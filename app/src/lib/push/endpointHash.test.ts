// 🔧 [2026-09-22 사용자 지시: "프론트 도구도 보강 확실하게 하자"] —
// 서버(handlePushSubscribe)의 sha256Hex와 정확히 같은 해시를 브라우저
// 쪽에서 재현해야 "이 브라우저가 기기 목록 중 어느 항목인지" 식별이
// 되므로, 알려진 SHA-256 벡터로 두 구현이 실제로 일치하는 해시를
// 내는지 검증한다(교차 구현 정확성이 핵심 — 이 함수만 단독으로 맞는
// 것보다 서버와 같은 결과를 내는 것 자체가 이 함수의 존재 이유).
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./endpointHash";

describe("sha256Hex", () => {
  it("빈 문자열의 SHA-256을 표준 벡터와 정확히 일치하게 계산한다", async () => {
    // NIST 표준 테스트 벡터(SHA-256 of "").
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("알려진 문자열의 SHA-256을 표준 벡터와 정확히 일치하게 계산한다", async () => {
    // NIST 표준 테스트 벡터(SHA-256 of "abc").
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("결과는 항상 64자 소문자 hex 문자열이다", async () => {
    const hash = await sha256Hex("https://fcm.googleapis.com/fcm/send/abc123");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("입력이 한 글자만 달라도 완전히 다른 해시가 나온다(눈사태 효과)", async () => {
    const a = await sha256Hex("endpoint-a");
    const b = await sha256Hex("endpoint-b");
    expect(a).not.toBe(b);
  });

  it("같은 입력은 항상 같은 해시를 낸다(결정적)", async () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/xyz";
    expect(await sha256Hex(endpoint)).toBe(await sha256Hex(endpoint));
  });
});
