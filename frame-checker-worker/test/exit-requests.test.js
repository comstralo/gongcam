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

// 🔧 [사용자 지시] "미납 벌금이 있거나 상금 정산이 처리되지 않았으면
// 내역과 동의 버튼을 보여주지 않음" — handleAgreeExitRequest가 이제
// buildPersonalStatus(exit-confirm.test.js의 stubForcedExitFetch와 동일한
// 최소 mock 표면)를 태워 fineUnpaid/prizePending을 확인한다.
function dataSheetResponse(members) {
  const rows = [["헤더", "번호", "이름", "이메일"]];
  for (const m of members) rows.push(["", String(m.number), m.name, m.email || ""]);
  return new Response(JSON.stringify({ values: rows }));
}

function personalTabRows({ partiStatus = "스터디원", dday = "D+45" } = {}) {
  const rows = Array.from({ length: 42 }, () => []);
  rows[2] = ["", "", "", "", "", "", "", "", dday, "", "", "스터디원"];
  rows[2][11] = partiStatus;
  rows[2][17] = "";
  rows[31] = ["", "", ""];
  rows[32] = ["", "", 0];
  return rows;
}

function metaResponse(sheetTitles) {
  return new Response(JSON.stringify({ sheets: sheetTitles.map((title, i) => ({ properties: { sheetId: i, title } })) }));
}

function stubAgreeExitFetch({ member, personalRows = personalTabRows() }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
      if (u.includes("V50")) return Promise.resolve(dataSheetResponse([member]));
      if (u.includes("values:batchGet")) {
        return Promise.resolve(new Response(JSON.stringify({ valueRanges: [[], []] })));
      }
      if (u.includes("U42")) {
        return Promise.resolve(new Response(JSON.stringify({ values: personalRows })));
      }
      if (u.includes("F4%3AM4") || u.includes("F4:M4")) {
        return Promise.resolve(new Response(JSON.stringify({ values: [] })));
      }
      if (/F\d+%3AM\d+|F\d+:M\d+/.test(u)) {
        return Promise.resolve(new Response(JSON.stringify({ values: [[]] })));
      }
      if (u.includes("D25")) {
        return Promise.resolve(new Response(JSON.stringify({ values: [["1"]] })));
      }
      if (u.includes("A4%3AL18") || u.includes("A4:L18")) {
        return Promise.resolve(new Response(JSON.stringify({ values: [] })));
      }
      if (u.includes("D23%3AD24") || u.includes("D23:D24")) {
        return Promise.resolve(new Response(JSON.stringify({ values: [["0"], ["0"]] })));
      }
      if (u.includes("fields=sheets.properties")) {
        return Promise.resolve(metaResponse(["1", "template"]));
      }
      if (u.includes("집계!P6")) {
        return Promise.resolve(new Response(JSON.stringify({ values: [] })));
      }
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

    stubAgreeExitFetch({ member: { number: 5, name: "가", email: MEMBER_EMAIL } });
    const req = makeRequest("https://worker/exit-request/agree", { token, method: "POST" });
    const res = await handleAgreeExitRequest(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.agreedAt).toBe("number");
  });

  it("벌금 미납분이 있으면 400을 반환하고 동의가 기록되지 않는다", async () => {
    stubOauthFetch();
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-req-agree-fine-unpaid" });
    const token = await makeMemberToken({ memberNumber: "6" });
    const setReq = makeRequest("https://worker/exit-request", {
      token,
      method: "POST",
      body: { exitDate: "2020-01-01" },
    });
    await handleSetExitRequest(setReq, testEnv, "https://example.com");

    const personalRows = personalTabRows();
    personalRows[32] = ["", "", 1]; // ROW_FINE_NO_STATUS col2=1(미납)
    stubAgreeExitFetch({ member: { number: 6, name: "나", email: MEMBER_EMAIL }, personalRows });
    const req = makeRequest("https://worker/exit-request/agree", { token, method: "POST" });
    const res = await handleAgreeExitRequest(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);

    const id = testEnv.LEAVE_QUEUE_DO.idFromName("leave-queue");
    const stub = testEnv.LEAVE_QUEUE_DO.get(id);
    const getRes = await stub.fetch("https://do/exit/get?memberNumber=6");
    const { entry } = await getRes.json();
    expect(entry.agreedAt).toBeNull();
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
