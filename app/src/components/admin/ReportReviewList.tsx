import { useEffect, useState } from "react";
import { Flag, ChevronDown, CalendarDays, FileText, Clock, Gavel, Image as ImageIcon, User, Users, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { InfoCard, SubRow, TintedPill } from "@/components/dashboard/shared";
import { SectionHeader, CapturePreview } from "@/components/admin/shared";
import { useApi } from "@/hooks/useApi";
import { useRefreshOnVisible } from "@/hooks/useRefreshOnVisible";
import { useAuth } from "@/lib/auth/useAuth";
import { ICON_STROKE, cn } from "@/lib/utils";
import type {
  CaptureReviewItem,
  CapturesListResponse,
  CaptureDecideResponse,
  CaptureDeleteResponse,
  OutputPenaltyResult,
} from "@/lib/api/types";

const STATUS_DAYS = ["월", "화", "수", "목", "금", "토", "일"];

// 네이티브 <input type="time">은 OS/브라우저 로케일에 따라 오전/오후(12시간제)
// 표기로 렌더링될 수 있어, 항상 24시간제로 "3:32"처럼 입력하려는 요구와
// 충돌한다(사용자 지적) — 순수 텍스트 입력에 숫자만 받아 "HH:MM"으로 자동
// 정렬하는 방식으로 대체한다. 백엔드(minutesBetween)는 어차피 "H:MM"/"HH:MM"
// 형태의 문자열만 파싱하면 되므로 그대로 호환된다.
function formatTimeInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

// 위반 수준별 가중치(합의 판정용) — 평균 2점(대략 "중" 수준) 이상이면
// 페널티로 확정, 미만이면 반려로 본다. 실제 다중 관리자 투표/집계는 아직
// 없고(관리자가 1명뿐), 여기서는 UI 흐름만 미리 만들어둔다.
const SEVERITY_LEVELS = [
  { value: "high", label: "상", weight: 3 },
  { value: "mid", label: "중", weight: 2 },
  { value: "low", label: "하", weight: 1 },
  { value: "none", label: "위반 아님", weight: 0 },
] as const;
const CONSENSUS_THRESHOLD = 2;

// 🧪 [더미 시뮬레이션] 실제 다중 관리자 인증이 아직 없어, 주 관리자가 "다른
// 관리자들"의 제출 여부/선택값을 직접 토글해 전체 합의 흐름을 미리
// 체험해볼 수 있게 한다. 실제 백엔드가 붙으면 이 두 항목은 서버가 내려주는
// 다른 관리자 목록으로 교체된다.
const DUMMY_OTHER_ADMINS = ["부스터디장", "운영지원"];

// 본인(주 관리자) + 더미 관리자들의 제출 현황으로 평균 가중치와 확정/반려
// 여부를 계산한다. 전원 제출 전에는 average가 null.
function computeConsensus(myVote: string | undefined, votes: Record<string, string>) {
  const allSubmitted = !!myVote && DUMMY_OTHER_ADMINS.every((name) => votes[name]);
  if (!allSubmitted) return { allSubmitted: false, average: null, willApprove: false };
  const values = [myVote, ...DUMMY_OTHER_ADMINS.map((name) => votes[name])];
  const average =
    values.reduce((sum, v) => sum + (SEVERITY_LEVELS.find((l) => l.value === v)?.weight ?? 0), 0) / values.length;
  return { allSubmitted: true, average, willApprove: average >= CONSENSUS_THRESHOLD };
}

// 송출 P 슬롯 차수(1~6차)별로 실제 적용되는 조치가 다르다 — 1차는 구두경고만,
// 2/3/5차는 총 상점에서 벌점만 차감(개인 탭 C35 수식), 4/6차는 실제 송출 P가
// 발생해 예치금 재납 등 페널티로 이어진다(OUTPUT_PEN_P_SLOTS와 동일 기준).
function actionLabel(occurrence: number | null): string {
  if (occurrence === 1) return "구두경고";
  if (occurrence === 2 || occurrence === 3 || occurrence === 5) return "송출 벌점";
  return "송출 페널티";
}

// 버튼 문구용 "N차 (조치명)" 형태. occurrence가 없으면(회원을 못 찾았거나
// 슬롯이 다 찼으면) 차수 없이 조치명만 보여준다.
function occurrenceLabel(occurrence: number | null): string {
  const action = actionLabel(occurrence);
  return occurrence ? `${occurrence}차 (${action})` : action;
}

// "적용 시" 아래에 보여줄 이번 건의 실질적 영향 — 개인 탭 C35(주간 총 상점)
// 수식 기준: 1차는 점수 변동 없음, 2/3/5차는 0.1점 차감, 4/6차는 그 주 상점이
// 전액(0점) 제외 처리된다(제외 조건에 걸림). 실제 상점을 조회하지 않고
// 규칙만 안내하는 문구라, 회원별 정확한 점수 변화량은 아님.
function weeklyImpactLabel(occurrence: number | null): string {
  if (occurrence === 1) return "주간 총 상점 변동 없음";
  if (occurrence === 2 || occurrence === 3 || occurrence === 5) return "주간 총 상점 0.1점 차감";
  if (occurrence === 4 || occurrence === 6) return "주간 총 상점 전액 제외(0점 처리)";
  return "-";
}

// 제보 발생 시각(item.ts)의 요일을 "월"~"일"로 계산한다.
function dayOfTs(ts: number): string {
  const jsDay = new Date(ts).getDay(); // 일=0 ... 토=6
  return STATUS_DAYS[(jsDay + 6) % 7]; // 월=0 ... 일=6으로 보정
}

// 오늘 날짜 기준 이번 주(월~일)의 각 요일 실제 날짜를 "8월 19일" 형태로
// 계산한다(벌금 미납 현황의 thisWeekDateLabel과 동일 패턴).
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

// 같은 요일의 여러 제보를 요일별로 묶는다(벌금 미납 현황의 groupByDay와 동일 패턴).
function groupByDay(items: CaptureReviewItem[]) {
  const map = new Map<string, CaptureReviewItem[]>();
  for (const item of items) {
    const day = dayOfTs(item.ts);
    const existing = map.get(day);
    if (existing) existing.push(item);
    else map.set(day, [item]);
  }
  return STATUS_DAYS.filter((d) => map.has(d)).map((day) => ({ day, items: map.get(day)! }));
}

// "처리 완료/반려" 여부는 이 세션에서 방금 처리한 화면 로컬 상태(applied/
// rejected — 승인 상세 정보를 함께 들고 있어야 해서 우선한다)뿐 아니라,
// 서버가 내려준 item.reviewStatus도 함께 본다 — 그러지 않으면 페이지를
// 완전히 새로고침(F5)했을 때 방금 처리한 항목이 로컬 상태를 잃고 다시
// "처리 대기"로 보이는 문제가 있다.
function isItemApplied(item: CaptureReviewItem, applied: Record<string, unknown>): boolean {
  return !!applied[item.id] || item.reviewStatus === "approved";
}
function isItemRejected(item: CaptureReviewItem, rejected: Record<string, unknown>): boolean {
  return !!rejected[item.id] || item.reviewStatus === "rejected";
}

// 요일 그룹 내부 표시 순서 — "처리 대기" → "처리 완료" → "처리 반려".
function statusRank(item: CaptureReviewItem, applied: Record<string, unknown>, rejected: Record<string, unknown>) {
  if (isItemApplied(item, applied)) return 1;
  if (isItemRejected(item, rejected)) return 2;
  return 0;
}

// 다른 섹션(제보 정보/시간 차감/벌점·페널티 변동)과 같은 톤으로 맞춘 합의
// 투표 섹션 — 아이콘+제목 헤더, SubRow 들여쓰기, 얇은 필셋 버튼만 사용하고
// 별도 배경 박스는 두지 않는다. 주 관리자는 본인 판단과 다른 관리자들의
// 제출 현황을 함께 본다(다른 관리자 값은 아직 인증이 없어 더미 시뮬레이션).
function ConsensusSection({
  isConsensus,
  onToggleConsensus,
  myVote,
  onMyVoteChange,
  otherVotes,
  onOtherVoteChange,
}: {
  isConsensus: boolean;
  onToggleConsensus: (checked: boolean) => void;
  myVote: string | undefined;
  onMyVoteChange: (value: string | undefined) => void;
  otherVotes: Record<string, string>;
  onOtherVoteChange: (name: string, value: string | undefined) => void;
}) {
  const { allSubmitted, average, willApprove } = computeConsensus(myVote, otherVotes);

  return (
    <div className="flex flex-col gap-1.5">
      <Label className="justify-start">
        <Checkbox checked={isConsensus} onCheckedChange={onToggleConsensus} />
        <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
          <Users className="size-3.5 sm:size-4" strokeWidth={ICON_STROKE.default} />
          다른 관리자 의견 반영
        </span>
      </Label>

      {isConsensus && (
        <>
          <SeverityPicker label="내 판단" value={myVote} onChange={onMyVoteChange} />
          {DUMMY_OTHER_ADMINS.map((name) => (
            <SeverityPicker
              key={name}
              label={name}
              value={otherVotes[name]}
              onChange={(value) => onOtherVoteChange(name, value)}
            />
          ))}
          <SubRow
            label="평균 가중치"
            value={
              allSubmitted
                ? `${average!.toFixed(1)}점 → ${willApprove ? "확정" : "반려"}`
                : `전원 제출 대기 중 (기준 ${CONSENSUS_THRESHOLD}점)`
            }
            valueClassName={allSubmitted ? cn("font-semibold", willApprove ? "text-destructive" : "text-foreground") : undefined}
          />
        </>
      )}
    </div>
  );
}

// 위반 수준 4단계를 고르는 컴팩트 필셋. DUMMY 관리자 행은 시뮬레이션용으로
// 주 관리자가 대신 클릭하지만, 표시 형태는 실제 투표 행과 동일하게 둔다.
function SeverityPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 pl-5 sm:pl-5.5">
      <span className="text-micro-lg text-muted-foreground before:mr-1 before:content-['└'] sm:text-xs">{label}</span>
      <div className="flex gap-1">
        {SEVERITY_LEVELS.map((level) => (
          <button
            key={level.value}
            type="button"
            onClick={() => onChange(value === level.value ? undefined : level.value)}
            className={cn(
              "rounded px-1.5 py-0.5 text-micro-lg font-semibold transition-colors sm:text-xs",
              value === level.value ? "bg-primary/15 text-primary" : "text-muted-foreground/50"
            )}
          >
            {level.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ReportReviewList({ visible }: { visible: boolean }) {
  const { call } = useApi();
  const { session } = useAuth();

  const [items, setItems] = useState<CaptureReviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 승인 완료된 항목을 목록에서 지우지 않고 그 자리에 남겨 "{조치} 취소"
  // 버튼으로 전환한다 — 관리자가 오적용을 바로 바로잡을 수 있게. 새로고침하면
  // 초기화되는 화면 상태로만 관리한다(봇 연결 전까지는 서버가 이 상태를
  // 별도로 기억하지 않음).
  const [applied, setApplied] = useState<Record<string, OutputPenaltyResult>>({});
  // 반려도 승인과 동일하게 목록에서 지우지 않고 화면 상태로만 표시한다
  // ("처리 반려" 뱃지) — "반려 취소"를 누르면 이 항목만 지워 "처리 대기"로
  // 되돌린다(반려 시점에는 시트에 아무것도 쓰지 않으므로 서버 되돌림은 불필요).
  const [rejected, setRejected] = useState<Record<string, true>>({});
  // 화각 요청 발신·회신 시각(HH:MM) — 항목별로 관리자가 입력. 20분 초과분이
  // 개인 탭 27행(보정 학습시간)에서 차감된다.
  const [sendTimes, setSendTimes] = useState<Record<string, string>>({});
  const [replyTimes, setReplyTimes] = useState<Record<string, string>>({});
  // "다른 관리자 의견 반영" — 체크하면 주 관리자가 먼저 위반 수준을 고르고,
  // 다른 관리자들의 의견을 모아 평균 가중치로 확정/반려를 가리는 합의 모드로
  // 전환한다. 주 관리자는 자신을 포함한 전원의 선택을 볼 수 있고(보조
  // 관리자는 자기 선택만 보임 — 별도 뷰), 전원 제출이 끝나야 승인/반려
  // 버튼이 열린다. 다른 관리자 값은 아직 실제 인증이 없어 더미로 시뮬레이션.
  const [consensusEnabled, setConsensusEnabled] = useState<Record<string, boolean>>({});
  const [severityLevel, setSeverityLevel] = useState<Record<string, string>>({});
  // itemId -> adminName -> 선택값(제출 안 했으면 키 자체가 없음)
  const [otherAdminVotes, setOtherAdminVotes] = useState<Record<string, Record<string, string>>>({});

  function load() {
    setLoading(true);
    setError(null);
    call<CapturesListResponse>("/admin/captures")
      .then((data) => setItems(data.items || []))
      .catch((err) => setError(err instanceof Error ? err.message : "제보 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 다른 학생이 이 탭을 벗어난 사이에 새 제보를 넣을 수 있어, 승인 대기열은
  // 관리자가 이 탭으로 돌아올 때마다 새로 불러와야 방금 들어온 제보를 놓치지 않는다.
  useRefreshOnVisible(visible, load);

  function decide(item: CaptureReviewItem, decision: "approved" | "rejected") {
    setDecidingId(item.id);
    setError(null);
    call<CaptureDecideResponse>("/admin/captures/decide", {
      method: "POST",
      body: {
        id: item.id,
        decision,
        nickname: item.nickname,
        reason: item.reason,
        ts: item.ts,
        sendTime: sendTimes[item.id] || "",
        replyTime: replyTimes[item.id] || "",
      },
    })
      .then((data) => {
        if (data.penalty) {
          setApplied((prev) => ({ ...prev, [item.id]: data.penalty! }));
        } else {
          setRejected((prev) => ({ ...prev, [item.id]: true }));
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "처리에 실패했습니다."))
      .finally(() => setDecidingId(null));
  }

  // 반려는 시트에 아무것도 쓰지 않으므로, 취소도 서버 호출 없이 화면 상태만 되돌린다.
  function revertReject(item: CaptureReviewItem) {
    setRejected((prev) => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
  }

  // 합의 모드가 꺼져 있으면 항상 처리 가능, 켜져 있으면 전원 제출이 끝나야 처리 가능.
  function canDecide(itemId: string): boolean {
    if (!consensusEnabled[itemId]) return true;
    return computeConsensus(severityLevel[itemId], otherAdminVotes[itemId] || {}).allSubmitted;
  }

  function cancel(item: CaptureReviewItem) {
    const penalty = applied[item.id];
    if (!penalty) return;
    setDecidingId(item.id);
    setError(null);
    call<{ ok: boolean }>("/admin/captures/cancel-penalty", {
      method: "POST",
      body: {
        number: penalty.number,
        col: penalty.col,
        deductedMinutes: penalty.deductedMinutes,
        dayCol: penalty.dayCol,
      },
    })
      .then(() => {
        setApplied((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
      })
      .catch((err) => setError(err instanceof Error ? err.message : "취소에 실패했습니다."))
      .finally(() => setDecidingId(null));
  }

  // 기록 자체를 완전히 말소한다(되돌릴 수 없음). "적용"된 항목이면 시트에
  // 반영된 페널티도 함께 취소되도록 penalty 정보를 같이 보낸다.
  function deleteCapture(item: CaptureReviewItem) {
    if (!window.confirm("이 제보 기록을 완전히 삭제할까요? 되돌릴 수 없습니다.")) return;
    setDeletingId(item.id);
    setError(null);
    call<CaptureDeleteResponse>("/admin/captures/delete", {
      method: "POST",
      body: { id: item.id, penalty: applied[item.id] || null },
    })
      .then(() => {
        setItems((prev) => (prev ? prev.filter((i) => i.id !== item.id) : prev));
        setApplied((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
        setRejected((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
      })
      .catch((err) => setError(err instanceof Error ? err.message : "삭제에 실패했습니다."))
      .finally(() => setDeletingId(null));
  }

  return (
    <Collapsible defaultOpen className="flex flex-col gap-4">
      <SectionHeader icon={Flag} title="송출 P 대상 처리" loading={loading} onRefresh={load} />
      <div className="h-px w-full bg-border" />
      <CollapsiblePanel className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading && !items && (
          <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">불러오는 중...</p>
        )}

        {!loading && items && items.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">검토 대기 중인 제보가 없습니다.</p>
        )}

        {items && items.length > 0 && (
          <div className="flex flex-col gap-2 sm:gap-2.5">
            {groupByDay(items).map((group) => {
              const isDayExpanded = expandedDay === group.day;
              const appliedCount = group.items.filter((item) => isItemApplied(item, applied)).length;
              const rejectedCount = group.items.filter((item) => isItemRejected(item, rejected)).length;
              const pendingCount = group.items.length - appliedCount - rejectedCount;
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
                        <span className="rounded-full bg-destructive/15 px-2 py-1 text-micro-lg leading-none sm:text-xs font-semibold text-destructive">
                          대기 : {pendingCount}건
                        </span>
                        <span className="rounded-full bg-ok/15 px-2 py-1 text-micro-lg leading-none sm:text-xs font-semibold text-ok">
                          적용 : {appliedCount}건
                        </span>
                        <span className="rounded-full bg-amber-600/15 px-2 py-1 text-micro-lg leading-none sm:text-xs font-semibold text-amber-600 dark:bg-amber-400/15 dark:text-amber-400">
                          반려 : {rejectedCount}건
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
                      {[...group.items]
                        .sort((a, b) => statusRank(a, applied, rejected) - statusRank(b, applied, rejected))
                        .map((item) => {
                        const isMemberExpanded = expandedId === item.id;
                        const isApplied = isItemApplied(item, applied);
                        const isRejected = isItemRejected(item, rejected);
                        return (
                          <div key={item.id} className="flex flex-col gap-2.5 rounded-lg border bg-card p-3">
                            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                              <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                                <User className="size-3 shrink-0 text-muted-foreground sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                                {item.nickname}
                              </span>
                              <div className="flex items-center gap-1.5">
                                {isApplied ? (
                                  <TintedPill tone="ok">적용</TintedPill>
                                ) : isRejected ? (
                                  <TintedPill tone="amber">반려</TintedPill>
                                ) : (
                                  <TintedPill tone="warn">대기</TintedPill>
                                )}
                                <Button
                                  variant="outline"
                                  size="icon-sm"
                                  onClick={() => setExpandedId(isMemberExpanded ? null : item.id)}
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
                                  <div className="flex flex-col gap-1.5">
                                    <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                                      <ImageIcon className="size-3.5 sm:size-4" strokeWidth={ICON_STROKE.default} />
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

                                  <div className="h-px w-full bg-border" />

                                  <div className="flex flex-col gap-1.5">
                                    <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                                      <FileText className="size-3.5 sm:size-4" strokeWidth={ICON_STROKE.default} />
                                      제보 정보
                                    </span>
                                    <SubRow label="사유" value={item.reason || "-"} />
                                    <SubRow label="제보자" value={item.reporterName || item.reporterEmail || "-"} />
                                    <SubRow label="발생일시" value={new Date(item.ts).toLocaleString("ko-KR")} />
                                  </div>

                                  <div className="h-px w-full bg-border" />

                                  <div className="flex flex-col gap-1.5">
                                    <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                                      <Clock className="size-3.5 sm:size-4" strokeWidth={ICON_STROKE.default} />
                                      시간 차감
                                    </span>
                                    <div className="grid grid-cols-2 gap-2 pl-5 sm:pl-5.5">
                                      <label className="flex flex-col gap-1">
                                        <span className="text-micro-lg text-muted-foreground before:mr-1 before:content-['└'] sm:text-xs">
                                          발신시각
                                        </span>
                                        <Input
                                          type="text"
                                          inputMode="numeric"
                                          placeholder="HH:MM"
                                          maxLength={5}
                                          value={sendTimes[item.id] || ""}
                                          disabled={!!applied[item.id]}
                                          onChange={(e) =>
                                            setSendTimes((prev) => ({
                                              ...prev,
                                              [item.id]: formatTimeInput(e.target.value),
                                            }))
                                          }
                                          className="sm:h-12 sm:text-base md:text-base"
                                        />
                                      </label>
                                      <label className="flex flex-col gap-1">
                                        <span className="text-micro-lg text-muted-foreground before:mr-1 before:content-['└'] sm:text-xs">
                                          회신시각
                                        </span>
                                        <Input
                                          type="text"
                                          inputMode="numeric"
                                          placeholder="HH:MM"
                                          maxLength={5}
                                          value={replyTimes[item.id] || ""}
                                          disabled={!!applied[item.id]}
                                          onChange={(e) =>
                                            setReplyTimes((prev) => ({
                                              ...prev,
                                              [item.id]: formatTimeInput(e.target.value),
                                            }))
                                          }
                                          className="sm:h-12 sm:text-base md:text-base"
                                        />
                                      </label>
                                    </div>
                                    {applied[item.id] && applied[item.id].deductedMinutes > 0 && (
                                      <SubRow
                                        label="학습시간 차감"
                                        value={`-${applied[item.id].deductedMinutes}분`}
                                        valueClassName="text-destructive"
                                      />
                                    )}
                                  </div>

                                  <div className="h-px w-full bg-border" />

                                  <div className="flex flex-col gap-1.5">
                                    <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                                      <Gavel className="size-3.5 sm:size-4" strokeWidth={ICON_STROKE.default} />
                                      벌점 · 페널티 변동
                                    </span>
                                    <SubRow
                                      label="적용 시"
                                      value={
                                        applied[item.id]
                                          ? occurrenceLabel(applied[item.id].occurrence)
                                          : occurrenceLabel(item.nextOccurrence)
                                      }
                                      valueClassName="font-semibold text-foreground"
                                    />
                                    <SubRow
                                      label="이번 주 영향"
                                      value={weeklyImpactLabel(applied[item.id] ? applied[item.id].occurrence : item.nextOccurrence)}
                                    />
                                  </div>
                                </div>

                                {!isApplied && !isRejected && (
                                  <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:gap-3.5 sm:p-5">
                                    <ConsensusSection
                                      isConsensus={!!consensusEnabled[item.id]}
                                      onToggleConsensus={(checked) =>
                                        setConsensusEnabled((prev) => ({ ...prev, [item.id]: checked }))
                                      }
                                      myVote={severityLevel[item.id]}
                                      onMyVoteChange={(value) =>
                                        setSeverityLevel((prev) => {
                                          const next = { ...prev };
                                          if (value === undefined) delete next[item.id];
                                          else next[item.id] = value;
                                          return next;
                                        })
                                      }
                                      otherVotes={otherAdminVotes[item.id] || {}}
                                      onOtherVoteChange={(name, value) =>
                                        setOtherAdminVotes((prev) => {
                                          const itemVotes = { ...(prev[item.id] || {}) };
                                          if (value === undefined) delete itemVotes[name];
                                          else itemVotes[name] = value;
                                          return { ...prev, [item.id]: itemVotes };
                                        })
                                      }
                                    />
                                  </div>
                                )}

                                <div className="grid grid-cols-[1fr_auto] gap-2">
                                  {isApplied && applied[item.id] ? (
                                    <Button
                                      variant="outline"
                                      className="sm:h-12 sm:text-base"
                                      disabled={decidingId === item.id}
                                      onClick={() => cancel(item)}
                                    >
                                      {occurrenceLabel(applied[item.id].occurrence)} 취소
                                    </Button>
                                  ) : isApplied ? (
                                    // 새로고침 등으로 이 세션이 승인 상세 정보(occurrence 등)를
                                    // 들고 있지 않은 경우 — 취소에 필요한 정보가 없어 버튼
                                    // 자체를 숨긴다(잘못 눌러도 동작하지 않는 것보다 안전).
                                    <p className="flex items-center justify-center text-center text-xs text-muted-foreground sm:text-sm">
                                      이미 처리된 제보입니다.
                                    </p>
                                  ) : isRejected ? (
                                    <Button
                                      variant="outline"
                                      className="sm:h-12 sm:text-base"
                                      disabled={decidingId === item.id}
                                      onClick={() => revertReject(item)}
                                    >
                                      반려 취소
                                    </Button>
                                  ) : (
                                    <div className="grid grid-cols-2 gap-2">
                                      <Button
                                        variant="destructive"
                                        className="sm:h-12 sm:text-base"
                                        disabled={decidingId === item.id || !canDecide(item.id)}
                                        onClick={() => decide(item, "approved")}
                                      >
                                        {occurrenceLabel(item.nextOccurrence)} 적용
                                      </Button>
                                      <Button
                                        variant="outline"
                                        className="sm:h-12 sm:text-base"
                                        disabled={decidingId === item.id || !canDecide(item.id)}
                                        onClick={() => decide(item, "rejected")}
                                      >
                                        반려
                                      </Button>
                                    </div>
                                  )}
                                  <Button
                                    variant="outline"
                                    size="icon"
                                    className="sm:h-12 sm:w-12 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                                    disabled={deletingId === item.id}
                                    onClick={() => deleteCapture(item)}
                                    aria-label="기록 삭제"
                                  >
                                    <Trash2 className="size-4" strokeWidth={ICON_STROKE.default} />
                                  </Button>
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
