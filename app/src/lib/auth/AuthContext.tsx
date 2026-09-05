import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/api/client";
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
  login: (session: Session, mode: SessionMode) => void;
  logout: () => void;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // lazy initializer로 마운트 시점에 동기적으로 세션을 읽는다.
  // useEffect에서 읽으면 첫 렌더가 "비로그인"으로 잠깐 보였다가 바뀌는 깜빡임이 생긴다.
  const [session, setSession] = useState<Session | null>(() => getSession());
  const [isCoReviewer, setIsCoReviewer] = useState(false);

  useEffect(() => {
    // 주 관리자는 이미 전체 권한이 있어 이 조회가 필요 없다 — 호출 자체를
    // 건너뛴다. useApi가 아니라 apiFetch를 직접 쓰는 이유: useApi는
    // useAuth(=이 컨텍스트)에 의존해 순환 참조가 된다.
    if (!session || checkIsAdmin(session)) {
      setIsCoReviewer(false);
      return;
    }
    let cancelled = false;
    apiFetch<MyRoleResponse>("/me/role", { token: session.token })
      .then((data) => {
        if (!cancelled) setIsCoReviewer(!!data.isCoReviewer);
      })
      .catch(() => {
        if (!cancelled) setIsCoReviewer(false);
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
      login,
      logout,
    }),
    [session, isCoReviewer, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
