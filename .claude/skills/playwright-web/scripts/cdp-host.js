// 로그인이 필요한 사이트용 "호스트" 브라우저.
// 크로미움을 CDP 포트(9222)로 띄운 채 유지한다. 사용자는 열린 창에서 직접
// 로그인하고, 작업 스크립트는 chromium.connectOverCDP('http://localhost:9222')
// 로 붙어서 같은 브라우저를 재사용한다.
//
//   node scripts/cdp-host.js [시작URL]
//
const { chromium } = require('playwright');

const startUrl = process.argv[2] || 'https://www.naver.com';

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ['--remote-debugging-port=9222'],
  });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  console.log('HOST READY (CDP :9222) ->', await page.title(), page.url());
  console.log('이 창에서 로그인하세요. 창은 계속 열려 있습니다. (Ctrl+C 로 종료)');
  await new Promise(() => {}); // keep alive
})();
