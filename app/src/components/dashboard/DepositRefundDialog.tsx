import { CalendarDays, CheckCircle2, DoorOpen, PiggyBank, Search, TrendingDown, TriangleAlert } from "lucide-react";
import { useState } from "react";
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
import { SubRow, InfoCard, ItemTitle, buildDepositCauseItems } from "@/components/dashboard/shared";
import { useApi } from "@/hooks/useApi";
import { useAuth } from "@/lib/auth/useAuth";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import type { DepositRefundBreakdown } from "@/lib/api/types";

function won(n: number) {
  return `₩${(n || 0).toLocaleString()}`;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
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
  const [selectedDate, setSelectedDate] = useState(exitRequestDate || todayStr());

  // 🔧 [사용자 지시] "퇴실 신청 → 마지막 참여일 익일에 정산 내역과 동의
  // 버튼 출력. 단, 미납 벌금이 있거나 상금 정산이 처리되지 않았으면
  // 내역과 동의 버튼을 보여주지 않음" — 익일이 됐어도 벌금 미납이나
  // 상금 미정산이 남아있으면 아직 정확한 반환액을 계산할 수 없어 동의
  // 자체를 막는다.
  const exitDatePassed =
    exitRequested &&
    !!exitRequestDate &&
    exitDatePassedDay(exitRequestDate) &&
    !breakdown.fineUnpaid &&
    !prizePending;

  function handleRequestExit() {
    setSubmitting(true);
    setError(null);
    call<{ ok: boolean }>("/exit-request", { method: "POST", body: { exitDate: selectedDate } })
      .then(onExitRequestChange)
      .catch((err) => setError(err instanceof Error ? err.message : "퇴실 신청에 실패했습니다."))
      .finally(() => setSubmitting(false));
  }

  function handleCancelExit() {
    setSubmitting(true);
    setError(null);
    call<{ ok: boolean }>("/exit-request/cancel", { method: "POST" })
      .then(onExitRequestChange)
      .catch((err) => setError(err instanceof Error ? err.message : "퇴실 신청 취소에 실패했습니다."))
      .finally(() => setSubmitting(false));
  }

  function handleAgreeExit() {
    setSubmitting(true);
    setError(null);
    call<{ ok: boolean }>("/exit-request/agree", { method: "POST" })
      .then(onExitRequestChange)
      .catch((err) => setError(err instanceof Error ? err.message : "동의 처리에 실패했습니다."))
      .finally(() => setSubmitting(false));
  }

  const amount = breakdown.amount ?? 0;
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
  const lateNoticeRate = exitRequested
    ? breakdown.lateNotice
      ? 50
      : 0
    : (() => {
        const daysUntilLastAttend = selectedDate
          ? Math.round((new Date(selectedDate).getTime() - new Date(todayStr()).getTime()) / 86_400_000)
          : null;
        return daysUntilLastAttend !== null && daysUntilLastAttend < 3 ? 50 : 0;
      })();

  const causeItems = buildDepositCauseItems(breakdown, lateNoticeRate);

  return (
    <Dialog>
      <DialogTrigger className="w-full rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        {children}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Search className="size-4 text-primary sm:size-5" />
            퇴실신청
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* 🔧 2026-09: 이 다이얼로그의 카드 제목들이 text-xs font-semibold
              sm:text-sm(12/14px)로, dashboard/shared.tsx가 이미 정의해둔
              "카드 1차 텍스트" 컴포넌트 ItemTitle(text-sm font-semibold
              sm:text-base, 14/16px)보다 작았다 — 정작 그 밑의 SubRow는
              기본값이 이미 한 단계 작고(11/12px) 옅은 색(muted-foreground)
              인데, 제목이 SubRow와 비슷한 크기라 위계가 잘 안 읽혔다
              (MeritBreakdownDialog에서 같은 문제를 겪고 사용자 확인 후
              고친 것과 동일한 원인). 새 스타일을 발명하지 않고 이미 있는
              ItemTitle로 통일했다. */}
          {exitRequested ? (
            <InfoCard className="flex items-center justify-between gap-2 bg-card">
              <span className="flex items-center gap-1.5">
                <CalendarDays className="size-3.5 shrink-0 text-muted-foreground sm:size-4" />
                <ItemTitle>마지막 참여일</ItemTitle>
              </span>
              <span className="text-xs sm:text-sm">{exitRequestDate || "-"}</span>
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
                onChange={(e) => setSelectedDate(e.target.value)}
                className="sm:h-12 sm:text-base md:text-base"
              />
            </InfoCard>
          )}

          <InfoCard className="flex flex-col gap-1.5 bg-card">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5">
                <PiggyBank className="size-3.5 shrink-0 text-muted-foreground sm:size-4" />
                <ItemTitle>예치금 반환 예상액</ItemTitle>
              </span>
              <span
                className={cn(
                  "text-xs sm:text-sm",
                  isAdmin && isReduced ? "text-destructive" : isAdmin ? "text-ok" : "text-muted-foreground"
                )}
              >
                {isAdmin ? won(amount) : "-"}
              </span>
            </div>

            {!isAdmin && (
              <span className="text-micro-lg text-muted-foreground sm:text-xs">
                마지막 참여일 다음 날 확인하실 수 있습니다.
              </span>
            )}
          </InfoCard>

          {isAdmin && (
            <InfoCard className="flex flex-col gap-1.5 bg-card">
              <span className="flex items-center gap-1.5">
                <TrendingDown className="size-3.5 shrink-0 text-muted-foreground sm:size-4" />
                <ItemTitle>차감 원인</ItemTitle>
              </span>
              {/* 🔧 2026-09: SubRow 기본값(11/12px)이 아니라 MeritBreakdownDialog
                  에서 이미 검증된 하위 항목 크기(text-xs sm:text-sm, 12/14px)로
                  맞춘다 — 같은 "카드 제목 밑 하위 항목" 역할인데 화면마다
                  크기가 다르면 위계가 화면 간에 어긋나 보인다(사용자 지적). */}
              {causeItems.map((item) => (
                <SubRow
                  key={item.key}
                  label={item.label}
                  value={`${item.rate}%`}
                  labelClassName="text-xs sm:text-sm"
                  valueClassName={cn("font-sans text-xs sm:text-sm", item.rate > 0 && "text-destructive")}
                />
              ))}
            </InfoCard>
          )}

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
              {breakdown.reason && breakdown.reason !== "가입 30일 미만" && (
                <li className="flex gap-1.5">
                  <span className="text-destructive/60">•</span>
                  {breakdown.reason}
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
            exitAgreedAt ? (
              <Alert>
                <AlertDescription>
                  예치금 정산액에 동의하셨습니다. 관리자 확인 후 처리됩니다.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  className="w-full sm:h-12 sm:text-base"
                  disabled={submitting}
                  onClick={handleCancelExit}
                >
                  퇴실 신청 취소
                </Button>
                <Button
                  variant="destructive"
                  className="w-full sm:h-12 sm:text-base"
                  disabled={submitting}
                  onClick={handleAgreeExit}
                >
                  <CheckCircle2 className="size-3.5 shrink-0" />
                  동의합니다
                </Button>
              </div>
            )
          ) : exitRequested ? (
            <>
              {/* 🔧 [사용자 지시] "미납 벌금이 있거나 상금 정산이 처리되지
                  않았으면 내역과 동의 버튼을 보여주지 않음" — 마지막
                  참여일 익일이 지났는데도 동의 버튼이 안 보이면 회원이
                  이유를 알 수 있게 사유를 안내한다. */}
              {exitRequestDate && exitDatePassedDay(exitRequestDate) && (breakdown.fineUnpaid || prizePending) && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {breakdown.fineUnpaid && prizePending
                      ? "벌금 미납분과 상금 정산이 아직 처리되지 않아 예치금 정산액을 확인할 수 없습니다."
                      : breakdown.fineUnpaid
                        ? "벌금 미납분이 남아있어 예치금 정산액을 확인할 수 없습니다."
                        : "이번 주 상금 정산이 아직 처리되지 않아 예치금 정산액을 확인할 수 없습니다."}
                  </AlertDescription>
                </Alert>
              )}
              <Button variant="outline" className="w-full sm:h-12 sm:text-base" disabled={submitting} onClick={handleCancelExit}>
                퇴실 신청 취소
              </Button>
            </>
          ) : (
            <Button
              variant="destructive"
              className="w-full sm:h-12 sm:text-base"
              disabled={submitting || !selectedDate}
              onClick={handleRequestExit}
            >
              <DoorOpen className="size-3.5 shrink-0" />
              퇴실 신청하기
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
