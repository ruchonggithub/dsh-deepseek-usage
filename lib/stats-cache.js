/**
 * dsh-quota-usage — 用量统计的**后台预计算**缓存。
 *
 * 这个模块存在的理由与 lib/collector.js 完全相同，只是对象从"上游账户请求"换成了
 * "会话日志扫描"：
 *
 *   · 只有 `start()` 排出的定时器、以及显式的 `refresh()` 会读日志；
 *   · `get()` 是**纯读缓存**，同步返回，绝不 stat、绝不解析。
 *
 * 为什么不许在请求路径上扫（这条最容易被"顺手优化"掉，所以写死在注释里）：
 *   1. 统计页会被反复打开。每次打开都解压全部会话日志，一次就是几百毫秒到几秒的
 *      同步 IO + 解压，宿主的事件循环被拖住，侧边栏卡片跟着卡。
 *   2. `lib/usage.js` 的 mtime+size 缓存只省"没变的文件"的解析；**文件遍历与 stat
 *      仍然全量发生**，而这恰恰是用户报的"打开才扫"。
 *   3. 用户在会话里说话时日志一直在追加，缓存几乎每一轮都有失效文件——"打开时才算"
 *      等于每次打开都在算增量。
 *   所以：**要新数据就 refresh()，要展示就读 get()**，两者不交叉。
 *
 * 与 collector 的差别（为什么不直接复用 createCollector）：
 *   · collector 的键是固定的三类（credits / prepaid / subscription），值是"采集函数
 *     返回的对象"；而统计要按 `session=<id>` / `scope=workspace` 分桶，**键是动态的**
 *     （有多少会话就有多少桶）。
 *   · collector 的误差语义是"失败保留旧值 + stale"；统计这边还要多一层"从没算过"
 *     （state: 'computing'），不能用一个 initialSnapshot = null 表达就完事——空结果与
 *     未计算必须能分开，否则界面会把"还没算"显示成"0 用量"。
 * 但**间隔归一化仍然复用 collector 的 normalizeInterval**，不另写一套夹取。
 *
 * 调度用递归 setTimeout 而不是 setInterval，理由与 collector 相同：一次计算慢了
 * 12 分钟，10 分钟的间隔就会在它结束前堆出下一次。运行时改间隔只清句柄重排。
 * 时钟与定时器可注入，测试因此能用假时钟手动推进，完全不 sleep。
 */

import { normalizeInterval, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS } from './collector.js';

/** 预计算覆盖的三种视图。值即桶键。 */
export const STATS_SCOPES = Object.freeze(['machine', 'workspace', 'session']);

/**
 * 逾期阈值（以间隔为单位）：超过 2 个间隔没算成，就认为这份缓存"已经该更新了"。
 *
 * 为什么是 2 而不是 1：一轮计算失败（日志正在写、解压失败）之后立刻标过期，
 * 会让界面在一次抖动里闪两次状态。留一个间隔的余量，一次失败不算过期，两次才算。
 * 注意它与 `stale` **不是一回事**——`stale` 说的是"日志真的比缓存新"（数据判据），
 * 这个说的是"定时器看起来没在正常工作"（调度判据）。两者都给，界面可以分别表达。
 */
export const OVERDUE_INTERVALS = 2;

/** 一个桶的初始状态：**从没算过**。 */
function emptyBucket() {
  return {
    value: null,
    computedAt: null,
    signature: null,
    lastError: null,
    computing: false,
    failures: 0,
    // `stale` 只在 refreshStale() 拿到两份可比对的指纹之后才有意义；
    // `staleKnown` 说明"这个结论是量出来的还是默认的"——从没算过的桶不该被标成过期。
    stale: false,
    staleKnown: false,
  };
}

/**
 * 创建统计预计算缓存。
 *
 * @param {object} options
 * @param {() => Promise<any>} options.computeMachine   全机统计（含 cost）
 * @param {() => Promise<any>} options.computeWorkspace 工作区统计（含 cost）
 * @param {(sessionId: string) => Promise<any>} options.computeSession 单会话统计（含 cost）
 * @param {(sessionId?: string) => Promise<string>} options.signature 日志指纹（只 stat）
 * @param {number} [options.intervalMs] 初始间隔（未归一化也行）
 * @param {() => number} [options.now] 时钟注入
 * @param {(msg: string) => void} [options.log] 日志出口
 * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers] 定时器注入
 */
export function createStatsCache({
  computeMachine,
  computeWorkspace,
  computeSession,
  signature,
  intervalMs,
  now,
  log,
  timers,
} = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const warn = typeof log === 'function' ? log : () => {};
  const timerApi = timers !== null && typeof timers === 'object'
    && typeof timers.setTimeout === 'function' && typeof timers.clearTimeout === 'function'
    ? timers
    : {
      setTimeout: (fn, ms) => {
        const handle = setTimeout(fn, ms);
        if (handle !== null && typeof handle === 'object' && typeof handle.unref === 'function') {
          handle.unref();
        }
        return handle;
      },
      clearTimeout: (handle) => clearTimeout(handle),
    };

  const initial = normalizeInterval(intervalMs);
  let interval = initial.ms;
  let clamped = initial.clamped;

  /** @type {Map<string, ReturnType<typeof emptyBucket>>} */
  const buckets = new Map();
  /** 参与预计算的会话 id 集合（由 refresh 过程中发现，供预热与过期判定使用）。 */
  const sessionIds = new Set();

  let running = false;
  let handle = null;
  let nextAt = null;
  let inFlight = null;

  function bucketOf(key) {
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = emptyBucket();
      buckets.set(key, bucket);
    }
    return bucket;
  }

  /**
   * 算一个桶。
   *
   * 永不 reject：调用方之一是定时器回调，一个没有 await 的 rejection 在宿主里会升级成
   * uncaught exception，把整个插件带下去；而"失败"完全可表达在桶状态里。
   *
   * 失败时 `value` / `computedAt` 原样保留——"10 分钟前的数字 + 一句失败说明"远比
   * "一片空白"有用（与 collector 同一口径）。
   */
  async function computeBucket(key, run, sigOf) {
    const bucket = bucketOf(key);
    if (bucket.computing) return;
    bucket.computing = true;
    try {
      const sig = typeof sigOf === 'function' ? await sigOf() : '';
      const value = await run();
      bucket.value = value;
      bucket.computedAt = clock();
      bucket.signature = sig;
      bucket.lastError = null;
      bucket.failures = 0;
      // 刚算完：这份数据与当时的指纹一致，明确不是过期。
      bucket.stale = false;
      bucket.staleKnown = true;
    } catch (error) {
      bucket.failures += 1;
      bucket.lastError = describeError(error);
      warn(`[stats] ${key} 计算失败（连续第 ${bucket.failures} 次）：${bucket.lastError}`);
    } finally {
      bucket.computing = false;
    }
  }

  /**
   * 重算**所有**已知视图：全机、工作区、以及每个已发现会话。
   *
   * 为什么一次算全部而不是"打开哪个算哪个"：用户要的是后台提前算，打开只读。
   * 若按需算单桶，第一次打开某个会话仍然要等——那就退回原状了。
   *
   * 合流：已有一次在飞时直接复用它的 Promise，绝不并发算两轮（定时 tick 撞上手动
   * 刷新是常态，两轮并发只会互相拖慢、并让 computedAt 乱序）。
   *
   * 合流的边界（数据新鲜度）由调用方收尾：并进的一轮若是**本次调用之前**启动的，
   * 它算的可能已是旧日志——显式刷新路径要在合流之后校验指纹、必要时再排一轮
   * （见 index.js 统计路由 POST 分支的有界循环）。
   *
   * @returns {Promise<void>}
   */
  function refresh() {
    if (inFlight !== null) return inFlight;
    const run = async () => {
      // 全机：顺带把"这台机器上有哪些会话"探出来（工作区统计与单会话桶都要用）。
      await computeBucket('machine', computeMachine, () => signature(''));
      // 工作区统计自己会遍历注册表里的会话，不依赖上面探到的列表。
      await computeBucket('workspace', computeWorkspace, () => signature(''));
      const discovered = await collectSessionIds();
      for (const id of discovered) sessionIds.add(id);
      for (const id of sessionIds) {
        await computeBucket(`session:${id}`, () => computeSession(id), () => signature(id));
      }
    };
    inFlight = run()
      .catch((error) => warn(`[stats] 预计算收尾异常：${describeError(error)}`))
      .then(() => {
        inFlight = null;
      });
    return inFlight;
  }

  /**
   * 从全机统计的结果里列出会话 id。
   *
   * 统计的 `summarize()` 输出里没有会话 id（它是把多份日志合成一份，匿名化了），
   * 所以会话集合必须另外拿。这里让它可注入：宿主传一个"枚举会话目录"的实现。
   */
  let sessionEnumerator = null;
  function setSessionEnumerator(fn) {
    sessionEnumerator = typeof fn === 'function' ? fn : null;
  }
  /**
   * 列出要预计算的会话 id。
   *
   * **必须 await**：宿主的枚举实现要遍历会话目录（`listSessionFiles` 是异步的），
   * 传进来的因此是 async 函数。早期版本这里写的是同步调用 `sessionEnumerator()`
   * 再 `Array.isArray`，于是拿到的是一个 Promise → 判成"不是数组" → 返回 `[]`。
   * 后果不是报错而是**静默为空**：`refresh()` 只算全机与工作区，一个会话桶都不建，
   * 用户单独勾「会话」时永远是 `computing`——数据明明在日志里。
   *
   * 同步实现仍然支持（返回值不是 Promise 就直接用），这样注入方不必被迫改成 async。
   */
  async function collectSessionIds() {
    if (sessionEnumerator === null) return [];
    try {
      const list = await sessionEnumerator();
      if (!Array.isArray(list)) return [];
      return list.filter((id) => typeof id === 'string' && id.trim() !== '');
    } catch {
      // 枚举失败不能把整轮预计算带下去：全机/工作区那两个桶仍然有效。
      return [];
    }
  }

  // ── 调度面 ────────────────────────────────────────────────────────────────

  function clearTimer() {
    if (handle !== null) {
      timerApi.clearTimeout(handle);
      handle = null;
    }
    nextAt = null;
  }

  function schedule() {
    if (!running) {
      clearTimer();
      return;
    }
    clearTimer();
    nextAt = clock() + interval;
    handle = timerApi.setTimeout(() => {
      handle = null;
      nextAt = null;
      Promise.resolve()
        .then(() => refresh())
        .catch((error) => warn(`[stats] 定时预计算异常：${describeError(error)}`))
        .then(() => {
          schedule();
        });
    }, interval);
  }

  /** 启动定时器。幂等。 */
  function start() {
    if (running) return;
    running = true;
    schedule();
  }

  /** 停掉定时器。不强杀在飞的那一轮（它会正常收尾到缓存里）。 */
  function stop() {
    running = false;
    clearTimer();
  }

  /**
   * 运行时改间隔。未变的间隔不重排（避免无关的配置写入变成一次定时器抖动）。
   * @param {unknown} next
   */
  function setIntervalMs(next) {
    const normalized = normalizeInterval(next);
    if (normalized.clamped) {
      warn(`[stats] 统计间隔 ${String(next)}ms 低于下限，已提升到 ${normalized.ms}ms`);
    }
    clamped = normalized.clamped;
    if (interval === normalized.ms) return;
    interval = normalized.ms;
    if (running) schedule();
  }

  // ── 读取面（纯同步，零 IO）────────────────────────────────────────────────

  /**
   * 读一个视图的缓存。**不 stat、不解析、不发起任何 IO。**
   *
   * @param {'machine'|'workspace'} scope 或传 'session' 且给 sessionId
   * @param {string} [sessionId]
   * @returns {{
   *   state: 'ready'|'computing',
   *   value: any|null,
   *   computedAt: number|null,
   *   stale: boolean,
   *   staleKnown: boolean,
   *   overdue: boolean,
   *   intervalMs: number,
   *   nextAt: number|null,
   *   lastError: string|null,
   * }}
   */
  function get(scope, sessionId) {
    const key = scope === 'session' ? `session:${sessionId ?? ''}` : scope;
    const bucket = buckets.get(key) ?? emptyBucket();
    const ready = bucket.value !== null;
    return {
      // 从没算成过 → computing（**不是** ready + 空数据）。
      // 这一步是这整个模块最重要的一行：把它写成 ready 会让界面显示"0 用量"。
      state: ready ? 'ready' : 'computing',
      value: bucket.value,
      computedAt: bucket.computedAt,
      stale: bucket.stale === true,
      staleKnown: bucket.staleKnown === true,
      // 调度层面的逾期（与 stale 不同，见 OVERDUE_INTERVALS 的注释）。
      overdue: bucket.computedAt !== null && clock() - bucket.computedAt > interval * OVERDUE_INTERVALS,
      intervalMs: interval,
      nextAt,
      lastError: bucket.lastError,
    };
  }

  /**
   * 用当前日志指纹刷新每个桶的 `stale`。
   *
   * 由请求路径调用，但**只 stat**（`signature()` 不解压）。这是"日志比缓存新"的
   * 唯一判据：不能拿"距上次计算多久"猜，那会在日志没变时误报过期。
   *
   * 一个桶在并发里被 stat 的时候可能正好有一轮 refresh 在跑；那种情况跳过它
   * （下一轮 tick 会把 stale 重置）。宁可不更新一个布尔，也不要读半截状态。
   *
   * @param {'machine'|'workspace'} scope
   * @param {string} [sessionId]
   */
  async function refreshStale(scope, sessionId) {
    const key = scope === 'session' ? `session:${sessionId ?? ''}` : scope;
    const bucket = buckets.get(key);
    if (bucket === undefined) return;
    if (bucket.computing) return;
    let sig;
    try {
      sig = scope === 'session' ? await signature(sessionId ?? '') : await signature('');
    } catch {
      // stat 失败：不知道新不新，保持上一轮的结论（不要把"读不到"说成"过期"）。
      return;
    }
    if (bucket.computing) return;
    if (bucket.signature === null) {
      // 从没算成过：连基准都没有，谈不上"比缓存新"。
      bucket.staleKnown = false;
      bucket.stale = false;
      return;
    }
    bucket.staleKnown = true;
    bucket.stale = sig !== bucket.signature;
  }

  function clear() {
    buckets.clear();
    sessionIds.clear();
  }

  return {
    start,
    stop,
    refresh,
    get,
    refreshStale,
    setIntervalMs,
    setSessionEnumerator,
    clear,
    /** 当前生效间隔（已夹取）。 */
    get intervalMs() { return interval; },
    /** 配置值是否被下限夹过。 */
    get clamped() { return clamped; },
    /** 定时器在跑吗。 */
    get running() { return running; },
    /** 下一次预计算的时刻（没排时为 null）。 */
    get nextAt() { return nextAt; },
  };
}

/** 把任意抛出物变成一句可展示的话（与 collector 的 describeError 同口径）。 */
function describeError(error) {
  if (error instanceof Error) {
    const message = typeof error.message === 'string' ? error.message.trim() : '';
    return message === '' ? error.name || 'Error' : message;
  }
  if (typeof error === 'string') {
    const text = error.trim();
    return text === '' ? 'unknownError' : text;
  }
  if (error === null || error === undefined) return 'unknownError';
  try {
    const text = JSON.stringify(error);
    return typeof text === 'string' && text !== '' && text !== '{}' ? text : 'unknownError';
  } catch {
    return 'unknownError';
  }
}

/** 导出给调用方构造默认值（避免各处再写一遍 600000 / 60000）。 */
export { DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS };
