# 하루한끼 캣푸드 — 상품페이지 + 문의 폼

고양이 사료 상품 상세페이지 한 장과, 거기 붙은 문의하기 폼.
화면은 React 18 + Babel을 CDN으로 불러 쓰는 **파일 하나**(빌드 없음),
문의는 **PostgreSQL** 에 저장한다. 상품 이미지는 파일 없이 **SVG로 직접 그린다**.

로컬에서는 `server.js` 가, Vercel에서는 `api/*.js` 서버리스 함수가 같은 핸들러(`api/_lib.js`)를 부른다.

## 실행

```bash
npm install
cp .env.example .env          # DATABASE_URL, ADMIN_TOKEN 채우기
node server.js                # → http://localhost:8790
```

| 변수 | 기본값 | 뜻 |
| --- | --- | --- |
| `DATABASE_URL` | (없음) | PostgreSQL 접속 URL. 없으면 페이지는 보이지만 문의 저장은 막히고 폼에 안내가 뜬다 |
| `ADMIN_TOKEN` | (없음) | 문의 목록 조회용 토큰. 없으면 `GET /api/inquiries` 는 잠긴다 |
| `PORT` | `8790` | 로컬 서버 포트 |
| `PGSSL` | 자동 | `on`/`off`. 기본은 localhost 면 끄고 원격이면 켠다 |
| `RATE_LIMIT` | `5` | 같은 IP 의 10분당 문의 건수 |

테이블은 첫 요청 때 `CREATE TABLE IF NOT EXISTS` 로 알아서 만든다.

## 페이지 구성

- **히어로** — SVG 사료 봉투(맛에 따라 색이 바뀜), 맛 3종 · 용량 3종 · 수량 선택, 실시간 총액, 배송/교환 안내
- **특징 4가지** — 그레인프리 · 휴먼그레이드 · 헤어볼 케어 · 국내 HACCP
- **성분표 / 하루 급여량 표**
- **후기 3건**
- **문의하기 폼** — 이름 · 이메일 · 연락처 · 문의 유형 · 내용 · 개인정보 동의
  - 지금 보고 있는 옵션(예: `연어 / 3kg`)이 문의에 자동으로 함께 저장된다
  - 접수되면 **접수번호**(`2026-0917-0007`)를 보여준다
  - 옆에 **최근 문의**가 뜨지만 이름·이메일은 가려서(`홍**`, `ho**@example.com`) 보여주고 본문은 공개하지 않는다

## 테이블

```sql
CREATE TABLE IF NOT EXISTS inquiries (
  id          bigserial   PRIMARY KEY,
  name        text        NOT NULL,
  email       text        NOT NULL,
  phone       text,
  topic       text        NOT NULL DEFAULT '상품 문의',
  option_name text,
  message     text        NOT NULL,
  agreed      boolean     NOT NULL DEFAULT false,
  status      text        NOT NULL DEFAULT '접수',
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

값은 전부 `$1`, `$2` … 파라미터로 넘긴다.

## API

| 메서드 | 경로 | 하는 일 |
| --- | --- | --- |
| GET | `/api/health` | DB 연결 상태 · 누적 문의 수 · 문의 유형 목록 |
| POST | `/api/inquiries` | 문의 접수 → `{ ticket, created, topic }` |
| GET | `/api/inquiries?recent=1` | 최근 5건 (이름·이메일 마스킹, 본문 없음) |
| GET | `/api/inquiries` | 전체 목록 — 헤더 `x-admin-token` 필요 |

입력은 서버에서 다시 검증한다 — 이메일 형식, 연락처 문자, 5자 미만 내용, 동의 여부.
틀리면 `400` 과 함께 `{ errors: { email: "...", message: "..." } }` 를 돌려주고 폼이 칸별로 표시한다.
같은 IP 에서 10분에 `RATE_LIMIT` 건을 넘기면 `429`.

## 테스트

진짜 DB 없이 `pg-mem`(인메모리 PostgreSQL)으로 돌린다.

```bash
npm test          # 아래 둘 다
npm run test:db   # db.js 28가지 (검증 규칙 · 마스킹 · 통계)
npm run test:api  # HTTP 왕복 21가지 (pg 자리에 pg-mem 을 끼운다)
```

`test:api` 는 접수·검증오류·관리자 토큰·레이트리밋·`.env` 차단까지 확인하고,
응답에 이메일 본문이나 DB 비밀번호가 섞여 나가지 않는지도 함께 본다.

## Vercel 배포

```bash
vercel login                     # 브라우저 인증 (직접 실행해야 함)
vercel env add DATABASE_URL      # production/preview 에 값 입력
vercel env add ADMIN_TOKEN
vercel --prod                    # 이 폴더에서 실행
```

- 정적 파일(`index.html`)은 그대로 서빙되고 `api/health.js` · `api/inquiries.js` 가 함수로 붙는다.
- Supabase 를 쓸 때는 **6543 트랜잭션 풀러** URL을 쓸 것 (서버리스는 커넥션이 자주 생겼다 사라진다).
- 레이트리밋은 인스턴스 메모리 기준이라 서버리스에서는 느슨하게 동작한다.

## 파일

```
catfood/
├── index.html        상품페이지 + 문의 폼 (React, 파일 하나)
├── api/
│   ├── _lib.js       요청 처리 본체 (로컬·Vercel 공용)
│   ├── health.js     GET /api/health
│   └── inquiries.js  GET/POST /api/inquiries
├── db.js             스키마 · 쿼리 · 입력 검증 · 마스킹
├── server.js         로컬 개발 서버
├── test-db.js, test-server.js
├── vercel.json
├── package.json
├── .env.example
└── .gitignore
```
