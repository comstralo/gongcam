// 🔧 [2026-09-22 사용자 지시: "먼저 계속 진행해"(프론트 테스트 도구
// 보강 4차)] — SessionCard.tsx를 시작으로, useAuth()(AuthContext)와
// useNavigate()(react-router-dom)에 의존하는 컴포넌트가 이미 10개 이상
// 있다(grep 확인: NewMemberForm/StatusView/TabBar/AppShell 등). 실제
// AuthProvider를 쓰면 apiFetch("/me/role") 호출까지 함께 딸려와
// 컴포넌트 테스트가 네트워크 mock에 얽매이므로, 대신 AuthContext.
// Provider에 테스트가 원하는 값을 직접 주입하는 얇은 래퍼를 공용으로
// 둔다 — 이후 컴포넌트 테스트가 매번 이 mock 배선을 새로 만들지 않도록.
import type { ReactElement, ReactNode } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { AuthContext, type AuthContextValue } from "@/lib/auth/AuthContext";
import type { Session } from "@/lib/auth/session";

// 테스트가 흔히 필요로 하는 필드만 채우면 나머지는 안전한 기본값으로
// 채워지는 부분 타입 — 매번 AuthContextValue 전체를 나열하지 않아도 된다.
export function makeAuthContextValue(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    session: null,
    isAdmin: false,
    isCoReviewer: false,
    sessionVerified: true,
    login: () => {},
    logout: () => {},
    ...overrides,
  };
}

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    token: "test-token",
    email: "member@example.com",
    name: "테스트회원",
    ...overrides,
  };
}

type RenderWithProvidersOptions = Omit<RenderOptions, "wrapper"> & {
  authValue?: Partial<AuthContextValue>;
  route?: string;
};

// 현재 라우터 경로를 화면 어딘가(data-testid="location-display")에
// 그려두는 숨은 컴포넌트 — useNavigate()로 실제 경로 이동까지
// 검증하고 싶은 테스트가 screen.getByTestId("location-display")로
// 이동 결과를 확인할 수 있게 한다. MemoryRouter 없이 useNavigate만
// 부르면 예외가 나므로, 이 트래커도 항상 Wrapper 안에 함께 둔다.
function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location-display">{location.pathname}</div>;
}

// AuthContext + MemoryRouter로 감싸 렌더링한다. route를 지정하면 그
// 경로에서 시작하는 라우팅 상태를 재현할 수 있다. LocationDisplay를
// 함께 렌더링해두므로, navigate() 호출 후 실제로 어느 경로로 이동했는지
// screen.getByTestId("location-display")로 확인할 수 있다.
export function renderWithProviders(ui: ReactElement, options: RenderWithProvidersOptions = {}) {
  const { authValue, route = "/", ...renderOptions } = options;
  const contextValue = makeAuthContextValue(authValue);

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[route]}>
        <AuthContext.Provider value={contextValue}>
          {children}
          <LocationDisplay />
        </AuthContext.Provider>
      </MemoryRouter>
    );
  }

  return render(ui, { wrapper: Wrapper, ...renderOptions });
}
