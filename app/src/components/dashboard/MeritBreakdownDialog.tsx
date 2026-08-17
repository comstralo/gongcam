import { Award, TrendingDown, TrendingUp, Gauge } from "lucide-react";
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
import type { WeeklyMeritBreakdown } from "@/lib/api/types";

function pt(n: number | null | undefined) {
  const value = n ?? 0;
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  const abs = Math.abs(value)
    .toFixed(4)
    .replace(/\.?0+$/, "");
  return `${sign}${abs}점`;
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
      <DialogTrigger className="w-full rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        {children}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Award className="size-4 text-primary sm:size-5" />
            주간 총 상점 · 세부사항
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <InfoCard className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <Award className="size-3.5 shrink-0 text-primary sm:size-4" />
              이번 주 상점 · 순위
            </span>
            <span className={cn("font-mono text-sm font-bold sm:text-base", breakdown.isZero && "text-destructive")}>
              {weeklyMerit} · {weeklyMeritRank}
            </span>
          </InfoCard>

          <InfoCard className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <TrendingUp className="size-3.5 shrink-0 text-primary sm:size-4" />
              적립 원인
            </span>
            <SubRow label="학습시간 상점" value={pt(breakdown.studyTimeMerit)} />
            <SubRow
              label={breakdown.isLeader ? "제보상점 (스터디장 고정)" : "제보상점"}
              value={breakdown.reportMeritIncluded ? pt(breakdown.reportMerit) : pt(0)}
              valueClassName={!breakdown.reportMeritIncluded ? "text-muted-foreground/60" : undefined}
            />
            {!breakdown.reportMeritIncluded && (
              <p className="pl-5 text-micro-lg text-muted-foreground/70 sm:pl-5.5">
                주중(월~금) 기록이 모두 끝나야 이번 주 계산에 포함됩니다 — 현재는 미반영
              </p>
            )}
          </InfoCard>

          <InfoCard className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <TrendingDown className="size-3.5 shrink-0 text-primary sm:size-4" />
              차감 원인
            </span>
            <SubRow
              label="벌점 차감"
              value={(breakdown.penaltyDeduction ?? 0) > 0 ? pt(-breakdown.penaltyDeduction) : pt(0)}
              valueClassName={(breakdown.penaltyDeduction ?? 0) > 0 ? "text-destructive" : undefined}
            />
            <SubRow
              label={`벌금 차감 (₩${(breakdown.weeklyTotalFineAmount ?? 0).toLocaleString()})`}
              value={(breakdown.fineDeduction ?? 0) > 0 ? pt(-breakdown.fineDeduction) : pt(0)}
              valueClassName={(breakdown.fineDeduction ?? 0) > 0 ? "text-destructive" : undefined}
            />
          </InfoCard>

          <InfoCard className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <Gauge className="size-3.5 shrink-0 text-primary sm:size-4" />
              목표시간 배율
            </span>
            <SubRow label="적용 배율" value={`× ${breakdown.multiplier ?? 1}`} />
          </InfoCard>

          {breakdown.isZero && breakdown.zeroReason && (
            <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
              <span className="font-semibold text-destructive">순위가 "-"로 표시되는 이유: </span>
              {breakdown.zeroReason}에 해당해 이번 주 상점이 0점으로 처리되어 순위 계산에서 제외됩니다.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
