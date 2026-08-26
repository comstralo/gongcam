import { CalendarDays, DoorOpen, PiggyBank, Search, TrendingDown, TriangleAlert } from "lucide-react";
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
import { SubRow, InfoCard } from "@/components/dashboard/shared";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import type { DepositRefundBreakdown } from "@/lib/api/types";

function won(n: number) {
  return `₩${(n || 0).toLocaleString()}`;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export function DepositRefundDialog({
  depositRefundEstimate,
  breakdown,
  exitRequested,
  exitRequestDate,
  onExitRequestChange,
  children,
}: {
  depositRefundEstimate: string;
  breakdown: DepositRefundBreakdown;
  exitRequested: boolean;
  exitRequestDate: string | null;
  onExitRequestChange: () => void;
  children: ReactNode;
}) {
  const { call } = useApi();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(exitRequestDate || todayStr());

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

  const amount = breakdown.amount ?? 0;
  const isReduced = amount < 10000;
  const penaltyTotal = (breakdown.outputPen ?? 0) + (breakdown.timePen ?? 0);
  const penaltyRate = penaltyTotal >= 2 ? 100 : penaltyTotal === 1 ? 50 : 0;
  const daysSinceJoin = breakdown.daysSinceJoin ?? -1;

  // 차감 원인을 성격별로 세 그룹으로 나눈다. 각 그룹은 차감률 내림차순으로
  // 정렬하되, 그룹 자체의 순서(일반 차감 → 강제퇴실 계열 → 예치금 재납)는
  // 고정한다. 0%인 항목도 판정 근거를 투명하게 보여주기 위해 그대로 남긴다.
  // "직권 P"는 앱스크립트에서 관리자가 퇴실 처리 시 그때그때 입력하는
  // 사유일 뿐 시트에 상시 저장되지 않아, 지금은 UI만 만들고 항상 0%로
  // 표시한다 — 감사 기록용 시트 칸이 추가되면 실제 값을 연동할 예정.
  const generalItems = [
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
  ].sort((a, b) => b.rate - a.rate);

  const forcedExitItems = [
    { key: "fine", label: "벌금 시한 내 미납", rate: breakdown.fineUnpaid ? 100 : 0 },
    {
      key: "depositUnpaid",
      label: "예치금 재납 시한 미납",
      rate: breakdown.depositAgainStatus === "미납" ? 100 : 0,
    },
    { key: "directPen", label: "페널티 (직권 P)", rate: 0 },
  ].sort((a, b) => b.rate - a.rate);

  const depositAgainItems = [
    {
      key: "depositAgain",
      label: "예치금 재납 대상자",
      rate: breakdown.depositAgainStatus === "납부" ? 100 : 0,
    },
  ];

  return (
    <Dialog>
      <DialogTrigger className="w-full rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        {children}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Search className="size-4 text-primary sm:size-5" />
            예치금 반환 · 세부사항
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

          <InfoCard className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <PiggyBank className="size-3.5 shrink-0 text-primary sm:size-4" />
              예치금 반환 예상액
            </span>
            <span
              className={cn(
                "text-xs sm:text-sm",
                isReduced ? "text-destructive" : "text-ok"
              )}
            >
              {won(amount)}
            </span>
          </InfoCard>

          <InfoCard className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <TrendingDown className="size-3.5 shrink-0 text-primary sm:size-4" />
              차감 원인
            </span>
            {generalItems.map((item) => (
              <SubRow
                key={item.key}
                label={item.label}
                value={`${item.rate}%`}
                valueClassName={cn("font-sans", item.rate > 0 && "text-destructive")}
              />
            ))}

            <div className="my-0.5 h-px w-full bg-border" />

            {forcedExitItems.map((item) => (
              <SubRow
                key={item.key}
                label={item.label}
                value={`${item.rate}%`}
                valueClassName={cn("font-sans", item.rate > 0 && "text-destructive")}
              />
            ))}

            <div className="my-0.5 h-px w-full bg-border" />

            {depositAgainItems.map((item) => (
              <SubRow
                key={item.key}
                label={item.label}
                value={`${item.rate}%`}
                valueClassName={cn("font-sans", item.rate > 0 && "text-destructive")}
              />
            ))}
          </InfoCard>

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

          {exitRequested ? (
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
