// AI 레시피 생성 — 냉장고에 있는 재료를 OpenAI 에 넘겨 새 레시피를 하나 받아온다.
//
// 지키는 것 두 가지:
//   1) API 키는 서버에만 있다. 브라우저는 /api/ai/recipe 만 부르고 키를 절대 보지 않는다.
//   2) 모델이 돌려준 JSON 은 "그냥 데이터"다. 실행하지 않고, 전부 형식 검사를 거쳐 DB 에 들어간다.
//      (모델이 이상한 값을 주거나 빈칸을 빠뜨려도 앱이 깨지지 않게)

const { UNITS, metaOf } = require("./db");

const DEFAULT_BASE = "https://api.openai.com/v1";
const LEVELS = ["쉬움", "보통", "어려움"];

const bad = (msg, status) => Object.assign(new Error(msg), { status: status || 400 });

/* =========================================================
   1. 프롬프트
   ========================================================= */

/** 유통기한이 임박한 것부터 쓰라고 알려주려고 D-day 를 같이 적는다. */
function daysLeft(iso) {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return null;
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return Math.round((d - t) / 86400000);
}

function describeIngredient(i) {
  const n = daysLeft(i.expiresAt);
  let when = "유통기한 없음";
  if (n !== null) when = n < 0 ? `유통기한 ${Math.abs(n)}일 지남` : n === 0 ? "오늘까지" : `D-${n}`;
  return `- ${i.name} ${i.qty}${i.unit} (${i.storage}, ${when})`;
}

const SYSTEM = [
  "너는 한국 가정식에 익숙한 요리사다.",
  "사용자의 냉장고에 실제로 있는 재료만으로 만들 수 있는 요리를 하나 제안한다.",
  "규칙:",
  "1. 재료 목록에 없는 것은 쓰지 않는다. 다만 소금·후추·식용유·물처럼 어느 집에나 있는 것은 써도 되고, 그건 재료 목록에 넣지 않는다.",
  "2. 유통기한이 임박했거나 지난 재료를 먼저 쓴다. 단 '지남' 표시가 있는 재료는 쓰지 않는다.",
  "3. 재료의 수량은 사용자가 가진 양을 넘지 않는다. 단위는 사용자가 쓰는 단위를 그대로 쓴다.",
  "4. 조리 순서는 3~8단계, 각 단계는 한 문장으로 구체적으로 쓴다.",
  "5. 모든 글은 한국어로 쓴다. 이름은 20자 이내로 짧고 먹음직스럽게.",
].join("\n");

function buildUserPrompt(ingredients, opts) {
  const lines = [
    "냉장고에 있는 재료:",
    ...ingredients.map(describeIngredient),
    "",
    `쓸 수 있는 단위: ${UNITS.join(", ")}`,
  ];
  if (opts.use && opts.use.length) {
    lines.push("", `이 재료는 꼭 써 줘: ${opts.use.join(", ")}`);
  }
  if (opts.note) {
    lines.push("", `추가 요청: ${opts.note}`);
  }
  lines.push("", "이 재료로 만들 수 있는 요리 하나를 JSON 으로 알려줘.");
  return lines.join("\n");
}

/* 응답을 JSON 으로 못 박는다 (Structured Outputs) */
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "emoji", "desc", "minutes", "level", "servings", "tags", "need", "steps"],
  properties: {
    name: { type: "string", description: "요리 이름 (한국어, 20자 이내)" },
    emoji: { type: "string", description: "요리를 나타내는 이모지 한 개" },
    desc: { type: "string", description: "한 줄 소개 (한국어, 60자 이내)" },
    minutes: { type: "integer", description: "조리 시간(분)" },
    level: { type: "string", enum: LEVELS },
    servings: { type: "integer", description: "몇 인분" },
    tags: { type: "array", items: { type: "string" }, description: "태그 2~4개 (예: 한식, 반찬)" },
    need: {
      type: "array",
      description: "필요한 재료. 냉장고에 있는 것만.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "qty", "unit"],
        properties: {
          name: { type: "string" },
          qty: { type: "number" },
          unit: { type: "string", enum: UNITS },
        },
      },
    },
    steps: { type: "array", items: { type: "string" }, description: "조리 순서 3~8단계" },
  },
};

/* =========================================================
   2. 응답 검증 — 모델 출력을 그대로 믿지 않는다
   ========================================================= */

const str = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

function normalize(raw, ingredients) {
  if (!raw || typeof raw !== "object") throw bad("AI 응답을 읽지 못했습니다.", 502);

  const name = str(raw.name, 30);
  if (!name) throw bad("AI 가 요리 이름을 주지 않았습니다.", 502);

  const have = new Map(ingredients.map((i) => [i.name, i]));

  // 냉장고에 없는 재료는 버린다. 수량도 가진 양을 넘지 않게 자른다.
  const need = [];
  const seen = new Set();
  for (const n of Array.isArray(raw.need) ? raw.need : []) {
    const nm = str(n && n.name, 20);
    const mine = have.get(nm);
    if (!nm || !mine || seen.has(nm)) continue;
    let qty = Number(n.qty);
    if (!isFinite(qty) || qty <= 0) qty = 1;
    // 단위는 무조건 냉장고에 적힌 것으로 맞춘다.
    // 모델이 "우유 1개"처럼 다른 단위를 쓰면 요리 완료 때 차감이 조용히 건너뛰어진다.
    const unit = mine.unit;
    qty = Math.min(qty, mine.qty);
    need.push({ name: nm, qty: Math.round(qty * 100) / 100, unit });
    seen.add(nm);
    if (need.length >= 12) break;
  }
  if (!need.length) throw bad("AI 가 냉장고에 있는 재료를 하나도 쓰지 않았습니다. 다시 시도해 주세요.", 502);

  const steps = (Array.isArray(raw.steps) ? raw.steps : [])
    .map((s) => str(s, 200)).filter(Boolean).slice(0, 10);
  if (steps.length < 2) throw bad("AI 가 조리 순서를 제대로 주지 않았습니다. 다시 시도해 주세요.", 502);

  const minutes = Math.min(240, Math.max(1, Math.round(Number(raw.minutes) || 15)));
  const servings = Math.min(8, Math.max(1, Math.round(Number(raw.servings) || 1)));
  const emoji = str(raw.emoji, 4) || metaOf(need[0].name).emoji;

  const tags = (Array.isArray(raw.tags) ? raw.tags : [])
    .map((t) => str(t, 12).replace(/^#/, "")).filter(Boolean).slice(0, 4);

  return {
    name,
    emoji,
    desc: str(raw.desc, 80) || "AI 가 냉장고 재료로 짜 준 레시피.",
    minutes,
    level: LEVELS.includes(raw.level) ? raw.level : "보통",
    servings,
    tags: tags.length ? tags : ["AI 추천"],
    need,
    steps,
  };
}

/* =========================================================
   3. OpenAI 호출
   ========================================================= */

function config(env) {
  const key = (env.OPENAI_API_KEY || "").trim();
  if (!key) throw bad("OPENAI_API_KEY 가 없습니다. .env 에 키를 넣고 서버를 다시 실행하세요.", 503);
  return {
    key,
    model: (env.OPENAI_MODEL || "gpt-4o-mini").trim(),
    base: (env.OPENAI_BASE_URL || DEFAULT_BASE).trim().replace(/\/+$/, ""),
    timeout: Number(env.OPENAI_TIMEOUT_MS) || 45000,
  };
}

/** OpenAI 쪽 오류를 사용자가 읽을 수 있는 말로 바꾼다 */
function friendlyOpenAI(status, body) {
  const msg = (body && body.error && body.error.message) || "";
  if (status === 401) return bad("OpenAI 키가 거부되었습니다. .env 의 OPENAI_API_KEY 를 확인하세요.", 502);
  if (status === 429) {
    return /quota|billing/i.test(msg)
      ? bad("OpenAI 사용 한도(크레딧)를 다 썼습니다.", 502)
      : bad("OpenAI 요청이 너무 잦습니다. 잠시 뒤 다시 시도해 주세요.", 429);
  }
  if (status === 404) return bad(`OpenAI 모델을 찾을 수 없습니다 (${msg || "모델 이름 확인"}).`, 502);
  if (status >= 500) return bad("OpenAI 서버 쪽 문제입니다. 잠시 뒤 다시 시도해 주세요.", 502);
  return bad("OpenAI 요청이 거부되었습니다 — " + (msg || status), 502);
}

async function callOpenAI(cfg, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeout);
  let res;
  try {
    res = await fetch(cfg.base + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw bad("AI 응답이 너무 오래 걸립니다. 다시 시도해 주세요.", 504);
    throw bad("OpenAI 에 연결하지 못했습니다 — " + e.message, 502);
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = await res.json(); } catch { /* 본문이 JSON 이 아닐 수도 있다 */ }
  if (!res.ok) throw friendlyOpenAI(res.status, data);
  return data;
}

/**
 * 냉장고 재료로 레시피 하나를 만들어 온다.
 * @param {Array}  ingredients  store.ingredients() 결과
 * @param {Object} opts         { note?: string, use?: string[] }
 * @param {Object} env          process.env (테스트에서 갈아끼울 수 있게 받는다)
 */
async function generateRecipe(ingredients, opts = {}, env = process.env) {
  if (!ingredients || ingredients.length === 0) {
    throw bad("냉장고가 비어 있어요. 재료를 먼저 등록해 주세요.");
  }
  const cfg = config(env);

  const note = str(opts.note, 120);
  const use = (Array.isArray(opts.use) ? opts.use : [])
    .map((s) => str(s, 20))
    .filter((s) => ingredients.some((i) => i.name === s))    // 냉장고에 있는 것만
    .slice(0, 8);

  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: buildUserPrompt(ingredients, { note, use }) },
  ];
  const base = { model: cfg.model, messages, temperature: 0.8, max_tokens: 900 };

  // 먼저 Structured Outputs 로 요청하고, 모델이 그걸 못 받으면 json_object 로 한 번 더.
  let data;
  try {
    data = await callOpenAI(cfg, {
      ...base,
      response_format: {
        type: "json_schema",
        json_schema: { name: "recipe", strict: true, schema: SCHEMA },
      },
    });
  } catch (e) {
    if (e.status !== 502 && e.status !== 400) throw e;
    data = await callOpenAI(cfg, {
      ...base,
      messages: [...messages, { role: "system", content: "반드시 JSON 객체 하나만 출력한다." }],
      response_format: { type: "json_object" },
    });
  }

  const choice = data && data.choices && data.choices[0];
  const text = choice && choice.message && choice.message.content;
  if (choice && choice.finish_reason === "length") {
    throw bad("AI 응답이 중간에 잘렸습니다. 다시 시도해 주세요.", 502);
  }
  if (!text) throw bad("AI 가 빈 응답을 보냈습니다. 다시 시도해 주세요.", 502);

  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw bad("AI 응답이 JSON 이 아닙니다. 다시 시도해 주세요.", 502); }

  return {
    recipe: normalize(parsed, ingredients),
    usage: (data && data.usage) || null,
    model: (data && data.model) || cfg.model,
  };
}

module.exports = { generateRecipe, normalize, buildUserPrompt, config, SCHEMA, SYSTEM, LEVELS };
