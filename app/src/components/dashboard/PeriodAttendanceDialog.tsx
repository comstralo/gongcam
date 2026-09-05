import { ListChecks, Search, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SubRow, InfoCard, ItemTitle, DividedValue } from "@/components/dashboard/shared";
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
  const isLow = breakdown.rate !== null && breakdown.rate < 85;

  return (
    <Dialog>
      <DialogTrigger className="w-full rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        {children}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Search className="size-4 text-primary sm:size-5" />
            주간 교시 참여율 · 세부사항
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <InfoCard className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5">
                <ListChecks className="size-3.5 shrink-0 text-primary sm:size-4" />
                <ItemTitle>주간 교시 참여율</ItemTitle>
              </span>
              <span className="text-xs sm:text-sm">
                {breakdown.applicable ? (
                  <DividedValue
                    items={[
                      <span key="rate" className={isLow ? "text-destructive" : undefined}>
                        {periodAttendanceRate}
                      </span>,
                      <span key="threshold" className="text-ok">
                        85%
                      </span>,
                    ]}
                  />
                ) : (
                  "-"
                )}
              </span>
            </div>
            {breakdown.applicable ? (
              <div className="flex flex-col gap-1.5">
                <SubRow label="① 85% 이상 달성 교시" value={`${breakdown.achievedCount}개`} valueClassName="font-sans" />
                <SubRow label="② 오류(ERR) 발생 교시" value={`${breakdown.errorCount}개`} valueClassName="font-sans" />
                <div className="flex flex-col">
                  <SubRow label="③ 목표 교시 수" value={`${breakdown.targetPeriods}개`} valueClassName="font-sans" />
                  <span className="pl-8.5 text-micro leading-tight text-amber-600 sm:pl-9.5 sm:text-micro-lg dark:text-amber-400">
                    * 사유 반휴 사용 시, 목표량 감소
                  </span>
                </div>
                <span className="pl-5 text-micro text-muted-foreground before:mr-1 before:content-['└'] sm:pl-5.5 sm:text-micro-lg">
                  참여율 = (① + ②) ÷ ③ × 100
                </span>
              </div>
            ) : (
              <span className="pl-5 text-micro text-amber-600 sm:pl-5.5 sm:text-micro-lg dark:text-amber-400">
                * 달성제 참여자는 집계되지 않습니다.
              </span>
            )}
          </InfoCard>

          <InfoCard className="flex flex-col gap-1 border-destructive/30 bg-destructive/5">
            <div className="flex items-center gap-1.5 text-destructive">
              <TriangleAlert className="size-3.5 shrink-0 sm:size-4" />
              <ItemTitle className="text-destructive">주의사항</ItemTitle>
            </div>
            <ul className="flex flex-col gap-1 text-micro-lg leading-relaxed text-muted-foreground sm:text-xs">
              <li className="flex gap-1.5">
                <span className="text-destructive/60">•</span>
                교시 참여율이 85% 미만인 경우, 주간 P가 1회 적립됩니다.
              </li>
              <li className="flex gap-1.5">
                <span className="text-destructive/60">•</span>
                교시제 참여자가 달성제처럼 자유롭게 참여할 경우, 주간 P 위험이 증가합니다.
              </li>
            </ul>
          </InfoCard>
        </div>
      </DialogContent>
    </Dialog>
  );
}
