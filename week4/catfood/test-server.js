// server.js + api/_lib.js 통합 검증 — require('pg') 를 pg-mem 으로 바꿔치기해 HTTP 왕복을 그대로 돌린다.
//   실행: npm run test:api
const Module = require("node:module");
const { newDb } = require("pg-mem");

const mem = newDb();
const memPg = mem.adapters.createPg();
const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "pg") return memPg;
  return realRequire.apply(this, arguments);
};

const PORT = 8795;
process.env.DATABASE_URL = "postgresql://tester:secret@localhost:5432/catfood_test";
process.env.PORT = String(PORT);
process.env.PGSSL = "off";
process.env.ADMIN_TOKEN = "test-admin-token";
process.env.RATE_LIMIT = "3";

// localhost 로 부르면 요청마다 ::1 / 127.0.0.1 로 갈릴 수 있어 IP 기준 제한 검증이 흔들린다
const BASE = "http://127.0.0.1:" + PORT;
let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log("  ✔ " + label); }
  else { fail++; console.log("  ✘ " + label + (extra ? " — " + extra : "")); }
};
const call = async (p, init) => {
  const res = await fetch(BASE + p, init);
  const type = res.headers.get("content-type") || "";
  const body = type.includes("json") ? await res.json().catch(() => null) : await res.text();
  return { status: res.status, body };
};
const post = (p, obj, headers) => call(p, {
  method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, headers || {}), body: JSON.stringify(obj || {}),
});

const ok = {
  name: "홍길동", email: "hong@example.com", phone: "010-1234-5678",
  topic: "배송 문의", option: "연어 / 3kg", message: "제주도도 당일 출고되나요?", agreed: true,
};

require("./server.js");

setTimeout(async () => {
  console.log("catfood 통합 검증 (pg-mem 을 pg 자리에 끼움)\n");
  try {
    const h = await call("/api/health");
    check("GET /api/health 연결됨", h.status === 200 && h.body.connected === true, JSON.stringify(h.body.detail));
    check("문의 유형 목록 내려줌", Array.isArray(h.body.topics) && h.body.topics.length >= 3);
    check("비밀번호는 응답에 없음", !JSON.stringify(h.body).includes("secret"));

    const c1 = await post("/api/inquiries", ok);
    check("POST /api/inquiries 201", c1.status === 201, JSON.stringify(c1.body).slice(0, 120));
    check("접수번호 발급", /^\d{4}-\d{4}-\d{4}$/.test(c1.body.ticket || ""), c1.body.ticket);
    check("응답에 본문·이메일 안 실림", !JSON.stringify(c1.body).includes("hong@example.com"));
    check("최근 목록은 마스킹된 채로 옴", (c1.body.recent || [])[0].name === "홍**", JSON.stringify((c1.body.recent || [])[0]));

    const bad = await post("/api/inquiries", { ...ok, email: "틀린이메일", message: "짧" });
    check("검증 실패 400", bad.status === 400, "status " + bad.status);
    check("필드별 오류 내려줌", bad.body.errors && bad.body.errors.email && bad.body.errors.message, JSON.stringify(bad.body.errors));
    const noAgree = await post("/api/inquiries", { ...ok, agreed: false });
    check("동의 안 하면 400", noAgree.status === 400 && !!noAgree.body.errors.agreed);

    const pub = await call("/api/inquiries?recent=1");
    check("공개 최근 목록 200", pub.status === 200 && pub.body.recent.length === 1);
    check("공개 목록에 본문 없음", !JSON.stringify(pub.body).includes("제주도"));

    const locked = await call("/api/inquiries");
    check("토큰 없으면 목록 401", locked.status === 401, "status " + locked.status);
    const wrong = await call("/api/inquiries", { headers: { "x-admin-token": "nope" } });
    check("틀린 토큰 401", wrong.status === 401);
    const admin = await call("/api/inquiries", { headers: { "x-admin-token": "test-admin-token" } });
    check("관리자 토큰이면 전체 조회", admin.status === 200 && admin.body.inquiries[0].message.includes("제주도"), "status " + admin.status);

    /* ---- 관리자 상태 변경 ---- */
    const target = admin.body.inquiries[0];
    const noTok = await call("/api/inquiries?id=" + target.id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "처리중" }) });
    check("토큰 없이 상태 변경 401", noTok.status === 401, "status " + noTok.status);

    const patched = await call("/api/inquiries?id=" + target.id, {
      method: "PATCH", headers: { "Content-Type": "application/json", "x-admin-token": "test-admin-token" },
      body: JSON.stringify({ status: "답변완료" }),
    });
    check("관리자 상태 변경", patched.status === 200 && patched.body.updated.status === "답변완료", JSON.stringify(patched.body.detail));
    check("통계에 반영", patched.body.stats.answered === 1, JSON.stringify(patched.body.stats));

    const badStatus = await call("/api/inquiries?id=" + target.id, {
      method: "PATCH", headers: { "Content-Type": "application/json", "x-admin-token": "test-admin-token" },
      body: JSON.stringify({ status: "대기" }),
    });
    check("모르는 상태값 400", badStatus.status === 400, "status " + badStatus.status);

    const noId = await call("/api/inquiries", {
      method: "PATCH", headers: { "Content-Type": "application/json", "x-admin-token": "test-admin-token" },
      body: JSON.stringify({ status: "처리중" }),
    });
    check("id 없으면 400", noId.status === 400, "status " + noId.status);

    const adminPage = await call("/admin.html");
    check("관리자 페이지 서빙", adminPage.status === 200 && String(adminPage.body).includes("문의 관리"));

    // 위에서 POST 를 3건(성공 1 + 검증실패 2) 보냈다. RATE_LIMIT=3 이므로 다음 건은 막혀야 한다
    const limited = await post("/api/inquiries", { ...ok, message: "도배 테스트입니다." });
    check("같은 IP 연속 문의 429", limited.status === 429, "status " + limited.status);

    const page = await call("/");
    check("GET / 상품 페이지", page.status === 200 && String(page.body).includes("하루한끼"));
    check("문의 폼 포함", String(page.body).includes("문의 보내기"));
    const envFile = await call("/.env");
    check("GET /.env 차단(403)", envFile.status === 403, "status " + envFile.status);
    const libFile = await call("/api/_lib.js");
    check("서버 코드 직접 접근 차단", libFile.status === 403 || libFile.status === 404, "status " + libFile.status);
    const nope = await call("/api/없는것");
    check("없는 API 404", nope.status === 404);

    console.log(`\n통과 ${pass} · 실패 ${fail}`);
  } catch (e) {
    console.error("\n테스트 중 예외:", e);
    fail++;
  }
  process.exit(fail ? 1 : 0);
}, 700);
