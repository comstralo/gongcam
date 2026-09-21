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

export const test = base.extend<{ authedPage: Page; pwaPage: Page; authedPwaPage: Page }>({
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
});

export { expect };
