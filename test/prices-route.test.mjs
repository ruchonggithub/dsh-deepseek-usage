// 宿主侧 /api/quota-usage/prices 路由的确定性断言。
//
// 这条路由是配置页「单价」块的数据通道，浏览器侧 lib/client.js 的 PriceEditor 消费它。
// 客户端对「响应体不是 {ok:true, records:[…]}」与「404」**一律按「暂不可用」处理**，
// 所以本文件钉住的是**响应形状**，不是实现细节：
//
//   GET  → { ok: true, records: [...] }（records 是整张表）
//   POST → { action:"save", record:{…} }  保存一条用户改的价
//   POST → { action:"reset" }            恢复出厂价（103 条种子）
//
// 另外三件事必须成立：
//   · 存储损坏（非法 JSON）时 GET **不许 500**：回落种子并把 notices/problems 报出来，
//     用户至少要能看见默认价并继续编辑；
//   · 保存被拒（负数 / 非数字）时**不许写盘**：表内容原样不变；
//   · 非法 JSON body 返回 {ok:false, error:…}，不崩。
//
// ⚠️ 隔离：DSH_QUOTA_USAGE_PRICE_STORE 指向临时文件。lib/price-store.js 的
//   storePath() **每次调用现算**（不是模块加载时读一次并缓存），所以这里在 import 之前
//   设好环境变量即可——运行时改也照样生效，路由处理时同样生效。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { registerHooks } from 'node:module';

const CREDENTIALS_STUB = `
export function credentialRef(name) { return { kind: 'credential-ref', name }; }
export default { credentialRef };
`;

const SCHEMASTERY_STUB = `
const chain = () => new Proxy(function () {}, { get: () => chain, apply: () => chain });
const z = {
  object: chain, array: chain, string: chain, number: chain, boolean: chain,
  dict: chain, union: chain, const: chain, any: chain, literal: chain,
};
export default z;
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-credentials') {
      return { url: 'data:text/javascript,' + encodeURIComponent(CREDENTIALS_STUB), shortCircuit: true };
    }
    if (specifier === '@deepseek-ai/schemastery') {
      return { url: 'data:text/javascript,' + encodeURIComponent(SCHEMASTERY_STUB), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// ---- 存储隔离（必须在 import lib/index.js 之前设好）----------------------
const HOME = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'dsh-prices-route-'));
const STORE_FILE = path.join(HOME, 'price-table.json');
process.env.DSH_QUOTA_USAGE_PRICE_STORE = STORE_FILE;

const { apply } = await import('../lib/index.js');
const priceTable = await import('../lib/price-table.js');

after(() => {
  nodeFs.rmSync(HOME, { recursive: true, force: true });
});

const PRICES_PATH = '/api/quota-usage/prices';

/** 造一个最小的 ctx：记录注册进来的路由。 */
function makeCtx() {
  const routes = new Map();
  const ctx = {
    logger: { warn() {} },
    credentials: {
      resolve: async () => undefined,
      readRecord: async () => undefined,
      set: async () => {},
      unset: async () => {},
    },
    get() { return undefined; },
    effect(fn) {
      fn();
      return () => {};
    },
    webServer: {
      host: '127.0.0.1',
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  };
  return { ctx, routes };
}

/** 造一个最小的 req（GET）。 */
function makeReq(headers = {}, url = PRICES_PATH, method = 'GET') {
  return { headers, url, method };
}

/**
 * 造一个 POST 请求。
 *
 * 宿主的 readBoundedText 需要 Response 形态（headers.get + text），所以用真的
 * Response 提供这两样，再补上 req 的 method / url / headers。
 */
function makePost(payload, headers = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const response = new Response(text, { headers: { 'content-type': 'application/json', ...headers } });
  return {
    method: 'POST',
    url: PRICES_PATH,
    headers: {
      host: '127.0.0.1:64452',
      'content-type': 'application/json',
      ...headers,
      get: (name) => response.headers.get(name),
    },
    text: async () => text,
  };
}

/**
 * 造一个**真宿主那种**的 POST 请求：Node 的 IncomingMessage 形态。
 *
 * ⚠️ 这是踩过的坑，必须有回归：真宿主把 `req` 交给路由时是 Node 的
 * IncomingMessage —— `headers` 是普通对象（`req.headers["content-length"]`），
 * **没有** `.get()`，**没有** `.text()`，但可以 `for await (const chunk of req)`。
 * 只认 Response 形态的读法在真宿主上会让所有 POST 路由读不到 body
 * （实测 /token 返回 413、/collect 返回 502）。
 *
 * 这里用 Readable 造一个等价的请求体流。
 */
function makeIncomingPost(payload, headers = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const stream = Readable.from([Buffer.from(text, 'utf8')]);
  stream.method = 'POST';
  stream.url = PRICES_PATH;
  stream.headers = {
    host: '127.0.0.1:64452',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text, 'utf8')),
    ...headers,
  };
  return stream;
}

function makeRes() {
  const res = {
    statusCode: 0,
    headersSent: false,
    body: undefined,
    writeHead(status) { res.statusCode = status; res.headersSent = true; },
    end(chunk) { res.body = chunk; },
  };
  return res;
}

async function call(route, req) {
  const res = makeRes();
  await route.handler(req, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}

/** 应用插件并拿到 prices 路由。 */
function pricesRoute() {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const route = routes.get(PRICES_PATH);
  assert.ok(route !== undefined, `宿主必须注册 ${PRICES_PATH}`);
  return route;
}

/** 读盘上的存储（信封）。 */
function readStoreFile() {
  return JSON.parse(nodeFs.readFileSync(STORE_FILE, 'utf8'));
}

// ───────────────────────────────────────────────────────────────────────────
// 1. GET：形状与内容
// ───────────────────────────────────────────────────────────────────────────

test('GET 返回 {ok:true, records:[…]}，条数与 listRecords() 一致（103 条）', async () => {
  const route = pricesRoute();
  const res = await call(route, makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(res.status, 200);
  // **确切形状**：客户端只认 ok:true + records。少了 ok 或把 records 换名字都会让
  // 配置页整块变成「暂不可用」。
  assert.equal(res.body.ok, true);
  assert.ok(Array.isArray(res.body.records), 'records 必须是数组');
  assert.equal(res.body.records.length, priceTable.listRecords().length);
  assert.equal(res.body.records.length, 103, '出厂价是 103 条');
});

test('GET 的 records 带客户端分组/过滤/预填要用的字段', async () => {
  const route = pricesRoute();
  const res = await call(route, makeReq({ host: '127.0.0.1:64452' }));
  for (const record of res.body.records) {
    for (const field of ['provider', 'model', 'displayName', 'currency', 'source', 'asOf', 'form']) {
      assert.ok(field in record, `记录缺字段 ${field}：${JSON.stringify(record)}`);
    }
    assert.equal(typeof record.provider, 'string');
    assert.equal(typeof record.model, 'string');
    assert.equal(typeof record.displayName, 'string');
    assert.ok(['CNY', 'USD'].includes(record.currency), `币种非法：${record.currency}`);
    assert.ok(['uniform', 'split', 'free'].includes(record.form), `形态非法：${record.form}`);
    assert.match(record.asOf, /^\d{4}-\d{2}-\d{2}$/);
  }
  // 客户端按 source 区分「已改」与「出厂」，按 currency 显示币种——这两处要真的有值。
  assert.ok(res.body.records.some((r) => r.source === 'official-doc'));
  assert.ok(res.body.records.some((r) => r.source === 'name-suffix'));
  assert.ok(res.body.records.some((r) => r.source === 'free'));
  assert.ok(res.body.records.some((r) => r.form === 'uniform'), '有单一价记录');
  assert.ok(res.body.records.some((r) => r.form === 'split'), '有分项价记录');
  assert.ok(res.body.records.some((r) => r.form === 'free'), '有免费记录');
});

test('GET：分项价记录带峰谷两档与 schedule（客户端的峰谷提示靠它）', async () => {
  const route = pricesRoute();
  const res = await call(route, makeReq({ host: '127.0.0.1:64452' }));
  const flash = res.body.records.find((r) => r.provider === 'deepseek-official' && r.model === 'deepseek-flash');
  assert.ok(flash !== undefined, '表里应有 deepseek-official/deepseek-flash');
  assert.equal(flash.form, 'split');
  assert.equal(flash.input.standard, 2);
  assert.equal(flash.input.offPeak, 1);
  assert.ok(flash.schedule !== null && typeof flash.schedule === 'object', '峰谷记录必须有 schedule');
});

// ───────────────────────────────────────────────────────────────────────────
// 2. POST：保存
// ───────────────────────────────────────────────────────────────────────────

test('POST action:"save" 保存一条 → {ok:true}，之后 GET 能读到新价', async () => {
  const route = pricesRoute();
  const saved = await call(route, makePost({
    action: 'save',
    record: { provider: 'raccoon', model: 'sn-glm-5-3', input: 1.5, output: 1.5, cacheRead: 1.5 },
  }, { host: '127.0.0.1:64452' }));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ok, true, JSON.stringify(saved.body));

  const after = await call(route, makeReq({ host: '127.0.0.1:64452' }));
  const row = after.body.records.find((r) => r.provider === 'raccoon' && r.model === 'sn-glm-5-3');
  assert.ok(row !== undefined, 'GET 必须能读到刚保存的记录');
  assert.equal(row.form, 'uniform', '三值相等仍是单一价');
  assert.equal(row.uniform, 1.5, 'GET 必须给出新价');
  assert.equal(row.source, 'manual', '用户改过的价来源是 manual');
});

test('POST 负数被拒 → {ok:false, error:…}，且**不写盘**（表内容不变）', async () => {
  const route = pricesRoute();
  // 先存一个已知值，之后用它当"表没变"的基准。
  await call(route, makePost({
    action: 'save',
    record: { provider: 'raccoon', model: 'sn-glm-5-3', input: 2, output: 2, cacheRead: 2 },
  }, { host: '127.0.0.1:64452' }));
  const before = readStoreFile();

  const rejected = await call(route, makePost({
    action: 'save',
    record: { provider: 'raccoon', model: 'sn-glm-5-3', input: -1, output: 2, cacheRead: 2 },
  }, { host: '127.0.0.1:64452' }));
  assert.equal(rejected.status, 200, '保存被拒是业务结果，不是 HTTP 错误');
  assert.equal(rejected.body.ok, false);
  assert.equal(typeof rejected.body.error, 'string');
  assert.ok(rejected.body.error !== '', '必须给出原因（客户端会原文显示）');
  // 原因得是人话：客户端直接把它显示在那一行下面。
  assert.ok(/[一-鿿]/.test(rejected.body.error), `error 应是可读文案，实际：${rejected.body.error}`);

  const after = readStoreFile();
  assert.deepEqual(after.records, before.records, '被拒的保存不许写盘');
});

test('POST 非数字被拒 → {ok:false, error:…}，且不写盘', async () => {
  const route = pricesRoute();
  const before = readStoreFile();
  const rejected = await call(route, makePost({
    action: 'save',
    record: { provider: 'raccoon', model: 'sn-glm-5-3', input: 'abc', output: 2, cacheRead: 2 },
  }, { host: '127.0.0.1:64452' }));
  assert.equal(rejected.body.ok, false);
  assert.ok(rejected.body.error !== '');
  assert.deepEqual(readStoreFile().records, before.records, '被拒的保存不许写盘');
});

// ───────────────────────────────────────────────────────────────────────────
// 3. POST：重置 / 未知操作 / 非法 body
// ───────────────────────────────────────────────────────────────────────────

test('POST action:"reset" → 恢复出厂价（103 条种子）', async () => {
  const route = pricesRoute();
  await call(route, makePost({
    action: 'save',
    record: { provider: 'raccoon', model: 'sn-glm-5-3', input: 9, output: 9, cacheRead: 9 },
  }, { host: '127.0.0.1:64452' }));

  const reset = await call(route, makePost({ action: 'reset' }, { host: '127.0.0.1:64452' }));
  assert.equal(reset.status, 200);
  assert.equal(reset.body.ok, true, JSON.stringify(reset.body));

  const after = await call(route, makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(after.body.records.length, 103, '重置后是 103 条种子');
  const row = after.body.records.find((r) => r.provider === 'raccoon' && r.model === 'sn-glm-5-3');
  assert.equal(row.uniform, 0.75, '恢复出厂价');
  assert.equal(row.source, 'name-suffix', '来源也恢复');
});

test('POST 未知 action → {ok:false, error:…}', async () => {
  const route = pricesRoute();
  const res = await call(route, makePost({ action: 'explode' }, { host: '127.0.0.1:64452' }));
  assert.equal(res.body.ok, false);
  assert.ok(typeof res.body.error === 'string' && res.body.error !== '');
});

test('POST 非法 JSON body → {ok:false, error:…}，不崩', async () => {
  const route = pricesRoute();
  const res = await call(route, makePost('{ this is not json', { host: '127.0.0.1:64452' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  // error 是**人话**（客户端原文显示给用户），不是 "payload" 这种机器键。
  assert.ok(typeof res.body.error === 'string' && res.body.error !== '');
  assert.ok(!/^[a-z-]+$/.test(res.body.error), `error 应是人话，实际：${res.body.error}`);
});

// ───────────────────────────────────────────────────────────────────────────
// 4. 存储损坏：不许 500
// ───────────────────────────────────────────────────────────────────────────

test('存储是非法 JSON 时 GET 仍返回 {ok:true, records:[…]}（回落种子，不 500）', async () => {
  const route = pricesRoute();
  nodeFs.writeFileSync(STORE_FILE, '{ "records": [ this is not json', 'utf8');

  const res = await call(route, makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(res.status, 200, '存储坏了不许 500');
  assert.equal(res.body.ok, true, '必须是客户端认得的那个形状');
  assert.ok(Array.isArray(res.body.records));
  assert.equal(res.body.records.length, 103, '回落种子');
  // 坏在哪要说出来（静默回落 = 用户不知道自己看的是出厂价）。
  assert.ok(Array.isArray(res.body.notices));
  assert.ok(res.body.notices.includes('store-parse-error'), `应报告解析失败，实际：${res.body.notices}`);
  assert.equal(typeof res.body.problems, 'number');
  assert.ok(res.body.problems > 0, '问题条数要报出来');
});

test('存储结构不对（records 不是数组）时同样回落种子，不 500', async () => {
  const route = pricesRoute();
  nodeFs.writeFileSync(STORE_FILE, JSON.stringify({ version: 1, records: 5 }), 'utf8');
  const res = await call(route, makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.records.length, 103);
  assert.ok(res.body.notices.includes('store-shape-error'));
});

test('存储坏了之后仍可保存：整表重写为合法 JSON，并告知坏文件已被替换', async () => {
  const route = pricesRoute();
  nodeFs.writeFileSync(STORE_FILE, '{ broken', 'utf8');
  const saved = await call(route, makePost({
    action: 'save',
    record: { provider: 'raccoon', model: 'sn-kimi-k3', input: 2, output: 2, cacheRead: 2 },
  }, { host: '127.0.0.1:64452' }));
  assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
  assert.ok(saved.body.notices.includes('overwrote-corrupt-store'), `应告知坏文件被替换，实际：${saved.body.notices}`);

  const after = await call(route, makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(after.body.ok, true);
  assert.equal(after.body.records.length, 103);
});

// ───────────────────────────────────────────────────────────────────────────
// 5. 请求体形态：真宿主给的是 Node 的 IncomingMessage
// ───────────────────────────────────────────────────────────────────────────

test('POST 在真宿主的请求体形态（IncomingMessage）下也能保存（回归：读 body 的两副面孔）', async () => {
  const route = pricesRoute();
  const saved = await call(route, makeIncomingPost({
    action: 'save',
    record: { provider: 'raccoon', model: 'sn-glm-5-3', input: 1.75, output: 1.75, cacheRead: 1.75 },
  }));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ok, true, `IncomingMessage 形态下必须能读到 body，实际：${JSON.stringify(saved.body)}`);

  const after = await call(route, makeReq({ host: '127.0.0.1:64452' }));
  const row = after.body.records.find((r) => r.provider === 'raccoon' && r.model === 'sn-glm-5-3');
  assert.equal(row.uniform, 1.75, '新价必须落盘并能被 GET 读到');
});

test('POST 在真宿主形态下：负数被拒、非法 JSON 不崩', async () => {
  const route = pricesRoute();
  const rejected = await call(route, makeIncomingPost({
    action: 'save',
    record: { provider: 'raccoon', model: 'sn-glm-5-3', input: -3, output: 1, cacheRead: 1 },
  }));
  assert.equal(rejected.body.ok, false);
  assert.ok(rejected.body.error !== '');

  const broken = await call(route, makeIncomingPost('{ not json'));
  assert.equal(broken.status, 200);
  assert.equal(broken.body.ok, false);
  assert.ok(broken.body.error !== '');
});

test('POST 在真宿主形态下：reset 恢复出厂价', async () => {
  const route = pricesRoute();
  await call(route, makeIncomingPost({
    action: 'save',
    record: { provider: 'raccoon', model: 'sn-glm-5-3', input: 5, output: 5, cacheRead: 5 },
  }));
  const reset = await call(route, makeIncomingPost({ action: 'reset' }));
  assert.equal(reset.body.ok, true, JSON.stringify(reset.body));
  const after = await call(route, makeReq({ host: '127.0.0.1:64452' }));
  const row = after.body.records.find((r) => r.provider === 'raccoon' && r.model === 'sn-glm-5-3');
  assert.equal(row.uniform, 0.75, '恢复出厂价');
});

// ───────────────────────────────────────────────────────────────────────────
// 6. 围栏与隔离
// ───────────────────────────────────────────────────────────────────────────
test('prices 路由也只接受本机来源', async () => {
  const route = pricesRoute();
  const denied = await call(route, makeReq({ host: 'evil.example' }));
  assert.equal(denied.status, 403);
});

test('非 GET/POST 方法被拒绝（405）', async () => {
  const route = pricesRoute();
  const res = await call(route, makeReq({ host: '127.0.0.1:64452' }, PRICES_PATH, 'DELETE'));
  assert.equal(res.status, 405);
});

test('DSH_QUOTA_USAGE_PRICE_STORE 在**路由处理时**也生效（运行时改环境变量即换存储）', async () => {
  const route = pricesRoute();
  const other = path.join(HOME, 'other-store.json');
  const previous = process.env.DSH_QUOTA_USAGE_PRICE_STORE;
  process.env.DSH_QUOTA_USAGE_PRICE_STORE = other;
  try {
    // 换一个存储文件 → 第一次访问那里是"存储不存在" → 种子落盘到新文件。
    const res = await call(route, makeReq({ host: '127.0.0.1:64452' }));
    assert.equal(res.body.ok, true);
    assert.ok(nodeFs.existsSync(other), '新环境变量指定的文件应当被使用');
    // 原来的文件不受影响。
    assert.notEqual(other, STORE_FILE);
  } finally {
    if (previous === undefined) delete process.env.DSH_QUOTA_USAGE_PRICE_STORE;
    else process.env.DSH_QUOTA_USAGE_PRICE_STORE = previous;
  }
});
