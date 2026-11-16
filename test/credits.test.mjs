// 免费渠道积分：读 dsh-free-model 落盘的三份状态，合成「账号面 + 消耗面」。
//
// 这一组钉住三件事：
//   1. 未检测到 ≠ 0 个账号（available:false 必须与空渠道分开）；
//   2. 账本按 provider 归并、按天筛选，token 口径与 usage.js 一致；
//   3. 过期账号单独计数，不混进「可用」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  channelPackDir,
  foldTokenLedger,
  readFreeModelCredits,
  todayInShanghai,
} from '../lib/credits.js';

/** 在临时 DSH_HOME 下铺一份 channel-pack 状态。 */
function makeHome({ state, checkin, ledger } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-credits-'));
  const dir = channelPackDir(home);
  mkdirSync(dir, { recursive: true });
  if (state !== undefined) writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  if (checkin !== undefined) writeFileSync(join(dir, 'auto-checkin.json'), JSON.stringify(checkin));
  if (ledger !== undefined) writeFileSync(join(dir, 'token-ledger.json'), JSON.stringify(ledger));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** 造一份 token-ledger。 */
function ledgerOf(days) {
  return { schema: 'dsh-codearts-auth/token-ledger/v1', days };
}

test('未检测到：三份状态都缺失时 available=false，而不是 0 个账号', async () => {
  const { home, cleanup } = makeHome();
  try {
    const result = await readFreeModelCredits({ home });
    assert.equal(result.available, false);
    assert.deepEqual(result.channels, []);
    assert.equal(result.totals.channels, 0);
    assert.equal(result.totals.accounts, 0);
  } finally {
    cleanup();
  }
});

test('账号池：按 provider 归并，区分总数 / 启用 / 过期', async () => {
  const now = 1_800_000_000_000;
  const { home, cleanup } = makeHome({
    state: {
      accounts: [
        { id: 'trae-1', provider: 'trae', enabled: true, expiresAt: now + 10_000 },
        { id: 'trae-2', provider: 'trae', enabled: true, expiresAt: now - 10_000 },
        { id: 'trae-3', provider: 'trae', enabled: false },
        { id: 'buddy-1', provider: 'buddy', enabled: true },
      ],
    },
  });
  try {
    const result = await readFreeModelCredits({ home, now });
    assert.equal(result.available, true);
    const trae = result.channels.find((c) => c.provider === 'trae');
    assert.equal(trae.accounts, 3);
    assert.equal(trae.enabled, 2);
    assert.equal(trae.expiring, 1, '只有一个账号的 expiresAt 已过');
    const buddy = result.channels.find((c) => c.provider === 'buddy');
    assert.equal(buddy.accounts, 1);
    assert.equal(buddy.expiring, 0, '没有 expiresAt 的账号不算过期');
    assert.equal(result.totals.accounts, 4);
  } finally {
    cleanup();
  }
});

test('签到：结果文案按渠道挂上，只出现在签到里的渠道也会列出', async () => {
  const { home, cleanup } = makeHome({
    state: { accounts: [{ id: 'trae-1', provider: 'trae', enabled: true }] },
    checkin: {
      lastAt: 1_700_000_000_000,
      channels: [
        { provider: 'trae', text: '2 个 +200积分' },
        { provider: 'lobsterai', text: '1 个失败' },
      ],
    },
  });
  try {
    const result = await readFreeModelCredits({ home });
    const trae = result.channels.find((c) => c.provider === 'trae');
    assert.equal(trae.checkin, '2 个 +200积分');
    assert.equal(trae.checkinAt, 1_700_000_000_000);
    // 账号池里没有、只在签到里出现的渠道：列出来，账号数为 0
    const lobsterai = result.channels.find((c) => c.provider === 'lobsterai');
    assert.ok(lobsterai, '签到里出现过的渠道必须列出');
    assert.equal(lobsterai.accounts, 0);
    assert.equal(lobsterai.checkin, '1 个失败');
  } finally {
    cleanup();
  }
});

test('账本：按 provider 归并，不因账号或模型数量而拆开', () => {
  const folded = foldTokenLedger(ledgerOf({
    '2026-11-14': {
      'direct|trae|trae-a|deepseek-v4.1-flash': { requests: 10, inputTokens: 100, outputTokens: 10, cacheReadTokens: 500 },
      'direct|trae|trae-b|deepseek-v4.1-flash': { requests: 5, inputTokens: 50, outputTokens: 5 },
      'direct|trae|trae-a|glm-5': { requests: 2, inputTokens: 20, outputTokens: 2, reasoningTokens: 7, errors: 1 },
      'direct|buddy|buddy-a|deepseek-v4.1-flash': { requests: 1, inputTokens: 1, outputTokens: 1 },
    },
  }));
  const trae = folded.get('trae');
  assert.equal(trae.requests, 17);
  assert.equal(trae.inputTokens, 170);
  assert.equal(trae.outputTokens, 17);
  assert.equal(trae.cacheReadTokens, 500);
  assert.equal(trae.reasoningTokens, 7);
  assert.equal(trae.errors, 1);
  assert.equal(folded.get('buddy').requests, 1);
});

test('账本：指定日期只统计那一天', () => {
  const ledger = ledgerOf({
    '2026-11-13': { 'direct|buddy|b|m': { requests: 100, inputTokens: 1000 } },
    '2026-11-14': { 'direct|buddy|b|m': { requests: 7, inputTokens: 70 } },
  });
  assert.equal(foldTokenLedger(ledger, '2026-11-14').get('buddy').requests, 7);
  assert.equal(foldTokenLedger(ledger).get('buddy').requests, 107);
  // 那一天没有数据：provider 不出现在结果里（而不是出现一个 0）
  assert.equal(foldTokenLedger(ledger, '2026-11-15').size, 0);
});

test('账本：格式异常的行被跳过，不影响其余统计', () => {
  const folded = foldTokenLedger({
    days: {
      '2026-11-14': {
        'direct|trae|a|m': { requests: 3, inputTokens: 30 },
        'no-separators': { requests: 99 },
        '|': { requests: 99 },
        'direct||a|m': { requests: 99 },
        'direct|buddy|a|m': null,
      },
    },
  });
  assert.equal(folded.size, 1);
  assert.equal(folded.get('trae').requests, 3);
});

test('合成：今日消耗按 provider 对齐到渠道，未消耗的渠道 usage 为 null', async () => {
  const day = '2026-11-14';
  const { home, cleanup } = makeHome({
    state: { accounts: [{ id: 'trae-1', provider: 'trae', enabled: true }, { id: 'zcode-1', provider: 'zcode', enabled: true }] },
    ledger: ledgerOf({
      [day]: { 'direct|trae|trae-1|m': { requests: 4, inputTokens: 40, outputTokens: 4, cacheReadTokens: 400 } },
    }),
  });
  try {
    const result = await readFreeModelCredits({ home, day });
    const trae = result.channels.find((c) => c.provider === 'trae');
    assert.equal(trae.usage.requests, 4);
    assert.equal(trae.totalTokens, 40 + 4 + 400);
    const zcode = result.channels.find((c) => c.provider === 'zcode');
    assert.equal(zcode.usage, null, '今天没消耗的渠道 usage 必须是 null，不是一串 0');
    assert.equal(zcode.totalTokens, 0);
    assert.equal(result.totals.requests, 4);
  } finally {
    cleanup();
  }
});

test('损坏的 JSON 不会让整块失败（当成没读到）', async () => {
  const { home, cleanup } = makeHome({
    state: { accounts: [{ id: 'trae-1', provider: 'trae', enabled: true }] },
  });
  try {
    // 把 auto-checkin 写成非法 JSON
    writeFileSync(join(channelPackDir(home), 'auto-checkin.json'), '{ not json');
    const result = await readFreeModelCredits({ home });
    assert.equal(result.available, true);
    const trae = result.channels.find((c) => c.provider === 'trae');
    assert.equal(trae.checkin, null);
    assert.equal(trae.accounts, 1);
  } finally {
    cleanup();
  }
});

test('今天按上海时区切天', () => {
  // 2026-11-14T16:30Z = 北京时间 2026-11-15 00:30，已经跨天
  assert.equal(todayInShanghai(Date.UTC(2026, 10, 14, 16, 30)), '2026-11-15');
  // 2026-11-14T15:30Z = 北京时间 2026-11-14 23:30，还没跨
  assert.equal(todayInShanghai(Date.UTC(2026, 10, 14, 15, 30)), '2026-11-14');
});
