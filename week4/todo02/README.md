# todo02 · PostgreSQL 에 쌓이는 투두

[todo01](../todo01/) 과 화면은 같지만 저장 위치가 다르다 — **텍스트 파일이 아니라 PostgreSQL 테이블**.
화면은 React 18 + Babel을 CDN으로 불러 쓰는 파일 하나, 서버는 `pg` 하나만 쓰는 Node 서버다.
접속 URL은 **`DATABASE_URL` 환경변수에만** 있고 브라우저로는 내려가지 않는다.

## 실행

```bash
npm install
cp .env.example .env          # DATABASE_URL=postgresql://... 채우기
node server.js                # → http://localhost:8789
```

환경변수로 직접 줘도 된다 (이쪽이 우선).

```bash
DATABASE_URL="postgresql://user:pw@host:5432/db" node server.js     # bash
$env:DATABASE_URL="postgresql://user:pw@host:5432/db"; node server.js  # PowerShell
```

| 변수 | 기본값 | 뜻 |
| --- | --- | --- |
| `DATABASE_URL` | (없음) | PostgreSQL 접속 URL. 없으면 서버는 뜨지만 저장은 막히고 화면에 안내가 나온다 |
| `PORT` | `8789` | 서버 포트 |
| `PGSSL` | 자동 | `on`/`off`. 기본은 localhost 면 끄고 원격이면 켠다 (Neon·Supabase·Render 등은 SSL 필요) |
| `PGPOOL_MAX` | `5` | 커넥션 풀 최대 개수 |

테이블은 서버가 처음 뜰 때 `CREATE TABLE IF NOT EXISTS` 로 알아서 만든다. 미리 만들어 둘 필요 없다.

## 테이블

```sql
CREATE TABLE IF NOT EXISTS todos (
  id          bigserial   PRIMARY KEY,
  text        text        NOT NULL,
  priority    text        NOT NULL DEFAULT '보통',
  done        boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  done_at     timestamptz
);
CREATE INDEX IF NOT EXISTS todos_created_idx ON todos (created_at);
```

값은 전부 `$1`, `$2` … 파라미터로 넘긴다 — 문자열을 SQL 에 이어 붙이는 곳이 한 군데도 없다.
수정할 때도 칸 이름은 코드에 적힌 것(`done` · `text` · `priority`)만 쓰이고 값만 파라미터로 들어간다.

## API

| 메서드 | 경로 | 하는 일 |
| --- | --- | --- |
| GET | `/api/health` | 연결 상태 + 호스트/DB 이름 (**비밀번호는 응답에 들어가지 않는다**) |
| GET | `/api/todos?q=검색어` | 목록 + 통계. `q` 가 있으면 `ILIKE` 로 찾는다 |
| POST | `/api/todos` | `{ text, priority }` 추가 |
| PATCH | `/api/todos/:id` | `{ done?, text?, priority? }` 수정 |
| DELETE | `/api/todos/:id` | 삭제 |
| POST | `/api/todos/clear-done` | 완료된 것 일괄 삭제 |

모든 변경은 서버를 거치고 화면은 서버가 돌려준 목록을 그대로 그린다 — 화면과 DB 가 어긋나지 않는다.

## 기능

- 추가(엔터) · 우선순위 높음 · 보통 · 낮음
- 체크로 완료 / 완료 취소 (`done_at` 도 함께 기록·해제)
- 더블클릭으로 내용 수정 (엔터 저장 · Esc 취소)
- **검색** — 입력이 멈추면 서버로 보내 `ILIKE` 로 찾는다
- 필터: 전체 / 할 일 / 완료, 완료 일괄 삭제
- 왼쪽 패널에 **DB 연결 상태**(호스트·DB 이름·저장 건수), 아래쪽에 **저장된 행 그대로 보기**(todos 테이블 표 + 실행되는 SQL)
- 연결이 안 되면 원인별 한국어 안내 — 호스트 못 찾음 / 연결 거부 / 시간 초과 / 인증 실패 / DB 없음 / 권한 없음 / SSL 인증서

## 테스트

진짜 DB 없이도 돌아간다. `pg-mem`(인메모리 PostgreSQL)에 같은 SQL 을 실행한다.

```bash
npm test          # 아래 둘 다
npm run test:db   # db.js 쿼리 22가지
npm run test:api  # server.js HTTP 왕복 23가지 (pg 자리에 pg-mem 을 끼운다)
```

`test:api` 는 라우팅·JSON·오류 처리까지 실제로 확인하고,
작은따옴표가 든 검색어(`'; DROP TABLE todos; --`)를 넣어도 그냥 문자열로 처리되는지,
`/.env` 가 `403` 으로 막히는지, 응답에 비밀번호가 섞이지 않는지도 함께 본다.

## 파일

```
todo02/
├── index.html       화면 (React, 파일 하나)
├── server.js        HTTP + 정적 서버
├── db.js            스키마와 쿼리 (query 함수를 주입받는다)
├── test-db.js       pg-mem 으로 쿼리 검증
├── test-server.js   pg-mem 으로 서버 통합 검증
├── package.json     의존성 pg (+ 개발용 pg-mem)
├── .env.example     DATABASE_URL 자리
└── .gitignore       .env / node_modules 제외
```

## 디자인

[todo01](../todo01/) 과 같은 디자인 언어 — 배경 `#f6f8fc`, 글자 `#17213c`, 네이비 패널 `#182d69`,
프라이머리 `#254bdb`, radius `14px`, DM Sans + Noto Sans KR.
