// db.js 검사 — 진짜 PostgreSQL 없이 pg-mem(인메모리 DB) 위에서 같은 SQL 을 돌린다.
//   실행: node test-db.js
// makeStore 가 query/tx 를 주입받는 구조라서 드라이버만 바꿔 끼우면 그대로 돌아간다.

const assert = require("node:assert");
const { newDb } = require("pg-mem");
const { makeStore, cleanEmail, cleanNickname, checkEmail, checkPassword } = require("./db");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log("  ok    " + name); }
  catch (e) { fail++; console.log("  FAIL  " + name + "\n        " + (e && e.message)); }
}

/** pg-mem 의 pg 어댑터를 쓰면 $1 파라미터 바인딩과 트랜잭션이 진짜처럼 동작한다. */
async function freshStore() {
  const pool = new (newDb().adapters.createPg().Pool)();
  const query = async (sql, args) => (await pool.query(sql, args)).rows;
  const tx = async (fn) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(async (sql, args) => (await c.query(sql, args)).rows);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      try { await c.query("ROLLBACK"); } catch { /* 무시 */ }
      throw e;
    } finally { c.release(); }
  };
  const store = makeStore(query, tx);
  await store.init();
  return store;
}

const HOUR = 3600 * 1000;
const later = (ms) => new Date(Date.now() + ms);

(async () => {
  console.log("db.js — pg-mem 위에서 검사\n");

  /* ---------- 입력 규칙 ---------- */

  await test("이메일은 공백을 털고 소문자로 맞춘다", () => {
    assert.strictEqual(cleanEmail("  YuDang@Example.COM "), "yudang@example.com");
    assert.strictEqual(cleanEmail(null), "");
  });

  await test("이메일 형식을 거른다", () => {
    assert.strictEqual(checkEmail("a@b.co"), null);
    for (const bad of ["", "a", "a@b", "a b@c.co", "@b.co", "a@.co"]) {
      assert.ok(checkEmail(bad), "통과하면 안 되는 값: " + bad);
    }
  });

  await test("비밀번호 규칙 — 8자 이상 · 영문 + 숫자", () => {
    assert.strictEqual(checkPassword("hunter2024"), null);
    for (const bad of ["", "short1", "12345678", "abcdefgh", "a".repeat(201) + "1"]) {
      assert.ok(checkPassword(bad), "통과하면 안 되는 값: " + bad);
    }
  });

  await test("닉네임을 안 적으면 이메일 앞부분을 쓴다", () => {
    assert.strictEqual(cleanNickname("", "yudang@example.com"), "yudang");
    assert.strictEqual(cleanNickname("  유  댕  ", "a@b.co"), "유 댕");
    assert.strictEqual(cleanNickname("가".repeat(40), "a@b.co").length, 20);
  });

  /* ---------- 계정 ---------- */

  await test("가입하면 계정이 생기고, 나오는 값에 해시가 없다", async () => {
    const store = await freshStore();
    assert.strictEqual(await store.countUsers(), 0);
    const user = await store.createUser({ email: "a@b.co", nickname: "유댕", passwordHash: "scrypt$fake" });
    assert.strictEqual(user.email, "a@b.co");
    assert.strictEqual(user.nickname, "유댕");
    assert.ok(typeof user.id === "number");
    assert.ok(!("password_hash" in user) && !("passwordHash" in user), "해시가 새어 나온다");
    assert.strictEqual(await store.countUsers(), 1);
  });

  await test("같은 이메일로 또 가입하면 409 로 막힌다", async () => {
    const store = await freshStore();
    await store.createUser({ email: "a@b.co", nickname: "하나", passwordHash: "h1" });
    await assert.rejects(
      () => store.createUser({ email: "a@b.co", nickname: "둘", passwordHash: "h2" }),
      (e) => e.status === 409
    );
    assert.strictEqual(await store.countUsers(), 1);
  });

  await test("findForLogin 만 해시를 같이 준다", async () => {
    const store = await freshStore();
    await store.createUser({ email: "a@b.co", nickname: "유댕", passwordHash: "scrypt$real" });
    const found = await store.findForLogin("a@b.co");
    assert.strictEqual(found.passwordHash, "scrypt$real");
    assert.ok(!("password_hash" in found.user));
    assert.strictEqual(await store.findForLogin("none@b.co"), null);
  });

  await test("닉네임을 바꾸면 반영된다", async () => {
    const store = await freshStore();
    const u = await store.createUser({ email: "a@b.co", nickname: "옛날", passwordHash: "h" });
    const updated = await store.updateNickname(u.id, "새이름");
    assert.strictEqual(updated.nickname, "새이름");
    assert.strictEqual((await store.findById(u.id)).nickname, "새이름");
  });

  /* ---------- 세션 ---------- */

  await test("세션을 만들면 토큰 해시로 찾을 수 있다", async () => {
    const store = await freshStore();
    const u = await store.createUser({ email: "a@b.co", nickname: "유댕", passwordHash: "h" });
    await store.createSession({ userId: u.id, tokenHash: "hash1", expiresAt: later(HOUR), userAgent: "test", ip: "1.1.1.1" });

    const found = await store.findSession("hash1");
    assert.ok(found, "세션을 못 찾았다");
    assert.strictEqual(found.user.id, u.id);
    assert.strictEqual(await store.findSession("없는해시"), null);
  });

  await test("만료된 세션은 없는 것으로 친다", async () => {
    const store = await freshStore();
    const u = await store.createUser({ email: "a@b.co", nickname: "유댕", passwordHash: "h" });
    await store.createSession({ userId: u.id, tokenHash: "old", expiresAt: later(-HOUR) });
    assert.strictEqual(await store.findSession("old"), null);
    assert.strictEqual((await store.listSessions(u.id)).length, 0);
    assert.strictEqual(await store.sweepSessions(), 1);
  });

  await test("토큰 회전 — 옛 토큰은 죽고 새 토큰이 산다", async () => {
    const store = await freshStore();
    const u = await store.createUser({ email: "a@b.co", nickname: "유댕", passwordHash: "h" });
    await store.createSession({ userId: u.id, tokenHash: "first", expiresAt: later(HOUR) });
    const s = await store.findSession("first");

    await store.rotateSession(s.sessionId, "second", later(HOUR));
    assert.strictEqual(await store.findSession("first"), null, "옛 토큰이 아직 통한다");
    assert.ok(await store.findSession("second"), "새 토큰이 안 통한다");
    assert.strictEqual((await store.listSessions(u.id)).length, 1, "세션이 늘어났다");
  });

  await test("로그아웃은 그 세션만 지운다", async () => {
    const store = await freshStore();
    const u = await store.createUser({ email: "a@b.co", nickname: "유댕", passwordHash: "h" });
    await store.createSession({ userId: u.id, tokenHash: "pc", expiresAt: later(HOUR) });
    await store.createSession({ userId: u.id, tokenHash: "phone", expiresAt: later(HOUR) });

    assert.strictEqual(await store.deleteSession("pc"), 1);
    assert.strictEqual(await store.deleteSession("pc"), 0, "두 번 지워진다");
    const left = await store.listSessions(u.id);
    assert.strictEqual(left.length, 1);
  });

  await test("남의 세션은 id 를 알아도 못 지운다", async () => {
    const store = await freshStore();
    const me = await store.createUser({ email: "me@b.co", nickname: "나", passwordHash: "h" });
    const you = await store.createUser({ email: "you@b.co", nickname: "너", passwordHash: "h" });
    await store.createSession({ userId: you.id, tokenHash: "yours", expiresAt: later(HOUR) });
    const [yours] = await store.listSessions(you.id);

    assert.strictEqual(await store.deleteSessionById(me.id, yours.id), 0, "남의 세션이 지워졌다");
    assert.strictEqual((await store.listSessions(you.id)).length, 1);
  });

  await test("비밀번호를 바꾸면 이 기기만 남고 나머지는 끊긴다", async () => {
    const store = await freshStore();
    const u = await store.createUser({ email: "a@b.co", nickname: "유댕", passwordHash: "old" });
    await store.createSession({ userId: u.id, tokenHash: "here", expiresAt: later(HOUR) });
    await store.createSession({ userId: u.id, tokenHash: "phone", expiresAt: later(HOUR) });
    await store.createSession({ userId: u.id, tokenHash: "cafe", expiresAt: later(HOUR) });

    await store.updatePassword(u.id, "new", { keepTokenHash: "here" });

    assert.strictEqual(await store.passwordHashOf(u.id), "new");
    assert.ok(await store.findSession("here"), "지금 기기까지 끊겼다");
    assert.strictEqual(await store.findSession("phone"), null);
    assert.strictEqual(await store.findSession("cafe"), null);
  });

  await test("전부 로그아웃하면 세션이 남지 않는다", async () => {
    const store = await freshStore();
    const u = await store.createUser({ email: "a@b.co", nickname: "유댕", passwordHash: "h" });
    for (const t of ["a", "b", "c"]) await store.createSession({ userId: u.id, tokenHash: t, expiresAt: later(HOUR) });
    assert.strictEqual(await store.deleteAllSessions(u.id), 3);
    assert.strictEqual((await store.listSessions(u.id)).length, 0);
  });

  console.log(`\n${pass} 통과 · ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
