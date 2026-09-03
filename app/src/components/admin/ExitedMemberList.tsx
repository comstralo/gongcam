import { useEffect, useState } from "react";
import { UserX, User, ChevronDown, PiggyBank, TrendingDown, Eye, ClipboardList } from "lucide-react";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { InfoCard, SubRow, buildDepositCauseItems } from "@/components/dashboard/shared";
import { SectionHeader } from "@/components/admin/shared";
import { useApi } from "@/hooks/useApi";
import { ICON_STROKE, cn } from "@/lib/utils";
import type { AdminExitedMembersResponse, ExitedMemberEntry } from "@/lib/api/types";

function won(n: number) {
  return `₩${(n || 0).toLocaleString()}`;
}

// "참여 스터디원 목록"과 짝을 이루는 화면 — 원본 스프레드시트에 남은
// "{이름} (퇴실)" 백업 탭 목록을 보여주고, 각 항목을 펼치면 확정 처리
// 시점에 저장해둔 결과(반환 예치금/차감 원인/처리 결과/퇴실유형)를
// ExitProcessDialog의 미리보기 카드와 동일한 형태로 보여준다 — 다만 이건
// "지금 계산"이 아니라 "그때 이미 확정된 값"을 그대로 보여주는 조회
// 전용 화면이라 별도 API 호출(미리보기/확정) 없이 목록 응답에 함께
// 실려온다.
export function ExitedMemberList() {
  const { call } = useApi();

  const [members, setMembers] = useState<ExitedMemberEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedNumber, setExpandedNumber] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    call<AdminExitedMembersResponse>("/admin/members/exited")
      .then((data) => setMembers(data.members || []))
      .catch((err) => setError(err instanceof Error ? err.message : "퇴실 스터디원 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Collapsible defaultOpen className="flex flex-col gap-4">
      <SectionHeader icon={UserX} title="퇴실 스터디원 목록" loading={loading} onRefresh={load} />
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
          <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">퇴실한 스터디원이 없습니다.</p>
        )}

        {members && members.length > 0 && (
          <div className="flex flex-col gap-2 sm:gap-2.5">
            {members.map((m) => {
              const isExpanded = expandedNumber === m.number;
              const result = m.result;
              return (
                <InfoCard key={m.number} className="flex flex-col gap-2.5">
                  <button
                    type="button"
                    onClick={() => setExpandedNumber(isExpanded ? null : m.number)}
                    className="flex items-center justify-between gap-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded"
                  >
                    <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                      <User className="size-3 shrink-0 text-muted-foreground sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                      {m.name}
                    </span>
                    <ChevronDown
                      className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isExpanded && "rotate-180")}
                      strokeWidth={ICON_STROKE.default}
                    />
                  </button>

                  {isExpanded && (
                    <>
                      {!result && (
                        <p className="py-4 text-center text-xs text-muted-foreground sm:text-sm">
                          처리 결과를 조회할 수 없습니다 (이 기능 도입 이전에 처리된 퇴실자입니다).
                        </p>
                      )}

                      {result && (
                        <>
                          <InfoCard className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
                              <PiggyBank className="size-3.5 shrink-0 sm:size-4" strokeWidth={ICON_STROKE.default} />
                              반환 예치금
                            </span>
                            <span
                              className={cn(
                                "text-xs sm:text-sm",
                                result.refundAmount === 10000 && "text-ok",
                                result.refundAmount === 0 && "text-destructive"
                              )}
                            >
                              {won(result.refundAmount)}
                            </span>
                          </InfoCard>

                          <InfoCard className="flex flex-col gap-1.5">
                            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
                              <TrendingDown className="size-3.5 shrink-0 sm:size-4" strokeWidth={ICON_STROKE.default} />
                              차감 원인
                            </span>
                            {buildDepositCauseItems(result.breakdown, result.breakdown.lateNotice ? 50 : 0).map((item) => (
                              <SubRow
                                key={item.key}
                                label={item.label}
                                value={`${item.rate}%`}
                                valueClassName={cn("font-sans", item.rate > 0 && "text-destructive")}
                              />
                            ))}
                          </InfoCard>

                          <InfoCard className="flex flex-col gap-1.5">
                            <span className="flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                              <Eye className="size-3.5 shrink-0 sm:size-4" strokeWidth={ICON_STROKE.default} />
                              처리 결과
                            </span>
                            <SubRow label="반환 예치금" value={won(result.refundAmount)} />
                            <SubRow label="귀속 예치금" value={won(result.heldAmount)} />
                            <SubRow label="주간 납부 벌금" value={won(result.fineAlreadyPayment)} />
                            <SubRow label="처리일자" value={result.processedDate} />
                          </InfoCard>

                          <InfoCard className="flex flex-col gap-1.5">
                            <span className="flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                              <ClipboardList className="size-3.5 shrink-0 sm:size-4" strokeWidth={ICON_STROKE.default} />
                              퇴실유형
                            </span>
                            <SubRow label="유형" value={result.kindStr} />
                            {result.reasons.map((r) => (
                              <SubRow key={r.code} label="원인" value={r.label} />
                            ))}
                          </InfoCard>
                        </>
                      )}
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
