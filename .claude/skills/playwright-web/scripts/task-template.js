// cdp-host.js 로 띄운 브라우저(로그인 완료)에 붙어서 작업하는 스크립트 뼈대.
// 복사해서 <사이트>-<동작>.js 로 만든다.
//
//   1) node scripts/cdp-host.js <시작URL>
//   2) 열린 창에서 로그인
//   3) node scripts/<이 파일>.js [인자]
//
const { chromium } = require('playwright');
const path = require('path');

const arg = process.argv[2] || '';
const outDir = path.join(__dirname, '..', 'screenshots');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];

  // 기존 로그인 창 재사용:  const page = ctx.pages()[0];
  // 새 탭에서 작업(로그인 창 안 건드림):
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.bringToFront();

  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  // 로그인 벽 판별
  if (/nid\.naver\.com|accounts\.google\.com|instagram\.com\/accounts\/login/.test(page.url())) {
    console.log('로그인이 필요합니다. cdp-host 창에서 로그인 후 다시 실행하세요.');
    return;
  }

  // === 여기서 작업 ===
  // 네이버 카페 등 iframe 메뉴:
  // for (const frame of page.frames()) {
  //   const link = frame.locator('a:has-text("통합장터")').first();
  //   if (await link.count()) { await link.click(); break; }
  // }

  const out = path.join(outDir, `result-${Date.now()}.png`);
  await page.screenshot({ path: out });
  console.log('saved:', out, '| URL:', page.url());
})();
