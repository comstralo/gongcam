// 퇴실 처리 도메인의 조회 핸들러(관리자 전용) 통합 테스트 — fetch mock +
// signSession으로 만든 유효 토큰, MemberSettingsDO(실제 workerd)를 조합한다.
// listExitCandidates/listActiveMembersWithExitInfo(getAllExitRelevantStatus
// 경유)는 buildPersonalStatus 없이도 동작하는 조회 전용 경로라 여기서 다룬다.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../src/index.js";
import { handleAdminExitedMembers, handleAdminExitCandidates, handleAdminBlacklist, handleAdminExitBlacklist } from "../src/exit-candidates.js";
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
    GOOGLE_SHEET_FILE_ID: "live-exit-fetch-file",
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

function metaResponse(sheetTitles) {
  return new Response(JSON.stringify({ sheets: sheetTitles.map((title, i) => ({ properties: { sheetId: i, title } })) }));
}

function stubExitedMembersFetch({ sheetTitles, exitResults = {} }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
      if (u.includes("fields=sheets.properties")) return Promise.resolve(metaResponse(sheetTitles));
      throw new Error("unexpected fetch: " + u);
    })
  );
  return exitResults;
}

async function seedExitResult(testEnv, name, entry) {
  const id = testEnv.MEMBER_SETTINGS_DO.idFromName("member-settings");
  const stub = testEnv.MEMBER_SETTINGS_DO.get(id);
  await stub.fetch("https://do/exit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, entry }),
  });
}

describe("handleAdminExitedMembers", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeNonAdminToken();
    const req = makeRequest("https://worker/admin/members/exited", { token });

    const res = await handleAdminExitedMembers(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("백업 탭 목록에 저장된 처리 결과를 붙여 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-fetch-exited-list" });
    const token = await makeAdminToken();
    stubExitedMembersFetch({ sheetTitles: ["1", "2", "가나다 (퇴실)", "template"] });
    await seedExitResult(testEnv, "가나다 (퇴실)", { kind: "settle", kindStr: "정산 퇴실", refundAmount: 50000 });

    const req = makeRequest("https://worker/admin/members/exited", { token });
    const res = await handleAdminExitedMembers(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.members).toEqual([
      { number: "exited:가나다 (퇴실)", name: "가나다 (퇴실)", result: { kind: "settle", kindStr: "정산 퇴실", refundAmount: 50000 } },
    ]);
  });

  it("이 기능 도입 이전 처리된 퇴실자는 result: null로 내려간다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-fetch-exited-null" });
    const token = await makeAdminToken();
    stubExitedMembersFetch({ sheetTitles: ["옛날회원 (퇴실)"] });

    const req = makeRequest("https://worker/admin/members/exited", { token });
    const res = await handleAdminExitedMembers(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(body.members).toEqual([{ number: "exited:옛날회원 (퇴실)", name: "옛날회원 (퇴실)", result: null }]);
  });
});

describe("handleAdminExitCandidates", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeNonAdminToken();
    const req = makeRequest("https://worker/admin/exit/candidates", { token });

    const res = await handleAdminExitCandidates(req, testEnv, "https://example.com", null);
    expect(res.status).toBe(403);
  });
});

describe("handleAdminExitBlacklist", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeNonAdminToken();
    const req = makeRequest("https://worker/admin/exit/blacklist", {
      token,
      method: "POST",
      body: { name: "가나다 (퇴실)", blacklist: true },
    });

    const res = await handleAdminExitBlacklist(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("이름 또는 blacklist 값이 올바르지 않으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeAdminToken();
    const req = makeRequest("https://worker/admin/exit/blacklist", {
      token,
      method: "POST",
      body: { name: "", blacklist: true },
    });

    const res = await handleAdminExitBlacklist(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("처리 결과가 없는 회원은 404를 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-fetch-blacklist-404" });
    const token = await makeAdminToken();
    const req = makeRequest("https://worker/admin/exit/blacklist", {
      token,
      method: "POST",
      body: { name: "존재안함 (퇴실)", blacklist: true },
    });

    const res = await handleAdminExitBlacklist(req, testEnv, "https://example.com");
    expect(res.status).toBe(404);
  });

  it("처리 결과가 있으면 blacklist 값을 덮어쓰고 200을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-fetch-blacklist-ok" });
    const token = await makeAdminToken();
    await seedExitResult(testEnv, "가나다 (퇴실)", { kind: "admin_forced", blacklist: false });

    const req = makeRequest("https://worker/admin/exit/blacklist", {
      token,
      method: "POST",
      body: { name: "가나다 (퇴실)", blacklist: true },
    });
    const res = await handleAdminExitBlacklist(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toEqual({ ok: true, name: "가나다 (퇴실)", blacklist: true });
  });
});

describe("handleAdminBlacklist", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeNonAdminToken();
    const req = makeRequest("https://worker/admin/blacklist", { token });

    const res = await handleAdminBlacklist(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("블랙리스트로 등록된 퇴실자의 계정만 뽑아 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-fetch-blacklist-list" });
    const token = await makeAdminToken();
    stubExitedMembersFetch({ sheetTitles: ["가나다 (퇴실)", "라마바 (퇴실)"] });
    await seedExitResult(testEnv, "가나다 (퇴실)", {
      blacklist: true,
      googleAccount: "black@test.com",
      gooroomeeAccount: "gooroomee@test.com",
    });
    await seedExitResult(testEnv, "라마바 (퇴실)", { blacklist: false });

    const req = makeRequest("https://worker/admin/blacklist", { token });
    const res = await handleAdminBlacklist(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.entries).toEqual([
      { name: "가나다 (퇴실)", googleAccount: "black@test.com", gooroomeeAccount: "gooroomee@test.com" },
    ]);
  });
});
