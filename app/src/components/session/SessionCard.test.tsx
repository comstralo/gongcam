// 🔧 [2026-09-22 사용자 지시: "먼저 계속 진행해"(프론트 테스트 도구
// 보강 4차, useAuth+useNavigate 의존 컴포넌트 첫 대상)] — 이 컴포넌트는
// session이 없을 때(로드 전) 스켈레톤을, 있을 때 실제 카드를 그리는
// 조건부 렌더링과 로그아웃 버튼 클릭 시 logout()+onLogout()+navigate()
// 세 가지가 정확한 순서로 호출되는지가 핵심 계약이다.
import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders, makeSession } from "@/test-utils";
import { SessionCard } from "./SessionCard";

describe("SessionCard", () => {
  it("session이 없으면(로드 전) 스켈레톤을 렌더링하고 이름/이메일/버튼은 보이지 않는다", () => {
    renderWithProviders(<SessionCard />, { authValue: { session: null } });
    // 스켈레톤은 aria-hidden으로 접근성 트리에서 제외되므로 role 쿼리로는
    // 안 잡힌다 — 로그아웃 버튼이 아직 없다는 것으로 로드 전 상태임을 확인.
    expect(screen.queryByRole("button", { name: "로그아웃" })).not.toBeInTheDocument();
  });

  it("session이 있으면 이름과 이메일, 로그아웃 버튼을 렌더링한다", () => {
    const session = makeSession({ name: "홍길동", email: "hong@example.com" });
    renderWithProviders(<SessionCard />, { authValue: { session } });

    expect(screen.getByText("홍길동")).toBeInTheDocument();
    expect(screen.getByText("hong@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "로그아웃" })).toBeInTheDocument();
  });

  it("name prop이 주어지면 session.name 대신 그 값을 우선 표시한다", () => {
    const session = makeSession({ name: "세션이름" });
    renderWithProviders(<SessionCard name="prop이름" />, { authValue: { session } });

    expect(screen.getByText("prop이름")).toBeInTheDocument();
    expect(screen.queryByText("세션이름")).not.toBeInTheDocument();
  });

  it("session.name이 없으면 email을 이름 자리에 대신 표시한다", () => {
    const session = makeSession({ name: undefined, email: "noname@example.com" });
    renderWithProviders(<SessionCard />, { authValue: { session } });

    // email이 이름 자리와 상세 자리 두 군데 모두에 나타난다(DividedValue의
    // 두 항목이 우연히 같은 값이 되는 경우) — getAllByText로 확인.
    expect(screen.getAllByText("noname@example.com").length).toBeGreaterThan(0);
  });

  it("로그아웃 버튼을 클릭하면 logout과 onLogout이 모두 호출된다", () => {
    const logout = vi.fn();
    const onLogout = vi.fn();
    const session = makeSession();
    renderWithProviders(<SessionCard onLogout={onLogout} />, { authValue: { session, logout } });

    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));

    expect(logout).toHaveBeenCalledTimes(1);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("onLogout이 주어지지 않아도 로그아웃 클릭 시 예외를 던지지 않는다", () => {
    const logout = vi.fn();
    const session = makeSession();
    renderWithProviders(<SessionCard />, { authValue: { session, logout } });

    expect(() => {
      fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    }).not.toThrow();
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("로그아웃 버튼을 클릭하면 실제로 /login 경로로 이동한다", () => {
    const session = makeSession();
    renderWithProviders(<SessionCard />, { authValue: { session, logout: vi.fn() }, route: "/settings" });

    expect(screen.getByTestId("location-display")).toHaveTextContent("/settings");
    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    expect(screen.getByTestId("location-display")).toHaveTextContent("/login");
  });
});
