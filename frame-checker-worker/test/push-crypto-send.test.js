// sendWebPush 테스트 — fetch mock으로 실제 POST 요청의 URL/헤더/body가
// 올바르게 구성되는지 검증한다. index.js 내 3곳(관리자 발송 핸들러)에서
// 직접 호출되지만, 다른 곳에서 재export하지 않아 테스트는
// ../src/push-crypto.js에서 직접 import한다.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { base64url, base64urlToBytes } from "../src/index.js";
import { sendWebPush } from "../src/push-crypto.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function makeVapidEnv() {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const jwkPrivate = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  return {
    ...env,
    VAPID_PRIVATE_KEY: jwkPrivate.d,
    VAPID_PUBLIC_KEY: base64url(rawPublic),
    VAPID_SUBJECT: "mailto:test@example.com",
  };
}

async function makeFakeSubscription() {
  const clientKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const clientPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", clientKeyPair.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return {
    endpoint: "https://fcm.googleapis.com/fcm/send/dummy-endpoint-id",
    keys: {
      p256dh: base64url(clientPublicRaw),
      auth: base64url(authSecret),
    },
  };
}

describe("sendWebPush", () => {
  it("VAPID 헤더 + aes128gcm 인코딩으로 정확한 엔드포인트에 POST한다", async () => {
    const testEnv = await makeVapidEnv();
    const subscription = await makeFakeSubscription();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendWebPush(subscription, JSON.stringify({ title: "t" }), testEnv);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(subscription.endpoint);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);
    expect(init.headers["Content-Type"]).toBe("application/octet-stream");
    expect(init.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(init.headers.TTL).toBe("60");
    expect(init.body).toBeInstanceOf(Uint8Array);
    expect(init.body.length).toBeGreaterThan(21);
  });

  it("audience는 subscription.endpoint의 origin과 정확히 일치한다", async () => {
    const testEnv = await makeVapidEnv();
    const subscription = await makeFakeSubscription();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendWebPush(subscription, "payload", testEnv);

    const [, init] = fetchMock.mock.calls[0];
    const jwt = init.headers.Authorization.match(/^vapid t=([^,]+),/)[1];
    const [, encPayload] = jwt.split(".");
    const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(encPayload)));
    expect(payload.aud).toBe("https://fcm.googleapis.com");
  });

  it("fetch 응답을 그대로 반환한다", async () => {
    const testEnv = await makeVapidEnv();
    const subscription = await makeFakeSubscription();
    const fakeResponse = new Response(null, { status: 201 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse));

    const res = await sendWebPush(subscription, "payload", testEnv);
    expect(res).toBe(fakeResponse);
  });
});
