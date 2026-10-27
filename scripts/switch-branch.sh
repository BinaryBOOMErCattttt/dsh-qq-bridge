#!/usr/bin/env bash
# 一条命令从「旧树」切到合并后的分支，并自检。
#
#   bash scripts/switch-branch.sh
#
# 做的事，按顺序，任何一步失败就停（set -e）：
#   1. 备份当前树（排除运行时数据）到 ../qqbot-snapshot-<时间>.tar.gz
#   2. fetch + checkout feat/port-server + pull --ff-only
#   3. 三类自检：必须变 / 必须在 / 必须保留（运行时数据少一个就立刻退出）
#   4. 重启服务（有 systemd 才做）
#   5. 跑 scripts/smoke.mjs 并把 json 存到 /tmp/qqbot-smoke.json
#
# 干跑（只检查不切换）：bash scripts/switch-branch.sh --check
set -euo pipefail

BRANCH="feat/port-server"
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
echo "== 仓库：$ROOT"

git rev-parse --git-dir >/dev/null 2>&1 || { echo "✗ 这里不是 git 仓库"; exit 1; }
git remote get-url origin >/dev/null 2>&1 || { echo "✗ 没有 origin 远端"; exit 1; }

if [[ $CHECK_ONLY -eq 0 ]]; then
  STAMP="$(date +%F-%H%M%S)"
  BACKUP="../qqbot-snapshot-$STAMP.tar.gz"
  echo "== 1/5 备份 → $BACKUP"
  tar czf "$BACKUP" \
    --exclude=data --exclude=.qq-media --exclude=.qq-stickers \
    --exclude=.qq-memory --exclude=.qq-persona --exclude=node_modules \
    --exclude=.git .
  ls -lh "$BACKUP"

  echo "== 2/5 切换分支 → $BRANCH"
  git fetch origin
  git checkout "$BRANCH"
  git pull --ff-only
fi

echo "== 3/5 自检"
FAIL=0
check() { if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; FAIL=1; fi; }

# A. 必须变
VER="$(node -p "require('./package.json').version")"
echo "  版本 $VER｜HEAD $(git rev-parse --short HEAD)｜分支 $(git rev-parse --abbrev-ref HEAD)"
check "版本是 0.4.0 或更新" "node -e \"const v=require('./package.json').version.split('.').map(Number);process.exit(v[0]>=0&&v[1]>=4?0:1)\"".replace
check "index.js 有 SIMPLE_ALLOWED_COMMANDS" "grep -q SIMPLE_ALLOWED_COMMANDS index.js"
check "AGENTS.md 有 §12 冒烟章节" "grep -q '部署后冒烟' AGENTS.md"

# B. 必须在
for f in mode.js mood.js debug.js topics.js handoff.js scripts/smoke.mjs PORTING.md; do
  check "文件存在 $f" "test -f \"$f\""
done

# C. 必须保留（运行时数据）
for d in data .qq-memory .qq-stickers .qq-media .qq-persona; do
  check "运行时目录还在 $d" "test -d \"$d\""
done

if [[ $FAIL -ne 0 ]]; then
  echo "✗ 自检有 FAIL —— 先别继续。回滚：git checkout - && tar xzf ..."
  echo "  详细步骤见 docs/switch-to-merged-branch.md"
  exit 1
fi

if [[ $CHECK_ONLY -eq 0 ]]; then
  echo "== 4/5 重启服务"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user restart qqbot || echo "  warn 重启失败，手动看：systemctl --user status qqbot"
    sleep 2
    systemctl --user is-active qqbot || true
  else
    echo "  warn 没有 systemctl，跳过（容器部署请自行重启）"
  fi
fi

echo "== 5/5 冒烟"
node scripts/smoke.mjs --service --json > /tmp/qqbot-smoke.json || true
node scripts/smoke.mjs --service | tail -n 25
echo "== json 已存 /tmp/qqbot-smoke.json"
echo "== 交接照 AGENTS.md §12 的三档写：fail 原样抄、warn 分开写、todo 写「未验」"