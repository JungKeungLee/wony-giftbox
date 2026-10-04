// gift/overlay/overlay.js
// OBS 오버레이 화면 로직입니다.
// - 서버가 SSE(/api/gift/stream)로 보내주는 이벤트를 받아 장면(게이지 → 오픈 연출 → 룰렛 → 결과)을 전환합니다.
// - 모든 판단(목표 달성, 당첨자)은 서버가 하고, 이 화면은 "보여주기"만 합니다.
// - OBS 새로고침/서버 재시작 후에도 서버가 보내주는 STATE_SYNC와 서버 시각을 기준으로 이어서 보여줍니다.
// - 관리자 API는 전혀 호출하지 않습니다.

const params = new URLSearchParams(window.location.search);
const WIDGET_POSITIONS = ['tl', 'tc', 'tr', 'bl', 'bc', 'br'];
const widgetPos = WIDGET_POSITIONS.includes(params.get('pos')) ? params.get('pos') : 'bl';

const TYPE_LABELS = { STAR: '별풍선', CHALLENGE: '도전미션', BATTLE: '대결미션' };
const TYPE_ICONS = { STAR: '⭐', CHALLENGE: '🔥', BATTLE: '⚔️' };
const WHEEL_COLORS = ['#c2263f', '#e8bf6a', '#7d1027', '#f3d48c', '#a01c34', '#c9963f', '#5e0c1e', '#ffe7ad'];
const DARK_TEXT_COLORS = new Set(['#e8bf6a', '#f3d48c', '#c9963f', '#ffe7ad']);

const $ = (id) => document.getElementById(id);
const el = {
  idleWidget: $('idleWidget'),
  toastArea: $('toastArea'),
  miniBox: $('miniBox'),
  idleRound: $('idleRound'),
  idleCurrent: $('idleCurrent'),
  idleTarget: $('idleTarget'),
  idleRemaining: $('idleRemaining'),
  idleHint: $('idleHint'),
  gaugeFill: $('gaugeFill'),
  sceneOpening: $('sceneOpening'),
  openingRays: $('openingRays'),
  openingHeadline: $('openingHeadline'),
  openingBoxWrap: $('openingBoxWrap'),
  openingCountdown: $('openingCountdown'),
  openingSub: $('openingSub'),
  openingFlash: $('openingFlash'),
  sceneRoulette: $('sceneRoulette'),
  rouletteRound: $('rouletteRound'),
  rouletteEntrants: $('rouletteEntrants'),
  rouletteTickets: $('rouletteTickets'),
  entrantList: $('entrantList'),
  wheelCanvas: $('wheelCanvas'),
  prizeOrder: $('prizeOrder'),
  prizeName: $('prizeName'),
  prizeSlot: $('prizeSlot'),
  prizeCard: $('prizeCard'),
  winnerMiniList: $('winnerMiniList'),
  winnerBanner: $('winnerBanner'),
  winnerName: $('winnerName'),
  winnerPrize: $('winnerPrize'),
  winnerOdds: $('winnerOdds'),
  sceneResult: $('sceneResult'),
  resultRound: $('resultRound'),
  resultList: $('resultList'),
  resultEmpty: $('resultEmpty'),
  confettiCanvas: $('confettiCanvas'),
};

el.idleWidget.dataset.pos = widgetPos;

// ---------------------------------------------------------------------------
// 공통 도우미
// ---------------------------------------------------------------------------

function formatNumber(num) {
  return Number(num || 0).toLocaleString('ko-KR');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function rankLabel(order) {
  return `${order}등`;
}

// 서버 시각과 이 PC 시각의 차이 (연출을 서버 기준으로 맞추기 위함)
let serverOffsetMs = 0;
function serverNow() {
  return Date.now() + serverOffsetMs;
}

// ---------------------------------------------------------------------------
// 장면 연출 큐
// 이벤트가 연달아 와도(목표 달성 → 룰렛 시작 → 당첨) 연출이 겹치지 않도록 하나씩 순서대로 실행합니다.
// interrupt()를 부르면 진행 중인 연출은 다음 대기 지점에서 조용히 멈춥니다. (세대 번호 방식)
// ---------------------------------------------------------------------------

let generation = 0;
let chain = Promise.resolve();

function enqueue(task) {
  const gen = generation;
  chain = chain
    .then(() => (gen === generation ? task(gen) : null))
    .catch((error) => console.error('[overlay] 연출 오류:', error));
}

function interrupt() {
  generation += 1;
  chain = Promise.resolve();
}

function alive(gen) {
  return gen === generation;
}

async function wait(ms, gen) {
  await sleep(ms);
  return alive(gen);
}

// ---------------------------------------------------------------------------
// 장면 표시/숨김
// ---------------------------------------------------------------------------

let currentScene = 'none'; // none | idle | opening | roulette | result
const SCENE_ELEMENTS = {
  idle: () => el.idleWidget,
  opening: () => el.sceneOpening,
  roulette: () => el.sceneRoulette,
  result: () => el.sceneResult,
};

function showScene(name) {
  for (const [key, getter] of Object.entries(SCENE_ELEMENTS)) {
    const node = getter();
    node.classList.remove('is-leaving');
    node.hidden = key !== name;
  }
  currentScene = name;
  if (name !== 'idle') clearToasts();
}

// ---------------------------------------------------------------------------
// ① 기본 게이지
// ---------------------------------------------------------------------------

let shownAmount = 0;
let amountTween = null;

function tweenAmount(to) {
  if (amountTween) cancelAnimationFrame(amountTween);
  const from = shownAmount;
  if (from === to) {
    el.idleCurrent.textContent = formatNumber(to);
    return;
  }
  const start = performance.now();
  const duration = 700;
  const step = (now) => {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    shownAmount = Math.round(from + (to - from) * eased);
    el.idleCurrent.textContent = formatNumber(shownAmount);
    amountTween = t < 1 ? requestAnimationFrame(step) : null;
  };
  amountTween = requestAnimationFrame(step);
}

function pop(node) {
  node.classList.remove('value-pop');
  void node.offsetWidth;
  node.classList.add('value-pop');
}

function renderIdle(state, { bump = false } = {}) {
  const { event } = state;
  el.idleRound.textContent = `${event.roundNo}회차`;
  el.idleTarget.textContent = formatNumber(event.targetAmount);
  el.idleRemaining.textContent = formatNumber(event.remainingAmount);
  el.idleHint.textContent = `${formatNumber(event.ticketUnit)}개당 응모권 1장`;
  el.gaugeFill.style.width = `${event.percent}%`;
  el.miniBox.classList.toggle('is-hot', event.percent >= 80);
  tweenAmount(event.displayAmount);
  if (bump) {
    pop(el.idleRemaining);
    el.miniBox.classList.remove('is-bump');
    void el.miniBox.offsetWidth;
    el.miniBox.classList.add('is-bump');
  }
}

// ---- 후원 알림 토스트 (게이지 화면에서만, 한 번에 하나씩) ----
const toastQueue = [];
let toastRunning = false;

function queueToast(donation, donor) {
  if (!donation) return;
  toastQueue.push({ donation, donor });
  if (toastQueue.length > 30) toastQueue.splice(0, toastQueue.length - 30); // 폭주 시 오래된 알림 버림
  if (!toastRunning) runToasts();
}

async function runToasts() {
  toastRunning = true;
  while (toastQueue.length > 0) {
    if (currentScene !== 'idle') {
      toastQueue.length = 0;
      break;
    }
    const { donation, donor } = toastQueue.shift();
    // 알림이 밀려 있으면 조금 빨리 넘깁니다.
    const holdMs = toastQueue.length > 3 ? 1200 : 2600;
    const node = document.createElement('div');
    node.className = 'toast';
    node.dataset.type = donation.type;
    const ticketBadge = donor && donor.tickets > 0 ? `<span class="toast-ticket">응모권 ${formatNumber(donor.tickets)}장</span>` : '';
    node.innerHTML = `
      <span class="toast-icon">${TYPE_ICONS[donation.type] || '🎁'}</span>
      <div>
        <div class="toast-name"><strong>${escapeHtml(donation.nickname)}</strong>님</div>
        <div class="toast-line">${TYPE_LABELS[donation.type] || ''} ${formatNumber(donation.amount)}개!${ticketBadge}</div>
      </div>`;
    el.toastArea.replaceChildren(node);
    await sleep(holdMs);
    node.classList.add('is-leaving');
    await sleep(350);
    node.remove();
  }
  toastRunning = false;
}

function clearToasts() {
  toastQueue.length = 0;
  el.toastArea.replaceChildren();
}

// ---------------------------------------------------------------------------
// ② 선물상자 오픈 연출
// 타임라인(기본 11초, 서버의 boxOpenMs에 비례): 목표 달성 문구 → 흔들림 → 강한 흔들림 + Glow
// → 3,2,1 카운트다운 → 터짐(섬광 + 꽃가루) → 서버가 ROULETTE_STARTED를 보내면 룰렛으로 전환
// fromMs: 이미 지난 시간 (OBS 새로고침 시 중간부터 이어서 재생)
// ---------------------------------------------------------------------------

let openingBurst = false;

function openingTimeline(boxOpenMs) {
  const k = boxOpenMs / 11000;
  return { shake: 1200 * k, hardShake: 3000 * k, countdown: 4200 * k, burst: 7400 * k };
}

function resetOpeningScene() {
  openingBurst = false;
  el.openingBoxWrap.className = 'opening-box-wrap';
  el.openingRays.classList.remove('is-on');
  el.openingFlash.classList.remove('is-on');
  el.openingCountdown.replaceChildren();
  el.openingSub.textContent = '';
  el.openingHeadline.textContent = '목표 달성!';
}

async function playOpening(state, fromMs, gen) {
  const tl = openingTimeline(state.timing.boxOpenMs);
  if (currentScene !== 'opening') {
    resetOpeningScene();
    showScene('opening');
  }
  el.openingHeadline.textContent = `${formatNumber(state.event.targetAmount)}개 목표 달성!`;
  el.openingSub.textContent = '선물상자가 열립니다…';
  let t = fromMs;

  if (t < tl.shake && !(await wait(tl.shake - t, gen))) return;
  t = Math.max(t, tl.shake);
  el.openingBoxWrap.classList.add('is-shaking');

  if (t < tl.hardShake && !(await wait(tl.hardShake - t, gen))) return;
  t = Math.max(t, tl.hardShake);
  el.openingBoxWrap.classList.remove('is-shaking');
  el.openingBoxWrap.classList.add('is-shaking-hard', 'is-glowing');
  el.openingRays.classList.add('is-on');

  if (t < tl.burst) {
    // 남은 시간에 맞춰 3 → 2 → 1 (중간부터 시작하면 남은 숫자만)
    const countStep = (tl.burst - tl.countdown) / 3;
    if (t < tl.countdown && !(await wait(tl.countdown - t, gen))) return;
    t = Math.max(t, tl.countdown);
    while (t < tl.burst) {
      const n = 3 - Math.floor((t - tl.countdown) / countStep);
      el.openingSub.textContent = '';
      el.openingCountdown.innerHTML = `<span class="count">${n}</span>`;
      const next = tl.countdown + (4 - n) * countStep;
      if (!(await wait(next - t, gen))) return;
      t = next;
    }
  }

  burstBox(fromMs > tl.burst + 1500);
}

// 상자 터짐: 뚜껑 날아감 + 섬광 + 꽃가루 (skipFlash: 새로고침으로 이미 지난 경우 조용히)
function burstBox(quiet = false) {
  if (openingBurst) return;
  openingBurst = true;
  el.openingCountdown.replaceChildren();
  el.openingBoxWrap.classList.remove('is-shaking', 'is-shaking-hard');
  el.openingBoxWrap.classList.add('is-open', 'is-glowing');
  el.openingRays.classList.add('is-on');
  el.openingHeadline.textContent = 'OPEN!';
  el.openingSub.textContent = '잠시 후 당첨자 추첨이 시작됩니다';
  if (!quiet) {
    el.openingFlash.classList.add('is-on');
    confetti.burst(960, 600, 260);
    setTimeout(() => confetti.rain(160), 400);
  }
}

// ---------------------------------------------------------------------------
// ③ 룰렛
// ---------------------------------------------------------------------------

const wheelCtx = el.wheelCanvas.getContext('2d');
let wheelPool = []; // 현재 룰렛판에 올라간 후보 [{ key, nickname, tickets }]
let wheelRotation = 0; // 라디안

function poolTotal(pool) {
  return pool.reduce((sum, entrant) => sum + entrant.tickets, 0);
}

function colorFor(index, count) {
  // 마지막 칸과 첫 칸이 같은 색이 되지 않게 보정합니다.
  let color = WHEEL_COLORS[index % WHEEL_COLORS.length];
  if (count > 1 && index === count - 1 && index % WHEEL_COLORS.length === 0) color = WHEEL_COLORS[3];
  return color;
}

function drawWheel() {
  const ctx = wheelCtx;
  const size = el.wheelCanvas.width;
  const c = size / 2;
  const r = c - 16;
  ctx.clearRect(0, 0, size, size);

  // 바깥 금테
  ctx.beginPath();
  ctx.arc(c, c, c - 4, 0, Math.PI * 2);
  ctx.fillStyle = '#a9772c';
  ctx.fill();

  const total = poolTotal(wheelPool);
  if (total === 0) {
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.fillStyle = '#1a1a1f';
    ctx.fill();
    return;
  }

  ctx.save();
  ctx.translate(c, c);
  ctx.rotate(wheelRotation);
  let angle = -Math.PI / 2;
  wheelPool.forEach((entrant, index) => {
    const slice = (entrant.tickets / total) * Math.PI * 2;
    const color = colorFor(index, wheelPool.length);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    if (wheelPool.length > 1) {
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // 칸이 충분히 넓을 때만 이름을 씁니다. (좁은 칸은 왼쪽 목록에서 확인)
    if (slice > 0.11) {
      const label = `${truncate(entrant.nickname, 9)} x${entrant.tickets}`;
      const fontSize = Math.max(22, Math.min(44, slice * 120));
      const mid = angle + slice / 2;
      // 화면 왼쪽 절반에 있는 칸은 글자가 뒤집혀 보이지 않도록 180도 돌려서 씁니다.
      const screenAngle = (((mid + wheelRotation) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const flipped = screenAngle > Math.PI / 2 && screenAngle < (Math.PI * 3) / 2;
      ctx.save();
      ctx.rotate(mid);
      ctx.textBaseline = 'middle';
      ctx.font = `800 ${fontSize}px Pretendard, 'Malgun Gothic', sans-serif`;
      ctx.fillStyle = DARK_TEXT_COLORS.has(color) ? '#2a1606' : '#fff6e0';
      if (flipped) {
        ctx.translate(r - 34, 0);
        ctx.rotate(Math.PI);
        ctx.textAlign = 'left';
        ctx.fillText(label, 0, 0);
      } else {
        ctx.textAlign = 'right';
        ctx.fillText(label, r - 34, 0);
      }
      ctx.restore();
    }
    angle += slice;
  });
  ctx.restore();

  // 안쪽 그림자 링
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 243, 209, 0.6)';
  ctx.lineWidth = 6;
  ctx.stroke();
}

function truncate(text, max) {
  const chars = Array.from(text || '');
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

function renderEntrantList(pool, allEntrants) {
  const total = poolTotal(pool);
  const inPool = new Set(pool.map((p) => p.key));
  const colorByKey = new Map(pool.map((p, i) => [p.key, colorFor(i, pool.length)]));
  const MAX_ROWS = 12;
  const rows = allEntrants.slice(0, MAX_ROWS).map((entrant) => {
    const out = !inPool.has(entrant.key);
    const pct = !out && total > 0 ? `${((entrant.tickets / total) * 100).toFixed(1)}%` : '-';
    const swatch = colorByKey.get(entrant.key) || 'transparent';
    return `<li class="${out ? 'is-out' : ''}">
      <span class="swatch" style="background:${swatch}"></span>
      <span class="name">${escapeHtml(entrant.nickname)}</span>
      <span class="tickets">x${formatNumber(entrant.tickets)}</span>
      <span class="pct">${pct}</span>
    </li>`;
  });
  if (allEntrants.length > MAX_ROWS) {
    rows.push(`<li class="more">외 ${formatNumber(allEntrants.length - MAX_ROWS)}명</li>`);
  }
  el.entrantList.innerHTML = rows.join('');
}

function renderWinnerMiniList(winners) {
  el.winnerMiniList.innerHTML = winners
    .slice(-8)
    .map((w) => `<li>
      <span class="rank">${rankLabel(w.prize.order)}</span>
      <span class="name">${escapeHtml(w.nickname)}</span>
      <span class="prize">${escapeHtml(w.prize.name)}</span>
    </li>`)
    .join('');
}

function renderPrizeCard(slot, totalSlots) {
  if (!slot) {
    el.prizeCard.hidden = true;
    return;
  }
  el.prizeCard.hidden = false;
  el.prizeOrder.textContent = rankLabel(slot.prize.order);
  el.prizeName.textContent = slot.prize.name;
  el.prizeSlot.textContent = `추첨 ${slot.slotNo} / ${totalSlots}`;
}

// 룰렛 화면을 "다음 추첨 대기" 상태로 그립니다.
function renderRoulette(state, { pool = state.drawPool, slot = state.nextSlot, winners = state.winners } = {}) {
  el.rouletteRound.textContent = `${state.event.roundNo}회차`;
  el.rouletteEntrants.textContent = formatNumber(state.stats.entrantCount);
  el.rouletteTickets.textContent = formatNumber(state.stats.totalTickets);
  renderEntrantList(pool, state.entrants);
  renderWinnerMiniList(winners);
  renderPrizeCard(slot, state.totalSlots);
  wheelPool = pool;
  drawWheel();
}

// 당첨자 칸이 포인터(12시 방향)에 오도록 회전시킵니다.
function spinTo(winnerKey, durationMs, gen) {
  const total = poolTotal(wheelPool);
  let before = 0;
  let winnerTickets = 0;
  for (const entrant of wheelPool) {
    if (entrant.key === winnerKey) {
      winnerTickets = entrant.tickets;
      break;
    }
    before += entrant.tickets;
  }
  // 칸 안의 임의 위치(가장자리 15%는 피함)에 멈추게 해서 "아슬아슬한" 느낌을 줍니다.
  const within = 0.15 + Math.random() * 0.7;
  const targetAngle = ((before + winnerTickets * within) / total) * Math.PI * 2;
  const TWO_PI = Math.PI * 2;
  const start = wheelRotation;
  const normalized = ((-targetAngle - start) % TWO_PI + TWO_PI) % TWO_PI;
  const end = start + TWO_PI * 7 + normalized;

  return new Promise((resolve) => {
    const startTime = performance.now();
    const frame = (now) => {
      if (!alive(gen)) return resolve(false);
      const t = Math.min((now - startTime) / durationMs, 1);
      const eased = 1 - Math.pow(1 - t, 4); // 처음엔 빠르게, 끝에서 천천히
      wheelRotation = start + (end - start) * eased;
      drawWheel();
      if (t < 1) requestAnimationFrame(frame);
      else {
        wheelRotation = end % TWO_PI;
        resolve(true);
      }
    };
    requestAnimationFrame(frame);
  });
}

function showWinnerBanner(winner) {
  el.winnerName.textContent = winner.nickname;
  el.winnerPrize.textContent = `${rankLabel(winner.prize.order)} · ${winner.prize.name}`;
  const pct = winner.totalTickets > 0 ? ((winner.tickets / winner.totalTickets) * 100).toFixed(1) : '0';
  el.winnerOdds.textContent = `응모권 ${formatNumber(winner.tickets)}장 / ${formatNumber(winner.totalTickets)}장 (${pct}%)`;
  el.winnerBanner.hidden = false;
}

function hideWinnerBanner() {
  el.winnerBanner.hidden = true;
}

// 당첨 연출: 추첨 당시의 룰렛판(pool)으로 돌려서 당첨자에게 멈춘 뒤 배너 표시
async function playWinner(state, message, gen, { skipSpin = false, holdMs } = {}) {
  const { winner, pool } = message;
  const winnersBefore = state.winners.filter((w) => w.slotNo < winner.slotNo);
  if (currentScene !== 'roulette') showScene('roulette');
  hideWinnerBanner();
  renderRoulette(state, { pool, slot: { slotNo: winner.slotNo, prize: winner.prize }, winners: winnersBefore });

  if (!skipSpin) {
    const done = await spinTo(winner.key, state.timing.spinMs, gen);
    if (!done) return;
  }
  showWinnerBanner(winner);
  confetti.burst(960, 520, 200);
  renderWinnerMiniList(state.winners.filter((w) => w.slotNo <= winner.slotNo));
  if (!(await wait(holdMs ?? state.timing.winnerHoldMs, gen))) return;
  hideWinnerBanner();
  if (latestState && latestState.event.status === 'ROULETTE') renderRoulette(latestState);
}

// ---------------------------------------------------------------------------
// ④ 결과
// ---------------------------------------------------------------------------

function renderResult(state) {
  el.resultRound.textContent = `${state.event.roundNo}회차`;
  const slots = [];
  const sortedPrizes = [...state.prizes].sort((a, b) => a.order - b.order);
  for (const prize of sortedPrizes) {
    for (let i = 0; i < prize.quantity; i += 1) slots.push(prize);
  }
  const winnersBySlot = new Map(state.winners.map((w) => [w.slotNo, w]));
  const noWinners = state.winners.length === 0;
  el.resultEmpty.hidden = !noWinners;
  el.resultList.hidden = noWinners;
  el.resultList.classList.toggle('is-compact', slots.length > 8);
  el.resultList.innerHTML = slots
    .slice(0, 16)
    .map((prize, index) => {
      const winner = winnersBySlot.get(index + 1);
      return `<li class="${prize.order === 1 ? 'rank-1' : ''} ${winner ? '' : 'is-empty'}" style="animation-delay:${index * 0.12}s">
        <span class="r-rank">${rankLabel(prize.order)}</span>
        <span class="r-name">${winner ? escapeHtml(winner.nickname) : '당첨자 없음'}</span>
        <span class="r-prize">${escapeHtml(prize.name)}</span>
      </li>`;
    })
    .join('');
}

async function playResult(state, gen) {
  if (currentScene === 'roulette') {
    el.sceneRoulette.classList.add('is-leaving');
    if (!(await wait(450, gen))) return;
  }
  renderResult(state);
  showScene('result');
  if (state.winners.length > 0) confetti.rain(220);
}

// ---------------------------------------------------------------------------
// 꽃가루 (가벼운 canvas 파티클, 외부 라이브러리 없음)
// ---------------------------------------------------------------------------

const confetti = (() => {
  const canvas = el.confettiCanvas;
  const ctx = canvas.getContext('2d');
  canvas.width = 1920;
  canvas.height = 1080;
  const colors = ['#e8bf6a', '#fff3d1', '#c2263f', '#ea4a63', '#ffffff', '#f4c430', '#6aa8ff'];
  let particles = [];
  let running = false;

  function add(x, y, vx, vy) {
    particles.push({
      x, y, vx, vy,
      w: 8 + Math.random() * 10,
      h: 5 + Math.random() * 8,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: colors[Math.floor(Math.random() * colors.length)],
      life: 1,
    });
    if (particles.length > 900) particles.splice(0, particles.length - 900);
    if (!running) {
      running = true;
      requestAnimationFrame(tick);
    }
  }

  function burst(x, y, count) {
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 6 + Math.random() * 16;
      add(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed - 8);
    }
  }

  function rain(count) {
    for (let i = 0; i < count; i += 1) {
      add(Math.random() * 1920, -20 - Math.random() * 400, (Math.random() - 0.5) * 3, 2 + Math.random() * 4);
    }
  }

  let last = performance.now();
  function tick(now) {
    const dt = Math.min((now - last) / 16.67, 3);
    last = now;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles = particles.filter((p) => p.y < 1140 && p.life > 0);
    for (const p of particles) {
      p.vy += 0.32 * dt;
      p.vx *= 0.99;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.vy > 0) p.life -= 0.003 * dt;
      ctx.save();
      ctx.globalAlpha = Math.max(p.life, 0);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot * 2)));
      ctx.restore();
    }
    if (particles.length > 0) requestAnimationFrame(tick);
    else {
      running = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  return { burst, rain };
})();

// ---------------------------------------------------------------------------
// 상태 동기화 (첫 접속 / OBS 새로고침 / 서버 재시작 후 재연결)
// ---------------------------------------------------------------------------

let latestState = null;
let syncedSignature = null;

function signatureOf(state) {
  return `${state.event.id}|${state.event.status}|${state.winners.length}`;
}

function lastWinnerElapsed(state) {
  const last = state.winners[state.winners.length - 1];
  if (!last) return null;
  return { winner: last, elapsed: serverNow() - Date.parse(last.selectedAt) };
}

// 현재 상태를 보고 "지금 이 순간 보여야 할 장면"으로 바로 맞춥니다.
function resync(state) {
  const signature = signatureOf(state);
  // 재연결했는데 상태가 그대로면 진행 중인 연출을 끊지 않고 숫자만 갱신합니다.
  if (signature === syncedSignature) {
    if (currentScene === 'idle') renderIdle(state);
    return;
  }
  syncedSignature = signature;
  interrupt();
  hideWinnerBanner();

  const { status } = state.event;
  const { spinMs, winnerHoldMs } = state.timing;

  if (status === 'READY' || status === 'FINISHED') {
    showScene('none');
    return;
  }
  if (status === 'ACTIVE') {
    showScene('idle');
    renderIdle(state);
    return;
  }
  if (status === 'BOX_OPENING') {
    const elapsed = serverNow() - Date.parse(state.event.statusChangedAt);
    enqueue((gen) => playOpening(state, Math.max(elapsed, 0), gen));
    return;
  }

  // ROULETTE / RESULT: 마지막 당첨 연출이 아직 진행 중이어야 할 시간이면 배너부터 보여줍니다.
  const recent = lastWinnerElapsed(state);
  if (recent && recent.elapsed < spinMs + winnerHoldMs) {
    const remainHold = Math.min(winnerHoldMs, spinMs + winnerHoldMs - recent.elapsed);
    const pool = recent.winner && status === 'ROULETTE' ? state.drawPool : state.entrants;
    enqueue((gen) => playWinner(state, { winner: recent.winner, pool }, gen, { skipSpin: true, holdMs: remainHold }));
  } else if (status === 'ROULETTE') {
    showScene('roulette');
    renderRoulette(state);
  }
  if (status === 'RESULT') enqueue((gen) => playResult(state, gen));
}

// ---------------------------------------------------------------------------
// 실시간 이벤트 처리
// ---------------------------------------------------------------------------

function handleMessage(message) {
  const state = message.state;
  if (!state) return;
  serverOffsetMs = Date.parse(state.serverTime) - Date.now();
  latestState = state;

  switch (message.type) {
    case 'STATE_SYNC':
      resync(state);
      break;

    case 'DONATION_RECEIVED':
      if (state.event.status === 'ACTIVE' || state.event.status === 'BOX_OPENING') {
        if (currentScene === 'idle') {
          renderIdle(state, { bump: true });
          queueToast(message.donation, message.donor);
        }
      }
      break;

    case 'PROGRESS_UPDATED':
    case 'SETTINGS_UPDATED':
    case 'DONATION_CANCELED':
      // 시작/종료/목표 복귀처럼 상태가 바뀌었으면 장면을 다시 맞추고, 아니면 숫자만 갱신합니다.
      // (BOX_OPENING/ROULETTE/RESULT로의 전환은 각각 BOX_OPEN/ROULETTE_STARTED/RESULT_READY가 연출을 담당)
      if (signatureOf(state) !== syncedSignature) {
        if (['READY', 'ACTIVE', 'FINISHED'].includes(state.event.status)) resync(state);
      }
      else if (currentScene === 'idle') renderIdle(state);
      else if (currentScene === 'roulette' && state.event.status === 'ROULETTE' && el.winnerBanner.hidden) renderRoulette(state);
      break;

    case 'GOAL_REACHED':
      // 게이지를 100%로 채운 모습을 잠깐 보여준 뒤 BOX_OPEN 연출로 넘어갑니다.
      if (currentScene === 'idle') renderIdle(state, { bump: true });
      break;

    case 'BOX_OPEN': {
      syncedSignature = signatureOf(state);
      const elapsed = serverNow() - Date.parse(state.event.statusChangedAt);
      enqueue(async (gen) => {
        // 목표를 채운 마지막 후원 알림과 100% 게이지를 잠깐 보여준 뒤 오픈 연출로 넘어갑니다.
        const lead = currentScene === 'idle' ? 1600 : 0;
        if (lead && !(await wait(lead, gen))) return;
        await playOpening(state, Math.max(elapsed, 0) + lead, gen);
      });
      break;
    }

    case 'ROULETTE_STARTED':
      syncedSignature = signatureOf(state);
      enqueue(async (gen) => {
        // 관리자가 "룰렛 강제 실행"으로 연출을 건너뛴 경우에도 터지는 장면은 짧게 보여줍니다.
        if (currentScene === 'opening' && !openingBurst) {
          burstBox();
          if (!(await wait(1500, gen))) return;
        } else if (currentScene === 'opening') {
          if (!(await wait(800, gen))) return;
        }
        if (message.noEntrants) return; // 곧 RESULT_READY가 옵니다.
        el.sceneOpening.classList.add('is-leaving');
        if (currentScene === 'opening' && !(await wait(400, gen))) return;
        showScene('roulette');
        wheelRotation = 0;
        renderRoulette(state);
      });
      break;

    case 'WINNER_SELECTED':
      syncedSignature = signatureOf(state);
      enqueue((gen) => playWinner(state, message, gen));
      break;

    case 'RESULT_READY':
      syncedSignature = signatureOf(state);
      enqueue((gen) => playResult(state, gen));
      break;

    case 'ROUND_FINISHED':
      resync(state);
      break;

    default:
      break;
  }
}

// EventSource는 연결이 끊기면 자동으로 재연결하고, 서버는 재연결마다 STATE_SYNC를 다시 보내줍니다.
function connect() {
  const source = new EventSource('/api/gift/stream');
  source.onmessage = (event) => {
    try {
      handleMessage(JSON.parse(event.data));
    } catch (error) {
      console.error('[overlay] 메시지 처리 실패:', error);
    }
  };
  source.onerror = () => {
    // 브라우저가 알아서 재연결합니다. 완전히 닫힌 경우에만 직접 다시 엽니다.
    if (source.readyState === EventSource.CLOSED) {
      setTimeout(connect, 3000);
    }
  };
}

connect();
