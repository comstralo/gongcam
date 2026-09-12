// 회원 관리 도메인의 비교적 얕은 핸들러 통합 테스트 — fetch mock +
// signSession으로 만든 유효 토큰을 조합해 requireAdmin 인증 경로까지
// 함께 검증한다(6차 fines-handlers.test.js와 동일 패턴).
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../src/index.js";
import {
  handleAdminMembers,
  handleAdminOpenSlots,
  handleAdminMemberReorderPreview,
  handleGrantMemberAccess,
} from "../src/members.js";
import { TEST_SERVICE_ACCOUNT_JSON, oauthTokenResponse } from "./helpers/service-account.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const TEST_SECRET = "test-session-secret";
const ADMIN_EMAIL = "admin@test.com";

function makeTestEnv(overrides = {}) {
  return {
    ...env,
    SESSION_SECRET: TEST_SECRET,
    ADMIN_EMAIL,
    GOOGLE_SHEET_FILE_ID: "live-members-file",
    GOOGLE_SERVICE_ACCOUNT_JSON: TEST_SERVICE_ACCOUNT_JSON,
    ...overrides,
  };
}

async function makeAdminToken() {
  return signSession({ email: ADMIN_EMAIL, exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
}

async function makeNonAdminToken() {
  return signSession({ email: "member@test.com", exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
}

function makeRequest(url, { token, method = "GET", body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

function dataSheetResponse(members) {
  const rows = [["헤더", "번호", "이름", "이메일"]];
  for (const m of members) rows.push(["", String(m.number), m.name, m.email || ""]);
  return new Response(JSON.stringify({ values: rows }));
}

function stubReadFetch(dataMembers) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com")) {
        return Promise.resolve(oauthTokenResponse());
      }
      if (u.includes("V50")) {
        return Promise.resolve(dataSheetResponse(dataMembers));
      }
      // handleAdminMembers가 listExitedMemberEntries를 통해 조회하는
      // 스프레드시트 메타 — 퇴실자 백업 탭이 없는 상태로 응답한다.
      if (u.includes("fields=sheets.properties")) {
        return Promise.resolve(new Response(JSON.stringify({ sheets: [] })));
      }
      throw new Error("unexpected fetch: " + u);
    })
  );
}

describe("handleAdminMembers", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeNonAdminToken();
    const req = makeRequest("https://worker/admin/members", { token });

    const res = await handleAdminMembers(req, testEnv, "https://example.com", null);
    expect(res.status).toBe(403);
  });

  it("관리자면 회원 목록을 정상 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "handler-members-list" });
    const token = await makeAdminToken();
    stubReadFetch([{ number: 1, name: "가", email: "a@b.com" }]);
    const req = makeRequest("https://worker/admin/members", { token });
    const url = new URL("https://worker/admin/members");

    const res = await handleAdminMembers(req, testEnv, "https://example.com", url);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const body = await res.json();
    expect(body.members).toEqual([{ number: "1", name: "가", email: "a@b.com" }]);
  });
});

describe("handleAdminOpenSlots", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeNonAdminToken();
    const req = makeRequest("https://worker/admin/members/open-slots", { token });

    const res = await handleAdminOpenSlots(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("이메일이 비어있는 슬롯 번호를 오름차순으로 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "handler-open-slots" });
    const token = await makeAdminToken();
    stubReadFetch([
      { number: 1, name: "가", email: "a@b.com" },
      { number: 3, name: "", email: "" },
      { number: 2, name: "", email: "" },
    ]);
    const req = makeRequest("https://worker/admin/members/open-slots", { token });

    const res = await handleAdminOpenSlots(req, testEnv, "https://example.com");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slots).toEqual(["2", "3"]);
  });
});

describe("handleAdminMemberReorderPreview", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeNonAdminToken();
    const req = makeRequest("https://worker/admin/members/reorder-preview", { token });

    const res = await handleAdminMemberReorderPreview(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("관리자면 이동 계획을 정상 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "handler-reorder-preview" });
    const token = await makeAdminToken();
    stubReadFetch([
      { number: 1, name: "가", email: "a@b.com" },
      { number: 3, name: "다", email: "c@d.com" },
    ]);
    const req = makeRequest("https://worker/admin/members/reorder-preview", { token });

    const res = await handleAdminMemberReorderPreview(req, testEnv, "https://example.com");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan).toEqual([{ from: "3", to: "2", name: "다" }]);
  });
});

describe("handleGrantMemberAccess", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeNonAdminToken();
    const req = makeRequest("https://worker/admin/members/grant-access", {
      token,
      method: "POST",
      body: { email: "a@b.com" },
    });

    const res = await handleGrantMemberAccess(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("이메일 형식이 올바르지 않으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeAdminToken();
    const req = makeRequest("https://worker/admin/members/grant-access", {
      token,
      method: "POST",
      body: { email: "not-an-email" },
    });

    const res = await handleGrantMemberAccess(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("관리자 위임 인증이 안 되어 있으면 500을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeAdminToken();
    // getAdminAccessToken은 BOT_ADMIN_CONFIG_DO에 refreshToken이 없으면
    // 즉시 에러를 던진다 — 이 테스트 스위트에서 DO에 값을 심어둔 적이
    // 없으므로 grantSheetAccess가 실패하는 경로를 그대로 검증한다.
    const req = makeRequest("https://worker/admin/members/grant-access", {
      token,
      method: "POST",
      body: { email: "a@b.com" },
    });

    const res = await handleGrantMemberAccess(req, testEnv, "https://example.com");
    expect(res.status).toBe(500);
  });
});
