import { useEffect, useState } from "react";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import type { CycleListResponse, CycleWeek } from "@/lib/api/types";

// weekOf는 백업 파일명에서 온 "YYMMDD"(그 주 월요일) 형식이다.
function formatWeekLabel(weekOf: string) {
  const m = weekOf.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!m) return weekOf;
  const [, , mm, dd] = m;
  return `${parseInt(mm, 10)}월 ${parseInt(dd, 10)}일 주`;
}

// MY/ALL 상단에서 "현재 진행 중인 사이클(최대 3주) 중 어느 시점을 볼지"
// 고르는 토글. "현재"(실시간, cycle 파라미터 없음)가 항상 맨 앞에 있고,
// 그 뒤로 이미 백업된 주차가 최신순으로 이어진다 — 사이클을 벗어난(4주
// 이상 지난) 기록은 이 토글에 나타나지 않는다.
export function CycleSwitcher({
  selectedFileId,
  onSelect,
}: {
  selectedFileId: string | null;
  onSelect: (fileId: string | null) => void;
}) {
  const { call } = useApi();
  const [weeks, setWeeks] = useState<CycleWeek[]>([]);

  useEffect(() => {
    let cancelled = false;
    call<CycleListResponse>("/cycles")
      .then((data) => {
        if (!cancelled) setWeeks(data.weeks || []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (weeks.length === 0) return null;

  // 백엔드는 최신순으로 내려주므로, 시간 흐름대로(오래된 → 최신) 보여주기 위해 뒤집는다.
  const oldestFirst = [...weeks].reverse();

  return (
    <div className="flex w-full flex-wrap gap-1.5 sm:gap-2">
      {oldestFirst.map((w) => (
        <button
          key={w.fileId}
          type="button"
          onClick={() => onSelect(w.fileId)}
          className={cn(
            "rounded-full border px-3.5 py-2 text-sm font-semibold transition-colors sm:text-base",
            w.fileId === selectedFileId
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-card text-foreground hover:border-primary/50 hover:bg-muted"
          )}
        >
          {formatWeekLabel(w.weekOf)}
        </button>
      ))}
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={cn(
          "rounded-full border px-3.5 py-2 text-sm font-semibold transition-colors sm:text-base",
          selectedFileId === null
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-card text-foreground hover:border-primary/50 hover:bg-muted"
        )}
      >
        현재
      </button>
    </div>
  );
}
