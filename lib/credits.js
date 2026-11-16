/**
 * dsh-quota-usage — 免费模型提供商的积分查询（dsh-free-model 的补充）。
 *
 * 这一块回答的问题是「那些免费渠道还剩多少积分、哪些账号还能用」，而不是
 * 「这个月花了多少 token」（后者是 lib/usage.js 的统计）。
 *
 * 数据边界（重要）：
 *   dsh-free-model 把逐账号实时积分通过 `credits.balances` RPC 提供给**它自己的
 *   浏览器页面**——那条 RPC 注册在 `connection.rpc.call('/api', 'channel-pack', …)`
 *   上，要求浏览器会话的 admission；宿主侧直接 POST `/api/channel-pack` 会 401。
 *   本插件不去绕那道门，只读它已经落盘的三份状态：
 *
 *     $DSH_HOME/channel-pack/state.json        账号池（provider / 账号 / 凭据引用 / 过期）
 *     $DSH_HOME/channel-pack/auto-checkin.json 最近一次自动签到：哪个渠道领到多少
 *     $DSH_HOME/channel-pack/token-ledger.json 按天 × 渠道 × 账号 × 模型的 token 消耗
 *
 *   于是本插件给的是**账号面 + 消耗面**：每个渠道有几个可用账号、签到收益如何、
 *   今天烧了多少 token。逐账号的实时积分余额仍以 dsh-free-model 的渠道页为准。
 *
 * 口径约束（与 accounts.js 一致）：
 *   · 读不到就是读不到，绝不当 0。`credited: null` 表示"这次查不到"，与
 *     `credited: 0`（确实领了 0）严格区分——把失败显示成 0 会让用户以为积分没了。
 *   · 不猜渠道：只报 state.json 里真实存在的 provider，不做"应该有哪几家"的推断。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { resolveDshHome } from './usage.js';

/** channel-pack 状态目录（dsh-free-model 的落盘位置）。 */
export function channelPackDir(home = resolveDshHome()) {
  return path.join(home, 'channel-pack');
}

/** 读一份 JSON；不存在或解析失败返回 null（调用方据此区分"没有"与"坏了"）。 */
async function readJson(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 有限非负数或 0（计数口径：缺失即 0）。 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 把 `token-ledger.json` 的按天账本折成「渠道 → 累计消耗」。
 *
 * 账本键的形态是 `direct|provider|accountId|model`（渠道直连）或别的传输前缀；
 * 我们只取 provider 那一格——渠道名不因账号或模型而变，按它归并才是用户要的口径。
 *
 * @param {unknown} ledger `token-ledger.json` 的内容
 * @param {string} [day] 只统计这一天（YYYY-MM-DD）；缺省统计全部
 * @returns {Map<string, {requests, inputTokens, outputTokens, cacheReadTokens, reasoningTokens, errors, days:Set<string>}>}
 */
export function foldTokenLedger(ledger, day) {
  const byProvider = new Map();
  const days = ledger !== null && typeof ledger === 'object' && ledger.days !== null && typeof ledger.days === 'object'
    ? ledger.days
    : {};
  for (const [dayKey, rows] of Object.entries(days)) {
    if (typeof day === 'string' && day !== '' && dayKey !== day) continue;
    if (rows === null || typeof rows !== 'object') continue;
    for (const [key, row] of Object.entries(rows)) {
      if (row === null || typeof row !== 'object') continue;
      const parts = key.split('|');
      // direct|provider|account|model —— provider 在第 2 格（index 1）。
      const provider = (parts[1] ?? '').trim().toLowerCase();
      if (provider === '') continue;
      if (!byProvider.has(provider)) {
        byProvider.set(provider, {
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          errors: 0,
          days: new Set(),
        });
      }
      const acc = byProvider.get(provider);
      acc.requests += num(row.requests);
      acc.inputTokens += num(row.inputTokens);
      acc.outputTokens += num(row.outputTokens);
      acc.cacheReadTokens += num(row.cacheReadTokens);
      acc.cacheWriteTokens += num(row.cacheWriteTokens);
      acc.reasoningTokens += num(row.reasoningTokens);
      acc.errors += num(row.errors);
      acc.days.add(dayKey);
    }
  }
  return byProvider;
}

/** 上海时区的今天（YYYY-MM-DD）——签到与账本都按这个时区切天。 */
export function todayInShanghai(now = Date.now()) {
  const d = new Date(now + 8 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * 合成积分型读数。
 *
 * 返回结构：
 *   {
 *     available: boolean,        // 是否读到 dsh-free-model 的落盘状态
 *     dir: string,               // 读的是哪个目录（排查用，不含任何机密）
 *     day: string,               // 统计用的"今天"
 *     channels: [{
 *       provider,                // trae / buddy / qodercn …
 *       accounts: number,        // 账号池里的账号数
 *       enabled: number,         // 其中启用的
 *       expiring: number,        // 已过期的（expiresAt < now）
 *       checkin: string | null,  // 最近一次自动签到该渠道的结果文案（上游原文）
 *       checkinAt: number | null,
 *       usage: { requests, inputTokens, outputTokens, cacheReadTokens, reasoningTokens, errors } | null,
 *     }],
 *     totals: { channels, accounts, enabled, requests, totalTokens },
 *   }
 *
 * 注意 `available: false` 时要让界面说"未检测到免费渠道"，而不是显示 0 个账号。
 */
export async function readFreeModelCredits({ home, now = Date.now(), day } = {}) {
  const dir = channelPackDir(home ?? resolveDshHome());
  const state = await readJson(path.join(dir, 'state.json'));
  const checkin = await readJson(path.join(dir, 'auto-checkin.json'));
  const ledger = await readJson(path.join(dir, 'token-ledger.json'));

  // 三份都读不到 = dsh-free-model 没装或没跑过：这是"未检测到"，不是"0 积分"。
  if (state === null && checkin === null && ledger === null) {
    return {
      available: false,
      dir,
      day: day ?? todayInShanghai(now),
      channels: [],
      totals: { channels: 0, accounts: 0, enabled: 0, requests: 0, totalTokens: 0 },
    };
  }

  const accounts = state !== null && Array.isArray(state.accounts) ? state.accounts : [];
  const byProvider = new Map();
  for (const account of accounts) {
    if (account === null || typeof account !== 'object') continue;
    const provider = typeof account.provider === 'string' ? account.provider.trim().toLowerCase() : '';
    if (provider === '') continue;
    if (!byProvider.has(provider)) {
      byProvider.set(provider, { provider, accounts: 0, enabled: 0, expiring: 0 });
    }
    const row = byProvider.get(provider);
    row.accounts += 1;
    if (account.enabled === true) row.enabled += 1;
    const expires = num(account.expiresAt);
    if (expires > 0 && expires < now) row.expiring += 1;
  }

  // 签到结果：渠道列表 + 每个渠道的一句话结果（上游原文，可能含中文）。
  const checkinAt = checkin !== null && typeof checkin === 'object' ? num(checkin.lastAt) || null : null;
  const checkinByChannel = new Map();
  if (checkin !== null && Array.isArray(checkin.channels)) {
    for (const item of checkin.channels) {
      if (item === null || typeof item !== 'object') continue;
      const provider = typeof item.provider === 'string' ? item.provider.trim().toLowerCase() : '';
      if (provider === '') continue;
      checkinByChannel.set(provider, typeof item.text === 'string' ? item.text : null);
      // 只出现在签到里、账号池里没有的渠道也要列出来（账号可能已被移除）。
      if (!byProvider.has(provider)) {
        byProvider.set(provider, { provider, accounts: 0, enabled: 0, expiring: 0 });
      }
    }
  }

  const useDay = day ?? todayInShanghai(now);
  const usageByProvider = foldTokenLedger(ledger, useDay);

  const channels = [];
  const totals = { channels: 0, accounts: 0, enabled: 0, requests: 0, totalTokens: 0 };
  for (const [provider, row] of [...byProvider].sort((a, b) => a[0].localeCompare(b[0]))) {
    const usage = usageByProvider.get(provider) ?? null;
    const totalTokens = usage === null
      ? 0
      : usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    channels.push({
      provider,
      accounts: row.accounts,
      enabled: row.enabled,
      expiring: row.expiring,
      checkin: checkinByChannel.get(provider) ?? null,
      checkinAt,
      usage: usage === null
        ? null
        : {
          requests: usage.requests,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          reasoningTokens: usage.reasoningTokens,
          errors: usage.errors,
        },
      totalTokens,
    });
    totals.channels += 1;
    totals.accounts += row.accounts;
    totals.enabled += row.enabled;
    totals.requests += usage === null ? 0 : usage.requests;
    totals.totalTokens += totalTokens;
  }

  return { available: true, dir, day: useDay, channels, totals };
}
