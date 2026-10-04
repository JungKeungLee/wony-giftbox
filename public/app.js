// public/app.js
// broadcast.html에서 쓰는 화면 로직입니다.
// 주소창의 ?bj=아이디 또는 ?nick=닉네임을 읽어서, 그 스트리머의 도전미션 TOP5만 조회합니다.
// (여러 스트리머가 각자 다른 주소로 동시에 이 화면을 쓸 수 있습니다)
// ?goal=목표별풍선개수 로 목표치도 스트리머마다 다르게 지정할 수 있습니다. (없거나 잘못된 값이면 300,000 사용)

// 서버 캐시가 30초 정도이므로, 그보다 살짝 짧게 주기적으로 다시 물어봅니다.
const POLL_INTERVAL_MS = 15000;

// 1~3위를 꾸며줄 때 사용할 메달 이모지와 CSS 클래스 이름입니다.
const RANK_DECORATIONS = {
  1: { emoji: '🥇', className: 'rank-1' },
  2: { emoji: '🥈', className: 'rank-2' },
  3: { emoji: '🥉', className: 'rank-3' },
};

const missionTitleEl = document.getElementById('missionTitle');
const rankingListEl = document.getElementById('rankingList');
const emptyMessageEl = document.getElementById('emptyMessage');

const progressCardEl = document.getElementById('progressCard');
const progressLabelEl = document.getElementById('progressLabel');
const progressPercentEl = document.getElementById('progressPercent');
const progressBarFillEl = document.getElementById('progressBarFill');
const progressCurrentEl = document.getElementById('progressCurrent');
const progressGoalEl = document.getElementById('progressGoal');
const progressRemainingEl = document.getElementById('progressRemaining');

const DEFAULT_GOAL_STARS = 300000;

// 주소창 쿼리스트링에서 bj/nick/goal을 읽습니다. 예: broadcast.html?bj=whiteone325&goal=500000
const params = new URLSearchParams(window.location.search);
const targetBj = params.get('bj');
const targetNick = params.get('nick');

// 목표 별풍선 개수입니다. 스트리머마다 다를 수 있어서 goal 파라미터로 받고,
// 값이 없거나 숫자가 아니거나 0 이하면 기본값(300,000)을 씁니다.
function parseGoalStars(raw) {
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_GOAL_STARS;
  }
  return parsed;
}

const GOAL_STARS = parseGoalStars(params.get('goal'));

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

// bj/nick이 아예 없을 때 화면에 사용법을 안내합니다.
function renderMissingParam() {
  missionTitleEl.textContent = '⚠️ 스트리머를 지정해주세요';
  rankingListEl.innerHTML = '';
  emptyMessageEl.hidden = false;
  emptyMessageEl.textContent = '주소 끝에 ?bj=아이디&goal=목표치을 추가해주세요. broadcast.html?bj=아이디&goal=목표치숫자( 예 : 300000)';
  progressCardEl.hidden = true;
}

// 목표 진행률 카드를 그립니다. 진행 중인 모든 도전미션의 별풍선 총합(totalStars)을
// 현재 모금액으로 사용해서, 현재/goal * 100으로 달성률을 계산합니다.
function renderProgress(totalStars) {
  const percent = (totalStars / GOAL_STARS) * 100;
  const barPercent = Math.min(percent, 100); // 진행률 바는 100%를 넘기지 않게 고정
  const remaining = Math.max(GOAL_STARS - totalStars, 0);
  const goalReached = totalStars >= GOAL_STARS;

  progressLabelEl.textContent = `🎯 ${formatNumber(GOAL_STARS)}개 목표`;
  progressCurrentEl.textContent = formatNumber(totalStars); // 실제 총합은 100%를 넘어도 그대로 표시
  progressGoalEl.textContent = formatNumber(GOAL_STARS);
  progressRemainingEl.textContent = formatNumber(remaining);
  progressBarFillEl.style.width = `${barPercent}%`; // CSS transition으로 부드럽게 늘어남

  progressPercentEl.textContent = goalReached
    ? `🎉 ${formatNumber(GOAL_STARS)}개 목표 달성!`
    : `${percent.toFixed(2)}%`;
  progressCardEl.classList.toggle('goal-reached', goalReached);
}

// 직전에 그린 내용과 같으면 다시 그리지 않기 위한 비교용 문자열입니다.
let lastRenderedKey = null;

// 서버가 보내준 상태로 화면을 다시 그립니다.
function renderMission(state) {
  const key = JSON.stringify({
    hasMission: state.hasMission,
    bjNick: state.bjNick,
    totalStars: state.totalStars,
    topRanking: state.topRanking,
  });
  if (key === lastRenderedKey) {
    return; // 내용이 바뀌지 않았으면 다시 그리지 않습니다.
  }
  lastRenderedKey = key;

  const { hasMission, bjNick, totalStars, topRanking } = state;

  missionTitleEl.textContent = `🔥 ${escapeHtml(bjNick || targetBj || targetNick)} 도전미션 별풍선 TOP5`;

  progressCardEl.hidden = false;
  renderProgress(totalStars);

  if (!hasMission) {
    rankingListEl.innerHTML = '';
    emptyMessageEl.textContent = '현재 진행 중인 도전미션이 없습니다.';
    emptyMessageEl.hidden = false;
    return;
  }

  emptyMessageEl.hidden = true;
  rankingListEl.innerHTML = '';

  topRanking.slice(0, 5).forEach((donor) => {
    const rank = donor.rank;
    const decoration = RANK_DECORATIONS[rank];

    const li = document.createElement('li');
    li.className = 'rank-item' + (decoration ? ` ${decoration.className}` : '');

    // 표시 형식: "1위 닉네임 10,000개"
    li.innerHTML = `
      <span class="rank-number">${decoration ? `${decoration.emoji} ` : ''}${rank}위</span>
      <span class="rank-nickname">${escapeHtml(donor.nickname)}</span>
      <span class="rank-count">${formatNumber(donor.stars)}개</span>
    `;

    rankingListEl.appendChild(li);
  });
}

function buildMissionUrl() {
  const qs = new URLSearchParams();
  if (targetBj) qs.set('bj', targetBj);
  else if (targetNick) qs.set('nick', targetNick);
  return `/api/mission?${qs.toString()}`;
}

async function fetchMission() {
  try {
    const res = await fetch(buildMissionUrl());
    const data = await res.json();
    if (!res.ok) {
      console.error('조회 실패:', data.error);
      return; // 실패하면 화면은 이전 상태 그대로 둡니다.
    }
    renderMission(data);
  } catch (error) {
    console.error('네트워크 오류로 조회하지 못했습니다:', error);
  }
}

// ---- 페이지가 열리면 실행되는 초기화 코드 ----
if (!targetBj && !targetNick) {
  renderMissingParam();
} else {
  fetchMission();
  setInterval(fetchMission, POLL_INTERVAL_MS);
}

// ---- 숫자가 바뀔 때 살짝 튀어오르는 연출 (디자인 추가 요소, 기존 로직에는 영향 없음) ----
// progressCurrent/progressGoal/progressPercent/progressRemaining, 순위 카드의 별풍선 개수가
// 바뀔 때마다 .value-pop 클래스를 잠깐 씌웠다가 애니메이션이 끝나면 벗겨냅니다.
function watchValuePop(target) {
  const observer = new MutationObserver(() => {
    target.classList.remove('value-pop');
    // 리플로우를 강제로 한 번 일으켜서, 같은 값이 연속으로 들어와도 애니메이션이 재생되게 합니다.
    void target.offsetWidth;
    target.classList.add('value-pop');
  });
  observer.observe(target, { characterData: true, childList: true, subtree: true });
}

[progressCurrentEl, progressGoalEl, progressPercentEl, progressRemainingEl].forEach(watchValuePop);

new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    mutation.addedNodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        node.querySelectorAll?.('.rank-count').forEach((el) => watchValuePop(el));
      }
    });
  });
}).observe(rankingListEl, { childList: true });
