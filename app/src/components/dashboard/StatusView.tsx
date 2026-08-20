import { useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Clock,
  Timer,
  CalendarDays,
  Award,
  PiggyBank,
  ListChecks,
  ShieldAlert,
  BedDouble,
  DoorOpen,
  MessageCircle,
  FileText,
  Table,
  Megaphone,
} from "lucide-react";
import { cn, ICON_STROKE } from "@/lib/utils";
import {
  SummaryTile,
  InfoCard,
  DividedValue,
  DayDetailCard,
  ItemTitle,
  formatTotalPenalty,
} from "@/components/dashboard/shared";
import { PeriodAlarmCard } from "@/components/dashboard/PeriodAlarmCard";
import { MeritBreakdownDialog } from "@/components/dashboard/MeritBreakdownDialog";
import { GoalTypeScheduleDialog } from "@/components/dashboard/GoalTypeScheduleDialog";
import { DepositRefundDialog } from "@/components/dashboard/DepositRefundDialog";
import { PeriodAttendanceDialog } from "@/components/dashboard/PeriodAttendanceDialog";
import { TotalPenaltyDialog } from "@/components/dashboard/TotalPenaltyDialog";
import { StudyTimeDialog } from "@/components/dashboard/StudyTimeDialog";
import { LeaveApplyButton } from "@/components/dashboard/LeaveApplyButton";
import type { StatusResponse } from "@/lib/api/types";

const TODAY_INDEX = (new Date().getDay() + 6) % 7; // 월=0 ... 일=6

// 스터디 바로가기 — 링크 값은 추후 실제 URL로 교체 예정.
const quickLinks: { key: string; icon: LucideIcon; label: string; href: string }[] = [
  { key: "chat", icon: MessageCircle, label: "단체 채팅방", href: "#" },
  { key: "rules", icon: FileText, label: "스터디 규정", href: "#" },
  { key: "sheet", icon: Table, label: "원본 시트", href: "#" },
  { key: "notice", icon: Megaphone, label: "공지사항", href: "#" },
];

// 시트 원본 값은 "8H (교시제)"처럼 괄호가 붙어 있어 그대로 노출하면 답답해
// 보인다 — 괄호만 제거해 "8H 교시제"로 표시한다.
function formatGoalType(raw: string): string {
  if (!raw) return "-";
  return raw.replace(/[()]/g, "").replace(/\s+/g, " ").trim();
}

// 시트 원본 값("₩10,000 (송출 P 0회 / 주간 P 0회)")에서 감액 사유 괄호를
// 떼어낸다 — 사유는 이제 별도 모달에서 보여주므로 타일에는 금액만 노출한다.
function formatDepositRefund(raw: string): string {
  if (!raw) return "-";
  return raw.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

// "HH:MM"을 분으로 변환한다. 파싱 실패 시 0.
function timeToMinutesOrZero(raw: string): number {
  const m = (raw || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// 서버가 "HH:MM"으로 내려주는 시간 값을 "NH NM" 형태로 바꾼다.
function formatHM(raw: string): string {
  const totalMinutes = timeToMinutesOrZero(raw);
  return `${Math.floor(totalMinutes / 60)}H ${totalMinutes % 60}M`;
}

// 괄호 안 "0회" 등의 숫자가 섞여 들어오지 않도록, formatDepositRefund와 동일하게
// 괄호를 먼저 떼어낸 뒤 남은 숫자만 파싱한다.
function parseDepositRefundAmount(raw: string): number {
  return parseInt(formatDepositRefund(raw).replace(/[^\d]/g, ""), 10) || 0;
}

// 실시간 조회(StatusPage)와 지난 주 스냅샷(SnapshotPage) 모두 같은 형태로
// 데이터를 보여줘야 해서, fetch 로직과 표시 로직을 분리해 이 컴포넌트를 공유한다.
// allowGoalSchedule: 목표시간 예약은 로그인한 본인 계정에만 적용되므로, 관리자가
// 다른 회원을 조회 중이거나 지난 주 기록을 볼 때는 반드시 false로 꺼야 한다.
export function StatusView({
  status,
  allowGoalSchedule = false,
}: {
  status: StatusResponse | null;
  allowGoalSchedule?: boolean;
}) {
  const [selectedDay, setSelectedDay] = useState<number>(TODAY_INDEX);

  if (!status) return null;

  const selected = status.days[selectedDay] || status.days[0];
  const effectiveSelectedDay = status.days[selectedDay] ? selectedDay : 0;

  const periodAttendanceValue = parseFloat(status.periodAttendanceRate || "");
  const periodAttendanceLow = Number.isNaN(periodAttendanceValue) ? false : periodAttendanceValue < 80;

  const outputPen = status.weeklyOutputPen || 0;
  const timePen = status.weeklyTimePen || 0;
  const totalPen = outputPen + timePen;
  const totalPenClassName =
    totalPen >= 2 ? "text-destructive" : totalPen === 1 ? "text-amber-600 dark:text-amber-400" : undefined;

  const depositRefundAmount = parseDepositRefundAmount(status.depositRefundEstimate);
  const depositRefundClassName = depositRefundAmount >= 10000 ? "text-ok" : "text-destructive";

  const studyTimeShort =
    timeToMinutesOrZero(status.weeklyStudyTime) < timeToMinutesOrZero(status.weeklyGoalTime);

  const summaryTiles: {
    key: string;
    icon: LucideIcon;
    label: string;
    value: ReactNode;
    wrap?: boolean;
    valueClassName?: string;
    hint?: string;
    clickable?: "edit" | "view";
  }[] = [
    {
      key: "goalType",
      icon: Clock,
      label: "목표시간",
      value: formatGoalType(status.goalType),
      clickable: allowGoalSchedule ? "edit" : undefined,
    },
    { key: "joinDate", icon: CalendarDays, label: "가입일자 (첫 참여일 기준)", value: status.joinDate || "-" },
    {
      key: "depositRefund",
      icon: PiggyBank,
      label: "예치금 반환 예상액",
      value: formatDepositRefund(status.depositRefundEstimate),
      valueClassName: depositRefundClassName,
      clickable: "view",
    },
    {
      key: "merit",
      icon: Award,
      label: "주간 총 상점",
      value: (
        <DividedValue
          items={[
            `+${status.weeklyMerit || "0"}`,
            status.weeklyMeritBreakdown?.isZero ? "제외" : status.weeklyMeritRank || "-",
          ]}
        />
      ),
      wrap: true,
      clickable: "view",
    },
    {
      key: "studyTime",
      icon: Timer,
      label: "주간 학습시간",
      value: (
        <DividedValue
          items={[
            <span key="value" className={studyTimeShort ? "text-destructive" : undefined}>
              {formatHM(status.weeklyStudyTime)}
            </span>,
            <span key="goal" className="text-ok">
              {formatHM(status.weeklyGoalTime)}
            </span>,
          ]}
        />
      ),
      wrap: true,
      clickable: "view",
    },
    {
      key: "periodAttendance",
      icon: ListChecks,
      label: "주간 교시 참여율",
      value: status.periodAttendanceBreakdown?.applicable ? (
        <DividedValue
          items={[
            <span key="value" className={periodAttendanceLow ? "text-destructive" : undefined}>
              {status.periodAttendanceRate || "-"}
            </span>,
            <span key="goal" className="text-ok">
              80%
            </span>,
          ]}
        />
      ) : (
        "-"
      ),
      wrap: true,
      clickable: "view",
    },
    {
      key: "totalFine",
      icon: ShieldAlert,
      label: "총 페널티",
      value:
        totalPen >= 2 ? (
          <span className="flex flex-col">
            <span>{formatTotalPenalty(outputPen, timePen)}</span>
            <span className="text-micro sm:text-micro-lg">* 예치금 재납 대상</span>
          </span>
        ) : (
          formatTotalPenalty(outputPen, timePen)
        ),
      wrap: true,
      valueClassName: totalPenClassName,
      clickable: "view",
    },
    {
      key: "leaveLeft",
      icon: BedDouble,
      label: "반휴권 잔여량",
      value: (
        <DividedValue
          items={[`일반 ${status.normalLeaveLeft || "0"}회`, `사유 ${status.reasonLeaveLeft || "0"}회`]}
        />
      ),
      wrap: true,
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-2.5">
        {summaryTiles.map((tile) => {
          const tileEl = (
            <SummaryTile
              icon={tile.icon}
              label={tile.label}
              value={tile.value}
              wrap={tile.wrap}
              valueClassName={tile.valueClassName}
              hint={tile.hint}
              clickable={tile.clickable}
            />
          );
          if (tile.key === "merit" && status.weeklyMeritBreakdown) {
            return (
              <MeritBreakdownDialog
                key={tile.key}
                weeklyMerit={status.weeklyMerit || "0"}
                weeklyMeritRank={status.weeklyMeritRank || "-"}
                goalType={status.goalType}
                breakdown={status.weeklyMeritBreakdown}
              >
                {tileEl}
              </MeritBreakdownDialog>
            );
          }
          if (tile.key === "goalType" && allowGoalSchedule) {
            return (
              <GoalTypeScheduleDialog key={tile.key}>
                {tileEl}
              </GoalTypeScheduleDialog>
            );
          }
          if (tile.key === "depositRefund" && status.depositRefundBreakdown) {
            return (
              <DepositRefundDialog
                key={tile.key}
                depositRefundEstimate={status.depositRefundEstimate}
                breakdown={status.depositRefundBreakdown}
              >
                {tileEl}
              </DepositRefundDialog>
            );
          }
          if (tile.key === "studyTime") {
            return (
              <StudyTimeDialog
                key={tile.key}
                weeklyStudyTime={formatHM(status.weeklyStudyTime)}
                goalType={status.goalType}
                periodGrid={status.periodGrid || []}
                days={status.days}
              >
                {tileEl}
              </StudyTimeDialog>
            );
          }
          if (tile.key === "periodAttendance" && status.periodAttendanceBreakdown) {
            return (
              <PeriodAttendanceDialog
                key={tile.key}
                periodAttendanceRate={status.periodAttendanceRate || "-"}
                breakdown={status.periodAttendanceBreakdown}
              >
                {tileEl}
              </PeriodAttendanceDialog>
            );
          }
          if (tile.key === "totalFine" && status.totalPenaltyBreakdown) {
            return (
              <TotalPenaltyDialog
                key={tile.key}
                outputPen={outputPen}
                timePen={timePen}
                breakdown={status.totalPenaltyBreakdown}
              >
                {tileEl}
              </TotalPenaltyDialog>
            );
          }
          return <div key={tile.key}>{tileEl}</div>;
        })}
      </section>

      <section className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-2.5">
        <PeriodAlarmCard />

        <InfoCard className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <DoorOpen className="size-4 shrink-0 text-primary sm:size-5" strokeWidth={ICON_STROKE.default} />
            <div className="flex min-w-0 flex-col gap-0.5">
              <ItemTitle>퇴실신청</ItemTitle>
              <span className="truncate text-xs text-muted-foreground sm:text-sm">
                운영진에게 문의해주세요
              </span>
            </div>
          </div>
        </InfoCard>
      </section>

      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-2.5">
        {quickLinks.map((link) => (
          <a
            key={link.key}
            href={link.href}
            target="_blank"
            rel="noreferrer"
            className="flex flex-col items-center gap-1.5 rounded-xl border bg-muted px-3 py-3 text-center shadow-xs transition-colors hover:bg-accent sm:py-3.5"
          >
            <link.icon className="size-4 shrink-0 text-primary sm:size-5" strokeWidth={ICON_STROKE.default} />
            <span className="truncate text-xs font-semibold sm:text-sm">{link.label}</span>
          </a>
        ))}
      </section>

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
                  "relative flex flex-col items-center gap-1 rounded-full border py-2 text-xs font-semibold transition-all sm:py-2.5 sm:text-sm",
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
          <DayDetailCard
            day={selected}
            isPast={effectiveSelectedDay < TODAY_INDEX}
            footer={
              allowGoalSchedule ? (
                <div className="grid grid-cols-2 gap-2">
                  <LeaveApplyButton type="normal" day={selected.day} label="일반반휴" />
                  <LeaveApplyButton type="reason" day={selected.day} label="사유반휴" />
                </div>
              ) : undefined
            }
          />
        )}
      </section>
    </div>
  );
}
