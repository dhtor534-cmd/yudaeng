// 플레이라이트로 네이버 카페를 연다. 인자로 카페 주소(또는 club id 경로)를 받는다.
//
//   node scripts/open-naver-cafe.js                 -> 카페 메인
//   node scripts/open-naver-cafe.js noljatravel     -> 테슬라코리아클럽(TKC)
//
const { chromium } = require('playwright');

const slug = process.argv[2];
const url = slug
  ? `https://cafe.naver.com/${slug}`
  : 'https://cafe.naver.com';

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  console.log('Naver Cafe:', await page.title(), page.url());
  // 로그인이 필요한 카페면 nid.naver.com 로그인 페이지로 이동한다.
})();
