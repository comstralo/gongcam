import { useCallback, useEffect, useRef } from "react";

// 🔧 [2026-09-21 사용자 지시: "다양한 환경 대응을 위한 도구를 체계적으로
// 적용" — 앱 전체 CSS/레이아웃 전수조사 후속] AppShell.tsx/TabBar.tsx/
// ChatPage.tsx 세 곳이 "요소를 ResizeObserver로 관찰하다가 크기가 바뀌면
// 콜백을 부른다"는 같은 패턴을 각자 인라인으로 재구현하고 있었다(observer
// 생성, observe/disconnect cleanup, 콜백을 최신 상태로 유지하는 ref
// 처리까지 매번 손으로 반복). 이 공용 훅으로 그 반복을 하나로 모은다 —
// 새로 ResizeObserver가 필요한 곳은 이 훅을 재사용할 것.
//
// 콜백은 항상 최신 함수를 실행한다(ref로 감싸 매 렌더 재구독하지 않음).
// 반환값은 콜백 ref다 — <div ref={useResizeObserver(onResize)} /> 형태로
// 조건부 마운트/언마운트되는 요소에도 안전하게 붙일 수 있다(useRef+
// useEffect 조합보다 콜백 ref가 이런 케이스에 더 안정적이라는 점은
// TabBar.tsx의 기존 주석에 이미 정리되어 있다).
export function useResizeObserver<T extends Element>(
  onResize: (entry: ResizeObserverEntry, element: T) => void
): (element: T | null) => void {
  const onResizeRef = useRef(onResize);
  useEffect(() => {
    onResizeRef.current = onResize;
  });
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((element: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) onResizeRef.current(entry, element);
    });
    observer.observe(element);
    observerRef.current = observer;
  }, []);

  useEffect(() => {
    return () => observerRef.current?.disconnect();
  }, []);

  return ref;
}
