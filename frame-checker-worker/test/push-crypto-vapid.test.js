// createVapidAuthHeader 테스트 — 실제 P-256 ECDSA 키쌍을 생성해
// env.VAPID_PRIVATE_KEY/VAPID_PUBLIC_KEY로 넘기고, 만들어진 JWT의
// header/payload를 디코드해 필드를 확인한 뒤, 그 공개키로 실제
// crypto.subtle.verify를 호출해 서명이 유효한지까지 검증하는 왕복 테스트.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base64url, base64urlToBytes } from "../src/index.js";
import { createVapidAuthHeader } from "../src/push-crypto.js";

async function makeVapidKeyPair() {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)); // 65바이트
  const jwkPrivate = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  return {
    publicKeyB64url: base64url(rawPublic),
    privateKeyB64url: jwkPrivate.d,
    verifyKey: keyPair.publicKey,
  };
}

describe("createVapidAuthHeader", () => {
  it("Authorization 헤더가 'vapid t=<jwt>, k=<publicKey>' 형식이다", async () => {
    const { publicKeyB64url, privateKeyB64url } = await makeVapidKeyPair();
    const testEnv = {
      ...env,
      VAPID_PRIVATE_KEY: privateKeyB64url,
      VAPID_PUBLIC_KEY: publicKeyB64url,
      VAPID_SUBJECT: "mailto:test@example.com",
    };

    const headers = await createVapidAuthHeader(testEnv, "https://fcm.googleapis.com");
    const match = headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
    expect(match).not.toBeNull();
    expect(match[2]).toBe(publicKeyB64url);
  });

  it("JWT header/payload가 정확한 필드를 담고 있다", async () => {
    const { publicKeyB64url, privateKeyB64url } = await makeVapidKeyPair();
    const testEnv = {
      ...env,
      VAPID_PRIVATE_KEY: privateKeyB64url,
      VAPID_PUBLIC_KEY: publicKeyB64url,
      VAPID_SUBJECT: "mailto:test@example.com",
    };

    const headers = await createVapidAuthHeader(testEnv, "https://fcm.googleapis.com");
    const jwt = headers.Authorization.match(/^vapid t=([^,]+),/)[1];
    const [encHeader, encPayload] = jwt.split(".");

    const header = JSON.parse(new TextDecoder().decode(base64urlToBytes(encHeader)));
    const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(encPayload)));

    expect(header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(payload.aud).toBe("https://fcm.googleapis.com");
    expect(payload.sub).toBe("mailto:test@example.com");
    // exp는 "지금 + 12시간" 근사치 — 정확한 시각 고정 대신 오차 허용.
    const nowSec = Math.floor(Date.now() / 1000);
    expect(payload.exp - nowSec).toBeGreaterThan(12 * 60 * 60 - 5);
    expect(payload.exp - nowSec).toBeLessThanOrEqual(12 * 60 * 60);
  });

  it("생성된 JWT 서명이 실제로 그 공개키로 검증된다(왕복 검증)", async () => {
    const { publicKeyB64url, privateKeyB64url, verifyKey } = await makeVapidKeyPair();
    const testEnv = {
      ...env,
      VAPID_PRIVATE_KEY: privateKeyB64url,
      VAPID_PUBLIC_KEY: publicKeyB64url,
      VAPID_SUBJECT: "mailto:test@example.com",
    };

    const headers = await createVapidAuthHeader(testEnv, "https://fcm.googleapis.com");
    const jwt = headers.Authorization.match(/^vapid t=([^,]+),/)[1];
    const [encHeader, encPayload, encSig] = jwt.split(".");

    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifyKey,
      base64urlToBytes(encSig),
      new TextEncoder().encode(`${encHeader}.${encPayload}`)
    );
    expect(valid).toBe(true);
  });

  it("다른 키쌍의 공개키로 검증하면 실패한다(서명 위조 방지 확인)", async () => {
    const { publicKeyB64url, privateKeyB64url } = await makeVapidKeyPair();
    const otherPair = await makeVapidKeyPair(); // 검증에 쓸 엉뚱한 공개키
    const testEnv = {
      ...env,
      VAPID_PRIVATE_KEY: privateKeyB64url,
      VAPID_PUBLIC_KEY: publicKeyB64url,
      VAPID_SUBJECT: "mailto:test@example.com",
    };

    const headers = await createVapidAuthHeader(testEnv, "https://fcm.googleapis.com");
    const jwt = headers.Authorization.match(/^vapid t=([^,]+),/)[1];
    const [encHeader, encPayload, encSig] = jwt.split(".");

    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      otherPair.verifyKey,
      base64urlToBytes(encSig),
      new TextEncoder().encode(`${encHeader}.${encPayload}`)
    );
    expect(valid).toBe(false);
  });
});
