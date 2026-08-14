import { useEffect, useState } from "react";
import { Clock, CircleCheck, CircleDot, CalendarDays, Award, PalmtreeIcon, HeartHandshake, Timer } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useApi } from "@/hooks/useApi";
import type { StatusResponse } from "@/lib/api/types";
import { cn } from "@/lib/utils";

type SummaryTile = {
  key: string;
  icon: typeof Clock;
  label: string;
  value: string;
};

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

  const selected = status?.days[selectedDay];

  const summaryTiles: SummaryTile[] = status
    ? [
        { key: "goalType", icon: Clock, label: "목표시간", value: status.goalType || "-" },
        { key: "joinDate", icon: CalendarDays, label: "가입일자", value: status.joinDate || "-" },
        { key: "merit", icon: Award, label: "주간 총 상점", value: status.weeklyMerit || "0" },
        { key: "normalLeave", icon: PalmtreeIcon, label: "일반 반휴 잔여", value: `${status.normalLeaveLeft}회` },
        { key: "reasonLeave", icon: HeartHandshake, label: "사유 반휴 잔여", value: `${status.reasonLeaveLeft}회` },
      ]
    : [];

  return (
    <Card className="w-full page-content">
      <CardContent className="flex flex-col gap-5">
        {status && (
          <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-2.5">
            {summaryTiles.map((tile) => {
              const Icon = tile.icon;
              return (
                <div key={tile.key} className="flex flex-col gap-1.5 rounded-xl border bg-muted px-3.5 py-3 sm:px-4 sm:py-3.5">
                  <div className="flex items-center gap-1.25 text-muted-foreground">
                    <Icon className="size-3.5 shrink-0 sm:size-4" strokeWidth={2.25} />
                    <span className="truncate text-[11px] font-semibold tracking-wide uppercase sm:text-xs">
                      {tile.label}
                    </span>
                  </div>
                  <span className="truncate text-base font-bold sm:text-lg">{tile.value}</span>
                </div>
              );
            })}
          </section>
        )}

        {status && (
          <section className="flex flex-col gap-2">
            <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
              {status.days.map((d, i) => {
                const isSelected = i === selectedDay;
                return (
                  <button
                    key={d.day}
                    type="button"
                    onClick={() => setSelectedDay(i)}
                    className={cn(
                      "relative flex flex-col items-center gap-1 rounded-full border py-2.5 text-sm font-bold transition-all sm:py-3 sm:text-base",
                      isSelected
                        ? "border-primary bg-primary text-primary-foreground shadow-sm"
                        : "border-border bg-card text-foreground hover:border-primary/50 hover:bg-muted"
                    )}
                  >
                    {i === TODAY_INDEX && !isSelected && (
                      <span className="absolute -top-1 size-1.25 rounded-full bg-primary sm:size-1.5" />
                    )}
                    {d.day}
                  </button>
                );
              })}
            </div>

            {selected && (
              <div
                className={cn(
                  "flex flex-col gap-2 rounded-xl border p-4 sm:gap-2.5 sm:p-5",
                  selected.total > 0 ? "border-destructive/30 bg-destructive/5" : "border-ok/30 bg-ok/5"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-bold sm:text-base">
                    {selected.day}요일
                    {selectedDay === TODAY_INDEX && (
                      <span className="ml-1.5 text-xs font-medium text-primary sm:text-sm">오늘</span>
                    )}
                  </span>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold sm:text-xs",
                      selected.confirmed
                        ? "bg-foreground/8 text-foreground"
                        : "bg-primary/15 text-primary"
                    )}
                  >
                    {selected.confirmed ? (
                      <CircleCheck className="size-3 sm:size-3.5" strokeWidth={2.5} />
                    ) : (
                      <CircleDot className="size-3 sm:size-3.5" strokeWidth={2.5} />
                    )}
                    {selected.confirmed ? "확정" : "진행중"}
                  </span>
                </div>
                <div className="flex items-baseline gap-3">
                  <span
                    className={cn(
                      "font-mono text-2xl font-bold tabular-nums sm:text-3xl",
                      selected.total > 0 ? "text-destructive" : "text-ok"
                    )}
                  >
                    {won(selected.total)}
                  </span>
                  {selected.studyTime && (
                    <span className="inline-flex items-center gap-1 font-mono text-sm text-muted-foreground sm:text-base">
                      <Timer className="size-3.5 sm:size-4" strokeWidth={2.25} />
                      {selected.studyTime}
                    </span>
                  )}
                </div>
                {selected.explain && (
                  <div className="text-sm leading-relaxed text-muted-foreground sm:text-base">{selected.explain}</div>
                )}
              </div>
            )}
          </section>
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
