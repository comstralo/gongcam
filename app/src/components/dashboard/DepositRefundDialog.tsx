import { PiggyBank, TriangleAlert } from "lucide-react";
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
            <span className="text-xs font-semibold sm:text-sm">판정 근거</span>
            <SubRow
              label="가입 후 경과일"
              value={(breakdown.daysSinceJoin ?? -1) >= 0 ? `D+${breakdown.daysSinceJoin}` : "-"}
            />
            <SubRow label="송출 P (금주+누적)" value={`${breakdown.outputPen ?? 0}회`} />
            <SubRow label="주간 P (누적)" value={`${breakdown.timePen ?? 0}회`} />
          </InfoCard>

          <div className="flex flex-col gap-1.5 rounded-lg border bg-muted p-3.5">
            <span className="text-micro-lg font-semibold tracking-wide text-muted-foreground uppercase sm:text-xs">
              예치금 반환 예상액
            </span>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold sm:text-base">예상 반환액</span>
              <span
                className={cn("font-mono text-sm font-bold sm:text-base", isReduced && "text-destructive")}
              >
                {won(amount)}
              </span>
            </div>
          </div>

          {breakdown.reason && (
            <div className="flex flex-col gap-1 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <div className="flex items-center gap-1.5 text-destructive">
                <TriangleAlert className="size-3.5 shrink-0 sm:size-4" />
                <span className="text-xs font-semibold sm:text-sm">감액 사유</span>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">{breakdown.reason}</p>
            </div>
          )}

          {!depositRefundEstimate || depositRefundEstimate === "-" ? (
            <p className="text-micro-lg text-muted-foreground/70">시트에서 값을 불러오지 못했습니다.</p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
