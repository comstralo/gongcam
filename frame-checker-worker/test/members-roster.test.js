// handleAdminMembersRoster("스터디원 목록" 상세 패널) 통합 테스트.
// listActiveMembersWithExitInfo(exit.js)가 buildPersonalStatus급 mock을
// 요구해 test/exit-confirm.test.js의 stubForcedExitFetch 패턴을 재사용한다.
// 🔧 [구조 개선 16차] 이 핸들러는 원래 loadNotifyPrefs/getPushDeviceIndex
// (notify.js)가 index.js에 import조차 되어 있지 않아 실제로 호출하면
// ReferenceError로 500이 나는 프로덕션 버그가 있었다 — 정상 200 응답을
// 검증하는 테스트가 이 버그의 회귀를 막는 핵심 목적이다.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../src/index.js";
import { handleAdminMembersRoster } from "../src/members.js";
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
    GOOGLE_SHEET_FILE_ID: "live-members-roster-file",
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

function makeRequest(url, { token, method = "GET" } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(url, { method, headers });
}

function dataSheetResponse(members) {
  const rows = [["헤더", "번호", "이름", "이메일"]];
  for (const m of members) rows.push(["", String(m.number), m.name, m.email || ""]);
  return new Response(JSON.stringify({ values: rows }));
}

// 개인 탭 A1:U42 — buildPersonalStatus/getAllExitRelevantStatus가 읽는
// 최소 필드만 채운다(test/exit-confirm.test.js/test/personal-status.test.js
// 와 동일한 fixture).
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

function stubMembersRosterFetch({ members, personalRows, aggregateRows = ["0", "0"] }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
      if (u.includes("V50")) return Promise.resolve(dataSheetResponse(members));
      if (u.includes("values:batchGet")) {
        // getSharedMemberRows(getAllExitRelevantStatus가 씀) — 회원별
        // "{번호}!A1:U41" 범위를 한 번에 조회한다. personalRows를 그대로
        // 각 회원의 valueRanges 항목으로 채운다.
        if (u.includes("A1%3AU")) {
          return Promise.resolve(
            new Response(JSON.stringify({ valueRanges: members.map(() => ({ values: personalRows })) }))
          );
        }
        // handleAdminMembersRoster 자신의 O3/I2(목표시간/가입일) batchGet.
        if (u.includes("O3") || u.includes("I2")) {
          const memberCount = members.length;
          const valueRanges = Array.from({ length: memberCount * 2 }, () => []);
          return Promise.resolve(new Response(JSON.stringify({ valueRanges })));
        }
        // buildRosterStatus류의 batchGet(D20:D24, P6) — 이 테스트에서는
        // 사용되지 않지만 폴백으로 남겨둔다.
        return Promise.resolve(new Response(JSON.stringify({ valueRanges: [[], []] })));
      }
      if (u.includes("U42")) {
        return Promise.resolve(new Response(JSON.stringify({ values: personalRows })));
      }
      // getPenaltySlotNotesGrid(getAllExitRelevantStatus가 씀) — 페널티
      // 슬롯 주석(F4:M18)만 rowData.values.note 형태로 조회한다.
      if (u.includes("fields=sheets.data.rowData")) {
        return Promise.resolve(new Response(JSON.stringify({ sheets: [{ data: [{ rowData: [] }] }] })));
      }
      // 🔧 getAllExitRelevantStatus의 데이터!F4:M18(plain getSheetValues) —
      // 회원별 송출P/주간P 슬롯 원본. 빈 값(전부 0)으로 둔다.
      if (u.includes("F4%3AM18") || u.includes("F4:M18")) {
        return Promise.resolve(new Response(JSON.stringify({ values: [] })));
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

describe("handleAdminMembersRoster", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeNonAdminToken();
    const req = makeRequest("https://worker/admin/members/roster", { token });

    const res = await handleAdminMembersRoster(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("정상 조회면 200과 회원별 상세(알림 설정 포함)를 반환한다 — loadNotifyPrefs/getPushDeviceIndex ReferenceError 회귀 방지", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "members-roster-200" });
    const token = await makeAdminToken();
    stubMembersRosterFetch({
      members: [{ number: 1, name: "가", email: "a@test.com" }],
      personalRows: personalTabRows(),
    });
    const req = makeRequest("https://worker/admin/members/roster", { token });

    const res = await handleAdminMembersRoster(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(Array.isArray(body.members)).toBe(true);
    expect(body.members.length).toBe(1);
    const member = body.members[0];
    expect(member.number).toBe("1");
    expect(member.name).toBe("가");
    expect(member.pushSubscribed).toBe(false);
    expect(member.notifyPrefs).toBeTruthy();
    expect(body.notifyCategories).toBeTruthy();
    expect(body.spreadsheetId).toBe("members-roster-200");
  });
});
