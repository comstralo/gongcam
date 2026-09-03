import { useEffect, useMemo, useState } from "react";
import { UserX, User, ChevronDown, PiggyBank, TrendingDown, Eye, ClipboardList, Search, ShieldOff, ShieldAlert } from "lucide-react";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { InfoCard, SubRow, TintedPill, buildDepositCauseItems } from "@/components/dashboard/shared";
import type { DepositCauseItem } from "@/components/dashboard/shared";
import { SectionHeader, displayExitedName as displayName } from "@/components/admin/shared";
import { useApi } from "@/hooks/useApi";
import { ApiError } from "@/lib/api/client";
import { ICON_STROKE, cn } from "@/lib/utils";
import type { ExitedMemberEntry, ExitKind, SetExitBlacklistResponse } from "@/lib/api/types";

function won(n: number) {
  return `₩${(n || 0).toLocaleString()}`;
}

// 🔧 2026-09: 백엔드가 kindStr을 "강제 퇴실자"(discountRatio===1인 모든
// 경우 — 자동 감지된 강제 조건이든 관리자의 직권 사유든)로 통일했다.
// reasons[].label은 "페널티 누적 2회 이상 (송출 P 1회 / 주간 P 1회) ➡️
// 0% 반환"처럼 화살표·반환율까지 포함한 긴 문장이라, "강제 퇴실자
// (사유)" 한 줄로 합칠 때는 code 기준으로 짧은 키워드만 뽑는다(사용자
// 지시: "강제 퇴실자 (예치금 미납)"/"강제 퇴실자 (벌금 미납)" 형태).
// admin_reason(직권 P, 관리자가 자유 입력한 사유)만 label에서 접두사
// ("직권 사유: ")를 떼고 그대로 쓴다 — 그 값 자체가 이미 짧은 키워드가
// 아니라 관리자가 쓴 문장이기 때문이다.
const REASON_SHORT_LABEL: Record<string, string> = {
  under_30_days: "가입 30일 미만",
  fine_unpaid: "벌금 미납",
  deposit_again_unpaid: "예치금 미납",
  penalty_2_or_more: "페널티 2회 이상",
};

function shortReasonLabel(reason: { code: string; label: string }): string {
  if (reason.code === "admin_reason") return reason.label.replace(/^직권 사유:\s*/, "");
  return REASON_SHORT_LABEL[reason.code] ?? reason.label;
}

// "강제 퇴실자"/"정산 퇴실자" 등 유형에, 해당하는 사유를 괄호로 이어붙인다.
// 사유가 여러 개(예: 벌금 미납 + 페널티 2회 이상 동시 해당)면 쉼표로 나열.
function exitTypeLabel(kindStr: string, reasons: { code: string; label: string }[]): string {
  if (reasons.length === 0) return kindStr;
  return `${kindStr} (${reasons.map(shortReasonLabel).join(", ")})`;
}

// 🔧 2026-09: "차감 원인" 카드(buildDepositCauseItems)는 회원 대시보드/
// ExitProcessDialog와 공유하는 함수라, 그 회원의 실제 시트 상태(벌금
// 미납, 가입일수, 송출P/주간P 페널티)만 보여준다 — kind=admin_forced
// (직권 P)로 처리됐다는 사실 자체는 여기에 전혀 반영되지 않는다(계산에도
// 관여하지 않음, ExitProcessDialog의 admin_forced 미리보기와 동일하게
// discountRatio가 사유와 무관하게 항상 1로 고정이기 때문). 관리자가 "이
// 회원이 직권 P로 처리됐는지"를 차감 원인 목록에서도 명시적으로 확인할
// 수 있도록, "퇴실 스터디원 목록"에서만(사용자 지시 — 다른 화면은
// 그대로 둠) "페널티 (직권 P N회)" 항목을 끼워 넣는다. 블랙리스트
// SubRow와 마찬가지로(사용자 지시) admin_forced가 아닌 유형에서도 항상
// 표시하되 "0회"(rate 0)로, admin_forced면 "1회"(rate 100, 직권 P는
// 항상 반환율 0%=전액 차감)로 값만 다르게 채운다. buildDepositCauseItems
// 가 최대 차감률이 낮은 순(고지지연 50% → 나머지 100%)으로 정렬되므로,
// 이 항목도 같은 100% 그룹인 "페널티" 항목 바로 뒤(=배열 맨 끝)에 둔다.
// (참고: buildDepositCauseItems의 "예치금 미납" 항목은 별도로 제거됨 —
// R3="미납"은 항상 페널티 2회 이상의 파생 표시일 뿐이라 "페널티" 항목과
// 중복이었다.)
function insertAdminForcedCauseItem(items: DepositCauseItem[], kind: ExitKind): DepositCauseItem[] {
  const isAdminForced = kind === "admin_forced";
  const adminForcedItem: DepositCauseItem = {
    key: "adminForced",
    label: `페널티 (직권 P ${isAdminForced ? 1 : 0}회)`,
    rate: isAdminForced ? 100 : 0,
  };
  return [...items, adminForcedItem];
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
        fineUnpaidDays: [],
        depositAgainStatus: null,
        lateNotice: false,
      },
      reasons: [{ code: "penalty_2_or_more", label: "페널티 누적 2회 이상 (송출 P 1회 / 주간 P 1회) ➡️ 0% 반환" }],
      processedDate: "2026-08-24",
      blacklist: false,
      googleAccount: "jaehee.kim@gmail.com",
      gooroomeeAccount: "jaehee.kim@gmail.com",
    },
  },
  {
    number: "exited:이서준 (퇴실)",
    name: "이서준 (퇴실)",
    result: {
      kind: "admin_forced",
      kindStr: "강제 퇴실자",
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
        fineUnpaidDays: [],
        depositAgainStatus: null,
        lateNotice: false,
      },
      reasons: [{ code: "admin_reason", label: "직권 사유: 비매너 행위로 인한 즉시 퇴실" }],
      processedDate: "2026-08-19",
      blacklist: true,
      googleAccount: "seojun.lee@gmail.com",
      gooroomeeAccount: "seojun.lee@gmail.com",
    },
  },
  {
    // 🔧 R3(예치금 재납)="미납"은 항상 페널티 2회 이상의 파생 결과라(코드
    // 검토로 확인, daily_calc()가 total_pen>=2일 때만 이 값을 씀), 예치금
    // 미납만 있고 페널티가 0회인 조합은 실제로 발생할 수 없다 — outputPen/
    // timePen을 2회로 맞춰 실제 있을 수 있는 조합으로 더미를 구성한다.
    number: "exited:윤아름 (퇴실)",
    name: "윤아름 (퇴실)",
    result: {
      kind: "forced",
      kindStr: "강제 퇴실자",
      refundAmount: 0,
      heldAmount: 10000,
      fineAlreadyPayment: 0,
      breakdown: {
        amount: 0,
        reason: "페널티 2회 이상",
        outputPen: 2,
        timePen: 0,
        daysSinceJoin: 60,
        fineUnpaid: false,
        fineUnpaidDays: [],
        depositAgainStatus: "미납",
        lateNotice: false,
      },
      reasons: [{ code: "penalty_2_or_more", label: "페널티 누적 2회 이상 (송출 P 2회 / 주간 P 0회) ➡️ 0% 반환" }],
      processedDate: "2026-08-17",
      blacklist: false,
      googleAccount: "areum.yoon@gmail.com",
      gooroomeeAccount: "areum.yoon@gmail.com",
    },
  },
  {
    number: "exited:한지민 (퇴실)",
    name: "한지민 (퇴실)",
    result: {
      kind: "forced",
      kindStr: "강제 퇴실자",
      refundAmount: 0,
      heldAmount: 10000,
      fineAlreadyPayment: 5000,
      breakdown: {
        amount: 0,
        reason: "벌금 시한 내 미납",
        outputPen: 0,
        timePen: 0,
        daysSinceJoin: 70,
        fineUnpaid: true,
        fineUnpaidDays: ["월", "화", "수"],
        depositAgainStatus: null,
        lateNotice: false,
      },
      reasons: [{ code: "fine_unpaid", label: "벌금 시한 내 미납 ➡️ 0% 반환" }],
      processedDate: "2026-08-12",
      blacklist: false,
      googleAccount: "jimin.han@gmail.com",
      gooroomeeAccount: "jimin.han@gmail.com",
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
        fineUnpaidDays: [],
        depositAgainStatus: null,
        lateNotice: false,
      },
      reasons: [{ code: "settle_return_rate", label: "100% 반환" }],
      processedDate: "2026-08-10",
      blacklist: false,
      googleAccount: "doyoon.park@gmail.com",
      gooroomeeAccount: "doyoon.park@gmail.com",
    },
  },
  {
    // 🔧 페널티 1회 + 고지지연이 동시에 있으면 100% 차감(반환 0원)이어야
    // 한다(calcSettleReturnDeposit 수정으로 depositRefundBreakdown과 일치
    // 시킴, 2026-09) — 이전 더미는 이 조합에서도 50%/₩5,000으로 남아있던
    // 실제 처리 로직 버그를 그대로 반영한 상태였다.
    number: "exited:최하은 (퇴실)",
    name: "최하은 (퇴실)",
    result: {
      kind: "settle",
      kindStr: "정산 퇴실자",
      refundAmount: 0,
      heldAmount: 10000,
      fineAlreadyPayment: 1500,
      breakdown: {
        amount: 0,
        reason: null,
        outputPen: 1,
        timePen: 0,
        daysSinceJoin: 95,
        fineUnpaid: false,
        fineUnpaidDays: [],
        depositAgainStatus: null,
        lateNotice: true,
      },
      reasons: [{ code: "settle_return_rate", label: "0% 반환" }],
      processedDate: "2026-08-03",
      blacklist: false,
      googleAccount: "haeun.choi@gmail.com",
      gooroomeeAccount: "haeun.choi@gmail.com",
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
  const { call } = useApi();
  const [members, setMembers] = useState<ExitedMemberEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedNumber, setExpandedNumber] = useState<string | null>(null);
  // 퇴실자가 많아지면 목록을 스크롤로 훑기보다 이름으로 바로 찾는 게
  // 빠르다 — displayName()으로 "(퇴실)" 접미사를 뗀 이름 기준, 대소문자
  // 구분 없이 부분 일치로 필터링한다.
  const [query, setQuery] = useState("");
  // 블랙리스트 토글 진행 중인 회원(번호)만 잠근다 — 여러 항목을 동시에
  // 눌러도 서로 막지 않는다.
  const [togglingNumber, setTogglingNumber] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    setTimeout(() => {
      setMembers(DUMMY_EXITED_MEMBERS);
      setLoading(false);
    }, 300);
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 🔧 2026-09: 블랙리스트 등록/해제 토글(POST /admin/exit/blacklist) —
  // 실제 백엔드를 호출하는 진짜 액션이다(목록 자체는 위 load()처럼 아직
  // 더미 데이터지만, 이 버튼은 실제 KV 값을 바꾼다). 성공하면 이 화면이
  // "그때 이미 확정된 값"을 그대로 보여주는 조회 전용이라는 원칙대로,
  // 서버가 승인한 값으로 로컬 상태만 갱신한다 — load()를 다시 부르면
  // 더미 데이터로 덮어써져 방금 바꾼 값이 사라지므로 쓰지 않는다.
  function toggleBlacklist(m: ExitedMemberEntry) {
    if (!m.result) return;
    const nextBlacklist = !m.result.blacklist;
    setTogglingNumber(m.number);
    setError(null);
    call<SetExitBlacklistResponse>("/admin/exit/blacklist", {
      method: "POST",
      body: { name: m.name, blacklist: nextBlacklist },
    })
      .then(() => {
        setMembers(
          (prev) =>
            prev?.map((x) => (x.number === m.number && x.result ? { ...x, result: { ...x.result, blacklist: nextBlacklist } } : x)) ??
            prev
        );
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "블랙리스트 변경에 실패했습니다."))
      .finally(() => setTogglingNumber(null));
  }

  const filteredMembers = useMemo(() => {
    if (!members) return members;
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return members;
    return members.filter((m) => displayName(m.name).toLowerCase().includes(trimmed));
  }, [members, query]);

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

        {members && members.length > 0 && (
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground sm:size-4"
              strokeWidth={ICON_STROKE.default}
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="이름으로 검색"
              className="pl-9 sm:h-11 sm:pl-10 sm:text-base"
            />
          </div>
        )}

        {loading && !members && (
          <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">불러오는 중...</p>
        )}

        {!loading && members && members.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">퇴실한 스터디원이 없습니다.</p>
        )}

        {!loading && members && members.length > 0 && filteredMembers && filteredMembers.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">
            "{query}"와 일치하는 퇴실 스터디원이 없습니다.
          </p>
        )}

        {filteredMembers && filteredMembers.length > 0 && (
          <div className="flex flex-col gap-2 sm:gap-2.5">
            {filteredMembers.map((m) => {
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
                    <span className="flex items-center gap-1.5">
                      {result?.blacklist && <TintedPill tone="warn">블랙리스트</TintedPill>}
                      <ChevronDown
                        className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isExpanded && "rotate-180")}
                        strokeWidth={ICON_STROKE.default}
                      />
                    </span>
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
                                result.refundAmount >= 5000 && "text-ok",
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
                            {insertAdminForcedCauseItem(
                              buildDepositCauseItems(result.breakdown, result.breakdown.lateNotice ? 50 : 0),
                              result.kind
                            ).map((item) => (
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
                            <SubRow label="유형" value={exitTypeLabel(result.kindStr, result.reasons)} />
                            {/* 🔧 2026-09: 처음엔 admin_forced(직권 P)에서만
                                조건부로 보였으나, 사용자 지시로 모든 퇴실
                                유형에 항상 표시하도록 변경 — forced/settle은
                                블랙리스트 체크박스 자체가 없어(§ExitProcessDialog)
                                항상 N으로 저장된 값이 그대로 뜬다. 표기도
                                "예/아니오"에서 "Y/N"으로 변경. */}
                            <SubRow
                              label="블랙리스트"
                              value={result.blacklist ? "Y" : "N"}
                              valueClassName={result.blacklist ? "text-destructive" : undefined}
                            />
                          </InfoCard>

                          <Button
                            variant="outline"
                            className="w-full sm:h-11 sm:text-base"
                            disabled={togglingNumber === m.number}
                            onClick={() => toggleBlacklist(m)}
                          >
                            {result.blacklist ? (
                              <ShieldOff className="size-3.5 shrink-0 sm:size-4" strokeWidth={ICON_STROKE.default} />
                            ) : (
                              <ShieldAlert className="size-3.5 shrink-0 sm:size-4" strokeWidth={ICON_STROKE.default} />
                            )}
                            {result.blacklist ? "블랙리스트 등록 해제" : "블랙리스트로 등록"}
                          </Button>
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
