/**
 * 运维动作的**纯计划**那一半：平台能力 + 观察到的事实 → 一份可以照着做的步骤清单。
 *
 * 为什么值得单独一个纯模块：`scripts/ops.mjs` 要做的事分两截 —— 「现在到底哪儿坏了」
 * （事实）与「照着做什么」（计划）。前一半必须碰磁盘、起子进程，后一半应当只是
 * 普通对象进、普通对象出：这样同一份计划能在 Linux 上被喂 Windows 的形状来测
 * （`test/ops.test.mjs` 就是这么钉的），也保证 agent 在拿不到任何权限时仍然能
 * 把「该跑什么」原样打印给用户。
 *
 * 三条纪律（写这个文件时反复用到）：
 *
 *   - **未知 ≠ 坏**：`doctorFindings` 只在事实**明确是假**时报问题；`undefined`
 *     表示「没查到」，绝不据此编一条 finding（那会让「查不出来」变成「你有病」）。
 *   - **写 cwd 外的步骤一律标 `human` / `root`**：脚本自己只做 `workspace` 里的事。
 *     这是 AGENTS.md §5.5 那条沙箱边界在运维层的落地 —— 能自动的自动，不能自动的
 *     给一条能复制的命令，而不是假装自动化然后静默失败。
 *   - **不重复造计划**：Windows 的隐藏启动 / 计划任务 / 提权命令已经在 `napcat.js` 里
 *     （有单测、有实测依据），这里只把它们**包成步骤**；桌面版 profile 的链接判断同理
 *     （`desktop.js` 的 `pluginLinkState`），manifest 的「装没装」用
 *     `withPluginInstalled` 的 `changed` 只读地问一次。
 *
 * 它不读 `config.js` / `settings.js`：那两个模块要 schemastery peer，而裸跑脚本时
 * 那份依赖不一定解析得到（`node_modules` 没铺好时插件自己都起不来）。运维要回答的
 * 也不该是「配置项现在是什么」，而是「文件在不在、服务跑没跑」。
 *
 * @module @qqbot/dsh-plugin-qq/ops
 */
import { posix as posixPath, win32 as winPath } from 'node:path';
import {
  HIDDEN_WRAPPER_NAME,
  TASK_NAME,
  TASK_XML_NAME,
  endpointTarget,
  scheduledTaskDeletePlan,
  scheduledTaskInstallPlan,
  scheduledTaskQueryPlan,
} from './napcat.js';

/**
 * JSON 输出协议的版本号。agent 只认自己认识的版本，不猜字段 ——
 * 所以加字段可以，改语义必须加这个数。
 */
export const OPS_SCHEMA = 1;

/** `servicePlan` 认识的动作。 */
export const OPS_ACTIONS = ['status', 'restart', 'logs', 'install', 'uninstall', 'autostart'];

/** CLI 认识的一级命令（`scripts/ops.mjs` 与这里共用，免得两边各记一份）。 */
export const OPS_COMMANDS = ['doctor', 'status', 'restart', 'logs', 'install', 'uninstall', 'napcat', 'migrate', 'cleanup', 'selftest'];

/**
 * 步骤 / finding 的「谁来执行」三分类。
 *
 * `workspace` = 脚本自己就能做（cwd 内、或只读查询）；`human` = 必须人拍板
 * （cwd 外的写、删数据）；`root` = 需要提权，脚本**永不**执行。
 */
export const REQUIREMENTS = ['workspace', 'human', 'root'];

/** finding 的三个级别。`warn` 不改变退出码，`error` 才让命令以 1 退出。 */
export const FINDING_LEVELS = ['error', 'warn', 'info'];

/** systemd user unit 的默认名字（与 `deploy/qqbot.service` 一致）。 */
export const DEFAULT_UNIT = 'qqbot';

/** 容器模式下 NapCat 容器的默认名字。 */
export const DEFAULT_CONTAINER = 'napcat';

/**
 * 插件默认连接的 OneBot 地址。
 *
 * 与 `cordis.patch.yml` 里 `endpoint` 的默认值**逐字一致**：ops 不读 `.env`
 * 也不解析 patch，所以这里写死一份，并留 `--endpoint` 给改过端口的部署。
 */
export const DEFAULT_ENDPOINT = 'ws://127.0.0.1:3001';

/** 默认看多少行日志（`logs -n N` 覆盖）。 */
export const DEFAULT_LOG_LINES = 100;

// ---------------------------------------------------------------------------
// 小工具（纯）
// ---------------------------------------------------------------------------

/** 某个平台该用哪一套路径规则 —— 在 Linux 上验 Windows 形状靠它，不靠宿主的 `sep`。 */
function pathFor(platform) {
  return platform?.os === 'win32' ? winPath : posixPath;
}

/**
 * 步骤对象的唯一构造点：少一个字段的步骤在 CLI 里会以很难查的方式炸掉，
 * 所以统一在这里补齐，默认 `status: 'planned'`（还没做）。
 *
 * `command` 是给人复制的那一行，`argv` 是脚本真要执行时的参数数组：执行**只**走
 * `argv` + `shell: false`，绝不把 `command` 丢给 shell（引号、`&&`、重定向在这里
 * 都是不可信输入 —— 路径里一个空格就能让命令跑到别的地方去）。
 */
function step(id, requires, command, note, argv, optional = false) {
  return {
    id: String(id),
    status: 'planned',
    requires: REQUIREMENTS.includes(requires) ? requires : 'human',
    command: String(command ?? ''),
    note: String(note ?? ''),
    argv: Array.isArray(argv) ? argv.map((item) => String(item)) : [],
    // `optional: true` = 不做也完全正常（例如 linger、重启 NapCat 容器本身）。
    // 它不算「等你动手」，否则一个可选项会把退出码永远钉在 2 上。
    optional: optional === true,
  };
}

/** 一条 finding 的构造点：`code` / `fix` 永远非空（agent 靠 code 分派，人靠 fix 行动）。 */
function finding(level, code, requires, message, fix) {
  return {
    level: FINDING_LEVELS.includes(level) ? level : 'warn',
    code: String(code),
    message: String(message ?? ''),
    fix: String(fix ?? ''),
    requires: REQUIREMENTS.includes(requires) ? requires : 'human',
  };
}

/**
 * 把一段 shell 路径变成「能直接贴进终端」的样子。
 *
 * `~` 必须留在引号外（`"~/x"` 在 shell 里不会展开），带空格的路径才加引号。
 */
function shellPath(value) {
  const text = String(value ?? '');
  if (text.length === 0) return '""';
  if (text.startsWith('~')) return text;
  return /[\s"'$`\\]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

/** 单个命令行参数：只在真的有歧义时加引号（powershell 的 base64 参数不加）。 */
function quoteArg(value) {
  const text = String(value ?? '');
  if (text.length === 0) return '""';
  if (!/[\s"'&|<>^]/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

/**
 * 把 `napcat.js` 那些 `{ command, args, describe }` 计划渲染成一行人能读的命令。
 *
 * 导出是为了让 CLI 打印 `napcat start` 的计划、以及测试直接断言「包装出来的那条命令
 * 就是 napcat.js 算出来的那条」—— 两处若各拼一遍，迟早会漂移。
 *
 * @param plan - `{ command, args }`（`{ unsupported }` 时返回空串）。
 * @returns 命令行字符串；计划不可执行时为空串。
 */
export function renderPlan(plan) {
  if (plan === undefined || plan === null || plan.unsupported !== undefined) return '';
  const head = String(plan.command ?? '').trim();
  if (head.length === 0) return '';
  const args = Array.isArray(plan.args) ? plan.args : [];
  return [head, ...args.map(quoteArg)].join(' ');
}

/** 一条 `napcat.js` 计划包成步骤；计划不可执行时退回一条说明性的人工步骤。 */
function planStep(id, plan, requires, note) {
  const command = renderPlan(plan);
  if (command.length === 0) {
    return step(id, 'human', '', `${note}${note.length > 0 ? '；' : ''}${plan?.unsupported ?? '这一步算不出可执行的命令'}`);
  }
  const describe = String(plan?.describe ?? '').trim();
  return step(id, requires, command, [note, describe].filter((item) => item.length > 0).join('；'),
    [plan.command, ...(Array.isArray(plan.args) ? plan.args : [])]);
}

// ---------------------------------------------------------------------------
// 平台探测
// ---------------------------------------------------------------------------

/**
 * 把「这台机器的能力」收成一个普通对象。
 *
 * 入参是**事实而不是环境**：`platform` / `env` / `uid` / 各能力开关都由调用方（或测试）
 * 喂进来，所以「Linux 上验 Windows 的形状」不需要 mock 整个 `process`。
 *
 * `container` 放进来是因为容器部署的运维动作完全不同（docker 而不是 systemd/计划任务）；
 * 它由调用方判定（`/.dockerenv`、`docker ps` 或显式开关），这里只负责携带。
 *
 * @param {object} [input] 事实来源：
 *   `platform`（`process.platform` 的值）、`env`（环境变量表）、`uid`（POSIX 的 uid）、
 *   `hasSystemctl`（有没有可用的 `systemctl --user`）、`hasSchtasks`（Windows 上默认有）、
 *   `container`、`elevated`、`profileDir`、`cwd`、`wsl`。
 * @returns {{ os: string, wsl: boolean, systemd: boolean, schtasks: boolean, container: boolean,
 *   elevated: boolean, profileDir: string, cwd: string }}
 */
export function detectPlatform(input = {}) {
  const facts = input ?? {};
  const env = facts.env ?? {};
  const raw = String(facts.platform ?? '').trim();
  const os = raw === 'win32' ? 'win32' : raw === 'linux' ? 'linux' : raw.length > 0 ? raw : 'linux';
  const px = os === 'win32' ? winPath : posixPath;
  const container = facts.container === true;
  const wsl = os === 'linux' && (
    facts.wsl === true
    || String(env.WSL_DISTRO_NAME ?? '').trim().length > 0
    || String(env.WSL_INTEROP ?? '').trim().length > 0
  );
  // DSH 自己的家目录规则：DSH_HOME 优先，否则 `~/.dsh`（与 scripts/napcat-setup.mjs 同一条）。
  const home = String(env.HOME ?? env.USERPROFILE ?? '').trim();
  const dshHome = String(env.DSH_HOME ?? '').trim() || (home.length > 0 ? px.join(home, '.dsh') : '');
  const profileName = String(env.QQBOT_PROFILE ?? '').trim() || 'qqbot';
  const profileDir = String(facts.profileDir ?? '').trim()
    || (dshHome.length > 0 ? px.join(dshHome, 'profiles', profileName) : '');
  const cwd = String(facts.cwd ?? '').trim()
    || String(env.QQBOT_CWD ?? '').trim()
    || String(env.PWD ?? '').trim()
    || '';
  // systemd 只认「真的能用」：`systemctl` 存在不代表有用户级会话（WSL 默认就没有）。
  // 它与 container 无关：NapCat 在容器里不代表 bot（DSH 进程）不在 systemd 下面 ——
  // 本机的部署恰恰是「unit 管 bot、docker 管 NapCat」，两件事要能同时成立。
  const systemd = os === 'linux' && facts.hasSystemctl === true;
  const schtasks = os === 'win32' && facts.hasSchtasks !== false;
  // Windows 的提权只能由调用方判断（要跑 `net session`），这里不自作主张；
  // POSIX 上 uid 0 就是 root，是确定事实。
  const elevated = typeof facts.elevated === 'boolean'
    ? facts.elevated
    : os !== 'win32' && Number(facts.uid) === 0;
  return { os, wsl, systemd, schtasks, container, elevated, profileDir, cwd };
}

// ---------------------------------------------------------------------------
// doctor：事实 → findings
// ---------------------------------------------------------------------------

/** finding 的排序：error 在前。输出顺序稳定，agent 拿第一条 error 当「主因」才靠得住。 */
function levelRank(level) {
  const index = FINDING_LEVELS.indexOf(level);
  return index === -1 ? FINDING_LEVELS.length : index;
}

/**
 * 一份完整的事实表长什么样（`undefined` = 没查到，**不是**坏）：
 *
 * ```
 * {
 *   os, wsl, systemd, schtasks, container, elevated,
 *   endpoint, endpointReachable,
 *   napcatDir, napcatConfigPresent, napcatConfigured, napcatConfigFile,
 *   systemdUnitPresent, systemdUnitEnabled, systemdUnitActive,
 *   profileDir, profileLinkState, profileLinkTarget, profileManifestInstalled,
 *   envPresent, envFile, credentialsUsable,
 *   keyPoolPresent, keyPoolSize, keyPoolPath,
 *   staleToolAllowlist, peerDepsMissing, logsPath, logsHint, journalProblem, cwdWritable,
 * }
 * ```
 *
 * @param {object} facts 上面那张表（缺的字段按「未知」处理）。
 * @returns {Array<{ level: string, code: string, message: string, fix: string, requires: string }>}
 */
export function doctorFindings(facts = {}) {
  const f = facts ?? {};
  const out = [];
  const add = (level, code, requires, message, fix) => out.push(finding(level, code, requires, message, fix));

  // ---- OneBot 链路 -------------------------------------------------------
  if (f.endpointReachable === false) {
    add('error', 'ONEBOT_UNREACHABLE', 'human',
      `${f.endpoint ?? DEFAULT_ENDPOINT} 连不上（TCP 都没通）`,
      f.container === true
        ? `确认 NapCat 容器在跑、端口映射到宿主（docker ps；docker logs --tail 100 ${DEFAULT_CONTAINER}）`
        : '确认 NapCat 在跑、它里面有一条启用的 WebSocket 服务器、端口与插件的 endpoint 一致（node scripts/ops.mjs napcat config --apply）');
  } else if (f.endpointReachable === true) {
    // 明确连通也值得说一句：agent 靠它区分「通的」与「没查到」。
    add('info', 'ONEBOT_REACHABLE', 'workspace', `${f.endpoint ?? DEFAULT_ENDPOINT} 端口通`, '无需处理');
  }

  // ---- NapCat 配置 -------------------------------------------------------
  if (f.napcatDir === '') {
    add('warn', 'NAPCAT_DIR_MISSING', 'human',
      '没找到 NapCat 安装目录（常见位置都没有）',
      '把 NapCat.Shell 解压到仓库根目录，或用 --napcat <目录> 指定；容器部署不需要这一步');
  }
  if (f.napcatConfigPresent === false) {
    add('error', 'NAPCAT_CONFIG_MISSING', 'human',
      f.napcatDir && f.napcatDir.length > 0
        ? `${f.napcatDir}/config 里没有 onebot11_<QQ号>.json（还没登录过账号？）`
        : '读不到 NapCat 的 OneBot 配置',
      '启动一次 NapCat 并扫码登录，然后跑 node scripts/ops.mjs napcat config --apply');
  } else if (f.napcatConfigured === false) {
    add('error', 'NAPCAT_CONFIG_MISSING', 'human',
      'NapCat 里没有一条「端口与 token 都对得上」的 WebSocket 服务器',
      'node scripts/ops.mjs napcat config --apply（只改它自己那一条，改前备份）');
  } else if (f.napcatConfigured === true) {
    add('info', 'NAPCAT_CONFIG_OK', 'workspace', 'NapCat 的 WebSocket 配置与插件对得上', '无需处理');
  }

  // ---- systemd -----------------------------------------------------------
  // unit 不存在时不再报「没在跑」：那是同一个根因的两种说法，只会让输出更难读。
  if (f.systemdUnitPresent !== false && f.systemdUnitActive === false) {
    add('error', 'SYSTEMD_NOT_ACTIVE', 'workspace',
      `systemd user unit「${f.unit ?? DEFAULT_UNIT}」没在跑`,
      `systemctl --user restart ${f.unit ?? DEFAULT_UNIT}；日志 journalctl --user -u ${f.unit ?? DEFAULT_UNIT} -n 100`);
  }
  if (f.systemdUnitPresent === false) {
    add('warn', 'SYSTEMD_UNIT_MISSING', 'human',
      `没装 systemd unit（~/.config/systemd/user/${f.unit ?? DEFAULT_UNIT}.service）`,
      'node scripts/ops.mjs install（会给出写 unit + enable 的命令）');
  }
  if (f.systemdUnitPresent !== false && f.systemdUnitEnabled === false) {
    add('warn', 'SYSTEMD_NOT_ENABLED', 'human',
      `unit「${f.unit ?? DEFAULT_UNIT}」没设成开机自启`,
      `systemctl --user enable ${f.unit ?? DEFAULT_UNIT}`);
  }

  // ---- 桌面版 profile ----------------------------------------------------
  if (f.profileLinkState === 'missing') {
    add('warn', 'PROFILE_LINK_MISSING', 'human',
      `profile 的 node_modules 里没有本插件的链接（${f.profileLinkPath ?? 'node_modules/@qqbot/dsh-plugin-qq'}）`,
      'node scripts/napcat-setup.mjs（桌面版也可以在「设置 → 插件」里按本地路径安装）');
  } else if (f.profileLinkState === 'elsewhere') {
    add('warn', 'PROFILE_LINK_ELSEWHERE', 'human',
      `插件链接指着 ${f.profileLinkTarget ?? '别处'}，不是本仓库`,
      'node scripts/napcat-setup.mjs 会删掉旧链接重建（跑的其实是链接指向的那份代码）');
  } else if (f.profileLinkState === 'unknown') {
    add('warn', 'PROFILE_LINK_UNKNOWN', 'human',
      '插件链接在那儿，但读不出它指着谁（目标被删过？）',
      '删掉那条链接再跑 node scripts/napcat-setup.mjs');
  } else if (f.profileLinkState === 'not-a-link') {
    add('warn', 'PROFILE_LINK_NOT_LINK', 'human',
      'node_modules 里那个位置是一个真的目录，不是链接（手工拷进去的插件？）',
      '确认要跑的是哪一份：要跑本仓库就删掉它再跑 node scripts/napcat-setup.mjs');
  }
  if (f.profileManifestInstalled === false) {
    add('warn', 'PROFILE_PLUGIN_MISSING', 'human',
      'profile 的 package.json 里缺「依赖 + bundles」那两项：装了也不会被加载',
      'node scripts/napcat-setup.mjs（两处一起补；只补一处等于没装）');
  }

  // ---- 环境变量与凭据 ----------------------------------------------------
  if (f.envPresent === false) {
    add('warn', 'ENV_MISSING', 'workspace',
      `${f.envFile ?? '.env'} 不存在：QQBOT_* 全用插件的平台默认值`,
      'node scripts/ops.mjs doctor --fix 生成 .env.example（照着填）；桌面版要写进 profile 的 .env 并重启');
  }
  if (f.credentialsUsable === false) {
    add('error', 'CREDENTIAL_MISSING', 'human',
      '找不到可用的模型凭据（DEEPSEEK_API_KEY）',
      '在 DSH Web UI 的 Models 页填一次（写进 $DSH_HOME/.credentials.yaml，任何启动方式都生效）；别把 key 写进仓库');
  }

  // ---- 每天轮换的 key 池 -------------------------------------------------
  if (f.keyPoolPresent === false) {
    add('info', 'KEY_POOL_MISSING', 'workspace',
      `${f.keyPoolPath ?? 'data/api-keys.txt'} 不存在：apiKeyRotate 不会做任何事`,
      '想轮换就建 data/api-keys.txt，一行一个 key（不想要就不用管，这条不影响运行）');
  } else if (typeof f.keyPoolSize === 'number' && f.keyPoolSize < 2) {
    add('info', 'KEY_POOL_TOO_SMALL', 'workspace',
      `key 池里只有 ${f.keyPoolSize} 个 key（轮换至少要两个能用的）`,
      '再加一个 key；只有一个可用 key 时轮换本来就不做事，这不是故障');
  }

  // ---- 配置里过期的工具名（JM 移除之后最常见） ---------------------------
  if (Array.isArray(f.staleToolAllowlist) && f.staleToolAllowlist.length > 0) {
    add('warn', 'STALE_TOOL_ALLOWLIST', 'human',
      `allowTools 里有代码里不存在的工具：${f.staleToolAllowlist.join(' / ')}`,
      '在 Web UI 的「设置 → QQ Bridge」里删掉它们（或改 cordis.patch.yml）；不删也能跑，只是每次启动会记一条 warn');
  }

  // ---- 依赖与工作目录 ----------------------------------------------------
  if (Array.isArray(f.peerDepsMissing) && f.peerDepsMissing.length > 0) {
    add('warn', 'DEPS_MISSING', 'human',
      `node_modules 里缺 Harness 注入的包：${f.peerDepsMissing.join(' / ')}`,
      'Windows 上跑 node scripts/dev-node-modules.mjs --from <DSH checkout>；Linux 上检查 node_modules 是不是被删了');
  }
  if (f.cwdWritable === false) {
    add('error', 'CWD_NOT_WRITABLE', 'root',
      `${f.cwd ?? 'cwd'} 写不进去：会话缓存、记忆、表情包都必须落在 cwd 里`,
      '给它写权限（chmod / chown），或把 QQBOT_CWD 指到写得进去的目录');
  }

  // ---- 长期记忆的卫生 ----------------------------------------------------
  // 这几条对应的都是「文件在、但不生效」的静默故障：解析不了的行永远不会进提示词，
  // 指向已删除图片的目录条目选了就发不出去 —— 靠人翻文件才发现太晚。
  if (Array.isArray(f.cognitionWarnings) && f.cognitionWarnings.length > 0) {
    add('warn', 'COGNITION_UNPARSED', 'workspace',
      `COGNITION.md 有 ${f.cognitionWarnings.length} 行字段不全，永远不会进提示词（首条：${f.cognitionWarnings[0]}）`,
      '补齐那一行的「｜」分隔（写法｜意思｜怎么用），或删掉它；迁移脚本只搬路径条目，不替你补格式');
  }
  if (Array.isArray(f.cognitionDuplicateSections) && f.cognitionDuplicateSections.length > 0) {
    add('warn', 'COGNITION_DUPLICATE_SECTION', 'workspace',
      `COGNITION.md 有重复的二级标题：${f.cognitionDuplicateSections.join(' / ')}`,
      '合并成一个；之后再用 append 写认知也会在落盘时自动合并，但历史内容要人看一眼');
  }
  if (Array.isArray(f.cognitionPathViolations) && f.cognitionPathViolations.length > 0) {
    add('warn', 'COGNITION_PATH', 'workspace',
      `COGNITION.md 里有 ${f.cognitionPathViolations.length} 条以文件路径为键的条目（.qq-media 是缓存，会过期）`,
      'node scripts/ops.mjs migrate --apply 把它们迁进 STICKERS.md');
  }
  if (Array.isArray(f.stickerMissing) && f.stickerMissing.length > 0) {
    add('warn', 'STICKER_PATH_MISSING', 'workspace',
      `STICKERS.md 的已收藏条目指向不存在的文件：${f.stickerMissing.slice(0, 3).join(' / ')}${f.stickerMissing.length > 3 ? ' …' : ''}`,
      '把图放回 .qq-stickers/，或者删掉那一条（删之前确认不是只改了文件名）');
  }
  if (Array.isArray(f.stickerMediaPaths) && f.stickerMediaPaths.length > 0) {
    add('warn', 'STICKER_MEDIA_PATH', 'workspace',
      `STICKERS.md 的「已收藏」区里出现了 .qq-media 路径：${f.stickerMediaPaths.slice(0, 3).join(' / ')}`,
      '先用 qq_save_sticker 收藏，再把那一行改成 .qq-stickers/… —— 缓存路径迟早被淘汰');
  }

  // ---- 日志里的现场 ------------------------------------------------------
  if (typeof f.journalProblem === 'string' && f.journalProblem.length > 0) {
    add('warn', 'JOURNAL_PROBLEM', 'workspace',
      `最近的日志里有可疑的一行：${f.journalProblem}`,
      'node scripts/ops.mjs logs -n 100 看完整上下文（插件日志同时写 journal 与 stderr）');
  }

  // ---- 纯提示（info 级，不影响退出码） -----------------------------------
  if (f.container === true) {
    add('info', 'CONTAINER_MODE', 'workspace',
      'NapCat 在容器里：状态 / 日志 / 重启都走 docker',
      `docker ps -a --filter name=${DEFAULT_CONTAINER}`);
  }
  if (f.wsl === true && f.systemd !== true) {
    add('info', 'WSL_NO_SYSTEMD', 'human',
      'WSL 里没有可用的 systemd 用户会话：install / restart 只能给前台启动的命令',
      '在 tmux 里前台跑：dsh --profile qqbot --port 3081 --no-open');
  }
  const logPlace = typeof f.logsPath === 'string' && f.logsPath.length > 0
    ? f.logsPath
    : (typeof f.logsHint === 'string' && f.logsHint.length > 0 ? f.logsHint : '');
  if (logPlace.length > 0) {
    add('info', 'LOG_LOCATION', 'workspace', `日志在：${logPlace}`, 'node scripts/ops.mjs logs -n 100');
  }

  // 稳定排序：同级保持产生顺序（先主因、后细节），跨级 error → warn → info。
  return out
    .map((item, index) => ({ item, index }))
    .sort((left, right) => levelRank(left.item.level) - levelRank(right.item.level) || left.index - right.index)
    .map(({ item }) => item);
}

/**
 * 每条 finding 对应的「人该跑什么」。`requires: 'workspace'` 的 finding 不进这里
 * （那些脚本自己能做，或本来就只是提示）。
 *
 * 命令刻意只写**一条**：agent 的用法是把 `command` 原样贴给用户，多行会变成一段
 * 需要人二次理解的脚本。详细解释在 finding 的 `fix` 里。
 */
const FIX_COMMANDS = {
  ONEBOT_UNREACHABLE: 'node scripts/ops.mjs logs -n 100',
  NAPCAT_CONFIG_MISSING: 'node scripts/ops.mjs napcat config --apply',
  SYSTEMD_UNIT_MISSING: 'node scripts/ops.mjs install',
  SYSTEMD_NOT_ENABLED: `systemctl --user enable ${DEFAULT_UNIT}`,
  PROFILE_LINK_MISSING: 'node scripts/napcat-setup.mjs',
  PROFILE_LINK_ELSEWHERE: 'node scripts/napcat-setup.mjs',
  PROFILE_LINK_UNKNOWN: 'node scripts/napcat-setup.mjs',
  PROFILE_LINK_NOT_LINK: 'node scripts/napcat-setup.mjs',
  PROFILE_PLUGIN_MISSING: 'node scripts/napcat-setup.mjs',
  NAPCAT_DIR_MISSING: 'node scripts/napcat-setup.mjs --napcat <目录>',
  DEPS_MISSING: 'node scripts/dev-node-modules.mjs --from <DSH checkout>',
  CWD_NOT_WRITABLE: 'chmod u+w .',
  WSL_NO_SYSTEMD: 'dsh --profile qqbot --port 3081 --no-open',
  // 凭据与 allowTools 只能在 Web UI / 配置里改，没有一条对得上的 shell 命令：
  // 空命令 + note 才是诚实的（编一条假命令比不给更糟）。
  CREDENTIAL_MISSING: '',
  STALE_TOOL_ALLOWLIST: '',
};

/**
 * 把 finding 变成步骤：只收 `human` / `root` 的那些 —— `workspace` 的修复
 * （建 data/、写 .env.example）由 CLI 的 `--fix` 自己干，不该混在「等你复制」的清单里。
 *
 * @param findings - {@link doctorFindings} 的结果。
 * @returns 步骤数组（`status` 一律 `planned`，等 CLI 执行或打印）。
 */
export function doctorSteps(findings = []) {
  const out = [];
  for (const item of Array.isArray(findings) ? findings : []) {
    if (item === undefined || item === null) continue;
    if (item.requires !== 'human' && item.requires !== 'root') continue;
    const id = `fix-${String(item.code ?? 'unknown').toLowerCase()}`;
    out.push(step(id, item.requires, FIX_COMMANDS[item.code] ?? '', item.fix ?? item.message ?? ''));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 路径归一
// ---------------------------------------------------------------------------

/**
 * `servicePlan` 需要的路径与名字，全部有默认值（没给也能算出能读的计划）。
 *
 * `unitPath` 的默认值刻意写成带 `~` 的形状：它是给人复制到终端里跑的命令，
 * 展开交给我们看不见的那个 shell，比在脚本里猜 `$HOME` 更可靠。
 */
function opsPaths(platform, paths = {}) {
  const p = paths ?? {};
  const px = pathFor(platform);
  const unit = String(p.unit ?? '').trim() || DEFAULT_UNIT;
  const cwd = String(p.cwd ?? '').trim();
  const repoRoot = String(p.repoRoot ?? '').trim();
  const endpoint = String(p.endpoint ?? '').trim() || DEFAULT_ENDPOINT;
  const target = endpointTarget(endpoint);
  const port = Number.isSafeInteger(Number(p.port)) && Number(p.port) > 0
    ? Number(p.port)
    : (target?.port ?? 3001);
  const logLinesRaw = Number(p.logLines);
  const logLines = Number.isSafeInteger(logLinesRaw) && logLinesRaw > 0
    ? Math.min(logLinesRaw, 10000)
    : DEFAULT_LOG_LINES;
  const servicePath = String(p.servicePath ?? '').trim()
    || (repoRoot.length > 0 ? px.join(repoRoot, 'deploy', 'qqbot.service') : 'deploy/qqbot.service');
  const unitPath = String(p.unitPath ?? '').trim()
    || px.join('~', '.config', 'systemd', 'user', `${unit}.service`);
  return {
    os: platform?.os ?? 'linux',
    // 有没有可用的 systemd 用户会话决定 Linux 那一套计划是不是成立；
    // 它来自 platform（detectPlatform 的探测结果），不从 paths 里猜。
    systemd: platform?.systemd === true,
    unit,
    unitPath,
    unitDir: String(p.unitDir ?? '').trim() || px.join('~', '.config', 'systemd', 'user'),
    servicePath,
    cwd,
    repoRoot,
    endpoint,
    port,
    logLines,
    logFile: String(p.logFile ?? '').trim(),
    taskName: String(p.taskName ?? '').trim() || TASK_NAME,
    containerName: String(p.containerName ?? '').trim() || DEFAULT_CONTAINER,
    profileName: String(p.profileName ?? '').trim() || 'qqbot',
    profileDir: String(p.profileDir ?? '').trim(),
    napcatDir: String(p.napcatDir ?? '').trim(),
    qq: String(p.qq ?? '').trim(),
  };
}

/** Windows 上「看日志尾巴」的一行：有具体文件就看文件，只知道目录就先列最近的几个。 */
function windowsLogCommand(p) {
  if (p.logFile.length > 0) {
    return `powershell.exe -NoProfile -Command "Get-Content -Tail ${p.logLines} -LiteralPath '${p.logFile.replace(/'/g, "''")}'"`;
  }
  if (p.napcatDir.length > 0) {
    const dir = winPath.join(p.napcatDir, 'logs').replace(/'/g, "''");
    return `powershell.exe -NoProfile -Command "Get-ChildItem -LiteralPath '${dir}' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 5 Name,Length"`;
  }
  return '';
}

/** 容器模式的 `docker run` 片段：端口必须与 endpoint 一致，配置挂出来才改得动。 */
function containerRunCommand(p) {
  return [
    'docker run -d --name', p.containerName, '--restart=always',
    '-p', `${p.port}:${p.port}`, '-p', '6099:6099',
    '-v', '~/napcat/config:/app/napcat/config',
    '-v', '~/napcat/qq:/app/.config/QQ',
    'mlikiowa/napcat-docker:latest',
  ].join(' ');
}

// ---------------------------------------------------------------------------
// servicePlan
// ---------------------------------------------------------------------------

/**
 * 某一类平台上「服务怎么管」的步骤清单：**只描述，不执行**。
 *
 * 三套基础计划按 `platform.os` 选：
 *   - Windows：计划任务（`schtasks`）+ 明确承认「桌面版应用重启不了」；
 *   - Linux：`systemctl --user` / `journalctl --user`（没有 systemd 时只给前台跑法）；
 *   - 其它：一条说明 + 退路。
 *
 * 容器模式（`platform.container`）是在基础计划之后**追加** `docker ps` / `docker logs` /
 * `docker restart` 那几条，而不是替换：NapCat 在容器里，但 bot 自己（DSH 进程）仍然由
 * systemd / 计划任务 / tmux 管着 —— 两件事得同时被看见，否则「重启 bot」就没人做了。
 *
 * `requires` 的语义见 {@link REQUIREMENTS}：`workspace` 的步骤 CLI 会自己跑
 * （只读查询、或直接重启当前用户的 unit），`human` / `root` 的只打印。
 * 写 cwd 外的步骤（装 unit、注册计划任务、改 profile）**永远**不是 `workspace`。
 *
 * @param {'status'|'restart'|'logs'|'install'|'uninstall'|'autostart'} action
 * @param {object} platform {@link detectPlatform} 的返回值。
 * @param {object} [paths] 见 {@link opsPaths}（`unit` / `unitPath` / `taskName` /
 *   `containerName` / `repoRoot` / `cwd` / `profileName` / `napcatDir` / `qq` /
 *   `endpoint` / `logLines` / `logFile`）。
 * @returns {Array<{ id: string, status: string, requires: string, command: string, note: string }>}
 */
export function servicePlan(action, platform, paths = {}) {
  const p = opsPaths(platform, paths);
  if (!OPS_ACTIONS.includes(action)) {
    return [step('unknown-action', 'human', '', `不认识的运维动作「${action}」（可用：${OPS_ACTIONS.join(' / ')}）`)];
  }
  const base = platform?.os === 'win32'
    ? windowsPlan(action, p)
    : platform?.os === 'linux' ? linuxPlan(action, p) : genericPlan(action, p);
  // 容器模式是**附加**而不是替换：NapCat 在 docker 里，但 bot 自己（DSH 进程）仍然跑在
  // systemd / 计划任务 / tmux 里 —— 只打 docker 命令的话，「重启 bot」这件事就没人做了。
  return platform?.container === true ? [...base, ...containerExtra(action, p)] : base;
}

/** Linux：systemd user unit。没有 systemd（WSL 常见）时只给前台跑法，不假装能管服务。 */
function linuxPlan(action, p) {
  if (p.systemd !== true) return noSystemdPlan(action, p);
  const shell = (value) => shellPath(value);
  switch (action) {
    case 'status':
      return [
        step('systemd-status', 'workspace',
          `systemctl --user status ${p.unit} --no-pager -n ${p.logLines}`,
          '只读：看它在不在、最后一次退出了什么。`status` 对 inactive 也返回 3，别拿退出码当结论',
          ['systemctl', '--user', 'status', p.unit, '--no-pager', '-n', String(p.logLines)]),
        step('systemd-journal', 'workspace',
          `journalctl --user -u ${p.unit} -n ${p.logLines} --no-pager`,
          '只读：插件日志同时写 journal 与 stderr（AGENTS.md §5.8），这是唯一看得到它的地方',
          ['journalctl', '--user', '-u', p.unit, '-n', String(p.logLines), '--no-pager']),
      ];
    case 'restart':
      return [
        step('systemd-restart', 'workspace',
          `systemctl --user restart ${p.unit}`,
          '只重启当前用户的 unit：不要 sudo、也不写项目外的文件；正在回答的那一轮会断，会话从磁盘恢复',
          ['systemctl', '--user', 'restart', p.unit]),
        step('systemd-is-active', 'workspace',
          `systemctl --user is-active ${p.unit}`,
          '重启之后确认一次（输出 active 才算回来了）',
          ['systemctl', '--user', 'is-active', p.unit]),
      ];
    case 'logs':
      return [
        step('systemd-logs', 'workspace',
          `journalctl --user -u ${p.unit} -n ${p.logLines} --no-pager`,
          '只读：加 -f 可以跟着看；插件日志同时也在 stderr 里',
          ['journalctl', '--user', '-u', p.unit, '-n', String(p.logLines), '--no-pager']),
      ];
    case 'install':
      return [
        step('write-unit', 'human',
          `mkdir -p ${shell(p.unitDir)} && cp ${shell(p.servicePath)} ${shell(p.unitPath)}`,
          '写 systemd unit 在 cwd 外（~/.config/systemd/user）。unit 里的 %h 由 systemd 展开，别手改成绝对路径'),
        step('systemd-enable', 'human',
          `systemctl --user daemon-reload && systemctl --user enable --now ${p.unit}`,
          'enable 会在 ~/.config 里建链接（cwd 外），还顺手把服务拉起来'),
        step('systemd-linger', 'human',
          'loginctl enable-linger "$USER"',
          '可选：让它在你不登录的时候也活着（不装的话注销后 unit 会被停掉）。可能要弹一次 polkit 授权',
          [], true),
        step('install-profile', 'human',
          `node scripts/napcat-setup.mjs --profile ${p.profileName}`,
          '把仓库装进 profile：依赖 + bundles + node_modules 链接一次做完（desktop.js 的纯函数，可先 --dry-run）'),
        step('napcat-config', 'human',
          'node scripts/ops.mjs napcat config --apply',
          '在 NapCat 里写一条启用的 WebSocket 服务器（端口 / token 与插件一致；改前自动备份）'),
        step('verify', 'workspace', 'node scripts/ops.mjs doctor --json', '装完自己体检一遍：端口、配置、profile 链接、凭据'),
      ];
    case 'uninstall':
      return [
        step('systemd-disable', 'human',
          `systemctl --user disable --now ${p.unit}`,
          '先停再取消自启；正在回答的那一轮会断'),
        step('remove-unit', 'human',
          `rm -f ${shell(p.unitPath)} && systemctl --user daemon-reload`,
          '删掉 unit 文件（cwd 外）并让 systemd 忘掉它'),
        step('remove-profile', 'human', '',
          `在 Web UI 的「设置 → 插件」里移除本插件，或删掉 profile 的 package.json 里 dependencies + dsh.profile.bundles 那两项与 node_modules 链接（${p.profileDir || 'profile 目录'}，cwd 外）`),
        step('keep-data', 'human', '',
          'data/、.qq-memory/、.qq-media/、.qq-stickers/ 里是聊天记录与记忆，**不自动删**：要清就自己删（.qq-jm/ 可以用 cleanup jm）',
          [], true),
      ];
    case 'autostart':
      return [
        step('systemd-enable-autostart', 'human',
          `systemctl --user enable ${p.unit}`,
          '开机自启就是 enable（它会建一条 ~/.config/systemd/user/...wants 的链接，cwd 外）'),
        step('systemd-linger', 'human',
          'loginctl enable-linger "$USER"',
          '可选：不登录也要它活着，就得开 linger',
          [], true),
        step('systemd-is-enabled', 'workspace',
          `systemctl --user is-enabled ${p.unit}`,
          '确认（输出 enabled 才算设好）',
          ['systemctl', '--user', 'is-enabled', p.unit]),
      ];
    default:
      return [];
  }
}

/** 没有 systemd 用户会话（WSL 第一版、容器里没装 systemd）：只给诚实的退路。 */
function noSystemdPlan(action, p) {
  const foreground = `dsh --profile ${p.profileName} --port 3081 --no-open`;
  switch (action) {
    case 'status':
      return [step('no-systemd', 'human', '', `这台机器没有可用的 systemd 用户会话（WSL？），没有服务可查：${foreground} 是在 tmux 里跑的吧？看前台输出或 node scripts/ops.mjs logs`)];
    case 'restart':
      return [step('no-systemd-restart', 'human', '',
        `没有 systemd 就没有「重启服务」这回事：在 tmux 里 Ctrl-C，再跑 ${foreground}（源码改动必须重启进程才生效，AGENTS.md §5.1）`)];
    case 'logs':
      return [
        step('no-systemd-logs', 'human', '',
          '没有 journalctl 可看：插件日志落在它自己的 stderr 上（前台运行的那个 tmux 面板）'),
      ];
    case 'install':
      return [
        step('no-systemd-install', 'human', '',
          `不装 systemd unit：${foreground}（建议放 tmux）；重启机器后要重新跑`),
        step('install-profile', 'human',
          `node scripts/napcat-setup.mjs --profile ${p.profileName}`,
          'profile 里装插件与写 .env 这两步与 systemd 无关，仍然要做'),
        step('napcat-config', 'human', 'node scripts/ops.mjs napcat config --apply', '在 NapCat 里写一条启用的 WebSocket 服务器（改前备份）'),
        step('verify', 'workspace', 'node scripts/ops.mjs doctor --json', '体检一遍'),
      ];
    case 'uninstall':
      return [step('no-systemd-uninstall', 'human', '', '没有 unit 可删；把 tmux 里那个进程停掉即可，数据目录不自动删')];
    case 'autostart':
      return [step('no-systemd-autostart', 'human', '', `没有 systemd 就没有开机自启：${foreground} 放进 tmux 或你自己的启动项（脚本不碰登录脚本）`)];
    default:
      return [];
  }
}

/** Windows：计划任务管 NapCat，桌面版应用**重启不了**（那会连 UI 一起杀掉）。 */
function windowsPlan(action, p) {
  switch (action) {
    case 'status':
      return [
        planStep('schtasks-query', scheduledTaskQueryPlan({ taskName: p.taskName, verbose: true }), 'workspace',
          '只读：任务在不在、上次结果、下次运行时间（查询自己的任务不需要提权）'),
        windowsLogStep(p),
      ];
    case 'restart':
      return [
        step('restart-napcat-task', 'human',
          `schtasks.exe /End /TN "${p.taskName}" & schtasks.exe /Run /TN "${p.taskName}"`,
          '计划任务里的 NapCat 能单独重启（以管理员身份、无窗口；任务不在就先装：node scripts/napcat-setup.mjs --autostart install）'),
        step('restart-desktop-app', 'human', '',
          '请重启桌面版（DSH 应用）：插件源码在启动时加载，重启会连 UI 一起退出，脚本不替你做（AGENTS.md §5.1 / §5.11）'),
      ];
    case 'logs':
      return [windowsLogStep(p)];
    case 'install':
      return [
        step('install-profile', 'human',
          `node scripts/napcat-setup.mjs --profile ${p.profileName}${p.qq.length > 0 ? ` --qq ${p.qq}` : ''}`,
          '把仓库装进 profile（依赖 + bundles + node_modules 链接一次做完；先加 --dry-run 看它要改什么）'),
        step('write-autostart-files', 'human',
          'node scripts/napcat-setup.mjs --autostart install',
          `写 ${HIDDEN_WRAPPER_NAME}（UTF-16LE + BOM，别手写）与 ${TASK_XML_NAME}，再注册计划任务；这一步会弹一次 UAC`),
        planStep('register-autostart',
          scheduledTaskInstallPlan({ platform: 'win32', taskName: p.taskName, xmlPath: p.napcatDir.length > 0 ? winPath.join(p.napcatDir, TASK_XML_NAME) : '' }),
          'root',
          '注册计划任务：登录时以管理员身份、无窗口启动 NapCat（UAC 点一次「是」，之后启动不再问）'),
        step('napcat-config', 'human', 'node scripts/ops.mjs napcat config --apply', '在 NapCat 里写一条启用的 WebSocket 服务器（端口 / token 与插件一致；改前备份）'),
        step('verify', 'workspace', 'node scripts/ops.mjs doctor --json', '装完体检一遍'),
      ];
    case 'uninstall':
      return [
        planStep('delete-autostart', scheduledTaskDeletePlan({ platform: 'win32', taskName: p.taskName }), 'root',
          '删掉计划任务（UAC 点「是」）；NapCat 进程本身不会被停掉'),
        step('remove-autostart-files', 'human', '',
          `删掉 NapCat 目录里的 ${p.napcatDir.length > 0 ? winPath.join(p.napcatDir, HIDDEN_WRAPPER_NAME) : HIDDEN_WRAPPER_NAME} 与 ${TASK_XML_NAME}（cwd 外；留着也能跑，只是两份旧文件）`),
        step('remove-profile', 'human', '',
          '在桌面版「设置 → 插件」里移除本插件（或删 profile 的 package.json 里 dependencies + dsh.profile.bundles 那两项与 node_modules 链接）'),
        step('keep-data', 'human', '', 'data/ 与 .qq-memory/ 是聊天记录与记忆，**不自动删**：要清就自己删',
          [], true),
      ];
    case 'autostart':
      return [
        planStep('register-autostart',
          scheduledTaskInstallPlan({ platform: 'win32', taskName: p.taskName, xmlPath: p.napcatDir.length > 0 ? winPath.join(p.napcatDir, TASK_XML_NAME) : '' }),
          'root',
          '注册（或覆盖）计划任务；XML 得先由 napcat-setup 写出来，所以单跑这条前先 node scripts/napcat-setup.mjs --autostart install'),
      ];
    default:
      return [];
  }
}

/** Windows 的日志步骤：桌面版没有终端，日志文件是唯一的现场。 */
function windowsLogStep(p) {
  const command = windowsLogCommand(p);
  if (command.length === 0) {
    return step('napcat-log-tail', 'human', '',
      'Windows 桌面版没有终端面板：日志在 NapCat 的 logs 目录里，Electron 自己的日志在桌面版数据目录（用 Web UI 看）。用 --napcat <目录> 指定 NapCat 后这里会给出具体命令');
  }
  const argv = p.logFile.length > 0
    ? ['powershell.exe', '-NoProfile', '-Command', `Get-Content -Tail ${p.logLines} -LiteralPath '${p.logFile.replace(/'/g, "''")}'`]
    : ['powershell.exe', '-NoProfile', '-Command', `Get-ChildItem -LiteralPath '${winPath.join(p.napcatDir, 'logs').replace(/'/g, "''")}' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 5 Name,Length`];
  return step('napcat-log-tail', 'workspace', command, `NapCat 日志（最后 ${p.logLines} 行；有 --log-file 时直接读文件）`, argv);
}

/** 容器模式附加在平台计划后面的那几条：NapCat 那一侧的动作（写操作按 root 等价处理）。 */
function containerExtra(action, p) {
  switch (action) {
    case 'status':
      return [
        step('docker-ps', 'workspace',
          `docker ps --filter name=${p.containerName}`,
          '只读：NapCat 容器在不在、端口映射对不对（宿主端口必须等于 endpoint 的端口）',
          ['docker', 'ps', '--filter', `name=${p.containerName}`]),
        step('docker-logs', 'workspace',
          `docker logs --tail ${p.logLines} ${p.containerName}`,
          '只读：NapCat 的日志就是容器日志（加 --timestamps 看时间）',
          ['docker', 'logs', '--tail', String(p.logLines), p.containerName]),
      ];
    case 'restart':
      return [
        // 可选：重启 bot 之后 NapCat 自己会重新连上；要连那一侧也重启才需要这条。
        step('docker-restart', 'human',
          `docker restart ${p.containerName}`,
          '可选。docker 权限等同于 root，脚本不替你做；正在回答的那一轮会断',
          [], true),
      ];
    case 'logs':
      return [
        step('docker-logs', 'workspace',
          `docker logs --tail ${p.logLines} ${p.containerName}`,
          '只读：NapCat 的日志（加 -f 跟着看，--timestamps 看时间）',
          ['docker', 'logs', '--tail', String(p.logLines), p.containerName]),
      ];
    case 'install':
      return [
        step('container-run', 'human', containerRunCommand(p),
          `NapCat 跑在容器里；端口 ${p.port} 必须与插件的 endpoint 一致，6099 是它的 WebUI。配置挂到宿主的 ~/napcat/config，改完 docker restart`),
      ];
    case 'uninstall':
      return [
        step('docker-stop', 'human',
          `docker stop ${p.containerName}`,
          '可选：停掉 NapCat 容器。卸载 bot 本身不需要停它；容器里的 QQ 数据与挂载目录一律留着',
          [], true),
      ];
    case 'autostart':
      return [
        step('docker-restart-policy', 'human',
          `docker update --restart=always ${p.containerName}`,
          '容器版 NapCat 的开机自启就是 docker 的重启策略（替代 systemd / 计划任务）'),
      ];
    default:
      return [];
  }
}

/** 其它平台（macOS 等）：没有专门计划，说清原因给一条退路。 */
function genericPlan(action, p) {
  return [
    step(`generic-${action}`, 'human', '',
      `这个平台（${p.os}）还没有专门的运维计划：前台跑 dsh --profile ${p.profileName} --port 3081 --no-open，或自己写 launchd / 计划任务；数据目录照旧在 cwd 里`),
  ];
}

// ---------------------------------------------------------------------------
// installPlan
// ---------------------------------------------------------------------------

/** 各平台的「在 cwd 里先铺好」命令（`mkdir -p` 只有 POSIX 有）。 */
function mkdirCommand(platform, dir) {
  if (platform?.os === 'win32') {
    return `powershell.exe -NoProfile -Command "New-Item -ItemType Directory -Force -Path '${String(dir).replace(/'/g, "''")}' | Out-Null"`;
  }
  return `mkdir -p ${shellPath(dir)}`;
}

/** cwd 里的准备步骤（agent 在 `--apply` 时可以自己做完的那部分）。 */
function installPrepareSteps(platform, facts) {
  const px = pathFor(platform);
  const cwd = String(facts.cwd ?? '').trim() || '.';
  return [
    step('ensure-data-dir', 'workspace', mkdirCommand(platform, px.join(cwd, 'data')),
      'data/ 放会话缓存、/reset 标记与 key 池（.gitignore 已盖住）；缺了它插件会自己建，先建好能省一条启动警告'),
    step('ensure-env-example', 'workspace', 'node scripts/ops.mjs doctor --fix',
      '.env.example 只列 QQBOT_* 的名字与说明、不写真实 token；桌面版的真值要写进 profile 的 .env（cwd 外，脚本不碰）'),
  ];
}

/**
 * 「从零把它装起来」的完整步骤：cwd 内的准备 + {@link servicePlan} 的 `install`，
 * 再把 `facts.doneStepIds` 里已有的步骤标成 `skipped`（**幂等**：重复执行不重复写）。
 *
 * `doneStepIds` 由调用方观察磁盘/服务后给出（`data/` 在不在、unit 装没装、
 * profile 链接指不指本仓库）—— 计划层不自己去查，这样它才测得动、也才不会
 * 「先查后做」之间出现两条真相。
 *
 * @param {object} platform {@link detectPlatform} 的返回值。
 * @param {object} [facts] `doneStepIds` + {@link opsPaths} 认的那些字段
 *   （`cwd` / `repoRoot` / `unit` / `unitPath` / `taskName` / `containerName` /
 *   `profileName` / `profileDir` / `napcatDir` / `qq` / `endpoint` / `logLines`）。
 * @returns {Array<{ id: string, status: string, requires: string, command: string, note: string }>}
 */
export function installPlan(platform, facts = {}) {
  const f = facts ?? {};
  const done = new Set(Array.isArray(f.doneStepIds) ? f.doneStepIds.map((item) => String(item)) : []);
  const steps = [
    ...installPrepareSteps(platform, f),
    ...servicePlan('install', platform, {
      unit: f.unit,
      unitPath: f.unitPath,
      servicePath: f.servicePath,
      taskName: f.taskName,
      containerName: f.containerName,
      cwd: f.cwd,
      repoRoot: f.repoRoot,
      profileName: f.profileName,
      profileDir: f.profileDir,
      napcatDir: f.napcatDir,
      qq: f.qq,
      endpoint: f.endpoint,
      logLines: f.logLines,
      logFile: f.logFile,
    }),
  ];
  return steps.map((item) => {
    if (!done.has(item.id)) return item;
    const note = item.note.length > 0 ? `${item.note}（已经做过了，跳过）` : '已经做过了，跳过';
    return { ...item, status: 'skipped', note };
  });
}

// ---------------------------------------------------------------------------
// 退出码
// ---------------------------------------------------------------------------

/**
 * §10.3 的退出码契约：`0` 全部通过；`1` 有 error 级 findings；`2` 需要人工/提权；
 * `3` 脚本自身出错。优先级是 3 → 1 → 2 → 0：脚本自己坏了就不再假装诊断结论有效，
 * 而「这里有错」比「需要人动手」更值得先被看见。
 *
 * 只有**还没做**（`status` 不是 `skipped` / `done`）的 `human` / `root` 步骤才算
 * 「需要人工」：`--apply` 跑完之后步骤变成 `done`，就不该再以 2 退出。
 * `optional: true` 的步骤（linger、重启 NapCat 容器）同样不算：可选项没做是正常的。
 *
 * @param {object} result `{ error?, findings?, steps? }`
 * @returns {0|1|2|3}
 */
export function exitCodeFor(result = {}) {
  const r = result ?? {};
  if (typeof r.error === 'string' ? r.error.length > 0 : r.error === true) return 3;
  const findings = Array.isArray(r.findings) ? r.findings : [];
  if (findings.some((item) => item?.level === 'error')) return 1;
  const steps = Array.isArray(r.steps) ? r.steps : [];
  // optional 的步骤不算「等你动手」：可选动作（linger、重启 NapCat 容器）没做是正常的，
  // 否则一个可选项会把退出码永远钉在 2 上，agent 就再也分不清「真需要人」了。
  const waiting = (item) => item?.optional !== true && item?.status !== 'skipped' && item?.status !== 'done'
    && (item?.requires === 'human' || item?.requires === 'root');
  // findings 没有 status：一条还没解决的 finding 本身就是「等你动手」。
  if (findings.some((item) => item?.requires === 'human' || item?.requires === 'root')) return 2;
  return steps.some(waiting) ? 2 : 0;
}
