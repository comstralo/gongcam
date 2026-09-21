// 🔧 [2026-09-22 사용자 지시: "프론트 도구도 보강 확실하게 하자"] —
// 백엔드 date-utils.js/exit-timing.js와 같은 계열의 "KST 자정 경계"
// 로직이지만, 이 훅은 Intl.DateTimeFormat(브라우저가 사용자 기기의
// 임의 시간대에 있을 수 있어 UTC+9 트릭이 안 통함)으로 완전히 다르게
// 구현되어 독립적인 검증이 필요하다. 자정에 맞춰 정확히 재계산되는지
// (자정 근처 setTimeout 스케줄링)까지 vi.useFakeTimers()로 검증한다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTodayIndex } from "./useTodayIndex";

afterEach(() => {
  vi.useRealTimers();
});

describe("useTodayIndex", () => {
  it("KST 수요일이면 인덱스 2(월=0 기준)를 반환한다", () => {
    vi.useFakeTimers();
    // 2026-09-09(수) 10:00 KST == 2026-09-09 01:00 UTC.
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 9, 1, 0, 0)));
    const { result } = renderHook(() => useTodayIndex());
    expect(result.current).toBe(2);
  });

  it("KST 일요일이면 인덱스 6을 반환한다", () => {
    vi.useFakeTimers();
    // 2026-09-13(일) 10:00 KST == 2026-09-13 01:00 UTC.
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 13, 1, 0, 0)));
    const { result } = renderHook(() => useTodayIndex());
    expect(result.current).toBe(6);
  });

  it("UTC로는 아직 전날이지만 KST로는 이미 다음날인 경계에서 KST 기준 요일을 반환한다", () => {
    vi.useFakeTimers();
    // 2026-09-09(수) 20:00 UTC == 2026-09-10(목) 05:00 KST.
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 9, 20, 0, 0)));
    const { result } = renderHook(() => useTodayIndex());
    expect(result.current).toBe(3); // 목요일.
  });

  it("KST 자정을 넘기면 자동으로 다음날 인덱스로 갱신된다(자정 타이머 검증)", () => {
    vi.useFakeTimers();
    // 2026-09-09(수) 23:59:56 KST == 2026-09-09 14:59:56 UTC.
    // 자정까지 4초 + 5초 여유 = 9초 뒤에 타이머가 발화해야 한다.
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 9, 14, 59, 56)));
    const { result } = renderHook(() => useTodayIndex());
    expect(result.current).toBe(2); // 아직 수요일.

    act(() => {
      vi.advanceTimersByTime(9000);
    });
    expect(result.current).toBe(3); // 자정을 넘겨 목요일로 갱신.
  });

  it("자정 타이머가 발화한 뒤 다음 자정을 위한 타이머를 다시 건다(연속 갱신 검증)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 9, 14, 59, 56)));
    const { result } = renderHook(() => useTodayIndex());
    expect(result.current).toBe(2);

    // 첫 번째 자정.
    act(() => {
      vi.advanceTimersByTime(9000);
    });
    expect(result.current).toBe(3);

    // 다음날 자정까지 정확히 24시간을 더 흘려도 또 갱신되어야 한다 —
    // 타이머가 재귀적으로 다시 걸리지 않으면(useEffect의 [todayIndex]
    // 의존성이 빠지면) 이 두 번째 갱신이 일어나지 않는다.
    act(() => {
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    });
    expect(result.current).toBe(4); // 금요일.
  });

  it("언마운트 시 예약된 자정 타이머를 정리한다(누수 방지)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 9, 14, 59, 56)));
    const { unmount } = renderHook(() => useTodayIndex());
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });
});
