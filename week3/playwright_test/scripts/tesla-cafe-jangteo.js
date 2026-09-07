// cdp-host.js 로 띄운 브라우저(네이버 로그인 완료 상태)에 붙어서
// 테슬라코리아클럽(TKC, cafe.naver.com/noljatravel) 통합장터로 이동하고
// 스크린샷을 저장한다.
//
//   1) node scripts/cdp-host.js https://cafe.naver.com/noljatravel
//   2) 열린 창에서 네이버 로그인
//   3) node scripts/tesla-cafe-jangteo.js
//
const { chromium } = require('playwright');
const path = require('path');

const CAFE = 'https://cafe.naver.com/noljatravel';
const outDir = path.join(__dirname, '..', 'screenshots');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  await page.bringToFront();

  await page.goto(CAFE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  if (page.url().includes('nid.naver.com')) {
    console.log('로그인이 필요합니다. cdp-host 창에서 네이버 로그인 후 다시 실행하세요.');
    return;
  }

  // 좌측 메뉴 프레임에서 "장터" 링크 탐색
  const labels = ['통합장터', '통합 장터', '장터'];
  let clicked = false;
  for (const frame of page.frames()) {
    for (const label of labels) {
      const link = frame.locator(`a:has-text("${label}")`).first();
      if (await link.count().catch(() => 0)) {
        try {
          await link.click({ timeout: 5000 });
          clicked = true;
          console.log(`"${label}" 클릭 (frame: ${frame.url()})`);
          break;
        } catch (_) {}
      }
    }
    if (clicked) break;
  }
  if (!clicked) console.log('장터 링크를 자동으로 찾지 못했습니다. 카페 UI 변경 확인 필요.');

  await page.waitForTimeout(2500);
  const out = path.join(outDir, 'tesla-cafe-jangteo.png');
  await page.screenshot({ path: out });
  console.log('saved:', out, '| URL:', page.url());
})();
