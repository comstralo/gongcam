// 제보 접수/쿨다운/안전망 폴링 통합 테스트 — fetch mock + 실제 workerd
// ParticipantsRoster/ReportQueue DO를 조합한다. 봇 URL을 설정하지 않으면
// proxyToBotDashboard(BotAdminConfigDO)가 fetch 없이 즉시 null을 반환하는
// 성질(11차에서 확인)을 활용해 "봇 오프라인" 경로를 mock 없이 자연스럽게
// 검증한다. 6~11차와 동일하게 이메일/회원번호를 케이스마다 다르게 줘서
// DO 상태(전역 싱글턴, 10차 교훈)를 격리한다.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../src/index.js";
import { handleReport, handleListActiveCooldowns, handleReportCaptureDone, handleListReports, handleRequeueReport } from "../src/report.js";
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
    GOOGLE_SHEET_FILE_ID: "live-report-submit-file",
    GOOGLE_SERVICE_ACCOUNT_JSON: TEST_SERVICE_ACCOUNT_JSON,
    BOT_SECRET: "test-bot-secret",
    ...overrides,
  };
}

function makeRequest(url, { token, method = "GET", body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body) h["Content-Type"] = "application/json";
  return new Request(url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
}

function dataSheetResponse(members) {
  const rows = [["헤더", "번호", "이름", "이메일"]];
  for (const m of members) rows.push(["", String(m.number), m.name, m.email || ""]);
  return new Response(JSON.stringify({ values: rows }));
}

async function makeMemberToken(overrides = {}) {
  return signSession({ email: "reporter@test.com", exp: Date.now() / 1000 + 3600, ...overrides }, TEST_SECRET);
}

async function makeAdminToken() {
  return signSession({ email: ADMIN_EMAIL, exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
}

function stubMembersFetch(members) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
      if (u.includes("V50")) return Promise.resolve(dataSheetResponse(members));
      throw new Error("unexpected fetch: " + u);
    })
  );
}

describe("handleReport", () => {
  it("token이 없으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/report", { method: "POST", body: { nickname: "가", reason: "지각" } });

    const res = await handleReport(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("세션이 만료되었으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/report", { method: "POST", body: { token: "invalid", nickname: "가", reason: "지각" } });

    const res = await handleReport(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("nickname이 명단에 없으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "report-submit-no-member" });
    const token = await makeMemberToken();
    stubMembersFetch([{ number: 1, name: "가나다", email: "reporter@test.com" }]);
    const req = makeRequest("https://worker/report", {
      method: "POST",
      body: { token, nickname: "존재안함", reason: "지각" },
    });

    const res = await handleReport(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("본인을 대상으로 지정하면 400을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "report-submit-self" });
    const token = await makeMemberToken();
    stubMembersFetch([
      { number: 1, name: "본인이름", email: "reporter@test.com" },
      { number: 2, name: "타인", email: "other@test.com" },
    ]);
    const req = makeRequest("https://worker/report", {
      method: "POST",
      body: { token, nickname: "본인이름", reason: "지각" },
    });

    const res = await handleReport(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("유효한 제보면 200을 반환하고 쿨다운 목록에 나타난다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "report-submit-ok" });
    const token = await makeMemberToken();
    stubMembersFetch([
      { number: 1, name: "제보자자신", email: "reporter@test.com" },
      { number: 2, name: "대상자", email: "target@test.com" },
    ]);
    const req = makeRequest("https://worker/report", {
      method: "POST",
      body: { token, nickname: "대상자", reason: "지각" },
    });

    const res = await handleReport(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);

    const listReq = makeRequest("https://worker/report-cooldowns", { token });
    const listRes = await handleListActiveCooldowns(listReq, testEnv, "https://example.com");
    const listBody = await listRes.json();
    expect(listBody.items.some((it) => it.nickname === "대상자")).toBe(true);
  });

  it("같은 대상에게 20분 내 재제보하면 429를 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "report-submit-cooldown" });
    const token = await makeMemberToken();
    stubMembersFetch([
      { number: 1, name: "제보자자신2", email: "reporter@test.com" },
      { number: 2, name: "대상자2", email: "target2@test.com" },
    ]);
    const makeReq = () =>
      makeRequest("https://worker/report", { method: "POST", body: { token, nickname: "대상자2", reason: "지각" } });

    const res1 = await handleReport(makeReq(), testEnv, "https://example.com");
    expect(res1.status).toBe(200);
    const res2 = await handleReport(makeReq(), testEnv, "https://example.com");
    expect(res2.status).toBe(429);
  });

  it("관리자는 쿨다운을 우회한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "report-submit-admin-bypass" });
    const adminToken = await makeAdminToken();
    stubMembersFetch([{ number: 3, name: "대상자3", email: "target3@test.com" }]);
    const makeReq = () =>
      makeRequest("https://worker/report", {
        method: "POST",
        body: { token: adminToken, nickname: "대상자3", reason: "지각" },
      });

    const res1 = await handleReport(makeReq(), testEnv, "https://example.com");
    expect(res1.status).toBe(200);
    const res2 = await handleReport(makeReq(), testEnv, "https://example.com");
    expect(res2.status).toBe(200);
  });

  it("셀프 체크는 대상자가 본인으로 강제된다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "report-submit-selfcheck" });
    const token = await makeMemberToken();
    stubMembersFetch([{ number: 4, name: "셀프체크본인", email: "reporter@test.com" }]);
    const req = makeRequest("https://worker/report", {
      method: "POST",
      body: { token, selfCheck: true },
    });

    const res = await handleReport(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
  });
});

describe("handleListActiveCooldowns", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/report-cooldowns");

    const res = await handleListActiveCooldowns(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("다른 사람의 셀프체크 항목은 노출하지 않는다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "report-cooldowns-hide-selfcheck" });
    const selfCheckerToken = await makeMemberToken({ email: "selfchecker@test.com" });
    stubMembersFetch([{ number: 5, name: "본인체크", email: "selfchecker@test.com" }]);
    await handleReport(
      makeRequest("https://worker/report", { method: "POST", body: { token: selfCheckerToken, selfCheck: true } }),
      testEnv,
      "https://example.com"
    );

    const viewerToken = await makeMemberToken({ email: "viewer@test.com" });
    const req = makeRequest("https://worker/report-cooldowns", { token: viewerToken });
    const res = await handleListActiveCooldowns(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(body.items.some((it) => it.nickname === "본인체크")).toBe(false);
  });
});

describe("handleReportCaptureDone", () => {
  it("봇 시크릿이 없으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/reports/capture-done", { method: "POST", body: { id: "x" } });

    const res = await handleReportCaptureDone(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("id가 없으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/reports/capture-done", {
      method: "POST",
      body: {},
      headers: { "X-Bot-Secret": "test-bot-secret" },
    });

    const res = await handleReportCaptureDone(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("유효한 요청이면 200을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/reports/capture-done", {
      method: "POST",
      body: { id: "some-id" },
      headers: { "X-Bot-Secret": "test-bot-secret" },
    });

    const res = await handleReportCaptureDone(req, testEnv, "https://example.com");
    expect(res.status).toBe(200);
  });
});

describe("handleListReports / handleRequeueReport", () => {
  it("handleListReports: 봇 시크릿이 없으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/reports");

    const res = await handleListReports(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("handleListReports: 안전망 큐에 등록된 제보를 drain한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "report-drain-ok" });
    const token = await makeMemberToken();
    stubMembersFetch([
      { number: 6, name: "제보자자신4", email: "reporter@test.com" },
      { number: 7, name: "대상자4", email: "target4@test.com" },
    ]);
    // 봇이 오프라인이므로(URL 미설정) reports/new push가 null을 반환해
    // 큐(report:{id})에 그대로 남는다.
    await handleReport(
      makeRequest("https://worker/report", { method: "POST", body: { token, nickname: "대상자4", reason: "지각" } }),
      testEnv,
      "https://example.com"
    );

    const req = makeRequest("https://worker/reports", { headers: { "X-Bot-Secret": "test-bot-secret" } });
    const res = await handleListReports(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.some((it) => it.nickname === "대상자4")).toBe(true);
  });

  it("handleRequeueReport: 봇 시크릿이 없으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/reports/requeue", { method: "POST", body: {} });

    const res = await handleRequeueReport(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("handleRequeueReport: TTL이 지난 항목은 requeued:false를 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/reports/requeue", {
      method: "POST",
      body: { id: "x", ts: 1 }, // REPORT_TTL_SEC(12시간) 이전 과거 시각 — 이미 만료됨.
      headers: { "X-Bot-Secret": "test-bot-secret" },
    });

    const res = await handleRequeueReport(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.requeued).toBe(false);
  });

  it("handleRequeueReport: TTL이 남았으면 재등록되고 handleListReports로 다시 조회된다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/reports/requeue", {
      method: "POST",
      body: { id: "requeue-test-id", ts: Date.now(), nickname: "재등록대상" },
      headers: { "X-Bot-Secret": "test-bot-secret" },
    });

    const res = await handleRequeueReport(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.requeued).toBe(true);

    const listReq = makeRequest("https://worker/reports", { headers: { "X-Bot-Secret": "test-bot-secret" } });
    const listRes = await handleListReports(listReq, testEnv, "https://example.com");
    const listBody = await listRes.json();
    expect(listBody.some((it) => it.id === "requeue-test-id")).toBe(true);
  });
});
