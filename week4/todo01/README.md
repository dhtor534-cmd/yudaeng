# todo01 · 텍스트 파일에 쌓이는 투두

할 일을 적으면 그 순간 **`data/todos.txt` 한 장에 저장**되는 간단한 투두 앱.
화면은 React 18 + Babel을 CDN으로 불러 쓰는 **파일 하나**(빌드 없음),
저장은 Node 표준 모듈만 쓴 `server.js` 가 맡는다.

## 실행

```bash
node server.js          # → http://localhost:8788
```

`index.html` 을 그냥 더블클릭해도 화면은 뜨지만, 저장할 서버가 없어서 경고 배너가 뜬다.
반드시 `http://localhost:8788` 로 접속할 것.

## 환경변수

`.env` 를 두거나 환경변수로 직접 줘도 된다 (실제 환경변수가 우선).

| 변수 | 기본값 | 뜻 |
| --- | --- | --- |
| `TODO_FILE` | `data/todos.txt` | 저장할 텍스트 파일 (상대경로는 `server.js` 기준) |
| `PORT` | `8788` | 서버 포트 |

```bash
cp .env.example .env
TODO_FILE=D:/메모/할일.txt PORT=9000 node server.js      # bash
$env:TODO_FILE="D:/메모/할일.txt"; node server.js         # PowerShell
```

## 저장 형식

탭으로 나뉜 한 줄이 할 일 하나다. **이 파일이 원본이고, 메모장으로 직접 고쳐도 된다.**

```
# todo01 저장 파일 — 이 파일이 원본입니다. 메모장으로 직접 고쳐도 됩니다.
# 상태[ ]/[x] <TAB> id <TAB> 만든시각 <TAB> 우선순위 <TAB> 완료시각 <TAB> 할 일
[x]	4wizb2	2026-09-17 14:27	높음	2026-09-17 15:02	목요일까지 과제 제출
[ ]	45daul	2026-09-17 14:31	보통	-	우유 사기
```

- 탭 없이 `우유 사기` 처럼 한 줄만 적어도 된다 — 다음에 읽을 때 서버가 id·시각·우선순위를 채워 넣는다.
- 줄 앞에 `[x]` 만 붙여도 완료로 읽는다.
- `#` 로 시작하는 줄과 빈 줄은 무시한다.
- 저장은 임시 파일에 쓰고 `rename` 하는 방식이라, 쓰다가 멈춰도 원본이 반쯤 깨지지 않는다.
- 내용의 탭·줄바꿈은 공백으로 바꿔 한 줄을 유지한다. 한 건당 500자까지.

## API

| 메서드 | 경로 | 하는 일 |
| --- | --- | --- |
| GET | `/api/todos` | `{ todos, raw, file }` — 목록과 파일 원문을 같이 준다 |
| POST | `/api/todos` | `{ text, priority }` 추가 |
| PATCH | `/api/todos/:id` | `{ done?, text?, priority? }` 수정 |
| DELETE | `/api/todos/:id` | 삭제 |
| POST | `/api/todos/clear-done` | 완료된 것 일괄 삭제 |
| GET | `/api/file` | 저장된 txt 원문 그대로 |

모든 변경은 서버를 거치고 화면은 서버가 돌려준 목록을 그대로 그린다 — 화면과 파일이 어긋나지 않는다.

## 기능

- 할 일 추가 (엔터), 우선순위 높음 · 보통 · 낮음
- 체크로 완료 / 완료 취소 (완료 시각도 파일에 남는다)
- **더블클릭으로 내용 수정** (엔터 저장 · Esc 취소)
- 필터: 전체 / 할 일 / 완료, 완료 일괄 삭제
- 맨 아래 **저장된 txt 파일 그대로 보기** — 방금 적은 내용이 파일에 어떻게 들어갔는지 바로 확인
- 서버가 꺼져 있으면 경고 배너 + 다시 시도 버튼

## 파일

```
todo01/
├── index.html      화면 (React, 파일 하나)
├── server.js       저장 + 정적 서버 (Node 표준 모듈만)
├── .env.example    TODO_FILE / PORT
├── .gitignore      data/ 와 .env 제외
└── data/todos.txt  실행하면 생기는 저장 파일 (커밋되지 않음)
```
