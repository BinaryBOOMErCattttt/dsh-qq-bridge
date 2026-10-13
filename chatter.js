/**
 * 群里「谁在说话」的三本账。
 *
 * 这三件事看着都像「群号 → 一个数」，但**判据完全不同**，所以刻意分成三份，而不是一张表：
 *
 *   1. **插话序号**（`others`，只算**别人**）—— 判「这个一对一中间有没有人插过话」，比**大小**。
 *      当前这条消息自己已经把序号 +1，所以「紧跟着的下一条」恰好等于快照值 + 1。
 *   2. **回答指向**（`anchor`，**含我自己发的话**）—— 判「我回的那条有没有被后来的话挤远」。
 *      上一轮的回复、复读、主动搭话同样会把话头挤走，看的人一样会对不上，所以要算我自己的。
 *   3. **热度窗口**（`isHot`，只算**别人**）—— 判「最近这个群聊得够不够热」，比**时间**：
 *      条目会过期，大家一停，窗口自己就空了。
 *
 * 第 1、3 项都「只算别人」，并成一张表的诱惑最大 —— 但一个要的是单调递增的序号，
 * 一个要的是会过期的窗口，合并就得在一张表上同时维护两种语义。第 1、2 项也不能并：
 * 合并之后「我自己说了一句话」会把我自己的一对一窗口打断（那正是不该发生的事）。
 *
 * 所以这个模块只暴露**语义化的动作**，不暴露任何 Map —— 用错名字比用错表难得多：
 * 想知道「算不算我自己」，看调的是 `noteOther` 还是 `noteSelf` 就够了。
 *
 * 机器人自己发的话为什么由调用方显式记（`noteSelf`）而不是等事件回灌：本机的 NapCat 配着
 * `reportSelfMessage: false`，自己发出去的话一条都不会回来（见 index.js 的 `noteOwnMessage`）。
 *
 * @module @qqbot/dsh-plugin-qq/chatter
 */

/**
 * 每个群最多留多少条「最近说过的话」。
 *
 * 判定只需要回答「最近这个窗口里够不够 N 条、够不够 M 个人」，留着整段历史毫无意义；
 * 上限取 64：默认门槛是 6 条，留一个数量级的余量，也挡掉刷屏群把这份缓冲撑大。
 */
const GROUP_HEAT_MAX = 64;

/**
 * 最多记住多少个群（三本账各自的上限）。
 *
 * 见过面的群不该这么多；真超了就丢掉最早的那个群 —— 丢掉只影响一个「要不要引用」的
 * 判断（序号从头开始），以及那个群的搭话判定重新攒，都不会出错。
 */
const GROUP_LIMIT = 512;

/**
 * 建一份「谁在说话」的账。
 * @returns 语义化的读写动作（见模块注释里的三本账）。
 */
export function createChatter() {
  /** 群号 → **别人**说话的条数（单调递增）。 */
  const interposeSeq = new Map();
  /** 群号 → 含我自己在内说话的条数（单调递增）。 */
  const anchorSeq = new Map();
  /** 群号 → 最近说过的 `[{ userId, at }]`（旧 → 新，会过期）。 */
  const heatWindow = new Map();

  /** 把一个序号 +1 并返回新值；超上限时丢掉最早的那个群。 */
  function bump(map, groupId) {
    const next = (map.get(groupId) ?? 0) + 1;
    map.set(groupId, next);
    if (map.size > GROUP_LIMIT) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined && oldest !== groupId) map.delete(oldest);
    }
    return next;
  }

  /** 按「群号 → 数组」的表做同样的上限兜底。 */
  function trimGroups(map, groupId) {
    if (map.size <= GROUP_LIMIT) return;
    const oldest = map.keys().next().value;
    if (oldest !== undefined && oldest !== groupId) map.delete(oldest);
  }

  return {
    /**
     * 群里**别人**说了一句：插话序号 +1，同时记进热度窗口。
     *
     * 两本账一起进是因为同一件事（「别人说话了」）同时喂两条判据，但各自的口径不同 ——
     * 详见模块注释。
     *
     * @param groupId - 群号。
     * @param userId - 说话的人（热度判「够几个人」用）。
     * @param at - 这条消息**到达**的时刻（毫秒）；链上的时间按「群里什么时候说的」算，
     *   而不是「我们什么时候判完的」。
     * @param windowMs - 热度窗口的长度；`≤ 0` 时按 1 毫秒算（只留最后一条）。
     * @param keepLines - 配置里的门槛条数：缓冲要留得比它多，否则门槛配大了永远凑不够。
     * @returns 该群此刻的插话序号（**已计入这一句**）。
     */
    noteOther(groupId, userId, at, { windowMs, keepLines }) {
      bump(anchorSeq, groupId);
      const list = heatWindow.get(groupId) ?? [];
      list.push({ userId, at });
      const cutoff = at - Math.max(1, windowMs);
      // 条数上限取「默认上限」与「配置的门槛」的较大者。真正的边界是上面那个时间窗口，
      // 这里的裁剪只是不让这份缓冲无限长。
      const keep = Math.max(GROUP_HEAT_MAX, keepLines);
      while (list.length > keep || (list.length > 0 && list[0].at < cutoff)) list.shift();
      heatWindow.set(groupId, list);
      trimGroups(heatWindow, groupId);
      return bump(interposeSeq, groupId);
    },

    /**
     * 我自己往这个群发了一条消息（在**发出去**那一刻记，不依赖事件回灌）。
     *
     * 只推回答指向的序号，**不动**插话序号与热度窗口：我自己说话不该把自己的一对一窗口
     * 打断，也不该把自己算进「几个人在聊」里。
     * @param groupId - 群号。
     */
    noteSelf(groupId) {
      bump(anchorSeq, groupId);
    },

    /**
     * **别人**到目前为止说了几句。
     *
     * 判「这中间有没有人插过话」：与快照值差 1 就是紧跟着的下一条。
     * @param groupId - 群号。
     * @returns 单调递增的条数（没记过就是 0）。
     */
    others(groupId) {
      return interposeSeq.get(groupId) ?? 0;
    },

    /**
     * 含我自己在内，这个群说到第几句。
     *
     * 判「我回的那条有没有被后来的话挤远」—— 所以要算我自己的话（见模块注释）。
     * @param groupId - 群号。
     * @returns 单调递增的条数（没记过就是 0）。
     */
    anchor(groupId) {
      return anchorSeq.get(groupId) ?? 0;
    },

    /**
     * 这个群现在算不算「大家正聊着」。
     *
     * 判据：最近 `windowMs` 里**别人**说了 ≥ `lines` 条，且来自 ≥ `speakers` 个不同的人。
     * 两个条件一起卡住两类误判：一个人自己刷屏凑不出「几个人」，两个人半天说一句也算不上
     * 「聊起来了」。
     *
     * **纯查询**，不写状态：所以搭话不会赖着不走 —— 大家一停，窗口自己就空了，下次消息
     * 重新判。这也让「插话」自然成为进入方式之一：有人接一句，条数与人数就往上走。
     *
     * @param groupId - 群号。
     * @param windowMs - 窗口长度；`≤ 0` 直接 false（说明这套功能关着）。
     * @param lines - 至少要多少条。
     * @param speakers - 至少要多少个不同的人。
     * @param now - 当前时刻（毫秒），测试里可注入。
     * @returns 现在算「大家正聊着」时为 true。
     */
    isHot(groupId, windowMs, lines, speakers, now = Date.now()) {
      if (windowMs <= 0 || lines <= 0 || speakers <= 0) return false;
      const cutoff = now - windowMs;
      const recent = (heatWindow.get(groupId) ?? []).filter((entry) => entry.at >= cutoff);
      if (recent.length < lines) return false;
      return new Set(recent.map((entry) => entry.userId)).size >= speakers;
    },

    /**
     * 忘掉这个群的**热度窗口**。
     *
     * `/reset` 用它：不清的话，新一轮的第一条消息就可能被上一轮的热度判成「多人搭话」。
     * 刻意不清两个序号 —— 快照（`activeInterposeSeq`）在 `/reset` 时也归零，而
     * `activeUntil` 同样归零，接话本来就要重新 @ 一次；清不清都到不了那条判据。
     * @param groupId - 群号。
     */
    forgetHeat(groupId) {
      heatWindow.delete(groupId);
    },
  };
}
