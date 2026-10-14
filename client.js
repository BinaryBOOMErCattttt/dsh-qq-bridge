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
 *   1. **页面在哪里**：注册在 `settings.section`（侧栏「设置」左边那一列里的一页），
 *      与 `dsh-our-free-model` 等插件同一套。**不再**挂在插件页的组合包卡片下
 *      （`plugins.bundle.config`）—— 一百多个字段摊在「插件」页那张卡里，既难找又把
 *      插件页撑得没法看。
 *   2. **页面长什么样**：这一页**不写死任何字段**，可编辑字段来自 Host 送过来的那份
 *      schema（`config.js` 的 Config 是根 volatile，`dsh-settings` 的 `volatileForm`
 *      把整份配置投影成表单 schema），标签与说明也来自 schema 上的 `.description()`。
 *      于是「加一个配置项」只需要改 `config.js` 一处 —— 设置页自动多出一行。
 *      字段按 `SECTIONS` 分成十几组**折叠卡片**（默认只展开第一组），先给一张
 *      「有哪几组、哪几组已经被改过」的总览，再让人按需点开 —— 一条条平铺出来
 *      正是要避免的那种乱。
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
    const { Fragment, jsx, jsxs } = require('react/jsx-runtime');
    const P = require('@deepseek-ai/dsh-client-ui-primitives');

    const useSyncExternalStore = React.useSyncExternalStore;
    const useState = React.useState;

    /** 本页文案的字典命名空间（`ctx.locale.register` 的那把钥匙）。 */
    const NS = 'settings.qq';
    /**
     * 设置命名空间 = **profile 条目 id**。DSH 的配置表单按 Loader 条目 id 认插件，
     * 而本组合包的 patch（cordis.patch.yml）里那一行的 id 就是 `qq-bridge`。
     */
    const ENTRY = 'qq-bridge';
    /** 设置面板里的那一页。 */
    const SECTION = 'settings.section';
    /** 字段控件的 id 前缀（`SettingsValueField` 靠它把 label 与 input 连起来）。 */
    const FIELD_ID_PREFIX = 'qq-config-';

    // ---- 文案 ------------------------------------------------------------------

    const zh = {
      navTitle: 'QQ Bridge',
      title: 'QQ Bridge',
      intro: 'QQ 桥接的全部配置，按用途分成十几组；点开一组改其中的项，改完在页面底部一次保存。',
      notice: '保存会把改动写进当前 profile 的 cordis.patch.yml（其余字段原样保留），随后插件会重启一次以应用新配置：连接会断开重连，聊天记忆不受影响。',
      envNotice: '环境变量（QQBOT_*）提供的取值会以表达式原样写回，不会因为在界面上点了一次保存而失效。',
      groupsHint: '点标题展开这一组；右侧的记号表示这一组里有没有被改过的项。',
      changed: '已改',
      helpLabel: '字段说明',
      keyLabel: '配置项',
      acceptLabel: '可填的值',
      overridden: '已覆盖',
      reset: '恢复默认',
      invalidNumber: '请填数字；留空表示使用默认值',
      invalidBoolean: '请填 true 或 false；留空表示使用默认值',
      invalidChoice: '请填上面列出的某个值；留空表示使用默认值',
      invalidList: '多个值用逗号（中英文都行）或换行分隔；留空表示清空',
      hintBoolean: 'true / false',
      hintList: '多个值用逗号分隔；留空 = 清空',
      unavailable: '该插件当前未加载，暂时无法配置。',
      readOnly: '本部署的设置为只读。',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      save: '保存',
      saving: '保存中…',
    };
    const en = {
      navTitle: 'QQ Bridge',
      title: 'QQ Bridge',
      intro: 'Every QQ bridge setting, grouped by purpose; open a group, change what you need, then save once at the bottom of the page.',
      notice: 'Saving writes the change into this profile’s cordis.patch.yml (every other field is preserved), then the plugin restarts once to apply it: the connection drops and reconnects, chat memory is kept.',
      envNotice: 'Values that come from environment variables (QQBOT_*) are written back as expressions, so one save here does not freeze them.',
      groupsHint: 'Select a title to expand that group; the mark on the right shows whether it holds changed fields.',
      changed: 'changed',
      helpLabel: 'Field help',
      keyLabel: 'Config key',
      acceptLabel: 'Accepted values',
      overridden: 'Overridden',
      reset: 'Reset to default',
      invalidNumber: 'Enter a number, or leave blank to use the default.',
      invalidBoolean: 'Enter true or false, or leave blank to use the default.',
      invalidChoice: 'Enter one of the values listed above, or leave blank to use the default.',
      invalidList: 'Separate values with commas (either kind) or newlines; leave blank to clear.',
      hintBoolean: 'true / false',
      hintList: 'comma-separated; blank clears',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      readOnly: 'This deployment stores settings read-only.',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      save: 'Save',
      saving: 'Saving…',
    };

    // ---- 分组与标签 ------------------------------------------------------------
    //
    // 分组只能由这里给出（schema 里没有「这一项属于哪一段」这种元数据），按字段名
    // 的显式清单 + 前缀来分；认不出来的落进「其它」—— test/client.test.mjs 会钉住
    // 「当前没有字段落进其它」，将来加了配置项又忘了分组时它就会红。

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
      // 人设与额外要求单独一张卡片：它们是一整段提示词（内置人设本身就有十来行），
      // 混在「QQ 会话与 Agent」那堆开关里既难找、也只能挤在一行输入框里改（见 LONG_TEXT_FIELDS）。
      {
        id: 'persona',
        title: '人设与提示词',
        fields: ['persona', 'instructions'],
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
        fields: ['batchWindowMs', 'batchMaxWaitMs', 'ambientMessages', 'ambientLineChars'],
      },
      { id: 'repeat', title: '自动复读', prefix: ['repeat'] },
      { id: 'proactive', title: '主动说话（冷场时自己冒个泡）', prefix: ['proactive'] },
      { id: 'active', title: '活跃对话（聊起来之后保持搭话）', prefix: ['active'] },
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
      { id: 'jm', title: '禁漫下载（JM → PDF → 发到 QQ）', prefix: ['jm'] },
      { id: 'memory', title: '长期记忆（转录 / 摘要 / 认知库）', prefix: ['memory', 'digest'] },
      { id: 'apikey', title: '模型凭据轮换', prefix: ['apiKey'] },
    ];
    const OTHER_SECTION = { id: 'other', title: '其它' };

    /**
     * 少数几个字段的短标签：信息足够时标签直接从 `.description()` 的第一段取
     * （见 `deriveLabel`），这里只覆盖那些取出来读不通的。想永久改掉一个标签，
     * 在 `config.js` 的字段上加 `.comment('…')` 更合适 —— schema 上的 comment
     * 优先级比这份表还高（`labelOf`）。
     */
    const LABEL_OVERRIDES = {
      quoteMedia: '被引用的消息也一起看',
      imageSend: '让 Agent 主动发图',
      napcatAutoConfig: '自动补 NapCat 配置',
      prefix: '前缀触发用的前缀',
      agentPreset: 'QQ 会话的 Agent 预设',
      resetUsers: '谁能新开一轮会话',
      allowTools: 'QQ 会话的工具白名单',
      persona: '人设（群友口吻）',
      instructions: '额外要求（追加）',
      batchWindowMs: '攒批窗口（毫秒）',
      batchMaxWaitMs: '整批等待上限（毫秒）',
      activeMaxTurns: '免 @ 接话的条数上限',
      activeGroupSpeakers: '多人搭话要几个人',
      activeChimeIdleMs: '补一句前的安静时间',
      activeChimeMax: '每轮最多补几句',
      memorySearchHits: '搜索最多返回几条',
      jmFileHost: 'NapCat 取 PDF 用的地址',
    };

    /**
     * 需要用**多行输入框**改的字段。这两项是一整段提示词（只写一句也算，但内置人设
     * 本身就有十来行），而 primitives 的 `SettingsValueField` 只有单行 `<input>`：
     * 那么长的正文挤在一条输入框里只能看到最后一截，等于盲改。名单写在这里而不是
     * schema 里 —— schema 管「配置的取值口径」，控件长什么样是界面自己的事。
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

    /** 这一组里有几项是「用户改过、保存后会留下一层覆盖」的（折叠时也看得见）。 */
    function countOverrides(rows) {
      return rows.filter((row) => row.state?.overridden === true).length;
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

    /** 布尔字段：存的是 true/false，界面是文本框，所以两边都要宽容一点。 */
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

    /** 短提示：有「可填什么」的字段就说可填什么，其余用描述的第一行。 */
    function hintOf(kind, node, choices) {
      if (kind === 'boolean') return zh.hintBoolean;
      if (kind === 'list') return zh.hintList;
      if (kind === 'choice' && choices.length > 0) return choices.join(' / ');
      const description = node?.meta?.description;
      if (typeof description !== 'string') return '';
      const line = description.split('\n')[0].trim();
      return line.length > 72 ? `${line.slice(0, 71)}…` : line;
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
        return {
          key,
          node,
          kind,
          choices,
          section: sectionOf(key),
          label: labelOf(key, node),
          description: typeof node?.meta?.description === 'string' ? node.meta.description : '',
          hint: hintOf(kind, node, choices),
          placeholder: placeholderOf(kind, node, choices),
          numeric: kind === 'number',
          long: LONG_TEXT_FIELDS.has(key),
          invalidLabel:
            kind === 'number'
              ? zh.invalidNumber
              : kind === 'boolean'
                ? zh.invalidBoolean
                : kind === 'choice'
                  ? zh.invalidChoice
                  : kind === 'list'
                    ? zh.invalidList
                    : zh.invalidNumber,
        };
      });
    }

    // ---- 表单模型 --------------------------------------------------------------

    /**
     * 一页的暂存表单：primitives 的 `SettingsFormModel` 负责草稿、校验与一次提交，
     * 这里只负责「把字段按分组摆好」这件事。
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

      function project(model, fields) {
        const shell = model.shell();
        const order = [...SECTIONS, OTHER_SECTION];
        const sections = order
          .map((section) => ({
            id: section.id,
            title: section.title,
            rows: fields
              .filter((row) => row.section.id === section.id)
              .map((row) => ({ ...row, state: model.field(row.key) })),
          }))
          .filter((section) => section.rows.length > 0);
        return { shell, sections };
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

    // ---- 页面 ------------------------------------------------------------------
    //
    // 视觉一律走 `--dsw-*` 主题变量（与 primitives 同一套 token），不引任何外部
    // 样式表：手写 bundle 里没有构建好的 CSS 可以 import。

    const PAGE_STYLE = { maxWidth: '720px', display: 'flex', flexDirection: 'column' };
    const TITLE_STYLE = {
      margin: '0 0 6px',
      fontSize: '16px',
      fontWeight: 500,
      lineHeight: '24px',
      color: 'var(--dsw-alias-label-primary)',
    };
    const INTRO_STYLE = {
      margin: '0 0 4px',
      fontSize: '13px',
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-tertiary)',
    };
    const NOTICE_STYLE = {
      margin: '0 0 4px',
      fontSize: '12px',
      lineHeight: '1.6',
      color: 'var(--dsw-alias-label-tertiary)',
    };
    const GROUP_LIST_STYLE = { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' };
    const CARD_STYLE = {
      border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
      background: 'var(--dsw-alias-settings-card-fill)',
      borderRadius: 'var(--dsw-radius-xl)',
      overflow: 'hidden',
    };
    const CARD_HEAD_STYLE = {
      boxSizing: 'border-box',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      width: '100%',
      padding: '12px 14px',
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '14px',
      lineHeight: '22px',
      textAlign: 'left',
      cursor: 'pointer',
    };
    const GROUP_TITLE_STYLE = { flex: '1 1 auto', minWidth: 0 };
    /** 折叠时也显示「这组改过几项」：宽高固定，展开与折叠时标题左边缘不会跳动。 */
    const CHANGED_STYLE = {
      flex: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: '12px',
      lineHeight: '18px',
    };
    const DOT_STYLE = {
      width: '6px',
      height: '6px',
      borderRadius: '50%',
      background: 'var(--dsw-alias-state-business-primary)',
    };
    const EMPTY_MARK_STYLE = { flex: 'none', width: '6px', height: '6px' };
    const CHEVRON_STYLE = {
      flex: 'none',
      width: '7px',
      height: '7px',
      borderRight: '1.5px solid currentColor',
      borderBottom: '1.5px solid currentColor',
      transform: 'rotate(-45deg)',
      opacity: 0.7,
    };
    const CARD_BODY_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      padding: '12px 14px 14px',
      borderTop: '0.5px solid var(--dsw-alias-border-l2)',
    };

    /** 折叠卡片的标题行（受控：开关状态在页面里，见 `QQ_BRIDGE`）。 */
    function groupHeader(options) {
      const { id, title, expanded, changed, t, onToggle } = options;
      const head = [jsx('span', { style: GROUP_TITLE_STYLE, children: title }, 'title')];
      if (changed > 0) {
        head.push(
          jsxs(
            'span',
            {
              style: CHANGED_STYLE,
              title: `${changed} ${t('overridden')}`,
              children: [jsx('span', { style: DOT_STYLE }, 'dot'), `${changed} ${t('changed')}`],
            },
            'changed',
          ),
        );
      } else {
        head.push(jsx('span', { style: EMPTY_MARK_STYLE }, 'changed-empty'));
      }
      head.push(
        jsx(
          'span',
          { style: { ...CHEVRON_STYLE, transform: expanded ? 'rotate(45deg)' : 'rotate(-45deg)' } },
          'chevron',
        ),
      );
      return jsx(
        'button',
        {
          type: 'button',
          style: CARD_HEAD_STYLE,
          'aria-expanded': expanded ? 'true' : 'false',
          'aria-controls': `qq-group-${id}`,
          onClick: () => {
            onToggle(id);
          },
          children: head,
        },
        'head',
      );
    }

    // 长文本字段的样式：取值与 primitives 的 fields.module.css 对齐（同一套 `--dsw-*`
    // 变量、同一套字号/边框/底色），免得自定义控件在表单里显得像另一个应用。

    const LONG_FIELD_STYLE = { display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 0' };
    const LONG_FIELD_DIVIDED_STYLE = { ...LONG_FIELD_STYLE, borderTop: '0.5px solid var(--dsw-alias-border-l2)' };
    const FIELD_HEAD_STYLE = { display: 'flex', alignItems: 'center', gap: '8px' };
    const FIELD_LABEL_STYLE = {
      flex: '0 1 auto',
      minWidth: 0,
      fontSize: '13px',
      fontWeight: 500,
      lineHeight: '1.5',
      color: 'var(--dsw-alias-label-primary)',
    };
    const FIELD_BADGES_STYLE = {
      flex: '1 1 auto',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: '8px',
      fontSize: '12px',
      lineHeight: '1.5',
      color: 'var(--dsw-alias-label-tertiary)',
    };
    const HELP_BUTTON_STYLE = {
      flex: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '24px',
      height: '24px',
      padding: 0,
      border: 0,
      borderRadius: 'var(--dsw-radius-sm)',
      background: 'none',
      color: 'var(--dsw-alias-label-tertiary)',
      font: 'inherit',
      cursor: 'pointer',
    };
    const RESET_BUTTON_STYLE = {
      border: 'none',
      background: 'none',
      padding: 0,
      font: 'inherit',
      fontSize: '12px',
      lineHeight: '1.5',
      color: 'var(--dsw-alias-label-secondary)',
      cursor: 'pointer',
    };
    const LONG_TEXTAREA_STYLE = {
      boxSizing: 'border-box',
      width: '100%',
      padding: '8px 12px',
      border: '0.5px solid var(--dsw-alias-border-l4)',
      borderRadius: 'var(--dsw-radius-md)',
      background: 'var(--dsw-alias-bg-layer-3)',
      font: 'inherit',
      fontSize: '13px',
      lineHeight: '1.6',
      color: 'var(--dsw-alias-label-primary)',
      resize: 'vertical',
    };
    const LONG_HINT_STYLE = { margin: 0, fontSize: '12px', lineHeight: '1.5', color: 'var(--dsw-alias-label-tertiary)' };
    const LONG_INVALID_STYLE = { margin: 0, fontSize: '12px', lineHeight: '1.5', color: 'var(--dsw-alias-state-error-primary)' };
    const HELP_PANEL_STYLE = { padding: '10px 0 0', fontSize: '12px', lineHeight: '1.6', color: 'var(--dsw-alias-label-secondary)' };
    /** 多行框的默认高度：够看清十来行人设，再长自己往下拖（`resize: vertical`）。 */
    const LONG_TEXT_ROWS = 10;
    /** primitives 的 help 按钮里那颗 ⓘ；万一取不到就退一个字，别整页炸掉。 */
    const helpGlyph = typeof P.IconInfoOutlineRegular === 'function' ? jsx(P.IconInfoOutlineRegular, { size: 12 }) : 'ⓘ';

    /**
     * 长文本字段的控件（人设 / 额外要求）。
     *
     * 为什么自己画一个而不是用 `SettingsValueField`：那个控件只有单行 `<input>`，
     * 一整段人设挤进去只能看到最后一截。props 口径与它保持一致（`text` / `invalid` /
     * `overridden` / `onEdit` / `onReset` / `help`），于是 `renderField` 只是换个组件，
     * 草稿、校验、保存一个字都不用动 —— spec 那边仍然是 `settingsTextField`。
     */
    function LongTextField(props) {
      const [helpOpen, setHelpOpen] = useState(false);
      const helpId = `${props.id}-help`;
      const messageId = `${props.id}-message`;
      const hasMessage = props.invalid || Boolean(props.hint);
      const describedBy = [hasMessage ? messageId : '', helpOpen ? helpId : ''].filter(Boolean).join(' ');
      const head = [
        jsx('label', { style: FIELD_LABEL_STYLE, htmlFor: props.id, children: props.label }, 'label'),
        props.help !== undefined
          ? jsx(
              'button',
              {
                type: 'button',
                style: HELP_BUTTON_STYLE,
                'aria-label': props.help.label,
                'aria-expanded': helpOpen,
                'aria-controls': helpId,
                onClick: () => {
                  setHelpOpen(!helpOpen);
                },
                children: helpGlyph,
              },
              'help-button',
            )
          : null,
        props.overridden
          ? jsxs(
              'span',
              {
                style: FIELD_BADGES_STYLE,
                children: [
                  jsx('span', { children: props.overriddenLabel }, 'overridden'),
                  jsx(
                    'button',
                    {
                      type: 'button',
                      style: RESET_BUTTON_STYLE,
                      disabled: props.disabled,
                      onClick: () => {
                        props.onReset();
                      },
                      children: props.resetLabel,
                    },
                    'reset',
                  ),
                ],
              },
              'badges',
            )
          : null,
      ];
      const children = [
        jsxs('div', { style: FIELD_HEAD_STYLE, children: head }, 'head'),
        jsx(
          'textarea',
          {
            id: props.id,
            style: props.invalid
              ? { ...LONG_TEXTAREA_STYLE, borderColor: 'var(--dsw-alias-state-error-primary)' }
              : LONG_TEXTAREA_STYLE,
            rows: LONG_TEXT_ROWS,
            ...(props.invalid ? { 'aria-invalid': true } : {}),
            'aria-describedby': describedBy || undefined,
            value: props.text,
            placeholder: props.placeholder ?? '',
            disabled: props.disabled,
            onChange: (event) => {
              props.onEdit(event.target.value);
            },
          },
          'control',
        ),
      ];
      if (hasMessage) {
        children.push(
          jsx(
            'p',
            { id: messageId, style: props.invalid ? LONG_INVALID_STYLE : LONG_HINT_STYLE, children: props.invalid ? props.invalidLabel : props.hint },
            'message',
          ),
        );
      }
      if (props.help !== undefined && helpOpen) {
        children.push(
          jsx(
            'div',
            { id: helpId, style: HELP_PANEL_STYLE, role: 'region', 'aria-label': props.help.label, children: props.help.content },
            'help',
          ),
        );
      }
      return jsxs('div', { style: props.divided ? LONG_FIELD_DIVIDED_STYLE : LONG_FIELD_STYLE, children }, 'field');
    }

    function helpContent(row, t) {
      const paragraphs = [];
      if (row.description.length > 0) {
        paragraphs.push(jsx('p', { children: row.description }, 'description'));
      }
      if (row.choices.length > 0) {
        paragraphs.push(jsx('p', { children: `${t('acceptLabel')}: ${row.choices.join(' / ')}` }, 'choices'));
      }
      paragraphs.push(jsx('p', { children: `${t('keyLabel')}: ${row.key}` }, 'key'));
      return jsxs('div', { children: paragraphs }, 'help');
    }

    function renderField(row, props, writable, t, divided) {
      // 单行 / 多行两种控件：props 口径相同，只有控件本身不一样（见 LongTextField）。
      const Control = row.long ? LongTextField : P.SettingsValueField;
      return jsx(
        Control,
        {
          id: `${FIELD_ID_PREFIX}${row.key}`,
          label: row.label,
          hint: row.hint,
          help: { label: t('helpLabel'), content: helpContent(row, t) },
          numeric: row.numeric,
          placeholder: row.placeholder,
          disabled: !writable,
          divided,
          overriddenLabel: t('overridden'),
          resetLabel: t('reset'),
          invalidLabel: row.invalidLabel,
          ...row.state,
          onEdit: (text) => {
            props.edit(row.key, text);
          },
          onReset: () => {
            props.resetField(row.key);
          },
        },
        row.key,
      );
    }

    /**
     * 一组折叠卡片：标题行永远在，字段只在展开时渲染。
     *
     * 为什么不把十几组一次全摊开：一百多项一次铺满整页，等于把「插件页那张卡撑爆」
     * 换了个地方重演。收起时只留下组名 + 「这组改过几项」，滑一遍就知道全貌。
     */
    function renderGroup(section, options) {
      const { expanded, t, props, writable } = options;
      const changed = countOverrides(section.rows);
      const body = expanded
        ? jsx(
            'div',
            { id: `qq-group-${section.id}`, style: CARD_BODY_STYLE, children: section.rows.map((row, index) => renderField(row, props, writable, t, index > 0)) },
            'body',
          )
        : null;
      return jsxs(
        'section',
        {
          style: CARD_STYLE,
          children: [
            groupHeader({
              id: section.id,
              title: section.title,
              expanded,
              changed,
              t,
              onToggle: options.onToggle,
            }),
            body,
          ],
        },
        section.id,
      );
    }

    /** 页面的根组件：`view === 'summary'` 时只给一行简介（设置面板的导航项用它）。 */
    function QQ_BRIDGE(props) {
      const { t, useQqSettings } = props;
      if (props.view === 'summary') return t('intro');
      const state = useQqSettings((snapshot) => snapshot);
      const sections = state.sections;
      // 默认展开第一组：打开页面就有东西可改，其余组保持收起。
      const [openId, setOpenId] = useState(sections.length > 0 ? sections[0].id : undefined);
      const writable = state.shell.writable;
      const toggle = (id) => {
        setOpenId(openId === id ? undefined : id);
      };
      const children = [
        jsxs(
          Fragment,
          {
            children: [
              jsx('h2', { style: TITLE_STYLE, children: t('title') }, 'title'),
              jsx('p', { style: INTRO_STYLE, children: t('intro') }, 'intro'),
              jsx('p', { style: NOTICE_STYLE, children: t('notice') }, 'notice'),
              jsx('p', { style: NOTICE_STYLE, children: t('envNotice') }, 'env-notice'),
              jsx('p', { style: INTRO_STYLE, children: t('groupsHint') }, 'groups-hint'),
            ],
          },
          'intro',
        ),
      ];
      children.push(
        jsx(
          'div',
          {
            style: GROUP_LIST_STYLE,
            children: sections.map((section) =>
              renderGroup(section, {
                expanded: section.id === openId,
                onToggle: toggle,
                t,
                props,
                writable,
              }),
            ),
          },
          'groups',
        ),
      );
      return jsxs(
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
          children: jsx('div', { style: PAGE_STYLE, children }, 'page'),
        },
        'form',
      );
    }

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
       */
      const translator = (injected) => {
        const base = typeof injected === 'function' ? injected : t;
        return (key) => {
          const text = base(key);
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
    // 测试用：把纯函数露出来，好在 node 里钉住「分组不漏字段 / 标签不为空」这类契约。
    exports.describeFields = describeFields;
    exports.specFor = specFor;
    exports.sectionOf = sectionOf;
    exports.labelOf = labelOf;
    exports.deriveLabel = deriveLabel;
    exports.countOverrides = countOverrides;
    exports.SECTIONS = SECTIONS;
    // 测试用：长文本那一路是自己画的控件（primitives 只有单行输入），单独露出来，
    // 好钉住「人设那一组用的是多行框、textarea 的取值与回调接对了」。
    exports.LongTextField = LongTextField;
    // 测试用：注册项外面包了一层（把字典与语言塞进 props），页面的根组件单独露出来，
    // 好在 node 里直接渲染一次、钉住「折叠 / 分组 / 字段」的形状。
    exports.QQ_BRIDGE = QQ_BRIDGE;
    return module.exports;
  },
});
