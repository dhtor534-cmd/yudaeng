// 네이버 금융 시장지표(환율) 페이지 스크린샷.
//   node scripts/naver-exchange-shot.js
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const out = path.join(__dirname, '..', 'naver_exchange.png');
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ locale: 'ko-KR', viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('https://finance.naver.com/marketindex/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: out });
  console.log('saved:', out);
  await browser.close();
})();
