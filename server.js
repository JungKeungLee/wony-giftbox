// server.js
// bcraping.kr(비공식 사이트)의 도전미션 API를 조회해서, 요청받은 스트리머(bj 또는 nick)가
// "현재 진행 중인" 도전미션과 "미확정"(종료됐지만 성공/실패로 판정되지 않은) 도전미션을
// 모두 모아, 그 후원자를 닉네임 기준으로 합산한 뒤 TOP5를 돌려주는 서버입니다.
//
// 특정 스트리머 하나로 고정되어 있지 않고, 요청마다 ?bj=아이디 또는 ?nick=닉네임을 받아서
// 그 스트리머만 조회합니다. 그래서 broadcast.html?bj=아무개 형태로 누구든 각자 쓸 수 있습니다.
//
// SOOP 공식 OAuth/Chat SDK는 전혀 사용하지 않습니다.
// bcraping.kr API는 브라우저가 아니라 이 서버(Node.js)에서만 호출합니다.

require('dotenv').config();

const express = require('express');
const path = require('path');
const { mountGiftBox } = require('./gift');

const app = express();
const PORT = process.env.PORT || 3000;

// Render 등 프록시 뒤에서 실행될 때 실제 접속자 IP(req.ip)와 HTTPS 여부(req.secure)를 올바르게 인식합니다.
// (선물상자 관리자 로그인 실패 제한, 보안 쿠키에 사용. Render는 RENDER 환경변수를 자동으로 넣어줍니다)
if (process.env.TRUST_PROXY || process.env.RENDER) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
}

// 같은 스트리머(bj/nick)를 이 시간(ms) 안에 다시 요청하면, bcraping.kr을 다시 부르지 않고
// 메모리에 저장해둔 결과를 그대로 돌려줍니다. (요구사항 6: 과도한 호출 방지)
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 30000;

const BCRAPING_BASE = 'https://bcraping.kr';

const BCRAPING_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json',
};

// 이 서비스는 이제 선물상자 시스템이 메인이므로, 루트 주소(/)는 관리자 화면으로 보냅니다.
// (기존 도전미션 TOP5 루트 안내 페이지 public/index.html은 제거했습니다)
app.get('/', (req, res) => res.redirect(302, '/admin'));

// 헬스 체크 (Render Health Check Path 등). DB 상태와 무관하게 서버 프로세스가 살아 있으면 200을 돌려줍니다.
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use(express.static(path.join(__dirname, 'public')));

// 선물상자 이벤트 (/admin 관리자 화면, /overlay OBS 오버레이, /api/gift/*). 자세한 내용은 GIFT_BOX_README.md
mountGiftBox(app);

// 스트리머(bj 또는 nick)별로 마지막 조회 결과를 저장해둡니다. (요구사항 5: URL마다 독립적으로 조회)
// key -> { data, fetchedAt }
const missionCache = new Map();

// 같은 스트리머에 대한 요청이 짧은 시간 안에 동시에 여러 번 들어와도,
// bcraping.kr 조회를 중복으로 시작하지 않도록 "진행 중인 조회"를 잠깐 공유합니다.
// key -> Promise
const inFlightFetches = new Map();

function cacheKeyFor({ bj, nick }) {
  return bj ? `bj:${bj}` : `nick:${nick}`;
}

// 제목에 이 단어들이 들어간 미션은 스트리머와 상관없이 항상 집계에서 제외합니다.
const EXCLUDED_TITLE_KEYWORDS = ['도시락'];

function isExcludedMission(mission) {
  return EXCLUDED_TITLE_KEYWORDS.some((keyword) => (mission.title || '').includes(keyword));
}

// 부캐 등 서로 다른 닉네임이지만 같은 사람으로 합쳐서 보여주고 싶을 때 씁니다.
// key(부캐 닉네임) -> value(화면에 대신 보여줄 닉네임)
const NICKNAME_ALIASES = {
  Sol_솔부캐: 'Sol_솔',
};

function canonicalNickname(nickname) {
  return NICKNAME_ALIASES[nickname] || nickname;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: BCRAPING_HEADERS });
  if (!res.ok) {
    throw new Error(`bcraping.kr 응답 오류 (HTTP ${res.status})`);
  }
  const body = await res.json();
  if (!body.result) {
    throw new Error(`bcraping.kr 응답 실패: ${body.message || '알 수 없는 오류'}`);
  }
  return body.data;
}

// bj(아이디) 또는 nick(닉네임)으로 정확히 일치하는 스트리머 한 명을 찾습니다.
// bcraping.kr의 미션 API는 경로에 bjId가 필요해서, nick으로만 요청이 온 경우
// 이 검색을 통해 먼저 bjId를 알아내야 합니다.
async function resolveBj({ bj, nick }) {
  const query = bj || nick;
  const candidates = await fetchJson(`${BCRAPING_BASE}/api/search/bj?q=${encodeURIComponent(query)}`);

  const match = bj
    ? candidates.find((candidate) => candidate.BJ_ID === bj)
    : candidates.find((candidate) => candidate.BJ_NAME === nick || candidate.BJ_DISPLAY_NAME === nick);

  if (!match) {
    return null;
  }

  return { bjId: match.BJ_ID, bjNick: match.BJ_NAME };
}

// bcraping.kr의 미션 목록 응답(raw item)을 서버 내부에서 다루기 쉬운 형태로 바꿉니다.
function normalizeMission(bjId, bjNick, raw) {
  return {
    missionKey: raw.MISSION_KEY,
    title: raw.TITLE || '',
    bjId,
    bjNick,
    totalStars: raw.FUNDING_SUM || 0,
    fundingStatus: raw.FUNDING_STATUS, // 'PENDING' | 'SETTLED' | 'EXPIRED' | null
    outcome: raw.OUTCOME,
  };
}

// 미션 목록(mission summary 배열)을 받아서, 각 미션의 후원자 상세를 병렬로 조회한 뒤
// 닉네임 기준으로 합산하고 TOP5를 뽑습니다. active 미션 합산과 미확정 미션 합산이
// 로직이 똑같아서 공용으로 뺐습니다.
async function aggregateDonorsAcrossMissions(bjId, missions) {
  const details = await Promise.all(
    missions.map((mission) =>
      fetchJson(`${BCRAPING_BASE}/api/mission/${bjId}/${mission.missionKey}`).catch((error) => {
        console.warn(`미션 ${mission.missionKey} 상세 조회 실패, 이 미션은 건너뜁니다:`, error.message);
        return null;
      })
    )
  );

  const starsByNickname = new Map();
  for (const detail of details) {
    if (!detail) continue; // 실패한 미션은 건너뜀
    for (const participant of detail.participants || []) {
      const nickname = canonicalNickname(participant.USER_NAME);
      const accumulated = starsByNickname.get(nickname) || 0;
      starsByNickname.set(nickname, accumulated + (participant.TOTAL_COUNT || 0));
    }
  }

  const topRanking = Array.from(starsByNickname.entries())
    .map(([nickname, stars]) => ({ nickname, stars }))
    .sort((a, b) => b.stars - a.stars)
    .slice(0, 5)
    .map((donor, index) => ({ rank: index + 1, ...donor }));

  return topRanking;
}

// 진행 중(active)인 미션 목록만 가져옵니다. bcraping.kr에서는 FUNDING_STATUS가
// 'PENDING'인 미션이 아직 모금이 진행 중인(=진행 중) 미션입니다.
function pickActiveMissions(missions) {
  return missions.filter((mission) => mission.fundingStatus === 'PENDING' && !isExcludedMission(mission));
}

// "미확정" 상태인 미션 목록만 가져옵니다. bcraping.kr에서는 모금 기간이 끝났는데도
// 스트리머가 성공/실패를 판정하지 않고 그대로 만료된 미션이 FUNDING_STATUS: 'EXPIRED'로
// 남는데, 사이트에서는 이걸 성공/실패 확정과 구분해서 다룹니다.
function pickUnconfirmedMissions(missions) {
  return missions.filter((mission) => mission.fundingStatus === 'EXPIRED' && !isExcludedMission(mission));
}

// 특정 스트리머(bj 또는 nick)의 "진행 중인" 미션과 "미확정" 미션을 항상 같이 가져와서,
// 둘을 합친 전체 후원자를 닉네임 기준으로 합산한 뒤 TOP5를 계산합니다.
// (진행 중인 미션이 있어도 미확정 미션을 무시하지 않고 항상 같이 더합니다.)
async function fetchMissionData({ bj, nick }) {
  const resolved = await resolveBj({ bj, nick });

  if (!resolved) {
    return {
      hasMission: false,
      bjId: bj || null,
      bjNick: nick || null,
      missionCount: 0,
      totalStars: 0,
      topRanking: [],
      missionStatus: 'none',
      updatedAt: new Date().toISOString(),
    };
  }

  const { bjId, bjNick } = resolved;

  // bcraping.kr은 CHALLENGE(도전미션)와 BATTLE(대결미션)을 같은 목록으로 섞어서 주기 때문에,
  // 대결미션과 알 수 없는(MISSION_TYPE: 'UNKNOWN') 항목은 걸러내고 도전미션만 사용합니다.
  const missionList = await fetchJson(`${BCRAPING_BASE}/api/mission/${bjId}`);
  const challengeMissions = (missionList.contents || [])
    .filter((raw) => raw.MISSION_TYPE === 'CHALLENGE')
    .map((raw) => normalizeMission(bjId, bjNick, raw));

  const activeMissions = pickActiveMissions(challengeMissions);
  const unconfirmedMissions = pickUnconfirmedMissions(challengeMissions);
  const allMissions = [...activeMissions, ...unconfirmedMissions];

  if (allMissions.length === 0) {
    return {
      hasMission: false,
      bjId,
      bjNick,
      missionCount: 0,
      totalStars: 0,
      topRanking: [],
      missionStatus: 'none',
      updatedAt: new Date().toISOString(),
    };
  }

  // 미션 목록 자체에 들어있는 totalStars를 더합니다. 아래 상세 조회가 일부 실패하더라도
  // "전체 별풍선 총합"만큼은 정확하게 유지하기 위해, 상세 조회 결과와는 별도로 계산합니다.
  const totalStars = allMissions.reduce((sum, mission) => sum + (mission.totalStars || 0), 0);
  const topRanking = await aggregateDonorsAcrossMissions(bjId, allMissions);

  const missionStatus =
    activeMissions.length > 0 && unconfirmedMissions.length > 0
      ? 'active+unconfirmed'
      : activeMissions.length > 0
      ? 'active'
      : 'unconfirmed';

  return {
    hasMission: true,
    bjId,
    bjNick,
    missionCount: allMissions.length,
    activeMissionCount: activeMissions.length,
    unconfirmedMissionCount: unconfirmedMissions.length,
    totalStars,
    topRanking,
    missionStatus,
    updatedAt: new Date().toISOString(),
  };
}

// 캐시 → 진행 중인 조회 공유 → 새 조회, 순서로 데이터를 가져옵니다.
async function getMissionDataCached({ bj, nick }) {
  const key = cacheKeyFor({ bj, nick });
  const cached = missionCache.get(key);
  const now = Date.now();

  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return { ...cached.data, cached: true };
  }

  // 같은 스트리머를 지금 막 다른 요청이 이미 조회하고 있다면, 그 결과를 같이 기다립니다.
  if (inFlightFetches.has(key)) {
    const data = await inFlightFetches.get(key);
    return { ...data, cached: false };
  }

  const fetchPromise = fetchMissionData({ bj, nick })
    .then((data) => {
      missionCache.set(key, { data, fetchedAt: Date.now() });
      return data;
    })
    .finally(() => {
      inFlightFetches.delete(key);
    });

  inFlightFetches.set(key, fetchPromise);

  try {
    const data = await fetchPromise;
    return { ...data, cached: false };
  } catch (error) {
    // 조회에 실패해도, 이전에 이 스트리머를 성공적으로 조회한 적이 있다면 그 결과를 그대로 유지합니다.
    if (cached) {
      return { ...cached.data, cached: true, lastError: error.message };
    }
    throw error;
  }
}

// 특정 스트리머의 현재 상태를 조회하는 API입니다. ?bj=아이디 또는 ?nick=닉네임 중 하나가 필요합니다.
app.get('/api/mission', async (req, res) => {
  const bj = String(req.query.bj || '').trim();
  const nick = String(req.query.nick || '').trim();

  if (!bj && !nick) {
    return res.status(400).json({
      error: 'bj 또는 nick 쿼리 파라미터가 필요합니다. 예: /api/mission?bj=whiteone325',
    });
  }

  try {
    const data = await getMissionDataCached({ bj, nick });
    res.json(data);
  } catch (error) {
    console.error(`bcraping.kr 조회 실패 (${bj ? `bj=${bj}` : `nick=${nick}`}):`, error.message);
    res.status(502).json({ error: `bcraping.kr 조회에 실패했습니다: ${error.message}` });
  }
});

// `node server.js`로 직접 실행할 때만 서버를 시작합니다. (테스트에서는 app만 불러와 사용)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`서버가 실행되었습니다: http://localhost:${PORT}`);
    console.log('사용 예: http://localhost:' + PORT + '/broadcast.html?bj=아이디&goal=목표치');
    console.log(`선물상자 관리자: http://localhost:${PORT}/admin  /  OBS 오버레이: http://localhost:${PORT}/overlay`);
  });
}

module.exports = app;
