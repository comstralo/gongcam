import { createContext, useState, type ReactNode } from "react";
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

  const login = (newSession: Session, mode: SessionMode) => {
    saveSession(newSession, mode);
    setSession(newSession);
  };

  const logout = () => {
    clearSession();
    setSession(null);
  };

  const value: AuthContextValue = {
    session,
    isAdmin: checkIsAdmin(session),
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
