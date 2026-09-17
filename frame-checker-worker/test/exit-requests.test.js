// 퇴실 신청/동의/취소, 도움봇 조회 통합 테스트 — LeaveQueue DO(실제
// workerd)와 fetch mock을 조합한다. 6~7차와 동일하게 fileId를 테스트
// 케이스마다 다르게 줘서 _cachedCompute 캐시 오염을 피한다.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../src/index.js";
import {
  handleSetExitRequest,
  handleAgreeExitRequest,
  handleCancelExitRequest,
  handleBotExitRequests,
} from "../src/exit-request.js";
import { TEST_SERVICE_ACCOUNT_JSON, oauthTokenResponse } from "./helpers/service-account.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const TEST_SECRET = "test-session-secret";
const ADMIN_EMAIL = "admin@test.com";
const MEMBER_EMAIL = "member@test.com";

function makeTestEnv(overrides = {}) {
  return {
    ...env,
    SESSION_SECRET: TEST_SECRET,
    ADMIN_EMAIL,
    GOOGLE_SHEET_FILE_ID: "live-exit-req-file",
    GOOGLE_SERVICE_ACCOUNT_JSON: TEST_SERVICE_ACCOUNT_JSON,
    BOT_SECRET: "test-bot-secret",
    ...overrides,
  };
}

async function makeMemberToken(overrides = {}) {
  return signSession({ email: MEMBER_EMAIL, memberNumber: "3", exp: Date.now() / 1000 + 3600, ...overrides }, TEST_SECRET);
}

function makeRequest(url, { token, method = "GET", body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body) h["Content-Type"] = "application/json";
  return new Request(url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
}

// resolveMemberNumber(session.memberNumber가 있어도) 호출 전에 항상
// getServiceAccountAccessToken(env)를 먼저 실행하므로, OAuth 토큰 fetch는
// 매 테스트에서 mock이 필요하다.
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

describe("handleSetExitRequest", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/exit-request", { method: "POST", body: {} });

    const res = await handleSetExitRequest(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("희망 퇴실일 형식이 올바르지 않으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const req = makeRequest("https://worker/exit-request", { token, method: "POST", body: { exitDate: "not-a-date" } });

    const res = await handleSetExitRequest(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("유효한 요청이면 200을 반환하고 LeaveQueue DO에 신청이 기록된다", async () => {
    stubOauthFetch();
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-req-set-ok" });
    const token = await makeMemberToken();
    const req = makeRequest("https://worker/exit-request", {
      token,
      method: "POST",
      body: { exitDate: "2026-09-20" },
    });

    const res = await handleSetExitRequest(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toEqual({ ok: true });

    const id = testEnv.LEAVE_QUEUE_DO.idFromName("leave-queue");
    const stub = testEnv.LEAVE_QUEUE_DO.get(id);
    const getRes = await stub.fetch("https://do/exit/get?memberNumber=3");
    const { entry } = await getRes.json();
    expect(entry).toMatchObject({ exitDate: "2026-09-20", agreedAt: null });
  });
});

describe("handleAgreeExitRequest", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/exit-request/agree", { method: "POST" });

    const res = await handleAgreeExitRequest(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("퇴실 신청 내역이 없으면 404를 반환한다", async () => {
    stubOauthFetch();
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-req-agree-404" });
    const token = await makeMemberToken({ memberNumber: "9" });
    const req = makeRequest("https://worker/exit-request/agree", { token, method: "POST" });

    const res = await handleAgreeExitRequest(req, testEnv, "https://example.com");
    expect(res.status).toBe(404);
  });

  it("일간 집계가 끝나지 않은 미래 날짜면 400을 반환한다", async () => {
    stubOauthFetch();
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-req-agree-notsettled" });
    const token = await makeMemberToken({ memberNumber: "4" });
    const setReq = makeRequest("https://worker/exit-request", {
      token,
      method: "POST",
      body: { exitDate: "2999-01-01" },
    });
    await handleSetExitRequest(setReq, testEnv, "https://example.com");

    const req = makeRequest("https://worker/exit-request/agree", { token, method: "POST" });
    const res = await handleAgreeExitRequest(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("일간 집계가 끝난 과거 날짜면 동의가 기록되고 200을 반환한다", async () => {
    stubOauthFetch();
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-req-agree-ok" });
    const token = await makeMemberToken({ memberNumber: "5" });
    const setReq = makeRequest("https://worker/exit-request", {
      token,
      method: "POST",
      body: { exitDate: "2020-01-01" },
    });
    await handleSetExitRequest(setReq, testEnv, "https://example.com");

    const req = makeRequest("https://worker/exit-request/agree", { token, method: "POST" });
    const res = await handleAgreeExitRequest(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.agreedAt).toBe("number");
  });
});

describe("handleCancelExitRequest", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/exit-request/cancel", { method: "POST" });

    const res = await handleCancelExitRequest(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("본인 신청을 취소하면 200을 반환한다", async () => {
    stubOauthFetch();
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-req-cancel-self" });
    const token = await makeMemberToken({ memberNumber: "6" });
    const setReq = makeRequest("https://worker/exit-request", {
      token,
      method: "POST",
      body: { exitDate: "2026-09-20" },
    });
    await handleSetExitRequest(setReq, testEnv, "https://example.com");

    const req = makeRequest("https://worker/exit-request/cancel", { token, method: "POST" });
    const res = await handleCancelExitRequest(req, testEnv, "https://example.com");
    expect(res.status).toBe(200);

    const id = testEnv.LEAVE_QUEUE_DO.idFromName("leave-queue");
    const stub = testEnv.LEAVE_QUEUE_DO.get(id);
    const getRes = await stub.fetch("https://do/exit/get?memberNumber=6");
    const { entry } = await getRes.json();
    expect(entry).toBeFalsy();
  });

  it("관리자가 아닌 회원이 다른 회원 번호를 지정하면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken({ memberNumber: "6" });
    const req = makeRequest("https://worker/exit-request/cancel", {
      token,
      method: "POST",
      body: { number: "7" },
    });

    const res = await handleCancelExitRequest(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("관리자는 다른 회원의 신청을 취소할 수 있다", async () => {
    stubOauthFetch();
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-req-cancel-admin" });
    const memberToken = await makeMemberToken({ memberNumber: "8" });
    const setReq = makeRequest("https://worker/exit-request", {
      token: memberToken,
      method: "POST",
      body: { exitDate: "2026-09-20" },
    });
    await handleSetExitRequest(setReq, testEnv, "https://example.com");

    const adminToken = await signSession({ email: ADMIN_EMAIL, exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
    const req = makeRequest("https://worker/exit-request/cancel", {
      token: adminToken,
      method: "POST",
      body: { number: "8" },
    });
    const res = await handleCancelExitRequest(req, testEnv, "https://example.com");
    expect(res.status).toBe(200);
  });
});

describe("handleBotExitRequests", () => {
  it("봇 시크릿이 없으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/bot/exit-requests");

    const res = await handleBotExitRequests(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("신청된 exitDate만 회원번호별로 내려준다", async () => {
    stubOauthFetch();
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-req-bot" });
    const token = await makeMemberToken({ memberNumber: "10" });
    const setReq = makeRequest("https://worker/exit-request", {
      token,
      method: "POST",
      body: { exitDate: "2026-09-22" },
    });
    await handleSetExitRequest(setReq, testEnv, "https://example.com");

    const req = makeRequest("https://worker/bot/exit-requests", {
      headers: { "X-Bot-Secret": "test-bot-secret" },
    });
    const res = await handleBotExitRequests(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.exitDates["10"]).toBe("2026-09-22");
  });
});
