// "Date.now() 기반 KST 시각 경계 판정" 함수 테스트 — isSettlementVisibleToMembers
// (상금 공개 시각)와 exitDateSettled(퇴실 동의 가능 시점).
import { afterEach, describe, expect, it, vi } from "vitest";
import { exitDateSettled, isSettlementVisibleToMembers } from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("isSettlementVisibleToMembers", () => {
  it("일요일 23:29 KST -> false(경계 직전)", () => {
    // 2026-09-13(일) 23:29 KST == 2026-09-13 14:29 UTC.
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 13, 14, 29, 0));
    expect(isSettlementVisibleToMembers()).toBe(false);
  });

  it("일요일 23:30 KST -> true(경계 정확히)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 13, 14, 30, 0));
    expect(isSettlementVisibleToMembers()).toBe(true);
  });

  it("일요일 23:31 KST -> true", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 13, 14, 31, 0));
    expect(isSettlementVisibleToMembers()).toBe(true);
  });

  it("일요일 오후 3시(23:30 이전 다른 시각) -> false", () => {
    vi.useFakeTimers();
    // 2026-09-13(일) 15:00 KST == 2026-09-13 06:00 UTC.
    vi.setSystemTime(Date.UTC(2026, 8, 13, 6, 0, 0));
    expect(isSettlementVisibleToMembers()).toBe(false);
  });

  it("월~토 임의 시각(요일 자체가 다름) -> false", () => {
    vi.useFakeTimers();
    // 2026-09-09(수) 23:59 KST == 2026-09-09 14:59 UTC.
    vi.setSystemTime(Date.UTC(2026, 8, 9, 14, 59, 0));
    expect(isSettlementVisibleToMembers()).toBe(false);
  });

  it("UTC 토요일 15:00 == KST 일요일 00:00 경계에서도 day 판정이 KST 기준으로 정확하다", () => {
    // UTC 2026-09-12(토) 15:00 == KST 2026-09-13(일) 00:00. 아직 23:30 전이라 false.
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 12, 15, 0, 0));
    expect(isSettlementVisibleToMembers()).toBe(false);
  });
});

describe("exitDateSettled", () => {
  it.each([[""], [null], ["2026/09/07"], ["invalid"]])("exitDate=%s(형식 불일치) -> false", (exitDate) => {
    expect(exitDateSettled(exitDate)).toBe(false);
  });

  // exitDate = 2026-09-07(월) 00:00 KST == 2026-09-06 15:00 UTC.
  // settledAt = 그 시각 + 26시간 = 2026-09-07 17:00 UTC == 2026-09-08 02:00 KST.
  const exitDate = "2026-09-07";
  const settledAtUtcMs = Date.UTC(2026, 8, 7, 17, 0, 0);

  it("exitDate 다음날 새벽 2시(KST) 정각에 true(경계 포함)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(settledAtUtcMs);
    expect(exitDateSettled(exitDate)).toBe(true);
  });

  it("새벽 1시 59분에는 아직 false", () => {
    vi.useFakeTimers();
    vi.setSystemTime(settledAtUtcMs - 60_000);
    expect(exitDateSettled(exitDate)).toBe(false);
  });

  it("exitDate 당일 아무리 늦은 시각(23:59)이어도 아직 false(다음날 2시가 안 지남)", () => {
    // 2026-09-07(월) 23:59 KST == 2026-09-07 14:59 UTC.
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 7, 14, 59, 0));
    expect(exitDateSettled(exitDate)).toBe(false);
  });

  it("경계 이후(다음날 새벽 2시보다 한참 지난 시각)에도 true 유지", () => {
    vi.useFakeTimers();
    vi.setSystemTime(settledAtUtcMs + 24 * 60 * 60 * 1000);
    expect(exitDateSettled(exitDate)).toBe(true);
  });
});
