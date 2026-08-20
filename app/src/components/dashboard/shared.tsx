import type { ReactNode } from "react";
import { Search, SquarePen, CircleCheck, CircleDot, Timer, BedDouble, Wallet, type LucideIcon } from "lucide-react";
import { cn, ICON_STROKE } from "@/lib/utils";
import type { StatusDay } from "@/lib/api/types";

// 카드 안에서 가장 두드러지는 1차 텍스트(예: "퇴실신청" 같은 카드 제목).
// 섹션/탭 제목(font-bold)보다 한 단계 낮은 굵기(semibold)로 위계를 분리한다.
export function ItemTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-sm font-semibold sm:text-base", className)}>{children}</span>;
}

type PillTone = "ok" | "warn" | "muted" | "primary";

const PILL_TONE_CLASSES: Record<PillTone, string> = {
  ok: "bg-ok/15 text-ok",
  warn: "bg-destructive/15 text-destructive",
  muted: "bg-foreground/8 text-muted-foreground",
  primary: "bg-primary/15 text-primary",
};

// 대시보드 전반(내 대시보드/전체 대시보드/지난 기록)에서 반복되는 "틴트된 상태 배지".
export function TintedPill({
  tone,
  icon: Icon,
  children,
  className,
}: {
  tone: PillTone;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-micro-lg font-semibold sm:text-xs",
        PILL_TONE_CLASSES[tone],
        className
      )}
    >
      {Icon && <Icon className="size-3 sm:size-3.5" strokeWidth={ICON_STROKE.emphasis} />}
      {children}
    </span>
  );
}

// 아이콘 + 라벨 + 값을 담는 요약 타일 (StatusView 상단 그리드).
// wrap: 순위 사유("- (사유 반휴 3장 이상 사용)")처럼 값이 길어질 수 있는
// 타일만 줄바꿈을 허용한다 — 기본은 다른 타일과 맞춰 한 줄 자르기.
// valueClassName: 페널티 합계처럼 값 자체의 색상을 상태에 따라 바꿔야 할 때 사용.
// hint: 라벨을 길게 늘이지 않고 값 옆에 부연 설명("예치금 납부일 기준")을 덧붙일 때 사용.
// clickable: 타일이 모달을 여는 버튼으로 감싸져 있을 때, 우측 상단에 작은 아이콘을
// 얹어 클릭 가능하다는 것을 시각적으로 드러낸다. "edit"는 값을 바꿀 수 있는 타일
// (목표시간 예약), "view"는 조회 전용 세부사항 모달(예치금 반환/상점/페널티 등)에 사용.
export function SummaryTile({
  icon: Icon,
  label,
  value,
  wrap,
  valueClassName,
  hint,
  clickable,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  wrap?: boolean;
  valueClassName?: string;
  hint?: string;
  clickable?: "edit" | "view";
}) {
  const ClickIcon = clickable === "edit" ? SquarePen : Search;
  return (
    <div className="relative flex flex-col gap-1 rounded-xl border bg-muted px-3.5 py-2.5 shadow-xs sm:px-4 sm:py-3">
      {clickable && (
        <ClickIcon
          className="absolute top-2 right-2 size-2.5 text-muted-foreground/50 sm:size-3"
          strokeWidth={ICON_STROKE.default}
        />
      )}
      <div className="flex items-center gap-1.25 text-muted-foreground">
        <Icon className="size-3 shrink-0 sm:size-3.5" strokeWidth={ICON_STROKE.default} />
        <span className="truncate text-micro font-semibold tracking-wide uppercase sm:text-micro-lg">{label}</span>
      </div>
      <span
        className={cn(
          "text-xs font-semibold sm:text-sm",
          wrap ? "break-keep" : "truncate",
          valueClassName
        )}
      >
        {value}
      </span>
      {hint && <span className="truncate text-micro text-muted-foreground/70">{hint}</span>}
    </div>
  );
}

// 총합 0이면 "-", 1이면 "송출 P 1회" 처럼 0이 아닌 쪽만, 2 이상이면 두 값을
// "+"로 조합해 표시한다(총합은 최대 2까지만 나올 수 있는 값이다). 대시보드
// 타일과 페널티 모달이 동일한 문구를 써야 해서 공용 헬퍼로 둔다.
export function formatTotalPenalty(outputPen: number, timePen: number): string {
  const parts: string[] = [];
  if (outputPen > 0) parts.push(`송출 P ${outputPen}회`);
  if (timePen > 0) parts.push(`주간 P ${timePen}회`);
  return parts.length > 0 ? parts.join(" + ") : "-";
}

// 텍스트 구분자("|") 대신 은은한 세로선으로 두 값을 나눠 보여준다.
// 예: 주간 총 상점(수치) │ 순위.
export function DividedValue({ items }: { items: ReactNode[] }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {items.map((item, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {i > 0 && <span className="h-3 w-px bg-border" aria-hidden="true" />}
          {item}
        </span>
      ))}
    </span>
  );
}

// "└" 접두 트리 표기로 상위 행 아래 들여쓰기된 세부 항목을 표시하는 서브로우.
// indent: 상위 행 없이 박스 안에 항목만 나열할 때는 false로 꺼서 불필요한
// 좌측 여백/트리 기호 없이 일반 목록처럼 보이게 한다.
export function SubRow({
  label,
  value,
  valueClassName,
  indent = true,
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string;
  indent?: boolean;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-2", indent && "pl-5 sm:pl-5.5")}>
      <span
        className={cn(
          "text-micro-lg text-muted-foreground sm:text-xs",
          indent && "before:mr-1 before:content-['└']"
        )}
      >
        {label}
      </span>
      <span className={cn("font-mono text-micro-lg tabular-nums text-muted-foreground sm:text-xs", valueClassName)}>
        {value}
      </span>
    </div>
  );
}

// 세션 카드/알림 설정 등 여러 페이지에서 반복되는 옅은 배경의 정보 카드.
export function InfoCard({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("rounded-lg border bg-muted p-3.5 shadow-xs sm:p-4.5", className)} {...props}>
      {children}
    </div>
  );
}

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

// 관리자가 직접 입력하는 값이라 "00:20"처럼 부호 없이 저장되는 경우 기본을 +로 해석하고,
// "-00:20"처럼 이미 부호가 붙어 있으면 그 부호를 그대로 존중한다.
function signedTime(raw: string): string {
  const trimmed = (raw || "").trim();
  if (!trimmed || trimmed === "00:00" || trimmed.startsWith("+") || trimmed.startsWith("-")) {
    return trimmed || "-";
  }
  return `+${trimmed}`;
}

// 내 대시보드(StatusView)의 요일 상세 카드 — 관리자가 벌금 미납 현황에서
// 특정 인원/요일을 펼쳐볼 때도 동일한 형태로 재사용한다.
// dayLabel: MY 대시보드는 요일 선택 버튼이 이미 있어 생략하지만, 관리자 화면처럼
// 별도 요일 선택 UI 없이 이 카드만 보여줄 때는 어느 요일인지 표시해줘야 한다.
// isPast: 기록시점(23:3x) 유무와 무관하게, 오늘보다 이전 요일이면 무조건
// "마감"으로 표시한다 — 봇이 그날 마지막 기록을 못 남긴 경우에도 이미
// 지난 요일을 "진행중"으로 오인 표시하지 않기 위함.
export function DayDetailCard({
  day,
  dayLabel,
  isPast = false,
}: {
  day: StatusDay;
  dayLabel?: string;
  isPast?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card p-4 sm:gap-3.5 sm:p-5",
        day.total > 0 ? "border-destructive/30" : "border-border"
      )}
    >
      <div className="flex items-center justify-start gap-1.5">
        {dayLabel && <TintedPill tone="warn">{dayLabel}</TintedPill>}
        <TintedPill
          tone={day.confirmed || isPast ? "muted" : "primary"}
          icon={day.confirmed || isPast ? CircleCheck : CircleDot}
        >
          {day.confirmed ? "확정" : isPast ? "마감" : "진행중"}
        </TintedPill>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
            <Timer className="size-3.5 sm:size-4" strokeWidth={ICON_STROKE.default} />
            일간 학습시간
          </span>
          <span
            className={cn(
              "text-xs font-semibold sm:text-sm",
              goalStatus(day.studyTime, day.dailyGoalTime, day.complete) === "met" && "text-ok",
              goalStatus(day.studyTime, day.dailyGoalTime, day.complete) === "failed" && "text-destructive"
            )}
          >
            {day.dailyGoalTime ? (
              <DividedValue
                items={[day.studyTime || "-", <span key="goal" className="text-muted-foreground">{day.dailyGoalTime}</span>]}
              />
            ) : (
              day.studyTime || "-"
            )}
          </span>
        </div>
        <SubRow label="보정 학습시간" value={signedTime(day.bonusStudyTime)} />
      </div>

      <div className="h-px w-full bg-border" />

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
            <BedDouble className="size-3.5 sm:size-4" strokeWidth={ICON_STROKE.default} />
            반휴 사용
          </span>
        </div>
        <SubRow label="일반반휴" value={day.normalLeaveUsed > 0 ? `${day.normalLeaveUsed}회` : "-"} />
        <SubRow label="사유반휴" value={day.reasonLeaveUsed > 0 ? `${day.reasonLeaveUsed}회` : "-"} />
      </div>

      <div className="h-px w-full bg-border" />

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
            <Wallet className="size-3.5 sm:size-4" strokeWidth={ICON_STROKE.default} />
            일간 총 벌금
            {!day.complete && (
              <span className="rounded-full bg-muted-foreground/10 px-1.5 py-0.5 text-micro font-medium normal-case text-muted-foreground sm:text-micro-lg">
                집계 중
              </span>
            )}
          </span>
          <span
            className={cn(
              "text-sm font-semibold sm:text-base",
              day.total > 0 ? "text-destructive" : "text-ok"
            )}
          >
            {won(day.total)}
          </span>
        </div>
        <SubRow label="일간 목표시간 벌금" value={won(day.goal)} />
        <SubRow label="오전 목표시간 벌금" value={won(day.morning)} />
        <SubRow
          label="납부확인"
          value={day.paymentStatus || "-"}
          valueClassName={cn(
            "font-sans text-xs font-semibold normal-case sm:text-sm",
            day.paymentStatus === "미납" && "text-destructive"
          )}
        />
      </div>
    </div>
  );
}
