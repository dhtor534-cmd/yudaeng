// 네이버에서 환율(금융 시장지표) + 오늘 날씨 정보를 텍스트로 추출해 콘솔에 출력.
//   node scripts/naver-search-info.js
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ locale: 'ko-KR' });

  const fx = await ctx.newPage();
  await fx.goto('https://finance.naver.com/marketindex/', { waitUntil: 'domcontentloaded' });
  await fx.waitForTimeout(2000);
  const fxData = await fx.evaluate(() => {
    const out = [];
    document.querySelectorAll('#exchangeList > li').forEach(li => {
      const name = li.querySelector('.h_lst')?.innerText.trim();
      const val = li.querySelector('.value')?.innerText.trim();
      const chg = li.querySelector('.change')?.innerText.trim();
      const dir = li.querySelector('.blind')?.innerText.trim();
      if (name && val) out.push(`${name}: ${val}  (${dir || ''} ${chg || ''})`);
    });
    return out;
  });
  console.log('=== 환율 (네이버 금융) ===');
  console.log(fxData.join('\n'));

  const w = await ctx.newPage();
  await w.goto('https://search.naver.com/search.naver?query=' + encodeURIComponent('오늘 날씨'), { waitUntil: 'domcontentloaded' });
  await w.waitForTimeout(2500);
  const wData = await w.evaluate(() => {
    const box = document.querySelector('.weather_area, .api_cs_wrap, ._cs_weather_new');
    return (box ? box.innerText : document.body.innerText)
      .split('\n').map(s => s.trim()).filter(Boolean).slice(0, 30).join('\n');
  });
  console.log('\n=== 오늘 날씨 ===');
  console.log(wData);

  await browser.close();
})();
