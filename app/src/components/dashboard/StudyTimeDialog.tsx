import { Timer, Search, CalendarDays, Clock } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoCard } from "@/components/dashboard/shared";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import type { PeriodGridDay } from "@/lib/api/types";

const PERIOD_LABELS = Array.from({ length: 14 }, (_, i) => `${i + 1}교시`);

// 참여율 셀 값을 판정한다: "ERR"=기록 오류, 숫자 85 이상=달성, 그 외 숫자=미달, 빈 값=미기록.
function periodTone(raw: string): { text: string; className?: string } {
  if (!raw) return { text: "-", className: "text-muted-foreground/60" };
  if (raw === "ERR") return { text: "ERR", className: "text-destructive" };
  const n = Number(raw);
  if (Number.isFinite(n)) {
    return { text: `${Math.round(n)}%`, className: n >= 85 ? "text-ok" : "text-destructive" };
  }
  return { text: raw, className: "text-muted-foreground" };
}

export function StudyTimeDialog({
  weeklyStudyTime,
  periodGrid,
  children,
}: {
  weeklyStudyTime: string;
  periodGrid: PeriodGridDay[];
  children: ReactNode;
}) {
  return (
    <Dialog>
      <DialogTrigger className="w-full rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        {children}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Search className="size-4 text-primary sm:size-5" />
            주간 학습시간 · 세부사항
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <InfoCard className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <Timer className="size-3.5 shrink-0 text-primary sm:size-4" />
              주간 학습시간
            </span>
            <span className="text-xs sm:text-sm">{weeklyStudyTime}</span>
          </InfoCard>

          {periodGrid.map((d) => (
            <Collapsible key={d.day}>
              <InfoCard className="flex flex-col gap-1.5">
                <CollapsibleTrigger>
                  <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
                    <CalendarDays className="size-3.5 shrink-0 text-primary sm:size-4" />
                    {d.day}요일
                  </span>
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1.5 sm:grid-cols-2">
                    {d.periods.map((raw, i) => {
                      const { text, className } = periodTone(raw);
                      return (
                        <div key={i} className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1 text-micro-lg text-muted-foreground sm:text-xs">
                            <Clock className="size-2.5 shrink-0 sm:size-3" />
                            {PERIOD_LABELS[i]}
                          </span>
                          <span className={cn("text-micro-lg tabular-nums sm:text-xs", className)}>{text}</span>
                        </div>
                      );
                    })}
                  </div>
                </CollapsiblePanel>
              </InfoCard>
            </Collapsible>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
