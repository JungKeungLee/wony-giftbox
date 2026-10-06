// gift/giftEventService.js
// 선물상자 이벤트의 비즈니스 로직(상태 전환, 게이지, 응모권, 추첨)을 모두 담당합니다.
//
// [동시성 규칙]
// PostgreSQL은 여러 요청이 동시에 처리되므로, 데이터를 바꾸는 작업은 모두
//   1) 트랜잭션을 열고
//   2) 진행 중 회차 행을 SELECT ... FOR UPDATE 로 잠근 뒤
//   3) 상태를 확인하고 변경
// 하는 순서로 처리합니다. 같은 회차를 바꾸는 요청은 이 잠금 때문에 한 줄로 서서 처리되므로,
// 동시에 후원이 몰려도 currentAmount 계산이나 상태 전환이 꼬이지 않습니다.
// 추가로 상태 전환은 "UPDATE ... WHERE status = '현재'" 조건부 업데이트, 중복 후원/중복 당첨은
// DB UNIQUE 제약으로 한 번 더 막습니다.
//
// 후원이 어디서 왔는지(SOOP, 테스트, 수동 등록)는 알지 못합니다. donationService.js가
// 통일된 형식으로 바꿔서 applyDonation()을 호출해줍니다.

const crypto = require('crypto');
const {
  DEFAULT_TICKET_UNIT,
  MAX_TICKET_UNIT,
  normalizeTicketUnit,
  ticketCount,
  DONATION_TYPE_LABELS,
  aggregateDonors,
  weightedPick,
  expandPrizeSlots,
} = require('./tickets');

const STATUS = {
  READY: 'READY',
  ACTIVE: 'ACTIVE',
  BOX_OPENING: 'BOX_OPENING',
  ROULETTE: 'ROULETTE',
  RESULT: 'RESULT',
  FINISHED: 'FINISHED',
};

// 실시간 이벤트 이름 (SSE로 관리자/오버레이에 전달됩니다)
const EVENTS = {
  STATE_SYNC: 'STATE_SYNC',
  DONATION_RECEIVED: 'DONATION_RECEIVED',
  DONATION_CANCELED: 'DONATION_CANCELED',
  PROGRESS_UPDATED: 'PROGRESS_UPDATED',
  GOAL_REACHED: 'GOAL_REACHED',
  BOX_OPEN: 'BOX_OPEN',
  ROULETTE_STARTED: 'ROULETTE_STARTED',
  WINNER_SELECTED: 'WINNER_SELECTED',
  RESULT_READY: 'RESULT_READY',
  ROUND_FINISHED: 'ROUND_FINISHED',
  SETTINGS_UPDATED: 'SETTINGS_UPDATED',
};

const DEFAULT_TARGET_AMOUNT = 1000;
const MAX_TARGET_AMOUNT = 100000000;
const MAX_PRIZE_SLOTS = 100;

// 관리자에게 그대로 보여줄 수 있는 업무 오류입니다. (HTTP 상태 코드 포함)
class GiftError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// PostgreSQL UNIQUE 제약 위반 (SQLSTATE 23505)
// 관리자 입력(응모권 지급 기준)을 검증합니다. 1 이상의 정수만 허용 (0, 음수, 소수, 문자 거절)
function parseTicketUnit(value) {
  const text = typeof value === 'string' ? value.trim() : value;
  const unit = typeof text === 'number' ? text : /^\d+$/.test(String(text ?? '')) ? Number(text) : NaN;
  if (!Number.isInteger(unit) || unit < 1) {
    throw new GiftError('INVALID_TICKET_UNIT', '응모권 지급 기준은 1 이상의 정수여야 합니다.');
  }
  if (unit > MAX_TICKET_UNIT) {
    throw new GiftError('INVALID_TICKET_UNIT', `응모권 지급 기준은 ${MAX_TICKET_UNIT.toLocaleString('ko-KR')} 이하로 입력해주세요.`);
  }
  return unit;
}

function isUniqueViolation(error) {
  return Boolean(error) && error.code === '23505';
}

function toIso(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

class GiftEventService {
  // database: database.js의 공통 인터페이스 (pg 또는 PGlite)
  // options
  //  - now(): 현재 시각(Date). 테스트에서 시간을 고정할 때 사용
  //  - randomInt(max): 추첨용 난수. 테스트에서 결과를 고정할 때 사용
  //  - publish(type, payload): 실시간 전송 함수 (realtime.js)
  //  - boxOpenMs: 목표 달성 → 룰렛 화면까지의 오픈 연출 시간
  //  - spinMs / winnerHoldMs: 룰렛 회전 시간 / 당첨자 표시 시간 (다음 추첨까지의 최소 간격)
  //  - scheduleTimers: false면 BOX_OPENING → ROULETTE 자동 전환 타이머를 쓰지 않음 (테스트용)
  // 생성 후 반드시 await service.init()을 호출해야 합니다.
  constructor(database, options = {}) {
    this.db = database;
    this.now = options.now || (() => new Date());
    this.randomInt = options.randomInt;
    this.publishFn = options.publish || (() => {});
    this.boxOpenMs = options.boxOpenMs ?? 11000;
    this.spinMs = options.spinMs ?? 6500;
    this.winnerHoldMs = options.winnerHoldMs ?? 4000;
    this.scheduleTimers = options.scheduleTimers ?? true;
    this.boxOpenTimer = null;
    // 실시간 메시지를 보내는 순서를 지키기 위한 줄(queue)입니다. (동시 요청이어도 오래된 상태가 나중에 가지 않게)
    this.publishChain = Promise.resolve();
  }

  async init() {
    await this.ensureOpenEvent();
    await this.resumeTimers();
    return this;
  }

  nowIso() {
    return this.now().toISOString();
  }

  // ---------------------------------------------------------------------------
  // 조회 (q: 트랜잭션 tx 또는 this.db)
  // ---------------------------------------------------------------------------

  async getOpenEvent(q = this.db) {
    const { rows } = await q.query("SELECT * FROM gift_event WHERE status <> 'FINISHED' ORDER BY id DESC LIMIT 1");
    return rows[0] ? mapEvent(rows[0]) : null;
  }

  async requireOpenEvent(q = this.db) {
    const event = await this.getOpenEvent(q);
    if (!event) throw new GiftError('NO_EVENT', '진행 중인 회차가 없습니다.', 409);
    return event;
  }

  // 진행 중 회차 행을 잠급니다. 트랜잭션이 끝날 때까지 같은 회차를 바꾸려는 다른 요청은 기다립니다.
  async lockOpenEvent(tx) {
    const { rows } = await tx.query(
      "SELECT * FROM gift_event WHERE status <> 'FINISHED' ORDER BY id DESC LIMIT 1 FOR UPDATE"
    );
    if (!rows[0]) throw new GiftError('NO_EVENT', '진행 중인 회차가 없습니다.', 409);
    return mapEvent(rows[0]);
  }

  async lockEventById(tx, eventId) {
    const { rows } = await tx.query('SELECT * FROM gift_event WHERE id = $1 FOR UPDATE', [eventId]);
    return rows[0] ? mapEvent(rows[0]) : null;
  }

  async getEventById(eventId, q = this.db) {
    const { rows } = await q.query('SELECT * FROM gift_event WHERE id = $1', [eventId]);
    return rows[0] ? mapEvent(rows[0]) : null;
  }

  async getLatestEvent(q = this.db) {
    const { rows } = await q.query('SELECT * FROM gift_event ORDER BY id DESC LIMIT 1');
    return rows[0] ? mapEvent(rows[0]) : null;
  }

  async getPrizes(eventId, q = this.db) {
    const { rows } = await q.query(
      'SELECT * FROM gift_prize WHERE event_id = $1 ORDER BY prize_order ASC, id ASC',
      [eventId]
    );
    return rows.map(mapPrize);
  }

  async getWinners(eventId, q = this.db) {
    const { rows } = await q.query(
      `SELECT w.*, p.prize_name, p.prize_order
         FROM gift_winner w JOIN gift_prize p ON p.id = w.prize_id
        WHERE w.event_id = $1 ORDER BY w.slot_no ASC`,
      [eventId]
    );
    return rows.map(mapWinner);
  }

  // 해당 회차에서 "인정된(COUNTED)" 후원만 모아 후원자별로 합산합니다.
  // 취소(CANCELED) / 무시(IGNORED)된 후원은 응모권 계산에서 빠집니다.
  async getDonors(event, q = this.db) {
    const { rows } = await q.query(
      `SELECT donor_key, donor_id, nickname, donation_type, amount
         FROM gift_donation WHERE event_id = $1 AND status = 'COUNTED' ORDER BY id ASC`,
      [event.id]
    );
    const donations = rows.map((row) => ({
      donorKey: row.donor_key,
      donorId: row.donor_id,
      nickname: row.nickname,
      type: row.donation_type,
      amount: row.amount,
    }));
    return aggregateDonors(donations, event.ticketUnit);
  }

  async getDonations(eventId, { limit } = {}, q = this.db) {
    const { rows } = limit
      ? await q.query('SELECT * FROM gift_donation WHERE event_id = $1 ORDER BY id DESC LIMIT $2', [eventId, limit])
      : await q.query('SELECT * FROM gift_donation WHERE event_id = $1 ORDER BY id DESC', [eventId]);
    return rows.map(mapDonation);
  }

  async getLogs(eventId, q = this.db, limit = null) {
    const { rows } = limit
      ? await q.query('SELECT * FROM gift_event_log WHERE event_id = $1 ORDER BY id DESC LIMIT $2', [eventId, limit])
      : await q.query('SELECT * FROM gift_event_log WHERE event_id = $1 ORDER BY id DESC', [eventId]);
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      detail: typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail,
      createdAt: toIso(row.created_at),
    }));
  }

  // 다음 추첨 대상(룰렛에 올라갈 후보)입니다.
  // 응모권 1장 이상인 사람 중, 이번 회차에 아직 당첨되지 않은 사람만 들어갑니다. (중복 당첨 불가 고정 규칙)
  // 당첨자는 후보에서만 빠질 뿐, 후원/응모 기록은 그대로 남습니다.
  getDrawPool(donors, winners) {
    const wonKeys = new Set(winners.map((winner) => winner.donorKey));
    return donors.filter((donor) => donor.tickets > 0 && !wonKeys.has(donor.donorKey));
  }

  // OBS 오버레이에 보내는 공개 상태입니다. donorId 같은 내부 값은 넣지 않습니다.
  // snapshot: 여러 쿼리가 같은 시점의 데이터를 보도록 읽기 전용 트랜잭션으로 묶습니다.
  async getPublicState() {
    const { _internal, ...publicState } = await this.getPublicStateWithInternal();
    return publicState;
  }

  async buildPublicState(q, event) {
    const prizes = await this.getPrizes(event.id, q);
    const donors = await this.getDonors(event, q);
    const winners = await this.getWinners(event.id, q);
    const entrants = donors.filter((donor) => donor.tickets > 0);
    const drawPool = this.getDrawPool(donors, winners);
    const slots = expandPrizeSlots(prizes);
    const nextSlot = slots[winners.length] || null;
    const displayAmount = Math.min(event.currentAmount, event.targetAmount);

    return {
      serverTime: this.nowIso(),
      timing: { boxOpenMs: this.boxOpenMs, spinMs: this.spinMs, winnerHoldMs: this.winnerHoldMs },
      event: {
        id: event.id,
        roundNo: event.roundNo,
        status: event.status,
        statusChangedAt: event.statusChangedAt,
        targetAmount: event.targetAmount,
        currentAmount: event.currentAmount, // 실제 누적 (목표 초과 가능)
        displayAmount, // 게이지 표시용 (목표에서 멈춤)
        remainingAmount: Math.max(event.targetAmount - event.currentAmount, 0),
        percent: Math.min((event.currentAmount / event.targetAmount) * 100, 100),
        ticketUnit: event.ticketUnit,
        winnerCount: event.winnerCount,
        goalReachedAt: event.goalReachedAt,
      },
      prizes: prizes.map(publicPrize),
      stats: {
        participantCount: donors.length,
        entrantCount: entrants.length,
        totalTickets: entrants.reduce((sum, entrant) => sum + entrant.tickets, 0),
      },
      entrants: entrants.map(publicEntrant),
      drawPool: drawPool.map(publicEntrant),
      winners: winners.map(publicWinner),
      nextSlot: nextSlot ? { slotNo: nextSlot.slotNo, prize: publicPrize(nextSlot.prize) } : null,
      totalSlots: slots.length,
      // 관리자 상태 조립용 (공개 응답에서는 제거)
      _internal: { event, donors, winners },
    };
  }

  // 관리자 화면용 상태: 공개 상태 + 후원자 상세 + 최근 후원 + 다음 추첨 가능 시각
  getAdminState() {
    return this.db.snapshot(async (tx) => {
      const event = await this.requireOpenEvent(tx);
      const { _internal, ...publicState } = await this.buildPublicState(tx, event);
      const lastWinner = _internal.winners[_internal.winners.length - 1];
      return {
        ...publicState,
        donors: _internal.donors,
        recentDonations: await this.getDonations(event.id, { limit: 200 }, tx),
        nextDrawAvailableAt: lastWinner
          ? new Date(Date.parse(lastWinner.selectedAt) + this.spinMs + this.winnerHoldMs).toISOString()
          : null,
        logs: await this.getLogs(event.id, tx, 50),
      };
    });
  }

  // 회차 기록 목록 (최신순). COUNT/SUM은 PostgreSQL에서 bigint라서 ::int로 바꿔 숫자로 받습니다.
  async listRounds() {
    const { rows } = await this.db.query(
      `SELECT e.*,
              (SELECT COUNT(DISTINCT d.donor_key) FROM gift_donation d WHERE d.event_id = e.id AND d.status = 'COUNTED')::int AS participant_count,
              (SELECT COALESCE(SUM(d.amount), 0) FROM gift_donation d WHERE d.event_id = e.id AND d.status = 'COUNTED')::int AS donation_total,
              (SELECT COUNT(*) FROM gift_winner w WHERE w.event_id = e.id)::int AS drawn_count
         FROM gift_event e ORDER BY e.round_no DESC`
    );
    return rows.map((row) => ({
      ...mapEvent(row),
      participantCount: row.participant_count,
      donationTotal: row.donation_total,
      drawnCount: row.drawn_count,
    }));
  }

  // 회차 하나의 전체 기록: 목표/총 후원/참여자/후원 내역/응모권/당첨자/상품/시작·종료 시간
  getRoundDetail(eventId) {
    return this.db.snapshot(async (tx) => {
      const event = await this.getEventById(eventId, tx);
      if (!event) throw new GiftError('NOT_FOUND', '해당 회차를 찾을 수 없습니다.', 404);
      const donors = await this.getDonors(event, tx);
      return {
        event,
        donationTotal: donors.reduce((sum, donor) => sum + donor.total, 0),
        donors,
        donations: await this.getDonations(event.id, {}, tx),
        prizes: await this.getPrizes(event.id, tx),
        winners: await this.getWinners(event.id, tx),
        logs: await this.getLogs(event.id, tx),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // 내부 도우미
  // ---------------------------------------------------------------------------

  async log(tx, eventId, action, detail) {
    await tx.query(
      'INSERT INTO gift_event_log (event_id, action, detail, created_at) VALUES ($1, $2, $3::jsonb, $4)',
      [eventId, action, detail ? JSON.stringify(detail) : null, this.nowIso()]
    );
  }

  // 조건부 상태 전환. 현재 상태가 fromStatuses 중 하나일 때만 toStatus로 바꿉니다. 바뀌었으면 true
  async transition(tx, eventId, fromStatuses, toStatus, extraSets = {}) {
    const now = this.nowIso();
    const params = [toStatus, now, eventId];
    const sets = ['status = $1', 'status_changed_at = $2', 'updated_at = $2'];
    for (const [column, value] of Object.entries(extraSets)) {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
    const placeholders = fromStatuses.map((status) => {
      params.push(status);
      return `$${params.length}`;
    });
    const result = await tx.query(
      `UPDATE gift_event SET ${sets.join(', ')} WHERE id = $3 AND status IN (${placeholders.join(', ')})`,
      params
    );
    return result.rowCount === 1;
  }

  assertStatus(event, allowed, actionLabel) {
    if (!allowed.includes(event.status)) {
      throw new GiftError('INVALID_STATUS', `현재 상태(${event.status})에서는 ${actionLabel}할 수 없습니다.`, 409);
    }
  }

  // 새 회차를 READY 상태로 만듭니다. 직전 회차의 목표/상품 설정을 그대로 복사해서
  // 관리자가 매번 다시 입력하지 않아도 되게 합니다. (current_amount는 반드시 0부터 시작)
  async createNextEvent(tx, previous) {
    const now = this.nowIso();
    const { rows: maxRows } = await tx.query('SELECT COALESCE(MAX(round_no), 0) AS max_round FROM gift_event');
    const nextRound = maxRows[0].max_round + 1;
    const template = previous || (await this.getLatestEvent(tx));
    const prevPrizes = template ? await this.getPrizes(template.id, tx) : [];

    const { rows } = await tx.query(
      `INSERT INTO gift_event
         (round_no, target_amount, current_amount, ticket_unit, winner_count,
          status, status_changed_at, created_at, updated_at)
       VALUES ($1, $2, 0, $3, $4, 'READY', $5, $5, $5)
       RETURNING id`,
      [
        nextRound,
        template ? template.targetAmount : DEFAULT_TARGET_AMOUNT,
        template ? template.ticketUnit : DEFAULT_TICKET_UNIT,
        prevPrizes.reduce((sum, prize) => sum + prize.quantity, 0),
        now,
      ]
    );
    const eventId = rows[0].id;

    for (const prize of prevPrizes) {
      await tx.query(
        'INSERT INTO gift_prize (event_id, prize_order, prize_name, quantity, created_at) VALUES ($1, $2, $3, $4, $5)',
        [eventId, prize.prizeOrder, prize.prizeName, prize.quantity, now]
      );
    }
    await this.log(tx, eventId, 'ROUND_CREATED', { roundNo: nextRound, copiedFromEventId: template ? template.id : null });
    return this.getEventById(eventId, tx);
  }

  async ensureOpenEvent() {
    try {
      return await this.db.transaction(async (tx) => (await this.getOpenEvent(tx)) || this.createNextEvent(tx, null));
    } catch (error) {
      // 서버 두 대가 동시에 첫 회차를 만들려고 한 경우: 먼저 만든 쪽을 그대로 씁니다.
      if (isUniqueViolation(error)) return this.requireOpenEvent();
      throw error;
    }
  }

  // 실시간 메시지 전송. 순서를 지키기 위해 한 줄로 세워서 보내며, 보내는 시점의 최신 상태를 담습니다.
  // 전송 실패(DB 일시 오류 등)가 원래 작업(후원 등록 등)을 실패시키지 않도록 예외를 삼킵니다.
  publish(type, extra = {}) {
    return this.inPublishOrder(async () => {
      let state = null;
      try {
        state = await this.getPublicState();
      } catch (error) {
        console.error('[gift] 상태 조회 실패:', error.message);
      }
      this.publishFn(type, { ...extra, state });
    });
  }

  // SSE 새 연결의 STATE_SYNC도 같은 줄에서 보내야, 직전에 보낸 이벤트보다 오래된 상태가 뒤늦게 가지 않습니다.
  inPublishOrder(task) {
    const run = this.publishChain.then(task);
    this.publishChain = run.catch(() => {});
    return run.catch((error) => console.error('[gift] 실시간 전송 실패:', error.message));
  }

  getPublicStateWithInternal() {
    return this.db.snapshot(async (tx) => this.buildPublicState(tx, await this.requireOpenEvent(tx)));
  }

  // ---------------------------------------------------------------------------
  // 타이머 (BOX_OPENING → ROULETTE 자동 전환)
  // ---------------------------------------------------------------------------

  // 서버가 재시작됐을 때 BOX_OPENING 상태였다면, DB에 저장된 status_changed_at을 기준으로
  // 남은 시간만큼만 기다렸다가 룰렛으로 넘어갑니다. (이미 지났으면 바로 넘어감)
  async resumeTimers() {
    const event = await this.getOpenEvent();
    if (event && event.status === STATUS.BOX_OPENING) {
      const elapsed = this.now().getTime() - Date.parse(event.statusChangedAt);
      this.scheduleRoulette(event.id, Math.max(this.boxOpenMs - elapsed, 0));
    }
  }

  scheduleRoulette(eventId, delayMs) {
    if (!this.scheduleTimers) return;
    this.clearTimers();
    this.boxOpenTimer = setTimeout(() => {
      this.boxOpenTimer = null;
      this.enterRoulette(eventId, 'AUTO').catch((error) => {
        // 그 사이 관리자가 강제 실행/초기화를 했다면 상태가 달라서 실패하는 게 정상입니다.
        if (!(error instanceof GiftError)) console.error('[gift] 룰렛 자동 전환 실패:', error);
      });
    }, delayMs);
    if (this.boxOpenTimer.unref) this.boxOpenTimer.unref();
  }

  clearTimers() {
    if (this.boxOpenTimer) {
      clearTimeout(this.boxOpenTimer);
      this.boxOpenTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // 설정
  // ---------------------------------------------------------------------------

  // 목표 개수 / 응모권 지급 기준(ticketUnit) 변경. 둘 중 보낸 값만 바꿉니다.
  // ticketUnit은 회차 설정값(gift_event.ticket_unit)이라 서버를 재시작해도 유지되고, 다음 회차에도 그대로 복사됩니다.
  // 응모권은 저장하지 않고 매번 "누적 후원 ÷ ticketUnit"으로 계산하므로, 수집 중에 바꾸면 기존 참여자 응모권도 새 기준으로 다시 계산됩니다.
  // 추첨 가중치가 흔들리지 않도록 룰렛/결과 단계에서는 바꿀 수 없습니다. (READY / ACTIVE에서만)
  async updateSettings({ targetAmount, ticketUnit } = {}) {
    if (targetAmount === undefined && ticketUnit === undefined) return this.getAdminState();
    const target = targetAmount === undefined ? undefined : Number(targetAmount);
    if (target !== undefined) {
      if (!Number.isInteger(target) || target <= 0) {
        throw new GiftError('INVALID_TARGET', '목표 개수는 1 이상의 정수여야 합니다.');
      }
      if (target > MAX_TARGET_AMOUNT) {
        throw new GiftError('INVALID_TARGET', `목표 개수는 ${MAX_TARGET_AMOUNT.toLocaleString('ko-KR')} 이하로 입력해주세요.`);
      }
    }
    const unit = ticketUnit === undefined ? undefined : parseTicketUnit(ticketUnit);

    const result = await this.db.transaction(async (tx) => {
      const event = await this.lockOpenEvent(tx);
      this.assertStatus(event, [STATUS.READY, STATUS.ACTIVE], target !== undefined ? '목표 개수를 변경' : '응모권 지급 기준을 변경');
      const now = this.nowIso();
      const changes = {};
      if (target !== undefined) {
        await tx.query('UPDATE gift_event SET target_amount = $1, updated_at = $2 WHERE id = $3', [target, now, event.id]);
        changes.targetAmount = target;
      }
      if (unit !== undefined) {
        await tx.query('UPDATE gift_event SET ticket_unit = $1, updated_at = $2 WHERE id = $3', [unit, now, event.id]);
        changes.ticketUnit = unit;
        changes.previousTicketUnit = event.ticketUnit;
      }
      await this.log(tx, event.id, 'SETTINGS_UPDATED', changes);
      // 수집 중에 목표를 현재값 이하로 낮추면 즉시 목표 달성 처리합니다.
      const goalReached = target !== undefined && event.status === STATUS.ACTIVE && (await this.tryReachGoal(tx, event.id));
      return { event, goalReached };
    });

    await this.publish(EVENTS.SETTINGS_UPDATED);
    if (result.goalReached) await this.afterGoalReached(result.event.id);
    return this.getAdminState();
  }

  // 상품 목록 전체를 교체합니다. 배열 순서 = 상품 순서(1등, 2등, ...)
  // prizes: [{ name, quantity }]
  async setPrizes(prizes) {
    if (!Array.isArray(prizes) || prizes.length === 0) {
      throw new GiftError('INVALID_PRIZES', '상품을 1개 이상 등록해주세요.');
    }
    const cleaned = prizes.map((prize, index) => {
      const name = String(prize.name ?? prize.prizeName ?? '').trim();
      const quantity = Number(prize.quantity ?? 1);
      if (!name) throw new GiftError('INVALID_PRIZES', `${index + 1}번째 상품 이름이 비어 있습니다.`);
      if (name.length > 100) throw new GiftError('INVALID_PRIZES', `${index + 1}번째 상품 이름이 너무 깁니다. (100자 이하)`);
      if (!Number.isInteger(quantity) || quantity < 1) {
        throw new GiftError('INVALID_PRIZES', `${index + 1}번째 상품 수량은 1 이상의 정수여야 합니다.`);
      }
      return { name, quantity, order: index + 1 };
    });
    const totalSlots = cleaned.reduce((sum, prize) => sum + prize.quantity, 0);
    if (totalSlots > MAX_PRIZE_SLOTS) {
      throw new GiftError('INVALID_PRIZES', `당첨 인원은 최대 ${MAX_PRIZE_SLOTS}명까지 설정할 수 있습니다.`);
    }

    await this.db.transaction(async (tx) => {
      const event = await this.lockOpenEvent(tx);
      this.assertStatus(event, [STATUS.READY, STATUS.ACTIVE, STATUS.BOX_OPENING, STATUS.ROULETTE], '상품을 변경');
      if ((await this.getWinners(event.id, tx)).length > 0) {
        throw new GiftError('DRAW_STARTED', '추첨이 시작된 뒤에는 상품을 바꿀 수 없습니다.', 409);
      }
      const now = this.nowIso();
      await tx.query('DELETE FROM gift_prize WHERE event_id = $1', [event.id]);
      for (const prize of cleaned) {
        await tx.query(
          'INSERT INTO gift_prize (event_id, prize_order, prize_name, quantity, created_at) VALUES ($1, $2, $3, $4, $5)',
          [event.id, prize.order, prize.name, prize.quantity, now]
        );
      }
      await tx.query('UPDATE gift_event SET winner_count = $1, updated_at = $2 WHERE id = $3', [totalSlots, now, event.id]);
      await this.log(tx, event.id, 'PRIZES_UPDATED', { prizes: cleaned });
    });

    await this.publish(EVENTS.SETTINGS_UPDATED);
    return this.getAdminState();
  }

  // ---------------------------------------------------------------------------
  // 이벤트 시작 / 종료
  // ---------------------------------------------------------------------------

  async start() {
    const result = await this.db.transaction(async (tx) => {
      const event = await this.lockOpenEvent(tx);
      this.assertStatus(event, [STATUS.READY], '이벤트를 시작');
      if ((await this.getPrizes(event.id, tx)).length === 0) {
        throw new GiftError('NO_PRIZES', '상품을 먼저 1개 이상 등록해주세요.');
      }
      await this.transition(tx, event.id, [STATUS.READY], STATUS.ACTIVE, { started_at: event.startedAt || this.nowIso() });
      await this.log(tx, event.id, 'STARTED');
      // 일시정지 중 목표를 낮췄거나 게이지를 수정했다면 시작과 동시에 달성될 수 있습니다.
      return { event, goalReached: await this.tryReachGoal(tx, event.id) };
    });
    await this.publish(EVENTS.PROGRESS_UPDATED);
    if (result.goalReached) await this.afterGoalReached(result.event.id);
    return this.getAdminState();
  }

  // 이벤트 종료 = 후원 수집 중지. 데이터는 그대로 두고 READY로 돌아가며, 다시 "시작"하면 이어서 수집합니다.
  async stop() {
    await this.db.transaction(async (tx) => {
      const event = await this.lockOpenEvent(tx);
      this.assertStatus(event, [STATUS.ACTIVE], '이벤트를 종료');
      await this.transition(tx, event.id, [STATUS.ACTIVE], STATUS.READY);
      await this.log(tx, event.id, 'STOPPED');
    });
    await this.publish(EVENTS.PROGRESS_UPDATED);
    return this.getAdminState();
  }

  // ---------------------------------------------------------------------------
  // 후원 처리
  // ---------------------------------------------------------------------------

  // donationService.js가 검증/정규화한 후원 1건을 반영합니다.
  // donation: { donorId, donorKey, nickname, type, amount, timestamp, source, externalEventId }
  //
  // - 같은 (source, externalEventId)가 이미 있으면 아무것도 하지 않습니다. (중복 수신 방지)
  // - ACTIVE가 아니면(목표 달성 이후, 룰렛 중, 준비 단계) IGNORED로 기록만 하고 게이지/응모권에는 넣지 않습니다.
  // - ACTIVE면 COUNTED로 저장하고 current_amount를 원자적으로 더한 뒤 목표 달성 여부를 확인합니다.
  async applyDonation(donation) {
    let outcome;
    try {
      outcome = await this.db.transaction(async (tx) => {
        // 회차 행을 먼저 잠가서, 같은 순간 들어온 다른 후원은 이 후원이 끝날 때까지 기다립니다.
        const event = await this.lockOpenEvent(tx);

        if (donation.externalEventId) {
          const { rows } = await tx.query(
            'SELECT id FROM gift_donation WHERE source = $1 AND external_event_id = $2',
            [donation.source, donation.externalEventId]
          );
          if (rows[0]) return { result: 'DUPLICATE', donationId: rows[0].id };
        }

        const now = this.nowIso();
        const isActive = event.status === STATUS.ACTIVE;
        const { rows } = await tx.query(
          `INSERT INTO gift_donation
             (event_id, donor_key, donor_id, nickname, donation_type, amount, status, ignored_reason,
              source, external_event_id, donated_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING id`,
          [
            event.id,
            donation.donorKey,
            donation.donorId || null,
            donation.nickname,
            donation.type,
            donation.amount,
            isActive ? 'COUNTED' : 'IGNORED',
            isActive ? null : `STATUS_${event.status}`,
            donation.source,
            donation.externalEventId || null,
            donation.timestamp || now,
            now,
          ]
        );
        const donationId = rows[0].id;

        if (!isActive) {
          return { result: 'IGNORED', donationId, eventId: event.id, reason: `현재 상태(${event.status})에서는 집계하지 않습니다.` };
        }

        // 원자적 증가: 읽고-더하고-쓰는 대신 DB가 직접 더하게 합니다.
        const updated = await tx.query(
          "UPDATE gift_event SET current_amount = current_amount + $1, updated_at = $2 WHERE id = $3 AND status = 'ACTIVE'",
          [donation.amount, now, event.id]
        );
        if (updated.rowCount !== 1) {
          throw new GiftError('STATE_CHANGED', '처리 중 이벤트 상태가 바뀌었습니다. 다시 시도해주세요.', 409);
        }

        const goalReached = await this.tryReachGoal(tx, event.id);
        const donor = await this.findDonor(tx, event, donation.donorKey);
        return { result: 'COUNTED', donationId, eventId: event.id, goalReached, donor };
      });
    } catch (error) {
      // 같은 외부 이벤트가 동시에 들어와 UNIQUE 제약에 걸린 경우도 중복으로 처리합니다.
      if (donation.externalEventId && isUniqueViolation(error)) {
        return { result: 'DUPLICATE' };
      }
      throw error;
    }

    if (outcome.result === 'COUNTED') {
      const { donor, ...rest } = outcome;
      await this.publish(EVENTS.DONATION_RECEIVED, {
        donation: {
          id: outcome.donationId,
          nickname: donation.nickname,
          type: donation.type,
          typeLabel: DONATION_TYPE_LABELS[donation.type],
          amount: donation.amount,
        },
        donor,
      });
      await this.publish(EVENTS.PROGRESS_UPDATED);
      if (outcome.goalReached) await this.afterGoalReached(outcome.eventId);
      return rest;
    }
    return outcome;
  }

  // 후원자 1명의 현재 누적 (후원 알림에 "응모권 N장"을 보여주기 위함)
  async findDonor(tx, event, donorKey) {
    const { rows } = await tx.query(
      `SELECT COALESCE(SUM(amount), 0)::int AS total FROM gift_donation
        WHERE event_id = $1 AND donor_key = $2 AND status = 'COUNTED'`,
      [event.id, donorKey]
    );
    const total = rows[0].total;
    return { total, tickets: ticketCount(total, event.ticketUnit) };
  }

  // current_amount가 목표 이상이면 ACTIVE → BOX_OPENING 으로 바꿉니다. 바뀌었으면 true
  async tryReachGoal(tx, eventId) {
    const now = this.nowIso();
    const result = await tx.query(
      `UPDATE gift_event SET status = 'BOX_OPENING', status_changed_at = $1, goal_reached_at = $1, updated_at = $1
        WHERE id = $2 AND status = 'ACTIVE' AND current_amount >= target_amount`,
      [now, eventId]
    );
    if (result.rowCount === 1) {
      await this.log(tx, eventId, 'GOAL_REACHED');
      return true;
    }
    return false;
  }

  async afterGoalReached(eventId) {
    await this.publish(EVENTS.GOAL_REACHED);
    await this.publish(EVENTS.BOX_OPEN);
    this.scheduleRoulette(eventId, this.boxOpenMs);
  }

  // 후원 취소: 기록은 남기고 status만 CANCELED로 바꾸며 게이지에서 뺍니다.
  // 준비/수집 중이거나 오픈 연출 중(BOX_OPENING)일 때만 가능합니다.
  // 오픈 연출 중 취소로 목표 미만이 되면 다시 ACTIVE로 돌아갑니다. (잘못 등록된 후원 정정용)
  async cancelDonation(donationId) {
    const result = await this.db.transaction(async (tx) => {
      const event = await this.lockOpenEvent(tx);
      this.assertStatus(event, [STATUS.READY, STATUS.ACTIVE, STATUS.BOX_OPENING], '후원을 취소');
      const { rows } = await tx.query('SELECT * FROM gift_donation WHERE id = $1', [donationId]);
      const donation = rows[0];
      if (!donation || donation.event_id !== event.id) {
        throw new GiftError('NOT_FOUND', '현재 회차의 후원이 아닙니다.', 404);
      }
      if (donation.status !== 'COUNTED') {
        throw new GiftError('NOT_COUNTED', '이미 취소되었거나 집계되지 않은 후원입니다.', 409);
      }
      const now = this.nowIso();
      await tx.query("UPDATE gift_donation SET status = 'CANCELED', canceled_at = $1 WHERE id = $2", [now, donationId]);
      const { rows: updated } = await tx.query(
        'UPDATE gift_event SET current_amount = GREATEST(current_amount - $1, 0), updated_at = $2 WHERE id = $3 RETURNING current_amount, target_amount',
        [donation.amount, now, event.id]
      );
      await this.log(tx, event.id, 'DONATION_CANCELED', { donationId, nickname: donation.nickname, amount: donation.amount });

      let reverted = false;
      if (event.status === STATUS.BOX_OPENING && updated[0].current_amount < updated[0].target_amount) {
        reverted = await this.transition(tx, event.id, [STATUS.BOX_OPENING], STATUS.ACTIVE, { goal_reached_at: null });
        if (reverted) await this.log(tx, event.id, 'GOAL_REVERTED');
      }
      return { reverted };
    });
    if (result.reverted) this.clearTimers();
    await this.publish(EVENTS.DONATION_CANCELED, { donationId });
    await this.publish(EVENTS.PROGRESS_UPDATED);
    return this.getAdminState();
  }

  // ---------------------------------------------------------------------------
  // 수동 관리
  // ---------------------------------------------------------------------------

  // 현재 게이지 값을 직접 수정합니다. 후원 기록/응모권에는 영향이 없고 게이지만 바뀝니다.
  async adjustCurrentAmount(value) {
    const amount = Number(value);
    if (!Number.isInteger(amount) || amount < 0) {
      throw new GiftError('INVALID_AMOUNT', '게이지 값은 0 이상의 정수여야 합니다.');
    }
    const result = await this.db.transaction(async (tx) => {
      const event = await this.lockOpenEvent(tx);
      this.assertStatus(event, [STATUS.READY, STATUS.ACTIVE], '게이지를 수정');
      await tx.query('UPDATE gift_event SET current_amount = $1, updated_at = $2 WHERE id = $3', [amount, this.nowIso(), event.id]);
      await this.log(tx, event.id, 'AMOUNT_ADJUSTED', { from: event.currentAmount, to: amount });
      return { event, goalReached: event.status === STATUS.ACTIVE && (await this.tryReachGoal(tx, event.id)) };
    });
    await this.publish(EVENTS.PROGRESS_UPDATED);
    if (result.goalReached) await this.afterGoalReached(result.event.id);
    return this.getAdminState();
  }

  // 상자 강제 오픈: 목표 미달이어도 BOX_OPENING으로 넘깁니다.
  async forceOpen() {
    const event = await this.db.transaction(async (tx) => {
      const current = await this.lockOpenEvent(tx);
      this.assertStatus(current, [STATUS.READY, STATUS.ACTIVE], '상자를 강제 오픈');
      if ((await this.getPrizes(current.id, tx)).length === 0) {
        throw new GiftError('NO_PRIZES', '상품을 먼저 1개 이상 등록해주세요.');
      }
      await this.transition(tx, current.id, [STATUS.READY, STATUS.ACTIVE], STATUS.BOX_OPENING, {
        goal_reached_at: this.nowIso(),
        started_at: current.startedAt || this.nowIso(),
      });
      await this.log(tx, current.id, 'FORCE_OPEN', { currentAmount: current.currentAmount, targetAmount: current.targetAmount });
      return current;
    });
    await this.afterGoalReached(event.id);
    return this.getAdminState();
  }

  // 룰렛 강제 실행: 오픈 연출을 건너뛰고(또는 수집 중이어도) 바로 룰렛 화면으로 넘어갑니다.
  async forceRoulette() {
    const event = await this.requireOpenEvent();
    this.assertStatus(event, [STATUS.READY, STATUS.ACTIVE, STATUS.BOX_OPENING], '룰렛을 강제 실행');
    await this.enterRoulette(event.id, 'FORCE');
    return this.getAdminState();
  }

  // BOX_OPENING(또는 강제 실행 시 READY/ACTIVE) → ROULETTE
  // 응모권 보유자가 없으면 바로 RESULT로 넘어갑니다. (당첨자 없음)
  async enterRoulette(eventId, trigger) {
    const fromStatuses = trigger === 'FORCE' ? [STATUS.READY, STATUS.ACTIVE, STATUS.BOX_OPENING] : [STATUS.BOX_OPENING];
    const outcome = await this.db.transaction(async (tx) => {
      const event = await this.lockEventById(tx, eventId);
      if (!event || !fromStatuses.includes(event.status)) {
        throw new GiftError('INVALID_STATUS', '룰렛을 시작할 수 있는 상태가 아닙니다.', 409);
      }
      if ((await this.getPrizes(event.id, tx)).length === 0) {
        throw new GiftError('NO_PRIZES', '상품을 먼저 1개 이상 등록해주세요.');
      }
      const now = this.nowIso();
      await this.transition(tx, event.id, fromStatuses, STATUS.ROULETTE, {
        goal_reached_at: event.goalReachedAt || now,
        started_at: event.startedAt || now,
      });
      await this.log(tx, event.id, 'ROULETTE_STARTED', { trigger });

      const pool = this.getDrawPool(await this.getDonors(event, tx), await this.getWinners(event.id, tx));
      if (pool.length === 0) {
        await this.transition(tx, event.id, [STATUS.ROULETTE], STATUS.RESULT);
        await this.log(tx, event.id, 'RESULT_READY', { reason: 'NO_ENTRANTS' });
        return { noEntrants: true };
      }
      return { noEntrants: false };
    });

    this.clearTimers();
    await this.publish(EVENTS.ROULETTE_STARTED, { noEntrants: outcome.noEntrants });
    if (outcome.noEntrants) await this.publish(EVENTS.RESULT_READY, { reason: 'NO_ENTRANTS' });
    return outcome;
  }

  // 다음 칸 1명을 추첨합니다. (여러 명은 이 함수를 한 번씩 순서대로 호출)
  // 직전 당첨 연출(회전 + 당첨자 표시)이 끝나기 전에는 다음 추첨을 막습니다.
  async drawNext() {
    let outcome;
    try {
      outcome = await this.db.transaction(async (tx) => {
        const event = await this.lockOpenEvent(tx);
        this.assertStatus(event, [STATUS.ROULETTE], '추첨');
        const winners = await this.getWinners(event.id, tx);
        const lastWinner = winners[winners.length - 1];
        if (lastWinner) {
          const readyAt = Date.parse(lastWinner.selectedAt) + this.spinMs + this.winnerHoldMs;
          const waitMs = readyAt - this.now().getTime();
          if (waitMs > 0) {
            throw new GiftError('DRAW_COOLDOWN', `룰렛 연출 중입니다. ${Math.ceil(waitMs / 1000)}초 후 다시 눌러주세요.`, 409);
          }
        }

        const slots = expandPrizeSlots(await this.getPrizes(event.id, tx));
        const slot = slots[winners.length] || null;
        const donors = await this.getDonors(event, tx);
        const pool = this.getDrawPool(donors, winners);

        if (!slot || pool.length === 0) {
          const reason = !slot ? 'ALL_DRAWN' : 'POOL_EXHAUSTED';
          await this.transition(tx, event.id, [STATUS.ROULETTE], STATUS.RESULT);
          await this.log(tx, event.id, 'RESULT_READY', { reason });
          return { finished: true, reason };
        }

        const picked = weightedPick(pool, this.randomInt);
        const now = this.nowIso();
        const totalTickets = picked.totalWeight;
        // UNIQUE (event_id, slot_no), UNIQUE (event_id, donor_key)가 중복 추첨/중복 당첨을 DB에서 한 번 더 막습니다.
        await tx.query(
          `INSERT INTO gift_winner
             (event_id, prize_id, slot_no, donor_key, donor_id, nickname, ticket_count, total_tickets, selected_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            event.id,
            slot.prize.id,
            slot.slotNo,
            picked.winner.donorKey,
            picked.winner.donorId,
            picked.winner.nickname,
            picked.winner.tickets,
            totalTickets,
            now,
          ]
        );
        await this.log(tx, event.id, 'WINNER_SELECTED', {
          slotNo: slot.slotNo,
          prize: slot.prize.prizeName,
          nickname: picked.winner.nickname,
          tickets: picked.winner.tickets,
          totalTickets,
          roll: picked.roll,
        });

        // 마지막 칸이었거나, 더 뽑을 사람이 없으면 결과 단계로 넘어갑니다.
        const updatedWinners = [...winners, { donorKey: picked.winner.donorKey }];
        const nextSlot = slots[updatedWinners.length] || null;
        const nextPool = this.getDrawPool(donors, updatedWinners);
        let finished = false;
        let reason = null;
        if (!nextSlot || nextPool.length === 0) {
          reason = !nextSlot ? 'ALL_DRAWN' : 'POOL_EXHAUSTED';
          await this.transition(tx, event.id, [STATUS.ROULETTE], STATUS.RESULT);
          await this.log(tx, event.id, 'RESULT_READY', { reason });
          finished = true;
        }

        return {
          finished,
          reason,
          winner: {
            slotNo: slot.slotNo,
            key: publicKey(picked.winner.donorKey),
            nickname: picked.winner.nickname,
            tickets: picked.winner.tickets,
            totalTickets,
            prize: publicPrize(slot.prize),
            selectedAt: now,
          },
          // 오버레이가 "추첨 당시의 룰렛판"을 그대로 그릴 수 있도록 후보 목록을 함께 보냅니다.
          pool: pool.map(publicEntrant),
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new GiftError('DRAW_CONFLICT', '동시에 추첨 요청이 들어와 이번 요청은 취소되었습니다. 다시 눌러주세요.', 409);
      }
      throw error;
    }

    if (outcome.winner) await this.publish(EVENTS.WINNER_SELECTED, { winner: outcome.winner, pool: outcome.pool });
    if (outcome.finished) await this.publish(EVENTS.RESULT_READY, { reason: outcome.reason });
    return { ...outcome, state: await this.getAdminState() };
  }

  // 다음 선물상자 시작: RESULT인 현재 회차를 FINISHED(COMPLETED)로 닫고, 0부터 시작하는 새 회차를 만듭니다.
  async startNextRound() {
    await this.db.transaction(async (tx) => {
      const event = await this.lockOpenEvent(tx);
      this.assertStatus(event, [STATUS.RESULT], '다음 선물상자를 시작');
      await this.transition(tx, event.id, [STATUS.RESULT], STATUS.FINISHED, { finished_at: this.nowIso(), end_reason: 'COMPLETED' });
      await this.log(tx, event.id, 'ROUND_FINISHED', { reason: 'COMPLETED' });
      await this.createNextEvent(tx, event);
    });
    this.clearTimers();
    await this.publish(EVENTS.ROUND_FINISHED, { reason: 'COMPLETED' });
    return this.getAdminState();
  }

  // 회차 초기화: 어떤 상태든 현재 회차를 FINISHED(RESET)로 닫고 새 회차를 만듭니다.
  // 이전 회차의 후원/당첨 기록은 그대로 DB에 남습니다.
  async resetRound() {
    await this.db.transaction(async (tx) => {
      const event = await this.lockOpenEvent(tx);
      await this.transition(tx, event.id, [event.status], STATUS.FINISHED, { finished_at: this.nowIso(), end_reason: 'RESET' });
      await this.log(tx, event.id, 'ROUND_FINISHED', { reason: 'RESET', status: event.status, currentAmount: event.currentAmount });
      await this.createNextEvent(tx, event);
    });
    this.clearTimers();
    await this.publish(EVENTS.ROUND_FINISHED, { reason: 'RESET' });
    return this.getAdminState();
  }
}

// ---- DB row → 객체 변환 ----
// INTEGER 컬럼은 node-postgres/PGlite 모두 숫자로 돌려주고, TIMESTAMPTZ는 Date로 오므로 ISO 문자열로 바꿉니다.
// (기존 SQLite 버전과 API 응답 형태를 똑같이 유지하기 위함)

function mapEvent(row) {
  return {
    id: row.id,
    roundNo: row.round_no,
    targetAmount: row.target_amount,
    currentAmount: row.current_amount,
    ticketUnit: normalizeTicketUnit(row.ticket_unit),
    winnerCount: row.winner_count,
    status: row.status,
    statusChangedAt: toIso(row.status_changed_at),
    endReason: row.end_reason,
    startedAt: toIso(row.started_at),
    goalReachedAt: toIso(row.goal_reached_at),
    finishedAt: toIso(row.finished_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapPrize(row) {
  return { id: row.id, eventId: row.event_id, prizeOrder: row.prize_order, prizeName: row.prize_name, quantity: row.quantity };
}

function mapWinner(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    prizeId: row.prize_id,
    prizeName: row.prize_name,
    prizeOrder: row.prize_order,
    slotNo: row.slot_no,
    donorKey: row.donor_key,
    donorId: row.donor_id,
    nickname: row.nickname,
    ticketCount: row.ticket_count,
    totalTickets: row.total_tickets,
    selectedAt: toIso(row.selected_at),
  };
}

function mapDonation(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    donorKey: row.donor_key,
    donorId: row.donor_id,
    nickname: row.nickname,
    type: row.donation_type,
    amount: row.amount,
    status: row.status,
    ignoredReason: row.ignored_reason,
    source: row.source,
    externalEventId: row.external_event_id,
    donatedAt: toIso(row.donated_at),
    createdAt: toIso(row.created_at),
    canceledAt: toIso(row.canceled_at),
  };
}

function publicPrize(prize) {
  return { id: prize.id, order: prize.prizeOrder, name: prize.prizeName, quantity: prize.quantity };
}

// 오버레이에는 donorKey(donorId 포함 가능)를 그대로 주지 않고, 화면에서 같은 사람을 구분할 용도의 해시만 줍니다.
function publicKey(donorKey) {
  return crypto.createHash('sha256').update(donorKey).digest('hex').slice(0, 12);
}

function publicEntrant(entrant) {
  return { key: publicKey(entrant.donorKey), nickname: entrant.nickname, tickets: entrant.tickets };
}

function publicWinner(winner) {
  return {
    slotNo: winner.slotNo,
    key: publicKey(winner.donorKey),
    nickname: winner.nickname,
    tickets: winner.ticketCount,
    totalTickets: winner.totalTickets,
    prize: { id: winner.prizeId, order: winner.prizeOrder, name: winner.prizeName },
    selectedAt: winner.selectedAt,
  };
}

module.exports = { GiftEventService, GiftError, STATUS, EVENTS, isUniqueViolation };
