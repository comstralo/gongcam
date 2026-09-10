import { useEffect, useState } from "react";
import { ShieldAlert, ChevronDown, CalendarDays, User, Radio, CalendarClock } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "@/components/ui/collapsible";
import { InfoCard, TintedPill } from "@/components/dashboard/shared";
import { SectionHeader, PenaltyHistorySection, AdminListSkeleton } from "@/components/admin/shared";
import { ExitProcessDialog } from "@/components/admin/ExitProcessDialog";
import { useApi } from "@/hooks/useApi";
import { useRefreshOnVisible } from "@/hooks/useRefreshOnVisible";
import { usePollingRefresh } from "@/hooks/usePollingRefresh";
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

// 기준 주(월~일)의 각 요일 실제 날짜를 "8월 19일" 형태로 계산한다(벌금 미납
// 현황 · 송출 P 제보 확인과 동일 패턴). weekOf("YYMMDD")를 주면 그 주 기준,
// 없으면 오늘이 속한 이번 주 기준 — 사이클 토글로 지난 주를 선택했을 때도
// 실제 그 주의 날짜를 보여주기 위함.
function thisWeekDateLabel(dayKr: string, weekOf?: string | null): string {
  const dayIndex = STATUS_DAYS.indexOf(dayKr);
  if (dayIndex === -1) return "";
  let monday: Date;
  if (weekOf) {
    const m = /^(\d{2})(\d{2})(\d{2})$/.exec(weekOf);
    if (!m) return "";
    monday = new Date(2000 + parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  } else {
    const now = new Date();
    const todayIndex = (now.getDay() + 6) % 7;
    monday = new Date(now);
    monday.setDate(now.getDate() - todayIndex);
  }
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
export function PenaltyCandidateList({
  visible,
  cycleFileId,
  cycleWeekOf,
}: {
  visible: boolean;
  cycleFileId: string | null;
  cycleWeekOf: string | null;
}) {
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
  // 서버가 지난 사이클 조회면 readOnly: true를 내려준다 — 이제는 액션을
  // 잠그는 용도가 아니라, "지난 사이클 데이터 기준으로 처리 중"임을 화면에
  // 안내하는 용도로만 쓴다(사용자 지시, 2026-09-10: "예치금 재납/벌금 납부는
  // 익일이거나 하루 이틀 늦게 처리될 수도 있으니 지난주 시트에도 쓸 수
  // 있어야 한다"). 실제 계산은 이 화면이 보고 있는 cycleFileId 기준으로
  // 이뤄지고, 참여상태 변경 자체는 항상 현재 시트에 반영된다.
  const [readOnly, setReadOnly] = useState(false);

  function load() {
    setLoading(true);
    setError(null);
    const cycleParam = cycleFileId ? `?cycle=${encodeURIComponent(cycleFileId)}` : "";
    call<AdminExitCandidatesResponse>(`/admin/exit/candidates${cycleParam}`)
      .then((data) => {
        setCandidates(data.candidates || []);
        setReadOnly(!!data.readOnly);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "예치금 재납 대상 처리 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, [cycleFileId]); // eslint-disable-line react-hooks/exhaustive-deps
  // 다른 회원의 페널티 누적이 탭을 벗어난 사이에도 바뀔 수 있어, 돌아올
  // 때마다 새로 불러와야 최신 대상자를 놓치지 않는다.
  useRefreshOnVisible(visible, load);
  // 관련 캐시(exitStatus:/memberRows: 60초)의 3배 이상 주기로 폴링해,
  // 탭을 벗어나지 않아도 몇 분 안에 자동으로 최신 값을 받는다.
  const refreshProgress = usePollingRefresh(visible, load, 3 * 60_000);

  return (
    <Collapsible defaultOpen className="flex flex-col">
      <SectionHeader icon={ShieldAlert} title="예치금 재납 처리" loading={loading} onRefresh={load} refreshProgress={refreshProgress} />
      <CollapsiblePanel className="flex flex-col gap-4">
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
                // 🔧 [사용자 지시] "제보 쪽 토글의 전환 애니메이션처럼 부드럽게"
                // — MyOutputPenSection에 적용한 base-ui Collapsible(높이
                // 전환)을 여기도 적용한다.
                <Collapsible key={group.day} open={isDayExpanded} onOpenChange={(open) => setExpandedDay(open ? group.day : null)}>
                <InfoCard className="flex flex-col gap-2.5 bg-card">
                  <CollapsibleTrigger className="flex items-center justify-between gap-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded" hideChevron>
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      <span className="inline-flex shrink-0 items-center gap-1.25 text-sm font-semibold text-muted-foreground sm:text-base">
                        <CalendarDays className="size-3.5 shrink-0 sm:size-4" strokeWidth={ICON_STROKE.default} />
                        {isUnknown ? group.day : `${thisWeekDateLabel(group.day, cycleWeekOf)} ${group.day}요일`}
                      </span>
                      {/* 🔧 [사용자 지시] "'화각 불량 제보'에서 설정한 디자인을 기준으로
                          비슷한 모양의 다른 화면에도 적용" — 제보 화면의 "총 N건" 뱃지와
                          동일한 크기(text-xs sm:text-sm)로 통일한다. */}
                      <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
                        <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-destructive sm:text-sm">
                          대기 : {waitingCount}건
                        </span>
                        <span className="rounded-full bg-ok/15 px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-ok sm:text-sm">
                          재납 : {depositCount}건
                        </span>
                        <span className="rounded-full bg-amber-600/15 px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-amber-600 sm:text-sm dark:bg-amber-400/15 dark:text-amber-400">
                          강퇴 : {forcedCount}건
                        </span>
                      </span>
                    </span>
                    <ChevronDown
                      className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isDayExpanded && "rotate-180")}
                      strokeWidth={ICON_STROKE.default}
                    />
                  </CollapsibleTrigger>

                  <CollapsiblePanel className="flex flex-col">
                    <div className="flex flex-col gap-2.5 pt-2.5">
                      {group.items.map((c) => {
                        const isMemberExpanded = expandedNumber === c.number;
                        const decidedKind = processed[c.number];
                        return (
                          <Collapsible key={c.number} open={isMemberExpanded} onOpenChange={(open) => setExpandedNumber(open ? c.number : null)}>
                          <div className="flex flex-col gap-2.5 rounded-lg border bg-card p-3">
                            <div className="flex items-center justify-between gap-2">
                              <span className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base">
                                <User className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
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
                                <CollapsibleTrigger
                                  render={
                                    <Button
                                      variant="outline"
                                      size="icon-sm"
                                      aria-label={isMemberExpanded ? "상세 접기" : "상세 펼치기"}
                                    />
                                  }
                                >
                                  {/* 🔧 [사용자 지시] 제보 화면 기준 통일 — 색 지정이 없으면 outline
                                      버튼의 기본 전경색을 물려받아 날짜 그룹 헤더의 chevron
                                      (text-muted-foreground)보다 진하게 보였다. */}
                                  <ChevronDown
                                    className={cn(
                                      "size-3.5 text-muted-foreground transition-transform",
                                      isMemberExpanded && "rotate-180"
                                    )}
                                    strokeWidth={ICON_STROKE.default}
                                  />
                                </CollapsibleTrigger>
                              </div>
                            </div>

                            <CollapsiblePanel className="flex flex-col">
                              <div className="flex flex-col gap-2.5 pt-2.5">
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
                                  <>
                                    {/* 🔧 [사용자 지시, 2026-09-10] "예치금 재납/강퇴 확정은 지난주
                                        시트 기준으로도 처리될 수 있어야 한다" — 지난 사이클(1~3주차
                                        내) 조회 중이어도 그 시점 데이터를 기준으로 확정할 수 있다.
                                        cycleFileId를 그대로 넘기면 계산은 그 시점 기준, 실제 참여상태
                                        변경은 항상 현재 시트에 반영된다(ExitProcessDialog/백엔드 참고). */}
                                    {readOnly && (
                                      <p className="text-center text-xs text-muted-foreground sm:text-sm">
                                        지난 사이클 기록 기준으로 처리합니다 — 실제 반영은 현재 시트에 됩니다.
                                      </p>
                                    )}
                                    <div className="grid grid-cols-2 gap-2">
                                      <ExitProcessDialog
                                        candidate={c}
                                        onConfirmed={(kind) => setProcessed((prev) => ({ ...prev, [c.number]: kind }))}
                                        lockKind="forced"
                                        cycleFileId={cycleFileId}
                                      >
                                        <Button variant="destructive" className="w-full sm:h-12 sm:text-base">
                                          강제퇴실자 처리
                                        </Button>
                                      </ExitProcessDialog>
                                      <ExitProcessDialog
                                        candidate={c}
                                        onConfirmed={(kind) => setProcessed((prev) => ({ ...prev, [c.number]: kind }))}
                                        lockKind="deposit_again"
                                        cycleFileId={cycleFileId}
                                      >
                                        <Button variant="destructive" className="w-full sm:h-12 sm:text-base">
                                          재납자 처리
                                        </Button>
                                      </ExitProcessDialog>
                                    </div>
                                  </>
                                )}
                              </div>
                            </CollapsiblePanel>
                          </div>
                          </Collapsible>
                        );
                      })}
                    </div>
                  </CollapsiblePanel>
                </InfoCard>
                </Collapsible>
              );
            })}
          </div>
        )}
      </CollapsiblePanel>
    </Collapsible>
  );
}
