// 🔧 [2026-09-22 사용자 지시: "계속 진행해"(프론트 테스트 도구 보강 3차)]
// — ThemeToggleButton 컴포넌트 테스트를 위한 선행 작업. index.html의
// 인라인 스크립트가 마운트 전에 이미 .dark 클래스를 반영해두므로, 이
// 훅은 그 결과를 초기값으로 읽기만 한다(파일 상단 주석) — 테스트에서도
// 그 전제(documentElement.classList가 이미 세팅된 상태)를 그대로
// 재현한다.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTheme } from "./useTheme";

function setupThemeColorMeta() {
  const meta = document.createElement("meta");
  meta.setAttribute("name", "theme-color");
  meta.setAttribute("content", "#ff5a36");
  document.head.appendChild(meta);
  return meta;
}

beforeEach(() => {
  document.documentElement.classList.remove("dark");
  localStorage.clear();
});

afterEach(() => {
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((el) => el.remove());
  document.documentElement.classList.remove("dark");
});

describe("useTheme", () => {
  it("documentElement에 dark 클래스가 없으면 초기값은 false다", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.dark).toBe(false);
  });

  it("documentElement에 이미 dark 클래스가 있으면(index.html 인라인 스크립트가 미리 반영) 초기값은 true다", () => {
    document.documentElement.classList.add("dark");
    const { result } = renderHook(() => useTheme());
    expect(result.current.dark).toBe(true);
  });

  it("setDark(true)를 호출하면 documentElement에 dark 클래스가 추가된다", () => {
    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current.setDark(true);
    });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("setDark(false)를 호출하면 documentElement에서 dark 클래스가 제거된다", () => {
    document.documentElement.classList.add("dark");
    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current.setDark(false);
    });
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("theme-color meta 태그가 있으면 다크 모드 전환 시 그 content를 갱신한다", () => {
    const meta = setupThemeColorMeta();
    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current.setDark(true);
    });
    expect(meta.getAttribute("content")).toBe("#1c1917");

    act(() => {
      result.current.setDark(false);
    });
    expect(meta.getAttribute("content")).toBe("#ff5a36");
  });

  it("theme-color meta 태그가 없어도 예외를 던지지 않는다", () => {
    const { result } = renderHook(() => useTheme());
    expect(() => {
      act(() => {
        result.current.setDark(true);
      });
    }).not.toThrow();
  });

  it("localStorage에 선택한 테마를 저장한다", () => {
    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current.setDark(true);
    });
    expect(localStorage.getItem("theme")).toBe("dark");

    act(() => {
      result.current.setDark(false);
    });
    expect(localStorage.getItem("theme")).toBe("light");
  });

  it("localStorage 접근이 막혀도(시크릿 모드 등) 예외를 던지지 않는다", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException("blocked");
    };
    try {
      const { result } = renderHook(() => useTheme());
      expect(() => {
        act(() => {
          result.current.setDark(true);
        });
      }).not.toThrow();
      // localStorage 저장이 실패해도 documentElement 반영(더 중요한
      // 즉각적 시각 효과)은 여전히 이루어져야 한다.
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
