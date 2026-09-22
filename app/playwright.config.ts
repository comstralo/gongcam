import { defineConfig, devices, type PlaywrightTestOptions } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

// 🔧 Playwright의 DeviceDescriptor/PlaywrightTestOptions 타입 선언
// 어디에도 screen 필드가 없지만(playwright-core/types/types.d.ts,
// playwright/types/test.d.ts 둘 다 확인), 런타임 devices 객체와
// BrowserContextOptions 둘 다 이 필드를 실제로 갖고/받는다 — 순수
// 타입 선언 누락이다(Node 콘솔로 devices["iPhone 14"].screen이 실제
// 값을 반환함을 확인). 아래 landscape 프리셋 2곳이 이 필드를 읽고
// 뒤집어 다시 쓰므로, 그 값을 담을 넓은 타입을 여기서 한 번만 정의한다.
type ScreenSize = { width: number; height: number };
type DeviceWithScreen = (typeof devices)[string] & { screen?: ScreenSize };
const devicesWithScreen = devices as unknown as Record<string, DeviceWithScreen>;

// .env.test(gitignore, 로컬 전용)가 있으면 여기서 process.env에 로드한다 —
// 별도 dotenv 의존성을 추가하지 않고 "KEY=VALUE" 줄만 읽는 최소 파서.
// 파일이 없어도(대부분의 경우) 조용히 넘어간다 — 이 설정 자체는 파일
// 유무와 무관하게 항상 유효해야 한다.
const envTestPath = new URL(".env.test", import.meta.url);
if (existsSync(envTestPath)) {
  for (const line of readFileSync(envTestPath, "utf-8").split("\n")) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const value = (match[2] || "").trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

// 🔧 [2026-09-21 사용자 지시: "다양한 환경 대응을 위한 도구를 체계적으로
// 적용" — 앱 전체 CSS/레이아웃 전수조사 후속] 이번 세션에서 PC/모바일/
// PWA 간 레이아웃 불일치(문서 스크롤 여지, 탭바 위치, v버튼 잘림 등)를
// 여러 차례 수동으로 재현·검증해야 했다 — 자동 회귀 테스트가 없어
// "고치면 다른 게 깨졌는지"를 매번 사람이 다시 확인해야 했던 것이 반복된
// 시행착오의 큰 원인 중 하나였다. 이 설정으로 데스크톱/모바일(iOS·
// Android)/태블릿 프리셋을 등록해, 최소한 "문서 자체가 뷰포트를 넘지
// 않는다" 같은 레이아웃 불변식을 기계적으로 검증한다.
//
// 로그인이 필요한 화면은 tests/e2e/fixtures.ts의 authenticatedPage가
// /dev/login(DEV_LOGIN_SECRET 게이트, frame-checker-worker/src/auth.js
// 참고)으로 발급받은 세션을 localStorage에 주입해 로그인 절차 자체를
// 우회한다 — 이 엔드포인트는 그 시크릿을 아는 사람만 호출 가능하고,
// 프로덕션 명단 검증은 그대로 거치므로(가짜 회원으로 로그인 불가) 실제
// 로그인 흐름의 대체물로 안전하다. 시크릿이 로컬 .env.test(gitignore)에
// 없으면 그 테스트들은 스스로 스킵된다(tests/e2e/README.md 참고).
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // 🔧 [디버그 확인, 2026-09-22 사용자 지시: "여러 환경에서의 문제점을
  // 테스트 단계에서 파악하고 싶다" 후속] — 프리셋을 5개→7개(가로모드
  // 추가)로 늘린 뒤, 이 스위트가 실제 프로덕션(GitHub Pages)을 네트워크로
  // 호출하는 구조라 로컬 8워커 병렬 실행에서 동시 요청이 늘어난 만큼
  // page.goto 자체가 30초 타임아웃에 걸리는 경우가 실측됐다(격리
  // 실행하면 항상 통과 — 앱/테스트 로직 문제가 아니라 순수 네트워크
  // 부하 변동성). CI는 이미 retries:1이라 이런 산발적 실패가 자동
  // 재시도로 흡수되지만(실제 배포 시 55개 전부 통과 확인됨), 로컬에서도
  // 매번 수동으로 재실행할 필요 없이 최소 1회는 자동 재시도한다.
  //
  // 🔧 [버그 수정 시도 → 정정, 2026-09-22 배포 후 실측] deploy.yml의
  // e2e job이 연속 3회 실행(원본 push + 재실행 2회) 모두에서 프로덕션
  // 백엔드(frame-checker-worker)의 /status 등이 산발적으로 500을
  // 반환해 "목표시간" 데이터 로드가 실패했다 — 처음엔 retries를 2로
  // 늘려 흡수하려 했으나(아래 이력), 그 시도가 오히려 역효과를 냈다:
  // 실행 시간이 4~5분→11분 36초로 늘었고 실패 범위가 산발적(1~2개
  // 프로젝트)에서 7개 프로젝트 전부로 넓어졌다. playwright-report
  // 아티팩트의 trace(2-trace.network)를 직접 파싱해 확인한 결과,
  // /status 요청이 500이 아니라 응답 자체를 못 받고 있었다(status:-1,
  // 모든 timing이 -1 — 서버가 아예 응답하지 못한 채 테스트 타임아웃으로
  // 끊긴 상태). 7개 프로젝트가 거의 동시에 로그인+상태조회를 몰아치며
  // buildPersonalStatus가 호출하는 Google Sheets API가 순간적으로
  // 쓰로틀링된 것으로 추정된다(로컬은 최대 2워커라 이 정도 동시
  // 부하가 재현되지 않음, 순차 8회/병렬 10회 모두 200). 즉 진짜 병목은
  // "재시도 부족"이 아니라 "CI가 프로덕션 백엔드에 동시다발 부하를
  // 준다"였다 — retries를 다시 1로 되돌리고, 대신 CI workers를 1로
  // 낮춰(아래 use.workers 아님, 커맨드라인 인자로 별도 제어 — CI
  // 워크플로우 참고) 동시 요청 수 자체를 줄인다(사용자 확인).
  retries: 1,
  // 🔧 [임시 진단, 2026-09-22] html 리포터는 실행 중 진행 상황을 콘솔에
  // 거의 안 찍고 끝난 뒤 한꺼번에 요약을 내보내, CI 로그의 타임스탬프가
  // "실제로 언제 멈췄는지"를 오도할 수 있었다(37초 공백처럼 보였던 게
  // 실은 로그 flush 지연일 가능성) — CI에서는 list 리포터를 추가해
  // 각 테스트 시작/종료를 실시간으로 콘솔에 남긴다. 원인 확정 후 제거할 것.
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : [["html", { open: "never" }]],
  use: {
    // 🔧 [버그 수정, 2026-09-21] baseURL 끝에 슬래시가 없으면
    // page.goto("/#/report")처럼 선행 슬래시가 있는 상대경로가 WHATWG
    // URL 결합 규칙상 baseURL의 경로("/gongcam")를 통째로 버리고
    // "https://comstralo.github.io/#/report"가 된다(GitHub Pages
    // 조직 루트에는 이 앱이 없어 404) — 실측으로 확인된 실패 원인.
    // baseURL 끝에 슬래시를 두고, 테스트 쪽 goto 인자도 선행 슬래시
    // 없이("gongcam/#/report" 형태가 아니라 상대경로 자체를 "#/report"
    // 처럼) 쓰면 baseURL 경로가 보존된다.
    baseURL: process.env.E2E_BASE_URL || "https://comstralo.github.io/gongcam/",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "desktop-chromium-narrow",
      // 🔧 이번 세션의 v버튼 잘림 버그가 정확히 이 폭대(950px 안팎, md
      // 브레이크포인트 근처)에서만 재현됐다 — 넓은 데스크톱 하나만으로는
      // 놓칠 수 있는 구간이라 별도 프로젝트로 고정한다.
      use: { ...devices["Desktop Chrome"], viewport: { width: 950, height: 864 } },
    },
    {
      name: "mobile-iphone",
      use: { ...devices["iPhone 14"] },
    },
    {
      name: "mobile-android",
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "tablet-ipad",
      use: { ...devices["iPad (gen 7)"] },
    },
    // 🔧 [2026-09-22 사용자 지시: "여러 환경에서의 문제점을 테스트 단계에서
    // 파악하고 싶다"] — 키보드 인셋/v버튼 위치 계산(useKeyboardInset.ts,
    // AppShell.tsx)이 세로/가로 판정에 window.innerWidth와
    // window.screen.width를 비교하는 로직을 갖고 있어(useVisualViewportRect
    // 참고), 가로모드에서만 재현되는 회귀가 있을 수 있는데 지금까지
    // 세로모드 프리셋만 있어 이 방향 자체가 전혀 실행되지 않았다.
    // devices[...] 프리셋에 이미 있는 viewport를 가로로 뒤집어(w/h 교체)
    // 등록한다 — AppShell.tsx의 fitToScreen(mobile-landscape: 브레이크포인트)
    // 분기도 이 프로젝트에서만 실행된다.
    {
      // 🔧 [버그 수정, 2026-09-22 디버그 확인] 처음엔 viewport만 뒤집었는데,
      // devices["iPhone 14"]는 viewport(390×664, 브라우저 크롬 제외한
      // 실제 뷰포트)와 screen(390×844, 물리적 화면 전체) 값이 서로
      // 다르다 — screen을 안 뒤집으면 useVisualViewportRect의
      // isLandscape 판정(window.innerWidth > window.screen.width)은
      // 664>390이라 맞게 true가 나오지만, 그 뒤 screenHeight =
      // isLandscape ? window.screen.width : ... 에서 뒤집히지 않은
      // screen.width(세로 기준 너비, 390)를 그대로 써 실제 세로 방향
      // 화면 높이(844)와 전혀 다른 값이 된다 — 실측: 로그인/제보 페이지의
      // "스크롤 여지 없음" 테스트가 이 프로젝트에서만 재현성 있게
      // 실패(scrollHeight-clientHeight=488)했다. screen도 viewport와
      // 동일하게 가로로 뒤집어야 실제 iOS 기기 회전과 같은 상태가 된다.
      //
      // 🔧 [2026-09-22 재확인] Playwright에 내장된 "iPhone 14 landscape"
      // 프리셋이 실제로 존재하지만(devices["iPhone 14 landscape"]),
      // 그 프리셋은 viewport만 뒤집고 screen은 세로값(390×844) 그대로
      // 둔다 — useKeyboardInset.ts의 isLandscape 판정 주석("iOS는 회전
      // 시 screen.width/height 값 자체를 서로 교체한다", 실기기 실측
      // 근거)과 정면으로 다르다. 내장 프리셋을 썼다면 이 훅의 회전 판정
      // 버그를 오히려 은폐했을 것 — 이 프로젝트의 실제 hook 계약에 맞게
      // 계속 커스텀으로 뒤집은 값을 쓴다(devicesWithScreen은 파일 상단 참고).
      name: "mobile-iphone-landscape",
      use: {
        ...devicesWithScreen["iPhone 14"],
        viewport: {
          width: devicesWithScreen["iPhone 14"].viewport!.height,
          height: devicesWithScreen["iPhone 14"].viewport!.width,
        },
        screen: {
          width: devicesWithScreen["iPhone 14"].screen!.height,
          height: devicesWithScreen["iPhone 14"].screen!.width,
        },
      } as Partial<PlaywrightTestOptions> & { screen: ScreenSize },
    },
    {
      // iPad (gen 7) 프리셋은 screen 필드가 아예 없다(Playwright가 없으면
      // viewport와 동일하게 취급) — viewport 자체를 기준으로 뒤집는다.
      name: "tablet-ipad-landscape",
      use: {
        ...devicesWithScreen["iPad (gen 7)"],
        viewport: {
          width: devicesWithScreen["iPad (gen 7)"].viewport!.height,
          height: devicesWithScreen["iPad (gen 7)"].viewport!.width,
        },
        screen: {
          width: devicesWithScreen["iPad (gen 7)"].viewport!.height,
          height: devicesWithScreen["iPad (gen 7)"].viewport!.width,
        },
      } as Partial<PlaywrightTestOptions> & { screen: ScreenSize },
    },
  ],
});
