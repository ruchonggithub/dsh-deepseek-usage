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
 * ── 2026-11 内存事故与缓存形态（重要，改动前必读）───────────────────────
 *
 * 这个模块曾经把每个文件解析出的**完整事件数组**缓存在扫描器里（`cache.set(file,
 * { events })`），以为"全机十几个会话也只是几 MB"。实际排查时的语料是
 * **321 个日志文件、压缩共 473.9MB、解压后 1980.8MB 文本**，事件数组里还带着完整的
 * 消息正文，解析成对象后全量驻留达到数 GB——宿主启动 10 分钟后统计定时器第一次
 * tick，扫描进行到一半就把 V8 默认 ~4GB 堆上限顶爆，`JavaScript heap out of memory`
 * 猝死，用户重启一次崩一次。
 *
 * 现在的缓存形态（两步，第二步是用户的进一步要求："计算结果的缓存不该一直占着
 * 内存，存在文件中就行"）：
 *   · 第一步：只缓存**用量 record**而不是事件——解析时从每条 `assistant/message`
 *     事件里只抽出 `{ id, provider, model, at, usage 六个数字 }`，事件对象（含
 *     正文）当场丢弃，堆里不再有 GB 级驻留；
 *   · 第二步：record 与汇总结果**全部落盘**（`$DSH_HOME/storages/dsh-quota-usage/
 *     usage-cache/`，与 price-table.json 同一命名空间约定，见 lib/price-store.js）。
 *     扫描器在堆内**零驻留**：扫描瞬间从磁盘把 record 顺序读进来、边折叠边丢弃，
 *     读完即释放。语料再怎么涨，宿主堆的占用都与它无关；代价只是每轮多读一些
 *     小文件（全语料的 record 缓存也就几十 MB，OS 页缓存一热就是纯 CPU 的 JSON 解析）。
 *
 * 跨文件的 message.id 去重**没有**因为缓存形态变化而丢：它在汇总阶段完成——
 * 折叠器把所有文件的 record（从磁盘缓存顺序读入）流过同一个一次性 seen 集合，
 * 先到的计一次，后面的跳过。这保住了两个承重语义（见 lib/workspaces.js 里
 * summaryFingerprint 的注释，那里有实测数字）：
 *   · 会话副本（分叉/复制出的内容完全相同的两份日志）在全机视图只计一次；
 *   · 分叉会话共享的那段历史（同 id 的前缀消息）也只计一次。
 * 若改成"每文件各自汇总再相加"，全机合计会从 4.2 亿 token 虚涨到 6.9 亿——
 * 那不是误差，是一整份账单。
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
 * 因此按 message.id 去重，只计一次。
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

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

// ── 磁盘缓存：record 与汇总结果的驻留位置 ──────────────────────────────
//
// 缓存全部落盘、堆内零驻留（见文件头的内存事故一节）。目录遵循宿主约定
// `$DSH_HOME/storages/<插件命名空间>/`——lib/price-store.js 的 price-table.json、
// lib/subscription.js 的 dsh-chatgpt-subscription 目录都是同一层。
//
//   usage-cache/records/<sha1(路径)>.json    每个会话日志的用量 record
//   usage-cache/summaries/<桶名>.json        每个桶（全机 / 单会话）的汇总结果
//
// 写入走「临时文件 + rename」的原子替换；读取失败、JSON 损坏、内嵌校验字段对不上，
// 一律当缓存未命中——重新推导并覆写。缓存坏了不报错、自愈，最坏只是多解压一次日志。

/** 插件命名空间（= 包名去掉 scope），与 price-store 的 STORE_DIR_NAME 同口径。 */
const STORE_DIR_NAME = 'dsh-quota-usage';

/** 用量统计缓存的根目录（record 与汇总都落在这下面）。单独导出给测试与排障。 */
export function usageCacheRoot(home = resolveDshHome()) {
  return path.join(home, 'storages', STORE_DIR_NAME, 'usage-cache');
}

/** 会话文件路径 → record 缓存文件名。sha1 足够防碰撞，且条目内还嵌着原路径兜底校验。 */
function recordsCacheKey(file) {
  return createHash('sha1').update(file).digest('hex');
}

/**
 * 桶名 → 汇总缓存文件名。`'*'`（全机）映射为定长哨兵 `__all__`；会话 id 只保留
 * 文件名安全字符（宿主生成的会话目录名本来就是 `session-<uuid>` 或裸 uuid）。
 */
function summariesCacheKey(bucket) {
  const raw = bucket === '*' ? '__all__' : bucket;
  return raw.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** 读一个 JSON 文件；不存在、损坏、编码不对一律返回 null（= 缓存未命中）。 */
async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 原子写：先写带序号的 `.tmp` 再 rename 覆盖。
 * rename 在 Windows 上是覆盖式（libuv 用 MOVEFILEEX REPLACE_EXISTING）。
 * 临时文件名带自增序号：并发写同一路径（后台写入互撞）时互不干扰，
 * 给失败的一方留下的是多一次重算，而不是坏缓存。
 */
let pendingWriteSeq = 0;
async function writeJsonAtomic(file, value) {
  pendingWriteSeq += 1;
  const tmp = `${file}.${pendingWriteSeq}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value));
  await fs.rename(tmp, file);
}

/**
 * 把缓存落盘/清退排到后台：**不挡扫描的返回路径**，返回在后台落定的 Promise。
 *
 * 为什么必须后台化：预计算的响应链路对延迟敏感——刷新一轮会串行算全机、
 * 工作区、每个会话的桶，每桶若同步等 mkdir+写+rename，几轮 fs 开销叠加后，
 * 在飞合流（statsCache.refresh 的 inFlight 语义）会把后到的强制刷新并进
 * 旧一轮，用户 POST 强制重算拿到的就是旧数字。写缓存只是加速器：
 * 失败/被并发删掉，代价都是下次重算，绝不值得拿正确性去换。
 */
function persistInBackground(run) {
  return run().catch(() => { /* 缓存写失败不影响本次结果，下次重算 */ });
}

/** zstd 帧魔数（RFC 8878 §3.1.1）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 逐帧产出解压文本（生成器）。
 *
 * 为什么不能直接 `zstdDecompressSync(buf)`：DSH 是边写边压的，每批事件各自成为
 * 一个独立的 zstd 帧，于是同一个 `session.v4.jsonl.zstd` 里有几百个首尾相接的帧。
 * Node 24（DSH 运行时自带的版本）的 `zstdDecompressSync` **只解第一帧就停**，
 * 一份 671KB、569 帧的日志因此只吐出 `session` 头那一行，统计结果为 0；Node 26
 * 才解多帧。插件必须跑在宿主那版 Node 上，所以不能依赖新版行为。
 *
 * 做法：按魔数找出每个帧的起点，从该起点单独解一帧，逐帧 yield 文本：
 *   · 帧起点用魔数扫描定位——zstd 帧之间没有长度前缀，只能这样切；
 *   · 魔数可能恰好出现在压缩数据里，所以从某个候选起点解不出来就跳过它（无害：
 *     真正的帧起点一定能解，误命中的候选只会解出乱码或抛错）；
 *   · 逐帧解压保证任何一帧损坏只丢那一帧（追加写入正在进行的最后一帧），不会
 *     让整份日志报废。
 *
 * 为什么要做成生成器而不是返回拼接好的整串：消费方（`forEachSessionEvent`）要的是
 * "处理完一帧就丢一帧"的流式边界——把全部帧的文本攒成一个大字符串，正是内存事故
 * 之前单文件瞬时占用过大的来源之一。需要整串的场景（读日志头、测试）用
 * `decompressZstdFrames` 包装。
 *
 * @param {Buffer} raw 文件原始字节
 * @yields {string} 单帧解压后的文本
 */
function* frameTexts(raw) {
  if (!Buffer.isBuffer(raw) || raw.length === 0) return;
  const offsets = [];
  let at = raw.indexOf(ZSTD_MAGIC, 0);
  while (at !== -1) {
    offsets.push(at);
    at = raw.indexOf(ZSTD_MAGIC, at + 1);
  }
  if (offsets.length === 0) {
    // 没有魔数：交给 zstd 自己（不是 zstd 文件，或用了可跳过帧格式）；错误原样抛出。
    yield zlib.zstdDecompressSync(raw).toString('utf8');
    return;
  }
  let decoded = 0;
  for (let i = 0; i < offsets.length; i += 1) {
    // 切到**下一个候选起点**而不是切到文件末尾：Node 26 的 zstdDecompressSync 会把
    // 从起点开始的后续帧一并解出来，那样同一批数据会被算很多次（实测：3 帧拼起来
    // 逐起点解，得到 6 行而不是 3 行）。切出单帧才能保证两版 Node 结果一致。
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : raw.length;
    try {
      const text = zlib.zstdDecompressSync(raw.subarray(start, end)).toString('utf8');
      decoded += 1;
      yield text;
    } catch {
      // 误命中的魔数，或正在写入的最后一帧：跳过。
    }
  }
  if (decoded === 0) {
    // 一帧都没解出来：可能是完全不同的编码，让标准解压抛出真正的错误。
    yield zlib.zstdDecompressSync(raw).toString('utf8');
  }
}

/**
 * 把一份**多帧** zstd 文件解成整段文本。
 *
 * 现在是 `frameTexts` 的包装：把各帧文本拼起来。只适合小体量场景（读日志头、
 * 测试断言）；会话级扫描请用 `forEachSessionEvent`——它逐帧消费、逐帧丢弃，
 * 不会把整份解压文本攒在内存里。
 *
 * @param {Buffer} raw 文件原始字节
 * @returns {string} 拼接后的文本
 */
export function decompressZstdFrames(raw) {
  let text = '';
  for (const part of frameTexts(raw)) text += part;
  return text;
}

/**
 * 流式处理一个会话日志：逐帧解压 → 逐行 JSON.parse → 回调。
 *
 * 这是扫描路径的**唯一**读文件入口。不构建事件数组：每条事件交给回调后即失去引用，
 * 瞬时内存 = 单帧文本 + 单条事件对象（单帧就是宿主一次写入的批次，通常 KB 级），
 * 与文件总体量无关。这正是修复内存事故的关键路径——以前"整份解析成数组再缓存"，
 * 现在只有回调里**主动留下**的东西（用量 record）会进缓存。
 *
 * 行的切分带跨帧续接：帧文本不一定以换行结尾，末尾半行拼到下一帧开头再判完整；
 * 到文件末尾仍是半行的（进程被杀在写日志中间），按残缺行处理——解析失败跳过，
 * 不让最后一行把整份统计带失败。
 *
 * 解析失败（帧损坏 / 半行）只丢那一条；只有整份都解不出来时错误才向外抛
 * （与旧实现一致，调用方按文件粒度 catch）。
 *
 * @param {string} file 会话日志路径
 * @param {(event: object) => void} onEvent 每条事件回调（同步）
 */
export async function forEachSessionEvent(file, onEvent) {
  const raw = await fs.readFile(file);
  let carry = '';
  for (const text of frameTexts(raw)) {
    let chunk = carry === '' ? text : carry + text;
    carry = '';
    for (;;) {
      const nl = chunk.indexOf('\n');
      if (nl === -1) {
        // 帧尾的半行：留到下一帧开头再判，可能是完整事件被切在了帧边界上。
        carry = chunk;
        break;
      }
      const line = chunk.slice(0, nl);
      chunk = chunk.slice(nl + 1);
      if (line.trim() === '') continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        // 残缺行（进程被杀在写日志中间）：跳过，统计不因此整份失败。
      }
    }
  }
  if (carry !== '' && carry.trim() !== '') {
    try {
      onEvent(JSON.parse(carry));
    } catch {
      // 同上：最后的半行解析不了就丢。
    }
  }
}

/**
 * 一个会话文件的完整解压与逐行解析（**会驻留全部事件**，仅测试/小文件用）。
 *
 * 扫描器与模型解析器都已改走 `forEachSessionEvent`；这个导出留给测试断言与小体量
 * 场景（几 KB 的 fixture）。对 33MB 的真实日志调用它等于把整份解析结果拉进内存，
 * 生产路径不要用。
 */
export async function readSessionEvents(file) {
  const events = [];
  await forEachSessionEvent(file, (event) => { events.push(event); });
  return events;
}

// ── 用量 record：磁盘缓存的最小单元 ────────────────────────────────────
//
// record 是从一条 assistant/message 事件里抽出的统计所需字段的**副本**：
//   { id, provider, model, at, usage: { 六个 token 数字 } }
// 事件本身（含 message.content 正文、工具结果等大字段）不进缓存。
//
// 这几条不变量保证了它与旧"整事件缓存"的行为逐位一致：
//   · 字段的抽取规则逐字来自旧 summarize 的事件读取段（usageRecordOf）；
//   · 汇总逻辑（去重、分层、排序、时间窗）逐字来自旧 summarize 的聚合段
//     （createUsageFold）——旧的 summarize(events) 现在是
//     "抽 record → 折叠 record"的两步组合，同一份数据必然得到同一份结果。
//
// record 经 JSON 落盘再读回时，`at: NaN` 会变成 null——两者在 addUsage 里
// 同样过不了 Number.isFinite，时间窗行为不漂移。

/**
 * provider/model 字符串池：同一 provider/model 的 record 共享同一个字符串引用。
 *
 * 为什么要池化：record 是逐文件 JSON.parse 出来的，不池化的话每条 record 各持一份
 * "deepseek-official"——百万条消息时光重复字符串就是几十 MB。池子按"不同取值数"
 * 而不是"消息数"增长，实测全语料也就几十个取值。
 *
 * 上限是防御性的：病态/被篡改的日志塞进几万个不同 provider 时，池化本身就会变成
 * 泄漏面，超过上限直接返回原串（不共享），宁可多占点字符串也不再进池。
 */
const STRING_POOL_LIMIT = 4096;
const stringPool = new Map();

function internString(value) {
  if (value === '' || stringPool.size >= STRING_POOL_LIMIT) return value;
  let hit = stringPool.get(value);
  if (hit === undefined) {
    stringPool.set(value, value);
    hit = value;
  }
  return hit;
}

/**
 * 一条事件 → 用量 record（不是 assistant/message 或形状不对时返回 null）。
 *
 * 与旧 summarize 的事件读取段逐字段对齐：data.message 缺失时同样产生一条
 * id=''、provider/model 落 unknown 的 record（旧实现对这种退化事件也计 messages，
 * 测试里锁了这个行为）；usage 的六个数字在这里就归一成有限数（count 语义幂等，
 * 汇总时再走一遍 addUsage 的 count 不会改变结果）。
 *
 * @param {object} event 会话日志里的一行
 * @returns {{ id: string, provider: string, model: string, at: number,
 *   usage: { inputTokens: number, outputTokens: number, cacheReadTokens: number,
 *            cacheWriteTokens: number, reasoningTokens: number, totalTokens: number } } | null}
 */
export function usageRecordOf(event) {
  if (event === null || typeof event !== 'object') return null;
  if (event.type !== 'assistant/message') return null;
  const data = event.data;
  if (data === null || typeof data !== 'object') return null;
  const message = data.message ?? {};
  const id = typeof message.id === 'string' ? message.id : '';
  const source = message.source ?? {};
  const provider = normalizeProvider(source.provider);
  const model = typeof source.model === 'string' && source.model.trim() !== '' ? source.model.trim() : '';
  const time = count(event.time);
  const usage = data.usage;
  return {
    id,
    provider: internString(provider),
    model: model === '' ? '' : internString(model),
    at: time > 0 ? time : Number.NaN,
    usage: {
      inputTokens: count(usage?.inputTokens),
      outputTokens: count(usage?.outputTokens),
      cacheReadTokens: count(usage?.cacheReadTokens),
      cacheWriteTokens: count(usage?.cacheWriteTokens),
      reasoningTokens: count(usage?.reasoningTokens),
      totalTokens: count(usage?.totalTokens),
    },
  };
}

/**
 * 流式抽取一个会话文件的用量 record。
 *
 * 全文件读一遍、每条事件抽完即丢；返回的数组就是该文件写入磁盘 record 缓存的
 * 全部内容。解压层面的错误（整份解不出来）向外抛，调用方按文件粒度 catch——
 * 与旧实现一致。
 *
 * @param {string} file 会话日志路径
 * @returns {Promise<Array<object>>} 该文件的用量 record 列表
 */
export async function extractUsageRecords(file) {
  const records = [];
  await forEachSessionEvent(file, (event) => {
    const record = usageRecordOf(event);
    if (record !== null) records.push(record);
  });
  return records;
}

/**
 * 用量汇总的增量折叠器：逐条喂 record，最后取整份汇总。
 *
 * 聚合逻辑与旧 summarize 完全一致（包括 message.id 跨条目去重：先到先得，
 * 实测 DSH 日志里同 id 只出现一次，这里是防御性的），只是输入从"事件数组"
 * 换成了"record"。与 summarizeRecords 拆成两层，是为了让扫描器能
 * **边读磁盘缓存边折叠**——每个文件的 record 数组喂完即失去引用，扫描全程
 * 堆里只有单个文件的瞬时数据 + 一次性去重集合。
 */
function createUsageFold() {
  /** @type {Map<string, Map<string, Map<string, ReturnType<typeof newAccumulator>>>>} */
  const byKind = new Map();
  const seen = new Set();
  let messageCount = 0;

  function add(record) {
    if (record === null || typeof record !== 'object') return;
    // id 为空的消息不参与去重（旧实现同款：没有 id 就没法判"同一条"，宁计勿漏）。
    const id = typeof record.id === 'string' ? record.id : '';
    const key = id === '' ? '' : `id:${id}`;
    if (key !== '') {
      // 同一条消息重复出现（流式重试 / 被取代的分支 / 会话副本与分叉的共享历史）
      // 只统计一次。跨文件的去重靠的是"所有 record 流过同一个 seen"——
      // 单文件各自汇总会把副本整份重复计入，全机账单会虚涨，见文件头注释。
      if (seen.has(key)) return;
      seen.add(key);
    }

    const provider = normalizeProvider(record.provider) || '(unknown)';
    const model = typeof record.model === 'string' && record.model.trim() !== '' ? record.model.trim() : '(unknown)';
    const kind = billingKindOf(provider);

    if (!byKind.has(kind)) byKind.set(kind, new Map());
    const byProvider = byKind.get(kind);
    if (!byProvider.has(provider)) byProvider.set(provider, new Map());
    const byModel = byProvider.get(provider);
    if (!byModel.has(model)) byModel.set(model, newAccumulator());

    addUsage(byModel.get(model), record.usage, record.at);
    messageCount += 1;
  }

  function result() {
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

  return { add, result };
}

/**
 * 把一批用量 record 聚成一份汇总（数组直算入口）。
 *
 * 实现是 createUsageFold 的逐条喂入——与扫描器"边读磁盘缓存边折叠"走完全相同的
 * 代码路径，"数组直算"与"缓存后汇总"不会出现两套口径。record 可以来自
 * usageRecordOf(events)（summarize 路径），也可以来自磁盘 record 缓存。
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
export function summarizeRecords(records) {
  const fold = createUsageFold();
  for (const record of records) fold.add(record);
  return fold.result();
}

/**
 * 把一批 `assistant/message` 事件聚成一份汇总（测试与既有调用方入口）。
 *
 * 实现是 `usageRecordOf` + `createUsageFold` 的两步组合——与扫描器走完全相同的
 * 代码路径，"数组直算"与"缓存后汇总"不会出现两套口径。
 *
 * 输入事件形状（只读这两个字段，其余忽略）：
 *   { type:'assistant/message', time, data:{ message:{ id, source:{provider,model} }, usage } }
 */
export function summarize(events) {
  if (!Array.isArray(events)) return summarizeRecords([]);
  const records = [];
  for (const event of events) {
    const record = usageRecordOf(event);
    if (record !== null) records.push(record);
  }
  return summarizeRecords(records);
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
  const tracker = createLastModelTracker();
  for (const event of events) tracker.add(event);
  return tracker.result();
}

/**
 * "最后用的模型"的流式追踪器：逐条喂事件，只保留当前最优（seq 最大）的一条。
 *
 * 与 lastModelOf 拆成两层，是为了让 `createSessionModelResolver` 能流式喂事件——
 * 不把整份日志解析成数组，读完一个 33MB 的文件也只多占一个 {provider, model}。
 * 判据逐字段沿用 lastModelOf：seq 缺失时用到达序号代替（同一条日志内部，
 * 到达序与 seq 同序）。
 */
function createLastModelTracker() {
  /** @type {{provider: string, model: string, from: string, seq: number} | null} */
  let best = null;
  let order = -1;

  function add(event) {
    order += 1;
    if (event === null || typeof event !== 'object') return;
    const type = typeof event.type === 'string' ? event.type : '';
    let provider = '';
    let model = '';
    if (type === 'model/selection') {
      const data = event.data;
      if (data === null || typeof data !== 'object') return;
      provider = typeof data.provider === 'string' ? data.provider.trim() : '';
      model = typeof data.model === 'string' ? data.model.trim() : '';
    } else if (type === 'request/header') {
      const data = event.data;
      const header = data !== null && typeof data === 'object' ? data.header : null;
      const config = header !== null && typeof header === 'object' ? header.config : null;
      if (config === null || typeof config !== 'object') return;
      provider = typeof config.provider === 'string' ? config.provider.trim() : '';
      model = typeof config.model === 'string' ? config.model.trim() : '';
    } else if (type === 'assistant/message') {
      const data = event.data;
      const message = data !== null && typeof data === 'object' ? data.message : null;
      const source = message !== null && typeof message === 'object' ? message.source : null;
      if (source === null || typeof source !== 'object') return;
      provider = typeof source.provider === 'string' ? source.provider.trim() : '';
      model = typeof source.model === 'string' ? source.model.trim() : '';
    } else {
      return;
    }
    if (provider === '' && model === '') return;
    // seq 缺失时用到达序代替：同一条日志内部的先后关系，到达序与 seq 同序。
    const seq = typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : order;
    if (best === null || seq >= best.seq) best = { provider, model, from: type, seq };
  }

  return {
    add,
    result() {
      return best === null ? null : { provider: best.provider, model: best.model, from: best.from };
    },
  };
}

/**
 * 单个会话的模型解析器（带缓存）。
 *
 * 为什么要缓存：一份 28.7MB / 2.3 万事件的日志解压 + 解析约 1.5s，而卡片每 30 秒
 * 心跳一次、每次心跳都会问一遍。按文件 mtime + size 失效——只要日志没被追加，
 * 结果就不会变（追加才会改变"最后用的模型"）。
 *
 * 缓存的是单个 {provider, model}（每会话几十字节，全机几 MB 上限），留在堆里：
 * 它是请求路径上的热数据，且体量与消息正文无关。只读、只解析一个文件：
 * 不扫全目录，不给无关会话付代价。解析是流式的（`forEachSessionEvent` +
 * 追踪器），读完只留下一个 {provider, model}。
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
      const tracker = createLastModelTracker();
      await forEachSessionEvent(newest.file, tracker.add);
      value = tracker.result();
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
 * 带缓存的统计器：文件 mtime + size 未变就复用解析结果，只重算变过的文件。
 *
 * **缓存全部在磁盘上，堆内零驻留**（2026-11 内存事故的修复形态 + 用户的进一步
 * 要求"计算结果的缓存存在文件里"，见文件头）：
 *
 *   `usage-cache/records/<sha1>.json`     单文件解析产物（用量 record 数组）
 *   `usage-cache/summaries/<桶名>.json`   单桶计算产物（含整份日志集合的指纹）
 *
 * 扫描流程：
 *   1. stat 全部日志 → 拼指纹；指纹与汇总缓存里记的一致 → 直接回缓存结果
 *      （`cached` 报全部文件——上次计算结束时每个文件的 record 缓存必然有效）。
 *   2. 不一致 → 逐文件读磁盘 record 缓存（mtime+size 失效则重新解析日志，解析
 *      结果**立刻**参与折叠，写盘在后台落定；同一文件随后的读取等在途写盘
 *      复用产物，见 pendingRecordWrites），**边读边折叠**：每个文件的 record
 *      喂进折叠器后即失去引用，堆里只有单文件瞬时数据 + 一次性去重集合。
 *   3. 汇总写盘与孤儿清退**后台异步**，不挡扫描的返回路径（见 persistInBackground
 *      的注释：同步落盘的延迟会让刷新轮次拖长，把强制刷新并进旧数据的后面）。
 *   4. 全机扫描顺带排一次孤儿清退：日志已删除的 record 条目、会话已不存在的汇总。
 *
 * 去重发生在折叠阶段而不是抽取阶段（createUsageFold 的一次性 seen 集合），
 * 因此"全机视图对会话副本/分叉只计一次"的口径与旧实现一致。
 *
 * 缓存条目自带校验（原路径 + mtime + size 内嵌在 JSON 里，读时比对）：损坏、
 * 缺失、对不上都当未命中，重新推导并覆写——磁盘缓存永远只是加速器，不是数据源。
 */
export function createUsageScanner({ home } = {}) {
  const dshHome = () => home ?? resolveDshHome();

  /**
   * 在途 record 写盘表：file → { records, mtimeMs, size, promise }。
   *
   * record 写盘被移出了扫描的关键路径（后台落定，见 persistInBackground 的
   * 注释），但"写完之前不算命中"的缓存语义必须保住：磁盘还没写完时，同一文件的
   * 下一次读取在这里等这次写入落定、直接复用它的解析产物，而不是重新解压一遍。
   * 条目在写入落定（成败都算）后自删，表里永远只有正在写入的那几条——
   * 这不是驻留缓存，是进行中 IO 的记账。
   */
  const pendingRecordWrites = new Map();

  /**
   * 读一个文件的用量 record：磁盘缓存命中直接用；在途写盘等它落定后复用产物；
   * 都没有才解析日志，并排后台写盘。整份解不出来才会抛（帧损坏只丢帧），
   * 由调用方按文件粒度 catch。
   *
   * @returns {Promise<{ records: any[], hit: boolean }>} hit = 是否复用了
   *   已有解析产物（磁盘缓存或在途写盘），false = 本次重新解析
   */
  async function recordsOf(file, stat) {
    const recordsPath = path.join(usageCacheRoot(dshHome()), 'records', `${recordsCacheKey(file)}.json`);
    const entry = await readJsonIfExists(recordsPath);
    if (
      entry !== null && typeof entry === 'object'
      && entry.file === file
      && entry.mtimeMs === stat.mtimeMs
      && entry.size === stat.size
      && Array.isArray(entry.records)
    ) {
      return { records: entry.records, hit: true };
    }
    const pending = pendingRecordWrites.get(file);
    if (pending !== undefined && pending.mtimeMs === stat.mtimeMs && pending.size === stat.size) {
      // 上一次解析的写盘还在路上：等它落定，直接用它的产物。写盘可能失败，
      // 但 records 是刚刚从日志里解析出来的，与这组 mtime+size 对应的事实不变。
      await pending.promise;
      return { records: pending.records, hit: true };
    }
    const records = await extractUsageRecords(file);
    const writing = { records, mtimeMs: stat.mtimeMs, size: stat.size, promise: null };
    writing.promise = persistInBackground(async () => {
      try {
        await fs.mkdir(path.dirname(recordsPath), { recursive: true });
        await writeJsonAtomic(recordsPath, { file, mtimeMs: stat.mtimeMs, size: stat.size, records });
      } finally {
        // 只删自己的条目：并发解析同一文件时后到者覆盖了表项，先到者的收尾
        // 不应该把别人的在途记账删掉（那会让第三位读者白等一次落盘）。
        if (pendingRecordWrites.get(file) === writing) pendingRecordWrites.delete(file);
      }
    });
    pendingRecordWrites.set(file, writing);
    return { records, hit: false };
  }

  /**
   * 清退孤儿缓存（只在全机扫描时做）：
   *   · records：不在当前日志集合里的条目（日志被宿主删除/清理后留下的）
   *   · summaries：会话已不存在的桶（`__all__` 与在册会话的桶保留）
   *   · 半截的 `.tmp`（写入中途被杀的残留）
   * 删除失败一律忽略——清退只是卫生，不影响正确性。
   */
  async function pruneCache(currentFiles, currentSessions) {
    const root = usageCacheRoot(dshHome());
    const recordsDir = path.join(root, 'records');
    const summariesDir = path.join(root, 'summaries');
    try {
      const keepRecords = new Set([...currentFiles].map((file) => `${recordsCacheKey(file)}.json`));
      for (const name of await fs.readdir(recordsDir)) {
        if (!name.endsWith('.json')) {
          if (name.endsWith('.tmp')) await fs.rm(path.join(recordsDir, name), { force: true }).catch(() => {});
          continue;
        }
        if (keepRecords.has(name)) continue;
        await fs.rm(path.join(recordsDir, name), { force: true }).catch(() => {});
      }
    } catch {
      // records 目录还没有：没有可清的。
    }
    try {
      const keepSummaries = new Set(
        [`${summariesCacheKey('*')}.json`, ...[...currentSessions].map((id) => `${summariesCacheKey(id)}.json`)],
      );
      for (const name of await fs.readdir(summariesDir)) {
        if (!name.endsWith('.json')) {
          if (name.endsWith('.tmp')) await fs.rm(path.join(summariesDir, name), { force: true }).catch(() => {});
          continue;
        }
        if (keepSummaries.has(name)) continue;
        await fs.rm(path.join(summariesDir, name), { force: true }).catch(() => {});
      }
    } catch {
      // summaries 目录还没有：没有可清的。
    }
  }

  async function scanFor(sessionId) {
    const root = sessionsRoot(dshHome());
    if (!existsSync(root)) {
      return { ...summarizeRecords([]), scannedAt: Date.now(), files: 0, cached: 0, sessionId: sessionId || null };
    }
    const files = await listSessionFiles(root, sessionId);

    // stat 一遍，拼指纹。stat 失败的文件不参与（下一轮要么回来，要么没了）。
    const signatureParts = [];
    /** @type {Array<[string, {mtimeMs: number, size: number}]>} */
    const statList = [];
    for (const file of files) {
      let stat;
      try {
        stat = await fs.stat(file);
      } catch {
        continue;
      }
      signatureParts.push(`${file}:${stat.mtimeMs}:${stat.size}`);
      statList.push([file, { mtimeMs: stat.mtimeMs, size: stat.size }]);
    }

    const bucket = sessionId || '*';
    const signature = signatureParts.join('|');

    // 1) 汇总缓存（磁盘）：指纹一致说明日志集合与上次计算时完全相同——
    //    上次计算结束时每个文件的 record 缓存都是有效的，所以 cached 报全部。
    const summariesDir = path.join(usageCacheRoot(dshHome()), 'summaries');
    const summaryPath = path.join(summariesDir, `${summariesCacheKey(bucket)}.json`);
    const summaryEntry = await readJsonIfExists(summaryPath);
    if (
      summaryEntry !== null && typeof summaryEntry === 'object'
      && summaryEntry.bucket === bucket
      && summaryEntry.signature === signature
      && summaryEntry.summary !== null && typeof summaryEntry.summary === 'object'
    ) {
      return { ...summaryEntry.summary, cached: statList.length, files: files.length, sessionId: sessionId || null };
    }

    // 2) 折叠：逐文件读磁盘 record 缓存（失效则重解析并写回），喂完即丢。
    let cachedCount = 0;
    const fold = createUsageFold();
    for (const [file, stat] of statList) {
      let loaded;
      try {
        loaded = await recordsOf(file, stat);
      } catch {
        // 解压失败（正在被写入 / 版本不认）：跳过这个文件，下次再试。
        continue;
      }
      if (loaded.hit) cachedCount += 1;
      for (const record of loaded.records) fold.add(record);
    }
    const summary = fold.result();

    persistInBackground(async () => {
      await fs.mkdir(summariesDir, { recursive: true });
      await writeJsonAtomic(summaryPath, { bucket, signature, summary });
    });

    if (sessionId === '') {
      // 3) 全机扫描顺带清退孤儿缓存（会话 id = 日志所在目录名，与桶名同源）。
      //    同样后台化：清退是卫生工作，不该挡在返回路径上。
      persistInBackground(() => pruneCache(
        new Set(statList.map(([file]) => file)),
        new Set(statList.map(([file]) => path.basename(path.dirname(file)))),
      ));
    }

    return { ...summary, scannedAt: Date.now(), files: files.length, cached: cachedCount, sessionId: sessionId || null };
  }

  /** 全机统计（所有会话）。 */
  const scan = () => scanFor('');
  /** 单个会话的统计（会话内视图用）。 */
  const scanSession = (sessionId) => scanFor(sessionId);

  /**
   * 当前日志集合的**指纹**：只 stat，不解压、不解析。
   *
   * 为什么需要它（而不是拿"距上次计算多久"猜 stale）：预计算之后，缓存可能比日志旧，
   * 也可能只是"还没来得及重算"。这两种情况对用户是不同的事实——前者该标"数字已过期"，
   * 后者只是"还没到点"。用时间猜会在日志根本没变时误报过期。
   *
   * 所以判据必须是数据：把每个文件的 mtime + size 拼起来与计算时记下的那份比较，
   * 变了才是真的旧了。`scanFor` 内部本来就是用这同一个串做汇总缓存的键
   * （`signatureParts`），这里只是把它单独暴露出来，口径不会漂移。
   *
   * 代价：一次 stat 遍历（N 个文件 N 次 stat），不做解压。相对"整库解析"是毫秒级，
   * 放在请求路径上可以接受；**解析仍然只在后台 tick 与显式刷新时发生**。
   *
   * @param {string} [sessionId] 只算这一个会话的文件（会话内视图用）
   * @returns {Promise<string>} 文件有变化时这个串必然变；目录为空时是空串
   */
  async function signature(sessionId = '') {
    const root = sessionsRoot(dshHome());
    if (!existsSync(root)) return '';
    const want = typeof sessionId === 'string' ? sessionId.trim() : '';
    const files = await listSessionFiles(root, want);
    const parts = [];
    for (const file of files) {
      let stat;
      try {
        stat = await fs.stat(file);
      } catch {
        // 正在被删除 / 权限变了：这一刻读不到就不参与指纹。
        // 它下一轮要么回来（指纹变化 → 标 stale），要么真的没了。
        continue;
      }
      parts.push(`${file}:${stat.mtimeMs}:${stat.size}`);
    }
    return parts.join('|');
  }

  /**
   * 清空缓存：删除磁盘上的 record 与汇总（原子写留下的 `.tmp` 一并随目录消失）。
   * 扫描器在堆内已无常驻状态；删除失败不抛——缓存只是加速器。
   */
  const clear = () => fs.rm(usageCacheRoot(dshHome()), { recursive: true, force: true }).catch(() => {});

  return {
    scan,
    scanSession,
    signature,
    clear,
  };
}
