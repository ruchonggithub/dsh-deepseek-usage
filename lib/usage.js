/**
 * dsh-quota-usage — 会话用量统计（回放式）。
 *
 * 数据源是宿主自己写的会话日志：
 *   `$DSH_HOME/sessions/<workspace-slug>/<sessionId>/session.v4.jsonl.zstd`
 * 每行一个事件，其中 `assistant/message` 带两样东西：
 *   · `data.message.source` = { provider, model }  —— 这条消息是谁答的；
 *   · `data.usage`         = { inputTokens, outputTokens, cacheReadTokens,
 *                              cacheWriteTokens, reasoningTokens, totalTokens }
 *
 * 为什么回放日志，而不是自己攒计数器：
 *   · 日志是模型调用真实发生的记录，宿主保证它持久化；插件自己的计数器会因为重启、
 *     并发、崩溃丢数，而且只能统计"装上之后"的部分。
 *   · 回放天然支持历史会话，也不需要任何请求路径上的埋点（不改变模型调用行为）。
 *   · 代价是 IO：所以按文件 mtime + size 做缓存，只重新解析变过的文件。
 *
 * 分层口径（三大计费类型 → 厂商 → 模型）：
 *   · 订阅型   —— 按月/按周期付固定费用，用量受窗口约束。codex-chatgpt / anthropic /
 *                kimi-coding / opencode / minimax 订阅端口。
 *   · 预充值型 —— 先充钱后按量扣，余额可见。DeepSeek / Moonshot / Z.ai / OpenRouter。
 *   · 积分型   —— 签到或活动发的积分，扣完为止，通常分账号。Trae / Buddy / Qoder /
 *                Coder / ZCode / Raccoon / Cline 等免费渠道。
 *   · 未分类   —— 白名单外的 provider id。不猜：猜错分类比没有分类更糟，界面按原样
 *                展示 provider id 并标注"未分类"。
 *
 * 只统计 assistant/message 的 usage：tool/result 与 user/message 不带 usage，把它们
 * 算进来只会得到一个偏大的数字。同一条消息在日志里可能出现被取代的中间态（流式重试），
 * 因此按 message.id 去重，保留最后一次。
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

/** 三大计费类型 + 未分类。顺序即界面展示顺序。 */
export const BILLING_KINDS = ['subscription', 'prepaid', 'credits', 'unknown'];

/**
 * provider id → 计费类型。白名单制：没登记的一律 unknown。
 *
 * 同一家厂商可能同时有预充值与订阅两种形态（DeepSeek 官方余额 vs 账号订阅、
 * MiniMax 充值 vs 订阅端口），所以这里按 **路由 id** 而不是按厂商归类——分类说的是
 * "这条路由怎么结算"，不是"这家公司卖什么"。
 */
const PROVIDER_BILLING = {
  // ── 订阅型 ──
  'codex-chatgpt': 'subscription',   // dsh-chatgpt-subscription 注册的 ChatGPT 订阅路由
  'openai-codex': 'subscription',
  'chatgpt-codex': 'subscription',
  anthropic: 'subscription',         // Claude Code 订阅
  'kimi-coding': 'subscription',
  opencode: 'subscription',
  'opencode-go': 'subscription',

  // ── 预充值型 ──
  'deepseek-official': 'prepaid',
  'deepseek-account': 'prepaid',
  deepseek: 'prepaid',
  moonshotai: 'prepaid',
  zai: 'prepaid',
  openrouter: 'prepaid',
  'minimax-cn': 'prepaid',

  // ── 积分型（dsh-free-model 的免费渠道）──
  trae: 'credits',
  buddy: 'credits',
  qoder: 'credits',
  'qoder-cn': 'credits',
  qodercn: 'credits',
  coder: 'credits',
  zcode: 'credits',
  raccoon: 'credits',
  cline: 'credits',
  minimax: 'credits',
  lobsterai: 'credits',
  loomy: 'credits',
  officeace: 'credits',
  accio: 'credits',
  codearts: 'credits',
  codebuddy: 'credits',
  workbuddy: 'credits',
  gemini: 'credits',
};

/** provider id 的大小写/空白归一（日志里的 id 与能力表可能拼写不同）。 */
function normalizeProvider(provider) {
  return typeof provider === 'string' ? provider.trim().toLowerCase() : '';
}

/**
 * provider id → 计费类型；未登记返回 'unknown'。
 * 不做模糊匹配：`trae-xxx` 这类账号后缀属于账号 id，不属于 provider id。
 */
export function billingKindOf(provider) {
  const id = normalizeProvider(provider);
  if (id === '') return 'unknown';
  return PROVIDER_BILLING[id] ?? 'unknown';
}

/** 该 provider 是否属于白名单（界面用它区分"未分类"与"明确分类"）。 */
export function isClassifiedProvider(provider) {
  return billingKindOf(provider) !== 'unknown';
}

/** 容忍字符串/数字，返回有限非负数或 0（统计口径里缺失即 0，不是 NaN）。 */
function count(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  return 0;
}

/** 空累加器。 */
function newAccumulator() {
  return {
    messages: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    firstAt: null,
    lastAt: null,
  };
}

/** 把一条 usage 累加进累加器（不改动入参，调用方负责赋值）。 */
function addUsage(target, usage, at) {
  const input = count(usage?.inputTokens);
  const output = count(usage?.outputTokens);
  const cacheRead = count(usage?.cacheReadTokens);
  const cacheWrite = count(usage?.cacheWriteTokens);
  const reasoning = count(usage?.reasoningTokens);
  // totalTokens 由上游给时以它为准；没给就用各分项之和（含缓存读写，与 DSH 的
  // token-meter 口径一致：缓存读入也是真实消耗的 token）。
  const reported = count(usage?.totalTokens);
  target.messages += 1;
  target.inputTokens += input;
  target.outputTokens += output;
  target.cacheReadTokens += cacheRead;
  target.cacheWriteTokens += cacheWrite;
  target.reasoningTokens += reasoning;
  target.totalTokens += reported > 0 ? reported : input + output + cacheRead + cacheWrite;
  if (Number.isFinite(at)) {
    if (target.firstAt === null || at < target.firstAt) target.firstAt = at;
    if (target.lastAt === null || at > target.lastAt) target.lastAt = at;
  }
  return target;
}

/**
 * 把一批 `assistant/message` 事件聚成「类型 → 厂商 → 模型 → 累加器」。
 *
 * 输入事件形状（只读这两个字段，其余忽略）：
 *   { type:'assistant/message', time, data:{ message:{ id, source:{provider,model} }, usage } }
 *
 * 返回的结构可直接 JSON 序列化给浏览器：
 *   {
 *     kinds: [
 *       { kind:'prepaid', totals:{...}, providers:[
 *           { provider:'deepseek-official', classified:true, totals:{...},
 *             models:[ { model:'deepseek-flash', ...totals } ] } ] }
 *     ],
 *     messages, unclassified: [providerId…]
 *   }
 */
export function summarize(events) {
  /** @type {Map<string, Map<string, Map<string, ReturnType<typeof newAccumulator>>>>} */
  const byKind = new Map();
  const seen = new Set();
  let messageCount = 0;

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type !== 'assistant/message') continue;
    const data = event.data;
    if (data === null || typeof data !== 'object') continue;
    const message = data.message ?? {};
    // 同一条消息的中间态（流式重试 / 被取代的分支）只保留最后一次：日志顺序即
    // 写入顺序，后来的覆盖先前的。
    const id = typeof message.id === 'string' ? message.id : '';
    const key = id === '' ? '' : `id:${id}`;
    const source = message.source ?? {};
    const provider = normalizeProvider(source.provider);
    const model = typeof source.model === 'string' && source.model.trim() !== '' ? source.model.trim() : '';
    const kind = billingKindOf(provider);
    const at = count(event.time) > 0 ? count(event.time) : NaN;

    if (key !== '') {
      // 同一条消息重复出现（流式重试 / 被取代的分支）只统计一次。实测 DSH 的日志里
      // 同 id 只出现一次，所以这里是防御性的：宁可少数一次，也不要重复累加。
      if (seen.has(key)) continue;
      seen.add(key);
    }

    if (!byKind.has(kind)) byKind.set(kind, new Map());
    const byProvider = byKind.get(kind);
    if (!byProvider.has(provider || '(unknown)')) byProvider.set(provider || '(unknown)', new Map());
    const byModel = byProvider.get(provider || '(unknown)');
    if (!byModel.has(model || '(unknown)')) byModel.set(model || '(unknown)', newAccumulator());

    addUsage(byModel.get(model || '(unknown)'), data.usage, at);
    messageCount += 1;
  }

  const kinds = [];
  for (const kind of BILLING_KINDS) {
    const byProvider = byKind.get(kind);
    if (!byProvider || byProvider.size === 0) continue;
    const total = newAccumulator();
    const providers = [];
    for (const [provider, byModel] of byProvider) {
      const providerTotal = newAccumulator();
      const models = [];
      for (const [model, acc] of byModel) {
        models.push({ model, ...acc });
        mergeInto(providerTotal, acc);
      }
      models.sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));
      providers.push({ provider, classified: kind !== 'unknown', ...providerTotal, models });
      mergeInto(total, providerTotal);
    }
    providers.sort((a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider));
    kinds.push({ kind, ...total, providers });
  }

  return {
    kinds,
    messages: messageCount,
    // 界面用它提示"有 N 个 provider 未分类"，让用户知道分类表需要补。
    unclassified: kinds.find((k) => k.kind === 'unknown')?.providers.map((p) => p.provider) ?? [],
  };
}

/** 把 acc 的分项并入 target（含时间窗）。 */
function mergeInto(target, acc) {
  target.messages += acc.messages;
  target.inputTokens += acc.inputTokens;
  target.outputTokens += acc.outputTokens;
  target.cacheReadTokens += acc.cacheReadTokens;
  target.cacheWriteTokens += acc.cacheWriteTokens;
  target.reasoningTokens += acc.reasoningTokens;
  target.totalTokens += acc.totalTokens;
  if (acc.firstAt !== null && (target.firstAt === null || acc.firstAt < target.firstAt)) target.firstAt = acc.firstAt;
  if (acc.lastAt !== null && (target.lastAt === null || acc.lastAt > target.lastAt)) target.lastAt = acc.lastAt;
  return target;
}

/** DSH home：`$DSH_HOME` 优先，否则 `~/.dsh`（与宿主 home-paths 同一口径）。 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  return path.join(os.homedir(), '.dsh');
}

/** 会话日志根目录。 */
export function sessionsRoot(home = resolveDshHome()) {
  return path.join(home, 'sessions');
}

/** zstd 帧魔数（RFC 8878 §3.1.1）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 把一份**多帧** zstd 文件解成文本。
 *
 * 为什么不能直接 `zstdDecompressSync(buf)`：DSH 是边写边压的，每批事件各自成为
 * 一个独立的 zstd 帧，于是同一个 `session.v4.jsonl.zstd` 里有几百个首尾相接的帧。
 * Node 24（DSH 运行时自带的版本）的 `zstdDecompressSync` **只解第一帧就停**，
 * 一份 671KB、569 帧的日志因此只吐出 `session` 头那一行，统计结果为 0；Node 26
 * 才解多帧。插件必须跑在宿主那版 Node 上，所以不能依赖新版行为。
 *
 * 做法：按魔数找出每个帧的起点，从该起点单独解一帧，再把各帧文本拼起来。
 *   · 帧起点用魔数扫描定位——zstd 帧之间没有长度前缀，只能这样切；
 *   · 魔数可能恰好出现在压缩数据里，所以从某个候选起点解不出来就跳过它（无害：
 *     真正的帧起点一定能解，误命中的候选只会解出乱码或抛错）；
 *   · 逐帧解压保证任何一帧损坏只丢那一帧（追加写入正在进行的最后一帧），不会
 *     让整份日志报废。
 *
 * @param {Buffer} raw 文件原始字节
 * @returns {string} 拼接后的文本
 */
export function decompressZstdFrames(raw) {
  if (!Buffer.isBuffer(raw) || raw.length === 0) return '';
  const offsets = [];
  let at = raw.indexOf(ZSTD_MAGIC, 0);
  while (at !== -1) {
    offsets.push(at);
    at = raw.indexOf(ZSTD_MAGIC, at + 1);
  }
  if (offsets.length === 0) {
    // 没有魔数：交给 zstd 自己报错（不是 zstd 文件，或用了可跳过帧格式）。
    return zlib.zstdDecompressSync(raw).toString('utf8');
  }
  const parts = [];
  let decoded = 0;
  for (let i = 0; i < offsets.length; i += 1) {
    // 切到**下一个候选起点**而不是切到文件末尾：Node 26 的 zstdDecompressSync 会把
    // 从起点开始的后续帧一并解出来，那样同一批数据会被算很多次（实测：3 帧拼起来
    // 逐起点解，得到 6 行而不是 3 行）。切出单帧才能保证两版 Node 结果一致。
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : raw.length;
    try {
      parts.push(zlib.zstdDecompressSync(raw.subarray(start, end)).toString('utf8'));
      decoded += 1;
    } catch {
      // 误命中的魔数，或正在写入的最后一帧：跳过。
    }
  }
  if (decoded === 0) {
    // 一帧都没解出来：可能是完全不同的编码，让标准解压抛出真正的错误。
    return zlib.zstdDecompressSync(raw).toString('utf8');
  }
  return parts.join('');
}

/** 一个会话文件的解压与逐行解析（只在需要重算时调用）。 */
export async function readSessionEvents(file) {
  const raw = await fs.readFile(file);
  const text = decompressZstdFrames(raw);
  const events = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // 半行（进程被杀在写日志中间）跳过：统计不该因为最后一行残缺而整份失败。
    }
  }
  return events;
}

/**
 * 会话日志 → 「这个会话最后用的是哪个模型」。
 *
 * 为什么从日志里读：宿主 Node 侧**没有**会话级模型服务。`agentDefaultModel`
 * 给的是全局默认选择，与会话无关；会话级的模型选择在**客户端**（`ctx.modelDirectories`
 * 按 sessionId 解析的投影）里，宿主 `apply(ctx)` 拿不到。日志是宿主自己写的，
 * 且每次请求都会落盘，所以按日志回放是这个位置唯一可靠的来源。
 *
 * 三处候选，取 **seq 最大**的那一条（谁最后写谁算数）：
 *
 *   · `model/selection`  —— 用户在界面上切模型时写一条。最直接，但**只有手动切过
 *     模型的会话才有**（本机实测 13/66），因此不能当唯一来源。
 *   · `request/header`   —— 每次模型请求写一条，`data.header.config.{provider,model}`。
 *     覆盖几乎全部会话。
 *   · `assistant/message` —— 每条回复带 `data.message.source.{provider,model}`。
 *     覆盖几乎全部会话。
 *
 * 三者**不冲突**：本机 66 个会话里 `model/selection` 的末值与末条 request/header、
 * 末条 assistant/message 完全一致（比对结果为空）。差别只在覆盖度，所以取并集、
 * 按 seq 排序，而不是"只读其中一种"。
 *
 * 形状不对一律当没有：返回 null 让调用方回落，绝不猜一个 provider 出来。
 *
 * @param {Array<object>} events 会话事件数组
 * @returns {{provider: string, model: string, from: string} | null}
 */
export function lastModelOf(events) {
  if (!Array.isArray(events)) return null;
  /** @type {{provider: string, model: string, from: string, seq: number} | null} */
  let best = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === null || typeof event !== 'object') continue;
    const type = typeof event.type === 'string' ? event.type : '';
    let provider = '';
    let model = '';
    if (type === 'model/selection') {
      const data = event.data;
      if (data === null || typeof data !== 'object') continue;
      provider = typeof data.provider === 'string' ? data.provider.trim() : '';
      model = typeof data.model === 'string' ? data.model.trim() : '';
    } else if (type === 'request/header') {
      const data = event.data;
      const header = data !== null && typeof data === 'object' ? data.header : null;
      const config = header !== null && typeof header === 'object' ? header.config : null;
      if (config === null || typeof config !== 'object') continue;
      provider = typeof config.provider === 'string' ? config.provider.trim() : '';
      model = typeof config.model === 'string' ? config.model.trim() : '';
    } else if (type === 'assistant/message') {
      const data = event.data;
      const message = data !== null && typeof data === 'object' ? data.message : null;
      const source = message !== null && typeof message === 'object' ? message.source : null;
      if (source === null || typeof source !== 'object') continue;
      provider = typeof source.provider === 'string' ? source.provider.trim() : '';
      model = typeof source.model === 'string' ? source.model.trim() : '';
    } else {
      continue;
    }
    if (provider === '' && model === '') continue;
    // seq 缺失时用下标代替：同一条日志内部的先后关系，下标与 seq 同序。
    const seq = typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : index;
    if (best === null || seq >= best.seq) best = { provider, model, from: type, seq };
  }
  if (best === null) return null;
  return { provider: best.provider, model: best.model, from: best.from };
}

/**
 * 单个会话的模型解析器（带缓存）。
 *
 * 为什么要缓存：一份 28.7MB / 2.3 万事件的日志解压 + 解析约 1.5s，而卡片每 30 秒
 * 心跳一次、每次心跳都会问一遍。按文件 mtime + size 失效——只要日志没被追加，
 * 结果就不会变（追加才会改变"最后用的模型"）。
 *
 * 只读、只解析一个文件：不扫全目录，不给无关会话付代价。
 *
 * @param {{home?: string}} [options]
 */
export function createSessionModelResolver({ home } = {}) {
  /** @type {Map<string, {mtimeMs: number, size: number, value: object|null}>} */
  const cache = new Map();

  /**
   * @param {string} sessionId 会话 id（目录名）
   * @returns {Promise<{provider: string, model: string, from: string} | null>}
   */
  async function resolve(sessionId) {
    const want = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (want === '') return null;
    const files = await listSessionFiles(sessionsRoot(home ?? resolveDshHome()), want);
    if (files.length === 0) return null;
    // 同一 id 理论上只有一个文件；真出现多个时取最后写的那个（最新的一份）。
    let newest = null;
    for (const file of files) {
      let stat;
      try {
        stat = await fs.stat(file);
      } catch {
        continue;
      }
      if (newest === null || stat.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: stat.mtimeMs, size: stat.size };
    }
    if (newest === null) return null;
    const hit = cache.get(newest.file);
    if (hit && hit.mtimeMs === newest.mtimeMs && hit.size === newest.size) return hit.value;
    let value = null;
    try {
      value = lastModelOf(await readSessionEvents(newest.file));
    } catch {
      // 解压失败（正在写入 / 版本不认）：当作"这次拿不到"，下次再试。
      value = null;
    }
    cache.set(newest.file, { mtimeMs: newest.mtimeMs, size: newest.size, value });
    return value;
  }

  return { resolve, clear: () => { cache.clear(); } };
}

/**
 * 收集会话根目录下的全部日志文件（含子目录）。
 * 用递归目录遍历而不是 glob：不同 workspace 的目录名是宿主生成的 slug，层级固定但
 * 名字不可预测，`**` 在 Node 里也要自己展开。
 *
 * `sessionId` 给出时只保留目录名等于它的那一个文件——会话内视图只统计当前会话，
 * 把别的会话的账算进来会让用户看到不属于这次对话的数字。
 */
export async function listSessionFiles(root = sessionsRoot(), sessionId = '') {
  const files = [];
  const want = typeof sessionId === 'string' ? sessionId.trim() : '';
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl.zstd')) {
        // 会话目录名就是会话 id（`session-<uuid>`）。给定 sessionId 时只收它自己。
        if (want !== '' && path.basename(dir) !== want) continue;
        files.push(full);
      }
    }
  }
  await walk(root);
  return files;
}

/**
 * 带缓存的统计器：文件 mtime + size 未变就复用上次解析结果，只重算变过的文件。
 *
 * 缓存按文件路径存「事件数组」而不是「汇总结果」，因为汇总要把所有文件合起来算；
 * 单文件事件数组的文件大小通常几十 KB，全机十几个会话也只是几 MB，可接受。
 * 不缓存压缩字节：解压后的对象更省 CPU。
 */
export function createUsageScanner({ home } = {}) {
  /** @type {Map<string, { mtimeMs:number, size:number, events:any[] }>} */
  const cache = new Map();
  /** @type {Map<string, any>} 按「是否限定会话」分开缓存汇总结果。 */
  const summaries = new Map();

  async function scanFor(sessionId) {
    const root = sessionsRoot(home ?? resolveDshHome());
    if (!existsSync(root)) {
      return { ...summarize([]), scannedAt: Date.now(), files: 0, cached: 0, sessionId: sessionId || null };
    }
    const files = await listSessionFiles(root, sessionId);
    const signatureParts = [];
    let cachedCount = 0;
    const all = [];
    for (const file of files) {
      let stat;
      try {
        stat = await fs.stat(file);
      } catch {
        continue;
      }
      signatureParts.push(`${file}:${stat.mtimeMs}:${stat.size}`);
      const hit = cache.get(file);
      if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
        all.push(hit.events);
        cachedCount += 1;
        continue;
      }
      try {
        const events = await readSessionEvents(file);
        cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, events });
        all.push(events);
      } catch {
        // 解压失败（正在被写入 / 版本不认）：跳过这个文件，下次再试。
      }
    }
    const bucket = sessionId || '*';
    const signature = signatureParts.join('|');
    const cached = summaries.get(bucket);
    if (cached !== undefined && cached.signature === signature) {
      return { ...cached.summary, cached: cachedCount, files: files.length, sessionId: sessionId || null };
    }
    const summary = summarize(all.flat());
    summaries.set(bucket, { signature, summary });
    return { ...summary, scannedAt: Date.now(), files: files.length, cached: cachedCount, sessionId: sessionId || null };
  }

  /** 全机统计（所有会话）。 */
  const scan = () => scanFor('');
  /** 单个会话的统计（会话内视图用）。 */
  const scanSession = (sessionId) => scanFor(sessionId);

  return {
    scan,
    scanSession,
    clear: () => { cache.clear(); summaries.clear(); },
  };
}
