# 테스트 인프라 (`app`)

## 배경

`docs/TESTING.md`가 `frame-checker-worker`(백엔드)의 테스트 인프라를
다루는 것과 대칭으로, 이 문서는 `app`(프론트엔드)을 다룬다.

2026-09-22 시점까지 `app`에는 `tests/e2e/`(Playwright)만 있었다 —
문서/타이틀 자체가 "레이아웃 구조 회귀만 잡는다"고 명시한 대로(문서
`app/tests/e2e/README.md` 참고), hooks의 개별 로직(`useKeyboardInset.ts`
의 KST 시각 경계 판정 등)이나 순수 함수(`date.ts`/`periods.ts`)는
E2E가 브라우저를 실제로 띄워야만 간접적으로 exercise될 뿐, 그 값
자체를 직접 겨냥해 빠르게 검증할 방법이 없었다. 사용자 질문
"프론트엔드, 백엔드 테스트 도구 정비는 끝난거야?"에 대한 전수조사
(백엔드는 `docs/TESTING.md` "구조 개선 23차" 참고)에서 이 공백이
확인되어, `frame-checker-worker`가 이미 쓰고 있는 vitest를 프론트엔드
에도 도입했다.

## 도구 선택

**Vitest 5 + jsdom + `@testing-library/react`(RTL) 16** — 백엔드가
`@cloudflare/vitest-plugin`으로 Vitest 4를 이미 채택한 것과 같은
계열 도구를 쓰되, 프론트엔드는 실제 workerd 런타임이 필요 없고
(DOM API만 있으면 됨) 대신 React 컴포넌트/hooks를 렌더링해야 하므로
`jsdom` 환경 + RTL을 추가했다. Vite 8/React 19와 호환되는 최신
버전(설치 시점 기준 vitest@5.0.1, @testing-library/react@16.3.3,
@testing-library/jest-dom@7.0.1, jsdom@30.1.0)을 그대로 썼다.

```bash
cd app
npm test        # 전체 단위 테스트 실행 (vitest run)
npm run test:watch  # watch 모드
```

## 파일 구조

- `app/vitest.config.ts` — `playwright.config.ts`와 대칭을 이루는
  별도 설정 파일(vite.config.ts에 `test` 옵션을 얹지 않음 — 프로덕션
  번들링 설정과 테스트 설정의 관심사를 분리하기 위해). `vite.config.ts`
  와 동일한 `@` → `src/` 별칭을 독립적으로 정의한다(값이 갈리면 바로
  드러나도록 같은 계산식 사용).
  - `include: ["src/**/*.{test,spec}.{ts,tsx}"]` — 테스트 파일을
    소스 파일 옆에 둔다(`session.ts` 옆에 `session.test.ts`).
  - `exclude: ["tests/e2e/**", ...]` — Playwright 스위트와 완전히
    분리해, 두 실행기가 같은 파일을 서로 다르게 해석해 충돌할 위험을
    원천 차단한다.
- `app/vitest.setup.ts` — `@testing-library/jest-dom/vitest`를
  로드해 `toBeInTheDocument()` 등 커스텀 matcher를 전역 `expect`에
  확장한다.
- `app/tsconfig.node.json`의 `include`에 `vitest.config.ts`/
  `vitest.setup.ts`를 추가해, 이 설정 파일들도 `npx tsc -b`(CI가
  돌리는 것과 동일)의 타입체크 대상이 되게 했다.
- 테스트 파일은 `src/` 안에 소스와 나란히 둔다(`src/lib/date.test.ts`,
  `src/hooks/useNetworkStatus.test.ts` 등) — 백엔드가 `test/` 별도
  디렉터리를 쓰는 것과 다른 관례이지만, RTL 생태계(Vite/CRA 템플릿)의
  표준 관례를 따랐다. `tsconfig.app.json`의 `include: ["src"]`가
  이미 이 파일들을 포함하므로 별도 설정 없이 `npm run build`(`tsc -b`)
  타입체크 대상에도 자동으로 들어간다 — 실제 프로덕션 번들(Vite)에는
  당연히 포함되지 않는다(Vite는 `.test.ts`를 진입점으로 삼지 않음).

## CI 통합 (2026-09-22)

`.github/workflows/ci.yml`의 `app` job에 `npm test`를 추가했다 —
`worker` job이 이미 `npm test`(vitest)를 돌리는 것과 대칭. `lint`/
`tsc -b`처럼 실패하면 이 job이 실패해 PR/main push를 막는다(배포
게이트인 `deploy.yml`과는 별개).

## 첫 커버리지 (2026-09-22)

전수조사(`src/hooks/*.ts`, `src/lib/**/*.ts` 중 React에 강하게
결합되지 않은 순수 로직/hooks를 우선순위로 선정)로 4개 파일, 37개
테스트를 신설했다.

- **`src/lib/auth/session.test.ts`**(12케이스) — `saveSession`의
  mode(`persist`/`once`)별 localStorage/sessionStorage 저장 분기,
  `getSession`의 `sessionStorage`가 `localStorage`보다 우선하는
  순서, 손상된 JSON/필드 누락 시 예외 없이 `null`을 반환하는지,
  `isAdmin`의 대소문자 무시 비교. `AuthContext.tsx`의
  "비로그인 대시보드 순간 노출 버그"(이전 세션에서 수정) 등 세션
  검증 로직 전체가 이 저장 계층 위에 서 있는데, 지금까지 이 계층
  자체는 한 번도 직접 테스트되지 않았다.
- **`src/lib/date.test.ts`**(7케이스) — `toKSTDateString`이
  `Intl.toLocaleDateString(..., { timeZone: "Asia/Seoul" })`로
  KST/UTC 9시간 시차 경계(예: UTC 15:00 = KST 자정)를 정확히
  반영하는지. 백엔드 `date-utils.js`와 같은 종류의 KST 계산이지만
  구현 방식이 완전히 달라(수동 UTC+9 계산 vs Intl API) 독립적으로
  검증이 필요했다.
- **`src/lib/periods.test.ts`**(13케이스) — `getPeriodPhase`의
  세 상태(`in-period`/`break`/`outside`) 전환 경계를 전수 검증:
  1교시 시작 정확히 1시간 전(break 진입 경계), 교시 종료 정각(다음
  교시로 넘어가는 배타적 상한), 마지막 교시 종료 후 다음날 1교시까지
  남은 시간 계산, 자정 직후의 outside 판정. `formatRemaining`의
  MM:SS/H:MM:SS 전환, 음수 ms 방어.
- **`src/hooks/useNetworkStatus.test.ts`**(5케이스) — 이전 세션
  (오프라인 감지/안내 기능)에서 만든 훅의 첫 자동 테스트.
  `@testing-library/react`의 `renderHook`/`act`로 `online`/`offline`
  이벤트를 직접 디스패치해 상태 전환과 언마운트 후 리스너 정리를
  검증한다 — 이후 hooks 테스트가 따를 기본 패턴이기도 하다.

## 다음 단계 (미착수)

- **`useKeyboardInset.ts`**(이번 세션 전체에서 가장 많이 다룬 파일)
  — `isStandalonePwa()`/`useVisualViewportRect()`는 `window.matchMedia`/
  `window.visualViewport`/`navigator.standalone` 등 jsdom이 기본
  제공하지 않는 API에 의존해 mock 설계가 필요하다. `tests/e2e/
  fixtures.ts`의 `injectPwaStandalone`/`injectKeyboardUp`이 이미
  Playwright용으로 이 값들을 흉내 내는 패턴을 만들어뒀으므로, 그
  로직을 vitest용으로 이식하면 브라우저 전체를 띄우지 않고도(E2E보다
  훨씬 빠르게) 같은 분기를 검증할 수 있다.
- **`useResizeObserver.ts`** — jsdom에 `ResizeObserver`가 없어
  전역 mock이 필요하다(`vi.stubGlobal("ResizeObserver", ...)`).
- 컴포넌트 테스트(RTL의 `render`+`screen`) 자체는 아직 한 건도
  없다 — 이번 라운드는 hooks/순수 로직에 한정했다(사용자 확인 없이
  범위를 임의로 넓히지 않음).
