// 드림캔버스 프록시 서버 — fal.ai 키를 브라우저에 노출하지 않기 위한 중계.
//   준비: .env 에 FAL_KEY=키아이디:시크릿    실행: node server.js  →  http://localhost:8787
// 외부 의존성 없이 Node 표준 모듈만 사용한다 (Node 18+ 의 내장 fetch 필요).
//
// 엔드포인트
//   GET  /                  index.html 등 정적 파일
//   GET  /api/health        키 설정 여부 · 사용 가능한 모델
//   POST /api/imagine       생성 요청 접수 → { id }        (fal 큐에 제출)
//   GET  /api/status/:id    { status, queue_position }
//   GET  /api/result/:id    { images: [{ url, width, height }] }
//
// 브라우저는 fal.ai 주소도, 키도 모른다. 오직 이 서버의 :id 만 본다.
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8787;

/* ---------- .env 로딩 (의존성 없이 최소 파서) ---------- */
function loadEnv(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return 0; }
  let n = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) { process.env[key] = val; n++; }   // 실제 환경변수가 항상 우선
  }
  return n;
}
loadEnv(path.join(ROOT, ".env"));

const FAL_KEY = (process.env.FAL_KEY || "").trim();
const FAL_QUEUE = "https://queue.fal.run/";

/* ---------- 허용 엔드포인트 화이트리스트 ----------
   브라우저가 임의의 fal 모델을 호출하지 못하도록 서버가 목록을 고정한다. */
const ENDPOINTS = {
  schnell: { ep: "fal-ai/flux/schnell", steps: 4, label: "FLUX.1 schnell" },
  dev: { ep: "fal-ai/flux/dev", steps: 28, label: "FLUX.1 dev" },
  i2i: { ep: "fal-ai/flux/dev/image-to-image", steps: 28, label: "FLUX.1 dev i2i" },
  upscale: { ep: "fal-ai/esrgan", steps: 0, label: "ESRGAN ×2" },
};
const SIZES = ["square_hd", "square", "portrait_4_3", "portrait_16_9", "landscape_4_3", "landscape_16_9"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
};

function send(res, status, body, type, cache) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": cache || "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), MIME[".json"]);

function readBody(req, limit = 1_000_000) {
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

/* ---------- 큐 작업 보관 (fal 주소는 서버만 안다) ---------- */
const jobs = new Map();               // id → { statusUrl, responseUrl, at }
const JOB_TTL = 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.at > JOB_TTL) jobs.delete(id);
}, 10 * 60 * 1000).unref();

async function falFetch(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: "Key " + FAL_KEY, "Content-Type": "application/json", ...(init && init.headers) },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { detail: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, data };
}
function falMessage(status, data) {
  const d = data && data.detail;
  const detail = typeof d === "string" ? d
    : Array.isArray(d) ? d.map((x) => (x.loc ? x.loc.join(".") + ": " : "") + x.msg).join(" / ")
    : data ? JSON.stringify(data).slice(0, 200) : "";
  if (status === 401 || status === 403) return `fal.ai 가 키를 거부했습니다 (${status}). .env 의 FAL_KEY 를 확인하세요. — ${detail}`;
  if (status === 402) return "fal.ai 잔액이 부족합니다 (402).";
  if (status === 429) return "요청이 너무 많습니다 (429). 잠시 후 다시 시도하세요.";
  return `fal.ai 오류 ${status} — ${detail}`;
}

/* 브라우저가 보낸 값을 그대로 믿지 않고 필요한 필드만 추려서 다시 만든다. */
function buildInput(body) {
  const op = String(body.op || "text");
  const num = 1;                                   // 한 요청당 1장 (타일별 진행률을 따로 보여주기 위해)
  const seed = Number.isFinite(+body.seed) ? Math.abs(Math.trunc(+body.seed)) % 4294967295 : undefined;

  if (op === "upscale") {
    const url = String(body.image_url || "");
    if (!/^https:\/\//.test(url)) throw new Error("업스케일에는 image_url 이 필요합니다.");
    return { key: "upscale", input: { image_url: url, scale: 2 } };
  }
  const prompt = String(body.prompt || "").slice(0, 2000).trim();
  if (!prompt) throw new Error("프롬프트가 비어 있습니다.");

  if (op === "vary") {
    const url = String(body.image_url || "");
    if (!/^https:\/\//.test(url)) throw new Error("변형에는 image_url 이 필요합니다.");
    return {
      key: "i2i",
      input: {
        image_url: url, prompt, num_images: num, seed,
        strength: Math.min(0.95, Math.max(0.2, Number(body.strength) || 0.7)),
        num_inference_steps: ENDPOINTS.i2i.steps,
        enable_safety_checker: true,
      },
    };
  }
  const key = body.model === "dev" ? "dev" : "schnell";
  const input = {
    prompt,
    image_size: SIZES.includes(body.image_size) ? body.image_size : "square_hd",
    num_images: num, seed,
    num_inference_steps: ENDPOINTS[key].steps,
    enable_safety_checker: true,
  };
  if (key === "dev") input.guidance_scale = Math.min(10, Math.max(1, Number(body.guidance_scale) || 3.5));
  return { key, input };
}

async function handleImagine(req, res) {
  if (!FAL_KEY) return sendJson(res, 503, { detail: "서버에 FAL_KEY 가 없습니다. .env 를 만들고 서버를 다시 실행하세요." });
  let body;
  try { body = JSON.parse((await readBody(req)) || "{}"); }
  catch { return sendJson(res, 400, { detail: "JSON 본문을 읽을 수 없습니다." }); }

  let built;
  try { built = buildInput(body); }
  catch (e) { return sendJson(res, 400, { detail: e.message }); }

  const { ok, status, data } = await falFetch(FAL_QUEUE + ENDPOINTS[built.key].ep, {
    method: "POST",
    body: JSON.stringify(built.input),
  });
  if (!ok) return sendJson(res, status === 401 || status === 403 ? 502 : status, { detail: falMessage(status, data) });

  const id = data.request_id || Math.random().toString(36).slice(2);
  jobs.set(id, { statusUrl: data.status_url, responseUrl: data.response_url, at: Date.now() });
  sendJson(res, 200, { id, status: "IN_QUEUE", model: ENDPOINTS[built.key].label });
}

async function handleStatus(res, id) {
  const j = jobs.get(id);
  if (!j) return sendJson(res, 404, { detail: "모르는 작업 id 입니다 (서버가 재시작되었을 수 있습니다)." });
  const { ok, status, data } = await falFetch(j.statusUrl);
  if (!ok) return sendJson(res, 502, { detail: falMessage(status, data) });
  sendJson(res, 200, { status: data.status, queue_position: data.queue_position ?? null });
}

async function handleResult(res, id) {
  const j = jobs.get(id);
  if (!j) return sendJson(res, 404, { detail: "모르는 작업 id 입니다." });
  const { ok, status, data } = await falFetch(j.responseUrl);
  if (!ok) return sendJson(res, 502, { detail: falMessage(status, data) });
  // 이미지 URL(fal 미디어 CDN)만 골라서 내보낸다. 키가 섞여 나갈 여지를 없앤다.
  const list = Array.isArray(data.images) ? data.images : data.image ? [data.image] : [];
  const images = list.filter((i) => i && i.url).map((i) => ({ url: i.url, width: i.width || null, height: i.height || null }));
  if (!images.length) return sendJson(res, 502, { detail: "응답에 이미지가 없습니다." });
  jobs.delete(id);
  sendJson(res, 200, { images, seed: data.seed ?? null });
}

async function serveStatic(res, urlPath) {
  let rel;
  try { rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, ""); }
  catch { return send(res, 400, "400 Bad Request", MIME[".html"]); }
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT)) return send(res, 403, "403 Forbidden", MIME[".html"]);          // 경로 탈출 차단
  if (path.basename(file) === ".env") return send(res, 403, "403 Forbidden", MIME[".html"]); // 키 파일은 절대 서빙하지 않는다
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
      return sendJson(res, 200, {
        ok: true,
        hasKey: !!FAL_KEY,
        keyHint: FAL_KEY ? FAL_KEY.slice(0, 4) + "…" + FAL_KEY.length + "자" : null,
        models: Object.entries(ENDPOINTS).map(([id, m]) => ({ id, label: m.label })),
      });
    }
    if (p === "/api/imagine" && req.method === "POST") return handleImagine(req, res);
    const st = p.match(/^\/api\/status\/([\w-]+)$/);
    if (st) return handleStatus(res, st[1]);
    const rs = p.match(/^\/api\/result\/([\w-]+)$/);
    if (rs) return handleResult(res, rs[1]);
    if (p.startsWith("/api/")) return sendJson(res, 404, { detail: "없는 엔드포인트" });
    return serveStatic(res, p);
  } catch (e) {
    sendJson(res, 500, { detail: "서버 오류 — " + e.message });
  }
});

server.listen(PORT, () => {
  console.log(`드림캔버스 → http://localhost:${PORT}`);
  console.log(FAL_KEY
    ? `  FAL_KEY 감지됨 (${FAL_KEY.slice(0, 4)}…, ${FAL_KEY.length}자) — fal.ai 실연동 사용 가능`
    : "  FAL_KEY 없음 — .env 에 넣거나 환경변수로 주세요. 지금은 목업 모드만 동작합니다.");
});
