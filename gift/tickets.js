// gift/tickets.js
// 선물상자 이벤트에서 "응모권 계산"과 "가중치 추첨"만 담당하는 순수 함수 모음입니다.
// DB나 Express에 전혀 의존하지 않아서, 테스트(test/gift.test.js)에서 그대로 불러 쓸 수 있습니다.

const crypto = require('crypto');

// 후원 종류는 이 세 가지만 인정합니다. (별풍선 / 도전미션 / 대결미션)
const DONATION_TYPES = ['STAR', 'CHALLENGE', 'BATTLE'];

const DONATION_TYPE_LABELS = {
  STAR: '별풍선',
  CHALLENGE: '도전미션',
  BATTLE: '대결미션',
};

// 기본 응모권 지급 기준: 100개 = 응모권 1개 (관리자 화면에서 회차별로 바꿀 수 있음, gift_event.ticket_unit)
const DEFAULT_TICKET_UNIT = 100;
const MAX_TICKET_UNIT = 1000000;

// 저장된 기준값이 없거나(기존 데이터) 잘못된 값이면 기본값 100으로 처리합니다.
function normalizeTicketUnit(value) {
  const unit = Number(value);
  return Number.isInteger(unit) && unit >= 1 ? unit : DEFAULT_TICKET_UNIT;
}

// 총 후원 개수로 응모권 개수를 계산합니다. (나머지는 버림)
// ticketCount = floor(누적 후원 / ticketUnit)
// 예(기준 100): 99 → 0, 100 → 1, 199 → 1, 550 → 5
// 예(기준 200): 199 → 0, 200 → 1, 399 → 1, 400 → 2, 550 → 2
function ticketCount(totalDonation, ticketUnit = DEFAULT_TICKET_UNIT) {
  if (!Number.isFinite(totalDonation) || totalDonation <= 0) return 0;
  return Math.floor(totalDonation / normalizeTicketUnit(ticketUnit));
}

// 응모권으로 바뀌지 않은 "기준 미만 잔여 개수"입니다. 예(기준 100): 520 → 20
function ticketRemainder(totalDonation, ticketUnit = DEFAULT_TICKET_UNIT) {
  if (!Number.isFinite(totalDonation) || totalDonation <= 0) return 0;
  return totalDonation % normalizeTicketUnit(ticketUnit);
}

// 후원 내역(여러 건)을 후원자별로 합산합니다.
// donations: [{ donorKey, donorId, nickname, type, amount }]
// 같은 donorKey면 같은 사람으로 보고 종류(STAR/CHALLENGE/BATTLE)에 상관없이 개수를 모두 더합니다.
// 닉네임은 가장 마지막 후원의 닉네임을 보여줍니다. (닉네임 변경 대응)
function aggregateDonors(donations, ticketUnit = DEFAULT_TICKET_UNIT) {
  const donorMap = new Map();

  for (const donation of donations) {
    let donor = donorMap.get(donation.donorKey);
    if (!donor) {
      donor = {
        donorKey: donation.donorKey,
        donorId: donation.donorId || null,
        nickname: donation.nickname,
        total: 0,
        byType: { STAR: 0, CHALLENGE: 0, BATTLE: 0 },
        donationCount: 0,
      };
      donorMap.set(donation.donorKey, donor);
    }
    donor.nickname = donation.nickname;
    donor.total += donation.amount;
    donor.byType[donation.type] = (donor.byType[donation.type] || 0) + donation.amount;
    donor.donationCount += 1;
  }

  return Array.from(donorMap.values())
    .map((donor) => ({
      ...donor,
      tickets: ticketCount(donor.total, ticketUnit),
      remainder: ticketRemainder(donor.total, ticketUnit),
    }))
    .sort((a, b) => b.total - a.total);
}

// 0 이상 max 미만의 정수 난수입니다. 추첨 공정성을 위해 Math.random 대신 crypto를 씁니다.
function secureRandomInt(max) {
  return crypto.randomInt(0, max);
}

// 누적 가중치(cumulative weight) 방식의 가중치 추첨입니다.
// candidates: [{ ..., tickets }] — tickets가 곧 가중치입니다.
// 예: A 5장, B 3장, C 2장 → 누적 [5, 8, 10], 0~9 난수 r에 대해
//     r < 5 → A, r < 8 → B, 나머지 → C  (A 50%, B 30%, C 20%)
// 이름을 응모권 수만큼 배열에 복제하지 않으므로 응모권이 많아도 메모리를 쓰지 않습니다.
// randomInt를 주입할 수 있게 해서 테스트에서 결과를 고정할 수 있습니다.
function weightedPick(candidates, randomInt = secureRandomInt) {
  const pool = candidates.filter((candidate) => candidate.tickets > 0);
  const totalWeight = pool.reduce((sum, candidate) => sum + candidate.tickets, 0);
  if (totalWeight <= 0) return null;

  const roll = randomInt(totalWeight);
  let cumulative = 0;
  for (const candidate of pool) {
    cumulative += candidate.tickets;
    if (roll < cumulative) {
      return { winner: candidate, roll, totalWeight };
    }
  }
  // 정상적으로는 도달하지 않지만, randomInt가 잘못된 값을 주더라도 마지막 후보를 돌려줍니다.
  return { winner: pool[pool.length - 1], roll, totalWeight };
}

// 상품 목록을 "추첨 칸(slot)" 목록으로 펼칩니다.
// 예: [{ 1등 치킨 x1 }, { 2등 스타벅스 x2 }] → 슬롯 1: 치킨, 슬롯 2: 스타벅스, 슬롯 3: 스타벅스
function expandPrizeSlots(prizes) {
  const slots = [];
  const sorted = [...prizes].sort((a, b) => a.prizeOrder - b.prizeOrder || a.id - b.id);
  for (const prize of sorted) {
    for (let i = 0; i < prize.quantity; i += 1) {
      slots.push({ slotNo: slots.length + 1, prize });
    }
  }
  return slots;
}

module.exports = {
  DONATION_TYPES,
  DONATION_TYPE_LABELS,
  DEFAULT_TICKET_UNIT,
  MAX_TICKET_UNIT,
  normalizeTicketUnit,
  ticketCount,
  ticketRemainder,
  aggregateDonors,
  weightedPick,
  expandPrizeSlots,
};
