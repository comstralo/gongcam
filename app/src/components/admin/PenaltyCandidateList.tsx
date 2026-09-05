import { useEffect, useState } from "react";
import { ShieldAlert, ChevronDown, CalendarDays, User, Radio, CalendarClock } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { InfoCard, TintedPill } from "@/components/dashboard/shared";
import { SectionHeader, PenaltyHistorySection, AdminListSkeleton } from "@/components/admin/shared";
import { ExitProcessDialog } from "@/components/admin/ExitProcessDialog";
import { useApi } from "@/hooks/useApi";
import { useRefreshOnVisible } from "@/hooks/useRefreshOnVisible";
import { useAuth } from "@/lib/auth/useAuth";
import { ICON_STROKE, cn } from "@/lib/utils";
import type { AdminExitCandidatesResponse, ExitCandidate, ExitKind } from "@/lib/api/types";

const STATUS_DAYS = ["월", "화", "수", "목", "금", "토", "일"];
const UNKNOWN_DAY = "요일 미확인";

// 송출 P 슬롯 차수(1~6차)를 실제 조치명으로 바꾼다 — "송출 P 제보 확인"의
// actionLabel과 동일 기준(1차 구두경고, 2/3/5차 벌점, 4/6차 페널티)이지만
// 여기서는 이미 확정된 이력을 나열하는 것이라 조치별로 별도 차수를 매긴다.
// "N차"는 괄호로 묶어 조치명과 구분한다.
const OUTPUT_PEN_SLOT_LABELS = [
  "구두경고 (1차)",
  "벌점 (1차)",
  "벌점 (2차)",
  "페널티 (1차)",
  "벌점 (3차)",
  "페널티 (2차)",
];

// 오늘 날짜 기준 이번 주(월~일)의 각 요일 실제 날짜를 "8월 19일" 형태로
// 계산한다(벌금 미납 현황 · 송출 P 제보 확인과 동일 패턴).
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

// 페널티 2회 달성 시점(occurredDay)의 요일로 그룹핑한다. 슬롯 주석이 없어
// 요일을 알 수 없는 회원은 "요일 미확인" 그룹으로 따로 모은다.
function groupByDay(candidates: ExitCandidate[]) {
  const map = new Map<string, ExitCandidate[]>();
  for (const c of candidates) {
    const day = c.occurredDay || UNKNOWN_DAY;
    const existing = map.get(day);
    if (existing) existing.push(c);
    else map.set(day, [c]);
  }
  const ordered = STATUS_DAYS.filter((d) => map.has(d)).map((day) => ({ day, items: map.get(day)! }));
  if (map.has(UNKNOWN_DAY)) ordered.push({ day: UNKNOWN_DAY, items: map.get(UNKNOWN_DAY)! });
  return ordered;
}

// PENALTY 탭의 "예치금 재납 대상자" — 페널티 누적 2 이상인 회원만 다룬다. 이제
// 페널티 2회 이상은 강제 퇴실자 조건 중 하나라 반환율이 항상 0%로 고정되며,
// 유형 선택 없이 강제 퇴실자로 곧바로 확정할 수 있다(lockKind="forced").
// "송출 P 제보 확인"과 동일하게 요일별 아코디언 → 인원별 토글 구조로 맞춘다.
export function PenaltyCandidateList({ visible }: { visible: boolean }) {
  const { call } = useApi();
  const { session } = useAuth();

  const [candidates, setCandidates] = useState<ExitCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [expandedNumber, setExpandedNumber] = useState<string | null>(null);
  // 처리 확정된 회원은 다음 새로고침 때 서버 목록(처리된 회원은 partiStatus가
  // 바뀌어 자연히 후보에서 빠짐)에서 사라지므로, 이 세션에서 방금 처리한
  // 결과("강퇴"/"재납")를 화면 상태로 기억해 뱃지로만 바꿔 그 자리에 남긴다
  // ("송출 P 제보 확인"과 동일한 패턴 — 사용자 요청으로 디자인 통일).
  const [processed, setProcessed] = useState<Record<string, ExitKind>>({});

  function load() {
    setLoading(true);
    setError(null);
    call<AdminExitCandidatesResponse>("/admin/exit/candidates")
      .then((data) => setCandidates(data.candidates || []))
      .catch((err) => setError(err instanceof Error ? err.message : "예치금 재납 대상 처리 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 다른 회원의 페널티 누적이 탭을 벗어난 사이에도 바뀔 수 있어, 돌아올
  // 때마다 새로 불러와야 최신 대상자를 놓치지 않는다.
  useRefreshOnVisible(visible, load);

  return (
    <Collapsible defaultOpen className="flex flex-col gap-4">
      <SectionHeader icon={ShieldAlert} title="예치금 재납 대상 처리" loading={loading} onRefresh={load} />
      <CollapsiblePanel className="flex flex-col gap-4">
        <div className="h-px w-full bg-border" />
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading && !candidates && <AdminListSkeleton />}

        {!loading && candidates && candidates.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">처리 대상이 없습니다.</p>
        )}

        {candidates && candidates.length > 0 && (
          <div className="flex flex-col gap-2 sm:gap-2.5">
            {groupByDay(candidates).map((group) => {
              const isDayExpanded = expandedDay === group.day;
              const isUnknown = group.day === UNKNOWN_DAY;
              const forcedCount = group.items.filter((c) => processed[c.number] === "forced").length;
              const depositCount = group.items.filter((c) => processed[c.number] === "deposit_again").length;
              const waitingCount = group.items.length - forcedCount - depositCount;
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
                        {isUnknown ? group.day : `${thisWeekDateLabel(group.day)} ${group.day}요일`}
                      </span>
                      <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
                        <span className="rounded-full bg-destructive/15 px-2 py-1 text-micro-lg leading-none sm:text-xs font-semibold text-destructive">
                          대기 : {waitingCount}건
                        </span>
                        <span className="rounded-full bg-ok/15 px-2 py-1 text-micro-lg leading-none sm:text-xs font-semibold text-ok">
                          재납 : {depositCount}건
                        </span>
                        <span className="rounded-full bg-amber-600/15 px-2 py-1 text-micro-lg leading-none sm:text-xs font-semibold text-amber-600 dark:bg-amber-400/15 dark:text-amber-400">
                          강퇴 : {forcedCount}건
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
                      {group.items.map((c) => {
                        const isMemberExpanded = expandedNumber === c.number;
                        const decidedKind = processed[c.number];
                        return (
                          <div key={c.number} className="flex flex-col gap-2.5 rounded-lg border bg-card p-3">
                            <div className="flex items-center justify-between gap-2">
                              <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                                <User className="size-3 shrink-0 text-muted-foreground sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                                {c.name}
                              </span>
                              <div className="flex items-center gap-1.5">
                                {decidedKind === "forced" ? (
                                  <TintedPill tone="amber">강퇴</TintedPill>
                                ) : decidedKind === "deposit_again" ? (
                                  <TintedPill tone="ok">재납</TintedPill>
                                ) : (
                                  <TintedPill tone="warn">대기</TintedPill>
                                )}
                                <Button
                                  variant="outline"
                                  size="icon-sm"
                                  onClick={() => setExpandedNumber(isMemberExpanded ? null : c.number)}
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
                                <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:gap-3.5 sm:p-5">
                                  <PenaltyHistorySection
                                    icon={Radio}
                                    title="송출 P 원인"
                                    history={c.outputPenHistory}
                                    slotLabels={OUTPUT_PEN_SLOT_LABELS}
                                    token={session?.token}
                                  />
                                  <div className="h-px w-full bg-border" />
                                  <PenaltyHistorySection
                                    icon={CalendarClock}
                                    title="주간 P 원인"
                                    history={c.timePenHistory}
                                    token={session?.token}
                                  />
                                </div>

                                {decidedKind ? (
                                  <p className="text-center text-xs text-muted-foreground sm:text-sm">
                                    이미 처리된 대상입니다.
                                  </p>
                                ) : (
                                  <div className="grid grid-cols-2 gap-2">
                                    <ExitProcessDialog
                                      candidate={c}
                                      onConfirmed={(kind) => setProcessed((prev) => ({ ...prev, [c.number]: kind }))}
                                      lockKind="forced"
                                    >
                                      <Button variant="destructive" className="w-full sm:h-12 sm:text-base">
                                        강제퇴실자 처리
                                      </Button>
                                    </ExitProcessDialog>
                                    <ExitProcessDialog
                                      candidate={c}
                                      onConfirmed={(kind) => setProcessed((prev) => ({ ...prev, [c.number]: kind }))}
                                      lockKind="deposit_again"
                                    >
                                      <Button variant="destructive" className="w-full sm:h-12 sm:text-base">
                                        재납자 처리
                                      </Button>
                                    </ExitProcessDialog>
                                  </div>
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
