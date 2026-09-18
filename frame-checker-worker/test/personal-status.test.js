// 개인 대시보드 클러스터(handleStatus, handleAdminMemberStatus) 통합
// 테스트. buildPersonalStatus 전체를 실제로 태우는 무거운 mock
// 시나리오라 test/exit-confirm.test.js의 stubForcedExitFetch 패턴을
// 그대로 재사용한다. LeaveQueue DO(listQueuedReasonLeaveDays/exit/get)
// 는 실제 workerd DO를 그대로 쓴다(mock 불필요, 기본값이 빈 배열/null
// 이라 안전). 🔧 [구조 개선 19차, 2026-09-17] handleRosterStatus/
// handleAdminPrizeSettle은 src/roster-status.js로 옮겨가면서
// test/roster-status.test.js로 함께 분리했다(docs/TESTING.md 참고).
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../src/index.js";
import { handleStatus, handleAdminMemberStatus } from "../src/personal-status.js";
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
    GOOGLE_SHEET_FILE_ID: "live-personal-status-file",
    GOOGLE_SERVICE_ACCOUNT_JSON: TEST_SERVICE_ACCOUNT_JSON,
    ...overrides,
  };
}

async function makeAdminToken() {
  return signSession({ email: ADMIN_EMAIL, exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
}

async function makeMemberToken(overrides = {}) {
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

// 개인 탭 A1:U42 — buildPersonalStatus가 읽는 최소 필드만 채운다.
// 참여상태(L3)="스터디원", 가입일 D+45(30일 이상), 벌금/재납 미납 신호 없음,
// 페널티 슬롯 전부 0.
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

function stubPersonalStatusFetch({ members, personalRows, aggregateRows = ["0", "0"], prizeSettle = "" }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
      if (u.includes("V50")) return Promise.resolve(dataSheetResponse(members));
      if (u.includes("values:batchGet")) {
        return Promise.resolve(new Response(JSON.stringify({ valueRanges: [[], [[prizeSettle]]] })));
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
      if (u.includes("D25") && u.includes("UNFORMATTED_VALUE")) {
        return Promise.resolve(new Response(JSON.stringify({ values: [["1"]] })));
      }
      if (u.includes("D25")) {
        return Promise.resolve(new Response(JSON.stringify({ values: [["1"]] })));
      }
      if (u.includes("A4%3AL18") || u.includes("A4:L18")) {
        return Promise.resolve(new Response(JSON.stringify({ values: [] })));
      }
      if (u.includes("D23%3AD24") || u.includes("D23:D24")) {
        return Promise.resolve(new Response(JSON.stringify({ values: [[aggregateRows[0]], [aggregateRows[1]]] })));
      }
      if (u.includes("fields=sheets.properties")) {
        return Promise.resolve(metaResponse(["1", "template"]));
      }
      throw new Error("unexpected fetch: " + u);
    })
  );
}

describe("handleStatus", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/status");

    const res = await handleStatus(req, testEnv, "https://example.com", new URL("https://worker/status"));
    expect(res.status).toBe(401);
  });

  it("명단에 없는 이메일이면 403을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "personal-status-403" });
    const token = await makeMemberToken();
    stubPersonalStatusFetch({ members: [{ number: 1, name: "가", email: "someone-else@test.com" }] });
    const req = makeRequest("https://worker/status", { token });

    const res = await handleStatus(req, testEnv, "https://example.com", new URL("https://worker/status"));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(403);
  });

  it("정상 회원이면 200과 개인 대시보드 상태를 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "personal-status-200" });
    const token = await makeMemberToken();
    stubPersonalStatusFetch({
      members: [{ number: 1, name: "가", email: "member@test.com" }],
      personalRows: personalTabRows(),
    });
    const req = makeRequest("https://worker/status", { token });

    const res = await handleStatus(req, testEnv, "https://example.com", new URL("https://worker/status"));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(Array.isArray(body.days)).toBe(true);
    expect(body.days.length).toBe(7);
  });

  // 🔧 [사용자 지시] "관리자 본인의 화면에서도 뜨도록" — 관리자 전용
  // "사이클 범위 선택" 드롭다운(AdminCycleRangeSelect)이 본인 조회
  // (/status)에도 cycleAny를 붙일 수 있게 됐다. 일반 회원이 붙이면
  // 조용히 무시되고(cycle과 동일하게 처리), 관리자가 붙이면 현재
  // 사이클 제약 없이 그 백업 파일을 대상으로 조회해야 한다.
  it("관리자가 cycleAny를 붙이면 현재 사이클 밖의 과거 백업도 대상으로 조회한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "personal-status-cycleany-admin" });
    const token = await makeAdminToken();
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("drive/v3/files")) {
          return Promise.resolve(
            new Response(JSON.stringify({ files: [{ id: "old-backup-file", name: "공부합시당 캠스터디 260817-260823" }] }))
          );
        }
        if (u.includes("V50")) return Promise.resolve(dataSheetResponse([{ number: 1, name: "가", email: ADMIN_EMAIL }]));
        if (u.includes("values:batchGet")) {
          return Promise.resolve(new Response(JSON.stringify({ valueRanges: [[], [[""]]] })));
        }
        if (u.includes("U42")) {
          return Promise.resolve(new Response(JSON.stringify({ values: personalTabRows() })));
        }
        if (u.includes("F4%3AM4") || u.includes("F4:M4")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [] })));
        }
        if (/F\d+%3AM\d+|F\d+:M\d+/.test(u)) {
          return Promise.resolve(new Response(JSON.stringify({ values: [[]] })));
        }
        if (u.includes("D25")) return Promise.resolve(new Response(JSON.stringify({ values: [["1"]] })));
        if (u.includes("A4%3AL18") || u.includes("A4:L18")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [] })));
        }
        if (u.includes("D23%3AD24") || u.includes("D23:D24")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [["0"], ["0"]] })));
        }
        if (u.includes("fields=sheets.properties")) return Promise.resolve(metaResponse(["1", "template"]));
        throw new Error("unexpected fetch: " + u);
      })
    );
    const req = makeRequest("https://worker/status?cycleAny=old-backup-file", { token });

    const res = await handleStatus(
      req,
      testEnv,
      "https://example.com",
      new URL("https://worker/status?cycleAny=old-backup-file")
    );
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
  });

  it("일반 회원이 cycleAny를 붙여도 무시되고 실시간 원본을 조회한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "personal-status-cycleany-member" });
    const token = await makeMemberToken();
    // drive/v3/files를 stub하지 않는다 — cycleAny가 무시된다면
    // resolveTargetFileIdForAnyBackup(=listBackupFiles 호출)이 아예
    // 실행되지 않아야 하므로, 호출되면 "unexpected fetch"로 실패한다.
    stubPersonalStatusFetch({
      members: [{ number: 1, name: "가", email: "member@test.com" }],
      personalRows: personalTabRows(),
    });
    const req = makeRequest("https://worker/status?cycleAny=old-backup-file", { token });

    const res = await handleStatus(
      req,
      testEnv,
      "https://example.com",
      new URL("https://worker/status?cycleAny=old-backup-file")
    );
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
  });
});

describe("handleAdminMemberStatus", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const req = makeRequest("https://worker/admin/member-status/1", { token });

    const res = await handleAdminMemberStatus(req, testEnv, "https://example.com", "1", new URL("https://worker/x"));
    expect(res.status).toBe(403);
  });

  it("존재하지 않는 회원번호면 404를 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "personal-status-admin-404" });
    const token = await makeAdminToken();
    stubPersonalStatusFetch({ members: [{ number: 1, name: "가", email: "a@b.com" }] });
    const req = makeRequest("https://worker/admin/member-status/9", { token });

    const res = await handleAdminMemberStatus(req, testEnv, "https://example.com", "9", new URL("https://worker/x"));
    expect(res.status).toBe(404);
  });

  it("정상 회원번호면 200과 상태를 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "personal-status-admin-200" });
    const token = await makeAdminToken();
    stubPersonalStatusFetch({
      members: [{ number: 1, name: "가", email: "a@b.com" }],
      personalRows: personalTabRows(),
    });
    const req = makeRequest("https://worker/admin/member-status/1", { token });

    const res = await handleAdminMemberStatus(req, testEnv, "https://example.com", "1", new URL("https://worker/x"));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(Array.isArray(body.days)).toBe(true);
  });

  it("퇴실자 접두사(exited:)면 백업 탭 스냅샷을 조회한다 — 백업 탭이 없으면 404", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "personal-status-admin-exited-404" });
    const token = await makeAdminToken();
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        throw new Error("unexpected fetch: " + u);
      })
    );
    const req = makeRequest("https://worker/admin/member-status/exited:가 (퇴실)", { token });

    const res = await handleAdminMemberStatus(
      req,
      testEnv,
      "https://example.com",
      "exited:가 (퇴실)",
      new URL("https://worker/x")
    );
    expect(res.status).toBe(404);
  });
});
