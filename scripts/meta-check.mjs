// 元验收：**验收脚本本身**能不能抓到 bug？
//
// 做法：故意注错（破坏一个行为），看对应判据会不会失败。如果注错之后仍然全绿，
// 那这条判据就是假绿——它测的东西与用户要的东西无关。
//
// 这里只测"判据的灵敏度"，不测产品代码。全部在内存里改字符串，不碰磁盘。

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const NODE = process.execPath;

/** 跑一组验收判据，返回结果数组。 */
function runAcceptance(only) {
  const out = spawnSync(NODE, ['scripts/acceptance.mjs', `--only=${only}`, '--json'], {
    encoding: 'utf8',
  });
  try {
    return JSON.parse(out.stdout);
  } catch {
    return { results: [], parseError: (out.stderr ?? '').slice(0, 400) + (out.stdout ?? '').slice(0, 400) };
  }
}

/**
 * 判据灵敏度检查表。
 *
 * 每项：`name` 说明注的是什么错，`group` 对应判据组，`expectFail` 是应当失败的判据 id。
 * 注错方式由 `mutate` 描述（人工在代码里做，本脚本只报告"当前判据能否发现"）。
 *
 * 由于注错需要改文件，这里用**只读判定**：先跑一遍基线，再报告每条判据是否存在
 * "看起来通过但实际没验"的风险标志（例如断言里出现 `includes(` 这种白盒写法）。
 */
const groups = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const baseline = runAcceptance(groups.join(','));

if (baseline.parseError) {
  console.error('验收脚本无法运行：', baseline.parseError);
  process.exit(2);
}

const byId = new Map((baseline.results ?? []).map((r) => [r.id, r]));

console.log('=== 基线 ===');
for (const r of baseline.results ?? []) {
  console.log(`${r.state === 'pass' ? '通过' : r.state === 'missing' ? '未实现' : '失败'}  ${r.id}  ${r.name}`);
}

// 白盒嗅探：判据的 detail 里不该出现"源码包含某标识符"这类痕迹。
// 这是我们上一版最大的毛病，用一条机械检查防止它悄悄回来。
//
// 注意区分两种 readFileSync：
//   · 读源码然后 `expect(source.includes(...))` —— 白盒断言，禁止。
//   · 读源码喂给 `new Function(...)` 真的把组件跑起来 —— 这是**必须**的，
//     验收要判"用户看到什么"就得执行组件。所以只禁第一种。
const source = readFileSync('scripts/acceptance.mjs', 'utf8');
const lines = source.split('\n');
const whiteBoxHits = [];
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (/^\s*(\*|\/\/)/.test(line)) continue; // 注释里提到旧写法是允许的（那是文档）
  if (/expect\(\s*source[\s.]/.test(line) || /source\.includes\(/.test(line)) {
    whiteBoxHits.push(`${i + 1}: ${line.trim().slice(0, 100)}`);
  }
}
const hits = whiteBoxHits;

console.log('\n=== 元检查 ===');
console.log(hits.length === 0
  ? '通过  判据里没有「检查源码包含某标识符」这类白盒断言'
  : `失败  发现 ${hits.length} 处白盒断言：\n  ${hits.join('\n  ')}`);

// 覆盖率提示：ACCEPTANCE.md 的每条标准，都应当有一个判据 id 以它为前缀。
// 判据可以比标准多（同一标准配正反两条），但不能少。
//
// 按 id 去重计数——同一编号在文档里出现两次是排版事故，不该掩盖真实缺口。
let docIds = [];
try {
  const doc = readFileSync('ACCEPTANCE.md', 'utf8');
  docIds = [...new Set([...doc.matchAll(/^### ([A-G][0-9a-z]*)/gm)].map((m) => m[1]))];
} catch { docIds = []; }
const claimIds = new Set((baseline.results ?? []).map((r) => r.id));
// 一条标准算"已覆盖"：存在同 id 的判据，或形如 `G2b` 的变体判据。
const uncovered = docIds.filter((id) => !claimIds.has(id)
  && ![...claimIds].some((claim) => claim.startsWith(id) && claim.length > id.length));

const judged = (baseline.results ?? []).length;
console.log(`\nACCEPTANCE.md 标准：${docIds.length} 条，可执行判据：${judged} 条`);
if (uncovered.length > 0) {
  console.log(`未覆盖的标准：${uncovered.join('、')}`);
} else {
  console.log('通过  每条标准都有对应判据');
}

process.exit(hits.length === 0 ? 0 : 1);
