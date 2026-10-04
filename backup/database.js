// database.js
// SQLite 데이터베이스 연결과 후원 데이터 관련 함수들을 모아둔 파일입니다.
// Node.js에 내장된 node:sqlite 모듈(DatabaseSync)을 사용합니다.
// 별도의 네이티브 빌드 도구(Python, Visual Studio Build Tools 등) 설치 없이
// Node.js 22.5 이상만 있으면 바로 동작하고, 동기(sync) 방식이라 콜백 없이 결과를 바로 받을 수 있어
// 초보자가 코드 흐름을 이해하기 쉽습니다.

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// data 폴더가 없으면 새로 만들어줍니다. (DB 파일을 저장할 위치)
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// leaderboard.db 파일에 연결합니다. 파일이 없으면 자동으로 새로 생성됩니다.
// 이 파일 덕분에 서버를 껐다 켜거나 브라우저를 새로고침해도 후원 데이터가 유지됩니다.
const dbPath = path.join(dataDir, 'leaderboard.db');
const db = new DatabaseSync(dbPath);

// 후원 내역을 한 건씩 저장할 테이블을 만듭니다. (이미 있으면 아무 일도 하지 않습니다)
// - user_id      : 후원자를 구분하는 고유 아이디 (같은 사람이면 항상 같은 값)
// - user_nickname: 후원자의 닉네임 (닉네임은 바뀔 수 있어서 항상 최신 값을 화면에 보여줍니다)
// - star_count   : 이번 한 번의 후원으로 준 별풍선 개수
// - is_test       : 테스트 모드에서 만든 가짜 후원이면 1, 실제 방송 후원이면 0
// - donated_at    : 후원이 발생한 시각 (동점자의 순위를 가릴 때 사용합니다)
db.exec(`
  CREATE TABLE IF NOT EXISTS donation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    user_nickname TEXT NOT NULL,
    star_count INTEGER NOT NULL,
    is_test INTEGER NOT NULL DEFAULT 0,
    donated_at TEXT NOT NULL
  )
`);

// SOOP Chat SDK의 OAuth Access/Refresh Token을 저장해두는 테이블입니다.
// 딱 1행(id = 1)만 유지하며(운영자 계정 1개 기준), 서버가 재시작되어도
// public/connect.html이 다시 로그인하지 않고 이 토큰으로 재연결을 시도할 수 있게 해줍니다.
db.exec(`
  CREATE TABLE IF NOT EXISTS soop_auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT,
    refresh_token TEXT,
    updated_at TEXT
  )
`);

// 같은 후원 이벤트가 짧은 시간 안에 중복으로 들어오는 것을 막기 위한 장치입니다.
// SOOP 공식 문서의 CHALLENGE_MISSION_GIFTED 이벤트에는 "이벤트 고유 ID"가 없기 때문에
// 완벽한 중복 판별은 불가능하지만, "같은 사람이 같은 개수로 아주 짧은 시간(3초) 안에 또 들어오면
// 네트워크 재연결 등으로 인한 중복 수신으로 간주한다"는 현실적인 기준으로 걸러냅니다.
const recentEventKeys = new Map(); // key: `${userId}:${count}` -> 마지막으로 처리한 시각(ms)
const DEDUP_WINDOW_MS = 3000;

function isDuplicateEvent(userId, count) {
  const key = `${userId}:${count}`;
  const now = Date.now();

  // 오래된 기록은 계속 쌓이지 않도록 정리합니다.
  for (const [existingKey, timestamp] of recentEventKeys) {
    if (now - timestamp > DEDUP_WINDOW_MS) {
      recentEventKeys.delete(existingKey);
    }
  }

  const lastSeenAt = recentEventKeys.get(key);
  if (lastSeenAt && now - lastSeenAt < DEDUP_WINDOW_MS) {
    return true; // 중복으로 판단
  }

  recentEventKeys.set(key, now);
  return false;
}

// 후원 1건을 데이터베이스에 저장합니다.
// 중복 이벤트로 판단되면 저장하지 않고 { saved: false }를 돌려줍니다. (동일 이벤트 중복 수신 방지)
function addDonation({ userId, userNickname, count, isTest }) {
  if (isDuplicateEvent(userId, count)) {
    return { saved: false, reason: 'duplicate' };
  }

  const stmt = db.prepare(`
    INSERT INTO donation_events (user_id, user_nickname, star_count, is_test, donated_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  // 시각은 밀리초 단위까지 저장해서, 같은 초에 여러 건이 들어와도 순서를 정확히 구분할 수 있게 합니다.
  const donatedAt = new Date().toISOString();
  stmt.run(userId, userNickname, count, isTest ? 1 : 0, donatedAt);

  return { saved: true };
}

// 모든 후원 내역을 시간 순서대로 가져온 뒤, 사용자별로 합산해서 순위표를 계산합니다.
// SQL의 복잡한 문법 대신 자바스크립트로 직접 계산해서, 처음 보는 사람도 흐름을 따라가기 쉽게 만들었습니다.
// limit: 화면에 보여줄 순위 수 (기본 5위까지 - 요구사항: TOP5 표시)
function getLeaderboard(limit = 5) {
  const rows = db.prepare('SELECT * FROM donation_events ORDER BY donated_at ASC').all();

  // userId를 key로 사용하는 Map에 사용자별 누적 정보를 쌓아 나갑니다.
  const userMap = new Map();

  for (const row of rows) {
    const existing = userMap.get(row.user_id);
    if (existing) {
      // 이미 후원한 적 있는 사용자면 별풍선 개수만 더해줍니다. (후원자 ID 기준 중복 합산)
      existing.totalCount += row.star_count;
      existing.userNickname = row.user_nickname; // 닉네임은 가장 최근 값으로 갱신
    } else {
      // 처음 등장한 사용자면 새로 등록합니다.
      userMap.set(row.user_id, {
        userId: row.user_id,
        userNickname: row.user_nickname,
        totalCount: row.star_count,
        firstDonatedAt: row.donated_at, // 이 사용자가 "가장 먼저" 후원한 시각 (동점 비교용)
      });
    }
  }

  // Map을 배열로 바꾼 뒤, ① 별풍선 개수 내림차순 ② 동점이면 먼저 후원한 시각 오름차순으로 정렬합니다.
  const ranking = Array.from(userMap.values()).sort((a, b) => {
    if (b.totalCount !== a.totalCount) {
      return b.totalCount - a.totalCount; // 별풍선이 많은 사람이 위로
    }
    return new Date(a.firstDonatedAt) - new Date(b.firstDonatedAt); // 동점이면 먼저 후원한 사람이 위로
  });

  const totalStarCount = ranking.reduce((sum, user) => sum + user.totalCount, 0);
  const participantCount = ranking.length;

  return {
    topRanking: ranking.slice(0, limit),
    totalStarCount,
    participantCount,
  };
}

// 새 도전미션을 시작할 때 기존 순위(후원 내역)를 모두 지웁니다.
function resetAll() {
  db.exec('DELETE FROM donation_events');
  recentEventKeys.clear();
}

// SOOP Chat SDK OAuth 인증 후 발급받은 토큰을 저장합니다. (한 번만 로그인하면 재시작 후에도 재사용)
function saveSoopToken({ accessToken, refreshToken }) {
  const updatedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO soop_auth (id, access_token, refresh_token, updated_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      updated_at = excluded.updated_at
  `).run(accessToken || null, refreshToken || null, updatedAt);
}

// 저장된 SOOP 토큰을 가져옵니다. 저장된 적이 없으면 null을 돌려줍니다.
function getSoopToken() {
  const row = db.prepare('SELECT * FROM soop_auth WHERE id = 1').get();
  if (!row || !row.access_token) return null;
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  addDonation,
  getLeaderboard,
  resetAll,
  saveSoopToken,
  getSoopToken,
};
