# 本机开发与测试

> 源码就在仓库里，改完**必须重启 Harness**（Loader 按 URL 缓存模块）；测试是唯一能自动验证的东西。
> 安装见 [install.md](install.md)，代码结构与改动纪律见 [AGENTS.md](../AGENTS.md)。

## 本机开发

插件以 `link:` 方式装进 profile，源码就在当前目录。裸跑 `node --test test/` 时，Node 需要
能从本目录解析插件 import 的那三个 `@deepseek-ai/*` 包（`schemastery` / `dsh-tools` /
`dsh-llm`）。Linux/macOS 上那是一条第 0 代的软链接：

```
node_modules -> <dsh 安装目录>/node_modules
```

**Windows 上这条路走不通**：桌面版把这三个包放在 `resources/app.asar/dsh/node_modules`
（asar 归档里的虚拟目录，没有对应的真实目录可以软链），而 Windows 建软链/junction 在受限
令牌下会被拒。所以仓库里改用「按依赖闭包拷贝真实文件」的脚本：

```powershell
node scripts\dev-node-modules.mjs --from D:\deepseek-harness   # DSH 源码 checkout
node --test test\
```

它从一份 DSH 源码 checkout 出发，解析出那三个包真正 import 到的每一个包（十几二十个），
平铺拷进本仓库的 `node_modules/`（已在 `.gitignore` 里）。**它只服务开发与测试**：插件运行时
用的是 DSH 自己的解析（靠 `package.json` 里的 `peerDependencies` 声明，见
[Windows 桌面版](windows.md#windows-桌面版napcatshell)）。

> **发布包里跑不了测试**，要先铺依赖：zip 走 `git archive`，只带被 git 跟踪的文件，所以
> `node_modules/` 不在里面 —— 而 `bridge` / `client` / `perceptual` / `settings` / `util`
> 这五个测试文件都 import `index.js`，会连带 import 那三个 `@deepseek-ai/*` peer 包。
> 症状是整文件级失败（`✖ test\util.test.mjs`，只有 91 条被收集、5 条模块解析失败）。
> 想验就把上面那条 `dev-node-modules.mjs` 跑一次 —— 但它需要一份 **DSH 源码 checkout**，
> 只拿到 zip、没做过开发的人跑不了。**这不代表发布包坏了**：插件本身不需要自带
> `node_modules`（那三个 peer 由宿主运行时提供）。

> 在 DSH 自己的沙箱里跑测试时，`node --test` 会派生子进程并捕获输出，而沙箱不允许管道
> （`spawn EPERM`）。同一个套件用同进程模式跑即可：`node --test --experimental-test-isolation=none "test/*.test.mjs"`。
>
> 基线是 **580 条全过、0 跳过**（0.2.0 删掉 JM 之后，原先那 13 条「沙箱里跳过」的探针也随
> 之消失 —— 现在没有一条用例需要真的 `spawn` 外部进程）。原有的偶发规律仍在：全量同进程
> 连跑时偶尔红一条、且每次不同（`until` 轮询与真实计时的竞态），单独跑永远绿，重跑确认即可，
> 别为了「让它稳」放宽断言。
>
> 新增的纯函数测试文件：`test/persona.test.mjs`、`test/style.test.mjs`、
> `test/speech-policy.test.mjs`、`test/modalities.test.mjs`、`test/links.test.mjs`、
> `test/interactions.test.mjs`、`test/cognition.test.mjs`、`test/migrate-cognition.test.mjs`、
> `test/ops.test.mjs`、`test/reminders.test.mjs`。行为层的新用例在 `test/bridge.test.mjs`：
> 气泡条数与中断、标点清洗、引用指向（表情消息不引用）、C 路四条排除、私聊补一句、戳一戳、链接预览、
> 视频封面、语音占位、定时提醒（text / agent / SKIP / 超时 / 重启 / 权限）。

### 改完源码必须重启 Harness

Loader 在进程内按 URL 缓存插件模块，**停用/启用插件不会重新加载代码**
（已验证：`set_plugin` 会注销并重新注册工具，但模块仍是第一代；改入口文件名、
`remove_bundle` + `install_bundle` 同样无效）。改了 `index.js` / `config.js` /
`settings.js` / `tools.js` / `onebot.js` 这些模块之后必须重启 `dsh --profile qqbot` 进程：

```bash
# Ctrl-C 后重新执行
dsh --profile qqbot --port 3081 --no-open
```

只有插件 `cordis.patch.yml` 里的配置改动可以热生效，源码改动必须重启。

### 跑测试

`test/bridge.test.mjs` 会起一个假的 OneBot WebSocket 服务端 + 假的 Harness
上下文，跑完整的入站/出站链路（真实使用 `ws` 与本插件的 OneBot 客户端）：

```bash
node --test test/
```

（Windows 上先跑一次 `node scripts\dev-node-modules.mjs --from <DSH checkout>` 铺好
`node_modules`；在 DSH 沙箱里跑要加 `--experimental-test-isolation=none`，见
[本机开发](#本机开发)。）

覆盖：私聊往返、群里 @ 触发与 `@机器人你好` 的 mention 剥离、白名单与
未开启渠道的丢弃、**没有正文的消息**（单纯 @ 与只有空白都开一轮且带对措辞、
`groupTrigger: all` 与私聊的措辞不同、`blankReply: false` 回到丢弃、
活跃对话窗口里的空消息不算接话）、空白文案纯函数的三种情形、模型路由（配置优先、
否则继承部署默认）、出站工具、
超长消息分段、会话列表，以及「像真实群友」那一组：群聊上下文进入提示词并可关闭、
攒批（三个人几乎同时 @ 只变成一条消息、只发一条回复且不逐人引用、`batchWindowMs: 0`
回到逐条、一直有人说话时按 `batchMaxWaitMs` 的上限发出、`/reset` 先把攒着的那批投出去）、
自动回复按换行/短句拆成多条且打字延迟真的接上了配置、多条时引用只挂在第一条、
`humanize: false` 回到单条、群聊引用/@ 指向（含 `auto` 的两面：紧挨着回不引用，
中间又出现了消息 —— 别人说的、或者机器人自己刚发的 —— 才引用）、
群名与「当前发言者」不再过期，外加 `splitBurst` / `typingDelayMs` 两个纯函数的边界用例。

还有「@ 人」那一组：正文写 `[[@昵称]]` 真的变成 `at` 段且位置照原文、整条回复只有一个标记时
只发一个 at 段一个字都不说、`[[@全体成员]]` → `qq: all`、认不出来的名字把标记整个丢掉
（整条只剩标记时一个字都不发）、引用指向与该标记同时出现时顺序是「先指向后正文」、
**同一批攒到一起的几个人都能被 @ 到**、名单按会话隔离（群里认识的人在私聊里 @ 不到、私聊里也没有
「全体成员」）、`qq_send_message` 用同一套解析（往没聊过的群发标记退化成纯文本而不是报错），
以及提示词里**不再出现任何 QQ 号**。标记解析本身另有一套纯函数用例在
`test/mention.test.mjs`：未闭合 / 空名字 / 名字带括号 / 名字里带空格 / 认不出来时前后正文一个字不丢、
精确优先再忽略大小写、同名的按登记顺序取第一个、`all` 与「全体成员」两种写法。

还有「自动复读」那一组：两条相同的群消息真的跟一句且**不建会话**、
中间插了别的话 / 隔得太久（`repeatWindowMs: 0` 则不限间隔）/ 只有一个人连发两遍
（`repeatDistinct: false` 时反过来）/ 正文太长 / 私聊 / 白名单外的群 都不跟、
`repeatCount` 要攒够人数、`repeat: false` 与 `repeatChance: 0` 完全关掉、跟过一次就断链、
被 @ 的消息走 Agent 回答而不是被顺带复读（并且打断链）、`groupTrigger: all` 时无处插话、
只有空白不同的相同正文照样算且复读的是后一条原文，复读的正文**不会**被解析成
`[[图片: …]]` 标记（群里人打的是字，不是发图指令），外加 `repeatableText` 的纯函数用例。

还有「表情包复读」那一组：连着两张一样的图就把那张原样发回去（`base64://` 解出来就是原字节）、
不同的两张图不跟、一张图会打断文字链、系统表情（`face` 段）连着两个一样的也跟、
**复读沿用原消息的类型**（原消息是表情就带 `sub_type: 1`、是普通图片就不带、带 `emoji_id`
的商城表情也按表情发）、**同一张画面被 QQ 重新编码（字节不同）时也跟**（PNG 版与 JPEG 版
连着两条 → 跟出后一条的字节）、
`repeatImageTolerance: 0` 回到只认字节完全相同的旧行为、
`repeatMedia: false` 只停图不停文字、图和话混着发或一条里两张图都不算候选、
取不到字节的图不跟，以及**带宽账**：两条消息一共只下载两次（环境上下文与复读共用同一次，
不为复读多拉一遍），`ambientMedia: false` 时一次都不下载、也就没有表情包复读。

图片指纹单独有一套 `test/perceptual.test.mjs`（fixture 在 `test/image-fixtures.mjs`，都是
真编码的字节）：同一张画面的 PNG / baseline / progressive / 两次重新编码的 JPEG / 调色板与
动图 GIF / 灰度 / 16bit / RGBA 十种编码指纹逐位一致、另一张画面必须差得远、同一套画风只换掉
上面几行文字必须判成两张、WebP 与 CMYK JPEG 和隔行 PNG 与 64×64 的小图与纯色图一律不给指纹、
畸形/截断/解压炸弹只返回 undefined 不抛异常，外加 `hashDistance` 与三个解码器输出平面的用例。

还有「读表情包」那一组：图片真的落盘且字节未变、内容哈希去重与按最近使用淘汰、群聊
环境上下文默认也落盘（`ambientMedia: false` 时退回不下载）、
引用消息走 `get_msg` 把被引用那条的图取回来（引用段换成引用前缀、纯文本引用进正文、
实现不支持 `get_msg` 时安静降级、`quoteMedia: false` 一次都不发）、
抓不到时降级成占位符并能靠 `get_image` 的 base64 兜底、
`mediaDownload: false` 与超限跳过、`mediaDir` 被配到 `cwd` 外面即整体停用，外加
`collectMedia` / `mediaPlaceholder` / `sniffImageExtension` 的纯函数用例（测试里的假
OneBot 按真实形状回 `image` 段，另外起一个 HTTP 服务假装腾讯的图片 CDN）。

还有「发表情包」那一组：发出去的确实是一个 `image` 段且 `base64://` 解出来就是原字节、
从 QQ 会话里调用默认发回当前会话（群里也能显式指定群号）、把会话里刚收到的那张图
（正文给了 `.qq-media/…` 路径）原样发回去、非图片 / 超过 `imageMaxBytes` / `cwd` 之外的
路径一律在发消息之前就失败、`imageSend: false` 直接报错、渠道提示里列出 `.qq-stickers/`
的文件名（被 `allowTools` 挡掉或目录在 `cwd` 外时一个字都不提），外加
`loadOutgoingImage` / `imageSegment` 的纯函数用例（本地路径、`file://`、URL、大小与格式校验）。

以及「存表情包」那一组：把会话里刚收到的那张图存进 `.qq-stickers/` 且落盘的是**原字节**、
存完下一轮提示词里就列得出来（裸文件名也认得出发）、非图片 / `cwd` 之外 / 名字洗成空 /
同名已存在一律拒绝（目录里不会留下半个文件）、超过 `imageMaxBytes` 或张数到
`stickerMaxFiles` 时拒绝、目录配到 `cwd` 外或白名单里没有它时**工具根本不注册**、
`stickerFileName` 的纯函数边界（丢掉目录部分、扩展名以真实格式为准、非法字符与超长名）。

以及「只发表情」那一组：`[[图片: …]]` 标记的纯函数用例（关键字与全角冒号、夹在正文中间
时顺序不变、空载荷与不认识的方括号都退回普通文字）、整条回复只有标记时**只发一张图、
一个字都不发**（`humanize` 开着关着都一样）、夹在文字中间时位置正确、只写文件名也能认到
`.qq-stickers/` 里的那张（工具那边同一套解析）、群聊里引用指向挂在图本身那条上、
发不出去时回一句「（那张表情我这儿没有，发不出去）」而不是静默（原因还会写回下一轮提示词）、
只认 `.qq-stickers/` 里的文件（`.qq-media` 即使存在也拒发）、`imageSend: false` 或白名单没放开时标记
退回普通文字。

最后是「长期记忆」那一组：每条别人的消息都落一行转录（**没 @ 机器人的群聊也算**，
并标出 `addressed`）、闲聊不会凭空把某个群变成「已处理会话」、`qq_transcript` 的
list / read / search（默认就是调用它的那个会话）、`qq_memory` 的 append / read /
write / search / list 与「路径写出记忆目录一律被拒」、每天一次的定时器**排到下一个
`digestAtHour`**（断言它落在一天之内、且指向下一个整点）、定时器睡醒后为一个攒够消息的
会话起一个**独立摘要会话**并把转录正文交给它（并在 `digest.json` 里记下时间与本地日期）、
同一个会话**一天至多摘要一次**、没攒够条数就不建摘要会话、错过摘要点时下次有人说话就
补课（而 `digestCatchUp: false` 时不补、补课也只跑一轮而不是每条消息一轮）、索引与记忆
进了渠道提示、`memoryDir` 配到 `cwd` 外时工具与定时器都不存在、以及摘要卡住时硬超时会
销毁那个摘要 Agent 并重试。

最后是「主动说话」那一组：`proactive` 默认开着（`proactive: false` 时连定时器都不挂，条件调成「一定会说」
也不开口）、群里安静下来之后真的投出一条**伪造的提醒**（里面点明「不是谁发给你的消息」、
给出 `SKIP` 出口、带上了群里刚聊的那句）、主动的回复照样按换行分条走拟人通道、
判成 `SKIP`（哪怕后面带一句括号里的解释）一个字都不发、**回别人的那一轮判成 `SKIP`
同样一个字都不发**（引用着消息的那一轮也一样：判成 `SKIP` 连引用段都不发出去）、
**掷中即消耗机会**（判过 `SKIP`
之后间隔闸照样生效，不会变成「再来一次」）、私聊永远不是候选（会话停在「最后说话的是对方」
的状态也不打扰）、时段之外 / 群里刚说完话 / 冷群太久 / 当天额度用完时都不开口、
自己刚说完没人接话时**不自言自语**、主动的 turn 出错时不在群里道歉、`/reset` 连它的
节奏一起忘掉（旧 Agent 销毁、新的那个重新开口），外加 `withinActiveHours` 的边界用例
（左闭右开、两边相等 = 全天、`from > to` 跨零点）。

还有「活跃对话」那一组：`activeFollow` **默认开**（关掉之后群里回复仍然必须有 @）、打开后
跟它聊的那个人接着说的话真的会被接住（正文照样是原话，前缀模式下不会被按前缀长度切掉）、
别人插一句不算（窗口跟着「最后跟它说话的那个人」走）、中间有别人说过话这段一对一就断了、
`@别人` 的消息不算接话、`activeMaxTurns` 接够了就要求重新 @、窗口过期同理（默认 1 分钟）；
**多人搭话**：群里几个人说够 `activeGroupLines` 条、够 `activeGroupSpeakers` 个人之后，
没被 @ 的陌生人说话也会被接住、之后换个人说话照样算、同一个人自己刷屏（人数不够）不算、
搭话状态里攒批窗口真的按 `activeGroupBatchScale` 变长（到点前不投出去）、
`activeFollow: false` 时这套同样不生效、`/reset` 把群聊热度一起清掉；**搭话抽卡**：
够资格也未必接（起始概率 0 时真的一句都不进模型）、连丢一条之后概率涨上来才接、抽中之后
累计归零、被明确 @ 到也归零、多人搭话里换个人接话同样按那一次掷中的概率走、这段对话凉掉
之后累计不跨对话（不把上一场攒的保底留到下一场），以及概率曲线的纯函数边界（起始 + 每步
累加、封顶、上限配得比起始小、NaN 一律不接）；以及「补一句」：
回完之后对方安静一小会儿它真的补一句（私聊与群聊各一条通路，提醒里点明「你已经回过话」）、
判成 `SKIP` 一个字都不发、没有 `proactive` 总开关就不补、群里中间有人插话不补、
对方再说一句会把挂着的补一句作废（不会攒出一堆）、`activeChimeDailyMax` 用完了不再补、
`/reset` 把「还聊着」与挂着的补一句一起忘掉、以及「`/reset` 换成新一轮的 Session id
而旧会话留在磁盘上」「重开进程后仍然停在同一轮」「只有 `resetUsers` 里的人能重置，别人
连会话都开不出来」，外加 `mentionsOthers` 的纯函数用例。
窗口里接上的那句**不会**触发 `/reset` 这类旁路（它只是闲聊，指令要明确叫它）。

以及「每天轮换 API key」那一组：池子文件的纯函数边界（注释 / 空行 / CRLF / 前后空白 /
重复）、到点从**当前 key 的下一个**开始试、探测失败（401）的候选被跳过而第一个通过的
（200）被写进凭据（`credentials.set` 的 ref 与值都对）、一个都不通过时**一个字节都不写**、
key 由启动环境提供（`describe().writable === false`）时提前退场（连探测都不发）、
组合里没有凭据服务时只记一条 warn、池子里没有第二个 key 时什么都不做、池子文件还没建时
只记一条 info 说明该放哪、池子配到 `cwd` 外时整个停用且不排定时器、默认开着而
`apiKeyRotate: false` 时连定时器都不挂，以及**日志里不会出现完整的 key**。

最后是这次 Windows 适配新增的两组（都不起 Harness，直接测纯函数/文件）：

- `test/napcat.test.mjs`：endpoint 解析（只认 `ws`/`wss`、端口越界不猜）、账号文件识别
  （只认 `onebot11_<QQ>.json`）、「NapCat 那边够不够用」的每一条判据（没配 / 端口不对 /
  没启用 / token 两个方向不一致 / `reportSelfMessage` 与监听地址只当 note）、幂等改写
  （追加 / 原地合并且**保留用户的 debug 与 heartInterval** / 再应用一次不变 / 不就地改原对象），
  以及真落盘的那几条：**默认一个字节都不改**、允许写时先备份且第二次不再动、token 不一致
  改回同一条而不是追加第二条、坏 JSON 与不存在的目录只报告**绝不覆盖**、自动探测只认
  「有 config 且有账号配置」的目录；`test/bridge.test.mjs` 末尾另有两条验接线：自检发现问题时
  warn 里带原因与修法且不改文件、`napcatAutoConfig` 打开时才写（含备份、并提示重启 NapCat）。
- `test/desktop.test.mjs`：`.env` 维护段落的**幂等**（重复运行逐字节相同、取值变了只换一段、
  段落之外的内容不动、CRLF 检出也认得出来）与 profile manifest 的两处一起改
  （依赖 + `dsh.profile.bundles`、只差一半时能补上、换仓库路径时 `link:` 跟着改、
  原有依赖与 bundle 一个不少、不就地改原对象）。

> 这两组之外，「一键脚本」本身是**照着 [Windows 桌面版](windows.md) 那份流程在真机上手工验过**的
> （`--dry-run` 与真跑共用同一条代码路径），端到端行为不靠单测钉。

设置页那半侧（`client.js`）另有一套 `test/client.test.mjs`：它不需要浏览器 —— 假的
`window.__ModuleLoader__` 收下注册、假的 `require` 给出 react / primitives、假的
`useState` 让 tab / 搜索 / 只看已改的状态能被驱动（`useEffect` 是空实现：迷你渲染器不跑
effect，取数那一步不在 node 里验），然后用一个十几行的迷你渲染器把页面
展开成节点树，钉住「页面注册在 `settings.section` + 条目 id `qq-bridge`」「141 个字段在
7 个 tab 的合集里恰好各出现一次、都不落进『其它』」「每个分组恰属一个 tab」、「控件映射
（32 个布尔是 `Switch`、8 个枚举是 `<select>`、长文本是 `textarea`）」「草稿的读写口径
（`true`/`是`/`1` 都算真，空串 = 恢复默认，胡说会被挡住）」「切 tab 不丢草稿」「搜索按
标签 / 字段名 / 描述 / 区块标题命中、结果行可编辑、`Esc` 清空」「只看已改与计数」
「量纲白名单覆盖所有 `Ms`/`Bytes`/`Chars`/`Hour`/`Chance` 字段」「只读部署里全部控件
`disabled`」「群聊页那块只读的定时任务列表（外壳与加载态、行里的状态 / 模式 / 时间 /
目标 / @ / 错误、空列表，以及与 Host 路由同一条路径）」，以及整棵树真的能渲染成
`SettingsForm` + 7 个 tab + 官方两种字段行。
**加了新配置项忘了分组、或加了枚举取值忘了写人话，这里都会红。**
