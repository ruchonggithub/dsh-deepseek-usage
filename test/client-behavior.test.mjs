// 客户端行为验证：并发乱序、重试阶梯、卸载后不写状态。
// 用真实的 lib/client.js + 可控 fetch + 迷你 React 运行时。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/**
 * 组件的心跳（30s interval）与补请求定时器会让 Node 的事件循环一直活着，
 * 测试进程就退不出来。这里把 interval 换成 unref 的版本：它照样被记录、
 * 照样能被触发，但不再阻止进程退出。
 */
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const handle = realSetInterval(fn, ms, ...rest);
  handle.unref?.();
  return handle;
};

// ---- 迷你 React：支持状态、effect、依赖比较 ----
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
    state,
    /** 渲染一次并执行新增的 effect（模拟 React 的 commit）。 */
    render(fn) {
      cursor = 0;
      const out = fn();
      const pending = effects.splice(0, effects.length);
      const cleanups = [];
      for (const e of pending) {
        const cleanup = e.fn();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
      }
      return { out, cleanups };
    },
  };
}

/** 迷你 DSH locale 服务里 en 的词典（真实 locale 服务会返回译文，这里按需镜像一份）。 */
const EN_DICT = {
  'price.input': 'Input',
  'price.cache': 'Input cache',
  'price.output': 'Output',
  'price.perMillion': 'Price per 1M tokens',
  'currency.CNY': 'CNY',
  'currency.USD': 'USD',
  'hint.peak': 'Peak pricing in',
  'hint.idle': 'Off-peak pricing in',
  'hint.switching': 'Price change imminent',
  'status.peak': 'Peak hours',
  'status.idle': 'Off-peak hours',
  'status.error': 'Balance unavailable',
  'status.unavailable': 'This provider has no query API',
  'card.label': 'Account usage, click to refresh',
};

/** 载入 client.js 并拿到注册进 sidebar.footer.action 槽位的组件。lang 决定界面语言。 */
function loadClient(runtime, lang = 'zh', services = {}) {
  return loadSlots(runtime, lang, services)['sidebar.footer.action'];
}

/** 载入 client.js 并返回按槽位名索引的注册组件表。services 模拟 ctx.get(name)。 */
function loadSlots(runtime, lang = 'zh', services = {}) {
  const win = { __ModuleLoader__: { load: (def) => { win.__def = def; } } };
  new Function('window', 'require', source)(win, (id) => (id === 'react' ? runtime.react : {}));
  const mod = win.__def.factory((id) => (id === 'react' ? runtime.react : {}));
  const registered = {};
  // 可变语言状态：测试改 localeState.active 后重渲染即可模拟 DSH 切换语言。
  const localeState = { active: lang };
  // `settings.section` 的注册选项（id / order / label thunk），供设置项用例断言。
  let sectionOptions;
  // `conversation.view` 的注册选项：会话内「用量」Tab 的 id / order / label。
  let viewOptions;
  const ctx = {
    get: (name) => services[name],
    locale: {
      subscribe: () => () => {},
      getSnapshot: () => ({ active: localeState.active, locales: [], revision: 0 }),
      // 与 DSH 一致：中文直接给 key（组件回退中文词典），其它语言回退英文词典。
      bind: () => (k) => (localeState.active === 'zh' ? k : EN_DICT[k] ?? k),
      register: () => {},
    },
    remote: { $on: () => () => {} },
    effect: (fn) => { fn(); return () => {}; },
    slots: {
      // 按槽位名分派：本插件注册的槽位各自有测试取用。
      inject: (_n, fn) => fn(),
      register: (meta, comp) => {
        registered[meta.name] = comp;
        if (meta.name === 'settings.section') sectionOptions = meta;
        if (meta.name === 'conversation.view') viewOptions = meta;
      },
      // 槽位账本：测试通过 services.slotsEntries 伪造 sidebar.settings 的注册项。
      entries: (name) => (services.slotsEntries ? services.slotsEntries(name) : []),
    },
  };
  mod.apply(ctx);
  Object.defineProperty(registered, 'localeState', { value: localeState, enumerable: false });
  Object.defineProperty(registered, 'sectionOptions', { value: () => sectionOptions, enumerable: false });
  Object.defineProperty(registered, 'viewOptions', { value: () => viewOptions, enumerable: false });
  return registered;
}

/** 渲染槽位组件：它返回的是一个元素，真正的组件在 element.type 里。 */
function renderCard(Comp, runtime, props = { wide: true }) {
  const element = Comp(props);
  return runtime.render(() => element.type(element.props));
}

/**
 * 造一个宿主风格的 `useSessions` 选择器（root 标准 props）。
 *
 * 形状照着宿主来：`SessionListState = { ids, byId, phase }`，`byId[id].retainedBy.mainView`
 * 是"这个会话正被主面板持有"的计数——切会话时它在两个会话之间转移。测试用它断言
 * 「卡片会跟着当前会话走」。
 *
 * @param {{current: string}} box 可变的当前会话（模拟用户切会话）
 */
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

/**
 * 递归展开函数组件（含包裹层的子组件），统一在一次 runtime.render 里执行。
 * 迷你 React 的 hook 槽位是全局游标，展开顺序固定，因此重渲染时各组件状态仍落在
 * 同一批槽位上——足以覆盖「映射编辑器 + 令牌区」这种一个槽位里嵌两个组件的结构。
 */
function renderTree(runtime, root) {
  return runtime.render(() => {
    const expand = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return node;
      if (Array.isArray(node)) return node.map(expand);
      if (typeof node.type === 'function') return expand(node.type(node.props));
      return node.children ? { ...node, children: node.children.map(expand) } : node;
    };
    return expand(root);
  });
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node.children) return node.children.map(textOf).join('');
  return '';
}

/** 深度收集元素树上的所有节点（含自身）。 */
function nodesOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) {
    node.forEach((n) => nodesOf(n, out));
    return out;
  }
  if (typeof node !== 'object') return out;
  out.push(node);
  if (node.children) node.children.forEach((n) => nodesOf(n, out));
  return out;
}

/** 计费区间指示灯：role="img" 的 8px 定位盒子（45px 的仪表盘同样是 role="img"，靠宽度区分）。 */
function isDotNode(node) {
  return !!(node.props && node.props.role === 'img' && node.props.style && node.props.style.width === 8);
}

const okResponse = (total) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    balance: { total, currency: 'CNY' },
    tier: { input: 2, cacheRead: 0.04, output: 8, known: true, currency: 'CNY', window: 'idle' },
    next: { at: Date.now() + 3_600_000 },
    peak: false,
    errors: [],
  }),
});

/** 可定制的宿主响应：峰谷状态与下次切换时刻由用例指定。 */
const stateResponse = (peak, nextAt) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    provider: { id: 'deepseek-official', kind: 'balance' },
    balance: { isAvailable: true, total: 5.35, currency: 'CNY' },
    tier: {
      input: 2, cacheRead: 0.04, output: 8, model: 'deepseek-flash', known: true,
      currency: 'CNY', window: peak ? 'peak' : 'idle',
    },
    next: { at: nextAt },
    peak,
    updatedAt: Date.now(),
    errors: [],
  }),
});

/** 旧宿主的响应：tier 里没有 window / currency 两个新字段。 */
const legacyResponse = (peak, nextAt) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    provider: { id: 'deepseek-official', kind: 'balance' },
    balance: { isAvailable: true, total: 5.35, currency: 'CNY' },
    tier: { input: 2, cacheRead: 0.04, output: 8, model: 'deepseek-flash', known: true },
    next: { at: nextAt },
    peak,
    errors: [],
  }),
});

/** 非 DeepSeek provider 的按量计费响应：价格表命中，全天一价（window: null）。 */
const providerPriceResponse = (over = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    provider: { id: 'zai', displayName: 'Z.ai (GLM)', kind: 'balance', reason: null },
    balance: { isAvailable: true, total: 8.5, currency: 'USD' },
    tier: {
      input: 0.6, cacheRead: 0.11, output: 2.2, model: 'glm-4.6', known: true,
      currency: 'USD', window: null,
    },
    next: { peak: false, at: null, ms: 0 },
    peak: false,
    updatedAt: Date.now(),
    errors: [],
    ...over,
  }),
});

/** 订阅用量形态的宿主响应（provider.kind = usage）。 */
const usageResponse = (windows) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    provider: { id: 'opencode', displayName: 'OpenCode', kind: 'usage', reason: null },
    balance: { isAvailable: null, total: null, currency: null },
    usage: { plan: null, windows },
    tier: { input: 2, known: false },
    next: { at: Date.now() + 3_600_000 },
    peak: false,
    errors: [],
  }),
});

/** 不可查 provider 的宿主响应：errors 里带一句原因，读数全空。 */
const unsupportedResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    provider: { id: 'workbuddy', displayName: 'Workbuddy', kind: 'none', reason: 'unsupported' },
    balance: { isAvailable: null, total: null, currency: null },
    usage: null,
    tier: { input: 2, known: false },
    next: { at: Date.now() + 3_600_000 },
    peak: false,
    errors: ['当前插件不支持 Workbuddy'],
  }),
});

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 可控 fetch：把请求挂起，测试自己决定何时、以什么结果返回。 */
/**
 * 卡片同时请求两条数据：USAGE_PATH（余额/订阅）与 SNAPSHOT_PATH（采集缓存）。
 * 这个 mock 只把 Usage 请求挂起交给测试控制，快照请求直接回一个空快照——
 * 那些用例断言的是余额/订阅行为，与积分无关；积分路径另有专门的用例。
 */
function makePendingFetch() {
  const pending = [];
  globalThis.fetch = (url) => {
    const target = String(url);
    if (target.startsWith('/api/quota-usage/snapshot')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, snapshots: {} }),
      });
    }
    return new Promise((resolve) => pending.push({ url: target, resolve }));
  };
  return {
    pending,
    usage: () => pending.filter((p) => p.url.startsWith('/api/quota-usage?')),
  };
}

test('晚到的旧响应不覆盖新数据', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  assert.equal(usage().length, 1, '挂载后应发出一次余额请求');

  renderCard(Comp, runtime).out.props.onClick();
  assert.equal(usage().length, 2, '点击应发出第二次余额请求');

  usage()[1].resolve(okResponse(999));
  await flush();
  assert.ok(textOf(renderCard(Comp, runtime).out).includes('999.00'));

  usage()[0].resolve(okResponse(1));
  await flush();
  const text = textOf(renderCard(Comp, runtime).out);
  assert.ok(text.includes('999.00'), `旧响应不得覆盖新数据，实际 ${text}`);
});

test('晚到的旧失败不抹掉新余额', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  renderCard(Comp, runtime).out.props.onClick();
  usage()[1].resolve(okResponse(777));
  await flush();
  usage()[0].resolve({ ok: false, status: 500, json: async () => ({ ok: false, message: 'boom' }) });
  await flush();
  const text = textOf(renderCard(Comp, runtime).out);
  assert.ok(text.includes('777.00'), `旧失败不得抹掉新余额，实际 ${text}`);
  assert.ok(!text.includes('boom'), '旧失败的文案不应上屏');
});

test('失败按阶梯补请求；成功一次会取消待发的补请求并复位阶梯', async () => {
  const delays = [];
  const realSetTimeout = globalThis.setTimeout;
  let scheduled = [];
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms >= 1000) {
      delays.push(ms);
      scheduled.push(fn);
    }
    return realSetTimeout(fn, ms, ...rest);
  };
  let mode = 'fail';
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return mode === 'fail'
      ? { ok: false, status: 500, json: async () => ({ ok: false, message: 'x' }) }
      : okResponse(42);
  };

  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  await flush();
  assert.ok(delays.includes(4000), `失败后应安排 4s 补请求，实际 ${delays.join(',')}`);

  // 补请求还挂着的时候，一次成功必须把它撤掉：否则它到点后再打一发，
  // 若那次失败就会把刚拿到的余额换成错误态。
  // 4s 的阶梯等不起，改为直接验证"待发的那个定时器被清掉了"。
  const cleared = [];
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.clearTimeout = (handle) => {
    cleared.push(handle);
    return realClearTimeout(handle);
  };
  const before = calls.length;
  mode = 'ok';
  renderCard(Comp, runtime).out.props.onClick();
  await flush();
  assert.equal(delays.length, 1, `成功后不应再安排补请求，实际 ${delays.join(',')}`);
  assert.ok(cleared.length > 0, '成功后必须清掉待发的补请求定时器');
  globalThis.clearTimeout = realClearTimeout;
  globalThis.setTimeout = realSetTimeout;
});

test('一次失败后再成功：错误文案消失，余额显示出来', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  // 第一次失败
  usage()[0].resolve({ ok: false, status: 500, json: async () => ({ ok: false, message: 'boom' }) });
  await flush();
  let text = textOf(renderCard(Comp, runtime).out);
  assert.ok(text.includes('boom'), `失败时应显示错误，实际 ${text}`);

  // 再点一次并成功
  renderCard(Comp, runtime).out.props.onClick();
  usage()[1].resolve(okResponse(6.66));
  await flush();
  text = textOf(renderCard(Comp, runtime).out);
  assert.ok(text.includes('6.66'), `成功后应显示余额，实际 ${text}`);
  assert.ok(!text.includes('boom'), '成功后错误文案必须消失');
});

test('宿主返回的假期表覆盖内置表：峰谷判定跟着宿主走', async () => {
  // 宿主可以把接下来 11 天标成假期。那些天里没有高峰/空闲翻转点，
  // 下一个切换点要等到第 12 天（一个工作日）的 09:00 —— 倒计时会显示"十几天"。
  // 若组件用的是内置表而不是宿主返回的这份，倒计时会指向今天的下一个整点（不到一天）。
  const { pending } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);

  const ranges = [];
  const base = Date.now();
  for (let i = 0; i < 11; i += 1) {
    // 假期按北京时间的日历日算，这里也要用北京日期（比 UTC 多 8 小时）。
    const d = new Date(base + i * 86400000 + 8 * 3600_000);
    ranges.push([d.toISOString().slice(0, 10), d.toISOString().slice(0, 10)]);
  }
  const holidays = pending.find((p) => p.url.includes('/holidays'));
  assert.ok(holidays, '挂载后应拉一次假期表');
  holidays.resolve({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, ranges }),
  });
  await flush();

  const usage = pending.find((p) => p.url.startsWith('/api/quota-usage?'));
  usage.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      provider: { id: 'deepseek-official', kind: 'balance' },
      balance: { total: 1, currency: 'CNY' },
      tier: { input: 2, known: true, currency: 'CNY', window: 'peak' },
      next: { at: null, ms: 0 },
      peak: true,
      errors: [],
    }),
  });
  await flush();

  const out = renderCard(Comp, runtime).out;
  // 剩余时间只放在指示灯的悬浮说明里（卡片上不再显示倒计时文本）。
  const titles = nodesOf(out).map((n) => n.props && n.props.title).filter((t) => typeof t === 'string');
  const hint = titles.find((t) => t.includes('还剩'));
  assert.ok(hint, `悬浮说明应给出剩余时间，实际 ${JSON.stringify(titles)}`);
  // 宿主表生效时至少还有 10 天。不能写死 10/11——11 天假往后可能撞上周末
  // （例如从周二起算，第 12 天才是工作日 09:00），天数取决于当天是周几。
  const days = /(\d+) 天/.exec(hint);
  assert.ok(days, `悬浮说明应以"天"显示，实际 ${hint}`);
  assert.ok(Number(days[1]) >= 10, `悬浮说明应按宿主的假期表指向十几天后，实际 ${hint}`);
});

test('卸载后不再写入状态', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  const { cleanups } = renderCard(Comp, runtime);
  cleanups.forEach((c) => c());
  usage()[0].resolve(okResponse(1));
  await flush();
  const text = textOf(renderCard(Comp, runtime).out);
  assert.ok(!text.includes('1.00'), `卸载后不得写入状态，实际 ${text}`);
});

// ---- 多提供商账户读数的渲染 ----------------------------------------------

test('订阅用量形态：一张卡片里同时渲染所有窗口', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  usage()[0].resolve(usageResponse([
    { key: '5h', percent: 4, resetsAt: null },
    { key: '7d', percent: 34, resetsAt: Date.now() + 86_400_000 },
  ]));
  await flush();
  const out = renderCard(Comp, runtime).out;
  const text = textOf(out);
  // 每个窗口一个仪表盘：百分比在弧内，周期缩写徽章在底部缺口。
  assert.ok(text.includes('5H'), `应显示 5 小时徽章，实际 ${text}`);
  assert.ok(text.includes('7D'), `应显示 7 天徽章，实际 ${text}`);
  // 弧内只显示剩余量（不带百分号），字号 15；完整百分比留到悬浮说明。
  const numbers = nodesOf(out).filter((n) => n.props && n.props.style && n.props.style.fontSize === 15).map(textOf);
  assert.deepEqual(numbers, ['96', '66'], `弧内应显示剩余量（不带百分号），实际 ${JSON.stringify(numbers)}`);
  assert.ok(!text.includes('%'), `卡片上不再显示百分号，实际 ${text}`);
  assert.ok(!text.includes('—'), `拿到数据后不应有占位符，实际 ${text}`);
  // 完整周期名与重置倒计时在悬浮说明里（环内放不下）。
  const titles = nodesOf(out).map((n) => n.props && n.props.title).filter((t) => typeof t === 'string');
  assert.ok(titles.some((t) => t.includes('5 小时：已用 4%')), `5 小时窗口应有完整悬浮说明，实际 ${titles.join(' | ')}`);
  assert.ok(titles.some((t) => t.includes('7 天：已用 34%，')), `7 天窗口的悬浮说明应带重置倒计时，实际 ${titles.join(' | ')}`);
});

test('订阅用量 + 峰谷时段：不再画指示灯，峰谷信息挂在卡片悬浮说明里', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  usage()[0].resolve({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      provider: { id: 'opencode-go', displayName: 'OpenCode Go', kind: 'usage', reason: null },
      balance: { isAvailable: null, total: null, currency: null },
      usage: { plan: null, windows: [{ key: '5h', percent: 12, resetsAt: null }, { key: '30d', percent: 56, resetsAt: null }] },
      tier: { input: null, cacheRead: null, output: null, known: false, currency: 'CNY', window: 'peak' },
      next: { peak: false, at: Date.now() + 3 * 3_600_000 },
      peak: true,
      updatedAt: Date.now(),
      errors: [],
    }),
  });
  await flush();
  const out = renderCard(Comp, runtime).out;
  const text = textOf(out);
  // 指示灯已按用户要求去掉：卡片上不再有那个 8px 的状态点。
  const dots = nodesOf(out).filter(isDotNode);
  assert.equal(dots.length, 0, `不应再有指示灯，实际 ${JSON.stringify(dots.map((n) => n.props['aria-label']))}`);
  // 峰谷信息没有丢：它挂在整张卡片的悬浮说明上（命中区比 8px 的小点大得多）。
  const titles = nodesOf(out).map((n) => n.props && n.props.title).filter((t) => typeof t === 'string');
  assert.ok(titles.some((t) => t.includes('还剩')), `卡片悬浮说明应给出剩余时间，实际 ${JSON.stringify(titles)}`);
  assert.ok(!/2h \d+m/.test(text), `卡片上不应再显示倒计时文本，实际 ${text}`);
  // 订阅制不显示单价行（价格数字 0.04 不应出现）。
  assert.ok(!text.includes('0.04'), `订阅卡片不应显示单价，实际 ${text}`);
});

test('订阅用量形态：接口返回三个档位时三个都上屏并按 5H→7D→1M 排列', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  usage()[0].resolve(usageResponse([
    { key: '30d', percent: 58, resetsAt: Date.now() + 86400_000 },
    { key: '5h', percent: 1, resetsAt: null },
    { key: '7d', percent: 24, resetsAt: null },
  ]));
  await flush();
  const text = textOf(renderCard(Comp, runtime).out);
  const at5h = text.indexOf('5H');
  const at7d = text.indexOf('7D');
  const at1m = text.indexOf('1M');
  assert.ok(at5h >= 0 && at7d > at5h && at1m > at7d, `窗口应按 5H→7D→1M 排列，实际 ${text}`);
  const numbers = nodesOf(renderCard(Comp, runtime).out).filter((n) => n.props && n.props.style && n.props.style.fontSize === 15).map(textOf);
  assert.deepEqual(numbers, ['99', '76', '42'], `三个窗口都要显示剩余量，实际 ${JSON.stringify(numbers)}`);
});

/** 订阅形态的宿主响应：三个窗口固定，计费区间由用例决定。 */
const subscriptionResponse = (tier, peaks = false) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    provider: { id: 'opencode-go', displayName: 'OpenCode Go', kind: 'usage', reason: null },
    balance: { isAvailable: null, total: null, currency: null },
    usage: {
      plan: null,
      windows: [
        { key: '5h', percent: 12, resetsAt: null },
        { key: '7d', percent: 34, resetsAt: null },
        { key: '30d', percent: 56, resetsAt: null },
      ],
    },
    tier,
    next: { peak: false, at: null, ms: 0 },
    peak: peaks,
    updatedAt: Date.now(),
    errors: [],
  }),
});

test('订阅用量形态：指示灯去掉后仪表盘阵列不再留 16px 空位', async () => {
  /** 渲染一次订阅卡片，取回仪表盘网格节点与指示灯节点。 */
  const renderOf = async (tier) => {
    globalThis.fetch = async () => subscriptionResponse(tier);
    const runtime = makeRuntime();
    const Comp = loadClient(runtime);
    renderCard(Comp, runtime);
    await flush();
    const nodes = nodesOf(renderCard(Comp, runtime).out);
    return {
      grid: nodes.find((n) => n.props && n.props.style && n.props.style.display === 'grid'),
      dots: nodes.filter((n) => isDotNode(n) && n.props.title),
    };
  };

  // 有计费区间（宿主填了 window）时。
  const withWindows = await renderOf({ input: null, cacheRead: null, output: null, known: false, currency: 'CNY', window: 'peak' });
  // 没有计费区间（全天一价）。
  const withoutWindows = await renderOf({ input: 2, known: false });

  assert.ok(withWindows.grid && withoutWindows.grid, '订阅形态应渲染仪表盘网格');
  // 指示灯整块去掉：两种情况下都不该再有那个 8px 的点。
  assert.equal(withWindows.dots.length, 0, '有计费区间时也不应有指示灯');
  assert.equal(withoutWindows.dots.length, 0, '没有计费区间时不应有指示灯');
  // **16px 占位必须一并清掉**：否则仪表盘右边会留下一段没有任何内容的空白。
  assert.equal(withWindows.grid.props.style.paddingRight, undefined, '指示灯占位的 16px 应已清掉');
  assert.equal(withoutWindows.grid.props.style.paddingRight, undefined, '指示灯占位的 16px 应已清掉');
});

test('订阅用量形态：仪表盘弧仍用低饱和度强调色（指示灯已去掉）', async () => {
  const GREEN = 'color-mix(in srgb, var(--dsw-alias-state-success-primary, rgb(34,160,80)) 55%, #808080)';
  const AMBER = 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, rgb(230,120,0)) 55%, #808080)';
  const RED = 'color-mix(in srgb, var(--dsw-alias-state-error-primary, rgb(200,40,40)) 55%, #808080)';

  /** 渲染一次并取出两条仪表盘弧色（已用 84% → 剩余弧变红）。 */
  const colorsOf = async (peak) => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        provider: { id: 'opencode-go', displayName: 'OpenCode Go', kind: 'usage', reason: null },
        balance: { isAvailable: null, total: null, currency: null },
        usage: {
          plan: null,
          windows: [
            { key: '5h', percent: 12, resetsAt: null },
            { key: '30d', percent: 84, resetsAt: null },
          ],
        },
        tier: { input: null, cacheRead: null, output: null, known: false, currency: 'CNY', window: peak ? 'peak' : 'idle' },
        next: { peak: false, at: null, ms: 0 },
        peak,
        updatedAt: Date.now(),
        errors: [],
      }),
    });
    const runtime = makeRuntime();
    const Comp = loadClient(runtime);
    renderCard(Comp, runtime);
    await flush();
    const nodes = nodesOf(renderCard(Comp, runtime).out);
    // 指示灯已经整块去掉，卡片里不该再有那个 8px 的点。
    assert.equal(nodes.filter(isDotNode).length, 0, '不应再有指示灯');
    const arcs = nodes
      .filter((n) => n.type === 'circle' && n.props && n.props.style && typeof n.props.style.stroke === 'string')
      .map((n) => n.props.style.stroke);
    return { arcs };
  };

  // 弧色不受"有没有指示灯"影响：剩余弧绿、已用 84% 那条红。
  const idle = await colorsOf(false);
  assert.deepEqual(idle.arcs, [GREEN, RED], `仪表盘弧应为低饱和度绿/红，实际 ${JSON.stringify(idle.arcs)}`);
  const peak = await colorsOf(true);
  assert.deepEqual(peak.arcs, [GREEN, RED]);
  // 峰谷状态仍然体现在弧色之外的信息里（卡片悬浮说明），但 AMBER 这套颜色
  // 不再挂在指示灯上——那个点已经没了。
  assert.ok(!idle.arcs.includes(AMBER), '弧色不应出现指示灯用的琥珀色');
});

test('不可查的 provider：卡片置空说明原因，且不出现任何数字', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  usage()[0].resolve(unsupportedResponse());
  await flush();
  const text = textOf(renderCard(Comp, runtime).out);
  assert.ok(text.includes('当前插件不支持 Workbuddy'), `应显示原因，实际 ${text}`);
  // 不画读数、单价、圆点：卡片里只有那句原因。
  assert.ok(!/\d+%/.test(text), `不得出现百分比，实际 ${text}`);
  assert.ok(!text.includes('¥') && !text.includes('$'), `不得出现币种符号，实际 ${text}`);
});

test('不可查的 provider：卡片文字不是错误色', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  usage()[0].resolve(unsupportedResponse());
  await flush();
  const out = renderCard(Comp, runtime).out;

  // 找到承载原因文字的那个 div，读它的 color。
  let reasonColor = null;
  const walk = (node) => {
    if (!node || typeof node !== 'object' || reasonColor !== null) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const kids = node.children ?? [];
    const isReason = kids.some((c) => typeof c === 'string' && c.includes('当前插件不支持'));
    if (isReason && node.props && node.props.style) reasonColor = node.props.style.color;
    kids.forEach(walk);
  };
  walk(out);

  // `kind: none` 不是错误：用次要文字色陈述事实，不是错误红。
  const ERR = 'var(--dsw-alias-state-error-primary, rgb(200,40,40))';
  assert.notEqual(reasonColor, ERR, `不可查的提供商不该用错误色，实际 ${reasonColor}`);
  assert.equal(reasonColor, 'var(--dsw-alias-label-secondary, rgba(0,0,0,.55))');
});

/** 伪造设置外壳：`sidebar.settings` 注册项共享的 store，记录 openSection 的分区 id。 */
function settingsShellServices(opened) {
  const shell = { actions: { openSection: (id) => { opened.push(id); } } };
  return {
    // 真实槽位 ledger 把 store 句柄放在 entry.store 上（options 是渲染侧擦除过的空壳）。
    slotsEntries: (name) => (name === 'sidebar.settings'
      ? [{ store: { create: () => shell } }]
      : []),
  };
}

test('不可查的 provider：卡片给出「去映射」，点击直接打开设置页', async () => {
  const opened = [];
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime, 'zh', settingsShellServices(opened));
  renderCard(Comp, runtime);
  usage()[0].resolve(unsupportedResponse());
  await flush();

  const out = renderCard(Comp, runtime).out;
  const button = nodesOf(out).find((n) => n.type === 'button' && (n.children ?? []).join('') === '去映射');
  assert.ok(button, `不支持时应有「去映射」按钮，实际 ${textOf(out)}`);
  button.props.onClick({ stopPropagation() {} });
  assert.deepEqual(opened, ['quota-usage'], '应跳到 DeepSeek 用量设置分区');
});

test('不可查的 provider：没有设置外壳时不显示「去映射」', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  usage()[0].resolve(unsupportedResponse());
  await flush();

  const out = renderCard(Comp, runtime).out;
  assert.ok(!nodesOf(out).some((n) => n.type === 'button'), '没有设置外壳时不应出现按钮');
  assert.ok(textOf(out).includes('当前插件不支持 Workbuddy'), '原因文案照旧显示');
});

test('不可查的 provider：英文界面按钮文案为 Set up mapping', async () => {
  const opened = [];
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime, 'en', settingsShellServices(opened));
  renderCard(Comp, runtime);
  usage()[0].resolve(unsupportedResponse());
  await flush();

  const out = renderCard(Comp, runtime).out;
  const button = nodesOf(out).find((n) => n.type === 'button' && (n.children ?? []).join('') === 'Set up mapping');
  assert.ok(button, `英文按钮文案不对，实际 ${textOf(out)}`);
});

test('折叠态整块不渲染（指示灯已去掉，那个栏里没有内容了）', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime, { wide: false });
  // 回一个正常的余额响应（有内容）：折叠态依然整块不渲染。
  usage()[0].resolve(okResponse(6.66));
  await flush();
  assert.equal(renderCard(Comp, runtime, { wide: false }).out, null, '折叠态不应再渲染那个只有小圆点的栏');
});

// ---- 设置页：DeepSeek 用量（映射 + OAuth 令牌）----------------------------

/** 设置面板「DeepSeek 用量」页（`settings.section`）：映射编辑器 + 其下方的令牌区。 */
function loadSettingsPage(runtime, services = {}) {
  const Slot = loadSlots(runtime, 'zh', services)['settings.section'];
  const render = () => renderTree(runtime, Slot({ t: (k) => k })).out;
  return { Slot, render };
}

const configForm = (value = { providerAliases: [] }) => ({
  getSnapshot: () => ({ status: 'ready', value, revision: 1, writable: true }),
  subscribe: () => () => {},
  mutate: async () => true,
});

test('设置面板：注册「额度与用量」子项，导航标题随语言变化', () => {
  const runtime = makeRuntime();
  const slots = loadSlots(runtime, 'zh');
  assert.equal(typeof slots['settings.section'], 'function', '设置项必须注册');
  const options = slots.sectionOptions();
  assert.equal(options.id, 'quota-usage');
  assert.equal(options.order, 16);
  assert.equal(options.label(), '额度与用量');
  slots.localeState.active = 'ja';
  assert.equal(options.label(), 'Quota & Usage', '非中文语言应显示英文标题');
  assert.equal(slots['plugins.bundle.config'], undefined, '插件详情页的配置区应已移除');
  assert.equal(slots['plugins.row.config'], undefined, '插件行的配置页应已移除');
});

test('设置页：未检测到 OAuth 路由时不渲染令牌区', async () => {
  const runtime = makeRuntime();
  const { render } = loadSettingsPage(runtime, { configForms: { get: () => configForm() } });
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, aliasable: [{ id: 'opencode-go', displayName: 'OpenCode Go' }], unmapped: [], oauth: [] }),
  });
  render();
  await flush();
  const out = render();
  assert.ok(textOf(out).includes('settings.title'), '设置页应有自己的标题');
  assert.equal(nodesOf(out).filter((n) => n.type === 'textarea').length, 0);
  assert.ok(!textOf(out).includes('token.title'));
});

test('价格悬浮说明：整行命中，写清单位与三个档位，分两行', async () => {
  const cases = [
    ['zh', '每百万 token 价格', '输入 2 元 / 输入缓存 0.04 元 / 输出 8 元'],
    ['en', 'Price per 1M tokens', 'Input 2 CNY / Input cache 0.04 CNY / Output 8 CNY'],
  ];
  for (const [lang, line0, line1] of cases) {
    globalThis.fetch = async () => okResponse(5.35);
    const runtime = makeRuntime();
    const Comp = loadClient(runtime, lang);
    renderCard(Comp, runtime);
    await flush();

    // 单价说明只挂一处（整条单价行），图标与数字各自不再挂 title：命中区覆盖整行。
    const titled = nodesOf(renderCard(Comp, runtime).out).filter((n) => n.props && typeof n.props.title === 'string');
    const rows = titled.filter((n) => n.props.title.includes('\n'));
    assert.equal(rows.length, 1, `${lang}: 说明文字应只挂在单价行上`);

    const lines = rows[0].props.title.split('\n');
    assert.equal(lines.length, 2, `${lang}: 说明分两行：单位 + 三个档位`);
    assert.equal(lines[0], line0, `${lang}: 第一行是单位`);
    assert.equal(lines[1], line1, `${lang}: 第二行是三个档位`);

    // 挂了 title 的节点必须包住三个价格数字，否则鼠标落在数字上仍出不来说明。
    const row = textOf(rows[0]);
    for (const amount of ['2', '0.04', '8']) {
      assert.ok(row.includes(amount), `${lang}: 单价行应包含 ${amount}，实际 ${row}`);
    }
  }
});

test('峰谷切换的悬浮说明：指到倒计时/指示灯上，讲清离峰价还是谷价还有多久', async () => {
  /** 渲染一次卡片并取回所有悬浮说明。 */
  const titlesOf = async ({ lang, peak, offsetMs, wide = true }) => {
    globalThis.fetch = async () => stateResponse(peak, Date.now() + offsetMs);
    const runtime = makeRuntime();
    const Comp = loadClient(runtime, lang);
    renderCard(Comp, runtime, { wide });
    await flush();
    return nodesOf(renderCard(Comp, runtime, { wide }).out)
      .filter((n) => n.props && typeof n.props.title === 'string')
      .map((n) => n.props.title);
  };

  const in21 = 21 * 60000 + 30000; // 多给 30 秒，天数/分钟数不会因为用例本身的耗时跳一格

  // 现在空闲 → 下一次切到峰价；现在高峰 → 下一次切到谷价。
  const idle = await titlesOf({ lang: 'zh', peak: false, offsetMs: in21 });
  assert.ok(idle.includes('距离峰价还剩 21 分钟'), `空闲态实际 ${JSON.stringify(idle)}`);
  const peak = await titlesOf({ lang: 'zh', peak: true, offsetMs: in21 });
  assert.ok(peak.includes('距离谷价还剩 21 分钟'), `高峰态实际 ${JSON.stringify(peak)}`);

  // 不足 1 分钟时倒计时显示 switching，说明换成整句，不拼一个「0 分钟」。
  const soon = await titlesOf({ lang: 'zh', peak: false, offsetMs: 30000 });
  assert.ok(soon.includes('即将切换价格'), `即将切换实际 ${JSON.stringify(soon)}`);

  // 英文用英文单位词，天/小时两级同样展开。
  const en = await titlesOf({ lang: 'en', peak: true, offsetMs: (2 * 1440 + 15 * 60) * 60000 + 30000 });
  assert.ok(en.includes('Off-peak pricing in 2 days 15 hours'), `英文实际 ${JSON.stringify(en)}`);

  // 折叠态：指示灯去掉后那一栏**整块不渲染**（原来只有那个小圆点）。
  const folded = await titlesOf({ lang: 'zh', peak: false, offsetMs: in21, wide: false });
  assert.deepEqual(folded, [], `折叠态不应再渲染任何内容，实际 ${JSON.stringify(folded)}`);
});

test('非 DeepSeek provider 的按量计费模型：显示单价行，全天一价时不画指示灯', async () => {
  globalThis.fetch = async () => providerPriceResponse();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  await flush();

  const { out } = renderCard(Comp, runtime);
  const text = textOf(out);
  assert.ok(text.includes('0.6') && text.includes('0.11') && text.includes('2.2'), `应显示单价行，实际 ${text}`);

  // 全天一价：没有倒计时、没有指示灯，只有单价行那一条悬浮说明。
  const titles = nodesOf(out).filter((n) => n.props && typeof n.props.title === 'string').map((n) => n.props.title);
  assert.equal(titles.length, 1, `只应有单价行一条说明，实际 ${JSON.stringify(titles)}`);
  assert.ok(titles[0].includes('美元'), `币种应跟价格表（USD），实际 ${titles[0]}`);
  assert.ok(!/距离|还剩/.test(titles[0]), '全天一价的模型不该出现区间倒计时');
});

test('非 DeepSeek provider 有分时段计费时：峰谷说明照旧（指示灯已去掉）', async () => {
  const in21 = 21 * 60000 + 30000;
  globalThis.fetch = async () => providerPriceResponse({
    provider: { id: 'moonshotai', displayName: 'Moonshot', kind: 'balance', reason: null },
    tier: {
      input: 6.5, cacheRead: 1.3, output: 27, model: 'kimi-k2.7-code', known: true,
      currency: 'CNY', window: 'idle',
    },
    peak: false,
    next: { peak: true, at: Date.now() + in21, ms: in21 },
  });
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  await flush();

  const { out } = renderCard(Comp, runtime);
  const titles = nodesOf(out).filter((n) => n.props && typeof n.props.title === 'string').map((n) => n.props.title);
  assert.ok(titles.includes('距离峰价还剩 21 分钟'), `应显示区间倒计时，实际 ${JSON.stringify(titles)}`);
  // 指示灯已去掉：不再有那个 8px 的状态点。
  assert.equal(nodesOf(out).filter(isDotNode).length, 0, '不应再有指示灯');
  const priceRow = titles.find((t) => t.includes('\n'));
  assert.ok(priceRow && priceRow.includes('元'), `单价行币种应为人民币，实际 ${priceRow}`);
});

test('非 DeepSeek provider 缺切换时刻时不在本地猜（不套用 DeepSeek 峰谷表）', async () => {
  globalThis.fetch = async () => providerPriceResponse({
    provider: { id: 'moonshotai', kind: 'balance' },
    tier: {
      input: 6.5, cacheRead: 1.3, output: 27, model: 'kimi-k2.7-code', known: true,
      currency: 'CNY', window: 'idle',
    },
    peak: false,
    next: { peak: true, at: null, ms: 0 },
  });
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  await flush();

  const out = renderCard(Comp, runtime).out;
  const titles = nodesOf(out).filter((n) => n.props && typeof n.props.title === 'string').map((n) => n.props.title);
  // 缺切换时刻：只说当前是哪个区间，不编一个剩余时间。
  assert.ok(titles.includes('空闲时段'), `缺切换时刻时应只显示当前区间，实际 ${JSON.stringify(titles)}`);
  assert.ok(!titles.some((t) => t.includes('还剩')), `不得用 DeepSeek 的峰谷口径本地补一个倒计时，实际 ${JSON.stringify(titles)}`);
});

test('旧宿主的响应（没有 tier.window）：峰谷说明照旧，币种回退人民币', async () => {
  const in21 = 21 * 60000 + 30000;
  globalThis.fetch = async () => legacyResponse(false, Date.now() + in21);
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  await flush();

  const { out } = renderCard(Comp, runtime);
  const titles = nodesOf(out).filter((n) => n.props && typeof n.props.title === 'string').map((n) => n.props.title);
  assert.ok(titles.includes('距离峰价还剩 21 分钟'), `旧宿主也必须显示倒计时，实际 ${JSON.stringify(titles)}`);
  assert.equal(nodesOf(out).filter(isDotNode).length, 0, '不应再有指示灯');
  const priceRow = titles.find((t) => t.includes('\n'));
  assert.ok(priceRow && priceRow.includes('元'), `缺 currency 时按人民币显示，实际 ${priceRow}`);
});


// ---- 设置页：provider 映射 ------------------------------------------------


// ---- 语言设置：中文→中文，其它语言→英文 ------------------------------------

test('非中文语言（ja）按英文渲染，并向宿主请求 en', async () => {
  const { pending } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime, 'ja');
  renderCard(Comp, runtime);

  const usage = pending.filter((p) => p.url.startsWith('/api/quota-usage?'));
  assert.equal(usage.length, 1, '挂载后应发出一次余额请求');
  assert.ok(usage[0].url.endsWith('?lang=en'), `非中文语言应请求 en，实际 ${usage[0].url}`);

  usage[0].resolve(stateResponse(false, null));
  await flush();

  const labels = nodesOf(renderCard(Comp, runtime).out)
    .map((n) => n.props && n.props['aria-label'])
    .filter(Boolean);
  assert.ok(labels.includes('Account usage, click to refresh'), `应显示英文文案，实际 ${JSON.stringify(labels)}`);
});

test('DSH 语言切换后立即按新语言重取一次', async () => {
  const { pending } = makePendingFetch();
  const runtime = makeRuntime();
  const slots = loadSlots(runtime, 'zh');
  const Comp = slots['sidebar.footer.action'];
  const usage = () => pending.filter((p) => p.url.startsWith('/api/quota-usage?'));
  renderCard(Comp, runtime);

  assert.equal(usage()[0].url, '/api/quota-usage?lang=zh');
  usage()[0].resolve(stateResponse(false, null));
  await flush();

  slots.localeState.active = 'ja';
  renderCard(Comp, runtime);
  assert.equal(usage().length, 2, '语言变化后应立即重取一次，而不是等下一次心跳');
  assert.ok(usage()[1].url.endsWith('?lang=en'), `切换后应请求 en，实际 ${usage()[1].url}`);

  usage()[1].resolve(stateResponse(false, null));
  await flush();
  const labels = nodesOf(renderCard(Comp, runtime).out)
    .map((n) => n.props && n.props['aria-label'])
    .filter(Boolean);
  assert.ok(labels.includes('Account usage, click to refresh'), `切换后应显示英文文案，实际 ${JSON.stringify(labels)}`);
});

// ---- 会话内视图：conversation.view「用量」Tab ------------------------------

test('会话内视图：注册 conversation.view，id/order 稳定，标题随语言变化', () => {
  const runtime = makeRuntime();
  const slots = loadSlots(runtime, 'zh');
  const view = slots['conversation.view'];
  assert.equal(typeof view, 'function', '会话内视图必须注册');
  // 注册项选项：id 决定 Tab 的稳定标识（DSH 按它记住当前激活的视图）
  const options = slots.viewOptions ? slots.viewOptions() : undefined;
  assert.ok(options, '必须能读到 conversation.view 的注册选项');
  assert.equal(options.id, 'usage-stats');
  assert.equal(options.order, 20);
  assert.equal(options.name, 'conversation.view');
  assert.equal(options.label(), '用量');
  slots.localeState.active = 'ja';
  assert.equal(options.label(), 'Usage', '非中文语言应显示英文标题');
});

test('会话内视图：按当前会话取数，请求带 session 参数', async () => {
  const runtime = makeRuntime();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        sessionId: 'session-abc',
        files: 1,
        messages: 12,
        kinds: [],
        unclassified: [],
      }),
    };
  };
  const slots = loadSlots(runtime, 'zh');
  const View = slots['conversation.view'];
  // 注册的是闭包组件（外面一层拿 ctx），里面才渲染 UsageView：用 renderTree 展开两层。
  renderTree(runtime, View({ sessionId: 'session-abc', t: (k) => k }));
  await flush();
  assert.ok(calls.length > 0, '视图挂载后应发起一次统计请求');
  assert.ok(calls[0].includes('session=session-abc'), '请求必须带上当前会话 id，实际：' + calls[0]);
});

test('设置页只剩采集频率：统计已搬到用量页，配置页不再拉 /stats', async () => {
  const runtime = makeRuntime();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, aliasable: [], unmapped: [], oauth: [] }),
    };
  };
  const { render } = loadSettingsPage(runtime, { configForms: { get: () => configForm() } });
  render();
  await flush();
  render();
  const statsCalls = calls.filter((url) => url.includes('/api/quota-usage/stats'));
  assert.deepEqual(statsCalls, [], '配置页不再渲染统计（改到用量页）：' + statsCalls.join(', '));
  // 采集频率那块的策略快照照旧要读——配置页现在只剩它。
  assert.ok(calls.some((url) => url.includes('/api/quota-usage/snapshot')), '配置页应读采集策略快照');
});
// ---- 积分渠道的卡片：不再显示「本插件不支持 X」------------------------------
//
// 这是用户实际报的 bug：侧边栏对 trae 显示「This plugin does not support trae」。
// 根因是卡片只读 /api/quota-usage（按 API Key 能力表判断），而 trae 这类免费
// 渠道走积分、不在那张表里；积分其实已经由采集器采到 /snapshot 里，卡片没去读。

test('积分渠道：kind=none 但快照里有该渠道积分时，卡片显示积分而不是「不支持」', async () => {
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.startsWith('/api/quota-usage/snapshot')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          snapshots: {
            credits: {
              value: {
                available: true,
                channels: [
                  { channel: 'trae', state: 'ok', remaining: 5551.0312, total: 7400, percent: 75, unit: 'credits' },
                ],
              },
              updatedAt: Date.now(),
              stale: false,
            },
          },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        // 宿主对 trae 的真实回答：能力表里没有它
        provider: { id: 'trae', displayName: 'trae', kind: 'none', reason: 'unsupported', via: 'none' },
        balance: { isAvailable: null, total: null, currency: null },
        usage: null,
        tier: { input: null, cacheRead: null, cacheWrite: null, output: null, known: false, currency: 'CNY', window: null },
        next: { peak: false, at: null, ms: 0 },
        peak: false,
        errors: ['This plugin does not support trae'],
      }),
    };
  };
  renderCard(Comp, runtime);
  await flush();
  const text = textOf(renderCard(Comp, runtime).out);
  assert.ok(!text.includes('does not support'), `不得再显示「不支持」，实际：${text}`);
  assert.ok(text.includes('5551') || text.includes('5.6K'), `应显示剩余积分，实际：${text}`);
  assert.ok(text.includes('7400') || text.includes('7.4K'), `应显示总额，实际：${text}`);
});

test('积分渠道：快照里没有该渠道时，仍然显示宿主的真实原因', async () => {
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.startsWith('/api/quota-usage/snapshot')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, snapshots: { credits: { value: { channels: [] } } } }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        provider: { id: 'some-unknown-gateway', displayName: 'some-unknown-gateway', kind: 'none', reason: 'unsupported' },
        balance: { isAvailable: null, total: null, currency: null },
        usage: null,
        tier: { known: false },
        next: { peak: false, at: null, ms: 0 },
        peak: false,
        errors: ['This plugin does not support some-unknown-gateway'],
      }),
    };
  };
  renderCard(Comp, runtime);
  await flush();
  const text = textOf(renderCard(Comp, runtime).out);
  // 真的没有数据时不能说谎：这条渠道确实查不到，如实显示。
  assert.ok(text.includes('does not support') || text.includes('some-unknown-gateway'), `应如实说明原因，实际：${text}`);
});

test('积分渠道：其它错误（未配置）不被积分读数掩盖', async () => {
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.startsWith('/api/quota-usage/snapshot')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          snapshots: { credits: { value: { channels: [{ channel: 'trae', state: 'ok', remaining: 10, total: 20, percent: 50, unit: 'credits' }] } } },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        provider: { id: 'trae', displayName: 'trae', kind: 'none', reason: 'unsupported' },
        balance: { isAvailable: null, total: null, currency: null },
        usage: null,
        tier: { known: false },
        next: { peak: false, at: null, ms: 0 },
        peak: false,
        // 与「不支持」无关的另一类错误必须保留
        errors: ['Balance API timed out'],
      }),
    };
  };
  renderCard(Comp, runtime);
  await flush();
  const text = textOf(renderCard(Comp, runtime).out);
  assert.ok(text.includes('Balance API timed out'), `无关错误必须保留，实际：${text}`);
});

// ---- 只有 remaining、没有 total/percent 的渠道 ------------------------------
//
// 用户报的 bug：「MiniMax 查不到额度」。
// 根因不在采集侧——channel-credits.js 有意让 total/percent 留空（没有分母就
// 不出百分比，见那里的规则 (4c)），数字是采到了的。是渲染层按 total 分支，
// 于是 total 为 null 时去画 fmtPct(null)，把真实数字整条丢掉，界面上只剩空白。
//
// 采集侧的设计仍然不动（它不该替界面猜）；**展示口径**由渲染层的 channelPercent
// 兜底：有分子缺分母 → 按 100% 显示，积分列照常显示数字。

/** 只有 remaining 的渠道快照（minimax 在真机上的实际形状）。 */
function channelWithoutTotal(channel, remaining, extra = {}) {
  return { channel, state: 'ok', packageCount: 0, packages: [], remaining, ...extra };
}

/**
 * 让卡片停在展开态并渲染。
 *
 * 展开态默认就是**开**（`creditCardOpen = true`：采集器已经采到三类数据，再让用户
 * 多点一次才看得见是多余的）。所以这里不再"点一下就展开"——那样在新默认下反而会
 * 把它合起来。函数保留：它同时把头部断言留在原地，并保证渲染两次以跑完取数。
 */
async function renderExpanded(Comp, runtime, snapshotBody) {
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.startsWith('/api/quota-usage/snapshot')) {
      return { ok: true, status: 200, json: async () => snapshotBody };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        provider: { id: 'minimax', displayName: 'MiniMax', kind: 'none', reason: 'unsupported' },
        balance: { isAvailable: null, total: null, currency: null },
        usage: null,
        tier: { known: false },
        next: { peak: false, at: null, ms: 0 },
        peak: false,
        errors: [],
      }),
    };
  };
  renderCard(Comp, runtime);
  await flush();
  // 首屏即展开：头部那个 role="button" 仍然存在（可以点回合起来），但不需要点。
  const header = nodesOf(renderCard(Comp, runtime).out).find((n) => n.props && n.props.role === 'button');
  assert.ok(header, '卡片头部应可作为展开/折叠开关');
  return renderCard(Comp, runtime).out;
}

/**
 * 只取「积分」分区那一段文本。
 *
 * 整卡文本里还混着订阅/充值分区与自己的百分比（真机上 buddy/raccoon 恰好是 100%），
 * 在全文上断言百分比会被别的分区误伤。用户的口径也只针对积分列。
 */
function creditsSectionText(out) {
  const text = textOf(out);
  const at = text.lastIndexOf('积分');
  return at >= 0 ? text.slice(at) : text;
}

const creditsSnapshot = (channels, currentChannel) => ({
  ok: true,
  snapshots: {
    credits: {
      value: {
        available: true,
        currentChannel,
        channels,
      },
      updatedAt: Date.now(),
      stale: false,
    },
  },
});

test('无 total 的渠道：展开态显示剩余数字，并按 100% 显示', async () => {
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  const out = await renderExpanded(Comp, runtime, creditsSnapshot([channelWithoutTotal('minimax', 221.53)]));
  const text = textOf(out);
  // 采集器采到的 221.53 必须出现在界面上（fmtCreditAmount 取整 → 221）。
  assert.ok(text.includes('221'), `展开态应显示剩余数字 221，实际：${text}`);
  // 缺分母时按用户口径补成 100%。
  assert.ok(creditsSectionText(out).includes('100%'), `缺分母时积分列应按 100% 显示，实际：${text}`);
});

test('无 total 的渠道：remaining 为 0 时也显示数字 0（真机 minimax 就是这个形状）', async () => {
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  const out = await renderExpanded(Comp, runtime, creditsSnapshot([channelWithoutTotal('minimax', 0)]));
  const section = creditsSectionText(out);
  // 0 是真实读数，不能被当成"没数据"吞掉。
  // 断言写成「渠道名紧跟 0」，因为值列会把数字与单位连排成 `0积分` —— 用 \b0\b
  // 会被这个相邻关系卡住（两侧都是数字，没有词边界），那是断言的毛病，不是渲染的。
  assert.ok(/minimax0/.test(section), `应显示剩余 0，实际：${section}`);
  // 补 100% 只在「分子 > 0 且缺分母」时成立。这里是分子 = 0，属于"余额用光了"，
  // 补上去会显示成「0 分钱但满额」，所以**不补**。
  assert.ok(!section.includes('100%'), `remaining 为 0 时不得补 100%，实际：${section}`);
});

test('无 total/percent 的渠道：折叠摘要显示数字，而不是「未显示」', async () => {
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  // currentChannel 指向该渠道，折叠摘要才会报它。
  const out = await renderExpanded(Comp, runtime, creditsSnapshot([channelWithoutTotal('minimax', 221.53)], 'minimax'));
  const text = textOf(out);
  assert.ok(text.includes('221'), `折叠摘要应显示数字 221，实际：${text}`);
  // 数据明明在，说「未显示」就是误报——这是本次修复的第二个点。
  assert.ok(!text.includes('未显示'), `有数字时不得说「未显示」，实际：${text}`);
  assert.ok(!text.includes('not shown'), `有数字时不得说「未显示」（en），实际：${text}`);
});

test('remaining 为 0 且无 total：显示 0，但不得补成 100%', async () => {
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  // 用户口径：只有「分子 > 0 且缺分母」才补 100%。
  // remaining === 0 是"余额用光了"，补 100% 会画成"满额"——0 分钱配 100%
  // 是整张卡最刺眼的一种错。真机上 minimax 就是这个形状。
  const out = await renderExpanded(Comp, runtime, creditsSnapshot([channelWithoutTotal('minimax', 0)], 'minimax'));
  const text = textOf(out);
  assert.ok(!text.includes('100%'), `remaining 为 0 时不得补 100%，实际：${text}`);
  // 数字本身照旧要显示：0 是真实读数，不能因为没百分比就藏起来。
  assert.ok(text.includes('0'), `remaining 为 0 时应显示 0，实际：${text}`);
});

test('remaining 与 total 都缺失：显示「—」并走「未显示」分支', async () => {
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  // 这才是真的没有数据：连分子都没有，绝不能补成 100%。
  const out = await renderExpanded(Comp, runtime, creditsSnapshot([{ channel: 'minimax', state: 'ok' }], 'minimax'));
  const text = textOf(out);
  assert.ok(text.includes('—'), `无任何数字时应显示破折号，实际：${text}`);
  assert.ok(text.includes('未显示'), `无任何数字时应说「未显示」，实际：${text}`);
  assert.ok(!text.includes('100%'), `没有分子时不得补 100%，实际：${text}`);
});

test('上游已有 percent 时以它为准，不被 100% 兜底覆盖', async () => {
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  const out = await renderExpanded(Comp, runtime, creditsSnapshot([
    { channel: 'trae', state: 'ok', remaining: 5551.0312, total: 7400, percent: 75, unit: 'credits' },
  ], 'trae'));
  const text = textOf(out);
  assert.ok(text.includes('5551'), `应显示剩余，实际：${text}`);
  assert.ok(text.includes('7400'), `应显示总额，实际：${text}`);
  assert.ok(text.includes('75%'), `应显示上游百分比 75%，实际：${text}`);
  assert.ok(!text.includes('100%'), `有真实百分比时不得兜底成 100%，实际：${text}`);
  assert.ok(!text.includes('未显示'), `有完整数据时不得说「未显示」，实际：${text}`);
});

test('有 total 有 percent：行为不变（回归保护）', async () => {
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  const out = await renderExpanded(Comp, runtime, creditsSnapshot([
    { channel: 'buddy', state: 'ok', remaining: 3179.65, total: 3721, percent: 85.5, unit: 'credits' },
  ], 'buddy'));
  const text = textOf(out);
  assert.ok(text.includes('3179'), `应显示剩余，实际：${text}`);
  assert.ok(text.includes('3721'), `应显示总额，实际：${text}`);
  assert.ok(text.includes('85.5%'), `应显示百分比，实际：${text}`);
});

test('只有 percent 没有 remaining/total 的渠道：显示百分比，不补数字', async () => {
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  // 个别渠道只回一个比例。百分比由 channelPercent 原样带出，数字位保持破折号。
  const out = await renderExpanded(Comp, runtime, creditsSnapshot([{ channel: 'minimax', state: 'ok', percent: 68.5 }], 'minimax'));
  const text = textOf(out);
  assert.ok(text.includes('68.5%'), `应显示百分比，实际：${text}`);
  assert.ok(!text.includes('100%'), `上游给了 percent 就不该兜底成 100%，实际：${text}`);
});

// ---- 用量页：三勾选 + 树形 + 「配置」按钮 -----------------------------------

/** 用量页在会话里的注册组件（闭包层已注入 ctx）。 */
function usageViewOf(runtime, sessionId = 'session-abc', services = {}) {
  const slots = loadSlots(runtime, 'zh', services);
  const View = slots['conversation.view'];
  return View({ sessionId, t: (k) => k });
}

/** 三个勾选框（顺序固定：整机 / 工作区 / 会话）。 */
function checkboxesOf(out) {
  return nodesOf(out).filter((n) => n.type === 'input' && n.props && n.props.type === 'checkbox');
}

const statsBody = (extra = {}) => ({
  ok: true,
  messages: 5,
  files: 1,
  kinds: [],
  unclassified: [],
  ...extra,
});

test('用量页：默认只勾「会话」，沿用「这次对话花了多少」的口径', async () => {
  const runtime = makeRuntime();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => statsBody() };
  };
  const View = usageViewOf(runtime);
  const out = renderTree(runtime, View).out;
  await flush();
  assert.ok(calls.length > 0, '挂载后应取数');
  assert.ok(calls[0].includes('session=session-abc'), '默认口径是当前会话，实际：' + calls[0]);
  const boxes = checkboxesOf(out);
  assert.equal(boxes.length, 3, '必须正好三个勾选框（整机 / 工作区 / 会话）');
  assert.deepEqual(boxes.map((b) => !!b.props.checked), [false, false, true], '默认只勾会话');
});

test('用量页：勾上「整机」后改取整机口径，且与「会话」共存时两级都取', async () => {
  const runtime = makeRuntime();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => statsBody({ workspaces: [], scope: 'workspace' }) };
  };
  const View = usageViewOf(runtime);
  renderTree(runtime, View);
  await flush();
  // 勾「整机」：仍勾着会话 → 需要整机口径 + workspace 口径（列所有会话）。
  const machineBox = checkboxesOf(renderTree(runtime, View).out)[0];
  machineBox.props.onChange();
  calls.length = 0;
  renderTree(runtime, View);
  await flush();
  assert.ok(calls.includes('/api/quota-usage/stats'), '整机口径要请求缺省 stats，实际：' + calls.join(', '));
  assert.ok(
    calls.includes('/api/quota-usage/stats?scope=workspace'),
    '整机+会话要拉 workspace 口径（会话行只在那里），实际：' + calls.join(', '),
  );
  assert.ok(
    !calls.some((url) => url.includes('session=')),
    '同时勾了整机时不该再退化成单会话查询：' + calls.join(', '),
  );
});

test('用量页：三个都不勾时不渲染树、不发请求，只提示「请至少勾选一项」', async () => {
  const runtime = makeRuntime();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => statsBody() };
  };
  const View = usageViewOf(runtime);
  renderTree(runtime, View);
  await flush();
  // 取消默认勾上的「会话」→ 空选。
  const sessionBox = checkboxesOf(renderTree(runtime, View).out)[2];
  sessionBox.props.onChange();
  calls.length = 0;
  const out = renderTree(runtime, View).out;
  await flush();
  assert.deepEqual(calls.filter((url) => url.includes('/api/quota-usage/stats')), [], '空选不该再发统计请求');
  assert.ok(textOf(out).includes('stats.tree.pickEmpty'), '空选要给出提示，实际：' + textOf(out));
  assert.ok(!textOf(out).includes('stats.tree.machine'), '空选不得静默显示整机树的节点');
  // 三个框都在，且都没勾。
  assert.deepEqual(checkboxesOf(out).map((b) => !!b.props.checked), [false, false, false]);
});

test('用量页：有设置外壳时给出「配置」按钮，点击跳到 DeepSeek 用量分区', async () => {
  const opened = [];
  const runtime = makeRuntime();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => statsBody() });
  const View = usageViewOf(runtime, 'session-abc', settingsShellServices(opened));
  renderTree(runtime, View);
  await flush();
  const out = renderTree(runtime, View).out;
  const button = nodesOf(out).find((n) => n.type === 'button' && (n.children ?? []).join('') === 'view.config');
  assert.ok(button, '有设置外壳时应渲染「配置」按钮，实际：' + textOf(out));
  button.props.onClick();
  assert.deepEqual(opened, ['quota-usage'], '应打开本插件的设置分区');
});

test('用量页：没有设置外壳时不画一个点了没反应的「配置」按钮', async () => {
  const runtime = makeRuntime();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => statsBody() });
  const View = usageViewOf(runtime);
  renderTree(runtime, View);
  await flush();
  const out = renderTree(runtime, View).out;
  assert.ok(
    !nodesOf(out).some((n) => n.type === 'button' && (n.children ?? []).join('') === 'view.config'),
    '外壳不存在时不该出现「配置」按钮',
  );
});

test('用量页：workspace 口径按 {workspaces:[...]} 解包，全选时出现三级行', async () => {
  const runtime = makeRuntime();
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('scope=workspace')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          scope: 'workspace',
          workspaces: [
            {
              id: 'w1', title: 'alpha', sessionCount: 1, messages: 3,
              totals: { totalTokens: 10 }, cost: { currency: 'CNY', priced: true, amounts: { total: 1 } },
              sessions: [{ id: 's9', archived: false, ok: true, messages: 2, totals: { totalTokens: 5 } }],
            },
          ],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => statsBody() };
  };
  const View = usageViewOf(runtime);
  renderTree(runtime, View);
  await flush();
  let out = renderTree(runtime, View).out;
  // 勾「整机」与「工作区」→ 全选：整机 → 工作区 → 会话。
  for (let round = 0; round < 2; round += 1) {
    const box = checkboxesOf(out)[round];
    if (box && box.props.checked !== true) box.props.onChange();
    await flush();
    out = renderTree(runtime, View).out;
  }
  const text = textOf(out);
  assert.ok(text.includes('alpha'), '工作区行必须出现（响应体是 {workspaces:[...]}，不是裸数组）：' + text);
  assert.ok(text.includes('s9'), '工作区下的会话行必须出现：' + text);
  assert.ok(text.includes('stats.tree.machine'), '整机根行在：' + text);
});

// ---- 三类采集数据与「当前模型类型」无关 -------------------------------------
//
// 用户原话：「那你这个不是多余判断吗，我面板上什么都有，你留着只查官方余额的判断是
// 干嘛？项目代码彻查哪里还有这种画蛇添足的操作。」
//
// 根因：卡片曾经写成 `if (kind0 === 'none' && hasCardData)` —— `kind0` 是**当前
// 会话所用 provider 的类型**。于是同一台机器、同一份采集数据，只因为当前对话用的是
// 官方余额模型（kind='balance'）而不是免费渠道（kind='none'），界面就从"三大类"
// 退化成"一张余额卡"。
//
// 下面的判据钉住两件事：
//   1. balance 型模型下三类数据也全部显示；
//   2. balance 型与 none 型的**渲染结构完全一致**（除了数字本身）。

const THREE_KINDS_SNAPSHOT = {
  ok: true,
  snapshots: {
    credits: {
      value: {
        available: true,
        currentChannel: 'trae',
        channels: [
          { channel: 'trae', state: 'ok', remaining: 5069.03, total: 7400, percent: 68.5, unit: 'credits' },
        ],
      },
      updatedAt: Date.now(),
      stale: false,
    },
    prepaid: {
      value: {
        providers: [
          {
            provider: 'openrouter', displayName: 'OpenRouter', kind: 'balance',
            balance: { isAvailable: true, total: 12.5, currency: 'USD', used: 7.5 },
            ok: true, code: null,
          },
        ],
      },
      updatedAt: Date.now(),
      stale: false,
    },
    subscription: {
      value: {
        subscriptions: [
          {
            ok: true, mode: 'plugin', provider: 'openai-codex', displayName: 'OpenAI Codex',
            plan: 'plus', accounts: [{ id: 'a1', alias: 'alice@example.com', plan: 'plus', active: true, windows: [{ key: '5h', percent: 13, resetsAt: null }] }],
          },
        ],
      },
      updatedAt: Date.now(),
      stale: false,
    },
  },
};

/** 造一个宿主响应：provider.kind 由用例指定（balance / none）。 */
function providerKindResponse(kind) {
  if (kind === 'balance') {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        provider: { id: 'deepseek-official', displayName: 'DeepSeek', kind: 'balance', reason: null },
        balance: { isAvailable: true, total: 6970.17, currency: 'CNY' },
        usage: null,
        tier: { input: 2, cacheRead: 0.04, output: 8, known: true, currency: 'CNY', window: 'idle' },
        next: { peak: false, at: null, ms: 0 },
        peak: false,
        updatedAt: Date.now(),
        errors: [],
      }),
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      provider: { id: 'buddy', displayName: 'buddy', kind: 'none', reason: 'unsupported', via: 'none' },
      balance: { isAvailable: null, total: null, currency: null },
      usage: null,
      tier: { input: null, cacheRead: null, cacheWrite: null, output: null, known: false, currency: 'CNY', window: null },
      next: { peak: false, at: null, ms: 0 },
      peak: false,
      updatedAt: Date.now(),
      errors: [],
    }),
  };
}

/** 用指定 kind 渲染一次卡片（三类数据都有）。 */
async function renderWithKind(kind) {
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.startsWith('/api/quota-usage/snapshot')) {
      return { ok: true, status: 200, json: async () => THREE_KINDS_SNAPSHOT };
    }
    return providerKindResponse(kind);
  };
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  await flush();
  return renderCard(Comp, runtime).out;
}

test('当前模型是 balance 型时，三类采集数据也必须全部显示（不再只有余额卡）', async () => {
  const text = textOf(await renderWithKind('balance'));
  // 订阅 / 充值 / 积分 三个分区标题都要在。
  assert.ok(text.includes('订阅'), `balance 型也应显示「订阅」分区，实际：${text}`);
  assert.ok(text.includes('充值'), `balance 型也应显示「充值」分区，实际：${text}`);
  assert.ok(text.includes('积分'), `balance 型也应显示「积分」分区，实际：${text}`);
  // 三类各有一个可辨识的数字。
  assert.ok(/Codex/i.test(text), `应出现订阅来源，实际：${text}`);
  assert.ok(/OpenRouter/i.test(text), `应出现充值来源，实际：${text}`);
  assert.ok(text.includes('7400') || text.includes('7.4K'), `应出现积分总量，实际：${text}`);
});

test('balance 型与 none 型的渲染结构一致（用户抱怨的根源就在这里）', async () => {
  const balanceText = textOf(await renderWithKind('balance'));
  const noneText = textOf(await renderWithKind('none'));
  // 两个分区标题集合必须相同：同一份采集数据，界面不该因为当前模型不同而换一套。
  for (const title of ['订阅', '充值', '积分']) {
    assert.equal(balanceText.includes(title), noneText.includes(title),
      `「${title}」分区在两种 kind 下必须一致：balance=${balanceText.includes(title)} none=${noneText.includes(title)}`);
  }
  // 分区顺序也必须一致。
  const order = (t) => ['订阅', '充值', '积分'].map((s) => t.indexOf(s));
  const balanceOrder = order(balanceText).map((i) => (i >= 0 ? 1 : 0));
  const noneOrder = order(noneText).map((i) => (i >= 0 ? 1 : 0));
  assert.deepEqual(balanceOrder, noneOrder, `两种 kind 的分区出现情况必须一致：${balanceText} ||| ${noneText}`);
  assert.deepEqual(balanceOrder, [1, 1, 1], '三类分区都应出现');
});

test('只有余额数据时仍然显示三大类卡片（有积分渠道那一类），且不出现余额型的大数字', async () => {
  // 这台机器只采到了积分一类：订阅与充值都空。
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.startsWith('/api/quota-usage/snapshot')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          snapshots: {
            credits: {
              value: { available: true, channels: [{ channel: 'trae', state: 'ok', remaining: 5069.03, total: 7400, percent: 68.5, unit: 'credits' }] },
              updatedAt: Date.now(),
              stale: false,
            },
          },
        }),
      };
    }
    return providerKindResponse('balance');
  };
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  await flush();
  const text = textOf(renderCard(Comp, runtime).out);
  // 有数据的分区照常渲染；没有的分区（订阅 / 充值）不占位。
  assert.ok(text.includes('积分'), `有积分数据时应显示积分分区，实际：${text}`);
  assert.ok(!text.includes('订阅'), `没有订阅数据时不应出现订阅标题，实际：${text}`);
  assert.ok(!text.includes('充值'), `没有充值数据时不应出现充值标题，实际：${text}`);
  assert.ok(text.includes('5069') || text.includes('7400'), `应显示积分读数，实际：${text}`);
});

test('三类都没有数据时：卡片是余额形态（不空白）', async () => {
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.startsWith('/api/quota-usage/snapshot')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, snapshots: {} }) };
    }
    return providerKindResponse('balance');
  };
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  await flush();
  const text = textOf(renderCard(Comp, runtime).out);
  // 余额卡兜底：金额照常显示，不是空白，也不出现三个空分区。
  assert.ok(text.includes('6970.17'), `三类都没数据时应显示余额，实际：${text}`);
  assert.ok(!text.includes('订阅'), `没有数据时不应出现订阅分区，实际：${text}`);
  assert.ok(!text.includes('充值'), `没有数据时不应出现充值分区，实际：${text}`);
});

// ---- 切换会话：请求必须带上当前会话 id，并在切换后重新取数 ---------------
//
// 用户报的 bug：「切换会话后如果另一个会话的大模型不同，面板还是没有自动把当前大模型
// 的标记改到刚切过去的会话的大模型那里」。
//
// 客户端要做两件事，缺一不可：
//   1. 请求里带 `?session=`（否则服务端只能回落全局默认，永远返回旧模型）；
//   2. 会话 id 变化时重新取数（否则界面停在上一个会话的读数上）。

test('当前会话 id 会被拼进 /api/quota-usage 的 session 参数', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.startsWith('/api/quota-usage/snapshot')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, snapshots: {} }) };
    }
    return providerKindResponse('balance');
  };
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  const box = { current: 'session-a' };
  const useSessions = makeSessionsHook(box);
  renderCard(Comp, runtime, { wide: true, useSessions });
  await flush();
  const usage = calls.filter((u) => u.startsWith('/api/quota-usage?'));
  assert.equal(usage.length, 1, `挂载后应发一次余额请求，实际 ${usage.join(', ')}`);
  assert.ok(usage[0].includes('session=session-a'), `请求必须带上当前会话 id，实际：${usage[0]}`);
});

test('切换会话后重新取数，且请求带的是新会话的 id', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.startsWith('/api/quota-usage/snapshot')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, snapshots: {} }) };
    }
    return providerKindResponse('balance');
  };
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  const box = { current: 'session-a' };
  const useSessions = makeSessionsHook(box);
  renderCard(Comp, runtime, { wide: true, useSessions });
  await flush();
  const before = calls.filter((u) => u.startsWith('/api/quota-usage?')).length;

  // 用户切到另一个会话（mainView 转移）。
  box.current = 'session-b';
  renderCard(Comp, runtime, { wide: true, useSessions });
  await flush();

  const usage = calls.filter((u) => u.startsWith('/api/quota-usage?'));
  assert.ok(usage.length > before, `切会话后必须重新取数，实际 ${usage.length} 次（切前 ${before}）`);
  const last = usage[usage.length - 1];
  assert.ok(last.includes('session=session-b'), `重取时必须带新会话 id，实际：${last}`);
});

test('宿主没提供 useSessions 时不带 session 参数（旧宿主兼容）', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.startsWith('/api/quota-usage/snapshot')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, snapshots: {} }) };
    }
    return providerKindResponse('balance');
  };
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime); // 不给 useSessions
  await flush();
  const usage = calls.filter((u) => u.startsWith('/api/quota-usage?'));
  assert.equal(usage.length, 1);
  assert.ok(!usage[0].includes('session='), `没有会话 id 时不应带空参数，实际：${usage[0]}`);
  assert.ok(usage[0].includes('lang='), `语言参数照旧要带，实际：${usage[0]}`);
});
