// todo02 데이터 계층 — 스키마와 쿼리만 모아 둔다.
// query 함수를 주입받으므로 진짜 PostgreSQL(pg) 로도, 테스트용 pg-mem 으로도 똑같이 돌아간다.
// 값은 전부 $1, $2 … 파라미터로 넘긴다 (문자열을 SQL 에 이어 붙이지 않는다).

const PRIORITIES = ["높음", "보통", "낮음"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS todos (
  id          bigserial   PRIMARY KEY,
  text        text        NOT NULL,
  priority    text        NOT NULL DEFAULT '보통',
  done        boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  done_at     timestamptz
)`;

const INDEX = `CREATE INDEX IF NOT EXISTS todos_created_idx ON todos (created_at)`;

const COLS = `id, text, priority, done, created_at, done_at`;

/* 화면이 쓰기 좋은 모양으로 — 시각은 "2026-09-17 14:30" 문자열로 내려보낸다 */
function stamp(v) {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const toTodo = (r) => ({
  id: String(r.id),
  text: r.text,
  priority: r.priority,
  done: r.done === true || r.done === "t",
  created: stamp(r.created_at),
  doneAt: stamp(r.done_at),
});

const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, 500);

function makeStore(query) {
  return {
    async init() {
      await query(SCHEMA);
      await query(INDEX);
    },

    async list(search) {
      const q = clean(search || "");
      const rows = q
        ? await query(
            `SELECT ${COLS} FROM todos WHERE text ILIKE '%' || $1 || '%' ORDER BY created_at, id`,
            [q]
          )
        : await query(`SELECT ${COLS} FROM todos ORDER BY created_at, id`);
      return rows.map(toTodo);
    },

    async add(text, priority) {
      const t = clean(text);
      if (!t) throw Object.assign(new Error("할 일 내용이 비어 있습니다."), { status: 400 });
      const p = PRIORITIES.includes(priority) ? priority : "보통";
      const rows = await query(
        `INSERT INTO todos (text, priority) VALUES ($1, $2) RETURNING ${COLS}`,
        [t, p]
      );
      return toTodo(rows[0]);
    },

    /* 바꿀 칸만 골라 SET 절을 만든다. 칸 이름은 코드에 적힌 것만 쓰이고 값은 전부 파라미터. */
    async update(id, patch) {
      const sets = [];
      const args = [];
      if (typeof patch.done === "boolean") {
        args.push(patch.done);
        sets.push(`done = $${args.length}`);
        sets.push(patch.done ? `done_at = now()` : `done_at = NULL`);
      }
      if (typeof patch.text === "string") {
        const t = clean(patch.text);
        if (!t) throw Object.assign(new Error("할 일 내용이 비어 있습니다."), { status: 400 });
        args.push(t);
        sets.push(`text = $${args.length}`);
      }
      if (PRIORITIES.includes(patch.priority)) {
        args.push(patch.priority);
        sets.push(`priority = $${args.length}`);
      }
      if (!sets.length) throw Object.assign(new Error("바꿀 내용이 없습니다."), { status: 400 });

      args.push(id);
      const rows = await query(
        `UPDATE todos SET ${sets.join(", ")} WHERE id = $${args.length} RETURNING ${COLS}`,
        args
      );
      if (!rows.length) throw Object.assign(new Error("그런 할 일이 없습니다."), { status: 404 });
      return toTodo(rows[0]);
    },

    async remove(id) {
      const rows = await query(`DELETE FROM todos WHERE id = $1 RETURNING id`, [id]);
      if (!rows.length) throw Object.assign(new Error("그런 할 일이 없습니다."), { status: 404 });
      return true;
    },

    async clearDone() {
      const rows = await query(`DELETE FROM todos WHERE done = true RETURNING id`);
      return rows.length;
    },

    async stats() {
      // count(*) FILTER (WHERE done) 대신 CASE 합계 — 표준 문법이라 어디서나 같은 값이 나온다
      const rows = await query(
        `SELECT count(*)::int AS total,
                coalesce(sum(CASE WHEN done THEN 1 ELSE 0 END), 0)::int AS done
           FROM todos`
      );
      const r = rows[0] || { total: 0, done: 0 };
      return { total: Number(r.total) || 0, done: Number(r.done) || 0 };
    },
  };
}

module.exports = { PRIORITIES, SCHEMA, INDEX, makeStore, toTodo, stamp, clean };
