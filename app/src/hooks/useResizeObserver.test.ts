// 🔧 [2026-09-22 사용자 지시: "프론트 도구도 보강 확실하게 하자"] —
// AppShell.tsx/TabBar.tsx/ChatPage.tsx가 각자 인라인으로 반복하던
// ResizeObserver 패턴을 통합한 공용 훅인데, jsdom에는 ResizeObserver
// 자체가 없어(Node 콘솔로 확인) 지금까지 이 훅만을 겨냥한 자동 테스트가
// 없었다. 실제 관찰 대상 크기 변화 대신, observer가 콜백에 넘기는
// entries[0]을 그대로 흉내 내는 mock 클래스로 이 훅의 계약(콜백은 항상
// 최신 함수를 참조, 반환값은 조건부 마운트에 안전한 콜백 ref, 언마운트
// 시 disconnect)을 검증한다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useResizeObserver } from "./useResizeObserver";

// 실제 ResizeObserver를 흉내 내는 최소 mock — observe()된 요소별로
// 콜백을 저장해뒀다가, 테스트가 triggerResize()로 직접 호출한다(jsdom은
// 실제 레이아웃 엔진이 없어 크기 변화 자체를 감지할 수 없으므로).
class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  callback: ResizeObserverCallback;
  observedElements: Element[] = [];
  disconnected = false;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }

  observe(element: Element) {
    this.observedElements.push(element);
  }

  unobserve(element: Element) {
    this.observedElements = this.observedElements.filter((el) => el !== element);
  }

  disconnect() {
    this.disconnected = true;
  }

  // 테스트 헬퍼 — 실제로는 브라우저가 리사이즈를 감지해 부르는 콜백을
  // 직접 트리거한다.
  trigger(entry: Partial<ResizeObserverEntry>) {
    this.callback([entry as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

function makeEntry(width: number, height: number): Partial<ResizeObserverEntry> {
  return {
    contentRect: { width, height } as DOMRectReadOnly,
    contentBoxSize: [{ inlineSize: width, blockSize: height }] as unknown as ReadonlyArray<ResizeObserverSize>,
  };
}

afterEach(() => {
  MockResizeObserver.instances = [];
  vi.unstubAllGlobals();
});

describe("useResizeObserver", () => {
  it("반환된 콜백 ref에 요소를 붙이면 ResizeObserver.observe가 그 요소로 호출된다", () => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    const onResize = vi.fn();
    const { result } = renderHook(() => useResizeObserver(onResize));
    const el = document.createElement("div");

    result.current(el);

    expect(MockResizeObserver.instances).toHaveLength(1);
    expect(MockResizeObserver.instances[0].observedElements).toEqual([el]);
  });

  it("observer가 콜백을 부르면 onResize가 entry와 관찰 대상 element를 함께 받는다", () => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    const onResize = vi.fn();
    const { result } = renderHook(() => useResizeObserver(onResize));
    const el = document.createElement("div");
    result.current(el);

    const entry = makeEntry(100, 50);
    MockResizeObserver.instances[0].trigger(entry);

    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(entry, el);
  });

  it("onResize 함수가 리렌더로 바뀌어도 항상 최신 함수를 호출한다(ref 패턴 검증)", () => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    const firstOnResize = vi.fn();
    const secondOnResize = vi.fn();
    const { result, rerender } = renderHook(({ onResize }) => useResizeObserver(onResize), {
      initialProps: { onResize: firstOnResize },
    });
    const el = document.createElement("div");
    result.current(el);

    rerender({ onResize: secondOnResize });

    MockResizeObserver.instances[0].trigger(makeEntry(10, 10));
    expect(firstOnResize).not.toHaveBeenCalled();
    expect(secondOnResize).toHaveBeenCalledTimes(1);
  });

  it("같은 요소에 ref를 다시 붙이면(재마운트) 이전 observer를 disconnect하고 새 observer로 교체한다", () => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    const onResize = vi.fn();
    const { result } = renderHook(() => useResizeObserver(onResize));
    const elA = document.createElement("div");
    const elB = document.createElement("div");

    result.current(elA);
    const firstObserver = MockResizeObserver.instances[0];
    expect(firstObserver.disconnected).toBe(false);

    // React가 콜백 ref를 다른 요소로 재호출하는 상황(조건부 마운트) —
    // 먼저 null로 정리 호출된 뒤 새 요소로 다시 호출되는 것이 React의
    // 실제 콜백 ref 갱신 순서다.
    result.current(null);
    expect(firstObserver.disconnected).toBe(true);

    result.current(elB);
    expect(MockResizeObserver.instances).toHaveLength(2);
    expect(MockResizeObserver.instances[1].observedElements).toEqual([elB]);
  });

  it("훅이 언마운트되면 마지막 observer를 disconnect한다(누수 방지)", () => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    const onResize = vi.fn();
    const { result, unmount } = renderHook(() => useResizeObserver(onResize));
    const el = document.createElement("div");
    result.current(el);

    const observer = MockResizeObserver.instances[0];
    expect(observer.disconnected).toBe(false);
    unmount();
    expect(observer.disconnected).toBe(true);
  });

  it("null이 전달되면 아무 observer도 만들지 않는다(요소가 아직 없는 최초 렌더 대응)", () => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    const onResize = vi.fn();
    const { result } = renderHook(() => useResizeObserver(onResize));

    result.current(null);

    expect(MockResizeObserver.instances).toHaveLength(0);
  });
});
