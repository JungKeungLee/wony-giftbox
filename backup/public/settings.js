// public/settings.js
// "스트리머 설정 화면"(settings.html)에서만 쓰이는 코드입니다.
// 1) SOOP 공식 Chat SDK로 OAuth 로그인 → 실시간 채팅 연결 → 도전미션 후원 이벤트 수신
// 2) 테스트 후원 추가
// 3) 순위 초기화
// 4) 현재 설정 값 확인
// 을 모두 이 화면에서 담당합니다. 여기서 다루는 값(Client Secret, Access Token)은
// 공개 송출 화면(broadcast.html)에는 절대 전달되지 않습니다.

const OPERATOR_KEY_STORAGE = 'soopOperatorToken';

const operatorKeyFormEl = document.getElementById('operatorKeyForm');
const operatorKeyInputEl = document.getElementById('operatorKeyInput');
const operatorKeySaveEl = document.getElementById('operatorKeySave');
const connectErrorBannerEl = document.getElementById('connectErrorBanner');
const sdkStatusEl = document.getElementById('sdkStatus');
const connectionStatusEl = document.getElementById('connectionStatus');
const loginButtonEl = document.getElementById('loginButton');
const eventLogEl = document.getElementById('eventLog');
const eventLogEmptyEl = document.getElementById('eventLogEmpty');
const resetButtonEl = document.getElementById('resetButton');
const testFormEl = document.getElementById('testForm');
const testNicknameEl = document.getElementById('testNickname');
const testCountEl = document.getElementById('testCount');
const settingTopNEl = document.getElementById('settingTopN');
const settingClientIdEl = document.getElementById('settingClientId');

let currentConnectedState = false;
let currentErrorMessage = null;

// ---- 운영자 키 저장/조회 (이 브라우저에만 저장되고 서버로는 헤더로만 전달됩니다) ----
function getOperatorKey() {
  return localStorage.getItem(OPERATOR_KEY_STORAGE) || '';
}

function saveOperatorKey(key) {
  localStorage.setItem(OPERATOR_KEY_STORAGE, key);
}

// 운영자 API를 호출할 때 항상 X-Operator-Token 헤더를 붙여주는 fetch 래퍼입니다.
// 순위 초기화, 테스트 후원, SOOP 연결 관련 API는 모두 이 함수로 호출해야 합니다.
async function operatorFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'X-Operator-Token': getOperatorKey(),
    },
  });
  return res;
}

// ---- 화면 표시 도우미 함수들 ----
function showConnectError(message) {
  currentErrorMessage = message;
  connectErrorBannerEl.hidden = false;
  connectErrorBannerEl.textContent = `⚠️ ${message}`;
  reportStatus();
}

function clearConnectError() {
  currentErrorMessage = null;
  connectErrorBannerEl.hidden = true;
}

function setConnectionStatus(connected) {
  currentConnectedState = connected;
  connectionStatusEl.textContent = connected ? '🟢 연결됨' : '🔴 연결 안됨';
  reportStatus();
}

function appendEventLog(action, message) {
  eventLogEmptyEl.hidden = true;
  const li = document.createElement('li');
  li.className = 'rank-item';
  const time = new Date().toLocaleTimeString('ko-KR');
  li.innerHTML = `<span class="rank-nickname">[${time}] ${action}</span><span class="rank-count">${JSON.stringify(message)}</span>`;
  eventLogEl.prepend(li);
  // 로그가 너무 길어지지 않도록 최근 50개만 유지합니다.
  while (eventLogEl.children.length > 50) {
    eventLogEl.removeChild(eventLogEl.lastChild);
  }
}

// 서버(/api/operator/status)에 지금 연결 상태를 알려줍니다. 공개 화면(broadcast.html)의 상태 배지가 이 값을 봅니다.
async function reportStatus(eventReceived = false) {
  try {
    await operatorFetch('/api/operator/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connected: currentConnectedState,
        error: currentErrorMessage,
        eventReceived,
      }),
    });
  } catch (error) {
    console.error('상태 보고에 실패했습니다.', error);
  }
}

// 후원 1건을 서버에 저장합니다. (도전미션 실이벤트 전달과 테스트 후원 둘 다 여기로 모입니다)
// 순위 초기화/후원 등록 API는 운영자 키로 보호되므로 operatorFetch로 호출합니다.
async function saveDonation({ userId, userNickname, count, isTest }) {
  await operatorFetch('/api/donations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, userNickname, count, isTest }),
  });
}

// ---- SOOP Chat SDK 연결 ----
function connectWithToken(config, accessToken) {
  const chat = new window.SOOP.ChatSDK(config.clientId, config.clientSecret);

  chat.init();
  chat.setAuth(accessToken);

  chat.connect()
    .then((res) => {
      console.log('[SOOP] 채팅 연결 성공 (chat.connect resolved):', res);
      clearConnectError();
      setConnectionStatus(true);
    })
    .catch((error) => {
      console.error('[SOOP] 연결 실패:', error);
      setConnectionStatus(false);
      showConnectError(`SOOP 채팅 연결에 실패했습니다: ${error && error.message ? error.message : error}`);
    });

  // 요청사항: CHALLENGE_MISSION_GIFTED가 실제로 수신되는지 로그로 확인
  chat.handleMessageReceived((action, message) => {
    console.log('[SOOP] 이벤트 수신 action =', action, message);
    appendEventLog(action, message);

    if (action !== 'CHALLENGE_MISSION_GIFTED') {
      return;
    }

    console.log('[SOOP] CHALLENGE_MISSION_GIFTED 수신 확인 →', message);
    reportStatus(true);

    const { userId, userNickname, count } = message;
    saveDonation({ userId, userNickname, count, isTest: false }).catch((error) => {
      console.error('후원 저장에 실패했습니다.', error);
    });
  });

  chat.handleError((code, message) => {
    console.error('[SOOP] Chat SDK 오류:', code, message);
    setConnectionStatus(false);
    showConnectError(`SOOP Chat SDK 오류 (${code}): ${message}`);
  });

  chat.handleChatClosed(() => {
    console.warn('[SOOP] 채팅 연결이 종료되었습니다.');
    setConnectionStatus(false);
    showConnectError('SOOP 채팅 연결이 종료되었습니다. 다시 로그인해주세요.');
  });
}

// OAuth 로그인 후 SOOP이 돌려준 code로 Access Token을 발급받습니다.
async function handleOAuthRedirect(config, code) {
  const chat = new window.SOOP.ChatSDK(config.clientId, config.clientSecret);
  chat.init();

  try {
    const tokens = await chat.getAuth(code);
    await operatorFetch('/api/operator/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token }),
    });

    // 주소창에서 ?code=... 를 지워서, 새로고침해도 같은 code로 재시도하지 않도록 합니다.
    const url = new URL(window.location.href);
    url.searchParams.delete('code');
    window.history.replaceState({}, '', url.toString());

    connectWithToken(config, tokens.access_token);
  } catch (error) {
    console.error('[SOOP] 로그인 처리 실패:', error);
    showConnectError(`SOOP 로그인 처리 중 오류가 발생했습니다: ${error && error.message ? error.message : error}`);
  }
}

// ---- 순위 초기화 / 테스트 후원 ----
resetButtonEl.addEventListener('click', async () => {
  const confirmed = window.confirm('정말 새 도전미션을 시작할까요?\n기존 순위표가 모두 초기화됩니다.');
  if (!confirmed) return;

  const res = await operatorFetch('/api/reset', { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(`초기화에 실패했습니다: ${body.error || res.status}`);
  }
});

testFormEl.addEventListener('submit', async (event) => {
  event.preventDefault();

  const userNickname = testNicknameEl.value.trim();
  const count = Number(testCountEl.value);

  if (!userNickname || !count || count <= 0) {
    alert('닉네임과 1 이상의 별풍선 개수를 입력해주세요.');
    return;
  }

  const res = await operatorFetch('/api/donations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userNickname, count, isTest: true }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(`테스트 후원 추가에 실패했습니다: ${body.error || res.status}`);
    return;
  }

  testNicknameEl.value = '';
  testCountEl.value = '';
  testNicknameEl.focus();
});

// ---- 초기화 흐름 ----
async function init() {
  const savedKey = getOperatorKey();
  if (savedKey) {
    operatorKeyInputEl.value = savedKey;
    operatorKeyFormEl.hidden = true;
  }

  // 공개 설정(TOP_N)은 운영자 키 없이도 조회할 수 있으므로 먼저 채워둡니다.
  try {
    const res = await fetch('/api/config');
    const publicConfig = await res.json();
    settingTopNEl.textContent = publicConfig.topN;
  } catch (error) {
    console.warn('공개 설정을 가져오지 못했습니다.', error);
  }

  if (window.__soopSdkLoadFailed) {
    sdkStatusEl.textContent = '❌ 로드 실패';
    showConnectError('SOOP Chat SDK 스크립트를 불러오지 못했습니다. 네트워크 연결을 확인해주세요.');
    return;
  }

  if (typeof window.SOOP?.ChatSDK === 'undefined') {
    sdkStatusEl.textContent = '❌ 없음';
    showConnectError('window.SOOP.ChatSDK를 찾을 수 없습니다. SDK 스크립트가 로드될 때까지 기다려주세요.');
    return;
  }
  sdkStatusEl.textContent = '✅ 로드됨';

  if (!savedKey) {
    // 운영자 키가 없으면 여기서 멈추고, 사용자가 입력하고 저장하기를 기다립니다.
    return;
  }

  let config;
  try {
    const res = await operatorFetch('/api/operator/config');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    config = await res.json();
    settingClientIdEl.textContent = config.clientId || '(설정 안 됨)';
  } catch (error) {
    showConnectError(`운영자 설정을 가져오지 못했습니다: ${error.message}`);
    return;
  }

  if (!config.clientId || !config.clientSecret) {
    showConnectError('.env에 SOOP_CLIENT_ID / SOOP_CLIENT_SECRET이 설정되어 있지 않습니다.');
    return;
  }

  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');

  if (code) {
    // SOOP 로그인 후 돌아온 경우
    await handleOAuthRedirect(config, code);
    return;
  }

  // 이전에 로그인해서 저장해둔 토큰이 있으면, 다시 로그인하지 않고 그 토큰으로 재연결을 시도합니다.
  try {
    const res = await operatorFetch('/api/operator/token');
    const saved = await res.json();
    if (saved && saved.accessToken) {
      connectWithToken(config, saved.accessToken);
      return;
    }
  } catch (error) {
    console.warn('저장된 토큰을 확인하지 못했습니다.', error);
  }

  // 저장된 토큰도 없으면 로그인 버튼을 보여줍니다.
  loginButtonEl.hidden = false;
  loginButtonEl.onclick = () => {
    const chat = new window.SOOP.ChatSDK(config.clientId, config.clientSecret);
    chat.init();
    chat.openAuth(); // SOOP 로그인/동의 페이지로 이동한 뒤, 완료되면 이 페이지의 redirect_uri로 돌아옵니다.
  };
}

operatorKeySaveEl.addEventListener('click', () => {
  const key = operatorKeyInputEl.value.trim();
  if (!key) {
    alert('운영자 키를 입력해주세요.');
    return;
  }
  saveOperatorKey(key);
  operatorKeyFormEl.hidden = true;
  init();
});

// 15초마다 서버에 현재 연결 상태를 알려서, 공개 화면의 "실시간 연결됨" 표시가 정확하게 유지되도록 합니다.
setInterval(() => {
  if (getOperatorKey()) {
    reportStatus();
  }
}, 15000);

init();
