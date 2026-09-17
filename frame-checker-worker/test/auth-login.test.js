// 로그인/OAuth 도메인(handleVerify, handleDevLogin,
// handleAdminOAuthAuthorize, handleAdminOAuthCallback) 통합 테스트.
// handleVerify는 실제 Google 서명 ID 토큰을 위조할 수 없어 크리덴셜
// 형식 오류 경로만 검증하고, 로그인 완료 로직(completeLogin) 자체는
// 동일한 절차를 거치는 handleDevLogin으로 충분히 검증한다.
// MemberSettingsDO는 실제 workerd DO를 그대로 쓴다(mock 불필요).
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession, verifySession } from "../src/index.js";
import {
  handleVerify,
  handleDevLogin,
  handleAdminOAuthAuthorize,
  handleAdminOAuthCallback,
} from "../src/auth.js";
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
    GOOGLE_SHEET_FILE_ID: "live-auth-login-file",
    GOOGLE_SERVICE_ACCOUNT_JSON: TEST_SERVICE_ACCOUNT_JSON,
    DEV_LOGIN_SECRET: "test-dev-secret",
    ADMIN_OAUTH_CLIENT_ID: "test-oauth-client-id",
    ADMIN_OAUTH_CLIENT_SECRET: "test-oauth-client-secret",
    ...overrides,
  };
}

function makeRequest(url, { token, devSecret, method = "GET", body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (devSecret !== undefined) headers["X-Dev-Login-Secret"] = devSecret;
  if (body) headers["Content-Type"] = "application/json";
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

function stubViewerFetch({ viewerEmails = [], extraHandlers } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url, opts) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
      if (u.includes("drive/v3/files") && u.includes("/permissions")) {
        return Promise.resolve(
          new Response(JSON.stringify({ permissions: viewerEmails.map((e) => ({ emailAddress: e, role: "reader" })) }))
        );
      }
      if (extraHandlers) {
        const handled = extraHandlers(u, opts);
        if (handled) return handled;
      }
      throw new Error("unexpected fetch: " + u);
    })
  );
}

describe("handleVerify", () => {
  it("credential이 없으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/verify", { method: "POST", body: {} });

    const res = await handleVerify(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("credential 형식이 잘못되면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/verify", { method: "POST", body: { credential: "not-a-jwt" } });

    const res = await handleVerify(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(401);
    expect(body.error).toContain("구글 인증 실패");
  });
});

describe("handleDevLogin", () => {
  it("DEV_LOGIN_SECRET이 설정되지 않으면 404를 반환한다", async () => {
    const testEnv = makeTestEnv({ DEV_LOGIN_SECRET: undefined });
    const req = makeRequest("https://worker/dev/login", { method: "POST", body: { email: "member@test.com" } });

    const res = await handleDevLogin(req, testEnv, "https://example.com");
    expect(res.status).toBe(404);
  });

  it("X-Dev-Login-Secret이 없으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/dev/login", { method: "POST", body: { email: "member@test.com" } });

    const res = await handleDevLogin(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("X-Dev-Login-Secret이 틀리면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/dev/login", {
      devSecret: "wrong-secret",
      method: "POST",
      body: { email: "member@test.com" },
    });

    const res = await handleDevLogin(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("email이 없으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/dev/login", {
      devSecret: "test-dev-secret",
      method: "POST",
      body: {},
    });

    const res = await handleDevLogin(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("참여자 명단에 없으면 403을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "auth-devlogin-403" });
    stubViewerFetch({ viewerEmails: ["someone-else@test.com"] });
    const req = makeRequest("https://worker/dev/login", {
      devSecret: "test-dev-secret",
      method: "POST",
      body: { email: "member@test.com" },
    });

    const res = await handleDevLogin(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(403);
  });

  it("명단에 있으면 세션 토큰을 발급하고, 회원번호를 못 찾아도 로그인은 허용한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "auth-devlogin-200" });
    stubViewerFetch({
      viewerEmails: ["member@test.com"],
      extraHandlers: (u) => {
        if (u.includes("V50") || u.includes("데이터!A1")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [["헤더", "번호", "이름", "이메일"]] })));
        }
        return null;
      },
    });
    const req = makeRequest("https://worker/dev/login", {
      devSecret: "test-dev-secret",
      method: "POST",
      body: { email: "member@test.com", name: "테스트유저" },
    });

    const res = await handleDevLogin(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.email).toBe("member@test.com");
    expect(body.name).toBe("테스트유저");
    expect(typeof body.token).toBe("string");

    const session = await verifySession(body.token, TEST_SECRET);
    expect(session.email).toBe("member@test.com");
    expect(session.memberNumber).toBe(null);
  });

  it("회원 명단에서 이메일을 찾으면 세션에 회원번호가 실린다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "auth-devlogin-withmember" });
    stubViewerFetch({
      viewerEmails: ["member@test.com"],
      extraHandlers: (u) => {
        if (u.includes("V50") || u.includes("데이터!A1")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ values: [["헤더", "번호", "이름", "이메일"], ["", "7", "가나다", "member@test.com"]] })
            )
          );
        }
        return null;
      },
    });
    const req = makeRequest("https://worker/dev/login", {
      devSecret: "test-dev-secret",
      method: "POST",
      body: { email: "member@test.com" },
    });

    const res = await handleDevLogin(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);

    const session = await verifySession(body.token, TEST_SECRET);
    expect(session.memberNumber).toBe("7");
    expect(session.memberName).toBe("가나다");
  });
});

describe("handleAdminOAuthAuthorize", () => {
  it("token 쿼리 파라미터가 없으면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const url = new URL("https://worker/oauth/authorize");
    const req = new Request(url.toString());

    const res = await handleAdminOAuthAuthorize(req, testEnv, "https://example.com", url);
    expect(res.status).toBe(403);
  });

  it("관리자가 아닌 세션이면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await signSession({ email: "member@test.com", exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
    const url = new URL(`https://worker/oauth/authorize?token=${encodeURIComponent(token)}`);
    const req = new Request(url.toString());

    const res = await handleAdminOAuthAuthorize(req, testEnv, "https://example.com", url);
    expect(res.status).toBe(403);
  });

  it("관리자 세션이면 구글 OAuth 동의 화면으로 302 리다이렉트한다", async () => {
    const testEnv = makeTestEnv();
    const token = await signSession({ email: ADMIN_EMAIL, exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
    const url = new URL(`https://worker/oauth/authorize?token=${encodeURIComponent(token)}`);
    const req = new Request(url.toString(), { redirect: "manual" });

    const res = await handleAdminOAuthAuthorize(req, testEnv, "https://example.com", url);
    expect(res.status).toBe(302);
    const location = res.headers.get("Location");
    expect(location).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location).toContain("client_id=test-oauth-client-id");
    expect(location).toContain("login_hint=admin%40test.com");
    expect(location).toContain("state=");
  });
});

describe("handleAdminOAuthCallback", () => {
  it("error 파라미터가 있으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const url = new URL("https://worker/oauth/callback?error=access_denied");
    const req = new Request(url.toString());

    const res = await handleAdminOAuthCallback(req, testEnv, "https://example.com", url);
    expect(res.status).toBe(400);
  });

  it("code 파라미터가 없으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const url = new URL("https://worker/oauth/callback");
    const req = new Request(url.toString());

    const res = await handleAdminOAuthCallback(req, testEnv, "https://example.com", url);
    expect(res.status).toBe(400);
  });

  it("state가 없거나 유효하지 않으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const url = new URL("https://worker/oauth/callback?code=abc123");
    const req = new Request(url.toString());

    const res = await handleAdminOAuthCallback(req, testEnv, "https://example.com", url);
    const text = await res.text();
    expect(res.status, text).toBe(400);
  });

  it("state의 purpose가 다르면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const wrongPurposeState = await signSession(
      { purpose: "not_admin_oauth_state", email: ADMIN_EMAIL, exp: Date.now() / 1000 + 600 },
      TEST_SECRET
    );
    const url = new URL(
      `https://worker/oauth/callback?code=abc123&state=${encodeURIComponent(wrongPurposeState)}`
    );
    const req = new Request(url.toString());

    const res = await handleAdminOAuthCallback(req, testEnv, "https://example.com", url);
    expect(res.status).toBe(400);
  });

  it("정상 state와 code면 refresh_token을 BotAdminConfigDO에 저장하고 200을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const validState = await signSession(
      { purpose: "admin_oauth_state", email: ADMIN_EMAIL, exp: Date.now() / 1000 + 600 },
      TEST_SECRET
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((url, opts) => {
        const u = String(url);
        if (u === "https://oauth2.googleapis.com/token") {
          return Promise.resolve(
            new Response(JSON.stringify({ refresh_token: "test-refresh-token", access_token: "test-access-token" }))
          );
        }
        throw new Error("unexpected fetch: " + u);
      })
    );
    const url = new URL(`https://worker/oauth/callback?code=abc123&state=${encodeURIComponent(validState)}`);
    const req = new Request(url.toString());

    const res = await handleAdminOAuthCallback(req, testEnv, "https://example.com", url);
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(text).toContain("완료");
  });

  it("토큰 교환이 실패하면 500을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const validState = await signSession(
      { purpose: "admin_oauth_state", email: ADMIN_EMAIL, exp: Date.now() / 1000 + 600 },
      TEST_SECRET
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u === "https://oauth2.googleapis.com/token") {
          return Promise.resolve(new Response(JSON.stringify({ error: "invalid_grant" })));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );
    const url = new URL(`https://worker/oauth/callback?code=bad-code&state=${encodeURIComponent(validState)}`);
    const req = new Request(url.toString());

    const res = await handleAdminOAuthCallback(req, testEnv, "https://example.com", url);
    expect(res.status).toBe(500);
  });
});
