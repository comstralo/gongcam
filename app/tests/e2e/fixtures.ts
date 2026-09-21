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

export const test = base.extend<{ authedPage: Page }>({
  authedPage: async ({ page, request }, use, testInfo) => {
    if (!DEV_LOGIN_SECRET || !TEST_EMAIL) {
      testInfo.skip(true, "E2E_DEV_LOGIN_SECRET/E2E_TEST_EMAIL이 .env.test에 없어 로그인 필요 테스트를 건너뜁니다 (tests/e2e/README.md 참고)");
      return;
    }
    const session = await fetchDevSessionToken(request);
    await injectSession(page, session);
    await use(page);
  },
});

export { expect };
