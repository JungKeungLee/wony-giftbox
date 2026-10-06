// soop/balloon.js
// SOOP 공식 Chat SDK의 BALLOON_GIFTED 메시지를 선물상자 표준 후원 형식으로 바꾸는 순수 함수입니다.
//
// 공식 문서(SOOP Developers > Chat SDK > 후원 메세지 조회)의 BALLOON_GIFTED message 필드:
//   bjId, userId, userNickname, count, fanNumber, imageUrl, becomesTopFan, relaysBroad, fromVod
//
// 집계 규칙:
//   - 일반 별풍선(STAR)만 집계합니다. 도전미션/대결미션은 별도 action
//     (CHALLENGE_MISSION_GIFTED / BATTLE_MISSION_GIFTED)이므로 이 함수로 들어오지 않고, 들어와도 제외합니다.
//   - fromVod === true (VOD 별풍선) → 제외
//   - relaysBroad === true (중계방) → 제외
//   - 시그니처 별풍선은 문서상 별도 action이 없어 BALLOON_GIFTED의 count 그대로 집계합니다.
//   - SDK에는 이벤트 고유 ID가 없으므로 닉네임+개수+시간으로 중복 제거하지 않습니다.
//     (같은 사람이 같은 개수를 두 번 보내면 두 건 모두 집계)
//     eventId는 커넥터 페이지가 "수신 1건"마다 만든 UUID로, 같은 수신 건의 재전송만 막습니다.

const SOURCE = 'SOOP_OFFICIAL';

const EXCLUDE_REASONS = {
  NOT_BALLOON: 'BALLOON_GIFTED 이벤트가 아님',
  VOD: 'VOD 별풍선',
  RELAY: '중계방 별풍선',
  OTHER_BJ: '연결된 방송인과 다른 bjId',
  INVALID: '필수 필드 누락 또는 잘못된 개수',
};

const MAX_EVENT_ID_LENGTH = 100;

function text(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

// input: { action?, message: SDK message, clientEventId? }
// context: { bjId? }  — 연결된 방송인 아이디 (있으면 bjId가 다른 이벤트는 제외)
// 반환: { donation } 또는 { excluded: 사유코드 }
function balloonToDonation(input, context = {}) {
  const action = text(input && input.action) || 'BALLOON_GIFTED';
  if (action !== 'BALLOON_GIFTED') return { excluded: 'NOT_BALLOON' };

  const message = input && input.message;
  if (!message || typeof message !== 'object') return { excluded: 'INVALID' };

  if (message.fromVod === true) return { excluded: 'VOD' };
  if (message.relaysBroad === true) return { excluded: 'RELAY' };

  const expectedBjIds = [context.bjId, context.allowedBjId].map(text).filter(Boolean);
  const bjId = text(message.bjId);
  if (expectedBjIds.some((expected) => bjId !== expected)) return { excluded: 'OTHER_BJ' };

  const userId = text(message.userId);
  const count = Number(message.count);
  if (!userId || !Number.isInteger(count) || count <= 0) return { excluded: 'INVALID' };

  const clientEventId = text(input.clientEventId).slice(0, MAX_EVENT_ID_LENGTH);

  return {
    donation: {
      donorId: userId,
      nickname: text(message.userNickname) || userId,
      type: 'STAR',
      amount: count,
      source: SOURCE,
      eventId: clientEventId ? `sdk:${clientEventId}` : null,
    },
  };
}

module.exports = { balloonToDonation, SOURCE, EXCLUDE_REASONS };
