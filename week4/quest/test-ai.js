// AI 레시피 생성 검사 — 진짜 OpenAI 를 부르지 않는다.
//   실행: node test-ai.js
// 가짜 OpenAI 서버를 띄우고 OPENAI_BASE_URL 을 그쪽으로 돌린 뒤, DB 는 pg-mem 으로 대신한다.
// 돈도 안 들고 네트워크도 필요 없지만, 서버가 실제로 타는 경로는 똑같다.

const assert = require("node:assert");
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

/* ---------- 가짜 OpenAI ---------- */
// next 에 다음 응답을 넣어 두면 그대로 돌려준다. 요청 본문은 seen 에 쌓아 두고 나중에 확인한다.
let next = null;
let seen = [];
let delayMs = 0;

const fakeOpenAI = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}") });
    const reply = () => {
      const r = typeof next === "function" ? next(seen[seen.length - 1]) : next;
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.body));
    };
    if (delayMs) setTimeout(reply, delayMs); else reply();
  });
});

/** 모델이 정상 응답했을 때의 모양 */
const ok = (recipe, extra) => ({
  status: 200,
  body: {
    model: "fake-model",
    usage: { total_tokens: 321 },
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(recipe) } }],
    ...extra,
  },
});

const GOOD = {
  name: "애호박 두부 볶음",
  emoji: "🥒",
  desc: "임박한 애호박과 두부를 한 번에 정리하는 볶음.",
  minutes: 15,
  level: "쉬움",
  servings: 2,
  tags: ["한식", "반찬"],
  need: [
    { name: "애호박", qty: 1, unit: "개" },
    { name: "두부", qty: 0.5, unit: "모" },
    { name: "다진마늘", qty: 10, unit: "g" },
  ],
  steps: [
    "애호박은 반달 모양으로 썰고 두부는 깍둑 썬다.",
    "팬에 기름을 두르고 다진마늘을 볶아 향을 낸다.",
    "애호박을 넣고 3분, 두부를 넣고 2분 더 볶는다.",
    "소금으로 간해 마무리한다.",
  ],
};

/* ---------- 테스트 도구 ---------- */
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log("  ok    " + name); }
  catch (e) { fail++; console.log("  FAIL  " + name + "\n        " + (e && e.message)); }
}

let base = "";
async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const get = (p) => call("GET", p);
const post = (p, b) => call("POST", p, b);
const del = (p) => call("DELETE", p);

(async () => {
  await new Promise((r) => fakeOpenAI.listen(0, "127.0.0.1", r));
  const fakeUrl = "http://127.0.0.1:" + fakeOpenAI.address().port + "/v1";

  process.env.DATABASE_URL = "postgresql://tester:pw@localhost:5432/memdb";
  process.env.PGSSL = "off";
  process.env.OPENAI_API_KEY = "sk-test-fake-key";
  process.env.OPENAI_MODEL = "gpt-4o-mini";
  process.env.OPENAI_BASE_URL = fakeUrl;

  const { server } = require("./server.js");
  const { generateRecipe } = require("./ai.js");

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
  console.log("AI 레시피 생성 — 가짜 OpenAI 로 검사\n");

  await test("health / state 가 AI 켜짐을 알려준다", async () => {
    const h = await get("/api/health");
    assert.strictEqual(h.data.ai.enabled, true);
    const s = await get("/api/state");
    assert.strictEqual(s.data.ai.enabled, true);
    assert.strictEqual(s.data.ai.model, "gpt-4o-mini");
  });

  await test("키가 응답에 안 실린다", async () => {
    const s = await get("/api/state");
    assert.ok(!JSON.stringify(s.data).includes("sk-test"), "API 키가 브라우저로 내려감");
  });

  await test("생성 성공 — 201, DB 에 저장되고 목록 맨 앞에 온다", async () => {
    seen = []; next = ok(GOOD);
    const { status, data } = await post("/api/ai/recipe", { note: "간단하게" });
    assert.strictEqual(status, 201, JSON.stringify(data));
    const made = data.recipes.find((r) => r.id === data.createdRecipeId);
    assert.ok(made, "만든 레시피가 목록에 없음");
    assert.strictEqual(made.name, "애호박 두부 볶음");
    assert.strictEqual(made.source, "ai");
    assert.strictEqual(data.recipes[0].id, made.id, "AI 레시피가 맨 앞이 아님");
    assert.ok(data.message.includes("애호박 두부 볶음"), data.message);
  });

  await test("프롬프트에 냉장고 재료와 D-day 가 들어간다", async () => {
    const sent = seen[seen.length - 1].body;
    const user = sent.messages.find((m) => m.role === "user").content;
    assert.ok(user.includes("애호박"), "재료가 프롬프트에 없음");
    assert.ok(/D-\d|오늘까지|지남/.test(user), "유통기한 정보가 프롬프트에 없음");
    assert.ok(user.includes("간단하게"), "추가 요청이 프롬프트에 없음");
    assert.strictEqual(seen[seen.length - 1].auth, "Bearer sk-test-fake-key");
    assert.strictEqual(sent.response_format.type, "json_schema");
  });

  await test("만든 레시피로 바로 요리할 수 있다 (재료가 실제로 차감된다)", async () => {
    const before = (await get("/api/state")).data;
    const aiRecipe = before.recipes.find((r) => r.source === "ai");
    const tofuBefore = before.ingredients.find((i) => i.name === "두부").qty;
    const { status, data } = await post(`/api/recipes/${aiRecipe.id}/cook`);
    assert.strictEqual(status, 200, JSON.stringify(data));
    assert.strictEqual(data.ingredients.find((i) => i.name === "두부").qty, tofuBefore - 0.5);
    assert.strictEqual(data.cooks[0].name, "애호박 두부 볶음");
  });

  await test("냉장고에 없는 재료를 지어내면 걸러진다", async () => {
    seen = [];
    next = ok({ ...GOOD, name: "가짜재료 볶음", need: [
      { name: "트러플", qty: 1, unit: "개" },          // 냉장고에 없음 → 버려야 함
      { name: "양파", qty: 1, unit: "개" },
    ] });
    const { status, data } = await post("/api/ai/recipe");
    assert.strictEqual(status, 201, JSON.stringify(data));
    const made = data.recipes.find((r) => r.id === data.createdRecipeId);
    assert.deepStrictEqual(made.need.map((n) => n.name), ["양파"], "없는 재료가 살아남음");
  });

  await test("가진 양보다 많이 쓰라고 하면 가진 만큼으로 줄인다", async () => {
    const state = (await get("/api/state")).data;
    const onion = state.ingredients.find((i) => i.name === "양파");
    seen = [];
    next = ok({ ...GOOD, name: "양파 폭탄", need: [{ name: "양파", qty: onion.qty + 50, unit: "개" }] });
    const { data } = await post("/api/ai/recipe");
    const made = data.recipes.find((r) => r.id === data.createdRecipeId);
    assert.strictEqual(made.need[0].qty, onion.qty, "가진 양을 넘는 수량이 그대로 저장됨");
  });

  await test("단위는 무조건 냉장고 단위로 맞춘다", async () => {
    // 모르는 단위(스푼)도, 아는데 다른 단위(g)도 전부 냉장고에 적힌 단위로 바꾼다.
    // 그러지 않으면 요리 완료 때 차감이 조용히 건너뛰어진다.
    for (const wrong of ["스푼", "g"]) {
      seen = [];
      next = ok({ ...GOOD, name: "단위 " + wrong, need: [{ name: "양파", qty: 1, unit: wrong }] });
      const { data } = await post("/api/ai/recipe");
      const made = data.recipes.find((r) => r.id === data.createdRecipeId);
      assert.strictEqual(made.need[0].unit, "개", wrong + " 가 안 바뀜");
    }
  });

  await test("단위를 맞췄으니 AI 레시피는 항상 실제로 차감된다", async () => {
    const before = (await get("/api/state")).data;
    const milk = before.ingredients.find((i) => i.name === "우유");   // 냉장고 단위는 ml
    seen = [];
    next = ok({ ...GOOD, name: "우유 차감 확인", need: [{ name: "우유", qty: 2, unit: "개" }] });
    const made = (await post("/api/ai/recipe")).data;
    const recipe = made.recipes.find((r) => r.id === made.createdRecipeId);
    assert.strictEqual(recipe.need[0].unit, "ml");
    const after = (await post("/api/recipes/" + recipe.id + "/cook")).data;
    assert.strictEqual(after.ingredients.find((i) => i.name === "우유").qty, milk.qty - 2, "차감이 안 됨");
  });

  await test("조리 순서가 없으면 502 (쓰레기 응답을 저장하지 않는다)", async () => {
    const before = (await get("/api/state")).data.recipes.length;
    next = ok({ ...GOOD, steps: [] });
    const { status, data } = await post("/api/ai/recipe");
    assert.strictEqual(status, 502, JSON.stringify(data));
    assert.strictEqual((await get("/api/state")).data.recipes.length, before, "실패했는데 저장됨");
  });

  await test("JSON 이 아니면 502", async () => {
    next = { status: 200, body: { choices: [{ finish_reason: "stop", message: { content: "안녕하세요" } }] } };
    const { status, data } = await post("/api/ai/recipe");
    assert.strictEqual(status, 502);
    assert.ok(data.detail.includes("JSON"), data.detail);
  });

  await test("응답이 잘리면(finish_reason=length) 502", async () => {
    next = { status: 200, body: { choices: [{ finish_reason: "length", message: { content: "{" } }] } };
    const { status, data } = await post("/api/ai/recipe");
    assert.strictEqual(status, 502);
    assert.ok(data.detail.includes("잘렸"), data.detail);
  });

  await test("OpenAI 401 → 키 문제라고 알려준다", async () => {
    next = { status: 401, body: { error: { message: "Incorrect API key provided" } } };
    const { status, data } = await post("/api/ai/recipe");
    assert.strictEqual(status, 502);
    assert.ok(data.detail.includes("OPENAI_API_KEY"), data.detail);
  });

  await test("OpenAI 429(크레딧 소진) → 한도 문제라고 알려준다", async () => {
    next = { status: 429, body: { error: { message: "You exceeded your current quota" } } };
    const { status, data } = await post("/api/ai/recipe");
    assert.strictEqual(status, 502);
    assert.ok(data.detail.includes("한도"), data.detail);
  });

  await test("모델이 json_schema 를 못 받으면 json_object 로 다시 시도한다", async () => {
    seen = [];
    next = (req) =>
      req.body.response_format.type === "json_schema"
        ? { status: 400, body: { error: { message: "response_format json_schema is not supported" } } }
        : ok({ ...GOOD, name: "폴백 볶음" });
    const { status, data } = await post("/api/ai/recipe");
    assert.strictEqual(status, 201, JSON.stringify(data));
    assert.strictEqual(seen.length, 2, "두 번 시도하지 않음");
    assert.strictEqual(seen[1].body.response_format.type, "json_object");
    assert.ok(data.recipes.some((r) => r.name === "폴백 볶음"));
  });

  await test("동시에 두 번 누르면 하나는 429 로 막힌다", async () => {
    next = ok({ ...GOOD, name: "동시성 테스트" });
    delayMs = 150;
    const [a, b] = await Promise.all([post("/api/ai/recipe"), post("/api/ai/recipe")]);
    delayMs = 0;
    const codes = [a.status, b.status].sort();
    assert.deepStrictEqual(codes, [201, 429], "동시 호출이 안 막힘: " + codes.join(","));
  });

  await test("AI 레시피는 지울 수 있다", async () => {
    const aiRecipe = (await get("/api/state")).data.recipes.find((r) => r.source === "ai");
    const { status, data } = await del("/api/recipes/" + aiRecipe.id);
    assert.strictEqual(status, 200, JSON.stringify(data));
    assert.ok(!data.recipes.some((r) => r.id === aiRecipe.id), "안 지워짐");
  });

  await test("기본 제공 레시피는 못 지운다 (403)", async () => {
    const { status, data } = await del("/api/recipes/r1");
    assert.strictEqual(status, 403, JSON.stringify(data));
    assert.ok((await get("/api/state")).data.recipes.some((r) => r.id === "r1"));
  });

  await test("초기화해도 AI 레시피는 남는다 (재료만 되돌린다)", async () => {
    next = ok({ ...GOOD, name: "초기화 생존자" });
    await post("/api/ai/recipe");
    const { data } = await post("/api/reset");
    assert.ok(data.recipes.some((r) => r.name === "초기화 생존자"), "AI 레시피가 지워짐");
    assert.strictEqual(data.ingredients.length, 23);
  });

  await test("키가 없으면 503 으로 알려준다", async () => {
    await assert.rejects(
      () => generateRecipe([{ name: "양파", qty: 1, unit: "개", storage: "실온", expiresAt: "" }], {}, {}),
      (e) => e.status === 503 && /OPENAI_API_KEY/.test(e.message)
    );
  });

  await test("냉장고가 비어 있으면 부르지도 않는다", async () => {
    await assert.rejects(() => generateRecipe([], {}, process.env), /냉장고가 비어/);
  });

  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  server.close();
  fakeOpenAI.close();
  process.exit(fail ? 1 : 0);
})();
