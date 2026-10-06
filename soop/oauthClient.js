// soop/oauthClient.js
// SOOP 공식 OpenAPI 인증(서버 전용)입니다. Client Secret은 이 파일에서만 사용하고 브라우저로 보내지 않습니다.
//
// 공식 문서(SOOP Developers > OpenAPI > 인증):
//   인증 코드 발급: GET  https://openapi.sooplive.com/auth/code?client_id=...
//                   (미리 등록한 Redirect URI로 ?code=... 가 전달됨, code는 1회용)
//   토큰 발급:      POST https://openapi.sooplive.com/auth/token
//                   grant_type=authorization_code, client_id, client_secret, code
//   토큰 재발급:    POST https://openapi.sooplive.com/auth/token
//                   grant_type=refresh_token, client_id, client_secret, refresh_token
//   응답: { access_token, expires_in(초), token_type: "Bearer", scope, refresh_token }
//
// response_type=code 는 공식 Chat SDK의 openAuth()가 붙이는 값과 같게 맞춘 것입니다.
// state 는 문서에 없는 파라미터입니다. SOOP가 돌려주면 검증하고, 돌려주지 않아도 쿠키로 요청을 묶어 검증합니다.

const DEFAULT_OAUTH_BASE = 'https://openapi.sooplive.com';
const REQUEST_TIMEOUT_MS = 10000;

class SoopOAuthError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'SoopOAuthError';
    this.status = status;
  }
}

function createOAuthClient({ clientId, clientSecret, oauthBase = DEFAULT_OAUTH_BASE, fetchImpl = fetch }) {
  const base = oauthBase.replace(/\/+$/, '');

  function authorizeUrl(state) {
    const params = new URLSearchParams({ client_id: clientId, response_type: 'code' });
    if (state) params.set('state', state);
    return `${base}/auth/code?${params}`;
  }

  async function requestToken(params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(`${base}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }).toString(),
        signal: controller.signal,
      });
    } catch (error) {
      throw new SoopOAuthError(`SOOP 토큰 서버에 연결하지 못했습니다: ${error.message}`, 502);
    } finally {
      clearTimeout(timer);
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      const reason = data.error_description || data.message || data.error || `HTTP ${res.status}`;
      throw new SoopOAuthError(`SOOP 토큰 발급 실패: ${reason}`, res.ok ? 502 : res.status);
    }
    const expiresIn = Number(data.expires_in);
    return {
      accessToken: String(data.access_token),
      refreshToken: data.refresh_token ? String(data.refresh_token) : null,
      expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null,
      scope: data.scope ?? null,
    };
  }

  return {
    authorizeUrl,
    exchangeCode: (code) => requestToken({ grant_type: 'authorization_code', code }),
    refresh: (refreshToken) => requestToken({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  };
}

module.exports = { createOAuthClient, SoopOAuthError, DEFAULT_OAUTH_BASE };
