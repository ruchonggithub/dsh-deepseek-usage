// 免费渠道积分余量的真实查询：内核 channel-pack RPC + 百分比算术。
//
// 这一组钉住四件事：
//   1. 环境不满足（无 connection / 无 handler / 无 peer）时 available:false 且不抛，
//      call 抛错而不是返回假数据；
//   2. 走的是内核的 client-request 信封 + shared fetch handler（线路形状必须对，
//      否则真实宿主里就是 401）；
//   3. 分母那套规则：失效包不进分母、聚合包用 balance.total + aggregate.used、
//      形状不认识时不出百分比（绝不 100%）；
//   4. 单渠道失败/超时只变成它自己的 error 行，不牵连其它渠道。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANNEL_CATALOGUE,
  CHANNEL_PACK_METHOD,
  CHANNEL_PACK_PATH,
  DEFAULT_TIMEOUT_MS,
  listCreditChannels,
  makeChannelCreditsRpc,
  normalizeChannelCredits,
  probeChannelCredits,
} from '../lib/channel-credits.js';

// ─────────────────────────── 造宿主假件 ───────────────────────────

/**
 * 造一个 connection 服务假件。
 *
 * `respond` 收到 (request, peer)，返回 Response。默认回一个 `{ok:true,value:{}}`，
 * 让测试只关心自己那一段。
 */
function makeConnection({ respond, peer = { principal: { kind: 'owner' } }, omitPeer = false, noHandler = false } = {}) {
  const calls = [];
  const connection = {
    createSharedFetchHandler(pathname) {
      calls.push({ pathname });
      if (noHandler) return undefined;
      return {
        async fetch(request, gotPeer) {
          calls.push({ request, peer: gotPeer });
          if (respond !== undefined) return respond(request, gotPeer);
          return jsonResponse({ result: { ok: true, value: {} } });
        },
      };
    },
  };
  if (!omitPeer) connection.browserPeer = peer;
  return { connection, calls, peer };
}

/** 造一个 ctx：`ctx.get('connection')` 返回给定服务。 */
function makeCtx(connection) {
  return {
    get(name) {
      if (name === 'connection') return connection;
      return undefined;
    },
  };
}

/** JSON 响应。 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 一个直接给固定 `value` 的 rpc 假件（用于纯 normalize / probe 测试）。 */
function stubRpc(build) {
  const seen = [];
  return {
    seen,
    available: true,
    async call(method, payload, signal) {
      seen.push({ method, payload, signal });
      return build(method, payload, signal);
    },
  };
}

// ─────────────────────── 1. 环境不满足：不抛、available:false ───────────────────────

test('无 ctx / 无 connection 服务：available:false 且 call 明确报错', async () => {
  for (const ctx of [undefined, null, {}, { get: () => undefined }, { get: () => { throw new Error('未注册'); } }]) {
    const rpc = makeChannelCreditsRpc(ctx);
    assert.equal(rpc.available, false);
    assert.equal(typeof rpc.reason, 'string');
    await assert.rejects(() => rpc.call('credits.balances', { provider: 'trae' }), /connection|未提供/);
  }
});

test('有 connection 但没有可用的 shared fetch handler：available:false，不抛', async () => {
  for (const connection of [
    {}, // 连方法都没有
    { createSharedFetchHandler: () => undefined },
    { createSharedFetchHandler: () => ({}) }, // 有 handler 没 fetch
    { createSharedFetchHandler: () => { throw new Error('没挂载'); } },
  ]) {
    const rpc = makeChannelCreditsRpc(makeCtx(connection));
    assert.equal(rpc.available, false);
    assert.match(rpc.reason, /fetch handler|抛错/);
    await assert.rejects(() => rpc.call('credits.balances', {}));
  }
});

test('有 handler 但没有 owner peer：available:false，不抛', async () => {
  for (const connection of [
    { createSharedFetchHandler: () => ({ fetch: async () => jsonResponse({}) }) },
    { createSharedFetchHandler: () => ({ fetch: async () => jsonResponse({}) }), browserPeer: null, operator: null },
  ]) {
    const rpc = makeChannelCreditsRpc(makeCtx(connection));
    assert.equal(rpc.available, false);
    assert.match(rpc.reason, /owner peer/);
    await assert.rejects(() => rpc.call('credits.balances', {}));
  }
});

test('connection 是惰性解析的：后挂载的服务能被立刻看到', async () => {
  let connection;
  const ctx = { get: (name) => (name === 'connection' ? connection : undefined) };
  const rpc = makeChannelCreditsRpc(ctx);
  assert.equal(rpc.available, false);

  // 模拟内核在插件 apply 之后才把 connection 交出来。
  connection = makeConnection().connection;
  assert.equal(rpc.available, true);
  const value = await rpc.call('providers.status', { providers: [] });
  assert.deepEqual(value, {});
});

test('DSH 0.2.0 的 operator 字段同样被认作 owner peer', async () => {
  const operator = { name: 'operator' };
  const { connection, calls } = makeConnection({ omitPeer: true });
  connection.operator = operator;
  const rpc = makeChannelCreditsRpc(makeCtx(connection));
  assert.equal(rpc.available, true);
  await rpc.call('credits.balances', { provider: 'trae' });
  const fetchCall = calls.find((entry) => entry.request !== undefined);
  assert.equal(fetchCall.peer, operator);
});

// ─────────────────────── 2. 线路形状：client-request 信封 ───────────────────────

test('call 发出内核信封：路径、方法、rpcId、channel-pack 双层 payload、peer', async () => {
  const { connection, calls, peer } = makeConnection({ respond: () => jsonResponse({ result: { ok: true, value: { accounts: [] } } }) });
  const rpc = makeChannelCreditsRpc(makeCtx(connection));

  const value = await rpc.call('credits.balances', { provider: 'codearts' });
  assert.deepEqual(value, { accounts: [] });

  // createSharedFetchHandler 必须按 '/api' 挂，路径才是 /api/channel-pack。
  assert.equal(calls[0].pathname, '/api');

  const { request, peer: gotPeer } = calls.find((entry) => entry.request !== undefined);
  assert.equal(gotPeer, peer);
  assert.equal(request.url, `http://127.0.0.1${CHANNEL_PACK_PATH}`);
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.get('content-type'), 'application/json');

  const envelope = JSON.parse(await request.text());
  assert.equal(envelope.type, 'client-request');
  assert.equal(envelope.method, CHANNEL_PACK_METHOD);
  assert.equal(envelope.method, 'channel-pack');
  assert.match(envelope.rpcId, /^dsh-usage-[0-9a-z]+-[0-9a-z]+$/);
  assert.deepEqual(envelope.payload, { method: 'credits.balances', payload: { provider: 'codearts' } });
});

test('信封可以被剥一层也可以被剥两层（不同内核版本套法不同）', async () => {
  // 只有 { ok, value }：call 直接给 value。
  const flat = makeChannelCreditsRpc(makeCtx(makeConnection({ respond: () => jsonResponse({ ok: true, value: { accounts: [] } }) }).connection));
  assert.deepEqual(await flat.call('credits.balances', { provider: 'trae' }), { accounts: [] });

  // value 缺失时原样返回，让 normalize 自己判空（不丢 data）。
  const bare = makeChannelCreditsRpc(makeCtx(makeConnection({ respond: () => jsonResponse({ result: { statuses: {} } }) }).connection));
  assert.deepEqual(await bare.call('provider.status', { providers: [] }), { statuses: {} });
});

test('HTTP 401/403、非 JSON、ok:false 各自抛出可读错误', async () => {
  const cases = [
    { respond: () => new Response('', { status: 403 }), pattern: /403/ },
    { respond: () => new Response('', { status: 401 }), pattern: /401/ },
    { respond: () => new Response('<html>oops</html>', { status: 200 }), pattern: /非 JSON/ },
    { respond: () => jsonResponse({ result: { ok: false, error: { code: 'NO_ACCOUNT' } } }), pattern: /NO_ACCOUNT/ },
    { respond: () => jsonResponse({ result: { ok: false, error: { message: '上游超时' } } }), pattern: /上游超时/ },
    { respond: () => null, pattern: /非响应对象/ },
    { respond: () => ({ status: 200 }), pattern: /没有可读响应体/ },
  ];
  for (const { respond, pattern } of cases) {
    const rpc = makeChannelCreditsRpc(makeCtx(makeConnection({ respond }).connection));
    await assert.rejects(() => rpc.call('credits.balances', { provider: 'gemini' }), pattern);
  }
});

// ─────────────────────── 3. 分母规则 ───────────────────────

test('codearts 实测：聚合包路径 → 分母 7500，剩余 7150.69，95.3%', () => {
  const raw = {
    accounts: [
      {
        accountId: 'a1',
        nickname: '主号',
        balance: {
          total: 7150.69,
          packages: [
            // 聚合包：remaining 与 balance.total 相等 → 分母 = 7150.69 + 349.31
            { name: '总积分包', total: 7500, used: 349.31, remaining: 7150.69, active: true, unit: 'credits' },
            // 子包：remaining/used 与聚合包重叠，不能被重复计入分子或分母
            { name: '基础积分包', total: 7000, used: 349.31, remaining: 6650.69, active: true, unit: 'credits' },
            { name: '赠送积分包', total: 500, used: 349.31, remaining: 500, active: true, unit: 'credits' },
          ],
        },
      },
    ],
  };

  const row = normalizeChannelCredits('codearts', raw, 1_800_000_000_000);
  assert.equal(row.state, 'ok');
  assert.equal(row.channel, 'codearts');
  assert.deepEqual(row.nicknames, ['主号']);
  assert.equal(row.remaining, 7150.69);
  assert.equal(row.total, 7500);
  assert.equal(row.percent, 95.3);
  assert.equal(row.unit, 'credits');
  assert.equal(row.packageCount, 3);
  assert.equal(row.observedAt, 1_800_000_000_000);
  assert.equal(row.error, undefined);

  // 反例守护：把所有包的 used 加起来会得到 7849.31，把 95.3% 算成 91.1%。
  const wrongDenominator = 7500 + (349.31 + 349.31 + 349.31);
  assert.notEqual(row.total, Number(wrongDenominator.toFixed(4)));
});

test('失效包不进分母：buddy 的 4 个已花完裂变包不能把 85.8% 稀释成 78.9%', () => {
  const expired = [0, 1, 2, 3].map((index) => ({
    name: `裂变包${index}`,
    total: 100,
    used: 100,
    remaining: 0,
    active: false,
    unit: 'credits',
  }));
  const raw = {
    accounts: [
      {
        nickname: 'buddy-a',
        balance: {
          total: 3896.29,
          packages: [
            { name: '基础包', total: 4000, used: 600, remaining: 3400, active: true, unit: 'credits' },
            { name: '赠送包', total: 539, used: 42.71, remaining: 496.29, active: true, unit: 'credits' },
            ...expired,
          ],
        },
      },
    ],
  };

  const row = normalizeChannelCredits('buddy', raw, Date.now());
  assert.equal(row.state, 'ok');
  assert.equal(row.remaining, 3896.29);
  // 分母 = max(Σtotal 4539, balance.total + Σused 4539)，失效包一分都不加。
  assert.equal(row.total, 4539);
  assert.equal(row.percent, 85.8);
  // 明细仍全量可见：失效包不参与算术，但必须能被用户看到。
  assert.equal(row.packageCount, 6);
  assert.equal(row.packages.filter((pkg) => pkg.active === false).length, 4);
});

test('active 缺省视为在用，只有显式 active:false 才排除', () => {
  const raw = {
    accounts: [
      {
        nickname: 'x',
        balance: {
          total: 90,
          packages: [
            { total: 100, used: 10, remaining: 90, unit: 'credits' }, // active 缺失
            { total: 50, used: 50, remaining: 0, active: false, unit: 'credits' },
          ],
        },
      },
    ],
  };
  const row = normalizeChannelCredits('trae', raw, Date.now());
  // 聚合包 = remaining 90 的那个（active 缺省不算失效）→ 100。
  assert.equal(row.total, 100);
  assert.equal(row.percent, 90);
});

test('无聚合包但两次读数一致：走 max(Σtotal, balance.total + Σused)', () => {
  const raw = {
    accounts: [
      {
        nickname: 'trae-a',
        balance: {
          total: 300,
          packages: [
            { total: 200, used: 50, remaining: 150, unit: 'credits' },
            { total: 150, used: 0, remaining: 150, unit: 'credits' },
          ],
        },
      },
    ],
  };
  const row = normalizeChannelCredits('trae', raw, Date.now());
  // Σremaining 300 == balance.total 300 → 分母 max(350, 350) = 350。
  assert.equal(row.total, 350);
  assert.equal(row.remaining, 300);
  assert.equal(row.percent, 85.7);
});

test('形状不认识：percent 为 undefined，绝不凑出 100%', () => {
  const cases = [
    // 完全没有 packages：只有 balance.total，没有分母。
    { accounts: [{ nickname: 'a', balance: { total: 12 } }] },
    // Σremaining 与 balance.total 差得远，且没有聚合包 —— 谁都不是分母。
    { accounts: [{ nickname: 'a', balance: { total: 500, packages: [{ total: 1000, used: 10, remaining: 990, unit: 'credits' }] } }] },
    // 包上一个数字都没有。
    { accounts: [{ nickname: 'a', balance: { total: 500, packages: [{ unit: 'credits' }] } }] },
    // 空载荷。
    { accounts: [{ nickname: 'a', balance: {} }] },
  ];
  for (const raw of cases) {
    const row = normalizeChannelCredits('loomy', raw, Date.now());
    assert.equal(row.percent, undefined, JSON.stringify(raw));
    assert.equal(row.total, undefined, JSON.stringify(raw));
    assert.notEqual(row.percent, 100);
  }
});

test('只有包没有 balance.total：用 Σtotal 做分母', () => {
  const raw = {
    accounts: [
      {
        nickname: 'a',
        balance: { packages: [{ total: 200, used: 50, remaining: 150, unit: 'credits' }] },
      },
    ],
  };
  const row = normalizeChannelCredits('cline', raw, Date.now());
  assert.equal(row.remaining, 150);
  assert.equal(row.total, 200);
  assert.equal(row.percent, 75);
});

test('多账号：balance:null 的失败账号不与有数字的账号互相抹掉', () => {
  const raw = {
    accounts: [
      { accountId: 'a1', nickname: '读不到', balance: null, error: '上游 502' },
      {
        accountId: 'a2',
        nickname: '正常号',
        balance: { total: 50, packages: [{ total: 100, used: 50, remaining: 50, active: true, unit: 'credits' }] },
      },
      { accountId: 'a3', nickname: '也读不到' }, // balance 缺失，同样算失败
    ],
  };

  const row = normalizeChannelCredits('gemini', raw, Date.now());
  assert.equal(row.state, 'ok');
  // 有数字的账号照常出数。
  assert.equal(row.remaining, 50);
  assert.equal(row.total, 100);
  assert.equal(row.percent, 50);
  // 两个失败账号各留一条原因，昵称去重保留。
  assert.match(row.error, /上游 502/);
  assert.match(row.error, /余额不可用/);
  assert.deepEqual(row.nicknames, ['读不到', '正常号', '也读不到']);
});

test('全渠道都读不到：state:error，不冒充 empty 也不冒充 0', () => {
  const row = normalizeChannelCredits('gemini', { accounts: [{ nickname: 'g', balance: null, error: '未登录' }] }, Date.now());
  assert.equal(row.state, 'error');
  assert.equal(row.remaining, undefined);
  assert.equal(row.percent, undefined);
  assert.equal(row.error, '未登录');
  assert.deepEqual(row.nicknames, ['g']);
  assert.equal(row.observedAt, undefined);
});

test('没有账号：state:empty，带 note，不是错误', () => {
  for (const raw of [{ accounts: [] }, {}, null, undefined, 'nonsense']) {
    const row = normalizeChannelCredits('zcode', raw, Date.now());
    assert.equal(row.state, 'empty');
    assert.deepEqual(row.nicknames, []);
    assert.equal(row.remaining, undefined);
    assert.equal(row.error, undefined);
    assert.equal(typeof row.note, 'string');
  }
});

test('账号在但一个数字都没读到：也是 empty 并给出说明，绝不当 0', () => {
  // balance 存在却没有 total/packages：不是失败（没有 error 可记），只是没有数。
  const row = normalizeChannelCredits('zcode', { accounts: [{ nickname: 'a', balance: {} }] }, Date.now());
  assert.equal(row.state, 'empty');
  assert.equal(row.remaining, undefined);
  assert.equal(row.percent, undefined);
  assert.match(row.note, /未返回任何余额/);

  // 对照：balance 整个缺失才算账号级失败 —— 这两种状态必须分开。
  const missing = normalizeChannelCredits('zcode', { accounts: [{ nickname: 'a' }] }, Date.now());
  assert.equal(missing.state, 'error');
  assert.equal(missing.error, '余额不可用');
});

test('多账号的数字相加（各账号各自成账）', () => {
  const raw = {
    accounts: [
      { nickname: 'a', balance: { total: 40, packages: [{ total: 100, used: 60, remaining: 40, unit: 'credits' }] } },
      { nickname: 'b', balance: { total: 60, packages: [{ total: 100, used: 40, remaining: 60, unit: 'credits' }] } },
    ],
  };
  const row = normalizeChannelCredits('qoder', raw, Date.now());
  assert.equal(row.remaining, 100);
  assert.equal(row.total, 200);
  assert.equal(row.percent, 50);
});

// ─────────────────────── 4. 单位折叠 ───────────────────────

test('单位：单复数折叠成一个写法，真不同才用斜杠连接', () => {
  const singular = normalizeChannelCredits('workbuddy', {
    accounts: [{ nickname: 'a', balance: { total: 3, packages: [
      { total: 2, used: 1, remaining: 1, active: true, unit: 'credit' },
      { total: 2, used: 0, remaining: 2, active: true, unit: 'credits' },
    ] } }],
  }, Date.now());
  assert.equal(singular.unit, 'credits');

  const mixed = normalizeChannelCredits('workbuddy', {
    accounts: [{ nickname: 'a', balance: { total: 3, packages: [
      { total: 2, used: 1, remaining: 1, active: true, unit: 'credit' },
      { total: 2, used: 0, remaining: 2, active: true, unit: 'token' },
    ] } }],
  }, Date.now());
  assert.equal(mixed.unit, 'credit/token');

  const none = normalizeChannelCredits('workbuddy', {
    accounts: [{ nickname: 'a', balance: { total: 3 } }],
  }, Date.now());
  assert.equal(none.unit, undefined);
});

// ─────────────────────── 5. 渠道发现 ───────────────────────

test('listCreditChannels：只保留 accounts.total > 0 的渠道', async () => {
  const rpc = stubRpc(() => ({
    statuses: {
      codearts: { accounts: { total: 2 }, models: { total: 9 } },
      buddy: { accounts: { total: 0 } },
      trae: { accounts: { total: 1 } },
      cline: {}, // 没给 accounts
      gemini: { accounts: { total: 3 } },
    },
  }));

  const channels = await listCreditChannels(rpc, ['codearts', 'buddy', 'trae', 'cline', 'gemini']);
  assert.deepEqual(channels, ['codearts', 'trae', 'gemini']);
  // 一次批量问完，不是逐家问。
  assert.equal(rpc.seen.length, 1);
  assert.equal(rpc.seen[0].method, 'provider.status');
  assert.deepEqual(rpc.seen[0].payload.providers, ['codearts', 'buddy', 'trae', 'cline', 'gemini']);
});

test('listCreditChannels：call 已剥信封或仍是 { value: { statuses } } 都认', async () => {
  const wrapped = stubRpc(() => ({ value: { statuses: { trae: { accounts: { total: 1 } } } } }));
  assert.deepEqual(await listCreditChannels(wrapped, ['trae']), ['trae']);
});

test('listCreditChannels：枚举失败 / 没账号时兜底返回目录，不返回空数组', async () => {
  const failing = { available: true, async call() { throw new Error('boom'); } };
  assert.deepEqual(await listCreditChannels(failing, ['trae', 'buddy']), ['trae', 'buddy']);

  const allZero = stubRpc(() => ({ statuses: { trae: { accounts: { total: 0 } }, buddy: { accounts: { total: 0 } } } }));
  assert.deepEqual(await listCreditChannels(allZero, ['trae', 'buddy']), ['trae', 'buddy']);

  const noRpc = undefined;
  assert.deepEqual(await listCreditChannels(noRpc, ['trae']), ['trae']);

  // 不给 catalogue 时用内置目录。
  assert.equal((await listCreditChannels(noRpc)).length, CHANNEL_CATALOGUE.length);
});

// ─────────────────────── 6. 逐渠道探测 ───────────────────────

test('probeChannelCredits：一个渠道失败只变成它自己的 error 行', async () => {
  const rpc = stubRpc((method, payload) => {
    if (payload.provider === 'gemini') throw new Error('上游 502');
    if (payload.provider === 'codearts') {
      return { accounts: [{ nickname: 'a', balance: { total: 7150.69, packages: [
        { total: 7500, used: 349.31, remaining: 7150.69, active: true, unit: 'credits' },
      ] } }] };
    }
    return { accounts: [] };
  });

  const rows = await probeChannelCredits(rpc, ['codearts', 'gemini', 'trae'], 5_000);
  assert.deepEqual(rows.map((row) => row.channel), ['codearts', 'gemini', 'trae']);
  assert.equal(rows[0].state, 'ok');
  assert.equal(rows[0].percent, 95.3);
  assert.equal(rows[1].state, 'error');
  assert.match(rows[1].error, /502/);
  assert.deepEqual(rows[1].packages, []);
  assert.equal(rows[2].state, 'empty');
  // 每个渠道都各自带一个 AbortSignal。
  assert.ok(rpc.seen.every((entry) => entry.signal instanceof AbortSignal));
  assert.equal(rpc.seen.length, 3);
});

test('probeChannelCredits：超时被翻译成可读文案，不是 AbortError', async () => {
  const rpc = {
    available: true,
    call(method, payload, signal) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      });
    },
  };
  const rows = await probeChannelCredits(rpc, ['gemini'], 20);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'error');
  assert.match(rows[0].error, /查询超时（20ms）/);
});

test('probeChannelCredits：rpc 缺失时给 error 行而不是崩', async () => {
  for (const rpc of [undefined, null, {}]) {
    const rows = await probeChannelCredits(rpc, ['trae', 'buddy']);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.state === 'error'));
    assert.ok(rows.every((row) => /connection/.test(row.error)));
  }
  assert.deepEqual(await probeChannelCredits(undefined, []), []);
});

test('probeChannelCredits：从真实 connection 一路拿到数字（端到端）', async () => {
  const { connection } = makeConnection({
    respond: (request) => {
      // 从信封里读渠道名，回该渠道的余额 —— 模拟官方 handler。
      return request.json().then((envelope) => {
        const channel = envelope.payload.payload.provider;
        return jsonResponse({
          result: {
            ok: true,
            value: {
              accounts: [{ nickname: `${channel}-1`, balance: { total: 45, packages: [
                { total: 50, used: 5, remaining: 45, active: true, unit: 'credits' },
              ] } }],
            },
          },
        });
      });
    },
  });

  const rpc = makeChannelCreditsRpc(makeCtx(connection));
  const rows = await probeChannelCredits(rpc, ['codearts', 'buddy']);
  assert.deepEqual(rows.map((row) => row.state), ['ok', 'ok']);
  assert.deepEqual(rows.map((row) => row.percent), [90, 90]);
  assert.deepEqual(rows.map((row) => row.nicknames), [['codearts-1'], ['buddy-1']]);
});

test('DEFAULT_TIMEOUT_MS 覆盖冷启动（实测冷路径约 10.5s）', () => {
  assert.ok(DEFAULT_TIMEOUT_MS > 10_500);
});
