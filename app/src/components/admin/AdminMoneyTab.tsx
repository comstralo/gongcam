import { useEffect, useState } from "react";
import { ChevronDown, CircleDollarSign, CalendarDays, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { InfoCard, DayDetailCard } from "@/components/dashboard/shared";
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
  PaidFine,
  StatusResponse,
} from "@/lib/api/types";

const STATUS_DAYS = ["월", "화", "수", "목", "금", "토", "일"];

function fineKey(f: Pick<PaidFine, "number" | "day">) {
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

// 납부 대상자 목록은 이미 납부된 항목만 다루므로 "납부" 버튼은 불필요하다.
const FINE_UNDO_PAID_OPTIONS: Exclude<FineStatus, "납부">[] = ["미납", "면제"];

function PaidFineList({ isVisible }: { isVisible: boolean }) {
  const { call } = useApi();
  const TODAY_INDEX = useTodayIndex();

  const [paid, setPaid] = useState<PaidFine[] | null>(null);
  const [totalAmount, setTotalAmount] = useState(0);
  // 이 목록 자체는 여전히 "납부" 항목만 다루지만(펼치면 미납/면제로 되돌리는
  // 액션만 있음), 요일 헤더 배지에는 그날의 미납/면제 인원수도 함께 참고용으로
  // 보여준다 — 그 두 상태를 따로 조회해 개수만 센다(개별 항목을 이 목록에서
  // 펼쳐보거나 조작할 수 있게 하려는 게 아니라, §3.1(제보 확인)과 동일한
  // "대기/적용/반려" 3배지 위계를 맞추기 위한 참고 정보다).
  const [unpaidByDay, setUnpaidByDay] = useState<Map<string, number>>(new Map());
  const [exemptByDay, setExemptByDay] = useState<Map<string, number>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [resolvedKeys, setResolvedKeys] = useState<Set<string>>(new Set());
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
      call<AdminFinesPaidResponse>("/admin/fines/paid"),
      call<AdminFinesUnpaidResponse>("/admin/fines/unpaid"),
      call<AdminFinesExemptResponse>("/admin/fines/exempt"),
    ])
      .then(([paidData, unpaidData, exemptData]) => {
        setPaid(paidData.paid || []);
        setTotalAmount(paidData.totalAmount || 0);
        setUnpaidByDay(countByDay(unpaidData.unpaid || []));
        setExemptByDay(countByDay(exemptData.exempt || []));
        setResolvedKeys(new Set());
      })
      .catch((err) => setError(err instanceof Error ? err.message : "벌금 납부 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 이 탭(MEM·PEN)에서 퇴실/재납 처리를 하면 벌금 상태가 바뀔 수 있어,
  // Money 탭으로 돌아올 때마다 새로 불러온다.
  useRefreshOnVisible(isVisible, load);

  async function handleSetStatus(f: PaidFine, status: FineStatus) {
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

  function toggleMember(f: PaidFine) {
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

  const visible = (paid || []).filter((f) => !resolvedKeys.has(fineKey(f)));
  const groups = groupByDay(visible);

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

      {loading && !paid && (
        <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">불러오는 중...</p>
      )}

      {!loading && paid && groups.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">납부 항목이 없습니다.</p>
      )}

      {groups.length > 0 && (
        <div className="flex flex-col gap-2 sm:gap-2.5">
          {groups.map((group) => {
            const isDayExpanded = expandedDay === group.day;
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
                        납부 : {group.members.length}건
                      </span>
                      <span className="rounded-full bg-destructive/15 px-2 py-1 text-micro-lg leading-none font-semibold text-destructive sm:text-xs">
                        미납 : {unpaidByDay.get(group.day) || 0}건
                      </span>
                      <span className="rounded-full bg-amber-600/15 px-2 py-1 text-micro-lg leading-none font-semibold text-amber-600 sm:text-xs dark:bg-amber-400/15 dark:text-amber-400">
                        면제 : {exemptByDay.get(group.day) || 0}건
                      </span>
                      {/* 🧪 [자리표시자] "강퇴" 인원을 어떤 기준으로 셀지(예:
                          그날 미납으로 인한 강제퇴실 조건 해당자 vs 이미
                          처리 확정된 강제퇴실자 전체)는 아직 정해지지
                          않았다 — 배지 자리와 스타일만 먼저 만들어두고
                          집계 로직은 추후 반영 예정. */}
                      <span className="rounded-full bg-primary/15 px-2 py-1 text-micro-lg leading-none font-semibold text-primary sm:text-xs">
                        강퇴 : 0건
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

                      return (
                        <div key={key} className="flex flex-col gap-2.5 rounded-lg border bg-card p-3">
                          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                            <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                              <User className="size-3 shrink-0 text-muted-foreground sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                              {f.name}
                            </span>
                            <div className="flex items-center gap-1.5">
                              {FINE_UNDO_PAID_OPTIONS.map((status) => (
                                <Button
                                  key={status}
                                  size="sm"
                                  variant="outline"
                                  disabled={isPending}
                                  onClick={() => handleSetStatus(f, status)}
                                  className="flex-1 sm:flex-none"
                                >
                                  {status}
                                </Button>
                              ))}
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
                                  dayLabel={`${f.day}요일`}
                                  isPast={STATUS_DAYS.indexOf(f.day) < TODAY_INDEX}
                                  depositRefundBreakdown={detail.depositRefundBreakdown}
                                />
                              )}
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
