const test = require('node:test');
const assert = require('node:assert');
const handler = require('../api/unsubscribe.js');

function mockRes() {
  const res = { statusCode: 200, headers: {}, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const realFetch = global.fetch;
let calls = [];
function mockFetch(status, body) {
  calls = [];
  global.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: status >= 200 && status < 300, status, json: async () => body }; };
}

test.beforeEach(() => { process.env.AIRTABLE_TOKEN = 'test-token'; });
test.after(() => { global.fetch = realFetch; delete process.env.AIRTABLE_TOKEN; });

test('rejects GET', async () => {
  mockFetch(200, {});
  const res = mockRes();
  await handler({ method: 'GET', body: null }, res);
  assert.strictEqual(res.statusCode, 405);
  assert.strictEqual(calls.length, 0);
});

test('rejects invalid ids with 400 and never calls Airtable', async () => {
  for (const r of ['', 'abc', 'rec123', 'recAAAAAAAAAAAAAAA', 'recAAAAAAAAAAAA!A', '../recAAAAAAAAAAAAAA']) {
    mockFetch(200, {});
    const res = mockRes();
    await handler({ method: 'POST', body: { r } }, res);
    assert.strictEqual(res.statusCode, 400, r);
    assert.strictEqual(calls.length, 0);
  }
});

test('patches the three watcher fields and never creates', async () => {
  mockFetch(200, { id: 'recAbCdEfGhIjKlMn' });
  const res = mockRes();
  await handler({ method: 'POST', body: JSON.stringify({ r: 'recAbCdEfGhIjKlMn' }) }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].opts.method, 'PATCH');
  assert.match(calls[0].url, /\/tblXffD6uZWW4275I\/recAbCdEfGhIjKlMn$/);
  assert.deepStrictEqual(JSON.parse(calls[0].opts.body).fields, { 'Unsubscribed': true, 'Sequence Stopped': true, 'Sequence Stop Reason': 'Unsubscribed' });
});

test('unknown record gives the same friendly success', async () => {
  mockFetch(404, { error: 'NOT_FOUND' });
  const res = mockRes();
  await handler({ method: 'POST', body: { r: 'recAbCdEfGhIjKlMn' } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.message, handler.DONE);
});

test('other Airtable errors return a server error', async () => {
  mockFetch(422, { error: { type: 'INVALID_VALUE_FOR_COLUMN' } });
  const res = mockRes();
  await handler({ method: 'POST', body: { r: 'recAbCdEfGhIjKlMn' } }, res);
  assert.strictEqual(res.statusCode, 502);
});

test('missing token is reported, not faked', async () => {
  delete process.env.AIRTABLE_TOKEN;
  mockFetch(200, {});
  const res = mockRes();
  await handler({ method: 'POST', body: { r: 'recAbCdEfGhIjKlMn' } }, res);
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(calls.length, 0);
});
