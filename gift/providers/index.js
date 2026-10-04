// gift/providers/index.js
// 사용할 외부 후원 Provider를 등록/시작하는 곳입니다.
//
// 현재는 외부 플랫폼 API가 확정되지 않아 등록된 Provider가 없습니다.
// 그래도 관리자 페이지의 "테스트 후원"과 "후원 수동 등록"으로 전체 흐름을 테스트할 수 있습니다.
//
// 연동이 준비되면 DonationProvider를 상속한 클래스를 만든 뒤 아래 배열에 추가하세요.
//   const { SoopDonationProvider } = require('./SoopDonationProvider');
//   const PROVIDERS = [new SoopDonationProvider({ ... })];

const PROVIDERS = [];

async function startProviders(donationService) {
  for (const provider of PROVIDERS) {
    provider.attach(donationService);
    try {
      await provider.start();
      console.log(`[gift] 후원 Provider 시작: ${provider.name}`);
    } catch (error) {
      console.error(`[gift] 후원 Provider 시작 실패 (${provider.name}):`, error.message);
    }
  }
}

module.exports = { startProviders, PROVIDERS };
