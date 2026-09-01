import { useEffect, useState } from "react";
import { ChevronDown, CircleDollarSign, CalendarDays, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { InfoCard, DayDetailCard, TintedPill } from "@/components/dashboard/shared";
import { SectionHeader, FieldLabel, SectionCard } from "@/components/admin/shared";
import { useApi } from "@/hooks/useApi";
import { useRefreshOnVisible } from "@/hooks/useRefreshOnVisible";
import { useTodayIndex } from "@/hooks/useTodayIndex";
import { ApiError } from "@/lib/api/client";
import { ICON_STROKE, cn } from "@/lib/utils";
import type {
  AdminFinesPaidResponse,
  AdminFinesUnpaidResponse,
  AdminFinesExemptResponse,
  FineStatus,
  SetFineStatusResponse,
  UnpaidFine,
  StatusResponse,
} from "@/lib/api/types";

const STATUS_DAYS = ["월", "화", "수", "목", "금", "토", "일"];

function fineKey(f: Pick<UnpaidFine, "number" | "day">) {
  return `${f.number}-${f.day}`;
}

function won(n: number) {
  return "₩" + (n || 0).toLocaleString();
}

// 오늘 날짜 기준 이번 주(월~일)의 각 요일 실제 날짜를 "8월 19일" 형태로 계산한다.
function thisWeekDateLabel(dayKr: string): string {
  const dayIndex = STATUS_DAYS.indexOf(dayKr); // 월=0 ... 일=6
  if (dayIndex === -1) return "";
  const now = new Date();
  const todayIndex = (now.getDay() + 6) % 7; // JS getDay()는 일=0 → 월=0으로 보정
  const monday = new Date(now);
  monday.setDate(now.getDate() - todayIndex);
  const target = new Date(monday);
  target.setDate(monday.getDate() + dayIndex);
  return `${target.getMonth() + 1}월 ${target.getDate()}일`;
}

// 같은 요일의 여러 항목을 요일별로 하나로 묶는다.
function groupByDay<T extends { number: string; name: string; day: string }>(items: T[]) {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const existing = map.get(item.day);
    if (existing) existing.push(item);
    else map.set(item.day, [item]);
  }
  return STATUS_DAYS.filter((d) => map.has(d)).map((day) => ({ day, members: map.get(day)! }));
}

// 회원 행 배지/버튼에 쓰는 상태 4종 — 시트 "납부확인" 값(FineStatus: 납부/
// 미납/면제)에 "직권 P"(아직 실제 처리와 연결되지 않은 자리표시자, 강제퇴실
// 트리거)를 더한 것.
type FineAction = FineStatus | "직권 P";
const ALL_FINE_ACTIONS: FineAction[] = ["납부", "미납", "면제", "직권 P"];

// 요일 헤더 배지, 회원 행 배지가 공유하는 색상 규칙 — §3.1(제보 확인)의
// 대기(destructive)/적용(ok)/반려(amber)와 동일한 위계.
const FINE_BADGE_TONE: Record<FineAction, "ok" | "warn" | "amber" | "primary"> = {
  납부: "ok",
  미납: "warn",
  면제: "amber",
  "직권 P": "primary",
};

// 일간집계(daily_calc)가 벌금이 발생한 날 기본으로 "미납"을 세팅해두면,
// 그때부터 이 화면이 "처리를 기다리는 대상자" 목록이 된다(사용자 설명) —
// 그래서 목록 자체는 /admin/fines/unpaid(미납 항목)를 기준으로 삼는다.
// /admin/fines/paid·/admin/fines/exempt는 이미 처리 완료된 항목의 요일별
// 개수(+납부 총액)만 참고용으로 함께 가져와 요일 헤더 배지에 반영한다.
function PaidFineList({ isVisible }: { isVisible: boolean }) {
  const { call } = useApi();
  const TODAY_INDEX = useTodayIndex();

  const [unpaid, setUnpaid] = useState<UnpaidFine[] | null>(null);
  const [totalAmount, setTotalAmount] = useState(0);
  const [paidByDay, setPaidByDay] = useState<Map<string, number>>(new Map());
  const [exemptByDay, setExemptByDay] = useState<Map<string, number>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  // 항목별로 이 세션에서 방금 바꾼 상태 — §3.1(제보 확인)의 applied/rejected와
  // 동일한 패턴으로, 상태를 바꿔도 목록에서 항목을 지우지 않고 그 자리에
  // 남겨 배지만 바꾼다(사용자 지적: "제보 확인"처럼 계속 보이면서 배지만
  // 바뀌길 원함).
  const [statusOverride, setStatusOverride] = useState<Record<string, FineStatus>>({});
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [dayDetail, setDayDetail] = useState<Record<string, StatusResponse | "loading" | "error">>({});

  function countByDay<T extends { day: string }>(items: T[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const item of items) map.set(item.day, (map.get(item.day) || 0) + 1);
    return map;
  }

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([
      call<AdminFinesUnpaidResponse>("/admin/fines/unpaid"),
      call<AdminFinesPaidResponse>("/admin/fines/paid"),
      call<AdminFinesExemptResponse>("/admin/fines/exempt"),
    ])
      .then(([unpaidData, paidData, exemptData]) => {
        setUnpaid(unpaidData.unpaid || []);
        setTotalAmount(paidData.totalAmount || 0);
        setPaidByDay(countByDay(paidData.paid || []));
        setExemptByDay(countByDay(exemptData.exempt || []));
        setStatusOverride({});
      })
      .catch((err) => setError(err instanceof Error ? err.message : "벌금 납부 대상자 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 이 탭(MEM·PEN)에서 퇴실/재납 처리를 하면 벌금 상태가 바뀔 수 있어,
  // Money 탭으로 돌아올 때마다 새로 불러온다.
  useRefreshOnVisible(isVisible, load);

  async function handleSetStatus(f: UnpaidFine, status: FineStatus) {
    const key = fineKey(f);
    setPendingKey(key);
    setError(null);
    try {
      await call<SetFineStatusResponse>("/admin/fines/status", {
        method: "POST",
        body: { number: f.number, day: f.day, status },
      });
      setStatusOverride((prev) => ({ ...prev, [key]: status }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "납부 상태 변경에 실패했습니다.");
    } finally {
      setPendingKey(null);
    }
  }

  function toggleMember(f: UnpaidFine) {
    const key = fineKey(f);
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(key);
    if (!dayDetail[f.number]) {
      setDayDetail((prev) => ({ ...prev, [f.number]: "loading" }));
      call<StatusResponse>(`/admin/members/${encodeURIComponent(f.number)}`)
        .then((data) => setDayDetail((prev) => ({ ...prev, [f.number]: data })))
        .catch(() => setDayDetail((prev) => ({ ...prev, [f.number]: "error" })));
    }
  }

  // 이 목록은 애초에 "미납" 항목만 불러오므로, 아직 아무것도 안 바꿨다면
  // 기본 상태는 "미납"이다 — 관리자가 버튼을 눌러야만 다른 상태로 바뀐다.
  function effectiveStatus(f: UnpaidFine): FineStatus {
    return statusOverride[fineKey(f)] ?? "미납";
  }

  // 목록 원본(unpaid)은 그대로 유지하고(항목을 지우지 않음), 로컬에서 상태를
  // 바꾼 항목만 배지가 바뀐 채로 계속 보인다.
  const groups = groupByDay(unpaid || []);

  return (
    <Collapsible defaultOpen className="flex flex-col gap-4">
      <SectionHeader icon={CircleDollarSign} title="벌금 납부 대상자 처리" loading={loading} onRefresh={load} />
      <div className="h-px w-full bg-border" />
      <CollapsiblePanel className="flex flex-col gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <InfoCard className="flex items-center justify-between gap-2">
        <FieldLabel>납부된 총 벌금액</FieldLabel>
        <span className="font-mono text-base font-bold tabular-nums text-ok sm:text-lg">{won(totalAmount)}</span>
      </InfoCard>

      {loading && !unpaid && (
        <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">불러오는 중...</p>
      )}

      {!loading && unpaid && groups.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">처리 대상이 없습니다.</p>
      )}

      {groups.length > 0 && (
        <div className="flex flex-col gap-2 sm:gap-2.5">
          {groups.map((group) => {
            const isDayExpanded = expandedDay === group.day;
            // 로컬에서 상태를 바꾼 항목만큼 그날의 납부/미납/면제 배지 숫자를
            // 실시간으로 보정한다 — 서버 값(paidByDay/exemptByDay)은 이 화면을
            // 처음 열었을 때 기준이라, 그 사이 이 세션에서 직접 바꾼 항목은
            // 반영되어 있지 않다.
            const unpaidCount = group.members.filter((f) => effectiveStatus(f) === "미납").length;
            const movedToPaid = group.members.filter((f) => effectiveStatus(f) === "납부").length;
            const movedToExempt = group.members.filter((f) => effectiveStatus(f) === "면제").length;
            const paidCount = (paidByDay.get(group.day) || 0) + movedToPaid;
            const exemptCount = (exemptByDay.get(group.day) || 0) + movedToExempt;
            return (
              <InfoCard key={group.day} className="flex flex-col gap-2.5">
                <button
                  type="button"
                  onClick={() => setExpandedDay(isDayExpanded ? null : group.day)}
                  className="flex items-center justify-between gap-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded"
                >
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="inline-flex shrink-0 items-center gap-1.25 text-xs font-semibold text-muted-foreground sm:text-sm">
                      <CalendarDays className="size-3 shrink-0 sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                      {thisWeekDateLabel(group.day)} {group.day}요일
                    </span>
                    <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
                      <span className="rounded-full bg-ok/15 px-2 py-1 text-micro-lg leading-none font-semibold text-ok sm:text-xs">
                        납부 : {paidCount}건
                      </span>
                      <span className="rounded-full bg-destructive/15 px-2 py-1 text-micro-lg leading-none font-semibold text-destructive sm:text-xs">
                        미납 : {unpaidCount}건
                      </span>
                      <span className="rounded-full bg-amber-600/15 px-2 py-1 text-micro-lg leading-none font-semibold text-amber-600 sm:text-xs dark:bg-amber-400/15 dark:text-amber-400">
                        면제 : {exemptCount}건
                      </span>
                      {/* 🧪 [자리표시자] "직권 P" 인원을 어떤 기준으로 셀지는
                          아직 정해지지 않았다 — 배지 자리와 스타일만 먼저
                          만들어두고 집계 로직은 추후 반영 예정. */}
                      <span className="rounded-full bg-primary/15 px-2 py-1 text-micro-lg leading-none font-semibold text-primary sm:text-xs">
                        직권 P : 0건
                      </span>
                    </span>
                  </span>
                  <ChevronDown
                    className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isDayExpanded && "rotate-180")}
                    strokeWidth={ICON_STROKE.default}
                  />
                </button>

                {isDayExpanded && (
                  <div className="flex flex-col gap-2.5">
                    {group.members.map((f) => {
                      const key = fineKey(f);
                      const isPending = pendingKey === key;
                      const isMemberExpanded = expandedKey === key;
                      const detail = dayDetail[f.number];
                      const dayIndex = STATUS_DAYS.indexOf(f.day);
                      const day =
                        detail && detail !== "loading" && detail !== "error" ? detail.days[dayIndex] : null;

                      const status = effectiveStatus(f);
                      // 뱃지는 지금 상태 하나만, 버튼은 지금 상태를 뺀 나머지
                      // 선택지만 보여준다(사용자 설명) — 이미 그 상태인데 같은
                      // 버튼을 또 누르는 무의미한 액션을 없앤다.
                      const otherActions = ALL_FINE_ACTIONS.filter((a) => a !== status);

                      return (
                        <div key={key} className="flex flex-col gap-2.5 rounded-lg border bg-card p-3">
                          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                            <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                              <User className="size-3 shrink-0 text-muted-foreground sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                              {f.name}
                            </span>
                            <div className="flex items-center gap-1.5">
                              <TintedPill tone={FINE_BADGE_TONE[status]}>{status}</TintedPill>
                              <Button
                                variant="outline"
                                size="icon-sm"
                                onClick={() => toggleMember(f)}
                                aria-label={isMemberExpanded ? "상세 접기" : "상세 펼치기"}
                              >
                                <ChevronDown
                                  className={cn("size-3.5 transition-transform", isMemberExpanded && "rotate-180")}
                                  strokeWidth={ICON_STROKE.default}
                                />
                              </Button>
                            </div>
                          </div>

                          {isMemberExpanded && (
                            <>
                              {detail === "loading" && (
                                <p className="py-4 text-center text-sm text-muted-foreground">불러오는 중...</p>
                              )}
                              {detail === "error" && (
                                <p className="py-4 text-center text-sm text-destructive">정보를 불러오지 못했습니다.</p>
                              )}
                              {day && detail && detail !== "loading" && detail !== "error" && (
                                <DayDetailCard
                                  day={day}
                                  isPast={STATUS_DAYS.indexOf(f.day) < TODAY_INDEX}
                                  depositRefundBreakdown={detail.depositRefundBreakdown}
                                  showStatusBadges={false}
                                />
                              )}
                              {/* "일간 총 벌금 · 재납 예치금" 바로 아래 —
                                  DayDetailCard의 마지막 섹션이라 그 카드
                                  바깥(아래)에 놓으면 시각적으로 그 자리다. */}
                              <div className="grid grid-cols-2 gap-2">
                                {otherActions.map((action) =>
                                  action === "직권 P" ? (
                                    // 🧪 [자리표시자] 헤더의 "직권 P" 배지와
                                    // 동일하게 아직 실제 동작(강제퇴실 처리
                                    // 트리거 등)이 연결되어 있지 않다.
                                    <Button key={action} variant="outline" disabled className="w-full sm:h-11">
                                      직권 P
                                    </Button>
                                  ) : (
                                    <Button
                                      key={action}
                                      variant="outline"
                                      disabled={isPending}
                                      onClick={() => handleSetStatus(f, action)}
                                      className="w-full sm:h-11"
                                    >
                                      {action}
                                    </Button>
                                  )
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
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

export function AdminMoneyTab({ visible }: { visible: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <SectionCard>
        <PaidFineList isVisible={visible} />
      </SectionCard>
    </div>
  );
}
