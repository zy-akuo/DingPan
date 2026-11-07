const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../apps/web/node_modules/typescript');
const source = fs.readFileSync(path.join(__dirname, '../apps/web/src/lib/requestFeedback.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
function setup(fetcher, timeout = 100) {
  const notices = [];
  const win = { fetch: fetcher, location: { href: 'http://localhost/' , origin: 'http://localhost' },
    dispatchEvent: e => { notices.push(e.detail); return true; } };
  const mod = { exports: {} };
  new Function('exports', 'window', compiled.outputText)(mod.exports, win);
  mod.exports.installRequestFeedback(timeout);
  return { win, notices };
}
const ok = () => new Response('{"bars":[1]}', { headers: { 'content-type': 'application/json' } });

test('超时会终止请求并提供中文提醒', async () => {
  let signal;
  const { win, notices } = setup(async (_, init) => { signal = init.signal; return new Promise(() => {}); }, 10);
  await assert.rejects(win.fetch('/api/stock/600261/kline'), /请求超时/);
  assert.equal(signal.aborted, true);
  assert.match(notices[0].title, /日K/);
});

test('响应体等待也受超时限制', async () => {
  const { win, notices } = setup(async () => new Response(new ReadableStream({ start() {} })), 10);
  await assert.rejects(win.fetch('/api/config'), /请求超时/);
  assert.equal(notices.length, 1);
});

test('HTTP错误合并提醒，恢复后只提示一次，保留响应供调用方处理', async () => {
  let broken = true;
  const { win, notices } = setup(async () => broken ? new Response('', { status: 502 }) : ok());
  assert.equal((await win.fetch('/api/auction/board')).status, 502);
  await win.fetch('/api/auction/board');
  assert.equal(notices.length, 1);
  broken = false;
  const response = await win.fetch('/api/auction/board');
  assert.deepEqual(await response.json(), { bars: [1] });
  await win.fetch('/api/auction/board');
  assert.equal(notices.length, 2);
  assert.equal(notices[1].kind, 'success');
});

test('200响应中的数据源错误也提醒', async () => {
  const { win, notices } = setup(async () => new Response('{"error":"上游不可用"}', { headers: { 'content-type': 'application/json' } }));
  await win.fetch('/api/market/history');
  assert.match(notices[0].description, /上游不可用/);
});

test('网络失败提示代理检查，主动取消静默', async () => {
  const network = setup(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(network.win.fetch('/api/config'), /代理/);
  assert.equal(network.notices.length, 1);
  const cancelled = setup(async (_, init) => { throw init.signal.reason; });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(cancelled.win.fetch('/api/config', { signal: controller.signal }));
  assert.equal(cancelled.notices.length, 0);
});
