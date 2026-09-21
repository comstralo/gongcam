# E2E 레이아웃 회귀 테스트 (Playwright)

## 배경

2026-09-20~21 세션에서 iOS PWA/PC/브라우저 줌 배율 간 레이아웃 불일치
(문서가 뷰포트보다 커져 로드 직후부터 스크롤됨, v버튼이 화면 밖으로
잘림 등)를 여러 차례 겪었고, 매번 사람이 스크린샷으로 재현·검증해야
했다. 이 스위트는 그런 시행착오를 줄이기 위해 핵심 레이아웃 불변식
("문서가 뷰포트를 넘지 않는다", "고정 영역이 스크롤 시에도 고정된다"
등)만 최소한으로 기계적으로 검증한다.

시각적 디자인 회귀(색상/간격/폰트 등)는 다루지 않는다 — 그건 사람 눈이
더 정확하고, 이 스위트의 목적은 구조적 회귀만 빠르게 잡는 것이다.

## 실행

```bash
# 최초 1회: 브라우저 엔진 설치
npx playwright install chromium

# 로그인 불필요 테스트만 (로그인 페이지 등)
npx playwright test

# 특정 프로젝트(뷰포트 프리셋)만
npx playwright test --project=mobile-iphone
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

### 설정

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
스킵된다(`tests/e2e/fixtures.ts`의 `authedPage` fixture) — CI나 다른
개발자 환경에서 자격 증명이 없어 실패하는 대신 "건너뜀"으로 표시된다.

## 보안 설계 메모

- `/dev/login`은 `env.DEV_LOGIN_SECRET`이 **명시적으로 등록되어 있을
  때만** 존재한다. `wrangler.toml`에는 이 값이 전혀 없다(secret으로만
  관리) — 실수로 커밋될 여지 자체가 없다.
- 이 엔드포인트로 로그인해도 참여자 명단에 없는 이메일로는 로그인할 수
  없다 — "실명 확인(구글 인증)을 생략"하는 것이지 "권한 검사를
  생략"하는 게 아니다.
- 발급된 세션 토큰은 일반 로그인 토큰과 동일한 TTL/서명 검증을 거친다
  (별도로 더 강한 권한을 주지 않는다).
