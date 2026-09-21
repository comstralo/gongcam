import { defineConfig, devices } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

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
  retries: process.env.CI ? 1 : 0,
  reporter: [["html", { open: "never" }]],
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
  ],
});
