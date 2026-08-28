import { useEffect, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Clock, Timer, CalendarDays, Award, ListChecks, ShieldAlert, CircleDollarSign, CircleCheck } from "lucide-react";
import { cn, ICON_STROKE } from "@/lib/utils";
import { SummaryTile, DividedValue, DayDetailCard, formatTotalPenalty } from "@/components/dashboard/shared";
import { formatRankInline } from "@/components/dashboard/RosterView";
import { MeritBreakdownDialog } from "@/components/dashboard/MeritBreakdownDialog";
import { GoalTypeScheduleDialog } from "@/components/dashboard/GoalTypeScheduleDialog";
import { PeriodAttendanceDialog } from "@/components/dashboard/PeriodAttendanceDialog";
import { TotalPenaltyDialog } from "@/components/dashboard/TotalPenaltyDialog";
import { StudyTimeDialog } from "@/components/dashboard/StudyTimeDialog";
import { HalfDayLeaveDialog } from "@/components/dashboard/HalfDayLeaveDialog";
import { useAuth } from "@/lib/auth/useAuth";
import type { StatusResponse } from "@/lib/api/types";

const TODAY_INDEX = (new Date().getDay() + 6) % 7; // 월=0 ... 일=6
const STATUS_DAYS = ["월", "화", "수", "목", "금", "토", "일"];

// 시트 원본 값은 "8H (교시제)"처럼 괄호가 붙어 있어 그대로 노출하면 답답해
// 보인다 — 괄호만 제거해 "8H 교시제"로 표시한다.
function formatGoalType(raw: string): string {
  if (!raw) return "-";
  return raw.replace(/[()]/g, "").replace(/\s+/g, " ").trim();
}

// "HH:MM"을 분으로 변환한다. 파싱 실패 시 0.
function timeToMinutesOrZero(raw: string): number {
  const m = (raw || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// 서버가 "H:MM"/"HH:MM"으로 내려주는 시간 값을 항상 2자리 "HH:MM" 형태로 맞춘다.
function formatHM(raw: string): string {
  const totalMinutes = timeToMinutesOrZero(raw);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

// 실시간 조회(StatusPage)와 지난 주 스냅샷(SnapshotPage) 모두 같은 형태로
// 데이터를 보여줘야 해서, fetch 로직과 표시 로직을 분리해 이 컴포넌트를 공유한다.
// allowGoalSchedule: 목표시간 예약은 로그인한 본인 계정에만 적용되므로, 관리자가
// 다른 회원을 조회 중이거나 지난 주 기록을 볼 때는 반드시 false로 꺼야 한다.
export function StatusView({
  status,
  allowGoalSchedule = false,
  // 과거 사이클(완결된 지난 주) 조회 중인지 — true면 그 주의 모든 요일이 이미
  // 지났으므로, 오늘 요일 기준 "미래라 선택 불가" 판정을 걸지 않는다.
  isViewingCycle = false,
  onLeaveApplied,
  onReasonLeaveSubmitted,
}: {
  status: StatusResponse | null;
  allowGoalSchedule?: boolean;
  isViewingCycle?: boolean;
  // 일반반휴 신청·취소가 반영됐을 때 부모(StatusPage)에 알려, 그 요일의
  // normalLeaveUsed를 새로고침 없이 즉시 갱신하게 한다.
  onLeaveApplied?: (day: string, type: "normal" | "reason", delta: number) => void;
  // 사유반휴 신청이 접수됐을 때(승인 전까지는 카운트가 바뀌지 않으므로) 부모가
  // 상태를 재조회해 "관리자 확인 중" 배지가 반영되게 한다.
  onReasonLeaveSubmitted?: () => void;
}) {
  const { session } = useAuth();
  // 과거 사이클은 오늘 요일과 무관하게 마지막 요일(일)을 기본으로 보여준다 —
  // 실시간 조회는 지금까지처럼 오늘 요일을 기본 선택한다.
  const [selectedDay, setSelectedDay] = useState<number>(isViewingCycle ? 6 : TODAY_INDEX);
  // 🔧 [미래 요일 잔존 버그 수정] StatusPage/DashboardPage가 페이지 전환에도
  // 언마운트되지 않는 구조라, 위 useState 초기값은 최초 마운트 1회만
  // 적용된다 — 과거 사이클에서 일요일(6)을 본 뒤 "현재"로 돌아와도
  // selectedDay가 6에 그대로 남아, 아직 오지 않은 요일이 선택된 채 표시되는
  // 문제가 있었다. isViewingCycle이 바뀔 때마다 그 상황에 맞는 기본값으로
  // 다시 맞춘다.
  useEffect(() => {
    setSelectedDay(isViewingCycle ? 6 : TODAY_INDEX);
  }, [isViewingCycle]);

  if (!status) return null;

  const split = status.depositAgainSplit;
  // 재납이 발생한 주는 요일별 카드를 재납 전(백업 탭)/후(현재 탭) 병합본으로
  // 보여줘야 하므로, split이 있으면 days 배열 자체를 병합본으로 교체한다.
  const days = split ? split.days : status.days;
  const boundaryIndex = split ? STATUS_DAYS.indexOf(split.boundaryDay) : -1;

  const selected = days[selectedDay] || days[0];
  const effectiveSelectedDay = days[selectedDay] ? selectedDay : 0;
  // 선택된 요일이 재납 전 구간(경계 요일 포함)에 속하면, 상단 요약 타일도
  // 그 시점의 백업 탭 스냅샷 기준으로 통째로 바꿔 보여준다.
  const viewingBeforeSplit = split !== null && split !== undefined && effectiveSelectedDay <= boundaryIndex;
  const summarySource = viewingBeforeSplit && split ? split.before : status;

  const periodAttendanceValue = parseFloat(summarySource.periodAttendanceRate || "");
  const periodAttendanceLow = Number.isNaN(periodAttendanceValue) ? false : periodAttendanceValue < 85;

  // 백업 스냅샷에는 페널티 이력(다른 시트 참조)이 없어 항상 0/em-dash로 둔다 —
  // 재납 자체가 페널티 누적으로 발동하는 것이라 "재납 전 페널티"라는 개념이
  // 이 시점 요약과는 맞지 않기도 하다.
  const outputPen = viewingBeforeSplit ? 0 : status.weeklyOutputPen || 0;
  const timePen = viewingBeforeSplit ? 0 : status.weeklyTimePen || 0;
  const totalPen = outputPen + timePen;
  const totalPenClassName =
    totalPen >= 2 ? "text-destructive" : totalPen === 1 ? "text-amber-600 dark:text-amber-400" : undefined;

  const studyTimeShort =
    timeToMinutesOrZero(summarySource.weeklyStudyTime) < timeToMinutesOrZero(summarySource.weeklyGoalTime);

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
      value: formatGoalType(summarySource.goalType),
      clickable: !viewingBeforeSplit && allowGoalSchedule ? "edit" : undefined,
    },
    { key: "joinDate", icon: CalendarDays, label: "가입일자 (첫 참여일 기준)", value: summarySource.joinDate || "-" },
    {
      key: "totalFine",
      icon: ShieldAlert,
      label: "총 페널티",
      value: viewingBeforeSplit ? "-" : formatTotalPenalty(outputPen, timePen),
      wrap: true,
      valueClassName: totalPenClassName,
      clickable: viewingBeforeSplit ? undefined : "view",
    },
    {
      key: "merit",
      icon: Award,
      label: "주간 총 상점",
      value: (
        <DividedValue
          items={[
            <span
              key="value"
              className={parseFloat(summarySource.weeklyMerit || "0") !== 0 ? "text-ok" : undefined}
            >
              +{summarySource.weeklyMerit || "0"}점
            </span>,
            <span key="rank" className="text-foreground">
              {viewingBeforeSplit
                ? "-"
                : status.weeklyMeritBreakdown?.isZero
                  ? "제외"
                  : formatRankInline(status.weeklyMeritRank || "-")}
            </span>,
          ]}
        />
      ),
      wrap: true,
      clickable: viewingBeforeSplit ? undefined : "view",
    },
    {
      key: "studyTime",
      icon: Timer,
      label: "주간 학습시간",
      // 재납 전 스냅샷은 완결된 요일 수가 5일보다 적을 수 있는데, 목표시간
      // 계산(weeklyGoalTime)은 항상 "5일 기준"으로만 나와 목표 대비 미달률이
      // 실제보다 심하게 왜곡돼 보인다 — 목표 비교 없이 실적치만 보여준다.
      value: viewingBeforeSplit ? (
        formatHM(summarySource.weeklyStudyTime)
      ) : (
        <DividedValue
          items={[
            <span key="value" className={studyTimeShort ? "text-destructive" : undefined}>
              {formatHM(summarySource.weeklyStudyTime)}
            </span>,
            <span key="goal" className="text-muted-foreground">
              {formatHM(summarySource.weeklyGoalTime)}
            </span>,
          ]}
        />
      ),
      wrap: true,
      clickable: viewingBeforeSplit ? undefined : "view",
    },
    {
      key: "periodAttendance",
      icon: ListChecks,
      label: "주간 교시 참여율",
      value: summarySource.periodAttendanceBreakdown?.applicable ? (
        <DividedValue
          items={[
            <span key="value" className={periodAttendanceLow ? "text-destructive" : undefined}>
              {summarySource.periodAttendanceRate || "-"}
            </span>,
            <span key="goal" className="text-muted-foreground">
              85%
            </span>,
          ]}
        />
      ) : (
        "-"
      ),
      wrap: true,
      clickable: viewingBeforeSplit ? undefined : "view",
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <section className="relative grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-2.5">
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
          // 재납 이전 스냅샷 보기 중에는 순위/제보점수/페널티 이력처럼 다른
          // 시트를 참조해야 하는 세부 다이얼로그를 열 근거 데이터가 없거나,
          // 목표시간 대비 비교가 5일 기준으로 왜곡되는 값(학습시간/교시참여율)
          // 이라 타일만 보여주고 클릭 동작은 비활성화한다.
          if (
            viewingBeforeSplit &&
            (tile.key === "merit" ||
              tile.key === "goalType" ||
              tile.key === "totalFine" ||
              tile.key === "studyTime" ||
              tile.key === "periodAttendance")
          ) {
            return <div key={tile.key}>{tileEl}</div>;
          }
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
          if (tile.key === "studyTime") {
            return (
              <StudyTimeDialog
                key={tile.key}
                weeklyStudyTime={formatHM(summarySource.weeklyStudyTime)}
                goalType={summarySource.goalType}
                periodGrid={summarySource.periodGrid || []}
                days={days}
              >
                {tileEl}
              </StudyTimeDialog>
            );
          }
          if (tile.key === "periodAttendance" && summarySource.periodAttendanceBreakdown) {
            return (
              <PeriodAttendanceDialog
                key={tile.key}
                periodAttendanceRate={summarySource.periodAttendanceRate || "-"}
                breakdown={summarySource.periodAttendanceBreakdown}
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
                token={session?.token}
              >
                {tileEl}
              </TotalPenaltyDialog>
            );
          }
          return <div key={tile.key}>{tileEl}</div>;
        })}

        {viewingBeforeSplit && (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-background/35 backdrop-blur-[1px]">
            <span className="rounded-full border bg-card px-3.5 py-1.5 text-xs font-semibold text-muted-foreground shadow-sm sm:text-sm">
              예치금 재납 이전 데이터입니다.
            </span>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        {split && (
          <div className="grid grid-cols-7 gap-1.5 text-center text-micro-lg text-muted-foreground sm:gap-2 sm:text-xs">
            <div style={{ gridColumn: `span ${boundaryIndex + 1} / span ${boundaryIndex + 1}` }}>
              <div className="border-b pb-1">예치금 재납 전</div>
            </div>
            <div style={{ gridColumn: `span ${7 - boundaryIndex - 1} / span ${7 - boundaryIndex - 1}` }}>
              <div className="border-b pb-1">예치금 재납 후</div>
            </div>
          </div>
        )}
        <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
          {days.map((d, i) => {
            const isSelected = i === effectiveSelectedDay;
            const isUnpaid =
              d.paymentStatus === "미납" ||
              (d.isDepositAgainDay && status.depositRefundBreakdown?.depositAgainStatus === "미납");
            const isPaid =
              !isUnpaid &&
              (d.paymentStatus === "납부" ||
                (d.isDepositAgainDay && status.depositRefundBreakdown?.depositAgainStatus === "납부"));
            const isFuture = !isViewingCycle && i > TODAY_INDEX;
            // 🔧 [가입일 이전 요일 비활성화] 가입 전이라 참여 자체가 불가능했던
            // 요일은 데이터가 항상 비어있어 "진행 전/기록 없음"이 미래 요일과
            // 똑같이 뜬다 — 실제로 지난 날인데 "아직 안 지났다"로 오해할 수
            // 있어, 아예 선택 불가로 표시한다. 두 값이 다 "YYYY-MM-DD" 문자열
            // 이라 사전식 비교가 곧 날짜 비교와 같다.
            const isBeforeJoin = !!(d.date && status.joinDateExact && d.date < status.joinDateExact);
            const isDisabled = isFuture || isBeforeJoin;
            return (
              <button
                key={d.day}
                type="button"
                onClick={() => setSelectedDay(i)}
                disabled={isDisabled}
                className={cn(
                  "relative flex flex-col items-center gap-1 rounded-full border py-2 text-xs font-semibold transition-all sm:py-2.5 sm:text-sm",
                  isDisabled
                    ? "cursor-not-allowed border-border bg-muted/50 text-muted-foreground/50"
                    : isSelected
                      ? isUnpaid
                        ? "animate-unpaid-glow border-destructive bg-destructive text-card shadow-sm"
                        : "border-primary bg-primary text-primary-foreground shadow-sm"
                      : isUnpaid
                        ? "animate-unpaid-glow border-destructive/60 bg-destructive/10 text-destructive hover:bg-destructive/15"
                        : "border-border bg-card text-foreground hover:border-primary/50 hover:bg-muted"
                )}
              >
                {isUnpaid ? (
                  <CircleDollarSign
                    className={cn(
                      "absolute -top-1.5 size-3 animate-pulse rounded-full sm:-top-2 sm:size-3.5",
                      isSelected ? "bg-destructive text-card" : "bg-card text-destructive"
                    )}
                    strokeWidth={ICON_STROKE.default}
                  />
                ) : isPaid ? (
                  <CircleDollarSign
                    className={cn(
                      "absolute -top-1.5 size-3 rounded-full sm:-top-2 sm:size-3.5",
                      isSelected ? "bg-ok text-card" : "bg-card text-ok"
                    )}
                    strokeWidth={ICON_STROKE.default}
                  />
                ) : (
                  !isViewingCycle && i === TODAY_INDEX && (
                    <CircleCheck
                      className={cn(
                        "absolute -top-1.5 size-3 rounded-full sm:-top-2 sm:size-3.5",
                        isSelected ? "bg-primary text-card" : "bg-card text-primary"
                      )}
                      strokeWidth={ICON_STROKE.default}
                    />
                  )
                )}
                {d.day}
              </button>
            );
          })}
        </div>

        {selected && (
          <DayDetailCard
            day={selected}
            isPast={isViewingCycle || effectiveSelectedDay < TODAY_INDEX}
            depositRefundBreakdown={status.depositRefundBreakdown}
            footer={
              allowGoalSchedule ? (
                <HalfDayLeaveDialog
                  day={selected.day}
                  usedToday={selected.normalLeaveUsed + selected.reasonLeaveUsed}
                  reasonLeaveUsed={selected.reasonLeaveUsed}
                  normalLeaveLeft={status.normalLeaveLeft}
                  reasonLeaveLeft={status.reasonLeaveLeft}
                  onNormalApplied={(delta) => onLeaveApplied?.(selected.day, "normal", delta)}
                  onReasonLeaveApplied={(delta) => onLeaveApplied?.(selected.day, "reason", delta)}
                  onReasonLeaveSubmitted={onReasonLeaveSubmitted}
                  onOpen={onReasonLeaveSubmitted}
                />
              ) : undefined
            }
          />
        )}
      </section>
    </div>
  );
}
