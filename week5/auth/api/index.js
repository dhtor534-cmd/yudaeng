// Vercel 서버리스 함수 — /api/* 를 전부 여기서 받는다 (vercel.json 의 routes 참고).
// 로컬 server.js 와 같은 handler.js 를 쓰므로 동작이 갈라지지 않는다.
module.exports = require("../handler").apiHandler;
