// 浏览器侧的确定性断言：缺失值语义、倒计时、币种、假期集合、峰谷规则。
// 加载真实的 lib/client.js（stub loader + 桩 React），不模拟计时器。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// ---- 极简 React 桩：只提供 useState / useEffect / useCallback / useRef / useMemo ----
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (init) => ({ current: init }),
  useMemo: (fn) => fn(),
  useSyncExternalStore: (_sub, snap) => snap(),
};

const win = { __ModuleLoader__: { load: (def) => { win.__def = def; } } };
new Function('window', 'require', source)(win, (id) => (id === 'react' ? reactStub : {}));
const mod = win.__def.factory((id) => (id === 'react' ? reactStub : {}));
const I = mod.__internals;

const at = (iso) => Date.parse(iso);

test('缺失的金额显示占位符而不是 0', () => {
  assert.equal(I.money(null), '—');
  assert.equal(I.money(undefined), '—');
  assert.equal(I.money(''), '—');
  assert.equal(I.fmtPrice(null), '—');
  assert.equal(I.fmtPrice(undefined), '—');
  assert.equal(I.fmtPrice(''), '—');
});

test('真正的 0 仍然显示 0', () => {
  assert.equal(I.money(0), '0.00');
  assert.equal(I.fmtPrice(0), '0');
});

test('金额与单价按既有格式显示', () => {
  assert.equal(I.money(12.345), '12.35');
  assert.equal(I.money(1234.5), '1234.50');
  assert.equal(I.fmtPrice(0.04), '0.04');
  assert.equal(I.fmtPrice(8), '8');
  assert.equal(I.fmtPrice(2.5), '2.5');
});

test('币种映射到符号，未知币种显示代码', () => {
  assert.equal(I.currencySymbol('CNY'), '¥');
  assert.equal(I.currencySymbol('USD'), '$');
  assert.equal(I.currencySymbol('EUR'), '€');
  assert.equal(I.currencySymbol('JPY'), '¥');
  assert.equal(I.currencySymbol('HKD'), 'HKD ');
  assert.equal(I.currencySymbol(null), '¥');
});

test('放假日期集合：闭区间展开，非法日期被跳过', () => {
  const days = I.expandHolidayRanges([
    ['2026-10-01', '2026-10-07'],
    ['2027-02-30', '2027-03-02'], // 非法日期：不得滚动成 03-02
  ]);
  assert.equal(days.has('2026-10-01'), true);
  assert.equal(days.has('2026-10-07'), true);
  assert.equal(days.has('2026-10-08'), false);
  assert.equal(days.has('2027-02-28'), false);
  assert.equal(days.has('2027-03-02'), false);
});

test('放假日期集合是实例级的：两个实例互不覆盖', () => {
  // 组件各自持有自己的集合：宿主返回的表只影响那一个实例。
  const a = I.expandHolidayRanges([['2026-10-01', '2026-10-07']]);
  const b = I.expandHolidayRanges([['2026-01-01', '2026-01-03']]);
  assert.equal(a.has('2026-10-01'), true);
  assert.equal(a.has('2026-01-01'), false);
  assert.equal(b.has('2026-01-01'), true);
  assert.equal(b.has('2026-10-01'), false);
});

test('峰谷：法定节假日与周末空闲，工作日高峰', () => {
  const days = I.expandHolidayRanges([['2026-10-01', '2026-10-07']]);
  assert.equal(I.isPeak(at('2026-10-08T10:00:00+08:00'), days), true);
  assert.equal(I.isPeak(at('2026-10-01T10:00:00+08:00'), days), false, '国庆');
  assert.equal(I.isPeak(at('2026-10-10T10:00:00+08:00'), days), false, '周六');
  assert.equal(I.isPeak(at('2026-10-11T10:00:00+08:00'), days), false, '周日');
});

test('峰谷窗口按北京时间判定', () => {
  const days = I.expandHolidayRanges([]);
  const day = (hhmm) => at(`2026-10-22T${hhmm}:00+08:00`);
  assert.equal(I.isPeak(day('08:59'), days), false);
  assert.equal(I.isPeak(day('09:00'), days), true);
  assert.equal(I.isPeak(day('11:59'), days), true);
  assert.equal(I.isPeak(day('12:00'), days), false);
  assert.equal(I.isPeak(day('13:59'), days), false);
  assert.equal(I.isPeak(day('14:00'), days), true);
  assert.equal(I.isPeak(day('17:59'), days), true);
  assert.equal(I.isPeak(day('18:00'), days), false);
});

test('倒计时落在精确的整点边界上', () => {
  const days = I.expandHolidayRanges([]);
  const n = nextChangeOf(days);
  assert.equal(new Date(n.at).toISOString(), '2026-10-22T04:00:00.000Z', '12:00 切出高峰');
  assert.equal(n.peak, false);
  const n2 = I.nextChange(at('2026-10-22T12:00:00+08:00'), days);
  assert.equal(new Date(n2.at).toISOString(), '2026-10-22T06:00:00.000Z', '14:00 切入高峰');
  assert.equal(n2.peak, true);
});

// ---- 多提供商账户读数 -----------------------------------------------------

/** 账户读数的窗口标签需要一个本地化函数；测试用恒等函数。 */
const t = (k) => k;

test('余额形态：币种符号 + 金额', () => {
  const lead = I.accountLead('balance', { balance: { total: 12.34, currency: 'CNY' } }, t);
  assert.equal(lead.symbol, '¥');
  assert.equal(lead.value, '12.34');
  const usd = I.accountLead('balance', { balance: { total: 49.58894, currency: 'USD' } }, t);
  assert.equal(usd.symbol, '$');
  assert.equal(usd.value, '49.59');
});

test('余额缺失显示占位符，不显示 0', () => {
  const lead = I.accountLead('balance', { balance: { total: null, currency: 'CNY' } }, t);
  assert.equal(lead.symbol, '¥');
  assert.equal(lead.value, '—');
  const none = I.accountLead('balance', null, t);
  assert.equal(none.value, '—');
});

test('订阅用量形态：取最紧窗口的百分比', () => {
  const account = {
    usage: {
      windows: [
        { key: '5h', percent: 4, resetsAt: null },
        { key: '7d', percent: 34, resetsAt: null },
        { key: '30d', percent: 12, resetsAt: null },
      ],
    },
  };
  const lead = I.accountLead('usage', account, t);
  assert.equal(lead.symbol, 'accounts.window.7d', '符号位是窗口标签的 key（由界面本地化）');
  assert.equal(lead.value, '34%');
});

test('订阅用量：没有窗口或读数缺失时是占位符', () => {
  assert.equal(I.accountLead('usage', { usage: { windows: [] } }, t).value, '—');
  assert.equal(I.accountLead('usage', null, t).value, '—');
  // 百分比不是数字时不当成 0。
  const bad = I.accountLead('usage', { usage: { windows: [{ key: '5h', percent: null }] } }, t);
  assert.equal(bad.value, '—');
});

test('OAuth 形态与用量形态同构', () => {
  const account = { usage: { windows: [{ key: '5h', percent: 33, resetsAt: 1789882800000 }] } };
  const lead = I.accountLead('oauth', account, t);
  assert.equal(lead.symbol, 'accounts.window.5h');
  assert.equal(lead.value, '33%');
});

test('不可查的 provider：符号与数值都是占位符', () => {
  const lead = I.accountLead('none', { balance: { total: 99, currency: 'CNY' } }, t);
  assert.equal(lead.symbol, '');
  assert.equal(lead.value, '—', 'none 形态不得显示任何数字');
});

test('百分比：null 是占位符，真 0 是 0%', () => {
  assert.equal(I.percentText(null), '—');
  assert.equal(I.percentText(undefined), '—');
  assert.equal(I.percentText(''), '—');
  assert.equal(I.percentText('n/a'), '—');
  assert.equal(I.percentText(0), '0%');
  assert.equal(I.percentText(23.4), '23%');
  assert.equal(I.percentText(99.6), '100%');
});

// ---- 多窗口卡片（订阅用量档位）--------------------------------------------

/** 与 lib/client.js 词典同口径的标签函数（中文）。 */
const labels = (k) => ({
  'accounts.window.5h': '5 小时',
  'accounts.window.7d': '7 天',
  'accounts.window.7d-opus': 'Opus 7 天',
  'accounts.window.30d': '30 天',
  'accounts.window.cycle': '当前周期',
}[k] ?? k);

/** 英文词典。 */
const enLabels = (k) => ({
  'accounts.window.5h': '5-hour',
  'accounts.window.7d': '7-day',
  'accounts.window.7d-opus': 'Opus 7-day',
  'accounts.window.30d': '30-day',
  'accounts.window.cycle': 'Current cycle',
}[k] ?? k);

test('用量窗口：按固定档位顺序排列，保留全部档位', () => {
  const rows = I.usageWindows({
    usage: {
      windows: [
        { key: '30d', percent: 58, resetsAt: 1000 },
        { key: '5h', percent: 1, resetsAt: 2000 },
        { key: '7d', percent: 24, resetsAt: 3000 },
        { key: '7d-opus', percent: 91, resetsAt: 4000 },
      ],
    },
  });
  assert.deepEqual(rows.map((w) => w.key), ['5h', '7d', '7d-opus', '30d']);
  assert.deepEqual(rows.map((w) => w.percent), [1, 24, 91, 58]);
  assert.equal(rows[0].resetsAt, 2000);
});

test('用量窗口：缺失/非法百分比不画，重复 key 取更高的那条', () => {
  const rows = I.usageWindows({
    usage: {
      windows: [
        { key: '5h', percent: null },
        { key: '7d', percent: 'n/a' },
        { key: '30d', percent: 12 },
        { key: '30d', percent: 40, resetsAt: 5000 },
      ],
    },
  });
  assert.deepEqual(rows.map((w) => w.key), ['30d']);
  assert.equal(rows[0].percent, 40);
  assert.equal(rows[0].resetsAt, 5000);
  // 没有 windows 或没有 usage 时返回空数组，由卡片回退到兜底行。
  assert.deepEqual(I.usageWindows(null), []);
  assert.deepEqual(I.usageWindows({ usage: { windows: [] } }), []);
});

test('用量窗口标签：词典优先，通用时长按语言拼，未知 key 原样显示', () => {
  assert.equal(I.windowLabel(labels, '5h', 'zh'), '5 小时');
  assert.equal(I.windowLabel(enLabels, '5h', 'en'), '5-hour');
  assert.equal(I.windowLabel(labels, '7d-opus', 'zh'), 'Opus 7 天');
  assert.equal(I.windowLabel(labels, '1h', 'zh'), '1 小时');
  assert.equal(I.windowLabel(labels, '3d', 'en'), '3-day');
  assert.equal(I.windowLabel(labels, 'weird', 'zh'), 'weird');
});

test('周期徽章：统一英文缩写，未知时长按通用格式，完全未知原样大写', () => {
  assert.equal(I.windowBadge('5h'), '5H');
  assert.equal(I.windowBadge('7d'), '7D');
  assert.equal(I.windowBadge('30d'), '1M');
  assert.equal(I.windowBadge('7d-opus'), 'OPUS');
  assert.equal(I.windowBadge('cycle'), 'CYCLE');
  assert.equal(I.windowBadge('1h'), '1H');
  assert.equal(I.windowBadge('14d'), '14D');
  assert.equal(I.windowBadge('weird'), 'WEIRD');
});

test('用量窗口悬浮说明：已用百分比 + 重置剩余时间', () => {
  const soon = Date.now() + 2 * 3600_000 + 5 * 60_000;
  const zh = I.windowHint({ key: '5h', percent: 12, resetsAt: soon }, labels, 'zh');
  assert.match(zh, /^5 小时：已用 12%/);
  assert.match(zh, /后重置$/);
  const en = I.windowHint({ key: '5h', percent: 12, resetsAt: soon }, enLabels, 'en');
  assert.match(en, /^5-hour: 12% used, resets in /);
  // 没有重置时间（或已经过了）时只讲已用，不编一个倒计时。
  assert.equal(I.windowHint({ key: '7d', percent: 34, resetsAt: null }, labels, 'zh'), '7 天：已用 34%');
  assert.equal(I.windowHint({ key: '7d', percent: 34, resetsAt: 1 }, enLabels, 'en'), '7-day: 34% used');
});

test('用量比例：夹在 0–1', () => {
  assert.equal(I.usageRatio(-5), 0);
  assert.equal(I.usageRatio(42.5), 0.425);
  assert.equal(I.usageRatio(180), 1);
});

test('剩余额度颜色：已用 <80% 绿色，≥80% 红色', () => {
  const green = I.remainingColor(0);
  assert.equal(I.remainingColor(79.9), green);
  const red = I.remainingColor(80);
  assert.notEqual(red, green);
  assert.equal(I.remainingColor(100), red);
  assert.equal(I.remainingColor(120), red);
  // 两种颜色都是降低饱和度后的强调色，不是主题 state 色的原值。
  assert.match(green, /^color-mix\(in srgb, var\(--dsw-alias-state-success-primary/);
  assert.match(red, /^color-mix\(in srgb, var\(--dsw-alias-state-error-primary/);
});

function nextChangeOf(days) {
  return I.nextChange(at('2026-10-22T11:00:00+08:00'), days);
}

test('DSH 语言 → 插件语言：中文前缀用中文，其它一律英文', () => {
  assert.equal(I.uiLang('zh'), 'zh');
  assert.equal(I.uiLang('zh-CN'), 'zh');
  assert.equal(I.uiLang('zh-Hans'), 'zh');
  assert.equal(I.uiLang('ZH'), 'zh');
  assert.equal(I.uiLang('en'), 'en');
  assert.equal(I.uiLang('en-US'), 'en');
  assert.equal(I.uiLang('ja'), 'en');
  assert.equal(I.uiLang('de'), 'en');
  assert.equal(I.uiLang(''), 'en');
  assert.equal(I.uiLang(undefined), 'en');
});

// ───────────────────────────────────────────────────────────────────────────
// 金额列的三种形态：单一价 / 免费 / 分项价，以及"按积分计费"的真正边界
// ───────────────────────────────────────────────────────────────────────────

/** 统计词典（只收本组用例要断言的那几条，缺的键原样返回，便于看是哪条没翻译）。 */
const costLabels = (k) => ({
  'stats.cost.credit': '按积分计费',
  'stats.cost.unpriced': '暂无定价',
  'stats.cost.noPrice': '该渠道未提供价格',
  'stats.cost.mixed': '多币种',
  'stats.cost.free': '免费',
  'stats.cost.singlePrice': '该渠道只提供单一价',
  'stats.promo': '促销：原 x{original} → 现 x{current}',
  'stats.mirror': '跨渠道镜像价，来源 {n}',
  'stats.priceLine': '每百万 token：输入 {input} / 输出 {output}',
  'stats.priceLineUniform': '每百万 token：{price}（单一价）',
}[k] ?? k);

test('金额列：单一价渠道显示金额（不是「按积分计费」）', () => {
  const cost = {
    known: true, priced: true, currency: 'CNY', form: 'uniform', singlePrice: true,
    prices: { uniform: 0.75, input: null, cacheRead: null, cacheWrite: null, output: null },
    cost: { input: null, cacheRead: null, cacheWrite: null, output: null, total: 0.75 },
    promotion: null, mirrors: null,
  };
  assert.equal(I.moneyText(cost, costLabels), '¥0.7500');
  assert.notEqual(I.moneyText(cost, costLabels), '按积分计费');
  // 悬浮说明必须讲清"这个数不分输入输出"。
  assert.match(I.costHint(cost, costLabels), /单一价/);
});

test('金额列：免费显示「免费」，既不是 ¥0.00 也不是「按积分计费」', () => {
  const cost = {
    known: true, priced: false, currency: 'free', form: 'free', singlePrice: false,
    prices: null,
    cost: { input: null, cacheRead: null, cacheWrite: null, output: null, total: null },
    promotion: null, mirrors: null,
  };
  assert.equal(I.moneyText(cost, costLabels), '免费');
  assert.notEqual(I.moneyText(cost, costLabels), '¥0.00');
  assert.notEqual(I.moneyText(cost, costLabels), '按积分计费');
  // 免费的单价行必须是空：没有价可画。
  assert.equal(I.priceText(cost, costLabels), '');
});

test('金额列：分项价照旧（既有逻辑不变）', () => {
  const cost = {
    known: true, priced: true, currency: 'CNY', form: 'split', singlePrice: false,
    prices: { uniform: null, input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
    cost: { input: 0.2296, cacheRead: 0, cacheWrite: 0, output: 0.2652, total: 0.4948 },
    promotion: null, mirrors: null,
  };
  assert.equal(I.moneyText(cost, costLabels), '¥0.4948');
  assert.equal(I.priceText(cost, costLabels), '每百万 token：输入 ¥2 / 输出 ¥8');
});

test('金额列：「按积分计费」只留给 currency:credit（两表都查不到）', () => {
  const credit = {
    known: false, priced: false, currency: 'credit', form: 'unknown', singlePrice: false,
    prices: { input: null, cacheRead: null, cacheWrite: null, output: null },
    cost: { input: null, cacheRead: null, cacheWrite: null, output: null, total: null },
    promotion: null, mirrors: null,
  };
  assert.equal(I.moneyText(credit, costLabels), '按积分计费');

  // 按钱算但缺这个模型的价 → 「暂无定价」，不是「按积分计费」。
  const unpriced = { ...credit, priced: true, currency: 'unknown' };
  assert.equal(I.moneyText(unpriced, costLabels), '暂无定价');
  // 渠道压根没给价 → 「该渠道未提供价格」，与上面那句区分开。
  const noPrice = { ...credit, priced: false, currency: 'unknown' };
  assert.equal(I.moneyText(noPrice, costLabels), '该渠道未提供价格');
});

test('金额列：单一价的单价行写成单值句式，不把同一个数字填两遍', () => {
  const cost = {
    known: true, priced: true, currency: 'CNY', form: 'uniform', singlePrice: true,
    prices: { uniform: 0.8, input: null, cacheRead: null, cacheWrite: null, output: null },
    cost: { input: null, cacheRead: null, cacheWrite: null, output: null, total: 0.8 },
    promotion: null, mirrors: null,
  };
  assert.equal(I.priceText(cost, costLabels), '每百万 token：¥0.8（单一价）');
});

test('悬浮说明：促销给原价→现价，镜像给来源，没话说时是 undefined', () => {
  const promo = {
    known: true, priced: true, currency: 'CNY', form: 'uniform', singlePrice: true,
    prices: { uniform: 0.1, input: null, cacheRead: null, cacheWrite: null, output: null },
    cost: { input: null, cacheRead: null, cacheWrite: null, output: null, total: 0.1 },
    promotion: { original: 0.2, current: 0.1, from: null, until: null },
    mirrors: null,
  };
  const hint = I.costHint(promo, costLabels);
  assert.match(hint, /x0\.2/);
  assert.match(hint, /x0\.1/);
  assert.match(hint, /单一价/);

  const mirror = {
    ...promo, form: 'split', singlePrice: false, promotion: null,
    mirrors: 'zai/glm-5.2',
  };
  assert.match(I.costHint(mirror, costLabels), /zai\/glm-5\.2/);

  // 普通分项价没有任何附加信息：不挂空 title（空提示框看起来像坏了）。
  const plain = { ...mirror, mirrors: null };
  assert.equal(I.costHint(plain, costLabels), '');
  assert.equal(I.hintOf(plain, costLabels), undefined);
});

test('工作区列：免费与按积分计费分开显示', () => {
  const free = { currency: 'free', priced: false, amounts: null };
  assert.equal(I.workspaceCostText(free, costLabels), '免费');
  const credit = { currency: 'credit', priced: false, amounts: null };
  assert.equal(I.workspaceCostText(credit, costLabels), '按积分计费');
});

// ───────────────────────────────────────────────────────────────────────────
// 倒计时：自然语言文案（`2天13小时后` / `5小时42分钟后` / `42分钟后`）
// + 定时器的启用阈值（订阅采集间隔 + 2 分钟）
// ───────────────────────────────────────────────────────────────────────────

const HOUR = 3600 * 1000;
const MIN = 60 * 1000;
// 倒计时的词典：天 / 小时 / 分钟 / 后缀「后」。
const countdownLabels = (k) => ({
  'credit.sub.countdownDay': '天',
  'credit.sub.countdownHour': '小时',
  'credit.sub.countdownMinute': '分钟',
  'credit.sub.countdownAfter': '后',
}[k] ?? k);

test('倒计时：自然语言文案，天/小时/分钟三档', () => {
  // 表格里的四个例子（用户给的原话）：
  assert.equal(I.countdownText(2 * 24 * HOUR + 13 * HOUR, countdownLabels), '2天13小时后');
  assert.equal(I.countdownText(1 * 24 * HOUR, countdownLabels), '1天后');
  assert.equal(I.countdownText(5 * HOUR, countdownLabels), '5小时后');
  assert.equal(I.countdownText(42 * MIN, countdownLabels), '42分钟后');
});

test('倒计时：低位为 0 时整段省略，不出现「1天0小时后」这种别扭写法', () => {
  // 天数 = 1 且小时位为 0 → 退化成「1天后」。
  assert.equal(I.countdownText(24 * HOUR, countdownLabels), '1天后');
  assert.equal(I.countdownText(24 * HOUR + 1 * MIN, countdownLabels), '1天后');
  // 天数 = 1 且小时位非 0 → 带出小时。
  assert.equal(I.countdownText(24 * HOUR + 13 * HOUR, countdownLabels), '1天13小时后');
  // 天数 > 1 但小时位为 0 → 「2天后」（不写「2天0小时后」）。
  assert.equal(I.countdownText(2 * 24 * HOUR, countdownLabels), '2天后');
  // 小时 = 1 → 「1小时后」（分钟位为 0 时不写「1小时0分钟后」）。
  assert.equal(I.countdownText(1 * HOUR, countdownLabels), '1小时后');
  assert.equal(I.countdownText(1 * HOUR + 30 * MIN, countdownLabels), '1小时30分钟后');
  // 不足 1 分钟：说「1分钟内」，不写「0分钟后」（那是在说一件已经过去的事）。
  assert.equal(I.countdownText(30 * 1000, countdownLabels), '1分钟内');
  assert.equal(I.countdownText(0, countdownLabels), '1分钟内');
});

test('倒计时：一律不补零（自然语言，不是时钟读数）', () => {
  // 小时 3、分钟 5 → 「3小时5分钟后」，不是「3小时05分钟后」。
  assert.equal(I.countdownText(3 * HOUR + 5 * MIN, countdownLabels), '3小时5分钟后');
  // 天 2、小时 3 → 「2天3小时后」，不是「2天03小时后」。
  assert.equal(I.countdownText(2 * 24 * HOUR + 3 * HOUR, countdownLabels), '2天3小时后');
});

test('倒计时：段数只看剩余时间，与窗口类型无关', () => {
  // 新格式是自然语言，"7 天窗口剩 3 小时"说成「3小时后」完全正确；
  // 硬按窗口类型塞一个「0天」反而是在给用户看一个没意义的 0。
  assert.equal(I.countdownText(3 * HOUR, countdownLabels), '3小时后');
  assert.equal(I.countdownText(3 * HOUR, countdownLabels), I.countdownText(3 * HOUR, countdownLabels, '7d'));
  // windowSpanMs 那套「窗口总长」判定仍然独立可用（染色用）。
  assert.equal(I.windowSpanMs('7d'), 7 * 24 * HOUR);
  assert.equal(I.windowSpanMs('5h'), 5 * HOUR);
});

test('倒计时定时器：只在「订阅采集间隔 + 2 分钟」以内才起', () => {
  const INTERVAL = 10 * MIN; // 订阅类采集间隔 10 分钟（宿主默认值）
  const LEAD = 2 * MIN;
  // 阈值 = 间隔 + 2 分钟 = 12 分钟。
  //
  // **注意需求原文里有一处算术不自洽**：它写「构造『剩余 11 分钟』→ 也不挂
  // （11 > 10+2）」——但 11 > 12 是**假**的，11 分钟是 ≤ 12 分钟的，按规则应当**挂**
  // 定时器；而紧挨着的「剩余 11.5 分钟 → 应挂」与它给出的规则也是一致的。
  // 也就是说，例子里的 11 分钟那一条与规则本身矛盾（而且 11 与 11.5 要分别落在
  // 阈值两侧，阈值就必须在 (11, 11.5] 内，而规则给的阈值是 12）。
  //
  // 这里**按规则实现**（规则是硬要求，例子是核对用的辅助）：阈值 = 间隔 + 2 分钟。
  // 三个核对点按规则的真实结果断言：
  //   · 剩 20 分钟 → 远大于 12 分钟 → **不挂**。
  assert.equal(I.countdownNeedsTimer(INTERVAL, 20 * MIN), false, '剩 20 分钟不应起定时器');
  //   · 剩 11 分钟 → 11 <= 12 → **挂**（按规则，不是按需求例子里那句自相矛盾的备注）。
  assert.equal(I.countdownNeedsTimer(INTERVAL, 11 * MIN), true, '剩 11 分钟（<= 间隔+2）应起定时器');
  //   · 剩 11.5 分钟 → 11.5 <= 12 → **挂**。
  assert.equal(I.countdownNeedsTimer(INTERVAL, 11.5 * MIN), true, '剩 11.5 分钟（<= 间隔+2）应起定时器');
  // 真正的分界在 12 分钟：正好 12 分钟挂（<= 是"挂"），12.001 分钟不挂。
  assert.equal(I.countdownNeedsTimer(INTERVAL, INTERVAL + LEAD), true, '正好等于间隔+2 应起定时器');
  assert.equal(I.countdownNeedsTimer(INTERVAL, INTERVAL + LEAD + 1), false, '刚过间隔+2 应停');
  // 间隔变了，阈值跟着变：间隔 30 分钟时，剩 20 分钟不该挂。
  // 间隔变了，阈值跟着变：间隔 30 分钟时阈值是 32 分钟，剩 20 分钟仍在其内 —— 应当起。
  // （原来这里写的是 false，是照抄上面「间隔 10 分钟时剩 20 分钟不挂」那个例子，
  //  忘了间隔一变阈值也跟着变；20 与 31 都小于 32，不可能一个不挂一个挂。）
  assert.equal(I.countdownNeedsTimer(30 * MIN, 20 * MIN), true, '间隔 30 分钟时阈值 32 分钟，剩 20 分钟应起定时器');
  assert.equal(I.countdownNeedsTimer(30 * MIN, 31 * MIN), true, '间隔 30 分钟时剩 31 分钟应起定时器');
  // 取不到间隔 → 用默认 10 分钟；已归零 → 不挂。
  assert.equal(I.countdownNeedsTimer(NaN, 20 * MIN), false, '间隔无效时按默认 10 分钟处理');
  assert.equal(I.countdownNeedsTimer(NaN, 11 * MIN), true);
  assert.equal(I.countdownNeedsTimer(NaN, 11.5 * MIN), true);
  assert.equal(I.countdownNeedsTimer(INTERVAL, 0), false, '已归零不应起定时器');
  assert.equal(I.countdownNeedsTimer(INTERVAL, -1000), false);
});

test('倒计时定时器：分钟级不每秒唤醒，秒级才 1 秒一次', () => {
  const now = 1_000_000_000_000;
  const snap = (resetsAt) => ({ subscription: { value: { subscriptions: [{ accounts: [{ windows: [{ key: '5h', resetsAt }] }] }] } } });
  // 剩 1h30m20s：下一次可见变化是 20 秒后的整分，而不是 1 秒后。
  assert.equal(I.nextCountdownTickMs(snap(now + 1 * HOUR + 30 * MIN + 20 * 1000), now), 20 * 1000);
  // 正好整分：下一次是满 60 秒后。
  assert.equal(I.nextCountdownTickMs(snap(now + 1 * HOUR + 30 * MIN), now), 60 * 1000);
  // 剩 59.4s：秒级，400ms 后跳字。
  assert.equal(I.nextCountdownTickMs(snap(now + 59 * 1000 + 400), now), 400);
  // 正好 1 分钟：整分那一刻文字要变（`60分钟后` → `59分钟后`），不能睡满 60 秒。
  assert.equal(I.nextCountdownTickMs(snap(now + 60 * 1000), now), 1000);
  // 已归零 / 没有 resetsAt：不起定时器。
  assert.equal(I.nextCountdownTickMs(snap(now - 1000), now), null);
  assert.equal(
    I.nextCountdownTickMs({ subscription: { value: { subscriptions: [{ accounts: [{ windows: [{ key: 'cycle' }] }] }] } } }, now),
    null,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 树形统计：八种勾选组合的层级语义
// ───────────────────────────────────────────────────────────────────────────

const treeLabels = (k) => ({
  'stats.tree.machine': '整机合计',
  'stats.scope.session': '本会话',
  'stats.workspace.archived': '含归档 {n} 个',
  'stats.tree.archived': '已归档',
  'stats.tree.failed': '读取失败',
  'stats.tree.duplicate': '副本未计入',
  'stats.cost.credit': '按积分计费',
  'stats.cost.unpriced': '暂无定价',
  'stats.cost.free': '免费',
}[k] ?? k);

const money = (total) => ({ currency: 'CNY', priced: true, form: 'split', amounts: { total } });
const kindOf = (name, tokens, amount) => ({ kind: name, totalTokens: tokens, messages: 10, cost: money(amount), providers: [] });

const treeMachine = { ok: true, messages: 300, files: 12, kinds: [kindOf('subscription', 300000, 1.5)], unclassified: [] };
const treeWorkspaces = [
  {
    id: 'ws-a', title: 'alpha', sessionCount: 2, messages: 180,
    totals: { totalTokens: 260000 }, cost: money(1.3), archivedSessions: ['s2'],
    kinds: [kindOf('subscription', 260000, 1.3)],
    sessions: [
      { id: 's1', archived: false, ok: true, messages: 100, totals: { totalTokens: 150000 } },
      { id: 's2', archived: true, ok: true, messages: 80, totals: { totalTokens: 110000 } },
    ],
  },
  {
    id: 'ws-b', title: 'beta', sessionCount: 1, messages: 120,
    totals: { totalTokens: 140000 }, cost: { currency: 'credit', priced: false, amounts: null },
    archivedSessions: [],
    kinds: [kindOf('credits', 140000, 0)],
    sessions: [{ id: 's3', archived: false, ok: false, messages: 0, totals: { totalTokens: 0 } }],
  },
];
const treeSession = { ok: true, messages: 100, files: 8, kinds: [kindOf('subscription', 150000, 0.7)], unclassified: [] };

/** 按勾选组合装配三份数据（模拟 statsFetchPlan 的取数结果）。 */
function treeFor(checks) {
  const plan = I.statsFetchPlan(checks);
  return I.statsTreeNodes({
    checks,
    machine: plan.machine ? treeMachine : null,
    workspaces: plan.workspaces ? treeWorkspaces : null,
    session: plan.sessionOnly ? treeSession : null,
    sessionId: 's1',
    t: treeLabels,
    lang: 'zh',
  });
}

test('树形统计：仅整机 / 仅工作区 / 仅会话都是一级', () => {
  assert.deepEqual(treeFor({ machine: true, workspace: false, session: false }).map((n) => [n.role, n.depth]), [['machine', 0]]);
  assert.deepEqual(treeFor({ machine: false, workspace: true, session: false }).map((n) => [n.role, n.depth]), [['workspace', 0]]);
  assert.deepEqual(treeFor({ machine: false, workspace: false, session: true }).map((n) => [n.role, n.depth]), [['session', 0]]);
  // 一级时根节点就是"当前"的那一个：当前工作区是 s1 所在的 alpha。
  assert.equal(treeFor({ machine: false, workspace: true, session: false })[0].label, 'alpha');
  assert.equal(treeFor({ machine: false, workspace: false, session: true })[0].label, '本会话');
});

test('树形统计：整机+工作区 是两级，整机在上、每个工作区在下', () => {
  const nodes = treeFor({ machine: true, workspace: true, session: false });
  assert.deepEqual(nodes.map((n) => [n.role, n.depth]), [['machine', 0], ['workspace', 1], ['workspace', 1]]);
  assert.equal(nodes[0].label, '整机合计');
  assert.deepEqual(nodes.slice(1).map((n) => n.label), ['alpha', 'beta']);
  // 整机行的会话数是各工作区之和（整机口径响应本身没有会话计数）。
  assert.equal(nodes[0].sessions, 3);
});

test('树形统计：工作区+会话 是两级，会话挂在当前工作区下', () => {
  const nodes = treeFor({ machine: false, workspace: true, session: true });
  assert.deepEqual(nodes.map((n) => [n.role, n.depth]), [['workspace', 0], ['session', 1], ['session', 1]]);
  assert.deepEqual(nodes.slice(1).map((n) => n.label), ['s1', 's2']);
});

test('树形统计：整机+会话 两级且**跨工作区平铺**（不按工作区分组）', () => {
  const nodes = treeFor({ machine: true, workspace: false, session: true });
  assert.deepEqual(nodes.map((n) => [n.role, n.depth]), [['machine', 0], ['session', 1], ['session', 1], ['session', 1]]);
  // 两个工作区的会话都在，且没有工作区那一层。
  assert.deepEqual(nodes.slice(1).map((n) => n.label), ['s1', 's2', 's3']);
});

test('树形统计：全选是三级，会话跟随它自己所属的工作区', () => {
  const nodes = treeFor({ machine: true, workspace: true, session: true });
  assert.deepEqual(nodes.map((n) => [n.role, n.depth]), [
    ['machine', 0], ['workspace', 1], ['session', 2], ['session', 2], ['workspace', 1], ['session', 2],
  ]);
  assert.deepEqual(nodes.map((n) => n.label), ['整机合计', 'alpha', 's1', 's2', 'beta', 's3']);
});

test('树形统计：空选不渲染任何节点（不静默回退全机）', () => {
  assert.deepEqual(treeFor({ machine: false, workspace: false, session: false }), []);
});

test('树形统计：会话行带归档/读取失败标记，金额留「—」（会话级没有 kinds）', () => {
  const nodes = treeFor({ machine: false, workspace: true, session: true });
  assert.deepEqual(nodes[2].badges, ['已归档']);
  assert.equal(nodes[2].costText, '—');
  const failed = treeFor({ machine: true, workspace: false, session: true }).find((n) => n.label === 's3');
  assert.deepEqual(failed.badges, ['读取失败']);
});

test('取数计划：勾选组合决定要请求哪几种口径', () => {
  assert.deepEqual(I.statsFetchPlan({ machine: true, workspace: false, session: false }), { machine: true, workspaces: false, sessionOnly: false });
  assert.deepEqual(I.statsFetchPlan({ machine: false, workspace: true, session: false }), { machine: false, workspaces: true, sessionOnly: false });
  // 只勾会话：一次单会话查询就够（还带回 kinds，供下面的明细块用）。
  assert.deepEqual(I.statsFetchPlan({ machine: false, workspace: false, session: true }), { machine: false, workspaces: false, sessionOnly: true });
  // 整机+会话：必须拉 workspace 口径，否则只知道当前这一个会话。
  assert.deepEqual(I.statsFetchPlan({ machine: true, workspace: false, session: true }), { machine: true, workspaces: true, sessionOnly: false });
  assert.deepEqual(I.statsFetchPlan({ machine: true, workspace: true, session: true }), { machine: true, workspaces: true, sessionOnly: false });
  assert.deepEqual(I.statsFetchPlan({ machine: false, workspace: false, session: false }), { machine: false, workspaces: false, sessionOnly: false });
});

test('整机合计的金额：同币种相加，跨币种分行，积分型不冒充金额', () => {
  assert.equal(I.mergeCostText([money(1.5), money(0.5)], costLabels), '¥2.00');
  assert.equal(I.mergeCostText([money(1.5), { currency: 'USD', priced: true, amounts: { total: 2 } }], costLabels), '¥1.50 · $2.00');
  assert.equal(I.mergeCostText([{ currency: 'credit', priced: false, amounts: null }], costLabels), '按积分计费');
  assert.equal(I.mergeCostText([{ currency: 'free', priced: false, amounts: null }], costLabels), '免费');
  assert.equal(I.mergeCostText([], costLabels), '—');
});
