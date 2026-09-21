import { useEffect, useState } from "react";

// 🔧 [2026-09-21 사용자 지시: "다양한 환경 대응을 위한 도구를 체계적으로
// 적용" — 추가 조사] 이 앱은 네트워크가 끊긴 상태를 전혀 감지하지 않는다
// — fetch가 TypeError("Failed to fetch")를 던지면 각 호출부의
// catch(err instanceof Error ? err.message : ...)가 그 영어 원문을 그대로
// 사용자에게 보여준다(42곳에서 동일 패턴 확인). 특히 카메라 촬영/제보
// 화면처럼 네트워크가 잠깐 끊긴 채로 계속 쓰기 쉬운 화면에서 원인을 알
// 수 없는 에러 메시지만 보게 되는 문제가 있었다.
//
// navigator.onLine과 online/offline 이벤트로 현재 네트워크 상태를
// 구독한다. navigator.onLine은 "네트워크 인터페이스가 있는지"만 보고
// "실제로 인터넷에 연결됐는지"는 보장하지 않는 알려진 한계가 있지만
// (Wi-Fi는 잡혔는데 인터넷이 안 되는 경우 등), 브라우저 표준으로 별도
// 서버 요청 없이 즉시 알 수 있는 가장 실용적인 신호다 — 이 앱의 목적
// (완전히 끊긴 상태를 안내)에는 충분하다.
export function useNetworkStatus(): boolean {
  const [isOnline, setIsOnline] = useState(() => (typeof navigator !== "undefined" ? navigator.onLine : true));

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return isOnline;
}
