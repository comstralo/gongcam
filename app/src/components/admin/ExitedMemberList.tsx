import { useEffect, useState } from "react";
import { UserX, User, ChevronDown, PiggyBank, TrendingDown, Eye, ClipboardList } from "lucide-react";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { InfoCard, SubRow, buildDepositCauseItems } from "@/components/dashboard/shared";
import { SectionHeader } from "@/components/admin/shared";
import { ICON_STROKE, cn } from "@/lib/utils";
import type { ExitedMemberEntry } from "@/lib/api/types";

function won(n: number) {
  return `₩${(n || 0).toLocaleString()}`;
}

// m.name/m.number는 백엔드가 "{이름} (퇴실)" 형태(백업 탭 이름 그대로)로
// 내려준다 — 이미 이 화면 자체가 "퇴실 스터디원"만 모아 보여주므로 목록
// 안에서 "(퇴실)"을 매번 반복해 붙일 필요가 없어, 표시용으로만 이름만 뽑는다.
function displayName(name: string): string {
  return name.replace(/ \(퇴실\)$/, "");
}

// 🧪 [임시 더미 미리보기] 실제 서비스 화면에서 렌더링을 확인하기 위한
// 임시 조치 — 확인 끝나면 반드시 원래 /admin/members/exited 호출로
// 되돌릴 것. 강제/직권/정산(100%/50%) 4가지 유형과, 이 기능 도입 이전에
// 처리되어 result가 없는 케이스까지 함께 보여준다.
const DUMMY_EXITED_MEMBERS: ExitedMemberEntry[] = [
  {
    number: "exited:김재희 (퇴실)",
    name: "김재희 (퇴실)",
    result: {
      kind: "forced",
      kindStr: "강제 퇴실자",
      refundAmount: 0,
      heldAmount: 10000,
      fineAlreadyPayment: 3000,
      breakdown: {
        amount: 0,
        reason: "페널티 2회 이상",
        outputPen: 1,
        timePen: 1,
        daysSinceJoin: 82,
        fineUnpaid: false,
        depositAgainStatus: null,
        lateNotice: false,
      },
      reasons: [{ code: "penalty_2_or_more", label: "페널티 누적 2회 이상 (송출 P 1회 / 주간 P 1회) ➡️ 0% 반환" }],
      processedDate: "2026-08-24",
    },
  },
  {
    number: "exited:이서준 (퇴실)",
    name: "이서준 (퇴실)",
    result: {
      kind: "admin_forced",
      kindStr: "직권 퇴실자",
      refundAmount: 0,
      heldAmount: 10000,
      fineAlreadyPayment: 0,
      breakdown: {
        amount: 0,
        reason: null,
        outputPen: 0,
        timePen: 0,
        daysSinceJoin: 45,
        fineUnpaid: false,
        depositAgainStatus: null,
        lateNotice: false,
      },
      reasons: [{ code: "admin_reason", label: "직권 사유: 비매너 행위로 인한 즉시 퇴실" }],
      processedDate: "2026-08-19",
    },
  },
  {
    number: "exited:박도윤 (퇴실)",
    name: "박도윤 (퇴실)",
    result: {
      kind: "settle",
      kindStr: "정산 퇴실자",
      refundAmount: 10000,
      heldAmount: 0,
      fineAlreadyPayment: 0,
      breakdown: {
        amount: 10000,
        reason: null,
        outputPen: 0,
        timePen: 0,
        daysSinceJoin: 120,
        fineUnpaid: false,
        depositAgainStatus: null,
        lateNotice: false,
      },
      reasons: ["송출 P (0회) / 주간 P (0회) ➡️ 100% 반환"].map((label, i) => ({ code: `settle_${i}`, label })),
      processedDate: "2026-08-10",
    },
  },
  {
    number: "exited:최하은 (퇴실)",
    name: "최하은 (퇴실)",
    result: {
      kind: "settle",
      kindStr: "정산 퇴실자",
      refundAmount: 5000,
      heldAmount: 5000,
      fineAlreadyPayment: 1500,
      breakdown: {
        amount: 5000,
        reason: null,
        outputPen: 1,
        timePen: 0,
        daysSinceJoin: 95,
        fineUnpaid: false,
        depositAgainStatus: null,
        lateNotice: true,
      },
      reasons: ["송출 P (1회) / 주간 P (0회) ➡️ 50% 반환"].map((label, i) => ({ code: `settle_${i}`, label })),
      processedDate: "2026-08-03",
    },
  },
  {
    // 이 기능(2026-09) 도입 이전에 처리된 퇴실자 — 저장된 결과가 없어
    // "조회 불가" 안내만 뜨는 케이스도 함께 확인한다.
    number: "exited:정유나 (퇴실)",
    name: "정유나 (퇴실)",
    result: null,
  },
];

// "참여 스터디원 목록"과 짝을 이루는 화면 — 원본 스프레드시트에 남은
// "{이름} (퇴실)" 백업 탭 목록을 보여주고, 각 항목을 펼치면 확정 처리
// 시점에 저장해둔 결과(반환 예치금/차감 원인/처리 결과/퇴실유형)를
// ExitProcessDialog의 미리보기 카드와 동일한 형태로 보여준다 — 다만 이건
// "지금 계산"이 아니라 "그때 이미 확정된 값"을 그대로 보여주는 조회
// 전용 화면이라 별도 API 호출(미리보기/확정) 없이 목록 응답에 함께
// 실려온다.
export function ExitedMemberList() {
  const [members, setMembers] = useState<ExitedMemberEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedNumber, setExpandedNumber] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    setTimeout(() => {
      setMembers(DUMMY_EXITED_MEMBERS);
      setLoading(false);
    }, 300);
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
                      {displayName(m.name)}
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
                          <InfoCard className="flex items-center justify-between gap-2 bg-card">
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

                          <InfoCard className="flex flex-col gap-1.5 bg-card">
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

                          <InfoCard className="flex flex-col gap-1.5 bg-card">
                            <span className="flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                              <Eye className="size-3.5 shrink-0 sm:size-4" strokeWidth={ICON_STROKE.default} />
                              처리 결과
                            </span>
                            <SubRow label="반환 예치금" value={won(result.refundAmount)} />
                            <SubRow label="귀속 예치금" value={won(result.heldAmount)} />
                            <SubRow label="주간 납부 벌금" value={won(result.fineAlreadyPayment)} />
                            <SubRow label="처리일자" value={result.processedDate} />
                          </InfoCard>

                          <InfoCard className="flex flex-col gap-1.5 bg-card">
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
