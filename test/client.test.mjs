/**
 * 浏览器半侧（`client.js`）的契约测试。
 *
 * 这份文件是手写的「已构建 bundle」，它的形状由 `dsh-client-modules` 决定（工厂函数
 * + `exports.apply` / `exports.inject`），而它**不经过 index.js**：真宿主把它作为
 * 浏览器 bundle 发给页面，挂在 Loader 里那一行（`name: '@qqbot/dsh-plugin-qq'`）上。
 *
 * 所以这里用最小的假 Host 把它跑一遍：假的 `window.__ModuleLoader__` 收下注册，
 * 假的 `require` 给出平台模块（react / jsx-runtime / ui-primitives 都是桩 —— 真
 * 浏览器 bundle 里有 CSS import，node 里加载不了），再用一个十几行的迷你渲染器
 * 把页面展开成节点树，断言设置页的那批契约（清单见 `client.js` 顶部注释）：
 *
 *   1. 注册位置与注入面；
 *   2. 143 个字段在 7 个 tab 的合集里恰好各出现一次、不落「其它」；
 *   3. 每个分组恰属一个 tab（`tabOf` 对未知分组返回 undefined）；
 *   4. 控件映射：布尔 → `Switch`、枚举 → `<select>`、数字 / 文本 → `<input>`（官方字段行
 *      几何）、长文本 → `textarea`；工具条里的搜索框才是 primitives 的 `Input`；
 *   5. 草稿口径：开关写 `'true'` / `'false'`、枚举写字面量、列表逗号分隔、空串 = 清空；
 *   6. 切 tab 不丢草稿、搜索命中四个来源且结果可编辑、`只看已改` 与搜索可叠加；
 *   7. 量纲 hint 齐全且跟着草稿走；枚举文案全覆盖；只读时全部 `disabled`。
 *
 * 迷你渲染器只展开带 `qqComponent` 记号的函数组件：primitives 的控件在测试里是桩，
 * 展开成桩的内部结构就看不到控件本身了（而那正是要断言的形状）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import z from '@deepseek-ai/schemastery';
import { Config } from '../config.js';
import { REMINDER_ROUTE_PATH } from '../reminders.js';

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

// ---- 假 react -----------------------------------------------------------------------

/**
 * `useState` 的槽位实现：**位置**对应 hook（React 的规则），槽位跨渲染保留。
 * 每次渲染前把索引归零（`BEGIN_RENDER`），于是「调 setter → 再渲染一次」就
 * 等价于 React 的重渲染。为什么不按组件实例分槽：测试里整棵树是一次同步渲染，
 * 位置稳定就够用，而按实例分会把桩写成一个小 React。
 */
let hookSlots = [];
let hookIndex = 0;

function resetHooks() {
  hookSlots = [];
  hookIndex = 0;
}

const reactStub = {
  useState: (initial) => {
    const index = hookIndex++;
    if (!(index in hookSlots)) hookSlots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      hookSlots[index],
      (next) => {
        hookSlots[index] = typeof next === 'function' ? next(hookSlots[index]) : next;
      },
    ];
  },
  /**
   * 迷你渲染器是同步的，不跑 effect：定时任务区块在测试里停在「正在读取」这一帧，
   * 断言的是区块外壳与加载态；真正的取数 / 刷新是浏览器行为，不在这里验。
   */
  useEffect: () => {},
};

const jsxRuntimeStub = {
  Fragment: 'Fragment',
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
};

/** 假的 ui-primitives：只保留本页面用到的那几个入口，props 口径与真组件一致。 */
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
  Switch: function Switch(props) {
    return { type: 'Switch', props };
  },
  Input: function Input(props) {
    return { type: 'Input', props };
  },
  Pill: function Pill(props) {
    return { type: 'Pill', props };
  },
  Tag: function Tag(props) {
    return { type: 'Tag', props };
  },
  IconSearchOutlineRegular: function IconSearchOutlineRegular(props) {
    return { type: 'IconSearch', props };
  },
  IconInfoOutlineRegular: function IconInfoOutlineRegular(props) {
    return { type: 'IconInfo', props };
  },
  /**
   * 一个有最小行为的假表单模型：草稿（staged）、覆盖、非法、清除各按 primitives
   * 的口径（`field()` 返回 `text / overridden / invalid`）。真实的
   * `SettingsFormModel` 在浏览器里，但它 import CSS modules，node 里加载不了。
   */
  SettingsFormModel: class FakeSettingsFormModel {
    constructor(scope, specs) {
      this.scope = scope;
      this.specs = new Map(specs.map((spec) => [spec.field, spec]));
      this.staged = new Map();
      this.listeners = new Set();
    }
    writeOf(key, text) {
      if (text.trim() === '') return { kind: 'clear' };
      return this.specs.get(key).parse(text);
    }
    shell() {
      const invalid = [...this.staged.entries()].some(([key, staged]) => staged.clear !== true && this.writeOf(key, staged.text) === undefined);
      return { available: true, writable: this.scope.writable, dirty: this.staged.size > 0, invalid, saving: false, failed: false };
    }
    field(key) {
      const staged = this.staged.get(key);
      if (staged !== undefined) {
        if (staged.clear === true) return { text: '', overridden: false, invalid: false };
        const write = this.writeOf(key, staged.text);
        return { text: staged.text, overridden: write?.kind === 'set', invalid: write === undefined };
      }
      const spec = this.specs.get(key);
      return { text: spec.format(this.scope.values[key]), overridden: this.scope.overrides.has(key), invalid: false };
    }
    bind(project) {
      this.project = project;
      const model = this;
      this.store = {
        snapshot: project(),
        getSnapshot() {
          return model.store.snapshot;
        },
        subscribe: () => () => {},
      };
      return this.store;
    }
    publish() {
      if (this.store !== undefined) this.store.snapshot = this.project();
    }
    actions() {
      const model = this;
      return {
        edit(key, text) {
          model.staged.set(key, { text });
          model.publish();
        },
        resetField(key) {
          model.staged.set(key, { text: '', clear: true });
          model.publish();
        },
        save() {},
        discard() {},
      };
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

// ---- 迷你渲染器 ---------------------------------------------------------------------

/** 展开带 `qqComponent` 记号的函数组件；primitives 的桩原样留在树上供断言。 */
function renderNode(node) {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map(renderNode);
  if (typeof node !== 'object') return node;
  if (typeof node.type === 'function' && node.type.qqComponent === true) return renderNode(node.type(node.props));
  if (node.props === undefined || node.props.children === undefined) return node;
  return { ...node, props: { ...node.props, children: renderNode(node.props.children) } };
}

/** 依次访问树里所有节点（只走 `children`，不碰 style / help 之类的数据）。 */
function walk(node, visit) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  walk(node.props?.children, visit);
}

function nodes(tree, predicate) {
  const found = [];
  walk(tree, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

/** 节点里的可见文本（用于「标签 / Tag 文案 / 空状态」这类断言）。 */
function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object') return textOf(node.props?.children);
  return '';
}

// ---- 假的客户端 Host ---------------------------------------------------------------

/** schema 与默认值都来自真 `Config`：页面上的字段表就是它投影出来的。 */
const SCHEMA_JSON = () => JSON.parse(JSON.stringify(Config.toJSON()));
const SCHEMA_DICT = () => SCHEMA_JSON().refs[SCHEMA_JSON().uid].dict;
const SCHEMA_KEYS = () => Object.keys(SCHEMA_DICT());
const DEFAULT_VALUES = () => JSON.parse(JSON.stringify(Config({}).get()));

function namespaceView(host) {
  return {
    ns: 'qq-bridge',
    autoGenerate: true,
    schema: SCHEMA_JSON(),
    value: host.scope.values,
    user: {},
    base: {},
    secrets: [],
    revision: 1,
    applies: 'live',
  };
}

/** 一个最小的客户端上下文：只实现 client.js 用到的那些服务。 */
function makeClientHost(options = {}) {
  const host = {
    dictionaries: new Map(),
    registrations: [],
    slotInjects: [],
    disposed: [],
    scope: {
      values: options.values ?? DEFAULT_VALUES(),
      overrides: new Set(options.overrides ?? []),
      writable: options.writable ?? true,
      getSnapshot: () => ({ status: 'ready', value: {}, base: {}, user: {}, writable: true, revision: 1, mode: 'host' }),
      subscribe: () => () => {},
      mutate: async () => true,
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
          getSnapshot: () => ({ status: 'ready', view: { namespaces: [namespaceView(host)], writable: true, hasDocument: true } }),
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

// ---- 会话：一次 apply() + 一棵可重渲染的树 -------------------------------------------

function mount(options = {}) {
  const host = makeClientHost(options);
  const mod = registration.factory(fakeRequire);
  mod.apply(host.ctx);
  return { host, mod, page: host.registrations[0] };
}

/** 当前语言的 `t`：用真实的 zh / en 字典，并插上 `{count}` / `{tab}` 占位符。 */
function translator(host, locale = 'zh') {
  const dict = host.dictionaries.get('settings.qq')?.[locale] ?? {};
  return (key, params) => {
    let text = typeof dict[key] === 'string' ? dict[key] : key;
    for (const [name, value] of Object.entries(params ?? {})) text = text.split(`{${name}}`).join(String(value));
    return text;
  };
}

/** 渲染一页（迷你渲染器把 `QQ_BRIDGE` 当组件展开）。 */
function render(session, extra = {}) {
  hookIndex = 0;
  const { host, mod, page } = session;
  const face = page.options.inject();
  return renderNode({
    type: mod.QQ_BRIDGE,
    props: {
      t: extra.t ?? translator(host, extra.locale ?? 'zh'),
      view: extra.view ?? 'page',
      locale: extra.locale ?? 'zh',
      useQqSettings: (selector) => selector(face.hooks.qqSettings.getSnapshot()),
      edit: extra.edit ?? face.edit,
      resetField: extra.resetField ?? face.resetField,
      save: face.save,
      discard: face.discard,
    },
  });
}

/** 第一次挂载：清空 hook 槽，等价于 React 的首次渲染。 */
function mountTree(session, extra = {}) {
  resetHooks();
  return render(session, extra);
}

/** 再渲染一次，沿用槽位 —— 等价于 React 在 setter 之后的重渲染。 */
function rerender(session, extra = {}) {
  return render(session, extra);
}

/** 页面里的 tab 按钮（按可见短标签找，断言不依赖 id 的拼法）。 */
function tabNode(tree, label) {
  return nodes(tree, (node) => node.props?.role === 'tab' && textOf(node) === label)[0];
}

/** 切到某个 tab（点一下，再渲染）。 */
function openTab(session, label) {
  const tree = rerender(session);
  const tab = tabNode(tree, label);
  assert.ok(tab, `找不到「${label}」这个 tab`);
  tab.props.onClick();
  return rerender(session);
}

/** 页面上当前渲染出来的字段行（按 key 索引；tab 只渲染当前那一个）。 */
function fieldsIn(tree) {
  const map = new Map();
  for (const node of nodes(tree, (candidate) => candidate.props?.['data-field'] !== undefined)) {
    map.set(node.props['data-field'], node);
  }
  return map;
}

/** 依次点过全部 tab，收集每个字段那一行（用来做「143 个字段各自的控件」这类断言）。 */
function allFields(session) {
  const found = new Map();
  mountTree(session);
  for (const tab of session.mod.TABS) {
    const tree = openTab(session, tab.label);
    for (const [key, node] of fieldsIn(tree)) found.set(key, node);
  }
  return found;
}

/** 某个字段行里的控件节点。 */
function controlIn(field, predicate) {
  return nodes(field, predicate)[0];
}

// 字段行的输入框是原生 `<input>`（官方 fields.module.css 的几何）；工具条里的搜索框才是
// primitives 的 `Input`（它自带前置放大镜），两者在断言里要分开认。
const isInput = (node) => node.type === 'input';
const isSearch = (node) => node.type === primitivesStub.Input;
const isSwitch = (node) => node.type === primitivesStub.Switch;
const isSelect = (node) => node.type === 'select';
const isTextarea = (node) => node.type === 'textarea';
const isHint = (node) => node.type === 'p' && node.props.className === 'qq-hint';
const isInvalid = (node) => node.type === 'p' && node.props.className === 'qq-invalid';
const tagsIn = (field) => nodes(field, (node) => node.type === primitivesStub.Tag);
const resetIn = (field) => nodes(field, (node) => node.type === 'button' && node.props.className === 'qq-reset')[0];
const helpButtonIn = (field) => nodes(field, (node) => node.type === 'button' && node.props.className === 'qq-helpButton')[0];

// ---- 用例 ---------------------------------------------------------------------------

test('浏览器半侧的注册形状：工厂 ID、必到服务、页面挂在设置面板的 section 位上', () => {
  const session = mount();
  const { host, mod, page } = session;

  assert.equal(registration.id, '@qqbot/dsh-plugin-qq', '工厂 ID 必须等于包名（客户端模块系统按它认这一行）');
  assert.deepEqual(mod.inject, ['slots', 'locale', 'configForms', 'settingsSchema']);
  assert.equal(mod.ENTRY, 'qq-bridge');
  assert.equal(mod.SECTION, 'settings.section');

  // `settings.section` 由 dsh 的设置外壳在运行时声明：直接 register 会抛
  // 「slot ... is not declared」，必须走 slots.inject 等声明。
  assert.deepEqual(host.slotInjects, ['settings.section']);

  assert.ok(page, 'apply() 必须注册一页设置');
  assert.equal(page.options.name, 'settings.section', '配置页住在设置面板里，不在插件页的组合包卡片下');
  assert.equal(page.options.id, 'qq-bridge', 'id 是 profile 条目 id，写错页面就不出现');
  assert.equal(page.options.locale, 'settings.qq');
  assert.equal(page.options.label(), 'navTitle', '导航标题来自本页字典（测试里的 bind 是回显 key）');
});

test('注入面：hooks 里的 observable 与四个表单动作都在', () => {
  const { page } = mount();
  const face = page.options.inject();

  assert.equal(typeof face.hooks.qqSettings.getSnapshot, 'function');
  assert.equal(typeof face.hooks.qqSettings.subscribe, 'function');
  for (const action of ['edit', 'resetField', 'save', 'discard']) {
    assert.equal(typeof face[action], 'function', `${action} 必须注入`);
  }
});

test('字典：zh / en 键集完全一致、非空，且旧版的 key 都删干净了', () => {
  const { host } = mount();
  const dicts = host.dictionaries.get('settings.qq');
  assert.ok(dicts, '必须注册 settings.qq 字典');
  const zhKeys = Object.keys(dicts.zh).sort();
  const enKeys = Object.keys(dicts.en).sort();
  assert.deepEqual(zhKeys, enKeys, 'zh / en 必须一一对应（缺一个就会把 key 露到页面上）');
  for (const key of zhKeys) {
    assert.ok(dicts.zh[key].length > 0, `zh.${key} 不能是空串`);
    assert.ok(dicts.en[key].length > 0, `en.${key} 不能是空串`);
  }
  // 设计 §3.2 定稿的页面 chrome 文案。
  for (const key of [
    'title',
    'intro',
    'notice',
    'searchPlaceholder',
    'searchEmpty',
    'changedCount',
    'onlyChanged',
    'invalidCount',
    'tabsLabel',
    'sectionOf',
  ]) {
    assert.ok(zhKeys.includes(key), `缺少字典 key：${key}`);
  }
  for (const key of ['envNotice', 'groupsHint', 'changed']) {
    assert.ok(!zhKeys.includes(key), `旧 key 应当删掉：${key}`);
  }
});

test('字段覆盖：schema 里每一项都上了页面、都有标签、都不落进「其它」', () => {
  const { mod } = mount();
  const fields = mod.describeFields(new z(SCHEMA_JSON()));
  const keys = fields.map((row) => row.key);

  assert.deepEqual([...keys].sort(), [...SCHEMA_KEYS()].sort(), '页面字段必须与 schema 字段一一对应');
  assert.equal(new Set(keys).size, keys.length, '同一个字段不能出现两次');

  const orphans = fields.filter((row) => row.section.id === 'other').map((row) => row.key);
  assert.deepEqual(orphans, [], '每个字段都要有归属的分组（加了配置项忘了分组时这里会红）');

  for (const row of fields) {
    assert.ok(row.label.length > 0 && row.label !== row.key, `${row.key} 的标签不该退化成字段名`);
    assert.ok(row.description.length > 0, `${row.key} 必须带 .description()（它就是界面上的说明）`);
    assert.ok(row.invalidLabel.length > 0, `${row.key} 必须有非法值的提示文案`);
  }
});

test('tab 映射：7 个 tab、15 个分组各属一个 tab、字段数加起来是 143', () => {
  const { mod } = mount();
  const fields = mod.describeFields(new z(SCHEMA_JSON()));

  assert.deepEqual(
    mod.TABS.map((tab) => tab.id),
    ['connect', 'session', 'persona', 'group', 'reminder', 'perception', 'memory'],
  );
  assert.equal(mod.TABS.length, 7);
  for (const tab of mod.TABS) {
    assert.ok(tab.label.length > 0 && tab.title.length > 0, `${tab.id} 的短标签与全称都要有`);
    assert.ok(tab.sections.length > 0, `${tab.id} 至少要有一个区块`);
  }

  for (const section of mod.SECTIONS) {
    const owners = mod.TABS.filter((tab) => tab.sections.includes(section.id));
    assert.equal(owners.length, 1, `分组 ${section.id} 必须恰好属于一个 tab`);
  }
  const mapped = mod.TABS.flatMap((tab) => tab.sections);
  assert.deepEqual([...mapped].sort(), mod.SECTIONS.map((section) => section.id).sort(), '没有分组被漏掉');
  assert.equal(mod.tabOf('repeat').id, 'group');
  assert.equal(mod.tabOf('reminder').id, 'reminder', '定时提醒单独一页，不塞在群聊里');
  assert.equal(mod.tabOf('apikey').id, 'memory');
  assert.equal(mod.tabOf('other'), undefined, 'tabOf 对未知分组返回 undefined（别静默丢字段）');

  const countOf = (tab) =>
    tab.sections
      .flatMap((sectionId) => fields.filter((row) => row.section.id === sectionId))
      .length;
  assert.deepEqual(
    Object.fromEntries(mod.TABS.map((tab) => [tab.id, countOf(tab)])),
    { connect: 12, session: 23, persona: 13, group: 29, reminder: 11, perception: 32, memory: 23 },
    '字段数按设计 §3.1 分布',
  );
  assert.equal(fields.length, 143, '合计 143 项');
});

test('定时任务：提醒页最上面有一块只读列表，取数路径与 Host 路由一致', () => {
  const session = mount();
  const { mod } = session;
  assert.equal(mod.REMINDER_TASKS_PATH, REMINDER_ROUTE_PATH, '浏览器 bundle 与 reminders.js 的路由必须一致');
  assert.ok(mod.REMINDER_REFRESH_MS >= 1000, '刷新间隔要是个正经的秒数');

  mountTree(session);
  const tree = openTab(session, '提醒');
  const panel = nodes(tree, (node) => node.props?.role === 'tabpanel')[0];
  assert.ok(panel, '提醒页要有 tabpanel');
  const section = nodes(
    panel,
    (node) => node.type === 'section' && String(node.props?.className ?? '').includes('qq-tasksSection'),
  )[0];
  assert.ok(section, '提醒页必须有「已记录的定时任务」区块');
  assert.equal(textOf(panel.props.children[0]).slice(0, 8), '已记录的定时任务', '任务列表排在这一页最上面');
  assert.match(textOf(section), /已记录的定时任务/);
  assert.match(textOf(section), /每 15 秒自动刷新/);
  assert.match(textOf(section), /正在读取任务/, '迷你渲染器不跑 effect，停在加载态');
  const refresh = nodes(
    section,
    (node) => node.type === primitivesStub.Pill && node.props?.children === '刷新',
  )[0];
  assert.ok(refresh, '要有刷新按钮');
  assert.equal(typeof refresh.props.onClick, 'function');
});

test('定时任务列表：状态 / 模式 / 时间 / 目标 / @ / 错误都在一行里，空列表给提示', () => {
  const session = mount();
  const t = translator(session.host, 'zh');
  const base = {
    repeat: '一次',
    repeating: false,
    fallbackText: '',
    createdAt: 1,
    createdLabel: '2026-08-20 14:00',
    fireCount: 0,
    lastFiredAt: 0,
    lastFiredLabel: '',
    error: '',
  };
  const data = {
    now: 0,
    pending: 1,
    total: 2,
    tasks: [
      {
        ...base,
        id: 'r-1',
        status: 'active',
        mode: 'prompt',
        repeat: '每天',
        repeating: true,
        dueAt: 1,
        dueLabel: '2026-08-21 16:00',
        type: 'group',
        targetId: '100000001',
        key: 'group:100000001',
        text: '查一下天气',
        mentions: ['张三'],
        createdBy: '李四',
        fireCount: 2,
      },
      {
        ...base,
        id: 'r-2',
        status: 'failed',
        mode: 'text',
        dueAt: 2,
        dueLabel: '2026-08-21 08:00',
        type: 'private',
        targetId: '100000002',
        key: 'private:100000002',
        text: '交作业',
        mentions: [],
        createdBy: '100000002',
        error: 'bot 没连上',
      },
    ],
  };
  const tree = renderNode({ type: session.mod.ReminderTaskList, props: { t, data } });
  const rows = nodes(tree, (node) => node.type === 'li');
  assert.equal(rows.length, 2);

  assert.match(textOf(rows[0]), /2026-08-21 16:00 · 每天/);
  assert.match(textOf(rows[0]), /指令：查一下天气/);
  assert.match(textOf(rows[0]), /群 100000001/);
  assert.match(textOf(rows[0]), /提醒 @张三/);
  assert.match(textOf(rows[0]), /李四 建的/);
  assert.match(textOf(rows[0]), /已发 2 次/);
  const tags = nodes(rows[0], (node) => node.type === primitivesStub.Tag);
  assert.equal(tags.length, 2, '状态与模式各一个 Tag');
  assert.equal(textOf(tags[0]), '待发送');
  assert.equal(tags[0].props.tone, 'info');
  assert.equal(textOf(tags[1]), 'Agent 执行');

  assert.match(textOf(rows[1]), /私聊 100000002/);
  assert.match(textOf(rows[1]), /上次错误：bot 没连上/);
  assert.equal(textOf(nodes(rows[1], (node) => node.type === primitivesStub.Tag)[0]), '失败');

  const empty = renderNode({ type: session.mod.ReminderTaskList, props: { t, data: { tasks: [] } } });
  assert.match(textOf(empty), /还没有记录任何定时任务/);
});

test('表单投影：7 个 tab 覆盖全部字段，每行带草稿状态与来源上下文', () => {
  const session = mount();
  mountTree(session);
  const state = session.page.options.inject().hooks.qqSettings.getSnapshot();

  assert.equal(state.tabs.length, 7);
  assert.equal(state.shell.writable, true);
  const rows = state.tabs.flatMap((tab) => tab.sections.flatMap((section) => section.rows));
  assert.equal(rows.length, 143, '投影必须覆盖全部字段');
  for (const tab of state.tabs) {
    for (const section of tab.sections) {
      assert.ok(section.title.length > 0, `${section.id} 的区块标题不能空`);
      assert.ok(section.rows.length > 0);
      for (const row of section.rows) {
        assert.equal(typeof row.state.text, 'string', `${row.key} 的草稿必须是文本`);
        assert.ok(row.invalidLabel.length > 0, `${row.key} 要有非法提示`);
        assert.equal(row.tabId, tab.id, `${row.key} 要带上来源 tab`);
        assert.equal(row.tabLabel, tab.label);
        assert.equal(row.sectionTitle, section.title);
      }
    }
  }
});

test('控件映射：34 个布尔是 Switch、8 个枚举是 select、长文本是 textarea', () => {
  const session = mount();
  const fields = allFields(session);
  assert.equal(fields.size, 143, '七个 tab 加起来必须刚好是 143 行（每行只渲染一次）');

  const kinds = new Map();
  for (const [key, field] of fields) {
    const kind = field.props['data-kind'];
    if (controlIn(field, isSwitch) !== undefined) kinds.set(key, 'boolean');
    else if (controlIn(field, isSelect) !== undefined) kinds.set(key, 'choice');
    else if (controlIn(field, isTextarea) !== undefined) kinds.set(key, 'long');
    else if (controlIn(field, isInput) !== undefined) kinds.set(key, 'input');
    else kinds.set(key, 'missing');

    if (kind === 'boolean') assert.equal(kinds.get(key), 'boolean', `${key} 是布尔，应当渲染 Switch`);
    if (kind === 'choice') assert.equal(kinds.get(key), 'choice', `${key} 是枚举，应当渲染 select`);
    if (kind === 'number') assert.equal(kinds.get(key), 'input', `${key} 是数字，应当渲染输入框`);
    if (kind === 'text') {
      assert.ok(['input', 'long'].includes(kinds.get(key)), `${key} 是文本，应当渲染输入框或多行框`);
    }
    if (field.props['data-layout'] === 'inline') assert.equal(kinds.get(key), 'boolean', '只有开关行走官方开关行');
  }

  const tally = {};
  for (const kind of kinds.values()) tally[kind] = (tally[kind] ?? 0) + 1;
  assert.deepEqual(tally, { boolean: 34, choice: 8, long: 2, input: 99 }, '按 schema 的类型分布');

  // 数字框带 `inputMode="numeric"`；列表行在输入框下面给 Pill 预览。
  assert.equal(controlIn(fields.get('proactiveChance'), isInput).props.inputMode, 'numeric');
  const listField = fields.get('allowUsers');
  assert.ok(controlIn(listField, isInput), '列表行仍然是输入框');
  const pills = nodes(listField, (node) => node.type === primitivesStub.Pill);
  assert.equal(pills.length, 0, '默认值空列表时不渲染 Pill 预览');
  // `allowTools` 的默认值不再为空（18 个工具名）：每个都渲染成一个可点的 Pill。
  const allowToolsPills = nodes(fields.get('allowTools'), (node) => node.type === primitivesStub.Pill);
  assert.equal(allowToolsPills.length, 18, '工具白名单的默认值应当逐个渲染成 Pill');
});

test('草稿口径：布尔收 true / 是 / 1，空串是「恢复默认」，胡说是非法', () => {
  const { mod } = mount();
  const schema = new z(SCHEMA_JSON());
  const spec = (key) => mod.specFor(key, schema.dict[key]);

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
  const { mod } = mount();
  const node = new z(SCHEMA_JSON()).dict.allowTools;
  const spec = mod.specFor('allowTools', node);

  assert.equal(spec.format(['read', 'grep']), 'read, grep');
  assert.deepEqual(spec.parse('read, grep'), { kind: 'set', value: ['read', 'grep'] });
  assert.deepEqual(spec.parse('read，grep\n\nskill'), { kind: 'set', value: ['read', 'grep', 'skill'] });
  assert.deepEqual(spec.parse(' '), { kind: 'clear' });
  assert.equal(spec.format(undefined), '');
});

test('草稿口径：枚举只认 union 里列出的值', () => {
  const { mod } = mount();
  const schema = new z(SCHEMA_JSON());
  const spec = mod.specFor('groupTrigger', schema.dict.groupTrigger);

  assert.deepEqual(spec.parse('all'), { kind: 'set', value: 'all' });
  assert.deepEqual(spec.parse('mention'), { kind: 'set', value: 'mention' });
  assert.equal(spec.parse('everyone'), undefined);
  assert.deepEqual(spec.parse(''), { kind: 'clear' });
});

test('开关与 select 的写入口径：走 props.edit，写的是草稿文本', () => {
  const session = mount();
  const events = [];
  const tree = mountTree(session, {
    edit: (key, text) => events.push([key, text]),
  });

  const privateChat = fieldsIn(tree).get('privateChat');
  const toggle = controlIn(privateChat, isSwitch);
  assert.equal(toggle.props.checked, true, 'privateChat 默认 true');
  toggle.props.onChange(false);
  toggle.props.onChange(true);

  const groupTrigger = fieldsIn(tree).get('groupTrigger');
  const select = controlIn(groupTrigger, isSelect);
  assert.equal(select.props.value, 'mention', '默认值来自 schema（跟真模型一致）');
  select.props.onChange({ target: { value: 'all' } });

  assert.deepEqual(events, [
    ['privateChat', 'false'],
    ['privateChat', 'true'],
    ['groupTrigger', 'all'],
  ]);
});

test('枚举文案：每个枚举字段的每个取值都有的人话，映射里没有 schema 之外的字段', () => {
  const { mod } = mount();
  const fields = mod.describeFields(new z(SCHEMA_JSON()));
  const enums = fields.filter((row) => row.kind === 'choice');

  assert.deepEqual(
    enums.map((row) => row.key).sort(),
    Object.keys(mod.ENUM_LABELS).sort(),
    '枚举字段与 ENUM_LABELS 必须一一对应（多一个/少一个都红）',
  );
  for (const row of enums) {
    assert.ok(row.choices.length >= 2, `${row.key} 至少两个取值`);
    assert.deepEqual(
      [...row.choices].sort(),
      Object.keys(mod.ENUM_LABELS[row.key]).sort(),
      `${row.key} 的每个取值都要有文案`,
    );
    for (const choice of row.choices) {
      const label = mod.labelForEnum(row.key, choice);
      assert.ok(label.length > 0 && label !== choice, `${row.key}=${choice} 的文案不能退化成字面量`);
    }
    assert.equal(mod.labelForEnum(row.key, '不存在的值'), '不存在的值', '认不出来的取值原样返回');
  }
});

test('量纲：FIELD_HINTS 覆盖所有 Ms/Bytes/Chars/Hour/Chance 字段，hint 跟着草稿走', () => {
  const { mod } = mount();
  const keys = SCHEMA_KEYS();
  const suffix = /(Ms|Bytes|Chars|Hour|Chance)$/;

  for (const key of keys.filter((name) => suffix.test(name))) {
    assert.ok(
      Object.hasOwn(mod.FIELD_HINTS, key) || mod.NO_HINT.has(key),
      `${key} 命中了量纲后缀，必须在 FIELD_HINTS 或 NO_HINT 里`,
    );
  }
  for (const key of [...Object.keys(mod.FIELD_HINTS), ...mod.NO_HINT]) {
    assert.ok(keys.includes(key), `${key} 不在 schema 里（配置改名后这里会红）`);
  }

  assert.equal(mod.hintFor('proactiveIdleMs', 2700000), '= 45 分钟');
  assert.equal(mod.hintFor('proactiveIdleMs', 60000), '= 1 分钟');
  assert.equal(mod.hintFor('mediaTimeoutMs', 1200), '= 1.2 秒');
  assert.equal(mod.hintFor('mediaMaxBytes', 8 * 1024 * 1024), '= 8 MB');
  assert.equal(mod.hintFor('memoryFileMaxBytes', 8963968), '= 8.5 MB');
  assert.equal(mod.hintFor('digestAtHour', 4), '= 04:00');
  assert.equal(mod.hintFor('personaMaxChars', 4000), '= 4000 字');
  assert.equal(mod.hintFor('proactiveChance', 0.35), '= 35%');
  assert.equal(mod.hintFor('activeGroupBatchScale', 2), '= ×2');
  assert.equal(mod.hintFor('accessToken', 'whatever'), '', '没有白名单条目就没有量纲提示');
  assert.equal(mod.hintFor('proactiveIdleMs', ''), '', '空草稿不猜');

  // 页面上的 hint 是「原 hint · 量纲」，而且草稿一改就跟着变（编辑器里仍是原始值）。
  const session = mount();
  mountTree(session);
  const tree = render(session);
  const toolbar = nodes(tree, (node) => node.props?.className === 'qq-toolbar')[0];
  const search = controlIn(toolbar, isSearch);
  search.props.onChange({ target: { value: 'proactiveIdleMs' } });
  let field = fieldsIn(rerender(session)).get('proactiveIdleMs');
  assert.match(textOf(nodes(field, isHint)[0]), /分钟/, 'hint 里要有人类可读的量纲');
  assert.match(textOf(nodes(field, isHint)[0]), /= 45 分钟/);
  controlIn(field, isInput).props.onChange({ target: { value: '60000' } });
  field = fieldsIn(rerender(session)).get('proactiveIdleMs');
  assert.match(textOf(nodes(field, isHint)[0]), /= 1 分钟/, '改草稿后量纲要立刻跟着变');
});

test('标签：优先 schema 上的 comment，其次覆盖表，最后从描述里取一段', () => {
  const { mod } = mount();

  assert.equal(mod.labelOf('batchWindowMs', { meta: { description: '收到一条要回的消息后，先等…' } }), '攒批窗口（毫秒）');
  assert.equal(mod.labelOf('anything', { meta: { comment: '手写的标签', description: '描述：…' } }), '手写的标签');
  assert.equal(mod.deriveLabel('群消息触发方式：@机器人 / 前缀 / 全部消息', 'groupTrigger'), '群消息触发方式');
  assert.equal(mod.deriveLabel(undefined, 'groupTrigger'), 'groupTrigger');
  assert.equal(mod.deriveLabel('**加粗**也照取：后面的说明', 'x'), '加粗也照取');
});

test('重构新增的字段在设置页上有像样的短标签（不截成半句、不退化成字段名）', () => {
  const { mod } = mount();
  const fields = mod.describeFields(new z(SCHEMA_JSON()));
  const label = (key) => fields.find((row) => row.key === key).label;

  assert.equal(label('persona'), '旧人设（PERSONA.md 不存在时用）');
  assert.equal(label('personaFile'), '人设文件（优先）');
  assert.equal(label('personaSceneOverlays'), '按场景叠加人设四段');
  assert.equal(label('stripShortPeriod'), '短气泡剥句末句号');
  assert.equal(label('pokeReplyChance'), '回戳的概率');
  assert.equal(label('apiKeyRotate'), '每天轮换 API key');
  assert.equal(label('endpoint'), 'OneBot WebSocket 地址');

  for (const row of fields) {
    assert.ok(!row.label.endsWith('…'), `${row.key} 的标签被截断：${row.label}`);
    assert.ok(!row.label.endsWith('「'), `${row.key} 的标签被截成半句：${row.label}`);
  }
});

test('页面骨架：标题 / 简介 / 通知 / 工具条 / 7 个 tab / 只渲染当前 tab 的区块', () => {
  const session = mount();
  const tree = mountTree(session);

  assert.equal(tree.type, 'SettingsForm', '根节点必须是 primitives 的 SettingsForm（它带保存按钮与只读提示）');
  assert.equal(textOf(nodes(tree, (node) => node.props?.className === 'qq-title')[0]), 'QQ Bridge');
  assert.match(textOf(nodes(tree, (node) => node.props?.className === 'qq-intro')[0]), /按用途分页/);
  assert.match(textOf(nodes(tree, (node) => node.props?.className === 'qq-notice')[0]), /cordis\.patch\.yml/);

  const tabs = nodes(tree, (node) => node.props?.role === 'tab');
  assert.deepEqual(
    tabs.map((node) => textOf(node)),
    ['连接', '会话', '人格', '群聊', '提醒', '感知', '记忆'],
  );
  assert.equal(tabs[0].props['aria-selected'], true, '默认打开「连接」');
  assert.equal(tabs[0].props.tabIndex, 0, '只有当前 tab 是 tab stop（roving tabindex）');
  assert.equal(tabs[1].props.tabIndex, -1);
  assert.equal(tabs[1].props['aria-controls'], 'qq-tabpanel-session');
  assert.equal(textOf(nodes(tree, (node) => node.props?.role === 'tablist')[0].props['aria-label']), '配置分类');
  const panel = nodes(tree, (node) => node.props?.role === 'tabpanel')[0];
  assert.equal(panel.props.id, 'qq-tabpanel-connect');
  assert.equal(panel.props['aria-labelledby'], 'qq-tab-connect');

  // 连接 tab = 连接与运行环境 + 准入与触发，正好两个扁平区块。
  const sections = nodes(panel, (node) => node.type === 'section');
  assert.deepEqual(
    sections.map((node) => textOf(nodes(node, (child) => child.type === 'h3')[0])),
    ['连接与运行环境', '准入与触发'],
  );
  assert.deepEqual(fieldsIn(tree).size, 12, '连接 tab 有 12 个字段');

  // 键盘 ←/→/Home/End 换 tab（事件里没有 DOM，focus 挪不动但切换必须生效）。
  const key = (name) => ({ key: name, preventDefault() {} });
  tabs[0].props.onKeyDown(key('ArrowRight'));
  assert.equal(nodes(rerender(session), (node) => node.props?.role === 'tab')[1].props['aria-selected'], true);
  nodes(rerender(session), (node) => node.props?.role === 'tab')[1].props.onKeyDown(key('End'));
  assert.equal(nodes(rerender(session), (node) => node.props?.role === 'tab')[6].props['aria-selected'], true);
  nodes(rerender(session), (node) => node.props?.role === 'tab')[6].props.onKeyDown(key('Home'));
  assert.equal(nodes(rerender(session), (node) => node.props?.role === 'tab')[0].props['aria-selected'], true);
  nodes(rerender(session), (node) => node.props?.role === 'tab')[0].props.onKeyDown(key('ArrowLeft'));
  assert.equal(nodes(rerender(session), (node) => node.props?.role === 'tab')[6].props['aria-selected'], true, '← 从第一个绕回最后一个');
});

test('人格页：文件参数在上、旧 persona 折进「兼容」、额外要求在正文', () => {
  const session = mount({ values: { ...DEFAULT_VALUES(), persona: '第一行\n第二行' } });
  mountTree(session);
  const tree = openTab(session, '人格');

  const section = nodes(tree, (node) => node.type === 'section')[0];
  assert.equal(textOf(nodes(section, (node) => node.type === 'h3')[0]), '人格与提示词（PERSONA.md 优先）');
  assert.equal(
    textOf(nodes(section, (node) => node.props?.className === 'qq-sectionNote')[0]),
    '人设优先读 cwd 里的 .qq-persona/PERSONA.md：那个文件存在且能解析时，「旧人设」这一项不再生效（启动日志里会写明人设来自文件还是配置）。',
  );

  // 字段顺序：文件参数在前，然后是折叠块，最后是额外要求。
  const order = nodes(section, (node) => node.props?.['data-field'] !== undefined).map((node) => node.props['data-field']);
  assert.deepEqual(order, ['personaFile', 'personaMaxChars', 'personaSceneOverlays', 'persona', 'instructions']);

  const disclosure = nodes(section, (node) => node.type === 'details')[0];
  assert.ok(disclosure, '旧 persona 要折进「兼容」的 <details>');
  assert.equal(textOf(nodes(disclosure, (node) => node.type === 'summary')[0]), '兼容：旧 persona（文件存在时不生效）');
  assert.deepEqual(
    nodes(disclosure, (node) => node.props?.['data-field'] !== undefined).map((node) => node.props['data-field']),
    ['persona'],
    '折叠块里只有旧 persona',
  );

  const persona = fieldsIn(tree).get('persona');
  const textarea = controlIn(persona, isTextarea);
  assert.equal(textarea.props.value, '第一行\n第二行', '多行框必须原样保留换行');
  assert.ok(textarea.props.rows >= 6);
  assert.equal(controlIn(fieldsIn(tree).get('instructions'), isTextarea) !== undefined, true, '额外要求也是多行框');
  assert.equal(nodes(section, (node) => node.props?.className === 'qq-sectionNote').length, 1);
});

test('表达页：机器参数按 标点 / 群聊 / 私聊 分了小标题（气泡数不设上限）', () => {
  const session = mount();
  mountTree(session);
  const tree = openTab(session, '人格');
  const sections = nodes(tree, (node) => node.type === 'section');
  const expression = sections[1];
  assert.equal(textOf(nodes(expression, (node) => node.type === 'h3')[0]), '表达（STYLE.md / 气泡 / 标点 / 补一句）');

  const subTitles = nodes(expression, (node) => node.props?.className === 'qq-subTitle').map((node) => textOf(node));
  assert.deepEqual(subTitles, ['标点', '私聊']);
  const order = nodes(expression, (node) => node.props?.['data-field'] !== undefined).map((node) => node.props['data-field']);
  assert.deepEqual(order.slice(0, 2), ['styleFile', 'styleMaxChars'], '散文（文件）在最前面');
  assert.deepEqual(order.slice(-4), [
    'privateAfterthought',
    'privateAfterthoughtChance',
    'privateAfterthoughtIdleMs',
    'privateAfterthoughtDailyMax',
  ]);
});

test('覆盖标记与恢复默认：行上有 Tag 与按钮，点恢复默认会回到注入的动作上', () => {
  const session = mount({ overrides: ['endpoint'] });
  const events = [];
  const tree = mountTree(session, { resetField: (key) => events.push(['reset', key]) });

  const field = fieldsIn(tree).get('endpoint');
  const tags = tagsIn(field);
  assert.equal(tags.length, 1);
  assert.equal(tags[0].props.tone, 'neutral');
  assert.equal(textOf(tags[0]), '已覆盖');
  const reset = resetIn(field);
  assert.ok(reset, '覆盖过的字段要有「恢复默认」');
  assert.equal(textOf(reset), '恢复默认');
  reset.props.onClick();
  assert.deepEqual(events, [['reset', 'endpoint']]);

  // 没有覆盖的字段不摆这套 chrome。
  assert.equal(tagsIn(fieldsIn(tree).get('accessToken')).length, 0);
  assert.equal(resetIn(fieldsIn(tree).get('accessToken')), undefined);
});

test('切 tab 不丢草稿：改一项 → 切走 → 切回，草稿还在', () => {
  const session = mount();
  mountTree(session);

  let tree = render(session);
  const input = controlIn(fieldsIn(tree).get('endpoint'), isInput);
  input.props.onChange({ target: { value: 'ws://example.test:9999' } });

  tree = render(session);
  assert.equal(controlIn(fieldsIn(tree).get('endpoint'), isInput).props.value, 'ws://example.test:9999');

  tree = openTab(session, '会话');
  assert.equal(fieldsIn(tree).has('endpoint'), false, '切走之后那一页的字段不再渲染');
  tree = openTab(session, '连接');
  assert.equal(
    controlIn(fieldsIn(tree).get('endpoint'), isInput).props.value,
    'ws://example.test:9999',
    '模型只建一次，切 tab 不重建（草稿不丢）',
  );
});

test('搜索：按标签 / 字段名 / 描述 / 区块标题命中，跨 tab，结果行可编辑', () => {
  const session = mount();
  const events = [];
  let tree = mountTree(session, { edit: (key, text) => events.push([key, text]) });
  const search = controlIn(nodes(tree, (node) => node.props?.className === 'qq-toolbar')[0], isSearch);

  const searchFor = (query) => {
    search.props.onChange({ target: { value: query } });
    return rerender(session, { edit: (key, text) => events.push([key, text]) });
  };

  // 字段名（驼峰与下划线都命中 —— 搜索前会去掉空白 / `_` / `-`）。
  tree = searchFor('proactiveIdleMs');
  assert.deepEqual([...fieldsIn(tree).keys()], ['proactiveIdleMs']);
  tree = searchFor('proactive_idle_ms');
  assert.deepEqual([...fieldsIn(tree).keys()], ['proactiveIdleMs']);

  // 短标签。
  tree = searchFor('攒批窗口');
  assert.ok(fieldsIn(tree).has('batchWindowMs'), '标签也能搜');

  // 区块标题：自动复读那一组的所有字段。
  tree = searchFor('自动复读');
  assert.ok(fieldsIn(tree).size >= 8, '按区块标题命中整组');
  assert.ok(fieldsIn(tree).has('repeat'));

  // 描述里的词（跨 tab）。
  tree = searchFor('白名单');
  const whitelist = [...fieldsIn(tree).keys()];
  assert.ok(whitelist.includes('allowUsers') && whitelist.includes('allowTools'));
  const tabLabels = new Set(
    nodes(tree, (node) => node.type === primitivesStub.Tag && node.props.tone === 'outline').map((node) => textOf(node)),
  );
  assert.ok(tabLabels.has('连接') && tabLabels.has('会话'), '搜索结果右侧的 Tag 要标出来源 tab');

  // 结果行本身可编辑，且仍走同一份草稿（props.edit）。
  const field = fieldsIn(tree).get('allowUsers');
  controlIn(field, isInput).props.onChange({ target: { value: '10001, 10002' } });
  assert.deepEqual(events, [['allowUsers', '10001, 10002']]);

  // 空结果有条文案，没有插画。
  tree = searchFor('不存在的配置项');
  assert.deepEqual([...fieldsIn(tree).keys()], []);
  assert.equal(
    textOf(nodes(tree, (node) => node.props?.className === 'qq-empty')[0]),
    '没有匹配的配置项。可以搜字段名（如 proactiveChance）或描述里的词。',
  );

  // Esc 清空搜索，回到分组视图。
  const input = controlIn(nodes(tree, (node) => node.props?.className === 'qq-toolbar')[0], isSearch);
  const event = { key: 'Escape', preventDefault() {} };
  input.props.onKeyDown(event);
  tree = rerender(session);
  assert.equal(fieldsIn(tree).size, 12, '清空搜索回到当前 tab 的分组视图');

  // 点 tab = 清空搜索并切过去。
  tree = searchFor('proactive');
  assert.ok(fieldsIn(tree).size > 0);
  tabNode(tree, '群聊').props.onClick();
  tree = rerender(session);
  assert.equal(
    controlIn(nodes(tree, (node) => node.props?.className === 'qq-toolbar')[0], isSearch).props.value,
    '',
    '搜索框被清空',
  );
  assert.equal(nodes(tree, (node) => node.props?.role === 'tabpanel')[0].props.id, 'qq-tabpanel-group');
});

test('脏状态：已改计数、只看已改、与搜索叠加、非法项计数', () => {
  const session = mount({ overrides: ['proactive', 'batchWindowMs'] });
  let tree = mountTree(session);
  const toolbar = () => nodes(render(session), (node) => node.props?.className === 'qq-toolbar')[0];
  const changedTag = () =>
    nodes(toolbar(), (node) => node.type === primitivesStub.Tag && node.props.tone === 'neutral')[0];
  const onlyChanged = () => nodes(toolbar(), (node) => node.type === primitivesStub.Pill)[0];

  assert.equal(textOf(changedTag()), '已改 2 项');
  assert.equal(onlyChanged().props.disabled, false);
  assert.equal(onlyChanged().props.active, false);

  // 打开「只看已改」：当前 tab（连接）里只剩准入组的 proactive… 不在这页 —— 换到群聊。
  onlyChanged().props.onClick();
  tree = openTab(session, '群聊');
  assert.deepEqual([...fieldsIn(tree).keys()], ['proactive'], '只剩改过的那一行');
  assert.equal(onlyChanged().props.active, true);

  // 与搜索叠加：先按覆盖过滤，再按查询过滤。
  const search = controlIn(toolbar(), isSearch);
  search.props.onChange({ target: { value: 'batch' } });
  tree = rerender(session);
  assert.deepEqual([...fieldsIn(tree).keys()], ['batchWindowMs'], '「只看已改」先过滤掉没改过的行，搜索再命中');
  search.props.onChange({ target: { value: 'proactive' } });
  tree = rerender(session);
  assert.deepEqual([...fieldsIn(tree).keys()], ['proactive']);

  // 恢复默认之后计数减 1；两个都没了之后「只看已改」自动放开、计数 Tag 消失。
  const field = fieldsIn(tree).get('proactive');
  resetIn(field).props.onClick();
  tree = rerender(session);
  assert.equal(textOf(nodes(toolbar(), (node) => node.type === primitivesStub.Tag && node.props.tone === 'neutral')[0]), '已改 1 项');
  // 那一行已经从「只看已改」里消失，换搜另一个再恢复。
  controlIn(toolbar(), isSearch).props.onChange({ target: { value: 'batchWindowMs' } });
  tree = rerender(session);
  resetIn(fieldsIn(tree).get('batchWindowMs')).props.onClick();
  tree = rerender(session);
  assert.equal(
    nodes(toolbar(), (node) => node.type === primitivesStub.Tag && node.props.tone === 'neutral').length,
    0,
    '没有覆盖行时隐藏计数',
  );
  assert.equal(onlyChanged().props.disabled, true, '「只看已改」置灰不可点');

  // 非法项：草稿校验不过时工具条给出「N 项待修正」。
  const numberInput = controlIn(fieldsIn(openTab(session, '会话')).get('batchWindowMs'), isInput);
  numberInput.props.onChange({ target: { value: '不久' } });
  tree = rerender(session);
  const invalidTag = nodes(toolbar(), (node) => node.type === primitivesStub.Tag && node.props.tone === 'danger')[0];
  assert.equal(textOf(invalidTag), '1 项待修正');
  assert.equal(isInvalidValid(tree), true, '那一行的提示要变成错误样式');

  // 改回一个合法值：「只看已改」不应当因为「刚才还是 0 项」而偷偷回到打开状态。
  controlIn(fieldsIn(tree).get('batchWindowMs'), isInput).props.onChange({ target: { value: '2000' } });
  tree = rerender(session);
  assert.equal(textOf(nodes(toolbar(), (node) => node.type === primitivesStub.Tag && node.props.tone === 'neutral')[0]), '已改 1 项');
  assert.ok(fieldsIn(tree).size > 1, '过滤保持关闭：这一页的字段都还在');
});

/** 当前页面上是不是有非法提示（`qq-invalid`）。 */
function isInvalidValid(tree) {
  return nodes(tree, isInvalid).length > 0;
}

test('只读部署：开关 / 输入框 / select / 多行框 / Pill 全部 disabled', () => {
  const session = mount({ writable: false, overrides: ['endpoint'] });
  mountTree(session);
  let tree = render(session);

  for (const [key, field] of fieldsIn(tree)) {
    const controls = nodes(field, (node) => isInput(node) || isSwitch(node) || isSelect(node) || isTextarea(node) || node.type === primitivesStub.Pill);
    for (const control of controls) {
      assert.equal(control.props.disabled, true, `${key} 的控件在只读部署里必须 disabled`);
    }
  }
  const reset = resetIn(fieldsIn(tree).get('endpoint'));
  assert.equal(reset.props.disabled, true, '「恢复默认」也要 disabled');

  tree = openTab(session, '人格');
  assert.equal(controlIn(fieldsIn(tree).get('persona'), isTextarea).props.disabled, true);
});

test('列表行：输入框在，Pill 预览能删掉一个值', () => {
  const session = mount({ values: { ...DEFAULT_VALUES(), allowGroups: ['10001', '10002'] } });
  const events = [];
  const tree = mountTree(session, { edit: (key, text) => events.push([key, text]) });

  const field = fieldsIn(tree).get('allowGroups');
  assert.equal(controlIn(field, isInput).props.value, '10001, 10002');
  const pills = nodes(field, (node) => node.type === primitivesStub.Pill);
  assert.deepEqual(pills.map((node) => textOf(node)), ['10001 ×', '10002 ×']);
  pills[0].props.onClick();
  assert.deepEqual(events, [['allowGroups', '10002']], '点 Pill 的 × 删掉那一个值');
});

test('多行控件：换行原样保留、编辑与恢复默认可达、ⓘ 能展开说明', () => {
  const session = mount({ values: { ...DEFAULT_VALUES(), persona: '第一行\n第二行' }, overrides: ['persona'] });
  const events = [];
  mountTree(session);
  let tree = openTab(session, '人格');

  let field = fieldsIn(tree).get('persona');
  const textarea = controlIn(field, isTextarea);
  assert.equal(textarea.props.value, '第一行\n第二行', '换行必须原样保留');
  textarea.props.onChange({ target: { value: '改过的\n人设' } });
  tree = rerender(session, { edit: (key, text) => events.push(['edit', key, text]) });
  field = fieldsIn(tree).get('persona');
  controlIn(field, isTextarea).props.onChange({ target: { value: '改过的\n人设' } });
  assert.deepEqual(events, [['edit', 'persona', '改过的\n人设']], '编辑要走注入的动作（草稿与校验都在那边）');

  // ⓘ 是完整说明的入口（配置项名也在里面），展开要走 aria-expanded。
  const helpButton = helpButtonIn(field);
  assert.equal(helpButton.props['aria-expanded'], false);
  helpButton.props.onClick();
  tree = rerender(session);
  field = fieldsIn(tree).get('persona');
  assert.equal(helpButtonIn(field).props['aria-expanded'], true);
  const panel = nodes(field, (node) => node.props?.role === 'region')[0];
  assert.ok(panel, '展开后要出现说明区');
  assert.match(textOf(panel), /配置项: persona/, '说明里有配置项名');
});

test('非法值：输入框 aria-invalid、提示走错误色，文案来自字典', () => {
  const session = mount();
  mountTree(session);
  let tree = openTab(session, '群聊');
  const input = controlIn(fieldsIn(tree).get('proactiveCheckMs'), isInput);
  input.props.onChange({ target: { value: '十分钟' } });
  tree = rerender(session);

  const field = fieldsIn(tree).get('proactiveCheckMs');
  const control = controlIn(field, isInput);
  assert.equal(control.props['aria-invalid'], true);
  assert.match(control.props['aria-describedby'], /qq-config-proactiveCheckMs-message/);
  assert.equal(textOf(nodes(field, isInvalid)[0]), '请填数字；留空表示使用默认值');
  assert.equal(nodes(field, isHint).length, 0, '错误与 hint 只显示一个');
});

test('summary 视图：导航项问它时只回一行简介', () => {
  const session = mount();
  resetHooks();
  assert.equal(render(session, { view: 'summary' }), 'QQ 桥接的全部配置，按用途分页；改完在底部一次保存。');
});

test('旧版的卡片 chrome 与折叠状态都删干净了（源码里搜不到它们的名字）', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  for (const gone of ['CARD_STYLE', 'CARD_HEAD_STYLE', 'CARD_BODY_STYLE', 'groupHeader', 'openId', 'groupsHint', 'envNotice', 'DOT_STYLE', 'CHEVRON_STYLE']) {
    assert.ok(!source.includes(gone), `client.js 里不该再有 ${gone}`);
  }
  assert.ok(source.includes('TABS'), 'tab 映射必须写在 client.js 里');
  assert.ok(source.includes('FIELD_HINTS'), '量纲白名单必须写在 client.js 里');
});
