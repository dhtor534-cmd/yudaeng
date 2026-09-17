// 요청 처리 본체 — Vercel 서버리스 함수(api/*.js)와 로컬 server.js 가 같이 쓴다.
// 순수 Node 의 req/res 만 쓰므로 양쪽에서 그대로 동작한다.
const { Pool } = require("pg");
const { makeStore, TOPICS } = require("../db");

/* ---------- 접속 ---------- */
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();

function describeUrl(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname + (u.port ? ":" + u.port : ""), database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "(기본)" };
  } catch { return null; }
}
const info = describeUrl(DATABASE_URL);

function sslOption() {
  const forced = (process.env.PGSSL || "").toLowerCase();
  if (["off", "false", "0"].includes(forced)) return false;
  if (["on", "true", "1"].includes(forced)) return { rejectUnauthorized: false };
  if (!info) return false;
  return /^(localhost|127\.0\.0\.1|::1)$/.test(info.host.split(":")[0]) ? false : { rejectUnauthorized: false };
}

// 서버리스에서는 호출마다 모듈이 살아있을 수도, 새로 뜰 수도 있다.
// 전역에 하나만 두고 재사용한다 (Supabase 는 6543 트랜잭션 풀러 사용 권장).
let pool = global.__catfoodPool;
if (!pool && DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: sslOption(),
    max: Number(process.env.PGPOOL_MAX) || 3,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 10000,
  });
  pool.on("error", (e) => console.error("[pool]", e.message));
  global.__catfoodPool = pool;
}

const store = pool ? makeStore(async (sql, args) => (await pool.query(sql, args)).rows) : null;

let ready = false;
async function ensureReady() {
  if (!pool) {
    throw Object.assign(new Error("DATABASE_URL 이 설정되지 않았습니다. 문의 저장은 DB 연결 후 동작합니다."), { status: 503 });
  }
  if (ready) return;
  try {
    await store.init();
    ready = true;
  } catch (e) {
    throw Object.assign(new Error(friendly(e)), { status: 503 });
  }
}

function friendly(e) {
  const code = e.code || "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "DB 호스트를 찾을 수 없습니다. DATABASE_URL 의 주소를 확인하세요.";
  if (code === "ECONNREFUSED") return "DB 가 연결을 거부했습니다. 포트와 방화벽을 확인하세요.";
  if (code === "ETIMEDOUT" || code === "ECONNRESET") return "DB 연결이 시간 초과되었습니다.";
  if (code === "28P01") return "DB 인증 실패 — 사용자 이름이나 비밀번호가 맞지 않습니다.";
  if (code === "3D000") return "그런 데이터베이스가 없습니다.";
  if (code === "XX000") return "DB 가 프로젝트를 찾지 못했습니다. 접속 URL 을 다시 확인하세요.";
  if (/certificate/i.test(e.message)) return "SSL 인증서 문제입니다. PGSSL=on 을 시도해보세요.";
  return "DB 오류 — " + e.message;
}

/* ---------- HTTP 도우미 ---------- */
const json = (res, status, obj) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
};

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;      // Vercel 이 미리 파싱한 경우
  if (typeof req.body === "string" && req.body) { try { return JSON.parse(req.body); } catch { return {}; } }
  const text = await new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > 100_000) { req.destroy(); reject(new Error("본문이 너무 큽니다")); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

const clientIp = (req) =>
  (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
  (req.socket && req.socket.remoteAddress) || "unknown";

/* 같은 IP 에서 쏟아지는 문의를 막는다. 서버리스에서는 인스턴스 단위로만 기억한다. */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = Number(process.env.RATE_LIMIT) || 5;
const hits = global.__catfoodHits || (global.__catfoodHits = new Map());
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_PER_WINDOW) { hits.set(ip, list); return true; }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return false;
}

/* 관리자 확인 — 토큰이 없거나 틀리면 여기서 끊는다 */
function requireAdmin(req, url) {
  const need = (process.env.ADMIN_TOKEN || "").trim();
  if (!need) throw Object.assign(new Error("ADMIN_TOKEN 이 설정되지 않아 관리자 기능이 잠겨 있습니다."), { status: 503 });
  const got = String(req.headers["x-admin-token"] || url.searchParams.get("token") || "");
  if (got !== need) throw Object.assign(new Error("관리자 토큰이 필요합니다."), { status: 401 });
}

/* ---------- 핸들러 ---------- */
async function health(req, res) {
  let connected = false, detail = null, stats = { total: 0, answered: 0 };
  try {
    await ensureReady();
    connected = true;
    stats = await store.stats();
  } catch (e) {
    detail = e.message;
  }
  json(res, 200, {
    ok: true,
    connected,
    detail,
    stats,
    topics: TOPICS,
    db: info ? { host: info.host, database: info.database } : null,
  });
}

async function inquiries(req, res) {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "POST") {
    if (rateLimited(clientIp(req))) {
      return json(res, 429, { detail: `잠시 후 다시 시도해주세요. (10분에 ${MAX_PER_WINDOW}건까지)` });
    }
    await ensureReady();
    const body = await readJson(req);
    const row = await store.create(body);
    const stats = await store.stats();
    return json(res, 201, {
      ticket: row.ticket,
      created: row.created,
      topic: row.topic,
      stats,
      recent: await store.recentPublic(5),
    });
  }

  if (req.method === "GET") {
    await ensureReady();
    if (url.searchParams.get("recent")) {
      return json(res, 200, { recent: await store.recentPublic(5), stats: await store.stats() });
    }
    requireAdmin(req, url);                      // 전체 목록은 관리자만
    return json(res, 200, { inquiries: await store.list(url.searchParams.get("limit")), stats: await store.stats() });
  }

  /* 관리자 답변 처리: PATCH /api/inquiries?id=3  { status: "답변완료" } */
  if (req.method === "PATCH") {
    await ensureReady();
    requireAdmin(req, url);
    const id = url.searchParams.get("id");
    if (!/^\d+$/.test(String(id || ""))) return json(res, 400, { detail: "id 가 필요합니다." });
    const body = await readJson(req);
    const updated = await store.setStatus(id, body.status);
    return json(res, 200, { updated, inquiries: await store.list(url.searchParams.get("limit")), stats: await store.stats() });
  }

  return json(res, 405, { detail: "지원하지 않는 메서드" });
}

/* 핸들러를 감싸 오류를 한국어 JSON 으로 돌려준다 */
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error("[오류]", e.message);
    json(res, status, Object.assign({ detail: e.status ? e.message : friendly(e) }, e.errors ? { errors: e.errors } : {}));
  }
};

module.exports = {
  health: wrap(health),
  inquiries: wrap(inquiries),
  info,
  hasDb: !!pool,
  json,
};
