// 🔧 [2026-09-22 사용자 지시: "프론트엔드 테스트 도구도 정비해"] —
// 이전 세션(오프라인 감지/안내 기능 도입)에서 만든 훅인데, 그때도 지금도
// 자동화된 테스트 없이 브라우저에서 눈으로 네트워크를 껐다 켜보는
// 수동 검증에만 의존했다. renderHook으로 이 첫 hooks 테스트를 만든다 —
// 이후 hooks 테스트가 따를 기본 패턴(@testing-library/react의
// renderHook + act로 이벤트 디스패치)이기도 하다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNetworkStatus } from "./useNetworkStatus";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useNetworkStatus", () => {
  it("초기값은 navigator.onLine을 그대로 반영한다(true)", () => {
    vi.stubGlobal("navigator", { onLine: true });
    const { result } = renderHook(() => useNetworkStatus());
    expect(result.current).toBe(true);
  });

  it("초기값은 navigator.onLine을 그대로 반영한다(false)", () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { result } = renderHook(() => useNetworkStatus());
    expect(result.current).toBe(false);
  });

  it("offline 이벤트가 발생하면 false로 바뀐다", () => {
    const { result } = renderHook(() => useNetworkStatus());
    expect(result.current).toBe(true);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(result.current).toBe(false);
  });

  it("offline 이후 online 이벤트가 발생하면 다시 true로 복원된다", () => {
    const { result } = renderHook(() => useNetworkStatus());
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(result.current).toBe(false);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(result.current).toBe(true);
  });

  it("언마운트 후에는 이벤트가 더 이상 상태를 바꾸지 않는다(리스너 정리 확인)", () => {
    const { result, unmount } = renderHook(() => useNetworkStatus());
    unmount();
    // 언마운트된 훅의 setState가 실행되면 React가 경고를 내는데, 리스너가
    // 제대로 정리됐다면애초에 콜백 자체가 호출되지 않아야 한다.
    expect(() => {
      window.dispatchEvent(new Event("offline"));
    }).not.toThrow();
    // 언마운트 이전 마지막 값이 그대로 남아있어야 한다(더 바뀌지 않음).
    expect(result.current).toBe(true);
  });
});
