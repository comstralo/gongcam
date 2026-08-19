import { useEffect, useState } from "react";
import { Users, DoorOpen } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { InfoCard } from "@/components/dashboard/shared";
import { SectionHeader, ItemTitle } from "@/components/admin/shared";
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
    <Collapsible defaultOpen className="flex flex-col gap-4">
      <SectionHeader icon={Users} title="스터디원 목록" loading={loading} onRefresh={load} />
      <div className="h-px w-full bg-border" />
      <CollapsiblePanel className="flex flex-col gap-4">
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
              <InfoCard
                key={m.number}
                className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <ItemTitle>{m.name}</ItemTitle>
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
      </CollapsiblePanel>
    </Collapsible>
  );
}
