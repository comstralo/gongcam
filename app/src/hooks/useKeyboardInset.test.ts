// 🔧 [2026-09-22 사용자 지시: "프론트 도구도 보강 확실하게 하자"] —
// 이 세션 전체에서 가장 많이 다룬 파일이지만(v버튼 위치, 뷰포트 높이
// 보정, PWA standalone 가드 등 반복 수정), 지금까지 tests/e2e/의
// Playwright 시뮬레이션(fixtures.ts의 injectPwaStandalone/
// injectKeyboardUp)으로만 간접 검증됐다 — 브라우저 전체를 띄워야 하는
// 무거운 경로였다. jsdom에는 window.visualViewport/matchMedia/
// navigator.standalone이 전혀 없으므로(Node 콘솔로 확인) 전부 직접
// mock해야 한다 — E2E fixtures.ts가 이미 검증한 "이 두 신호 중 하나만
// 있어도 PWA로 판정된다"는 계약, "offsetTop>0일 때만 실제
// visualViewport.height를 쓰고 그 외엔 screen 기반 추정치를 쓴다"는
// 계약을 그대로 vitest로 이식한다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDocumentHeightFix, useSafeAreaInsetBottom, useSafeAreaInsetTop, useVisualViewportRect } from "./useKeyboardInset";

// matchMedia를 "display-mode: standalone" 쿼리에만 matches를 원하는
// 값으로 응답하도록 mock한다(그 외 쿼리는 항상 false) — 이 훅들이
// 실제로 참조하는 유일한 미디어 쿼리이므로 그 이상은 흉내 낼 필요가 없다.
function stubMatchMedia(standaloneMatches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("display-mode: standalone") ? standaloneMatches : false,
      media: query,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
      onchange: null,
    }))
  );
}

// window.visualViewport를 최소 구현으로 mock한다 — 이 훅들이 실제로
// 읽는 필드(offsetTop/height)와 리스너 등록(addEventListener/
// removeEventListener)만 있으면 충분하다. update()를 직접 호출해
// 리스너에 등록된 콜백을 흉내 낸다(실제 브라우저의 visualViewport
// resize/scroll 이벤트를 jsdom이 발생시킬 수 없으므로).
type FakeVisualViewport = {
  offsetTop: number;
  height: number;
  listeners: Record<string, (() => void)[]>;
  addEventListener: (type: string, cb: () => void) => void;
  removeEventListener: (type: string, cb: () => void) => void;
  fire: (type: string) => void;
};

function stubVisualViewport(offsetTop: number, height: number): FakeVisualViewport {
  const listeners: Record<string, (() => void)[]> = { resize: [], scroll: [] };
  const fake: FakeVisualViewport = {
    offsetTop,
    height,
    listeners,
    addEventListener: (type, cb) => {
      listeners[type]?.push(cb);
    },
    removeEventListener: (type, cb) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== cb);
    },
    fire: (type) => {
      listeners[type]?.forEach((cb) => cb());
    },
  };
  vi.stubGlobal("visualViewport", fake);
  return fake;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty("height");
  document.body.style.removeProperty("height");
});

describe("useSafeAreaInsetTop/useSafeAreaInsetBottom", () => {
  it("jsdom은 env()를 해석하지 못해 항상 0을 반환한다(회귀 시 실제 브라우저 값이 필요함을 알리는 표식)", () => {
    // 🔧 이 테스트는 "정상 동작"을 검증하는 게 아니라 "이 환경의 한계"를
    // 문서화한다 — jsdom이 CSS env()를 지원하게 되거나 폴리필이
    // 추가되면 이 값이 바뀔 수 있고, 그때는 실제 안전영역 값을 mock하는
    // 테스트로 교체해야 한다는 신호가 된다.
    const { result } = renderHook(() => useSafeAreaInsetTop());
    expect(result.current).toBe(0);
  });

  it("useSafeAreaInsetBottom도 동일하게 0을 반환한다", () => {
    const { result } = renderHook(() => useSafeAreaInsetBottom());
    expect(result.current).toBe(0);
  });

  it("언마운트 시 프로브 엘리먼트를 DOM에서 제거한다(누수 방지)", () => {
    // 🔧 renderHook 자체가 마운트용 컨테이너 <div>를 document.body에
    // 붙이므로(RTL 구현 세부사항, unmount()해도 이 컨테이너 자체는
    // 안 지워짐), 그 컨테이너와 훅이 직접 만드는 프로브(fixed 포지션
    // 별도 div)를 구분해 프로브만 셀렉터로 세야 정확하다 — 이 훅의
    // 프로브는 style.position="fixed"로 만들어지므로 그 값으로 식별한다.
    const countProbes = () =>
      Array.from(document.body.children).filter((el) => (el as HTMLElement).style.position === "fixed").length;
    const before = countProbes();
    const { unmount } = renderHook(() => useSafeAreaInsetTop());
    expect(countProbes()).toBe(before + 1);
    unmount();
    expect(countProbes()).toBe(before);
  });
});

describe("useDocumentHeightFix — isStandalonePwa() 가드", () => {
  it("PWA standalone이 아니면(matchMedia false, navigator.standalone 없음) html/body 높이를 전혀 건드리지 않는다", () => {
    stubMatchMedia(false);
    renderHook(() => useDocumentHeightFix());
    expect(document.documentElement.style.height).toBe("");
    expect(document.body.style.height).toBe("");
  });

  it("PWA standalone이고 키보드가 없으면(offsetTop=0) screen 기반 높이를 강제한다", () => {
    stubMatchMedia(true);
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("screen", { width: 390, height: 844 });
    stubVisualViewport(0, 844);
    renderHook(() => useDocumentHeightFix());
    expect(document.documentElement.style.height).toBe("844px");
    expect(document.body.style.height).toBe("844px");
  });

  it("키보드가 뜬 채로 마운트되면 처음부터 height를 강제하지 않는다", () => {
    // 이미 키보드가 뜬 상태로 마운트되는 경우(예: 입력창 포커스를
    // 유지한 채 다른 탭에서 돌아옴)를 검증 — 마운트 시점부터
    // offsetTop>0이면 처음부터 height가 강제되지 않아야 한다.
    stubMatchMedia(true);
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("screen", { width: 390, height: 844 });
    stubVisualViewport(300, 500);
    renderHook(() => useDocumentHeightFix());
    expect(document.documentElement.style.height).toBe("");
    expect(document.body.style.height).toBe("");
  });

  it("키보드가 뜨면(offsetTop이 0→양수로 바뀌면) 강제해둔 height를 제거한다", () => {
    stubMatchMedia(true);
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("screen", { width: 390, height: 844 });
    const viewport = stubVisualViewport(0, 844);
    renderHook(() => useDocumentHeightFix());
    expect(document.documentElement.style.height).toBe("844px");

    act(() => {
      viewport.offsetTop = 300;
      viewport.height = 500;
      viewport.fire("resize");
    });
    expect(document.documentElement.style.height).toBe("");
    expect(document.body.style.height).toBe("");
  });

  it("언마운트 시 강제해둔 height를 원복한다", () => {
    stubMatchMedia(true);
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("screen", { width: 390, height: 844 });
    stubVisualViewport(0, 844);
    const { unmount } = renderHook(() => useDocumentHeightFix());
    expect(document.documentElement.style.height).toBe("844px");
    unmount();
    expect(document.documentElement.style.height).toBe("");
    expect(document.body.style.height).toBe("");
  });

  it("가로모드(innerWidth > screen.width)에서는 screen.width를 세로 길이로 쓴다", () => {
    // 🔧 useKeyboardInset.ts 148행: isLandscape ? screen.width :
    // screen.height. 실제 iOS는 회전해도 screen 값 자체를 바꾸지 않고
    // "지금 어느 쪽이 짧은 변인지"만 innerWidth로 판단하는 것이 이
    // 코드의 전제(148행 부근 주석) — 가로에서 innerWidth(750)가
        // screen.width(390)보다 크므로 isLandscape=true, 이때 화면의
    // 실제 세로 길이는 screen.width(390, 세로일 때 짧은 변)여야 한다.
    stubMatchMedia(true);
    vi.stubGlobal("innerWidth", 750);
    vi.stubGlobal("screen", { width: 390, height: 844 });
    stubVisualViewport(0, 340);
    renderHook(() => useDocumentHeightFix());
    expect(document.documentElement.style.height).toBe("390px");
  });
});

describe("useVisualViewportRect — isStandalonePwa() 가드 + 키보드 판정", () => {
  it("PWA standalone이 아니면 항상 null을 반환한다(PC/일반 브라우저 탭은 이 JS 좌표계를 타지 않음)", () => {
    stubMatchMedia(false);
    stubVisualViewport(0, 800); // visualViewport 자체는 있어도(데스크톱 Chrome처럼) 가드가 막아야 한다.
    const { result } = renderHook(() => useVisualViewportRect());
    expect(result.current).toBeNull();
  });

  it("PWA standalone이고 키보드가 없으면(offsetTop=0) screen 기반 높이를 반환한다", () => {
    stubMatchMedia(true);
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("screen", { width: 390, height: 844 });
    stubVisualViewport(0, 797); // 원복 실패로 낡은 값(797)이어도 무시되어야 함(주석 근거).
    const { result } = renderHook(() => useVisualViewportRect());
    expect(result.current).toEqual({ top: 0, height: 844 });
  });

  it("PWA standalone이고 키보드가 떠 있으면(offsetTop>0) visualViewport.height를 그대로 쓴다", () => {
    stubMatchMedia(true);
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("screen", { width: 390, height: 844 });
    stubVisualViewport(300, 500);
    const { result } = renderHook(() => useVisualViewportRect());
    expect(result.current).toEqual({ top: 300, height: 500 });
  });

  it("visualViewport의 resize 이벤트가 발생하면 최신 offsetTop/height로 재계산한다", () => {
    stubMatchMedia(true);
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("screen", { width: 390, height: 844 });
    const viewport = stubVisualViewport(0, 844);
    const { result } = renderHook(() => useVisualViewportRect());
    expect(result.current).toEqual({ top: 0, height: 844 });

    // 키보드가 뜬 것처럼 값을 바꾸고 resize 이벤트를 발생시킨다.
    act(() => {
      viewport.offsetTop = 300;
      viewport.height = 500;
      viewport.fire("resize");
    });
    expect(result.current).toEqual({ top: 300, height: 500 });
  });

  it("가로모드에서는 키보드가 없을 때 screen.width를 세로 길이로 쓴다(세로/가로 판정 회귀 방지)", () => {
    stubMatchMedia(true);
    vi.stubGlobal("innerWidth", 750);
    vi.stubGlobal("screen", { width: 390, height: 844 });
    stubVisualViewport(0, 340);
    const { result } = renderHook(() => useVisualViewportRect());
    expect(result.current).toEqual({ top: 0, height: 390 });
  });

  it("언마운트 후에는 visualViewport 이벤트가 더 이상 상태를 바꾸지 않는다(리스너 정리 확인)", () => {
    stubMatchMedia(true);
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("screen", { width: 390, height: 844 });
    const viewport = stubVisualViewport(0, 844);
    const { result, unmount } = renderHook(() => useVisualViewportRect());
    unmount();
    act(() => {
      viewport.offsetTop = 300;
      viewport.fire("resize");
    });
    // 언마운트 이전 마지막 값 그대로 — 리스너가 제거되지 않았다면
    // 이 값이 { top: 300, ... }로 바뀌어 있을 것이다.
    expect(result.current).toEqual({ top: 0, height: 844 });
  });
});
