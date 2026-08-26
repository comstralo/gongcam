import { useEffect, useState } from "react";
import { Users, User, DoorOpen, ChevronDown, Hash, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { InfoCard, SubRow, TintedPill } from "@/components/dashboard/shared";
import { SectionHeader } from "@/components/admin/shared";
import { ExitProcessDialog } from "@/components/admin/ExitProcessDialog";
import { useApi } from "@/hooks/useApi";
import { ICON_STROKE, cn } from "@/lib/utils";
import type { AdminMembersRosterResponse, MemberRosterEntry, SetPartiStatusResponse } from "@/lib/api/types";

export function MemberRosterList() {
  const { call } = useApi();

  const [members, setMembers] = useState<MemberRosterEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedNumber, setExpandedNumber] = useState<string | null>(null);
  const [cancelingNumber, setCancelingNumber] = useState<string | null>(null);
  const [togglingNumber, setTogglingNumber] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    call<AdminMembersRosterResponse>("/admin/members/roster")
      .then((data) => setMembers(data.members || []))
      .catch((err) => setError(err instanceof Error ? err.message : "스터디원 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  function cancelExitRequest(number: string) {
    setCancelingNumber(number);
    setError(null);
    call<{ ok: boolean }>("/exit-request/cancel", { method: "POST", body: { number } })
      .then(load)
      .catch((err) => setError(err instanceof Error ? err.message : "퇴실 신청 취소에 실패했습니다."))
      .finally(() => setCancelingNumber(null));
  }

  function toggleViceLeader(m: MemberRosterEntry) {
    setTogglingNumber(m.number);
    setError(null);
    call<SetPartiStatusResponse>("/admin/members/parti-status", {
      method: "POST",
      body: { number: m.number, appoint: m.partiStatus !== "부스터디장" },
    })
      .then(load)
      .catch((err) => setError(err instanceof Error ? err.message : "부스터디장 임명/해제에 실패했습니다."))
      .finally(() => setTogglingNumber(null));
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
            {members.map((m) => {
              const isExpanded = expandedNumber === m.number;
              return (
                <InfoCard key={m.number} className="flex flex-col gap-2.5">
                  <button
                    type="button"
                    onClick={() => setExpandedNumber(isExpanded ? null : m.number)}
                    className="flex items-center justify-between gap-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded"
                  >
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
                      <User className="size-3 shrink-0 text-muted-foreground sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                      {m.name}
                      {m.partiStatus !== "스터디원" && (
                        <TintedPill tone={m.partiStatus === "스터디장" ? "primary" : "ok"}>{m.partiStatus}</TintedPill>
                      )}
                    </span>
                    <span className="flex items-center gap-1.5">
                      {m.exitRequested && <TintedPill tone="amber">퇴실 예약</TintedPill>}
                      <ChevronDown
                        className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isExpanded && "rotate-180")}
                        strokeWidth={ICON_STROKE.default}
                      />
                    </span>
                  </button>

                  {isExpanded && (
                    <>
                      <div className="flex flex-col gap-1.5 rounded-xl border bg-card p-4 sm:p-5">
                        <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                          <Hash className="size-3.5 sm:size-4" strokeWidth={ICON_STROKE.default} />
                          기본 정보
                        </span>
                        <SubRow label="시트번호" value={`${m.number}번`} />
                        <SubRow label="가입일자" value={m.joinDate || "-"} />
                        <SubRow
                          label="총 페널티"
                          value={`${m.totalPenalty}회`}
                          valueClassName={m.totalPenalty > 0 ? "text-destructive" : undefined}
                        />
                        {m.exitRequested && (
                          <SubRow
                            label="퇴실 신청"
                            value={m.exitRequestDate ? `${m.exitRequestDate} 희망` : "접수됨"}
                            valueClassName="text-amber-600 dark:text-amber-400"
                          />
                        )}
                      </div>

                      <div
                        className={cn(
                          "grid gap-2",
                          m.partiStatus === "스터디장"
                            ? m.exitRequested
                              ? "grid-cols-2"
                              : "grid-cols-1"
                            : m.exitRequested
                              ? "grid-cols-3"
                              : "grid-cols-2"
                        )}
                      >
                        {m.partiStatus !== "스터디장" && (
                          <Button
                            variant="outline"
                            className="w-full sm:h-12 sm:text-base"
                            disabled={togglingNumber === m.number}
                            onClick={() => toggleViceLeader(m)}
                          >
                            <Star className="size-3.5 shrink-0" strokeWidth={ICON_STROKE.default} />
                            {m.partiStatus === "부스터디장" ? "임명 해제" : "부스터디장 임명"}
                          </Button>
                        )}
                        <ExitProcessDialog candidate={m} onConfirmed={load} triggerClassName="w-full">
                          <Button variant="destructive" className="w-full sm:h-12 sm:text-base">
                            <DoorOpen className="size-3.5 shrink-0" strokeWidth={ICON_STROKE.default} />
                            퇴실 처리
                          </Button>
                        </ExitProcessDialog>
                        {m.exitRequested && (
                          <Button
                            variant="outline"
                            className="w-full sm:h-12 sm:text-base"
                            disabled={cancelingNumber === m.number}
                            onClick={() => cancelExitRequest(m.number)}
                          >
                            신청 취소
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                </InfoCard>
              );
            })}
          </div>
        )}
      </CollapsiblePanel>
    </Collapsible>
  );
}
