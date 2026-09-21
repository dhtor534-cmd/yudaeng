# 회원가입 · 로그인 (JWT 토큰 인증)

week5 연습 앱. 이메일·비밀번호로 가입하고 로그인하면, 서버가 **JWT 액세스 토큰**을 주고
화면은 그걸 헤더에 실어 보호된 API 를 부른다.

의존성은 `pg` 와 `pg-mem` 둘뿐이다. JWT 서명·검증과 비밀번호 해시는 Node 에 들어 있는
`node:crypto` 로 직접 짰다 (`crypto.js`). 외부 인증 패키지를 안 쓴다.

```
node server.js      →  http://localhost:8792
```

`.env` 가 없어도 그냥 뜬다 — **데모 모드**(pg-mem, 메모리)로 돈다. 가입해서 눌러볼 수는 있지만
서버를 끄면 계정이 사라진다.

---

## 토큰을 두 개 쓰는 이유

| | 액세스 토큰 | 리프레시 토큰 |
| --- | --- | --- |
| 정체 | JWT (서명된 문자열) | 그냥 랜덤 문자열 |
| 수명 | 15분 | 14일 |
| 어디에 | 브라우저 **메모리**(JS 변수) | **httpOnly 쿠키** |
| 어떻게 쓰나 | `Authorization: Bearer …` | 브라우저가 알아서 같이 보냄 |
| 검증 방법 | 서명만 확인 (DB 안 봄) | DB 에 있는지 확인 |
| 취소 | 안 됨 → 그래서 15분 | 됨 (줄을 지우면 끝) |

액세스 토큰은 빠르지만 한 번 나가면 만료 전까지 못 막는다. 그래서 짧게 준다.
짧게 주면 15분마다 다시 로그인해야 하니, 그 불편을 리프레시 토큰이 메운다 —
만료되면 화면이 `/api/auth/refresh` 를 한 번 부르고 새 액세스 토큰을 받아 온다. 사용자는 모른다.

**액세스 토큰을 localStorage 에 안 넣는 이유**: 거기 넣으면 페이지에 끼어든 아무 스크립트나 읽어 간다.
메모리에만 두면 새로고침할 때 날아가는데, 그건 httpOnly 쿠키(=JS 가 못 읽는 쿠키)로 되살린다.

**리프레시 토큰은 쓸 때마다 바꾼다(회전)**. 한 번 쓴 토큰은 그 자리에서 죽는다.
새어 나가도 오래 못 쓴다.

---

## 준비

```bash
cp .env.example .env
```

`.env` 에 두 개를 넣는다.

```
DATABASE_URL=postgresql://...        # Supabase / Neon / Render 등
JWT_SECRET=<아래 명령으로 만든 값>
```

JWT 서명 키 만들기:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

`JWT_SECRET` 이 없으면 서버가 뜰 때마다 임시 키를 새로 만들어 쓴다. 앱은 돌지만
**서버를 다시 켤 때마다 모두 로그아웃된다.** 화면 위에도 경고가 뜬다.

테이블(`auth_users`, `auth_sessions`)은 첫 요청 때 자동으로 만들어진다.

---

## API

| 메서드 | 경로 | 하는 일 |
| --- | --- | --- |
| GET | `/api/health` | DB·설정 상태 (키 자체는 안 나온다) |
| POST | `/api/auth/signup` | `{ email, password, nickname? }` → 가입 + 바로 로그인 |
| POST | `/api/auth/login` | `{ email, password }` |
| POST | `/api/auth/refresh` | 쿠키로 액세스 토큰 재발급 (+ 리프레시 토큰 회전) |
| POST | `/api/auth/logout` | 이 기기 로그아웃 |
| GET | `/api/me` | 내 정보 🔒 |
| PATCH | `/api/me` | `{ nickname }` 🔒 |
| POST | `/api/me/password` | `{ current, next }` 🔒 |
| GET | `/api/me/sessions` | 로그인된 기기 목록 🔒 |
| DELETE | `/api/me/sessions/:id` | 그 기기만 끊기 🔒 |
| POST | `/api/me/sessions/logout-all` | 전부 끊기 🔒 |

🔒 = `Authorization: Bearer <액세스 토큰>` 필요.

```bash
# 가입
curl -i -X POST localhost:8792/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"me@example.com","password":"hunter2024","nickname":"유댕"}'

# 받은 accessToken 으로 내 정보
curl localhost:8792/api/me -H "Authorization: Bearer <accessToken>"
```

---

## 이 앱이 막고 있는 것

- **비밀번호 원문은 어디에도 없다.** `scrypt` 해시 + 계정마다 다른 salt 로만 저장한다.
  비교는 `timingSafeEqual` 로 한다 (맞는 글자 수만큼 응답이 빨라지면 그것도 힌트가 된다).
- **로그인 실패 안내를 하나로 합쳤다.** "없는 계정" 과 "비밀번호 틀림" 을 구분해 주면
  가입된 이메일 목록을 캐내는 데 쓰인다. 계정이 없을 때도 해시를 한 번 돌려서 응답 속도까지 맞춘다.
- **JWT 의 `alg` 를 고정했다.** 토큰이 스스로 `alg:"none"` 이라고 주장해도 거절한다.
- **리프레시 토큰은 DB 에 해시로만 있다.** DB 가 통째로 새어도 그걸로 로그인할 수 없다.
- **비밀번호를 바꾸면 다른 기기가 끊긴다.** 바뀐 줄 모르는 기기가 남으면 안 된다.
- **로그인 시도 제한** — 같은 이메일/IP 로 8번 틀리면 10분 막는다.
- **서버 파일은 브라우저로 안 나간다.** `index.html` 말고는 아무것도 안 내준다.

### 연습 앱이라 덜 된 것

- 시도 제한이 **메모리에만** 있다. 서버가 새로 뜨면 초기화되고, Vercel 처럼 인스턴스가 여러 개면
  각자 따로 센다. 진짜로 하려면 DB 나 Redis 로 옮겨야 한다.
- 이메일 인증, 비밀번호 찾기, 소셜 로그인은 없다.
- 관리자/권한 구분이 없다. 모든 계정이 자기 것만 본다.

---

## 테스트

```bash
npm test          # 아래 셋을 순서대로
node test-crypto.js   # 비밀번호 해시 · JWT 서명/검증 (위조·만료·alg:none 거절까지)
node test-db.js       # 스키마와 쿼리 (pg-mem 위에서)
node test-api.js      # 진짜 HTTP 요청 — 쿠키·토큰 회전·세션까지
```

DB 없이 돈다. `test-api.js` 는 `pg` 자리에 `pg-mem` 을 끼우고 서버를 실제로 띄운다.

---

## 배포 (Vercel)

`vercel.json` 이 `/api/*` 를 `api/index.js` 로, 나머지를 `index.html` 로 보낸다.
프로젝트 설정에 환경변수 **`DATABASE_URL`** 과 **`JWT_SECRET`** 을 넣어야 한다.
`JWT_SECRET` 을 빼먹으면 서버리스 인스턴스마다 다른 임시 키를 쓰게 되어 로그인이 계속 풀린다.

---

## 라이브러리로 바꾸기

`jsonwebtoken` · `bcrypt` 를 쓰고 싶으면 `crypto.js` 안의 함수 네 개만 갈아끼우면 된다.
나머지 파일은 손댈 필요가 없다.

```js
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");   // bcrypt 는 네이티브 빌드라 Windows·Vercel 에서 자주 막힌다

const hashPassword   = (pw) => bcrypt.hash(pw, 12);
const verifyPassword = (pw, stored) => bcrypt.compare(pw, stored).catch(() => false);
const signJwt   = (payload, secret, ttlSec) => jwt.sign(payload, secret, { expiresIn: ttlSec });
const verifyJwt = (token, secret) => { try { return jwt.verify(token, secret, { algorithms: ["HS256"] }); } catch { return null; } };
```

---

## 파일

```
crypto.js      비밀번호 해시(scrypt) · JWT 서명/검증 · 리프레시 토큰
db.js          스키마 + 쿼리 (query/tx 를 주입받아 pg / pg-mem 양쪽에서 동작)
handler.js     라우팅 · 쿠키 · 토큰 발급 · 시도 제한  ← 본체
server.js      로컬 서버 (포트 열기)
api/index.js   Vercel 서버리스 진입점 (같은 handler.js 를 쓴다)
index.html     화면 한 장 (React UMD + Babel)
test-*.js      테스트 셋
```
