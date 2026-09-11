import { createContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useApi } from "@/hooks/useApi";
import { useAuth } from "@/lib/auth/useAuth";
import { PULL_REFRESH_EVENT } from "@/hooks/usePullToRefresh";
import { isIdle, IDLE_WAKE_EVENT } from "@/lib/idleTracker";
import type { StatusResponse } from "@/lib/api/types";

export type MyStatusContextValue = {
  status: StatusResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  setStatus: (updater: StatusResponse | ((prev: StatusResponse | null) => StatusResponse | null)) => void;
  /** 서버에서 실제로 새 응답을 받은 시각(ms epoch) — 낙관적 업데이트(setStatus)로는
   * 갱신되지 않는다. StatusPage가 "personalStatusBundle: TTL이 지나기 전엔 새로고침
   * 버튼을 눌러도 어차피 같은 캐시값이라 비활성화"할 때 기준으로 쓴다. */
  lastLoadedAt: number | null;
};

export const MyStatusContext = createContext<MyStatusContextValue | null>(null);

// 본인의 "현재 사이클 · 내 대시보드" /status 하나만 앱 전역에서 공유한다.
// 대시보드(StatusPage)와 설정(SettingsPage)이 각자 따로 /status를 불러오면
// 페이지를 옮길 때마다 이미 아는 값(예: 시트 이름)이 잠깐 비어 있다가 다시
// 채워지는 깜빡임이 생긴다 — 다른 회원 조회/과거 사이클 조회처럼 파라미터가
// 붙는 조회는 각 페이지가 지금처럼 별도로 호출하고, 이 캐시는 건드리지 않는다.
//
// 🔧 [사용자 지시] "탭 전환 정책과 캐싱 정책을 원초적으로 재검토해서 KV
// 쓰기 삭제를 절약할 방안" — useMyStatus() 사용처를 전수조사한 결과 이
// 전역 상태를 실제로 쓰는 화면은 StatusPage(대시보드 MY 탭)와
// SettingsPage 둘뿐이었다. 그런데 이 Provider는 원래 라우팅 정보를 모르는
// 위치(App.tsx의 HashRouter 바로 안)에 있어 "지금 어느 화면을 보고
// 있는지"와 무관하게 세션이 있는 동안 항상 15분 폴링을 돌렸다 — 제보/
// 알림/링크/관리자 화면에 있는 동안에도 그 두 화면과 무관한 캐시
// (personalStatus/meritRank/penCycle/outputPenSlots/reportScore)가
// 계속 재작성됐다(wrangler tail 실시간 로그로 실측 확인). App.tsx가 이제
// visible(그 두 화면 중 하나를 보고 있는지)을 넘겨준다 — 최초 로드(로그인
// 직후 1회, 화면 전환 시 깜빡임 방지가 원래 목적)와 pull-to-refresh
// 리스너는 사용자의 명시적 액션이거나 "다른 화면에 있어도 미리 준비해
// 두는" 원래 설계 의도이므로 visible과 무관하게 그대로 두고, 아래 15분
// 폴링 타이머에만 조건을 추가한다.
export function MyStatusProvider({ children, visible = true }: { children: ReactNode; visible?: boolean }) {
  const { call } = useApi();
  const { session } = useAuth();
  const [status, setStatusState] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
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
        setLastLoadedAt(Date.now());
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

  // 이 Provider는 페이지 단위 visible 개념이 없는 앱 전역 캐시라 탭 재방문
  // 감지 대신 세션이 있는 동안 계속 타이머를 돌린다 — /status가 조합하는
  // 캐시 중 가장 짧은 것(5분)의 3배 이상 주기로 폴링해, 앱을 계속 띄워둔
  // 채로도 자동 갱신되게 한다(docs/CACHING_POLICY.md §15).
  // 🔧 [B 방안] 대시보드/설정 화면을 보고 있을 때만(App.tsx가 넘겨주는
  // visible) 이 타이머가 돈다 — 다른 화면에 있는 동안 무관한 캐시를
  // 재작성하던 가장 큰 낭비 원인이었다.
  // 🔧 [A 방안] Page Visibility API로 브라우저 탭이 실제로 안 보이는
  // 순간의 틱은 건너뛴다.
  // 🔧 [G 방안] document.hidden과 visible만으로는 "화면은 보이지만
  // 실제로는 안 쓰고 있음"을 구분할 수 없다 — idleTracker(마지막 사용자
  // 조작 시각을 앱 전역에서 추적, 유휴 기준 5분)로 이 경우도 건너뛴다.
  // 🔧 [2026-09 재조정] /status가 조합하는 캐시들의 TTL을 10분으로
  // 통일하면서, 폴링 주기도 그 3배인 30분으로 늘렸다(기존 15분).
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      if (!visible) return;
      if (isIdle()) return;
      refresh();
    }, 30 * 60_000);
    return () => clearInterval(timer);
  }, [session, refresh, visible]);

  // 🔧 [사용자 지시] "가만히 보고만 있는데 갱신이 멈춰버리는 건 좀 아닌
  // 것 같은데" — IdleOverlay가 유휴 상태를 화면에 명확히 보여주고, 유휴가
  // 풀리는 순간(IDLE_WAKE_EVENT) 이 화면을 보고 있었다면 다음 정기 틱까지
  // 기다리지 않고 즉시 한 번 재조회한다.
  useEffect(() => {
    if (!session) return;
    function onWake() {
      if (document.hidden || !visible) return;
      refresh();
    }
    window.addEventListener(IDLE_WAKE_EVENT, onWake);
    return () => window.removeEventListener(IDLE_WAKE_EVENT, onWake);
  }, [session, visible, refresh]);

  function setStatus(updater: StatusResponse | ((prev: StatusResponse | null) => StatusResponse | null)) {
    // 낙관적 업데이트(예: 반휴 신청 성공 직후 잔여량 즉시 감소)도 하나의
    // "최신 이벤트"로 취급해 순번을 올린다 — 이렇게 해야 그보다 먼저
    // 시작됐지만 아직 응답 중이던 refresh()가 나중에 도착해도(신청 전
    // 시점의 낡은 데이터이므로) 이 낙관적 업데이트를 덮어쓰지 못한다.
    requestIdRef.current += 1;
    setStatusState((prev) => (typeof updater === "function" ? (updater as (p: StatusResponse | null) => StatusResponse | null)(prev) : updater));
  }

  return (
    <MyStatusContext.Provider value={{ status, loading, error, refresh, setStatus, lastLoadedAt }}>
      {children}
    </MyStatusContext.Provider>
  );
}
