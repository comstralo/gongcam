import { Moon } from "lucide-react";
import { useIsIdle } from "@/lib/idleTracker";

// 🔧 [사용자 지시] "가만히 보고만 있는데 갱신이 멈춰버리는 건 좀 아닌 것
// 같은데" — 유휴 감지(idleTracker)로 자동 폴링을 조용히 멈추기만 하면,
// 화면을 계속 읽고 있던 사용자 입장에선 "왜 안 바뀌지"라는 오해로
// 이어진다. 절전화면처럼 유휴 상태를 명확히 알려주는 오버레이를 앱
// 전역에 하나 띄운다 — 마우스를 움직이거나 클릭/스크롤하면(이미
// idleTracker가 듣고 있는 이벤트) 즉시 사라지고, 그 화면에 있던 폴링
// 목록들은 IDLE_WAKE_EVENT를 구독해 바로 한 번 최신값을 다시 받아온다
// (usePollingRefresh.ts/MyStatusContext.tsx 참고) — "돌아왔을 때 낡은
// 값을 보여준다"는 문제까지 함께 없앤다.
//
// 첫 상호작용에서 오버레이만 사라지게 하고 그 아래 버튼 등을 곧바로
// 누르지는 않도록, 클릭을 오버레이가 가로챈다(진짜 절전화면을 깨울 때
// 첫 클릭이 곧바로 아이콘을 실행하지 않는 것과 같은 동작).
export function IdleOverlay() {
  const idle = useIsIdle();

  return (
    <div
      aria-hidden={!idle}
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-background/80 text-center backdrop-blur-sm transition-opacity duration-300"
      style={{
        opacity: idle ? 1 : 0,
        pointerEvents: idle ? "auto" : "none",
      }}
    >
      <Moon className="size-8 text-muted-foreground" strokeWidth={1.5} />
      <div className="flex flex-col gap-1 px-6">
        <p className="text-sm font-semibold sm:text-base">자동 새로고침을 잠시 멈췄어요</p>
        <p className="text-xs text-muted-foreground sm:text-sm">움직이거나 눌러보면 바로 다시 시작돼요</p>
      </div>
    </div>
  );
}
