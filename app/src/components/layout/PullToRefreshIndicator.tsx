import { RotateCw } from "lucide-react";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";
import { cn } from "@/lib/utils";

// 화면 최상단에 고정된 원형 인디케이터 — 당긴 거리에 비례해 나타나고
// 회전하다가(threshold 이상 당기면 채워진 배경으로 "확정" 표시), 새로고침
// 요청이 발행되면 짧게 스핀 애니메이션을 보여주고 사라진다.
export function PullToRefreshIndicator() {
  const { pullDistance, refreshing, threshold } = usePullToRefresh();

  if (pullDistance <= 0 && !refreshing) return null;

  const progress = Math.min(1, pullDistance / threshold);
  const armed = progress >= 1 || refreshing;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-40 flex justify-center"
      style={{
        transform: `translateY(${refreshing ? 14 : Math.max(-32, pullDistance - 32)}px)`,
        opacity: refreshing ? 1 : progress,
        transition: pullDistance === 0 || refreshing ? "transform 150ms ease, opacity 150ms ease" : undefined,
      }}
    >
      <div
        className={cn(
          "flex size-8 items-center justify-center rounded-full border shadow-md",
          armed ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-muted-foreground"
        )}
        style={{ marginTop: "env(safe-area-inset-top, 0px)" }}
      >
        <RotateCw
          className={cn("size-4", refreshing && "animate-spin")}
          style={!refreshing ? { transform: `rotate(${progress * 360}deg)` } : undefined}
        />
      </div>
    </div>
  );
}
