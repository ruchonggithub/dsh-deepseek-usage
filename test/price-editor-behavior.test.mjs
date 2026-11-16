// 配置页「单价」块（PriceEditor）的行为用例：真实 client.js + 迷你 React + 可控 fetch。
// 复用 client-behavior.test.mjs 的基建思路；组件从 __internals 拿（规格指定的验证通道），
// 但必须**每个用例现载一个模块实例**——模块加载时绑定的 react 对象决定 hooks 用哪一套，
// 拿全局桩载入的组件状态永远不动。
//
// 交互模型（用户口径）：**双击模型名进编辑，失焦自动保存**；Esc 放弃；Enter 提前保存。
// 表格只显示「提供商给的模型显示别名」+ 三个价格 + 「已改」徽章，不带任何出处解释。
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

// ---- 迷你 React（与 client-behavior.test.mjs 同一份实现）----
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
      for (const e of pending) e.fn();
      return { out };
    },
  };
}

/** 载入 client.js：react 必须用当前用例的 runtime.react（hooks 才有状态）。 */
function loadModule(runtime) {
  const win = { __ModuleLoader__: { load: (def) => { win.__def = def; } } };
  new Function('window', 'require', source)(win, (id) => (id === 'react' ? runtime.react : {}));
  return win.__def.factory((id) => (id === 'react' ? runtime.react : {}));
}

/** 全局桩实例：只用于纯函数与词典（不渲染组件）。 */
const stubReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (init) => ({ current: init }),
  useMemo: (fn) => fn(),
  useSyncExternalStore: (_sub, snap) => snap(),
};
const stubInternals = (() => {
  const win = { __ModuleLoader__: { load: (def) => { win.__def = def; } } };
  new Function('window', 'require', source)(win, (id) => (id === 'react' ? stubReact : {}));
  return win.__def.factory((id) => (id === 'react' ? stubReact : {})).__internals;
})();

const t = (k) => stubInternals.ZH[k] ?? k;
const { priceUnifiedOf, priceTripleOf, priceNoticeLines, priceRowsMatchFilter, priceGroupsOf } = stubInternals;
const PRICES_PATH = stubInternals.PRICES_PATH;

/** 递归展开函数组件（与 client-behavior.test.mjs 的 renderTree 同一实现）。 */
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

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 渲染一个挂载好的 PriceEditor（当前用例的模块实例 + runtime）。 */
function makeEditor(runtime) {
  const { PriceEditor } = loadModule(runtime).__internals;
  const render = () => renderTree(runtime, PriceEditor({ t, lang: 'zh' })).out;
  return { render, out: render() };
}

/**
 * 深拷贝种子的一条切片，够 UI 用即可。
 *
 * 种子按 lib/price-table.js 的真实价格写：trae 的 DeepSeek-V4-Flash-Official 是
 * deepseek-flash 的镜像，带**峰谷两档**（standard 2/8/0.04，offPeak 1/4/0.02），
 * 所以 priceUnifiedOf 会把它判成 peakDiffers=true——用来验证「峰谷合并提示」
 * 确实不再出现在界面上（那是"价格从哪来"的解释，用户不要）。
 */
function seedRows() {
  return [
    { provider: 'trae', model: 'DeepSeek-V4-Flash-Official', displayName: 'DeepSeek V4 Flash Official（对应官方 deepseek-flash 价）', currency: 'CNY', source: 'official-doc', asOf: '2026-09-10', mirrors: 'deepseek-official/deepseek-flash', input: { standard: 2, offPeak: 1 }, output: { standard: 8, offPeak: 4 }, cacheRead: { standard: 0.04, offPeak: 0.02 } },
    { provider: 'trae', model: 'glm-5.2', displayName: 'GLM-5.2（对应 Z.ai 官方价）', currency: 'CNY', source: 'official-doc', asOf: '2026-10-27', input: { standard: 1.4 }, output: { standard: 4.4 }, cacheRead: { standard: 0.26 } },
    { provider: 'trae', model: 'kimi-k3', displayName: 'Kimi K3（对应 Moonshot 官方价）', currency: 'USD', source: 'official-doc', asOf: '2026-10-27', input: { standard: 3 }, output: { standard: 15 }, cacheRead: { standard: 0.3 } },
    { provider: 'qoder', model: 'gmodel', displayName: 'GLM-5.3（对应 Z.ai 官方价）', currency: 'CNY', source: 'official-doc', asOf: '2026-10-27', input: { standard: 1.4 }, output: { standard: 4.4 }, cacheRead: { standard: 0.26 } },
    { provider: 'raccoon', model: 'sn-glm-5-3-flash', displayName: 'GLM-5-3-Flash · x0.2→x0.1', currency: 'CNY', source: 'name-suffix', asOf: '2026-11-14', uniform: 0.1, promotion: { original: 0.2, current: 0.1, from: null, until: null } },
    { provider: 'raccoon', model: 'sn-sensenova-6-8-flash', displayName: 'SenseNova-6.8-Flash · 免费', currency: 'CNY', source: 'free', asOf: '2026-11-14', free: true },
    { provider: 'moonshotai', model: 'kimi-k3', displayName: 'kimi-k3', currency: 'USD', source: 'official-doc', asOf: '2026-10-27', input: { standard: 2 }, output: { standard: 10 }, cacheRead: { standard: 0.2 } },
    { provider: 'moonshotai', model: 'kimi-k2.6', displayName: 'kimi-k2.6', currency: 'USD', source: 'manual', asOf: '2026-11-14', seedSource: 'official-doc', seedAsOf: '2026-10-27', input: { standard: 0.5 }, output: { standard: 2 }, cacheRead: { standard: 0.1 } },
  ];
}

const pricesResponse = (records = seedRows(), extra = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, records, problems: [], ...extra }),
});

const saveResponse = (over = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, saved: [], notices: [], ...over }),
});

const errorResponse = (error) => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: false, error, notices: [] }),
});

/** 找到文本恰为 label 的按钮。 */
function buttonWithText(out, label) {
  return nodesOf(out).find((n) => n.type === 'button' && textOf(n) === label) ?? null;
}

/** 某渠道分组行（tr[data-group]）。 */
function groupRowOf(out, provider) {
  return nodesOf(out).find((n) => n.type === 'tr' && n.props && n.props['data-group'] === provider) ?? null;
}

/**
 * 渠道分组行的**可点单元**：折叠开关的 onClick 挂在行内那个 colSpan 的 <td> 上
 * （整行都是点击区），不在 <tr> 本身。点它才是用户点的那一下。
 */
function groupToggleOf(out, provider) {
  const row = groupRowOf(out, provider);
  if (row === null) return null;
  const cell = nodesOf(row).find((n) => n.type === 'td' && n.props && typeof n.props.onClick === 'function');
  return cell ?? null;
}

/** 全部分组行。 */
function groupRowsOf(out) {
  return nodesOf(out).filter((n) => n.type === 'tr' && n.props && typeof n.props['data-group'] === 'string');
}

/**
 * 全部**模型行**（tbody 里的数据行）。
 *
 * 不能直接数所有 <tr>：表头那一行（thead 里那个无 props 的 tr）永远在，
 * 「无命中时不渲染行」会数出 1。渠道分组行有 data-group，这里只要没有 data-group
 * 的数据行——表头 tr 连 role 都没有，自然被排除。
 */
function modelRowsOf(out) {
  return nodesOf(out).filter((n) => n.type === 'tr' && n.props && n.props.role === 'row' && n.props['data-group'] === undefined);
}

/** 展开（非折叠）分组下的模型行：分组行之后的非分组 tr。 */
function rowsUnder(out, provider) {
  const nodes = nodesOf(out).filter((n) => n.type === 'tr');
  const idx = nodes.findIndex((n) => n.props && n.props['data-group'] === provider);
  const rows = [];
  for (let i = idx + 1; i < nodes.length; i += 1) {
    if (nodes[i].props && nodes[i].props['data-group'] !== undefined) break;
    rows.push(nodes[i]);
  }
  return rows;
}

/** 模型显示别名那一格（双击进入编辑的入口）。 */
function nameCellOf(out, displayName) {
  const cell = nodesOf(out).find((n) => n.type === 'td' && textOf(n) === displayName);
  return cell ?? null;
}

/** 编辑态的三个数字输入框。 */
function priceInputsOf(out) {
  return nodesOf(out).filter((n) => n.type === 'input' && n.props && n.props.inputMode === 'decimal');
}

/** 双击模型名 → 进入编辑态（onDoubleClick 挂在别名那一格上）。 */
function doubleClickName(out, displayName) {
  const cell = nameCellOf(out, displayName);
  assert.ok(cell, `找不到模型名单元格：${displayName}`);
  assert.equal(typeof cell.props.onDoubleClick, 'function', '模型名那格必须能双击');
  cell.props.onDoubleClick();
}

/**
 * 失焦 → 自动保存。
 *
 * relatedTarget 是「焦点移到哪儿去了」：null 表示移出了这一行（真失焦）。
 */
function blurOf(out, index = 0) {
  const inputs = priceInputsOf(out);
  assert.ok(inputs[index], `找不到第 ${index + 1} 个输入框`);
  assert.equal(typeof inputs[index].props.onBlur, 'function', '输入框必须能失焦');
  inputs[index].props.onBlur({ relatedTarget: null });
}

/** 模拟焦点在**同一行**的另一个输入框上（relatedTarget 非 null，但 data-row 相同）。 */
function blurWithinRow(out, index = 0, targetIndex = 1) {
  const inputs = priceInputsOf(out);
  const target = inputs[targetIndex];
  assert.ok(target, `找不到第 ${targetIndex + 1} 个输入框`);
  const fake = { getAttribute: (name) => (name === 'data-row' ? target.props['data-row'] : null) };
  inputs[index].props.onBlur({ relatedTarget: fake });
}

/** 键盘：Esc / Enter。 */
function pressKey(out, key, index = 0) {
  const inputs = priceInputsOf(out);
  assert.ok(inputs[index], `找不到第 ${index + 1} 个输入框`);
  assert.equal(typeof inputs[index].props.onKeyDown, 'function', '输入框必须能收键盘事件');
  let prevented = false;
  inputs[index].props.onKeyDown({ key, preventDefault: () => { prevented = true; } });
  return prevented;
}

// ---- 纯函数 ----

test('price.editor：priceUnifiedOf 按形态预填三字段（split/uniform/free/峰谷）', () => {
  const split = priceUnifiedOf({ provider: 'trae', model: 'm', currency: 'CNY', source: 'official-doc', asOf: '2026-01-01', input: { standard: 2, offPeak: 1 }, output: { standard: 8, offPeak: 4 }, cacheRead: { standard: 0.04, offPeak: 0.02 } });
  assert.deepEqual([split.input, split.output, split.cacheRead], [2, 8, 0.04]);
  assert.equal(split.peakDiffers, true, '有 offPeak 差价的记录必须标 peakDiffers');
  const uniform = priceUnifiedOf({ provider: 'raccoon', model: 'm', currency: 'CNY', source: 'name-suffix', asOf: '2026-01-01', uniform: 0.1 });
  assert.deepEqual([uniform.input, uniform.output, uniform.cacheRead], [0.1, 0.1, 0.1], '单一价三框预填同值');
  assert.equal(uniform.uniform, true);
  const free = priceUnifiedOf({ provider: 'opencode', model: 'm', currency: 'USD', source: 'free', asOf: '2026-01-01', free: true });
  assert.deepEqual([free.input, free.output, free.cacheRead], [0, 0, 0], '免费行预填三个 0');
  assert.equal(free.free, true);
  const sameTier = priceUnifiedOf({ provider: 'deepseek', model: 'm', currency: 'CNY', source: 'official-doc', asOf: '2026-01-01', input: { standard: 2, offPeak: 2 }, output: { standard: 8, offPeak: 8 }, cacheRead: { standard: 0.5, offPeak: 0.5 } });
  assert.equal(sameTier.peakDiffers, false, '两档同价不算峰谷差');
});

test('price.editor：priceTripleOf 拒绝负数与非数字，容忍小数', () => {
  // deepEqual 而不是 equal：priceTripleOf 每次返回**新对象**（普通对象，
  // 原型就是 Object.prototype），equal 是引用比较，两个字面量必然不等。
  assert.deepEqual(priceTripleOf({ input: '0.04', output: 8, cacheRead: 2 }), { input: 0.04, output: 8, cacheRead: 2 });
  assert.equal(priceTripleOf({ input: '-1', output: 8, cacheRead: 2 }), null, '负数拒发');
  assert.equal(priceTripleOf({ input: 'abc', output: 8, cacheRead: 2 }), null, '非数字拒发');
  assert.equal(priceTripleOf({ input: '', output: 8, cacheRead: 2 }), null, '空串拒发');
  assert.deepEqual(priceTripleOf({ input: 0, output: 0, cacheRead: 0 }), { input: 0, output: 0, cacheRead: 0 }, '0 合法（转免费）');
});

test('price.editor：priceNoticeLines 只映射已知标记，未知的跳过', () => {
  const lines = priceNoticeLines(['peak-merged', 'future-thing', 'now-free'], t);
  assert.deepEqual(lines.map((l) => l.key), ['peak-merged', 'now-free']);
  assert.ok(lines[0].text.includes('峰谷'), '峰谷文案进中文词典：' + lines[0].text);
  assert.deepEqual(priceNoticeLines([], t), []);
});

test('price.editor：priceRowsMatchFilter 大小写不敏感匹配 provider/model/展示名', () => {
  const row = { provider: 'trae', model: 'DeepSeek-V4-Flash-Official', displayName: 'DeepSeek V4 Flash Official（对应官方 deepseek-flash 价）' };
  assert.equal(priceRowsMatchFilter(row, 'TRAE'), true);
  assert.equal(priceRowsMatchFilter(row, 'deepseek-v4'), true);
  assert.equal(priceRowsMatchFilter(row, '对应官方'), true, '展示名也参与过滤');
  assert.equal(priceRowsMatchFilter(row, 'kimi'), false);
  assert.equal(priceRowsMatchFilter(row, ''), true, '空串匹配一切');
});

test('price.editor：priceGroupsOf 按渠道分组且保持存储顺序', () => {
  const groups = priceGroupsOf(seedRows());
  assert.deepEqual(groups.map((g) => g.provider), ['trae', 'qoder', 'raccoon', 'moonshotai']);
  assert.equal(groups[0].rows.length, 3);
});

// ---- 组件行为 ----

test('price.editor：挂载后拉价格表，按渠道分组可折叠，已改行有徽章', async () => {
  const runtime = makeRuntime();
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return pricesResponse(); };
  const { render } = makeEditor(runtime);
  await flush();
  const out = render();
  assert.equal(calls[0], PRICES_PATH, '必须请求价格路由，实际：' + calls.join(', '));
  assert.deepEqual(groupRowsOf(out).map((n) => n.props['data-group']), ['trae', 'qoder', 'raccoon', 'moonshotai'], '按渠道分组');
  // trae 组默认展开：三行模型都在。
  const traeRows = rowsUnder(out, 'trae');
  assert.equal(traeRows.length, 3, '未折叠时组内行可见，实际 ' + traeRows.length);
  assert.ok(!textOf(traeRows[0]).includes('已改'), 'official-doc 行不标已改');
  const editedRows = modelRowsOf(out).filter((n) => textOf(n).includes('已改'));
  assert.equal(editedRows.length, 1, '只有 source=manual 的行有已改徽章，实际 ' + editedRows.length);
  assert.ok(textOf(editedRows[0]).includes('kimi-k2.6'), '已改行是 kimi-k2.6');
  // 折叠：点 trae 渠道行后组内行消失，再点恢复。
  const toggle = groupToggleOf(out, 'trae');
  assert.ok(toggle, '渠道行里的可点单元必须在');
  toggle.props.onClick();
  const folded = render();
  assert.equal(rowsUnder(folded, 'trae').length, 0, '折叠后组内行不渲染');
  assert.ok(textOf(folded).includes('共 3 条'), '渠道行带条数');
  groupToggleOf(folded, 'trae').props.onClick();
  const expanded = render();
  assert.equal(rowsUnder(expanded, 'trae').length, 3, '再点展开');
});

test('price.editor：过滤 trae 只剩 trae 的行，且命中时折叠组自动展开', async () => {
  const runtime = makeRuntime();
  globalThis.fetch = async () => pricesResponse();
  const { render } = makeEditor(runtime);
  await flush();
  // 先折叠 trae。
  let out = render();
  groupToggleOf(out, 'trae').props.onClick();
  out = render();
  assert.equal(rowsUnder(out, 'trae').length, 0);
  // 输入过滤词（大小写混排）：folded 状态不再生效，命中组自动展开。
  const search = nodesOf(out).find((n) => n.type === 'input' && n.props && n.props['aria-label'] === t('price.editor.searchLabel'));
  assert.ok(search, '过滤框必须在');
  search.props.onChange({ target: { value: 'Trae' } });
  out = render();
  assert.deepEqual(groupRowsOf(out).map((n) => n.props['data-group']), ['trae'], '过滤 trae 后只剩 trae 组');
  assert.equal(rowsUnder(out, 'trae').length, 3, '命中时折叠组自动展开');
  assert.ok(textOf(out).includes('GLM-5.2（对应 Z.ai 官方价）'), 'trae 的行在：' + textOf(out));
  assert.ok(!textOf(out).includes('GLM-5.3（对应 Z.ai 官方价）'), 'qoder 的行被滤掉');
  // 模型子串过滤（大小写不敏感：两个渠道都有 kimi-k3）。
  search.props.onChange({ target: { value: 'KIMI-K3' } });
  out = render();
  assert.deepEqual(groupRowsOf(out).map((n) => n.props['data-group']), ['trae', 'moonshotai'], '模型名大小写不敏感：两个渠道都有 kimi-k3');
  // 无命中：一条模型行都不渲染（表头行不算）。
  search.props.onChange({ target: { value: 'no-such-model-xyz' } });
  out = render();
  assert.equal(modelRowsOf(out).length, 0, '无命中时不渲染行，实际 ' + modelRowsOf(out).length);
  assert.deepEqual(groupRowsOf(out), [], '无命中时不渲染分组行');
});

test('price.editor：表格只有显示别名与三个价格，没有出处解释与多余徽章', async () => {
  const runtime = makeRuntime();
  globalThis.fetch = async () => pricesResponse();
  const { render } = makeEditor(runtime);
  await flush();
  const out = render();
  const text = textOf(out);

  // ① 出处解释（"这个价格是怎么来的"）一律不出现：
  //   · 手定价出处（改于…／原出处…）
  //   · 镜像自…的官方价
  //   · 峰谷合并提示
  assert.ok(!text.includes('原出处'), '不得出现「原出处」：' + text);
  assert.ok(!text.includes('镜像自'), '不得出现「镜像自」：' + text);
  assert.ok(!text.includes('手定价'), '不得出现「手定价」：' + text);
  assert.ok(!text.includes('峰谷将合并为同价'), '不得出现峰谷合并提示：' + text);
  assert.ok(!text.includes('官方文档'), '不得出现出处标签：' + text);
  assert.ok(!text.includes('渠道名标价'), '不得出现出处标签：' + text);

  // ② 多余徽章（免费／单一价）不出现；「已改」保留。
  //    注意：只查**徽章**（data-badge），不能查整段文字——「SenseNova-6.8-Flash · 免费」
  //    里的「免费」是**提供商自己给的显示别名**，那是用户要的那一列，不能误伤。
  const badges = nodesOf(out)
    .filter((n) => n.props && typeof n.props['data-badge'] === 'string')
    .map((n) => n.props['data-badge']);
  assert.deepEqual([...new Set(badges)], ['edited'], '只应有「已改」一种徽章，实际：' + JSON.stringify(badges));
  assert.ok(!badges.includes('free'), '不得有「免费」徽章');
  assert.ok(!badges.includes('uniform'), '不得有「单一价」徽章');
  assert.ok(text.includes('已改'), '「已改」徽章保留（用户改价后要知道改了哪几行）：' + text);

  // ③ 标题是"操作说明"而不是"价格来源"：只提示怎么改。
  const nameCell = nameCellOf(out, 'DeepSeek V4 Flash Official（对应官方 deepseek-flash 价）');
  assert.ok(nameCell, '模型显示别名那格必须在');
  assert.equal(nameCell.props.title, t('price.editor.editHint'), '悬浮说明只讲怎么改，不讲价格来源');
  assert.ok(!/镜像|出处|手定价|峰谷/.test(nameCell.props.title ?? ''), '悬浮说明不得含出处解释：' + nameCell.props.title);

  // ④ 没有「编辑／保存／取消」按钮了（改用双击 + 失焦）。
  const rowButtons = modelRowsOf(out).flatMap((n) => nodesOf(n).filter((c) => c.type === 'button'));
  assert.equal(rowButtons.length, 0, '行内不该再有按钮，实际 ' + rowButtons.length);
  assert.equal(buttonWithText(out, '编辑'), null, '不该有「编辑」按钮');
  assert.equal(buttonWithText(out, '保存'), null, '不该有「保存」按钮');
});

test('price.editor：双击进入编辑，三个输入框预填原值', async () => {
  const runtime = makeRuntime();
  globalThis.fetch = async () => pricesResponse();
  const { render } = makeEditor(runtime);
  await flush();
  let out = render();
  assert.equal(priceInputsOf(out).length, 0, '查看态没有输入框');
  doubleClickName(out, 'DeepSeek V4 Flash Official（对应官方 deepseek-flash 价）');
  out = render();
  const inputs = priceInputsOf(out);
  assert.equal(inputs.length, 3, '编辑态有三个数字输入框');
  assert.deepEqual(inputs.map((n) => n.props.value), ['2', '8', '0.04'], '预填 standard 档的值，实际：' + inputs.map((n) => n.props.value).join('/'));
  assert.equal(inputs[0].props.autoFocus, true, '第一个输入框自动聚焦（双击后直接改）');
  assert.notEqual(inputs[1].props.autoFocus, true, '只有一个输入框自动聚焦');
  // 这一行**有峰谷差价**（种子带 offPeak），但编辑态不得再解释"价格从哪来"。
  // 注意：peakDiffers 的词典键已被删除，所以万一实现把它加回来，t() 返回的是
  // 原始键名 'price.editor.peakDiffers'（不是中文）——两种都查。
  assert.ok(!textOf(out).includes('峰谷'), '编辑态不得出现峰谷提示：' + textOf(out));
  assert.ok(!textOf(out).includes('price.editor.peakDiffers'), '编辑态不得出现峰谷提示（原始键名）：' + textOf(out));
});

test('price.editor：改数字 → 失焦 → 自动 POST 保存', async () => {
  const runtime = makeRuntime();
  const posts = [];
  globalThis.fetch = async (url, init) => {
    if (init && init.method === 'POST') {
      posts.push(JSON.parse(init.body));
      return saveResponse({ notices: ['peak-merged'] });
    }
    return pricesResponse();
  };
  const { render } = makeEditor(runtime);
  await flush();
  let out = render();
  doubleClickName(out, 'DeepSeek V4 Flash Official（对应官方 deepseek-flash 价）');
  out = render();
  // 改第一个价，然后**失焦**（不点任何按钮）。
  const inputs = priceInputsOf(out);
  inputs[0].props.onChange({ target: { value: '0.04' } });
  out = render();
  assert.equal(posts.length, 0, '改完还没失焦，不该发请求');
  blurOf(out, 0);
  await flush();
  out = render();
  assert.equal(posts.length, 1, '失焦必须自动发一次 POST，实际 ' + posts.length);
  assert.deepEqual(posts[0], { action: 'save', record: { provider: 'trae', model: 'DeepSeek-V4-Flash-Official', input: 0.04, output: 8, cacheRead: 0.04 } }, 'POST 体是三字段编辑，实际：' + JSON.stringify(posts[0]));
  assert.ok(textOf(out).includes('已保存'), '保存成功要有反馈：' + textOf(out));
  assert.ok(textOf(out).includes('峰谷已合并为同价'), 'notices（peak-merged）要可见：' + textOf(out));
  assert.equal(priceInputsOf(out).length, 0, '保存成功后退出编辑态');
});

test('price.editor：没改数字 → 失焦 → 不发请求（不产生无谓 POST）', async () => {
  const runtime = makeRuntime();
  const posts = [];
  globalThis.fetch = async (url, init) => {
    if (init && init.method === 'POST') {
      posts.push(JSON.parse(init.body));
      return saveResponse();
    }
    return pricesResponse();
  };
  const { render } = makeEditor(runtime);
  await flush();
  let out = render();
  doubleClickName(out, 'DeepSeek V4 Flash Official（对应官方 deepseek-flash 价）');
  out = render();
  assert.equal(priceInputsOf(out).length, 3, '进了编辑态');
  // 什么都没改，直接失焦。
  blurOf(out, 0);
  await flush();
  out = render();
  assert.equal(posts.length, 0, '值没变就不该发 POST，实际 ' + posts.length);
  assert.equal(priceInputsOf(out).length, 0, '没改也要退出编辑态（别把用户困在编辑里）');
});

test('price.editor：改回原值 → 失焦 → 同样不发请求', async () => {
  const runtime = makeRuntime();
  const posts = [];
  globalThis.fetch = async (url, init) => {
    if (init && init.method === 'POST') {
      posts.push(JSON.parse(init.body));
      return saveResponse();
    }
    return pricesResponse();
  };
  const { render } = makeEditor(runtime);
  await flush();
  let out = render();
  doubleClickName(out, 'DeepSeek V4 Flash Official（对应官方 deepseek-flash 价）');
  out = render();
  const inputs = priceInputsOf(out);
  inputs[0].props.onChange({ target: { value: '99' } });
  out = render();
  // 改回原值 → 与起始值相同 → 不该发请求。
  priceInputsOf(out)[0].props.onChange({ target: { value: '2' } });
  out = render();
  blurOf(out, 0);
  await flush();
  assert.equal(posts.length, 0, '改回原值等于没改，不该发 POST，实际 ' + posts.length);
});

test('price.editor：Esc 放弃编辑，还原原值且不发请求', async () => {
  const runtime = makeRuntime();
  const posts = [];
  globalThis.fetch = async (url, init) => {
    if (init && init.method === 'POST') {
      posts.push(JSON.parse(init.body));
      return saveResponse();
    }
    return pricesResponse();
  };
  const { render } = makeEditor(runtime);
  await flush();
  let out = render();
  doubleClickName(out, 'DeepSeek V4 Flash Official（对应官方 deepseek-flash 价）');
  out = render();
  priceInputsOf(out)[0].props.onChange({ target: { value: '99' } });
  out = render();
  assert.equal(pressKey(out, 'Escape'), true, 'Esc 要 preventDefault');
  out = render();
  await flush();
  out = render();
  assert.equal(posts.length, 0, 'Esc 放弃，不得发请求，实际 ' + posts.length);
  assert.equal(priceInputsOf(out).length, 0, 'Esc 后退出编辑态');
  // 值还原成原来的 2（不是 99）。
  const cell = nameCellOf(out, 'DeepSeek V4 Flash Official（对应官方 deepseek-flash 价）');
  assert.ok(cell, 'Esc 后回到查看态');
  assert.ok(textOf(out).includes('2'), '值已还原');
});

test('price.editor：Enter 提前结束编辑（等价于失焦保存）', async () => {
  const runtime = makeRuntime();
  const posts = [];
  globalThis.fetch = async (url, init) => {
    if (init && init.method === 'POST') {
      posts.push(JSON.parse(init.body));
      return saveResponse();
    }
    return pricesResponse();
  };
  const { render } = makeEditor(runtime);
  await flush();
  let out = render();
  doubleClickName(out, 'DeepSeek V4 Flash Official（对应官方 deepseek-flash 价）');
  out = render();
  priceInputsOf(out)[0].props.onChange({ target: { value: '3' } });
  out = render();
  assert.equal(pressKey(out, 'Enter'), true, 'Enter 要 preventDefault');
  await flush();
  out = render();
  assert.equal(posts.length, 1, 'Enter 应触发一次保存，实际 ' + posts.length);
  assert.deepEqual(posts[0], { action: 'save', record: { provider: 'trae', model: 'DeepSeek-V4-Flash-Official', input: 3, output: 8, cacheRead: 0.04 } }, 'POST 体正确');
});

test('price.editor：焦点在同一行内移动不算失焦（不打断编辑）', async () => {
  const runtime = makeRuntime();
  const posts = [];
  globalThis.fetch = async (url, init) => {
    if (init && init.method === 'POST') {
      posts.push(JSON.parse(init.body));
      return saveResponse();
    }
    return pricesResponse();
  };
  const { render } = makeEditor(runtime);
  await flush();
  let out = render();
  doubleClickName(out, 'DeepSeek V4 Flash Official（对应官方 deepseek-flash 价）');
  out = render();
  priceInputsOf(out)[0].props.onChange({ target: { value: '3' } });
  out = render();
  // 从第一个输入框移到同一行的第二个：还在这一行里 → 不算失焦。
  blurWithinRow(out, 0, 1);
  await flush();
  out = render();
  assert.equal(posts.length, 0, '焦点还在本行内不该发请求，实际 ' + posts.length);
  assert.equal(priceInputsOf(out).length, 3, '还在编辑态');
  // 真正离开这一行 → 存。
  blurOf(out, 1);
  await flush();
  assert.equal(posts.length, 1, '离开这一行才保存，实际 ' + posts.length);
});

test('price.editor：负数在客户端就被拒发，不发 POST 且有可见理由', async () => {
  const runtime = makeRuntime();
  const posts = [];
  globalThis.fetch = async (url, init) => {
    if (init && init.method === 'POST') {
      posts.push(JSON.parse(init.body));
      return saveResponse();
    }
    return pricesResponse();
  };
  const { render } = makeEditor(runtime);
  await flush();
  let out = render();
  doubleClickName(out, 'DeepSeek V4 Flash Official（对应官方 deepseek-flash 价）');
  out = render();
  priceInputsOf(out)[0].props.onChange({ target: { value: '-5' } });
  out = render();
  blurOf(out, 0);
  out = render();
  assert.equal(posts.length, 0, '非法值不得发请求');
  assert.ok(textOf(out).includes('必须是 0 或正数'), '客户端拒发要给可见理由：' + textOf(out));
  assert.equal(priceInputsOf(out).length, 3, '非法值时留在编辑态让用户改');
});

test('price.editor：ok:false 时错误原文可见，不静默失败', async () => {
  const runtime = makeRuntime();
  globalThis.fetch = async (url, init) => {
    if (init && init.method === 'POST') return errorResponse('有 1 条不合法，整批未写入：分项价槽位不是 { standard, offPeak? } 形状');
    return pricesResponse();
  };
  const { render } = makeEditor(runtime);
  await flush();
  let out = render();
  doubleClickName(out, 'DeepSeek V4 Flash Official（对应官方 deepseek-flash 价）');
  out = render();
  priceInputsOf(out)[0].props.onChange({ target: { value: '3' } });
  out = render();
  blurOf(out, 0);
  await flush();
  out = render();
  const alert = nodesOf(out).find((n) => n.props && n.props.role === 'alert');
  assert.ok(alert, 'ok:false 必须有 role=alert 的错误条');
  assert.ok(textOf(out).includes('整批未写入'), '宿主 error 原文要显示出来：' + textOf(out));
  assert.ok(textOf(out).includes('保存被拒绝'), '错误条要带前缀：' + textOf(out));
});

test('price.editor：网络失败（fetch 抛错）也有可见反馈', async () => {
  const runtime = makeRuntime();
  globalThis.fetch = async (url, init) => {
    if (init && init.method === 'POST') throw new TypeError('failed to fetch');
    return pricesResponse();
  };
  const { render } = makeEditor(runtime);
  await flush();
  let out = render();
  doubleClickName(out, 'DeepSeek V4 Flash Official（对应官方 deepseek-flash 价）');
  out = render();
  priceInputsOf(out)[0].props.onChange({ target: { value: '3' } });
  out = render();
  blurOf(out, 0);
  await flush();
  out = render();
  const alert = nodesOf(out).find((n) => n.props && n.props.role === 'alert');
  assert.ok(alert, '网络失败也要有错误条');
  assert.ok(textOf(out).includes('保存失败'), '网络失败文案：' + textOf(out));
});

test('price.editor：恢复默认有二次确认，确认后 POST reset', async () => {
  const runtime = makeRuntime();
  const posts = [];
  globalThis.fetch = async (url, init) => {
    if (init && init.method === 'POST') {
      posts.push(JSON.parse(init.body));
      return saveResponse({ notices: ['reset-to-seed'] });
    }
    return pricesResponse();
  };
  const { render } = makeEditor(runtime);
  await flush();
  let out = render();
  const resetBtn = buttonWithText(out, '恢复默认价格');
  assert.ok(resetBtn, '恢复默认按钮必须在');
  resetBtn.props.onClick();
  out = render();
  assert.equal(posts.length, 0, '二次确认前不得发请求');
  assert.ok(textOf(out).includes('恢复出厂价格表'), '确认条必须出现：' + textOf(out));
  assert.ok(textOf(out).includes('1 条已改'), '确认文案带上已改条数：' + textOf(out));
  // 取消 → 确认条消失。
  buttonWithText(out, '取消').props.onClick();
  out = render();
  assert.ok(!textOf(out).includes('恢复出厂价格表'), '取消后确认条消失');
  // 再点确认条上的「恢复默认价格」才真正 POST reset。
  // 确认条是 role=alertdialog 的容器（aria-label 挂在容器上），执行按钮本身没有
  // aria-label——所以要在**确认条容器内**按文案找按钮，别按 aria-label 找。
  resetBtn.props.onClick();
  out = render();
  const dialog = nodesOf(out).find((n) => n.props && n.props.role === 'alertdialog');
  assert.ok(dialog, '确认条必须存在');
  const confirmButton = nodesOf(dialog).find((n) => n.type === 'button' && textOf(n) === '恢复默认价格');
  assert.ok(confirmButton, '确认条里的执行按钮在');
  confirmButton.props.onClick();
  await flush();
  out = render();
  assert.equal(posts.length, 1, '确认后才发 POST');
  assert.deepEqual(posts[0], { action: 'reset' }, 'POST 体是 reset');
  assert.ok(textOf(out).includes('已恢复出厂价格'), '重置成功要有反馈：' + textOf(out));
});

test('price.editor：宿主缺路由（404）时整块显示「暂不可用」，不崩、不发保存', async () => {
  const runtime = makeRuntime();
  const posts = [];
  globalThis.fetch = async (url, init) => {
    if (init && init.method === 'POST') { posts.push(1); return errorResponse('x'); }
    return { ok: false, status: 404, json: async () => ({ ok: false }) };
  };
  const { render } = makeEditor(runtime);
  await flush();
  const out = render();
  assert.ok(textOf(out).includes('暂不可用'), '缺路由要明说：' + textOf(out));
  assert.ok(!textOf(out).includes('恢复默认价格'), '不可用态不给恢复按钮');
  assert.equal(posts.length, 0);
});

test('price.editor：GET 响应体不是 {ok:true,records} 时按暂不可用处理', async () => {
  const runtime = makeRuntime();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, unexpected: true }) });
  const { render } = makeEditor(runtime);
  await flush();
  const out = render();
  assert.ok(textOf(out).includes('暂不可用'), '畸形响应按暂不可用：' + textOf(out));
});

test('price.editor：词典键在 ZH/EN 同步存在，且没有撞 price.input / credit.* / credits.*', () => {
  const ZH = stubInternals.ZH;
  const EN = stubInternals.EN;
  const newKeys = Object.keys(ZH).filter((k) => k.startsWith('price.editor.') || k.startsWith('price.notice.') || k.startsWith('price.error.'));
  // 砍掉了「编辑/保存/取消」等按钮文案后键数变少了——这里钉的是「成批存在」
  // 这个性质，不是某个具体数字。
  assert.ok(newKeys.length >= 25, '新键应成批存在，实际 ' + newKeys.length);
  for (const k of newKeys) {
    assert.ok(EN[k] !== undefined, `${k} 在 EN 词典缺失`);
    assert.ok(!k.startsWith('credit.'), '新键不得用 credit.* 前缀');
    assert.ok(!k.startsWith('credits.'), '新键不得复活 credits.* 前缀');
    assert.ok(!['price.input', 'price.output', 'price.cache', 'price.perMillion'].includes(k), '新键不得覆盖用量页的 price.* 列名');
  }
  // 上一轮删设置页时把 credits.*（复数）删了：确认它没有回来。
  assert.equal(Object.keys(ZH).some((k) => k.startsWith('credits.')), false);
  // 砍掉的按钮文案键不该再留着（没人用了）。
  for (const gone of ['price.editor.edit', 'price.editor.save', 'price.editor.actions', 'price.editor.peakDiffers', 'price.editor.manualFrom', 'price.editor.mirrorOf', 'price.editor.free', 'price.editor.uniform']) {
    assert.equal(ZH[gone], undefined, `${gone} 应当已删除`);
    assert.equal(EN[gone], undefined, `${gone} 应当已删除（EN）`);
  }
});

test('price.editor：UsageConfigSection 在采集频率之后渲染单价块', async () => {
  // 从注册的 settings.section 槽位走一遍完整链路：标题→采集频率→单价。
  const runtime = makeRuntime();
  const mod = loadModule(runtime);
  globalThis.fetch = async () => pricesResponse();
  const registered = {};
  const ctx = {
    get: () => undefined,
    locale: { subscribe: () => () => {}, getSnapshot: () => ({ active: 'zh', locales: [], revision: 0 }), bind: () => (k) => k, register: () => {} },
    remote: { $on: () => () => {} },
    effect: (fn) => { fn(); return () => {}; },
    slots: {
      inject: (_n, fn) => fn(),
      register: (meta, comp) => { registered[meta.name] = comp; },
      entries: () => [],
    },
  };
  mod.apply(ctx);
  const Slot = registered['settings.section'];
  const expand = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(expand);
    if (typeof node.type === 'function') return expand(node.type(node.props));
    return node.children ? { ...node, children: node.children.map(expand) } : node;
  };
  const element = Slot({ t: (k) => k });
  // UsageSettingsSection → UsageConfigSection → CollectIntervalSettings + PriceEditor，
  // 全部是函数组件，expand 到底。
  runtime.render(() => expand(element));
  await flush();
  const out = runtime.render(() => expand(Slot({ t: (k) => k }))).out;
  const text = textOf(out);
  assert.ok(text.includes('collect.title'), '采集频率块在');
  assert.ok(text.includes('price.editor.title'), '单价块在（key 是词典键，fake t 返回原 key）');
  assert.ok(groupRowsOf(out).length > 0, '分组行渲染出来了');
});
