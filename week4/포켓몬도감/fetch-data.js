// PokéAPI에서 도감 데이터를 한 번만 받아 data/ 폴더에 저장한다.
// 내부 서버(server.js)는 이 파일들만 읽어 응답하므로, 실행 후에는 인터넷이 필요 없다.
//
//   node fetch-data.js           JSON + 작은 픽셀 스프라이트 (약 4MB)
//   node fetch-data.js --art     공식 일러스트까지 (약 140MB, 오래 걸림)
//   node fetch-data.js --art-only  이미 받은 JSON은 두고 일러스트만 추가
//   node fetch-data.js --evo-only  진화 계통(families.json)만 다시 수집
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const COUNT = Number(process.env.COUNT) || 1000;   // No.1 ~ No.1000
const CONCURRENCY = 10;                            // PokéAPI에 예의를 지키는 정도
const API = "https://pokeapi.co/api/v2";
const SPRITE = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon";
const DATA = path.join(__dirname, "data");

const WANT_ART = process.argv.includes("--art") || process.argv.includes("--art-only");
const ART_ONLY = process.argv.includes("--art-only");
const EVO_ONLY = process.argv.includes("--evo-only");

const IDS = Array.from({ length: COUNT }, function (_, i) { return i + 1; });

async function retry(fn, label, tries) {
  tries = tries || 3;
  for (var i = 1; i <= tries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === tries) throw new Error(label + " 실패: " + e.message);
      await new Promise(function (r) { setTimeout(r, 400 * i); });
    }
  }
}

function getJson(url) {
  return retry(async function () {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }, url);
}

async function download(url, dest) {
  if (fs.existsSync(dest)) return false;              // 이어받기: 이미 있으면 건너뛴다
  const buf = await retry(async function () {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return Buffer.from(await res.arrayBuffer());
  }, url);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, buf);
  return true;
}

// 동시 실행 개수를 CONCURRENCY로 제한하며 items를 처리한다.
async function pool(items, worker, label) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
      done++;
      if (done % 50 === 0 || done === items.length) {
        process.stdout.write("\r  " + label + " " + done + "/" + items.length + "   ");
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, run));
  process.stdout.write("\n");
  return out;
}

// 여러 언어가 담긴 배열에서 한국어를 고르고, 없으면 영어로 떨어진다.
function pick(entries, key) {
  entries = entries || [];
  const ko = entries.filter(function (e) { return e.language.name === "ko"; });
  const en = entries.filter(function (e) { return e.language.name === "en"; });
  const src = ko.length ? ko : en;
  return src.length ? String(src[0][key] || "").replace(/\s+/g, " ").trim() : "";
}

async function collect() {
  console.log("PokéAPI에서 No.1 ~ No." + COUNT + " 데이터를 받는 중…");

  const records = await pool(IDS, async function (id) {
    const both = await Promise.all([
      getJson(API + "/pokemon/" + id),
      getJson(API + "/pokemon-species/" + id),
    ]);
    const p = both[0], s = both[1];
    return {
      id: p.id,
      name: pick(s.names, "name") || p.name,
      nameEn: p.name,
      genus: pick(s.genera, "genus"),
      flavor: pick(s.flavor_text_entries, "flavor_text"),
      generation: s.generation ? s.generation.name : "",
      isLegendary: !!s.is_legendary,
      isMythical: !!s.is_mythical,
      types: p.types.slice().sort(function (a, b) { return a.slot - b.slot; })
        .map(function (t) { return t.type.name; }),
      heightM: p.height / 10,
      weightKg: p.weight / 10,
      abilities: p.abilities.map(function (a) {
        return { en: a.ability.name, hidden: a.is_hidden };
      }),
      stats: p.stats.map(function (st) { return { key: st.stat.name, base: st.base_stat }; }),
      statTotal: p.stats.reduce(function (n, st) { return n + st.base_stat; }, 0),
      sprite: "/sprites/small/" + p.id + ".png",
      // 공식 일러스트는 기본적으로 PokéAPI 스프라이트 CDN 주소를 그대로 쓴다.
      // --art 로 내려받으면 artLocal 경로로 바꿔 내부 서버가 서빙한다.
      art: ((p.sprites.other || {})["official-artwork"] || {}).front_default || "",
      artLocal: "/sprites/art/" + p.id + ".png",
    };
  }, "포켓몬");

  // 특성 한국어 이름 — 등장하는 특성만 모아서 한 번씩 조회한다.
  const slugs = Array.from(new Set(records.flatMap(function (r) {
    return r.abilities.map(function (a) { return a.en; });
  }))).sort();
  console.log("특성 " + slugs.length + "종의 한국어 이름을 받는 중…");
  const abilityNames = {};
  await pool(slugs, async function (slug) {
    const a = await getJson(API + "/ability/" + slug);
    abilityNames[slug] = pick(a.names, "name") || slug;
  }, "특성");

  // PokéAPI에 한국어 도감 설명이 없는 포켓몬은 data/flavor-ko.json 의 자체 번역으로 채운다.
  let koFlavor = {};
  try {
    koFlavor = JSON.parse(await fsp.readFile(path.join(DATA, "flavor-ko.json"), "utf8"));
  } catch (e) { /* 없으면 영어 원문 그대로 둔다 */ }
  let patched = 0;
  records.forEach(function (r) {
    if (koFlavor[String(r.id)]) {
      r.flavor = koFlavor[String(r.id)];
      r.flavorTranslated = true;
      patched++;
    }
  });
  if (patched) console.log("한국어 설명이 없는 " + patched + "마리에 자체 번역을 적용했습니다.");

  await fsp.mkdir(path.join(DATA, "pokemon"), { recursive: true });
  await Promise.all(records.map(function (r) {
    return fsp.writeFile(path.join(DATA, "pokemon", r.id + ".json"), JSON.stringify(r), "utf8");
  }));
  await fsp.writeFile(path.join(DATA, "abilities.json"), JSON.stringify(abilityNames, null, 2), "utf8");

  // 목록 화면용 색인 — 1000마리를 한 번에 그리기 위한 가벼운 요약본
  const index = records.map(function (r) {
    return { id: r.id, name: r.name, nameEn: r.nameEn, types: r.types, sprite: r.sprite };
  });
  await fsp.writeFile(path.join(DATA, "index.json"), JSON.stringify(index), "utf8");
  console.log("JSON 저장 완료 (" + records.length + "마리)\n");

  return records;
}

// 진화 사슬을 받아 "계통" 목록으로 만든다.
// 한 계통은 단계(stage)별 묶음이다: 꼬부기 → 어니부기 → 거북왕, 이브이 → (샤미드·쥬피썬더·…)
async function collectFamilies(records) {
  const byName = {};
  records.forEach(function (r) { byName[r.nameEn] = r.id; });

  const list = await getJson(API + "/evolution-chain?limit=1000");
  console.log("진화 계통 " + list.results.length + "개를 받는 중…");

  const chains = await pool(list.results, function (row) {
    return getJson(row.url).catch(function () { return null; });
  }, "계통");

  const families = [];
  const seen = new Set();

  chains.forEach(function (chain) {
    if (!chain || !chain.chain) return;
    const stages = [];
    // 사슬은 evolves_to 로 이어지는 나무다. 깊이별로 훑어 단계를 만든다.
    let level = [chain.chain];
    while (level.length) {
      const ids = level
        .map(function (n) { return byName[n.species.name]; })
        .filter(function (id) { return id !== undefined; });
      if (ids.length) stages.push(Array.from(new Set(ids)).sort(function (a, b) { return a - b; }));
      level = level.reduce(function (acc, n) { return acc.concat(n.evolves_to || []); }, []);
    }
    if (!stages.length) return;
    stages.forEach(function (ids) { ids.forEach(function (id) { seen.add(id); }); });
    families.push({ id: chain.id, stages: stages });
  });

  // 계통에 속하지 않은 포켓몬(단독 종)도 한 마리짜리 계통으로 넣어 빠짐없이 보이게 한다
  records.forEach(function (r) {
    if (!seen.has(r.id)) families.push({ id: 10000 + r.id, stages: [[r.id]] });
  });

  // 도감 번호 순으로 읽히도록 계통의 첫 번호 기준 정렬
  families.sort(function (a, b) { return a.stages[0][0] - b.stages[0][0]; });

  await fsp.writeFile(path.join(DATA, "families.json"), JSON.stringify(families), "utf8");
  const total = families.reduce(function (n, f) {
    return n + f.stages.reduce(function (m, ids) { return m + ids.length; }, 0);
  }, 0);
  console.log("계통 " + families.length + "개 / 수록 " + total + "마리 → families.json\n");
}

async function sprites(records) {
  console.log("픽셀 스프라이트 " + records.length + "장을 받는 중…");
  await pool(records, function (r) {
    return download(SPRITE + "/" + r.id + ".png", path.join(DATA, "sprites", "small", r.id + ".png"))
      .catch(function () { return false; });
  }, "스프라이트");

  if (!WANT_ART) {
    console.log("\n공식 일러스트는 건너뜁니다. 필요하면: node fetch-data.js --art-only");
    return;
  }
  console.log("공식 일러스트 " + records.length + "장을 받는 중… (수백 MB, 시간이 걸립니다)");
  await pool(records, async function (r) {
    const url = r.art && r.art.startsWith("http")
      ? r.art : SPRITE + "/other/official-artwork/" + r.id + ".png";
    try {
      await download(url, path.join(DATA, "sprites", "art", r.id + ".png"));
      // 받았으니 도감이 내부 주소를 보도록 레코드를 갱신한다.
      const file = path.join(DATA, "pokemon", r.id + ".json");
      const rec = JSON.parse(fs.readFileSync(file, "utf8"));
      rec.art = rec.artLocal;
      fs.writeFileSync(file, JSON.stringify(rec), "utf8");
    } catch (e) { /* 일러스트 한 장 실패는 치명적이지 않다 */ }
  }, "일러스트");
}

(async function () {
  const started = Date.now();
  let records;
  if (ART_ONLY || EVO_ONLY) {
    const idx = JSON.parse(await fsp.readFile(path.join(DATA, "index.json"), "utf8"));
    records = await Promise.all(idx.map(async function (r) {
      return JSON.parse(await fsp.readFile(path.join(DATA, "pokemon", r.id + ".json"), "utf8"));
    }));
  } else {
    records = await collect();
  }
  if (EVO_ONLY) {
    await collectFamilies(records);
    console.log("→ families.json 갱신 완료 (" + Math.round((Date.now() - started) / 1000) + "초)");
    return;
  }
  await collectFamilies(records);
  await sprites(records);
  console.log("\n→ " + DATA + " 준비 완료 (" + Math.round((Date.now() - started) / 1000) + "초)");
  console.log("   node server.js 로 내부 서버를 띄우세요.");
})();
