// 데모 모드 검사 — DATABASE_URL 이 없을 때 메모리 DB 로 대신 도는지 본다.
//   실행: node test-demo.js
// 다른 테스트와 달리 pg 를 바꿔치기하지 않는다. handler.js 가 스스로 pg-mem 을 고르는지가 요점이라서.

const assert = require("node:assert");

// .env 가 있어도 데모 경로를 타도록, 로딩 전에 빈 값을 박아 둔다
process.env.DATABASE_URL = "";
process.env.OPENAI_API_KEY = "";

const { server } = require("./server.js");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log("  ok    " + name); }
  catch (e) { fail++; console.log("  FAIL  " + name + "\n        " + (e && e.message)); }
}

let base = "";
const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
};
const get = (p) => call("GET", p);
const post = (p, b) => call("POST", p, b);

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
  console.log("데모 모드 — DATABASE_URL 없이 검사\n");

  await test("health 가 데모 모드라고 알려준다", async () => {
    const { data } = await get("/api/health");
    assert.strictEqual(data.connected, true, data.detail || "연결 안 됨");
    assert.strictEqual(data.demo, true, "demo 플래그가 없음");
    assert.strictEqual(data.ai.enabled, false, "키가 없는데 AI 가 켜져 있음");
  });

  await test("시드 데이터가 들어와 화면을 채울 수 있다", async () => {
    const { status, data } = await get("/api/state");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.demo, true);
    assert.strictEqual(data.ingredients.length, 23);
    assert.strictEqual(data.recipes.length, 10);
  });

  await test("재료를 추가·수정할 수 있다 (메모리에서)", async () => {
    const made = await post("/api/ingredients", { name: "두유", qty: 500, unit: "ml", category: "유제품" });
    assert.strictEqual(made.status, 201, JSON.stringify(made.data));
    const soy = made.data.ingredients.find((i) => i.name === "두유");
    assert.ok(soy, "추가가 안 됨");
    const bumped = await post(`/api/ingredients/${soy.id}/bump`, { delta: -100 });
    assert.strictEqual(bumped.data.ingredients.find((i) => i.name === "두유").qty, 400);
  });

  await test("요리 완료(트랜잭션)도 그대로 동작한다", async () => {
    const before = (await get("/api/state")).data;
    const kimchi = before.ingredients.find((i) => i.name === "김치").qty;
    const { status, data } = await post("/api/recipes/r1/cook");
    assert.strictEqual(status, 200, JSON.stringify(data));
    assert.strictEqual(data.ingredients.find((i) => i.name === "김치").qty, kimchi - 120);
    assert.strictEqual(data.cooks[0].name, "김치볶음밥");
  });

  await test("재료가 모자라면 데모에서도 409 로 롤백된다", async () => {
    const before = (await get("/api/state")).data.ingredients.map((i) => i.name + i.qty).join("|");
    const { status } = await post("/api/recipes/r3/cook");      // 올리브유 없음
    assert.strictEqual(status, 409);
    const after = (await get("/api/state")).data.ingredients.map((i) => i.name + i.qty).join("|");
    assert.strictEqual(after, before, "롤백이 안 됨");
  });

  await test("키가 없으면 AI 는 503 으로 거절한다", async () => {
    const { status, data } = await post("/api/ai/recipe");
    assert.strictEqual(status, 503);
    assert.ok(data.detail.includes("OPENAI_API_KEY"), data.detail);
  });

  await test("DEMO=off 면 데모로 안 돈다", async () => {
    // 같은 프로세스에서 두 번 못 부르므로 자식 프로세스로 확인한다
    const { execFileSync } = require("node:child_process");
    const out = execFileSync(process.execPath, ["-e", `
      process.env.DATABASE_URL = "";
      process.env.DEMO = "off";
      const h = require("./handler.js");
      console.log(JSON.stringify({ demo: h.DEMO, pool: !!h.pool }));
    `], { cwd: __dirname, encoding: "utf8" });
    const r = JSON.parse(out.trim().split("\n").pop());
    assert.strictEqual(r.demo, false, "DEMO=off 가 무시됨");
    assert.strictEqual(r.pool, false, "풀이 만들어짐");
  });

  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  server.close();
  process.exit(fail ? 1 : 0);
})();
