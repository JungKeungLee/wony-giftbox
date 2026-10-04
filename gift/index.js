// gift/index.js
// 선물상자 이벤트 기능을 기존 Express 앱(server.js)에 붙이는 진입점입니다.
// server.js에서는 mountGiftBox(app) 한 줄만 호출하면 되고, 기존 도전미션 TOP5 기능과는 서로 영향을 주지 않습니다.
//
// [DB 초기화 실패 격리]
// 라우트는 즉시 등록하고, PostgreSQL 연결/테이블 준비는 백그라운드에서 진행합니다.
// DB가 준비되기 전이나 연결에 실패한 동안에는 선물상자 API만 503을 돌려주고(자동 재시도),
// 서버 프로세스와 TOP5(/broadcast.html, /api/mission)는 정상 동작합니다.
//
// [공개 - 인증 없음, 조회 전용]
//   GET  /overlay                        OBS 브라우저 소스용 오버레이 화면
//   GET  /overlay-assets/*               오버레이 JS/CSS
//   GET  /api/gift/state                 현재 회차 공개 상태
//   GET  /api/gift/stream                실시간 이벤트(SSE)
//
// [관리자 - OPERATOR_TOKEN 인증 필요]
//   GET  /admin                          관리자 화면 (미인증이면 로그인 화면)
//   GET  /admin-assets/*                 관리자 JS/CSS
//   POST /api/gift/admin/login | logout
//   GET  /api/gift/admin/state
//   PUT  /api/gift/admin/settings        { targetAmount }
//   PUT  /api/gift/admin/prizes          { prizes: [{ name, quantity }] }
//   POST /api/gift/admin/start | stop
//   POST /api/gift/admin/donations       { nickname, donorId?, type, amount, eventId?, timestamp?, test? }
//   POST /api/gift/admin/donations/:id/cancel
//   PUT  /api/gift/admin/amount          { currentAmount }
//   POST /api/gift/admin/force-open | force-roulette | draw | next-round | reset-round
//   GET  /api/gift/admin/rounds          회차 기록 목록
//   GET  /api/gift/admin/rounds/:id      회차 상세 기록

const path = require('path');
const express = require('express');

const { openGiftDatabase, initSchema, GiftDatabaseConfigError } = require('./database');
const { GiftEventService, GiftError, isUniqueViolation } = require('./giftEventService');
const { DonationService, SOURCES } = require('./donationService');
const { createRealtimeHub } = require('./realtime');
const { requireAdmin, isAdminRequest, handleLogin, handleLogout, getOperatorToken } = require('./auth');
const { startProviders } = require('./providers');

const OVERLAY_DIR = path.join(__dirname, 'overlay');
const ADMIN_DIR = path.join(__dirname, 'admin');
const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 60000;

// 서비스 메서드(async)를 실행하고, 오류를 관리자에게 보여줄 메시지로 바꿔 응답합니다.
function handle(fn) {
  return (req, res) => {
    Promise.resolve()
      .then(() => fn(req))
      .then((result) => res.json(result))
      .catch((error) => {
        if (error instanceof GiftError) {
          return res.status(error.httpStatus).json({ error: error.message, code: error.code });
        }
        if (isUniqueViolation(error)) {
          return res.status(409).json({ error: '동시에 같은 요청이 처리되었습니다. 화면을 새로고침해주세요.', code: 'CONFLICT' });
        }
        console.error('[gift] 처리 중 오류:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다. (DB 연결 상태와 서버 로그를 확인해주세요)' });
      });
  };
}

// 연결 거부(ECONNREFUSED) 등은 message가 비어 있는 AggregateError로 오는 경우가 있어 코드까지 같이 보여줍니다.
function describeError(error) {
  const inner = error && Array.isArray(error.errors) && error.errors[0];
  return (error && error.message) || (inner && (inner.message || inner.code)) || (error && error.code) || String(error);
}

function noStore(res) {
  res.set('Cache-Control', 'no-store');
}

// options.database: 테스트 등에서 미리 만든 DB를 넣을 때 사용 (없으면 DATABASE_URL로 접속)
// options.retryBaseMs / serviceOptions: 테스트용 (재시도 간격, 서비스 옵션)
function mountGiftBox(app, options = {}) {
  const hub = createRealtimeHub();
  const runtime = { giftService: null, donationService: null, error: null, database: null };

  // ---------------- DB 초기화 (백그라운드 + 자동 재시도) ----------------
  async function initialize(attempt = 1) {
    try {
      if (!runtime.database) runtime.database = options.database || openGiftDatabase();
      await initSchema(runtime.database);
      const giftService = new GiftEventService(runtime.database, {
        publish: hub.publish,
        boxOpenMs: Number(process.env.GIFT_BOX_OPEN_MS) || undefined,
        spinMs: Number(process.env.GIFT_SPIN_MS) || undefined,
        winnerHoldMs: Number(process.env.GIFT_WINNER_HOLD_MS) || undefined,
        ...(options.serviceOptions || {}),
      });
      await giftService.init();
      runtime.giftService = giftService;
      runtime.donationService = new DonationService(giftService);
      runtime.error = null;
      console.log('[gift] 선물상자 DB(PostgreSQL) 준비 완료');
      await startProviders(runtime.donationService);
    } catch (error) {
      runtime.error = describeError(error);
      if (error instanceof GiftDatabaseConfigError) {
        // 설정 문제는 재시도해도 해결되지 않으므로 안내만 하고 멈춥니다. (TOP5는 계속 동작)
        console.error(`[gift] ⚠️ 선물상자 기능 비활성화: ${error.message}`);
        return;
      }
      const delay = Math.min((options.retryBaseMs ?? RETRY_BASE_MS) * attempt, RETRY_MAX_MS);
      console.error(`[gift] 선물상자 DB 초기화 실패 (${delay / 1000}초 후 재시도): ${runtime.error}`);
      const timer = setTimeout(() => initialize(attempt + 1), delay);
      if (timer.unref) timer.unref();
    }
  }
  const ready = initialize();

  // DB가 준비되기 전에는 선물상자 API만 503을 돌려줍니다.
  function requireReady(req, res, next) {
    if (runtime.giftService) return next();
    res.status(503).json({
      error: runtime.error
        ? `선물상자 DB에 연결할 수 없습니다: ${runtime.error}`
        : '선물상자 DB에 연결하는 중입니다. 잠시 후 다시 시도해주세요.',
      code: 'DB_NOT_READY',
    });
  }

  const router = express.Router();
  router.use('/api/gift', express.json({ limit: '32kb' }));

  // ---------------- 공개 (OBS 오버레이) ----------------
  // 오버레이 HTML 자체는 DB 없이도 열립니다. (DB가 준비되면 SSE 재연결로 자동 표시)
  router.get('/overlay', (req, res) => {
    noStore(res);
    res.sendFile(path.join(OVERLAY_DIR, 'overlay.html'));
  });
  router.use('/overlay-assets', express.static(OVERLAY_DIR, { index: false }));

  // ---------------- 관리자 화면 ----------------
  router.get('/admin', (req, res) => {
    noStore(res);
    res.sendFile(path.join(ADMIN_DIR, isAdminRequest(req) ? 'admin.html' : 'login.html'));
  });
  router.use('/admin-assets', (req, res, next) => {
    if (!isAdminRequest(req)) return res.status(401).send('관리자 인증이 필요합니다.');
    noStore(res);
    next();
  }, express.static(ADMIN_DIR, { index: false }));

  // 로그인/로그아웃은 DB와 무관합니다.
  router.post('/api/gift/admin/login', handleLogin);
  router.post('/api/gift/admin/logout', handleLogout);

  router.use('/api/gift', requireReady);
  const service = () => runtime.giftService;

  router.get('/api/gift/state', handle(() => service().getPublicState()));
  router.get('/api/gift/stream', (req, res) => hub.handleConnection(req, res, (write) =>
    service().inPublishOrder(async () => write(await service().getPublicState()))));

  // ---------------- 관리자 API ----------------
  const admin = express.Router();
  admin.use(requireAdmin);

  admin.get('/state', handle(() => service().getAdminState()));
  admin.put('/settings', handle((req) => service().updateSettings({ targetAmount: req.body.targetAmount })));
  admin.put('/prizes', handle((req) => service().setPrizes(req.body.prizes)));
  admin.post('/start', handle(() => service().start()));
  admin.post('/stop', handle(() => service().stop()));

  // 수동 등록 / 테스트 후원 / 외부 브리지(헤더 인증) 공용. 모두 DonationService의 같은 처리 로직을 탑니다.
  admin.post('/donations', handle(async (req) => {
    const body = req.body || {};
    const source = body.test ? SOURCES.TEST : body.source ? `EXTERNAL:${String(body.source).slice(0, 30)}` : SOURCES.MANUAL;
    const outcome = await runtime.donationService.receive(body, source);
    return { ...outcome, state: await service().getAdminState() };
  }));
  admin.post('/donations/:id/cancel', handle((req) => service().cancelDonation(Number(req.params.id))));

  admin.put('/amount', handle((req) => service().adjustCurrentAmount(req.body.currentAmount)));
  admin.post('/force-open', handle(() => service().forceOpen()));
  admin.post('/force-roulette', handle(() => service().forceRoulette()));
  admin.post('/draw', handle(() => service().drawNext()));
  admin.post('/next-round', handle(() => service().startNextRound()));
  admin.post('/reset-round', handle(() => service().resetRound()));

  admin.get('/rounds', handle(() => service().listRounds()));
  admin.get('/rounds/:id', handle((req) => service().getRoundDetail(Number(req.params.id))));

  router.use('/api/gift/admin', admin);
  app.use(router);

  if (!getOperatorToken()) {
    console.warn('[gift] ⚠️ .env에 OPERATOR_TOKEN이 없어 /admin 로그인이 불가능합니다.');
  }

  return { ready, hub, runtime };
}

module.exports = { mountGiftBox };
