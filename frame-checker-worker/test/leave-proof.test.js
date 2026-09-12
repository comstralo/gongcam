// 사유반휴 증빙 신청/조회/철회/관리자 승인·반려 통합 테스트. 봇 URL을
// 설정하지 않으면 proxyToBotDashboard가 fetch 없이 즉시 null을 반환하므로
// (BotAdminConfigDO, 실제 workerd) "봇 오프라인" 경로(LeaveQueue DO 큐
// 경유)를 자연스럽게 검증할 수 있다 — 6~10차와 동일하게 fileId/회원번호를
// 테스트 케이스마다 다르게 줘서 격리한다.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../src/index.js";
import {
  handleGetReasonLeaveProof,
  handleSetReasonLeaveProof,
  handleCancelReasonLeaveProof,
  handleAdminLeaveProofList,
  handleAdminLeaveProofFile,
  handleAdminLeaveProofDecide,
} from "../src/leave.js";
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
    GOOGLE_SHEET_FILE_ID: "live-leave-proof-file",
    GOOGLE_SERVICE_ACCOUNT_JSON: TEST_SERVICE_ACCOUNT_JSON,
    BOT_SECRET: "test-bot-secret",
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

// 사유반휴 잔여(C41, ROW_REASON_LEAVE_LEFT+1=41) mock — 봇 URL 미설정이라
// proxyToBotDashboard는 fetch 없이 null을 반환하므로 이 range 하나만
// mock하면 충분하다.
function stubReasonLeaveFetch({ left = 1 } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
      if (u.includes("!C41")) return Promise.resolve(new Response(JSON.stringify({ values: [[String(left)]] })));
      if (u.includes("values:batchUpdate")) return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      throw new Error("unexpected fetch: " + u);
    })
  );
}

async function submitReasonLeaveProof(testEnv, token, overrides = {}) {
  const body = {
    day: "월",
    reason: "몸살감기",
    imageBase64: "ZmFrZS1pbWFnZQ==",
    imageExt: "jpg",
    count: 1,
    ...overrides,
  };
  const req = makeRequest("https://worker/reason-leave-proof", { token, method: "POST", body });
  return handleSetReasonLeaveProof(req, testEnv, "https://example.com");
}

describe("handleGetReasonLeaveProof", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const url = new URL("https://worker/reason-leave-proof?day=월");
    const req = makeRequest(url.toString());

    const res = await handleGetReasonLeaveProof(req, testEnv, "https://example.com", url);
    expect(res.status).toBe(401);
  });

  it("day가 잘못되면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const url = new URL("https://worker/reason-leave-proof?day=존재안함");
    const req = makeRequest(url.toString(), { token });

    const res = await handleGetReasonLeaveProof(req, testEnv, "https://example.com", url);
    expect(res.status).toBe(400);
  });

  it("신청 이력이 없으면 pending:false를 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "leave-proof-get-none" });
    const token = await makeMemberToken({ memberNumber: "1" });
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        throw new Error("unexpected fetch: " + u);
      })
    );
    const url = new URL("https://worker/reason-leave-proof?day=월");
    const req = makeRequest(url.toString(), { token });

    const res = await handleGetReasonLeaveProof(req, testEnv, "https://example.com", url);
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toEqual({ pending: false, rejected: null });
  });
});

describe("handleSetReasonLeaveProof", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/reason-leave-proof", { method: "POST", body: {} });

    const res = await handleSetReasonLeaveProof(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("필수 필드가 없으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const req = makeRequest("https://worker/reason-leave-proof", { token, method: "POST", body: { day: "월" } });

    const res = await handleSetReasonLeaveProof(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("잔여량이 없으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "leave-proof-set-noleft" });
    const token = await makeMemberToken({ memberNumber: "2" });
    stubReasonLeaveFetch({ left: 0 });

    const res = await submitReasonLeaveProof(testEnv, token);
    expect(res.status).toBe(400);
  });

  it("봇이 꺼져 있으면 큐에 등록되고 queued:true를 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "leave-proof-set-queued" });
    const token = await makeMemberToken({ memberNumber: "3" });
    stubReasonLeaveFetch({ left: 1 });

    const res = await submitReasonLeaveProof(testEnv, token);
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.queued).toBe(true);
  });

  it("등록 직후 handleGetReasonLeaveProof가 pending:true를 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "leave-proof-set-then-get" });
    const token = await makeMemberToken({ memberNumber: "4" });
    stubReasonLeaveFetch({ left: 1 });
    await submitReasonLeaveProof(testEnv, token);

    const url = new URL("https://worker/reason-leave-proof?day=월");
    const req = makeRequest(url.toString(), { token });
    const res = await handleGetReasonLeaveProof(req, testEnv, "https://example.com", url);
    const body = await res.json();
    expect(body).toEqual({ pending: true, rejected: null });
  });

  it("같은 요일에 이미 대기 중인 신청이 있으면 409를 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "leave-proof-set-dup" });
    const token = await makeMemberToken({ memberNumber: "5" });
    stubReasonLeaveFetch({ left: 2 });
    await submitReasonLeaveProof(testEnv, token);

    const res2 = await submitReasonLeaveProof(testEnv, token);
    expect(res2.status).toBe(409);
  });
});

describe("handleCancelReasonLeaveProof", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/reason-leave-proof/cancel", { method: "POST", body: { day: "월" } });

    const res = await handleCancelReasonLeaveProof(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("큐에 있는 신청을 본인이 철회하면 200을 반환하고 큐에서 사라진다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "leave-proof-cancel-ok" });
    const token = await makeMemberToken({ memberNumber: "6" });
    stubReasonLeaveFetch({ left: 1 });
    await submitReasonLeaveProof(testEnv, token);

    const cancelReq = makeRequest("https://worker/reason-leave-proof/cancel", { token, method: "POST", body: { day: "월" } });
    const cancelRes = await handleCancelReasonLeaveProof(cancelReq, testEnv, "https://example.com");
    expect(cancelRes.status).toBe(200);

    const url = new URL("https://worker/reason-leave-proof?day=월");
    const getRes = await handleGetReasonLeaveProof(makeRequest(url.toString(), { token }), testEnv, "https://example.com", url);
    const getBody = await getRes.json();
    expect(getBody.pending).toBe(false);
  });

  it("철회할 신청이 없으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "leave-proof-cancel-none" });
    const token = await makeMemberToken({ memberNumber: "7" });
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        throw new Error("unexpected fetch: " + u);
      })
    );
    const req = makeRequest("https://worker/reason-leave-proof/cancel", { token, method: "POST", body: { day: "월" } });

    const res = await handleCancelReasonLeaveProof(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });
});

describe("handleAdminLeaveProofList", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const req = makeRequest("https://worker/admin/leave-proof");

    const res = await handleAdminLeaveProofList(req, testEnv, "https://example.com", null);
    expect(res.status).toBe(403);
  });

  it("큐에 있는 신청이 목록에 나타난다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "leave-proof-list-ok" });
    const memberToken = await makeMemberToken({ memberNumber: "8", memberName: "가나다" });
    stubReasonLeaveFetch({ left: 1 });
    await submitReasonLeaveProof(testEnv, memberToken, { reason: "치과 진료" });

    const adminToken = await makeAdminToken();
    const req = makeRequest("https://worker/admin/leave-proof", { token: adminToken });
    const res = await handleAdminLeaveProofList(req, testEnv, "https://example.com", new URL("https://worker/admin/leave-proof"));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.readOnly).toBe(false);
    expect(body.items.some((it) => it.memberNumber === "8" && it.reason === "치과 진료" && it.queued === true)).toBe(true);
  });
});

describe("handleAdminLeaveProofFile", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const url = new URL("https://worker/admin/leave-proof/file?id=x");
    const req = makeRequest(url.toString(), { token });

    const res = await handleAdminLeaveProofFile(req, testEnv, "https://example.com", url);
    expect(res.status).toBe(403);
  });

  it("id가 없으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeAdminToken();
    const url = new URL("https://worker/admin/leave-proof/file");
    const req = makeRequest(url.toString(), { token });

    const res = await handleAdminLeaveProofFile(req, testEnv, "https://example.com", url);
    expect(res.status).toBe(400);
  });

  it("큐에 있는 증빙 이미지를 base64 디코드해 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "leave-proof-file-ok" });
    const memberToken = await makeMemberToken({ memberNumber: "9" });
    stubReasonLeaveFetch({ left: 1 });
    const setRes = await submitReasonLeaveProof(testEnv, memberToken);
    const { id } = await setRes.json();

    const adminToken = await makeAdminToken();
    const url = new URL(`https://worker/admin/leave-proof/file?id=${id}`);
    const req = makeRequest(url.toString(), { token: adminToken });
    const res = await handleAdminLeaveProofFile(req, testEnv, "https://example.com", url);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
  });
});

describe("handleAdminLeaveProofDecide", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const req = makeRequest("https://worker/admin/leave-proof/decide", {
      token,
      method: "POST",
      body: { id: "x", decision: "approved", memberNumber: "1", day: "월" },
    });

    const res = await handleAdminLeaveProofDecide(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("반려 사유 없이 반려하면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeAdminToken();
    const req = makeRequest("https://worker/admin/leave-proof/decide", {
      token,
      method: "POST",
      body: { id: "x", decision: "rejected", memberNumber: "1", day: "월" },
    });

    const res = await handleAdminLeaveProofDecide(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("큐에 있는 신청을 반려하면 큐에서 삭제되고 200을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "leave-proof-decide-reject" });
    const memberToken = await makeMemberToken({ memberNumber: "10" });
    stubReasonLeaveFetch({ left: 1 });
    const setRes = await submitReasonLeaveProof(testEnv, memberToken);
    const { id } = await setRes.json();

    const adminToken = await makeAdminToken();
    const decideReq = makeRequest("https://worker/admin/leave-proof/decide", {
      token: adminToken,
      method: "POST",
      body: { id, decision: "rejected", memberNumber: "10", day: "월", rejectReason: "증빙 불충분" },
    });
    const decideRes = await handleAdminLeaveProofDecide(decideReq, testEnv, "https://example.com");
    const decideBody = await decideRes.json();
    expect(decideRes.status, JSON.stringify(decideBody)).toBe(200);

    const url = new URL("https://worker/reason-leave-proof?day=월");
    const getRes = await handleGetReasonLeaveProof(makeRequest(url.toString(), { token: memberToken }), testEnv, "https://example.com", url);
    const getBody = await getRes.json();
    expect(getBody.pending).toBe(false);
  });

  it("큐에 있는 신청을 승인하면 시트에 반영되고 200을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "leave-proof-decide-approve" });
    const memberToken = await makeMemberToken({ memberNumber: "11" });
    const writeCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url, init) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("!C41")) return Promise.resolve(new Response(JSON.stringify({ values: [["1"]] })));
        // 사유반휴 사용 셀 조회 — ROW_REASON_LEAVE_USE(20, 0-idx)+1=21행,
        // 월요일은 STATUS_DAY_COLS[0]=2(0-idx) -> "C"열.
        if (u.includes("!C21")) return Promise.resolve(new Response(JSON.stringify({ values: [[""]] })));
        if (u.includes("values:batchUpdate")) {
          writeCalls.push(JSON.parse(init.body));
          return Promise.resolve(new Response(JSON.stringify({ ok: true })));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );
    const setRes = await submitReasonLeaveProof(testEnv, memberToken);
    const { id } = await setRes.json();

    const adminToken = await makeAdminToken();
    const decideReq = makeRequest("https://worker/admin/leave-proof/decide", {
      token: adminToken,
      method: "POST",
      body: { id, decision: "approved", memberNumber: "11", day: "월", count: 1 },
    });
    const decideRes = await handleAdminLeaveProofDecide(decideReq, testEnv, "https://example.com");
    const decideBody = await decideRes.json();
    expect(decideRes.status, JSON.stringify(decideBody)).toBe(200);
    expect(writeCalls.some((c) => c.data.some((d) => d.range === "11!C21" && d.values[0][0] === 1))).toBe(true);
  });
});
