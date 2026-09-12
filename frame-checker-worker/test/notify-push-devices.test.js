// 웹 푸시 구독/기기 관리(subscribe, devices 목록/토글/이름변경/삭제,
// subscription-status) 통합 테스트 — PushSubscriptionsDO(실제 workerd)에
// 직접 기록된 값을 검증한다.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../src/index.js";
import {
  handlePushSubscribe,
  handleListPushDevices,
  handlePushDeviceToggle,
  handlePushDeviceRename,
  handlePushDeviceRemove,
  handlePushSubscriptionStatus,
} from "../src/notify.js";
import { TEST_SERVICE_ACCOUNT_JSON, oauthTokenResponse } from "./helpers/service-account.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const TEST_SECRET = "test-session-secret";

function makeTestEnv(overrides = {}) {
  return {
    ...env,
    SESSION_SECRET: TEST_SECRET,
    GOOGLE_SHEET_FILE_ID: "live-notify-push-file",
    GOOGLE_SERVICE_ACCOUNT_JSON: TEST_SERVICE_ACCOUNT_JSON,
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

async function makeToken(email, overrides = {}) {
  return signSession({ email, exp: Date.now() / 1000 + 3600, ...overrides }, TEST_SECRET);
}

function fakeSubscriptionBody() {
  return {
    subscription: {
      endpoint: "https://fcm.googleapis.com/fcm/send/dummy",
      keys: { p256dh: "dummy-p256dh", auth: "dummy-auth" },
    },
  };
}

describe("handlePushSubscribe", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/push/subscribe", { method: "POST", body: fakeSubscriptionBody() });

    const res = await handlePushSubscribe(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("구독 정보가 올바르지 않으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeToken("m1@test.com");
    const req = makeRequest("https://worker/push/subscribe", { token, method: "POST", body: { subscription: {} } });

    const res = await handlePushSubscribe(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("유효한 구독이면 200을 반환하고 기기 목록에 나타난다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeToken("m2@test.com");
    const req = makeRequest("https://worker/push/subscribe", {
      token,
      method: "POST",
      body: fakeSubscriptionBody(),
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/120" },
    });

    const res = await handlePushSubscribe(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.deviceLabel).toContain("Windows");

    const listReq = makeRequest("https://worker/push/devices", { token });
    const listRes = await handleListPushDevices(listReq, testEnv, "https://example.com");
    const listBody = await listRes.json();
    expect(listBody.devices).toHaveLength(1);
    expect(listBody.devices[0].id).toBe(body.deviceId);
  });
});

describe("handleListPushDevices", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/push/devices");

    const res = await handleListPushDevices(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("구독이 없으면 빈 배열을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeToken("m3@test.com");
    const req = makeRequest("https://worker/push/devices", { token });

    const res = await handleListPushDevices(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(body.devices).toEqual([]);
  });
});

describe("handlePushDeviceToggle / handlePushDeviceRename / handlePushDeviceRemove", () => {
  async function subscribeOnce(testEnv, token) {
    const req = makeRequest("https://worker/push/subscribe", { token, method: "POST", body: fakeSubscriptionBody() });
    const res = await handlePushSubscribe(req, testEnv, "https://example.com");
    const body = await res.json();
    return body.deviceId;
  }

  it("다른 사람 기기 id를 지정하면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeToken("m4@test.com");
    const req = makeRequest("https://worker/push/devices/toggle", {
      token,
      method: "POST",
      body: { id: "sub:other@test.com:xxx", enabled: false },
    });

    const res = await handlePushDeviceToggle(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("본인 기기를 끄면 devices 목록에 enabled:false로 반영된다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeToken("m5@test.com");
    const deviceId = await subscribeOnce(testEnv, token);

    const toggleReq = makeRequest("https://worker/push/devices/toggle", { token, method: "POST", body: { id: deviceId, enabled: false } });
    const toggleRes = await handlePushDeviceToggle(toggleReq, testEnv, "https://example.com");
    expect(toggleRes.status).toBe(200);

    const listReq = makeRequest("https://worker/push/devices", { token });
    const listRes = await handleListPushDevices(listReq, testEnv, "https://example.com");
    const listBody = await listRes.json();
    expect(listBody.devices[0].enabled).toBe(false);
  });

  it("존재하지 않는 기기를 토글하면 404를 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeToken("m6@test.com");
    const req = makeRequest("https://worker/push/devices/toggle", {
      token,
      method: "POST",
      body: { id: `sub:m6@test.com:nonexistent`, enabled: true },
    });

    const res = await handlePushDeviceToggle(req, testEnv, "https://example.com");
    expect(res.status).toBe(404);
  });

  it("기기 이름을 변경하면 목록에 반영된다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeToken("m7@test.com");
    const deviceId = await subscribeOnce(testEnv, token);

    const renameReq = makeRequest("https://worker/push/devices/rename", {
      token,
      method: "POST",
      body: { id: deviceId, deviceLabel: "내 노트북" },
    });
    const renameRes = await handlePushDeviceRename(renameReq, testEnv, "https://example.com");
    expect(renameRes.status).toBe(200);

    const listReq = makeRequest("https://worker/push/devices", { token });
    const listRes = await handleListPushDevices(listReq, testEnv, "https://example.com");
    const listBody = await listRes.json();
    expect(listBody.devices[0].deviceLabel).toBe("내 노트북");
  });

  it("빈 이름으로 변경 요청하면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeToken("m8@test.com");
    const deviceId = await subscribeOnce(testEnv, token);

    const req = makeRequest("https://worker/push/devices/rename", { token, method: "POST", body: { id: deviceId, deviceLabel: "  " } });
    const res = await handlePushDeviceRename(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("기기를 삭제하면 목록에서 사라진다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeToken("m9@test.com");
    const deviceId = await subscribeOnce(testEnv, token);

    const removeReq = makeRequest("https://worker/push/devices/remove", { token, method: "POST", body: { id: deviceId } });
    const removeRes = await handlePushDeviceRemove(removeReq, testEnv, "https://example.com");
    expect(removeRes.status).toBe(200);

    const listReq = makeRequest("https://worker/push/devices", { token });
    const listRes = await handleListPushDevices(listReq, testEnv, "https://example.com");
    const listBody = await listRes.json();
    expect(listBody.devices).toEqual([]);
  });
});

describe("handlePushSubscriptionStatus", () => {
  it("로그인하지 않으면 401을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const req = makeRequest("https://worker/push/subscription-status");

    const res = await handlePushSubscriptionStatus(req, testEnv, "https://example.com");
    expect(res.status).toBe(401);
  });

  it("회원별 구독 여부를 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "notify-sub-status" });
    const subscribedEmail = "subscribed@test.com";
    const subscribeToken = await makeToken(subscribedEmail);
    await handlePushSubscribe(
      makeRequest("https://worker/push/subscribe", { token: subscribeToken, method: "POST", body: fakeSubscriptionBody() }),
      testEnv,
      "https://example.com"
    );

    const viewerToken = await makeToken("viewer@test.com");
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("V50")) {
          return Promise.resolve(
            dataSheetResponse([
              { number: 1, name: "구독함", email: subscribedEmail },
              { number: 2, name: "구독안함", email: "notsubscribed@test.com" },
            ])
          );
        }
        throw new Error("unexpected fetch: " + u);
      })
    );
    const req = makeRequest("https://worker/push/subscription-status", { token: viewerToken });

    const res = await handlePushSubscriptionStatus(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.items).toEqual([
      { name: "구독함", subscribed: true },
      { name: "구독안함", subscribed: false },
    ]);
  });
});
