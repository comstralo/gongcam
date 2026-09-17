// 🔧 [구조 개선, 2026-09-13] 웹푸시 암호화/발송 함수 7개를 index.js에서
// 분리했다(docs/TESTING.md 참고). 4차에서는 "RFC 8291/5869 표준 구현이라
// it.each 대신 표준 벡터/왕복 검증이 필요해 테스트 성격이 다르다"는 이유로
// 제외했으나, 이번엔 별도 전략(표준 벡터 대신 정의상 합성 관계 검증 +
// 암호화→복호화 왕복 검증)으로 착수한다. @cloudflare/vitest-plugin은 실제
// workerd 런타임이라 crypto.subtle이 mock 없이 그대로 동작한다.
import { base64url, base64urlToBytes } from "./index.js";
import { buildVapidJwk, concatBytes } from "./pure-utils.js";

export async function hmacSha256Raw(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, dataBytes));
}

export async function hkdfExtract(salt, ikm) {
  return hmacSha256Raw(salt, ikm);
}

export async function hkdfExpand(prk, info, length) {
  const infoWithCounter = concatBytes([info, new Uint8Array([1])]);
  const t1 = await hmacSha256Raw(prk, infoWithCounter);
  return t1.slice(0, length);
}

export async function hkdf(salt, ikm, info, length) {
  const prk = await hkdfExtract(salt, ikm);
  return hkdfExpand(prk, info, length);
}

export async function createVapidAuthHeader(env, audience) {
  const jwk = await buildVapidJwk(env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY);
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const header = { typ: "JWT", alg: "ES256" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: audience,
    exp: now + 12 * 60 * 60,
    sub: env.VAPID_SUBJECT,
  };
  const encHeader = base64url(new TextEncoder().encode(JSON.stringify(header)));
  const encPayload = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signInput = `${encHeader}.${encPayload}`;

  const sigDer = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signInput)
  );
  // Web Crypto ECDSA 서명은 이미 raw (r||s) 64바이트 포맷으로 반환된다.
  const jwt = `${signInput}.${base64url(sigDer)}`;

  return {
    Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
  };
}

export async function encryptPushPayload(payloadText, subscription, env) {
  // RFC 8291 (aes128gcm) 최소 구현
  const p256dh = base64urlToBytes(subscription.keys.p256dh);
  const authSecret = base64urlToBytes(subscription.keys.auth);

  const localKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const localPublicRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", localKeyPair.publicKey)
  );

  const clientPublicKey = await crypto.subtle.importKey(
    "raw",
    p256dh,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: clientPublicKey },
      localKeyPair.privateKey,
      256
    )
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));

  const authInfo = concatBytes([
    new TextEncoder().encode("WebPush: info\0"),
    p256dh,
    localPublicRaw,
  ]);
  const ikm = await hkdf(authSecret, sharedSecret, authInfo, 32);

  const prk = await hkdfExtract(salt, ikm);
  const cekInfo = new TextEncoder().encode("Content-Encoding: aes128gcm\0");
  const cek = await hkdfExpand(prk, cekInfo, 16);
  const nonceInfo = new TextEncoder().encode("Content-Encoding: nonce\0");
  const nonce = await hkdfExpand(prk, nonceInfo, 12);

  // RFC 8188 구분자: 마지막(유일한) 레코드이므로 0x02. 0x00은 유효하지 않아
  // 수신측이 복호화에 실패해 메시지를 조용히 폐기하는 원인이 된다.
  const recordDelimiter = new Uint8Array([2]);
  const plaintext = concatBytes([new TextEncoder().encode(payloadText), recordDelimiter]);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext)
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096, false);
  const header = concatBytes([
    salt,
    recordSize,
    new Uint8Array([localPublicRaw.length]),
    localPublicRaw,
  ]);

  return concatBytes([header, ciphertext]);
}

export async function sendWebPush(subscription, payloadText, env) {
  const endpointUrl = new URL(subscription.endpoint);
  const audience = `${endpointUrl.protocol}//${endpointUrl.host}`;
  const vapidHeaders = await createVapidAuthHeader(env, audience);
  const body = await encryptPushPayload(payloadText, subscription, env);

  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      ...vapidHeaders,
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: "60",
    },
    body,
  });
  return res;
}
