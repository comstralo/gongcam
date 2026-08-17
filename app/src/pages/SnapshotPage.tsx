import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { StatusView } from "@/components/dashboard/StatusView";
import { RosterView } from "@/components/dashboard/RosterView";
import { useApi } from "@/hooks/useApi";
import { cn, ICON_STROKE } from "@/lib/utils";
import type { SnapshotDetailResponse, SnapshotListResponse } from "@/lib/api/types";

// weekOf는 백업 파일명에서 온 "YYMMDD"(그 주 월요일) 형식이다.
function formatWeekLabel(weekOf: string) {
  const m = weekOf.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!m) return weekOf;
  const [, , mm, dd] = m;
  return `${parseInt(mm, 10)}월 ${parseInt(dd, 10)}일 주`;
}

export function SnapshotPage() {
  const { call } = useApi();
  const [weeks, setWeeks] = useState<string[] | null>(null);
  const [selectedWeek, setSelectedWeek] = useState<string | null>(null);
  const [detail, setDetail] = useState<SnapshotDetailResponse | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingList(true);
    call<SnapshotListResponse>("/snapshots")
      .then((data) => {
        if (cancelled) return;
        setWeeks(data.weeks || []);
        if (data.weeks && data.weeks.length > 0) setSelectedWeek(data.weeks[0]);
      })
      .catch((err) => {
        if (!cancelled) setListError(err instanceof Error ? err.message : "지난 기록을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedWeek) return;
    let cancelled = false;
    setLoadingDetail(true);
    setDetailError(null);
    call<SnapshotDetailResponse>(`/snapshots/${encodeURIComponent(selectedWeek)}`)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((err) => {
        if (!cancelled) setDetailError(err instanceof Error ? err.message : "기록을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWeek]);

  return (
    <Card className="w-full">
      <CardContent className="flex flex-col gap-4">
        {weeks && weeks.length > 0 && (
          <div className="flex flex-wrap gap-1.5 sm:gap-2">
            {weeks.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setSelectedWeek(w)}
                className={cn(
                  "rounded-full border px-3.5 py-2 text-sm font-semibold transition-colors sm:text-base",
                  w === selectedWeek
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-foreground hover:border-primary/50 hover:bg-muted"
                )}
              >
                {formatWeekLabel(w)}
              </button>
            ))}
          </div>
        )}

        {weeks && weeks.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
            <History className="size-8" strokeWidth={ICON_STROKE.large} />
            <p className="text-sm sm:text-base">아직 보관된 기록이 없습니다.</p>
            <p className="text-xs sm:text-sm">매주 초기화 직전 백업된 기록이 있으면 여기에 표시됩니다.</p>
          </div>
        )}

        {loadingList && <p className="text-center font-mono text-xs text-muted-foreground sm:text-sm">불러오는 중...</p>}
        {listError && (
          <Alert variant="destructive">
            <AlertDescription>{listError}</AlertDescription>
          </Alert>
        )}

        {detail && (
          <>
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-bold sm:text-base">{formatWeekLabel(detail.weekOf)} 내 대시보드</span>
              {detail.personal ? (
                <StatusView status={detail.personal} />
              ) : (
                <p className="py-4 text-sm text-muted-foreground sm:text-base">이 주차에는 내 기록이 없습니다.</p>
              )}
            </div>

            <div className="h-px w-full bg-border" />

            <div className="flex flex-col gap-2">
              <span className="text-sm font-bold sm:text-base">전체 대시보드</span>
              <RosterView members={detail.roster.members} />
            </div>
          </>
        )}

        {loadingDetail && <p className="text-center font-mono text-xs text-muted-foreground sm:text-sm">불러오는 중...</p>}
        {detailError && (
          <Alert variant="destructive">
            <AlertDescription>{detailError}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
