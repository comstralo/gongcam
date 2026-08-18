import { useEffect, useState } from "react";
import { Wallet, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { InfoCard, TintedPill } from "@/components/dashboard/shared";
import { useApi } from "@/hooks/useApi";
import { ApiError } from "@/lib/api/client";
import { ICON_STROKE, cn } from "@/lib/utils";
import type { AdminFinesUnpaidResponse, FineStatus, SetFineStatusResponse, UnpaidFine } from "@/lib/api/types";

const STATUS_OPTIONS: FineStatus[] = ["미납", "납부", "면제"];

function fineKey(f: Pick<UnpaidFine, "number" | "day">) {
  return `${f.number}-${f.day}`;
}

export function AdminMoneyTab() {
  const { call } = useApi();

  const [unpaid, setUnpaid] = useState<UnpaidFine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [resolvedKeys, setResolvedKeys] = useState<Set<string>>(new Set());

  function load() {
    setLoading(true);
    setError(null);
    call<AdminFinesUnpaidResponse>("/admin/fines/unpaid")
      .then((data) => {
        setUnpaid(data.unpaid || []);
        setResolvedKeys(new Set());
      })
      .catch((err) => setError(err instanceof Error ? err.message : "벌금 미납 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSetStatus(f: UnpaidFine, status: FineStatus) {
    const key = fineKey(f);
    setPendingKey(key);
    setError(null);
    try {
      await call<SetFineStatusResponse>("/admin/fines/status", {
        method: "POST",
        body: { number: f.number, day: f.day, status },
      });
      setResolvedKeys((prev) => new Set(prev).add(key));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "납부 상태 변경에 실패했습니다.");
    } finally {
      setPendingKey(null);
    }
  }

  const visible = (unpaid || []).filter((f) => !resolvedKeys.has(fineKey(f)));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-bold sm:text-base">
          <Wallet className="size-4 shrink-0 text-primary sm:size-5" strokeWidth={ICON_STROKE.default} />
          벌금 미납 현황
        </span>
        <Button variant="outline" size="icon-sm" onClick={load} disabled={loading} aria-label="새로고침">
          <RotateCw className={cn("size-3.5", loading && "animate-spin")} strokeWidth={ICON_STROKE.default} />
        </Button>
      </div>
      <div className="h-px w-full bg-border" />

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
          {visible.map((f) => {
            const key = fineKey(f);
            const isPending = pendingKey === key;
            return (
              <InfoCard key={key} className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold sm:text-base">{f.name}</span>
                  <TintedPill tone="warn">미납 · {f.day}</TintedPill>
                </div>
                <div className="flex gap-1.5">
                  {STATUS_OPTIONS.map((status) => (
                    <Button
                      key={status}
                      size="sm"
                      variant={status === "미납" ? "destructive" : "outline"}
                      disabled={isPending}
                      onClick={() => handleSetStatus(f, status)}
                      className="flex-1 sm:flex-none"
                    >
                      {status}
                    </Button>
                  ))}
                  {/* 강제퇴실 처리 — 아직 미구현, 버튼만 우선 배치 */}
                  <Button size="sm" variant="outline" disabled className="flex-1 sm:flex-none">
                    직권
                  </Button>
                </div>
              </InfoCard>
            );
          })}
        </div>
      )}
    </div>
  );
}
