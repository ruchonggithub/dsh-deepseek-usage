// 金额计算的确定性断言：单价快照 × token 用量 → 分项金额与总额。
//
// 这些用例刻意钉死具体数字：金额算错是"看起来很正常"的错误（¥0.00 比空白更像真的），
// 只靠"总和等于分项之和"这类自洽断言抓不到单价取错区间、单位少乘/多乘 1e6 的问题。
import test from 'node:test';
import assert from 'node:assert/strict';

import { costOfModel, costOfSummary } from '../lib/cost.js';
import { asOfOf, hasPriceTable } from '../lib/pricing.js';

const at = (iso) => Date.parse(iso);
// 2026-10-22 周四 10:00（北京时间）= DeepSeek 高峰时段，取 standard 价。
const PEAK = at('2026-10-22T10:00:00+08:00');
// 同一周的周六 10:00：周末全天空闲，取 offPeak 价。
const WEEKEND = at('2026-10-24T10:00:00+08:00');

/** 断言一个金额是 4 位小数以内的有限数字（即没有浮点尾巴）。 */
function assertClean(value, label) {
  assert.equal(typeof value, 'number', `${label} 应为数字`);
  assert.ok(Number.isFinite(value), `${label} 应为有限数`);
  assert.equal(Number(value.toFixed(4)), value, `${label} 应最多 4 位小数，实际 ${value}`);
  assert.ok(!String(value).includes('000000'), `${label} 不应带浮点尾巴，实际 ${value}`);
}

test('已知模型：输入/输出/缓存分别按每百万 token 计价', () => {
  const result = costOfModel('deepseek-official', 'deepseek-flash', {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 0,
  }, PEAK);

  assert.equal(result.known, true);
  assert.equal(result.currency, 'CNY');
  assert.equal(result.unit, 'perMillionTokens');
  assert.equal(result.window, 'peak');
  // standard 价：input 2、cacheRead 0.04、output 8（每百万 tokens，元）
  assert.deepEqual(result.prices, { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 });
  assert.equal(result.cost.input, 2);
  assert.equal(result.cost.cacheRead, 0.04);
  assert.equal(result.cost.cacheWrite, 0);
  assert.equal(result.cost.output, 8);
  assert.equal(result.cost.total, 10.04);
  // 总额必须由分项相加得到
  assert.equal(
    result.cost.total,
    Number((result.cost.input + result.cost.cacheRead + result.cost.cacheWrite + result.cost.output).toFixed(4)),
  );
});

test('总量不是整百万时按比例换算（÷1e6，不是按 token 直接乘）', () => {
  const result = costOfModel('deepseek-official', 'deepseek-flash', {
    inputTokens: 500_000,
    outputTokens: 250_000,
    cacheReadTokens: 12_500,
    cacheWriteTokens: 0,
  }, PEAK);
  // 500k × 2 ÷ 1e6 = 1；250k × 8 ÷ 1e6 = 2；12.5k × 0.04 ÷ 1e6 = 0.0005
  assert.equal(result.cost.input, 1);
  assert.equal(result.cost.output, 2);
  assert.equal(result.cost.cacheRead, 0.0005);
  assert.equal(result.cost.total, 3.0005);
});

test('浮点尾巴被舍掉：0.1 + 0.2 得到 0.3 而不是 0.30000000000000004', () => {
  // 50k × 2 ÷ 1e6 = 0.1，25k × 8 ÷ 1e6 = 0.2，朴素相加是 0.30000000000000004
  const result = costOfModel('deepseek-official', 'deepseek-flash', {
    inputTokens: 50_000,
    outputTokens: 25_000,
  }, PEAK);
  assert.equal(result.cost.input, 0.1);
  assert.equal(result.cost.output, 0.2);
  assert.equal(result.cost.total, 0.3);
  assertClean(result.cost.total, 'total');

  // 更小的量级也不能被舍成 0.0001 里的浮点噪声
  const tiny = costOfModel('deepseek-official', 'deepseek-flash', {
    inputTokens: 3,
    outputTokens: 7,
    cacheReadTokens: 11,
  }, PEAK);
  for (const [key, value] of Object.entries(tiny.cost)) assertClean(value, `tiny.${key}`);
  assert.equal(
    tiny.cost.total,
    Number((tiny.cost.input + tiny.cost.cacheRead + tiny.cost.cacheWrite + tiny.cost.output).toFixed(4)),
  );
});

test('cacheWrite 照表算：快照写 0 就是 0，即使有 cacheWriteTokens', () => {
  const result = costOfModel('deepseek-official', 'deepseek-flash', {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 1_000_000,
  }, PEAK);
  assert.equal(result.prices.cacheWrite, 0);
  assert.equal(result.cost.cacheWrite, 0);
  assert.equal(result.cost.total, 0);
});

test('峰谷：高峰取 standard，周末取 offPeak（时段判定完全交给 quoteAt）', () => {
  const peak = costOfModel('deepseek-official', 'deepseek-flash', { inputTokens: 1_000_000 }, PEAK);
  assert.equal(peak.window, 'peak');
  assert.equal(peak.prices.input, 2);
  assert.equal(peak.prices.output, 8);
  assert.equal(peak.cost.total, 2);

  const idle = costOfModel('deepseek-official', 'deepseek-flash', { inputTokens: 1_000_000 }, WEEKEND);
  assert.equal(idle.window, 'idle');
  // offPeak 价：input 1、cacheRead 0.02、output 4
  assert.equal(idle.prices.input, 1);
  assert.equal(idle.prices.cacheRead, 0.02);
  assert.equal(idle.prices.output, 4);
  assert.equal(idle.cost.input, 1);
  assert.equal(idle.cost.total, 1);
});

test('没有 offPeak 的模型全天一价（window 为 null）', () => {
  const result = costOfModel('moonshotai', 'kimi-k3', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, PEAK);
  assert.equal(result.known, true);
  assert.equal(result.currency, 'USD');
  assert.equal(result.window, null);
  assert.equal(result.prices.input, 3);
  assert.equal(result.prices.output, 15);
  assert.equal(result.cost.total, 18);
});

test('未知模型：known:false、单价与金额全 null（绝不按 0 元算）', () => {
  const result = costOfModel('deepseek-official', 'deepseek-v5-pro', { inputTokens: 1_000_000 }, PEAK);
  assert.equal(result.known, false);
  assert.equal(result.via, 'fallback');
  assert.deepEqual(result.prices, { input: null, cacheRead: null, cacheWrite: null, output: null });
  // 关键：是 null，不是 0
  assert.deepEqual(result.cost, { input: null, cacheRead: null, cacheWrite: null, output: null, total: null });
  for (const value of Object.values(result.cost)) assert.notEqual(value, 0);
});

test('积分型渠道：currency 为 credit、cost 全 null、known:false', () => {
  // Trae / Buddy / Qoder / CodeArts 这些免费渠道按积分结算，PRICE_TABLES 里没有快照
  for (const provider of ['trae', 'buddy', 'qoder', 'codearts', 'cline', 'raccoon', 'gemini']) {
    const result = costOfModel(provider, 'claude-sonnet-5.5', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }, PEAK);
    assert.equal(result.known, false, `${provider} 不应有价格`);
    assert.equal(result.priced, false, `${provider} 没有价格表，priced 应为 false`);
    assert.equal(result.currency, 'credit', `${provider} 的币种应为 credit`);
    assert.equal(result.cost.total, null, `${provider} 的总额应为 null 而不是 0`);
    assert.equal(result.window, null);
  }
});

test('有快照的 provider 上的表外模型：currency 为 unknown（有表但缺这个模型的价）', () => {
  const result = costOfModel('moonshotai', 'kimi-k9-ultra', { inputTokens: 1_000_000 }, PEAK);
  assert.equal(result.known, false);
  // 这家确实按美元计费，只是这个模型没采到价：不能说 credit（"不花真钱"是假话），
  // 也不能沿用 pricing.quoteAt 兜底里写死的 CNY（会把美元表说成人民币）。
  assert.equal(result.priced, true, 'moonshotai 有价格表，priced 应为 true');
  assert.equal(result.currency, 'unknown');
  assert.equal(result.cost.total, null);
  // asOf 仍然取自该 provider 的快照：知道表是哪天的，只是表里没这个模型
  assert.equal(result.asOf, asOfOf('moonshotai'));
});

test('provider 缺失或大小写混乱不影响查表', () => {
  const upper = costOfModel('DeepSeek-Official', 'DEEPSEEK-FLASH', { inputTokens: 1_000_000 }, PEAK);
  assert.equal(upper.known, true);
  assert.equal(upper.cost.total, 2);

  const missing = costOfModel(undefined, 'deepseek-flash', { inputTokens: 1_000_000 }, PEAK);
  assert.equal(missing.known, false);
  assert.equal(missing.cost.total, null);
});

test('别名会归到现名并标出 via', () => {
  const result = costOfModel('deepseek-official', 'deepseek-v4-flash', { inputTokens: 1_000_000 }, PEAK);
  assert.equal(result.known, true);
  assert.equal(result.via, 'alias');
  assert.equal(result.model, 'deepseek-flash');
  assert.equal(result.requested, 'deepseek-v4-flash');
  assert.equal(result.cost.total, 2);
});

test('没有 token 记录时金额是 0（真实 0，不是未知）', () => {
  const result = costOfModel('deepseek-official', 'deepseek-flash', {}, PEAK);
  assert.equal(result.known, true);
  assert.equal(result.cost.total, 0);

  const noArg = costOfModel('deepseek-official', 'deepseek-flash', undefined, PEAK);
  assert.equal(noArg.cost.total, 0);
});

test('token 字段支持字符串数字，垃圾值当 0', () => {
  const result = costOfModel('deepseek-official', 'deepseek-flash', {
    inputTokens: '1000000',
    outputTokens: 'abc',
    cacheReadTokens: null,
    cacheWriteTokens: -5,
  }, PEAK);
  assert.equal(result.cost.input, 2);
  assert.equal(result.cost.output, 0);
  assert.equal(result.cost.cacheRead, 0);
  assert.equal(result.cost.cacheWrite, 0);
  assert.equal(result.cost.total, 2);
});

/** 造一个最小的 usage.js 计费类型块（形状与 summarize() 的产物一致）。 */
function kindBlock(kind, providers) {
  return { kind, messages: 1, inputTokens: 0, outputTokens: 0, providers };
}

function providerNode(provider, models) {
  return { provider, classified: true, messages: 1, inputTokens: 0, outputTokens: 0, models };
}

test('costOfSummary：模型 / 厂商 / 类型三级都带上金额', () => {
  const block = kindBlock('prepaid', [
    providerNode('deepseek-official', [
      { model: 'deepseek-flash', inputTokens: 1_000_000, outputTokens: 1_000_000 },
      { model: 'deepseek-v4-pro', inputTokens: 1_000_000, outputTokens: 0 },
    ]),
  ]);

  const out = costOfSummary(block, PEAK);
  assert.ok(out);
  assert.equal(out.kind, 'prepaid');
  const provider = out.providers[0];
  assert.equal(provider.provider, 'deepseek-official');

  // 模型级：与单独调 costOfModel 完全一致
  const flash = provider.models[0].cost;
  assert.deepEqual(flash, costOfModel('deepseek-official', 'deepseek-flash', {
    inputTokens: 1_000_000, outputTokens: 1_000_000,
  }, PEAK));
  assert.equal(flash.cost.total, 10);
  // v4-pro 高峰 standard：input 9、output 27
  assert.equal(provider.models[1].cost.cost.total, 9);

  // 厂商级 = 两个模型之和
  assert.equal(provider.cost.known, true);
  assert.equal(provider.cost.partial, false);
  assert.equal(provider.cost.currency, 'CNY');
  assert.equal(provider.cost.amounts.total, 19);
  assert.equal(provider.cost.amounts.input, 11);
  assert.equal(provider.cost.amounts.output, 8);

  // 类型级 = 厂商级之和
  assert.equal(out.cost.amounts.total, 19);
  assert.equal(out.cost.currency, 'CNY');
  assert.equal(out.cost.window, 'peak');
});

test('costOfSummary：token 字段原样保留（不丢统计口径）', () => {
  const block = kindBlock('prepaid', [
    providerNode('deepseek-official', [
      { model: 'deepseek-flash', inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 300, totalTokens: 3300 },
    ]),
  ]);
  const out = costOfSummary(block, PEAK);
  const model = out.providers[0].models[0];
  assert.equal(model.inputTokens, 1000);
  assert.equal(model.outputTokens, 2000);
  assert.equal(model.cacheReadTokens, 300);
  assert.equal(model.totalTokens, 3300);
  assert.equal(out.providers[0].inputTokens, 0, 'provider 自身的 token 字段不应被改写');
});

test('costOfSummary：积分型渠道整块无金额（null，不是 0）', () => {
  const block = kindBlock('credits', [
    providerNode('trae', [{ model: 'claude-sonnet-5.5', inputTokens: 1_000_000, outputTokens: 1_000_000 }]),
    providerNode('codearts', [{ model: 'deepseek-v4.1-flash', inputTokens: 500, outputTokens: 500 }]),
  ]);
  const out = costOfSummary(block, PEAK);

  assert.equal(out.providers[0].models[0].cost.known, false);
  assert.equal(out.providers[0].models[0].cost.currency, 'credit');
  assert.equal(out.providers[0].cost.known, false);
  assert.equal(out.providers[0].cost.amounts, null);
  assert.equal(out.providers[1].cost.amounts, null);

  assert.equal(out.cost.known, false);
  assert.equal(out.cost.currency, 'credit');
  assert.equal(out.cost.amounts, null);
  assert.notEqual(out.cost.amounts, 0);
});

test('costOfSummary：已知与未知模型混合时合计只算已知的，并标 partial', () => {
  const block = kindBlock('prepaid', [
    providerNode('deepseek-official', [
      { model: 'deepseek-flash', inputTokens: 1_000_000, outputTokens: 0 },   // 2 元
      { model: 'deepseek-v5-pro', inputTokens: 9_999_999, outputTokens: 9_999 }, // 无价
    ]),
  ]);
  const out = costOfSummary(block, PEAK);
  const provider = out.providers[0];

  assert.equal(provider.models[1].cost.known, false);
  assert.equal(provider.models[1].cost.cost.total, null);

  assert.equal(provider.cost.partial, true, '有模型无价时合计必须标 partial');
  assert.equal(provider.cost.known, false, '合计不完整，known 应为 false');
  // 已知部分的数字仍然给出，方便界面显示"部分 ¥2.00"
  assert.equal(provider.cost.amounts.total, 2);
  assert.equal(out.cost.partial, true);
});

test('costOfSummary：跨币种绝不相加，改给 byCurrency 小计', () => {
  const block = kindBlock('prepaid', [
    providerNode('deepseek-official', [
      { model: 'deepseek-flash', inputTokens: 1_000_000, outputTokens: 0 }, // 2 CNY
    ]),
    providerNode('moonshotai', [
      { model: 'kimi-k3', inputTokens: 1_000_000, outputTokens: 0 },       // 3 USD
    ]),
  ]);
  const out = costOfSummary(block, PEAK);

  // 单个厂商内部只有一个币种，照常给 amounts
  assert.equal(out.providers[0].cost.currency, 'CNY');
  assert.equal(out.providers[0].cost.amounts.total, 2);
  assert.equal(out.providers[1].cost.currency, 'USD');
  assert.equal(out.providers[1].cost.amounts.total, 3);

  // 类型级跨币种：不给金额，只给分币种小计
  assert.equal(out.cost.currency, 'mixed');
  assert.equal(out.cost.amounts, null);
  assert.equal(out.cost.byCurrency.CNY.total, 2);
  assert.equal(out.cost.byCurrency.USD.total, 3);
});

test('costOfSummary：window 不一致时合并成 null', () => {
  const block = kindBlock('prepaid', [
    providerNode('deepseek-official', [
      { model: 'deepseek-flash', inputTokens: 1_000_000 }, // 有 offPeak → window 'peak'
    ]),
    providerNode('moonshotai', [
      { model: 'kimi-k3', inputTokens: 1_000_000 },       // 全天一价 → window null
    ]),
  ]);
  const out = costOfSummary(block, PEAK);
  assert.equal(out.providers[0].cost.window, 'peak');
  assert.equal(out.providers[1].cost.window, null);
  assert.equal(out.cost.window, null, '多个模型时段不一致时不应合并出一个值');
});

test('costOfSummary 是纯函数：不改动入参', () => {
  const models = [{ model: 'deepseek-flash', inputTokens: 1_000_000, outputTokens: 0 }];
  const providers = [providerNode('deepseek-official', models)];
  const block = kindBlock('prepaid', providers);

  costOfSummary(block, PEAK);

  assert.equal(Object.prototype.hasOwnProperty.call(block, 'cost'), false, '不应给入参加 cost');
  assert.equal(Object.prototype.hasOwnProperty.call(providers[0], 'cost'), false, '不应改入参的 provider');
  assert.equal(Object.prototype.hasOwnProperty.call(models[0], 'cost'), false, '不应改入参的 model');
});

test('costOfSummary：形状异常的入参不抛错', () => {
  assert.equal(costOfSummary(null, PEAK), null);
  assert.equal(costOfSummary(undefined, PEAK), null);
  assert.equal(costOfSummary('prepaid', PEAK), null);
  assert.equal(costOfSummary([], PEAK), null);

  const bare = costOfSummary({ kind: 'prepaid' }, PEAK);
  assert.ok(bare);
  assert.deepEqual(bare.providers, []);
  assert.equal(bare.cost.known, false);
  assert.equal(bare.cost.amounts, null);

  // provider 里没有 models，或 model 项是 null
  const odd = costOfSummary(kindBlock('prepaid', [
    { provider: 'deepseek-official', models: undefined },
    { provider: 'deepseek-official', models: [null, { model: 'deepseek-flash', inputTokens: 1_000_000 }] },
  ]), PEAK);
  assert.equal(odd.providers[0].cost.amounts, null);
  assert.equal(odd.providers[1].models[0].cost.known, false);
  assert.equal(odd.providers[1].cost.amounts.total, 2);
});

test('asOf：已知模型的真实快照日期来自 pricing.asOfOf，不编日期', () => {
  const cases = [
    ['deepseek-official', 'deepseek-flash'],
    ['deepseek-account', 'deepseek-chat'],
    ['deepseek', 'deepseek-reasoner'],
    ['moonshotai', 'kimi-k3'],
    ['zai', 'glm-4.6'],
    ['minimax', 'minimax-m3'],
    ['minimax-cn', 'minimax-m3'],
    ['openrouter', 'claude-sonnet-5.5'],
  ];
  for (const [provider, model] of cases) {
    const result = costOfModel(provider, model, { inputTokens: 1_000_000 }, PEAK);
    assert.equal(result.known, true, `${provider}/${model} 应在表里`);
    assert.equal(result.priced, true, `${provider}/${model} 应有价格表`);
    // 必须与 pricing.asOfOf 完全一致（本模块只做转发，不自己算日期）
    assert.equal(result.asOf, asOfOf(provider), `${provider} 的 asOf 应等于 pricing.asOfOf`);
    assert.match(result.asOf, /^\d{4}-\d{2}-\d{2}$/, `${provider} 的 asOf 应是真实日期`);
    assert.equal(hasPriceTable(provider), true);
  }

  // 钉一个实测值：DeepSeek 官方快照是 2026-09-10
  assert.equal(
    costOfModel('deepseek-official', 'deepseek-flash', { inputTokens: 1 }, PEAK).asOf,
    '2026-09-10',
  );
});

test('asOf：积分型 / 无价格表的 provider 必须是 null（没有表就没有快照日期）', () => {
  // 验收要求：trae 等积分型 provider 的 asOf 必须是 null，不能编一个日期出来。
  //
  // ⚠️ 探针模型用 `kimi-k9-ultra`（表里压根没有的模型），不能用 `deepseek-v4.1-flash`：
  // 后者已在价格表里按官方价登记为镜像记录（trae / buddy / opencode / officeace /
  // accio / workbuddy 都有条目），拿它当"无价"样本会把"这个渠道有价"误判成"这张表坏了"。
  // 这条用例要钉的是"没有表就 no asOf"，与某个具体模型有没有登记无关。
  const noTable = ['trae', 'buddy', 'qodercn', 'qoder', 'codearts', 'cline', 'raccoon', 'coder',
    'zcode', 'lobsterai', 'loomy', 'officeace', 'accio', 'codebuddy', 'workbuddy', 'gemini',
    'codex-chatgpt', 'anthropic', 'kimi-coding', 'opencode', 'opencode-go', 'nope', ''];
  for (const provider of noTable) {
    const result = costOfModel(provider, 'kimi-k9-ultra', { inputTokens: 1_000_000 }, PEAK);
    assert.equal(hasPriceTable(provider), false, `${provider} 不应有价格表`);
    assert.equal(result.priced, false, `${provider} 的 priced 应为 false`);
    assert.equal(result.asOf, null, `${provider} 没有价格表，asOf 必须是 null`);
    assert.equal(result.currency, 'credit');
  }

  // asOfOf 对不存在的 provider 也返回 null
  assert.equal(asOfOf('nope'), null);
  // provider 缺失时同样不给日期
  assert.equal(costOfModel(undefined, 'deepseek-flash', { inputTokens: 1 }, PEAK).asOf, null);
});

test('priced 在汇总层：全无表时 credit，有表缺价时 unknown', () => {
  // 整组都没有价格表（积分型渠道）。
  // 模型用表里没有的 `kimi-k9-ultra`：`deepseek-v4.1-flash` 现在是镜像价条目，
  // 用它会让整组变成"有价"，测不到"全无表 → credit"这条分支。
  const credits = costOfSummary(kindBlock('credits', [
    providerNode('trae', [{ model: 'kimi-k9-ultra', inputTokens: 1_000_000 }]),
    providerNode('buddy', [{ model: 'kimi-k9-ultra', inputTokens: 1_000_000 }]),
  ]), PEAK);
  assert.equal(credits.cost.priced, false);
  assert.equal(credits.cost.currency, 'credit');
  assert.equal(credits.cost.asOf, null);

  // 有价格表但模型缺价
  const unknownModel = costOfSummary(kindBlock('prepaid', [
    providerNode('moonshotai', [{ model: 'kimi-k9-ultra', inputTokens: 1_000_000 }]),
  ]), PEAK);
  assert.equal(unknownModel.cost.priced, true);
  assert.equal(unknownModel.cost.currency, 'unknown');
  assert.equal(unknownModel.cost.amounts, null);

  // 已知模型：asOf 出现在汇总层，可直接展示"价格快照日期"
  const known = costOfSummary(kindBlock('prepaid', [
    providerNode('deepseek-official', [{ model: 'deepseek-flash', inputTokens: 1_000_000 }]),
  ]), PEAK);
  assert.equal(known.cost.asOf, '2026-09-10');
  assert.equal(known.providers[0].cost.asOf, '2026-09-10');
  assert.equal(known.providers[0].models[0].cost.asOf, '2026-09-10');
});

test('asOf 在多个模型来自不同快照时合并成 null', () => {
  const out = costOfSummary(kindBlock('prepaid', [
    providerNode('deepseek-official', [{ model: 'deepseek-flash', inputTokens: 1_000_000 }]),
    providerNode('moonshotai', [{ model: 'kimi-k3', inputTokens: 1_000_000 }]),
  ]), PEAK);
  assert.equal(out.providers[0].cost.asOf, '2026-09-10');
  assert.equal(out.providers[1].cost.asOf, asOfOf('moonshotai'));
  // 两张不同日期的快照混在一起时不该合并出一个日期
  assert.notEqual(asOfOf('moonshotai'), '2026-09-10', '用例前提：两家的快照日期不同');
  assert.equal(out.cost.asOf, null);
});
