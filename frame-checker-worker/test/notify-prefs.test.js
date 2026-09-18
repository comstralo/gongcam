// 알림 설정(notify-prefs)/상태 메시지(status-message) 통합 테스트 —
// MemberSettingsDO(실제 workerd)에 값을 읽고 쓴다. 6~9차와 동일하게
// fileId를 테스트 케이스마다 다르게 줘서 listAllMembers 캐시 오염을
// 피한다.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../src/index.js";
import {
  handleGetNotifyPrefs,
  handleSetNotifyPrefs,
  handleGetStatusMessage,
  handleSetStatusMessage,
  handleGetMemberStatusMessage,
} from "../src/notify.js";
import { TEST_SERVICE_ACCOUNT_JSON, oauthTokenResponse } from "./helpers/service-account.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const TEST_SECRET = "test-session-secret";

function makeTestEnv(overrides = {}) {
  return {
    ...env,
    SESSION_SECRET: TEST_SECRET,
    GOOGLE_SHEET_FILE_ID: "live-notify-file",
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

function dataSheetResponse(members) {
  const rows = [["헤더", "번호", "이름", "이메일"]];
  for (const m of members) rows.push(["", String(m.number), m.name, m.email || ""]);
  return new Response(JSON.stringify({ values: rows }));
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

describe("handleGetNotifyPrefs / handleSetNotifyPrefs", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/notify-prefs");

    const res = await handleGetNotifyPrefs(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("기본값(전부 true)을 반환한다", async () => {
    stubOauthFetch();
    const testEnv = makeTestEnv();
    const token = await signSession({ email: "m@test.com", memberNumber: "1", exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
    const req = makeRequest("https://worker/notify-prefs", { token });

    const res = await handleGetNotifyPrefs(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.prefs.report_result).toBe(true);
    expect(body.categories.report_result).toBe("제보 처리 결과");
  });

  it("알 수 없는 카테고리면 400을 반환한다", async () => {
    stubOauthFetch();
    const testEnv = makeTestEnv();
    const token = await signSession({ email: "m@test.com", memberNumber: "2", exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
    const req = makeRequest("https://worker/notify-prefs", { token, method: "POST", body: { category: "nope", enabled: false } });

    const res = await handleSetNotifyPrefs(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("설정을 끄면 저장되고 다시 조회 시 반영된다", async () => {
    stubOauthFetch();
    const testEnv = makeTestEnv();
    const token = await signSession({ email: "m@test.com", memberNumber: "3", exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
    const setReq = makeRequest("https://worker/notify-prefs", {
      token,
      method: "POST",
      body: { category: "fine_status", enabled: false },
    });
    const setRes = await handleSetNotifyPrefs(setReq, testEnv, "https://example.com");
    expect(setRes.status).toBe(200);

    const getReq = makeRequest("https://worker/notify-prefs", { token });
    const getRes = await handleGetNotifyPrefs(getReq, testEnv, "https://example.com");
    const body = await getRes.json();
    expect(body.prefs.fine_status).toBe(false);
  });
});

describe("handleGetStatusMessage / handleSetStatusMessage", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/status-message");

    const res = await handleGetStatusMessage(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("설정 전에는 빈 문자열을 반환한다", async () => {
    stubOauthFetch();
    const testEnv = makeTestEnv();
    const token = await signSession({ email: "m@test.com", memberNumber: "4", exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
    const req = makeRequest("https://worker/status-message", { token });

    const res = await handleGetStatusMessage(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(body.message).toBe("");
  });

  it("message가 문자열이 아니면 400을 반환한다", async () => {
    stubOauthFetch();
    const testEnv = makeTestEnv();
    const token = await signSession({ email: "m@test.com", memberNumber: "5", exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
    const req = makeRequest("https://worker/status-message", { token, method: "POST", body: { message: 123 } });

    const res = await handleSetStatusMessage(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("40자를 넘으면 잘라서 저장한다", async () => {
    stubOauthFetch();
    const testEnv = makeTestEnv();
    const token = await signSession({ email: "m@test.com", memberNumber: "6", exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
    const longMessage = "가".repeat(100);
    const req = makeRequest("https://worker/status-message", { token, method: "POST", body: { message: longMessage } });

    const res = await handleSetStatusMessage(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.message.length).toBe(40);
  });

  it("빈 문자열로 저장하면 삭제되어 다시 빈 문자열로 조회된다", async () => {
    stubOauthFetch();
    const testEnv = makeTestEnv();
    const token = await signSession({ email: "m@test.com", memberNumber: "7", exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
    const setReq1 = makeRequest("https://worker/status-message", { token, method: "POST", body: { message: "태블릿용" } });
    await handleSetStatusMessage(setReq1, testEnv, "https://example.com");

    const setReq2 = makeRequest("https://worker/status-message", { token, method: "POST", body: { message: "" } });
    await handleSetStatusMessage(setReq2, testEnv, "https://example.com");

    const getReq = makeRequest("https://worker/status-message", { token });
    const res = await handleGetStatusMessage(getReq, testEnv, "https://example.com");
    const body = await res.json();
    expect(body.message).toBe("");
  });
});

describe("handleGetMemberStatusMessage", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/member-status-message?nickname=가나다");

    const res = await handleGetMemberStatusMessage(req, testEnv, "https://example.com", new URL("https://worker/member-status-message?nickname=가나다"));
    expect(res.status).toBe(401);
  });

  it("nickname이 없으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await signSession({ email: "m@test.com", exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
    const req = makeRequest("https://worker/member-status-message", { token });

    const res = await handleGetMemberStatusMessage(req, testEnv, "https://example.com", new URL("https://worker/member-status-message"));
    expect(res.status).toBe(400);
  });

  it("존재하지 않는 닉네임이면 빈 메시지를 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "notify-member-status-none" });
    const token = await signSession({ email: "m@test.com", exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("V50")) return Promise.resolve(dataSheetResponse([]));
        throw new Error("unexpected fetch: " + u);
      })
    );
    const req = makeRequest("https://worker/member-status-message?nickname=없는사람", { token });

    const res = await handleGetMemberStatusMessage(
      req,
      testEnv,
      "https://example.com",
      new URL("https://worker/member-status-message?nickname=없는사람")
    );
    const body = await res.json();
    expect(body.message).toBe("");
  });

  it("본인이 등록한 상태 메시지를 다른 회원이 닉네임으로 조회할 수 있다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "notify-member-status-found" });
    const ownerToken = await signSession(
      { email: "owner@test.com", memberNumber: "8", exp: Date.now() / 1000 + 3600 },
      TEST_SECRET
    );
    stubOauthFetch();
    const setReq = makeRequest("https://worker/status-message", { token: ownerToken, method: "POST", body: { message: "이거 제 겁니다" } });
    await handleSetStatusMessage(setReq, testEnv, "https://example.com");

    const viewerToken = await signSession({ email: "viewer@test.com", exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("V50")) return Promise.resolve(dataSheetResponse([{ number: 8, name: "가나다", email: "owner@test.com" }]));
        throw new Error("unexpected fetch: " + u);
      })
    );
    const req = makeRequest("https://worker/member-status-message?nickname=가나다", { token: viewerToken });

    const res = await handleGetMemberStatusMessage(
      req,
      testEnv,
      "https://example.com",
      new URL("https://worker/member-status-message?nickname=가나다")
    );
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.message).toBe("이거 제 겁니다");
  });
});
