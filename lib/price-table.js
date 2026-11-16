/**
 * dsh-quota-usage — 统一价格表（每百万 tokens）。
 *
 * 本模块是**唯一的价格查询入口**：界面、金额计算、测试都从 `priceOf()` 取数，
 * 不再各写一份。
 *
 * 价格数据分两层：
 *   · `SEED_RECORDS`（旧名 `PRICE_RECORDS` 是它的别名）—— 出厂数据，随插件版本更新。
 *     渠道商在模型名后缀里标的价格、各家官方文档的按量计费快照、峰谷这类随时间变化的
 *     价格都在这里，共 103 条。
 *   · **运行时读取的是 lib/price-store.js 管理的存储**
 *     （`$DSH_HOME/storages/dsh-quota-usage/price-table.json`）——用户可以在配置页
 *     直接改它（用户口径：「直接改表」，不是覆盖层）。首次运行时把种子写进存储，之后
 *     以存储为准；改完不需要重启，下一次 `priceOf()` 就读到新价。
 *   所以本模块里 103 条是**种子**，不是运行时的事实来源；`priceOf()` 一律问 price-store。
 *
 * 与 lib/pricing.js 的关系（过渡期）：
 *   pricing.js 是既有的、按 provider 分组的快照（PRICE_TABLES），被 cost.js 与
 *   342 项现有测试依赖。本次**不改它**，先把它的 8 家数据原样搬进本表（来源标
 *   `official-doc`），两条路径共存；接线完成后再让 pricing.js 反向读取本表。
 *   在共存期内两份数据必须逐位一致——test/price-table.test.mjs 里有断言钉住
 *   这一点，改价时只改一处、另一处必须同步到测试仍然通过。
 *
 * 为什么必须按 渠道 × 模型 分组，而不是按模型去重：
 *   同一个模型在不同渠道价格不同（raccoon 的 GLM-5-3 是 x0.75，loomy 的
 *   GLM 5.3 Flash 是 x0.8；DeepSeek 官方 CNY 与 OpenRouter 网关 USD 更不是一回事），
 *   而且有些渠道根本不用官方价（Trae / qoder 按积分结算）。按模型去重会把两个
 *   渠道的账算成同一笔。
 *
 * 三种价格形态**互斥**（记录里只能出现一种，validateRecords 会在加载时校验）：
 *   · `uniform` —— 单一价，不分输入输出。渠道商在名字后缀里标 `· x3.0` 就是这种：
 *     它只说"这个模型每百万 token 多少钱"，没有输入/输出的区分。界面必须标注
 *     「该渠道只提供单一价」，不能凭空拆成输入价/输出价。
 *   · `input` / `output` / `cacheRead` 三槽 —— 分项价，可选峰谷两档。
 *   · `free: true` —— 免费，没有金额。
 *
 * 两种**动态**机制，彼此独立：
 *   · 峰谷（`schedule`）：只在分项价上生效。schedule 描述"贵"的时段
 *     （peakWindows 内走 standard，区间外走 offPeak）。没写 schedule、或该记录
 *     没有 offPeak 时全天同一价。
 *   · 促销（`promotion`）：记录原价与现价。`priceOf` 返回的是**现价**
 *     （prices.uniform 取 promotion.current），promotion 里保留 original 供界面
 *     显示"原价 x0.2 → 现价 x0.1"。促销与峰谷互不影响：促销只对 uniform 有数值
 *     含义（渠道商标的就是单一价），分项价上没有促销条目。
 *
 * 不猜价：表里没有的 渠道 × 模型 一律 `known:false`，界面显示「该渠道未提供价格」。
 * 尤其**不做**下列推断（这些数字全是维度标识，不是价格）：
 *   · 代数：Qwen 3.8 的 3.8、GLM-5.3 的 5.3、Kimi-K2.6 的 2.6、GPT-6 的 6；
 *   · 参数量：Qwen 3.8 27B 的 27B、Qwen 3.5 A3B 的 A3B；
 *   · 日期/版本：doubao-seed-2-1-pro-260628、qwen3.5-plus-2026-04-20、deepseek-v4-flash-0731；
 *   · 上下文窗口：Custom 1M Text 的 1M；
 *   · 版本号：Explore Sub Agent V13 的 V13；
 *   · 档位名：None / Low / Medium / High / Extra（cline）、
 *     Standard / Professional / Ultimate / Auto / Performance / Efficient（qoder）。
 *
 * 数据来源与采集日期：`source` + `asOf` 逐条记录。厂商调价时种子随插件版本更新；
 * 用户在配置页改过的条目来源变为 `manual`、采集日期变成改价那天，原值留在 `seed*`
 * 字段里。不联网抓取、不做后台同步。
 *
 * 时区：峰谷判定按各记录 schedule 的 offsetMinutes（缺省 480 = 北京时间 UTC+8），
 * 不随部署机器时区变化。法定节假日表复用 pricing.js 的 HOLIDAY_RANGES，保证两个
 * 模块在"今天是不是高峰"上永远给同一个结论。
 */

import { HOLIDAY_RANGES, expandHolidayRanges, SHANGHAI_OFFSET_MS } from './pricing.js';
import {
  formOf,
  isFiniteNumber,
  loadTable,
  registerSeed,
  validateRecords,
} from './price-store.js';

/** 放假日期集合（与 pricing.js 同源，O(1) 查表）。 */
const HOLIDAY_DAYS = expandHolidayRanges(HOLIDAY_RANGES);

/** 默认时区偏移：北京时间（上海无夏令时）。 */
const DEFAULT_OFFSET_MINUTES = SHANGHAI_OFFSET_MS / 60000;

/**
 * DeepSeek 官方峰谷：工作日 9:00–12:00、14:00–18:00 为高峰，法定节假日与周末
 * 全天按空闲计价。三条官方路由（deepseek-official / deepseek-account / deepseek）
 * 共用这一份。
 */
const DEEPSEEK_SCHEDULE = {
  offsetMinutes: DEFAULT_OFFSET_MINUTES,
  peakWindows: [[9, 12], [14, 18]],
  peakDays: 'weekdays',
  holidays: true,
};

/**
 * OpenRouter 上个别模型的分时 overrides：形状与 DeepSeek 峰谷同构，但按 UTC 星期、
 * **不认**中国法定节假日（holidays: false）。同一个模型走官方路由与走网关，指示灯
 * 会在节假日给出相反结论——这是两条真实计费规则，不是 bug。
 */
const OPENROUTER_SCHEDULE = {
  offsetMinutes: DEFAULT_OFFSET_MINUTES,
  peakWindows: [[9, 12], [14, 18]],
  peakDays: 'weekdays',
  holidays: false,
};

/**
 * 全天一价的分项价：把 `{ input, output, cacheRead }` 展开成三槽 `{ standard }`。
 *
 * 分项价一律用 `{ standard, offPeak? }` 两档表达；没有峰谷差的模型只给 standard，
 * 这样"这个模型有没有峰谷"是数据本身的事实，而不是代码里的分支。
 */
function flatPrice(standard) {
  return {
    input: { standard: standard.input },
    output: { standard: standard.output },
    cacheRead: { standard: standard.cacheRead },
  };
}

/** 峰谷两档的分项价（三者都必须给 offPeak，缺一档就不是峰谷模型）。 */
function peakPrice(standard, offPeak) {
  return {
    input: { standard: standard.input, offPeak: offPeak.input },
    output: { standard: standard.output, offPeak: offPeak.output },
    cacheRead: { standard: standard.cacheRead, offPeak: offPeak.cacheRead },
  };
}

/**
 * 免费记录：没有金额，只有"免费"这个事实。
 *
 * currency 在这里表示**该渠道的计价币种**（便于界面统一渲染），不代表有金额；
 * form 为 'free'、prices 为 null 才是"免费"的真正判据。
 */
function freeRecord(provider, model, displayName, currency, asOf) {
  return { provider, model, displayName, currency, source: 'free', asOf, free: true };
}

// ───────────────────────────────────────────────────────────────────────────
// 1. DeepSeek 官方（source: official-doc，迁移自 lib/pricing.js）
//
// 三条官方路由共用同一份快照：deepseek-official / deepseek-account / deepseek。
// 每条记录的 provider 字段按路由展开，模型数据只写一份，避免三份抄错。
// ───────────────────────────────────────────────────────────────────────────

const DEEPSEEK_MODELS = [
  {
    model: 'deepseek-flash',
    displayName: 'DeepSeek Flash（官方）',
    ...peakPrice(
      { input: 2, output: 8, cacheRead: 0.04 },
      { input: 1, output: 4, cacheRead: 0.02 },
    ),
  },
  {
    model: 'deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro（官方）',
    ...peakPrice(
      { input: 9, output: 27, cacheRead: 0.3 },
      { input: 4.5, output: 13.5, cacheRead: 0.15 },
    ),
  },
  {
    // chat / reasoner 官方没有峰谷差价：两档同价，但仍是"有区间"的模型，
    // 界面照旧显示指示灯与倒计时（价格不变）。
    model: 'deepseek-chat',
    displayName: 'DeepSeek Chat（官方）',
    ...peakPrice(
      { input: 2, output: 8, cacheRead: 0.5 },
      { input: 2, output: 8, cacheRead: 0.5 },
    ),
  },
  {
    model: 'deepseek-reasoner',
    displayName: 'DeepSeek Reasoner（官方）',
    ...peakPrice(
      { input: 4, output: 16, cacheRead: 1 },
      { input: 4, output: 16, cacheRead: 1 },
    ),
  },
];

const DEEPSEEK_RECORDS = ['deepseek-official', 'deepseek-account', 'deepseek'].flatMap((provider) =>
  DEEPSEEK_MODELS.map((entry) => ({
    provider,
    model: entry.model,
    displayName: entry.displayName,
    currency: 'CNY',
    source: 'official-doc',
    asOf: '2026-09-10',
    input: entry.input,
    output: entry.output,
    cacheRead: entry.cacheRead,
    schedule: DEEPSEEK_SCHEDULE,
  })));

// ───────────────────────────────────────────────────────────────────────────
// 2. 各家官方按量计费快照（source: official-doc，迁移自 lib/pricing.js）
//
// 币种按**一个站点**的口径维护——同一个模型 id 在不同站点价格不同，混用会与账单不符：
//   · Moonshot / Kimi、Z.ai 取国际站美元价；
//   · MiniMax 分 minimax（.io，美元）与 minimax-cn（.cn，人民币）；
//   · OpenRouter 是网关聚合价，记的是默认路由价，实际结算按响应里的上游 provider。
// ───────────────────────────────────────────────────────────────────────────

/** Moonshot / Kimi：platform.kimi.ai 国际站（USD）。国内站 kimi.com 是人民币价，本表不混用。 */
const MOONSHOTAI_ROWS = [
  ['kimi-k3.1-pro', { input: 2, output: 10, cacheRead: 0.2 }],
  ['kimi-k3.1-pro-highspeed', { input: 4, output: 20, cacheRead: 0.2 }],
  ['kimi-k3', { input: 3, output: 15, cacheRead: 0.3 }],
  ['kimi-k2.7-code', { input: 0.95, output: 4, cacheRead: 0.19 }],
  ['kimi-k2.7-code-highspeed', { input: 1.9, output: 8, cacheRead: 0.38 }],
  ['kimi-k2.6', { input: 0.95, output: 4, cacheRead: 0.16 }],
];

/** Z.ai / 智谱：docs.z.ai 国际站（USD）。BigModel 人民币价另有一份，本表不混用。 */
const ZAI_ROWS = [
  ['glm-5.3', { input: 1.4, output: 4.4, cacheRead: 0.26 }],
  ['glm-5.3-flash', { input: 0.15, output: 0.5, cacheRead: 0.03 }],
  ['glm-5.3-flashx', { input: 0.37, output: 1.25, cacheRead: 0.075 }],
  ['glm-5.2', { input: 1.4, output: 4.4, cacheRead: 0.26 }],
  ['glm-5.1', { input: 1.4, output: 4.4, cacheRead: 0.26 }],
  ['glm-5', { input: 1, output: 3.2, cacheRead: 0.2 }],
  ['glm-4.7', { input: 0.6, output: 2.2, cacheRead: 0.11 }],
  ['glm-4.7-flashx', { input: 0.07, output: 0.4, cacheRead: 0.01 }],
  ['glm-4.6', { input: 0.6, output: 2.2, cacheRead: 0.11 }],
  ['glm-4.6v', { input: 0.3, output: 0.9, cacheRead: 0.05 }],
  ['glm-4.5', { input: 0.6, output: 2.2, cacheRead: 0.11 }],
  ['glm-4.5-air', { input: 0.2, output: 1.1, cacheRead: 0.03 }],
];

/** MiniMax 国际站（platform.minimax.io，USD）。 */
const MINIMAX_ROWS = [
  ['minimax-m3.1-flash', { input: 0.15, output: 0.6, cacheRead: 0.015 }],
  // M3 按输入长度分档（≤512k / >512k）与 priority 服务等级加价；这里取默认档
  //（≤512k、标准服务），长上下文/优先服务会与账单有出入。
  ['minimax-m3', { input: 0.3, output: 1.2, cacheRead: 0.06 }],
];

/** MiniMax 国内站（platform.minimax.cn，人民币）。 */
const MINIMAX_CN_ROWS = [
  ['minimax-m3.1-flash', { input: 1, output: 4, cacheRead: 0.1 }],
  ['minimax-m3', { input: 2.1, output: 8.4, cacheRead: 0.42 }],
];

/**
 * OpenRouter 网关聚合价（USD）。
 *
 * ⚠️ 这里**不包含** `deepseek/deepseek-v4.1-flash-1017`：它有分时 overrides，
 * 单独由下面的 OPENROUTER_PEAK_RECORD 表达（同一 渠道×模型 只能有一条记录，
 * 否则加载自检会报重复）。
 */
const OPENROUTER_ROWS = [
  ['deepseek/deepseek-v4.1-flash', { input: 0.14, output: 0.42, cacheRead: 0.0042 }],
  ['claude-sonnet-5.5', { input: 2, output: 10, cacheRead: 0.1 }],
  ['gpt-6.1-sol', { input: 2, output: 10, cacheRead: 0.1 }],
  ['gemini-3.8-flash', { input: 0.825, output: 4.125, cacheRead: 0.0825 }],
  ['grok-4.7', { input: 2, output: 6, cacheRead: 0.5 }],
  ['glm-4.6', { input: 0.55, output: 2.2, cacheRead: 0.11 }],
  ['minimax-m3.1-flash', { input: 0.15, output: 0.6, cacheRead: 0.015 }],
];

/** 把「模型 + 价目」行列表展开成全天一价的记录。 */
function flatRecords(provider, currency, asOf, rows) {
  return rows.map(([model, price]) => ({
    provider,
    model,
    displayName: model,
    currency,
    source: 'official-doc',
    asOf,
    ...flatPrice(price),
  }));
}

const OFFICIAL_RECORDS = [
  ...flatRecords('moonshotai', 'USD', '2026-10-27', MOONSHOTAI_ROWS),
  ...flatRecords('zai', 'USD', '2026-10-27', ZAI_ROWS),
  ...flatRecords('minimax', 'USD', '2026-10-27', MINIMAX_ROWS),
  ...flatRecords('minimax-cn', 'CNY', '2026-10-27', MINIMAX_CN_ROWS),
  ...flatRecords('openrouter', 'USD', '2026-10-27', OPENROUTER_ROWS),
];

/**
 * OpenRouter 的 `deepseek/deepseek-v4.1-flash-1017` 有分时 overrides：工作日
 * 01–04、06–10（UTC）为贵的一侧，周末全天便宜。它是本表里唯一带 offPeak 的网关模型，
 * 因此单独列一条并挂上 schedule（记录级 schedule，不是 provider 级）。
 */
const OPENROUTER_PEAK_RECORD = {
  provider: 'openrouter',
  model: 'deepseek/deepseek-v4.1-flash-1017',
  displayName: 'deepseek/deepseek-v4.1-flash-1017（网关分时价）',
  currency: 'USD',
  source: 'official-doc',
  asOf: '2026-10-27',
  ...peakPrice(
    { input: 0.3, output: 1.2, cacheRead: 0.006 },
    { input: 0.15, output: 0.6, cacheRead: 0.003 },
  ),
  schedule: OPENROUTER_SCHEDULE,
};

// ───────────────────────────────────────────────────────────────────────────
// 3. 渠道名后缀里标的价格（source: name-suffix，单一价）
//
// 这些渠道商把价格直接写在模型展示名里（` · x3.0`，`·` 是 U+00B7 中点）。
// **只有一个数字 ⇒ 只有单一价**：它没有区分输入/输出，所以记录形态是 uniform，
// 界面必须标注「该渠道只提供单一价」，不能拆成输入价/输出价。
//
// 数据来源：dsh-free-model/vendor/channel-pack/src/{loomy,raccoon}-product.ts 的
// 兜底模型目录（2026-11-14 采集）。
// ───────────────────────────────────────────────────────────────────────────

/** loomy（讯飞）的倍率后缀：8 条，全部是单一价（元/百万 token）。 */
const LOOMY_UNIFORM = [
  ['deepseek-v4-flash-0731', 'DeepSeek V4 Flash 0731 · x3.0', 3.0],
  ['MiniMax-M3', 'MiniMax M3 · x4.0', 4.0],
  ['Kimi-k2.6', 'Kimi k2.6 · x6.5', 6.5],
  ['qwen-3.8-max', 'Qwen 3.8 Max · x12.0', 12.0],
  ['GLM-5.3-Flash', 'GLM 5.3 Flash · x0.8', 0.8],
  ['qwen3.8-flash', 'qwen 3.8 flash · x0.8', 0.8],
  ['spark-x', 'Spark X2.5 · x0.1', 0.1],
  ['mimo-v2.5', 'MiMo V2.5 · x3.3', 3.3],
];

const LOOMY_RECORDS = LOOMY_UNIFORM.map(([model, displayName, price]) => ({
  provider: 'loomy',
  model,
  displayName,
  currency: 'CNY',
  source: 'name-suffix',
  asOf: '2026-11-14',
  uniform: price,
}));

/**
 * raccoon 的倍率后缀：4 条有价的单一价记录（另 2 条 `· 免费` 走 freeRecord）。
 *
 * `sn-glm-5-3-flash` 的展示名是 `· x0.2→x0.1`：这个渠道正在做促销，原价 0.2、
 * 现价 0.1。`uniform` 记**现价**（生效价，与"这个模型现在多少钱"一致），原价放进
 * promotion 供界面显示 `x0.2→x0.1`。两者刻意都写，是为了让"单独看 uniform 也是
 * 对的"——任何只读 uniform 的消费方不会拿到过期价。
 */
const RACCOON_RECORDS = [
  {
    provider: 'raccoon',
    model: 'sn-glm-5-3',
    displayName: 'GLM-5-3 · x0.75',
    currency: 'CNY',
    source: 'name-suffix',
    asOf: '2026-11-14',
    uniform: 0.75,
  },
  {
    provider: 'raccoon',
    model: 'sn-kimi-k3',
    // ⚠️ 1 倍也要显示（用户报障「为什么 Kimi-K3 没有倍率」）—— 展示名保留 x1。
    displayName: 'Kimi-K3 · x1',
    currency: 'CNY',
    source: 'name-suffix',
    asOf: '2026-11-14',
    uniform: 1,
  },
  {
    provider: 'raccoon',
    model: 'sn-glm-5-3-flash',
    displayName: 'GLM-5-3-Flash · x0.2→x0.1',
    currency: 'CNY',
    source: 'name-suffix',
    asOf: '2026-11-14',
    uniform: 0.1,
    promotion: { original: 0.2, current: 0.1, from: null, until: null },
  },
  {
    provider: 'raccoon',
    model: 'sn-deepseek-v4-1-flash',
    displayName: 'DeepSeek-V4.1-Flash · x0.25',
    currency: 'CNY',
    source: 'name-suffix',
    asOf: '2026-11-14',
    uniform: 0.25,
  },
];

// ───────────────────────────────────────────────────────────────────────────
// 4. 免费（source: free）
//
// raccoon 两个 `· 免费`（远端 billing_effective_multiplier = 0）+ opencode 的
// 匿名免费通道。免费是**已知结论**（known:true, form:'free'），不是"不知道"——
// 界面据此显示「免费」，而不是「该渠道未提供价格」。
// ───────────────────────────────────────────────────────────────────────────

const RACCOON_FREE = [
  freeRecord('raccoon', 'sn-sensenova-6-8-flash', 'SenseNova-6.8-Flash · 免费', 'CNY', '2026-11-14'),
  freeRecord('raccoon', 'sn-sensenova-6-8-flash-lite', 'SenseNova-6.8-Flash-Lite · 免费', 'CNY', '2026-11-14'),
];

/**
 * opencode 的免费模型（`isFree: true` = 匿名通道可用）。
 *
 * ⚠️ `big-pickle` 的 id 里**没有** `free` 字样，但 `isFree` 为 true，展示名也不带
 * Free —— 只按名字里有没有 "Free" 筛选会漏掉它。这里以 `isFree` 标记为准。
 * 数据来源：channel-pack/src/opencode-product.ts 的 OPENCODE_FALLBACK_MODELS。
 */
const OPENCODE_FREE_IDS = [
  ['big-pickle', 'Big Pickle'],
  ['space-bunny-free', 'Space Bunny Free'],
  ['longcat-2.5-preview-free', 'LongCat 2.5 Preview Free'],
  ['mimo-v2.6-flash-free', 'MiMo-V2.6-Flash Free'],
  ['mimo-v2.5-free', 'MiMo-V2.5 Free'],
  ['nemotron-3-ultra-free', 'Nemotron 3 Ultra Free'],
  ['nemotron-3.5-lightning-free', 'Nemotron 3.5 Lightning Free'],
];

const OPENCODE_FREE = OPENCODE_FREE_IDS.map(([model, displayName]) =>
  freeRecord('opencode', model, displayName, 'USD', '2026-11-14'));

// ───────────────────────────────────────────────────────────────────────────
// 5. 跨渠道镜像（source: official-doc + mirrors）
//
// Trae / qoder / qodercn / officeace 这些渠道本身**按积分结算**，没有公布货币单价；
// 但它们目录里的 GLM / Kimi / DeepSeek / MiniMax 模型与官方按量计费表能精确对上。
// 这里按官方价填入，`mirrors` 标出对应关系，币种沿用**官方站点**的币种。
//
// ⚠️ 这不是"该渠道公布的价格"：它回答的是"这个模型在官方站点卖多少钱"，与积分
// 扣费不是一回事。界面必须用 mirrors 说明这是官方参考价，不能当成该渠道的账单。
// 对应不上的（Trae 的 Sagitta / Aquila / Custom *、qoder 的 Auto / 档位名、
// Qwen 系列官方表里压根没有）一律留空，不猜。
// ───────────────────────────────────────────────────────────────────────────

/** 从已迁移的官方记录里取一份价目，供镜像复用（避免第三次抄写数字）。 */
function officialPriceOf(provider, model) {
  const found = OFFICIAL_RECORDS.find((entry) => entry.provider === provider && entry.model === model)
    ?? DEEPSEEK_RECORDS.find((entry) => entry.provider === provider && entry.model === model);
  if (found === undefined) {
    throw new Error(`price-table: 镜像引用了不存在的官方条目 ${provider}/${model}`);
  }
  return found;
}

/**
 * 造一条镜像记录：价目、币种、asOf 全部取官方条目，只换 provider / model /
 * displayName，并挂上 mirrors 说明对应关系。
 */
function mirrorRecord(provider, model, displayName, officialProvider, officialModel) {
  const official = officialPriceOf(officialProvider, officialModel);
  const record = {
    provider,
    model,
    displayName,
    currency: official.currency,
    source: 'official-doc',
    asOf: official.asOf,
    mirrors: `${officialProvider}/${officialModel}`,
  };
  if (official.input !== undefined) {
    record.input = official.input;
    record.output = official.output;
    record.cacheRead = official.cacheRead;
    if (official.schedule !== undefined) record.schedule = official.schedule;
  }
  return record;
}

const MIRROR_ROWS = [
  // Trae（积分渠道；模型目录见 channel-pack/src/trae-product.ts）
  ['trae', 'DeepSeek-V4-Flash-Official', 'DeepSeek V4 Flash Official（对应官方 deepseek-flash 价）', 'deepseek-official', 'deepseek-flash'],
  ['trae', 'DeepSeek-V4-Flash', 'DeepSeek V4 Flash（对应官方 deepseek-flash 价）', 'deepseek-official', 'deepseek-flash'],
  ['trae', 'DeepSeek-V4-Pro', 'DeepSeek V4 Pro（对应官方 deepseek-v4-pro 价）', 'deepseek-official', 'deepseek-v4-pro'],
  ['trae', 'glm-5.2', 'GLM-5.2（对应 Z.ai 官方价）', 'zai', 'glm-5.2'],
  ['trae', 'glm-5', 'GLM-5（对应 Z.ai 官方价）', 'zai', 'glm-5'],
  ['trae', 'kimi-k3', 'Kimi K3（对应 Moonshot 官方价）', 'moonshotai', 'kimi-k3'],
  ['trae', 'kimi-k2.7-code', 'Kimi K2.7 Code（对应 Moonshot 官方价）', 'moonshotai', 'kimi-k2.7-code'],
  ['trae', 'kimi-k2.6', 'Kimi K2.6（对应 Moonshot 官方价）', 'moonshotai', 'kimi-k2.6'],
  ['trae', 'minimax-m3', 'MiniMax M3（对应 MiniMax 官方价）', 'minimax', 'minimax-m3'],

  // qoder（国际站，积分渠道；模型目录见 channel-pack/src/qoder-product.ts）
  ['qoder', 'gmodel', 'GLM-5.3（对应 Z.ai 官方价）', 'zai', 'glm-5.3'],
  ['qoder', 'gfmodel', 'GLM-5.3-Flash（对应 Z.ai 官方价）', 'zai', 'glm-5.3-flash'],
  ['qoder', 'gm51model', 'GLM-5.2（对应 Z.ai 官方价）', 'zai', 'glm-5.2'],
  ['qoder', 'dmodel', 'DeepSeek-V4-Pro（对应官方 deepseek-v4-pro 价）', 'deepseek-official', 'deepseek-v4-pro'],
  ['qoder', 'dfmodel', 'DeepSeek-Flash（对应官方 deepseek-flash 价）', 'deepseek-official', 'deepseek-flash'],
  ['qoder', 'kmodel_latest', 'Kimi-K3（对应 Moonshot 官方价）', 'moonshotai', 'kimi-k3'],
  ['qoder', 'mmodel', 'MiniMax-M3（对应 MiniMax 官方价）', 'minimax', 'minimax-m3'],

  // qodercn（国内站，模型 id 与国际站部分重合）
  ['qodercn', 'gmodel', 'GLM-5.3（对应 Z.ai 官方价）', 'zai', 'glm-5.3'],
  ['qodercn', 'gfmodel', 'GLM-5.3-Flash（对应 Z.ai 官方价）', 'zai', 'glm-5.3-flash'],
  ['qodercn', 'gm51model', 'GLM-5.2（对应 Z.ai 官方价）', 'zai', 'glm-5.2'],
  ['qodercn', 'dmodel', 'DeepSeek-V4-Pro（对应官方 deepseek-v4-pro 价）', 'deepseek-official', 'deepseek-v4-pro'],
  ['qodercn', 'dfmodel', 'DeepSeek-Flash（对应官方 deepseek-flash 价）', 'deepseek-official', 'deepseek-flash'],
  ['qodercn', 'kmodel_latest', 'Kimi-K3（对应 Moonshot 官方价）', 'moonshotai', 'kimi-k3'],

  // officeace（模型目录见 channel-pack/src/officeace-product.ts）
  ['officeace', 'glm-5.3', 'GLM-5.3（对应 Z.ai 官方价）', 'zai', 'glm-5.3'],
  ['officeace', 'glm-5.2', 'GLM-5.2（对应 Z.ai 官方价）', 'zai', 'glm-5.2'],
  ['officeace', 'glm-5.1', 'GLM-5.1（对应 Z.ai 官方价）', 'zai', 'glm-5.1'],
  ['officeace', 'kimi-k2.6', 'Kimi-K2.6（对应 Moonshot 官方价）', 'moonshotai', 'kimi-k2.6'],
  // officeace 的 deepseek-v4-flash 对应官方别名（deepseek-v4-flash → deepseek-flash）。
  ['officeace', 'deepseek-v4-flash', 'DeepSeek-V4-Flash（对应官方 deepseek-flash 价）', 'deepseek-official', 'deepseek-flash'],

  // ── DeepSeek V4.1 Flash 的跨渠道别名组 ──
  //
  // 官方把这个模型发布为 `deepseek-flash`，各家渠道用不同的 id / 展示名指向同一个
  // 模型。用户口径：「单价只跟模型有关」——这些渠道都只是在调用同一个模型，价格按
  // 厂商官方价算，不看调用它的渠道。因此全部指向 deepseek-official/deepseek-flash。
  //
  // 各家写法（来源：channel-pack/src/*product.ts；trae 的取自真实会话日志）：
  //   · `deepseek-v4.1-flash`      —— 日志实测 id；trae / buddy / officeace /
  //                                   opencode / workbuddy 的 id 都是这个小写连字符形式
  //   · `DeepSeek-V4.1-Flash`      —— officeace 的展示名、trae 的连字符大驼峰写法
  //   · `DeepSeek V4.1 Flash`      —— opencode / accio 的展示名
  //   · `Deepseek-V4.1-Flash`      —— CodeBuddy(199) / WorkBuddy(340) 的展示名
  //   · `1Nova-Q3xM8vJ1rH6z`       —— accio 的混淆 id（展示名是上面那行）
  //
  // 为什么 id 与展示名都要登记：日志里 `message.source.model` 装的是**远端下发的
  // 那个字符串**，可能是 id 也可能是展示名（渠道把二者混用的不少），而 priceOf 对
  // model 是精确匹配、不做大小写或连字符归一。少登记一个写法，那个渠道就继续显示
  // 「按积分计费」。
  //
  // ⚠️ 本组**只**收 V4.1：
  //   · `deepseek-v4-flash`（V4，无 `.1`）是另一个模型，不并入本组（既有条目不动）；
  //   · raccoon 的 `sn-deepseek-v4-1-flash` 是渠道自有定价（x0.25），属上面的
  //     RACCOON_RECORDS（source: name-suffix），**绝不**出现在本组。它与这里的
  //     镜像记录是不同的 渠道×模型 键（`sn-` 前缀），因此不会被官方价覆盖——渠道
  //     自有价优先是"两条记录互不相干"的自然结果，不需要额外的优先级判断。
  //     test/price-table.test.mjs 有专门用例钉死这条。
  //   · `deepseek-v4.1-flash-sg`（WorkBuddy 的新加坡区域变体）区域定价可能不同，
  //     表里没有依据，按「不猜价」留空。
  ['trae', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash（对应官方 deepseek-flash 价）', 'deepseek-official', 'deepseek-flash'],
  ['trae', 'DeepSeek-V4.1-Flash', 'DeepSeek V4.1 Flash（对应官方 deepseek-flash 价）', 'deepseek-official', 'deepseek-flash'],
  ['trae', 'DeepSeek V4.1 Flash', 'DeepSeek V4.1 Flash（对应官方 deepseek-flash 价）', 'deepseek-official', 'deepseek-flash'],
  ['buddy', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash（对应官方 deepseek-flash 价）', 'deepseek-official', 'deepseek-flash'],
  ['buddy', 'Deepseek-V4.1-Flash', 'DeepSeek V4.1 Flash（对应官方 deepseek-flash 价）', 'deepseek-official', 'deepseek-flash'],
  ['officeace', 'deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash（对应官方 deepseek-flash 价）', 'deepseek-official', 'deepseek-flash'],
  ['officeace', 'DeepSeek-V4.1-Flash', 'DeepSeek-V4.1-Flash（对应官方 deepseek-flash 价）', 'deepseek-official', 'deepseek-flash'],
  ['opencode', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash（对应官方 deepseek-flash 价）', 'deepseek-official', 'deepseek-flash'],
  ['opencode', 'DeepSeek V4.1 Flash', 'DeepSeek V4.1 Flash（对应官方 deepseek-flash 价）', 'deepseek-official', 'deepseek-flash'],
  ['accio', '1Nova-Q3xM8vJ1rH6z', 'DeepSeek V4.1 Flash（对应官方 deepseek-flash 价）', 'deepseek-official', 'deepseek-flash'],
  ['accio', 'DeepSeek V4.1 Flash', 'DeepSeek V4.1 Flash（对应官方 deepseek-flash 价）', 'deepseek-official', 'deepseek-flash'],
  ['workbuddy', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash（对应官方 deepseek-flash 价）', 'deepseek-official', 'deepseek-flash'],
  ['workbuddy', 'Deepseek-V4.1-Flash', 'DeepSeek V4.1 Flash（对应官方 deepseek-flash 价）', 'deepseek-official', 'deepseek-flash'],
];

const MIRROR_RECORDS = MIRROR_ROWS.map(([provider, model, displayName, officialProvider, officialModel]) =>
  mirrorRecord(provider, model, displayName, officialProvider, officialModel));

// ───────────────────────────────────────────────────────────────────────────
// 汇总
// ───────────────────────────────────────────────────────────────────────────

/**
 * 出厂种子记录：一条 = 一个 渠道 × 模型，共 103 条。
 *
 * 形态三选一（uniform / 分项 / free），互斥性由 price-store 的 validateRecords() 校验。
 *
 * ⚠️ 这是**种子**，不是运行时的事实来源：运行时读 price-store 里的那份可编辑表。
 *   种子只在「存储还不存在」和「用户调用 resetToSeed()」时被写进存储。
 */
export const SEED_RECORDS = [
  ...DEEPSEEK_RECORDS,
  ...OFFICIAL_RECORDS,
  OPENROUTER_PEAK_RECORD,
  ...LOOMY_RECORDS,
  ...RACCOON_RECORDS,
  ...RACCOON_FREE,
  ...OPENCODE_FREE,
  ...MIRROR_RECORDS,
];

/**
 * 旧名保留（语义已变成"种子"）：测试与既有消费方按这个名字读出厂数据。
 *
 * 这里刻意是**同一个数组对象**而不是拷贝——镜像记录的价目对象与官方条目共享引用，
 * 拷贝会悄悄造出第二份数字（test/price-table.test.mjs 用 Object.is 钉住了这一点）。
 */
export const PRICE_RECORDS = SEED_RECORDS;

/**
 * 把种子交给 price-store（模块级注册，只此一次）。
 *
 * price-store 不 import 本模块，所以这里靠**调用方注册**而不是循环依赖。
 * 必须在 SEED_RECORDS 求值之后调用——放在这个位置而不是文件末尾，是为了让
 * "注册"紧跟"定义"，改动时不容易漏。
 */
registerSeed(SEED_RECORDS);

// 价格形态判定（formOf）、记录校验（validateRecords）、source/currency 白名单都在
// lib/price-store.js —— 写入路径与读取路径共用同一份规则，本模块只 import 使用。

/**
 * 种子的自检结果；测试断言为空数组。
 *
 * 校验器在 lib/price-store.js：**写入路径（配置页保存）与读取路径（本模块）必须用同一份
 * 规则**，否则会出现"存得进去但取不出来"或"取出来的是没校验过的数据"。
 */
export const PRICE_RECORD_PROBLEMS = validateRecords(SEED_RECORDS);

/**
 * 当前生效的记录 + 索引，按表对象缓存。
 *
 * 为什么不在模块加载时建索引：表是**可编辑**的（用户改价要立刻生效），所以每次查询都问
 * 一次 `loadTable()`。它按文件 mtime + size 缓存，文件没变就返回同一个对象，这里于是
 * 直接命中，不会每条价格都重建一次 Map。
 *
 * 非法记录（validateRecords 挑出来的）不进索引——与改动前的行为一致：坏数据不该让整张
 * 表失效，但也不能被当成好数据用。
 *
 * @param {object} table loadTable() 的返回
 * @returns {{table: object, records: object[], index: Map<string, object>}}
 */
let indexCache = null;
function indexFor(table) {
  if (indexCache !== null && indexCache.table === table) return indexCache;
  const bad = new Set(table.problems.map((entry) => entry.record));
  const records = table.records.filter((record) => !bad.has(record));
  const index = new Map();
  for (const record of records) {
    index.set(`${record.provider.trim().toLowerCase()}\u0000${record.model.trim()}`, record);
  }
  indexCache = { table, records, index };
  return indexCache;
}

/**
 * 某时刻是否落在该 schedule 的"贵"的一侧（peakWindows 内，且不属于节假日/非工作日豁免）。
 *
 * 与 lib/pricing.js 的 inExpensiveWindow 同口径（同一份放假日期表、同样的
 * peakDays 默认值、同样的左闭右开区间）。它在本模块里是私有实现，因为
 * pricing.js 没有导出通用版本；test/price-table.test.mjs 用 DeepSeek 的 schedule
 * 与 pricing.isPeak 做逐小时对比，防止两份实现漂移。
 */
function inPeakWindow(atMs, schedule) {
  if (schedule === null || typeof schedule !== 'object') return false;
  const offset = isFiniteNumber(schedule.offsetMinutes) ? schedule.offsetMinutes : DEFAULT_OFFSET_MINUTES;
  const local = new Date(atMs + offset * 60000);
  const hour = local.getUTCHours();
  const dow = local.getUTCDay();
  const weekday = dow !== 0 && dow !== 6;
  if (schedule.holidays === true && HOLIDAY_DAYS.has(local.toISOString().slice(0, 10))) return false;
  if ((schedule.peakDays ?? 'everyday') === 'weekdays' && !weekday) return false;
  if (!Array.isArray(schedule.peakWindows)) return false;
  return schedule.peakWindows.some(([start, end]) => hour >= start && hour < end);
}

/** 按当前区间取一档：贵的一侧用 standard，便宜的一侧优先 offPeak。 */
function pickSlot(slot, peak) {
  if (slot === null || typeof slot !== 'object') return null;
  if (!peak && isFiniteNumber(slot.offPeak)) return slot.offPeak;
  return isFiniteNumber(slot.standard) ? slot.standard : null;
}

/** 查不到时的统一返回：没有数字，但把"问的是谁"带回去，便于排查。 */
function unknownResult(provider, model) {
  return {
    known: false,
    currency: 'CNY',
    form: 'unknown',
    prices: null,
    schedule: null,
    promotion: null,
    // 没有记录就没有来源与采集日期——不给默认值，null 表示"不知道"。
    source: null,
    asOf: null,
    mirrors: null,
    window: null,
    provider,
    model,
  };
}

/**
 * 某 渠道 × 模型在某一时刻的单位价格（每百万 tokens）。
 *
 * 这是本模块唯一的取价入口。返回结构（所有形态同形，用 `form` 区分怎么读）：
 *
 *   {
 *     known: boolean,                  // 有没有这条 渠道×模型 的记录
 *     currency: 'CNY'|'USD',
 *     form: 'uniform'|'split'|'free'|'unknown',
 *     prices: { uniform } | { input, output, cacheRead } | null,
 *     schedule: {...}|null,            // 峰谷时段（仅 split 且该模型有 offPeak）
 *     promotion: {...}|null,           // 促销原价（仅 uniform 且该条在促销）
 *     source: 'name-suffix'|'official-doc'|'manual'|'free'|null,
 *     asOf: 'YYYY-MM-DD'|null,
 *     mirrors: 'provider/model'|null,   // 跨渠道镜像时指向官方条目
 *     window: 'peak'|'idle'|null,       // 此刻处在峰谷的哪一侧
 *     provider, model,
 *   }
 *
 * 形态与 prices 的对应（互斥，不会同时出现两种）：
 *   · 'uniform' → prices = { uniform: <现价> }。渠道只给了一个数字，没有输入/输出
 *     之分；界面要标注「该渠道只提供单一价」，金额按 单价 × 全部 token 算。
 *   · 'split'   → prices = { input, output, cacheRead }，按 schedule 判峰谷取档。
 *   · 'free'    → prices = null，但 known 为 true：免费是**已知结论**，不是不知道。
 *   · 'unknown' → known = false, prices = null：该渠道未提供价格。
 *
 * @param {string} provider 渠道 id（大小写、首尾空白无关）
 * @param {string} model 渠道内的模型 id（精确匹配；本模块不做别名，别名在 pricing.js）
 * @param {number} atMs 定价时刻（ms），缺省 now；只影响有 schedule 的模型取哪一档
 * @returns {object} 见上
 */
export function priceOf(provider, model, atMs) {
  const providerId = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  const modelId = typeof model === 'string' ? model.trim() : '';
  const at = isFiniteNumber(atMs) ? atMs : Date.now();

  // 每次查询都问一次存储：用户改价后下一次统计就要生效（不需要重启）。
  // loadTable() 自己在文件没变时命中缓存，所以这里不是"每取一次价读一次盘"。
  const { index } = indexFor(loadTable());
  const record = providerId === '' || modelId === ''
    ? null
    : index.get(`${providerId}\u0000${modelId}`) ?? null;
  if (record === null) return unknownResult(providerId, modelId);

  const form = formOf(record);
  const base = {
    known: true,
    currency: record.currency,
    form,
    prices: null,
    // schedule / promotion 只在有数值含义的形态上返回，避免界面读到不生效的字段。
    schedule: null,
    promotion: null,
    source: record.source,
    asOf: record.asOf,
    mirrors: record.mirrors ?? null,
    window: null,
    provider: providerId,
    model: modelId,
  };

  if (form === 'free') return base;

  if (form === 'uniform') {
    // 促销：返回**现价**。promotion.current 与 uniform 的一致性在加载时已校验，
    // 这里仍然优先 current —— 它是促销口径的唯一权威。
    const effective = record.promotion !== undefined && isFiniteNumber(record.promotion.current)
      ? record.promotion.current
      : record.uniform;
    return {
      ...base,
      prices: { uniform: effective },
      promotion: record.promotion !== undefined
        ? {
          original: record.promotion.original,
          current: record.promotion.current,
          from: record.promotion.from ?? null,
          until: record.promotion.until ?? null,
        }
        : null,
    };
  }

  // split：按 schedule 判峰谷。没有 schedule 的记录全天同一价（peak 恒为 true 的
  // 语义是"取 standard"，因为 pickSlot 只在 !peak 时才用 offPeak）。
  const schedule = record.schedule ?? null;
  const peak = inPeakWindow(at, schedule);
  return {
    ...base,
    prices: {
      input: pickSlot(record.input, peak),
      output: pickSlot(record.output, peak),
      cacheRead: pickSlot(record.cacheRead, peak),
    },
    schedule,
    window: schedule === null ? null : (peak ? 'peak' : 'idle'),
  };
}

/**
 * 该 渠道 × 模型 是否有价格记录（含免费）。
 *
 * 与 `priceOf(...).known` 同口径，只是省掉取价的开销；界面用它决定要不要显示
 * 「该渠道未提供价格」。
 */
export function hasPriceRecord(provider, model) {
  const providerId = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  const modelId = typeof model === 'string' ? model.trim() : '';
  if (providerId === '' || modelId === '') return false;
  return indexFor(loadTable()).index.has(`${providerId}\u0000${modelId}`);
}

/**
 * 某渠道录了哪些模型（按录入顺序）。
 *
 * 供设置页/诊断列出"这个渠道有价可查的模型"，也让测试能按渠道统计覆盖率。
 * 顺序取自存储（= 种子顺序，配置页新加的记录追加在末尾）。
 */
export function modelsOf(provider) {
  const providerId = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  if (providerId === '') return [];
  return indexFor(loadTable()).records
    .filter((record) => record.provider.trim().toLowerCase() === providerId)
    .map((record) => record.model);
}

/**
 * 当前生效的整张表（给配置页/诊断用）：{records, source, storePath, updatedAt, notices, problems}。
 *
 * `source` 说明这份数据从哪来：`store`（用户的存储）/ `seed`（首次落盘）/
 * `seed-fallback`（存储坏了，回落种子并报告）/ `seed-unregistered`（种子还没注册）。
 */
export function currentTable() {
  return loadTable();
}

// 配置页要用的写入口与三字段视图：统一从本模块取，调用方不必知道存储层的存在。
// （实现都在 lib/price-store.js：写入路径与读取路径必须共用同一份校验与形态规则。）
export {
  listRecords,
  resetToSeed,
  saveRecord,
  saveRecord as savePriceRecord,
  recordKey,
  storePath,
  unifiedPricesOf,
  withUnifiedPrices,
} from './price-store.js';
