// public/soop.js
// 공개 순위표 화면(index.html)에서 "SOOP 연결 상태 표시"만 담당하는 파일입니다.
//
// [중요] 실제 SOOP Chat SDK 연결(OAuth 로그인, chat.connect(), handleMessageReceived 등)은
// 이 파일이 아니라 별도의 운영자 전용 페이지인 public/connect.html + public/connect.js에서 합니다.
// 그 이유는 SOOP Chat SDK가 브라우저에서 Client Secret / Access Token을 직접 다루기 때문에,
// 시청자 누구나 볼 수 있는 이 공개 화면에는 그런 민감한 값을 절대 두지 않기 위해서입니다.
//
// 이 화면은 서버(server.js)가 대신 SOOP과의 연결 상태를 계산해서 내려주는 값(live)을
// 그대로 받아 배지/오류 메시지로 보여주기만 합니다.

const modeBadgeEl = document.getElementById('modeBadge');
const soopErrorBannerEl = document.getElementById('soopErrorBanner');

// live = { connected: boolean, error: string|null, lastEventAt: string|null }
function renderSoopLiveStatus(live) {
  if (!live) return;

  if (live.connected) {
    modeBadgeEl.textContent = '🔴 실시간 방송 모드 (연결됨)';
    modeBadgeEl.className = 'mode-badge mode-live';
  } else {
    modeBadgeEl.textContent = '🧪 테스트 모드';
    modeBadgeEl.className = 'mode-badge mode-test';
  }

  if (live.error) {
    soopErrorBannerEl.hidden = false;
    soopErrorBannerEl.textContent = `⚠️ ${live.error}`;
  } else {
    soopErrorBannerEl.hidden = true;
  }
}

window.renderSoopLiveStatus = renderSoopLiveStatus;
