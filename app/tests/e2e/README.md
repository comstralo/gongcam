# E2E 레이아웃 회귀 테스트 (Playwright)

## 배경

2026-09-20~22 세션에서 iOS PWA/PC/브라우저 줌 배율 간 레이아웃 불일치
(문서가 뷰포트보다 커져 로드 직후부터 스크롤됨, v버튼이 화면 밖으로
잘림, 콘텐츠가 짧아도 padding만으로 스크롤 여지가 생김 등)를 여러 차례
겪었고, 매번 사람이 스크린샷으로 재현·검증해야 했다. 이 스위트는 그런
시행착오를 줄이기 위해 핵심 레이아웃 불변식("문서가 뷰포트를 넘지
않는다", "고정 영역이 스크롤 시에도 고정된다", "콘텐츠가 짧으면 스크롤
여지가 없다" 등)만 최소한으로 기계적으로 검증한다.

시각적 디자인 회귀(색상/간격/폰트 등)는 다루지 않는다 — 그건 사람 눈이
더 정확하고, 이 스위트의 목적은 구조적 회귀만 빠르게 잡는 것이다.

## 엔진 구성 (2026-09-22 보강)

5개 프로젝트 중 2개(`mobile-iphone`, `tablet-ipad`)는 **실제 WebKit
엔진**으로 실행된다 — `devices["iPhone 14"]`/`devices["iPad (gen 7)"]`
프리셋이 `defaultBrowserType: "webkit"`을 지정하고, 이 값이 Playwright
설정의 `use` 스프레드를 통해 실제로 반영된다(직접 실측 확인: 각
프로젝트에서 `browserName` fixture 값이 `webkit`으로 나옴). 나머지
3개(`desktop-chromium*`, `mobile-android`)는 Chromium이다.

이게 중요한 이유: `useKeyboardInset.ts`의 `isStandalonePwa()` 가드,
`visualViewport.offsetTop` 원복 실패 우회 로직 등은 WebKit(Safari) 고유
동작에 의존한다 — Chromium만으로는 이런 버그를 재현할 수 없다. WebKit
바이너리가 로컬에 없다면 최초 1회 `npx playwright install webkit`으로
설치해야 한다.

## PWA standalone 시뮬레이션 (2026-09-22 보강)

`isStandalonePwa()`는 `matchMedia("(display-mode: standalone)")` 또는
`navigator.standalone`(iOS 전용 비표준 프로퍼티) 중 하나만 true여도
전체가 true가 된다. `fixtures.ts`의 `pwaPage`/`authedPwaPage` fixture가
두 조건을 모두 흉내 낸다(`addInitScript`로 `navigator.standalone`을
직접 정의하고, `window.matchMedia`를 오버라이드) — 실제 iOS 홈 화면
PWA와 최대한 가깝게 재현한다.

- `pwaPage` — 로그인 불필요, PWA standalone만 흉내
- `authedPwaPage` — 로그인 + PWA standalone 둘 다 흉내(이 세션에서
  문제가 된 로직 대부분이 "로그인 후 메인 화면 + PWA" 조합에서만
  실제로 켜지므로 이 조합을 쓴다)

## 실행

```bash
# 최초 1회: 브라우저 엔진 설치 (chromium + webkit 둘 다 필요)
npx playwright install chromium webkit

# 로그인 불필요 테스트만 (로그인 페이지 등)
npx playwright test

# 특정 프로젝트(뷰포트 프리셋)만
npx playwright test --project=mobile-iphone            # WebKit, iOS 고유 버그 검증용
npx playwright test --project=tablet-ipad               # WebKit
npx playwright test --project=desktop-chromium-narrow   # v버튼 잘림 버그가 재현됐던 950px 폭

# 결과 리포트 보기
npx playwright show-report
```

기본적으로 `https://comstralo.github.io/gongcam`(배포된 프로덕션)을
대상으로 실행한다. 로컬 dev 서버를 대상으로 하려면:

```bash
E2E_BASE_URL=http://localhost:5173 npx playwright test
```

## 로그인 필요 테스트 (대시보드/제보/채팅/설정)

이 앱은 구글 OAuth 로그인이라 자동화 도구가 로그인 화면 자체를 통과할
수 없다. 대신 `frame-checker-worker/src/auth.js`의 `handleDevLogin`
(`POST /dev/login`)을 쓴다 — 구글 credential 검증만 건너뛸 뿐, 참여자
명단 검증(`getSheetViewerEmails`)은 실제 로그인과 동일하게 거치므로
안전한 대체물이다. 이 엔드포인트는 `env.DEV_LOGIN_SECRET`(wrangler
secret)이 등록되어 있을 때만 존재하고, 그렇지 않으면 프로덕션에서
`/dev/login`은 그 경로가 있는지조차 알 수 없이 항상 404를 반환한다.

### 로컬 설정

```bash
cp .env.test.example .env.test
```

`.env.test`에 다음 두 값을 채운다:

- `E2E_DEV_LOGIN_SECRET` — `frame-checker-worker`에 등록된
  `DEV_LOGIN_SECRET` 값. 이미 등록되어 있다면 팀 내 보안 채널로 전달받고,
  없다면 `cd frame-checker-worker && npx wrangler secret put DEV_LOGIN_SECRET`
  로 새로 등록한다(기존 값을 조회하는 방법은 없다 — `wrangler secret list`는
  이름만 보여준다).
- `E2E_TEST_EMAIL` — 참여자 명단에 등록된 테스트 계정 이메일.

`.env.test`는 `.gitignore`에 등록되어 있어 커밋되지 않는다. **이 파일의
값을 코드, 커밋 메시지, 이슈, 채팅 등 어디에도 평문으로 남기지 말 것.**

이 값들이 없으면 로그인이 필요한 테스트는 실패하지 않고 스스로
스킵된다(`tests/e2e/fixtures.ts`의 `authedPage`/`authedPwaPage`
fixture) — CI나 다른 개발자 환경에서 자격 증명이 없어 실패하는 대신
"건너뜀"으로 표시된다.

## CI 자동화 (2026-09-22 추가)

`.github/workflows/deploy.yml`의 `e2e` job이 `deploy` job(GitHub Pages
배포) 성공 직후 자동으로 이 스위트 전체를 실행한다. 로그인 필요
테스트까지 포함해 전부 돌리기로 결정했으므로(사용자 확인), 저장소
Secrets에 `E2E_DEV_LOGIN_SECRET`/`E2E_TEST_EMAIL`이 등록되어 있다 —
`gh secret list`로 등록 여부만 확인 가능하고 값 자체는 조회할 수 없다.

`index.html`은 GitHub Pages에서 10분간 캐싱되므로(`useVersionCheck.ts`
참고), `deploy` job이 끝났다고 바로 테스트하면 옛 번들을 대상으로 할 수
있다 — `e2e` job은 먼저 `version.json`(no-store, 값이 정확히 짧은 커밋
해시)을 폴링해 이번 커밋의 배포가 실제로 반영됐는지 확인한 뒤(최대
2분) 테스트를 시작한다.

실패 시 Playwright HTML 리포트가 워크플로우 아티팩트로 업로드된다
(`Actions` 탭 → 해당 실행 → Artifacts → `playwright-report`, 14일 보관).

🔧 [버그 수정, 2026-09-22 배포 후 실측] CI는 `--workers=1`로 완전히
순차 실행한다 — 처음엔 기본 병렬(2워커)로 돌렸는데, 7개 프로젝트가
로그인 필요 테스트를 거의 동시에 실행하며 `/dev/login`+`/status`를
프로덕션 백엔드에 몰아쳐 Google Sheets API가 순간적으로 쓰로틀링되는
것으로 보이는 증상(요청이 500이 아니라 응답 자체를 못 받음,
Playwright trace의 `status:-1`로 확인)을 실측했다. `retries`를 2로
늘려 흡수를 시도했으나 오히려 실행 시간만 늘고(4~5분→11분대) 실패
프로젝트 수가 더 넓어졌다(동시 재시도가 부하를 더 키운 것으로 추정) —
`--workers=1`로 동시 요청 자체를 없애는 쪽으로 정정했다. 실행 시간은
늘어나지만(순차 실행) 배포 파이프라인의 신뢰성이 우선이라는 판단
(사용자 확인).

## 보안 설계 메모

- `/dev/login`은 `env.DEV_LOGIN_SECRET`이 **명시적으로 등록되어 있을
  때만** 존재한다. `wrangler.toml`에는 이 값이 전혀 없다(secret으로만
  관리) — 실수로 커밋될 여지 자체가 없다.
- 이 엔드포인트로 로그인해도 참여자 명단에 없는 이메일로는 로그인할 수
  없다 — "실명 확인(구글 인증)을 생략"하는 것이지 "권한 검사를
  생략"하는 게 아니다.
- 발급된 세션 토큰은 일반 로그인 토큰과 동일한 TTL/서명 검증을 거친다
  (별도로 더 강한 권한을 주지 않는다).
- GitHub Secrets로 등록한 `E2E_DEV_LOGIN_SECRET`은 워크플로우 로그에서
  자동으로 마스킹된다. 다만 이 저장소에 쓰기 권한이 있는 사람은 워크플로우
  정의를 바꿔 이 값을 실질적으로 사용할 수 있다는 점은 인지하고 있어야
  한다 — 협업자를 늘릴 계획이면 이 시크릿의 노출 범위를 재검토할 것.
