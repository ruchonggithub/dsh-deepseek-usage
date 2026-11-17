// 反向验证：故意把代码改坏，看验收判据会不会失败。
//
// 一条判据只有在"注错后必然失败"时才可信。全部绿而注错也全绿，说明它测的是
// 别的东西。这个脚本在**临时副本**上做破坏，绝不碰工作区的真实文件。
//
// 用法：node scripts/meta-mutate.mjs

import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

/** 注入的错误：{ id, desc, target, mutate(text) → text, expectFail: '判据id' } */
const MUTATIONS = [
  {
    id: 'M1',
    desc: '把积分单位改回英文（模拟 A3 未修）',
    target: 'lib/client.js',
    expectFail: 'A3',
    mutate: (text) => {
      // 把返回中文单位的映射改回硬编码英文
      if (!/creditUnitText/.test(text)) return null;
      return text.replace(
        /function creditUnitText\([^)]*\)\s*\{[\s\S]{0,600}?\n\t\t\}/,
        'function creditUnitText(unit, lang) {\n\t\t\tif (unit === "") return "";\n\t\t\treturn String(unit);\n\t\t}',
      );
    },
  },
  {
    id: 'M2',
    desc: '把卡片主数字字号放大（模拟 A2 回归：文字太大溢出）',
    target: 'lib/client.js',
    expectFail: 'A2',
    mutate: (text) => {
      // 实现改过几轮，字号值不再固定为 14/15。这里把所有 10~13px 的数字字号
      // 统一抬到 24px，模拟"字号失控"。用宽松匹配，避免实现微调后注错点失效
      // （M2 曾经因为字号从 14 改成 11.5 而注不进去，白白漏掉一条）。
      let touched = false;
      const next = text.replace(/fontSize:\s*(1[0-3](?:\.\d+)?|9(?:\.\d+)?)\s*([,}])/g, (m, size, tail) => {
        touched = true;
        return `fontSize: 24${tail}`;
      });
      return touched ? next : null;
    },
  },
  {
    id: 'M3',
    desc: '把积分型聚合结果的 currency 从 credit 改成 CNY（模拟 B3b 回归：把积分说成真钱）',
    target: 'lib/cost.js',
    expectFail: 'B3b',
    mutate: (text) => {
      // B3b 测的是 costOfSummary（聚合层），不是 costOfModel（模型层）。
      // 聚合层的币种来自 aggregateCost：`currency: priced ? 'unknown' : 'credit'`
      // 改成恒为 'CNY'，等于把"不按积分钱算"的渠道伪装成人民币计价。
      const next = text.replace(
        /currency:\s*priced\s*\?\s*'unknown'\s*:\s*'credit'/,
        "currency: 'CNY'",
      );
      return next === text ? null : next;
    },
  },
  {
    id: 'M4',
    desc: '让无明细时兜底算出 100%（模拟 C2 回归：编造百分比）',
    target: 'lib/channel-credits.js',
    expectFail: 'C2',
    mutate: (text) => {
      // `percent: total > 0 ? round1(...) : undefined` → 兜底成 100
      const next = text.replace(
        /percent:\s*total\s*>\s*0\s*\?\s*round1\(\(remaining \/ total\) \* 100\)\s*:\s*undefined/,
        "percent: total > 0 ? round1((remaining / total) * 100) : 100",
      );
      return next === text ? null : next;
    },
  },
  {
    id: 'M5',
    desc: '让 getSnapshot 触发采集（模拟 E1 回归）',
    target: 'lib/collector.js',
    expectFail: 'E1',
    mutate: (text) => {
      return text.replace(/(getSnapshot\(kind\)\s*\{)/, '$1 void collect(kind);');
    },
  },
  {
    id: 'M6',
    desc: '把订阅环内数字改成"已用"（模拟 G4 口径回归：弧画剩余、环内写已用）',
    target: 'lib/client.js',
    expectFail: 'G4',
    mutate: (text) => {
      // 环内数字由 `const left = 100 - used;` 算出（client.js 的 subscriptionRing）。
      // 把它改成 `const left = used;`，环内就显示已用值 —— 与弧长口径相反。
      //
      // 踩过两次坑，记下来：
      //   1. 宽泛的 `100 - *.percent` 会先命中无关变量（`const left = 100 - used` 之外
      //      还有别的 100-x 表达式），改了无关代码，注错等于没做；
      //   2. 环内数字的直接渲染行是 `fmtPct(left)`，但改它只会换显示、不改弧长，
      //      改 `left` 的定义才能同时反转弧长与数字——那才是"口径回归"的真实形态。
      let touched = false;
      const next = text.replace(
        /const left = 100 - used;/,
        () => { touched = true; return 'const left = used;'; },
      );
      return touched ? next : null;
    },
  },
  {
    id: 'M7',
    desc: '把卡片标题加回界面（模拟 G1 回归）',
    target: 'lib/client.js',
    expectFail: 'G1',
    mutate: (text) => {
      // 锚点换过：原来的 `h(IconWallet, null)` 随「收缩/展开两形态」重构一起删了
      // （头部不再画图标）。现在的等效锚点是卡片容器本身——把标题塞进它的第一个
      // 子节点位置，效果与"标题回到界面"一致。
      const marker = 'h("div", {\n\t\t\t\t\t\tstyle: { display: "flex", flexDirection: "column", gap: 6, padding: open ?';
      if (!text.includes(marker)) {
        // 退一步：用 IconWallet 的定义处做锚点不成立（那里只是图标组件），
        // 因此找图标组件被引用的任何位置。
        const alt = 'h(IconWallet';
        if (!text.includes(alt)) return null;
        return text.replace(alt, 'h("span", null, t("credit.card.title")), h(IconWallet');
      }
      return text.replace(marker, `h("span", null, t("credit.card.title")),\n\t\t\t\t\t${marker}`);
    },
  },
  {
    id: 'M8',
    desc: '把"无已消耗数据"解释文字加回充值区（模拟 G5b 文字回归）',
    target: 'lib/client.js',
    expectFail: 'G5b',
    mutate: (text) => {
      // 无 used 时那里应是 `: null;`（留空，只显示金额）。
      // 换成一段可见文案，就复现了"缺数据时多写解释"的回归。
      //
      // 注意：注入点被实现改过两次——第一次是 `noUsed` 的 span，第二次改成 `: null`。
      // 这里锚在注释里那句"中间格直接留空"上，比锚具体代码更稳：
      // 只要那段注释还在，说明这个分支的语义没变，注入就有效。
      const anchor = '中间格直接留空';
      const at = text.indexOf(anchor);
      if (at < 0) return null;
      const tail = text.slice(at);
      const m = tail.match(/: null;/);
      if (m === null) return null;
      const abs = at + m.index;
      return text.slice(0, abs) + ': h("span", null, "无已消耗数据");' + text.slice(abs + 7);
    },
  },
  {
    id: 'M9',
    desc: '把订阅的多账号合并成一个（模拟 G4b 回归：用户要求按账号分列）',
    target: 'lib/client.js',
    expectFail: 'G4b',
    mutate: (text) => {
      // 订阅分区里渲染每个账号的那一行是 `group.accounts.map((account, ai) => ...)`。
      // 改成只取第一个，就等价于"多账号合并成一条"（用户明确要求不要合并）。
      let touched = false;
      const next = text.replace(/group\.accounts\.map\(/g, () => {
        touched = true;
        return 'group.accounts.slice(0, 1).map(';
      });
      return touched ? next : null;
    },
  },
  {
    id: 'M10',
    desc: '把订阅的条形改回圆形（模拟 G4 形态回归：用户要求用条形）',
    target: 'lib/client.js',
    expectFail: 'G4',
    mutate: (text) => {
      // subscriptionBar 里那条 4px 轨道的样式是 `height: 4, borderRadius: 2,`。
      // 改成圆形尺寸 + 50% 圆角，就复现了"圆圈太占位置"的老形态。
      let touched = false;
      const next = text.replace(
        /height: 4,\s*\n(\s*)borderRadius: 2,\s*\n(\s*)background: C\.track,/,
        (m, i1, i2) => { touched = true; return `height: 34,${i1}borderRadius: "50%",${i2}background: C.track,`; },
      );
      return touched ? next : null;
    },
  },
];

function runAcceptanceIn(dir, only) {
  const out = spawnSync(NODE, ['scripts/acceptance.mjs', `--only=${only}`, '--json'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120_000,
  });
  try {
    return JSON.parse(out.stdout);
  } catch {
    return { results: [], error: (out.stderr ?? '').slice(0, 300) };
  }
}

const work = mkdtempSync(join(tmpdir(), 'mutate-'));
let survived = 0;
let caught = 0;
const skipped = [];

try {
  // 复制一份可运行的副本
  for (const part of ['lib', 'scripts', 'test', 'locale']) {
    const src = join(ROOT, part);
    if (existsSync(src)) cpSync(src, join(work, part), { recursive: true });
  }
  for (const file of ['package.json', 'ACCEPTANCE.md']) {
    const src = join(ROOT, file);
    if (existsSync(src)) writeFileSync(join(work, file), readFileSync(src));
  }

  console.log('=== 基线（未注错）===');
  const baseline = runAcceptanceIn(work, 'A,B,C,E');
  const baseFails = (baseline.results ?? []).filter((r) => r.state === 'fail');
  console.log(`判据 ${(baseline.results ?? []).length} 条，失败 ${baseFails.length} 条`);
  if (baseFails.length > 0) {
    console.log('  基线就不干净，后续注错结果不可信：');
    for (const f of baseFails) console.log(`    ${f.id} ${f.name}`);
  }

  for (const m of MUTATIONS) {
    const file = join(work, m.target);
    if (!existsSync(file)) { skipped.push(`${m.id}（目标文件不存在）`); continue; }
    const original = readFileSync(file, 'utf8');
    const mutated = m.mutate(original);
    if (mutated === null || mutated === original) {
      skipped.push(`${m.id}（注入点没找到，可能实现已变）`);
      continue;
    }
    writeFileSync(file, mutated);
    const result = runAcceptanceIn(work, m.expectFail.charAt(0));
    const target = (result.results ?? []).find((r) => r.id === m.expectFail);
    writeFileSync(file, original);  // 立刻还原

    if (target === undefined) {
      skipped.push(`${m.id}（判据 ${m.expectFail} 没跑起来）`);
      continue;
    }
    if (target.state === 'fail') {
      caught += 1;
      console.log(`抓到  ${m.id} ${m.desc} → ${m.expectFail} 失败`);
    } else {
      survived += 1;
      console.log(`漏掉  ${m.id} ${m.desc} → ${m.expectFail} 仍然"${target.state}" ← 这条判据不可信`);
    }
  }

  console.log(`\n抓到 ${caught} · 漏掉 ${survived}${skipped.length > 0 ? ` · 跳过 ${skipped.length}` : ''}`);
  for (const s of skipped) console.log(`  跳过 ${s}`);
  process.exit(survived === 0 ? 0 : 1);
} finally {
  rmSync(work, { recursive: true, force: true });
}
