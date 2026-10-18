/**
 * 插件的**浏览器半侧**：DSH 设置面板里自己的一页「QQ Bridge」。
 *
 * 为什么是一个手写的 `window.__ModuleLoader__.load({...})` 而不是源码：DSH 的客户端
 * 模块系统只提供**已构建**的 bundle（`dsh-client-modules` 读 package.json 的
 * `dsh.client` + `exports["./client"]`，把这份文件当浏览器 bundle 发给页面）。本仓库
 * 没有构建步骤，所以这里直接手写编译后的形状 —— 与官方那些 `lib/client.js` 同构：
 * 工厂函数里 require 平台模块表里的东西（react / react/jsx-runtime /
 * dsh-client-ui-primitives）。
 *
 * 两件事是分开的，别混：
 *
 *   1. **页面在哪里**：注册在 `settings.section`（侧栏「设置」左边那一列里的一页）。
 *      这是**有意**的偏差：一百多项配置埋进「设置 → 插件」的 tab 里会被彻底忽略，
 *      所以本插件保留顶级入口（这是刻意的取舍，不挂到「设置 → 插件」下）。
 *   2. **页面长什么样**：这一页**不写死任何字段**，可编辑字段来自 Host 送过来的那份
 *      schema（`config.js` 的 Config 是根 volatile，`dsh-settings` 的 `volatileForm`
 *      把整份配置投影成表单 schema），标签与说明也来自 schema 上的 `.description()`。
 *      于是「加一个配置项」只需要改 `config.js` 一处 —— 设置页自动多出一行。
 *
 * 版式（定稿）：**7 个下划线 tab + 单列扁平区块 +
 * 官方两种字段行**，不再有折叠卡片墙。`TABS` 负责分组（字段 → 分组见 `SECTIONS`），
 * `FIELD_HINTS` 给数字补只读量纲（`= 45 分钟`），`ENUM_LABELS` 给枚举取值配人话。
 * 布尔是 `Switch`（官方开关行），枚举是原生 `<select>`（Input 外观），其余是输入框 /
 * 多行框 / 带 Pill 预览的列表。搜索按「标签 / 字段名 / 描述 / 区块标题」跨 tab 命中。
 *
 * 保存走 Host 的 settings 写路径（`configForms` → `settings/mutate` → profile patch），
 * 写进去的是**完整配置**，`!!js` 表达式原样保留。写完之后 Loader 只做 volatile 热更新，
 * 所以 `index.js` 那边收到 `loader/volatile-update` 会重启一次插件来重建装配。
 *
 * @module @qqbot/dsh-plugin-qq/client
 */

window.__ModuleLoader__.load({
  id: '@qqbot/dsh-plugin-qq',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const { jsx, jsxs } = require('react/jsx-runtime');
    const P = require('@deepseek-ai/dsh-client-ui-primitives');

    const useState = React.useState;
    const useEffect = React.useEffect;

    /** 本页文案的字典命名空间（`ctx.locale.register` 的那把钥匙）。 */
    const NS = 'settings.qq';
    /**
     * 设置命名空间 = **profile 条目 id**。DSH 的配置表单按 Loader 条目 id 认插件，
     * 而本组合包的 patch（cordis.patch.yml）里那一行的 id 就是 `qq-bridge`。
     */
    const ENTRY = 'qq-bridge';
    /** 设置面板里的那一页。 */
    const SECTION = 'settings.section';
    /** 字段控件的 id 前缀（label 的 `htmlFor` 与 `aria-describedby` 都靠它）。 */
    const FIELD_ID_PREFIX = 'qq-config-';
    /** tab 与 tabpanel 的 id：roving tabindex 的 `aria-controls` 要指得准。 */
    const TAB_ID_PREFIX = 'qq-tab-';
    const TAB_PANEL_ID_PREFIX = 'qq-tabpanel-';
    /**
     * 「已记录的定时任务」的只读接口。
     *
     * 路径必须与 `reminders.js` 的 `REMINDER_ROUTE_PATH` 一致：这份文件是浏览器
     * bundle，不能 import 主机模块，所以只能各写一份 —— `test/client.test.mjs`
     * 断言两处相等（漏改一边会红）。它是 Connection 认证栅栏内的 exact Fetch route。
     */
    const REMINDER_TASKS_PATH = '/api/qq-bridge/reminders';
    /** 页面开着时多久重读一次任务（建/取消任务发生在 QQ 那一侧，不会推事件过来）。 */
    const REMINDER_REFRESH_MS = 15000;

    // ---- 样式 ------------------------------------------------------------------
    //
    // 为什么打一个 <style> 而不是全部内联：内联样式表达不了 `:focus-visible`、`:hover`、
    // `prefers-reduced-motion`，也没法写 `details[open]` 那种父状态选择器。官方插件
    // 的做法就是在 factory 里塞一次 <style>（`data-plugin-css` 去重），这里照抄 ——
    // 仍然不引任何外部样式表，颜色一律走 `--dsw-*` token。
    //
    // 几何值抄的是官方设置页（docs 附录 A）：开关注行 16px 内边距 / 14-20 字号，
    // 表单行 12px 内边距 / 13-500 标签 / 34px 控件 / 12px hint，分隔线 0.5px border-l2。
    const STYLE_TAG = '@qqbot/dsh-plugin-qq/settings.css';
    const STYLES = `
.qq-page{max-width:720px;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary)}
.qq-title{margin:0 0 6px;font-size:16px;font-weight:500;line-height:24px}
.qq-intro{margin:0 0 4px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.qq-notice{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}
.qq-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px}
.qq-search{flex:1 1 200px;min-width:0;max-width:320px}
.qq-toolbarGap{flex:1 1 auto}
.qq-onlyChanged:disabled{opacity:.5;cursor:default}
.qq-tabs{display:flex;align-items:flex-end;gap:22px;margin-top:12px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.qq-tab{position:relative;padding:7px 1px 9px;border:0;background:none;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.qq-tab:hover{color:var(--dsw-alias-label-primary)}
.qq-tab[data-active='true']{color:var(--dsw-alias-label-primary)}
.qq-tab[data-active='true']::after{content:'';position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-label-primary)}
.qq-tab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:2px}
.qq-panel{display:flex;flex-direction:column;gap:12px;padding-top:12px;min-width:0}
.qq-section{display:flex;flex-direction:column;min-width:0}
.qq-sectionTitle{margin:0;font-size:15px;font-weight:600;line-height:22px}
.qq-sectionNote{margin:2px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}
.qq-subTitle{margin:12px 0 0;font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary)}
.qq-field{display:flex;flex-direction:column;gap:6px;padding:12px 0;min-width:0}
.qq-field[data-divided='true']{border-top:.5px solid var(--dsw-alias-border-l2)}
.qq-field[data-layout='inline']{flex-direction:row;align-items:flex-start;justify-content:space-between;gap:24px;padding:16px 0}
.qq-fieldMain{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:0}
.qq-fieldHead{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.qq-fieldLabelGroup{display:flex;align-items:center;gap:4px;flex:0 1 auto;min-width:0}
.qq-fieldLabel{flex:0 1 auto;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.qq-field[data-layout='inline'] .qq-fieldLabel{font-size:14px;font-weight:400;line-height:20px}
.qq-fieldBadges{display:inline-flex;align-items:center;gap:8px;margin-left:auto;flex:none}
.qq-helpButton{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.qq-helpButton:hover,.qq-helpButton[aria-expanded='true']{background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-secondary)}
.qq-helpButton:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.qq-reset{border:0;background:none;padding:0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}
.qq-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.qq-reset:disabled{cursor:default}
.qq-control{display:flex;flex-direction:column;gap:6px;min-width:0;flex:none}
.qq-field[data-layout='stack'] .qq-control{flex:1 1 auto}
.qq-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.qq-invalid{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}
.qq-help{padding:10px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.qq-help p{margin:0}
.qq-help p+p{margin-top:8px}
.qq-input{box-sizing:border-box;width:100%;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.qq-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.qq-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.qq-input[aria-invalid='true']{border-color:var(--dsw-alias-state-error-primary)}
.qq-select{appearance:none;cursor:pointer;padding-right:32px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-position:right 12px center;background-repeat:no-repeat;background-size:12px 12px}
.qq-textarea{box-sizing:border-box;width:100%;padding:8px 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary);resize:vertical}
.qq-textarea:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.qq-textarea[aria-invalid='true']{border-color:var(--dsw-alias-state-error-primary)}
.qq-pills{display:flex;flex-wrap:wrap;gap:6px}
.qq-pills button:disabled{opacity:.5;cursor:default}
.qq-disclosure{margin-top:12px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:10px}
.qq-summary{display:flex;align-items:center;gap:6px;width:fit-content;margin-left:-4px;padding:2px 4px;border-radius:var(--dsw-radius-sm);font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary);list-style:none;cursor:pointer}
.qq-summary::-webkit-details-marker{display:none}
.qq-summary:hover{color:var(--dsw-alias-label-primary)}
.qq-summary:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.qq-chevron{flex:none;width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .12s ease}
.qq-disclosure[open] > .qq-summary .qq-chevron{transform:rotate(45deg)}
.qq-disclosureBody{display:flex;flex-direction:column;padding-top:2px}
.qq-empty{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.qq-tasksToolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:8px}
.qq-tasksCount{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.qq-taskList{display:flex;flex-direction:column;margin:8px 0 0;padding:0;list-style:none}
.qq-task{display:flex;flex-direction:column;gap:4px;padding:10px 0;border-top:.5px solid var(--dsw-alias-border-l2);min-width:0}
.qq-task:first-child{border-top:0}
.qq-taskHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.qq-taskTime{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.qq-taskTags{display:inline-flex;align-items:center;gap:6px;margin-left:auto;flex:none}
.qq-taskText{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.qq-taskMeta{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
@media (prefers-reduced-motion: reduce){.qq-chevron{transition:none}}
`;

    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG)}]`) === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = '@qqbot/dsh-plugin-qq';
      tag.dataset.pluginCss = STYLE_TAG;
      tag.textContent = STYLES;
      document.head.appendChild(tag);
    }

    // ---- 文案 ------------------------------------------------------------------

    const zh = {
      navTitle: 'QQ Bridge',
      title: 'QQ Bridge',
      intro: 'QQ 桥接的全部配置，按用途分页；改完在底部一次保存。',
      notice: '保存会写进当前 profile 的 cordis.patch.yml，随后插件重启一次；环境变量（QQBOT_*）的取值会以表达式保留。',
      searchPlaceholder: '搜索配置项…',
      searchEmpty: '没有匹配的配置项。可以搜字段名（如 proactiveChance）或描述里的词。',
      changedCount: '已改 {count} 项',
      onlyChanged: '只看已改',
      invalidCount: '{count} 项待修正',
      tabsLabel: '配置分类',
      sectionOf: '属于「{tab}」',
      defaultOption: '用默认值',
      compatPersona: '兼容：旧 persona（文件存在时不生效）',
      personaNote:
        '人设优先读 cwd 里的 .qq-persona/PERSONA.md：那个文件存在且能解析时，「旧人设」这一项不再生效（启动日志里会写明人设来自文件还是配置）。',
      expressionNote:
        '「怎么说」的散文部分来自 cwd 里的 .qq-persona/STYLE.md（没有就用内置那份）；下面的气泡 / 标点 / 补一句是引擎参数，始终生效，和文件叠加。',
      helpLabel: '字段说明',
      keyLabel: '配置项',
      acceptLabel: '可填的值',
      overridden: '已覆盖',
      reset: '恢复默认',
      invalidNumber: '请填数字；留空表示使用默认值',
      invalidBoolean: '请选 true 或 false；留空表示使用默认值',
      invalidChoice: '请选上面列出的某个值；留空表示使用默认值',
      invalidList: '多个值用逗号（中英文都行）或换行分隔；留空表示清空',
      invalidText: '请填文本；留空表示使用默认值',
      hintList: '多个值用逗号分隔；留空 = 清空',
      unavailable: '该插件当前未加载，暂时无法配置。',
      readOnly: '本部署的设置为只读。',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      save: '保存',
      saving: '保存中…',
      remindersTitle: '已记录的定时任务',
      remindersNote:
        '来自提醒任务文件，每 {seconds} 秒自动刷新一次；这一块只读，建任务 / 取消任务都在 QQ 里说一声。',
      remindersRefresh: '刷新',
      remindersLoading: '正在读取任务…',
      remindersEmpty: '还没有记录任何定时任务。在 QQ 里说「明早 8 点提醒我」就会出现在这里。',
      remindersDisabled: '定时提醒已关闭（reminder），或提醒任务文件不可用。',
      remindersFailed: '读取任务失败：{message}',
      remindersCount: '待发 {pending} 条 · 共 {total} 条',
      remindersTargetGroup: '群 {id}',
      remindersTargetPrivate: '私聊 {id}',
      remindersMentions: '提醒 {names}',
      remindersCreatedBy: '{name} 建的',
      remindersFired: '已发 {count} 次',
      remindersPromptPrefix: '指令：',
      remindersErrorLabel: '上次错误：{message}',
      remindersStatusActive: '待发送',
      remindersStatusFiring: '发送中',
      remindersStatusDone: '已发送',
      remindersStatusMissed: '已错过',
      remindersStatusFailed: '失败',
      remindersStatusCancelled: '已取消',
      remindersStatusUnknown: '未知状态',
      remindersModeText: '固定文案',
      remindersModeAgent: 'Agent 组织',
      remindersModePrompt: 'Agent 执行',
    };
    const en = {
      navTitle: 'QQ Bridge',
      title: 'QQ Bridge',
      intro: 'Every QQ bridge setting, grouped by purpose; save once at the bottom.',
      notice: 'Saving writes this profile’s cordis.patch.yml and restarts the plugin once; values that come from QQBOT_* stay as expressions.',
      searchPlaceholder: 'Search settings…',
      searchEmpty: 'No matching settings. Try a field name (e.g. proactiveChance) or a word from its description.',
      changedCount: '{count} changed',
      onlyChanged: 'Changed only',
      invalidCount: '{count} to fix',
      tabsLabel: 'Setting groups',
      sectionOf: 'In “{tab}”',
      defaultOption: 'Use default',
      compatPersona: 'Legacy persona (ignored while the file exists)',
      personaNote:
        'Persona is read from .qq-persona/PERSONA.md in the cwd first: when that file exists and parses, the legacy persona below is ignored (the startup log says which source won).',
      expressionNote:
        'The prose half of “how it talks” comes from .qq-persona/STYLE.md in the cwd (built-in contract when missing); the bubble / punctuation / afterthought fields below are engine parameters that always apply on top.',
      helpLabel: 'Field help',
      keyLabel: 'Config key',
      acceptLabel: 'Accepted values',
      overridden: 'Overridden',
      reset: 'Reset to default',
      invalidNumber: 'Enter a number, or leave blank to use the default.',
      invalidBoolean: 'Choose true or false, or leave blank to use the default.',
      invalidChoice: 'Choose one of the values listed below, or leave blank to use the default.',
      invalidList: 'Separate values with commas (either kind) or newlines; leave blank to clear.',
      invalidText: 'Enter text, or leave blank to use the default.',
      hintList: 'comma-separated; blank clears',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      readOnly: 'This deployment stores settings read-only.',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      save: 'Save',
      saving: 'Saving…',
      remindersTitle: 'Scheduled reminders',
      remindersNote:
        'Read from the reminder task file and refreshed every {seconds} seconds. This block is read-only; create or cancel tasks by talking to the bot in QQ.',
      remindersRefresh: 'Refresh',
      remindersLoading: 'Loading tasks…',
      remindersEmpty: 'No reminders yet. Ask the bot in QQ (“remind me at 8 tomorrow”) and it will show up here.',
      remindersDisabled: 'Scheduled reminders are disabled (reminder), or the task file is unavailable.',
      remindersFailed: 'Could not load tasks: {message}',
      remindersCount: '{pending} pending · {total} total',
      remindersTargetGroup: 'Group {id}',
      remindersTargetPrivate: 'DM {id}',
      remindersMentions: 'reminds {names}',
      remindersCreatedBy: 'by {name}',
      remindersFired: 'sent {count}×',
      remindersPromptPrefix: 'Prompt: ',
      remindersErrorLabel: 'Last error: {message}',
      remindersStatusActive: 'Pending',
      remindersStatusFiring: 'Sending',
      remindersStatusDone: 'Sent',
      remindersStatusMissed: 'Missed',
      remindersStatusFailed: 'Failed',
      remindersStatusCancelled: 'Cancelled',
      remindersStatusUnknown: 'Unknown',
      remindersModeText: 'Verbatim',
      remindersModeAgent: 'Agent phrasing',
      remindersModePrompt: 'Agent task',
    };

    // ---- 分组、tab 与标签 -------------------------------------------------------
    //
    // 分组只能由这里给出（schema 里没有「这一项属于哪一段」这种元数据），按字段名
    // 的显式清单 + 前缀来分；认不出来的落进「其它」—— test/client.test.mjs 会钉住
    // 「当前没有字段落进其它」，将来加了配置项又忘了分组时它就会红。
    //
    // `fields` 的顺序就是渲染顺序（这是设计的一部分：人设页把「文件优先」的三个参数
    // 摆在已失效的旧 `persona` 前面）。前缀组沿用 schema 顺序。
    // `subs` 只是组内小标题（表达页的 标点 / 私聊），不参与归属判断。

    const SECTIONS = [
      {
        id: 'connection',
        title: '连接与运行环境',
        fields: ['endpoint', 'accessToken', 'cwd', 'napcatDir', 'napcatAutoConfig'],
      },
      {
        id: 'admission',
        title: '准入与触发',
        fields: ['privateChat', 'groupChat', 'groupTrigger', 'prefix', 'blankReply', 'allowUsers', 'allowGroups'],
      },
      {
        id: 'agent',
        title: 'QQ 会话与 Agent',
        fields: [
          'provider',
          'model',
          'approvalPolicy',
          'agentPreset',
          'allowTools',
          'resetCommand',
          'resetUsers',
          'maxReplyChars',
        ],
      },
      // 人设与额外要求单独一段：它们是一整段提示词（内置人设本身就有十来行），
      // 混在「QQ 会话与 Agent」那堆开关里既难找、也只能挤在一行输入框里改。
      // 旧 `persona` 排在文件参数后面并折进「兼容」（DISCLOSURES）：文件优先是重构后的
      // 语义，把已经失效的那一项摆到最显眼的位置，等于鼓励用户去改一个不会再被读到的
      // 字段。
      {
        id: 'persona',
        title: '人格与提示词（PERSONA.md 优先）',
        note: 'personaNote',
        fields: ['personaFile', 'personaMaxChars', 'personaSceneOverlays', 'persona', 'instructions'],
      },
      {
        id: 'expression',
        title: '表达（STYLE.md / 气泡 / 标点 / 补一句）',
        note: 'expressionNote',
        fields: [
          'styleFile',
          'styleMaxChars',
          'stripShortPeriod',
          'shortPeriodMaxChars',
          'privateAfterthought',
          'privateAfterthoughtChance',
          'privateAfterthoughtIdleMs',
          'privateAfterthoughtDailyMax',
        ],
        // 散文（文件路径）在上，机器参数按「标点 / 私聊」分段：
        // 这两组开关语义不同，摊成一串会看不出谁管谁。气泡条数不在这里（由模型按 STYLE.md 决定）。
        subs: [
          { title: '标点', fields: ['stripShortPeriod', 'shortPeriodMaxChars'] },
          {
            title: '私聊',
            fields: [
              'privateAfterthought',
              'privateAfterthoughtChance',
              'privateAfterthoughtIdleMs',
              'privateAfterthoughtDailyMax',
            ],
          },
        ],
      },
      {
        id: 'media',
        title: '图片与表情包',
        fields: [
          'mediaDownload',
          'mediaDir',
          'mediaMaxBytes',
          'mediaCacheFiles',
          'mediaTimeoutMs',
          'quoteMedia',
          'ambientMedia',
          'imageSend',
          'stickerDir',
          'imageMaxBytes',
          'stickerMaxFiles',
        ],
      },
      {
        id: 'batch',
        title: '攒批与群聊上下文',
        fields: [
          'batchWindowMs',
          'batchMaxWaitMs',
          'batchBacklog',
          'batchBacklogEntries',
          'batchBacklogChars',
          'batchBacklogHoldMs',
          'ambientMessages',
          'ambientLineChars',
        ],
      },
      { id: 'repeat', title: '自动复读', prefix: ['repeat'] },
      { id: 'proactive', title: '主动说话（冷场时自己冒个泡）', prefix: ['proactive'] },
      { id: 'active', title: '活跃对话（聊起来之后保持搭话）', prefix: ['active'] },
      { id: 'reminder', title: '定时提醒（到点自己开口）', prefix: ['reminder'] },
      {
        id: 'perception',
        title: '感知与互动（链接 / 视频 / 戳一戳 / 撤回）',
        fields: [
          'linkPreview',
          'linkPreviewTimeoutMs',
          'linkPreviewMaxBytes',
          'linkAllowPrivateHosts',
          'videoCover',
          'videoMaxBytes',
          'pokeReply',
          'pokeMode',
          'pokeReplyChance',
          'pokeCooldownMs',
          'pokeDailyMax',
          'recallMode',
          'recallAddressed',
          'recallScope',
          'recallChance',
          'recallCooldownMs',
          'recallDailyMax',
          'recallMaxAgeMs',
          'recallTeaseQuote',
          'recallPrivate',
          'recallMemoryMark',
        ],
        // 这两组管的是「群友做了个动作，它要不要有反应」，与上面那几个「怎么看待一条
        // 消息」的开关语义不同，摊成一串会看不出谁管谁。
        subs: [
          { title: '戳一戳', fields: ['pokeReply', 'pokeMode', 'pokeReplyChance', 'pokeCooldownMs', 'pokeDailyMax'] },
          {
            title: '撤回',
            fields: [
              'recallMode',
              'recallAddressed',
              'recallScope',
              'recallChance',
              'recallCooldownMs',
              'recallDailyMax',
              'recallMaxAgeMs',
              'recallTeaseQuote',
              'recallPrivate',
              'recallMemoryMark',
            ],
          },
        ],
      },
      {
        id: 'style',
        title: '说话方式与节奏',
        fields: [
          'humanize',
          'burstMaxChars',
          'burstMaxParts',
          'burstMaxMessages',
          'burstSingleMaxChars',
          'readDelayMs',
          'charsPerSecond',
          'minDelayMs',
          'maxDelayMs',
          'delayJitter',
          'replyStyle',
        ],
      },
      { id: 'memory', title: '长期记忆（转录 / 摘要 / 认知库）', prefix: ['memory', 'digest'] },
      { id: 'apikey', title: '模型凭据轮换', prefix: ['apiKey'] },
    ];
    const OTHER_SECTION = { id: 'other', title: '其它' };

    /**
     * 7 个 tab：`sections` 是 SECTIONS 的 id，顺序即页面顺序。
     *
     * 为什么映射写死在这里而不是从 schema 推：schema 只说「有哪些配置」，不知道
     * 「这一堆该按什么顺序读」；tab 是阅读顺序，是界面的事。
     *
     * 「提醒」单独一页：它同时服务群聊与私聊，塞进「群聊」既分类错误、又会被压在
     * 一长串群聊配置后面。任务列表放在这一页的最上面（见下面的 panelSections）。
     */
    const TABS = [
      { id: 'connect', label: '连接', title: '连接与准入', sections: ['connection', 'admission'] },
      { id: 'session', label: '会话', title: '会话与节奏', sections: ['agent', 'batch', 'style'] },
      { id: 'persona', label: '人格', title: '人格与表达', sections: ['persona', 'expression'] },
      { id: 'group', label: '群聊', title: '群聊互动', sections: ['repeat', 'proactive', 'active'] },
      { id: 'reminder', label: '提醒', title: '定时提醒', sections: ['reminder'] },
      { id: 'perception', label: '感知', title: '感知与媒体', sections: ['media', 'perception'] },
      { id: 'memory', label: '记忆', title: '记忆与运维', sections: ['memory', 'apikey'] },
    ];

    /** 仅此一处折叠：旧 `persona` 在文件存在时本来就不生效，折起来省版面。 */
    const DISCLOSURES = {
      persona: { summary: 'compatPersona', fields: ['persona'] },
    };

    /**
     * 少数几个字段的短标签：信息足够时标签直接从 `.description()` 的第一段取
     * （见 `deriveLabel`），这里只覆盖那些取出来读不通的。想永久改掉一个标签，
     * 在 `config.js` 的字段上加 `.comment('…')` 更合适 —— schema 上的 comment
     * 优先级比这份表还高（`labelOf`）。
     */
    const LABEL_OVERRIDES = {
      quoteMedia: '被引用的消息也一起看',
      endpoint: 'OneBot WebSocket 地址',
      imageSend: '让 Agent 主动发图',
      napcatAutoConfig: '自动补 NapCat 配置',
      prefix: '前缀触发用的前缀',
      agentPreset: 'QQ 会话的 Agent 预设',
      resetUsers: '谁能新开一轮会话',
      allowTools: 'QQ 会话的工具白名单',
      persona: '旧人设（PERSONA.md 不存在时用）',
      personaFile: '人设文件（优先）',
      personaSceneOverlays: '按场景叠加人设四段',
      styleFile: '表达规则文件（优先）',
      stripShortPeriod: '短气泡剥句末句号',
      shortPeriodMaxChars: '短气泡字数门槛',
      pokeReply: '被戳时是否回应',
      pokeReplyChance: '回戳的概率',
      privateAfterthought: '私聊补一句',
      privateAfterthoughtIdleMs: '私聊补一句前的安静时间',
      privateAfterthoughtDailyMax: '私聊每天最多补几句',
      pokeCooldownMs: '戳一戳冷却（毫秒）',
      pokeDailyMax: '每天最多回应几次戳',
      recallMode: '被撤回时的做法',
      recallAddressed: '被 @ 的那条撤回了还回不回',
      recallScope: '调侃谁的撤回',
      recallChance: '开口调侃的概率',
      recallCooldownMs: '撤回调侃冷却（毫秒）',
      recallDailyMax: '每天最多调侃几次撤回',
      recallMaxAgeMs: '多久之内的撤回才提',
      recallTeaseQuote: '把撤回的原文给模型看',
      recallPrivate: '私聊撤回也处理',
      recallMemoryMark: '记忆里标记「已撤回」',
      digestMinLines: '当天多少条新消息才摘要',
      digestMaxChars: '一次摘要最多读多少字',
      digestTimeoutMs: '单次摘要的硬超时',
      digestCatchUp: '错过摘要点后补课',
      apiKeyRotate: '每天轮换 API key',
      instructions: '额外要求（追加）',
      batchWindowMs: '攒批窗口（毫秒）',
      batchMaxWaitMs: '整批等待上限（毫秒）',
      batchBacklog: '长任务期间的 @ 攒成一波',
      batchBacklogEntries: '一波最多贴几条',
      batchBacklogChars: '一波最多带多少字',
      batchBacklogHoldMs: '一波最多憋多久（毫秒）',
      activeMaxTurns: '免 @ 接话的条数上限',
      activeTalkChanceStep: '没抽中一条加多少概率',
      activeGroupLines: '多人搭话的条数门槛',
      activeGroupSpeakers: '多人搭话要几个人',
      activeChimeIdleMs: '群里补一句前的安静时间',
      activeChimeMax: '群里每轮最多补几句',
      activeChimeDailyMax: '群里每天最多补几句',
      reminder: '启用定时提醒',
      reminderFile: '提醒任务文件',
      reminderUsers: '谁能建提醒',
      reminderMentionOthers: '允许提醒 @ 别人',
      reminderAllowAll: '允许提醒 @全体',
      reminderDailyMax: '每人每天最多建几条',
      reminderMaxActive: '每个会话最多待发几条',
      reminderGraceMs: '补发窗口（毫秒）',
      reminderModes: '允许的最高模式',
      reminderAgentTimeoutMs: 'Agent 提醒的超时',
      reminderAgentDailyMax: '每个会话每天最多跑几次 Agent',
      memoryFileMaxBytes: '记忆文件的字节上限',
      memorySearchHits: '搜索最多返回几条',
      memoryPromptChars: '每轮记忆注入预算',
      memoryRecallK: '每轮最多取几条记忆',
      memoryPeopleMax: '人物表最多注入几人',
      memoryArchive: '启用冷层归档',
      memoryArchiveRatio: '归档触发比例',
      memoryVocabHint: '附一行全部梗的写法',
      digestRollover: '摘要后执行滚档',
      digestConsolidate: '摘要后跑周合并',
    };

    /**
     * 枚举取值的人话。schema 只给字面量（`pokeMode: 'random'`），页面得给人读得懂的
     * 说明；这张表是**界面层**的，不往 schema 里塞（那属于配置口径，不是展示）。
     */
    const ENUM_LABELS = {
      groupTrigger: { mention: '按 @ 提及', prefix: '按前缀', all: '全部消息' },
      approvalPolicy: { never: '一律拒绝（无人值守）', inherit: '跟随宿主' },
      pokeMode: { random: '随机（回戳或走一轮）', poke: '总是回戳', text: '走一轮模型', ignore: '不回' },
      recallMode: { off: '不处理（只修引用）', ignore: '假装没看到', tease: '调侃一下' },
      recallAddressed: { answer: '照常回答（不引用）', drop: '真不回' },
      recallScope: { 'to-me': '只调侃冲它来的', all: '群里谁撤回都调侃' },
      reminderModes: { text: '只发固定文案（最可靠）', agent: 'Agent 组织语言', prompt: 'Agent 执行指令（受信者）' },
      replyStyle: { auto: '自动（默认）', plain: '直接发', quote: '引用', at: '@ 对方' },
    };

    /**
     * 需要用**多行输入框**改的字段。这两项是一整段提示词（只写一句也算，但内置人设
     * 本身就有十来行），而单行 `<input>` 那么长的正文只能看到最后一截，等于盲改。
     * 名单写在这里而不是 schema 里 —— schema 管「配置的取值口径」，控件长什么样是
     * 界面自己的事。
     */
    const LONG_TEXT_FIELDS = new Set(['persona', 'instructions']);

    /** 从 `.description()` 里取一段短标签：第一个分隔符之前的那一截，太长的截断。 */
    function deriveLabel(description, key) {
      if (typeof description !== 'string') return key;
      const text = description.replace(/\*\*/g, '').trim();
      if (text.length === 0) return key;
      const head = text.split(/[（(：:；;，,。]/)[0].trim();
      if (head.length === 0) return key;
      return head.length > 24 ? `${head.slice(0, 23)}…` : head;
    }

    function labelOf(key, node) {
      const comment = node?.meta?.comment;
      if (typeof comment === 'string' && comment.length > 0) return comment;
      return LABEL_OVERRIDES[key] ?? deriveLabel(node?.meta?.description, key);
    }

    /** 字段落在哪一段：显式清单优先，其次前缀；都不认就是「其它」。 */
    function sectionOf(key) {
      for (const section of SECTIONS) {
        if (section.fields !== undefined && section.fields.includes(key)) return section;
        if (section.prefix !== undefined && section.prefix.some((prefix) => key.startsWith(prefix))) return section;
      }
      return OTHER_SECTION;
    }

    /** 分组 → tab；未知分组返回 undefined（别静默丢字段，测试钉着）。 */
    function tabOf(sectionId) {
      return TABS.find((tab) => tab.sections.includes(sectionId));
    }

    /** 这一组里有几项是「用户改过、保存后会留下一层覆盖」的（工具条与只看已改用它）。 */
    function countOverrides(rows) {
      return rows.filter((row) => row.state?.overridden === true).length;
    }

    /**
     * 一组的字段顺序：显式清单说了算，前缀组沿用 schema 顺序。
     *
     * 为什么不能一律用 schema 顺序：`SECTIONS` 里那几个 `fields` 数组承载的
     * 顺序本身是设计的一部分（人设页把「文件优先」的三个参数摆在已失效的旧
     * `persona` 前面）。只拿它判归属、顺序另由 schema 决定的话，这份意图就
     * 被静默丢掉了。
     */
    function orderedRows(section, rows, schemaIndex) {
      if (section.fields === undefined) return rows;
      const rankOf = (row) => {
        const at = section.fields.indexOf(row.key);
        return at === -1 ? Number.MAX_SAFE_INTEGER : at;
      };
      return [...rows].sort((a, b) => rankOf(a) - rankOf(b) || schemaIndex.get(a.key) - schemaIndex.get(b.key));
    }

    /** 这一项上方要不要来一个小标题（表达页的 标点 / 私聊）。 */
    function subTitleOf(section, key) {
      for (const sub of section.subs ?? []) {
        if (!sub.fields.includes(key)) continue;
        return sub.fields[0] === key ? sub.title : undefined;
      }
      return undefined;
    }

    /** 这一项要不要折进「兼容」区；返回的是 summary 的文案 key。 */
    function disclosureOf(section, key) {
      const rule = DISCLOSURES[section.id];
      if (rule === undefined || !rule.fields.includes(key)) return undefined;
      return rule.summary;
    }

    // ---- 量纲提示（只显示，不做双向换算）-----------------------------------------
    //
    // `proactiveIdleMs: 2700000` 这种值只能心算，所以 hint 末尾追加一段人类可读的
    // 换算（`= 45 分钟`）。输入框里始终是原始值 —— 双向换算会让「我填的到底是什么」
    // 变得模糊，也会在精度上悄悄改值。
    //
    // `FIELD_HINTS` 是**显式白名单**，不按后缀猜：后缀一致但语义不同的字段将来还会
    // 有。为了让白名单不漏，测试反向钉住「凡是名字以 Ms/Bytes/Chars/Hour/Chance 结尾
    // 的字段都必须在这里或 NO_HINT 里」。

    /** 四舍五入到一位小数，整数不带 `.0`。 */
    function round1(value) {
      return Math.round(value * 10) / 10;
    }

    function numberText(value) {
      return String(round1(value));
    }

    function formatMs(value) {
      if (value >= 60 * 60 * 1000) return `${numberText(value / (60 * 60 * 1000))} 小时`;
      if (value >= 60 * 1000) return `${numberText(value / (60 * 1000))} 分钟`;
      if (value >= 1000) return `${numberText(value / 1000)} 秒`;
      return `${numberText(value)} 毫秒`;
    }

    function formatBytes(value) {
      if (value >= 1024 * 1024 * 1024) return `${numberText(value / (1024 * 1024 * 1024))} GB`;
      if (value >= 1024 * 1024) return `${numberText(value / (1024 * 1024))} MB`;
      if (value >= 1024) return `${numberText(value / 1024)} KB`;
      return `${numberText(value)} B`;
    }

    function formatChars(value) {
      return `${numberText(value)} 字`;
    }

    function formatHour(value) {
      if (!Number.isInteger(value) || value < 0 || value > 23) return `${numberText(value)} 点`;
      return `${String(value).padStart(2, '0')}:00`;
    }

    function formatPercent(value) {
      return `${numberText(value * 100)}%`;
    }

    function formatScale(value) {
      return `×${numberText(value)}`;
    }

    const FIELD_HINTS = {
      // 毫秒
      linkPreviewTimeoutMs: formatMs,
      mediaTimeoutMs: formatMs,
      batchWindowMs: formatMs,
      batchMaxWaitMs: formatMs,
      batchBacklogChars: formatChars,
      batchBacklogHoldMs: formatMs,
      pokeCooldownMs: formatMs,
      recallCooldownMs: formatMs,
      recallMaxAgeMs: formatMs,
      repeatWindowMs: formatMs,
      proactiveCheckMs: formatMs,
      proactiveIdleMs: formatMs,
      proactiveFreshMs: formatMs,
      proactiveGapMs: formatMs,
      activeWindowMs: formatMs,
      activeChimeIdleMs: formatMs,
      readDelayMs: formatMs,
      minDelayMs: formatMs,
      maxDelayMs: formatMs,
      privateAfterthoughtIdleMs: formatMs,
      digestTimeoutMs: formatMs,
      apiKeyProbeTimeoutMs: formatMs,
      reminderGraceMs: formatMs,
      reminderAgentTimeoutMs: formatMs,
      // 字节
      mediaMaxBytes: formatBytes,
      imageMaxBytes: formatBytes,
      linkPreviewMaxBytes: formatBytes,
      videoMaxBytes: formatBytes,
      memoryFileMaxBytes: formatBytes,
      // 字符
      maxReplyChars: formatChars,
      ambientLineChars: formatChars,
      repeatMaxChars: formatChars,
      personaMaxChars: formatChars,
      styleMaxChars: formatChars,
      burstMaxChars: formatChars,
      burstSingleMaxChars: formatChars,
      shortPeriodMaxChars: formatChars,
      digestMaxChars: formatChars,
      memoryPromptChars: formatChars,
      // 本地小时
      proactiveFromHour: formatHour,
      proactiveToHour: formatHour,
      digestAtHour: formatHour,
      apiKeyRotateHour: formatHour,
      // 概率（0~1）
      pokeReplyChance: formatPercent,
      recallChance: formatPercent,
      repeatChance: formatPercent,
      proactiveChance: formatPercent,
      activeTalkChance: formatPercent,
      activeTalkChanceStep: formatPercent,
      activeTalkChanceMax: formatPercent,
      privateAfterthoughtChance: formatPercent,
      memoryArchiveRatio: formatPercent,
      // 倍率
      activeGroupBatchScale: formatScale,
    };

    /** 显式豁免集合：后缀命中、但换算后反而不如原值直观的字段（目前没有）。 */
    const NO_HINT = new Set();

    /**
     * 一个字段值的量纲提示（`= 45 分钟`）；没有白名单条目就返回空串。
     * `value` 可以是数字，也可以是草稿文本（数字框里就是文本）。
     */
    function hintFor(key, value) {
      if (NO_HINT.has(key)) return '';
      const format = FIELD_HINTS[key];
      if (typeof format !== 'function') return '';
      const raw =
        typeof value === 'number' ? value : String(value ?? '').trim() === '' ? undefined : Number(value);
      if (raw === undefined || !Number.isFinite(raw)) return '';
      const text = format(raw);
      return text.length === 0 ? '' : `= ${text}`;
    }

    function labelForEnum(key, value) {
      const table = ENUM_LABELS[key];
      if (table !== undefined && typeof table[value] === 'string') return table[value];
      return value;
    }

    // ---- schema → 控件 ---------------------------------------------------------

    /**
     * 字段该用哪种控件。取值只有四种，都是 schemastery 的节点类型直接映射：
     * boolean / number / （字符串）union / array(string)，其余一律按文本。
     */
    function kindOf(node) {
      if (node?.type === 'boolean') return 'boolean';
      if (node?.type === 'number') return 'number';
      if (node?.type === 'array') return 'list';
      if (node?.type === 'union') return 'choice';
      return 'text';
    }

    /** 字符串 union 的可选值（`z.union(['a','b'])` 解析后是 const 节点列表）。 */
    function choicesOf(node) {
      if (node?.type !== 'union') return [];
      return (node.list ?? [])
        .map((child) => (child?.type === 'const' ? child.value : undefined))
        .filter((value) => typeof value === 'string');
    }

    const TRUE_WORDS = new Set(['true', '1', 'yes', 'y', 'on', '是', '开', '真', '启用', '打开']);
    const FALSE_WORDS = new Set(['false', '0', 'no', 'n', 'off', '否', '关', '假', '禁用', '关闭']);

    function emptyToClear(text) {
      return text.trim().length === 0 ? { kind: 'clear' } : undefined;
    }

    /**
     * 布尔字段：存的是 true/false，界面是开关，但草稿文本仍是 `'true'` / `'false'`
     * （spec 是唯一口径，控件只负责把值转成草稿文本）。宽容一点：手写的旧值里
     * 可能出现 `是` / `on` 之类。
     */
    function booleanSpec(field) {
      return {
        field,
        format: (value) => (typeof value === 'boolean' ? String(value) : ''),
        parse: (text) => {
          const cleared = emptyToClear(text);
          if (cleared !== undefined) return cleared;
          const word = text.trim().toLowerCase();
          if (TRUE_WORDS.has(word)) return { kind: 'set', value: true };
          if (FALSE_WORDS.has(word)) return { kind: 'set', value: false };
          return undefined;
        },
      };
    }

    /** 字符串数组（白名单 / 工具名单）：界面上是一行逗号分隔的值。 */
    function listSpec(field) {
      return {
        field,
        format: (value) => (Array.isArray(value) ? value.join(', ') : ''),
        parse: (text) => {
          const cleared = emptyToClear(text);
          if (cleared !== undefined) return cleared;
          const items = text
            .split(/[,，\n]/)
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
          return { kind: 'set', value: items };
        },
      };
    }

    /** 枚举字段：只接受 union 里列出的那几个值，别的当场判非法、拦住保存。 */
    function choiceSpec(field, choices) {
      return {
        field,
        format: (value) => (typeof value === 'string' ? value : ''),
        parse: (text) => {
          const cleared = emptyToClear(text);
          if (cleared !== undefined) return cleared;
          const word = text.trim();
          return choices.includes(word) ? { kind: 'set', value: word } : undefined;
        },
      };
    }

    /** 每个字段一条 spec，交给 primitives 的 SettingsFormModel 去暂存与提交。 */
    function specFor(key, node) {
      const kind = kindOf(node);
      if (kind === 'boolean') return booleanSpec(key);
      if (kind === 'number') return P.settingsNumberField(key);
      if (kind === 'list') return listSpec(key);
      if (kind === 'choice') return choiceSpec(key, choicesOf(node));
      return P.settingsTextField(key);
    }

    /** 描述的第一行（去掉 markdown 加粗），没有就空串。 */
    function firstLine(description) {
      if (typeof description !== 'string') return '';
      const line = description.replace(/\*\*/g, '').split('\n')[0].trim();
      return line;
    }

    /**
     * 把标签已覆盖的那一截从描述里去掉：开关行与枚举行的标签通常就是描述的第一小段，
     * 原样再显示一遍只会变成「标签 / 标签」两行。去不掉就整行留着（信息不丢）。
     */
    function dropLabel(text, label) {
      if (label.length === 0 || !text.startsWith(label)) return text;
      return text.slice(label.length).replace(/^[\s：:，,。；;、（）()「」]+/, '').trim();
    }

    /** 短提示：列表给用法，其余给描述去掉标签后的那一截。 */
    function hintOf(kind, node, choices, label) {
      if (kind === 'list') return zh.hintList;
      if (kind === 'choice' && choices.length === 0) return firstLine(node?.meta?.description);
      const tail = dropLabel(firstLine(node?.meta?.description), label);
      return tail.length > 96 ? `${tail.slice(0, 95)}…` : tail;
    }

    /** 输入框的占位：把 schema 默认值摆出来，让人一眼看到「留空 = 什么」。 */
    function placeholderOf(kind, node, choices) {
      if (kind === 'choice' && choices.length > 0) return choices.join(' / ');
      if (kind === 'boolean') return 'true / false';
      const fallback = node?.meta?.default;
      if (kind === 'list') return Array.isArray(fallback) && fallback.length > 0 ? fallback.join(', ') : '';
      if (typeof fallback === 'string' || typeof fallback === 'number') {
        const text = String(fallback);
        return text.length > 40 ? `${text.slice(0, 39)}…` : text;
      }
      return '';
    }

    /** 把一份表单 schema 摊成这个页面认识的行（顺序 = schema 里的字段顺序）。 */
    function describeFields(schema) {
      const dict = schema?.dict ?? {};
      return Object.keys(dict).map((key) => {
        const node = dict[key];
        const kind = kindOf(node);
        const choices = kind === 'choice' ? choicesOf(node) : [];
        const label = labelOf(key, node);
        return {
          key,
          node,
          kind,
          choices,
          section: sectionOf(key),
          label,
          description: typeof node?.meta?.description === 'string' ? node.meta.description : '',
          hint: hintOf(kind, node, choices, label),
          placeholder: placeholderOf(kind, node, choices),
          numeric: kind === 'number',
          long: LONG_TEXT_FIELDS.has(key),
          enumLabels: kind === 'choice' ? (ENUM_LABELS[key] ?? {}) : {},
          invalidLabel:
            kind === 'number'
              ? zh.invalidNumber
              : kind === 'boolean'
                ? zh.invalidBoolean
                : kind === 'choice'
                  ? zh.invalidChoice
                  : kind === 'list'
                    ? zh.invalidList
                    : zh.invalidText,
        };
      });
    }

    // ---- 搜索 ------------------------------------------------------------------

    /** 大小写不敏感，空白 / `_` / `-` 先去掉（`proactive_idle_ms` 也要能命中）。 */
    function normalize(text) {
      return String(text ?? '')
        .toLowerCase()
        .replace(/[\s_-]+/g, '');
    }

    /**
     * 搜索的匹配口径：字段短标签 / 字段名 / `.description()` / 所属区块标题。
     * 空查询返回空数组（「没有搜索」和「搜索无结果」是两种状态，调用方自己分）。
     */
    function filterRows(rows, query) {
      const needle = normalize(query);
      if (needle === '') return [];
      return rows.filter(
        (row) =>
          normalize(row.label).includes(needle) ||
          normalize(row.key).includes(needle) ||
          normalize(row.description).includes(needle) ||
          normalize(row.section.title).includes(needle),
      );
    }

    // ---- 表单模型 --------------------------------------------------------------

    /**
     * 一页的暂存表单：primitives 的 `SettingsFormModel` 负责草稿、校验与一次提交，
     * 这里只负责「把字段按 tab / 分组摆好」这件事。
     *
     * 它的 scope 是 `configForms.get(ENTRY)` —— Host 侧那一份按 profile 条目 id 认的
     * 配置表单（读值 + `mutate` 提交，带 revision 栅栏）。模型自己的订阅会把
     * scope 的每一次变化（保存后的回读、别处改了配置）转成 store 的一次发布。
     */
    function createPage(ctx) {
      const mirror = ctx.configForms.describe();
      const scope = ctx.configForms.get(ENTRY);
      let live = null;

      function namespaceView() {
        const namespaces = mirror.getSnapshot().view?.namespaces ?? [];
        return namespaces.find((view) => view.ns === ENTRY);
      }

      /** 按 schema 建模型与 store；schema 是「这个插件版本的配置长什么样」，重建只在重新挂载时发生。 */
      function build(view) {
        const fields = describeFields(ctx.settingsSchema.rehydrate(view.schema));
        const model = new P.SettingsFormModel(scope, fields.map((row) => specFor(row.key, row.node)));
        const store = model.bind(() => project(model, fields));
        live = { fields, model, store, actions: model.actions() };
        return live;
      }

      /**
       * 数字框里的草稿文本 → 用来算量纲提示的值。空草稿（= 用默认值）就取 schema
       * 默认值：`proactiveIdleMs` 那行即使没改过也该显示 `= 45 分钟`。
       */
      function valueOfDraft(row, text) {
        if (row.kind !== 'number') return text;
        const trimmed = String(text ?? '').trim();
        if (trimmed === '') return row.node?.meta?.default;
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : undefined;
      }

      /**
       * 把一行的「展示状态」补上：草稿、覆盖 / 非法标记、组内小标题、折叠归属、
       * 以及 hint 末尾追加的量纲。
       *
       * 为什么量纲在这里算而不是在 schema 里：它跟**当前草稿**走（用户把 2700000
       * 改成 60000，提示要立刻变成「= 1 分钟」），而且它不是配置口径。
       */
      function withMeta(row, tab, section, model) {
        const state = model.field(row.key);
        const dimension = hintFor(row.key, valueOfDraft(row, state.text));
        return {
          ...row,
          tabId: tab.id,
          tabLabel: tab.label,
          tabTitle: tab.title,
          sectionTitle: section.title,
          subTitle: subTitleOf(section, row.key),
          disclosure: disclosureOf(section, row.key),
          hint: dimension.length === 0 ? row.hint : row.hint.length === 0 ? dimension : `${row.hint} · ${dimension}`,
          state,
        };
      }

      /** 取一行的草稿状态：`model.field()` 是 primitives 的口径（文本 / 覆盖 / 非法）。 */
      function project(model, fields) {
        const shell = model.shell();
        const schemaIndex = new Map(fields.map((row, index) => [row.key, index]));
        const tabs = TABS.map((tab) => {
          const sections = tab.sections
            .map((sectionId) => SECTIONS.find((section) => section.id === sectionId))
            .filter((section) => section !== undefined)
            .map((section) => {
              const ordered = orderedRows(
                section,
                fields.filter((row) => row.section.id === section.id),
                schemaIndex,
              );
              return {
                id: section.id,
                title: section.title,
                note: section.note,
                rows: ordered.map((row) => withMeta(row, tab, section, model)),
              };
            })
            .filter((section) => section.rows.length > 0);
          return { id: tab.id, label: tab.label, title: tab.title, sections };
        });
        return { shell, tabs };
      }

      return {
        /** `whileServed` 的回调里调：此时命名空间已经在 describe 里了。 */
        mount() {
          const view = namespaceView();
          if (view === undefined) return () => {};
          const page = build(view);
          return () => {
            live = null;
            page.model.dispose();
          };
        },
        /**
         * 注册项要注入的业务面：`hooks` 里的 observable 会被框架绑成
         * `useQqSettings(selector)`，其余成员原样进 props。
         *
         * `live === null` 只可能出现在注册已经撤掉、而框架还在渲染最后一眼的时候；
         * 那时给一组空动作（而不是 undefined），免得报错盖掉真正的卸载原因。
         */
        inject() {
          if (live === null) {
            const noop = () => {};
            return { hooks: {}, edit: noop, resetField: noop, save: noop, discard: noop };
          }
          const { store, actions } = live;
          return {
            hooks: { qqSettings: store },
            edit: actions.edit,
            resetField: actions.resetField,
            save: actions.save,
            discard: actions.discard,
          };
        },
      };
    }

    // ---- 组件 ------------------------------------------------------------------
    //
    // 视觉一律走 `--dsw-*` 主题变量（与 primitives 同一套 token）与上面那段注入的
    // <style>，不引任何外部样式表：手写 bundle 里没有构建好的 CSS 可以 import。
    //
    // 下面这些组件是**纯函数画出来的节点**（除了 FieldShell 里那一个 help 展开状态），
    // 由页面组件通过 `jsx` 挂成真正的 React 元素。

    /**
     * 标记「这是本页自己的组件」。
     *
     * 为什么需要：`test/client.test.mjs` 用一个迷你渲染器把整页跑成树 —— 它只展开
     * 带这个记号的函数组件，primitives 的控件（Switch / Input / Tag…）在测试里是桩，
     * 展开成桩的内部结构就看不到控件本身了。
     */
    function component(render) {
      render.qqComponent = true;
      return render;
    }

    /** primitives 的 help 按钮里那颗 ⓘ；万一取不到就退一个字，别整页炸掉。 */
    const helpGlyph = typeof P.IconInfoOutlineRegular === 'function' ? jsx(P.IconInfoOutlineRegular, { size: 12 }) : 'ⓘ';

    /**
     * 字段行的统一外壳：label 行（含 ⓘ / 已覆盖 / 恢复默认）、控件槽、hint 或错误、
     * 展开后的完整说明。
     *
     * 为什么所有控件都走这一个组件而不是各自画 chrome：官方设置页只有两种行
     * （表单行 / 开关行），「已覆盖 + 恢复默认」那套 chrome 必须一模一样；两个控件
     * 各画一套，一年后就会长出第三种行。`layout: 'inline'` 就是官方开关行。
     */
    const FieldShell = component(function FieldShell(props) {
      const [helpOpen, setHelpOpen] = useState(false);
      const helpId = `${props.id}-help`;
      const messageId = `${props.id}-message`;
      const hasMessage = Boolean(props.invalid || props.hint);
      const describedBy = hasMessage ? messageId : undefined;
      const inline = props.layout === 'inline';

      // 开关行的标题不用 <label>：`Switch` 是个按钮，`label for` 点它不会切换；
      // 可见标题与 `aria-label` 用同一段文字（Switch 的 label 就是它的无障碍名）。
      const labelNode = inline
        ? jsx('span', { id: `${props.id}-label`, className: 'qq-fieldLabel', children: props.label }, 'label')
        : jsx(
            'label',
            { id: `${props.id}-label`, className: 'qq-fieldLabel', htmlFor: props.id, children: props.label },
            'label',
          );

      const labelGroup = jsxs(
        'div',
        {
          className: 'qq-fieldLabelGroup',
          children: [
            labelNode,
            props.help === undefined
              ? null
              : jsx(
                  'button',
                  {
                    type: 'button',
                    className: 'qq-helpButton',
                    'aria-label': props.help.label,
                    title: props.help.label,
                    'aria-expanded': helpOpen,
                    'aria-controls': helpId,
                    onClick: () => {
                      setHelpOpen(!helpOpen);
                    },
                    children: helpGlyph,
                  },
                  'help-button',
                ),
          ],
        },
        'label-group',
      );

      const badges = [];
      if (props.sourceTag !== undefined) badges.push(props.sourceTag);
      if (props.overridden) {
        badges.push(jsx(P.Tag, { tone: 'neutral', children: props.overriddenLabel }, 'overridden'));
        badges.push(
          jsx(
            'button',
            {
              type: 'button',
              className: 'qq-reset',
              disabled: props.disabled,
              onClick: () => {
                props.onReset();
              },
              children: props.resetLabel,
            },
            'reset',
          ),
        );
      }
      const head = jsxs(
        'div',
        {
          className: 'qq-fieldHead',
          children: [
            labelGroup,
            badges.length === 0 ? null : jsx('span', { className: 'qq-fieldBadges', children: badges }, 'badges'),
          ],
        },
        'head',
      );

      const message = hasMessage
        ? jsx(
            'p',
            {
              id: messageId,
              className: props.invalid ? 'qq-invalid' : 'qq-hint',
              children: props.invalid ? props.invalidLabel : props.hint,
            },
            'message',
          )
        : null;

      const control = jsx('div', { className: 'qq-control', children: props.renderControl({ describedBy }) }, 'control');

      const helpPanel =
        props.help !== undefined && helpOpen
          ? jsx(
              'div',
              {
                id: helpId,
                className: 'qq-help',
                role: 'region',
                'aria-label': props.help.label,
                children: props.help.content,
              },
              'help',
            )
          : null;

      const fieldProps = {
        className: 'qq-field',
        'data-field': props.fieldKey,
        'data-kind': props.kind,
        'data-layout': inline ? 'inline' : 'stack',
        'data-divided': props.divided ? 'true' : undefined,
        role: props.role,
        'aria-label': props.ariaLabel,
      };

      if (inline) {
        return jsxs(
          'div',
          {
            ...fieldProps,
            children: [
              jsxs('div', { className: 'qq-fieldMain', children: [head, message, helpPanel] }, 'main'),
              control,
            ],
          },
          'field',
        );
      }
      return jsxs('div', { ...fieldProps, children: [head, control, message, helpPanel] }, 'field');
    });

    /** 官方开关行：标题 + 说明在左，`Switch` 在右。 */
    const SwitchRow = component(function SwitchRow(props) {
      return jsx(
        FieldShell,
        {
          ...props,
          layout: 'inline',
          renderControl: () =>
            jsx(
              P.Switch,
              {
                checked: props.text === 'true',
                disabled: props.disabled,
                // Switch 的 label 就是它的 aria 名：传可见标题，屏幕阅读器读到的与看到的一致。
                label: props.label,
                onChange: (next) => {
                  props.onEdit(next ? 'true' : 'false');
                },
              },
              'switch',
            ),
        },
        props.fieldKey,
      );
    });

    /**
     * 字段行的输入框：原生 `<input>` + `.qq-input`（官方 `fields.module.css` 的几何：
     * 34px 高、radius-md、bg-layer-3、border-l4）。
     *
     * 为什么不用 primitives 的 `Input`：那个控件是「工具条里的胶囊」（32px、bg-layer-1、
     * 可以带前置图标），和同一行的 `<select>` / 多行框摆在一起会一眼看出两个尺寸。官方
     * 插件配置表单本身也是原生 input + 自己的 class（`SettingsValueField` 就是这么做的）。
     * 搜索框仍然用 `Input` —— 那里正好需要它自带的前置放大镜。
     */
    function inputControl(props, describedBy, extra = {}) {
      return jsx(
        'input',
        {
          id: props.id,
          type: 'text',
          className: 'qq-input',
          value: props.text,
          placeholder: props.placeholder ?? '',
          disabled: props.disabled,
          ...extra,
          ...(props.invalid ? { 'aria-invalid': true } : {}),
          ...(describedBy === undefined ? {} : { 'aria-describedby': describedBy }),
          onChange: (event) => {
            props.onEdit(event.target.value);
          },
        },
        'input',
      );
    }

    /** 文本行。 */
    const TextField = component(function TextField(props) {
      return jsx(
        FieldShell,
        {
          ...props,
          renderControl: ({ describedBy }) => inputControl(props, describedBy),
        },
        props.fieldKey,
      );
    });

    /** 数字行：与文本同一个控件，只多一个 `inputMode`（手机上调数字键盘）。 */
    const NumberField = component(function NumberField(props) {
      return jsx(
        FieldShell,
        {
          ...props,
          renderControl: ({ describedBy }) => inputControl(props, describedBy, { inputMode: 'numeric' }),
        },
        props.fieldKey,
      );
    });

    /**
     * 枚举行：原生 `<select>` + Input 外观 + 右侧箭头（官方 Models 页的写法）。
     *
     * 为什么不用 `SegmentedControl`：那是 tablist 语义（视图切换），拿来选值会误导
     * 屏幕阅读器；取值只有 2~4 个也不值得上 `Menu`。
     */
    const SelectField = component(function SelectField(props) {
      return jsx(
        FieldShell,
        {
          ...props,
          renderControl: ({ describedBy }) =>
            jsx(
              'select',
              {
                id: props.id,
                className: 'qq-input qq-select',
                value: props.text,
                disabled: props.disabled,
                ...(props.invalid ? { 'aria-invalid': true } : {}),
                ...(describedBy === undefined ? {} : { 'aria-describedby': describedBy }),
                onChange: (event) => {
                  props.onEdit(event.target.value);
                },
                children: [
                  jsx('option', { value: '', children: props.defaultLabel }, 'default'),
                  ...props.choices.map((choice) =>
                    jsx('option', { value: choice, children: labelForEnum(props.fieldKey, choice) }, choice),
                  ),
                ],
              },
              'select',
            ),
        },
        props.fieldKey,
      );
    });

    /**
     * 字符串数组行：输入仍是逗号分隔的文本（草稿口径只有一个），下面用 `Pill` 把
     * 当前值预览出来，点一下 × 就删掉那一个 —— 比在一行文本里找逗号删词可靠。
     */
    const ListField = component(function ListField(props) {
      const items = String(props.text ?? '')
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      const preview =
        items.length === 0
          ? null
          : jsx(
              'div',
              {
                className: 'qq-pills',
                children: items.map((item, index) =>
                  jsx(
                    P.Pill,
                    {
                      type: 'button',
                      disabled: props.disabled,
                      title: `${item} ×`,
                      onClick: () => {
                        props.onEdit(items.filter((other) => other !== item).join(', '));
                      },
                      children: `${item} ×`,
                    },
                    `${item}-${index}`,
                  ),
                ),
              },
              'pills',
            );
      return jsx(
        FieldShell,
        {
          ...props,
          renderControl: ({ describedBy }) =>
            jsxs(
              'div',
              {
                children: [
                  inputControl(props, describedBy),
                  preview,
                ],
              },
              'list',
            ),
        },
        props.fieldKey,
      );
    });

    /** 多行行：一整段提示词需要 `<textarea>`（单行 `<input>` 只能看到最后一截）。 */
    const LongTextField = component(function LongTextField(props) {
      return jsx(
        FieldShell,
        {
          ...props,
          renderControl: ({ describedBy }) =>
            jsx(
              'textarea',
              {
                id: props.id,
                className: 'qq-textarea',
                rows: 10,
                value: props.text,
                placeholder: props.placeholder ?? '',
                disabled: props.disabled,
                ...(props.invalid ? { 'aria-invalid': true } : {}),
                ...(describedBy === undefined ? {} : { 'aria-describedby': describedBy }),
                onChange: (event) => {
                  props.onEdit(event.target.value);
                },
              },
              'textarea',
            ),
        },
        props.fieldKey,
      );
    });

    /** `row` 的控件：按类型分派，props 口径全部一致（见上面的各类 Field）。 */
    function renderField(row, options) {
      const { t, writable, divided, sourceTag, role, ariaLabel } = options;
      const props = {
        fieldKey: row.key,
        kind: row.kind,
        id: `${FIELD_ID_PREFIX}${row.key}`,
        label: row.label,
        hint: row.hint,
        help: { label: t('helpLabel'), content: helpContent(row, t) },
        text: row.state.text,
        overridden: row.state.overridden === true,
        invalid: row.state.invalid === true,
        disabled: !writable,
        divided: divided === true,
        overriddenLabel: t('overridden'),
        resetLabel: t('reset'),
        invalidLabel: row.invalidLabel,
        placeholder: row.placeholder,
        choices: row.choices,
        enumLabels: row.enumLabels,
        defaultLabel: t('defaultOption'),
        sourceTag,
        role,
        ariaLabel,
        onEdit: (text) => {
          options.edit(row.key, text);
        },
        onReset: () => {
          options.resetField(row.key);
        },
      };
      if (row.long) return jsx(LongTextField, props, row.key);
      if (row.kind === 'boolean') return jsx(SwitchRow, props, row.key);
      if (row.kind === 'choice') return jsx(SelectField, props, row.key);
      if (row.kind === 'list') return jsx(ListField, props, row.key);
      if (row.kind === 'number') return jsx(NumberField, props, row.key);
      return jsx(TextField, props, row.key);
    }

    /** ⓘ 展开后的完整说明：描述全文 + 可取的值（人话）+ 配置项名。 */
    function helpContent(row, t) {
      const paragraphs = [];
      if (row.description.length > 0) {
        paragraphs.push(jsx('p', { children: row.description }, 'description'));
      }
      if (row.choices.length > 0) {
        paragraphs.push(
          jsx(
            'p',
            { children: `${t('acceptLabel')}: ${row.choices.map((choice) => labelForEnum(row.key, choice)).join(' / ')}` },
            'choices',
          ),
        );
      }
      paragraphs.push(jsx('p', { children: `${t('keyLabel')}: ${row.key}` }, 'key'));
      return jsxs('div', { children: paragraphs }, 'help');
    }

    /**
     * 把一个分组的行切成「行块 / 折叠块」。
     *
     * 只有旧 `persona` 是折叠的（`DISCLOSURES`），而它必须落在人设文件参数**之后**、
     * 额外要求**之前** —— 所以折叠不能提到分组开头，只能就地在行序列里切一刀。
     */
    function blocksOf(rows) {
      const blocks = [];
      let current;
      for (const row of rows) {
        const kind = row.disclosure === undefined ? 'rows' : 'disclosure';
        if (current === undefined || current.kind !== kind || (kind === 'disclosure' && current.titleKey !== row.disclosure)) {
          current = { kind, titleKey: row.disclosure, rows: [] };
          blocks.push(current);
        }
        current.rows.push(row);
      }
      return blocks;
    }

    /** 「兼容」折叠区（原生 `<details>`：展开状态、键盘与 `aria-expanded` 都由浏览器给）。 */
    const Disclosure = component(function Disclosure(props) {
      return jsxs(
        'details',
        {
          className: 'qq-disclosure',
          children: [
            jsx(
              'summary',
              {
                className: 'qq-summary',
                children: [
                  jsx('span', { className: 'qq-chevron', 'aria-hidden': 'true' }, 'chevron'),
                  jsx('span', { children: props.title }, 'title'),
                ],
              },
              'summary',
            ),
            jsx('div', { className: 'qq-disclosureBody', children: props.children }, 'body'),
          ],
        },
        'details',
      );
    });

    /** 一个扁平区块：标题 + 可选说明 + 字段行（行与行之间 0.5px 分隔线）。 */
    const SectionBlock = component(function SectionBlock(props) {
      const { section, t, edit, resetField, writable } = props;
      const titleId = `qq-section-${section.id}`;
      const children = [jsx('h3', { id: titleId, className: 'qq-sectionTitle', children: section.title }, 'title')];
      if (typeof section.note === 'string' && section.note.length > 0) {
        children.push(jsx('p', { className: 'qq-sectionNote', children: t(section.note) }, 'note'));
      }
      const blocks = blocksOf(section.rows);
      blocks.forEach((block, blockIndex) => {
        if (block.kind === 'disclosure') {
          children.push(
            jsx(
              Disclosure,
              {
                title: t(block.titleKey),
                children: block.rows.map((row, index) =>
                  renderField(row, { t, edit, resetField, writable, divided: index > 0 }),
                ),
              },
              `disclosure-${block.titleKey}`,
            ),
          );
          return;
        }
        block.rows.forEach((row, index) => {
          if (typeof row.subTitle === 'string' && row.subTitle.length > 0) {
            children.push(jsx('h4', { className: 'qq-subTitle', children: row.subTitle }, `sub-${row.key}`));
          }
          children.push(renderField(row, { t, edit, resetField, writable, divided: blockIndex > 0 || index > 0 }));
        });
      });
      return jsx('section', { className: 'qq-section', 'aria-labelledby': titleId, children }, section.id);
    });

    /** 搜索结果的扁平列表：每行可编辑，右侧 Tag 标出来源 tab。 */
    const SearchResults = component(function SearchResults(props) {
      const { t, rows, edit, resetField, writable } = props;
      if (rows.length === 0) return jsx('p', { className: 'qq-empty', children: t('searchEmpty') }, 'empty');
      return jsx(
        'div',
        {
          className: 'qq-panel',
          role: 'list',
          children: rows.map((row, index) =>
            renderField(row, {
              t,
              edit,
              resetField,
              writable,
              divided: index > 0,
              role: 'listitem',
              ariaLabel: t('sectionOf', { tab: row.tabTitle }),
              sourceTag: jsx(P.Tag, { tone: 'outline', children: row.tabLabel }, `source-${row.key}`),
            }),
          ),
        },
        'search-results',
      );
    });

    // ---- 已记录的定时任务（只读） ------------------------------------------------
    //
    // 数据不在 schema 里：任务文件是运行状态，不是配置。Host 那条 `REMINDER_TASKS_PATH`
    // 挂在 Connection 的认证栅栏后面，这里只负责画。页面开着时每 15 秒重读一次 ——
    // 任务是在 QQ 那一侧建的，没有事件能推到浏览器。

    /** 状态 → 字典 key（`unknown` 兜底，读到坏数据也不会把 key 露到页面上）。 */
    const REMINDER_STATUS_KEY = {
      active: 'remindersStatusActive',
      firing: 'remindersStatusFiring',
      done: 'remindersStatusDone',
      missed: 'remindersStatusMissed',
      failed: 'remindersStatusFailed',
      cancelled: 'remindersStatusCancelled',
      unknown: 'remindersStatusUnknown',
    };

    /** 状态 → Tag 色调：待发是信息、发送中要留意、失败是错误、历史静音。 */
    const REMINDER_STATUS_TONE = {
      active: 'info',
      firing: 'warning',
      done: 'success',
      missed: 'danger',
      failed: 'danger',
      cancelled: 'quiet',
      unknown: 'outline',
    };

    /** 模式 → 字典 key：这里用页面自己的短文案，不复用配置页那串长说明。 */
    const REMINDER_MODE_KEY = {
      text: 'remindersModeText',
      agent: 'remindersModeAgent',
      prompt: 'remindersModePrompt',
    };

    /** 一行任务的展示标签（时间 / 重复 / 目标 / @ / 创建者 / 发送次数 / 上次错误）。 */
    const ReminderTaskRow = component(function ReminderTaskRow(props) {
      const { t, task } = props;
      const mentions = (Array.isArray(task.mentions) ? task.mentions : []).map(String);
      const createdBy = typeof task.createdBy === 'string' ? task.createdBy : '';
      const error = typeof task.error === 'string' ? task.error : '';
      const text = typeof task.text === 'string' ? task.text : '';
      const meta = [
        task.type === 'group'
          ? t('remindersTargetGroup', { id: task.targetId })
          : t('remindersTargetPrivate', { id: task.targetId }),
      ];
      if (mentions.length > 0) meta.push(t('remindersMentions', { names: mentions.map((name) => `@${name}`).join(' ') }));
      if (createdBy.length > 0) meta.push(t('remindersCreatedBy', { name: createdBy }));
      if (task.fireCount > 0) meta.push(t('remindersFired', { count: task.fireCount }));
      if (error.length > 0) meta.push(t('remindersErrorLabel', { message: error }));
      const due = typeof task.dueLabel === 'string' && task.dueLabel.length > 0 ? task.dueLabel : String(task.id ?? '');
      const repeat = typeof task.repeat === 'string' ? task.repeat : '';
      return jsxs(
        'li',
        {
          className: 'qq-task',
          'data-status': task.status,
          children: [
            jsxs(
              'div',
              {
                className: 'qq-taskHead',
                children: [
                  jsx('span', {
                    className: 'qq-taskTime',
                    children: task.repeating ? `${due} · ${repeat}` : due,
                  }, 'time'),
                  jsxs(
                    'span',
                    {
                      className: 'qq-taskTags',
                      children: [
                        jsx(P.Tag, {
                          tone: REMINDER_STATUS_TONE[task.status] ?? 'outline',
                          children: t(REMINDER_STATUS_KEY[task.status] ?? REMINDER_STATUS_KEY.unknown),
                        }, 'status'),
                        jsx(P.Tag, { tone: 'outline', children: t(REMINDER_MODE_KEY[task.mode] ?? REMINDER_MODE_KEY.text) }, 'mode'),
                      ],
                    },
                    'tags',
                  ),
                ],
              },
              'head',
            ),
            jsx('p', {
              className: 'qq-taskText',
              children: task.mode === 'prompt' ? `${t('remindersPromptPrefix')}${text}` : text,
            }, 'text'),
            jsx('p', { className: 'qq-taskMeta', children: meta.join(' · ') }, 'meta'),
          ],
        },
        'task',
      );
    });

    /** 任务列表（纯展示）：空列表给一句「还没有」，否则逐条画。 */
    const ReminderTaskList = component(function ReminderTaskList(props) {
      const { t, data } = props;
      const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
      if (tasks.length === 0) return jsx('p', { className: 'qq-empty', children: t('remindersEmpty') }, 'empty');
      return jsx(
        'ul',
        {
          className: 'qq-taskList',
          children: tasks.map((task) => jsx(ReminderTaskRow, { t, task }, task.id)),
        },
        'list',
      );
    });

    /** 定时任务区块：取数（含定时刷新）+ 加载 / 失败 / 关闭 / 空 / 列表五种状态。 */
    const ReminderTasks = component(function ReminderTasks(props) {
      const { t } = props;
      const [reload, setReload] = useState(0);
      const [state, setState] = useState({ status: 'loading' });

      useEffect(() => {
        if (typeof fetch !== 'function') {
          setState({ status: 'error', message: 'fetch is unavailable' });
          return undefined;
        }
        let alive = true;
        const load = async () => {
          try {
            const response = await fetch(REMINDER_TASKS_PATH, {
              headers: { accept: 'application/json' },
              credentials: 'same-origin',
              cache: 'no-store',
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (alive) setState({ status: 'ready', data });
          } catch (error) {
            if (alive) setState({ status: 'error', message: String(error?.message ?? error) });
          }
        };
        void load();
        const timer = setInterval(load, REMINDER_REFRESH_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [reload]);

      // state 只可能是这三种形状；读到别的（旧版本残留、被意外替换）一律按「还在读」
      // 处理，宁可多转一圈也不要让整个设置页炸在渲染期。
      const view = state !== null && typeof state === 'object' && typeof state.status === 'string' ? state : { status: 'loading' };
      const data = view.status === 'ready' ? view.data : undefined;
      const toolbar = [
        data === undefined
          ? null
          : jsx('p', {
              className: 'qq-tasksCount',
              children: t('remindersCount', {
                pending: Number(data.pending) || 0,
                total: Number(data.total) || 0,
              }),
            }, 'count'),
        jsx(P.Pill, {
          onClick: () => setReload((value) => value + 1),
          children: t('remindersRefresh'),
        }, 'refresh'),
      ];

      let body;
      if (view.status === 'loading') {
        body = jsx('p', { className: 'qq-empty', role: 'status', children: t('remindersLoading') }, 'loading');
      } else if (view.status === 'error') {
        body = jsx('p', {
          className: 'qq-invalid',
          role: 'alert',
          children: t('remindersFailed', { message: view.message }),
        }, 'error');
      } else if (view.data?.enabled === false) {
        body = jsx('p', { className: 'qq-empty', children: t('remindersDisabled') }, 'disabled');
      } else {
        body = jsx(ReminderTaskList, { t, data: view.data }, 'tasks');
      }

      return jsxs(
        'section',
        {
          className: 'qq-section qq-tasksSection',
          'aria-labelledby': 'qq-reminders-title',
          children: [
            jsx('h3', {
              id: 'qq-reminders-title',
              className: 'qq-sectionTitle',
              children: t('remindersTitle'),
            }, 'title'),
            jsx('p', {
              className: 'qq-sectionNote',
              children: t('remindersNote', { seconds: Math.round(REMINDER_REFRESH_MS / 1000) }),
            }, 'note'),
            jsx('div', { className: 'qq-tasksToolbar', children: toolbar }, 'toolbar'),
            body,
          ],
        },
        'reminders',
      );
    });

    /** 工具条：搜索框 + 已改计数 + 只看已改 + 待修正计数。 */
    const Toolbar = component(function Toolbar(props) {      const { t, query, onlyChanged, changedCount, invalidCount, writable } = props;
      const items = [
        jsx(
          P.Input,
          {
            className: 'qq-search',
            type: 'search',
            value: query,
            placeholder: t('searchPlaceholder'),
            'aria-label': t('searchPlaceholder'),
            disabled: !writable,
            icon: typeof P.IconSearchOutlineRegular === 'function' ? jsx(P.IconSearchOutlineRegular, { size: 16 }) : undefined,
            onKeyDown: (event) => {
              // Esc 清空、焦点本来就还在搜索框里（不做 `/` 快捷键，见设计 D7）。
              if (event.key !== 'Escape') return;
              event.preventDefault();
              props.onQuery('');
            },
            onChange: (event) => {
              props.onQuery(event.target.value);
            },
          },
          'search',
        ),
        jsx('span', { className: 'qq-toolbarGap' }, 'gap'),
      ];
      if (changedCount > 0) {
        items.push(
          jsx(P.Tag, { tone: 'neutral', children: t('changedCount', { count: changedCount }) }, 'changed-count'),
        );
      }
      items.push(
        jsx(
          P.Pill,
          {
            className: 'qq-onlyChanged',
            active: onlyChanged,
            disabled: changedCount === 0,
            onClick: () => {
              props.onToggleOnlyChanged(!onlyChanged);
            },
            children: t('onlyChanged'),
          },
          'only-changed',
        ),
      );
      if (invalidCount > 0) {
        items.push(
          jsx(P.Tag, { tone: 'danger', children: t('invalidCount', { count: invalidCount }) }, 'invalid-count'),
        );
      }
      return jsx('div', { className: 'qq-toolbar', children: items }, 'toolbar');
    });

    /**
     * 下划线 tab（抄官方 Plugins 页）：`role=tablist/tab`、roving tabindex（只有当前
     * tab 是 tab stop）、←/→/Home/End 切换。焦点用 `parentElement.querySelectorAll`
     * 挪，不用 ref —— 组件就能是纯函数，测试里也不必给假 React 补 `useRef`。
     */
    const Tabs = component(function Tabs(props) {
      const { t, tabs, activeId, onSelect } = props;

      const onKeyDown = (event, index) => {
        let next;
        switch (event.key) {
          case 'ArrowRight':
            next = (index + 1) % tabs.length;
            break;
          case 'ArrowLeft':
            next = (index - 1 + tabs.length) % tabs.length;
            break;
          case 'Home':
            next = 0;
            break;
          case 'End':
            next = tabs.length - 1;
            break;
          default:
            return;
        }
        event.preventDefault();
        const nextTab = tabs[next];
        if (nextTab === undefined) return;
        onSelect(nextTab.id);
        const buttons = event.currentTarget?.parentElement?.querySelectorAll?.('[role="tab"]');
        buttons?.[next]?.focus?.();
      };

      return jsx('div', {
        className: 'qq-tabs',
        role: 'tablist',
        'aria-label': t('tabsLabel'),
        children: tabs.map((tab, index) => {
          const selected = tab.id === activeId;
          return jsx(
            'button',
            {
              id: `${TAB_ID_PREFIX}${tab.id}`,
              type: 'button',
              role: 'tab',
              className: 'qq-tab',
              'aria-selected': selected,
              'aria-controls': `${TAB_PANEL_ID_PREFIX}${tab.id}`,
              'data-active': selected ? 'true' : undefined,
              tabIndex: selected ? 0 : -1,
              title: tab.title,
              onClick: () => {
                onSelect(tab.id);
              },
              onKeyDown: (event) => {
                onKeyDown(event, index);
              },
              children: tab.label,
            },
            tab.id,
          );
        }),
      });
    });

    // ---- 页面 ------------------------------------------------------------------

    /** 去重：同一个 tab 里的区块只按 tab 的声明顺序渲染一次。 */
    function flatRows(tabs) {
      return tabs.flatMap((tab) => tab.sections.flatMap((section) => section.rows));
    }

    /** 页面的根组件：`view === 'summary'` 时只给一行简介（设置面板的导航项用它）。 */
    const QQ_BRIDGE = component(function QQ_BRIDGE(props) {
      const { t, useQqSettings } = props;
      if (props.view === 'summary') return t('intro');
      const state = useQqSettings((snapshot) => snapshot);
      const tabs = state.tabs;
      // 默认打开第一个 tab 的第一段；tab 记忆刻意不做（D2），刷新回到「连接」。
      const [activeId, setActiveId] = useState(tabs.length > 0 ? tabs[0].id : undefined);
      const [query, setQuery] = useState('');
      const [onlyChanged, setOnlyChanged] = useState(false);

      const writable = state.shell.writable;
      const rows = flatRows(tabs);
      const changedCount = countOverrides(rows);
      const invalidCount = rows.filter((row) => row.state.invalid === true).length;
      // 覆盖被「恢复默认」掉之后，开关要真的回到关：否则下次改一项时它会突然又生效，
      // 页面上只剩那一行。渲染期直接改自己的状态是 React 认可的「跟随数据校准」写法
      // （条件只会变一次，不会来回抖）。
      if (onlyChanged && changedCount === 0) setOnlyChanged(false);
      const changedOnly = onlyChanged && changedCount > 0;
      const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
      const searching = query.trim() !== '';

      const pageChildren = [
        jsx('h2', { className: 'qq-title', children: t('title') }, 'title'),
        jsx('p', { className: 'qq-intro', children: t('intro') }, 'intro'),
        jsx('p', { className: 'qq-notice', children: t('notice') }, 'notice'),
        jsx(
          Toolbar,
          {
            t,
            query,
            onlyChanged: changedOnly,
            changedCount,
            invalidCount,
            writable,
            onQuery: setQuery,
            onToggleOnlyChanged: setOnlyChanged,
          },
          'toolbar',
        ),
        jsx(
          Tabs,
          {
            t,
            tabs,
            activeId: active?.id,
            onSelect: (id) => {
              // 点 tab = 清空搜索并切过去（tab 是搜索结果的上下文，不是它的过滤器）。
              setActiveId(id);
              setQuery('');
            },
          },
          'tabs',
        ),
      ];

      if (searching || active === undefined) {
        // 搜索非空时只渲染扁平的匹配结果：所有控件只是同一个 SettingsFormModel 的
        // 视图，跨 tab 渲染没有状态问题，改完照样在底栏保存。
        const candidates = changedOnly ? rows.filter((row) => row.state.overridden === true) : rows;
        pageChildren.push(
          jsx(
            SearchResults,
            { t, rows: filterRows(candidates, query), edit: props.edit, resetField: props.resetField, writable },
            'results',
          ),
        );
      } else {
        const sections = active.sections
          .map((section) => ({
            ...section,
            rows: changedOnly ? section.rows.filter((row) => row.state.overridden === true) : section.rows,
          }))
          .filter((section) => section.rows.length > 0);
        // 「提醒」页最上面先给「现在记着哪些」：任务不是配置（schema 里没有），
        // 但用户打开这一页通常就是想看它们，所以排在配置字段前面。
        const panelSections = active.id === 'reminder' ? [jsx(ReminderTasks, { t }, 'reminders')] : [];
        panelSections.push(
          ...sections.map((section) =>
            jsx(SectionBlock, { section, t, edit: props.edit, resetField: props.resetField, writable }, section.id),
          ),
        );
        pageChildren.push(
          jsx(
            'div',
            {
              id: `${TAB_PANEL_ID_PREFIX}${active.id}`,
              className: 'qq-panel',
              role: 'tabpanel',
              'aria-labelledby': `${TAB_ID_PREFIX}${active.id}`,
              children: panelSections,
            },
            'panel',
          ),
        );
      }

      return jsx(
        P.SettingsForm,
        {
          labels: {
            unavailable: t('unavailable'),
            readOnly: t('readOnly'),
            saveFailed: t('saveFailed'),
            save: t('save'),
            saving: t('saving'),
          },
          state: state.shell,
          onSave: props.save,
          onDiscard: props.discard,
          children: jsx('div', { className: 'qq-page', children: pageChildren }, 'page'),
        },
        'form',
      );
    });

    // ---- 注册 ------------------------------------------------------------------

    /** 必到的服务：slot 注册表 / 字典 / 配置表单读取与提交 / schema 还原。 */
    const inject = ['slots', 'locale', 'configForms', 'settingsSchema'];

    /**
     * 挂上这一页。注册挂在 `settings.section`（侧栏「设置」左边那一列里的一页），
     * 与 `dsh-our-free-model` 等插件同一套 —— 组合包卡片上**不再**挂配置表单。
     *
     * 两层等待都不能省：
     *
     *   - `configForms.whileServed`：Host 没在服务这个设置命名空间时（插件没加载、
     *     或者这一行被停用）页面根本不注册，免得出现一个写不进去的空表单；
     *   - `slots.inject`：`settings.section` 由 dsh 的设置外壳在运行时声明，声明之前
     *     `slots.register` 会直接抛「slot ... is not declared」。inject 会等到它出现
     *     再调我们。
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      // 当前语言的短标签：优先 `getLocale()`（官方插件也这么取），拿不到再退回 `document.lang`。
      const localeTag = () => {
        try {
          const snapshot = typeof ctx.locale.getLocale === 'function' ? ctx.locale.getLocale() : ctx.locale.getSnapshot?.();
          if (typeof snapshot?.active === 'string') return snapshot.active;
        } catch {
          /* 读不到就按英文兜底 */
        }
        return typeof document !== 'undefined' && document.documentElement.lang !== '' ? document.documentElement.lang : 'en';
      };
      /**
       * 外壳已经给了 `t`（它按我们注册的 `locale: NS` 绑）时就用它，缺了才自己绑；
       * 两条路都拿不到某个键时退回键名本身 —— 页面上出现一个键名，总好过整页炸掉。
       * 占位符（`{count}` / `{tab}`）交给 `Translate(key, params)` 自己插。
       */
      const translator = (injected) => {
        const base = typeof injected === 'function' ? injected : t;
        return (key, params) => {
          const text = base(key, params);
          return typeof text === 'string' && text.length > 0 ? text : key;
        };
      };
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'qq-bridge:settings dictionary');
      const page = createPage(ctx);
      ctx.effect(
        () =>
          ctx.configForms.whileServed([ENTRY], () =>
            ctx.slots.inject(SECTION, () => {
              // 注册之前先建模型：`inject()` 送出去的就是它。
              const unmount = page.mount();
              const dispose = ctx.slots.register(
                {
                  name: SECTION,
                  id: ENTRY,
                  order: 40,
                  // 面板按 locale 重算导航标题，所以这里给函数而不是字符串。
                  label: () => t('navTitle'),
                  locale: NS,
                  inject: () => page.inject(),
                },
                // 外面包一层只是把字典与语言塞进 props（注册项的 options 到不了组件）。
                (props) => jsx(QQ_BRIDGE, { ...props, t: translator(props?.t), locale: localeTag() }),
              );
              return () => {
                dispose();
                unmount();
              };
            }),
          ),
        'qq-bridge:settings page',
      );
    }

    exports.NS = NS;
    exports.ENTRY = ENTRY;
    exports.SECTION = SECTION;
    exports.FIELD_ID_PREFIX = FIELD_ID_PREFIX;
    exports.apply = apply;
    exports.inject = inject;
    // 测试用：把纯函数露出来，好在 node 里钉住「分组不漏字段 / tab 不漏分组 /
    // 搜索能命中 / 量纲齐全」这类契约。
    exports.describeFields = describeFields;
    exports.specFor = specFor;
    exports.sectionOf = sectionOf;
    exports.tabOf = tabOf;
    exports.labelOf = labelOf;
    exports.deriveLabel = deriveLabel;
    exports.countOverrides = countOverrides;
    exports.filterRows = filterRows;
    exports.hintFor = hintFor;
    exports.labelForEnum = labelForEnum;
    exports.SECTIONS = SECTIONS;
    exports.TABS = TABS;
    exports.FIELD_HINTS = FIELD_HINTS;
    exports.NO_HINT = NO_HINT;
    exports.ENUM_LABELS = ENUM_LABELS;
    // 测试用：控件与页面组件露出来，好在 node 里直接渲染一次、钉住「布尔是 Switch /
    // 枚举是 select / 切 tab 不丢草稿 / 搜索可编辑」这些形状。
    exports.FieldShell = FieldShell;
    exports.SwitchRow = SwitchRow;
    exports.SelectField = SelectField;
    exports.ListField = ListField;
    exports.LongTextField = LongTextField;
    exports.QQ_BRIDGE = QQ_BRIDGE;
    exports.REMINDER_TASKS_PATH = REMINDER_TASKS_PATH;
    exports.REMINDER_REFRESH_MS = REMINDER_REFRESH_MS;
    exports.ReminderTaskRow = ReminderTaskRow;
    exports.ReminderTaskList = ReminderTaskList;
    exports.ReminderTasks = ReminderTasks;
    return module.exports;
  },
});
