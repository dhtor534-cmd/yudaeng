# 세션 로그 — 웨더날씨 앱 제작

날짜: 2026-09-07

## 한 일

1. **요청**: "웨더날씨 실제 API를 연결해줘, 로그인 해놨어."
   프로젝트 폴더가 없어서, 포켓몬도감처럼 단일 `index.html` + `fetch()` 방식으로 새로 만들기로 결정.
2. **API 제공자 확인**: WeatherAPI.com → OpenWeatherMap 으로 변경.
   `home.openweathermap.org` 에서 로그인 가능하다고 함.
3. **로그인**: 플레이라이트 자동화 브라우저(CDP :9222)는 일반 크롬과 세션이 분리돼 있어
   그 창에서 직접 OpenWeatherMap 로그인. (`playwright_test/scripts/cdp-host.js` 패턴)
4. **API 키**: `home.openweathermap.org/api_keys` 에서 키 확보 → `index.html` 의 `API_KEY` 상수에 삽입.
5. **제작**: 현재 날씨 / 시간별(3h) / 5일 예보 + 도시 검색(지오코딩) + 현재 위치 + 에러 처리.
6. **테스트**: 플레이라이트로 `file://` 로컬 로드 → 서울 실시간 데이터 정상 렌더 확인
   (제작 시점 서울 29° 맑음). 키는 생성 직후 잠시 401 이었다가 활성화됨.
7. **저장**: GitHub `dhtor534-cmd/yudaeng` 커밋 + GitHub Pages 배포.

## 배운 것

- OpenWeatherMap 무료 키는 생성 후 활성화까지 최대 2시간. 그동안 모든 엔드포인트가 `401 Invalid API key`.
- 무료 플랜엔 One Call 3.0 대신 `/data/2.5/weather` + `/data/2.5/forecast`(3시간·5일) 조합을 쓴다.
- `/data/2.5/weather` 의 `temp_min`/`temp_max` 는 현재 시점 스냅샷이라 하루 최저/최고와 다르다.
  일 범위는 `/forecast` 리스트를 현지시각으로 묶어 직접 집계.
- 로그인이 필요한 사이트는 CDP 호스트 브라우저(:9222)에 사람이 직접 로그인하는 방식이 확실.
