// 用量统计页的两处交互契约：**勾选记忆** 与 **刷新 / 重新统计分开**。
//
// 这两个需求都来自用户，且都属于"容易被实现成看起来对、实际不对"的那一类：
//
//   1. 勾选记忆：真正的判据不是"能存能读"，而是**回退路径**——非法 JSON、字段缺失、
//      空选、存储抛错、sessionId 为空。任何一条没兜住，用户就会打开统计页看到空屏
//      或者直接崩掉。
//   2. 刷新 vs 重新统计：真正的判据不是"两个按钮都在"，而是**它们各自发什么请求**。
//      两个按钮都调 load() 时，界面上看不出区别，但"重新统计"永远拿不到新数字。
//
// ## 驱动方式
//
// 全部走真实点击（`onClick`）与真实输入（`onChange`），不用组件内部 state 钩子。
// localStorage 由测试侧注入到 `globalThis`——这是浏览器 API 的替身，不是产品代码的
// 后门；注入不可用时**报错而不是跳过**（否则回退路径的判据会变成永远成立的假绿）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const handle = realSetInterval(fn, ms, ...rest);
  handle.unref?.();
  return handle;
};

const PREFS_KEY = 'dsh-quota-usage:stats-checks';
const STATS_PATH = '/api/quota-usage/stats';

// ---- 迷你 React ----
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

/**
 * 一个**真实的**译名表（只覆盖本文件用到的键）。
 *
 * 为什么不能用 `t: (k) => k`：组件的 aria-label 是 `t("stats.recalc")`，
 * 恒等函数会让 aria 变成字面量 `"stats.recalc"`。那样断言"aria 含「重新统计」"
 * 永远不成立，而"两个 aria 不同名"又会因为 key 名不同而假通过——两边都失真。
 */
const ZH = {
  'stats.recalc': '重新统计',
  'stats.recalcBusy': '正在重新统计…',
  'stats.recalcFailed': '重新统计失败，请稍后重试。',
  'stats.refresh': '刷新',
  'stats.pick.machine': '整机',
  'stats.pick.workspace': '工作区',
  'stats.pick.session': '本会话',
};
const tz = (key) => ZH[key] ?? key;

// ---- localStorage 替身 ----

/**
 * 一个可控的 localStorage。
 *
 * `failGet` / `failSet` / `readOnly` 用来验"存储出问题时静默回落、且不影响功能"。
 * 真实浏览器的隐私模式与配额满都会发生这两件事。
 */
function makeStorage({ initial = {}, failGet = false, failSet = false, readOnly = false } = {}) {
  const data = { ...initial };
  return {
    data,
    getItem(key) {
      if (failGet) throw new Error('SecurityError: localStorage is not available');
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      if (readOnly) throw new Error('QuotaExceededError');
      if (failSet) throw new Error('QuotaExceededError');
      data[key] = String(value);
    },
    removeItem(key) { delete data[key]; },
  };
}

/**
 * 装上 / 卸载 localStorage 替身，**整个测试体都在作用域内**。
 *
 * 为什么不是"mount 时装上、之后卸掉"：勾选切换与按钮点击都要读/写存储，
 * 卸载后再交互会让 `typeof localStorage === "undefined"` 成立，产品代码走的是
 * "无存储降级"分支——那测到的就不是"持久化"了（我第一版就踩了这个坑：
 * 断言"应写入存储，实际 null"，其实是测试自己把存储摘了）。
 */
async function withStorage(storage, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const prev = globalThis.localStorage;
  if (storage === null) delete globalThis.localStorage;
  else globalThis.localStorage = storage;
  try {
    return await fn();
  } finally {
    if (had) globalThis.localStorage = prev; else delete globalThis.localStorage;
  }
}

// ---- 载入组件 ----

/** 载入 client.js，返回按槽位名索引的注册组件表。 */
function loadSlots(runtime, lang = 'zh') {
  const win = { __ModuleLoader__: { load: (def) => { win.__def = def; } } };
  new Function('window', 'require', source)(win, (id) => (id === 'react' ? runtime.react : {}));
  const mod = win.__def.factory((id) => (id === 'react' ? runtime.react : {}));
  const registered = {};
  const ctx = {
    get: () => undefined,
    locale: {
      subscribe: () => () => {},
      getSnapshot: () => ({ active: lang, locales: [], revision: 0 }),
      bind: () => (k) => k,
      register: () => {},
    },
    remote: { $on: () => () => {} },
    effect: (fn) => { fn(); return () => {}; },
    slots: {
      inject: (_n, fn) => fn(),
      register: (meta, comp) => { registered[meta.name] = comp; },
      entries: () => [],
    },
  };
  mod.apply(ctx);
  return registered;
}

/** 渲染任意组件（递归展开函数组件）。 */
function renderComponent(runtime, Comp, props) {
  return runtime.render(() => {
    const expand = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return node;
      if (Array.isArray(node)) return node.map(expand);
      if (typeof node.type === 'function') return expand(node.type(node.props));
      return node.children ? { ...node, children: node.children.map(expand) } : node;
    };
    return expand({ type: Comp, props, children: [] });
  }).out;
}

/** 三个勾选框（顺序：整机 / 工作区 / 会话，与实现一致）。 */
function checkboxes(out) {
  return nodesOf(out).filter((n) => n.type === 'input' && n.props && n.props.type === 'checkbox');
}

const statsBody = (extra = {}) => ({
  ok: true,
  state: 'ready',
  computedAt: Date.now(),
  stale: false,
  intervalMs: 600000,
  atMs: Date.now(),
  messages: 3,
  files: 1,
  kinds: [],
  unclassified: [],
  ...extra,
});

/**
 * 造一个统计页环境：fetch 记录所有请求、可分别决定 GET/POST 的行为。
 *
 * `postPlan`：`ok` / `fail` / `pending`（挂起不返回，用来验 busy 期间禁用与不重复发请求）。
 */
function makeStatsEnv({ postPlan = 'ok' } = {}) {
  const calls = [];
  const pendingPosts = [];
  const env = {
    calls,
    pendingPosts,
    getCalls: () => calls.filter((c) => c.method === 'GET'),
    postCalls: () => calls.filter((c) => c.method === 'POST'),
    /** 立刻放行挂起的 POST（busy 用例用）。 */
    releasePosts(ok = true) {
      while (pendingPosts.length > 0) {
        const p = pendingPosts.shift();
        if (ok) p.resolve({ ok: true, status: 200, json: async () => statsBody() });
        else p.resolve({ ok: false, status: 502, json: async () => ({ ok: false, message: 'boom' }) });
      }
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    const method = (init && init.method) || 'GET';
    calls.push({ url: target, method });
    if (!target.startsWith(STATS_PATH)) {
      // 统计页只该请求 stats；别的端点给个空成功，避免噪音。
      return { ok: true, status: 200, json: async () => ({ ok: true, ranges: [] }) };
    }
    if (method === 'POST') {
      if (postPlan === 'pending') {
        return new Promise((resolve) => { pendingPosts.push({ resolve }); });
      }
      if (postPlan === 'fail') {
        return { ok: false, status: 502, json: async () => ({ ok: false, message: 'boom' }) };
      }
      return { ok: true, status: 200, json: async () => statsBody() };
    }
    return { ok: true, status: 200, json: async () => statsBody() };
  };
  return env;
}

/** 渲染统计页并让它把首次请求跑完。 */
async function mountStats(runtime, Comp, props) {
  renderComponent(runtime, Comp, props);
  await flush();
  await flush();
  return renderComponent(runtime, Comp, props);
}

/** 按 aria-label 找按钮。 */
function buttonsByAria(out, re) {
  return nodesOf(out).filter((n) => n.props
    && typeof n.props.onClick === 'function'
    && typeof n.props['aria-label'] === 'string'
    && re.test(n.props['aria-label']));
}

/**
 * 点一个按钮，**遵守浏览器的 disabled 语义**。
 *
 * 为什么不直接 `node.props.onClick()`：真实浏览器里 `disabled` 的按钮根本不派发
 * click 事件。如果测试直接调 handler，就等于绕过 disabled——"busy 期间连点不会重复
 * 发请求"这条会永远红（或被误判成实现有 bug），而实际用户点不动那个按钮。
 *
 * 返回是否真的点到了（`false` = 被 disabled 挡下）。
 */
function clickButton(node) {
  if (node === null || node === undefined) return false;
  if (node.props && node.props.disabled === true) return false;
  if (typeof node.props?.onClick !== 'function') return false;
  node.props.onClick({ stopPropagation() {} });
  return true;
}

/** 同理：勾选框被 disabled 时不会派发 change。 */
function toggleCheckbox(node) {
  if (node === null || node === undefined) return false;
  if (node.props && node.props.disabled === true) return false;
  if (typeof node.props?.onChange !== 'function') return false;
  node.props.onChange();
  return true;
}

/** 从存储里读回上次写入的勾选（直接读替身，验"持久化了什么"）。 */
function readPrefs(storage) {
  const raw = storage.getItem(PREFS_KEY);
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { __unparsable: raw };
  }
}

/** 统计页的固定 props：sessionId + 真实译名表。 */
const viewProps = (sessionId) => ({ sessionId, t: tz });

// ===========================================================================
// 一、勾选记忆
// ===========================================================================

test('偏好1：上次勾了「整机 + 工作区」，重开统计页时恢复成同一组合', async () => {
  const runtime = makeRuntime();
  const View = loadSlots(runtime)['conversation.view'];
  assert.ok(View, '必须注册 conversation.view');

  const storage = makeStorage({
    initial: { [PREFS_KEY]: JSON.stringify({ machine: true, workspace: true, session: false }) },
  });
  makeStatsEnv();
  const out = await withStorage(storage, () => mountStats(runtime, View, viewProps('session-1')));

  const boxes = checkboxes(out);
  assert.equal(boxes.length, 3, `统计页应有三勾选，实际 ${boxes.length}`);
  assert.equal(boxes[0].props.checked, true, '「整机」应恢复为勾上');
  assert.equal(boxes[1].props.checked, true, '「工作区」应恢复为勾上');
  assert.equal(boxes[2].props.checked, false, '「会话」上次没勾，应保持不勾');
});

test('偏好2：勾选变化后**立即**写入存储，且写的是新组合', async () => {
  const runtime = makeRuntime();
  const View = loadSlots(runtime)['conversation.view'];
  const storage = makeStorage();
  makeStatsEnv();
  let out = await withStorage(storage, async () => {
    const mounted = await mountStats(runtime, View, viewProps('session-1'));
    const before = readPrefs(storage);
    // 初始默认：只勾「会话」；打开「整机」。
  toggleCheckbox(checkboxes(mounted)[0]);
    await flush();
    const after = readPrefs(storage);
    const next = renderComponent(runtime, View, viewProps('session-1'));
    return { before, after, next };
  });

  const { before, after, next } = out;
  assert.ok(after && typeof after === 'object', `勾选变化后应写入存储，实际 ${JSON.stringify(after)}`);
  assert.equal(after.machine, true, `写入的应是新组合（machine:true），实际 ${JSON.stringify(after)}`);
  assert.notDeepEqual(after, before === null ? null : before,
    `写入内容应与变化前不同（新组合），变化前 ${JSON.stringify(before)}，变化后 ${JSON.stringify(after)}`);
  assert.equal(checkboxes(next)[0].props.checked, true, '界面应反映新勾选');
  void out;
});

test('偏好3：非法 JSON 回落默认，不崩', async () => {
  const runtime = makeRuntime();
  const View = loadSlots(runtime)['conversation.view'];
  const storage = makeStorage({ initial: { [PREFS_KEY]: '{not json' } });
  makeStatsEnv();
  const out = await withStorage(storage, () => mountStats(runtime, View, viewProps('session-1')));
  const boxes = checkboxes(out);
  assert.equal(boxes.length, 3, '非法 JSON 不应让统计页崩掉或丢勾选');
  assert.equal(boxes[0].props.checked, false, '默认「整机」不勾');
  assert.equal(boxes[1].props.checked, false, '默认「工作区」不勾');
  assert.equal(boxes[2].props.checked, true, '默认「会话」勾上');
});

test('偏好4：字段缺失按 false 处理，不因缺字段崩', async () => {
  const runtime = makeRuntime();
  const View = loadSlots(runtime)['conversation.view'];
  const storage = makeStorage({ initial: { [PREFS_KEY]: JSON.stringify({ workspace: true }) } });
  makeStatsEnv();
  const out = await withStorage(storage, () => mountStats(runtime, View, viewProps('session-1')));
  const boxes = checkboxes(out);
  assert.equal(boxes.length, 3);
  assert.equal(boxes[1].props.checked, true, '存在的字段 workspace 应生效');
  assert.equal(boxes[0].props.checked, false, '缺失的 machine 应按 false');
  assert.equal(boxes[2].props.checked, false, '缺失的 session 应按 false');
});

test('偏好5：空选（全 false）回落默认，不留空屏', async () => {
  const runtime = makeRuntime();
  const View = loadSlots(runtime)['conversation.view'];
  const storage = makeStorage({ initial: { [PREFS_KEY]: JSON.stringify({ machine: false, workspace: false, session: false }) } });
  makeStatsEnv();
  const out = await withStorage(storage, () => mountStats(runtime, View, viewProps('session-1')));
  const boxes = checkboxes(out);
  assert.equal(boxes[2].props.checked, true,
    '空选偏好不该被采用（会打开就是空屏），应回落默认「只勾会话」');
});

test('偏好6：localStorage 读取抛错时回落默认，不崩', async () => {
  const runtime = makeRuntime();
  const View = loadSlots(runtime)['conversation.view'];
  const storage = makeStorage({ failGet: true });
  makeStatsEnv();
  const out = await withStorage(storage, () => mountStats(runtime, View, viewProps('session-1')));
  const boxes = checkboxes(out);
  assert.equal(boxes.length, 3, 'getItem 抛错不应让统计页崩掉');
  assert.equal(boxes[2].props.checked, true, '读不到偏好时应回落默认');
});

test('偏好7：localStorage 写入抛错时功能照常（静默失败）', async () => {
  const runtime = makeRuntime();
  const View = loadSlots(runtime)['conversation.view'];
  const storage = makeStorage({ readOnly: true });
  makeStatsEnv();
  const out = await withStorage(storage, async () => {
    const mounted = await mountStats(runtime, View, viewProps('session-1'));
  toggleCheckbox(checkboxes(mounted)[0]);
    await flush();
    return renderComponent(runtime, View, viewProps('session-1'));
  });
  assert.equal(checkboxes(out)[0].props.checked, true, '写失败不该阻止界面切换');
});

test('偏好8：完全没有 localStorage（SSR / 旧环境）也不崩', async () => {
  const runtime = makeRuntime();
  const View = loadSlots(runtime)['conversation.view'];
  makeStatsEnv();
  const out = await withStorage(null, () => mountStats(runtime, View, viewProps('session-1')));
  const boxes = checkboxes(out);
  assert.equal(boxes.length, 3, '没有 localStorage 时统计页仍应正常渲染');
  assert.equal(boxes[2].props.checked, true, '无存储时应回落默认');
});

test('偏好9：上次勾了 session 但本次拿不到会话 id → 会话不可选，保留其它两项', async () => {
  const runtime = makeRuntime();
  const View = loadSlots(runtime)['conversation.view'];
  const storage = makeStorage({
    initial: { [PREFS_KEY]: JSON.stringify({ machine: true, workspace: false, session: true }) },
  });
  makeStatsEnv();
  const out = await withStorage(storage, () => mountStats(runtime, View, viewProps('')));
  const boxes = checkboxes(out);
  assert.equal(boxes[0].props.checked, true, '「整机」应保留（不因为会话不可用而丢）');
  assert.equal(boxes[2].props.checked, false, '无会话时「会话」不得被勾上');
});

test('偏好10：上次只勾了 session 且本次无会话 id → 至少一项被勾（不能空屏）', async () => {
  const runtime = makeRuntime();
  const View = loadSlots(runtime)['conversation.view'];
  const storage = makeStorage({
    initial: { [PREFS_KEY]: JSON.stringify({ machine: false, workspace: false, session: true }) },
  });
  makeStatsEnv();
  const out = await withStorage(storage, () => mountStats(runtime, View, viewProps('')));
  const boxes = checkboxes(out);
  const checkedCount = boxes.filter((b) => b.props.checked === true).length;
  assert.ok(checkedCount >= 1,
    `无论怎么回落，至少要有一项被勾（否则打开就是空屏），实际 ${JSON.stringify(boxes.map((b) => b.props.checked))}`);
});

// ===========================================================================
// 二、刷新 vs 重新统计
// ===========================================================================

const RECALC_RE = /重新统计|Recalculate/i;
const REFRESH_RE = /刷新|Refresh/i;

test('按钮1：刷新只发 GET，不发 POST', async () => {
  const runtime = makeRuntime();
  const View = loadSlots(runtime)['conversation.view'];
  const env = makeStatsEnv();
  const storage = makeStorage();
  const out = await withStorage(storage, () => mountStats(runtime, View, viewProps('session-1')));

  const beforeGet = env.getCalls().length;
  const beforePost = env.postCalls().length;
  const refresh = buttonsByAria(out, REFRESH_RE);
  assert.ok(refresh.length >= 1, `应有「刷新」按钮，实际 aria：${JSON.stringify(
    nodesOf(out).filter((n) => n.props && n.props['aria-label']).map((n) => n.props['aria-label']))}`);
  clickButton(refresh[0]);
  await flush();
  await flush();

  assert.ok(env.getCalls().length > beforeGet, '刷新应重新 GET 缓存');
  assert.equal(env.postCalls().length, beforePost,
    `刷新不得发 POST（那是「重新统计」的职责），实际 POST 次数 ${beforePost} → ${env.postCalls().length}`);
});

test('按钮2：重新统计发 POST，成功后跟一次 GET', async () => {
  const runtime = makeRuntime();
  const View = loadSlots(runtime)['conversation.view'];
  const env = makeStatsEnv();
  const storage = makeStorage();
  const out = await withStorage(storage, () => mountStats(runtime, View, viewProps('session-1')));

  const beforeGet = env.getCalls().length;
  const recalc = buttonsByAria(out, RECALC_RE);
  assert.ok(recalc.length >= 1, `应有「重新统计」按钮，实际 aria：${JSON.stringify(
    nodesOf(out).filter((n) => n.props && n.props['aria-label']).map((n) => n.props['aria-label']))}`);
  clickButton(recalc[0]);
  await flush();
  await flush();

  assert.equal(env.postCalls().length, 1, `重新统计应发一次 POST，实际 ${env.postCalls().length}`);
  assert.ok(env.getCalls().length > beforeGet,
    `POST 成功后应跟一次 GET 拿新缓存，实际 GET ${beforeGet} → ${env.getCalls().length}`);
});

test('按钮3：busy 期间按钮 disabled，且连点不会重复发请求', async () => {
  const runtime = makeRuntime();
  const View = loadSlots(runtime)['conversation.view'];
  const env = makeStatsEnv({ postPlan: 'pending' });
  const storage = makeStorage();
  const out = await withStorage(storage, async () => {
    const mounted = await mountStats(runtime, View, viewProps('session-1'));
    const started = clickButton(buttonsByAria(mounted, RECALC_RE)[0]);
    assert.equal(started, true, 'busy 之前「重新统计」应可点');
    await flush();
    return renderComponent(runtime, View, viewProps('session-1'));
  });

  // busy：按钮必须 disabled，且文案变成"正在重新统计…"。
  const recalcBtns = nodesOf(out).filter((n) => n.props
    && typeof n.props['aria-label'] === 'string'
    && RECALC_RE.test(n.props['aria-label']));
  assert.equal(recalcBtns.length, 1,
    `busy 期间应仍能找到那个按钮（aria 含「正在重新统计」），实际 aria：${JSON.stringify(
      nodesOf(out).filter((n) => n.props && n.props['aria-label']).map((n) => n.props['aria-label']))}`);
  assert.equal(recalcBtns[0].props.disabled, true,
    'busy 期间「重新统计」必须 disabled（否则用户能连点出多次全库扫描）');
  assert.ok(/正在重新统计|Recalculating/i.test(textOf(out)),
    `busy 期间应显示「正在重新统计…」，实际 ${textOf(out).slice(0, 200)}`);

  // 连点：浏览器的 disabled 语义下根本点不动——这才是用户真实遇到的。
  const posts = env.postCalls().length;
  let clickedAny = false;
  for (const node of buttonsByAria(out, RECALC_RE)) {
    if (clickButton(node)) clickedAny = true;
  }
  assert.equal(clickedAny, false, 'busy 期间那个按钮不该是可点状态');
  await flush();
  assert.equal(env.postCalls().length, posts, 'busy 期间连点不得重复发 POST');

  env.releasePosts(true);
  await flush();
  await flush();
});

test('按钮4：POST 失败显示失败文案，且可以再点重试', async () => {
  const runtime = makeRuntime();
  const View = loadSlots(runtime)['conversation.view'];
  const env = makeStatsEnv({ postPlan: 'fail' });
  const storage = makeStorage();
  const out = await withStorage(storage, async () => {
    const mounted = await mountStats(runtime, View, viewProps('session-1'));
    clickButton(buttonsByAria(mounted, RECALC_RE)[0]);
    await flush();
    await flush();
    return renderComponent(runtime, View, viewProps('session-1'));
  });

  assert.ok(/重新统计失败|Recalculation failed/i.test(textOf(out)),
    `失败应显示失败文案，实际 ${textOf(out).slice(0, 300)}`);

  const retry = buttonsByAria(out, RECALC_RE);
  assert.ok(retry.length >= 1, '失败后应仍能找到「重新统计」入口以便重试');
  const before = env.postCalls().length;
  clickButton(retry[0]);
  await flush();
  assert.ok(env.postCalls().length > before, '失败后应能再次触发 POST（可重试）');
});

test('按钮5：两个按钮的 aria 不同名，定位器不会互抓', async () => {
  const runtime = makeRuntime();
  const View = loadSlots(runtime)['conversation.view'];
  makeStatsEnv();
  const storage = makeStorage();
  const out = await withStorage(storage, () => mountStats(runtime, View, viewProps('session-1')));

  const refresh = buttonsByAria(out, REFRESH_RE);
  const recalc = buttonsByAria(out, RECALC_RE);
  assert.equal(refresh.length, 1, `「刷新」应恰好一个，实际 ${refresh.length}`);
  assert.equal(recalc.length, 1, `「重新统计」应恰好一个，实际 ${recalc.length}`);
  assert.notEqual(refresh[0].props['aria-label'], recalc[0].props['aria-label'],
    '两个按钮的 aria 必须不同名，否则屏幕阅读器与自动化都无法区分');
  assert.ok(!REFRESH_RE.test(recalc[0].props['aria-label']),
    `「重新统计」的 aria 不应命中刷新文案，实际 ${recalc[0].props['aria-label']}`);
  assert.ok(!RECALC_RE.test(refresh[0].props['aria-label']),
    `「刷新」的 aria 不应命中重新统计文案，实际 ${refresh[0].props['aria-label']}`);
});

test('按钮6：与 A4「存在真实刷新入口」不冲突——刷新入口仍在且真的取数', async () => {
  const runtime = makeRuntime();
  const View = loadSlots(runtime)['conversation.view'];
  const env = makeStatsEnv();
  const storage = makeStorage();
  const out = await withStorage(storage, () => mountStats(runtime, View, viewProps('session-1')));

  const refresh = buttonsByAria(out, REFRESH_RE);
  assert.ok(refresh.length >= 1, 'A4 要求的"真实刷新入口"必须仍在');
  const before = env.getCalls().length;
  clickButton(refresh[0]);
  await flush();
  await flush();
  assert.ok(env.getCalls().length > before, '那个入口必须真的触发取数');
});
