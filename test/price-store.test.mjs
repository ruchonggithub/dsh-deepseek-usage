// lib/price-store.js 的确定性断言（不依赖宿主运行时）。
//
// 覆盖规格点名的每一条：首次初始化 103 条、改价后 priceOf 立刻生效、三值相等/不等的形态
// 转换、free 改有价后 free 标记消失、原子写中途失败不破坏原文件、resetToSeed、存储损坏
// 回落种子。另外钉住三件"最容易悄悄错"的东西：
//   · 峰谷记录改价后两档同价但 schedule 仍在（否则窗口指示灯与取价会打架）；
//   · 存储坏了**不许覆盖用户字节**（否则一次断电就把 103 条改价全废掉）；
//   · 校验器只有一份（写入与读取共用），非法记录既不落盘也不被当成好数据。
//
// ⚠️ 本文件用 DSH_QUOTA_USAGE_PRICE_STORE 把存储指到临时目录：既保证测试互不干扰
//   （node --test 会并行跑多个测试文件），也**不会**碰到真实 $DSH_HOME 里的用户数据。
//   必须在 import 之前设置，所以下面用动态 import。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'dsh-price-store-'));
const STORE_FILE = path.join(HOME, 'price-table.json');
process.env.DSH_QUOTA_USAGE_PRICE_STORE = STORE_FILE;

const store = await import('../lib/price-store.js');
const table = await import('../lib/price-table.js');
const cost = await import('../lib/cost.js');

after(() => {
  nodeFs.rmSync(HOME, { recursive: true, force: true });
});

/** 周四 10:00 北京时间：DeepSeek 高峰。 */
const PEAK = Date.parse('2026-10-22T10:00:00+08:00');
/** 周四 13:00 北京时间：午休，空闲。 */
const IDLE = Date.parse('2026-10-22T13:00:00+08:00');

/** 读盘上的存储（含信封字段）。 */
function readStoreFile() {
  return JSON.parse(nodeFs.readFileSync(STORE_FILE, 'utf8'));
}

/** 读盘上的记录数组。 */
function recordsOnDisk() {
  return readStoreFile().records;
}

/** 把存储删掉，模拟"从没跑过"的首次启动。 */
function removeStoreFile() {
  nodeFs.rmSync(STORE_FILE, { force: true });
}

// ───────────────────────────────────────────────────────────────────────────
// 1. 首次运行 + 种子
// ───────────────────────────────────────────────────────────────────────────

test('首次运行：存储不存在时把 103 条种子写进存储，之后以存储为准', () => {
  removeStoreFile();
  const first = store.loadTable();
  assert.equal(first.records.length, 103, '种子是 103 条');
  assert.equal(first.records.length, table.SEED_RECORDS.length, '与 SEED_RECORDS 条数一致');
  assert.equal(first.source, 'seed', '本次数据来自种子');
  assert.ok(first.notices.includes('seed-initialized'), '应标明这是首次初始化');
  assert.ok(nodeFs.existsSync(STORE_FILE), '种子必须落盘');

  const envelope = readStoreFile();
  assert.equal(envelope.version, store.STORE_VERSION);
  assert.equal(envelope.records.length, 103);
  assert.equal(typeof envelope.updatedAt, 'string');

  // 再读一次：这一次必须来自存储（不是又拿种子凑出来的）。
  const second = store.loadTable();
  assert.equal(second.source, 'store');
  assert.equal(second.records.length, 103);
});

test('落盘的种子与 SEED_RECORDS 逐条深相等（JSON 往返不丢字段）', () => {
  removeStoreFile();
  store.loadTable();
  const onDisk = recordsOnDisk();
  assert.equal(onDisk.length, table.SEED_RECORDS.length);
  for (const [index, record] of onDisk.entries()) {
    assert.deepEqual(record, table.SEED_RECORDS[index], `第 ${index} 条（${record.provider}/${record.model}）不一致`);
  }
  // 峰谷 / 促销 / 镜像这三类"结构字段"必须活着穿过去。
  const flash = onDisk.find((r) => r.provider === 'deepseek-official' && r.model === 'deepseek-flash');
  assert.deepEqual(flash.input, { standard: 2, offPeak: 1 });
  assert.equal(flash.schedule.holidays, true);
  const promo = onDisk.find((r) => r.provider === 'raccoon' && r.model === 'sn-glm-5-3-flash');
  assert.equal(promo.promotion.current, 0.1);
  const mirror = onDisk.find((r) => r.provider === 'trae' && r.model === 'glm-5.2');
  assert.equal(mirror.mirrors, 'zai/glm-5.2');
});

test('provider / model 的键唯一：103 条没有重复的 渠道×模型', () => {
  removeStoreFile();
  store.loadTable();
  const keys = recordsOnDisk().map((r) => `${r.provider}\u0000${r.model}`);
  assert.equal(new Set(keys).size, keys.length);
});

// ───────────────────────────────────────────────────────────────────────────
// 2. 改一条 → priceOf 立刻生效（价格在统计时生效，不需要重启）
// ───────────────────────────────────────────────────────────────────────────

test('改一条单一价后 priceOf 立刻返回新价（不重启、不重载模块）', () => {
  store.resetToSeed();
  assert.equal(table.priceOf('raccoon', 'sn-glm-5-3', PEAK).prices.uniform, 0.75, '改前');

  const out = store.saveRecord({
    provider: 'raccoon', model: 'sn-glm-5-3', input: 1.5, output: 1.5, cacheRead: 1.5,
  });
  assert.equal(out.ok, true, JSON.stringify(out.problems));
  assert.equal(out.saved.length, 1);

  const after = table.priceOf('raccoon', 'sn-glm-5-3', PEAK);
  assert.equal(after.known, true);
  assert.equal(after.form, 'uniform', '三值相等仍是单一价');
  assert.equal(after.prices.uniform, 1.5, '价格在统计时生效');
  assert.equal(after.source, 'manual', '用户改过的价来源是 manual');
  assert.equal(after.asOf, new Date(Date.parse(after.asOf)).toISOString().slice(0, 10), 'asOf 是 YYYY-MM-DD');

  // 落盘了：另一个 store 实例（模拟重启）读到的是新价。
  const reread = recordsOnDisk().find((r) => r.provider === 'raccoon' && r.model === 'sn-glm-5-3');
  assert.equal(reread.uniform, 1.5);

  // 金额也跟着变：cost.js 一行未改，但它通过 priceOf 取价。
  const money = cost.costOfModel('raccoon', 'sn-glm-5-3', { totalTokens: 1_000_000 }, PEAK);
  assert.equal(money.form, 'uniform');
  assert.equal(money.cost.total, 1.5, '统计金额用新价');
});

test('直接改存储文件（模拟用户手改）也能生效：按 mtime/size 重新读取', () => {
  store.resetToSeed();
  assert.equal(table.priceOf('loomy', 'spark-x', PEAK).prices.uniform, 0.1);

  const envelope = readStoreFile();
  const record = envelope.records.find((r) => r.provider === 'loomy' && r.model === 'spark-x');
  record.uniform = 2.5;
  nodeFs.writeFileSync(STORE_FILE, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');

  assert.equal(table.priceOf('loomy', 'spark-x', PEAK).prices.uniform, 2.5);
});

// ───────────────────────────────────────────────────────────────────────────
// 3. 三字段统一输入 → 形态转换
// ───────────────────────────────────────────────────────────────────────────

test('三值相等 → uniform（单一价，金额按 单价 × totalTokens）', () => {
  store.resetToSeed();
  const out = store.saveRecord({ provider: 'zai', model: 'glm-4.6', input: 1, output: 1, cacheRead: 1 });
  assert.equal(out.ok, true, JSON.stringify(out.problems));
  const record = out.saved[0];
  assert.equal(store.formOf(record), 'uniform');
  assert.equal(record.uniform, 1);
  assert.equal(record.input, undefined, '不该留下分项槽');
  assert.equal(record.free, undefined);

  const prices = table.priceOf('zai', 'glm-4.6', PEAK);
  assert.equal(prices.form, 'uniform');
  assert.deepEqual(prices.prices, { uniform: 1 });
  assert.equal(prices.schedule, null, '单一价没有峰谷');
});

test('三值不等 → split（三个分项各自计费）', () => {
  store.resetToSeed();
  const out = store.saveRecord({ provider: 'zai', model: 'glm-4.6', input: 0.5, output: 2, cacheRead: 0.1 });
  assert.equal(out.ok, true, JSON.stringify(out.problems));
  const record = out.saved[0];
  assert.equal(store.formOf(record), 'split');
  // 原本没有 schedule（全天一价）：只写 standard，不凭空造峰谷。
  assert.deepEqual(record.input, { standard: 0.5 });
  assert.deepEqual(record.output, { standard: 2 });
  assert.deepEqual(record.cacheRead, { standard: 0.1 });
  assert.equal(record.uniform, undefined);

  const prices = table.priceOf('zai', 'glm-4.6', PEAK);
  assert.equal(prices.form, 'split');
  assert.deepEqual(prices.prices, { input: 0.5, output: 2, cacheRead: 0.1 });
  assert.equal(prices.window, null, '没有 schedule 就没有计费区间');
});

test('三值全等但为 0 → free（零价即免费，不是"花了 ¥0.00"）', () => {
  store.resetToSeed();
  const out = store.saveRecord({ provider: 'loomy', model: 'spark-x', input: 0, output: 0, cacheRead: 0 });
  assert.equal(out.ok, true, JSON.stringify(out.problems));
  const record = out.saved[0];
  assert.equal(record.free, true);
  assert.equal(record.uniform, undefined, 'free 不许再带价格字段（那会被判非法）');
  assert.ok(out.notices.includes('now-free'));

  const prices = table.priceOf('loomy', 'spark-x', PEAK);
  assert.equal(prices.form, 'free');
  assert.equal(prices.prices, null);
  const money = cost.costOfModel('loomy', 'spark-x', { totalTokens: 1_000_000 }, PEAK);
  assert.equal(money.currency, 'free');
  assert.equal(money.cost.total, null, '免费不是 0 元');
});

test('配置页回传的是字符串（<input type="number">）：照样按数字处理', () => {
  store.resetToSeed();
  const out = store.saveRecord({
    provider: 'loomy', model: 'mimo-v2.5', input: '0.2', output: '0.2', cacheRead: '0.2',
  });
  assert.equal(out.ok, true, JSON.stringify(out.problems));
  assert.equal(out.saved[0].uniform, 0.2);
  assert.equal(typeof out.saved[0].uniform, 'number', '落盘的是数字，不是字符串');
  assert.equal(table.priceOf('loomy', 'mimo-v2.5', PEAK).prices.uniform, 0.2);
});

test('free 记录填了非零值 → 转 uniform / split，free 标记消失', () => {
  store.resetToSeed();
  const before = table.priceOf('raccoon', 'sn-sensenova-6-8-flash', PEAK);
  assert.equal(before.form, 'free', '改前是免费');

  // 三值相等 → uniform
  const equal = store.saveRecord({
    provider: 'raccoon', model: 'sn-sensenova-6-8-flash', input: 0.5, output: 0.5, cacheRead: 0.5,
  });
  assert.equal(equal.ok, true, JSON.stringify(equal.problems));
  assert.equal(equal.saved[0].free, undefined, 'free 标记必须清掉');
  assert.equal(equal.saved[0].uniform, 0.5);
  const afterEqual = table.priceOf('raccoon', 'sn-sensenova-6-8-flash', PEAK);
  assert.equal(afterEqual.form, 'uniform');
  assert.equal(afterEqual.prices.uniform, 0.5);

  // 三值不等 → split，free 同样消失
  const lite = store.saveRecord({
    provider: 'raccoon', model: 'sn-sensenova-6-8-flash-lite', input: 0.2, output: 0.8, cacheRead: 0.05,
  });
  assert.equal(lite.ok, true, JSON.stringify(lite.problems));
  assert.equal(lite.saved[0].free, undefined);
  assert.equal(store.formOf(lite.saved[0]), 'split');
  assert.equal(table.priceOf('raccoon', 'sn-sensenova-6-8-flash-lite', PEAK).form, 'split');
});

test('非法三字段被拒：负数 / 缺一个 / 非数字，都不写盘也不改表', () => {
  store.resetToSeed();
  const before = nodeFs.readFileSync(STORE_FILE, 'utf8');

  const negative = store.saveRecord({ provider: 'loomy', model: 'spark-x', input: -1, output: 1, cacheRead: 1 });
  assert.equal(negative.ok, false);
  assert.match(negative.error, /非负/);
  assert.equal(negative.saved.length, 0);

  const missing = store.saveRecord({ provider: 'loomy', model: 'spark-x', input: 1, output: 1 });
  assert.equal(missing.ok, false);

  const nonsense = store.saveRecord({ provider: 'loomy', model: 'spark-x', input: 'abc', output: 1, cacheRead: 1 });
  assert.equal(nonsense.ok, false);

  assert.equal(nodeFs.readFileSync(STORE_FILE, 'utf8'), before, '被拒的保存不得改动文件');
  assert.equal(table.priceOf('loomy', 'spark-x', PEAK).prices.uniform, 0.1, '价格没变');
});

// ───────────────────────────────────────────────────────────────────────────
// 4. 峰谷：一次输入 → 两档同价
// ───────────────────────────────────────────────────────────────────────────

test('峰谷记录：填一次 → standard 与 offPeak 同价，schedule 保留并标注 peak-merged', () => {
  store.resetToSeed();
  const out = store.saveRecord({
    provider: 'deepseek-official', model: 'deepseek-flash', input: 3, output: 9, cacheRead: 0.05,
  });
  assert.equal(out.ok, true, JSON.stringify(out.problems));
  assert.ok(out.notices.includes('peak-merged'), '必须标注峰谷已合并为同价');

  const record = out.saved[0];
  assert.deepEqual(record.input, { standard: 3, offPeak: 3 }, '两档写同一个值');
  assert.deepEqual(record.output, { standard: 9, offPeak: 9 });
  assert.deepEqual(record.cacheRead, { standard: 0.05, offPeak: 0.05 });
  assert.ok(record.schedule !== undefined && record.schedule !== null, 'schedule 必须保留（否则记录非法，界面也没法显示峰谷）');
  assert.equal(record.schedule.holidays, true);

  const peak = table.priceOf('deepseek-official', 'deepseek-flash', PEAK);
  const idle = table.priceOf('deepseek-official', 'deepseek-flash', IDLE);
  assert.deepEqual(peak.prices, idle.prices, '峰谷差价已合并：两档同价');
  assert.deepEqual(peak.prices, { input: 3, output: 9, cacheRead: 0.05 });
  // 区间判定不变：灯还是那个灯，价格不再分峰谷。
  assert.equal(peak.window, 'peak');
  assert.equal(idle.window, 'idle');
  assert.ok(peak.schedule !== null);
});

test('峰谷记录填成三值相等 → 变 uniform，schedule 被丢弃并标注', () => {
  store.resetToSeed();
  const out = store.saveRecord({
    provider: 'deepseek-official', model: 'deepseek-flash', input: 2, output: 2, cacheRead: 2,
  });
  assert.equal(out.ok, true, JSON.stringify(out.problems));
  const record = out.saved[0];
  assert.equal(store.formOf(record), 'uniform');
  assert.ok(out.notices.includes('schedule-dropped'), '单一价没有峰谷，必须说明 schedule 被丢弃');
  assert.equal(record.seedSchedule.holidays, true, '原 schedule 留在 seedSchedule 里可追溯');

  const peak = table.priceOf('deepseek-official', 'deepseek-flash', PEAK);
  const idle = table.priceOf('deepseek-official', 'deepseek-flash', IDLE);
  assert.equal(peak.form, 'uniform');
  assert.deepEqual(peak.prices, idle.prices);
  assert.equal(peak.window, null, '单一价没有计费区间');
});

// ───────────────────────────────────────────────────────────────────────────
// 5. 促销 / 镜像：改价后不再成立，必须清掉（否则是假信息）
// ───────────────────────────────────────────────────────────────────────────

test('促销记录改价：promotion 清掉并留痕（原值进 seedPromotion）', () => {
  store.resetToSeed();
  const out = store.saveRecord({
    provider: 'raccoon', model: 'sn-glm-5-3-flash', input: 0.3, output: 0.3, cacheRead: 0.3,
  });
  assert.equal(out.ok, true, JSON.stringify(out.problems));
  const record = out.saved[0];
  assert.equal(record.promotion, undefined);
  assert.equal(record.seedPromotion.current, 0.1, '原促销信息留痕');
  assert.ok(out.notices.includes('promotion-cleared'));
  assert.equal(table.priceOf('raccoon', 'sn-glm-5-3-flash', PEAK).promotion, null);
});

test('镜像记录改价：mirrors 清掉（手定价不再是官方镜像）', () => {
  store.resetToSeed();
  const out = store.saveRecord({
    provider: 'trae', model: 'glm-5.2', input: 2, output: 5, cacheRead: 0.3,
  });
  assert.equal(out.ok, true, JSON.stringify(out.problems));
  const record = out.saved[0];
  assert.equal(record.mirrors, undefined);
  assert.equal(record.seedMirrors, 'zai/glm-5.2', '原来的对应关系留痕');
  assert.ok(out.notices.includes('mirrors-cleared'));
  assert.equal(table.priceOf('trae', 'glm-5.2', PEAK).mirrors, null);
  assert.equal(table.priceOf('trae', 'glm-5.2', PEAK).prices.input, 2);
});

// ───────────────────────────────────────────────────────────────────────────
// 6. 原子写：中途失败不破坏原文件
// ───────────────────────────────────────────────────────────────────────────

test('原子写：写一半抛错时原文件一字节不变，临时文件被清理', () => {
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'dsh-price-atomic-'));
  try {
    const file = path.join(dir, 'prices.json');
    const healthy = store.createPriceStore({ file });
    const seed = healthy.saveRecord([{
      provider: 'demo', model: 'm1', uniform: 1, currency: 'CNY', source: 'manual', asOf: '2026-11-01', displayName: 'm1',
    }]);
    assert.equal(seed.ok, true, JSON.stringify(seed.problems));
    const before = nodeFs.readFileSync(file, 'utf8');

    // 注入：只写进去一半就抛（模拟磁盘满 / 断电）。
    const brokenFs = {
      ...nodeFs,
      writeSync: (fd, buffer, offset, length, position) => {
        const half = Math.max(1, Math.floor(length / 2));
        nodeFs.writeSync(fd, buffer, offset, half, position);
        throw new Error('ENOSPC: no space left on device');
      },
    };
    const broken = store.createPriceStore({ file, fs: brokenFs });
    const failed = broken.saveRecord([{
      provider: 'demo', model: 'm1', uniform: 9, currency: 'CNY', source: 'manual', asOf: '2026-11-01', displayName: 'm1',
    }]);
    assert.equal(failed.ok, false);
    assert.match(failed.error, /原文件未改动/);
    assert.equal(nodeFs.readFileSync(file, 'utf8'), before, '原文件必须原样还在');
    assert.deepEqual(nodeFs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), [], '临时文件要清掉');

    // 读回来的还是旧价（没有被半份新文件污染）。
    const afterFailure = broken.loadTable();
    assert.equal(afterFailure.records.find((r) => r.model === 'm1').uniform, 1);
    assert.equal(JSON.parse(nodeFs.readFileSync(file, 'utf8')).records.length, 1);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('原子写：rename 失败同样不破坏原文件', () => {
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'dsh-price-rename-'));
  try {
    const file = path.join(dir, 'prices.json');
    const healthy = store.createPriceStore({ file });
    healthy.saveRecord([{
      provider: 'demo', model: 'm1', uniform: 1, currency: 'CNY', source: 'manual', asOf: '2026-11-01', displayName: 'm1',
    }]);
    const before = nodeFs.readFileSync(file, 'utf8');

    const brokenFs = { ...nodeFs, renameSync: () => { throw new Error('EPERM: operation not permitted'); } };
    const broken = store.createPriceStore({ file, fs: brokenFs });
    const failed = broken.saveRecord([{
      provider: 'demo', model: 'm1', uniform: 7, currency: 'CNY', source: 'manual', asOf: '2026-11-01', displayName: 'm1',
    }]);
    assert.equal(failed.ok, false);
    assert.equal(nodeFs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(nodeFs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('批量保存整批成功才落盘：其中一条不合法则整批不写', () => {
  store.resetToSeed();
  const before = nodeFs.readFileSync(STORE_FILE, 'utf8');
  const out = store.saveRecord([
    { provider: 'loomy', model: 'spark-x', input: 0.3, output: 0.3, cacheRead: 0.3 },
    { provider: 'loomy', model: 'mimo-v2.5', input: -5, output: 1, cacheRead: 1 },
  ]);
  assert.equal(out.ok, false);
  assert.equal(out.problems.length, 1, '坏的那条要报出来');
  assert.equal(nodeFs.readFileSync(STORE_FILE, 'utf8'), before, '整批拒写，文件不变');
  assert.equal(table.priceOf('loomy', 'spark-x', PEAK).prices.uniform, 0.1, '好的那条也没被写进去');
});

// ───────────────────────────────────────────────────────────────────────────
// 7. resetToSeed / 损坏兜底
// ───────────────────────────────────────────────────────────────────────────

test('resetToSeed 能把改坏的价恢复成出厂值', () => {
  store.resetToSeed();
  store.saveRecord({ provider: 'raccoon', model: 'sn-glm-5-3', input: 88, output: 88, cacheRead: 88 });
  assert.equal(table.priceOf('raccoon', 'sn-glm-5-3', PEAK).prices.uniform, 88);

  const out = store.resetToSeed();
  assert.equal(out.ok, true);
  assert.equal(out.table.length, 103);
  assert.equal(table.priceOf('raccoon', 'sn-glm-5-3', PEAK).prices.uniform, 0.75, '恢复出厂价');
  assert.equal(table.priceOf('raccoon', 'sn-glm-5-3', PEAK).source, 'name-suffix', '来源也恢复');
  assert.equal(recordsOnDisk().length, 103);
});

test('存储不是合法 JSON：不崩溃，回落种子并报告；且不覆盖用户字节', () => {
  const corrupt = '{ "records": [ this is not json';
  nodeFs.writeFileSync(STORE_FILE, corrupt, 'utf8');

  const loaded = store.loadTable();
  assert.equal(loaded.source, 'seed-fallback');
  assert.ok(loaded.notices.includes('store-parse-error'), '要报告出来，不能静默');
  assert.equal(loaded.problems.length, 1);
  assert.equal(loaded.records.length, 103, '回落种子');

  // 取价照常工作（统计页不能因为一份坏文件整片消失）。
  const prices = table.priceOf('raccoon', 'sn-glm-5-3', PEAK);
  assert.equal(prices.known, true);
  assert.equal(prices.prices.uniform, 0.75);

  assert.equal(nodeFs.readFileSync(STORE_FILE, 'utf8'), corrupt, '不许覆盖用户的字节（让人能自己看一眼）');

  // resetToSeed 能救回来。
  assert.equal(store.resetToSeed().ok, true);
  assert.equal(store.loadTable().source, 'store');
  assert.equal(table.priceOf('raccoon', 'sn-glm-5-3', PEAK).prices.uniform, 0.75);
});

test('存储结构不对（records 不是数组）：同样回落种子并报告', () => {
  nodeFs.writeFileSync(STORE_FILE, JSON.stringify({ version: 1, records: 5 }), 'utf8');
  const loaded = store.loadTable();
  assert.equal(loaded.source, 'seed-fallback');
  assert.ok(loaded.notices.includes('store-shape-error'));
  assert.equal(loaded.records.length, 103);
});

test('存储里混入非法记录：坏的被忽略，好的照常用（不整表失效）', () => {
  store.resetToSeed();
  const envelope = readStoreFile();
  envelope.records.push({ provider: 'bad', model: 'nope', currency: 'CNY', source: 'manual', asOf: '2026-11-01' });
  nodeFs.writeFileSync(STORE_FILE, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');

  const loaded = store.loadTable();
  assert.equal(loaded.source, 'store');
  assert.ok(loaded.notices.includes('store-has-invalid-records'));
  assert.equal(loaded.problems.length, 1, '非法记录被点名');
  assert.equal(table.priceOf('bad', 'nope', PEAK).known, false, '非法记录不进索引');
  assert.equal(table.priceOf('raccoon', 'sn-glm-5-3', PEAK).prices.uniform, 0.75, '好记录不受影响');
});

test('存储损坏后保存：整表重写为合法 JSON，并告知原文件已被替换', () => {
  nodeFs.writeFileSync(STORE_FILE, '{ broken', 'utf8');
  const out = store.saveRecord({
    provider: 'raccoon', model: 'sn-kimi-k3', input: 2, output: 2, cacheRead: 2,
  });
  assert.equal(out.ok, true, JSON.stringify(out.problems));
  assert.ok(out.notices.includes('overwrote-corrupt-store'), '必须告诉用户坏文件被整表替换了');
  const envelope = readStoreFile();
  assert.equal(envelope.records.length, 103, '重写的是完整的表（种子 + 改动），不是只剩一条');
  assert.equal(table.priceOf('raccoon', 'sn-kimi-k3', PEAK).prices.uniform, 2);
  assert.equal(table.priceOf('loomy', 'spark-x', PEAK).prices.uniform, 0.1, '其它条目仍是种子值');
});

test('种子落盘失败：仍按种子取价，但不会每次取价都重试写盘', () => {
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'dsh-price-readonly-'));
  try {
    let mkdirCalls = 0;
    const readOnlyFs = {
      ...nodeFs,
      mkdirSync: () => {
        mkdirCalls += 1;
        throw new Error('EROFS: read-only file system');
      },
    };
    const readOnly = store.createPriceStore({ file: path.join(dir, 'prices.json'), fs: readOnlyFs });
    readOnly.registerSeed(table.SEED_RECORDS);

    const first = readOnly.loadTable();
    assert.equal(first.source, 'seed');
    assert.ok(first.notices.includes('seed-write-failed'));
    assert.equal(first.records.length, 103, '落不了盘也要能取价');
    const attemptsAfterFirst = mkdirCalls;

    const second = readOnly.loadTable();
    assert.equal(second.records.length, 103);
    assert.equal(mkdirCalls, attemptsAfterFirst, '失败过一次就不再反复尝试写盘');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 8. 配置页的三字段视图与辅助函数
// ───────────────────────────────────────────────────────────────────────────

test('unifiedPricesOf：单一价三个框预填同一个值；free 预填 0', () => {
  store.resetToSeed();
  // 非法/空对象不该炸，只是返回 null（配置页可以据此跳过渲染）。
  assert.equal(store.unifiedPricesOf(null), null);
  assert.equal(store.unifiedPricesOf({}), null);

  const uniformRecord = store.listRecords().find((r) => r.provider === 'raccoon' && r.model === 'sn-glm-5-3');
  const view = store.unifiedPricesOf(uniformRecord);
  assert.equal(view.form, 'uniform');
  assert.equal(view.input, 0.75);
  assert.equal(view.output, 0.75, '单一价三个框预填同值');
  assert.equal(view.cacheRead, 0.75);
  assert.equal(view.peakDiffers, false);

  const freeRecord = store.listRecords().find((r) => r.provider === 'opencode' && r.model === 'big-pickle');
  const freeView = store.unifiedPricesOf(freeRecord);
  assert.equal(freeView.form, 'free');
  assert.equal(freeView.free, true);
  assert.equal(freeView.input, 0);
});

test('unifiedPricesOf：split 记录取 standard 档，两档不同价时 peakDiffers 为 true', () => {
  store.resetToSeed();
  const record = store.listRecords().find((r) => r.provider === 'deepseek-official' && r.model === 'deepseek-flash');
  const view = store.unifiedPricesOf(record);
  assert.equal(view.form, 'split');
  assert.deepEqual([view.input, view.output, view.cacheRead], [2, 8, 0.04], '预填高峰档');
  assert.equal(view.peakDiffers, true, '两档不同价：保存后会合并为同价');
  assert.deepEqual(view.offPeak, { input: 1, output: 4, cacheRead: 0.02 });

  const flat = store.listRecords().find((r) => r.provider === 'zai' && r.model === 'glm-4.6');
  const flatView = store.unifiedPricesOf(flat);
  assert.equal(flatView.peakDiffers, false, '全天一价没有峰谷差');
  assert.equal(flatView.offPeak, null);
});

test('saveRecord 也能直接保存一条完整记录（不是三字段编辑时的路径）', () => {
  store.resetToSeed();
  const out = store.saveRecord([{
    provider: 'demo', model: 'm2', displayName: 'Demo', currency: 'USD',
    source: 'manual', asOf: '2026-11-01', input: { standard: 1, offPeak: 1 }, output: { standard: 2 }, cacheRead: { standard: 0.1 },
  }]);
  // offPeak 只有 input 有 → 其余两槽没有 offPeak 也算合法（校验只看"有 offPeak 就要有 schedule"）。
  assert.equal(out.problems.some((p) => /schedule/.test(p.reason)), true, '有 offPeak 却没 schedule 必须被拒');

  const withSchedule = store.saveRecord([{
    provider: 'demo', model: 'm2', displayName: 'Demo', currency: 'USD',
    source: 'manual', asOf: '2026-11-01',
    input: { standard: 1, offPeak: 0.5 }, output: { standard: 2, offPeak: 1 }, cacheRead: { standard: 0.1, offPeak: 0.05 },
    schedule: { offsetMinutes: 480, peakWindows: [[9, 12]], peakDays: 'weekdays', holidays: false },
  }]);
  assert.equal(withSchedule.ok, true, JSON.stringify(withSchedule.problems));
  assert.equal(withSchedule.table.length, 104, '新记录追加，不覆盖种子');
  const prices = table.priceOf('demo', 'm2', PEAK);
  assert.equal(prices.form, 'split');
  assert.deepEqual(prices.prices, { input: 1, output: 2, cacheRead: 0.1 });
});

test('upsert：同一个 渠道×模型 改写两次不会多出一条', () => {
  store.resetToSeed();
  store.saveRecord({ provider: 'loomy', model: 'spark-x', input: 0.3, output: 0.3, cacheRead: 0.3 });
  store.saveRecord({ provider: 'loomy', model: 'spark-x', input: 0.4, output: 0.4, cacheRead: 0.4 });
  const rows = recordsOnDisk().filter((r) => r.provider === 'loomy' && r.model === 'spark-x');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].uniform, 0.4);
  assert.equal(recordsOnDisk().length, 103, '总数不变');
  // 改第二次不能把"真正的出处"覆盖成 manual。
  assert.equal(rows[0].seedSource, 'name-suffix', '原始来源要留在 seedSource');
  assert.equal(rows[0].seedAsOf, '2026-11-14');
});

// ───────────────────────────────────────────────────────────────────────────
// 9. 存储位置与命名空间
// ───────────────────────────────────────────────────────────────────────────

test('存储位置遵循 $DSH_HOME/storages/<插件命名空间>/ 的落盘约定', () => {
  assert.equal(store.STORE_DIR_NAME, 'dsh-quota-usage');
  assert.equal(store.STORE_FILE_NAME, 'price-table.json');

  // 1) 环境变量优先（本测试文件就是靠它隔离的）。
  assert.equal(store.storePath(), path.resolve(STORE_FILE));

  // 2) 没有环境变量时落到 $DSH_HOME/storages/<namespace>/。
  const saved = process.env[store.STORE_ENV];
  delete process.env[store.STORE_ENV];
  try {
    const isolated = store.createPriceStore({ home: path.join(HOME, 'fake-dsh-home') });
    assert.equal(
      isolated.storePath(),
      path.join(HOME, 'fake-dsh-home', 'storages', 'dsh-quota-usage', 'price-table.json'),
    );
    // 3) 显式 file 的优先级最高。
    const byFile = store.createPriceStore({ file: path.join(HOME, 'explicit.json'), home: path.join(HOME, 'ignored') });
    assert.equal(byFile.storePath(), path.join(HOME, 'explicit.json'));
  } finally {
    process.env[store.STORE_ENV] = saved;
  }
});

test('没有注册种子时不落盘（宁可空表也不许把空表写进用户存储）', () => {
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'dsh-price-noseed-'));
  try {
    const file = path.join(dir, 'prices.json');
    const bare = store.createPriceStore({ file });
    const loaded = bare.loadTable();
    assert.equal(loaded.records.length, 0);
    assert.equal(loaded.source, 'seed-unregistered');
    assert.equal(nodeFs.existsSync(file), false, '没有种子就不该创建文件');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PRICE_RECORDS 仍是种子别名，PRICE_RECORD_PROBLEMS 为空（既有断言不被打断）', () => {
  assert.equal(table.PRICE_RECORDS, table.SEED_RECORDS, '两个名字指向同一个数组对象');
  assert.deepEqual(table.PRICE_RECORD_PROBLEMS.map((p) => p.reason), []);
  assert.equal(table.currentTable().source, 'store');
  assert.equal(table.currentTable().records.length, 103);
});
