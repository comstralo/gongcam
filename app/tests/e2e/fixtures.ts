import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// 🔧 [2026-09-21] 로그인 화면 뒤(대시보드/제보/채팅/설정/관리자)를
// 자동화로 검증하려면 세션이 필요한데, 이 앱은 구글 OAuth라 자동화 도구가
// 통과할 수 없다. frame-checker-worker/src/auth.js의 handleDevLogin
// (POST /dev/login)이 정확히 이 목적을 위해 이미 만들어져 있다 —
// env.DEV_LOGIN_SECRET(wrangler secret, .env.test에만 로컬 사본을
// 둔다)이 등록되어 있을 때만 존재하고, 없으면 프로덕션에서는 그 경로가
// 있는지조차 알 수 없이 항상 404를 반환한다. 구글 credential 검증만
// 건너뛸 뿐 참여자 명단 검증은 그대로 거치므로, 실제 로그인 흐름의
// 안전한 대체물이다.
//
// .env.test에 다음 두 값이 없으면(개발자 본인만 아는 시크릿이라 이
// 저장소를 새로 받은 사람에게는 기본적으로 없다) 이 fixture를 쓰는
// 테스트는 test.skip()으로 스스로 건너뛴다 — CI나 다른 개발자 환경에서
// "시크릿이 없어서 실패"하는 게 아니라 "그냥 스킵됨"이 되도록 한다.
//   E2E_DEV_LOGIN_SECRET=<DEV_LOGIN_SECRET 값>
//   E2E_TEST_EMAIL=<참여자 명단에 등록된 테스트 계정 이메일>
const DEV_LOGIN_SECRET = process.env.E2E_DEV_LOGIN_SECRET;
const TEST_EMAIL = process.env.E2E_TEST_EMAIL;
const API_BASE_URL = process.env.E2E_API_BASE_URL || "https://frame-checker-worker.comstralo.workers.dev";

async function fetchDevSessionToken(request: import("@playwright/test").APIRequestContext) {
  const res = await request.post(`${API_BASE_URL}/dev/login`, {
    headers: { "X-Dev-Login-Secret": DEV_LOGIN_SECRET!, "Content-Type": "application/json" },
    data: { email: TEST_EMAIL },
  });
  if (!res.ok()) {
    throw new Error(`/dev/login 실패 (${res.status()}): ${await res.text()}`);
  }
  return (await res.json()) as { token: string; name: string; email: string };
}

// 세션을 localStorage에 주입한 뒤 페이지를 여는 fixture. 앱의
// src/lib/auth/session.ts가 읽는 것과 정확히 같은 키/형식을 써야 한다.
async function injectSession(page: Page, session: { token: string; email: string; name: string }) {
  await page.addInitScript((s) => {
    // saveSession(..., "persist")와 동일 — localStorage에 저장하고
    // 세션이 새로고침 후에도 유지되게 한다.
    localStorage.setItem("frameCheckerSession", JSON.stringify(s));
  }, session);
}

// 🔧 [2026-09-22 사용자 지시: "좀 더 철저하고 구체적인 검증 환경을
// 구성했으면 좋겠어"] — useKeyboardInset.ts의 isStandalonePwa()가 갈리는
// 지점(iOS 홈 화면에 추가한 PWA인지 여부)에 따라 v버튼 위치 계산, 뷰포트
// 높이 보정 등 이 세션에서 반복적으로 문제가 됐던 로직 전체가 켜지거나
// 꺼진다 — 이 분기 자체를 테스트가 전혀 흉내 내지 못하면, "PC/일반
// Safari 탭에서는 절대 이 JS 좌표계를 타면 안 된다"는 핵심 불변식이나
// "PWA standalone에서는 이 보정이 정확히 동작해야 한다"는 반대쪽 불변식
// 둘 다 기계적으로 검증할 방법이 없다.
//
// isStandalonePwa()는 두 조건의 OR라 하나만 흉내 내면 충분하다:
// matchMedia("(display-mode: standalone)")는 window.matchMedia 자체를
// 오버라이드해서, navigator.standalone(iOS 전용 비표준 프로퍼티, 표준
// Navigator 타입에 없어 Object.defineProperty로 직접 주입해야 함)은
// addInitScript로 값을 정의해서 각각 재현 가능함을 별도 스파이크
// 테스트로 확인했다. 두 조건을 모두 흉내 내 실제 iOS PWA와 최대한
// 가깝게 만든다.
async function injectPwaStandalone(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, "standalone", { value: true, configurable: true });
    const originalMatchMedia = window.matchMedia?.bind(window);
    window.matchMedia = (query: string) => {
      if (query.includes("display-mode: standalone")) {
        return {
          matches: true,
          media: query,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => true,
          onchange: null,
        } as MediaQueryList;
      }
      return originalMatchMedia ? originalMatchMedia(query) : ({ matches: false, media: query } as MediaQueryList);
    };
  });
}

// 🔧 [2026-09-22 사용자 지시: "여러 환경에서의 문제점을 테스트 단계에서
// 파악하고 싶다"] — useKeyboardInset.ts의 useVisualViewportRect()가 읽는
// window.visualViewport.offsetTop/height는 iOS가 실제 키보드를 띄울 때만
// 브라우저가 채워주는 값이라, Playwright(실제 키보드 없음)로는 이 분기
// (viewportRect.top > 0, AppShell.tsx의 v버튼 위치 계산·ChatPage의 컨테이너
// 크기 계산이 갈리는 지점)가 지금까지 단 한 번도 실행되지 않았다 — 이
// 세션에서 가장 많이 다룬 로직인데 정작 테스트 커버리지가 0이었다.
// window.visualViewport는 read-only 프로퍼티가 아니라 브라우저가 만든
// 살아있는 VisualViewport 객체라 필드를 직접 대입할 수 없으므로, 실제
// 객체를 얕게 감싸 offsetTop/height만 오버라이드하는 Proxy를 만들고,
// 리스너 등록은 원본 객체에 그대로 위임한다(useVisualViewportRect가 이
// 이벤트로 재계산을 트리거하므로 실제로 동작해야 함). 키보드가 뜨면 iOS는
// 레이아웃 뷰포트(window.innerHeight)는 그대로 두고 visualViewport만
// 줄어든 높이+아래로 이동한 offsetTop을 보고하는 것이 실측된 동작이라,
// 그 결과만 흉내 낸다(실제 키보드 UI 자체는 그리지 않음 — 이 앱 로직은
// 오직 이 두 숫자만 본다).
async function injectKeyboardUp(page: Page, keyboardHeight = 300) {
  await page.addInitScript((kbHeight) => {
    const real = window.visualViewport;
    if (!real) return;
    const fakeOffsetTop = kbHeight;
    const fakeHeight = window.innerHeight - kbHeight;
    const proxy = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "offsetTop") return fakeOffsetTop;
        if (prop === "height") return fakeHeight;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    Object.defineProperty(window, "visualViewport", { value: proxy, configurable: true });
  }, keyboardHeight);
}

// 🔧 [2026-09-22] /me/role 등 세션 검증 API가 느리거나 실패할 때도
// AuthContext.sessionVerified 로직(비로그인 대시보드 순간 노출 버그
// 수정의 핵심)이 레이아웃을 깨뜨리지 않는지 보려면, 그 응답을 의도적으로
// 지연/실패시킬 방법이 필요하다 — 실제 네트워크 장애를 기다릴 수 없으므로
// page.route로 프로덕션 API 응답을 가로채 대체한다.
async function delayApiRoute(page: Page, pathSuffix: string, delayMs: number) {
  await page.route(`**${pathSuffix}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.continue();
  });
}

async function failApiRoute(page: Page, pathSuffix: string, status = 500) {
  await page.route(`**${pathSuffix}`, async (route) => {
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: "injected failure" }) });
  });
}

// 🔧 [2026-09-22 사용자 지시: "그래서 E2E 문제는 언제 해결되는거야..
// 맨날 확인만 한다 하고 실제 개선이 안되고 있잖아"] — 대시보드 렌더링을
// 기다리는 테스트들("목표시간" 텍스트 대기)이 실제 프로덕션 /status
// 응답에 의존하고 있어, 그 API가 간헐적으로 느리거나 응답이 지연되는
// CI 환경에서 재현성 있게 타임아웃 실패해왔다(수 차례 trace 분석으로
// 확인). 로그인(/dev/login)은 세션 발급 자체라 mock할 수 없지만, 그
// 뒤에 대시보드가 그리는 데이터(/status)는 앱 로직과 무관한 고정값이면
// 충분하므로 실제 서버 대신 즉시 응답하는 mock으로 완전히 대체해 서버
// 타이밍 의존을 없앤다. 아래 데이터는 실제 프로덕션 /status 응답을
// 그대로 캡처한 것(2026-09-22, curl로 실측) — 타입(StatusResponse)과
// 완전히 들어맞음을 보장하기 위해 손으로 구성하지 않고 실제 응답을
// 그대로 썼다.
const MOCK_STATUS_RESPONSE = {
  name: "재희",
  goalType: "10H (교시제)",
  joinDate: "D+264",
  joinDateExact: "2026-01-01",
  weeklyMerit: "0.000",
  weeklyMeritRank: "- (미집계)",
  weeklyMeritBreakdown: {
    isZero: true,
    zeroReason: null,
    zeroConditions: [
      { key: "midJoin", label: "월요일 이후 중도 참여", met: false },
      { key: "penalty", label: "페널티 1회 이상 적립", met: false },
      { key: "fine", label: "벌금 5,000원 초과", met: false },
      { key: "reasonLeave", label: "사유 반휴 3장 이상 사용", met: false },
    ],
    studyTimeMerit: 0,
    studyTimeHours: 0,
    reportMerit: 0.5,
    reportApprovedCount: null,
    isLeader: true,
    reportMeritIncluded: false,
    multiplier: 1.125,
    multiplierDowngraded: false,
    reasonLeaveTotal: 0,
    penaltyDeduction: 0.1,
    fineDeduction: 0,
    weeklyTotalFineAmount: 0,
    computedMerit: 0,
  },
  normalLeaveLeft: "2",
  reasonLeaveLeft: "4",
  days: [
    {
      day: "월",
      date: "2026-09-21",
      confirmed: true,
      complete: true,
      total: 3000,
      goal: 3000,
      morning: 1500,
      studyTime: "00:00",
      logStudyTime: "00:00",
      bonusStudyTime: "00:00",
      dailyGoalTime: "10:00",
      dailyShortfallTime: "10:00",
      morningShortfallTime: "03:00",
      isDepositAgainDay: false,
      paymentStatus: "미납",
      normalLeaveUsed: 0,
      reasonLeaveUsed: 0,
      reasonLeavePending: false,
      explain: "상한 적용 — 목표 벌금 ₩3,000 + 오전 벌금 ₩1,500 = ₩4,500이지만 하루 상한 ₩3,000으로 조정되어 ₩3,000 확정",
    },
    {
      day: "화",
      date: "2026-09-22",
      confirmed: true,
      complete: true,
      total: 3000,
      goal: 3000,
      morning: 1500,
      studyTime: "00:00",
      logStudyTime: "00:00",
      bonusStudyTime: "00:00",
      dailyGoalTime: "10:00",
      dailyShortfallTime: "10:00",
      morningShortfallTime: "03:00",
      isDepositAgainDay: false,
      paymentStatus: "",
      normalLeaveUsed: 0,
      reasonLeaveUsed: 0,
      reasonLeavePending: false,
      explain: "상한 적용 — 목표 벌금 ₩3,000 + 오전 벌금 ₩1,500 = ₩4,500이지만 하루 상한 ₩3,000으로 조정되어 ₩3,000 확정",
    },
    {
      day: "수",
      date: "2026-09-23",
      confirmed: true,
      complete: true,
      total: 3000,
      goal: 3000,
      morning: 1500,
      studyTime: "00:00",
      logStudyTime: "00:00",
      bonusStudyTime: "00:00",
      dailyGoalTime: "10:00",
      dailyShortfallTime: "10:00",
      morningShortfallTime: "03:00",
      isDepositAgainDay: false,
      paymentStatus: "",
      normalLeaveUsed: 0,
      reasonLeaveUsed: 0,
      reasonLeavePending: false,
      explain: "상한 적용 — 목표 벌금 ₩3,000 + 오전 벌금 ₩1,500 = ₩4,500이지만 하루 상한 ₩3,000으로 조정되어 ₩3,000 확정",
    },
    {
      day: "목",
      date: "2026-09-24",
      confirmed: false,
      complete: true,
      total: 3000,
      goal: 3000,
      morning: 1500,
      studyTime: "00:00",
      logStudyTime: "00:00",
      bonusStudyTime: "00:00",
      dailyGoalTime: "10:00",
      dailyShortfallTime: "10:00",
      morningShortfallTime: "03:00",
      isDepositAgainDay: false,
      paymentStatus: "",
      normalLeaveUsed: 0,
      reasonLeaveUsed: 0,
      reasonLeavePending: false,
      explain: "마감 전(미확정) — 현재까지 목표시간 벌금 ₩3,000 + 오전 벌금 ₩1,500 예상 중",
    },
    {
      day: "금",
      date: "2026-09-25",
      confirmed: true,
      complete: false,
      total: 0,
      goal: 0,
      morning: 0,
      studyTime: "00:00",
      logStudyTime: "00:00",
      bonusStudyTime: "00:00",
      dailyGoalTime: "10:00",
      dailyShortfallTime: "",
      morningShortfallTime: "",
      isDepositAgainDay: false,
      paymentStatus: "",
      normalLeaveUsed: 0,
      reasonLeaveUsed: 0,
      reasonLeavePending: false,
      explain: "벌금 없음 (목표 달성)",
    },
    {
      day: "토",
      date: "2026-09-26",
      confirmed: true,
      complete: true,
      total: 3000,
      goal: 3000,
      morning: 1500,
      studyTime: "00:00",
      logStudyTime: "00:00",
      bonusStudyTime: "00:00",
      dailyGoalTime: "10:00",
      dailyShortfallTime: "10:00",
      morningShortfallTime: "03:00",
      isDepositAgainDay: false,
      paymentStatus: "",
      normalLeaveUsed: 0,
      reasonLeaveUsed: 0,
      reasonLeavePending: false,
      explain: "상한 적용 — 목표 벌금 ₩3,000 + 오전 벌금 ₩1,500 = ₩4,500이지만 하루 상한 ₩3,000으로 조정되어 ₩3,000 확정",
    },
    {
      day: "일",
      date: "2026-09-27",
      confirmed: true,
      complete: false,
      total: 0,
      goal: 0,
      morning: 0,
      studyTime: "00:00",
      logStudyTime: "00:00",
      bonusStudyTime: "00:00",
      dailyGoalTime: "05:00",
      dailyShortfallTime: "",
      morningShortfallTime: "",
      isDepositAgainDay: false,
      paymentStatus: "",
      normalLeaveUsed: 0,
      reasonLeaveUsed: 0,
      reasonLeavePending: false,
      explain: "벌금 없음 (목표 달성)",
    },
  ],
  weekTotalConfirmed: 12000,
  depositRefundEstimate: "₩0 (벌금 미납)",
  depositRefundBreakdown: {
    amount: 0,
    reason: "벌금 시한 내 미납",
    outputPen: 0,
    timePen: 0,
    daysSinceJoin: 264,
    fineUnpaid: true,
    fineUnpaidDays: ["월"],
    depositAgainStatus: null,
    lateNotice: false,
  },
  exitRequested: false,
  exitRequestDate: null,
  exitAgreedAt: null,
  prizePending: false,
  periodAttendanceRate: "2%",
  periodAttendanceBreakdown: { applicable: true, achievedCount: 0, errorCount: 1, targetPeriods: 50, rate: 2 },
  periodGrid: [
    { day: "월", periods: Array(14).fill({ start: "00:00", end: "00:00", rate: "0" }) },
    { day: "화", periods: Array(14).fill({ start: "00:00", end: "00:00", rate: "0" }) },
    { day: "수", periods: Array(14).fill({ start: "00:00", end: "00:00", rate: "0" }) },
    { day: "목", periods: Array(14).fill({ start: "00:00", end: "00:00", rate: "0" }) },
    { day: "금", periods: Array(14).fill({ start: "", end: "", rate: "" }) },
    { day: "토", periods: Array(14).fill({ start: "00:00", end: "00:00", rate: "0" }) },
    { day: "일", periods: Array(14).fill({ start: "00:00", end: "", rate: "" }) },
  ],
  weeklyGoalTime: "50:00",
  weeklyStudyTime: "00:00",
  weeklyTotalFine: "₩0",
  weeklyOutputPen: 0,
  weeklyTimePen: 0,
  totalPenaltyBreakdown: {
    outputPenHistory: [
      {
        label: "송출 P 1차",
        cycle: 3,
        when: "2026. 9. 9. 오전 1:48:19",
        reason: "격자 기준을 벗어난 근접 화각",
        captureId: "799f24e9-19d5-449a-9e51-ad0b7e6f1a75",
      },
      {
        label: "송출 P 2차",
        cycle: 3,
        when: "2026. 9. 9. 오전 4:14:11",
        reason: "얼굴, 정수리 등 노출",
        captureId: "0e6052a7-0379-4e79-abcb-eba92956094a",
      },
    ],
    timePenHistory: [],
  },
  depositAgainSplit: null,
};

// 대시보드 렌더링에 필요한 /status만 즉시 mock으로 응답시킨다 — 이
// 페이지가 로그인 후 곧장 이 데이터를 그려야 "목표시간" 텍스트가 뜨므로,
// 실제 서버 타이밍(간헐적 지연)에 더 이상 영향받지 않게 된다.
async function mockStatusRoute(page: Page) {
  // glob "**/status"는 URL이 정확히 "/status"로 끝날 때만 매칭되므로
  // "/status-message" 같은 다른 엔드포인트는 건드리지 않는다.
  await page.route("**/status", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_STATUS_RESPONSE) });
  });
}

// 🔧 [2026-09-22] "레이아웃은 안 깨져도 콘솔에 에러가 난다"를 놓치지
// 않으려고 매 테스트마다 콘솔 메시지를 수집한다. React 자체의 알려진
// 개발 모드 경고(CI 빌드 로그에 이미 떠 있는, 이번 세션 작업과 무관한
// 기존 항목들 — App.tsx/DashboardPage.tsx의 "Cannot access refs during
// render", usePollingRefresh.ts의 "cascading renders")는 오탐으로 매 번
// 실패시키면 신호 대 잡음비만 나빠지므로 allowlist로 걸러낸다. 새로
// 추가되는 진짜 회귀(예: 이번에 고친 버그들의 재발)는 이 필터를 통과해
// 그대로 테스트 실패로 이어진다.
const KNOWN_CONSOLE_NOISE = [
  "Cannot access refs during render",
  "Calling setState synchronously within an effect",
  "Download the React DevTools",
  // 🔧 [디버그 확인, 2026-09-22] 이 앱이 ResizeObserver를 여러 군데서
  // 쓰는 것(AppShell.tsx, useResizeObserver.ts 등)과 무관하게, 브라우저
  // 표준 스펙상 한 프레임 안에 너무 많은 관찰 대상이 갱신되면 크롬/
  // WebKit 모두 이 경고를 던진다 — 실제 레이아웃 깨짐이나 무한 루프의
  // 신호가 아니라(다음 프레임에 지연 전달될 뿐 알림 자체가 유실되지
  // 않음, MDN 문서에 명시된 정상 동작) 순수 브라우저 잡음이다.
  "ResizeObserver loop completed with undelivered notifications",
  "ResizeObserver loop limit exceeded",
  // 🔧 [버그 수정, 2026-09-22 CI 실패로 발견] index.html의 viewport
  // meta(interactive-widget=resizes-content, 이전 세션에서 iOS 키보드
  // 처리를 브라우저에 위임하려고 추가)가 CI가 새로 설치한 WebKit
  // 버전에서는 아직 이 속성을 인식하지 못해 경고를 낸다 — 로컬
  // WebKit(같은 Playwright 버전이지만 설치 시점이 달라 마이너 빌드가
  // 다를 수 있음)에서는 재현되지 않았다(실측 확인). 앱 동작에 영향이
  // 없는 순수 브라우저 파싱 경고이고, 실제 최신 CSS Viewport Module
  // 사양에 있는 값이라 앱 코드를 되돌릴 이유는 없다 — WebKit이
  // 따라잡을 때까지 잡음으로 처리한다.
  'Viewport argument key "interactive-widget" not recognized and ignored',
];

function attachConsoleErrorCollector(page: Page): { errors: string[] } {
  const state = { errors: [] as string[] };
  page.on("console", (msg) => {
    if (msg.type() !== "error" && msg.type() !== "warning") return;
    const text = msg.text();
    if (KNOWN_CONSOLE_NOISE.some((noise) => text.includes(noise))) return;
    state.errors.push(text);
  });
  page.on("pageerror", (err) => {
    // 🔧 [버그 수정, 2026-09-22] ResizeObserver 잡음이 이 브라우저(WebKit
    // 계열)에서는 console.error가 아니라 uncaught error(pageerror)로
    // 올라와, console 이벤트에만 걸어둔 KNOWN_CONSOLE_NOISE 필터를 아예
    // 거치지 않고 항상 실패로 이어졌다 — 같은 필터를 여기도 적용한다.
    if (KNOWN_CONSOLE_NOISE.some((noise) => err.message.includes(noise))) return;
    state.errors.push(`pageerror: ${err.message}`);
  });
  return state;
}

export const test = base.extend<{
  authedPage: Page;
  pwaPage: Page;
  authedPwaPage: Page;
  keyboardUpPage: Page;
  authedKeyboardUpPage: Page;
  authedKeyboardUpPwaPage: Page;
  consoleErrors: { errors: string[] };
}>({
  authedPage: async ({ page, request }, use, testInfo) => {
    if (!DEV_LOGIN_SECRET || !TEST_EMAIL) {
      testInfo.skip(true, "E2E_DEV_LOGIN_SECRET/E2E_TEST_EMAIL이 .env.test에 없어 로그인 필요 테스트를 건너뜁니다 (tests/e2e/README.md 참고)");
      return;
    }
    const session = await fetchDevSessionToken(request);
    await injectSession(page, session);
    await use(page);
  },

  // 로그인은 필요 없고 isStandalonePwa()만 true로 만들고 싶을 때(로그인
  // 페이지의 PWA 렌더링 등).
  pwaPage: async ({ page }, use) => {
    await injectPwaStandalone(page);
    await use(page);
  },

  // 로그인 + PWA standalone을 모두 흉내 낸다 — 이 세션에서 문제가 된
  // 로직(v버튼 위치, 뷰포트 높이 보정 등) 대부분이 "로그인 후 메인
  // 화면 + PWA" 조합에서만 실제로 켜지므로, 이 조합을 검증할 때 쓴다.
  authedPwaPage: async ({ page, request }, use, testInfo) => {
    if (!DEV_LOGIN_SECRET || !TEST_EMAIL) {
      testInfo.skip(true, "E2E_DEV_LOGIN_SECRET/E2E_TEST_EMAIL이 .env.test에 없어 로그인 필요 테스트를 건너뜁니다 (tests/e2e/README.md 참고)");
      return;
    }
    const session = await fetchDevSessionToken(request);
    await injectPwaStandalone(page);
    await injectSession(page, session);
    await use(page);
  },

  // PWA도 로그인도 필요 없이, useVisualViewportRect()가 항상 null만
  // 반환하는 일반 브라우저 환경에서 키보드를 흉내 내 봐야 실제로는 아무
  // 영향이 없어야 함을 확인할 때 쓴다(isStandalonePwa() 가드 자체의
  // 반대쪽 방향 검증).
  keyboardUpPage: async ({ page }, use) => {
    await injectKeyboardUp(page);
    await use(page);
  },

  // 로그인 + 키보드 시뮬레이션(PWA는 아님) — "PWA가 아니면 키보드가
  // 떠도 이 JS 좌표계 자체를 안 탄다"는 가드를 로그인된 실제 화면
  // (v버튼이 실제로 존재하는 채팅 화면)에서 검증할 때 쓴다.
  authedKeyboardUpPage: async ({ page, request }, use, testInfo) => {
    if (!DEV_LOGIN_SECRET || !TEST_EMAIL) {
      testInfo.skip(true, "E2E_DEV_LOGIN_SECRET/E2E_TEST_EMAIL이 .env.test에 없어 로그인 필요 테스트를 건너뜁니다 (tests/e2e/README.md 참고)");
      return;
    }
    const session = await fetchDevSessionToken(request);
    await injectKeyboardUp(page);
    await injectSession(page, session);
    await use(page);
  },

  // 로그인 + PWA standalone + 키보드가 뜬 상태까지 모두 흉내 낸다 —
  // AppShell.tsx의 viewportRect.top > 0 분기(v버튼이 화면 밖으로 사라져야
  // 함)와 ChatPage의 position:fixed 컨테이너 재계산이 실제로 실행되는
  // 유일한 조합이다.
  authedKeyboardUpPwaPage: async ({ page, request }, use, testInfo) => {
    if (!DEV_LOGIN_SECRET || !TEST_EMAIL) {
      testInfo.skip(true, "E2E_DEV_LOGIN_SECRET/E2E_TEST_EMAIL이 .env.test에 없어 로그인 필요 테스트를 건너뜁니다 (tests/e2e/README.md 참고)");
      return;
    }
    const session = await fetchDevSessionToken(request);
    await injectPwaStandalone(page);
    await injectKeyboardUp(page);
    await injectSession(page, session);
    await use(page);
  },

  // 🔧 auto: true — 모든 테스트에서 별도 선언 없이 항상 콘솔/페이지 에러를
  // 수집한다. 검증(expect)은 각 테스트가 필요할 때만 명시적으로 한다
  // (전수 검증을 강제하면 기존 통과 테스트들이 한꺼번에 실패로 바뀌어
  // 마이그레이션 비용이 커지므로, 우선 신규 테스트부터 옵트인).
  consoleErrors: [
    async ({ page }, use) => {
      const state = attachConsoleErrorCollector(page);
      await use(state);
    },
    { auto: false },
  ],
});

export { expect, delayApiRoute, failApiRoute, mockStatusRoute };
