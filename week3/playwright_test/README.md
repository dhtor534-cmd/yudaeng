# week3 · 플레이라이트 실습

실제 크로미움을 띄워서 웹사이트를 자동 조작하는 연습. (headless 아님)

## 준비

```bash
cd week3/playwright_test
npm install
npx playwright install chromium   # 최초 1회
```

> 이 환경에서 `node` 는 `C:\Program Files\nodejs\node.exe` 에 있음. PATH에 없으면 전체 경로로 실행.

## 스크립트

| 파일 | 설명 | 로그인 |
| --- | --- | --- |
| `scripts/cdp-host.js` | CDP 포트(9222)로 브라우저를 띄운 채 유지. 로그인이 필요한 작업의 베이스. | 사용자가 창에서 직접 |
| `scripts/open-google-form.js` | 새 구글폼 생성 페이지 열기 | 구글 |
| `scripts/open-naver-cafe.js` | 네이버 카페 열기 (`node ... noljatravel`) | 카페별 |
| `scripts/tesla-cafe-jangteo.js` | TKC(테슬라코리아클럽) 통합장터 이동 + 스크린샷 | 네이버 |
| `scripts/instagram-search.js` | 인스타 해시태그 검색 + 스크린샷 (`node ... 신사맛집`) | 인스타그램 |
| `scripts/naver-exchange-shot.js` | 네이버 금융 환율 페이지 스크린샷 | 불필요 |
| `scripts/naver-weather-shot.js` | 네이버 "오늘 날씨" 스크린샷 (+크롭) | 불필요 |
| `scripts/naver-search-info.js` | 환율 + 날씨 텍스트 추출 → 콘솔 | 불필요 |

## 로그인이 필요한 사이트 패턴

구글폼 / 네이버 카페 / 인스타그램은 로그인 없이는 내용이 안 보인다.
플레이라이트가 새로 띄운 브라우저는 로그인 세션이 없으므로:

```bash
# 1) 호스트 브라우저 실행 (계속 켜둠)
node scripts/cdp-host.js https://www.instagram.com/

# 2) 열린 창에서 사람이 직접 로그인

# 3) 다른 터미널에서 작업 스크립트 실행 (같은 브라우저에 붙음)
node scripts/instagram-search.js 신사맛집
```

`connectOverCDP('http://localhost:9222')` 로 같은 브라우저를 재사용한다.
작업 스크립트가 `page.goto` 로 페이지를 새로고침하면 사용자가 입력 중이던
로그인 폼이 초기화될 수 있으니, 로그인 완료 후에 실행할 것.

## 산출물

- `naver_exchange.png`, `naver_weather.png` — 로그인 불필요 스크린샷
- `screenshots/` — 카페 / 인스타그램 등 실습 중 캡처
- `sessions/` — 이 실습을 진행한 Claude Code 세션 로그(.jsonl)

## 관련 스킬

`.claude/skills/playwright-web/` — 위 패턴을 재사용하는 스킬.
