// 工作区维度统计：把会话按所在工作区归堆，再复用 usage.js 的 summarize 结构汇总。
//
// 这组测试只覆盖纯逻辑与文件映射，全部用临时目录造数据，不读真实 `~/.dsh`：
// 工作区归属算错会让用户拿错误的项目账单去做预算决策，比崩溃更糟。
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { summarize, createUsageScanner, sessionsRoot } from '../lib/usage.js';
import {
  resolveWorkspaces,
  scanWorkspaces,
  workspaceOfSession,
  workspaceStorePath,
  readSessionHeader,
} from '../lib/workspaces.js';

// ── 造数据的小工具 ────────────────────────────────────────────────

/** 造一条 assistant/message 事件（形状与 DSH 会话日志一致）。 */
function message({ id, provider, model, usage, time = 1000 }) {
  return {
    type: 'assistant/message',
    time,
    data: { message: { id, source: { provider, model } }, usage },
  };
}

/** 造一份"会话日志文本"：会话头 + N 条 assistant 消息。 */
function sessionBody({ id, parentSession, cwd, origin, messages }) {
  const head = { type: 'session', version: 4, id };
  if (cwd !== undefined) head.cwd = cwd;
  if (parentSession !== undefined) head.parentSession = parentSession;
  if (origin !== undefined) head.origin = origin;
  const lines = [JSON.stringify(head)];
  for (const m of messages) lines.push(JSON.stringify(m));
  return lines.join('\n') + '\n';
}

/** 把一个会话写到 `sessions/<slug>/<dir>/session.v4.jsonl.zstd`，返回文件路径。 */
function writeSessionLog(home, slug, dir, body) {
  const target = join(sessionsRoot(home), slug, dir);
  mkdirSync(target, { recursive: true });
  const file = join(target, 'session.v4.jsonl.zstd');
  writeFileSync(file, zlib.zstdCompressSync(Buffer.from(body, 'utf8')));
  return file;
}

/** 写 workspace.json（形状照实测的真实文件，含 unit / global.initialized 这些字段）。 */
function writeWorkspaceStore(home, store, raw) {
  const dir = join(home, 'storages');
  mkdirSync(dir, { recursive: true });
  const file = workspaceStorePath(home);
  writeFileSync(file, raw !== undefined ? raw : JSON.stringify(store, null, 2));
  return file;
}

/** 造一个最小可用的 workspace.json 对象。 */
function storeOf(workspaces, { workspaceIds, archivedSessionIds = [], pinnedSessionIds = [] } = {}) {
  return {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      defaultWorkspaceId: Object.keys(workspaces)[0] ?? null,
      workspaceIds: workspaceIds ?? Object.keys(workspaces),
      archivedSessionIds,
      pinnedSessionIds,
    },
    tables: { workspaces },
  };
}

/** 造一个工作区条目。 */
function workspaceRow({ path, title, sessionIds }) {
  const row = { sessionIds };
  if (path !== undefined) row.path = path;
  if (title !== undefined) row.title = title;
  row.createdAt = '2026-11-13T11:24:01.242Z';
  row.updatedAt = '2026-11-13T11:24:01.294Z';
  return row;
}

/**
 * 假 scanner：按 sessionId 返回预先算好的 summarize 结果，记录调用过哪些 id。
 * 用真 summarize 生成结构，保证合并逻辑面对的是宿主真实形状而不是手搓的假对象。
 */
function fakeScanner(eventsBySession, { fail = new Set(), onCall } = {}) {
  const calls = [];
  return {
    calls,
    async scanSession(sessionId) {
      calls.push(sessionId);
      if (onCall) onCall(sessionId);
      if (fail.has(sessionId)) throw new Error(`读取会话 ${sessionId} 失败`);
      const events = eventsBySession[sessionId] ?? [];
      return { ...summarize(events), sessionId };
    },
  };
}

/** 一个临时 home 的封装：用完一定删干净。 */
function tempHome(prefix = 'dsh-ws-') {
  const home = mkdtempSync(join(tmpdir(), prefix));
  return {
    home,
    cleanup() { rmSync(home, { recursive: true, force: true }); },
  };
}

/** 收集 warn 调用。 */
function warnSink() {
  const messages = [];
  const warn = (text) => messages.push(text);
  warn.messages = messages;
  return warn;
}

const TRAE = (id, tokens, time = 1000) =>
  message({ id, provider: 'trae', model: 'deepseek-v4.1-flash', usage: { inputTokens: tokens, totalTokens: tokens }, time });

// ── 注册表解析 ────────────────────────────────────────────────────

test('resolveWorkspaces：读真实形状的注册表，按 global.workspaceIds 的顺序输出', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf(
      {
        'ws-b': workspaceRow({ path: 'F:\\repo\\b', title: 'beta', sessionIds: ['s-b1', 's-b2'] }),
        'ws-a': workspaceRow({ path: 'F:\\repo\\a', title: 'alpha', sessionIds: ['s-a1'] }),
      },
      // 故意与对象键顺序不同：界面照抄宿主侧边栏的顺序，不能按插入顺序乱排。
      { workspaceIds: ['ws-a', 'ws-b'] },
    ));

    const list = await resolveWorkspaces(home, { warn: warnSink() });
    assert.deepEqual(list.map((w) => w.id), ['ws-a', 'ws-b']);
    assert.deepEqual(list[0], {
      id: 'ws-a',
      title: 'alpha',
      path: 'F:\\repo\\a',
      sessionIds: ['s-a1'],
      archivedSessions: [],
      pinnedSessions: [],
      droppedSessionIds: [],
      createdAt: '2026-11-13T11:24:01.242Z',
      updatedAt: '2026-11-13T11:24:01.294Z',
    });
    assert.deepEqual(list[1].sessionIds, ['s-b1', 's-b2']);
  } finally {
    cleanup();
  }
});

test('resolveWorkspaces：文件缺失、JSON 损坏、没有 workspaces 表都返回空数组', async () => {
  const missing = tempHome();
  try {
    // 连 storages 目录都没有
    assert.deepEqual(await resolveWorkspaces(missing.home, { warn: warnSink() }), []);
  } finally {
    missing.cleanup();
  }

  const broken = tempHome();
  try {
    // 进程被杀留下的半份文件
    writeWorkspaceStore(broken.home, null, '{"global":{"workspaceIds":["ws-a"]');
    assert.deepEqual(await resolveWorkspaces(broken.home, { warn: warnSink() }), []);
  } finally {
    broken.cleanup();
  }

  const noTable = tempHome();
  try {
    writeWorkspaceStore(noTable.home, { unit: { name: 'workspace', version: 2 }, global: { workspaceIds: ['ws-a'] } });
    assert.deepEqual(await resolveWorkspaces(noTable.home, { warn: warnSink() }), []);
  } finally {
    noTable.cleanup();
  }
});

test('resolveWorkspaces：带 BOM 的文件仍能读（用户手改过的 JSON 在 Windows 上常带 BOM）', async () => {
  const { home, cleanup } = tempHome();
  try {
    const store = storeOf({ 'ws-a': workspaceRow({ path: 'F:\\repo\\a', title: 'alpha', sessionIds: ['s-a1'] }) });
    writeWorkspaceStore(home, null, '\uFEFF' + JSON.stringify(store));
    const list = await resolveWorkspaces(home, { warn: warnSink() });
    assert.equal(list.length, 1);
    assert.equal(list[0].title, 'alpha');
  } finally {
    cleanup();
  }
});

test('resolveWorkspaces：workspaceIds 漏登记的工作区补到末尾，不被静默吞掉', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf(
      {
        'ws-listed': workspaceRow({ path: 'F:\\repo\\x', title: 'listed', sessionIds: ['s-1'] }),
        'ws-orphan': workspaceRow({ path: 'F:\\repo\\y', title: 'orphan', sessionIds: ['s-2'] }),
        'ws-gone': null, // workspaceIds 里有、表里没有：跳过，不造空工作区
      },
      { workspaceIds: ['ws-listed', 'ws-gone'] },
    ));
    const list = await resolveWorkspaces(home, { warn: warnSink() });
    assert.deepEqual(list.map((w) => w.id), ['ws-listed', 'ws-orphan']);
  } finally {
    cleanup();
  }
});

test('resolveWorkspaces：title 缺失时退回目录名，path 缺失时退回 id', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf({
      'ws-1': workspaceRow({ path: 'F:\\work\\repo\\dsh-quota-usage', sessionIds: [] }),
      'ws-2': workspaceRow({ sessionIds: [] }),
    }));
    const list = await resolveWorkspaces(home, { warn: warnSink() });
    assert.equal(list[0].title, 'dsh-quota-usage');
    assert.equal(list[1].title, 'ws-2');
  } finally {
    cleanup();
  }
});

test('resolveWorkspaces：同一会话被两个工作区登记时只认第一个，且全局只警告一次', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf({
      'ws-a': workspaceRow({ path: 'F:\\repo\\a', title: 'alpha', sessionIds: ['s-shared', 's-a'] }),
      'ws-b': workspaceRow({ path: 'F:\\repo\\b', title: 'beta', sessionIds: ['s-shared', 's-b'] }),
    }));
    const warn = warnSink();
    const list = await resolveWorkspaces(home, { warn });

    assert.deepEqual(list[0].sessionIds, ['s-shared', 's-a']);
    assert.deepEqual(list[1].sessionIds, ['s-b'], '重复的会话只能留在第一个工作区');
    assert.deepEqual(list[1].droppedSessionIds, ['s-shared']);
    // 三个工作区抢同一个会话也只该有一条警告，不能一次冲突刷一行
    assert.equal(warn.messages.length, 1);
    assert.match(warn.messages[0], /s-shared/);
  } finally {
    cleanup();
  }
});

test('resolveWorkspaces：重复会话再多也只发一条警告（刷屏的警告等于没警告）', async () => {
  const { home, cleanup } = tempHome();
  try {
    const many = Array.from({ length: 20 }, (_, i) => `s-dup-${i}`);
    writeWorkspaceStore(home, storeOf({
      'ws-a': workspaceRow({ path: 'F:\\repo\\a', sessionIds: many }),
      'ws-b': workspaceRow({ path: 'F:\\repo\\b', sessionIds: many }),
    }));
    const warn = warnSink();
    await resolveWorkspaces(home, { warn });
    assert.equal(warn.messages.length, 1);
  } finally {
    cleanup();
  }
});

test('resolveWorkspaces：归档与置顶按 global 标记落到具体工作区上', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf(
      {
        'ws-a': workspaceRow({ path: 'F:\\repo\\a', title: 'alpha', sessionIds: ['s-1', 's-2'] }),
        'ws-b': workspaceRow({ path: 'F:\\repo\\b', title: 'beta', sessionIds: ['s-3'] }),
      },
      { archivedSessionIds: ['s-2', 's-not-in-any-workspace'], pinnedSessionIds: ['s-1'] },
    ));
    const list = await resolveWorkspaces(home, { warn: warnSink() });
    assert.deepEqual(list[0].archivedSessions, ['s-2']);
    assert.deepEqual(list[0].pinnedSessions, ['s-1']);
    // 不属于本工作区的归档 id 不能串到别的项目上
    assert.deepEqual(list[1].archivedSessions, []);
  } finally {
    cleanup();
  }
});

// ── 汇总与合并 ────────────────────────────────────────────────────

test('scanWorkspaces：按工作区汇总，kinds 结构与 usage.js 一致，totals 为四大字段之和', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf({
      'ws-a': workspaceRow({ path: 'F:\\repo\\a', title: 'alpha', sessionIds: ['s-a1', 's-a2'] }),
      'ws-b': workspaceRow({ path: 'F:\\repo\\b', title: 'beta', sessionIds: ['s-b1'] }),
    }));

    const scanner = fakeScanner({
      's-a1': [TRAE('m1', 100)],
      's-a2': [
        TRAE('m2', 200),
        message({
          id: 'm3',
          provider: 'codex-chatgpt',
          model: 'gpt-6.1-sol',
          usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 },
        }),
      ],
      's-b1': [TRAE('m4', 7)],
    });

    const result = await scanWorkspaces({ home, scanner, includeSubagents: false, warn: warnSink() });
    assert.deepEqual(result.map((w) => w.id), ['ws-a', 'ws-b'], '消耗大的工作区排前面');

    const [alpha, beta] = result;
    assert.equal(alpha.title, 'alpha');
    assert.equal(alpha.path, 'F:\\repo\\a');
    assert.equal(alpha.sessionCount, 2);
    assert.equal(alpha.messages, 3);
    assert.equal(alpha.totals.inputTokens, 350);
    assert.equal(alpha.totals.totalTokens, 355);
    assert.equal(alpha.totals.outputTokens, 5);
    assert.equal(alpha.failedSessionCount, 0);

    // kinds 直接复用 usage.js 的分层结构，可直接 JSON 序列化给浏览器
    assert.deepEqual(alpha.kinds.map((k) => k.kind), ['subscription', 'credits']);
    const credits = alpha.kinds.find((k) => k.kind === 'credits');
    assert.equal(credits.providers[0].provider, 'trae');
    assert.equal(credits.providers[0].models.length, 1);
    assert.equal(credits.providers[0].models[0].model, 'deepseek-v4.1-flash');
    assert.equal(credits.providers[0].models[0].messages, 2);
    assert.equal(credits.providers[0].models[0].totalTokens, 300);

    assert.equal(beta.totals.totalTokens, 7);
    assert.equal(beta.messages, 1);
    // 逐会话明细齐全，界面不必再算一次
    assert.deepEqual(alpha.sessions.map((s) => s.id), ['s-a1', 's-a2']);
    assert.equal(alpha.sessions[0].totals.totalTokens, 100);
  } finally {
    cleanup();
  }
});

test('scanWorkspaces：多个会话同一模型相加，时间窗取首末', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf({
      'ws-a': workspaceRow({ path: 'F:\\repo\\a', sessionIds: ['s-1', 's-2', 's-3'] }),
    }));
    const scanner = fakeScanner({
      's-1': [TRAE('m1', 10, 5000)],
      's-2': [TRAE('m2', 20, 1000)],
      's-3': [TRAE('m3', 30, 9000)],
    });
    const [ws] = await scanWorkspaces({ home, scanner, includeSubagents: false, warn: warnSink() });
    assert.equal(ws.messages, 3);
    assert.equal(ws.totals.inputTokens, 60);
    assert.equal(ws.firstAt, 1000);
    assert.equal(ws.lastAt, 9000);
    // 合并后仍是同一个模型一条，不是三条
    assert.equal(ws.kinds[0].providers[0].models.length, 1);
    assert.equal(ws.kinds[0].providers[0].models[0].messages, 3);
  } finally {
    cleanup();
  }
});

test('scanWorkspaces：没有会话的工作区保留为全 0，而不是消失', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf({
      'ws-empty': workspaceRow({ path: 'F:\\repo\\empty', title: 'empty', sessionIds: [] }),
    }));
    const result = await scanWorkspaces({ home, scanner: fakeScanner({}), warn: warnSink() });
    assert.equal(result.length, 1);
    assert.equal(result[0].sessionCount, 0);
    assert.equal(result[0].messages, 0);
    assert.deepEqual(result[0].totals, {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
    });
    assert.deepEqual(result[0].kinds, []);
    assert.equal(result[0].firstAt, null);
  } finally {
    cleanup();
  }
});

test('scanWorkspaces：没有登记任何工作区时返回空数组（不造假工作区）', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf({}, { workspaceIds: [] }));
    assert.deepEqual(await scanWorkspaces({ home, scanner: fakeScanner({}), warn: warnSink() }), []);
  } finally {
    cleanup();
  }
});

// ── 失败隔离 ──────────────────────────────────────────────────────

test('scanWorkspaces：单个会话读失败只影响它自己，其它会话照常统计', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf({
      'ws-a': workspaceRow({ path: 'F:\\repo\\a', title: 'alpha', sessionIds: ['s-ok1', 's-bad', 's-ok2'] }),
    }));
    const scanner = fakeScanner(
      { 's-ok1': [TRAE('m1', 100)], 's-ok2': [TRAE('m2', 50)], 's-bad': [TRAE('m3', 999999)] },
      { fail: new Set(['s-bad']) },
    );
    const [ws] = await scanWorkspaces({ home, scanner, includeSubagents: false, warn: warnSink() });

    assert.equal(ws.messages, 2, '两个好会话的统计必须还在');
    assert.equal(ws.totals.totalTokens, 150);
    assert.equal(ws.failedSessionCount, 1);
    // 失败的会话仍出现在列表里并标明原因：用户要知道哪个会话没算进来
    const bad = ws.sessions.find((s) => s.id === 's-bad');
    assert.equal(bad.ok, false);
    assert.match(bad.error, /读取会话 s-bad 失败/);
    assert.equal(bad.totals.totalTokens, 0);
    // sessionCount 与界面上的会话数一致（含失败的）
    assert.equal(ws.sessionCount, 3);
  } finally {
    cleanup();
  }
});

test('scanWorkspaces：一个工作区整体失败不带崩其它工作区', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf({
      'ws-a': workspaceRow({ path: 'F:\\repo\\a', title: 'alpha', sessionIds: ['s-a1'] }),
      'ws-b': workspaceRow({ path: 'F:\\repo\\b', title: 'beta', sessionIds: ['s-b1'] }),
    }));
    const scanner = fakeScanner(
      { 's-a1': [TRAE('m1', 10)], 's-b1': [TRAE('m2', 20)] },
      { fail: new Set(['s-a1']) },
    );
    const result = await scanWorkspaces({ home, scanner, includeSubagents: false, warn: warnSink() });
    assert.equal(result.length, 2);
    const beta = result.find((w) => w.id === 'ws-b');
    assert.equal(beta.messages, 1);
    assert.equal(beta.totals.totalTokens, 20);
    assert.equal(beta.failedSessionCount, 0);
  } finally {
    cleanup();
  }
});

test('scanWorkspaces：scanner 没有 scanSession 时明确抛错（不要静默出全 0 报表）', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf({ 'ws-a': workspaceRow({ path: 'F:\\repo\\a', sessionIds: [] }) }));
    await assert.rejects(
      () => scanWorkspaces({ home, scanner: {}, warn: warnSink() }),
      /scanSession/,
    );
  } finally {
    cleanup();
  }
});

test('scanWorkspaces：sessions 目录不存在时子代理归属为空，不抛错', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf({
      'ws-a': workspaceRow({ path: 'F:\\repo\\a', title: 'alpha', sessionIds: ['s-a1'] }),
    }));
    const scanner = fakeScanner({ 's-a1': [TRAE('m1', 10)] });
    const [ws] = await scanWorkspaces({ home, scanner, warn: warnSink() });
    assert.equal(ws.totals.totalTokens, 10);
    assert.deepEqual(scanner.calls, ['s-a1']);
  } finally {
    cleanup();
  }
});

// ── 归档 ─────────────────────────────────────────────────────────

test('已归档的会话默认仍然统计，但逐会话标记 archived:true', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf(
      {
        'ws-a': workspaceRow({ path: 'F:\\repo\\a', title: 'alpha', sessionIds: ['s-live', 's-archived'] }),
      },
      { archivedSessionIds: ['s-archived'] },
    ));
    const scanner = fakeScanner({ 's-live': [TRAE('m1', 100)], 's-archived': [TRAE('m2', 40)] });
    const [ws] = await scanWorkspaces({ home, scanner, includeSubagents: false, warn: warnSink() });

    // 归档 ≠ 没花过钱：数字必须算进去
    assert.equal(ws.totals.totalTokens, 140);
    assert.deepEqual(ws.archivedSessions, ['s-archived']);
    const archived = ws.sessions.find((s) => s.id === 's-archived');
    const live = ws.sessions.find((s) => s.id === 's-live');
    assert.equal(archived.archived, true);
    assert.equal(live.archived, false);
    assert.equal(archived.ok, true);
  } finally {
    cleanup();
  }
});

// ── 子代理会话（实测：日志目录是裸 uuid，且不在 workspace.json 里）────────

test('子代理会话按 parentSession 归到父会话的工作区', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf({
      'ws-a': workspaceRow({ path: 'F:\\repo\\a', title: 'alpha', sessionIds: ['session-parent'] }),
      'ws-b': workspaceRow({ path: 'F:\\repo\\b', title: 'beta', sessionIds: ['session-other'] }),
    }));
    // 实测形态：子代理目录名是裸 uuid，日志头带 parentSession + origin
    writeSessionLog(home, '--F-repo-a--', 'aaaaaaaa-1111-2222-3333-444444444444', sessionBody({
      id: 'aaaaaaaa-1111-2222-3333-444444444444',
      parentSession: 'session-parent',
      origin: 'subagent',
      cwd: 'F:\\repo\\a',
      messages: [TRAE('sub-1', 500)],
    }));
    writeSessionLog(home, '--F-repo-a--', 'session-parent', sessionBody({
      id: 'session-parent',
      cwd: 'F:\\repo\\a',
      messages: [TRAE('p-1', 100)],
    }));
    writeSessionLog(home, '--F-repo-b--', 'session-other', sessionBody({
      id: 'session-other',
      cwd: 'F:\\repo\\b',
      messages: [TRAE('o-1', 7)],
    }));

    // 用真的扫描器，走完整链路（解压多帧 zstd → summarize → 合并）
    const result = await scanWorkspaces({ home, scanner: createUsageScanner({ home }), warn: warnSink() });
    const alpha = result.find((w) => w.id === 'ws-a');
    const beta = result.find((w) => w.id === 'ws-b');

    // 子代理的 500 token 必须算进 alpha —— 它是为 alpha 的会话干活的
    assert.equal(alpha.totals.totalTokens, 600);
    assert.equal(alpha.messages, 2);
    assert.equal(alpha.sessionCount, 2);
    assert.ok(alpha.sessions.some((s) => s.id === 'aaaaaaaa-1111-2222-3333-444444444444'));
    // 不能串到 beta 上
    assert.equal(beta.totals.totalTokens, 7);
    assert.equal(beta.sessionCount, 1);
  } finally {
    cleanup();
  }
});

test('子代理父会话缺失时按 cwd 精确匹配工作区，匹配不到就丢弃', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf({
      'ws-a': workspaceRow({ path: 'F:\\repo\\a', title: 'alpha', sessionIds: [] }),
    }));
    // 父会话不存在：靠 cwd 兜底
    writeSessionLog(home, '--F-repo-a--', 'bbbbbbbb-1111-2222-3333-444444444444', sessionBody({
      id: 'bbbbbbbb-1111-2222-3333-444444444444',
      parentSession: 'session-gone',
      origin: 'subagent',
      cwd: 'F:\\repo\\a',
      messages: [TRAE('sub-1', 40)],
    }));
    // 前缀相近但不是同一个目录：不能算进 ws-a（工作区可以嵌套，前缀匹配会算错项目）
    writeSessionLog(home, '--F-repo-ab--', 'cccccccc-1111-2222-3333-444444444444', sessionBody({
      id: 'cccccccc-1111-2222-3333-444444444444',
      origin: 'subagent',
      cwd: 'F:\\repo\\ab',
      messages: [TRAE('sub-2', 9999)],
    }));

    const [ws] = await scanWorkspaces({ home, scanner: createUsageScanner({ home }), warn: warnSink() });
    assert.equal(ws.totals.totalTokens, 40);
    assert.deepEqual(ws.sessions.map((s) => s.id), ['bbbbbbbb-1111-2222-3333-444444444444']);
  } finally {
    cleanup();
  }
});

test('includeSubagents:false 时只统计注册表里的会话', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf({
      'ws-a': workspaceRow({ path: 'F:\\repo\\a', title: 'alpha', sessionIds: ['session-parent'] }),
    }));
    writeSessionLog(home, '--F-repo-a--', 'session-parent', sessionBody({
      id: 'session-parent', cwd: 'F:\\repo\\a', messages: [TRAE('p-1', 100)],
    }));
    writeSessionLog(home, '--F-repo-a--', 'dddddddd-1111-2222-3333-444444444444', sessionBody({
      id: 'dddddddd-1111-2222-3333-444444444444',
      parentSession: 'session-parent',
      origin: 'subagent',
      cwd: 'F:\\repo\\a',
      messages: [TRAE('sub-1', 500)],
    }));

    const scanner = createUsageScanner({ home });
    const withSub = await scanWorkspaces({ home, scanner, warn: warnSink() });
    assert.equal(withSub[0].totals.totalTokens, 600);
    assert.equal(withSub[0].includeSubagents, true);

    const withoutSub = await scanWorkspaces({ home, scanner, includeSubagents: false, warn: warnSink() });
    assert.equal(withoutSub[0].totals.totalTokens, 100);
    assert.equal(withoutSub[0].sessionCount, 1);
    assert.equal(withoutSub[0].includeSubagents, false);
  } finally {
    cleanup();
  }
});

test('子代理会递归归属（子代理又开了子代理）', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf({
      'ws-a': workspaceRow({ path: 'F:\\repo\\a', title: 'alpha', sessionIds: ['session-root'] }),
    }));
    writeSessionLog(home, '--F-repo-a--', 'session-root', sessionBody({
      id: 'session-root', cwd: 'F:\\repo\\a', messages: [TRAE('r', 1)],
    }));
    writeSessionLog(home, '--F-repo-a--', 'eeeeeeee-0000-0000-0000-000000000001', sessionBody({
      id: 'eeeeeeee-0000-0000-0000-000000000001',
      parentSession: 'session-root', origin: 'subagent', messages: [TRAE('c1', 10)],
    }));
    writeSessionLog(home, '--F-repo-a--', 'eeeeeeee-0000-0000-0000-000000000002', sessionBody({
      id: 'eeeeeeee-0000-0000-0000-000000000002',
      parentSession: 'eeeeeeee-0000-0000-0000-000000000001', origin: 'subagent', messages: [TRAE('c2', 100)],
    }));

    const [ws] = await scanWorkspaces({ home, scanner: createUsageScanner({ home }), warn: warnSink() });
    assert.equal(ws.sessionCount, 3);
    assert.equal(ws.totals.totalTokens, 111);
  } finally {
    cleanup();
  }
});

// ── 日志头解析 ────────────────────────────────────────────────────

test('readSessionHeader：只解第一个帧就能拿到 parentSession / origin / cwd', async () => {
  const { home, cleanup } = tempHome();
  try {
    // 头之后跟一大段正文，模拟真实日志（头在第一帧，其余帧不该被解）
    const head = sessionBody({
      id: 'ffffffff-0000-0000-0000-000000000001',
      parentSession: 'session-parent',
      origin: 'subagent',
      cwd: 'F:\\repo\\a',
      messages: [],
    }).trimEnd();
    const body = Array.from({ length: 200 }, (_, i) => JSON.stringify(TRAE(`x${i}`, 1))).join('\n');
    const frames = [head + '\n', body + '\n'].map((t) => zlib.zstdCompressSync(Buffer.from(t, 'utf8')));
    const dir = join(home, 'sessions', '--slug--', 'ffffffff-0000-0000-0000-000000000001');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'session.v4.jsonl.zstd');
    writeFileSync(file, Buffer.concat(frames));

    const header = await readSessionHeader(file);
    assert.equal(header.parentSession, 'session-parent');
    assert.equal(header.origin, 'subagent');
    assert.equal(header.cwd, 'F:\\repo\\a');
  } finally {
    cleanup();
  }
});

test('readSessionHeader：文件不存在或不是 zstd 时返回 null，不抛错', async () => {
  const { home, cleanup } = tempHome();
  try {
    assert.equal(await readSessionHeader(join(home, 'nope.jsonl.zstd')), null);
    const dir = join(home, 'sessions', '--slug--', 'broken');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'session.v4.jsonl.zstd');
    writeFileSync(file, Buffer.from('not zstd at all'));
    assert.equal(await readSessionHeader(file), null);
  } finally {
    cleanup();
  }
});

// ── 反查 ─────────────────────────────────────────────────────────

test('workspaceOfSession：反查会话归属，含子代理会话与归档标记', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf(
      {
        'ws-a': workspaceRow({ path: 'F:\\repo\\a', title: 'alpha', sessionIds: ['session-parent', 's-archived'] }),
        'ws-b': workspaceRow({ path: 'F:\\repo\\b', title: 'beta', sessionIds: ['s-b'] }),
      },
      { archivedSessionIds: ['s-archived'] },
    ));
    writeSessionLog(home, '--F-repo-a--', 'session-parent', sessionBody({
      id: 'session-parent', cwd: 'F:\\repo\\a', messages: [TRAE('p', 1)],
    }));
    writeSessionLog(home, '--F-repo-a--', 'eeeeeeee-1111-2222-3333-444444444444', sessionBody({
      id: 'eeeeeeee-1111-2222-3333-444444444444',
      parentSession: 'session-parent', origin: 'subagent', cwd: 'F:\\repo\\a', messages: [TRAE('s', 1)],
    }));

    const result = await scanWorkspaces({ home, scanner: createUsageScanner({ home }), warn: warnSink() });

    assert.deepEqual(workspaceOfSession(result, 'session-parent'), {
      id: 'ws-a', title: 'alpha', path: 'F:\\repo\\a', archived: false,
    });
    assert.equal(workspaceOfSession(result, 'eeeeeeee-1111-2222-3333-444444444444')?.id, 'ws-a');
    assert.equal(workspaceOfSession(result, 's-archived')?.archived, true);
    assert.equal(workspaceOfSession(result, 's-b')?.id, 'ws-b');
    // 找不到就是 null，不猜
    assert.equal(workspaceOfSession(result, 'session-unknown'), null);
    assert.equal(workspaceOfSession(result, ''), null);
    assert.equal(workspaceOfSession(null, 'x'), null);
  } finally {
    cleanup();
  }
});

test('workspaceOfSession：也接受 resolveWorkspaces 的输出（未扫描时同样可用）', async () => {
  const list = [
    { id: 'ws-a', title: 'alpha', path: 'F:\\repo\\a', sessionIds: ['s-1'], archivedSessions: [], pinnedSessions: [] },
  ];
  assert.deepEqual(workspaceOfSession(list, 's-1'), { id: 'ws-a', title: 'alpha', path: 'F:\\repo\\a', archived: false });
  assert.equal(workspaceOfSession(list, 's-2'), null);
  // 也接受包了一层的形状
  assert.equal(workspaceOfSession({ workspaces: list }, 's-1')?.id, 'ws-a');
});

// ── 与真实扫描器的端到端 ─────────────────────────────────────────

test('端到端：真实 zstd 会话日志 → 工作区统计（含多帧与重复会话）', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf({
      'ws-a': workspaceRow({ path: 'F:\\repo\\a', title: 'alpha', sessionIds: ['session-1', 'session-2'] }),
      'ws-b': workspaceRow({ path: 'F:\\repo\\b', title: 'beta', sessionIds: ['session-2'] }),
    }));

    // 多帧：DSH 边写边压，一个文件里几百个首尾相接的 zstd 帧
    const dir1 = join(sessionsRoot(home), '--F-repo-a--', 'session-1');
    mkdirSync(dir1, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'session', version: 4, id: 'session-1', cwd: 'F:\\repo\\a' }),
      JSON.stringify(TRAE('a1', 10)),
      JSON.stringify(TRAE('a2', 20)),
    ];
    writeFileSync(
      join(dir1, 'session.v4.jsonl.zstd'),
      Buffer.concat(lines.map((l) => zlib.zstdCompressSync(Buffer.from(l + '\n', 'utf8')))),
    );
    writeSessionLog(home, '--F-repo-a--', 'session-2', sessionBody({
      id: 'session-2', cwd: 'F:\\repo\\a', messages: [TRAE('a3', 30)],
    }));

    const result = await scanWorkspaces({ home, scanner: createUsageScanner({ home }), warn: warnSink() });
    const alpha = result.find((w) => w.id === 'ws-a');
    const beta = result.find((w) => w.id === 'ws-b');

    assert.equal(alpha.messages, 3);
    assert.equal(alpha.totals.totalTokens, 60);
    // session-2 被两个工作区登记：只算进第一个（ws-a），beta 不该重复计
    assert.equal(beta.sessionCount, 0);
    assert.equal(beta.totals.totalTokens, 0);
  } finally {
    cleanup();
  }
});

// ── 内容相同的会话副本（实测坑）────────────────────────────────────
//
// 实测本机 litiaotiao 工作区里的 `session-40f34ee1` 与 `session-4bd9039b` 是同一段对话的
// 两份日志：消息数都是 832、token 都是 243,292,817、时间窗一致。两份都算，该工作区消耗
// 直接翻倍（全机合计 688M，而 usage.js 自己的全机扫描只有 422M）。下面这组用例锁住这个行为。

test('内容完全相同的两份会话日志只计一次，副本仍列出并标记 duplicateOf', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf({
      'ws-a': workspaceRow({ path: 'F:\\repo\\a', title: 'alpha', sessionIds: ['session-real', 'session-copy'] }),
    }));
    const same = [TRAE('m1', 100, 1000), TRAE('m2', 200, 2000)];
    const scanner = fakeScanner({
      'session-real': same,
      // 副本：消息 id 都不同（最新写入的副本会重编 id），但消息数与 token 完全一致
      'session-copy': [TRAE('c1', 100, 1000), TRAE('c2', 200, 2000)],
    });
    const warn = warnSink();
    const [ws] = await scanWorkspaces({ home, scanner, includeSubagents: false, warn });

    assert.equal(ws.totals.totalTokens, 300, '副本不能被重复计入');
    assert.equal(ws.messages, 2);
    assert.equal(ws.duplicateSessionCount, 1);
    // 两个会话都还在列表里：副本也是一份真实日志，用户要能看见它存在
    assert.equal(ws.sessionCount, 2);
    const copy = ws.sessions.find((s) => s.id === 'session-copy');
    assert.equal(copy.duplicateOf, 'session-real');
    assert.equal(copy.ok, true);
    // 单条警告说明发生了什么，而不是让用户自己怀疑数字
    assert.equal(warn.messages.length, 1);
    assert.match(warn.messages[0], /session-copy/);
  } finally {
    cleanup();
  }
});

test('副本跨工作区时也只计一次（副本与真身被登记在不同工作区）', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf({
      'ws-a': workspaceRow({ path: 'F:\\repo\\a', title: 'alpha', sessionIds: ['session-real'] }),
      'ws-b': workspaceRow({ path: 'F:\\repo\\b', title: 'beta', sessionIds: ['session-copy'] }),
    }));
    const scanner = fakeScanner({
      'session-real': [TRAE('m1', 100, 1000)],
      'session-copy': [TRAE('c1', 100, 1000)],
    });
    const result = await scanWorkspaces({ home, scanner, includeSubagents: false, warn: warnSink() });
    const total = result.reduce((acc, w) => acc + w.totals.totalTokens, 0);
    assert.equal(total, 100, '同一段对话在全局只该算一次');
    const beta = result.find((w) => w.id === 'ws-b');
    assert.equal(beta.totals.totalTokens, 0);
    assert.equal(beta.duplicateSessionCount, 1);
  } finally {
    cleanup();
  }
});

test('不同内容的会话不会被误判成副本', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf({
      'ws-a': workspaceRow({ path: 'F:\\repo\\a', title: 'alpha', sessionIds: ['s1', 's2', 's3'] }),
    }));
    const scanner = fakeScanner({
      // token 相同但时刻不同 —— 两段不同的对话
      's1': [TRAE('a', 100, 1000)],
      's2': [TRAE('b', 100, 5000)],
      // 时刻相同但 token 不同
      's3': [TRAE('c', 777, 1000)],
    });
    const [ws] = await scanWorkspaces({ home, scanner, includeSubagents: false, warn: warnSink() });
    assert.equal(ws.duplicateSessionCount, 0);
    assert.equal(ws.totals.totalTokens, 977);
  } finally {
    cleanup();
  }
});

test('多个空会话不会被当成互为副本（新建但没聊过是正常状态）', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf({
      'ws-a': workspaceRow({ path: 'F:\\repo\\a', title: 'alpha', sessionIds: ['e1', 'e2', 'e3'] }),
    }));
    const scanner = fakeScanner({ 'e1': [], 'e2': [], 'e3': [] });
    const [ws] = await scanWorkspaces({ home, scanner, includeSubagents: false, warn: warnSink() });
    assert.equal(ws.sessionCount, 3);
    assert.equal(ws.duplicateSessionCount, 0, '空会话之间不算副本');
    assert.equal(ws.messages, 0);
  } finally {
    cleanup();
  }
});

test('端到端：真实 zstd 副本文件只计一次', async () => {
  const { home, cleanup } = tempHome();
  try {
    writeWorkspaceStore(home, storeOf({
      'ws-a': workspaceRow({ path: 'F:\\repo\\a', title: 'alpha', sessionIds: ['session-real', 'session-copy'] }),
    }));
    const body = [TRAE('m1', 100, 1000), TRAE('m2', 200, 2000)];
    writeSessionLog(home, '--F-repo-a--', 'session-real', sessionBody({ id: 'session-real', messages: body }));
    // 副本用不同的消息 id（真实副本的实际情况），内容量完全一致
    writeSessionLog(home, '--F-repo-a--', 'session-copy', sessionBody({
      id: 'session-copy', messages: [TRAE('c1', 100, 1000), TRAE('c2', 200, 2000)],
    }));

    const [ws] = await scanWorkspaces({ home, scanner: createUsageScanner({ home }), warn: warnSink() });
    assert.equal(ws.totals.totalTokens, 300);
    assert.equal(ws.sessionCount, 2);
    assert.equal(ws.duplicateSessionCount, 1);
  } finally {
    cleanup();
  }
});
