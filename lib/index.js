/**
 * dsh-quota-usage — host half.
 *
 * 注册四个 HTTP 路由：
 *
 *   GET  /api/quota-usage[?lang=zh|en]   当前模型的账户（余额 / 订阅用量）
 *   GET  /api/quota-usage/accounts       插件页元数据：映射目标、未识别路由、OAuth 令牌状态
 *   POST /api/quota-usage/token          写入或清除 OAuth 订阅令牌
 *   GET  /api/quota-usage/holidays       法定节假日表（浏览器侧启动拉一次）
 *
 * 插件配置（Config）只有一项 providerAliases：把第三方 provider 插件注册的路由 id
 * 映射到本插件支持的能力条目。设置页（Plugins → 本插件 bundle 的行 → 配置）读写
 * 它，也可以直接在 profile 的 cordis.patch.yml 里手写。非法项在激活时只记一条日志，
 * 不阻塞插件启动。插件页的映射编辑器消费 /accounts 的 aliasable（可作为映射目标的
 * 提供商）与 unmapped（检测到但未识别的路由）；OAuth 令牌填写区消费同一响应里的
 * oauth（检测到的提供商及令牌是否已填写）。
 *
 * 主路由返回（JSON）：
 *   {
 *     ok: true,
 *     provider: { id, displayName, kind, reason, via },   // 当前模型的 provider 及查询能力
 *     balance: { isAvailable, total, currency },     // kind=balance 时有效
 *     usage: null | { plan, windows: [{key,percent,resetsAt}] },  // kind=usage/oauth
 *     tier: { input, cacheRead, cacheWrite, output, model, known, currency, window },
 *     next: { peak, at, ms },                        // 距下次计费区间翻转（界面倒计时）
 *     peak,                                          // 当前是否处于较贵的一侧
 *     updatedAt, errors,
 *     pricing: { via, requested, provider, capability, used, known, currency, window } // 【内部诊断】
 *   }
 *
 * provider.via 说明这个路由是怎么被认出来的：`exact`（能力表命中）、`alias`
 * （用户在本插件配置里添加的映射）、`none`（未识别）。识别顺序固定：精确 id 优先，
 * 命中不了才查用户映射；不按名字、不按端点猜。
 *
 * 界面只使用 provider / balance / usage / tier / next / peak / errors：插件内部的取价
 * 路径属于诊断信息，保留在响应里供排查与测试，但不出现在 UI 上。
 * errors 只放"用户能理解且需要行动"的账户类失败，不含任何上游原文——上游错误消息
 * 可能带着凭据片段（undici 会把非法的 Authorization 值写进异常消息），直接透出等于
 * 把 Key 印在侧边栏上。
 *
 * `lang` 参数（zh 前缀用中文，其余值或缺省用英文）只影响错误消息的语言；UI 其余文案由 client 端本地化。
 *
 * 账户数据源（lib/accounts.js 的能力表）：
 *   · 余额类：DeepSeek /user/balance、Moonshot /v1/users/me/balance、
 *     智谱 /api/biz/account/query-customer-account-report、OpenRouter /api/v1/key
 *     （单 Key 无限额时回落 /api/v1/credits）；
 *   · 订阅用量类：Kimi Coding /coding/v1/usages、OpenCode /zen/go/v1/usage、
 *     MiniMax /v1/token_plan/remains——订阅制没有余额接口，只有窗口百分比；
 *   · OAuth 订阅类：Claude Code /api/oauth/usage、Codex /backend-api/wham/usage，
 *     令牌由用户在插件页粘贴，经凭证服务存取（本机 .credentials.yaml），宿主之外
 *     任何位置都看不到它；
 *   · 其余 provider（云厂商 AK/SK、无可用接口的 OAuth-only）不查询，界面说明原因。
 *
 * 单价数据源：lib/pricing.js 的 PRICE_TABLES——一家提供商一份手动采集的快照，
 * DeepSeek 只是其中一条（带峰谷时段与法定节假日口径），代码不分叉。厂商调价时随
 * 插件版本更新——不联网抓取、不读写本地价格配置文件。
 * 只按 provider + 模型 id 精确查表：第三方路由上的 deepseek-* 同名模型按各自规则
 * 扣费，用官方快照算出来的数字与账单无关。表里模型带 schedule 时返回当前区间与
 * 下一次切换（tier.window / next），界面据此画指示灯与倒计时。
 *
 * 安全：所有路由只接受本机来源（见 isTrustedRequest）——与 DSH 自身的 /api 栅栏
 * 同一口径：Host 必须是回环地址或本监听器绑定的地址，跨站请求标记与异源 Origin
 * 一律拒绝。/token  additionally 要求 Content-Type 为 JSON 且 body 有界，
 * 只接受能力表白名单里的 provider，写入只经 credentials.set（见 routeToken）。
 * 另见 README 的"已知限制"：本机其它进程仍可直接访问该端口，这是本地工具的固有边界。
 */
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import z from "@deepseek-ai/schemastery";
import {
  accountCapabilityOf,
  aliasableProviderIds,
  candidateRefsOf,
  canonicalProviderId,
  makeAccountReader,
  oauthProviderIds,
  oauthProviderOf,
} from "./accounts.js";
import {
  DEFAULT_MODEL,
  HOLIDAY_RANGES,
  hasHolidayCoverage,
  isDeepSeekScheduleModel,
  isPeak,
  nextChange,
  unitAt,
} from "./pricing.js";
import { createProviderResolver, normalizeAliases } from "./providers.js";
import {
  createUsageScanner,
  createSessionModelResolver,
  listSessionFiles,
  resolveDshHome,
  sessionsRoot,
} from "./usage.js";
import { createStatsCache } from "./stats-cache.js";
import { readFreeModelCredits } from "./credits.js";
import {
  createCollector,
  normalizeInterval,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  RECOMMENDED_MIN_INTERVAL_MS,
} from "./collector.js";
import { makeChannelCreditsRpc, listCreditChannels, probeChannelCredits } from "./channel-credits.js";
import {
  readPluginSubscriptionUsage,
  readIndependentSubscriptionUsage,
  resolveSubscriptionMode,
  SUBSCRIPTION_MODES,
  // 下面四个是"多账号池型订阅"要用的零件：`lib/subscription.js` 的
  // `readPluginSubscriptionUsage` 只读**聚合桶**（`value.quota`），读不到
  // `value.accounts[]` 里的每账号用量。本文件因此自己取一次那条 HTTP 路由，
  // 但窗口归一化仍然交给它导出的 `normalizePluginQuota`——重写一份窗口时长
  // 分档会让 plugin 与 independent 两条路悄悄漂出两套 key（`5h` vs `300m`），
  // 界面就得为同一种数据写两套本地化。
  normalizePluginQuota,
  pluginOrigin,
  PLUGIN_STATUS_PATH,
  DEFAULT_BUCKET_ID,
} from "./subscription.js";
import { costOfSummary } from "./cost.js";
import { scanWorkspaces } from "./workspaces.js";
import { asOfOf } from "./pricing.js";
// 价格表：配置页「单价」块的数据通道（读整张表 / 保存 / 恢复出厂价）。
// 记录校验与形态规则都在 lib/price-store.js 里（写入路径与读取路径共用同一份），
// 这里只做路由与响应形状，不复制第二套规则。
import {
  currentTable as currentPriceTable,
  resetToSeed as resetPriceTable,
  saveRecord as savePriceRecord,
  SEED_RECORDS,
} from "./price-table.js";
import { formOf as priceFormOf } from "./price-store.js";

const name = "dsh-quota-usage";
const inject = ["credentials", "webServer"];

/**
 * 插件配置：把第三方插件注册的 provider 路由映射到本插件支持的提供商。
 *
 * 设置页（Plugins → 本插件 bundle → 行 → 配置）读写这一项；`volatile()` 是
 * host 的 settings.describe 收录该字段、并把表单交给浏览器侧的必要条件。
 * capability 的枚举与设置页下拉共用 aliasableProviderIds()，不另维护一份。
 * 目标可以是 OAuth 提供商（Claude Code / OpenAI Codex）：此时映射只决定账户口径，
 * 凭据引用不参与（令牌由插件页的「订阅令牌」区经 /token 写入凭据服务）。
 *
 * 老宿主的 schemastery 若没有 volatile()，退化成一个普通 schema：配置仍能被校验、
 * 仍然可以手写 YAML，只是没有设置表单——不能因为缺一个修饰符就让插件加载失败。
 */
function buildConfig(z) {
  const field = z.array(z.object({
    provider: z.string().required(),
    capability: z.union(aliasableProviderIds().map((id) => z.const(id))).required(),
    refs: z.array(z.string()).default([]),
  })).default([]);
  // 采集频率（毫秒）：三类各自可调。缺省 10 分钟，硬下限 1 分钟由
  // lib/collector.js 的 normalizeInterval 夹住——配置层不重复实现下限逻辑，
  // 免得两处判断慢慢漂移。
  //
  // 三项都做成 optional：用户只改了积分频率时，另外两项不该被写进配置文件
  // （那样升级后默认值就再也改不动了）。
  const interval = z.number();
  return z.object({
    providerAliases: typeof field.volatile === "function" ? field.volatile() : field,
    // 订阅余量的取数模式：independent（自己打上游）/ plugin（读 dsh-chatgpt-subscription）。
    // 枚举与 lib/subscription.js 的 SUBSCRIPTION_MODES 同源，不另维护一份。
    subscriptionMode: z.union(SUBSCRIPTION_MODES.map((id) => z.const(id))).default("independent"),
    collectIntervals: z.object({
      credits: interval,
      prepaid: interval,
      subscription: interval,
      // 用量统计的**后台预计算**间隔。
      //
      // 与上面三项同一个字段族、同一套归一化（lib/collector.js 的 normalizeInterval：
      // 默认 10 分钟、硬下限 1 分钟）。不另起一个顶层字段，是因为它就是"一类东西多久
      // 算/采一次"，用户在同一块表单里改最自然，也不会出现两个语义相同的旋钮。
      stats: interval,
    }).default({}),
  });
}

const Config = buildConfig(z);

const PUBLIC_BASE_URL = "https://api.deepseek.com";
/** 与 llm-deepseek 适配器对齐的环境变量覆盖。注意：指向第三方网关时 API Key 会发给该地址。 */
const BASE_URL_ENV = "DEEPSEEK_BASE_URL";
const API_KEY_REF = credentialRef("DEEPSEEK_API_KEY");
const BALANCE_PATH = "/user/balance";
const ROUTE_PATH = "/api/quota-usage";
const ACCOUNTS_PATH = "/api/quota-usage/accounts";
const TOKEN_PATH = "/api/quota-usage/token";
/** 放假日期路由（浏览器侧启动拉一次，保证两边同一份日期表）。 */
const HOLIDAYS_PATH = "/api/quota-usage/holidays";
/** 会话用量统计路由（只读预计算缓存，见 lib/stats-cache.js）。 */
const STATS_PATH = "/api/quota-usage/stats";
/**
 * 统计后台预计算是否自动启动。
 *
 * 模块级常量（一次求值），默认开启；只有显式设成 `0` 才关。
 * 关闭后统计路由永远是 `state: 'computing'`，除非有人 POST 强制算一次——
 * 这是给"只想验证别的行为"的测试用的窄口，生产路径不会碰它。
 */
const STATS_AUTOSTART = process.env.DSH_QUOTA_USAGE_STATS_AUTOSTART !== "0";
/** 免费渠道积分路由（读 dsh-free-model 落盘状态，见 lib/credits.js）。 */
const CREDITS_PATH = "/api/quota-usage/credits";
/**
 * 价格表路由：配置页「单价」块的数据通道。
 *
 *   GET  → { ok: true, records: [...] }   整张表（渠道×模型）
 *   POST → { action: "save", record: {...} }  保存一条用户改的价
 *   POST → { action: "reset" }                  恢复出厂价
 *
 * 响应形状由浏览器侧 lib/client.js 的 PriceEditor 消费，**不能改**：客户端把
 * 「响应体不是 {ok:true, records:[…]}」与「404」一律按「暂不可用」处理，所以这里
 * 必须是 ok:true + records 的确切形状，不能是 {records:[…]} 或 {ok:true,data:…}。
 *
 * 记录本身来自 lib/price-store.js 的存储（$DSH_HOME/storages/dsh-quota-usage/
 * price-table.json）；出厂价是 lib/price-table.js 的 103 条种子。存储坏了由 price-store
 * 自己回落种子，路由**不得**因此返回 500——用户至少要能看见默认价并继续编辑。
 */
const PRICES_PATH = "/api/quota-usage/prices";
/** 采集快照路由：展示侧唯一的数据来源（只读缓存，见 lib/collector.js）。 */
const SNAPSHOT_PATH = "/api/quota-usage/snapshot";
/** 显式采集（人工刷新）：允许在定时之外触发一次，但不改变定时节奏。 */
const COLLECT_PATH = "/api/quota-usage/collect";
const TIMEOUT_MS = 15000;
/** 余额响应体上限：网关返回异常大 body 时不让它占满内存。 */
const MAX_BODY_BYTES = 64 * 1024;
/**
 * 账户快照缓存时长（毫秒）。客户端每 30s 心跳一次，多个标签页/多次点击会重复打
 * 上游接口；缓存把这段时间内的重复请求合并成一次。
 */
const ACCOUNT_CACHE_MS = 10_000;
/**
 * /token 写入体上限：令牌是单行 ASCII，4KiB 足够；与余额响应体上限分开是因为
 * 两者的威胁模型不同（一个是上游返回，一个是本机提交）。
 */
const MAX_TOKEN_BODY_BYTES = 8 * 1024;


const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

/**
 * 错误消息字典（zh/en）。只保留"账户数据为什么拿不到"这类用户能理解、且需要行动的
 * 信息；不拼接任何上游原文或异常消息。
 *
 * `balance*` / `noKey` / `badKey` 是 DeepSeek 官方余额的专属文案，逐字保留：
 * 已有用户与回归测试都认这一套说法。其余提供商走 `account*`，其中
 * `accountNoKey` / `accountNoKeyNamed` 由调用方把引用名填进参数位。
 */
const MESSAGES = {
  zh: {
    noKey: "未配置 DEEPSEEK_API_KEY",
    badKey: "DEEPSEEK_API_KEY 含有非法字符",
    balanceHttp: (status) => `余额接口 HTTP ${status}`,
    balanceTimeout: "余额接口超时",
    balanceNetwork: "余额接口无法连接",
    balancePayload: "余额接口返回了无法解析的内容",
    balanceEmpty: "余额接口没有返回余额",
    balanceUnavailable: "账户当前不可用",
    forbidden: "仅允许本机访问",
    method: "仅支持 GET",
    internal: "插件内部错误",
    accountHttp: (status) => `账户接口 HTTP ${status}`,
    accountTimeout: "账户接口超时",
    accountNetwork: "账户接口无法连接",
    accountPayload: "账户接口返回了无法解析的内容",
    accountEmpty: "账户接口没有返回可用数值",
    accountUnavailable: "账户当前不可用",
    accountNoKey: "未配置该提供商的 API Key",
    accountNoKeyNamed: (name) => `未配置 ${name}`,
    accountNoToken: "尚未填写该提供商的 OAuth 令牌",
    // 别名路由（别人注册的订阅路由，如 codex-chatgpt）上的"没数据"另有原因：
    // 令牌由那个插件自己登录保管，本插件没有、也不需要它。再报"去填令牌"会把
    // 用户引到一个空输入框。
    accountAliasNoReading: "该订阅由对应插件采集，尚未取到用量",
    accountAliasActiveMissing: "当前账号尚未取到用量",
    accountAliasActiveMissingNamed: (id) => `当前账号（${id}）尚未取到用量`,
    accountNoGrant: "DeepSeek 账号尚未登录：在设置里登录后即可显示余额",
    accountTokenExpired: "OAuth 令牌已失效，请重新填写",
    accountNoApi: (name) => `当前插件不支持 ${name}`,
    tokenUnknownProvider: "不支持的提供商",
    tokenMethod: "仅支持 POST",
    tokenPayload: "请求内容无法解析",
    tokenWritten: "令牌已保存",
    tokenCleared: "令牌已清除",
    tokenFailed: "令牌保存失败",
    pricesMethod: "仅支持 GET 与 POST",
    pricesPayload: "请求内容无法解析",
    pricesUnknownAction: "未知操作",
    pricesSaveFailed: "价格保存失败",
    pricesResetFailed: "恢复出厂价失败",
  },
  en: {
    noKey: "DEEPSEEK_API_KEY is not configured",
    badKey: "DEEPSEEK_API_KEY contains invalid characters",
    balanceHttp: (status) => `Balance API HTTP ${status}`,
    balanceTimeout: "Balance API timed out",
    balanceNetwork: "Balance API is unreachable",
    balancePayload: "Balance API returned an unreadable response",
    balanceEmpty: "Balance API returned no balance",
    balanceUnavailable: "The account is currently unavailable",
    forbidden: "Local access only",
    method: "GET only",
    internal: "Internal plugin error",
    accountHttp: (status) => `Account API HTTP ${status}`,
    accountTimeout: "Account API timed out",
    accountNetwork: "Account API is unreachable",
    accountPayload: "Account API returned an unreadable response",
    accountEmpty: "Account API returned no usable value",
    accountUnavailable: "The account is currently unavailable",
    accountNoKey: "This provider has no API key configured",
    accountNoKeyNamed: (name) => `${name} is not configured`,
    accountNoToken: "This provider has no OAuth token yet",
    accountAliasNoReading: "This subscription is collected by its own plugin; no usage reading yet",
    accountAliasActiveMissing: "The active account has no usage reading yet",
    accountAliasActiveMissingNamed: (id) => `The active account (${id}) has no usage reading yet`,
    accountNoGrant: "Not signed in to a DeepSeek account: sign in to see the balance",
    accountTokenExpired: "The OAuth token is no longer valid; save it again",
    accountNoApi: (name) => `This plugin does not support ${name}`,
    tokenUnknownProvider: "Unsupported provider",
    tokenMethod: "POST only",
    tokenPayload: "The request body could not be read",
    tokenWritten: "Token saved",
    tokenCleared: "Token cleared",
    tokenFailed: "The token could not be saved",
    pricesMethod: "GET and POST only",
    pricesPayload: "The request body could not be read",
    pricesUnknownAction: "Unknown action",
    pricesSaveFailed: "The price could not be saved",
    pricesResetFailed: "The factory prices could not be restored",
  },
};

/**
 * 放假日期表未覆盖当前年份时告警一次（每天一次）。
 *
 * 在请求路径上检查，而不是只在启动时：进程跨年长跑时，下一年的节假日仍按工作日
 * 计价，而这正是用户真正会看到错误价格的时段——只在启动时告警覆盖不到那一刻。
 */
let lastHolidayWarningDay = "";
function warnHolidayCoverage(ctx) {
  if (hasHolidayCoverage()) return;
  const now = Date.now();
  const day = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (day === lastHolidayWarningDay) return;
  lastHolidayWarningDay = day;
  const year = new Date(now + 8 * 60 * 60 * 1000).getUTCFullYear();
  ctx.logger.warn(
    `dsh-quota-usage: 内置放假日期表未覆盖 ${year} 年（仅收录到 ${HOLIDAY_RANGES.at(-1)?.[1] ?? "未知"}）`
      + `，${year} 年法定节假日白天会被当作高峰时段：请按国务院办公厅通知更新 lib/pricing.js 的 HOLIDAY_RANGES`
      + `（并同步 lib/client.js 的镜像表，并把 HOLIDAY_TABLE_THROUGH_YEAR 推到 ${year}）`,
  );
}

function sendJson(res, status, body) {
  // 已经发过响应头时再写一次会抛 ERR_HTTP_HEADERS_SENT，直接结束即可。
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function balanceUrl() {
  const base = process.env[BASE_URL_ENV] ?? PUBLIC_BASE_URL;
  return `${base.replace(/\/+$/, "")}${BALANCE_PATH}`;
}

/**
 * 账号路由（`deepseek-account`）的余额端点，恒为官方源。
 *
 * 宿主只肯把登录 grant 发到它配置的官方推理源（`resolveToken(url)` 校验
 * `destination.origin === inferenceOrigin`，默认 https://api.deepseek.com），
 * 所以这里不能走 `balanceUrl()`：一旦用户把 DEEPSEEK_BASE_URL 指向第三方中转，
 * 账号令牌就会被送到那个地址。自定义基址只对 api-key 路由生效。
 */
function accountBalanceUrl() {
  return `${PUBLIC_BASE_URL}${BALANCE_PATH}`;
}

/** 容忍字符串/数字，返回有限数或 NaN。 */
function toFinite(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/**
 * 请求头里的 Host 是否是"本机"。
 *
 * 接受：回环地址（127/8 任意地址、::1、localhost）、本监听器绑定的地址。
 * 与 DSH 自己的 /api 栅栏同一口径（见 app.asar 的 isTrustedApiRequest）：只认回环
 * 会让 `--host <局域网IP>` 与 `--trusted-host` 部署下插件永久 403。
 */
function isLocalHost(req, bindHost) {
  const raw = req.headers.host;
  if (typeof raw !== "string" || raw === "") return false;
  const host = hostNameOf(raw);
  if (host === null) return false;
  if (host === "localhost" || host === "::1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host === "::ffff:127.0.0.1") return true;
  // 监听器绑定的地址（如 --host 10.0.0.7）同样是"自己"。
  if (typeof bindHost === "string" && bindHost !== "") {
    const bind = hostNameOf(bindHost);
    if (bind !== null && bind !== "" && host === bind) return true;
  }
  return false;
}

/**
 * 取 authority 里的主机名：小写、去掉端口与 IPv6 方括号。
 * IPv6 不能按冒号切（`::1` 切出空串），所以先剥方括号再处理。
 */
function hostNameOf(authority) {
  let host = authority.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return null;
    host = host.slice(1, end);
    return host;
  }
  const idx = host.lastIndexOf(":");
  if (idx !== -1 && host.indexOf(":") === idx) host = host.slice(0, idx);
  return host === "" ? null : host;
}

/**
 * 请求是否可以访问本插件的路由。
 *
 * 口径与 DSH 的 /api 栅栏一致：
 *   1. Host 必须是本机（回环或监听器绑定地址）；
 *   2. 浏览器标记为跨站的请求一律拒绝；
 *   3. 带 Origin 时，Origin 必须与 Host 同一 authority。
 * 这样任意网页都无法跨站读走余额，DNS rebinding（Host 变成攻击者域名）同样被挡下。
 */
function isTrustedRequest(req, bindHost) {
  if (!isLocalHost(req, bindHost)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "") {
    let originHost;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return false;
    }
    const host = String(req.headers.host ?? "").toLowerCase();
    if (originHost !== host) return false;
  }
  return true;
}

/**
 * 语言标签 → 文案语言：中文（zh、zh-CN、zh-Hans…）用中文，其它任何语言一律英文。
 * 与浏览器侧 lib/client.js 的 uiLang 同一规则。
 */
function uiLanguageOf(value) {
  return typeof value === "string" && value.trim().toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** 解析 ?lang= 参数：zh 前缀用中文，其余值或缺省用英文。 */
function resolveQuery(req) {
  const url = req.url ?? "";
  const q = url.indexOf("?");
  const kv = q === -1 ? [] : url.slice(q + 1).split("&");
  let lang = "en";
  let sessionId = "";
  for (const item of kv) {
    const eq = item.indexOf("=");
    if (eq === -1) continue;
    const name = item.slice(0, eq);
    let raw = item.slice(eq + 1);
    try {
      raw = decodeURIComponent(raw);
    } catch { /* 非法转义就按原文判断 */ }
    if (name === "lang") {
      lang = uiLanguageOf(raw);
    } else if (name === "session") {
      // 会话 id 只允许 id 本身（`session-<uuid>` 之类），拒绝路径分隔符与 `..`：
      // 这个值会拼进文件路径的过滤条件，不能让它跳出会话目录。
      const id = raw.trim();
      if (/^[A-Za-z0-9._-]+$/.test(id) && id !== "." && id !== "..") sessionId = id;
    }
  }
  return { lang, sessionId };
}

/**
 * API Key 是否能安全地放进 Authorization 头。
 * 凭据存储允许任意文本（多行值也是合法输入），而非法字符会让 undici 把整个
 * Authorization 值写进异常消息——那道消息会一路流到卡片上。
 */
function isUsableKey(value) {
  if (typeof value !== "string") return false;
  const key = value.trim();
  if (key === "") return false;
  // HTTP 头值只允许可见 ASCII（不含空格与控制字符）。
  return /^[\x21-\x7e]+$/.test(key);
}

/** 响应体超限：与"无法解析"同一类问题。 */
class PayloadTooLargeError extends Error {}

/**
 * 汇总求和：只累加有限数字。
 * 缺失 / NaN 一律当 0 —— 汇总行里"某个渠道没读到"不该让整行变成 NaN，
 * 那会让界面显示 `NaN` 而不是"部分缺失"。
 */
function sumOf(rows, key) {
  let total = 0;
  for (const row of rows) {
    const value = row?.[key];
    if (typeof value === "number" && Number.isFinite(value)) total += value;
  }
  return Number(total.toFixed(4));
}

/**
 * 把多个计费类型的金额合成工作区行上的一个 `cost`。
 *
 * 为什么要单独合一次，而不是让界面自己遍历 kinds：
 *   · 跨币种（CNY + USD 同时出现）时不能相加，必须按币种分开给；
 *   · 全是积分型时不该显示 ¥0，要显示"按积分计费"；
 *   · 这些判定与 lib/cost.js 的口径必须一致，界面再实现一遍就会漂移。
 *
 * @param {Array<object>} kinds 已经过 costOfSummary 的类型块
 * @returns {{ currency: string, priced: boolean, asOf: string|null,
 *   amounts: {input:number,cacheRead:number,cacheWrite:number,output:number,total:number}|null,
 *   byCurrency?: Record<string, object> }}
 */
function aggregateWorkspaceCost(kinds) {
  const byCurrency = new Map();
  let anyPriced = false;
  // 免费条目（kind.cost.currency === 'free'）单独计数：它们没有金额、也不属于任何币种，
  // 但"整行都是免费模型"与"这行压根查不到价"是两件事，界面要分别显示「免费」和
  // 「按积分计费」。混算会让一个只用免费模型的会话被说成"按积分计费"。
  let freeKinds = 0;
  let costKinds = 0;
  let asOf = null;
  let asOfMixed = false;
  for (const kind of kinds) {
    const cost = kind?.cost;
    if (cost === null || cost === undefined) continue;
    costKinds += 1;
    if (cost.priced === true) anyPriced = true;
    if (cost.currency === "free") freeKinds += 1;
    const amounts = cost.amounts;
    if (amounts === null || amounts === undefined) continue;
    const currency = typeof cost.currency === "string" ? cost.currency : "unknown";
    if (currency === "free") continue;
    if (!byCurrency.has(currency)) {
      byCurrency.set(currency, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 });
    }
    const bucket = byCurrency.get(currency);
    for (const key of ["input", "cacheRead", "cacheWrite", "output", "total"]) {
      const value = amounts[key];
      if (typeof value === "number" && Number.isFinite(value)) bucket[key] += value;
    }
    // 快照日期：多个类型来自不同快照时不伪造一个日期。
    if (typeof cost.asOf === "string" && cost.asOf !== "") {
      if (asOf === null) asOf = cost.asOf;
      else if (asOf !== cost.asOf) asOfMixed = true;
    }
  }
  const currencies = [...byCurrency.keys()];
  if (currencies.length === 0) {
    // 一个能算的都没有。三种情形必须分开说，不能一律"按积分计费"：
    //   · 有价格表却全缺价 → unknown（该模型暂无定价）；
    //   · 整行都是免费模型 → free（免费是已知结论，不是"不知道"）；
    //   · 免费与无价混在一起 → unknown（不能因为有一部分免费就谎称整行免费）；
    //   · 一个免费都没有 → credit（订阅 / 积分渠道，确实不按钱算）。
    let currency = anyPriced ? "unknown" : "credit";
    if (!anyPriced && freeKinds > 0) currency = freeKinds === costKinds ? "free" : "unknown";
    return { currency, priced: anyPriced, asOf: null, amounts: null };
  }
  const rounded = {};
  for (const [currency, bucket] of byCurrency) {
    rounded[currency] = {
      input: Number(bucket.input.toFixed(4)),
      cacheRead: Number(bucket.cacheRead.toFixed(4)),
      cacheWrite: Number(bucket.cacheWrite.toFixed(4)),
      output: Number(bucket.output.toFixed(4)),
      total: Number(bucket.total.toFixed(4)),
    };
  }
  if (currencies.length === 1) {
    const only = currencies[0];
    return { currency: only, priced: true, asOf: asOfMixed ? null : asOf, amounts: rounded[only] };
  }
  // 跨币种：不能相加，交给界面按币种分别显示。
  return { currency: "mixed", priced: true, asOf: asOfMixed ? null : asOf, amounts: null, byCurrency: rounded };
}

/**
 * 读响应体，超过上限即视为失败。
 *
 * **兼容两种请求体形态**（这是本插件踩过的坑）：
 *
 *   · **Node 的 IncomingMessage**（真宿主给的形状）：`req.headers` 是普通对象
 *     （`req.headers["content-length"]`，不是 `.get()`），没有 `.text()`，但可以
 *     `for await (const chunk of req)` 异步迭代。
 *   · **Response 形态**（测试桩与某些旧宿主）：有 `.text()` 与 `.headers.get()`。
 *
 * 之前这里只认 Response 形态，于是**真宿主上所有 POST 路由都读不到 body**：
 * `req.headers.get` 不存在 → 抛 TypeError → 被当成 413「无法解析」。
 * （真机实测：/token POST 返回 413，/collect POST 返回 502。）
 * 宿主换过形状时，一个插件不该整条 POST 链路瘫掉，所以两种都支持。
 *
 * 超限即失败，且**继续把流读完**：不读完的话 socket 上还留着未消费的字节，
 * 连接会悬在那里（下一个请求可能读到上一段的残留）。
 */
async function readBoundedText(response, limit = MAX_BODY_BYTES) {
  // 形态一：Response 风格（上游 fetch 的响应、测试桩）。
  if (typeof response?.text === "function") {
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > limit) throw new PayloadTooLargeError();
    const text = await response.text();
    // text.length 是 UTF-16 码元数；按字节算才不会让多字节内容绕过上限。
    if (Buffer.byteLength(text, "utf8") > limit) throw new PayloadTooLargeError();
    return text;
  }
  // 形态二：Node IncomingMessage（真宿主的请求体）。
  if (typeof response?.[Symbol.asyncIterator] === "function") {
    const declared = Number(response.headers?.["content-length"]);
    if (Number.isFinite(declared) && declared > limit) throw new PayloadTooLargeError();
    const chunks = [];
    let size = 0;
    let over = false;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > limit) {
        // 超限：不再收进内存，但**继续消费**（否则 socket 上留着未读的字节）。
        over = true;
        continue;
      }
      chunks.push(chunk);
    }
    if (over) throw new PayloadTooLargeError();
    return Buffer.concat(chunks).toString("utf8");
  }
  // 形态三：什么都没有（空 body）。
  return "";
}

/**
 * 一条价格记录 → 响应里的形状。
 *
 * 客户端（lib/client.js 的 PriceEditor）要的是**原始记录**加一个它自己认得的形态
 * 字段 `form`：它按 `uniform` / `input`/`output`/`cacheRead` / `free` 三槽判断行形态，
 * 用 `provider`/`model`/`displayName`/`currency`/`source`/`asOf` 分组、过滤与预填，
 * 用 `mirrors`/`seedSource`/`seedAsOf` 解释「这条原本是什么」。
 *
 * 所以这里**不裁字段**：原样透传存储里的记录，只补一个 `form`（形态判定只有
 * lib/price-store.js 一份实现，这里调用它，不复制规则）。
 */
function priceRecordFor(record) {
  if (record === null || typeof record !== "object") return null;
  return { ...record, form: priceFormOf(record) };
}

/**
 * 整张价格表 → 响应体。
 *
 * 形状是**契约**：客户端只认 `{ok:true, records:[…]}`，别的形状一律按「暂不可用」
 * 处理。所以这里永远是 ok:true + records，哪怕存储坏了（price-store 会回落种子）。
 *
 * 附带三样诊断信息：
 *   · notices —— 机器可读的短标记（store-parse-error / seed-initialized / …）；
 *   · problems —— **读不出来的记录条数（数字）**；
 *   · problemDetails —— 逐条原因（数组）。
 *
 * ⚠️ `problems` 在这里刻意是**数字**而不是 price-store 给的数组：浏览器侧
 *   lib/client.js 的 PriceEditor 读的是 `typeof body.problems === "number"`，数组会被
 *   它当成 0，于是「存储里有 N 条无法解析的记录」这句提示永远不出现。数组的那份改名
 *   叫 problemDetails，并且只带 reason（不带整条 record —— record 已经在 records 里，
 *   再抄一遍等于把整张表在响应里翻倍）。
 */
function priceTableResponse() {
  const table = currentPriceTable();
  const records = Array.isArray(table?.records) ? table.records : [];
  const problems = Array.isArray(table?.problems) ? table.problems : [];
  const notices = Array.isArray(table?.notices) ? table.notices : [];
  return {
    ok: true,
    records: records.map((record) => priceRecordFor(record)).filter((record) => record !== null),
    notices,
    problems: problems.length,
    problemDetails: problems.map((entry) => ({ reason: typeof entry?.reason === "string" ? entry.reason : "" })),
    // 这份数据从哪来：store（用户的存储）/ seed（首次落盘）/ seed-fallback（存储坏了，
    // 回落种子）/ seed-unregistered（种子还没注册）。界面与排查都用得上。
    source: table?.source ?? "seed",
    storePath: table?.storePath ?? null,
    updatedAt: table?.updatedAt ?? null,
    seedCount: SEED_RECORDS.length,
  };
}

/**
 * 把 accounts.js 的取数结果归一成宿主侧的失败分类。
 *
 * 分类键保持 accounts.js 的原始值（empty / shape / unavailable / timeout /
 * network / unauthorized），由调用方按自己的文案表映射：DeepSeek 走
 * DEEPSEEK_CODES（既有 `balance*` 契约），其余提供商走 ACCOUNT_CODES。
 */
function normalizeAccountResult(result) {
  if (result.ok) {
    return {
      ok: true,
      balance: result.balance ?? { isAvailable: null, total: null, currency: null },
      usage: result.usage ?? null,
      code: null,
    };
  }
  return { ok: false, balance: null, usage: null, code: result.code ?? "empty" };
}

/** 通用提供商的失败分类 → MESSAGES 的 `account*` 键。 */
const ACCOUNT_CODES = {
  empty: "accountEmpty",
  shape: "accountPayload",
  unavailable: "accountUnavailable",
  timeout: "accountTimeout",
  network: "accountNetwork",
  unauthorized: "accountTokenExpired",
  // 来自 resolveCredential 的三个分类：没配 / 配了但形状非法。
  noKey: "accountNoKey",
  accountNoKey: "accountNoKey",
  accountNoToken: "accountNoToken",
  badKey: "accountPayload",
};

/** 通用提供商的失败分类 → 用户文案。 */
function accountMessage(msg, code) {
  const key = ACCOUNT_CODES[code];
  if (key === undefined) return msg.accountNetwork;
  const text = msg[key];
  return typeof text === "function" ? text() : text;
}

/**
 * 从凭证服务解析第一个可用的引用值。
 *
 * @returns {{ ok: true, value, ref } | { ok: false, code: 'noKey'|'unusable' }}
 *   noKey = 一个都没配；unusable = 配了但形状不能进 HTTP 头。
 */
async function resolveCredential(ctx, refs) {
  for (const ref of refs) {
    let hit;
    try {
      hit = await ctx.credentials.resolve(credentialRef(ref));
    } catch {
      // 单个引用解析失败（服务异常）不阻断其余引用。
      continue;
    }
    if (hit === undefined) continue;
    const value = typeof hit.value === "string" ? hit.value.trim() : "";
    if (value === "") continue;
    if (!isUsableKey(value)) return { ok: false, code: "unusable" };
    return { ok: true, value, ref };
  }
  return { ok: false, code: "noKey" };
}

/**
 * DSH 账号登录留下的 grant 记录，键是 `<scope>/<id>`。
 *
 * `deepseek-account` 路由不认 DEEPSEEK_API_KEY：宿主把邮箱/设备登录换来的令牌写进
 * 这条记录，请求头是 `x-dsh-auth-token`（Bearer 会被上游 401 拒掉）。记录形状由
 * dsh-deepseek-account-platform 写入，令牌在 `payload.token`。
 *
 * 键名写字面量而不经 `credentialKey()`：记录 API 是较新的凭证服务能力，插件仍声明
 * 兼容更早的宿主（package.json 的 peerDependencies），这里的字符串与宿主写入的键
 * 逐字相同，因此不需要为它提高版本门槛，也不会在旧宿主上链接失败。
 */
const ACCOUNT_GRANT_KEY = "deepseek-account-platform/default";

/**
 * 读 DeepSeek 账号登录的 grant 令牌。
 *
 * @returns {{ ok: true, value: string } | { ok: false, code: 'noKey' | 'unusable' }}
 */
async function resolveAccountGrant(ctx) {
  const readRecord = ctx.credentials?.readRecord;
  if (typeof readRecord !== "function") return { ok: false, code: "noKey" };
  let record;
  try {
    record = await readRecord.call(ctx.credentials, ACCOUNT_GRANT_KEY);
  } catch {
    return { ok: false, code: "noKey" };
  }
  const token = typeof record?.payload?.token === "string" ? record.payload.token.trim() : "";
  if (token === "") return { ok: false, code: "noKey" };
  if (!isUsableKey(token)) return { ok: false, code: "unusable" };
  return { ok: true, value: token };
}

/**
 * 账户快照缓存：同一时间窗内多个请求（多标签页、点击、心跳）共用一次上游调用。
 *
 * 只缓存成功结果——失败必须立刻能被下一次请求重试。缓存与在途请求都按
 * `provider + 引用 + Key` 分桶：换 Key 不命中旧缓存，换 provider 也不会。
 */
const accountCache = new Map();
const accountInFlight = new Map();

/** 丢掉过期的缓存条目：换 Key 频繁时 Map 会一直长。 */
function evictStaleCache(now) {
  for (const [key, entry] of accountCache) {
    if (now - entry.at >= ACCOUNT_CACHE_MS) accountCache.delete(key);
  }
}

/** 让某个 provider 的下一次读取重新打上游（令牌写入后调用）。 */
function invalidateAccount(providerId) {
  const prefix = `${providerId}\u0000`;
  for (const key of accountCache.keys()) {
    if (key.startsWith(prefix)) accountCache.delete(key);
  }
  for (const key of accountInFlight.keys()) {
    if (key.startsWith(prefix)) accountInFlight.delete(key);
  }
}

/** 缓存 + 在途合并的公共路径（只缓存成功结果）。 */
async function cachedRead(ctx, bucket, run, now) {
  evictStaleCache(now);
  const cached = accountCache.get(bucket);
  if (cached !== undefined && now - cached.at < ACCOUNT_CACHE_MS) return cached.value;
  const pending = accountInFlight.get(bucket);
  if (pending !== undefined) return pending;
  const request = run()
    .then((value) => {
      if (value.ok) accountCache.set(bucket, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      accountInFlight.delete(bucket);
    });
  accountInFlight.set(bucket, request);
  return request;
}

/**
 * 取一个提供商的账户读数，带缓存与在途合并。
 *
 * `resolution` 是 lib/providers.js 的解析结果（可选）：精确 id 与用户映射都走
 * 同一条取数路径，`capabilityId` 决定端点与缓存桶，`entry` 决定解析函数，
 * `refs` 是候选凭据引用。
 */
async function readAccountCached(ctx, providerId, resolution = null) {
  const entry = resolution?.entry ?? accountCapabilityOf(providerId);
  const capabilityId = resolution?.capabilityId ?? entry?.id ?? providerId;
  const now = Date.now();
  if (entry === null || entry === undefined || entry.kind === "none") {
    return { kind: "none", reason: entry?.reason ?? "unsupported", ok: false, code: "accountNoApi" };
  }

  // DeepSeek 的端点由 DEEPSEEK_BASE_URL 决定，桶 Key 必须带上它，否则改了覆盖
  // 之后还会命中旧地址的缓存。
  const endpointKey = entry.kind === "balance" && capabilityId.startsWith("deepseek") ? balanceUrl() : "";

  if (entry.kind === "oauth") {
    const spec = oauthProviderOf(capabilityId);
    const resolved = await resolveCredential(ctx, [spec.tokenRef]);
    if (!resolved.ok) {
      return { kind: "oauth", ok: false, code: resolved.code === "noKey" ? "accountNoToken" : "badKey" };
    }
    // Codex 的账号标识是可选请求头：配了就带上，没配也照常查。
    let accountId = "";
    if (spec.accountRef !== undefined) {
      const account = await resolveCredential(ctx, [spec.accountRef]);
      if (account.ok) accountId = account.value;
    }
    const bucket = `${capabilityId}\u0000${resolved.ref}\u0000${resolved.value}\u0000${accountId}`;
    const reader = makeAccountReader({ deepseekUrl: balanceUrl() });
    return cachedRead(ctx, bucket, async () => normalizeAccountResult(await reader.read(entry, resolved.value, { accountId })), now);
  }

  // DeepSeek 的账号路由走宿主登录的 grant，不读环境变量里的 API key。
  if (capabilityId === "deepseek-account") {
    const grant = await resolveAccountGrant(ctx);
    if (!grant.ok) {
      return {
        kind: entry.kind,
        ok: false,
        code: grant.code === "unusable" ? "badKey" : "accountNoGrant",
        // 没登录不是"配错了 Key"，ref 留空，文案由 accountNoGrant 给。
        ref: null,
      };
    }
    const url = accountBalanceUrl();
    const bucket = `${capabilityId}\u0000${url}\u0000${grant.value}`;
    const reader = makeAccountReader({ deepseekUrl: url });
    return cachedRead(ctx, bucket, async () => normalizeAccountResult(await reader.read(entry, grant.value)), now);
  }

  const refs = resolution?.refs ?? candidateRefsOf(capabilityId);
  const resolved = await resolveCredential(ctx, refs);
  if (!resolved.ok) {
    return {
      kind: entry.kind,
      ok: false,
      code: resolved.code === "noKey" ? "accountNoKey" : "badKey",
      ref: resolved.code === "noKey" ? refs[0] : null,
    };
  }
  const bucket = `${capabilityId}\u0000${endpointKey}\u0000${resolved.ref}\u0000${resolved.value}`;
  const reader = makeAccountReader({ deepseekUrl: balanceUrl() });
  return cachedRead(ctx, bucket, async () => normalizeAccountResult(await reader.read(entry, resolved.value)), now);
}

/**
 * DeepSeek 官方余额的失败分类映射。
 *
 * accounts.js 的解析器返回 `empty`/`shape`/`unavailable`，而 DeepSeek 的用户可见
 * 文案（`balanceEmpty`/`balancePayload`/`balanceUnavailable`）是既有契约，逐字保留；
 * 其余分类（timeout / network）与通用文案一致。
 */
const DEEPSEEK_CODES = {
  empty: "balanceEmpty",
  shape: "balancePayload",
  unavailable: "balanceUnavailable",
  timeout: "balanceTimeout",
  network: "balanceNetwork",
  unauthorized: "accountTokenExpired",
};

/**
 * DeepSeek 失败分类 → 用户文案。
 *
 * `noKey` / `accountNoKey` / `badKey` 映射回 DeepSeek 专属说法（指出
 * DEEPSEEK_API_KEY 本身）：它们来自 resolveCredential 的通用分类，
 * 而 DeepSeek 的用户可见文案是既有契约，逐字保留。
 */
function deepSeekMessage(msg, snapshot) {
  if (snapshot.code === "noKey" || snapshot.code === "accountNoKey") return msg.noKey;
  if (snapshot.code === "accountNoGrant") return msg.accountNoGrant;
  if (snapshot.code === "badKey") return msg.badKey;
  const key = DEEPSEEK_CODES[snapshot.code];
  if (key === undefined) return msg.balanceNetwork;
  const text = msg[key];
  return typeof text === "function" ? text() : text;
}

function apply(ctx, config = {}) {
  const bindHost = typeof ctx.webServer?.host === "string" ? ctx.webServer.host : "";

  // 用户映射：把第三方插件注册的 provider id 翻译成受支持提供商的账户口径。
  //
  // 必须在**每次请求**时读取，不能在 apply 时拍快照：`providerAliases` 是
  // volatile 字段，Loader 对「只有 volatile 值变化」的配置更新不会重跑 apply，
  // 而是把新值就地写进这里捕获的引用（cordis-plugin-loader 的 _commitVolatile）。
  // 拍快照会让设置页保存后仍按旧映射查询，直到重启宿主。
  const warned = new Set();
  function providersNow() {
    const { aliases, warnings } = normalizeAliases(config?.providerAliases);
    for (const warning of warnings) {
      if (warned.has(warning)) continue;
      warned.add(warning);
      ctx.logger.warn(`dsh-quota-usage: ${warning}`);
    }
    return createProviderResolver(aliases);
  }

  // ── 采集调度器 ────────────────────────────────────────────────────────
  //
  // 所有上游请求都由这里定时触发，展示侧只读缓存。这是用户的明确要求：
  // 「所有的请求都通过统一的定时任务触发采集并缓存，展示区只读取缓存值」。
  //
  // 三个采集函数各自独立失败：一个渠道/提供商出错不会让另外两类停摆，
  // 也不会把已经采到的旧值擦掉（collector 内部保留 value + 标 stale）。
  const usageScanner = createUsageScanner();
  // 会话级模型解析器：宿主 Node 侧没有会话级模型服务（`agentDefaultModel` 是全局
  // 默认选择），所以从会话日志里读最后用的那个模型。按文件 mtime + size 缓存。
  const sessionModels = createSessionModelResolver();

  /** 积分采集：先问有哪些渠道登录了账号，再逐渠道查余额。 */
  async function collectCredits() {
    const rpc = makeChannelCreditsRpc(ctx);
    if (rpc.available !== true) {
      // connection 服务还没挂上：这不是错误，是"现在问不了"。返回一个明确的
      // 空结果，而不是抛错——抛错会让 lastError 挂在那里，用户以为是查询失败。
      return { available: false, reason: rpc.reason ?? "connectionUnavailable", channels: [] };
    }
    const channels = await listCreditChannels(rpc);
    const rows = await probeChannelCredits(rpc, channels);
    return {
      available: true,
      channels: rows,
      // 汇总一行给卡片直接用，省得客户端再折一遍。
      totals: {
        channels: rows.length,
        ok: rows.filter((row) => row.state === "ok").length,
        remaining: sumOf(rows, "remaining"),
        total: sumOf(rows, "total"),
      },
    };
  }

  /**
   * 预充值型的候选提供商。
   *
   * **为什么是一张固定表、而不是"跟着当前模型走"**：余额是账户维度的属性，不是
   * 路由维度的。用户在这台机器上把对话模型切成 trae（一个既非充值也非订阅的免费
   * 渠道）之后，旧的实现直接把 `balance` 返回成 null —— 可 DeepSeek 的余额一分
   * 没少、接口一直能读。用户看到的却是"充值型的数据没了"。余额跟"我现在用哪个
   * 模型说话"没有任何关系，所以这里按**有没有凭据**枚举，不按当前模型筛。
   *
   * 只列能力表里 `kind: 'balance'` 的三家 + DeepSeek 的两条路由。OAuth 订阅型
   * （anthropic / openai-codex）与用量型（kimi-coding / opencode / minimax …）
   * 不在其中：它们没有余额接口，混进来会多出几行必然失败的"未配置"。
   */
  const PREPAID_CANDIDATES = [
    "deepseek-official",
    "deepseek-account",
    "moonshotai",
    "zai",
    "openrouter",
  ];

  /**
   * 订阅型的候选提供商（independent 模式用）。
   *
   * 取自 `oauthProviderIds()`（能力表里 kind: 'oauth' 的全集），不写死：新增一家
   * OAuth 订阅源时这里自动跟上，不用改两处。
   */
  function subscriptionCandidates() {
    return oauthProviderIds();
  }

  /**
   * 一条预充值读数。
   *
   * `ok:false` 的行也保留在数组里：哪个提供商没配 Key、哪个配了但接口挂了，是
   * 两种不同的状态，界面要能分开说。但 `noKey` 的行**在采集阶段就被丢掉**了
   * （见 collectPrepaid），因为"这台机器上根本没有这家"不是读数，不该占一行。
   */
  async function readPrepaidOf(capabilityId) {
    const resolution = providersNow().resolve(capabilityId);
    const entry = resolution?.entry ?? null;
    if (entry === null || entry.kind !== "balance") {
      return { provider: capabilityId, displayName: capabilityId, kind: entry?.kind ?? "none", ok: false, code: "accountNoApi", balance: null, used: null };
    }
    const snapshot = await readAccountCached(ctx, capabilityId, resolution);
    return {
      provider: capabilityId,
      displayName: entry.displayName ?? capabilityId,
      kind: entry.kind,
      balance: snapshot.balance ?? null,
      ok: snapshot.ok === true,
      code: snapshot.ok === true ? null : snapshot.code ?? null,
    };
  }

  /**
   * 预充值采集：枚举**所有有凭据的**提供商，逐个查余额，各自独立失败。
   *
   * 与旧实现的差别（这是用户报的根因之一）：旧的不看凭据，只看当前模型路由；
   * 新的不看当前模型，只看凭据。用 `resolveCredential` 先探一次凭据再决定要不要
   * 打上游请求 —— 没有 Key 的提供商一次 HTTP 都不发，也就不可能因为"没配 Key"
   * 而往数组里塞五行错误。
   *
   * 单个提供商失败（超时 / 401 / 形状不认）**不影响**其它提供商：循环里 try/catch
   * 把异常转成一条 `ok:false` 的行，而不是让整轮采集抛出去——抛出去会让 collector
   * 把上次成功的整份数组丢掉，用户看到的是"充值数据又没了"。
   */
  async function collectPrepaid() {
    const providers = [];
    const skipped = [];
    for (const capabilityId of PREPAID_CANDIDATES) {
      // 先看凭据：`deepseek-account` 走宿主登录 grant，不读 API Key，单独判。
      if (capabilityId === "deepseek-account") {
        const grant = await resolveAccountGrant(ctx);
        if (!grant.ok) {
          skipped.push({ provider: capabilityId, reason: grant.code === "unusable" ? "badKey" : "accountNoGrant" });
          continue;
        }
      } else {
        const refs = candidateRefsOf(capabilityId);
        const resolved = await resolveCredential(ctx, refs);
        if (!resolved.ok) {
          skipped.push({ provider: capabilityId, reason: resolved.code === "noKey" ? "accountNoKey" : "badKey" });
          continue;
        }
      }
      try {
        providers.push(await readPrepaidOf(capabilityId));
      } catch (error) {
        // 采集函数不该因为一家厂商抛错就中断：把它降级成一条读数行。
        providers.push({
          provider: capabilityId,
          displayName: capabilityId,
          kind: "balance",
          balance: null,
          ok: false,
          code: "network",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      // 空数组 = 这台机器上一个预充值账户都没配。界面据此不渲染「充值」分区，
      // 而不是渲染一个空壳。
      providers,
      // 跳过的（没凭据的）单独列出来，供设置页/诊断用；不参与展示分区的存在性判断。
      skipped,
      totals: {
        configured: providers.length + skipped.length,
        ok: providers.filter((row) => row.ok === true).length,
      },
    };
  }

  /**
   * 给一条订阅读数补上展示名。
   *
   * `lib/subscription.js` 的返回形状里只有 `provider`（路由 id），没有给人看的
   * 名字——它是给单provider 场景写的。现在结果是一个数组、可能有多组，界面必须
   * 能说清"这一组是谁"，所以在这里按能力表补 `displayName`；能力表里没有的
   * （未知路由）原样用 id，不猜。
   */
  function withSubscriptionLabel(row) {
    const entry = accountCapabilityOf(row?.provider);
    return {
      ...row,
      displayName: typeof entry?.displayName === "string" && entry.displayName !== ""
        ? entry.displayName
        : (typeof row?.provider === "string" ? row.provider : ""),
      // 归一后的能力 id：同一份订阅在能力表里叫 `openai-codex`，而账户路由可能叫
      // `codex-chatgpt`（第三方插件注册的 id）。展示侧要判断"这条订阅是不是当前
      // provider 的那一份"，唯一稳定的判据就是这个字段——两边各写一份别名表必然
      // 漂移（一方加了 `codex-chatgpt`、另一方没加，界面就永远匹配不上）。
      capability: canonicalProviderId(row?.provider),
    };
  }

  /**
   * 多账号池里"该拿来当账户读数"的那个账号。
   *
   * 每个账号的用量是**分开**的，而顶层 `windows` 只有一个位置。取哪一个决定了
   * 侧边栏显示的是谁的额度，所以这个函数的**失败方式**比它成功时更重要：
   *
   *   · `activeAccountId` 存在且那个账号有窗口 → 就是它（这是正常路径）；
   *   · `activeAccountId` 存在但那个账号**这次没取到窗口** → 返回 `missing`
   *     状态，**绝不退到别的账号**。理由：退过去就等于拿 B 账号的剩余量冒充
   *     "你正在用的那个还剩多少"——A 可能已经耗尽了，用户却看到一个宽裕的数。
   *     这才是真正的误导，比"读不到"糟得多；
   *   · 没有 `activeAccountId`（单账号形态、或宿主没给池信息）→ 才退到第一个
   *     有窗口的账号，并明确标 `source: 'only-account'`，让上层知道这不是
   *     "按活跃账号选出来的"，而是"这台机器上只有这一个账号有数"。
   *
   * 为什么不能直接 `accounts.find(a => a.windows)`：那是"数组里第一个有数的账号"，
   * 与"正在用的账号"没有关系。实测这台机器上 accounts[0] 是 5h 已用 0% / 7d 已用
   * 100%（几乎耗尽、备用号），`activeAccountId` 指的是 accounts[1]（10% / 17%）。
   *
   * @returns {{ status: 'ok', account: object, source: 'active'|'only-account' }
   *          | { status: 'missing', activeId: string }
   *          | { status: 'none' }}
   */
  function accountRowOf(row) {
    if (row === null || typeof row !== "object") return { status: "none" };
    const accounts = Array.isArray(row.accounts) ? row.accounts : [];
    const usable = (account) => account !== null && typeof account === "object"
      && Array.isArray(account.windows) && account.windows.length > 0;
    const activeId = typeof row.activeAccountId === "string" && row.activeAccountId !== ""
      ? row.activeAccountId
      : null;
    if (activeId !== null) {
      const active = accounts.find((account) => account !== null && typeof account === "object"
        && account.id === activeId);
      // 活跃账号在池里、且有窗口：正常路径。
      if (active !== undefined && usable(active)) {
        return { status: "ok", account: active, source: "active" };
      }
      // 活跃账号在池里但没有窗口：它这次没取到用量。**不借别人的数。**
      return { status: "missing", activeId };
    }
    const first = accounts.find(usable);
    if (first !== undefined) return { status: "ok", account: first, source: "only-account" };
    return { status: "none" };
  }

  /**
   * 该账号的窗口数组。
   *
   * 活跃账号缺数据时返回**空数组**（而不是别的账号的窗口）——调用方据此报
   * "未取到用量"。单账号形态（没有 accounts 数组）时退回顶层 `windows`：
   * 那种形状下"活跃账号"这个概念不存在，顶层就是唯一读数。
   */
  function activeWindowsOf(row) {
    const picked = accountRowOf(row);
    if (picked.status === "ok") return picked.account.windows;
    if (picked.status === "missing") return [];
    return row !== null && typeof row === "object" && Array.isArray(row.windows) ? row.windows : [];
  }

  /** 该账号的 id / 别名（收起态要能说清"这是哪个账号的额度"）。 */
  function activeAccountOf(row) {
    const picked = accountRowOf(row);
    if (picked.status !== "ok") return null;
    return {
      id: typeof picked.account.id === "string" ? picked.account.id : null,
      alias: typeof picked.account.alias === "string" && picked.account.alias !== "" ? picked.account.alias : null,
    };
  }

  /**
   * 订阅快照里属于某个 capability 的那条读数（含窗口）。
   *
   * 用途：当前 provider 是**第三方插件注册的订阅路由**（如 `codex-chatgpt`）时，
   * 那条路由自己没有任何可查端点——本插件拿不到它的令牌，也不需要：额度早就由
   * 那个插件采到、并被本插件的订阅采集归一进快照了（`provider: 'openai-codex'`）。
   * 这里按 canonical id 把它找回来，喂给 `/api/quota-usage` 的 `usage`。
   *
   * 只认 `ok: true` 且有窗口的行：失败行、未登录行、没有窗口的行都不能冒充读数
   * （`reading` 为 null，调用方按"确实没有"处理，不编数字）。
   *
   * `state` 把"读不到"拆成四种，因为它们的处置方式完全不同：
   *   · `not-collected` —— 快照 `value === null`，采集器还没跑过一轮。首轮由第一次
   *     读快照时在后台垫（见 apply 里的 bootstrapOnce），这期间空白是正常的，
   *     报一条错误就是假故障（那正是 bootstrapOnce 注释里说的"白白往 lastError
   *     里写一条假故障"）；
   *   · `no-row` —— 采过了，但快照里没有这条 capability 的订阅行（这台机器上
   *     根本没登录这个订阅）。该如实说；
   *   · `active-missing` —— 有这一行，但 `activeAccountId` 指向的账号**这次没取到
   *     窗口**。这时**绝不退到别的账号**：拿 B 账号的剩余量冒充"你正在用的那个还剩
   *     多少"，会让一个已经耗尽的账号看起来宽裕，比"读不到"糟得多。要单独报出来，
   *     并说清是哪个账号缺数据；
   *   · `ok` —— 正常拿到窗口。
   *
   * @returns {{ state: 'not-collected'|'no-row'|'active-missing'|'ok',
   *            reading: object|null, activeId?: string }}
   */
  function subscriptionReadingOf(capabilityId, getSnapshot) {
    const snapshot = typeof getSnapshot === "function" ? getSnapshot("subscription") : null;
    const value = snapshot !== null && typeof snapshot === "object" ? snapshot.value : null;
    if (value === null || typeof value !== "object") return { state: "not-collected", reading: null };
    const rows = Array.isArray(value.subscriptions) ? value.subscriptions : [];
    for (const row of rows) {
      if (row === null || typeof row !== "object") continue;
      if (row.ok !== true) continue;
      if (canonicalProviderId(row.provider) !== capabilityId) continue;
      const picked = accountRowOf(row);
      if (picked.status === "missing") {
        // 活跃账号缺数据：记下来，别继续往下找"别的账号"。
        return { state: "active-missing", reading: null, activeId: picked.activeId };
      }
      const windows = picked.status === "ok" ? picked.account.windows : activeWindowsOf(row);
      if (windows.length === 0) return { state: "active-missing", reading: null, activeId: null };
      return {
        state: "ok",
        reading: {
          windows,
          plan: typeof row.plan === "string" && row.plan !== "" ? row.plan : null,
          account: activeAccountOf(row),
          // 这组窗口是"按活跃账号选的"还是"这台机器上只有一个账号有数"。
          // 界面据此决定要不要写"账号：xxx"——单账号没有别名可写，不编。
          accountSource: picked.status === "ok" ? picked.source : "only-account",
          // 数据来自哪个来源：plugin = 第三方订阅插件采到的快照。
          mode: typeof row.mode === "string" && row.mode !== "" ? row.mode : "plugin",
        },
      };
    }
    return { state: "no-row", reading: null };
  }

  /**
   * 一个账号的窗口数组（宿主原始形状 → 界面认识的 `{ key, percent, resetsAt }`）。
   *
   * 为什么不自己写一遍时长分档：`lib/subscription.js` 的 `normalizePluginQuota`
   * 已经把"分钟 → `5h` / `7d` / `30d` / `cycle`"这套映射写死了，而 independent
   * 那条路（`lib/accounts.js`）用的是同一批 key。这里另写一份，两条路的分档规则
   * 会各自漂移——同一个 5 小时窗口在一个来源叫 `5h`、在另一个叫 `300m`，界面就
   * 得为同一种数据准备两套本地化。
   *
   * **单位差一个数量级**（实测，别想当然）：账号级的 `quota.windows[].resetsAt`
   * 是 **epoch 毫秒**（1794676065000），而聚合桶 `value.quota.buckets[].windows[]`
   * 的同一字段是 **epoch 秒**（1794676065）。`normalizePluginQuota` 按秒乘 1000
   * 还原成毫秒，所以这里先把它折回秒再交出去，否则界面上的重置时间会跑到几万年
   * 之后。判定用数量级（> 1e11 必然是毫秒：1e11 秒是公元 5138 年，1e11 毫秒
   * 是 1973 年），不靠"有没有就乘"这种猜测。
   */
  function accountWindowsOf(quota) {
    if (quota === null || typeof quota !== "object") return null;
    const raw = Array.isArray(quota.windows) ? quota.windows : [];
    if (raw.length === 0) return null;
    const synthesized = {
      windows: raw.map((entry) => {
        if (entry === null || typeof entry !== "object") return entry;
        const resetsAt = typeof entry.resetsAt === "number" && Number.isFinite(entry.resetsAt)
          ? entry.resetsAt
          : null;
        return {
          ...entry,
          resetsAt: resetsAt !== null && resetsAt > 1e11 ? Math.floor(resetsAt / 1000) : resetsAt,
        };
      }),
    };
    // bucketId 用一个不可能的 id：`normalizePluginQuota` 找不到就退到"第一个带
    // 窗口的桶"，而我们只塞了一个桶，所以它必然选中它。
    const normalized = normalizePluginQuota({ buckets: [{ id: "__account__", ...synthesized }] }, {
      bucketId: "__account__",
    });
    if (normalized === null || normalized.windows.length === 0) return null;
    return normalized.windows;
  }

  /**
   * 这个路由 id 是不是「别人注册的别名」。
   *
   * `codex-chatgpt` / `chatgpt-codex` 都归一成 `openai-codex`——它们是第三方插件
   * 注册的路由，令牌由**那个插件自己**登录并保管（DPAPI 加密的 pool 文件），
   * 本插件的凭证服务里不会有 `DSH_USAGE_CODEX_OAUTH_TOKEN`。
   *
   * 所以别名路由上「尚未填写该提供商的 OAuth 令牌」是一句**误导**：它让用户去填
   * 一个他既没有、也不需要的东西。真正常态是"额度由那个插件采，本插件读快照"。
   */
  function isAliasRoute(providerId) {
    const raw = typeof providerId === "string" ? providerId.trim().toLowerCase() : "";
    if (raw === "") return false;
    return canonicalProviderId(raw) !== raw;
  }

  function subscriptionFailureRow(provider, error, extra = {}) {
    return withSubscriptionLabel({
      ok: false,
      mode: "plugin",
      provider,
      accounts: [],
      windows: [],
      plan: null,
      error,
      ...extra,
    });
  }

  /**
   * 多账号池型订阅：读 `dsh-chatgpt-subscription` 的 `/status`，把
   * `value.accounts[]` 映射成**账号数组**。
   *
   * 为什么不用 `readPluginSubscriptionUsage`：它只读 `value.quota`——那是"当前
   * 活跃账号"的**聚合副本**，一个账号池会被压成一行。用户的要求是"每个账号一行"，
   * 而这台机器上真实存在两个账号（ruchong@live.cn 有 quota，
   * ruchonggg@gmail.com 的 `quota` 是 undefined）。
   *
   * 与聚合桶的关系不是替代而是并列：账号级读到了就用账号级（更细），读不到就
   * 由调用方退回聚合那一份（保证"至少还有数"）。
   *
   * `lib/subscription.js` 不动：这条路复用它导出的 `pluginOrigin` /
   * `PLUGIN_STATUS_PATH` / `normalizePluginQuota`，没有第二套 HTTP 与解析规则。
   */
  async function readCodexAccountPool(provider = "openai-codex") {
    const base = pluginOrigin(ctx);
    if (base === null) return { ok: false, error: "pluginUnavailable", accounts: [] };

    let response;
    try {
      response = await fetch(`${base}${PLUGIN_STATUS_PATH}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // 连接被拒 / 超时：路由未注册与服务没起来在宿主侧无法区分，统一按不可用。
      return { ok: false, error: "pluginUnavailable", accounts: [] };
    }
    if (response.status === 404) return { ok: false, error: "pluginUnavailable", accounts: [] };
    if (!(response.status >= 200 && response.status < 300)) {
      return { ok: false, error: "pluginUnavailable", accounts: [], status: response.status };
    }

    let body;
    try {
      body = JSON.parse(await response.text());
    } catch {
      return { ok: false, error: "pluginShape", accounts: [] };
    }
    if (body === null || typeof body !== "object") {
      return { ok: false, error: "pluginShape", accounts: [] };
    }
    if (body.ok === false) return { ok: false, error: "pluginError", accounts: [] };
    const value = body.value;
    if (value === null || typeof value !== "object") {
      return { ok: false, error: "pluginShape", accounts: [] };
    }
    // 它那边没登录 ChatGPT：是"确实查不到"而不是"插件坏了"，与聚合那条路同一个
    // 判定（分开报，用户才知道该去它的设置页登录）。
    const quotaState = value.quota !== null && typeof value.quota === "object"
      ? value.quota.state
      : null;
    if (quotaState === "signed-out") {
      return { ok: false, error: "pluginSignedOut", accounts: [] };
    }

    const list = Array.isArray(value.accounts) ? value.accounts : [];
    if (list.length === 0) {
      // 没给账号数组：多账号这条路不存在（可能它降级成单账号模式了）。
      // 不猜，让调用方退回聚合那一份。
      return { ok: false, error: "pluginNoAccounts", accounts: [] };
    }

    const accounts = [];
    for (const [index, entry] of list.entries()) {
      if (entry === null || typeof entry !== "object") continue;
      const windows = accountWindowsOf(entry.quota);
      const id = typeof entry.id === "string" && entry.id !== ""
        ? entry.id
        : (typeof entry.accountId === "string" && entry.accountId !== "" ? entry.accountId : `account-${index}`);
      accounts.push({
        id,
        // alias 是给人看的邮箱；没有就 null，界面回退到 provider 名——绝不编一个
        // "账号 1" 出来，那会和真实的账号混在一起分不清。
        alias: typeof entry.alias === "string" && entry.alias !== ""
          ? entry.alias
          : (typeof entry.email === "string" && entry.email !== "" ? entry.email : null),
        plan: typeof entry.planLabel === "string" && entry.planLabel !== "" ? entry.planLabel : null,
        // active 的含义是"**这台机器上取到了这个账号的用量**"，不是"它是不是默认
        // 账号"（`activeAccountId` 实测指向的正是那个没有 quota 的账号，按它判会把
        // 有数的账号标成非活跃）。没有 windows 就是没取到，界面显示「未取用量」。
        active: windows !== null,
        // null = 未取用量（不是 0%）。这里绝不用 0 填坑：0% 是"额度用完"的真实
        // 读数，与"没去查"是两件完全不同的事。
        windows,
      });
    }
    if (accounts.length === 0) return { ok: false, error: "pluginShape", accounts: [] };

    return {
      ok: true,
      error: null,
      accounts,
      // 顶层套餐：所有账号套餐一致时用那个（这台机器上两个都是 plus，标题写
      // `OpenAI Codex · plus` 是准确的）；不一致或缺失时给 null，不挑一个冒充
      // 整个池的套餐——各账号自己那行已经分别写了自己的 plan。
      plan: uniformPlanOf(accounts),
      activeAccountId: typeof value.activeAccountId === "string" ? value.activeAccountId : null,
    };
  }

  /** 所有账号的 plan 相同且非空时返回它，否则 null（不拿第一个冒充全体）。 */
  function uniformPlanOf(accounts) {
    const plans = accounts.map((row) => row.plan);
    if (plans.length === 0) return null;
    const first = plans[0];
    if (first === null) return null;
    return plans.every((plan) => plan === first) ? first : null;
  }

  /**
   * 单令牌型订阅（anthropic / kimi-coding / opencode / minimax …）：
   * 一个凭据 = 一个账号，没有账号数组。
   *
   * 统一成"一个账号"的形态，是为了让界面只有一套渲染逻辑：订阅分区永远遍历
   * `accounts[]`，多账号池与单令牌的差别只在数组长度上，不在代码分支里。
   * `alias: null` 是刻意的——这类提供商没有任何邮箱/别名可取，界面回退到
   * provider 名，比编一个假账号名诚实。
   */
  function singleAccountOf(row) {
    if (row === null || typeof row !== "object") return [];
    const windows = Array.isArray(row.windows) && row.windows.length > 0 ? row.windows : null;
    return [{
      id: "default",
      alias: null,
      plan: typeof row.plan === "string" && row.plan !== "" ? row.plan : null,
      active: windows !== null,
      windows,
    }];
  }

  /**
   * 订阅采集：枚举**所有可用来源**，不跟当前模型走。
   *
   * 这是用户报的第二个根因：旧实现用 `agentDefaultModel` 的 provider 当订阅源，
   * 当前模型是 trae 时它既不在 OAuth 能力表里、也不是 dsh-chatgpt-subscription 的
   * 目标，于是永远 `unsupportedProvider`——而凭据其实早就登录好了。
   *
   * 取数顺序（任务里选的"更简单替代方案"，不动 lib/subscription.js）：
   *   1. **多账号池优先**：`readCodexAccountPool` 读 `/status` 的 `value.accounts[]`。
   *      这是用户"每个账号一行"诉求的落点——一个账号池里每个账号的用量是**分开
   *      的**（活跃的那个有 windows，其余 `quota` 缺失），聚合桶会把它压成一行。
   *      账号池读到了就用它；读不到（路由不可达 / 没给数组 / 都为空）再往下走。
   *   2. **plugin 聚合**：`readPluginSubscriptionUsage` 只读 `value.quota`（活跃
   *      账号的聚合副本）。它自己会探宿主 origin、认 404 / 未登录 / 形状不认，
   *      失败时明确回 `ok:false` 带 `error`。这一步是账号池失败时的兜底，保证
   *      "至少还有一条数"，不会被一次形状变化整段清零。
   *   3. **independent 兜底**：逐个 OAuth 提供商，**先看令牌在不在**——没配令牌
   *      的提供商一次请求都不发（否则数组里全是"未填写令牌"的噪声行），配了才查。
   *      各家独立失败，一个挂了不影响另一个。它们各是"单令牌型"，一个凭据就是一个
   *      账号，映射成单元素 `accounts[]`（见 singleAccountOf）。
   *
   * 每条来源都带 `accounts[]`，界面因此只有一套渲染逻辑：订阅分区永远遍历账号，
   * 多账号池与单令牌的差别只在数组长度上。
   *
   * 顶层 `mode` 说明主路是哪一条。
   *
   * 关于 `subscriptionMode` 配置：schema 给了 `.default("independent")`，所以从
   * config 里读到的 `'independent'` **无法区分**"用户明确选的"和"没选过走的默认
   * 值"。用户的诉求是"插件可达时自动用 plugin"，因此这里按 plugin 优先探测；
   * 用户显式配成 `'plugin'` 时同样先试 plugin，且失败时**只报它自己的失败原因**，
   * 不偷偷换成 independent 冒充成功（保留 subscription.js 原来那条"不静默回退"
   * 的语义）。
   */
  async function collectSubscription() {
    const configured = resolveSubscriptionMode(config?.subscriptionMode);
    const subscriptions = [];
    const skipped = [];

    // 1. 多账号池（**无论配置写的是什么**：默认值 'independent' 与用户显式选的
    //    'independent' 在 config 上无法区分，两者都先试 plugin 这条路；显式选
    //    'plugin' 时下面会严格只走它）。
    const pool = await readCodexAccountPool("openai-codex");

    // 2. 聚合那份只在"账号池没读到"时才去问：它不是更好的数据，而是更粗的一份，
    //    多问一次就多一次对上游的请求（它对同一端点做了 60s 缓存，但我们没必要
    //    为了一个已知会更差的形状去打它）。
    let pluginRow = null;
    if (pool.ok !== true) {
      pluginRow = await readPluginSubscriptionUsage({
        ctx,
        provider: "openai-codex",
        timeoutMs: TIMEOUT_MS,
      });
    }

    const pluginSucceeded = pool.ok === true || (pluginRow !== null && pluginRow.ok === true);

    if (pool.ok === true) {
      // 账号级数据：每个账号一行，`windows: null` 表示未取用量。
      subscriptions.push(withSubscriptionLabel({
        ok: true,
        mode: "plugin",
        provider: "openai-codex",
        accounts: pool.accounts,
        // 顶层 windows 保留**活跃账号**的那一份：别的消费方（本文件的
        // `/api/quota-usage`、判据脚本、以后的摘要行）按单条读数取 windows 时
        // 仍然有数，不必为账号形态重写一遍。
        //
        // 这里曾经写的是 `accounts.find(a => Array.isArray(a.windows))`——那是
        // "数组里第一个有数的账号"，与"正在用的账号"无关。实测 accounts[0] 是
        // 7d 已用 100% 的那个（已弃用），`activeAccountId` 指的却是 accounts[1]，
        // 于是顶层读数把"另一个账号用完了"当成用户当前的额度。改用
        // activeWindowsOf（优先 activeAccountId，退到第一个有窗口的账号）。
        windows: activeWindowsOf({ accounts: pool.accounts, activeAccountId: pool.activeAccountId }),
        plan: pool.plan,
        activeAccountId: pool.activeAccountId,
        // 当前活跃账号是谁（id + 邮箱别名）：展示侧要在收缩态说清"这是哪个账号"。
        activeAccount: activeAccountOf({ accounts: pool.accounts, activeAccountId: pool.activeAccountId }),
      }));
    } else if (pluginRow !== null && pluginRow.ok === true) {
      // 兜底：聚合桶 → 单账号。`ok:true` 但多账号那条路给了明确失败原因时，
      // 原因写进 `poolError`，界面能解释"为什么只看到一个账号"。
      subscriptions.push(withSubscriptionLabel({
        ...pluginRow,
        accounts: singleAccountOf(pluginRow),
        ...(pool.error === undefined ? {} : { poolError: pool.error }),
      }));
    }

    // 显式选了 plugin 却拿不到：只报它自己的失败原因，不换路。
    if (configured === "plugin") {
      if (!pluginSucceeded) {
        const row = pluginRow !== null && pluginRow.ok !== true
          ? pluginRow
          : subscriptionFailureRow("openai-codex", pool.error ?? "pluginUnavailable");
        subscriptions.push(withSubscriptionLabel(row));
      }
      return {
        mode: "plugin",
        subscriptions,
        skipped,
        // 明确写出主路是哪条，界面据此显示"读的是哪个来源"。
        primary: subscriptions.length > 0 ? "plugin" : null,
      };
    }

    // 3. independent 兜底：只查真的配了令牌的提供商。
    for (const provider of subscriptionCandidates()) {
      const spec = oauthProviderOf(provider);
      if (spec === null) continue;
      const token = await resolveCredential(ctx, [spec.tokenRef]);
      if (!token.ok) {
        // 没配令牌不是读数，不占一行——与预充值那边"没 Key 就跳过"同一口径。
        skipped.push({ provider, reason: token.code === "noKey" ? "accountNoToken" : "badKey" });
        continue;
      }
      try {
        const row = await readIndependentSubscriptionUsage({ ctx, provider, timeoutMs: TIMEOUT_MS });
        // 单令牌型：一个凭据就是一个账号，统一成单元素账号数组。
        subscriptions.push(withSubscriptionLabel({ ...row, accounts: singleAccountOf(row) }));
      } catch (error) {
        subscriptions.push({
          ok: false,
          mode: "independent",
          provider,
          displayName: accountCapabilityOf(provider)?.displayName ?? provider,
          windows: [],
          accounts: [],
          plan: null,
          error: "network",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 主路：账号池或聚合拿到了就是 plugin，否则 independent（哪怕 independent
    // 也没数据，那说明这台机器确实没有可读的订阅源，数组会是空的）。
    const primary = pluginSucceeded ? "plugin" : "independent";
    return { mode: primary, subscriptions, skipped, primary };
  }

  const collectIntervals = config?.collectIntervals ?? {};
  const collector = createCollector({
    intervals: {
      credits: normalizeInterval(collectIntervals.credits).ms,
      prepaid: normalizeInterval(collectIntervals.prepaid).ms,
      subscription: normalizeInterval(collectIntervals.subscription).ms,
    },
    collectors: {
      credits: collectCredits,
      prepaid: collectPrepaid,
      subscription: collectSubscription,
    },
    log: (line) => ctx.logger.warn(`dsh-quota-usage: ${line}`),
  });

  ctx.effect(
    () => {
      collector.start();
      return () => collector.stop();
    },
    "dsh-quota-usage: collector timers",
  );

  // 首轮采集**不在 apply 里触发**，而是由第一个来读快照的请求顺带"补一次"。
  //
  // 为什么不在 apply 里直接 collectNow()：
  //   · apply 期间 connection / webServer 可能还没挂全，采集必然失败一轮，白白
  //     往 lastError 里写一条假故障；
  //   · 副作用发生在插件加载路径上，谁 import 这个模块就会触发一次对上游的请求，
  //     包括测试、包括只想读配置的场景。
  // 代价是首屏会短暂为空。所以加一个"首次读取时垫一轮"的闸门：读快照时如果某一类
  // 从未采过（value === null 且 attemptedAt === null），就在后台补一次，并立刻
  // 返回当前（空）快照。补的那轮不阻塞响应，也不改变定时节奏。
  let bootstrapped = false;
  function bootstrapOnce() {
    if (bootstrapped) return;
    bootstrapped = true;
    void collector.collectNow();
  }

  // ── 用量统计：后台预计算 ──────────────────────────────────────────────
  //
  // 用户的要求：「统计改成后台提前算，打开统计页只读缓存，不再等打开时才扫日志」。
  //
  // 形状与采集调度器完全一致（见 lib/collector.js 的模块注释）：定时器负责算，
  // 路由只读。区别只是被算的东西是会话日志而不是上游账户接口，所以缓存键是动态的
  // （全机 / 工作区 / 每个会话一个桶）——这就是它单独一个模块而不是塞进 collector 的原因。
  //
  // 金额（costOfSummary）在**预计算时**就算好并随结果一起缓存：它是纯函数，与请求
  // 时刻无关（价格表可能被用户改，那一轮会在下一次预计算时反映出来）。放在请求路径上
  // 算等于每次打开都把几十个类型块重新查一遍价表，与"只读缓存"的精神不符。
  const statsCache = createStatsCache({
    intervalMs: collectIntervals.stats,
    computeMachine: async () => {
      const summary = await usageScanner.scan();
      const atMs = Date.now();
      return { ...summary, kinds: summary.kinds.map((kind) => costOfSummary(kind, atMs) ?? kind) };
    },
    computeWorkspace: async () => {
      const workspaces = await scanWorkspaces({ scanner: usageScanner });
      const atMs = Date.now();
      // 每个工作区把它的 kinds 逐个过 costOfSummary（与 usage 分支同一套口径），
      // 再把三级金额汇总成一个 cost 挂在行上，界面不必自己重新累加。
      return workspaces.map((row) => {
        const kinds = Array.isArray(row.kinds)
          ? row.kinds.map((kind) => costOfSummary(kind, atMs) ?? kind)
          : [];
        return { ...row, kinds, cost: aggregateWorkspaceCost(kinds) };
      });
    },
    computeSession: async (sessionId) => {
      const summary = await usageScanner.scanSession(sessionId);
      const atMs = Date.now();
      return { ...summary, kinds: summary.kinds.map((kind) => costOfSummary(kind, atMs) ?? kind) };
    },
    // 指纹只 stat，不解压：用来判断"日志比缓存新"（判 stale 的唯一数据依据）。
    signature: (sessionId) => usageScanner.signature(sessionId ?? ""),
    log: (line) => ctx.logger.warn(`dsh-quota-usage: ${line}`),
  });
  // 会话集合：全机统计的输出被匿名化了（没有会话 id），所以单独枚举一次目录。
  // 只列目录名、不读文件内容——它每轮预计算跑一次，不能有解析代价。
  statsCache.setSessionEnumerator(() => listSessionIds());

  // ── 后台预计算的开关 ──────────────────────────────────────────────────
  //
  // 预计算会读真实会话目录。对"只想验证别的行为"的用例（canonical 化、账户回落、
  // 路由围栏那些）来说，一次全库扫描纯属噪声：既拖慢用例，又会在断言中间插进一个
  // 后台任务，让"这一次到底谁写的缓存"变得不可推理。
  //
  // 所以留一个**窄口**：`DSH_QUOTA_USAGE_STATS_AUTOSTART=0` 时不排定时器、闸门也不
  // 垫底——统计路由退化成"永远 computing"，直到有人显式 POST。这只影响后台行为，
  // 读取与显式刷新照旧可用。生产路径不设这个变量，默认行为完全不变。
  //
  // 历史：这里曾写着"十几个用例各 apply 一次，叠加起来能把测试进程撑到 OOM"——
  // 那是扫描器还缓存完整事件数组时的现象（2026-11 内存事故，见 lib/usage.js 文件头）。
  // 扫描改为流式解析、缓存全部落盘（`$DSH_HOME/storages/dsh-quota-usage/usage-cache/`）
  // 之后堆内零驻留，此开关保留的意义是测试的确定性与隔离（不读真实会话目录、
  // 不排后台定时器），不再是内存止血阀。
  //
  // 读**模块级常量**而不是每次 apply 现读：同一进程里多个 ctx 应该看到同一个结论
  // （否则一半实例排了定时器、一半没排，诊断时无法解释）。
  const statsAutostart = STATS_AUTOSTART;

  ctx.effect(
    () => {
      if (!statsAutostart) return () => {};
      statsCache.start();
      return () => statsCache.stop();
    },
    "dsh-quota-usage: stats precompute timers",
  );

  // 首轮预热：**在第一次读统计路由时垫一轮，但不在请求里做**。
  //
  // 为什么不干脆在 apply 里 void refresh()：
  //   · apply 期间会话目录可能还不可读，那一轮必然失败，白写一条 lastError；
  //   · 副作用范围太大——任何只是装载插件但从不打开统计页的场景都会被拖去扫全库。
  //
  // 所以用闸门：第一次 GET 到达时**在后台**垫一轮（`void`，不 await），响应立刻
  // 按 `state: 'computing'` 返回。请求路径上**仍然一次扫描都没有**——那次扫描是
  // 闸门触发的后台任务，与这次请求的处理无关，只是恰好被它叫醒。
  // 闸门只开一次（`statsBootstrapped`），不是每次打开都扫。
  let statsBootstrapped = false;
  function bootstrapStatsOnce() {
    if (!statsAutostart) return;
    if (statsBootstrapped) return;
    statsBootstrapped = true;
    void statsCache.refresh();
  }

  /**
   * 枚举会话 id（目录名）。
   *
   * 复用 `lib/usage.js` 的 `listSessionFiles`：它已经实现了"递归遍历会话根目录、
   * 只收 `.jsonl.zstd`"这套规则，`sessionId` 参数也复用它。这里**只取路径里的目录名**，
   * 与 `path.basename(path.dirname(file))` 等价，不解析任何文件内容。
   *
   * 为什么不另写一遍目录遍历：两条遍历规则迟早会漂移（一边漏了子目录、一边多了别的后缀），
   * 而"哪些会话存在"与"哪些文件要统计"必须是同一批——否则预计算会漏掉会话。
   */
  async function listSessionIds() {
    const files = await listSessionFiles(sessionsRoot(resolveDshHome()));
    const ids = new Set();
    for (const file of files) {
      const parts = String(file).split(/[\\/]/);
      // `.../sessions/--ws--/session-<uuid>/xxx.jsonl.zstd` → 倒数第二段是会话 id。
      const name = parts.length >= 2 ? parts[parts.length - 2] : "";
      if (name !== "") ids.add(name);
    }
    return [...ids];
  }

  // ── 展示路由：只读缓存 ────────────────────────────────────────────────
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: SNAPSHOT_PATH,
      handler: async (req, res) => {
        const { lang } = resolveQuery(req);
        const msg = MESSAGES[lang];
        if (req.method !== "GET" && req.method !== "HEAD") {
          return sendJson(res, 405, { ok: false, error: "method", message: msg.method });
        }
        if (!isTrustedRequest(req, bindHost)) {
          return sendJson(res, 403, { ok: false, error: "forbidden", message: msg.forbidden });
        }
        // 这里**没有**任何上游调用：只读 collector 的快照。刷新页面不会打厂商接口。
        //
        // 唯一的例外是"从未采过"的那一次：由 bootstrapOnce 在后台垫一轮，响应仍然是
        // 即时的空快照。它只发生一次（bootstrapped 闸门），不是每次刷新都触发。
        bootstrapOnce();
        const snapshots = {};
        for (const kind of ["credits", "prepaid", "subscription"]) {
          snapshots[kind] = collector.getSnapshot(kind);
        }
        const intervals = config?.collectIntervals ?? {};
        sendJson(res, 200, {
          ok: true,
          collectedAt: Date.now(),
          snapshots,
          // 频率配置回给界面，让它能把"建议不低于 10 分钟"写对，也避免两边各写一份阈值。
          intervalPolicy: {
            defaultMs: DEFAULT_INTERVAL_MS,
            minMs: MIN_INTERVAL_MS,
            recommendedMinMs: RECOMMENDED_MIN_INTERVAL_MS,
            configured: {
              credits: collector.intervalOf("credits"),
              prepaid: collector.intervalOf("prepaid"),
              subscription: collector.intervalOf("subscription"),
              // 统计预计算的生效间隔。设置表单用它显示"统计"那一行；
              // 它与上面三项同一套归一化，所以这里也走 statsCache.intervalMs。
              stats: statsCache.intervalMs,
            },
            clamped: {
              credits: normalizeInterval(intervals.credits).clamped,
              prepaid: normalizeInterval(intervals.prepaid).clamped,
              subscription: normalizeInterval(intervals.subscription).clamped,
              stats: statsCache.clamped,
            },
          },
        });
      },
    }),
    "dsh-quota-usage: snapshot route",
  );

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: COLLECT_PATH,
      handler: async (req, res) => {
        const { lang, sessionId } = resolveQuery(req);
        const msg = MESSAGES[lang];
        try {
          if (req.method !== "POST") {
            return sendJson(res, 405, { ok: false, error: "method", message: msg.method });
          }
          if (!isTrustedRequest(req, bindHost)) {
            return sendJson(res, 403, { ok: false, error: "forbidden", message: msg.forbidden });
          }
          const raw = await readBoundedText(req, MAX_TOKEN_BODY_BYTES);
          let body = {};
          if (raw.trim() !== "") {
            try { body = JSON.parse(raw); } catch { body = {}; }
          }
          const kind = typeof body?.kind === "string" ? body.kind.trim() : "";
          // 人工刷新入口：只接受已知的三类，避免被当成通用触发器。
          if (kind !== "" && !["credits", "prepaid", "subscription"].includes(kind)) {
            return sendJson(res, 400, { ok: false, error: "kind", message: msg.tokenUnknownProvider });
          }
          await collector.collectNow(kind === "" ? undefined : kind);
          const snapshots = {};
          for (const name of ["credits", "prepaid", "subscription"]) {
            snapshots[name] = collector.getSnapshot(name);
          }
          sendJson(res, 200, { ok: true, collectedAt: Date.now(), snapshots });
        } catch (error) {
          ctx.logger.warn("dsh-quota-usage: collect request failed");
          ctx.logger.warn(error);
          sendJson(res, 502, { ok: false, error: "internal", message: msg.internal });
        }
      },
    }),
    "dsh-quota-usage: collect route",
  );

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: HOLIDAYS_PATH,
      handler: async (req, res) => {
        const { lang } = resolveQuery(req);
        const msg = MESSAGES[lang];
        if (req.method !== "GET" && req.method !== "HEAD") {
          return sendJson(res, 405, { ok: false, error: "method", message: msg.method });
        }
        if (!isTrustedRequest(req, bindHost)) {
          return sendJson(res, 403, { ok: false, error: "forbidden", message: msg.forbidden });
        }
        sendJson(res, 200, { ok: true, ranges: HOLIDAY_RANGES });
      },
    }),
    "dsh-quota-usage: holidays route",
  );

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: ROUTE_PATH,
      handler: async (req, res) => {
        const { lang, sessionId } = resolveQuery(req);
        const msg = MESSAGES[lang];
        try {
          if (req.method !== "GET" && req.method !== "HEAD") {
            return sendJson(res, 405, { ok: false, error: "method", message: msg.method });
          }
          // ---- 仅本机访问：拦截 DNS rebinding、跨站读取与局域网直连 ----
          if (!isTrustedRequest(req, bindHost)) {
            return sendJson(res, 403, { ok: false, error: "forbidden", message: msg.forbidden });
          }

          // 放假日期表过期时告警（每天一次）。放在请求路径上，跨年长跑也能覆盖到。
          try {
            warnHolidayCoverage(ctx);
          } catch { /* 告警失败不影响卡片 */ }

          // ---- 当前模型当前档单价（展示用）----
          //
          // **回落链（顺序不能乱）**：
          //   1. 会话级模型 —— 有 `?session=`，且该会话的日志能读出最后用的模型；
          //   2. `agentDefaultModel.currentSelection()` —— 全局默认选择；
          //   3. `DEFAULT_MODEL` —— 兜底。
          //
          // 为什么需要第 1 步：`agentDefaultModel` 是**全局**默认，与会话无关。用户在
          // 另一个会话里把模型换成别的，切回来时它仍返回旧值，面板就停在上一个模型的
          // 读数上（用户报的「切过去之后标记没跟过去」）。会话级的模型只在客户端投影
          // 与会话日志里，宿主 ctx 拿不到，所以这里回放日志。
          //
          // 取不到会话级模型时**不报错**：老宿主、刚建的会话（还没有任何请求）、日志
          // 正在写入，都会走到第 2 步。宁可回落，也不要让卡片因为一个附加参数变空。
          let model = DEFAULT_MODEL;
          let provider = "";
          let modelFrom = "default";
          if (sessionId !== "") {
            try {
              const snapshot = await sessionModels.resolve(sessionId);
              if (snapshot !== null) {
                if (snapshot.model !== "") model = snapshot.model;
                if (snapshot.provider !== "") provider = snapshot.provider;
                modelFrom = "session";
              }
            } catch { /* 读不到会话日志：按全局默认继续 */ }
          }
          if (modelFrom !== "session") {
            try {
              const adm = ctx.get("agentDefaultModel");
              const selection = adm && typeof adm.currentSelection === "function" ? adm.currentSelection() : void 0;
              if (selection && typeof selection.model === "string") model = selection.model;
              if (selection && typeof selection.provider === "string") provider = selection.provider;
              if (selection && (typeof selection.model === "string" || typeof selection.provider === "string")) {
                modelFrom = "default-selection";
              }
            } catch {}
          }
          // 时刻在账户请求之后再取：请求耗时会跨过峰谷边界，先取会让 peak / 单价 /
          // 倒计时三者互相矛盾（显示橙色高峰灯却给着空闲价）。
          const now = Date.now();
          // provider 解析：精确 id 优先，其次用户映射；未识别时按「不支持」处理。
          // 解析器按请求现建，读取的是 volatile 配置的最新值（见 providersNow）。
          const resolution = providersNow().resolve(provider);
          const entry = resolution?.entry ?? null;
          // 计价按解析后的能力 id 查表：映射到厂商账户的路由复用该厂商的价格快照。
          const unit = unitAt(model, now, entry?.id ?? provider);

          const errors = [];
          const kind = entry?.kind ?? "none";
          const providerInfo = {
            id: provider,
            // 归一后的能力 id：能力表用它索引端点与解析器。路由 id 与它可能不同
            // （第三方插件把 ChatGPT 订阅注册成 `codex-chatgpt`，能力表里叫
            // `openai-codex`）。**无条件下发**：认不出能力时等于 id 本身，展示侧
            // 可以不加判断地用它去匹配采集快照里的订阅来源，两边不必各写一份别名表。
            capability: entry?.id ?? provider,
            displayName: entry?.displayName ?? provider,
            kind,
            reason: kind === "none" ? (entry?.reason ?? "unsupported") : null,
            // 这个 provider 是怎么被认出来的：exact（能力表）/ alias（用户映射）/ none。
            via: resolution?.via ?? "none",
          };

          // ---- 当前 provider 的账户数据（余额 / 订阅用量）----
          let balance = { isAvailable: null, total: null, currency: null };
          let usage = null;

          if (kind === "none") {
            // 这个 provider 没有可查的接口：卡片置空并说明原因，不显示任何数字。
            errors.push(msg.accountNoApi(providerInfo.displayName));
          } else if (kind === "oauth") {
            const snapshot = await readAccountCached(ctx, provider, resolution);
            if (snapshot.ok) {
              balance = snapshot.balance ?? balance;
              usage = snapshot.usage ?? null;
            } else {
              // 本插件自己那份凭据不可用（没填令牌 / 令牌失效）时的回落：
              //
              // 有些订阅路由的额度**根本不需要本插件去查**——第三方插件（例如
              // dsh-chatgpt-subscription 的 `codex-chatgpt`）已经登录并采到了，
              // 本插件的订阅采集早就把它归一进快照（`provider: 'openai-codex'`，
              // 带账号数组与窗口）。此时再报「尚未填写 OAuth 令牌」是**错的**：
              // 用户什么都没缺，数字就在手边。
              //
              // 只在这一种情况下回落（凭据不可用），且只认快照里 `ok: true` 且
              // 真有窗口的那条读数；拿不到就照旧报原来的错误码，绝不编数字。
              const probe = subscriptionReadingOf(providerInfo.capability, collector.getSnapshot);
              if (probe.reading !== null) {
                usage = {
                  plan: probe.reading.plan,
                  windows: probe.reading.windows,
                  // 数据是从哪儿来的：plugin = 第三方订阅插件采到的快照。
                  // 与 lib/subscription.js 的 mode 同口径，界面据此标"来源"。
                  source: probe.reading.mode,
                  // 这条读数属于哪个账号（多账号池里 activeAccountId 那个）。
                  account: probe.reading.account,
                  // 'active' = 按 activeAccountId 选的；'only-account' = 这台机器上
                  // 只有这一个账号有数（没有池信息时的退化路径）。
                  accountSource: probe.reading.accountSource,
                };
              } else if (isAliasRoute(provider) && snapshot.code === "accountNoToken") {
                // 别名路由 = 别人注册的订阅路由，令牌本来就不在我们这儿。
                //
                // 三种"没拿到"要分开说，别混成一句：
                if (probe.state === "active-missing") {
                  // 有这一行、但当前活跃账号这次没取到用量。**绝不借别的账号的数**，
                  // 如实说清是哪个账号缺——那才是用户去排查的入口。
                  errors.push(probe.activeId === null || probe.activeId === undefined
                    ? msg.accountAliasActiveMissing
                    : msg.accountAliasActiveMissingNamed(probe.activeId));
                } else if (probe.state === "no-row") {
                  // 采过了，快照里根本没有这条订阅：这台机器没登录那个订阅。
                  errors.push(msg.accountAliasNoReading);
                }
                // `not-collected` 不报错：首轮采集还没跑，空白是过渡态，
                // 报一条就是假故障（见 bootstrapOnce 的注释）。
              } else {
                errors.push(accountMessage(msg, snapshot.code));
              }
            }
          } else if (entry.id === "deepseek-official" || entry.id === "deepseek-account" || entry.id === "deepseek") {
            // DeepSeek 官方路由：与其他提供商同一条取数路径，但失败文案沿用
            // 既有的 `balance*`（用户可见契约，逐字保留）。
            const snapshot = await readAccountCached(ctx, provider, resolution);
            balance = snapshot.balance ?? balance;
            usage = snapshot.usage ?? null;
            if (!snapshot.ok) {
              errors.push(deepSeekMessage(msg, snapshot));
            }
          } else {
            const snapshot = await readAccountCached(ctx, provider, resolution);
            if (snapshot.ok) {
              balance = snapshot.balance ?? balance;
              usage = snapshot.usage ?? null;
            } else {
              errors.push(
                snapshot.code === "accountNoKey" && snapshot.ref
                  ? msg.accountNoKeyNamed(snapshot.ref)
                  : accountMessage(msg, snapshot.code),
              );
            }
          }

          // ---- 距下一次计费区间翻转（界面用它在指示灯旁显示倒计时）----
          // DeepSeek 官方模型走峰谷表；其它 provider 有分时段计费时由各自的表给出；
          // 不分时段的（window 为 null）不发送倒计时。
          //
          // 订阅制路由没有价格快照，但当前模型如果是 DeepSeek 的峰谷型号，仍然把
          // 时段信息发出去——卡片照旧显示峰谷灯与倒计时（不显示单价）。
          let displayWindow = unit.window;
          if (
            displayWindow === null &&
            (kind === "usage" || kind === "oauth") &&
            isDeepSeekScheduleModel(model)
          ) {
            displayWindow = isPeak(now) ? "peak" : "idle";
          }
          const next = displayWindow === null
            ? { peak: false, at: null, ms: 0 }
            : unit.next ?? nextChange(now);

          sendJson(res, 200, {
            ok: true,
            provider: providerInfo,
            balance,
            usage,
            // peak = 当前是否处于较贵的一侧（DeepSeek 的峰谷、其它 provider 的高峰
            // 时段或优惠时段之外都是这个含义）；不分时段时为 false。
            peak: displayWindow === "peak",
            //   peak = 切换后所处的时段，at = 切换时刻，ms = 剩余毫秒
            next,
            tier: {
              input: unit.input,
              cacheRead: unit.cacheRead,
              cacheWrite: unit.cacheWrite,
              output: unit.output,
              model: unit.model,
              known: unit.known,
              // 计费币种：DeepSeek 为 CNY，其它 provider 见各自价格表。
              currency: unit.currency,
              // null = 这个模型全天同一价（不画指示灯与倒计时）；订阅制路由上的
              // DeepSeek 模型会给出峰谷时段，但仍然 known=false（不显示单价）。
              window: displayWindow,
            },
            // 【内部诊断】取价路径：界面不再展示（卡片去技术化），保留字段
            // 供排查问题与回归测试使用。
            pricing: {
              via: unit.via,                        // exact | alias | fallback
              requested: unit.requested,            // 当前启用的模型 id
              provider: provider,                   // 当前路由的原始 provider id
              capability: entry?.id ?? provider,    // 解析后用于查价的能力表 id
              used: unit.model,                     // 实际取价使用的模型 id
              known: unit.known,                    // false = 不计价，界面隐藏单价
              currency: unit.currency,
              window: unit.window,
              // 这个 provider/model 是怎么定下来的：session（会话日志）/
              // default-selection（全局默认选择）/ default（兜底常量）。
              // 界面不展示，供排查"切了会话却没跟过去"这类问题。
              modelFrom,
            },
            updatedAt: now,
            errors,
          });
        } catch (error) {
          ctx.logger.warn("dsh-quota-usage: request failed");
          ctx.logger.warn(error);
          sendJson(res, 502, {
            ok: false,
            error: "internal",
            message: msg.internal,
          });
        }
      },
    }),
    "dsh-quota-usage: route",
  );

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: ACCOUNTS_PATH,
      handler: async (req, res) => {
        const { lang } = resolveQuery(req);
        const msg = MESSAGES[lang];
        try {
          if (req.method !== "GET" && req.method !== "HEAD") {
            return sendJson(res, 405, { ok: false, error: "method", message: msg.method });
          }
          if (!isTrustedRequest(req, bindHost)) {
            return sendJson(res, 403, { ok: false, error: "forbidden", message: msg.forbidden });
          }

          // 当前 provider 也是"已检测到"的一条：用户可能只在 agentDefaultModel 里
          // 指向了它，而目录还没列出。
          let currentProvider = "";
          try {
            const adm = ctx.get("agentDefaultModel");
            const selection = adm && typeof adm.currentSelection === "function" ? adm.currentSelection() : void 0;
            if (selection && typeof selection.provider === "string") currentProvider = selection.provider;
          } catch {}

          // 设置页的下拉选项：schema 允许映射到的提供商集合。与 Config 的枚举同源，
          // 目录读不到时也要给出来，否则设置页没法添加映射。`kind` 让设置页知道
          // OAuth 目标（Claude Code / Codex）的凭据是订阅令牌，不填凭据引用。
          const aliasable = aliasableProviderIds().map((id) => {
            const entry = accountCapabilityOf(id);
            return { id, displayName: entry.displayName, kind: entry.kind };
          });

          // 已注册的 provider 路由（directory 可能包含未注册的，只取注册过的）。
          const registered = new Map();
          try {
            const llm = ctx.get("llm");
            if (llm && typeof llm.listProviders === "function") {
              for (const item of llm.listProviders()) registered.set(item.id, item.name ?? item.id);
            }
          } catch {
            // 目录读不到时映射选项照常给，未识别候选与令牌区留空。
            sendJson(res, 200, { ok: true, aliasable, unmapped: [], oauth: [] });
            return;
          }

          // 本次请求的映射解析器：volatile 配置可能在两次请求之间被设置页改写。
          const providers = providersNow();

          // 检测到、但既不在能力表里、也没有用户映射的路由：设置页用它给出"添加映射"
          // 的候选。只取已注册与当前 provider，目录里那几十条无关路由不进列表。
          const detected = new Set([...registered.keys(), ...(currentProvider ? [currentProvider] : [])]);
          const unmapped = [...detected]
            .filter((id) => providers.resolve(id) === null)
            .map((id) => ({ id, displayName: registered.get(id) ?? id }));

          // OAuth 令牌状态：列出「DSH 里检测到」或「被映射目标引用」的 Claude Code /
          // Codex——后者让只装了第三方 Codex/Claude 插件的环境也能先填令牌。令牌值
          // 永不回传；`configured` 只看本地凭据，不查上游。
          //
          // 检测到的路由可能用别名 id 注册（如第三方 Codex 插件的 `chatgpt-codex`），
          // 按规范 id 归一后再判断，令牌框才会出现。
          const detectedCanonical = new Set([...detected].map((id) => canonicalProviderId(id)));
          const mappedOauth = new Set(providers.capabilityIds.filter((id) => oauthProviderOf(id) !== null));
          const oauth = [];
          for (const id of oauthProviderIds()) {
            if (!detectedCanonical.has(id) && !mappedOauth.has(id)) continue;
            const spec = oauthProviderOf(id);
            const resolved = await resolveCredential(ctx, [spec.tokenRef]);
            oauth.push({
              id,
              displayName: accountCapabilityOf(id).displayName,
              configured: resolved.ok,
            });
          }

          sendJson(res, 200, { ok: true, aliasable, unmapped, oauth });
        } catch (error) {
          ctx.logger.warn("dsh-quota-usage: plugin page request failed");
          ctx.logger.warn(error);
          sendJson(res, 502, { ok: false, error: "internal", message: msg.internal });
        }
      },
    }),
    "dsh-quota-usage: plugin page route",
  );

  // 会话用量统计：**只读预计算缓存**。
  //
  // 请求路径上唯一的 IO 是 `refreshStale()`——它只 stat 文件、不解压不解析，
  // 用来判断"日志比缓存新"。真正的扫描（`usageScanner.scan()` /
  // `scanSession()` / `scanWorkspaces()`）只在两处发生：
  //   1. 后台定时器（statsCache.start() 排的，间隔见 collectIntervals.stats）；
  //   2. 显式 POST（用户点刷新）。
  //
  // 这就是用户要求的那条边界：「打开统计页只读缓存」。以前的写法在这里直接
  // `await usageScanner.scan()`，于是每次打开都走一遍目录遍历 + 增量解析。
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: STATS_PATH,
      handler: async (req, res) => {
        const { lang, sessionId } = resolveQuery(req);
        const msg = MESSAGES[lang];
        try {
          // 先做方法判定，再做信任围栏——顺序与原来的路由一致。
          //
          // 反过来的写法（先栅栏后方法）会把"用错方法"的请求也报成 403：一个没有
          // Host 头的 POST 原本该得到 405「仅支持 GET」，却得到 403「禁止访问」，
          // 排查时会往权限方向找错路。方法与来源是两件独立的事，方法错就先说方法错。
          const isRefresh = req.method === "POST";
          if (!isRefresh && req.method !== "GET" && req.method !== "HEAD") {
            return sendJson(res, 405, { ok: false, error: "method", message: msg.method });
          }
          if (!isTrustedRequest(req, bindHost)) {
            return sendJson(res, 403, { ok: false, error: "forbidden", message: msg.forbidden });
          }
          // `scope=workspace` 走工作区维度；`session=<id>` 只算那一个会话（会话内视图）；
          // 两者都没有就是全机。
          const scope = String(req.url ?? "").includes("scope=workspace")
            ? "workspace"
            : (sessionId === "" ? "machine" : "session");

          if (isRefresh) {
            // 显式刷新：等这一轮算完再回答（用户点了"刷新"，要的就是一个确定的结果）。
            //
            // 合流的边界要补上：statsCache.refresh 会把本次调用并进已在飞的那一轮——
            // 那一轮可能是**按下刷新之前**启动的，算的还是旧日志。所以收尾必须校验：
            // 刚算完的这份数据的指纹还匹不匹配当前日志（refreshStale），不匹配就再
            // 排一轮，直到拿到"至少和按下时一样新"的结果。有上限（3 次）：
            // 日志在持续追加的极端场景不该让一次刷新永远收不了尾——那时的数据
            // 只比"按下时"旧几秒，界面上的 stale 标记会交代这一点，下一轮后台
            // tick 也会把它收敛掉。
            for (let attempt = 0; attempt < 3; attempt += 1) {
              await statsCache.refresh();
              await statsCache.refreshStale(scope, sessionId);
              if (statsCache.get(scope, sessionId).stale !== true) break;
            }
          } else {
            // 普通 GET **一次扫描都不做**：只读缓存 + 一次 stat 指纹（refreshStale）。
            // 未预热时立刻回 `state: 'computing'`，并在后台垫**一次**（闸门保证只一次）。
            // 那次垫底的开销不落在这次请求的等待上——响应先返回。
            bootstrapStatsOnce();
            await statsCache.refreshStale(scope, sessionId);
          }

          const cached = statsCache.get(scope, sessionId);
          // 三个通用字段：界面据此区分"算好了" / "还在算" / "数据已过期"。
          // `computedAt === null` 与 `state: 'computing'` 一起保证"未预热"不会被
          // 显示成"0 用量"——那种误读是这个页面上最坏的一种错。
          const base = {
            ok: true,
            state: cached.state,
            computedAt: cached.computedAt,
            stale: cached.stale,
            intervalMs: cached.intervalMs,
            nextAt: cached.nextAt,
            ...(cached.lastError === null ? {} : { error: cached.lastError }),
          };

          if (scope === "workspace") {
            const workspaces = Array.isArray(cached.value) ? cached.value : null;
            if (workspaces === null) {
              // 未预热：**不给 workspaces: []**。空数组会被读成"一个工作区都没有"，
              // 而真相是"还没算"。只给状态，让界面显示"计算中"。
              return sendJson(res, 200, { ...base, scope: "workspace" });
            }
            return sendJson(res, 200, { ...base, scope: "workspace", atMs: cached.computedAt, workspaces });
          }

          const summary = cached.value;
          if (summary === null) {
            // 未预热：不给 messages / kinds。写了 messages: 0 就等于谎报"这次对话 0 次请求"。
            return sendJson(res, 200, base);
          }
          // 金额已在预计算时算好并随缓存一起返回（见 statsCache 的 computeMachine）。
          return sendJson(res, 200, { ...base, ...summary });
        } catch (error) {
          ctx.logger.warn("dsh-quota-usage: stats request failed");
          ctx.logger.warn(error);
          sendJson(res, 502, { ok: false, error: "internal", message: msg.internal });
        }
      },
    }),
    "dsh-quota-usage: stats route",
  );

  // 免费渠道积分：读 dsh-free-model 落盘的三份状态，合成「积分型」读数。
  //
  // 为什么不直接调它的 `credits.balances` RPC：那条 RPC 由 dsh-free-model 注册在
  // 浏览器侧的 `connection.rpc.call('/api', 'channel-pack', …)`，宿主的
  // `/api/channel-pack` 直接 POST 会 401（它要求浏览器会话的 admission）。本插件
  // 不去绕那道门，而是读它已经落盘的状态：账号池、签到结果、token 账本。
  // 于是这里给的是"账号面 + 消耗面"，逐账号实时积分仍以 dsh-free-model 自己的
  // 渠道页为准——README 里写明了这条边界。
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: CREDITS_PATH,
      handler: async (req, res) => {
        const { lang } = resolveQuery(req);
        const msg = MESSAGES[lang];
        try {
          if (req.method !== "GET" && req.method !== "HEAD") {
            return sendJson(res, 405, { ok: false, error: "method", message: msg.method });
          }
          if (!isTrustedRequest(req, bindHost)) {
            return sendJson(res, 403, { ok: false, error: "forbidden", message: msg.forbidden });
          }
          const credits = await readFreeModelCredits();
          sendJson(res, 200, { ok: true, ...credits });
        } catch (error) {
          ctx.logger.warn("dsh-quota-usage: credits request failed");
          ctx.logger.warn(error);
          sendJson(res, 502, { ok: false, error: "internal", message: msg.internal });
        }
      },
    }),
    "dsh-quota-usage: credits route",
  );

  // 价格表：配置页「单价」块的数据通道（见 lib/client.js 的 PriceEditor）。
  //
  // GET  拉整张表；POST 保存一条用户改的价（{action:"save", record:{…}}）或恢复出厂价
  // （{action:"reset"}）。
  //
  // 两条硬要求：
  //   1. **GET 的响应形状是契约**：必须是 `{ok:true, records:[…]}`。客户端把别的形状
  //      （含 404）一律当「暂不可用」，配置页的整块单价就没了。
  //   2. **存储坏了不许 500**：price-store 读不出来时自己回落种子，路由仍返回
  //      `{ok:true, records:[种子]}` 并带上 notices/problems——用户至少要能看见默认价
  //      并继续编辑，而不是整块报错。
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: PRICES_PATH,
      handler: async (req, res) => {
        const { lang } = resolveQuery(req);
        const msg = MESSAGES[lang];
        try {
          if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") {
            return sendJson(res, 405, { ok: false, error: "method", message: msg.pricesMethod });
          }
          if (!isTrustedRequest(req, bindHost)) {
            return sendJson(res, 403, { ok: false, error: "forbidden", message: msg.forbidden });
          }

          // ---- GET：整张表 ----
          if (req.method === "GET" || req.method === "HEAD") {
            return sendJson(res, 200, priceTableResponse());
          }

          // ---- POST：保存 / 恢复出厂价 ----
          //
          // 读 body 的方式与 /token 一致（readBoundedText + JSON.parse）：本机提交也
          // 不该无限读，解析失败按「无法解析」处理而不是崩。
          //
          // ⚠️ 失败一律用 **HTTP 200 + {ok:false, error:"…"}** 表示（不是 4xx）：
          //   浏览器侧 lib/client.js 把 `payload.error` **原文显示**给用户（"保存被拒绝：
          //   {reason}"），所以 error 里必须是**人话**，不能是 "payload" 这种机器键。
          //   4xx 会让客户端走 `!res.ok` 分支，恰好也读 error，但状态码不是本路由契约
          //   的一部分（客户端只看 body.ok 与 body.error），统一 200 少一处分叉。
          //   机器要分支的话看 `code` 字段（它才是机器键）。
          let raw = "";
          try {
            raw = await readBoundedText(req, MAX_TOKEN_BODY_BYTES);
          } catch {
            return sendJson(res, 200, { ok: false, code: "payload", error: msg.pricesPayload });
          }
          let body;
          try {
            body = JSON.parse(raw);
          } catch {
            return sendJson(res, 200, { ok: false, code: "payload", error: msg.pricesPayload });
          }

          const action = typeof body?.action === "string" ? body.action.trim() : "";
          if (action === "save") {
            const result = savePriceRecord(body?.record);
            if (result?.ok !== true) {
              // 保存被拒（负数、非数字、缺 provider/model…）：**不写盘**，把原因原文回给
              // 客户端——它会把这句 error 直接显示在那一行下面。
              const error = typeof result?.error === "string" && result.error !== ""
                ? result.error
                : msg.pricesSaveFailed;
              return sendJson(res, 200, {
                ok: false,
                code: "save-rejected",
                error,
                notices: Array.isArray(result?.notices) ? result.notices : [],
                problems: Array.isArray(result?.problems) ? result.problems : [],
              });
            }
            return sendJson(res, 200, {
              ok: true,
              notices: Array.isArray(result?.notices) ? result.notices : [],
              saved: Array.isArray(result?.saved) ? result.saved : [],
            });
          }
          if (action === "reset") {
            const result = resetPriceTable();
            if (result?.ok !== true) {
              const error = typeof result?.error === "string" && result.error !== ""
                ? result.error
                : msg.pricesResetFailed;
              return sendJson(res, 200, {
                ok: false,
                code: "reset-failed",
                error,
                notices: Array.isArray(result?.notices) ? result.notices : [],
              });
            }
            return sendJson(res, 200, {
              ok: true,
              notices: Array.isArray(result?.notices) ? result.notices : [],
            });
          }
          return sendJson(res, 200, { ok: false, code: "action", error: msg.pricesUnknownAction });
        } catch (error) {
          // 走到这里说明 price-store 之外出了意外（存储层自身已处理读失败）。
          // 仍然**不返回 500**：给一份能用的响应形状，好过让配置页整块变成「暂不可用」。
          ctx.logger.warn("dsh-quota-usage: prices request failed");
          ctx.logger.warn(error);
          try {
            return sendJson(res, 200, priceTableResponse());
          } catch {
            return sendJson(res, 500, { ok: false, error: "internal", message: msg.internal });
          }
        }
      },
    }),
    "dsh-quota-usage: prices route",
  );

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: TOKEN_PATH,
      handler: async (req, res) => {
        const { lang } = resolveQuery(req);
        const msg = MESSAGES[lang];
        try {
          if (req.method !== "POST") {
            return sendJson(res, 405, { ok: false, error: "method", message: msg.tokenMethod });
          }
          if (!isTrustedRequest(req, bindHost)) {
            return sendJson(res, 403, { ok: false, error: "forbidden", message: msg.forbidden });
          }

          // 读有界 body：本机提交也不该无限读。
          let raw = "";
          try {
            raw = await readBoundedText(req, MAX_TOKEN_BODY_BYTES);
          } catch {
            return sendJson(res, 413, { ok: false, error: "payload", message: msg.tokenPayload });
          }
          let body;
          try {
            body = JSON.parse(raw);
          } catch {
            return sendJson(res, 400, { ok: false, error: "payload", message: msg.tokenPayload });
          }

          const provider = typeof body?.provider === "string" ? body.provider.trim().toLowerCase() : "";
          const spec = oauthProviderOf(provider);
          if (spec === null) {
            return sendJson(res, 400, { ok: false, error: "provider", message: msg.tokenUnknownProvider });
          }
          const token = typeof body?.token === "string" ? body.token.trim() : "";
          if (token !== "" && !isUsableKey(token)) {
            return sendJson(res, 400, { ok: false, error: "key", message: msg.badKey });
          }

          const ref = credentialRef(spec.tokenRef);
          try {
            if (token === "") {
              await ctx.credentials.unset(ref);
              if (spec.accountRef !== undefined) await ctx.credentials.unset(credentialRef(spec.accountRef));
              invalidateAccount(provider);
              return sendJson(res, 200, { ok: true, provider, configured: false, message: msg.tokenCleared });
            }
            await ctx.credentials.set(ref, token);
            // Codex 的账号标识与令牌一并保存（缺了它上游可能拒绝请求）。
            if (spec.accountRef !== undefined) {
              const accountId = typeof body?.accountId === "string" ? body.accountId.trim() : "";
              if (accountId !== "") await ctx.credentials.set(credentialRef(spec.accountRef), accountId);
            }
            invalidateAccount(provider);
            return sendJson(res, 200, { ok: true, provider, configured: true, message: msg.tokenWritten });
          } catch (error) {
            ctx.logger.warn("dsh-quota-usage: token write failed");
            ctx.logger.warn(error);
            return sendJson(res, 502, { ok: false, error: "internal", message: msg.tokenFailed });
          }
        } catch (error) {
          ctx.logger.warn("dsh-quota-usage: token request failed");
          ctx.logger.warn(error);
          sendJson(res, 502, { ok: false, error: "internal", message: msg.internal });
        }
      },
    }),
    "dsh-quota-usage: token route",
  );
}

export { name, inject, apply, Config };
