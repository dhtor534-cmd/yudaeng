// todo02 서버 — 투두를 PostgreSQL 에 저장한다. (todo01 은 텍스트 파일, 이쪽은 DB)
//   준비: .env 에 DATABASE_URL=postgresql://...     실행: node server.js  →  http://localhost:8789
// 의존성은 pg 하나. 접속 정보는 환경변수에만 있고 브라우저로 내려가지 않는다.
//
// 엔드포인트
//   GET    /api/health              DB 연결 상태 (비밀번호는 빼고 호스트/DB 이름만)
//   GET    /api/todos?q=검색어      { todos, stats }
//   POST   /api/todos               { text, priority }
//   PATCH  /api/todos/:id           { done?, text?, priority? }
//   DELETE /api/todos/:id
//   POST   /api/todos/clear-done
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");
const { PRIORITIES, makeStore } = require("./db");

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

const PORT = Number(process.env.PORT) || 8789;
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();

/* 접속 문자열에서 사람에게 보여줘도 되는 부분만 뽑는다 (비밀번호는 절대 안 꺼낸다) */
function describeUrl(url) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname + (u.port ? ":" + u.port : ""),
      database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "(기본)",
      ssl: /sslmode=require|sslmode=verify/.test(u.search),
    };
  } catch { return null; }
}
const info = describeUrl(DATABASE_URL);

/* 원격 DB(Neon·Supabase·Render 등)는 대개 SSL 을 요구한다.
   localhost 가 아니면 SSL 을 켜고, PGSSL=off 로 끌 수 있게 해 둔다. */
function sslOption() {
  const forced = (process.env.PGSSL || "").toLowerCase();
  if (forced === "off" || forced === "false" || forced === "0") return false;
  if (forced === "on" || forced === "true" || forced === "1") return { rejectUnauthorized: false };
  if (!info) return false;
  const local = /^(localhost|127\.0\.0\.1|::1)$/.test(info.host.split(":")[0]);
  return local ? false : { rejectUnauthorized: false };
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: sslOption(),
      max: Number(process.env.PGPOOL_MAX) || 5,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 30000,
    })
  : null;

if (pool) pool.on("error", (e) => console.error("  [pool] 유휴 커넥션 오류:", e.message));

const query = async (sql, args) => (await pool.query(sql, args)).rows;
const store = pool ? makeStore(query) : null;

let dbReady = false;
let dbError = DATABASE_URL ? null : "DATABASE_URL 이 없습니다. .env 를 만들고 서버를 다시 실행하세요.";

async function ensureReady() {
  if (!pool) throw Object.assign(new Error(dbError), { status: 503 });
  if (dbReady) return;
  try {
    await store.init();                       // 테이블이 없으면 만든다 (CREATE TABLE IF NOT EXISTS)
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
  if (code === "28P01") return "인증 실패 — 사용자 이름이나 비밀번호가 맞지 않습니다.";
  if (code === "3D000") return "그런 데이터베이스가 없습니다.";
  if (code === "42501") return "권한이 없습니다. 테이블을 만들 수 있는 계정인지 확인하세요.";
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
function send(res, status, body, type) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), MIME[".json"]);

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) { reject(new Error("본문이 너무 큽니다")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const payload = async (search) => ({
  todos: await store.list(search),
  stats: await store.stats(),
  priorities: PRIORITIES,
  db: info ? { host: info.host, database: info.database } : null,
});

async function serveStatic(res, urlPath) {
  let rel;
  try { rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, ""); }
  catch { return send(res, 400, "400 Bad Request", MIME[".html"]); }
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT)) return send(res, 403, "403 Forbidden", MIME[".html"]);
  if (path.basename(file) === ".env") return send(res, 403, "403 Forbidden", MIME[".html"]);
  try {
    const body = await fsp.readFile(file);
    send(res, 200, body, MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
  } catch {
    send(res, 404, "404 Not Found", MIME[".html"]);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  try {
    if (p === "/api/health") {
      let connected = false, detail = dbError;
      if (pool) {
        try { await ensureReady(); connected = true; detail = null; }
        catch (e) { detail = e.message; }
      }
      return sendJson(res, 200, {
        ok: true,
        connected,
        detail,
        db: info ? { host: info.host, database: info.database, ssl: !!sslOption() } : null,
      });
    }

    if (p.startsWith("/api/")) {
      await ensureReady();

      if (p === "/api/todos" && req.method === "GET") {
        return sendJson(res, 200, await payload(url.searchParams.get("q")));
      }
      if (p === "/api/todos" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const created = await store.add(body.text, body.priority);
        return sendJson(res, 201, Object.assign({ created }, await payload()));
      }
      if (p === "/api/todos/clear-done" && req.method === "POST") {
        const removed = await store.clearDone();
        return sendJson(res, 200, Object.assign({ removed }, await payload()));
      }
      const m = p.match(/^\/api\/todos\/(\d+)$/);
      if (m) {
        const id = m[1];
        if (req.method === "PATCH") {
          const body = JSON.parse((await readBody(req)) || "{}");
          const updated = await store.update(id, body);
          return sendJson(res, 200, Object.assign({ updated }, await payload()));
        }
        if (req.method === "DELETE") {
          await store.remove(id);
          return sendJson(res, 200, await payload());
        }
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
});

server.listen(PORT, async () => {
  console.log(`todo02 → http://localhost:${PORT}`);
  if (!pool) {
    console.log("  DATABASE_URL 없음 — .env 에 postgresql://... 을 넣고 다시 실행하세요.");
    return;
  }
  console.log(`  DB: ${info ? info.host + " / " + info.database : "(URL 형식을 읽지 못했습니다)"} · SSL ${sslOption() ? "on" : "off"}`);
  try {
    await ensureReady();
    const s = await store.stats();
    console.log(`  연결 성공 · todos 테이블 준비됨 (${s.total}건, 완료 ${s.done}건)`);
  } catch (e) {
    console.log("  연결 실패 — " + e.message);
    console.log("  (서버는 계속 떠 있습니다. URL 을 고치고 다시 실행하세요.)");
  }
});
