#!/usr/bin/env node
/**
 * 一条命令从「旧树」切到合并后的分支，并自检。
 *
 *   node scripts/switch-branch.mjs          # 备份 → 切换 → 自检 → 重启 → 冒烟
 *   node scripts/switch-branch.mjs --check  # 只自检，不切换也不重启
 *
 * 为什么是 Node 而不是 bash：仓库本来就纯 Node、零依赖，Windows 也能跑；
 * 而且要判 git / systemctl / smoke.mjs 存不存在，Node 比 shell 稳。
 *
 * 步骤（任何一步失败就停）：备份 → 切换 → 三类自检 → 重启 → 冒烟。
 * 三类自检 = 必须变 / 必须在 / 必须保留（运行时目录少一个立刻退出）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRANCH = 'feat/port-server';
const CHECK_ONLY = process.argv.includes("--check");

function run(cmd, args) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", timeout: 300000, windowsHide: true }).trim() };
  } catch (error) {
    const out = String((error.stdout ?? "") + (error.stderr ?? "")).trim() || String(error.message);
    return { ok: false, out };
  }
}

let failed = 0;
function check(label, ok, detail) {
  if (ok) return void console.log("  ok   " + label);
  failed += 1;
  console.log("  FAIL " + label + (detail ? " — " + detail : ""));
}

console.log("== 仓库：" + ROOT);
if (!existsSync(resolve(ROOT, ".git"))) {
  console.error("x 这里不是 git 仓库");
  process.exit(1);
}

if (!CHECK_ONLY) {
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const backup = resolve(ROOT, "..", "qqbot-snapshot-" + stamp + ".tar.gz");
  console.log("== 1/5 备份 -> " + backup);
  const excludes = ["data", ".qq-media", ".qq-stickers", ".qq-memory", ".qq-persona", "node_modules", ".git"].map((d) => "--exclude=./" + d);
  const tar = run("tar", ["czf", backup, ...excludes, "."]);
  if (!tar.ok) {
    console.error("x 备份失败，停下：" + tar.out.slice(0, 300));
    process.exit(1);
  }
  console.log("   备份完成");

  console.log("== 2/5 切换分支 -> " + BRANCH);
  for (const args of [["fetch", "origin"], ["checkout", BRANCH], ["pull", "--ff-only"]]) {
    const step = run("git", args);
    if (!step.ok) {
      console.error("x git " + args.join(" ") + " 失败，停下：\n" + step.out.slice(0, 400));
      process.exit(1);
    }
  }
}

console.log("== 3/5 自检");
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const head = run("git", ["rev-parse", "--short", "HEAD"]).out;
const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).out;
console.log("  版本 " + pkg.version + " | HEAD " + head + " | 分支 " + branch);

const [maj, min] = pkg.version.split(".").map(Number);
check("版本 >= 0.4.0", maj > 0 || min >= 4, "当前 " + pkg.version);

const read = (rel) => (existsSync(resolve(ROOT, rel)) ? readFileSync(resolve(ROOT, rel), "utf8") : "");
check("index.js 有 SIMPLE_ALLOWED_COMMANDS", read("index.js").includes("SIMPLE_ALLOWED_COMMANDS"));
check("AGENTS.md 有「部署后冒烟」章节", read("AGENTS.md").includes("部署后冒烟"));

for (const file of ["mode.js", "mood.js", "debug.js", "topics.js", "handoff.js", "scripts/smoke.mjs", "PORTING.md"]) {
  check("文件存在 " + file, existsSync(resolve(ROOT, file)));
}

for (const dir of ["data", ".qq-memory", ".qq-stickers", ".qq-media", ".qq-persona"]) {
  check("运行时目录还在 " + dir, existsSync(resolve(ROOT, dir)), "LOST —— 先恢复备份，别继续");
}

if (failed > 0) {
  console.error("");
  console.error("x 自检有 " + failed + " 条 FAIL —— 先别继续。");
  console.error("  回滚：git checkout -（回到切之前），需要时再 tar xzf 备份包");
  console.error("  详细步骤：docs/switch-to-merged-branch.md");
  process.exit(1);
}

if (!CHECK_ONLY) {
  console.log("== 4/5 重启服务");
  const hasSystemctl = run("sh", ["-c", "command -v systemctl"]).ok;
  if (hasSystemctl) {
    const restart = run("systemctl", ["--user", "restart", "qqbot"]);
    console.log(restart.ok ? "   已重启 qqbot" : "   warn 重启失败：" + restart.out.slice(0, 200));
  } else {
    console.log("   warn 没有 systemctl（容器部署？请自行重启）");
  }
}

console.log("== 5/5 冒烟");
const smokeJson = "/tmp/qqbot-smoke.json";
const smoke = run(process.execPath, ["scripts/smoke.mjs", "--service", "--json"]);
if (smoke.ok) {
  try {
    writeFileSync(smokeJson, smoke.out);
    console.log("   json 已存 " + smokeJson);
  } catch {
    console.log("   warn /tmp 不可写，json 没存（用 --json 自己跑一遍）");
  }
}
const human = run(process.execPath, ["scripts/smoke.mjs", "--service"]);
console.log(human.out.split("\n").slice(-25).join("\n"));
console.log("== 交接照 AGENTS.md §12：fail 原样抄、warn 分开写、todo 写「未验」");