// test/gift.test.js
// 선물상자 이벤트 테스트입니다. Node.js 내장 테스트 러너(node:test)를 사용합니다.
// 실행: npm test
//
// 기본은 PGlite(메모리에서 도는 진짜 PostgreSQL)를 써서 별도 DB 없이 실행됩니다.
// 실제 PostgreSQL 서버로도 돌려보고 싶다면 TEST_DATABASE_URL을 지정하세요.
//   예) TEST_DATABASE_URL=postgres://... npm test
//   → 임시 스키마(gift_test_xxx)를 만들어 그 안에서만 테스트하고 끝나면 지웁니다.
//   ⚠️ Neon의 pooler 주소(-pooler)는 스키마 지정 옵션을 지원하지 않으므로 direct 주소나 테스트용 브랜치를 쓰세요.

const test = require('node:test');
const { before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { wrapPglite, createPgDatabase, initSchema } = require('../gift/database');
const { GiftEventService, STATUS } = require('../gift/giftEventService');
const { DonationService } = require('../gift/donationService');
const { mountGiftBox } = require('../gift');
const { ticketCount, ticketRemainder, aggregateDonors, weightedPick } = require('../gift/tickets');

let database;
let cleanup = async () => {};

before(async () => {
  if (process.env.TEST_DATABASE_URL) {
    const schema = `gift_test_${process.pid}_${Date.now()}`;
    const admin = createPgDatabase({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    await admin.exec(`CREATE SCHEMA ${schema}`);
    database = createPgDatabase({ connectionString: process.env.TEST_DATABASE_URL, searchPath: schema, max: 10 });
    cleanup = async () => {
      await database.close();
      await admin.exec(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    };
    console.log(`[test] 실제 PostgreSQL(${schema})에서 테스트합니다.`);
  } else {
    const { PGlite } = require('@electric-sql/pglite');
    database = wrapPglite(new PGlite());
    cleanup = () => database.close();
  }
  await initSchema(database);
});

after(() => cleanup());

// 테스트마다 빈 DB에서 시작합니다.
beforeEach(async () => {
  await database.exec('TRUNCATE gift_event_log, gift_winner, gift_prize, gift_donation, gift_event RESTART IDENTITY CASCADE');
});

// 테스트용 서비스: 타이머 끔 + 시계 조작 가능 + 추첨 난수 주입 가능 + 룰렛 쿨다운 0
async function setup({ target = 1000, prizes = [{ name: '치킨 기프티콘', quantity: 1 }], randomInt, spinMs = 0, winnerHoldMs = 0 } = {}) {
  let clock = new Date('2026-10-05T12:00:00.000Z').getTime();
  const published = [];
  const service = new GiftEventService(database, {
    now: () => new Date(clock),
    randomInt,
    publish: (type, payload) => published.push({ type, payload }),
    scheduleTimers: false,
    spinMs,
    winnerHoldMs,
  });
  await service.init();
  const donations = new DonationService(service);
  await service.updateSettings({ targetAmount: target });
  await service.setPrizes(prizes);
  await service.start();
  return {
    service,
    donations,
    published,
    advance: (ms) => {
      clock += ms;
    },
    donate: (nickname, amount, type = 'STAR', extra = {}) => donations.receive({ nickname, amount, type, ...extra }, 'TEST'),
    donor: async (nickname) => (await service.getAdminState()).donors.find((d) => d.nickname === nickname),
    status: async () => (await service.getPublicState()).event.status,
  };
}

// ---------------- 응모권 계산 (요구사항 24-1 ~ 24-7) ----------------

test('1. 99개 후원 → 응모권 0', async () => {
  const t = await setup();
  await t.donate('철수', 99);
  assert.equal((await t.donor('철수')).tickets, 0);
  assert.equal((await t.donor('철수')).remainder, 99);
});

test('2. 100개 후원 → 응모권 1', async () => {
  const t = await setup();
  await t.donate('철수', 100);
  assert.equal((await t.donor('철수')).tickets, 1);
});

test('3. 50 + 50 → 응모권 1', async () => {
  const t = await setup();
  await t.donate('철수', 50);
  await t.donate('철수', 50);
  const donor = await t.donor('철수');
  assert.equal(donor.total, 100);
  assert.equal(donor.tickets, 1);
});

test('4. 50 + 30 + 19 → 총 99 → 응모권 0', async () => {
  const t = await setup();
  for (const amount of [50, 30, 19]) await t.donate('철수', amount);
  const donor = await t.donor('철수');
  assert.equal(donor.total, 99);
  assert.equal(donor.tickets, 0);
});

test('5. 50 + 30 + 20 → 총 100 → 응모권 1', async () => {
  const t = await setup();
  for (const amount of [50, 30, 20]) await t.donate('철수', amount);
  const donor = await t.donor('철수');
  assert.equal(donor.total, 100);
  assert.equal(donor.tickets, 1);
});

test('6. 250 + 150 → 총 400 → 응모권 4', async () => {
  const t = await setup();
  await t.donate('철수', 250);
  await t.donate('철수', 150);
  const donor = await t.donor('철수');
  assert.equal(donor.total, 400);
  assert.equal(donor.tickets, 4);
});

test('7. 별풍선 100 + 도전미션 100 + 대결미션 100 → 총 300 → 응모권 3', async () => {
  const t = await setup();
  await t.donate('철수', 100, 'STAR');
  await t.donate('철수', 100, 'CHALLENGE');
  await t.donate('철수', 100, 'BATTLE');
  const donor = await t.donor('철수');
  assert.equal(donor.total, 300);
  assert.equal(donor.tickets, 3);
  assert.deepEqual(donor.byType, { STAR: 100, CHALLENGE: 100, BATTLE: 100 });
});

test('응모권 계산 함수 경계값 (99/100/199/200/550, 잔여)', () => {
  assert.deepEqual([99, 100, 199, 200, 550].map((n) => ticketCount(n)), [0, 1, 1, 2, 5]);
  assert.equal(ticketRemainder(520), 20);
  assert.equal(ticketCount(0), 0);
  assert.equal(ticketCount(-100), 0);
});

test('게이지와 응모권은 별개: A 50 + B 99 + C 100 → 게이지 249, 응모권 0/0/1', async () => {
  const t = await setup();
  await t.donate('A', 50);
  await t.donate('B', 99);
  await t.donate('C', 100);
  const state = await t.service.getAdminState();
  assert.equal(state.event.currentAmount, 249);
  assert.deepEqual(['A', 'B', 'C'].map((n) => state.donors.find((d) => d.nickname === n).tickets), [0, 0, 1]);
});

test('90개 누적 후 20개 추가 → 110 / 응모권 1 / 잔여 10 유지', async () => {
  const t = await setup();
  await t.donate('철수', 60);
  await t.donate('철수', 30);
  assert.equal((await t.donor('철수')).tickets, 0);
  await t.donate('철수', 20);
  const donor = await t.donor('철수');
  assert.equal(donor.total, 110);
  assert.equal(donor.tickets, 1);
  assert.equal(donor.remainder, 10);
});

test('donorId가 있으면 닉네임이 바뀌어도 같은 사람으로 합산', async () => {
  const t = await setup();
  await t.donate('철수', 50, 'STAR', { donorId: 'cs01' });
  await t.donate('철수짱', 50, 'STAR', { donorId: 'cs01' });
  const { donors } = await t.service.getAdminState();
  assert.equal(donors.length, 1);
  assert.equal(donors[0].total, 100);
  assert.equal(donors[0].nickname, '철수짱');
});

// ---------------- 목표 달성 (요구사항 24-8, 9번 항목) ----------------

test('8. 목표 1000 / 현재 950에서 100 후원 → 목표 달성 → BOX_OPENING', async () => {
  const t = await setup({ target: 1000 });
  await t.donate('영희', 950);
  assert.equal(await t.status(), STATUS.ACTIVE);
  await t.donate('철수', 100);
  const state = await t.service.getPublicState();
  assert.equal(state.event.status, STATUS.BOX_OPENING);
  assert.equal(state.event.currentAmount, 1050); // 실제 누적은 그대로
  assert.equal(state.event.displayAmount, 1000); // 게이지는 1000 / 1000
  assert.equal(state.event.percent, 100);
  assert.ok(t.published.some((m) => m.type === 'GOAL_REACHED'));
});

test('목표 달성 후 들어온 후원은 IGNORED로 기록만 되고 게이지/응모권에 반영되지 않음', async () => {
  const t = await setup({ target: 100 });
  await t.donate('철수', 100);
  const result = await t.donate('영희', 500);
  assert.equal(result.result, 'IGNORED');
  const state = await t.service.getAdminState();
  assert.equal(state.event.currentAmount, 100);
  assert.equal(state.donors.find((d) => d.nickname === '영희'), undefined);
  assert.ok(state.recentDonations.some((d) => d.nickname === '영희' && d.status === 'IGNORED'));
});

// ---------------- 추첨 (요구사항 24-9, 24-10) ----------------

test('9. 응모권 A5 / B3 / C2 → 누적 가중치 추첨이 정확한 구간을 선택', () => {
  const pool = [
    { nickname: 'A', tickets: 5 },
    { nickname: 'B', tickets: 3 },
    { nickname: 'C', tickets: 2 },
  ];
  // 난수 0~4 → A, 5~7 → B, 8~9 → C
  const pickWith = (roll) => weightedPick(pool, () => roll).winner.nickname;
  assert.deepEqual([0, 4, 5, 7, 8, 9].map(pickWith), ['A', 'A', 'B', 'B', 'C', 'C']);
  assert.equal(weightedPick(pool, () => 0).totalWeight, 10);
});

test('9-1. 가중치 추첨 분포가 50% / 30% / 20%에 근접 (실제 crypto 난수, 20만 회)', () => {
  const pool = [
    { nickname: 'A', tickets: 5 },
    { nickname: 'B', tickets: 3 },
    { nickname: 'C', tickets: 2 },
  ];
  const counts = { A: 0, B: 0, C: 0 };
  const trials = 200000;
  for (let i = 0; i < trials; i += 1) counts[weightedPick(pool).winner.nickname] += 1;
  assert.ok(Math.abs(counts.A / trials - 0.5) < 0.01, `A ${counts.A / trials}`);
  assert.ok(Math.abs(counts.B / trials - 0.3) < 0.01, `B ${counts.B / trials}`);
  assert.ok(Math.abs(counts.C / trials - 0.2) < 0.01, `C ${counts.C / trials}`);
});

test('응모권 0장인 사람은 추첨 대상이 아님', () => {
  assert.equal(weightedPick([{ nickname: 'A', tickets: 0 }]), null);
  const result = weightedPick([{ nickname: 'A', tickets: 0 }, { nickname: 'B', tickets: 1 }], () => 0);
  assert.equal(result.winner.nickname, 'B');
});

test('10. 중복 당첨 불가(고정 규칙): A가 당첨되면 다음 추첨에서 A 제외 (기록은 유지)', async () => {
  const t = await setup({
    prizes: [
      { name: '치킨', quantity: 1 },
      { name: '스타벅스', quantity: 1 },
    ],
    randomInt: () => 0, // 항상 첫 번째 후보(응모권 많은 순)를 뽑음
  });
  await t.donate('A', 500);
  await t.donate('B', 300);
  await t.donate('C', 200);
  await t.service.forceRoulette();

  const first = await t.service.drawNext();
  assert.equal(first.winner.nickname, 'A');
  const poolNames = (await t.service.getPublicState()).drawPool.map((p) => p.nickname);
  assert.deepEqual(poolNames, ['B', 'C']);

  const second = await t.service.drawNext();
  assert.equal(second.winner.nickname, 'B');
  assert.equal(second.winner.totalTickets, 5); // B3 + C2 (A 제외)
  assert.equal(await t.status(), STATUS.RESULT);
  assert.equal((await t.donor('A')).tickets, 5); // A의 후원/응모 기록은 그대로
});

test('10-1. DB 제약: 같은 회차에서 같은 donor_key는 두 번 당첨될 수 없음 (UNIQUE event_id, donor_key)', async () => {
  const t = await setup({ prizes: [{ name: '쿠폰', quantity: 2 }] });
  await t.donate('A', 100);
  await t.donate('B', 100);
  await t.service.forceRoulette();
  await t.service.drawNext();
  const [winner] = (await database.query('SELECT * FROM gift_winner')).rows;
  // 서비스 로직을 우회해 같은 사람을 2번 칸에 직접 넣으려 하면 DB가 거절해야 합니다.
  await assert.rejects(
    database.query(
      `INSERT INTO gift_winner (event_id, prize_id, slot_no, donor_key, nickname, ticket_count, total_tickets, selected_at)
       VALUES ($1, $2, 2, $3, $4, 1, 1, now())`,
      [winner.event_id, winner.prize_id, winner.donor_key, winner.nickname]
    ),
    (error) => error.code === '23505'
  );
});

test('당첨 인원보다 응모자가 적으면 가능한 만큼만 뽑고 RESULT로 이동', async () => {
  const t = await setup({ prizes: [{ name: '1등', quantity: 1 }, { name: '2등', quantity: 2 }] });
  await t.donate('A', 100);
  await t.service.forceRoulette();
  const draw = await t.service.drawNext();
  assert.equal(draw.winner.nickname, 'A');
  assert.equal(draw.finished, true);
  assert.equal(draw.reason, 'POOL_EXHAUSTED');
  assert.equal(await t.status(), STATUS.RESULT);
});

test('응모권 보유자가 아무도 없으면 룰렛 진입 즉시 RESULT (당첨자 없음)', async () => {
  const t = await setup({ target: 100 });
  await t.donate('A', 50);
  await t.donate('B', 50); // 게이지는 100 달성, 응모권은 모두 0
  const before = await t.service.getPublicState();
  assert.equal(before.event.status, STATUS.BOX_OPENING);
  await t.service.enterRoulette(before.event.id, 'AUTO');
  const state = await t.service.getPublicState();
  assert.equal(state.event.status, STATUS.RESULT);
  assert.equal(state.winners.length, 0);
});

test('룰렛 연출 중에는 다음 추첨을 막음 (쿨다운)', async () => {
  const t = await setup({ prizes: [{ name: '쿠폰', quantity: 2 }], spinMs: 5000, winnerHoldMs: 3000 });
  await t.donate('A', 100);
  await t.donate('B', 100);
  await t.service.forceRoulette();
  await t.service.drawNext();
  await assert.rejects(t.service.drawNext(), /룰렛 연출 중/);
  t.advance(8000);
  assert.ok((await t.service.drawNext()).winner);
});

// ---------------- 회차 (요구사항 24-11, 24-12) ----------------

async function playFullRound(t) {
  await t.donate('A', 600);
  await t.donate('B', 400);
  await t.service.enterRoulette((await t.service.getPublicState()).event.id, 'AUTO');
  await t.service.drawNext();
  assert.equal(await t.status(), STATUS.RESULT);
}

test('11. 회차 종료 후 다음 회차 시작 시 currentAmount = 0 (초과분 이월 없음)', async () => {
  const t = await setup({ target: 1000 });
  await playFullRound(t);
  await t.service.startNextRound();
  const state = await t.service.getPublicState();
  assert.equal(state.event.roundNo, 2);
  assert.equal(state.event.currentAmount, 0);
  assert.equal(state.event.status, STATUS.READY);
  assert.equal(state.event.targetAmount, 1000); // 설정은 이어받음
  assert.equal(state.prizes.length, 1);
  assert.equal(state.stats.participantCount, 0); // 참여자는 새로 시작
});

test('12. 이전 회차 기록은 DB에 그대로 존재', async () => {
  const t = await setup({ target: 1000 });
  await playFullRound(t);
  const firstId = (await t.service.getPublicState()).event.id;
  await t.service.startNextRound();

  const rounds = await t.service.listRounds();
  assert.equal(rounds.length, 2);
  const detail = await t.service.getRoundDetail(firstId);
  assert.equal(detail.event.status, STATUS.FINISHED);
  assert.equal(detail.event.endReason, 'COMPLETED');
  assert.equal(detail.event.currentAmount, 1000);
  assert.equal(detail.donations.length, 2);
  assert.equal(detail.donors.find((d) => d.nickname === 'A').tickets, 6);
  assert.equal(detail.winners.length, 1);
  assert.ok(detail.event.startedAt && detail.event.finishedAt);
});

test('회차 초기화도 기존 기록을 지우지 않음', async () => {
  const t = await setup();
  await t.donate('A', 300);
  await t.service.resetRound();
  const rounds = await t.service.listRounds();
  assert.equal(rounds.length, 2);
  assert.equal(rounds[1].endReason, 'RESET');
  assert.equal(rounds[1].donationTotal, 300);
  assert.equal((await t.service.getPublicState()).event.currentAmount, 0);
});

// ---------------- 예외 처리 (요구사항 23) ----------------

test('목표값 0 / 음수 / 소수는 거절', async () => {
  const t = await setup();
  for (const bad of [0, -100, 10.5, 'abc']) {
    await assert.rejects(t.service.updateSettings({ targetAmount: bad }), /목표 개수/);
  }
});

test('후원 0 / 음수 / 소수 / 닉네임 없음 / 잘못된 종류는 거절', async () => {
  const t = await setup();
  await assert.rejects(t.donate('철수', 0), /1 이상의 정수/);
  await assert.rejects(t.donate('철수', -50), /1 이상의 정수/);
  await assert.rejects(t.donate('철수', 1.5), /1 이상의 정수/);
  await assert.rejects(t.donate('   ', 100), /닉네임/);
  await assert.rejects(t.donate('철수', 100, 'GIFT'), /후원 종류/);
  assert.equal((await t.service.getPublicState()).event.currentAmount, 0);
});

test('같은 외부 eventId는 한 번만 처리 (중복 수신 방지)', async () => {
  const t = await setup();
  const first = await t.donate('철수', 100, 'STAR', { eventId: 'evt-1' });
  const second = await t.donate('철수', 100, 'STAR', { eventId: 'evt-1' });
  assert.equal(first.result, 'COUNTED');
  assert.equal(second.result, 'DUPLICATE');
  assert.equal((await t.service.getPublicState()).event.currentAmount, 100);
});

test('여러 후원이 연속으로 들어와도 currentAmount가 정확히 합산됨 (500건 순차)', async () => {
  const t = await setup({ target: 1000000 });
  let expected = 0;
  for (let i = 1; i <= 500; i += 1) {
    await t.donate(`user${i % 37}`, i, ['STAR', 'CHALLENGE', 'BATTLE'][i % 3]);
    expected += i;
  }
  const state = await t.service.getAdminState();
  assert.equal(state.event.currentAmount, expected);
  assert.equal(state.donors.reduce((sum, d) => sum + d.total, 0), expected);
});

test('후원 취소: 기록은 남고 게이지/응모권에서 빠짐', async () => {
  const t = await setup();
  const { donationId } = await t.donate('철수', 200);
  await t.service.cancelDonation(donationId);
  const state = await t.service.getAdminState();
  assert.equal(state.event.currentAmount, 0);
  assert.equal(state.donors.length, 0);
  assert.equal(state.recentDonations[0].status, 'CANCELED');
});

test('오픈 연출 중 후원 취소로 목표 미만이 되면 ACTIVE로 복귀', async () => {
  const t = await setup({ target: 100 });
  const { donationId } = await t.donate('철수', 100);
  assert.equal(await t.status(), STATUS.BOX_OPENING);
  await t.service.cancelDonation(donationId);
  assert.equal(await t.status(), STATUS.ACTIVE);
});

test('잘못된 상태 전환은 거절 (READY에서 추첨, RESULT 전 다음 회차 등)', async () => {
  const t = await setup();
  await assert.rejects(t.service.startNextRound(), /현재 상태/);
  await assert.rejects(t.service.drawNext(), /현재 상태/);
  await assert.rejects(t.service.start(), /현재 상태/); // 이미 ACTIVE
});

test('서버 재시작: 같은 DB로 서비스를 다시 만들어도 상태/게이지가 유지됨', async () => {
  const t = await setup({ target: 1000 });
  await t.donate('철수', 300);
  const restarted = await new GiftEventService(database, { scheduleTimers: false }).init();
  const state = await restarted.getPublicState();
  assert.equal(state.event.status, STATUS.ACTIVE);
  assert.equal(state.event.currentAmount, 300);
});

test('오버레이 공개 상태에는 donorId가 노출되지 않음', async () => {
  const t = await setup();
  await t.donate('철수', 100, 'STAR', { donorId: 'secret_id_123' });
  const state = await t.service.getPublicState();
  const json = JSON.stringify(state);
  assert.ok(!json.includes('secret_id_123'));
  assert.equal(state._internal, undefined);
  const winnerEvent = JSON.stringify(t.published);
  assert.ok(!winnerEvent.includes('secret_id_123'));
});

test('aggregateDonors는 종류와 관계없이 합산하고 총액 내림차순 정렬', () => {
  const donors = aggregateDonors([
    { donorKey: 'a', nickname: 'A', type: 'STAR', amount: 70 },
    { donorKey: 'a', nickname: 'A', type: 'CHALLENGE', amount: 80 },
    { donorKey: 'a', nickname: 'A', type: 'BATTLE', amount: 150 },
    { donorKey: 'b', nickname: 'B', type: 'STAR', amount: 500 },
  ]);
  assert.deepEqual(donors.map((d) => [d.nickname, d.total, d.tickets]), [['B', 500, 5], ['A', 300, 3]]);
});

// ---------------- PostgreSQL 전환 관련 ----------------

test('ID/집계 값은 문자열이 아니라 숫자로 응답 (INTEGER IDENTITY, ::int 캐스팅)', async () => {
  const t = await setup();
  const { donationId } = await t.donate('철수', 150);
  assert.equal(typeof donationId, 'number');
  const state = await t.service.getAdminState();
  assert.equal(typeof state.event.id, 'number');
  assert.equal(typeof state.prizes[0].id, 'number');
  assert.equal(typeof state.recentDonations[0].id, 'number');
  assert.equal(typeof state.event.statusChangedAt, 'string'); // 날짜는 ISO 문자열 유지
  const [round] = await t.service.listRounds();
  assert.equal(typeof round.participantCount, 'number');
  assert.equal(typeof round.donationTotal, 'number');
  assert.equal(round.donationTotal, 150);
  assert.equal(state.event.duplicateWinner, undefined); // 중복 당첨 옵션 제거
});

// ---------------- 동시성 (Promise.all) ----------------

test('동시성: 200건이 동시에 들어와도 currentAmount와 후원 합계가 정확히 일치', async () => {
  const t = await setup({ target: 10000000 });
  const jobs = [];
  let expected = 0;
  for (let i = 1; i <= 200; i += 1) {
    expected += i;
    jobs.push(t.donate(`user${i % 13}`, i, ['STAR', 'CHALLENGE', 'BATTLE'][i % 3]));
  }
  const results = await Promise.all(jobs);
  assert.ok(results.every((r) => r.result === 'COUNTED'));
  const state = await t.service.getAdminState();
  assert.equal(state.event.currentAmount, expected);
  assert.equal(state.donors.reduce((sum, d) => sum + d.total, 0), expected);
  assert.equal(state.recentDonations.length, 200);
});

test('동시성: 목표 근처에서 동시 후원 → 목표 달성은 정확히 1번, 이후 후원은 IGNORED', async () => {
  const t = await setup({ target: 1000 });
  await t.donate('base', 900);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => t.donate(`u${i}`, 50)));
  const counted = results.filter((r) => r.result === 'COUNTED');
  const ignored = results.filter((r) => r.result === 'IGNORED');
  assert.equal(counted.length, 2); // 900 + 50 + 50 = 1000 에서 달성
  assert.equal(ignored.length, 18);
  const state = await t.service.getPublicState();
  assert.equal(state.event.status, STATUS.BOX_OPENING);
  assert.equal(state.event.currentAmount, 1000);
  assert.equal(t.published.filter((m) => m.type === 'GOAL_REACHED').length, 1);
});

test('동시성: 같은 외부 eventId가 동시에 10번 와도 1건만 집계', async () => {
  const t = await setup();
  const results = await Promise.all(
    Array.from({ length: 10 }, () => t.donate('철수', 100, 'STAR', { eventId: 'same-evt' }))
  );
  assert.equal(results.filter((r) => r.result === 'COUNTED').length, 1);
  assert.equal(results.filter((r) => r.result === 'DUPLICATE').length, 9);
  assert.equal((await t.service.getPublicState()).event.currentAmount, 100);
});

test('동시성: 추첨 버튼을 동시에 눌러도 같은 칸/같은 사람이 두 번 뽑히지 않음', async () => {
  const t = await setup({ prizes: [{ name: '쿠폰', quantity: 3 }] });
  for (const name of ['A', 'B', 'C', 'D']) await t.donate(name, 100);
  await t.service.forceRoulette();
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => t.service.drawNext()));
  const winners = (await t.service.getPublicState()).winners;
  assert.equal(winners.length, 3);
  assert.equal(new Set(winners.map((w) => w.key)).size, 3); // 모두 다른 사람
  assert.deepEqual(winners.map((w) => w.slotNo), [1, 2, 3]);
  assert.equal(results.filter((r) => r.status === 'fulfilled' && r.value.winner).length, 3);
  assert.equal(await t.status(), STATUS.RESULT);
});

test('동시성: "다음 선물상자 시작"을 연타해도 새 회차는 1개만 생성', async () => {
  const t = await setup();
  await playFullRound(t);
  const results = await Promise.allSettled([1, 2, 3].map(() => t.service.startNextRound()));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await t.service.listRounds()).length, 2);
});

// ---------------- DB 초기화 실패 격리 ----------------

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, () => resolve(server));
  });
}

test('DB 연결 실패 시 선물상자 API만 503, 다른 기능(TOP5 등)과 오버레이 화면은 정상 → DB가 살아나면 자동 복구', async () => {
  // 처음 2번은 연결 실패, 이후 정상인 DB를 흉내 냅니다.
  let failures = 2;
  const flakyDatabase = {
    ...database,
    exec: (sql) => (failures-- > 0 ? Promise.reject(new Error('connect ECONNREFUSED (테스트)')) : database.exec(sql)),
  };
  const app = express();
  app.get('/api/mission', (req, res) => res.json({ ok: true })); // 기존 TOP5 라우트 자리
  const { runtime } = mountGiftBox(app, {
    database: flakyDatabase,
    retryBaseMs: 30,
    serviceOptions: { scheduleTimers: false },
  });
  const server = await listen(app);
  const base = `http://localhost:${server.address().port}`;
  try {
    const giftDown = await fetch(`${base}/api/gift/state`);
    assert.equal(giftDown.status, 503);
    assert.match((await giftDown.json()).error, /DB/);
    assert.equal((await fetch(`${base}/api/mission`)).status, 200);
    assert.equal((await fetch(`${base}/overlay`)).status, 200);

    for (let i = 0; i < 50 && !runtime.giftService; i += 1) await new Promise((r) => setTimeout(r, 20));
    const giftUp = await fetch(`${base}/api/gift/state`);
    assert.equal(giftUp.status, 200);
    assert.equal((await giftUp.json()).event.roundNo, 1);
  } finally {
    server.close();
  }
});
