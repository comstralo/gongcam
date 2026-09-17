// 랭킹/로스터/정산 클러스터(handleRosterStatus, handleAdminPrizeSettle)
// 통합 테스트. buildRosterStatus 전체를 실제로 태우는 mock 시나리오라
// test/personal-status.test.js(19차 이전엔 이 파일이 handleRosterStatus/
// handleAdminPrizeSettle도 함께 다뤘다)의 stubPersonalStatusFetch 패턴을
// 그대로 재사용한다. 🔧 [구조 개선 19차, 2026-09-17] 이 두 핸들러가
// personal-status.js에서 src/roster-status.js로 옮겨가면서 이 파일도
// 함께 분리했다(docs/TESTING.md 참고).
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../src/index.js";
import { handleRosterStatus, handleAdminPrizeSettle } from "../src/roster-status.js";
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
    GOOGLE_SHEET_FILE_ID: "live-roster-status-file",
    GOOGLE_SERVICE_ACCOUNT_JSON: TEST_SERVICE_ACCOUNT_JSON,
    ...overrides,
  };
}

async function makeAdminToken() {
  return signSession({ email: ADMIN_EMAIL, exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
}

async function makeMemberToken() {
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

function stubRosterStatusFetch({ members, aggregateRows = ["0", "0"], prizeSettle = "" }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
      if (u.includes("V50")) return Promise.resolve(dataSheetResponse(members));
      if (u.includes("values:batchGet")) {
        return Promise.resolve(new Response(JSON.stringify({ valueRanges: [[], [[prizeSettle]]] })));
      }
      if (u.includes("D25") && u.includes("UNFORMATTED_VALUE")) {
        return Promise.resolve(new Response(JSON.stringify({ values: [["1"]] })));
      }
      if (u.includes("D25")) {
        return Promise.resolve(new Response(JSON.stringify({ values: [["1"]] })));
      }
      if (u.includes("A4%3AL18") || u.includes("A4:L18")) {
        return Promise.resolve(new Response(JSON.stringify({ values: [] })));
      }
      if (u.includes("F4%3AM4") || u.includes("F4:M4")) {
        return Promise.resolve(new Response(JSON.stringify({ values: [] })));
      }
      throw new Error("unexpected fetch: " + u);
    })
  );
}

describe("handleRosterStatus", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/roster-status");

    const res = await handleRosterStatus(req, testEnv, "https://example.com", new URL("https://worker/roster-status"));
    expect(res.status).toBe(401);
  });

  it("로그인한 회원이면 200과 랭킹 정보를 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "roster-status-200" });
    const token = await makeMemberToken();
    stubRosterStatusFetch({ members: [{ number: 1, name: "가", email: "member@test.com" }] });
    const req = makeRequest("https://worker/roster-status", { token });

    const res = await handleRosterStatus(req, testEnv, "https://example.com", new URL("https://worker/roster-status"));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(Array.isArray(body.members)).toBe(true);
  });
});

describe("handleAdminPrizeSettle", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const req = makeRequest("https://worker/admin/prize-settle", { token, method: "POST", body: { cycle: "x" } });

    const res = await handleAdminPrizeSettle(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("cycle 파라미터가 없으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeAdminToken();
    const req = makeRequest("https://worker/admin/prize-settle", { token, method: "POST", body: {} });

    const res = await handleAdminPrizeSettle(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });
});
