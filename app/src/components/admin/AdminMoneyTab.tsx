import { useEffect, useState } from "react";
import { Wallet, ChevronDown, CircleDollarSign, BadgePercent } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { InfoCard, DayDetailCard } from "@/components/dashboard/shared";
import { SectionHeader, ItemTitle, FieldLabel, SectionCard } from "@/components/admin/shared";
import { useApi } from "@/hooks/useApi";
import { useRefreshOnVisible } from "@/hooks/useRefreshOnVisible";
import { useTodayIndex } from "@/hooks/useTodayIndex";
import { ApiError } from "@/lib/api/client";
import { ICON_STROKE, cn } from "@/lib/utils";
import type {
  AdminFinesUnpaidResponse,
  AdminFinesPaidResponse,
  AdminFinesExemptResponse,
  FineStatus,
  SetFineStatusResponse,
  UnpaidFine,
  PaidFine,
  ExemptFine,
  StatusResponse,
} from "@/lib/api/types";

// 미납 현황 목록은 이미 미납 상태인 항목만 다루므로 "미납" 버튼은 불필요하다.
const FINE_RESOLVE_OPTIONS: Exclude<FineStatus, "미납">[] = ["납부", "면제"];
// 면제 현황 목록은 이미 면제된 항목이므로 "면제" 버튼은 불필요하다.
const FINE_REVERT_OPTIONS: Exclude<FineStatus, "면제">[] = ["납부", "미납"];
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

// 납부 현황은 이미 납부된 항목만 다루므로 "납부" 버튼은 불필요하다.
const FINE_UNDO_PAID_OPTIONS: Exclude<FineStatus, "납부">[] = ["미납", "면제"];

function PaidFineList({
  refreshToken,
  onResolved,
  isVisible,
}: {
  refreshToken?: number;
  onResolved?: (status: FineStatus) => void;
  isVisible: boolean;
}) {
  const { call } = useApi();
  const TODAY_INDEX = useTodayIndex();

  const [paid, setPaid] = useState<PaidFine[] | null>(null);
  const [totalAmount, setTotalAmount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [resolvedKeys, setResolvedKeys] = useState<Set<string>>(new Set());
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [dayDetail, setDayDetail] = useState<Record<string, StatusResponse | "loading" | "error">>({});

  function load() {
    setLoading(true);
    setError(null);
    call<AdminFinesPaidResponse>("/admin/fines/paid")
      .then((data) => {
        setPaid(data.paid || []);
        setTotalAmount(data.totalAmount || 0);
        setResolvedKeys(new Set());
      })
      .catch((err) => setError(err instanceof Error ? err.message : "벌금 납부 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, [refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps
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
      onResolved?.(status);
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
      <SectionHeader icon={CircleDollarSign} title="벌금 납부 현황" loading={loading} onRefresh={load} />
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
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-sm font-bold sm:text-base">
                      {thisWeekDateLabel(group.day)} {group.day}요일
                    </span>
                    <span className="text-xs text-muted-foreground sm:text-sm">{group.members.length}명</span>
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
                            <ItemTitle>{f.name}</ItemTitle>
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

function FineList({
  refreshToken,
  onResolved,
  isVisible,
}: {
  refreshToken?: number;
  onResolved?: (status: FineStatus) => void;
  isVisible: boolean;
}) {
  const { call } = useApi();
  const TODAY_INDEX = useTodayIndex();

  const [unpaid, setUnpaid] = useState<UnpaidFine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [resolvedKeys, setResolvedKeys] = useState<Set<string>>(new Set());
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [dayDetail, setDayDetail] = useState<Record<string, StatusResponse | "loading" | "error">>({});

  function load() {
    setLoading(true);
    setError(null);
    call<AdminFinesUnpaidResponse>("/admin/fines/unpaid")
      .then((data) => {
        setUnpaid(data.unpaid || []);
        setResolvedKeys(new Set());
      })
      .catch((err) => setError(err instanceof Error ? err.message : "벌금 미납 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, [refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps
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
      setResolvedKeys((prev) => new Set(prev).add(key));
      onResolved?.(status);
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

  const visible = (unpaid || []).filter((f) => !resolvedKeys.has(fineKey(f)));
  const groups = groupByDay(visible);

  return (
    <Collapsible defaultOpen className="flex flex-col gap-4">
      <SectionHeader icon={Wallet} title="벌금 미납 현황" loading={loading} onRefresh={load} />
      <div className="h-px w-full bg-border" />
      <CollapsiblePanel className="flex flex-col gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && !unpaid && (
        <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">불러오는 중...</p>
      )}

      {!loading && unpaid && groups.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">미납 항목이 없습니다.</p>
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
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-sm font-bold sm:text-base">
                      {thisWeekDateLabel(group.day)} {group.day}요일
                    </span>
                    <span className="text-xs text-muted-foreground sm:text-sm">{group.members.length}명</span>
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
                            <ItemTitle>{f.name}</ItemTitle>
                            <div className="flex items-center gap-1.5">
                              {FINE_RESOLVE_OPTIONS.map((status) => (
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
                              {/* 강제퇴실 처리 — 아직 미구현, 버튼만 우선 배치 */}
                              <Button size="sm" variant="outline" disabled className="flex-1 sm:flex-none">
                                직권 P
                              </Button>
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

function ExemptFineList({
  refreshToken,
  onResolved,
  isVisible,
}: {
  refreshToken?: number;
  onResolved?: (status: FineStatus) => void;
  isVisible: boolean;
}) {
  const { call } = useApi();
  const TODAY_INDEX = useTodayIndex();

  const [exempt, setExempt] = useState<ExemptFine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [resolvedKeys, setResolvedKeys] = useState<Set<string>>(new Set());
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [dayDetail, setDayDetail] = useState<Record<string, StatusResponse | "loading" | "error">>({});

  function load() {
    setLoading(true);
    setError(null);
    call<AdminFinesExemptResponse>("/admin/fines/exempt")
      .then((data) => {
        setExempt(data.exempt || []);
        setResolvedKeys(new Set());
      })
      .catch((err) => setError(err instanceof Error ? err.message : "벌금 면제 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, [refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps
  useRefreshOnVisible(isVisible, load);

  async function handleSetStatus(f: ExemptFine, status: FineStatus) {
    const key = fineKey(f);
    setPendingKey(key);
    setError(null);
    try {
      await call<SetFineStatusResponse>("/admin/fines/status", {
        method: "POST",
        body: { number: f.number, day: f.day, status },
      });
      setResolvedKeys((prev) => new Set(prev).add(key));
      onResolved?.(status);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "납부 상태 변경에 실패했습니다.");
    } finally {
      setPendingKey(null);
    }
  }

  function toggleMember(f: ExemptFine) {
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

  const visible = (exempt || []).filter((f) => !resolvedKeys.has(fineKey(f)));
  const groups = groupByDay(visible);

  return (
    <Collapsible defaultOpen className="flex flex-col gap-4">
      <SectionHeader icon={BadgePercent} title="벌금 면제 현황" loading={loading} onRefresh={load} />
      <div className="h-px w-full bg-border" />
      <CollapsiblePanel className="flex flex-col gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && !exempt && (
        <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">불러오는 중...</p>
      )}

      {!loading && exempt && groups.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">면제 항목이 없습니다.</p>
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
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-sm font-bold sm:text-base">
                      {thisWeekDateLabel(group.day)} {group.day}요일
                    </span>
                    <span className="text-xs text-muted-foreground sm:text-sm">{group.members.length}명</span>
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
                            <ItemTitle>{f.name}</ItemTitle>
                            <div className="flex items-center gap-1.5">
                              {FINE_REVERT_OPTIONS.map((status) => (
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
  // 세 현황(납부/미납/면제) 중 어느 하나에서 상태를 바꾸면, 그 값이 향하는
  // 다른 현황이 즉시 새 항목을 반영하도록 재조회를 트리거한다.
  const [paidRefresh, setPaidRefresh] = useState(0);
  const [unpaidRefresh, setUnpaidRefresh] = useState(0);
  const [exemptRefresh, setExemptRefresh] = useState(0);

  function handleFineResolved(status: FineStatus) {
    if (status === "납부") setPaidRefresh((n) => n + 1);
    if (status === "미납") setUnpaidRefresh((n) => n + 1);
    if (status === "면제") setExemptRefresh((n) => n + 1);
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionCard>
        <PaidFineList refreshToken={paidRefresh} onResolved={handleFineResolved} isVisible={visible} />
      </SectionCard>
      <SectionCard>
        <FineList refreshToken={unpaidRefresh} onResolved={handleFineResolved} isVisible={visible} />
      </SectionCard>
      <SectionCard>
        <ExemptFineList refreshToken={exemptRefresh} onResolved={handleFineResolved} isVisible={visible} />
      </SectionCard>
    </div>
  );
}
