// 인증 앱 데이터 계층 — 스키마와 쿼리만 모아 둔다.
// query / tx 를 주입받으므로 진짜 PostgreSQL(pg) 로도, 테스트용 pg-mem 으로도 똑같이 돌아간다.
// 값은 전부 $1, $2 … 파라미터로 넘긴다 (문자열을 SQL 에 이어 붙이지 않는다).
//
// 테이블은 둘뿐이다.
//   auth_users     계정. 비밀번호는 원문이 아니라 scrypt 해시만 들어간다.
//   auth_sessions  살아 있는 리프레시 토큰. 로그아웃 = 여기서 한 줄 지우기.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS auth_users (
     id            bigserial   PRIMARY KEY,
     email         text        NOT NULL UNIQUE,
     nickname      text        NOT NULL DEFAULT '',
     password_hash text        NOT NULL,
     created_at    timestamptz NOT NULL DEFAULT now(),
     last_login_at timestamptz
   )`,

  `CREATE TABLE IF NOT EXISTS auth_sessions (
     id           bigserial   PRIMARY KEY,
     user_id      bigint      NOT NULL,
     token_hash   text        NOT NULL UNIQUE,
     user_agent   text        NOT NULL DEFAULT '',
     ip           text        NOT NULL DEFAULT '',
     created_at   timestamptz NOT NULL DEFAULT now(),
     last_used_at timestamptz NOT NULL DEFAULT now(),
     expires_at   timestamptz NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id)`,
  `CREATE INDEX IF NOT EXISTS auth_sessions_exp_idx ON auth_sessions (expires_at)`,
];

/* =========================================================
   행 -> 화면 모양
   ========================================================= */

const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);

/** 비밀번호 해시는 절대 이 함수를 통과하지 못한다 — 화면으로 내려가는 사용자 모양은 여기 하나뿐이다. */
const toUser = (r) => r && {
  id: Number(r.id),
  email: r.email,
  nickname: r.nickname || "",
  createdAt: iso(r.created_at),
  lastLoginAt: iso(r.last_login_at),
};

const toSession = (r) => ({
  id: Number(r.id),
  userAgent: r.user_agent || "",
  ip: r.ip || "",
  createdAt: iso(r.created_at),
  lastUsedAt: iso(r.last_used_at),
  expiresAt: iso(r.expires_at),
});

const USER_COLS = `id, email, nickname, created_at, last_login_at`;

/* =========================================================
   입력 다듬기 + 규칙
   =========================================================
   규칙은 서버가 정한다. 화면에서도 같은 걸 검사하지만 그건 친절일 뿐,
   진짜 검사는 여기서 한다 (브라우저는 언제든 우회할 수 있다). */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const cleanEmail = (v) => String(v ?? "").trim().toLowerCase();

/** 규칙에 걸리면 사람이 읽을 수 있는 문장을 돌려준다. 통과면 null. */
function checkEmail(email) {
  if (!email) return "이메일을 입력해 주세요.";
  if (email.length > 254) return "이메일이 너무 깁니다.";
  if (!EMAIL_RE.test(email)) return "이메일 형식이 아닙니다.";
  return null;
}

function checkPassword(password) {
  const p = String(password ?? "");
  if (!p) return "비밀번호를 입력해 주세요.";
  if (p.length < 8) return "비밀번호는 8자 이상이어야 합니다.";
  if (p.length > 200) return "비밀번호가 너무 깁니다.";
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return "비밀번호에 영문과 숫자를 모두 넣어 주세요.";
  return null;
}

function cleanNickname(v, email) {
  const n = String(v ?? "").trim().replace(/\s+/g, " ");
  if (n) return n.slice(0, 20);
  return email ? email.split("@")[0].slice(0, 20) : "";   // 안 적으면 이메일 앞부분
}

/* =========================================================
   스토어
   ========================================================= */

const UNIQUE_VIOLATION = "23505";

function makeStore(query, tx) {
  return {
    async init() {
      for (const sql of SCHEMA) await query(sql);
    },

    async countUsers() {
      const [row] = await query(`SELECT count(*) AS n FROM auth_users`);
      return Number(row.n);
    },

    /** 가입. 이메일이 이미 있으면 409 로 돌려준다. */
    async createUser({ email, nickname, passwordHash }) {
      try {
        const rows = await query(
          `INSERT INTO auth_users (email, nickname, password_hash)
           VALUES ($1, $2, $3) RETURNING ${USER_COLS}`,
          [email, nickname, passwordHash]
        );
        return toUser(rows[0]);
      } catch (e) {
        if (e.code === UNIQUE_VIOLATION || /unique|duplicate/i.test(e.message || "")) {
          throw Object.assign(new Error("이미 가입된 이메일입니다."), { status: 409 });
        }
        throw e;
      }
    },

    /** 로그인 검사용 — 이것만 password_hash 를 같이 돌려준다. 다른 데서 쓰지 말 것. */
    async findForLogin(email) {
      const rows = await query(
        `SELECT ${USER_COLS}, password_hash FROM auth_users WHERE email = $1`, [email]
      );
      if (!rows[0]) return null;
      return { user: toUser(rows[0]), passwordHash: rows[0].password_hash };
    },

    async findById(id) {
      const rows = await query(`SELECT ${USER_COLS} FROM auth_users WHERE id = $1`, [id]);
      return rows[0] ? toUser(rows[0]) : null;
    },

    async passwordHashOf(id) {
      const rows = await query(`SELECT password_hash FROM auth_users WHERE id = $1`, [id]);
      return rows[0] ? rows[0].password_hash : null;
    },

    async touchLogin(id) {
      await query(`UPDATE auth_users SET last_login_at = now() WHERE id = $1`, [id]);
    },

    async updateNickname(id, nickname) {
      const rows = await query(
        `UPDATE auth_users SET nickname = $2 WHERE id = $1 RETURNING ${USER_COLS}`, [id, nickname]
      );
      return rows[0] ? toUser(rows[0]) : null;
    },

    /** 비밀번호를 바꾸면 다른 기기의 세션을 끊는다 (바뀐 줄 모르는 기기가 남으면 안 된다). */
    async updatePassword(id, passwordHash, { keepTokenHash } = {}) {
      return tx(async (q) => {
        await q(`UPDATE auth_users SET password_hash = $2 WHERE id = $1`, [id, passwordHash]);
        if (keepTokenHash) {
          await q(`DELETE FROM auth_sessions WHERE user_id = $1 AND token_hash <> $2`, [id, keepTokenHash]);
        } else {
          await q(`DELETE FROM auth_sessions WHERE user_id = $1`, [id]);
        }
      });
    },

    /* ----- 세션 (리프레시 토큰) ----- */

    async createSession({ userId, tokenHash, expiresAt, userAgent, ip }) {
      const rows = await query(
        `INSERT INTO auth_sessions (user_id, token_hash, user_agent, ip, expires_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [userId, tokenHash, String(userAgent || "").slice(0, 200), String(ip || "").slice(0, 60), expiresAt]
      );
      return Number(rows[0].id);
    },

    /** 토큰 해시로 살아 있는 세션 + 주인을 찾는다. 만료된 줄은 없는 것으로 친다. */
    async findSession(tokenHash, now = new Date()) {
      const rows = await query(
        `SELECT s.id AS sid, s.expires_at,
                u.id, u.email, u.nickname, u.created_at, u.last_login_at
           FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.expires_at > $2`,
        [tokenHash, now]
      );
      if (!rows[0]) return null;
      return { sessionId: Number(rows[0].sid), user: toUser(rows[0]) };
    },

    /**
     * 토큰 회전 — 쓴 토큰은 버리고 새 토큰으로 갈아끼운다.
     * 한 번 쓴 리프레시 토큰이 계속 통하면, 새어 나갔을 때 계속 쓰인다.
     */
    async rotateSession(sessionId, nextTokenHash, expiresAt) {
      await query(
        `UPDATE auth_sessions SET token_hash = $2, expires_at = $3, last_used_at = now() WHERE id = $1`,
        [sessionId, nextTokenHash, expiresAt]
      );
    },

    async deleteSession(tokenHash) {
      const rows = await query(`DELETE FROM auth_sessions WHERE token_hash = $1 RETURNING id`, [tokenHash]);
      return rows.length;
    },

    async deleteSessionById(userId, sessionId) {
      const rows = await query(
        `DELETE FROM auth_sessions WHERE id = $1 AND user_id = $2 RETURNING id`, [sessionId, userId]
      );
      return rows.length;
    },

    async deleteAllSessions(userId) {
      const rows = await query(`DELETE FROM auth_sessions WHERE user_id = $1 RETURNING id`, [userId]);
      return rows.length;
    },

    async listSessions(userId, now = new Date()) {
      const rows = await query(
        `SELECT id, user_agent, ip, created_at, last_used_at, expires_at
           FROM auth_sessions WHERE user_id = $1 AND expires_at > $2
          ORDER BY last_used_at DESC`,
        [userId, now]
      );
      return rows.map(toSession);
    },

    /** 만료된 세션 줄 청소 — 로그인할 때 가끔 부른다. */
    async sweepSessions(now = new Date()) {
      const rows = await query(`DELETE FROM auth_sessions WHERE expires_at <= $1 RETURNING id`, [now]);
      return rows.length;
    },
  };
}

module.exports = { SCHEMA, makeStore, toUser, cleanEmail, cleanNickname, checkEmail, checkPassword };
