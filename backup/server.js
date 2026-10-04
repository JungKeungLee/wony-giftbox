// server.js
// Express로 만든 웹 서버입니다. 하는 일은 크게 4가지입니다.
// 1) 정적 파일(public 폴더 안의 html/css/js)을 브라우저에 제공합니다.
// 2) 후원 데이터를 저장/조회/초기화하는 API(주소)를 제공합니다.
// 3) Server-Sent Events(SSE)를 이용해 새 후원이 생기면 실시간으로 화면을 갱신시켜줍니다.
// 4) SOOP 연동 정보를 다룹니다 — 공개 송출 화면(broadcast.html)에는 절대 비밀값을 주지 않고,
//    운영자 전용 화면(settings.html)만 OPERATOR_TOKEN으로 확인한 뒤 비밀값/운영 기능을 내려줍니다.

require('dotenv').config();

const express = require('express');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const TOP_N = Number(process.env.TOP_N) || 5; // 화면에 보여줄 순위 수 (기본 TOP5)

// 브라우저가 보낸 JSON 요청 본문을 자바스크립트 객체로 자동 변환해줍니다.
app.use(express.json());

// public 폴더 안의 파일을 그대로 서비스합니다.
app.use(express.static(path.join(__dirname, 'public')));

// ---- SOOP 연결 상태 (메모리에만 저장 — 서버 재시작 시 초기화되는 "지금 연결됐는지" 표시용) ----
const liveStatus = {
  connected: false,
  lastError: null,
  lastEventAt: null,
  lastHeartbeatAt: 0,
};
const HEARTBEAT_TIMEOUT_MS = 30000; // 이 시간 동안 하트비트가 없으면 "연결 끊김"으로 간주

function isReallyConnected() {
  return liveStatus.connected && Date.now() - liveStatus.lastHeartbeatAt < HEARTBEAT_TIMEOUT_MS;
}

// 현재 실시간 갱신(SSE)에 연결되어 있는 브라우저들의 응답 객체를 담아두는 배열입니다.
const sseClients = [];

// 화면에 내려줄 순위표 + 연결 상태를 한 번에 만듭니다.
function buildPublicPayload() {
  return {
    ...db.getLeaderboard(TOP_N),
    live: {
      connected: isReallyConnected(),
      error: liveStatus.lastError,
      lastEventAt: liveStatus.lastEventAt,
    },
  };
}

// 순위표가 바뀔 때마다 연결된 모든 브라우저에게 최신 데이터를 보내줍니다. (실시간 갱신)
function broadcastLeaderboard() {
  const payload = `data: ${JSON.stringify(buildPublicPayload())}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// 실시간 갱신을 위한 SSE 엔드포인트입니다. 브라우저는 이 주소에 EventSource로 접속합니다.
app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  // 새로 접속한 브라우저에게 지금 순위표를 즉시 한 번 보내줍니다.
  res.write(`data: ${JSON.stringify(buildPublicPayload())}\n\n`);

  sseClients.push(res);

  // 브라우저 연결이 끊기면(새로고침, 창 닫기 등) 목록에서 제거합니다.
  req.on('close', () => {
    const index = sseClients.indexOf(res);
    if (index !== -1) sseClients.splice(index, 1);
  });
});

// 연결이 오래 유지되어도 중간 서버/프록시가 끊지 않도록 30초마다 하트비트를 보냅니다.
setInterval(() => {
  for (const client of sseClients) {
    client.write(': heartbeat\n\n');
  }
}, 30000);

// 현재 순위표를 한 번만 조회하는 API입니다. (페이지를 처음 열었을 때 사용)
app.get('/api/leaderboard', (req, res) => {
  res.json(buildPublicPayload());
});

// public/app.js(공개 페이지)가 화면에 "테스트 모드/실시간 모드" 배지를 그릴 때 쓰는 값입니다.
// ⚠️ 보안: Client Secret과 Access Token은 여기에 절대 포함하지 않습니다. (누구나 볼 수 있는 공개 API이기 때문)
app.get('/api/config', (req, res) => {
  res.json({
    clientId: process.env.SOOP_CLIENT_ID || '',
    hasToken: Boolean(db.getSoopToken()),
    topN: TOP_N,
  });
});

// ---- 운영자 전용 API (public/settings.html에서만 사용) ----
// OPERATOR_TOKEN을 아는 사람만 Client Secret / Access Token을 다룰 수 있도록 막는 간단한 게이트입니다.
function requireOperatorToken(req, res, next) {
  const expected = process.env.OPERATOR_TOKEN;
  if (!expected) {
    return res.status(500).json({ error: '서버 .env에 OPERATOR_TOKEN이 설정되어 있지 않습니다.' });
  }
  const provided = req.get('X-Operator-Token');
  if (provided !== expected) {
    return res.status(403).json({ error: '운영자 키가 올바르지 않습니다.' });
  }
  next();
}

// settings.html이 SOOP Chat SDK를 초기화할 때 필요한 민감한 값(Client Secret 포함)을 받아갑니다.
app.get('/api/operator/config', requireOperatorToken, (req, res) => {
  res.json({
    clientId: process.env.SOOP_CLIENT_ID || '',
    clientSecret: process.env.SOOP_CLIENT_SECRET || '',
    redirectUri: process.env.SOOP_REDIRECT_URI || '',
  });
});

// 저장되어 있는 SOOP Access/Refresh Token을 가져옵니다. (재로그인 없이 재연결을 시도할 때 사용)
app.get('/api/operator/token', requireOperatorToken, (req, res) => {
  res.json(db.getSoopToken() || {});
});

// OAuth 로그인 후 발급받은 토큰을 저장합니다. (서버 재시작 후에도 재사용하기 위함)
app.post('/api/operator/token', requireOperatorToken, (req, res) => {
  const { accessToken, refreshToken } = req.body;
  if (!accessToken) {
    return res.status(400).json({ error: 'accessToken이 필요합니다.' });
  }
  db.saveSoopToken({ accessToken, refreshToken });
  res.json({ saved: true });
});

// settings.html이 주기적으로 호출해서 "지금 연결되어 있는지"를 서버에 알려주는 하트비트입니다.
// 오류가 발생하면 error에 담아 보내고, 정상이면 error를 비워서 보냅니다.
app.post('/api/operator/status', requireOperatorToken, (req, res) => {
  const { connected, error, eventReceived } = req.body;

  liveStatus.connected = Boolean(connected);
  liveStatus.lastError = error || null;
  liveStatus.lastHeartbeatAt = Date.now();
  if (eventReceived) {
    liveStatus.lastEventAt = new Date().toISOString();
  }

  broadcastLeaderboard(); // 연결 상태 배지가 실시간으로 바뀌도록 즉시 알려줍니다.
  res.json({ ok: true });
});

// 후원 1건을 등록하는 API입니다.
// 실제 SOOP 후원(settings.html이 감지해서 전달)과 테스트 후원(settings.html의 테스트 폼) 모두 이 API를 함께 사용합니다.
// 순위를 조작할 수 있는 "운영" 기능이므로 운영자 키로 보호합니다.
app.post('/api/donations', requireOperatorToken, (req, res) => {
  const { userNickname, count, isTest } = req.body;
  let { userId } = req.body;

  // 값 검증: 닉네임과 1 이상의 개수가 없으면 저장하지 않습니다.
  const parsedCount = Number(count);
  if (!userNickname || !Number.isFinite(parsedCount) || parsedCount <= 0) {
    return res.status(400).json({ error: '닉네임과 1 이상의 별풍선 개수를 입력해주세요.' });
  }

  // 테스트 후원인데 userId가 없으면, 닉네임을 기반으로 만들어서
  // 같은 닉네임으로 여러 번 테스트하면 자동으로 합산되도록 합니다.
  if (!userId) {
    userId = `test_${userNickname}`;
  }

  const result = db.addDonation({
    userId,
    userNickname,
    count: parsedCount,
    isTest: Boolean(isTest),
  });

  // 중복 이벤트로 판단되어 저장하지 않았다면, 화면도 다시 그릴 필요가 없습니다.
  if (result.saved) {
    broadcastLeaderboard();
  }

  res.json({ ...buildPublicPayload(), saved: result.saved });
});

// 새 도전미션을 시작할 때 기존 순위를 초기화하는 API입니다.
// 확인창(confirm)은 브라우저(settings.js) 쪽에서 미리 띄우고, 사용자가 승인했을 때만 이 API를 호출합니다.
// 순위를 초기화하는 "운영" 기능이므로 운영자 키로 보호합니다.
app.post('/api/reset', requireOperatorToken, (req, res) => {
  db.resetAll();
  broadcastLeaderboard();
  res.json(buildPublicPayload());
});

app.listen(PORT, () => {
  console.log(`서버가 실행되었습니다: http://localhost:${PORT}`);
});
