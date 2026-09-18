// 퇴실 신청/동의/취소, 도움봇 조회 통합 테스트 — LeaveQueue DO(실제
// workerd)와 fetch mock을 조합한다. 6~7차와 동일하게 fileId를 테스트
// 케이스마다 다르게 줘서 _cachedCompute 캐시 오염을 피한다.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession, weekOfForDate } from "../src/index.js";
import {
  handleSetExitRequest,
  handleAgreeExitRequest,
  handleCancelExitRequest,
  handleBotExitRequests,
  autoAgreeExpiredExitRequests,
} from "../src/exit-request.js";
import { TEST_SERVICE_ACCOUNT_JSON, oauthTokenResponse } from "./helpers/service-account.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

// exitDate가 이미 sheet_reset(그 주 다음 월요일 06:00 KST)을 넘겼으면
// handleAgreeExitRequest(exit-request.js)가 resolveExitSourceFileId를 통해
// 그 주의 백업 파일을 찾으려 한다(§버그 수정: 회원 동의 API도 확정 처리
// 경로와 동일하게 리셋 이후엔 원본이 아니라 백업을 봐야 한다) — Drive
// 파일 목록 조회에 그 주의 백업 파일을 하나 채워 넣는다. weekOfForDate로
// 실제 로직과 동일하게 계산해 테스트가 특정 날짜에 종속되지 않게 한다.
function driveBackupResponse(exitDate) {
  const weekOf = weekOfForDate(exitDate);
  const weekTo = String(Number(weekOf) + 6).padStart(6, "0");
  return new Response(
    JSON.stringify({ files: [{ id: `backup-${weekOf}`, name: `공부합시당 캠스터디 ${weekOf}-${weekTo}` }] })
  );
}

function stubAgreeExitFetch({ member, personalRows = personalTabRows(), exitDate }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
      if (u.includes("drive/v3/files")) return Promise.resolve(driveBackupResponse(exitDate));
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

  // 🔧 [사용자 지시] "마지막 참여일을 캘린더 2주 범위로만 선택 가능하도록"
  it("14일보다 먼 미래 날짜면 400을 반환한다", async () => {
    stubOauthFetch();
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-req-set-toofar" });
    const token = await makeMemberToken();
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 18));
    const req = makeRequest("https://worker/exit-request", {
      token,
      method: "POST",
      body: { exitDate: "2026-10-03" }, // 2026-09-18 기준 15일 뒤
    });

    const res = await handleSetExitRequest(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("이미 지난 날짜면 400을 반환한다", async () => {
    stubOauthFetch();
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-req-set-past" });
    const token = await makeMemberToken();
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 18));
    const req = makeRequest("https://worker/exit-request", {
      token,
      method: "POST",
      body: { exitDate: "2026-09-17" },
    });

    const res = await handleSetExitRequest(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("정확히 14일 뒤 날짜는 통과한다(경계 포함)", async () => {
    stubOauthFetch();
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-req-set-boundary" });
    const token = await makeMemberToken();
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 18));
    const req = makeRequest("https://worker/exit-request", {
      token,
      method: "POST",
      body: { exitDate: "2026-10-02" }, // 2026-09-18 + 14일
    });

    const res = await handleSetExitRequest(req, testEnv, "https://example.com");
    expect(res.status).toBe(200);
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
    // 🔧 [테스트 조정] handleSetExitRequest가 이제 신청 시점(서버 시각)
    // 기준 "오늘~14일 이내"만 exitDate로 허용한다(사용자 지시: "마지막
    // 참여일을 캘린더 2주 범위로만 선택 가능하도록") — 신청 시점을 그
    // exitDate의 10일 전으로 고정해, 신청 자체는 통과하되(2주 이내) 동의
    // 시점(신청 직후, 아직 exitDate 당일도 안 지남)에는 여전히 "집계가
    // 끝나지 않음"을 재현한다.
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 1));
    const setReq = makeRequest("https://worker/exit-request", {
      token,
      method: "POST",
      body: { exitDate: "2026-09-10" },
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
    const exitDate = "2026-08-17";
    // 🔧 [테스트 조정] 신청 시점(handleSetExitRequest)은 exitDate로부터
    // 2주 이내여야 통과한다(사용자 지시로 추가된 신청 범위 제한) — exitDate
    // 5일 전으로 신청 시점을 고정하고, 실제 동의 판정은 exitDate 익일
    // 이후로 시계를 이동해 검증한다.
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 12));
    const setReq = makeRequest("https://worker/exit-request", {
      token,
      method: "POST",
      body: { exitDate },
    });
    await handleSetExitRequest(setReq, testEnv, "https://example.com");
    vi.setSystemTime(Date.UTC(2026, 7, 19)); // exitDate 익일 이후

    stubAgreeExitFetch({ member: { number: 5, name: "가", email: MEMBER_EMAIL }, exitDate });
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
    const exitDate = "2026-08-17";
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 12));
    const setReq = makeRequest("https://worker/exit-request", {
      token,
      method: "POST",
      body: { exitDate },
    });
    await handleSetExitRequest(setReq, testEnv, "https://example.com");
    vi.setSystemTime(Date.UTC(2026, 7, 19)); // exitDate 익일 이후

    const personalRows = personalTabRows();
    personalRows[32] = ["", "", 1]; // ROW_FINE_NO_STATUS col2=1(미납)
    stubAgreeExitFetch({ member: { number: 6, name: "나", email: MEMBER_EMAIL }, personalRows, exitDate });
    const req = makeRequest("https://worker/exit-request/agree", { token, method: "POST" });
    const res = await handleAgreeExitRequest(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);

    const id = testEnv.LEAVE_QUEUE_DO.idFromName("leave-queue");
    const stub = testEnv.LEAVE_QUEUE_DO.get(id);
    const getRes = await stub.fetch("https://do/exit/get?memberNumber=6");
    const { entry } = await getRes.json();
    expect(entry.agreedAt).toBeNull();
  });

  // 🔧 [버그 수정 회귀 테스트] 마지막 참여일이 일요일이고, 그 다음 주
  // sheet_reset(월요일 06:00 KST)이 이미 지난 뒤 회원이 동의를 시도하면
  // 원본 시트가 아니라 그 주의 백업 파일에서 순위/집계!P6을 읽어야
  // 한다(exit-confirm.js의 확정 처리 경로와 동일한 resolveExitSourceFileId
  // 재사용) — 원본에는 순위 데이터가 없고(리셋으로 사라짐) 백업에만
  // "3등, 상금 미정산"이 남아있는 상황을 재현해, 원본을 봤다면
  // prizePending=false(오판)로 통과했겠지만 백업을 봐서 정확히
  // 차단되는지 확인한다.
  it("일요일 마지막 참여일 + 리셋 이후 동의 시도 시 원본이 아니라 백업의 순위/상금정산 상태로 판정한다", async () => {
    stubOauthFetch();
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-req-agree-sunday-reset" });
    const token = await makeMemberToken({ memberNumber: "7" });
    const exitDate = "2026-08-16"; // 일요일
    // 신청 시점(2주 이내 범위 제한)을 exitDate 5일 전으로 고정한다.
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 11));
    const setReq = makeRequest("https://worker/exit-request", {
      token,
      method: "POST",
      body: { exitDate },
    });
    await handleSetExitRequest(setReq, testEnv, "https://example.com");
    vi.useRealTimers();

    const weekOf = weekOfForDate(exitDate);
    const backupFileId = `backup-${weekOf}`;
    const member = { number: 7, name: "다", email: MEMBER_EMAIL };
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("drive/v3/files")) return Promise.resolve(driveBackupResponse(exitDate));
        if (u.includes("V50")) return Promise.resolve(dataSheetResponse([member]));
        if (u.includes("values:batchGet")) {
          return Promise.resolve(new Response(JSON.stringify({ valueRanges: [[], []] })));
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
        if (u.includes("D25")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [["1"]] })));
        }
        if (u.includes("A4%3AL18") || u.includes("A4:L18")) {
          // 원본(GOOGLE_SHEET_FILE_ID)은 리셋으로 이미 새 사이클이라 순위
          // 데이터 없음 — 원본을 봤다면 rank="-"가 되어 prizePending이
          // 항상 false로 오판된다.
          if (u.includes(backupFileId)) {
            const rows = Array.from({ length: 15 }, () => []);
            rows[3] = ["", "7", "다", "0", "0", "3"]; // 회원번호7, 순위 3등
            return Promise.resolve(new Response(JSON.stringify({ values: rows })));
          }
          return Promise.resolve(new Response(JSON.stringify({ values: [] })));
        }
        if (u.includes("D23%3AD24") || u.includes("D23:D24")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [["0"], ["0"]] })));
        }
        if (u.includes("fields=sheets.properties")) {
          return Promise.resolve(metaResponse(["1", "template"]));
        }
        if (u.includes("집계!P6")) {
          // 백업(=그 주 실제 상태)에는 상금 정산 미집행이 남아있어야
          // prizePending=true가 나온다 — 값을 비워 "완료"가 아님을 표현.
          return Promise.resolve(new Response(JSON.stringify({ values: [] })));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );

    const req = makeRequest("https://worker/exit-request/agree", { token, method: "POST" });
    const res = await handleAgreeExitRequest(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error).toContain("상금 정산");
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

// 🔧 [사용자 지시] "신청자가 동의를 누르지 않으면 48시간 뒤에는 자동
// 동의처리" — 5분 cron(index.js scheduled)이 부르는
// autoAgreeExpiredExitRequests를 직접 호출해 검증한다. 익일(exitDateSettled
// 기준)로부터 48시간 지난 미동의 신청만 대상이 되는지, 그 전이면 손대지
// 않는지, 벌금 미납 등으로 막힌 신청은 자동 동의도 통과 못 하고 다음
// 크론까지 그대로 남는지 확인한다.
describe("autoAgreeExpiredExitRequests", () => {
  it("익일로부터 48시간이 지난 미동의 신청을 자동으로 동의 처리한다", async () => {
    stubOauthFetch();
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-req-auto-agree-ok" });
    const token = await makeMemberToken({ memberNumber: "11" });
    // 🔧 [테스트 격리] LeaveQueue DO는 idFromName("leave-queue")로 파일별
    // 구분 없이 전역 공유된다 — 다른 테스트가 같은 exitDate로 미동의 상태를
    // 남기면 fake timer 설정 시 그 항목까지 대상에 함께 걸릴 수 있어
    // (autoAgreeExpiredExitRequests는 회원번호와 무관하게 exitDate/agreedAt만
    // 본다), 이 describe 블록 안에서만 쓰는 고유한 날짜를 쓴다.
    const exitDate = "2026-08-11";
    // 신청 시점(2주 이내 범위 제한)을 exitDate 당일로 고정한다.
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 11));
    const setReq = makeRequest("https://worker/exit-request", {
      token,
      method: "POST",
      body: { exitDate },
    });
    await handleSetExitRequest(setReq, testEnv, "https://example.com");

    // 익일(2026-08-12 00:00 KST) + 48시간 + 1분 뒤로 시계를 고정한다.
    const nextDayMidnightUtcMs = Date.UTC(2026, 7, 11, 15, 0, 0); // 2026-08-12 00:00 KST
    vi.setSystemTime(nextDayMidnightUtcMs + 48 * 60 * 60 * 1000 + 60_000);

    stubAgreeExitFetch({ member: { number: 11, name: "라", email: MEMBER_EMAIL }, exitDate });
    await autoAgreeExpiredExitRequests(testEnv);
    vi.useRealTimers();

    const id = testEnv.LEAVE_QUEUE_DO.idFromName("leave-queue");
    const stub = testEnv.LEAVE_QUEUE_DO.get(id);
    const getRes = await stub.fetch("https://do/exit/get?memberNumber=11");
    const { entry } = await getRes.json();
    expect(entry.agreedAt).not.toBeNull();
  });

  it("48시간이 아직 지나지 않았으면 손대지 않는다", async () => {
    stubOauthFetch();
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-req-auto-agree-tooSoon" });
    const token = await makeMemberToken({ memberNumber: "12" });
    const exitDate = "2026-08-12"; // 다른 케이스와 겹치지 않는 고유 날짜(§테스트 격리)
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 12));
    const setReq = makeRequest("https://worker/exit-request", {
      token,
      method: "POST",
      body: { exitDate },
    });
    await handleSetExitRequest(setReq, testEnv, "https://example.com");

    const nextDayMidnightUtcMs = Date.UTC(2026, 7, 12, 15, 0, 0);
    vi.setSystemTime(nextDayMidnightUtcMs + 47 * 60 * 60 * 1000);

    // listExitRequests만 호출되고(대상 없음) 그 이후 조회는 없어야 하므로
    // 다른 경로는 stub하지 않는다 — 잘못 호출되면 "unexpected fetch"로 실패.
    stubOauthFetch();
    await autoAgreeExpiredExitRequests(testEnv);
    vi.useRealTimers();

    const id = testEnv.LEAVE_QUEUE_DO.idFromName("leave-queue");
    const stub = testEnv.LEAVE_QUEUE_DO.get(id);
    const getRes = await stub.fetch("https://do/exit/get?memberNumber=12");
    const { entry } = await getRes.json();
    expect(entry.agreedAt).toBeNull();
  });

  it("벌금 미납분이 남아있으면 48시간이 지나도 자동 동의하지 않는다", async () => {
    stubOauthFetch();
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "exit-req-auto-agree-blocked" });
    const token = await makeMemberToken({ memberNumber: "13" });
    const exitDate = "2026-08-13"; // 다른 케이스와 겹치지 않는 고유 날짜(§테스트 격리)
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 13));
    const setReq = makeRequest("https://worker/exit-request", {
      token,
      method: "POST",
      body: { exitDate },
    });
    await handleSetExitRequest(setReq, testEnv, "https://example.com");

    const nextDayMidnightUtcMs = Date.UTC(2026, 7, 13, 15, 0, 0);
    vi.setSystemTime(nextDayMidnightUtcMs + 48 * 60 * 60 * 1000 + 60_000);

    const personalRows = personalTabRows();
    personalRows[32] = ["", "", 1]; // ROW_FINE_NO_STATUS col2=1(미납)
    stubAgreeExitFetch({ member: { number: 13, name: "마", email: MEMBER_EMAIL }, personalRows, exitDate });
    await autoAgreeExpiredExitRequests(testEnv);
    vi.useRealTimers();

    const id = testEnv.LEAVE_QUEUE_DO.idFromName("leave-queue");
    const stub = testEnv.LEAVE_QUEUE_DO.get(id);
    const getRes = await stub.fetch("https://do/exit/get?memberNumber=13");
    const { entry } = await getRes.json();
    expect(entry.agreedAt).toBeNull();
  });
});
