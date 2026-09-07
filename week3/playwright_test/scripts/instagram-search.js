// cdp-host.js 로 띄운 브라우저(로그인 완료 상태)에 붙어서
// 인스타그램 해시태그를 검색하고 스크린샷을 저장한다.
//
//   1) node scripts/cdp-host.js https://www.instagram.com/
//   2) 열린 창에서 인스타그램 로그인
//   3) node scripts/instagram-search.js 신사맛집
//
const { chromium } = require('playwright');
const path = require('path');

const keyword = process.argv[2] || '신사맛집';
const outDir = path.join(__dirname, '..', 'screenshots');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];

  let page = ctx.pages().find(p => p.url().includes('instagram.com'));
  if (!page) page = await ctx.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.bringToFront();

  const tagUrl = 'https://www.instagram.com/explore/tags/' + encodeURIComponent(keyword) + '/';
  await page.goto(tagUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  if (page.url().includes('/accounts/login')) {
    console.log('로그인이 필요합니다. cdp-host 창에서 인스타그램 로그인 후 다시 실행하세요.');
    return;
  }

  const out = path.join(outDir, `instagram-${keyword}.png`);
  await page.screenshot({ path: out });
  console.log('saved:', out, '| URL:', page.url());
})();
