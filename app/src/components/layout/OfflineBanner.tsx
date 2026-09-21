import { WifiOff } from "lucide-react";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { ICON_STROKE } from "@/lib/utils";

// 🔧 [2026-09-21 사용자 지시: "다양한 환경 대응을 위한 도구를 체계적으로
// 적용" — 추가 조사] 이 앱은 네트워크가 끊긴 상태를 전혀 안내하지 않아,
// 특히 카메라 촬영/제보처럼 네트워크가 잠깐 끊긴 채로도 계속 조작하기
// 쉬운 화면에서 사용자가 원인을 모른 채 "Failed to fetch"류 에러만 보게
// 됐다(client.ts의 apiFetch가 이제 이 경우 한국어 메시지로 바꾸지만,
// 애초에 끊겼다는 사실 자체를 미리 알려주는 게 더 낫다).
//
// IdleOverlay(전체 화면을 덮는 절전 안내)와 달리, 이 배너는 사용자가
// 이미 작성 중인 내용(입력 필드 등)을 가리지 않도록 화면 맨 위에 얇게
// 붙는 형태로 만든다 — 오프라인이어도 로컬 상태(폼 입력 등)는 그대로
// 유지되므로 조작을 막을 이유가 없다. AppShell 밖(App.tsx 최상위)에
// 한 번만 두면 모든 화면에 자동 적용된다.
export function OfflineBanner() {
  const isOnline = useNetworkStatus();

  if (isOnline) return null;

  return (
    <div
      // <output>은 "폼 계산 결과"를 뜻하는 태그라 이 배너(네트워크 상태
      // 변화를 스크린리더에게 즉시 알리는 라이브 리전)에는 맞지 않는다 —
      // role="status"가 의도한 의미(상태 알림) 그대로다.
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="status"
      // 🔧 이 앱은 꽉 찬 destructive 배경(text-destructive-foreground
      // 토큰 자체가 index.css에 정의되어 있지 않음) 대신 옅은 배경(/10~20)
      // + 진한 텍스트 조합을 관례로 쓴다(button.tsx/badge.tsx 참고) —
      // 이 배너도 그 관례를 그대로 따른다.
      className="fixed inset-x-0 top-0 z-[70] flex items-center justify-center gap-1.5 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-center text-xs font-semibold text-destructive dark:bg-destructive/20 sm:text-sm"
      style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 0.375rem)" }}
    >
      <WifiOff className="size-3.5 shrink-0 sm:size-4" strokeWidth={ICON_STROKE.default} />
      인터넷 연결이 끊겼어요 — 연결을 확인해주세요
    </div>
  );
}
