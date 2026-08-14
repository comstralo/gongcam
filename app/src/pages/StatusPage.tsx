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

        <div className="flex flex-col gap-2">
          {status?.days.map((d, i) => (
            <div
              key={d.day}
              className={cn(
                "flex gap-2.5 rounded-lg border bg-muted p-3 sm:gap-3.5 sm:p-4",
                i === TODAY_INDEX && "border-primary"
              )}
            >
              <div className="w-6 shrink-0 pt-px font-mono text-xs font-bold sm:w-8 sm:text-sm">{d.day}</div>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className={cn("font-mono text-sm font-bold tabular-nums sm:text-base", d.total > 0 ? "text-destructive" : "text-ok")}>
                  {won(d.total)}
                </div>
                <div className="text-xs leading-relaxed text-muted-foreground sm:text-sm">{d.explain}</div>
                <Badge variant={d.confirmed ? "default" : "outline"} className="w-fit text-[10px] sm:text-xs">
                  {d.confirmed ? "확정" : "진행중"}
                </Badge>
              </div>
            </div>
          ))}
        </div>

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
