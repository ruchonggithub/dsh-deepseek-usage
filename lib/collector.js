/**
 * dsh-quota-usage — 统一采集调度器 + 缓存。
 *
 * 这个模块存在的唯一理由：**把上游请求从展示路径上彻底摘出去**。
 *
 * 用户的原话是「所有的请求都通过统一的定时任务触发采集并缓存，展示区只读取缓存值，
 * 避免过于频繁采集导致被厂商拉黑」。于是职责边界非常硬：
 *
 *   · 只有 `start()` 排出的定时器（以及显式的 `collectNow()`）会调用采集函数；
 *   · `getSnapshot()` 是纯读取，同步返回，绝不触发任何 IO。它不是"按需刷新"，
 *     它**就是读缓存**。展示侧（RPC / HTTP 路由 / 客户端渲染）只调它。
 *
 * 为什么不许在 getSnapshot 里采集（这条最容易被"顺手优化"掉，所以写死在注释里）：
 *   1. 面板会轮询刷新，一次页面停留就能打出几十次请求。若 getSnapshot 触发采集，
 *      每个用户的每次刷新都会变成一次上游调用，厂商看到的是"频率失控的客户端"，
 *      轻则限流、重则封号 —— 正是用户要避免的事。
 *   2. 采集是异步的，getSnapshot 是同步契约。为了"不阻塞"而返回旧值、却在背后
 *      偷偷发起请求，等于把上游并发量和 UI 刷新次数绑死，缓存什么时候被写进去
 *      取决于谁先返回，无法推理、无法测试。
 *   3. 失败会传染。展示路径上发请求，意味着上游抖动直接打到 UI 主路径；而由定时
 *      采集器来采，失败可以被关在缓存里（保留旧值 + 标 stale），界面永远有东西可显示。
 *   所以：**要新数据就 collectNow()，要展示就读 getSnapshot()**，两者不交叉。
 *
 * 为什么定时器用 setTimeout 递归而不是 setInterval：
 *   · setInterval 按墙钟触发，不管上一次有没有结束。一次采集慢了 12 分钟，10 分钟的
 *     间隔就会在它结束前堆出下一次，采集函数被并发打穿。
 *   · 递归 setTimeout 是"上一次结束后再排下一次"，天然串行，堆积不可能发生；采集函数
 *     抛错也能在收尾后照常重排，定时器链不会因为一次异常断掉。
 *   · 运行时改间隔只需清掉句柄重排；setInterval 必须 clear + set，且改完的第一次
 *     触发点仍落在旧节奏上，错峰更麻烦。
 *
 * 时钟与定时器都可注入（`now` / `timers`），测试因此能用假时钟手动推进，完全不 sleep。
 */

/** 三类采集目标。顺序即界面上的展示顺序。 */
export const COLLECT_KINDS = Object.freeze(['credits', 'prepaid', 'subscription']);

/** 默认采集间隔：10 分钟（用户指定）。 */
export const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

/** 硬下限：1 分钟。再小就不是采集而是攻击了。 */
export const MIN_INTERVAL_MS = 60 * 1000;

/** 给界面用的建议下限：不低于 10 分钟（用户指定要写在 UI 上）。 */
export const RECOMMENDED_MIN_INTERVAL_MS = 10 * 60 * 1000;

const KIND_SET = new Set(COLLECT_KINDS);

/**
 * 归一化一个配置来的间隔值。
 *
 * 只接受真正的有限数字：字符串（含 '600000' 这种数字字符串）一律当"没配"回落默认值。
 * 为什么不顺手把字符串解析成数字？因为那会把一个配置层的类型错误（比如把秒当毫秒传、
 * 或把 '10m' 传进来）悄悄变成"看起来能用但其实不是用户意图"的频率。让它在配置层
 * 暴露，比在这里猜更安全。
 *
 * - 缺失 / null / undefined / 非数字 / NaN / Infinity / <=0 → DEFAULT_INTERVAL_MS
 * - 小于 MIN_INTERVAL_MS → 夹到 MIN_INTERVAL_MS，并让调用方知道被夹过
 *
 * @param {unknown} value 配置里的原始值
 * @returns {{ ms: number, clamped: boolean }}
 */
export function normalizeInterval(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return { ms: DEFAULT_INTERVAL_MS, clamped: false };
  }
  // 亚毫秒的间隔没有意义，四舍五入后统一按毫秒整数处理。
  const ms = Math.round(value);
  if (ms < MIN_INTERVAL_MS) return { ms: MIN_INTERVAL_MS, clamped: true };
  return { ms, clamped: false };
}

/**
 * 把采集函数抛出的任意值变成一句可展示的话。
 * 上游可能抛 Error、字符串、甚至 `{ code }` 对象 —— 界面要的是字符串，不能是 `[object Object]`。
 *
 * @param {unknown} error
 * @returns {string}
 */
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

/** 一个新 kind 的初始快照状态。 */
function initialState(kind, intervalMs) {
  return {
    kind,
    value: null,
    updatedAt: null,
    attemptedAt: null,
    nextAt: null,
    intervalMs,
    lastError: null,
    stale: true,
    collecting: false,
    failures: 0,
  };
}

/**
 * 创建采集器。
 *
 * @param {object} options
 * @param {Record<string, number>} [options.intervals] 三类各自的间隔（毫秒，未归一化也行）；缺省用 DEFAULT
 * @param {Record<string, () => Promise<any>>} options.collectors 三类各自的采集函数
 * @param {() => number} [options.now] 时钟注入（测试用）
 * @param {(msg: string) => void} [options.log] 日志出口（默认静默，避免刷屏）
 * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers] 定时器注入（测试用）
 */
export function createCollector({ intervals, collectors, now, log, timers } = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const warn = typeof log === 'function' ? log : () => {};
  // 只在确实传入完整定时器时使用注入实现；只要缺一半就整体回落到真实定时器，
  // 免得出现"排得进去、清不掉"的半吊子状态（那才是真正的定时器泄漏）。
  const timerApi = timers !== null && typeof timers === 'object'
    && typeof timers.setTimeout === 'function' && typeof timers.clearTimeout === 'function'
    ? timers
    : {
      // `unref()` 是必须的：定时采集是后台任务，不该成为进程活着的理由。
      // 没有它，宿主里一次 `stop()` 漏调（或测试里根本没调）就会让进程永远不退出——
      // 实测表现为测试跑完挂住、Node 进程不结束。宿主本身有 web server 撑着，
      // unref 不会让采集停摆；而它保证了本模块永远不会拖住任何宿主。
      setTimeout: (fn, ms) => {
        const handle = setTimeout(fn, ms);
        if (handle !== null && typeof handle === 'object' && typeof handle.unref === 'function') {
          handle.unref();
        }
        return handle;
      },
      clearTimeout: (handle) => clearTimeout(handle),
    };

  const fns = collectors !== null && typeof collectors === 'object' ? collectors : {};
  /** @type {Map<string, ReturnType<typeof initialState>>} */
  const states = new Map();
  /** @type {Map<string, Promise<void>>} 同 kind 的在飞采集，用于并发合流 */
  const inflight = new Map();
  /** @type {Map<string, unknown>} kind → 定时器句柄 */
  const handles = new Map();
  let running = false;

  for (const kind of COLLECT_KINDS) {
    const raw = intervals !== null && typeof intervals === 'object' ? intervals[kind] : undefined;
    const { ms, clamped } = normalizeInterval(raw);
    if (clamped) {
      warn(`[collector] ${kind} 的采集间隔 ${String(raw)}ms 低于下限，已提升到 ${ms}ms`);
    }
    states.set(kind, initialState(kind, ms));
  }

  // ── 读取面（纯同步，零 IO）────────────────────────────────────────────────

  /**
   * 读某个 kind 的缓存快照。
   *
   * 同步、无副作用、不发请求、不改状态 —— 这条契约是模块的核心，见文件头注释。
   * 返回的是浅拷贝：调用方改字段不会污染内部状态；但 `value` 仍是采集结果对象本身
   * （上游结果可能很大，每次读都深拷贝不划算），展示方**不得修改**它。
   *
   * @param {string} kind
   */
  function getSnapshot(kind) {
    const state = states.get(kind);
    if (state === undefined) {
      // 读快照处在展示路径上：宁可给一个空快照，也不能抛异常把面板打崩。
      warn(`[collector] getSnapshot 收到未知 kind：${String(kind)}`);
      return {
        kind,
        value: null,
        updatedAt: null,
        attemptedAt: null,
        nextAt: null,
        intervalMs: DEFAULT_INTERVAL_MS,
        lastError: null,
        stale: true,
        collecting: false,
        failures: 0,
      };
    }
    return {
      kind: state.kind,
      value: state.value,
      updatedAt: state.updatedAt,
      attemptedAt: state.attemptedAt,
      nextAt: state.nextAt,
      intervalMs: state.intervalMs,
      lastError: state.lastError,
      stale: state.stale,
      collecting: state.collecting,
      failures: state.failures,
    };
  }

  /** 某个 kind 当前的采集间隔（毫秒）。未知 kind 给出默认值而不抛。 */
  function intervalOf(kind) {
    const state = states.get(kind);
    return state === undefined ? DEFAULT_INTERVAL_MS : state.intervalMs;
  }

  /** 定时器是否在跑（接线方在卸载时可以先问一下，再决定要不要 stop）。 */
  function isRunning() {
    return running;
  }

  // ── 采集面 ────────────────────────────────────────────────────────────────

  /**
   * 采集一个 kind。
   *
   * 合流：同一 kind 已有一次在飞时直接复用它的 Promise，绝不并发打两次上游 ——
   * 定时器触发撞上手动刷新是常态，这层保护是"不被拉黑"的第二道闸。
   *
   * 永不 reject：失败只落到快照里（`lastError` / `failures` / `stale:true`）。
   * 因为调用方之一是定时器回调，一个没有 await 的 rejection 在宿主里会升级成
   * uncaught exception，把整个插件带下去；而"失败"本身完全可表达在快照里。
   */
  function collectOne(kind) {
    const state = states.get(kind);
    if (state === undefined) {
      warn(`[collector] collectNow 收到未知 kind：${String(kind)}`);
      return Promise.resolve();
    }
    const existing = inflight.get(kind);
    if (existing !== undefined) return existing;

    const fn = fns[kind];
    // 合流用的 Promise 必须**先**进 map 再开始干活。
    // 反过来的写法（先跑 async 再 set）在采集函数同步抛错时会踩坑：async 函数体会
    // 同步执行到 finally，那时 map 里还没有条目，`delete` 等于空操作，紧接着
    // `set` 又把一个已落地的 Promise 塞进去 —— 这个 kind 从此永远命中"在飞"分支，
    // 再也不会上游了（且毫无报错）。用显式 deferred + 身份校验收尾，杜绝这个泄漏。
    let settle;
    const promise = new Promise((resolve) => {
      settle = resolve;
    });
    inflight.set(kind, promise);

    const run = async () => {
      state.collecting = true;
      state.attemptedAt = clock();
      try {
        if (typeof fn !== 'function') throw new Error('collectorMissing');
        const value = await fn();
        // 成功才覆盖 value / updatedAt —— 失败时旧值必须留着，界面上"上次的钱"
        // 远比"一片空白"有用。
        state.value = value;
        state.updatedAt = clock();
        state.lastError = null;
        state.failures = 0;
        state.stale = false;
      } catch (error) {
        state.failures += 1;
        state.lastError = describeError(error);
        // 失败不等于没有值：`value` / `updatedAt` 原样保留，只把 stale 立起来，
        // 让界面能同时表达"这是 10 分钟前的数字"和"刚才那次刷新失败了"。
        state.stale = true;
        warn(`[collector] ${kind} 采集失败（连续第 ${state.failures} 次）：${state.lastError}`);
      } finally {
        state.collecting = false;
      }
    };

    run()
      .catch((error) => warn(`[collector] ${kind} 采集收尾异常：${describeError(error)}`))
      .then(() => {
        // 只在 map 里还是本次这一个时才清，避免误删后来者的条目。
        if (inflight.get(kind) === promise) inflight.delete(kind);
        settle();
      });

    return promise;
  }

  /**
   * 立即采集一次，**不改变定时器节奏**（已排好的 nextAt 保持不动）。
   * kind 省略则三类都采（并行，各自独立落地）。
   *
   * 手动刷新即便在 `stop()` 之后也照常可用 —— 它不依赖定时器。
   *
   * @param {string} [kind]
   * @returns {Promise<void>}
   */
  function collectNow(kind) {
    if (kind === undefined || kind === null) {
      return Promise.all(COLLECT_KINDS.map((each) => collectOne(each))).then(() => undefined);
    }
    return collectOne(kind);
  }

  // ── 调度面 ────────────────────────────────────────────────────────────────

  function clearTimer(kind) {
    const handle = handles.get(kind);
    if (handle !== undefined) {
      timerApi.clearTimeout(handle);
      handles.delete(kind);
    }
  }

  /**
   * 给一个 kind 排下一次采集（递归 setTimeout）。
   *
   * 触发点的算法是"现在 + 间隔"。采集耗时因此天然被排除在间隔之外：占用的总周期
   * 是 interval + 采集耗时，永远不会堆积（代价是漂移，而漂移对 10 分钟级的采集
   * 完全无害，反而更礼貌）。
   */
  function schedule(kind) {
    const state = states.get(kind);
    if (state === undefined) return;
    if (!running || typeof fns[kind] !== 'function') {
      // 没有采集函数的 kind 不排定时器：空转的定时器只会白白消耗事件循环。
      clearTimer(kind);
      state.nextAt = null;
      return;
    }
    clearTimer(kind);
    const delay = state.intervalMs;
    state.nextAt = clock() + delay;
    const handle = timerApi.setTimeout(() => {
      handles.delete(kind);
      state.nextAt = null;
      // collectOne 不抛；这里的 catch 是二道保险：无论发生什么，链都不能断。
      Promise.resolve()
        .then(() => collectOne(kind))
        .catch((error) => warn(`[collector] ${kind} 定时采集异常：${describeError(error)}`))
        .then(() => {
          schedule(kind);
        });
    }, delay);
    handles.set(kind, handle);
  }

  /** 启动定时器。幂等：重复调用不会叠加。 */
  function start() {
    if (running) return;
    running = true;
    for (const kind of COLLECT_KINDS) schedule(kind);
  }

  /**
   * 停掉所有定时器。
   *
   * 注意"停"的语义：只拆定时器，不强杀已经在飞的那次采集 —— 中断一个进行中的
   * 上游请求既省不下配额，又会让它落地成一次错误。那次采集会正常收尾到缓存里，
   * 之后不再有新的自动采集。`collectNow()` 仍可手工调用。
   */
  function stop() {
    running = false;
    for (const kind of COLLECT_KINDS) {
      clearTimer(kind);
      const state = states.get(kind);
      if (state !== undefined) state.nextAt = null;
    }
  }

  /**
   * 运行时改采集频率。只处理传入的 kind，其余保持原值；间隔未变的 kind 不重排
   * （避免把一次无关的配置写入变成一次定时器抖动）。
   *
   * @param {Record<string, number>} next
   */
  function setIntervals(next) {
    if (next === null || typeof next !== 'object') return;
    for (const kind of COLLECT_KINDS) {
      if (!Object.prototype.hasOwnProperty.call(next, kind)) continue;
      const raw = next[kind];
      const { ms, clamped } = normalizeInterval(raw);
      if (clamped) {
        warn(`[collector] ${kind} 的采集间隔 ${String(raw)}ms 低于下限，已提升到 ${ms}ms`);
      }
      const state = states.get(kind);
      if (state === undefined || state.intervalMs === ms) continue;
      state.intervalMs = ms;
      // 在跑就立刻按新间隔重排；没在跑就只记住，等 start() 时生效。
      if (running) schedule(kind);
    }
  }

  return {
    getSnapshot,
    start,
    stop,
    collectNow,
    intervalOf,
    setIntervals,
    isRunning,
  };
}
