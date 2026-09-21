# 반응형 레이아웃 원칙 (LAYOUT_PRINCIPLES.md)

> 이 문서는 웹 서비스(`app/`)가 PC/모바일(iOS·Android)/태블릿/PWA
> standalone 등 다양한 환경에서 일관되게 동작하도록 지켜야 하는 레이아웃
> 불변식과, 그걸 어긴 실제 사례들을 정리합니다. `docs/WEB_CHAT.md` §3.5
> 에 iOS PWA 뷰포트 버그 시리즈가 상세히 기록되어 있는데, 이 문서는 그
> 경험에서 뽑아낸 **일반 원칙**(채팅 화면에 국한되지 않는, 앱 전체가
> 따라야 하는 규칙)을 다룹니다. 새로운 fixed/absolute 요소나 vh/dvh
> 계산을 추가하기 전에 먼저 이 문서를 확인하세요.
>
> 조사 시점: 2026-09-21. 대상 커밋 기준
> `app/src/components/layout/{AppShell,TabBar}.tsx`,
> `app/src/hooks/{useKeyboardInset,useResizeObserver}.ts`,
> `app/src/components/ui/dialog.tsx`, `app/playwright.config.ts`,
> `app/tests/e2e/*`.

## 1. 핵심 불변식

이 세 가지를 어기면 이번 세션에서 실제로 재현된 버그(문서 스크롤 여지,
v버튼 잘림, 헤더 사라짐)가 다시 나타난다.

1. **PC/비-PWA 환경은 절대 iOS PWA 우회용 JS 좌표계를 타지 않는다.**
   `useVisualViewportRect`/`useDocumentHeightFix`(`useKeyboardInset.ts`)는
   `isStandalonePwa()` 가드로 이미 이 원칙을 강제한다 — PWA standalone이
   아니면 항상 `null`/no-op을 반환해, 소비 컴포넌트(`AppShell`/`TabBar`/
   `ChatPage`)가 자동으로 순수 CSS 폴백(`bottom: env(...)`, `dvh`)만
   타게 만든다. **새로운 뷰포트 관련 훅을 추가할 때 이 가드를 빠뜨리지
   말 것** — 빠뜨리면 iOS 버그를 우회하려던 계산 자체가 PC에도
   적용되어, 그 계산에 낀 서브픽셀 오차가 PC까지 전염된다(실제로
   브라우저 줌 100%에서만 v버튼이 잘리는 버그로 나타났었다).

2. **"화면 하단이 차지하는 높이"는 항상 실측(ResizeObserver)이고,
   그 값 위에 손으로 정한 여백을 더하지 않는다.** 예전엔 "실측값 +
   매직넘버 여백"(예: `Math.max(safeAreaInsetBottom / 2, 4)`)을 여러
   곳에 흩어 두고, 환경이 바뀔 때마다 그 여백을 재조정하는 악순환이
   있었다. 여백이 필요하면 그 요소 자신의 CSS(padding/margin)에 넣어
   `getBoundingClientRect()`가 이미 포함해서 재는 값 안에 들어가게
   한다 — "실측값 바깥에 추가로 더하는 여백"이라는 카테고리 자체를
   만들지 않는다.

3. **문서(`html`/`body`) 자체는 뷰포트를 넘지 않는다 — 콘텐츠가 길면
   지정된 스크롤 컨테이너 안에서만 스크롤된다.** `AppShell`의 일반
   페이지(채팅/체커 제외)는 최상위를 `h-dvh overflow-hidden`으로 고정
   하고, `title` + 페이지가 넘긴 `stickyHeader`(탭 UI 등)를 고정 영역에,
   `children`을 `flex-1 min-h-0 overflow-y-auto` 스크롤 영역에 배치한다
   (§3 참고). 콘텐츠가 짧을 때도 문서 자체가 스크롤 여지를 갖던 예전
   구조(`min-h-dvh` + `paddingBottom`)로 되돌리지 말 것 — 매직넘버든
   실측값이든 정확히 일치시키기 어려워 결국 다시 재현된다.

## 2. 훅 사용 가이드 (`useKeyboardInset.ts`, `useResizeObserver.ts`)

| 훅 | 용도 | PC에서의 동작 |
|---|---|---|
| `useVisualViewportRect()` | 키보드 유무에 따른 뷰포트 top/height(iOS PWA 전용 버그 우회) | `isStandalonePwa()`가 아니면 항상 `null` |
| `useDocumentHeightFix()` | `html`/`body`에 실제 화면 높이를 강제(iOS PWA 원복 실패 버그 우회) | `isStandalonePwa()`가 아니면 아무 일도 안 함 |
| `useSafeAreaInsetTop()`/`useSafeAreaInsetBottom()` | `env(safe-area-inset-*)`를 px로 실측 | 대부분 0을 반환(노치/홈 인디케이터 없음) — 값 자체는 플랫폼 무관하게 항상 정확 |
| `useResizeObserver(onResize)` | 요소 크기 변화를 관찰하는 콜백 ref | 플랫폼과 무관, 조건부 마운트되는 요소에도 안전 |

`useResizeObserver`는 콜백 ref를 반환한다 — `<div ref={useResizeObserver((entry, el) => ...)} />`
형태로 쓴다. 콜백은 항상 최신 함수를 참조하므로(내부적으로 ref에
담아둠) 매 렌더 재구독을 신경 쓸 필요가 없다. 다만 **외부에서 이 관찰을
강제로 재트리거해야 하는 경우**(예: `AppShell`의 v버튼이 `safeAreaInsetBottom`
값이 바뀔 때 다시 측정해야 하는 경우)는 이 훅만으로는 부족해 별도
`report()` 참조를 유지하는 패턴이 여전히 필요하다 — 무리하게
`useResizeObserver`로 통일하려 하지 말 것(`AppShell.tsx`의 v버튼 측정
로직은 의도적으로 이 훅을 쓰지 않는다).

## 3. `AppShell`의 `stickyHeader` 슬롯

각 페이지(대시보드/제보/설정/관리자)는 이제 `App.tsx`가 아니라 **자기
자신을 직접 `AppShell`로 감싼다**:

```tsx
// 페이지 컴포넌트 내부
return (
  <AppShell
    title="제보"
    titleIcon={ScanLine}
    stickyHeader={<Tabs ...>...</Tabs>}  // 페이지 내부 탭 상태가 필요해 여기서만 채울 수 있다
  >
    <div>...스크롤되는 본문...</div>
  </AppShell>
);
```

이렇게 바뀐 이유: `stickyHeader`(페이지 내부 탭 UI)를 렌더링하려면 그
탭 상태(`view`, `changeView`)가 필요한데, 예전처럼 `App.tsx`가
`<AppShell><Page/></AppShell>` 형태로 감싸는 구조에서는 그 상태가 페이지
내부에 캡슐화되어 있어 `stickyHeader`로 끌어올릴 방법이 없었다. 페이지가
스스로 `AppShell`을 렌더링하면 상태를 끌어올릴 필요가 없어진다.

**예외**: `ChatPage`는 `collapsibleTabBar` 상태를 `AppShell`과
형제 컴포넌트로서 공유해야 해서, 그 공통 부모인 `App.tsx`가 계속
`AppShell`로 감싼다. `CheckerPage`(`fitToScreen`)도 탭 UI가 없어 예전
구조를 유지한다.

새 메인 페이지를 추가할 때: 탭 UI가 있으면 위 패턴(페이지가 직접
`AppShell` 렌더링 + `stickyHeader`)을 따르고, 탭이 없으면 `stickyHeader`
없이 `title`만 넘기면 된다.

## 4. `vh`/`dvh`/`svh` 선택 기준

- **`dvh`(dynamic viewport height)**: 키보드/브라우저 UI 변화에 따라
  실시간으로 갱신되는 값. 화면을 꽉 채우는 컨테이너(`AppShell` 최상위
  등)에 적합.
- **`svh`(small viewport height)**: 브라우저 UI가 모두 펼쳐진 상태의
  최소값 — 항상 `dvh`보다 작거나 같다. **"절대 넘치면 안 되는" 요소**
  (모달의 `max-height` 등)에는 `dvh`보다 `svh`가 더 안전하다(`dialog.tsx`의
  `max-h-[85svh]` 참고 — 원래 `85vh`였는데, `vh`는 iOS Safari에서 키보드
  없는 최대 뷰포트 기준으로 고정돼 실제 가시 영역보다 커질 수 있다는
  전수조사 결과로 교체).
- **순수 `vh`**: 이 앱에서는 쓰지 않는다 — iOS Safari의 알려진 함정
  (키보드/주소창 변화를 반영 못 함)을 그대로 물려받는다.

## 5. 회귀 방지 체크리스트

새 fixed/absolute 요소나 뷰포트 관련 계산을 추가하기 전에:

- [ ] 이 계산이 PC에서도 실행되는가? 실행된다면 iOS PWA 전용 버그를
      우회하려는 목적이 아닌지, 아니라면 플랫폼 가드가 있는지 확인.
- [ ] "실측값 + 상수 여백"을 추가하려 하는가? 그 여백을 요소 자신의
      CSS에 넣어 실측값 안에 포함시킬 수는 없는지 먼저 검토.
- [ ] 이 요소가 속한 최상위 컨테이너가 문서(`html`/`body`)를 뷰포트
      밖으로 밀어낼 수 있는가? (`min-h-dvh` + 별도 패딩 조합은 특히
      위험 — §1-3 참고)
- [ ] 실측이 필요하면 `useResizeObserver` 재사용을 먼저 검토(외부
      강제 재트리거가 필요 없다면).
- [ ] 브라우저 줌 배율(100%/125%/150%)이나 950px 안팎의 좁은 창에서도
      확인했는가? `tests/e2e/layout.spec.ts`의 `desktop-chromium-narrow`
      프로젝트가 정확히 이 구간을 커버한다.

## 6. 자동 회귀 테스트

`app/tests/e2e/layout.spec.ts`(Playwright)가 핵심 불변식(§1)을
데스크톱(1280px, 950px 두 폭)/iPhone/Android/iPad 프리셋에서 자동으로
검증한다. 로그인이 필요한 화면은 `frame-checker-worker`의
`/dev/login`(시크릿 게이트) 엔드포인트로 세션을 발급받아 검증한다 —
실행 방법과 보안 설계는 `app/tests/e2e/README.md` 참고.

```bash
cd app
npx playwright test                              # 전체 프로젝트
npx playwright test --project=desktop-chromium-narrow  # v버튼 잘림 재현 폭
```

## 7. 관련 문서

- `docs/WEB_CHAT.md` §3.5 — iOS PWA 뷰포트 버그 5종의 상세 경위(이
  문서의 원칙들이 도출된 실제 사례).
- `app/tests/e2e/README.md` — E2E 테스트 실행법과 `/dev/login` 보안 설계.
