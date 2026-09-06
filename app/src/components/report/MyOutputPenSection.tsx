import { useEffect, useState } from "react";
import { ListChecks, ChevronDown, CalendarDays, User, Image as ImageIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { InfoCard, SubRow } from "@/components/dashboard/shared";
import { SectionHeader, SectionCard, CapturePreview, AdminListSkeleton } from "@/components/admin/shared";
import { useApi } from "@/hooks/useApi";
import { useRefreshOnVisible } from "@/hooks/useRefreshOnVisible";
import { useAuth } from "@/lib/auth/useAuth";
import { ICON_STROKE, cn } from "@/lib/utils";
import type { MyCaptureItem, MyCapturesResponse } from "@/lib/api/types";

const STATUS_DAYS = ["월", "화", "수", "목", "금", "토", "일"];

// "송출 P 대상 처리"(관리자용 ReportReviewList)와 동일한 요일별 아코디언 →
// 항목별 토글 → 캡처 미리보기 구조를 재활용한다(사용자 지시) — 다만 "내
// 화각 점검"은 벌점/페널티 판정 대상이 아니라 승인/반려/투표/시간차감 등
// 관리자 전용 조작은 전부 뺀 읽기 전용 버전이다.
function dayOfTs(ts: number): string {
  const jsDay = new Date(ts).getDay();
  return STATUS_DAYS[(jsDay + 6) % 7];
}

function thisWeekDateLabel(dayKr: string): string {
  const dayIndex = STATUS_DAYS.indexOf(dayKr);
  if (dayIndex === -1) return "";
  const now = new Date();
  const todayIndex = (now.getDay() + 6) % 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - todayIndex);
  const target = new Date(monday);
  target.setDate(monday.getDate() + dayIndex);
  return `${target.getMonth() + 1}월 ${target.getDate()}일`;
}

function groupByDay(items: MyCaptureItem[]) {
  const map = new Map<string, MyCaptureItem[]>();
  for (const item of items) {
    const day = dayOfTs(item.ts);
    const existing = map.get(day);
    if (existing) existing.push(item);
    else map.set(day, [item]);
  }
  return STATUS_DAYS.filter((d) => map.has(d)).map((day) => ({ day, items: map.get(day)! }));
}

export function MyOutputPenSection({ refreshSignal }: { refreshSignal?: number }) {
  const { call } = useApi();
  const { session } = useAuth();

  const [items, setItems] = useState<MyCaptureItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    call<MyCapturesResponse>("/my-captures")
      .then((data) => setItems(data.items || []))
      .catch((err) => setError(err instanceof Error ? err.message : "제보 확인 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  useRefreshOnVisible(true, load);
  useEffect(() => {
    if (refreshSignal) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  return (
    <SectionCard>
      <Collapsible defaultOpen className="flex flex-col gap-4">
        <SectionHeader icon={ListChecks} title="내 송출 P 제보 확인" loading={loading} onRefresh={load} />
        <CollapsiblePanel className="flex flex-col gap-4">
          <div className="h-px w-full bg-border" />
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {loading && !items && <AdminListSkeleton />}

          {!loading && items && items.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">
              실행한 내 화각 점검이 없습니다.
            </p>
          )}

          {items && items.length > 0 && (
            <div className="flex flex-col gap-2 sm:gap-2.5">
              {groupByDay(items).map((group) => {
                const isDayExpanded = expandedDay === group.day;
                return (
                  <InfoCard key={group.day} className="flex flex-col gap-2.5 bg-card">
                    <button
                      type="button"
                      onClick={() => setExpandedDay(isDayExpanded ? null : group.day)}
                      className="flex items-center justify-between gap-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded"
                    >
                      <span className="inline-flex shrink-0 items-center gap-1.25 text-xs font-semibold sm:text-sm">
                        <CalendarDays className="size-3 shrink-0 text-muted-foreground sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                        {thisWeekDateLabel(group.day)} {group.day}요일
                        <span className="ml-1 rounded-full bg-foreground/8 px-2 py-1 text-micro-lg leading-none text-muted-foreground sm:text-xs">
                          {group.items.length}건
                        </span>
                      </span>
                      <ChevronDown
                        className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isDayExpanded && "rotate-180")}
                        strokeWidth={ICON_STROKE.default}
                      />
                    </button>

                    {isDayExpanded && (
                      <div className="flex flex-col gap-2.5">
                        {group.items.map((item) => {
                          const isItemExpanded = expandedId === item.id;
                          return (
                            <div key={item.id} className="flex flex-col gap-2.5 rounded-lg border bg-card p-3">
                              <div className="flex items-center justify-between gap-2">
                                <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                                  <User className="size-3 shrink-0 text-muted-foreground sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                                  {new Date(item.ts).toLocaleString("ko-KR")}
                                </span>
                                <Button
                                  variant="outline"
                                  size="icon-sm"
                                  onClick={() => setExpandedId(isItemExpanded ? null : item.id)}
                                  aria-label={isItemExpanded ? "상세 접기" : "상세 펼치기"}
                                >
                                  <ChevronDown
                                    className={cn("size-3.5 transition-transform", isItemExpanded && "rotate-180")}
                                    strokeWidth={ICON_STROKE.default}
                                  />
                                </Button>
                              </div>

                              {isItemExpanded && (
                                <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:gap-3.5 sm:p-5">
                                  <div className="flex flex-col gap-1.5">
                                    <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                                      <ImageIcon className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                      캡처 내용
                                    </span>
                                    {session?.token ? (
                                      <CapturePreview id={item.id} token={session.token} />
                                    ) : (
                                      <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed bg-muted">
                                        <p className="text-xs text-muted-foreground sm:text-sm">
                                          미리보기를 불러오지 못했습니다.
                                        </p>
                                      </div>
                                    )}
                                  </div>
                                  <div className="h-px w-full bg-border" />
                                  <SubRow label="발생일시" value={new Date(item.ts).toLocaleString("ko-KR")} />
                                </div>
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
    </SectionCard>
  );
}
