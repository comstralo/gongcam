import { Award } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { SubRow } from "@/components/dashboard/shared";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import type { WeeklyMeritBreakdown } from "@/lib/api/types";

function pt(n: number) {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(3).replace(/\.?0+$/, "")}점`;
}

export function MeritBreakdownDialog({
  weeklyMerit,
  weeklyMeritRank,
  breakdown,
  children,
}: {
  weeklyMerit: string;
  weeklyMeritRank: string;
  breakdown: WeeklyMeritBreakdown;
  children: ReactNode;
}) {
  return (
    <Dialog>
      <DialogTrigger className="w-full text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded-xl">
        {children}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Award className="size-4 text-primary sm:size-5" />
            주간 총 상점 산정 내역
          </DialogTitle>
          <DialogDescription>이번 주 상점이 이렇게 계산되었습니다.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5 rounded-lg border bg-muted p-3.5">
            <SubRow
              label={breakdown.isLeader ? "제보상점 (스터디장 고정)" : "제보상점"}
              value={pt(breakdown.reportMerit)}
            />
            <SubRow label="학습시간 상점" value={pt(breakdown.studyTimeMerit)} />
            {breakdown.penaltyDeduction > 0 && (
              <SubRow
                label="벌점 차감"
                value={`-${breakdown.penaltyDeduction.toFixed(3).replace(/\.?0+$/, "")}점`}
                valueClassName="text-destructive"
              />
            )}
            {breakdown.fineDeduction > 0 && (
              <SubRow
                label={`벌금 차감 (₩${breakdown.weeklyTotalFineAmount.toLocaleString()})`}
                value={`-${breakdown.fineDeduction.toFixed(3).replace(/\.?0+$/, "")}점`}
                valueClassName="text-destructive"
              />
            )}
          </div>

          <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted p-3.5">
            <span className="text-sm font-semibold sm:text-base">최종 상점</span>
            <span className={cn("font-mono text-sm font-bold sm:text-base", breakdown.isZero && "text-destructive")}>
              {weeklyMerit} · {weeklyMeritRank}
            </span>
          </div>

          {breakdown.isZero && breakdown.zeroReason && (
            <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
              <span className="font-semibold text-destructive">순위가 "-"로 표시되는 이유: </span>
              {breakdown.zeroReason}에 해당해 이번 주 상점이 0점으로 처리되어 순위 계산에서 제외됩니다.
            </p>
          )}

          <p className="text-micro-lg text-muted-foreground/70">
            학습시간·목표달성 배율 등 세부 가중치는 반영되어 최종 상점(시트 값)과 항목 합계가 다를 수 있습니다.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
