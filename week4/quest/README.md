# 냉장고 재료 & 레시피 🧊

집에 있는 재료를 등록하면 **지금 바로 만들 수 있는 요리**를 매칭률 순으로 알려주는 앱.
화면은 빌드 없이 `index.html` 하나에 React 18 + Babel standalone(CDN),
저장은 Node 표준 모듈 + `pg` 로 만든 서버가 **PostgreSQL(Supabase)** 에 한다.
있는 재료로 **AI(OpenAI)가 새 레시피를 만들어 주는** 기능이 붙어 있다.

## 실행

```bash
cd week4/quest
npm install
node server.js        # → http://localhost:8791
```

> `index.html` 을 더블클릭해서 `file://` 로 열면 서버가 없어 "DB 에 연결하지 못했습니다" 화면이 나온다.
> 반드시 `localhost:8791` 로 열 것.

`.env` 에 접속 정보를 둔다 (`.env.example` 복사해서 사용, git 에는 안 올라감).

```
DATABASE_URL=postgresql://postgres.<프로젝트ref>:<비밀번호>@aws-0-<리전>.pooler.supabase.com:6543/postgres
PORT=8791
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

`OPENAI_API_KEY` 가 없으면 AI 버튼만 안 보이고 나머지 기능은 그대로 돌아간다.

### DB·키 없이 화면만 보고 싶을 때

```bash
node dev-mem.js       # → http://localhost:8792
```

DB 자리에 pg-mem(메모리), OpenAI 자리에 가짜 응답을 끼워서 앱 전체가 그대로 돈다.
`.env` 가 아직 준비 안 됐어도 화면을 눌러 볼 수 있다. 데이터는 서버를 끄면 사라진다.

## 웹사이트로 열기 (Vercel)

`node server.js` 없이 URL 로 열려면 Vercel 에 올린다. catfood 와 같은 구성이다.

```bash
cd week4/quest
vercel            # 처음 한 번은 프로젝트 연결
vercel --prod
```

**환경변수는 저장소가 아니라 Vercel 에 넣는다.**
Project → Settings → Environment Variables 에 `DATABASE_URL`, `OPENAI_API_KEY`, (선택) `OPENAI_MODEL`.
`.env` 는 `.vercelignore` 로 배포에서 빠진다.

> **GitHub Pages 로는 안 된다.** 정적 호스팅이라 서버가 없어서 DB 를 못 쓰고,
> OpenAI 키를 브라우저에 넣어야 해서 키가 그대로 공개된다. 서버가 필요한 앱이라 Vercel 같은 곳이라야 한다.

### 로컬과 배포가 같은 코드를 쓴다

```
handler.js  ← 요청 처리 본체 (라우팅 · DB · AI)
  ├── server.js      로컬: 포트 열고 정적 파일까지 같이 내줌
  └── api/index.js   Vercel: /api/* 만 서버리스 함수로 (정적은 Vercel 이 직접)
```

`server.js` 와 `dev-mem.js` 는 `.vercelignore` 에 있다.
배포에 남아 있으면 Vercel 이 그걸 앱 진입점으로 잡아 정적 `index.html` 을 덮어쓴다.

## 기능

**냉장고 탭**
- 재료 추가 / 수정 / 삭제, `+` `−` 버튼으로 수량 바로 조절
- 유통기한 D-day 자동 계산 → `D-4` / `오늘까지` / `1일 지남` 배지
- 검색 + 분류(채소·육류·양념…) + 보관위치(냉장·냉동·실온) 필터
- 임박순 / 이름순 / 분류순 정렬, `⚠️ 임박한 것만` 토글

**레시피 탭**
- 냉장고 재료와 대조해 **보유 매칭률**을 막대로 표시 (`4/5 재료 보유 · 80%`), 높은 순 정렬
- `✅ 지금 만들 수 있는 것` / `⚠️ 임박 재료 쓰는 것` 필터
- 상세에서 재료 보유 현황 + 조리 순서 확인
- **요리 완료** → 사용한 만큼 재료 차감 + `fridge_cook_log` 에 기록 → 탭 위에 "최근에 만든 것" 표시

**✨ AI 레시피** (레시피 탭 오른쪽 버튼)
- 지금 냉장고에 **있는 재료만으로** 만들 수 있는 요리를 OpenAI 가 하나 만들어 준다
- 유통기한 임박한 재료를 자동으로 골라 두고("꼭 쓸 재료"), `매콤하게` 같은 추가 요청도 넣을 수 있다
- 만들어진 레시피는 DB 에 저장돼 목록 맨 앞에 `✨ AI` 배지로 남고, 바로 **요리 완료**로 재료 차감까지 된다
- 마음에 안 들면 상세에서 삭제 (기본 제공 레시피는 못 지운다)

**장보기 탭**
- 레시피 상세의 `부족한 재료 담기` → 어느 레시피 때문인지까지 같이 저장
- 체크한 항목을 한 번에 **냉장고로 옮기기** (유통기한 7일로 임시 설정)

## 데이터베이스

테이블 4개. 서버가 처음 뜰 때 `CREATE TABLE IF NOT EXISTS` 로 만들고, 비어 있으면 시드를 넣는다.

| 테이블 | 하는 일 |
|---|---|
| `fridge_ingredients` | 냉장고 재료 (이름·수량·단위·보관·유통기한) |
| `fridge_recipes` | 레시피. `tags` `need` `steps` 는 `jsonb` |
| `fridge_shopping` | 장보기 목록 (`source` 에 어느 레시피 때문인지) |
| `fridge_cook_log` | 요리 완료 기록 (`used` 에 쓴 재료를 `jsonb` 로) |

`fridge_recipes.source` 가 `seed`(기본 제공) / `ai`(AI 생성) 를 구분한다.
나중에 붙인 칸이라 `ALTER TABLE … ADD COLUMN IF NOT EXISTS` 로 넣어서 이미 만들어진 DB 에도 그대로 들어간다.

**시드**는 재료 23개 / 레시피 10개.
유통기한은 고정 날짜가 아니라 `dateStr(n)` 으로 **넣는 시점 기준 상대 날짜**라,
처음 켜면 "오늘까지"·"1일 지남"이 자연스럽게 섞여 보인다.
레시피는 `ON CONFLICT (id) DO NOTHING` 이라 DB 에서 고친 내용이 재시작 때 덮이지 않는다.

**트랜잭션**을 쓰는 곳은 두 군데다. 여러 행을 한꺼번에 바꾸므로 중간에 실패하면 통째로 되돌아간다.

- `요리 완료` — 재료 여러 개 차감 + 0 이하 삭제 + 기록 남기기
- `체크한 것 냉장고에 넣기` — 재료 추가/합치기 + 장바구니에서 삭제

## API

쓰기 요청은 전부 **바뀐 뒤의 전체 상태**를 돌려준다. 화면은 받아서 통째로 갈아끼우기만 하면 되고,
낙관적 갱신을 안 하므로 화면과 DB 가 어긋날 일이 없다.

| 메서드 | 경로 | 하는 일 |
|---|---|---|
| GET | `/api/health` | DB · AI 연결 상태 (비밀번호와 키는 안 나감) |
| GET | `/api/state` | `{ ingredients, recipes, shopping, cooks, options, db, ai }` |
| POST | `/api/ingredients` | 재료 추가 |
| PATCH | `/api/ingredients/:id` | 보낸 칸만 수정 |
| POST | `/api/ingredients/:id/bump` | `{ delta }` 수량 증감 (DB 에서 더함) |
| DELETE | `/api/ingredients/:id` | 재료 삭제 |
| POST | `/api/recipes/:id/cook` | 요리 완료 (트랜잭션) |
| POST | `/api/shopping` | `{ items: [...] }` 담기, 같은 이름은 한 번만 |
| POST | `/api/shopping/:id/toggle` | 체크 토글 |
| DELETE | `/api/shopping/:id` | 항목 삭제 |
| POST | `/api/shopping/clear-done` | 체크 항목 비우기 |
| POST | `/api/shopping/stock-up` | 체크한 것 냉장고로 (트랜잭션) |
| POST | `/api/ai/recipe` | `{ note?, use? }` 냉장고 재료로 AI 레시피 생성 → DB 저장 |
| DELETE | `/api/recipes/:id` | AI 레시피 삭제 (기본 레시피는 403) |
| POST | `/api/reset` | 시드 데이터로 초기화 (AI 레시피는 남는다) |

오류는 `{ "detail": "..." }` 한 가지 모양이고, 상태코드는
400(입력) / 403(금지) / 404(없음) / 409(재료 부족) / 429(연타·한도) / 502(AI 응답 문제) / 503(DB·키 없음) 를 쓴다.

## AI 레시피가 지키는 것

1. **키는 서버에만 둔다.** 브라우저는 `/api/ai/recipe` 만 부르고 `OPENAI_API_KEY` 를 절대 못 본다.
2. **모델 출력은 데이터로만 취급한다.** 실행하지 않고 `ai.js` 의 `normalize()` 를 반드시 통과시킨다.
   - 냉장고에 **없는 재료를 지어내면 버린다**
   - 가진 양보다 많이 쓰라고 하면 **가진 만큼으로 줄인다**
   - 모르는 단위는 냉장고에 적힌 단위로 바꾼다
   - 조리 순서가 2단계 미만이거나 쓸 재료가 하나도 없으면 **저장하지 않고 502**
3. **Structured Outputs**(`response_format: json_schema`)로 JSON 을 못 박고, 모델이 그걸 못 받으면 `json_object` 로 한 번 더 시도한다.
4. **돈이 나가는 호출이라** 동시에 하나만 처리한다 (연타하면 두 번째는 429).
5. OpenAI 쪽 오류(401·429·404·타임아웃)는 사람이 읽을 수 있는 한국어로 바꿔서 보여 준다.

## 테스트

Supabase 없이도, OpenAI 없이도 돌아간다.
`pg` 자리에 **pg-mem**(인메모리 PostgreSQL)을, OpenAI 자리에 **가짜 HTTP 서버**를 끼워 넣고 같은 코드를 실행한다.

```bash
npm test           # 77개 (db 23 + api 26 + ai 21 + demo 7)
npm run test:db    # db.js 쿼리 로직
npm run test:api   # 진짜 HTTP 요청으로 라우팅·상태코드·롤백 확인
npm run test:ai    # AI 경로 — 응답 검증·폴백·오류 처리·동시성
npm run test:demo  # DATABASE_URL 없을 때 메모리 DB 로 도는지
```

## 구조

```
quest/
  index.html    화면 (React, CDN) — 서버에서 상태를 받아 그리기만 한다
  handler.js    요청 처리 본체 — 라우팅 · .env 로딩 · 트랜잭션
  server.js     로컬 진입점 — 포트 열고 정적 파일까지 제공
  api/index.js  Vercel 서버리스 진입점 — 같은 handler.js 를 쓴다
  dev-mem.js    DB·키 없이 띄우는 개발용 진입점
  db.js         스키마 · 쿼리 · 입력 정리 · 시드 데이터
  ai.js         OpenAI 호출 · 프롬프트 · 응답 검증
  vercel.json   배포 설정
  test-db.js    db.js 검사 (pg-mem)
  test-api.js   라우팅 검사 (pg-mem + 실제 HTTP)
  test-ai.js    AI 경로 검사 (pg-mem + 가짜 OpenAI)
  test-demo.js  데모 모드 검사 (DATABASE_URL 없을 때)
  .env          접속 정보 (git 에 안 올라감)
```

`db.js` 의 `makeStore(query, tx)` 는 드라이버를 주입받는다. 그래서 진짜 `pg` 로도,
테스트용 `pg-mem` 으로도 **똑같은 코드**가 돈다.
