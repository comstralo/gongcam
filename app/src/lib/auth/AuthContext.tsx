import { createContext, useCallback, useMemo, useState, type ReactNode } from "react";
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
  login: (session: Session, mode: SessionMode) => void;
  logout: () => void;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // lazy initializer로 마운트 시점에 동기적으로 세션을 읽는다.
  // useEffect에서 읽으면 첫 렌더가 "비로그인"으로 잠깐 보였다가 바뀌는 깜빡임이 생긴다.
  const [session, setSession] = useState<Session | null>(() => getSession());

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
      login,
      logout,
    }),
    [session, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
