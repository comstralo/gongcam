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
          {/* 🔧 2026-09 재정정: 1~2px 단위로 크기만 조금씩 밀고 당기는
              시도를 두 차례 반복했지만 둘 다 위계가 안 읽혔다(사용자
              확인) — 이 크기대(10~14px)에서는 폰트 크기 한 축만으로는
              절대 눈에 띄는 차이가 나지 않는다. 모바일 하이브리드 웹에서
              흔히 쓰는 3단 타이포 스케일(제목=크고 굵고 기본색 / 본문
              보조정보=한 단계 작고 일반 굵기+회색조/muted / 각주=가장
              작고 강조색)을 그대로 적용한다 — 크기·굵기·색 세 축을 함께
              바꿔야 작은 화면에서도 위계가 확실히 읽힌다.
              - 카드 제목(5개 전부 동일): text-sm/base(14/16px), font-bold,
                기본 글자색.
              - 하위 항목(SubRow, 제외 원인 목록): text-xs/sm(12/14px),
                일반 굵기(SubRow 기본값), 회색조(muted-foreground, SubRow
                라벨 기본값 그대로) — 제목과 2px 차이지만 굵기+색이 함께
                바뀌어 실제로는 훨씬 크게 갈려 보인다.
              - 각주(* 주중 랜덤 반영 등): text-micro/micro-lg(10/11px),
                강조색(amber) — 가장 낮은 3번째 단.
              공용 SubRow 컴포넌트의 기본값 자체는 다른 화면에 영향 없도록
              바꾸지 않고, 이 다이얼로그에서만 labelClassName/valueClassName
              으로 크기를 조정한다. */}
          <InfoCard className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-sm font-bold sm:text-base">
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
            <span className="flex items-center gap-1.5 text-sm font-bold sm:text-base">
              <TrendingUp className="size-3.5 shrink-0 text-primary sm:size-4" />
              상점 적립 원인
            </span>
            <SubRow
              label={`학습시간 상점 ${breakdown.studyTimeHours ?? 0}H`}
              value={(breakdown.studyTimeMerit ?? 0) > 0 ? `+${pt(breakdown.studyTimeMerit)}` : `+${pt(0)}`}
              labelClassName="text-xs sm:text-sm"
              valueClassName={cn(
                "font-sans text-xs sm:text-sm",
                (breakdown.studyTimeMerit ?? 0) > 0 ? "text-ok" : "text-muted-foreground"
              )}
            />
            <div className="flex flex-col">
              <SubRow
                label={`제보상점 인정 ${breakdown.reportApprovedCount ?? 0}건`}
                value={
                  breakdown.reportMeritIncluded && (breakdown.reportMerit ?? 0) > 0
                    ? `+${pt(breakdown.reportMerit)}`
                    : `+${pt(0)}`
                }
                labelClassName="text-xs sm:text-sm"
                valueClassName={cn(
                  "font-sans text-xs sm:text-sm",
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
            <span className="flex items-center gap-1.5 text-sm font-bold sm:text-base">
              <TrendingDown className="size-3.5 shrink-0 text-primary sm:size-4" />
              상점 차감 원인
            </span>
            <SubRow
              label="송출 벌점"
              value={(breakdown.penaltyDeduction ?? 0) > 0 ? `-${pt(breakdown.penaltyDeduction)}` : `-${pt(0)}`}
              labelClassName="text-xs sm:text-sm"
              valueClassName={cn(
                "font-sans text-xs sm:text-sm",
                (breakdown.penaltyDeduction ?? 0) > 0 ? "text-destructive" : "text-muted-foreground"
              )}
            />
            <SubRow
              label="벌금 500원 당"
              value={(breakdown.fineDeduction ?? 0) > 0 ? `-${pt(breakdown.fineDeduction)}` : `-${pt(0)}`}
              labelClassName="text-xs sm:text-sm"
              valueClassName={cn(
                "font-sans text-xs sm:text-sm",
                (breakdown.fineDeduction ?? 0) > 0 ? "text-destructive" : "text-muted-foreground"
              )}
            />
          </InfoCard>

          {breakdown.isZero && breakdown.zeroConditions?.length > 0 && (
            <InfoCard className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5 text-sm font-bold sm:text-base">
                <TrendingDown className="size-3.5 shrink-0 text-destructive sm:size-4" />
                상점 제외 원인
              </span>
              <ul className="flex flex-col gap-1 pl-5 sm:pl-5.5">
                {breakdown.zeroConditions.map((cond) => (
                  <li
                    key={cond.key}
                    className={cn(
                      "flex items-center gap-1.5 text-xs sm:text-sm",
                      cond.met ? "text-destructive" : "text-muted-foreground"
                    )}
                  >
                    {cond.met ? (
                      <CircleCheck className="size-3.5 shrink-0" />
                    ) : (
                      <Circle className="size-3.5 shrink-0" />
                    )}
                    <span>{cond.label}</span>
                  </li>
                ))}
              </ul>
            </InfoCard>
          )}

          <InfoCard className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-sm font-bold sm:text-base">
              <Gauge className="size-3.5 shrink-0 text-primary sm:size-4" />
              상점 배율
            </span>
            <div className="flex flex-col">
              <SubRow
                label={formatGoalType(goalType)}
                value={`× ${breakdown.multiplier ?? 1}`}
                labelClassName="text-xs sm:text-sm"
                valueClassName={cn(
                  "font-sans text-xs sm:text-sm",
                  breakdown.multiplierDowngraded && "text-destructive"
                )}
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
