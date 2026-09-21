// db.js 검사 — 진짜 PostgreSQL 없이 pg-mem(인메모리 DB) 위에서 같은 SQL 을 돌린다.
//   실행: node test-db.js
// makeStore 가 query/tx 를 주입받는 구조라서 드라이버만 바꿔 끼우면 그대로 돌아간다.

const assert = require("node:assert");
const { newDb } = require("pg-mem");
const { makeStore, SEED_INGREDIENTS, SEED_RECIPES } = require("./db");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log("  ok    " + name); }
  catch (e) { fail++; console.log("  FAIL  " + name + "\n        " + e.message); }
}

function makeQuery() {
  const db = newDb();
  return async (sql, args) => db.public.query(subst(sql, args)).rows;
}

/* pg-mem 의 query() 는 파라미터 바인딩을 안 받으므로 직접 끼워 넣는다 (테스트 전용) */
function subst(sql, args) {
  if (!args || !args.length) return sql;
  return sql.replace(/\$(\d+)/g, (_, n) => lit(args[Number(n) - 1]));
}
function lit(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

(async () => {
  console.log("db.js — pg-mem 위에서 검사\n");

  const query = makeQuery();
  const store = makeStore(query);      // tx 없이 = 같은 커넥션에서 순차 실행

  await test("init: 테이블이 만들어지고 시드가 들어간다", async () => {
    await store.init();
    const ing = await store.ingredients();
    const rec = await store.recipes();
    assert.strictEqual(ing.length, SEED_INGREDIENTS.length, "재료 수가 시드와 다름");
    assert.strictEqual(rec.length, SEED_RECIPES.length, "레시피 수가 시드와 다름");
  });

  // 서버가 재시작될 때마다 init() 이 다시 도는데, 그때 시드가 또 들어가면 안 된다.
  // (init() 전체를 두 번 부르지 않는 건 pg-mem 이 이미 있는 테이블에 대한
  //  CREATE TABLE IF NOT EXISTS 를 처리 못 하기 때문. 진짜 PostgreSQL 에서는 문제없다.)
  await test("seed 를 두 번 돌려도 중복되지 않는다", async () => {
    const out = await store.seed();
    assert.strictEqual(out.seeded, false, "이미 재료가 있는데 또 시드를 넣음");
    assert.strictEqual((await store.ingredients()).length, SEED_INGREDIENTS.length);
    assert.strictEqual((await store.recipes()).length, SEED_RECIPES.length);
  });

  await test("재료는 유통기한 임박순으로 나온다", async () => {
    const ing = (await store.ingredients()).filter((i) => i.expiresAt);
    for (let i = 1; i < ing.length; i++) {
      assert.ok(ing[i - 1].expiresAt <= ing[i].expiresAt, "정렬이 어긋남");
    }
  });

  await test("레시피는 r1, r2 … r10 순서로 나온다 (문자열 정렬 아님)", async () => {
    const ids = (await store.recipes()).map((r) => r.id);
    assert.deepStrictEqual(ids.slice(0, 3), ["r1", "r2", "r3"]);
    assert.strictEqual(ids[ids.length - 1], "r10");
  });

  await test("레시피의 jsonb 칸이 배열/객체로 돌아온다", async () => {
    const r = (await store.recipes()).find((x) => x.id === "r1");
    assert.ok(Array.isArray(r.need) && r.need[0].name, "need 가 배열이 아님");
    assert.ok(Array.isArray(r.steps) && typeof r.steps[0] === "string", "steps 가 배열이 아님");
    assert.ok(Array.isArray(r.tags), "tags 가 배열이 아님");
  });

  await test("재료 추가 — 모르는 분류/단위는 기본값으로 걸러진다", async () => {
    const made = await store.addIngredient({
      name: "  식빵  ", qty: "2", unit: "장", category: "없는분류", storage: "냉장", expiresAt: "",
    });
    assert.strictEqual(made.name, "식빵", "이름 공백이 안 다듬어짐");
    assert.strictEqual(made.emoji, "🍞", "사전에서 이모지를 못 가져옴");
    assert.strictEqual(made.category, "곡물·면", "사전 분류가 안 쓰임");
    assert.strictEqual(made.qty, 2);
    assert.strictEqual(made.expiresAt, "", "빈 유통기한이 null 로 안 들어감");
  });

  await test("재료 추가 — 이름이 비면 400", async () => {
    await assert.rejects(() => store.addIngredient({ name: "   " }), /비어 있습니다/);
  });

  await test("유통기한 형식이 틀리면 400", async () => {
    await assert.rejects(() => store.addIngredient({ name: "우엉", expiresAt: "2026/01/01" }), /YYYY-MM-DD/);
  });

  await test("수정 — 바꾼 칸만 바뀐다", async () => {
    const before = (await store.ingredients()).find((i) => i.name === "식빵");
    const after = await store.updateIngredient(before.id, { qty: 5 });
    assert.strictEqual(after.qty, 5);
    assert.strictEqual(after.unit, before.unit, "안 보낸 칸이 바뀜");
  });

  await test("수정 — 없는 재료면 404", async () => {
    await assert.rejects(() => store.updateIngredient(999999, { qty: 1 }), /없습니다/);
  });

  await test("수량 +/- — 0 밑으로 안 내려간다", async () => {
    const x = (await store.ingredients()).find((i) => i.name === "식빵");
    await store.bumpIngredient(x.id, -100);
    const after = (await store.ingredients()).find((i) => i.id === x.id);
    assert.strictEqual(after.qty, 0);
  });

  await test("삭제", async () => {
    const x = (await store.ingredients()).find((i) => i.name === "식빵");
    const name = await store.removeIngredient(x.id);
    assert.strictEqual(name, "식빵");
    assert.ok(!(await store.ingredients()).some((i) => i.name === "식빵"));
  });

  /* ---- 요리 ---- */

  await test("요리 완료 — 쓴 만큼 깎이고 기록이 남는다", async () => {
    const before = await store.ingredients();
    const kimchiBefore = before.find((i) => i.name === "김치").qty;
    const riceBefore = before.find((i) => i.name === "밥").qty;

    const out = await store.cook("r1");           // 김치볶음밥: 밥 1컵, 김치 120g, 대파 0.5묶음, 달걀 1개, 참기름 5ml
    assert.strictEqual(out.recipe, "김치볶음밥");

    const after = await store.ingredients();
    assert.strictEqual(after.find((i) => i.name === "김치").qty, kimchiBefore - 120);
    assert.strictEqual(after.find((i) => i.name === "밥").qty, riceBefore - 1);

    const log = await store.cooks();
    assert.strictEqual(log[0].name, "김치볶음밥");
    assert.ok(log[0].used.some((u) => u.name === "김치" && u.qty === 120), "사용 재료 기록이 없음");
  });

  await test("요리 완료 — 재료가 모자라면 409 이고 아무것도 안 깎인다", async () => {
    const before = await store.ingredients();
    // r8 치즈 계란토스트는 식빵이 없다 (위에서 지웠음)
    await assert.rejects(() => store.cook("r8"), /부족합니다/);
    const after = await store.ingredients();
    assert.deepStrictEqual(after.map((i) => i.name + i.qty), before.map((i) => i.name + i.qty), "실패했는데 재료가 바뀜");
  });

  await test("요리 완료 — 없는 레시피면 404", async () => {
    await assert.rejects(() => store.cook("nope"), /없습니다/);
  });

  await test("요리로 다 쓴 재료는 냉장고에서 빠진다", async () => {
    const banana = (await store.ingredients()).find((i) => i.name === "바나나");
    assert.ok(banana, "바나나가 있어야 함");
    await store.cook("r9");                        // 바나나 2개 + 우유 200ml → 바나나는 딱 2개뿐
    assert.ok(!(await store.ingredients()).some((i) => i.name === "바나나"), "다 쓴 바나나가 남아 있음");
  });

  /* ---- 장보기 ---- */

  await test("장보기 담기 — 같은 이름은 한 번만", async () => {
    const n1 = await store.addShopping([{ name: "식빵", qty: 2, unit: "장", from: "치즈 계란토스트" }]);
    const n2 = await store.addShopping([{ name: "식빵", qty: 2, unit: "장" }]);
    assert.strictEqual(n1, 1);
    assert.strictEqual(n2, 0, "중복으로 또 담김");
    const list = await store.shopping();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].emoji, "🍞", "장보기 항목에 이모지가 안 붙음");
    assert.strictEqual(list[0].from, "치즈 계란토스트");
  });

  await test("체크 토글", async () => {
    const [item] = await store.shopping();
    const after = await store.toggleShopping(item.id);
    assert.strictEqual(after.done, true);
  });

  await test("체크한 것 냉장고로 옮기기 — 장바구니에서는 사라진다", async () => {
    const n = await store.stockUp();
    assert.strictEqual(n, 1);
    assert.strictEqual((await store.shopping()).length, 0, "장바구니가 안 비워짐");
    const bread = (await store.ingredients()).find((i) => i.name === "식빵");
    assert.ok(bread, "냉장고에 안 들어감");
    assert.strictEqual(bread.qty, 2);
    assert.strictEqual(bread.category, "곡물·면");
  });

  await test("옮긴 뒤에는 그 레시피를 만들 수 있다", async () => {
    const out = await store.cook("r8");            // 식빵이 생겼으니 치즈 계란토스트 가능
    assert.strictEqual(out.recipe, "치즈 계란토스트");
  });

  await test("체크한 게 없으면 stockUp 은 400", async () => {
    await assert.rejects(() => store.stockUp(), /체크한 항목이 없습니다/);
  });

  await test("체크 항목 비우기", async () => {
    await store.addShopping([{ name: "부침가루" }, { name: "올리브유" }]);
    const list = await store.shopping();
    await store.toggleShopping(list[0].id);
    const removed = await store.clearDoneShopping();
    assert.strictEqual(removed, 1);
    assert.strictEqual((await store.shopping()).length, 1);
  });

  /* ---- 초기화 ---- */

  await test("초기화 — 재료는 시드로, 장보기/기록은 비워진다", async () => {
    const n = await store.reset();
    assert.strictEqual(n, SEED_INGREDIENTS.length);
    assert.strictEqual((await store.ingredients()).length, SEED_INGREDIENTS.length);
    assert.strictEqual((await store.shopping()).length, 0);
    assert.strictEqual((await store.cooks()).length, 0);
    assert.strictEqual((await store.recipes()).length, SEED_RECIPES.length, "레시피까지 지워짐");
  });

  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
