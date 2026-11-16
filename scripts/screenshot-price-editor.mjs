// 截图脚本：在 Node 里用迷你 React 渲染真实的 PriceEditor，把渲染树转成 HTML，
// 再用 Chrome 无头模式截图。
//
// 为什么不在浏览器里直接跑 client.js：client.js 走 DSH 的 __ModuleLoader__ 装载，
// 在浏览器里要重造整个 loader。改走"Node 里渲染 → 序列化 → 静态 HTML → 截图"，
// 画面与真实组件**完全同源**（同一个 lib/client.js、同一份接口数据）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

mkdirSync('docs', { recursive: true });
const source = readFileSync('lib/client.js', 'utf8');

// ---- 迷你 React（与测试同一份）----
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
    useRef: (init) => { const i = cursor++; if (!(i in state)) state[i] = { current: init }; return state[i]; },
    useMemo: (fn, deps) => { const i = cursor++; const prev = state[i]; if (!prev || deps.some((d, k) => !Object.is(d, prev.deps[k]))) state[i] = { deps, value: fn() }; return state[i].value; },
    useCallback: (fn, deps) => { const i = cursor++; const prev = state[i]; if (!prev || deps.some((d, k) => !Object.is(d, prev.deps[k]))) state[i] = { deps, fn }; return state[i].fn; },
    useEffect: (fn, deps) => { const i = cursor++; const prev = state[i]; if (!prev || deps.some((d, k) => !Object.is(d, prev.deps[k]))) { state[i] = { deps }; effects.push({ fn, i }); } },
    useSyncExternalStore: (_sub, snap) => snap(),
  };
  return {
    react,
    render(fn) { cursor = 0; const out = fn(); for (const e of effects.splice(0, effects.length)) e.fn(); return out; },
  };
}

const runtime = makeRuntime();
const win = { __ModuleLoader__: { load: (def) => { win.__def = def; } } };
new Function('window', 'require', source)(win, (id) => (id === 'react' ? runtime.react : {}));
const internals = win.__def.factory((id) => (id === 'react' ? runtime.react : {})).__internals;

// ---- 接口数据（与测试同一种子）----
const seedRows = [
  { provider: 'trae', model: 'DeepSeek-V4-Flash-Official', displayName: 'DeepSeek V4 Flash Official（对应官方 deepseek-flash 价）', currency: 'CNY', source: 'official-doc', asOf: '2026-09-10', mirrors: 'deepseek-official/deepseek-flash', input: { standard: 2, offPeak: 1 }, output: { standard: 8, offPeak: 4 }, cacheRead: { standard: 0.04, offPeak: 0.02 } },
  { provider: 'trae', model: 'glm-5.2', displayName: 'GLM-5.2（对应 Z.ai 官方价）', currency: 'CNY', source: 'official-doc', asOf: '2026-10-27', input: { standard: 1.4 }, output: { standard: 4.4 }, cacheRead: { standard: 0.26 } },
  { provider: 'trae', model: 'kimi-k3', displayName: 'Kimi K3（对应 Moonshot 官方价）', currency: 'USD', source: 'official-doc', asOf: '2026-10-27', input: { standard: 3 }, output: { standard: 15 }, cacheRead: { standard: 0.3 } },
  { provider: 'qoder', model: 'gmodel', displayName: 'GLM-5.3（对应 Z.ai 官方价）', currency: 'CNY', source: 'official-doc', asOf: '2026-10-27', input: { standard: 1.4 }, output: { standard: 4.4 }, cacheRead: { standard: 0.26 } },
  { provider: 'raccoon', model: 'sn-glm-5-3-flash', displayName: 'GLM-5-3-Flash · x0.2→x0.1', currency: 'CNY', source: 'name-suffix', asOf: '2026-11-14', uniform: 0.1 },
  { provider: 'raccoon', model: 'sn-sensenova-6-8-flash', displayName: 'SenseNova-6.8-Flash · 免费', currency: 'CNY', source: 'free', asOf: '2026-11-14', free: true },
  { provider: 'moonshotai', model: 'kimi-k3', displayName: 'kimi-k3', currency: 'USD', source: 'official-doc', asOf: '2026-10-27', input: { standard: 2 }, output: { standard: 10 }, cacheRead: { standard: 0.2 } },
  { provider: 'moonshotai', model: 'kimi-k2.6', displayName: 'kimi-k2.6', currency: 'USD', source: 'manual', asOf: '2026-11-14', seedSource: 'official-doc', seedAsOf: '2026-10-27', input: { standard: 0.5 }, output: { standard: 2 }, cacheRead: { standard: 0.1 } },
];

globalThis.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({ ok: true, records: seedRows, problems: [] }),
});

const t = (k) => internals.ZH[k] ?? k;

// ---- 渲染 ----
const renderTree = (root) => {
  const expand = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(expand);
    if (typeof node.type === 'function') return expand(node.type(node.props));
    return node.children ? { ...node, children: node.children.map(expand) } : node;
  };
  return expand(root);
};

const out = runtime.render(() => renderTree(internals.PriceEditor({ t, lang: 'zh' })));
await new Promise((r) => setTimeout(r, 30));
const tree = runtime.render(() => renderTree(internals.PriceEditor({ t, lang: 'zh' })));

// ---- 渲染树 → HTML ----
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function styleToCss(style) {
  if (!style || typeof style !== 'object') return '';
  return Object.entries(style).map(([k, v]) => {
    if (v === null || v === undefined) return '';
    const prop = k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
    return `${prop}:${v};`;
  }).join('');
}

function toHtml(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return esc(node);
  if (Array.isArray(node)) return node.map(toHtml).join('');
  if (typeof node.type !== 'string') return (node.children ?? []).map(toHtml).join('');
  const { type, props = {}, children = [] } = node;
  const attrs = [];
  if (props.style) attrs.push(`style="${esc(styleToCss(props.style))}"`);
  if (props.role) attrs.push(`role="${esc(props.role)}"`);
  if (props['data-group']) attrs.push(`data-group="${esc(props['data-group'])}"`);
  if (props['data-badge']) attrs.push(`data-badge="${esc(props['data-badge'])}"`);
  if (props.title) attrs.push(`title="${esc(props.title)}"`);
  if (props.placeholder) attrs.push(`placeholder="${esc(props.placeholder)}"`);
  if (props.type === 'search' || props.type === 'text') {
    attrs.push(`type="${esc(props.type)}"`);
    attrs.push(`value="${esc(props.value ?? '')}"`);
  }
  if (props.colSpan) attrs.push(`colspan="${props.colSpan}"`);
  const inner = children.map(toHtml).join('');
  if (inner === '' && (type === 'input' || type === 'button')) return `<${type} ${attrs.join(' ')}></${type}>`;
  return `<${type} ${attrs.join(' ')}>${inner}</${type}>`;
}

const body = toHtml(tree);

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<style>
  body { margin:0; background:#f6f7f9; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color:#1a1a1a; }
  .page { max-width: 760px; margin: 0 auto; padding: 28px 24px 40px; }
  .card { background:#fff; border:1px solid rgba(127,127,127,.28); border-radius: 10px; padding: 18px 20px; }
  table { width:100%; border-collapse: collapse; }
  th { border-bottom:1px solid rgba(127,127,127,.22); }
  tr[data-group] td { border-bottom:1px solid rgba(127,127,127,.14); }
  input, button { font-family: inherit; }
</style></head>
<body><div class="page">
  <h2 style="font-size:18px;line-height:26px;margin:0 0 8px">DeepSeek 用量</h2>
  <p style="margin:0 0 16px;font-size:13px;line-height:20px;color:rgba(0,0,0,.45)">改这里的价格，统计金额立即按新价计算（无需重启）。</p>
  <div class="card">${body}</div>
</div></body></html>`;

const tmpHtml = 'docs/_price-editor-preview.html';
writeFileSync(tmpHtml, html, { encoding: 'utf8' });
console.log(`已写 ${tmpHtml}`);

// ---- Chrome 无头截图 ----
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const fileUrl = `file:///${tmpHtml.replace(/\\/g, '/')}`;
const outAbs = `${process.cwd()}\\docs\\price-editor.png`;
const res = spawnSync(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--force-device-scale-factor=2', '--window-size=820,900',
  `--screenshot=${outAbs}`, fileUrl,
], { encoding: 'utf8' });
console.log('chrome exit:', res.status);
if (res.status !== 0) console.log((res.stderr ?? '').slice(0, 800));
console.log('截图:', outAbs);
