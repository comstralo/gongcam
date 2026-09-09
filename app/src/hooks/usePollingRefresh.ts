import { useEffect, useRef, useState } from "react";
import { isIdleFor } from "@/lib/idleTracker";

// 마우스/키보드/터치 조작이 이만큼 없었으면 "화면은 보이지만 실제로는
// 안 쓰고 있다"고 판단해 폴링 틱을 건너뛴다. 각 화면 폴링 주기(3분/15분)
// 보다 충분히 짧아야 의미가 있다 — docs/CACHING_POLICY.md §13(이 파일이
// 다루는 개선) 참고.
const IDLE_THRESHOLD_MS = 5 * 60_000;

// useRefreshOnVisible(탭 재방문 시 1회 재조회)과 짝을 이루는 훅 — 사용자가
// 수동으로 새로고침을 누르지 않아도, 서버 캐시 TTL이 자연 만료될 때쯤
// 화면이 알아서 다시 최신 값을 받아오게 한다(사용자 지시: "큰 부하가
// 발생하지 않는 선에서 자동으로 새로고침"). intervalMs는 항상 그 화면이
// 쓰는 캐시의 TTL보다 충분히(3배 이상) 길게 잡아야 한다 — 그래야 폴링이
// 도착할 때쯤 캐시가 이미 자연 만료돼 있어 "매번 강제로 새로 읽는" 것과
// 다르게 KV 예산을 거의 그대로 아낄 수 있다(docs/CACHING_POLICY.md §14).
// visible이 false인 동안(다른 SPA 내부 탭에 가려진 화면)에는 타이머를
// 아예 돌리지 않아, 보이지도 않는 화면이 계속 백그라운드에서 요청을
// 쌓는 걸 막는다.
//
// 🔧 [사용자 지시] "현재 메뉴나 탭 전환 정책과 웹 캐싱 정책을 원초적으로
// 다시 판단해서 KV 쓰기 삭제를 절약할 방안을 조사해줘" — 실시간 로그로
// 확인한 결과, 위 visible(SPA 내부 탭 전환)만으로는 브라우저 탭 자체가
// 다른 탭에 가려지거나 최소화되거나 화면이 꺼진 경우를 전혀 감지하지
// 못해, "웹앱을 열어둔 채 자리를 비우면" 폴링이 계속 돌아 KV를 낭비하는
// 근본 원인이었다(§13 실측: "1~2시간 낮잠" 동안에도 계속 증가). 여기에
// Page Visibility API(document.hidden)를 얹어, 타이머 자체는 그대로
// 돌되 실제로 브라우저 탭이 보이지 않는 순간의 틱은 load()를 건너뛴다
// — 다시 포그라운드로 돌아오면 다음 정기 틱부터 정상 재개된다(최악의
// 경우 intervalMs만큼 지연될 수 있지만, 이건 "낭비를 막는다"는 목적에
// 부합하고 수동 새로고침 버튼으로 언제든 즉시 받아올 수 있다).
//
// 🔧 [사용자 지시] "더 적용할만한건 더 없는지 연구해줘" — document.hidden
// 만으로는 "화면은 떠 있고 보이는데(예: 관리자가 참여 스터디원 목록을
// 띄워두고 자리를 비움) 실제로는 안 쓰는" 경우를 못 막는다(실측: 그런
// 화면이 15분마다 계속 여러 캐시를 재작성). idleTracker(마지막 사용자
// 조작 시각을 앱 전역에서 추적)로 이 케이스도 함께 건너뛴다.
export function usePollingRefresh(visible: boolean, load: () => void, intervalMs: number) {
  const loadRef = useRef(load);
  loadRef.current = load;
  const [progress, setProgress] = useState(1);

  useEffect(() => {
    if (!visible) return;
    const startedAt = Date.now();
    setProgress(1);

    const dataTimer = setInterval(() => {
      if (document.hidden) return;
      if (isIdleFor(IDLE_THRESHOLD_MS)) return;
      loadRef.current();
    }, intervalMs);
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
