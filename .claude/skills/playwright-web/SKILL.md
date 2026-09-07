---
name: playwright-web
description: >-
  플레이라이트(Playwright)로 실제 브라우저를 띄워 웹사이트를 조작할 때 사용한다. "플레이라이트로 <사이트>
  열어줘", "<사이트>에서 <검색어> 검색해줘", "그 페이지 스크린샷 찍어줘", "로그인해서 ~ 해줘" 같은 요청에
  발동. 스크립트는 weekN/playwright_test/scripts/ 에 저장하고 산출물(스크린샷)은
  weekN/playwright_test/screenshots/ 에 둔다. 로그인이 필요한 사이트는 CDP 호스트 브라우저에
  사용자가 직접 로그인하는 방식을 쓴다. Drive a real Chromium browser with Playwright for
  this course's week3 playwright_test folder.
---

# 플레이라이트로 웹 조작

## 환경

- `node` 실행 파일: `C:\Program Files\nodejs\node.exe` (PATH에 없으면 전체 경로로).
- 셸: PowerShell. bash 툴에서는 `node` 를 못 찾을 수 있으니 PowerShell로 실행.
- 작업 폴더: 존재하는 가장 최근 `weekN/playwright_test/`. 없으면 만든다.
  - `scripts/` — 스크립트, `screenshots/` — 캡처 산출물, `sessions/` — 세션 로그.
- 최초 1회: `npm install` 후 `npx playwright install chromium`.

## 핵심 판단: 로그인이 필요한가?

| 상황 | 방법 |
| --- | --- |
| 로그인 불필요 (검색/뉴스/금융/공개 페이지) | `chromium.launch({ headless:false })` 로 바로 조작 |
| 로그인 필요 (구글폼·네이버 카페·인스타그램·메일 등) | **CDP 호스트 방식** (아래) |

플레이라이트가 새로 띄운 브라우저에는 로그인 세션이 없다. `launch` 로는
로그인 벽을 못 뚫으니 시간 낭비하지 말 것.

## CDP 호스트 방식 (로그인 필요 시)

1. **호스트 브라우저 실행** — 계속 켜둔다 (`run_in_background`).
   ```
   node scripts/cdp-host.js <시작URL>
   ```
   `--remote-debugging-port=9222` 로 뜬다.
2. **사용자에게 로그인 요청** — "열린 창에서 로그인하고 '됐어' 해주세요."
   여러 크로미움 창이 떠 있을 수 있으니 **어느 창인지** (제목/배너로) 짚어준다.
3. **로그인 확인 후에만** 작업 스크립트 실행. `connectOverCDP('http://localhost:9222')`
   로 같은 브라우저에 붙는다.
   - 작업 스크립트가 `page.goto` 로 새로고침하면 사용자가 입력 중이던 로그인 폼이
     초기화된다. 로그인이 끝나기 전에 스크립트를 돌리지 말 것.
   - 기존 로그인 창을 건드리지 않으려면 `ctx.newPage()` 로 새 탭에서 작업.
4. 로그인 여부는 URL로 판별: `nid.naver.com` / `accounts.google.com` /
   `instagram.com/accounts/login` 로 튕겼으면 아직 미로그인.

## 스크립트 작성 규칙

- CommonJS, `const { chromium } = require('playwright')`.
- `headless: false`, 뷰포트 `1400x900` (또는 `1280x900`), 한글 사이트는 `locale: 'ko-KR'`.
- 스크린샷 경로는 `path.join(__dirname, '..', 'screenshots', '<이름>.png')`.
- 인자(`process.argv[2]`)로 검색어·카페 slug 등을 받게 만든다.
- 네이버 카페는 좌측 메뉴가 iframe 안 → `for (const frame of page.frames())` 순회해서
  `frame.locator('a:has-text("...")')` 로 찾는다.
- 조작 후 반드시 스크린샷을 남기고 경로를 콘솔에 출력한다.

## 절차

1. **요청 파악** — 사이트, 할 일(열기/검색/스크린샷/클릭), 검색어를 확정.
   불명확하면 (어느 카페인지 등) 먼저 묻는다.
2. **작업 폴더 확인** — 최근 `weekN/playwright_test/`.
3. **로그인 필요 여부 판단** → 필요하면 CDP 호스트 방식.
4. **스크립트 작성** — `scripts/<사이트>-<동작>.js`. 재사용 가능하게 인자화.
5. **실행** (PowerShell, node 전체 경로). 장시간 유지가 필요하면 `run_in_background`.
6. **결과 확인** — 스크린샷을 Read로 열어보고, 사용자에게 SendUserFile로 보낸다.
7. **보고** — 만든 스크립트 경로, 스크린샷 경로, 다음 단계.
8. **커밋·푸시** — 사용자가 "저장", "커밋", "푸시", "깃허브" 등을 요청하면
   `git add weekN/playwright_test .claude/skills` → 커밋 → `git push origin`.
   `node_modules/` 는 `.gitignore` 로 제외. 아니면 하지 않는다.

## 파일명

| 종류 | 규칙 | 예 |
| --- | --- | --- |
| 스크립트 | `scripts/<사이트>-<동작>.js` | `scripts/instagram-search.js` |
| 스크린샷 | `screenshots/<사이트>-<주제>.png` | `screenshots/instagram-신사맛집.png` |
| 세션 로그 | `sessions/<세션id>.jsonl` + `SESSION_LOG.md` 요약 | |

## 참고 파일

- `scripts/cdp-host.js` — CDP 호스트 브라우저 (복사해서 쓴다)
- `scripts/task-template.js` — connectOverCDP 작업 스크립트 뼈대
- 실제 예시: `weekN/playwright_test/scripts/` (instagram-search, tesla-cafe-jangteo 등)

## 하지 말 것

- 로그인 자동화(아이디/비번 입력 대행) 시도 — 사용자가 직접 하게 한다.
- 로그인 창을 스크립트로 새로고침 — 입력이 날아간다.
- `node_modules/` 커밋.
