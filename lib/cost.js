/**
 * dsh-quota-usage — 用量 → 金额（单价 / 输入价 / 输出价 / 总额）。
 *
 * 为什么单独一个模块，而不是塞进 usage.js 或 pricing.js：
 *   · lib/usage.js 只回答"用了多少 token"，不知道价格；lib/pricing.js 只回答"某一刻
 *     单价多少"，不知道用量。金额是两者的乘积，写进任何一边都会让那一边多背一份与
 *     自身职责无关的失败模式（缺价 / 缺 token 字段 / 币种不一致）。
 *   · 金额算错比没有金额更糟：卡片上写着"¥0.00"会让用户以为这次对话没花钱。所以本模块
 *     每一条不确定路径都返回 null 而不是 0，由界面决定怎么显示"未知"。
 *
 * 三条硬口径：
 *   1. 价格只按 provider + 模型 id 查既有的事实源（用户改过的可编辑价格表
 *      lib/price-table.js，其次旧快照 lib/pricing.js）。本模块不写第二份价格，也不做
 *      家族猜测（表里没有就是不知道），避免"插件价"与"账单价"两个真相。
 *   2. 单价单位是"每百万 token 的金额"，所以金额 = tokens × 单价 ÷ 1e6。
 *   3. 峰谷时段不在这里判定：直接问 pricing.quoteAt 要当前区间的单价（它已按 provider 的
 *      schedule、北京时间、法定节假日算好，并给出 window 与下一次翻转）。本模块自己重算
 *      时段就会和卡片的峰谷指示灯给出相反结论。
 *
 * 币种：按"这条 渠道×模型 有没有价格"这个**事实**分派，先问可编辑价格表
 * （lib/price-table.js，按 渠道×模型 收录；其中 `source === 'manual'` 的记录——
 * 即用户在配置页改过的价——优先级最高，见 costOfModel），再回落旧快照表
 * （lib/pricing.js）。
 *   · 两表都查不到 —— 这家的 token 不换算成钱。免费渠道（Buddy / CodeArts …）按积分
 *     结算，订阅型按周期付费，都不走 token 付费；currency 给 'credit'，含义是"没有可
 *     换算的真金白银单价"。把它们显示成"已花 ¥0.00"是在骗人。
 *     ⚠️ 'credit' 只留给这种情形：新表收录了某渠道的个别模型，不代表整家渠道改用货币计价。
 *   · 有价且形态是 uniform / split —— currency 取记录的币种（CNY / USD），金额可算。
 *   · 价格表写明免费 —— currency 给 'free'，界面显示「免费」。这既不是 ¥0.00
 *     （那是"花了 0 元"），也不是 'credit'（免费不需要积分），必须单列。
 *   · 查得到这家但缺这个模型的价（例如 moonshotai 上刚发布的新模型）—— 这家确实按钱
 *     计费，只是这个模型的价没采到。currency 给 'unknown'：既不能说 'credit'（那是
 *     "不花真钱"的假话），也不能沿用 quoteAt 兜底里写死的 'CNY'（会把美元表说成人民币）。
 *     `priced` 字段负责区分这种 unknown：true = 有表但缺这个模型，false = 整家没有表。
 *
 * 枚举因此被扩到 'CNY' | 'USD' | 'credit' | 'unknown' | 'free'（+'mixed'，见 aggregateCost）。
 * 它们给界面的含义各不相同：'credit' → 「按积分计费」、'free' → 「免费」、
 * 'unknown' → 「暂无定价」/「该渠道未提供价格」（按 priced 分），都不显示假金额。
 *
 * 精度：分项各自舍入到 4 位小数，合计按**已舍入的分项**求和再舍入。这样
 * "总额 = 分项之和"这条恒等式不会被浮点尾巴（0.30000000000000004）打破；代价是合计与
 * "原始值直接求和"最多差 0.0001×4，对账展示无所谓，恒等式更要紧。
 *
 * 时段与历史聚合的近似：atMs 只表达"按哪一刻的单价算"。把跨月的历史汇总用单一时刻定价，
 * 等于假设这段时间全在同一计费区间——对 DeepSeek 这类峰谷两价的提供商必然与账单有出入。
 * 需要精确时按时间段切片后再调 costOfModel（模型节点带 firstAt/lastAt，可据此切）。
 */

import * as pricing from './pricing.js';
import { priceOf as recordPriceOf } from './price-table.js';

/** 金额保留的小数位数。 */
const DECIMALS = 4;

/** 单价单位：与 pricing.js 的"每百万 tokens"对应（不是"每 token"）。 */
const UNIT = 'perMillionTokens';

/**
 * 四舍五入到 4 位小数。
 *
 * 用 toFixed 而不是 `Math.round(x * 1e4) / 1e4`：后者对大数（几十万元累计）会因为 1e4 的
 * 二进制放大误差在最后一位抖动；toFixed 走的是十进制舍入。
 */
function round4(value) {
  return Number(value.toFixed(DECIMALS));
}

/** 容忍字符串/数字；缺失、NaN、负数一律 0（"没记录"就是 0 个 token）。 */
function count(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  return 0;
}

/** 从 usage.js 的累加器（或形状相近的对象）里取出四个计费分项。 */
function tokenCountsOf(tokens) {
  const source = tokens !== null && typeof tokens === 'object' ? tokens : {};
  return {
    inputTokens: count(source.inputTokens),
    outputTokens: count(source.outputTokens),
    cacheReadTokens: count(source.cacheReadTokens),
    cacheWriteTokens: count(source.cacheWriteTokens),
    // 上游报告的 token 总数。单一价渠道（渠道只给一个数字，不分输入输出）要按它算，
    // 不能拿四个分项相加顶替：reasoning 等 token 可能只体现在总数里。
    reportedTotalTokens: count(source.totalTokens),
  };
}

/**
 * 单行金额：token × 单价 ÷ 1e6。
 *
 * tokens 为 0 时直接给 0——这是真实的 0 元，不是"不知道"。
 * 真的用了 token 但快照里没有这条单价（例如某模型没写缓存读价）时给 null：拿 0 顶替等于
 * 白送，会让总额偏小且看不出来。
 */
function amountOf(tokens, price) {
  if (tokens === 0) return 0;
  if (typeof price !== 'number' || !Number.isFinite(price)) return null;
  return round4((tokens * price) / 1e6);
}

/**
 * 某 provider 的价格快照元信息：有没有表、表是哪天采的。
 *
 * 两个事实分开问，因为它们回答的问题不同：
 *   · `hasPriceTable` = "这家到底按不按钱算" —— 决定 currency 该是 credit 还是真实币种；
 *   · `asOfOf`        = "这个价是哪天采的" —— 决定界面该不该提示"价格可能过期"。
 * 有表但表里没写日期时 priced 仍为 true、asOf 为 null，这是合法组合（能计价但不知道日期）。
 *
 * 两个函数都由 pricing.js 导出（不要自己从 quoteAt 的兜底值反推：兜底把 currency 写死成
 * 'CNY'，对有美元表的 provider 会得出错误结论）。调用包一层 try：pricing 是数据快照模块，
 * 万一它将来在异常入参上抛错，"不知道"比让整条金额链崩掉好。
 */
function snapshotOf(provider, model) {
  // 先问统一价格表：它按 provider × model 收录，能覆盖 pricing.js 没有的渠道
  // （trae / raccoon / loomy / qoder / opencode 这些）。判定必须是**模型级**的：
  // 只问"这家有没有表"会把"这家有别的模型的价"误当成"这个模型的价也查过"，
  // 于是新表收录了某渠道的个别模型，整家渠道就再也回不到 credit —— 那与事实不符。
  try {
    const record = recordPriceOf(provider, model, Date.now());
    if (record !== null && record.known === true) {
      return {
        // 免费是"已知"但不花真钱：priced 为 false，而 known 由 fromRecord 自己给。
        priced: record.form === 'uniform' || record.form === 'split',
        asOf: snapshotAsOf(provider, record),
        source: typeof record.source === 'string' && record.source !== '' ? record.source : null,
      };
    }
  } catch {
    /* 新表异常时回落旧表：金额链不能因为一张表读失败就整条崩掉 */
  }
  // 旧表兜底：保持向后兼容，现有 8 家官方价仍走这条路。
  let priced = false;
  try {
    priced = pricing.hasPriceTable(provider) === true;
  } catch {
    priced = false;
  }
  if (!priced) return { priced: false, asOf: null, source: null };
  try {
    const value = pricing.asOfOf(provider);
    return { priced: true, asOf: typeof value === 'string' && value !== '' ? value : null, source: 'official-doc' };
  } catch {
    return { priced: true, asOf: null, source: 'official-doc' };
  }
}

/**
 * 快照日期：旧表有这家时**以旧表为准**。
 *
 * 两张表对同一家 provider 都可能写日期（实测 deepseek / moonshotai / zai / minimax /
 * openrouter 两边一致，但那是采集结果碰巧同步，不是恒等式）。同一家在两处显示两个
 * 快照日期会让用户无法判断该信哪一个，所以定一个来源优先级，而不是"谁先查到来算谁"。
 */
function snapshotAsOf(provider, record) {
  try {
    if (pricing.hasPriceTable(provider) === true) {
      const value = pricing.asOfOf(provider);
      if (typeof value === 'string' && value !== '') return value;
    }
  } catch {
    /* 旧表读不到就用新记录自己的日期 */
  }
  return typeof record.asOf === 'string' && record.asOf !== '' ? record.asOf : null;
}

/**
 * 用户手工改过的价格记录的快照事实。
 *
 * 为什么不能沿用 `snapshotOf()`：它对 deepseek / moonshotai / zai / minimax / openrouter
 * 这 8 家会**以旧表为准**给出 asOf（厂商文档的采集日期）。可 manual 记录的日期是
 * **用户改价那天**，两者的含义完全不同：把用户昨天手填的价标成"厂商 2026-09-10 采的价"
 * 是在给用户一个错的溯源信息，而且卡片（priceOf）显示的是改价日，两处会打架。
 *
 * 所以 manual 分支自己造一份快照：priced 由记录形态决定，asOf 只用记录自己的日期。
 *
 * @param {object} record price-table.priceOf() 的返回（已确认 source === 'manual'）
 * @returns {{priced: boolean, asOf: string|null, source: 'manual'}}
 */
function manualSnapshot(record) {
  return {
    // 与 fromRecord 同口径：uniform / split 才是真金白银，free 不是。
    priced: record.form === 'uniform' || record.form === 'split',
    asOf: typeof record.asOf === 'string' && record.asOf !== '' ? record.asOf : null,
    source: 'manual',
  };
}

/** 全 null 金额：一条分项都没有可算的数（未知模型 / 无价渠道）。 */
function nullAmounts() {
  return { input: null, cacheRead: null, cacheWrite: null, output: null, total: null };
}

/** 0 起点累加器（用于求和）。 */
function emptyAmounts() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
}

/**
 * 把 b 并入 a。逐项舍入、合计由分项相加得到，
 * 保证多次 addAmounts 之后仍然满足"合计 = 分项之和"。
 *
 * ⚠️ b 可以是 `amountOfUniform` 产物（分项全 null、只有 total），此时分项相加会把
 * 合计算成 0 —— 单一价渠道的金额就是这么被静默抹掉的。所以这里分开处理：
 *   · 分项可加（b.input 等是数字）→ 照旧累加，total 由分项重算；
 *   · 整笔只有 total（单一价）→ 单独累进 `uniformTotal`，最终再加进 total。
 * 两条路都走时（一个 provider 下既有分项价模型又有单一价模型），total 是两者之和，
 * 但 `input`/`output` 只反映分项部分——单一价拆不出输入输出，硬摊一个值是在编数字。
 */
function addAmounts(target, b) {
  target.input = round4(target.input + b.input);
  target.cacheRead = round4(target.cacheRead + b.cacheRead);
  target.cacheWrite = round4(target.cacheWrite + b.cacheWrite);
  target.output = round4(target.output + b.output);
  // 单一价部分的累计（分项为 null 的整笔）。
  target.uniformTotal = round4((target.uniformTotal ?? 0) + (b.total !== null && b.input === null ? b.total : 0));
  target.total = round4(target.input + target.cacheRead + target.cacheWrite + target.output + target.uniformTotal);
  return target;
}

/**
 * 单一价（渠道只给一个数字）的金额：`uniform × totalTokens / 1e6`。
 *
 * 为什么用 totalTokens 而不是四个分项相加：单一价渠道**没有**输入/输出之分，它按
 * "总共过了多少 token"计价。上游报告的 totalTokens 还包含 reasoning 等不落在四个
 * 分项里的 token，拿分项相加会把这部分漏掉、金额偏小且看不出来。
 *
 * 上游没给 totalTokens 时才退回分项之和——那是唯一能算的情况，不是默认口径。
 *
 * @returns {{ input: null, cacheRead: null, cacheWrite: null, output: null, total: number }}
 *   分项恒为 null：单一价拆不出输入/输出成本，编一个出来就是在骗人。
 */
function uniformAmount(used, uniform) {
  const tokens = used.reportedTotalTokens > 0
    ? used.reportedTotalTokens
    : used.inputTokens + used.outputTokens + used.cacheReadTokens + used.cacheWriteTokens;
  return {
    input: null,
    cacheRead: null,
    cacheWrite: null,
    output: null,
    // tokens 为 0 时 amountOf 给 0（真实 0 元，不是未知），与分项口径一致。
    total: amountOf(tokens, uniform),
  };
}

/**
 * 统一价格表命中时的返回（供 costOfModel 在 pricing.js 查不到时接手）。
 *
 * 与分项路径的差别只有三处，其余字段同形，调用方可以按同一套字段读：
 *   · `form` 标明怎么解读 `prices`（uniform / split / free）；
 *   · uniform 形态下 `cost` 只有 total，分项恒为 null（单一价拆不出输入输出）；
 *   · free 形态下 `cost` 全 null 而 `known` 为 true —— 免费是已知结论，不是不知道。
 *
 * @param {object} record price-table.priceOf() 的返回
 * @param {object} used tokenCountsOf() 的结果
 * @param {string} providerId 规范化后的 provider
 * @param {string} modelId 请求的模型 id
 * @param {{ priced: boolean, asOf: string|null }} snapshot 该 provider 的既有快照事实
 */
function fromRecord(record, used, providerId, modelId, snapshot) {
  const base = {
    known: true,
    // priced = "这条 token 能不能换算成真金白银"：
    //   · uniform / split —— 有真实币种单价，true（哪怕该 provider 在 pricing.js 里
    //     没有快照：loomy 的单一价、trae 的官方镜像价都是真钱）；
    //   · free —— 免费，没有金额，false。
    // 不再沿用 snapshot.priced：那问的是"有没有 pricing.js 快照"，与本表的结论无关，
    // 混用会出现 priced:false 却给出 currency:'CNY' 金额的自相矛盾返回。
    priced: record.form === 'uniform' || record.form === 'split',
    currency: record.currency,
    unit: UNIT,
    form: record.form,
    // 渠道只给了一个数字时，界面必须能一眼看出"不分输入输出"。
    singlePrice: record.form === 'uniform',
    window: record.window ?? null,
    // asOf 走 snapshotOf 定好的优先级（旧表有这家就以旧表为准，否则用记录自己的日期），
    // 保证同一家 provider 在卡片与统计两处不会出现两个快照日期。
    asOf: snapshot.asOf ?? record.asOf ?? null,
    provider: providerId,
    model: modelId,
    requested: modelId,
    via: 'exact',
    promotion: record.promotion ?? null,
    mirrors: record.mirrors ?? null,
    source: record.source ?? null,
  };

  if (record.form === 'free') {
    // 免费：价格与金额都是"没有数字"，但 known 为 true，界面据 form 显示「免费」。
    // currency 给 'free' 而不是记录里的 CNY/USD：免费渠道没有任何金额，
    // 沿用币种会让下游把"免费"当成"0 元人民币"，正是本次要消灭的假信息。
    return {
      ...base,
      currency: 'free',
      prices: { uniform: null, input: null, cacheRead: null, cacheWrite: null, output: null },
      cost: nullAmounts(),
    };
  }

  if (record.form === 'uniform') {
    const uniform = record.prices === null ? null : record.prices.uniform;
    return {
      ...base,
      // 四个分项键恒为 null，只给 uniform：单一价拆不出输入/输出，留 null 比编数字诚实。
      prices: {
        uniform: Number.isFinite(uniform) ? uniform : null,
        input: null,
        cacheRead: null,
        cacheWrite: null,
        output: null,
      },
      cost: Number.isFinite(uniform) ? uniformAmount(used, uniform) : nullAmounts(),
    };
  }

  // split：记录已按 schedule 判好峰谷，这里只做乘法。
  const prices = {
    uniform: null,
    input: Number.isFinite(record.prices.input) ? record.prices.input : null,
    cacheRead: Number.isFinite(record.prices.cacheRead) ? record.prices.cacheRead : null,
    // 价格表不收 cacheWrite（渠道没有这一项），按 0 计，与 pricing.js 补 0 的口径一致。
    cacheWrite: 0,
    output: Number.isFinite(record.prices.output) ? record.prices.output : null,
  };
  const cost = {
    input: amountOf(used.inputTokens, prices.input),
    cacheRead: amountOf(used.cacheReadTokens, prices.cacheRead),
    cacheWrite: amountOf(used.cacheWriteTokens, prices.cacheWrite),
    output: amountOf(used.outputTokens, prices.output),
    total: null,
  };
  cost.total = cost.input === null || cost.cacheRead === null
    || cost.cacheWrite === null || cost.output === null
    ? null
    : round4(cost.input + cost.cacheRead + cost.cacheWrite + cost.output);
  return { ...base, prices, cost };
}

/**
 * 某 provider 上的某模型在某一时刻的实际花费。
 *
 * 取价顺序（三条路径，结果同形）：
 *   0. **用户手工改过的记录**（`price-table.priceOf` 且 `source === 'manual'`）——
 *      配置页把新价写进存储后，统计必须立刻按新价算。这一条排在最前面，因为
 *      `pricing.js` 收录了 deepseek-official / deepseek-account / deepseek / moonshotai /
 *      zai / minimax / minimax-cn / openrouter 这 8 家，`quoteAt` 对它们恒 known:true，
 *      排在它后面的任何分支都没机会读到用户的新价（改价后金额纹丝不动就是这么来的）。
 *      闸门是 `source === 'manual'`：**只有被用户改过的条目**才接管，没改过的
 *      （official-doc / name-suffix / free）继续走下面两条，行为逐字节不变。
 *   1. `pricing.quoteAt` —— 既有快照（DeepSeek / Moonshot / Z.ai / MiniMax /
 *      OpenRouter）。这条路径原样保留，别名解析、峰谷、币种语义都不动。
 *   2. `price-table.priceOf` —— 统一价格表。接管 pricing.js 查不到的 渠道 × 模型：
 *      渠道名后缀的单一价（loomy / raccoon）、免费（raccoon / opencode）、以及
 *      能对应到官方价的跨渠道镜像（trae / qoder / officeace）。
 *
 * 三条都查不到时仍是 known:false，且 `priced` / `currency` 完全沿用 pricing.js 的
 * 既有事实——统一价格表收录了某渠道的个别模型，不代表这个渠道整体改用货币计价。
 *
 * @param {string} provider provider id（大小写无关；未知 provider 一律 known:false）
 * @param {string} model 模型 id
 * @param {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number,
 *   cacheWriteTokens?: number, totalTokens?: number }} tokens 用量分项
 * @param {number} atMs 定价时刻（ms），缺省 now；决定峰谷取哪一档
 * @returns {{
 *   known: boolean, priced: boolean,
 *   currency: 'CNY'|'USD'|'credit'|'unknown', unit: 'perMillionTokens',
 *   form: 'split'|'uniform'|'free'|'unknown', singlePrice: boolean,
 *   prices: object|null, cost: object,
 *   window: 'peak'|'idle'|null, asOf: string|null,
 *   provider: string, model: string, requested: string,
 *   via: 'exact'|'alias'|'fallback',
 *   promotion: object|null, mirrors: string|null, source: string|null
 * }}
 *   known=false 时 prices 与 cost 全为 null（不是 0）：免费/订阅渠道不花真钱，但
 *   "已花 0 元"是错误信息。
 *   form='uniform' 时 cost.total = uniform × totalTokens ÷ 1e6，分项为 null。
 *   form='free' 时 known=true 而 cost 全 null，界面据 form 显示「免费」。
 */
export function costOfModel(provider, model, tokens, atMs) {
  const at = Number.isFinite(atMs) ? atMs : Date.now();
  const used = tokenCountsOf(tokens);
  const providerId = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  const modelId = typeof model === 'string' ? model.trim() : '';

  // 第 0 步：问存储层「这条 渠道×模型 有没有用户手改过的价」。
  // 一次读取同时服务下面两个分支，所以只查一次（loadTable 按 mtime+size 命中缓存）。
  let record = null;
  try {
    record = recordPriceOf(providerId, modelId, at);
  } catch {
    // 新表异常时按"没有记录"处理：金额链不能因为一张表读失败就整条崩掉。
    record = null;
  }
  // ── manual 闸门 ──
  // `record.source === 'manual'` 是关键：只有**用户改过**的条目才跳过后面的
  // pricing.quoteAt。种子记录（official-doc / name-suffix / free）不满足这个条件，
  // 继续走原路径，输出与改动前逐字节相同——包括峰谷、别名解析、币种语义。
  if (record !== null && record.known === true && record.source === 'manual') {
    // 形态交给 fromRecord 判（uniform 走 uniformTotal 口径、split 走分项、free 无金额）。
    // 快照事实用 manualSnapshot：日期取**改价那天**，不沿用厂商文档的采集日期。
    return fromRecord(record, used, providerId, modelId, manualSnapshot(record));
  }

  const quote = pricing.quoteAt(model, at, provider);
  // 先问"这条 渠道×模型 有没有价格"这个事实，再谈这个模型在不在表里——两件事不能混。
  // 必须带 model：判定是模型级的，见 snapshotOf 的注释。
  const snapshot = snapshotOf(providerId, modelId);

  if (quote.known !== true) {
    // pricing.js 没有这条 → 问统一价格表（渠道后缀价 / 免费 / 跨渠道镜像）。
    // record 已经在上面查过一次，这里直接复用（同样的 provider/model/at，结果相同）。
    if (record !== null && record.known === true) {
      return fromRecord(record, used, providerId, modelId, snapshot);
    }
    return {
      known: false,
      priced: snapshot.priced,
      // 有表却缺这个模型的价：不能说 credit（那是"不花真钱"的假话），也不沿用
      // quoteAt 兜底里写死的 CNY，统一给 unknown，由 priced 区分两种"不知道"。
      currency: snapshot.priced ? 'unknown' : 'credit',
      unit: UNIT,
      form: 'unknown',
      singlePrice: false,
      prices: { input: null, cacheRead: null, cacheWrite: null, output: null },
      cost: nullAmounts(),
      window: null,
      // 没有表就没有"快照日期"这回事，asOf 恒为 null（pricing.asOfOf 的语义）。
      asOf: snapshot.asOf,
      provider: providerId,
      model: modelId,
      requested: modelId,
      via: 'fallback',
      promotion: null,
      mirrors: null,
      source: null,
    };
  }

  // cacheWrite 在多数快照里没单列（官方暂不计费），quoteAt 已把它补成 0，照表算。
  const prices = {
    input: Number.isFinite(quote.input) ? quote.input : null,
    cacheRead: Number.isFinite(quote.cacheRead) ? quote.cacheRead : null,
    cacheWrite: Number.isFinite(quote.cacheWrite) ? quote.cacheWrite : 0,
    output: Number.isFinite(quote.output) ? quote.output : null,
  };

  const cost = {
    input: amountOf(used.inputTokens, prices.input),
    cacheRead: amountOf(used.cacheReadTokens, prices.cacheRead),
    cacheWrite: amountOf(used.cacheWriteTokens, prices.cacheWrite),
    output: amountOf(used.outputTokens, prices.output),
    total: null,
  };
  // 任何一行算不出来（用了 token 却没有该行单价）就整笔不给合计：部分分项相加得到的
  // "总额"比 null 更容易被误读成真实账单。
  cost.total = cost.input === null || cost.cacheRead === null
    || cost.cacheWrite === null || cost.output === null
    ? null
    : round4(cost.input + cost.cacheRead + cost.cacheWrite + cost.output);

  return {
    known: true,
    priced: true,
    // 走到这里说明 quoteAt 命中了真实条目，它返回的 currency 取自快照本身（不是兜底值），
    // 可以信；仍然兜一层 CNY 以防某张表没写 currency。
    currency: typeof quote.currency === 'string' && quote.currency !== '' ? quote.currency : 'CNY',
    unit: UNIT,
    // pricing.js 的快照恒为分项价（standard / offPeak 两档），形态标成 split。
    form: 'split',
    singlePrice: false,
    prices,
    cost,
    window: quote.window ?? null,
    // 走拿到真实条目的路径：asOf 一定来自快照（priced=true），不再受兜底值干扰。
    asOf: snapshot.asOf,
    provider: providerId,
    // quoteAt 会把别名解析到现名，界面据此知道"这个价其实来自现名"。
    model: typeof quote.model === 'string' && quote.model !== '' ? quote.model : modelId,
    requested: modelId,
    via: quote.via ?? 'exact',
    // 促销与镜像只存在于统一价格表；这条路径恒为 null，保持返回结构同形。
    promotion: null,
    mirrors: null,
    source: 'official-doc',
  };
}

/**
 * 把若干模型级金额合成一个合计（厂商级 / 类型级）。
 *
 * 关键决定：
 *   · 合计只覆盖**已知价格**的模型。只要有一个模型缺价，`known` 就是 false 且 `partial`
 *     为 true——让界面能说"部分模型无价"，而不是把合计当完整账单。
 *   · 跨币种**绝不相加**（CNY + USD 没有意义）。出现多个币种时 currency 为 'mixed'、
 *     amounts 为 null，由 byCurrency 给出各币种小计。
 *   · window / asOf 在多个模型不一致时给 null（"这段横跨两个计费区间 / 两张快照"，
 *     合并成一个值会误导）。
 *   · 金额字段名叫 amounts 而不是 cost：这些汇总节点本身挂在 `cost` 键下，内层再叫 cost
 *     会变成 `provider.cost.cost.total`，读的人一定会错。
 *   · `priced` 与模型级同口径：这一组里**有任何一条**来自有价格表的 provider，就为 true。
 *     它决定"一条都算不出钱"时的 currency：全都没表 → 'credit'（按积分/订阅计费），
 *     有表却全缺价 → 'unknown'（该模型暂无定价）。混在一起时只要有一家没表，就没法说
 *     这些 token 都按钱算，仍以 'unknown' 为准（'credit' 只在整组都没表时出现）。
 *   · 免费（form='free'）**不是币种也不参与金额聚合**：它 known=true 但没有数字。
 *     把它们算进币种集合会让「免费 + 人民币」被误判成 mixed，合计里还会多出一个
 *     'free' 桶。整组全免费时 currency 给 'free'（「免费」），
 *     免费与"查不到价"混在一起时给 'unknown'（不能因为有一半免费就谎称整组免费）。
 */
function aggregateCost(entries) {
  const known = entries.filter((entry) => entry !== null && entry.known === true);
  const partial = known.length > 0 && known.length < entries.length;
  const priced = entries.some((entry) => entry !== null && entry.priced === true);
  const base = {
    known: false,
    partial,
    priced,
    // 一条已知价格都没有时 currency 由 priced 决定，见上面的注释。
    currency: priced ? 'unknown' : 'credit',
    unit: UNIT,
    prices: null,
    amounts: null,
    byCurrency: null,
    window: null,
    asOf: null,
    via: 'sum',
  };
  // 一条已知价格都没有（订阅型/积分型渠道全走这条）：null 而不是 0。
  if (known.length === 0) return base;

  // 免费条目（form='free'）虽然 known=true，但**没有金额也不属于任何币种**：
  // 把它们算进 currencies 会让「免费 + 人民币」被误判成跨币种，合计里还会凭空多出
  // 一个 'free' 桶。所以金额聚合只覆盖真正能换算成钱的条目（payable）。
  const payable = known.filter((entry) => entry.priced === true && entry.currency !== 'free');
  const freeCount = known.filter((entry) => entry.form === 'free').length;

  if (payable.length === 0) {
    // 整组都算不出钱。三种情形要分开讲，不能一律说"按积分计费"：
    //   · 全部条目都是免费模型 → 'free'，界面显示「免费」（这是已知结论）；
    //   · 有免费也有查不到价的 → 'unknown'（只知道一部分，不能谎称全免费）；
    //   · 一条免费都没有 → 沿用旧口径：有表缺价 'unknown'，整组无表 'credit'。
    let currency = priced ? 'unknown' : 'credit';
    if (freeCount > 0) currency = freeCount === entries.length ? 'free' : 'unknown';
    return { ...base, known: !partial, currency };
  }

  const currencies = [...new Set(payable.map((entry) => entry.currency))];
  const windows = [...new Set(payable.map((entry) => entry.window))];
  const asOfs = [...new Set(payable.map((entry) => entry.asOf))];
  const window = windows.length === 1 ? windows[0] ?? null : null;
  const asOf = asOfs.length === 1 ? asOfs[0] ?? null : null;

  if (currencies.length > 1) {
    const byCurrency = {};
    for (const entry of payable) {
      const acc = byCurrency[entry.currency] ?? emptyAmounts();
      byCurrency[entry.currency] = addAmounts(acc, entry.cost);
    }
    return {
      ...base,
      known: !partial,
      currency: 'mixed',
      byCurrency,
      window,
      asOf,
    };
  }

  const amounts = payable.reduce((acc, entry) => addAmounts(acc, entry.cost), emptyAmounts());
  return {
    ...base,
    known: !partial,
    currency: currencies[0],
    amounts,
    window,
    asOf,
  };
}

/**
 * 给 usage.js 的一个计费类型块整体加上金额。
 *
 * 入参形状（lib/usage.js 的 summarize 产物，见其头部注释）：
 *   { kind, messages, inputTokens…, providers: [
 *       { provider, classified, inputTokens…, models: [ { model, inputTokens… } ] } ] }
 *
 * 出参：同样的结构，在**模型 / 厂商 / 类型**三级各加一个 `cost`：
 *   · models[i].cost    —— 与 costOfModel 的返回**同形**（含 prices / cost / window / asOf），
 *                          调用方可以用同一套字段读任意一级的模型价
 *   · providers[i].cost —— 该厂商下所有模型的合计（amounts / byCurrency）
 *   · block.cost        —— 该计费类型的合计（跨厂商，可能跨币种）
 *
 * 纯函数：usage.js 的汇总结果被 createUsageScanner 缓存着（scan() 复用同一个对象），就地
 * 改它会把金额泄漏到下一次读取，也让"不加金额"的视图拿到加过金额的对象。所以这里一律
 * 返回新对象（模型节点、provider 节点都是新的浅拷贝，token 字段原样带过去）。
 *
 * @param {object} kindBlock summarize() 产出的单个 kinds 元素
 * @param {number} atMs 定价时刻（ms），缺省 now
 * @returns {object|null} 入参不是对象时返回 null（调用方判空即可，不必 try/catch）
 */
export function costOfSummary(kindBlock, atMs) {
  if (kindBlock === null || typeof kindBlock !== 'object' || Array.isArray(kindBlock)) return null;
  const at = Number.isFinite(atMs) ? atMs : Date.now();
  const providers = Array.isArray(kindBlock.providers) ? kindBlock.providers : [];

  /** 所有模型级单价结果，留给类型级合计（跨厂商、可能跨币种）。 */
  const allModelCosts = [];
  const outProviders = [];

  for (const provider of providers) {
    const source = provider !== null && typeof provider === 'object' ? provider : {};
    const models = Array.isArray(source.models) ? source.models : [];
    const quotedModels = [];
    const providerModelCosts = [];
    for (const model of models) {
      const node = model !== null && typeof model === 'object' ? model : {};
      const cost = costOfModel(source.provider, node.model, node, at);
      providerModelCosts.push(cost);
      allModelCosts.push(cost);
      quotedModels.push({ ...node, cost });
    }
    outProviders.push({
      ...source,
      models: quotedModels,
      cost: aggregateCost(providerModelCosts),
    });
  }

  return {
    ...kindBlock,
    providers: outProviders,
    cost: aggregateCost(allModelCosts),
  };
}
