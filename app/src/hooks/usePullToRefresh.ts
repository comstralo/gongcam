import { useEffect, useRef, useState } from "react";

const THRESHOLD = 64; // 이 이상 당겨야 "새로고침 확정" 상태로 인정.
const MAX_PULL = 100; // 인디케이터가 시각적으로 늘어나는 한계(고무줄 저항용).

// 모바일 웹앱 표준 관례: 페이지별 refresh 로직에 얽매이지 않고 새로고침
// "요청"만 전역 이벤트로 쏜다 — 각 화면이 이미 가진 자기만의 refresh(들)를
// 이 이벤트에 구독시키면 된다(usePullRefreshListener 참고).
export const PULL_REFRESH_EVENT = "app:pull-refresh";

// 문서 최상단에서 아래로 당기는 제스처를 추적해 당김 거리(px, 0~MAX_PULL)와
// 새로고침 트리거 여부를 반환한다. 스크롤이 맨 위(scrollY===0)일 때 시작한
// 터치만 인정해, 페이지 내부 스크롤 중 우발적으로 당겨지는 걸 막는다.
export function usePullToRefresh() {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef<number | null>(null);
  const pulling = useRef(false);

  useEffect(() => {
    function onTouchStart(e: TouchEvent) {
      if (window.scrollY > 0 || refreshing) {
        startY.current = null;
        return;
      }
      startY.current = e.touches[0].clientY;
      pulling.current = false;
    }

    function onTouchMove(e: TouchEvent) {
      if (startY.current === null || refreshing) return;
      const delta = e.touches[0].clientY - startY.current;
      if (delta <= 0) {
        setPullDistance(0);
        pulling.current = false;
        return;
      }
      // 페이지 자체가 스크롤 중이면(당기는 동안 다시 맨 위를 벗어나면) 취소.
      if (window.scrollY > 0) {
        startY.current = null;
        setPullDistance(0);
        pulling.current = false;
        return;
      }
      pulling.current = true;
      // 고무줄 저항: 당길수록 점점 덜 늘어나 자연스러운 한계를 준다.
      const resisted = Math.min(MAX_PULL, delta * 0.5);
      setPullDistance(resisted);
      if (delta > 10) e.preventDefault();
    }

    function onTouchEnd() {
      if (!pulling.current) {
        startY.current = null;
        return;
      }
      pulling.current = false;
      startY.current = null;
      setPullDistance((current) => {
        if (current >= THRESHOLD * 0.5) {
          setRefreshing(true);
          window.dispatchEvent(new CustomEvent(PULL_REFRESH_EVENT));
          // 실제 API 호출 완료 시점을 알 수 없으므로(페이지마다 다른 refresh를
          // 각자 fire-and-forget으로 실행) 인디케이터는 짧게 보여주고 접는다.
          window.setTimeout(() => setRefreshing(false), 700);
        }
        return 0;
      });
    }

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, [refreshing]);

  return { pullDistance, refreshing, threshold: THRESHOLD };
}

// 현재 화면이 pull-to-refresh 요청을 받았을 때 자신의 refresh를 실행하고
// 싶을 때 쓰는 리스너. visible이 false인 동안(hidden 탭 등)에는 무시한다.
export function usePullRefreshListener(visible: boolean, onRefresh: () => void) {
  useEffect(() => {
    if (!visible) return;
    function handler() {
      onRefresh();
    }
    window.addEventListener(PULL_REFRESH_EVENT, handler);
    return () => window.removeEventListener(PULL_REFRESH_EVENT, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
}
