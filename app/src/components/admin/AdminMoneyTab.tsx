import { useEffect, useState } from "react";
import { ChevronDown, CircleDollarSign, CalendarDays, User, Trophy, Timer, Award, Coins } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { InfoCard, DayDetailCard, TintedPill, ItemTitle, DividedValue } from "@/components/dashboard/shared";
import { SectionHeader, FieldLabel, SectionCard } from "@/components/admin/shared";
import { ExitProcessDialog } from "@/components/admin/ExitProcessDialog";
import { RankBadge, achievedTime } from "@/components/dashboard/RosterView";
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
  StatusResponse,
  RosterStatusResponse,
  RosterMember,
  PrizeSettleResponse,
} from "@/lib/api/types";

const STATUS_DAYS = ["월", "화", "수", "목", "금", "토", "일"];

// 세 API(paid/unpaid/exempt)가 공통으로 내려주는 최소 필드 — 어느 목록에서
// 왔는지와 무관하게 하나의 행으로 합쳐 다룬다.
type FineRecord = { number: string; name: string; day: string; baseStatus: FineStatus };

function fineKey(f: Pick<FineRecord, "number" | "day">) {
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
function groupByDay<T extends { day: string }>(items: T[]) {
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

// 시트의 "납부확인" 값은 회원·요일마다 항상 미납/납부/면제 중 하나다 — 이
// 화면은 그 값이 무엇이든 전원을 요일별로 보여주고(사용자 지적: 미납만
// 보여선 안 되고 세 상태 모두 보여야 함), 각 행은 실제 그 값을 배지로,
// 나머지 두 상태 + "직권 P"를 버튼으로 제공한다. 세 상태를 각각 다른
// API(/admin/fines/paid·unpaid·exempt)로 나눠 조회한 뒤 하나의 목록으로
// 합친다 — 백엔드가 이 세 목록을 합쳐주는 API가 따로 없기 때문.
function PaidFineList({ isVisible }: { isVisible: boolean }) {
  const { call } = useApi();
  const TODAY_INDEX = useTodayIndex();

  const [records, setRecords] = useState<FineRecord[] | null>(null);
  const [totalAmount, setTotalAmount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  // 항목별로 이 세션에서 방금 바꾼 상태 — §3.1(제보 확인)의 applied/rejected와
  // 동일한 패턴으로, 상태를 바꿔도 목록에서 항목을 지우지 않고 그 자리에
  // 남겨 배지만 바꾼다.
  const [statusOverride, setStatusOverride] = useState<Record<string, FineStatus>>({});
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [dayDetail, setDayDetail] = useState<Record<string, StatusResponse | "loading" | "error">>({});

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([
      call<AdminFinesUnpaidResponse>("/admin/fines/unpaid"),
      call<AdminFinesPaidResponse>("/admin/fines/paid"),
      call<AdminFinesExemptResponse>("/admin/fines/exempt"),
    ])
      .then(([unpaidData, paidData, exemptData]) => {
        const merged: FineRecord[] = [
          ...(unpaidData.unpaid || []).map((f) => ({ ...f, baseStatus: "미납" as const })),
          ...(paidData.paid || []).map((f) => ({ ...f, baseStatus: "납부" as const })),
          ...(exemptData.exempt || []).map((f) => ({ ...f, baseStatus: "면제" as const })),
        ];
        setRecords(merged);
        setTotalAmount(paidData.totalAmount || 0);
        setStatusOverride({});
      })
      .catch((err) => setError(err instanceof Error ? err.message : "벌금 납부 대상자 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 이 탭(MEM·PEN)에서 퇴실/재납 처리를 하면 벌금 상태가 바뀔 수 있어,
  // Money 탭으로 돌아올 때마다 새로 불러온다.
  useRefreshOnVisible(isVisible, load);

  async function handleSetStatus(f: FineRecord, status: FineStatus) {
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

  function toggleMember(f: FineRecord) {
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

  // 로컬에서 바꾼 적이 있으면 그 값, 없으면 서버가 알려준 실제 현재 상태.
  function effectiveStatus(f: FineRecord): FineStatus {
    return statusOverride[fineKey(f)] ?? f.baseStatus;
  }

  const groups = groupByDay(records || []);

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

      {loading && !records && (
        <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">불러오는 중...</p>
      )}

      {!loading && records && groups.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">처리 대상이 없습니다.</p>
      )}

      {groups.length > 0 && (
        <div className="flex flex-col gap-2 sm:gap-2.5">
          {groups.map((group) => {
            const isDayExpanded = expandedDay === group.day;
            // 요일 헤더 배지는 그날 전체 인원을 실시간 상태(로컬 변경 포함)
            // 기준으로 다시 센다.
            const paidCount = group.members.filter((f) => effectiveStatus(f) === "납부").length;
            const unpaidCount = group.members.filter((f) => effectiveStatus(f) === "미납").length;
            const exemptCount = group.members.filter((f) => effectiveStatus(f) === "면제").length;
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
                      // 선택지만 보여준다 — 이미 그 상태인데 같은 버튼을 또
                      // 누르는 무의미한 액션을 없앤다.
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
                              <div className="flex items-center gap-2">
                                {otherActions.map((action) =>
                                  action === "직권 P" ? (
                                    // 🔧 §3.5 MemberRosterList의 "퇴실 처리
                                    // (직권 P)"와 동일한 ExitProcessDialog를
                                    // 그대로 재사용 — 이 화면엔 roster 조회로
                                    // 얻는 suggestedKind/allChecks가 없지만,
                                    // lockKind="admin_forced"일 땐 그 값이
                                    // 실제로 읽히지 않는다(체크리스트도 숨김,
                                    // useState 초기값 fallback도 lockKind가
                                    // 우선). 확정 후 목록을 다시 불러와야
                                    // 상태가 반영되므로 onConfirmed에서 load().
                                    <ExitProcessDialog
                                      key={action}
                                      candidate={{ number: f.number, name: f.name, suggestedKind: "settle", allChecks: [] }}
                                      lockKind="admin_forced"
                                      lockForcedReason="벌금 시한 내 미납자"
                                      onConfirmed={load}
                                      triggerClassName="flex-1"
                                    >
                                      <Button variant="destructive" className="w-full sm:h-11">
                                        퇴실 처리 (직권 P)
                                      </Button>
                                    </ExitProcessDialog>
                                  ) : (
                                    <Button
                                      key={action}
                                      variant="outline"
                                      disabled={isPending}
                                      onClick={() => handleSetStatus(f, action)}
                                      className="flex-1 sm:h-11"
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

// "상금 수령 대상자 처리" — §4.2. 이번 주 1~5등에게 분배될 정산 금액을
// 보여준다. RosterPage의 "이번 주 정산"(회원 대시보드)과 완전히 같은
// 원본(GET /roster-status, settlement 필드)을 그대로 재사용한다 — 순위
// 산정·1/n 균등 분배 로직이 이미 백엔드에 있어(buildRosterStatus,
// index.js) 별도 API를 새로 만들 필요가 없다. 다만 그 엔드포인트는 기본적
// 으로 스터디원에게는 일요일 14교시 종료(23:30 KST) 전까지 settlement을
// 숨기는데, 관리자는 그 시간 제한 없이 항상 봐야 하므로(사용자 지시대로
// 상시 처리 화면) 백엔드에 isAdmin 조건을 추가해 우회한다(handleRosterStatus).
function PrizeRecipientList({ isVisible }: { isVisible: boolean }) {
  const { call } = useApi();
  const [collectMoney, setCollectMoney] = useState(0);
  // "랭킹"(RosterView)의 타이머·상점을 그대로 보여주려면 members(그 두
  // 값을 가진 원본)와 settlement(순위·분배금)을 회원번호로 매칭해야
  // 한다 — settlement 자체엔 timer/merit가 없다.
  const [members, setMembers] = useState<RosterMember[]>([]);
  const [settlement, setSettlement] = useState<RosterStatusResponse["settlement"]>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [settling, setSettling] = useState(false);
  const [settled, setSettled] = useState(false);

  // 🧪 [임시 더미 미리보기] 실제 서비스 화면에서 렌더링을 확인하기 위한
  // 임시 조치 — 확인 끝나면 반드시 원래 /roster-status 호출로 되돌릴 것.
  function load() {
    setLoading(true);
    setError(null);
    setTimeout(() => {
      setCollectMoney(142000);
      setMembers([
        { number: "3", name: "김재희", timer: "48:20 / 50:00", merit: "12.500", rank: "🥇", status: "" },
        { number: "7", name: "이서준", timer: "45:10 / 50:00", merit: "10.200", rank: "🥈", status: "" },
        { number: "1", name: "박도윤", timer: "43:55 / 50:00", merit: "9.800", rank: "🥉", status: "" },
        { number: "9", name: "최하은", timer: "41:30 / 50:00", merit: "8.100", rank: "🏅", status: "" },
        { number: "5", name: "정유나", timer: "40:05 / 50:00", merit: "7.600", rank: "5", status: "" },
      ]);
      setSettlement([
        { number: "3", name: "김재희", rank: 1, amount: 28400 },
        { number: "7", name: "이서준", rank: 2, amount: 28400 },
        { number: "1", name: "박도윤", rank: 3, amount: 28400 },
        { number: "9", name: "최하은", rank: 4, amount: 28400 },
        { number: "5", name: "정유나", rank: 5, amount: 28400 },
      ]);
      setLoading(false);
    }, 300);
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  useRefreshOnVisible(isVisible, load);

  // "상금 정산 집행" — 관리자가 이번 주 1~5등에게 실제로 상금을 지급했음을
  // 집계!P6 셀에 "완료"로 기록한다(handleAdminPrizeSettle). 다른 상태
  // 변경(납부/미납/면제)처럼 별도 확인 다이얼로그 없이 클릭 즉시 실행한다
  // (사용자 지시) — 대신 실수로 중복 집행하지 않도록, 성공한 뒤에는
  // 버튼을 "집행 완료"로 바꾸고 다시 누를 수 없게 한다.
  async function handleSettle() {
    setSettling(true);
    setError(null);
    try {
      await call<PrizeSettleResponse>("/admin/prize/settle", { method: "POST" });
      setSettled(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "상금 정산 집행에 실패했습니다.");
    } finally {
      setSettling(false);
    }
  }

  return (
    <Collapsible defaultOpen className="flex flex-col gap-4">
      <SectionHeader icon={Trophy} title="상금 수령 대상자 처리" loading={loading} onRefresh={load} />
      <div className="h-px w-full bg-border" />
      <CollapsiblePanel className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <InfoCard className="flex items-center justify-between gap-2">
          <FieldLabel>납부된 총 벌금액</FieldLabel>
          <span className="font-mono text-base font-bold tabular-nums text-ok sm:text-lg">{won(collectMoney)}</span>
        </InfoCard>

        {loading && !settlement && (
          <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">불러오는 중...</p>
        )}

        {!loading && settlement && settlement.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">이번 주 정산 대상이 없습니다.</p>
        )}

        {settlement && settlement.length > 0 && (
          // §"랭킹"(RosterView)의 카드 출력 형태를 그대로 재활용한다 —
          // 타이머·상점 서브로우(DividedValue)는 그대로 두고, 거기에
          // 구분선으로 세 번째 항목만 추가해 분배받을 금액을 보여준다
          // (사용자 지시: "상점 옆에 구분자 하나 더 넣고 분배받을 금액을
          // 표시"). settlement 자체엔 timer/merit가 없어 members에서
          // 회원번호로 찾아 합친다.
          <div className="flex flex-col gap-2 sm:gap-2.5">
            {settlement.map((s) => {
              const m = members.find((mm) => mm.number === s.number);
              return (
                <InfoCard key={s.number} className="flex items-center gap-3 sm:gap-4">
                  <RankBadge rank={String(s.rank)} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <ItemTitle className="truncate">{s.name}</ItemTitle>
                    <div className="text-xs tabular-nums text-muted-foreground sm:text-sm">
                      <DividedValue
                        items={[
                          <span key="timer" className="inline-flex items-center gap-1">
                            <Timer className="size-3 shrink-0 sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                            {(m && achievedTime(m.timer)) || "-"}
                          </span>,
                          <span key="merit" className="inline-flex items-center gap-1">
                            <Award className="size-3 shrink-0 sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                            {m?.merit || "-"}
                          </span>,
                          <span key="amount" className="inline-flex items-center gap-1">
                            <Coins className="size-3 shrink-0 sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                            {won(s.amount)}
                          </span>,
                        ]}
                      />
                    </div>
                  </div>
                </InfoCard>
              );
            })}
          </div>
        )}

        {settlement && settlement.length > 0 && (
          <Button
            variant="outline"
            className="w-full sm:h-12 sm:text-base"
            disabled={settling || settled}
            onClick={handleSettle}
          >
            {settled ? "집행 완료" : settling ? "집행 중..." : "상금 정산 집행"}
          </Button>
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
      <SectionCard>
        <PrizeRecipientList isVisible={visible} />
      </SectionCard>
    </div>
  );
}
