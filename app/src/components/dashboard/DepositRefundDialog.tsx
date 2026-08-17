import { PiggyBank, TrendingDown, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SubRow, InfoCard } from "@/components/dashboard/shared";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import type { DepositRefundBreakdown } from "@/lib/api/types";

function won(n: number) {
  return `₩${(n || 0).toLocaleString()}`;
}

export function DepositRefundDialog({
  depositRefundEstimate,
  breakdown,
  children,
}: {
  depositRefundEstimate: string;
  breakdown: DepositRefundBreakdown;
  children: ReactNode;
}) {
  const amount = breakdown.amount ?? 0;
  const isReduced = amount < 10000;

  return (
    <Dialog>
      <DialogTrigger className="w-full rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        {children}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <PiggyBank className="size-4 text-primary sm:size-5" />
            예치금 반환 · 세부사항
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <InfoCard className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <PiggyBank className="size-3.5 shrink-0 text-primary sm:size-4" />
              예치금 반환 예상액
            </span>
            <div className="flex items-center justify-end gap-2">
              <span
                className={cn("font-mono text-sm font-bold sm:text-base", isReduced && "text-destructive")}
              >
                {won(amount)}
              </span>
            </div>
          </InfoCard>

          <InfoCard className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <TrendingDown className="size-3.5 shrink-0 text-primary sm:size-4" />
              차감 원인
            </span>
            <SubRow
              label="가입 후 경과일"
              value={(breakdown.daysSinceJoin ?? -1) >= 0 ? `D+${breakdown.daysSinceJoin}` : "-"}
            />
            <SubRow label="송출 P (금주+누적)" value={`${breakdown.outputPen ?? 0}회`} />
            <SubRow label="주간 P (누적)" value={`${breakdown.timePen ?? 0}회`} />
          </InfoCard>

          <InfoCard className="flex flex-col gap-1 border-destructive/30 bg-destructive/5">
            <div className="flex items-center gap-1.5 text-destructive">
              <TriangleAlert className="size-3.5 shrink-0 sm:size-4" />
              <span className="text-xs font-semibold sm:text-sm">주의사항</span>
            </div>
            <ul className="flex flex-col gap-1 text-xs leading-relaxed text-muted-foreground sm:text-sm">
              <li className="flex gap-1.5">
                <span className="text-destructive/60">•</span>
                조회 당일 기준입니다. 퇴실일자에는 페널티 등에 의해 달라질 수 있습니다.
              </li>
              {breakdown.reason && (
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
