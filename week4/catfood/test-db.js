// db.js 검증 — 진짜 DB 없이 pg-mem(인메모리 PostgreSQL)에 같은 SQL 을 실행한다.
//   실행: npm run test:db
const { newDb } = require("pg-mem");
const { makeStore, validate, ticket, maskEmail, maskName } = require("./db");

const mem = newDb();
const { Pool } = mem.adapters.createPg();
const pool = new Pool();
const store = makeStore(async (sql, args) => (await pool.query(sql, args)).rows);

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log("  ✔ " + label); }
  else { fail++; console.log("  ✘ " + label + (extra ? " — " + extra : "")); }
};
const rejects = async (fn) => { try { await fn(); return false; } catch { return true; } };

const ok = {
  name: "홍길동", email: "Hong@Example.COM", phone: "010-1234-5678",
  topic: "배송 문의", option: "연어 / 3kg", message: "제주도도 당일 출고되나요?", agreed: true,
};

(async () => {
  console.log("catfood db.js 검증 (pg-mem)\n");
  await store.init();
  check("스키마 생성", true);

  /* ---- 입력 검증 ---- */
  check("정상 입력 통과", Object.keys(validate(ok).errors).length === 0, JSON.stringify(validate(ok).errors));
  check("이메일 소문자로 정규화", validate(ok).value.email === "hong@example.com");
  check("이름 없으면 거부", !!validate({ ...ok, name: "  " }).errors.name);
  check("이메일 형식 거부", !!validate({ ...ok, email: "hong@example" }).errors.email);
  check("연락처 문자 거부", !!validate({ ...ok, phone: "전화주세요" }).errors.phone);
  check("연락처 비워도 통과", !validate({ ...ok, phone: "" }).errors.phone);
  check("짧은 내용 거부", !!validate({ ...ok, message: "안녕" }).errors.message);
  check("미동의 거부", !!validate({ ...ok, agreed: false }).errors.agreed);
  check("모르는 문의유형은 기본값으로", validate({ ...ok, topic: "아무거나" }).value.topic === "상품 문의");
  check("긴 내용은 2000자로 자름", validate({ ...ok, message: "가".repeat(3000) }).value.message.length === 2000);

  /* ---- 저장 ---- */
  const a = await store.create(ok);
  check("문의 저장", !!a.id && a.email === "hong@example.com", JSON.stringify(a));
  check("접수번호 형식", /^\d{4}-\d{4}-\d{4}$/.test(a.ticket), a.ticket);
  check("선택 옵션 보관", a.option === "연어 / 3kg");
  check("기본 상태 접수", a.status === "접수");
  check("잘못된 입력은 저장 거부", await rejects(() => store.create({ ...ok, email: "nope" })));

  await store.create({ ...ok, name: "김", email: "cat@lover.co.kr", topic: "대량 구매", message: "20봉 견적 부탁드립니다." });

  /* ---- 조회 ---- */
  const list = await store.list();
  check("관리자 목록 2건", list.length === 2, "실제 " + list.length);
  check("최신순 정렬", list[0].topic === "대량 구매", list[0].topic);

  const pub = await store.recentPublic(5);
  check("공개 목록은 이름 마스킹", pub[1].name === "홍**", pub[1].name);
  check("공개 목록은 이메일 마스킹", pub[1].email === "ho**@example.com", pub[1].email);
  check("공개 목록에 본문 없음", pub[0].message === undefined);
  check("한 글자 이름 마스킹", maskName("김") === "김");
  check("이메일 마스킹 규칙", maskEmail("ab@x.com") === "ab*@x.com", maskEmail("ab@x.com"));

  /* ---- 상태 ---- */
  const done = await store.setStatus(a.id, "답변완료");
  check("상태 변경", done.status === "답변완료");
  check("모르는 상태값 거부", await rejects(() => store.setStatus(a.id, "대기")));
  check("없는 id 거부", await rejects(() => store.setStatus(999999, "처리중")));

  const st = await store.stats();
  check("통계", st.total === 2 && st.answered === 1, JSON.stringify(st));

  check("접수번호 자릿수 채움", ticket(7, new Date("2026-09-17")) === "2026-0917-0007", ticket(7, new Date("2026-09-17")));

  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\n테스트 중 예외:", e); process.exit(1); });
