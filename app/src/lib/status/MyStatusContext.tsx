import { createContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useApi } from "@/hooks/useApi";
import { useAuth } from "@/lib/auth/useAuth";
import type { StatusResponse } from "@/lib/api/types";

export type MyStatusContextValue = {
  status: StatusResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  setStatus: (updater: StatusResponse | ((prev: StatusResponse | null) => StatusResponse | null)) => void;
};

export const MyStatusContext = createContext<MyStatusContextValue | null>(null);

// 본인의 "현재 사이클 · 내 대시보드" /status 하나만 앱 전역에서 공유한다.
// 대시보드(StatusPage)와 설정(SettingsPage)이 각자 따로 /status를 불러오면
// 페이지를 옮길 때마다 이미 아는 값(예: 시트 이름)이 잠깐 비어 있다가 다시
// 채워지는 깜빡임이 생긴다 — 다른 회원 조회/과거 사이클 조회처럼 파라미터가
// 붙는 조회는 각 페이지가 지금처럼 별도로 호출하고, 이 캐시는 건드리지 않는다.
export function MyStatusProvider({ children }: { children: ReactNode }) {
  const { call } = useApi();
  const { session } = useAuth();
  const [status, setStatusState] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const refresh = useCallback(() => {
    if (!session) return;
    setLoading(true);
    setError(null);
    call<StatusResponse>("/status")
      .then((data) => {
        loadedRef.current = true;
        setStatusState(data);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "상태를 불러오지 못했습니다."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    if (!session || loadedRef.current) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  function setStatus(updater: StatusResponse | ((prev: StatusResponse | null) => StatusResponse | null)) {
    setStatusState((prev) => (typeof updater === "function" ? (updater as (p: StatusResponse | null) => StatusResponse | null)(prev) : updater));
  }

  return (
    <MyStatusContext.Provider value={{ status, loading, error, refresh, setStatus }}>
      {children}
    </MyStatusContext.Provider>
  );
}
