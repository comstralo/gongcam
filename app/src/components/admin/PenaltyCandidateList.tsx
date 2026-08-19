import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { InfoCard } from "@/components/dashboard/shared";
import { SectionHeader, ItemTitle } from "@/components/admin/shared";
import { ExitProcessDialog } from "@/components/admin/ExitProcessDialog";
import { useApi } from "@/hooks/useApi";
import type { AdminExitCandidatesResponse, ExitCandidate } from "@/lib/api/types";

// PENALTY 탭의 "페널티 대상자" — 페널티 누적 2 이상인 회원만 다룬다. 이
// 조건에서는 반환율이 항상 0%로 고정되므로 유형 선택 없이 정산 퇴실자로
// 곧바로 확정할 수 있다(ExitProcessDialog의 lockKind="settle").
export function PenaltyCandidateList() {
  const { call } = useApi();

  const [candidates, setCandidates] = useState<ExitCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    call<AdminExitCandidatesResponse>("/admin/exit/candidates")
      .then((data) => setCandidates(data.candidates || []))
      .catch((err) => setError(err instanceof Error ? err.message : "페널티 대상자 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Collapsible defaultOpen className="flex flex-col gap-4">
      <SectionHeader icon={ShieldAlert} title="페널티 대상자" loading={loading} onRefresh={load} />
      <div className="h-px w-full bg-border" />
      <CollapsiblePanel className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading && !candidates && (
          <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">불러오는 중...</p>
        )}

        {!loading && candidates && candidates.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">처리 대상이 없습니다.</p>
        )}

        {candidates && candidates.length > 0 && (
          <div className="flex flex-col gap-2 sm:gap-2.5">
            {candidates.map((c) => (
              <ExitProcessDialog key={c.number} candidate={c} onConfirmed={load} lockKind="settle">
                <InfoCard className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <ItemTitle>{c.name}</ItemTitle>
                    <span className="rounded-full bg-destructive/15 px-2.5 py-1 text-micro-lg font-semibold text-destructive sm:text-xs">
                      정산퇴실 대상
                    </span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground sm:text-sm">{c.reasons.join(", ")}</p>
                </InfoCard>
              </ExitProcessDialog>
            ))}
          </div>
        )}
      </CollapsiblePanel>
    </Collapsible>
  );
}
