/**
 * dsh-quota-usage — 订阅余量的两种取数模式。
 *
 * 同一个"订阅还剩多少"有两个可能的来源，用户在设置里单选：
 *
 *   independent —— 本插件自己打上游（Claude `/api/oauth/usage`、
 *                  Codex `/backend-api/wham/usage`）。令牌来自宿主凭证服务，
 *                  查询能力全部复用 lib/accounts.js（本文件不写任何 HTTP 请求
 *                  拼装逻辑，避免两套解析器慢慢漂移）。
 *
 *   plugin      —— 直接读 `@eddyskywalker/dsh-chatgpt-subscription` 已经取到的值，
 *                  不重复打上游（它对同一个端点做了 60s 缓存 + 15s 最小间隔 +
 *                  429 退避，我们再打一次只会把它刚拿到的数据变成一次额外限流）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 调研结论（实测，写在代码里而不是留在聊天记录里）：
 *
 *   `plugin` 模式的宿主侧接口**存在，但它不是 cordis service**。
 *
 *   1) 没有服务暴露。对整个 `lib/index.js`（101507 行）搜 `ctx.set(` /
 *      `ctx.provide(` / `provide(` —— 零命中。`UsageService` 定义在
 *      lib/index.js:11584，实例化在 lib/index.js:101155
 *      （`const usage = new UsageService(oauth, { fetchFn: proxyFetch })`），
 *      之后只在插件自己的闭包里流转（传给 registerRoutes 与 adapter），
 *      所以 `ctx.get('...')` 取不到它。
 *
 *   2) 有宿主可读的 HTTP 路由。lib/index.js:797
 *      `const ROUTE_PREFIX$5 = "/api/dsh-chatgpt-subscription"`；
 *      lib/index.js:12107 `function registerRoutes(ctx, oauth, usage, ...)`；
 *      同文件 12111-12132 的 GET 分支：
 *        GET /api/dsh-chatgpt-subscription/status
 *          const quota = await usage.status(oauthStatus.authenticated, false,
 *                                           { backgroundRefresh: true });
 *          json(response, { ok: true, value: { ...oauthStatus, quota, ... } });
 *      也就是说 `UsageService.status()` 的快照（buckets / credits /
 *      individualLimit / resetCredits / fetchedAt / state）原样出现在
 *      `value.quota` 里。
 *
 *   3) 注册方式是 `ctx.webServer.register({ kind: "prefix", path: ROUTE_PREFIX$5,
 *      handler })`（lib/index.js:12452-12455），因此宿主侧任何拿到 webServer
 *      的插件都能用本机回环地址 GET 到这条路由。
 *
 *   4) GET 不需要浏览器会话：`isSameOriginMutation(request)` 的 CSRF 判定只在
 *      POST 分支之后（lib/index.js:12174-12187），GET 在上面的分支里就返回了。
 *
 *   5) 用量端点常量与请求本身：`CODEX_USAGE_URL`（lib/index.js:821）只被
 *      `UsageService.fetch()` 使用（lib/index.js:11897-11902）。也就是说
 *      "用量值"唯一的出口就是上面那条 HTTP 路由。
 *
 *   6) 落盘凭据 `$DSH_HOME/storages/dsh-chatgpt-subscription/oauth.dpapi` 是
 *      Windows DPAPI 加密的，本模块**不解密**，也不把凭据当数据源。
 *
 *   因此 `plugin` 模式的取数路径是：本机 `GET {origin}{PLUGIN_STATUS_PATH}`
 *   → 读 `value.quota` → 归一成与 independent 完全相同的窗口形状。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 口径约束：
 *   · 读不到就是读不到：失败返回 `ok:false` + 明确的 `error` 码，绝不用 0 或
 *     100% 之类"看起来正常"的数字填坑。
 *   · **绝不静默回退**：用户选了 `plugin`，得到的结果里 `mode` 就必须还是
 *     `plugin`，失败也得说清楚是 `plugin` 这条路失败。悄悄改走 independent 会
 *     让用户以为自己在看插件那份数据（两份数据的上游时刻、账号甚至账号池都可能
 *     不同），排查时完全对不上号。
 *   · 时间戳统一成 epoch 毫秒：插件那份快照里 `resetsAt` / `fetchedAt` 是
 *     Unix 秒（lib/index.js:11920 `Math.floor(this.cache.fetchedAt / 1e3)`、
 *     lib/index.js:11683 `window.resetsAt * 1e3`），accounts.js 那边是毫秒。
 *     两种模式对外必须同一个单位，否则界面倒计时会差三个数量级。
 */

import { canonicalProviderId, makeAccountReader, oauthProviderOf } from './accounts.js';

/** 两种取数模式（设置页单选的枚举，顺序即界面顺序）。 */
export const SUBSCRIPTION_MODES = ['independent', 'plugin'];

/**
 * 配置里承载模式的字段名。
 *
 * 单独导出是因为设置页、宿主路由、测试三处都要写同一个字面量；散落成字符串
 * 拼写错误不会报错，只会在某个入口悄悄回退成 independent。
 */
export const SUBSCRIPTION_MODE_FIELD = 'subscriptionMode';

/**
 * dsh-chatgpt-subscription 的状态路由。
 *
 * 与它的 `ROUTE_PREFIX$5`（lib/index.js:797）逐字对应。写死而不是去 import 那个
 * 包：它是可选的第三方插件，宿主上未必安装，import 失败会让本模块整体加载不了。
 */
export const PLUGIN_STATUS_PATH = '/api/dsh-chatgpt-subscription/status';

/**
 * 从它那堆 quota 桶里选哪一个。
 *
 * `UsageService` 的 buckets 至少可能有 `codex`（对话额度）与 `code-review`
 * （代码审查额度），还有 `additional_rate_limits` 展开出来的若干条
 * （lib/index.js:11945-11953）。本插件这张卡片说的是订阅余量本身，取 `codex`；
 * 找不到时才退到第一个有窗口的桶（它的字段可能随套餐变化）。
 */
export const DEFAULT_BUCKET_ID = 'codex';

/** 统一结果形状的空壳：所有失败分支都必须带上 `mode`，一个字段都不许省。 */
function failure(mode, provider, error, extra = {}) {
  return { ok: false, mode, provider, windows: [], plan: null, error, ...extra };
}

/**
 * 读配置里的取数模式。
 *
 * 非法值一律回退 `'independent'`：这是"不需要装别的插件"的那条路，也是这个
 * 插件一直以来的行为。回退只发生在这里（配置解析），绝不发生在取数阶段——
 * 取数阶段选了什么就是什么。
 *
 * 容忍三种写法：字符串本身、`{ subscriptionMode }`、`{ mode }` 或
 * `{ subscription: { mode } }`（设置页的嵌套分组以后再变也不用改这里）。
 *
 * @param {unknown} config 配置对象、模式字符串、或 null/undefined
 * @returns {'independent'|'plugin'}
 */
export function resolveSubscriptionMode(config) {
  if (typeof config === 'string') return acceptMode(config);
  if (config === null || typeof config !== 'object') return SUBSCRIPTION_MODES[0];
  const candidates = [
    config[SUBSCRIPTION_MODE_FIELD],
    config.mode,
    config.subscription !== null && typeof config.subscription === 'object'
      ? config.subscription.mode
      : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return acceptMode(candidate);
  }
  return SUBSCRIPTION_MODES[0];
}

/** 大小写与首尾空白容错；不在枚举里的一律回退第一个模式。 */
function acceptMode(value) {
  const normalized = value.trim().toLowerCase();
  return SUBSCRIPTION_MODES.includes(normalized) ? normalized : SUBSCRIPTION_MODES[0];
}

/**
 * 窗口时长（分钟）→ 卡片上的窗口标签。
 *
 * 与 accounts.js 的 `windowKeyOfSeconds` 同一套分档（那个函数没有导出，这里
 * 按分钟重写一份）：两种模式的窗口标签必须是同一批字符串，否则同一个 `5h`
 * 窗口会在 independent 下叫 `5h`、在 plugin 下叫 `300m`，界面就得为一种数据
 * 源写两套本地化。
 *
 * `null` 表示时长缺失，调用方退回 `cycle`（不猜）。
 */
function windowKeyOfMinutes(value) {
  const minutes = typeof value === 'number' && Number.isFinite(value) ? value : NaN;
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  if (Math.abs(minutes - 300) <= 1) return '5h';
  if (Math.abs(minutes - 10080) <= 60) return '7d';
  if (minutes < 72 * 60) return `${Math.max(1, Math.round(minutes / 60))}h`;
  return `${Math.max(1, Math.round(minutes / 1440))}d`;
}

/** 取一个有限数；缺失 / 非数字返回 null（绝不把 null 当 0）。 */
function finiteOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 把 dsh-chatgpt-subscription 的 `value.quota` 归一成统一窗口形状（纯函数）。
 *
 * 它那边的形状（lib/index.js:11962-11990 的 addBucket / mapWindow）：
 *   { state, buckets: [{ id, name, planType,
 *                        windows: [{ usedPercent, windowDurationMins, resetsAt }] }],
 *     credits, individualLimit, resetCredits, fetchedAt }
 * `usedPercent` 已在 0..100 之间夹过（lib/index.js:11986），`resetsAt` 是 Unix 秒。
 *
 * @param {unknown} quota  `value.quota`
 * @param {{ bucketId?: string }} [options]
 * @returns {{ plan: string|null, windows: Array<{key: string, percent: number, resetsAt: number|null}>,
 *            bucketId: string|null, state: string|null } | null}
 *   完全认不出形状时返回 null（调用方报 `pluginShape`，不猜数字）。
 */
export function normalizePluginQuota(quota, options = {}) {
  if (quota === null || typeof quota !== 'object') return null;
  const buckets = Array.isArray(quota.buckets) ? quota.buckets : [];
  const preferred = typeof options.bucketId === 'string' ? options.bucketId : DEFAULT_BUCKET_ID;
  // 先按 id 精确找；`codex` 不在时退到第一个真的带窗口的桶。
  const selected =
    buckets.find((bucket) => bucket !== null && typeof bucket === 'object' && bucket.id === preferred) ??
    buckets.find((bucket) => bucket !== null && typeof bucket === 'object' && rawWindowsOf(bucket).length > 0) ??
    null;

  const windows = [];
  if (selected !== null) {
    for (const entry of rawWindowsOf(selected)) {
      const percent = finiteOrNull(entry.usedPercent);
      if (percent === null) continue;
      const key = windowKeyOfMinutes(finiteOrNull(entry.windowDurationMins)) ?? 'cycle';
      // 秒 → 毫秒；0 与负数在它那边就已经当"没有"处理（mapWindow 的 `reset > 0`），
      // 这里再挡一次，免得 1970 年出现在界面上。
      const resetSeconds = finiteOrNull(entry.resetsAt);
      const resetsAt = resetSeconds !== null && resetSeconds > 0 ? resetSeconds * 1000 : null;
      windows.push({ key, percent: Math.max(0, Math.min(100, percent)), resetsAt });
    }
  }

  return {
    plan: selected !== null && typeof selected.planType === 'string' ? selected.planType : null,
    windows,
    bucketId: selected !== null && typeof selected.id === 'string' ? selected.id : null,
    state: typeof quota.state === 'string' ? quota.state : null,
  };
}

/**
 * 一个桶里的窗口数组。
 *
 * 正常情况它自己有 `windows`（addBucket 的产物）；这里额外接受 `primary` /
 * `secondary` 两个位置化字段，是因为早期快照形状里只有这两个——多认一种形状
 * 比"读不出数字"便宜。
 */
function rawWindowsOf(bucket) {
  const windows = bucket.windows;
  const rows = [];
  if (Array.isArray(windows)) {
    for (const entry of windows) {
      if (entry !== null && typeof entry === 'object') rows.push(entry);
    }
    if (rows.length > 0) return rows;
  }
  for (const entry of [bucket.primary, bucket.secondary]) {
    if (entry !== null && entry !== undefined && typeof entry === 'object') rows.push(entry);
  }
  return rows;
}

/**
 * 本插件的 webServer 对外 origin。
 *
 * 与 dsh-chatgpt-subscription 自己的 `webServerOrigin`（lib/index.js:6075-6079）
 * 同一套规则：优先 `getOrigin()`，否则用 host/port 拼；`0.0.0.0` 必须换成
 * 回环地址，否则请求会打到"未指定"上。
 *
 * **每次调用时取**，不在 apply 时拍快照：端口是监听器绑定时才有的，apply 阶段
 * 往往是 undefined（它自己也因为这个原因把 origin 写成 `() => webServerOrigin(...)`
 * 这样的惰性函数回调，见 lib/index.js:101162）。
 *
 * @returns {string|null} 取不到时 null（调用方据此报 pluginUnavailable）
 */
export function pluginOrigin(ctx) {
  const server = ctx === null || typeof ctx !== 'object' ? null : ctx.webServer;
  if (server === null || server === undefined) return null;
  if (typeof server.getOrigin === 'function') {
    try {
      const origin = server.getOrigin();
      if (typeof origin === 'string' && origin.trim() !== '') return origin.replace(/\/+$/, '');
    } catch {
      // 监听器还没绑端口时它会抛（它自己的 webServerOrigin 就 throw）；
      // 落到 port 分支继续尝试，不再往上冒。
    }
  }
  const port = finiteOrNull(server.port);
  if (port === null || port <= 0) return null;
  const host = typeof server.host === 'string' && server.host.trim() !== '' ? server.host.trim() : '127.0.0.1';
  const reachableHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${reachableHost}:${Math.trunc(port)}`;
}

/**
 * plugin 模式：读 dsh-chatgpt-subscription 已经取到的用量。
 *
 * @param {object} options
 * @param {object} options.ctx          宿主上下文（只要 webServer）
 * @param {string} options.provider     路由 id（只用于回填结果，不影响取数）
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.origin]     覆盖 origin（测试用）
 * @param {string} [options.bucketId]
 * @returns {Promise<object>} 统一结果形状
 */
export async function readPluginSubscriptionUsage({
  ctx,
  provider,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  origin = null,
  bucketId = DEFAULT_BUCKET_ID,
} = {}) {
  const base = typeof origin === 'string' && origin !== '' ? origin.replace(/\/+$/, '') : pluginOrigin(ctx);
  // 没有 webServer / 没绑端口 = 这条路确实不存在，直接"插件不可用"，
  // 不要把失败原因说成"插件没装"以外的任何东西，也不要绕去 independent。
  if (base === null) return failure('plugin', provider, 'pluginUnavailable');

  let response;
  try {
    response = await fetchImpl(`${base}${PLUGIN_STATUS_PATH}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // 连接被拒 / 超时：路由未注册与服务没起来在宿主侧无法区分，统一按不可用。
    return failure('plugin', provider, 'pluginUnavailable');
  }

  // 404 是"这个插件没注册这条路由"（未安装或未启用）——最典型的不可用。
  if (response.status === 404) return failure('plugin', provider, 'pluginUnavailable');
  if (!(response.status >= 200 && response.status < 300)) {
    return failure('plugin', provider, 'pluginUnavailable', { status: response.status });
  }

  let body;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return failure('plugin', provider, 'pluginShape');
  }
  if (body === null || typeof body !== 'object') return failure('plugin', provider, 'pluginShape');
  // 它自己的路由约定是 `{ ok, value }`（lib/index.js:12117）；ok:false 说明
  // 处理失败，但那条路径下通常还带 error 文案。
  if (body.ok === false) return failure('plugin', provider, 'pluginError');
  const value = body.value;
  if (value === null || typeof value !== 'object') return failure('plugin', provider, 'pluginShape');

  const quota = value.quota;
  if (quota === null || typeof quota !== 'object') return failure('plugin', provider, 'pluginShape');

  // signed-out = 它那边没登录 ChatGPT，是"确实查不到"而不是"插件坏了"。
  // 分开报，用户才知道该去它的设置页登录。
  if (quota.state === 'signed-out') return failure('plugin', provider, 'pluginSignedOut');

  const normalized = normalizePluginQuota(quota, { bucketId });
  if (normalized === null) return failure('plugin', provider, 'pluginShape');
  if (normalized.windows.length === 0) {
    // 有响应但没有窗口：它那边的 `empty` 或上游只回了错误。带出它自己的错误码，
    // 否则界面只能显示一句和 independent 一模一样的"没有数据"。
    const pluginError = quota.error !== null && typeof quota.error === 'object' && typeof quota.error.code === 'string'
      ? quota.error.code
      : null;
    return failure('plugin', provider, normalized.state === 'error' ? 'pluginError' : 'pluginEmpty', {
      plan: normalized.plan,
      pluginError,
    });
  }

  return {
    ok: true,
    mode: 'plugin',
    provider,
    windows: normalized.windows,
    plan: normalized.plan,
    // 它那边的快照时刻（Unix 秒，lib/index.js:11920）：界面用它标"数据是几点的"，
    // 因为 plugin 模式下的数字可能比 independent 旧（它自己缓存 60s）。
    fetchedAt: finiteOrNull(quota.fetchedAt) !== null ? finiteOrNull(quota.fetchedAt) * 1000 : null,
    bucketId: normalized.bucketId,
  };
}

/**
 * 默认的令牌读取：走宿主凭证服务。
 *
 * `@deepseek-ai/dsh-credentials` 在插件仓库里不是本地依赖（peerDependency，由宿主
 * 提供），所以**动态** import：测试与静态检查不会因为缺包而加载失败，真跑在宿主里
 * 时它一定在。
 */
async function defaultReadToken(ctx, ref) {
  const credentials = ctx === null || typeof ctx !== 'object' ? null : ctx.credentials;
  if (credentials === null || credentials === undefined || typeof credentials.resolve !== 'function') {
    return { ok: false, code: 'noKey' };
  }
  let credentialRef;
  try {
    ({ credentialRef } = await import('@deepseek-ai/dsh-credentials'));
  } catch {
    return { ok: false, code: 'credentialsUnavailable' };
  }
  let hit;
  try {
    hit = await credentials.resolve(credentialRef(ref));
  } catch {
    return { ok: false, code: 'noKey' };
  }
  if (hit === undefined || hit === null) return { ok: false, code: 'noKey' };
  const value = typeof hit.value === 'string' ? hit.value.trim() : '';
  if (value === '') return { ok: false, code: 'noKey' };
  // 头值只允许可见 ASCII：非法字符会让 undici 把整个 Authorization 写进异常消息，
  // 那条消息会一路流到卡片上（accounts.js/index.js 的 isUsableKey 同一口径）。
  if (!/^[\x21-\x7e]+$/.test(value)) return { ok: false, code: 'unusable' };
  return { ok: true, value };
}

/**
 * independent 模式：本插件自己打上游。
 *
 * 所有 HTTP 与解析都交给 lib/accounts.js（`makeAccountReader().read()`）——
 * 能力表、端点、请求头、OAuth 的 403 → probe 兜底、失败分类全在那边。这里只做
 * 三件事：把订阅令牌从凭证服务取出来、把结果归一成本模块的窗口形状、把失败码
 * 翻译成界面认识的那几个。
 *
 * @param {object} options
 * @param {object} options.ctx
 * @param {string} options.provider
 * @param {Function} [options.readToken]    默认走 ctx.credentials
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<object>} 统一结果形状
 */
export async function readIndependentSubscriptionUsage({
  ctx,
  provider,
  readToken = defaultReadToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
} = {}) {
  const capabilityId = canonicalProviderId(provider);
  const entry = oauthProviderOf(capabilityId);
  // 不是订阅型提供商（比如当前路由是 DeepSeek / Kimi 这类读余额的）：
  // 这条路上没有任何 OAuth 端点可打，明确说出来，别打一次必然 401 的请求。
  if (entry === null) return failure('independent', provider, 'unsupportedProvider');

  const token = await readToken(ctx, entry.tokenRef);
  if (token === null || typeof token !== 'object' || token.ok !== true) {
    const code = token !== null && typeof token === 'object' && typeof token.code === 'string' ? token.code : 'noKey';
    return failure('independent', provider, code === 'noKey' ? 'accountNoToken' : code);
  }

  // Codex 的账号标识是可选请求头：配了带上，没配也照常查。
  let accountId = '';
  if (typeof entry.accountRef === 'string' && entry.accountRef !== '') {
    const account = await readToken(ctx, entry.accountRef);
    if (account !== null && typeof account === 'object' && account.ok === true) accountId = account.value;
  }

  const reader = makeAccountReader({ fetchImpl, timeoutMs });
  const result = await reader.read(entry, token.value, { accountId });
  if (result === null || typeof result !== 'object' || result.ok !== true) {
    const code = result !== null && typeof result === 'object' && typeof result.code === 'string'
      ? result.code
      : 'empty';
    return failure('independent', provider, code);
  }

  const usage = result.usage;
  const rows = usage !== null && typeof usage === 'object' && Array.isArray(usage.windows) ? usage.windows : [];
  const windows = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const percent = finiteOrNull(row.percent);
    if (percent === null) continue;
    windows.push({
      key: typeof row.key === 'string' && row.key !== '' ? row.key : 'cycle',
      percent: Math.max(0, Math.min(100, percent)),
      resetsAt: finiteOrNull(row.resetsAt),
    });
  }
  if (windows.length === 0) return failure('independent', provider, 'empty');

  return {
    ok: true,
    mode: 'independent',
    provider,
    windows,
    plan: usage !== null && typeof usage === 'object' && typeof usage.plan === 'string' ? usage.plan : null,
  };
}

/**
 * 统一入口：按模式取订阅余量。
 *
 * `mode` 缺省时从 `config` 解析；解析结果原样写回结果的 `mode` 字段——调用方
 * 永远能知道这次看的是哪条路的数据（这是"不静默回退"的可验证形式）。
 *
 * @param {object} options
 * @param {'independent'|'plugin'} [options.mode]
 * @param {unknown} [options.config]        没有 mode 时用它解析
 * @param {object} options.ctx
 * @param {string} options.provider
 * @param {Function} [options.readToken]
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.origin]
 * @param {string} [options.bucketId]
 * @returns {Promise<{ ok: boolean, mode: 'independent'|'plugin', provider: string,
 *   windows: Array<{key: string, percent: number, resetsAt: number|null}>,
 *   plan: string|null, error?: string }>}
 */
export async function readSubscriptionUsage(options = {}) {
  const requested = options.mode !== undefined ? options.mode : options.config;
  const mode = resolveSubscriptionMode(requested);
  const provider = typeof options.provider === 'string' ? options.provider : '';
  if (mode === 'plugin') {
    return readPluginSubscriptionUsage({ ...options, provider });
  }
  return readIndependentSubscriptionUsage({ ...options, provider });
}
