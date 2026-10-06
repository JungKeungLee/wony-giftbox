// soop/index.js
// SOOP 공식 OAuth + 공식 Chat SDK(브라우저) 연동 진입점입니다. server.js에서 mountSoopConnector(app, ...)로 붙입니다.
//
// 흐름:
//   방송인 브라우저 /soop-connector (관리자 로그인 필요)
//     → /soop-connector/login: state 생성 후 SOOP 인증 페이지(auth/code)로 이동
//     → /soop-connector/callback?code=..: 서버가 Client Secret으로 토큰 발급 (Secret은 브라우저로 가지 않음)
//     → 커넥터 세션 쿠키(HttpOnly) 발급, 페이지가 Access Token으로 공식 Chat SDK에 접속
//     → BALLOON_GIFTED 수신 시 POST /api/soop/balloon (세션 쿠키 인증)
//     → 기존 DonationService.receive() → GiftEventService → PostgreSQL → /overlay
//
// 이 모듈은 선물상자 DB/서비스와 독립적으로 동작합니다. SOOP 설정이 없거나 연동이 실패해도
// /admin, /overlay, 테스트·수동 후원, 룰렛, 회차 기록에는 영향을 주지 않습니다.
//
// [관리자 로그인 필요]
//   GET  /soop-connector                 커넥터 화면 (미인증이면 관리자 로그인 화면)
//   GET  /soop-connector-assets/*        커넥터 JS/CSS
//   GET  /soop-connector/login           SOOP OAuth 시작
//   GET  /api/soop/admin/status          관리자 화면용 연동 상태
// [SOOP 인증 콜백]
//   GET  /soop-connector/callback        OAuth 콜백 (state 검증 → 토큰 발급 → 세션 발급)
// [커넥터 세션 쿠키 필요]
//   GET  /api/soop/session               연결 상태 + Chat SDK용 Access Token
//   POST /api/soop/token/refresh         Access Token 재발급 (서버가 Refresh Token 사용)
//   POST /api/soop/status                Chat SDK 상태 보고(하트비트) { sdkState, bjId, bjNickname, error }
//   POST /api/soop/balloon               별풍선 1건 전달 { message, clientEventId }
//   POST /api/soop/logout                SOOP 계정 연결 해제 (서버 세션 삭제)

const crypto = require('crypto');
const path = require('path');
const express = require('express');

const { isAdminRequest, requireAdmin } = require('../gift/auth');
const { GiftError } = require('../gift/giftEventService');
const { createOAuthClient, SoopOAuthError, DEFAULT_OAUTH_BASE } = require('./oauthClient');
const { balloonToDonation, SOURCE, EXCLUDE_REASONS } = require('./balloon');

const CONNECTOR_DIR = path.join(__dirname, 'connector');
const LOGIN_PAGE = path.join(__dirname, '..', 'gift', 'admin', 'login.html');

const STATE_COOKIE = 'soop_oauth_state';
const SESSION_COOKIE = 'soop_connector';
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_STATES = 20;
const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000; // 마지막 사용 후 7일이 지나면 다시 연결
const HEARTBEAT_STALE_MS = 45 * 1000;
const RECENT_LIMIT = 20;
const SDK_STATES = ['IDLE', 'CONNECTING', 'CONNECTED', 'DISCONNECTED', 'ERROR'];

function readConfig(env = process.env) {
  return {
    clientId: (env.SOOP_CLIENT_ID || '').trim(),
    clientSecret: (env.SOOP_CLIENT_SECRET || '').trim(),
    allowedBjId: (env.SOOP_BJ_ID || '').trim(),
    oauthBase: (env.SOOP_OAUTH_BASE || '').trim() || DEFAULT_OAUTH_BASE,
  };
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function cookie(req, name, value, { maxAgeSec, sameSite, cookiePath = '/' }) {
  const parts = [`${name}=${value}`, `Path=${cookiePath}`, 'HttpOnly', `SameSite=${sameSite}`, `Max-Age=${maxAgeSec}`];
  if (req.secure) parts.push('Secure');
  return parts.join('; ');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

// 콜백은 SOOP에서 넘어오는 "다른 사이트발" 이동이라 SameSite=Strict 쿠키(관리자 로그인)가 붙지 않습니다.
// 그래서 결과를 HTML로 보여주고, 이 페이지에서 /soop-connector로 다시 이동해 관리자 쿠키가 정상적으로 붙게 합니다.
function callbackPage(res, { ok, message }) {
  res.set('Cache-Control', 'no-store');
  res.status(ok ? 200 : 400).type('html').send(`<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" /><title>SOOP 계정 연결</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:#0b0b0e;color:#f5f1e6;font-family:'Malgun Gothic',sans-serif}
main{max-width:420px;padding:28px;border-radius:16px;background:#15151a;border:1px solid rgba(232,191,106,.35);text-align:center;line-height:1.6}
a{color:#e8bf6a}</style></head>
<body><main><h1 style="font-size:20px">${ok ? 'SOOP 계정 연결 완료' : 'SOOP 계정 연결 실패'}</h1>
<p>${escapeHtml(message)}</p><p><a href="/soop-connector" id="back">커넥터 화면으로 돌아가기</a></p></main>
${ok ? '<script>location.replace("/soop-connector");</script>' : ''}
</body></html>`);
}

function noStore(res) {
  res.set('Cache-Control', 'no-store');
}

// options.getDonationService: () => DonationService | null  (선물상자 DB가 준비되기 전에는 null)
// options.config / options.fetchImpl / options.now: 테스트용
function mountSoopConnector(app, options = {}) {
  const config = options.config || readConfig();
  const now = options.now || (() => Date.now());
  const configured = Boolean(config.clientId && config.clientSecret);
  const oauth = configured
    ? createOAuthClient({ ...config, fetchImpl: options.fetchImpl || fetch })
    : null;
  const getDonationService = options.getDonationService || (() => null);

  const pendingStates = new Map(); // state -> createdAt
  let session = null; // 방송인 1명만 연결합니다. 새로 연결하면 이전 세션은 무효가 됩니다.
  const status = {
    sdkState: 'IDLE',
    bjId: null,
    bjNickname: null,
    lastHeartbeatAt: null,
    lastError: null,
    recent: [],
  };

  function resetStatus() {
    Object.assign(status, { sdkState: 'IDLE', bjId: null, bjNickname: null, lastHeartbeatAt: null });
  }

  function recordError(message) {
    status.lastError = { message: String(message).slice(0, 300), at: new Date(now()).toISOString() };
  }

  function prunePendingStates() {
    for (const [state, createdAt] of pendingStates) {
      if (now() - createdAt > STATE_TTL_MS) pendingStates.delete(state);
    }
    while (pendingStates.size > MAX_PENDING_STATES) pendingStates.delete(pendingStates.keys().next().value);
  }

  function currentSession(req) {
    if (!session) return null;
    const value = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!value || !safeEqual(value, session.id)) return null;
    if (now() - session.lastSeenAt > SESSION_IDLE_MS) {
      session = null;
      resetStatus();
      return null;
    }
    session.lastSeenAt = now();
    return session;
  }

  function requireSession(req, res, next) {
    const current = currentSession(req);
    if (!current) {
      return res.status(401).json({ error: 'SOOP 커넥터 세션이 없습니다. /soop-connector에서 SOOP 계정을 연결해주세요.', code: 'NO_SESSION' });
    }
    req.soopSession = current;
    next();
  }

  function sessionView(current) {
    return {
      connected: true,
      clientId: config.clientId,
      accessToken: current.accessToken,
      accessTokenExpiresAt: current.accessExpiresAt ? new Date(current.accessExpiresAt).toISOString() : null,
      canRefresh: Boolean(current.refreshToken),
      connectedAt: new Date(current.createdAt).toISOString(),
    };
  }

  function publicStatus() {
    const heartbeatAlive = status.lastHeartbeatAt !== null && now() - status.lastHeartbeatAt <= HEARTBEAT_STALE_MS;
    return {
      configured,
      oauth: session ? 'CONNECTED' : 'DISCONNECTED',
      sdkState: session && heartbeatAlive ? status.sdkState : session ? 'NO_PAGE' : 'IDLE',
      pageAlive: heartbeatAlive,
      bjId: status.bjId,
      bjNickname: status.bjNickname,
      allowedBjId: config.allowedBjId || null,
      lastHeartbeatAt: status.lastHeartbeatAt ? new Date(status.lastHeartbeatAt).toISOString() : null,
      lastBalloon: status.recent.find((item) => item.result !== 'EXCLUDED') || null,
      recent: status.recent,
      lastError: status.lastError,
    };
  }

  function pushRecent(entry) {
    status.recent.unshift({ ...entry, at: new Date(now()).toISOString() });
    status.recent.length = Math.min(status.recent.length, RECENT_LIMIT);
  }

  const router = express.Router();

  // ---------------- 커넥터 화면 ----------------
  router.get('/soop-connector', (req, res) => {
    noStore(res);
    res.sendFile(isAdminRequest(req) ? path.join(CONNECTOR_DIR, 'connector.html') : LOGIN_PAGE);
  });
  router.use('/soop-connector-assets', (req, res, next) => {
    if (!isAdminRequest(req)) return res.status(401).send('관리자 인증이 필요합니다.');
    noStore(res);
    next();
  }, express.static(CONNECTOR_DIR, { index: false }));

  // ---------------- OAuth ----------------
  router.get('/soop-connector/login', (req, res) => {
    noStore(res);
    if (!isAdminRequest(req)) return res.redirect(302, '/soop-connector');
    if (!configured) {
      return callbackPage(res, { ok: false, message: '서버 환경변수 SOOP_CLIENT_ID / SOOP_CLIENT_SECRET이 설정되어 있지 않습니다.' });
    }
    prunePendingStates();
    const state = crypto.randomBytes(24).toString('hex');
    pendingStates.set(state, now());
    // SOOP → 우리 서버로 돌아오는 이동은 다른 사이트발 GET이므로 Lax여야 쿠키가 붙습니다.
    res.append('Set-Cookie', cookie(req, STATE_COOKIE, state, { maxAgeSec: STATE_TTL_MS / 1000, sameSite: 'Lax', cookiePath: '/soop-connector' }));
    res.redirect(302, oauth.authorizeUrl(state));
  });

  router.get('/soop-connector/callback', async (req, res) => {
    res.append('Set-Cookie', cookie(req, STATE_COOKIE, '', { maxAgeSec: 0, sameSite: 'Lax', cookiePath: '/soop-connector' }));
    if (!configured) return callbackPage(res, { ok: false, message: 'SOOP 연동 설정이 없습니다.' });

    prunePendingStates();
    const cookieState = parseCookies(req.headers.cookie)[STATE_COOKIE] || '';
    const queryState = typeof req.query.state === 'string' ? req.query.state : '';
    const known = cookieState && pendingStates.has(cookieState);
    if (cookieState) pendingStates.delete(cookieState); // state는 1회용
    // CSRF 방지: 이 브라우저에서 /soop-connector/login으로 시작한 요청이어야 하고,
    // SOOP가 state를 돌려준 경우 그 값도 일치해야 합니다.
    if (!known || (queryState && !safeEqual(queryState, cookieState))) {
      recordError('OAuth state 검증 실패');
      return callbackPage(res, { ok: false, message: '인증 요청을 확인할 수 없습니다(state 불일치 또는 만료). 커넥터 화면에서 다시 연결해주세요.' });
    }
    if (!queryState) {
      console.warn('[soop] OAuth 콜백에 state가 없습니다. (쿠키에 묶인 요청으로 검증)');
    }

    const code = typeof req.query.code === 'string' ? req.query.code.trim() : '';
    if (!code) {
      const reason = req.query.error_description || req.query.error || 'code 없음';
      recordError(`OAuth 실패: ${reason}`);
      return callbackPage(res, { ok: false, message: `SOOP 인증이 완료되지 않았습니다: ${reason}` });
    }

    try {
      const tokens = await oauth.exchangeCode(code);
      session = {
        id: crypto.randomBytes(32).toString('hex'),
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessExpiresAt: tokens.expiresIn ? now() + tokens.expiresIn * 1000 : null,
        createdAt: now(),
        lastSeenAt: now(),
      };
      resetStatus();
      status.lastError = null;
      res.append('Set-Cookie', cookie(req, SESSION_COOKIE, session.id, { maxAgeSec: SESSION_IDLE_MS / 1000, sameSite: 'Strict' }));
      console.log('[soop] SOOP 계정 연결 완료 (OAuth)');
      callbackPage(res, { ok: true, message: '잠시 후 커넥터 화면으로 이동합니다.' });
    } catch (error) {
      recordError(error.message);
      console.error('[soop] 토큰 발급 실패:', error.message);
      callbackPage(res, { ok: false, message: error.message });
    }
  });

  // ---------------- 커넥터 API ----------------
  const api = express.Router();
  api.use(express.json({ limit: '16kb' }));

  api.get('/session', (req, res) => {
    noStore(res);
    const current = currentSession(req);
    if (!current) return res.json({ connected: false, configured, clientId: configured ? config.clientId : null });
    res.json({ configured, ...sessionView(current) });
  });

  api.post('/token/refresh', requireSession, async (req, res) => {
    noStore(res);
    const current = req.soopSession;
    if (!current.refreshToken) {
      return res.status(409).json({ error: 'Refresh Token이 없습니다. SOOP 계정을 다시 연결해주세요.', code: 'NO_REFRESH_TOKEN' });
    }
    try {
      const tokens = await oauth.refresh(current.refreshToken);
      current.accessToken = tokens.accessToken;
      if (tokens.refreshToken) current.refreshToken = tokens.refreshToken;
      current.accessExpiresAt = tokens.expiresIn ? now() + tokens.expiresIn * 1000 : null;
      res.json({ configured, ...sessionView(current) });
    } catch (error) {
      recordError(error.message);
      const status400 = error instanceof SoopOAuthError && error.status >= 400 && error.status < 500;
      if (status400) {
        // 재발급이 거절되면(Refresh Token 만료 등) 세션을 끝내고 다시 연결하도록 안내합니다.
        session = null;
        resetStatus();
        return res.status(401).json({ error: `${error.message} — SOOP 계정을 다시 연결해주세요.`, code: 'REFRESH_REJECTED' });
      }
      res.status(502).json({ error: error.message, code: 'REFRESH_FAILED' });
    }
  });

  api.post('/status', requireSession, (req, res) => {
    const body = req.body || {};
    const sdkState = String(body.sdkState || '').toUpperCase();
    if (SDK_STATES.includes(sdkState)) status.sdkState = sdkState;
    if (body.bjId) status.bjId = String(body.bjId).slice(0, 80);
    if (body.bjNickname) status.bjNickname = String(body.bjNickname).slice(0, 80);
    if (body.error) recordError(`Chat SDK: ${body.error}`);
    status.lastHeartbeatAt = now();
    const bjMismatch = Boolean(config.allowedBjId && status.bjId && status.bjId !== config.allowedBjId);
    res.json({ ok: true, bjMismatch, allowedBjId: config.allowedBjId || null });
  });

  api.post('/balloon', requireSession, async (req, res) => {
    const body = req.body || {};
    const converted = balloonToDonation(body, { bjId: status.bjId, allowedBjId: config.allowedBjId });
    const message = body.message || {};

    if (converted.excluded) {
      pushRecent({
        nickname: String(message.userNickname || message.userId || '-').slice(0, 50),
        count: Number(message.count) || 0,
        result: 'EXCLUDED',
        reason: EXCLUDE_REASONS[converted.excluded],
      });
      return res.json({ result: 'EXCLUDED', reason: converted.excluded, message: EXCLUDE_REASONS[converted.excluded] });
    }

    const donationService = getDonationService();
    if (!donationService) {
      return res.status(503).json({ error: '선물상자 DB가 아직 준비되지 않았습니다. 잠시 후 자동으로 다시 보냅니다.', code: 'DB_NOT_READY' });
    }

    const { donation } = converted;
    try {
      const outcome = await donationService.receive(donation, SOURCE);
      if (outcome.result !== 'DUPLICATE') {
        pushRecent({ nickname: donation.nickname, count: donation.amount, result: outcome.result });
      }
      res.json({ result: outcome.result, donationId: outcome.donationId ?? null, reason: outcome.reason ?? null });
    } catch (error) {
      if (error instanceof GiftError) {
        recordError(`후원 반영 실패: ${error.message}`);
        return res.status(error.httpStatus).json({ error: error.message, code: error.code });
      }
      recordError(`후원 반영 실패: ${error.message}`);
      console.error('[soop] 별풍선 반영 실패:', error);
      res.status(500).json({ error: '서버 오류로 별풍선을 반영하지 못했습니다. 자동으로 다시 보냅니다.' });
    }
  });

  api.post('/logout', (req, res) => {
    if (currentSession(req)) {
      session = null;
      resetStatus();
    }
    res.append('Set-Cookie', cookie(req, SESSION_COOKIE, '', { maxAgeSec: 0, sameSite: 'Strict' }));
    res.json({ ok: true });
  });

  api.get('/admin/status', requireAdmin, (req, res) => {
    noStore(res);
    res.json(publicStatus());
  });

  router.use('/api/soop', api);
  app.use(router);

  if (!configured) {
    console.warn('[soop] ⚠️ SOOP_CLIENT_ID / SOOP_CLIENT_SECRET이 없어 SOOP 공식 별풍선 연동이 꺼져 있습니다. (선물상자 다른 기능은 정상)');
  }

  return { getStatus: publicStatus };
}

module.exports = { mountSoopConnector, readConfig };
