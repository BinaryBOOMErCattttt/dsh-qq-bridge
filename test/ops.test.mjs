/**
 * 运维纯计划层（`ops.js`）的判据测试。
 *
 * 这一层要回答的是「现在哪儿坏了、照着做什么」，而它的两个失误都很贵：
 *
 *   - **把「没查到」当成「坏了」**（误报）：用户被指挥去改一份没问题的配置；
 *   - **把「要写 cwd 外」的步骤标成脚本自己能做**（越权）：agent 在沙箱里执行它，
 *     然后以「拒绝访问」收场 —— 比不做更让人困惑。
 *
 * 所以这里的用例分三组：平台形状（Linux / Windows / 容器，在 Linux 上照样验 Windows
 * 形状）、finding 的判据与完整性、以及计划步骤的「谁来做 / 幂等 / 退出码」。
 * 不 spawn 任何子进程，也不碰真的磁盘：所有事实都是手写的普通对象。
 *
 * 运行：node --test test/ops.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONTAINER,
  DEFAULT_UNIT,
  OPS_ACTIONS,
  OPS_SCHEMA,
  REQUIREMENTS,
  detectPlatform,
  doctorFindings,
  doctorSteps,
  exitCodeFor,
  installPlan,
  renderPlan,
  servicePlan,
} from '../ops.js';
import { HIDDEN_WRAPPER_NAME, TASK_NAME, TASK_XML_NAME } from '../napcat.js';

/** 一台「标准的」Linux 本机：有 systemd 用户会话、不是容器。 */
function linux(overrides = {}) {
  return detectPlatform({
    platform: 'linux',
    env: { HOME: '/home/u' },
    uid: 1000,
    hasSystemctl: true,
    cwd: '/srv/qqbot',
    ...overrides,
  });
}

/** Windows 桌面版：有 schtasks，路径是反斜杠的。 */
function windows(overrides = {}) {
  return detectPlatform({
    platform: 'win32',
    env: { USERPROFILE: 'C:\\Users\\u' },
    hasSchtasks: true,
    cwd: 'C:\\qqbot',
    ...overrides,
  });
}

/** 容器部署：NapCat 在 docker 里，systemd 那一套不成立。 */
function container(overrides = {}) {
  return detectPlatform({
    platform: 'linux',
    env: { HOME: '/home/u' },
    uid: 1000,
    hasSystemctl: false,
    container: true,
    cwd: '/srv/qqbot',
    ...overrides,
  });
}

/** 计划里允许脚本自己跑的步骤（cwd 内的准备 + 只读体检）。 */
const SCRIPT_OWN_IDS = new Set(['ensure-data-dir', 'ensure-env-example', 'verify']);

// ---------------------------------------------------------------------------
// detectPlatform：平台能力
// ---------------------------------------------------------------------------

test('detectPlatform：Linux 形状认得出 systemd 用户会话与 profile 目录', () => {
  const platform = linux();
  assert.equal(platform.os, 'linux');
  assert.equal(platform.systemd, true);
  assert.equal(platform.schtasks, false);
  assert.equal(platform.wsl, false);
  assert.equal(platform.container, false);
  assert.equal(platform.elevated, false);
  assert.equal(platform.profileDir, '/home/u/.dsh/profiles/qqbot');
  assert.equal(platform.cwd, '/srv/qqbot');
});

test('detectPlatform：Windows 形状默认有 schtasks，路径按反斜杠拼', () => {
  const platform = windows();
  assert.equal(platform.os, 'win32');
  assert.equal(platform.schtasks, true);
  assert.equal(platform.systemd, false);
  assert.equal(platform.profileDir, 'C:\\Users\\u\\.dsh\\profiles\\qqbot');
  // 显式说没有 schtasks 时才关掉（比如受限环境）。
  assert.equal(windows({ hasSchtasks: false }).schtasks, false);
});

test('detectPlatform：WSL 由环境变量认出来，但不等于「没有 systemd」', () => {
  const platform = linux({ env: { HOME: '/home/u', WSL_DISTRO_NAME: 'Ubuntu' } });
  assert.equal(platform.wsl, true);
  assert.equal(platform.systemd, true, 'WSL2 开了 systemd 就照常用 systemd 那一套');
  assert.equal(linux({ env: { HOME: '/home/u', WSL_INTEROP: '/run/WSL/1_interop' } }).wsl, true);
});

test('detectPlatform：容器模式压过 os，systemd 一律不成立', () => {
  const platform = container();
  assert.equal(platform.container, true);
  assert.equal(platform.systemd, false);
  assert.equal(platform.elevated, false, '普通用户跑 docker 时不算已提权');
  // 容器里跑 root 也是事实：elevated 仍然按 uid 算。
  assert.equal(container({ uid: 0 }).elevated, true, 'uid 0 就是 root，不管在不在容器里');
});

test('detectPlatform：profileDir / cwd 可以由调用方显式覆盖（--profile / --cwd）', () => {
  const platform = linux({ profileDir: '/tmp/p', cwd: '/tmp/w' });
  assert.equal(platform.profileDir, '/tmp/p');
  assert.equal(platform.cwd, '/tmp/w');
  // 什么都没给时不能崩，也不能编出一个假的绝对路径。
  const bare = detectPlatform({});
  assert.equal(bare.os, 'linux');
  assert.equal(bare.profileDir, '');
});

// ---------------------------------------------------------------------------
// doctorFindings：未知 ≠ 坏
// ---------------------------------------------------------------------------

test('doctorFindings：完全未知的事实不产生任何 finding', () => {
  assert.deepEqual(doctorFindings({}), []);
  assert.deepEqual(doctorFindings(), [], '不传参数也不能当成「什么都坏了」');
});

test('doctorFindings：长期记忆里「文件在、但不生效」的五种情况都要点名', () => {
  const findings = doctorFindings({
    cognitionWarnings: ['COGNITION.md 第 15 行少于两段，跳过：- popipa…'],
    cognitionDuplicateSections: ['黑话与缩写'],
    cognitionPathViolations: ['.qq-media/d792c9e4.gif'],
    stickerMissing: ['.qq-stickers/蔫了.gif'],
    stickerMediaPaths: ['无语'],
  });
  assert.deepEqual(findings.map((item) => item.code).sort(), [
    'COGNITION_DUPLICATE_SECTION',
    'COGNITION_PATH',
    'COGNITION_UNPARSED',
    'STICKER_MEDIA_PATH',
    'STICKER_PATH_MISSING',
  ]);
  assert.ok(findings.every((item) => item.level === 'warn'), '这些是「能用但会静默失效」，不是错误');
  assert.match(findings.find((item) => item.code === 'COGNITION_PATH').fix, /ops\.mjs migrate/);
  assert.match(findings.find((item) => item.code === 'STICKER_MEDIA_PATH').fix, /qq_save_sticker/);
});

test('doctorFindings：记忆正常时一条都不报', () => {
  const findings = doctorFindings({
    cognitionWarnings: [],
    cognitionDuplicateSections: [],
    cognitionPathViolations: [],
    stickerMissing: [],
    stickerMediaPaths: [],
  });
  assert.deepEqual(findings, []);
});

test('doctorFindings：ONEBOT_UNREACHABLE 是 error，fix 里要说清怎么查', () => {
  const findings = doctorFindings({ endpoint: 'ws://127.0.0.1:3001', endpointReachable: false });
  const one = findings.find((item) => item.code === 'ONEBOT_UNREACHABLE');
  assert.ok(one, '端口查不通必须报出来');
  assert.equal(one.level, 'error');
  assert.equal(one.requires, 'human');
  assert.match(one.fix, /napcat|docker|端口/);
});

test('doctorFindings：NapCat 配置「在但不对」同样算 NAPCAT_CONFIG_MISSING', () => {
  const missing = doctorFindings({ napcatConfigPresent: false });
  assert.equal(missing[0].code, 'NAPCAT_CONFIG_MISSING');
  // 有账号文件、但 websocketServers 里没有对得上的一条：也是同一个根因。
  const configured = doctorFindings({ napcatConfigPresent: true, napcatConfigured: false });
  assert.equal(configured[0].code, 'NAPCAT_CONFIG_MISSING');
  assert.ok(configured.length === 1, '同一个根因只报一条');
  // 已经配好时只给一条 info，不制造噪音。
  const ok = doctorFindings({ napcatConfigured: true });
  assert.equal(ok.length, 1);
  assert.equal(ok[0].level, 'info');
});

test('doctorFindings：unit 不在时不再报「没在跑」（同一个根因只报一条）', () => {
  const notActive = doctorFindings({ systemdUnitPresent: true, systemdUnitActive: false });
  assert.equal(notActive[0].code, 'SYSTEMD_NOT_ACTIVE');
  assert.equal(notActive[0].level, 'error');
  const missing = doctorFindings({ systemdUnitPresent: false, systemdUnitActive: false });
  assert.deepEqual(missing.map((item) => item.code), ['SYSTEMD_UNIT_MISSING'], 'unit 都没装，就别再说它没在跑');
  const healthy = doctorFindings({ systemdUnitPresent: true, systemdUnitActive: true, systemdUnitEnabled: true });
  assert.deepEqual(healthy, []);
});

test('doctorFindings：profile 的链接四种状态各有一条，且都要人做', () => {
  const expected = {
    missing: 'PROFILE_LINK_MISSING',
    elsewhere: 'PROFILE_LINK_ELSEWHERE',
    unknown: 'PROFILE_LINK_UNKNOWN',
    'not-a-link': 'PROFILE_LINK_NOT_LINK',
  };
  for (const [state, code] of Object.entries(expected)) {
    const findings = doctorFindings({ profileLinkState: state });
    assert.equal(findings.length, 1, `${state} 应当只报一条`);
    assert.equal(findings[0].code, code);
    assert.equal(findings[0].requires, 'human', '改 profile 是 cwd 外的事，不能标成脚本自己做');
  }
  assert.deepEqual(doctorFindings({ profileLinkState: 'linked' }), []);
});

test('doctorFindings：环境变量 / 凭据 / key 池三条各管各的', () => {
  const env = doctorFindings({ envPresent: false, envFile: '/srv/qqbot/.env' });
  assert.equal(env[0].code, 'ENV_MISSING');
  assert.equal(env[0].fix.includes('doctor --fix'), true, 'fix 要指向脚本真能做的那个动作');
  const credentials = doctorFindings({ credentialsUsable: false });
  assert.equal(credentials[0].code, 'CREDENTIAL_MISSING');
  assert.equal(credentials[0].level, 'error');
  assert.equal(credentials[0].requires, 'human');
  const pool = doctorFindings({ keyPoolPresent: false, keyPoolPath: '/srv/qqbot/data/api-keys.txt' });
  assert.equal(pool[0].code, 'KEY_POOL_MISSING');
  assert.equal(pool[0].level, 'info', '没有 key 池只是「不轮换」，不是故障');
  assert.equal(doctorFindings({ keyPoolPresent: true, keyPoolSize: 1 })[0].code, 'KEY_POOL_TOO_SMALL');
});

test('doctorFindings：STALE_TOOL_ALLOWLIST 只在真的列得出名字时报', () => {
  const stale = doctorFindings({ staleToolAllowlist: ['qq_jm_pdf'] });
  assert.equal(stale[0].code, 'STALE_TOOL_ALLOWLIST');
  assert.match(stale[0].message, /qq_jm_pdf/);
  // 空数组 = 查过、没问题；undefined = 没查。两者都不该报。
  assert.deepEqual(doctorFindings({ staleToolAllowlist: [] }), []);
  assert.deepEqual(doctorFindings({ staleToolAllowlist: undefined }), []);
});

test('doctorFindings：每条 finding 都有 code / fix / level / requires', () => {
  // 一堆坏事实，专门喂给完整性断言：agent 靠 code 分派，人靠 fix 行动，缺一个就废一半。
  const findings = doctorFindings({
    endpoint: 'ws://127.0.0.1:3001',
    endpointReachable: false,
    napcatDir: '',
    napcatConfigPresent: false,
    systemdUnitPresent: false,
    systemdUnitActive: false,
    systemdUnitEnabled: false,
    profileLinkState: 'elsewhere',
    profileLinkTarget: '/old/qqbot',
    profileManifestInstalled: false,
    envPresent: false,
    credentialsUsable: false,
    keyPoolPresent: false,
    staleToolAllowlist: ['qq_jm_pdf', 'qq_gone'],
    peerDepsMissing: ['@deepseek-ai/schemastery'],
    cwdWritable: false,
    journalProblem: 'cannot get property "timer" without inject',
  });
  assert.ok(findings.length >= 10, `应当报出一堆问题，实际 ${findings.length} 条`);
  for (const item of findings) {
    assert.equal(typeof item.code, 'string');
    assert.ok(item.code.length > 0, 'code 不能是空的');
    assert.ok(item.fix.length > 0, `${item.code} 缺 fix`);
    assert.ok(item.message.length > 0, `${item.code} 缺 message`);
    assert.ok(['error', 'warn', 'info'].includes(item.level), `${item.code} 的 level 不合法`);
    assert.ok(REQUIREMENTS.includes(item.requires), `${item.code} 的 requires 不合法`);
  }
});

test('doctorFindings：error 排在 warn 前、warn 排在 info 前', () => {
  const findings = doctorFindings({
    logsHint: 'journalctl --user -u qqbot -n 100', // info
    envPresent: false, // warn
    endpointReachable: false, // error
  });
  const levels = findings.map((item) => item.level);
  assert.deepEqual(levels, ['error', 'warn', 'info'], `顺序是 ${levels.join(',')}`);
});

test('doctorFindings：全绿时只有 info，没有 error / warn', () => {
  const findings = doctorFindings({
    endpoint: 'ws://127.0.0.1:3001',
    endpointReachable: true,
    napcatConfigured: true,
    systemdUnitPresent: true,
    systemdUnitActive: true,
    systemdUnitEnabled: true,
    profileLinkState: 'linked',
    profileManifestInstalled: true,
    envPresent: true,
    credentialsUsable: true,
    keyPoolPresent: true,
    keyPoolSize: 3,
    staleToolAllowlist: [],
    peerDepsMissing: [],
    cwdWritable: true,
    logsHint: 'journalctl --user -u qqbot -n 100',
  });
  assert.equal(findings.some((item) => item.level !== 'info'), false, JSON.stringify(findings, null, 1));
});

test('doctorSteps：只把需要人/提权的 finding 变成步骤，workspace 的留给 --fix', () => {
  const findings = doctorFindings({
    credentialsUsable: false, // human
    cwdWritable: false, // root
    envPresent: false, // workspace
    logsHint: 'journalctl --user -u qqbot',
  });
  const steps = doctorSteps(findings);
  assert.deepEqual(steps.map((item) => item.id), ['fix-credential_missing', 'fix-cwd_not_writable']);
  for (const item of steps) {
    assert.ok(item.requires === 'human' || item.requires === 'root');
    assert.ok(item.note.length > 0, `${item.id} 的 note 要能直接念给人听`);
  }
});

// ---------------------------------------------------------------------------
// servicePlan：三种平台的「服务怎么管」
// ---------------------------------------------------------------------------

test('servicePlan：Linux 的 status / restart / logs 走 systemctl 与 journalctl，且都是只读/用户级（workspace）', () => {
  const status = servicePlan('status', linux(), {});
  assert.deepEqual(status.map((item) => item.id), ['systemd-status', 'systemd-journal']);
  for (const item of status) {
    assert.equal(item.requires, 'workspace');
    assert.ok(item.command.includes('--user'), `${item.id} 必须是用户级命令，不能要 sudo`);
  }
  const restart = servicePlan('restart', linux(), {});
  assert.match(restart[0].command, /systemctl --user restart qqbot$/);
  assert.equal(restart[0].requires, 'workspace', '重启当前用户的 unit 是这条命令存在的意义');
  assert.equal(servicePlan('logs', linux(), { logLines: 40 })[0].command.includes(' -n 40'), true);
});

test('servicePlan：Linux install 里所有 cwd 外的写都是 human，脚本不代劳', () => {
  const steps = servicePlan('install', linux(), { repoRoot: '/srv/qqbot', cwd: '/srv/qqbot' });
  const byId = Object.fromEntries(steps.map((item) => [item.id, item]));
  for (const id of ['write-unit', 'systemd-enable', 'systemd-linger', 'install-profile', 'napcat-config']) {
    assert.ok(byId[id], `缺步骤 ${id}`);
    assert.equal(byId[id].requires, 'human', `${id} 写的是 cwd 外，必须人来做`);
  }
  assert.equal(byId['write-unit'].command.includes('/srv/qqbot/deploy/qqbot.service'), true);
  assert.equal(byId.verify.requires, 'workspace', '体检是只读的，脚本可以自己跑');
});

test('servicePlan：没有 systemd 的 Linux（WSL 第一版）只给前台跑法，不假装能管服务', () => {
  const platform = linux({ hasSystemctl: false });
  const restart = servicePlan('restart', platform, {});
  assert.equal(restart.length, 1);
  assert.equal(restart[0].requires, 'human');
  assert.ok(restart[0].note.includes('dsh --profile'), '要给出真能跑的那条前台命令');
  const install = servicePlan('install', platform, {});
  assert.equal(install[0].id, 'no-systemd-install');
  assert.equal(install.some((item) => item.id === 'systemd-enable'), false, '不能假装 enable 得动');
});

test('servicePlan：Windows 的 status 用 schtasks 查询（只读），日志指向文件', () => {
  const steps = servicePlan('status', windows(), { napcatDir: 'C:\\NapCat.Shell', logFile: 'C:\\NapCat.Shell\\logs\\a.log' });
  assert.equal(steps[0].id, 'schtasks-query');
  assert.equal(steps[0].requires, 'workspace');
  assert.match(steps[0].command, /schtasks\.exe \/Query \/TN dsh-qq-bridge-napcat/);
  assert.equal(steps[1].requires, 'workspace', '读日志是只读的');
  assert.ok(steps[1].command.includes('a.log'));
});

test('servicePlan：Windows 的 restart 承认「桌面版重启不了」，那条必须是 human', () => {
  const steps = servicePlan('restart', windows(), {});
  const desktop = steps.find((item) => item.id === 'restart-desktop-app');
  assert.ok(desktop, '必须有一条「请重启桌面版」');
  assert.equal(desktop.requires, 'human');
  assert.match(desktop.note, /请重启桌面版/);
  assert.equal(desktop.command, '', '不 pretend：没有能复制去「重启 Electron」的命令');
  // NapCat 那个计划任务可以单独重启，但同样是 cwd 外的动作。
  assert.equal(steps[0].requires, 'human');
  assert.match(steps[0].command, /schtasks\.exe \/End .*schtasks\.exe \/Run/);
});

test('servicePlan：Windows install 注册计划任务要提权（root），并复用 napcat.js 的计划', () => {
  const steps = servicePlan('install', windows(), { napcatDir: 'C:\\NapCat.Shell', profileName: 'desktop' });
  const byId = Object.fromEntries(steps.map((item) => [item.id, item]));
  assert.equal(byId['register-autostart'].requires, 'root');
  // napcat.js 的计划走的是 powershell 的 -EncodedCommand（提权 + 免引号转义）。
  assert.match(byId['register-autostart'].command, /powershell\.exe .*-EncodedCommand/);
  assert.equal(byId['write-autostart-files'].requires, 'human');
  assert.ok(byId['write-autostart-files'].note.includes(HIDDEN_WRAPPER_NAME));
  assert.ok(byId['write-autostart-files'].note.includes(TASK_XML_NAME));
  assert.match(byId['install-profile'].command, /--profile desktop/);
});

test('servicePlan：容器模式在平台计划后附加 docker 步骤，而不是替换掉 bot 自己的管理方式', () => {
  // 容器里的只是 NapCat；bot（DSH 进程）仍然由 systemd 管 —— 所以两种步骤都要在。
  const withSystemd = linux({ container: true });
  const restart = servicePlan('restart', withSystemd, {});
  assert.deepEqual(restart.map((item) => item.id), ['systemd-restart', 'systemd-is-active', 'docker-restart']);
  const dockerRestart = restart.find((item) => item.id === 'docker-restart');
  assert.equal(dockerRestart.command, 'docker restart napcat');
  assert.equal(dockerRestart.requires, 'human');
  assert.equal(dockerRestart.optional, true, '重启 NapCat 本身不是「重启 bot」的必需项');
  assert.equal(dockerRestart.note.includes('root'), true, '说明为什么脚本不代跑');
  // 没有 systemd 的机器上，附加的仍然是 docker 那几条。
  const bare = servicePlan('status', container(), { containerName: 'napcat' });
  assert.deepEqual(bare.map((item) => item.id), ['no-systemd', 'docker-ps', 'docker-logs']);
  for (const item of bare.filter((one) => one.id.startsWith('docker-'))) {
    assert.equal(item.requires, 'workspace', '读状态是只读的');
  }
  const logs = servicePlan('logs', container(), { logLines: 7 });
  assert.equal(logs.find((item) => item.id === 'docker-logs').command, 'docker logs --tail 7 napcat');
});

test('servicePlan：容器 install 的 docker run 端口必须与 endpoint 一致', () => {
  const steps = servicePlan('install', container(), { endpoint: 'ws://127.0.0.1:4001' });
  const run = steps.find((item) => item.id === 'container-run');
  assert.ok(run.command.includes('-p 4001:4001'), run.command);
  assert.equal(run.requires, 'human');
  assert.ok(run.command.includes(DEFAULT_CONTAINER));
});

test('servicePlan：autostart 在三种平台上分别是 enable / 计划任务 / 重启策略', () => {
  const linuxAuto = servicePlan('autostart', linux(), {});
  assert.ok(linuxAuto.some((item) => item.command.includes('systemctl --user enable')));
  assert.equal(linuxAuto.every((item) => item.requires !== 'root'), true, '用户级 unit 不该要 root');
  // linger 是可选项：不做也正常，不能把退出码钉在 2 上。
  assert.equal(linuxAuto.find((item) => item.id === 'systemd-linger').optional, true);
  const windowsAuto = servicePlan('autostart', windows(), { napcatDir: 'C:\\NapCat.Shell' });
  assert.equal(windowsAuto[0].requires, 'root');
  const containerAuto = servicePlan('autostart', container(), {});
  const policy = containerAuto.find((item) => item.id === 'docker-restart-policy');
  assert.equal(policy.command, 'docker update --restart=always napcat');
});

test('servicePlan：不认识的动作用一条说明性步骤收场，不抛错', () => {
  const steps = servicePlan('teleport', linux(), {});
  assert.equal(steps.length, 1);
  assert.equal(steps[0].id, 'unknown-action');
  assert.ok(steps[0].note.includes('teleport'));
  // 所有声明的动作在三种平台上都得有产出（selftest 也这么断言）。
  for (const shape of [linux(), windows(), container()]) {
    for (const action of OPS_ACTIONS) {
      assert.ok(servicePlan(action, shape, {}).length > 0, `${shape.os}/${action} 没有步骤`);
    }
  }
});

// ---------------------------------------------------------------------------
// installPlan：幂等 + 不越权
// ---------------------------------------------------------------------------

test('installPlan：doneStepIds 里已有的步骤回来是 skipped（重复执行不重复写）', () => {
  const steps = installPlan(linux(), {
    cwd: '/srv/qqbot',
    repoRoot: '/srv/qqbot',
    doneStepIds: ['ensure-data-dir', 'write-unit'],
  });
  const byId = Object.fromEntries(steps.map((item) => [item.id, item]));
  assert.equal(byId['ensure-data-dir'].status, 'skipped');
  assert.equal(byId['write-unit'].status, 'skipped');
  assert.match(byId['write-unit'].note, /已经做过了/);
  assert.equal(byId['systemd-enable'].status, 'planned', '没做过的仍然是 planned');
  // 已经跳过的步骤仍然保留命令：用户想手工确认时还要看得到它。
  assert.ok(byId['write-unit'].command.length > 0);
});

test('installPlan：无论哪个平台，cwd 外的写都标 human / root（--apply 默认关的地基）', () => {
  for (const shape of [linux(), windows(), container()]) {
    const steps = installPlan(shape, { cwd: shape.cwd, repoRoot: shape.cwd, napcatDir: shape.os === 'win32' ? 'C:\\NapCat.Shell' : '', doneStepIds: [] });
    for (const item of steps) {
      if (SCRIPT_OWN_IDS.has(item.id)) {
        assert.equal(item.requires, 'workspace', `${shape.os}/${item.id} 是 cwd 内的准备动作`);
      } else {
        assert.ok(
          item.requires === 'human' || item.requires === 'root',
          `${shape.os}/${item.id} 写的是 cwd 外，却标成了 ${item.requires}`,
        );
      }
    }
  }
});

test('installPlan：同一份计划里 id 不重复（幂等的前提）', () => {
  for (const shape of [linux(), windows(), container()]) {
    const ids = installPlan(shape, { cwd: shape.cwd, repoRoot: shape.cwd, doneStepIds: [] }).map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length, `${shape.os} 的计划里有重复 id：${ids.join(',')}`);
  }
});

test('installPlan：每个步骤都有 id / status / requires / command / note', () => {
  for (const shape of [linux(), windows(), container()]) {
    for (const item of installPlan(shape, { cwd: shape.cwd, repoRoot: shape.cwd, doneStepIds: [] })) {
      assert.equal(typeof item.id, 'string');
      assert.ok(['planned', 'skipped'].includes(item.status));
      assert.ok(REQUIREMENTS.includes(item.requires));
      assert.equal(typeof item.command, 'string');
      assert.equal(typeof item.note, 'string');
      assert.ok(item.command.length > 0 || item.note.length > 0, `${item.id} 既没命令也没说明`);
    }
  }
});

test('installPlan：cwd 内的准备工作真的指向 cwd（不是别处的 data/）', () => {
  const steps = installPlan(linux(), { cwd: '/srv/qqbot', repoRoot: '/srv/qqbot', doneStepIds: [] });
  const data = steps.find((item) => item.id === 'ensure-data-dir');
  assert.ok(data.command.includes('/srv/qqbot/data'), data.command);
  const env = steps.find((item) => item.id === 'ensure-env-example');
  assert.equal(env.requires, 'workspace');
});

// ---------------------------------------------------------------------------
// exitCodeFor：§10.3 的退出码
// ---------------------------------------------------------------------------

test('exitCodeFor：0 全部通过、1 有 error、2 需要人、3 脚本自身出错', () => {
  assert.equal(exitCodeFor({}), 0);
  assert.equal(exitCodeFor({ findings: [] }), 0);
  assert.equal(exitCodeFor({ findings: [{ level: 'warn' }, { level: 'info' }] }), 0);
  assert.equal(exitCodeFor({ findings: [{ level: 'error' }] }), 1);
  assert.equal(exitCodeFor({ findings: [{ level: 'warn', requires: 'human' }] }), 2);
  assert.equal(exitCodeFor({ steps: [{ requires: 'root', status: 'planned' }] }), 2);
  assert.equal(exitCodeFor({ steps: [{ requires: 'human', status: 'planned' }] }), 2);
  assert.equal(exitCodeFor({ error: '模块契约不对' }), 3);
});

test('exitCodeFor：优先级是 3 → 1 → 2 → 0', () => {
  // 脚本自己坏了：诊断结论不可信，先报 3。
  assert.equal(exitCodeFor({ error: 'boom', findings: [{ level: 'error' }] }), 3);
  // 有错误：比「需要人动手」更该先被看见。
  assert.equal(exitCodeFor({ findings: [{ level: 'error', requires: 'human' }], steps: [{ requires: 'root', status: 'planned' }] }), 1);
});

test('exitCodeFor：已经做完 / 跳过 / 可选的步骤不再算「等你动手」', () => {
  assert.equal(exitCodeFor({ steps: [{ requires: 'human', status: 'done' }] }), 0);
  assert.equal(exitCodeFor({ steps: [{ requires: 'root', status: 'skipped' }] }), 0);
  // 只读（workspace）的步骤留在 planned 也不影响退出码。
  assert.equal(exitCodeFor({ steps: [{ requires: 'workspace', status: 'planned' }] }), 0);
  // 可选项没做是正常的（linger / 重启 NapCat 容器）。
  assert.equal(exitCodeFor({ steps: [{ requires: 'human', status: 'planned', optional: true }] }), 0);
  assert.equal(exitCodeFor({ steps: [{ requires: 'human', status: 'planned', optional: false }] }), 2);
});

test('renderPlan：把 napcat.js 的 { command, args } 渲染成一行，不可执行时给空串', () => {
  assert.equal(renderPlan({ command: 'schtasks.exe', args: ['/Query', '/TN', TASK_NAME] }), `schtasks.exe /Query /TN ${TASK_NAME}`);
  assert.equal(renderPlan({ command: 'powershell.exe', args: ['-NoProfile', '-Command', 'Get-Content x'] }), 'powershell.exe -NoProfile -Command "Get-Content x"');
  assert.equal(renderPlan({ unsupported: '平台不对' }), '');
  assert.equal(renderPlan(undefined), '');
});

test('协议常量：schema 是 1、动作清单与 requires 取值都没漂', () => {
  assert.equal(OPS_SCHEMA, 1, 'agent 只认自己认识的版本号，改协议必须加它');
  assert.deepEqual(OPS_ACTIONS, ['status', 'restart', 'logs', 'install', 'uninstall', 'autostart']);
  assert.deepEqual(REQUIREMENTS, ['workspace', 'human', 'root']);
  assert.equal(DEFAULT_UNIT, 'qqbot');
  assert.equal(DEFAULT_CONTAINER, 'napcat');
});
