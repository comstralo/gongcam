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

**`@testing-library/user-event`(6차 라운드에서 추가, 14.6.7)** —
`@base-ui/react`의 `Select` 등 pointer 이벤트 시퀀스에 반응하는
컴포넌트는 RTL의 `fireEvent.click`만으로 상호작용이 되지 않는다는
것을 스파이크로 확인했다(아래 6차 라운드 참고) — `user-event`가
실제 브라우저 이벤트 순서(pointerdown → pointerup → click 등)를
더 정확히 재현한다.

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
- `app/tsconfig.app.json`의 `include`에도 `vitest.setup.ts`를 추가
  했다(🔧 [버그 수정, 3차 라운드에서 발견] — jest-dom의 vitest 확장은
  `declare module "vitest"`로 `Assertion` 인터페이스에 커스텀
  matcher를 얹는데, 컴포넌트 테스트 파일이 속한 `tsconfig.app.json`
  프로젝트가 이 setup 파일을 몰라 `npx tsc -b`가
  `toBeInTheDocument`/`toHaveAttribute`/`toHaveStyle` 전부를 "존재하지
  않는 프로퍼티"로 잘못 판정했다 — `npx vitest run`은 자체적으로 이
  setup 파일을 로드해 정상 통과했으므로, 순수 로직 테스트(matcher를
  안 쓰는)만 있던 1~2차 라운드에서는 이 괴리가 드러나지 않았다).
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

## 두 번째 라운드 — mock이 필요한 hooks + 나머지 순수 로직 (2026-09-22)

사용자 지시 "프론트 도구도 보강 확실하게 하자"에 따라, 첫 라운드에서
"다음 단계"로 남겨뒀던 두 훅(mock 설계 필요)과 손대지 않은 나머지
순수 로직 파일을 마저 커버했다. 6개 파일, 47개 케이스 추가(4개
파일 37케이스 → 10개 파일 84케이스).

- **`src/hooks/useKeyboardInset.test.ts`**(15케이스) — 이 세션
  전체에서 가장 많이 수정된 파일의 첫 자동 테스트. `window.matchMedia`
  (`display-mode: standalone` 쿼리에만 응답)와 `window.visualViewport`
  (offsetTop/height 필드 + addEventListener/removeEventListener만
  구현한 최소 fake, `fire()`로 리스너를 직접 트리거)를 각각
  `vi.stubGlobal`로 mock했다 — `tests/e2e/fixtures.ts`의
  `injectPwaStandalone`/`injectKeyboardUp`이 검증한 것과 동일한 계약
  (PWA standalone이 아니면 이 좌표계를 전혀 안 탐, 키보드가 뜨면
  visualViewport.height를 그대로 씀, 없으면 screen 기반 추정치로
  대체, 가로/세로 판정)을 브라우저 없이 재현한다.
  `useSafeAreaInsetTop/Bottom`은 jsdom이 CSS `env()`를 해석하지
  못해(Node 콘솔로 확인) 항상 0을 반환한다는 사실 자체를 테스트로
  고정해뒀다 — "정상 동작 검증"이 아니라 "이 환경의 한계 표식"이며,
  jsdom이 나중에 env()를 지원하게 되면 이 테스트가 깨지는 것 자체가
  실제 안전영역 값을 검증하는 테스트로 교체할 신호가 된다.
- **`src/hooks/useResizeObserver.test.ts`**(6케이스) — jsdom에
  `ResizeObserver`가 없어(Node 콘솔로 확인) `observe`/`disconnect`
  호출을 기록하고 `trigger()`로 콜백을 직접 호출할 수 있는 mock
  클래스를 만들었다. 콜백 ref가 조건부 마운트/언마운트/재마운트에
  안전한지(이전 observer를 정확히 disconnect한 뒤 새 요소를 observe),
  `onResize`가 리렌더 후에도 항상 최신 함수를 참조하는지(ref 패턴)를
  검증한다.
- **`src/lib/push/endpointHash.test.ts`**(5케이스) — NIST SHA-256
  표준 테스트 벡터("", "abc")로 `crypto.subtle.digest` 기반 구현이
  정확한지 확인 — 서버(`handlePushSubscribe`)의 `sha256Hex`와 같은
  해시를 내야 하는 함수라 표준 벡터 일치가 특히 중요하다. vitest의
  jsdom 환경에서도 Node의 전역 `crypto.subtle`이 그대로 노출됨을
  이 테스트로 실증했다(jsdom 자체는 `crypto.subtle`이 없음).
- **`src/lib/utils.test.ts`**(7케이스) — `cn()` 유틸의 파일 상단
  주석이 기록한 실제 프로덕션 버그("제목과 하위 항목 크기가 똑같아
  보인다"는 지적의 근본 원인 — `extendTailwindMerge`로 커스텀 유틸
  `text-micro`/`text-micro-lg`를 `font-size` 그룹에 등록하기 전에는
  색상 클래스와 같은 충돌 그룹으로 오인돼 크기 클래스가 삭제됐다)를
  회귀 테스트로 고정했다.
- **`src/hooks/useTodayIndex.test.ts`**(6케이스) — `Intl.DateTimeFormat`
  기반 KST 요일 계산(백엔드의 UTC+9 수동 계산과 다른 구현이라
  독립 검증 필요), `vi.useFakeTimers()`로 KST 자정 경계에서 정확히
  다음날 인덱스로 갱신되는지, 자정 타이머가 매번 다시 걸리는지
  (연속 두 번의 자정을 모두 통과시켜 검증) 확인했다.
- **`src/lib/idleTracker.test.ts`**(8케이스) — 이 모듈은 최상단
  코드가 import 시점에 즉시 실행되어 전역 `setInterval`과 모듈
  스코프 변수를 만드는 특이한 구조(파일 상단 주석: "React 생명주기와
  무관하게 이 모듈이 로드되는 순간 단 한 번"이 의도된 설계)라, 매
  테스트마다 `vi.resetModules()` + 동적 `import()`로 완전히 새
  모듈 인스턴스를 받아 격리했다 — 그러지 않으면 이전 테스트의
  `lastActivityAt`이 다음 테스트로 새어나간다.

## 세 번째 라운드 — 첫 컴포넌트 테스트(RTL render) (2026-09-22)

사용자 지시 "계속 진행해"에 따라 처음으로 실제 컴포넌트를 RTL의
`render`+`screen`으로 테스트했다. 이미 훅 단위로 검증된 로직
(`useNetworkStatus`/`idleTracker`)을 실제로 소비하는 화면에서, 그
훅의 상태 변화가 실제 DOM(조건부 렌더링, `aria-hidden`, 텍스트,
스타일)에 올바르게 반영되는지 확인한다. 4개 파일, 20개 케이스
추가(10개 파일 84케이스 → 14개 파일 104케이스).

- **`src/hooks/useTheme.test.ts`**(8케이스, 컴포넌트 테스트 착수
  전 선행 작업) — `index.html`의 인라인 스크립트가 마운트 전에 이미
  `.dark` 클래스를 반영해두는 전제를 그대로 재현(초기값을
  `documentElement.classList`에서 읽음), `theme-color` meta 태그
  갱신, `localStorage` 저장, 그리고 `localStorage` 접근이 막힌
  환경(시크릿 모드 등)에서도 예외 없이 동작하는지.
- **`src/components/layout/ThemeToggleButton.test.tsx`**(4케이스) —
  이 프로젝트의 첫 RTL 컴포넌트 테스트. 클릭 시 아이콘/`aria-label`이
  라이트↔다크로 정확히 전환되는지.
- **`src/components/layout/OfflineBanner.test.tsx`**(4케이스) —
  `useNetworkStatus`를 소비하는 화면. `navigator.onLine`을
  `vi.stubGlobal`로 조작하고 `online`/`offline` 이벤트를 `act()`로
  감싸 디스패치해 배너의 표시/숨김을 검증했다(🔧 최초 작성 시 `act()`
  없이 이벤트를 디스패치해 "state update not wrapped in act" 경고와
  함께 2개 테스트가 실패 — `useNetworkStatus.test.ts`에서 이미 썼던
  패턴을 빠뜨린 실수, 바로 수정).
- **`src/components/layout/IdleOverlay.test.tsx`**(4케이스) —
  `idleTracker.ts`의 모듈 최상위 사이드 이펙트 특성(2차 라운드 참고)
  때문에 이 파일에서도 `vi.resetModules()` + 동적 `import()`로 매
  테스트마다 격리된 인스턴스를 받는다. `IDLE_ENTER_EVENT`/
  `IDLE_WAKE_EVENT`를 직접 디스패치하는 단위 테스트뿐 아니라, 실제
  유휴 임계값(`IDLE_THRESHOLD_MS`)을 페이크 타이머로 넘겨 이벤트
  발행부터 오버레이 렌더링까지 전체 경로가 실제로 이어지는지 보는
  통합 테스트도 포함했다.

**부수 발견**: `@testing-library/jest-dom`의 vitest 타입 확장이
`tsconfig.app.json`(컴포넌트 테스트 파일이 속한 프로젝트)에 로드되지
않아 `npx tsc -b`가 `toBeInTheDocument` 등 커스텀 matcher 전부를
타입 에러로 판정하고 있었다(파일 구조 절 참고) — 1~2차 라운드는
matcher를 전혀 안 써서 드러나지 않았던 문제. `vitest.setup.ts`를
`tsconfig.app.json`의 `include`에 추가해 해결했다.

## 네 번째 라운드 — useAuth/useNavigate 의존 컴포넌트 + 공용 테스트 헬퍼 (2026-09-22)

3차가 상태 없는/단순 조건부 렌더링 컴포넌트에 그쳤던 것에 이어, 실제
컨텍스트(`useAuth`)와 라우터(`useNavigate`/`Link`)에 의존하는
컴포넌트를 다뤘다. 이 두 의존성을 가진 컴포넌트가 이미 10개 이상
있음을 grep으로 확인해(`NewMemberForm`/`StatusView`/`TabBar`/
`AppShell` 등), 매번 새로 배선하지 않도록 공용 헬퍼를 먼저 만들었다.
2개 파일, 11개 케이스 추가(14개 파일 104케이스 → 16개 파일
115케이스).

- **`src/test-utils.tsx`**(신설, 테스트 파일 아님 — `.test.tsx`가
  아니라 `test-utils.tsx`라 vitest의 `include` 패턴에 걸리지 않음을
  `npx vitest list`로 확인) — `renderWithProviders()`가
  `AuthContext.Provider`(실제 `AuthProvider`를 쓰면 `apiFetch("/me/role")`
  호출까지 함께 딸려와 컴포넌트 테스트가 네트워크 mock에 얽매이므로,
  대신 원하는 값을 직접 주입)와 `MemoryRouter`로 감싸 렌더링한다.
  `LocationDisplay`(숨은 `useLocation()` 구독 컴포넌트)를 항상 함께
  렌더링해두어, `navigate()` 호출 후 실제로 어느 경로로 이동했는지
  `screen.getByTestId("location-display")`로 확인할 수 있게 했다.
- **`src/components/session/SessionCard.test.tsx`**(7케이스) —
  session 유무에 따른 스켈레톤/실제 카드 조건부 렌더링, `name` prop이
  `session.name`보다 우선하는지, 로그아웃 클릭 시 `logout()`/
  `onLogout()`이 모두 호출되고 실제로 `/login`으로 이동하는지(
  `renderWithProviders`의 `LocationDisplay`로 확인)까지 검증했다.
- **`src/components/layout/LinksHeaderButton.test.tsx`**(4케이스) —
  `@base-ui/react`의 `Dialog`(모달)와 `react-router-dom`의 `Link`를
  함께 쓰는 컴포넌트의 첫 테스트이자 스파이크 성격도 겸한다 — Dialog가
  jsdom에서 실제로 열리고(`role="dialog"`) 닫히는지, `DialogClose`로
  감싼 `Link`를 클릭하면 모달이 닫히며 실제 라우트가 바뀌는지
  (`/checker`)까지 확인했다. `waitFor()`로 감싼 이유: `@base-ui/react`
  Dialog의 마운트가 동기적이지 않을 수 있어(실측으로 필요성 확인) —
  이후 Dialog 기반 컴포넌트 테스트가 참고할 선례.

## 다섯 번째 라운드 — fetch 의존 컴포넌트 + fake timer 함정 (2026-09-22)

`useApi`/`apiFetch`에 의존하는 첫 컴포넌트를 다뤘다. `apiFetch`는
항상 `WORKER_BASE + path` 절대 URL로 전역 `fetch`를 호출하므로,
백엔드(`frame-checker-worker`)가 이미 채택한 `vi.stubGlobal("fetch",
...)` 패턴을 그대로 프론트에도 적용했다. 1개 파일, 6개 케이스
추가(16개 파일 115케이스 → 17개 파일 121케이스).

- **`src/test-utils.tsx`에 `stubApiFetch()` 추가** — 경로 접미사
  (예: `"/push/recent-notices"`)를 키로 응답을 등록하는 라우팅
  mock. `WORKER_BASE`를 신경 쓸 필요가 없고, 등록되지 않은 경로가
  호출되면 즉시 에러를 던져 테스트가 실제로 어떤 API를 부르는지
  놓치지 않게 한다.
- **`src/components/report/RecentNoticesSection.test.tsx`**(6케이스)
  — 항목 유무에 따른 렌더링, 경과 시간 포맷(`"방금 전"`/`"N분 전"`),
  15초 폴링, `refreshSignal` prop 변경 시 즉시 재조회, API 실패 시
  `catch(() => {})`로 조용히 무시되는지.

**🔧 함정 발견·해결**: `vi.useFakeTimers()`를 켠 채
`@testing-library/react`의 `waitFor()`를 쓰면 **전부 타임아웃났다**
(30초 전부 소진, 6개 테스트 전멸을 실측으로 확인) — `waitFor`의 내부
폴링이 실제 `setTimeout`에 의존하는데, fake timer가 그 시간 흐름
자체를 멈춰버려 `fetch` 응답이 이미 resolve됐어도 `waitFor`가 다음
체크를 하지 못한다. `vi.advanceTimersByTimeAsync()`(pending
microtask/promise까지 함께 진행시키는 비동기 버전)로 시간을 흘려보낸
직후 곧바로 동기 assertion을 쓰는 방식으로 전환해 해결했다 — **fake
timer와 폴링(setInterval)이 함께 있는 컴포넌트를 테스트할 때는
`waitFor` 대신 이 패턴을 표준으로 삼는다.**

## 여섯 번째 라운드 — 첫 폼 제출 컴포넌트 + user-event 도입 (2026-09-22)

`NewMemberForm`(관리자가 신규 회원을 등록하는 폼)을 다뤘다 — 마운트 시
두 API 병행 조회, 입력값 실시간 블랙리스트 대조, 제출 시 성공/재인증
필요/네트워크 오류 세 갈래, 클라이언트 측 유효성 검사(쉼표 포함 금지)
까지 이 세션에서 가장 복잡한 컴포넌트다. 1개 파일, 11개 케이스
추가(17개 파일 121케이스 → 18개 파일 132케이스).

- **`src/components/admin/NewMemberForm.test.tsx`**(11케이스) — 빈
  자리 목록 로드(성공/빈 배열/실패), 블랙리스트 대소문자 무시 매칭,
  필수 필드 미충족 시 제출 버튼 비활성화, 제출 성공 시 메시지+폼
  초기화, `Select`로 다른 시트 번호를 선택하면 실제 제출 요청 바디에
  반영되는지(`fetchMock.mock.calls`로 요청 바디 직접 파싱), Drive
  재인증이 필요한 경우(`needsReauth`) 안내 문구+재시도 버튼+
  `window.open` 호출(`vi.spyOn(window, "open")`)까지, 쉼표 포함 시
  서버 요청 자체가 나가지 않는 클라이언트 유효성 검사.

**🔧 함정 발견·해결**: `@base-ui/react`의 `Select`(드롭다운)는
`fireEvent.click`만으로는 `onValueChange`가 전혀 호출되지 않음을
스파이크로 확인했다(트리거를 눌러 옵션 목록은 열리지만 옵션 클릭이
선택으로 이어지지 않음) — 내부적으로 `pointerdown`/`pointerup`
이벤트 시퀀스에 반응하는 것으로 보인다. `pointerDown`/`pointerUp`을
수동으로 조합해도 되지만(스파이크로 동작 확인), 대신
**`@testing-library/user-event`를 새로 설치**해 표준적인 방식으로
해결했다 — RTL 생태계의 공식 권장 도구이고 앞으로도 pointer 기반
컴포넌트(Select/Dialog 등)를 계속 다룰 것이므로 재사용성이 높다.
combobox에 접근 가능한 이름(`aria-label` 등)이 없어 `getAllByRole
("combobox")`의 렌더링 순서(인덱스)로 구분해야 했다는 점도 기록해둔다
— 앞으로 `Select`를 쓰는 컴포넌트에 `aria-label`을 붙이면 이런
테스트가 더 명확해질 수 있다(디자인 개선 여지, 이번 범위 밖).

## 다음 단계 (미착수)

- `src/lib/checker/drawGrid.ts`(Canvas API 의존), `src/lib/push/vapid.ts`,
  `src/lib/periodAlarm/*`는 아직 미착수.
- 지금까지 다룬 컴포넌트는 전부 `SessionCard`/`NewMemberForm`처럼
  개별 화면 요소다 — 페이지 단위 통합(여러 컴포넌트+라우팅이 얽힌
  `*Page.tsx`)은 아직 다루지 않았다.
