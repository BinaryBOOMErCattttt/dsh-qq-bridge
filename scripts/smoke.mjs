#!/usr/bin/env node
/**
 * 部署后冒烟：把「能在本地看出来的」和「必须人/机器人自己验的」分开报。
 *
 * 为什么要有这个脚本：这套插件的验证分两半 ——
 *   1. 静态与产物：仓库版本、模块是否都在、配置 schema 有没有新键、运行时数据目录里有没有
 *      该出现的文件（`data/mode.json` / `data/TOPICS.md` / `data/handoff/` …）。这些能自动判。
 *   2. 行为：切模式、斗图发表情、`debug` 提权、`定档`、动图分镜。这些只能在真实 QQ 里点一遍，
 *      脚本不假装能验，只打印**逐条的验收口径**，好让人（或别的 agent）照着做、照着写交接。
 *
 * 用法：
 *   node scripts/smoke.mjs            # 人看
 *   node scripts/smoke.mjs --json     # 机读（交给别的 agent 写交接文档时用）
 *   node scripts/smoke.mjs --service  # 额外查 systemd 服务（会起子进程，沙箱里可能被拒）
 *
 * 退出码：0 = 没有硬伤（可以有「待人工确认」）；1 = 有 FAIL。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = new Set(process.argv.slice(2));
const asJson = argv.has("--json");
const withService = argv.has("--service");

/** 一条结果：level = ok | warn | fail | todo（todo 是需要人工/真实群验的）。 */
const results = [];
function add(id, level, title, detail) {
  results.push({ id, level, title, detail: detail ?? null });
}

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

function exists(rel) {
  return existsSync(join(ROOT, rel));
}

/** 文件在不在 + 多大 + 最后写入时间（运行时产物靠这个判「有没有真的跑起来」）。 */
function artifact(rel, hint) {
  if (!exists(rel)) {
    add(rel, "warn", `${rel} 还不存在`, hint);
    return false;
  }
  const stat = statSync(join(ROOT, rel));
  const when = new Date(stat.mtimeMs).toISOString().replace("T", " ").slice(0, 19);
  add(rel, "ok", `${rel}（${stat.size} 字节，最后写入 ${when} UTC）`);
  return true;
}

// ---- 1. 环境与版本 -------------------------------------------------------------
const major = Number(process.versions.node.split(".")[0]);
add("node", major >= 22 ? "ok" : "fail", `Node ${process.versions.node}`, major >= 22 ? null : "需要 Node >= 22");
add("cwd", "ok", `仓库根 ${ROOT}`);

const pkg = JSON.parse(read("package.json"));
add("version", "ok", `package.json version = ${pkg.version}`);

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", timeout: 8000, windowsHide: true }).trim();
  } catch (error) {
    return null;
  }
}
const head = git(["rev-parse", "--short", "HEAD"]);
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
const dirty = git(["status", "--porcelain"]);
if (head === null) add("git", "warn", "读不到 git 信息（可能是 tar 部署，没有 .git）");
else {
  add("git", "ok", `在 ${branch} @ ${head}`);
  if (dirty) add("git-dirty", "warn", "工作树有未提交改动", dirty.split("\n").slice(0, 8).join(" / "));
}

// ---- 2. v0.4.0 的新模块必须在位 -------------------------------------------------
const MODULES = {
  "mode.js": "运行模式（完整 / 简洁 / 斗图）",
  "mood.js": "心情门控与表情许可",
  "debug.js": "调试提权（10 分钟 TTL / baseline 回滚）",
  "topics.js": "话题记忆（high/medium/low/cold 降档）",
  "handoff.js": "定档（交接文档 + 归档 + 代次 +1）",
};
for (const [file, why] of Object.entries(MODULES)) {
  add(`module:${file}`, exists(file) ? "ok" : "fail", `${file} — ${why}`, exists(file) ? null : "这个文件缺失，说明这份代码不是 v0.4.0");
}

// ---- 3. 工具面：24 个 qq_* 一个都不能少 -----------------------------------------
const TOOLS = [
  "qq_send_message", "qq_send_image", "qq_save_sticker", "qq_rename_sticker", "qq_poke",
  "qq_list_conversations", "qq_transcript", "qq_memory", "qq_remind_create", "qq_remind_list",
  "qq_remind_cancel", "qq_write", "qq_edit", "qq_skill", "qq_quiet", "qq_settings",
  "qq_auto_tool", "qq_debug_read", "qq_debug_write", "qq_debug_list", "qq_debug_shell",
  "qq_debug_log", "qq_time", "qq_topic",
];
const toolsSource = exists("tools.js") ? read("tools.js") : "";
const missingTools = TOOLS.filter((name) => !toolsSource.includes(`"${name}"`) && !toolsSource.includes(`'${name}'`));
if (missingTools.length === 0) add("tools", "ok", `tools.js 里 ${TOOLS.length} 个 qq_* 工具都在`);
else add("tools", "fail", "tools.js 缺工具", missingTools.join(", "));

// ---- 4. 配置项：新功能的开关有没有真的进 schema ---------------------------------
const configSource = exists("config.js") ? read("config.js") : "";
const KEYS = [
  "moduleEmojiMood", "moodMax", "moodTriggerFull", "moodDecayIdleMs",
  "modelAutoTool", "debug", "moduleAutoTool", "moduleDebug",
  "moduleHandoff", "simpleReplyMaxChars", "fullReplyMaxChars",
];
const missingKeys = KEYS.filter((key) => !new RegExp(`\\b${key}\\s*:`).test(configSource));
if (missingKeys.length === 0) add("config", "ok", `config.js 里 ${KEYS.length} 个新开关都在`);
else add("config", "fail", "config.js 缺字段", missingKeys.join(", "));

// ---- 5. 文档与配置表同步（check.mjs 就是干这个的） -------------------------------
try {
  const out = execFileSync(process.execPath, [join(ROOT, "scripts/check.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120000,
    windowsHide: true,
  });
  add("check", "ok", "scripts/check.mjs 通过", out.trim().split("\n").slice(-2).join(" "));
} catch (error) {
  const text = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
  add("check", "fail", "scripts/check.mjs 不通过", text.split("\n").slice(-6).join(" / ") || String(error.message));
}

// ---- 6. 运行时产物：这些文件只有真跑过才会出现 ----------------------------------
// 这些文件都落在部署目录（= 本仓库根，link 安装时 cwd 就是它）下，gitignore 挡着；没跑过就不会有。
artifact("data/mode.json", "没切过模式时不会出现；私聊发一次 `模式 简洁` 再回来看");
artifact("data/chat-state.json", "玩过 吃饭 / 木鱼 / 抽签 或用过心情门控后才会出现");
artifact("data/TOPICS.md", "只登记过 high/medium 话题才会写；`qq_topic high …` 试一次");
artifact("data/handoff", "只在 `定档` 之后出现（目录）");
artifact(".qq-stickers/SEMANTICS.md", "第一次存表情、或斗图模式开场时才会建");

// ---- 7. 服务状态（可选，会起子进程） --------------------------------------------
if (withService) {
  for (const [id, args] of [
    ["service:active", ["systemctl", ["--user", "is-active", "qqbot"]]],
    ["service:journal", ["journalctl", ["--user", "-u", "qqbot", "-n", "40", "--no-pager"]]],
  ]) {
    try {
      const out = execFileSync(args[0], args[1], { cwd: ROOT, encoding: "utf8", timeout: 15000, windowsHide: true });
      if (id === "service:active") add(id, out.trim() === "active" ? "ok" : "warn", `qqbot 服务状态：${out.trim()}`);
      else {
        const bad = out.split("\n").filter((line) => /\\b(error|ERROR|Error)\\b/.test(line)).slice(0, 5);
        add(id, bad.length === 0 ? "ok" : "warn", bad.length === 0 ? "最近 40 行日志里没有 error" : `最近 40 行有 ${bad.length} 行 error`, bad.join(" / "));
      }
    } catch (error) {
      add(id, "warn", `${id} 跳过（起不了子进程或没装 systemd）`, String(error.message).slice(0, 120));
    }
  }
} else {
  add("service", "todo", "服务状态没查（要查加 --service）", "systemctl --user is-active qqbot / journalctl --user -u qqbot -n 80");
}

// ---- 8. 必须在真实 QQ 里点一遍的（脚本不假装能验） -------------------------------
const MANUAL = [
  { id: "mode", title: "运行模式", run: "私聊发 `模式` → `模式 简洁` → 再发 `模式`", expect: "先回当前模式；切换后回确认；`data/mode.json` 里 mode 变 simple；群里说话变短、攒批 5 秒" },
  { id: "sticker", title: "斗图模式", run: "私聊 `模式 斗图`，然后在群里让它发一张表情", expect: "不受心情阈值限制直接发；`.qq-stickers/SEMANTICS.md` 有行；切回 `模式 完整` 后恢复门控" },
  { id: "mood", title: "心情门控", run: "连发几条让它发表情，别明说“发个表情”", expect: "阈值未到时会拒绝/换话术；`data/chat-state.json` 的 mood 段在变；明说要表情时才直通" },
  { id: "debug", title: "调试提权", run: "主人私聊让它调 `qq_debug_list`（`debug` 开着时）", expect: "回一段“你现在能碰什么”；`data/debug/<时间>/baseline` 出现；10 分钟后或 `overdebug` 自动关" },
  { id: "topic", title: "话题记忆", run: "让它 `qq_topic high 某某事`，再随便聊几轮", expect: "`data/TOPICS.md` 有行；下一轮情境里出现「长期话题：…」；久不提会降档" },
  { id: "handoff", title: "定档", run: "私聊发 `定档`", expect: "回“交接写好了”；`data/handoff/*.md` 出现（近 80 条 + 任务关键词）；旧会话进 archive；代次 +1" },
  { id: "gif", title: "动图分镜", run: "群里发一张动图，问「这图在干嘛」", expect: "描述的是动作过程而不是只有第一帧；`.qq-media/` 下有 `*-frames.png`" },
];
for (const item of MANUAL) add(`manual:${item.id}`, "todo", item.title, `怎么验：${item.run}；期望：${item.expect}`);

// ---- 输出 ----------------------------------------------------------------------
const count = (level) => results.filter((item) => item.level === level).length;
const summary = { ok: count("ok"), warn: count("warn"), fail: count("fail"), todo: count("todo") };

if (asJson) {
  process.stdout.write(`${JSON.stringify({ root: ROOT, version: pkg.version, summary, results }, null, 2)}\n`);
} else {
  const mark = { ok: "[ok]  ", warn: "[warn]", fail: "[FAIL]", todo: "[todo]" };
  console.log(`冒烟：${ROOT}\n版本 ${pkg.version}\n`);
  for (const item of results) {
    console.log(`${mark[item.level]} ${item.title}`);
    if (item.detail) console.log(`        ${item.detail}`);
  }
  console.log(`\n合计 ok=${summary.ok} warn=${summary.warn} fail=${summary.fail} todo=${summary.todo}`);
  console.log("todo 是必须人（或 QQ 里的机器人自己）验的，脚本不假装能验。");
}

process.exit(summary.fail > 0 ? 1 : 0);