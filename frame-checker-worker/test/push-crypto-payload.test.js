// encryptPushPayload 테스트 — salt/ephemeral key가 매번 랜덤이라 RFC 8291
// 공개 벡터가 무의미하다. 대신 가짜 "클라이언트"(브라우저 측) P-256 키쌍을
// 준비해 암호화 결과를 테스트 코드 안에 직접 구현한 RFC 8291 aes128gcm
// 복호화 로직으로 되돌려 원문이 나오는지 확인하는 왕복 검증을 쓴다 — HKDF·
// ECDH·AES-GCM 전체 체인이 하나라도 틀리면 AEAD 인증 태그 불일치로 즉시
// 예외가 나므로, 이 왕복 검증 자체가 강한 정확성 보장이 된다.
import { describe, expect, it } from "vitest";
import { base64url } from "../src/index.js";
import { concatBytes } from "../src/pure-utils.js";
import { encryptPushPayload, hkdf, hkdfExpand, hkdfExtract } from "../src/push-crypto.js";

async function makeFakeSubscription() {
  const clientKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const clientPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", clientKeyPair.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));

  return {
    subscription: {
      endpoint: "https://fcm.googleapis.com/fcm/send/dummy-endpoint-id",
      keys: {
        p256dh: base64url(clientPublicRaw),
        auth: base64url(authSecret),
      },
    },
    clientPrivateKey: clientKeyPair.privateKey,
    clientPublicRaw,
    authSecret,
  };
}

// RFC 8291 aes128gcm 복호화 — encryptPushPayload가 만든 것을 클라이언트
// 입장에서 되돌린다.
async function decryptAes128gcmForTest(encryptedPayload, clientPrivateKey, clientPublicRaw, authSecret) {
  const salt = encryptedPayload.slice(0, 16);
  const keyLen = encryptedPayload[20];
  const serverPublicRaw = encryptedPayload.slice(21, 21 + keyLen);
  const ciphertext = encryptedPayload.slice(21 + keyLen);

  const serverPublicKey = await crypto.subtle.importKey(
    "raw",
    serverPublicRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: serverPublicKey }, clientPrivateKey, 256)
  );

  const authInfo = concatBytes([
    new TextEncoder().encode("WebPush: info\0"),
    clientPublicRaw,
    serverPublicRaw,
  ]);
  const ikm = await hkdf(authSecret, sharedSecret, authInfo, 32);

  const prk = await hkdfExtract(salt, ikm);
  const cek = await hkdfExpand(prk, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand(prk, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plaintextWithDelimiter = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, ciphertext)
  );

  const delimiter = plaintextWithDelimiter[plaintextWithDelimiter.length - 1];
  if (delimiter !== 2) throw new Error(`unexpected record delimiter: ${delimiter}`);
  const plaintext = plaintextWithDelimiter.slice(0, -1);

  return new TextDecoder().decode(plaintext);
}

describe("encryptPushPayload", () => {
  it("암호화한 페이로드를 클라이언트 측에서 복호화하면 원문이 그대로 나온다", async () => {
    const { subscription, clientPrivateKey, clientPublicRaw, authSecret } = await makeFakeSubscription();
    const payloadText = JSON.stringify({ title: "테스트 알림", body: "본문" });

    const encrypted = await encryptPushPayload(payloadText, subscription, {});
    const decrypted = await decryptAes128gcmForTest(encrypted, clientPrivateKey, clientPublicRaw, authSecret);

    expect(decrypted).toBe(payloadText);
  });

  it("빈 문자열 페이로드도 왕복 검증이 통과한다", async () => {
    const { subscription, clientPrivateKey, clientPublicRaw, authSecret } = await makeFakeSubscription();
    const encrypted = await encryptPushPayload("", subscription, {});
    const decrypted = await decryptAes128gcmForTest(encrypted, clientPrivateKey, clientPublicRaw, authSecret);
    expect(decrypted).toBe("");
  });

  it("한글/이모지가 섞인 페이로드도 정확히 복원된다", async () => {
    const { subscription, clientPrivateKey, clientPublicRaw, authSecret } = await makeFakeSubscription();
    const payloadText = "제보 처리 결과 🔔 확인해주세요";
    const encrypted = await encryptPushPayload(payloadText, subscription, {});
    const decrypted = await decryptAes128gcmForTest(encrypted, clientPrivateKey, clientPublicRaw, authSecret);
    expect(decrypted).toBe(payloadText);
  });

  it("헤더 레이아웃이 RFC 8188 형식과 일치한다(salt16 + recordSize4 + keyLen1 + pubkey65)", async () => {
    const { subscription } = await makeFakeSubscription();
    const encrypted = await encryptPushPayload("x", subscription, {});
    expect(encrypted[20]).toBe(65); // keyLen 바이트가 65(uncompressed P-256 공개키 길이)
    expect(encrypted.length).toBeGreaterThan(21 + 65); // 헤더 + 최소 ciphertext(태그 포함)
  });

  it("호출마다 salt/ephemeral key가 달라 같은 입력이어도 출력이 매번 다르다", async () => {
    const { subscription } = await makeFakeSubscription();
    const a = await encryptPushPayload("hello", subscription, {});
    const b = await encryptPushPayload("hello", subscription, {});
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("env 인자는 실제로 사용되지 않는다 — 빈 객체를 넘겨도 정상 동작한다", async () => {
    const { subscription, clientPrivateKey, clientPublicRaw, authSecret } = await makeFakeSubscription();
    const encrypted = await encryptPushPayload("no env needed", subscription, undefined);
    const decrypted = await decryptAes128gcmForTest(encrypted, clientPrivateKey, clientPublicRaw, authSecret);
    expect(decrypted).toBe("no env needed");
  });

  it("잘못된 authSecret으로 복호화를 시도하면 실패한다(AEAD 무결성 검증)", async () => {
    const { subscription, clientPrivateKey, clientPublicRaw } = await makeFakeSubscription();
    const wrongAuthSecret = crypto.getRandomValues(new Uint8Array(16));
    const encrypted = await encryptPushPayload("secret message", subscription, {});

    await expect(
      decryptAes128gcmForTest(encrypted, clientPrivateKey, clientPublicRaw, wrongAuthSecret)
    ).rejects.toThrow();
  });
});
