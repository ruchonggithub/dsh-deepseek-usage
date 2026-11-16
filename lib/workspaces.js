/**
 * dsh-quota-usage — 工作区维度统计。
 *
 * 会话维度的口径解决的是"这次对话花了多少"，但用户真正想知道的是"这个项目花了多少"：
 * 一个工作区里的几十个会话（含子代理会话）合起来才是这个项目的真实消耗。所以这里多一层：
 * 把会话按**它所在的工作区**归堆，再复用 usage.js 的 summarize 结构逐工作区汇总。
 *
 * 数据源只有两处，都只读：
 *   · `$DSH_HOME/storages/workspace.json` —— 工作区注册表（id → path / title / sessionIds）
 *   · `$DSH_HOME/sessions/**` —— 会话日志，靠 scanner.scanSession(id) 读，本模块不自己解压
 *
 * 实测到的宿主落盘形态（与最初按文档写的假设有出入，以实测为准）：
 *
 *   $DSH_HOME/sessions/
 *     --F-work-workspace-ruchong-ai-deepseek-harness-plugin-dsh-quota-usage--/   ← slug 目录
 *       session-bdefd88b-40ab-4ae2-9380-6190e9ae3911/session.v4.jsonl.zstd         ← 顶层会话
 *       2441e31b-cfbb-4ef4-8eac-33349ae47dcb/session.v4.jsonl.zstd                 ← 子代理会话（裸 uuid）
 *
 * 也就是说**同一个工作区目录下混着两种会话**：
 *   · 顶层会话：目录名 `session-<uuid>`，与 workspace.json 的 sessionIds 直接对得上；
 *   · 子代理会话：目录名是**裸 uuid**（没有 session- 前缀），**不会**出现在 workspace.json
 *     的 sessionIds 里。它们的日志头里有 `origin:'subagent'` 和 `parentSession:<父会话 id>`。
 *
 * 为什么这件事必须处理：子代理的模型调用是真金白银花在该工作区上的。实测当前工作区的
 * slug 目录里 6 个会话有 4 个是子代理会话——只按 workspace.json 的 sessionIds 统计，
 * 工作区消耗会**大幅偏低**（这不是"少算一点"，是账错了）。所以默认把子代理会话也归到
 * 它父会话所在的工作区（见 subagent 归属规则），并给出 `includeSubagents:false` 让调用方
 * 在需要"只算用户亲手开的会话"时可关掉。
 *
 * 三条口径上的硬规矩：
 *   1. 一个会话只能算进一个工作区。workspace.json 里若出现重复 sessionIds，只认**第一个**
 *      出现的工作区，并在日志里**只警告一次**——重复统计比漏统计更难被发现。
 *   2. 归档 ≠ 没花过钱。`archivedSessionIds` 里的会话照常计入，但逐会话带上 `archived:true`，
 *      让界面能区分"已归档但确实花过"和"在用"。
 *   3. 工作区的 `path` 只用来展示、以及匹配子代理日志头里的 `cwd`；**绝不**用它去拼会话日志
 *      路径（slug 是宿主自己生成的目录名，靠 path 猜必错）。日志位置一律通过 sessions 目录
 *      枚举得到，读取一律走 scanner。
 *
 * 失败隔离：单个会话读不出来只影响它自己（该会话 ok:false 并记 error），单个工作区抛错也
 * 不会带崩其它工作区——统计插件把整份报表弄丢，比少一行数字严重。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  BILLING_KINDS,
  createUsageScanner,
  decompressZstdFrames,
  resolveDshHome,
  sessionsRoot,
} from './usage.js';

/** 读日志头时先尝试的字节数：会话头是第一个 zstd 帧，通常几百字节就够。 */
const HEADER_BYTES = 64 * 1024;
/** 头解析失败时的兜底读取上限：防的是"第一个帧特别大"而不是"文件特别大"。 */
const HEADER_FALLBACK_BYTES = 4 * 1024 * 1024;
/** 会话目录枚举的递归深度上限（实测就是两层，留余量但不无限递归）。 */
const MAX_DIR_DEPTH = 6;
/** 子代理归属的迭代轮数上限（父 → 孙 → 曾孙，链再长也不会超过这个数）。 */
const MAX_OWNER_PASSES = 8;

/** 令牌字段的白名单：合并时只碰这些，别的字段原样透传不会被误加。 */
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'];

/** 空 totals（工作区没有任何会话时用它，而不是 undefined —— 界面代码不该到处判空）。 */
function zeroTotals() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
}

/** 容忍字符串/数字，返回有限非负数或 0。统计口径里缺失即 0，绝不是 NaN。 */
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  return 0;
}

/** 取一个非空字符串（去掉首尾空白），否则空串。 */
function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 把任意值当成"id 列表"读：只留非空字符串，去重并保持原顺序。 */
function idList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const id = str(item);
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 路径归一（只用于**比较**，不用于拼接文件路径）。
 *
 * Windows 路径大小写不敏感，所以只在 win32 上折叠大小写；在 POSIX 上折叠会把
 * `/a/B` 和 `/a/b` 两个真实存在的不同目录认成一个，反而制造错误归属。
 */
function normalizePath(value) {
  const raw = str(value);
  if (raw === '') return '';
  let p = raw.replace(/\\/g, '/');
  if (process.platform === 'win32') p = p.toLowerCase();
  if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');
  return p;
}

/**
 * workspace.json 的位置。
 * 单独导出是因为测试与排障都需要在不读文件的情况下知道它在哪。
 */
export function workspaceStorePath(home = resolveDshHome()) {
  return path.join(home, 'storages', 'workspace.json');
}

/**
 * 读注册表原始对象。文件缺失、JSON 损坏、形状不认识一律返回 null（调用方转成 []）。
 *
 * 为什么要剥 BOM：宿主自己写这个文件时不会带，但用户在 Windows 上手动改过之后很可能带。
 * 带 BOM 的 JSON 会让 JSON.parse 直接抛错，于是整个工作区视图消失——为了三个字节丢一份报表
 * 不值得。
 */
async function readWorkspaceStore(home) {
  let raw;
  try {
    raw = await fs.readFile(workspaceStorePath(home), 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  return parsed;
}

/** 默认警告出口：一条 console.warn（只用于"数据本身有问题"这类用户该知道的事）。 */
function defaultWarn(message) {
  console.warn(message);
}

/**
 * 读工作区注册表，返回按宿主的展示顺序排好的工作区列表。
 *
 * @param {string} [home] DSH home（默认 `$DSH_HOME` 或 `~/.dsh`）
 * @param {{ warn?: (message: string) => void }} [options] `warn` 用于接管重复会话的告警
 * @returns {Promise<Array<{
 *   id: string, title: string, path: string,
 *   sessionIds: string[], archivedSessions: string[], pinnedSessions: string[],
 *   droppedSessionIds: string[], createdAt: string, updatedAt: string,
 * }>>} 文件缺失/损坏/没有工作区表时返回 `[]`
 *
 * 排序口径：先按 `global.workspaceIds` 的顺序（那是宿主侧边栏的顺序，界面照抄才不会跳），
 * 再把"有工作区记录但没出现在 workspaceIds 里"的补到末尾——注册表出现这种不一致时，
 * 宁可多显示一个也不能把一个真花过钱的工作区从报表里吞掉。
 */
export async function resolveWorkspaces(home = resolveDshHome(), options = {}) {
  const warn = typeof options?.warn === 'function' ? options.warn : defaultWarn;
  const store = await readWorkspaceStore(home);
  if (store === null) return [];
  const tables = store.tables?.workspaces;
  if (!isPlainObject(tables)) return [];

  const glob = isPlainObject(store.global) ? store.global : {};
  // 归档/置顶在实测结构里挂在 global 上（不是工作区条目上）。
  const archivedAll = new Set(idList(glob.archivedSessionIds));
  const pinnedAll = new Set(idList(glob.pinnedSessionIds));

  /** @type {string[]} */
  const order = [];
  const ordered = new Set();
  for (const id of idList(glob.workspaceIds)) {
    if (!isPlainObject(tables[id]) || ordered.has(id)) continue;
    ordered.add(id);
    order.push(id);
  }
  for (const id of Object.keys(tables)) {
    if (ordered.has(id) || !isPlainObject(tables[id])) continue;
    ordered.add(id);
    order.push(id);
  }

  /** 会话 → 工作区 的归属表。重复登记时先到先得。 */
  const owner = new Map();
  /** @type {Array<{ sessionId: string, keptBy: string, droppedBy: string }>} */
  const duplicates = [];
  const workspaces = [];

  for (const id of order) {
    const row = tables[id];
    const declared = idList(row.sessionIds);
    const kept = [];
    const dropped = [];
    for (const sessionId of declared) {
      const already = owner.get(sessionId);
      if (already !== undefined) {
        // 只认第一个工作区：同一笔消耗算进两个项目，两个项目的数字都不可信。
        dropped.push(sessionId);
        duplicates.push({ sessionId, keptBy: already, droppedBy: id });
        continue;
      }
      owner.set(sessionId, id);
      kept.push(sessionId);
    }

    // 归档/置顶同时容忍挂在 global 与挂在单个工作区条目上两种写法（宿主版本演进过）。
    const archivedLocal = new Set(idList(row.archivedSessionIds));
    const pinnedLocal = new Set(idList(row.pinnedSessionIds));
    const folder = str(row.path);
    workspaces.push({
      id,
      // title 缺失时退回目录名：界面上显示 `dsh-quota-usage` 比显示一坨 uuid 有用。
      title: str(row.title) || (folder === '' ? '' : path.basename(folder)) || id,
      path: folder,
      sessionIds: kept,
      // 只保留真正属于本工作区的会话：全局归档表里可能有别的（甚至已不存在的）会话 id。
      archivedSessions: kept.filter((sid) => archivedAll.has(sid) || archivedLocal.has(sid)),
      pinnedSessions: kept.filter((sid) => pinnedAll.has(sid) || pinnedLocal.has(sid)),
      droppedSessionIds: dropped,
      createdAt: str(row.createdAt),
      updatedAt: str(row.updatedAt),
    });
  }

  // 只警告一次：这段是要被人看见的，但刷屏的警告等于没警告。合并成一条，列出全部冲突。
  if (duplicates.length > 0) {
    const detail = duplicates.map((d) => `${d.sessionId}（${d.droppedBy} 重复登记，已归 ${d.keptBy}）`).join('；');
    warn(`[dsh-quota-usage] workspace.json 里有 ${duplicates.length} 个会话被多个工作区同时登记，只统计第一个工作区：${detail}`);
  }

  return workspaces;
}

/** 从文件里读最多 maxBytes 字节（不解压，只取开头）。 */
async function readHead(file, maxBytes) {
  const handle = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** 解压给定字节并取第一行 JSON；失败返回 null。 */
function parseFirstJsonLine(raw) {
  let text;
  try {
    text = decompressZstdFrames(raw);
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const value = JSON.parse(line);
      return isPlainObject(value) ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 读一个会话日志的**头部**（第一行 `{type:'session', id, parentSession, origin, cwd, ...}`）。
 *
 * 为什么要专门做一个只读头的函数：头部记录了会话的父子关系与 cwd，是子代理归属的唯一依据；
 * 而一个会话日志动辄 1MB+，为了一个头部把整份日志解压一遍（还有 zstd 多帧的坑）代价太大。
 * 只解第一个帧就够。
 *
 * @param {string} file
 * @param {number} [maxBytes]
 * @returns {Promise<object|null>}
 */
export async function readSessionHeader(file, maxBytes = HEADER_BYTES) {
  try {
    const head = parseFirstJsonLine(await readHead(file, maxBytes));
    if (head !== null) return head;
    // 第一个帧比预留的缓冲还大时，退回整份读取（有上限，避免误读巨型文件）。
    const stat = await fs.stat(file);
    if (stat.size <= maxBytes || stat.size > HEADER_FALLBACK_BYTES) return null;
    return parseFirstJsonLine(await readHead(file, stat.size));
  } catch {
    return null;
  }
}

/**
 * 枚举 sessions 目录下的全部会话目录，返回 `[{ id, file }]`。
 *
 * 不用工作区 `path` 拼路径：目录名是宿主生成的 slug，规则不在本插件手里，拼必错。
 * 递归而不是写死两层，是因为实测是 `slug/sessionId/`，但子代理会话若将来被放进更深一层，
 * 写死两层就会静默丢数据。
 */
async function listSessionLogs(home) {
  const root = sessionsRoot(home);
  const logs = [];
  async function walk(dir, depth) {
    if (depth > MAX_DIR_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    let logFile = '';
    const subdirs = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl.zstd')) {
        // 一个会话目录里正常只有一个日志；有多个时取名字排序最小的那个，保证结果可复现。
        const candidate = path.join(dir, entry.name);
        if (logFile === '' || candidate < logFile) logFile = candidate;
      } else if (entry.isDirectory()) {
        subdirs.push(path.join(dir, entry.name));
      }
    }
    if (logFile !== '') logs.push({ id: path.basename(dir), file: logFile });
    for (const sub of subdirs) await walk(sub, depth + 1);
  }
  await walk(root, 0);
  return logs;
}

/**
 * 找出没被 workspace.json 直接登记的会话（实测就是子代理会话），解析出它们属于哪个工作区。
 *
 * 归属规则，按优先级：
 *   1. 日志头的 `parentSession` 指向的会话已归属某工作区 → 跟着走（子代理为父会话干活，
 *      消耗理应记在同一个项目上）；
 *   2. 日志头的 `cwd` 与某个工作区的 `path` 完全相同 → 归该工作区（父会话已删或日志头缺字段
 *      时的兜底；不做前缀匹配，因为工作区可以嵌套，前缀匹配会把内层会话算到外层）；
 *   3. 都不满足 → 丢弃（宁可少算一个孤儿会话，也不要猜错项目）。
 *
 * 多轮迭代是为了处理"子代理又开了子代理"的链。
 *
 * @returns {Promise<Map<string, string[]>>} workspaceId → 追加的会话 id 列表（已排序）
 */
async function collectSubagentOwners({ home, workspaces, owner }) {
  const logs = await listSessionLogs(home);
  /** @type {Array<{ id: string, parentSession: string, cwd: string }>} */
  const pending = [];
  for (const entry of logs) {
    // 已被 workspace.json 登记过的会话不重复归属（归属只由注册表决定，不再读头，省 IO）。
    if (owner.has(entry.id)) continue;
    const header = await readSessionHeader(entry.file);
    pending.push({
      id: entry.id,
      parentSession: str(header?.parentSession),
      cwd: normalizePath(header?.cwd),
    });
  }
  if (pending.length === 0) return new Map();

  const byPath = new Map();
  for (const ws of workspaces) {
    const key = normalizePath(ws.path);
    // 先到先得：两个工作区指向同一目录时，按注册表顺序取第一个，与重复会话口径一致。
    if (key !== '' && !byPath.has(key)) byPath.set(key, ws.id);
  }

  const children = new Map();
  for (let pass = 0; pass < MAX_OWNER_PASSES; pass += 1) {
    let changed = false;
    for (const item of pending) {
      if (owner.has(item.id)) continue;
      let workspaceId = null;
      if (item.parentSession !== '' && owner.has(item.parentSession)) {
        workspaceId = owner.get(item.parentSession);
      } else if (item.cwd !== '') {
        workspaceId = byPath.get(item.cwd) ?? null;
      }
      if (workspaceId === null) continue;
      owner.set(item.id, workspaceId);
      if (!children.has(workspaceId)) children.set(workspaceId, []);
      children.get(workspaceId).push(item.id);
      changed = true;
    }
    if (!changed) break;
  }

  // 排序是为了让同一份数据每次产出稳定（readdir 的顺序不保证跨平台一致），
  // 否则界面上的会话列表会莫名其妙换位置。
  for (const ids of children.values()) ids.sort();
  return children;
}

/** 合并用的累加器（字段与 usage.js 的累加器同名，便于对照）。 */
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

/** 把一份「条目」（模型/厂商累加结果、或 usage.js 的 summarize 输出节点）并进累加器。 */
function addInto(target, source) {
  if (!isPlainObject(source)) return target;
  target.messages += num(source.messages);
  for (const field of TOKEN_FIELDS) target[field] += num(source[field]);
  const first = num(source.firstAt);
  const last = num(source.lastAt);
  if (first > 0 && (target.firstAt === null || first < target.firstAt)) target.firstAt = first;
  if (last > 0 && (target.lastAt === null || last > target.lastAt)) target.lastAt = last;
  return target;
}

/** 计费类型的展示顺序，与 usage.js 的 BILLING_KINDS 保持一致。 */
const KIND_ORDER = new Map(BILLING_KINDS.map((kind, index) => [kind, index]));

function kindRank(kind) {
  return KIND_ORDER.has(kind) ? KIND_ORDER.get(kind) : BILLING_KINDS.length;
}

/** 从一份汇总里取出顶层 totals 与时间窗（顶层 = 该汇总所有计费类型之和）。 */
function totalsOfSummary(summary) {
  const totals = zeroTotals();
  let firstAt = null;
  let lastAt = null;
  const kinds = Array.isArray(summary?.kinds) ? summary.kinds : [];
  for (const kind of kinds) {
    if (!isPlainObject(kind)) continue;
    for (const field of TOKEN_FIELDS) {
      // reasoningTokens 不进 totals（口径只到 4 个 token 字段），但它在 kinds 里的明细照旧。
      if (field === 'reasoningTokens') continue;
      totals[field] += num(kind[field]);
    }
    const first = num(kind.firstAt);
    const last = num(kind.lastAt);
    if (first > 0 && (firstAt === null || first < firstAt)) firstAt = first;
    if (last > 0 && (lastAt === null || last > lastAt)) lastAt = last;
  }
  return { totals, firstAt, lastAt };
}

/**
 * 把多个会话的 summarize 结果合并成一份「工作区级」汇总。
 *
 * 为什么不重新解压所有日志再 summarize 一次：scanner.scanSession(id) 已经带 mtime+size 缓存，
 * 沿用它就不会因为多了一个工作区视图而让整个会话被重复解析一遍。代价是要在这里做一次结构
 * 合并——所以合并必须与 usage.js 的排序/分层口径严格一致，否则同一份数据在两个视图里
 * 会排出不同的顺序，用户会以为是两个功能在打架。
 *
 * 合并时以**模型级**明细为唯一真值（各层数字都由它相加得到）：外部传进来的扫描器若
 * 厂商级数字与模型级之和本来就不一致，以模型级为准比"两层各自加一遍"更不容易出双计。
 */
function mergeSummaries(summaries) {
  /** @type {Map<string, Map<string, Map<string, ReturnType<typeof newAccumulator>>>>} */
  const byKind = new Map();
  let messages = 0;

  for (const summary of summaries) {
    if (!isPlainObject(summary)) continue;
    messages += num(summary.messages);
    for (const kind of Array.isArray(summary.kinds) ? summary.kinds : []) {
      if (!isPlainObject(kind)) continue;
      const kindId = str(kind.kind) || 'unknown';
      if (!byKind.has(kindId)) byKind.set(kindId, new Map());
      const byProvider = byKind.get(kindId);
      for (const provider of Array.isArray(kind.providers) ? kind.providers : []) {
        if (!isPlainObject(provider)) continue;
        const providerId = str(provider.provider) || '(unknown)';
        if (!byProvider.has(providerId)) byProvider.set(providerId, new Map());
        const byModel = byProvider.get(providerId);
        const models = Array.isArray(provider.models) ? provider.models : [];
        if (models.length === 0) {
          // 没有模型明细（不该发生，但外部扫描器可能这样给）：退化为厂商级数字，
          // 用一个哨兵模型名占位，至少不把这笔消耗丢掉。
          const key = '(unknown)';
          if (!byModel.has(key)) byModel.set(key, newAccumulator());
          addInto(byModel.get(key), provider);
          continue;
        }
        for (const model of models) {
          if (!isPlainObject(model)) continue;
          const modelId = str(model.model) || '(unknown)';
          if (!byModel.has(modelId)) byModel.set(modelId, newAccumulator());
          addInto(byModel.get(modelId), model);
        }
      }
    }
  }

  const kinds = [];
  for (const kindId of [...byKind.keys()].sort((a, b) => kindRank(a) - kindRank(b) || a.localeCompare(b))) {
    const byProvider = byKind.get(kindId);
    const kindAcc = newAccumulator();
    const providers = [];
    for (const [providerId, byModel] of byProvider) {
      const providerAcc = newAccumulator();
      const models = [];
      for (const [modelId, acc] of byModel) {
        models.push({ model: modelId, ...acc });
        addInto(providerAcc, acc);
      }
      models.sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));
      addInto(kindAcc, providerAcc);
      providers.push({
        provider: providerId,
        // 与 usage.js 一致：classified 由计费类型决定，未分类的 provider 界面要标出来。
        classified: kindId !== 'unknown',
        ...providerAcc,
        models,
      });
    }
    providers.sort((a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider));
    kinds.push({ kind: kindId, ...kindAcc, providers });
  }

  const totals = zeroTotals();
  for (const kind of kinds) {
    for (const field of TOKEN_FIELDS) {
      if (field === 'reasoningTokens') continue;
      totals[field] += num(kind[field]);
    }
  }

  return {
    kinds,
    messages,
    unclassified: kinds.find((k) => k.kind === 'unknown')?.providers.map((p) => p.provider) ?? [],
    totals,
    firstAt: kinds.reduce((acc, k) => (k.firstAt !== null && (acc === null || k.firstAt < acc) ? k.firstAt : acc), null),
    lastAt: kinds.reduce((acc, k) => (k.lastAt !== null && (acc === null || k.lastAt > acc) ? k.lastAt : acc), null),
  };
}

/**
 * 会话副本的指纹。
 *
 * 为什么要这一步：实测本机存在**同一段对话的两份日志**（`session-40f34ee1` 与
 * `session-4bd9039b`，同在 litiaotiao 工作区）——消息数都是 832、token 都是 243,292,817、
 * 时间窗也一样。这是宿主侧分叉/复制会话留下的产物。两份都算，工作区消耗会凭空翻倍：
 * 未去重时各工作区合计 688,732,292，而 usage.js 的全机扫描（它按 message.id 去重）只有
 * 422,040,394——差出来的 266,692,098 不是统计误差，是一整份账单。
 * （上面的绝对数字是这次排查时的快照，会话还在写，读到的值会漂，比例关系不变。）
 *
 * 指纹用「消息数 + 各 token 分项 + 首末消息毫秒时刻 + 完整 kinds 结构」拼出来：
 * 首末时刻是毫秒级时间戳，两段不同对话撞上同一个首末毫秒并且每个模型的 token 完全相等的
 * 概率可以忽略，所以"指纹相同"就等于"同一段对话的副本"，不会误杀真实会话。
 *
 * 已知局限（写在这里而不是藏着）：指纹只能认出**完全一致**的副本。对"从某段对话分叉后
 * 各走各路"的**部分重叠**（实测 `session-e6171074` 的 163 条消息全部包含在
 * `session-bdefd88b` 里，后者头上有 `isSeeded:true`），本模块认不出来——那需要 message.id
 * 级别的跨会话去重，只有 usage.js 的 summarize 能做（它的 seen 集合覆盖整批事件）。
 * 实测残留差额正好等于该会话的 23,550,280 token（全机合计与工作区合计之差，分毫不差），
 * 也就是说误差的上界是"分叉点之前那段历史"，界面不该假装两者必然相等。
 */
function summaryFingerprint(summary) {
  const kinds = Array.isArray(summary?.kinds) ? summary.kinds : [];
  const shape = kinds.map((kind) => ({
    kind: str(kind?.kind),
    messages: num(kind?.messages),
    tokens: TOKEN_FIELDS.map((field) => num(kind?.[field])),
    firstAt: num(kind?.firstAt),
    lastAt: num(kind?.lastAt),
    providers: (Array.isArray(kind?.providers) ? kind.providers : []).map((provider) => ({
      provider: str(provider?.provider),
      messages: num(provider?.messages),
      tokens: TOKEN_FIELDS.map((field) => num(provider?.[field])),
      models: (Array.isArray(provider?.models) ? provider.models : []).map((model) => ({
        model: str(model?.model),
        messages: num(model?.messages),
        tokens: TOKEN_FIELDS.map((field) => num(model?.[field])),
      })),
    })),
  }));
  const messages = num(summary?.messages);
  // 没有任何消息的会话不参与指纹比对：空会话之间"完全相同"是正常的（新建但没聊过），
  // 把它们当成副本处理会让用户的会话列表莫名其妙少几条。
  if (messages === 0 && shape.length === 0) return '';
  return JSON.stringify({ messages, shape });
}

/** 解析 scanner：不传就用 usage.js 的默认实现；传了但没有 scanSession 说明调用方写错了。 */
function resolveScanner(scanner, home) {
  if (scanner === undefined || scanner === null) return createUsageScanner({ home });
  if (typeof scanner.scanSession !== 'function') {
    // 这里报错而不是静默返回 0：一个坏掉的 scanner 会让整份报表变成"全都是 0"，
    // 而 0 看起来完全正常，用户永远不会发现自己的账丢了。
    throw new TypeError('scanWorkspaces: 传入的 scanner 必须有 scanSession(sessionId) 方法');
  }
  return scanner;
}

/** 把异常转成一行可展示的字符串（不吞堆栈信息里的关键部分）。 */
function errorText(error) {
  if (error instanceof Error) return error.message || error.name || 'Error';
  const text = str(error);
  return text === '' ? 'unknown error' : text;
}

/**
 * 按工作区汇总用量。
 *
 * @param {{
 *   home?: string,
 *   scanner?: { scanSession: (sessionId: string) => Promise<any> },
 *   includeSubagents?: boolean,
 *   warn?: (message: string) => void,
 * }} [options]
 * @returns {Promise<Array<{
 *   id: string, title: string, path: string,
 *   sessionCount: number,
 *   messages: number,
 *   kinds: any[],
 *   unclassified: string[],
 *   totals: { inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, totalTokens: number },
 *   firstAt: number|null, lastAt: number|null,
 *   archivedSessions: string[], pinnedSessions: string[],
 *   sessions: Array<{ id: string, archived: boolean, ok: boolean, messages: number, totals: object, firstAt: number|null, lastAt: number|null, error?: string }>,
 *   failedSessionCount: number,
 *   includeSubagents: boolean,
 * }>>}
 *
 * 语义要点：
 *   · 没有任何工作区登记时返回 `[]`（不是"一个空工作区"——那会让界面显示一个假项目）；
 *   · 登记了但没有会话的工作区**保留**，各项为 0，界面据此显示"这个项目还没用过"；
 *   · 归档会话默认计入（归档不等于没花过钱），逐会话 `archived:true` 供界面区分；
 *   · 单个会话/工作区失败只影响它自己。
 */
export async function scanWorkspaces(options = {}) {
  const home = typeof options.home === 'string' && options.home.trim() !== '' ? options.home : resolveDshHome();
  const includeSubagents = options.includeSubagents !== false;
  const warn = typeof options.warn === 'function' ? options.warn : defaultWarn;
  const scanner = resolveScanner(options.scanner, home);

  const workspaces = await resolveWorkspaces(home, { warn });
  if (workspaces.length === 0) return [];

  // 会话 → 工作区归属表：先按注册表建，再让子代理会话挂上去。
  const owner = new Map();
  for (const ws of workspaces) for (const sessionId of ws.sessionIds) owner.set(sessionId, ws.id);

  let children = new Map();
  if (includeSubagents) {
    try {
      children = await collectSubagentOwners({ home, workspaces, owner });
    } catch {
      // 枚举会话目录失败（权限/文件系统异常）不该拖垮整个工作区视图：
      // 注册表里的会话仍然能统计出来，子代理部分暂时缺失。
      children = new Map();
    }
  }

  const results = [];
  /** 已统计会话的指纹 → 首次出现的会话 id。跨工作区共享：副本可能被登记在不同工作区。 */
  const seenFingerprints = new Map();
  const duplicateCopies = [];

  for (const ws of workspaces) {
    const archivedSet = new Set(ws.archivedSessions);
    const ids = [...ws.sessionIds, ...(children.get(ws.id) ?? [])];
    const summaries = [];
    const sessions = [];
    let failedSessionCount = 0;

    for (const sessionId of ids) {
      const archived = archivedSet.has(sessionId);
      try {
        const summary = await scanner.scanSession(sessionId);
        const { totals, firstAt, lastAt } = totalsOfSummary(summary);
        const session = {
          id: sessionId,
          archived,
          ok: true,
          messages: num(summary?.messages),
          totals,
          firstAt,
          lastAt,
        };
        // 同内容的副本只算一次（详见 summaryFingerprint 的注释）。先到的算真身，
        // 后来的标记 duplicateOf 并**不**进入汇总——副本也是一份真实日志，
        // 所以仍然列在 sessions 里让用户看见，只是不重复计钱。
        const fingerprint = summaryFingerprint(summary);
        if (fingerprint !== '' && seenFingerprints.has(fingerprint)) {
          const original = seenFingerprints.get(fingerprint);
          session.duplicateOf = original;
          duplicateCopies.push({ sessionId, original, workspaceId: ws.id });
        } else {
          if (fingerprint !== '') seenFingerprints.set(fingerprint, sessionId);
          summaries.push(summary);
        }
        sessions.push(session);
      } catch (error) {
        // 一个会话读不出来只记在它自己身上：其它会话的数字仍然是对的，没理由一起丢。
        failedSessionCount += 1;
        sessions.push({
          id: sessionId,
          archived,
          ok: false,
          messages: 0,
          totals: zeroTotals(),
          firstAt: null,
          lastAt: null,
          error: errorText(error),
        });
      }
    }

    const merged = mergeSummaries(summaries);
    results.push({
      id: ws.id,
      title: ws.title,
      path: ws.path,
      // sessionCount 用"归属到本工作区的会话数"（含读取失败的），与界面上的会话列表长度一致；
      // 真正进了统计的数字看 messages/totals，失败的看 failedSessionCount。
      sessionCount: sessions.length,
      messages: merged.messages,
      kinds: merged.kinds,
      unclassified: merged.unclassified,
      totals: merged.totals,
      firstAt: merged.firstAt,
      lastAt: merged.lastAt,
      archivedSessions: ws.archivedSessions,
      pinnedSessions: ws.pinnedSessions,
      sessions,
      failedSessionCount,
      // 被识别为"同一段对话的另一份副本"而未计入汇总的会话数：界面可以据此提示用户
      // "有 N 个会话与别的会话内容相同，未重复计入"，而不是让人怀疑数字对不上。
      duplicateSessionCount: sessions.filter((s) => typeof s.duplicateOf === 'string').length,
      includeSubagents,
    });
  }

  if (duplicateCopies.length > 0) {
    const detail = duplicateCopies.map((d) => `${d.sessionId}（与 ${d.original} 内容相同）`).join('；');
    warn(`[dsh-quota-usage] 有 ${duplicateCopies.length} 个会话日志与另一份内容完全相同（分叉/复制留下的副本），已只计一次：${detail}`);
  }

  // 工作区级排序：消耗大的在前（与 usage.js 里厂商/模型排序同一套直觉），
  // 没用过的按标题兜底，保证顺序稳定。
  results.sort((a, b) => b.totals.totalTokens - a.totals.totalTokens || a.title.localeCompare(b.title));
  return results;
}

/**
 * 反查某个会话属于哪个工作区。
 *
 * 同时接受 resolveWorkspaces 与 scanWorkspaces 的输出（后者多了子代理会话，所以能让
 * 子代理会话也查得到自己的归属——这正是界面"这个会话算在哪个项目上"需要的答案）。
 *
 * 只返回一个轻量描述对象，不返回整份汇总：调用方通常是渲染一行标签，把几 MB 的
 * kinds 传进来没有意义。
 *
 * @param {any} mapping 工作区数组，或 `{ workspaces: [...] }`
 * @param {string} sessionId
 * @returns {{ id: string, title: string, path: string, archived: boolean } | null}
 */
export function workspaceOfSession(mapping, sessionId) {
  const id = str(sessionId);
  if (id === '') return null;
  const list = Array.isArray(mapping)
    ? mapping
    : Array.isArray(mapping?.workspaces)
      ? mapping.workspaces
      : [];
  for (const ws of list) {
    if (!isPlainObject(ws)) continue;
    const declared = Array.isArray(ws.sessionIds) ? ws.sessionIds : [];
    const detail = Array.isArray(ws.sessions) ? ws.sessions : [];
    const owns = declared.includes(id) || detail.some((item) => isPlainObject(item) && item.id === id);
    if (!owns) continue;
    const archived = Array.isArray(ws.archivedSessions) ? ws.archivedSessions.includes(id) : false;
    return { id: str(ws.id), title: str(ws.title), path: str(ws.path), archived };
  }
  return null;
}
