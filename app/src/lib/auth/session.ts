// 세션 저장소 — React에 의존하지 않는 순수 로직.
// 기존 shared/auth.js의 getSession/saveSession/clearSession/isAdmin을 그대로 이식.

const SESSION_KEY = "frameCheckerSession";
const ADMIN_EMAIL = "comstralo@gmail.com";

export type Session = {
  token: string;
  email: string;
  name?: string;
};

export type SessionMode = "persist" | "once";

export function getSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (!parsed.token || !parsed.email) return null;
    return parsed as Session;
  } catch {
    return null;
  }
}

export function saveSession(session: Session, mode: SessionMode): void {
  const serialized = JSON.stringify(session);
  if (mode === "once") {
    sessionStorage.setItem(SESSION_KEY, serialized);
    localStorage.removeItem(SESSION_KEY);
  } else {
    localStorage.setItem(SESSION_KEY, serialized);
    sessionStorage.removeItem(SESSION_KEY);
  }
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY);
}

export function isAdmin(session: Session | null): boolean {
  return !!session && (session.email || "").toLowerCase() === ADMIN_EMAIL;
}
