// 订阅余量双模式：independent 打上游 / plugin 读 dsh-chatgpt-subscription 的值。
//
// 这一组钉住五件事：
//   1. 模式解析容错但有限：只有两个合法值，其余一律回退 independent；
//   2. independent 复用 accounts.js 的 OAuth 查询，且把它的窗口形状原样抬过来；
//   3. plugin 走宿主本机 HTTP，把 `value.quota` 的秒级 resetsAt 换成毫秒；
//   4. plugin 不可用时给明确的 pluginUnavailable，**不静默回退**；
//   5. 两条路失败都不造数字（不用 0 或 100% 填坑）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BUCKET_ID,
  PLUGIN_STATUS_PATH,
  SUBSCRIPTION_MODES,
  normalizePluginQuota,
  pluginOrigin,
  readIndependentSubscriptionUsage,
  readPluginSubscriptionUsage,
  readSubscriptionUsage,
  resolveSubscriptionMode,
} from '../lib/subscription.js';

// ── 替身 ───────────────────────────────────────────────────────────────────

/** 造一个 webServer 替身；`getOrigin` 为 null 表示服务器没提供这个方法。 */
function webServerOf({ origin = null, host = '127.0.0.1', port = 51250 } = {}) {
  const server = { host, port };
  if (origin !== null) server.getOrigin = () => origin;
  return server;
}

/**
 * 造一个 fetch 替身：只认一条 URL，回一个固定的 body / status。
 * 记下被调用过的 URL，便于断言"到底打了谁"。
 */
function fetchStub({ status = 200, body = null, text = null } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const payload = text !== null ? text : JSON.stringify(body);
    return {
      status,
      headers: { entries: () => [] },
      text: async () => payload,
      json: async () => JSON.parse(payload),
    };
  };
  impl.calls = calls;
  return impl;
}

/** independent 路径的凭证替身：按引用名给值。 */
function readTokenOf(table) {
  const seen = [];
  const impl = async (_ctx, ref) => {
    seen.push(ref);
    if (Object.prototype.hasOwnProperty.call(table, ref)) return { ok: true, value: table[ref] };
    return { ok: false, code: 'noKey' };
  };
  impl.seen = seen;
  return impl;
}

/** dsh-chatgpt-subscription 的 `/status` 响应（形状照 lib/index.js:12117-12131）。 */
function pluginStatusBody(quota) {
  return { ok: true, value: { authenticated: true, quota } };
}

/** 它那边的 quota 快照（形状照 lib/index.js:11909-11924 + addBucket）。 */
function quotaOf({ buckets, state = 'ready', fetchedAt = 1_763_000_000, error } = {}) {
  return {
    state,
    buckets,
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    resetCredits: null,
    fetchedAt,
    stale: false,
    ...(error === undefined ? {} : { error }),
  };
}

// ── 1. 模式解析 ────────────────────────────────────────────────────────────

test('SUBSCRIPTION_MODES 只有两个值，independent 在前（默认）', () => {
  assert.deepEqual(SUBSCRIPTION_MODES, ['independent', 'plugin']);
});

test('模式解析：合法值原样返回，大小写与空白容错', () => {
  assert.equal(resolveSubscriptionMode('plugin'), 'plugin');
  assert.equal(resolveSubscriptionMode('  PLUGIN  '), 'plugin');
  assert.equal(resolveSubscriptionMode('Independent'), 'independent');
  assert.equal(resolveSubscriptionMode({ subscriptionMode: 'plugin' }), 'plugin');
  assert.equal(resolveSubscriptionMode({ mode: 'plugin' }), 'plugin');
  assert.equal(resolveSubscriptionMode({ subscription: { mode: 'plugin' } }), 'plugin');
});

test('模式解析：非法值与缺失一律回退 independent，不抛错', () => {
  for (const bad of [undefined, null, '', '   ', 42, true, {}, [], 'pluginx', 'auto', 'indep']) {
    assert.equal(resolveSubscriptionMode(bad), 'independent', `非法输入 ${JSON.stringify(bad)} 应回退`);
  }
  // 字段存在但类型不对：也不许抛。
  assert.equal(resolveSubscriptionMode({ subscriptionMode: 7, mode: 'plugin' }), 'plugin',
    '前一个字段非法时继续看下一个候选字段');
  assert.equal(resolveSubscriptionMode({ subscriptionMode: 'nope' }), 'independent');
});

// ── 2. origin 解析 ─────────────────────────────────────────────────────────

test('origin：优先 getOrigin()，去掉尾斜杠；0.0.0.0 换成回环地址', () => {
  assert.equal(pluginOrigin({ webServer: webServerOf({ origin: 'http://127.0.0.1:51250/' }) }), 'http://127.0.0.1:51250');
  assert.equal(pluginOrigin({ webServer: webServerOf({ host: '0.0.0.0', port: 8080 }) }), 'http://127.0.0.1:8080');
  assert.equal(pluginOrigin({ webServer: webServerOf({ host: '::', port: 8080 }) }), 'http://127.0.0.1:8080');
  assert.equal(pluginOrigin({ webServer: webServerOf({ host: '192.168.1.5', port: 9000 }) }), 'http://192.168.1.5:9000');
});

test('origin：getOrigin 抛错时退回 host/port；没有 webServer / 没端口时返回 null', () => {
  const throwing = { host: '127.0.0.1', port: 51250, getOrigin: () => { throw new Error('not bound'); } };
  assert.equal(pluginOrigin({ webServer: throwing }), 'http://127.0.0.1:51250');
  assert.equal(pluginOrigin({}), null);
  assert.equal(pluginOrigin({ webServer: {} }), null, '没有 port 也没有 getOrigin → null');
  assert.equal(pluginOrigin(null), null);
  assert.equal(pluginOrigin(undefined), null);
});

// ── 3. plugin 快照归一（纯函数）─────────────────────────────────────────────

test('normalizePluginQuota：秒级 resetsAt → 毫秒，窗口时长 → 5h / 7d 标签', () => {
  const quota = quotaOf({
    buckets: [
      {
        id: 'codex',
        name: 'Codex',
        planType: 'pro',
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_763_021_600 },
        secondary: { usedPercent: 12.5, windowDurationMins: 10080, resetsAt: 1_763_600_000 },
        windows: [
          { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_763_021_600 },
          { usedPercent: 12.5, windowDurationMins: 10080, resetsAt: 1_763_600_000 },
        ],
      },
    ],
  });
  const normalized = normalizePluginQuota(quota);
  assert.equal(normalized.plan, 'pro');
  assert.equal(normalized.bucketId, 'codex');
  assert.deepEqual(normalized.windows, [
    { key: '5h', percent: 42, resetsAt: 1_763_021_600_000 },
    { key: '7d', percent: 12.5, resetsAt: 1_763_600_000_000 },
  ]);
});

test('normalizePluginQuota：优先 codex 桶，没有时退到第一个带窗口的桶', () => {
  const quota = quotaOf({
    buckets: [
      { id: 'code-review', name: 'Code review', planType: 'pro', windows: [{ usedPercent: 5, windowDurationMins: 10080, resetsAt: null }] },
      { id: 'codex', name: 'Codex', planType: 'pro', windows: [{ usedPercent: 60, windowDurationMins: 300, resetsAt: null }] },
    ],
  });
  assert.equal(normalizePluginQuota(quota).bucketId, 'codex');
  assert.equal(normalizePluginQuota(quota).windows[0].percent, 60);

  const onlyReview = quotaOf({
    buckets: [{ id: 'code-review', name: 'Code review', planType: 'pro', windows: [{ usedPercent: 5, windowDurationMins: 10080, resetsAt: null }] }],
  });
  assert.equal(normalizePluginQuota(onlyReview).bucketId, 'code-review');
  assert.equal(normalizePluginQuota(onlyReview, { bucketId: 'nope' }).bucketId, 'code-review',
    '指定的桶不存在时也要退到有窗口的那个');
});

test('normalizePluginQuota：认不出的形状返回 null，百分比缺字段就跳过（不当 0）', () => {
  assert.equal(normalizePluginQuota(null), null);
  assert.equal(normalizePluginQuota('nope'), null);
  const empty = normalizePluginQuota(quotaOf({ buckets: [] }));
  assert.deepEqual(empty.windows, []);
  const partial = normalizePluginQuota(quotaOf({
    buckets: [{ id: 'codex', windows: [{ windowDurationMins: 300 }, { usedPercent: 33, windowDurationMins: 300 }] }],
  }));
  assert.equal(partial.windows.length, 1, '没有 usedPercent 的窗口跳过');
  assert.equal(partial.windows[0].percent, 33);
});

test('normalizePluginQuota：百分比夹到 0..100，resetsAt 为 0 / 负数视作没有', () => {
  const normalized = normalizePluginQuota(quotaOf({
    buckets: [{ id: 'codex', windows: [
      { usedPercent: 140, windowDurationMins: 300, resetsAt: 0 },
      { usedPercent: -5, windowDurationMins: 300, resetsAt: -1 },
    ] }],
  }));
  assert.deepEqual(normalized.windows.map((w) => w.percent), [100, 0]);
  assert.deepEqual(normalized.windows.map((w) => w.resetsAt), [null, null]);
});

// ── 4. plugin 模式成功路径 ─────────────────────────────────────────────────

test('plugin 成功：GET /api/dsh-chatgpt-subscription/status，读 value.quota', async () => {
  const quota = quotaOf({
    buckets: [{
      id: 'codex',
      name: 'Codex',
      planType: 'plus',
      windows: [
        { usedPercent: 38, windowDurationMins: 300, resetsAt: 1_763_021_600 },
        { usedPercent: 71, windowDurationMins: 10080, resetsAt: 1_763_600_000 },
      ],
    }],
  });
  const fetchImpl = fetchStub({ body: pluginStatusBody(quota) });

  const result = await readSubscriptionUsage({
    mode: 'plugin',
    ctx: { webServer: webServerOf({ origin: 'http://127.0.0.1:51250' }) },
    provider: 'openai-codex',
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'plugin', '模式必须还是用户选的那个');
  assert.equal(result.provider, 'openai-codex');
  assert.equal(result.plan, 'plus');
  assert.equal(result.bucketId, 'codex');
  assert.equal(result.fetchedAt, 1_763_000_000_000, 'fetchedAt 也是秒 → 毫秒');
  assert.deepEqual(result.windows, [
    { key: '5h', percent: 38, resetsAt: 1_763_021_600_000 },
    { key: '7d', percent: 71, resetsAt: 1_763_600_000_000 },
  ]);

  assert.equal(fetchImpl.calls.length, 1, '只打一次本机路由');
  assert.equal(fetchImpl.calls[0].url, `http://127.0.0.1:51250${PLUGIN_STATUS_PATH}`);
  assert.equal(fetchImpl.calls[0].init.method, 'GET');
});

test('plugin 成功：DEFAULT_BUCKET_ID 是 codex（它的对话额度桶）', () => {
  assert.equal(DEFAULT_BUCKET_ID, 'codex');
});

// ── 5. plugin 模式失败路径：明确不可用，绝不回退 ─────────────────────────────

test('plugin 不可用：没有 webServer → pluginUnavailable，且**没有**打上游也没回退', async () => {
  const fetchImpl = fetchStub({ body: pluginStatusBody(quotaOf({ buckets: [] })) });
  const readToken = readTokenOf({ DSH_USAGE_CODEX_OAUTH_TOKEN: 'token' });

  const result = await readSubscriptionUsage({
    mode: 'plugin',
    ctx: {},
    provider: 'openai-codex',
    fetchImpl,
    readToken,
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, 'plugin', '失败也必须报 plugin，不能改成 independent');
  assert.equal(result.error, 'pluginUnavailable');
  assert.deepEqual(result.windows, []);
  assert.equal(fetchImpl.calls.length, 0, '没有可用的 origin，一次请求都不该发');
  assert.equal(readToken.seen.length, 0, '不静默回退到 independent：凭证一次都不该被读');
});

test('plugin 不可用：路由 404（插件未安装/未启用）→ pluginUnavailable', async () => {
  const fetchImpl = fetchStub({ status: 404, text: 'Not found' });
  const result = await readPluginSubscriptionUsage({
    ctx: { webServer: webServerOf({ port: 51250 }) },
    provider: 'openai-codex',
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.mode, 'plugin');
  assert.equal(result.error, 'pluginUnavailable');
});

test('plugin 不可用：连接被拒 / 超时 → pluginUnavailable，不抛', async () => {
  const impl = async () => { throw new Error('ECONNREFUSED'); };
  const result = await readPluginSubscriptionUsage({
    ctx: { webServer: webServerOf({ port: 51250 }) },
    provider: 'openai-codex',
    fetchImpl: impl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'pluginUnavailable');
});

test('plugin 失败：未登录 → pluginSignedOut（可区分的失败，不是"没有数据"）', async () => {
  const fetchImpl = fetchStub({ body: pluginStatusBody(quotaOf({ state: 'signed-out', buckets: [] })) });
  const result = await readPluginSubscriptionUsage({
    ctx: { webServer: webServerOf({ port: 51250 }) },
    provider: 'openai-codex',
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.mode, 'plugin');
  assert.equal(result.error, 'pluginSignedOut');
});

test('plugin 失败：有响应但没有窗口 → pluginEmpty，带上它自己的错误码', async () => {
  const quota = quotaOf({
    buckets: [],
    state: 'error',
    error: { code: 'rate-limited', message: 'Quota refresh was rate limited.' },
  });
  const fetchImpl = fetchStub({ body: pluginStatusBody(quota) });
  const result = await readPluginSubscriptionUsage({
    ctx: { webServer: webServerOf({ port: 51250 }) },
    provider: 'openai-codex',
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'pluginError');
  assert.equal(result.pluginError, 'rate-limited');
});

test('plugin 失败：响应体不是 JSON / 形状不认 → pluginShape，不造数字', async () => {
  const notJson = fetchStub({ text: '<html>nope</html>' });
  const shape = await readPluginSubscriptionUsage({
    ctx: { webServer: webServerOf({ port: 51250 }) },
    provider: 'openai-codex',
    fetchImpl: notJson,
  });
  assert.equal(shape.error, 'pluginShape');
  assert.deepEqual(shape.windows, []);

  const noQuota = fetchStub({ body: { ok: true, value: { authenticated: true } } });
  const missing = await readPluginSubscriptionUsage({
    ctx: { webServer: webServerOf({ port: 51250 }) },
    provider: 'openai-codex',
    fetchImpl: noQuota,
  });
  assert.equal(missing.error, 'pluginShape');
  assert.deepEqual(missing.windows, []);
});

test('plugin 失败：上游 500 → pluginUnavailable，并带出状态码', async () => {
  const fetchImpl = fetchStub({ status: 500, text: 'oops' });
  const result = await readPluginSubscriptionUsage({
    ctx: { webServer: webServerOf({ port: 51250 }) },
    provider: 'openai-codex',
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'pluginUnavailable');
  assert.equal(result.status, 500);
});

test('不静默回退：plugin 失败时结果里绝不出现 independent 的数据', async () => {
  // 让 independent 那条路"本来能成功"——如果实现里有任何回退，这里就会拿到 ok:true。
  const readToken = readTokenOf({
    DSH_USAGE_CODEX_OAUTH_TOKEN: 'sk-ant-oat01-token',
    DSH_USAGE_CODEX_ACCOUNT_ID: 'acct-1',
  });
  const upstreamOk = fetchStub({
    body: {
      plan_type: 'pro',
      rate_limit: {
        primary_window: { used_percent: 10, reset_at: 1_763_021_600, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 20, reset_at: 1_763_600_000, limit_window_seconds: 604800 },
      },
    },
  });

  const result = await readSubscriptionUsage({
    mode: 'plugin',
    ctx: { webServer: webServerOf({ port: 51250 }) },
    provider: 'openai-codex',
    fetchImpl: fetchStub({ status: 404, text: 'Not found' }),
    readToken,
    // 注意：这里没有传 upstreamOk，故意的——一旦回退就会走这个 fetch。
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, 'plugin');
  assert.equal(result.error, 'pluginUnavailable');
  assert.deepEqual(result.windows, []);
  assert.equal(readToken.seen.length, 0, '一次凭证都不该被读');
  assert.equal(upstreamOk.calls.length, 0);
});

// ── 6. independent 模式 ───────────────────────────────────────────────────

test('independent 成功：复用 accounts.js 的 Codex 查询，窗口与 resetsAt 原样抬过来', async () => {
  const fetchImpl = fetchStub({
    body: {
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 25, reset_at: 1_763_021_600, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 64, reset_at: 1_763_600_000, limit_window_seconds: 604800 },
      },
      credits: { has_credits: false, unlimited: false, balance: null },
    },
  });
  const readToken = readTokenOf({
    DSH_USAGE_CODEX_OAUTH_TOKEN: 'sk-codex-token',
    DSH_USAGE_CODEX_ACCOUNT_ID: 'acct-9',
  });

  const result = await readSubscriptionUsage({
    mode: 'independent',
    ctx: {},
    provider: 'openai-codex',
    fetchImpl,
    readToken,
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'independent');
  assert.equal(result.plan, 'plus');
  assert.deepEqual(result.windows, [
    { key: '5h', percent: 25, resetsAt: 1_763_021_600_000 },
    { key: '7d', percent: 64, resetsAt: 1_763_600_000_000 },
  ]);
  // accounts.js 拼的就是这个端点；顺带钉住"没有另写一套 HTTP"。
  assert.equal(fetchImpl.calls[0].url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(fetchImpl.calls[0].init.method, 'GET');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer sk-codex-token');
  assert.equal(fetchImpl.calls[0].init.headers['ChatGPT-Account-Id'], 'acct-9');
});

test('independent 成功：Claude Code 用自己的端点与窗口 key', async () => {
  const fetchImpl = fetchStub({
    body: {
      five_hour: { utilization: 18, resets_at: '2026-11-14T18:00:00.000Z' },
      seven_day: { utilization: 47, resets_at: '2026-11-20T00:00:00.000Z' },
      seven_day_opus: { utilization: 90, resets_at: null },
    },
  });
  const readToken = readTokenOf({ DSH_USAGE_CLAUDE_OAUTH_TOKEN: 'sk-ant-oat01-abc' });

  const result = await readSubscriptionUsage({
    mode: 'independent',
    ctx: {},
    provider: 'anthropic',
    fetchImpl,
    readToken,
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'independent');
  assert.deepEqual(result.windows.map((w) => w.key), ['5h', '7d', '7d-opus']);
  assert.deepEqual(result.windows.map((w) => w.percent), [18, 47, 90]);
  assert.equal(result.windows[0].resetsAt, Date.parse('2026-11-14T18:00:00.000Z'));
  assert.equal(fetchImpl.calls[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(fetchImpl.calls[0].init.headers['anthropic-beta'], 'oauth-2025-04-20');
});

test('independent 失败：没配令牌 → accountNoToken，一次上游都不打', async () => {
  const fetchImpl = fetchStub({ body: {} });
  const readToken = readTokenOf({});
  const result = await readSubscriptionUsage({
    mode: 'independent',
    ctx: {},
    provider: 'openai-codex',
    fetchImpl,
    readToken,
  });
  assert.equal(result.ok, false);
  assert.equal(result.mode, 'independent');
  assert.equal(result.error, 'accountNoToken');
  assert.deepEqual(result.windows, []);
  assert.equal(fetchImpl.calls.length, 0);
});

test('independent 失败：401 且无 probe 兜底 → unauthorized，不造数字', async () => {
  const fetchImpl = fetchStub({ status: 401, text: '{"error":"invalid token"}' });
  const readToken = readTokenOf({ DSH_USAGE_CODEX_OAUTH_TOKEN: 'expired' });
  const result = await readIndependentSubscriptionUsage({
    ctx: {},
    provider: 'openai-codex',
    fetchImpl,
    readToken,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unauthorized');
  assert.deepEqual(result.windows, []);
});

test('independent 失败：不是订阅型提供商 → unsupportedProvider，不打上游', async () => {
  const fetchImpl = fetchStub({ body: {} });
  const result = await readIndependentSubscriptionUsage({
    ctx: {},
    provider: 'deepseek-official',
    fetchImpl,
    readToken: readTokenOf({}),
  });
  assert.equal(result.ok, false);
  assert.equal(result.mode, 'independent');
  assert.equal(result.error, 'unsupportedProvider');
  assert.equal(fetchImpl.calls.length, 0);
});

test('independent：路由 id 别名 chatgpt-codex 归一成 openai-codex 后照样能查', async () => {
  const fetchImpl = fetchStub({
    body: {
      plan_type: 'pro',
      rate_limit: {
        primary_window: { used_percent: 5, reset_at: 1_763_021_600, limit_window_seconds: 18000 },
      },
    },
  });
  const result = await readSubscriptionUsage({
    mode: 'independent',
    ctx: {},
    provider: 'chatgpt-codex',
    fetchImpl,
    readToken: readTokenOf({ DSH_USAGE_CODEX_OAUTH_TOKEN: 'tok' }),
  });
  assert.equal(result.ok, true);
  // provider 字段回填的是调用方传来的原始 id，界面才知道自己问的是哪条路由。
  assert.equal(result.provider, 'chatgpt-codex');
  assert.equal(result.windows.length, 1);
});

test('independent 失败：上游返回形状不认 → shape，不猜百分比', async () => {
  const fetchImpl = fetchStub({ body: { unexpected: true } });
  const result = await readIndependentSubscriptionUsage({
    ctx: {},
    provider: 'openai-codex',
    fetchImpl,
    readToken: readTokenOf({ DSH_USAGE_CODEX_OAUTH_TOKEN: 'tok' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'shape');
  assert.deepEqual(result.windows, []);
});

// ── 7. 入口按 config 选路 ──────────────────────────────────────────────────

test('readSubscriptionUsage：mode 缺省时从 config 解析（非法值走 independent）', async () => {
  const fetchImpl = fetchStub({ body: { plan_type: 'pro', rate_limit: { primary_window: { used_percent: 8, limit_window_seconds: 18000 } } } });
  const result = await readSubscriptionUsage({
    config: { subscriptionMode: 'garbage' },
    ctx: {},
    provider: 'openai-codex',
    fetchImpl,
    readToken: readTokenOf({ DSH_USAGE_CODEX_OAUTH_TOKEN: 'tok' }),
  });
  assert.equal(result.mode, 'independent');
  assert.equal(fetchImpl.calls[0].url, 'https://chatgpt.com/backend-api/wham/usage');
});

test('readSubscriptionUsage：显式 mode 优先于 config', async () => {
  const fetchImpl = fetchStub({ body: pluginStatusBody(quotaOf({ buckets: [{ id: 'codex', windows: [{ usedPercent: 9, windowDurationMins: 300, resetsAt: null }] }] })) });
  const result = await readSubscriptionUsage({
    mode: 'plugin',
    config: { subscriptionMode: 'independent' },
    ctx: { webServer: webServerOf({ port: 51250 }) },
    provider: 'openai-codex',
    fetchImpl,
  });
  assert.equal(result.mode, 'plugin');
  assert.equal(result.ok, true);
  assert.equal(result.windows[0].percent, 9);
  assert.ok(fetchImpl.calls[0].url.endsWith(PLUGIN_STATUS_PATH));
});

test('两种模式的窗口形状完全一致（同一批 key，同一毫秒单位）', async () => {
  const pluginResult = await readSubscriptionUsage({
    mode: 'plugin',
    ctx: { webServer: webServerOf({ port: 51250 }) },
    provider: 'openai-codex',
    fetchImpl: fetchStub({
      body: pluginStatusBody(quotaOf({
        buckets: [{
          id: 'codex',
          planType: 'pro',
          windows: [
            { usedPercent: 11, windowDurationMins: 300, resetsAt: 1_763_021_600 },
            { usedPercent: 22, windowDurationMins: 10080, resetsAt: 1_763_600_000 },
          ],
        }],
      })),
    }),
  });
  const independentResult = await readSubscriptionUsage({
    mode: 'independent',
    ctx: {},
    provider: 'openai-codex',
    fetchImpl: fetchStub({
      body: {
        plan_type: 'pro',
        rate_limit: {
          primary_window: { used_percent: 11, reset_at: 1_763_021_600, limit_window_seconds: 18000 },
          secondary_window: { used_percent: 22, reset_at: 1_763_600_000, limit_window_seconds: 604800 },
        },
      },
    }),
    readToken: readTokenOf({ DSH_USAGE_CODEX_OAUTH_TOKEN: 'tok' }),
  });

  assert.deepEqual(pluginResult.windows, independentResult.windows);
  assert.equal(pluginResult.plan, independentResult.plan);
});
