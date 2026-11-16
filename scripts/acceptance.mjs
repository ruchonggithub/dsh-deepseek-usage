#!/usr/bin/env node
/**
 * 验收脚本：把 ACCEPTANCE.md 的判据变成可执行断言。
 *
 * 与上一版的根本区别：**这一版不看代码长什么样，只看行为对不对。**
 *
 *   ❌ 旧写法：`expect(source.includes('creditRowOf'))` —— 检查实现里有没有某个函数名。
 *      这种断言有两个致命问题：换个写法就误报失败（哪怕行为完全正确），
 *      而实现里留个同名空函数就能骗过（哪怕功能没做）。它测的是代码的倒影，不是需求。
 *
 *   ✅ 新写法：喂输入 → 读输出 → 判行为。卡片给定"宿主说不支持 trae + 快照里有 trae 积分"，
 *      断言渲染结果里出现积分数字、不出现"不支持"。实现怎么写的，与本条无关。
 *
 * 三态：通过 / 失败 / 未实现。**未实现不是通过**——模块没交付时必须显式报出来。
 *
 * 用法：
 *   node scripts/acceptance.mjs              # 全部
 *   node scripts/acceptance.mjs --only=A,B   # 按 ACCEPTANCE.md 的编号
 *   node scripts/acceptance.mjs --json       # 机器可读
 *
 * 退出码：0 = 全通过；1 = 有失败或未实现；2 = 脚本自身出错。
 */

import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import zlib from 'node:zlib';
import { registerHooks } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── 结果收集 ───────────────────────────────────────────────────────────

const PASS = 'pass';
const FAIL = 'fail';
const MISSING = 'missing';

/** @type {{ id: string, name: string, state: string, detail: string }[]} */
const results = [];

function record(id, name, state, detail = '') {
  results.push({ id, name, state, detail });
  return state;
}

/**
 * 跑一条判据。抛错 = 失败；模块不存在 = 未实现。
 *
 * @param {string} id ACCEPTANCE.md 里的编号（如 'A1'）
 * @param {string} name 用户视角的一句话
 * @param {Function} fn 断言体
 */
async function claim(id, name, fn) {
  try {
    const outcome = await fn();
    if (outcome === MISSING) return record(id, name, MISSING, '被测模块尚未交付');
    if (outcome === false) return record(id, name, FAIL, '返回 false');
    return record(id, name, PASS);
  } catch (error) {
    if (error && (error.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/.test(String(error.message)))) {
      return record(id, name, MISSING, String(error.message).split('\n')[0]);
    }
    if (error && error.code === 'ACCEPTANCE_MISSING') {
      return record(id, name, MISSING, error.message);
    }
    return record(id, name, FAIL, error instanceof Error ? error.message : String(error));
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function missing(message) {
  const error = new Error(message);
  error.code = 'ACCEPTANCE_MISSING';
  return error;
}

async function load(rel) {
  const full = join(ROOT, rel);
  if (!existsSync(full)) throw missing(`模块未交付：${rel}`);
  return import(new URL(`file://${full.replace(/\\/g, '/')}`).href);
}

// ── 迷你 React：用来真的渲染卡片，而不是读源码 ──────────────────────────
//
// 验收要判"用户看到什么"，就必须真的把组件跑一遍。这个迷你渲染器只实现本插件
// 用到的部分（createElement / useState / useEffect / useRef / useMemo /
// useSyncExternalStore），足以把 UsageCell 渲染成可遍历的树。

function makeRenderer() {
  const hooks = [];
  let cursor = 0;
  let pending = [];

  const react = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    }),
    useState: (initial) => {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial;
      const set = (next) => {
        hooks[i] = typeof next === 'function' ? next(hooks[i]) : next;
      };
      return [hooks[i], set];
    },
    useEffect: (fn) => { pending.push(fn); },
    useLayoutEffect: (fn) => { pending.push(fn); },
    useRef: (initial) => {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = { current: initial };
      return hooks[i];
    },
    useMemo: (fn) => {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = fn();
      return hooks[i];
    },
    useCallback: (fn) => {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = fn;
      return hooks[i];
    },
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  };

  function render(root) {
    cursor = 0;
    pending = [];
    const expand = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return node;
      if (Array.isArray(node)) return node.map(expand);
      if (typeof node.type === 'function') return expand(node.type(node.props));
      return node.children ? { ...node, children: node.children.map(expand) } : node;
    };
    const out = expand(root);
    const effects = pending;
    pending = [];
    for (const fn of effects) {
      try { fn(); } catch { /* effect 失败不影响渲染结果 */ }
    }
    return out;
  }

  return { react, render };
}

/** 把渲染树里的所有文本拼起来（验收断言"用户看到什么"）。 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && Array.isArray(node.children)) return node.children.map(textOf).join('');
  return '';
}

/** 收集树里所有 title（悬浮说明也是用户可见文本）。 */
function titlesOf(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) titlesOf(child, out); return out; }
  if (node.props && typeof node.props.title === 'string') out.push(node.props.title);
  if (Array.isArray(node.children)) for (const child of node.children) titlesOf(child, out);
  return out;
}

/** 收集每段文本对应的样式（判字号/溢出这类视觉问题）。 */
function stylesOf(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) stylesOf(child, out); return out; }
  if (node.props && node.props.style) out.push({ text: textOf(node), style: node.props.style });
  if (Array.isArray(node.children)) for (const child of node.children) stylesOf(child, out);
  return out;
}

/** 收集树里所有节点的 type（判"是不是有输入框/表格"之类）。 */
function nodesOf(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) nodesOf(child, out); return out; }
  out.push(node);
  if (Array.isArray(node.children)) for (const child of node.children) nodesOf(child, out);
  return out;
}

/** 让已排队的 Promise 链跑完（不 sleep，只让微任务与一次宏任务完成）。 */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── 加载客户端（真的跑 client.js）───────────────────────────────────────
//
// client.js 是给浏览器模块表用的惰性工厂（`window.__ModuleLoader__.load`）。
// 这里用一个最小的 window 骗它注册，再取出工厂自己调用，得到真正的组件。

function loadClient() {
  const source = readFileSync(join(ROOT, 'lib/client.js'), 'utf8');
  const { react, render } = makeRenderer();
  const win = { __ModuleLoader__: { load: (def) => { win.__def = def; } } };
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', source)(win, (id) => (id === 'react' ? react : {}));
  const mod = win.__def.factory((id) => (id === 'react' ? react : {}));
  const slots = {};
  // 记录每个槽位注册的选项与组件，供断言"是否注册"与"渲染出什么"。
  const ctx = {
    get: () => undefined,
    locale: {
      subscribe: () => () => {},
      getSnapshot: () => ({ active: 'zh', locales: [], revision: 0 }),
      bind: () => (key) => key,
      register: () => {},
    },
    remote: { $on: () => () => {} },
    effect: (fn) => { fn(); return () => {}; },
    slots: {
      inject: (_name, fn) => fn(),
      register: (meta, comp) => { slots[meta.name] = { meta, comp }; },
      entries: () => [],
    },
  };
  mod.apply(ctx);
  return { mod, slots, render, react };
}

/**
 * 渲染侧边栏卡片，返回渲染结果。
 *
 * 卡片组件在 apply 时被注册进 `sidebar.footer.action` 槽位，注册的是一个
 * 包装函数（接收 props 返回元素）。这里直接调用它再展开，与浏览器里一致。
 */
async function renderCard(fetchImpl, props = { wide: true }) {
  const { slots, render } = loadClient();
  const entry = slots['sidebar.footer.action'];
  expect(entry !== undefined, '卡片没有注册到 sidebar.footer.action 槽位');
  globalThis.fetch = fetchImpl;
  const element = entry.comp({ wide: props.wide !== false, ctx: undefined });
  const out = render(element);
  await flush();
  return render(element);
}

// ── A. 侧边栏卡片 ──────────────────────────────────────────────────────

/** 造一个"宿主说不支持 + 快照里有该渠道积分"的 fetch。 */
function fetchWithCredit({ providerId, creditRow, errors }) {
  return async (url) => {
    const target = String(url);
    if (target.includes('/snapshot')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          snapshots: {
            credits: {
              value: { available: true, channels: creditRow === null ? [] : [creditRow] },
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
        provider: { id: providerId, displayName: providerId, kind: 'none', reason: 'unsupported', via: 'none' },
        balance: { isAvailable: null, total: null, currency: null },
        usage: null,
        tier: { input: null, cacheRead: null, cacheWrite: null, output: null, known: false, currency: 'CNY', window: null },
        next: { peak: false, at: null, ms: 0 },
        peak: false,
        errors,
      }),
    };
  };
}

async function groupA() {
  // A1：积分渠道不该显示「不支持」
  await claim('A1', '积分渠道显示积分而不是「不支持」', async () => {
    const out = await renderCard(fetchWithCredit({
      providerId: 'trae',
      creditRow: { channel: 'trae', state: 'ok', remaining: 5551.0312, total: 7400, percent: 75, unit: 'credits' },
      errors: ['This plugin does not support trae'],
    }));
    const text = textOf(out);
    expect(!/does not support|不支持/i.test(text) || !/trae/i.test(text),
      `不得显示「不支持」，实际：${text}`);
    expect(!/does not support/i.test(text), `不得显示英文「does not support」，实际：${text}`);
    // 必须有数字：剩余与总额都要能看到
    expect(/5[0-9]{2,4}/.test(text) || /5\.\dK/.test(text), `应显示剩余积分，实际：${text}`);
    return true;
  });

  // A1 反向：没有积分数据时必须诚实
  await claim('A1b', '没有积分数据时如实说明原因', async () => {
    const out = await renderCard(fetchWithCredit({
      providerId: 'mystery-gateway',
      creditRow: null,
      errors: ['当前插件不支持 mystery-gateway'],
    }));
    const text = textOf(out);
    expect(/mystery-gateway/.test(text), `应指出是哪个渠道查不到，实际：${text}`);
    return true;
  });

  // A2：大数字必须紧凑，且字号不得撑破侧边栏
  await claim('A2', '大数字走紧凑写法，且主数值字号不溢出侧边栏', async () => {
    const out = await renderCard(fetchWithCredit({
      providerId: 'zcode',
      creditRow: { channel: 'zcode', state: 'ok', remaining: 16000000, total: 16000000, percent: 100, unit: 'token' },
      errors: [],
    }));
    const text = textOf(out);
    // 16000000 必须被缩写，原始 8 位数字不得直接出现
    expect(!/16000000/.test(text), `1600 万不得原样渲染成 16000000，实际：${text}`);
    // 只判"被缩写了 + 用了中文量级"，不钉死具体写法。
    // 上一版写成 /16(\.\d)?\s*[MK万]/ —— 它只能匹配 `16.0M` / `16M`；而规格要求的中文
    // 写法 `1600 万` 里 16 后面跟的是 00，`[MK万]` 永远轮不到，于是"照规格做反而必红、
    // 要过只能输出英文"，与 A3 直接冲突。**断言不能比需求更窄**，这是验收脚本自己的 bug。
    expect(/[万亿]/.test(text), `应使用中文量级（万 / 亿），实际：${text}`);
    // 字号：这是用户报的"文字太大超出展示区"。侧边栏可用宽度约 200px，
    // 主数值字号超过 16px 时，"5487.64 / 7400 credits" 这种长串必然溢出。
    const big = stylesOf(out).filter(({ style }) => {
      const size = Number.parseInt(String(style.fontSize ?? ''), 10);
      return Number.isFinite(size) && size > 16;
    });
    const oversized = big.filter(({ text: t }) => t.length > 3);
    expect(oversized.length === 0,
      `主数值字号过大（>16px）会溢出侧边栏，实测：${oversized.map((o) => `"${o.text}"@${o.style.fontSize}`).join('、')}`);
    return true;
  });

  // A3：中文界面不得出现英文
  await claim('A3', '中文界面所有用户可见文本为中文', async () => {
    const out = await renderCard(fetchWithCredit({
      providerId: 'trae',
      creditRow: { channel: 'trae', state: 'ok', remaining: 5487.6376, total: 7400, percent: 74.2, unit: 'credits' },
      errors: [],
    }));
    const visible = textOf(out) + ' ' + titlesOf(out).join(' ');

    // 关键：不能用 \b 词边界判英文单词。
    // 实测踩过：`credits5487.64` 里 `s` 与 `5` 都是单词字符，`\bcredits?\b` 匹配不到，
    // 于是明明界面上写着 "credits"，断言却通过了——这就是"验收假绿"。
    // 改成：任何长度 ≥ 3 的英文单词（允许被数字紧邻）都算英文泄漏。
    const englishWords = visible.match(/[A-Za-z]{3,}/g) ?? [];
    // 专有名词白名单：厂商名、模型 id 是原名，不算"写英文"。
    const proper = new Set([
      'trae', 'buddy', 'qoder', 'qodercn', 'zcode', 'raccoon', 'lobsterai', 'minimax',
      'cline', 'loomy', 'codearts', 'gemini', 'workbuddy', 'officeace', 'accio', 'codebuddy',
      'deepseek', 'flash', 'pro', 'chat', 'reasoner', 'gpt', 'sol', 'kimi', 'moonshot',
      'zai', 'glm', 'openrouter', 'anthropic', 'claude', 'codex', 'openai', 'opencode',
      'oauth', 'api', 'key', 'dsh',
    ]);
    const leaked = englishWords.filter((word) => !proper.has(word.toLowerCase()));
    expect(leaked.length === 0, `界面出现英文：${[...new Set(leaked)].join('、')}（完整文本：${visible}）`);
    return true;
  });

  // A4：卡片只有一种交互——点击刷新
  await claim('A4', '点击卡片触发一次取数（唯一交互）', async () => {
    let usageCalls = 0;
    const fetchImpl = fetchWithCredit({
      providerId: 'trae',
      creditRow: { channel: 'trae', state: 'ok', remaining: 100, total: 200, percent: 50, unit: 'credits' },
      errors: [],
    });
    const counting = async (url) => {
      if (String(url).startsWith('/api/quota-usage?')) usageCalls += 1;
      return fetchImpl(url);
    };
    // 用一个能拿到 onClick 的渲染：卡片根节点带 onClick。
    const { slots, render } = loadClient();
    const entry = slots['sidebar.footer.action'];
    globalThis.fetch = counting;
    const element = entry.comp({ wide: true, ctx: undefined });
    render(element);
    await flush();
    const out = render(element);
    const clickable = nodesOf(out).filter((n) => n.props && typeof n.props.onClick === 'function');
    expect(clickable.length > 0, '卡片必须可点击');
    // 对齐 OFM 之后，头部点击是**展开/折叠**，刷新是底部单独一个入口。
    // 所以这里不再要求"点击就取数"，而是要求"界面上存在一个能触发刷新的入口"。
    // 原断言（点击任一处必发请求）与 G7 直接冲突，是旧设计遗留的过时判据。
    const before = usageCalls;
    // 找刷新入口：优先按文案匹配，退而求其次找除头部之外的 onClick。
    const refreshish = clickable.filter((n) => {
      const label = textOf(n);
      return /刷新|refresh/i.test(label);
    });
    if (refreshish.length > 0) {
      refreshish[refreshish.length - 1].props.onClick();
    } else {
      // 没有明确文案时，依次尝试每个 onClick，只要有一个触发取数即算通过。
      for (const node of clickable) {
        try { node.props.onClick(); } catch { /* 单个入口失败不影响判定 */ }
      }
    }
    await flush();
    expect(usageCalls > before,
      `界面上必须有能触发刷新的入口，实际点击后仍为 ${usageCalls} 次（点击前 ${before}）`);
    return true;
  });
}

// ── B. 用量统计 ────────────────────────────────────────────────────────

async function groupB() {
  const cost = await load('lib/cost.js');
  const usage = await load('lib/usage.js');

  // 造一段会话语料
  const events = [
    { type: 'assistant/message', time: 1000, data: { message: { id: 'a', source: { provider: 'deepseek-official', model: 'deepseek-flash' } }, usage: { inputTokens: 1000000, outputTokens: 500000, totalTokens: 1500000 } } },
    { type: 'assistant/message', time: 2000, data: { message: { id: 'b', source: { provider: 'deepseek-official', model: 'deepseek-flash' } }, usage: { inputTokens: 500000, outputTokens: 200000, totalTokens: 700000 } } },
  ];
  const summary = usage.summarize(events);

  await claim('B1', '按三大类型 → 厂商 → 模型分层，且三层数字自洽', () => {
    expect(Array.isArray(summary.kinds) && summary.kinds.length > 0, '应产出计费类型分组');
    const prepaid = summary.kinds.find((k) => k.kind === 'prepaid');
    expect(prepaid !== undefined, '应识别出预充值型');
    expect(Array.isArray(prepaid.providers) && prepaid.providers.length > 0, '类型下应有厂商');
    const provider = prepaid.providers[0];
    expect(Array.isArray(provider.models) && provider.models.length > 0, '厂商下应有模型');
    // 自洽：模型 total 之和 = 厂商 total
    const sum = provider.models.reduce((acc, m) => acc + m.totalTokens, 0);
    expect(sum === provider.totalTokens || Math.abs(sum - provider.totalTokens) < 1,
      `模型之和 ${sum} 应等于厂商 ${provider.totalTokens}`);
    return true;
  });

  await claim('B2', '模型/厂商/类型三级都有单价与金额', () => {
    const withCost = cost.costOfSummary(summary.kinds.find((k) => k.kind === 'prepaid'), Date.now());
    expect(withCost !== null, 'costOfSummary 应返回结果');
    // 模型级：单价 + 金额
    const model = withCost.providers[0].models[0];
    expect(model.cost !== undefined, '模型应有 cost');
    expect(model.cost.prices !== undefined && model.cost.prices.input !== undefined,
      `模型应有单价 prices.input，实际 ${JSON.stringify(model.cost.prices)}`);
    expect(model.cost.cost !== undefined && typeof model.cost.cost.total === 'number',
      `模型应有金额 cost.total，实际 ${JSON.stringify(model.cost.cost)}`);
    // 厂商级
    expect(withCost.providers[0].cost !== undefined, '厂商应有 cost');
    expect(withCost.providers[0].cost.amounts !== undefined, '厂商应有金额合计');
    // 类型级
    expect(withCost.cost !== undefined, '类型应有 cost');
    expect(withCost.cost.amounts !== undefined, '类型应有金额合计');
    return true;
  });

  await claim('B3', '预充值型给真实金额并带快照日期', () => {
    const withCost = cost.costOfSummary(summary.kinds.find((k) => k.kind === 'prepaid'), Date.now());
    expect(withCost.cost.currency === 'CNY' || withCost.cost.currency === 'USD',
      `预充值型应为真实币种，实际 ${withCost.cost.currency}`);
    expect(typeof withCost.cost.amounts.total === 'number', '应有总额数字');
    expect(typeof withCost.cost.asOf === 'string' && withCost.cost.asOf !== '',
      `应给出价格快照日期，实际 ${withCost.cost.asOf}`);
    return true;
  });

  await claim('B3b', '积分型不得显示成 ¥0（必须标明按积分计费）', () => {
    // ⚠️ 样本必须是**真的查不到价**的模型。
    // 原来用的是 `trae` + `deepseek-v4.1-flash`，但该模型已按官方价登记为镜像记录
    // （见 lib/price-table.js 的 V4.1 Flash 别名组），现在能算出 ¥ 金额——拿它当
    // "积分型无价"的样本等于拿有价的东西验无价的规则，属假绿。
    // 改用表里不存在的 `kimi-k9-ultra`：trae 在 pricing.js 里没有快照、新表也没有这个
    // 模型 → 仍是 credit，判据的意图（无价渠道不得显示 ¥0）不变。
    const creditsEvents = [
      { type: 'assistant/message', time: 1000, data: { message: { id: 'c', source: { provider: 'trae', model: 'kimi-k9-ultra' } }, usage: { inputTokens: 1000, totalTokens: 1000 } } },
    ];
    const s = usage.summarize(creditsEvents);
    const withCost = cost.costOfSummary(s.kinds[0], Date.now());

    // 这条判据要同时钉住两件事，缺一不可：
    //   1. currency 必须明确是 'credit'（告诉界面"按积分计费"）；
    //   2. 不得给出可当成真钱的金额。
    //
    // 上一版写成 `amounts === null || currency === 'credit'` —— 用的是**或**。
    // 注入测试发现的漏洞：把 currency 改成 'CNY'（把积分伪装成人民币）后，
    // amounts 仍是 null，第一条就成立，判据照样通过 —— 假绿。
    // 必须两者都验，而不是任一成立就放行。
    expect(withCost.cost.currency === 'credit',
      `积分型的 currency 必须是 credit（按积分计费），实际 ${withCost.cost.currency}`);
    expect(withCost.cost.priced === false,
      `积分型不按钱算，priced 必须为 false，实际 ${withCost.cost.priced}`);
    const amounts = withCost.cost.amounts;
    expect(amounts === null || amounts === undefined,
      `积分型不得给出货币金额（会被显示成 ¥0.00），实际 ${JSON.stringify(amounts)}`);
    return true;
  });

  await claim('B4', '工作区维度可统计，且同一会话不重复计入两个工作区', async () => {
    const ws = await load('lib/workspaces.js');
    const usage = await load('lib/usage.js');
    const home = mkdtempSync(join(tmpdir(), 'acc-ws-'));
    try {
      // 造两个工作区，各一个会话
      const sessionsRoot = join(home, 'sessions');
      const mkSession = (slug, sid, tokens) => {
        const dir = join(sessionsRoot, slug, sid);
        mkdirSync(dir, { recursive: true });
        const line = JSON.stringify({
          type: 'assistant/message', time: 1000,
          data: { message: { id: sid, source: { provider: 'trae', model: 'm' } }, usage: { inputTokens: tokens, totalTokens: tokens } },
        });
        writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(line, 'utf8')));
      };
      mkSession('--ws-a--', 'session-aaa', 100);
      mkSession('--ws-b--', 'session-bbb', 900);

      const storages = join(home, 'storages');
      mkdirSync(storages, { recursive: true });
      writeFileSync(join(storages, 'workspace.json'), JSON.stringify({
        global: { defaultWorkspaceId: 'w1', workspaceIds: ['w1', 'w2'], archivedSessionIds: [], pinnedSessionIds: [] },
        tables: {
          workspaces: {
            w1: { path: 'F:\\a', title: '工作区甲', sessionIds: ['session-aaa'], createdAt: '', updatedAt: '' },
            w2: { path: 'F:\\b', title: '工作区乙', sessionIds: ['session-bbb'], createdAt: '', updatedAt: '' },
          },
        },
      }));

      const scanner = usage.createUsageScanner({ home });
      const rows = await ws.scanWorkspaces({ home, scanner });
      expect(Array.isArray(rows) && rows.length === 2, `应返回 2 个工作区，实际 ${rows?.length}`);
      const a = rows.find((r) => r.title === '工作区甲');
      const b = rows.find((r) => r.title === '工作区乙');
      expect(a !== undefined && b !== undefined, '两个工作区都应出现');
      expect(a.totals.totalTokens === 100, `工作区甲的 token 应为 100，实际 ${a.totals.totalTokens}`);
      expect(b.totals.totalTokens === 900, `工作区乙的 token 应为 900，实际 ${b.totals.totalTokens}`);
      // 不重复：两个工作区之和 = 全机
      const all = await scanner.scan();
      expect(a.totals.totalTokens + b.totals.totalTokens === all.kinds[0].totalTokens,
        `工作区之和 ${a.totals.totalTokens + b.totals.totalTokens} 应等于全机 ${all.kinds[0].totalTokens}（同一会话不得重复计入）`);
      return true;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  await claim('B5', '会话内视图只统计当前会话', async () => {
    const home = mkdtempSync(join(tmpdir(), 'acc-'));
    try {
      const mk = (sid, tokens) => {
        const dir = join(home, 'sessions', '--ws--', sid);
        mkdirSync(dir, { recursive: true });
        const line = JSON.stringify({
          type: 'assistant/message', time: 1000,
          data: { message: { id: sid, source: { provider: 'trae', model: 'm' } }, usage: { inputTokens: tokens, totalTokens: tokens } },
        });
        writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(line, 'utf8')));
      };
      mk('session-aaa', 100);
      mk('session-bbb', 900);
      const scanner = usage.createUsageScanner({ home });
      const one = await scanner.scanSession('session-aaa');
      expect(one.messages === 1, `单会话应只统计 1 条，实际 ${one.messages}`);
      expect(one.kinds[0].totalTokens === 100, `单会话 token 应为 100，实际 ${one.kinds[0].totalTokens}`);
      const all = await scanner.scan();
      expect(all.messages === 2, `全机应统计 2 条，实际 ${all.messages}`);
      return true;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

// ── C. 积分查询 ────────────────────────────────────────────────────────

async function groupC() {
  const mod = await load('lib/channel-credits.js');

  await claim('C1', '能拿到真实的剩余/总额/百分比', () => {
    const row = mod.normalizeChannelCredits('trae', {
      accounts: [{ accountId: 'a', nickname: 'n', balance: { total: 7400, packages: [{ total: 7400, used: 1850, remaining: 7400, active: true, unit: 'credit' }] } }],
    }, Date.now());
    expect(row.state === 'ok', `应识别为成功，实际 ${row.state}`);
    expect(typeof row.remaining === 'number', '应有剩余');
    expect(typeof row.total === 'number', '应有总额');
    expect(typeof row.percent === 'number', '应有百分比');
    return true;
  });

  await claim('C2', '百分比口径正确且不编造 100%', () => {
    const row = mod.normalizeChannelCredits('codearts', {
      accounts: [{ accountId: 'a', nickname: 'n', balance: { total: 7150.69, packages: [{ total: 7500, used: 349.31, remaining: 7150.69, active: true, unit: 'credit' }] } }],
    }, Date.now());
    expect(Math.abs(row.percent - 95.3) < 0.3, `应为 95.3%，实际 ${row.percent}`);
    // 无明细时不得给百分比
    const noDetail = mod.normalizeChannelCredits('weird', {
      accounts: [{ accountId: 'a', nickname: 'n', balance: { total: 500, packages: [] } }],
    }, Date.now());
    expect(noDetail.percent === undefined, `无明细时不得给百分比，实际 ${noDetail.percent}`);
    return true;
  });

  await claim('C3', '单账号失败不污染同渠道其它账号', () => {
    const row = mod.normalizeChannelCredits('trae', {
      accounts: [
        { accountId: 'a', nickname: 'n1', balance: null, error: 'expired' },
        { accountId: 'b', nickname: 'n2', balance: { total: 100, packages: [{ total: 100, used: 0, remaining: 100, active: true, unit: 'credit' }] } },
      ],
    }, Date.now());
    expect(row.remaining === 100, `正常账号的数字应保留，实际 ${row.remaining}`);
    expect(row.error !== undefined, '失败账号的错误应被记录');
    return true;
  });
}

// ── D. 订阅余量 ────────────────────────────────────────────────────────

async function groupD() {
  const mod = await load('lib/subscription.js');

  await claim('D1', '两种模式可选，非法值回退 independent', () => {
    expect(mod.resolveSubscriptionMode({}) === 'independent', '缺配置应回退 independent');
    expect(mod.resolveSubscriptionMode({ subscriptionMode: 'nonsense' }) === 'independent', '非法值应回退');
    expect(mod.resolveSubscriptionMode({ subscriptionMode: 'plugin' }) === 'plugin', 'plugin 应保留');
    return true;
  });

  await claim('D2', 'plugin 模式不可用时明确报错且不回退', async () => {
    const out = await mod.readSubscriptionUsage({ mode: 'plugin', ctx: { get: () => undefined }, provider: 'openai-codex' });
    expect(out.ok === false, 'ok 必须为 false');
    expect(out.mode === 'plugin', `mode 必须是 plugin，实际 ${out.mode}`);
    expect(typeof out.error === 'string' && out.error !== '', '必须给出 error');
    return true;
  });
}

// ── E. 采集架构 ────────────────────────────────────────────────────────

async function groupE() {
  const mod = await load('lib/collector.js');

  await claim('E1', '读快照是纯内存操作，不触发上游请求', async () => {
    let calls = 0;
    const c = mod.createCollector({ collectors: { credits: async () => { calls += 1; return { n: 1 }; } } });
    await c.collectNow('credits');
    expect(calls === 1, `采集一次应只打一次，实际 ${calls}`);
    // 连续读 20 次快照，不得增加上游调用
    for (let i = 0; i < 20; i += 1) {
      const snap = c.getSnapshot('credits');
      expect(!(snap instanceof Promise), 'getSnapshot 必须同步返回');
    }
    expect(calls === 1, `读快照不得触发采集，实际调用 ${calls} 次`);
    return true;
  });

  await claim('E2', '默认 10 分钟、硬下限 1 分钟、可配', () => {
    expect(mod.DEFAULT_INTERVAL_MS === 600000, `默认应为 10 分钟，实际 ${mod.DEFAULT_INTERVAL_MS}`);
    expect(mod.normalizeInterval(undefined).ms === 600000, '缺配置应为 10 分钟');
    const clamped = mod.normalizeInterval(1000);
    expect(clamped.ms === 60000, `1 秒应夹到 1 分钟，实际 ${clamped.ms}`);
    expect(clamped.clamped === true, '应标记被夹过');
    return true;
  });

  await claim('E3', '失败保留旧值，成功清错误，三类互不影响', async () => {
    let fail = false;
    const c = mod.createCollector({
      collectors: {
        credits: async () => { if (fail) throw new Error('boom'); return { n: 7 }; },
        prepaid: async () => ({ ok: true }),
      },
    });
    await c.collectNow('credits');
    fail = true;
    await c.collectNow('credits');
    const snap = c.getSnapshot('credits');
    expect(snap.value !== null, '失败不得擦掉旧值');
    expect(snap.stale === true, '失败应标过期');
    await c.collectNow('prepaid');
    expect(c.getSnapshot('prepaid').stale === false, '另一类不受影响');
    fail = false;
    await c.collectNow('credits');
    expect(c.getSnapshot('credits').lastError === null, '成功后应清空错误');
    return true;
  });
}

// ── F. 工程底线 ────────────────────────────────────────────────────────

async function groupF() {
  const files = [
    'README.md', 'ACCEPTANCE.md', 'package.json', 'locale/en.json', 'locale/zh.json',
    'lib/index.js', 'lib/client.js', 'lib/usage.js', 'lib/credits.js', 'lib/pricing.js',
    'lib/accounts.js', 'lib/channel-credits.js', 'lib/subscription.js', 'lib/cost.js',
    'lib/workspaces.js', 'lib/collector.js',
  ];

  await claim('F1', '所有文本文件无 BOM、LF 行尾', () => {
    const bad = [];
    for (const rel of files) {
      const full = join(ROOT, rel);
      if (!existsSync(full)) continue;
      const bytes = readFileSync(full);
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bad.push(`${rel} 有 BOM`);
      if (bytes.includes(0x0d)) bad.push(`${rel} 含 CR（CRLF）`);
    }
    expect(bad.length === 0, bad.join('；'));
    return true;
  });

  await claim('F2', '当前运行时的 Node 版本被记录且 ≥ 24', () => {
    const major = Number(process.versions.node.split('.')[0]);
    expect(major >= 24, `Node 版本过低：${process.versions.node}`);
    return true;
  });

  // F3：测试不得用真实 sleep（否则整套测试会慢到没人愿意跑，也会不稳）
  await claim('F3', '测试套件不含真实 sleep，且整体够快', () => {
    const started = Date.now();
    const testDir = join(ROOT, 'test');
    let sleepers = [];
    if (existsSync(testDir)) {
      for (const name of readdirSync(testDir)) {
        if (!name.endsWith('.mjs')) continue;
        const text = readFileSync(join(testDir, name), 'utf8');
        // 找 await new Promise(...setTimeout..., N) 且 N 大于 5ms 的写法
        const matches = [...text.matchAll(/setTimeout\([^)]*,\s*(\d{2,})\s*\)/g)];
        for (const m of matches) {
          const ms = Number(m[1]);
          if (ms >= 10) sleepers.push(`${name}: setTimeout ${ms}ms`);
        }
      }
    }
    expect(sleepers.length === 0, `测试里有真实 sleep：${sleepers.join('、')}`);
    expect(Date.now() - started < 2000, 'F3 自身检查不应耗时过长');
    return true;
  });
}

// ── G. 侧边栏卡片：三大类分区展示 ──────────────────────────────────────

/** 造一个快照：三类各有数据。 */
function fetchThreeKinds({ currentChannel = 'trae', credits = [], prepaid = null, subscription = null } = {}) {
  return async (url) => {
    const target = String(url);
    if (target.includes('/snapshot')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          snapshots: {
            credits: { value: { available: true, channels: credits, currentChannel }, updatedAt: Date.now(), stale: false },
            prepaid: { value: prepaid, updatedAt: Date.now(), stale: false },
            subscription: { value: subscription, updatedAt: Date.now(), stale: false },
          },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        provider: { id: currentChannel, displayName: currentChannel, kind: 'none', reason: 'unsupported', via: 'none' },
        balance: { isAvailable: null, total: null, currency: null },
        usage: null,
        tier: { input: null, cacheRead: null, cacheWrite: null, output: null, known: false, currency: 'CNY', window: null },
        next: { peak: false, at: null, ms: 0 },
        peak: false,
        errors: [],
      }),
    };
  };
}

const SAMPLE_CREDITS = [
  { channel: 'trae', state: 'ok', remaining: 5069.03, total: 7400, percent: 68.5, unit: 'credits' },
  { channel: 'buddy', state: 'ok', remaining: 300, total: 3721, percent: 8.1, unit: 'credits' },
];

// 预充值：宿主已改成数组形状（providers[]），这里用真实结构采样，
// 而不是旧的单条 `{provider, balance}` —— 后者能被"向后兼容"通道兜住，
// 等于判据测不到真实数据路径（成员指出过这一点，属实）。
const SAMPLE_PREPAID = {
  providers: [
    {
      provider: 'openrouter', displayName: 'OpenRouter', kind: 'balance',
      balance: { isAvailable: true, total: 12.5, currency: 'USD', used: 7.5 },
      ok: true, code: null,
    },
  ],
  skipped: [],
  totals: { configured: 1, ok: 1 },
};

const SAMPLE_SUBSCRIPTION = {
  mode: 'plugin',
  primary: 'plugin',
  subscriptions: [
    {
      ok: true, mode: 'plugin', provider: 'openai-codex', displayName: 'OpenAI Codex',
      plan: 'plus', bucketId: 'codex', fetchedAt: Date.now(),
      // 窗口值刻意选成**互不互补**的：若 remaining 恰好等于另一个窗口的 used，
      // 判据在"口径反转"时会误判通过（实测踩过：原样本 20/65/80 的剩余 80/35/20
      // 与已用 20/65/80 有交集，反转后断言照样命中）。
      // 这组 13/47/91 的剩余 87/53/9 与已用值无交集，口径一错必被抓住。
      windows: [
        { key: '5h', percent: 13, resetsAt: null },
        { key: '7d', percent: 47, resetsAt: null },
        { key: '30d', percent: 91, resetsAt: null },
      ],
    },
  ],
  skipped: [],
};

/**
 * 渲染并把卡片摆到指定的展开态。
 *
 * **展开是默认态**（`creditCardOpen = true`）：采集器已经把订阅 / 充值 / 积分三类
 * 采到了，让用户再多点一次才看得见是多余的。
 *
 * 但 `creditCardOpen` 是**模块级开关**，在同一次验收运行里会被前面的用例改掉，
 * 所以这里不能"点一下就当展开/折叠"——那会随上一条用例的残留状态翻转。改成先渲染、
 * 读头部箭头（`▾` 展开 / `▸` 折叠），与目标不一致才点一次，点完再确认。
 */
async function renderG(fetchImpl, { expand = true } = {}) {
  const { slots, render } = loadClient();
  const entry = slots['sidebar.footer.action'];
  expect(entry !== undefined, '卡片未注册');
  globalThis.fetch = fetchImpl;
  const element = entry.comp({ wide: true, ctx: undefined });
  render(element);
  await flush();
  let out = render(element);
  const isOpen = () => textOf(out).includes('▾');
  // 最多点两次：正常情况下一次就到位；两次是给"残留状态与目标只差一次翻转"兜底。
  for (let i = 0; i < 2 && isOpen() !== expand; i += 1) {
    const head = nodesOf(out).filter((n) => n.props && typeof n.props.onClick === 'function' && n.props.role === 'button');
    expect(head.length > 0, '需要 role=button 的头部来切换展开态');
    head[0].props.onClick();
    await flush();
    out = render(element);
  }
  expect(isOpen() === expand, `卡片未能摆到${expand ? '展开' : '折叠'}态：${textOf(out)}`);
  return out;
}

async function groupG() {
  // G1 折叠态一行摘要，无标题
  //
  // 注意：**展开是默认态**（三类数据采集到了就该直接看见）。这条判据考的是"折叠
  // 之后长什么样"，所以显式要求折叠态，而不是依赖默认值。
  await claim('G1', '折叠态是一行摘要，字号 ≤13px，且不显示卡片标题', async () => {
    const out = await renderG(fetchThreeKinds({ credits: SAMPLE_CREDITS }), { expand: false });
    const styled = stylesOf(out).filter(({ text }) => text !== '');
    const bigNumbers = styled.filter(({ text, style }) => {
      const size = Number.parseInt(String(style.fontSize ?? ''), 10);
      return Number.isFinite(size) && size > 13 && /\d/.test(text);
    });
    expect(bigNumbers.length === 0,
      `折叠态不得有大字号数字：${bigNumbers.map((o) => `"${o.text}"@${o.style.fontSize}`).join('、')}`);
    const text = textOf(out);
    for (const title of ['免费渠道积分', 'Free-channel credits']) {
      expect(!text.includes(title), `折叠态不应再显示标题「${title}」，实际：${text}`);
    }
    return true;
  });

  // G2 摘要优先级
  await claim('G2', '摘要优先显示当前会话所用渠道，找不到时不冒充', async () => {
    const out = await renderG(fetchThreeKinds({ currentChannel: 'buddy', credits: SAMPLE_CREDITS }));
    const text = textOf(out);
    expect(/buddy/i.test(text), `应显示当前渠道 buddy，实际：${text}`);
    const ghost = await renderG(fetchThreeKinds({ currentChannel: 'ghost', credits: SAMPLE_CREDITS }));
    const gtext = textOf(ghost);
    expect(/未显示|无数据|读取中/.test(gtext), `当前渠道无数据时应明确说明，实际：${gtext}`);
    return true;
  });

  // G3 三大类分区顺序
  //
  // 原判据用 `text.indexOf('积分')` 定位分区，但折叠摘要里有「… / 7400 积分」这个单位，
  // indexOf 会命中单位而不是分区标题，导致"充值@52 < 积分@18"必红——判据本身有问题。
  // 这里改成按**分区标题节点**定位：分区标题是短文本块，且不带数字。
  await claim('G3', '展开态按 订阅 → 充值 → 积分 分区', async () => {
    const out = await renderG(
      fetchThreeKinds({ credits: SAMPLE_CREDITS, prepaid: SAMPLE_PREPAID, subscription: SAMPLE_SUBSCRIPTION }),
      { expand: true },
    );
    // 收集所有"纯标题"文本（恰好等于分区名，不含数字），按出现顺序排列
    const titles = [];
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const c of node) walk(c); return; }
      const t = textOf(node).trim();
      if (['订阅', '充值', '积分'].includes(t)) titles.push(t);
      if (Array.isArray(node.children)) for (const c of node.children) walk(c);
    };
    walk(out);
    expect(titles.includes('订阅'), `展开态应出现「订阅」分区标题，实际标题：${titles.join(',')} || 全文：${textOf(out)}`);
    expect(titles.includes('充值'), `展开态应出现「充值」分区标题，实际标题：${titles.join(',')}`);
    expect(titles.includes('积分'), `展开态应出现「积分」分区标题，实际标题：${titles.join(',')}`);
    // 顺序：订阅 在 充值 之前，充值 在 积分 之前
    const iSub = titles.indexOf('订阅');
    const iPre = titles.indexOf('充值');
    const iCre = titles.indexOf('积分');
    expect(iSub < iPre, `顺序必须是 订阅 → 充值，实际 ${titles.join(' → ')}`);
    expect(iPre < iCre, `顺序必须是 充值 → 积分，实际 ${titles.join(' → ')}`);
    return true;
  });

  // G3b 空分区不占位
  await claim('G3b', '没有数据的分区不渲染', async () => {
    const out = await renderG(fetchThreeKinds({ credits: SAMPLE_CREDITS }), { expand: true });
    const text = textOf(out);
    expect(!text.includes('订阅'), `没有订阅数据时不应出现「订阅」分区，实际：${text}`);
    expect(text.includes('积分'), `有积分数据时应出现「积分」分区，实际：${text}`);
    return true;
  });

  // G3c 多来源：订阅与充值都必须能渲染多条
  //
  // 用户实际遇到的问题：采集器只查"当前模型那一个提供商"，于是卡片永远只有一类有数据。
  // 修完后宿主返回的是数组（providers[] / subscriptions[]），这里钉住"多条都要渲染"，
  // 防止以后有人图省事退回单条结构。
  await claim('G3c', '订阅与充值分区都能渲染多个来源', async () => {
    const twoPrepaid = {
      providers: [
        { provider: 'deepseek-official', displayName: 'DeepSeek', kind: 'balance',
          balance: { isAvailable: true, total: 6994.47, currency: 'CNY', used: null }, ok: true, code: null },
        { provider: 'openrouter', displayName: 'OpenRouter', kind: 'balance',
          balance: { isAvailable: true, total: 12.5, currency: 'USD', used: 7.5 }, ok: true, code: null },
      ],
      skipped: [], totals: { configured: 2, ok: 2 },
    };
    const twoSubs = {
      mode: 'plugin', primary: 'plugin',
      subscriptions: [
        { ok: true, mode: 'plugin', provider: 'openai-codex', displayName: 'OpenAI Codex', plan: 'plus',
          windows: [{ key: '5h', percent: 13, resetsAt: null }] },
        { ok: true, mode: 'independent', provider: 'anthropic', displayName: 'Claude Code', plan: 'max',
          windows: [{ key: '7d', percent: 47, resetsAt: null }] },
      ],
      skipped: [],
    };
    const out = await renderG(fetchThreeKinds({
      credits: SAMPLE_CREDITS, prepaid: twoPrepaid, subscription: twoSubs,
    }), { expand: true });
    const text = textOf(out);

    // 两个充值来源都要出现（按 displayName 或 provider id）
    expect(/DeepSeek/i.test(text), `应渲染 DeepSeek 充值行，实际：${text}`);
    expect(/OpenRouter/i.test(text), `应渲染 OpenRouter 充值行，实际：${text}`);
    // 两个订阅来源都要出现
    expect(/Codex/i.test(text), `应渲染 Codex 订阅组，实际：${text}`);
    expect(/Claude/i.test(text), `应渲染 Claude 订阅组，实际：${text}`);
    return true;
  });

  // G4 订阅：每个窗口一条健康条，条长按剩余
  //
  // 口径（成员发现、我确认属实）：宿主 `windows[].percent` 是**已用**百分比。
  // 卡片画的是"还剩多少"，条长与数字都必须是**剩余** = 100 - used，
  // 否则会出现"条画满却表示只剩 20%"。原判据只断言 `text.includes(percent)`，
  // 20 既可能是剩余也可能是已用，等于没验口径。
  //
  // 形态变更（用户要求）：圆圈太占位置，改成 4px 条形。
  await claim('G4', '订阅每个窗口一条健康条（不是圆圈），数字为剩余值', async () => {
    const out = await renderG(fetchThreeKinds({ subscription: SAMPLE_SUBSCRIPTION }), { expand: true });
    const text = textOf(out);
    const group = SAMPLE_SUBSCRIPTION.subscriptions[0];
    expect(group !== undefined && Array.isArray(group.windows), '样本必须有 subscriptions[].windows');
    const windows = group.windows;

    for (const w of windows) {
      const remaining = Math.round((100 - w.percent) * 10) / 10;
      const remText = Number.isInteger(remaining) ? String(remaining) : remaining.toFixed(1);
      expect(text.includes(remText),
        `窗口 ${w.key} 应显示剩余 ${remText}%（宿主给的是已用 ${w.percent}%），实际：${text}`);
      const clash = windows.some((o) => Math.round(100 - o.percent) === w.percent);
      if (!clash) {
        const inner = text.match(new RegExp(`${w.key}[^0-9%]{0,20}(\\d+(?:\\.\\d+)?)%`));
        if (inner !== null) {
          expect(Number(inner[1]) !== w.percent,
            `窗口 ${w.key} 显示了已用值 ${w.percent}%（应为剩余 ${remText}%）`);
        }
      }
    }

    // 必须是条形：高度 ≤5px 的水平条，数量不少于窗口数
    const bars = stylesOf(out).filter(({ style }) => {
      const h = Number.parseInt(String(style.height ?? ''), 10);
      return Number.isFinite(h) && h > 0 && h <= 5;
    });
    expect(bars.length >= windows.length,
      `应有至少 ${windows.length} 条健康条（每个窗口一条），实际 ${bars.length}`);

    // 且不得再有圆圈/环
    const circles = nodesOf(out).filter((n) => {
      const s = n.props && n.props.style;
      if (!s) return false;
      const br = String(s.borderRadius ?? '');
      return br === '50%' || br === '999px' || n.type === 'circle';
    });
    expect(circles.length === 0,
      `订阅区不得再画圆圈（用户要求改条形），实际 ${circles.length} 个`);
    return true;
  });

  // G4b 订阅按账号显示，不合并
  //
  // 用户要求：「订阅型的都是，不止 GPT」——所有订阅型都按账号显示。
  // 多账号池型（Codex）每个账号一行；单令牌型（Claude/Kimi/…）固定一行。
  // 关键：非活跃账号没有用量数据（宿主只给活跃那份），必须显示「未取」而不是 0%。
  await claim('G4b', '订阅按账号分列，非活跃账号显示「未取」而非 0%', async () => {
    const multiAccount = {
      mode: 'plugin', primary: 'plugin',
      subscriptions: [{
        ok: true, mode: 'plugin', provider: 'openai-codex', displayName: 'OpenAI Codex', plan: 'plus',
        accounts: [
          { id: 'a1', alias: 'alice@example.com', plan: 'plus', active: true,
            windows: [{ key: '5h', percent: 37, resetsAt: null }] },
          { id: 'a2', alias: 'bob@example.com', plan: 'plus', active: false, windows: null },
        ],
      }],
      skipped: [],
    };
    const out = await renderG(fetchThreeKinds({ subscription: multiAccount }), { expand: true });
    const text = textOf(out);

    // 两个账号别名都要出现（不合并成一条）
    expect(/alice@example\.com/i.test(text), `应显示账号 alice@example.com，实际：${text}`);
    expect(/bob@example\.com/i.test(text), `应显示账号 bob@example.com，实际：${text}`);

    // 非活跃账号必须明确说"未取"，且不得显示 0%
    expect(/未取/.test(text), `非活跃账号应显示「未取」，实际：${text}`);
    // bob 那一段不能出现百分比
    const bobPart = text.slice(text.indexOf('bob@example.com'), text.indexOf('bob@example.com') + 40);
    expect(!/\d+(\.\d+)?%/.test(bobPart),
      `非活跃账号不得显示百分比（那会被读成"用完了"），实际：${bobPart}`);
    return true;
  });

  // G5 充值：有已消耗+剩余则合并画条
  await claim('G5', '充值型有已消耗+剩余时合并为总量并画健康条', async () => {
    const out = await renderG(fetchThreeKinds({ prepaid: SAMPLE_PREPAID }), { expand: true });
    const text = textOf(out);
    expect(/20(\.0+)?/.test(text), `应显示总量 20（已消耗 7.5 + 剩余 12.5），实际：${text}`);
    expect(/12\.5/.test(text), `应显示剩余 12.5，实际：${text}`);
    const bars = stylesOf(out).filter(({ style }) => {
      const h = Number.parseInt(String(style.height ?? ''), 10);
      return Number.isFinite(h) && h > 0 && h <= 5;
    });
    expect(bars.length > 0, '充值型有分母时应画健康条');
    return true;
  });

  // G5b 只有剩余时不伪造总量
  //
  // 原判据断言"全文不得出现 100%"，这是脆弱的文本级判断：同屏若有别的渠道恰好 100%
  // （真实数据里 buddy/raccoon 就是），会误伤。改成只检查**充值分区内**不得出现百分比。
  await claim('G5b', '充值型只有剩余时不伪造总量、不画条', async () => {
    const out = await renderG(fetchThreeKinds({
      prepaid: {
        provider: 'deepseek-official', model: 'deepseek-flash', kind: 'balance', displayName: 'DeepSeek',
        balance: { isAvailable: true, total: 12.34, currency: 'CNY' },
        usage: null, ok: true, code: null,
      },
    }), { expand: true });
    const text = textOf(out);
    expect(/12\.34/.test(text), `应显示剩余 12.34，实际：${text}`);

    // 定位「充值」分区标题之后的文本段，只在那一段里查百分比
    const marker = '充值';
    const at = text.lastIndexOf(marker);
    expect(at >= 0, `应出现「充值」分区，实际：${text}`);
    const prepaidSection = text.slice(at);
    expect(!/\d+(\.\d+)?%/.test(prepaidSection),
      `只有剩余时充值分区内不得出现百分比（分母不存在，画/写比例都是编的），实际：${prepaidSection}`);

    // 同时：整块不得有健康条（该分区没有分母）
    const bars = stylesOf(out).filter(({ style }) => {
      const h = Number.parseInt(String(style.height ?? ''), 10);
      return Number.isFinite(h) && h > 0 && h <= 5;
    });
    expect(bars.length === 0, `只有剩余时不应画健康条，实际 ${bars.length} 条`);

    // 用户口径：「充值区没有足够信息的话可以只展示余额数字」。
    // 所以除了金额本身，不许多写"无已消耗数据""算不出比例"这类解释性文字——
    // 它占宽度、还要读者去理解一件他并不关心的事。
    // 唯一允许承载原因的地方是悬浮说明（title / aria-label）。
    const explainWords = ['无已消耗', '算不出', '没有已消耗', 'no spent figure'];
    const visibleOnly = textOf(out);
    for (const word of explainWords) {
      expect(!visibleOnly.includes(word),
        `充值区缺数据时只显示金额，不写解释文字（出现「${word}」）`);
    }
    return true;
  });

  // G6 积分保持健康条
  await claim('G6', '积分型每渠道一行：名称 + 健康条 + 剩余/总量 + 百分比', async () => {
    const out = await renderG(fetchThreeKinds({ credits: SAMPLE_CREDITS }), { expand: true });
    const text = textOf(out);
    for (const ch of SAMPLE_CREDITS) {
      expect(new RegExp(ch.channel, 'i').test(text), `应列出渠道 ${ch.channel}，实际：${text}`);
    }
    const bars = stylesOf(out).filter(({ style }) => {
      const h = Number.parseInt(String(style.height ?? ''), 10);
      return Number.isFinite(h) && h > 0 && h <= 5;
    });
    expect(bars.length > 0, '积分型必须有细健康条（≤5px）');
    return true;
  });

  // G7 格式
  await claim('G7', '格式：无 .0% / 无科学计数 / 单位中文化', async () => {
    const out = await renderG(fetchThreeKinds({ credits: SAMPLE_CREDITS }), { expand: true });
    const text = textOf(out);
    expect(!/\d+\.0%/.test(text), `百分比不留 .0，实际：${text}`);
    expect(!/\d+e\+\d+/i.test(text), `不得出现科学计数，实际：${text}`);
    expect(!/\bcredits?\b/i.test(text), `单位不得显示英文 credits，实际：${text}`);
    return true;
  });

  // G8 不轮询
  await claim('G8', '卡片不引入自动轮询（只读缓存）', async () => {
    let calls = 0;
    const base = fetchThreeKinds({ credits: SAMPLE_CREDITS });
    const counting = async (url) => { if (String(url).includes('/snapshot')) calls += 1; return base(url); };
    await renderG(counting);
    const after = calls;
    await new Promise((r) => setTimeout(r, 1700));
    expect(calls === after, `挂载后 ${after} 次，1.7s 后 ${calls} 次 —— 不得自动轮询`);
    return true;
  });

  // G9 展开/折叠/刷新
  await claim('G9', '头部可展开且键盘可达，有刷新入口与更新时间', async () => {
    const out = await renderG(fetchThreeKinds({ credits: SAMPLE_CREDITS }));
    const clickable = nodesOf(out).filter((n) => n.props && typeof n.props.onClick === 'function');
    expect(clickable.length > 0, '必须有可点击元素');
    const keyboard = clickable.filter((n) => n.props.role === 'button' || n.props.tabIndex !== undefined
      || typeof n.props.onKeyDown === 'function');
    expect(keyboard.length > 0, '头部必须键盘可达');
    const expanded = await renderG(fetchThreeKinds({ credits: SAMPLE_CREDITS }), { expand: true });
    const etext = textOf(expanded);
    expect(/刷新|⟳/.test(etext), `展开态应有刷新入口，实际：${etext}`);
    expect(/更新于|\d{1,2}:\d{2}/.test(etext), `展开态应有更新时间，实际：${etext}`);
    return true;
  });

  // G10 状态区分
  await claim('G10', '读取中 / 未登录 / 出错 有可辨识的不同呈现', async () => {
    const ok = textOf(await renderG(fetchThreeKinds({
      credits: [{ channel: 'trae', state: 'ok', remaining: 50, total: 100, percent: 50, unit: 'credits' }],
    }), { expand: true }));
    const empty = textOf(await renderG(fetchThreeKinds({
      credits: [{ channel: 'trae', state: 'empty', note: '未登录' }],
    }), { expand: true }));
    const err = textOf(await renderG(fetchThreeKinds({
      credits: [{ channel: 'trae', state: 'error', error: '令牌过期' }],
    }), { expand: true }));
    expect(ok !== empty, '正常态与未登录态必须有不同呈现');
    expect(ok !== err, '正常态与出错态必须有不同呈现');
    expect(empty !== err, '未登录态与出错态必须有不同呈现');
    return true;
  });

  // G11 窄宽度下不出现残段
  //
  // 真实界面暴露过：3840 宽屏 2x 缩放下侧边栏约 274 CSS px，
  // 「免费渠道积分」被 flex 压成一个「免」字 —— 既不可读也不像省略号。
  // 判据：任何"纯中文 1~2 字"的可见文本，若不在白名单里，就是被压扁的残段。
  await claim('G11', '窄宽度下不出现 1~2 字的残段', async () => {
    const out = await renderG(fetchThreeKinds({
      credits: SAMPLE_CREDITS, prepaid: SAMPLE_PREPAID, subscription: SAMPLE_SUBSCRIPTION,
    }), { expand: true });

    // 白名单：本身就是 1~2 字的完整词（状态词、单位、分区名、窗口名）
    const allowed = new Set([
      '订阅', '充值', '积分', '令牌', '已用', '剩余', '刷新', '未登录', '读取中', '无数据',
      '失败', '暂无', '小时', '天', '万', '亿', '元', '更新于', '已用13', '已用47',
    ]);
    const bad = [];
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const c of node) walk(c); return; }
      const t = textOf(node).trim();
      if (/^[\u4e00-\u9fa5]{1,2}$/.test(t) && !allowed.has(t)) bad.push(t);
      if (Array.isArray(node.children)) for (const c of node.children) walk(c);
    };
    walk(out);
    expect(bad.length === 0,
      `出现 ${bad.length} 处 1~2 字残段：${[...new Set(bad)].join('、')}（被压扁的标题/标签）`);
    return true;
  });
}
// ── 主流程 ─────────────────────────────────────────────────────────────

const GROUPS = {
  A: { title: '侧边栏卡片', run: groupA },
  B: { title: '用量统计', run: groupB },
  C: { title: '积分查询', run: groupC },
  D: { title: '订阅余量', run: groupD },
  E: { title: '采集架构', run: groupE },
  F: { title: '工程底线', run: groupF },
  G: { title: '卡片展示与交互（对标 OFM）', run: groupG },
};

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const only = onlyArg
    ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim().toUpperCase()).filter((k) => k in GROUPS)
    : null;

  const selected = only ?? Object.keys(GROUPS);
  for (const key of selected) {
    await GROUPS[key].run();
  }

  const pass = results.filter((r) => r.state === PASS).length;
  const fail = results.filter((r) => r.state === FAIL).length;
  const missingCount = results.filter((r) => r.state === MISSING).length;

  if (json) {
    process.stdout.write(JSON.stringify({ pass, fail, missing: missingCount, results }, null, 2) + '\n');
  } else {
    let current = '';
    for (const row of results) {
      const group = row.id.charAt(0);
      if (group !== current) {
        current = group;
        process.stdout.write(`\n[${group}] ${GROUPS[group]?.title ?? ''}\n`);
      }
      const mark = row.state === PASS ? ' 通过 ' : row.state === MISSING ? ' 未实现 ' : ' 失败 ';
      process.stdout.write(`${mark} ${row.id}  ${row.name}${row.detail === '' ? '' : `\n            ${row.detail}`}\n`);
    }
    process.stdout.write(`\n通过 ${pass} · 失败 ${fail} · 未实现 ${missingCount}\n`);
    if (missingCount > 0) process.stdout.write('未实现项：对应能力尚未交付（既不算通过，也不算失败）\n');
  }

  process.exit(fail > 0 || missingCount > 0 ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`验收脚本自身出错：${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(2);
});
