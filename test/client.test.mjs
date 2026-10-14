/**
 * 浏览器半侧（`client.js`）的契约测试。
 *
 * 这份文件是手写的「已构建 bundle」，它的形状由 `dsh-client-modules` 决定（工厂函数
 * + `exports.apply` / `exports.inject`），而它**不经过 index.js**：真宿主把它作为
 * 浏览器 bundle 发给页面，挂在 Loader 里那一行（`name: '@qqbot/dsh-plugin-qq'`）上。
 *
 * 所以这里用最小的假 Host 把它跑一遍：假的 `window.__ModuleLoader__` 收下注册，
 * 假的 `require` 给出平台模块（react / jsx-runtime / ui-primitives 都是桩 —— 真
 * 浏览器 bundle 里有 CSS import，node 里加载不了），然后断言四件真正会坏掉的事：
 *
 *   1. **注册位置**：`settings.section` + 条目 id（写错就等于页面根本不出现）；
 *   2. **字段覆盖**：schema 里的每一个配置项都必须在页面上出现一次、且不在「其它」
 *      分组里（漏一个 = 界面上改不了这一项），标签不能是空串；
 *   3. **分组是折叠的**：默认只展开第一组、点标题才渲染那一组的字段（一条条平铺出来
 *      正是这次要避免的乱）；
 *   4. **草稿的读写口径**：布尔 / 数组 / 枚举三类字段自己实现的 spec，必须能把
 *      `true`/`是`、逗号分隔、枚举字面量解析成 set，把空串解析成 clear，把胡说挡住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import z from '@deepseek-ai/schemastery';
import { Config } from '../config.js';

// ---- 假的浏览器模块系统 ------------------------------------------------------------

let registration;
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registration = entry;
    },
  },
};
await import('../client.js');
delete globalThis.window;

/**
 * 假 react：`useSyncExternalStore` 与 `useState` 各留一个单槽实现。
 *
 * 这是「假 StrictMode」的等价物：不排队重渲染，只把 setter 的入参记下来，
 * 于是用例可以像 React 那样「调 setter → 再渲染一次」地驱动折叠/展开。
 *
 * 单槽的「没初始化」不能用 `undefined` 表示 —— 本页的折叠状态本来就允许被
 * setter 设成 `undefined`（全部收起），拿它当哨兵会让「点了两次」变成
 * 「从没点过」。所以另给一个 `UNSET`。
 */
const UNSET = Symbol('unset');
const reactHooks = { store: undefined, state: UNSET };
const reactStub = {
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useState: (initial) => {
    if (reactHooks.state === UNSET) {
      reactHooks.state = typeof initial === 'function' ? initial() : initial;
    }
    return [reactHooks.state, (next) => { reactHooks.state = next; }];
  },
};
const jsxRuntimeStub = {
  Fragment: 'Fragment',
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
};

/** 假的 ui-primitives：只保留本页面用到的那几个入口，行为与文档一致。 */
const primitivesStub = {
  settingsTextField: (field) => ({
    field,
    format: (value) => (typeof value === 'string' ? value : ''),
    parse: (text) => (text.trim() === '' ? { kind: 'clear' } : { kind: 'set', value: text.trim() }),
  }),
  settingsNumberField: (field) => ({
    field,
    format: (value) => (typeof value === 'number' ? String(value) : ''),
    parse: (text) => {
      if (text.trim() === '') return { kind: 'clear' };
      const parsed = Number(text.trim());
      return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined;
    },
  }),
  SettingsForm: 'SettingsForm',
  SettingsValueField: 'SettingsValueField',
  /** 只留这一页真正会调的那几个方法；字段的暂存交给真 primitives（浏览器里）。 */
  SettingsFormModel: class {
    constructor(scope, specs) {
      this.scope = scope;
      this.specs = specs;
    }
    shell() {
      return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false };
    }
    field() {
      return { text: '', overridden: false, invalid: false };
    }
    bind(project) {
      const snapshot = project();
      return { getSnapshot: () => snapshot, subscribe: () => () => {} };
    }
    actions() {
      return { edit() {}, resetField() {}, save() {}, discard() {} };
    }
    dispose() {}
  },
};

const fakeRequire = (id) => {
  if (id === 'react') return reactStub;
  if (id === 'react/jsx-runtime') return jsxRuntimeStub;
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub;
  throw new Error(`意外的平台模块请求：${id}`);
};

// ---- 假的客户端 Host ---------------------------------------------------------------

/** 当前 profile 条目 id 对应的设置命名空间视图：schema 用真 Config 的 toJSON。 */
function namespaceView() {
  return {
    ns: 'qq-bridge',
    autoGenerate: true,
    schema: JSON.parse(JSON.stringify(Config.toJSON())),
    value: JSON.parse(JSON.stringify(Config({}).get())),
    user: {},
    base: {},
    secrets: [],
    revision: 1,
    applies: 'live',
  };
}

/** 一个最小的客户端上下文：只实现 client.js 用到的那些服务。 */
function makeClientHost() {
  const host = {
    dictionaries: new Map(),
    registrations: [],
    slotInjects: [],
    disposed: [],
    scope: {
      written: [],
      getSnapshot: () => ({ status: 'ready', value: {}, base: {}, user: {}, writable: true, revision: 1, mode: 'host' }),
      subscribe: () => () => {},
      mutate: async (ops) => {
        host.scope.written.push(ops);
        return true;
      },
    },
    ctx: {
      effect(body) {
        const dispose = body();
        host.disposed.push(dispose);
        return () => {};
      },
      locale: {
        bind: () => (key) => key,
        getLocale: () => ({ active: 'zh', locales: [], revision: 1 }),
        register: (ns, dict) => {
          host.dictionaries.set(ns, dict);
          return () => {};
        },
      },
      settingsSchema: { rehydrate: (serialized) => new z(serialized) },
      configForms: {
        describe: () => ({
          getSnapshot: () => ({ status: 'ready', view: { namespaces: [namespaceView()], writable: true, hasDocument: true } }),
          subscribe: () => () => {},
          ensure: () => Promise.resolve(),
        }),
        get: () => host.scope,
        whileServed: (namespaces, register) => {
          const off = register(new Set(namespaces));
          return () => off?.();
        },
      },
      slots: {
        /** 真实实现只在目标 slot 被声明之后才跑回调（声明前 register 会直接抛）。 */
        inject(name, register) {
          host.slotInjects.push(name);
          const off = register();
          return () => off?.();
        },
        register(options, component) {
          host.registrations.push({ options, component });
          return () => {};
        },
      },
    },
  };
  return host;
}

/** 跑一遍 apply()，把这一页的注册与注入面拿回来。 */
function mountPage() {
  const host = makeClientHost();
  registration.factory(fakeRequire);
  // 上面那句建了 module.exports 的副本，这里再取一次真正的导出面。
  const mod = registration.factory(fakeRequire);
  mod.apply(host.ctx);
  return { host, mod, page: host.registrations[0] };
}

/**
 * 渲染页面根组件（框架平时通过 slot props 注入的那些东西在这里手工给），
 * 模拟「组件第一次挂载」：`useState` 的单槽实现先清空，折叠状态从默认值开始。
 */
function mountTree(page, mod, extra = {}) {
  reactHooks.state = UNSET;
  return rerender(page, mod, extra);
}

/**
 * 再渲染一次，沿用上一次的 `useState` 槽 —— 等价于 React 在 setter 之后的重渲染，
 * 折叠 / 展开就是靠它驱动的。
 */
function rerender(page, mod, extra = {}) {
  const face = page.options.inject();
  return mod.QQ_BRIDGE({
    t: (key) => key,
    view: 'page',
    locale: 'zh',
    useQqSettings: (selector) => selector(face.hooks.qqSettings.getSnapshot()),
    edit: face.edit,
    resetField: face.resetField,
    save: face.save,
    discard: face.discard,
    ...extra,
  });
}

/** 从 SettingsForm 的 children 里挖出所有分组的卡片节点（每组一个 `section`）。 */
function groupCards(tree) {
  const page = tree.props.children;
  const list = page.props.children.find((child) => child.type === 'div' && Array.isArray(child.props.children));
  return list.props.children;
}

/** 一组卡片里的字段控件（收起时是空数组）。 */
function fieldsOf(card) {
  const body = card.props.children.find((child) => child?.type === 'div');
  if (body === undefined) return [];
  return body.props.children.filter((child) => child.type === 'SettingsValueField');
}

/** 一组卡片里的**全部**控件：长文本那几项是自定义控件，`fieldsOf` 认不出来。 */
function controlsOf(card) {
  const body = card.props.children.find((child) => child?.type === 'div');
  return body === undefined ? [] : body.props.children;
}

/** 按分组 id 找出那张卡片（展开与否都找得到，全是组名时也在）。 */
function cardOf(tree, id) {
  return groupCards(tree).find((card) => headOf(card).props['aria-controls'] === `qq-group-${id}`);
}

/** 一组卡片的标题行。 */
function headOf(card) {
  return card.props.children[0];
}

// ---- 用例 -------------------------------------------------------------------------

test('浏览器半侧的注册形状：工厂 ID、必到服务、页面挂在设置面板的 section 位上', () => {
  const { host, mod, page } = mountPage();

  assert.equal(registration.id, '@qqbot/dsh-plugin-qq', '工厂 ID 必须等于包名（客户端模块系统按它认这一行）');
  assert.deepEqual(mod.inject, ['slots', 'locale', 'configForms', 'settingsSchema']);
  assert.equal(mod.ENTRY, 'qq-bridge');
  assert.equal(mod.SECTION, 'settings.section');

  // `settings.section` 由 dsh 的设置外壳在运行时声明：直接 register 会抛
  // 「slot ... is not declared」，必须走 slots.inject 等声明。
  assert.deepEqual(host.slotInjects, ['settings.section']);

  assert.ok(page, 'apply() 必须注册一页设置');
  assert.equal(page.options.name, 'settings.section', '配置页住在设置面板里，不再挂在插件页的组合包卡片下');
  assert.equal(page.options.id, 'qq-bridge', 'id 是 profile 条目 id，写错页面就不出现');
  assert.equal(page.options.locale, 'settings.qq');
  assert.equal(page.options.label(), 'navTitle', '导航标题来自本页字典');
});

test('注入面：hooks 里的 observable 与四个表单动作都在', () => {
  const { page } = mountPage();
  const face = page.options.inject();

  assert.equal(typeof face.hooks.qqSettings.getSnapshot, 'function');
  assert.equal(typeof face.hooks.qqSettings.subscribe, 'function');
  for (const action of ['edit', 'resetField', 'save', 'discard']) {
    assert.equal(typeof face[action], 'function', `${action} 必须注入`);
  }
});

test('字段覆盖：schema 里每一项都上了页面、都有标签、都不落进「其它」', () => {
  const { mod, page } = mountPage();
  const fields = mod.describeFields(new z(JSON.parse(JSON.stringify(Config.toJSON()))));
  const keys = fields.map((row) => row.key);
  const schemaKeys = Object.keys(Config.toJSON().refs[Config.toJSON().uid].dict);

  assert.deepEqual([...keys].sort(), [...schemaKeys].sort(), '页面字段必须与 schema 字段一一对应');
  assert.equal(new Set(keys).size, keys.length, '同一个字段不能出现两次');

  const orphans = fields.filter((row) => row.section.id === 'other').map((row) => row.key);
  assert.deepEqual(orphans, [], '每个字段都要有归属的分组（加了配置项忘了分组时这里会红）');

  for (const row of fields) {
    assert.ok(row.label.length > 0 && row.label !== row.key, `${row.key} 的标签不该退化成字段名`);
    assert.ok(row.description.length > 0, `${row.key} 必须带 .description()（它就是界面上的说明）`);
  }
});

test('表单投影：分组里的行数加起来正好是全部字段，每组标题非空', () => {
  const { page } = mountPage();
  const state = page.options.inject().hooks.qqSettings.getSnapshot();

  assert.ok(state.sections.length > 0);
  const rows = state.sections.flatMap((section) => section.rows);
  assert.equal(rows.length, Object.keys(Config({}).get()).length, '投影必须覆盖全部字段');
  for (const section of state.sections) {
    assert.ok(section.title.length > 0 && section.rows.length > 0);
    for (const row of section.rows) {
      assert.equal(typeof row.state.text, 'string');
      assert.equal(typeof row.invalidLabel, 'string');
      assert.ok(row.invalidLabel.length > 0, `${row.key} 必须有非法值的提示文案`);
    }
  }
});

test('草稿口径：布尔收 true / 是 / 1，空串是「恢复默认」，胡说是非法', () => {
  const { mod } = mountPage();
  const spec = (key) => mod.specFor(key, new z(JSON.parse(JSON.stringify(Config.toJSON()))).dict[key]);

  const proactive = spec('proactive');
  assert.equal(proactive.format(true), 'true');
  assert.equal(proactive.format(false), 'false');
  assert.deepEqual(proactive.parse('是'), { kind: 'set', value: true });
  assert.deepEqual(proactive.parse('OFF'), { kind: 'set', value: false });
  assert.deepEqual(proactive.parse('1'), { kind: 'set', value: true });
  assert.deepEqual(proactive.parse('  '), { kind: 'clear' });
  assert.equal(proactive.parse('大概吧'), undefined, '认不出来的词要挡住保存');
});

test('草稿口径：白名单是逗号分隔（中英文都认），空串清空', () => {
  const { mod } = mountPage();
  const node = new z(JSON.parse(JSON.stringify(Config.toJSON()))).dict.allowTools;
  const spec = mod.specFor('allowTools', node);

  assert.equal(spec.format(['read', 'grep']), 'read, grep');
  assert.deepEqual(spec.parse('read, grep'), { kind: 'set', value: ['read', 'grep'] });
  assert.deepEqual(spec.parse('read，grep\n\nskill'), { kind: 'set', value: ['read', 'grep', 'skill'] });
  assert.deepEqual(spec.parse(' '), { kind: 'clear' });
  assert.equal(spec.format(undefined), '');
});

test('草稿口径：枚举只认 union 里列出的值', () => {
  const { mod } = mountPage();
  const schema = new z(JSON.parse(JSON.stringify(Config.toJSON())));
  const spec = mod.specFor('groupTrigger', schema.dict.groupTrigger);

  assert.deepEqual(spec.parse('all'), { kind: 'set', value: 'all' });
  assert.deepEqual(spec.parse('mention'), { kind: 'set', value: 'mention' });
  assert.equal(spec.parse('everyone'), undefined);
  assert.deepEqual(spec.parse(''), { kind: 'clear' });
});

test('标签：优先 schema 上的 comment，其次覆盖表，最后从描述里取一段', () => {
  const { mod } = mountPage();

  assert.equal(mod.labelOf('batchWindowMs', { meta: { description: '收到一条要回的消息后，先等…' } }), '攒批窗口（毫秒）');
  assert.equal(mod.labelOf('anything', { meta: { comment: '手写的标签', description: '描述：…' } }), '手写的标签');
  assert.equal(mod.deriveLabel('群消息触发方式：@机器人 / 前缀 / 全部消息', 'groupTrigger'), '群消息触发方式');
  assert.equal(mod.deriveLabel(undefined, 'groupTrigger'), 'groupTrigger');
  assert.equal(mod.deriveLabel('**加粗**也照取：后面的说明', 'x'), '加粗也照取');
});

test('组件真的能渲染：SettingsForm 里一组一张折叠卡片，默认只展开第一组', () => {
  const { page, mod } = mountPage();
  const state = page.options.inject().hooks.qqSettings.getSnapshot();
  const events = [];

  // 框架平时会把 hooks 里的 observable 绑成 useQqSettings（useSyncExternalStore），
  // 这里换成一个直接读快照的实现，于是组件能当纯函数调。
  const tree = mountTree(page, mod, {
    edit: (key, text) => events.push(['edit', key, text]),
    resetField: (key) => events.push(['reset', key]),
    save: () => events.push(['save']),
    discard: () => events.push(['discard']),
  });

  assert.equal(tree.type, 'SettingsForm', '根节点必须是 primitives 的 SettingsForm（它带保存按钮与只读提示）');
  const cards = groupCards(tree);
  assert.equal(cards.length, state.sections.length, '每一组都要有一张卡片');

  // 折叠是这一页的核心：默认只有第一组把字段渲染出来。
  assert.equal(fieldsOf(cards[0]).length, state.sections[0].rows.length, '第一组默认展开');
  for (const card of cards.slice(1)) {
    assert.equal(fieldsOf(card).length, 0, '其余组默认收起（收起时不渲染字段）');
  }

  const rows = cards.flatMap((card) => fieldsOf(card));
  assert.equal(rows.length, state.sections[0].rows.length, '默认页面上只有第一组的字段');
  for (const row of rows) {
    assert.equal(row.type, 'SettingsValueField');
    assert.match(row.props.id, new RegExp(`^${mod.FIELD_ID_PREFIX}`));
    assert.ok(row.props.label.length > 0);
    assert.equal(typeof row.props.onEdit, 'function');
    assert.equal(typeof row.props.onReset, 'function');
    assert.equal(row.props.help.label, 'helpLabel');
  }

  // 编辑与重置要带着字段名回到注入的动作上（键名写错 = 改了别的字段）。
  rows[0].props.onEdit('新值');
  rows[0].props.onReset();
  const firstKey = state.sections[0].rows[0].key;
  assert.deepEqual(events, [['edit', firstKey, '新值'], ['reset', firstKey]]);

  // 点标题：那一组展开（假 useState 会把新状态留在槽里，下一次渲染就用它）。
  headOf(cards[1]).props.onClick();
  const reopened = rerender(page, mod);
  const reopenedCards = groupCards(reopened);
  assert.equal(fieldsOf(reopenedCards[0]).length, 0, '点开第二组时第一组要收起');
  assert.equal(fieldsOf(reopenedCards[1]).length, state.sections[1].rows.length, '第二组应当展开');
  assert.equal(headOf(reopenedCards[1]).props['aria-expanded'], 'true');
  assert.equal(headOf(reopenedCards[0]).props['aria-expanded'], 'false');
  assert.equal(headOf(reopenedCards[1]).props['aria-controls'], `qq-group-${state.sections[1].id}`);

  // 再点一次同一个标题：这一组收起，页面上一个字段都不渲染（回到「全是组名」的总览）。
  headOf(reopenedCards[1]).props.onClick();
  const collapsed = rerender(page, mod);
  assert.equal(groupCards(collapsed).flatMap((card) => fieldsOf(card)).length, 0);
  assert.equal(headOf(groupCards(collapsed)[1]).props['aria-expanded'], 'false');

  // summary 视图只给一行简介（设置面板的导航项在缺描述时会问它）。
  reactHooks.state = UNSET;
  assert.equal(rerender(page, mod, { view: 'summary' }), 'intro');
});

test('人设单独一张卡片：persona / instructions 是多行输入框，不和别的字段挤在一起', () => {
  const { mod, page } = mountPage();
  const fields = mod.describeFields(new z(JSON.parse(JSON.stringify(Config.toJSON()))));
  const sectionOfKey = (key) => fields.find((row) => row.key === key).section;

  // 两张卡片：这一段里只有人设与额外要求，而它们也不在「QQ 会话与 Agent」那堆开关里。
  assert.equal(sectionOfKey('persona').id, 'persona');
  assert.equal(sectionOfKey('instructions').id, 'persona');
  assert.equal(sectionOfKey('persona').title, '人设与提示词');
  const personaSection = mod.SECTIONS.find((section) => section.id === 'persona');
  assert.deepEqual(personaSection.fields, ['persona', 'instructions']);
  const agentSection = mod.SECTIONS.find((section) => section.id === 'agent');
  assert.ok(!agentSection.fields.includes('persona') && !agentSection.fields.includes('instructions'));

  // 「多行」是一条白名单，不是「字符串字段都算」：其余文本字段仍然是单行控件。
  assert.equal(fields.find((row) => row.key === 'persona').long, true);
  assert.equal(fields.find((row) => row.key === 'instructions').long, true);
  assert.equal(fields.find((row) => row.key === 'allowTools').long, false);

  // 展开那一组：两个字段都得渲染成自定义的多行控件（假的 useState 是单槽的，这里
  // 直接把它预置成这一组的 id，等于「用户点开了这一组的标题」）。
  reactHooks.state = 'persona';
  const card = cardOf(rerender(page, mod), 'persona');
  assert.ok(card, '人设要有自己的一张折叠卡片');
  const controls = controlsOf(card);
  assert.deepEqual(
    controls.map((control) => control.props.id),
    ['qq-config-persona', 'qq-config-instructions'],
  );
  for (const control of controls) assert.equal(control.type, mod.LongTextField);
});

test('多行控件：换行原样保留、编辑与恢复默认可达、ⓘ 能展开说明', () => {
  const { mod } = mountPage();
  // 假的 useState 是一根模块级单槽：这里当「组件刚挂载」用，先把槽清干净，
  // 否则会继承上一个用例留在里面的展开状态。
  reactHooks.state = UNSET;
  const events = [];
  const props = {
    id: 'qq-config-persona',
    label: '人设（群友口吻）',
    hint: '留空 = 用插件内置的那份',
    help: { label: 'helpLabel', content: '说明' },
    text: '第一行\n第二行',
    overridden: true,
    invalid: false,
    disabled: false,
    overriddenLabel: 'overridden',
    resetLabel: 'reset',
    invalidLabel: 'invalid',
    placeholder: '留空 = 内置',
    onEdit: (text) => events.push(['edit', text]),
    onReset: () => events.push(['reset']),
  };

  const field = mod.LongTextField(props);
  const textarea = field.props.children[1];
  assert.equal(textarea.type, 'textarea', '多行框才是 `<textarea>`（单行 `<input>` 看不到整段人设）');
  assert.equal(textarea.props.value, '第一行\n第二行', '换行必须原样保留');
  assert.ok(textarea.props.rows >= 6);
  assert.equal(textarea.props.placeholder, '留空 = 内置');
  assert.equal(textarea.props.disabled, false);
  textarea.props.onChange({ target: { value: '改过的\n人设' } });
  assert.deepEqual(events, [['edit', '改过的\n人设']], '编辑要走注入的 onEdit（草稿与校验都在那边）');

  // 「已覆盖」那一行里的恢复默认：按钮被点到时要回到注入的 onReset 上。
  const head = field.props.children[0];
  const badges = head.props.children.find((child) => child?.type === 'span');
  assert.ok(badges, '覆盖过的人设要显示「已覆盖」与恢复默认');
  const reset = badges.props.children.find((child) => child?.type === 'button');
  reset.props.onClick();
  assert.deepEqual(events.at(-1), ['reset']);

  // ⓘ 是这一页唯一的「完整说明」入口（配置项名也在里面），展开要走 aria-expanded。
  const helpButton = head.props.children.find((child) => child?.type === 'button');
  assert.equal(helpButton.props['aria-expanded'], false);
  helpButton.props.onClick();
  const expanded = mod.LongTextField(props);
  assert.equal(expanded.props.children[0].props.children.find((child) => child?.type === 'button').props['aria-expanded'], true);
  assert.equal(expanded.props.children.at(-1).props.role, 'region', '展开后要出现说明区');
});

test('多行控件的非法提示：填了非法值就说清楚，边框走错误色', () => {
  const { mod } = mountPage();
  const field = mod.LongTextField({
    id: 'qq-config-persona',
    label: '人设',
    hint: '留空 = 用内置的那份',
    text: '',
    invalid: true,
    disabled: false,
    invalidLabel: '请填文本；留空表示使用默认值',
    overriddenLabel: 'overridden',
    resetLabel: 'reset',
    onEdit() {},
    onReset() {},
  });

  const textarea = field.props.children[1];
  assert.equal(textarea.props['aria-invalid'], true);
  assert.match(textarea.props.style.borderColor, /state-error-primary/);
  const message = field.props.children[2];
  assert.equal(message.props.children, '请填文本；留空表示使用默认值');
});

