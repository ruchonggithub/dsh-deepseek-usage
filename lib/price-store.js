/**
 * dsh-quota-usage — 价格表的持久化层（可编辑的那一份价格事实）。
 *
 * 为什么要有这一层：
 *   价格原本硬编码在 lib/price-table.js 的 PRICE_RECORDS 里。用户要求「配置页能配单价」，
 *   而且口径是**直接改表**——不是「用户覆盖层叠在默认表上」。所以可编辑的那份数据必须
 *   独立于代码存在：代码里留下的 103 条是**种子**（SEED_RECORDS），运行时读的是这份
 *   落盘的表。种子只在「存储还不存在」或「用户主动 resetToSeed」时被写进去。
 *
 * 存储位置（跟着 DSH 的既有落盘约定走，不自创、不写系统临时目录）：
 *
 *   $DSH_HOME/storages/dsh-quota-usage/price-table.json
 *
 *   · `$DSH_HOME` 由 lib/usage.js 的 resolveDshHome() 解析（`$DSH_HOME` → `~/.dsh`），
 *     这是宿主 home-paths 的同一口径；
 *   · `storages/<插件命名空间>/` 是宿主自己的约定：lib/workspaces.js 读
 *     `$DSH_HOME/storages/workspace.json`，lib/subscription.js 写
 *     `$DSH_HOME/storages/dsh-chatgpt-subscription/`。这里沿用同一层；
 *   · 临时目录会被清理，用户手配的价格不能丢在那里，所以不用 tmpdir。
 *   · 需要指到别处（测试隔离 / 多份账本）时设 `DSH_QUOTA_USAGE_PRICE_STORE` 为
 *     绝对文件路径，优先级最高。
 *
 * 为什么 JSON 而不是 YAML：免依赖、JSON.parse 能严格校验、坏了立刻能看见；YAML 的隐式
 * 类型（`1.0` 变数字、`*` 变别名）会让价格悄悄变形，而价格变形是"账算错"而不是"报错"。
 *
 * 分层（避免两套校验漂移）：
 *   价格形态（uniform / split / free）与记录校验**只在这里实现一次**，因为现在有两条
 *   写入路径（配置页保存、种子初始化）和两条读取路径（取价、配置页列表）。lib/price-table.js
 *   从本模块 import `formOf` / `validateRecords`，并在模块底部 `registerSeed(SEED_RECORDS)`
 *   把种子交进来——**本模块不 import price-table**，因此没有循环依赖。
 *
 * ⚠️ 本模块不 import lib/price-table.js，`loadTable()` 依赖调用方先 registerSeed()。
 *   lib/price-table.js 在模块底部注册，任何 import price-table 的进程都已完成注册。
 *   若在注册之前就 loadTable()（只 import 了本模块），返回空表并标 `seed-unregistered`，
 *   **绝不**把空表落盘（那会毁掉用户的 103 条）。
 */

import * as nodeFs from 'node:fs';
import path from 'node:path';

import { resolveDshHome } from './usage.js';
import { todayInShanghai } from './credits.js';

/** 存储格式版本。将来改结构时靠它迁移（当前只有 1）。 */
export const STORE_VERSION = 1;

/** 插件命名空间（= 包名去掉 scope）。与宿主 `storages/<namespace>/` 的写法一致。 */
export const STORE_DIR_NAME = 'dsh-quota-usage';

/** 存储文件名。 */
export const STORE_FILE_NAME = 'price-table.json';

/** 覆盖存储位置的环变量（绝对文件路径）。 */
export const STORE_ENV = 'DSH_QUOTA_USAGE_PRICE_STORE';

/** 合法的 source 取值。`manual` = 用户在配置页手填的价（不是采集来的）。 */
export const SOURCES = new Set(['name-suffix', 'official-doc', 'manual', 'free']);

/** 合法的币种。 */
export const CURRENCIES = new Set(['CNY', 'USD']);

/** 有限数字判定（与 price-table 原来那份同义，搬过来只此一份）。 */
export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 字符串取值：非字符串一律空串，并去首尾空白。 */
function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 数字取值：接受 number 与非空数字字符串（`<input type="number">` 回传的是字符串）。 */
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 记录的 渠道×模型 键（provider 规范化为小写，model 精确匹配）。 */
export function recordKey(provider, model) {
  const providerId = str(provider).toLowerCase();
  const modelId = str(model);
  return `${providerId}\u0000${modelId}`;
}

/** 一条记录的键（从记录自身取）。 */
function keyOfRecord(record) {
  return recordKey(record === null || record === undefined ? '' : record.provider,
    record === null || record === undefined ? '' : record.model);
}

/**
 * 一条记录属于哪种价格形态；非法或矛盾时返回 null。
 *
 * 互斥是这个表的核心不变量：`uniform` 与分项价同时出现意味着"一个数字既是单一价
 * 又拆了输入输出"，任何消费方都无法判断该用哪个，所以宁可整条判非法也不要猜。
 *
 * @returns {'free'|'uniform'|'split'|null}
 */
export function formOf(record) {
  const hasUniform = record.uniform !== undefined;
  const hasSplit = record.input !== undefined || record.output !== undefined || record.cacheRead !== undefined;
  if (record.free === true) {
    // 免费记录不许再带任何价格字段。
    return hasUniform || hasSplit ? null : 'free';
  }
  if (hasUniform) {
    if (hasSplit) return null;
    return isFiniteNumber(record.uniform) ? 'uniform' : null;
  }
  if (hasSplit) {
    // 分项价必须三槽齐全：缺一档的"部分分项"会让总额算不出来却看起来算出来了。
    if (record.input === undefined || record.output === undefined || record.cacheRead === undefined) return null;
    return 'split';
  }
  return null;
}

/** 分项槽是否合法：{ standard: number, offPeak?: number }。 */
function validSlot(slot) {
  if (slot === null || typeof slot !== 'object') return false;
  if (!isFiniteNumber(slot.standard)) return false;
  if (slot.offPeak !== undefined && !isFiniteNumber(slot.offPeak)) return false;
  return true;
}

/**
 * 加载/写入共用的自检：剔除非法记录，并给出原因。
 *
 * 为什么不抛错：一张表里一条坏数据不该让整个插件加载失败（用户会失去全部用量展示）。
 * 但也不能静默——问题清单随 loadTable() 一起返回（price-table 用它算 PRICE_RECORD_PROBLEMS，
 * 测试断言种子那份为空），造表出错时在 CI 就炸，而不是等界面上显示一个错的金额。
 *
 * @param {unknown} records 待校验的记录数组
 * @returns {{record: unknown, reason: string}[]} 每条非法记录一条问题
 */
export function validateRecords(records) {
  const problems = [];
  if (!Array.isArray(records)) return [{ record: records, reason: '记录集合不是数组' }];
  const seen = new Set();
  for (const record of records) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      problems.push({ record, reason: '记录不是对象' });
      continue;
    }
    const provider = typeof record.provider === 'string' ? record.provider.trim().toLowerCase() : '';
    const model = typeof record.model === 'string' ? record.model.trim() : '';
    if (provider === '' || model === '') {
      problems.push({ record, reason: 'provider 或 model 为空' });
      continue;
    }
    const key = `${provider}\u0000${model}`;
    if (seen.has(key)) {
      problems.push({ record, reason: `重复的 渠道×模型：${provider}/${model}` });
      continue;
    }
    seen.add(key);
    if (!SOURCES.has(record.source)) {
      problems.push({ record, reason: `非法 source：${String(record.source)}` });
      continue;
    }
    if (!CURRENCIES.has(record.currency)) {
      problems.push({ record, reason: `非法 currency：${String(record.currency)}` });
      continue;
    }
    if (typeof record.asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.asOf)) {
      problems.push({ record, reason: `asOf 不是 YYYY-MM-DD：${String(record.asOf)}` });
      continue;
    }
    const form = formOf(record);
    if (form === null) {
      problems.push({ record, reason: '价格形态缺失或互相矛盾（uniform 与分项价只能二选一）' });
      continue;
    }
    if (form === 'split') {
      if (!validSlot(record.input) || !validSlot(record.output) || !validSlot(record.cacheRead)) {
        problems.push({ record, reason: '分项价槽位不是 { standard, offPeak? } 形状' });
        continue;
      }
      // 有 offPeak 却没有 schedule：判峰谷无从下手，取价会静默落到 offPeak。
      const hasOffPeak = [record.input, record.output, record.cacheRead]
        .some((slot) => slot.offPeak !== undefined);
      if (hasOffPeak && (record.schedule === null || typeof record.schedule !== 'object')) {
        problems.push({ record, reason: '有 offPeak 却没有 schedule' });
        continue;
      }
    }
    if (record.promotion !== undefined) {
      const promo = record.promotion;
      if (promo === null || typeof promo !== 'object'
        || !isFiniteNumber(promo.original) || !isFiniteNumber(promo.current)) {
        problems.push({ record, reason: 'promotion 不是 { original, current } 数字对' });
        continue;
      }
      if (form !== 'uniform') {
        problems.push({ record, reason: 'promotion 只对单一价（uniform）有数值含义' });
        continue;
      }
      // uniform 必须就是现价，否则只读 uniform 的消费方会拿到过期价。
      if (promo.current !== record.uniform) {
        problems.push({ record, reason: 'promotion.current 与 uniform 不一致' });
        continue;
      }
    }
  }
  return problems;
}

// ───────────────────────────────────────────────────────────────────────────
// 三字段统一输入 → 记录形态
//
// 用户口径（不要重新设计）：配置页只有一个 input / output / cacheRead 三字段的表单，
// 单一价渠道就让用户三个框填一样的值。于是这里必须回答"三个值怎么落到计费上"。
//
// 三种原形态的计费方式不同：
//   · uniform  ——  uniform × totalTokens
//   · split    ——  input×inputTokens + output×outputTokens + cacheRead×cacheReadTokens
//   · free     ——  没有金额
//
// 转换规则：
//   三值全等且 > 0  → uniform（渠道只给一个数字，就按"总共过了多少 token"计）
//   三值全等且 = 0  → free（零价即免费；不写成 uniform:0，否则界面会显示"花了 ¥0.00"）
//   三值不等        → split（standard = 三个值；原记录有峰谷 schedule 时 offPeak 也写同值）
//
// ⚠️ 金额口径的取舍（规格点名必须说明）：`uniform × totalTokens` 与「三值相等的 split」
//   算出来的金额**不完全相等**——totalTokens 可能包含 reasoning 等不落在四个分项里的
//   token，而 split 只乘四个分项。所以三值相等时选 uniform，理由是：
//     1) 它保住单一价渠道原本的计费口径，不会因为用户"把三个框填成一样"就悄悄少算
//        reasoning 那部分钱（少算钱比多算钱更难被发现）；
//     2) cost.js 据此给出 singlePrice:true，界面继续标「该渠道只提供单一价」，
//        与用户"这就是一个价"的意图一致；
//     3) 不会出现"填了一样的三个数，总额却变了"这种无法从界面解释的现象。
//   想强制按分项算（例如刻意排除 reasoning）时显式传 `{ form: 'split' }`，那是明确选择，
//   不是默认行为。
// ───────────────────────────────────────────────────────────────────────────

/** 三值全等的判定（浮点用 ===：用户填的是同一个字面量，不需要容差）。 */
function allEqual(a, b, c) {
  return a === b && b === c;
}

/** 三个数字的规范化：必须是有限非负数。返回 null 表示不合法。 */
function tripleOf(values) {
  const input = num(values.input);
  const output = num(values.output);
  const cacheRead = num(values.cacheRead);
  if (input === null || output === null || cacheRead === null) return null;
  if (input < 0 || output < 0 || cacheRead < 0) return null;
  return { input, output, cacheRead };
}

/** 取分项槽的一档（缺少时退到 standard），供配置页预填。 */
function slotValue(slot, tier) {
  if (slot === null || typeof slot !== 'object') return null;
  if (tier === 'offPeak' && isFiniteNumber(slot.offPeak)) return slot.offPeak;
  return isFiniteNumber(slot.standard) ? slot.standard : null;
}

/**
 * 把一条记录摊成配置页的三字段（预填值）。
 *
 * 单一价记录三个框预填同一个值——用户改价时看到的就是"这就是那个价格"，
 * 而不是"输入价 0.75 / 输出价 ——"这种拆出来的假分项。
 *
 * @param {object} record 存储里的记录
 * @returns {object|null} 记录形态不认识时返回 null
 */
export function unifiedPricesOf(record) {
  if (record === null || typeof record !== 'object') return null;
  const form = formOf(record);
  const base = {
    provider: str(record.provider).toLowerCase(),
    model: str(record.model),
    displayName: str(record.displayName) === '' ? str(record.model) : str(record.displayName),
    currency: record.currency,
    source: record.source,
    asOf: record.asOf,
    form,
    free: form === 'free',
    input: null,
    output: null,
    cacheRead: null,
    // 峰谷两档是否不同价。true 时保存会把两档合并为同价（配置页据此给提示）。
    peakDiffers: false,
    offPeak: null,
  };
  if (form === 'uniform') {
    return { ...base, input: record.uniform, output: record.uniform, cacheRead: record.uniform };
  }
  if (form === 'free') {
    return { ...base, input: 0, output: 0, cacheRead: 0 };
  }
  if (form !== 'split') return null;
  const input = slotValue(record.input, 'standard');
  const output = slotValue(record.output, 'standard');
  const cacheRead = slotValue(record.cacheRead, 'standard');
  const offPeak = {
    input: slotValue(record.input, 'offPeak'),
    output: slotValue(record.output, 'offPeak'),
    cacheRead: slotValue(record.cacheRead, 'offPeak'),
  };
  const peakDiffers = offPeak.input !== input || offPeak.output !== output || offPeak.cacheRead !== cacheRead;
  return { ...base, input, output, cacheRead, peakDiffers, offPeak: peakDiffers ? offPeak : null };
}

/**
 * 把三字段输入落成一条记录（纯函数，不写盘）。
 *
 * 保留原记录里"与价格无关"的元信息（displayName / currency / schedule / 展示顺序），
 * 清掉"用户改价后已不成立"的三样：
 *   · promotion —— 厂商促销只对 uniform 有数值含义，且它记的是厂商的现价，用户手填之后
 *     再挂着就是在说"这个 0.1 是促销价"，与事实不符；
 *   · mirrors   —— 手定价不再是"对应官方 X 的镜像价"；
 *   · free      —— 一旦填了非零值就转成 uniform / split，free 标记必须消失。
 * 把被清掉的原始值留在 `seedSource` / `seedAsOf` / `seedPromotion` / `seedMirrors` 里，
 * 便于排查"这条原本是什么"。
 *
 * @param {object|null} base 原记录（新建时传 null）
 * @param {{input: number|string, output: number|string, cacheRead: number|string}} values 三字段
 * @param {{form?: 'uniform'|'split'|'free', now?: number}} [options] form 可强制形态
 * @returns {{record: object, notices: string[]}}
 * @throws {Error} 三字段不是有限非负数，或 base 缺 provider/model
 */
export function withUnifiedPrices(base, values, options = {}) {
  const source = base !== null && typeof base === 'object' ? { ...base } : {};
  const provider = str(source.provider);
  const model = str(source.model);
  if (provider === '' || model === '') throw new Error('记录缺 provider 或 model');
  const triple = tripleOf(values === null || values === undefined ? {} : values);
  if (triple === null) throw new Error('input / output / cacheRead 必须是有限的非负数');
  const forced = options.form;
  if (forced !== undefined && !['uniform', 'split', 'free'].includes(forced)) {
    throw new Error(`不支持的 form：${String(forced)}`);
  }

  const notices = [];
  // 清掉所有价格字段，下面按形态重建（避免 uniform 与分项价同时存在）。
  const record = { ...source };
  const hadPromotion = record.promotion !== undefined;
  const hadMirrors = record.mirrors !== undefined;
  const hadSchedule = record.schedule !== undefined && record.schedule !== null;
  if (hadPromotion) {
    record.seedPromotion = record.promotion;
    notices.push('promotion-cleared');
  }
  if (hadMirrors) {
    record.seedMirrors = record.mirrors;
    notices.push('mirrors-cleared');
  }
  delete record.uniform;
  delete record.free;
  delete record.input;
  delete record.output;
  delete record.cacheRead;
  delete record.promotion;
  delete record.mirrors;

  // 形态判定：强制值优先，否则按三值关系自动决定。
  let form = forced;
  if (form === undefined) {
    if (!allEqual(triple.input, triple.output, triple.cacheRead)) form = 'split';
    else form = triple.input > 0 ? 'uniform' : 'free';
  }

  if (form === 'uniform') {
    if (!allEqual(triple.input, triple.output, triple.cacheRead)) {
      throw new Error('uniform 要求三个值相等（单一价不能拆成输入/输出）');
    }
    record.uniform = triple.input;
    // uniform 没有峰谷概念：schedule 留着会让消费方以为有区间价。
    if (hadSchedule) {
      record.seedSchedule = record.schedule;
      delete record.schedule;
      notices.push('schedule-dropped');
    }
  } else if (form === 'split') {
    if (hadSchedule) {
      // 峰谷合并为同价：standard 与 offPeak 都写用户填的值，schedule 保留。
      // 保留 schedule 有两个原因：①「有 offPeak 却没有 schedule」是非法记录；
      // ② 界面的峰谷指示灯与倒计时靠它，删掉会让卡片与统计给出相反结论。
      record.input = { standard: triple.input, offPeak: triple.input };
      record.output = { standard: triple.output, offPeak: triple.output };
      record.cacheRead = { standard: triple.cacheRead, offPeak: triple.cacheRead };
      notices.push('peak-merged');
    } else {
      // 原本全天一价：只写 standard，不凭空造一个 schedule。
      record.input = { standard: triple.input };
      record.output = { standard: triple.output };
      record.cacheRead = { standard: triple.cacheRead };
    }
  } else {
    record.free = true;
    if (hadSchedule) {
      record.seedSchedule = record.schedule;
      delete record.schedule;
      notices.push('schedule-dropped');
    }
    notices.push('now-free');
  }

  // 改过的价不再是采集来的：来源改成 manual，采集日期改成今天（北京时间）。
  // 原值留在 seed* 里，界面仍可解释"这条原本来自哪里"。
  // `seedSource === undefined` 这个条件很重要：同一条被改第二次时，record.source 已经是
  // 'manual'，再抄一次就把**真正的出处**（name-suffix / official-doc）覆盖掉了。
  if (record.source !== 'manual' && record.seedSource === undefined) {
    record.seedSource = record.source;
    record.seedAsOf = record.asOf;
  }
  record.source = 'manual';
  record.asOf = todayInShanghai(isFiniteNumber(options.now) ? options.now : Date.now());
  record.currency = CURRENCIES.has(record.currency) ? record.currency : 'CNY';
  if (str(record.displayName) === '') record.displayName = str(record.model);

  return { record, notices };
}

// ───────────────────────────────────────────────────────────────────────────
// 存储实现
// ───────────────────────────────────────────────────────────────────────────

/** 深拷贝（JSON 边界等价：写盘读回来就是这份数据，没有函数/undefined 语义）。 */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * 造一个价格表存储实例。
 *
 * 为什么做成工厂而不是一堆模块级函数：原子写的失败路径必须能被测（"写一半失败不得
 * 破坏原文件"）。工厂让测试注入一个会在写途中抛错的 fs 包装，同时指向临时目录，
 * 不去碰真实 $DSH_HOME。
 *
 * @param {{fs?: object, file?: string, home?: string}} [options]
 *   fs   注入的 fs 实现（默认 node:fs；测试用来模拟写失败）
 *   file 显式文件路径（优先级最高；测试用）
 *   home DSH home（默认按 $DSH_HOME → ~/.dsh 解析）
 */
export function createPriceStore(options = {}) {
  const fs = options.fs !== undefined && options.fs !== null ? options.fs : nodeFs;
  const explicitFile = str(options.file) === '' ? null : path.resolve(str(options.file));
  const explicitHome = str(options.home) === '' ? null : str(options.home);

  /** 种子记录（由 registerSeed 注入；本模块不 import price-table）。 */
  let seed = null;

  /** 上一次读到的表 + 文件指纹（mtime/size 变了才重读）。 */
  let cache = null;

  /** 种子落盘失败过一次（只读盘 / 权限不足）；置位后不再每次取价都重试。 */
  let seedWriteFailed = false;

  /** 存储文件路径（每次现算，便于测试中途改 env）。 */
  function storePath() {
    if (explicitFile !== null) return explicitFile;
    const fromEnv = str(process.env[STORE_ENV]);
    if (fromEnv !== '') return path.resolve(fromEnv);
    const home = explicitHome !== null ? explicitHome : resolveDshHome();
    return path.join(home, 'storages', STORE_DIR_NAME, STORE_FILE_NAME);
  }

  /**
   * 注册种子（lib/price-table.js 在模块底部调用一次）。
   *
   * 允许重复注册（热重载 / 测试里重建模块），后注册的覆盖前一份。
   * 非法输入不抛错：种子坏了也应该能启动，只是首次初始化会报 `seed-invalid`。
   */
  function registerSeed(records) {
    seed = Array.isArray(records) ? records : null;
    return seed === null ? 0 : seed.length;
  }

  /** 种子的一份可写副本（深拷贝，避免调用方就地改到 price-table 的常量）。 */
  function seedRecords() {
    return seed === null ? [] : clone(seed);
  }

  /** 日志式结果：一次 loadTable 的全部事实。 */
  function tableOf(records, source, extra = {}) {
    return {
      records,
      source,
      // 调用方通常已经算过一次路径了，传进来避免每次取价都重建一遍路径。
      storePath: extra.storePath ?? storePath(),
      updatedAt: extra.updatedAt ?? null,
      // notices 是机器可读的短标记（界面/测试按它分支），notes 是给人看的中文说明。
      notices: extra.notices ?? [],
      problems: extra.problems ?? [],
    };
  }

  /**
   * 读文件 → 表；任何一步失败都回落到种子（但**不覆盖**用户的坏文件）。
   *
   * 回落结果也进缓存：一份坏文件不该让统计页每算一个模型就重解一遍 JSON。
   * 文件一被修好（mtime 变）缓存自动失效。
   */
  function fallback(reason, detail, options = {}) {
    const records = seedRecords();
    const file = options.storePath ?? storePath();
    const table = tableOf(records, 'seed-fallback', {
      storePath: file,
      notices: [reason],
      problems: [{
        record: null,
        reason: `${detail}${options.at === undefined ? '' : `（${options.at}）`}`,
      }],
    });
    cache = options.stat === undefined || options.stat === null
      ? null
      : { path: file, mtimeMs: options.stat.mtimeMs, size: options.stat.size, table };
    return table;
  }

  /** 把一份记录写成存储（原子写：临时文件 → fsync → rename）。 */
  function writeStore(records, extra = {}) {
    const file = storePath();
    const payload = {
      version: STORE_VERSION,
      updatedAt: new Date().toISOString(),
      records,
    };
    // 缩进 2 + 末尾换行：人工可读、git diff 友好。
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    atomicWrite(fs, file, text);
    // 写得进去就说明盘是可写的：解除"上次落盘失败"的封印。
    seedWriteFailed = false;
    const table = tableOf(records, 'store', {
      storePath: file,
      updatedAt: payload.updatedAt,
      notices: extra.notices ?? [],
      problems: extra.problems ?? [],
    });
    // 直接把新内容放进缓存：不依赖文件 mtime 的分辨率（同毫秒内两次写可能撞上）。
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      stat = null;
    }
    cache = stat === null
      ? null
      : { path: file, mtimeMs: stat.mtimeMs, size: stat.size, table };
    return table;
  }

  /**
   * 读价格表。
   *
   * 优先级：存储文件 → 种子（首次运行则落盘）。
   * 存储损坏（非法 JSON / 结构不对 / 读不出来）时**回落种子并报告**，绝不抛错：
   * 统计页不能因为一份配置文件坏了就整片消失；同时也不覆盖坏文件——那是用户的字节，
   * 让人能自己看一眼，或用 resetToSeed() 明确重置。
   *
   * @returns {{records: object[], source: 'store'|'seed'|'seed-fallback'|'seed-unregistered',
   *   storePath: string, updatedAt: string|null, notices: string[],
   *   problems: {record: unknown, reason: string}[]}}
   */
  function loadTable() {
    const file = storePath();
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      stat = null;
    }

    if (stat === null || stat.isFile?.() === false) {
      // 存储还不存在 → 首次运行：把种子写进去（写失败也要能继续用）。
      return initializeSeed(file);
    }
    if (cache !== null && cache.path === file
      && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
      return cache.table;
    }

    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      return fallback('store-read-error', '价格存储读不出来，已回落种子', { at: errorMsg(error), stat, storePath: file });
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return fallback('store-parse-error', '价格存储不是合法 JSON，已回落种子', { at: errorMsg(error), stat, storePath: file });
    }
    const records = Array.isArray(parsed)
      ? parsed
      : (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.records) ? parsed.records : null);
    if (records === null) {
      return fallback('store-shape-error', '价格存储不是记录数组，已回落种子', { stat, storePath: file });
    }
    const problems = validateRecords(records);
    const table = tableOf(records, 'store', {
      storePath: file,
      updatedAt: parsed !== null && typeof parsed === 'object' && typeof parsed.updatedAt === 'string'
        ? parsed.updatedAt
        : null,
      notices: problems.length === 0 ? [] : ['store-has-invalid-records'],
      problems,
    });
    cache = { path: file, mtimeMs: stat.mtimeMs, size: stat.size, table };
    return table;
  }

  /** 首次运行：种子落盘；没有注册种子时不写（宁可空表也不把空表写进用户的存储）。 */
  function initializeSeed(file) {
    const records = seedRecords();
    if (records.length === 0) {
      // 只 import 了本模块、还没 registerSeed 的情形：返回空表并标出来，绝不落盘。
      cache = null;
      return tableOf([], 'seed-unregistered', {
        notices: ['seed-unregistered'],
        problems: [{ record: null, reason: '尚未注册种子记录（lib/price-table.js 未加载）' }],
      });
    }
    // 落盘失败过就不再每次取价都重试：只读盘（插件目录被挂成只读）时否则每算一个模型
    // 都会白跑一次 mkdir + open。用户真的修好权限后，下一次 saveRecord/resetToSeed 会
    // 重新尝试并成功。
    if (seedWriteFailed) {
      return tableOf(records, 'seed', {
        notices: ['seed-write-failed'],
        problems: [{ record: null, reason: '种子落盘上次已失败（仍按种子取价）' }],
      });
    }
    try {
      const written = writeStore(records, { notices: ['seed-initialized'] });
      // 数据来源这一次是种子（虽然已经落盘）。用一个新的外壳改 source，缓存里留的是
      // writeStore 那份（source: 'store'）——于是"本次刚初始化"与"之后读的是已有存储"
      // 能区分开，也不会出现同一份数据两次调用给两个不同 source 的摇摆。
      return { ...written, source: 'seed' };
    } catch (error) {
      seedWriteFailed = true;
      cache = null;
      return tableOf(records, 'seed', {
        notices: ['seed-write-failed'],
        problems: [{ record: null, reason: `种子落盘失败（本次仍按种子取价）：${errorMsg(error)}` }],
      });
    }
  }

  /**
   * 保存一条或一批记录。
   *
   * 两种入参形态（按 `input` 的类型区分，不会歧义）：
   *   · 三字段编辑：`{ provider, model, input: 0.75, output: 0.75, cacheRead: 0.75 }`
   *     —— 配置页直接把这一个对象丢进来即可，形态转换见 withUnifiedPrices()；
   *   · 完整记录：`{ provider, model, currency, uniform, ... }` 或带分项槽的对象
   *     —— 原样保存（仍然过一遍 validateRecords）。
   *
   * 整批成功才落盘：有一条不合法就整批拒写（返回 ok:false 与原表），不做"写一半"。
   *
   * @param {object|object[]} input 单条或批量
   * @returns {{ok: boolean, saved: object[], table: object[], notices: string[],
   *   problems: {record: unknown, reason: string}[], storePath: string, error?: string}}
   */
  function saveRecord(input) {
    const items = Array.isArray(input) ? input : [input];
    const current = loadTable();
    const records = clone(current.records);
    const saved = [];
    const notices = [];
    const problems = [];

    for (const item of items) {
      try {
        const prepared = prepare(item, records);
        // 逐条过校验：宁可拒写，也不要把非法记录落盘后又被读取路径默默忽略。
        const invalid = validateRecords([prepared.record]);
        if (invalid.length > 0) {
          problems.push({ record: item, reason: invalid[0].reason });
          continue;
        }
        upsert(records, prepared.record);
        saved.push(prepared.record);
        for (const notice of prepared.notices) if (!notices.includes(notice)) notices.push(notice);
      } catch (error) {
        problems.push({ record: item, reason: errorMsg(error) });
      }
    }

    if (problems.length > 0) {
      // 有一条不合法就整批不写：批量保存的语义是"这些都要存下来"，静默存一半会让用户
      // 以为全都生效了。
      return {
        ok: false, saved: [], table: current.records, notices: [], problems,
        storePath: current.storePath,
        error: `有 ${problems.length} 条不合法，整批未写入：${problems[0].reason}`,
      };
    }
    if (saved.length === 0) {
      return {
        ok: false, saved: [], table: current.records, notices, problems, storePath: current.storePath,
        error: '没有可保存的记录',
      };
    }

    try {
      // 原来是坏文件、现在整表重写成合法 JSON：要告诉调用方"你的坏文件被新表替换了"，
      // 否则用户会以为那几条改价悄悄丢了（实际是坏文件根本读不出来）。
      if (current.source === 'seed-fallback' && !notices.includes('overwrote-corrupt-store')) {
        notices.push('overwrote-corrupt-store');
      }
      const table = writeStore(records, { notices });
      return {
        ok: true, saved, table: table.records, notices, problems, storePath: table.storePath,
      };
    } catch (error) {
      // 写盘失败：原文件必须原样还在（atomicWrite 只 rename 成功才算成功）。
      return {
        ok: false, saved: [], table: current.records, notices, problems, storePath: current.storePath,
        error: `写入失败（原文件未改动）：${errorMsg(error)}`,
      };
    }
  }

  /** 把一条入参变成可保存的记录（三字段编辑走转换，完整记录原样用）。 */
  function prepare(item, records) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('记录不是对象');
    }
    const provider = str(item.provider);
    const model = str(item.model);
    if (provider === '' || model === '') throw new Error('记录缺 provider 或 model');
    const existing = records.find((row) => keyOfRecord(row) === recordKey(provider, model)) ?? null;

    const unifiedEdit = typeof item.input === 'number' || typeof item.input === 'string';
    if (unifiedEdit) {
      const base = existing ?? { provider, model, currency: 'CNY' };
      const { record, notices } = withUnifiedPrices(base, {
        input: item.input,
        output: item.output,
        cacheRead: item.cacheRead,
      }, { form: item.form, now: item.now });
      // 三字段编辑允许顺带改展示名/币种/是否免费以外的元信息，但不允许改形态判定依据。
      if (str(item.displayName) !== '') record.displayName = str(item.displayName);
      if (CURRENCIES.has(item.currency)) record.currency = item.currency;
      return { record, notices };
    }

    // 完整记录：补齐必填元信息后原样保存。
    if (existing !== null) {
      const merged = { ...existing, ...item };
      if (str(merged.displayName) === '') merged.displayName = str(merged.model);
      return { record: merged, notices: [] };
    }
    return {
      record: {
        ...item,
        provider: str(item.provider).toLowerCase(),
        model: str(item.model),
        displayName: str(item.displayName) === '' ? str(item.model) : str(item.displayName),
        currency: CURRENCIES.has(item.currency) ? item.currency : 'CNY',
        source: SOURCES.has(item.source) ? item.source : 'manual',
        asOf: typeof item.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.asOf)
          ? item.asOf
          : todayInShanghai(),
      },
      notices: [],
    };
  }

  /**
   * 恢复种子（用户改坏了能救回来）。
   *
   * 直接整表覆盖，不做合并：种子的语义就是"出厂那张表"。
   */
  function resetToSeed() {
    const records = seedRecords();
    if (records.length === 0) {
      const current = loadTable();
      return {
        ok: false, saved: [], table: current.records, notices: ['seed-unregistered'],
        problems: [{ record: null, reason: '尚未注册种子记录，无法重置' }], storePath: current.storePath,
        error: '尚未注册种子记录，无法重置',
      };
    }
    try {
      const table = writeStore(records, { notices: ['reset-to-seed'] });
      return {
        ok: true, saved: records, table: table.records, notices: ['reset-to-seed'],
        problems: [], storePath: table.storePath,
      };
    } catch (error) {
      const current = loadTable();
      return {
        ok: false, saved: [], table: current.records, notices: [], problems: [],
        storePath: current.storePath, error: `写入失败（原文件未改动）：${errorMsg(error)}`,
      };
    }
  }

  /** 供配置页读取的记录（深拷贝：调用方随便改，不会伤到缓存里的那份）。 */
  function listRecords() {
    return clone(loadTable().records);
  }

  /** 当前种子的条数（诊断用；不返回记录本身，避免被就地改）。 */
  function seedCount() {
    return seed === null ? 0 : seed.length;
  }

  return {
    loadTable,
    saveRecord,
    resetToSeed,
    listRecords,
    registerSeed,
    storePath,
    seedCount,
  };
}

/** 错误文本（异常对象/字符串都吃）。 */
function errorMsg(error) {
  if (error === null || error === undefined) return '';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string') return error.message;
  return String(error);
}

/** 原子写的临时文件序号：同进程内唯一即可（跨进程靠文件名里的 pid 区分）。 */
let atomicSeq = 0;

/**
 * 原子写：临时文件 → fsync → rename。
 *
 * 为什么必须这么写：配置页保存时最怕"文件被截断成半份"——那样下次启动会读到一个非法
 * JSON，全部价格回落种子，用户手填的 103 条里改过的那几条就看不见了（虽然没丢，但也
 * 找不回来）。rename 在同一分区内是原子的：读者要么看到旧文件，要么看到新文件。
 *
 * 失败路径：任何一步抛错都关 fd、删临时文件，然后原样抛出——调用方据此报错，
 * 原文件一个字节都没动。
 */
function atomicWrite(fs, file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  atomicSeq += 1;
  const tmp = `${file}.${process.pid}.${atomicSeq}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    const buffer = Buffer.from(text, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      offset += fs.writeSync(fd, buffer, offset, buffer.length - offset, null);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 关不掉也只能继续删临时文件 */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件可能根本没建出来 */
    }
    throw error;
  }
}

/** 把 newRecord 写进 records：同键替换（保持原位置），新键追加。 */
function upsert(records, newRecord) {
  const key = keyOfRecord(newRecord);
  const index = records.findIndex((row) => keyOfRecord(row) === key);
  if (index === -1) records.push(newRecord);
  else records[index] = newRecord;
  return records;
}

// ───────────────────────────────────────────────────────────────────────────
// 插件运行时用的默认实例
//
// 账号/统计都走这一份。价格改完立刻生效：每次 priceOf() 都会问一次 loadTable()，
// 它按 mtime + size 判断文件是否变过，saveRecord() 还会直接把新内容放进缓存，
// 所以配置页保存后**不需要重启**。
// ───────────────────────────────────────────────────────────────────────────

const defaultStore = createPriceStore();

/** 注册种子（lib/price-table.js 在模块底部调用）。 */
export function registerSeed(records) {
  return defaultStore.registerSeed(records);
}

/** 读价格表（默认实例）。见 createPriceStore().loadTable。 */
export function loadTable() {
  return defaultStore.loadTable();
}

/** 保存一条/一批记录（默认实例）。见 createPriceStore().saveRecord。 */
export function saveRecord(input) {
  return defaultStore.saveRecord(input);
}

/** 恢复种子（默认实例）。 */
export function resetToSeed() {
  return defaultStore.resetToSeed();
}

/** 列出记录（默认实例，深拷贝）。 */
export function listRecords() {
  return defaultStore.listRecords();
}

/** 存储文件路径（默认实例）。 */
export function storePath() {
  return defaultStore.storePath();
}

/** 种子条数（默认实例）。 */
export function seedCount() {
  return defaultStore.seedCount();
}
