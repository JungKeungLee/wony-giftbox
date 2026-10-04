// gift/donationService.js
// 후원 "수집"과 선물상자 "비즈니스 로직"을 분리하는 계층입니다.
//
// 어디서 온 후원이든(관리자 수동 등록, 테스트 후원, 외부 방송 플랫폼 Provider) 모두
// 이 파일의 receive()를 거쳐 아래 하나의 형식으로 통일된 뒤 giftEventService.applyDonation()으로 갑니다.
//
//   {
//     donorId:   "soop_user_id" | null,   // 있으면 우선 사용
//     nickname:  "철수",
//     type:      "STAR" | "CHALLENGE" | "BATTLE",
//     amount:    100,
//     timestamp: "2026-10-05T12:00:00.000Z",
//     eventId:   "외부 플랫폼의 고유 이벤트 ID" | null   // 있으면 중복 수신 방지에 사용
//   }

const { DONATION_TYPES } = require('./tickets');
const { GiftError } = require('./giftEventService');

// 한 번에 들어올 수 있는 최대 개수입니다. 오타(0을 몇 개 더 붙인 경우)로 게이지가 망가지는 것을 막습니다.
const MAX_DONATION_AMOUNT = Number(process.env.GIFT_MAX_DONATION_AMOUNT) || 1000000;
const MAX_NICKNAME_LENGTH = 50;

// 후원 출처 (DB의 gift_donation.source). 외부 이벤트 ID는 출처별로 중복을 판단합니다.
const SOURCES = {
  MANUAL: 'MANUAL', // 관리자 수동 등록
  TEST: 'TEST', // 관리자 테스트 후원
};

function cleanText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

// 외부/관리자 입력을 검증하고 내부 표준 형식으로 바꿉니다. 잘못된 값이면 GiftError를 던집니다.
function normalizeDonation(input, source) {
  if (!input || typeof input !== 'object') {
    throw new GiftError('INVALID_DONATION', '후원 데이터가 비어 있습니다.');
  }

  const donorId = cleanText(input.donorId) || null;
  let nickname = cleanText(input.nickname);
  // 닉네임이 없으면 donorId로 대신 표시하고, 둘 다 없으면 누구에게 응모권을 줄지 알 수 없으므로 거절합니다.
  if (!nickname && donorId) nickname = donorId;
  if (!nickname) {
    throw new GiftError('INVALID_NICKNAME', '닉네임(또는 donorId)이 없는 후원은 등록할 수 없습니다.');
  }
  if (nickname.length > MAX_NICKNAME_LENGTH) {
    throw new GiftError('INVALID_NICKNAME', `닉네임은 ${MAX_NICKNAME_LENGTH}자 이하여야 합니다.`);
  }

  const type = cleanText(input.type).toUpperCase();
  if (!DONATION_TYPES.includes(type)) {
    throw new GiftError('INVALID_TYPE', `후원 종류는 ${DONATION_TYPES.join(' / ')} 중 하나여야 합니다.`);
  }

  const amount = Number(input.amount);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new GiftError('INVALID_AMOUNT', '후원 개수는 1 이상의 정수여야 합니다. (0, 음수, 소수 불가)');
  }
  if (amount > MAX_DONATION_AMOUNT) {
    throw new GiftError('INVALID_AMOUNT', `한 번에 ${MAX_DONATION_AMOUNT.toLocaleString('ko-KR')}개를 넘는 후원은 등록할 수 없습니다.`);
  }

  let timestamp = null;
  if (input.timestamp) {
    const parsed = new Date(input.timestamp);
    if (Number.isNaN(parsed.getTime())) {
      throw new GiftError('INVALID_TIMESTAMP', 'timestamp 형식이 올바르지 않습니다.');
    }
    timestamp = parsed.toISOString();
  }

  const externalEventId = cleanText(input.eventId) || null;

  return {
    donorId,
    // 집계 기준 키: donorId가 있으면 donorId, 없으면 닉네임 (요구사항 17)
    donorKey: donorId ? `id:${donorId}` : `nick:${nickname}`,
    nickname,
    type,
    amount,
    timestamp,
    source: cleanText(source) || SOURCES.MANUAL,
    externalEventId,
  };
}

class DonationService {
  constructor(giftEventService) {
    this.giftEventService = giftEventService;
  }

  // 모든 후원의 단일 진입점입니다. (Promise를 돌려줍니다)
  // 반환값 result: 'COUNTED'(집계됨) | 'IGNORED'(수집 중이 아니라 기록만 함) | 'DUPLICATE'(이미 처리된 이벤트)
  async receive(input, source) {
    const donation = normalizeDonation(input, source);
    return this.giftEventService.applyDonation(donation);
  }
}

module.exports = { DonationService, normalizeDonation, SOURCES, MAX_DONATION_AMOUNT };
