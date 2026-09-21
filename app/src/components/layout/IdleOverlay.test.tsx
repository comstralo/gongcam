// 🔧 [2026-09-22 사용자 지시: "계속 진행해"(프론트 테스트 도구 보강
// 3차)] — 이미 테스트된 idleTracker(useIsIdle) 모듈을 실제로 소비하는
// 화면 단위 검증. idleTracker.ts는 import 시점에 즉시 setInterval을
// 걸고 모듈 스코프 상태를 만드는 구조(idleTracker.test.ts 상단 주석
// 참고)라, 이 파일에서도 동일하게 vi.resetModules() + 동적 import로
// 매 테스트마다 격리된 인스턴스를 받는다 — IDLE_ENTER_EVENT/
// IDLE_WAKE_EVENT를 직접 디스패치해 오버레이의 표시(aria-hidden,
// opacity, pointerEvents)를 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type { IdleOverlay as IdleOverlayComponent } from "./IdleOverlay";

async function freshIdleOverlay(): Promise<{
  IdleOverlay: typeof IdleOverlayComponent;
  IDLE_ENTER_EVENT: string;
  IDLE_WAKE_EVENT: string;
}> {
  vi.resetModules();
  const idleTracker = await import("@/lib/idleTracker");
  const { IdleOverlay } = await import("./IdleOverlay");
  return { IdleOverlay, IDLE_ENTER_EVENT: idleTracker.IDLE_ENTER_EVENT, IDLE_WAKE_EVENT: idleTracker.IDLE_WAKE_EVENT };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("IdleOverlay", () => {
  it("초기 상태(유휴 아님)에서는 aria-hidden이고 클릭을 가로채지 않는다", async () => {
    const { IdleOverlay } = await freshIdleOverlay();
    render(<IdleOverlay />);
    const overlay = screen.getByText("자동 새로고침을 잠시 멈췄어요").closest("[aria-hidden]");
    expect(overlay).toHaveAttribute("aria-hidden", "true");
    expect(overlay).toHaveStyle({ opacity: "0", pointerEvents: "none" });
  });

  it("IDLE_ENTER_EVENT가 발생하면 오버레이가 보이고 클릭을 가로챈다", async () => {
    const { IdleOverlay, IDLE_ENTER_EVENT } = await freshIdleOverlay();
    render(<IdleOverlay />);

    act(() => {
      window.dispatchEvent(new Event(IDLE_ENTER_EVENT));
    });

    const overlay = screen.getByText("자동 새로고침을 잠시 멈췄어요").closest("[aria-hidden]");
    expect(overlay).toHaveAttribute("aria-hidden", "false");
    expect(overlay).toHaveStyle({ opacity: "1", pointerEvents: "auto" });
  });

  it("IDLE_WAKE_EVENT가 발생하면 다시 숨겨진다", async () => {
    const { IdleOverlay, IDLE_ENTER_EVENT, IDLE_WAKE_EVENT } = await freshIdleOverlay();
    render(<IdleOverlay />);

    act(() => {
      window.dispatchEvent(new Event(IDLE_ENTER_EVENT));
    });
    act(() => {
      window.dispatchEvent(new Event(IDLE_WAKE_EVENT));
    });

    const overlay = screen.getByText("자동 새로고침을 잠시 멈췄어요").closest("[aria-hidden]");
    expect(overlay).toHaveAttribute("aria-hidden", "true");
  });

  it("실제 유휴 임계값(idleTracker의 판정 로직)을 넘기면 자동으로 표시된다(통합 경로)", async () => {
    const { IdleOverlay } = await freshIdleOverlay();
    const { IDLE_THRESHOLD_MS } = await import("@/lib/idleTracker");
    render(<IdleOverlay />);

    act(() => {
      vi.advanceTimersByTime(IDLE_THRESHOLD_MS + 2_000);
    });

    const overlay = screen.getByText("자동 새로고침을 잠시 멈췄어요").closest("[aria-hidden]");
    expect(overlay).toHaveAttribute("aria-hidden", "false");
  });
});
