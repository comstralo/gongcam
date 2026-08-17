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
          <DialogDescription>이번 주 상점이 이렇게 계산되었습니다.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-1.5 rounded-lg border bg-muted p-3.5">
            <span className="text-micro-lg font-semibold tracking-wide text-muted-foreground uppercase sm:text-xs">
              상점 적립
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
          </div>

          <div className="flex flex-col gap-1.5 rounded-lg border bg-muted p-3.5">
            <span className="text-micro-lg font-semibold tracking-wide text-muted-foreground uppercase sm:text-xs">
              상점 차감
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
          </div>

          <div className="flex flex-col gap-1.5 rounded-lg border bg-muted p-3.5">
            <span className="text-micro-lg font-semibold tracking-wide text-muted-foreground uppercase sm:text-xs">
              목표시간 배율
            </span>
            <SubRow label="적용 배율" value={`× ${breakdown.multiplier ?? 1}`} />
          </div>

          <div className="flex flex-col gap-1.5 rounded-lg border bg-muted p-3.5">
            <span className="text-micro-lg font-semibold tracking-wide text-muted-foreground uppercase sm:text-xs">
              최종 상점
            </span>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold sm:text-base">이번 주 상점 · 순위</span>
              <span
                className={cn("font-mono text-sm font-bold sm:text-base", breakdown.isZero && "text-destructive")}
              >
                {weeklyMerit} · {weeklyMeritRank}
              </span>
            </div>
          </div>

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
