// 用量统计「后台预计算」的行为判据。
//
// 用户需求：统计改为**后台预计算**，打开统计页只读缓存；统计间隔可配置，默认 10 分钟。
//
// 这个文件只走**公开面**（HTTP 路由 + 配置项），不读 `lib/*.js` 的内部变量，
// 也不断言实现里有没有某个函数名——那类白盒断言在 meta-check 里是被禁的。
//
// ## 为什么需要「注入计数」
//
// 「打开页面不触发全库扫描」这件事，光看响应是看不出来的：一次"每请求都扫、但
// 结果一样"的实现，响应体与"读缓存"完全一致。所以必须数**扫描被调用了多少次**。
//
// 数法：用 Node 的 `registerHooks` 在**加载期**把 `lib/usage.js` 里导出的
// `createUsageScanner` 包一层计数器（host-route.test.mjs 已证明本仓可以用
// registerHooks 做模块级注入）。这是**测试侧**的注入，不改任何产品代码。
//
// 注入失败必须**报错而不是静默放行**：包不上计数器时，后面所有"扫描次数不变"的
// 断言都会变成永远成立的假绿。所以文件顶部有 `assertInjectionActive()`。
//
// ## 契约（字段名是与实现方约定的，不是猜的）
//
//   GET  /api/quota-usage/stats              → { ok, state, computedAt, stale, intervalMs, ... }
//   GET  /api/quota-usage/stats?session=ID   → 同上（只统计该会话，且**不**每请求重扫）
//   GET  /api/quota-usage/stats?scope=workspace → { ok, scope:'workspace', state, computedAt, stale, workspaces }
//   POST /api/quota-usage/stats              → 强制重算一次，返回同样形状
//
//   state      : 'ready' | 'computing'（未预热时不得报 ready）
//   computedAt : number（毫秒）| null（从未算过）
//   stale      : true 表示这份缓存比日志旧（日志变了但还没到下一次 tick）
//   intervalMs : 本次生效的统计间隔（默认 600000，下限 60000）
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

const CREDENTIALS_STUB = `
export function credentialRef(name) { return { kind: 'credential-ref', name }; }
export default { credentialRef };
`;

const SCHEMASTERY_STUB = `
const chain = () => new Proxy(function () {}, { get: () => chain, apply: () => chain });
const z = {
  object: chain, array: chain, string: chain, number: chain, boolean: chain,
  dict: chain, union: chain, const: chain, any: chain, literal: chain,
};
export default z;
`;

/** 计数器挂在 globalThis 上：加载期注入，运行时读取。 */
const COUNTER_KEY = '__dshUsageScanCounter__';

/**
 * 加载钩子：把 `lib/usage.js` 的 `createUsageScanner` 包一层计数。
 *
 * 变换是**精确到声明**的：只把 `export function createUsageScanner(` 改名为内部函数，
 * 再追加一个同名导出包装它。改不到（实现改名/换写法）时 `injected` 保持 false，
 * 由 assertInjectionActive 报错——绝不静默跳过。
 */
const injection = { attempted: false, applied: false };
const USAGE_URL_SUFFIX = '/lib/usage.js';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-credentials') {
      return { url: 'data:text/javascript,' + encodeURIComponent(CREDENTIALS_STUB), shortCircuit: true };
    }
    if (specifier === '@deepseek-ai/schemastery') {
      return { url: 'data:text/javascript,' + encodeURIComponent(SCHEMASTERY_STUB), shortCircuit: true };
    }
    const resolved = nextResolve(specifier, context);
    if (typeof resolved.url === 'string' && resolved.url.endsWith(USAGE_URL_SUFFIX)) {
      injection.attempted = true;
    }
    return resolved;
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (typeof url !== 'string' || !url.endsWith(USAGE_URL_SUFFIX)) return result;
    const source = String(result.source ?? '');
    const marker = 'export function createUsageScanner(';
    if (!source.includes(marker)) return result;
    const patched = source.replace(marker, 'function __createUsageScannerRaw(') + `
export function createUsageScanner(options) {
  const scanner = __createUsageScannerRaw(options);
  const counter = globalThis['${COUNTER_KEY}'] ??= { scan: 0, scanSession: 0, created: 0 };
  counter.created += 1;
  const scan = scanner.scan;
  const scanSession = scanner.scanSession;
  scanner.scan = (...args) => { counter.scan += 1; return scan(...args); };
  scanner.scanSession = (...args) => { counter.scanSession += 1; return scanSession(...args); };
  return scanner;
}
`;
    injection.applied = true;
    return { ...result, source: patched, shortCircuit: true };
  },
});

/** 注入没生效就直接失败：否则"扫描次数不变"会永远是假绿。 */
function assertInjectionActive() {
  assert.ok(injection.attempted, '未能拦截 lib/usage.js 的加载——统计注入链路失效，后续计数断言不可信');
  assert.ok(injection.applied,
    '未能在 lib/usage.js 里注入扫描计数器（createUsageScanner 的声明形式变了）。'
    + '请更新本文件的注入点，不要跳过这些判据。');
}

const { apply } = await import('../lib/index.js');

// ---- 最小 ctx（与 host-route.test.mjs 同口径）----

let keySeq = 0;
function makeCtx() {
  const routes = new Map();
  keySeq += 1;
  const ctx = {
    logger: { warn() {} },
    credentials: {
      resolve: async () => ({ value: `sk-test-${keySeq}` }),
      readRecord: async () => undefined,
      set: async () => {},
      unset: async () => {},
    },
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) };
      }
      if (name === 'llm') {
        return { listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }], listConfigurableProviders: () => [] };
      }
      return undefined;
    },
    effect(fn) { fn(); return () => {}; },
    webServer: {
      host: '127.0.0.1',
      register(route) { routes.set(route.path, route); return () => routes.delete(route.path); },
    },
  };
  return { ctx, routes };
}

function makeReq(url = '/api/quota-usage/stats', method = 'GET') {
  return { headers: { host: '127.0.0.1:64452' }, url, method };
}

function makeRes() {
  const res = {
    statusCode: 0,
    headersSent: false,
    body: undefined,
    writeHead(status) { res.statusCode = status; res.headersSent = true; },
    end(chunk) { res.body = chunk; },
  };
  return res;
}

async function call(route, req) {
  const res = makeRes();
  await route.handler(req, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}

// ---- 会话日志夹具 ----

/** 在临时 DSH_HOME 里铺一个会话日志；`events` 是事件数组。 */
function seedSession(home, sessionId, events) {
  const dir = join(home, 'sessions', '--ws--', sessionId);
  mkdirSync(dir, { recursive: true });
  const body = events.map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(body, 'utf8')));
}

function assistantEvent(id, provider, model, usage, time = 1000) {
  return { type: 'assistant/message', time, data: { message: { id, source: { provider, model } }, usage } };
}

/**
 * 一个可用的统计环境：临时 DSH_HOME + 已铺好的日志。
 *
 * 返回 `bumpLogs()`：往日志里追加一条新事件（模拟"又用了模型"），用于验证
 * "后台 tick 之后缓存反映新日志"。
 */
function makeStatsEnv({ sessions = 2 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-stats-pre-'));
  const ids = [];
  for (let i = 0; i < sessions; i += 1) {
    const id = `session-${i + 1}`;
    ids.push(id);
    seedSession(home, id, [
      assistantEvent(`m-${i}`, 'trae', 'deepseek-v4.1-flash', { inputTokens: 100, outputTokens: 10, totalTokens: 110 }),
    ]);
  }
  return {
    home,
    ids,
    bumpLogs(extra = 1) {
      for (let i = 0; i < extra; i += 1) {
        seedSession(home, ids[0], [
          assistantEvent(`m-${ids[0]}-${i}`, 'trae', 'deepseek-v4.1-flash', { inputTokens: 100, outputTokens: 10, totalTokens: 110 }),
          assistantEvent(`m-extra-${i}`, 'trae', 'deepseek-v4.1-flash', { inputTokens: 500, outputTokens: 50, totalTokens: 550 }),
        ]);
      }
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** 把过程包进 DSH_HOME 的作用域，结束后还原。 */
async function withHome(home, fn) {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
  }
}

/** 读扫描计数器并归零（每次断言只看这一段区间的调用）。 */
function resetCounter() {
  globalThis[COUNTER_KEY] = { scan: 0, scanSession: 0, created: 0 };
  return globalThis[COUNTER_KEY];
}

function readCounter() {
  const c = globalThis[COUNTER_KEY];
  assert.ok(c, '扫描计数器不存在——注入没生效');
  return c;
}

/** 让后台 tick 真的跑一次（只推进真实时间，不伪造时钟）。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把 `kinds[]` 里的 totalTokens 加总——"数据有没有反映新日志"用它判。 */
function totalTokensOf(kinds) {
  if (!Array.isArray(kinds)) return 0;
  let sum = 0;
  for (const kind of kinds) {
    if (kind === null || typeof kind !== 'object') continue;
    if (typeof kind.totalTokens === 'number' && Number.isFinite(kind.totalTokens)) sum += kind.totalTokens;
  }
  return sum;
}

// ---- 判据 1：打开统计页不触发全库扫描 --------------------------------

test('判据1：连续打开统计接口，扫描次数不随请求次数增长（只读缓存）', async () => {
  assertInjectionActive();
  const env = makeStatsEnv();
  try {
    await withHome(env.home, async () => {
      const { ctx, routes } = makeCtx();
      apply(ctx, { collectIntervals: { stats: 60 * 60 * 1000 } });
      const route = routes.get('/api/quota-usage/stats');
      assert.ok(route, '必须注册 /api/quota-usage/stats');

      // 预热：允许第一次（或前几次）建立缓存。
      await call(route, makeReq());
      // **等后台这一轮真正算完**再取样。
      //
      // 后台预计算是"逐桶串行"的：全机 → 工作区 → 每个会话各一次 scanSession。
      // 早先这里只 sleep 60ms，而会话桶还没算完，于是紧接着 5 次请求的窗口里
      // 会"撞进"后台余下的 scanSession 调用——那 2 次是**后台**在算，不是请求
      // 触发的，判据却把它算成"打开就扫"，成了假红。
      //
      // 判据要分辨的是"请求路径有没有扫描"，所以必须等后台静默：
      // 反复读计数直到两次取样之间不再增长（有上限，避免实现真的卡死时无限等）。
      let stable = readCounter();
      let quietTicks = 0;
      for (let i = 0; i < 60; i += 1) {
        await sleep(50);
        const now = readCounter();
        if (now.scan === stable.scan && now.scanSession === stable.scanSession) {
          quietTicks += 1;
          // 连续**两次**取样都没变才算真静默：第一次 GET 只是"叫醒"后台，
          // 计数在唤醒后的头几十毫秒里还是 0，只看一次会误判成已经算完。
          if (quietTicks >= 2) break;
        } else {
          quietTicks = 0;
        }
        stable = now;
      }

      const before = readCounter();
      const baseScan = before.scan;
      const baseSession = before.scanSession;

      for (let i = 0; i < 5; i += 1) {
        const res = await call(route, makeReq());
        assert.equal(res.status, 200, `第 ${i} 次请求应 200`);
      }
      const after = readCounter();
      const delta = (after.scan - baseScan) + (after.scanSession - baseSession);
      assert.equal(delta, 0,
        `连续 5 次请求期间扫描调用次数必须为 0（打开即读缓存），实际 ${delta} 次`
        + `（scan ${after.scan - baseScan}、scanSession ${after.scanSession - baseSession}）`);
    });
  } finally {
    env.cleanup();
  }
});

// ---- 判据 2：后台 tick 到点后缓存更新 --------------------------------

test('判据2：后台计算完成后 computedAt 前进，且数据反映新日志', async () => {
  assertInjectionActive();
  const env = makeStatsEnv();
  try {
    await withHome(env.home, async () => {
      const { ctx, routes } = makeCtx();
      // 间隔取允许的最小值，让"后台 tick"在测试可等待的范围内发生。
      apply(ctx, { collectIntervals: { stats: 60 * 1000 } });
      const route = routes.get('/api/quota-usage/stats');

      await call(route, makeReq());
      await sleep(80);
      const first = await call(route, makeReq());
      assert.equal(first.status, 200);
      const firstAt = first.body.computedAt;
      assert.equal(typeof firstAt, 'number', `预热后 computedAt 应为数字，实际 ${JSON.stringify(first.body.computedAt)}`);
      const firstTotals = totalTokensOf(first.body.kinds);
      assert.ok(firstTotals > 0, `预热后应有 token 汇总，实际 ${firstTotals}`);

      // 追加日志：多出一条 550 tokens 的事件。
      env.bumpLogs(1);
      // 等后台 tick（最小间隔 1 分钟太慢），改用手动刷新把缓存推进——
      // 判据2 只要求"缓存更新后 computedAt 前进、数据反映新日志"，不限定由谁触发。
      const refreshed = await call(route, makeReq('/api/quota-usage/stats', 'POST'));
      assert.equal(refreshed.status, 200, '强制重算应 200');
      const secondAt = refreshed.body.computedAt;
      assert.equal(typeof secondAt, 'number');
      assert.ok(secondAt >= firstAt, `computedAt 必须前进（或至少不回退），实际 ${firstAt} → ${secondAt}`);

      // **"反映新日志"用总量变大来判**，不用"某条字符串出现过"：
      // 日志被追加后总量必然增加；钉住具体数字（例如 550）会在夹具变化时误报，
      // 而且分不清"读到了新日志"与"恰好某个旧数字里含 550"。
      const secondTotals = totalTokensOf(refreshed.body.kinds);
      assert.ok(secondTotals > firstTotals,
        `重算后总量必须变大（反映新日志），实际 ${firstTotals} → ${secondTotals}`);
    });
  } finally {
    env.cleanup();
  }
});

// ---- 判据 3：间隔默认 10 分钟、下限 1 分钟 ---------------------------

test('判据3：统计间隔默认 10 分钟，且与采集同口径（复用同一夹取，不重复实现）', async () => {
  assertInjectionActive();
  const env = makeStatsEnv();
  try {
    await withHome(env.home, async () => {
      // 不传 stats 间隔：应取默认 10 分钟。
      const { ctx, routes } = makeCtx();
      apply(ctx, {});
      const route = routes.get('/api/quota-usage/stats');
      await call(route, makeReq());
      await sleep(60);
      const res = await call(route, makeReq());
      assert.equal(res.status, 200);
      assert.equal(res.body.intervalMs, 10 * 60 * 1000,
        `默认统计间隔应为 10 分钟（600000ms），实际 ${JSON.stringify(res.body.intervalMs)}`);
    });
  } finally {
    env.cleanup();
  }
});

test('判据3b：给一个过小的间隔要夹到下限 1 分钟（不是 0、不是原值）', async () => {
  assertInjectionActive();
  const env = makeStatsEnv();
  try {
    await withHome(env.home, async () => {
      const { ctx, routes } = makeCtx();
      apply(ctx, { collectIntervals: { stats: 1000 } });
      const route = routes.get('/api/quota-usage/stats');
      await call(route, makeReq());
      await sleep(60);
      const res = await call(route, makeReq());
      assert.equal(res.body.intervalMs, 60 * 1000,
        `低于下限的间隔应夹到 60000ms，实际 ${JSON.stringify(res.body.intervalMs)}`);
    });
  } finally {
    env.cleanup();
  }
});

test('判据3c：配置的间隔原样生效（不总是回落默认值）', async () => {
  assertInjectionActive();
  const env = makeStatsEnv();
  try {
    await withHome(env.home, async () => {
      const { ctx, routes } = makeCtx();
      apply(ctx, { collectIntervals: { stats: 5 * 60 * 1000 } });
      const route = routes.get('/api/quota-usage/stats');
      await call(route, makeReq());
      await sleep(60);
      const res = await call(route, makeReq());
      assert.equal(res.body.intervalMs, 5 * 60 * 1000,
        `应使用配置的 5 分钟，实际 ${JSON.stringify(res.body.intervalMs)}`);
    });
  } finally {
    env.cleanup();
  }
});

// ---- 判据 4：未预热如实报告状态，不冒充 0、不拿旧数据冒充当前 -------

test('判据4：未预热时给出 computing/未就绪状态，且不把空缓存报成 0 用量', async () => {
  assertInjectionActive();
  const env = makeStatsEnv();
  try {
    await withHome(env.home, async () => {
      const { ctx, routes } = makeCtx();
      apply(ctx, { collectIntervals: { stats: 60 * 60 * 1000 } });
      const route = routes.get('/api/quota-usage/stats');
      // **立刻**请求：此刻后台还没算完（首轮不给它 sleep 的机会）。
      const res = await call(route, makeReq());
      assert.equal(res.status, 200, '未预热也必须 200，不能 5xx');
      const body = res.body ?? {};
      // 未就绪必须是**可判别**的状态。
      const notReady = body.state === 'computing' || body.ready === false;
      assert.ok(notReady,
        `未预热时必须有明确的状态标记（state:'computing' 或 ready:false），实际 ${JSON.stringify(body).slice(0, 300)}`);
      // 不能把"还没算"报成"用量为 0"。
      assert.notEqual(body.messages, 0,
        `未预热时不得把空缓存报成 0 用量，实际 messages=${JSON.stringify(body.messages)}`);
      assert.equal(body.computedAt, null,
        `未预热时 computedAt 应为 null（从未算过），实际 ${JSON.stringify(body.computedAt)}`);
    });
  } finally {
    env.cleanup();
  }
});

test('判据4b：日志变了但还没重算时，必须标 stale，不得拿旧数据冒充当前', async () => {
  assertInjectionActive();
  const env = makeStatsEnv();
  try {
    await withHome(env.home, async () => {
      const { ctx, routes } = makeCtx();
      // 间隔拉到最长，确保"日志变了"之后不会自动重算。
      apply(ctx, { collectIntervals: { stats: 60 * 60 * 1000 } });
      const route = routes.get('/api/quota-usage/stats');
      await call(route, makeReq());
      await sleep(80);
      const warm = await call(route, makeReq());
      assert.equal(warm.body.stale === true, false,
        `刚算完不应标 stale，实际 ${JSON.stringify(warm.body.stale)}`);

      env.bumpLogs(1);
      const after = await call(route, makeReq());
      assert.equal(after.body.stale, true,
        `日志已变、缓存未重算时必须标 stale:true，实际 ${JSON.stringify(after.body.stale)}`
        + `（body: ${JSON.stringify(after.body).slice(0, 300)}）`);
    });
  } finally {
    env.cleanup();
  }
});

// ---- 判据 5：手动刷新可强制重算，但不是"打开即扫" ------------------

test('判据5：POST 强制重算一次，且只增加一次扫描（不是每请求都扫）', async () => {
  assertInjectionActive();
  const env = makeStatsEnv();
  try {
    await withHome(env.home, async () => {
      const { ctx, routes } = makeCtx();
      apply(ctx, { collectIntervals: { stats: 60 * 60 * 1000 } });
      const route = routes.get('/api/quota-usage/stats');
      await call(route, makeReq());
      await sleep(80);
      await call(route, makeReq());

      const before = readCounter();
      const baseScan = before.scan;
      const baseSession = before.scanSession;
      const forced = await call(route, makeReq('/api/quota-usage/stats', 'POST'));
      assert.equal(forced.status, 200, 'POST 强制重算必须 200');
      const after = readCounter();
      const delta = (after.scan - baseScan) + (after.scanSession - baseSession);
      assert.ok(delta >= 1, `强制重算必须真的扫一次，实际扫描 ${delta} 次`);
      // 再连开三次：不许继续扫。
      const midScan = readCounter().scan;
      const midSession = readCounter().scanSession;
      for (let i = 0; i < 3; i += 1) await call(route, makeReq());
      const end = readCounter();
      assert.equal((end.scan - midScan) + (end.scanSession - midSession), 0,
        '强制重算之后的普通打开仍必须只读缓存');
    });
  } finally {
    env.cleanup();
  }
});

// ---- 判据 6：会话内 / 工作区视图不得每请求全量重扫 -------------------

test('判据6：session=id 视图连续打开不重复扫描', async () => {
  assertInjectionActive();
  const env = makeStatsEnv();
  try {
    await withHome(env.home, async () => {
      const { ctx, routes } = makeCtx();
      apply(ctx, { collectIntervals: { stats: 60 * 60 * 1000 } });
      const route = routes.get('/api/quota-usage/stats');
      const url = `/api/quota-usage/stats?session=${env.ids[0]}`;
      await call(route, makeReq(url));
      await sleep(80);

      const before = readCounter();
      const base = before.scan + before.scanSession;
      for (let i = 0; i < 4; i += 1) {
        const res = await call(route, makeReq(url));
        assert.equal(res.status, 200);
      }
      const after = readCounter();
      assert.equal((after.scan + after.scanSession) - base, 0,
        `session 视图连续 4 次打开期间不得重扫，实际 ${(after.scan + after.scanSession) - base} 次`);
    });
  } finally {
    env.cleanup();
  }
});

test('判据6b：scope=workspace 视图连续打开不重复扫描', async () => {
  assertInjectionActive();
  const env = makeStatsEnv();
  try {
    await withHome(env.home, async () => {
      const { ctx, routes } = makeCtx();
      apply(ctx, { collectIntervals: { stats: 60 * 60 * 1000 } });
      const route = routes.get('/api/quota-usage/stats');
      const url = '/api/quota-usage/stats?scope=workspace';
      await call(route, makeReq(url));
      await sleep(80);

      const before = readCounter();
      const base = before.scan + before.scanSession;
      for (let i = 0; i < 4; i += 1) {
        const res = await call(route, makeReq(url));
        assert.equal(res.status, 200);
        assert.equal(res.body.scope, 'workspace');
      }
      const after = readCounter();
      assert.equal((after.scan + after.scanSession) - base, 0,
        `workspace 视图连续 4 次打开期间不得重扫（含逐会话 scanSession），`
        + `实际 ${(after.scan + after.scanSession) - base} 次`);
    });
  } finally {
    env.cleanup();
  }
});

// ---- 判据 7：现有口径不得被预计算改坏 -------------------------------

test('判据7：预计算后的响应仍带金额（每层 kinds 都有 cost），口径不变', async () => {
  assertInjectionActive();
  const env = makeStatsEnv();
  try {
    await withHome(env.home, async () => {
      const { ctx, routes } = makeCtx();
      apply(ctx, {});
      const route = routes.get('/api/quota-usage/stats');
      await call(route, makeReq());
      await sleep(80);
      const res = await call(route, makeReq());
      assert.equal(res.status, 200);
      const kinds = res.body.kinds ?? [];
      assert.ok(kinds.length > 0, `应有三类之一的汇总，实际 ${JSON.stringify(res.body).slice(0, 300)}`);
      // 金额必须仍在：预计算不能把"补金额"那一步省掉。
      for (const kind of kinds) {
        assert.ok('cost' in kind,
          `每个计费类型块都应带 cost（金额），实际缺 cost：${JSON.stringify(kind).slice(0, 200)}`);
        if (kind.cost !== null && typeof kind.cost === 'object' && kind.cost.currency !== 'credit') {
          assert.ok(kind.cost.currency === 'unknown' || kind.cost.amounts !== undefined,
            `有钱可算的类型应给 amounts，实际 ${JSON.stringify(kind.cost)}`);
        }
      }
    });
  } finally {
    env.cleanup();
  }
});

// ---- 判据 8：只勾「会话」也必须有数据 ---------------------------------
//
// 用户报的真 bug：统计里只看「会话」时永远空白。
//
// 根因不在扫描，而在**枚举**：`statsCache` 需要宿主告诉它"这台机器上有哪些会话"，
// 宿主的实现是 async 的（要遍历会话目录）。缓存侧早期写的是同步调用
// `sessionEnumerator()` 再 `Array.isArray(...)`，拿到的是 Promise → 判成"不是数组"
// → 返回 `[]`。于是 `refresh()` 只算全机与工作区，**一个会话桶都不建**：
//
//   · 全机视图正常（有 13700 条消息）；
//   · 单独勾会话 → 该桶从没算过 → 永远 `state: 'computing'`。
//
// 这条判据必须**只用会话视图**（不带 scope、不带全机），否则全机桶的存在会掩盖它。
// 修复前这里必然是 red。
test('判据8：单独请求某个会话（宿主枚举器是 async）时必须有数据，不得永远 computing', async () => {
  assertInjectionActive();
  const env = makeStatsEnv();
  try {
    await withHome(env.home, async () => {
      const { ctx, routes } = makeCtx();
      apply(ctx, { collectIntervals: { stats: 60 * 60 * 1000 } });
      const route = routes.get('/api/quota-usage/stats');
      // 先给后台一轮预计算的时间：它必须把**每个已知会话**都建好桶。
      await call(route, makeReq());
      await sleep(150);
      // 让后台这一轮彻底跑完（refresh 是逐桶串行 await 的）。
      await sleep(150);

      const res = await call(route, makeReq(`/api/quota-usage/stats?session=${encodeURIComponent(env.ids[0])}`));
      assert.equal(res.status, 200, '会话视图必须 200');
      const body = res.body ?? {};
      assert.equal(body.state, 'ready',
        `单独打开会话时该会话必须已预计算（state:'ready'），实际 ${JSON.stringify(body.state)}`
        + `——枚举器若被判成非数组，会话桶根本不会建`);
      assert.notEqual(body.computedAt, null,
        `已预计算就必须有 computedAt，实际 ${JSON.stringify(body.computedAt)}`);
      // 会话里确实有属于它的用量：不能是"ready 但空"。
      const kinds = Array.isArray(body.kinds) ? body.kinds : [];
      assert.ok(kinds.length > 0,
        `该会话应有三类之一的汇总，实际 ${JSON.stringify(body).slice(0, 300)}`);
      const total = Number(body.messages ?? 0);
      assert.ok(total > 0, `该会话应统计到消息，实际 messages=${JSON.stringify(body.messages)}`);
    });
  } finally {
    env.cleanup();
  }
});
