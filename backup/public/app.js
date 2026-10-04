// public/app.js
// 순위표를 그리고 서버와 통신하는 "공통 코드"입니다.
// public/broadcast.html(송출 화면)과 public/settings.html(운영자 설정 화면) 양쪽에서 함께 불러 씁니다.
// 이 파일 자체는 SOOP 인증 정보를 전혀 다루지 않고, 서버가 계산해둔 결과(순위표 + 연결 상태)만 받아 보여줍니다.

// 1~5위를 꾸며줄 때 사용할 메달 이모지와 CSS 클래스 이름입니다. (1~3위는 특별 디자인)
const RANK_DECORATIONS = {
  1: { emoji: '🥇', className: 'rank-1' },
  2: { emoji: '🥈', className: 'rank-2' },
  3: { emoji: '🥉', className: 'rank-3' },
};

const rankingListEl = document.getElementById('rankingList');
const emptyMessageEl = document.getElementById('emptyMessage');
const totalStarCountEl = document.getElementById('totalStarCount');
const participantCountEl = document.getElementById('participantCount');

// 숫자를 1,000 처럼 천 단위 콤마로 보기 좋게 바꿔줍니다.
function formatNumber(num) {
  return num.toLocaleString('ko-KR');
}

// 닉네임에 특수문자(<, > 등)가 들어와도 안전하게 화면에 표시하기 위한 함수입니다.
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 서버에서 받은 순위 데이터로 화면 전체를 다시 그립니다.
function renderLeaderboard(data) {
  const { topRanking, totalStarCount, participantCount, live } = data;

  totalStarCountEl.textContent = `${formatNumber(totalStarCount)} 개`;
  participantCountEl.textContent = `${formatNumber(participantCount)} 명`;

  // 모드 배지 / 오류 배너 갱신은 soop.js가 담당합니다. (이 요소가 없는 화면에서는 아무 일도 하지 않습니다)
  if (typeof window.renderSoopLiveStatus === 'function') {
    window.renderSoopLiveStatus(live);
  }

  rankingListEl.innerHTML = '';

  if (topRanking.length === 0) {
    emptyMessageEl.hidden = false;
    return;
  }
  emptyMessageEl.hidden = true;

  topRanking.forEach((user, index) => {
    const rank = index + 1;
    const decoration = RANK_DECORATIONS[rank];

    const li = document.createElement('li');
    li.className = 'rank-item' + (decoration ? ` ${decoration.className}` : '');

    li.innerHTML = `
      <span class="rank-number">${decoration ? decoration.emoji : rank}</span>
      <span class="rank-nickname">${escapeHtml(user.userNickname)}</span>
      <span class="rank-count">⭐ ${formatNumber(user.totalCount)}</span>
    `;

    rankingListEl.appendChild(li);
  });
}

// 서버에 저장된 최신 순위표를 한 번 가져옵니다. (페이지를 처음 열었을 때 사용)
async function fetchLeaderboard() {
  const res = await fetch('/api/leaderboard');
  const data = await res.json();
  renderLeaderboard(data);
}

// 실시간 갱신(Server-Sent Events)에 연결합니다.
function connectRealtimeUpdates() {
  const eventSource = new EventSource('/api/stream');

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    renderLeaderboard(data);
  };

  eventSource.onerror = () => {
    // 연결이 끊어져도 브라우저(EventSource)가 자동으로 재접속을 시도합니다.
    console.warn('실시간 연결이 끊어졌습니다. 자동 재접속을 시도합니다.');
  };
}

// ---- 페이지가 열리면 실행되는 초기화 코드 ----
fetchLeaderboard();
connectRealtimeUpdates();
