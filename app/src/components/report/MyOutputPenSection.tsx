import { useEffect, useState } from "react";
import { ListChecks, ChevronDown, CalendarDays, User, Image as ImageIcon, Trash2, FileText, Clock, Gavel } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { InfoCard, SubRow, TintedPill } from "@/components/dashboard/shared";
import { SectionHeader, SectionCard, CapturePreview, AdminListSkeleton } from "@/components/admin/shared";
import { CycleSwitcher } from "@/components/dashboard/CycleSwitcher";
import { useApi } from "@/hooks/useApi";
import { useRefreshOnVisible } from "@/hooks/useRefreshOnVisible";
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

// "처리현황" — 대상자 응답(targetResponse)과 관리자 최종 처리(reviewStatus)를
// 조합한 문구. 코드상 "이의제기 승인/미승인"이라는 값이 별도로 저장되지
// 않고(관리자는 대상자 응답과 무관하게 approved/rejected_recognized/rejected/
// deferred 중 자유롭게 고른다 — 대상자가 "위반인정"을 눌러도 관리자가 검토 후
// 위반이 아니라고 판단해 반려할 수 있다), 최종 reviewStatus로부터 역산한다:
// approved/deferred(대상자에게 결국 적용된 처리) → "확정", rejected/
// rejected_recognized(대상자에게 적용되지 않은 처리) → "반려". "승인"은 대상자
// 응답과 관리자 최종 처리가 같은 방향(이의제기→반려, 위반인정→확정)일 때다.
function statusLabel(item: MyOutputPenItem): string {
  if (!item.targetResponse) return "대상자 응답 대기 중";
  const isDisputed = item.targetResponse === "disputed";
  const label = isDisputed ? "이의제기" : "위반인정";
  if (item.reviewStatus === "pending") {
    // 90분 내 응답이 없으면 자동으로 위반인정 처리된다 — 본인이 직접
    // 누른 것과 구분해 보여준다(사용자 지시).
    if (item.targetResponseAuto) return "시한 (90분) 초과로 위반인정 자동 제출 (검토 중)";
    return `${label} 제출 (검토 중)`;
  }
  const wasApplied = item.reviewStatus === "approved" || item.reviewStatus === "deferred";
  const approvedByAdmin = isDisputed ? !wasApplied : wasApplied;
  const outcome = isDisputed ? (approvedByAdmin ? "반려" : "확정") : (approvedByAdmin ? "확정" : "반려");
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

function expectedDeductedMinutes(item: MyOutputPenItem): number | null {
  if (!item.targetRespondedAt) return null;
  const diffMinutes = Math.floor((item.targetRespondedAt - item.ts) / 60_000);
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
// 로직이다 — "받은 제보" 상세를 관리자 화면과 완전히 동일하게 보여달라는
// 사용자 지시에 맞춰, 별도 공용 유틸로 옮기는 대신 이 파일에도 필요한
// 만큼만 복제했다(다른 파일 변경을 최소화하려는 이 세션의 기존 패턴).
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
  if (occurrence === 1) return "주간 총 상점 변동 없음";
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

export function MyOutputPenSection({ refreshSignal }: { refreshSignal?: number }) {
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
  useRefreshOnVisible(true, load);
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
        <SectionHeader icon={ListChecks} title="내 송출 P 제보 확인" loading={loading} onRefresh={load} />
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
                // "확정 전인지 후인지"로만 구분한다(사용자 지시) — 관리자
                // 확정 개념이 없는 "내 화각 점검"은 어느 쪽에도 넣지 않고
                // 집계에서 제외한다. "받은 제보"는 reviewStatus==="pending"
                // 이면 검토(확정 전), 그 외(approved/rejected/유예 등 관리자가
                // 어떤 형태로든 최종 처리한 상태)는 적용(확정 후)으로 본다.
                const reviewingCount = group.items.filter(
                  (item) => item.kind === "received" && (item.data as MyOutputPenItem).reviewStatus === "pending"
                ).length;
                const appliedCount = group.items.filter(
                  (item) => item.kind === "received" && (item.data as MyOutputPenItem).reviewStatus !== "pending"
                ).length;
                return (
                  <InfoCard key={group.dateKey} className="flex flex-col gap-2.5 bg-card">
                    <button
                      type="button"
                      onClick={() => setExpandedDay(isDayExpanded ? null : group.dateKey)}
                      className="flex items-center justify-between gap-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded"
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-1.5">
                        <span className="inline-flex shrink-0 items-center gap-1.25 text-xs font-semibold sm:text-sm">
                          <CalendarDays className="size-3 shrink-0 text-muted-foreground sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                          {dateLabel(group.dateKey)}
                        </span>
                        <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
                          <span className="rounded-full bg-destructive/15 px-2 py-1 text-micro-lg leading-none sm:text-xs font-semibold text-destructive">
                            검토 : {reviewingCount}건
                          </span>
                          <span className="rounded-full bg-ok/15 px-2 py-1 text-micro-lg leading-none sm:text-xs font-semibold text-ok">
                            적용 : {appliedCount}건
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
                        {group.items.map((item) => {
                          const isItemExpanded = expandedId === item.id;
                          const isReceived = item.kind === "received";
                          const received = isReceived ? (item.data as MyOutputPenItem) : null;
                          // 버튼 자체는 항상 보여주되(사용자 지시), 이미 관리자가 최종
                          // 처리(적용/유예/반려)했거나 대상자가 이미 응답을 제출한
                          // 건이면 눌러도 무효이므로 비활성화한다.
                          const canRespond =
                            isReceived && received!.reviewStatus === "pending" && !received!.targetResponse;
                          return (
                            <div key={item.id} className="flex flex-col gap-2.5 rounded-lg border bg-card p-3">
                              <div className="flex items-center justify-between gap-2">
                                <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                                  <User className="size-3 shrink-0 text-muted-foreground sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                                  {new Date(item.ts).toLocaleString("ko-KR")}
                                </span>
                                <div className="flex items-center gap-1.5">
                                  {isReceived ? (
                                    received!.targetResponse === "disputed" ? (
                                      <TintedPill tone="primary">이의제기함</TintedPill>
                                    ) : received!.targetResponse === "recognized" ? (
                                      <TintedPill
                                        tone="primary"
                                        className="bg-violet-600/15 text-violet-600 dark:bg-violet-400/15 dark:text-violet-400"
                                      >
                                        위반인정함
                                      </TintedPill>
                                    ) : (
                                      <TintedPill tone="warn">응답 대기 중</TintedPill>
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
                                          시간차감
                                        </span>
                                        <SubRow
                                          label="응답일시"
                                          value={
                                            received!.targetRespondedAt
                                              ? new Date(received!.targetRespondedAt).toLocaleString("ko-KR")
                                              : "-"
                                          }
                                        />
                                        <SubRow
                                          label="예상차감"
                                          value={(() => {
                                            const confirmed = received!.penalty?.deductedMinutes;
                                            if (confirmed !== undefined && confirmed !== null) {
                                              return formatDeductedTime(confirmed);
                                            }
                                            const expected = expectedDeductedMinutes(received!);
                                            if (expected !== null) return formatDeductedTime(expected);
                                            return "대상자 응답 대기 중";
                                          })()}
                                          valueClassName="text-destructive"
                                        />
                                      </div>

                                      <div className="h-px w-full bg-border" />

                                      <div className="flex flex-col gap-1.5">
                                        <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                                          <Gavel className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                          벌점 · 페널티 변동
                                        </span>
                                        <SubRow
                                          label="적용 시"
                                          value={
                                            received!.penalty
                                              ? occurrenceLabel(received!.penalty.occurrence)
                                              : occurrenceLabel(received!.nextOccurrence)
                                          }
                                          valueClassName="font-semibold text-destructive"
                                        />
                                        <SubRow
                                          label="이번 주 영향"
                                          value={weeklyImpactLabel(
                                            received!.penalty ? received!.penalty.occurrence : received!.nextOccurrence,
                                            received!.weeklyMinorPenaltyCount
                                          )}
                                        />
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
