# SOOP 도전미션 별풍선 실시간 순위표

SOOP(숲) 도전미션에 후원된 별풍선을 후원자별로 합산해서, 실시간으로 갱신되는 TOP5 순위표로 보여주는 웹서비스입니다.

- SOOP 연결 없이도 **테스트 모드**로 바로 실행하고 확인할 수 있습니다.
- 후원 데이터는 SQLite 파일에 저장되어, 서버를 껐다 켜거나 브라우저를 새로고침해도 유지됩니다.
- 시청자에게 보이는 **송출 화면**과, 운영자만 쓰는 **설정 화면**이 분리되어 있어서, SOOP 인증 정보(Client Secret/Access Token)가 시청자 화면에는 절대 노출되지 않습니다.

---

## 1. 설치 방법

### 요구 사항
- **Node.js 22.5 이상** (내장 `node:sqlite` 모듈을 사용하기 때문에 이 버전 이상이 필요합니다. 별도의 SQLite 관련 네이티브 빌드 도구는 필요 없습니다.)

### 설치 순서
```bash
# 1) 이 프로젝트 폴더로 이동
cd soop-challenge-leaderboard

# 2) 패키지 설치 (express, dotenv 두 개만 설치됩니다)
npm install

# 3) 환경변수 파일 만들기 (.env.example을 복사해서 .env로 저장)
cp .env.example .env
```

`.env`에는 서버 포트(`PORT`), 화면에 보여줄 순위 수(`TOP_N`, 기본 5), SOOP Chat SDK 연동 정보(`SOOP_CLIENT_ID`/`SOOP_CLIENT_SECRET`/`SOOP_REDIRECT_URI`), 그리고 운영자 전용 화면을 보호하는 `OPERATOR_TOKEN`이 들어있습니다. SOOP 연동 정보는 **비워둔 채로 실행해도 테스트 모드로 정상 동작**하며, 실제 방송 연동 방법은 [5번 항목](#5-soop-extension-sdk-연결-위치)을 참고하세요.

`OPERATOR_TOKEN`만은 꼭 아무 값이나 채워주세요 — 설정 화면(운영자 페이지)에 접근할 때 필요한 비밀번호 역할을 합니다.

---

## 2. 실행 방법

```bash
npm start
```

정상적으로 실행되면 아래와 같은 메시지가 출력됩니다.

```
서버가 실행되었습니다: http://localhost:3000
```

브라우저에서 `http://localhost:3000`으로 접속하면, 아래 두 화면으로 가는 링크가 있는 안내 페이지가 나옵니다.

- **송출 화면** (`/broadcast.html`) — 시청자에게 보여줄 TOP5 순위표. OBS 브라우저 소스 등에 그대로 넣을 수 있도록 배경이 투명합니다.
- **설정 화면** (`/settings.html`) — 운영자 전용. SOOP 연결 상태, 테스트 후원, 순위 초기화, 설정 확인을 여기서 합니다. 처음 열면 "운영자 키"를 입력해야 하며, `.env`의 `OPERATOR_TOKEN`과 같은 값을 넣으면 됩니다.

---

## 3. 프로젝트 구조

```
soop-challenge-leaderboard/
├── server.js           # Express 서버, API 라우팅, 실시간(SSE) 브로드캐스트, 운영자 API 보호
├── database.js          # SQLite 연결, 후원 집계/초기화, 중복 이벤트 방지, SOOP 토큰 저장
├── package.json          # 패키지 정보 및 의존성
├── .env.example          # 환경변수 예시 (복사해서 .env로 사용)
├── .gitignore             # Git에 올리지 않을 파일 목록
├── README.md              # 지금 보고 있는 문서
├── data/                 # SQLite 데이터베이스 파일이 저장되는 폴더 (자동 생성됨)
│   └── leaderboard.db
└── public/                # 브라우저에 제공되는 정적 파일
    ├── index.html          # 기본 URL — 두 화면(송출/설정)으로 가는 안내 페이지
    ├── broadcast.html       # 송출 화면(PC/모바일 공통) — 시청자 공개, TOP5만 표시
    ├── settings.html        # 스트리머 설정 화면(PC/모바일 공통) — 운영자 전용
    ├── style.css             # 디자인(반응형 CSS, 1~3위 특별 디자인 포함)
    ├── app.js                 # 공통 렌더링 코드 (순위표 그리기, 실시간 갱신) — broadcast/settings 공용
    ├── soop.js                 # 연결 상태 배지 렌더링 (모드 배지 + 오류 배너)
    └── settings.js             # 설정 화면 전용 로직: SOOP OAuth 연결, 테스트 후원, 초기화
```

### 화면이 왜 3개로 나뉘어 있나요?

| 화면 | 파일 | 누가 보나요 | 인증 정보 다룸? |
|---|---|---|---|
| 기본 URL | `index.html` | 아무나(안내용) | ❌ |
| 송출 화면 | `broadcast.html` | 시청자(방송에 노출) | ❌ |
| 설정 화면 | `settings.html` | 운영자만 | ✅ (Client Secret, Access Token) |

SOOP Chat SDK는 공식 예제 기준으로 **브라우저에서 Client Secret/Access Token을 직접 사용**합니다. 이 값이 시청자가 보는 화면에 있으면 개발자 도구(F12)로 누구나 훔쳐볼 수 있으므로, 그 값을 다루는 화면을 아예 분리하고 `OPERATOR_TOKEN`으로 접근을 제한했습니다.

### 주요 API

| 메서드 | 주소 | 보호 여부 | 설명 |
|---|---|---|---|
| GET | `/api/leaderboard` | 공개 | 현재 순위표(TOP_N), 전체 별풍선 개수, 참여 인원, 연결 상태 조회 |
| GET | `/api/stream` | 공개 | 실시간 갱신을 위한 SSE(Server-Sent Events) 스트림 |
| GET | `/api/config` | 공개 | 화면에 필요한 공개 설정(Client ID, 토큰 존재 여부, TOP_N) — 비밀값 없음 |
| POST | `/api/donations` | 🔒 운영자 키 필요 | 후원 1건 등록 (`userId?`, `userNickname`, `count`, `isTest`) |
| POST | `/api/reset` | 🔒 운영자 키 필요 | 순위 전체 초기화 (새 도전미션 시작) |
| GET | `/api/operator/config` | 🔒 운영자 키 필요 | Client ID/Secret/Redirect URI 조회 (settings.html 전용) |
| GET/POST | `/api/operator/token` | 🔒 운영자 키 필요 | SOOP Access/Refresh Token 조회/저장 |
| POST | `/api/operator/status` | 🔒 운영자 키 필요 | 지금 SOOP에 연결되어 있는지 하트비트 보고 |

🔒 표시된 API는 요청 헤더에 `X-Operator-Token: <.env의 OPERATOR_TOKEN 값>`이 없으면 403으로 거부됩니다.

---

## 4. 테스트 방법

SOOP 방송에 연결하지 않고도, 내 컴퓨터에서 브라우저만으로 전체 기능을 테스트할 수 있습니다.

1. `npm start`로 서버를 실행하고 `http://localhost:3000/settings.html` 접속
2. "운영자 키" 입력창에 `.env`의 `OPERATOR_TOKEN`과 같은 값을 입력하고 저장
3. **"🧪 테스트 후원 추가"** 폼에 닉네임과 별풍선 개수를 입력하고 **추가하기** 클릭
4. 같은 페이지의 순위 미리보기, 그리고 `http://localhost:3000/broadcast.html`(다른 탭으로 열기)에 즉시 반영되는지 확인 — 같은 닉네임을 여러 번 입력하면 개수가 합산됩니다
5. **"🆕 새 도전미션 시작"** 버튼을 눌러 확인창이 뜨는지, 확인을 누르면 순위가 초기화되는지 확인
6. 서버를 껐다가(`Ctrl+C`) 다시 `npm start`로 켜서, 초기화 전에 넣었던 데이터가 남아있는지 확인 (데이터 유지 확인)
7. 같은 닉네임·개수로 테스트 후원을 아주 빠르게 두 번 연속 눌러보고, 두 번째가 무시되는지 확인 (동일 이벤트 중복 수신 방지 — 3초 이내 동일 `userId`+`count`는 자동으로 걸러집니다)

> 테스트 폼으로 추가한 후원은 `isTest: true`로 표시되어 데이터베이스에 저장되며, 실제 후원과 동일하게 순위 계산에 반영됩니다.

---

## 5. SOOP Extension SDK 연결 위치

### 5-1. 등록 화면에 입력할 값

SOOP 확장 프로그램 등록 화면(공식 문서 `?szWork=extension&sub=register` 기준)에는 아래 값을 입력하세요.

```
기본 URL                 : http://localhost:3000/        (배포 후에는 실제 도메인으로 교체)
송출 화면(PC)            : broadcast.html
스트리머 설정 화면(PC)    : settings.html
송출 화면(모바일)         : broadcast.html   (PC와 동일 파일 — 반응형이라 그대로 재사용)
스트리머 설정 화면(모바일): settings.html   (PC와 동일 파일)
```

- "기본 URL"은 절대경로(프로토콜 포함)로, 나머지 필드는 이 기본 URL 기준 상대경로(파일명)로 입력합니다.
- PC/모바일에 같은 파일명을 넣어도 된다고 문서에 나와 있으며, `style.css`에 반응형 미디어쿼리가 이미 있어 그대로 재사용할 수 있습니다.

### 5-2. 사전 준비 (API KEY 발급)
Chat SDK는 누구나 바로 쓸 수 있는 게 아니라, **사전 승인 절차**가 필요합니다.
1. SOOP Developers 사이트에서 개발자로 등록합니다.
2. Support 메뉴에서 **"제휴 제안"**을 신청합니다. (심사에 최대 10일 소요)
3. 승인되면 **"내 계정 > 내 API KEY"** 메뉴에서 `Client ID`와 `Client Secret`을 확인할 수 있습니다.

> ⚠️ 공식 문서에 명시된 현재 제약: *"현재는 본인 방송에만 접속 할 수 있습니다."* 즉, 이 SDK로는 **API KEY를 발급받은 계정 자신의 방송**에만 연결할 수 있습니다. 다른 스트리머의 방송에 연결하려면, 그 스트리머가 직접 로그인 절차(아래 5-4)를 수행해서 Access Token을 발급받아야 합니다.

### 5-3. 연결 방법
`.env`에 Client ID/Secret과 리다이렉트 주소를 채웁니다.
```
SOOP_CLIENT_ID=발급받은_클라이언트_아이디
SOOP_CLIENT_SECRET=발급받은_클라이언트_시크릿
SOOP_REDIRECT_URI=http://localhost:3000/settings.html   (SOOP API KEY 신청 시 등록한 값과 정확히 일치해야 함)
OPERATOR_TOKEN=아무_비밀값
```

### 5-4. 로그인(OAuth) 절차
1. `http://localhost:3000/settings.html`을 열고 운영자 키를 입력합니다.
2. "🔑 SOOP 로그인해서 연결하기" 버튼을 누르면 SOOP 로그인/동의 화면으로 이동합니다.
3. 로그인/동의가 끝나면 `redirect_uri`로 돌아오면서 `?code=...`가 붙습니다. `settings.js`가 이 code로 `chat.getAuth(code)`를 호출해 Access/Refresh Token을 발급받고, 서버(SQLite `soop_auth` 테이블)에 저장합니다.
4. 이후에는 서버가 재시작되어도 저장된 토큰으로 재로그인 없이 재연결을 시도합니다. (토큰이 만료되면 다시 로그인해야 할 수 있습니다 — 공식 문서에 refresh 절차가 명시되어 있지 않습니다)

### 5-5. 실제 연결 코드 (SOOP 공식 문서 예제 기준)
```js
// public/settings.js 중 실제 연결 부분
const chat = new window.SOOP.ChatSDK(config.clientId, config.clientSecret);
chat.init();
chat.setAuth(accessToken);
chat.connect();

// 채팅 이벤트는 chat.listen이 아니라 handleMessageReceived로 받습니다.
chat.handleMessageReceived((action, message) => {
  console.log('[SOOP] 이벤트 수신 action =', action, message); // 실제 수신 여부 확인용 로그
  if (action !== 'CHALLENGE_MISSION_GIFTED') return; // 도전미션 후원만 처리
  const { userId, userNickname, count } = message;
  saveDonation({ userId, userNickname, count, isTest: false });
});
```
`CHALLENGE_MISSION_GIFTED`의 `message`에는 `userId`, `userNickname`, `count` 외에 `imageUrl`, `relaysBroad` 필드도 함께 오지만, 이 서비스는 순위 계산에 필요한 3가지 값만 사용합니다.

### 5-6. 연결 확인 방법
- **콘솔 로그**: `settings.html`을 열어둔 상태에서 브라우저 개발자 도구(F12) → Console 탭에 `[SOOP] 이벤트 수신 action = ...` 로그가 찍히는지 확인
- **Network 탭**: F12 → Network → WS(WebSocket) 필터에서 `wss://`로 시작하는 항목이 뜨고 상태가 **101 Switching Protocols**인지 확인 (SOOP 공식 SDK는 접속 서버 주소를 `connect()` 호출 시 서버에서 동적으로 받아오는 구조라, 코드만 봐서는 고정 주소를 알 수 없고 실제로 연결해봐야 확인 가능합니다)
- `settings.html`에는 SDK 로드 상태, 연결 상태, 최근 수신 이벤트 로그가 화면에도 표시됩니다.

`.env`에 SOOP 연동 정보가 비어있으면(=기본 상태) 항상 **테스트 모드**로 동작하고, 로그인/연결에 성공하면 `broadcast.html`의 배지가 자동으로 **실시간 방송 모드**로 바뀝니다.

> ⚠️ **보안 주의**: Client Secret과 Access Token은 오직 `settings.html`(운영자 전용, `OPERATOR_TOKEN`으로 보호됨)에서만 다뤄집니다. 이 페이지 주소는 남에게 공유하지 마세요. 더 안전하게 만들고 싶다면 별도의 백엔드 프록시로 SOOP 토큰 교환을 옮기는 것도 고려할 수 있습니다.

---

## 6. SQLite 데이터 확인 방법

후원 데이터는 `data/leaderboard.db` 파일에 저장됩니다. 테이블은 2개입니다.

**`donation_events`** — 후원 내역 (후원 1건마다 1행)

| 컬럼 | 설명 |
|---|---|
| `user_id` | 후원자 고유 아이디 |
| `user_nickname` | 후원자 닉네임 (최신 값으로 갱신됨) |
| `star_count` | 이번 후원의 별풍선 개수 |
| `is_test` | 테스트 후원이면 1, 실제 후원이면 0 |
| `donated_at` | 후원 발생 시각 (동점 순위 판단, 중복 방지에 사용) |

**`soop_auth`** — SOOP OAuth 토큰 (항상 1행)

| 컬럼 | 설명 |
|---|---|
| `access_token` / `refresh_token` | 로그인 후 발급받은 토큰 |
| `updated_at` | 마지막으로 갱신된 시각 |

### 확인 방법 A. sqlite3 CLI 사용
```bash
sqlite3 data/leaderboard.db "SELECT * FROM donation_events ORDER BY donated_at;"
```

### 확인 방법 B. Node.js 콘솔에서 확인 (별도 설치 없이 내장 모듈 사용)
```bash
node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('./data/leaderboard.db'); console.log(db.prepare('SELECT * FROM donation_events').all());"
```

### 확인 방법 C. GUI 도구 사용
[DB Browser for SQLite](https://sqlitebrowser.org/)와 같은 무료 프로그램으로 `data/leaderboard.db` 파일을 열면, 표 형태로 편하게 데이터를 확인할 수 있습니다.

---

## 7. 배포 방법

### 방법 A. 일반 서버(VPS)에 배포
1. 서버에 Node.js 22.5 이상을 설치합니다.
2. 프로젝트 파일을 서버로 복사하고 `npm install`을 실행합니다.
3. `.env` 파일을 만들어 `PORT`, `TOP_N`, `OPERATOR_TOKEN` 등 운영 환경에 맞는 값을 설정합니다.
4. 서버가 재부팅되어도 계속 실행되도록 프로세스 매니저(예: [pm2](https://pm2.keymetrics.io/))를 사용합니다.
   ```bash
   npm install -g pm2
   pm2 start server.js --name soop-leaderboard
   pm2 save
   ```
5. 외부에서 HTTPS로 접속할 수 있도록 Nginx 등 리버스 프록시를 앞단에 두는 것을 권장합니다. (SOOP OAuth 리다이렉트도 보통 HTTPS를 요구합니다)
6. `data/` 폴더(SQLite 파일)는 서버 재배포 시에도 삭제되지 않도록 별도 디스크/볼륨에 보관하세요.

### 방법 B. Render, Railway 등 PaaS에 배포
1. 이 저장소를 GitHub에 올립니다. (`.env`, `data/*.db`는 `.gitignore`에 의해 제외됩니다)
2. 배포 서비스에서 빌드 명령은 `npm install`, 시작 명령은 `npm start`로 설정합니다.
3. 환경변수 `PORT`는 대부분의 PaaS가 자동으로 주입해주므로, 서비스에서 안내하는 값을 그대로 사용하면 됩니다. `TOP_N`, `SOOP_CLIENT_ID`, `SOOP_CLIENT_SECRET`, `SOOP_REDIRECT_URI`, `OPERATOR_TOKEN`은 서비스의 환경변수 설정 화면에 직접 입력하세요.
4. SQLite 파일이 저장되는 `data/` 폴더가 배포마다 초기화되지 않도록, **영구 디스크(Persistent Disk/Volume)** 기능을 반드시 연결하세요.
5. SOOP 확장 프로그램 등록 화면의 "기본 URL"을 이 배포 도메인(`https://...`)으로, `SOOP_REDIRECT_URI`도 `https://해당도메인/settings.html`로 함께 갱신하세요.

### 배포 전 체크리스트
- [ ] SOOP 확장 프로그램 등록 화면에 5번 항목의 값(기본 URL/송출 화면/설정 화면)을 실제 배포 도메인 기준으로 입력했는지 확인
- [ ] `.env`의 `OPERATOR_TOKEN`을 추측하기 어려운 값으로 바꿨는지 확인 (기본값 그대로 배포 금지)
- [ ] `settings.html` 주소를 시청자/외부에 공유하지 않았는지 확인
- [ ] `data/` 폴더가 영구 저장소에 연결되어 있는지 확인
- [ ] HTTPS 적용 여부 확인
