import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch, ApiError } from "@/lib/api/client";
import type { MyRoleResponse } from "@/lib/api/types";
import {
  clearSession,
  getSession,
  isAdmin as checkIsAdmin,
  saveSession,
  type Session,
  type SessionMode,
} from "./session";

export type AuthContextValue = {
  session: Session | null;
  isAdmin: boolean;
  // 🔧 2026-09: "다른 관리자 의견 반영" 실제 구현 — 현재 부스터디장으로
  // 임명된 회원이면 true(§GET /me/role). 로그인 시점에 한 번만 조회하므로,
  // 세션이 열려 있는 도중 임명/해제되면 다음 로그인·새로고침 전까지는
  // 반영되지 않는다 — isAdmin도 세션당 고정이라는 것과 같은 성격.
  isCoReviewer: boolean;
  // 🔧 [버그 수정, 2026-09-21 사용자 지시: "로그인 안 한 상태로 접속했을
  // 때 대시보드가 순간적으로 보였다가 로그인 페이지로 바뀐다, 방지해야"]
  // — getSession()은 저장소에 토큰이 있는지 형태만 볼 뿐, 그 토큰이 실제
  // 서버에서 아직 유효한지는 확인하지 않는다. 그래서 만료/무효화된 토큰이
  // localStorage에 남아있으면: (1) session이 "있음"으로 판단돼 대시보드가
  // 즉시 렌더링 → (2) 대시보드 내부 API 호출이 401을 받아야만 로그아웃
  // 처리 → (3) 로그인 화면으로 튕김. 그 사이(1)~(2) 구간에 대시보드
  // 내용이 실제로 화면에 그려져 노출된다(실측: "찰나긴 하지만 보임").
  // sessionVerified가 true가 될 때까지는 App.tsx가 아무 라우트도
  // 렌더링하지 않아, 이 구간 자체가 화면에 나타나지 않게 한다.
  sessionVerified: boolean;
  login: (session: Session, mode: SessionMode) => void;
  logout: () => void;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // lazy initializer로 마운트 시점에 동기적으로 세션을 읽는다.
  // useEffect에서 읽으면 첫 렌더가 "비로그인"으로 잠깐 보였다가 바뀌는 깜빡임이 생긴다.
  const [session, setSession] = useState<Session | null>(() => getSession());
  const [isCoReviewer, setIsCoReviewer] = useState(false);
  // 저장된 세션이 아예 없으면 검증할 것도 없이 바로 "확정"이다 — 검증
  // 대상은 "토큰이 있는데 유효한지 모르는" 경우뿐이다.
  const [sessionVerified, setSessionVerified] = useState(() => !getSession());

  useEffect(() => {
    if (!session) {
      setIsCoReviewer(false);
      setSessionVerified(true);
      return;
    }
    // 🔧 [버그 수정] 기존엔 "주 관리자는 권한이 이미 최대라 이 조회가
    // 불필요"하다며 건너뛰었는데, 그 결과 관리자 계정의 만료된 토큰은
    // 이 세션 검증에서 전혀 걸러지지 않는 사각지대가 됐다(위 설명 참고).
    // handleMyRole은 관리자 세션으로 불러도 안전하게 200(isCoReviewer:
    // false)을 반환하므로(서버 확인), 건너뛰지 않고 모든 세션에 항상
    // 호출해 "토큰이 실제로 유효한가"의 검증도 함께 겸하게 한다. useApi가
    // 아니라 apiFetch를 직접 쓰는 이유는 그대로 — useApi는 useAuth(=이
    // 컨텍스트)에 의존해 순환 참조가 된다.
    let cancelled = false;
    apiFetch<MyRoleResponse>("/me/role", { token: session.token })
      .then((data) => {
        if (cancelled) return;
        setIsCoReviewer(!!data.isCoReviewer);
        setSessionVerified(true);
      })
      .catch((err) => {
        if (cancelled) return;
        // 401(세션 만료/무효)만 실제 로그아웃으로 이어진다 — 그 외
        // 오류(네트워크 끊김, 서버 일시 장애 등)로 정상 사용자를 잘못
        // 로그아웃시키지 않기 위해 상태 코드를 구분한다.
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          setSession(null);
        }
        setIsCoReviewer(false);
        setSessionVerified(true);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  // 🔧 [폴링 재구독 방지] login/logout/value를 매 렌더 새로 만들면, 이
  // 컨텍스트를 쓰는 useEffect([call, ...]) 계열(예: 15초 폴링 컴포넌트들)이
  // AuthProvider가 재렌더될 때마다 재구독되며 타이머가 리셋될 수 있다 —
  // 지금은 AuthProvider가 자기 상태 변경 시에만 드물게 재렌더되어 실질적
  // 피해는 적지만, useCallback/useMemo로 참조를 안정시켜 두는 편이 안전하다.
  const login = useCallback((newSession: Session, mode: SessionMode) => {
    saveSession(newSession, mode);
    setSession(newSession);
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setSession(null);
  }, []);

  const value: AuthContextValue = useMemo(
    () => ({
      session,
      isAdmin: checkIsAdmin(session),
      isCoReviewer,
      sessionVerified,
      login,
      logout,
    }),
    [session, isCoReviewer, sessionVerified, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
