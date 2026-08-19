import { useEffect, useState } from "react";
import { PiggyBank } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { InfoCard } from "@/components/dashboard/shared";
import { SectionHeader, ItemTitle } from "@/components/admin/shared";
import { useApi } from "@/hooks/useApi";
import { ApiError } from "@/lib/api/client";
import type { AdminDepositsUnpaidResponse, SetDepositStatusResponse, UnpaidDeposit } from "@/lib/api/types";

// 페널티 누적 2 이상이면 앱스크립트가 예치금 재납(R3)을 자동으로 "미납"
// 처리한다 — 이 목록은 그렇게 발생한 예치금 재납 대상자를 보여준다.
// "재납"은 실제 재납을 받았을 때(R3를 "납부"로), "직권 P"는 강제퇴실
// 처리로 이어지는 버튼이며 아직 미구현이라 우선 버튼만 배치한다.
export function PenaltyDepositList() {
  const { call } = useApi();

  const [unpaid, setUnpaid] = useState<UnpaidDeposit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingNumber, setPendingNumber] = useState<string | null>(null);
  const [resolvedNumbers, setResolvedNumbers] = useState<Set<string>>(new Set());

  function load() {
    setLoading(true);
    setError(null);
    call<AdminDepositsUnpaidResponse>("/admin/deposits/unpaid")
      .then((data) => {
        setUnpaid(data.unpaid || []);
        setResolvedNumbers(new Set());
      })
      .catch((err) => setError(err instanceof Error ? err.message : "예치금 미납 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleAgain(d: UnpaidDeposit) {
    setPendingNumber(d.number);
    setError(null);
    try {
      await call<SetDepositStatusResponse>("/admin/deposits/status", {
        method: "POST",
        body: { number: d.number, status: "납부" },
      });
      setResolvedNumbers((prev) => new Set(prev).add(d.number));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "예치금 재납 상태 변경에 실패했습니다.");
    } finally {
      setPendingNumber(null);
    }
  }

  const visible = (unpaid || []).filter((d) => !resolvedNumbers.has(d.number));

  return (
    <Collapsible defaultOpen className="flex flex-col gap-4">
      <SectionHeader icon={PiggyBank} title="예치금 미납 현황" loading={loading} onRefresh={load} />
      <div className="h-px w-full bg-border" />
      <CollapsiblePanel className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading && !unpaid && (
          <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">불러오는 중...</p>
        )}

        {!loading && unpaid && visible.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">미납 항목이 없습니다.</p>
        )}

        {visible.length > 0 && (
          <div className="flex flex-col gap-2 sm:gap-2.5">
            {visible.map((d) => {
              const isPending = pendingNumber === d.number;
              return (
                <InfoCard
                  key={d.number}
                  className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <ItemTitle>{d.name}</ItemTitle>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="outline" disabled={isPending} onClick={() => handleAgain(d)} className="flex-1 sm:flex-none">
                      재납
                    </Button>
                    {/* 강제퇴실 처리 — 아직 미구현, 버튼만 우선 배치 */}
                    <Button size="sm" variant="outline" disabled className="flex-1 sm:flex-none">
                      직권 P
                    </Button>
                  </div>
                </InfoCard>
              );
            })}
          </div>
        )}
      </CollapsiblePanel>
    </Collapsible>
  );
}
