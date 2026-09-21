// week5 auth — 요청 처리 본체 (전송 계층과 분리)
//
// 로컬(server.js) 과 Vercel 서버리스 함수(api/index.js) 가 이 파일을 같이 쓴다.
// 순수 Node 의 req/res 만 쓰므로 양쪽에서 똑같이 동작한다.
//
// ── 토큰 두 개를 쓰는 이유 ────────────────────────────────
//   액세스 토큰 (JWT, 15분)   : 요청마다 Authorization 헤더에 실어 보낸다.
//                              서버가 서명만 확인하면 되니 DB 를 안 봐도 된다. 대신 취소가 안 된다 →
//                              그래서 수명을 짧게 준다.
//   리프레시 토큰 (랜덤, 14일) : httpOnly 쿠키로만 오간다. JS 가 읽을 수 없어서 XSS 로 훔치기 어렵다.
//                              DB 에 있는지로 판단하므로 로그아웃하면 그 즉시 죽는다.
//   액세스 토큰이 만료되면 화면이 /api/auth/refresh 를 한 번 부르고 조용히 새 토큰을 받아 간다.
//
// 엔드포인트
//   GET    /api/health                   DB·설정 상태 (비밀은 안 나온다)
//   POST   /api/auth/signup              { email, password, nickname? }  가입 + 바로 로그인
//   POST   /api/auth/login               { email, password }
//   POST   /api/auth/refresh             쿠키의 리프레시 토큰으로 액세스 토큰 재발급 (토큰 회전)
//   POST   /api/auth/logout              이 기기 로그아웃
//   GET    /api/me                       내 정보                        [로그인 필요]
//   PATCH  /api/me                       { nickname }                   [로그인 필요]
//   POST   /api/me/password              { current, next }              [로그인 필요]
//   GET    /api/me/sessions              로그인된 기기 목록             [로그인 필요]
//   DELETE /api/me/sessions/:id          그 기기만 끊기                 [로그인 필요]
//   POST   /api/me/sessions/logout-all   전부 끊기                      [로그인 필요]
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const nodeCrypto = require("node:crypto");
const { Pool } = require("pg");
const { makeStore, cleanEmail, cleanNickname, checkEmail, checkPassword } = require("./db");
const { hashPassword, verifyPassword, signJwt, verifyJwt, newRefreshToken, hashToken } = require("./crypto");

const ROOT = __dirname;

/* ---------- .env 로딩 (의존성 없이 최소 파서) ---------- */
function loadEnv(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;   // 실제 환경변수가 항상 우선
  }
}
loadEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT) || 8792;
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();

const ACCESS_TTL_SEC = Math.max(60, Number(process.env.ACCESS_TTL_MIN || 15) * 60);
const REFRESH_TTL_SEC = Math.max(3600, Number(process.env.REFRESH_TTL_DAYS || 14) * 86400);

/* JWT 서명 키. 없으면 뜰 때마다 새로 만들어 쓴다 —
   앱이 돌긴 하지만 서버가 재시작되면 발급했던 액세스 토큰이 전부 무효가 된다.
   실제로 쓸 거면 .env 에 JWT_SECRET 을 반드시 넣을 것. */
const SECRET_FROM_ENV = (process.env.JWT_SECRET || "").trim();
const JWT_SECRET = SECRET_FROM_ENV || nodeCrypto.randomBytes(48).toString("base64url");
const SECRET_IS_EPHEMERAL = !SECRET_FROM_ENV;

/* 접속 문자열에서 사람에게 보여줘도 되는 부분만 뽑는다 (비밀번호는 절대 안 꺼낸다) */
function describeUrl(url) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname + (u.port ? ":" + u.port : ""),
      database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "(기본)",
    };
  } catch { return null; }
}
const info = describeUrl(DATABASE_URL);

/* 원격 DB(Supabase·Neon·Render 등)는 대개 SSL 을 요구한다.
   localhost 가 아니면 SSL 을 켜고, PGSSL=off 로 끌 수 있게 해 둔다. */
function sslOption() {
  const forced = (process.env.PGSSL || "").toLowerCase();
  if (forced === "off" || forced === "false" || forced === "0") return false;
  if (forced === "on" || forced === "true" || forced === "1") return { rejectUnauthorized: false };
  if (!info) return false;
  const local = /^(localhost|127\.0\.0\.1|::1)$/.test(info.host.split(":")[0]);
  return local ? false : { rejectUnauthorized: false };
}

/* DATABASE_URL 이 없으면 데모 모드로 돈다 — 메모리 DB(pg-mem) 를 대신 끼운다.
   가입해서 눌러볼 수는 있지만 진짜 저장은 아니다: 서버가 새로 뜨면 계정이 사라진다. */
const DEMO = !DATABASE_URL && (process.env.DEMO || "").toLowerCase() !== "off";

function makePool() {
  if (DATABASE_URL) {
    const p = new Pool({
      connectionString: DATABASE_URL,
      ssl: sslOption(),
      max: Number(process.env.PGPOOL_MAX) || 5,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
    });
    p.on("error", (e) => console.error("  [pool] 유휴 커넥션 오류:", e.message));
    return p;
  }
  if (!DEMO) return null;
  const { newDb } = require("pg-mem");
  return new (newDb().adapters.createPg().Pool)();
}

const pool = makePool();

const query = async (sql, args) => (await pool.query(sql, args)).rows;

/* 트랜잭션 — 커넥션 하나를 잡고 BEGIN … COMMIT, 실패하면 ROLLBACK 하고 되던진다 */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(async (sql, args) => (await client.query(sql, args)).rows);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* 이미 끊긴 커넥션이면 무시 */ }
    throw e;
  } finally {
    client.release();
  }
}

const store = pool ? makeStore(query, tx) : null;

let dbReady = false;
let dbError = (DATABASE_URL || DEMO) ? null : "DATABASE_URL 이 없습니다. .env 를 만들고 서버를 다시 실행하세요.";

async function ensureReady() {
  if (!pool) throw Object.assign(new Error(dbError), { status: 503 });
  if (dbReady) return;
  try {
    await store.init();                       // 테이블이 없으면 만든다
    dbReady = true;
    dbError = null;
  } catch (e) {
    dbError = friendly(e);
    throw Object.assign(new Error(dbError), { status: 503 });
  }
}

function friendly(e) {
  const code = e.code || "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "DB 호스트를 찾을 수 없습니다. DATABASE_URL 의 주소를 확인하세요.";
  if (code === "ECONNREFUSED") return "DB 가 연결을 거부했습니다. 포트와 방화벽을 확인하세요.";
  if (code === "ETIMEDOUT" || code === "ECONNRESET") return "DB 연결이 시간 초과되었습니다. 네트워크나 허용 IP 설정을 확인하세요.";
  if (code === "28P01") return "인증 실패 — 비밀번호가 맞지 않습니다. 접속 문자열을 다시 복사하세요.";
  if (code === "3D000") return "그런 데이터베이스가 없습니다.";
  if (code === "42501") return "권한이 없습니다. 테이블을 만들 수 있는 계정인지 확인하세요.";
  if (/tenant.*not found/i.test(e.message)) return "그런 프로젝트(테넌트)가 없습니다. 접속 문자열의 프로젝트 ref 를 확인하세요.";
  if (/self.signed|certificate/i.test(e.message)) return "SSL 인증서 문제입니다. PGSSL=on 또는 URL 에 ?sslmode=require 를 붙여보세요.";
  return "DB 오류 — " + e.message;
}

/* ---------- HTTP 유틸 ---------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
function send(res, status, body, type, headers) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...(headers || {}) });
  res.end(body);
}
const sendJson = (res, status, obj, headers) => send(res, status, JSON.stringify(obj), MIME[".json"], headers);

function readBody(req, limit = 20_000) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) { reject(Object.assign(new Error("본문이 너무 큽니다"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function json(req) {
  const raw = (await readBody(req)) || "{}";
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new Error("본문이 올바른 JSON 이 아닙니다."), { status: 400 }); }
}

const bad = (status, message) => Object.assign(new Error(message), { status });

/* ---------- 쿠키 ---------- */

const COOKIE = "rt";   // refresh token

function readCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(eq + 1).trim()); } catch { /* 깨진 값은 버린다 */ }
  }
  return out;
}

/** https 로 접속했는지 — Vercel 같은 프록시 뒤에서는 x-forwarded-proto 를 본다. */
function isSecure(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  if (proto) return proto === "https";
  return !!(req.socket && req.socket.encrypted);
}

/**
 * 리프레시 토큰 쿠키.
 *   HttpOnly  브라우저 JS 가 읽지 못한다 (XSS 로 훔치기 어렵다)
 *   SameSite  다른 사이트에서 넘어온 요청에는 안 붙는다 (CSRF 방지)
 *   Secure    https 에서만. 로컬 http 개발을 막지 않으려고 접속 방식을 보고 정한다.
 */
function setRefreshCookie(req, token, maxAgeSec) {
  const bits = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeSec)}`,
  ];
  if (isSecure(req)) bits.push("Secure");
  return { "Set-Cookie": bits.join("; ") };
}

function clearRefreshCookie(req) {
  const bits = [`${COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isSecure(req)) bits.push("Secure");
  return { "Set-Cookie": bits.join("; ") };
}

const clientIp = (req) =>
  String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
  (req.socket && req.socket.remoteAddress) || "";

/* ---------- 로그인 시도 제한 ----------
   같은 이메일/IP 로 비밀번호를 계속 틀리면 잠깐 막는다.
   메모리에만 있어서 서버가 새로 뜨면 초기화된다 (서버리스에서는 인스턴스마다 따로 센다).
   제대로 하려면 DB 나 Redis 로 옮겨야 하지만, 연습 앱에서는 이 정도로 둔다. */
const FAILS = new Map();
const MAX_FAILS = 8;
const LOCK_MS = 10 * 60 * 1000;

function failKey(email, req) { return `${email}|${clientIp(req)}`; }

function throttleCheck(key) {
  const hit = FAILS.get(key);
  if (!hit) return;
  if (Date.now() - hit.first > LOCK_MS) { FAILS.delete(key); return; }
  if (hit.n >= MAX_FAILS) {
    const left = Math.ceil((LOCK_MS - (Date.now() - hit.first)) / 60000);
    throw bad(429, `로그인 시도가 너무 많습니다. ${left}분 뒤에 다시 시도해 주세요.`);
  }
}

function throttleFail(key) {
  const hit = FAILS.get(key);
  if (!hit || Date.now() - hit.first > LOCK_MS) FAILS.set(key, { n: 1, first: Date.now() });
  else hit.n += 1;
}

const throttleReset = (key) => FAILS.delete(key);

/* ---------- 토큰 발급 ---------- */

/** 액세스 토큰에는 최소한만 담는다. 내용은 누구나 열어볼 수 있다 (암호화가 아니다). */
const accessFor = (user) =>
  signJwt({ sub: String(user.id), email: user.email, nickname: user.nickname }, JWT_SECRET, ACCESS_TTL_SEC);

/** 로그인·가입 성공 시 공통 처리 — 세션을 만들고 토큰 두 개를 내려준다. */
async function startSession(req, user) {
  const refresh = newRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_SEC * 1000);
  await store.createSession({
    userId: user.id,
    tokenHash: hashToken(refresh),
    expiresAt,
    userAgent: req.headers["user-agent"],
    ip: clientIp(req),
  });
  return {
    body: { user, accessToken: accessFor(user), expiresIn: ACCESS_TTL_SEC },
    headers: setRefreshCookie(req, refresh, REFRESH_TTL_SEC),
  };
}

/* ---------- 로그인 확인 ----------
   보호된 엔드포인트 앞에서 부른다. 토큰이 멀쩡해도 DB 에서 사용자를 다시 읽는다 —
   탈퇴한 계정의 토큰이 남아 있을 수 있기 때문. */
async function requireUser(req) {
  const header = String(req.headers.authorization || "");
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) throw bad(401, "로그인이 필요합니다.");
  const payload = verifyJwt(m[1].trim(), JWT_SECRET);
  if (!payload) throw bad(401, "토큰이 만료되었거나 올바르지 않습니다.");
  const user = await store.findById(Number(payload.sub));
  if (!user) throw bad(401, "없는 계정입니다.");
  return user;
}

/* 브라우저에 내줘도 되는 파일만 적어 둔다.
   폴더를 통째로 열어 주면 handler.js·package-lock.json 같은 서버 파일까지 같이 나간다.
   ("숨김 파일만 막기" 로는 부족했다 — .env 는 막혀도 소스는 그대로 나갔다.)
   Vercel 은 vercel.json 의 routes 가 같은 일을 한다: /api/* 말고는 전부 index.html. */
const PUBLIC = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
]);

async function serveStatic(res, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); }
  catch { return send(res, 400, "400 Bad Request", MIME[".html"]); }

  const rel = PUBLIC.get(decoded);
  if (!rel) return send(res, 404, "404 Not Found", MIME[".html"]);
  try {
    const body = await fsp.readFile(path.join(ROOT, rel));
    send(res, 200, body, MIME[path.extname(rel).toLowerCase()] || "application/octet-stream");
  } catch {
    send(res, 404, "404 Not Found", MIME[".html"]);
  }
}

/* ---------- 라우팅 ---------- */

const match = (p, pattern) => p.match(new RegExp("^" + pattern + "$"));

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const m = req.method;

  try {
    if (p === "/api/health") {
      let connected = false, detail = dbError;
      if (pool) {
        try { await ensureReady(); connected = true; detail = null; }
        catch (e) { detail = e.message; }
      }
      return sendJson(res, 200, {
        ok: true, connected, detail,
        db: info ? { host: info.host, database: info.database, ssl: !!sslOption() } : null,
        demo: DEMO,
        auth: {
          accessTtlSec: ACCESS_TTL_SEC,
          refreshTtlSec: REFRESH_TTL_SEC,
          // 키 자체는 절대 안 내보낸다. 환경변수로 왔는지만 알려준다.
          secret: SECRET_IS_EPHEMERAL ? "임시 (재시작하면 로그인 풀림)" : "환경변수",
        },
      });
    }

    if (p.startsWith("/api/")) {
      await ensureReady();

      /* ===== 가입 ===== */
      if (p === "/api/auth/signup" && m === "POST") {
        const body = await json(req);
        const email = cleanEmail(body.email);

        const emailErr = checkEmail(email);
        if (emailErr) throw bad(400, emailErr);
        const pwErr = checkPassword(body.password);
        if (pwErr) throw bad(400, pwErr);

        const user = await store.createUser({
          email,
          nickname: cleanNickname(body.nickname, email),
          passwordHash: await hashPassword(String(body.password)),
        });
        await store.touchLogin(user.id);

        // 가입하면 바로 로그인된 상태로 만들어 준다 (다시 로그인 폼을 거치게 하지 않는다)
        const out = await startSession(req, { ...user, lastLoginAt: new Date().toISOString() });
        return sendJson(res, 201, { ...out.body, message: `${user.nickname} 님, 가입됐어요` }, out.headers);
      }

      /* ===== 로그인 ===== */
      if (p === "/api/auth/login" && m === "POST") {
        const body = await json(req);
        const email = cleanEmail(body.email);
        const key = failKey(email, req);
        throttleCheck(key);

        const found = email ? await store.findForLogin(email) : null;

        // 계정이 없을 때도 비밀번호를 한 번 해시해 본다.
        // 그냥 바로 돌려보내면 응답이 빨라서 "이 이메일은 없는 계정" 이라는 게 티가 난다.
        const ok = found
          ? await verifyPassword(String(body.password ?? ""), found.passwordHash)
          : await verifyPassword(String(body.password ?? ""), "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA");

        if (!found || !ok) {
          throttleFail(key);
          // 둘 중 뭐가 틀렸는지 알려주지 않는다 — 가입된 이메일 목록을 캐내는 데 쓰인다.
          throw bad(401, "이메일 또는 비밀번호가 맞지 않습니다.");
        }

        throttleReset(key);
        await store.touchLogin(found.user.id);
        if (Math.random() < 0.1) await store.sweepSessions();   // 만료된 세션 줄 가끔 청소

        const user = { ...found.user, lastLoginAt: new Date().toISOString() };
        const out = await startSession(req, user);
        return sendJson(res, 200, { ...out.body, message: `${user.nickname} 님, 반가워요` }, out.headers);
      }

      /* ===== 액세스 토큰 재발급 ===== */
      if (p === "/api/auth/refresh" && m === "POST") {
        const token = readCookies(req)[COOKIE];
        if (!token) throw bad(401, "로그인이 필요합니다.");

        const session = await store.findSession(hashToken(token));
        if (!session) {
          // 만료됐거나 로그아웃된 토큰 — 쿠키를 지워서 다시 안 보내게 한다
          return sendJson(res, 401, { detail: "다시 로그인해 주세요." }, clearRefreshCookie(req));
        }

        // 토큰 회전: 방금 쓴 토큰은 버리고 새것으로 바꾼다
        const next = newRefreshToken();
        const expiresAt = new Date(Date.now() + REFRESH_TTL_SEC * 1000);
        await store.rotateSession(session.sessionId, hashToken(next), expiresAt);

        return sendJson(res, 200, {
          user: session.user,
          accessToken: accessFor(session.user),
          expiresIn: ACCESS_TTL_SEC,
        }, setRefreshCookie(req, next, REFRESH_TTL_SEC));
      }

      /* ===== 로그아웃 ===== */
      if (p === "/api/auth/logout" && m === "POST") {
        const token = readCookies(req)[COOKIE];
        if (token) await store.deleteSession(hashToken(token));
        // 쿠키가 없어도 200 으로 답한다 — 이미 로그아웃된 상태도 성공이다
        return sendJson(res, 200, { ok: true, message: "로그아웃했어요" }, clearRefreshCookie(req));
      }

      /* ===== 여기서부터 로그인 필요 ===== */

      if (p === "/api/me" && m === "GET") {
        return sendJson(res, 200, { user: await requireUser(req) });
      }

      if (p === "/api/me" && m === "PATCH") {
        const user = await requireUser(req);
        const body = await json(req);
        const nickname = cleanNickname(body.nickname, user.email);
        if (!nickname) throw bad(400, "닉네임을 입력해 주세요.");
        const updated = await store.updateNickname(user.id, nickname);
        // 닉네임이 액세스 토큰 안에도 들어 있으므로 새로 발급해 준다
        return sendJson(res, 200, {
          user: updated, accessToken: accessFor(updated), expiresIn: ACCESS_TTL_SEC,
          message: "닉네임을 바꿨어요",
        });
      }

      if (p === "/api/me/password" && m === "POST") {
        const user = await requireUser(req);
        const body = await json(req);

        const stored = await store.passwordHashOf(user.id);
        if (!stored || !(await verifyPassword(String(body.current ?? ""), stored))) {
          throw bad(401, "지금 쓰는 비밀번호가 맞지 않습니다.");
        }
        const pwErr = checkPassword(body.next);
        if (pwErr) throw bad(400, pwErr);
        if (String(body.next) === String(body.current)) throw bad(400, "지금과 다른 비밀번호로 정해 주세요.");

        // 이 기기만 남기고 나머지 세션은 끊는다
        const token = readCookies(req)[COOKIE];
        await store.updatePassword(user.id, await hashPassword(String(body.next)), {
          keepTokenHash: token ? hashToken(token) : null,
        });
        return sendJson(res, 200, { ok: true, message: "비밀번호를 바꿨어요. 다른 기기는 로그아웃됩니다." });
      }

      if (p === "/api/me/sessions" && m === "GET") {
        const user = await requireUser(req);
        const token = readCookies(req)[COOKIE];
        const current = token ? await store.findSession(hashToken(token)) : null;
        const sessions = await store.listSessions(user.id);
        return sendJson(res, 200, {
          sessions: sessions.map((s) => ({ ...s, current: !!current && current.sessionId === s.id })),
        });
      }

      if (p === "/api/me/sessions/logout-all" && m === "POST") {
        const user = await requireUser(req);
        const n = await store.deleteAllSessions(user.id);
        return sendJson(res, 200, { ok: true, message: `${n}개 기기에서 로그아웃했어요` }, clearRefreshCookie(req));
      }

      const r = match(p, `/api/me/sessions/(\\d+)`);
      if (r && m === "DELETE") {
        const user = await requireUser(req);
        const n = await store.deleteSessionById(user.id, Number(r[1]));
        if (!n) throw bad(404, "그런 세션이 없습니다.");
        return sendJson(res, 200, { ok: true, message: "그 기기를 로그아웃했어요" });
      }

      return sendJson(res, 404, { detail: "없는 엔드포인트" });
    }

    return serveStatic(res, p);
  } catch (e) {
    const status = e.status || 500;
    const detail = e.status ? e.message : friendly(e);
    if (status >= 500) console.error("  [오류]", e.message);
    sendJson(res, status, { detail });
  }
}

/** Vercel 서버리스용 — 정적 파일은 Vercel 이 직접 주므로 /api/* 만 처리한다. */
async function apiHandler(req, res) {
  if (!new URL(req.url, "http://localhost").pathname.startsWith("/api/")) {
    res.writeHead(404, { "Content-Type": MIME[".json"] });
    return res.end(JSON.stringify({ detail: "없는 엔드포인트" }));
  }
  return handle(req, res);
}

module.exports = {
  handle, apiHandler, store, pool, ensureReady, sslOption, info,
  DEMO, PORT, JWT_SECRET, SECRET_IS_EPHEMERAL, ACCESS_TTL_SEC, REFRESH_TTL_SEC,
};
