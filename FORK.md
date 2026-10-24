# Fork / 开源说明

这个目录是从 `C:\dsh-qq-bridge\0.2.0` 导出的**功能组件**，用于 fork 上游仓库后发布。
上游：<https://github.com/flyinstar/dsh-qq-bridge>（MIT）。

## 已排除（不要带进仓库）

| 路径 | 原因 |
|---|---|
| `.qq-persona/` | 个人人设 / 表达文件 |
| `.qq-memory/`、`.qq-stickers/`、`.qq-media/` | 聊天记忆、收藏表情、媒体缓存 |
| `data/` | 状态、覆盖层、提醒、凭据池、聊天状态 |
| `NapCat.Shell/` | 第三方二进制，几十 MB；按需自行下载 |
| `node_modules/` | 依赖由 DSH 宿主提供 |
| `.env` / `.env.*` | 凭据与个人部署值 |
| `*.log`、`dist/`、`.tmp-*` | 日志与发布产物 |

## 已脱敏

- `cordis.patch.yml`：群触发改回 `mention`，前缀 `/`；`stickerMaxFiles` 60；主动说话恢复
  默认节奏（10 分钟检查 / 45 分钟安静 / 2 小时间隔 / 4 次每天 / 0.35 概率）。
- 文档、测试、指令帮助里的个人昵称改成「小助手 / 机器人」；QQ 号、群号示例改成 `123456789`。
- 不包含主人的 `resetUsers` 值；部署时用 `QQBOT_RESET_USERS` 环境变量自己配。
- 不包含 `PERSONA.md` / `STYLE.md`；没有它们时用 `persona.js` / `style.js` 的内置回退。

## 怎么 fork + 发布

这里没有安装 `git` / `gh`，所以下面是在你本机执行的步骤：

1. 打开 <https://github.com/flyinstar/dsh-qq-bridge>，点 **Fork**，fork 到你自己的账号。
2. 克隆你的 fork：

   ```bash
   git clone https://github.com/<你的账号>/dsh-qq-bridge.git
   cd dsh-qq-bridge
   ```

3. 把本目录的内容覆盖进克隆目录（保留 `.git/` 与上游 `LICENSE`）：

   ```powershell
   robocopy "C:\dsh-qq-bridge\open-source\dsh-qq-bridge" "D:\path\to\dsh-qq-bridge" /E
   ```

4. 检查没有敏感文件：

   ```bash
   git status --short
   # 不应出现 .env / .qq-* / data/ / NapCat.Shell / node_modules
   ```

5. 提交并推送：

   ```bash
   git add -A
   git commit -m "feat: commands, quiet mode, owner tooling, media hold"
   git push origin main
   ```

6. 回到 GitHub 你的 fork，确认文件列表；需要 PR 就点 **Contribute → Open pull request**。

## 授权

上游是 MIT，**必须保留原版权声明**（见 `LICENSE`）。你要给“你的改动”另加授权，
可以新增 `NOTICE` 或在 README 里写；不要直接删掉上游的 MIT 文本。

## 首次运行

1. 按 `docs/install.md` 把它作为 bundle 装进 profile。
2. 在 profile 的 `.env` 里配 `QQBOT_ENDPOINT` / `QQBOT_CWD` / `QQBOT_NAPCAT_DIR`；
   主人 QQ 用 `QQBOT_RESET_USERS`。
3. 按需把 `deploy/persona/` 的模板复制成 `cwd/.qq-persona/PERSONA.md` / `STYLE.md`。
4. `node --test test/`（Windows 先按 `docs/development.md` 铺 `node_modules`）。
