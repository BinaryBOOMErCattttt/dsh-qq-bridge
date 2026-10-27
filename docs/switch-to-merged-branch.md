# 从旧树切到合并分支（云端执行清单）

> 适用场景：云端那份工作树是**功能齐全、但没有合并上游**的旧树（也是你给我打 zip 的那份）。
> 目标：换成 `feat/port-server` —— 它 = 上游 `8d52e45` 的全部修复 + 你那套功能。

## 0. 先认清两件事

- **上游没有新东西**：`flyinstar/dsh-qq-bridge` 只有一条 `main`，停在 `8d52e45`；不是"没 pull 到"，是没有。
- **云端缺的是合并结果**，不是缺功能。所以不要自己在云端 merge（它没有 push 能力，合完只能再打一次 zip）。

## 1. 备份（必做，跳过这步别往下走）

```bash
cd <云端部署目录>
tar czf ../qqbot-snapshot-$(date +%F-%H%M).tar.gz \
  --exclude=data --exclude=.qq-media --exclude=.qq-stickers \
  --exclude=.qq-memory --exclude=.qq-persona --exclude=node_modules .
ls -lh ../qqbot-snapshot-*.tar.gz
```

为什么排除那几个目录：它们是**运行时数据**（记忆、表情包、人设），本来就不进 git，备份它们只是浪费空间；
但如果里面有你手改过人设，单独 `tar czf persona.tgz .qq-persona` 再存一份。

## 2. 切换

```bash
git fetch origin
git checkout feat/port-server
git pull --ff-only
git rev-parse --short HEAD        # 期望 bb529d8 或更新的 commit
node -p "require('./package.json').version"   # 期望 0.4.0
```

## 3. 自检：三类文件，分别怎么判

### A. 必须**变**（变了才说明切对了）

| 文件 | 期望 |
| --- | --- |
| `package.json` 的 `version` | `0.4.0` |
| `git rev-parse HEAD` | `bb529d8` 或更新 |
| `index.js` | 存在 `SIMPLE_ALLOWED_COMMANDS`、`channelTurnContext`、`writeAuthority` 这些符号 |
| `AGENTS.md` | 有 `## 12. 部署后冒烟` 这一节（旧树没有） |

```bash
grep -c "SIMPLE_ALLOWED_COMMANDS" index.js    # > 0
grep -n "## 12. 部署后冒烟" AGENTS.md          # 有命中
```

### B. 必须**在**（新模块，缺一个就说明没切干净）

```bash
for f in mode.js mood.js debug.js topics.js handoff.js scripts/smoke.mjs PORTING.md; do
  test -f "$f" && echo "ok   $f" || echo "MISS $f"
done
```

### C. 必须**原样保留**（checkout 不该碰它；少了就是出事了）

```bash
for d in data .qq-memory .qq-stickers .qq-media .qq-persona; do
  test -d "$d" && echo "ok   $d ($(du -sh "$d" | cut -f1))" || echo "LOST $d";
done
ls .qq-persona/PERSONA.md .qq-persona/STYLE.md 2>/dev/null
```

**任何一个 `LOST` 都要立刻停下**：先用第 1 步的 tar 恢复，再查是不是把这个目录 `git add` 进去过。

拉齐之后跑冒烟（`AGENTS.md` §12 也是这么要求的）：

```bash
systemctl --user restart qqbot        # 改源码必须重启，Loader 按 URL 缓存模块
node scripts/smoke.mjs --service --json > /tmp/smoke.json
node -e "const r=require('/tmp/smoke.json');console.log(r.summary)"
```

## 4. 回滚（切错了 / 起不来）

```bash
git checkout -                      # 回到切之前那个分支/提交
tar xzf ../qqbot-snapshot-*.tar.gz -C .   # 需要时把旧树文件铺回来
systemctl --user restart qqbot
```

## 5. 写交接时的三档（别混）

| 档 | 含义 | 写法 |
| --- | --- | --- |
| `ok` / `fail` | `smoke.mjs` 静态判出来的 | `fail` 原样抄，不许写成"基本正常" |
| `warn` | 运行时产物缺失（正常）／工作树脏、服务没起（要处理） | 分开写 |
| `todo` | 7 条只能在真实 QQ 里点的 | 原文照抄"怎么验 / 期望"，**没验就写"未验"** |

交接里必须带：`git rev-parse HEAD`、`package.json` 版本、`smoke.json` 的 `summary`。
