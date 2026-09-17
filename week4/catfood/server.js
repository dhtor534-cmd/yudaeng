// 하루한끼 캣푸드 — 로컬 개발 서버.
// Vercel 에 올리면 api/*.js 가 서버리스 함수로 동작하고, 로컬에서는 이 파일이 같은 핸들러를 부른다.
//   준비: .env 에 DATABASE_URL=postgresql://...     실행: node server.js  →  http://localhost:8790
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

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

const PORT = Number(process.env.PORT) || 8790;
const lib = require("./api/_lib");        // .env 를 읽은 뒤에 불러야 한다

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".md": "text/markdown; charset=utf-8",
};

async function serveStatic(res, urlPath) {
  let rel;
  try { rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, ""); }
  catch { res.writeHead(400); return res.end("400 Bad Request"); }
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("403 Forbidden"); }
  if (path.basename(file) === ".env" || file.includes(path.join(ROOT, "api"))) {
    res.writeHead(403); return res.end("403 Forbidden");     // 서버 코드와 키 파일은 내주지 않는다
  }
  try {
    const body = await fsp.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": MIME[".html"] });
    res.end("404 Not Found");
  }
}

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://localhost").pathname;
  if (p === "/api/health") return lib.health(req, res);
  if (p === "/api/inquiries") return lib.inquiries(req, res);
  if (p.startsWith("/api/")) return lib.json(res, 404, { detail: "없는 엔드포인트" });
  return serveStatic(res, p);
});

server.listen(PORT, () => {
  console.log(`하루한끼 캣푸드 → http://localhost:${PORT}`);
  console.log(lib.info
    ? `  DB: ${lib.info.host} / ${lib.info.database}`
    : "  DATABASE_URL 없음 — 페이지는 보이지만 문의 저장은 막힙니다.");
  console.log(process.env.ADMIN_TOKEN ? "  ADMIN_TOKEN 설정됨 — GET /api/inquiries 사용 가능" : "  ADMIN_TOKEN 없음 — 문의 목록 조회는 잠겨 있습니다.");
});
