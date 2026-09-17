# 드림캔버스 · 프롬프트 이미지 생성기

미드저니처럼 프롬프트를 넣고 4장을 받아 `U1~U4`(업스케일) · `V1~V4`(변형)로 가지를 치는 단일 페이지 앱.
React 18 + Babel을 CDN으로 불러 쓰는 **파일 하나**(빌드 없음)이고,
fal.ai 호출은 **같은 폴더의 `server.js` 프록시**가 대신 한다 — API 키는 브라우저에 절대 내려가지 않는다.

## 두 가지 엔진

| 모드 | 동작 | 필요한 것 |
| --- | --- | --- |
| **목업** | 네트워크 요청 0건. 프롬프트 키워드로 팔레트를 고르고 시드 난수로 캔버스에 직접 그린다 | 없음 (`index.html` 더블클릭) |
| **fal.ai 실연동** | `/api/imagine` → `server.js` → `queue.fal.run` (FLUX.1) | Node 18+, `.env` 의 `FAL_KEY` |

화면 우상단 프롬프트 바와 사이드바 **설정** 에서 모드를 바꾼다.
실연동 중 실패한 칸은 목업 그림으로 대체되고, 카드에 빨간 오류 문구가 뜬다.

## 실행

```bash
cp .env.example .env          # FAL_KEY=키아이디:시크릿
node server.js                # → http://localhost:8787
```

환경변수로 직접 줘도 된다 (이쪽이 우선).

```bash
FAL_KEY=xxx:yyy PORT=9000 node server.js      # bash
$env:FAL_KEY="xxx:yyy"; node server.js        # PowerShell
```

`index.html` 을 그냥 더블클릭해도 열리지만, 그때는 서버가 없으므로 **목업 모드만** 동작한다.
(같은 이유로 GitHub Pages 에 올리면 목업 전용이다. 실연동은 Node 가 도는 곳이 필요하다.)

## 키를 노출하지 않는 방법

- 키는 `server.js` 프로세스의 환경변수(`process.env.FAL_KEY`)에만 있다. `index.html` 어디에도 없다.
- 브라우저가 부르는 건 `/api/imagine`, `/api/status/:id`, `/api/result/:id` 뿐이라 개발자도구 네트워크 탭에도 키가 안 보인다.
- fal 큐의 `status_url` / `response_url` 은 서버 메모리의 `Map` 에만 두고, 브라우저에는 불투명한 `id` 만 준다.
- 브라우저가 임의의 fal 모델을 부르지 못하도록 서버가 엔드포인트를 화이트리스트로 고정하고, 입력 필드도 추려서 다시 만든다.
- `.env` 는 `.gitignore` 에 있고, 정적 서빙에서도 `403` 으로 막는다.

## 서버 API

| 메서드 | 경로 | 하는 일 |
| --- | --- | --- |
| GET | `/api/health` | 키 설정 여부(`hasKey`) · 모델 목록. 앱이 시작할 때 부른다 |
| POST | `/api/imagine` | `{op, model, prompt, image_size, seed, image_url?}` → `{id}` (fal 큐에 제출) |
| GET | `/api/status/:id` | `{status, queue_position}` |
| GET | `/api/result/:id` | `{images:[{url,width,height}]}` |

`op` 는 `text`(생성) · `vary`(이미지→이미지) · `upscale` 셋이고, 서버에서 이렇게 매핑된다.

| op / 모델 | fal 엔드포인트 |
| --- | --- |
| `text` + schnell | `fal-ai/flux/schnell` (4 step) |
| `text` + dev | `fal-ai/flux/dev` (28 step, `guidance_scale`) |
| `vary` | `fal-ai/flux/dev/image-to-image` |
| `upscale` | `fal-ai/esrgan` (×2) |

타일 4칸은 요청 4건으로 나눠 보낸다 — 칸마다 시드와 진행률이 따로 논다.

## 기능

- 프롬프트 바: 화면비(1:1 · 3:2 · 2:3 · 16:9 · 9:16) · 모델 · 스타일화 · 카오스 · `--no` 제외어 · 스타일 칩 8종 · 🎲 랜덤 아이디어
- 작업 카드: 4분할 그리드, 칸별 진행률(대기열 → 노이즈 제거 → 디테일 강화 → 마무리), `U1~U4` / `V1~V4` / 다시 굴리기 / 프롬프트 가져오기
- 크게 보기: 시드 · 해상도 · 파라미터 표, 즐겨찾기, 시드/프롬프트 복사, 원본 저장, 여기서도 업스케일·변형
- 갤러리 · 즐겨찾기 탭, 사이드바 최근 프롬프트(누르면 설정까지 복원)
- 시작하면 목업 히스토리 5건이 채워져 있어 빈 화면을 보지 않는다

## 목업 이미지가 만들어지는 방식

`renderArt()` 하나가 시드로 그림 전체를 결정한다 — **같은 시드 + 같은 프롬프트면 언제나 같은 그림**.

1. 프롬프트 키워드로 팔레트 10종 중 하나를 고른다 (네온 시티 · 설산 · 심해 · 안개 숲 · 우주 · 벚꽃 · 느와르 · 용암 · 사막 · 몽환 추상)
2. 팔레트의 `kind` 에 따라 장면을 그린다 — 스카이라인 / 산 능선 / 나무 / 수평선 반사 / 사구 / 별과 고리 행성 / 리본 곡선
3. 인물 키워드(`소녀`, `portrait` …)가 있으면 실루엣과 림라이트를 얹는다
4. 광원 · 보케 입자 · 색 오버레이(모델별) · 비네트 · 필름 그레인 순으로 마감

`--chaos` 는 얼룩과 입자 수를, `--s`(스타일화)는 색 오버레이 세기를 올린다.

## 파일

```
이미지생성기/
├── index.html      앱 (아트 엔진 + React, 파일 하나)
├── server.js       fal.ai 프록시 + 정적 서버 (Node 표준 모듈만)
├── .env.example    FAL_KEY 자리
└── .gitignore      .env 제외
```
