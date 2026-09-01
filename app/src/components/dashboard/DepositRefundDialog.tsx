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
import { SubRow, InfoCard, buildDepositCauseItems } from "@/components/dashboard/shared";
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

// 🔧 [일간 집계 완료 시점 반영] "마지막 참여일" 당일이 KST로 지났다고
// 해서 그날의 최종 반환액이 바로 확정되는 게 아니다 — 앱스크립트의
// daily_calc()가 "그날 다음날 자정~오전 1시 사이"에 실행돼야 그날치 벌금
// 미납/페널티 판정이 최종 반영된다(사용자 지적). 그래서 exitDate 당일이
// 지났다고 바로 "동의합니다" 버튼을 보여주면, 아직 집계가 안 끝난 값을
// 회원이 동의해버릴 수 있다 — exitDate 다음날 오전 2시(집계 시각보다
// 넉넉히 여유를 둔 시각) 이후부터 노출한다.
function exitDateSettled(exitDate: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(exitDate);
  if (!m) return false;
  // exitDate(그 날짜)의 KST 자정을 UTC ms로 표현: KST는 UTC+9이므로,
  // "그 날짜 00:00 KST"는 "그 날짜 00:00 UTC - 9시간"과 같다.
  const exitDateMidnightUtcMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 9 * 60 * 60 * 1000;
  // 다음날 오전 2시(KST) = 그 날짜 자정(UTC 환산) + 24시간 + 2시간.
  const settledAtUtcMs = exitDateMidnightUtcMs + 26 * 60 * 60 * 1000;
  return Date.now() >= settledAtUtcMs;
}

export function DepositRefundDialog({
  depositRefundEstimate,
  breakdown,
  exitRequested,
  exitRequestDate,
  exitAgreedAt,
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
  onExitRequestChange: () => void;
  children: ReactNode;
}) {
  const { call } = useApi();
  const { isAdmin } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(exitRequestDate || todayStr());

  // 🔧 [퇴실 프로세스 확장] 마지막 참여일(exitRequestDate)의 일간 집계가
  // 실제로 끝나야만(다음날 오전 2시 이후) "예치금 정산액에 동의합니다"
  // 버튼이 나타난다 — 그 전까지는 지금까지처럼 "퇴실 신청 취소하기"만
  // 보여준다(사용자 지시).
  const exitDatePassed = exitRequested && !!exitRequestDate && exitDateSettled(exitRequestDate);

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
          {exitRequested ? (
            <InfoCard className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
                <CalendarDays className="size-3.5 shrink-0 text-primary sm:size-4" />
                마지막 참여일
              </span>
              <span className="text-xs sm:text-sm">{exitRequestDate || "-"}</span>
            </InfoCard>
          ) : (
            <InfoCard className="flex flex-col gap-1.5">
              <Label
                htmlFor="exit-request-date"
                className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm"
              >
                <CalendarDays className="size-3.5 shrink-0 text-primary sm:size-4" />
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

          <InfoCard className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
                <PiggyBank className="size-3.5 shrink-0 text-primary sm:size-4" />
                예치금 반환 예상액
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
            <InfoCard className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
                <TrendingDown className="size-3.5 shrink-0 text-primary sm:size-4" />
                차감 원인
              </span>
              {causeItems.map((item) => (
                <SubRow
                  key={item.key}
                  label={item.label}
                  value={`${item.rate}%`}
                  valueClassName={cn("font-sans", item.rate > 0 && "text-destructive")}
                />
              ))}
            </InfoCard>
          )}

          <InfoCard className="flex flex-col gap-1 border-destructive/30 bg-destructive/5">
            <div className="flex items-center gap-1.5 text-destructive">
              <TriangleAlert className="size-3.5 shrink-0 sm:size-4" />
              <span className="text-xs font-semibold sm:text-sm">주의사항</span>
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
            <Button variant="outline" className="w-full sm:h-12 sm:text-base" disabled={submitting} onClick={handleCancelExit}>
              퇴실 신청 취소
            </Button>
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
