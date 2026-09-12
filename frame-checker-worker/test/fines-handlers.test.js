// 벌금/납부 처리 핸들러 통합 테스트 — fetch mock + signSession으로 만든
// 실제 유효 토큰을 조합해 requireAdmin 인증 경로까지 함께 검증한다.
// 라우팅 계층을 거치지 않고 핸들러 함수를 직접 호출한다(기존 패턴과 동일).
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../src/index.js";
import {
  handleAdminFineStatus,
  handleAdminFinesExempt,
  handleAdminFinesPaid,
  handleAdminFinesUnpaid,
} from "../src/fines.js";
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
    GOOGLE_SHEET_FILE_ID: "live-fine-file",
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
  for (const m of members) rows.push(["", String(m.number), m.name, `${m.email},gooroomee${m.number}`]);
  return new Response(JSON.stringify({ values: rows }));
}

function batchGetPaymentResponse(memberPaymentRows) {
  const valueRanges = memberPaymentRows.map((paymentRow) => {
    const rows = [];
    rows[31] = paymentRow;
    return { values: rows };
  });
  return new Response(JSON.stringify({ valueRanges }));
}

function stubReadFetch(dataMembers, memberPaymentRows) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com")) {
        return Promise.resolve(oauthTokenResponse());
      }
      if (u.includes(":batchGet")) {
        return Promise.resolve(batchGetPaymentResponse(memberPaymentRows));
      }
      if (u.includes("V50")) {
        return Promise.resolve(dataSheetResponse(dataMembers));
      }
      if (u.includes("D22")) {
        return Promise.resolve(new Response(JSON.stringify({ values: [["5000"]] })));
      }
      throw new Error("unexpected fetch: " + u);
    })
  );
}

describe("handleAdminFinesUnpaid", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeNonAdminToken();
    const req = makeRequest("https://worker/admin/fines/unpaid", { token });

    const res = await handleAdminFinesUnpaid(req, testEnv, "https://example.com", null);
    expect(res.status).toBe(403);
  });

  it("인증 헤더가 없으면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/admin/fines/unpaid");

    const res = await handleAdminFinesUnpaid(req, testEnv, "https://example.com", null);
    expect(res.status).toBe(403);
  });

  it("관리자면 미납 목록을 정상 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "handler-fine-unpaid" });
    const token = await makeAdminToken();
    stubReadFetch(
      [{ number: 1, name: "가", email: "a@b.com" }],
      [{ 2: "미납" }]
    );
    const req = makeRequest("https://worker/admin/fines/unpaid", { token });
    const url = new URL("https://worker/admin/fines/unpaid");

    const res = await handleAdminFinesUnpaid(req, testEnv, "https://example.com", url);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.unpaid).toEqual([{ number: "1", name: "가", day: "월" }]);
  });
});

describe("handleAdminFinesPaid", () => {
  it("관리자면 납부 목록과 총액을 함께 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "handler-fine-paid" });
    const token = await makeAdminToken();
    stubReadFetch(
      [{ number: 1, name: "가", email: "a@b.com" }],
      [{ 2: "납부" }]
    );
    const req = makeRequest("https://worker/admin/fines/paid", { token });
    const url = new URL("https://worker/admin/fines/paid");

    const res = await handleAdminFinesPaid(req, testEnv, "https://example.com", url);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.paid).toEqual([{ number: "1", name: "가", day: "월" }]);
    expect(body.totalAmount).toBe(5000);
  });
});

describe("handleAdminFinesExempt", () => {
  it("관리자면 면제 목록을 정상 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "handler-fine-exempt" });
    const token = await makeAdminToken();
    stubReadFetch(
      [{ number: 1, name: "가", email: "a@b.com" }],
      [{ 2: "면제" }]
    );
    const req = makeRequest("https://worker/admin/fines/exempt", { token });
    const url = new URL("https://worker/admin/fines/exempt");

    const res = await handleAdminFinesExempt(req, testEnv, "https://example.com", url);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exempt).toEqual([{ number: "1", name: "가", day: "월" }]);
  });
});

describe("handleAdminFineStatus", () => {
  function stubWriteFetch() {
    const batchUpdateCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url, init) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) {
          return Promise.resolve(oauthTokenResponse());
        }
        if (u.includes(":batchUpdate")) {
          batchUpdateCalls.push(JSON.parse(init.body));
          return Promise.resolve(new Response(JSON.stringify({ ok: true })));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );
    return batchUpdateCalls;
  }

  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeNonAdminToken();
    const req = makeRequest("https://worker/admin/fines/status", {
      token,
      method: "POST",
      body: { number: "1", day: "월", status: "납부" },
    });

    const res = await handleAdminFineStatus(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("회원번호가 범위를 벗어나면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeAdminToken();
    const req = makeRequest("https://worker/admin/fines/status", {
      token,
      method: "POST",
      body: { number: "16", day: "월", status: "납부" },
    });

    const res = await handleAdminFineStatus(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("요일이 올바르지 않으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeAdminToken();
    const req = makeRequest("https://worker/admin/fines/status", {
      token,
      method: "POST",
      body: { number: "1", day: "존재안함", status: "납부" },
    });

    const res = await handleAdminFineStatus(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("상태값이 미납/납부/면제가 아니면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeAdminToken();
    const req = makeRequest("https://worker/admin/fines/status", {
      token,
      method: "POST",
      body: { number: "1", day: "월", status: "알수없음" },
    });

    const res = await handleAdminFineStatus(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("유효한 요청이면 정확한 range로 시트에 쓰고 200을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeAdminToken();
    const batchUpdateCalls = stubWriteFetch();
    const req = makeRequest("https://worker/admin/fines/status", {
      token,
      method: "POST",
      body: { number: "3", day: "수", status: "납부" },
    });

    const res = await handleAdminFineStatus(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toEqual({ ok: true, number: "3", day: "수", status: "납부" });

    expect(batchUpdateCalls).toHaveLength(1);
    // 수요일(STATUS_DAY_COLS[2]=8 -> "I"열), ROW_PAYMENT_CHECK(31, 0-idx) + 1 = 32행.
    expect(batchUpdateCalls[0]).toEqual({
      valueInputOption: "USER_ENTERED",
      data: [{ range: "3!I32", values: [["납부"]] }],
    });
  });
});
