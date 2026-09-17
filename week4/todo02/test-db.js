// db.js 검증 — 진짜 DB 없이도 쿼리가 도는지 확인한다.
// pg-mem(인메모리 PostgreSQL)에 같은 SQL 을 그대로 실행한다.
//   실행: npm test
const { newDb } = require("pg-mem");
const { makeStore } = require("./db");

// pg 어댑터를 쓰면 server.js 와 똑같이 Pool.query(sql, [$1, $2 …]) 경로를 탄다
const mem = newDb();
const { Pool } = mem.adapters.createPg();
const pool = new Pool();
const store = makeStore(async (sql, args) => (await pool.query(sql, args)).rows);

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ✔ " + label); }
  else { fail++; console.log("  ✘ " + label + (extra ? " — " + extra : "")); }
}

(async () => {
  console.log("todo02 db.js 검증 (pg-mem)\n");

  await store.init();
  check("스키마 생성", true);

  const a = await store.add("목요일까지 과제 제출", "높음");
  const b = await store.add("우유 사기");
  check("추가 2건", a.id && b.id, "id=" + a.id + "," + b.id);
  check("우선순위 지정", a.priority === "높음");
  check("우선순위 기본값", b.priority === "보통");
  check("생성 시각 형식", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(a.created), a.created);
  check("잘못된 우선순위는 보통으로", (await store.add("테스트", "아무거나")).priority === "보통");

  const list = await store.list();
  check("목록 3건", list.length === 3, "실제 " + list.length);
  check("생성순 정렬", list[0].id === a.id);

  const done = await store.update(a.id, { done: true });
  check("완료 처리", done.done === true);
  check("완료 시각 기록", !!done.doneAt, done.doneAt);
  const undone = await store.update(a.id, { done: false });
  check("완료 취소 시 완료시각 비움", undone.done === false && undone.doneAt === "");

  const edited = await store.update(b.id, { text: "  우유   두 개  사기 ", priority: "낮음" });
  check("내용 수정 + 공백 정리", edited.text === "우유 두 개 사기", edited.text);
  check("우선순위 수정", edited.priority === "낮음");

  check("빈 내용 거부", await rejects(() => store.add("   ")));
  check("없는 id 수정 거부", await rejects(() => store.update(999999, { done: true })));
  check("없는 id 삭제 거부", await rejects(() => store.remove(999999)));

  const found = await store.list("우유");
  check("검색(ILIKE)", found.length === 1 && found[0].id === b.id, "결과 " + found.length + "건");
  check("검색 결과 없음", (await store.list("없는말")).length === 0);

  await store.update(a.id, { done: true });
  const stats = await store.stats();
  check("통계", stats.total === 3 && stats.done === 1, JSON.stringify(stats));

  const removed = await store.clearDone();
  check("완료 일괄 삭제", removed === 1, "삭제 " + removed + "건");
  check("삭제 후 남은 건수", (await store.list()).length === 2);

  await store.remove(b.id);
  check("한 건 삭제", (await store.list()).length === 1);

  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\n테스트 중 예외:", e);
  process.exit(1);
});

async function rejects(fn) {
  try { await fn(); return false; } catch { return true; }
}
