import { Search, ShieldAlert, TriangleAlert, Radio, CalendarClock } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoCard, formatTotalPenalty } from "@/components/dashboard/shared";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import type { TotalPenaltyBreakdown } from "@/lib/api/types";

export function TotalPenaltyDialog({
  outputPen,
  timePen,
  breakdown,
  children,
}: {
  outputPen: number;
  timePen: number;
  breakdown: TotalPenaltyBreakdown;
  children: ReactNode;
}) {
  const total = outputPen + timePen;

  return (
    <Dialog>
      <DialogTrigger className="w-full rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        {children}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Search className="size-4 text-primary sm:size-5" />
            총 페널티 · 세부사항
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <InfoCard className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <ShieldAlert className="size-3.5 shrink-0 text-primary sm:size-4" />
              총 페널티
            </span>
            <span
              className={cn(
                "flex flex-col text-right text-xs font-semibold sm:text-sm",
                total >= 2 ? "text-destructive" : total === 1 ? "text-amber-600 dark:text-amber-400" : undefined
              )}
            >
              <span>{formatTotalPenalty(outputPen, timePen)}</span>
              {total >= 2 && <span className="text-micro sm:text-micro-lg">* 예치금 재납 대상</span>}
            </span>
          </InfoCard>

          <InfoCard className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <Radio className="size-3.5 shrink-0 text-primary sm:size-4" />
              송출 P 원인
            </span>
            {outputPen > 0 && breakdown.outputPenReasons.length > 0 ? (
              <ul className="flex flex-col gap-1 pl-5 text-xs text-muted-foreground sm:pl-5.5 sm:text-sm">
                {breakdown.outputPenReasons.map((reason, i) => (
                  <li key={i} className="before:mr-1 before:content-['└']">
                    {reason}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pl-5 text-micro-lg text-muted-foreground/70 sm:pl-5.5">해당 없음</p>
            )}
          </InfoCard>

          <InfoCard className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <CalendarClock className="size-3.5 shrink-0 text-primary sm:size-4" />
              주간 P 원인
            </span>
            {timePen > 0 && breakdown.timePenReasons.length > 0 ? (
              <ul className="flex flex-col gap-1 pl-5 text-xs text-muted-foreground sm:pl-5.5 sm:text-sm">
                {breakdown.timePenReasons.map((reason, i) => (
                  <li key={i} className="before:mr-1 before:content-['└']">
                    {reason}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pl-5 text-micro-lg text-muted-foreground/70 sm:pl-5.5">해당 없음</p>
            )}
          </InfoCard>

          <InfoCard className="flex flex-col gap-1 border-destructive/30 bg-destructive/5">
            <div className="flex items-center gap-1.5 text-destructive">
              <TriangleAlert className="size-3.5 shrink-0 sm:size-4" />
              <span className="text-xs font-semibold sm:text-sm">주의사항</span>
            </div>
            <ul className="flex flex-col gap-1 text-micro-lg leading-relaxed text-muted-foreground sm:text-xs">
              <li className="flex gap-1.5">
                <span className="text-destructive/60">•</span>
                조회 당일 기준입니다. 이후 기록에 따라 값이 달라질 수 있습니다.
              </li>
              <li className="flex gap-1.5">
                <span className="text-destructive/60">•</span>
                송출 P + 주간 P 합이 예치금 반환액에도 영향을 줍니다.
              </li>
            </ul>
          </InfoCard>
        </div>
      </DialogContent>
    </Dialog>
  );
}
