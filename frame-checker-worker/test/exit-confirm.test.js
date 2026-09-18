// 퇴실 처리 확정 경로(handleAdminExitPreview/handleAdminExitConfirm) 통합
// 테스트 — buildPersonalStatus 전체를 실제로 태우는 가장 무거운 mock
// 시나리오다. kind: "forced"로 고정해 resolveExitSourceFileId가 추가
// fetch 없이 즉시 반환하도록 해서 mock 표면을 최소화한다(cycle.js 참고).
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../src/index.js";
import { handleAdminExitPreview, handleAdminExitConfirm } from "../src/exit-confirm.js";
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
    GOOGLE_SHEET_FILE_ID: "live-exit-confirm-file",
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
  for (const m of members) rows.push(["", String(m.number), m.name, m.email || ""]);
  return new Response(JSON.stringify({ values: rows }));
}

// 개인 탭 A1:U42 — buildPersonalStatus/depositRefundBreakdown이 읽는
// 최소 필드만 채운다. 참여상태(L3)="스터디원", 가입일 D+45(30일 이상),
// 벌금/재납 미납 신호 없음, 페널티 슬롯 전부 0 → forced 조건에 걸리는
// 유일한 사유가 "페널티 누적 2회 이상"이 되도록 나머지는 깨끗하게 둔다.
function personalTabRows({ partiStatus = "스터디원", dday = "D+45" } = {}) {
  const rows = Array.from({ length: 42 }, () => []);
  rows[2] = ["", "", "", "", "", "", "", "", dday, "", "", "스터디원"]; // row 2: I=dday(8), L=partiStatus(11)
  rows[2][11] = partiStatus;
  rows[2][17] = ""; // R3: 예치금 재납 상태(미납/납부 아니면 해당없음)
  rows[31] = ["", "", ""]; // ROW_PAYMENT_CHECK(31) — 미납 요일 없음
  rows[32] = ["", "", 0]; // ROW_FINE_NO_STATUS(32), col2=0(미납 아님)
  return rows;
}

function metaResponse(sheetTitles) {
  return new Response(JSON.stringify({ sheets: sheetTitles.map((title, i) => ({ properties: { sheetId: i, title } })) }));
}

function stubForcedExitFetch({ fileId, members, personalRows, aggregateRows = ["0", "0"] }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
      if (u.includes("V50")) return Promise.resolve(dataSheetResponse(members));
      if (u.includes("values:batchGet")) {
        // buildRosterStatus의 [집계!D20:D24, 집계!P6] batchGet.
        return Promise.resolve(new Response(JSON.stringify({ valueRanges: [[], []] })));
      }
      if (u.includes("U42")) {
        return Promise.resolve(new Response(JSON.stringify({ values: personalRows })));
      }
      if (u.includes("F4%3AM4") || u.includes("F4:M4")) {
        return Promise.resolve(new Response(JSON.stringify({ values: [] })));
      }
      if (/F\d+%3AM\d+|F\d+:M\d+/.test(u)) {
        // _computeOutputPenSlots — 슬롯 전부 0(비어있음)이라 note 재조회는 생략된다.
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
        // buildPersonalStatus -> buildDepositAgainSplit(재납 이력 탭 탐색) — 없음.
        return Promise.resolve(metaResponse(["1", "template"]));
      }
      throw new Error("unexpected fetch: " + u);
    })
  );
}

describe("handleAdminExitPreview", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeNonAdminToken();
    const req = makeRequest("https://worker/admin/exit/preview", {
      token,
      method: "POST",
      body: { number: "1", kind: "forced" },
    });

    const res = await handleAdminExitPreview(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("회원번호 또는 처리 유형이 올바르지 않으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeAdminToken();
    const req = makeRequest("https://worker/admin/exit/preview", {
      token,
      method: "POST",
      body: { number: "1", kind: "not-a-kind" },
    });

    const res = await handleAdminExitPreview(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("존재하지 않는 회원번호면 404를 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-confirm-preview-404" });
    const token = await makeAdminToken();
    stubForcedExitFetch({ members: [{ number: 1, name: "가", email: "a@b.com" }], personalRows: personalTabRows() });
    const req = makeRequest("https://worker/admin/exit/preview", {
      token,
      method: "POST",
      body: { number: "9", kind: "forced" },
    });

    const res = await handleAdminExitPreview(req, testEnv, "https://example.com");
    expect(res.status).toBe(404);
  });

  it("정산 퇴실 대상(가입 30일 이상, 페널티 없음)이면 100% 반환으로 계산된다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-confirm-preview-ok" });
    const token = await makeAdminToken();
    stubForcedExitFetch({
      members: [{ number: 1, name: "가", email: "a@b.com" }],
      personalRows: personalTabRows(),
    });
    const req = makeRequest("https://worker/admin/exit/preview", {
      token,
      method: "POST",
      body: { number: "1", kind: "settle" },
    });

    const res = await handleAdminExitPreview(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.discountRatio).toBe(0);
    expect(body.refundAmount).toBe(10000);
    expect(body.heldAmount).toBe(0);
  });
});

describe("handleAdminExitConfirm", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeNonAdminToken();
    const req = makeRequest("https://worker/admin/exit/confirm", {
      token,
      method: "POST",
      body: { number: "1", kind: "settle" },
    });

    const res = await handleAdminExitConfirm(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("정산 퇴실 신청이 없으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-confirm-confirm-noreq" });
    const token = await makeAdminToken();
    stubForcedExitFetch({
      members: [{ number: 1, name: "가", email: "a@b.com" }],
      personalRows: personalTabRows(),
    });
    const req = makeRequest("https://worker/admin/exit/confirm", {
      token,
      method: "POST",
      body: { number: "1", kind: "settle" },
    });

    const res = await handleAdminExitConfirm(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("직권 퇴실은 사유 없이 확정할 수 없다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-confirm-confirm-noreason" });
    const token = await makeAdminToken();
    stubForcedExitFetch({
      members: [{ number: 1, name: "가", email: "a@b.com" }],
      personalRows: personalTabRows(),
    });
    const req = makeRequest("https://worker/admin/exit/confirm", {
      token,
      method: "POST",
      body: { number: "1", kind: "admin_forced", forcedReason: "" },
    });

    const res = await handleAdminExitConfirm(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("유효한 강제퇴실 확정이면 시트를 갱신하고 200을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-confirm-confirm-ok" });
    const token = await makeAdminToken();
    const rows = personalTabRows();
    // 페널티 4차(I열, idx3)/6차(K열, idx5)에 현재 사이클(1)을 채워 강제퇴실
    // 조건("페널티 누적 2회 이상")을 충족시킨다 — countCurrentCyclePen 참고.
    const writeCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url, init) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("V50")) return Promise.resolve(dataSheetResponse([{ number: 1, name: "가", email: "a@b.com" }]));
        if (u.includes("values:batchGet")) {
          return Promise.resolve(new Response(JSON.stringify({ valueRanges: [[], []] })));
        }
        if (u.includes("U42")) return Promise.resolve(new Response(JSON.stringify({ values: rows })));
        // _computeOutputPenSlots는 시트명을 작은따옴표(')로 감싸 조회한다
        // ('데이터'!F4:M4 — encodeURIComponent는 '를 그대로 둔다) — 따옴표
        // 없는 _computeRosterStatus의 데이터!F4:M4(스터디장 슬롯)와 URL이
        // 겹치므로(둘 다 회원 1번 = 4행) 이 표식으로 구분한다.
        if (u.includes("'") && /F\d+%3AM\d+/.test(u)) {
          return Promise.resolve(new Response(JSON.stringify({ values: [[0, 0, 0, "1", 0, "1", 0, 0]] })));
        }
        if (u.includes("F4%3AM4") || u.includes("F4:M4")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [] })));
        }
        if (u.includes("D25")) return Promise.resolve(new Response(JSON.stringify({ values: [["1"]] })));
        if (u.includes("A4%3AL18") || u.includes("A4:L18")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [] })));
        }
        if (u.includes("D23%3AD24") || u.includes("D23:D24")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [["0"], ["0"]] })));
        }
        if (u.includes("fields=sheets.properties")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                sheets: [
                  { properties: { sheetId: 1, title: "1" } },
                  { properties: { sheetId: 99, title: "template" } },
                ],
              })
            )
          );
        }
        if (u.includes(":copyTo")) return Promise.resolve(new Response(JSON.stringify({ sheetId: 555 })));
        if (u.includes("fields=sheets(properties.sheetId")) {
          return Promise.resolve(new Response(JSON.stringify({ sheets: [{ properties: { sheetId: 555 }, protectedRanges: [] }] })));
        }
        if (u.includes("/permissions") && !init) {
          return Promise.resolve(new Response(JSON.stringify({ permissions: [] })));
        }
        if (/:batchUpdate$/.test(u)) {
          return Promise.resolve(new Response(JSON.stringify({ ok: true })));
        }
        if (u.includes("values:batchUpdate")) {
          writeCalls.push(JSON.parse(init.body));
          return Promise.resolve(new Response(JSON.stringify({ ok: true })));
        }
        if (u.includes("D4%3AE4") || u.includes("D4:E4") || u.includes("B4%3AB2000") || u.includes("B4:B2000")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [] })));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );

    const req = makeRequest("https://worker/admin/exit/confirm", {
      token,
      method: "POST",
      body: { number: "1", kind: "forced" },
    });

    const res = await handleAdminExitConfirm(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.number).toBe("1");
  });

  // 🔧 [사용자 지시] "'참여 스터디원 목록'의 상태 정보를 '퇴실 스터디원
  // 목록'에도" — 확정 처리 시점에 examKind(데이터 탭 E열)/sheetGid(백업
  // 탭 자체의 gid)/backupFileId(백업 탭이 생성된 spreadsheetId)가
  // MemberSettingsDO에 실제로 저장되는지 검증한다. 위 테스트와 거의
  // 동일한 mock이지만 D:E열에 실제 값을 채워 examKind가 보존되는지까지
  // 확인한다.
  it("확정 처리 시 examKind/sheetGid/backupFileId를 MemberSettingsDO에 저장한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-confirm-confirm-status-info" });
    const token = await makeAdminToken();
    const rows = personalTabRows();
    vi.stubGlobal(
      "fetch",
      vi.fn((url, init) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("V50")) return Promise.resolve(dataSheetResponse([{ number: 1, name: "가", email: "a@b.com" }]));
        if (u.includes("values:batchGet")) {
          return Promise.resolve(new Response(JSON.stringify({ valueRanges: [[], []] })));
        }
        if (u.includes("U42")) return Promise.resolve(new Response(JSON.stringify({ values: rows })));
        if (u.includes("'") && /F\d+%3AM\d+/.test(u)) {
          return Promise.resolve(new Response(JSON.stringify({ values: [[0, 0, 0, "1", 0, "1", 0, 0]] })));
        }
        if (u.includes("F4%3AM4") || u.includes("F4:M4")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [] })));
        }
        if (u.includes("D25")) return Promise.resolve(new Response(JSON.stringify({ values: [["1"]] })));
        if (u.includes("A4%3AL18") || u.includes("A4:L18")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [] })));
        }
        if (u.includes("D23%3AD24") || u.includes("D23:D24")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [["0"], ["0"]] })));
        }
        if (u.includes("fields=sheets.properties")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                sheets: [
                  { properties: { sheetId: 1, title: "1" } },
                  { properties: { sheetId: 99, title: "template" } },
                ],
              })
            )
          );
        }
        if (u.includes(":copyTo")) return Promise.resolve(new Response(JSON.stringify({ sheetId: 777 })));
        if (u.includes("fields=sheets(properties.sheetId")) {
          return Promise.resolve(new Response(JSON.stringify({ sheets: [{ properties: { sheetId: 777 }, protectedRanges: [] }] })));
        }
        if (u.includes("/permissions") && !init) {
          return Promise.resolve(new Response(JSON.stringify({ permissions: [] })));
        }
        if (/:batchUpdate$/.test(u)) {
          return Promise.resolve(new Response(JSON.stringify({ ok: true })));
        }
        if (u.includes("values:batchUpdate")) {
          return Promise.resolve(new Response(JSON.stringify({ ok: true })));
        }
        // D열(이메일)은 빈 값으로 둔다 — revokeSheetAccess(exit-confirm.js)가
        // email이 falsy면 즉시 return해 getAdminAccessToken(관리자 위임
        // OAuth, 이 테스트 스위트에서 별도로 mock하지 않는 경로)을 타지
        // 않는다. E열(준비중인시험)만 채워 examKind 캡처만 검증한다.
        if (u.includes("D4%3AE4") || u.includes("D4:E4")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [["", "9급 공무원"]] })));
        }
        if (u.includes("B4%3AB2000") || u.includes("B4:B2000")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [] })));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );

    const req = makeRequest("https://worker/admin/exit/confirm", {
      token,
      method: "POST",
      body: { number: "1", kind: "forced" },
    });

    const res = await handleAdminExitConfirm(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);

    const { getMemberSettingsStub } = await import("../src/index.js");
    const listRes = await getMemberSettingsStub(testEnv).fetch("https://do/exit/list");
    const { items } = await listRes.json();
    const saved = items["가 (퇴실)"];
    expect(saved).toBeTruthy();
    expect(saved.examKind).toBe("9급 공무원");
    expect(saved.sheetGid).toBe(777);
    // 이번 케이스는 지난 주 백업으로 넘어가지 않은 정상 흐름이라
    // backupFileId는 라이브 시트(fileId) 그대로여야 한다.
    expect(saved.backupFileId).toBe("exit-confirm-confirm-status-info");
    // 🔧 [사용자 지시] "'퇴실 예약일자', '최근 접속일자', '최근 접속 IP'도
    // 출력되도록" — 이 케이스는 신청도, 로그인 기록도 미리 심어두지 않았으므로
    // null/빈 값으로 안전하게 저장돼야 한다(신청 없이 처리 가능한 forced).
    expect(saved.exitRequestDate).toBeNull();
    expect(saved.lastLoginAt).toBeNull();
    expect(saved.lastLoginIp).toBe("");
  });

  it("확정 처리 전 신청/최근 접속 기록이 있으면 그 값을 그대로 캡처해 저장한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-confirm-confirm-request-login" });
    const token = await makeAdminToken();
    const rows = personalTabRows();

    // 확정 처리 전에 퇴실 신청(LeaveQueue DO)과 최근 접속 기록
    // (MemberSettingsDO)을 미리 심어둔다 — performExitReset이 회원번호
    // 슬롯을 초기화하고 do/exit/delete가 신청 기록을 지우기 전에, 이
    // 값들이 정확히 캡처되는지 검증한다.
    const { getLeaveQueueStub, getMemberSettingsStub } = await import("../src/index.js");
    await getLeaveQueueStub(testEnv).fetch("https://do/exit/put", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberNumber: "1", exitDate: "2026-08-20", ts: Date.now(), agreedAt: null }),
    });
    await getMemberSettingsStub(testEnv).fetch("https://do/last-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberNumber: "1", ts: 1755900000000, ip: "203.0.113.5" }),
    });

    vi.stubGlobal(
      "fetch",
      vi.fn((url, init) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("V50")) return Promise.resolve(dataSheetResponse([{ number: 1, name: "가", email: "a@b.com" }]));
        if (u.includes("values:batchGet")) {
          return Promise.resolve(new Response(JSON.stringify({ valueRanges: [[], []] })));
        }
        if (u.includes("U42")) return Promise.resolve(new Response(JSON.stringify({ values: rows })));
        if (u.includes("'") && /F\d+%3AM\d+/.test(u)) {
          return Promise.resolve(new Response(JSON.stringify({ values: [[0, 0, 0, "1", 0, "1", 0, 0]] })));
        }
        if (u.includes("F4%3AM4") || u.includes("F4:M4")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [] })));
        }
        if (u.includes("D25")) return Promise.resolve(new Response(JSON.stringify({ values: [["1"]] })));
        if (u.includes("A4%3AL18") || u.includes("A4:L18")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [] })));
        }
        if (u.includes("D23%3AD24") || u.includes("D23:D24")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [["0"], ["0"]] })));
        }
        if (u.includes("fields=sheets.properties")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                sheets: [
                  { properties: { sheetId: 1, title: "1" } },
                  { properties: { sheetId: 99, title: "template" } },
                ],
              })
            )
          );
        }
        if (u.includes(":copyTo")) return Promise.resolve(new Response(JSON.stringify({ sheetId: 888 })));
        if (u.includes("fields=sheets(properties.sheetId")) {
          return Promise.resolve(new Response(JSON.stringify({ sheets: [{ properties: { sheetId: 888 }, protectedRanges: [] }] })));
        }
        if (u.includes("/permissions") && !init) {
          return Promise.resolve(new Response(JSON.stringify({ permissions: [] })));
        }
        if (/:batchUpdate$/.test(u)) {
          return Promise.resolve(new Response(JSON.stringify({ ok: true })));
        }
        if (u.includes("values:batchUpdate")) {
          return Promise.resolve(new Response(JSON.stringify({ ok: true })));
        }
        if (u.includes("D4%3AE4") || u.includes("D4:E4")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [["", "세무사"]] })));
        }
        if (u.includes("B4%3AB2000") || u.includes("B4:B2000")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [] })));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );

    const req = makeRequest("https://worker/admin/exit/confirm", {
      token,
      method: "POST",
      body: { number: "1", kind: "forced" },
    });

    const res = await handleAdminExitConfirm(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);

    const listRes = await getMemberSettingsStub(testEnv).fetch("https://do/exit/list");
    const { items } = await listRes.json();
    const saved = items["가 (퇴실)"];
    expect(saved).toBeTruthy();
    expect(saved.exitRequestDate).toBe("2026-08-20");
    expect(saved.lastLoginAt).toBe(1755900000000);
    expect(saved.lastLoginIp).toBe("203.0.113.5");

    // 확정 처리가 끝나면 신청 기록은 삭제돼야 한다(기존 동작 회귀 확인).
    const exitGetRes = await getLeaveQueueStub(testEnv).fetch(
      "https://do/exit/get?memberNumber=1"
    );
    const { entry } = await exitGetRes.json();
    expect(entry).toBeNull();
  });
});
