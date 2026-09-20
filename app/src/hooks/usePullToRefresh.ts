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
// 🔧 [버그 수정, 2026-09-20 사용자 지시: "모바일에서 채팅 스크롤을 하려고
// 하면 우리 웹 서비스의 새로고침이 발동해버린다"] — 이 훅은 원래
// window.scrollY===0일 때만 당김을 추적하면 안전하다고 가정했는데, 이는
// "페이지 전체가 window 스크롤로 움직이는 화면"에만 맞는 전제였다.
// Stream Chat의 메시지 리스트(.str-chat__main-panel-inner)처럼 페이지
// 자체는 스크롤하지 않고 내부 div가 자체적으로 overflow-y:auto로
// 스크롤하는 화면에서는 window.scrollY가 항상 0으로 유지된 채, 그 내부
// 리스트를 위로 스크롤하려는 터치가 그대로 이 전역 리스너에 pull-to-
// refresh 제스처로 오인됐다(실측: 채팅에서만 재현, 페이지 자체가
// window 스크롤을 쓰는 다른 탭에서는 무해했음 — scrollY가 이미 0보다
// 커져 자연히 걸러짐). 터치 시작 지점의 조상 중에 "스스로 스크롤 가능한
// (overflow-y auto/scroll + 실제 스크롤할 컨텐츠가 있는)" 요소가 있으면
// 그 안의 스크롤을 우선하고 전역 당김 추적 자체를 시작하지 않는다.
function findScrollableAncestor(el: Element | null): Element | null {
  for (let node = el; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    const canScrollY = style.overflowY === "auto" || style.overflowY === "scroll";
    if (canScrollY && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

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
      const scrollableAncestor = findScrollableAncestor(e.target as Element | null);
      // 내부 스크롤 컨테이너가 맨 위가 아니면(더 위로 스크롤할 여지가
      // 있으면) 그 스크롤을 우선한다. 이미 맨 위(scrollTop===0)라면
      // 카카오톡 등과 동일하게 그 다음 당김은 페이지 새로고침으로
      // 넘어가도 자연스러우므로 계속 추적한다.
      if (scrollableAncestor && scrollableAncestor.scrollTop > 0) {
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
