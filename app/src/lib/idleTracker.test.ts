// 🔧 [2026-09-22 사용자 지시: "프론트 도구도 보강 확실하게 하자"] —
// 이 모듈은 최상단 코드(55~68행)가 import되는 즉시 실행되어 전역
// setInterval과 모듈 스코프 변수(lastActivityAt/wasIdle)를 만든다 —
// React 생명주기와 무관하게 "이 모듈이 로드되는 순간 단 한 번"만
// 리스너를 걸기 위한 의도적 설계(파일 상단 주석)다. 이 때문에 일반
// import로는 테스트 간 모듈 상태가 공유되어 격리가 안 되므로, 매
// 테스트마다 vi.resetModules() + 동적 import로 완전히 새 모듈
// 인스턴스를 받는다 — 그래야 "방금 로드됐다"는 전제(lastActivityAt이
// 로드 시각으로 초기화됨)를 재현할 수 있다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function freshModule() {
  vi.resetModules();
  return await import("./idleTracker");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isIdle", () => {
  it("모듈이 막 로드된 직후에는 idle이 아니다(로드 시각을 최초 활동 시각으로 초기화)", async () => {
    const { isIdle } = await freshModule();
    expect(isIdle()).toBe(false);
  });

  it("IDLE_THRESHOLD_MS 미만이 지나면 여전히 idle이 아니다", async () => {
    const { isIdle, IDLE_THRESHOLD_MS } = await freshModule();
    vi.advanceTimersByTime(IDLE_THRESHOLD_MS - 1);
    expect(isIdle()).toBe(false);
  });

  it("IDLE_THRESHOLD_MS가 정확히 지나면 idle이다(경계 포함)", async () => {
    const { isIdle, IDLE_THRESHOLD_MS } = await freshModule();
    vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
    expect(isIdle()).toBe(true);
  });

  it("활동 이벤트(mousemove 등)가 발생하면 유휴 판정이 리셋된다", async () => {
    const { isIdle, IDLE_THRESHOLD_MS } = await freshModule();
    vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
    expect(isIdle()).toBe(true);

    window.dispatchEvent(new Event("mousemove"));
    expect(isIdle()).toBe(false);
  });

  it("scroll/keydown/click/touchstart 이벤트도 모두 활동으로 인정한다", async () => {
    const { isIdle, IDLE_THRESHOLD_MS } = await freshModule();
    for (const eventName of ["scroll", "keydown", "click", "touchstart"]) {
      vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
      expect(isIdle()).toBe(true);
      window.dispatchEvent(new Event(eventName));
      expect(isIdle()).toBe(false);
    }
  });
});

describe("IDLE_ENTER_EVENT/IDLE_WAKE_EVENT", () => {
  it("유휴 임계값을 넘기면 IDLE_ENTER_EVENT가 정확히 한 번 발생한다", async () => {
    const { IDLE_ENTER_EVENT, IDLE_THRESHOLD_MS } = await freshModule();
    const onEnter = vi.fn();
    window.addEventListener(IDLE_ENTER_EVENT, onEnter);

    vi.advanceTimersByTime(IDLE_THRESHOLD_MS + 2_000);
    expect(onEnter).toHaveBeenCalledTimes(1);

    window.removeEventListener(IDLE_ENTER_EVENT, onEnter);
  });

  it("유휴 상태에서 활동이 발생하면 다음 판정 주기에 IDLE_WAKE_EVENT가 발생한다", async () => {
    const { IDLE_ENTER_EVENT, IDLE_WAKE_EVENT, IDLE_THRESHOLD_MS } = await freshModule();
    const onWake = vi.fn();
    window.addEventListener(IDLE_ENTER_EVENT, () => {});
    window.addEventListener(IDLE_WAKE_EVENT, onWake);

    vi.advanceTimersByTime(IDLE_THRESHOLD_MS + 2_000); // idle 진입.
    window.dispatchEvent(new Event("click")); // 활동 발생 — 다음 판정 주기까지는 아직 wasIdle=true.
    vi.advanceTimersByTime(2_000); // 판정 주기(1.5초)가 한 번 더 돌아 WAKE를 발행해야 한다.

    expect(onWake).toHaveBeenCalledTimes(1);
    window.removeEventListener(IDLE_WAKE_EVENT, onWake);
  });

  it("이미 활동 중인(idle 아닌) 상태가 계속 유지되는 동안에는 이벤트를 반복 발생시키지 않는다", async () => {
    const { IDLE_ENTER_EVENT } = await freshModule();
    const onEnter = vi.fn();
    window.addEventListener(IDLE_ENTER_EVENT, onEnter);

    // 임계값 근처까지 여러 판정 주기를 거치되 계속 활동을 유지한다.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1_500);
      window.dispatchEvent(new Event("mousemove"));
    }
    expect(onEnter).not.toHaveBeenCalled();

    window.removeEventListener(IDLE_ENTER_EVENT, onEnter);
  });
});
