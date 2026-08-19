import { useEffect, useState } from "react";
import { Users, RotateCw, DoorOpen } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { InfoCard } from "@/components/dashboard/shared";
import { ExitProcessDialog } from "@/components/admin/ExitProcessDialog";
import { useApi } from "@/hooks/useApi";
import { ICON_STROKE, cn } from "@/lib/utils";
import type { AdminMembersRosterResponse, MemberRosterEntry } from "@/lib/api/types";

export function MemberRosterList() {
  const { call } = useApi();

  const [members, setMembers] = useState<MemberRosterEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    call<AdminMembersRosterResponse>("/admin/members/roster")
      .then((data) => setMembers(data.members || []))
      .catch((err) => setError(err instanceof Error ? err.message : "스터디원 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-bold sm:text-base">
          <Users className="size-4 shrink-0 text-primary sm:size-5" strokeWidth={ICON_STROKE.default} />
          스터디원 목록
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

      {loading && !members && (
        <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">불러오는 중...</p>
      )}

      {!loading && members && members.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">등록된 스터디원이 없습니다.</p>
      )}

      {members && members.length > 0 && (
        <div className="flex flex-col gap-2 sm:gap-2.5">
          {members.map((m) => (
            <InfoCard key={m.number} className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-bold sm:text-base">{m.name}</span>
                <span className="text-xs text-muted-foreground sm:text-sm">
                  가입일자 {m.joinDate || "-"} · 총 페널티 {m.totalPenalty}회
                </span>
              </div>
              <ExitProcessDialog
                candidate={m}
                onConfirmed={load}
                triggerClassName={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full sm:w-auto")}
              >
                <DoorOpen className="size-3.5 shrink-0" strokeWidth={ICON_STROKE.default} />
                퇴실
              </ExitProcessDialog>
            </InfoCard>
          ))}
        </div>
      )}
    </div>
  );
}
