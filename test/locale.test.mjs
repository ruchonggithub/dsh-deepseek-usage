// 插件元数据本地化：DSH 读 locale/<language>.json 里的 meta.title / meta.description
// （插件列表的名称与描述）与 meta.detail（详情页正文），按 DSH 语言解析。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const manifest = readJson('package.json');

test('locale/en.json 与 locale/zh.json 提供非空的标题与描述', () => {
  for (const lang of ['en', 'zh']) {
    const meta = readJson(`locale/${lang}.json`).meta;
    assert.equal(typeof meta.title, 'string', `${lang}: meta.title 必须是字符串`);
    assert.ok(meta.title.trim() !== '', `${lang}: meta.title 不能为空`);
    assert.equal(typeof meta.description, 'string', `${lang}: meta.description 必须是字符串`);
    assert.ok(meta.description.trim() !== '', `${lang}: meta.description 不能为空`);
  }
  // 英文标题与中文标题必须真的不同，否则等于没本地化。
  // 名称改为「额度与用量」：插件查的不只 DeepSeek 一家（还有 Kimi / GLM / OpenRouter…），
  // 「DeepSeek 用量」在插件列表里会误导——那一栏是各家账户的额度与用量。
  assert.equal(readJson('locale/zh.json').meta.title, '额度与用量');
  assert.equal(readJson('locale/en.json').meta.title, 'Quota & Usage');
});

test('详情页正文统一用中文 README.md', () => {
  // 中文是本项目的默认文档语言：README.md 就是中文版，不再维护英文 README。
  for (const lang of ['en', 'zh']) {
    assert.equal(readJson(`locale/${lang}.json`).meta.detail, 'README.md', `${lang}: meta.detail 必须指向 README.md`);
  }
  assert.ok(existsSync(join(root, 'README.md')), 'README.md 必须存在（meta.detail 指向它）');
  assert.ok(!existsSync(join(root, 'README.zh.md')), 'README.zh.md 已并入 README.md，不应再存在');
});

test('meta.detail 是包内相对路径的 Markdown', () => {
  for (const lang of ['en', 'zh']) {
    const detail = readJson(`locale/${lang}.json`).meta.detail;
    assert.match(detail, /^[A-Za-z0-9._-]+(?:[A-Za-z0-9._-]*\/)?[A-Za-z0-9._-]+\.md$/, `${lang}: meta.detail 必须是 .md 相对路径`);
    assert.ok(!detail.split('/').includes('..'), `${lang}: meta.detail 不得离开包目录`);
  }
});

test('打包声明带上 locale 与中文 README，否则线上读不到元数据', () => {
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json');
  assert.ok(manifest.files.includes('locale'), 'files 必须包含 locale');
  assert.ok(manifest.files.includes('README.md'), 'files 必须包含 README.md（中文默认文档）');
});
