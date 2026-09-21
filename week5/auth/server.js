// week5 auth — 로컬 개발용 서버.
//   준비: .env 에 DATABASE_URL 과 JWT_SECRET      실행: node server.js  →  http://localhost:8792
//   .env 없이 그냥 실행해도 뜬다 (데모 모드 — 메모리 DB, 끄면 계정이 사라진다).
//
// 요청 처리는 전부 handler.js 에 있다. 이 파일은 포트를 열고 정적 파일까지 같이 내주는 껍데기다.
// Vercel 에 올릴 때는 이 파일이 안 쓰인다 (api/index.js 가 같은 handler.js 를 부른다).
const http = require("node:http");
const {
  handle, store, pool, ensureReady, sslOption, info,
  DEMO, PORT, SECRET_IS_EPHEMERAL, ACCESS_TTL_SEC, REFRESH_TTL_SEC,
} = require("./handler");

const server = http.createServer(handle);

if (require.main === module) {
  server.listen(PORT, async () => {
    console.log(`회원가입 · 로그인 (JWT) → http://localhost:${PORT}`);

    if (!pool) {
      console.log("  DATABASE_URL 없음 — .env 를 만들고 다시 실행하세요. (DEMO=off 를 지우면 데모 모드로 뜹니다)");
      return;
    }
    if (DEMO) {
      console.log("  DB: 데모 모드 (pg-mem · 메모리) — 서버를 끄면 가입한 계정이 사라집니다");
    } else {
      console.log(`  DB: ${info ? info.host + " / " + info.database : "(URL 형식을 읽지 못했습니다)"} · SSL ${sslOption() ? "on" : "off"}`);
    }
    console.log(`  토큰: 액세스 ${Math.round(ACCESS_TTL_SEC / 60)}분 · 리프레시 ${Math.round(REFRESH_TTL_SEC / 86400)}일`);
    if (SECRET_IS_EPHEMERAL) {
      console.log("  ⚠ JWT_SECRET 이 없어 임시 키로 돌립니다 — 서버를 다시 켜면 로그인이 전부 풀립니다.");
      console.log('    만들기: node -e "console.log(require(\'node:crypto\').randomBytes(48).toString(\'base64url\'))"');
    }

    try {
      await ensureReady();
      console.log(`  연결 성공 · 가입된 계정 ${await store.countUsers()}개`);
    } catch (e) {
      console.log("  연결 실패 — " + e.message);
      console.log("  (서버는 계속 떠 있습니다. .env 를 고치고 다시 실행하세요.)");
    }
  });
}

module.exports = { server, pool, store, PORT };
