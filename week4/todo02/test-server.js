// server.js 통합 검증 — 진짜 DB 없이 HTTP 왕복을 그대로 돌린다.
// require('pg') 를 pg-mem 의 어댑터로 바꿔치기해서, 라우팅 · JSON · 오류 처리까지 실제로 확인한다.
//   실행: npm run test:api
const Module = require("node:module");
const { newDb } = require("pg-mem");

const mem = newDb();
const memPg = mem.adapters.createPg();

const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "pg") return memPg;                      // ← 여기만 갈아끼운다
  return realRequire.apply(this, arguments);
};

const PORT = 8790;
process.env.DATABASE_URL = "postgresql://tester:secret@localhost:5432/todo02_test";
process.env.PORT = String(PORT);
process.env.PGSSL = "off";

const BASE = "http://localhost:" + PORT;
let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log("  ✔ " + label); }
  else { fail++; console.log("  ✘ " + label + (extra ? " — " + extra : "")); }
};
const get = async (p, init) => {
  const res = await fetch(BASE + p, init);
  let body = null;
  const type = res.headers.get("content-type") || "";
  body = type.includes("json") ? await res.json().catch(() => null) : await res.text();
  return { status: res.status, body };
};
const post = (p, obj) => get(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj || {}) });
const patch = (p, obj) => get(p, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
const del = (p) => get(p, { method: "DELETE" });

require("./server.js");

setTimeout(async () => {
  console.log("todo02 server.js 통합 검증 (pg-mem 을 pg 자리에 끼움)\n");
  try {
    const h = await get("/api/health");
    check("GET /api/health 연결됨", h.status === 200 && h.body.connected === true, JSON.stringify(h.body));
    check("비밀번호는 응답에 없음", !JSON.stringify(h.body).includes("secret"));
    check("호스트/DB 이름만 노출", h.body.db && h.body.db.database === "todo02_test", JSON.stringify(h.body.db));

    const c1 = await post("/api/todos", { text: "목요일까지 과제 제출", priority: "높음" });
    check("POST /api/todos 201", c1.status === 201 && c1.body.created.priority === "높음", JSON.stringify(c1.body.created));
    const c2 = await post("/api/todos", { text: "우유 사기" });
    check("두 번째 추가", c2.status === 201);
    check("통계 갱신", c2.body.stats.total === 2, JSON.stringify(c2.body.stats));

    const empty = await post("/api/todos", { text: "   " });
    check("빈 내용 400", empty.status === 400, "status " + empty.status);

    const id = c1.body.created.id;
    const done = await patch("/api/todos/" + id, { done: true });
    check("PATCH 완료 처리", done.status === 200 && done.body.updated.done === true);
    check("완료 시각 기록", !!done.body.updated.doneAt, done.body.updated.doneAt);
    check("완료 통계", done.body.stats.done === 1, JSON.stringify(done.body.stats));

    const ed = await patch("/api/todos/" + id, { text: "과제 제출하기", priority: "낮음" });
    check("PATCH 내용/우선순위 수정", ed.body.updated.text === "과제 제출하기" && ed.body.updated.priority === "낮음");

    const missing = await patch("/api/todos/999999", { done: true });
    check("없는 id PATCH 404", missing.status === 404, "status " + missing.status);
    const missingDel = await del("/api/todos/999999");
    check("없는 id DELETE 404", missingDel.status === 404, "status " + missingDel.status);

    const search = await get("/api/todos?q=" + encodeURIComponent("우유"));
    check("검색 질의", search.body.todos.length === 1 && search.body.todos[0].text === "우유 사기", JSON.stringify(search.body.todos.map(t => t.text)));
    const noHit = await get("/api/todos?q=" + encodeURIComponent("없는말"));
    check("검색 결과 0건", noHit.body.todos.length === 0);

    const inject = await get("/api/todos?q=" + encodeURIComponent("'; DROP TABLE todos; --"));
    check("작은따옴표 검색어도 그냥 문자열로 처리", inject.status === 200 && inject.body.todos.length === 0, "status " + inject.status);
    const still = await get("/api/todos");
    check("테이블 그대로 살아 있음", still.body.todos.length === 2, JSON.stringify(still.body.stats));

    const cleared = await post("/api/todos/clear-done");
    check("완료 일괄 삭제", cleared.status === 200 && cleared.body.removed === 1, JSON.stringify(cleared.body.removed));
    check("남은 1건", cleared.body.todos.length === 1);

    const gone = await del("/api/todos/" + c2.body.created.id);
    check("DELETE 한 건", gone.status === 200 && gone.body.todos.length === 0);

    const page = await get("/");
    check("GET / 정적 페이지", page.status === 200 && String(page.body).includes("todo02"));
    const envFile = await get("/.env");
    check("GET /.env 차단(403)", envFile.status === 403, "status " + envFile.status);
    const nope = await get("/api/없는것");
    check("없는 API 404", nope.status === 404);

    console.log(`\n통과 ${pass} · 실패 ${fail}`);
  } catch (e) {
    console.error("\n테스트 중 예외:", e);
    fail++;
  }
  process.exit(fail ? 1 : 0);
}, 700);
