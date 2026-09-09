import { useEffect, useState } from "react";
import { Flag, ChevronDown, CalendarDays, FileText, Clock, Gavel, Image as ImageIcon, User, Users, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { DividedValue, InfoCard, SubRow, TintedPill } from "@/components/dashboard/shared";
import { CycleSwitcher } from "@/components/dashboard/CycleSwitcher";
import { SectionHeader, CapturePreview, AdminListSkeleton } from "@/components/admin/shared";
import { useApi } from "@/hooks/useApi";
import { useRefreshOnVisible } from "@/hooks/useRefreshOnVisible";
import { usePollingRefresh } from "@/hooks/usePollingRefresh";
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
  TimeDeductionResult,
} from "@/lib/api/types";

// "적용"/"송출 P 적용 (불가)"/"유예" 결정 한 건의 화면 상태 — 대상자 페널티
// (있을 수도, 없을 수도 있음)와 제보자 제보상점(둘 다 실패할 수 있어 error만
// 남을 수 있음)을 함께 들고 있어야 "취소"/"폐기" 시 무엇을 되돌려야 하는지
// 알 수 있다. decision은 penalty가 없는 경우("rejected_recognized" vs
// "deferred")를 구분해 정확한 뱃지·취소 버튼 문구를 고르는 데 쓴다.
type AppliedResult = {
  decision: "approved" | "rejected_recognized" | "deferred";
  penalty: OutputPenaltyResult | null;
  merit: ReportMeritResult | { error: string } | null;
  // "유예" 결정에서만 채워지는 응답 지연 시간 차감 확정값(벌점과 별개로
  // 적용됨).
  timeDeduction: TimeDeductionResult | null;
};

const STATUS_DAYS = ["월", "화", "수", "목", "금", "토", "일"];

// 위반 수준 판정 — 상/중/하/위반 아님 4단계에서 "위반 O"/"위반 X" 2단계로
// 단순화(사용자 지시).
const SEVERITY_LEVELS = [
  { value: "yes", label: "위반 O" },
  { value: "no", label: "위반 X" },
] as const;
// 총 관리자(스터디장 본인 + 부스터디장 전원) 중 "위반 O" 판단이 이 수 이상이면
// 확정한다(사용자 지시: "총 관리자의 2인 이상이 O로 판단하면 벌점이나
// 페널티가 적용될 수 있도록").
const CONSENSUS_THRESHOLD = 2;

// 🔧 2026-09: "다른 관리자" = 현재 임명된 부스터디장 전원(최대 2명, 사용자
// 확인) — 더 이상 더미가 아니라 GET /admin/captures가 내려주는 실제 명단
// (coReviewers)과 각 항목의 실제 제출 값(item.votes, POST
// /admin/captures/vote로 부스터디장 본인이 직접 제출)이다. 부스터디장이
// 0명이면 대조할 대상이 없으므로 ConsensusSection이 체크박스 자체를
// 비활성화한다.
type CoReviewer = { number: string; name: string };
type VoteMap = Record<string, { name: string; severity: string; votedAt: number }>;

// 본인(스터디장) + 실제 부스터디장들의 제출 현황으로 확정/반려 여부를
// 계산한다. 전원 제출 전에는 판정하지 않는다 — "항상 전원 동의 필수"(사용자
// 지시)라 한 명이라도 미제출이면 확정 버튼이 열리지 않는다. 확정 기준은
// "총 관리자 중 위반 O가 CONSENSUS_THRESHOLD명 이상"(사용자 지시).
function computeConsensus(myVote: string | undefined, coReviewers: CoReviewer[], votes: VoteMap) {
  const allSubmitted = !!myVote && coReviewers.every((m) => votes[m.number]);
  if (!allSubmitted) return { allSubmitted: false, yesCount: null, willApprove: false };
  const values = [myVote, ...coReviewers.map((m) => votes[m.number].severity)];
  const yesCount = values.filter((v) => v === "yes").length;
  return { allSubmitted: true, yesCount, willApprove: yesCount >= CONSENSUS_THRESHOLD };
}

// "처리현황" — "내 화각 불량 제보"(MyOutputPenSection)의 statusLabel과 동일한
// 문구 체계를 관리자 화면 "제보정보"에도 노출한다(사용자 지시). 대상자 응답
// (targetResponse)과 관리자 최종 처리(reviewStatus)를 조합한 상세 텍스트 —
// 대상자가 어떤 응답을 냈고 관리자가 그걸 받아들였는지(승인/미승인)까지
// 그대로 풀어서 보여준다. targetResponse가 없으면 관리자가 이미 처리했어도
// (구조적으로는 가능하나 실제 운영에서는 도달하지 않는 경로) 항상 "대상자
// 응답 대기 중"으로만 표시한다.
function statusLabel(item: CaptureReviewItem): string {
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

// 송출 P 슬롯 차수(1~6차)별로 실제 적용되는 조치가 다르다 — 1차는 구두경고만,
// 2/3/5차는 총 상점에서 벌점만 차감(개인 탭 C35 수식), 4/6차는 실제 송출 P가
// 발생해 예치금 재납 등 페널티로 이어진다(OUTPUT_PEN_P_SLOTS와 동일 기준).
function actionLabel(occurrence: number | null): string {
  if (occurrence === 1) return "구두경고";
  if (occurrence === 2 || occurrence === 3 || occurrence === 5) return "벌점";
  if (occurrence === 4) return "송출 P : 1회";
  if (occurrence === 6) return "송출 P : 2회";
  return "적용 불가 (잔여 슬롯 없음)";
}

// 버튼 문구용 "N차 (조치명)" 형태. occurrence가 없으면(회원을 못 찾았거나
// 슬롯이 다 찼으면) "적용 불가 (잔여 슬롯 없음)"만 보여준다(사용자 지시).
function occurrenceLabel(occurrence: number | null): string {
  const action = actionLabel(occurrence);
  return occurrence ? `${occurrence}차 (${action})` : action;
}

// "취소" 버튼 문구용 — "구두경고 적용 취소"/"송출 벌점 적용 취소"/"송출 P
// 적용 취소"(사용자 확정 형식). applyButtonLabel과 동일한 차수 매핑을 쓴다.
function cancelButtonLabel(occurrence: number | null): string {
  return `${applyButtonLabel(occurrence)} 취소`;
}

// 🔧 [3버튼 재설계] 사용자 확정: "반려 (인정)" 버튼을 따로 만들지 않고,
// "적용" 버튼 하나가 상황에 따라 라벨과 동작을 바꾼다 — 1차는 "구두경고
// 적용", 2/3/5차는 "송출 벌점 적용", 4/6차는 "송출 P 적용"(decision:
// approved), 잔여 슬롯이 없어 등록 자체가 불가능하면 "송출 P 적용 (불가)"
// 로 보여주고 클릭 시 반려(인정)과 동일하게 decision: "rejected_recognized"를
// 보낸다(대상자 처리 없이 제보자 상점만 부여). "취소" 버튼은 occurrenceLabel이
// 아니라 이 함수의 라벨을 그대로 재사용해 "구두경고 적용 취소" 등 요구
// 형식과 정확히 맞춘다.
function applyButtonLabel(occurrence: number | null): string {
  if (occurrence === null) return "송출 P 적용 (불가)";
  if (occurrence === 2 || occurrence === 3 || occurrence === 5) return "송출 벌점 적용";
  if (occurrence === 4 || occurrence === 6) return "송출 P 적용";
  return "구두경고 적용"; // occurrence === 1
}

// "적용 시" 아래에 보여줄 이번 건의 실질적 영향 — 개인 탭 C35(주간 총 상점)
// 수식 기준: 1차는 점수 변동 없음, 4/6차는 송출 P 발생 자체를 알린다.
// 2/3/5차는 고정 0.1점이 아니라 "이번 사이클 2/3/5차 슬롯 개수 × 0.1점"을
// 실제로 계산해 보여준다(weeklyMinorPenaltyCount — attachNextOccurrence가
// 미리 계산해 붙여준 값, 사용자 지시).
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

// 🔧 [버그 수정] 기존에는 dayOfTs가 요일 이름(월~일)만 계산하고
// thisWeekDateLabel이 "오늘이 속한 주"의 그 요일 날짜를 역산해 헤더에
// 붙였다 — "이번 주 대기 건만" 다루던 시절엔 문제없었지만, 지금은 24시간
// 결정 창을 지나서도 pending인 항목이 여러 주에 걸쳐 계속 남을 수 있어
// (사용자 확인: 지난주 테스트 제보가 pending으로 남아 관리자 화면에서
// "이번 주 같은 요일" 헤더 밑에 잘못 합쳐져 보임) 서로 다른 주의 같은
// 요일이 하나로 합쳐지고 헤더 날짜도 실제와 달라지는 문제가 있었다
// (MyOutputPenSection.tsx에서 먼저 발견/수정한 것과 동일한 버그).
// KST 기준 실제 날짜(YYYY-MM-DD)로 그룹핑해 근본적으로 없앤다.
function kstDateKey(ts: number): string {
  return new Date(ts).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }); // sv-SE 로케일이 YYYY-MM-DD를 그대로 출력.
}

function dateLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const dayKr = STATUS_DAYS[(date.getDay() + 6) % 7];
  return `${m}월 ${d}일 ${dayKr}요일`;
}

function groupByDay(items: CaptureReviewItem[]) {
  const map = new Map<string, CaptureReviewItem[]>();
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

// "처리 완료/반려/유예" 여부는 이 세션에서 방금 처리한 화면 로컬 상태
// (applied — decision 필드로 어느 경로였는지 구분, rejected — 순수 반려는
// 시트에 아무것도 안 써서 별도 상태로만 관리)뿐 아니라, 서버가 내려준
// item.reviewStatus도 함께 본다 — 그러지 않으면 페이지를 완전히 새로고침
// (F5)했을 때 방금 처리한 항목이 로컬 상태를 잃고 다시 "처리 대기"로
// 보이는 문제가 있다. "rejected_recognized"(반려·인정 — 잔여 슬롯 없어
// 제보자 상점만 부여)와 "deferred"(유예 — 당일 1회 제한으로 제보자 상점만
// 부여)는 둘 다 대상자 penalty가 없다는 점은 같지만, 사유가 달라 서로 다른
// 뱃지("반려 (인정)" vs "유예")로 구분해야 한다(사용자 지시).
function isItemApplied(item: CaptureReviewItem, applied: Record<string, AppliedResult>): boolean {
  return !!applied[item.id]?.penalty || item.reviewStatus === "approved";
}
function isItemDeferred(item: CaptureReviewItem, applied: Record<string, AppliedResult>): boolean {
  return applied[item.id]?.decision === "deferred" || item.reviewStatus === "deferred";
}
function isItemRejected(
  item: CaptureReviewItem,
  applied: Record<string, AppliedResult>,
  rejected: Record<string, unknown>
): boolean {
  if (isItemDeferred(item, applied)) return false;
  return (
    !!rejected[item.id] ||
    (!!applied[item.id] && !applied[item.id].penalty) ||
    item.reviewStatus === "rejected" ||
    item.reviewStatus === "rejected_recognized"
  );
}

// 시간 차감 예상 분 — 관리자가 "적용" 버튼을 눌러 발신~회신 시각을 직접
// 입력해야만 실제 penalty.deductedMinutes가 확정되지만(서버 applyTimeDeduction),
// 그 전에도 "예상 차감"을 보여줘야 한다(사용자 지시: 적용 버튼을 누르지
// 않아도 출력되어야 함). 접수 시각(item.ts)부터 대상자 응답 시각
// (targetRespondedAt)까지의 경과에서 20분(서버 TIME_DEDUCT_GRACE_MINUTES와
// 동일) 유예를 뺀 초과분을 예상값으로 계산한다 — 20분 이하로 응답했으면
// 0을 반환한다(차감 없음, "-00:00"으로 표시).
// 🔧 [버그 수정, 2026-09] 아직 응답이 없으면(targetRespondedAt이 null)
// "계산할 근거가 없다"며 null을 반환해 항상 "-00:00"으로 고정 표시되고
// 있었다 — 하지만 미응답 자체가 계속 시간이 흐르는 중이라는 뜻이므로,
// 응답 전에는 현재 시각(now)까지의 경과로 실시간 예상값을 보여줘야
// 한다(사용자 실사례: 미응답 60분째에도 예상 차감시간이 -00:00으로
// 보임). 호출부가 1분 간격 nowTick으로 리렌더링되므로 이 값도 자연히
// 갱신된다.
const TIME_DEDUCT_GRACE_MINUTES = 20;

function expectedDeductedMinutes(item: CaptureReviewItem, now: number = Date.now()): number | null {
  const respondedAt = item.targetRespondedAt || now;
  const diffMinutes = Math.floor((respondedAt - item.ts) / 60_000);
  return Math.max(0, diffMinutes - TIME_DEDUCT_GRACE_MINUTES);
}

// 차감 분을 "-HH:MM" 형식으로 포맷한다(사용자 지시) — 대부분 1시간 미만이라
// 시:분 표기가 "-25분" 같은 표기보다 한눈에 들어온다.
function formatDeductedTime(minutes: number): string {
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `-${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

// 다른 섹션(제보 정보/시간 차감/벌점·페널티 변동)과 같은 톤으로 맞춘 합의
// 투표 섹션 — 아이콘+제목 헤더, SubRow 들여쓰기, 얇은 필셋 버튼만 사용하고
// 별도 배경 박스는 두지 않는다. 스터디장(주 관리자)은 본인 판단과 실제
// 부스터디장들의 제출 현황(읽기 전용 — 그들 본인의 화면에서만 값을 바꿀 수
// 있다)을 함께 본다. 부스터디장이 한 명도 없으면 대조할 대상이 없으므로
// 체크박스 자체를 막는다.
function ConsensusSection({
  isConsensus,
  onToggleConsensus,
  myVote,
  onMyVoteChange,
  myName,
  coReviewers,
  votes,
  targetResponse,
}: {
  isConsensus: boolean;
  onToggleConsensus: (checked: boolean) => void;
  myVote: string | undefined;
  onMyVoteChange: (value: string | undefined) => void;
  myName: string | null;
  coReviewers: CoReviewer[];
  votes: VoteMap;
  targetResponse: "disputed" | "recognized" | null;
}) {
  const { allSubmitted, yesCount, willApprove } = computeConsensus(myVote, coReviewers, votes);
  const noCoReviewers = coReviewers.length === 0;
  const totalReviewers = 1 + coReviewers.length; // 스터디장 본인 + 부스터디장 전원
  // 🔧 [이의제기 연동] 제보 대상자가 [내 송출 P 제보 확인]에서 "이의제기"를
  // 눌러야만(targetResponse === "disputed") 체크박스를 켤 수 있다(사용자 지시).
  const hasDispute = targetResponse === "disputed";
  const disabled = noCoReviewers || !hasDispute;

  return (
    <div className="flex flex-col gap-1.5">
      <Label className={cn("justify-start", disabled && "opacity-50")}>
        <Checkbox checked={isConsensus && !disabled} disabled={disabled} onCheckedChange={onToggleConsensus} />
        <span className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base">
          <Users className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
          다른 관리자 의견 반영
        </span>
      </Label>

      {noCoReviewers && (
        <p className="pl-5 text-micro-lg text-muted-foreground sm:pl-5.5 sm:text-xs">
          현재 임명된 부스터디장이 없습니다.
        </p>
      )}

      {isConsensus && !disabled && (
        <>
          <SeverityPicker label={myName ? `스터디장 (${myName})` : "스터디장"} value={myVote} onChange={onMyVoteChange} />
          {coReviewers.map((m) => (
            <SeverityPicker
              key={m.number}
              label={`부 스터디장 (${m.name})`}
              value={votes[m.number]?.severity}
              readOnly
            />
          ))}
          {/* 🔧 [사용자 지시] "현재 페이지(관리자)의 위계도 맞춰줘" — SubRow
              기본 크기가 제보 화면 기준보다 한 단계 작았다. */}
          <div className="[&_span]:text-xs [&_span]:sm:text-sm">
            <SubRow
              label="판정 현황"
              value={
                allSubmitted
                  ? willApprove
                    ? `검토 결과 위반으로 인정 (위반 O ${yesCount}/${totalReviewers}명)`
                    : `위반 O ${yesCount}/${totalReviewers}명 → 반려`
                  : `전원 제출 대기 중 (기준 위반 O ${CONSENSUS_THRESHOLD}명 이상)`
              }
              valueClassName={allSubmitted ? cn("font-semibold", willApprove ? "text-destructive" : "text-foreground") : undefined}
            />
          </div>
        </>
      )}
    </div>
  );
}

// 위반 O/X를 고르는 컴팩트 필셋. 스터디장(주 관리자)이 다른 부스터디장의
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

export function ReportReviewList({
  visible,
  cycleFileId: cycleFileIdProp,
  onCycleChange,
}: {
  visible: boolean;
  // PEN·MONEY 탭 상단의 공용 사이클 토글이 있으면 부모가 넘겨준다 — 이
  // 경우 이 컴포넌트는 자체 토글을 그리지 않고 그 값을 그대로 쓴다.
  // 넘기지 않으면(부스터디장 전용 화면처럼 이 컴포넌트 단독 렌더링) 기존과
  // 동일하게 자체 상태 + 자체 CycleSwitcher를 쓴다.
  cycleFileId?: string | null;
  onCycleChange?: (fileId: string | null) => void;
}) {
  const { call } = useApi();
  const { session, isAdmin } = useAuth();

  const [items, setItems] = useState<CaptureReviewItem[] | null>(null);
  // 🔧 2026-09: 실제 부스터디장(공동 검토자) 명단과, 이 세션이 그중 누구인지
  // (isAdmin이 아닐 때만 값이 옴) — GET /admin/captures 응답에 함께 실려온다.
  const [coReviewers, setCoReviewers] = useState<CoReviewer[]>([]);
  const [myMemberNumber, setMyMemberNumber] = useState<string | null>(null);
  // 스터디장(주 관리자)일 때만 값이 옴 — "스터디장 (이름)" 라벨에 쓰인다.
  const [myName, setMyName] = useState<string | null>(null);
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
  // cancel()이 시트 취소는 끝냈지만 서버 revert가 실패했을 때, 재시도 시
  // 시트 취소를 중복 실행하지 않기 위한 표시(cancel 함수 참고).
  const [cancelSheetCleared, setCancelSheetCleared] = useState<Record<string, true>>({});
  // 순수 반려("rejected" — 미인정, 시트에 아무것도 쓰지 않음)도 승인과
  // 동일하게 목록에서 지우지 않고 화면 상태로만 표시한다("처리 반려" 뱃지)
  // — "반려 취소"를 누르면 이 항목만 지워 "처리 대기"로 되돌린다(서버
  // 되돌림 불필요).
  const [rejected, setRejected] = useState<Record<string, true>>({});
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
  // "90분 경과" 판정(canProcess)이 시간 흐름에 따라 바뀌므로, 그 경계를
  // 넘는 순간 버튼이 자동으로 활성화되도록 1분 간격으로만 다시 렌더링한다
  // (ReportPage의 재접속 대기 tick과 동일 패턴 — 초 단위로 잦게 돌 필요는 없음).
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setNowTick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  // 🔧 [3주 사이클 토글] "내 송출 P 제보 확인"과 동일한 CycleSwitcher를
  // 재사용한다 — null이면 현재 진행 중(대기 중이거나 24시간 이내 결정만),
  // 백업 fileId를 고르면 그 주(월~일, KST) 전체를 reviewStatus 무관하게 노출.
  // 부모(PEN·MONEY 탭)가 공용 토글을 제공하면 그 값을 그대로 쓰고(controlled),
  // 아니면 이 컴포넌트가 자체 상태로 관리한다(uncontrolled — 부스터디장 화면).
  const [cycleFileIdState, setCycleFileIdState] = useState<string | null>(null);
  const cycleFileId = cycleFileIdProp !== undefined ? cycleFileIdProp : cycleFileIdState;
  const setCycleFileId = onCycleChange || setCycleFileIdState;

  function load() {
    setLoading(true);
    setError(null);
    const cycleParam = cycleFileId ? `?cycle=${encodeURIComponent(cycleFileId)}` : "";
    call<CapturesListResponse>(`/admin/captures${cycleParam}`)
      .then((data) => {
        setItems(data.items || []);
        const nextCoReviewers = data.coReviewers || [];
        setCoReviewers(nextCoReviewers);
        setMyMemberNumber(data.myMemberNumber ?? null);
        setMyName(data.myName ?? null);
        // 🔧 [버그 수정] 부스터디장이 0명이 되면 isConsensusActive가 이미
        // false를 반환해 버튼은 정상 동작하지만, consensusEnabled 로컬
        // state 자체는 남아있어 이후 부스터디장이 재임명되면(같은 세션
        // 유지 중) 사용자가 체크박스를 다시 켠 적 없이 합의 모드가 갑자기
        // 부활해 버튼이 잠긴다. 0명이 되는 시점에 통째로 비워 이 부작용을
        // 막는다 — 부스터디장이 없으면 어차피 모든 항목의 합의 모드가
        // 무의미하므로 전체 초기화해도 안전하다.
        if (nextCoReviewers.length === 0) {
          setConsensusEnabled({});
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "제보 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, [cycleFileId]); // eslint-disable-line react-hooks/exhaustive-deps
  // 다른 학생이 이 탭을 벗어난 사이에 새 제보를 넣을 수 있어, 승인 대기열은
  // 관리자가 이 탭으로 돌아올 때마다 새로 불러와야 방금 들어온 제보를 놓치지 않는다.
  useRefreshOnVisible(visible, load);
  usePullRefreshListener(visible, load);
  // 탭을 벗어나지 않고 계속 띄워둔 채로도(다른 관리자가 처리한 결과 등)
  // 몇 분 안에 자동으로 최신 값을 받도록 폴링한다 — 관련 캐시(penSlotGrid:
  // 60초)의 3배 이상으로 주기를 잡아 캐시 절감 효과를 거의 그대로 유지한다.
  const refreshProgress = usePollingRefresh(visible, load, 3 * 60_000);

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

  function decide(
    item: CaptureReviewItem,
    decision: "approved" | "rejected" | "rejected_recognized" | "deferred"
  ) {
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
      },
    })
      .then((data) => {
        if (decision === "rejected") {
          setRejected((prev) => ({ ...prev, [item.id]: true }));
        } else {
          setApplied((prev) => ({
            ...prev,
            [item.id]: {
              decision,
              penalty: data.penalty ?? null,
              merit: data.merit ?? null,
              timeDeduction: data.timeDeduction ?? null,
            },
          }));
        }
        // 🔧 [버그 수정] "적용"/"유예" 결정은 같은 대상자의 다른 대기 항목의
        // shouldDefer(당일 유예 상한 판정, 서버가 매 조회마다 재계산)에
        // 영향을 준다 — 로컬 state만 갱신하고 끝내면, 화면에 함께 떠 있는
        // 다른 항목은 새로고침 전까지 "적용"/"유예" 버튼 구분이 갱신되지
        // 않아 이미 상한을 넘겼는데도 "유예"가 계속 보이거나 그 반대인
        // 상태로 남을 수 있었다. 순수 반려("rejected")는 이 카운트에 영향을
        // 주지 않으므로 재조회할 필요가 없다.
        if (decision === "approved" || decision === "deferred") {
          load();
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
        // 🔧 [버그 수정] 로컬 items 배열의 reviewStatus만 "pending"으로
        // 패치하고 끝내면, "유예" 처리됐던 건을 취소했을 때 그 순간의
        // item.shouldDefer가 갱신되지 않은 채(deferred였던 시점의 스냅샷,
        // handleAdminCapturesList는 pending 항목에만 shouldDefer를
        // 계산한다) 그대로 남아있었다 — 대상자가 그날 이미 다른 건으로
        // "적용"을 받은 상태에서 이 유예를 취소하면, 원래는 여전히
        // "유예" 후보(shouldDefer: true)여야 하는데 화면은 갱신 안 된
        // shouldDefer: false를 보고 "적용"(송출 벌점 적용) 버튼을 대신
        // 그렸다. load()로 서버 최신 스냅샷(shouldDefer 포함)을 다시
        // 받아와야 정확한 버튼이 나온다.
        load();
      })
      .catch((err) => setError(err instanceof Error ? err.message : "반려 취소에 실패했습니다."))
      .finally(() => setDecidingId(null));
  }

  // 합의 모드가 꺼져 있으면 항상 처리 가능, 켜져 있으면 전원 제출이 끝나야 처리 가능.
  // 합의 모드가 꺼져 있으면 항상 처리 가능. 켜져 있으면 전원 제출이 끝나야
  // "반려"를 누를 수 있다.
  // "적용"/"반려" 공통 활성화 전제 조건(사용자 지시): 제보 대상자가
  // [내 송출 P 제보 확인]에서 "위반인정"/"이의제기" 중 하나를 눌렀거나,
  // 접수 시점(item.ts)으로부터 90분이 지나야 관리자가 처리할 수 있다 —
  // 당사자에게 소명 기회를 준 뒤에만 확정하려는 취지.
  const TARGET_RESPONSE_TIMEOUT_MS = 90 * 60 * 1000;
  function canProcess(item: CaptureReviewItem): boolean {
    if (item.targetResponse) return true;
    return Date.now() - item.ts >= TARGET_RESPONSE_TIMEOUT_MS;
  }

  // 대상자가 아직 응답하지 않은 건이 90분 자동 위반인정까지 남은 시간을
  // "N분" 형태로 보여준다(사용자 지시: 적용/반려 버튼을 덮는 오버레이에
  // 표시). canProcess가 이미 true(응답했거나 90분 경과)면 null.
  function remainingUntilAutoRecognize(item: CaptureReviewItem): string | null {
    if (canProcess(item)) return null;
    const remainingMs = TARGET_RESPONSE_TIMEOUT_MS - (Date.now() - item.ts);
    const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    return `${remainingMinutes}분`;
  }

  // 🔧 [버그 수정] "합의는 항상 선택 사항"(부스터디장이 있어도 스터디장
  // 독단으로 처리 가능, 사용자 확정)이므로 consensusEnabled가 꺼져 있으면
  // 즉시 처리 가능한 것 자체는 의도된 동작이다. 다만 체크박스가 부스터디장
  // 0명이라 강제로 잠겨 있는 상태(noCoReviewers)에서는 "합의 모드"라는
  // 개념 자체가 성립하지 않으므로 — 로컬 consensusEnabled 값이 남아있어도
  // (부스터디장 해임 등으로) 무시하고 항상 즉시 처리 가능해야 한다. 그러지
  // 않으면 UI는 체크박스를 꺼서 보여주는데 로직은 여전히 "합의 모드"로
  // 착각해 새로고침 외에는 풀 수 없는 영구 잠김이 생긴다.
  function isConsensusActive(item: CaptureReviewItem): boolean {
    return !!consensusEnabled[item.id] && coReviewers.length > 0;
  }
  function canReject(item: CaptureReviewItem): boolean {
    if (!canProcess(item)) return false;
    if (!isConsensusActive(item)) return true;
    return computeConsensus(severityLevel[item.id], coReviewers, item.votes || {}).allSubmitted;
  }
  // "적용"은 합의 모드가 켜져 있으면 "전원 제출 + 위반 O가
  // CONSENSUS_THRESHOLD명 이상"(검토 결과 위반으로 인정)일 때만 연다(사용자
  // 지시) — 전원이 제출했어도 위반 O가 기준 미만이면 인정이 아니므로
  // "적용"이 아니라 "반려"로 처리해야 한다.
  function canApply(item: CaptureReviewItem): boolean {
    if (!canProcess(item)) return false;
    if (!isConsensusActive(item)) return true;
    return computeConsensus(severityLevel[item.id], coReviewers, item.votes || {}).willApprove;
  }

  // "적용"/"페널티 적용 (불가)"를 되돌린다. 대상자 페널티(penalty)가 있으면
  // 기존 cancel-penalty로, 제보자 제보상점(merit — error가 아닌 실제 기록)이
  // 있으면 새 cancel-merit으로 각각 되돌린다. 두 시트 반영이 서로 다른
  // 실패 지점이라(예: 페널티는 있는데 제보상점 부여가 실패했을 수 있음)
  // 독립적으로 처리한다.
  // 🔧 [버그 수정] 시트만 되돌리고 서버 reviewStatus를 그대로 "approved"로
  // 남겨두면, ① 이 항목이 "적용" 뱃지 + "이미 처리된 제보입니다."로 고착돼
  // 재적용이 불가능해지고, ② handleAdminCapturesList의 shouldDefer 집계가
  // (reviewStatus==="approved" && penalty 존재)만으로 세기 때문에 이미
  // 취소된 이 건이 계속 "오늘 적용 1건"으로 잡혀 같은 대상자의 다른 정상
  // 제보가 부당하게 유예 처리된다. cancel-penalty/cancel-merit으로 시트를
  // 되돌린 뒤, revertReject와 동일하게 /admin/captures/revert를 호출해
  // 서버 reviewStatus도 "pending"으로 되돌린다 — merit은 이미 위에서
  // 회수했으므로 여기서는 null을 보내 중복 회수를 막는다.
  // 🔧 [버그 수정] applied[item.id](이 세션에서 방금 "적용"을 눌렀을 때만
  // 채워지는 로컬 상태)가 없으면 곧바로 return해, 새로고침 후 이미 확정된
  // 건은 "취소" 버튼 자체가 렌더링되지 않고 "이미 처리된 제보입니다."만
  // 보였다. 서버가 함께 내려주는 item.penalty/item.merit(봇 manifest
  // 스냅샷)을 폴백으로 사용해, 새로고침 여부와 무관하게 항상 취소할 수
  // 있게 한다.
  function cancel(item: CaptureReviewItem) {
    const penalty = applied[item.id]?.penalty ?? item.penalty;
    const merit = applied[item.id]?.merit ?? item.merit;
    if (!penalty && !merit) return;
    const meritToCancel = merit && !("error" in merit) ? merit : null;
    // 🔧 [부분 실패 대응] 시트 취소(cancel-penalty/cancel-merit)까지는 이미
    // 끝났는데 마지막 /admin/captures/revert(서버 reviewStatus 되돌리기)만
    // 네트워크 오류 등으로 실패하면, 시트는 깨끗한데 봇 manifest만
    // "approved"로 남아 shouldDefer가 다시 오염되고 새로고침 시 영구
    // 고착된다. sheetCleared로 "시트는 이미 비웠다"를 기억해 두면, 재시도
    // 시 이미 0으로 비운 슬롯에 cancel-penalty/cancel-merit을 또 실행하지
    // 않고 revert만 재시도한다(deductedMinutes 등 복원 연산이 멱등이
    // 아닐 수 있어 중복 호출 자체를 피하는 게 안전하다).
    const alreadyCleared = cancelSheetCleared[item.id];
    if (!penalty && !meritToCancel && !alreadyCleared) return;
    setDecidingId(item.id);
    setError(null);
    const sheetStep = alreadyCleared
      ? Promise.resolve()
      : Promise.all([
          penalty
            ? call<{ ok: boolean }>("/admin/captures/cancel-penalty", {
                method: "POST",
                body: {
                  number: penalty.number,
                  col: penalty.col,
                  deductedMinutes: penalty.deductedMinutes,
                  dayCol: penalty.dayCol,
                },
              })
            : Promise.resolve(),
          meritToCancel
            ? call<{ ok: boolean }>("/admin/captures/cancel-merit", {
                method: "POST",
                body: { number: meritToCancel.number, col: meritToCancel.col },
              })
            : Promise.resolve(),
        ]);
    sheetStep
      .then(() => {
        // 시트 취소가 이 호출에서 성공했든, 이미 이전 시도에서 끝나 있었든
        // 여기 도달했다면 시트는 확실히 깨끗하다 — 표시해 둔다.
        setCancelSheetCleared((prev) => ({ ...prev, [item.id]: true }));
        return call<CaptureRevertResponse>("/admin/captures/revert", {
          method: "POST",
          body: { id: item.id, merit: null, skipMeritLookup: true },
        });
      })
      .then(() => {
        setApplied((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
        setCancelSheetCleared((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
        setItems((prev) =>
          prev ? prev.map((i) => (i.id === item.id ? { ...i, reviewStatus: "pending" } : i)) : prev
        );
        // load()로 목록을 다시 받아와야 이 항목뿐 아니라 같은 대상자의
        // 다른 대기 항목의 nextOccurrence/shouldDefer도 방금 비운 슬롯을
        // 반영해 정확해진다(스냅샷인 item.nextOccurrence는 취소만으로는
        // 갱신되지 않는다).
        load();
      })
      .catch((err) =>
        setError(
          err instanceof Error
            ? alreadyCleared
              ? `시트는 이미 되돌렸지만 상태 갱신에 실패했습니다: ${err.message} — 새로고침하지 말고 다시 시도해주세요.`
              : err.message
            : "취소에 실패했습니다."
        )
      )
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
        // 🔧 [정리] 캡처가 완전히 삭제되면 다시 화면에 나타날 일이 없으므로
        // (id가 uuid라 재사용도 안 됨) 이 항목에 대한 나머지 로컬 편집
        // state도 함께 정리해 세션 동안의 메모리 누수를 없앤다.
        setCancelSheetCleared((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
        setConsensusEnabled((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
        setSeverityLevel((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
        setCoReviewerDraft((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
      })
      .catch((err) => setError(err instanceof Error ? err.message : "삭제에 실패했습니다."))
      .finally(() => setDeletingId(null));
  }

  return (
    <Collapsible defaultOpen className="flex flex-col">
      <SectionHeader icon={Flag} title="화각 불량 제보 처리" loading={loading} onRefresh={load} refreshProgress={refreshProgress} />
      <CollapsiblePanel className="flex flex-col gap-4">
        {cycleFileIdProp === undefined && (
          <>
            <CycleSwitcher selectedFileId={cycleFileId} onSelect={setCycleFileId} />
            {/* 🔧 [버그 수정] AdminMoneyTab이 렌더링할 때는 부모가 공용 경고
                배너를 이미 보여주므로 여기서는 이 컴포넌트가 자체 토글을
                쓰는 독립 모드(부스터디장 단독 화면)일 때만 표시한다. */}
            {cycleFileId && (
              <Alert>
                <AlertDescription className="flex items-center gap-1.5">
                  <CalendarDays className="size-3.5 shrink-0" strokeWidth={ICON_STROKE.default} />
                  지난 기록을 보고 있습니다 — 실제 처리는 "이번 주"로 돌아가서 하세요.
                </AlertDescription>
              </Alert>
            )}
          </>
        )}
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
              const isDayExpanded = expandedDay === group.dateKey;
              const appliedCount = group.items.filter((item) => isItemApplied(item, applied)).length;
              const deferredCount = group.items.filter((item) => isItemDeferred(item, applied)).length;
              const rejectedCount = group.items.filter((item) => isItemRejected(item, applied, rejected)).length;
              // "이의"/"인정"은 아직 관리자가 처리하지 않은 항목 중, 당사자가
              // 응답을 제출한 것만 센다 — 처리 완료(적용/유예/반려)된 건은
              // targetResponse가 남아있어도 그 결과 뱃지로만 표시한다.
              const stillPending = (item: CaptureReviewItem) =>
                !isItemApplied(item, applied) && !isItemDeferred(item, applied) && !isItemRejected(item, applied, rejected);
              const disputedCount = group.items.filter((item) => stillPending(item) && item.targetResponse === "disputed").length;
              const recognizedCount = group.items.filter((item) => stillPending(item) && item.targetResponse === "recognized").length;
              const pendingCount = group.items.length - appliedCount - deferredCount - rejectedCount - disputedCount - recognizedCount;
              return (
                <InfoCard key={group.dateKey} className="flex flex-col gap-2.5 bg-card">
                  <button
                    type="button"
                    onClick={() => setExpandedDay(isDayExpanded ? null : group.dateKey)}
                    className="flex items-center justify-between gap-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded"
                  >
                    <span className="inline-flex shrink-0 items-center gap-1.25 text-sm font-semibold sm:text-base">
                      <CalendarDays className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                      {dateLabel(group.dateKey)}
                    </span>
                    <span className="ml-auto flex items-center gap-1.5">
                      {/* 🔧 [뱃지 2행 재배치] 대기/이의/인정(당사자 응답 단계)을 1행,
                          확정/유예/반려(관리자 최종 처리 단계)를 2행으로 나눠 처리
                          진행 흐름이 한눈에 구분되게 한다(사용자 지시: 날짜 라벨
                          아래로 밀리지 않고 우측에 그대로 위치한 채 2행으로).
                          색상도 의미에 맞게 재정리: 대기=노랑(amber), 이의=옅은
                          빨강, 인정=초록(ok), 확정=진한 빨강(destructive), 유예/
                          반려=회색(muted). */}
                      {/* grid-cols-3 + justify-items-stretch(기본값)로, 각
                          열의 두 뱃지가 같은 열 폭을 "꽉 채우고" 텍스트는 그
                          안에서 중앙 정렬되게 한다 — justify-items-end(안쪽
                          정렬)로는 짧은 텍스트의 뱃지가 열 안에서 오른쪽으로
                          붙어 좌측 끝이 어긋나 보였다. 행 구성은 사용자 지시로
                          "대기/유예/반려"(1행) · "이의/인정/확정"(2행)으로
                          배치 — 뱃지 자체 순서(DOM 순서)로 행이 정해지므로
                          이 순서 그대로 나열한다. */}
                      {/* 🔧 [사용자 지시] "'화각 불량 제보'에서 설정한 디자인을 기준으로
                          비슷한 모양의 다른 화면에도 적용" — 제보 화면의 "총 N건" 뱃지와
                          동일한 크기(text-xs sm:text-sm)로 통일한다(기존 text-micro-lg
                          leading-none sm:text-xs는 한 단계 작았다). 🔧 [버그 수정] 텍스트가
                          커진 만큼 기존 grid-cols-3 고정 3열 폭 안에서 "대기 : 0건" 같은
                          텍스트가 줄바꿈돼 깨져 보였다 — 각 뱃지가 자기 내용만큼만 폭을
                          차지하는 flex-wrap으로 바꾸고 whitespace-nowrap으로 줄바꿈을
                          막는다(2행 배치는 grid-cols-3 대신 flex-wrap의 자연스러운
                          줄바꿈으로 유지되며, DOM 순서가 그대로라 "대기/유예/반려"·
                          "이의/인정/확정" 순서도 유지된다). */}
                      <span className="flex flex-wrap justify-end gap-1">
                        <span className="rounded-full bg-foreground/8 px-2 py-0.5 text-center text-xs font-semibold whitespace-nowrap text-muted-foreground sm:text-sm">
                          대기 : {pendingCount}건
                        </span>
                        <span className="rounded-full bg-foreground/8 px-2 py-0.5 text-center text-xs font-semibold whitespace-nowrap text-muted-foreground sm:text-sm">
                          유예 : {deferredCount}건
                        </span>
                        <span className="rounded-full bg-foreground/8 px-2 py-0.5 text-center text-xs font-semibold whitespace-nowrap text-muted-foreground sm:text-sm">
                          반려 : {rejectedCount}건
                        </span>
                        <span className="rounded-full bg-amber-600/15 px-2 py-0.5 text-center text-xs font-semibold whitespace-nowrap text-amber-600 sm:text-sm dark:bg-amber-400/15 dark:text-amber-400">
                          이의 : {disputedCount}건
                        </span>
                        <span className="rounded-full bg-ok/15 px-2 py-0.5 text-center text-xs font-semibold whitespace-nowrap text-ok sm:text-sm">
                          인정 : {recognizedCount}건
                        </span>
                        <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-center text-xs font-semibold whitespace-nowrap text-destructive sm:text-sm">
                          확정 : {appliedCount}건
                        </span>
                      </span>
                      <ChevronDown
                        className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isDayExpanded && "rotate-180")}
                        strokeWidth={ICON_STROKE.default}
                      />
                    </span>
                  </button>

                  {isDayExpanded && (
                    <div className="flex flex-col gap-2.5">
                      {/* 🔧 [정렬 기준 변경] 원래 처리 상태(대기→확정→유예→반려)
                          우선으로 정렬해, 같은 시각에 발생한 여러 건이 상태만
                          다르면 시간 순서와 무관하게 뒤섞여 보였다(사용자 지적).
                          발생 시각(item.ts) 오름차순(오래된 게 위, 사용자
                          지시)으로 바꿈. */}
                      {[...group.items]
                        .sort((a, b) => a.ts - b.ts)
                        .map((item) => {
                        const isMemberExpanded = expandedId === item.id;
                        const isApplied = isItemApplied(item, applied);
                        const isRejected = isItemRejected(item, applied, rejected);
                        // 뱃지가 대기/이의/인정(=관리자가 아직 최종 처리하지 않은
                        // 상태)인 항목만 빨간 글로우로 강조해 처리를 유도한다
                        // (사용자 지시) — 적용/유예/반려로 이미 처리된 항목은 제외.
                        const isUnprocessed = !isApplied && !isItemDeferred(item, applied) && !isRejected;
                        return (
                          <div
                            key={item.id}
                            className={cn(
                              "flex flex-col gap-2.5 rounded-lg border bg-card p-3",
                              isUnprocessed && "animate-unpaid-glow border-destructive"
                            )}
                          >
                            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                              <span className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base">
                                <User className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                {/* 이미 날짜별로 묶여 있으므로(그룹 헤더에 날짜 표시) 여기서는
                                    시:분:초까지 덧붙여 같은 대상자의 여러 건을 시각으로
                                    구분한다(사용자 지시: 토글 제목 옆에 발생일시도 표시,
                                    초 단위까지). 구분자는 이 프로젝트 전반(대시보드 타일
                                    등)에서 쓰는 DividedValue(텍스트 "|" 대신 은은한 세로선
                                    요소)를 그대로 재사용한다. */}
                                {/* 🔧 [사용자 지시] "구분자 우측 시간이 다른데를
                                    보면 구분자 우측은 폰트 위계가 더 작게
                                    되어있지 않아?" — 크기 클래스가 없어 부모의
                                    text-sm sm:text-base를 그대로 물려받아
                                    좌측과 같은 크기였다(굵기만 font-normal이라
                                    작아 보이는 착시). 설정 화면(SessionCard/
                                    PeriodAlarmCard)의 DividedValue 우측
                                    항목처럼 명시적으로 한 단계 작게
                                    (text-xs sm:text-sm) 통일한다. */}
                                <DividedValue
                                  items={[
                                    item.nickname,
                                    <span key="ts" className="text-xs font-normal text-muted-foreground sm:text-sm">
                                      {new Date(item.ts).toLocaleTimeString("ko-KR", {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                        second: "2-digit",
                                      })}
                                    </span>,
                                  ]}
                                />
                              </span>
                              <div className="flex items-center gap-1.5">
                                {/* 🔧 [6종 뱃지 재설계] 대기/이의/인정/적용/유예/반려 순으로 확장.
                                    "이의"/"인정"은 당사자가 [내 송출 P 제보 확인]에서 제출한
                                    targetResponse를 그대로 보여준다 — 아직 관리자가 최종
                                    처리(적용/유예/반려)하지 않은 건에서만 의미가 있으므로
                                    isApplied/isItemDeferred/isRejected보다 아래에서 판정한다.
                                    색상은 날짜 그룹 헤더의 6종 뱃지와 동일하게 통일(사용자
                                    지시): 대기=회색, 이의=주황, 인정=초록, 확정=빨강, 유예/
                                    반려=회색. */}
                                {isApplied ? (
                                  <>
                                    <TintedPill tone="warn">확정</TintedPill>
                                    {/* 🔧 [차수 뱃지 추가] "벌점·페널티 변동"의 "확정 적용" 값과
                                        동일한 정보(몇 차 · 어떤 조치)를 카드를 펼치지 않아도
                                        바로 보이도록 헤더에 별도 뱃지로 함께 노출한다(사용자
                                        지시). */}
                                    <TintedPill
                                      tone="muted"
                                      className="bg-yellow-500/15 text-yellow-600 dark:bg-yellow-400/15 dark:text-yellow-400"
                                    >
                                      {occurrenceLabel((applied[item.id]?.penalty ?? item.penalty)?.occurrence ?? item.nextOccurrence)}
                                    </TintedPill>
                                    {/* 🔧 [차감시간 뱃지 추가] "학습시간 차감"의 "확정 차감시간"
                                        값도 세 번째 뱃지로 함께 노출한다(사용자 지시) — 유예도
                                        벌점과 별개로 시간 차감이 확정되므로 penalty/timeDeduction
                                        둘 다 확인한다. */}
                                    <TintedPill tone="muted">
                                      {formatDeductedTime(
                                        (applied[item.id]?.penalty ?? item.penalty)?.deductedMinutes ??
                                          (applied[item.id]?.timeDeduction ?? item.timeDeduction)?.deductedMinutes ??
                                          0
                                      )}
                                    </TintedPill>
                                  </>
                                ) : isItemDeferred(item, applied) ? (
                                  <>
                                    {/* 🔧 [유예 뱃지 2개로 분리] 1번째는 "유예 N차"(당일 몇 번째
                                        유예인지), 2번째는 "2차 (벌점)"처럼 유예되지 않았다면
                                        원래 적용됐어야 할 조치를 그대로 보여준다(사용자 지시).
                                        deferOccurrence가 없는 예외적인 경우(아주 오래된 데이터
                                        등)에는 순번 없이 "유예"만 표시. 🔧 [버그 수정] 차수는
                                        item.deferredOccurrence(유예 확정 시점의 슬롯 스냅샷)를
                                        우선 쓴다 — item.nextOccurrence는 조회 시점마다 재계산돼,
                                        이 유예 건 확정 이후 다른 건이 실제로 그 슬롯을 채우면
                                        표시 차수까지 밀려 보였다(사용자 재현: "2차 확정되니
                                        앞의 유예 1차·2차가 3차로 바뀜"). */}
                                    <TintedPill tone="muted">{item.deferOccurrence ? `유예 ${item.deferOccurrence}차` : "유예"}</TintedPill>
                                    <TintedPill tone="muted">
                                      {occurrenceLabel(item.deferredOccurrence ?? item.nextOccurrence)}
                                    </TintedPill>
                                    {/* 🔧 [차감시간 뱃지 추가] 유예도 벌점과 별개로 응답 지연
                                        시간 차감이 확정되므로(사용자 지시) 세 번째 뱃지로 함께
                                        노출한다. */}
                                    <TintedPill tone="muted">
                                      {formatDeductedTime((applied[item.id]?.timeDeduction ?? item.timeDeduction)?.deductedMinutes ?? 0)}
                                    </TintedPill>
                                  </>
                                ) : isRejected ? (
                                  <TintedPill tone="muted">
                                    {applied[item.id]?.decision === "rejected_recognized" ||
                                    item.reviewStatus === "rejected_recognized"
                                      ? "반려 (인정)"
                                      : "반려"}
                                  </TintedPill>
                                ) : item.targetResponse === "disputed" ? (
                                  <TintedPill tone="amber">이의</TintedPill>
                                ) : item.targetResponse === "recognized" ? (
                                  <TintedPill tone="ok">인정</TintedPill>
                                ) : (
                                  <TintedPill tone="muted">대기</TintedPill>
                                )}
                                <Button
                                  variant="outline"
                                  size="icon-sm"
                                  onClick={() => setExpandedId(isMemberExpanded ? null : item.id)}
                                  aria-label={isMemberExpanded ? "상세 접기" : "상세 펼치기"}
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
                                    <span className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base">
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

                                  <div className="h-px w-full bg-border" />

                                  <div className="flex flex-col gap-1.5">
                                    <span className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base">
                                      <FileText className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                      제보정보
                                    </span>
                                    {/* 🔧 [사용자 지시] "현재 페이지(관리자)의
                                        위계도 맞춰줘" — SubRow 기본 크기가
                                        제보 화면 기준보다 한 단계 작았다. */}
                                    <div className="flex flex-col gap-1.5 [&_span]:text-xs [&_span]:sm:text-sm">
                                      <SubRow label="사유" value={item.reason || "-"} valueClassName="text-destructive" />
                                      <SubRow label="제보자" value={item.reporterName || item.reporterEmail || "-"} />
                                      <SubRow label="발생일시" value={new Date(item.ts).toLocaleString("ko-KR")} />
                                      <SubRow label="처리현황" value={statusLabel(item)} />
                                    </div>
                                  </div>
                                </div>

                                {/* 🔧 [버그 수정] 스터디장 쪽 ConsensusSection(위 hasDispute)은
                                    "대상자가 이의제기한 건에서만" 합의 검토를 켤 수 있게
                                    막아두는데, 부스터디장 본인이 자기 의견을 제출하는 이
                                    화면은 그 조건을 전혀 확인하지 않고 미확정 건이면 항상
                                    폼을 보여줬다(사용자 결정: 이의제기 건에서만 투표해야
                                    함). 서버(handleAdminCaptureVote)도 reviewStatus만
                                    확인할 뿐 targetResponse는 검사하지 않아, 대상자가
                                    아직 응답하지 않았거나 스스로 위반을 인정한 건에도
                                    부스터디장의 위반 O/X 판단이 KV에 기록될 수 있었다.
                                    스터디장 쪽과 동일한 기준(targetResponse === "disputed")
                                    을 여기도 적용한다. */}
                                {!isApplied && !isRejected && item.targetResponse === "disputed" && (
                                  <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:gap-3.5 sm:p-5">
                                    <span className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base">
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
                                {!isApplied && !isRejected && item.targetResponse !== "disputed" && (
                                  <div className="flex flex-col gap-2 rounded-xl border bg-card p-4 sm:p-5">
                                    <span className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base">
                                      <Users className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                      내 의견
                                    </span>
                                    <p className="text-xs text-muted-foreground sm:text-sm">
                                      대상자가 이의제기한 건에서만 의견을 제출할 수 있습니다.
                                    </p>
                                  </div>
                                )}
                              </>
                            )}

                            {isMemberExpanded && isAdmin && (
                              <>
                                <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:gap-3.5 sm:p-5">
                                  <div className="flex flex-col gap-1.5">
                                    <span className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base">
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

                                  <div className="h-px w-full bg-border" />

                                  <div className="flex flex-col gap-1.5">
                                    <span className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base">
                                      <FileText className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                      제보정보
                                    </span>
                                    <div className="flex flex-col gap-1.5 [&_span]:text-xs [&_span]:sm:text-sm">
                                      <SubRow label="사유" value={item.reason || "-"} valueClassName="text-destructive" />
                                      <SubRow label="제보자" value={item.reporterName || item.reporterEmail || "-"} />
                                      <SubRow label="발생일시" value={new Date(item.ts).toLocaleString("ko-KR")} />
                                      <SubRow label="처리현황" value={statusLabel(item)} />
                                    </div>
                                  </div>

                                  <div className="h-px w-full bg-border" />

                                  <div className="flex flex-col gap-1.5">
                                    <span className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base">
                                      <Clock className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                      학습시간 차감
                                    </span>
                                    {/* 🔧 [자동 계산으로 전환] 관리자가 발신/회신시각을 수동 입력하던
                                        기존 방식을 대체 — 스크린샷·영상 저장 시점(item.ts)부터 대상자가
                                        "위반인정"/"이의제기" 버튼을 누른 시점(targetRespondedAt)까지의
                                        간격에서 20분 유예를 뺀 초과분을 예상 차감으로 보여준다(사용자
                                        지시: "적용" 버튼을 누르지 않아도 출력되어야 함). 실제 시트 반영은
                                        여전히 "적용" 버튼을 눌렀을 때 확정값(penalty.deductedMinutes)으로
                                        이루어진다 — 그 전까지는 이 예상값만 표시.
                                    */}
                                    {/* 🔧 [사용자 지시] "현재 페이지(관리자)의
                                        위계도 맞춰줘" — SubRow 기본 크기가
                                        제보 화면 기준보다 한 단계 작았다. */}
                                    <div className="flex flex-col gap-1.5 [&_span]:text-xs [&_span]:sm:text-sm">
                                    <SubRow
                                      label="응답일시"
                                      value={
                                        item.targetRespondedAt
                                          ? new Date(item.targetRespondedAt).toLocaleString("ko-KR")
                                          : "대상자 응답 대기 중"
                                      }
                                    />
                                    {(() => {
                                      // 🔧 [버그 수정] 로컬 세션 상태(applied[item.id])만 보면
                                      // 새로고침한 뒤 이미 확정된 건을 열어도 그 사실을 몰라
                                      // "예상 차감시간"으로 잘못 표시되고, 값도 현재 시각 기준
                                      // 재계산된(응답 시각이 지날수록 계속 달라지는) 예상치가
                                      // 실제 확정값 대신 나왔다. 서버가 함께 내려주는 item.penalty
                                      // (봇 manifest 스냅샷)를 폴백으로 사용해, 새로고침 여부와
                                      // 무관하게 항상 정확한 확정값을 보여준다.
                                      // 🔧 [유예도 확정으로 표시] "유예"는 벌점만 면제될 뿐 응답
                                      // 지연 시간 차감은 별도로 적용되므로(사용자 지시), penalty가
                                      // 아니라 reviewStatus가 pending을 벗어났는지로 확정 여부를
                                      // 판단한다 — 유예 건은 item.timeDeduction(있으면 실제 차감,
                                      // 없으면 지연이 20분 이하였다는 확정된 0)을 쓴다.
                                      const localApplied = applied[item.id];
                                      const isDecided = !!localApplied || item.reviewStatus !== "pending";
                                      const confirmed = isDecided
                                        ? (localApplied?.penalty?.deductedMinutes ??
                                            item.penalty?.deductedMinutes ??
                                            localApplied?.timeDeduction?.deductedMinutes ??
                                            item.timeDeduction?.deductedMinutes ??
                                            0)
                                        : undefined;
                                      const isConfirmed = confirmed !== undefined;
                                      const deductedMinutes = isConfirmed ? confirmed : expectedDeductedMinutes(item) ?? 0;
                                      return (
                                        <SubRow
                                          label={isConfirmed ? "확정 차감시간" : "예상 차감시간"}
                                          value={formatDeductedTime(deductedMinutes)}
                                          valueClassName={deductedMinutes === 0 ? undefined : "text-destructive"}
                                        />
                                      );
                                    })()}
                                    </div>
                                  </div>

                                  <div className="h-px w-full bg-border" />

                                  <div className="flex flex-col gap-1.5">
                                    <span className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base">
                                      <Gavel className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                      벌점 · 페널티 변동
                                    </span>
                                    <div className="flex flex-col gap-1.5 [&_span]:text-xs [&_span]:sm:text-sm">
                                    {/* 🔧 [버그 수정] 위 학습시간 차감과 동일한 이유로,
                                        applied[item.id](로컬 세션)만 보면 새로고침 후 이미
                                        확정된 건이 "예상 적용" + 재계산된 nextOccurrence로
                                        잘못 표시됐다. 서버가 내려주는 item.penalty(확정
                                        스냅샷)를 폴백으로 함께 사용한다. */}
                                    {(() => {
                                      const confirmedPenalty = applied[item.id]?.penalty ?? item.penalty;
                                      // 🔧 [유예 표시] deferOccurrence(당일 몇 번째 유예인지, 서버가
                                      // 계산)가 있으면 실제로는 "적용"이 아니라 "유예"로 처리됐거나
                                      // 처리될 예정이다(사용자 지시: "2차 (벌점) 유예 1차"처럼 원래
                                      // 차수 라벨에 취소선을 긋고 "유예 N차"를 덧붙여, 대상자
                                      // 페널티가 아니라 제보자 상점만 부여(됐/될) 것임을 명확히
                                      // 보여준다) — reviewStatus === "deferred"로 이미 확정된 건도,
                                      // 아직 pending이라 shouldDefer로만 예고된 건도 동일하게 표시한다.
                                      const deferOccurrence = item.deferOccurrence;
                                      // 🔧 [반려도 확정으로 표시] "반려"(순수 rejected 또는
                                      // rejected_recognized)도 관리자가 이미 처리를 마친 상태이므로
                                      // 라벨은 "확정"으로 보여주되(사용자 지시), 실제로는 적용되지
                                      // 않은 조치이므로 값 자체에 취소선을 그어 구분한다.
                                      const isRejectedDecided =
                                        !confirmedPenalty && !deferOccurrence && isRejected;
                                      // 🔧 [버그 수정] deferOccurrence는 위 주석대로 이미 확정된
                                      // 유예(reviewStatus: "deferred")뿐 아니라 아직 pending인
                                      // 항목의 예상값에도 채워진다 — 있기만 하면 무조건 확정으로
                                      // 취급하면, 대상자 응답을 기다리는 중인 건도 "확정 적용"으로
                                      // 잘못 표시된다(사용자 실사례). reviewStatus로 실제 확정
                                      // 여부를 가른다.
                                      const isDecided =
                                        !!confirmedPenalty || item.reviewStatus === "deferred" || isRejectedDecided;
                                      return (
                                        <SubRow
                                          label={isDecided ? "확정 적용" : "예상 적용"}
                                          value={
                                            deferOccurrence ? (
                                              <>
                                                <span className="line-through">
                                                  {occurrenceLabel(item.deferredOccurrence ?? item.nextOccurrence)}
                                                </span>{" "}
                                                유예 {deferOccurrence}차
                                              </>
                                            ) : confirmedPenalty ? (
                                              occurrenceLabel(confirmedPenalty.occurrence)
                                            ) : isRejectedDecided ? (
                                              <span className="line-through">
                                                {occurrenceLabel(item.deferredOccurrence ?? item.nextOccurrence)}
                                              </span>
                                            ) : (
                                              occurrenceLabel(item.nextOccurrence)
                                            )
                                          }
                                          valueClassName="text-destructive"
                                        />
                                      );
                                    })()}
                                    {(() => {
                                      // 🔧 [버그 수정] "이번 주 영향"이 확정된 뒤에도 item.
                                      // weeklyMinorPenaltyCount(GET 시점마다 "다음 pending 건을
                                      // 지금 적용하면"이라는 가정으로 매번 재계산되는 값)를 그대로
                                      // 써서, 같은 대상자의 다른 건이 나중에 처리되면 이미 확정된
                                      // 건의 "이번 주 영향"까지 덩달아 바뀌어 보였다(사용자 지적:
                                      // "-0.1점에서 -0.2점으로 바뀐다"). 확정된 건은 penalty에 함께
                                      // 저장해 둔 확정 시점 스냅샷(weeklyMinorPenaltyCount)을 우선
                                      // 쓴다. 🔧 [반려도 동일 적용] 반려(순수 rejected/
                                      // rejected_recognized)는 애초에 대상자 페널티가 적용되지
                                      // 않으므로 벌점 영향 자체가 없다 — penalty가 없어
                                      // weeklyMinorPenaltyCount 스냅샷도 없는데, 그렇다고
                                      // item.weeklyMinorPenaltyCount(재계산값)로 새면 위와 동일한
                                      // 버그가 반려 건에서 재현된다(같은 대상자의 다른 건이 나중에
                                      // 처리되면 이미 반려된 건의 "이번 주 영향"까지 바뀌어 보임).
                                      // 유예와 마찬가지로 반려 건은 항상 "없음"으로 고정한다.
                                      const confirmedPenalty = applied[item.id]?.penalty ?? item.penalty;
                                      const minorCount = confirmedPenalty?.weeklyMinorPenaltyCount ?? item.weeklyMinorPenaltyCount;
                                      const impact =
                                        item.deferOccurrence || isRejected
                                          ? "없음"
                                          : weeklyImpactLabel(confirmedPenalty?.occurrence ?? item.nextOccurrence, minorCount);
                                      const hasImpact = impact !== "없음" && impact !== "-";
                                      return (
                                        <SubRow
                                          label="이번 주 영향"
                                          value={impact}
                                          valueClassName={hasImpact ? "text-destructive" : undefined}
                                        />
                                      );
                                    })()}
                                    {/* 🔧 [버그 수정] "없음 (잔여 슬롯 없어 미등록)"은 "적용"을
                                        시도했는데 대상자 잔여 슬롯이 없어 페널티 등록만 못 한
                                        경우(rejected_recognized)를 위한 문구다 — "유예"
                                        (decision === "deferred")는 애초에 대상자 페널티를
                                        주지 않는 게 의도된 결정이라 이 조건에 걸려도 같은
                                        문구가 뜨면 "슬롯이 없어서 처리가 안 됐다"는 오해를
                                        준다. decision이 rejected_recognized일 때만 보여준다. */}
                                    {applied[item.id]?.decision === "rejected_recognized" && !applied[item.id]!.penalty && (
                                      <SubRow label="대상자 처리" value="없음 (잔여 슬롯 없어 미등록)" />
                                    )}
                                    {/* 🔧 [버그 수정] "제보자 상점" 줄은 사용자 지시로 완전히
                                        제거 — 확정(approved)/유예(deferred)/반려(인정,
                                        rejected_recognized) 어떤 결정이든 관리자 화면에서는
                                        더 이상 노출하지 않는다(부여 실패 케이스도 포함). */}
                                    </div>
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
                                      myName={myName}
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
                                      targetResponse={item.targetResponse}
                                    />
                                  </div>
                                )}

                                <div className="grid grid-cols-[1fr_auto] gap-2">
                                  {isApplied ? (
                                    // 🔧 [버그 수정] applied[item.id](로컬 세션 상태)만 보면
                                    // 새로고침 후 이미 확정된 건은 취소에 필요한 정보를 잃어
                                    // 버튼 자체가 사라지고 "이미 처리된 제보입니다."만 보였다 —
                                    // 서버가 함께 내려주는 item.penalty(봇 manifest 스냅샷)를
                                    // 폴백으로 사용한다. isApplied === true인 건은 항상
                                    // reviewStatus === "approved"이고, 이는 penalty가 실제로
                                    // 기록된 경우에만 set_decision이 남기는 상태이므로(잔여
                                    // 슬롯이 없어 penalty 없이 제보상점만 부여된 건은
                                    // "rejected_recognized"로 별도 분류됨) penalty는 항상 존재한다.
                                    (applied[item.id]?.penalty ?? item.penalty) ? (
                                      <Button
                                        variant="outline"
                                        className="sm:h-12 sm:text-base"
                                        disabled={decidingId === item.id}
                                        onClick={() => cancel(item)}
                                      >
                                        {cancelButtonLabel((applied[item.id]?.penalty ?? item.penalty)!.occurrence)}
                                      </Button>
                                    ) : (
                                      // 그래도 penalty를 못 찾은 경우(예: 아주 오래된 데이터) —
                                      // 취소에 필요한 정보가 없어 버튼 자체를 숨긴다(잘못 눌러도
                                      // 동작하지 않는 것보다 안전).
                                      <p className="flex items-center justify-center text-center text-xs text-muted-foreground sm:text-sm">
                                        이미 처리된 제보입니다.
                                      </p>
                                    )
                                  ) : isItemDeferred(item, applied) ? (
                                    // "유예 취소" — "유예" 클릭으로 부여된 제보자 상점을 되돌리고
                                    // 다시 "처리 대기"로 되돌린다(사용자 지시). revertReject와
                                    // 처리 로직은 동일하다(merit 회수 + reviewStatus를 pending으로).
                                    <Button
                                      variant="outline"
                                      className="sm:h-12 sm:text-base"
                                      disabled={decidingId === item.id}
                                      onClick={() => revertReject(item)}
                                    >
                                      유예 취소
                                    </Button>
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
                                    <div className="flex flex-col gap-1.5">
                                      {/* 🔧 [응답 대기 오버레이] 대상자가 아직 응답하지 않아
                                          "적용"/"반려" 버튼이 비활성화된 동안, 두 버튼 전체를
                                          반투명 레이어로 덮고 90분 자동 위반인정까지 남은 시간을
                                          표시한다(사용자 지시 — 폐기 버튼은 별도 영역이라 덮지
                                          않음). 버튼 자체는 disabled로 이미 막혀 있으므로 이
                                          오버레이는 순수 시각적 안내이고 pointer-events는 그대로
                                          버튼에 남겨 둔다(막힌 버튼을 눌러도 disabled라 무해). */}
                                      <div className="relative">
                                        <div className="grid grid-cols-2 gap-2">
                                          {/* 🔧 [유예 조건] 대상자가 오늘 이미 1회 적용을 받았으면
                                              "적용" 대신 "유예"를 노출한다(사용자 지시) — 클릭 시
                                              decision: "deferred"로, 대상자 페널티 없이 제보자
                                              상점만 부여된다(applyReportMerit 재사용). */}
                                          {item.shouldDefer ? (
                                            <Button
                                              variant="destructive"
                                              className="sm:h-12 sm:text-base"
                                              disabled={decidingId === item.id || !canApply(item)}
                                              onClick={() => decide(item, "deferred")}
                                            >
                                              유예
                                            </Button>
                                          ) : (
                                            <Button
                                              variant="destructive"
                                              className="sm:h-12 sm:text-base"
                                              disabled={decidingId === item.id || !canApply(item)}
                                              onClick={() =>
                                                decide(item, item.nextOccurrence === null ? "rejected_recognized" : "approved")
                                              }
                                            >
                                              {applyButtonLabel(item.nextOccurrence)}
                                            </Button>
                                          )}
                                          <Button
                                            variant="outline"
                                            className="sm:h-12 sm:text-base"
                                            disabled={decidingId === item.id || !canReject(item)}
                                            onClick={() => decide(item, "rejected")}
                                          >
                                            반려
                                          </Button>
                                        </div>
                                        {!canProcess(item) && (
                                          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1.25 rounded-md bg-background/70 text-micro-lg font-semibold text-muted-foreground backdrop-blur-[1px] sm:text-xs">
                                            <Clock className="size-3 shrink-0" strokeWidth={ICON_STROKE.default} />
                                            자동 응답까지 {remainingUntilAutoRecognize(item)} 남음
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                  {/* 🔧 [버그 수정] 폐기(삭제) 버튼은 확정/유예/반려로 이미
                                      처리된 건에는 노출하지 않는다(사용자 지시: "관리자가
                                      유예나 반려 적용 처리 하기 전 단계에만" 보이도록) —
                                      처리 완료된 건은 각각 "취소"/"유예 취소"/"반려 취소"
                                      버튼으로만 되돌리게 해, 시트에 이미 반영된 기록을
                                      되돌리지 않은 채 통째로 지워버리는 실수를 막는다. */}
                                  {!isApplied && !isItemDeferred(item, applied) && !isRejected && (
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
