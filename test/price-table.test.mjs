// lib/price-table.js 的确定性断言（不依赖宿主运行时）。
//
// 覆盖规格里点名的每一条，并额外钉住三类"最容易悄悄错"的东西：
//   · 与 lib/pricing.js 的共存期一致性（两份数据必须逐位相同，否则同一模型两个价钱）；
//   · 峰谷判定与 pricing.isPeak 逐小时一致（两套实现不得漂移）；
//   · 形态互斥（uniform 与分项价不能同时出现，否则消费方无从判断该用哪个）。
//
// ⚠️ 存储隔离（必须保留）：`priceOf()` 读的是 price-store 里那份**可编辑**的表
//   （$DSH_HOME/storages/dsh-quota-usage/price-table.json）。用户在自己机器上改过价
//   之后，本文件里断言种子价的那批用例就会红——那不是代码错，是测试读了用户数据。
//   所以这里用 DSH_QUOTA_USAGE_PRICE_STORE 把存储指到临时文件（首次调用会把 103 条
//   种子写进去，于是 priceOf 读到的仍是出厂数据）。刻意**不**改成「只断言 SEED_RECORDS」：
//   种子是常量，改断言等于把 priceOf 的取价 / 峰谷 / 形态判定从覆盖里摘掉，而这里要测的
//   恰恰是那条读取路径。环境变量必须在 import 之前生效，所以下面用动态 import。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'dsh-price-table-'));
process.env.DSH_QUOTA_USAGE_PRICE_STORE = path.join(HOME, 'price-table.json');

const {
  PRICE_RECORDS,
  PRICE_RECORD_PROBLEMS,
  hasPriceRecord,
  modelsOf,
  priceOf,
} = await import('../lib/price-table.js');
const { isPeak, quoteAt, asOfOf } = await import('../lib/pricing.js');
const { costOfModel, costOfSummary } = await import('../lib/cost.js');

after(() => {
  delete process.env.DSH_QUOTA_USAGE_PRICE_STORE;
  nodeFs.rmSync(HOME, { recursive: true, force: true });
});

const at = (iso) => Date.parse(iso);
/** 周四 10:00 北京时间：DeepSeek 高峰。 */
const PEAK = '2026-10-22T10:00:00+08:00';
/** 周四 13:00 北京时间：午休，空闲。 */
const IDLE = '2026-10-22T13:00:00+08:00';

// ───────────────────────────────────────────────────────────────────────────
// 表本身的自洽
// ───────────────────────────────────────────────────────────────────────────

test('造表自检没有问题（非法/矛盾记录会让 PRICE_RECORD_PROBLEMS 非空）', () => {
  assert.deepEqual(
    PRICE_RECORD_PROBLEMS.map((p) => p.reason),
    [],
    '价格表里有非法记录，见 lib/price-table.js 的 validateRecords',
  );
});

test('每条记录的 渠道×模型 唯一（按渠道分组，不按模型去重）', () => {
  const keys = PRICE_RECORDS.map((r) => `${r.provider}\u0000${r.model}`);
  assert.equal(new Set(keys).size, keys.length, '存在重复的 渠道×模型');
});

test('同一个模型在不同渠道各有一条记录（不能按模型去重）', () => {
  // raccoon 的 GLM-5-3 与 loomy 的 GLM 5.3 Flash 是两个渠道的两个价。
  const raccoonGlm = priceOf('raccoon', 'sn-glm-5-3');
  const loomyGlm = priceOf('loomy', 'GLM-5.3-Flash');
  assert.equal(raccoonGlm.known, true);
  assert.equal(loomyGlm.known, true);
  assert.equal(raccoonGlm.prices.uniform, 0.75);
  assert.equal(loomyGlm.prices.uniform, 0.8);
  assert.notEqual(raccoonGlm.prices.uniform, loomyGlm.prices.uniform, '同族模型跨渠道必须取各自的价');
});

test('三种形态互斥：uniform / 分项 / free 不会同时出现在一条记录里', () => {
  for (const record of PRICE_RECORDS) {
    const hasUniform = record.uniform !== undefined;
    const hasSplit = record.input !== undefined || record.output !== undefined || record.cacheRead !== undefined;
    const isFree = record.free === true;
    const count = [hasUniform, hasSplit, isFree].filter(Boolean).length;
    assert.equal(count, 1, `${record.provider}/${record.model} 的形态数应为 1，实际 ${count}`);
  }
});

test('priceOf 的返回结构：形态与 prices 一一对应，且互斥', () => {
  const probes = [
    ['raccoon', 'sn-glm-5-3'],
    ['deepseek-official', 'deepseek-flash'],
    ['raccoon', 'sn-sensenova-6-8-flash'],
    ['trae', 'sagitta'],
  ];
  for (const [provider, model] of probes) {
    const out = priceOf(provider, model, at(PEAK));
    // 四个字段恒存在，调用方不必判 undefined。
    for (const key of ['known', 'currency', 'form', 'prices', 'schedule', 'promotion', 'source', 'asOf']) {
      assert.ok(key in out, `${provider}/${model} 缺少字段 ${key}`);
    }
    assert.ok(['uniform', 'split', 'free', 'unknown'].includes(out.form));
    if (out.form === 'uniform') {
      assert.deepEqual(Object.keys(out.prices), ['uniform'], '单一价只给 uniform 一个键');
    }
    if (out.form === 'split') {
      assert.deepEqual(Object.keys(out.prices).sort(), ['cacheRead', 'input', 'output']);
    }
    if (out.form === 'free' || out.form === 'unknown') {
      assert.equal(out.prices, null, `${out.form} 形态的 prices 必须是 null`);
    }
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 1. 名字后缀提取的 12 条单一价（+ 2 条免费，共 14 条有价/免费记录）
// ───────────────────────────────────────────────────────────────────────────

test('名字后缀的 12 条单一价：数值逐条正确', () => {
  const cases = [
    // loomy（8 条）
    ['loomy', 'deepseek-v4-flash-0731', 3.0],
    ['loomy', 'MiniMax-M3', 4.0],
    ['loomy', 'Kimi-k2.6', 6.5],
    ['loomy', 'qwen-3.8-max', 12.0],
    ['loomy', 'GLM-5.3-Flash', 0.8],
    ['loomy', 'qwen3.8-flash', 0.8],
    ['loomy', 'spark-x', 0.1],
    ['loomy', 'mimo-v2.5', 3.3],
    // raccoon（4 条有价）
    ['raccoon', 'sn-glm-5-3', 0.75],
    ['raccoon', 'sn-kimi-k3', 1],
    ['raccoon', 'sn-glm-5-3-flash', 0.1], // 促销现价（原价 0.2 见下一条测试）
    ['raccoon', 'sn-deepseek-v4-1-flash', 0.25],
  ];
  for (const [provider, model, expected] of cases) {
    const out = priceOf(provider, model, at(PEAK));
    assert.equal(out.known, true, `${provider}/${model} 应能查到`);
    assert.equal(out.form, 'uniform', `${provider}/${model} 应是单一价`);
    assert.equal(out.source, 'name-suffix', `${provider}/${model} 的来源应是 name-suffix`);
    assert.equal(out.currency, 'CNY', `${provider}/${model} 是人民币价`);
    assert.equal(out.prices.uniform, expected, `${provider}/${model} 的单一价应为 ${expected}`);
    // 单一价不分输入输出：另三槽必须是 null，不能编出输入价/输出价。
    assert.equal(out.prices.input, undefined, '单一价不应带 input');
    assert.equal(out.prices.output, undefined, '单一价不应带 output');
  }
});

test('名字后缀的 12 条都在表里，且都带展示名（含 xN 后缀原文）', () => {
  const named = PRICE_RECORDS.filter((r) => r.source === 'name-suffix');
  assert.equal(named.length, 12, 'name-suffix 应有 12 条（loomy 8 + raccoon 4）');
  for (const record of named) {
    assert.equal(typeof record.displayName, 'string');
    assert.ok(record.displayName.length > 0);
    // 展示名必须保留渠道原本的倍率写法，界面才能照原样显示。
    assert.match(
      record.displayName,
      /x\d/,
      `${record.provider}/${record.model} 的展示名应保留 xN 倍率`,
    );
  }
});

test('促销：GLM-5-3-Flash 取 current（0.1）而非 original（0.2），且保留原价', () => {
  const out = priceOf('raccoon', 'sn-glm-5-3-flash', at(PEAK));
  assert.equal(out.known, true);
  assert.equal(out.form, 'uniform');
  assert.equal(out.prices.uniform, 0.1, '生效价必须是现价 0.1');
  assert.notEqual(out.prices.uniform, 0.2, '绝不能返回原价');
  assert.ok(out.promotion, '促销记录必须带 promotion');
  assert.equal(out.promotion.original, 0.2, '原价要保留，界面才能显示 x0.2→x0.1');
  assert.equal(out.promotion.current, 0.1);
  assert.equal(out.promotion.from, null, '未知的促销起止时间用 null，不编日期');
  assert.equal(out.promotion.until, null);
});

test('只有促销那一条带 promotion；其它单一价记录 promotion 为 null', () => {
  const withPromo = PRICE_RECORDS.filter((r) => r.promotion !== undefined);
  assert.equal(withPromo.length, 1, '本表只有 raccoon 的 GLM-5-3-Flash 在做促销');
  assert.equal(withPromo[0].model, 'sn-glm-5-3-flash');

  for (const [provider, model] of [['raccoon', 'sn-kimi-k3'], ['loomy', 'spark-x']]) {
    const out = priceOf(provider, model, at(PEAK));
    assert.equal(out.promotion, null, `${provider}/${model} 没有促销，promotion 应为 null`);
  }
});

test('促销记录的 uniform 与 promotion.current 一致（只读 uniform 也不会拿到过期价）', () => {
  for (const record of PRICE_RECORDS) {
    if (record.promotion === undefined) continue;
    assert.equal(record.uniform, record.promotion.current);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 2. 免费
// ───────────────────────────────────────────────────────────────────────────

test('免费模型：form 为 free、prices 为 null，但 known 为 true', () => {
  const cases = [
    // raccoon 的 2 条 `· 免费`
    ['raccoon', 'sn-sensenova-6-8-flash'],
    ['raccoon', 'sn-sensenova-6-8-flash-lite'],
    // opencode 的免费通道（含 id 不带 free 字样的 big-pickle）
    ['opencode', 'big-pickle'],
    ['opencode', 'space-bunny-free'],
    ['opencode', 'longcat-2.5-preview-free'],
    ['opencode', 'mimo-v2.6-flash-free'],
    ['opencode', 'mimo-v2.5-free'],
    ['opencode', 'nemotron-3-ultra-free'],
    ['opencode', 'nemotron-3.5-lightning-free'],
  ];
  for (const [provider, model] of cases) {
    const out = priceOf(provider, model, at(PEAK));
    assert.equal(out.known, true, `${provider}/${model} 免费是已知结论，不是不知道`);
    assert.equal(out.form, 'free', `${provider}/${model} 的形态应为 free`);
    assert.equal(out.prices, null, `${provider}/${model} 的 prices 必须是 null`);
    assert.equal(out.source, 'free');
    assert.equal(out.asOf, '2026-11-14');
  }
});

test('opencode 的 free 记录数等于 isFree 模型数（共 7 条）', () => {
  // opencode 也收录了 DeepSeek V4.1 Flash 的镜像价，所以按 form 过滤后再数——
  // count 会把镜像记录一起算进来，这里的口径是"免费通道有几条"。
  const opencode = PRICE_RECORDS.filter((r) => r.provider === 'opencode' && r.free === true);
  assert.equal(opencode.length, 7);
  assert.ok(opencode.every((r) => r.free === true), 'opencode 的 free 记录必须带 free:true');
  // big-pickle 的 id 里没有 free 字样，按名字筛会漏掉它——这里显式钉住。
  assert.ok(opencode.some((r) => r.model === 'big-pickle'));
  // 镜像价与免费记录是两类，不能互相覆盖：V4.1 Flash 那条必须是 split 分项价。
  const mirrored = priceOf('opencode', 'deepseek-v4.1-flash', at(PEAK));
  assert.equal(mirrored.form, 'split', 'V4.1 Flash 是镜像分项价，不是免费');
});

// ───────────────────────────────────────────────────────────────────────────
// 3. 未收录 → known:false
// ───────────────────────────────────────────────────────────────────────────

test('未收录的模型返回 known:false / form:unknown / prices:null', () => {
  const unknownCases = [
    // Trae 的自研模型与 Custom 系列
    ['trae', 'sagitta'],
    ['trae', 'aquila'],
    ['trae', 'custom_model_1M_text'],
    ['trae', 'custom_model_placeholder'],
    ['trae', 'explore_sub_agent_v13'],
    // qoder 的 Auto 与档位名
    ['qoder', 'auto'],
    ['qoder', 'ultimate'],
    ['qoder', 'efficient'],
    // cline 的思考档位
    ['cline', 'space-bunny-alpha'],
    // 完全不存在的渠道/模型
    ['nope', 'whatever'],
    ['loomy', 'no-such-model'],
  ];
  for (const [provider, model] of unknownCases) {
    const out = priceOf(provider, model, at(PEAK));
    assert.equal(out.known, false, `${provider}/${model} 不该有价格`);
    assert.equal(out.form, 'unknown');
    assert.equal(out.prices, null);
    assert.equal(out.schedule, null);
    assert.equal(out.promotion, null);
    assert.equal(out.source, null, '不知道就没有来源');
    assert.equal(out.asOf, null, '不知道就没有采集日期');
  }
});

test('名字里的数字不被当成价格（代数 / 参数量 / 日期 / 上下文 / 档位）', () => {
  // 这些数字全是维度标识；能查到价的只有上面 12 条 + 免费 + 镜像。
  const notPrices = [
    ['trae', 'glm-5-turbo'],            // GLM-5 代数
    ['qoder', 'qmodel_38max'],          // Qwen3.8 代数（qoder 该条未镜像）
    ['opencode', 'kimi-k2.5'],          // 2.5 是代数
    ['opencode', 'minimax-m3'],         // 3 是代数
    ['officeace', 'qwen3-32b'],         // 32B 是参数量
    ['officeace', 'qwen3-30b-a3b'],     // A3B 是参数量
  ];
  for (const [provider, model] of notPrices) {
    assert.equal(priceOf(provider, model, at(PEAK)).known, false, `${provider}/${model} 不该凭空有价`);
  }
});

test('provider 或 model 为空 / 非字符串时一律 known:false，不抛错', () => {
  for (const [provider, model] of [[undefined, 'deepseek-flash'], ['loomy', undefined], ['', ''], [null, null]]) {
    const out = priceOf(provider, model, at(PEAK));
    assert.equal(out.known, false);
    assert.equal(out.form, 'unknown');
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 4. 峰谷（split 形态）
// ───────────────────────────────────────────────────────────────────────────

test('DeepSeek 峰谷：同一模型在高峰/空闲时段返回不同价', () => {
  const peak = priceOf('deepseek-official', 'deepseek-flash', at(PEAK));
  const idle = priceOf('deepseek-official', 'deepseek-flash', at(IDLE));

  assert.equal(peak.form, 'split');
  assert.equal(peak.window, 'peak');
  assert.deepEqual(peak.prices, { input: 2, output: 8, cacheRead: 0.04 });

  assert.equal(idle.window, 'idle');
  assert.deepEqual(idle.prices, { input: 1, output: 4, cacheRead: 0.02 });

  // 两档确实不同（这就是"峰谷"的意义），且空闲更便宜。
  assert.notDeepEqual(peak.prices, idle.prices);
  assert.ok(idle.prices.input < peak.prices.input);
  assert.ok(idle.prices.output < peak.prices.output);
  // schedule 只在 split 形态上返回。
  assert.ok(peak.schedule);
  assert.equal(peak.schedule.holidays, true);
});

test('无峰谷差的 split 模型：两档同价，但仍有 schedule 与 window', () => {
  const peak = priceOf('deepseek-official', 'deepseek-chat', at(PEAK));
  const idle = priceOf('deepseek-official', 'deepseek-chat', at(IDLE));
  assert.deepEqual(peak.prices, idle.prices, 'chat 官方没有峰谷差价');
  assert.equal(peak.window, 'peak');
  assert.equal(idle.window, 'idle');
  assert.ok(peak.schedule, '仍是"有区间"的模型，界面要显示指示灯');
});

test('全天一价的 split 模型：window 与 schedule 都是 null', () => {
  const out = priceOf('zai', 'glm-4.6', at(PEAK));
  assert.equal(out.form, 'split');
  assert.equal(out.window, null, '全天一价没有计费区间');
  assert.equal(out.schedule, null);
  assert.deepEqual(out.prices, { input: 0.6, output: 2.2, cacheRead: 0.11 });
});

test('周末与法定节假日恒为空闲（与 pricing.js 同口径）', () => {
  const cases = [
    ['2026-10-24T10:00:00+08:00', 'idle', '周六'],
    ['2026-10-25T10:00:00+08:00', 'idle', '周日'],
    ['2026-10-01T10:00:00+08:00', 'idle', '国庆'],
    ['2026-02-16T10:00:00+08:00', 'idle', '春节'],
    ['2026-10-22T09:00:00+08:00', 'peak', '工作日 09:00 起'],
    ['2026-10-22T12:00:00+08:00', 'idle', '午休'],
    ['2026-10-22T14:00:00+08:00', 'peak', '14:00 起'],
    ['2026-10-22T18:00:00+08:00', 'idle', '18:00 起空闲'],
  ];
  for (const [iso, expected, label] of cases) {
    assert.equal(priceOf('deepseek-official', 'deepseek-flash', at(iso)).window, expected, label);
  }
});

test('OpenRouter 的分时价不认中国法定节假日（holidays:false）', () => {
  const id = 'deepseek/deepseek-v4.1-flash-1017';
  const nationalDay = at('2026-10-01T10:00:00+08:00'); // 周四，国庆
  const gateway = priceOf('openrouter', id, nationalDay);
  assert.equal(gateway.window, 'peak', '网关只看星期，不看中国节假日');
  assert.equal(gateway.prices.input, 0.3);
  assert.equal(gateway.schedule.holidays, false);

  // 同一时刻走 DeepSeek 官方路由：节假日全天免峰价。
  const official = priceOf('deepseek-official', 'deepseek-flash', nationalDay);
  assert.equal(official.window, 'idle');
  assert.equal(official.prices.input, 1);
});

test('峰谷判定与 pricing.isPeak 逐小时一致（两套实现不得漂移）', () => {
  // 一周 7 天 × 24 小时，逐小时比对"是不是高峰"。
  const start = at('2026-10-19T00:00:00+08:00'); // 周一
  for (let hour = 0; hour < 24 * 7; hour += 1) {
    const ms = start + hour * 60 * 60 * 1000;
    const fromTable = priceOf('deepseek-official', 'deepseek-flash', ms).window === 'peak';
    assert.equal(fromTable, isPeak(ms), `${new Date(ms).toISOString()} 的峰谷判定不一致`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 5. 与 lib/pricing.js 的共存期一致性
// ───────────────────────────────────────────────────────────────────────────

test('共存期一致：pricing.js 里每个模型在价格表里都有同价记录', () => {
  // 两份数据必须逐位一致，否则同一个模型会给出两个价钱。
  const probes = [
    ['deepseek-official', 'deepseek-flash'],
    ['deepseek-official', 'deepseek-v4-pro'],
    ['deepseek-official', 'deepseek-chat'],
    ['deepseek-official', 'deepseek-reasoner'],
    ['deepseek-account', 'deepseek-flash'],
    ['deepseek', 'deepseek-v4-pro'],
    ['moonshotai', 'kimi-k3.1-pro'],
    ['moonshotai', 'kimi-k3'],
    ['moonshotai', 'kimi-k2.6'],
    ['zai', 'glm-5.3'],
    ['zai', 'glm-4.6'],
    ['zai', 'glm-4.5-air'],
    ['minimax', 'minimax-m3'],
    ['minimax-cn', 'minimax-m3'],
    ['openrouter', 'deepseek/deepseek-v4.1-flash-1017'],
    ['openrouter', 'claude-sonnet-5.5'],
    ['openrouter', 'glm-4.6'],
  ];
  for (const [provider, model] of probes) {
    for (const iso of [PEAK, IDLE]) {
      const fromTable = priceOf(provider, model, at(iso));
      const fromPricing = quoteAt(model, at(iso), provider);
      assert.equal(fromTable.known, true, `${provider}/${model} 在价格表里应能查到`);
      assert.equal(fromPricing.known, true, `${provider}/${model} 在 pricing.js 里应能查到`);
      assert.equal(fromTable.currency, fromPricing.currency, `${provider}/${model} 币种不一致`);
      assert.deepEqual(
        fromTable.prices,
        {
          input: fromPricing.input,
          output: fromPricing.output,
          cacheRead: fromPricing.cacheRead,
        },
        `${provider}/${model} @ ${iso} 的单价与 pricing.js 不一致`,
      );
      assert.equal(
        fromTable.window,
        fromPricing.window,
        `${provider}/${model} @ ${iso} 的峰谷区间与 pricing.js 不一致`,
      );
    }
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 6. 跨渠道镜像
// ───────────────────────────────────────────────────────────────────────────

test('镜像记录：按官方价填入，并用 mirrors 标出对应关系', () => {
  const cases = [
    ['trae', 'glm-5.2', 'zai/glm-5.2'],
    ['trae', 'DeepSeek-V4-Pro', 'deepseek-official/deepseek-v4-pro'],
    ['trae', 'kimi-k3', 'moonshotai/kimi-k3'],
    ['qoder', 'gmodel', 'zai/glm-5.3'],
    ['qodercn', 'dfmodel', 'deepseek-official/deepseek-flash'],
    ['officeace', 'deepseek-v4-flash', 'deepseek-official/deepseek-flash'],
  ];
  for (const [provider, model, mirrors] of cases) {
    const out = priceOf(provider, model, at(PEAK));
    assert.equal(out.known, true, `${provider}/${model} 应有镜像价`);
    assert.equal(out.source, 'official-doc', '镜像价的来源是官方文档');
    assert.equal(out.mirrors, mirrors, `${provider}/${model} 的对应关系`);
  }
});

test('镜像价与该模型在官方渠道的价完全一致（不许出现第二个数字）', () => {
  const pairs = [
    ['trae', 'glm-5.2', 'zai', 'glm-5.2'],
    ['trae', 'DeepSeek-V4-Pro', 'deepseek-official', 'deepseek-v4-pro'],
    ['qoder', 'gmodel', 'zai', 'glm-5.3'],
    ['qoder', 'mmodel', 'minimax', 'minimax-m3'],
    ['officeace', 'kimi-k2.6', 'moonshotai', 'kimi-k2.6'],
  ];
  for (const [provider, model, officialProvider, officialModel] of pairs) {
    for (const iso of [PEAK, IDLE]) {
      const mirrored = priceOf(provider, model, at(iso));
      const official = priceOf(officialProvider, officialModel, at(iso));
      assert.deepEqual(mirrored.prices, official.prices, `${provider}/${model} 镜像价与官方价不一致`);
    }
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 7. 辅助函数
// ───────────────────────────────────────────────────────────────────────────

test('hasPriceRecord 与 priceOf().known 同口径', () => {
  assert.equal(hasPriceRecord('loomy', 'spark-x'), true);
  assert.equal(hasPriceRecord('raccoon', 'sn-sensenova-6-8-flash'), true, '免费也算"有记录"');
  assert.equal(hasPriceRecord('trae', 'sagitta'), false);
  assert.equal(hasPriceRecord('', ''), false);
  // 大小写与空白无关。
  assert.equal(hasPriceRecord('  LOOMY  ', ' spark-x '), true);
});

test('modelsOf 返回该渠道录入的模型（按录入顺序）', () => {
  const loomy = modelsOf('loomy');
  assert.equal(loomy.length, 8);
  assert.equal(loomy[0], 'deepseek-v4-flash-0731');
  assert.deepEqual(modelsOf('nope'), []);
  assert.deepEqual(modelsOf(''), []);
});

// ───────────────────────────────────────────────────────────────────────────
// 8. 与 cost.js 的衔接
// ───────────────────────────────────────────────────────────────────────────

test('cost.js：uniform 形态按 单价 × totalTokens ÷ 1e6 算总额', () => {
  const out = costOfModel('loomy', 'GLM-5.3-Flash', { totalTokens: 1_000_000 }, at(PEAK));
  assert.equal(out.known, true);
  assert.equal(out.form, 'uniform');
  assert.equal(out.singlePrice, true);
  assert.equal(out.prices.uniform, 0.8);
  assert.equal(out.cost.total, 0.8);
  // 单一价拆不出输入/输出成本：分项必须是 null，不能编。
  assert.equal(out.cost.input, null);
  assert.equal(out.cost.output, null);
  assert.equal(out.cost.cacheRead, null);

  // 线性：翻倍 token 即翻倍金额。
  const double = costOfModel('loomy', 'GLM-5.3-Flash', { totalTokens: 2_000_000 }, at(PEAK));
  assert.equal(double.cost.total, 1.6);
});

test('cost.js：uniform 优先用上游 totalTokens（含 reasoning），没有才退回分项之和', () => {
  // totalTokens 比四个分项之和大（差额是 reasoning 等不落在分项里的 token）。
  const withTotal = costOfModel('loomy', 'spark-x', {
    inputTokens: 400_000, outputTokens: 400_000, cacheReadTokens: 0, cacheWriteTokens: 0,
    totalTokens: 1_000_000,
  }, at(PEAK));
  assert.equal(withTotal.cost.total, 0.1, '应按 totalTokens 算，不是按 0.8M 分项');

  // 没有 totalTokens 时退回分项之和（唯一能算的情况）。
  const withoutTotal = costOfModel('loomy', 'spark-x', {
    inputTokens: 500_000, outputTokens: 500_000,
  }, at(PEAK));
  assert.equal(withoutTotal.cost.total, 0.1);
});

test('cost.js：促销记录按现价算金额', () => {
  const out = costOfModel('raccoon', 'sn-glm-5-3-flash', { totalTokens: 1_000_000 }, at(PEAK));
  assert.equal(out.cost.total, 0.1, '促销期按现价，不是原价 0.2');
  assert.equal(out.promotion.original, 0.2);
});

test('cost.js：free 形态 cost 全 null 但 known 为 true', () => {
  const out = costOfModel('raccoon', 'sn-sensenova-6-8-flash', { totalTokens: 1_000_000 }, at(PEAK));
  assert.equal(out.known, true, '免费是已知结论');
  assert.equal(out.form, 'free');
  assert.equal(out.cost.total, null, '免费不是"花了 0 元"，是"没有金额"');
  for (const value of Object.values(out.cost)) assert.equal(value, null);
  assert.notEqual(out.cost.total, 0);
});

test('cost.js：未收录模型仍走 pricing.js 的 credit 语义（新表不改变既有结论）', () => {
  const out = costOfModel('trae', 'sagitta', { totalTokens: 1_000_000 }, at(PEAK));
  assert.equal(out.known, false);
  assert.equal(out.form, 'unknown');
  assert.equal(out.priced, false);
  assert.equal(out.currency, 'credit');
  assert.equal(out.cost.total, null);
});

test('cost.js：split 形态的原有路径未被改变（DeepSeek 峰谷照旧）', () => {
  const peak = costOfModel('deepseek-official', 'deepseek-flash', {
    inputTokens: 1_000_000, outputTokens: 1_000_000,
  }, at(PEAK));
  assert.equal(peak.form, 'split');
  assert.equal(peak.cost.total, 10);
  assert.equal(peak.window, 'peak');

  const idle = costOfModel('deepseek-official', 'deepseek-flash', {
    inputTokens: 1_000_000, outputTokens: 1_000_000,
  }, at(IDLE));
  assert.equal(idle.cost.total, 5);
  assert.equal(idle.window, 'idle');
});

test('cost.js：镜像记录能算出金额并带 mirrors', () => {
  const out = costOfModel('trae', 'glm-5.2', {
    inputTokens: 1_000_000, outputTokens: 1_000_000,
  }, at(PEAK));
  assert.equal(out.known, true);
  assert.equal(out.currency, 'USD');
  assert.equal(out.mirrors, 'zai/glm-5.2');
  assert.equal(out.cost.total, 5.8, '1M×1.4 + 1M×4.4');
});

// ───────────────────────────────────────────────────────────────────────────
// 9. 汇总层（costOfSummary）：单一价的金额不能被汇总抹掉
// ───────────────────────────────────────────────────────────────────────────

test('汇总：单一价渠道的金额进入 total（曾因分项为 null 被静默算成 0）', () => {
  const block = {
    kind: 'prepaid',
    providers: [
      { provider: 'loomy', models: [{ model: 'GLM-5.3-Flash', totalTokens: 1_000_000 }] },
    ],
  };
  const out = costOfSummary(block, at(PEAK));
  assert.equal(out.providers[0].models[0].cost.cost.total, 0.8, '模型级金额');
  assert.equal(out.providers[0].cost.amounts.total, 0.8, '厂商级合计不能是 0');
  assert.equal(out.cost.amounts.total, 0.8, '类型级合计不能是 0');
  // 分项确实拆不出来：单一价没有输入/输出成本。
  assert.equal(out.cost.amounts.input, 0);
  assert.equal(out.cost.amounts.output, 0);
  // 单一价部分的金额单独可见，界面能解释"为什么 total 不等于分项之和"。
  assert.equal(out.cost.amounts.uniformTotal, 0.8);
});

test('汇总：分项价 + 单一价混合时 total 是两者之和，分项只反映分项部分', () => {
  const block = {
    kind: 'prepaid',
    providers: [
      {
        provider: 'loomy',
        models: [
          { model: 'GLM-5.3-Flash', totalTokens: 1_000_000 }, // uniform 0.8
        ],
      },
      {
        provider: 'deepseek-official',
        models: [
          { model: 'deepseek-flash', inputTokens: 1_000_000, outputTokens: 0 }, // split 2
        ],
      },
    ],
  };
  const out = costOfSummary(block, at(PEAK));
  // 跨币种？两边都是 CNY，可以相加。
  assert.equal(out.cost.currency, 'CNY');
  assert.equal(out.cost.amounts.total, 2.8, '0.8（单一价）+ 2（分项）');
  assert.equal(out.cost.amounts.input, 2, '分项部分照常累加');
  assert.equal(out.cost.amounts.uniformTotal, 0.8);
});

test('汇总：纯分项价路径的合计不受单一价改动影响（既有口径不变）', () => {
  const block = {
    kind: 'prepaid',
    providers: [
      {
        provider: 'deepseek-official',
        models: [
          { model: 'deepseek-flash', inputTokens: 1_000_000, outputTokens: 1_000_000 },
        ],
      },
    ],
  };
  const out = costOfSummary(block, at(PEAK));
  assert.equal(out.cost.amounts.total, 10);
  assert.equal(out.cost.amounts.input, 2);
  assert.equal(out.cost.amounts.output, 8);
  // 没有单一价条目时 uniformTotal 为 0，不影响"合计 = 分项之和"。
  assert.equal(out.cost.amounts.uniformTotal, 0);
});

// ───────────────────────────────────────────────────────────────────────────
// 10. 价格表接进判定链（snapshotOf 先新表后旧表）—— 用户报的
//     「统计里怎么还是到处都在显示按积分计费」就是这两处没接上造成的
// ───────────────────────────────────────────────────────────────────────────

test('接入：新表有名额的渠道不再被判成 credit（trae / raccoon / loomy）', () => {
  // trae 在新表里只有镜像价条目；glm-5.2 命中 → 真钱 USD。
  const trae = costOfModel('trae', 'glm-5.2', {
    inputTokens: 1_000_000, outputTokens: 1_000_000,
  }, at(PEAK));
  assert.equal(trae.known, true);
  assert.equal(trae.priced, true);
  assert.equal(trae.currency, 'USD');
  assert.notEqual(trae.currency, 'credit');

  const raccoon = costOfModel('raccoon', 'sn-glm-5-3', { totalTokens: 1_000_000 }, at(PEAK));
  assert.equal(raccoon.priced, true);
  assert.equal(raccoon.currency, 'CNY');
  assert.equal(raccoon.form, 'uniform');
  assert.equal(raccoon.singlePrice, true);
  assert.equal(raccoon.cost.total, 0.75);
});

test('接入：credit 只留给新表旧表都查不到的渠道', () => {
  // buddy / codex-chatgpt 两张表都没有 → 仍是 credit（按积分计费）。
  for (const provider of ['buddy', 'codex-chatgpt', 'cline']) {
    const out = costOfModel(provider, 'claude-sonnet-5.5', { inputTokens: 1_000_000 }, at(PEAK));
    assert.equal(out.known, false, `${provider} 两表都没有`);
    assert.equal(out.priced, false, `${provider} 不按钱算`);
    assert.equal(out.currency, 'credit', `${provider} 应显示按积分计费`);
  }
});

test('接入：免费模型给 currency:free（不是 credit，也不是 CNY）', () => {
  for (const [provider, model] of [
    ['raccoon', 'sn-sensenova-6-8-flash'],
    ['opencode', 'big-pickle'],
    ['opencode', 'nemotron-3.5-lightning-free'],
  ]) {
    const out = costOfModel(provider, model, { totalTokens: 1_000_000 }, at(PEAK));
    assert.equal(out.known, true, `${provider}/${model} 免费是已知结论`);
    assert.equal(out.form, 'free');
    assert.equal(out.currency, 'free', `${provider}/${model} 的币种应为 free`);
    assert.equal(out.priced, false, '免费不花真钱');
    assert.equal(out.cost.total, null, '免费不是花了 0 元');
  }
});

test('接入：新表查不到这个模型时仍回落旧表（不因这家有别的模型的价而误判）', () => {
  // trae 在新表里有 12 条镜像价（9 条 + V4.1 Flash 的 3 种写法），但 sagitta 不在其中，
  // 旧表也没有 → credit。
  const out = costOfModel('trae', 'sagitta', { inputTokens: 1_000_000 }, at(PEAK));
  assert.equal(out.known, false);
  assert.equal(out.priced, false, '这家有别的模型的价，不代表这个模型有');
  assert.equal(out.currency, 'credit');
});

test('接入：asOf 在两表都有时不打架（旧表为准）', () => {
  // deepseek-official 与 zai 两表都有：日期必须与 pricing.asOfOf 一致，
  // 否则卡片与统计会显示两个快照日期。
  const cases = [
    ['deepseek-official', 'deepseek-flash'],
    ['zai', 'glm-5.2'],
    ['moonshotai', 'kimi-k3'],
  ];
  for (const [provider, model] of cases) {
    const out = costOfModel(provider, model, { inputTokens: 1_000_000 }, at(PEAK));
    assert.equal(out.asOf, asOfOf(provider), `${provider} 的 asOf 应与 pricing 快照一致`);
  }
  // 只有新表有的渠道，asOf 用记录自己的采集日期。
  const raccoon = costOfModel('raccoon', 'sn-glm-5-3', { totalTokens: 1 }, at(PEAK));
  assert.equal(raccoon.asOf, '2026-11-14');
});

test('汇总：全免费的一组给 free，不是 credit', () => {
  const out = costOfSummary({
    kind: 'subscription',
    providers: [{ provider: 'opencode', models: [{ model: 'big-pickle', totalTokens: 1_000_000 }] }],
  }, at(PEAK));
  assert.equal(out.cost.currency, 'free');
  assert.equal(out.cost.priced, false);
  assert.equal(out.cost.amounts, null, '免费没有金额，不能给 0');
});

test('汇总：免费与有价混在一组时，免费条目不得污染币种也不得凭空加桶', () => {
  const out = costOfSummary({
    kind: 'credits',
    providers: [
      {
        provider: 'raccoon',
        models: [
          { model: 'sn-glm-5-3', totalTokens: 1_000_000 }, // uniform 0.75
          { model: 'sn-glm-5-3-flash', totalTokens: 1_000_000 }, // uniform 0.1（促销现价）
          { model: 'sn-sensenova-6-8-flash', totalTokens: 1_000_000 }, // free
        ],
      },
      { provider: 'loomy', models: [{ model: 'GLM-5.3-Flash', totalTokens: 2_000_000 }] }, // uniform 1.6
    ],
  }, at(PEAK));
  // free 不能被当成一个币种：currency 仍是 CNY，不是 mixed。
  assert.equal(out.cost.currency, 'CNY', 'free 条目不该被算成一个币种');
  assert.equal(out.cost.amounts.total, 2.45, '0.75 + 0.1 + 1.6');
  assert.equal(out.cost.amounts.uniformTotal, 2.45, '单一价部分单独可见，且已包含在 total 里');
  assert.equal(out.providers[0].cost.amounts.total, 0.85);
  assert.equal(out.providers[1].cost.amounts.total, 1.6);
});

test('汇总：免费与查不到价混在一组 → unknown（不能因为有一部分免费就谎称整组免费）', () => {
  const out = costOfSummary({
    kind: 'credits',
    providers: [
      { provider: 'opencode', models: [{ model: 'big-pickle', totalTokens: 1_000_000 }] },
      { provider: 'buddy', models: [{ model: 'claude-sonnet-5.5', inputTokens: 1_000_000 }] },
    ],
  }, at(PEAK));
  assert.equal(out.cost.currency, 'unknown');
});

// ───────────────────────────────────────────────────────────────────────────
// 11. DeepSeek V4.1 Flash 的跨渠道别名组 —— 用户报「统计里到处显示按积分计费」
//     的第二次复发：上一轮修了判定逻辑，但主力模型 trae/deepseek-v4.1-flash
//     在表里根本没有条目名，仍然 known:false。
//
// 用户口径（不要重新推导）：
//   · `deepseek-v4.1-flash` 与官方 `deepseek-flash` 是别名关系；
//   · dfmodel（qodercn）也是同一个模型；
//   · **单价只跟模型有关** —— 跨渠道同名模型一律按厂商官方价算。
// ───────────────────────────────────────────────────────────────────────────

/** 各渠道指向同一个 DS V4.1 Flash 的写法（id 与展示名都要覆盖）。 */
const DS41_FLASH_ALIASES = [
  // trae：日志实测的 id + 展示名的两种写法
  ['trae', 'deepseek-v4.1-flash'],
  ['trae', 'DeepSeek-V4.1-Flash'],
  ['trae', 'DeepSeek V4.1 Flash'],
  // buddy（CodeBuddy，product.ts:199）
  ['buddy', 'deepseek-v4.1-flash'],
  ['buddy', 'Deepseek-V4.1-Flash'],
  // officeace（officeace-product.ts:140）
  ['officeace', 'deepseek-v4.1-flash'],
  ['officeace', 'DeepSeek-V4.1-Flash'],
  // opencode（opencode-product.ts:120）
  ['opencode', 'deepseek-v4.1-flash'],
  ['opencode', 'DeepSeek V4.1 Flash'],
  // accio（accio-product.ts:119，id 是混淆串）
  ['accio', '1Nova-Q3xM8vJ1rH6z'],
  ['accio', 'DeepSeek V4.1 Flash'],
  // workbuddy（product.ts:340）
  ['workbuddy', 'deepseek-v4.1-flash'],
  ['workbuddy', 'Deepseek-V4.1-Flash'],
];

test('DS 4.1 Flash 别名组：每个渠道 × 写法都能查到，且 known/priced/form 正确', () => {
  for (const [provider, model] of DS41_FLASH_ALIASES) {
    const out = priceOf(provider, model, at(PEAK));
    assert.equal(out.known, true, `${provider}/${model} 应有镜像价（这是用户的主力模型）`);
    assert.equal(out.form, 'split', `${provider}/${model} 应是分项价（有峰谷）`);
    assert.equal(out.currency, 'CNY', `${provider}/${model} 按 DeepSeek 官方人民币价`);
    assert.equal(out.source, 'official-doc');
    assert.equal(out.mirrors, 'deepseek-official/deepseek-flash', `${provider}/${model} 的对应关系`);
    // 峰谷两档必须都在：只在高峰有价等于空闲时无价。
    for (const iso of [PEAK, IDLE]) {
      const probe = priceOf(provider, model, at(iso));
      assert.ok(Number.isFinite(probe.prices.input), `${provider}/${model} 缺 input 价`);
      assert.ok(Number.isFinite(probe.prices.output), `${provider}/${model} 缺 output 价`);
      assert.ok(Number.isFinite(probe.prices.cacheRead), `${provider}/${model} 缺 cacheRead 价`);
      assert.ok(probe.schedule !== null, `${provider}/${model} 应带峰谷 schedule`);
    }
  }
});

test('DS 4.1 Flash 别名组：价格与官方 deepseek-flash 逐位一致（镜像不是第二份数字）', () => {
  for (const [provider, model] of DS41_FLASH_ALIASES) {
    for (const iso of [PEAK, IDLE]) {
      const mirrored = priceOf(provider, model, at(iso));
      const official = priceOf('deepseek-official', 'deepseek-flash', at(iso));
      assert.deepEqual(mirrored.prices, official.prices, `${provider}/${model} 与官方价不一致`);
      assert.equal(mirrored.window, official.window, `${provider}/${model} 的峰谷判定与官方不一致`);
      assert.equal(mirrored.asOf, official.asOf, `${provider}/${model} 的快照日期与官方不一致`);
    }
  }
  // 具体数字也钉一遍，防止官方条目被改错时两处一起漂。
  assert.deepEqual(priceOf('trae', 'deepseek-v4.1-flash', at(PEAK)).prices,
    { input: 2, output: 8, cacheRead: 0.04 });
  assert.deepEqual(priceOf('trae', 'deepseek-v4.1-flash', at(IDLE)).prices,
    { input: 1, output: 4, cacheRead: 0.02 });
});

test('DS 4.1 Flash 别名组：镜像记录不复制价格字段，只引用官方条目', () => {
  // mirrors 机制的关键性质：价目对象与官方条目**同一个引用**（Object.is），
  // 不是深拷贝。这样官方调价只改一处，不会出现两个数字各自漂移。
  const official = PRICE_RECORDS.find(
    (r) => r.provider === 'deepseek-official' && r.model === 'deepseek-flash');
  assert.ok(official, '官方条目必须存在');
  for (const [provider, model] of DS41_FLASH_ALIASES) {
    const record = PRICE_RECORDS.find((r) => r.provider === provider && r.model === model);
    assert.ok(record, `${provider}/${model} 的记录必须存在`);
    assert.equal(record.mirrors, 'deepseek-official/deepseek-flash');
    assert.ok(Object.is(record.input, official.input), `${provider}/${model} 的 input 应是官方对象的引用`);
    assert.ok(Object.is(record.output, official.output), `${provider}/${model} 的 output 应是官方对象的引用`);
    assert.ok(Object.is(record.cacheRead, official.cacheRead), `${provider}/${model} 的 cacheRead 应是官方对象的引用`);
    assert.ok(Object.is(record.schedule, official.schedule), `${provider}/${model} 的 schedule 应是官方对象的引用`);
    assert.equal(record.asOf, official.asOf, 'asOf 取自官方条目');
    assert.equal(record.currency, official.currency, '币种取自官方条目');
  }
});

test('DS 4.1 Flash 别名组：真实日志的 id 能算出金额（trae / buddy 的主力）', () => {
  // 日志实测：trae 6341 条 / 24.9 亿 token，buddy 269 条 / 3484 万 token。
  const trae = costOfModel('trae', 'deepseek-v4.1-flash', {
    inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000,
  }, at(PEAK));
  assert.equal(trae.known, true, 'trae 的主力模型必须有价');
  assert.equal(trae.priced, true, '有真金白银单价');
  assert.notEqual(trae.currency, 'credit', '不能再显示「按积分计费」');
  assert.equal(trae.form, 'split');
  assert.equal(trae.mirrors, 'deepseek-official/deepseek-flash');
  // 高峰：input 2 + output 8 + cacheRead 0.04 = 10.04
  assert.equal(trae.cost.total, 10.04);

  const buddy = costOfModel('buddy', 'deepseek-v4.1-flash', {
    inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000,
  }, at(IDLE));
  // 空闲：input 1 + output 4 + cacheRead 0.02 = 5.02
  assert.equal(buddy.cost.total, 5.02);
  assert.notEqual(buddy.currency, 'credit');
});

test('DS 4.1 Flash 别名组：统计页那一行不再显示「按积分计费」', () => {
  const out = costOfSummary({
    kind: 'credits',
    providers: [
      { provider: 'trae', models: [{ model: 'deepseek-v4.1-flash', inputTokens: 1_000_000, totalTokens: 1_000_000 }] },
      { provider: 'buddy', models: [{ model: 'deepseek-v4.1-flash', inputTokens: 2_000_000, totalTokens: 2_000_000 }] },
    ],
  }, at(PEAK));
  // 整组变成可计价：currency 是真币种，不是 credit / unknown。
  assert.equal(out.cost.currency, 'CNY');
  assert.equal(out.cost.priced, true);
  assert.equal(out.cost.known, true, '两个模型都有价，不该是 partial');
  // trae 1M × 2 = 2；buddy 2M × 2 = 4 → 合计 6
  assert.equal(out.providers[0].cost.amounts.total, 2);
  assert.equal(out.providers[1].cost.amounts.total, 4);
  assert.equal(out.cost.amounts.total, 6, '汇总 total 要包含这笔钱');
  // 逐级都不再是 credit
  for (const provider of out.providers) {
    assert.notEqual(provider.cost.currency, 'credit', `${provider.provider} 不该再按积分计费`);
  }
});

test('DS 4.1 Flash 别名组：raccoon 渠道自有价（x0.25）优先，不被官方镜像覆盖', () => {
  // raccoon 的 `sn-deepseek-v4-1-flash` 名字里写的是渠道自己的定价 x0.25，
  // 属 name-suffix 段。它与本组的镜像记录是**不同**的 渠道×模型 键
  // （`sn-` 前缀），所以不会被官方价顶掉——这里把这条优先级钉死。
  const raccoon = priceOf('raccoon', 'sn-deepseek-v4-1-flash', at(PEAK));
  assert.equal(raccoon.known, true);
  assert.equal(raccoon.form, 'uniform', '渠道自有价是单一价，不是分项价');
  assert.equal(raccoon.source, 'name-suffix', '来源必须是渠道名后缀，不能变成 official-doc');
  assert.equal(raccoon.mirrors, null, '渠道自有价不挂 mirrors（它不镜像官方价）');
  assert.equal(raccoon.prices.uniform, 0.25, '必须是 x0.25，不能被官方价覆盖');
  // 官方镜像价是 2（高峰 input），两者必须不同，否则说明被覆盖了。
  const officialLike = priceOf('trae', 'deepseek-v4.1-flash', at(PEAK));
  assert.notEqual(raccoon.prices.uniform, officialLike.prices.input);
  // raccoon 上也不存在裸 `deepseek-v4.1-flash` 这个键——真正的模型 id 带 sn- 前缀。
  assert.equal(priceOf('raccoon', 'deepseek-v4.1-flash', at(PEAK)).known, false,
    'raccoon 的模型 id 带 sn- 前缀，裸名不该命中（命中就意味着串了渠道）');
  // 金额也照渠道价算：1M token × 0.25 = 0.25
  const cost = costOfModel('raccoon', 'sn-deepseek-v4-1-flash', { totalTokens: 1_000_000 }, at(PEAK));
  assert.equal(cost.cost.total, 0.25);
  assert.equal(cost.form, 'uniform');
});

test('DS 4.1 Flash 别名组：V4（无 .1）是不同模型，不被并入', () => {
  // `deepseek-v4-flash` 是上一代，与 V4.1 Flash 不是同一个模型。
  // officeace 的那条既有镜像指向官方 deepseek-flash（历史决定，保持不动），
  // 但除此之外不得因为本组而凭空多出 V4 的条目。
  const traeV4 = priceOf('trae', 'deepseek-v4-flash', at(PEAK));
  assert.equal(traeV4.known, false, 'trae 没有登记 V4 Flash，不该被 V4.1 的规则带进来');
  const buddyV4 = priceOf('buddy', 'deepseek-v4-flash', at(PEAK));
  assert.equal(buddyV4.known, false, 'buddy 没有登记 V4 Flash');
  // WorkBuddy 的 sg 变体是区域版本，表里没有依据 → 不猜价。
  const sg = priceOf('workbuddy', 'deepseek-v4.1-flash-sg', at(PEAK));
  assert.equal(sg.known, false, 'sg 变体是区域定价，没有依据时不猜');
});
