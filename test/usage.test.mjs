// 会话用量统计：回放会话日志，按「计费类型 → 厂商 → 模型」汇总。
//
// 这一组测试只覆盖纯逻辑（分类表、解析、汇总、去重、缓存失效），不碰真实会话目录：
// 统计口径错了会让用户看到错误的账单，比崩溃更糟。
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BILLING_KINDS,
  billingKindOf,
  isClassifiedProvider,
  summarize,
  listSessionFiles,
  readSessionEvents,
  decompressZstdFrames,
  createUsageScanner,
  createSessionModelResolver,
  lastModelOf,
  sessionsRoot,
} from '../lib/usage.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 造一条 assistant/message 事件。 */
function message({ id, provider, model, usage, time = 1000 }) {
  return {
    type: 'assistant/message',
    time,
    data: {
      message: { id, source: provider === undefined ? undefined : { provider, model } },
      usage,
    },
  };
}

test('分类表覆盖三大类型，且白名单外的 provider 归为 unknown', () => {
  assert.deepEqual(BILLING_KINDS, ['subscription', 'prepaid', 'credits', 'unknown']);

  // 订阅型
  for (const id of ['codex-chatgpt', 'anthropic', 'kimi-coding', 'opencode']) {
    assert.equal(billingKindOf(id), 'subscription', `${id} 应为订阅型`);
  }
  // 预充值型
  for (const id of ['deepseek-official', 'deepseek-account', 'moonshotai', 'zai', 'openrouter']) {
    assert.equal(billingKindOf(id), 'prepaid', `${id} 应为预充值型`);
  }
  // 积分型
  for (const id of ['trae', 'buddy', 'qodercn', 'minimax', 'zcode', 'raccoon']) {
    assert.equal(billingKindOf(id), 'credits', `${id} 应为积分型`);
  }
  // 未登记：不猜
  assert.equal(billingKindOf('some-gateway'), 'unknown');
  assert.equal(billingKindOf(''), 'unknown');
  assert.equal(billingKindOf(undefined), 'unknown');
  assert.equal(isClassifiedProvider('trae'), true);
  assert.equal(isClassifiedProvider('some-gateway'), false);
});

test('分类按路由 id 而不是厂商，且大小写与空白无关', () => {
  assert.equal(billingKindOf('  Codex-ChatGPT '), 'subscription');
  assert.equal(billingKindOf('TRAE'), 'credits');
  // 同一家厂商的不同路由可以属于不同类型。
  assert.equal(billingKindOf('deepseek-official'), 'prepaid');
  assert.equal(billingKindOf('deepseek-account'), 'prepaid');
  // 账号后缀属于账号 id，不属于 provider id，不做模糊匹配。
  assert.equal(billingKindOf('trae-d7b653fd'), 'unknown');
});

test('汇总：只统计 assistant/message，按类型 → 厂商 → 模型分层', () => {
  const events = [
    message({ id: 'a', provider: 'trae', model: 'deepseek-v4.1-flash', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } }),
    message({ id: 'b', provider: 'trae', model: 'deepseek-v4.1-flash', usage: { inputTokens: 200, outputTokens: 20 } }),
    message({ id: 'c', provider: 'trae', model: 'glm-5', usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 } }),
    message({ id: 'd', provider: 'codex-chatgpt', model: 'gpt-6.1-sol', usage: { inputTokens: 300, outputTokens: 30, totalTokens: 330 } }),
    message({ id: 'e', provider: 'deepseek-official', model: 'deepseek-flash', usage: { inputTokens: 400, outputTokens: 40, totalTokens: 440 } }),
    // 非 assistant/message 一律不计
    { type: 'user/message', time: 1000, data: { usage: { inputTokens: 999999 } } },
    { type: 'tool/result', time: 1000, data: { usage: { inputTokens: 999999 } } },
    null,
    'not an event',
  ];

  const summary = summarize(events);
  assert.equal(summary.messages, 5);
  assert.deepEqual(summary.kinds.map((k) => k.kind), ['subscription', 'prepaid', 'credits']);

  const credits = summary.kinds.find((k) => k.kind === 'credits');
  assert.equal(credits.messages, 3);
  assert.equal(credits.totalTokens, 110 + 220 + 55);
  // 厂商按 totalTokens 降序
  assert.equal(credits.providers.length, 1);
  const trae = credits.providers[0];
  assert.equal(trae.provider, 'trae');
  assert.equal(trae.classified, true);
  // 模型按 totalTokens 降序
  assert.deepEqual(trae.models.map((m) => m.model), ['deepseek-v4.1-flash', 'glm-5']);
  assert.equal(trae.models[0].messages, 2);
  // 没给 totalTokens 时按分项之和补齐
  assert.equal(trae.models[0].totalTokens, 110 + 220);
});

test('汇总：缓存读写与推理 token 一并计入，totalTokens 有值以它为准', () => {
  const summary = summarize([
    message({
      id: 'a',
      provider: 'buddy',
      model: 'deepseek-v4.1-flash',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 100,
        cacheWriteTokens: 7,
        reasoningTokens: 3,
        totalTokens: 999,
      },
    }),
  ]);
  const model = summary.kinds[0].providers[0].models[0];
  assert.equal(model.cacheReadTokens, 100);
  assert.equal(model.cacheWriteTokens, 7);
  assert.equal(model.reasoningTokens, 3);
  assert.equal(model.totalTokens, 999);
});

test('汇总：没有 usage 或缺字段的消息不计 token，但仍然计入消息数', () => {
  const summary = summarize([
    message({ id: 'a', provider: 'trae', model: 'x' }),
    message({ id: 'b', provider: 'trae', model: 'x', usage: { inputTokens: 'not-a-number' } }),
    message({ id: 'c', provider: 'trae', model: 'x', usage: { inputTokens: -5, outputTokens: null } }),
  ]);
  const model = summary.kinds[0].providers[0].models[0];
  assert.equal(model.messages, 3);
  assert.equal(model.totalTokens, 0);
});

test('汇总：同一条消息重复出现只统计一次', () => {
  const one = message({ id: 'same', provider: 'trae', model: 'x', usage: { inputTokens: 100, totalTokens: 100 } });
  const summary = summarize([one, { ...one }, { ...one }]);
  assert.equal(summary.messages, 1);
  assert.equal(summary.kinds[0].totalTokens, 100);
});

test('汇总：缺少 provider/model 的消息落到 unknown 分类，并列进 unclassified', () => {
  const summary = summarize([
    message({ id: 'a', provider: 'mystery-gateway', model: 'm1', usage: { inputTokens: 10, totalTokens: 10 } }),
    message({ id: 'b', usage: { inputTokens: 20, totalTokens: 20 } }),
  ]);
  const unknown = summary.kinds.find((k) => k.kind === 'unknown');
  assert.ok(unknown, '未分类的消息必须落在 unknown 里');
  assert.equal(unknown.classified, undefined);
  assert.deepEqual(summary.unclassified.sort(), ['(unknown)', 'mystery-gateway']);
  // 未分类的 provider 条目上 classified=false，界面据此标注
  for (const provider of unknown.providers) assert.equal(provider.classified, false);
});

test('汇总：时间窗取首末消息时刻', () => {
  const summary = summarize([
    message({ id: 'a', provider: 'trae', model: 'x', usage: { inputTokens: 1 }, time: 5000 }),
    message({ id: 'b', provider: 'trae', model: 'x', usage: { inputTokens: 1 }, time: 1000 }),
    message({ id: 'c', provider: 'trae', model: 'x', usage: { inputTokens: 1 }, time: 9000 }),
  ]);
  const provider = summary.kinds[0].providers[0];
  assert.equal(provider.firstAt, 1000);
  assert.equal(provider.lastAt, 9000);
});

test('空输入返回空结构而不是抛错', () => {
  const summary = summarize([]);
  assert.deepEqual(summary.kinds, []);
  assert.equal(summary.messages, 0);
  assert.deepEqual(summary.unclassified, []);
});

test('多帧 zstd：逐帧解压，不因只解第一帧而丢掉整份日志', async () => {
  // DSH 边写边压，一个会话文件里有几百个首尾相接的 zstd 帧。Node 24（宿主自带的
  // 运行时）的 zstdDecompressSync 只解第一帧，所以这里必须自己切帧——这个用例就是
  // 那次真实故障的回归：一份 671KB 的日志只解出 session 头一行，统计结果为 0。
  const lines = [
    JSON.stringify({ type: 'session', version: 4, id: 'session-x' }),
    JSON.stringify(message({ id: 'a', provider: 'trae', model: 'm', usage: { inputTokens: 10, totalTokens: 10 } })),
    JSON.stringify(message({ id: 'b', provider: 'buddy', model: 'm', usage: { inputTokens: 20, totalTokens: 20 } })),
  ];
  // 每行各自压成一个独立帧，再把帧拼起来 —— 与 DSH 的落盘形态一致。
  const frames = lines.map((line) => zlib.zstdCompressSync(Buffer.from(line + '\n', 'utf8')));
  const multiFrame = Buffer.concat(frames);

  // 前提：这个文件确实是多帧的（否则用例就没测到该测的东西）。
  assert.ok(multiFrame.length > frames[0].length, '构造出来的文件必须是多帧');

  const text = decompressZstdFrames(multiFrame);
  assert.equal(text.split('\n').filter(Boolean).length, 3);

  const dir = mkdtempSync(join(tmpdir(), 'dsh-usage-multiframe-'));
  try {
    const file = join(dir, 'session.v4.jsonl.zstd');
    writeFileSync(file, multiFrame);
    const events = await readSessionEvents(file);
    assert.equal(events.length, 3);
    const summary = summarize(events);
    assert.equal(summary.messages, 2);
    const credits = summary.kinds.find((k) => k.kind === 'credits');
    assert.equal(credits.totalTokens, 30);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('多帧 zstd：正在写入的最后一帧损坏时，只丢那一帧', () => {
  const good = zlib.zstdCompressSync(Buffer.from('{"type":"a"}\n', 'utf8'));
  const truncated = zlib.zstdCompressSync(Buffer.from('{"type":"b"}\n'.repeat(50), 'utf8')).subarray(0, 10);
  const text = decompressZstdFrames(Buffer.concat([good, truncated]));
  assert.ok(text.includes('"type":"a"'), '好的帧必须解出来');
  assert.ok(!text.includes('"type":"b"'), '损坏的帧被丢弃');
});

test('单帧文件同样走通', () => {
  const single = zlib.zstdCompressSync(Buffer.from('{"type":"a"}\n', 'utf8'));
  assert.equal(decompressZstdFrames(single).trim(), '{"type":"a"}');
});

test('空文件返回空串而不是抛错', () => {
  assert.equal(decompressZstdFrames(Buffer.alloc(0)), '');
});

test('readSessionEvents 跳过残缺行，不因最后一行半截而整份失败', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-usage-'));
  try {
    const file = join(dir, 'session.v4.jsonl.zstd');
    const body = [
      JSON.stringify({ type: 'assistant/message', time: 1, data: { usage: { inputTokens: 5 } } }),
      '{"type":"assistant/message","time":2,"data":{"usag',   // 进程被杀留下的半行
    ].join('\n');
    writeFileSync(file, zlib.zstdCompressSync(Buffer.from(body, 'utf8')));
    const events = await readSessionEvents(file);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'assistant/message');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listSessionFiles 递归找出全部会话日志，忽略其它文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-usage-'));
  try {
    const a = join(dir, '--workspace-a--', 'session-1');
    const b = join(dir, '--workspace-b--', 'session-2');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from('', 'utf8')));
    writeFileSync(join(b, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from('', 'utf8')));
    writeFileSync(join(b, 'notes.txt'), 'ignore me');
    const files = await listSessionFiles(dir);
    assert.equal(files.length, 2);
    assert.ok(files.every((f) => f.endsWith('.jsonl.zstd')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('扫描器：目录不存在时返回空统计而不是抛错', async () => {
  const scanner = createUsageScanner({ home: join(tmpdir(), 'definitely-not-here-dsh-usage') });
  const result = await scanner.scan();
  assert.deepEqual(result.kinds, []);
  assert.equal(result.messages, 0);
  assert.equal(result.files, 0);
});

test('扫描器：文件未变时复用缓存，变了才重算', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-usage-home-'));
  try {
    const dir = join(sessionsRoot(home), '--ws--', 'session-1');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'session.v4.jsonl.zstd');
    const body = JSON.stringify(message({ id: 'a', provider: 'trae', model: 'x', usage: { inputTokens: 10, totalTokens: 10 } }));
    writeFileSync(file, zlib.zstdCompressSync(Buffer.from(body, 'utf8')));

    const scanner = createUsageScanner({ home });
    const first = await scanner.scan();
    assert.equal(first.messages, 1);
    assert.equal(first.files, 1);
    assert.equal(first.cached, 0);

    // 文件没动：第二次走缓存
    const second = await scanner.scan();
    assert.equal(second.cached, 1);
    assert.equal(second.messages, 1);

    // 追加一条并让 mtime 变化：应当重算成 2 条
    const more = [
      body,
      JSON.stringify(message({ id: 'b', provider: 'trae', model: 'x', usage: { inputTokens: 20, totalTokens: 20 }, time: 3000 })),
    ].join('\n');
    writeFileSync(file, zlib.zstdCompressSync(Buffer.from(more, 'utf8')));
    const third = await scanner.scan();
    assert.equal(third.messages, 2);
    assert.equal(third.cached, 0);
    assert.equal(third.kinds[0].totalTokens, 30);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('会话过滤：给定 sessionId 时只收那一个会话的日志', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-usage-one-'));
  try {
    const a = join(dir, '--ws-a--', 'session-aaa');
    const b = join(dir, '--ws-b--', 'session-bbb');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from('', 'utf8')));
    writeFileSync(join(b, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from('', 'utf8')));

    assert.equal((await listSessionFiles(dir)).length, 2);
    const only = await listSessionFiles(dir, 'session-aaa');
    assert.equal(only.length, 1);
    assert.ok(only[0].includes('session-aaa'));
    // 不存在的会话：空结果，不是全部
    assert.deepEqual(await listSessionFiles(dir, 'session-nope'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('扫描器：scanSession 只统计该会话，与全机统计分开缓存', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-usage-sess-'));
  try {
    const one = join(sessionsRoot(home), '--ws--', 'session-one');
    const two = join(sessionsRoot(home), '--ws--', 'session-two');
    mkdirSync(one, { recursive: true });
    mkdirSync(two, { recursive: true });
    const body = (id, tokens) => JSON.stringify(message({ id, provider: 'trae', model: 'x', usage: { inputTokens: tokens, totalTokens: tokens } }));
    writeFileSync(join(one, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(body('a', 10), 'utf8')));
    writeFileSync(join(two, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(body('b', 20), 'utf8')));

    const scanner = createUsageScanner({ home });
    const all = await scanner.scan();
    assert.equal(all.messages, 2);
    assert.equal(all.sessionId, null);

    const single = await scanner.scanSession('session-one');
    assert.equal(single.messages, 1);
    assert.equal(single.totalTokens ?? single.kinds[0].totalTokens, 10);
    assert.equal(single.sessionId, 'session-one');
    assert.equal(single.files, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- 会话级模型：从日志回放"这个会话最后用的是哪个模型" ---------------------
//
// 背景（用户报的 bug）：「切换会话后如果另一个会话的大模型不同，面板还是没有自动
// 把当前大模型的标记改到刚切过去的会话的大模型那里」。
//
// 根因：宿主 `agentDefaultModel.currentSelection()` 是**全局默认选择**，与会话无关。
// 会话级模型只在客户端投影与会话日志里，宿主 ctx 拿不到——所以服务端从日志读。
//
// 本机 66 个会话的实测事实（决定了下面判据的形状）：
//   · `model/selection` 只有 13/66 有（只在手动切过模型的会话里写）；
//   · `request/header` 与 `assistant/message` 几乎每个会话都有；
//   · 三者的末值**互相一致**，所以取 seq 最大的那条即可，不需要定优先级。

/** 造一条 model/selection 事件（用户手动切模型时宿主写的）。 */
function selection({ provider, model, seq }) {
  return { type: 'model/selection', seq, time: seq, data: { provider, model } };
}

/** 造一条 request/header 事件（每次模型请求都写）。 */
function requestHeader({ provider, model, seq }) {
  return { type: 'request/header', seq, time: seq, data: { header: { config: { provider, model } } } };
}

test('lastModelOf：三类候选都能读出模型，取 seq 最大的那条', () => {
  // 只有 selection：切过模型的会话就是这种形状。
  assert.deepEqual(
    lastModelOf([selection({ provider: 'trae', model: 'deepseek-v4.1-flash', seq: 5 })]),
    { provider: 'trae', model: 'deepseek-v4.1-flash', from: 'model/selection' },
  );
  // 只有 request/header（没有手动切过模型）：这只占多数。
  assert.deepEqual(
    lastModelOf([requestHeader({ provider: 'buddy', model: 'deepseek-v4.1-flash', seq: 7 })]),
    { provider: 'buddy', model: 'deepseek-v4.1-flash', from: 'request/header' },
  );
  // 只有 assistant/message：
  assert.deepEqual(
    lastModelOf([message({ id: 'a', provider: 'minimax', model: 'MiniMax-M3.1-Flash', usage: { inputTokens: 1 } })]),
    { provider: 'minimax', model: 'MiniMax-M3.1-Flash', from: 'assistant/message' },
  );
});

test('lastModelOf：三类混在一起时按 seq 取最后写入的那一个', () => {
  const events = [
    requestHeader({ provider: 'trae', model: 'deepseek-v4.1-flash', seq: 10 }),
    selection({ provider: 'codex-chatgpt', model: 'gpt-6.1-sol', seq: 20 }),
    // 切到 codex 之后又发了一次请求：request/header 更晚，它才是"现在用的"
    requestHeader({ provider: 'codex-chatgpt', model: 'gpt-6.1-sol', seq: 30 }),
    selection({ provider: 'trae', model: 'deepseek-v4.1-flash', seq: 40 }),
  ];
  assert.deepEqual(lastModelOf(events), { provider: 'trae', model: 'deepseek-v4.1-flash', from: 'model/selection' });
});

test('lastModelOf：形状不对一律当没有（返回 null，不猜）', () => {
  assert.equal(lastModelOf([]), null);
  assert.equal(lastModelOf(null), null);
  assert.equal(lastModelOf([{ type: 'model/selection', seq: 1, data: {} }]), null);
  assert.equal(lastModelOf([{ type: 'request/header', seq: 1, data: { header: {} } }]), null);
  assert.equal(lastModelOf([{ type: 'assistant/message', seq: 1, data: { message: {} } }]), null);
  // 不相关的类型不参与。
  assert.equal(lastModelOf([{ type: 'user/message', seq: 1, data: { provider: 'x', model: 'y' } }]), null);
});

test('会话模型解析器：不同会话返回各自的模型（本次修复的核心断言）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-model-home-'));
  try {
    const one = join(sessionsRoot(home), '--ws--', 'session-trae');
    const two = join(sessionsRoot(home), '--ws--', 'session-buddy');
    mkdirSync(one, { recursive: true });
    mkdirSync(two, { recursive: true });
    const lines = (events) => zlib.zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n'), 'utf8'));
    writeFileSync(join(one, 'session.v4.jsonl.zstd'), lines([
      selection({ provider: 'trae', model: 'deepseek-v4.1-flash', seq: 1 }),
    ]));
    writeFileSync(join(two, 'session.v4.jsonl.zstd'), lines([
      requestHeader({ provider: 'buddy', model: 'deepseek-v4.1-flash', seq: 3 }),
    ]));

    const resolver = createSessionModelResolver({ home });
    const a = await resolver.resolve('session-trae');
    const b = await resolver.resolve('session-buddy');
    assert.equal(a.provider, 'trae', `会话 A 应给出 trae，实际 ${JSON.stringify(a)}`);
    assert.equal(b.provider, 'buddy', `会话 B 应给出 buddy，实际 ${JSON.stringify(b)}`);
    assert.notEqual(a.provider, b.provider, '**两个用不同模型的会话必须给出不同的 provider**');

    // 不存在的会话：null（调用方回落全局默认，不能凭空编一个）
    assert.equal(await resolver.resolve('session-nope'), null);
    assert.equal(await resolver.resolve(''), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('会话模型解析器：日志未变时结果稳定，追加后必须重算', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-model-cache-'));
  try {
    const dir = join(sessionsRoot(home), '--ws--', 'session-one');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'session.v4.jsonl.zstd');
    const first = [selection({ provider: 'trae', model: 'deepseek-v4.1-flash', seq: 1 })];
    writeFileSync(file, zlib.zstdCompressSync(Buffer.from(first.map((e) => JSON.stringify(e)).join('\n'), 'utf8')));

    const resolver = createSessionModelResolver({ home });
    assert.equal((await resolver.resolve('session-one')).provider, 'trae');
    // 同一份日志再问一次：仍是同一个答案（缓存命中时不会读盘，结果当然也不变）。
    assert.equal((await resolver.resolve('session-one')).provider, 'trae');

    // 追加一条新的选择：**缓存必须失效**，否则用户切了模型、面板却永远停在旧值上。
    const next = [
      ...first,
      selection({ provider: 'codex-chatgpt', model: 'gpt-6.1-sol', seq: 2 }),
    ];
    writeFileSync(file, zlib.zstdCompressSync(Buffer.from(next.map((e) => JSON.stringify(e)).join('\n'), 'utf8')));
    assert.equal((await resolver.resolve('session-one')).provider, 'codex-chatgpt', '日志变了必须重算');

    // 日志没了：返回 null（让调用方回落），不是把缓存里的旧模型端出来当现状。
    rmSync(file);
    assert.equal(await resolver.resolve('session-one'), null, '会话日志已不存在时不得返回旧值');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});