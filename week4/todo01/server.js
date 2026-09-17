// todo01 서버 — 투두를 텍스트 파일 한 장(data/todos.txt)에 저장한다.
//   실행: node server.js  →  http://localhost:8788
// 외부 의존성 없이 Node 표준 모듈만 사용한다.
//
// 저장 파일이 원본이다. 메모장으로 직접 고쳐도 되고, 서버는 그걸 그대로 읽는다.
//   [x]<TAB>id<TAB>만든시각<TAB>우선순위<TAB>완료시각<TAB>할 일
//   탭이 없는 줄은 "할 일" 한 줄로 보고 서버가 나머지 칸을 채워 준다.
//
// 엔드포인트
//   GET    /api/todos        { todos, raw, file }
//   POST   /api/todos        { text, priority }        한 건 추가
//   PATCH  /api/todos/:id    { done?, text?, priority? } 한 건 수정
//   DELETE /api/todos/:id                               한 건 삭제
//   POST   /api/todos/clear-done                        완료된 것 일괄 삭제
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

const PORT = Number(process.env.PORT) || 8788;
const TODO_FILE = path.resolve(ROOT, process.env.TODO_FILE || "data/todos.txt");
const PRIORITIES = ["높음", "보통", "낮음"];
const HEADER = [
  "# todo01 저장 파일 — 이 파일이 원본입니다. 메모장으로 직접 고쳐도 됩니다.",
  "# 상태[ ]/[x] <TAB> id <TAB> 만든시각 <TAB> 우선순위 <TAB> 완료시각 <TAB> 할 일",
  "# 탭 없이 한 줄만 적어도 됩니다. 그러면 나머지 칸은 서버가 채웁니다.",
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
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

/* ---------- 시각 · id ---------- */
const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const newId = () => Math.random().toString(36).slice(2, 8);

/* ---------- txt ↔ 배열 ---------- */
const esc = (s) => String(s).replace(/\t/g, " ").replace(/\r?\n/g, " ").trim();

function parse(text) {
  const todos = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const cols = raw.split("\t");
    if (cols.length >= 6) {
      const [state, id, created, priority, doneAt, ...rest] = cols;
      todos.push({
        id: (id || "").trim() || newId(),
        done: /\[x\]/i.test(state),
        created: (created || "").trim() || stamp(),
        priority: PRIORITIES.includes((priority || "").trim()) ? priority.trim() : "보통",
        doneAt: (doneAt || "").trim() === "-" ? "" : (doneAt || "").trim(),
        text: rest.join("\t").trim(),
      });
      continue;
    }
    // 사람이 손으로 적은 줄 — 앞의 [ ] / [x] 만 읽고 나머지는 내용으로 본다
    const m = line.match(/^\[([ xX])\]\s*(.*)$/);
    todos.push({
      id: newId(),
      done: m ? m[1].toLowerCase() === "x" : false,
      created: stamp(),
      priority: "보통",
      doneAt: "",
      text: (m ? m[2] : line).trim(),
    });
  }
  return todos.filter((t) => t.text);
}

function serialize(todos) {
  const lines = todos.map((t) =>
    [t.done ? "[x]" : "[ ]", t.id, t.created, t.priority, t.doneAt || "-", t.text].join("\t")
  );
  return HEADER.concat(lines).join("\r\n") + "\r\n";
}

async function load() {
  try {
    const text = await fsp.readFile(TODO_FILE, "utf8");
    return { todos: parse(text), raw: text };
  } catch (e) {
    if (e.code === "ENOENT") return { todos: [], raw: "" };
    throw e;
  }
}

// 임시 파일에 쓰고 rename — 쓰다가 죽어도 원본이 반쯤 날아가지 않는다
async function save(todos) {
  const raw = serialize(todos);
  await fsp.mkdir(path.dirname(TODO_FILE), { recursive: true });
  const tmp = TODO_FILE + ".tmp";
  await fsp.writeFile(tmp, raw, "utf8");
  await fsp.rename(tmp, TODO_FILE);
  return raw;
}

const payload = (todos, raw) => ({
  todos,
  raw,
  file: TODO_FILE,
  fileName: path.relative(ROOT, TODO_FILE).replace(/\\/g, "/"),
  priorities: PRIORITIES,
});

/* ---------- 핸들러 ---------- */
async function apiTodos(req, res, id) {
  const method = req.method;

  if (method === "GET") {
    const { todos, raw } = await load();
    return sendJson(res, 200, payload(todos, raw));
  }

  let body = {};
  if (method === "POST" || method === "PATCH") {
    try { body = JSON.parse((await readBody(req)) || "{}"); }
    catch { return sendJson(res, 400, { detail: "JSON 본문을 읽을 수 없습니다." }); }
  }

  const { todos } = await load();

  if (method === "POST" && !id) {
    const text = esc(body.text || "");
    if (!text) return sendJson(res, 400, { detail: "할 일 내용이 비어 있습니다." });
    if (text.length > 500) return sendJson(res, 400, { detail: "할 일은 500자까지 적을 수 있습니다." });
    const todo = {
      id: newId(),
      done: false,
      created: stamp(),
      priority: PRIORITIES.includes(body.priority) ? body.priority : "보통",
      doneAt: "",
      text,
    };
    todos.push(todo);
    const raw = await save(todos);
    return sendJson(res, 201, Object.assign({ created: todo }, payload(todos, raw)));
  }

  const i = todos.findIndex((t) => t.id === id);
  if (i < 0) return sendJson(res, 404, { detail: "그런 할 일이 없습니다 (파일이 바뀌었을 수 있습니다)." });

  if (method === "PATCH") {
    const t = todos[i];
    if (typeof body.done === "boolean") {
      t.done = body.done;
      t.doneAt = body.done ? stamp() : "";
    }
    if (typeof body.text === "string") {
      const text = esc(body.text);
      if (!text) return sendJson(res, 400, { detail: "할 일 내용이 비어 있습니다." });
      t.text = text.slice(0, 500);
    }
    if (PRIORITIES.includes(body.priority)) t.priority = body.priority;
    const raw = await save(todos);
    return sendJson(res, 200, Object.assign({ updated: t }, payload(todos, raw)));
  }

  if (method === "DELETE") {
    todos.splice(i, 1);
    const raw = await save(todos);
    return sendJson(res, 200, payload(todos, raw));
  }

  return sendJson(res, 405, { detail: "지원하지 않는 메서드" });
}

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
    if (p === "/api/todos") return await apiTodos(req, res, null);

    if (p === "/api/todos/clear-done" && req.method === "POST") {
      const { todos } = await load();
      const left = todos.filter((t) => !t.done);
      const raw = await save(left);
      return sendJson(res, 200, payload(left, raw));
    }

    const m = p.match(/^\/api\/todos\/([\w-]+)$/);
    if (m) return await apiTodos(req, res, m[1]);

    if (p === "/api/file") {                       // 저장된 txt 원본 그대로 보기
      const { raw } = await load();
      return send(res, 200, raw || "(아직 비어 있습니다)", MIME[".txt"]);
    }
    if (p.startsWith("/api/")) return sendJson(res, 404, { detail: "없는 엔드포인트" });
    return serveStatic(res, p);
  } catch (e) {
    sendJson(res, 500, { detail: "서버 오류 — " + e.message });
  }
});

server.listen(PORT, () => {
  console.log(`todo01 → http://localhost:${PORT}`);
  console.log(`  저장 파일: ${TODO_FILE}`);
  console.log("  (TODO_FILE / PORT 환경변수 또는 .env 로 바꿀 수 있습니다)");
});
