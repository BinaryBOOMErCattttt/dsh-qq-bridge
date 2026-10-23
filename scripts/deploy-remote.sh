#!/usr/bin/env bash
# 把本机工作树同步到另一台机器上的「link 安装」部署，并重启它。
#
# 为什么是 tar 而不是 rsync / git：
#   · 插件源码（含文档、skill、测试）一共 3 MB 出头，整包过去几秒就完了 —— 增量同步
#     省下的时间还不够多装一个 rsync（目标机默认没有它，装它要 root）。
#   · git 路线更干净（历史 / 回滚 / 删除都能传播），但它要求每改一次都先提交再推送；
#     调试期从脏工作树直接上机是常态，所以那条路留作可选项（见 docs/install.md）。
#
# 这个脚本按本项目的部署形状来（目标机上插件目录是 link 进 profile 的）：
#   · 停服务 → 传代码 → 起服务：宁可断 5 秒，也不要在进程活着时替换模块文件
#     （Loader 按 URL 缓存模块，半新半旧的树只会在下一次 import 时炸得莫名其妙）；
#   · 代码改了必须重启（AGENTS.md §5.1：`systemctl --user restart` 就是「重启 Harness」）；
#   · 运行时数据（data/ .qq-media .qq-memory .qq-stickers .qq-persona）**不传也不删**，
#     它们属于那台机器，不是代码。
#
# 用法：
#   scripts/deploy-remote.sh                 # 跑测试 → 同步 → 重启 → 健康检查
#   scripts/deploy-remote.sh --skip-tests    # 调试期跳过全量测试
#   scripts/deploy-remote.sh --with-persona  # 连 .qq-persona（人设 / 表达规则）一起传
#   scripts/deploy-remote.sh --no-restart    # 只同步，不重启
#   scripts/deploy-remote.sh --rollback      # 回滚到该机上一次部署前的代码
#
# 部署现场（目标机 / 端口 / 目录）不写进脚本 —— 仓库是公开的，写进来就等于公开 IP、
# SSH 端口和用户名。默认从仓库根的 .deploy.env 读（gitignore 挡着，模板见
# .deploy.env.example）；同名环境变量可以临时覆盖：
#   REMOTE=user@host  SSH_PORT=22  REMOTE_DIR=/home/user/dsh-qq-bridge
#   SERVICE=dsh-web   KEEP_BACKUPS=5  SSH_OPTS="..."
#
# 注意 SSH_OPTS 里的 `-F /dev/null`：本机 /etc/ssh/ssh_config.d/ 里有个文件的权限是坏的，
# 不绕开它连 `ssh` 都起不来（报 "Bad owner or permissions"）。没这个毛病就设成空串。
set -euo pipefail

cd "$(dirname "$0")/.."

# 部署现场从仓库根读：这份文件不进提交（见 .gitignore），模板是 .deploy.env.example。
# 用 `.` 而不是 source（POSIX），失败也不静默 —— `set -e` 会让它停下。
if [ -f ./.deploy.env ]; then
  # shellcheck disable=SC1091
  . ./.deploy.env
fi

REMOTE=${REMOTE:-}
SSH_PORT=${SSH_PORT:-22}
REMOTE_DIR=${REMOTE_DIR:-}
SERVICE=${SERVICE:-dsh-web}
SSH_OPTS=${SSH_OPTS-"-F /dev/null -o ConnectTimeout=15 -o ServerAliveInterval=15"}
KEEP_BACKUPS=${KEEP_BACKUPS:-5}

WITH_PERSONA=0
DO_RESTART=1
RUN_TESTS=1
ROLLBACK=0
for arg in "$@"; do
  case "$arg" in
    --with-persona) WITH_PERSONA=1 ;;
    --no-restart) DO_RESTART=0 ;;
    --skip-tests) RUN_TESTS=0 ;;
    --rollback) ROLLBACK=1 ;;
    -h | --help) sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$arg（--help 看用法）" >&2; exit 2 ;;
  esac
done

# 目标机没配就停在这里：不然脚本会对着一个空地址 ssh，报错信息跟真正的问题差很远。
if [ -z "$REMOTE" ] || [ -z "$REMOTE_DIR" ]; then
  echo "没有部署目标：在仓库根建 .deploy.env，写上 REMOTE=user@host 与 REMOTE_DIR=/path" >&2
  echo "（模板：cp .deploy.env.example .deploy.env；格式见 docs/install.md）" >&2
  exit 2
fi

# shellcheck disable=SC2086  # SSH_OPTS 就是留给调用方拆成多个参数的
ssh_do() { ssh $SSH_OPTS -p "$SSH_PORT" "$REMOTE" "$@"; }

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }

if [ "$ROLLBACK" = 1 ]; then
  say "回滚 $REMOTE:$REMOTE_DIR 到上一次备份"
  ssh_do "SERVICE='$SERVICE' REMOTE_DIR='$REMOTE_DIR' bash -s" <<'REMOTE_SH'
set -euo pipefail
backup=$(ls -1t ~/dsh-qq-bridge.bak/*.tgz 2>/dev/null | head -1 || true)
if [ -z "$backup" ]; then echo "没有找到备份（~/dsh-qq-bridge.bak/*.tgz）" >&2; exit 1; fi
echo "使用备份：$backup"
systemctl --user stop "$SERVICE" 2>/dev/null || true
tar xzf "$backup" -C "$REMOTE_DIR"
systemctl --user start "$SERVICE"
REMOTE_SH
  say "已回滚并重启"
  exit 0
fi

if [ "$RUN_TESTS" = 1 ]; then
  say "跑测试（跳过用 --skip-tests）"
  node --test test/
fi

# 部署的是什么：本地 HEAD + 有没有未提交的改动。脏树照样能上（这正是调试期要的），
# 但要让人一眼看见「这次上去的不是某个提交」。
say "本地状态"
printf '  提交 %s\n' "$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  printf '  工作树有未提交改动（%s 个文件）—— 会一起传上去\n' "$(git status --porcelain | wc -l)"
else
  echo "  工作树干净"
fi

EXCLUDES=(
  --exclude=./node_modules
  --exclude=./.git
  --exclude=./dist
  --exclude=./data
  --exclude=./.qq-media
  --exclude=./.qq-memory
  --exclude=./.qq-stickers
  --exclude=./NapCat.Shell
  --exclude=./.dsh-tmp
  --exclude=./.venv
  --exclude=./.tmp-bin
  --exclude=./.qq-jm
)
if [ "$WITH_PERSONA" = 0 ]; then
  EXCLUDES+=(--exclude=./.qq-persona) # 人设属于部署现场，默认不覆盖远端的
fi

# 第一步：备份旧代码 + 停服务（停服务是为了让下一步整包覆盖时不出现半新半旧的模块）。
say "备份旧代码并停 $SERVICE"
ssh_do "SERVICE='$SERVICE' REMOTE_DIR='$REMOTE_DIR' KEEP_BACKUPS='$KEEP_BACKUPS' bash -s" <<'REMOTE_SH'
set -euo pipefail
mkdir -p ~/dsh-qq-bridge.bak
if [ -n "$(ls -A "$REMOTE_DIR" 2>/dev/null)" ]; then
  stamp=$(date +%Y%m%d-%H%M%S)
  tar czf "$HOME/dsh-qq-bridge.bak/$stamp.tgz" -C "$REMOTE_DIR" \
    --exclude=./data --exclude=./.qq-media --exclude=./.qq-memory \
    --exclude=./.qq-stickers --exclude=./.qq-persona --exclude=./node_modules .
  echo "备份：~/dsh-qq-bridge.bak/$stamp.tgz"
  ls -1t "$HOME"/dsh-qq-bridge.bak/*.tgz | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
fi
systemctl --user stop "$SERVICE" 2>/dev/null || true
REMOTE_SH

# 第二步：整包覆盖。数据目录被 --exclude 挡在外面，所以日志 / 记忆 / 表情包不受影响。
say "同步到 $REMOTE:$REMOTE_DIR"
tar czf - "${EXCLUDES[@]}" . | ssh_do "tar xzf - -C '$REMOTE_DIR'"

# 第三步：补 node_modules 软链、重启、健康检查。
say "重启 $SERVICE 并做健康检查"
ssh_do "SERVICE='$SERVICE' REMOTE_DIR='$REMOTE_DIR' DO_RESTART='$DO_RESTART' bash -s" <<'REMOTE_SH'
set -euo pipefail
# 插件在目标机上按 link 安装，裸跑/测试时的 node_modules 指回 **DSH 自带**的依赖
# （不是 profile 的 node_modules：那里可能是另一个 schemastery，没有 .volatile()）。
if [ ! -e "$REMOTE_DIR/node_modules" ]; then
  dshbin=$(PATH="$HOME/.npm-global/bin:$PATH" command -v dsh)
  ln -sfn "$(dirname "$(dirname "$(readlink -f "$dshbin")")")/node_modules" "$REMOTE_DIR/node_modules"
  echo "已补 node_modules 软链"
fi
echo "代码目录：$(du -sh "$REMOTE_DIR" | cut -f1)"

if [ "$DO_RESTART" != 1 ]; then
  echo "未重启（--no-restart）"
  exit 0
fi
systemctl --user restart "$SERVICE"

# 健康检查只认「插件有没有连上 OneBot」：配置热更新、摘要循环这些都在启动日志里，
# 但连接状态才是「QQ 能不能说话」的唯一硬指标；NapCat 不在线时只告警，不算部署失败。
for _ in $(seq 1 20); do
  sleep 2
  logs=$(journalctl --user -u "$SERVICE" --since "-3min" --no-pager 2>/dev/null || true)
  if printf '%s\n' "$logs" | grep -q "qq-bridge: connected to ws://"; then
    printf '%s\n' "$logs" | grep "qq-bridge: connected to ws://" | tail -1
    printf '%s\n' "$logs" | grep "dsh web: http" | tail -1
    echo "OK：插件已连上 OneBot"
    exit 0
  fi
  if printf '%s\n' "$logs" | grep -q "did not activate"; then
    printf '%s\n' "$logs" | tail -20
    echo "失败：插件没有激活（看上面的日志）" >&2
    exit 1
  fi
done
echo "警告：40 秒内没看到「connected to ws://」——NapCat 可能没在跑；最近日志：" >&2
journalctl --user -u "$SERVICE" --since "-3min" --no-pager 2>/dev/null | tail -8 >&2
exit 1
REMOTE_SH

say "完成"
