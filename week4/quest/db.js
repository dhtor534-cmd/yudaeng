// 냉장고 앱 데이터 계층 — 스키마와 쿼리만 모아 둔다.
// query / tx 를 주입받으므로 진짜 PostgreSQL(pg) 로도, 테스트용 pg-mem 으로도 똑같이 돌아간다.
// 값은 전부 $1, $2 … 파라미터로 넘긴다 (문자열을 SQL 에 이어 붙이지 않는다).

const CATEGORIES = ["채소", "과일", "육류", "해산물", "유제품", "곡물·면", "양념", "가공식품"];
const STORAGES = ["냉장", "냉동", "실온"];
const UNITS = ["개", "g", "ml", "묶음", "컵", "큰술", "장", "마리", "모"];

/* =========================================================
   스키마
   ========================================================= */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS fridge_ingredients (
     id         bigserial     PRIMARY KEY,
     name       text          NOT NULL,
     emoji      text          NOT NULL DEFAULT '📦',
     category   text          NOT NULL DEFAULT '가공식품',
     qty        numeric(10,2) NOT NULL DEFAULT 0,
     unit       text          NOT NULL DEFAULT '개',
     storage    text          NOT NULL DEFAULT '냉장',
     expires_at date,
     created_at timestamptz   NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS fridge_recipes (
     id       text  PRIMARY KEY,
     name     text  NOT NULL,
     emoji    text  NOT NULL DEFAULT '🍽',
     descr    text  NOT NULL DEFAULT '',
     minutes  int   NOT NULL DEFAULT 10,
     level    text  NOT NULL DEFAULT '쉬움',
     servings int   NOT NULL DEFAULT 1,
     tags     jsonb NOT NULL DEFAULT '[]',
     need     jsonb NOT NULL DEFAULT '[]',
     steps    jsonb NOT NULL DEFAULT '[]'
   )`,

  `CREATE TABLE IF NOT EXISTS fridge_shopping (
     id         bigserial     PRIMARY KEY,
     name       text          NOT NULL,
     qty        numeric(10,2) NOT NULL DEFAULT 1,
     unit       text          NOT NULL DEFAULT '개',
     source     text          NOT NULL DEFAULT '',
     done       boolean       NOT NULL DEFAULT false,
     created_at timestamptz   NOT NULL DEFAULT now()
   )`,

  // 요리 완료 기록 — 무엇을 언제 만들었고 재료를 얼마나 썼는지 남긴다
  `CREATE TABLE IF NOT EXISTS fridge_cook_log (
     id          bigserial   PRIMARY KEY,
     recipe_id   text        NOT NULL,
     recipe_name text        NOT NULL,
     used        jsonb       NOT NULL DEFAULT '[]',
     cooked_at   timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE INDEX IF NOT EXISTS fridge_ing_expires_idx ON fridge_ingredients (expires_at)`,
  `CREATE INDEX IF NOT EXISTS fridge_cook_at_idx ON fridge_cook_log (cooked_at)`,

  // AI 생성 레시피가 생기면서 나중에 붙인 칸들 — 이미 만들어진 DB 에도 안전하게 들어간다
  `ALTER TABLE fridge_recipes ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'seed'`,
  `ALTER TABLE fridge_recipes ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`,
];

const ING_COLS = `id, name, emoji, category, qty, unit, storage, expires_at`;
const SHOP_COLS = `id, name, qty, unit, source, done`;

/* =========================================================
   행 <-> 화면 모양 변환
   ========================================================= */

/** DATE 컬럼을 "YYYY-MM-DD" 문자열로. pg 는 Date 객체로 돌려주므로 로컬 기준으로 포맷한다. */
function dateOut(v) {
  if (!v) return "";
  if (typeof v === "string") return v.slice(0, 10);
  const p = (n) => String(n).padStart(2, "0");
  return v.getFullYear() + "-" + p(v.getMonth() + 1) + "-" + p(v.getDate());
}

/** jsonb 는 드라이버가 이미 객체로 주지만, 문자열로 오는 구현(pg-mem 등)도 있어 한 번 감싼다. */
function jsonOut(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return fallback; } }
  return v;
}

const num = (v) => (v == null ? 0 : Number(v));

const toIngredient = (r) => ({
  id: String(r.id),
  name: r.name,
  emoji: r.emoji,
  category: r.category,
  qty: num(r.qty),
  unit: r.unit,
  storage: r.storage,
  expiresAt: dateOut(r.expires_at),
});

const toRecipe = (r) => ({
  id: r.id,
  name: r.name,
  emoji: r.emoji,
  desc: r.descr,
  minutes: Number(r.minutes),
  level: r.level,
  servings: Number(r.servings),
  tags: jsonOut(r.tags, []),
  need: jsonOut(r.need, []),
  steps: jsonOut(r.steps, []),
  source: r.source || "seed",          // "seed" = 기본 제공, "ai" = AI 가 만든 것
});

const toShop = (r) => ({
  id: String(r.id),
  name: r.name,
  qty: num(r.qty),
  unit: r.unit,
  from: r.source,
  done: r.done === true || r.done === "t",
  emoji: metaOf(r.name).emoji,
});

const toCook = (r) => ({
  id: String(r.id),
  recipeId: r.recipe_id,
  name: r.recipe_name,
  used: jsonOut(r.used, []),
  at: r.cooked_at instanceof Date ? r.cooked_at.toISOString() : String(r.cooked_at || ""),
});

/* =========================================================
   입력 정리 — 브라우저가 보낸 값은 전부 여기서 한 번 걸러 넣는다
   ========================================================= */

const clean = (s, max = 60) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, max);
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

function cleanQty(v, dflt = 0) {
  const n = Number(v);
  if (!isFinite(n) || n < 0) return dflt;
  return Math.round(Math.min(n, 99999) * 100) / 100;
}

function cleanDate(v) {
  const s = clean(v, 10);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad("유통기한은 YYYY-MM-DD 형식이어야 합니다.");
  if (isNaN(new Date(s + "T00:00:00"))) throw bad("유통기한 날짜가 올바르지 않습니다.");
  return s;
}

const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);

/** 화면에서 온 재료 한 건을 DB 에 넣을 수 있는 모양으로 정리한다. */
function cleanIngredient(input) {
  const name = clean(input.name);
  if (!name) throw bad("재료 이름이 비어 있습니다.");
  const meta = metaOf(name);
  const emoji = clean(input.emoji, 8);
  return {
    name,
    emoji: emoji && emoji !== "📦" ? emoji : meta.emoji,
    category: pick(input.category, CATEGORIES, meta.category),
    qty: cleanQty(input.qty, 1),
    unit: pick(input.unit, UNITS, "개"),
    storage: pick(input.storage, STORAGES, "냉장"),
    expiresAt: cleanDate(input.expiresAt),
  };
}

/* =========================================================
   시드 데이터 — 서버가 처음 뜰 때 한 번만 넣는다
   유통기한은 고정 날짜가 아니라 "오늘 + n일" 로 계산해서,
   언제 처음 켜도 임박/만료가 섞여 보이게 한다.
   ========================================================= */

const DAY = 86400000;

function dateStr(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const t = new Date(d.getTime() + offsetDays * DAY);
  const p = (n) => String(n).padStart(2, "0");
  return t.getFullYear() + "-" + p(t.getMonth() + 1) + "-" + p(t.getDate());
}

const SEED_INGREDIENTS = [
  { name: "대파",       emoji: "🥬", category: "채소",     qty: 2,   unit: "묶음", storage: "냉장", days: 4 },
  { name: "양파",       emoji: "🧅", category: "채소",     qty: 5,   unit: "개",   storage: "실온", days: 21 },
  { name: "감자",       emoji: "🥔", category: "채소",     qty: 4,   unit: "개",   storage: "실온", days: 18 },
  { name: "당근",       emoji: "🥕", category: "채소",     qty: 2,   unit: "개",   storage: "냉장", days: 9 },
  { name: "애호박",     emoji: "🥒", category: "채소",     qty: 1,   unit: "개",   storage: "냉장", days: 1 },
  { name: "청양고추",   emoji: "🌶️", category: "채소",     qty: 6,   unit: "개",   storage: "냉장", days: 6 },
  { name: "김치",       emoji: "🥬", category: "가공식품", qty: 500, unit: "g",    storage: "냉장", days: 40 },
  { name: "달걀",       emoji: "🥚", category: "유제품",   qty: 8,   unit: "개",   storage: "냉장", days: 11 },
  { name: "우유",       emoji: "🥛", category: "유제품",   qty: 900, unit: "ml",   storage: "냉장", days: -1 },
  { name: "체다치즈",   emoji: "🧀", category: "유제품",   qty: 4,   unit: "장",   storage: "냉장", days: 15 },
  { name: "삼겹살",     emoji: "🥓", category: "육류",     qty: 400, unit: "g",    storage: "냉동", days: 30 },
  { name: "닭가슴살",   emoji: "🍗", category: "육류",     qty: 300, unit: "g",    storage: "냉장", days: 2 },
  { name: "새우",       emoji: "🍤", category: "해산물",   qty: 12,  unit: "마리", storage: "냉동", days: 45 },
  { name: "두부",       emoji: "🧊", category: "가공식품", qty: 1,   unit: "모",   storage: "냉장", days: 3 },
  { name: "밥",         emoji: "🍚", category: "곡물·면", qty: 3,   unit: "컵",   storage: "냉장", days: 2 },
  { name: "소면",       emoji: "🍜", category: "곡물·면", qty: 400, unit: "g",    storage: "실온", days: 120 },
  { name: "스파게티면", emoji: "🍝", category: "곡물·면", qty: 500, unit: "g",    storage: "실온", days: 200 },
  { name: "간장",       emoji: "🍶", category: "양념",     qty: 300, unit: "ml",   storage: "실온", days: 300 },
  { name: "고추장",     emoji: "🌶️", category: "양념",     qty: 250, unit: "g",    storage: "냉장", days: 180 },
  { name: "참기름",     emoji: "🫗", category: "양념",     qty: 120, unit: "ml",   storage: "실온", days: 150 },
  { name: "다진마늘",   emoji: "🧄", category: "양념",     qty: 90,  unit: "g",    storage: "냉장", days: 25 },
  { name: "사과",       emoji: "🍎", category: "과일",     qty: 3,   unit: "개",   storage: "냉장", days: 7 },
  { name: "바나나",     emoji: "🍌", category: "과일",     qty: 2,   unit: "개",   storage: "실온", days: 0 },
];

const SEED_RECIPES = [
  {
    id: "r1", name: "김치볶음밥", emoji: "🍚", minutes: 15, level: "쉬움", servings: 1,
    desc: "찬밥이랑 김치만 있으면 끝. 냉장고 파먹기 1순위.",
    tags: ["한식", "한그릇", "자취요리"],
    need: [
      { name: "밥", qty: 1, unit: "컵" },
      { name: "김치", qty: 120, unit: "g" },
      { name: "대파", qty: 0.5, unit: "묶음" },
      { name: "달걀", qty: 1, unit: "개" },
      { name: "참기름", qty: 5, unit: "ml" },
    ],
    steps: [
      "김치를 한입 크기로 썰고 대파는 송송 썬다.",
      "팬에 기름을 두르고 대파를 먼저 볶아 파기름을 낸다.",
      "김치를 넣고 2분간 볶아 신맛을 날린다.",
      "밥을 넣고 눌러가며 3분 볶은 뒤 참기름으로 마무리.",
      "달걀 프라이를 올려 완성.",
    ],
  },
  {
    id: "r2", name: "뚝배기 없는 계란찜", emoji: "🥚", minutes: 12, level: "쉬움", servings: 2,
    desc: "달걀만 있으면 되는 국민 반찬. 냄비로도 된다.",
    tags: ["한식", "반찬", "초간단"],
    need: [
      { name: "달걀", qty: 3, unit: "개" },
      { name: "대파", qty: 0.3, unit: "묶음" },
      { name: "청양고추", qty: 1, unit: "개", optional: true },
    ],
    steps: [
      "달걀 3개를 풀고 물 반 컵을 섞어 체에 한 번 내린다.",
      "냄비에 붓고 약불에서 젓가락으로 계속 저어준다.",
      "몽글몽글해지면 뚜껑을 덮고 2분간 뜸 들인다.",
      "송송 썬 대파와 청양고추를 올려 완성.",
    ],
  },
  {
    id: "r3", name: "새우 알리오 올리오", emoji: "🍝", minutes: 20, level: "보통", servings: 2,
    desc: "냉동 새우 꺼내서 만드는 주말 파스타.",
    tags: ["양식", "파스타"],
    need: [
      { name: "스파게티면", qty: 180, unit: "g" },
      { name: "새우", qty: 8, unit: "마리" },
      { name: "다진마늘", qty: 20, unit: "g" },
      { name: "청양고추", qty: 2, unit: "개" },
      { name: "올리브유", qty: 40, unit: "ml" },
    ],
    steps: [
      "끓는 물에 소금을 넣고 면을 8분간 삶는다. 면수는 한 컵 남겨둔다.",
      "팬에 올리브유와 다진마늘을 넣고 약불에서 향을 낸다.",
      "새우와 어슷 썬 청양고추를 넣고 센불에 볶는다.",
      "삶은 면과 면수를 넣고 30초간 빠르게 유화시킨다.",
    ],
  },
  {
    id: "r4", name: "삼겹살 김치찜", emoji: "🥓", minutes: 35, level: "보통", servings: 3,
    desc: "묵은지랑 삼겹살이 있으면 무조건 성공하는 메뉴.",
    tags: ["한식", "메인", "손님상"],
    need: [
      { name: "삼겹살", qty: 300, unit: "g" },
      { name: "김치", qty: 300, unit: "g" },
      { name: "양파", qty: 1, unit: "개" },
      { name: "대파", qty: 1, unit: "묶음" },
      { name: "다진마늘", qty: 15, unit: "g" },
      { name: "고추장", qty: 20, unit: "g" },
    ],
    steps: [
      "냄비 바닥에 김치를 깔고 삼겹살을 올린다.",
      "채 썬 양파, 다진마늘, 고추장을 얹고 물을 재료가 잠길 만큼 붓는다.",
      "뚜껑을 덮고 센불에 10분, 약불로 줄여 20분 더 끓인다.",
      "대파를 올리고 3분 더 끓여 완성.",
    ],
  },
  {
    id: "r5", name: "닭가슴살 두부 샐러드", emoji: "🥗", minutes: 15, level: "쉬움", servings: 1,
    desc: "유통기한 임박한 닭가슴살, 두부 처리용 다이어트식.",
    tags: ["샐러드", "다이어트", "고단백"],
    need: [
      { name: "닭가슴살", qty: 150, unit: "g" },
      { name: "두부", qty: 0.5, unit: "모" },
      { name: "양파", qty: 0.5, unit: "개" },
      { name: "참기름", qty: 10, unit: "ml" },
      { name: "간장", qty: 15, unit: "ml" },
    ],
    steps: [
      "닭가슴살을 끓는 물에 12분 삶고 결대로 찢는다.",
      "두부는 키친타월로 물기를 뺀 뒤 깍둑 썬다.",
      "양파는 얇게 채 썰어 찬물에 5분 담가 매운맛을 뺀다.",
      "간장과 참기름을 섞어 드레싱을 만들고 전부 버무린다.",
    ],
  },
  {
    id: "r6", name: "감자채볶음", emoji: "🥔", minutes: 12, level: "쉬움", servings: 2,
    desc: "감자 한 알이면 되는 밑반찬. 도시락에도 좋음.",
    tags: ["한식", "반찬"],
    need: [
      { name: "감자", qty: 2, unit: "개" },
      { name: "양파", qty: 0.5, unit: "개" },
      { name: "당근", qty: 0.3, unit: "개" },
    ],
    steps: [
      "감자를 얇게 채 썰어 찬물에 10분 담가 전분을 뺀다.",
      "양파와 당근도 같은 굵기로 채 썬다.",
      "팬에 기름을 두르고 감자부터 3분 볶는다.",
      "나머지 채소를 넣고 소금 간해 2분 더 볶는다.",
    ],
  },
  {
    id: "r7", name: "잔치국수", emoji: "🍜", minutes: 18, level: "보통", servings: 2,
    desc: "소면 삶고 애호박 올리면 완성되는 따뜻한 한 그릇.",
    tags: ["한식", "면요리"],
    need: [
      { name: "소면", qty: 200, unit: "g" },
      { name: "애호박", qty: 0.5, unit: "개" },
      { name: "당근", qty: 0.3, unit: "개" },
      { name: "달걀", qty: 1, unit: "개" },
      { name: "간장", qty: 30, unit: "ml" },
      { name: "멸치육수팩", qty: 1, unit: "개" },
    ],
    steps: [
      "냄비에 물 1L와 멸치육수팩을 넣고 10분 끓인 뒤 간장으로 간한다.",
      "애호박과 당근은 채 썰어 팬에 각각 살짝 볶는다.",
      "달걀은 지단으로 부쳐 채 썬다.",
      "소면을 3분 삶아 찬물에 헹구고, 그릇에 담아 육수를 붓고 고명을 올린다.",
    ],
  },
  {
    id: "r8", name: "치즈 계란토스트", emoji: "🥪", minutes: 10, level: "쉬움", servings: 1,
    desc: "아침에 5분 만에. 식빵만 사 오면 바로 가능.",
    tags: ["양식", "아침", "초간단"],
    need: [
      { name: "식빵", qty: 2, unit: "장" },
      { name: "달걀", qty: 2, unit: "개" },
      { name: "체다치즈", qty: 1, unit: "장" },
      { name: "우유", qty: 30, unit: "ml" },
    ],
    steps: [
      "달걀에 우유를 섞어 곱게 푼다.",
      "팬에 부어 네모나게 스크램블을 만든다.",
      "식빵을 노릇하게 굽고 달걀과 치즈를 올린다.",
      "한 장 더 덮고 반으로 잘라 완성.",
    ],
  },
  {
    id: "r9", name: "바나나 우유 스무디", emoji: "🍌", minutes: 5, level: "쉬움", servings: 1,
    desc: "물러지기 직전 바나나 처리용. 갈기만 하면 됨.",
    tags: ["음료", "초간단"],
    need: [
      { name: "바나나", qty: 2, unit: "개" },
      { name: "우유", qty: 200, unit: "ml" },
    ],
    steps: [
      "바나나를 큼직하게 잘라 믹서에 넣는다.",
      "우유를 붓고 30초간 간다.",
      "얼음을 넣어 차갑게 마신다.",
    ],
  },
  {
    id: "r10", name: "애호박 새우전", emoji: "🥒", minutes: 20, level: "보통", servings: 2,
    desc: "애호박 남았을 때. 새우 넣으면 확 고급스러워짐.",
    tags: ["한식", "전"],
    need: [
      { name: "애호박", qty: 1, unit: "개" },
      { name: "새우", qty: 4, unit: "마리" },
      { name: "달걀", qty: 2, unit: "개" },
      { name: "부침가루", qty: 60, unit: "g" },
    ],
    steps: [
      "애호박을 0.5cm 두께로 동그랗게 썬다.",
      "새우는 잘게 다져 부침가루와 섞는다.",
      "애호박에 부침가루를 묻히고 달걀물을 입힌다.",
      "약불에서 앞뒤로 노릇하게 부친다.",
    ],
  },
];

/* 냉장고에 없는 재료도 이모지/분류를 붙여 줄 수 있게 만든 사전 */
const KNOWN = {};
SEED_INGREDIENTS.forEach((i) => { KNOWN[i.name] = { emoji: i.emoji, category: i.category }; });
Object.assign(KNOWN, {
  "올리브유":   { emoji: "🫒", category: "양념" },
  "식빵":       { emoji: "🍞", category: "곡물·면" },
  "부침가루":   { emoji: "🥣", category: "곡물·면" },
  "멸치육수팩": { emoji: "🐟", category: "해산물" },
});
const metaOf = (name) => KNOWN[name] || { emoji: "📦", category: "가공식품" };

/* =========================================================
   스토어
   query(sql, args) -> rows
   tx(fn)           -> 한 커넥션 안에서 BEGIN … COMMIT (실패하면 ROLLBACK)
   ========================================================= */

function makeStore(query, tx) {
  /* 트랜잭션을 못 쓰는 환경(테스트 등)에서는 그냥 같은 query 로 돌린다 */
  const runTx = tx || ((fn) => fn(query));

  const store = {
    async init() {
      for (const sql of SCHEMA) await query(sql);
      await store.seed();
    },

    /** 처음 켰을 때만 채운다. 레시피는 새로 추가된 것만 들어가고 기존 행은 건드리지 않는다. */
    async seed() {
      for (const r of SEED_RECIPES) {
        await query(
          `INSERT INTO fridge_recipes (id, name, emoji, descr, minutes, level, servings, tags, need, steps)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (id) DO NOTHING`,
          [r.id, r.name, r.emoji, r.desc, r.minutes, r.level, r.servings,
           JSON.stringify(r.tags), JSON.stringify(r.need), JSON.stringify(r.steps)]
        );
      }
      const [{ n }] = await query(`SELECT count(*)::int AS n FROM fridge_ingredients`);
      if (Number(n) > 0) return { seeded: false };
      for (const s of SEED_INGREDIENTS) {
        await query(
          `INSERT INTO fridge_ingredients (name, emoji, category, qty, unit, storage, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [s.name, s.emoji, s.category, s.qty, s.unit, s.storage, dateStr(s.days)]
        );
      }
      return { seeded: true, count: SEED_INGREDIENTS.length };
    },

    /* ---------- 읽기 ---------- */

    async ingredients() {
      const rows = await query(
        `SELECT ${ING_COLS} FROM fridge_ingredients
         ORDER BY expires_at NULLS LAST, name`
      );
      return rows.map(toIngredient);
    },

    async recipes() {
      const rows = await query(`SELECT * FROM fridge_recipes ORDER BY id`);
      // AI 가 만든 건 방금 만든 게 위로, 기본 레시피는 r1, r2 … r10 순서로.
      // (id 가 문자열이라 그냥 정렬하면 r10 이 r2 앞에 온다)
      const seq = (id) => parseInt(String(id).replace(/\D/g, ""), 10) || 0;
      return rows.map(toRecipe).sort((a, b) => {
        if (a.source !== b.source) return a.source === "ai" ? -1 : 1;
        return a.source === "ai" ? seq(b.id) - seq(a.id) : seq(a.id) - seq(b.id);
      });
    },

    async shopping() {
      const rows = await query(`SELECT ${SHOP_COLS} FROM fridge_shopping ORDER BY done, id`);
      return rows.map(toShop);
    },

    async cooks(limit = 5) {
      const rows = await query(
        `SELECT id, recipe_id, recipe_name, used, cooked_at
           FROM fridge_cook_log ORDER BY cooked_at DESC, id DESC LIMIT $1`,
        [limit]
      );
      return rows.map(toCook);
    },

    /** 화면이 한 번에 받아 가는 전체 상태 */
    async state() {
      return {
        ingredients: await store.ingredients(),
        recipes: await store.recipes(),
        shopping: await store.shopping(),
        cooks: await store.cooks(),
      };
    },

    /* ---------- 재료 ---------- */

    async addIngredient(input) {
      const v = cleanIngredient(input);
      const rows = await query(
        `INSERT INTO fridge_ingredients (name, emoji, category, qty, unit, storage, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${ING_COLS}`,
        [v.name, v.emoji, v.category, v.qty, v.unit, v.storage, v.expiresAt]
      );
      return toIngredient(rows[0]);
    },

    /** 바꿀 칸만 골라 SET 절을 만든다. 칸 이름은 코드에 적힌 것만 쓰이고 값은 전부 파라미터. */
    async updateIngredient(id, patch) {
      const sets = [];
      const args = [];
      const put = (col, val) => { args.push(val); sets.push(`${col} = $${args.length}`); };

      if (patch.name !== undefined) {
        const name = clean(patch.name);
        if (!name) throw bad("재료 이름이 비어 있습니다.");
        put("name", name);
      }
      if (patch.emoji !== undefined) put("emoji", clean(patch.emoji, 8) || "📦");
      if (patch.category !== undefined) put("category", pick(patch.category, CATEGORIES, "가공식품"));
      if (patch.unit !== undefined) put("unit", pick(patch.unit, UNITS, "개"));
      if (patch.storage !== undefined) put("storage", pick(patch.storage, STORAGES, "냉장"));
      if (patch.qty !== undefined) put("qty", cleanQty(patch.qty, 0));
      if (patch.expiresAt !== undefined) put("expires_at", cleanDate(patch.expiresAt));
      if (!sets.length) throw bad("바꿀 내용이 없습니다.");

      args.push(id);
      const rows = await query(
        `UPDATE fridge_ingredients SET ${sets.join(", ")} WHERE id = $${args.length} RETURNING ${ING_COLS}`,
        args
      );
      if (!rows.length) throw Object.assign(new Error("그런 재료가 없습니다."), { status: 404 });
      return toIngredient(rows[0]);
    },

    /** +/- 버튼. 0 밑으로는 안 내려가고, DB 에서 바로 더한다(경쟁 조건 없음). */
    async bumpIngredient(id, delta) {
      const d = Number(delta);
      if (!isFinite(d) || d === 0) throw bad("변화량이 올바르지 않습니다.");
      const rows = await query(
        `UPDATE fridge_ingredients
            SET qty = CASE WHEN qty + $1 < 0 THEN 0 ELSE qty + $1 END
          WHERE id = $2 RETURNING ${ING_COLS}`,
        [Math.round(d * 100) / 100, id]
      );
      if (!rows.length) throw Object.assign(new Error("그런 재료가 없습니다."), { status: 404 });
      return toIngredient(rows[0]);
    },

    async removeIngredient(id) {
      const rows = await query(`DELETE FROM fridge_ingredients WHERE id = $1 RETURNING name`, [id]);
      if (!rows.length) throw Object.assign(new Error("그런 재료가 없습니다."), { status: 404 });
      return rows[0].name;
    },

    /* ---------- 레시피 (AI 가 만든 것) ---------- */

    /** AI 응답은 ai.js 에서 이미 검증·정리된 뒤 여기로 온다. */
    async addRecipe(recipe) {
      const id = "ai-" + Date.now();
      const rows = await query(
        `INSERT INTO fridge_recipes (id, name, emoji, descr, minutes, level, servings, tags, need, steps, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ai') RETURNING *`,
        [id, recipe.name, recipe.emoji, recipe.desc, recipe.minutes, recipe.level, recipe.servings,
         JSON.stringify(recipe.tags), JSON.stringify(recipe.need), JSON.stringify(recipe.steps)]
      );
      return toRecipe(rows[0]);
    },

    /** 기본 제공 레시피는 못 지운다 — AI 가 만든 것만. */
    async removeRecipe(id) {
      const found = await query(`SELECT source, name FROM fridge_recipes WHERE id = $1`, [id]);
      if (!found.length) throw Object.assign(new Error("그런 레시피가 없습니다."), { status: 404 });
      if ((found[0].source || "seed") !== "ai") {
        throw Object.assign(new Error("기본 제공 레시피는 지울 수 없습니다."), { status: 403 });
      }
      await query(`DELETE FROM fridge_recipes WHERE id = $1`, [id]);
      return found[0].name;
    },

    /* ---------- 요리 완료 ----------
       여러 재료를 한꺼번에 깎으므로 트랜잭션으로 묶는다.
       중간에 실패하면 하나도 안 깎인 상태로 되돌아간다. */

    async cook(recipeId) {
      return runTx(async (q) => {
        const found = await q(`SELECT * FROM fridge_recipes WHERE id = $1`, [recipeId]);
        if (!found.length) throw Object.assign(new Error("그런 레시피가 없습니다."), { status: 404 });
        const recipe = toRecipe(found[0]);

        const have = (await q(`SELECT ${ING_COLS} FROM fridge_ingredients`)).map(toIngredient);
        const byName = new Map(have.map((i) => [i.name, i]));

        // 필수 재료가 하나라도 모자라면 아무것도 건드리지 않고 되돌린다
        const missing = recipe.need.filter((n) => {
          if (n.optional) return false;
          const h = byName.get(n.name);
          return !h || (h.unit === n.unit && h.qty < n.qty);
        });
        if (missing.length) {
          throw Object.assign(
            new Error("재료가 부족합니다 — " + missing.map((m) => m.name).join(", ")),
            { status: 409 }
          );
        }

        const used = [];
        for (const n of recipe.need) {
          const h = byName.get(n.name);
          if (!h) continue;
          if (h.unit !== n.unit) continue;           // 단위가 다르면 건드리지 않는다
          await q(
            `UPDATE fridge_ingredients
                SET qty = CASE WHEN qty - $1 < 0 THEN 0 ELSE qty - $1 END
              WHERE id = $2`,
            [n.qty, h.id]
          );
          used.push({ name: n.name, qty: n.qty, unit: n.unit });
        }
        await q(`DELETE FROM fridge_ingredients WHERE qty <= 0`);   // 다 쓴 재료는 냉장고에서 뺀다

        await q(
          `INSERT INTO fridge_cook_log (recipe_id, recipe_name, used) VALUES ($1,$2,$3)`,
          [recipe.id, recipe.name, JSON.stringify(used)]
        );
        return { recipe: recipe.name, used };
      });
    },

    /* ---------- 장보기 ---------- */

    async addShopping(items) {
      const list = (Array.isArray(items) ? items : [items])
        .map((it) => ({
          name: clean(it.name),
          qty: cleanQty(it.qty, 1) || 1,
          unit: pick(it.unit, UNITS, "개"),
          source: clean(it.from || it.source || "", 40),
        }))
        .filter((it) => it.name);
      if (!list.length) throw bad("담을 항목이 없습니다.");

      const existing = new Set((await query(`SELECT name FROM fridge_shopping`)).map((r) => r.name));
      let added = 0;
      for (const it of list) {
        if (existing.has(it.name)) continue;          // 같은 이름은 한 번만
        await query(
          `INSERT INTO fridge_shopping (name, qty, unit, source) VALUES ($1,$2,$3,$4)`,
          [it.name, it.qty, it.unit, it.source]
        );
        existing.add(it.name);
        added++;
      }
      return added;
    },

    async toggleShopping(id) {
      const rows = await query(
        `UPDATE fridge_shopping SET done = NOT done WHERE id = $1 RETURNING ${SHOP_COLS}`, [id]
      );
      if (!rows.length) throw Object.assign(new Error("그런 항목이 없습니다."), { status: 404 });
      return toShop(rows[0]);
    },

    async removeShopping(id) {
      const rows = await query(`DELETE FROM fridge_shopping WHERE id = $1 RETURNING id`, [id]);
      if (!rows.length) throw Object.assign(new Error("그런 항목이 없습니다."), { status: 404 });
      return true;
    },

    async clearDoneShopping() {
      const rows = await query(`DELETE FROM fridge_shopping WHERE done = true RETURNING id`);
      return rows.length;
    },

    /** 체크한 장바구니 항목을 냉장고로 옮긴다 — 담기와 지우기를 한 트랜잭션으로. */
    async stockUp() {
      return runTx(async (q) => {
        const bought = (await q(`SELECT ${SHOP_COLS} FROM fridge_shopping WHERE done = true`)).map(toShop);
        if (!bought.length) throw bad("체크한 항목이 없습니다.");

        for (const b of bought) {
          const same = await q(
            `SELECT id FROM fridge_ingredients WHERE name = $1 AND unit = $2 LIMIT 1`, [b.name, b.unit]
          );
          if (same.length) {
            await q(
              `UPDATE fridge_ingredients SET qty = qty + $1, expires_at = $2 WHERE id = $3`,
              [b.qty, dateStr(7), same[0].id]
            );
          } else {
            const meta = metaOf(b.name);
            await q(
              `INSERT INTO fridge_ingredients (name, emoji, category, qty, unit, storage, expires_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [b.name, meta.emoji, meta.category, b.qty, b.unit, "냉장", dateStr(7)]
            );
          }
        }
        await q(`DELETE FROM fridge_shopping WHERE done = true`);
        return bought.length;
      });
    },

    /* ---------- 초기화 ---------- */

    async reset() {
      return runTx(async (q) => {
        await q(`DELETE FROM fridge_ingredients`);
        await q(`DELETE FROM fridge_shopping`);
        await q(`DELETE FROM fridge_cook_log`);
        for (const s of SEED_INGREDIENTS) {
          await q(
            `INSERT INTO fridge_ingredients (name, emoji, category, qty, unit, storage, expires_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [s.name, s.emoji, s.category, s.qty, s.unit, s.storage, dateStr(s.days)]
          );
        }
        return SEED_INGREDIENTS.length;
      });
    },
  };

  return store;
}

module.exports = {
  CATEGORIES, STORAGES, UNITS,
  SCHEMA, SEED_INGREDIENTS, SEED_RECIPES, KNOWN,
  makeStore, metaOf, dateStr, clean, cleanQty, cleanDate, cleanIngredient,
  toIngredient, toRecipe, toShop, toCook,
};
