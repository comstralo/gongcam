import { ListChecks, CheckCheck, Search, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SubRow, InfoCard } from "@/components/dashboard/shared";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import type { PeriodAttendanceBreakdown } from "@/lib/api/types";

export function PeriodAttendanceDialog({
  periodAttendanceRate,
  breakdown,
  children,
}: {
  periodAttendanceRate: string;
  breakdown: PeriodAttendanceBreakdown;
  children: ReactNode;
}) {
  const isLow = breakdown.rate !== null && breakdown.rate < 80;

  return (
    <Dialog>
      <DialogTrigger className="w-full rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        {children}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Search className="size-4 text-primary sm:size-5" />
            교시 참여율 · 세부사항
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <InfoCard className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <ListChecks className="size-3.5 shrink-0 text-primary sm:size-4" />
              교시 참여율
            </span>
            <span className={cn("font-mono text-sm font-bold sm:text-base", isLow && "text-destructive")}>
              {periodAttendanceRate}
            </span>
          </InfoCard>

          {breakdown.applicable ? (
            <InfoCard className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
                <CheckCheck className="size-3.5 shrink-0 text-primary sm:size-4" />
                통과된 교시 카운트
              </span>
              <SubRow label="85% 이상 달성 교시" value={`${breakdown.achievedCount}교시`} />
              <SubRow label="오류(ERR) 처리 교시" value={`${breakdown.errorCount}교시`} />
              <SubRow label="목표 교시 수" value={`${breakdown.targetPeriods}교시`} />
            </InfoCard>
          ) : (
            <InfoCard className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground sm:text-sm">
                교시제 목표시간(8H/9H/10H 교시제)이 아니면 참여율이 집계되지 않습니다.
              </span>
            </InfoCard>
          )}

          <InfoCard className="flex flex-col gap-1 border-destructive/30 bg-destructive/5">
            <div className="flex items-center gap-1.5 text-destructive">
              <TriangleAlert className="size-3.5 shrink-0 sm:size-4" />
              <span className="text-xs font-semibold sm:text-sm">주의사항</span>
            </div>
            <ul className="flex flex-col gap-1 text-xs leading-relaxed text-muted-foreground sm:text-sm">
              <li className="flex gap-1.5">
                <span className="text-destructive/60">•</span>
                조회 당일 기준입니다. 이후 기록에 따라 값이 달라질 수 있습니다.
              </li>
              <li className="flex gap-1.5">
                <span className="text-destructive/60">•</span>
                참여율이 80% 미만이면 주간 P(페널티) 대상이 될 수 있습니다.
              </li>
            </ul>
          </InfoCard>
        </div>
      </DialogContent>
    </Dialog>
  );
}
