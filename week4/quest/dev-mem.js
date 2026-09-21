// 개발용 진입점 — Supabase 도 OpenAI 도 없이 앱 전체를 띄운다.
//   실행: node dev-mem.js       →  http://localhost:8792
//
// DB 자리에 pg-mem(인메모리), OpenAI 자리에 가짜 서버를 끼운다.
// server.js / db.js / ai.js / index.html 은 진짜로 쓸 때와 똑같은 코드가 돈다.
// 브라우저에서 화면을 눌러 볼 때, 또는 .env 가 아직 준비 안 됐을 때 쓴다.
//
// ⚠ 데이터는 메모리에만 있다. 서버를 끄면 전부 사라진다.

const http = require("node:http");
const Module = require("node:module");
const { newDb } = require("pg-mem");

/* ---------- pg → pg-mem ---------- */
const mem = newDb();
const pgShim = mem.adapters.createPg();
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "pg") return pgShim;
  return load.apply(this, [request, ...rest]);
};

/* ---------- 가짜 OpenAI ----------
   진짜 모델 대신, 냉장고에서 유통기한이 급한 재료를 골라 그럴듯한 레시피를 만들어 준다.
   ai.js 의 검증 경로(없는 재료 버리기·수량 자르기 등)를 그대로 타는지 보려고 일부러
   있는 재료 + 없는 재료를 섞어서 돌려준다. */
const fakeOpenAI = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    const user = (body.messages || []).map((m) => m.content).join("\n");

    // 프롬프트에 적힌 재료 줄("- 대파 2묶음 (냉장, D-4)")에서 이름만 뽑는다
    const names = [...user.matchAll(/^- (\S+) /gm)].map((m) => m[1]);
    const pick = names.slice(0, 3);

    const recipe = {
      name: (pick[0] || "냉장고") + " 한 접시",
      emoji: "🍲",
      desc: "유통기한이 급한 재료부터 정리하는 간단한 한 접시.",
      minutes: 15,
      level: "쉬움",
      servings: 2,
      tags: ["한식", "냉장고털이"],
      need: [
        ...pick.map((n) => ({ name: n, qty: 1, unit: "개" })),
        { name: "송로버섯", qty: 1, unit: "개" },   // 냉장고에 없는 재료 — 걸러져야 정상
      ],
      steps: [
        pick.join(", ") + " 을(를) 먹기 좋게 썬다.",
        "팬을 달구고 기름을 두른 뒤 단단한 재료부터 볶는다.",
        "나머지를 넣고 3분 더 볶는다.",
        "소금과 후추로 간을 맞춰 완성.",
      ],
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      model: "fake-model (dev-mem)",
      usage: { total_tokens: 0 },
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(recipe) } }],
    }));
  });
});

fakeOpenAI.listen(0, "127.0.0.1", () => {
  process.env.DATABASE_URL = "postgresql://dev:dev@localhost:5432/memdb";
  process.env.PGSSL = "off";
  process.env.OPENAI_API_KEY = "sk-dev-fake";
  process.env.OPENAI_MODEL = "fake-model (dev-mem)";
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:" + fakeOpenAI.address().port + "/v1";
  // 진짜 서버(.env 의 8791)와 동시에 띄울 수 있게 포트를 따로 쓴다.
  // server.js 의 .env 로딩은 이미 들어 있는 환경변수를 덮지 않으므로 여기서 먼저 박아 둔다.
  process.env.PORT = process.env.PORT || "8792";

  const { server } = require("./server.js");
  const port = Number(process.env.PORT);

  server.listen(port, async () => {
    console.log(`냉장고 파먹기 (개발용) → http://localhost:${port}`);
    console.log("  DB: pg-mem (메모리) · AI: 가짜 응답");
    console.log("  ⚠ 데이터는 서버를 끄면 사라집니다. 진짜로 쓰려면 .env 를 채우고 node server.js 를 쓰세요.");
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/state`);
      const s = await r.json();
      console.log(`  준비 완료 · 재료 ${s.ingredients.length}건 · 레시피 ${s.recipes.length}건`);
    } catch (e) {
      console.log("  초기화 실패 —", e.message);
    }
  });
});
