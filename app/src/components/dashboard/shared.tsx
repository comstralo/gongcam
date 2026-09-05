import type { ReactNode } from "react";
import { Search, SquarePen, CircleCheck, CircleDot, Timer, BedDouble, Wallet, type LucideIcon } from "lucide-react";
import { cn, ICON_STROKE } from "@/lib/utils";
import type { StatusDay, DepositRefundBreakdown } from "@/lib/api/types";

// 하루(요일)에 일반반휴+사유반휴를 합쳐 신청할 수 있는 최대 장수. 각 종류의
// 요일별 시트 셀이 0/1만 가능해(종류당 1장) 두 종류를 합친 구조적 상한도
// 자연히 이 값과 같다 — HalfDayLeaveDialog/LeaveApplyButton이 함께 쓴다.
export const MAX_LEAVES_PER_DAY = 2;

// 카드 안에서 가장 두드러지는 1차 텍스트(예: "퇴실신청" 같은 카드 제목).
// 🔧 2026-09: 원래 font-semibold였으나, MeritBreakdownDialog("주간 총
// 상점")에서 사용자와 함께 검증을 마친 카드 제목 스타일(text-sm font-bold
// sm:text-base)을 이 앱 전체의 기준값으로 삼기로 했다(사용자 지시 —
// "제목과 하위 항목의 위계를 '주간 총 상점'에서 설정한 값처럼 보이도록").
// font-semibold로 남아있으면 그 다이얼로그와 미묘하게 다른 굵기로 보여
// 화면마다 위계가 일관되지 않다는 인상을 준다.
export function ItemTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-sm font-bold sm:text-base", className)}>{children}</span>;
}

type PillTone = "ok" | "warn" | "muted" | "primary" | "amber";

const PILL_TONE_CLASSES: Record<PillTone, string> = {
  ok: "bg-ok/15 text-ok",
  warn: "bg-destructive/15 text-destructive",
  muted: "bg-foreground/8 text-muted-foreground",
  primary: "bg-primary/15 text-primary",
  amber: "bg-amber-600/15 text-amber-600 dark:bg-amber-400/15 dark:text-amber-400",
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
  // 🔧 2026-09: 요약 타일(목표시간/가입일자/총 페널티 등) 배경을
  // bg-muted(회색)에서 bg-card(흰색)로 변경(사용자 지시).
  return (
    <div className="relative flex flex-col gap-1 rounded-xl border bg-card px-3.5 py-2.5 shadow-xs sm:px-4 sm:py-3">
      {clickable && (
        <ClickIcon
          className="absolute top-2 right-2 size-2.5 text-muted-foreground/50 sm:size-3"
          strokeWidth={ICON_STROKE.default}
        />
      )}
      <div className="flex items-center gap-1.25 text-muted-foreground">
        <Icon className="size-3 shrink-0 sm:size-3.5" strokeWidth={ICON_STROKE.default} />
        <span className="truncate text-xs font-semibold tracking-wide uppercase sm:text-sm">{label}</span>
      </div>
      <span
        className={cn(
          "text-sm font-bold sm:text-base",
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

// 총합(outputPen + timePen)은 0~2까지만 나올 수 있는 값이다. 0이면 "없음",
// 1이면 "1회 │ 송출 P"처럼 0이 아닌 쪽 유형만, 2면 "2회 │ 예치금 재납 대상"
// 으로 표시한다(2는 항상 예치금 재납 대상이므로 유형 대신 그 결과를
// 보여준다). 다른 타일(주간 학습시간 등)과 동일하게 DividedValue의 세로선
// 구분자를 쓴다. 대시보드 타일과 페널티 모달이 동일한 문구를 써야 해서
// 공용 헬퍼로 둔다.
export function formatTotalPenalty(outputPen: number, timePen: number): ReactNode {
  const total = outputPen + timePen;
  if (total <= 0) return "없음";
  const kind = total >= 2 ? "예치금 재납 대상" : outputPen > 0 ? "송출 P" : "주간 P";
  return <DividedValue items={[`${total}회`, kind]} />;
}

export type DepositCauseItem = { key: string; label: string; rate: number };

// "예치금 반환액이 왜 깎였는지" 항목별 사유를, 각 항목이 낼 수 있는 최대
// 차감률이 낮은 순서(고지지연 최대 50% → 벌금 미납/30일 미만/페널티
// 각 최대 100%)로 고정해 만든다(🔧 2026-09, 사용자 지시 — 실제 rate 값
// 기준으로 회원마다 동적 정렬하면 카드 순서가 매번 달라져 오히려 훑어보기
// 어려워지므로, "이 항목이 발생하면 최대 몇 % 깎이는지" 기준의 고정
// 순서를 택했다).
// DepositRefundDialog(회원 본인 대시보드)와 ExitProcessDialog(관리자
// 정산 퇴실 처리) 둘 다 같은 breakdown 구조를 받아 이 항목들을 그대로
// 보여준다. lateNoticeRate는 호출부가 각자의 방식으로 계산해 넘긴다 —
// 회원 대시보드는 "아직 신청 전"일 수 있어 선택한 날짜로 미리 계산하고,
// 관리자 정산 처리는 이미 확정된 신청이라 breakdown.lateNotice를 그대로 쓴다.
//
// 🔧 2026-09: "예치금 미납"(depositAgainStatus==="미납") 항목을 제거했다 —
// 개인 탭 R3가 "미납"으로 바뀌는 유일한 경로는 앱스크립트 daily_calc()가
// "데이터" 시트 페널티 슬롯 총합(outputPen+timePen)이 2 이상일 때 자동으로
// 써넣는 것뿐이라(코드 검토로 확인), R3="미납"은 항상 "페널티 2회 이상"의
// 뒤늦은 파생 표시일 뿐 독립된 원인이 아니다 — 두 항목이 사실상 같은
// 사건을 중복 표시하고 있었다(사용자 지적). 반환액 계산(depositRefundBreakdown
// 의 amount)도 R3를 기다리지 않고 페널티 카운트만으로 이미 0원을 산출하므로,
// 이 항목을 빼도 판정 정확도나 우회 가능성에는 영향이 없다.
export function buildDepositCauseItems(
  breakdown: DepositRefundBreakdown,
  lateNoticeRate: number
): DepositCauseItem[] {
  const penaltyTotal = (breakdown.outputPen ?? 0) + (breakdown.timePen ?? 0);
  const penaltyRate = penaltyTotal >= 2 ? 100 : penaltyTotal === 1 ? 50 : 0;
  const daysSinceJoin = breakdown.daysSinceJoin ?? -1;

  return [
    {
      key: "lateNotice",
      label: "퇴실 통보 지연 (3일내)",
      rate: lateNoticeRate,
    },
    {
      key: "fine",
      // 🔧 2026-09: 어느 요일에 미납이 발생했는지 항상 괄호로 병기한다
      // (사용자 지시) — "30일 미만 참여자 (D+N)"과 동일하게 rate가 0%여도
      // 괄호 표시 자체는 계속 남긴다. 미납 요일이 없으면 "(해당없음)".
      label: `벌금 미납 (${breakdown.fineUnpaidDays?.length ? breakdown.fineUnpaidDays.join(", ") : "해당없음"})`,
      rate: breakdown.fineUnpaid ? 100 : 0,
    },
    {
      key: "days",
      label: `30일 미만 참여자 (D+${daysSinceJoin >= 0 ? daysSinceJoin : "-"})`,
      rate: daysSinceJoin >= 0 && daysSinceJoin < 30 ? 100 : 0,
    },
    {
      key: "penalty",
      label: `페널티 (송출 P ${breakdown.outputPen ?? 0}회 + 주간 P ${breakdown.timePen ?? 0}회)`,
      rate: penaltyRate,
    },
  ];
}

// "└" 접두 트리 표기로 상위 행 아래 들여쓰기된 세부 항목을 표시하는 서브로우.
// indent: 상위 행 없이 박스 안에 항목만 나열할 때는 false로 꺼서 불필요한
// 좌측 여백/트리 기호 없이 일반 목록처럼 보이게 한다.
export function SubRow({
  label,
  value,
  valueClassName,
  labelClassName,
  indent = true,
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string;
  labelClassName?: string;
  indent?: boolean;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-2", indent && "pl-5 sm:pl-5.5")}>
      <span
        className={cn(
          "text-micro-lg text-muted-foreground sm:text-xs",
          indent && "before:mr-1 before:content-['└']",
          labelClassName
        )}
      >
        {label}
      </span>
      <span className={cn("text-micro-lg tabular-nums text-muted-foreground sm:text-xs", valueClassName)}>
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

export function won(n: number) {
  return "₩" + (n || 0).toLocaleString();
}

// appscript.js deposit_value(고정 예치금)와 동일 — 재납 대상이면 이 금액
// 전액을 다시 내야 한다(미납/납부 상태와 무관하게 금액 자체는 고정).
const DEPOSIT_AGAIN_AMOUNT = 10000;

function timeToMinutes(raw: string): number | null {
  const m = (raw || "").trim().match(/^([+-]?)(\d{1,3}):(\d{2})$/);
  if (!m) return null;
  const minutes = parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
  return m[1] === "-" ? -minutes : minutes;
}

type GoalStatus = "met" | "failed" | "pending";

// 그날 기록이 완결됐는지와 무관하게, 현재 학습시간이 목표시간 이상이면
// 그 시점 기준으로 바로 초록/빨강을 표시한다.
function goalStatus(studyTime: string, goalTime: string): GoalStatus {
  const study = timeToMinutes(studyTime);
  const goal = timeToMinutes(goalTime);
  if (study === null || goal === null) return "pending";
  return study >= goal ? "met" : "failed";
}

// 시트 셀 값이 "4:10"처럼 시(hour)가 한 자리로 오는 경우가 있어, 항상
// "04:10" 두 자리로 맞춰 보여준다. 파싱 실패(빈 값 등)는 원본을 그대로 둔다.
function padHM(raw: string): string {
  const m = (raw || "").trim().match(/^(\d{1,3}):(\d{2})$/);
  if (!m) return raw;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

// 관리자가 직접 입력하는 값이라 "00:20"처럼 부호 없이 저장되는 경우 기본을 +로 해석하고,
// "-00:20"처럼 이미 부호가 붙어 있으면 그 부호를 그대로 존중한다.
function signedTime(raw: string): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "-";
  if (trimmed.startsWith("+") || trimmed.startsWith("-")) return trimmed;
  return `+${trimmed}`;
}

// 내 대시보드(StatusView)의 요일 상세 카드 — 관리자가 벌금 미납 현황에서
// 특정 인원/요일을 펼쳐볼 때도 동일한 형태로 재사용한다.
// dayLabel: MY 대시보드는 요일 선택 버튼이 이미 있어 생략하지만, 관리자 화면처럼
// 별도 요일 선택 UI 없이 이 카드만 보여줄 때는 어느 요일인지 표시해줘야 한다.
// isPast: 기록시점(23:3x) 유무와 무관하게, 오늘보다 이전 요일이면 무조건
// "마감"으로 표시한다 — 봇이 그날 마지막 기록을 못 남긴 경우에도 이미
// 지난 요일을 "진행중"으로 오인 표시하지 않기 위함.
// footer: 일반반휴 신청 버튼처럼, 훅/API 호출이 필요해 이 순수 UI 파일에
// 직접 넣기 애매한 액션 영역을 호출부에서 주입할 때 쓴다.
export function DayDetailCard({
  day,
  dayLabel,
  isPast = false,
  footer,
  depositRefundBreakdown,
  // 요일/마감·진행중/벌금 납부·미납/예치금 납부·미납 뱃지 한 줄을 보여줄지.
  // MY 대시보드는 이 뱃지들이 핵심 정보라 그대로 두지만, 관리자 "벌금 납부
  // 대상자 처리"(AdminMoneyTab)는 이미 요일별 그룹 헤더·납부확인 SubRow에
  // 같은 정보가 다 있어 중복이라 꺼둔다(사용자 지적).
  showStatusBadges = true,
}: {
  day: StatusDay;
  dayLabel?: string;
  isPast?: boolean;
  footer?: ReactNode;
  // 예치금 재납 여부(미납/납부)는 요일이 아니라 개인 탭 상단의 주간값
  // 하나뿐이라, 모든 요일 카드가 이 값을 그대로 반복해 보여준다.
  depositRefundBreakdown?: DepositRefundBreakdown;
  showStatusBadges?: boolean;
}) {
  // 예치금 재납 미납은 요일별 기록이 아니라 개인 탭 상단의 "현재 시점" 값이라,
  // 2회 달성 시점의 요일 카드(day.isDepositAgainDay)에만 뱃지를 띄운다 — 그러지
  // 않으면 이번 주 모든 요일 카드에 똑같이 "예치금 미납"이 찍히게 된다.
  const showDepositAgainUnpaidBadge =
    day.isDepositAgainDay && depositRefundBreakdown?.depositAgainStatus === "미납";
  const showDepositAgainPaidBadge =
    day.isDepositAgainDay && depositRefundBreakdown?.depositAgainStatus === "납부";

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card p-4 sm:gap-3.5 sm:p-5",
        day.total > 0 || showDepositAgainUnpaidBadge ? "border-destructive/30" : "border-border"
      )}
    >
      {showStatusBadges && (
        <div className="flex items-center justify-start gap-1.5">
          {dayLabel && <TintedPill tone="warn">{dayLabel}</TintedPill>}
          <TintedPill
            tone={day.confirmed || isPast ? "muted" : "primary"}
            icon={day.confirmed || isPast ? CircleCheck : CircleDot}
          >
            {day.confirmed || isPast ? "마감" : "진행중"}
          </TintedPill>
          {day.paymentStatus === "미납" && <TintedPill tone="warn">벌금 미납</TintedPill>}
          {day.paymentStatus === "납부" && <TintedPill tone="ok">벌금 납부</TintedPill>}
          {showDepositAgainUnpaidBadge && <TintedPill tone="warn">예치금 미납</TintedPill>}
          {showDepositAgainPaidBadge && <TintedPill tone="ok">예치금 납부</TintedPill>}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.25">
            <Timer className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
            <ItemTitle>일간 학습시간</ItemTitle>
          </span>
          <span
            className={cn(
              "text-sm sm:text-base",
              goalStatus(day.studyTime, day.dailyGoalTime) === "met" && "text-ok",
              goalStatus(day.studyTime, day.dailyGoalTime) === "failed" && "text-destructive"
            )}
          >
            {day.dailyGoalTime ? (
              <DividedValue
                items={[
                  day.studyTime ? padHM(day.studyTime) : "-",
                  <span key="goal" className="text-muted-foreground">
                    {padHM(day.dailyGoalTime)}
                  </span>,
                ]}
              />
            ) : day.studyTime ? (
              padHM(day.studyTime)
            ) : (
              "-"
            )}
          </span>
        </div>
        <SubRow
          label="로그 학습시간"
          value={day.logStudyTime ? `+${padHM(day.logStudyTime)}` : "-"}
          labelClassName="text-xs sm:text-sm"
          valueClassName="text-xs sm:text-sm"
        />
        <SubRow
          label="보정 학습시간"
          value={signedTime(day.bonusStudyTime)}
          labelClassName="text-xs sm:text-sm"
          valueClassName={cn(
            "text-xs sm:text-sm",
            (day.bonusStudyTime || "").trim() && timeToMinutes(day.bonusStudyTime) !== 0
              ? "text-destructive"
              : undefined
          )}
        />
      </div>

      <div className="h-px w-full bg-border" />

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.25">
            <BedDouble className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
            <ItemTitle>반휴권</ItemTitle>
          </span>
          <span
            className={cn(
              "text-sm sm:text-base",
              day.normalLeaveUsed + day.reasonLeaveUsed === 0 && "text-muted-foreground"
            )}
          >
            {day.normalLeaveUsed + day.reasonLeaveUsed}장
          </span>
        </div>
        <SubRow label="일반반휴" value={`${day.normalLeaveUsed}장`} labelClassName="text-xs sm:text-sm" valueClassName="text-xs sm:text-sm" />
        <SubRow
          label="사유반휴"
          value={`${day.reasonLeaveUsed}장${day.reasonLeavePending ? " (관리자 확인 중)" : ""}`}
          labelClassName="text-xs sm:text-sm"
          valueClassName="text-xs sm:text-sm"
        />
        {footer}
      </div>

      <div className="h-px w-full bg-border" />

      {(() => {
        // 예치금 재납 상태는 요일별 기록이 아니라 개인 탭 상단의 "현재 시점"
        // 스냅샷 하나뿐이라, day.isDepositAgainDay(2회 달성 시점의 요일)가
        // 아닌 카드에는 반영하지 않는다 — 그러지 않으면 이번 주 모든 요일
        // 카드에 동일하게 "미납" 등이 찍히는 문제가 있었다(사용자 지적).
        const showDepositAgain = day.isDepositAgainDay && depositRefundBreakdown?.depositAgainStatus;
        const depositAgainAmount = showDepositAgain ? DEPOSIT_AGAIN_AMOUNT : 0;
        const combinedTotal = day.total + depositAgainAmount;
        const combinedPaymentStatus =
          day.paymentStatus === "미납" || (showDepositAgain && depositRefundBreakdown?.depositAgainStatus === "미납")
            ? "미납"
            : day.paymentStatus;
        return (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.25">
                <Wallet className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                <ItemTitle>일간 총 벌금 · 재납 예치금</ItemTitle>
              </span>
              <span
                className={cn(
                  "text-sm sm:text-base",
                  combinedTotal > 0 ? "text-destructive" : "text-muted-foreground"
                )}
              >
                {won(combinedTotal)}
              </span>
            </div>
            <SubRow
              label={`일간 목표시간 벌금${day.dailyShortfallTime ? ` (-${day.dailyShortfallTime} 미달)` : ""}`}
              value={won(day.goal)}
              labelClassName="text-xs sm:text-sm"
              valueClassName="text-xs sm:text-sm"
            />
            <SubRow
              label={`오전 목표시간 벌금${day.morningShortfallTime ? ` (-${day.morningShortfallTime} 미달)` : ""}`}
              value={won(day.morning)}
              labelClassName="text-xs sm:text-sm"
              valueClassName="text-xs sm:text-sm"
            />
            {depositRefundBreakdown && (
              <SubRow
                label={
                  showDepositAgain
                    ? `재납 예치금 (송출 P ${depositRefundBreakdown.outputPen}회 + 주간 P ${depositRefundBreakdown.timePen}회)`
                    : "재납 예치금"
                }
                value={won(depositAgainAmount)}
                labelClassName="text-xs sm:text-sm"
                valueClassName={cn(
                  "text-xs sm:text-sm",
                  showDepositAgain && depositRefundBreakdown.depositAgainStatus === "미납"
                    ? "text-destructive"
                    : undefined
                )}
              />
            )}
            <SubRow
              label="납부확인"
              value={combinedPaymentStatus || "-"}
              labelClassName="text-xs sm:text-sm"
              valueClassName={cn(
                "font-sans text-xs normal-case sm:text-sm",
                combinedPaymentStatus === "미납" && "text-destructive",
                combinedPaymentStatus === "납부" && "text-ok"
              )}
            />
          </div>
        );
      })()}
    </div>
  );
}
