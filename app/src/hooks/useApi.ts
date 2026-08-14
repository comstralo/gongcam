import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/useAuth";

type CallOptions = {
  method?: string;
  body?: Record<string, unknown>;
  tokenInBody?: boolean;
};

// report.html/status.html/participants에 3번 중복됐던
// "401이면 세션 지우고 로그인으로 보내기" 로직을 한 곳으로 모은다.
export function useApi() {
  const { session, logout } = useAuth();
  const navigate = useNavigate();

  const call = useCallback(
    <T,>(path: string, opts: CallOptions = {}) =>
      apiFetch<T>(path, {
        ...opts,
        token: session?.token,
        onUnauthorized: () => {
          logout();
          navigate("/login", { replace: true });
        },
      }),
    [session, logout, navigate]
  );

  return { call };
}
