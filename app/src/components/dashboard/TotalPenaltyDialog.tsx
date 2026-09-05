import { Search, ShieldAlert, TriangleAlert, Radio, CalendarClock } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoCard, ItemTitle, formatTotalPenalty } from "@/components/dashboard/shared";
import { PenaltyHistorySection } from "@/components/admin/shared";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import type { TotalPenaltyBreakdown } from "@/lib/api/types";

// 관리자 "예치금 재납 대상자"의 송출 P 슬롯 차수(1~6차) → 조치명 매핑과
// 동일하게 맞춘다(PenaltyCandidateList.OUTPUT_PEN_SLOT_LABELS). 두 화면이
// 같은 시트 슬롯을 가리키므로 라벨도 동일해야 한다.
const OUTPUT_PEN_SLOT_LABELS = [
  "구두경고 (1차)",
  "벌점 (1차)",
  "벌점 (2차)",
  "페널티 (1차)",
  "벌점 (3차)",
  "페널티 (2차)",
];

export function TotalPenaltyDialog({
  outputPen,
  timePen,
  breakdown,
  token,
  children,
}: {
  outputPen: number;
  timePen: number;
  breakdown: TotalPenaltyBreakdown;
  token: string | undefined;
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
            <span className="flex items-center gap-1.5">
              <ShieldAlert className="size-3.5 shrink-0 text-primary sm:size-4" />
              <ItemTitle>총 페널티</ItemTitle>
            </span>
            <span
              className={cn(
                "text-right text-sm sm:text-base",
                total >= 2 ? "text-destructive" : total === 1 ? "text-amber-600 dark:text-amber-400" : undefined
              )}
            >
              {formatTotalPenalty(outputPen, timePen)}
            </span>
          </InfoCard>

          <InfoCard className="flex flex-col gap-3">
            <PenaltyHistorySection
              icon={Radio}
              title="송출 P 원인"
              history={breakdown.outputPenHistory}
              slotLabels={OUTPUT_PEN_SLOT_LABELS}
              token={token}
            />
            <div className="h-px w-full bg-border" />
            <PenaltyHistorySection
              icon={CalendarClock}
              title="주간 P 원인"
              history={breakdown.timePenHistory}
              token={token}
            />
          </InfoCard>

          <InfoCard className="flex flex-col gap-1 border-destructive/30 bg-destructive/5">
            <div className="flex items-center gap-1.5 text-destructive">
              <TriangleAlert className="size-3.5 shrink-0 sm:size-4" />
              <ItemTitle className="text-destructive">주의사항</ItemTitle>
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
