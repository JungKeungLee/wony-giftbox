// gift/database.js
// 선물상자 이벤트용 PostgreSQL(Neon) 연결과 테이블 정의입니다.
//
// 운영(Render)에서는 DATABASE_URL(Neon 연결 문자열)로 접속합니다. Render의 디스크는 배포/재시작 때마다
// 초기화되기 때문에, 이벤트 상태(READY/ACTIVE/...)와 게이지·기록은 모두 외부 DB(Neon)에 저장합니다.
//
// 서비스 코드(giftEventService.js)는 아래 공통 인터페이스만 사용하므로, 운영의 node-postgres(pg)와
// 테스트용 PGlite(메모리에서 도는 진짜 PostgreSQL)를 똑같이 다룰 수 있습니다.
//   query(sql, params)   → { rows, rowCount }
//   exec(sql)            → 여러 문장 실행 (테이블 생성용)
//   transaction(fn)      → fn(tx) 안의 tx.query(...)를 하나의 트랜잭션으로 실행 (예외 시 ROLLBACK)
//   snapshot(fn)         → 읽기 전용 + 같은 시점의 데이터로 여러 쿼리를 실행 (화면 상태 조회용)
//   close()

const SCHEMA_SQL = `
  -- 회차(선물상자 1개) 정보입니다. 회차가 끝나도 삭제하지 않고 FINISHED 상태로 남겨 기록으로 씁니다.
  CREATE TABLE IF NOT EXISTS gift_event (
    id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    round_no          INTEGER     NOT NULL UNIQUE,
    target_amount     INTEGER     NOT NULL CHECK (target_amount > 0),
    current_amount    INTEGER     NOT NULL DEFAULT 0 CHECK (current_amount >= 0),
    ticket_unit       INTEGER     NOT NULL DEFAULT 100 CHECK (ticket_unit > 0),
    winner_count      INTEGER     NOT NULL DEFAULT 0 CHECK (winner_count >= 0),
    status            VARCHAR(20) NOT NULL CHECK (status IN ('READY', 'ACTIVE', 'BOX_OPENING', 'ROULETTE', 'RESULT', 'FINISHED')),
    status_changed_at TIMESTAMPTZ NOT NULL,
    end_reason        VARCHAR(20) CHECK (end_reason IN ('COMPLETED', 'RESET')),
    started_at        TIMESTAMPTZ,
    goal_reached_at   TIMESTAMPTZ,
    finished_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL
  );

  -- 진행 중(FINISHED가 아닌) 회차는 항상 최대 1개만 존재하도록 DB 차원에서 막습니다.
  CREATE UNIQUE INDEX IF NOT EXISTS ux_gift_event_single_open
    ON gift_event ((status <> 'FINISHED')) WHERE status <> 'FINISHED';

  -- 후원 1건 = 1행입니다. 취소/무시된 후원도 지우지 않고 status로 구분합니다.
  CREATE TABLE IF NOT EXISTS gift_donation (
    id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id          INTEGER      NOT NULL REFERENCES gift_event(id),
    donor_key         VARCHAR(200) NOT NULL,
    donor_id          VARCHAR(100),
    nickname          VARCHAR(50)  NOT NULL,
    donation_type     VARCHAR(20)  NOT NULL CHECK (donation_type IN ('STAR', 'CHALLENGE', 'BATTLE')),
    amount            INTEGER      NOT NULL CHECK (amount > 0),
    status            VARCHAR(20)  NOT NULL DEFAULT 'COUNTED' CHECK (status IN ('COUNTED', 'CANCELED', 'IGNORED')),
    ignored_reason    VARCHAR(50),
    source            VARCHAR(50)  NOT NULL,
    external_event_id VARCHAR(200),
    donated_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ  NOT NULL,
    canceled_at       TIMESTAMPTZ,
    UNIQUE (source, external_event_id)
  );
  CREATE INDEX IF NOT EXISTS ix_gift_donation_event ON gift_donation (event_id, status);
  CREATE INDEX IF NOT EXISTS ix_gift_donation_donor ON gift_donation (event_id, donor_key);

  -- 회차별 상품입니다. quantity만큼 추첨 칸이 생깁니다. (동일 상품 여러 개 지원)
  CREATE TABLE IF NOT EXISTS gift_prize (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id    INTEGER      NOT NULL REFERENCES gift_event(id),
    prize_order INTEGER      NOT NULL,
    prize_name  VARCHAR(100) NOT NULL,
    quantity    INTEGER      NOT NULL DEFAULT 1 CHECK (quantity >= 1),
    created_at  TIMESTAMPTZ  NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_gift_prize_event ON gift_prize (event_id, prize_order);

  -- 당첨 기록입니다.
  --  (event_id, slot_no)   : 같은 칸을 두 번 추첨하지 않음
  --  (event_id, donor_key) : 같은 회차에서 같은 사람이 두 번 당첨되지 않음 (중복 당첨 불가는 고정 규칙)
  CREATE TABLE IF NOT EXISTS gift_winner (
    id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id      INTEGER      NOT NULL REFERENCES gift_event(id),
    prize_id      INTEGER      NOT NULL REFERENCES gift_prize(id),
    slot_no       INTEGER      NOT NULL,
    donor_key     VARCHAR(200) NOT NULL,
    donor_id      VARCHAR(100),
    nickname      VARCHAR(50)  NOT NULL,
    ticket_count  INTEGER      NOT NULL,
    total_tickets INTEGER      NOT NULL,
    selected_at   TIMESTAMPTZ  NOT NULL,
    UNIQUE (event_id, slot_no),
    UNIQUE (event_id, donor_key)
  );

  -- 관리자 조작 기록(감사 로그)입니다. 게이지 수동 수정, 강제 오픈 등 숫자가 후원 합계와
  -- 달라질 수 있는 조작과 추첨 난수를 나중에 확인할 수 있도록 남깁니다.
  CREATE TABLE IF NOT EXISTS gift_event_log (
    id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id   INTEGER     NOT NULL REFERENCES gift_event(id),
    action     VARCHAR(50) NOT NULL,
    detail     JSONB,
    created_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_gift_event_log_event ON gift_event_log (event_id);
`;

// 설정 문제(DATABASE_URL 없음 등)는 다시 시도해도 해결되지 않으므로 따로 구분합니다.
class GiftDatabaseConfigError extends Error {}

// node-postgres(pg) 결과를 공통 형식으로 맞춥니다.
function pgResult(result) {
  return { rows: result.rows, rowCount: result.rowCount ?? 0 };
}

// 운영용: Neon 등 PostgreSQL 서버에 접속합니다.
// options.searchPath: 테스트에서 별도 스키마를 쓸 때만 사용 (Neon pooler 주소에서는 지원되지 않음)
function createPgDatabase({ connectionString, searchPath, max } = {}) {
  if (!connectionString) {
    throw new GiftDatabaseConfigError('DATABASE_URL이 설정되어 있지 않습니다. (.env 또는 Render 환경변수에 Neon 연결 문자열을 넣어주세요)');
  }
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString,
    max: max || Number(process.env.GIFT_DB_POOL_MAX) || 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    options: searchPath ? `-c search_path=${searchPath}` : undefined,
  });
  // 유휴 연결이 끊겼을 때(Neon 컴퓨트 정지 등) 이 핸들러가 없으면 프로세스 전체가 종료됩니다.
  // 여기서는 로그만 남기고, 다음 쿼리 때 풀이 새 연결을 만듭니다. (TOP5 기능 보호)
  pool.on('error', (error) => {
    console.error('[gift] PostgreSQL 유휴 연결 오류 (자동 재연결):', error.message);
  });

  async function runInClient(beginSql, fn) {
    const client = await pool.connect();
    try {
      await client.query(beginSql);
      const result = await fn({ query: (sql, params) => client.query(sql, params).then(pgResult) });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    kind: 'pg',
    query: (sql, params) => pool.query(sql, params).then(pgResult),
    exec: (sql) => pool.query(sql),
    transaction: (fn) => runInClient('BEGIN', fn),
    snapshot: (fn) => runInClient('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', fn),
    close: () => pool.end(),
  };
}

// 테스트용: PGlite 인스턴스를 같은 인터페이스로 감쌉니다.
// PGlite는 연결이 1개라서 트랜잭션이 끝날 때까지 다른 쿼리가 기다립니다. (그래서 snapshot도 transaction으로 충분)
// ⚠️ 트랜잭션 안에서는 반드시 tx.query를 써야 합니다. 바깥 query를 부르면 서로 기다리다 멈춥니다.
function wrapPglite(pglite) {
  const normalize = (result) => ({ rows: result.rows, rowCount: result.affectedRows ?? 0 });
  const transaction = (fn) => pglite.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params).then(normalize) }));
  return {
    kind: 'pglite',
    query: (sql, params) => pglite.query(sql, params).then(normalize),
    exec: (sql) => pglite.exec(sql),
    transaction,
    snapshot: transaction,
    close: () => pglite.close(),
  };
}

// 환경변수(DATABASE_URL)로 운영 DB를 엽니다.
function openGiftDatabase(connectionString = process.env.DATABASE_URL) {
  return createPgDatabase({ connectionString });
}

// 테이블이 없으면 만듭니다. (CREATE ... IF NOT EXISTS라서 여러 번 실행해도 안전)
async function initSchema(database) {
  await database.exec(SCHEMA_SQL);
}

module.exports = {
  SCHEMA_SQL,
  GiftDatabaseConfigError,
  openGiftDatabase,
  createPgDatabase,
  wrapPglite,
  initSchema,
};
