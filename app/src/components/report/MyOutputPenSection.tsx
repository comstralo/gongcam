import { useEffect, useState } from "react";
import { ListChecks, ChevronDown, CalendarDays, Image as ImageIcon, Trash2, FileText, Clock, Gavel } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { InfoCard, SubRow, TintedPill } from "@/components/dashboard/shared";
import { SectionHeader, SectionCard, CapturePreview, AdminListSkeleton } from "@/components/admin/shared";
import { CycleSwitcher } from "@/components/dashboard/CycleSwitcher";
import { useApi } from "@/hooks/useApi";
import { useRefreshOnVisible } from "@/hooks/useRefreshOnVisible";
import { usePollingRefresh } from "@/hooks/usePollingRefresh";
import { useAuth } from "@/lib/auth/useAuth";
import { ICON_STROKE, cn } from "@/lib/utils";
import type {
  MyCaptureDeleteResponse,
  MyCaptureItem,
  MyCapturesResponse,
  MyOutputPenItem,
  MyOutputPenResponse,
  TargetRespondResponse,
} from "@/lib/api/types";

const STATUS_DAYS = ["월", "화", "수", "목", "금", "토", "일"];

// ReportPage.tsx의 REASON_OPTIONS(고정 사유 5개 + "기타")와 동일한 목록.
// "기타"를 선택하면 그 문구 자체는 서버로 전송되지 않고 참여자가 직접 입력한
// 자유 텍스트로 reason이 완전히 대체된다 — 즉 reason 문자열만으로는 "기타
// 사유"였는지 구분할 고정 표식이 없다. 그래서 이 고정 사유 목록에 정확히
// 일치하지 않으면 자유 기재(기타)로 간주한다(사용자 지시: 다른 참여자가
// 직접 쓴 임의 문구를 그대로 노출하지 않기 위해).
const FIXED_REASONS = new Set([
  "격자 기준을 벗어난 근접 화각",
  "손 또는 학습자료 확인 불가",
  "전자기기 사용목적 확인 불가",
  "얼굴, 정수리 등 노출",
  "과도한 스티커 사용",
]);

function displayReason(reason: string): string {
  if (!reason) return "-";
  return FIXED_REASONS.has(reason) ? reason : "기타 (관리자 문의)";
}

// 카드 헤더 뱃지(단순화 버전, "처리현황" 상세 텍스트와는 별도) — 사용자
// 확정 매핑(2026-09):
// - targetResponse 없음 → "응답 대기 중"
// - 응답했지만 reviewStatus === "pending"(검토 중) → "이의제기 (검토 중)"/
//   "위반인정 (검토 중)"(90분 시한 초과로 자동 제출된 경우도 "위반인정
//   (검토 중)"으로 동일하게 표시 — 자동 제출 여부는 더 이상 문구로
//   구분하지 않는다).
// - 관리자가 최종 처리했으면(pending이 아님) reviewStatus만으로 결정한다
//   — approved→"확정", deferred→"유예", rejected/rejected_recognized→
//   "반려". targetResponse(이의제기/위반인정)와 무관하다: 예를 들어
//   "이의제기"했어도 관리자가 검토 후 실제 위반이라고 판단해 approved로
//   처리하면 "확정"이 되고(이의제기가 받아들여지지 않음), "위반인정"했어도
//   관리자가 위반이 아니라고 판단해 rejected로 처리하면 "반려"가 된다
//   (사용자 확인) — 결국 이 관리자 최종 결정 자체가 대상자에게 실질적으로
//   중요한 정보이므로, 어떤 응답을 냈었는지보다 결과(확정/유예/반려)를
//   우선 보여준다.
type StatusTone = "warn" | "primary" | "ok" | "muted";
function statusInfo(item: MyOutputPenItem): { label: string; tone: StatusTone } {
  if (!item.targetResponse) {
    return { label: "응답 대기 중", tone: "warn" };
  }
  if (item.reviewStatus === "pending") {
    const label = item.targetResponse === "disputed" ? "이의제기 (검토 중)" : "위반인정 (검토 중)";
    return { label, tone: "primary" };
  }
  if (item.reviewStatus === "approved") return { label: "확정", tone: "warn" };
  if (item.reviewStatus === "deferred") return { label: "유예", tone: "muted" };
  return { label: "반려", tone: "muted" };
}

// "처리현황" SubRow에 쓰는 상세 텍스트 — statusInfo(카드 헤더 뱃지, 단순화된
// 6종)와 달리 대상자가 실제로 어떤 응답을 제출했는지·90분 시한 초과로 자동
// 제출됐는지·관리자 결정이 그 응답을 승인했는지 미승인했는지까지 그대로
// 풀어서 보여준다(사용자 지시: "처리현황"은 텍스트, 카드 헤더는 뱃지로
// 역할을 분리). "무응답 (관리자 확정/반려)"는 실제 운영에서 도달하지 않는
// 경로라 제외하고 "대상자 응답 대기 중"으로 폴백한다(이전 확인 사항).
function statusLabel(item: MyOutputPenItem): string {
  if (!item.targetResponse) {
    return "대상자 응답 대기 중";
  }
  const isDisputed = item.targetResponse === "disputed";
  const label = isDisputed ? "이의제기" : "위반인정";
  if (item.reviewStatus === "pending") {
    if (item.targetResponseAuto) return "90분 내 무응답으로 위반인정 자동 제출 (검토 중)";
    return `${label} 제출 (검토 중)`;
  }
  const wasApplied = item.reviewStatus === "approved" || item.reviewStatus === "deferred";
  const approvedByAdmin = isDisputed ? !wasApplied : wasApplied;
  const outcome = item.reviewStatus === "approved" ? "확정" : item.reviewStatus === "deferred" ? "유예" : "반려";
  return `${label} ${approvedByAdmin ? "승인" : "미승인"} (${outcome})`;
}

// 시간 차감 예상 분 — 관리자가 "적용" 버튼을 눌러 발신~회신 시각을 직접
// 입력해야만 실제 penalty.deductedMinutes가 확정되지만(서버 applyTimeDeduction),
// 그 전에도 "예상 차감"을 보여줘야 한다(사용자 지시: 적용 버튼을 누르지
// 않아도 출력되어야 함). 접수 시각(item.ts)부터 대상자 응답 시각
// (targetRespondedAt)까지의 경과에서 20분(서버 TIME_DEDUCT_GRACE_MINUTES와
// 동일) 유예를 뺀 초과분을 예상값으로 계산한다 — 20분 이하로 응답했으면
// 0을 반환한다(차감 없음, "-00:00"으로 표시). 아직 응답이 없으면
// (targetRespondedAt이 null) 계산할 근거가 없어 null을 반환한다.
const TIME_DEDUCT_GRACE_MINUTES = 20;

function expectedDeductedMinutes(item: MyOutputPenItem, now: number = Date.now()): number | null {
  const respondedAt = item.targetRespondedAt || now;
  const diffMinutes = Math.floor((respondedAt - item.ts) / 60_000);
  return Math.max(0, diffMinutes - TIME_DEDUCT_GRACE_MINUTES);
}

// 차감 분을 "-HH:MM" 형식으로 포맷한다(사용자 지시).
function formatDeductedTime(minutes: number): string {
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `-${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

// "송출 P 대상 처리"(관리자용 ReportReviewList)와 동일한 요일별 아코디언 →
// 항목별 토글 → 캡처 미리보기 구조를 재활용한다(사용자 지시). 이 화면은
// 두 가지 서로 다른 항목을 같은 섹션에 함께 보여준다(사용자 지시):
// - "내 화각 점검"(kind: "selfCheck") — 본인이 스스로 찍은 것, 벌점/페널티
//   판정 대상이 아닌 읽기 전용.
// - "받은 제보"(kind: "received") — 다른 사람이 나를 대상으로 접수한 일반
//   제보. 대상자 본인이 "위반인정"/"이의제기" 중 하나를 제출할 수 있다
//   (관리자 화면의 90분 타임아웃·"다른 관리자 의견 반영" 활성화 조건이
//   이 응답을 사용한다).
type MergedItem =
  | { kind: "selfCheck"; id: string; ts: number; data: MyCaptureItem }
  | { kind: "received"; id: string; ts: number; data: MyOutputPenItem };

// 🔧 [버그 수정] 관리자 화면(ReportReviewList)의 groupByDay/thisWeekDateLabel은
// "이번 주 대기 건만" 다루는 화면이라 요일 이름(월~일)만으로 그룹핑해도
// 문제가 없었다. 하지만 이 컴포넌트는 여러 주에 걸친 이력을 계속 쌓아
// 보여주므로, 요일 이름만으로 그룹핑하면 서로 다른 주의 같은 요일이
// 하나로 합쳐지고, 헤더 날짜는 "오늘이 속한 주의 그 요일"로 계산돼 실제
// 항목 날짜와 어긋나 보이는 문제가 있었다(예: 9월 6일 접수 건인데 헤더가
// "9월 13일"로 표시). 요일 이름 대신 KST 기준 실제 날짜(YYYY-MM-DD)로
// 그룹핑해 이 문제를 근본적으로 없앤다.
function kstDateKey(ts: number): string {
  return new Date(ts).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }); // sv-SE 로케일이 YYYY-MM-DD를 그대로 출력.
}

function dateLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const dayKr = STATUS_DAYS[(date.getDay() + 6) % 7];
  return `${m}월 ${d}일 ${dayKr}요일`;
}

// 아래 3개 함수는 관리자 화면(ReportReviewList)의 동명 함수와 동일한
// 로직이다(§ expectedDeductedMinutes의 미응답 실시간 계산 수정 포함) —
// "받은 제보" 상세를 관리자 화면과 완전히 동일하게 보여달라는 사용자
// 지시에 맞춰, 별도 공용 유틸로 옮기는 대신 이 파일에도 필요한 만큼만
// 복제했다(다른 파일 변경을 최소화하려는 이 세션의 기존 패턴).
function actionLabel(occurrence: number | null): string {
  if (occurrence === 1) return "구두경고";
  if (occurrence === 2 || occurrence === 3 || occurrence === 5) return "벌점";
  if (occurrence === 4) return "송출 P : 1회";
  if (occurrence === 6) return "송출 P : 2회";
  return "적용 불가 (잔여 슬롯 없음)";
}

function occurrenceLabel(occurrence: number | null): string {
  const action = actionLabel(occurrence);
  return occurrence ? `${occurrence}차 (${action})` : action;
}

function weeklyImpactLabel(occurrence: number | null, weeklyMinorPenaltyCount: number): string {
  if (occurrence === 1) return "없음";
  if (occurrence === 2 || occurrence === 3 || occurrence === 5) {
    const deduction = Math.round(weeklyMinorPenaltyCount * 0.1 * 10) / 10;
    return `주간 총 상점에서 -${deduction}점`;
  }
  if (occurrence === 4) return "송출 P : 1회";
  if (occurrence === 6) return "송출 P : 2회";
  return "-";
}

function groupByDay(items: MergedItem[]) {
  const map = new Map<string, MergedItem[]>();
  for (const item of items) {
    const key = kstDateKey(item.ts);
    const existing = map.get(key);
    if (existing) existing.push(item);
    else map.set(key, [item]);
  }
  // 최근 날짜가 위로 오도록 내림차순 정렬.
  return Array.from(map.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([dateKey, groupItems]) => ({ dateKey, items: groupItems }));
}

export function MyOutputPenSection({
  refreshSignal,
  visible = true,
}: {
  refreshSignal?: number;
  visible?: boolean;
}) {
  const { call } = useApi();
  const { session } = useAuth();

  const [selfCheckItems, setSelfCheckItems] = useState<MyCaptureItem[] | null>(null);
  const [receivedItems, setReceivedItems] = useState<MyOutputPenItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // 🔧 [3주 사이클 토글] "현재 진행 중인 사이클"에서 어느 주(월~일, KST)를
  // 볼지 — null이면 현재(실시간), 아니면 CycleSwitcher가 넘긴 백업 fileId.
  // 사이클 밖(4주 이상 전)은 기존 CycleSwitcher와 마찬가지로 조회 대상이 아니다.
  const [cycleFileId, setCycleFileId] = useState<string | null>(null);
  // 관리자 화면(ReportReviewList)과 동일한 이유로, "예상 차감시간"이
  // 미응답 상태에서도 현재 시각 기준으로 계속 늘어나는 걸 보여주려면
  // 1분마다 다시 렌더링해야 한다.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setNowTick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  // 🔧 [버그 대응] 두 요청(/my-captures, /my-output-pen)을 동시에 보내다
  // 보니, 순간적인 네트워크 요동(브라우저 fetch 자체가 거부되는 "Failed to
  // fetch")으로 그중 하나만 실패해도 Promise.all이 전체를 reject해 목록이
  // 아예 안 뜨는 경우가 가끔 있었다(사용자 확인: 가끔 뜨고 새로고침하면
  // 정상). 서버/코드 로직 문제가 아니라 일시적 계층 실패라 짧은 지연 후
  // 1회 자동 재시도로 대부분의 경우를 사용자가 체감하지 않게 흡수한다.
  function loadOnce(cycle: string | null) {
    const cycleParam = cycle ? `?cycle=${encodeURIComponent(cycle)}` : "";
    return Promise.all([
      call<MyCapturesResponse>(`/my-captures${cycleParam}`),
      call<MyOutputPenResponse>(`/my-output-pen${cycleParam}`),
    ]);
  }

  function load() {
    setLoading(true);
    setError(null);
    loadOnce(cycleFileId)
      .catch(() => new Promise((resolve) => setTimeout(resolve, 800)).then(() => loadOnce(cycleFileId)))
      .then(([captures, outputPen]) => {
        setSelfCheckItems(captures.items || []);
        setReceivedItems(outputPen.items || []);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "제보 확인 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, [cycleFileId]); // eslint-disable-line react-hooks/exhaustive-deps
  // 🔧 [버그 수정] 원래는 visible 자리에 상수 true를 그대로 넘겼다 —
  // useRefreshOnVisible은 false→true로 바뀌는 전환에만 반응하는데, 인자가
  // 항상 true로 고정되어 있으면 최초 마운트 직후로 절대 다시 바뀌지 않아
  // 이 훅이 두 번 다시 트리거될 수 없었다. ReportPage가 App.tsx로부터
  // 실제 페이지 가시성(다른 탭으로 이동했다 돌아오는 것)을 받지 못해
  // 생긴 문제 — App.tsx가 이제 실제 visible을 내려주므로 그대로 이어받는다.
  // 참여자가 본인 위반 처리 현황 화면을 잠깐 벗어났다 돌아왔을 때, 그
  // 사이 관리자가 처리한 최신 상태가 자동으로 반영되게 하는 게 원래 이
  // 훅의 목적이었다.
  useRefreshOnVisible(visible, load);
  // 관련 캐시(penSlotGrid: 60초)의 3배 이상 주기로 폴링해, 화면을 계속
  // 띄워둔 채로도 관리자가 방금 처리한 결과가 몇 분 안에 자동 반영된다.
  const refreshProgress = usePollingRefresh(visible, load, 3 * 60_000);
  useEffect(() => {
    if (refreshSignal) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  // 당사자 본인이 "위반인정"/"이의제기" 중 하나를 제출한다 — 제출 성공 시
  // 서버 재조회 없이 로컬 상태만 갱신해 즉시 반영한다(다른 결정 흐름과 동일 패턴).
  function respond(item: MyOutputPenItem, response: "disputed" | "recognized") {
    setRespondingId(item.id);
    setError(null);
    call<TargetRespondResponse>("/captures/target-respond", { method: "POST", body: { id: item.id, response } })
      .then(() => {
        setReceivedItems((prev) =>
          prev
            ? prev.map((i) => (i.id === item.id ? { ...i, targetResponse: response, targetRespondedAt: Date.now() } : i))
            : prev
        );
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "응답 제출에 실패했습니다.");
        // 서버가 409(이미 응답함/이미 처리됨)를 반환한 경우 로컬 state가
        // 실제 서버 상태와 어긋나 있을 수 있어(예: 다른 탭에서 먼저 응답)
        // 최신 상태로 다시 불러온다.
        load();
      })
      .finally(() => setRespondingId(null));
  }

  // "내 화각 점검"은 벌점/페널티 판정 대상이 아닌 순수 셀프 확인용 기록이라
  // (사용자 요청) 본인이 직접 삭제할 수 있다. "받은 제보"는 관리자 처리
  // 대상이라 여기서 삭제 버튼을 제공하지 않는다.
  function deleteSelfCheck(item: MyCaptureItem) {
    if (!window.confirm("이 내 화각 점검 기록을 삭제할까요? 되돌릴 수 없습니다.")) return;
    setDeletingId(item.id);
    setError(null);
    call<MyCaptureDeleteResponse>("/my-captures/delete", { method: "POST", body: { id: item.id } })
      .then(() => {
        setSelfCheckItems((prev) => (prev ? prev.filter((i) => i.id !== item.id) : prev));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "삭제에 실패했습니다."))
      .finally(() => setDeletingId(null));
  }

  const items: MergedItem[] = [
    ...(selfCheckItems || []).map((data): MergedItem => ({ kind: "selfCheck", id: data.id, ts: data.ts, data })),
    ...(receivedItems || []).map((data): MergedItem => ({ kind: "received", id: data.id, ts: data.ts, data })),
  ];
  const loaded = selfCheckItems !== null && receivedItems !== null;

  return (
    <SectionCard>
      <Collapsible defaultOpen className="flex flex-col gap-4">
        <SectionHeader icon={ListChecks} title="내 화각 불량 제보" loading={loading} onRefresh={load} refreshProgress={refreshProgress} />
        <CollapsiblePanel className="flex flex-col gap-4">
          <div className="h-px w-full bg-border" />
          <CycleSwitcher selectedFileId={cycleFileId} onSelect={setCycleFileId} memberNumber="self" />
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {loading && !loaded && <AdminListSkeleton />}

          {!loading && loaded && items.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">
              확인할 내 화각 점검·제보가 없습니다.
            </p>
          )}

          {loaded && items.length > 0 && (
            <div className="flex flex-col gap-2 sm:gap-2.5">
              {groupByDay(items).map((group) => {
                const isDayExpanded = expandedDay === group.dateKey;
                // "내 화각 점검"(kind: "selfCheck")은 벌점/페널티 판정 대상이
                // 아닌 자가 점검용 기록이라 건수에서 제외한다(사용자 지시).
                const receivedCount = group.items.filter((item) => item.kind === "received").length;
                return (
                  <InfoCard key={group.dateKey} className="flex flex-col gap-2.5 bg-card">
                    <button
                      type="button"
                      onClick={() => setExpandedDay(isDayExpanded ? null : group.dateKey)}
                      className="flex items-center justify-between gap-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded"
                    >
                      <span className="inline-flex shrink-0 items-center gap-1.25 text-xs font-semibold sm:text-sm">
                        <CalendarDays className="size-3 shrink-0 text-muted-foreground sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                        {dateLabel(group.dateKey)}
                      </span>
                      <span className="ml-auto flex items-center gap-1.5">
                        <span className="rounded-full bg-amber-600/15 px-2 py-1 text-micro-lg leading-none sm:text-xs font-semibold text-amber-600 dark:bg-amber-400/15 dark:text-amber-400">
                          {receivedCount}건
                        </span>
                        <ChevronDown
                          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isDayExpanded && "rotate-180")}
                          strokeWidth={ICON_STROKE.default}
                        />
                      </span>
                    </button>

                    {isDayExpanded && (
                      <div className="flex flex-col gap-2.5">
                        {/* 발생 시각(item.ts) 오름차순(오래된 게 위) — 관리자 화면
                            (ReportReviewList)과 동일한 정렬 기준(사용자 지시). */}
                        {[...group.items]
                          .sort((a, b) => a.ts - b.ts)
                          .map((item) => {
                          const isItemExpanded = expandedId === item.id;
                          const isReceived = item.kind === "received";
                          const received = isReceived ? (item.data as MyOutputPenItem) : null;
                          // 버튼 자체는 항상 보여주되(사용자 지시), 이미 관리자가 최종
                          // 처리(적용/유예/반려)했거나 대상자가 이미 응답을 제출한
                          // 건이면 눌러도 무효이므로 비활성화한다.
                          const canRespond =
                            isReceived && received!.reviewStatus === "pending" && !received!.targetResponse;
                          return (
                            <div
                              key={item.id}
                              className={cn(
                                "flex flex-col gap-2.5 rounded-lg border bg-card p-3",
                                // 아직 응답하지 않은 건은 대상자가 놓치기 쉬우므로(90분
                                // 시한이 지나면 자동으로 위반인정 처리됨) 벌금 미납
                                // 강조와 동일한 글로우 효과로 눈에 띄게 한다(사용자 지시).
                                canRespond && "border-destructive/60 animate-unpaid-glow"
                              )}
                            >
                              {/* 🔧 [버그 수정] 항상 가로 배치(justify-between)였는데, 유예/
                                  확정 건은 뱃지가 3개(예: "유예 1차"/"3차 (벌점)"/"-00:00")까지
                                  붙어 좁은 모바일 폭에서 각 뱃지 안 텍스트가 눌려 줄바꿈되며
                                  깨져 보였다(Playwright MCP 모바일 뷰포트 점검으로 발견).
                                  관리자 화면(ReportReviewList)과 동일하게 sm 미만에서는
                                  세로로 쌓이도록(flex-col) 맞춘다. */}
                              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                                  <Clock className="size-3 shrink-0 text-muted-foreground sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                                  {/* 이미 날짜별로 묶여 있으므로(그룹 헤더에 날짜 표시) 여기서는
                                      시각만 보여준다(사용자 지시: 날짜는 빼고, 아이콘도 시계로). */}
                                  {new Date(item.ts).toLocaleTimeString("ko-KR")}
                                </span>
                                <div className="flex items-center gap-1.5">
                                  {isReceived ? (
                                    received!.reviewStatus === "deferred" ? (
                                      // 🔧 [관리자 화면과 동일화] 관리자 화면(ReportReviewList)은
                                      // 유예 뱃지를 "유예 N차" + 원래 조치("2차 (벌점)" 등) 2개로
                                      // 분리해 보여준다(사용자 지시로 여기도 통일).
                                      <>
                                        <TintedPill tone="muted">
                                          {received!.deferOccurrence ? `유예 ${received!.deferOccurrence}차` : "유예"}
                                        </TintedPill>
                                        {/* 🔧 [버그 수정] deferredOccurrence(유예 확정 시점의 슬롯
                                            스냅샷)를 우선 쓴다 — nextOccurrence는 조회 시점마다
                                            재계산돼, 이 유예 건 확정 이후 다른 건이 실제로 그
                                            슬롯을 채우면 표시 차수까지 밀려 보였다(관리자 화면과
                                            동일 버그, 사용자 재현으로 발견). */}
                                        <TintedPill tone="muted">
                                          {occurrenceLabel(received!.deferredOccurrence ?? received!.nextOccurrence)}
                                        </TintedPill>
                                        {/* 🔧 [차감시간 뱃지 추가] 유예도 벌점과 별개로 응답 지연
                                            시간 차감이 확정되므로(사용자 지시) 세 번째 뱃지로
                                            함께 노출한다. */}
                                        <TintedPill tone="muted">
                                          {formatDeductedTime(received!.timeDeduction?.deductedMinutes ?? 0)}
                                        </TintedPill>
                                      </>
                                    ) : received!.reviewStatus === "approved" ? (
                                      // 🔧 [차수 뱃지 추가] "확정" 뱃지 옆에도 유예와 동일하게
                                      // "확정 적용" 값(몇 차 · 어떤 조치)을 별도 뱃지로 붙여
                                      // 상세를 펼치지 않아도 바로 볼 수 있게 한다(사용자 지시).
                                      <>
                                        <TintedPill tone="warn">확정</TintedPill>
                                        <TintedPill
                                          tone="muted"
                                          className="bg-yellow-500/15 text-yellow-600 dark:bg-yellow-400/15 dark:text-yellow-400"
                                        >
                                          {occurrenceLabel(received!.penalty?.occurrence ?? received!.nextOccurrence)}
                                        </TintedPill>
                                        {/* 🔧 [차감시간 뱃지 추가] "확정 차감시간" 값도 세 번째
                                            뱃지로 함께 노출한다(사용자 지시). */}
                                        <TintedPill tone="muted">
                                          {formatDeductedTime(
                                            received!.penalty?.deductedMinutes ?? received!.timeDeduction?.deductedMinutes ?? 0
                                          )}
                                        </TintedPill>
                                      </>
                                    ) : (
                                      (() => {
                                        const { label, tone } = statusInfo(received!);
                                        return <TintedPill tone={tone}>{label}</TintedPill>;
                                      })()
                                    )
                                  ) : (
                                    <TintedPill tone="ok">화각 점검</TintedPill>
                                  )}
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
                              </div>

                              {isItemExpanded && (
                                <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:gap-3.5 sm:p-5">
                                  <div className="flex flex-col gap-1.5">
                                    <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                                      <ImageIcon className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                      스크린샷 · 영상
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
                                  {isReceived && (
                                    <>
                                      <div className="h-px w-full bg-border" />
                                      <div className="flex flex-col gap-1.5">
                                        <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                                          <FileText className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                          제보정보
                                        </span>
                                        {/* 관리자 화면과 동일한 레이아웃이되, 제보자는 숨긴다(사용자 지시). */}
                                        <SubRow label="사유" value={displayReason(received!.reason)} valueClassName="text-destructive" />
                                        <SubRow label="발생일시" value={new Date(item.ts).toLocaleString("ko-KR")} />
                                        <SubRow label="처리현황" value={statusLabel(received!)} />
                                      </div>

                                      <div className="h-px w-full bg-border" />

                                      <div className="flex flex-col gap-1.5">
                                        <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                                          <Clock className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                          학습시간 차감
                                        </span>
                                        <SubRow
                                          label="응답일시"
                                          value={
                                            received!.targetRespondedAt
                                              ? new Date(received!.targetRespondedAt).toLocaleString("ko-KR")
                                              : "대상자 응답 대기 중"
                                          }
                                        />
                                        {(() => {
                                          // 🔧 [유예도 확정으로 표시] "유예"는 벌점만 면제될 뿐 응답
                                          // 지연 시간 차감은 별도로 적용되므로(사용자 지시), penalty가
                                          // 아니라 reviewStatus가 pending을 벗어났는지로 확정 여부를
                                          // 판단한다 — 유예 건은 timeDeduction(있으면 실제 차감, 없으면
                                          // 지연이 20분 이하였다는 확정된 0)을 쓴다.
                                          const isDecided = received!.reviewStatus !== "pending";
                                          const confirmed = isDecided
                                            ? received!.penalty?.deductedMinutes ?? received!.timeDeduction?.deductedMinutes ?? 0
                                            : undefined;
                                          const isConfirmed = confirmed !== undefined;
                                          const deductedMinutes = isConfirmed ? confirmed : expectedDeductedMinutes(received!) ?? 0;
                                          return (
                                            <SubRow
                                              label={isConfirmed ? "확정 차감시간" : "예상 차감시간"}
                                              value={formatDeductedTime(deductedMinutes)}
                                              valueClassName={deductedMinutes === 0 ? undefined : "text-destructive"}
                                            />
                                          );
                                        })()}
                                      </div>

                                      <div className="h-px w-full bg-border" />

                                      <div className="flex flex-col gap-1.5">
                                        <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                                          <Gavel className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                          벌점 · 페널티 변동
                                        </span>
                                        {/* 🔧 [관리자 화면과 동일화] deferOccurrence(당일 몇 번째
                                            유예인지)가 있으면 관리자 화면과 동일하게 원래 차수
                                            라벨에 취소선을 긋고 "유예 N차"를 덧붙인다(사용자
                                            지시). */}
                                        {/* 🔧 [반려도 확정으로 표시] "반려"(rejected/
                                            rejected_recognized)도 관리자가 이미 처리를 마친
                                            상태이므로 라벨은 "확정"으로 보여주되(사용자 지시),
                                            실제로는 적용되지 않은 조치이므로 값 자체에 취소선을
                                            그어 구분한다. */}
                                        {(() => {
                                          const isRejectedDecided =
                                            !received!.penalty &&
                                            !received!.deferOccurrence &&
                                            (received!.reviewStatus === "rejected" ||
                                              received!.reviewStatus === "rejected_recognized");
                                          // 🔧 [버그 수정] deferOccurrence는 이미 확정된 유예
                                          // (reviewStatus: "deferred")뿐 아니라 아직 pending인
                                          // 항목의 "지금 처리하면 유예 대상"이라는 예상값에도
                                          // 채워진다 — 있기만 하면 무조건 확정으로 취급하면,
                                          // 대상자 응답을 기다리는 중인 건도 "확정 적용"으로
                                          // 잘못 표시된다(사용자 실사례). reviewStatus로 실제
                                          // 확정 여부를 가른다.
                                          const isDecided =
                                            !!received!.penalty || received!.reviewStatus === "deferred" || isRejectedDecided;
                                          return (
                                            <SubRow
                                              label={isDecided ? "확정 적용" : "예상 적용"}
                                              value={
                                                received!.deferOccurrence ? (
                                                  <>
                                                    <span className="line-through">
                                                      {occurrenceLabel(received!.deferredOccurrence ?? received!.nextOccurrence)}
                                                    </span>{" "}
                                                    유예 {received!.deferOccurrence}차
                                                  </>
                                                ) : received!.penalty ? (
                                                  occurrenceLabel(received!.penalty.occurrence)
                                                ) : isRejectedDecided ? (
                                                  <span className="line-through">
                                                    {occurrenceLabel(received!.deferredOccurrence ?? received!.nextOccurrence)}
                                                  </span>
                                                ) : (
                                                  occurrenceLabel(received!.nextOccurrence)
                                                )
                                              }
                                              valueClassName="text-destructive"
                                            />
                                          );
                                        })()}
                                        {/* 🔧 [버그 수정] 관리자 화면과 동일한 이유로, 확정된 건은
                                            penalty에 저장된 확정 시점 스냅샷(weeklyMinorPenaltyCount)을
                                            우선 사용해 "이번 주 영향"이 이후 다른 건 처리로 계속
                                            바뀌어 보이지 않게 한다. 반려(rejected/rejected_recognized)
                                            도 애초에 벌점이 적용되지 않으므로 유예와 동일하게
                                            "없음"으로 고정 — 재계산값(nextOccurrence/
                                            weeklyMinorPenaltyCount)으로 새면 같은 대상자의 다른
                                            건이 나중에 처리될 때 이미 반려된 건의 표시까지
                                            바뀌어 보이는 버그가 재현된다. */}
                                        {(() => {
                                          const isRejectedDecided =
                                            !received!.penalty &&
                                            (received!.reviewStatus === "rejected" ||
                                              received!.reviewStatus === "rejected_recognized");
                                          const impact =
                                            received!.deferOccurrence || isRejectedDecided
                                              ? "없음"
                                              : weeklyImpactLabel(
                                                  received!.penalty ? received!.penalty.occurrence : received!.nextOccurrence,
                                                  received!.penalty?.weeklyMinorPenaltyCount ?? received!.weeklyMinorPenaltyCount
                                                );
                                          const hasImpact = impact !== "없음" && impact !== "-";
                                          return (
                                            <SubRow
                                              label="이번 주 영향"
                                              value={impact}
                                              valueClassName={hasImpact ? "text-destructive" : undefined}
                                            />
                                          );
                                        })()}
                                      </div>
                                    </>
                                  )}

                                  {isReceived && (
                                    <>
                                      <div className="h-px w-full bg-border" />
                                      <div className="grid grid-cols-2 gap-2">
                                        <Button
                                          variant="outline"
                                          className="sm:h-11 sm:text-base"
                                          disabled={!canRespond || respondingId === item.id}
                                          onClick={() => respond(received!, "recognized")}
                                        >
                                          위반인정
                                        </Button>
                                        <Button
                                          variant="destructive"
                                          className="sm:h-11 sm:text-base"
                                          disabled={!canRespond || respondingId === item.id}
                                          onClick={() => respond(received!, "disputed")}
                                        >
                                          이의제기
                                        </Button>
                                      </div>
                                    </>
                                  )}

                                  {!isReceived && (
                                    <>
                                      <div className="h-px w-full bg-border" />
                                      <Button
                                        variant="outline"
                                        className="text-destructive hover:bg-destructive/10 hover:text-destructive sm:h-11 sm:text-base"
                                        disabled={deletingId === item.id}
                                        onClick={() => deleteSelfCheck(item.data as MyCaptureItem)}
                                      >
                                        <Trash2 className="size-3.5 shrink-0" strokeWidth={ICON_STROKE.default} />
                                        삭제
                                      </Button>
                                    </>
                                  )}
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
