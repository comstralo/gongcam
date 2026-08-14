import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SessionCard } from "@/components/session/SessionCard";
import { useApi } from "@/hooks/useApi";
import type { StatusResponse } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const TODAY_INDEX = (new Date().getDay() + 6) % 7; // 월=0 ... 일=6

function won(n: number) {
  return "₩" + (n || 0).toLocaleString();
}

export function StatusPage() {
  const { call } = useApi();
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState<number>(TODAY_INDEX);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    call<StatusResponse>("/status")
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "상태를 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card className="w-full page-content">
      <CardContent className="flex flex-col gap-4">
        <SessionCard />

        <div className="flex gap-2.5">
          <div className="flex flex-1 flex-col gap-1 rounded-lg border bg-muted p-3.5 sm:p-4.5">
            <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground sm:text-xs">목표 유형</span>
            <span className="font-mono text-[15px] font-bold sm:text-lg">{status?.goalType || "-"}</span>
          </div>
          <div className="flex flex-1 flex-col gap-1 rounded-lg border bg-muted p-3.5 sm:p-4.5">
            <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground sm:text-xs">
              이번 주 확정 벌금
            </span>
            <span
              className={cn(
                "font-mono text-[22px] font-bold tabular-nums sm:text-3xl",
                status && status.weekTotalConfirmed > 0 ? "text-destructive" : "text-ok"
              )}
            >
              {won(status?.weekTotalConfirmed ?? 0)}
            </span>
          </div>
        </div>

        {status && (
          <>
            <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
              {status.days.map((d, i) => (
                <button
                  key={d.day}
                  type="button"
                  onClick={() => setSelectedDay(i)}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-lg border bg-muted py-2.5 font-mono text-xs font-bold transition-colors sm:py-3 sm:text-sm",
                    i === selectedDay
                      ? "border-primary bg-primary text-primary-foreground"
                      : i === TODAY_INDEX
                        ? "border-primary"
                        : "border-transparent"
                  )}
                >
                  {d.day}
                  <span
                    className={cn(
                      "size-1.25 rounded-full sm:size-1.5",
                      i === selectedDay
                        ? "bg-primary-foreground/70"
                        : d.total > 0
                          ? "bg-destructive"
                          : "bg-ok"
                    )}
                  />
                </button>
              ))}
            </div>

            {status.days[selectedDay] && (
              <div
                className={cn(
                  "flex flex-col gap-1.5 rounded-lg border bg-muted p-3.5 sm:gap-2 sm:p-4.5",
                  selectedDay === TODAY_INDEX && "border-primary"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm font-bold sm:text-base">{status.days[selectedDay].day}요일</span>
                  <Badge variant={status.days[selectedDay].confirmed ? "default" : "outline"} className="text-[10px] sm:text-xs">
                    {status.days[selectedDay].confirmed ? "확정" : "진행중"}
                  </Badge>
                </div>
                <div
                  className={cn(
                    "font-mono text-xl font-bold tabular-nums sm:text-2xl",
                    status.days[selectedDay].total > 0 ? "text-destructive" : "text-ok"
                  )}
                >
                  {won(status.days[selectedDay].total)}
                </div>
                <div className="text-sm leading-relaxed text-muted-foreground sm:text-base">
                  {status.days[selectedDay].explain}
                </div>
              </div>
            )}
          </>
        )}

        {loading && <p className="text-center font-mono text-xs text-muted-foreground sm:text-sm">불러오는 중...</p>}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
