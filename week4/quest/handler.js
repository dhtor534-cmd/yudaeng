// week4 quest — 요청 처리 본체 (전송 계층과 분리)
//
// 로컬(server.js) 과 Vercel 서버리스 함수(api/index.js) 가 이 파일을 같이 쓴다.
// 순수 Node 의 req/res 만 쓰므로 양쪽에서 똑같이 동작한다.
//
// 의존성은 pg 하나. 접속 정보는 환경변수에만 있고 브라우저로 내려가지 않는다.
//
// 엔드포인트 (쓰기 요청은 전부 바뀐 뒤의 전체 상태를 그대로 돌려준다 → 화면은 받아서 갈아끼우기만)
//   GET    /api/health                  DB 연결 상태 (비밀번호는 빼고 호스트/DB 이름만)
//   GET    /api/state                   { ingredients, recipes, shopping, cooks }
//   POST   /api/ingredients             { name, emoji, category, qty, unit, storage, expiresAt }
//   PATCH  /api/ingredients/:id         위 항목 중 바꿀 것만
//   POST   /api/ingredients/:id/bump    { delta }  수량 +1 / -1
//   DELETE /api/ingredients/:id
//   POST   /api/recipes/:id/cook        요리 완료 — 재료 차감 + 기록 (트랜잭션)
//   POST   /api/ai/recipe               { note?, use? } 냉장고 재료로 AI 레시피 생성 → DB 에 저장
//   DELETE /api/recipes/:id             AI 가 만든 레시피 삭제 (기본 레시피는 못 지움)
//   POST   /api/shopping                { name } 또는 { items: [{name, qty, unit, from}] }
//   POST   /api/shopping/:id/toggle
//   DELETE /api/shopping/:id
//   POST   /api/shopping/clear-done
//   POST   /api/shopping/stock-up       체크한 것 냉장고로 (트랜잭션)
//   POST   /api/reset                   시드 데이터로 되돌리기
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");
const { CATEGORIES, STORAGES, UNITS, makeStore } = require("./db");
const { generateRecipe } = require("./ai");

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

const PORT = Number(process.env.PORT) || 8791;
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();

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

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: sslOption(),
      max: Number(process.env.PGPOOL_MAX) || 5,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
    })
  : null;

if (pool) pool.on("error", (e) => console.error("  [pool] 유휴 커넥션 오류:", e.message));

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
let dbError = DATABASE_URL ? null : "DATABASE_URL 이 없습니다. .env 를 만들고 서버를 다시 실행하세요.";

async function ensureReady() {
  if (!pool) throw Object.assign(new Error(dbError), { status: 503 });
  if (dbReady) return;
  try {
    await store.init();                       // 테이블이 없으면 만들고, 비어 있으면 시드를 넣는다
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
  if (code === "28P01") return "인증 실패 — 비밀번호가 맞지 않습니다. Supabase → Settings → Database 에서 접속 문자열을 다시 복사하세요.";
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
function send(res, status, body, type) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), MIME[".json"]);

function readBody(req, limit = 200_000) {
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

/* AI 는 돈이 드는 호출이라 한 번에 하나만 처리한다 (새로고침 연타 방지) */
const AI_ON = !!(process.env.OPENAI_API_KEY || "").trim();
let aiBusy = false;

/** 화면이 받아 가는 전체 상태 + 폼에 쓸 선택지 */
const payload = async (extra) => Object.assign(
  {
    ...(await store.state()),
    options: { categories: CATEGORIES, storages: STORAGES, units: UNITS },
    db: info ? { host: info.host, database: info.database } : null,
    ai: { enabled: AI_ON, model: (process.env.OPENAI_MODEL || "gpt-4o-mini").trim() },
  },
  extra || {}
);

async function serveStatic(res, urlPath) {
  let rel;
  try { rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, ""); }
  catch { return send(res, 400, "400 Bad Request", MIME[".html"]); }
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT)) return send(res, 403, "403 Forbidden", MIME[".html"]);
  if (path.basename(file).startsWith(".env")) return send(res, 403, "403 Forbidden", MIME[".html"]);
  try {
    const body = await fsp.readFile(file);
    send(res, 200, body, MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
  } catch {
    send(res, 404, "404 Not Found", MIME[".html"]);
  }
}

/* ---------- 라우팅 ---------- */

const ID = "(\\d+)";
const RID = "([A-Za-z0-9_-]{1,40})";
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
        ai: { enabled: AI_ON, model: (process.env.OPENAI_MODEL || "gpt-4o-mini").trim() },
      });
    }

    if (p.startsWith("/api/")) {
      await ensureReady();

      if (p === "/api/state" && m === "GET") return sendJson(res, 200, await payload());

      /* ----- 재료 ----- */
      if (p === "/api/ingredients" && m === "POST") {
        const created = await store.addIngredient(await json(req));
        return sendJson(res, 201, await payload({ message: `${created.name} 추가했어요` }));
      }
      let r = match(p, `/api/ingredients/${ID}`);
      if (r) {
        if (m === "PATCH") {
          const updated = await store.updateIngredient(r[1], await json(req));
          return sendJson(res, 200, await payload({ message: `${updated.name} 수정했어요` }));
        }
        if (m === "DELETE") {
          const name = await store.removeIngredient(r[1]);
          return sendJson(res, 200, await payload({ message: `${name} 삭제했어요` }));
        }
      }
      r = match(p, `/api/ingredients/${ID}/bump`);
      if (r && m === "POST") {
        const body = await json(req);
        await store.bumpIngredient(r[1], body.delta);
        return sendJson(res, 200, await payload());
      }

      /* ----- 요리 ----- */
      r = match(p, `/api/recipes/${RID}/cook`);
      if (r && m === "POST") {
        const out = await store.cook(r[1]);
        return sendJson(res, 200, await payload({ message: `🍽 ${out.recipe} 완성! 사용한 재료를 차감했어요` }));
      }
      r = match(p, `/api/recipes/${RID}`);
      if (r && m === "DELETE") {
        const name = await store.removeRecipe(r[1]);
        return sendJson(res, 200, await payload({ message: `${name} 레시피를 지웠어요` }));
      }

      /* ----- AI 레시피 생성 ----- */
      if (p === "/api/ai/recipe" && m === "POST") {
        if (!AI_ON) {
          return sendJson(res, 503, { detail: "AI 기능이 꺼져 있습니다. .env 에 OPENAI_API_KEY 를 넣어 주세요." });
        }
        if (aiBusy) {
          return sendJson(res, 429, { detail: "이미 만드는 중이에요. 잠깐만 기다려 주세요." });
        }
        aiBusy = true;
        try {
          const body = await json(req);
          const ingredients = await store.ingredients();
          const out = await generateRecipe(ingredients, { note: body.note, use: body.use });
          const saved = await store.addRecipe(out.recipe);
          const tok = out.usage ? ` · 토큰 ${out.usage.total_tokens}` : "";
          console.log(`  [AI] ${saved.name} (${out.model}${tok})`);
          return sendJson(res, 201, await payload({
            message: `✨ ${saved.name} 레시피를 만들었어요`,
            createdRecipeId: saved.id,
          }));
        } finally {
          aiBusy = false;
        }
      }

      /* ----- 장보기 ----- */
      if (p === "/api/shopping" && m === "POST") {
        const body = await json(req);
        const added = await store.addShopping(body.items || body);
        return sendJson(res, 201, await payload({ message: `장보기에 ${added}개 담았어요` }));
      }
      r = match(p, `/api/shopping/${ID}/toggle`);
      if (r && m === "POST") {
        await store.toggleShopping(r[1]);
        return sendJson(res, 200, await payload());
      }
      r = match(p, `/api/shopping/${ID}`);
      if (r && m === "DELETE") {
        await store.removeShopping(r[1]);
        return sendJson(res, 200, await payload());
      }
      if (p === "/api/shopping/clear-done" && m === "POST") {
        const n = await store.clearDoneShopping();
        return sendJson(res, 200, await payload({ message: `${n}개 비웠어요` }));
      }
      if (p === "/api/shopping/stock-up" && m === "POST") {
        const n = await store.stockUp();
        return sendJson(res, 200, await payload({ message: `${n}개를 냉장고에 넣었어요 (유통기한 7일로 임시 설정)` }));
      }

      /* ----- 초기화 ----- */
      if (p === "/api/reset" && m === "POST") {
        const n = await store.reset();
        return sendJson(res, 200, await payload({ message: `초기 데이터 ${n}개로 되돌렸어요` }));
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

module.exports = { handle, apiHandler, store, pool, ensureReady, sslOption, info, AI_ON, PORT };
