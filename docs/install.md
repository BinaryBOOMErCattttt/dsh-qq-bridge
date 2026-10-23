# 安装与运行（Linux / 容器）

> 这一页从「下载」讲到「跑起来」：拿包、装 NapCat 的 WebSocket 服务器、起常驻进程、填模型凭据。
> Windows 桌面版走 [windows.md](windows.md)；连不上 / 不说话先看 [ops.md](ops.md) 的排查配方。

## 下载与开始

两种拿法：

- **下载发布包**（不想碰 git 的走这条）：到 [Releases](../../releases) 下载
  `dsh-qq-bridge-<版本>.zip`。解压出来就是一个能直接用的仓库副本，连 `NapCat.Shell\`
  都带上了 —— Windows 上双击 `scripts\napcat-setup.cmd` 就能配好。
  包里那份 NapCat 是**干净**的：不含任何账号配置、登录态、日志与 WebUI token
  （`config/` 由 NapCat 首次启动时自己生成；也可以 `--qq <你的号>` 让脚本直接写）。
- **git clone**：克隆本仓库，照下面自己装。

两条路的前置条件一样：**装好的 DSH**，模型凭据在 Web UI 的 Models 页填一次。
**Node ≥ 22**（见 `package.json` 的 `engines`）只有源码路线和那个一键配置脚本需要 ——
**Windows 桌面版自带一份 Node**（`<DSH>\resources\runtime\...\node.exe`），
`scripts\napcat-setup.cmd` 会自己去找它，所以桌面版用户不必另外装 Node。之后按平台走：

| 你的平台 | 看哪一节 |
|---|---|
| Windows（桌面版 DSH 与 NapCat 在同一台机器上） | [Windows 桌面版（NapCat.Shell）](windows.md#windows-桌面版napcatshell) |
| Linux / 容器（NapCat 跑在 docker 里） | [运行方式：独立的 `qqbot` profile](#运行方式独立的-qqbot-profile) |

改了什么、这个版本有什么，见 [CHANGELOG.md](../CHANGELOG.md)。

## NapCat 端要求

NapCat 需要开启一个 **WebSocket 服务器**（不是 websocketClients）。
在 NapCat WebUI 的「网络配置」里新建 WebSocket 服务器，端口与本插件
`endpoint` 一致；若设了 token，同步填到 `accessToken`。

当前这份配置对应的容器：

```
容器     napcat (mlikiowa/napcat-docker:latest)
端口     3001  → OneBot WebSocket 服务器（name: qqbot, token 为空）
配置文件 /app/napcat/config/onebot11_<QQ号>.json
```

查看配置：

```bash
docker exec napcat cat /app/napcat/config/onebot11_100000000.json
```

**Windows 桌面版不是这套**：那边 NapCat 是注入进本机 QQ 的原生进程（没有容器、没有 docker
网桥），配置在 `<NapCat>\config\onebot11_<QQ号>.json`，而且有脚本代劳 —— 见
[Windows 桌面版](windows.md#windows-桌面版napcatshell)。

## 运行方式：独立的 `qqbot` profile

插件装在专属 profile 里，和日常用的 `web` profile 完全隔离。

```
profile   ~/.dsh/profiles/qqbot/         （从 dsh 自带的 web 模板克隆）
bundles   @deepseek-ai/dsh-base
          @deepseek-ai/dsh-web-app
          @qqbot/dsh-plugin-qq
依赖      @qqbot/dsh-plugin-qq -> link:<本仓库的绝对路径>   （`link:` 不认 `~`）
UI        http://127.0.0.1:3081/
```

启动：

```bash
dsh --profile qqbot --port 3081 --no-open
```

没有"常驻但无 UI"的官方模板可用（`headless` 是一次性任务，`acp`/`sdk` 是
stdio JSON-RPC 服务），所以从 `web` 模板克隆：进程常驻，并且可以顺便在
浏览器里实时看 QQ 会话。

### 常驻运行

**不要**把它挂在一个 agent 会话的后台任务里：DSH 的 bash 工具跑在
`bwrap --die-with-parent` 沙箱内，沙箱一销毁子进程就跟着死。常驻必须由你
自己的登录会话或 systemd 托管。仓库里备好了 user unit：

```bash
cp deploy/qqbot.service ~/.config/systemd/user/     # 在仓库根目录执行
systemctl --user daemon-reload
systemctl --user enable --now qqbot

systemctl --user status qqbot          # 状态
journalctl --user -u qqbot -f          # 日志（含带 token 的 Web UI 地址）

# 想让它在没有桌面登录时也能跑：
loginctl enable-linger "$USER"
```

`Restart=always`，崩了 5 秒后自动拉起。改完源码后
`systemctl --user restart qqbot` 即可（等价于"重启 Harness"）。

临时手动跑（放 tmux 里，别用 agent 的后台任务）：

```bash
tmux new -s qqbot 'dsh --profile qqbot --port 3081 --no-open'
```

### 同步本机改动（频繁迭代）

插件是 `link:` 安装的，**改代码不用重装**：把文件传过去、重启进程就行。仓库里带了
`scripts/deploy-remote.sh`，按「跑测试 → 备份旧代码 → 停服务 → 整包覆盖 → 起服务 →
等 `connected to ws://`」一条龙做。

目标机**不写在脚本里**（仓库是公开的，写进去等于公开 IP、SSH 端口和用户名），先建一份
`.deploy.env`（已被 gitignore 挡住，不进提交）：

```bash
cp .deploy.env.example .deploy.env
$EDITOR .deploy.env    # REMOTE=user@host、SSH_PORT、REMOTE_DIR、SERVICE
```

```bash
scripts/deploy-remote.sh                  # 全量测试 → 同步 → 重启 → 健康检查
scripts/deploy-remote.sh --skip-tests     # 调试期跳过全量测试
scripts/deploy-remote.sh --with-persona   # 连 .qq-persona（人设 / 表达规则）一起传
scripts/deploy-remote.sh --rollback       # 回滚到那台机器上一次部署前的代码
```

同名环境变量可以临时覆盖（`REMOTE=user@host scripts/deploy-remote.sh`）；`REMOTE` 或
`REMOTE_DIR` 没给时脚本直接退出，它不会对着空地址去 ssh。

几条它刻意不做的事：

- **不传运行时数据**：`data/`、`.qq-media/`、`.qq-memory/`、`.qq-stickers/`、`.qq-persona/`
  留在那台机器上（`--with-persona` 才带人设 —— 人设是部署资产，不是代码）。
- **不删文件**：整包解压只覆盖、不清理，删掉/改名的旧模块会留在远端（不 import 就不影响运行）。
  要彻底对齐就用 `--rollback` 回到备份，或者干脆走下面的 git 路线。每次部署前它会把
  「代码」打包到 `~/dsh-qq-bridge.bak/`，默认留 5 份。
- **必须先重启**：Loader 按 URL 缓存模块，停用/启用插件拿不回新代码（见 AGENTS.md §5.1），
  所以脚本宁可断 5 秒也要先停再替换文件。

**改走 git 也可以**（历史、删除、回滚都由 git 管）：目标机上 `git clone` 一份，profile 的
`link:` 指到 clone 目录，之后每次 `git push` + 远端 `git pull` + `systemctl --user restart`。
代价是每改一次都得先提交 —— 调试期从脏工作树直接上机，tar 那条路更顺手。

### 凭据

QQ 会话用的模型是 `deepseek-official/deepseek-flash`（继承 `dsh-base` 的
`agent-default-model` 默认值），它需要 `DEEPSEEK_API_KEY`。解析顺序是：

```
继承的环境变量
  > $DSH_HOME/.credentials.yaml
    > <启动 cwd>/.env
      > $DSH_HOME/.env
```

注意 Harness 会用 `scrubbedParentEnv` 把敏感变量从**所有子进程**里抹掉，
所以 `env` 里看不到它属于正常现象。如果从没有该变量的环境启动（systemd、
别的 shell、CI），会报 `MISSING_CREDENTIAL`。

**推荐做法**：在 3081 的 Web UI 里打开 Models 页面填一次 key。它写入全局的
`$DSH_HOME/.credentials.yaml`，之后任何 profile、任何启动方式都不再依赖 shell 环境。
从自己的 `~/.zshrc`（已 export 该变量）里启动也可以，但只在那一个 shell 有效。

> 想让它每天自己换一把 key（额度 / 限流用），见[每天轮换 API key](ops.md#每天轮换-api-keyapikeyrotate)。
> 注意那条路径写的就是上面这个 `$DSH_HOME/.credentials.yaml`，而且要求 key 是**存在文件里**
> 的（从启动环境传进来的 key 优先级更高，轮换写不进去，插件会说明并跳过）。
