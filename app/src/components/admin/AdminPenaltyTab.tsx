import { useEffect, useState } from "react";
import { ShieldAlert, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { InfoCard } from "@/components/dashboard/shared";
import { ExitProcessDialog } from "@/components/admin/ExitProcessDialog";
import { useApi } from "@/hooks/useApi";
import { ICON_STROKE, cn } from "@/lib/utils";
import type { AdminExitCandidatesResponse, ExitCandidate } from "@/lib/api/types";

const KIND_LABEL: Record<ExitCandidate["suggestedKind"], string> = {
  forced: "강제퇴실 대상",
  settle: "정산퇴실 대상",
};

export function AdminPenaltyTab() {
  const { call } = useApi();

  const [candidates, setCandidates] = useState<ExitCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    call<AdminExitCandidatesResponse>("/admin/exit/candidates")
      .then((data) => setCandidates(data.candidates || []))
      .catch((err) => setError(err instanceof Error ? err.message : "퇴실 후보 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-bold sm:text-base">
          <ShieldAlert className="size-4 shrink-0 text-primary sm:size-5" strokeWidth={ICON_STROKE.default} />
          퇴실·재납 대상자
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

      {loading && !candidates && (
        <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">불러오는 중...</p>
      )}

      {!loading && candidates && candidates.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">처리 대상이 없습니다.</p>
      )}

      {candidates && candidates.length > 0 && (
        <div className="flex flex-col gap-2 sm:gap-2.5">
          {candidates.map((c) => (
            <ExitProcessDialog key={c.number} candidate={c} onConfirmed={load}>
              <InfoCard className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-bold sm:text-base">{c.name}</span>
                  <span className="rounded-full bg-destructive/15 px-2.5 py-1 text-micro-lg font-semibold text-destructive sm:text-xs">
                    {KIND_LABEL[c.suggestedKind]}
                  </span>
                </div>
                <p className="truncate text-xs text-muted-foreground sm:text-sm">{c.reasons.join(", ")}</p>
              </InfoCard>
            </ExitProcessDialog>
          ))}
        </div>
      )}
    </div>
  );
}
