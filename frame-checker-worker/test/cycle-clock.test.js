// 사이클 판정 중 "지금 몇 시인지"에 의존하는 함수 테스트 — vi.setSystemTime()
// 으로 시계를 고정해 리셋 경계 전후를 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentWeekMondayKST, exitWeekResetPassed, formatYYMMDD } from "../src/index.js";

describe("exitWeekResetPassed", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // exitDate = 2026-09-07(월요일). 그 주의 리셋 시각은 다음 주 월요일
  // (2026-09-14) 06:00 KST == 2026-09-13 21:00 UTC.
  const exitDate = "2026-09-07";
  const resetAtUtcMs = Date.UTC(2026, 8, 13, 21, 0, 0);

  it("리셋 시각 직전에는 false를 반환한다", () => {
    vi.useFakeTimers();
    vi.setSystemTime(resetAtUtcMs - 1);
    expect(exitWeekResetPassed(exitDate)).toBe(false);
  });

  it("리셋 시각 정각에는 true를 반환한다(경계 포함)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(resetAtUtcMs);
    expect(exitWeekResetPassed(exitDate)).toBe(true);
  });

  it("리셋 시각 이후에는 true를 반환한다", () => {
    vi.useFakeTimers();
    vi.setSystemTime(resetAtUtcMs + 24 * 60 * 60 * 1000);
    expect(exitWeekResetPassed(exitDate)).toBe(true);
  });

  it("같은 주 안(리셋 전)에는 언제 조회해도 false다", () => {
    vi.useFakeTimers();
    // exitDate 당일(2026-09-07) 자정 직후.
    vi.setSystemTime(Date.UTC(2026, 8, 6, 15, 0, 1));
    expect(exitWeekResetPassed(exitDate)).toBe(false);
  });
});

describe("currentWeekMondayKST", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("KST 수요일에 조회하면 그 주 월요일을 반환한다", () => {
    // 2026-09-09(수) 10:00 KST == 2026-09-09 01:00 UTC.
    vi.setSystemTime(Date.UTC(2026, 8, 9, 1, 0, 0));
    const monday = currentWeekMondayKST();
    // currentWeekMondayKST()는 "UTC 자정이지만 KST 날짜를 담은" Date를
    // 반환하므로 formatYYMMDD(UTC getter 사용)로 그대로 검증한다.
    expect(formatYYMMDD(monday)).toBe("260907");
  });

  it("KST 월요일 자정 직후에 조회하면 그날 자신을 반환한다", () => {
    // 2026-09-07(월) 00:30 KST == 2026-09-06 15:30 UTC.
    vi.setSystemTime(Date.UTC(2026, 8, 6, 15, 30, 0));
    const monday = currentWeekMondayKST();
    expect(formatYYMMDD(monday)).toBe("260907");
  });

  it("KST 일요일 23:59에 조회해도 그 주(같은 주) 월요일을 반환한다", () => {
    // 2026-09-13(일) 23:59 KST == 2026-09-13 14:59 UTC.
    vi.setSystemTime(Date.UTC(2026, 8, 13, 14, 59, 0));
    const monday = currentWeekMondayKST();
    expect(formatYYMMDD(monday)).toBe("260907");
  });
});
