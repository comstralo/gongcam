import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Clock,
  CircleCheck,
  CircleDot,
  CalendarDays,
  Award,
  Timer,
  Wallet,
  BedDouble,
  PiggyBank,
  ListChecks,
  ShieldAlert,
  DoorOpen,
} from "lucide-react";
import { cn, ICON_STROKE } from "@/lib/utils";
import { SummaryTile, SubRow, TintedPill, InfoCard } from "@/components/dashboard/shared";
import { PeriodAlarmCard } from "@/components/dashboard/PeriodAlarmCard";
import type { StatusResponse } from "@/lib/api/types";

const TODAY_INDEX = (new Date().getDay() + 6) % 7; // 월=0 ... 일=6

function won(n: number) {
  return "₩" + (n || 0).toLocaleString();
}

function timeToMinutes(raw: string): number | null {
  const m = (raw || "").trim().match(/^(\d{1,3}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

type GoalStatus = "met" | "failed" | "pending";

function goalStatus(studyTime: string, goalTime: string, complete: boolean): GoalStatus {
  if (!complete) return "pending";
  const study = timeToMinutes(studyTime);
  const goal = timeToMinutes(goalTime);
  if (study === null || goal === null) return "pending";
  return study >= goal ? "met" : "failed";
}

// 시트 원본 값은 "8H (교시제)"처럼 괄호가 붙어 있어 그대로 노출하면 답답해
// 보인다 — 괄호만 제거해 "8H 교시제"로 표시한다.
function formatGoalType(raw: string): string {
  if (!raw) return "-";
  return raw.replace(/[()]/g, "").replace(/\s+/g, " ").trim();
}

// 관리자가 직접 입력하는 값이라 "00:20"처럼 부호 없이 저장되는 경우 기본을 +로 해석하고,
// "-00:20"처럼 이미 부호가 붙어 있으면 그 부호를 그대로 존중한다.
function signedTime(raw: string): string {
  const trimmed = (raw || "").trim();
  if (!trimmed || trimmed === "00:00" || trimmed.startsWith("+") || trimmed.startsWith("-")) {
    return trimmed || "-";
  }
  return `+${trimmed}`;
}

// 실시간 조회(StatusPage)와 지난 주 스냅샷(SnapshotPage) 모두 같은 형태로
// 데이터를 보여줘야 해서, fetch 로직과 표시 로직을 분리해 이 컴포넌트를 공유한다.
export function StatusView({ status }: { status: StatusResponse | null }) {
  const [selectedDay, setSelectedDay] = useState<number>(TODAY_INDEX);

  if (!status) return null;

  const selected = status.days[selectedDay] || status.days[0];
  const effectiveSelectedDay = status.days[selectedDay] ? selectedDay : 0;

  const periodAttendanceValue = parseFloat(status.periodAttendanceRate || "");
  const periodAttendanceClassName = Number.isNaN(periodAttendanceValue)
    ? undefined
    : periodAttendanceValue >= 85
      ? "text-ok"
      : "text-destructive";

  const outputPen = status.weeklyOutputPen || 0;
  const timePen = status.weeklyTimePen || 0;
  const totalPen = outputPen + timePen;
  const totalPenClassName =
    totalPen >= 2 ? "text-destructive" : totalPen === 1 ? "text-amber-600 dark:text-amber-400" : undefined;

  const summaryTiles: {
    key: string;
    icon: LucideIcon;
    label: string;
    value: string;
    wrap?: boolean;
    valueClassName?: string;
  }[] = [
    { key: "goalType", icon: Clock, label: "목표시간", value: formatGoalType(status.goalType) },
    { key: "joinDate", icon: CalendarDays, label: "가입일자", value: status.joinDate || "-" },
    { key: "depositRefund", icon: PiggyBank, label: "예치금 반환 예상액", value: status.depositRefundEstimate || "-" },
    {
      key: "merit",
      icon: Award,
      label: "주간 총 상점",
      value: `${status.weeklyMerit || "0"} · ${status.weeklyMeritRank || "-"}`,
      wrap: true,
    },
    {
      key: "periodAttendance",
      icon: ListChecks,
      label: "교시 참여율",
      value: status.periodAttendanceRate || "-",
      valueClassName: periodAttendanceClassName,
    },
    {
      key: "totalFine",
      icon: ShieldAlert,
      label: "총 페널티",
      value: `송출 P ${outputPen}회 + 주간 P ${timePen}회`,
      wrap: true,
      valueClassName: totalPenClassName,
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-2.5">
        {summaryTiles.map((tile) => (
          <SummaryTile
            key={tile.key}
            icon={tile.icon}
            label={tile.label}
            value={tile.value}
            wrap={tile.wrap}
            valueClassName={tile.valueClassName}
          />
        ))}
      </section>

      <PeriodAlarmCard />

      <InfoCard className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <DoorOpen className="size-4 shrink-0 text-primary sm:size-5" strokeWidth={ICON_STROKE.default} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-semibold sm:text-base">퇴실신청</span>
            <span className="text-xs text-muted-foreground sm:text-sm">
              퇴실/예치금 재납 처리는 운영진에게 문의해주세요
            </span>
          </div>
        </div>
      </InfoCard>

      <section className="flex flex-col gap-2">
        <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
          {status.days.map((d, i) => {
            const isSelected = i === effectiveSelectedDay;
            const isUnpaid = d.paymentStatus === "미납";
            return (
              <button
                key={d.day}
                type="button"
                onClick={() => setSelectedDay(i)}
                className={cn(
                  "relative flex flex-col items-center gap-1 rounded-full border py-2.5 text-sm font-semibold transition-all sm:py-3 sm:text-base",
                  isSelected
                    ? isUnpaid
                      ? "border-destructive bg-destructive text-card shadow-sm"
                      : "border-primary bg-primary text-primary-foreground shadow-sm"
                    : isUnpaid
                      ? "border-destructive/60 bg-destructive/10 text-destructive hover:bg-destructive/15"
                      : "border-border bg-card text-foreground hover:border-primary/50 hover:bg-muted"
                )}
              >
                {i === TODAY_INDEX && !isSelected && !isUnpaid && (
                  <span className="absolute -top-1 size-1.25 rounded-full bg-primary sm:size-1.5" />
                )}
                {isUnpaid && (
                  <span
                    className={cn(
                      "absolute -top-1 size-1.25 rounded-full bg-destructive sm:size-1.5",
                      isSelected && "bg-card"
                    )}
                  />
                )}
                {d.day}
              </button>
            );
          })}
        </div>

        {selected && (
          <div
            className={cn(
              "flex flex-col gap-3 rounded-xl border p-4 sm:gap-3.5 sm:p-5",
              selected.total > 0 ? "border-destructive/30 bg-destructive/5" : "border-ok/30 bg-ok/5"
            )}
          >
            <div className="flex items-center justify-start">
              <TintedPill
                tone={selected.confirmed ? "muted" : "primary"}
                icon={selected.confirmed ? CircleCheck : CircleDot}
              >
                {selected.confirmed ? "확정" : "진행중"}
              </TintedPill>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.25 text-xs font-semibold text-muted-foreground sm:text-sm">
                  <Timer className="size-3.5 sm:size-4" strokeWidth={ICON_STROKE.default} />
                  일간 학습시간
                </span>
                <span
                  className={cn(
                    "font-mono text-sm font-semibold tabular-nums sm:text-base",
                    goalStatus(selected.studyTime, selected.dailyGoalTime, selected.complete) === "met" && "text-ok",
                    goalStatus(selected.studyTime, selected.dailyGoalTime, selected.complete) === "failed" &&
                      "text-destructive"
                  )}
                >
                  {selected.studyTime || "-"}
                  {selected.dailyGoalTime && <span className="text-muted-foreground"> / {selected.dailyGoalTime}</span>}
                </span>
              </div>
              <SubRow label="보정 학습시간" value={signedTime(selected.bonusStudyTime)} />
            </div>

            <div className="h-px w-full bg-border" />

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.25 text-xs font-semibold text-muted-foreground sm:text-sm">
                  <BedDouble className="size-3.5 sm:size-4" strokeWidth={ICON_STROKE.default} />
                  반휴 사용
                </span>
              </div>
              <SubRow
                label="일반반휴"
                value={selected.normalLeaveUsed > 0 ? `${selected.normalLeaveUsed}회` : "-"}
              />
              <SubRow
                label="사유반휴"
                value={selected.reasonLeaveUsed > 0 ? `${selected.reasonLeaveUsed}회` : "-"}
              />
            </div>

            <div className="h-px w-full bg-border" />

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.25 text-xs font-semibold text-muted-foreground sm:text-sm">
                  <Wallet className="size-3.5 sm:size-4" strokeWidth={ICON_STROKE.default} />
                  일간 총 벌금
                  {!selected.complete && (
                    <span className="rounded-full bg-muted-foreground/10 px-1.5 py-0.5 text-micro font-medium normal-case text-muted-foreground sm:text-micro-lg">
                      집계 중
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    "font-mono text-base font-semibold tabular-nums sm:text-lg",
                    selected.total > 0 ? "text-destructive" : "text-ok"
                  )}
                >
                  {won(selected.total)}
                </span>
              </div>
              <SubRow label="일간 목표시간 벌금" value={won(selected.goal)} />
              <SubRow label="오전 목표시간 벌금" value={won(selected.morning)} />
              <SubRow
                label="납부확인"
                value={selected.paymentStatus || "-"}
                valueClassName={cn(
                  "font-sans text-xs font-semibold normal-case sm:text-sm",
                  selected.paymentStatus === "미납" && "text-destructive"
                )}
              />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
