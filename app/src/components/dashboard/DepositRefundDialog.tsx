import { CalendarDays, FlaskConical, Search, SkipForward, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  InfoCard,
  ItemTitle,
  buildDepositCauseItems,
  mergePenaltyLabel,
  RefundAmountCard,
  DepositCauseCard,
} from "@/components/dashboard/shared";
import { useApi } from "@/hooks/useApi";
import { useAuth } from "@/lib/auth/useAuth";
import { cn, ICON_STROKE } from "@/lib/utils";
import type { ReactNode } from "react";
import type { DepositRefundBreakdown } from "@/lib/api/types";

function won(n: number) {
  return `₩${(n || 0).toLocaleString()}`;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// 🧪 [목업 미리보기, 사용자 지시] "'퇴실신청' 다이얼로그 제목 옆에 토글
// 버튼을 만들고, 신청 전 → 신청 후(마지막 참여일 미도래) → 신청 후
// (도래) 3단계를 확인할 수 있게 해줘" — 관리자 계정에서 API 호출 없이
// 이 다이얼로그가 실제로 다루는 상태 전환을 확인하기 위한 것. 신청/
// 취소/동의 버튼을 누르면 실제로 다음 단계로 넘어가 보이도록 순환시킨다.
// 🔧 [사용자 지시] "당일이 됐을 때, 벌금 미납이나 상금 미정산자면
// 오버레이에... '동의합니다' 버튼을 비활성화 처리해줘" — 이 두 케이스도
// 실제로 눈으로 확인할 수 있도록 도래 단계를 셋으로 나눴다(정상/벌금
// 미납/상금 미정산).
type DummyExitStage = "before" | "requested" | "arrivedOk" | "arrivedFineUnpaid" | "arrivedPrizePending";

const DUMMY_STAGE_ORDER: DummyExitStage[] = [
  "before",
  "requested",
  "arrivedOk",
  "arrivedFineUnpaid",
  "arrivedPrizePending",
];

function nextDummyStage(current: DummyExitStage): DummyExitStage {
  const idx = DUMMY_STAGE_ORDER.indexOf(current);
  return DUMMY_STAGE_ORDER[(idx + 1) % DUMMY_STAGE_ORDER.length];
}

const DUMMY_STAGE_LABEL: Record<DummyExitStage, string> = {
  before: "목업 · 신청 전",
  requested: "목업 · 신청 후(미도래)",
  arrivedOk: "목업 · 신청 후(도래, 정상)",
  arrivedFineUnpaid: "목업 · 신청 후(도래, 벌금 미납)",
  arrivedPrizePending: "목업 · 신청 후(도래, 상금 미정산)",
};

// exitRequestDate는 "YYYY-MM-DD" 문자열만 쓰이므로, 미도래는 오늘로부터
// 5일 뒤(2주 신청 범위 안), 도래 3종은 모두 어제 날짜로 고정해 "이미
// 익일이 지남" 조건(exitDatePassedDay)을 항상 만족시킨다.
function dummyExitRequestDate(stage: DummyExitStage): string | null {
  if (stage === "before") return null;
  const offsetDays = stage === "requested" ? 5 : -1;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function dummyBreakdown(stage: DummyExitStage): DepositRefundBreakdown {
  return {
    amount: stage === "requested" ? 5000 : 10000,
    reason: null,
    outputPen: 0,
    timePen: 0,
    daysSinceJoin: 120,
    fineUnpaid: stage === "arrivedFineUnpaid",
    fineUnpaidDays: stage === "arrivedFineUnpaid" ? ["월"] : [],
    depositAgainStatus: null,
    lateNotice: stage === "requested",
  };
}

function dummyPrizePending(stage: DummyExitStage): boolean {
  return stage === "arrivedPrizePending";
}

// 🔧 [사용자 지시] "마지막 참여일을 캘린더 2주 범위로만 선택 가능하도록" —
// 너무 먼 미래 날짜를 신청하면 그 사이 페널티/벌금 상태가 여러 번
// 바뀔 수 있어 신청 시점의 반환액 미리보기가 무의미해진다. todayStr과
// 동일한 시간대 기준(UTC 자정)으로 14일 뒤까지만 허용한다.
function maxSelectableDateStr() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 14);
  return d.toISOString().slice(0, 10);
}

// 🔧 [정산 퇴실 절차 명확화, 사용자 지시] "퇴실 신청 → 마지막 참여일
// 익일에 정산 내역과 동의 버튼 출력. 단, 미납 벌금이 있거나 상금
// 정산이 처리되지 않았으면 내역과 동의 버튼을 보여주지 않음 → 동의를
// 누르면 관리자가 확인 후 확정 처리" — 이전엔 "exitDate 다음날 오전
// 2시 이후"라는 모호한 시간 기준이었으나, 이제 "익일(자정)"로 단순화하고
// 벌금 미납/상금 미정산 여부는 별도 조건(fineUnpaid/prizePending)으로
// 명시적으로 분리한다.
function exitDatePassedDay(exitDate: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(exitDate);
  if (!m) return false;
  // exitDate(그 날짜)의 KST 자정을 UTC ms로 표현: KST는 UTC+9이므로,
  // "그 날짜 00:00 KST"는 "그 날짜 00:00 UTC - 9시간"과 같다.
  const exitDateMidnightUtcMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 9 * 60 * 60 * 1000;
  // 익일 00:00(KST) = 그 날짜 자정(UTC 환산) + 24시간.
  const nextDayMidnightUtcMs = exitDateMidnightUtcMs + 24 * 60 * 60 * 1000;
  return Date.now() >= nextDayMidnightUtcMs;
}

export function DepositRefundDialog({
  depositRefundEstimate,
  breakdown,
  exitRequested,
  exitRequestDate,
  exitAgreedAt,
  prizePending,
  onExitRequestChange,
  children,
}: {
  depositRefundEstimate: string;
  breakdown: DepositRefundBreakdown;
  exitRequested: boolean;
  exitRequestDate: string | null;
  // 마지막 참여일이 지난 뒤 "예치금 정산액에 동의합니다"를 누른 시각. 아직
  // 안 눌렀으면 null — 이 경우 퇴실일이 지나도 관리자의 정산 처리 버튼은
  // 비활성 상태로 남는다.
  exitAgreedAt: number | null;
  // 마지막 참여일이 일요일이고 이 회원이 그 주 순위권(1~5등)인데 아직
  // 상금 정산이 집행되지 않은 상태 — true면 벌금 미납 여부와 무관하게
  // 동의 버튼을 보여주지 않는다(personal-status.js 참고).
  prizePending: boolean;
  onExitRequestChange: () => void;
  children: ReactNode;
}) {
  const { call } = useApi();
  const { isAdmin } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 🧪 [목업 미리보기] 관리자만 토글 버튼을 볼 수 있다 — 이 다이얼로그
  // 자체가 회원 본인 확인용이라 관리자 계정엔 실제 신청 상태가 없는
  // 경우가 대부분이기 때문. showingDummy가 켜지면 아래 exitRequested/
  // exitRequestDate/breakdown 등은 props 대신 dummyStage 기반 값으로
  // 대체된다.
  const [showingDummy, setShowingDummy] = useState(false);
  const [dummyStage, setDummyStage] = useState<DummyExitStage>("before");

  // 🔧 [사용자 지시] "지금 진행중인 퇴실신청의 목업은 관리자 계정
  // 시점이 아닌 일반 계정 시점에서 구현해주길 바래" — 목업을 켜면
  // 관리자가 실제로 확인하려는 것은 "일반 회원이 보는 화면"이므로,
  // 이 화면 안에서는 isAdmin을 항상 false로 취급한다(오버레이·마스킹·
  // 취소 버튼 숨김이 전부 이 값을 기준으로 동작).
  const effectiveIsAdmin = showingDummy ? false : isAdmin;

  const effectiveExitRequested = showingDummy ? dummyStage !== "before" : exitRequested;
  const effectiveExitRequestDate = showingDummy ? dummyExitRequestDate(dummyStage) : exitRequestDate;
  const effectiveExitAgreedAt = showingDummy ? null : exitAgreedAt;
  const effectivePrizePending = showingDummy ? dummyPrizePending(dummyStage) : prizePending;
  const effectiveBreakdown = showingDummy ? dummyBreakdown(dummyStage) : breakdown;

  const [selectedDate, setSelectedDate] = useState(effectiveExitRequestDate || todayStr());

  // 🧪 목업 단계가 바뀌면(신청 전 ↔ 신청 후) "마지막 참여일" 입력값도
  // 그 단계에 맞는 날짜로 다시 맞춘다 — useState 초기값은 최초 렌더에만
  // 적용되므로 이후 dummyStage 전환에는 반응하지 않는다.
  useEffect(() => {
    if (showingDummy) setSelectedDate(effectiveExitRequestDate || todayStr());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showingDummy, dummyStage]);

  // 마지막 참여일 익일이 지났는지(벌금 미납/상금 미정산 여부와 무관) —
  // "퇴실 신청 취소" 가능 여부를 이 값 하나로 판단한다.
  const lastAttendDayPassed = !!effectiveExitRequestDate && exitDatePassedDay(effectiveExitRequestDate);

  // 🔧 [사용자 지시] "퇴실 신청 → 마지막 참여일 익일에 정산 내역과 동의
  // 버튼 출력" — 익일이 지나면 "동의합니다"/"퇴실 신청 취소" 영역
  // 자체는 항상 보여준다. 벌금 미납/상금 미정산 여부는(사용자 지시:
  // "동의합니다 버튼을 비활성화 처리해줘") 버튼을 아예 숨기지 않고
  // canAgree로 비활성화만 시킨다 — 서버(handleAgreeExitRequest)도 같은
  // 조건을 다시 검증해 API 직접 호출까지 막는다.
  const exitDatePassed = effectiveExitRequested && lastAttendDayPassed;
  const canAgree = !effectiveBreakdown.fineUnpaid && !effectivePrizePending;

  // 🔧 [사용자 지시] "'퇴실 신청 취소'는 마지막 참여일까지는 본인이
  // 자발적으로 가능하고, 익일이 되면 취소하지 못하게 처리해줘(관리자는
  // 취소 가능)" — 목업 중에는 effectiveIsAdmin이 항상 false이므로 관리자가
  // 목업으로 볼 때도 일반 회원과 동일하게 취소가 막힌다.
  const canCancelExit = effectiveIsAdmin || !lastAttendDayPassed;

  // 🧪 목업 미리보기 중에는 실제 회원 상태가 아니므로 API를 호출하지
  // 않는다 — 대신 dummyStage만 다음 단계로 넘긴다(신청 전 → 신청 후
  // (미도래) → 신청 후(도래) → 다시 신청 전).
  function handleRequestExit() {
    if (showingDummy) {
      setDummyStage((s) => nextDummyStage(s));
      return;
    }
    setSubmitting(true);
    setError(null);
    call<{ ok: boolean }>("/exit-request", { method: "POST", body: { exitDate: selectedDate } })
      .then(onExitRequestChange)
      .catch((err) => setError(err instanceof Error ? err.message : "퇴실 신청에 실패했습니다."))
      .finally(() => setSubmitting(false));
  }

  function handleCancelExit() {
    if (showingDummy) {
      setDummyStage((s) => nextDummyStage(s));
      return;
    }
    setSubmitting(true);
    setError(null);
    call<{ ok: boolean }>("/exit-request/cancel", { method: "POST" })
      .then(onExitRequestChange)
      .catch((err) => setError(err instanceof Error ? err.message : "퇴실 신청 취소에 실패했습니다."))
      .finally(() => setSubmitting(false));
  }

  function handleAgreeExit() {
    if (showingDummy) {
      setDummyStage((s) => nextDummyStage(s));
      return;
    }
    setSubmitting(true);
    setError(null);
    call<{ ok: boolean }>("/exit-request/agree", { method: "POST" })
      .then(onExitRequestChange)
      .catch((err) => setError(err instanceof Error ? err.message : "동의 처리에 실패했습니다."))
      .finally(() => setSubmitting(false));
  }

  const amount = effectiveBreakdown.amount ?? 0;
  const isReduced = amount < 10000;

  // 🔧 [고지지연 실제 반영] 오늘과 마지막 참여일 사이가 3일 미만이면(임박
  // 신청) 50% 차감이고, 페널티 1개(50%)와 겹치면 100%가 된다 — 서버
  // (depositRefundBreakdown)가 실제 amount 계산에 이미 이 조건을 반영한다.
  // 이미 퇴실 신청을 제출한 상태(exitRequested)라면 서버가 정확히 아는
  // exitRequestDate 기준의 판정 결과(breakdown.lateNotice)를 그대로 믿고
  // 쓴다. 아직 신청 전(날짜만 고르는 중)이라면 서버는 이 날짜를 모르므로,
  // "이 날짜로 신청하면 어떻게 되는지" 미리보기용으로만 프론트에서 같은
  // 규칙을 재계산한다 — 실제 신청 전까지는 이 미리보기 값이 아직 서버
  // amount에는 반영되지 않은 상태임에 유의.
  const lateNoticeRate = effectiveExitRequested
    ? effectiveBreakdown.lateNotice
      ? 50
      : 0
    : (() => {
        const daysUntilLastAttend = selectedDate
          ? Math.round((new Date(selectedDate).getTime() - new Date(todayStr()).getTime()) / 86_400_000)
          : null;
        return daysUntilLastAttend !== null && daysUntilLastAttend < 3 ? 50 : 0;
      })();

  // 🔧 [사용자 지시] "차감 원인의 페널티 출력 형태도 다른 곳이랑 다른데?"
  // — 회원이 스스로 신청하는 이 화면은 "직권 P" 개념이 없으니 kind를
  // 항상 "settle"로 고정해 mergePenaltyLabel을 적용한다. 이렇게 하면
  // 관리자 확정 결과(ExitResultCards)와 동일하게 "송출 P : N회" 콜론
  // 형식, 0회 항목 생략, "페널티 (해당 없음)" 문구까지 일치한다.
  const causeItems = mergePenaltyLabel(
    buildDepositCauseItems(effectiveBreakdown, lateNoticeRate),
    effectiveBreakdown,
    "settle"
  );

  // 🔧 [사용자 지시] "접수중인 상태에서는 일반 회원이면 반환 예치금과
  // 차감 원인이 보이지 않아야 하는데... 두 영역을 덮는 오버레이로
  // 처리해서 '마지막 참여일 다음 날부터...' 메시지를 보여줘. 당일이
  // 됐을 때 벌금 미납/상금 미정산자면 각각 다른 문구를 보여주고 동의
  // 버튼을 비활성화" — 세 조건을 우선순위대로 판정한다: (1) 아직
  // 신청조차 안 했으면 카드 자체가 이 문구 대상이 아니다(신청 폼만
  // 보여줌), (2) 신청은 했지만 익일 전(접수중), (3) 익일이 지났는데
  // 벌금 미납, (4) 익일이 지났는데 상금 미정산(벌금 미납이 없을 때만
  // 확인 — 둘 다 걸리면 벌금 미납 문구를 우선한다). 관리자는 이 오버레이
  // 없이 항상 실제 값을 본다.
  const refundOverlayMessage = effectiveIsAdmin
    ? null
    : !effectiveExitRequested
      ? null
      : !lastAttendDayPassed
        ? "마지막 참여일 다음 날부터 반환 예치금을 확인할 수 있습니다."
        : effectiveBreakdown.fineUnpaid
          ? "미납 벌금을 먼저 납부해 주세요. 이후 퇴실 절차가 진행됩니다."
          : effectivePrizePending
            ? "지난 주 상금 대상자입니다. 정산을 기다려 주세요. 이후 퇴실 절차가 진행됩니다."
            : null;

  return (
    <Dialog>
      <DialogTrigger className="w-full rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        {children}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <Search className="size-4 text-primary sm:size-5" />
              퇴실신청
            </span>
            {/* 🧪 [사용자 지시] "'퇴실신청' 다이얼로그 제목 옆에 목업 토글
                버튼을 만들어줘" — 관리자만 이 버튼을 본다(회원 본인
                계정에는 자기 데이터가 실제로 존재하므로 목업이 필요
                없음). 누르면 아래 카드들이 신청 전 → 신청 후(미도래) →
                신청 후(도래, 정상/벌금 미납/상금 미정산) 5단계를 순환한다.
                🔧 [사용자 지시] "목업 토글 버튼이 활성화 되면 좌측에 재생
                아이콘 모양의 버튼을 만들어서 누를 때마다 각 단계별 목업
                화면으로 전환되도록" — 기존에도 신청/취소/동의 버튼을
                누르면 다음 단계로 넘어갔지만, 이 버튼은 그 흐름과 무관하게
                항상 바로 다음 단계로 건너뛸 수 있게 한다. */}
            {isAdmin && (
              <span className="flex items-center gap-1">
                {showingDummy && (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    className="shrink-0 border-ok/30 bg-ok/15 text-ok hover:bg-ok/25 dark:hover:bg-ok/25"
                    onClick={() => setDummyStage((s) => nextDummyStage(s))}
                    aria-label="다음 목업 단계로 전환"
                    title="다음 목업 단계로 전환"
                  >
                    <SkipForward className="size-3.5" strokeWidth={ICON_STROKE.default} />
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  className={cn(
                    "shrink-0",
                    showingDummy && "border-ok/30 bg-ok/15 text-ok hover:bg-ok/25 dark:hover:bg-ok/25"
                  )}
                  onClick={() => setShowingDummy((v) => !v)}
                  aria-pressed={showingDummy}
                  aria-label={showingDummy ? "목업 미리보기 끄기" : "목업 데이터로 미리보기"}
                  title={showingDummy ? "목업 미리보기 끄기" : "목업 데이터로 미리보기"}
                >
                  <FlaskConical className="size-3.5" strokeWidth={ICON_STROKE.default} />
                </Button>
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {showingDummy && (
          <p className="text-micro-lg text-ok sm:text-xs">{DUMMY_STAGE_LABEL[dummyStage]}</p>
        )}

        <div className="flex flex-col gap-3">
          {/* 🔧 2026-09: 이 다이얼로그의 카드 제목들이 dashboard/shared.tsx가
              이미 정의해둔 "카드 1차 텍스트" 컴포넌트 ItemTitle(text-sm
              font-bold sm:text-base)보다 작았다 — 정작 그 밑의 SubRow는
              기본값이 이미 한 단계 작고(11/12px) 옅은 색(muted-foreground)
              인데, 제목이 SubRow와 비슷한 크기라 위계가 잘 안 읽혔다
              (MeritBreakdownDialog에서 같은 문제를 겪고 사용자 확인 후
              고친 것과 동일한 원인). 새 스타일을 발명하지 않고 이미 있는
              ItemTitle로 통일했다. */}
          {effectiveExitRequested ? (
            <InfoCard className="flex items-center justify-between gap-2 bg-card">
              <span className="flex items-center gap-1.5">
                <CalendarDays className="size-3.5 shrink-0 text-muted-foreground sm:size-4" />
                <ItemTitle>마지막 참여일</ItemTitle>
              </span>
              <span className="text-sm sm:text-base">{effectiveExitRequestDate || "-"}</span>
            </InfoCard>
          ) : (
            <InfoCard className="flex flex-col gap-1.5 bg-card">
              <Label
                htmlFor="exit-request-date"
                className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base"
              >
                <CalendarDays className="size-3.5 shrink-0 text-muted-foreground sm:size-4" />
                마지막 참여일
              </Label>
              <Input
                id="exit-request-date"
                type="date"
                value={selectedDate}
                min={todayStr()}
                max={maxSelectableDateStr()}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="sm:h-12 sm:text-base md:text-base"
              />
            </InfoCard>
          )}

          {/* 🔧 2026-09: "반환 예치금"/"차감 원인" 카드 껍데기를
              ExitResultCards(관리자용, admin/shared.tsx)와 각자 복붙해
              구현하고 있었다(사용자 지적: "예치금 반환, 차감 원인 쪽이
              재활용 가능해 보인다") — RefundAmountCard/DepositCauseCard
              (dashboard/shared.tsx)로 공통화했다.
              🔧 [사용자 지시] "접수중인 상태에서는 일반 회원이면 반환
              예치금과 차감 원인이 보이지 않아야 하는데 지금은 출력되고
              있거든? 두 영역을 덮는 오버레이로 처리해서 '...' 라는
              메시지를 보여줘" — 두 카드를 감싸는 relative wrapper에
              refundOverlayMessage가 있을 때만 불투명 오버레이를 얹는다.
              관리자(effectiveIsAdmin)는 오버레이 없이 항상 실제 값을
              본다. */}
          <div className="relative">
            <div className="flex flex-col gap-3">
              <RefundAmountCard
                valueContent={refundOverlayMessage ? "-" : won(amount)}
                valueClassName={cn(
                  "text-sm sm:text-base",
                  !refundOverlayMessage && (isReduced ? "text-destructive" : "text-ok")
                )}
              />
              <DepositCauseCard items={causeItems} maskValues={!!refundOverlayMessage} />
            </div>
            {refundOverlayMessage && (
              <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-muted/95 p-3 text-center backdrop-blur-[1px]">
                <p className="text-xs font-medium text-muted-foreground sm:text-sm">{refundOverlayMessage}</p>
              </div>
            )}
          </div>

          <InfoCard className="flex flex-col gap-1 border-destructive/30 bg-destructive/5">
            <div className="flex items-center gap-1.5 text-destructive">
              <TriangleAlert className="size-3.5 shrink-0 sm:size-4" />
              <ItemTitle className="text-destructive">주의사항</ItemTitle>
            </div>
            <ul className="flex flex-col gap-1 text-micro-lg leading-relaxed text-muted-foreground sm:text-xs">
              <li className="flex gap-1.5">
                <span className="text-destructive/60">•</span>
                조회 당일 기준입니다. 퇴실일자에는 페널티 등에 의해 달라질 수 있습니다.
              </li>
              {effectiveBreakdown.reason && effectiveBreakdown.reason !== "가입 30일 미만" && (
                <li className="flex gap-1.5">
                  <span className="text-destructive/60">•</span>
                  {effectiveBreakdown.reason}
                </li>
              )}
            </ul>
          </InfoCard>

          {!depositRefundEstimate || depositRefundEstimate === "-" ? (
            <p className="text-micro-lg text-muted-foreground/70">시트에서 값을 불러오지 못했습니다.</p>
          ) : null}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {exitDatePassed ? (
            effectiveExitAgreedAt ? (
              <Alert>
                <AlertDescription>
                  예치금 정산액에 동의하셨습니다. 관리자 확인 후 처리됩니다.
                </AlertDescription>
              </Alert>
            ) : (
              // 🔧 [사용자 지시] "퇴실 신청 취소는 마지막 참여일까지는
              // 본인이 자발적으로 가능하고, 익일이 되면 취소하지
              // 못하게(관리자는 취소 가능)" — 회원 본인에게는 canCancelExit가
              // 항상 false라 "동의합니다"만 단독으로 보인다. 관리자는 계속
              // 두 버튼을 함께 본다. "동의합니다"는 벌금 미납/상금
              // 미정산이면(canAgree=false, 위 오버레이가 이유를 설명)
              // 숨기지 않고 비활성화만 한다(사용자 지시).
              <div className={cn("grid gap-2", canCancelExit ? "grid-cols-2" : "grid-cols-1")}>
                {canCancelExit && (
                  <Button
                    variant="outline"
                    className="w-full sm:h-12 sm:text-base"
                    disabled={submitting}
                    onClick={handleCancelExit}
                  >
                    퇴실 신청 취소
                  </Button>
                )}
                <Button
                  variant="outline"
                  className="w-full border-transparent bg-ok/10 text-ok hover:bg-ok/20 sm:h-12 sm:text-base dark:bg-ok/20 dark:hover:bg-ok/30"
                  disabled={submitting || !canAgree}
                  title={!canAgree ? "미납 벌금 또는 상금 정산이 남아있어 아직 동의할 수 없습니다." : undefined}
                  onClick={handleAgreeExit}
                >
                  위 결정에 동의합니다.
                </Button>
              </div>
            )
          ) : effectiveExitRequested ? (
            canCancelExit ? (
              <Button variant="outline" className="w-full sm:h-12 sm:text-base" disabled={submitting} onClick={handleCancelExit}>
                퇴실 신청 취소
              </Button>
            ) : null
          ) : (
            <Button
              variant="destructive"
              className="w-full sm:h-12 sm:text-base"
              disabled={submitting || !selectedDate}
              onClick={handleRequestExit}
            >
              퇴실 신청
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
