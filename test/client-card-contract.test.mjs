// 侧边栏卡片的产品契约：**真实点击驱动**，不用 setCardOpen 之类的钩子。
//
// 为什么单开一份文件（而不是继续往 client-behavior 里加）：
// 上一轮把一批用例改成"用 __internals.setCardOpen 直接摆形态、然后读元素树"，
// 于是"点整条数据能展开""点顶部当前行能收起"这两件**用户唯一会做的事**没有任何
// 判据在管——全绿却与实屏不符。这组用例只允许两种驱动方式：
//   1. 点击元素树里某个节点的 onClick（就是用户点下去的那一下）；
//   2. 在同一个节点上派发 keydown Enter / Space（键盘用户的那一下）。
// 读形态一律读渲染出来的文本与 aria，不读模块内部变量。
//
// 元素树 ≠ 实屏：这里断言的是"组件在给定数据下会渲染出什么、点击后变成什么"，
// 不等于像素级布局。实屏仍需真机确认（报告里单列）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// 心跳定时器不许拖住测试进程。
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const handle = realSetInterval(fn, ms, ...rest);
  handle.unref?.();
  return handle;
};

// ---- 迷你 React（与 client-behavior 同一套最小实现）----
function makeRuntime() {
  const state = [];
  const effects = [];
  let cursor = 0;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }),
    useState: (init) => {
      const i = cursor++;
      if (!(i in state)) state[i] = typeof init === 'function' ? init() : init;
      return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v; }];
    },
    useRef: (init) => {
      const i = cursor++;
      if (!(i in state)) state[i] = { current: init };
      return state[i];
    },
    useMemo: (fn, deps) => {
      const i = cursor++;
      const prev = state[i];
      if (!prev || deps.some((d, k) => !Object.is(d, prev.deps[k]))) state[i] = { deps, value: fn() };
      return state[i].value;
    },
    useCallback: (fn, deps) => {
      const i = cursor++;
      const prev = state[i];
      if (!prev || deps.some((d, k) => !Object.is(d, prev.deps[k]))) state[i] = { deps, fn };
      return state[i].fn;
    },
    useEffect: (fn, deps) => {
      const i = cursor++;
      const prev = state[i];
      if (!prev || deps.some((d, k) => !Object.is(d, prev.deps[k]))) {
        state[i] = { deps };
        effects.push({ fn, i });
      }
    },
    useSyncExternalStore: (_sub, snap) => snap(),
  };
  return {
    react,
    render(fn) {
      cursor = 0;
      const out = fn();
      const pending = effects.splice(0, effects.length);
      for (const e of pending) e.fn();
      return { out };
    },
  };
}

/** 载入 client.js，返回 sidebar.footer.action 槽位的组件。 */
function loadCard(runtime) {
  const win = { __ModuleLoader__: { load: (def) => { win.__def = def; } } };
  new Function('window', 'require', source)(win, (id) => (id === 'react' ? runtime.react : {}));
  const mod = win.__def.factory((id) => (id === 'react' ? runtime.react : {}));
  const registered = {};
  const localeState = { active: 'zh' };
  const ctx = {
    get: () => undefined,
    locale: {
      subscribe: () => () => {},
      getSnapshot: () => ({ active: localeState.active, locales: [], revision: 0 }),
      bind: () => (k) => (localeState.active === 'zh' ? k : EN_DICT[k] ?? k),
      register: () => {},
    },
    remote: { $on: () => () => {} },
    effect: (fn) => { fn(); return () => {}; },
    slots: { inject: (_n, fn) => fn(), register: (meta, comp) => { registered[meta.name] = comp; }, entries: () => [] },
  };
  mod.apply(ctx);
  return registered['sidebar.footer.action'];
}

/** 英文界面下组件会去问的几个键（只镜像本文件用到的）。 */
const EN_DICT = {};

function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node.children) return node.children.map(textOf).join('');
  return '';
}

function nodesOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) { node.forEach((n) => nodesOf(n, out)); return out; }
  if (typeof node !== 'object') return out;
  out.push(node);
  if (node.children) node.children.forEach((n) => nodesOf(n, out));
  return out;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 渲染一次槽位组件。 */
function renderCard(Comp, runtime, props = { wide: true }) {
  const element = Comp(props);
  return runtime.render(() => element.type(element.props));
}

// ---- 交互基元：只有"用户真的能做的那两下" ----

/**
 * 找一个可点节点。`want` 是 aria-label 的**子串**（中文界面）。
 *
 * 为什么按 aria 找而不按文本：文本会随数据变（余额数字、渠道名），拿它当锚点的
 * 用例在数据一换时就静默失效；aria 是给屏幕阅读器的名字，本来就必须稳定。
 */
function clickableByAria(out, want) {
  return nodesOf(out).filter((n) => n.props
    && typeof n.props.onClick === 'function'
    && typeof n.props['aria-label'] === 'string'
    && n.props['aria-label'].includes(want));
}

/** 点一下这个节点（用户点下去的那一下）。 */
function click(node) {
  node.props.onClick({ stopPropagation() {} });
}

/** 在这个节点上按 Enter / Space（键盘用户的那一下）。 */
function press(node, key) {
  assert.equal(typeof node.props.onKeyDown, 'function', `节点「${node.props['aria-label']}」必须可键盘操作`);
  let prevented = false;
  node.props.onKeyDown({ key, preventDefault() { prevented = true; } });
  return prevented;
}

/** 卡片的展开态开关（aria-label 随形态变，两者都可点）。 */
const EXPAND_RE = /展开|Show all/i;
const COLLAPSE_RE = /收回|Collapse/i;
const REFRESH_RE = /刷新|Refresh/i;

/**
 * 造一个 fetch：账户响应 + 采集快照分开给。
 *
 * 两条请求是并行的，所以按 URL 前缀分派；其余一律当"没有"处理——本文件只关心
 * 卡片，不要顺手把假期表之类也造出来。
 */
function makeFetch(accountBody, snapshotBody) {
  const calls = [];
  const impl = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.startsWith('/api/quota-usage/snapshot')) {
      return { ok: true, status: 200, json: async () => snapshotBody };
    }
    if (target.startsWith('/api/quota-usage/holidays')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, ranges: [] }) };
    }
    return { ok: true, status: 200, json: async () => accountBody };
  };
  return { impl, calls };
}

/**
 * 渲染到稳定，返回 { out, Comp, runtime, calls, rerender }。
 *
 * `session` 可选：给 root 标准 props 的 `useSessions` 用（模拟当前会话）。
 */
async function mount(accountBody, snapshotBody, { session } = {}) {
  const { impl, calls } = makeFetch(accountBody, snapshotBody);
  globalThis.fetch = impl;
  const runtime = makeRuntime();
  const Comp = loadCard(runtime);
  const props = { wide: true };
  if (session !== undefined) props.useSessions = makeSessionsHook(session);
  const rerender = () => renderCard(Comp, runtime, props).out;
  rerender();
  await flush();
  return { out: rerender(), rerender, calls, Comp, runtime };
}

/** 宿主风格的 useSessions：当前会话由 retainedBy.mainView 标记。 */
function makeSessionsHook(box) {
  const sessions = {
    'session-a': { id: 'session-a', retainedBy: { mainView: 0 } },
    'session-b': { id: 'session-b', retainedBy: { mainView: 0 } },
  };
  const stateOf = () => {
    for (const key of Object.keys(sessions)) {
      sessions[key].retainedBy.mainView = sessions[key].id === box.current ? 1 : 0;
    }
    return { ids: Object.keys(sessions), byId: sessions, phase: 'ready' };
  };
  return (selector) => selector(stateOf());
}

// ---- 真实数据形状（取自本机 GET 的两份响应）------------------------------

/**
 * 本机真实形状之一：**账户路由 id 与快照来源 id 不同**。
 *
 * GET /api/quota-usage?lang=zh →
 *   provider: { id: 'codex-chatgpt', kind: 'none', reason: 'unsupported' }
 * GET /api/quota-usage/snapshot →
 *   subscription.value.subscriptions[0] = { provider: 'openai-codex', ok: true,
 *     mode: 'plugin', accounts: [ {windows:[5h 0, 7d 100]}, {windows:[5h 52, 7d 14]} ] }
 *
 * 用户在真机上看到的就是「不支持 codex-chatgpt」——能力表按 `openai-codex` 索引，
 * 第三方插件把同一份订阅注册成了 `codex-chatgpt`。界面的判据必须是**数据**：
 * 快照里有没有这个订阅来源（经别名归一），而不是账户路由 id 在不在能力表里。
 *
 * 同时它是**多账号**形状：两个账号各自的窗口值不同，收缩态若只取第一个账号，
 * 用户会以为第二个账号没有额度。
 */
const REAL_CODEX_ACCOUNT = {
  ok: true,
  provider: { id: 'codex-chatgpt', displayName: 'codex-chatgpt', kind: 'none', reason: 'unsupported', via: 'none' },
  balance: { isAvailable: null, total: null, currency: null },
  usage: null,
  tier: { input: null, cacheRead: null, cacheWrite: null, output: null, known: false, currency: 'CNY', window: null },
  next: { peak: false, at: null, ms: 0 },
  peak: false,
  updatedAt: Date.now(),
  errors: ['当前插件不支持 codex-chatgpt'],
};

const REAL_CODEX_SNAPSHOT = {
  ok: true,
  snapshots: {
    subscription: {
      value: {
        mode: 'plugin',
        primary: 'plugin',
        subscriptions: [{
          ok: true,
          mode: 'plugin',
          provider: 'openai-codex',
          displayName: 'OpenAI Codex',
          plan: 'plus',
          accounts: [
            { id: 'acc-1', alias: 'first@example.com', plan: 'plus', active: true, windows: [{ key: '5h', percent: 0, resetsAt: null }, { key: '7d', percent: 100, resetsAt: null }] },
            { id: 'acc-2', alias: 'second@example.com', plan: 'plus', active: false, windows: [{ key: '5h', percent: 52, resetsAt: null }, { key: '7d', percent: 14, resetsAt: null }] },
          ],
        }],
        skipped: [],
      },
      updatedAt: Date.now(),
      stale: false,
    },
    credits: {
      value: {
        available: true,
        currentChannel: 'trae',
        channels: [
          { channel: 'trae', state: 'ok', remaining: 5069.03, total: 7400, percent: 68.5, unit: 'credits' },
          { channel: 'buddy', state: 'ok', remaining: 2927.18, total: 3521, percent: 83.1, unit: 'credits' },
        ],
      },
      updatedAt: Date.now(),
      stale: false,
    },
    prepaid: {
      value: {
        providers: [
          // 同一家厂商的两条路由：收缩态必须只认 id 完全相同的那条。
          { provider: 'deepseek-official', displayName: 'DeepSeek', kind: 'balance', balance: { isAvailable: true, total: 6970.17, currency: 'CNY', used: null }, ok: true, code: null },
          { provider: 'deepseek-account', displayName: 'DeepSeek Account', kind: 'balance', balance: { isAvailable: true, total: 147.49, currency: 'CNY', used: null }, ok: true, code: null },
          { provider: 'openrouter', displayName: 'OpenRouter', kind: 'balance', balance: { isAvailable: true, total: 12.5, currency: 'USD', used: 7.5 }, ok: true, code: null },
        ],
      },
      updatedAt: Date.now(),
      stale: false,
    },
  },
};

/** DeepSeek 官方（余额型）：收缩态要显示 ¥6970.17，且必须是 deepseek-official 那条。 */
const DS_BALANCE_ACCOUNT = {
  ok: true,
  provider: { id: 'deepseek-official', displayName: 'DeepSeek', kind: 'balance', reason: null },
  balance: { isAvailable: true, total: 6970.17, currency: 'CNY' },
  usage: null,
  tier: { input: 2, cacheRead: 0.04, output: 8, known: true, currency: 'CNY', window: 'idle' },
  next: { peak: false, at: null, ms: 0 },
  peak: false,
  updatedAt: Date.now(),
  errors: [],
};

/** trae（免费渠道）：账户读数恒为「—」，收缩态只能靠快照里 trae 那一行。 */
const TRAE_ACCOUNT = {
  ok: true,
  provider: { id: 'trae', displayName: 'trae', kind: 'none', reason: 'unsupported', via: 'none' },
  balance: { isAvailable: null, total: null, currency: null },
  usage: null,
  tier: { input: null, cacheRead: null, cacheWrite: null, output: null, known: false, currency: 'CNY', window: null },
  next: { peak: false, at: null, ms: 0 },
  peak: false,
  updatedAt: Date.now(),
  errors: [],
};

// ---- 契约 1：真实 id 差异 —— codex-chatgpt 要看到 GPT 订阅窗口 ----------

test('契约1：账户路由是 codex-chatgpt（kind none）时，收缩态显示快照里的 GPT 订阅窗口', async () => {
  const { out } = await mount(REAL_CODEX_ACCOUNT, REAL_CODEX_SNAPSHOT);
  const text = textOf(out);
  assert.ok(!/不支持|does not support/i.test(text),
    `不得对 codex-chatgpt 说「不支持」——同一份订阅就在快照里，实际：${text}`);
  // 窗口值取自**多账号**：第一个账号 5h 已用 0% → 剩余 100；7d 已用 100% → 剩余 0。
  // 这里断言的是"有窗口读数上屏"，而不是某个具体格式。
  assert.ok(/Codex/i.test(text), `收缩态应指出当前来源是 Codex，实际：${text}`);
  assert.ok(/5\s*小时|5H/i.test(text), `收缩态应出现 5 小时窗口，实际：${text}`);
  assert.ok(/7\s*天|7D/i.test(text), `收缩态应出现 7 天窗口，实际：${text}`);
});

test('契约1b：展开态同样显示 GPT 订阅，且两个账号的读数都在', async () => {
  const { out, rerender } = await mount(REAL_CODEX_ACCOUNT, REAL_CODEX_SNAPSHOT);
  const expand = clickableByAria(out, '展开');
  assert.equal(expand.length, 1, `收缩态应恰有一个「展开」入口，实际 ${expand.length} 个：${textOf(out)}`);
  click(expand[0]);
  await flush();
  const text = textOf(rerender());
  assert.ok(!/不支持|does not support/i.test(text), `展开态也不得说「不支持」，实际：${text}`);
  assert.ok(/Codex/i.test(text), `展开态应出现 Codex 订阅来源，实际：${text}`);
  // 多账号：两个别名都要在（只画第一个账号 = 用户以为第二个账号没额度）。
  assert.ok(/first@example\.com/.test(text), `应显示账号一，实际：${text}`);
  assert.ok(/second@example\.com/.test(text), `应显示账号二，实际：${text}`);
});

// ---- 契约 2：收缩只显示当前厂商，且充值型要精确匹配当前 API ------------

test('契约2：收缩态只显示当前厂商那一行，同厂商的另一条路由不得冒充', async () => {
  const { out } = await mount(DS_BALANCE_ACCOUNT, REAL_CODEX_SNAPSHOT);
  const text = textOf(out);
  // 当前是 deepseek-official：只能看到它自己的 6970.17。
  assert.ok(text.includes('6970.17'), `收缩态应显示 deepseek-official 的余额，实际：${text}`);
  // deepseek-account 是同厂商的另一条路由（147.49），绝不能因为"同厂商"就顶上来。
  assert.ok(!text.includes('147.49'), `收缩态不得显示同厂商另一条路由的余额，实际：${text}`);
  // 更不该把别家（OpenRouter / 积分渠道 / Codex）列出来。
  assert.ok(!/OpenRouter/i.test(text), `收缩态不得显示别家充值来源，实际：${text}`);
  assert.ok(!/trae|buddy/i.test(text), `收缩态不得显示积分渠道，实际：${text}`);
  assert.ok(!/Codex/i.test(text), `收缩态不得显示订阅来源，实际：${text}`);
});

// ---- 契约 3：展开态顶部保留与收缩态同源同内容的当前行 ------------------

test('契约3：展开态顶部保留当前行，且与收缩态同源同内容', async () => {
  const { out, rerender } = await mount(DS_BALANCE_ACCOUNT, REAL_CODEX_SNAPSHOT);
  const collapsedText = textOf(out);
  assert.ok(collapsedText.includes('6970.17'), `收缩态应显示当前余额，实际：${collapsedText}`);

  const openRow = rowNode(out, '展开', ['6970.17', 'DeepSeek']);
  assert.ok(openRow, `收缩态应有"自身即数据行"的展开入口；实际：${JSON.stringify(
    clickableByAria(out, '展开').map((n) => ownText(n)))}`);
  click(openRow);
  await flush();
  const openOut = rerender();
  const openText = textOf(openOut);

  // 展开态：三大类分区都在。
  for (const title of ['订阅', '充值', '积分']) {
    assert.ok(openText.includes(title), `展开态应出现分区「${title}」，实际：${openText}`);
  }
  // 展开态顶部仍有当前那一行 —— 按**节点位置**判，不按全文 indexOf：
  // 全文里第一个 6970.17 也可能来自「充值」分区里那一行（那不是"顶部当前行"）。
  const top = rowNode(openOut, '收回', ['6970.17', 'DeepSeek']);
  assert.ok(top, `展开态顶部必须有"自身即当前行"的节点（含 6970.17 + DeepSeek）；实际可点节点：${JSON.stringify(
    clickableByAria(openOut, '收回').map((n) => ownText(n)))}`);
  const nodes = nodesOf(openOut);
  const atTop = nodes.indexOf(top);
  const atSub = firstSectionTitleIndex(openOut, '订阅');
  assert.ok(atSub >= 0, `展开态应出现「订阅」分区标题，实际：${openText}`);
  assert.ok(atTop < atSub,
    `顶部当前行必须排在「订阅」分区之前（节点序 ${atTop} vs 分区 ${atSub}）；实际：${openText}`);
});

/**
 * 第一个文本恰好等于 `title` 的节点（分区标题）在整树里的下标。
 *
 * 为什么不用全文 indexOf：分区标题与单位（「积分」）、渠道名会撞子串，
 * 而"顶部当前行在分区之前"是一个**结构**断言，必须按节点位置判。
 */
function firstSectionTitleIndex(root, title) {
  const nodes = nodesOf(root);
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    if (!n.props || typeof n.props.onClick === 'function') continue;
    if (textOf(n).trim() === title) return i;
  }
  return -1;
}

/**
 * 一个节点**自身子树**里的可读文本（不含它的兄弟、也不含祖先）。
 *
 * 用途：证明"被点的那一下，点的确实是那条数据行"。
 * 只看全卡文本是不够的——整卡文本里本来就有 6970.17，一个小三角按钮的点击也能让
 * 全卡文本发生变化，于是"点 ▸ 展开"和"点整行展开"在断言层面完全一样（假绿）。
 */
function ownText(node) {
  return textOf(node);
}

/**
 * 断言这个节点自己是**数据行**，不是一个纯箭头/纯刷新按钮。
 *
 * 判据三条一起成立才算：
 *   1. 自身子树里有真实数据（`must` 里的每一条都命中）——这排除了"只有一个 ▸"；
 *   2. 自身文本去掉箭头/刷新字符后仍有内容——排除"▸"、"⟳"这类装饰字符冒充整行；
 *   3. 不是纯刷新按钮（aria 里不含"刷新/Refresh"）。
 */
function assertRowNode(node, must, what) {
  const text = ownText(node);
  const aria = typeof node.props['aria-label'] === 'string' ? node.props['aria-label'] : '';
  assert.ok(!/刷新|Refresh/i.test(aria), `${what}：被点节点不能是纯刷新按钮（aria=${aria}）`);
  const bare = text.replace(/[▸▾⟳\s]/g, '');
  assert.ok(bare !== '', `${what}：被点节点自身不能只有一个箭头/图标，实际文本 ${JSON.stringify(text)}`);
  for (const needle of must) {
    assert.ok(text.includes(needle),
      `${what}：被点节点自身子树必须含「${needle}」（这才是"整条数据行"），实际 ${JSON.stringify(text)}`);
  }
}

/** 断言节点带公开语义 aria-expanded 且值为期望。 */
function assertExpanded(node, want, what) {
  assert.equal(node.props['aria-expanded'], want,
    `${what}：必须用公开语义 aria-expanded=${want}，实际 ${JSON.stringify(node.props['aria-expanded'])}`);
}

/** 一个可控 event：记录 stopPropagation 是否真的被调用。 */
function makeEvent() {
  const calls = { stopPropagation: 0, preventDefault: 0 };
  return {
    calls,
    stopPropagation() { calls.stopPropagation += 1; },
    preventDefault() { calls.preventDefault += 1; },
  };
}

/** 在最深的匹配节点里挑出"自身含数据"的那个（找不到就返回 null）。 */
function rowNode(out, ariaWant, must) {
  const candidates = clickableByAria(out, ariaWant);
  for (const node of candidates) {
    const text = ownText(node);
    if (!must.every((needle) => text.includes(needle))) continue;
    const bare = text.replace(/[▸▾⟳\s]/g, '');
    if (bare === '') continue;
    return node;
  }
  return null;
}

// ---- 契约 4：点击整条数据展开，点击顶部当前行收起，Enter/Space 双向 ------

test('契约4：被点的节点自身就是整条数据行（不是小三角），点它展开', async () => {
  const { out, rerender } = await mount(DS_BALANCE_ACCOUNT, REAL_CODEX_SNAPSHOT);

  // 收缩态：展开入口必须**自己是那条数据行**——自身子树里有余额与厂商名。
  const row = rowNode(out, '展开', ['6970.17', 'DeepSeek']);
  assert.ok(row, `收缩态必须有一个"自身就是数据行"的展开入口；实际可点节点：${JSON.stringify(
    clickableByAria(out, '展开').map((n) => ownText(n)))}`);
  assertRowNode(row, ['6970.17', 'DeepSeek'], '收缩态整行');
  assertExpanded(row, false, '收缩态整行');

  // 小三角可以同时存在，但**不能是唯一入口**：上面那个带数据的节点必须也能点。
  click(row);
  await flush();
  const current = rerender();
  const text = textOf(current);
  assert.ok(text.includes('订阅'), `点整条应展开出三大类，实际：${text}`);

  // 展开态：收起入口必须是顶部那条**当前行**（自身含当前数据），且排在分区之前。
  const top = rowNode(current, '收回', ['6970.17']);
  assert.ok(top, `展开态必须有一个"自身就是顶部当前行"的收起入口；实际：${JSON.stringify(
    clickableByAria(current, '收回').map((n) => ownText(n)))}`);
  assertExpanded(top, true, '展开态顶部当前行');
  // 顶部：这个节点在整树里的位置必须早于「订阅」这个分区标题。
  const nodes = nodesOf(current);
  const atNode = nodes.indexOf(top);
  const atSection = nodes.findIndex((n) => n.props && typeof n.props.onClick !== 'function' && textOf(n).trim() === '订阅');
  assert.ok(atSection === -1 || atNode < atSection,
    `顶部当前行必须在「订阅」分区之前（节点序 ${atNode} vs 分区 ${atSection}）`);

  click(top);
  await flush();
  const collapsed = textOf(rerender());
  assert.ok(!collapsed.includes('订阅') && !collapsed.includes('积分') && !collapsed.includes('充值'),
    `点顶部当前行应收起（分区消失），实际：${collapsed}`);
  assert.ok(collapsed.includes('6970.17'), `收起后仍应显示当前行，实际：${collapsed}`);
});

test('契约4b：键盘 Enter / Space 双向都能切形态（同一数据行节点）', async () => {
  const { out, rerender } = await mount(DS_BALANCE_ACCOUNT, REAL_CODEX_SNAPSHOT);
  let node = rowNode(out, '展开', ['6970.17', 'DeepSeek']);
  assert.ok(node, '收缩态应有一个自带数据的展开入口');
  // Enter 展开
  press(node, 'Enter');
  await flush();
  let current = rerender();
  assert.ok(textOf(current).includes('订阅'), `Enter 应展开，实际：${textOf(current)}`);

  node = rowNode(current, '收回', ['6970.17']);
  assert.ok(node, '展开态应有一个自带数据的顶部当前行');
  // Space 收起
  press(node, ' ');
  await flush();
  current = rerender();
  assert.ok(!textOf(current).includes('订阅'), `Space 应收起，实际：${textOf(current)}`);

  // 反向再来一遍：Space 展开、Enter 收起。
  const openNode = rowNode(current, '展开', ['6970.17', 'DeepSeek']);
  assert.ok(openNode, '再次展开前应有展开入口');
  press(openNode, ' ');
  await flush();
  current = rerender();
  assert.ok(textOf(current).includes('订阅'), `Space 应展开，实际：${textOf(current)}`);
  press(rowNode(current, '收回', ['6970.17']), 'Enter');
  await flush();
  current = rerender();
  assert.ok(!textOf(current).includes('订阅'), `Enter 应收起，实际：${textOf(current)}`);
});

test('契约4c：头部厂商名/余额区域（数据行的子区域）点击也能切换', async () => {
  const { out, rerender } = await mount(DS_BALANCE_ACCOUNT, REAL_CODEX_SNAPSHOT);
  // 找最内层那个只含「DeepSeek」文本、自身**没有** onClick 的后代（就是头部名称区域）。
  const all = nodesOf(out);
  const nameNode = all.find((n) => n.props && typeof n.props.onClick !== 'function'
    && textOf(n).trim() === 'DeepSeek');
  assert.ok(nameNode, `收缩态应有厂商名区域，实际：${textOf(out)}`);
  // 它的某个祖先必须可点且带数据（命中区覆盖名称，而不是只有箭头）。
  const clickables = clickableByAria(out, '展开');
  const covers = clickables.some((n) => nodesOf(n).includes(nameNode));
  assert.ok(covers,
    `厂商名区域必须落在某个可点的数据行内（命中区覆盖名称而不只是箭头）；实际可点节点：${JSON.stringify(
      clickables.map((n) => ownText(n)))}`);
  // 并且点那个祖先确实能展开。
  const row = rowNode(out, '展开', ['6970.17', 'DeepSeek']);
  click(row);
  await flush();
  assert.ok(textOf(rerender()).includes('订阅'), '点名称区域应能展开');
});

// ---- 契约 5：刷新独立，不切换形态 ---------------------------------------

test('契约5：点刷新只重新取数，不改变展开形态，且真的 stopPropagation', async () => {
  const { out, rerender, calls } = await mount(DS_BALANCE_ACCOUNT, REAL_CODEX_SNAPSHOT);
  const before = calls.filter((u) => u.startsWith('/api/quota-usage?')).length;
  const refresh = clickableByAria(out, '刷新');
  assert.ok(refresh.length >= 1, `收缩态应有刷新入口，实际：${textOf(out)}`);

  // 刷新必须**阻止冒泡**：否则点击会连带触发外层数据行的 toggle。
  const ev = makeEvent();
  refresh[0].props.onClick(ev);
  await flush();
  assert.equal(ev.calls.stopPropagation, 1,
    `刷新必须调用一次 stopPropagation（否则冒泡到整行会切换形态），实际调用 ${ev.calls.stopPropagation} 次`);

  const after = calls.filter((u) => u.startsWith('/api/quota-usage?')).length;
  assert.ok(after > before, `点刷新必须重新取数，实际 ${before} → ${after}`);
  // 形态没变：仍是收缩态（没有分区标题）。
  const text = textOf(rerender());
  assert.ok(!text.includes('订阅'), `刷新不得改变形态，实际：${text}`);

  // 展开态下点刷新同样不许把形态改掉。
  click(rowNode(out, '展开', ['6970.17', 'DeepSeek']));
  await flush();
  const openOut = rerender();
  assert.ok(textOf(openOut).includes('订阅'));
  const ev2 = makeEvent();
  clickableByAria(openOut, '刷新')[0].props.onClick(ev2);
  await flush();
  assert.equal(ev2.calls.stopPropagation, 1, '展开态刷新也必须 stopPropagation');
  assert.ok(textOf(rerender()).includes('订阅'), '展开态刷新后应仍是展开态');
});

// ---- 契约 6：切会话更新当前行 -------------------------------------------

test('契约6：切换会话后当前行跟着换成新会话的厂商', async () => {
  const box = { current: 'session-a' };
  const { out, rerender, calls } = await mount(DS_BALANCE_ACCOUNT, REAL_CODEX_SNAPSHOT, { session: box });
  assert.ok(textOf(out).includes('6970.17'), `会话 A 应显示 DeepSeek 余额，实际：${textOf(out)}`);
  // 请求带了会话 A。
  const first = calls.filter((u) => u.startsWith('/api/quota-usage?')).pop();
  assert.ok(/session=session-a/.test(first), `请求应带会话 id，实际：${first}`);

  // 切到会话 B：宿主对新会话回的是另一个厂商。
  box.current = 'session-b';
  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.startsWith('/api/quota-usage/snapshot')) {
      return { ok: true, status: 200, json: async () => REAL_CODEX_SNAPSHOT };
    }
    if (target.startsWith('/api/quota-usage/holidays')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, ranges: [] }) };
    }
    return { ok: true, status: 200, json: async () => TRAE_ACCOUNT };
  };
  rerender();
  await flush();
  const text = textOf(rerender());
  const last = calls.filter((u) => u.startsWith('/api/quota-usage?')).pop();
  assert.ok(/session=session-b/.test(last), `切换会话后请求应带新会话 id，实际：${last}`);
  assert.ok(text.includes('5069'), `切到 trae 后收缩态应显示 trae 的积分，实际：${text}`);
  assert.ok(!text.includes('6970.17'), `切会话后不该还留着上一个会话的读数，实际：${text}`);
});

// ---- 契约 7：当前厂商没有数据时，不得冒充别家 ---------------------------

test('契约7：当前厂商在快照里没有数据时，收缩态不得拿别家的数字冒充', async () => {
  // 当前是 qodercn，快照里只有 trae / buddy。
  const ghost = {
    ok: true,
    provider: { id: 'qodercn', displayName: 'qodercn', kind: 'none', reason: 'unsupported', via: 'none' },
    balance: { isAvailable: null, total: null, currency: null },
    usage: null,
    tier: { input: null, known: false },
    next: { peak: false, at: null, ms: 0 },
    peak: false,
    updatedAt: Date.now(),
    errors: [],
  };
  const { out } = await mount(ghost, REAL_CODEX_SNAPSHOT);
  const text = textOf(out);
  // 不能出现任何别家的数字。
  assert.ok(!text.includes('5069'), `不得显示 trae 的积分，实际：${text}`);
  assert.ok(!text.includes('2927'), `不得显示 buddy 的积分，实际：${text}`);
  assert.ok(!text.includes('6970.17'), `不得显示 DeepSeek 的余额，实际：${text}`);
  assert.ok(!/Codex/i.test(text), `不得显示 Codex 订阅，实际：${text}`);
  // 必须说清"这个渠道没有数据"，而不是留空。
  assert.ok(text.trim() !== '', '收缩态不得空白');
  assert.ok(/未显示|无可用数据|读取中|—|不支持/i.test(text), `应说明当前厂商没有数据，实际：${text}`);
});

// ---- 契约 8：现有读数（剩余 / 总额 / 单位 / 百分比）不得丢失 ------------

test('契约8：积分行的剩余、总额、单位、百分比都还在（总额在悬浮说明里）', async () => {
  const { out, rerender } = await mount(TRAE_ACCOUNT, REAL_CODEX_SNAPSHOT);
  const collapsed = out;

  // 定位到**承载这一行读数的那几个节点**，而不是在全文里找子串：
  // 全文里有 5069 也可能来自别的渲染路径（比如另一处摘要），那样断言会放过
  // "正文读数丢了、但某处恰好也印了同一个数"的回归。
  const readNodes = nodesOf(collapsed).filter((n) => n.props && typeof n.props.style === 'object');
  const withRemain = readNodes.filter((n) => textOf(n).includes('5069'));
  assert.ok(withRemain.length > 0, `收缩态应有一个节点承载剩余 5069，实际：${textOf(collapsed)}`);
  // 单位与剩余必须**在同一个节点子树**里（「5069 积分」是这一行的读数形态）。
  assert.ok(withRemain.some((n) => textOf(n).includes('积分')),
    `剩余与单位应同处一个节点子树，实际：${JSON.stringify(withRemain.map(textOf))}`);
  // 百分比同样落在这一行的节点子树里。
  assert.ok(withRemain.some((n) => textOf(n).includes('68.5%')),
    `百分比应与剩余同处一个节点子树，实际：${JSON.stringify(withRemain.map(textOf))}`);

  // 总额 7400 的实际承载位置是**这一行的 title**（正文放不下，见实现注释）。
  // 所以断言必须落在"含 5069 的那个节点"自己的 title 上，而不是全树任意 title。
  const rowTitles = withRemain
    .map((n) => (typeof n.props.title === 'string' ? n.props.title : ''))
    .filter((v) => v !== '');
  assert.ok(rowTitles.some((v) => v.includes('7400')),
    `总额 7400 必须挂在承载这一行的节点 title 上（不许凭空消失），实际该行 title：${JSON.stringify(rowTitles)}`);

  // 展开态：同一行的四个读数一个不少，且仍挂在同一行的节点上。
  const openRowNode = rowNode(out, '展开', ['5069']);
  assert.ok(openRowNode, `收缩态应有"自身即数据行"的展开入口；实际：${JSON.stringify(
    clickableByAria(out, '展开').map((n) => ownText(n)))}`);
  click(openRowNode);
  await flush();
  const openOut = rerender();
  const openRead = nodesOf(openOut).filter((n) => n.props && typeof n.props.style === 'object' && textOf(n).includes('5069'));
  assert.ok(openRead.length > 0, `展开态应有节点承载剩余 5069，实际：${textOf(openOut)}`);
  assert.ok(openRead.some((n) => textOf(n).includes('积分')), `展开态剩余旁应有单位，实际：${textOf(openOut)}`);
  assert.ok(openRead.some((n) => textOf(n).includes('68.5%')), `展开态剩余旁应有百分比，实际：${textOf(openOut)}`);
  const openRowTitles = openRead
    .map((n) => (typeof n.props.title === 'string' ? n.props.title : ''))
    .filter((v) => v !== '');
  assert.ok(openRowTitles.some((v) => v.includes('7400')),
    `展开态总额 7400 也必须在同一行的 title 上，实际：${JSON.stringify(openRowTitles)}`);
});

test('契约8b：订阅窗口的百分比方向是「剩余」（宿主 percent 是已用）', async () => {
  // 真机样本最容易写反的地方：宿主 `windows[].percent` 是**已用**，界面画的是**剩余**。
  // 用一组互补对（13/87、42/58）钉住方向——写反了必然被抓住，而单向数字（0 / 100）
  // 互补后与原值相同，抓不住（这正是旧判据漏掉方向错误的原因）。
  //
  // 数据源必须用**快照**：收缩态那一行来自 `subscription.value.subscriptions[]`，
  // 账户响应里的 `usage.windows` 是另一条路径（仪表盘）。用错数据源会让这条用例
  // 测到不相干的东西（第一版就踩了这个坑：拿到了快照账号的 0/100）。
  const dirSnapshot = {
    ok: true,
    snapshots: {
      subscription: {
        value: {
          mode: 'plugin',
          primary: 'plugin',
          subscriptions: [{
            ok: true,
            mode: 'plugin',
            provider: 'openai-codex',
            displayName: 'OpenAI Codex',
            plan: 'plus',
            accounts: [{
              id: 'acc-1', alias: 'first@example.com', plan: 'plus', active: true,
              windows: [{ key: '5h', percent: 13, resetsAt: null }, { key: '7d', percent: 42, resetsAt: null }],
            }],
          }],
          skipped: [],
        },
        updatedAt: Date.now(),
        stale: false,
      },
    },
  };
  const dirBody = {
    ok: true,
    provider: { id: 'openai-codex', displayName: 'OpenAI Codex', kind: 'oauth', reason: null },
    balance: { isAvailable: null, total: null, currency: null },
    usage: { windows: [{ key: '5h', percent: 13, resetsAt: null }, { key: '7d', percent: 42, resetsAt: null }] },
    tier: { input: null, known: false, currency: 'USD', window: null },
    next: { peak: false, at: null, ms: 0 },
    peak: false,
    updatedAt: Date.now(),
    errors: [],
  };
  const { out } = await mount(dirBody, dirSnapshot);
  const text = textOf(out);
  // 剩余值必须上屏。
  assert.ok(text.includes('87%'), `5 小时已用 13% → 应显示剩余 87%，实际：${text}`);
  assert.ok(text.includes('58%'), `7 天已用 42% → 应显示剩余 58%，实际：${text}`);
  // 反向：已用值不得冒充剩余（用边界避开数字内部子串）。
  assert.ok(!/(^|[^\d])13%/.test(text), `不得把已用的 13% 画成剩余，实际：${text}`);
  assert.ok(!/(^|[^\d])42%/.test(text), `不得把已用的 42% 画成剩余，实际：${text}`);
});

// ---- 契约 9：当前厂商未知时，收缩态不得退化成"全部" ----------------------
//
// 这条对应一个已经发生过的实现缺陷：
//   `const only = collapsed && currentProviderId !== '' ? currentProviderId : null`
// 「收缩态没有当前厂商」和「展开态」被压成了同一个值（都传 null），于是：
//   · 宿主没给 provider.id（旧宿主 / 首次渲染 / 错误响应）时，收缩态画的是**全部**；
//   · 用户以为自己在看"当前模型那一行"，其实那是全机所有来源的列表。
// 两者必须分开：展开态是"我要看全部"，当前未知是"我不知道该给你看哪一行"，
// 后者必须**明确说出来**，不能拿别人的数据顶上。

test('契约9：provider.id 为空时，收缩态不得退化成展开态（全量）', async () => {
  const noProvider = {
    ok: true,
    // 老宿主 / 首次渲染：响应里没有 provider 字段。
    balance: { isAvailable: null, total: null, currency: null },
    usage: null,
    tier: { input: null, known: false },
    next: { peak: false, at: null, ms: 0 },
    peak: false,
    updatedAt: Date.now(),
    errors: [],
  };
  const { out } = await mount(noProvider, REAL_CODEX_SNAPSHOT);
  const text = textOf(out);

  // 没有当前厂商 → 不许把全量列出来（那就是"收缩态 = 展开态"的老缺陷）。
  assert.ok(!/OpenRouter/i.test(text), `当前厂商未知时不得列出别家充值来源，实际：${text}`);
  assert.ok(!/trae|buddy/i.test(text), `当前厂商未知时不得列出积分渠道，实际：${text}`);
  assert.ok(!/Codex/i.test(text), `当前厂商未知时不得列出订阅来源，实际：${text}`);
  // 也不许出现分区标题（有标题就是全量形态）。
  for (const title of ['订阅', '充值', '积分']) {
    assert.ok(!text.includes(title), `当前厂商未知时不得出现分区标题「${title}」，实际：${text}`);
  }
  // 必须**明确**说明状态，而不是空白、也不是拿别人的数字顶上。
  assert.ok(text.trim() !== '', '当前厂商未知时不得空白');
  assert.ok(/未知|未识别|不支持|未显示|无可用数据|读取中|—/.test(text),
    `当前厂商未知时应明确说明，实际：${text}`);
});

test('契约9b：当前厂商未知时仍可展开看全量（形态切换不受"未知"影响）', async () => {
  const noProvider = {
    ok: true,
    balance: { isAvailable: null, total: null, currency: null },
    usage: null,
    tier: { input: null, known: false },
    next: { peak: false, at: null, ms: 0 },
    peak: false,
    updatedAt: Date.now(),
    errors: [],
  };
  const { out, rerender } = await mount(noProvider, REAL_CODEX_SNAPSHOT);
  // 「未知"是收缩态的状态，不是禁止展开——用户还是应该能主动看全部。
  const expand = clickableByAria(out, '展开');
  assert.ok(expand.length >= 1, `当前厂商未知时仍应给出展开入口，实际：${textOf(out)}`);
  click(expand[0]);
  await flush();
  const text = textOf(rerender());
  for (const title of ['订阅', '充值', '积分']) {
    assert.ok(text.includes(title), `展开态应出现分区「${title}」，实际：${text}`);
  }
});

// ---- 契约 10：顶部当前行必须是"当前那一行"，不是永远那条积分摘要 --------
//
// 上一版实现里，收缩态顶部那一行来自 `creditSummaryOf(...)`：它是**积分专区**的
// 摘要，于是：
//   · 当前模型是 DeepSeek 官方（充值型）时，顶部仍写着某个积分渠道的名字与积分；
//   · 当前模型是 Codex（订阅型）时，顶部还是积分渠道。
// 用户看到的是"我明明在用 X，顶上却写着 Y"。
//
// 正确口径：顶部那一行必须**同源**于当前厂商所属的那一类数据——
//   充值型 → 充值分区里精确匹配当前 API 的那一行（金额）；
//   订阅型 → 订阅分区里匹配当前订阅来源的那一行（窗口）；
//   积分型 → 积分分区里匹配当前渠道的那一行（积分）。

test('契约10：当前是充值型时，顶部当前行来自充值分区（金额），不是积分摘要', async () => {
  const { out, rerender } = await mount(DS_BALANCE_ACCOUNT, REAL_CODEX_SNAPSHOT);

  // 按**节点**定位顶部那一行：它自身必须含当前金额与厂商名。
  const top = rowNode(out, '展开', ['6970.17', 'DeepSeek']);
  assert.ok(top, `充值型顶部必须是"自身含 6970.17 + DeepSeek"的那一行；实际：${JSON.stringify(
    clickableByAria(out, '展开').map((n) => ownText(n)))}`);
  const own = ownText(top);
  // 金额形态：带币种符号（这是"金额行"而不是"积分数"的标志）。
  assert.ok(own.includes('¥'), `顶部金额行自身应带币种符号，实际 ${JSON.stringify(own)}`);
  // 不得借用积分渠道的数据（那是另一类数据）。
  assert.ok(!/trae|buddy/i.test(own), `充值型顶部行自身不得含积分渠道，实际 ${JSON.stringify(own)}`);
  assert.ok(!own.includes('5069'), `充值型顶部行自身不得含积分数值，实际 ${JSON.stringify(own)}`);

  // 展开态：顶部那一行仍在分区之前，且内容不变（同源）。
  click(top);
  await flush();
  const openOut = rerender();
  const openTop = rowNode(openOut, '收回', ['6970.17', 'DeepSeek']);
  assert.ok(openTop, `展开态顶部应保留同一行（6970.17 + DeepSeek）；实际：${JSON.stringify(
    clickableByAria(openOut, '收回').map((n) => ownText(n)))}`);
  const atTop = nodesOf(openOut).indexOf(openTop);
  const atSec = firstSectionTitleIndex(openOut, '订阅');
  assert.ok(atSec >= 0 && atTop < atSec,
    `展开态顶部当前行必须排在「订阅」分区之前（${atTop} vs ${atSec}）`);
});

test('契约10b：当前是订阅型时，顶部当前行来自订阅分区（窗口），不是积分摘要', async () => {
  // **夹具必须是同一个数据源。**
  //
  // 顶部当前行复用「订阅」分区里那一行（同源同内容），而那一行读的是**快照**
  // `subscription.value.subscriptions[].accounts[].windows`。如果这里只把账户响应的
  // `usage.windows` 改成 13/42、快照仍留 0/100，就等于要求界面把两个不同来源的数
  // 混进行——那是错的要求（同源就变成不同源了）。
  //
  // 所以两份夹具同口径：快照窗口 13 / 42（**已用**），界面应画剩余 87% / 58%。
  const dirSnapshot = {
    ok: true,
    snapshots: {
      subscription: {
        value: {
          mode: 'plugin',
          primary: 'plugin',
          subscriptions: [{
            ok: true,
            mode: 'plugin',
            provider: 'openai-codex',
            displayName: 'OpenAI Codex',
            plan: 'plus',
            accounts: [{
              id: 'acc-1', alias: 'first@example.com', plan: 'plus', active: true,
              windows: [{ key: '5h', percent: 13, resetsAt: null }, { key: '7d', percent: 42, resetsAt: null }],
            }],
          }],
          skipped: [],
        },
        updatedAt: Date.now(),
        stale: false,
      },
    },
  };
  const codexOauth = {
    ok: true,
    provider: { id: 'openai-codex', displayName: 'OpenAI Codex', kind: 'oauth', reason: null },
    balance: { isAvailable: null, total: null, currency: null },
    usage: { windows: [{ key: '5h', percent: 13, resetsAt: null }, { key: '7d', percent: 42, resetsAt: null }] },
    tier: { input: null, known: false, currency: 'USD', window: null },
    next: { peak: false, at: null, ms: 0 },
    peak: false,
    updatedAt: Date.now(),
    errors: [],
  };
  const { out } = await mount(codexOauth, dirSnapshot);

  // 顶部那一行自身必须含窗口读数（剩余 87 / 58，宿主 percent 是已用）。
  const top = rowNode(out, '展开', ['87%']);
  assert.ok(top, `订阅型顶部必须是"自身含窗口剩余 87%"的那一行；实际：${JSON.stringify(
    clickableByAria(out, '展开').map((n) => ownText(n)))}`);
  const own = ownText(top);
  assert.ok(own.includes('58%'), `顶部行自身应同时含 7 天剩余 58%，实际 ${JSON.stringify(own)}`);
  // 方向不能反：已用的 13/42 不得被画成剩余。
  assert.ok(!/(^|[^\d])13%/.test(own), `顶部行不得把已用的 13% 画成剩余，实际 ${JSON.stringify(own)}`);
  assert.ok(!/(^|[^\d])42%/.test(own), `顶部行不得把已用的 42% 画成剩余，实际 ${JSON.stringify(own)}`);
  // 不得借用积分渠道的名字/数值。
  assert.ok(!/trae|buddy/i.test(own), `订阅型顶部行自身不得含积分渠道，实际 ${JSON.stringify(own)}`);
  assert.ok(!own.includes('5069'), `订阅型顶部行自身不得含积分数值，实际 ${JSON.stringify(own)}`);
});

test('契约10c：顶部行与展开态同一分区里的同一行数值一致（同源）', async () => {
  const { out, rerender } = await mount(TRAE_ACCOUNT, REAL_CODEX_SNAPSHOT);

  // 顶部那一行自身必须含 trae 的剩余与百分比。
  const top = rowNode(out, '展开', ['5069']);
  assert.ok(top, `积分型顶部必须是"自身含 5069"的那一行；实际：${JSON.stringify(
    clickableByAria(out, '展开').map((n) => ownText(n)))}`);
  const own = ownText(top);
  assert.ok(own.includes('68.5%'), `顶部行自身应含百分比，实际 ${JSON.stringify(own)}`);
  // 收缩态只能有当前那一个渠道的数。
  assert.ok(!own.includes('2927'), `顶部行自身不得混入 buddy 的读数，实际 ${JSON.stringify(own)}`);
  assert.ok(!own.includes('7400'), `顶部行自身不得混入总额，实际 ${JSON.stringify(own)}`);

  click(top);
  await flush();
  const openOut = rerender();
  // 展开态里 trae 那一行的读数与顶部**相等**（同源，不是两个渲染器各算一遍）。
  const openRead = nodesOf(openOut).filter((n) => n.props && typeof n.props.style === 'object' && textOf(n).includes('5069'));
  assert.ok(openRead.length > 0, `展开态 trae 行应同样是 5069，实际：${textOf(openOut)}`);
  assert.ok(openRead.some((n) => textOf(n).includes('68.5%')),
    `展开态 trae 行的百分比应与顶部一致（68.5%），实际：${textOf(openOut)}`);
});

// ---- 契约 11：三类快照为空 / 纯余额机器 —— 回退场景也要守口径 1 -----------
//
// 用户口径（lead 复述的产品决定，选 1）：
//   「整条当前数据/状态始终切换形态，刷新独立 ⟳，**包括纯余额 / 三类未采到场景**。」
//
// 这一段考的是**回退路径**：采集器还没跑过（快照 `{}`），三大类卡不存在，
// 界面退到「账户卡」。此时最常见的实现退化是——账户卡整张挂 onClick = 刷新，
// 于是同一个侧边栏位置，有数据时点一下是"切形态"，没数据时点一下就变成"刷新"。
// 用户点下去之前无法预判，这是最容易在回退路径上丢掉一致性的地方。
//
// 判据只钉两件用户可观察的事，不规定视觉设计：
//   1. 整条（数据/状态）的手势**不得**是取数——取数是独立 ⟳ 的职责；
//   2. 独立 ⟳ 必须真实触发一次取数（A4 的等价要求，不放宽）。

/** 纯余额机器的账户响应：`kind: 'balance'`，读到金额。 */
const PURE_BALANCE_BODY = {
  ok: true,
  provider: { id: 'deepseek-official', displayName: 'DeepSeek', kind: 'balance', reason: null },
  balance: { isAvailable: true, total: 6970.17, currency: 'CNY' },
  usage: null,
  tier: { input: 2, cacheRead: 0.04, output: 8, known: true, currency: 'CNY', window: 'idle' },
  next: { peak: false, at: null, ms: 0 },
  peak: false,
  updatedAt: Date.now(),
  errors: [],
};

/** 三类都没采到：采集器尚未跑过一轮。 */
const EMPTY_SNAPSHOT = { ok: true, snapshots: {} };

const usageCallsOf = (calls) => calls.filter((u) => u.startsWith('/api/quota-usage?')).length;

test('契约11：三类快照为空（纯余额）时，整条手势不得是刷新', async () => {
  const { out, rerender, calls } = await mount(PURE_BALANCE_BODY, EMPTY_SNAPSHOT);
  const text = textOf(out);
  // 回退路径必须真的画出了余额（否则这条用例测的是空白卡）。
  assert.ok(text.includes('6970.17'), `纯余额机器应显示余额，实际：${text}`);

  const before = usageCallsOf(calls);
  // 找"整条状态"那个可点节点：它承载当前数据，且**不是**刷新按钮。
  const rows = clickableByAria(out, '展开').filter((n) => !/刷新|Refresh/i.test(
    typeof n.props['aria-label'] === 'string' ? n.props['aria-label'] : ''));
  if (rows.length > 0) {
    // 有形态入口时：点它只切形态，不取数。
    click(rows[0]);
    await flush();
    const after = usageCallsOf(calls);
    assert.equal(after, before,
      `点形态入口不得触发取数（那是刷新按钮的职责），实际 ${before} → ${after}`);
    // 形态确实变了（aria-expanded 公开语义翻转）。
    const toggled = clickableByAria(rerender(), '收回');
    assert.ok(toggled.length > 0, '点过形态入口后应能从「收回」找到同一个开关');
    assert.equal(toggled[0].props['aria-expanded'], true, '开关形态后 aria-expanded 应为 true');
    return;
  }

  // 没有形态入口时：整卡**也不许**把刷新当手势——那是口径 1 明确否掉的退化。
  const cardRoots = nodesOf(out).filter((n) => n.props
    && typeof n.props.onClick === 'function'
    && typeof n.props['aria-label'] === 'string'
    && /账户用量|Account usage/i.test(n.props['aria-label']));
  assert.equal(cardRoots.length, 0,
    '回退路径上整卡不得挂"点击刷新"的手势（口径1：整条切形态、刷新独立 ⟳）；'
    + `实际仍有 ${cardRoots.length} 个整卡可点刷新入口：${JSON.stringify(cardRoots.map((n) => n.props['aria-label']))}`);
});

test('契约11b：同上场景，独立 ⟳ 仍必须真实触发一次取数（A4 不放宽）', async () => {
  const { out, rerender, calls } = await mount(PURE_BALANCE_BODY, EMPTY_SNAPSHOT);
  const refresh = clickableByAria(out, '刷新');
  assert.ok(refresh.length >= 1, `回退路径上必须有独立的刷新入口，实际：${textOf(out)}`);

  const before = usageCallsOf(calls);
  const ev = makeEvent();
  refresh[0].props.onClick(ev);
  await flush();

  assert.equal(ev.calls.stopPropagation, 1,
    `刷新必须 stopPropagation 一次（否则冒泡到整条会切形态），实际 ${ev.calls.stopPropagation} 次`);
  const after = usageCallsOf(calls);
  assert.ok(after > before, `刷新必须真实触发取数，实际 ${before} → ${after}`);
  // 刷新不得改变形态：仍能按「展开」找到形态入口（或该场景本就没有形态入口时不该凭空冒出「收回」）。
  const reopened = clickableByAria(rerender(), '收回');
  assert.equal(reopened.length, 0, '刷新不得把形态切到展开');
});
