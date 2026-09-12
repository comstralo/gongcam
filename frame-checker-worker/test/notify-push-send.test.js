// 웹 푸시 발송(관리자 카테고리 테스트 발송/일반 테스트 발송/참여자 간
// 알림 발송)과 최근 알림 이력 통합 테스트. sendWebPush가 실제 fetch로
// subscription.endpoint에 POST하므로, 5차(push-crypto) 테스트와 동일하게
// 유효한 VAPID 키를 env에 심어 암호화 경로까지 실제로 태운다.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession, base64url } from "../src/index.js";
import {
  handleAdminPushSendCategory,
  handlePushSubscribe,
  handlePushSendTest,
  handlePushSendToMember,
  handleListRecentNotices,
} from "../src/notify.js";
import { TEST_SERVICE_ACCOUNT_JSON, oauthTokenResponse } from "./helpers/service-account.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const TEST_SECRET = "test-session-secret";
const ADMIN_EMAIL = "admin@test.com";

async function makeVapidOverrides() {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const jwkPrivate = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  return {
    VAPID_PRIVATE_KEY: jwkPrivate.d,
    VAPID_PUBLIC_KEY: base64url(rawPublic),
    VAPID_SUBJECT: "mailto:test@example.com",
  };
}

async function makeFakeSubscription() {
  const clientKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const clientPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", clientKeyPair.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return {
    endpoint: "https://fcm.googleapis.com/fcm/send/dummy-endpoint",
    keys: { p256dh: base64url(clientPublicRaw), auth: base64url(authSecret) },
  };
}

async function makeTestEnv(overrides = {}) {
  const vapid = await makeVapidOverrides();
  return {
    ...env,
    ...vapid,
    SESSION_SECRET: TEST_SECRET,
    ADMIN_EMAIL,
    GOOGLE_SHEET_FILE_ID: "live-notify-send-file",
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

function dataSheetResponse(members) {
  const rows = [["헤더", "번호", "이름", "이메일"]];
  for (const m of members) rows.push(["", String(m.number), m.name, m.email || ""]);
  return new Response(JSON.stringify({ values: rows }));
}

async function makeAdminToken() {
  return signSession({ email: ADMIN_EMAIL, exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
}

async function makeMemberToken(overrides = {}) {
  return signSession({ email: "member@test.com", exp: Date.now() / 1000 + 3600, ...overrides }, TEST_SECRET);
}

describe("handleAdminPushSendCategory", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = await makeTestEnv();
    const token = await makeMemberToken();
    const req = makeRequest("https://worker/admin/push/send-category", {
      token,
      method: "POST",
      body: { nickname: "가", category: "fine_status" },
    });

    const res = await handleAdminPushSendCategory(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("알 수 없는 카테고리면 400을 반환한다", async () => {
    const testEnv = await makeTestEnv();
    const token = await makeAdminToken();
    const req = makeRequest("https://worker/admin/push/send-category", {
      token,
      method: "POST",
      body: { nickname: "가", category: "nope" },
    });

    const res = await handleAdminPushSendCategory(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("존재하지 않는 회원이면 404를 반환한다", async () => {
    const testEnv = await makeTestEnv({ GOOGLE_SHEET_FILE_ID: "notify-send-cat-404" });
    const token = await makeAdminToken();
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("V50")) return Promise.resolve(dataSheetResponse([]));
        throw new Error("unexpected fetch: " + u);
      })
    );
    const req = makeRequest("https://worker/admin/push/send-category", {
      token,
      method: "POST",
      body: { nickname: "없는사람", category: "fine_status" },
    });

    const res = await handleAdminPushSendCategory(req, testEnv, "https://example.com");
    expect(res.status).toBe(404);
  });

  it("회원이 해당 카테고리를 꺼뒀으면 blocked:true를 반환한다", async () => {
    const testEnv = await makeTestEnv({ GOOGLE_SHEET_FILE_ID: "notify-send-cat-blocked" });
    const memberToken = await makeMemberToken({ memberNumber: "1" });
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        throw new Error("unexpected fetch: " + u);
      })
    );
    const { handleSetNotifyPrefs } = await import("../src/notify.js");
    await handleSetNotifyPrefs(
      makeRequest("https://worker/notify-prefs", { token: memberToken, method: "POST", body: { category: "fine_status", enabled: false } }),
      testEnv,
      "https://example.com"
    );

    const adminToken = await makeAdminToken();
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("V50")) return Promise.resolve(dataSheetResponse([{ number: 1, name: "가나다", email: "member@test.com" }]));
        throw new Error("unexpected fetch: " + u);
      })
    );
    const req = makeRequest("https://worker/admin/push/send-category", {
      token: adminToken,
      method: "POST",
      body: { nickname: "가나다", category: "fine_status" },
    });

    const res = await handleAdminPushSendCategory(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.blocked).toBe(true);
  });

  it("구독한 회원에게 정상 발송하면 sent 카운트를 반환한다", async () => {
    // 🔧 [DO 상태 격리] loadNotifyPrefs/getPushDeviceIndex는 memberNumber/
    // email을 키로 MemberSettingsDO/PushSubscriptionsDO(둘 다 전역 싱글턴)
    // 에 저장한다 — GOOGLE_SHEET_FILE_ID를 바꿔도 이 키들은 격리되지
    // 않으므로, 앞선 "blocked" 테스트와 다른 회원번호/이메일을 써야 한다.
    const testEnv = await makeTestEnv({ GOOGLE_SHEET_FILE_ID: "notify-send-cat-ok" });
    const memberToken = await makeMemberToken({ email: "member-ok@test.com" });
    const subscription = await makeFakeSubscription();
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("fcm.googleapis.com")) return Promise.resolve(new Response(null, { status: 201 }));
        throw new Error("unexpected fetch: " + u);
      })
    );
    await handlePushSubscribe(
      makeRequest("https://worker/push/subscribe", { token: memberToken, method: "POST", body: { subscription } }),
      testEnv,
      "https://example.com"
    );

    const adminToken = await makeAdminToken();
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("V50")) return Promise.resolve(dataSheetResponse([{ number: 99, name: "마바사", email: "member-ok@test.com" }]));
        if (u.includes("fcm.googleapis.com")) return Promise.resolve(new Response(null, { status: 201 }));
        throw new Error("unexpected fetch: " + u);
      })
    );
    const req = makeRequest("https://worker/admin/push/send-category", {
      token: adminToken,
      method: "POST",
      body: { nickname: "마바사", category: "fine_status" },
    });

    const res = await handleAdminPushSendCategory(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.sent).toBe(1);
  });
});

describe("handlePushSendTest", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = await makeTestEnv();
    const token = await makeMemberToken();
    const req = makeRequest("https://worker/push/send-test", { token, method: "POST" });

    const res = await handlePushSendTest(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("구독이 없으면 404를 반환한다", async () => {
    const testEnv = await makeTestEnv();
    const token = await makeAdminToken();
    const req = makeRequest("https://worker/push/send-test", { token, method: "POST" });

    const res = await handlePushSendTest(req, testEnv, "https://example.com");
    expect(res.status).toBe(404);
  });
});

describe("handlePushSendToMember", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = await makeTestEnv();
    const req = makeRequest("https://worker/push/send-to-member", { method: "POST", body: { nickname: "가", message: "안녕" } });

    const res = await handlePushSendToMember(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("메시지가 없으면 400을 반환한다", async () => {
    const testEnv = await makeTestEnv();
    const token = await makeMemberToken();
    const req = makeRequest("https://worker/push/send-to-member", { token, method: "POST", body: { nickname: "가", message: "" } });

    const res = await handlePushSendToMember(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("200자를 넘으면 400을 반환한다", async () => {
    const testEnv = await makeTestEnv();
    const token = await makeMemberToken();
    const req = makeRequest("https://worker/push/send-to-member", {
      token,
      method: "POST",
      body: { nickname: "가", message: "a".repeat(201) },
    });

    const res = await handlePushSendToMember(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("정상 발송 후 10분 내 같은 대상에게 재발송하면 429를 반환한다(관리자 아님)", async () => {
    const testEnv = await makeTestEnv({ GOOGLE_SHEET_FILE_ID: "notify-send-member-cooldown" });
    const senderToken = await makeMemberToken({ memberName: "보낸사람" });
    const subscription = await makeFakeSubscription();
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("fcm.googleapis.com")) return Promise.resolve(new Response(null, { status: 201 }));
        throw new Error("unexpected fetch: " + u);
      })
    );
    const targetToken = await makeMemberToken({ email: "target@test.com" });
    await handlePushSubscribe(
      makeRequest("https://worker/push/subscribe", { token: targetToken, method: "POST", body: { subscription } }),
      testEnv,
      "https://example.com"
    );

    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("V50")) return Promise.resolve(dataSheetResponse([{ number: 1, name: "받는사람", email: "target@test.com" }]));
        if (u.includes("fcm.googleapis.com")) return Promise.resolve(new Response(null, { status: 201 }));
        throw new Error("unexpected fetch: " + u);
      })
    );
    const req1 = makeRequest("https://worker/push/send-to-member", {
      token: senderToken,
      method: "POST",
      body: { nickname: "받는사람", message: "안녕하세요" },
    });
    const res1 = await handlePushSendToMember(req1, testEnv, "https://example.com");
    expect(res1.status).toBe(200);

    const req2 = makeRequest("https://worker/push/send-to-member", {
      token: senderToken,
      method: "POST",
      body: { nickname: "받는사람", message: "또 보냄" },
    });
    const res2 = await handlePushSendToMember(req2, testEnv, "https://example.com");
    expect(res2.status).toBe(429);
  });
});

describe("handleListRecentNotices", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = await makeTestEnv();
    const req = makeRequest("https://worker/push/recent-notices");

    const res = await handleListRecentNotices(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("발송된 알림이 최근 목록에 나타난다", async () => {
    const testEnv = await makeTestEnv({ GOOGLE_SHEET_FILE_ID: "notify-recent-list" });
    const senderToken = await makeMemberToken({ memberName: "보낸사람2" });
    const subscription = await makeFakeSubscription();
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("fcm.googleapis.com")) return Promise.resolve(new Response(null, { status: 201 }));
        throw new Error("unexpected fetch: " + u);
      })
    );
    const targetToken = await makeMemberToken({ email: "target2@test.com" });
    await handlePushSubscribe(
      makeRequest("https://worker/push/subscribe", { token: targetToken, method: "POST", body: { subscription } }),
      testEnv,
      "https://example.com"
    );

    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("V50")) return Promise.resolve(dataSheetResponse([{ number: 2, name: "받는사람2", email: "target2@test.com" }]));
        if (u.includes("fcm.googleapis.com")) return Promise.resolve(new Response(null, { status: 201 }));
        throw new Error("unexpected fetch: " + u);
      })
    );
    await handlePushSendToMember(
      makeRequest("https://worker/push/send-to-member", {
        token: senderToken,
        method: "POST",
        body: { nickname: "받는사람2", message: "테스트 알림" },
      }),
      testEnv,
      "https://example.com"
    );

    const viewerToken = await makeMemberToken({ email: "viewer2@test.com" });
    const req = makeRequest("https://worker/push/recent-notices", { token: viewerToken });
    const res = await handleListRecentNotices(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.items.some((n) => n.nickname === "받는사람2" && n.message === "테스트 알림")).toBe(true);
  });
});
