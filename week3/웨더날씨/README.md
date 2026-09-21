# 웨더날씨 · OpenWeatherMap 라이브

도시를 검색하면 [OpenWeatherMap](https://openweathermap.org) 서버에 `fetch()`로 직접 요청해
현재 날씨 · 시간별 예보(3시간 간격) · 5일 예보를 실시간으로 가져오는 단일 HTML 페이지.
포켓몬도감과 같은 방식(빌드 없음, 파일 하나).

## 열기

- 로컬: `index.html` 더블클릭
- 배포: https://dhtor534-cmd.github.io/yudaeng/week3/%EC%9B%A8%EB%8D%94%EB%82%A0%EC%94%A8/

## 쓰는 API

| 용도 | 엔드포인트 |
| --- | --- |
| 현재 날씨 | `GET /data/2.5/weather?lat=&lon=&units=metric&lang=kr&appid=` |
| 시간별 예보 (3h 간격, 5일) | `GET /data/2.5/forecast?lat=&lon=&units=metric&lang=kr&appid=` |
| 도시 이름 → 좌표 | `GET /geo/1.0/direct?q=&limit=1&appid=` |
| 아이콘 | `https://openweathermap.org/img/wn/{code}@2x.png` |

베이스 URL은 `https://api.openweathermap.org`.

## 기능

- 도시 검색 — 영문 / 한글 / `Seoul,KR` 형식 모두 인식 (지오코딩 후 좌표로 조회)
- 프리셋 칩: 서울 · 부산 · 제주 · 도쿄 · 뉴욕 · 런던
- 📍 현재 위치 — 브라우저 geolocation 권한
- 현재 카드: 기온 · 체감 · 습도 · 바람 · 기압 · 최저/최고 · 구름 · 가시거리
- 시간별 8칸: 기온 + 강수확률(`pop`)
- 5일 예보: 3시간 예보를 현지시각 기준 일 단위로 묶어 최고/최저 집계, 정오에 가장 가까운 슬롯의 날씨로 대표 아이콘
- 에러 처리: 401(키 미활성 — 생성 후 최대 2시간) / 404(도시 못 찾음) / 429(분당 60회 초과) 별 한글 안내 + 다시 시도

## API 키

`index.html` 안에 `API_KEY` 상수로 박혀 있음 (OpenWeatherMap 무료 플랜).
공개 저장소이므로 키가 노출됨 — 오남용이 의심되면
[home.openweathermap.org/api_keys](https://home.openweathermap.org/api_keys) 에서 재발급하고 파일의 상수만 교체.

## 만든 과정

`SESSION_LOG.md` 참고.
플레이라이트(CDP :9222)로 OpenWeatherMap 로그인 → API 키 확인 → 이 페이지 제작 → 로컬 렌더 테스트.
