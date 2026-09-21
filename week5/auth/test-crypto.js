// crypto.js 검사 — 비밀번호 해시와 JWT 서명·검증.
//   실행: node test-crypto.js
// 인증에서 제일 조용히 망가지는 자리라서, "통과해야 하는 것" 보다 "막아야 하는 것" 을 더 많이 본다.

const assert = require("node:assert");
const nodeCrypto = require("node:crypto");
const { hashPassword, verifyPassword, signJwt, verifyJwt, newRefreshToken, hashToken } = require("./crypto");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log("  ok    " + name); }
  catch (e) { fail++; console.log("  FAIL  " + name + "\n        " + (e && e.message)); }
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const SECRET = "test-secret-do-not-use";

(async () => {
  console.log("crypto.js — 비밀번호 · JWT\n");

  /* ---------- 비밀번호 ---------- */

  await test("맞는 비밀번호는 통과한다", async () => {
    const stored = await hashPassword("hunter2024");
    assert.strictEqual(await verifyPassword("hunter2024", stored), true);
  });

  await test("틀린 비밀번호는 막힌다", async () => {
    const stored = await hashPassword("hunter2024");
    assert.strictEqual(await verifyPassword("hunter2025", stored), false);
    assert.strictEqual(await verifyPassword("", stored), false);
  });

  await test("원문이 저장 문자열에 남지 않는다", async () => {
    const stored = await hashPassword("hunter2024");
    assert.ok(!stored.includes("hunter2024"), "해시 안에 비밀번호가 보인다");
  });

  await test("같은 비밀번호라도 저장값이 매번 다르다 (salt)", async () => {
    const a = await hashPassword("hunter2024");
    const b = await hashPassword("hunter2024");
    assert.notStrictEqual(a, b);
    assert.strictEqual(await verifyPassword("hunter2024", a), true);
    assert.strictEqual(await verifyPassword("hunter2024", b), true);
  });

  await test("저장값이 깨져 있어도 던지지 않고 false 를 준다", async () => {
    for (const junk of ["", "x", "scrypt$", "bcrypt$1$2$3$4$5", null, undefined, "scrypt$a$b$c$d$e"]) {
      assert.strictEqual(await verifyPassword("hunter2024", junk), false, String(junk));
    }
  });

  /* ---------- JWT ---------- */

  await test("서명한 토큰은 검증되고 내용이 그대로 나온다", () => {
    const token = signJwt({ sub: "42", email: "a@b.co" }, SECRET, 60);
    const out = verifyJwt(token, SECRET);
    assert.ok(out);
    assert.strictEqual(out.sub, "42");
    assert.strictEqual(out.email, "a@b.co");
    assert.ok(out.exp > out.iat);
  });

  await test("다른 키로는 검증되지 않는다", () => {
    const token = signJwt({ sub: "42" }, SECRET, 60);
    assert.strictEqual(verifyJwt(token, "another-secret"), null);
  });

  await test("내용을 고치면 검증이 깨진다", () => {
    const token = signJwt({ sub: "42" }, SECRET, 60);
    const [h, , s] = token.split(".");
    const forged = [h, b64({ sub: "1", iat: 1, exp: 9999999999 }), s].join(".");
    assert.strictEqual(verifyJwt(forged, SECRET), null);
  });

  await test("만료된 토큰은 거절한다", () => {
    const token = signJwt({ sub: "42" }, SECRET, -10);   // 10초 전에 만료
    assert.strictEqual(verifyJwt(token, SECRET), null);
  });

  await test('alg:"none" 토큰은 거절한다', () => {
    // 서명 없이 "나는 검증할 필요 없는 토큰이야" 라고 주장하는 고전적인 공격
    const forged = [b64({ alg: "none", typ: "JWT" }), b64({ sub: "1", exp: 9999999999 }), ""].join(".");
    assert.strictEqual(verifyJwt(forged, SECRET), null);
  });

  await test("HS256 이 아닌 alg 는 거절한다", () => {
    const head = b64({ alg: "HS512", typ: "JWT" });
    const body = b64({ sub: "1", exp: 9999999999 });
    const sig = nodeCrypto.createHmac("sha512", SECRET).update(head + "." + body).digest("base64url");
    assert.strictEqual(verifyJwt([head, body, sig].join("."), SECRET), null);
  });

  await test("모양이 아닌 값은 전부 거절한다", () => {
    for (const junk of ["", "a.b", "a.b.c.d", null, undefined, 42, {}, "...."]) {
      assert.strictEqual(verifyJwt(junk, SECRET), null, String(junk));
    }
  });

  /* ---------- 리프레시 토큰 ---------- */

  await test("리프레시 토큰은 매번 다르고 충분히 길다", () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const t = newRefreshToken();
      assert.ok(t.length >= 40, "토큰이 너무 짧다: " + t.length);
      assert.ok(!seen.has(t), "토큰이 겹쳤다");
      seen.add(t);
    }
  });

  await test("토큰 해시는 같은 값에 같은 결과, 다른 값에 다른 결과", () => {
    const t = newRefreshToken();
    assert.strictEqual(hashToken(t), hashToken(t));
    assert.notStrictEqual(hashToken(t), hashToken(newRefreshToken()));
    assert.ok(!hashToken(t).includes(t), "해시 안에 원문이 보인다");
  });

  console.log(`\n${pass} 통과 · ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
