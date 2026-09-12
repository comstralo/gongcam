// 일반/사유 반휴 즉시 신청(handleGetLeaveApply/handleSetLeaveApply/
// handleAdminLeaveApply) 통합 테스트 — fetch mock + 실제 workerd
// ParticipantsRoster DO(leave-rate 제한)를 조합한다. 6~10차와 동일하게
// GOOGLE_SHEET_FILE_ID를 테스트 케이스마다 다르게 줘서 격리한다(단,
// leave-rate DO 제한은 memberNumber가 키이므로 세션 이메일/memberNumber도
// 함께 바꿔야 한다 — 10차에서 확인한 DO 상태 격리 원칙).
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../src/index.js";
import { handleGetLeaveApply, handleSetLeaveApply, handleAdminLeaveApply } from "../src/leave.js";
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
    GOOGLE_SHEET_FILE_ID: "live-leave-apply-file",
    GOOGLE_SERVICE_ACCOUNT_JSON: TEST_SERVICE_ACCOUNT_JSON,
    ...overrides,
  };
}

function makeRequest(url, { token, method = "GET", body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

async function makeMemberToken(overrides = {}) {
  return signSession({ email: "m@test.com", exp: Date.now() / 1000 + 3600, ...overrides }, TEST_SECRET);
}

async function makeAdminToken() {
  return signSession({ email: ADMIN_EMAIL, exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
}

function stubOauthFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
      throw new Error("unexpected fetch: " + u);
    })
  );
}

// 일반반휴 useRow=19(0-idx)->20행, leftRow=39(0-idx)->40행. 월요일은
// STATUS_DAY_COLS[0]=2(0-idx) -> "C"열이라 사용 셀은 "{번호}!C20", 잔여
// 셀은 항상 "{번호}!C{leftRow+1}"(40) — 둘 다 "!C"로 시작해 행 번호(20 vs
// 40)로만 구분해야 한다.
function stubLeaveApplyFetch({ currentCount = "", left = 2 } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
      if (u.includes("!C40")) return Promise.resolve(new Response(JSON.stringify({ values: [[String(left)]] })));
      if (u.includes("!C20")) return Promise.resolve(new Response(JSON.stringify({ values: [[currentCount]] })));
      if (u.includes("values:batchUpdate")) return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      throw new Error("unexpected fetch: " + u);
    })
  );
}

describe("handleGetLeaveApply", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/leave-apply?type=normal&day=월");

    const res = await handleGetLeaveApply(req, testEnv, "https://example.com", new URL("https://worker/leave-apply?type=normal&day=월"));
    expect(res.status).toBe(401);
  });

  it("type/day가 잘못되면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const url = new URL("https://worker/leave-apply?type=nope&day=월");
    const req = makeRequest(url.toString(), { token });

    const res = await handleGetLeaveApply(req, testEnv, "https://example.com", url);
    expect(res.status).toBe(400);
  });

  it("관리자가 아닌 회원이 number 파라미터로 다른 회원을 조회하면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const url = new URL("https://worker/leave-apply?type=normal&day=월&number=5");
    const req = makeRequest(url.toString(), { token });

    const res = await handleGetLeaveApply(req, testEnv, "https://example.com", url);
    expect(res.status).toBe(403);
  });

  it("본인 신청 현황을 정상 조회한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "leave-apply-get-ok" });
    const token = await makeMemberToken({ memberNumber: "1" });
    stubLeaveApplyFetch({ currentCount: "1", left: 3 });
    const url = new URL("https://worker/leave-apply?type=normal&day=월");
    const req = makeRequest(url.toString(), { token });

    const res = await handleGetLeaveApply(req, testEnv, "https://example.com", url);
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toEqual({ applied: true, count: 1, left: 3 });
  });
});

describe("handleSetLeaveApply", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/leave-apply", { method: "POST", body: { type: "normal", day: "월", count: 1 } });

    const res = await handleSetLeaveApply(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("잘못된 count면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken({ memberNumber: "2" });
    const req = makeRequest("https://worker/leave-apply", { token, method: "POST", body: { type: "normal", day: "월", count: 5 } });

    const res = await handleSetLeaveApply(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("잔여량이 없으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "leave-apply-set-noleft" });
    const token = await makeMemberToken({ memberNumber: "3" });
    stubLeaveApplyFetch({ currentCount: "", left: 0 });
    const req = makeRequest("https://worker/leave-apply", { token, method: "POST", body: { type: "normal", day: "월", count: 1 } });

    const res = await handleSetLeaveApply(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("유효한 신청이면 200을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "leave-apply-set-ok" });
    const token = await makeMemberToken({ memberNumber: "4" });
    stubLeaveApplyFetch({ currentCount: "", left: 2 });
    const req = makeRequest("https://worker/leave-apply", { token, method: "POST", body: { type: "normal", day: "월", count: 1 } });

    const res = await handleSetLeaveApply(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toEqual({ ok: true, applied: true, count: 1 });
  });

  it("1분에 3번째 요청은 429를 반환한다(회원당 2회 제한)", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "leave-apply-rate-limit" });
    const token = await makeMemberToken({ memberNumber: "5" });
    stubLeaveApplyFetch({ currentCount: "", left: 2 });
    const makeReq = () => makeRequest("https://worker/leave-apply", { token, method: "POST", body: { type: "normal", day: "월", count: 1 } });

    const res1 = await handleSetLeaveApply(makeReq(), testEnv, "https://example.com");
    expect(res1.status).toBe(200);
    const res2 = await handleSetLeaveApply(makeReq(), testEnv, "https://example.com");
    expect(res2.status).toBe(200);
    const res3 = await handleSetLeaveApply(makeReq(), testEnv, "https://example.com");
    expect(res3.status).toBe(429);
  });
});

describe("handleAdminLeaveApply", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const req = makeRequest("https://worker/admin/leave-apply", {
      token,
      method: "POST",
      body: { type: "normal", number: "1", day: "월", count: 1 },
    });

    const res = await handleAdminLeaveApply(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("잘못된 회원번호면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeAdminToken();
    const req = makeRequest("https://worker/admin/leave-apply", {
      token,
      method: "POST",
      body: { type: "normal", number: "99", day: "월", count: 1 },
    });

    const res = await handleAdminLeaveApply(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("유효한 대리 신청이면 200을 반환한다(rate limit 우회)", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "leave-apply-admin-ok" });
    const token = await makeAdminToken();
    stubLeaveApplyFetch({ currentCount: "", left: 2 });
    const req = makeRequest("https://worker/admin/leave-apply", {
      token,
      method: "POST",
      body: { type: "normal", number: "6", day: "월", count: 1 },
    });

    const res = await handleAdminLeaveApply(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toEqual({ ok: true, number: "6", applied: true, count: 1 });
  });
});
