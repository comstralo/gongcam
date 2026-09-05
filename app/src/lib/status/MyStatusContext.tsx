import { createContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useApi } from "@/hooks/useApi";
import { useAuth } from "@/lib/auth/useAuth";
import { PULL_REFRESH_EVENT } from "@/hooks/usePullToRefresh";
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
  // 🔧 [경쟁 조건 수정] refresh()에 순서 보장이 없어, 먼저 시작된 요청이
  // 늦게 도착하면 "최신 도착"이라는 이유만으로 화면을 덮어썼다 — 예를 들어
  // 반휴 신청 다이얼로그를 열 때 나간 refresh()가 아직 응답 전인데 그 사이
  // 신청이 먼저 성공해 잔여량이 낙관적으로 줄어들면, 뒤늦게 도착한(신청 전
  // 시점 데이터를 담은) refresh() 응답이 전체를 덮어써 잔여량이 잠깐
  // 되돌아가 보였다. 매 refresh() 호출마다 순번을 매겨, 응답이 왔을 때
  // 그사이 더 최신 refresh()가 시작되지 않았을 때만 반영한다.
  const requestIdRef = useRef(0);

  const refresh = useCallback(() => {
    if (!session) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    call<StatusResponse>("/status")
      .then((data) => {
        if (requestId !== requestIdRef.current) return;
        loadedRef.current = true;
        setStatusState(data);
      })
      .catch((err) => {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : "상태를 불러오지 못했습니다.");
      })
      .finally(() => {
        if (requestId !== requestIdRef.current) return;
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    if (!session || loadedRef.current) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // 대시보드/설정 페이지에서 아래로 당겨 새로고침하면(usePullToRefresh) 이
  // 전역 캐시가 갱신되고, 이를 구독하는 두 페이지 모두 자동으로 최신화된다.
  useEffect(() => {
    window.addEventListener(PULL_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(PULL_REFRESH_EVENT, refresh);
  }, [refresh]);

  function setStatus(updater: StatusResponse | ((prev: StatusResponse | null) => StatusResponse | null)) {
    // 낙관적 업데이트(예: 반휴 신청 성공 직후 잔여량 즉시 감소)도 하나의
    // "최신 이벤트"로 취급해 순번을 올린다 — 이렇게 해야 그보다 먼저
    // 시작됐지만 아직 응답 중이던 refresh()가 나중에 도착해도(신청 전
    // 시점의 낡은 데이터이므로) 이 낙관적 업데이트를 덮어쓰지 못한다.
    requestIdRef.current += 1;
    setStatusState((prev) => (typeof updater === "function" ? (updater as (p: StatusResponse | null) => StatusResponse | null)(prev) : updater));
  }

  return (
    <MyStatusContext.Provider value={{ status, loading, error, refresh, setStatus }}>
      {children}
    </MyStatusContext.Provider>
  );
}
