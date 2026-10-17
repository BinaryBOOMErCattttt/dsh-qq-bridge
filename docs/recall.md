# 被撤回的消息：假装没看到，或者调侃一下（设计方案）

> **状态：已实现**（`recall.js` + `index.js` 的 `handleRecall` 一族 + `memory.noteRecall`；
> 用户视角见 README「被撤回的消息」，改代码的导览见 AGENTS.md §4.I）。本文留作设计依据与取舍
> 记录：`index.js` 的 `handleEvent` / `handlePoke` / 攒批链路、
> `interactions.js`（戳一戳的纯判据，本方案的形状来源）、`memory.js`（转录）、
> `speech-policy.js`（伪造 user message 的写法）、NapCat `napcat.mjs` 的撤回事件类。
>
> 本文把「撤回」拆成三层：**安全层**（别引用一条已经不在的消息、记忆里留痕）、
> **数据层**（它到底撤了哪句 —— QQ 不给，只能自己记）、**行为层**（装作没看见 / 调侃）。
> 前两层永远生效，行为层才是配置项。

---

## 0. 结论与范围

### 0.1 一句话方案

接 OneBot 的 `notice/group_recall`（与 `friend_recall`），在内存里维护一份「最近看见过
什么」的环形账（QQ 不给回查已撤回消息的接口），然后按**撤回发生在哪一刻**分三种处理：
**投递前**就地摘除或改写成撤回提示、**在飞**只清引用不补刀、**已回复**才补一句调侃。

```
QQ ─▶ NapCat ─ws─▶ OneBotClient.onEvent ─▶ handleEvent
                                              │ notice 分支（现在只调 handlePoke）
                                              ▼
                                       handleRecall ──▶ recall.js（纯判据）
                                              │
        ┌─────────────────┬───────────────────┴──────────────────┐
        ▼                 ▼                                      ▼
  安全层（永远做）    数据层（查 ring）                     行为层（配置决定）
  清掉指向它的 quote   撤的是哪句 / 谁发的                   投递前：摘除 / 改写
  转录追加 tombstone   有没有 @ 过它 / 回没回过              在飞：只清引用、不补刀
                                                             已回复：补一句 nudge
```

### 0.2 目标

1. 有人撤回一条**它看见过**的消息时，它要么真的没读到（连回复都不会沾上），要么调侃
   一句，由部署者选。
2. 不管选哪个，**不能因为引用一条已撤回的消息而发不出回复**（见 §1.4）。
3. 被 @ 的消息撤回后，默认**不再回答**（撤回 = 当没收到）；想「照常答、只是不引用」就把
   `recallAddressed` 设成 `answer`，两种取舍见 §3.1。
4. 长期记忆里留一行「撤回」标记，摘要 agent 不会把被撤回的内容当成事实。
5. 频率由纯判据控制：冷却、当天上限、概率、时效，全部可单测。

### 0.3 非目标

- **不**做「把原文从长期记忆里删掉」。转录是只追加的原料，删行要重写文件、破坏
  「写边界只有一处」的约定；先做标记（§7），真有需求是另一件事。
- **不**做撤销已在飞的那一轮（见 §3.3 的理由）。
- **不**做「撤回自己的消息」的互动（管理员撤了机器人的话是另一件事，默认不管）。
- **不**碰图片文件：撤回的消息若带图，`.qq-media` 里的那份照旧由 LRU 淘汰。

---

## 1. 事实基础（先钉死这几条，后面都依赖它）

### 1.1 撤回事件长什么样

NapCat 的 `group_recall` / `friend_recall` 事件类（`NapCat.Shell/napcat.mjs`）：

```js
// 群撤回
{ post_type: 'notice', notice_type: 'group_recall', self_id,
  group_id, user_id /* 谁发的 */, operator_id /* 谁撤的（管理员代撤时 ≠ user_id）*/,
  message_id /* 被撤回的那条的 id */, time }
// 私聊撤回（没有 group_id、没有 operator_id）
{ post_type: 'notice', notice_type: 'friend_recall', self_id,
  user_id, message_id, time }
```

三处实现差异必须容错：`message_id` 可能是数字或字符串；`operator_id` 有的实现不给（缺省
当「本人撤回」）；私聊没有 `group_id`。

### 1.2 现在为什么收不到

`index.js:3593` 的 notice 分支只调 `handlePoke` 就 `return`；而 `interactions.js` 的
`pokeNotice` 明确写着「别的通知（入群、**撤回**、戳别人的普通消息段）一律返回 undefined，
让调用方继续走原来的分支」。也就是说撤回本来就有位置，只是没人接。

### 1.3 为什么不能 `get_msg` 回查

消息都撤了，`get_msg` 要么报错、要么返回已被清理的内容；各实现行为还不一致。
`resolveQuote` 的注释里已经记了这条降级路径（「老消息已被撤回、网络抖动」都降级成没有引用）。
所以**「它撤了什么」只能我们在收到消息时自己记**（§2）。

### 1.4 引用一条已撤回的消息会怎样

`admit` 在收下消息时快照 `quote.messageId`，`turn/end` 之后由 `quoteHead` 挂成 `reply` 段。
如果这条消息在这之间被撤回：

- `sendOne`（`index.js:1562`）失败时只 `report('warn')` 并 `return false`；
- `sendParts` 的循环见到 false 就 `return`，**这条回复剩下的气泡一起不发**。

群里看到的现象是「它没理人」，日志里只有一条 warn。这是本方案最硬的一条理由：
**清引用不是可选的优化，是正确性。**

---

## 2. 数据：最近看见过什么

撤回时唯一能回答「撤的是哪句」的地方。放 `apply` 闭包，和 `ambient` 同级，**不落盘**
（重启后撤回一条重启前的消息本来就无从谈起；重启也不该把不可信文本留在内存之外）。

```js
/** 会话 key → 最近见过的消息，新的在后。只用于撤回时取回原文与元信息。 */
const recent = new Map();          // 'group:<群号>' / 'private:<QQ号>'
const RECENT_MAX = 30;             // 每个会话最多记多少条
const RECENT_TEXT_MAX = 80;        // 原文最多留多少字（给 nudge 用，不落盘）
```

条目：

| 字段 | 来源 | 用途 |
|---|---|---|
| `id` | `String(event.message_id)` | 与撤回事件对账（主键） |
| `userId` | `String(event.user_id)` | `@` 回被撤回的人；判「自己撤的」 |
| `name` | `userDisplayName(sender, ...)`（群名片优先） | 正文里的称呼，和 `[[@昵称]]` 同一串字 |
| `text` | `messageToText(message, selfId)` 的**占位符版**（不下载媒体） | nudge 里可选地引用 |
| `at` | `Date.now()` | 时效判据 `recallMaxAgeMs` |
| `addressed` | 这条有没有 @ 它 / 前缀 / `groupTrigger: all` | `recallScope: 'to-me'` 与「被 @ 撤回」分支 |
| `submitted` | `submitBatch` 投递时置 true | 区分「投递前」与「已投递」 |
| `replied` | `turn/end` 真要发回复时置 true | nudge 里说「你已经回过了」 |
| `recalled` | 撤回事件来时置 true | 去重（同一个撤回可能重复上报） |
| `action` | `'drop' \| 'rewrite' \| undefined` | 投递时怎么处理（见 §4.2 的三态） |

> 三个字段的语义要分清：`recalled` 是**事实**（发生过撤回，用来去重）；`action` 是**决定**
> （这条不许投、或者投的时候换成撤回提示）；`submitted` / `replied` 是**进度**。混成一个
> 布尔值，`ignore + answer` 那种「照常答、只是不引用」的路径就没法表达了。

### 2.1 写入点

`handleEvent` 里 `admit` **之前**、`selfId` 判空之后，调 `noteSeen(event, selfId)`：

- 必须在 `admit` 之前：`admit` 会快照 `quote`，且 `admit === undefined` 的闲聊也要记
  （撤回不认「有没有 @ 它」）；
- 必须在所有提前 `return` 之前：否则「刚发就撤」的那几十毫秒里会漏；
- 准入边界照抄 `rememberTranscript`：群聊 `groupChat` + `allowGroups`、私聊 `privateChat`
  + `allowUsers`。不设这一道，等于把不可信群/陌生人的文本无限期留在内存里。
- 机器人自己的消息不记（`String(event.user_id) === selfId` 直接 return），与
  `rememberAmbient` / `rememberTranscript` 同一条口径；否则「我的消息被管理员撤了」会被
  当成别人的撤回进判据。

`text` 用占位符版本（`[图片]` / `[表情]`）就够：撤回时不会为了它去下载媒体，而且
**nudge 默认不给原文**（§8），这里只是日志与可选引用用。

### 2.2 清理点

| 时机 | 动作 | 理由 |
|---|---|---|
| 超过 `RECENT_MAX` | `shift()` 最旧的 | 撤回通常紧跟在消息之后；30 条 ≈ 一两分钟的群聊量 |
| `/reset`（`resetConversation`） | 删掉这个 key 的 ring + `recallAt` / `recallToday` | 新一轮会话不该拿上一轮的撤回开玩笑 |
| 插件卸载 | 闭包销毁，自动没了 | 与 `ambient` / `repeatStates` 同口径 |
| 不在 ring 里 | **什么都不做**，只记 info | 「没看见」是一个有效状态，不是错误 |

### 2.3 顺手给 `ambient` 补 `id`

`rememberAmbient`（`index.js:2287`）现在存的是 `{ name, text }`。要「真没看见」就必须能
精确摘掉那一行，所以条目补一个 `id: String(event.message_id ?? '')`。删除要按 **id**
或对象引用，**不能按文本比**：`hydrateAmbientMedia` 会把 `text` 异步改写成带路径的版本，
落盘前后文本不一样。

---

## 3. 位置 × 模式矩阵（本方案的核心）

一条消息从到达发出要经过：

```
t0 handleEvent（同步：noteSeen → admit 快照 quote → 转录 → holdForBatch 进 pending）
t1 batchWindowMs（默认 2 秒，pending 里等）
t2 flushBatch → submitBatch（异步：媒体落盘 → ensureAgent → followup → submitted.set）
t3 turn 在飞（模型跑，可能几十秒；turnOwners 里有 owner）
t4 turn/end → sendToConversation（打字延迟后真发）
t5 已发到 QQ
```

撤回落在不同位置时，这条消息在系统里有三种身份：

| 身份 | 怎么判 | 含义 |
|---|---|---|
| 待回批次里 | `conversation.pending` 里找得到它 | 这一轮本来就打算回它 |
| 环境上下文里 | 哪都找不到，但 `ambient` 里有（没 @ 它的群聊） | 模型「见过」，但没人指望它回 |
| 已投递 | `entry.submitted === true` | 模型已经在处理，或已经回过 |

**两条规则**（先定投递，再谈反应）：

1. **投递**（`ignore` / `tease` 都做，`off` 不做）：还没进模型的，凡是**没被 @ 它**的一律
   摘掉（待回批次 + 环境上下文）；**被 @ 它**的按 `recallAddressed` 决定。
2. **反应**（只有 `tease` 有）：在已经发生的事实上，补一句话。

| 位置 | `off` | `ignore`（默认） | `tease` |
|---|---|---|---|
| 待回批次，**被 @**，`answer` | 保留（清引用） | 保留，照常答（**它没注意到撤回**） | **就地改写成撤回提示**（这一轮就是调侃） |
| 待回批次，**被 @**，`drop` | 保留（清引用） | 摘除，不回 | 摘除，不回 |
| 待回批次，**没被 @** | 保留（清引用） | 摘除（它本来也只是「也许接一句」） | 摘除 |
| 环境上下文 | 不动 | 删掉那一行 | 删行 +（`scope: 'all'` 且过闸）补一句 |
| 已投递 / 已回复 | 清引用 | 清引用，**不补** | 清引用，过闸才补一句（§3.3、§3.4） |

四种动作的落点：

| 动作 | 做什么 | 落在 |
|---|---|---|
| **清引用** | `quote.messageId = ''`（保留 `userId`） | `clearQuoteFor`（§4.2），**所有模式都执行** |
| **摘除** | ring 里标 `action: 'drop'`；还在 `pending` 的顺手 splice，摘空则 `clearTimeout(batchTimer)`；在 `ambient` 里就删那一行 | `handleRecall` + `dropPending` / `dropAmbient`（§4.2） |
| **改写** | ring 里标 `action: 'rewrite'`；渲染时正文换成 `recallLine` | `submitBatch`（§4.2） |
| **补一句** | `enqueue` 一条 `proactive: true` 的 nudge | `handleRecall`（§4.3） |

`action` 放在 ring 上而不是只改 `pending` 数组，是为了兜住 `submitBatch` 已经把这批
`splice` 出来、正在异步下媒体的那几十毫秒（那时数组里已经没有它了，但循环还没走到它）。
`submitBatch` 每条渲染前查一次 ring 即可，不需要另存一份「被撤回的 id」集合。

**配额只算「补一句」**：改写是把本来就要发的那一轮换了个说法，不增加消息数，所以不吃
`recallChance` / 冷却 / 每日上限；`nudge` 是真的多发一条，才要过那一套闸。

### 3.1 为什么被 @ 的要「照常答」，而不是一起摘掉

@ 是**明确点名**：模型已经准备接这一轮，对方也确实点了名。此时摘掉等于点名了却不吭声，
比答错更像掉线。所以 `recallAddressed: 'answer'` 是**站得住的一档** —— 照常答、只是不引用
（§1.4），`ignore` 模式下它**根本不会知道有人撤回过**。

不过实现之后的默认值选了另一档：**`drop`**（撤回 = 当没收到，只影响被 @ 的那条）。两种取舍都
合理，区别只是「点名了就该有回应」还是「撤回就是没说过」；本仓库与 schema 默认都取后者，
想要前者把这一项改成 `answer`。

### 3.2 为什么「改写」比另开一轮好

`tease` 模式下，如果先摘掉、再 enqueue 一条 nudge，会变成「先回一句正经的、再补一句
调侃」的两连发。而在 `pending` 阶段直接把这一条**换成**撤回提示，模型就在**本来就要
开的这一轮**里看到「他 @ 了我，然后撤了」，回一句就够 —— 不额外发消息，也不引用死人。

改写只改「正文怎么渲染」，别的都不动：`userId` / `name` 留着（`@` 与名单登记照常），
`intent` 照旧 `addressed`；引用那一路由 `clearQuoteFor` 兜住（`quote` 对象是共享的，
`batchQuote` 拿到的就是已经被清空 `messageId` 的那个）。

### 3.3 为什么「在飞」不补刀

1. 回复马上要发出去，本身就是对这一条的回应；再补一句是连发两条。
2. 没有「撤销一轮」的干净 API：真要撤回只能 `dispose` Agent（`resetConversation` 那一级
   的动作），为了一个撤回把会话上下文丢掉完全不划算。
3. 想让它「答完再补刀」也可以，但那是另一个决定：把 `busyWithTurn` 那道闸去掉即可，
   `enqueue` 会自然排在这一轮之后 —— 代价就是两条。默认不开。

### 3.4 已经回过了才有得调侃

`t5` 的 `replied: true` 只有在「这一轮的回复真的发出去了」时才成立（§4.4）。这时它手里
既有那条消息（在上下文里），又已经答过，调侃一句「撤得有点晚，我都回了」才成立。

### 3.5 「群里的闲聊被撤回」：`scope` 决定要不要主动开口

没 @ 它的消息不进待回批次，只进 `ambient`。按 §3 的规则一，它会被删掉 —— 但「删掉」
不等于「要说点什么」。`tease` + `recallScope: 'all'` 是唯一会让它为**别人的撤回**主动
开口的组合，它因此比 `to-me` 更接近 `proactive`：**默认关，打开前先想清楚**
（等于承认它每条都看，见 §8）。

## 4. 处理流程

### 4.1 `handleRecall(event, selfId)`

```js
function handleRecall(event, selfId) {
  const notice = recallNotice(event);                  // recall.js，纯函数
  if (notice === undefined) return;                    // 不是撤回通知

  // ① 准入：与 handlePoke 同一条纪律，先过渠道开关 / 白名单，再谈别的
  const type = notice.groupId !== undefined ? 'group' : 'private';
  const id = type === 'group' ? notice.groupId : notice.userId;
  if (!recallAllowed(type, id)) return;                // 群：groupChat/allowGroups；私聊：privateChat/allowUsers/recallPrivate
  const key = `${type}:${id}`;

  // ② 安全层：不管哪种模式、ring 里有没有，先清掉指向它的引用（§1.4）
  clearQuoteFor(key, notice.messageId);

  // ③ 数据层：没看见过就到此为止（转录里也没有，没什么可标记）
  const entry = findRecent(key, notice.messageId);
  if (entry === undefined) {
    report('info', `撤回了一条没见过的消息（${key} ${notice.messageId}）`);
    return;
  }
  if (entry.recalled === true) return;                 // 重复上报：同一个撤回只处理一次
  entry.recalled = true;

  const conversation = conversations.get(key);         // 可能没有（闲聊过的群不建会话记录）
  const addressed = entry.addressed === true;

  // 长期记忆：留一行 tombstone（不影响回复，失败只记 warn，见 §7）
  if (settings.recallMemoryMark) {
    memory.noteRecall(key, { messageId: notice.messageId, userId: entry.userId, name: entry.name, addressed });
  }

  // ④ 投递决策（off 模式什么都不动）：还没进模型的，没 @ 的一律摘；被 @ 的看 recallAddressed
  if (settings.recallMode !== 'off' && entry.submitted !== true) {
    const drop = !addressed || settings.recallAddressed === 'drop';
    if (drop) {
      entry.action = 'drop';                           // 兜住 submitBatch 的异步窗口
      dropPending(conversation, notice.messageId);     // 还在攒批里就顺手摘掉
      dropAmbient(notice.groupId, notice.messageId);   // 还在环境上下文里就删掉那一行
      report('info', `${key} 被撤回的那条不再投递（${addressed ? 'recallAddressed=drop' : '没有被 @'}）`);
    } else if (settings.recallMode === 'tease') {
      entry.action = 'rewrite';                        // 这一轮就回一句调侃
      report('info', `${key} 被 @ 的那条被撤回了，这一轮改成调侃`);
    } else {
      report('info', `${key} 被 @ 的那条被撤回了，照常回答（不引用）`);
    }
  }

  // ⑤ 反应：只有 tease 会「补一句」；被 @ 的已经在改写里处理，不再叠一条
  if (settings.recallMode !== 'tease') return;
  if (conversation === undefined) return;              // 没有会话记录就不主动开口（AGENTS §4.F）
  if (entry.submitted !== true && addressed) return;
  const decision = recallAction({
    mode: settings.recallMode,
    selfId: String(selfId),
    userId: notice.userId,
    operatorId: notice.operatorId,
    seen: true,
    addressed,
    replied: entry.replied === true,
    scope: settings.recallScope,
    ageMs: Date.now() - (Number(entry.at) || 0),
    maxAgeMs: settings.recallMaxAgeMs,
    busy: busyWithTurn(conversation),
    cooldownLeftMs: Math.max(0, (Number(conversation.recallAt) || 0) + settings.recallCooldownMs - Date.now()),
    todayCount: recallTodayCount(conversation),        // 带跨天归零的副作用，只在走到这里时取
    dailyMax: settings.recallDailyMax,
    chance: settings.recallChance,
    roll: Math.random(),
  });
  if (decision.act === 'none') {
    report('info', `${describeConversation(conversation)} 撤回不调侃（${decision.reason}）`);
    return;
  }
  // 先记账再发（与 poke / proactive 同一条规矩：掷中即消耗，SKIP 也算）
  conversation.recallAt = Date.now();
  conversation.recallToday = recallTodayCount(conversation) + 1;
  conversation.pendingIntent = 'recall';
  enqueue(conversation, async () => {
    const text = recallNudge({
      name: entry.name,
      text: settings.recallTeaseQuote ? entry.text : undefined,
      replied: entry.replied === true,
      imageAllowed: imageAllowed(),
    });
    const agent = await ensureAgent(conversation);
    const userMessage = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
    // `proactive: true` 的三个现成语义正好要：出错不道歉、SKIP 全局静默、不挂补一句。
    submitted.set(userMessage.id, {
      key: conversation.key,
      quote: { messageId: '', userId: '', seq: 0 },     // 撤回的消息不能挂 reply 段（§1.4）
      proactive: true,
      intent: 'recall',
    });
    agent.followup(userMessage);
  });
}
```

`handleEvent` 的 notice 分支改成按类型分流：

```js
if (event?.post_type === 'notice') {
  if (event.notice_type === 'group_recall' || event.notice_type === 'friend_recall') handleRecall(event, selfId);
  else handlePoke(event, selfId);
  return;
}
```

### 4.2 清引用 / 摘除 / 改写

**清引用**：`quote` 对象在 `pending` 条目、`submitted`、`turnOwners` 里是**同一个引用**
（`submitBatch` 用 `batchQuote(batch)`，claim 时整个 owner 对象搬到 `turnOwners`，
`turn/end` 又原样交给 `sendToConversation`），所以一次遍历全改掉：

```js
/** 撤回时清掉「指向这条消息」的引用；保留 userId，让 quoteHead 的降级路径接手。 */
function clearQuoteFor(key, messageId) {
  const quotes = [];
  for (const item of conversations.get(key)?.pending ?? []) quotes.push(item.quote);
  for (const owner of submitted.values()) if (owner.key === key) quotes.push(owner.quote);
  for (const owner of turnOwners.values()) if (owner.key === key) quotes.push(owner.quote);
  for (const quote of quotes) {
    if (quote !== undefined && String(quote.messageId) === messageId) quote.messageId = '';
  }
}
```

只清 `messageId`、留着 `userId` 是刻意的：`quoteHead` 里本来就有这条降级（「锚点没取到
（撤回 / 实现不支持）时退化成 @ 说话人」），于是四档 `replyStyle` 全部自动正确：

| `replyStyle` | 清完之后 |
|---|---|
| `quote` | `messageId` 空 → 不引用，裸发 |
| `auto` | `drifted && messageId 空` → 不引用 |
| `at` | 仍 `@` 那个人（`userId` 还在） |
| 插话轮（强制引用） | 退化成 `at` 锚点说话人 |

**摘除**：

```js
/** 从攒批里摘掉一条；摘空了就取消定时器（绝不能 flush —— 那会投一条空批）。 */
function dropPending(conversation, messageId) {
  if (conversation === undefined) return false;        // 这个群还没有会话记录
  const at = conversation.pending.findIndex((item) => String(item.messageId) === messageId);
  if (at < 0) return false;                            // 已经进了 submitBatch，交给下面的标记兜
  conversation.pending.splice(at, 1);
  if (conversation.pending.length === 0 && conversation.batchTimer !== undefined) {
    clearTimeout(conversation.batchTimer);
    conversation.batchTimer = undefined;
  }
  return true;
}
```

**改写**：不在撤回事件里直接改数组，只在 ring 上打 `action`；渲染时统一查一次：

```js
// submitBatch 里，每条渲染正文之前
const mark = recalledMark(conversation.key, item.messageId);   // ring 条目，纯查表
if (mark?.action === 'drop') continue;                          // 摘除的第二道（兜住异步窗口）
const body = mark?.action === 'rewrite'
  ? recallLine({ name: item.name, text: item.text })            // recall.js
  : item.continued === true ? raw : dropPrefix(raw);
```

**清环境上下文**：没 @ 它的消息不进待回批次，而是进 `ambient`（「群里刚才在聊这些」）。
「假装没看到」必须把那一行也删掉，否则模型下次被 @ 时又在上下文里读到它：

```js
/** 从群聊环境上下文里删掉这一行；按 id 删，不能按文本（媒体落盘会把文本改写一次）。 */
function dropAmbient(groupId, messageId) {
  if (groupId === undefined) return;                   // 私聊没有环境上下文
  const list = ambient.get(groupId);
  if (list === undefined) return;
  const at = list.findIndex((item) => String(item.id) === messageId);
  if (at >= 0) list.splice(at, 1);
}
```

为什么用 ring 上的标记、而不是在 `submitBatch` 里再存一份「被撤回的 id」集合：理由见 §3
末尾（异步窗口里数组已经没有它了，但循环还没走到它）。

配套小改：`holdForBatch` 的 entry 补 `messageId: String(event.message_id ?? '')`
（摘除、改写、去重都要它）。`batchQuote` **不用动**：它返回的就是 `admit` 快照的那个
`quote` 对象，而 `clearQuoteFor` 已经把这个对象的 `messageId` 清空了。

### 4.3 补一句（nudge 路径）

走 `enqueue` + 伪造 user message，与 `handlePoke` / `proactiveSpeak` 同一条通道：

- `submitted` 标 `proactive: true` + `intent: 'recall'`；
- `quote` 为空（§1.4）；
- `conversation.pendingIntent = 'recall'`（人设场景会回落到 group/private，见 §9）。

### 4.4 `replied` 怎么记

`submitBatch` 投递时把这一批的 id 记进 owner：

```js
submitted.set(userMessage.id, {
  key: conversation.key,
  quote: batchQuote(batch),
  intent,
  blank: entries.every((entry) => entry.blank === true),
  // 只算**真正投进这一轮**的那些（被摘掉的不算），所以用 entries 而不是 batch；
  // entries 里补一个 messageId 字段（现在只有 name / id / body / blank）。
  batchIds: entries.map((entry) => String(entry.messageId ?? '')).filter((id) => id.length > 0),
});
```

`turn/end` 决定要发回复的那几个分支（正常 / 主动），在 `sendToConversation` 之前把
`owner.batchIds` 对应的 ring 条目置 `replied = true`。SKIP / 错误 / 中止的分支不置
（它没回过，nudge 里就不能说「你已经回过了」）。

---

## 5. 纯函数模块 `recall.js`

新建，形状照抄 `interactions.js`：**普通入参 → 结论**，不碰 `ctx`、不读磁盘、不记日志、
不 import `index.js`。随机数由调用方掷（`roll`），所以每个分支都能用固定序列钉住。

### 5.1 `recallNotice(event)`

只认 `post_type: 'notice'` + `notice_type: 'group_recall' | 'friend_recall'` + `message_id`
存在；所有 id 归一成字符串（`toId` 同款），`operator_id` 缺失时返回 `undefined` 字段。

返回 `{ groupId?, userId, operatorId?, messageId }`；不是撤回通知时 `undefined`。
私聊没有 `groupId`，群聊没有 `operatorId` 时按「本人撤回」处理。

### 5.2 `recallAction(input)`

**只管「要不要补一句」，不管投递。** 摘除 / 改写要看 `pending`、`ambient`、`submitted`
这些运行时状态，那是 `index.js` 的事（`handleRecall` 的 ④）；这里只回答一个布尔式的问题：
「现在这一刻，适合为这条撤回说句话吗」。

判据顺序（先排除，再决策）：

| # | 条件 | `act` / `reason` |
|---|---|---|
| 1 | `mode !== 'tease'` | `none` / `off` |
| 2 | `messageId` 或 `userId` 缺失 | `none` / `target` |
| 3 | `userId === selfId`（自己的消息被撤） | `none` / `self` |
| 4 | `operatorId !== userId`（管理员代撤） | `none` / `operator` |
| 5 | ring 里没有（`seen !== true`） | `none` / `unseen` |
| 6 | `ageMs > maxAgeMs` | `none` / `stale` |
| 7 | `scope === 'to-me'` 且 `!addressed && !replied` | `none` / `scope` |
| 8 | `busy === true`（turn 在飞） | `none` / `busy` |
| 9 | 冷却未过 | `none` / `cooldown` |
| 10 | 当天次数到上限 | `none` / `daily` |
| 11 | 概率没中（`roll >= chance`） | `none` / `roll` |
| 12 | 全过 | `tease` |

`chance` 夹到 0..1，NaN 当 0；`roll` 缺失当 1（不中）—— 掷骰子坏了偏保守，与
`activeTalkAllows` 同口径。`maxAgeMs <= 0` 表示不限；`dailyMax <= 0` 表示不限
（与 `pokeDailyMax` 一致）。

> 为什么不复用 `pokeAction`：戳一戳的核心判据是「戳的目标必须是自己」，撤回没有 target
> 字段；而且撤回多出「时效 / 已回复 / 管理员代撤」三条，混进去两边都会长出 if。

### 5.3 `recallLine(input)`（投递前改写用）

`（{name} 刚才 @ 了你，接着又把自己那条撤回了。那句是：「{text}」）` + 选择权两行。
`text` 只在 `recallTeaseQuote` 打开时给；关着时连这句「那句是」都不出现。

### 5.4 `recallNudge(input)`（补一句用：已回复 / 别人的闲聊）

必须说清四件事，少一件模型就会乱来：

1. 这条**不是谁发给它的消息**（否则它会当成一个人在跟它说话）；
2. 它可以调侃，也可以什么都不做（`SKIP` 出口 —— 与 `pokeNudge` / `proactiveNudge` 同一条规矩）；
3. **别复述被撤回的内容**（默认连原文都不给它）；
4. **别把这条提醒本身说出去**。

`name` 来自 QQ（群名片可随便改），先折空白再按码点截断，否则一个带换行的昵称就能伪造
提示行。`replied` 决定措辞：`true` 才说「你已经回过了」；`false`（环境上下文那条 / 在飞
之后的迟到）只说「刚撤了一条」，一个字都不替它下结论。

---

## 6. 配置

| 字段 | 类型 | 默认 | 说明（也是 `.description()` 的底稿） |
|---|---|---|---|
| `recallMode` | `'off' \| 'ignore' \| 'tease'` | `'ignore'` | `off` 只做安全层（清引用 + 记忆标记）；`ignore` 假装没看到撤回（没 @ 它的不再投递，被 @ 的照常答）；`tease` 在此基础上多一种反应（被 @ 的改写成调侃 / 已回复补一句） |
| `recallAddressed` | `'answer' \| 'drop'` | `'drop'` | 被 @ 的那条还没投递就撤回时还回不回：`drop` = 从攒批里摘掉，真不回（默认，「撤回 = 当没收到」）；`answer` = 照常答、只是不引用（`tease` 时这一轮改成调侃） |
| `recallScope` | `'to-me' \| 'all'` | `'to-me'` | `to-me` = 只调侃冲它来的、或它已经回过的；`all` = 别人撤回的闲聊也调侃（会主动开一次口，语义接近 proactive，见 §3.5 与 §8） |
| `recallChance` | number | `0.5` | `tease` 时掷一次的概率（0~1） |
| `recallCooldownMs` | number | `60000` | 同一个会话两次调侃之间至少隔多久（防撤回刷屏） |
| `recallDailyMax` | number | `5` | 同一个会话一天最多调侃几次（本地日界线，内存计数）；0 = 不限 |
| `recallMaxAgeMs` | number | `120000` | 消息发出后多久之内撤回才值得调侃；0 = 不限 |
| `recallTeaseQuote` | boolean | `false` | 调侃时要不要把被撤回的原文交给模型（默认不要，见 §8） |
| `recallPrivate` | boolean | `true` | 私聊撤回要不要处理（`friend_recall`）；默认处理（还没投给模型的那条就不回）。`tease` 时建议关掉 —— 私聊里调侃「你撤什么」很容易变成冒犯 |
| `recallMemoryMark` | boolean | `true` | 转录里追加一行「已撤回」标记（§7） |

`settings.js` 的再加工（与 `poke*` 同款，`index.js` 里不许出现 `config.xxx`）：

```js
const recallChance = Math.min(1, Math.max(0, Number(config.recallChance)));
const recallCooldownMs = msOf(config.recallCooldownMs, 60000);
const recallDailyMax = msOf(config.recallDailyMax, 5);
const recallMaxAgeMs = msOf(config.recallMaxAgeMs, 120000);
```

界面：加在 `client.js` 的 `SECTIONS` 里 `perception`（感知与互动）那一段，单开一个
`subs` 小标题「撤回」，与 `poke*` 并列。`LABEL_OVERRIDES` 给 `recallMode` /
`recallScope` 人话标签，`ENUM_LABELS` 给枚举值（`off: '不处理'` / `ignore: '假装没看到'`
/ `tease: '调侃一下'`、`to-me: '只调侃冲它来的'` / `all: '群里谁撤回都调侃'`）。
`test/client.test.mjs` 会钉住「每个配置项都有分组」。

README 加一节「被撤回的消息」+ 配置表 10 行；AGENTS.md §4 加一条数据流、§6 表加一行。

---

## 7. 长期记忆：追加一行 tombstone

转录里已经存了 `id`（`memory.js` 的 `write()` 有 `id: String(event.message_id ?? '')`），
所以能精确对上。`memory.js` 暴露一个 `noteRecall(key, { messageId, userId, name, addressed })`，
走**同一个** `appendTranscript`：

```json
{"at":1712345678901,"date":"2026-11-20","kind":"recall","recall":"1234567890",
 "user":"100000003","name":"kaguya","addressed":true,"text":"（撤回了自己上一条消息）"}
```

- **追加而不是删行**：转录是只追加的原料；删行要重写文件、破坏「写边界只有一处」，
  而且摘要状态（`lastDigestAt` / `memoryDirty`）也要跟着改。
- `text` 填一句话而不是空串：`qq_transcript read` 与 `renderTranscriptWindow` 都直接渲染
  `text`，空串会显示成「kaguya: 」。
- `renderTranscriptWindow` 的标签里加一条：`if (line.kind === 'recall') tags.push('撤回')`，
  摘要 agent 一眼能看出「这条被撤了，别当事实」。
- `recallMemoryMark: false` 时连这一行都不写 —— 给「就是纯粹假装没看到」的部署。
- 写失败只记 warn（`appendTranscript` 本来就是尽力而为），不影响回复。

---

## 8. 安全与隐私

| 决定 | 理由 |
|---|---|
| `recallScope` 默认 `to-me` | `all` 等于当众展示「它每条都看」—— 这是行为上的暴露，不是技术问题。想当群里的活宝再开 |
| 默认不给原文（`recallTeaseQuote: false`） | 复述别人撤掉的话是最常见的社交事故；而且模型手里本来就有上下文，真需要它自己知道 |
| 原文截断 80 字、折空白 | 与 `pokeNudge` 的昵称同一条线：QQ 消息是不可信输入，不能让它在一行里伪造提示 |
| `operatorId !== userId` 不调侃 | 管理员替别人撤了话，调侃他 = 公开处刑，而且对象错了 |
| 自己的消息被撤不处理 | 「我的话被撤了」是另一件事（且多半是管理员操作） |
| 私聊默认**处理**（`recallPrivate: true`，但不调侃） | 只做「撤回 = 不回」；`tease` 时建议关掉 —— 私聊里调侃「你撤什么」很容易变成冒犯 |
| 白名单 / 渠道开关先过 | 与 `handlePoke` 同一条纪律，否则等于给不可信的群开了个入口 |
| 冷却 + 当天上限 + 时效 | 撤回刷屏（群里「撤回测试」）是常见行为，没有闸门会被刷成复读机 |
| 不把图路径写进 nudge | 图文件还在 `.qq-media` 里，但「我存了你撤的那张图」是另一层冒犯，默认不做 |

---

## 9. 坑清单

| 坑 | 处理 |
|---|---|
| `message_id` 数字/字符串混用 | 一律 `String()` 再比（`toId` 同款） |
| 同一个撤回重复上报 | ring 条目打 `recalled` 标记去重；`action` 标记是幂等的；冷却再兜一层 |
| 「刚发就撤」的时序 | `noteSeen` 在 `handleEvent` 最前面、`admit` 之前 |
| `ambient` 的媒体是异步改写的 | 删除按 `id` 或对象引用，别按文本比 |
| 摘空批次后 flush | 绝不能 flush（`flushBatch` 对空数组会直接 return，但会白等一个窗口）；只清 timer |
| 转录 / 记忆 | 追加 tombstone，不删行（§7） |
| `talkMisses` / `chatter` 已经记过账 | 不回滚：那是一次「有人说了话」的事实，回滚要动三本账的不变量，不值得 |
| 复读链 | 撤回的正好是复读链第一条时，链里还留着它；可选 `repeatStates.delete(groupId)`，影响很小 |
| `/reset` | `resetConversation` 清 ring + `recallAt` / `recallToday` |
| `pendingIntent = 'recall'` | `personaSceneFor` 不认它会回落成 group/private，可接受；想让它「嘴更欠」在 `PERSONA.md` 里加 recall 场景 |
| `proactive: true` 的副作用 | 正好要：出错不道歉、SKIP 静默、不挂补一句；别改成普通回复 |
| 引用死人 | 永远清；这是 §1.4 的正确性问题 |
| `quote` 对象共享 | `pending` / `submitted` / `turnOwners` 是同一个引用，一处改动三处生效；别复制新对象 |
| `SKIP` | 全局判据，nudge 必须给出口（`proactiveSkip` 对所有轮次生效） |

---

## 10. 测试计划

### 10.1 `test/recall.test.mjs`（纯函数）

- `recallNotice`：两种 `notice_type`；缺 `message_id` / `user_id` 返回 undefined；数字 id
  归一成字符串；私聊没有 `groupId`；群聊没有 `operatorId`。
- `recallAction`：从「全过」的基准入参出发，**逐条只翻一个字段**（照
  `speaking-rules.test.mjs` 的写法），12 条判据各一条；`chance` 的 0 / 1 / NaN；
  `maxAgeMs: 0` 不限。
- `recallLine` / `recallNudge`：含 `SKIP`；默认**不含**原文；含昵称；昵称里的换行被折掉。

### 10.2 `test/bridge.test.mjs` 新增一组 `bootRecall`

（`digestMinLines: 9999` 隔离摘要循环，与 `bootProactive` 同款；事件用
`groupMessage(...)` + 一个 `groupRecall({ messageId })` 工厂。）

| # | 场景 | 断言 |
|---|---|---|
| 1 | `tease` + 被 @ 后立刻撤回（还在攒批窗口） | 只有一轮；正文含「撤回」；`send_group_msg` 里**没有 `reply` 段** |
| 2 | `ignore` + `answer` + 同上 | 一轮；正文是原问题的答案（模型没看见撤回）；仍没有 `reply` 段 |
| 3 | `ignore` + `drop` | Agent 一条消息都没收到（`host.list.created` 为空） |
| 4 | `tease` + 先 @ → `untilInbox` → **`completeTurn` 之前**推撤回 → 再 `completeTurn` | 回复照常发出；没有 `reply` 段；**只有一条**回复（`busyWithTurn` 挡住补刀） |
| 5 | `tease` + `completeTurn` 之后再推撤回 | 第二条回复 = 调侃；正文含对方昵称；`quote` 为空 |
| 6 | 冷却 / 每日上限 / 管理员代撤 / 自己撤 / 太久的撤回 | 各一条，断言「没有第二条回复」 |
| 7 | `ignore` + 环境上下文 | 一条没 @ 它的消息撤回后再 @ 它，断言给模型的群聊上下文里没有那句 |
| 8 | `tease` + `scope: 'all'` + 环境上下文 | 没 @ 它的消息撤回 → 开一轮调侃（正文含昵称、`quote` 为空）；`scope: 'to-me'` 时**不开** |
| 9 | 转录 | `qq_transcript read` 里能看到 `kind: 'recall'` 那一行，原文仍在、不重复 |

### 10.3 回归

- `node --test test/` 全绿（基线 491 条；新增约 20 条）。
- 动过 `config.js` / `settings.js` → `test/settings.test.mjs`；动过 `client.js` →
  `test/client.test.mjs`（分组别漏、标签别退化成字段名）。

---

## 11. 落地顺序与验收（已按此顺序完成）

| 步 | 内容 | 可独立提交 | 验收 |
|---|---|---|---|
| 1 | `recall.js` 纯函数 + `test/recall.test.mjs` | 是（不接线，零风险） | 单测全绿 |
| 2 | ring（`noteSeen`）+ `ambient` 补 `id` + `/reset` 清理 | 是（只记不看） | 全量绿 |
| 3 | 安全层：notice 分流 + `clearQuoteFor` + `batchIds` / `replied` | 是 | 用例 4 |
| 4 | `ignore` 模式：`dropPending` + `recallAddressed` + `ambient` 删行 + 配置 | 是 | 用例 2、3、7 |
| 5 | `tease` 模式：`action: 'rewrite'` + `recallNudge` + `submitted` 标记 | 是 | 用例 1、5、7 |
| 6 | 转录 tombstone（`memory.noteRecall` + 渲染标签） | 是 | 用例 8 |
| 7 | 设置页分组 / README / AGENTS.md / CHANGELOG | 是 | `client.test.mjs` |

改完必须重启 `qqbot` profile（Loader 按 URL 缓存模块，停用插件没用）。

验收清单（与 AGENTS.md §9 一致）：测试全绿、注释中文且解释「为什么」、配置同步 README、
没有新增 `dependencies`、权限判断没有变成「不配 = 人人可用」、涉及不可信输入的地方复核过。

---

## 12. 未决问题（当时的取舍，实现时按此默认落地）

1. **默认 `ignore` 还是 `tease`？** 默认 `ignore`：不调侃，但「撤回 = 不回」那部分照常生效
   （`recallAddressed: 'drop'`），不需要额外的概率与冷却闸门。想一上来就有反应：
   `recallMode: 'tease'`（注意它才会真的多补一条消息）。
2. **`recallScope` 开不开 `all`？** 群友视角更好玩，代价是承认它每条都看。
3. **管理员代撤要不要调侃？** 本方案不调侃（§8），如果群里就是熟人局可以放开。
4. **被 @ 的消息撤回后要不要保留回答？** 实现后选了 `recallAddressed: 'drop'`（本方案原文推荐
   `answer`），两种取舍见 §3.1；想保留回答就把这一项设回 `answer`。
5. **回复风格是否要跟着变？** `recallNudge` 只给话头，不规定长短；如果发现它每次都来
   一句「撤什么呀」，在 `STYLE.md` 的 recall 场景里限一句更好。

---

## 附录 A：文案草稿

**`recallLine`（投递前改写，这一轮直接调侃）**

```
（kaguya 刚才 @ 了你，接着又把自己那条撤回了。那句是：「晚上吃啥」）
你想回就回一句（也可以顺口调侃「撤什么呀，我看见了」），不想回就只写 SKIP。
```

`recallTeaseQuote: false` 时：`（kaguya 刚才 @ 了你，接着又把自己那条撤回了。）`

**`recallNudge`（已回复补刀）**

```
（这条不是谁发给你的消息，是插件转告你：kaguya 刚才把一条你已回过的话撤回了。）
想补一句「撤得有点晚，我都回了」就补，不想说就整条只写 SKIP。
注意：别把这条提醒本身说出来，也别复述可能被撤回的内容。
```

**`recallNudge`（`replied: false`，别人的闲聊被撤回，`scope: 'all'`）**

```
（这条不是谁发给你的消息，是插件转告你：群里 kaguya 刚撤回了一条消息，你没回过。）
想接一句就接（比如「撤什么呀，我看见了」），也可以什么都不说。
注意：别把这条提醒本身说出来，也别复述可能被撤回的内容。
```

**在飞时不发**（仅备档，说明为什么没有这条文案）：这一轮正在发的回复就是回应，再补一句
会变成连发两条；`busyWithTurn` 那道闸挡的就是它（§3.3）。

---

## 附录 B：AGENTS.md 要同步的段落

- §4 数据流：新增「E′ 撤回」一条，写清三层（安全 / 数据 / 行为）与三种位置。
- §6 表：`改「被撤回的消息」` 一行 → `recall.js` + `index.js` 的 `handleRecall` /
  `clearQuoteFor` / `dropPending` / `dropAmbient` / `submitBatch` 里的 `action` 分支 +
  `Config.recall*` + `memory.noteRecall`。
- §5 硬约束：补一句「`quote.messageId` 是 pending / submitted / turnOwners 共享的同一个
  对象，改一处三处生效」。
