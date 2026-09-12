// 봇 상태/사용량 도메인(handleBotRegisterUrl, handleBotSheetsUsageReport,
// handleInternalCycleBoundary, handleAdminUsageStatus, handleAdminBotStatus,
// handleAdminBotCommand) 통합 테스트. BotAdminConfigDO/UsageStatsDO는 실제
// workerd DO를 그대로 쓴다(mock 불필요) — 봇 URL을 등록하지 않으면
// proxyToBotDashboard가 fetch 없이 즉시 null을 반환하는 성질(11~13차에서
// 반복 확인)을 활용해 "봇 오프라인" 경로를 검증한다. CF_API_TOKEN/
// CF_ACCOUNT_ID를 설정하지 않으면 fetchCloudflareUsage도 fetch 없이 null을
// 반환하므로, handleAdminUsageStatus 검증에도 fetch mock이 필요 없다.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../src/index.js";
import {
  handleBotRegisterUrl,
  handleBotSheetsUsageReport,
  handleInternalCycleBoundary,
  handleAdminUsageStatus,
  handleAdminBotStatus,
  handleAdminBotCommand,
} from "../src/bot.js";
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
    GOOGLE_SHEET_FILE_ID: "live-bot-status-file",
    GOOGLE_SERVICE_ACCOUNT_JSON: TEST_SERVICE_ACCOUNT_JSON,
    BOT_SECRET: "test-bot-secret",
    ...overrides,
  };
}

function makeRequest(url, { token, botSecret, method = "GET", body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (botSecret !== undefined) headers["X-Bot-Secret"] = botSecret;
  if (body) headers["Content-Type"] = "application/json";
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

async function makeAdminToken() {
  return signSession({ email: ADMIN_EMAIL, exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
}

async function makeMemberToken() {
  return signSession({ email: "member@test.com", exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
}

describe("handleBotRegisterUrl", () => {
  it("X-Bot-Secret이 없으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/bot/register-url", { method: "POST", body: { url: "https://bot.example" } });

    const res = await handleBotRegisterUrl(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("X-Bot-Secret이 틀리면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/bot/register-url", {
      botSecret: "wrong-secret",
      method: "POST",
      body: { url: "https://bot.example" },
    });

    const res = await handleBotRegisterUrl(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("url이 없으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/bot/register-url", {
      botSecret: "test-bot-secret",
      method: "POST",
      body: {},
    });

    const res = await handleBotRegisterUrl(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("정상 등록 시 실제 BotAdminConfigDO에 URL이 저장되고 ok를 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/bot/register-url", {
      botSecret: "test-bot-secret",
      method: "POST",
      body: { url: "https://bot-13.example" },
    });

    const res = await handleBotRegisterUrl(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);

    // 실제 DO에 반영됐는지 확인 — handleAdminBotStatus가 proxyToBotDashboard로
    // 이 URL을 읽어 실제로 fetch를 시도하는지로 간접 검증한다.
    const adminToken = await makeAdminToken();
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.startsWith("https://bot-13.example")) {
          return Promise.resolve(new Response(JSON.stringify({ online: true }), { status: 200 }));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );
    const statusReq = makeRequest("https://worker/admin/bot/status", { token: adminToken });
    const statusRes = await handleAdminBotStatus(statusReq, testEnv, "https://example.com");
    const statusBody = await statusRes.json();
    expect(statusRes.status, JSON.stringify(statusBody)).toBe(200);
    expect(statusBody.online).toBe(true);
  });
});

describe("handleBotSheetsUsageReport", () => {
  it("X-Bot-Secret이 없으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/admin/bot-sheets-usage", { method: "POST", body: { read: 1, write: 1 } });

    const res = await handleBotSheetsUsageReport(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("정상 요청이면 카운터에 합산되고 ok를 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/admin/bot-sheets-usage", {
      botSecret: "test-bot-secret",
      method: "POST",
      body: { read: 3, write: 2 },
    });

    const res = await handleBotSheetsUsageReport(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);
  });
});

describe("handleInternalCycleBoundary", () => {
  it("X-Bot-Secret이 없으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/internal/cycle-boundary");

    const res = await handleInternalCycleBoundary(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("백업이 없으면 cycleStartWeekOf는 null이다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "bot-cycle-boundary-none" });
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("drive/v3/files")) {
          return Promise.resolve(new Response(JSON.stringify({ files: [] })));
        }
        if (u.includes("D25")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [["1"]] })));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );
    const req = makeRequest("https://worker/internal/cycle-boundary", { botSecret: "test-bot-secret" });

    const res = await handleInternalCycleBoundary(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.cycleStartWeekOf).toBe(null);
  });
});

describe("handleAdminUsageStatus", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const req = makeRequest("https://worker/admin/usage", { token });

    const res = await handleAdminUsageStatus(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("CF 토큰 미설정 시 cloudflare는 null, sheets/dailyUsage는 정상 반환한다", async () => {
    const testEnv = makeTestEnv({ CF_API_TOKEN: undefined, CF_ACCOUNT_ID: undefined });
    const token = await makeAdminToken();
    const req = makeRequest("https://worker/admin/usage", { token });

    const res = await handleAdminUsageStatus(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.cloudflare).toBe(null);
    expect(body.cloudflareConfigured).toBe(false);
    expect(body.sheets).toBeTruthy();
    expect(Array.isArray(body.dailyUsage)).toBe(true);
    expect(Array.isArray(body.kvWriteBreakdown)).toBe(true);
    expect(body.limits.workersRequestsPerDay).toBe(100_000);
  });
});

describe("handleAdminBotStatus", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const req = makeRequest("https://worker/admin/bot/status", { token });

    const res = await handleAdminBotStatus(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("봇이 등록되지 않았으면 online:false를 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeAdminToken();
    const req = makeRequest("https://worker/admin/bot/status", { token });

    const res = await handleAdminBotStatus(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toEqual({ online: false, roomState: null, screenshot: null, recentLogs: [] });
  });
});

describe("handleAdminBotCommand", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const req = makeRequest("https://worker/admin/bot/command", { token, method: "POST", body: { command: "restart" } });

    const res = await handleAdminBotCommand(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("알 수 없는 명령이면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeAdminToken();
    const req = makeRequest("https://worker/admin/bot/command", { token, method: "POST", body: { command: "shutdown" } });

    const res = await handleAdminBotCommand(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("봇이 등록되지 않았으면 502를 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeAdminToken();
    const req = makeRequest("https://worker/admin/bot/command", { token, method: "POST", body: { command: "restart" } });

    const res = await handleAdminBotCommand(req, testEnv, "https://example.com");
    expect(res.status).toBe(502);
  });

  it("봇이 409를 반환하면 그대로 409를 전달한다", async () => {
    const testEnv = makeTestEnv();
    const registerReq = makeRequest("https://worker/bot/register-url", {
      botSecret: "test-bot-secret",
      method: "POST",
      body: { url: "https://bot-409.example" },
    });
    await handleBotRegisterUrl(registerReq, testEnv, "https://example.com");

    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u === "https://bot-409.example/restart") {
          return Promise.resolve(new Response(JSON.stringify({ error: "이미 재시작 진행 중" }), { status: 409 }));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );
    const token = await makeAdminToken();
    const req = makeRequest("https://worker/admin/bot/command", { token, method: "POST", body: { command: "restart" } });

    const res = await handleAdminBotCommand(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.error).toBe("이미 재시작 진행 중");
  });

  it("봇이 정상 응답하면 200과 데이터를 그대로 전달한다", async () => {
    const testEnv = makeTestEnv();
    const registerReq = makeRequest("https://worker/bot/register-url", {
      botSecret: "test-bot-secret",
      method: "POST",
      body: { url: "https://bot-200.example" },
    });
    await handleBotRegisterUrl(registerReq, testEnv, "https://example.com");

    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u === "https://bot-200.example/restart") {
          return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );
    const token = await makeAdminToken();
    const req = makeRequest("https://worker/admin/bot/command", { token, method: "POST", body: { command: "restart" } });

    const res = await handleAdminBotCommand(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);
  });
});
