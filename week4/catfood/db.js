// 하루한끼 캣푸드 — 문의 데이터 계층.
// query 함수를 주입받으므로 진짜 PostgreSQL(pg) 로도, 테스트용 pg-mem 으로도 똑같이 돌아간다.
// 값은 전부 $1, $2 … 파라미터로 넘긴다 (문자열을 SQL 에 이어 붙이지 않는다).

const TOPICS = ["상품 문의", "배송 문의", "교환·환불", "대량 구매", "기타"];
const STATUSES = ["접수", "처리중", "답변완료"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inquiries (
  id          bigserial   PRIMARY KEY,
  name        text        NOT NULL,
  email       text        NOT NULL,
  phone       text,
  topic       text        NOT NULL DEFAULT '상품 문의',
  option_name text,
  message     text        NOT NULL,
  agreed      boolean     NOT NULL DEFAULT false,
  status      text        NOT NULL DEFAULT '접수',
  created_at  timestamptz NOT NULL DEFAULT now()
)`;

const INDEX = `CREATE INDEX IF NOT EXISTS inquiries_created_idx ON inquiries (created_at)`;

const COLS = `id, name, email, phone, topic, option_name, message, agreed, status, created_at`;

function stamp(v) {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const clean = (s, max) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, max || 200);
const cleanLong = (s, max) => String(s == null ? "" : s).replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim().slice(0, max || 2000);

/* 접수번호는 사람이 부르기 좋게 — 2026-0917-0007 */
function ticket(id, created) {
  const d = created instanceof Date ? created : new Date(created || Date.now());
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}${p(d.getDate())}-${String(id).padStart(4, "0")}`;
}

/* 목록에 남의 이메일·전화번호를 그대로 보여주지 않는다 */
const maskEmail = (e) => {
  const [head, host] = String(e).split("@");
  if (!host) return "***";
  const shown = head.slice(0, 2);
  return shown + "*".repeat(Math.max(1, head.length - 2)) + "@" + host;
};
const maskName = (n) => (n.length <= 1 ? n : n[0] + "*".repeat(n.length - 1));

const toRow = (r) => ({
  id: String(r.id),
  ticket: ticket(r.id, r.created_at),
  name: r.name,
  email: r.email,
  phone: r.phone || "",
  topic: r.topic,
  option: r.option_name || "",
  message: r.message,
  status: r.status,
  created: stamp(r.created_at),
});
const toPublic = (r) => ({
  ticket: ticket(r.id, r.created_at),
  name: maskName(r.name),
  email: maskEmail(r.email),
  topic: r.topic,
  status: r.status,
  created: stamp(r.created_at),
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* 서버가 받은 값을 검사하고 저장할 모양으로 다듬는다 */
function validate(input) {
  const name = clean(input.name, 50);
  const email = clean(input.email, 120).toLowerCase();
  const phone = clean(input.phone, 30);
  const topic = TOPICS.includes(input.topic) ? input.topic : TOPICS[0];
  const option = clean(input.option, 60);
  const message = cleanLong(input.message, 2000);

  const errors = {};
  if (name.length < 1) errors.name = "이름을 적어주세요.";
  if (!EMAIL_RE.test(email)) errors.email = "이메일 형식이 올바르지 않습니다.";
  if (phone && !/^[0-9+\-() ]{7,30}$/.test(phone)) errors.phone = "연락처는 숫자와 - ( ) + 만 쓸 수 있습니다.";
  if (message.length < 5) errors.message = "문의 내용을 5자 이상 적어주세요.";
  if (input.agreed !== true) errors.agreed = "개인정보 수집·이용에 동의해주세요.";

  return { value: { name, email, phone, topic, option, message, agreed: true }, errors };
}

function makeStore(query) {
  return {
    async init() {
      await query(SCHEMA);
      await query(INDEX);
    },

    async create(input) {
      const { value, errors } = validate(input);
      if (Object.keys(errors).length) {
        throw Object.assign(new Error("입력을 다시 확인해주세요."), { status: 400, errors });
      }
      const rows = await query(
        `INSERT INTO inquiries (name, email, phone, topic, option_name, message, agreed)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLS}`,
        [value.name, value.email, value.phone || null, value.topic, value.option || null, value.message, true]
      );
      return toRow(rows[0]);
    },

    /* 관리자용 — 전체 내용을 그대로 준다 */
    async list(limit) {
      const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const rows = await query(`SELECT ${COLS} FROM inquiries ORDER BY created_at DESC, id DESC LIMIT $1`, [n]);
      return rows.map(toRow);
    },

    /* 상품 페이지에 거는 목록 — 이름·이메일을 가린다 */
    async recentPublic(limit) {
      const n = Math.min(Math.max(Number(limit) || 5, 1), 20);
      const rows = await query(`SELECT ${COLS} FROM inquiries ORDER BY created_at DESC, id DESC LIMIT $1`, [n]);
      return rows.map(toPublic);
    },

    async setStatus(id, status) {
      if (!STATUSES.includes(status)) {
        throw Object.assign(new Error("그런 상태값은 없습니다."), { status: 400 });
      }
      const rows = await query(`UPDATE inquiries SET status = $1 WHERE id = $2 RETURNING ${COLS}`, [status, id]);
      if (!rows.length) throw Object.assign(new Error("그런 문의가 없습니다."), { status: 404 });
      return toRow(rows[0]);
    },

    async stats() {
      const rows = await query(
        `SELECT count(*)::int AS total,
                coalesce(sum(CASE WHEN status = '답변완료' THEN 1 ELSE 0 END), 0)::int AS answered
           FROM inquiries`
      );
      const r = rows[0] || { total: 0, answered: 0 };
      return { total: Number(r.total) || 0, answered: Number(r.answered) || 0 };
    },
  };
}

module.exports = { TOPICS, STATUSES, SCHEMA, INDEX, makeStore, validate, ticket, maskEmail, maskName, stamp };
