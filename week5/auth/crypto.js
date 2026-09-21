// 인증에 쓰는 암호 관련 함수 모음 — node:crypto 만 쓴다 (외부 패키지 없음).
//
//   1) 비밀번호 저장     : scrypt 로 해시. 원문은 어디에도 남기지 않는다.
//   2) 액세스 토큰       : JWT (HS256). 서버가 서명하고, 서버가 검증한다.
//   3) 리프레시 토큰     : 그냥 랜덤 문자열. DB 에는 그 해시만 저장한다.
//
// JWT 를 직접 만드는 이유는 의존성을 늘리지 않으려는 것뿐이다.
// jsonwebtoken 패키지로 갈아끼우고 싶으면 README 의 "라이브러리로 바꾸기" 참고.

const crypto = require("node:crypto");

/* =========================================================
   1) 비밀번호 — scrypt
   =========================================================
   같은 비밀번호라도 계정마다 salt 가 달라서 해시가 다르게 나온다.
   저장 형식:  scrypt$N$r$p$<salt(base64url)>$<hash(base64url)>
   나중에 파라미터를 올리더라도 옛날 해시를 그대로 검증할 수 있게 값을 같이 적어 둔다. */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const b64 = (buf) => buf.toString("base64url");
const unb64 = (s) => Buffer.from(s, "base64url");

function scrypt(password, salt, opts) {
  return new Promise((resolve, reject) => {
    // maxmem 을 안 올리면 N=16384 에서 "memory limit exceeded" 가 난다.
    crypto.scrypt(password, salt, opts.keylen, { N: opts.N, r: opts.r, p: opts.p, maxmem: 256 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** 비밀번호 → 저장용 문자열 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64(salt)}$${b64(key)}`;
}

/** 입력한 비밀번호가 저장된 해시와 맞는지. 형식이 깨져 있어도 예외를 던지지 않고 false 를 준다. */
async function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, salt, hash] = String(stored).split("$");
    if (algo !== "scrypt") return false;
    const expected = unb64(hash);
    const actual = await scrypt(password, unb64(salt), {
      N: Number(N), r: Number(r), p: Number(p), keylen: expected.length,
    });
    // 길이가 다르면 timingSafeEqual 이 던지므로 먼저 본다.
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);   // 글자 수만큼 시간이 달라지지 않게 비교
  } catch {
    return false;
  }
}

/* =========================================================
   2) 액세스 토큰 — JWT (HS256)
   =========================================================
   JWT 는 점 두 개로 이어 붙인 문자열이다:

       base64url(헤더) . base64url(내용) . base64url(서명)

   앞의 두 토막은 누구나 읽을 수 있다 (암호화가 아니다 — 비밀을 담으면 안 된다).
   서명은 JWT_SECRET 을 아는 쪽만 만들 수 있어서, 내용이 한 글자라도 바뀌면 검증이 깨진다. */

const HEADER = b64(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));

function sign(data, secret) {
  return b64(crypto.createHmac("sha256", secret).update(data).digest());
}

/**
 * @param payload  토큰에 담을 내용 (sub=사용자 id, email, nickname 정도만)
 * @param secret   JWT_SECRET
 * @param ttlSec   유효 시간(초)
 */
function signJwt(payload, secret, ttlSec) {
  const now = Math.floor(Date.now() / 1000);
  const body = b64(Buffer.from(JSON.stringify({
    ...payload,
    iat: now,              // 발급 시각
    exp: now + ttlSec,     // 만료 시각 — 검증할 때 이걸 본다
  })));
  const data = `${HEADER}.${body}`;
  return `${data}.${sign(data, secret)}`;
}

/**
 * 토큰을 검증하고 내용을 돌려준다. 못 믿을 토큰이면 null.
 * 실패 이유를 밖으로 자세히 알려주지 않는다 (공격자에게 힌트가 된다).
 */
function verifyJwt(token, secret) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;

  // alg 를 고정한다. 토큰이 스스로 "나는 alg:none 이야" 라고 주장하게 두면 안 된다.
  let header;
  try { header = JSON.parse(unb64(head).toString("utf8")); } catch { return null; }
  if (!header || header.alg !== "HS256" || header.typ !== "JWT") return null;

  const expected = Buffer.from(sign(`${head}.${body}`, secret));
  const actual = Buffer.from(sig);
  if (actual.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(actual, expected)) return null;

  let payload;
  try { payload = JSON.parse(unb64(body).toString("utf8")); } catch { return null; }
  if (!payload || typeof payload !== "object") return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;   // 만료
  if (typeof payload.iat === "number" && payload.iat > now + 60) return null; // 미래에 발급된 토큰
  return payload;
}

/* =========================================================
   3) 리프레시 토큰 — 랜덤 문자열
   =========================================================
   JWT 와 달리 내용이 없다. DB 에 있는지로만 판단하므로 로그아웃 때 바로 무효화할 수 있다.
   DB 에는 원문 대신 SHA-256 해시를 넣는다 — DB 가 통째로 새어도 토큰을 재사용할 수 없게. */

const newRefreshToken = () => crypto.randomBytes(32).toString("base64url");
const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

module.exports = { hashPassword, verifyPassword, signJwt, verifyJwt, newRefreshToken, hashToken };
