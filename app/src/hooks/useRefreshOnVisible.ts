import { useEffect, useRef } from "react";

// 관리자/대시보드 페이지들은 탭·페이지를 옮겨도 언마운트하지 않고 hidden
// 으로만 감춘다(여러 곳을 오가도 시트 재조회가 안 쌓이게 하려는 최적화).
// 그 부작용으로, 폴링이 없는 화면은 처음 마운트될 때 딱 한 번만 데이터를
// 불러오고 그 뒤로는 다시 보이게 돼도 자동으로 갱신되지 않는다 — 특히
// 봇 온라인 상태·사용량 모니터링처럼 "지금 상태"를 보여주는 게 목적인
// 화면에서는 이게 실제 문제가 된다(2026-08). visible이 false에서 true로
// 바뀌는 순간(=사용자가 이 화면으로 다시 돌아온 순간)에만 다시 불러온다
// — 최초 마운트 시의 자체 useEffect(load, [])와 겹치지 않도록 마운트
// 직후 1회는 건너뛴다.
export function useRefreshOnVisible(visible: boolean, load: () => void) {
  const mounted = useRef(false);
  const wasVisible = useRef(visible);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      wasVisible.current = visible;
      return;
    }
    if (visible && !wasVisible.current) {
      load();
    }
    wasVisible.current = visible;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
}
