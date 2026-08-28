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
  const [weeks, setWeeks] = useState<CycleWeek[] | null>(null);
  // 사이클 하나가 최대 몇 주인지(현재 3) — 아직 응답 전이면 기존 버그
  // ("과거 주차 있어도 응답 오기 전엔 안 보임")를 재현하지 않도록 슬롯을
  // 아예 안 그린다. 응답이 오면 실제 서버 값으로 갱신된다.
  const [maxWeeks, setMaxWeeks] = useState(0);

  useEffect(() => {
    let cancelled = false;
    call<CycleListResponse>("/cycles")
      .then((data) => {
        if (cancelled) return;
        setWeeks(data.weeks || []);
        setMaxWeeks(data.maxWeeks || 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (weeks === null || maxWeeks === 0) return null;

  // 🔧 [빈 슬롯 표시] 아직 3주가 다 안 지나 백업이 없는 과거 주차는 원래
  // 버튼 자체가 안 보였다 — 몇 주째인지, 앞으로 몇 자리가 더 채워질지
  // 가늠할 수 없었다. 실제 존재하는 주차(최신순 응답을 오래된 순으로
  // 뒤집은 것) 앞쪽을, 아직 없는 주차 수만큼 비활성화 슬롯으로 채운다.
  const oldestFirst = [...weeks].reverse();
  const missingCount = Math.max(0, maxWeeks - oldestFirst.length);
  const slots: (CycleWeek | null)[] = [...Array(missingCount).fill(null), ...oldestFirst];

  return (
    <div className="flex w-full flex-wrap gap-1.5 sm:gap-2">
      {slots.map((w, i) =>
        w ? (
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
        ) : (
          <button
            key={`empty-${i}`}
            type="button"
            disabled
            className="cursor-not-allowed rounded-full border border-border bg-muted/50 px-3.5 py-2 text-sm font-semibold text-muted-foreground/50 sm:text-base"
          >
            -
          </button>
        )
      )}
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
