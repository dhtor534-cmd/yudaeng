// 로그인 인증 — 비밀번호 해싱과 JWT 발급/검증.
// 라이브러리 없이 Node 내장 crypto 만 쓴다 (bcrypt, jsonwebtoken 안 씀).
//
// 비밀번호: scrypt + 계정마다 다른 소금(salt). 원본은 어디에도 저장하지 않는다.
// 토큰:     HS256 JWT. 서명 키(JWT_SECRET)는 서버에만 있고 브라우저로 안 나간다.
//
// ⚠ JWT 는 "내용이 안 보이는 것" 이 아니라 "위조가 안 되는 것" 이다.
//   payload 는 누구나 디코드해서 읽을 수 있으므로 비밀번호 같은 건 절대 넣지 않는다.

const crypto = require("node:crypto");

const bad = (msg, status) => Object.assign(new Error(msg), { status: status || 400 });

/* =========================================================
   1. 비밀번호
   ========================================================= */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const scrypt = (password, salt) =>
  new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (e, key) =>
      e ? reject(e) : resolve(key)
    );
  });

/** 저장 형태: scrypt$<소금>$<해시>  — 나중에 알고리즘을 바꿔도 구분할 수 있게 앞에 이름을 붙인다 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await scrypt(password, salt);
  return `scrypt$${salt}$${key.toString("hex")}`;
}

/** 길이가 달라도 시간차로 정보가 새지 않게 timingSafeEqual 을 쓴다 */
async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hex] = parts;
  let expected;
  try { expected = Buffer.from(hex, "hex"); } catch { return false; }
  const actual = await scrypt(password, salt);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

/* =========================================================
   2. JWT (HS256)
   ========================================================= */

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const unb64url = (s) => Buffer.from(s, "base64url");

const DEFAULT_TTL = 60 * 60 * 24 * 14;   // 2주

function sign(payload, secret, ttlSeconds = DEFAULT_TTL) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const data = head + "." + b64url(JSON.stringify(body));
  const mac = crypto.createHmac("sha256", secret).update(data).digest();
  return data + "." + b64url(mac);
}

/** 서명이 맞고 아직 안 지난 토큰이면 payload 를, 아니면 null 을 준다 (던지지 않는다) */
function verify(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const data = parts[0] + "." + parts[1];

  const expected = crypto.createHmac("sha256", secret).update(data).digest();
  let got;
  try { got = unb64url(parts[2]); } catch { return null; }
  if (got.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(got, expected)) return null;

  let body;
  try { body = JSON.parse(unb64url(parts[1]).toString("utf8")); } catch { return null; }
  if (typeof body.exp !== "number" || body.exp < Math.floor(Date.now() / 1000)) return null;
  return body;
}

/* =========================================================
   3. 입력 검사
   ========================================================= */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cleanEmail(v) {
  const email = String(v == null ? "" : v).trim().toLowerCase();
  if (!email) throw bad("이메일을 입력해 주세요.");
  if (email.length > 120 || !EMAIL.test(email)) throw bad("이메일 형식이 올바르지 않습니다.");
  return email;
}

function checkPassword(v) {
  const pw = String(v == null ? "" : v);
  if (pw.length < 8) throw bad("비밀번호는 8자 이상이어야 합니다.");
  if (pw.length > 200) throw bad("비밀번호가 너무 깁니다.");
  return pw;
}

function cleanName(v, email) {
  const name = String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, 20);
  return name || (email ? email.split("@")[0].slice(0, 20) : "사용자");
}

/* =========================================================
   4. 서명 키
   ========================================================= */

/**
 * JWT_SECRET 이 없으면 임시 키를 만들어 쓴다.
 * 서버가 다시 뜨면 키가 바뀌므로 그 전에 발급한 토큰은 무효가 된다 (다시 로그인해야 함).
 * 그래서 진짜로 쓸 때는 반드시 환경변수로 넣어야 한다.
 */
function getSecret(env = process.env) {
  const s = (env.JWT_SECRET || "").trim();
  if (s) return { secret: s, temporary: false };
  if (!getSecret._tmp) getSecret._tmp = crypto.randomBytes(32).toString("hex");
  return { secret: getSecret._tmp, temporary: true };
}

/** Authorization: Bearer <토큰> 에서 토큰만 꺼낸다 */
function bearer(req) {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1].trim() : "";
}

module.exports = {
  hashPassword, verifyPassword,
  sign, verify, getSecret, bearer,
  cleanEmail, checkPassword, cleanName,
  DEFAULT_TTL,
};
