// 🔧 [2026-09-22 사용자 지시: "계속 진행해"(프론트 테스트 도구 보강
// 3차, 컴포넌트 테스트 첫 대상)] — 이 앱의 첫 RTL 컴포넌트 테스트.
// 이미 테스트된 useTheme 훅을 실제로 소비하는 화면 단위에서, 클릭 시
// 아이콘/aria-label이 올바르게 전환되는지 확인한다.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeToggleButton } from "./ThemeToggleButton";

beforeEach(() => {
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  document.documentElement.classList.remove("dark");
});

describe("ThemeToggleButton", () => {
  it("라이트 모드일 때는 '다크 모드로 전환' 버튼을 보여준다", () => {
    render(<ThemeToggleButton />);
    expect(screen.getByRole("button", { name: "다크 모드로 전환" })).toBeInTheDocument();
  });

  it("다크 모드일 때는 '라이트 모드로 전환' 버튼을 보여준다", () => {
    document.documentElement.classList.add("dark");
    render(<ThemeToggleButton />);
    expect(screen.getByRole("button", { name: "라이트 모드로 전환" })).toBeInTheDocument();
  });

  it("클릭하면 다크 모드로 전환되고 라벨이 바뀐다", () => {
    render(<ThemeToggleButton />);
    fireEvent.click(screen.getByRole("button", { name: "다크 모드로 전환" }));

    expect(screen.getByRole("button", { name: "라이트 모드로 전환" })).toBeInTheDocument();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("다시 클릭하면 라이트 모드로 되돌아간다", () => {
    render(<ThemeToggleButton />);
    const button = screen.getByRole("button");
    fireEvent.click(button); // → dark
    fireEvent.click(button); // → light

    expect(screen.getByRole("button", { name: "다크 모드로 전환" })).toBeInTheDocument();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
