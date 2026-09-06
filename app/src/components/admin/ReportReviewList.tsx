import { useEffect, useState } from "react";
import { Flag, ChevronDown, CalendarDays, FileText, Clock, Gavel, Image as ImageIcon, User, Users, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { InfoCard, SubRow, TintedPill } from "@/components/dashboard/shared";
import { SectionHeader, CapturePreview, AdminListSkeleton } from "@/components/admin/shared";
import { useApi } from "@/hooks/useApi";
import { useRefreshOnVisible } from "@/hooks/useRefreshOnVisible";
import { usePullRefreshListener } from "@/hooks/usePullToRefresh";
import { useAuth } from "@/lib/auth/useAuth";
import { ICON_STROKE, cn } from "@/lib/utils";
import type {
  CaptureReviewItem,
  CapturesListResponse,
  CaptureDecideResponse,
  CaptureDeleteResponse,
  CaptureRevertResponse,
  CaptureVoteResponse,
  OutputPenaltyResult,
  ReportMeritResult,
} from "@/lib/api/types";

// "적용"/"페널티 적용 (불가)" 결정 한 건의 화면 상태 — 대상자 페널티(있을 수도,
// 없을 수도 있음)와 제보자 제보상점(둘 다 실패할 수 있어 error만 남을 수 있음)을
// 함께 들고 있어야 "취소"/"폐기" 시 무엇을 되돌려야 하는지 알 수 있다.
type AppliedResult = {
  penalty: OutputPenaltyResult | null;
  merit: ReportMeritResult | { error: string } | null;
};

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
// 페널티로 확정, 미만이면 반려로 본다.
const SEVERITY_LEVELS = [
  { value: "high", label: "상", weight: 3 },
  { value: "mid", label: "중", weight: 2 },
  { value: "low", label: "하", weight: 1 },
  { value: "none", label: "위반 아님", weight: 0 },
] as const;
const CONSENSUS_THRESHOLD = 2;

// 🔧 2026-09: "다른 관리자" = 현재 임명된 부스터디장 전원(최대 2명, 사용자
// 확인) — 더 이상 더미가 아니라 GET /admin/captures가 내려주는 실제 명단
// (coReviewers)과 각 항목의 실제 제출 값(item.votes, POST
// /admin/captures/vote로 부스터디장 본인이 직접 제출)이다. 부스터디장이
// 0명이면 대조할 대상이 없으므로 ConsensusSection이 체크박스 자체를
// 비활성화한다.
type CoReviewer = { number: string; name: string };
type VoteMap = Record<string, { name: string; severity: string; votedAt: number }>;

// 본인(주 관리자) + 실제 부스터디장들의 제출 현황으로 평균 가중치와 확정/
// 반려 여부를 계산한다. 전원 제출 전에는 average가 null — "항상 전원 동의
// 필수"(사용자 지시)라 한 명이라도 미제출이면 확정 버튼이 열리지 않는다.
function computeConsensus(myVote: string | undefined, coReviewers: CoReviewer[], votes: VoteMap) {
  const allSubmitted = !!myVote && coReviewers.every((m) => votes[m.number]);
  if (!allSubmitted) return { allSubmitted: false, average: null, willApprove: false };
  const values = [myVote, ...coReviewers.map((m) => votes[m.number].severity)];
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

// 🔧 [3버튼 재설계] 사용자 확정: "반려 (인정)" 버튼을 따로 만들지 않고,
// "적용" 버튼 하나가 상황에 따라 라벨과 동작을 바꾼다 — 벌점 상황이면
// "벌점 적용"(decision: approved), 페널티 상황이면 "페널티 적용"(decision:
// approved), 잔여 슬롯이 없어 등록 자체가 불가능하면 "페널티 적용 (불가)"
// 로 보여주고 클릭 시 반려(인정)과 동일하게 decision: "rejected_recognized"를
// 보낸다(대상자 처리 없이 제보자 상점만 부여).
function applyButtonLabel(occurrence: number | null): string {
  if (occurrence === null) return "페널티 적용 (불가)";
  if (occurrence === 2 || occurrence === 3 || occurrence === 5) return "벌점 적용";
  if (occurrence === 4 || occurrence === 6) return "페널티 적용";
  return "구두경고 적용"; // occurrence === 1
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
// "처리 대기"로 보이는 문제가 있다. "rejected_recognized"(반려·인정 — 대상자
// 슬롯이 없어 제보자 상점만 부여됨)는 대상자 관점에서는 아무 조치가 없었으므로
// "적용"이 아니라 "반려" 뱃지로 묶는다 — applied 맵에는 취소를 위해 여전히
// 들어 있지만(제보상점을 되돌려야 하므로), penalty 필드가 없으면(=대상자
// 처리가 없었으면) "적용"으로 치지 않는다.
function isItemApplied(item: CaptureReviewItem, applied: Record<string, AppliedResult>): boolean {
  return !!applied[item.id]?.penalty || item.reviewStatus === "approved";
}
function isItemRejected(item: CaptureReviewItem, applied: Record<string, AppliedResult>, rejected: Record<string, unknown>): boolean {
  return (
    !!rejected[item.id] ||
    (!!applied[item.id] && !applied[item.id].penalty) ||
    item.reviewStatus === "rejected" ||
    item.reviewStatus === "rejected_recognized"
  );
}

// 요일 그룹 내부 표시 순서 — "처리 대기" → "처리 완료" → "처리 반려".
function statusRank(item: CaptureReviewItem, applied: Record<string, AppliedResult>, rejected: Record<string, unknown>) {
  if (isItemApplied(item, applied)) return 1;
  if (isItemRejected(item, applied, rejected)) return 2;
  return 0;
}

// 다른 섹션(제보 정보/시간 차감/벌점·페널티 변동)과 같은 톤으로 맞춘 합의
// 투표 섹션 — 아이콘+제목 헤더, SubRow 들여쓰기, 얇은 필셋 버튼만 사용하고
// 별도 배경 박스는 두지 않는다. 주 관리자는 본인 판단과 실제 부스터디장들의
// 제출 현황(읽기 전용 — 그들 본인의 화면에서만 값을 바꿀 수 있다)을 함께
// 본다. 부스터디장이 한 명도 없으면 대조할 대상이 없으므로 체크박스 자체를
// 막는다.
function ConsensusSection({
  isConsensus,
  onToggleConsensus,
  myVote,
  onMyVoteChange,
  coReviewers,
  votes,
}: {
  isConsensus: boolean;
  onToggleConsensus: (checked: boolean) => void;
  myVote: string | undefined;
  onMyVoteChange: (value: string | undefined) => void;
  coReviewers: CoReviewer[];
  votes: VoteMap;
}) {
  const { allSubmitted, average, willApprove } = computeConsensus(myVote, coReviewers, votes);
  const noCoReviewers = coReviewers.length === 0;

  return (
    <div className="flex flex-col gap-1.5">
      <Label className={cn("justify-start", noCoReviewers && "opacity-50")}>
        <Checkbox checked={isConsensus && !noCoReviewers} disabled={noCoReviewers} onCheckedChange={onToggleConsensus} />
        <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
          <Users className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
          다른 관리자 의견 반영
        </span>
      </Label>

      {noCoReviewers && (
        <p className="pl-5 text-micro-lg text-muted-foreground sm:pl-5.5 sm:text-xs">
          현재 임명된 부스터디장이 없습니다.
        </p>
      )}

      {isConsensus && !noCoReviewers && (
        <>
          <SeverityPicker label="내 판단" value={myVote} onChange={onMyVoteChange} />
          {coReviewers.map((m) => (
            <SeverityPicker key={m.number} label={m.name} value={votes[m.number]?.severity} readOnly />
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

// 위반 수준 4단계를 고르는 컴팩트 필셋. 주 관리자가 다른 부스터디장의
// 제출값을 보는 행은 readOnly로 클릭을 막는다 — 그 값은 그 부스터디장
// 본인의 화면(POST /admin/captures/vote)에서만 바꿀 수 있다. 값이 아직
// 없으면(미제출) "대기 중"으로 보여준다.
function SeverityPicker({
  label,
  value,
  onChange,
  readOnly,
}: {
  label: string;
  value: string | undefined;
  onChange?: (value: string | undefined) => void;
  readOnly?: boolean;
}) {
  if (readOnly) {
    const level = SEVERITY_LEVELS.find((l) => l.value === value);
    return (
      <div className="flex items-center justify-between gap-2 pl-5 sm:pl-5.5">
        <span className="text-micro-lg text-muted-foreground before:mr-1 before:content-['└'] sm:text-xs">{label}</span>
        <span className={cn("text-micro-lg font-semibold sm:text-xs", level ? "text-primary" : "text-muted-foreground/50")}>
          {level ? level.label : "대기 중"}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2 pl-5 sm:pl-5.5">
      <span className="text-micro-lg text-muted-foreground before:mr-1 before:content-['└'] sm:text-xs">{label}</span>
      <div className="flex gap-1">
        {SEVERITY_LEVELS.map((level) => (
          <button
            key={level.value}
            type="button"
            onClick={() => onChange?.(value === level.value ? undefined : level.value)}
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
  const { session, isAdmin } = useAuth();

  const [items, setItems] = useState<CaptureReviewItem[] | null>(null);
  // 🔧 2026-09: 실제 부스터디장(공동 검토자) 명단과, 이 세션이 그중 누구인지
  // (isAdmin이 아닐 때만 값이 옴) — GET /admin/captures 응답에 함께 실려온다.
  const [coReviewers, setCoReviewers] = useState<CoReviewer[]>([]);
  const [myMemberNumber, setMyMemberNumber] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [votingId, setVotingId] = useState<string | null>(null);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // "적용"(벌점/페널티 적용) 또는 "페널티 적용 (불가)"(반려·인정 — 대상자
  // 처리 없이 제보자 상점만 부여)로 처리된 항목을 목록에서 지우지 않고
  // 그 자리에 남겨 "취소" 버튼으로 전환한다 — 관리자가 오적용을 바로
  // 바로잡을 수 있게. 새로고침하면 초기화되는 화면 상태로만 관리한다
  // (봇 연결 전까지는 서버가 이 상태를 별도로 기억하지 않음).
  const [applied, setApplied] = useState<Record<string, AppliedResult>>({});
  // 순수 반려("rejected" — 미인정, 시트에 아무것도 쓰지 않음)도 승인과
  // 동일하게 목록에서 지우지 않고 화면 상태로만 표시한다("처리 반려" 뱃지)
  // — "반려 취소"를 누르면 이 항목만 지워 "처리 대기"로 되돌린다(서버
  // 되돌림 불필요).
  const [rejected, setRejected] = useState<Record<string, true>>({});
  // 화각 요청 발신·회신 시각(HH:MM) — 항목별로 관리자가 입력. 20분 초과분이
  // 개인 탭 27행(보정 학습시간)에서 차감된다.
  const [sendTimes, setSendTimes] = useState<Record<string, string>>({});
  const [replyTimes, setReplyTimes] = useState<Record<string, string>>({});
  // "다른 관리자 의견 반영" — 체크하면 주 관리자가 먼저 위반 수준을 고르고,
  // 실제 부스터디장들의 제출 현황을 모아 평균 가중치로 확정/반려를 가리는
  // 합의 모드로 전환한다. 부스터디장 값은 item.votes로 서버에서 오며(그들
  // 본인이 자신의 화면에서 제출), "항상 전원 동의 필수"(사용자 지시)라
  // 한 명이라도 미제출이면 승인/반려 버튼이 열리지 않는다.
  const [consensusEnabled, setConsensusEnabled] = useState<Record<string, boolean>>({});
  const [severityLevel, setSeverityLevel] = useState<Record<string, string>>({});
  // 부스터디장 본인 화면에서만 쓰는 "아직 제출 안 한 임시 선택값" — 제출
  // 버튼을 눌러야 서버(item.votes)에 반영된다.
  const [coReviewerDraft, setCoReviewerDraft] = useState<Record<string, string>>({});

  function load() {
    setLoading(true);
    setError(null);
    call<CapturesListResponse>("/admin/captures")
      .then((data) => {
        setItems(data.items || []);
        setCoReviewers(data.coReviewers || []);
        setMyMemberNumber(data.myMemberNumber ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "제보 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 다른 학생이 이 탭을 벗어난 사이에 새 제보를 넣을 수 있어, 승인 대기열은
  // 관리자가 이 탭으로 돌아올 때마다 새로 불러와야 방금 들어온 제보를 놓치지 않는다.
  useRefreshOnVisible(visible, load);
  usePullRefreshListener(visible, load);

  // 부스터디장(공동 검토자) 본인이 위반 수준 의견을 제출한다 — 성공하면
  // 서버에 실제 저장된 값을 다시 불러와 반영한다(다른 회원 임명 변경과
  // 같은 write-then-reload 패턴, MemberRosterList의 toggleViceLeader 참고).
  function submitVote(item: CaptureReviewItem, severity: string) {
    setVotingId(item.id);
    setError(null);
    call<CaptureVoteResponse>("/admin/captures/vote", { method: "POST", body: { id: item.id, severity } })
      .then(load)
      .catch((err) => setError(err instanceof Error ? err.message : "의견 제출에 실패했습니다."))
      .finally(() => setVotingId(null));
  }

  function decide(item: CaptureReviewItem, decision: "approved" | "rejected" | "rejected_recognized") {
    setDecidingId(item.id);
    setError(null);
    call<CaptureDecideResponse>("/admin/captures/decide", {
      method: "POST",
      body: {
        id: item.id,
        decision,
        nickname: item.nickname,
        reporterEmail: item.reporterEmail,
        reason: item.reason,
        ts: item.ts,
        sendTime: sendTimes[item.id] || "",
        replyTime: replyTimes[item.id] || "",
      },
    })
      .then((data) => {
        if (decision === "rejected") {
          setRejected((prev) => ({ ...prev, [item.id]: true }));
        } else {
          setApplied((prev) => ({
            ...prev,
            [item.id]: { penalty: data.penalty ?? null, merit: data.merit ?? null },
          }));
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "처리에 실패했습니다."))
      .finally(() => setDecidingId(null));
  }

  // "반려 취소" — 사용자 지시: 다시 벌점/페널티 여부를 판단할 수 있도록
  // "처리 대기"로 되돌리는 것이 목표. 순수 반려("rejected")는 시트에 아무것도
  // 쓰지 않았으므로 봇 manifest만 pending으로 되돌리면 되지만, "반려 (인정)"
  // (rejected_recognized)은 이미 제보자에게 제보상점이 부여됐을 수 있어
  // 그 슬롯도 함께 회수해야 한다 — 그러지 않으면 다시 판단하는 동안 상점만
  // 남는 불일치가 생긴다. 새로고침 후에도 동작해야 하므로(서버가 내려준
  // item.reviewStatus 기준으로도 눌릴 수 있어야 함) 로컬 상태만으로는 부족해
  // 서버에 /admin/captures/revert를 호출한다.
  function revertReject(item: CaptureReviewItem) {
    const result = applied[item.id];
    const meritToCancel = result?.merit && !("error" in result.merit) ? result.merit : null;
    setDecidingId(item.id);
    setError(null);
    call<CaptureRevertResponse>("/admin/captures/revert", {
      method: "POST",
      body: { id: item.id, merit: meritToCancel },
    })
      .then(() => {
        setRejected((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
        setApplied((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
        // item.reviewStatus는 서버 응답 스냅샷이라 이 세션의 items 배열도
        // 함께 "pending"으로 바꿔야, 새로고침 없이도 즉시 "처리 대기"로
        // 보이고 승인/반려 버튼이 다시 나타난다.
        setItems((prev) =>
          prev ? prev.map((i) => (i.id === item.id ? { ...i, reviewStatus: "pending" } : i)) : prev
        );
      })
      .catch((err) => setError(err instanceof Error ? err.message : "반려 취소에 실패했습니다."))
      .finally(() => setDecidingId(null));
  }

  // 합의 모드가 꺼져 있으면 항상 처리 가능, 켜져 있으면 전원 제출이 끝나야 처리 가능.
  function canDecide(item: CaptureReviewItem): boolean {
    if (!consensusEnabled[item.id]) return true;
    return computeConsensus(severityLevel[item.id], coReviewers, item.votes || {}).allSubmitted;
  }

  // "적용"/"페널티 적용 (불가)"를 되돌린다. 대상자 페널티(penalty)가 있으면
  // 기존 cancel-penalty로, 제보자 제보상점(merit — error가 아닌 실제 기록)이
  // 있으면 새 cancel-merit으로 각각 되돌린다. 두 시트 반영이 서로 다른
  // 실패 지점이라(예: 페널티는 있는데 제보상점 부여가 실패했을 수 있음)
  // 독립적으로 처리한다.
  function cancel(item: CaptureReviewItem) {
    const result = applied[item.id];
    if (!result) return;
    const meritToCancel = result.merit && !("error" in result.merit) ? result.merit : null;
    if (!result.penalty && !meritToCancel) return;
    setDecidingId(item.id);
    setError(null);
    Promise.all([
      result.penalty
        ? call<{ ok: boolean }>("/admin/captures/cancel-penalty", {
            method: "POST",
            body: {
              number: result.penalty.number,
              col: result.penalty.col,
              deductedMinutes: result.penalty.deductedMinutes,
              dayCol: result.penalty.dayCol,
            },
          })
        : Promise.resolve(),
      meritToCancel
        ? call<{ ok: boolean }>("/admin/captures/cancel-merit", {
            method: "POST",
            body: { number: meritToCancel.number, col: meritToCancel.col },
          })
        : Promise.resolve(),
    ])
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

  // 기록 자체를 완전히 말소한다("폐기" — 되돌릴 수 없고 웹에서도 더 이상
  // 보이지 않게 됨, 사용자 확정대로 기존 삭제 경로를 그대로 재사용). "적용"/
  // "페널티 적용 (불가)"로 처리된 항목이면 시트에 반영된 페널티·제보상점을
  // 함께 취소되도록 정보를 같이 보낸다.
  function deleteCapture(item: CaptureReviewItem) {
    if (!window.confirm("이 제보 기록을 완전히 삭제할까요? 되돌릴 수 없습니다.")) return;
    setDeletingId(item.id);
    setError(null);
    const result = applied[item.id];
    const meritToCancel = result?.merit && !("error" in result.merit) ? result.merit : null;
    call<CaptureDeleteResponse>("/admin/captures/delete", {
      method: "POST",
      body: { id: item.id, penalty: result?.penalty || null, merit: meritToCancel },
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
      <CollapsiblePanel className="flex flex-col gap-4">
        <div className="h-px w-full bg-border" />
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading && !items && <AdminListSkeleton />}

        {!loading && items && items.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">검토 대기 중인 제보가 없습니다.</p>
        )}

        {items && items.length > 0 && (
          <div className="flex flex-col gap-2 sm:gap-2.5">
            {groupByDay(items).map((group) => {
              const isDayExpanded = expandedDay === group.day;
              const appliedCount = group.items.filter((item) => isItemApplied(item, applied)).length;
              const rejectedCount = group.items.filter((item) => isItemRejected(item, applied, rejected)).length;
              const pendingCount = group.items.length - appliedCount - rejectedCount;
              return (
                <InfoCard key={group.day} className="flex flex-col gap-2.5 bg-card">
                  <button
                    type="button"
                    onClick={() => setExpandedDay(isDayExpanded ? null : group.day)}
                    className="flex items-center justify-between gap-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded"
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      <span className="inline-flex shrink-0 items-center gap-1.25 text-xs font-semibold sm:text-sm">
                        <CalendarDays className="size-3 shrink-0 text-muted-foreground sm:size-3.5" strokeWidth={ICON_STROKE.default} />
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
                        const isRejected = isItemRejected(item, applied, rejected);
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
                                  <TintedPill tone="amber">
                                    {(applied[item.id] && !applied[item.id].penalty) || item.reviewStatus === "rejected_recognized"
                                      ? "반려 (인정)"
                                      : "반려"}
                                  </TintedPill>
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

                            {isMemberExpanded && !isAdmin && (
                              // 🔧 2026-09: 부스터디장(공동 검토자) 전용 제한 뷰 — 스크린샷·
                              // 제보 정보는 읽기 전용으로 그대로 보여주되, 시간 차감/벌점
                              // 변동/승인·반려/삭제 등 시트를 직접 바꾸는 관리자 액션은 전혀
                              // 노출하지 않는다. 대신 본인 위반 수준 의견만 제출할 수 있다.
                              <>
                                <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:gap-3.5 sm:p-5">
                                  <div className="flex flex-col gap-1.5">
                                    <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                                      <ImageIcon className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                      제보 내용
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
                                      <FileText className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                      제보 정보
                                    </span>
                                    <SubRow label="사유" value={item.reason || "-"} />
                                    <SubRow label="제보자" value={item.reporterName || item.reporterEmail || "-"} />
                                    <SubRow label="발생일시" value={new Date(item.ts).toLocaleString("ko-KR")} />
                                  </div>
                                </div>

                                {!isApplied && !isRejected && (
                                  <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:gap-3.5 sm:p-5">
                                    <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                                      <Users className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                      내 의견
                                    </span>
                                    {(() => {
                                      const currentValue =
                                        coReviewerDraft[item.id] ?? item.votes?.[myMemberNumber || ""]?.severity;
                                      return (
                                        <>
                                          <SeverityPicker
                                            label="위반 수준"
                                            value={currentValue}
                                            onChange={(value) =>
                                              setCoReviewerDraft((prev) => {
                                                const next = { ...prev };
                                                if (value === undefined) delete next[item.id];
                                                else next[item.id] = value;
                                                return next;
                                              })
                                            }
                                          />
                                          <Button
                                            variant="outline"
                                            className="sm:h-11 sm:text-base"
                                            disabled={votingId === item.id || !currentValue}
                                            onClick={() => currentValue && submitVote(item, currentValue)}
                                          >
                                            의견 제출
                                          </Button>
                                        </>
                                      );
                                    })()}
                                  </div>
                                )}
                              </>
                            )}

                            {isMemberExpanded && isAdmin && (
                              <>
                                <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:gap-3.5 sm:p-5">
                                  <div className="flex flex-col gap-1.5">
                                    <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                                      <ImageIcon className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                      제보 내용
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
                                      <FileText className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                      제보 정보
                                    </span>
                                    <SubRow label="사유" value={item.reason || "-"} />
                                    <SubRow label="제보자" value={item.reporterName || item.reporterEmail || "-"} />
                                    <SubRow label="발생일시" value={new Date(item.ts).toLocaleString("ko-KR")} />
                                  </div>

                                  <div className="h-px w-full bg-border" />

                                  <div className="flex flex-col gap-1.5">
                                    <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                                      <Clock className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
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
                                          disabled={isApplied}
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
                                          disabled={isApplied}
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
                                    {applied[item.id]?.penalty && applied[item.id]!.penalty!.deductedMinutes > 0 && (
                                      <SubRow
                                        label="학습시간 차감"
                                        value={`-${applied[item.id]!.penalty!.deductedMinutes}분`}
                                        valueClassName="text-destructive"
                                      />
                                    )}
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
                                        applied[item.id]?.penalty
                                          ? occurrenceLabel(applied[item.id]!.penalty!.occurrence)
                                          : occurrenceLabel(item.nextOccurrence)
                                      }
                                      valueClassName="font-semibold text-foreground"
                                    />
                                    <SubRow
                                      label="이번 주 영향"
                                      value={weeklyImpactLabel(
                                        applied[item.id]?.penalty ? applied[item.id]!.penalty!.occurrence : item.nextOccurrence
                                      )}
                                    />
                                    {applied[item.id] && !applied[item.id]!.penalty && (
                                      <SubRow label="대상자 처리" value="없음 (잔여 슬롯 없어 미등록)" />
                                    )}
                                    {applied[item.id]?.merit && (
                                      <SubRow
                                        label="제보자 상점"
                                        value={
                                          "error" in applied[item.id]!.merit!
                                            ? "부여 실패"
                                            : `${(applied[item.id]!.merit as ReportMeritResult).occurrence}차 슬롯 부여`
                                        }
                                        valueClassName={"error" in applied[item.id]!.merit! ? "text-destructive" : undefined}
                                      />
                                    )}
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
                                      coReviewers={coReviewers}
                                      votes={item.votes || {}}
                                    />
                                  </div>
                                )}

                                <div className="grid grid-cols-[1fr_auto] gap-2">
                                  {isApplied ? (
                                    applied[item.id]?.penalty ? (
                                      <Button
                                        variant="outline"
                                        className="sm:h-12 sm:text-base"
                                        disabled={decidingId === item.id}
                                        onClick={() => cancel(item)}
                                      >
                                        {occurrenceLabel(applied[item.id]!.penalty!.occurrence)} 취소
                                      </Button>
                                    ) : (
                                      // 새로고침 등으로 이 세션이 승인 상세 정보(penalty col 등)를
                                      // 들고 있지 않은 경우 — 취소에 필요한 정보가 없어 버튼 자체를
                                      // 숨긴다(잘못 눌러도 동작하지 않는 것보다 안전).
                                      <p className="flex items-center justify-center text-center text-xs text-muted-foreground sm:text-sm">
                                        이미 처리된 제보입니다.
                                      </p>
                                    )
                                  ) : isRejected ? (
                                    // "반려 취소" — 순수 반려("rejected")든 반려 (인정)
                                    // ("rejected_recognized", 제보상점만 부여된 경우)든 항상
                                    // 다시 "처리 대기"로 되돌릴 수 있다(사용자 지시: 다시
                                    // 벌점/페널티 여부를 판단할 수 있어야 함). 부여된 제보상점은
                                    // revertReject 내부에서 함께 회수된다.
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
                                        disabled={decidingId === item.id || !canDecide(item)}
                                        onClick={() =>
                                          decide(item, item.nextOccurrence === null ? "rejected_recognized" : "approved")
                                        }
                                      >
                                        {applyButtonLabel(item.nextOccurrence)}
                                      </Button>
                                      <Button
                                        variant="outline"
                                        className="sm:h-12 sm:text-base"
                                        disabled={decidingId === item.id || !canDecide(item)}
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
