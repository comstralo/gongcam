// 캡처 목록 조회/응답/투표(handleAdminCapturesList, handleMyCaptures,
// handleMyCaptureDelete, handleMyOutputPen, handleCaptureTargetRespond,
// handleAdminCaptureVote, handleAdminCaptureFile, handleReportStatus)
// 통합 테스트. 봇 URL을 설정하지 않으면 proxyToBotDashboard가 fetch 없이
// 즉시 null을 반환하므로(BotAdminConfigDO, 11차에서 확인) 이 경계
// (봇 오프라인 → 빈 목록/502)를 중심으로 검증한다.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../src/index.js";
import {
  handleAdminCapturesList,
  handleMyCaptures,
  handleMyCaptureDelete,
  handleMyOutputPen,
  handleCaptureTargetRespond,
  handleAdminCaptureVote,
  handleAdminCaptureFile,
} from "../src/report-review.js";
import { handleReportStatus } from "../src/report-penalty.js";
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
    GOOGLE_SHEET_FILE_ID: "live-report-list-file",
    GOOGLE_SERVICE_ACCOUNT_JSON: TEST_SERVICE_ACCOUNT_JSON,
    ...overrides,
  };
}

function makeRequest(url, { token, method = "GET", body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

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

async function makeMemberToken(overrides = {}) {
  return signSession({ email: "member@test.com", exp: Date.now() / 1000 + 3600, ...overrides }, TEST_SECRET);
}

async function makeAdminToken() {
  return signSession({ email: ADMIN_EMAIL, exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
}

describe("handleAdminCapturesList", () => {
  it("관리자도 부스터디장도 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const req = makeRequest("https://worker/admin/captures", { token });

    const res = await handleAdminCapturesList(req, testEnv, "https://example.com", null);
    expect(res.status).toBe(403);
  });

  it("관리자면 봇이 꺼져 있어도 빈 목록을 200으로 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeAdminToken();
    const req = makeRequest("https://worker/admin/captures", { token });

    const res = await handleAdminCapturesList(req, testEnv, "https://example.com", null);
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.coReviewers).toEqual([]);
  });
});

describe("handleMyCaptures", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/my-captures");

    const res = await handleMyCaptures(req, testEnv, "https://example.com", null);
    expect(res.status).toBe(401);
  });

  it("봇이 꺼져 있으면 빈 목록을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const req = makeRequest("https://worker/my-captures", { token });

    const res = await handleMyCaptures(req, testEnv, "https://example.com", new URL("https://worker/my-captures"));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.items).toEqual([]);
  });
});

describe("handleMyCaptureDelete", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/my-captures/delete", { method: "POST", body: { id: "x" } });

    const res = await handleMyCaptureDelete(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("id가 없으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const req = makeRequest("https://worker/my-captures/delete", { token, method: "POST", body: {} });

    const res = await handleMyCaptureDelete(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("봇이 꺼져 있어 기록을 찾을 수 없으면 404를 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const req = makeRequest("https://worker/my-captures/delete", { token, method: "POST", body: { id: "nonexistent" } });

    const res = await handleMyCaptureDelete(req, testEnv, "https://example.com");
    expect(res.status).toBe(404);
  });
});

describe("handleMyOutputPen", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/my-output-pen");

    const res = await handleMyOutputPen(req, testEnv, "https://example.com", null);
    expect(res.status).toBe(401);
  });

  it("회원 명단에 없으면 빈 목록을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "report-list-myoutputpen-none" });
    const token = await makeMemberToken();
    stubOauthFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("V50")) return Promise.resolve(new Response(JSON.stringify({ values: [["헤더", "번호", "이름", "이메일"]] })));
        throw new Error("unexpected fetch: " + u);
      })
    );
    const req = makeRequest("https://worker/my-output-pen", { token });

    const res = await handleMyOutputPen(req, testEnv, "https://example.com", new URL("https://worker/my-output-pen"));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.items).toEqual([]);
  });
});

describe("handleCaptureTargetRespond", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/captures/target-respond", {
      method: "POST",
      body: { id: "x", response: "recognized" },
    });

    const res = await handleCaptureTargetRespond(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("response 값이 잘못되면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const req = makeRequest("https://worker/captures/target-respond", {
      token,
      method: "POST",
      body: { id: "x", response: "invalid" },
    });

    const res = await handleCaptureTargetRespond(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("회원 명단에 없으면 403을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "report-list-target-respond-403" });
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
    const req = makeRequest("https://worker/captures/target-respond", {
      token,
      method: "POST",
      body: { id: "x", response: "recognized" },
    });

    const res = await handleCaptureTargetRespond(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("봇에 연결할 수 없으면 502를 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "report-list-target-respond-502" });
    const token = await makeMemberToken();
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("V50")) {
          return Promise.resolve(
            new Response(JSON.stringify({ values: [["헤더", "번호", "이름", "이메일"], ["", "1", "가", "member@test.com"]] }))
          );
        }
        throw new Error("unexpected fetch: " + u);
      })
    );
    const req = makeRequest("https://worker/captures/target-respond", {
      token,
      method: "POST",
      body: { id: "x", response: "recognized" },
    });

    const res = await handleCaptureTargetRespond(req, testEnv, "https://example.com");
    expect(res.status).toBe(502);
  });
});

describe("handleAdminCaptureVote", () => {
  it("권한이 없으면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const req = makeRequest("https://worker/admin/captures/vote", {
      token,
      method: "POST",
      body: { id: "x", severity: "yes" },
    });

    const res = await handleAdminCaptureVote(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("severity 값이 잘못되면 400을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "report-list-vote-400" });
    const token = await makeMemberToken({ email: "coreviewer-400@test.com" });
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("values:batchGet")) {
          return Promise.resolve(new Response(JSON.stringify({ valueRanges: [{ values: [["부스터디장"]] }] })));
        }
        if (u.includes("V50")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ values: [["헤더", "번호", "이름", "이메일"], ["", "1", "가", "coreviewer-400@test.com"]] })
            )
          );
        }
        throw new Error("unexpected fetch: " + u);
      })
    );
    const req = makeRequest("https://worker/admin/captures/vote", {
      token,
      method: "POST",
      body: { id: "x", severity: "invalid" },
    });

    const res = await handleAdminCaptureVote(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("주 관리자는 coReviewer 역할이 아니므로 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeAdminToken();
    const req = makeRequest("https://worker/admin/captures/vote", {
      token,
      method: "POST",
      body: { id: "x", severity: "yes" },
    });

    const res = await handleAdminCaptureVote(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });
});

describe("handleAdminCaptureFile", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const url = new URL("https://worker/admin/captures/file?id=x");
    const req = makeRequest(url.toString());

    const res = await handleAdminCaptureFile(req, testEnv, "https://example.com", url);
    expect(res.status).toBe(401);
  });

  it("id가 없으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const url = new URL("https://worker/admin/captures/file");
    const req = makeRequest(url.toString(), { token });

    const res = await handleAdminCaptureFile(req, testEnv, "https://example.com", url);
    expect(res.status).toBe(400);
  });

  it("봇에 연결할 수 없으면 502를 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const url = new URL("https://worker/admin/captures/file?id=x");
    const req = makeRequest(url.toString(), { token });

    const res = await handleAdminCaptureFile(req, testEnv, "https://example.com", url);
    expect(res.status).toBe(502);
  });
});

describe("handleReportStatus", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const url = new URL("https://worker/report-status?nickname=x");
    const req = makeRequest(url.toString());

    const res = await handleReportStatus(req, testEnv, "https://example.com", url);
    expect(res.status).toBe(401);
  });

  it("nickname이 없으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const url = new URL("https://worker/report-status");
    const req = makeRequest(url.toString(), { token });

    const res = await handleReportStatus(req, testEnv, "https://example.com", url);
    expect(res.status).toBe(400);
  });

  it("봇이 꺼져 있으면 inProgress:false를 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeMemberToken();
    const url = new URL("https://worker/report-status?nickname=가나다");
    const req = makeRequest(url.toString(), { token });

    const res = await handleReportStatus(req, testEnv, "https://example.com", url);
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toEqual({ inProgress: false, recentLogs: [] });
  });
});
