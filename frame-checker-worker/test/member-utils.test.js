// 회원 관리/알림·푸시 도메인의 완전 순수 함수 테스트 — fetch/DO/캐시/시계
// 의존이 전혀 없다. buildVapidJwk는 async이지만 crypto.subtle을 전혀 쓰지
// 않는 순수 바이트 슬라이싱/조립이라 다른 순수 함수와 동일하게 취급한다.
import { describe, expect, it } from "vitest";
import {
  buildVapidJwk,
  concatBytes,
  defaultNotifyPrefs,
  guessDeviceLabel,
  parseGoogleEmail,
  parseGooroomeeAccount,
} from "../src/member-utils.js";
import { base64url, NOTIFY_CATEGORIES } from "../src/index.js";

describe("parseGoogleEmail", () => {
  it.each([
    ["a@b.com,gooroomee1", "a@b.com"],
    ["a@b.com", "a@b.com"], // 콤마 없으면 전체가 이메일로 처리
    ["", ""],
    [null, ""],
    ["A@B.COM,gooroomee1", "a@b.com"], // 소문자 변환
    ["  a@b.com  ,gooroomee1", "a@b.com"], // 앞뒤 공백 trim
  ])("parseGoogleEmail(%j) -> %j", (rawCell, expected) => {
    expect(parseGoogleEmail(rawCell)).toBe(expected);
  });
});

describe("parseGooroomeeAccount", () => {
  it.each([
    ["a@b.com,gooroomee1", "gooroomee1"],
    ["a@b.com", ""], // 콤마 없으면 빈 문자열
    ["", ""],
    [null, ""],
    ["a@b.com,  gooroomee1  ", "gooroomee1"], // trim
  ])("parseGooroomeeAccount(%j) -> %j", (rawCell, expected) => {
    expect(parseGooroomeeAccount(rawCell)).toBe(expected);
  });
});

describe("guessDeviceLabel", () => {
  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", "iPhone · Safari"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1", "iPhone · Chrome"],
    ["Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36", "Android · Chrome"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", "Mac · Safari"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", "Mac · Chrome"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0", "Windows · Edge"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0", "Windows · Firefox"],
    ["Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", "iPad · Safari"],
    ["", "알 수 없는 기기"],
    [null, "알 수 없는 기기"],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", "Linux · Chrome"],
  ])("guessDeviceLabel(%j) -> %j", (userAgent, expected) => {
    expect(guessDeviceLabel(userAgent)).toBe(expected);
  });

  it("OS는 감지되지만 브라우저가 감지되지 않으면 브라우저 없이 OS만 반환한다", () => {
    expect(guessDeviceLabel("SomeUnknownBrowser on Windows NT 10.0")).toBe("Windows");
  });
});

describe("defaultNotifyPrefs", () => {
  it("NOTIFY_CATEGORIES의 모든 키가 true로 채워진다", () => {
    const prefs = defaultNotifyPrefs();
    expect(Object.keys(prefs).sort()).toEqual(Object.keys(NOTIFY_CATEGORIES).sort());
    expect(Object.values(prefs).every((v) => v === true)).toBe(true);
  });

  it("키 개수가 NOTIFY_CATEGORIES와 정확히 일치한다(상수 변경 시 회귀 감지)", () => {
    expect(Object.keys(defaultNotifyPrefs())).toHaveLength(Object.keys(NOTIFY_CATEGORIES).length);
  });
});

describe("buildVapidJwk", () => {
  it("65바이트 공개키(0x04 + x32 + y32)를 x/y로 정확히 슬라이스한다", async () => {
    const pub = new Uint8Array(65);
    pub[0] = 0x04; // uncompressed point 접두 바이트
    for (let i = 1; i <= 32; i++) pub[i] = i; // x = 1..32
    for (let i = 33; i <= 64; i++) pub[i] = i; // y = 33..64
    const publicKeyB64url = base64url(pub);

    const jwk = await buildVapidJwk("dummy-private-key", publicKeyB64url);

    expect(jwk.kty).toBe("EC");
    expect(jwk.crv).toBe("P-256");
    expect(jwk.ext).toBe(true);
    expect(jwk.d).toBe("dummy-private-key");

    const expectedX = base64url(pub.slice(1, 33));
    const expectedY = base64url(pub.slice(33, 65));
    expect(jwk.x).toBe(expectedX);
    expect(jwk.y).toBe(expectedY);
    // x와 y가 서로 다른 바이트 구간에서 나왔는지 확인(오프바이원 회귀 방지).
    expect(jwk.x).not.toBe(jwk.y);
  });

  it("privateKeyB64url은 그대로 d 필드로 보존된다", async () => {
    const pub = new Uint8Array(65);
    pub[0] = 0x04;
    const jwk = await buildVapidJwk("some-private-key-value", base64url(pub));
    expect(jwk.d).toBe("some-private-key-value");
  });
});

describe("concatBytes", () => {
  it("빈 배열 목록이면 길이 0인 Uint8Array를 반환한다", () => {
    const result = concatBytes([]);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(0);
  });

  it("배열 1개는 그대로 복사된다", () => {
    const a = new Uint8Array([1, 2, 3]);
    const result = concatBytes([a]);
    expect(Array.from(result)).toEqual([1, 2, 3]);
  });

  it("여러 배열을 순서대로 이어붙이고 길이 합이 정확하다", () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3, 4, 5]);
    const c = new Uint8Array([]);
    const d = new Uint8Array([6]);
    const result = concatBytes([a, b, c, d]);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.length).toBe(6);
  });

  it("원본 배열은 변경되지 않는다(불변성)", () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3, 4]);
    concatBytes([a, b]);
    expect(Array.from(a)).toEqual([1, 2]);
    expect(Array.from(b)).toEqual([3, 4]);
  });
});
