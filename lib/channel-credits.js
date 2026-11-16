/**
 * dsh-quota-usage — 免费渠道积分余量的**真实查询**（走内核 channel-pack RPC）。
 *
 * 与 lib/credits.js 的分工：
 *   · credits.js 读的是 dsh-free-model 落盘的状态（账号池 / 签到 / token 账本），
 *     它答的是「有几个账号、今天烧了多少 token」。
 *   · 本模块答的是另一个问题：「这些渠道现在还剩多少积分、用了百分之多少」。
 *     这个数只存在于渠道上游的实时响应里，落盘状态里没有，所以必须真的去问。
 *
 * 为什么要绕道 `connection` 服务而不是自己发 HTTP：
 *   dsh-free-model 把逐账号积分挂在 `HostConnectionService` 的 Fetch 路由
 *   `/api/channel-pack` 上，并且只放行**同进程的 owner Peer**。宿主侧直接
 *   POST `http://127.0.0.1:PORT/api/channel-pack` 会吃 401 —— 那道门是按
 *   Peer 判权的，不是按端口。唯一可行的办法是拿到内核的 connection 服务、
 *   用 `createSharedFetchHandler('/api')` 拿到 handler、再把 owner Peer 一起
 *   传进去，让请求以内核自己的身份进入。这不是绕过鉴权，而是使用内核公开的
 *   进程内调用面（同一个 handler 就是内核给前端页面用的那个）。
 *
 * 三道容易踩的坑（都写在代码对应位置，这里先点明）：
 *   1. connection 服务随 web server 一起挂载，可能晚于本插件 apply。所以
 *      「取 connection」必须是**每次调用时**的动作，不能在 apply 时拍快照，
 *      否则 `available` 永远是 false。
 *   2. `browserPeer` / `operator` 是同一个 owner 身份在 DSH 0.2.1 前后的两个
 *      字段名，两个版本各自只接受自己那个形状的 Peer。所以这里只做字段读取，
 *      绝不自己合成 Peer。
 *   3. 余额响应的**分母**有一套反直觉规则（失效包、重叠聚合包），下面
 *      `normalizeChannelCredits` 里逐条解释。它是这个模块里唯一会「骗人」的
 *      地方：算错了会把 95.3% 显示成 91.1%，或者把未知余额显示成 100%。
 */

/** 官方插件注册的 Fetch 路由路径。 */
export const CHANNEL_PACK_PATH = '/api/channel-pack';

/** RPC 端点名（envelope 上的 `method`，必须与路径后半段同名）。 */
export const CHANNEL_PACK_METHOD = 'channel-pack';

/**
 * 单次请求的默认上限。
 * 冷启动第一次问余额时上游要挨个渠道去取，实测约 10.5s；热的时候约 0.3s。
 * 所以既不能太短（把慢当成失败），也不能无限等（拖住整个轮询）。
 */
export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * channel-pack 认识的渠道目录。
 * 发现渠道时要一次把它们全问一遍（`provider.status`），所以这份清单必须在这里
 * 有一份；它同时也是枚举失败时的兜底。
 */
export const CHANNEL_CATALOGUE = [
  'codearts',
  'buddy',
  'workbuddy',
  'lobsterai',
  'qoder',
  'qodercn',
  'trae',
  'cline',
  'loomy',
  'raccoon',
  'minimax',
  'zcode',
  'gemini',
];

/** 读一个"数字样"的值；读不出就 undefined（绝不能退化成 0）。 */
function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** 读一个"非空字符串样"的值。 */
function str(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 错误转文案：调用方要的是一行可读原因，不是 Error 对象。 */
function message(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error.trim() !== '') return error.trim();
  return String(error);
}

/** 金额/积分保留 4 位，掐掉浮点尾巴（7150.69 + 349.31 不该是 7500.000000000001）。 */
function round4(value) {
  return Number(value.toFixed(4));
}

/** 百分比保留 1 位：卡片上再多的位数也没有信息量。 */
function round1(value) {
  return Number(value.toFixed(1));
}

/**
 * 剥掉 `{ ok, value }` 信封。
 *
 * 内核在 handler 外面又套了一层 rpcId 信封，官方 handler 自己返回 `{ ok, value }`。
 * 各版本套法略有差别，所以这里两种都认：有 `value` 就取 `value`，否则原样返回。
 * 认错的后果很轻（normalize 会当成"没有账号"），但不认就会把整条数据丢掉。
 */
function unwrapEnvelope(result) {
  if (result === null || typeof result !== 'object') return result;
  if (Object.prototype.hasOwnProperty.call(result, 'value')) return result.value;
  return result;
}

/**
 * 把可能带信封的余额载荷剥成 `{ accounts: [...] }`。
 *
 * 只认得出「有 accounts 数组」的对象是载荷本身；没有 accounts 但有 value 的当信封剥。
 */
function rawPayload(raw) {
  if (raw === null || typeof raw !== 'object') return raw;
  if (Array.isArray(raw.accounts)) return raw;
  if (raw.value !== undefined) return raw.value;
  return raw;
}

/**
 * 渠道/账号/包共用一个单位标签时取哪个。
 *
 * 同一个渠道里的包经常只是**拼写**不一致：workbuddy 有些包写 `credit`、有些写
 * `credits`，直接把去重集合拼起来会在卡片上印出 `credit/credits` —— 两个词占掉
 * 本该给数字的宽度，而且看起来像两种东西。单复数是同一个单位，折叠成一种写法
 * （取更长的那个，在这份目录里就是复数）。
 *
 * 但 credit 与 token 是**真不同**的单位，那种情况绝不折叠：把它们说成同一个
 * 才是撒谎。这时用 `/` 连接，明确表示"这个数是跨单位加出来的"。
 *
 * @param {Set<string>} units 该渠道所有包上出现过的单位标签。
 * @returns {string | undefined} 一个标签、一个斜杠列表，或 undefined。
 */
function pickUnit(units) {
  const list = [...units];
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  const stems = new Set(list.map((unit) => unit.toLowerCase().replace(/s$/, '')));
  if (stems.size === 1) {
    return list.reduce((longest, unit) => (unit.length > longest.length ? unit : longest), list[0]);
  }
  return list.join('/');
}

/**
 * 建立内核 RPC 调用器。
 *
 * 返回值里的 `available` / `reason` 是 **getter**：每次读都在重新解析 connection。
 * 理由见文件头第 1 条坑——connection 会晚于本插件出现，任何一次性的快照都可能
 * 永久为 undefined。getter 让它天然是惰性的，调用方随手 `rpc.available` 也能看到
 * 最新事实，不需要额外的 refresh 接口。
 *
 * `ctx` 缺 `get` 方法时退化成读 `ctx.connection`：有些内核版本把服务直接挂 ctx 上。
 * `ctx.get` 抛错（服务未注册）不算致命，当作没有即可 —— 探测代码不该因为宿主
 * 的一句异常就崩掉整个插件。
 *
 * @param {object} ctx 宿主插件上下文。
 * @returns {{
 *   readonly available: boolean,
 *   readonly reason: string | undefined,
 *   call: (method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>,
 * }}
 */
export function makeChannelCreditsRpc(ctx) {
  /** 解析一次 connection，把"缺什么"说清楚。 */
  const inspect = () => {
    let connection;
    try {
      connection = ctx?.get?.('connection') ?? ctx?.connection;
    } catch {
      connection = undefined;
    }
    if (connection === undefined || connection === null) {
      return { reason: '内核未提供 connection 服务' };
    }

    let handler;
    try {
      handler = typeof connection.createSharedFetchHandler === 'function'
        ? connection.createSharedFetchHandler('/api')
        : undefined;
    } catch (error) {
      return { reason: `connection.createSharedFetchHandler 抛错：${message(error)}` };
    }
    if (handler === undefined || handler === null || typeof handler.fetch !== 'function') {
      return { reason: 'connection 没有可用的共享 fetch handler' };
    }

    // 0.2.1+ 叫 browserPeer，0.2.0-rc 叫 operator，同一个 owner 身份两个名字。
    // 只读字段，绝不合成 Peer：形状不对的 Peer 会在路由内部抛错。
    const peer = connection.browserPeer ?? connection.operator;
    if (peer === undefined || peer === null) {
      return { reason: 'connection 没有 owner peer（browserPeer/operator）' };
    }

    return { connection, handler, peer };
  };

  return {
    get available() {
      return inspect().reason === undefined;
    },

    get reason() {
      return inspect().reason;
    },

    /**
     * 调用 channel-pack 的一个方法。
     *
     * envelope 是内核自己的线上格式：`type: 'client-request'` + `rpcId` + `method`
     * + `payload`。`method` 必须与路径后半段同名（`channel-pack`），否则路由不认。
     * rpcId 只需在会话内唯一，带上 `dsh-usage-` 前缀是为了在宿主日志里认得出是我们。
     *
     * @param {string} method 端点内的方法名（`credits.balances` / `provider.status`）。
     * @param {unknown} payload 方法载荷。
     * @param {AbortSignal} [signal] 调用方取消信号。
     * @returns {Promise<unknown>} 剥掉信封后的 `value`。
     */
    async call(method, payload, signal) {
      const resolved = inspect();
      if (resolved.reason !== undefined) throw new Error(resolved.reason);

      const envelope = {
        type: 'client-request',
        rpcId: `dsh-usage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        method: CHANNEL_PACK_METHOD,
        payload: { method, payload },
      };
      const request = new Request(`http://127.0.0.1${CHANNEL_PACK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
        signal,
      });

      const response = await resolved.handler.fetch(request, resolved.peer);
      if (response === null || typeof response !== 'object') {
        throw new Error('channel-pack 返回了非响应对象');
      }
      const status = typeof response.status === 'number' ? response.status : 0;
      // 这两码是权限问题（Peer 不对 / 没有 owner 身份），与"渠道不存在"必须分开报，
      // 否则用户会以为自己的渠道全掉了。
      if (status === 401 || status === 403) {
        throw new Error(`channel-pack 拒绝（HTTP ${status}）`);
      }
      if (typeof response.text !== 'function') {
        throw new Error(`channel-pack 没有可读响应体（HTTP ${status}）`);
      }

      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`channel-pack 返回非 JSON（HTTP ${status}）`);
      }

      // 内核用 `{ result: ... }` 包一层；官方 handler 自己的返回是 `{ ok, value }`。
      const result = body !== null && typeof body === 'object' && body.result !== undefined ? body.result : body;
      if (result !== null && typeof result === 'object' && result.ok === false) {
        // 应用层失败（渠道未登录、上游超时）是 HTTP 200，必须靠 ok:false 认出来。
        throw new Error(str(result.error?.message) ?? str(result.error?.code) ?? 'channel-pack 拒绝请求');
      }
      return unwrapEnvelope(result);
    },
  };
}

/**
 * 找出**真的登录了账号**的渠道。
 *
 * 为什么用 `provider.status` 而不是 `credits.balances`：前者一次往返就能问完整个
 * 目录（`{ providers: [...] }` → 每家的账号数、模型数），后者一次只能问一家。
 * 没登录账号的渠道去问余额只会得到空响应，先筛一遍能省 12 次无用请求。
 *
 * 枚举失败/空结果时**兜底返回目录**而不是空数组：这个函数是用来"决定要问谁"的，
 * 多问几家只是慢一点，漏问则会让用户看到一个空的积分卡片。真正的
 * "插件不可用"由 `makeChannelCreditsRpc().available` 表达，不靠这里区分。
 *
 * @param {{call: Function}} rpc {@link makeChannelCreditsRpc} 的返回值。
 * @param {readonly string[]} [catalogue] 渠道目录。
 * @returns {Promise<string[]>} 至少有一个账号的渠道（失败时是目录本身）。
 */
export async function listCreditChannels(rpc, catalogue = CHANNEL_CATALOGUE) {
  const fallback = Array.isArray(catalogue) ? [...catalogue] : [];
  if (rpc === undefined || rpc === null || typeof rpc.call !== 'function') return fallback;
  try {
    // 目录为空时问整个目录，避免拿空数组去问（那会得到空状态，白跑一趟）。
    const result = await rpc.call('provider.status', { providers: fallback.length > 0 ? fallback : CHANNEL_CATALOGUE });
    // 容忍两种形状：call 已剥信封（直接给 statuses），或还是 `{ value: { statuses } }`。
    const value = rawPayload(result);
    const statuses = value?.statuses ?? result?.statuses;
    if (statuses === null || typeof statuses !== 'object') return fallback;
    const channels = [];
    for (const [provider, status] of Object.entries(statuses)) {
      const total = status?.accounts?.total;
      // `accounts.total > 0` 才是"登录过"。0 或缺失都表示这家没账号，问了也是空。
      if (typeof total === 'number' && total > 0) channels.push(provider);
    }
    if (channels.length > 0) return channels;
  } catch {
    // 枚举失败不等于没有渠道 —— 走兜底。
  }
  return fallback;
}

/**
 * 把一个渠道的原始余额响应折成卡片要的一行。
 *
 * 返回结构（`state` 三态必须严格区分）：
 *   ok    —— 至少读到一个数字，`remaining` / `total` / `percent` 可能都有
 *   empty —— 渠道没有绑定账号（用户还没登录），不是错误、也不是"0 积分"
 *   error —— 有账号但一个都读不到（全 null 或全失败）
 *
 * ## 算术规则，以及为什么每条都不能省
 *
 * (1) `balance === null` 是**该账号**查询失败，不是余额为 0。
 *     gemini 就是这样：HTTP 200、`ok:true`、`balance:null` + `error`。必须记一条
 *     错误，但绝不能因为它把同渠道其它账号的数字抹掉——那等于用一个人的失败
 *     否认同渠道另一个人的余额。
 *
 * (2) 只统计 `active !== false` 的包。
 *     失效包会把**分母**撑大。buddy 实测带 4 个已失效的裂变包（各 total 100 /
 *     used 100 / remaining 0），算进去分母从 4539 变 4939，85.8% 就变成 78.9%。
 *     排除它们不会藏起任何剩余积分（失效包的 remaining 就是 0，加 0 不改变分子），
 *     只是不让一份已经花完的额度继续被当成"还欠着的额度"来摊薄百分比。
 *     明细里仍然列出全部包（`packageCount` 也是全量），信息不丢。
 *
 * (3) 剩余以 `balance.total` 为准。
 *     这个网关的包是**重叠**的：codearts 的「总积分包」remaining 恰好等于
 *     「基础积分包 + 赠送积分包」，把每个包的 remaining 加起来会重复计算。
 *     `balance.total` 是网关自己去过重的聚合值，有它就用它。
 *
 * (4) 分母三条分支：
 *     a. 存在 `remaining === balance.total` 的包 → 它就是那个聚合包，分母 =
 *        `balance.total + 它的 used`。codearts 实测 7150.69 + 349.31 = 7500，
 *        与它的 total 字段精确吻合。不能改成"把所有包的 used 加起来"：同一个
 *        used 在聚合包和它切出来的子包里各出现一次，加总得 7849.31，把 95.3%
 *        算成 91.1%。
 *     b. 没有聚合包，但 `|Σremaining − balance.total| < 0.005` → 各包相互独立，
 *        Σremaining 与 balance.total 是对同一份额度的两次独立读数。分母取
 *        `max(Σtotal, balance.total + Σused)`，取大值是为了让"报了 used 却没报
 *        total 的包"没法把分母压小。buddy / trae 走这条。
 *     c. 其它情况（没有明细，或形状不认识）→ **不出百分比**。
 *        这时没有任何可靠的分母。最容易犯的错是退回 `remaining / remaining`
 *        去凑 100%：那会在余额可能已经快花光的时候，给用户一个信心十足的
 *        100%。宁可只显示剩余数字、不显示百分比。
 *
 * (5) 单位只折叠拼写差异，不折叠语义差异（见 {@link pickUnit}）。
 *
 * @param {string} channel 渠道 id。
 * @param {unknown} raw `credits.balances` 的返回（可带信封）。
 * @param {number} [observedAt] 本次读取的时间戳（ms）。
 * @returns {{
 *   channel: string,
 *   state: 'ok' | 'empty' | 'error',
 *   nicknames: string[],
 *   remaining?: number,
 *   total?: number,
 *   percent?: number,
 *   unit?: string,
 *   packageCount: number,
 *   packages: object[],
 *   note?: string,
 *   error?: string,
 *   observedAt?: number,
 * }}
 */
export function normalizeChannelCredits(channel, raw, observedAt) {
  const payload = rawPayload(raw);
  const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];

  if (accounts.length === 0) {
    // 没绑账号是"还没登录"，是正常状态，不是错误、也不是 0 积分。
    return {
      channel,
      state: 'empty',
      nicknames: [],
      packageCount: 0,
      packages: [],
      note: '未在该渠道登录账号',
    };
  }

  const nicknames = [];
  const packages = [];
  const units = new Set();
  const failures = [];
  let remaining = 0;
  let total = 0;
  let anyNumber = false;

  for (const account of accounts) {
    const nickname = str(account?.nickname);
    if (nickname !== undefined && !nicknames.includes(nickname)) nicknames.push(nickname);

    const balance = account?.balance;
    if (balance === null || balance === undefined) {
      // 规则 (1)：账号级失败留在失败列表里，不碰同渠道其它账号的数字。
      failures.push(str(account?.error) ?? '余额不可用');
      continue;
    }

    const accountPackages = Array.isArray(balance.packages) ? balance.packages : [];
    // 规则 (2)：分母只算在用包；明细照旧全量收集。
    const activePackages = accountPackages.filter((pkg) => pkg?.active !== false);

    let packageRemaining = 0;
    let packageTotal = 0;
    let packageUsed = 0;

    for (const pkg of accountPackages) {
      const unit = str(pkg?.unit);
      if (unit !== undefined) units.add(unit);
      packages.push(pkg);
    }
    for (const pkg of activePackages) {
      const pkgRemaining = num(pkg?.remaining);
      const pkgTotal = num(pkg?.total);
      const pkgUsed = num(pkg?.used);
      if (pkgRemaining !== undefined) packageRemaining += pkgRemaining;
      if (pkgTotal !== undefined) packageTotal += pkgTotal;
      if (pkgUsed !== undefined) packageUsed += pkgUsed;
    }

    // 规则 (3)：聚合值优先。
    const gatewayTotal = num(balance.total);
    if (gatewayTotal !== undefined || packageRemaining !== 0) anyNumber = true;
    remaining += gatewayTotal !== undefined ? gatewayTotal : packageRemaining;

    if (gatewayTotal !== undefined) {
      // 规则 (4a)：结构上认出聚合包 —— 它的 remaining 等于 balance.total。
      // 同名包可能不止一个，取 used 最大的那个（真正的聚合包 used 最完整）。
      let aggregate = null;
      for (const pkg of activePackages) {
        if (num(pkg?.remaining) !== gatewayTotal) continue;
        const pkgUsed = num(pkg?.used) ?? 0;
        if (aggregate === null || pkgUsed > (num(aggregate?.used) ?? 0)) aggregate = pkg;
      }

      if (aggregate !== null) {
        total += gatewayTotal + (num(aggregate?.used) ?? 0);
      } else if (packageTotal > 0) {
        // 规则 (4b)：没有聚合包，要求各包能自己把 total 解释清楚。
        if (Math.abs(packageRemaining - gatewayTotal) < 0.005) {
          total += Math.max(packageTotal, gatewayTotal + packageUsed);
        }
      }
      // 规则 (4c)：其余情况让 total 保持原样 —— 于是 percent 缺失，而不是瞎猜。
    } else {
      // 网关没给聚合值，只能信各包自己的 total。
      total += packageTotal;
    }
  }

  if (!anyNumber && failures.length > 0) {
    // 有账号但一个数字都没读出来 —— 这才是 error（不是 empty）。
    return {
      channel,
      state: 'error',
      nicknames,
      packageCount: packages.length,
      packages,
      error: failures.join('; '),
    };
  }

  // 账号存在但一个数字都没读到（既没报错，也没返回余额）也是一种"没有数"，
  // 给它一句说明，免得界面上只剩一个光秃秃的短横线让人误以为是 0 积分。
  const note = anyNumber ? undefined : '该渠道账号未返回任何余额数字';

  return {
    channel,
    state: anyNumber ? 'ok' : 'empty',
    nicknames,
    remaining: anyNumber ? round4(remaining) : undefined,
    // total 必须为正才有意义：0 或负数做分母会得到 Infinity/NaN 或负百分比。
    total: total > 0 ? round4(total) : undefined,
    // 没有分母就不出百分比 —— 见规则 (4c)，绝不用 remaining/remaining 凑 100%。
    percent: total > 0 ? round1((remaining / total) * 100) : undefined,
    unit: pickUnit(units),
    packageCount: packages.length,
    packages,
    note,
    error: failures.length > 0 ? failures.join('; ') : undefined,
    observedAt: anyNumber ? observedAt : undefined,
  };
}

/**
 * 逐渠道读积分。
 *
 * 用 `Promise.all` + 每渠道独立 AbortController，而不是 `allSettled` 一把梭：
 * 单个渠道慢（gemini 常态）或报错时，要变成**它自己**的 error 行，不能拖住或取消
 * 别的渠道。超时也用固定文案报出来，否则用户看到的是 `AbortError` 这种无信息量
 * 的东西，分不清是"上游慢"还是"没登录"。
 *
 * @param {{call: Function}} rpc {@link makeChannelCreditsRpc} 的返回值。
 * @param {readonly string[]} channels 要读的渠道。
 * @param {number} [timeoutMs] 单渠道超时。
 * @returns {Promise<Array<ReturnType<typeof normalizeChannelCredits>>>} 与输入同序。
 */
export async function probeChannelCredits(rpc, channels, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const list = Array.isArray(channels) ? channels : [];
  const limit = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const observedAt = Date.now();

  return Promise.all(list.map(async (channel) => {
    const controller = new AbortController();
    let timedOut = false;
    // 定时器保持 referenced：它必须在 finally 里被 clearTimeout 掉，而不是靠 unref
    // 让事件循环悄悄退出。超时正是这条链要保证的行为，不能被"进程先走了"掩盖。
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limit);

    try {
      if (rpc === undefined || rpc === null || typeof rpc.call !== 'function') {
        throw new Error('内核未提供 connection 服务，无法读取积分');
      }
      const value = await rpc.call('credits.balances', { provider: channel }, controller.signal);
      return normalizeChannelCredits(channel, value, Date.now());
    } catch (error) {
      return {
        channel,
        state: 'error',
        nicknames: [],
        packageCount: 0,
        packages: [],
        error: timedOut ? `查询超时（${limit}ms）` : message(error),
        observedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }));
}
