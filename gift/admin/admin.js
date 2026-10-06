// gift/admin/admin.js
// 선물상자 관리자 화면 로직입니다.
// - 모든 조작은 /api/gift/admin/* 로 보내며, 로그인 쿠키(HttpOnly)로 인증됩니다.
// - 실시간 갱신: /api/gift/stream(SSE)에서 이벤트가 오면 관리자 상태를 다시 불러옵니다.
//   (관리자 화면을 새로고침하거나 여러 창을 띄워도 항상 서버의 현재 상태를 보여줍니다)

const TYPE_LABELS = { STAR: '별풍선', CHALLENGE: '도전미션', BATTLE: '대결미션' };
const STATUS_LABELS = {
  READY: '준비',
  ACTIVE: '수집 중',
  BOX_OPENING: '상자 오픈 중',
  ROULETTE: '룰렛 추첨 중',
  RESULT: '결과 표시',
  FINISHED: '완료',
};
const DONATION_STATUS_LABELS = { COUNTED: '집계', CANCELED: '취소', IGNORED: '미집계' };
const END_REASON_LABELS = { COMPLETED: '정상 완료', RESET: '초기화' };
const LOG_LABELS = {
  ROUND_CREATED: '회차 생성',
  SETTINGS_UPDATED: '설정 변경',
  PRIZES_UPDATED: '상품 변경',
  STARTED: '이벤트 시작',
  STOPPED: '이벤트 종료(수집 중지)',
  GOAL_REACHED: '목표 달성',
  GOAL_REVERTED: '목표 달성 취소(후원 취소로 목표 미만)',
  DONATION_CANCELED: '후원 취소',
  AMOUNT_ADJUSTED: '게이지 수정',
  FORCE_OPEN: '상자 강제 오픈',
  ROULETTE_STARTED: '룰렛 시작',
  WINNER_SELECTED: '당첨자 선정',
  RESULT_READY: '결과 확정',
  ROUND_FINISHED: '회차 종료',
};

const $ = (id) => document.getElementById(id);

let state = null;
let serverOffsetMs = 0;
let prizesDirty = false;
let prizeDraft = [];

// ---------------------------------------------------------------------------
// 공통
// ---------------------------------------------------------------------------

function formatNumber(num) {
  return Number(num || 0).toLocaleString('ko-KR');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function formatTime(iso, withDate = false) {
  if (!iso) return '-';
  const date = new Date(iso);
  return withDate
    ? date.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    : date.toLocaleTimeString('ko-KR', { hour12: false });
}

function notify(message, type = 'ok') {
  const node = document.createElement('div');
  node.className = `notice is-${type}`;
  node.textContent = message;
  $('toastHost').appendChild(node);
  setTimeout(() => node.remove(), type === 'error' ? 6000 : 3000);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    window.location.reload(); // 인증이 풀렸으면 로그인 화면으로
    throw new Error('관리자 인증이 필요합니다.');
  }
  if (!res.ok) throw new Error(data.error || `요청 실패 (HTTP ${res.status})`);
  return data;
}

// 버튼을 누르는 동안 잠가서 같은 요청이 두 번 가지 않게 합니다.
async function run(button, task, successMessage) {
  if (button) button.disabled = true;
  try {
    const result = await task();
    if (result && result.event) applyState(result);
    else if (result && result.state && result.state.event) applyState(result.state);
    if (successMessage) notify(typeof successMessage === 'function' ? successMessage(result) : successMessage);
    return result;
  } catch (error) {
    notify(error.message, 'error');
    return null;
  } finally {
    if (button) button.disabled = false;
    renderControls();
  }
}

// ---------------------------------------------------------------------------
// 상태 불러오기 / 그리기
// ---------------------------------------------------------------------------

async function loadState() {
  try {
    applyState(await api('GET', '/api/gift/admin/state'));
  } catch (error) {
    notify(`상태를 불러오지 못했습니다: ${error.message}`, 'error');
  }
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(loadState, 150);
}

function applyState(next) {
  const roundChanged = state && state.event.id !== next.event.id;
  state = next;
  serverOffsetMs = Date.parse(next.serverTime) - Date.now();
  if (roundChanged) {
    prizesDirty = false;
    loadRounds();
  }
  render();
}

function render() {
  if (!state) return;
  const { event } = state;

  $('roundChip').textContent = `${event.roundNo}회차`;
  const badge = $('statusBadge');
  badge.textContent = `${STATUS_LABELS[event.status] || event.status} · ${event.status}`;
  badge.dataset.status = event.status;

  $('currentAmount').textContent = formatNumber(event.currentAmount);
  $('targetAmount').textContent = formatNumber(event.targetAmount);
  $('progressPercent').textContent = `${event.percent.toFixed(1)}%`;
  $('barFill').style.width = `${event.percent}%`;
  const over = event.currentAmount - event.targetAmount;
  $('progressMeta').textContent = [
    `남은 ${formatNumber(event.remainingAmount)}개`,
    over > 0 ? `목표 초과 ${formatNumber(over)}개 (게이지는 100%에서 멈춤, 다음 회차로 이월 없음)` : null,
    `참여자 ${formatNumber(state.stats.participantCount)}명`,
    `응모자 ${formatNumber(state.stats.entrantCount)}명 / 응모권 ${formatNumber(state.stats.totalTickets)}장`,
  ].filter(Boolean).join(' · ');

  if (document.activeElement !== $('targetInput')) $('targetInput').value = event.targetAmount;
  if (document.activeElement !== $('ticketUnitInput')) $('ticketUnitInput').value = event.ticketUnit;
  $('ticketUnitHint').textContent = `응모권: 해당 회차 누적 별풍선 ${formatNumber(event.ticketUnit)}개당 1장 (현재 운영은 일반 별풍선만 집계)`;
  if (document.activeElement !== $('amountInput')) $('amountInput').value = event.currentAmount;

  if (!prizesDirty) {
    prizeDraft = state.prizes.map((p) => ({ name: p.name, quantity: p.quantity }));
    renderPrizes();
  }

  renderWinners();
  renderDonors();
  renderDonations();
  renderLogs();
  renderControls();
}

// 상태별로 누를 수 있는 버튼만 활성화합니다. (서버도 같은 규칙으로 한 번 더 막습니다)
function renderControls() {
  if (!state) return;
  const { status } = state.event;
  const drawn = state.winners.length > 0;
  const show = (id, visible) => {
    $(id).hidden = !visible;
  };

  show('startBtn', status === 'READY');
  show('stopBtn', status === 'ACTIVE');
  show('drawBtn', status === 'ROULETTE');
  show('nextRoundBtn', status === 'RESULT');

  $('forceOpenBtn').disabled = !['READY', 'ACTIVE'].includes(status);
  $('forceRouletteBtn').disabled = !['READY', 'ACTIVE', 'BOX_OPENING'].includes(status);
  $('targetInput').disabled = !['READY', 'ACTIVE'].includes(status);
  $('ticketUnitInput').disabled = !['READY', 'ACTIVE'].includes(status);
  $('amountInput').disabled = !['READY', 'ACTIVE'].includes(status);
  const prizeLocked = status === 'RESULT' || drawn;
  $('savePrizesBtn').disabled = prizeLocked;
  $('addPrizeBtn').disabled = prizeLocked;

  const hints = {
    READY: '설정을 확인한 뒤 "이벤트 시작"을 누르면 후원 수집이 시작됩니다. (준비 단계의 후원은 집계되지 않고 기록만 남습니다)',
    ACTIVE: '후원 수집 중입니다. 목표 달성 시 자동으로 상자가 열립니다.',
    BOX_OPENING: '상자 오픈 연출 중입니다. 잠시 후 자동으로 룰렛 화면으로 넘어갑니다. 이후 들어오는 후원은 집계되지 않습니다.',
    ROULETTE: '"다음 추첨"을 누를 때마다 1명씩 뽑습니다. (서버에서 가중치 추첨 후 오버레이에서 룰렛이 돌아갑니다. 이미 당첨된 사람은 제외)',
    RESULT: '추첨이 끝났습니다. 방송에서 결과를 보여준 뒤 "다음 선물상자 시작"을 누르면 새 회차가 0부터 준비됩니다.',
  };
  $('flowHint').textContent = hints[status] || '';
  updateDrawButton();
}

// 룰렛 연출(회전 + 당첨자 표시)이 끝나기 전에는 다음 추첨 버튼을 잠급니다.
function updateDrawButton() {
  if (!state || state.event.status !== 'ROULETTE') return;
  const button = $('drawBtn');
  const next = state.nextSlot;
  const label = next ? `🎡 다음 추첨 — ${next.prize.order}등 ${next.prize.name} (${next.slotNo}/${state.totalSlots})` : '🎡 결과 확정';
  const waitMs = state.nextDrawAvailableAt ? Date.parse(state.nextDrawAvailableAt) - (Date.now() + serverOffsetMs) : 0;
  if (waitMs > 0) {
    button.disabled = true;
    button.textContent = `룰렛 연출 중… ${Math.ceil(waitMs / 1000)}초`;
  } else {
    button.disabled = false;
    button.textContent = label;
  }
}
setInterval(updateDrawButton, 250);

function renderPrizes() {
  const list = $('prizeList');
  if (prizeDraft.length === 0) {
    list.innerHTML = '<p class="hint">등록된 상품이 없습니다. "+ 상품 추가"를 눌러주세요.</p>';
  } else {
    list.innerHTML = prizeDraft
      .map((prize, index) => `
        <div class="prize-row" data-index="${index}">
          <span class="order">${index + 1}등</span>
          <input data-field="name" maxlength="100" placeholder="상품명 (예: 치킨 기프티콘)" value="${escapeHtml(prize.name)}" aria-label="${index + 1}등 상품명" />
          <input data-field="quantity" type="number" min="1" step="1" value="${prize.quantity}" aria-label="${index + 1}등 수량" title="수량(당첨 인원)" />
          <span class="tools">
            <button class="btn btn-ghost" type="button" data-move="-1" title="위로" ${index === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn btn-ghost" type="button" data-move="1" title="아래로" ${index === prizeDraft.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="btn btn-ghost" type="button" data-remove title="삭제">✕</button>
          </span>
        </div>`)
      .join('');
  }
  const total = prizeDraft.reduce((sum, prize) => sum + (Number(prize.quantity) || 0), 0);
  $('winnerCountLabel').textContent = `당첨 인원 ${total}명${prizesDirty ? ' · 저장 안 됨' : ''}`;
}

function renderWinners() {
  const winnersBySlot = new Map(state.winners.map((w) => [w.slotNo, w]));
  const slots = [];
  for (const prize of [...state.prizes].sort((a, b) => a.order - b.order)) {
    for (let i = 0; i < prize.quantity; i += 1) slots.push(prize);
  }
  $('drawProgress').textContent = `${state.winners.length} / ${slots.length}명 추첨`;
  const finished = state.event.status === 'RESULT';
  $('winnerList').innerHTML = slots.length === 0
    ? '<li class="is-empty"><span></span><span class="name">상품을 먼저 등록해주세요.</span></li>'
    : slots.map((prize, index) => {
      const winner = winnersBySlot.get(index + 1);
      const odds = winner ? `응모권 ${winner.tickets}/${winner.totalTickets}장` : '';
      return `<li class="${winner ? '' : 'is-empty'}">
        <span class="rank">${prize.order}등</span>
        <span class="name">${winner ? escapeHtml(winner.nickname) : finished ? '당첨자 없음' : '대기'}</span>
        <span class="prize">${escapeHtml(prize.name)}</span>
        <span class="odds">${odds}</span>
      </li>`;
    }).join('');
}

function renderDonors() {
  const donors = state.donors;
  $('participantSummary').textContent = `${donors.length}명 · 응모권 ${formatNumber(state.stats.totalTickets)}장`;
  $('donorTable').innerHTML = donors.length === 0
    ? '<tr><td class="empty" colspan="7">아직 후원이 없습니다.</td></tr>'
    : donors.map((d) => `<tr>
        <td>${escapeHtml(d.nickname)}${d.donorId ? ` <small class="label">(${escapeHtml(d.donorId)})</small>` : ''}</td>
        <td class="num"><strong>${formatNumber(d.total)}</strong></td>
        <td class="num">${formatNumber(d.byType.STAR)}</td>
        <td class="num">${formatNumber(d.byType.CHALLENGE)}</td>
        <td class="num">${formatNumber(d.byType.BATTLE)}</td>
        <td class="num tickets">${formatNumber(d.tickets)}</td>
        <td class="num">${formatNumber(d.remainder)}</td>
      </tr>`).join('');
}

function renderDonations() {
  const canCancel = ['READY', 'ACTIVE', 'BOX_OPENING'].includes(state.event.status);
  const rows = state.recentDonations;
  $('donationTable').innerHTML = rows.length === 0
    ? '<tr><td class="empty" colspan="6">후원 내역이 없습니다.</td></tr>'
    : rows.map((d) => `<tr>
        <td>${formatTime(d.createdAt)}</td>
        <td>${escapeHtml(d.nickname)}</td>
        <td><span class="tag tag-${d.type}">${TYPE_LABELS[d.type]}</span></td>
        <td class="num">${formatNumber(d.amount)}</td>
        <td><span class="tag tag-${d.status}" title="${escapeHtml(d.ignoredReason || d.source)}">${DONATION_STATUS_LABELS[d.status]}</span>${d.source === 'TEST' ? ' <small class="label">테스트</small>' : ''}</td>
        <td>${d.status === 'COUNTED' && canCancel ? `<button class="btn btn-ghost btn-sm" type="button" data-cancel="${d.id}">취소</button>` : ''}</td>
      </tr>`).join('');
}

function renderLogs() {
  $('logList').innerHTML = state.logs
    .map((log) => `<li>${formatTime(log.createdAt, true)} · <code>${escapeHtml(LOG_LABELS[log.action] || log.action)}</code>${log.detail ? ` — ${escapeHtml(JSON.stringify(log.detail))}` : ''}</li>`)
    .join('');
}

// ---------------------------------------------------------------------------
// 회차 기록
// ---------------------------------------------------------------------------

async function loadRounds() {
  try {
    const rounds = await api('GET', '/api/gift/admin/rounds');
    $('roundTable').innerHTML = rounds.map((r) => `<tr class="clickable" data-round="${r.id}" tabindex="0">
        <td><strong>${r.roundNo}회차</strong></td>
        <td>${STATUS_LABELS[r.status]}${r.endReason ? ` (${END_REASON_LABELS[r.endReason]})` : ''}</td>
        <td class="num">${formatNumber(r.targetAmount)}</td>
        <td class="num">${formatNumber(r.currentAmount)}</td>
        <td class="num">${formatNumber(r.donationTotal)}</td>
        <td class="num">${formatNumber(r.participantCount)}</td>
        <td class="num">${r.drawnCount}/${r.winnerCount}</td>
        <td>${formatTime(r.startedAt, true)}</td>
        <td>${formatTime(r.finishedAt, true)}</td>
      </tr>`).join('');
  } catch (error) {
    notify(`회차 기록을 불러오지 못했습니다: ${error.message}`, 'error');
  }
}

async function openRound(id) {
  try {
    const detail = await api('GET', `/api/gift/admin/rounds/${id}`);
    const { event } = detail;
    $('roundModalTitle').textContent = `${event.roundNo}회차 상세 기록`;
    const entrants = detail.donors.filter((d) => d.tickets > 0);
    $('roundModalBody').innerHTML = `
      <div class="summary-grid">
        <div><span>상태</span><strong>${STATUS_LABELS[event.status]}${event.endReason ? ` (${END_REASON_LABELS[event.endReason]})` : ''}</strong></div>
        <div><span>목표 개수</span><strong>${formatNumber(event.targetAmount)}</strong></div>
        <div><span>게이지 최종값</span><strong>${formatNumber(event.currentAmount)}</strong></div>
        <div><span>총 후원 (집계분)</span><strong>${formatNumber(detail.donationTotal)}</strong></div>
        <div><span>참여자 / 응모자</span><strong>${detail.donors.length} / ${entrants.length}명</strong></div>
        <div><span>총 응모권</span><strong>${formatNumber(entrants.reduce((s, d) => s + d.tickets, 0))}장</strong></div>
        <div><span>시작</span><strong>${formatTime(event.startedAt, true)}</strong></div>
        <div><span>목표 달성</span><strong>${formatTime(event.goalReachedAt, true)}</strong></div>
        <div><span>종료</span><strong>${formatTime(event.finishedAt, true)}</strong></div>
      </div>

      <h3>상품 / 당첨자</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>순서</th><th>상품</th><th>당첨자</th><th class="num">응모권</th><th>선정 시각</th></tr></thead>
        <tbody>${detail.prizes.map((p) => {
          const winners = detail.winners.filter((w) => w.prizeId === p.id);
          const cells = [];
          for (let i = 0; i < p.quantity; i += 1) {
            const w = winners[i];
            cells.push(`<tr><td>${p.prizeOrder}등</td><td>${escapeHtml(p.prizeName)}</td><td>${w ? escapeHtml(w.nickname) : '-'}</td><td class="num">${w ? `${w.ticketCount}/${w.totalTickets}` : ''}</td><td>${w ? formatTime(w.selectedAt, true) : ''}</td></tr>`);
          }
          return cells.join('');
        }).join('') || '<tr><td class="empty" colspan="5">상품 없음</td></tr>'}</tbody>
      </table></div>

      <h3>참여자 / 응모권</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>닉네임</th><th class="num">총 후원</th><th class="num">별풍선</th><th class="num">도전</th><th class="num">대결</th><th class="num">응모권</th><th class="num">잔여</th></tr></thead>
        <tbody>${detail.donors.map((d) => `<tr><td>${escapeHtml(d.nickname)}</td><td class="num">${formatNumber(d.total)}</td><td class="num">${formatNumber(d.byType.STAR)}</td><td class="num">${formatNumber(d.byType.CHALLENGE)}</td><td class="num">${formatNumber(d.byType.BATTLE)}</td><td class="num tickets">${d.tickets}</td><td class="num">${d.remainder}</td></tr>`).join('') || '<tr><td class="empty" colspan="7">참여자 없음</td></tr>'}</tbody>
      </table></div>

      <h3>후원 내역 (${detail.donations.length}건)</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>시각</th><th>닉네임</th><th>유형</th><th class="num">개수</th><th>상태</th><th>출처</th></tr></thead>
        <tbody>${detail.donations.map((d) => `<tr><td>${formatTime(d.createdAt, true)}</td><td>${escapeHtml(d.nickname)}</td><td><span class="tag tag-${d.type}">${TYPE_LABELS[d.type]}</span></td><td class="num">${formatNumber(d.amount)}</td><td><span class="tag tag-${d.status}">${DONATION_STATUS_LABELS[d.status]}</span></td><td>${escapeHtml(d.source)}</td></tr>`).join('') || '<tr><td class="empty" colspan="6">후원 없음</td></tr>'}</tbody>
      </table></div>

      <h3>조작 로그</h3>
      <ul class="log-list">${detail.logs.map((log) => `<li>${formatTime(log.createdAt, true)} · <code>${escapeHtml(LOG_LABELS[log.action] || log.action)}</code>${log.detail ? ` — ${escapeHtml(JSON.stringify(log.detail))}` : ''}</li>`).join('')}</ul>
    `;
    $('roundModal').showModal();
  } catch (error) {
    notify(error.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// 이벤트 연결
// ---------------------------------------------------------------------------

$('startBtn').addEventListener('click', (e) => run(e.currentTarget, () => api('POST', '/api/gift/admin/start'), '이벤트를 시작했습니다.'));

$('stopBtn').addEventListener('click', (e) => {
  if (!confirm('후원 수집을 중지할까요?\n지금까지의 기록은 유지되고, 다시 "이벤트 시작"을 누르면 이어서 수집합니다.')) return;
  run(e.currentTarget, () => api('POST', '/api/gift/admin/stop'), '수집을 중지했습니다.');
});

$('drawBtn').addEventListener('click', (e) => run(e.currentTarget, () => api('POST', '/api/gift/admin/draw'), (result) =>
  result.winner ? `${result.winner.nickname}님 당첨! (${result.winner.prize.name})` : '추첨이 끝났습니다.'));

$('nextRoundBtn').addEventListener('click', (e) => {
  if (!confirm('현재 회차를 완료하고 다음 선물상자를 준비할까요?\n(이번 회차 기록은 보존되고, 게이지는 0부터 시작합니다)')) return;
  run(e.currentTarget, () => api('POST', '/api/gift/admin/next-round'), '새 회차가 준비되었습니다. 설정 확인 후 이벤트를 시작해주세요.');
});

$('settingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  run(e.submitter, () => api('PUT', '/api/gift/admin/settings', { targetAmount: Number($('targetInput').value) }), '목표 개수를 저장했습니다.');
});

$('ticketUnitForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = $('ticketUnitInput').value.trim();
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    notify('응모권 지급 기준은 1 이상의 정수만 입력할 수 있습니다.', 'error');
    return;
  }
  run(e.submitter, () => api('PUT', '/api/gift/admin/settings', { ticketUnit: Number(raw) }), `응모권 지급 기준을 ${formatNumber(Number(raw))}개당 1장으로 저장했습니다.`);
});

// ---- 상품 편집 ----
$('prizeList').addEventListener('input', (e) => {
  const row = e.target.closest('.prize-row');
  if (!row) return;
  const prize = prizeDraft[Number(row.dataset.index)];
  if (e.target.dataset.field === 'name') prize.name = e.target.value;
  if (e.target.dataset.field === 'quantity') prize.quantity = Number(e.target.value);
  prizesDirty = true;
  const total = prizeDraft.reduce((sum, p) => sum + (Number(p.quantity) || 0), 0);
  $('winnerCountLabel').textContent = `당첨 인원 ${total}명 · 저장 안 됨`;
});

$('prizeList').addEventListener('click', (e) => {
  const button = e.target.closest('button');
  const row = e.target.closest('.prize-row');
  if (!button || !row) return;
  const index = Number(row.dataset.index);
  if (button.dataset.move) {
    const to = index + Number(button.dataset.move);
    [prizeDraft[index], prizeDraft[to]] = [prizeDraft[to], prizeDraft[index]];
  } else if (button.hasAttribute('data-remove')) {
    prizeDraft.splice(index, 1);
  }
  prizesDirty = true;
  renderPrizes();
});

$('addPrizeBtn').addEventListener('click', () => {
  prizeDraft.push({ name: '', quantity: 1 });
  prizesDirty = true;
  renderPrizes();
  const inputs = $('prizeList').querySelectorAll('input[data-field="name"]');
  inputs[inputs.length - 1].focus();
});

$('savePrizesBtn').addEventListener('click', async (e) => {
  const result = await run(e.currentTarget, () => api('PUT', '/api/gift/admin/prizes', { prizes: prizeDraft }), '상품을 저장했습니다.');
  if (result) {
    prizesDirty = false;
    render();
  }
});

// ---- 테스트 후원 ----
$('testForm').addEventListener('click', (e) => {
  const quick = e.target.closest('[data-quick]');
  if (quick) $('testAmount').value = quick.dataset.quick;
});

function testType() {
  return document.querySelector('input[name="testType"]:checked').value;
}

function describeDonationResult(result) {
  if (result.result === 'COUNTED') return '후원이 집계되었습니다.';
  if (result.result === 'DUPLICATE') return '이미 처리된 후원(중복)이라 무시했습니다.';
  return `기록만 남기고 집계하지 않았습니다. (${result.reason || '수집 중이 아님'})`;
}

$('testForm').addEventListener('submit', (e) => {
  e.preventDefault();
  run(e.submitter, () => api('POST', '/api/gift/admin/donations', {
    nickname: $('testNickname').value,
    type: testType(),
    amount: Number($('testAmount').value),
    test: true,
  }), describeDonationResult);
});

$('randomTestBtn').addEventListener('click', (e) => run(e.currentTarget, async () => {
  const names = ['철수', '영희', '민수', '지영', '현우', '수빈', '도윤', '하은'];
  const types = ['STAR']; // 현재 운영은 일반 별풍선만 사용
  const amounts = [10, 30, 50, 77, 100, 150, 200, 300];
  let last = null;
  for (let i = 0; i < 5; i += 1) {
    last = await api('POST', '/api/gift/admin/donations', {
      nickname: names[Math.floor(Math.random() * names.length)],
      type: types[Math.floor(Math.random() * types.length)],
      amount: amounts[Math.floor(Math.random() * amounts.length)],
      test: true,
    });
  }
  return last;
}, '랜덤 테스트 후원 5건을 보냈습니다.'));

// ---- 수동 관리 ----
$('manualForm').addEventListener('submit', (e) => {
  e.preventDefault();
  run(e.submitter, () => api('POST', '/api/gift/admin/donations', {
    nickname: $('manualNickname').value,
    donorId: $('manualDonorId').value || undefined,
    type: $('manualType').value,
    amount: Number($('manualAmount').value),
  }), describeDonationResult).then((result) => {
    if (result) $('manualAmount').value = '';
  });
});

$('donationTable').addEventListener('click', (e) => {
  const button = e.target.closest('[data-cancel]');
  if (!button) return;
  const id = Number(button.dataset.cancel);
  const donation = state.recentDonations.find((d) => d.id === id);
  if (!confirm(`${donation ? `${donation.nickname}님 ${TYPE_LABELS[donation.type]} ${formatNumber(donation.amount)}개` : '이 후원'}를 취소할까요?\n게이지와 응모권에서 빠지고, 기록은 "취소"로 남습니다.`)) return;
  run(button, () => api('POST', `/api/gift/admin/donations/${id}/cancel`), '후원을 취소했습니다.');
});

$('amountForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = Number($('amountInput').value);
  if (!confirm(`게이지를 ${formatNumber(value)}(으)로 수정할까요?\n후원 기록과 응모권은 바뀌지 않습니다.`)) return;
  run(e.submitter, () => api('PUT', '/api/gift/admin/amount', { currentAmount: value }), '게이지를 수정했습니다.');
});

$('forceOpenBtn').addEventListener('click', (e) => {
  if (!confirm('목표에 도달하지 않았어도 지금 상자를 열까요?\n이후 들어오는 후원은 이번 회차에 집계되지 않습니다.')) return;
  run(e.currentTarget, () => api('POST', '/api/gift/admin/force-open'), '상자를 강제로 열었습니다.');
});

$('forceRouletteBtn').addEventListener('click', (e) => {
  if (!confirm('오픈 연출을 건너뛰고 바로 룰렛 화면으로 넘어갈까요?')) return;
  run(e.currentTarget, () => api('POST', '/api/gift/admin/force-roulette'), '룰렛 화면으로 전환했습니다.');
});

$('resetRoundBtn').addEventListener('click', (e) => {
  const input = prompt('현재 회차를 초기화합니다.\n이번 회차는 "초기화"로 종료되어 기록만 남고, 게이지 0인 새 회차가 준비됩니다.\n\n계속하려면 "초기화"를 입력하세요.');
  if (input !== '초기화') return;
  run(e.currentTarget, () => api('POST', '/api/gift/admin/reset-round'), '회차를 초기화했습니다.');
});

$('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/gift/admin/logout', { method: 'POST' });
  window.location.reload();
});

$('refreshRoundsBtn').addEventListener('click', loadRounds);
$('roundTable').addEventListener('click', (e) => {
  const row = e.target.closest('[data-round]');
  if (row) openRound(Number(row.dataset.round));
});
$('roundTable').addEventListener('keydown', (e) => {
  const row = e.target.closest('[data-round]');
  if (row && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openRound(Number(row.dataset.round));
  }
});
$('roundModalClose').addEventListener('click', () => $('roundModal').close());

// ---- 오버레이 미리보기 크기 맞추기 (1920x1080 화면을 카드 폭에 맞게 축소) ----
const previewFrame = document.querySelector('.preview-frame');
const previewIframe = previewFrame.querySelector('iframe');
new ResizeObserver(() => {
  previewIframe.style.transform = `scale(${previewFrame.clientWidth / 1920})`;
}).observe(previewFrame);

// ---- 실시간 연결 ----
function connectStream() {
  const source = new EventSource('/api/gift/stream');
  source.onopen = () => $('liveDot').classList.add('is-on');
  source.onmessage = (event) => {
    const message = JSON.parse(event.data);
    scheduleRefresh();
    if (message.type === 'ROUND_FINISHED' || message.type === 'RESULT_READY') loadRounds();
  };
  source.onerror = () => {
    $('liveDot').classList.remove('is-on');
    if (source.readyState === EventSource.CLOSED) setTimeout(connectStream, 3000);
  };
}

// ---- SOOP 공식 연동 상태 (선물상자 기능과 독립: 실패해도 다른 화면 동작에는 영향 없음) ----
const SOOP_SDK_LABELS = {
  IDLE: '대기',
  CONNECTING: '연결 중',
  CONNECTED: '연결됨',
  DISCONNECTED: '끊김',
  ERROR: '오류',
  NO_PAGE: '커넥터 페이지 닫힘',
};

function setSoopValue(id, text, tone) {
  const node = $(id);
  node.textContent = text;
  node.dataset.tone = tone || '';
}

async function loadSoopStatus() {
  try {
    const res = await fetch('/api/soop/admin/status', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(res.status === 404 ? '연동 모듈 없음' : `HTTP ${res.status}`);
    const soop = await res.json();
    if (!soop.configured) {
      setSoopValue('soopOauth', '설정 안 됨', 'muted');
      setSoopValue('soopSdk', '-', 'muted');
      setSoopValue('soopLast', '-', 'muted');
      $('soopHint').textContent = 'Render 환경변수 SOOP_CLIENT_ID / SOOP_CLIENT_SECRET을 설정하면 사용할 수 있습니다.';
      return;
    }
    const oauthOn = soop.oauth === 'CONNECTED';
    setSoopValue('soopOauth', oauthOn ? '연결됨' : '연결 안 됨', oauthOn ? 'ok' : 'bad');
    const sdkTone = soop.sdkState === 'CONNECTED' ? 'ok' : soop.sdkState === 'CONNECTING' ? 'warn' : oauthOn ? 'bad' : 'muted';
    const who = soop.bjNickname || soop.bjId;
    setSoopValue('soopSdk', (SOOP_SDK_LABELS[soop.sdkState] || soop.sdkState) + (who && soop.sdkState === 'CONNECTED' ? ` · ${who}` : ''), sdkTone);
    const last = soop.lastBalloon;
    setSoopValue('soopLast', last ? `${last.nickname} / ${formatNumber(last.count)}개 / ${formatTime(last.at)}` : '-', last ? '' : 'muted');
    $('soopHint').textContent = soop.lastError ? `최근 오류 (${formatTime(soop.lastError.at)}): ${soop.lastError.message}` : '';
  } catch (error) {
    setSoopValue('soopOauth', '확인 불가', 'muted');
    setSoopValue('soopSdk', '-', 'muted');
    setSoopValue('soopLast', '-', 'muted');
    $('soopHint').textContent = `SOOP 연동 상태를 불러오지 못했습니다: ${error.message}`;
  }
}

loadState();
loadRounds();
connectStream();
loadSoopStatus();
setInterval(loadSoopStatus, 5000);
