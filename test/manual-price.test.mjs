// 「价格在统计时生效」的确定性断言：配置页改过的价，金额必须立刻跟着变。
//
// 用户报障的现场（实测过）：改价前 cost.total = 1；改价后存储层 priceOf 已经给出
// form=uniform uniform=99 source=manual，可 cost.total 仍是 1。根因在 lib/cost.js 的
// costOfModel 先问旧表 pricing.quoteAt()，而 pricing.js 收录了 deepseek-official /
// deepseek-account / deepseek / moonshotai / zai / minimax / minimax-cn / openrouter 这 8 家
// ——它们恰好是最需要按官方价核算的渠道，quoteAt 对它们恒 known:true，于是新表里的
// manual 记录一次都读不到。所以本文件第一条用例就是那个现场的最小复现。
//
// 这一组钉住七件事：
//   1. 改价生效（核心）：deepseek-flash 改 99 → cost.total 变 99；
//   2. 闸门是 source === 'manual'：同表里没改过的行，输出逐字段不变；
//   3. 8 家逐个改，每一家都要生效（漏一家就是漏一个渠道的钱）；
//   4. 改回原值 → 金额恢复；resetToSeed 连峰谷两档一起还原；
//   5. uniform 口径：三值相等后按「单价 × 全部 token」，分项恒为 null；
//   6. 峰谷：改价后两档同值 → 高峰/空闲金额相同，指示灯与 schedule 仍在；
//   7. 无存储：把环境变量指向不存在的路径 → 回落种子，与改前一致。
// 另外验证汇总层（aggregateCost）对 manual 记录也能正确聚合。
//
// ⚠️ 本文件用 DSH_QUOTA_USAGE_PRICE_STORE 把存储指到临时文件：既保证不与其它测试
//   文件互相干扰（node --test 并行跑多个文件），也**不会**写进真实 $DSH_HOME。环境变量
//   必须在 import 之前设置，所以下面用动态 import。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'dsh-manual-price-'));
const STORE_FILE = path.join(HOME, 'price-table.json');
process.env.DSH_QUOTA_USAGE_PRICE_STORE = STORE_FILE;

const store = await import('../lib/price-store.js');
const table = await import('../lib/price-table.js');
const cost = await import('../lib/cost.js');
const { todayInShanghai } = await import('../lib/credits.js');

after(() => {
  delete process.env[store.STORE_ENV];
  nodeFs.rmSync(HOME, { recursive: true, force: true });
});

/** 周四 10:00 北京时间：DeepSeek 高峰（input 2 / output 8 / cacheRead 0.04）。 */
const PEAK = Date.parse('2026-10-22T10:00:00+08:00');
/** 周四 13:00 北京时间：午休，空闲（input 1 / output 4 / cacheRead 0.02）。 */
const IDLE = Date.parse('2026-10-22T13:00:00+08:00');

/**
 * 1M token 的用量：totalTokens 与 inputTokens 同值。
 *
 * 这个形状是刻意选的——改价前（split）金额只乘 inputTokens，改价后（uniform）金额乘
 * totalTokens，两边都是 1M，于是「改价前 1 元 → 改价后 99 元」能被逐位比对，不会因为
 * 口径差异（分项之和 vs 上报总数）把问题混掉。
 */
const ONE_M = { inputTokens: 1_000_000, totalTokens: 1_000_000 };

/** 把存储恢复成出厂种子（也让 price-table 的索引缓存失效）。 */
function reset() {
  const out = store.resetToSeed();
  assert.equal(out.ok, true, 'resetToSeed 应成功');
}

/** 用配置页的三字段形态改价，并断言写入成功。 */
function editPrice(provider, model, input, output, cacheRead) {
  const saved = store.saveRecord({ provider, model, input, output, cacheRead });
  assert.equal(saved.ok, true, `${provider}/${model} 改价应成功：${saved.error ?? ''}`);
  return saved;
}

// ───────────────────────────────────────────────────────────────────────────
// 1. 核心：改价生效（用户报障现场的最小复现）
// ───────────────────────────────────────────────────────────────────────────

test('改价生效（核心）：配置页把 deepseek-flash 改成 99，统计立刻按 99 算', () => {
  reset();

  const before = cost.costOfModel('deepseek-official', 'deepseek-flash', ONE_M, IDLE);
  assert.equal(before.cost.total, 1, '改价前：空闲档 input 1 元/百万 × 1M = 1');
  assert.equal(before.source, 'official-doc', '没改过的记录来源是厂商文档');

  editPrice('deepseek-official', 'deepseek-flash', 99, 99, 99);

  // 存储层（这一层本来就没问题，是统计层没跟上）
  const stored = table.priceOf('deepseek-official', 'deepseek-flash', IDLE);
  assert.equal(stored.known, true);
  assert.equal(stored.form, 'uniform', '三值相等 → 单一价');
  assert.equal(stored.prices.uniform, 99);
  assert.equal(stored.source, 'manual');

  // 统计层：必须改口（改动前这里恒为 1，就是用户看到的现象）
  const after = cost.costOfModel('deepseek-official', 'deepseek-flash', ONE_M, IDLE);
  assert.equal(after.known, true);
  assert.equal(after.form, 'uniform');
  assert.equal(after.singlePrice, true);
  assert.equal(after.prices.uniform, 99, '统计读到的单价必须是 99');
  assert.equal(after.cost.total, 99, '改价后金额必须变成 99');
  assert.equal(after.source, 'manual', '来源跟着变成 manual');
  // asOf 是**改价那天**，不是厂商文档的采集日期：卡片与统计不能显示两个日期。
  assert.equal(after.asOf, todayInShanghai(), 'manual 记录的快照日期是改价日');
  assert.equal(stored.asOf, after.asOf, '卡片与统计的 asOf 必须一致');
});

// ───────────────────────────────────────────────────────────────────────────
// 2. 闸门：只有 manual 接管，没改过的行逐字段不变
// ───────────────────────────────────────────────────────────────────────────

test('未改价的行不受影响：同表里没动过的 moonshotai/kimi-k3 输出逐字段相同', () => {
  reset();
  const before = cost.costOfModel('moonshotai', 'kimi-k3', ONE_M, PEAK);
  assert.equal(before.known, true);
  assert.equal(before.source, 'official-doc');
  assert.equal(before.cost.total, 3, '美元表：3 元/百万 × 1M');

  // 改的是 DeepSeek 的价，与 kimi-k3 无关。
  editPrice('deepseek-official', 'deepseek-flash', 99, 99, 99);

  const after = cost.costOfModel('moonshotai', 'kimi-k3', ONE_M, PEAK);
  // 整份返回（含 prices / cost / window / asOf / source / via）必须一致：
  // 这就是「未改过的走原路径，行为逐字节不变」的可验证形式。
  assert.deepEqual(after, before, '没被改过的模型，输出必须与改价前完全一致');
});

// ───────────────────────────────────────────────────────────────────────────
// 3. 8 家逐个：pricing.js 收录的每一家都要能改
// ───────────────────────────────────────────────────────────────────────────

/** pricing.js 收录的 8 家（+ 各自取一条种子模型 + 该记录的计价币种）。 */
const EIGHT_PROVIDERS = [
  ['deepseek-official', 'deepseek-flash', 'CNY'],
  ['deepseek-account', 'deepseek-flash', 'CNY'],
  ['deepseek', 'deepseek-v4-pro', 'CNY'],
  ['moonshotai', 'kimi-k3', 'USD'],
  ['zai', 'glm-5.3', 'USD'],
  ['minimax', 'minimax-m3', 'USD'],
  ['minimax-cn', 'minimax-m3', 'CNY'],
  ['openrouter', 'glm-4.6', 'USD'],
];

test('8 家逐个改价：每家改一条，cost.total 都要变（漏一家就是漏一个渠道的钱）', () => {
  assert.equal(EIGHT_PROVIDERS.length, 8, '这 8 家就是 lib/pricing.js 收录的全部渠道');
  for (const [provider, model, currency] of EIGHT_PROVIDERS) {
    reset();
    const before = cost.costOfModel(provider, model, ONE_M, PEAK);
    assert.equal(before.known, true, `${provider}/${model} 改价前应能查到旧表`);
    assert.equal(before.source, 'official-doc', `${provider}/${model} 改价前来源是厂商文档`);
    assert.equal(before.currency, currency, `${provider}/${model} 的币种`);
    assert.notEqual(before.cost.total, 99, `${provider}/${model} 的种子价不该正好是 99`);

    editPrice(provider, model, 99, 99, 99);

    const after = cost.costOfModel(provider, model, ONE_M, PEAK);
    assert.equal(after.cost.total, 99, `${provider}/${model} 改价后金额应为 99`);
    assert.notEqual(after.cost.total, before.cost.total,
      `${provider}/${model} 改价后金额必须变化（改前 ${before.cost.total}）`);
    assert.equal(after.form, 'uniform', `${provider}/${model} 三值相等 → 单一价`);
    assert.equal(after.source, 'manual', `${provider}/${model} 来源变 manual`);
    assert.equal(after.currency, currency, `${provider}/${model} 改价不改计价币种`);
    // 渠道×模型 键仍是自己那一条（改价不会串到别的渠道或别的模型）。
    assert.equal(after.provider, provider);
    assert.equal(after.model, model);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 4. 改回原值 → 恢复
// ───────────────────────────────────────────────────────────────────────────

test('改回原值：改 99 再改回种子的三字段，金额恢复；resetToSeed 连两档价一起还原', () => {
  reset();
  const originalPeak = cost.costOfModel('deepseek-official', 'deepseek-flash', ONE_M, PEAK);
  const originalIdle = cost.costOfModel('deepseek-official', 'deepseek-flash', ONE_M, IDLE);
  assert.equal(originalPeak.cost.total, 2, '高峰档 input 2 元/百万 × 1M');
  assert.equal(originalIdle.cost.total, 1, '空闲档 input 1 元/百万 × 1M');

  editPrice('deepseek-official', 'deepseek-flash', 99, 99, 99);
  assert.equal(cost.costOfModel('deepseek-official', 'deepseek-flash', ONE_M, PEAK).cost.total, 99);

  // 用户在配置页把三个框改回官方 standard 档（2 / 8 / 0.04）：三值不等 → 回到分项价。
  editPrice('deepseek-official', 'deepseek-flash', 2, 8, 0.04);
  const reverted = cost.costOfModel('deepseek-official', 'deepseek-flash', ONE_M, PEAK);
  assert.equal(reverted.cost.total, 2, '改回原价后金额恢复');
  assert.equal(reverted.form, 'split', '三值不等 → 回到分项价形态');
  assert.equal(reverted.source, 'manual', '来源仍是 manual：这个价是用户定的');
  // 手改价会把峰谷两档合并成同值（price-store 的 peak-merged），所以空闲档此时也是 2。
  // 这不是取价错误，而是要能解释：用户填的是"一个价"，不是"两档价"。
  assert.equal(cost.costOfModel('deepseek-official', 'deepseek-flash', ONE_M, IDLE).cost.total, 2);

  // 彻底恢复出厂：resetToSeed 把两档价（2/8/0.04 与 1/4/0.02）一起写回。
  reset();
  assert.equal(cost.costOfModel('deepseek-official', 'deepseek-flash', ONE_M, PEAK).cost.total, 2);
  assert.equal(cost.costOfModel('deepseek-official', 'deepseek-flash', ONE_M, IDLE).cost.total, 1,
    'resetToSeed 之后空闲档才回到 1');
  assert.equal(cost.costOfModel('deepseek-official', 'deepseek-flash', ONE_M, PEAK).source, 'official-doc');
});

// ───────────────────────────────────────────────────────────────────────────
// 5. uniform 口径
// ───────────────────────────────────────────────────────────────────────────

test('uniform 口径：三值相等后按 单价 × 全部 token 算，分项恒为 null', () => {
  reset();
  editPrice('deepseek-official', 'deepseek-flash', 99, 99, 99);

  const out = cost.costOfModel('deepseek-official', 'deepseek-flash', ONE_M, PEAK);
  assert.equal(out.form, 'uniform');
  assert.equal(out.singlePrice, true);
  // 单一价只给 uniform 一个键；四年分项必须是 null，不能编出输入价/输出价。
  assert.deepEqual(out.prices, { uniform: 99, input: null, cacheRead: null, cacheWrite: null, output: null });
  assert.equal(out.cost.total, 99, '99 × 1M ÷ 1e6');
  for (const key of ['input', 'cacheRead', 'cacheWrite', 'output']) {
    assert.equal(out.cost[key], null, `单一价拆不出 ${key} 成本，必须是 null（不是 0）`);
  }

  // 线性：token 翻倍金额翻倍。
  const double = cost.costOfModel('deepseek-official', 'deepseek-flash',
    { inputTokens: 2_000_000, totalTokens: 2_000_000 }, PEAK);
  assert.equal(double.cost.total, 198, '2M token → 198');

  // 上游没给 totalTokens 时退回四个分项之和（唯一能算的口径）。
  const noTotal = cost.costOfModel('deepseek-official', 'deepseek-flash',
    { inputTokens: 500_000, outputTokens: 300_000, cacheReadTokens: 200_000 }, IDLE);
  assert.equal(noTotal.cost.total, 99, '没有 totalTokens → 分项之和 1M → 99');

  // uniform 记录没有峰谷概念：两刻金额相同，window 为 null。
  const atIdle = cost.costOfModel('deepseek-official', 'deepseek-flash', ONE_M, IDLE);
  assert.equal(atIdle.cost.total, 99);
  assert.equal(atIdle.window, null, '单一价不分峰谷，window 为 null');
});

// ───────────────────────────────────────────────────────────────────────────
// 6. 峰谷：两档写同值 → 两刻金额相同
// ───────────────────────────────────────────────────────────────────────────

test('峰谷：改 DeepSeek 价为不等三值 → 两档同价，高峰/空闲金额相同（可解释）', () => {
  reset();
  // 三值不等 → split 形态，且原记录带 schedule → 两档都写这套值（peak-merged）。
  editPrice('deepseek-official', 'deepseek-flash', 3, 5, 1);

  const peak = cost.costOfModel('deepseek-official', 'deepseek-flash', ONE_M, PEAK);
  const idle = cost.costOfModel('deepseek-official', 'deepseek-flash', ONE_M, IDLE);

  assert.equal(peak.form, 'split');
  assert.equal(peak.window, 'peak', '高峰指示灯仍在');
  assert.equal(idle.window, 'idle', '空闲指示灯仍在');
  assert.notEqual(peak.schedule, null, 'schedule 必须保留：否则指示灯与取价会打架');
  assert.deepEqual(peak.prices, idle.prices, '两档写同值：2/8/0.04 被换成用户填的 3/5/1');
  assert.deepEqual(peak.prices, { uniform: null, input: 3, output: 5, cacheRead: 1, cacheWrite: 0 });

  assert.equal(peak.cost.total, 3, 'input 3 元/百万 × 1M');
  assert.equal(idle.cost.total, 3);
  assert.equal(idle.cost.total, peak.cost.total,
    '两刻金额相同——因为用户填的是一个价、两档同值，不是取错了档');
  assert.equal(peak.source, 'manual');
});

// ───────────────────────────────────────────────────────────────────────────
// 7. 无存储 → 回落种子
// ───────────────────────────────────────────────────────────────────────────

test('无存储：DSH_QUOTA_USAGE_PRICE_STORE 指向不存在的路径 → 回落种子，与改前一致', () => {
  reset();
  const baseline = cost.costOfModel('deepseek-official', 'deepseek-flash', ONE_M, IDLE);

  const emptyPath = path.join(HOME, 'never-created', 'nested', 'price-table.json');
  const previous = process.env[store.STORE_ENV] === undefined ? null : process.env[store.STORE_ENV];
  assert.equal(nodeFs.existsSync(emptyPath), false, '前提：这个存储文件确实还不存在');
  process.env[store.STORE_ENV] = emptyPath;
  try {
    const loaded = store.loadTable();
    assert.equal(loaded.records.length, table.SEED_RECORDS.length, '回落 103 条种子');
    assert.equal(loaded.source, 'seed', '首次运行：把种子落盘');

    const fromSeed = cost.costOfModel('deepseek-official', 'deepseek-flash', ONE_M, IDLE);
    assert.deepEqual(fromSeed, baseline, '空存储下的取价与改价前逐字段一致');
    assert.equal(table.priceOf('deepseek-official', 'deepseek-flash', IDLE).source, 'official-doc',
      '种子的来源仍是厂商文档，不会被当成 manual');
  } finally {
    if (previous === null) delete process.env[store.STORE_ENV];
    else process.env[store.STORE_ENV] = previous;
    nodeFs.rmSync(path.join(HOME, 'never-created'), { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 8. 汇总层：aggregateCost 对 manual 记录也要能聚合
// ───────────────────────────────────────────────────────────────────────────

test('汇总层：manual 记录参与聚合（金额、币种、asOf、window 四处都要对）', () => {
  reset();
  editPrice('deepseek-official', 'deepseek-flash', 99, 99, 99);
  editPrice('minimax-cn', 'minimax-m3', 99, 99, 99);

  const block = cost.costOfSummary({
    kind: 'prepaid',
    providers: [
      { provider: 'deepseek-official', models: [{ model: 'deepseek-flash', ...ONE_M }] },
      { provider: 'minimax-cn', models: [{ model: 'minimax-m3', ...ONE_M }] },
    ],
  }, PEAK);

  // 两家都是人民币 → 不会被误判成跨币种（manual 记录仍带原币种）。
  assert.equal(block.cost.currency, 'CNY');
  assert.equal(block.cost.known, true);
  assert.equal(block.cost.amounts.total, 198, '99 + 99');
  assert.equal(block.cost.amounts.uniformTotal, 198, '单一价部分单独可见，且已含在 total 里');
  assert.equal(block.cost.amounts.input, 0, '单一价拆不出输入成本');
  assert.equal(block.cost.amounts.output, 0);
  assert.equal(block.cost.asOf, todayInShanghai(), '汇总的 asOf 取改价日');
  assert.equal(block.cost.window, null, '单一价没有峰谷');
  assert.equal(block.providers[0].cost.amounts.total, 99, '厂商级小计');
  assert.equal(block.providers[1].cost.amounts.total, 99);
  // 模型级仍与 costOfModel 同形，界面读同一套字段。
  assert.equal(block.providers[0].models[0].cost.cost.total, 99);
  assert.equal(block.providers[0].models[0].cost.source, 'manual');
});

test('汇总层：manual 的分项价与未改价的模型混在一组时各算各的', () => {
  reset();
  // DeepSeek 手改成 3/5/1（split），moonshotai 不动（USD）→ 跨币种，给 byCurrency。
  editPrice('deepseek-official', 'deepseek-flash', 3, 5, 1);

  const block = cost.costOfSummary({
    kind: 'prepaid',
    providers: [
      { provider: 'deepseek-official', models: [{ model: 'deepseek-flash', ...ONE_M }] },
      { provider: 'moonshotai', models: [{ model: 'kimi-k3', ...ONE_M }] },
    ],
  }, PEAK);

  assert.equal(block.cost.currency, 'mixed', 'CNY 与 USD 绝不相加');
  assert.equal(block.cost.byCurrency.CNY.total, 3, '手改后的 DeepSeek 价');
  assert.equal(block.cost.byCurrency.USD.total, 3, '未改过的 Moonshot 价');
});