// 웹푸시 암호화의 HKDF 계열 함수 테스트. RFC 5869 공개 벡터는 전부 출력
// 길이(L)가 32바이트(SHA-256 해시 크기)를 넘어 다중 블록이 필요한데, 이
// hkdfExpand는 카운터를 항상 1로 고정해 1블록(최대 32바이트)만 생성한다
// (RFC 8291이 요구하는 단순화된 형태) — 표준 벡터를 그대로 쓸 수 없어,
// 대신 정의 그대로의 합성 관계를 고정하는 회귀 테스트로 검증한다.
import { describe, expect, it } from "vitest";
import { hkdf, hkdfExpand, hkdfExtract, hmacSha256Raw } from "../src/push-crypto.js";
import { concatBytes } from "../src/pure-utils.js";

describe("hmacSha256Raw", () => {
  it("같은 입력이면 항상 같은 출력을 낸다(결정성)", async () => {
    const key = new Uint8Array([1, 2, 3, 4]);
    const data = new TextEncoder().encode("hello");
    const a = await hmacSha256Raw(key, data);
    const b = await hmacSha256Raw(key, data);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("SHA-256 다이제스트 길이(32바이트)를 반환한다", async () => {
    const mac = await hmacSha256Raw(new Uint8Array([1]), new Uint8Array([2]));
    expect(mac.length).toBe(32);
  });

  it("키가 다르면 출력도 달라진다", async () => {
    const data = new TextEncoder().encode("same data");
    const a = await hmacSha256Raw(new Uint8Array([1, 2, 3]), data);
    const b = await hmacSha256Raw(new Uint8Array([4, 5, 6]), data);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("데이터가 다르면 출력도 달라진다", async () => {
    const key = new Uint8Array([9, 9, 9]);
    const a = await hmacSha256Raw(key, new TextEncoder().encode("data-a"));
    const b = await hmacSha256Raw(key, new TextEncoder().encode("data-b"));
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});

describe("hkdfExtract", () => {
  it("salt를 키로, ikm을 데이터로 한 HMAC-SHA256과 정확히 같다", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const ikm = crypto.getRandomValues(new Uint8Array(32));
    const prk = await hkdfExtract(salt, ikm);
    const expected = await hmacSha256Raw(salt, ikm);
    expect(Array.from(prk)).toEqual(Array.from(expected));
  });
});

describe("hkdfExpand", () => {
  it("info에 카운터 0x01을 붙인 HMAC-SHA256의 앞 length바이트와 같다", async () => {
    const prk = crypto.getRandomValues(new Uint8Array(32));
    const info = new TextEncoder().encode("some-info");
    const length = 16;
    const out = await hkdfExpand(prk, info, length);
    const infoWithCounter = concatBytes([info, new Uint8Array([1])]);
    const expected = (await hmacSha256Raw(prk, infoWithCounter)).slice(0, length);
    expect(Array.from(out)).toEqual(Array.from(expected));
  });

  it("요청한 길이만큼만 잘라 반환한다", async () => {
    const prk = crypto.getRandomValues(new Uint8Array(32));
    const info = new TextEncoder().encode("info");
    expect((await hkdfExpand(prk, info, 12)).length).toBe(12);
    expect((await hkdfExpand(prk, info, 16)).length).toBe(16);
  });
});

describe("hkdf", () => {
  it("hkdfExtract 후 hkdfExpand를 그대로 합성한 것과 같다", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const ikm = crypto.getRandomValues(new Uint8Array(32));
    const info = new TextEncoder().encode("WebPush: info\0");
    const length = 32;

    const out = await hkdf(salt, ikm, info, length);
    const prk = await hkdfExtract(salt, ikm);
    const expected = await hkdfExpand(prk, info, length);

    expect(Array.from(out)).toEqual(Array.from(expected));
  });
});
