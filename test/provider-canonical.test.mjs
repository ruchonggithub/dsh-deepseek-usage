// 服务端 canonical 化与"三方订阅路由从快照取数"的回归用例。
//
// 这一组只走 `/api/quota-usage` 的 HTTP 面，不碰渲染。判据钉的是**代码路径**：
// 从第三方插件的 `/status` 响应一路走到本插件 `/api/quota-usage` 的 `usage` 字段，
// 中间没有一步是构造出来的中间态——采集、归一、匹配都用真实实现。
//
// 真机背景（lead 的 GET + 本机实测）：
//   · `agent-default-model` 配的是 `provider: codex-chatgpt`（第三方插件注册的路由）；
//   · 本插件能力表按 `openai-codex` 索引，没有 `codex-chatgpt`，于是判成
//     `kind: 'none'` + 「当前插件不支持 codex-chatgpt」；
//   · 而额度其实早就采到了：第三方插件 `/status` 的
//     `value.accounts[].quota.windows`，本插件 `collectSubscription` 一直把它归一进
//     快照（`provider: 'openai-codex'`，带 accounts 数组）。
// 所以修复必须让这条路由**从快照取数**，而不是只把 kind 改成 oauth——后者会让
// 卡片变成"尚未填写 OAuth 令牌"，用户照样看不到额度。
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

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

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-credentials') {
      return { url: 'data:text/javascript,' + encodeURIComponent(CREDENTIALS_STUB), shortCircuit: true };
    }
    if (specifier === '@deepseek-ai/schemastery') {
      return { url: 'data:text/javascript,' + encodeURIComponent(SCHEMASTERY_STUB), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { apply } = await import('../lib/index.js');
const { canonicalProviderId, accountCapabilityOf, oauthProviderOf } = await import('../lib/accounts.js');

// ---- 纯函数层：canonical 化 ------------------------------------------------

test('canonicalProviderId：codex-chatgpt 与 chatgpt-codex 都归一到 openai-codex', () => {
  // 两个字符串的词序相反，是**两个不同的 id**，第三方插件用的是前者。
  // 只加一个会让另一个继续被判成"不支持"。
  assert.equal(canonicalProviderId('codex-chatgpt'), 'openai-codex');
  assert.equal(canonicalProviderId('chatgpt-codex'), 'openai-codex');
  assert.equal(canonicalProviderId('openai-codex'), 'openai-codex');
  // 大小写与首尾空白容错（日志里的 id 常带这两种噪声）。
  assert.equal(canonicalProviderId('  Codex-ChatGPT '), 'openai-codex');
});

test('canonicalProviderId：认不出的 id 原样返回，不猜', () => {
  assert.equal(canonicalProviderId('some-unknown-gateway'), 'some-unknown-gateway');
  assert.equal(canonicalProviderId(''), '');
  assert.equal(canonicalProviderId(null), null);
  assert.equal(canonicalProviderId(undefined), undefined);
});

test('归一之后 codex-chatgpt 走的是 Codex 订阅能力（kind=oauth，端点不变）', () => {
  const entry = accountCapabilityOf('codex-chatgpt');
  assert.notEqual(entry, null);
  assert.equal(entry.id, 'openai-codex');
  assert.equal(entry.kind, 'oauth');
  // 上游端点与直连 openai-codex 完全一致：同一份订阅、同一个接口。
  const spec = oauthProviderOf('codex-chatgpt');
  assert.equal(spec.usage.host, 'https://chatgpt.com');
  assert.equal(spec.usage.path, '/backend-api/wham/usage');
  assert.equal(spec.tokenRef, 'DSH_USAGE_CODEX_OAUTH_TOKEN');
});

// ---- 路由层：真实链路 ------------------------------------------------------

/** 第三方插件 `/status` 响应的真实形状（字段名取自本机实测，值已替换）。 */
function chatgptStatusBody({ activeId, accounts }) {
  return {
    ok: true,
    value: {
      authenticated: true,
      // 聚合桶：活跃账号的那一份。窗口字段与账号级一致（usedPercent / windowDurationMins）。
      quota: {
        state: 'ok',
        buckets: [{
          id: 'codex',
          name: 'Codex',
          planType: 'plus',
          windows: [
            { usedPercent: 10, windowDurationMins: 300, resetsAt: 1894777849 },
            { usedPercent: 17, windowDurationMins: 10080, resetsAt: 1894921285 },
          ],
        }],
        fetchedAt: 1894905905,
      },
      accounts,
      activeAccountId: activeId,
    },
  };
}

/** 一个账号的真实形状。`usedPercent` 是**已用**百分比。 */
function accountRow({ id, alias, fiveHour, sevenDay, plan = 'plus' }) {
  return {
    id,
    alias,
    email: alias,
    planLabel: plan,
    isPrimary: id === 'acc-primary',
    quota: {
      state: 'ok',
      windows: [
        { usedPercent: fiveHour, windowDurationMins: 300, resetsAt: 1894777849 },
        { usedPercent: sevenDay, windowDurationMins: 10080, resetsAt: 1894921285 },
      ],
    },
  };
}

let fetchMode = 'status-only';
let upstreamCalls = [];

/**
 * 上游桩：只认第三方插件那条 `/status` 路由。
 *
 * 本插件**不会**去打 `chatgpt.com`（它没有那个令牌），所以其它 URL 一律 404 ——
 * 如果实现偷偷打了别的地方，用例会因为拿不到数据而失败，而不是静默通过。
 */
const dispatchFetch = async (url) => {
  const target = String(url);
  upstreamCalls.push(target);
  if (target.includes('/api/dsh-chatgpt-subscription/status')) {
    if (fetchMode === 'status-fail') return new Response('{}', { status: 500 });
    return new Response(JSON.stringify(chatgptStatusBody({
      activeId: 'acc-active',
      accounts: [
        // 数组里第一个账号是**几乎耗尽**的那个：5h 已用 0%、7d 已用 100%。
        accountRow({ id: 'acc-spare', alias: 'spare@example.com', fiveHour: 0, sevenDay: 100 }),
        // activeAccountId 指的是这个：5h 已用 10%、7d 已用 17%（真机实测值）。
        accountRow({ id: 'acc-active', alias: 'active@example.com', fiveHour: 10, sevenDay: 17 }),
      ],
    })), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 404 });
};

globalThis.fetch = dispatchFetch;
test.after(() => { globalThis.fetch = dispatchFetch; });

function resetUpstream(mode = 'status-only') {
  fetchMode = mode;
  upstreamCalls = [];
  globalThis.fetch = dispatchFetch;
}

/** 最小 ctx：带 webServer.port，否则 pluginOrigin() 取不到 origin、采集会短路。 */
let seq = 0;
function makeCtx(options = {}) {
  const routes = new Map();
  seq += 1;
  const key = options.key === undefined ? `sk-test-${seq}` : options.key;
  const ctx = {
    logger: { warn() {} },
    credentials: {
      resolve: async (ref) => {
        const name = ref && typeof ref === 'object' && 'name' in ref ? ref.name : String(ref);
        const value = options.refs ? options.refs[name] : (name === 'DEEPSEEK_API_KEY' ? key : undefined);
        return value === undefined || value === null ? undefined : { value };
      },
      readRecord: async () => undefined,
      set: async () => {},
      unset: async () => {},
    },
    get(name) {
      if (name === 'agentDefaultModel') {
        return {
          currentSelection: () => ({
            provider: options.provider ?? 'deepseek-official',
            model: options.model ?? 'deepseek-flash',
          }),
        };
      }
      if (name === 'llm') {
        return {
          listProviders: () => (options.registered ?? []),
          listConfigurableProviders: () => [],
        };
      }
      return undefined;
    },
    effect(fn) { fn(); return () => {}; },
    webServer: {
      host: '127.0.0.1',
      // pluginOrigin() 优先 getOrigin()，没有才用 port。这里给 port：与宿主一致，
      // 也顺带覆盖"只靠 port 拼 origin"那条分支。
      port: 59770,
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  };
  return { ctx, routes };
}

function makeReq(headers = {}, url = '/api/quota-usage?lang=zh', method = 'GET') {
  const text = '';
  return {
    headers, url, method,
    text: async () => text,
    on() { return undefined; },
    [Symbol.asyncIterator]: async function* iterator() {},
  };
}

function makePost(url, payload) {
  const body = JSON.stringify(payload);
  const response = new Response(body, { headers: { 'content-type': 'application/json' } });
  return {
    method: 'POST',
    url,
    headers: {
      host: '127.0.0.1:59770',
      'content-type': 'application/json',
      get: (name) => response.headers.get(name),
    },
    text: async () => body,
  };
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

/**
 * 采一轮订阅，然后读 `/api/quota-usage`。
 *
 * 两步是必须分开走的：采集只写缓存，读路由只读缓存（这是本插件的核心契约，
 * 见 lib/collector.js）。中途插一步"手工塞快照"就会绕开真实链路，
 * 那正是这一组要避免的假绿。
 */
async function collectThenRead(options) {
  const { ctx, routes } = makeCtx(options);
  apply(ctx);
  const collected = await call(
    routes.get('/api/quota-usage/collect'),
    makePost('/api/quota-usage/collect', { kind: 'subscription' }),
  );
  assert.equal(collected.status, 200, `订阅采集应成功，实际 ${JSON.stringify(collected.body)}`);
  const res = await call(routes.get('/api/quota-usage'), makeReq({ host: '127.0.0.1:59770' }));
  return { res, collected, ctx, routes };
}

test('真实链路：codex-chatgpt 的 usage 必须带上快照里的窗口（不只是 kind 变 oauth）', async () => {
  resetUpstream();
  const { res } = await collectThenRead({ provider: 'codex-chatgpt', model: 'gpt-6.1-sol', refs: {} });

  assert.equal(res.status, 200);
  // 1. 路由 id 原样，能力归一。
  assert.equal(res.body.provider.id, 'codex-chatgpt');
  assert.equal(res.body.provider.capability, 'openai-codex');
  assert.equal(res.body.provider.kind, 'oauth');
  assert.deepEqual(res.body.errors, [], `不得报错，实际 ${JSON.stringify(res.body.errors)}`);

  // 2. **关键**：usage 真有窗口，不是 null。只把 kind 改成 oauth 会让这里还是 null
  //    （本插件没有那个令牌），卡片就变成"尚未填写 OAuth 令牌"。
  assert.notEqual(res.body.usage, null, `usage 必须从快照取到，实际 ${JSON.stringify(res.body.usage)}`);
  assert.deepEqual(res.body.usage.windows.map((w) => w.key), ['5h', '7d']);
  // 3. 窗口值来自 **activeAccountId** 那个账号（已用 10% / 17%），
  //    不是数组里第一个（0% / 100%）。
  assert.deepEqual(res.body.usage.windows.map((w) => w.percent), [10, 17],
    `应取活跃账号的窗口，实际 ${JSON.stringify(res.body.usage.windows)}`);
  // 4. 数据来源与账号都要说清楚。
  assert.equal(res.body.usage.source, 'plugin');
  assert.equal(res.body.usage.account.id, 'acc-active');
  assert.equal(res.body.usage.account.alias, 'active@example.com');
  assert.equal(res.body.usage.plan, 'plus');
});

test('真实链路：上游不可达时如实失败，不编窗口', async () => {
  resetUpstream('status-fail');
  const { res } = await collectThenRead({ provider: 'codex-chatgpt', model: 'gpt-6.1-sol', refs: {} });

  assert.equal(res.body.provider.kind, 'oauth');
  // 采不到就是采不到：usage 为 null，绝不用 0 / 100% 填坑。
  assert.equal(res.body.usage, null, `没有数据时 usage 必须为 null，实际 ${JSON.stringify(res.body.usage)}`);
  // 且必须说清原因（不是"不支持"，也不是让人去填令牌）。
  assert.equal(res.body.errors.length, 1, `应有一条原因，实际 ${JSON.stringify(res.body.errors)}`);
  assert.ok(!res.body.errors[0].includes('不支持'), `不得说"不支持"，实际 ${res.body.errors[0]}`);
});

test('真实链路：快照里的订阅行带 capability，展示侧不必再写别名表', async () => {
  resetUpstream();
  const { ctx, routes } = makeCtx({ provider: 'codex-chatgpt', model: 'gpt-6.1-sol', refs: {} });
  apply(ctx);
  await call(routes.get('/api/quota-usage/collect'), makePost('/api/quota-usage/collect', { kind: 'subscription' }));
  const snap = await call(routes.get('/api/quota-usage/snapshot'), makeReq({ host: '127.0.0.1:59770' }, '/api/quota-usage/snapshot'));

  const rows = snap.body.snapshots.subscription.value.subscriptions;
  assert.ok(rows.length > 0, '快照里应有订阅行');
  const row = rows.find((r) => r.provider === 'openai-codex');
  assert.ok(row !== undefined, `快照行应以能力 id 出现，实际 ${JSON.stringify(rows.map((r) => r.provider))}`);
  assert.equal(row.capability, 'openai-codex');
  // 顶层 windows 与 activceAccount 同源：都是活跃账号那一份。
  assert.deepEqual(row.windows.map((w) => w.percent), [10, 17],
    `顶层 windows 应取活跃账号，实际 ${JSON.stringify(row.windows)}`);
  assert.equal(row.activeAccount.id, 'acc-active');
  // 账号级数据完整保留（每个账号一行是既有需求）。
  assert.equal(row.accounts.length, 2);
});

test('未采过一轮时不报假故障：别名路由上"没有数据"是过渡态', async () => {
  resetUpstream();
  const { ctx, routes } = makeCtx({ provider: 'codex-chatgpt', model: 'gpt-6.1-sol', refs: {} });
  apply(ctx);
  // **不采集**，直接读：collector 的订阅快照还是 null。
  const res = await call(routes.get('/api/quota-usage'), makeReq({ host: '127.0.0.1:59770' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.provider.kind, 'oauth');
  assert.deepEqual(res.body.errors, [],
    `首轮采集未跑时不得报错（那会是一条假故障），实际 ${JSON.stringify(res.body.errors)}`);
  assert.equal(res.body.usage, null);
});

test('别名路由：仍然打不上游（令牌不在我们这儿），只读快照', async () => {
  resetUpstream();
  const { res } = await collectThenRead({ provider: 'codex-chatgpt', model: 'gpt-6.1-sol', refs: {} });
  assert.equal(res.status, 200);
  // 本插件拿不到 codex-chatgpt 的令牌，所以不该出现对 chatgpt.com 的请求。
  const toUpstream = upstreamCalls.filter((url) => url.includes('chatgpt.com'));
  assert.deepEqual(toUpstream, [],
    `别名路由不该由本插件直连上游（令牌由那个插件持有），实际 ${JSON.stringify(toUpstream)}`);
});

// ---- 账号选取：活跃账号缺数据时**绝不借别人的数** --------------------------
//
// 这是最容易写出"看起来对"的一种错：多账号池里每个账号的用量是分开的，
// 顶层只放得下一份。若"活跃账号没取到"就退到数组里第一个有数的账号，用户看到的
// 是**另一个账号**的剩余量——A 可能已经耗尽，界面却显示宽裕。
// 「读不到」是诚实，「读到别人的」是误导。

/** 造一份快照，让 activeAccountId 指向的账号**没有窗口**。 */
function statusBodyActiveMissing() {
  return {
    ok: true,
    value: {
      authenticated: true,
      quota: { state: 'ok', buckets: [], fetchedAt: 1894905905 },
      accounts: [
        // 这个有窗口，但**不是**活跃账号。
        accountRow({ id: 'acc-other', alias: 'other@example.com', fiveHour: 0, sevenDay: 100 }),
        // 活跃账号：quota 存在但 windows 为空 → 这次没取到用量。
        { id: 'acc-active', alias: 'active@example.com', email: 'active@example.com', planLabel: 'plus', quota: { state: 'ok', windows: [] } },
      ],
      activeAccountId: 'acc-active',
    },
  };
}

test('活跃账号没窗口时：不借别的账号的数，如实报该账号缺数据', async () => {
  upstreamCalls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    upstreamCalls.push(target);
    if (target.includes('/api/dsh-chatgpt-subscription/status')) {
      return new Response(JSON.stringify(statusBodyActiveMissing()), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  };

  const { ctx, routes } = makeCtx({ provider: 'codex-chatgpt', model: 'gpt-6.1-sol', refs: {} });
  apply(ctx);
  await call(routes.get('/api/quota-usage/collect'), makePost('/api/quota-usage/collect', { kind: 'subscription' }));
  const res = await call(routes.get('/api/quota-usage'), makeReq({ host: '127.0.0.1:59770' }));

  assert.equal(res.body.provider.kind, 'oauth');
  // **关键断言**：没有读数。不是"退到 acc-other 的 0/100"。
  assert.equal(res.body.usage, null,
    `活跃账号缺数据时不得借别的账号，实际 ${JSON.stringify(res.body.usage)}`);
  // 也不能悄悄用 0 或 100 填坑（那正是 acc-other 的值）。
  assert.ok(!JSON.stringify(res.body).includes('"percent":100'),
    `不得把备用账号的 100% 冒充成当前读数，实际 ${JSON.stringify(res.body.usage)}`);
  // 必须说清是哪一步缺：不是"不支持"，也不是"去填令牌"。
  assert.equal(res.body.errors.length, 1, `应有一条原因，实际 ${JSON.stringify(res.body.errors)}`);
  assert.ok(!res.body.errors[0].includes('不支持'), `不得说"不支持"，实际 ${res.body.errors[0]}`);
  assert.ok(!res.body.errors[0].includes('OAUTH 令牌'), `不得让人去填令牌，实际 ${res.body.errors[0]}`);
  // 并且点名是哪个账号。
  assert.ok(res.body.errors[0].includes('acc-active'),
    `应点名缺数据的账号，实际 ${res.body.errors[0]}`);
});

test('没有 activeAccountId 时：退到唯一有数的账号，并标明这不是"按活跃账号选的"', async () => {
  upstreamCalls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    upstreamCalls.push(target);
    if (target.includes('/api/dsh-chatgpt-subscription/status')) {
      // 池里只有一份读数，宿主没给 activeAccountId（单账号形态）。
      return new Response(JSON.stringify({
        ok: true,
        value: {
          authenticated: true,
          quota: { state: 'ok', buckets: [], fetchedAt: 1894905905 },
          accounts: [
            { id: 'acc-only', alias: 'only@example.com', email: 'only@example.com', planLabel: 'plus',
              quota: { state: 'ok', windows: [{ usedPercent: 0, windowDurationMins: 300, resetsAt: null },
                { usedPercent: 100, windowDurationMins: 10080, resetsAt: null }] } },
          ],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  };

  const { ctx, routes } = makeCtx({ provider: 'codex-chatgpt', model: 'gpt-6.1-sol', refs: {} });
  apply(ctx);
  await call(routes.get('/api/quota-usage/collect'), makePost('/api/quota-usage/collect', { kind: 'subscription' }));
  const res = await call(routes.get('/api/quota-usage'), makeReq({ host: '127.0.0.1:59797' }));

  assert.notEqual(res.body.usage, null, `唯一账号有数时应该给出来，实际 ${JSON.stringify(res.body.usage)}`);
  // 0% 与 100% 都是**真实读数**，必须原样保留：0 不是"没有数据"，
  // 100 不是"满额可用"（这里是已用 100% = 用完了）。
  assert.deepEqual(res.body.usage.windows.map((w) => w.percent), [0, 100],
    `0/100 是真实读数，不得改写，实际 ${JSON.stringify(res.body.usage.windows)}`);
  // 退化路径要标出来：界面不该写"账号：only@example.com"当成"你正在用的那个"。
  assert.equal(res.body.usage.accountSource, 'only-account',
    `无 activeAccountId 时应标明退化来源，实际 ${res.body.usage.accountSource}`);
  assert.equal(res.body.usage.account.id, 'acc-only');
});

test('空快照：不伪造任何窗口，也不报"不支持"', async () => {
  upstreamCalls = [];
  globalThis.fetch = async () => new Response('{}', { status: 404 });

  const { ctx, routes } = makeCtx({ provider: 'codex-chatgpt', model: 'gpt-6.1-sol', refs: {} });
  apply(ctx);
  await call(routes.get('/api/quota-usage/collect'), makePost('/api/quota-usage/collect', { kind: 'subscription' }));
  const res = await call(routes.get('/api/quota-usage'), makeReq({ host: '127.0.0.1:59770' }));

  assert.equal(res.body.usage, null, `空快照时 usage 必须为 null，实际 ${JSON.stringify(res.body.usage)}`);
  assert.ok(!JSON.stringify(res.body).includes('"percent"'), '不得伪造任何百分比');
  assert.ok(!res.body.errors[0].includes('不支持'), `不得说"不支持"，实际 ${res.body.errors[0]}`);
});

test('0/100 的百分比原样保留：不改写、不取反、不合并', async () => {
  resetUpstream();
  const { res } = await collectThenRead({ provider: 'codex-chatgpt', model: 'gpt-6.1-sol', refs: {} });
  // 活跃账号是 10 / 17（真机实测），备用是 0 / 100。
  // 这里只断言"活跃那份原样过来"，反过来证明没被备用号的 0/100 顶掉。
  assert.deepEqual(res.body.usage.windows.map((w) => w.percent), [10, 17]);
  // 两个窗口的 key 必须与快照一致，不做 300m / 10080m 这种换算。
  assert.deepEqual(res.body.usage.windows.map((w) => w.key), ['5h', '7d']);
  // 已用百分比不做 100-x 反转（反转会把"用了 10%"变成 90%，语义完全相反）。
  assert.ok(!res.body.usage.windows.some((w) => w.percent === 90 || w.percent === 83),
    `不得把已用反转成剩余，实际 ${JSON.stringify(res.body.usage.windows)}`);
});

// ---- 统计预计算调度器（stats-cache）----------------------------------------
//
// 这一组**直接测调度器本身**，不经过扫描器、不经过 HTTP。
//
// 为什么值得单独测：`createStatsCache` 有三条互相牵连的性质，任何一条写错都会
// 悄悄退化成"打开才算"或"永远算一次"：
//   1. get() 是纯读——它一次都不许调用 compute / signature；
//   2. 定时器按 normalizeInterval 的间隔排，并能运行时改；
//   3. 计时器回调触发的那一轮**算全部三个视图**（全机 / 工作区 / 每个已发现会话），
//      否则第一次打开某个会话仍然要等。
//
// 用假时钟 + 假定时器手动推进，全程不 sleep（仓库铁律：测试里不许真实等待）。

const { createStatsCache } = await import('../lib/stats-cache.js');

/** 假定时器：记下句柄与延迟，测试自己决定何时触发。 */
function makeFakeTimers() {
  const pending = new Map();
  let seq = 0;

  /**
   * 让出微任务直到 `done()` 为真，或到达上限。
   *
   * 定时器回调里串着 `Promise.resolve().then(算一轮).then(重排)`，而"算一轮"内部
   * 还有多层 await（每个视图一次 compute + 一次 signature）。固定让出 N 轮微任务
   * 很脆：N 小了会在"算完但还没重排"的中间态上断言，把实现对的写成错的。
   *
   * **上限要小**：`stop()` 之后队列不会再被填上，`settle` 必然空转到上限；
   * 上限给到 2000 时实测把一个用例拖到 60s 超时。200 轮足够跑完正常的一条重排链。
   */
  async function settle(done, limit = 200) {
    for (let i = 0; i < limit; i += 1) {
      if (done()) return true;
      await Promise.resolve();
    }
    return done();
  }

  return {
    timers: {
      setTimeout: (fn, ms) => {
        seq += 1;
        pending.set(seq, { fn, ms });
        return seq;
      },
      clearTimeout: (handle) => { pending.delete(handle); },
    },
    pending,
    settle,
    /** 当前排着的定时器数（fireAll 用它判断"重排发生了没有"）。 */
    size: () => pending.size,
    /**
     * 触发全部已排的定时器。
     *
     * `expectReschedule` 默认 true：正常一轮算完会重排下一次，等它重排完再交还
     * 控制权。`stop()` 之后的那一次显式传 false——那时**不该**有重排，等下去只会
     * 空转到上限，既慢又把"没重排"这件事本身掩盖掉。
     */
    async fireAll({ expectReschedule = true } = {}) {
      const batch = [...pending.entries()];
      pending.clear();
      for (const [, entry] of batch) {
        await entry.fn();
        if (expectReschedule) await settle(() => pending.size > 0);
        else await settle(() => false, 20);
      }
    },
    delays() {
      return [...pending.values()].map((entry) => entry.ms);
    },
  };
}

/** 一个最小的 stats 计算源：记录被调用次数，返回固定形状。 */
function makeComputeSpy() {
  const calls = { machine: 0, workspace: 0, session: [] };
  return {
    calls,
    computeMachine: async () => { calls.machine += 1; return { messages: 7, kinds: [] }; },
    computeWorkspace: async () => { calls.workspace += 1; return []; },
    computeSession: async (id) => { calls.session.push(id); return { messages: 1, kinds: [], sessionId: id }; },
    signature: async () => 'sig-1',
  };
}

test('stats-cache：get() 是纯读——一次都不调计算函数', async () => {
  const spy = makeComputeSpy();
  const fake = makeFakeTimers();
  let nowMs = 1_000_000;
  const cache = createStatsCache({
    ...spy,
    intervalMs: 600000,
    now: () => nowMs,
    timers: fake.timers,
  });

  // 预热之前读：computing，且**没有**触发任何计算。
  const cold = cache.get('machine');
  assert.equal(cold.state, 'computing');
  assert.equal(cold.computedAt, null);
  assert.equal(cold.value, null);
  assert.deepEqual([spy.calls.machine, spy.calls.workspace, spy.calls.session.length], [0, 0, 0],
    'get() 不得触发计算');

  // 手工算一轮，再连读十次：计算次数必须一直是 1。
  await cache.refresh();
  const after = cache.get('machine');
  assert.equal(after.state, 'ready');
  assert.equal(after.value.messages, 7);
  nowMs += 1234;
  for (let i = 0; i < 10; i += 1) cache.get('machine');
  assert.equal(spy.calls.machine, 1, 'get() 连读十次也只能有那一次计算');
});

test('stats-cache：一轮 refresh 覆盖三个视图（含每个已发现会话）', async () => {
  const spy = makeComputeSpy();
  const fake = makeFakeTimers();
  const cache = createStatsCache({ ...spy, intervalMs: 600000, now: () => 0, timers: fake.timers });
  cache.setSessionEnumerator(() => ['session-a', 'session-b']);

  await cache.refresh();

  assert.equal(spy.calls.machine, 1, '全机视图要算');
  assert.equal(spy.calls.workspace, 1, '工作区视图要算');
  assert.deepEqual(spy.calls.session.sort(), ['session-a', 'session-b'],
    '每个已发现会话都要预先算好，否则第一次打开那个会话仍然要等');
  // 三个视图都能读到 ready。
  for (const [scope, id] of [['machine', undefined], ['workspace', undefined], ['session', 'session-a']]) {
    const got = cache.get(scope, id);
    assert.equal(got.state, 'ready', `${scope} 视图应已就绪`);
    assert.equal(typeof got.computedAt, 'number', `${scope} 应带 computedAt`);
  }
});

test('stats-cache：未预热是 computing，且 computedAt 为 null（不是 0）', () => {
  const spy = makeComputeSpy();
  const fake = makeFakeTimers();
  const cache = createStatsCache({ ...spy, now: () => 500, timers: fake.timers });
  const got = cache.get('machine');
  assert.equal(got.state, 'computing');
  assert.equal(got.computedAt, null, 'unix epoch 0 会被读成"1970 年算过"，必须是 null');
  // 未预热时用 value 判断"有没有数据"，value 必须是 null 而不是 {} 或 [].
  assert.equal(got.value, null, '未预热不得给一个空对象冒充"算过了"');
});

test('stats-cache：默认间隔 10 分钟、下限夹到 1 分钟、配置值原样生效', () => {
  const spy = makeComputeSpy();
  const fake = makeFakeTimers();
  // 缺省：复用 collector 的 normalizeInterval → 600000。
  const byDefault = createStatsCache({ ...spy, now: () => 0, timers: fake.timers });
  assert.equal(byDefault.intervalMs, 600000, '默认必须是 10 分钟');
  // 低于下限：夹到 60000 并标记 clamped。
  const tooSmall = createStatsCache({ ...spy, intervalMs: 1000, now: () => 0, timers: fake.timers });
  assert.equal(tooSmall.intervalMs, 60000, '低于下限要夹到 1 分钟');
  assert.equal(tooSmall.clamped, true, '被夹过要说出来，界面据此提示');
  // 合法值：原样。
  const fiveMin = createStatsCache({ ...spy, intervalMs: 300000, now: () => 0, timers: fake.timers });
  assert.equal(fiveMin.intervalMs, 300000);
  assert.equal(fiveMin.clamped, false);
});

test('stats-cache：定时器按间隔排，触发时算一轮并重排下一次', async () => {
  const spy = makeComputeSpy();
  const fake = makeFakeTimers();
  const cache = createStatsCache({ ...spy, intervalMs: 300000, now: () => 0, timers: fake.timers });

  // 没 start() 之前不该排队（否则 import 就有副作用）。
  assert.deepEqual(fake.delays(), []);
  cache.start();
  assert.deepEqual(fake.delays(), [300000], 'start() 应按配置间隔排一次');

  await fake.fireAll();
  assert.equal(spy.calls.machine, 1, '定时器触发要算一轮');
  assert.deepEqual(fake.delays(), [300000], '算完要重排下一次（递归 setTimeout）');

  // stop() 之后不再排队。
  cache.stop();
  assert.deepEqual(fake.delays(), [], 'stop() 必须拆掉定时器');
});

test('stats-cache：运行时改间隔立即重排；停掉后不再自动算', async () => {
  const spy = makeComputeSpy();
  const fake = makeFakeTimers();
  const cache = createStatsCache({ ...spy, intervalMs: 600000, now: () => 0, timers: fake.timers });
  cache.start();
  assert.deepEqual(fake.delays(), [600000]);

  cache.setIntervalMs(120000);
  assert.equal(cache.intervalMs, 120000);
  assert.deepEqual(fake.delays(), [120000], '改间隔要立刻按新间隔重排');

  // 改成一个被夹的值：夹取与 collector 同口径。
  cache.setIntervalMs(1);
  assert.equal(cache.intervalMs, 60000);
  assert.equal(cache.clamped, true);

  cache.stop();
  const before = spy.calls.machine;
  await fake.fireAll({ expectReschedule: false });
  assert.equal(spy.calls.machine, before, 'stop() 之后定时器不得再触发计算');
  assert.deepEqual(fake.delays(), [], 'stop() 之后不得重排定时器');
});

test('stats-cache：计算失败保留旧值并记错误（不把旧数据当新数据）', async () => {
  const fake = makeFakeTimers();
  let nowMs = 1000;
  let shouldFail = false;
  const cache = createStatsCache({
    computeMachine: async () => {
      if (shouldFail) throw new Error('disk hiccup');
      return { messages: 42, kinds: [] };
    },
    computeWorkspace: async () => [],
    computeSession: async () => null,
    signature: async () => 'sig',
    now: () => nowMs,
    timers: fake.timers,
  });
  await cache.refresh();
  assert.equal(cache.get('machine').value.messages, 42);

  // 第二轮失败：值保留、computedAt 不前移、带错误说明。
  shouldFail = true;
  nowMs += 600000;
  await cache.refresh();
  const after = cache.get('machine');
  assert.equal(after.value.messages, 42, '失败时旧值必须留着（"10 分钟前的数字"远好过空白）');
  assert.equal(after.lastError, 'disk hiccup');
  assert.equal(after.state, 'ready');
});

test('stats-cache：stale 由日志指纹判定，不用"距上次多久"猜', async () => {
  const fake = makeFakeTimers();
  let sig = 'sig-1';
  const cache = createStatsCache({
    computeMachine: async () => ({ messages: 1, kinds: [] }),
    computeWorkspace: async () => [],
    computeSession: async () => null,
    signature: async () => sig,
    now: () => 0,
    timers: fake.timers,
  });
  await cache.refresh();
  // 刚算完：指纹一致 → 不是过期。
  await cache.refreshStale('machine');
  assert.equal(cache.get('machine').stale, false, '日志没变时不得报过期');

  // 日志变了：过期。
  sig = 'sig-2';
  await cache.refreshStale('machine');
  assert.equal(cache.get('machine').stale, true, '日志比缓存新时必须报过期');

  // 再算一轮：回到不过期。
  await cache.refresh();
  await cache.refreshStale('machine');
  assert.equal(cache.get('machine').stale, false, '重算之后必须回到不过期');
});

test('stats-cache：从没算过的桶不会被标成 stale（没有基准可比）', async () => {
  const fake = makeFakeTimers();
  const cache = createStatsCache({
    computeMachine: async () => ({}),
    computeWorkspace: async () => [],
    computeSession: async () => null,
    signature: async () => 'sig',
    now: () => 0,
    timers: fake.timers,
  });
  // 从未 refresh，直接问 stale：不该是 true（那等于说"这份不存在的数据过期了"）。
  await cache.refreshStale('machine');
  const got = cache.get('machine');
  assert.equal(got.state, 'computing');
  assert.equal(got.stale, false, '没有基准时不得报 stale');
  assert.equal(got.staleKnown, false, '结论是否量出来的要能区分');
});

test('stats-cache：并发 refresh 合流，不会算两轮', async () => {
  const spy = makeComputeSpy();
  const fake = makeFakeTimers();
  const cache = createStatsCache({ ...spy, now: () => 0, timers: fake.timers });
  // 定时 tick 撞上手动刷新是常态：两轮并发只会互相拖慢、并让 computedAt 乱序。
  await Promise.all([cache.refresh(), cache.refresh(), cache.refresh()]);
  assert.equal(spy.calls.machine, 1, '三次并发 refresh 只能算一轮');
});
