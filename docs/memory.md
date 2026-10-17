# 长期记忆：聊天记录 → 摘要 → 认知

> 每句话落盘、每天摘要、聊天时能查。认知（语言）与表情包（图）是两个文件，
> 写坏了有护栏与历史备份。实现全在 `memory.js`，读转录前先等写入。

默认开着。三件事：**每一句话都落盘**、**定时把它总结成记忆**、**聊天时随时能查**。

```
QQ 消息 ─▶ 转录(.qq-memory/…/log/YYYY-MM-DD.jsonl)         插件写，不经过模型
                 │
                 │  每天 digestAtHour（默认 04:00）醒一次：这个会话今天攒够了吗？
                 ▼
            独立「摘要会话」（qq_memory + qq_transcript + skill）
                 │  按 message-digest skill 读转录、写记忆
                 ▼
  conversations/<slug>/MEMORY.md   这个群的记忆           ┐
  COGNITION.md                     公共认知：语言梗 / 黑话  ├─ 摘要成 INDEX.md 的一行
  STICKERS.md                      表情包目录：名字 + 含义  ┘  每次提示词都带上
  INDEX.md                         短索引
```

**为什么是「摘要」而不是「把聊天记录塞回上下文」**：一个群一天的记录就能撑爆窗口，
而模型真正需要的是「kaguya是群主、周六打本、他不喜欢被叫大佬」这种**结论**。
转录是原料、记忆是成品 —— 成品每次进提示词，原料只在摘要与追问时才被翻。

## 记什么、记在哪

`memoryDir`（默认 `.qq-memory/`，**必须落在 `cwd` 内**，否则整个功能记一条 warn 并停用）：

| 路径 | 谁写 | 是什么 |
|---|---|---|
| `conversations/<slug>/log/YYYY-MM-DD.jsonl` | 插件 | 原始转录：每条**别人的**消息一行（含没 @ 机器人的群聊） |
| `conversations/<slug>/MEMORY.md` | 摘要 Agent | 这个会话的长期记忆（人、约定、偏好、在追的东西） |
| `COGNITION.md` | 摘要 Agent / 聊天中的模型 | 跨会话的公共认知：**只有语言**（梗、黑话、缩写、谐音；键是文字写法含变体） |
| `STICKERS.md` | `qq_save_sticker` / 摘要 Agent | 表情包目录：名字、画面、含义、场景、**收藏后的文件路径** |
| `INDEX.md` | 摘要 Agent | 「去哪里找什么」的短索引，每次提示词都注入 |
| `digest.json` | 插件 | 摘要进度（上次摘要时间 + **本地日期**），重启后据此补课、并保证一天至多摘要一次 |

`<slug>` 是会话 key 去掉冒号：`group:100000001` → `group-100000001`。

落到转录里的消息要**先过一遍准入规则**（私聊开关、群/私聊白名单）—— 记忆不会成为绕过
白名单的后门。机器人自己发出去的话不进转录：那是它说的话，不是群里的历史（本机 NapCat 的
`reportSelfMessage` 关着，这些消息其实也不会作为事件回来）。

## 定时摘要怎么跑

- **每天在 `digestAtHour`（默认凌晨 4:00，本地时间）醒一次**，醒来先跑摘要、再把下一次
  排到明天的同一个整点。挑凌晨是因为那时群里没人说话；每天一次也就意味着一个会话
  **一天至多摘要一次** —— 这条判据是「`digest.json` 里记的日期」（本地日界线），
  所以白天重启、重复启动都不会在同一天把同一个会话摘要两遍。
- 醒来后逐会话问两个问题：**今天摘要过吗**（日期判据）、**今天攒够 `digestMinLines`
  条新消息了吗**。攒不够就留到明天 —— 消息不会丢（计数一直累加），只是不为两三句话
  白跑一次模型调用。
- **错过就补课**（`digestCatchUp`）：如果摘要点那一刻进程正好在重启，或者这个会话是
  重启之后才有人说话的，那么它**一开口就补一次**，而不是等到明天。补课每次启动只跑
  一轮，不是每条消息一轮。
- 摘要在**独立会话**里跑（session id 由 `bridge:digest` 确定性派生）：它没有人格、
  不挂在任何 QQ 会话上、输出**不会**发到 QQ。它拿到的正文就是这段时间的转录，
  并被告知要处理哪个会话。
- 一次摘要最多喂 `digestMaxChars` 个字符（超出按**最近优先**截断，并在提示里说明
  前面还有更早的记录），单次有 `digestTimeoutMs` 硬超时：卡住的摘要 Agent 会被销毁，
  下次重新开一个，不让一个死掉的 turn 把摘要永久堵住。
- 摘要会话本身也有上下文窗口，但它**不是**记忆的载体：记忆在磁盘上、由 `qq_memory`
  读进来 —— 所以就算那个会话被压缩、被重启，记忆也不会丢。

## 聊天时怎么用

- **`qq_transcript`**：`list`（哪些会话有记录）／`read`（按会话读，可给日期范围）／
  `search`（按关键词找原话）。提示词里只放最近 `ambientMessages` 条，更早的靠它翻。
- **`qq_memory`**：`read`／`append`／`write`／`search`／`list`，外加两个**逐条**动作：
  `upsert`（按名字新增或替换一条认知 / 表情包条目，只给字段、格式与分节由代码生成）与
  `remove`。`write` 仍是整份覆盖，但有护栏：**条目数掉到 90% 以下直接被拒**（除非
  `force: true`）；每次写入前还会把旧版本存进 `<memory>/.history/`（每个文件留最近 20 份）。
  **写被限制在 `memoryDir` 之内**（`../`、绝对路径都直接报错），并有单文件字节上限 ——
  QQ 会话因此始终拿不到 `write` / `edit` / `bash`，能力面没有被记忆功能放大。
- **`INDEX.md` + 本会话的 `MEMORY.md` 每次提示词都注入**（有 15 秒缓存，上限 4KB）：
  模型一开口就「知道自己记得什么」，而不是先撞一次「不知道」再去查。

两个工具都在**宿主平面**注册，所以 Web UI 里的主会话也能直接用来翻记录 / 读记忆。

## 五个 skill（`.dsh/skills/`）

| skill | 什么时候加载 | 写哪 |
|---|---|---|
| `message-digest` | 定时摘要的那一轮；或有人在群里问「以前说过什么」需要系统整理时 | `MEMORY.md` / `INDEX.md`，并按分诊规则转给下面两个 |
| `learn-meme` | 遇到看不懂的**说法**（梗、黑话、缩写、谐音） | `COGNITION.md` |
| `learn-sticker` | 遇到看不懂的**表情包 / 梗图** | 先 `qq_save_sticker` 收藏，再写 `STICKERS.md` |
| `moegirl` | 遇到二次元 / ACG 相关的梗、缩写、角色、作品、弹幕用语，去萌娘百科查准确意思 | 不写 |
| `update-cognition` | **兼容壳**：只做一句话分诊（旧提示词 / 旧习惯还在用这个名字） | 不写 |

**分诊规则**（写在 `learn-meme` / `learn-sticker` / `message-digest` 三处）：有图 →
`learn-sticker`；只有文字 → `learn-meme`；图文都有 → 图进 `STICKERS.md`、那个词的用法进
`COGNITION.md`，两边互相写名字，不要在一个文件里写两遍；拿不准就不写。

`moegirl` 只管查：走萌娘百科的 MediaWiki 接口（`opensearch` 找条目名 → `prop=extracts`
取正文开头），**不用**全文搜索接口与条目网页（匿名调用被封、正文是脚本渲染的，实测都拿不到
东西）。弄懂之后的沉淀仍然归 `update-cognition`，所以没开长期记忆时它也能用 ——
skill 的发现归预设管，跟 `memory` 开关无关。

skill 由**预设**发现（不是宿主）：`dsh-web-app` 把宿主的 `skill-filesystem` 停掉了，
「locality 归预设管」。所以 `cordis.patch.yml` 的 `qq` 预设里挂了
`skill-filesystem` + `tool-skill`，扫的目录是 `<项目根>/.dsh/skills`、
`<项目根>/.agents/skills`、`~/.dsh/skills`，外加 `dsh-agent-preset` 随包出货的那套。
`allowTools` 里必须留着 `skill`，否则模型看得见目录却打不开。

新增自己的 skill：在 `.dsh/skills/<名字>/SKILL.md` 写一份（frontmatter 必填 `name`
与 `description`，name 要 kebab-case 且与目录同名），文件**不需要重启**就被发现。

## 认知（学梗）是怎么发生的

两条路，写进**两个文件**：

1. **聊天中按需**：遇到不懂的**说法** → `learn-meme`（写 `COGNITION.md`）；遇到看不懂的
   **图** → `learn-sticker`（先 `qq_save_sticker` 收藏，再写 `STICKERS.md`）；是二次元 /
   ACG 那一类就先按 `moegirl` 去萌娘百科查，其它话题用 `web_search`。懂之前不要装懂。
2. **摘要时自动**：定时摘要扫到新东西时按同一套分诊规则沉淀；只是又用了一次老梗就不动
   （认知库要短，长了没人读）。

**为什么分成两个文件**：它们的「键」根本不同 —— 梗是**文字写法**（所以 `qq_memory search
蚌埠` 能命中），表情包是**收藏后的文件名**（`.qq-stickers/委屈猫.gif`）。混在一起时，表情包
条目会拿 `.qq-media/<内容哈希>` 当键，而那是 LRU 缓存、迟早被淘汰，于是那条记忆变成一条
死链（真实事故：机器人说「存好了」，过几天那张图没了）。两条硬规则：

- `COGNITION.md` 里**不许出现文件路径**（`.qq-media/…`、`.qq-stickers/…` 都不行）；
- `STICKERS.md` 里**不许出现 `.qq-media`**（那说明还没收藏，先收藏再记）。

**提示词里怎么用**：`STICKERS.md` 的「已收藏」条目以「名字（含义）→ 完整路径」的形式每轮
注入（最多 40 条），模型看含义就能判断该不该发，不用先 `read_image` 猜；路径**原样给全**
（带上 `.jpg` / `.gif` 扩展名），模型抄进 `[[图片: …]]` 就行 —— 只给名字时它会猜扩展名，
猜错就是一次「那张表情我这儿没有」（真实事故：`敲盆.gif` 被写成 `敲盆.jpg`）。
`COGNITION.md` 最近 15 条「置信：确认」的条目作为「最近学的梗」注入（≤1200 字），谐音梗
不用先 search 再答。
「最近」按**首见日期**算，不按它在文件里排第几 —— 否则整理一次文件（合并标题、分节）
就等于悄悄换掉它每轮记得什么。没有日期的条目算最旧，同日期按文件顺序。
「置信：存疑」的条目**不进**提示词，只能被 `qq_memory search` 到 —— 那是给已经记下的猜测
留的余地，不是「先写一条再猜」的借口。

**怎么写入**：结构化文件只走 `qq_memory` 的 `upsert`（字段级），不要整份重写：

```
qq_memory { action: "upsert", path: "COGNITION.md", name: "蚌埠住了",
            meaning: "忍不住笑了", usage: "有人发离谱东西时",
            type: "谐音", variants: "绷不住/绷" }
qq_memory { action: "upsert", path: "STICKERS.md", name: "无语",
            meaning: "无语、懒得吐槽", image: ".qq-stickers/无语.gif" }
```

`type` 决定落在哪个二级标题：`缩写` / `谐音` / `专名`（游戏、角色、选手、作品）/ `其它`。
同名的会**原地替换**，不会多出一条；`remove` 按名字删。整份 `write` 仍然存在，但会先归一化
（重复二级标题只留一个、完全相同的行去重），并在条目数掉到 90% 以下时直接拒绝。

**从旧认知库迁移**：老部署的 `COGNITION.md` 里可能有以 `.qq-media/…` 为键的表情包条目。
`scripts/migrate-cognition.mjs` 一次性把它们迁到 `STICKERS.md`（用画面指纹认同一张被 QQ
重新编码过的图；认不出就标「原图已过期」放进「未收藏」区）：

```bash
node scripts/migrate-cognition.mjs --json            # 默认 dry-run，只看报告
node scripts/migrate-cognition.mjs --apply           # 真的写（先备份成 *.bak-<时间戳>）
node scripts/ops.mjs migrate cognition --apply       # 同一条路，走运维 CLI
```

退出码 `0` = 没什么要人处理的，`2` = 有认不出来的条目（报告里逐条列出），`3` = 脚本自己出错。

## 关掉 / 排查

```bash
# 关掉整个长期记忆（工具、skill 提示、定时器都消失）
memory: false

ls -la ~/Projects/qqbot/.qq-memory                  # 看到目录结构
cat ~/Projects/qqbot/.qq-memory/digest.json         # 上次摘要时间与条数
journalctl --user -u qqbot -f | grep 'qq-bridge: digest'        # 摘要开始 / 失败 / 超时
journalctl --user -u qqbot | grep 'qq-bridge: memory'           # 目录、定时器、启动补课
```

- **不摘要**：先看 `digestAtHour`（默认 4 点，别在下午找它）和 `digestMinLines`
  （没攒够就留到明天），再看 journal 里的 `qq-bridge: digest` 行 —— 每次真的跑摘要
  都会打一行「digest <key>: N/M lines」，每小时几点排的下一次定时器则在
  `qq-bridge: memory enabled at …` 那一行里。
- **错过了摘要点**：只要 `digestCatchUp` 没关，那个会话下次有人说话时就会补一次；
  关掉的话就要等到明天的 `digestAtHour`。
- **记忆是空的**：确认 `memoryDir` 在 `cwd` 内（配到外面只会有一条 warn 然后停用）。
- **摘要报错**：多半是预设里没有 `skill` 工具，或 `qq_memory` / `qq_transcript`
  被 `allowTools` 挡掉了（摘要 Agent 用的是同一份预设与白名单）。
- **条目「写了却没进提示词」**：那一行字段不全（少于两段），解析器只记 warn。`qq_memory read`
  的 note 会点出来，`node scripts/ops.mjs doctor` 报 `COGNITION_UNPARSED` —— 用 `upsert`
  重写那一行，别手写 markdown。
- **表情包发不出去、只收到一句「那张表情我这儿没有」**：`[[图片: …]]` 只认 `.qq-stickers/`，
  `.qq-media/<哈希>` 是入站缓存（默认 200 张，会被淘汰）。要让某张图以后能发，先
  `qq_save_sticker` 存一次。
- **想回滚一次写坏的记忆**：`.qq-memory/.history/` 里是每次写入前的旧版本（每个文件留最近 20 份）。
- **记忆文件越写越乱**：`doctor` 会报 `COGNITION_DUPLICATE_SECTION` / `STICKER_PATH_MISSING` /
  `STICKER_MEDIA_PATH`；下一次用 `upsert` 或整份 `write` 时，重复标题与完全相同的行会在落盘时
  自动合并。
