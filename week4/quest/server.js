// week4 quest — 로컬 개발용 서버.
//   준비: .env 에 DATABASE_URL=postgresql://...     실행: node server.js  →  http://localhost:8791
//
// 요청 처리는 전부 handler.js 에 있다. 이 파일은 포트를 열고 정적 파일까지 같이 내주는 껍데기다.
// Vercel 에 올릴 때는 이 파일이 안 쓰인다 (api/index.js 가 같은 handler.js 를 부른다).
const http = require("node:http");
const { handle, store, pool, ensureReady, sslOption, info, AI_ON, PORT } = require("./handler");

const server = http.createServer(handle);

if (require.main === module) {
  server.listen(PORT, async () => {
    console.log(`냉장고 재료 & 레시피 → http://localhost:${PORT}`);
    if (!pool) {
      console.log("  DATABASE_URL 없음 — .env 를 만들고 다시 실행하세요. (또는 node dev-mem.js)");
      return;
    }
    console.log(`  DB: ${info ? info.host + " / " + info.database : "(URL 형식을 읽지 못했습니다)"} · SSL ${sslOption() ? "on" : "off"}`);
    console.log(`  AI: ${AI_ON ? (process.env.OPENAI_MODEL || "gpt-4o-mini").trim() : "꺼짐 (OPENAI_API_KEY 없음)"}`);
    try {
      await ensureReady();
      const s = await store.state();
      console.log(`  연결 성공 · 재료 ${s.ingredients.length}건 · 레시피 ${s.recipes.length}건 · 장보기 ${s.shopping.length}건`);
    } catch (e) {
      console.log("  연결 실패 — " + e.message);
      console.log("  (서버는 계속 떠 있습니다. .env 를 고치고 다시 실행하세요.)");
    }
  });
}

module.exports = { server, pool, store, PORT };
