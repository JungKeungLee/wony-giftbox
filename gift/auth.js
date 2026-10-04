// gift/auth.js
// 관리자 인증입니다. 현재 프로젝트에는 로그인 기능이 없어서, backup/ 버전에서 쓰던
// OPERATOR_TOKEN(.env) 방식을 그대로 이어받아 쓰도록 만들었습니다.
//
// - 브라우저(/admin): 로그인 화면에서 OPERATOR_TOKEN을 입력하면 HttpOnly 쿠키를 발급합니다.
//   쿠키 값은 토큰 원문이 아니라 HMAC 서명값이라, 쿠키가 노출돼도 토큰 원문은 알 수 없습니다.
//   SameSite=Strict라서 다른 사이트에서 관리자 API를 몰래 호출(CSRF)할 수 없습니다.
// - 외부 연동/스크립트: X-Operator-Token 헤더에 토큰을 넣어 호출할 수도 있습니다. (backup과 동일한 헤더)
//
// OBS 오버레이(/overlay)는 이 인증을 거치지 않는 "조회 전용" API만 사용하므로
// 오버레이 주소를 알아도 후원 등록/초기화/룰렛 실행은 할 수 없습니다.

const crypto = require('crypto');

const COOKIE_NAME = 'gift_admin';
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30일

// 로그인 실패가 너무 많으면 잠시 막습니다. (무차별 대입 방지)
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map(); // ip -> { count, firstAt }

function getOperatorToken() {
  return process.env.OPERATOR_TOKEN || '';
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// 토큰이 바뀌면 기존 쿠키는 자동으로 무효가 됩니다.
function sessionValue(token) {
  return crypto.createHmac('sha256', token).update('gift-admin-session-v1').digest('hex');
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function isAdminRequest(req) {
  const token = getOperatorToken();
  if (!token) return false;
  const headerToken = req.get('X-Operator-Token');
  if (headerToken && safeEqual(headerToken, token)) return true;
  const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME];
  return Boolean(cookie) && safeEqual(cookie, sessionValue(token));
}

// 관리자 API 보호 미들웨어
function requireAdmin(req, res, next) {
  if (!getOperatorToken()) {
    return res.status(503).json({ error: '서버 .env에 OPERATOR_TOKEN이 설정되어 있지 않아 관리자 기능이 꺼져 있습니다.' });
  }
  if (!isAdminRequest(req)) {
    return res.status(401).json({ error: '관리자 인증이 필요합니다.' });
  }
  next();
}

function setSessionCookie(req, res) {
  const parts = [
    `${COOKIE_NAME}=${sessionValue(getOperatorToken())}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${COOKIE_MAX_AGE_SEC}`,
  ];
  if (req.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

// POST /api/gift/admin/login { token }
function handleLogin(req, res) {
  const expected = getOperatorToken();
  if (!expected) {
    return res.status(503).json({ error: '서버 .env에 OPERATOR_TOKEN을 먼저 설정해주세요.' });
  }

  const ip = req.ip || 'unknown';
  const now = Date.now();
  const record = loginFailures.get(ip);
  if (record && now - record.firstAt > LOGIN_WINDOW_MS) loginFailures.delete(ip);
  const current = loginFailures.get(ip);
  if (current && current.count >= LOGIN_MAX_FAILURES) {
    return res.status(429).json({ error: '로그인 실패가 너무 많습니다. 10분 후 다시 시도해주세요.' });
  }

  const provided = String((req.body && req.body.token) || '');
  if (!safeEqual(provided, expected)) {
    const next = current || { count: 0, firstAt: now };
    next.count += 1;
    loginFailures.set(ip, next);
    return res.status(401).json({ error: '운영자 키가 올바르지 않습니다.' });
  }

  loginFailures.delete(ip);
  setSessionCookie(req, res);
  res.json({ ok: true });
}

function handleLogout(req, res) {
  clearSessionCookie(res);
  res.json({ ok: true });
}

module.exports = { requireAdmin, isAdminRequest, handleLogin, handleLogout, getOperatorToken };
