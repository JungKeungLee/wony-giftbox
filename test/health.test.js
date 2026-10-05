// test/health.test.js
// GET /health 헬스 체크 테스트입니다.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

test('GET /health → DB 연결이 없어도 200 { status: "ok" }', async () => {
  // DB가 없는 상태를 만들기 위해 DATABASE_URL을 비우고 server.js의 app만 불러옵니다. (listen하지 않음)
  delete process.env.DATABASE_URL;
  const app = require('../server');
  const server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, () => resolve(s));
  });
  try {
    const base = `http://localhost:${server.address().port}`;

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.match(health.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await health.json(), { status: 'ok' });

    // 선물상자 API는 DB가 없으므로 503 — 헬스 체크는 DB 상태와 무관함을 확인
    assert.equal((await fetch(`${base}/api/gift/state`)).status, 503);
  } finally {
    server.close();
  }
});
