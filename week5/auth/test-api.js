// handler.js 검사 — pg 드라이버 자리에 pg-mem 을 끼워 넣고 진짜 HTTP 요청을 보낸다.
//   실행: node test-api.js
// Supabase 없이도 라우팅·상태코드·쿠키·토큰 흐름을 그대로 확인할 수 있다.

const assert = require("node:assert");
const Module = require("node:module");
const { newDb } = require("pg-mem");

/* ---------- pg 를 pg-mem 으로 바꿔치기 (server.js 를 require 하기 전에) ---------- */
const mem = newDb();
const pgShim = mem.adapters.createPg();

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "pg") return pgShim;
  return load.apply(this, [request, ...rest]);
};

process.env.DATABASE_URL = "postgresql://tester:pw@localhost:5432/memdb";
process.env.PGSSL = "off";
process.env.JWT_SECRET = "test-secret-for-api-test";

const { server } = require("./server.js");
const { signJwt } = require("./crypto");

/* ---------- 테스트 도구 ---------- */
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log("  ok    " + name); }
  catch (e) { fail++; console.log("  FAIL  " + name + "\n        " + (e && e.message)); }
}

let base = "";

/**
 * 브라우저 흉내 — 쿠키를 기억하는 하나의 "기기".
 * fetch 는 쿠키를 자동으로 챙겨주지 않으므로 직접 담았다 꺼낸다.
 */
function device() {
  const jar = new Map();
  let accessToken = null;

  async function call(method, path, body, { auth = true } = {}) {
    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (auth && accessToken) headers.Authorization = "Bearer " + accessToken;
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) headers.Cookie = cookie;

    const res = await fetch(base + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });

    // Set-Cookie 반영 (Max-Age=0 이면 지운다)
    for (const line of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1).trim();
      if (attrs.some((a) => /max-age=0/i.test(a.trim())) || !v) jar.delete(k);
      else jar.set(k, v);
    }

    let data = null;
    try { data = await res.json(); } catch { /* 본문 없음 */ }
    if (data && data.accessToken) accessToken = data.accessToken;
    return { status: res.status, data, cookies: jar };
  }

  return {
    call,
    get: (p, o) => call("GET", p, null, o),
    post: (p, b, o) => call("POST", p, b, o),
    patch: (p, b, o) => call("PATCH", p, b, o),
    del: (p, o) => call("DELETE", p, null, o),
    hasRefreshCookie: () => jar.has("rt"),
    token: () => accessToken,
    setToken: (t) => { accessToken = t; },
  };
}

let n = 0;
const freshEmail = () => `user${++n}@example.com`;
const PW = "hunter2024";

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
  console.log("handler.js — pg-mem 위에서 HTTP 검사 (" + base + ")\n");

  /* ---------- 상태 ---------- */

  await test("GET /api/health — 연결됨으로 나오고 비밀은 안 나온다", async () => {
    const { status, data } = await device().get("/api/health");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.connected, true, data.detail || "");
    assert.strictEqual(data.auth.secret, "환경변수");
    assert.ok(!JSON.stringify(data).includes("test-secret-for-api-test"), "JWT 키가 새어 나온다");
  });

  /* ---------- 가입 ---------- */

  await test("POST /api/auth/signup — 가입하면 201 + 토큰 + 쿠키", async () => {
    const d = device();
    const { status, data } = await d.post("/api/auth/signup", { email: freshEmail(), password: PW, nickname: "유댕" });
    assert.strictEqual(status, 201, JSON.stringify(data));
    assert.ok(data.accessToken, "액세스 토큰이 없다");
    assert.strictEqual(data.user.nickname, "유댕");
    assert.ok(d.hasRefreshCookie(), "리프레시 쿠키가 안 내려왔다");
    assert.ok(!JSON.stringify(data).includes("scrypt$"), "비밀번호 해시가 응답에 있다");
  });

  await test("가입 — 닉네임을 비우면 이메일 앞부분이 된다", async () => {
    const { data } = await device().post("/api/auth/signup", { email: "nonick@example.com", password: PW });
    assert.strictEqual(data.user.nickname, "nonick");
  });

  await test("가입 — 잘못된 입력은 400", async () => {
    const d = device();
    const cases = [
      [{ email: "not-an-email", password: PW }, "이메일 형식"],
      [{ email: freshEmail(), password: "short1" }, "짧은 비밀번호"],
      [{ email: freshEmail(), password: "abcdefghij" }, "숫자 없는 비밀번호"],
      [{ email: freshEmail() }, "비밀번호 없음"],
      [{}, "빈 본문"],
    ];
    for (const [body, label] of cases) {
      const { status, data } = await d.post("/api/auth/signup", body);
      assert.strictEqual(status, 400, `${label} 이 통과했다`);
      assert.ok(data.detail, "안내 문구가 없다");
    }
  });

  await test("가입 — 같은 이메일은 409, 대소문자만 다른 것도 같은 계정", async () => {
    const d = device();
    const email = "Dup@Example.com";
    assert.strictEqual((await d.post("/api/auth/signup", { email, password: PW })).status, 201);
    const again = await d.post("/api/auth/signup", { email: "dup@example.com", password: PW });
    assert.strictEqual(again.status, 409, JSON.stringify(again.data));
  });

  /* ---------- 로그인 ---------- */

  await test("POST /api/auth/login — 맞는 비밀번호면 200 + 토큰", async () => {
    const email = freshEmail();
    await device().post("/api/auth/signup", { email, password: PW, nickname: "로그인" });

    const d = device();
    const { status, data } = await d.post("/api/auth/login", { email, password: PW });
    assert.strictEqual(status, 200, JSON.stringify(data));
    assert.ok(data.accessToken);
    assert.strictEqual(data.user.email, email);
    assert.ok(d.hasRefreshCookie());
  });

  await test("로그인 — 없는 계정과 틀린 비밀번호가 같은 답을 준다", async () => {
    const email = freshEmail();
    await device().post("/api/auth/signup", { email, password: PW });

    const wrong = await device().post("/api/auth/login", { email, password: "wrongpass1" });
    const missing = await device().post("/api/auth/login", { email: "nobody@example.com", password: PW });

    assert.strictEqual(wrong.status, 401);
    assert.strictEqual(missing.status, 401);
    // 답이 다르면 어떤 이메일이 가입돼 있는지 캐낼 수 있다
    assert.strictEqual(wrong.data.detail, missing.data.detail, "두 실패의 안내가 다르다");
  });

  await test("로그인 — 여러 번 틀리면 429 로 막는다", async () => {
    const email = freshEmail();
    await device().post("/api/auth/signup", { email, password: PW });
    const d = device();

    let blocked = false;
    for (let i = 0; i < 12; i++) {
      const { status } = await d.post("/api/auth/login", { email, password: "wrongpass1" });
      if (status === 429) { blocked = true; break; }
    }
    assert.ok(blocked, "계속 틀려도 안 막힌다");
  });

  /* ---------- 보호된 엔드포인트 ---------- */

  await test("GET /api/me — 토큰이 있으면 내 정보가 나온다", async () => {
    const email = freshEmail();
    const d = device();
    await d.post("/api/auth/signup", { email, password: PW, nickname: "본인" });

    const { status, data } = await d.get("/api/me");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.user.email, email);
    assert.strictEqual(data.user.nickname, "본인");
  });

  await test("GET /api/me — 토큰이 없거나 이상하면 401", async () => {
    const d = device();
    await d.post("/api/auth/signup", { email: freshEmail(), password: PW });

    assert.strictEqual((await d.get("/api/me", { auth: false })).status, 401, "토큰 없이 통과했다");

    for (const junk of ["", "garbage", "a.b.c", d.token() + "x"]) {
      d.setToken(junk);
      assert.strictEqual((await d.get("/api/me")).status, 401, "이상한 토큰이 통과했다: " + junk);
    }
  });

  await test("GET /api/me — 다른 키로 서명한 토큰은 401", async () => {
    const d = device();
    await d.post("/api/auth/signup", { email: freshEmail(), password: PW });
    d.setToken(signJwt({ sub: "1", email: "x@y.z", nickname: "위조" }, "내가-만든-가짜-키", 600));
    assert.strictEqual((await d.get("/api/me")).status, 401, "위조 토큰이 통과했다");
  });

  await test("GET /api/me — 만료된 토큰은 401", async () => {
    const d = device();
    await d.post("/api/auth/signup", { email: freshEmail(), password: PW });
    d.setToken(signJwt({ sub: "1" }, "test-secret-for-api-test", -60));
    assert.strictEqual((await d.get("/api/me")).status, 401, "만료 토큰이 통과했다");
  });

  await test("PATCH /api/me — 닉네임을 바꾸면 새 토큰도 같이 온다", async () => {
    const d = device();
    await d.post("/api/auth/signup", { email: freshEmail(), password: PW, nickname: "옛날" });
    const before = d.token();

    const { status, data } = await d.patch("/api/me", { nickname: "새이름" });
    assert.strictEqual(status, 200, JSON.stringify(data));
    assert.strictEqual(data.user.nickname, "새이름");
    assert.ok(data.accessToken && data.accessToken !== before, "토큰이 안 바뀌었다");
    assert.strictEqual((await d.get("/api/me")).data.user.nickname, "새이름");
  });

  /* ---------- 리프레시 · 로그아웃 ---------- */

  await test("POST /api/auth/refresh — 쿠키로 새 액세스 토큰을 받는다", async () => {
    const d = device();
    await d.post("/api/auth/signup", { email: freshEmail(), password: PW });
    const first = d.token();

    await new Promise((r) => setTimeout(r, 1100));   // iat/exp 가 초 단위라 1초 이상 띄운다
    const { status, data } = await d.post("/api/auth/refresh");
    assert.strictEqual(status, 200, JSON.stringify(data));
    assert.ok(data.accessToken !== first, "같은 토큰이 다시 왔다");
    assert.strictEqual((await d.get("/api/me")).status, 200, "새 토큰이 안 통한다");
  });

  await test("리프레시 — 쿠키 없이 부르면 401", async () => {
    assert.strictEqual((await device().post("/api/auth/refresh")).status, 401);
  });

  await test("리프레시 — 한 번 쓴 토큰은 다시 안 통한다 (회전)", async () => {
    const d = device();
    await d.post("/api/auth/signup", { email: freshEmail(), password: PW });

    // 한 번 회전시킨 뒤의 쿠키를 따로 챙겨 둔다 ("훔쳐 간 쪽" 이 들고 있는 값)
    const stolen = (await d.post("/api/auth/refresh")).cookies.get("rt");

    await d.post("/api/auth/refresh");                       // 진짜 기기가 두 번째 회전
    const res = await fetch(base + "/api/auth/refresh", {
      method: "POST", headers: { Cookie: "rt=" + stolen },
    });
    assert.strictEqual(res.status, 401, "이미 쓴 리프레시 토큰이 아직 통한다");
  });

  await test("POST /api/auth/logout — 쿠키가 지워지고 리프레시가 막힌다", async () => {
    const d = device();
    await d.post("/api/auth/signup", { email: freshEmail(), password: PW });

    const { status } = await d.post("/api/auth/logout");
    assert.strictEqual(status, 200);
    assert.ok(!d.hasRefreshCookie(), "쿠키가 안 지워졌다");
    assert.strictEqual((await d.post("/api/auth/refresh")).status, 401, "로그아웃 후에도 재발급된다");
  });

  await test("로그아웃 — 안 한 상태에서 불러도 200", async () => {
    assert.strictEqual((await device().post("/api/auth/logout")).status, 200);
  });

  /* ---------- 비밀번호 변경 ---------- */

  await test("POST /api/me/password — 바꾸면 새 비밀번호로만 로그인된다", async () => {
    const email = freshEmail();
    const d = device();
    await d.post("/api/auth/signup", { email, password: PW });

    const { status, data } = await d.post("/api/me/password", { current: PW, next: "newpass2024" });
    assert.strictEqual(status, 200, JSON.stringify(data));

    assert.strictEqual((await device().post("/api/auth/login", { email, password: PW })).status, 401, "옛 비밀번호가 아직 통한다");
    assert.strictEqual((await device().post("/api/auth/login", { email, password: "newpass2024" })).status, 200);
  });

  await test("비밀번호 변경 — 지금 비밀번호가 틀리면 401", async () => {
    const d = device();
    await d.post("/api/auth/signup", { email: freshEmail(), password: PW });
    const { status } = await d.post("/api/me/password", { current: "nottherightone1", next: "newpass2024" });
    assert.strictEqual(status, 401);
  });

  await test("비밀번호 변경 — 새 비밀번호가 규칙에 안 맞으면 400", async () => {
    const d = device();
    await d.post("/api/auth/signup", { email: freshEmail(), password: PW });
    assert.strictEqual((await d.post("/api/me/password", { current: PW, next: "short1" })).status, 400);
    assert.strictEqual((await d.post("/api/me/password", { current: PW, next: PW })).status, 400, "같은 비밀번호가 통과했다");
  });

  await test("비밀번호 변경 — 다른 기기는 로그아웃되고 이 기기는 남는다", async () => {
    const email = freshEmail();
    const pc = device();
    const phone = device();
    await pc.post("/api/auth/signup", { email, password: PW });
    await phone.post("/api/auth/login", { email, password: PW });

    await pc.post("/api/me/password", { current: PW, next: "newpass2024" });

    assert.strictEqual((await pc.post("/api/auth/refresh")).status, 200, "바꾼 기기가 끊겼다");
    assert.strictEqual((await phone.post("/api/auth/refresh")).status, 401, "다른 기기가 안 끊겼다");
  });

  /* ---------- 세션 목록 ---------- */

  await test("GET /api/me/sessions — 기기 두 대가 보이고 지금 기기가 표시된다", async () => {
    const email = freshEmail();
    const pc = device();
    const phone = device();
    await pc.post("/api/auth/signup", { email, password: PW });
    await phone.post("/api/auth/login", { email, password: PW });

    const { status, data } = await pc.get("/api/me/sessions");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.sessions.length, 2, "기기 수가 다르다");
    assert.strictEqual(data.sessions.filter((s) => s.current).length, 1, "지금 기기 표시가 하나가 아니다");
    assert.ok(!JSON.stringify(data).includes("rt="), "토큰이 목록에 들어 있다");
  });

  await test("DELETE /api/me/sessions/:id — 고른 기기만 끊는다", async () => {
    const email = freshEmail();
    const pc = device();
    const phone = device();
    await pc.post("/api/auth/signup", { email, password: PW });
    await phone.post("/api/auth/login", { email, password: PW });

    const { data } = await pc.get("/api/me/sessions");
    const other = data.sessions.find((s) => !s.current);
    assert.strictEqual((await pc.del("/api/me/sessions/" + other.id)).status, 200);

    assert.strictEqual((await phone.post("/api/auth/refresh")).status, 401, "끊긴 기기가 아직 산다");
    assert.strictEqual((await pc.post("/api/auth/refresh")).status, 200, "내 기기가 끊겼다");
  });

  await test("POST /api/me/sessions/logout-all — 전부 끊긴다", async () => {
    const email = freshEmail();
    const pc = device();
    const phone = device();
    await pc.post("/api/auth/signup", { email, password: PW });
    await phone.post("/api/auth/login", { email, password: PW });

    assert.strictEqual((await pc.post("/api/me/sessions/logout-all")).status, 200);
    assert.strictEqual((await pc.post("/api/auth/refresh")).status, 401);
    assert.strictEqual((await phone.post("/api/auth/refresh")).status, 401);
  });

  /* ---------- 잡다 ---------- */

  await test("없는 엔드포인트는 404", async () => {
    assert.strictEqual((await device().get("/api/nope")).status, 404);
  });

  await test("서버 파일은 브라우저로 안 나간다", async () => {
    for (const p of ["/.env", "/.env.example", "/handler.js", "/crypto.js", "/db.js",
                     "/package.json", "/package-lock.json", "/../handler.js"]) {
      const res = await fetch(base + p, { redirect: "manual" });
      const text = await res.text();
      assert.notStrictEqual(res.status, 200, `${p} 가 열린다`);
      assert.ok(!text.includes("JWT_SECRET"), `${p} 내용이 새어 나온다`);
    }
  });

  await test("/ 는 앱 화면을 준다", async () => {
    const res = await fetch(base + "/");
    assert.strictEqual(res.status, 200);
    assert.ok((await res.text()).includes("<!doctype html>"), "index.html 이 아니다");
  });

  console.log(`\n${pass} 통과 · ${fail} 실패`);
  server.close();
  process.exit(fail ? 1 : 0);
})();
