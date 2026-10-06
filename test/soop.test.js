// test/soop.test.js
// SOOP 공식 OAuth + Chat SDK 별풍선 연동 테스트입니다.
//
// - 실제 SOOP 대신 가짜 OAuth 서버(/auth/token)와 Mock Chat SDK Adapter를 씁니다.
// - 흐름 전체를 실제로 탑니다:
//   Mock SDK(BALLOON_GIFTED) → connectorCore → POST /api/soop/balloon(세션 쿠키)
//   → DonationService → GiftEventService → PostgreSQL(PGlite)

const test = require('node:test');
const { before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const OPERATOR_TOKEN = 'test-operator-token';
process.env.OPERATOR_TOKEN = OPERATOR_TOKEN;

const { wrapPglite, initSchema } = require('../gift/database');
const { mountGiftBox } = require('../gift');
const { mountSoopConnector } = require('../soop');
const { balloonToDonation } = require('../soop/balloon');
const { SoopConnectorCore } = require('../soop/connector/connectorCore');

const ADMIN = { 'X-Operator-Token': OPERATOR_TOKEN };
const BJ_ID = 'wony';

let database;
let fakeSoop;
let fakeSoopBase;
const fakeSoopState = { mode: 'ok', requests: [], issued: 0 };

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, () => resolve(server));
  });
}

before(async () => {
  const { PGlite } = require('@electric-sql/pglite');
  database = wrapPglite(new PGlite());
  await initSchema(database);

  // 가짜 SOOP OpenAPI: POST /auth/token 만 흉내 냅니다. (공식 문서의 요청/응답 형식)
  fakeSoop = await listen((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const params = Object.fromEntries(new URLSearchParams(body));
      fakeSoopState.requests.push({ method: req.method, url: req.url, contentType: req.headers['content-type'], params });
      res.setHeader('Content-Type', 'application/json');
      if (req.url !== '/auth/token' || fakeSoopState.mode === 'fail') {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: 'invalid_grant', error_description: '잘못된 인증 코드 (테스트)' }));
      }
      fakeSoopState.issued += 1;
      res.end(JSON.stringify({
        access_token: `access-${fakeSoopState.issued}`,
        expires_in: 28800,
        token_type: 'Bearer',
        scope: null,
        refresh_token: `refresh-${fakeSoopState.issued}`,
      }));
    });
  });
  fakeSoopBase = `http://localhost:${fakeSoop.address().port}`;
});

after(async () => {
  fakeSoop.close();
  await database.close();
});

beforeEach(async () => {
  await database.exec('TRUNCATE gift_event_log, gift_winner, gift_prize, gift_donation, gift_event RESTART IDENTITY CASCADE');
  Object.assign(fakeSoopState, { mode: 'ok', requests: [], issued: 0 });
});

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

// 선물상자 + SOOP 커넥터가 붙은 앱을 띄웁니다.
async function startApp({ soopConfig, target = 1000, start = true, database: db = database } = {}) {
  const app = express();
  const gift = mountGiftBox(app, { database: db, retryBaseMs: 30, serviceOptions: { scheduleTimers: false } });
  mountSoopConnector(app, {
    getDonationService: () => gift.runtime.donationService,
    config: soopConfig === undefined
      ? { clientId: 'test-client-id', clientSecret: 'test-client-secret', allowedBjId: '', oauthBase: fakeSoopBase }
      : soopConfig,
  });
  const server = await listen(app);
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://localhost:${server.address().port}`;

  const call = async (method, url, { body, headers = {} } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };

  if (db === database) {
    await gift.ready;
    if (start) {
      await call('PUT', '/api/gift/admin/settings', { headers: ADMIN, body: { targetAmount: target } });
      await call('PUT', '/api/gift/admin/prizes', { headers: ADMIN, body: { prizes: [{ name: '치킨', quantity: 1 }] } });
      await call('POST', '/api/gift/admin/start', { headers: ADMIN });
    }
  }
  return { base, call, gift, adminState: async () => (await call('GET', '/api/gift/admin/state', { headers: ADMIN })).data };
}

function cookieFrom(headers, name) {
  const found = headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  return found ? found.split(';')[0] : null;
}

// 관리자 → /soop-connector/login → (SOOP 로그인/동의) → /soop-connector/callback 까지 진행하고 세션 쿠키를 돌려줍니다.
async function oauthLogin(t, { code = 'auth-code-1', echoState = true } = {}) {
  const login = await t.call('GET', '/soop-connector/login', { headers: ADMIN });
  assert.equal(login.status, 302);
  const authorizeUrl = new URL(login.headers.get('location'));
  assert.equal(`${authorizeUrl.origin}${authorizeUrl.pathname}`, `${fakeSoopBase}/auth/code`);
  const state = authorizeUrl.searchParams.get('state');
  const stateCookie = cookieFrom(login.headers, 'soop_oauth_state');
  assert.ok(state && stateCookie);

  const query = new URLSearchParams({ code, ...(echoState ? { state } : {}) });
  const callback = await t.call('GET', `/soop-connector/callback?${query}`, { headers: { Cookie: stateCookie } });
  return { callback, authorizeUrl, sessionCookie: cookieFrom(callback.headers, 'soop_connector') };
}

// ---------------- Mock Chat SDK Adapter ----------------
// 공식 SDK(window.SOOP.ChatSDK)와 같은 메서드 이름/콜백 형태를 흉내 냅니다.
// 현재 배포된 공식 SDK 인스턴스에는 init()이 없어서(문서 예제와 다름) Mock에도 넣지 않습니다.
class MockChatSdk {
  constructor(clientId, { failConnect = false, bjId = BJ_ID } = {}) {
    this.clientId = clientId;
    this.failConnect = failConnect;
    this.bjId = bjId;
    this.connected = false;
  }
  setAuth(token) { this.accessToken = token; }
  connect() {
    if (this.failConnect) return Promise.reject(new Error('mock connect failure'));
    this.connected = true;
    return Promise.resolve(true);
  }
  disconnect() { this.connected = false; }
  getRoomInfo() { return { chatNumber: 1, bjId: this.bjId }; }
  handleMessageReceived(callback) { this.onMessage = callback; }
  handleChatClosed(callback) { this.onClosed = callback; }
  handleError(callback) { this.onError = callback; }
  // 테스트에서 채팅 서버 이벤트를 흉내 냅니다.
  emit(action, message) { this.onMessage(action, message); }
}

function balloon(overrides = {}) {
  return {
    bjId: BJ_ID,
    userId: 'fan01',
    userNickname: '홍길동',
    count: 100,
    fanNumber: 0,
    imageUrl: 'https://example.invalid/balloon.png',
    becomesTopFan: false,
    relaysBroad: false,
    fromVod: false,
    ...overrides,
  };
}

// 브라우저 fetch 대신 쿠키 헤더를 직접 붙이는 API 어댑터
function connectorApi(t, sessionCookie) {
  const request = async (method, url, body) => {
    const res = await t.call(method, url, { body, headers: sessionCookie ? { Cookie: sessionCookie } : {} });
    if (res.status >= 400) {
      const error = new Error((res.data && res.data.error) || `HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return res.data;
  };
  return {
    getSession: () => request('GET', '/api/soop/session'),
    refreshToken: () => request('POST', '/api/soop/token/refresh'),
    postStatus: (body) => request('POST', '/api/soop/status', body),
    postBalloon: (body) => request('POST', '/api/soop/balloon', body),
    logout: () => request('POST', '/api/soop/logout'),
  };
}

async function startConnector(t, sessionCookie, sdkOptions = {}) {
  const sdks = [];
  const core = new SoopConnectorCore({
    api: connectorApi(t, sessionCookie),
    createSdk: (clientId) => {
      const sdk = new MockChatSdk(clientId, sdkOptions);
      sdks.push(sdk);
      return sdk;
    },
    reconnectDelaysMs: [60000],
  });
  cleanups.push(() => core.stopAll());
  await core.loadSession();
  await core.connect();
  return { core, sdks, sdk: () => sdks[sdks.length - 1] };
}

async function waitIdle(core) {
  for (let i = 0; i < 200 && (core.queue.length || core.sending); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(core.queue.length, 0, '전송 대기열이 비어야 합니다');
}

async function donorOf(t, nickname) {
  return (await t.adminState()).donors.find((donor) => donor.nickname === nickname);
}

// ---------------- 변환 규칙 (순수 함수) ----------------

test('balloonToDonation: 공식 필드 → 표준 후원 형식 (donorId=userId, STAR, amount=count, SOOP_OFFICIAL)', () => {
  const { donation } = balloonToDonation({ message: balloon(), clientEventId: 'abc' });
  assert.deepEqual(donation, {
    donorId: 'fan01',
    nickname: '홍길동',
    type: 'STAR',
    amount: 100,
    source: 'SOOP_OFFICIAL',
    eventId: 'sdk:abc',
  });
});

test('balloonToDonation: VOD / 중계방 / 도전·대결미션 / 다른 bjId / 잘못된 개수는 제외', () => {
  assert.equal(balloonToDonation({ message: balloon({ fromVod: true }) }).excluded, 'VOD');
  assert.equal(balloonToDonation({ message: balloon({ relaysBroad: true }) }).excluded, 'RELAY');
  assert.equal(balloonToDonation({ action: 'CHALLENGE_MISSION_GIFTED', message: balloon() }).excluded, 'NOT_BALLOON');
  assert.equal(balloonToDonation({ action: 'BATTLE_MISSION_GIFTED', message: balloon() }).excluded, 'NOT_BALLOON');
  assert.equal(balloonToDonation({ message: balloon({ bjId: 'other' }) }, { bjId: BJ_ID }).excluded, 'OTHER_BJ');
  assert.equal(balloonToDonation({ message: balloon() }, { allowedBjId: 'someone-else' }).excluded, 'OTHER_BJ');
  assert.equal(balloonToDonation({ message: balloon({ count: 0 }) }).excluded, 'INVALID');
  assert.equal(balloonToDonation({ message: balloon({ count: 1.5 }) }).excluded, 'INVALID');
});

// ---------------- OAuth ----------------

test('OAuth: 공식 auth/code로 이동(client_id, state) → 콜백에서 서버가 Client Secret으로 토큰 발급 → HttpOnly 세션 쿠키', async () => {
  const t = await startApp();
  const { callback, authorizeUrl, sessionCookie } = await oauthLogin(t);

  assert.equal(authorizeUrl.searchParams.get('client_id'), 'test-client-id');
  assert.equal(authorizeUrl.searchParams.get('response_type'), 'code');
  assert.ok(!authorizeUrl.toString().includes('test-client-secret'), '인증 URL에 Client Secret이 들어가면 안 됨');

  assert.equal(callback.status, 200);
  assert.ok(sessionCookie);
  const setCookie = callback.headers.getSetCookie().find((value) => value.startsWith('soop_connector='));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);

  const tokenRequest = fakeSoopState.requests.find((r) => r.url === '/auth/token');
  assert.equal(tokenRequest.method, 'POST');
  assert.match(tokenRequest.contentType, /application\/x-www-form-urlencoded/);
  assert.deepEqual(tokenRequest.params, {
    client_id: 'test-client-id',
    client_secret: 'test-client-secret',
    grant_type: 'authorization_code',
    code: 'auth-code-1',
  });

  // 브라우저(커넥터 화면)에는 Access Token과 Client ID만 가고 Secret/Refresh Token은 가지 않습니다.
  const session = await t.call('GET', '/api/soop/session', { headers: { Cookie: sessionCookie } });
  assert.equal(session.data.connected, true);
  assert.equal(session.data.accessToken, 'access-1');
  assert.equal(session.data.clientId, 'test-client-id');
  const serialized = JSON.stringify(session.data);
  assert.ok(!serialized.includes('test-client-secret'));
  assert.ok(!serialized.includes('refresh-1'));
  assert.ok(!serialized.includes(OPERATOR_TOKEN));
});

test('OAuth: state가 다르거나 state 쿠키가 없으면 콜백 거절 (CSRF 방지), state는 1회용', async () => {
  const t = await startApp();
  const login = await t.call('GET', '/soop-connector/login', { headers: ADMIN });
  const stateCookie = cookieFrom(login.headers, 'soop_oauth_state');
  const state = new URL(login.headers.get('location')).searchParams.get('state');

  const wrong = await t.call('GET', '/soop-connector/callback?code=x&state=forged', { headers: { Cookie: stateCookie } });
  assert.equal(wrong.status, 400);
  assert.equal(cookieFrom(wrong.headers, 'soop_connector'), null);

  const noCookie = await t.call('GET', `/soop-connector/callback?code=x&state=${state}`);
  assert.equal(noCookie.status, 400);

  // 위의 실패 시도에서 이미 소모되었으므로 같은 state로는 더 이상 연결할 수 없습니다.
  const reused = await t.call('GET', `/soop-connector/callback?code=x&state=${state}`, { headers: { Cookie: stateCookie } });
  assert.equal(reused.status, 400);
  assert.equal(fakeSoopState.requests.length, 0, '검증 실패 시 토큰 발급을 요청하지 않음');
});

test('OAuth: 관리자 로그인 없이 /soop-connector/login 접근 시 SOOP로 보내지 않음', async () => {
  const t = await startApp();
  const res = await t.call('GET', '/soop-connector/login');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/soop-connector');
  const page = await t.call('GET', '/soop-connector');
  assert.match(page.data, /OPERATOR_TOKEN/); // 관리자 로그인 화면
});

test('OAuth: Refresh Token으로 Access Token 재발급 (서버가 grant_type=refresh_token 호출)', async () => {
  const t = await startApp();
  const { sessionCookie } = await oauthLogin(t);
  const refreshed = await t.call('POST', '/api/soop/token/refresh', { headers: { Cookie: sessionCookie } });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.data.accessToken, 'access-2');
  const last = fakeSoopState.requests[fakeSoopState.requests.length - 1];
  assert.equal(last.params.grant_type, 'refresh_token');
  assert.equal(last.params.refresh_token, 'refresh-1');
});

// ---------------- Mock Chat SDK → 서버 → 선물상자 ----------------

test('BALLOON_GIFTED 100개 → STAR 100 집계 (source SOOP_OFFICIAL, donorId = SOOP userId)', async () => {
  const t = await startApp();
  const { sessionCookie } = await oauthLogin(t);
  const { core, sdk } = await startConnector(t, sessionCookie);
  assert.equal(core.sdkState, 'CONNECTED');
  assert.equal(sdk().accessToken, 'access-1');
  assert.equal(sdk().clientId, 'test-client-id');

  sdk().emit('BALLOON_GIFTED', balloon({ count: 100 }));
  await waitIdle(core);

  const state = await t.adminState();
  assert.equal(state.event.currentAmount, 100);
  const donor = await donorOf(t, '홍길동');
  assert.deepEqual(donor.byType, { STAR: 100, CHALLENGE: 0, BATTLE: 0 });
  assert.equal(donor.tickets, 1);
  const [donation] = state.recentDonations;
  assert.equal(donation.source, 'SOOP_OFFICIAL');
  assert.equal(donation.donorId, 'fan01');
  assert.equal(donation.type, 'STAR');
  assert.equal(core.recent[0].result, 'COUNTED');
});

test('동일 사용자 100 + 100 두 번 → 두 건 모두 집계되어 총 200 (임의 중복 제거 없음)', async () => {
  const t = await startApp();
  const { sessionCookie } = await oauthLogin(t);
  const { core, sdk } = await startConnector(t, sessionCookie);

  sdk().emit('BALLOON_GIFTED', balloon({ count: 100 }));
  sdk().emit('BALLOON_GIFTED', balloon({ count: 100 }));
  await waitIdle(core);

  const donor = await donorOf(t, '홍길동');
  assert.equal(donor.total, 200);
  assert.equal(donor.tickets, 2);
  const counted = (await t.adminState()).recentDonations.filter((d) => d.status === 'COUNTED');
  assert.equal(counted.length, 2);
});

test('VOD 별풍선은 제외', async () => {
  const t = await startApp();
  const { sessionCookie } = await oauthLogin(t);
  const { core, sdk } = await startConnector(t, sessionCookie);

  sdk().emit('BALLOON_GIFTED', balloon({ count: 500, fromVod: true, relaysBroad: false }));
  await waitIdle(core);

  const state = await t.adminState();
  assert.equal(state.event.currentAmount, 0);
  assert.equal(state.recentDonations.length, 0);
  assert.equal(core.recent[0].result, 'EXCLUDED');
});

test('중계방(relay) 별풍선은 제외', async () => {
  const t = await startApp();
  const { sessionCookie } = await oauthLogin(t);
  const { core, sdk } = await startConnector(t, sessionCookie);

  sdk().emit('BALLOON_GIFTED', balloon({ count: 300, relaysBroad: true }));
  await waitIdle(core);

  assert.equal((await t.adminState()).event.currentAmount, 0);
  assert.equal(core.recent[0].result, 'EXCLUDED');
});

test('도전미션 / 대결미션 / 다른 후원 이벤트는 서버로 보내지 않음', async () => {
  const t = await startApp();
  const { sessionCookie } = await oauthLogin(t);
  const { core, sdk } = await startConnector(t, sessionCookie);

  sdk().emit('CHALLENGE_MISSION_GIFTED', { userId: 'fan01', userNickname: '홍길동', count: 100, relaysBroad: false });
  sdk().emit('BATTLE_MISSION_GIFTED', { userId: 'fan01', userNickname: '홍길동', count: 100, relaysBroad: false });
  sdk().emit('ADBALLOON_GIFTED', { userId: 'fan01', userNickname: '홍길동', count: 100 });
  sdk().emit('MESSAGE', { userId: 'fan01', message: '안녕하세요' });
  await waitIdle(core);

  assert.equal(core.recent.length, 0);
  assert.equal((await t.adminState()).event.currentAmount, 0);
});

test('목표 달성 이후 들어온 별풍선은 기존 규칙대로 IGNORED (게이지/응모권 미반영)', async () => {
  const t = await startApp({ target: 100 });
  const { sessionCookie } = await oauthLogin(t);
  const { core, sdk } = await startConnector(t, sessionCookie);

  sdk().emit('BALLOON_GIFTED', balloon({ userId: 'fan01', userNickname: '홍길동', count: 100 }));
  sdk().emit('BALLOON_GIFTED', balloon({ userId: 'fan02', userNickname: '김철수', count: 50 }));
  await waitIdle(core);

  const state = await t.adminState();
  assert.equal(state.event.status, 'BOX_OPENING');
  assert.equal(state.event.currentAmount, 100);
  const late = state.recentDonations.find((d) => d.nickname === '김철수');
  assert.equal(late.status, 'IGNORED');
  assert.equal(core.recent[0].result, 'IGNORED');
  assert.equal(core.recent[1].result, 'COUNTED');
});

// ---------------- 인증 ----------------

test('인증되지 않은 donation API 호출은 거절 (쿠키 없음 / 위조 쿠키 / 관리자 토큰만으로도 불가)', async () => {
  const t = await startApp();
  await oauthLogin(t); // 다른 브라우저에 정상 세션이 있어도

  const body = { message: balloon(), clientEventId: 'fake-1' };
  assert.equal((await t.call('POST', '/api/soop/balloon', { body })).status, 401);
  assert.equal((await t.call('POST', '/api/soop/balloon', { body, headers: { Cookie: 'soop_connector=forged' } })).status, 401);
  assert.equal((await t.call('POST', '/api/soop/balloon', { body, headers: ADMIN })).status, 401);
  assert.equal((await t.call('POST', '/api/soop/status', { body: { sdkState: 'CONNECTED' } })).status, 401);
  assert.equal((await t.call('POST', '/api/soop/token/refresh')).status, 401);
  assert.equal((await t.adminState()).event.currentAmount, 0);
});

test('정상 OAuth 세션의 donation API 호출 성공, 같은 수신 건(clientEventId) 재전송은 1번만 반영', async () => {
  const t = await startApp();
  const { sessionCookie } = await oauthLogin(t);
  const body = { action: 'BALLOON_GIFTED', message: balloon({ count: 70 }), clientEventId: 'evt-1' };

  const first = await t.call('POST', '/api/soop/balloon', { body, headers: { Cookie: sessionCookie } });
  assert.equal(first.status, 200);
  assert.equal(first.data.result, 'COUNTED');

  const retry = await t.call('POST', '/api/soop/balloon', { body, headers: { Cookie: sessionCookie } });
  assert.equal(retry.data.result, 'DUPLICATE');
  assert.equal((await t.adminState()).event.currentAmount, 70);
});

test('새로 OAuth 연결하면 이전 세션은 무효, 연결 끊기(logout) 후에도 무효', async () => {
  const t = await startApp();
  const { sessionCookie: oldCookie } = await oauthLogin(t, { code: 'c1' });
  const { sessionCookie: newCookie } = await oauthLogin(t, { code: 'c2' });
  const body = { message: balloon(), clientEventId: 'e' };
  assert.equal((await t.call('POST', '/api/soop/balloon', { body, headers: { Cookie: oldCookie } })).status, 401);

  await t.call('POST', '/api/soop/logout', { headers: { Cookie: newCookie } });
  assert.equal((await t.call('POST', '/api/soop/balloon', { body, headers: { Cookie: newCookie } })).status, 401);
});

test('SOOP_BJ_ID가 설정되면 다른 방송인의 별풍선은 제외', async () => {
  const t = await startApp({
    soopConfig: { clientId: 'test-client-id', clientSecret: 'test-client-secret', allowedBjId: BJ_ID, oauthBase: fakeSoopBase },
  });
  const { sessionCookie } = await oauthLogin(t);
  const { core, sdk } = await startConnector(t, sessionCookie, { bjId: 'someone-else' });

  sdk().emit('BALLOON_GIFTED', balloon({ bjId: 'someone-else' }));
  await waitIdle(core);
  assert.equal((await t.adminState()).event.currentAmount, 0);
  assert.equal(core.recent[0].result, 'EXCLUDED');
  assert.match(core.lastError, /SOOP_BJ_ID/);
});

// ---------------- 장애 격리 ----------------

test('SOOP 연결 실패(토큰 발급 실패 / Chat SDK 접속 실패 / 미설정)여도 선물상자는 정상', async () => {
  // 1) 토큰 발급 실패
  const t = await startApp();
  fakeSoopState.mode = 'fail';
  const { callback, sessionCookie } = await oauthLogin(t);
  assert.equal(callback.status, 400);
  assert.equal(sessionCookie, null);

  // 2) Chat SDK 접속 실패
  fakeSoopState.mode = 'ok';
  const { sessionCookie: okCookie } = await oauthLogin(t, { code: 'c2' });
  const { core } = await startConnector(t, okCookie, { failConnect: true });
  assert.equal(core.sdkState, 'ERROR');
  assert.match(core.lastError, /mock connect failure/);

  // 선물상자: 테스트 후원 / 수동 후원 / 오버레이 / 공개 상태 모두 정상
  const testDonation = await t.call('POST', '/api/gift/admin/donations', { headers: ADMIN, body: { nickname: '테스트1', type: 'STAR', amount: 100, test: true } });
  assert.equal(testDonation.status, 200);
  assert.equal(testDonation.data.result, 'COUNTED');
  const manual = await t.call('POST', '/api/gift/admin/donations', { headers: ADMIN, body: { nickname: '수동', type: 'STAR', amount: 50 } });
  assert.equal(manual.data.result, 'COUNTED');
  assert.equal((await t.call('GET', '/overlay')).status, 200);
  assert.equal((await t.call('GET', '/api/gift/state')).data.event.currentAmount, 150);

  const status = await t.call('GET', '/api/soop/admin/status', { headers: ADMIN });
  assert.equal(status.data.oauth, 'CONNECTED');
  assert.equal(status.data.sdkState, 'ERROR');
  assert.match(status.data.lastError.message, /mock connect failure/);
});

test('SOOP 설정이 없어도 선물상자 정상, 연동 API는 꺼진 상태로 응답', async () => {
  const t = await startApp({ soopConfig: { clientId: '', clientSecret: '', allowedBjId: '', oauthBase: fakeSoopBase } });
  const status = await t.call('GET', '/api/soop/admin/status', { headers: ADMIN });
  assert.equal(status.data.configured, false);
  assert.equal((await t.call('GET', '/soop-connector/login', { headers: ADMIN })).status, 400);
  assert.equal((await t.call('POST', '/api/soop/balloon', { body: { message: balloon() } })).status, 401);
  const donation = await t.call('POST', '/api/gift/admin/donations', { headers: ADMIN, body: { nickname: 'A', type: 'STAR', amount: 10 } });
  assert.equal(donation.data.result, 'COUNTED');
});

test('선물상자 DB 장애 중 받은 별풍선은 503 → 커넥터가 같은 clientEventId로 재시도해 DB 복구 후 1번만 반영', async () => {
  let failures = 2;
  const flaky = { ...database, exec: (sql) => (failures-- > 0 ? Promise.reject(new Error('connect ECONNREFUSED (테스트)')) : database.exec(sql)) };
  const t = await startApp({ database: flaky });
  const { sessionCookie } = await oauthLogin(t);

  const api = connectorApi(t, sessionCookie);
  const sent = [];
  const postBalloon = api.postBalloon;
  api.postBalloon = (body) => {
    sent.push(body.clientEventId);
    return postBalloon(body);
  };
  const core = new SoopConnectorCore({
    api,
    createSdk: (clientId) => new MockChatSdk(clientId),
    retryDelaysMs: [600000], // 자동 재시도 타이머 대신 아래에서 직접 재시도를 실행합니다. (시점 고정)
    reconnectDelaysMs: [600000],
  });
  cleanups.push(() => core.stopAll());
  await core.loadSession();
  await core.connect();
  core.sdk.emit('BALLOON_GIFTED', balloon({ count: 100 }));
  for (let i = 0; i < 100 && core.sending; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(core.queue.length, 1, 'DB 장애 중에는 대기열에 남아 있어야 함');
  assert.match(core.lastError, /재시도/);

  for (let i = 0; i < 100 && !t.gift.runtime.giftService; i += 1) await new Promise((r) => setTimeout(r, 20));
  await t.call('PUT', '/api/gift/admin/settings', { headers: ADMIN, body: { targetAmount: 1000 } });
  await t.call('PUT', '/api/gift/admin/prizes', { headers: ADMIN, body: { prizes: [{ name: '치킨', quantity: 1 }] } });
  await t.call('POST', '/api/gift/admin/start', { headers: ADMIN });

  await core.flush(); // 재시도 타이머가 울린 것과 같은 동작
  await waitIdle(core);

  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1], '재시도는 같은 clientEventId로 보내야 함');
  const state = await t.adminState();
  assert.equal(state.event.currentAmount, 100);
  assert.equal(state.recentDonations.length, 1);
});

test('관리자 화면용 상태: OAuth / Chat SDK / 최근 별풍선 표시, 관리자만 조회 가능', async () => {
  const t = await startApp();
  assert.equal((await t.call('GET', '/api/soop/admin/status')).status, 401);

  const { sessionCookie } = await oauthLogin(t);
  const { core, sdk } = await startConnector(t, sessionCookie);
  sdk().emit('JOIN', { userId: BJ_ID, userNickname: '워니' });
  sdk().emit('BALLOON_GIFTED', balloon({ userNickname: '홍길동', count: 100 }));
  await waitIdle(core);
  await core.reportStatus();

  const { data } = await t.call('GET', '/api/soop/admin/status', { headers: ADMIN });
  assert.equal(data.configured, true);
  assert.equal(data.oauth, 'CONNECTED');
  assert.equal(data.sdkState, 'CONNECTED');
  assert.equal(data.bjId, BJ_ID);
  assert.equal(data.bjNickname, '워니');
  assert.equal(data.lastBalloon.nickname, '홍길동');
  assert.equal(data.lastBalloon.count, 100);
  assert.equal(data.lastBalloon.result, 'COUNTED');
  assert.ok(!JSON.stringify(data).includes('access-1'), '관리자 상태에 토큰이 노출되면 안 됨');
});
