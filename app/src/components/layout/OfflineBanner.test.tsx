// 🔧 [2026-09-22 사용자 지시: "계속 진행해"(프론트 테스트 도구 보강
// 3차)] — 이미 테스트된 useNetworkStatus 훅을 실제로 소비하는 화면
// 단위 검증. navigator.onLine을 stubGlobal로 조작하고 online/offline
// 이벤트를 디스패치해 배너의 표시/숨김을 확인한다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { OfflineBanner } from "./OfflineBanner";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OfflineBanner", () => {
  it("온라인 상태면 아무것도 렌더링하지 않는다", () => {
    vi.stubGlobal("navigator", { onLine: true });
    render(<OfflineBanner />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("오프라인 상태면 안내 문구를 role=status로 렌더링한다", () => {
    vi.stubGlobal("navigator", { onLine: false });
    render(<OfflineBanner />);
    expect(screen.getByRole("status")).toHaveTextContent("인터넷 연결이 끊겼어요");
  });

  it("렌더링 도중 offline 이벤트가 발생하면 배너가 나타난다", () => {
    vi.stubGlobal("navigator", { onLine: true });
    render(<OfflineBanner />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("offline 이후 online 이벤트가 발생하면 배너가 사라진다", () => {
    vi.stubGlobal("navigator", { onLine: false });
    render(<OfflineBanner />);
    expect(screen.getByRole("status")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
