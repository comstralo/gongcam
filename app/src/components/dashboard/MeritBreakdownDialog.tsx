import { Award, TrendingDown, TrendingUp, Gauge, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SubRow, InfoCard, DividedValue } from "@/components/dashboard/shared";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import type { WeeklyMeritBreakdown } from "@/lib/api/types";

function pt(n: number | null | undefined) {
  const abs = Math.abs(n ?? 0)
    .toFixed(4)
    .replace(/\.?0+$/, "");
  return `${abs}점`;
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
              주간 총 상점
            </span>
            <span className={cn("font-mono text-sm font-bold sm:text-base", breakdown.isZero && "text-destructive")}>
              <DividedValue
                items={[
                  weeklyMeritRank && !weeklyMeritRank.startsWith("-") ? `+${weeklyMerit || "0"}` : weeklyMerit || "0",
                  weeklyMeritRank || "-",
                ]}
              />
            </span>
          </InfoCard>

          <InfoCard className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <TrendingUp className="size-3.5 shrink-0 text-primary sm:size-4" />
              적립 원인
            </span>
            <SubRow label="학습시간 상점" value={`+${pt(breakdown.studyTimeMerit)}`} valueClassName="text-ok" />
            <SubRow
              label="제보상점"
              value={breakdown.reportMeritIncluded ? `+${pt(breakdown.reportMerit)}` : pt(0)}
              valueClassName={breakdown.reportMeritIncluded ? "text-ok" : "text-muted-foreground/60"}
            />
          </InfoCard>

          <InfoCard className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <TrendingDown className="size-3.5 shrink-0 text-primary sm:size-4" />
              차감 원인
            </span>
            <SubRow
              label="송출 P 벌점"
              value={(breakdown.penaltyDeduction ?? 0) > 0 ? `-${pt(breakdown.penaltyDeduction)}` : pt(0)}
              valueClassName={(breakdown.penaltyDeduction ?? 0) > 0 ? "text-destructive" : undefined}
            />
            <SubRow
              label={`벌금 차감 (₩${(breakdown.weeklyTotalFineAmount ?? 0).toLocaleString()})`}
              value={(breakdown.fineDeduction ?? 0) > 0 ? `-${pt(breakdown.fineDeduction)}` : pt(0)}
              valueClassName={(breakdown.fineDeduction ?? 0) > 0 ? "text-destructive" : undefined}
            />
          </InfoCard>

          <InfoCard className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <Gauge className="size-3.5 shrink-0 text-primary sm:size-4" />
              상점 배율
            </span>
            <SubRow label="적용 배율" value={`× ${breakdown.multiplier ?? 1}`} />
          </InfoCard>

          <InfoCard className="flex flex-col gap-1 border-destructive/30 bg-destructive/5">
            <div className="flex items-center gap-1.5 text-destructive">
              <TriangleAlert className="size-3.5 shrink-0 sm:size-4" />
              <span className="text-xs font-semibold sm:text-sm">주의사항</span>
            </div>
            <ul className="flex flex-col gap-1 text-xs leading-relaxed text-muted-foreground sm:text-sm">
              <li className="flex gap-1.5">
                <span className="text-destructive/60">•</span>
                제보상점은 금요일에 일괄 반영됩니다.
              </li>
              {breakdown.isZero && breakdown.zeroReason && (
                <li className="flex gap-1.5">
                  <span className="text-destructive/60">•</span>
                  {breakdown.zeroReason}에 해당해 이번 주 상점이 0점으로 처리되어 순위 계산에서 제외됩니다.
                </li>
              )}
            </ul>
          </InfoCard>
        </div>
      </DialogContent>
    </Dialog>
  );
}
