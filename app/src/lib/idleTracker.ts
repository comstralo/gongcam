// 🔧 [사용자 지시] "현재 메뉴나 탭 전환 정책과 웹 캐싱 정책을 원초적으로
// 다시 판단해서 KV 쓰기 삭제를 절약할 방안을 조사해줘" — Page Visibility
// API(document.hidden, usePollingRefresh/MyStatusContext에 이미 적용)는
// "브라우저 탭이 다른 탭에 가려지거나 최소화된" 경우만 감지한다. 하지만
// 관리자가 화면(예: "참여 스터디원 목록")을 띄워놓은 채로 자리를 비우거나
// 다른 작업을 하면, 탭은 여전히 "보이는" 상태(document.hidden=false)라서
// 그 경우는 놓친다 — wrangler tail 실시간 로그로 실측: 그런 화면이
// 15분마다 계속 여러 캐시를 재작성했다. 마우스/키보드/터치 조작이 일정
// 시간 없었으면(진짜 "안 쓰고 있음") 폴링을 건너뛰도록, 앱 전체가 공유하는
// 마지막 활동 시각을 추적한다.
//
// 여러 화면이 각자 usePollingRefresh를 쓰므로, 훅마다 리스너를 걸면
// 중복 등록되어 낭비다 — 이 모듈이 로드되는 즉시(React 생명주기와 무관하게
// 단 한 번) 리스너를 등록하고, isIdleFor()는 그 결과를 읽기만 하는 순수
// 함수로 둔다. 초기값은 모듈 로드 시각으로 잡아, 페이지를 막 연 직후
// 아직 아무 조작이 없어도 곧바로 "idle"로 오판되지 않게 한다.
let lastActivityAt = Date.now();

const ACTIVITY_EVENTS = ["mousemove", "keydown", "click", "scroll", "touchstart"] as const;

if (typeof window !== "undefined") {
  const markActive = () => {
    lastActivityAt = Date.now();
  };
  for (const eventName of ACTIVITY_EVENTS) {
    window.addEventListener(eventName, markActive, { passive: true });
  }
}

// thresholdMs 이상 사용자 조작(마우스/키보드/터치)이 없었으면 true.
// 브라우저 탭이 실제로 보이는(document.hidden=false) 상태에서, "화면은
// 떠 있지만 실제로는 쓰고 있지 않은" 경우를 가려내기 위한 것 — 탭 자체가
// 안 보이는 경우는 이걸로 판단하지 않는다(그건 document.hidden으로 이미
// 걸러진다). SPA 내부 탭 재방문(useRefreshOnVisible)처럼 사용자가 방금
// 클릭한 게 명백한 상황에는 쓰지 않는다 — 오직 폴링 타이머에만 쓴다.
export function isIdleFor(thresholdMs: number): boolean {
  return Date.now() - lastActivityAt >= thresholdMs;
}
