import { useEffect, useState } from "react";

// 🔧 [사용자 지시] "메뉴나 탭 전환 정책과 웹 캐싱 정책을 원초적으로
// 다시 판단해서 KV 쓰기 삭제를 절약할 방안을 조사해줘" — Page Visibility
// API(document.hidden, usePollingRefresh/MyStatusContext에 이미 적용)는
// "브라우저 탭이 다른 탭에 가려지거나 최소화된" 경우만 감지한다. 하지만
// 관리자가 화면을 띄워놓은 채로 자리를 비우거나 다른 작업을 하면, 탭은
// 여전히 "보이는" 상태(document.hidden=false)라서 그 경우는 놓친다 —
// wrangler tail 실시간 로그로 실측: 그런 화면이 계속 여러 캐시를
// 재작성했다(관리자 1명이 화면 하나만 띄워둬도 8시간이면 하루 KV 쓰기
// 한도를 넘길 정도). 마우스/키보드/터치 조작이 일정 시간 없었으면(진짜
// "안 쓰고 있음") 폴링을 건너뛰도록, 앱 전체가 공유하는 마지막 활동
// 시각을 추적한다.
//
// 여러 화면이 각자 폴링 훅을 쓰므로, 화면마다 리스너를 걸면 중복
// 등록되어 낭비다 — 이 모듈이 로드되는 즉시(React 생명주기와 무관하게
// 단 한 번) 리스너를 등록한다. 초기값은 모듈 로드 시각으로 잡아, 페이지를
// 막 연 직후 아직 아무 조작이 없어도 곧바로 "idle"로 오판되지 않게 한다.
//
// 🔧 [사용자 지시] "가만히 보고만 있는데 갱신이 멈춰버리는 건 좀 아닌 것
// 같은데" — 유휴 감지는 실제 조작 이벤트만 보므로, 화면을 계속 읽고만
// 있는 정당한 사용과 자리를 비운 상태를 구분할 수 없다는 근본적 한계가
// 있다. "왜 멈췄는지 모르게 조용히 멈추는" 대신, 절전화면처럼 유휴
// 상태를 명확히 알려주고(IdleOverlay) 돌아오면 즉시 최신값을 받아오는
// (IDLE_WAKE_EVENT) 방식으로 절충한다 — 유휴 기준(5분, 사용자 확정)을
// 이 모듈이 앱 전체에 하나로 통일해, 폴링 훅과 오버레이가 서로 다른
// 기준으로 어긋나지 않게 한다.
export const IDLE_THRESHOLD_MS = 5 * 60_000;

// 유휴 상태로 "막 전환된" 순간과 "막 풀린" 순간을 각각 이벤트로 알린다.
// usePollingRefresh/MyStatusContext는 WAKE 이벤트를 구독해 다음 정기
// 틱까지 기다리지 않고 즉시 한 번 재조회한다 — 자리를 비웠다 돌아왔을 때
// intervalMs만큼 낡은 값을 보여주던 문제를 없앤다. IdleOverlay는 두
// 이벤트로 표시 여부를 결정한다.
export const IDLE_ENTER_EVENT = "app:idle-enter";
export const IDLE_WAKE_EVENT = "app:idle-wake";

const ACTIVITY_EVENTS = ["mousemove", "keydown", "click", "scroll", "touchstart"] as const;
// 유휴 진입/해제 판정 자체는 폴링과 무관하게 이 주기로만 확인한다 —
// 임계값(5분)보다 충분히 짧아 전환 시점을 몇 초 오차 안에서 잡아낸다.
const CHECK_INTERVAL_MS = 5_000;

let lastActivityAt = Date.now();
let wasIdle = false;

if (typeof window !== "undefined") {
  const markActive = () => {
    lastActivityAt = Date.now();
  };
  for (const eventName of ACTIVITY_EVENTS) {
    window.addEventListener(eventName, markActive, { passive: true });
  }
  setInterval(() => {
    const idleNow = Date.now() - lastActivityAt >= IDLE_THRESHOLD_MS;
    if (idleNow && !wasIdle) window.dispatchEvent(new Event(IDLE_ENTER_EVENT));
    if (!idleNow && wasIdle) window.dispatchEvent(new Event(IDLE_WAKE_EVENT));
    wasIdle = idleNow;
  }, CHECK_INTERVAL_MS);
}

// IDLE_THRESHOLD_MS 이상 사용자 조작(마우스/키보드/터치/스크롤)이
// 없었으면 true. 브라우저 탭이 실제로 보이는(document.hidden=false)
// 상태에서, "화면은 떠 있지만 실제로는 쓰고 있지 않은" 경우를 가려내기
// 위한 것 — 탭 자체가 안 보이는 경우는 이걸로 판단하지 않는다(그건
// document.hidden으로 이미 걸러진다). SPA 내부 탭 재방문
// (useRefreshOnVisible)처럼 사용자가 방금 클릭한 게 명백한 상황에는
// 쓰지 않는다 — 오직 폴링 타이머에만 쓴다.
export function isIdle(): boolean {
  return Date.now() - lastActivityAt >= IDLE_THRESHOLD_MS;
}

// IdleOverlay 전용 — 유휴 여부를 리액트 상태로 구독한다. CHECK_INTERVAL_MS
// 주기로 도는 위 판정 결과를 이벤트로만 받으므로 별도 폴링이 없다.
export function useIsIdle(): boolean {
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    function onEnter() {
      setIdle(true);
    }
    function onWake() {
      setIdle(false);
    }
    window.addEventListener(IDLE_ENTER_EVENT, onEnter);
    window.addEventListener(IDLE_WAKE_EVENT, onWake);
    return () => {
      window.removeEventListener(IDLE_ENTER_EVENT, onEnter);
      window.removeEventListener(IDLE_WAKE_EVENT, onWake);
    };
  }, []);

  return idle;
}
