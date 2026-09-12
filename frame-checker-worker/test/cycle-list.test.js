// 사이클 판정(hasUnpaidFineInCycle/hasForcedCandidateInCycle)과
// handleCycleList 통합 테스트 — 9차에서 index.js → cycle.js로 이동한
// 함수들이다. fetch mock만 필요(DO 의존 없음). fileId를 테스트 케이스마다
// 다르게 줘서 _cachedCompute 캐시 오염을 피한다(6~8차와 동일 원칙).
//
// 이 파일은 이동 작업 직전 발견한 실제 프로덕션 버그(CYCLE_MAX_LEN이
// index.js의 cycle.js import 목록에서 빠져 handleCycleList 호출 시
// ReferenceError로 500이 나던 문제, 이미 수정 완료)의 회귀 방지 역할도
// 겸한다 — "정상 200 응답 + maxWeeks 필드 존재" 검증이 그 수정을 검증한다.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../src/index.js";
import { hasUnpaidFineInCycle, hasForcedCandidateInCycle, handleCycleList } from "../src/cycle.js";
import { TEST_SERVICE_ACCOUNT_JSON, oauthTokenResponse } from "./helpers/service-account.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const TEST_SECRET = "test-session-secret";

function makeTestEnv(overrides = {}) {
  return {
    ...env,
    SESSION_SECRET: TEST_SECRET,
    GOOGLE_SHEET_FILE_ID: "live-cycle-file",
    GOOGLE_SERVICE_ACCOUNT_JSON: TEST_SERVICE_ACCOUNT_JSON,
    BACKUP_FOLDER_ID: "test-backup-folder",
    ...overrides,
  };
}

function makeRequest(url, { token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(url, { headers });
}

function dataSheetResponse(members) {
  const rows = [["헤더", "번호", "이름", "이메일"]];
  for (const m of members) rows.push(["", String(m.number), m.name, m.email || ""]);
  return new Response(JSON.stringify({ values: rows }));
}

function emptyBackupFolderResponse() {
  return new Response(JSON.stringify({ files: [] }));
}

// batchGet 응답 — 각 회원 탭의 A1:U41 범위. ROW_PAYMENT_CHECK(31행, 0-idx)
// 에 STATUS_DAY_COLS(2,5,8,11,14,17,20) 위치로 상태값을 채운다
// (fines-fetch.test.js와 동일 패턴).
function batchGetPaymentResponse(memberPaymentRows) {
  const valueRanges = memberPaymentRows.map((paymentRow) => {
    const rows = [];
    rows[31] = paymentRow;
    return { values: rows };
  });
  return new Response(JSON.stringify({ valueRanges }));
}

describe("hasUnpaidFineInCycle", () => {
  it("특정 회원이 미납 요일이 있으면 true를 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "cycle-unpaid-member-true" });
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("V50")) return Promise.resolve(dataSheetResponse([{ number: 1, name: "가", email: "a@b.com" }]));
        if (u.includes("values:batchGet")) {
          const paymentRow = [];
          paymentRow[2] = "미납"; // STATUS_DAY_COLS[0] = C열(월요일).
          return Promise.resolve(batchGetPaymentResponse([paymentRow]));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );

    const result = await hasUnpaidFineInCycle(testEnv, "token", "cycle-unpaid-member-true", "1");
    expect(result).toBe(true);
  });

  it("존재하지 않는 회원번호면 false를 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "cycle-unpaid-member-404" });
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("V50")) return Promise.resolve(dataSheetResponse([{ number: 1, name: "가", email: "a@b.com" }]));
        throw new Error("unexpected fetch: " + u);
      })
    );

    const result = await hasUnpaidFineInCycle(testEnv, "token", "cycle-unpaid-member-404", "9");
    expect(result).toBe(false);
  });

  it("memberNumber 없이 전체 기준이면 미납자 존재 여부를 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "cycle-unpaid-all" });
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("V50")) return Promise.resolve(dataSheetResponse([{ number: 1, name: "가", email: "a@b.com" }]));
        if (u.includes("values:batchGet")) {
          const paymentRow = [];
          paymentRow[2] = "미납";
          return Promise.resolve(batchGetPaymentResponse([paymentRow]));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );

    const result = await hasUnpaidFineInCycle(testEnv, "token", "cycle-unpaid-all", null);
    expect(result).toBe(true);
  });
});

describe("hasForcedCandidateInCycle", () => {
  it("전체 기준으로 강제퇴실 후보가 없으면 false를 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "cycle-forced-all-none" });
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("V50")) return Promise.resolve(dataSheetResponse([{ number: 1, name: "가", email: "a@b.com" }]));
        if (u.includes("values:batchGet")) {
          return Promise.resolve(new Response(JSON.stringify({ valueRanges: [] })));
        }
        if (u.includes("D25")) return Promise.resolve(new Response(JSON.stringify({ values: [["1"]] })));
        if (u.includes("F4%3AM18") || u.includes("F4:M18")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [] })));
        }
        if (u.includes("fields=sheets.data.rowData")) {
          return Promise.resolve(new Response(JSON.stringify({ sheets: [] })));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );

    const result = await hasForcedCandidateInCycle(testEnv, "token", "cycle-forced-all-none", null);
    expect(result).toBe(false);
  });
});

describe("handleCycleList", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/cycles");

    const res = await handleCycleList(req, testEnv, "https://example.com", null);
    expect(res.status).toBe(401);
  });

  it("로그인하면 200을 반환하고 maxWeeks/currentWeekNumber를 포함한다", async () => {
    // 🔧 [회귀 방지] CYCLE_MAX_LEN이 index.js의 cycle.js import에서 빠져
    // ReferenceError로 500이 나던 실제 버그가 있었다 — 이 테스트가 그
    // 수정을 검증한다.
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "cycle-list-ok" });
    const token = await signSession({ email: "member@test.com", exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("drive/v3/files")) return Promise.resolve(emptyBackupFolderResponse());
        if (u.includes("D25")) return Promise.resolve(new Response(JSON.stringify({ values: [["1"]] })));
        throw new Error("unexpected fetch: " + u);
      })
    );
    const req = makeRequest("https://worker/cycles", { token });

    const res = await handleCycleList(req, testEnv, "https://example.com", new URL("https://worker/cycles"));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.maxWeeks).toBe(3);
    expect(body.currentWeekNumber).toBe(1);
    expect(body.weeks).toEqual([]);
  });

  it("includeUnpaid/includeForced 파라미터가 없으면 currentHasUnpaid/currentHasForced 필드가 없다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "cycle-list-no-flags" });
    const token = await signSession({ email: "member@test.com", exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("drive/v3/files")) return Promise.resolve(emptyBackupFolderResponse());
        if (u.includes("D25")) return Promise.resolve(new Response(JSON.stringify({ values: [["1"]] })));
        throw new Error("unexpected fetch: " + u);
      })
    );
    const req = makeRequest("https://worker/cycles", { token });

    const res = await handleCycleList(req, testEnv, "https://example.com", new URL("https://worker/cycles"));
    const body = await res.json();
    expect(body.currentHasUnpaid).toBeUndefined();
    expect(body.currentHasForced).toBeUndefined();
  });

  it("includeUnpaid=1이면 currentHasUnpaid 필드를 포함한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "cycle-list-unpaid-flag" });
    const token = await signSession({ email: "member@test.com", exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("drive/v3/files")) return Promise.resolve(emptyBackupFolderResponse());
        if (u.includes("D25")) return Promise.resolve(new Response(JSON.stringify({ values: [["1"]] })));
        if (u.includes("V50")) return Promise.resolve(dataSheetResponse([]));
        throw new Error("unexpected fetch: " + u);
      })
    );
    const req = makeRequest("https://worker/cycles?includeUnpaid=1", { token });

    const res = await handleCycleList(
      req,
      testEnv,
      "https://example.com",
      new URL("https://worker/cycles?includeUnpaid=1")
    );
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(typeof body.currentHasUnpaid).toBe("boolean");
  });
});
