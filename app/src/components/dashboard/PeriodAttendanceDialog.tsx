import { ListChecks, Search, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SubRow, InfoCard, DividedValue } from "@/components/dashboard/shared";
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
          <InfoCard className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
                <ListChecks className="size-3.5 shrink-0 text-primary sm:size-4" />
                교시 참여율
              </span>
              <span className="font-mono text-sm font-bold sm:text-base">
                <DividedValue
                  items={[
                    <span key="rate" className={isLow ? "text-destructive" : undefined}>
                      {periodAttendanceRate}
                    </span>,
                    <span key="threshold" className="text-muted-foreground">
                      80%
                    </span>,
                  ]}
                />
              </span>
            </div>
            {breakdown.applicable ? (
              <div className="flex flex-col gap-1.5">
                <SubRow label="① 85% 이상 달성 교시" value={`${breakdown.achievedCount}개`} />
                <SubRow label="② 오류(ERR) 처리 교시" value={`${breakdown.errorCount}개`} />
                <div className="flex flex-col">
                  <SubRow label="③ 목표 교시 수" value={`${breakdown.targetPeriods}개`} />
                  <span className="pl-8.5 text-micro leading-tight text-amber-600 sm:pl-9.5 sm:text-micro-lg dark:text-amber-400">
                    * 사유 반휴 사용 시, 목표량 감소
                  </span>
                </div>
                <span className="pl-5 text-micro text-amber-600 before:mr-1 before:content-['└'] sm:pl-5.5 sm:text-micro-lg dark:text-amber-400">
                  참여율 = (① + ②) ÷ ③ × 100
                </span>
              </div>
            ) : (
              <span className="pl-5 text-xs text-muted-foreground sm:pl-5.5 sm:text-sm">
                교시제 목표시간(8H/9H/10H 교시제)이 아니면 참여율이 집계되지 않습니다.
              </span>
            )}
          </InfoCard>

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
