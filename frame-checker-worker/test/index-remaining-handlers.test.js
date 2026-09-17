// index.js에 남은 잡다한 관리자/조회 핸들러(handleMyRole,
// handleGetGoalSchedule, handleSetGoalSchedule, handleBotInvalidateCache,
// handlePutParticipants, handleGetParticipants) 최소 스모크 테스트.
// 17차 구조 감사에서 이 핸들러들이 "이동 대상이 아니라는 이유로 통합
// 테스트 대상에서도 빠져, 9차(CYCLE_MAX_LEN)·16차(loadNotifyPrefs/
// getPushDeviceIndex)와 동일한 패턴의 import 누락 버그가 숨어있을
// 위험"으로 지목됐다 — 실제로 handleBotInvalidateCache의
// MEMBER_CACHE_GROUPS 미import 버그를 이 작업 중 발견해 함께 고쳤다.
// 인증/검증 분기 중심으로 최소 커버리지만 확보한다(완벽한 커버리지가
// 목표가 아니라 회귀 방지가 목표). handleAdminFinesAdminForcedCount는
// 18차에서 fines.js로 옮겨져 test/fines-handlers.test.js로 이전했다.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  signSession,
  handleMyRole,
  handleGetGoalSchedule,
  handleSetGoalSchedule,
  handleBotInvalidateCache,
  handlePutParticipants,
  handleGetParticipants,
} from "../src/index.js";
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
    GOOGLE_SHEET_FILE_ID: "live-remaining-handlers-file",
    GOOGLE_SERVICE_ACCOUNT_JSON: TEST_SERVICE_ACCOUNT_JSON,
    BOT_SECRET: "test-bot-secret",
    ...overrides,
  };
}

async function makeAdminToken() {
  return signSession({ email: ADMIN_EMAIL, exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
}

async function makeMemberToken() {
  return signSession({ email: "member@test.com", exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
}

function makeRequest(url, { token, botSecret, method = "GET", body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (botSecret !== undefined) headers["X-Bot-Secret"] = botSecret;
  if (body) headers["Content-Type"] = "application/json";
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

describe("handleMyRole", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/me/role");

    const res = await handleMyRole(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("로그인한 회원이면 200과 isCoReviewer 값을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "myrole-200" });
    const token = await makeMemberToken();
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("V50")) return Promise.resolve(new Response(JSON.stringify({ values: [["헤더", "번호", "이름", "이메일"]] })));
        throw new Error("unexpected fetch: " + u);
      })
    );
    const req = makeRequest("https://worker/me/role", { token });

    const res = await handleMyRole(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(typeof body.isCoReviewer).toBe("boolean");
  });
});

describe("handleGetGoalSchedule", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/goal-schedule");

    const res = await handleGetGoalSchedule(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("로그인한 회원이면 200과 validValues(GOAL_TYPE_MULTIPLIER 키 목록)를 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "goal-schedule-200" });
    const token = await signSession({ email: "member@test.com", memberNumber: "1", exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("L5")) return Promise.resolve(new Response(JSON.stringify({ values: [[""]] })));
        throw new Error("unexpected fetch: " + u);
      })
    );
    const req = makeRequest("https://worker/goal-schedule", { token });

    const res = await handleGetGoalSchedule(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(Array.isArray(body.validValues)).toBe(true);
    expect(body.validValues.length).toBeGreaterThan(0);
    expect(body.scheduled).toBe(null);
  });
});

describe("handleSetGoalSchedule", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/goal-schedule", { method: "POST", body: { goalType: "8H (달성제)" } });

    const res = await handleSetGoalSchedule(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("잘못된 goalType이면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const req = makeRequest("https://worker/goal-schedule", { token, method: "POST", body: { goalType: "not-a-type" } });

    const res = await handleSetGoalSchedule(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });
});


describe("handleBotInvalidateCache", () => {
  it("X-Bot-Secret이 없으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/bot/invalidate-cache", { method: "POST", body: {} });

    const res = await handleBotInvalidateCache(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("groups에 잘못된 그룹명이 있으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/bot/invalidate-cache", {
      botSecret: "test-bot-secret",
      method: "POST",
      body: { groups: ["not-a-real-group"] },
    });

    const res = await handleBotInvalidateCache(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("정상 요청이면 200을 반환한다 — MEMBER_CACHE_GROUPS ReferenceError 회귀 방지", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/bot/invalidate-cache", {
      botSecret: "test-bot-secret",
      method: "POST",
      body: { groups: ["roster"] },
    });

    const res = await handleBotInvalidateCache(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);
  });
});

describe("handlePutParticipants / handleGetParticipants", () => {
  it("PUT: X-Bot-Secret이 없으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/participants", { method: "PUT", body: { members: [] } });

    const res = await handlePutParticipants(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("GET: 로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/participants");

    const res = await handleGetParticipants(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("실제 ParticipantsRoster DO에 쓰고 다시 읽으면 같은 값을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const putReq = makeRequest("https://worker/participants", {
      botSecret: "test-bot-secret",
      method: "PUT",
      body: { members: [{ nickname: "가나다" }] },
    });
    const putRes = await handlePutParticipants(putReq, testEnv, "https://example.com");
    expect(putRes.status).toBe(200);

    const token = await makeMemberToken();
    const getReq = makeRequest("https://worker/participants", { token });
    const getRes = await handleGetParticipants(getReq, testEnv, "https://example.com");
    const body = await getRes.json();
    expect(getRes.status, JSON.stringify(body)).toBe(200);
    expect(Array.isArray(body.members)).toBe(true);
    expect(body.members[0]?.nickname).toBe("가나다");
  });
});
