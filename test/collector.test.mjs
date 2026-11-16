// 统一采集调度器：验收重点是「展示路径上不许有请求」和「定时器不出岔子」。
//
// 这一组测试全程**不 sleep**：时钟与定时器都是注入的假实现，时间靠 `clock.advance()`
// 显式推进，`setImmediate` 只用来让 Promise 链跑完（它不是睡眠，也不依赖墙钟）。
// 这样既能把 10 分钟级的调度压缩成毫秒级断言，也不会因为 CI 慢而抖成 flaky。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLLECT_KINDS,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  RECOMMENDED_MIN_INTERVAL_MS,
  normalizeInterval,
  createCollector,
} from '../lib/collector.js';

/** 让挂起的 Promise 链跑完（宏任务检查点，不是 sleep）。 */
async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * 假时钟 + 假定时器。
 *
 * - `advance(ms)`：推进时间并**真实触发**到期的定时器回调（等价于"时间真的过去了"）
 * - `skip(ms)`：只推进时间，不触发任何定时器（用来区分 updatedAt / attemptedAt）
 * - `pending()`：当前还挂着的定时器数量（用来验证 stop 是否清干净）
 */
function makeFakeClock(startMs = 1_700_000_000_000) {
  let current = startMs;
  let seq = 0;
  /** @type {Map<number, { at: number, fn: Function }>} */
  const timers = new Map();

  const timersApi = {
    setTimeout(fn, ms) {
      seq += 1;
      const id = seq;
      timers.set(id, { at: current + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };

  async function advance(ms) {
    const target = current + ms;
    for (;;) {
      let nextId = null;
      let next = null;
      for (const [id, timer] of timers) {
        if (timer.at > target) continue;
        if (next === null || timer.at < next.at || (timer.at === next.at && id < nextId)) {
          nextId = id;
          next = timer;
        }
      }
      if (next === null) break;
      timers.delete(nextId);
      current = next.at;
      next.fn();
      // 定时器回调里排下一次是异步链条，每触发一个都要让它跑完再找下一个。
      await settle();
    }
    current = target;
    await settle();
  }

  return {
    now: () => current,
    timers: timersApi,
    advance,
    skip(ms) {
      current += ms;
    },
    pending: () => timers.size,
  };
}

/** 造一个"每次采集都成功、并记录调用次数"的采集函数。 */
function okCollector(value, counter) {
  return async () => {
    counter.calls += 1;
    return typeof value === 'function' ? value(counter.calls) : value;
  };
}

/** 造一个"每次都抛错"的采集函数。 */
function failCollector(message, counter) {
  return async () => {
    counter.calls += 1;
    throw new Error(message);
  };
}

test('常量：三类目标、默认 10 分钟、硬下限 1 分钟、建议下限 10 分钟', () => {
  assert.deepEqual([...COLLECT_KINDS], ['credits', 'prepaid', 'subscription']);
  assert.equal(DEFAULT_INTERVAL_MS, 10 * 60 * 1000);
  assert.equal(MIN_INTERVAL_MS, 60 * 1000);
  assert.equal(RECOMMENDED_MIN_INTERVAL_MS, 10 * 60 * 1000);
  // 建议下限不得低于硬下限，否则界面上会出现"建议值被静默夹掉"的矛盾提示。
  assert.ok(RECOMMENDED_MIN_INTERVAL_MS >= MIN_INTERVAL_MS);
  // 常量是冻结的，接线方不能顺手改掉全局默认。
  assert.equal(Object.isFrozen(COLLECT_KINDS), true);
});

test('normalizeInterval：脏值一律回落到 10 分钟，且不标记 clamped', () => {
  for (const bad of [undefined, null, 0, -1, -600000, NaN, Infinity, -Infinity, 'abc', '', '600000', {}, []]) {
    const got = normalizeInterval(bad);
    assert.deepEqual(got, { ms: DEFAULT_INTERVAL_MS, clamped: false }, `${String(bad)} 应回落默认值`);
  }
});

test('normalizeInterval：低于 1 分钟夹到 1 分钟并标记 clamped', () => {
  assert.deepEqual(normalizeInterval(1000), { ms: MIN_INTERVAL_MS, clamped: true });
  assert.deepEqual(normalizeInterval(1), { ms: MIN_INTERVAL_MS, clamped: true });
  // 刚好等于下限不算被夹。
  assert.deepEqual(normalizeInterval(MIN_INTERVAL_MS), { ms: MIN_INTERVAL_MS, clamped: false });
});

test('normalizeInterval：合法值原样返回，小数四舍五入到毫秒', () => {
  assert.deepEqual(normalizeInterval(DEFAULT_INTERVAL_MS), { ms: DEFAULT_INTERVAL_MS, clamped: false });
  assert.deepEqual(normalizeInterval(15 * 60 * 1000), { ms: 900000, clamped: false });
  // 小数先取整再判下限：60000.4 → 60000（不越界）。
  assert.deepEqual(normalizeInterval(60000.4), { ms: 60000, clamped: false });
  assert.deepEqual(normalizeInterval(119999.6), { ms: 120000, clamped: false });
  // 1234.6 取整后是 1235，仍远低于 1 分钟下限 → 被夹住。
  assert.deepEqual(normalizeInterval(1234.6), { ms: MIN_INTERVAL_MS, clamped: true });
});

test('getSnapshot 是纯读取：反复读也不触发采集，从未采集时 stale:true / value:null', async () => {
  const counter = { calls: 0 };
  const clock = makeFakeClock();
  const c = createCollector({
    collectors: { credits: okCollector('x', counter) },
    now: clock.now,
    timers: clock.timers,
  });

  // 还没 start，也没有任何定时器被排出去。
  assert.equal(clock.pending(), 0);
  for (let i = 0; i < 20; i += 1) c.getSnapshot('credits');
  await settle();

  assert.equal(counter.calls, 0, 'getSnapshot 不得触发采集');
  assert.equal(clock.pending(), 0, 'getSnapshot 不得排定时器');

  const snap = c.getSnapshot('credits');
  assert.deepEqual(snap, {
    kind: 'credits',
    value: null,
    updatedAt: null,
    attemptedAt: null,
    nextAt: null,
    intervalMs: DEFAULT_INTERVAL_MS,
    lastError: null,
    stale: true,
    collecting: false,
    failures: 0,
  });
});

test('getSnapshot 返回副本：外部乱改不会污染内部状态', async () => {
  const clock = makeFakeClock();
  const c = createCollector({ collectors: { credits: okCollector({ v: 1 }, { calls: 0 }) }, now: clock.now, timers: clock.timers });
  await c.collectNow('credits');

  const snap = c.getSnapshot('credits');
  snap.value = 'hacked';
  snap.stale = true;
  snap.failures = 99;

  const again = c.getSnapshot('credits');
  assert.deepEqual(again.value, { v: 1 });
  assert.equal(again.stale, false);
  assert.equal(again.failures, 0);
});

test('start 到点采集并缓存：value / updatedAt / stale / nextAt 全部就位', async () => {
  const counter = { calls: 0 };
  const clock = makeFakeClock();
  const c = createCollector({
    collectors: { credits: okCollector({ credits: 42 }, counter) },
    now: clock.now,
    timers: clock.timers,
  });

  c.start();
  assert.equal(counter.calls, 0, 'start 不立即采集，只排定时器');
  assert.equal(c.getSnapshot('credits').nextAt, clock.now() + DEFAULT_INTERVAL_MS);

  // 差一点点不触发。
  await clock.advance(DEFAULT_INTERVAL_MS - 1);
  assert.equal(counter.calls, 0);

  await clock.advance(1);
  assert.equal(counter.calls, 1);

  const snap = c.getSnapshot('credits');
  assert.deepEqual(snap.value, { credits: 42 });
  assert.equal(snap.updatedAt, clock.now());
  assert.equal(snap.attemptedAt, clock.now());
  assert.equal(snap.stale, false);
  assert.equal(snap.lastError, null);
  assert.equal(snap.failures, 0);
  assert.equal(snap.collecting, false);
  assert.equal(snap.nextAt, clock.now() + DEFAULT_INTERVAL_MS);

  // 再过一个间隔继续采，说明定时器链是活的。
  await clock.advance(DEFAULT_INTERVAL_MS);
  assert.equal(counter.calls, 2);
  c.stop();
});

test('start 幂等：重复调用不叠加定时器', async () => {
  const counter = { calls: 0 };
  const clock = makeFakeClock();
  const c = createCollector({ collectors: { credits: okCollector('v', counter) }, now: clock.now, timers: clock.timers });

  c.start();
  assert.equal(clock.pending(), 1);
  c.start();
  c.start();
  assert.equal(clock.pending(), 1, '重复 start 不得叠加');

  await clock.advance(DEFAULT_INTERVAL_MS);
  assert.equal(counter.calls, 1);
  c.stop();
});

test('stop 彻底：定时器清零、nextAt 归空、之后不再自动采集', async () => {
  const counter = { calls: 0 };
  const clock = makeFakeClock();
  const c = createCollector({ collectors: { credits: okCollector('v', counter) }, now: clock.now, timers: clock.timers });

  c.start();
  assert.equal(c.isRunning(), true);
  c.stop();

  assert.equal(c.isRunning(), false);
  assert.equal(clock.pending(), 0, 'stop 后不得残留定时器');
  assert.equal(c.getSnapshot('credits').nextAt, null);

  await clock.advance(DEFAULT_INTERVAL_MS * 5);
  assert.equal(counter.calls, 0, 'stop 后定时不得触发');

  // 重复 stop 是安全的空操作。
  c.stop();
  assert.equal(clock.pending(), 0);
});

test('stop 之后 collectNow 仍可显式调用（手动刷新不受定时器影响）', async () => {
  const counter = { calls: 0 };
  const clock = makeFakeClock();
  const c = createCollector({ collectors: { credits: okCollector('v', counter) }, now: clock.now, timers: clock.timers });

  c.start();
  c.stop();

  await c.collectNow('credits');
  assert.equal(counter.calls, 1);
  assert.equal(c.getSnapshot('credits').value, 'v');
  // 手动采集不复活定时器。
  assert.equal(clock.pending(), 0);
  assert.equal(c.getSnapshot('credits').nextAt, null);
});

test('失败保留旧值：只更新 attemptedAt / lastError / failures，stale 置 true', async () => {
  const clock = makeFakeClock();
  let mode = 'ok';
  const c = createCollector({
    collectors: {
      credits: async () => {
        if (mode === 'fail') throw new Error('upstream 502');
        return { credits: 7 };
      },
    },
    now: clock.now,
    timers: clock.timers,
  });

  await c.collectNow('credits');
  const good = c.getSnapshot('credits');
  assert.deepEqual(good.value, { credits: 7 });
  const goodUpdatedAt = good.updatedAt;

  clock.skip(30000);
  mode = 'fail';
  await c.collectNow('credits');

  const bad = c.getSnapshot('credits');
  assert.deepEqual(bad.value, { credits: 7 }, '失败不得抹掉旧值');
  assert.equal(bad.updatedAt, goodUpdatedAt, '失败不得改 updatedAt');
  assert.equal(bad.attemptedAt, goodUpdatedAt + 30000);
  assert.equal(bad.lastError, 'upstream 502');
  assert.equal(bad.failures, 1);
  assert.equal(bad.stale, true);
  assert.equal(bad.collecting, false);
});

test('连续失败累加 failures，且旧值一直在', async () => {
  const clock = makeFakeClock();
  let mode = 'ok';
  const c = createCollector({
    collectors: {
      credits: async () => {
        if (mode === 'fail') throw new Error('nope');
        return 'good';
      },
    },
    now: clock.now,
    timers: clock.timers,
  });

  await c.collectNow('credits');
  mode = 'fail';
  await c.collectNow('credits');
  await c.collectNow('credits');
  await c.collectNow('credits');

  const snap = c.getSnapshot('credits');
  assert.equal(snap.failures, 3);
  assert.equal(snap.value, 'good');
  assert.equal(snap.stale, true);
});

test('成功一次就清空 lastError 并把 failures 归零', async () => {
  const clock = makeFakeClock();
  let mode = 'fail';
  const c = createCollector({
    collectors: {
      subscription: async () => {
        if (mode === 'fail') throw new Error('boom');
        return { ok: true };
      },
    },
    now: clock.now,
    timers: clock.timers,
  });

  await c.collectNow('subscription');
  await c.collectNow('subscription');
  assert.equal(c.getSnapshot('subscription').failures, 2);

  mode = 'ok';
  await c.collectNow('subscription');

  const snap = c.getSnapshot('subscription');
  assert.equal(snap.lastError, null);
  assert.equal(snap.failures, 0);
  assert.equal(snap.stale, false);
  assert.deepEqual(snap.value, { ok: true });
});

test('非 Error 的抛出物也能变成可展示的字符串', async () => {
  const clock = makeFakeClock();
  const c = createCollector({
    collectors: {
      credits: async () => { throw 'plain string'; },
      prepaid: async () => { throw { code: 429 }; },
      subscription: async () => { throw undefined; },
    },
    now: clock.now,
    timers: clock.timers,
  });

  await c.collectNow();
  assert.equal(c.getSnapshot('credits').lastError, 'plain string');
  assert.equal(c.getSnapshot('prepaid').lastError, '{"code":429}');
  assert.equal(c.getSnapshot('subscription').lastError, 'unknownError');
});

test('并发合流：同一 kind 在飞时再次 collectNow 复用同一个 Promise', async () => {
  const clock = makeFakeClock();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const counter = { calls: 0 };
  const c = createCollector({
    collectors: {
      credits: () => {
        counter.calls += 1;
        return gate;
      },
    },
    now: clock.now,
    timers: clock.timers,
  });

  const p1 = c.collectNow('credits');
  const p2 = c.collectNow('credits');
  assert.equal(counter.calls, 1, '在飞时不得再打一次上游');
  assert.equal(p1, p2, '必须复用同一个 Promise');
  assert.equal(c.getSnapshot('credits').collecting, true);

  release('done');
  await Promise.all([p1, p2]);

  assert.equal(c.getSnapshot('credits').collecting, false);
  assert.equal(c.getSnapshot('credits').value, 'done');

  // 落地后可以再来一次，不会被"永远合流"卡住。
  await c.collectNow('credits');
  assert.equal(counter.calls, 2);
});

test('并发合流：定时器撞上手动刷新也只打一次上游', async () => {
  const clock = makeFakeClock();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const counter = { calls: 0 };
  const c = createCollector({
    collectors: {
      credits: () => {
        counter.calls += 1;
        return gate;
      },
    },
    now: clock.now,
    timers: clock.timers,
  });

  c.start();
  await clock.advance(DEFAULT_INTERVAL_MS);
  assert.equal(counter.calls, 1);

  const manual = c.collectNow('credits');
  assert.equal(counter.calls, 1, '定时采集在飞时手动刷新应合流');
  release('v');
  await manual;
  await settle();

  assert.equal(c.getSnapshot('credits').value, 'v');
  c.stop();
});

test('三类互不影响：一个失败不干扰另外两类的数据与节奏', async () => {
  const clock = makeFakeClock();
  const counters = { credits: { calls: 0 }, prepaid: { calls: 0 }, subscription: { calls: 0 } };
  const c = createCollector({
    collectors: {
      credits: failCollector('credits down', counters.credits),
      prepaid: okCollector({ balance: 100 }, counters.prepaid),
      subscription: okCollector({ percent: 12 }, counters.subscription),
    },
    now: clock.now,
    timers: clock.timers,
  });

  c.start();
  await clock.advance(DEFAULT_INTERVAL_MS);

  assert.equal(counters.credits.calls, 1);
  assert.equal(counters.prepaid.calls, 1);
  assert.equal(counters.subscription.calls, 1);

  const credits = c.getSnapshot('credits');
  assert.equal(credits.value, null);
  assert.equal(credits.stale, true);
  assert.equal(credits.lastError, 'credits down');
  assert.equal(credits.failures, 1);

  assert.deepEqual(c.getSnapshot('prepaid').value, { balance: 100 });
  assert.equal(c.getSnapshot('prepaid').stale, false);
  assert.deepEqual(c.getSnapshot('subscription').value, { percent: 12 });
  assert.equal(c.getSnapshot('subscription').stale, false);

  // 下一个周期：credits 继续重试（failures 累加），另外两类照常刷新成功。
  await clock.advance(DEFAULT_INTERVAL_MS);
  assert.equal(counters.credits.calls, 2);
  assert.equal(c.getSnapshot('credits').failures, 2);
  assert.equal(c.getSnapshot('prepaid').failures, 0);
  assert.equal(c.getSnapshot('prepaid').stale, false);
  c.stop();
});

test('采集函数抛错不会让定时器停摆：后续周期照常触发', async () => {
  const clock = makeFakeClock();
  const counter = { calls: 0 };
  const c = createCollector({
    collectors: { credits: failCollector('always', counter) },
    now: clock.now,
    timers: clock.timers,
  });

  c.start();
  await clock.advance(DEFAULT_INTERVAL_MS);
  assert.equal(counter.calls, 1);

  await clock.advance(DEFAULT_INTERVAL_MS);
  await clock.advance(DEFAULT_INTERVAL_MS);
  assert.equal(counter.calls, 3, '失败后定时器链必须继续');
  assert.equal(c.getSnapshot('credits').failures, 3);
  assert.equal(clock.pending(), 1, '任何时刻只有一个待触发的定时器');
  c.stop();
});

test('采集函数同步抛错同样不影响定时器链', async () => {
  const clock = makeFakeClock();
  const counter = { calls: 0 };
  const c = createCollector({
    collectors: {
      credits: () => {
        counter.calls += 1;
        throw new Error('sync explode');
      },
    },
    now: clock.now,
    timers: clock.timers,
  });

  c.start();
  await clock.advance(DEFAULT_INTERVAL_MS);
  assert.equal(counter.calls, 1);
  assert.equal(c.getSnapshot('credits').lastError, 'sync explode');

  await clock.advance(DEFAULT_INTERVAL_MS);
  assert.equal(counter.calls, 2);
  c.stop();
});

test('间隔按 kind 独立：各自按自己的周期触发', async () => {
  const clock = makeFakeClock();
  const counters = { credits: { calls: 0 }, prepaid: { calls: 0 }, subscription: { calls: 0 } };
  const c = createCollector({
    intervals: { credits: MIN_INTERVAL_MS, prepaid: 5 * 60 * 1000, subscription: 15 * 60 * 1000 },
    collectors: {
      credits: okCollector('c', counters.credits),
      prepaid: okCollector('p', counters.prepaid),
      subscription: okCollector('s', counters.subscription),
    },
    now: clock.now,
    timers: clock.timers,
  });

  assert.equal(c.intervalOf('credits'), MIN_INTERVAL_MS);
  assert.equal(c.intervalOf('prepaid'), 5 * 60 * 1000);
  assert.equal(c.intervalOf('subscription'), 15 * 60 * 1000);

  c.start();
  await clock.advance(15 * 60 * 1000);

  assert.equal(counters.credits.calls, 15, '1 分钟间隔在 15 分钟内应采 15 次');
  assert.equal(counters.prepaid.calls, 3);
  assert.equal(counters.subscription.calls, 1);
  c.stop();
});

test('setIntervals：未运行时只记值，intervalOf 立即反映', () => {
  const clock = makeFakeClock();
  const c = createCollector({ collectors: { credits: okCollector('v', { calls: 0 }) }, now: clock.now, timers: clock.timers });

  assert.equal(c.intervalOf('credits'), DEFAULT_INTERVAL_MS);
  c.setIntervals({ credits: 15 * 60 * 1000 });
  assert.equal(c.intervalOf('credits'), 15 * 60 * 1000);
  // 没 start 就不该冒出定时器。
  assert.equal(clock.pending(), 0);
});

test('setIntervals：运行中改频率立刻重排，且旧节奏不再触发', async () => {
  const clock = makeFakeClock();
  const counter = { calls: 0 };
  const c = createCollector({ collectors: { credits: okCollector('v', counter) }, now: clock.now, timers: clock.timers });

  c.start();
  assert.equal(c.getSnapshot('credits').nextAt, clock.now() + DEFAULT_INTERVAL_MS);

  c.setIntervals({ credits: 2 * 60 * 1000 });
  assert.equal(c.intervalOf('credits'), 2 * 60 * 1000);
  assert.equal(c.getSnapshot('credits').nextAt, clock.now() + 2 * 60 * 1000);
  assert.equal(clock.pending(), 1, '改频率只应换一个新定时器，不得叠加');

  await clock.advance(2 * 60 * 1000);
  assert.equal(counter.calls, 1);

  // 原 10 分钟节奏不应再补一次。
  await clock.advance(8 * 60 * 1000);
  assert.equal(counter.calls, 5, '2 分钟间隔在 10 分钟内共 5 次');
  c.stop();
});

test('setIntervals：低于下限被夹住并写日志，未提及的 kind 保持原值', () => {
  const clock = makeFakeClock();
  const logs = [];
  const c = createCollector({
    intervals: { prepaid: 20 * 60 * 1000 },
    collectors: {
      credits: okCollector('c', { calls: 0 }),
      prepaid: okCollector('p', { calls: 0 }),
      subscription: okCollector('s', { calls: 0 }),
    },
    now: clock.now,
    timers: clock.timers,
    log: (msg) => logs.push(msg),
  });

  c.setIntervals({ credits: 1000 });
  assert.equal(c.intervalOf('credits'), MIN_INTERVAL_MS);
  assert.equal(c.intervalOf('prepaid'), 20 * 60 * 1000, '未提及的 kind 不得被改');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /credits/);
  assert.match(logs[0], /下限/);
});

test('构造时传入过低间隔也会被夹住并写一次日志', () => {
  const clock = makeFakeClock();
  const logs = [];
  const c = createCollector({
    intervals: { credits: 5, subscription: 'nonsense' },
    collectors: { credits: okCollector('c', { calls: 0 }), subscription: okCollector('s', { calls: 0 }) },
    now: clock.now,
    timers: clock.timers,
    log: (msg) => logs.push(msg),
  });

  assert.equal(c.intervalOf('credits'), MIN_INTERVAL_MS);
  assert.equal(c.intervalOf('subscription'), DEFAULT_INTERVAL_MS);
  assert.equal(logs.length, 1, '只有被夹的那个写日志');
});

test('collectNow 省略 kind 时三类都采，且并行发起', async () => {
  const clock = makeFakeClock();
  const seen = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const c = createCollector({
    collectors: {
      credits: async () => { seen.push('credits'); return 'c'; },
      prepaid: async () => { seen.push('prepaid'); return 'p'; },
      subscription: () => { seen.push('subscription'); return gate; },
    },
    now: clock.now,
    timers: clock.timers,
  });

  const all = c.collectNow();
  await settle();
  // 三类都已发起（不等前一个结束），说明不是串行排队。
  assert.deepEqual(seen.sort(), ['credits', 'prepaid', 'subscription']);

  release('s');
  await all;

  assert.equal(c.getSnapshot('credits').value, 'c');
  assert.equal(c.getSnapshot('prepaid').value, 'p');
  assert.equal(c.getSnapshot('subscription').value, 's');
});

test('collectNow 不改变定时器节奏（nextAt 保持不动）', async () => {
  const clock = makeFakeClock();
  const c = createCollector({ collectors: { credits: okCollector('v', { calls: 0 }) }, now: clock.now, timers: clock.timers });

  c.start();
  const plannedBefore = c.getSnapshot('credits').nextAt;

  clock.skip(60000);
  await c.collectNow('credits');

  assert.equal(c.getSnapshot('credits').nextAt, plannedBefore, '手动刷新不得挪动排好的下一次');
  assert.equal(clock.pending(), 1);
  c.stop();
});

test('采集函数缺失：getSnapshot 可用、collectNow 不抛、不排定时器', async () => {
  const clock = makeFakeClock();
  const logs = [];
  const c = createCollector({
    collectors: { credits: okCollector('v', { calls: 0 }) },
    now: clock.now,
    timers: clock.timers,
    log: (msg) => logs.push(msg),
  });

  c.start();
  // 只为有采集函数的那一类排定时器，其余空转没有意义。
  assert.equal(clock.pending(), 1);
  assert.equal(c.getSnapshot('prepaid').nextAt, null);

  await c.collectNow('prepaid');
  const snap = c.getSnapshot('prepaid');
  assert.equal(snap.value, null);
  assert.equal(snap.stale, true);
  assert.equal(snap.lastError, 'collectorMissing');

  // 三类并发采集时也不能因为缺一类而整体失败。
  await c.collectNow();
  assert.equal(c.getSnapshot('credits').value, 'v');
  c.stop();
});

test('未知 kind：读快照返回空快照而不抛，采集是安全的空操作', async () => {
  const clock = makeFakeClock();
  const logs = [];
  const c = createCollector({
    collectors: { credits: okCollector('v', { calls: 0 }) },
    now: clock.now,
    timers: clock.timers,
    log: (msg) => logs.push(msg),
  });

  const snap = c.getSnapshot('nope');
  assert.equal(snap.kind, 'nope');
  assert.equal(snap.value, null);
  assert.equal(snap.stale, true);
  assert.equal(snap.intervalMs, DEFAULT_INTERVAL_MS);
  assert.equal(c.intervalOf('nope'), DEFAULT_INTERVAL_MS);

  await c.collectNow('nope');
  assert.ok(logs.length >= 1);
});

test('慢采集不会堆积：完成前不会排下一次，任何时刻只有一个待触发定时器', async () => {
  const clock = makeFakeClock();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const counter = { calls: 0 };
  const c = createCollector({
    collectors: {
      credits: () => {
        counter.calls += 1;
        return gate;
      },
    },
    now: clock.now,
    timers: clock.timers,
  });

  c.start();
  await clock.advance(DEFAULT_INTERVAL_MS);
  assert.equal(counter.calls, 1);
  assert.equal(clock.pending(), 0, '在飞期间不排下一次（递归 setTimeout 的关键性质）');

  // 时间过去三个周期，但因为上一次还没结束，一次都不该再发。
  await clock.advance(DEFAULT_INTERVAL_MS * 3);
  assert.equal(counter.calls, 1);
  assert.equal(c.getSnapshot('credits').collecting, true);

  release('slow');
  await settle();
  assert.equal(counter.calls, 1);
  assert.equal(c.getSnapshot('credits').value, 'slow');
  // 结束后才排下一次。
  assert.equal(clock.pending(), 1);
  assert.equal(c.getSnapshot('credits').nextAt, clock.now() + DEFAULT_INTERVAL_MS);
  c.stop();
});

test('未传 collectors / 未传 intervals 也能安全构造', async () => {
  const clock = makeFakeClock();
  const c = createCollector({ now: clock.now, timers: clock.timers });
  assert.equal(c.intervalOf('credits'), DEFAULT_INTERVAL_MS);
  c.start();
  assert.equal(clock.pending(), 0, '没有采集函数就不排定时器');
  await c.collectNow();
  c.stop();
  assert.equal(c.getSnapshot('credits').lastError, 'collectorMissing');
});

test('未注入 timers 时回落到真实定时器且 stop 能清掉', async () => {
  const counter = { calls: 0 };
  const c = createCollector({ collectors: { credits: okCollector('v', counter) } });
  c.start();
  assert.equal(c.isRunning(), true);
  assert.ok(c.getSnapshot('credits').nextAt > Date.now());
  // 不推进真实时间，只验证 stop 后不再有挂着的东西。
  c.stop();
  assert.equal(c.isRunning(), false);
  assert.equal(c.getSnapshot('credits').nextAt, null);
  await settle();
  assert.equal(counter.calls, 0);
});
