# Windows 桌面版（NapCat.Shell）

> 桌面版 DSH（Electron）与 NapCat 跑在**同一台 Windows 机器**上：没有 docker 网桥、没有
> `systemctl`，Host 进程的 cwd 是 DSH 的 profile 目录。仓库里的 `scripts\napcat-setup.cmd`
> 把两边一起配好。Linux / 容器部署见 [install.md](install.md)。

## 照着走一遍（第一次装就按这个顺序）

1. 解压发布包到**你想长期放着的位置**（比如 `D:\dsh-qq-bridge-0.2.0`），以后别再挪：
   profile 里存的是指向这个目录的链接，挪了要重跑一次脚本（脚本会自己发现并重建链接）。
2. 双击 `scripts\napcat-setup.cmd`（或跑 `node scripts\napcat-setup.mjs`）—— 它配好 NapCat
   的网络配置、profile 的 `.env`，并把插件装进 `desktop` profile。想先看它要做什么就加
   `--dry-run`；知道自己机器人的 QQ 号就带上 `--qq <号>`，它会顺手写好快速登录。
3. 启动 NapCat 扫码登录：`scripts\napcat-setup.cmd --start --window normal`
   （**第一次要看得见窗口**才能扫二维码）。登完确认它能正常监听端口。
4. **再跑一次脚本**（同第 2 步的命令）—— 这一步是必须的：`config/onebot11_<QQ号>.json`
   与 `config/webui.json` 都是 NapCat **第一次启动时**才生成的，第二次运行才能把
   WebSocket 服务器那一条对齐、并写进 `autoLoginAccount`。
5. 重启 DSH 桌面版（源码在启动时加载，装完必须重启）。
6. 在 DSH 的 **Models** 页面确认模型凭据已填。
7. 私聊机器人发一句话，它在 QQ 里回你就说明整条链路通了。
8. （可选，推荐）`scripts\napcat-setup.cmd --autostart install`：以后开机静默启动，
   没有那个黑框框、也不再问 UAC。见[不要那个黑框框](#不要那个黑框框推荐做法)。

命令清单（第 2 / 4 步用的就是前两条）：

```powershell
# 在仓库根目录（或者直接双击 scripts\napcat-setup.cmd）
node scripts\napcat-setup.mjs --dry-run      # 先看它打算做什么：一个字都不写
node scripts\napcat-setup.mjs --qq 123456    # 指定机器人账号（还没登录过也能先写好配置）
node scripts\napcat-setup.mjs                # 真配
node scripts\napcat-setup.mjs --start        # 顺手启动 NapCat（提权 + 快速登录，窗口默认最小化）
node scripts\napcat-setup.mjs --autostart install  # 装计划任务：以后开机静默启动，没有黑框框、也不再问 UAC
node scripts\napcat-setup.mjs --autostart status   # 看它装没装、上次跑成没成
node scripts\napcat-setup.mjs --autostart remove   # 不想要了
node scripts\napcat-setup.mjs --where        # 只回答「用的是哪份 node」，排查用
```

> **不装 Node 也能跑**：`scripts\napcat-setup.cmd` 会按「PATH → `DSH_DESKTOP_NODE_EXECUTABLE`
> → 桌面版安装目录里自带的那份 Node」的顺序找解释器，找到了就直接用它跑 `.mjs`；
> 桌面版自带的是完整的一份 Node（实测 v24.x），所以新机器上不需要先装 Node。
> 一个都没找到时它会把确切路径的写法打出来，`--where` 则随时能告诉你现在用的是哪一份。

它做五件事，每一步都是**幂等 + 先备份**：

1. **NapCat 的网络配置**：在 `<NapCat>\config\onebot11_<QQ号>.json` 里写好（或对齐）一条
   监听 `endpoint` 端口的 WebSocket 服务器 —— `name: dsh-qq-bridge`、`enable: true`、
   `reportSelfMessage: false`、`messagePostFormat: array`、token 与 `accessToken` 一致。
   **只动 `websocketServers` 里我们那一条**：用户自己调过的 `debug` / `heartInterval`、
   以及 `httpServers` / `websocketClients` / `timeout` 全部原样保留；改之前把原文件复制成
   `onebot11_<QQ>.json.bak-<时间戳>`。已经配好时**一个字节都不写**（连备份都不产生）。
   > NapCat 目录怎么找：`config/onebot11_<QQ号>.json` 是**登录之后**才生成的，所以
   > 「刚解压、还没登录过」的 NapCat 也认（判据是目录里它自带的 `launcher*.bat` /
   > `napcat.mjs`）—— 发布版安装流程正是这一种，不然 `--qq` 那条路永远走不到。
2. **快速登录**（只在显式给了 `--qq` 时）：把 `<NapCat>\config\webui.json` 的
   `autoLoginAccount` 设成这个号，NapCat 以后启动就自己快速登录，不用每次掏手机扫码。
   同样只动那一个字段、先备份；`webui.json` 还不存在（NapCat 没启动过）时**不凭空造**它，
   而是提示你登录完再跑一次。不想要这条就加 `--no-auto-login`。
   > 快速登录的前提是本机已经为这个号留下过登录记录；没有记录时 NapCat 会退回二维码 ——
   > 那不是失败，扫一次码，之后才会走快速登录。
3. **profile 的 `.env`**：把 `QQBOT_ENDPOINT` / `QQBOT_ACCESS_TOKEN` / `QQBOT_CWD` /
   `QQBOT_NAPCAT_DIR` 写进 `~/.dsh/profiles/desktop/.env` 里一段带标记的段落，段落**之外**
   的内容一个字节都不动。这些取值由 `cordis.patch.yml` 里的 `!!js process.env.QQBOT_*`
   读进配置 —— 「每台机器不一样的值」全走 `.env`，仓库里那份 patch 保持所有部署共用。
   （`#` 是 `.env` 的注释符，取值里别出现它。）
4. **装进 desktop profile**：`package.json` 里加 `"@qqbot/dsh-plugin-qq": "link:<仓库>"`，
   并把它追加进 `dsh.profile.bundles` —— **两处都必须有**，只加依赖不加 bundles 等于
   「装上了但不加载」；再在 `profiles/desktop/node_modules/@qqbot/dsh-plugin-qq` 建一个指向
   仓库的链接（Windows 上用 junction，不需要开发者模式）。原 `package.json` 先备份成
   `.bak-<时间戳>`。
   > 链接**已经存在**时会读一眼它指着谁（junction 也能读）：指着别的目录（上一份发布包、
   > 旧的 clone）就删掉重建，并把你原来指向哪也打出来。「存在就当装好了」是不行的 ——
   > 解析实际走链接，于是会出现「manifest 写的是新路径、加载的是旧代码」而**一句报错都没有**。
   > 目录里那个东西如果**不是链接**（例如你手工拷了一份插件进去），脚本不删它，只提醒你
   > 现在加载的是它、不是本仓库。
5. `--start` 时启动 NapCat：**以管理员身份**（UAC 弹窗点「是」）跑官方文档让双击的那个
   `launcher.bat`，并把 `--qq` 当 `-q <号>` 传进去让它快速登录。窗口样式由 `--window` 决定：
   `normal` / `min`（默认，最小化、不挡视线）/ `hidden`（无窗口，走的是另一套机制，见下）。
   **首次登录要扫二维码，得能看见窗口**，所以第一次请用 `normal` 或 `min`。

## 不要那个黑框框（推荐做法）

> **那个黑框框就是 NapCat 本体**：关掉它 = 停掉机器人，它不是「一个可以随手关掉的日志窗口」。
> 想让它彻底消失，三条路，按推荐程度排：

| 这条路 | 适合谁 | 代价 |
|---|---|---|
| `node scripts\napcat-setup.mjs --autostart install` | 大多数人 | 装的时候点一次 UAC；以后开机**静默**启动，没有窗口、也不再问 UAC |
| 官方 [NapCat.Windows 可视化管理工具](https://github.com/NapNeko/NapCatQQ-Desktop) | 想要图形界面 / 多账号的人 | 多装一个 EXE（单文件、托盘托管、后台静默） |
| `--start --window min`（默认） | 只想最小化、不想动系统设置 | 任务栏里仍然有一个 NapCat 的控制台 |

**为什么不能简单地「隐藏窗口」**：`launcher.bat` 发现自己不是管理员时，会用
`launcher-elevate.ps1` **把 `wt.exe`（Windows Terminal）提权起来**再重跑自己 —— 而 Windows
Terminal 根本没有「隐藏启动」这回事，那个窗口一定会出现。所以 `--window hidden` 走的是另一条
路：提权跑 `wscript.exe`（GUI 子系统程序，自己不带控制台），由它用 `WshShell.Run` 的窗口样式
`0`（SW_HIDE）去起 `cmd.exe /s /c "launcher.bat" -q <号>` —— 控制台**从创建那一刻**就是隐藏的。
三个细节都是踩出来的，别顺手改：

- **必须 `wscript.exe //B`**：不加 `//B` 时 WSH 一出错就弹一个模态错误框停在那儿等人点，
  而我们连窗口都没有 —— 表现是「机器人静默停住、日志里什么都没有」（本地实测：同一份脚本
  加 `//B` 跑通，不加就是卡住等点）。
- **命令行走 `cmd.exe /s /c`，而不是把 `.bat` 直接交给 WshShell.Run**：后者走文件关联
  （ShellExecute），从下载来的 zip 里解压出来的 `.bat` 带 Mark-of-the-Web，会弹「打开文件 -
  安全警告」等人点 —— 同样是我们看不见的卡死。
- **包装脚本按 UTF-16LE + BOM 落盘**：WSH 读没有 BOM 的脚本时按系统 ANSI 解码，注释和中文
  路径会变成乱码。

`--autostart install` 做的是一次性注册一个计划任务（名字 `dsh-qq-bridge-napcat`）：

- **登录时触发 + 以最高权限运行（`RunLevel: HighestAvailable`）**：不提权 QQ 会崩在
  `QQNT.dll`（见[下一节](#为什么必须提权启动实测)），而计划任务让「提权」不再需要每次点 UAC
  （`schtasks /run` 直接以最高权限起来）。
- **`LogonType: InteractiveToken`**：必须跑在**用户会话**里。NapCat 要拉起 `QQ.exe` 并注入，
  「不管用户是否登录都运行」会把进程扔进会话 0，那里 QQ 根本起不来。
- **`MultipleInstancesPolicy: IgnoreNew` + `ExecutionTimeLimit: PT0S`**：不许起两份（抢同一个
  QQ 和端口），也不许跑满默认的 72 小时被掐掉。
- 装的时候顺手把 NapCat 的日志改成**写文件**（`config/napcat.json` 的 `consoleLog=false` /
  `fileLog=true`，先备份、幂等，`--no-log-to-file` 可关）：窗口看不见了，日志是唯一的现场，
  落在 `<NapCat>\logs\<时间戳>.log`（NapCat 自己按 5MB × 5 个轮转）。
- 脚本会把 **WebUI 的地址与 token** 打出来（从 `config/webui.json` 读）。它是隐藏之后唯一
  还看得见的「控制台」：**看日志、扫码登录、改配置都在那里** —— NapCat 的 WebUI 自带登录页
  与二维码，所以「窗口藏起来就没法第一次扫码」并不成立。token 原本是打在控制台里的，现在从
  那个文件里读给你。
- 停止：`schtasks /end /tn dsh-qq-bridge-napcat`（必要时再跑一次 `<NapCat>\KillQQ.bat`）。
  卸载：`--autostart remove`。

**第一次登录仍然建议先看得见**：脚本在 `config/webui.json` 还不存在时（= 这份 NapCat 从没
启动过）会**拦住** `--autostart install`，让你先跑一次 `--start --window normal` 扫码 ——
那时既没有二维码可看、WebUI 也还没生成，隐藏启动等于把自己关在门外。知道自己在做什么就加
`--force`（例如你打算装完再从 WebUI 登录）。

> 在 DSH 自己的沙箱里跑这个脚本时，`schtasks` 与 CIM 会被拦下（实测报「无法从客户端中访问
> CIM 资源」/「系统找不到指定的路径」）。**注册计划任务这一步请在普通终端里跑**（双击
> `scripts\napcat-setup.cmd` 也算）。

`--dry-run` 与真跑共用同一条代码路径，所以试运行的输出就是真会发生的事。脚本**不碰**
`~/.dsh/.credentials.yaml`：模型凭据仍然在 DSH 的 Models 页面里填一次。

## 为什么必须提权启动（实测）

NapCat 官方文档让用户双击的是 `launcher.bat` —— 包里那几个启动器里，它是**会自己提权**的
那个（`launcher-user.bat` 是刻意不提权的变体）。这不是洁癖，是一次实测的结论：

| 启动方式 | 结果 |
|---|---|
| `launcher-user.bat`（普通用户） | 注入其实**成功**了（崩溃转储的模块列表里能看到 `NapCatWinBootHook.dll` 已加载、QQ 的 Node 运行时 `major.node` 也在），但 QQ 随后在 `QQNT.dll` 里撞 `0x80000003`（STATUS_BREAKPOINT）当场死掉，控制台只剩一句 `Process exited.` |
| `launcher.bat`（管理员） | 正常起来：登录、监听端口、插件接上，全对 |

当时的组合是 QQ 9.9.35-52892 + NapCat 4.18.38，而 NapCat 自己的 `qqnt.json` 与兼容表都覆盖
这个 build（`9.9.35-52892-x64` 的发包/收包 RVA 都在表里），QQ 的安装目录也干净 —— 没有
`loadNapCat` 之类的改动痕迹。所以这**不是**「QQ 版本不受支持」或「装坏了」。

排查用的两处证据：崩溃转储在 `%LOCALAPPDATA%\CrashDumps\QQ.exe.*.dmp`（minidump 头部的
模块列表能看出注入到底成没成），系统事件日志里则是 `APPCRASH / QQNT.dll`。

`--start` 因此走「我们自己提权」（`Start-Process -Verb RunAs`），而不是 `cmd /c start`。
看到 `Process exited.` 时先确认启动器是提权跑的那个，再看系统事件日志里的 `APPCRASH` 落在
哪个模块。要连窗口一起免掉（也不再一次次点 UAC），装[计划任务](#不要那个黑框框推荐做法)。

## 装进 `desktop` profile 的四个代价（都处理掉了）

| 代价 | 怎么修的 |
|---|---|
| QQ 会话可能继承 desktop 的默认预设（`standard`，带 shell / 子代理 / write） | 本 bundle 自带 `qq` 预设，`cordis.patch.yml` 里写死 `agentPreset: qq`，所以 QQ 会话拿到的仍然只是「只读文件 + 检索 + 联网 + 本地 skill」；`allowTools` 再收一层。换 profile 不影响这条 |
| 媒体 / 表情包 / 记忆会写进 `~/.dsh/profiles/desktop` | 桌面版是拿 profile 目录当 Host 进程的 cwd 的。脚本写的 `QQBOT_CWD`（默认 `~/.dsh/qq-bot`）把这三个目录挪到一个干净、独立的地方（它们必须落在 `cwd` 内，否则各自记 warn 并停用） |
| `@deepseek-ai/schemastery` / `dsh-tools` / `dsh-llm` 的解析 | 按 DSH 的解析规则，link 安装的插件是「linked root」，宿主那份包**只有声明成 `peerDependencies` 才会被用上**；`package.json` 里因此声明了这三个 peer。不声明的话会去用仓库里那份副本，于是宿主与插件各持一个实例（工具注册、消息构造都会开始出怪问题） |
| 改了代码不生效 | Loader 按 URL 缓存插件模块：装完 / 改完源码必须**重启整个桌面版**（停用启用插件没用）。只有 `cordis.patch.yml` 的配置改动能热生效 |

## NapCat 自检与「它为什么不说话」

插件启动时会读一眼 `napcatDir` 下的配置，**默认只读**：

- 一切正常 → 一句 info（`napcat: … 里已经有监听端口 3001 的 WebSocket 服务器`）；
- 缺那条服务器 / 端口不对 / 没启用 / token 不一致 → 一条 warn，把**原因**和修法一起写出来，
  例如 `napcat: 没有配置任何 WebSocket 服务器（缺一条监听 3001 的）；跑 node scripts/napcat-setup.mjs …`；
- `napcatAutoConfig: true` 时才动手写，写完提示**要重启 NapCat 才生效**。

找不到 NapCat 目录时只记一句 info（容器部署里它压根不在这个文件系统上，那不是错误）。
`token` 不一致是最容易查半天的一种：WS 连上又立刻被拒，而日志里只有一句 `closed`。

控制台里出现 **`Process exited.`**（QQ 刚起来就退了）是另一类问题，**不在插件能报的范围内**：
十之八九是启动方式不对 —— 没用提权的 `launcher.bat`，见
[为什么必须提权启动](#为什么必须提权启动实测)。判断顺序是先确认启动器，再看系统事件日志里的
`APPCRASH` 落在哪个模块：落在 `QQNT.dll` 就是注入/兼容那半边的事，与插件配置无关。

## 目录、配置与文件都在哪

```
DSH profile   ~\.dsh\profiles\desktop\         （Electron 独占；插件与 .env 都装在这里）
profile .env  ~\.dsh\profiles\desktop\.env     （QQBOT_* 那一段由脚本维护）
NapCat         <你解压的位置>\NapCat.Shell\     （仓库根目录下放一份也行，脚本会自动探测）
NapCat 配置    <NapCat>\config\onebot11_<QQ>.json
QQ 会话数据    ~\.dsh\qq-bot\                   （QQBOT_CWD：.qq-media / .qq-stickers / .qq-memory / data）
```

## 「装完了，但它一句话都不说」

按这个顺序查，前两步能盖住绝大多数：

1. **DSH 启动日志里有没有这句话**：`skipping profile bundle "@qqbot/dsh-plugin-qq": cannot
   resolve profile bundle …`。有它 = 插件**静默跳过**（DSH 照常启动，群里当然没反应）：
   `node_modules\@qqbot\dsh-plugin-qq` 那个链接没了、或者指着一个已经被你删掉/挪走的目录。
   重跑一次 `scripts\napcat-setup.cmd` 就会重建链接（它会读链接现在指着哪）。
   注意：`package.json` 里的 `link:` 那行**不决定**加载什么，链接才决定。
2. **`.env` 改动生效了没有**：`.env` 只在 DSH 启动时读一次，改完必须重启整个桌面版。
3. 再往下是 NapCat 那一侧：见[为什么它不说话](#napcat-自检与它为什么不说话)。
