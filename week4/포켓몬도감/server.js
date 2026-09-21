// 전국도감 내부 서버 — PokéAPI 대신 data/ 폴더의 데이터를 돌려준다.
//   준비: node fetch-data.js     실행: node server.js   →  http://localhost:8000
// 외부 의존성 없이 Node 표준 모듈만 사용한다.
//
// 엔드포인트
//   GET /api/v2/pokedex        도감 목록 1000마리 요약 (번호·이름·타입·스프라이트)
//   GET /api/v2/families       진화 계통 535개 (단계별 묶음)
//   GET /api/v2/pokemon/:id    한 마리 상세
//   GET /api/v2/abilities      특성 슬러그 → 한국어 이름
//   GET /sprites/small/:id.png 픽셀 스프라이트
//   GET /sprites/art/:id.png   공식 일러스트 (--art 로 받았을 때만)
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const PORT = Number(process.env.PORT) || 8000;
const ROOT = __dirname;
const DATA = path.join(ROOT, "data");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

function send(res, status, body, type, cache) {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",      // file:// 로 열어도 호출되도록 열어 둔다
    "Cache-Control": cache || "no-store",
  });
  res.end(body);
}

const sendJson = (res, status, obj) =>
  send(res, status, JSON.stringify(obj), MIME[".json"]);

// data/ 안의 JSON 파일을 그대로 흘려보낸다. 없으면 404.
async function sendDataFile(res, rel, notFound) {
  try {
    const body = await fsp.readFile(path.join(DATA, rel), "utf8");
    send(res, 200, body, MIME[".json"], "public, max-age=60");
  } catch {
    sendJson(res, 404, { detail: notFound });
  }
}

async function serveStatic(res, urlPath) {
  let rel;
  try {
    rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
  } catch {
    return send(res, 400, "400 Bad Request", MIME[".html"]);   // 깨진 퍼센트 인코딩
  }
  const file = path.resolve(ROOT, rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    return send(res, 403, "403 Forbidden", MIME[".html"]);   // 상위 폴더 탈출 차단
  }
  try {
    const body = await fsp.readFile(file);
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    send(res, 200, body, type, type === MIME[".png"] ? "public, max-age=3600" : "no-store");
  } catch {
    send(res, 404, "404 Not Found", MIME[".html"]);
  }
}

http
  .createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      console.error("요청 처리 실패:", req.method, req.url, "—", err.message);
      if (!res.headersSent) sendJson(res, 500, { detail: "서버 오류" });
      else res.end();
    }
  })
  .listen(PORT, () => {
    if (!fs.existsSync(path.join(DATA, "index.json"))) {
      console.log("⚠ data/ 가 비어 있습니다. 먼저 node fetch-data.js 를 실행하세요.\n");
    }
    console.log(`전국도감 내부 서버: http://localhost:${PORT}`);
    console.log(`  도감 페이지   http://localhost:${PORT}/`);
    console.log(`  API 예시      http://localhost:${PORT}/api/v2/pokemon/25`);
    console.log("종료하려면 Ctrl+C\n");
  });

async function handle(req, res) {
  const urlPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (!urlPath.startsWith("/sprites/")) console.log(`${req.method} ${urlPath}`);

  if (urlPath === "/api/v2/pokedex") {
    return sendDataFile(res, "index.json", "도감 목록이 없습니다. node fetch-data.js 를 먼저 실행하세요.");
  }
  if (urlPath === "/api/v2/families") {
    return sendDataFile(res, "families.json", "진화 계통 자료가 없습니다. node fetch-data.js --evo-only 를 실행하세요.");
  }
  if (urlPath === "/api/v2/abilities") {
    return sendDataFile(res, "abilities.json", "특성 목록이 없습니다.");
  }

  const one = urlPath.match(/^\/api\/v2\/pokemon\/(\d+)\/?$/);
  if (one) {
    return sendDataFile(res, path.join("pokemon", `${one[1]}.json`),
      `도감에 없는 번호입니다: No.${one[1]}`);
  }
  if (urlPath.startsWith("/api/")) {
    return sendJson(res, 404, { detail: "Not found." });
  }

  // 이미지는 data/sprites/ 에 있지만 /sprites/ 주소로 서빙한다
  if (urlPath.startsWith("/sprites/")) return serveStatic(res, "/data" + urlPath);

  return serveStatic(res, urlPath);
}
