import { Award, Search, TrendingDown, TrendingUp, Gauge, CircleCheck, Circle } from "lucide-react";
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

// 시트 원본 값("8H (교시제)")의 괄호를 지워 "8H 교시제"로 표시한다.
function formatGoalType(raw: string): string {
  if (!raw) return "-";
  return raw.replace(/[()]/g, "").replace(/\s+/g, " ").trim();
}

export function MeritBreakdownDialog({
  weeklyMerit,
  weeklyMeritRank,
  goalType,
  breakdown,
  children,
}: {
  weeklyMerit: string;
  weeklyMeritRank: string;
  goalType: string;
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
            <Search className="size-4 text-primary sm:size-5" />
            주간 총 상점 · 세부사항
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* 🔧 2026-09: 이 총점 요약 행이 아래 4개 섹션 헤더("상점 적립
              원인" 등)와 똑같은 text-xs sm:text-sm 크기를 써서, 정작 이
              화면에서 가장 중요한 숫자인데도 하위 섹션 제목과 구분이
              안 됐다(사용자 지적: 모바일에서 위계가 안 맞아 보임 — 실제로는
              모바일/데스크톱 둘 다 구분이 없던 것). ItemTitle 크기 체계
              (text-sm sm:text-base, admin/shared.tsx의 SectionHeader>
              ItemTitle>FieldLabel 3단 체계와 같은 발상)로 한 단계 올려
              총점 > 섹션 헤더 > 세부 항목 위계가 두 화면 크기 모두에서
              일관되게 보이도록 했다. */}
          <InfoCard className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-sm font-semibold sm:text-base">
              <Award className="size-3.5 shrink-0 text-primary sm:size-4" />
              주간 총 상점
            </span>
            <span
              className={cn(
                "text-sm tabular-nums sm:text-base",
                breakdown.isZero ? "text-muted-foreground" : "text-ok"
              )}
            >
              <DividedValue
                items={[
                  `+${weeklyMerit || "0"}`,
                  breakdown.isZero ? "제외" : weeklyMeritRank || "-",
                ]}
              />
            </span>
          </InfoCard>

          <InfoCard className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <TrendingUp className="size-3.5 shrink-0 text-primary sm:size-4" />
              상점 적립 원인
            </span>
            <SubRow
              label={`주간 학습시간 상점 (${breakdown.studyTimeHours ?? 0}H)`}
              value={(breakdown.studyTimeMerit ?? 0) > 0 ? `+${pt(breakdown.studyTimeMerit)}` : `+${pt(0)}`}
              valueClassName={cn("font-sans", (breakdown.studyTimeMerit ?? 0) > 0 ? "text-ok" : "text-muted-foreground")}
            />
            <div className="flex flex-col">
              <SubRow
                label={`주간 제보상점 (인정 ${breakdown.reportApprovedCount ?? 0}건)`}
                value={
                  breakdown.reportMeritIncluded && (breakdown.reportMerit ?? 0) > 0
                    ? `+${pt(breakdown.reportMerit)}`
                    : `+${pt(0)}`
                }
                valueClassName={cn(
                  "font-sans",
                  breakdown.reportMeritIncluded && (breakdown.reportMerit ?? 0) > 0
                    ? "text-ok"
                    : "text-muted-foreground"
                )}
              />
              <span className="pl-8.5 text-micro leading-tight text-amber-600 sm:pl-9.5 sm:text-micro-lg dark:text-amber-400">
                * 주중 랜덤 반영
              </span>
            </div>
          </InfoCard>

          <InfoCard className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <TrendingDown className="size-3.5 shrink-0 text-primary sm:size-4" />
              상점 차감 원인
            </span>
            <SubRow
              label="주간 송출 벌점"
              value={(breakdown.penaltyDeduction ?? 0) > 0 ? `-${pt(breakdown.penaltyDeduction)}` : `-${pt(0)}`}
              valueClassName={cn("font-sans", (breakdown.penaltyDeduction ?? 0) > 0 ? "text-destructive" : "text-muted-foreground")}
            />
            <SubRow
              label="주간 벌금 (500원 당)"
              value={(breakdown.fineDeduction ?? 0) > 0 ? `-${pt(breakdown.fineDeduction)}` : `-${pt(0)}`}
              valueClassName={cn("font-sans", (breakdown.fineDeduction ?? 0) > 0 ? "text-destructive" : "text-muted-foreground")}
            />
          </InfoCard>

          {breakdown.isZero && breakdown.zeroConditions?.length > 0 && (
            <InfoCard className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
                <TrendingDown className="size-3.5 shrink-0 text-destructive sm:size-4" />
                상점 제외 원인
              </span>
              <ul className="flex flex-col gap-1 pl-5 sm:pl-5.5">
                {breakdown.zeroConditions.map((cond) => (
                  <li
                    key={cond.key}
                    className={cn(
                      "flex items-center gap-1.5 text-micro-lg sm:text-xs",
                      cond.met ? "text-destructive" : "text-muted-foreground"
                    )}
                  >
                    {cond.met ? (
                      <CircleCheck className="size-3.5 shrink-0" />
                    ) : (
                      <Circle className="size-3.5 shrink-0" />
                    )}
                    <span>주간 {cond.label}</span>
                  </li>
                ))}
              </ul>
            </InfoCard>
          )}

          <InfoCard className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <Gauge className="size-3.5 shrink-0 text-primary sm:size-4" />
              상점 배율
            </span>
            <div className="flex flex-col">
              <SubRow
                label={formatGoalType(goalType)}
                value={`× ${breakdown.multiplier ?? 1}`}
                valueClassName={cn("font-sans", breakdown.multiplierDowngraded && "text-destructive")}
              />
              <span className="pl-8.5 text-micro leading-tight text-amber-600 sm:pl-9.5 sm:text-micro-lg dark:text-amber-400">
                * 사유반휴 2장 사용 시, 8H 기준으로 강등
              </span>
            </div>
          </InfoCard>
        </div>
      </DialogContent>
    </Dialog>
  );
}
