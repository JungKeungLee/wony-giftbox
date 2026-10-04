// gift/providers/DonationProvider.js
// 외부 방송 플랫폼(SOOP 등)의 후원 이벤트를 받아오는 "어댑터"의 공통 인터페이스입니다.
//
// ⚠️ 아직 실제 외부 API가 확정되지 않았기 때문에, 이 폴더에는 인터페이스와 등록 방법만 있고
//    가짜 API 구현은 일부러 넣지 않았습니다. (요구사항 19)
//
// 새 플랫폼을 연동할 때는 이 클래스를 상속해서 아래 세 가지만 구현하면 됩니다.
//   1) start(): 플랫폼에 연결(WebSocket/SDK/Webhook 등)하고 이벤트 수신을 시작
//   2) stop():  연결 종료
//   3) toDonation(rawEvent): 플랫폼 원본 이벤트 → 내부 표준 형식 변환 (해당 없으면 null)
// 그리고 이벤트를 받을 때마다 this.emitDonation(rawEvent)를 호출하면,
// DonationService → GiftEventService 로 이어지는 "동일한 후원 처리 로직"을 그대로 탑니다.
//
// 예시 (실제 SOOP 이벤트 필드명이 확정되면 채워 넣을 자리):
//
//   class SoopDonationProvider extends DonationProvider {
//     constructor(options) { super('SOOP', options); }
//     async start() { /* SOOP Chat SDK 연결 후 이벤트 핸들러에서 this.emitDonation(raw) 호출 */ }
//     async stop() { /* 연결 해제 */ }
//     toDonation(raw) {
//       // 예: 별풍선 이벤트 → STAR, 도전미션 → CHALLENGE, 대결미션 → BATTLE
//       return { donorId: raw.???, nickname: raw.???, type: 'STAR', amount: raw.???, timestamp: raw.???, eventId: raw.??? };
//     }
//   }

class DonationProvider {
  // name: 출처 이름 (gift_donation.source에 'EXTERNAL:이름'으로 저장되고, 이 출처 안에서 eventId 중복을 막습니다)
  constructor(name, options = {}) {
    if (!name) throw new Error('DonationProvider에는 name이 필요합니다.');
    this.name = name;
    this.options = options;
    this.donationService = null;
  }

  get source() {
    return `EXTERNAL:${this.name}`;
  }

  // providers/index.js가 DonationService를 연결해줍니다.
  attach(donationService) {
    this.donationService = donationService;
  }

  async start() {
    throw new Error(`${this.name}: start()를 구현해야 합니다.`);
  }

  async stop() {}

  // eslint-disable-next-line no-unused-vars
  toDonation(rawEvent) {
    throw new Error(`${this.name}: toDonation()을 구현해야 합니다.`);
  }

  // 플랫폼 원본 이벤트 1건을 처리합니다. 변환 결과가 null이면(후원이 아닌 이벤트) 무시합니다.
  // 실패해도 연결 자체가 끊기지 않도록 예외를 삼키고 로그만 남깁니다. (Promise를 돌려줍니다)
  async emitDonation(rawEvent) {
    if (!this.donationService) throw new Error(`${this.name}: DonationService가 연결되지 않았습니다.`);
    try {
      const donation = this.toDonation(rawEvent);
      if (!donation) return null;
      const result = await this.donationService.receive(donation, this.source);
      if (result.result === 'DUPLICATE') {
        console.log(`[gift:${this.name}] 중복 이벤트 무시: ${donation.eventId}`);
      }
      return result;
    } catch (error) {
      console.error(`[gift:${this.name}] 후원 처리 실패:`, error.message);
      return null;
    }
  }
}

module.exports = { DonationProvider };
