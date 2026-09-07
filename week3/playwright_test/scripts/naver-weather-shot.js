// 네이버 "오늘 날씨" 검색결과 스크린샷 (전체 + 날씨 영역 크롭).
//   node scripts/naver-weather-shot.js
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const outDir = path.join(__dirname, '..');
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ locale: 'ko-KR', viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('https://search.naver.com/search.naver?query=' + encodeURIComponent('오늘 날씨'), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  await page.screenshot({ path: path.join(outDir, 'naver_weather.png') });
  console.log('saved: naver_weather.png');

  const box = page.locator('.weather_area, ._cs_weather_new, .api_cs_wrap').first();
  try {
    await box.screenshot({ path: path.join(outDir, 'naver_weather_crop.png') });
    console.log('saved: naver_weather_crop.png');
  } catch (e) {
    console.log('crop skipped:', e.message);
  }
  await browser.close();
})();
