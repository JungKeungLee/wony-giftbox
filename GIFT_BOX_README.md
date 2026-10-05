# 🎁 선물상자 이벤트 시스템

별풍선·도전미션·대결미션 후원 개수를 하나의 게이지에 모읍니다. 목표를 달성하면 선물상자가 열리고, 해당 회차 후원자 가운데 응모권을 가진 사람을 대상으로 룰렛을 돌려 당첨자를 정합니다.

- **관리자 화면**: `/admin` (운영자 키로 로그인). 루트 주소 `/`로 접속해도 `/admin`으로 이동합니다(302).
- **OBS 오버레이**: `/overlay` (배경 투명, 조회 전용)
- **DB**: PostgreSQL (운영: Neon / 테스트: PGlite)
- 기존 기능인 도전미션 TOP5(`/broadcast.html`, `/api/mission`)는 그대로 동작합니다. 선물상자 DB에 장애가 나도 TOP5는 영향을 받지 않습니다.

---

## 1. 핵심 규칙

| 규칙 | 내용 |
|---|---|
| 인정 후원 | `STAR`(별풍선), `CHALLENGE`(도전미션), `BATTLE`(대결미션). 종류에 관계없이 개수를 합산합니다. **현재 운영은 일반 별풍선(STAR)만 사용**하므로 관리자 테스트 후원/수동 등록 화면에서는 STAR만 선택할 수 있습니다. (DB와 서버는 세 타입을 계속 지원) |
| 게이지 | 수집 중(ACTIVE)에 들어온 후원은 100개 미만이라도 **전부** 게이지에 더합니다. |
| 응모권 | 후원자별 회차 누적 합계 기준으로 `floor(총 후원 / 100)`장입니다. 99개 → 0장, 100개 → 1장, 550개 → 5장. 남은 개수도 계속 누적됩니다. |
| 후원자 구분 | `donorId`가 있으면 donorId 기준, 없으면 닉네임 기준으로 합산합니다. |
| 목표 달성 | 목표 이상이 되는 즉시 `BOX_OPENING`으로 바뀌고 수집이 끝납니다. 게이지는 목표값(100%)에서 멈춥니다. 초과분은 다음 회차로 **이월하지 않습니다**. |
| 추첨 | 응모권 수를 가중치로 한 누적 가중치 추첨입니다(`crypto.randomInt`). 이름을 응모권 수만큼 복제하지 않습니다. |
| **중복 당첨 불가 (고정 규칙)** | 같은 회차에서 한 번 당첨된 사람은 다음 추첨 대상에서 제외됩니다. 설정으로 바꿀 수 없습니다. 서비스 로직에서 한 번, DB 제약 `UNIQUE (event_id, donor_key)`에서 한 번 더 막습니다. 당첨자의 후원·응모 기록은 그대로 남습니다. |
| 다음 회차 | "다음 선물상자 시작"을 누르면 `0 / 목표`부터 새로 시작합니다. 이전 회차는 DB에 그대로 보존됩니다. |

### 상태 전환 (서버가 DB에 저장해 관리)

```
READY ──시작──▶ ACTIVE ──목표 달성/강제 오픈──▶ BOX_OPENING ──(연출 11초 후 자동)/룰렛 강제 실행──▶ ROULETTE
  ▲              │                                   │                                              │ 다음 추첨 × N
  └──이벤트 종료──┘                     후원 취소로 목표 미만이 되면 ACTIVE로 복귀                          ▼
                                                                                                    RESULT
새 회차 READY ◀── 다음 선물상자 시작 ── (현재 회차는 FINISHED/COMPLETED로 보존) ◀──────────────────────────┘
회차 초기화: 어떤 상태에서든 현재 회차를 FINISHED/RESET으로 보존하고 새 회차를 READY로 만듭니다.
```

`READY`·`BOX_OPENING`·`ROULETTE`·`RESULT` 상태에서 들어온 후원은 `IGNORED`로 **기록만** 남습니다. 게이지와 응모권에는 들어가지 않습니다.

---

## 2. 파일 구성

| 파일 | 역할 |
|---|---|
| `gift/index.js` | Express 라우트 등록과 DB 초기화를 맡습니다. 초기화는 백그라운드에서 하고, 실패하면 자동으로 다시 시도합니다(실패 격리). |
| `gift/database.js` | PostgreSQL 연결(`pg` Pool), 테이블 생성 SQL, 트랜잭션 도우미, 테스트용 PGlite 어댑터 |
| `gift/tickets.js` | 응모권 계산, 후원자 합산, 누적 가중치 추첨 (순수 함수) |
| `gift/giftEventService.js` | 상태 머신, 후원 반영, 목표 달성, 추첨, 회차 관리, 기록 조회 (async) |
| `gift/donationService.js` | 후원 입력 검증과 표준 형식 변환. 모든 후원이 이곳 하나를 거쳐 들어옵니다. |
| `gift/providers/` | 외부 방송 플랫폼 어댑터 인터페이스 (아직 구현체 없음) |
| `gift/realtime.js` | SSE 실시간 전송 |
| `gift/auth.js` | 관리자 인증 (OPERATOR_TOKEN → HttpOnly 쿠키, 로그인 시도 제한) |
| `gift/overlay/*` | OBS 오버레이 (게이지 → 오픈 연출 → 룰렛 → 결과) |
| `gift/admin/*` | 관리자 화면과 로그인 화면 |
| `test/gift.test.js` | 테스트 41개 (PGlite 또는 실제 PostgreSQL) |

기존 파일 변경은 최소한으로 했습니다: `server.js`(trust proxy 설정, mountGiftBox 1줄, 로그 1줄), `package.json`(`pg`, 테스트 스크립트, devDependency `@electric-sql/pglite`), `.env.example`, `README.md`(링크 1줄).

---

## 3. DB (PostgreSQL)

서버가 시작할 때 테이블이 없으면 자동으로 만듭니다(`CREATE ... IF NOT EXISTS`). 그래서 Neon에서 SQL을 미리 실행하지 않아도 됩니다. 아래는 `gift/database.js`의 SQL과 같습니다.

```sql
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
CREATE UNIQUE INDEX IF NOT EXISTS ux_gift_event_single_open
  ON gift_event ((status <> 'FINISHED')) WHERE status <> 'FINISHED';

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

CREATE TABLE IF NOT EXISTS gift_prize (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id    INTEGER      NOT NULL REFERENCES gift_event(id),
  prize_order INTEGER      NOT NULL,
  prize_name  VARCHAR(100) NOT NULL,
  quantity    INTEGER      NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  created_at  TIMESTAMPTZ  NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_gift_prize_event ON gift_prize (event_id, prize_order);

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

CREATE TABLE IF NOT EXISTS gift_event_log (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id   INTEGER     NOT NULL REFERENCES gift_event(id),
  action     VARCHAR(50) NOT NULL,
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_gift_event_log_event ON gift_event_log (event_id);
```

### 요구 명세 외에 추가한 컬럼·테이블과 이유
| 항목 | 이유 |
|---|---|
| `gift_event.status_changed_at` | 오픈 연출과 룰렛 연출을 **서버 시각 기준**으로 이어 가기 위해 필요합니다(OBS 새로고침, 서버 재시작 대응). 재시작 후 BOX_OPENING → ROULETTE 자동 전환 타이머도 이 값으로 다시 맞춥니다. |
| `gift_event.goal_reached_at`, `end_reason` | 회차 기록에 목표 달성 시각과 종료 사유(정상 완료 `COMPLETED` / 초기화 `RESET`)를 남깁니다. |
| `gift_donation.donor_key` | 집계 기준 키입니다(`id:<donorId>` 또는 `nick:<닉네임>`). 중복 당첨 판정에도 씁니다. |
| `gift_donation.status` / `ignored_reason` / `canceled_at` | 취소된 후원이나 수집 시간 외 후원도 **삭제하지 않고** 기록으로 남기고, 집계에서만 뺍니다. |
| `gift_donation.source` + `external_event_id` (UNIQUE) | 외부 플랫폼 이벤트 ID로 **중복 수신을 막습니다**. |
| `gift_donation.donated_at` | 플랫폼이 알려준 실제 후원 시각입니다(`created_at`은 서버가 받은 시각). |
| `gift_winner.slot_no` + `UNIQUE (event_id, slot_no)` | 같은 상품을 여러 개 추첨할 때 몇 번째 칸인지 기록합니다. 같은 칸이 두 번 추첨되지 않게 합니다. |
| `gift_winner.donor_key` + `UNIQUE (event_id, donor_key)` | **중복 당첨 불가 규칙을 DB에서 한 번 더 보장합니다.** |
| `gift_winner.total_tickets` | 당첨 당시 전체 응모권 수입니다. 당첨 확률을 기록으로 증명할 수 있습니다. |
| `gift_event_log` (JSONB) | 게이지 수동 수정, 강제 오픈, 후원 취소 같은 조작과 추첨 난수(roll)를 남기는 감사 로그입니다. |
| 제거: `duplicate_winner_yn` | 중복 당첨 불가가 고정 규칙이 되어 필요 없어졌습니다. |

- PK는 모두 `INTEGER GENERATED ALWAYS AS IDENTITY`라서 node-postgres에서 **숫자로** 받습니다. `COUNT`/`SUM` 결과는 bigint라 SQL에서 `::int`로 바꿔 숫자로 응답합니다.
- 날짜는 `TIMESTAMPTZ`로 저장하고, API에서는 지금처럼 ISO 문자열로 응답합니다.

### 동시성 / 무결성
- 데이터를 바꾸는 모든 작업은 트랜잭션 안에서 **진행 중 회차 행을 `SELECT ... FOR UPDATE`로 잠근 뒤** 처리합니다. 후원이 동시에 몰려도 한 줄로 서서 처리되므로 게이지 합산과 상태 전환이 꼬이지 않습니다.
- 게이지 증가는 `current_amount = current_amount + $1` 원자적 UPDATE로 처리합니다. 상태 전환은 `WHERE status = '현재'` 조건부 UPDATE입니다.
- 진행 중 회차 1개, 외부 이벤트 ID 유일, 추첨 칸 유일, 회차당 1인 1회 당첨을 **DB 제약**으로 한 번 더 보장합니다.
- 화면용 상태 조회는 읽기 전용 스냅샷 트랜잭션(REPEATABLE READ)으로 묶습니다. 그래서 게이지와 참여자 수가 서로 다른 시점의 값으로 섞이지 않습니다.

---

## 4. 로컬 실행

요구 사항: Node.js 18 이상 (권장 22)

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
```

`.env`에 다음 두 값을 넣습니다.
```
DATABASE_URL=postgresql://...      # Neon 연결 문자열 (아래 5번). 로컬 PostgreSQL도 가능
OPERATOR_TOKEN=길고-추측하기-어려운-값
```
로컬 개발에는 Neon에서 **개발용 브랜치**(Branches → Create branch)를 만들어 그 연결 문자열을 쓰는 것을 권장합니다. 운영 데이터와 분리됩니다.

```bash
npm start
# 서버가 실행되었습니다: http://localhost:3000
# 선물상자 관리자: http://localhost:3000/admin  /  OBS 오버레이: http://localhost:3000/overlay
# [gift] 선물상자 DB(PostgreSQL) 준비 완료
```

`DATABASE_URL`이 비어 있거나 DB에 연결할 수 없으면, 선물상자 API만 503("DB에 연결할 수 없습니다")을 돌려줍니다. TOP5는 정상 동작합니다. 연결 실패는 5초, 10초, … 최대 60초 간격으로 자동 재시도하므로 DB가 살아나면 서버를 재시작하지 않아도 복구됩니다.

---

## 5. Neon 설정 (DATABASE_URL)

1. https://neon.tech 에서 프로젝트를 만듭니다. **Region은 Render 서버와 같은 지역**을 고르세요(예: 둘 다 Singapore / AWS ap-southeast-1). 지역이 다르면 요청마다 지연이 생깁니다.
2. 프로젝트 대시보드에서 **Connect**를 누르고, **Connection pooling을 켠** 연결 문자열을 복사합니다. 호스트에 `-pooler`가 들어간 주소입니다.
   ```
   postgresql://<user>:<password>@ep-xxxx-pooler.<region>.aws.neon.tech/neondb?sslmode=require
   ```
3. 이 값을 Render 환경변수 `DATABASE_URL`에 넣습니다. 비밀번호가 들어 있으므로 저장소나 채팅에 올리지 마세요.
4. 테이블은 첫 서버 실행 때 자동으로 만들어집니다. Neon **SQL Editor**에서 `SELECT * FROM gift_event;`로 확인할 수 있습니다.

참고
- Neon 무료 플랜은 일정 시간 요청이 없으면 컴퓨트가 정지됩니다. 정지 후 첫 요청은 수백 ms~수 초 느릴 수 있습니다. 방송 시작 전에 `/admin`을 한 번 열어 두면 됩니다.
- 백업과 복원(특정 시점 복원) 보관 기간은 요금제마다 다릅니다. 중요한 회차 기록은 Neon 대시보드에서 보관 기간을 확인하세요.

---

## 6. Render 배포

1. Render → **New → Web Service** → GitHub 저장소를 연결하고 브랜치를 고릅니다.
2. 설정

| 항목 | 값 |
|---|---|
| Runtime | Node |
| Region | Neon과 같은 지역 (예: Singapore) |
| **Build Command** | `npm ci --omit=dev` |
| **Start Command** | `npm start` |
| Health Check Path (선택) | `/broadcast.html` (DB 상태와 무관한 경로라서 DB 일시 장애로 서버가 재시작되지 않습니다) |
| Instance 수 | **1개** (아래 주의 참고) |

3. **환경변수 (Environment)**

| 키 | 필수 | 값 |
|---|---|---|
| `DATABASE_URL` | ✅ | Neon pooled 연결 문자열 |
| `OPERATOR_TOKEN` | ✅ | 관리자 로그인 키 (길고 무작위인 값) |
| `NODE_VERSION` | 권장 | `22` |
| `GIFT_BOX_OPEN_MS` / `GIFT_SPIN_MS` / `GIFT_WINNER_HOLD_MS` | 선택 | 연출 시간 (기본 11000 / 6500 / 4000) |
| `GIFT_MAX_DONATION_AMOUNT` | 선택 | 후원 1건 최대 개수 (기본 1000000) |
| `GIFT_DB_POOL_MAX` | 선택 | DB 연결 풀 크기 (기본 5) |
| `CACHE_TTL_MS` | 선택 | 기존 TOP5 캐시 시간 (기본 30000) |

`PORT`와 `RENDER`는 Render가 자동으로 넣습니다. `RENDER`가 있으면 `trust proxy`가 켜져서 실제 접속자 IP(로그인 시도 제한)와 HTTPS 보안 쿠키가 올바르게 동작합니다. `TRUST_PROXY`는 Render에서는 설정하지 않아도 됩니다.

4. 배포가 끝나면 `https://<서비스이름>.onrender.com/admin`에 접속해 로그인합니다.

**주의**
- **인스턴스는 1개로 유지하세요.** 실시간 전송(SSE)이 서버 메모리 안에서 동작하므로, 인스턴스가 여러 개면 한 서버에서 일어난 후원이 다른 서버에 연결된 OBS에 전달되지 않습니다.
- Render 무료 플랜은 요청이 없으면 잠듭니다. 깨어날 때 수십 초가 걸리므로 실제 방송용으로는 유료 인스턴스를 권장합니다. 잠들거나 재배포돼도 데이터는 Neon에 있으므로 회차는 유지되고, OBS 오버레이는 자동으로 다시 연결됩니다.
- Render의 디스크는 배포할 때마다 초기화되므로 선물상자 데이터는 디스크에 저장하지 않습니다(전부 Neon).

---

## 7. OBS 설정

1. OBS → 소스 `+` → **브라우저**를 추가합니다.
2. URL: `https://<서비스이름>.onrender.com/overlay` (로컬에서는 `http://localhost:3000/overlay`)
3. 너비 **1920**, 높이 **1080**으로 설정하고 방송 캔버스 전체를 덮게 배치합니다. 배경은 이미 투명합니다.
4. "보이지 않을 때 소스 종료"는 **끄기**를 권장합니다. 켜 둬도 다시 연결되면 현재 상태로 복구됩니다.
5. 게이지 위치는 `/overlay?pos=bl`로 정합니다(기본값: 왼쪽 아래). 선택지는 `tl` `tc` `tr` `bl` `bc` `br`입니다. 오픈 연출, 룰렛, 결과는 항상 화면 가운데에 표시됩니다.

오버레이는 조회 API(`/api/gift/state`, `/api/gift/stream`)만 사용합니다. 주소가 노출돼도 후원 등록, 초기화, 룰렛 실행은 불가능합니다.

---

## 8. 관리자 사용 방법 (`/admin`)

1. `OPERATOR_TOKEN`으로 로그인합니다. 로그인은 30일 유지되고, 토큰을 바꾸면 기존 로그인은 모두 해제됩니다.
2. **이벤트 설정**에서 목표 개수를 저장합니다.
3. **상품 설정**에서 위에서부터 1등, 2등… 순서로 입력합니다. 수량이 2 이상이면 같은 상품으로 여러 명을 뽑습니다. 입력 후 **상품 저장**을 누릅니다.
4. **▶ 이벤트 시작**을 누르면 후원 수집이 시작됩니다.
5. 목표를 달성하면 오픈 연출이 자동으로 나오고, 약 11초 뒤 룰렛 화면으로 넘어갑니다.
6. **🎡 다음 추첨**을 누를 때마다 1명을 뽑습니다. 이미 당첨된 사람은 자동으로 제외되고, 연출이 끝날 때까지 버튼이 잠깁니다.
7. 결과 화면을 확인한 뒤 **🎁 다음 선물상자 시작**을 누릅니다. 0부터 시작하는 새 회차가 READY로 준비되고, 목표와 상품 설정은 이어받습니다. 이어서 다시 **이벤트 시작**을 누르세요.

그 밖의 기능
- **이벤트 종료**: 수집 중지입니다. 데이터는 유지됩니다.
- **테스트 후원**과 **랜덤 5건**
- **후원 수동 등록**: 후원자 ID를 입력할 수 있습니다.
- **후원 취소**: 기록은 남고 집계에서만 빠집니다.
- **게이지 수정**, **상자 강제 오픈**, **룰렛 강제 실행**
- **회차 초기화**: "초기화"를 직접 입력해야 실행됩니다.
- **회차 기록 상세**: 목표, 총 후원, 참여자, 후원 내역, 응모권, 당첨자, 상품, 시각, 조작 로그를 봅니다.
- **오버레이 미리보기**

---

## 9. 테스트

```bash
npm test                                   # PGlite (메모리 PostgreSQL) — 별도 DB 필요 없음
TEST_DATABASE_URL=postgresql://... npm test  # 실제 PostgreSQL 서버 (임시 스키마를 만든 뒤 테스트 후 삭제)
```
`TEST_DATABASE_URL`에는 Neon의 **direct 주소**(`-pooler`가 없는 주소)나 테스트용 브랜치를 쓰세요. pooler 주소는 스키마 지정 옵션을 지원하지 않습니다.

테스트 41개
- 요구사항 1~12번: 응모권 99/100/50+50/50+30+19/50+30+20/250+150/종류 합산, 목표 달성 시 BOX_OPENING, A5·B3·C2 가중치(구간 선택과 20만 회 분포), 중복 당첨 불가로 A 제외, 다음 회차 0부터 시작, 이전 기록 보존
- 10-1: DB 제약. 같은 회차에서 같은 donor_key의 두 번째 당첨 INSERT를 23505로 거절하는지 확인
- 예외 처리: 목표·후원 0/음수/소수, 닉네임 없음, 잘못된 종류, eventId 중복, 목표 달성 후 후원 IGNORED, 응모자 0명, 응모자 < 당첨 인원, 추첨 쿨다운, 잘못된 상태 전환, 서버 재시작, donorId 비노출
- PostgreSQL: ID와 집계 값이 숫자 타입인지, 날짜가 ISO 문자열인지 확인
- 동시성(`Promise.all`): 후원 200건 동시 처리, 목표 근처 동시 후원 시 목표 달성 1회, 같은 eventId 10건 동시 → 1건만 집계, 추첨 동시 클릭 시 칸·당첨자 중복 없음, 다음 회차 연타 시 1개만 생성
- 장애 격리: DB 연결 실패 중에는 선물상자만 503이고 TOP5 라우트와 오버레이 화면은 200인지, DB가 살아나면 자동 복구되는지 확인

---

## 10. API / 실시간 이벤트

| 구분 | 메서드 · 경로 | 설명 |
|---|---|---|
| 공개 | `GET /api/gift/state` | 현재 회차 공개 상태 |
| 공개 | `GET /api/gift/stream` | SSE. 접속하면 바로 `STATE_SYNC`를 받습니다. |
| 관리자 | `POST /api/gift/admin/login` · `logout` | 로그인(쿠키) / 로그아웃 |
| 관리자 | `GET /api/gift/admin/state` | 관리자 상태 |
| 관리자 | `PUT /api/gift/admin/settings` | `{ targetAmount }` |
| 관리자 | `PUT /api/gift/admin/prizes` | `{ prizes: [{ name, quantity }] }` (배열 순서 = 등수) |
| 관리자 | `POST /api/gift/admin/start` · `stop` | 시작 / 수집 중지 |
| 관리자 | `POST /api/gift/admin/donations` | `{ nickname, donorId?, type, amount, eventId?, timestamp?, test?, source? }` → 결과는 `COUNTED`/`IGNORED`/`DUPLICATE` |
| 관리자 | `POST /api/gift/admin/donations/:id/cancel` | 후원 취소 |
| 관리자 | `PUT /api/gift/admin/amount` | `{ currentAmount }` |
| 관리자 | `POST /api/gift/admin/force-open` · `force-roulette` · `draw` · `next-round` · `reset-round` | |
| 관리자 | `GET /api/gift/admin/rounds` · `rounds/:id` | 회차 기록 |

관리자 API는 브라우저에서는 로그인 쿠키로, 외부 연동에서는 `X-Operator-Token` 헤더로 호출합니다. DB가 준비되지 않았으면 `503 { code: "DB_NOT_READY" }`를 돌려줍니다.

SSE `type` 목록: `STATE_SYNC`, `DONATION_RECEIVED`, `DONATION_CANCELED`, `PROGRESS_UPDATED`, `GOAL_REACHED`, `BOX_OPEN`, `ROULETTE_STARTED`, `WINNER_SELECTED`, `RESULT_READY`, `ROUND_FINISHED`, `SETTINGS_UPDATED`

---

## 11. 예외 처리 정리

| 상황 | 처리 |
|---|---|
| 목표·후원이 0, 음수, 소수 / 닉네임 없음 | 400 거절 (닉네임이 없어도 donorId가 있으면 donorId로 표시) |
| 중복 후원 이벤트 | 같은 `(source, eventId)`면 `DUPLICATE`로 처리. 동시에 들어와도 1건만 집계 |
| 응모자 0명에서 목표 달성 | 룰렛에 들어가자마자 RESULT로 넘어가고 "당첨자가 없습니다"를 표시 |
| 응모자 < 당첨 인원 | 가능한 만큼만 뽑고 RESULT. 남은 칸은 "당첨자 없음" |
| 룰렛 도중 / 목표 달성 후 후원 | `IGNORED`로 기록만 남기고 이월하지 않음 |
| 추첨 동시 클릭 | 행 잠금으로 순서대로 처리하고, 칸·당첨자 중복은 DB 제약으로 거절 |
| 관리자 / OBS 새로고침 | 서버 상태와 서버 시각을 기준으로 현재 장면을 복구 |
| 서버 재시작 · 재배포 | 상태는 Neon에 있으므로 유지. BOX_OPENING이었다면 남은 연출 시간 뒤 룰렛으로 전환 |
| DB 연결 실패 · Neon 일시 장애 | 선물상자 API만 503으로 응답하고 자동 재시도. TOP5와 서버 프로세스는 영향 없음 |

---

## 12. 미구현 사항 / 한계

- **외부 방송 플랫폼 실시간 연동**: API가 확정되지 않아 `DonationProvider` 인터페이스만 준비했습니다. 지금은 관리자 테스트 후원과 수동 등록으로 운영합니다.
- 기존 bcraping.kr 조회는 미션별 **합계**만 주므로 선물상자 후원 소스로 연결하지 않았습니다.
- 관리자 계정은 `OPERATOR_TOKEN` 1개를 공유합니다.
- 효과음과 BGM은 없습니다(OBS 미디어 소스로 추가).
- 실시간 전송이 서버 메모리 기반이라 **인스턴스 1개** 전제입니다. 여러 대로 늘리려면 Redis Pub/Sub 같은 별도 채널이 필요합니다.
- 응모자가 많으면 룰렛 칸이 좁아져 이름이 생략됩니다(왼쪽 목록에 상위 12명과 확률 표시).
- 기존 SQLite 버전 데이터는 이관하지 않습니다(운영 배포 전이라 필요 없음).

---

## 13. 외부 방송 플랫폼 연동 시 필요한 정보

1. 연결 방식(WebSocket / SDK / Webhook / 폴링)과 인증 방식(OAuth, 토큰 갱신)
2. 별풍선 / 도전미션 / 대결미션 후원 이벤트의 구분 방법
3. 이벤트 필드: 후원자 **고유 ID**, 닉네임, 후원 **개수**, 후원 시각, **이벤트 고유 ID** 유무
4. 미션 실패·취소 시 환불 이벤트가 오는지 여부 (지금은 관리자 "후원 취소"로 처리)
5. 재연결할 때 이벤트를 다시 보내는지 여부 (중복 방지와 연관)
6. 호출 제한과 이용 약관상 허용 범위

`gift/providers/DonationProvider.js`를 상속해 `toDonation(raw)`만 구현하면, 나머지 처리(검증 → 중복 방지 → 게이지 → 응모권 → 실시간 전송)는 지금 로직을 그대로 탑니다. 별도 브리지 프로그램에서 보낼 경우 `POST /api/gift/admin/donations`에 `X-Operator-Token` 헤더와 `{ donorId, nickname, type, amount, timestamp, eventId, source: "SOOP" }`를 담아 보내면 됩니다.
