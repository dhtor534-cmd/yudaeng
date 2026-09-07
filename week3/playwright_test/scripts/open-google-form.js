// 플레이라이트로 새 구글폼 생성 페이지를 연다.
// (구글 로그인이 안 돼 있으면 로그인 페이지로 리다이렉트된다 -> cdp-host.js 사용 권장)
//
//   node scripts/open-google-form.js
//
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('https://docs.google.com/forms/u/0/create');
  console.log('Google Form:', await page.title(), page.url());
  // 브라우저를 열어둔 채로 유지
})();
