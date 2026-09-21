// server.js 검사 — pg 드라이버 자리에 pg-mem 을 끼워 넣고 진짜 HTTP 요청을 보낸다.
//   실행: node test-api.js
// 이렇게 하면 Supabase 없이도 라우팅·상태코드·트랜잭션 동작을 그대로 확인할 수 있다.

const assert = require("node:assert");
const Module = require("node:module");
const { newDb } = require("pg-mem");

/* ---------- pg 를 pg-mem 으로 바꿔치기 (server.js 를 require 하기 전에) ---------- */
const mem = newDb();
const pgShim = mem.adapters.createPg();

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "pg") return pgShim;
  return load.apply(this, [request, ...rest]);
};

process.env.DATABASE_URL = "postgresql://tester:pw@localhost:5432/memdb";
process.env.PGSSL = "off";

const { server } = require("./server.js");

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
  try { data = await res.json(); } catch { /* 본문 없음 */ }
  return { status: res.status, data };
}
const get = (p) => call("GET", p);
const post = (p, b) => call("POST", p, b);
const patch = (p, b) => call("PATCH", p, b);
const del = (p) => call("DELETE", p);

const find = (state, name) => state.ingredients.find((i) => i.name === name);

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
  console.log("server.js — pg-mem 위에서 HTTP 검사 (" + base + ")\n");

  await test("GET /api/health — 연결됨으로 나온다", async () => {
    const { status, data } = await get("/api/health");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.connected, true, data.detail || "");
    assert.ok(data.db.host, "DB 호스트 정보가 없음");
  });

  await test("health 응답에 비밀번호가 안 실린다", async () => {
    const { data } = await get("/api/health");
    assert.ok(!JSON.stringify(data).includes("pw"), "응답에 비밀번호가 들어감");
  });

  await test("GET /api/state — 재료·레시피·장보기·기록·선택지가 온다", async () => {
    const { status, data } = await get("/api/state");
    assert.strictEqual(status, 200);
    assert.ok(data.ingredients.length > 0, "재료가 비었음");
    assert.strictEqual(data.recipes.length, 10);
    assert.deepStrictEqual(data.shopping, []);
    assert.deepStrictEqual(data.cooks, []);
    assert.ok(data.options.categories.includes("채소"), "분류 선택지가 없음");
    assert.ok(data.options.units.includes("g"), "단위 선택지가 없음");
  });

  await test("POST /api/ingredients — 201 과 바뀐 전체 상태", async () => {
    const before = (await get("/api/state")).data.ingredients.length;
    const { status, data } = await post("/api/ingredients", {
      name: "식빵", qty: 2, unit: "장", category: "곡물·면", storage: "실온", expiresAt: "",
    });
    assert.strictEqual(status, 201);
    assert.strictEqual(data.ingredients.length, before + 1);
    assert.ok(data.message.includes("식빵"), "안내 문구가 없음");
    assert.strictEqual(find(data, "식빵").emoji, "🍞");
  });

  await test("POST /api/ingredients — 이름이 비면 400", async () => {
    const { status, data } = await post("/api/ingredients", { name: "  " });
    assert.strictEqual(status, 400);
    assert.ok(data.detail.includes("비어"), data.detail);
  });

  await test("PATCH /api/ingredients/:id — 수량만 바꾼다", async () => {
    const bread = find((await get("/api/state")).data, "식빵");
    const { status, data } = await patch("/api/ingredients/" + bread.id, { qty: 4 });
    assert.strictEqual(status, 200);
    assert.strictEqual(find(data, "식빵").qty, 4);
    assert.strictEqual(find(data, "식빵").unit, "장", "안 보낸 칸이 바뀜");
  });

  await test("PATCH — 없는 id 면 404", async () => {
    const { status } = await patch("/api/ingredients/987654", { qty: 1 });
    assert.strictEqual(status, 404);
  });

  await test("POST /api/ingredients/:id/bump — +1 / -1", async () => {
    const bread = find((await get("/api/state")).data, "식빵");
    let { data } = await post("/api/ingredients/" + bread.id + "/bump", { delta: 1 });
    assert.strictEqual(find(data, "식빵").qty, 5);
    ({ data } = await post("/api/ingredients/" + bread.id + "/bump", { delta: -1 }));
    assert.strictEqual(find(data, "식빵").qty, 4);
  });

  await test("bump — delta 가 0 이면 400", async () => {
    const bread = find((await get("/api/state")).data, "식빵");
    const { status } = await post("/api/ingredients/" + bread.id + "/bump", { delta: 0 });
    assert.strictEqual(status, 400);
  });

  await test("POST /api/recipes/:id/cook — 재료가 깎이고 기록이 남는다", async () => {
    const before = (await get("/api/state")).data;
    const kimchi = find(before, "김치").qty;
    const { status, data } = await post("/api/recipes/r1/cook");
    assert.strictEqual(status, 200);
    assert.strictEqual(find(data, "김치").qty, kimchi - 120);
    assert.strictEqual(data.cooks[0].name, "김치볶음밥");
    assert.ok(data.message.includes("김치볶음밥"), data.message);
  });

  await test("cook — 재료가 모자라면 409, 아무것도 안 바뀐다", async () => {
    const before = (await get("/api/state")).data.ingredients.map((i) => i.name + i.qty).join("|");
    const { status, data } = await post("/api/recipes/r3/cook");   // 올리브유가 없다
    assert.strictEqual(status, 409, JSON.stringify(data));
    assert.ok(data.detail.includes("올리브유"), data.detail);
    const after = (await get("/api/state")).data.ingredients.map((i) => i.name + i.qty).join("|");
    assert.strictEqual(after, before, "롤백이 안 됨");
  });

  await test("cook — 없는 레시피면 404", async () => {
    const { status } = await post("/api/recipes/r999/cook");
    assert.strictEqual(status, 404);
  });

  await test("POST /api/shopping — 부족한 재료 여러 개 담기", async () => {
    const { status, data } = await post("/api/shopping", {
      items: [
        { name: "올리브유", qty: 40, unit: "ml", from: "새우 알리오 올리오" },
        { name: "부침가루", qty: 60, unit: "g", from: "애호박 새우전" },
      ],
    });
    assert.strictEqual(status, 201);
    assert.strictEqual(data.shopping.length, 2);
    assert.strictEqual(data.shopping[0].from, "새우 알리오 올리오");
  });

  await test("POST /api/shopping — 같은 이름은 다시 안 담긴다", async () => {
    const { data } = await post("/api/shopping", { items: [{ name: "올리브유" }] });
    assert.strictEqual(data.shopping.length, 2);
  });

  await test("POST /api/shopping/:id/toggle", async () => {
    const list = (await get("/api/state")).data.shopping;
    const { status, data } = await post("/api/shopping/" + list[0].id + "/toggle");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.shopping.find((s) => s.id === list[0].id).done, true);
  });

  await test("POST /api/shopping/stock-up — 체크한 것만 냉장고로", async () => {
    const { status, data } = await post("/api/shopping/stock-up");
    assert.strictEqual(status, 200);
    assert.ok(find(data, "올리브유"), "냉장고에 안 들어감");
    assert.strictEqual(data.shopping.length, 1, "체크 안 한 것까지 사라짐");
    assert.strictEqual(find(data, "올리브유").category, "양념");
  });

  await test("올리브유가 생겼으니 r3 을 만들 수 있다", async () => {
    const { status, data } = await post("/api/recipes/r3/cook");
    assert.strictEqual(status, 200, JSON.stringify(data));
    assert.strictEqual(data.cooks[0].name, "새우 알리오 올리오");
  });

  await test("stock-up — 체크한 게 없으면 400", async () => {
    const { status } = await post("/api/shopping/stock-up");
    assert.strictEqual(status, 400);
  });

  await test("DELETE /api/shopping/:id", async () => {
    const list = (await get("/api/state")).data.shopping;
    const { status, data } = await del("/api/shopping/" + list[0].id);
    assert.strictEqual(status, 200);
    assert.strictEqual(data.shopping.length, 0);
  });

  await test("DELETE /api/ingredients/:id", async () => {
    const bread = find((await get("/api/state")).data, "식빵");
    const { status, data } = await del("/api/ingredients/" + bread.id);
    assert.strictEqual(status, 200);
    assert.ok(!find(data, "식빵"), "안 지워짐");
  });

  await test("POST /api/reset — 시드로 돌아가고 기록이 비워진다", async () => {
    const { status, data } = await post("/api/reset");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.ingredients.length, 23);
    assert.strictEqual(data.cooks.length, 0);
    assert.strictEqual(data.recipes.length, 10, "레시피까지 지워짐");
  });

  await test("없는 API 경로는 404 JSON", async () => {
    const { status, data } = await get("/api/nope");
    assert.strictEqual(status, 404);
    assert.ok(data.detail);
  });

  await test("GET / 는 index.html 을 준다", async () => {
    const res = await fetch(base + "/");
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("냉장고 파먹기"), "index.html 이 아님");
  });

  await test(".env 는 못 내려받는다", async () => {
    const res = await fetch(base + "/.env");
    assert.strictEqual(res.status, 403);
  });

  await test("상위 폴더로 빠져나가는 경로는 막힌다", async () => {
    const res = await fetch(base + "/../../.gitignore");
    assert.ok(res.status === 403 || res.status === 404, "상태 " + res.status);
  });

  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  server.close();
  process.exit(fail ? 1 : 0);
})();
