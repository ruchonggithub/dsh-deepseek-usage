// 反向验证：故意把代码改坏，看验收判据会不会失败。
//
// 一条判据只有在"注错后必然失败"时才可信。全部绿而注错也全绿，说明它测的是
// 别的东西。这个脚本在**工作区内的副本目录**上做破坏，绝不碰源文件。
//
// 为什么不用系统临时目录：本仓库的铁律是"工作区外零写入（含 TEMP）"。
// 为什么不用固定目录名：固定名字要先删再建，那等于"删掉别人的东西"（上一次的残留、
// 或别人放在那儿的同名目录），而且两个人同时跑会互相覆盖。所以每次运行在固定父目录
// `.mutate-work/` 下建一个**独占子目录**，清理时只删这一个（见 removeOwnedWorkDir）。
//
// **跳过（skip）是非零退出**：注错点找不到就是"这条判据这次没被验证"，与"漏掉"
// 同等不可信。以前跳过不算失败，于是实现一重构、锚点一失效，注错就静默不验，
// 报告里还写着"无跳过"。
//
// **基线红也直接中止**：基线不干净时，某条注错"没被抓到"可能只是那条判据本来就
// 没渲染出东西，结果既抓不到注错也说明不了什么。（这里的"不干净"指验收判据红，
// 与 git 有没有未提交改动无关。）
//
// 用法：node scripts/meta-mutate.mjs

import { readFileSync, writeFileSync, cpSync, rmSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  {
    id: 'M11',
    desc: '让 stats 路由重新在请求里扫描（模拟"预计算"退化成打开即扫）',
    target: 'lib/index.js',
    // 这条注错的判据**不在验收脚本里**，在测试套件里（test/stats-precompute.test.mjs）。
    // 所以用 `testFile` 指定"跑哪个测试文件"，而不是 `expectFail` 报一个验收 id。
    //
    // 为什么必须用测试文件：验收判据只能看响应体，"每请求都扫但结果一样"与"读缓存"
    // 的响应完全一致——只有数**扫描调用次数**才分得出。那是测试侧的注入能力。
    testFile: 'test/stats-precompute.test.mjs',
    expectFail: '判据1：连续打开统计接口，扫描次数不随请求次数增长（只读缓存）',
    mutate: (text) => {
      // 把路由里的"读预计算缓存"改回"每个请求都现扫"。
      // 实现方可能用不同变量名，所以按几个常见形状找锚点；一个都找不到就返回 null，
      // 由脚本记 skip（skip 是非零退出，不会被误读成通过）。
      const patterns = [
        /(const|let)\s+\w+\s*=\s*(await\s+)?[\w$.]*statsCache[\w$.]*/,
        /(const|let)\s+\w+\s*=\s*(await\s+)?(?:[\w$.]*\.)?(statsSnapshot|precomputed|precomputedStats|cachedStats)\b/,
      ];
      for (const pattern of patterns) {
        if (!pattern.test(text)) continue;
        let touched = false;
        const out = text.replace(pattern, () => {
          touched = true;
          return 'const __mutatedLiveScan = await usageScanner.scan();';
        });
        if (touched) return out;
      }
      return null;
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

/**
 * 在副本里跑**一条**测试，返回它是否变红。
 *
 * 为什么需要它：有些判据只有测试能表达（"扫描次数必须为 0"要数调用次数，验收脚本
 * 只看响应体，两者在"每请求都扫、结果一样"时无法区分）。
 *
 * **判据"真的被选中了吗"必须单独判**：`--test-name-pattern` 一条都没匹配时，
 * node 仍然输出 `# tests 1 / # pass 1`（那 1 个是文件级条目），只是 TAP 里
 * `1..0`、且没有带判据名的 `# Subtest:`。曾按 `# pass>0` 判定，会把"判据根本
 * 没跑"误读成"注错没被抓住 / 或者被抓住了"，两种误读都会让注错报表失真。
 *
 * 所以：只有 TAP 里出现「以判据名命名的 Subtest」才算选中；否则记 missing
 * （→ skip → 非零退出）。
 */
function runTestIn(dir, file, namePattern) {
  const out = spawnSync(NODE, [
    '--test',
    '--test-name-pattern', namePattern,
    '--test-reporter', 'tap',
    file,
  ], { cwd: dir, encoding: 'utf8', timeout: 180_000 });
  const stdout = String(out.stdout ?? '');
  // 选中时会有一行 `# Subtest: <判据名>`，且该行不是文件名。
  const subtestNames = [...stdout.matchAll(/^# Subtest: (.+)$/gm)].map((m) => m[1].trim());
  const selected = subtestNames.some((name) => !/\.test\.mjs$/.test(name));
  if (!selected) {
    return { missing: true, failed: false, summary: '没有匹配到判据' };
  }
  const fail = Number((/# fail (\d+)/.exec(stdout) ?? [])[1] ?? 0);
  return { missing: false, failed: fail > 0, summary: fail > 0 ? '变红' : '仍然绿' };
}

/**
 * 建一个**本次运行独占**的工作副本目录。
 *
 * 为什么不是固定的 `.mutate-work/`：固定目录名有两个真问题——
 *   1. 开工前 `rmSync(work, { recursive: true })` 会删掉**别人**放在那儿的同名目录
 *      （可能是上一次的运行、也可能是别人手工留的东西），没有所有权就不该删；
 *   2. 两个人同时跑这个脚本会互相覆盖对方正在改的副本，注错结果互相污染。
 *
 * 做法：在仓库内的固定父目录 `.mutate-work/` 下用一个**唯一子目录**（`mkdtempSync`
 * 生成带随机后缀的名字），父目录只在不存在时创建、绝不删除。
 *
 * 返回的 `owned` 就是本次创建的子目录绝对路径：清理时**只**删它，并在删之前校验
 * 它确实位于 parent 之下。
 */
function createWorkDir() {
  const parent = join(ROOT, '.mutate-work');
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  // `mkdtempSync` 自带"目录已存在就换名"的语义：即使两次运行撞了前缀，也不会
  // 落到别人已经建好的目录上。
  const dir = mkdtempSync(join(parent, `run-${process.pid}-`));
  return { dir, parent };
}

/**
 * 只删除**本次创建**的那个子目录。
 *
 * 三重校验，任一不成立就拒绝删除并报出来（宁可留下垃圾，也不删不该删的东西）：
 *   1. 路径必须是绝对路径；
 *   2. 它必须位于 parent 之下（前缀 + 分隔符，不能是 `..` 拼出来的）；
 *   3. parent 必须仍在仓库根之内。
 */
function removeOwnedWorkDir(dir, parent) {
  const resolvedRoot = resolve(ROOT);
  const resolvedParent = resolve(parent);
  const resolvedDir = resolve(dir);
  const underRoot = resolvedParent === resolvedRoot || resolvedParent.startsWith(resolvedRoot + sep);
  const underParent = resolvedDir.startsWith(resolvedParent + sep);
  if (!underRoot || !underParent) {
    console.log(`  拒绝清理：${resolvedDir} 不在 ${resolvedParent} 之下（或父目录不在仓库内），保留现场。`);
    return;
  }
  rmSync(resolvedDir, { recursive: true, force: true });
}

/**
 * 主流程：**返回退出码**，不在这里 process.exit。
 *
 * 为什么：`try { ... process.exit(1) } finally { ... }` 里 finally **不会执行**——
 * process.exit 直接终止进程。于是"基线不干净就退出"和"跳过就退出"这两条路径上，
 * 工作副本永远留在盘上，脚本注释里写的"跑完 finally 里删掉"是假的。
 *
 * 现在改成：本函数返回码 → finally 清理 → 最后统一 `process.exitCode = code`。
 * 任何一条路径（正常结束 / 基线脏 / 有跳过 / 抛错）都会走到清理。
 */
function main() {
  const { dir: work, parent } = createWorkDir();
  let code = 0;
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
      // **基线不干净 = 整套注错结果不可信。**
      //
      // 这里说的"不干净"是**验收判据红**，与 git 有没有未提交改动无关（那是另一件事，
      // 而且未提交恰恰是本脚本要测的状态：注错就注在工作副本上）。
      //
      // 为什么必须中止：基线红着的时候，某条注错"没被抓到"很可能只是因为那条判据
      // 本来就没渲染出东西（例如实现改到一半，卡片只剩 `⟳▸`），于是它既抓不到注错、
      // 也说明不了什么。上一轮就出现过：M1 记为"漏掉"，真因是基线里 A1/A2 已经红了。
      console.log('  基线就不干净，后续注错结果不可信：');
      for (const f of baseFails) console.log(`    ${f.id} ${f.name} —— ${f.detail ?? ''}`);
      console.log('  先把基线修绿，再谈注错。');
      return 1;
    }

    let survived = 0;
    let caught = 0;
    const skipped = [];

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
      let caughtByThis = false;
      let why = '';
      if (typeof m.testFile === 'string') {
        // 判据在**测试套件**里（预计算那种"必须数调用次数"的判据，验收脚本看不到）。
        // 用 `node --test --test-name-pattern` 只跑那一条，看它是否变红。
        const testResult = runTestIn(work, m.testFile, m.expectFail);
        writeFileSync(file, original);  // 立刻还原
        if (testResult.missing) {
          skipped.push(`${m.id}（测试 ${m.testFile} 里找不到判据「${m.expectFail}」）`);
          continue;
        }
        caughtByThis = testResult.failed;
        why = testResult.summary;
      } else {
        const result = runAcceptanceIn(work, m.expectFail.charAt(0));
        const target = (result.results ?? []).find((r) => r.id === m.expectFail);
        writeFileSync(file, original);  // 立刻还原
        if (target === undefined) {
          skipped.push(`${m.id}（判据 ${m.expectFail} 没跑起来）`);
          continue;
        }
        caughtByThis = target.state === 'fail';
        why = `仍然"${target.state}"`;
      }

      if (caughtByThis) {
        caught += 1;
        console.log(`抓到  ${m.id} ${m.desc} → ${m.expectFail} 失败`);
      } else {
        survived += 1;
        console.log(`漏掉  ${m.id} ${m.desc} → ${m.expectFail} ${why} ← 这条判据不可信`);
      }
    }

    console.log(`\n抓到 ${caught} · 漏掉 ${survived}${skipped.length > 0 ? ` · 跳过 ${skipped.length}` : ''}`);
    for (const s of skipped) console.log(`  跳过 ${s}`);
    // **跳过必须是非零退出。**
    //
    // 之前的写法是 `process.exit(survived === 0 ? 0 : 1)` —— 只要没有"漏掉"就是 0，
    // 哪怕所有注错都因为锚点失效而被跳过。那正是上一轮的实际情况：M7 的锚点随重构
    // 消失、退化成 `return null`，脚本记一条"跳过"，报告里却写「10/10 无跳过」。
    //
    // 一条注错被跳过 = 它对应的判据这次**没被验证过**，与"漏掉"同等不可信。
    if (skipped.length > 0) {
      console.log('  注错被跳过意味着对应判据这次没被验证（等同于漏掉）。');
    }
    code = survived > 0 || skipped.length > 0 ? 1 : 0;
    return code;
  } finally {
    // 清理**本次创建**的那个子目录（不是父目录，更不是别的东西）。
    // 因为 main 返回而不是 process.exit，这条路径在所有分支上都会执行。
    removeOwnedWorkDir(work, parent);
    console.log(`  已清理工作副本：${work}`);
  }
}

try {
  process.exitCode = main();
} catch (error) {
  console.log('脚本自身出错：' + (error instanceof Error ? error.stack : String(error)));
  process.exitCode = 2;
}
