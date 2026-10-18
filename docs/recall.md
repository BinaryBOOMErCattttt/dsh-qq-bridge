# 被撤回的消息（`recallMode`）

> 撤回事件一到，先保证「不引用一条已经不在的消息」，再决定要不要有反应。
> 判据全在 `recall.js`，可以单测；`index.js` 只凑入参、记账、投递。默认是「撤回就当没收到」。

群友发了一句、又撤回了。这块拆成三层，**前两层永远生效**，第三层才是配置项：

1. **安全层：绝不引用一条已经不在的消息。** 回复本来是带着 `reply` 段指向那条消息发出去的，
   而 `sendOne` 失败时只记一条 warn、`sendParts` 见到失败就停 —— 结果是**这条回复剩下的气泡
   一起不发**，群里看到的只是「它没理人」。所以撤回一到，先把这个会话里所有指向它的引用清掉；
   清完 `@` 那一档仍然照常（`replyStyle: 'at'` 只用 `userId`，不依赖被清掉的 `messageId`）。
2. **数据层：它到底撤了哪句。** QQ 不提供回查已撤回消息的接口（`get_msg` 对撤掉的 id 要么
   报错、要么返回空），所以插件在收到每条消息时记一份「最近看见过什么」（每个会话 30 条、
   只在内存里）。撤回事件里只有一个 `message_id`，其余信息全靠这份账对出来。
   对不上的（重启之前发的、或者落在这 30 条之外）只记一条 info —— **「没看见」是一个有效
   状态**，不是错误。
3. **行为层**：`recallMode` 决定要不要有反应。

| `recallMode` | 还没进模型（还在攒批 / 只进了群聊上下文） | 已经投给模型 / 已经回过 |
|---|---|---|
| `off` | 不动（但引用照清） | 清引用，不补 |
| `ignore`（默认） | 没 @ 它的一律摘掉（它本来也只是「也许接一句」）；被 @ 的按 `recallAddressed` | 清引用，不补 |
| `tease` | 没 @ 它的摘掉；被 @ 的那条**就地改写成撤回提示**，这一轮直接调侃 | 清引用，过了闸门再补一句 |

`recallAddressed`（默认 `drop`）只影响「被 @ 的那条还没投出去就撤回了」：`drop` 是**真的不回**
（撤回就是没说过，群里和私聊同一套口径）；`answer` 才是照常回答、只是不引用 —— `@` 是明确
点名，认为「点名了就该有回应、哪怕问句已经撤掉」就选这一档（`ignore` 模式下它**根本不会知道
有人撤回过**，这也是「假装没看到」最自然的形态）。两种取舍都站得住；本仓库取前者
（撤回 = 没说过），想保留回答就改成 `answer`。

`tease` 的两种反应都是**伪造的 user message**（与戳一戳同一条通道），都带 `SKIP` 出口：

- **投递前改写**（那条还没进模型）：不另开一轮，就在本来要开的这一轮里把正文换成
  「他 @ 了你，接着又把自己那条撤回了」。另开一轮会变成「先回一句正经的、再补一句调侃」的两连发。
- **已经回头补一句**：只有在**这一轮真的发出去了**之后才算「已回过」；`turn` 还在飞时**不补刀**
  （这一轮的回复本身就是回应，再补一句是连发两条）。

补一句要过一串闸门（判据全在 `recall.js` 的 `recallAction` 里，可以单测）：`recallScope`、
`recallChance`、`recallCooldownMs`、`recallDailyMax`、`recallMaxAgeMs`，再加上几条硬性的 ——
**自己的消息被撤**不处理、**管理员代撤**（`operator_id ≠ user_id`）不调侃（那等于公开处刑）、
以及「这一轮还在飞」时不说。

几个刻意的取舍：

- **默认不给原文**（`recallTeaseQuote: false`）：复述别人撤掉的话是最常见的社交事故，而模型本来
  就有上下文；真要给也会折空白、截 80 字再进提示词（昵称与正文都来自 QQ，是不可信输入）。
- **`recallScope` 默认 `to-me`**：`all` 等于当众展示「它每条都看」—— 那是行为上的暴露，不是
  技术问题。想当群里的活宝再开。
- **私聊默认也处理**（`recallPrivate: true`）：私聊里撤回一条还没投给它的消息，同样不回。
  默认的 `ignore` 模式下它只做这一件事，不调侃；`recallMode: tease` 时建议把这一项关掉 ——
  私聊里调侃「你撤什么」很容易变成冒犯。清引用则是安全层，永远照做。
- **复读链不回滚**：撤回的正好是复读链第一条时链里还留着它，影响很小（下一条不同的消息就会
  把它顶掉），回滚要动三本账的不变量，不值得。
- **长期记忆只追加、不删行**（`recallMemoryMark`）：转录是只追加的原料，删行要重写文件、破坏
  「写边界只有一处」，还会牵动摘要状态。所以追加一行 `kind: "recall"` 的标记，摘要 Agent 一眼
  就能看出「这条撤了、别当事实」，而原文仍然在。

**默认就是「撤回就当没收到」**：`recallMode: ignore` + `recallAddressed: drop` +
`recallPrivate: true` —— 撤回的那条只要还没投给模型，就真的不回答（群里和私聊都算）。
想反过来（被 @ 的照常答、只是不引用），把 `recallAddressed` 改成 `answer`；想让它调侃一句，
`recallMode: tease`。注意只对**还没投进模型**的那条有效：攒批窗口（`batchWindowMs`，默认 2 秒）
之后、或者那一轮已经在飞了，撤回来不及 —— 这一轮的回复本身就是回应，不再追。

## 实现：事件、账本与流程

### 撤回事件长什么样

```js
// 群撤回
{ post_type: 'notice', notice_type: 'group_recall', self_id,
  group_id, user_id /* 谁发的 */, operator_id /* 谁撤的（管理员代撤时 ≠ user_id）*/,
  message_id, time }
// 私聊撤回（没有 group_id、没有 operator_id）
{ post_type: 'notice', notice_type: 'friend_recall', self_id, user_id, message_id, time }
```

`recallNotice`（纯函数）负责容错：`message_id` 可能是数字或字符串（统一 `String()`）、
`operator_id` 可能缺省（当本人撤回）、私聊没有 `group_id`。QQ 也没有「回查已撤回消息」的接口
（`get_msg` 对撤掉的 id 要么报错、要么返回空），所以原文只能靠下面这份账。

### 账本：`recent`

`index.js` 的 `handleEvent` 在 `admit` 之前调 `noteSeen`，把每条消息压进
`recent: Map<key, entry[]>`（每个会话 30 条，只在内存里）。撤回事件里只有一个 `message_id`，
原文、昵称、是否被 @、有没有投递 / 回复过，全靠这份账对出来。字段语义别合并：

| 字段 | 语义 |
|---|---|
| `recalled` | **事实**：发生过撤回（用来去重） |
| `action` | **决定**：`drop`（不投） / `rewrite`（投递时换成撤回提示） |
| `submitted` | **进度**：已经交给模型 |
| `replied` | **进度**：这一轮真的发出去了 |

### `handleRecall` 的顺序

```
recallNotice → 渠道 / 白名单准入 → clearQuoteFor（安全层，所有模式都做）
  → findRecent（对不上只记 info） → recalled 去重
  → memory.noteRecall（转录追加 kind:"recall"）
  → 还没投递：没 @ 它 / recallAddressed=drop ⇒ action='drop' + dropPending + dropAmbient
               被 @ 且 tease ⇒ action='rewrite'
  → 只有 tease 且已投递 / 已回过：recallAction 过 12 条闸门 → 先记账 → enqueue(nudge, proactive: true)
```

`handleEvent` 的 notice 分支先认撤回、再交给 `handlePoke`；`submitBatch` 见到 `action` 才决定
是摘掉这条、还是把正文换成撤回提示（两处都只认这一个标记，别在别处复制判断）。

### 坑清单

| 坑 | 处理 |
|---|---|
| `quote` 对象在 `pending` / `submitted` / `turnOwners` 之间共享 | 只清 `messageId`、留 `userId`，别复制新对象 |
| 摘空批次后 flush | 只清 timer，绝不 flush（会白等一个窗口） |
| `ambient` 的媒体是异步改写的 | 按 `id` 或对象引用删，别按文本比 |
| `replied` 的时机 | 只在这一轮真要发回复时由 `markReplied` 置 |
| `proactive: true` 的副作用 | 正好要：出错不道歉、SKIP 全局静默、不挂补一句 |
| 转录 / 记忆 | 追加 tombstone，不删行 |
| `/reset` | 清 `recent[key]` 与 `recallAt` / `recallToday` |
| 同一个撤回重复上报 | `recalled` 去重 + 冷却再兜一层 |
