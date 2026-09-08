import { useEffect, useRef, useState } from "react";

// useRefreshOnVisible(탭 재방문 시 1회 재조회)과 짝을 이루는 훅 — 사용자가
// 수동으로 새로고침을 누르지 않아도, 서버 캐시 TTL이 자연 만료될 때쯤
// 화면이 알아서 다시 최신 값을 받아오게 한다(사용자 지시: "큰 부하가
// 발생하지 않는 선에서 자동으로 새로고침"). intervalMs는 항상 그 화면이
// 쓰는 캐시의 TTL보다 충분히(3배 이상) 길게 잡아야 한다 — 그래야 폴링이
// 도착할 때쯤 캐시가 이미 자연 만료돼 있어 "매번 강제로 새로 읽는" 것과
// 다르게 KV 예산을 거의 그대로 아낄 수 있다(docs/CACHING_POLICY.md §14).
// visible이 false인 동안(다른 탭에 가려진 화면)에는 타이머를 아예 돌리지
// 않아, 보이지도 않는 화면이 계속 백그라운드에서 요청을 쌓는 걸 막는다.
//
// 🔧 [진행률 표시 추가] 반환하는 progress(0~1, 다음 자동 갱신까지 남은
// 비율)는 순수 프론트 표시용이다 — 1초 간격으로만 로컬에서 갱신되고
// 서버에는 어떤 요청도 보내지 않으므로(사용자 확인: "이건 KV 예산과
// 무관") 실제 데이터 재조회 주기(intervalMs)에는 영향을 주지 않는다.
export function usePollingRefresh(visible: boolean, load: () => void, intervalMs: number) {
  const loadRef = useRef(load);
  loadRef.current = load;
  const [progress, setProgress] = useState(1);

  useEffect(() => {
    if (!visible) return;
    const startedAt = Date.now();
    setProgress(1);

    const dataTimer = setInterval(() => loadRef.current(), intervalMs);
    // 표시용 카운트다운 — 1초마다 남은 비율만 갱신, 네트워크 요청 없음.
    const displayTimer = setInterval(() => {
      const elapsed = (Date.now() - startedAt) % intervalMs;
      setProgress(1 - elapsed / intervalMs);
    }, 1000);

    return () => {
      clearInterval(dataTimer);
      clearInterval(displayTimer);
    };
  }, [visible, intervalMs]);

  return progress;
}
