import { useEffect, useRef, useState } from "react";
import { Flag, ChevronDown, CalendarDays, FileText, FlaskConical, Clock, Gavel, Image as ImageIcon, User, Users, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DividedValue, SubRow, TintedPill, STATUS_DAYS, statusPillTone } from "@/components/dashboard/shared";
import { CycleSwitcher } from "@/components/dashboard/CycleSwitcher";
import {
  SectionHeader,
  CapturePreview,
  AdminListSkeleton,
  AdminEmptyState,
  formatDateTime24h,
  DayGroupHeader,
  occurrenceLabel,
  penaltyCategoryLabel,
  weeklyImpactLabel,
  formatDeductedTime,
  statusLabel,
  DottedValue,
} from "@/components/admin/shared";
import { useApi } from "@/hooks/useApi";
import { useRefreshOnVisible } from "@/hooks/useRefreshOnVisible";
import { usePollingRefresh } from "@/hooks/usePollingRefresh";
import { usePullRefreshListener } from "@/hooks/usePullToRefresh";
import { useAuth } from "@/lib/auth/useAuth";
import { ICON_STROKE, cn } from "@/lib/utils";
import { toKSTDateString } from "@/lib/date";
import type {
  CaptureReviewItem,
  CapturesListResponse,
  CaptureDecideResponse,
  CaptureDeleteResponse,
  CaptureRevertResponse,
  CaptureVoteResponse,
  CaptureVote,
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
  // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — penalty/
  // merit/timeDeduction이 실제로 기록된 파일 id. 취소/삭제/되돌리기 시
  // 그대로 다시 보내야 정확한 파일에서 롤백된다.
  sourceFileId: string | null;
};

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
// (targetResponse)과 관리자 최종 처리(reviewStatus)를 조합한 상세 텍스트.
// targetResponse가 없으면 관리자가 이미 처리했어도(구조적으로는 가능하나
// 실제 운영에서는 도달하지 않는 경로) 항상 "응답 대기 중"으로만 표시한다.
// 🔧 [공용화, 2026-09-19] statusLabel/actionLabel/occurrenceLabel/
// penaltyCategoryLabel은 MyOutputPenSection.tsx와 완전히 동일한 로직을
// 복제해 갖고 있었다 — "한쪽만 고치면 서로 달라지는" 문제를 없애기 위해
// admin/shared.tsx로 옮기고 두 파일이 함께 import한다.

// "취소" 버튼 문구용 — "구두경고 적용 취소"/"송출 벌점 적용 취소"/"송출 P
// 적용 취소"(사용자 확정 형식). applyButtonLabel과 동일한 차수 매핑을 쓴다.
function cancelButtonLabel(occurrence: number | null): string {
  return `${applyButtonLabel(occurrence)} 취소`;
}

// 🔧 [3버튼 재설계] 사용자 확정: "반려 (상점인정)" 버튼을 따로 만들지 않고,
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

// 🔧 [버그 수정] 기존에는 dayOfTs가 요일 이름(월~일)만 계산하고
// thisWeekDateLabel이 "오늘이 속한 주"의 그 요일 날짜를 역산해 헤더에
// 붙였다 — "이번 주 대기 건만" 다루던 시절엔 문제없었지만, 지금은 24시간
// 결정 창을 지나서도 pending인 항목이 여러 주에 걸쳐 계속 남을 수 있어
// (사용자 확인: 지난주 테스트 제보가 pending으로 남아 관리자 화면에서
// "이번 주 같은 요일" 헤더 밑에 잘못 합쳐져 보임) 서로 다른 주의 같은
// 요일이 하나로 합쳐지고 헤더 날짜도 실제와 달라지는 문제가 있었다
// (MyOutputPenSection.tsx에서 먼저 발견/수정한 것과 동일한 버그).
// KST 기준 실제 날짜(YYYY-MM-DD)로 그룹핑해 근본적으로 없앤다.
// 🔧 [중복 제거, 2026-09-21] 이 함수가 MyOutputPenSection.tsx에 거의
// 동일하게 복사돼 있던 걸 lib/date.ts의 toKSTDateString으로 통합했다.
function kstDateKey(ts: number): string {
  return toKSTDateString(ts);
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
// 뱃지("반려 (상점인정)" vs "유예")로 구분해야 한다(사용자 지시).
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

// 🧪 [목업 미리보기, 사용자 지시] "'PEN MONEY' 탭의 각 요소도 새로고침
// 좌측에 목업 버튼을 만들고 적절한 목업을 생성" — 실 운영에서 나올 수
// 있는 분기(대상자 응답 대기, 이의제기 + 합의 투표 진행 중, 확정 적용,
// 반려)를 한 화면에서 모두 볼 수 있는 고정 스냅샷.
// 실제 슬롯 열 배치(frame-checker-worker/src/index.js·report-penalty.js)와
// 동일하게 맞춰야 occurrence/col/dayCol 조합이 실제로 나올 수 있는
// 값이 된다 — 송출P(1~6차)와 제보상점(1~5차)은 서로 다른 열 대역을
// 쓰고, dayCol(요일)은 이 둘과 또 다른 축이다.
const DUMMY_OUTPUT_PEN_SLOT_COLUMNS = ["F", "G", "H", "I", "J", "K"]; // 1차..6차
const DUMMY_REPORT_MERIT_SLOT_COLUMNS = ["R", "S", "T", "U", "V"]; // 1차..5차
const DUMMY_STATUS_DAY_COLS = ["C", "F", "I", "L", "O", "R", "U"]; // 월..일

const DUMMY_CO_REVIEWERS: CoReviewer[] = [{ number: "13", name: "유나" }];

// 🔧 [사용자 지적] "화각 불량 제보 처리"의 nickname은 기기 이름이 아니라
// 제보 "대상자"(위반 의심 회원) 본인의 이름이다 — ReportPage.tsx의
// "제보 대상자" Select가 members(실제 회원 이름 목록)에서 값을 받아 그대로
// nickname으로 전송하고(report-intake.js:99 "대상자는 항상 본인 —
// member.name"), 관리자 화면도 <User> 아이콘과 함께 그 값을 이름처럼
// 렌더링한다. reason도 실제 REASON_OPTIONS(ReportPage.tsx) 프리셋 중
// 하나여야 한다 — "화면 미확인"은 존재하지 않는 임의 문구였다.
const DUMMY_CAPTURE_ITEMS: CaptureReviewItem[] = [
  {
    id: "dummy-report-1",
    nickname: "지민",
    reason: "전자기기 사용목적 확인 불가",
    mode: "screenshot",
    reporterEmail: "areum.study@gmail.com",
    ts: Date.now() - 20 * 60 * 1000,
    reviewStatus: "pending",
    nextOccurrence: 1,
    weeklyMinorPenaltyCount: 0,
    shouldDefer: false,
    deferOccurrence: null,
    deferredOccurrence: null,
    reporterName: "아름",
    targetResponse: null,
    targetRespondedAt: null,
    targetResponseAuto: false,
    votes: {},
    penalty: null,
    merit: null,
    timeDeduction: null,
    sourceFileId: null,
  },
  {
    id: "dummy-report-2",
    nickname: "도윤",
    reason: "손 또는 학습자료 확인 불가",
    mode: "video",
    reporterEmail: "jimin.cam@gmail.com",
    ts: Date.now() - 3 * 60 * 60 * 1000,
    reviewStatus: "pending",
    nextOccurrence: 2,
    weeklyMinorPenaltyCount: 1,
    shouldDefer: false,
    deferOccurrence: null,
    deferredOccurrence: null,
    reporterName: null,
    targetResponse: "disputed",
    targetRespondedAt: Date.now() - 2.5 * 60 * 60 * 1000,
    targetResponseAuto: false,
    // 부스터디장(13번)은 이미 "위반 O"를 제출했고, 스터디장 본인은 아직
    // 미제출 — computeConsensus의 "전원 제출 대기 중" 분기를 보여준다.
    votes: { "13": { name: "유나", severity: "yes" as CaptureVote["severity"], votedAt: Date.now() - 60 * 60 * 1000 } },
    penalty: null,
    merit: null,
    timeDeduction: null,
    sourceFileId: null,
  },
  {
    id: "dummy-report-3",
    nickname: "민준",
    reason: "격자 기준을 벗어난 근접 화각",
    mode: "screenshot",
    reporterEmail: "areum.study@gmail.com",
    ts: Date.now() - 26 * 60 * 60 * 1000,
    reviewStatus: "approved",
    nextOccurrence: null,
    weeklyMinorPenaltyCount: 2,
    shouldDefer: false,
    deferOccurrence: null,
    deferredOccurrence: null,
    reporterName: "아름",
    targetResponse: "recognized",
    targetRespondedAt: Date.now() - 25.5 * 60 * 60 * 1000,
    targetResponseAuto: false,
    votes: {},
    // occurrence 3 → OUTPUT_PEN_SLOT_COLUMNS[2] = "H"(F,G,H,I,J,K가 1~6차).
    // dayCol은 실제 발생 요일 열(화요일 = STATUS_DAY_COLS[1] = "F")이어야
    // 한다 — occurrence 열과 요일 열은 서로 다른 축이라 값이 겹치지 않는다.
    // merit.col은 제보상점 전용 슬롯(REPORT_MERIT_SLOT_COLUMNS, R~V가
    // 1~5차)이라 occurrence 1이면 "R". penalty/merit의 name은 각각 실제
    // 벌점 대상자(nickname과 동일)와 제보자(reporterName과 동일)여야
    // 한다 — 앞서 서로 다른 이름을 넣은 것은 모순이었다.
    penalty: { number: "8", name: "민준", occurrence: 3, isPCount: false, col: "H", deductedMinutes: 15, dayCol: "F", weeklyMinorPenaltyCount: 2 },
    merit: { number: "3", name: "아름", occurrence: 1, col: "R" },
    timeDeduction: null,
    sourceFileId: null,
  },
  {
    id: "dummy-report-4",
    nickname: "하준",
    reason: "얼굴, 정수리 등 노출",
    mode: "screenshot",
    reporterEmail: "doyun.p@gmail.com",
    ts: Date.now() - 30 * 60 * 60 * 1000,
    reviewStatus: "rejected",
    nextOccurrence: 4,
    weeklyMinorPenaltyCount: 2,
    shouldDefer: false,
    deferOccurrence: null,
    deferredOccurrence: null,
    reporterName: null,
    targetResponse: "disputed",
    targetRespondedAt: Date.now() - 29.8 * 60 * 60 * 1000,
    targetResponseAuto: true,
    votes: {},
    penalty: null,
    merit: null,
    timeDeduction: null,
    sourceFileId: null,
  },
  // 대기 | 위반인정 — 대상자가 직접 "위반인정" 버튼을 눌러 제출, 아직
  // 관리자 처리 전(1번 "대기 | 접수"와 짝을 이루는, targetResponse가
  // recognized인 대기 케이스 보강).
  {
    id: "dummy-report-5",
    nickname: "서연",
    reason: "과도한 스티커 사용",
    mode: "video",
    reporterEmail: "areum.study@gmail.com",
    ts: Date.now() - 90 * 60 * 1000,
    reviewStatus: "pending",
    nextOccurrence: 1,
    weeklyMinorPenaltyCount: 0,
    shouldDefer: false,
    deferOccurrence: null,
    deferredOccurrence: null,
    reporterName: "아름",
    targetResponse: "recognized",
    targetRespondedAt: Date.now() - 60 * 60 * 1000,
    targetResponseAuto: false,
    votes: {},
    penalty: null,
    merit: null,
    timeDeduction: null,
    sourceFileId: null,
  },
  // 대기 | 접수 — 90분 무응답으로 시스템이 자동 위반인정 처리(수신 화면
  // MyOutputPenSection의 dummy-received-3과 대응하는 케이스, 이 화면에는
  // 아직 없었음). targetResponseAuto가 true라 statusLabel이 "90분 내
  // 무응답으로 자동 제출"로 구분해 보여준다.
  {
    id: "dummy-report-6",
    nickname: "지민",
    reason: "기타 사유",
    mode: "screenshot",
    reporterEmail: "hayoon.k@gmail.com",
    ts: Date.now() - 100 * 60 * 1000,
    reviewStatus: "pending",
    nextOccurrence: 2,
    weeklyMinorPenaltyCount: 1,
    shouldDefer: false,
    deferOccurrence: null,
    deferredOccurrence: null,
    reporterName: null,
    targetResponse: "recognized",
    targetRespondedAt: Date.now() - 10 * 60 * 1000,
    targetResponseAuto: true,
    votes: {},
    penalty: null,
    merit: null,
    timeDeduction: null,
    sourceFileId: null,
  },
  // 확정 | 유예 — 대상자가 당일 이미 1회 적용을 받아 벌점만 면제(응답 지연
  // 시간 차감은 그대로 적용). deferOccurrence(당일 몇 번째 유예인지)/
  // deferredOccurrence(유예 확정 시점 스냅샷 차수)를 함께 채운다.
  {
    id: "dummy-report-7",
    nickname: "도윤",
    reason: "손 또는 학습자료 확인 불가",
    mode: "screenshot",
    reporterEmail: "seoyeon.lee@gmail.com",
    ts: Date.now() - 34 * 60 * 60 * 1000,
    reviewStatus: "deferred",
    nextOccurrence: null,
    weeklyMinorPenaltyCount: 1,
    shouldDefer: true,
    deferOccurrence: 1,
    deferredOccurrence: 3,
    reporterName: "서연",
    targetResponse: "recognized",
    targetRespondedAt: Date.now() - 33.5 * 60 * 60 * 1000,
    targetResponseAuto: false,
    votes: {},
    penalty: null,
    merit: { number: "5", name: "서연", occurrence: 2, col: "S" },
    timeDeduction: { number: "4", deductedMinutes: 10, dayCol: "I" },
    sourceFileId: null,
  },
  // 확정 | 반려 — "반려 (상점인정)"(rejected_recognized): 위반은 인정되나
  // 잔여 슬롯이 없어 대상자 등록만 불가, 제보자 상점은 그대로 지급됨
  // (사용자 지시로 화면상 표시는 순수 반려와 동일하게 "반려"로 통합).
  {
    id: "dummy-report-8",
    nickname: "민준",
    reason: "전자기기 사용목적 확인 불가",
    mode: "video",
    reporterEmail: "jimin.cam@gmail.com",
    ts: Date.now() - 46 * 60 * 60 * 1000,
    reviewStatus: "rejected_recognized",
    nextOccurrence: null,
    weeklyMinorPenaltyCount: 0,
    shouldDefer: false,
    deferOccurrence: null,
    deferredOccurrence: 6,
    reporterName: "도윤",
    targetResponse: "recognized",
    targetRespondedAt: Date.now() - 45.5 * 60 * 60 * 1000,
    targetResponseAuto: false,
    votes: {},
    penalty: null,
    merit: { number: "6", name: "도윤", occurrence: 4, col: "U" },
    timeDeduction: null,
    sourceFileId: null,
  },
  // 확정 | 반려 — "반려 (상점인정)"이되 nextOccurrence/deferredOccurrence가
  // 둘 다 null인 케이스(스냅샷 조회 자체가 실패했거나 애초에 슬롯 정보를
  // 특정할 수 없었던 경우) — 취소할 원래 차수 자체가 없으므로 "확정 적용"
  // 값에 취소선 없이 occurrenceLabel(null)("적용 불가 (잔여 슬롯 없음)")만
  // 그대로 보여야 한다(사용자 지적: "취소선이 그어지는데 안 그어져야 하는
  // 거 아니야? 논리적으로").
  {
    id: "dummy-report-10",
    nickname: "하윤",
    reason: "격자 기준을 벗어난 근접 화각",
    mode: "screenshot",
    reporterEmail: "seoyeon.lee@gmail.com",
    ts: Date.now() - 9 * 60 * 60 * 1000,
    reviewStatus: "rejected_recognized",
    nextOccurrence: null,
    weeklyMinorPenaltyCount: 0,
    shouldDefer: false,
    deferOccurrence: null,
    deferredOccurrence: null,
    reporterName: "서연",
    targetResponse: "disputed",
    targetRespondedAt: Date.now() - 8 * 60 * 60 * 1000,
    targetResponseAuto: false,
    votes: {},
    penalty: null,
    merit: { number: "8", name: "서연", occurrence: 5, col: "V" },
    timeDeduction: null,
    sourceFileId: null,
  },
  // 대기 | 이의제기 — "다른 관리자 의견 반영"(합의 모드)에서 부스터디장
  // (13번, 유나)이 이미 "위반 O"를 제출한 상태로 남겨, ConsensusSection의
  // "전원 제출 대기 중" 이후 스터디장 본인이 마저 제출하면 바로 판정되는
  // 흐름을 목업으로도 확인할 수 있게 한다(dummy-report-2와 유사하나 응답이
  // "이의제기"인 케이스 보강).
  {
    id: "dummy-report-9",
    nickname: "하윤",
    reason: "격자 기준을 벗어난 근접 화각",
    mode: "screenshot",
    reporterEmail: "minjun.k@gmail.com",
    ts: Date.now() - 5 * 60 * 60 * 1000,
    reviewStatus: "pending",
    nextOccurrence: 5,
    weeklyMinorPenaltyCount: 2,
    shouldDefer: false,
    deferOccurrence: null,
    deferredOccurrence: null,
    reporterName: "민준",
    targetResponse: "disputed",
    targetRespondedAt: Date.now() - 4 * 60 * 60 * 1000,
    targetResponseAuto: false,
    votes: { "13": { name: "유나", severity: "yes" as CaptureVote["severity"], votedAt: Date.now() - 30 * 60 * 1000 } },
    penalty: null,
    merit: null,
    timeDeduction: null,
    sourceFileId: null,
  },
];

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

  // 🧪 [목업 미리보기, 사용자 지시] 켜져 있는 동안 API 호출 없이 고정
  // 스냅샷(대기·이의제기 합의 투표 중·확정·반려 혼재)을 보여준다.
  const [showingDummy, setShowingDummy] = useState(false);
  const [items, setItems] = useState<CaptureReviewItem[] | null>(null);
  // 🔧 2026-09: 실제 부스터디장(공동 검토자) 명단과, 이 세션이 그중 누구인지
  // (isAdmin이 아닐 때만 값이 옴) — GET /admin/captures 응답에 함께 실려온다.
  const [coReviewers, setCoReviewers] = useState<CoReviewer[]>([]);
  const [myMemberNumber, setMyMemberNumber] = useState<string | null>(null);
  // 스터디장(주 관리자)일 때만 값이 옴 — "스터디장 (이름)" 라벨에 쓰인다.
  const [myName, setMyName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // 탭 복귀/당겨서 새로고침/폴링이 겹쳐 load()가 중복 호출되는 걸 막는
  // 가드 — loading state는 비동기라 ref로 즉시 확인한다.
  const loadingRef = useRef(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // 🔧 [UI 일관성, 2026-09-21] "기록 삭제" 확인을 브라우저 기본
  // window.confirm() 대신 앱 다이얼로그로 받는다 — 강제퇴실류가 이미
  // ExitProcessDialog로 확인받는 것과 같은 수준의 파괴적 액션인데 이
  // 화면만 네이티브 confirm(폰트/다크모드 미대응)이 튀어나와 이질감이
  // 있었다(전수조사에서 발견). 삭제 대상 하나만 담아두고, 다이얼로그의
  // "삭제" 버튼이 눌리면 실제 삭제(deleteCapture)를 실행한다.
  const [pendingDeleteItem, setPendingDeleteItem] = useState<CaptureReviewItem | null>(null);
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

  // 🔧 [사용자 지시, 2026-09-11] "화각 불량 제보 처리" 캐싱 정책 점검 —
  // 탭 복귀(useRefreshOnVisible)/당겨서 새로고침(usePullRefreshListener)/
  // 20분 폴링(usePollingRefresh)이 서로의 존재를 모른 채 각자 load()를
  // 호출해, 타이밍이 겹치면(예: 폴링 직전에 당겨서 새로고침) 같은 조회가
  // 중복으로 나갈 수 있었다. loadingRef로 "이미 진행 중이면 무시"하는
  // 가드를 추가한다 — loading state는 비동기 setState라 재진입 시점에
  // 아직 반영 안 됐을 수 있어 ref로 즉시 체크한다.
  function load(force = false) {
    if (showingDummy && !force) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
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
      .finally(() => {
        loadingRef.current = false;
        setLoading(false);
      });
  }

  useEffect(load, [cycleFileId]); // eslint-disable-line react-hooks/exhaustive-deps
  // 다른 학생이 이 탭을 벗어난 사이에 새 제보를 넣을 수 있어, 승인 대기열은
  // 관리자가 이 탭으로 돌아올 때마다 새로 불러와야 방금 들어온 제보를 놓치지 않는다.
  useRefreshOnVisible(visible, load);
  usePullRefreshListener(visible, load);
  // 탭을 벗어나지 않고 계속 띄워둔 채로도(다른 관리자가 처리한 결과 등)
  // 몇 분 안에 자동으로 최신 값을 받도록 폴링한다.
  // 🔧 [사용자 지시] 3분→10분으로 하향 — 이 폴링이 부스터디장 목록
  // (getCurrentCoReviewers)을 매번 캐시 없이 다시 조회하게 했던 원인이라
  // (사용자 지적), 그 목록을 5분 TTL로 캐싱하면서 폴링 주기도 그 2배인
  // 10분으로 늘렸다.
  // 🔧 [사용자 지시, 2026-09-11] 10분→20분 — penSlotGrid:가 60초에서
  // 5분으로 늘어나면서(§ attachNextOccurrence, "내 제보 확인"과 공유하는
  // 캐시), 배율을 10:5(2배)에서 20:5(4배)로 넉넉하게 맞추기 위함.
  // coReviewers:(5분)도 함께 10:5→20:5로 개선된다.
  const refreshProgress = usePollingRefresh(visible, load, 20 * 60_000);

  // 부스터디장(공동 검토자) 본인이 위반 수준 의견을 제출한다 — 성공하면
  // 서버에 실제 저장된 값을 다시 불러와 반영한다(다른 회원 임명 변경과
  // 같은 write-then-reload 패턴, MemberRosterList의 toggleViceLeader 참고).
  function submitVote(item: CaptureReviewItem, severity: string) {
    // 🧪 목업 중엔 실제 API를 호출하지 않고 items 배열의 votes만 로컬로
    // 갱신한다 — 이 화면은 스터디장(주 관리자) 본인이므로 실제로는
    // coReviewerDraft에 담기고 SeverityPicker가 그 값을 보여주지만,
    // 여기서는 재현을 위해 votes에도 반영해둔다.
    if (showingDummy) return;
    setVotingId(item.id);
    setError(null);
    call<CaptureVoteResponse>("/admin/captures/vote", { method: "POST", body: { id: item.id, severity } })
      .then(() => load())
      .catch((err) => setError(err instanceof Error ? err.message : "의견 제출에 실패했습니다."))
      .finally(() => setVotingId(null));
  }

  function decide(
    item: CaptureReviewItem,
    decision: "approved" | "rejected" | "rejected_recognized" | "deferred"
  ) {
    // 🧪 목업 중엔 실제 API를 호출하지 않고 로컬 state만 바꿔 확정/유예/
    // 반려 전환만 보여준다 — 운영 시트에 어떤 쓰기도 발생하지 않는다.
    if (showingDummy) {
      if (decision === "rejected") {
        setRejected((prev) => ({ ...prev, [item.id]: true }));
      } else {
        const occurrence = item.nextOccurrence ?? 1;
        const dayIndex = (new Date(item.ts).getDay() + 6) % 7; // 월=0..일=6
        const dayCol = DUMMY_STATUS_DAY_COLS[dayIndex];
        setApplied((prev) => ({
          ...prev,
          [item.id]: {
            decision,
            penalty:
              decision === "rejected_recognized"
                ? null
                : {
                    number: "14",
                    name: item.nickname,
                    occurrence,
                    isPCount: false,
                    col: DUMMY_OUTPUT_PEN_SLOT_COLUMNS[occurrence - 1] || "K",
                    deductedMinutes: expectedDeductedMinutes(item) ?? 0,
                    dayCol,
                    weeklyMinorPenaltyCount: item.weeklyMinorPenaltyCount + 1,
                  },
            merit: { number: "3", name: item.reporterName || "아름", occurrence: 1, col: DUMMY_REPORT_MERIT_SLOT_COLUMNS[0] },
            timeDeduction:
              decision === "deferred"
                ? { number: "14", deductedMinutes: expectedDeductedMinutes(item) ?? 0, dayCol }
                : null,
            sourceFileId: null,
          },
        }));
      }
      return;
    }
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
              sourceFileId: data.sourceFileId ?? null,
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
  // 쓰지 않았으므로 봇 manifest만 pending으로 되돌리면 되지만, "반려 (상점인정)"
  // (rejected_recognized)은 이미 제보자에게 제보상점이 부여됐을 수 있어
  // 그 슬롯도 함께 회수해야 한다 — 그러지 않으면 다시 판단하는 동안 상점만
  // 남는 불일치가 생긴다. 새로고침 후에도 동작해야 하므로(서버가 내려준
  // item.reviewStatus 기준으로도 눌릴 수 있어야 함) 로컬 상태만으로는 부족해
  // 서버에 /admin/captures/revert를 호출한다.
  function revertReject(item: CaptureReviewItem) {
    // 🧪 목업 중엔 실제 API를 호출하지 않고 로컬 state만 되돌린다. 더미
    // 항목은 item.reviewStatus 자체가 고정 데이터이므로, applied/rejected
    // 로컬 오버라이드만 지우면 isItemRejected가 다시 item.reviewStatus를
    // 보고 반려로 되돌아간다 — items 배열의 그 항목도 "pending"으로
    // 함께 패치해야 실제 응답과 동일하게 동작한다.
    if (showingDummy) {
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
      setItems((prev) => (prev ? prev.map((i) => (i.id === item.id ? { ...i, reviewStatus: "pending" } : i)) : prev));
      return;
    }
    const result = applied[item.id];
    const meritToCancel = result?.merit && !("error" in result.merit) ? result.merit : null;
    // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — meritToCancel
    // 이 있으면(반려 (상점인정)으로 이미 제보상점이 부여된 경우) 그게 실제로
    // 기록된 파일에서 회수해야 한다.
    const sourceFileId = meritToCancel ? (result?.sourceFileId ?? item.sourceFileId) : undefined;
    setDecidingId(item.id);
    setError(null);
    call<CaptureRevertResponse>("/admin/captures/revert", {
      method: "POST",
      body: { id: item.id, merit: meritToCancel, sourceFileId },
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
    return !!consensusEnabled[item.id] && effectiveCoReviewers.length > 0;
  }
  function canReject(item: CaptureReviewItem): boolean {
    if (!canProcess(item)) return false;
    if (!isConsensusActive(item)) return true;
    return computeConsensus(severityLevel[item.id], effectiveCoReviewers, item.votes || {}).allSubmitted;
  }
  // "적용"은 합의 모드가 켜져 있으면 "전원 제출 + 위반 O가
  // CONSENSUS_THRESHOLD명 이상"(검토 결과 위반으로 인정)일 때만 연다(사용자
  // 지시) — 전원이 제출했어도 위반 O가 기준 미만이면 인정이 아니므로
  // "적용"이 아니라 "반려"로 처리해야 한다.
  function canApply(item: CaptureReviewItem): boolean {
    if (!canProcess(item)) return false;
    if (!isConsensusActive(item)) return true;
    return computeConsensus(severityLevel[item.id], effectiveCoReviewers, item.votes || {}).willApprove;
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
    // 🧪 목업 중엔 실제 시트 취소 API(cancel-penalty/cancel-merit/revert)를
    // 호출하지 않고 로컬 state만 되돌린다.
    if (showingDummy) {
      setApplied((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      setItems((prev) => (prev ? prev.map((i) => (i.id === item.id ? { ...i, reviewStatus: "pending" } : i)) : prev));
      return;
    }
    const penalty = applied[item.id]?.penalty ?? item.penalty;
    const merit = applied[item.id]?.merit ?? item.merit;
    if (!penalty && !merit) return;
    const meritToCancel = merit && !("error" in merit) ? merit : null;
    // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — 실제로
    // 벌점/상점이 기록된 파일에서 취소해야 한다.
    const sourceFileId = applied[item.id]?.sourceFileId ?? item.sourceFileId;
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
                  sourceFileId,
                },
              })
            : Promise.resolve(),
          meritToCancel
            ? call<{ ok: boolean }>("/admin/captures/cancel-merit", {
                method: "POST",
                body: { number: meritToCancel.number, col: meritToCancel.col, sourceFileId },
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
    // 🧪 목업 중엔 실제 삭제 API를 호출하지 않고 목록에서만 로컬로 제거한다.
    if (showingDummy) {
      setItems((prev) => (prev ? prev.filter((i) => i.id !== item.id) : prev));
      return;
    }
    setDeletingId(item.id);
    setError(null);
    const result = applied[item.id];
    const meritToCancel = result?.merit && !("error" in result.merit) ? result.merit : null;
    // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — 로컬
    // 상태가 없으면(새로고침 등) item.sourceFileId로 폴백, 그것도 없으면
    // 서버가 findStoredPenaltyMerit으로 자체 폴백한다.
    const sourceFileId = result?.sourceFileId ?? item.sourceFileId;
    call<CaptureDeleteResponse>("/admin/captures/delete", {
      method: "POST",
      body: { id: item.id, penalty: result?.penalty || null, merit: meritToCancel, sourceFileId },
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

  const effectiveItems = showingDummy ? items ?? DUMMY_CAPTURE_ITEMS : items;
  const effectiveCoReviewers = showingDummy ? DUMMY_CO_REVIEWERS : coReviewers;

  return (
    <Collapsible defaultOpen className="flex flex-col">
      <SectionHeader
        icon={Flag}
        title="화각 불량 제보 처리"
        loading={loading}
        onRefresh={load}
        refreshProgress={refreshProgress}
        trailing={
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className={cn("shrink-0", showingDummy && "border-ok/30 bg-ok/15 text-ok hover:bg-ok/25 dark:hover:bg-ok/25")}
            onClick={() => {
              const next = !showingDummy;
              setShowingDummy(next);
              // 목업을 켤 땐 items에 고정 스냅샷을 넣고, 끌 땐 null로
              // 비워 useEffect가 실제 데이터를 다시 받아오게 한다 —
              // items를 그대로 두면 CapturePreview 등이 더미 id로 실제
              // 파일을 fetch하려다 실패한다(사용자 리포트: 502 에러).
              setItems(next ? DUMMY_CAPTURE_ITEMS : null);
              setExpandedDay(null);
              setExpandedId(null);
              setApplied({});
              setRejected({});
              setConsensusEnabled({});
              setSeverityLevel({});
              setCoReviewerDraft({});
              if (!next) load(true);
            }}
            aria-pressed={showingDummy}
            aria-label={showingDummy ? "목업 미리보기 끄기" : "목업 데이터로 미리보기"}
            title={showingDummy ? "목업 미리보기 끄기" : "목업 데이터로 미리보기"}
          >
            <FlaskConical className="size-3.5" strokeWidth={ICON_STROKE.default} />
          </Button>
        }
      />
      <CollapsiblePanel className="flex flex-col gap-4">
        <Dialog open={pendingDeleteItem !== null} onOpenChange={(open) => !open && setPendingDeleteItem(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>기록 삭제</DialogTitle>
              <DialogDescription>이 제보 기록을 완전히 삭제할까요? 되돌릴 수 없습니다.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Button
                variant="destructive"
                className="w-full sm:h-12 sm:text-base"
                onClick={() => {
                  if (pendingDeleteItem) deleteCapture(pendingDeleteItem);
                  setPendingDeleteItem(null);
                }}
              >
                삭제
              </Button>
              <Button
                variant="outline"
                className="w-full sm:h-12 sm:text-base"
                onClick={() => setPendingDeleteItem(null)}
              >
                취소
              </Button>
            </div>
          </DialogContent>
        </Dialog>
        {cycleFileIdProp === undefined && (
          <>
            <CycleSwitcher selectedFileId={cycleFileId} onSelect={setCycleFileId} includeUnpaid />
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

        {/* 🔧 [버그 수정, 2026-09] ReasonLeaveReviewList와 동일한 근본
            수정 — loading을 빼고 items의 실제 값만으로 렌더링해 재조회
            중엔 이전 화면이 그대로 유지되게 한다. */}
        {!effectiveItems && <AdminListSkeleton />}

        {effectiveItems && effectiveItems.length === 0 && <AdminEmptyState>처리 대기 중인 데이터가 없습니다.</AdminEmptyState>}

        {effectiveItems && effectiveItems.length > 0 && (
          <div className="flex flex-col gap-2 sm:gap-2.5">
            {groupByDay(effectiveItems).map((group) => {
              const isDayExpanded = expandedDay === group.dateKey;
              const appliedCount = group.items.filter((item) => isItemApplied(item, applied)).length;
              const deferredCount = group.items.filter((item) => isItemDeferred(item, applied)).length;
              const rejectedCount = group.items.filter((item) => isItemRejected(item, applied, rejected)).length;
              // "이의제기"/"위반인정"은 아직 관리자가 처리하지 않은 항목 중, 당사자가
              // 응답을 제출한 것만 센다 — 처리 완료(적용/유예/반려)된 건은
              // targetResponse가 남아있어도 그 결과 뱃지로만 표시한다.
              const stillPending = (item: CaptureReviewItem) =>
                !isItemApplied(item, applied) && !isItemDeferred(item, applied) && !isItemRejected(item, applied, rejected);
              const disputedCount = group.items.filter((item) => stillPending(item) && item.targetResponse === "disputed").length;
              const recognizedCount = group.items.filter((item) => stillPending(item) && item.targetResponse === "recognized").length;
              const pendingCount = group.items.length - appliedCount - deferredCount - rejectedCount - disputedCount - recognizedCount;
              return (
                // 🔧 [리팩토링, 2026-09-19] 요일별 그룹 헤더 바깥 골격을
                // DayGroupHeader로 공용화(admin/shared.tsx) — 이 파일만
                // ChevronDown이 뱃지 span 안쪽에 있던 구조라, header prop에는
                // ChevronDown을 빼고 넘겨 DayGroupHeader가 자동으로 붙이는
                // ChevronDown 하나만 남게 정리한다(중복 렌더링 방지).
                <DayGroupHeader
                  key={group.dateKey}
                  isExpanded={isDayExpanded}
                  onOpenChange={(open) => setExpandedDay(open ? group.dateKey : null)}
                  header={
                    <>
                      <span className="inline-flex shrink-0 items-center gap-1.25 text-sm font-semibold sm:text-base">
                        <CalendarDays className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                        {dateLabel(group.dateKey)}
                      </span>
                      <span className="ml-auto flex items-center gap-1.5">
                        {/* 🔧 [뱃지 통폐합, 2026-09-19] 사용자 지시로 6종(대기/이의제기/
                            위반인정/확정/유예/반려) 건수 뱃지가 장황하다고 판단해 "대기"
                            (당사자 응답 대기 단계 — 대기/이의제기/위반인정)와 "확정"(관리자
                            최종 처리 완료 단계 — 확정/유예/반려) 2종으로 통합한다.
                            세부 상태는 2차 토글(회원별 카드) 헤더에서 "대기 | 이의제기"
                            처럼 DividedValue로 이미 보여주므로 그룹 헤더는 큰 분류만
                            보여줘도 충분하다는 판단. */}
                        <span className="flex flex-wrap justify-end gap-1">
                          <TintedPill tone="amber" className="whitespace-nowrap">
                            대기 : {pendingCount + disputedCount + recognizedCount}건
                          </TintedPill>
                          <TintedPill tone="warn" className="whitespace-nowrap">
                            확정 : {appliedCount + deferredCount + rejectedCount}건
                          </TintedPill>
                        </span>
                      </span>
                    </>
                  }
                >
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
                        const isDeferred = isItemDeferred(item, applied);
                        const isRejected = isItemRejected(item, applied, rejected);
                        // 뱃지가 대기/이의/인정(=관리자가 아직 최종 처리하지 않은
                        // 상태)인 항목만 빨간 글로우로 강조해 처리를 유도한다
                        // (사용자 지시) — 적용/유예/반려로 이미 처리된 항목은 제외.
                        const isUnprocessed = !isApplied && !isDeferred && !isRejected;
                        // 🔧 [뱃지 통폐합, 2026-09-19] 사용자 지시로 헤더의 6종 뱃지
                        // (대기/이의/인정/적용/유예/반려, 확정 건은 추가로 차수·차감
                        // 시간 뱃지까지 최대 3개)를 "{대분류} | {세부}" 하나로
                        // 합친다 — 대분류는 관리자 최종 처리 여부(대기/확정), 세부는
                        // 실제 상태다. 세부 정보(차수·차감시간·반려 인정 여부)는
                        // 펼쳤을 때 "처리현황"/"학습시간 차감" SubRow에서 이미 전부
                        // 볼 수 있어 헤더에서는 뺀다(사용자 확인). 구분자는 이
                        // 프로젝트 관례인 DividedValue(텍스트 "|" 대신 세로선)를
                        // 그대로 재사용한다.
                        const statusPillGroup: "대기" | "확정" = isApplied || isDeferred || isRejected ? "확정" : "대기";
                        const statusPillDetail = isApplied
                          ? penaltyCategoryLabel((applied[item.id]?.penalty ?? item.penalty)?.occurrence ?? item.nextOccurrence)
                          : isDeferred
                            ? "유예"
                            : isRejected
                              ? "반려"
                              : item.targetResponse === "disputed"
                                ? "이의제기"
                                : item.targetResponse === "recognized"
                                  ? "위반인정"
                                  : "응답대기";
                        return (
                          <Collapsible key={item.id} open={isMemberExpanded} onOpenChange={(open) => setExpandedId(open ? item.id : null)}>
                          <div
                            className={cn(
                              "flex flex-col gap-2.5 rounded-lg border bg-card p-3",
                              isUnprocessed && "animate-unpaid-glow border-destructive"
                            )}
                          >
                            {/* 🔧 [사용자 지시] "토글 헤더 중간부 눌러도 토글 되도록"
                                — 이전엔 우측 끝 chevron 버튼만 클릭 가능했다. 요일
                                그룹 헤더(1차 토글)와 동일하게 헤더 행 전체를
                                CollapsibleTrigger로 감싸 어디를 눌러도 펼쳐지게 한다. */}
                            <CollapsibleTrigger
                              className="flex flex-col gap-2.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded sm:flex-row sm:items-center sm:justify-between"
                              aria-label={isMemberExpanded ? "상세 접기" : "상세 펼치기"}
                              hideChevron
                            >
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
                              <span className="flex items-center gap-1.5">
                                {/* 🔧 [뱃지 통폐합, 2026-09-19] 기존 최대 3개까지
                                    늘어나던 헤더 뱃지(확정+차수+차감시간, 유예+차수+
                                    차감시간 등)를 "{대분류} | {세부}" 단일 뱃지로
                                    합쳤다(사용자 지시 — 장황함 해소). 차수·차감시간·
                                    "반려 (상점인정)" 여부는 펼쳤을 때 처리현황/학습시간
                                    차감 SubRow에서 그대로 볼 수 있어 헤더에서는
                                    뺐다. 🔧 [색상 세분화, 2026-09-19 사용자 지시]
                                    "확정"이어도 실제 세부 조치(경고/벌점/페널티)와
                                    유예/반려를 색으로 구분한다 — 반려=회색/유예=
                                    노랑/경고=주황/벌점=연한빨강/페널티=진한빨강,
                                    대기 계열(접수/이의/인정)은 기존처럼 주황
                                    유지(statusPillTone, dashboard/shared.tsx 공용
                                    헬퍼 — 회원 화면 MyOutputPenSection과 매핑을
                                    반드시 함께 맞춰야 한다). */}
                                <TintedPill tone={statusPillTone(statusPillDetail)}>
                                  {/* 🔧 [사용자 지시, 2026-09-19] 제보 도메인 뱃지의 구분자를
                                      다른 화면이 공용으로 쓰는 DividedValue(세로선)와 별개로
                                      "·"(가운뎃점)로 바꾼다 — 카드 제목의 "이름 | 시각"
                                      구분(위 1318행 DividedValue)은 뱃지가 아니라 그대로 둔다. */}
                                  <DottedValue items={[statusPillGroup, statusPillDetail]} />
                                </TintedPill>
                                {/* 🔧 [사용자 지시] "1차 토글처럼 버튼 모양이 안 보이게" +
                                    "토글 헤더 중간부 눌러도 토글 되도록" — 헤더 행 전체가
                                    이제 CollapsibleTrigger이므로(위) 이 chevron은 더 이상
                                    별도 트리거가 아니라 상태만 보여주는 순수 아이콘이다. */}
                                <ChevronDown
                                  className={cn(
                                    "size-3.5 shrink-0 text-muted-foreground transition-transform",
                                    isMemberExpanded && "rotate-180"
                                  )}
                                  strokeWidth={ICON_STROKE.default}
                                />
                              </span>
                            </CollapsibleTrigger>

                            <CollapsiblePanel className="flex flex-col">
                            <div className="flex flex-col gap-2.5 pt-2.5">
                            {!isAdmin && (
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
                                    {showingDummy ? (
                                      <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed bg-muted">
                                        <p className="text-xs text-muted-foreground sm:text-sm">목업 이미지 (실제 파일 없음)</p>
                                      </div>
                                    ) : session?.token ? (
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
                                      <SubRow label="발생일시" value={formatDateTime24h(item.ts)} />
                                      <SubRow label="처리현황" value={statusLabel(item, (applied[item.id]?.penalty ?? item.penalty)?.occurrence ?? null)} />
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

                            {isAdmin && (
                              <>
                                <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:gap-3.5 sm:p-5">
                                  <div className="flex flex-col gap-1.5">
                                    <span className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base">
                                      <ImageIcon className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                      스크린샷 · 영상
                                    </span>
                                    {showingDummy ? (
                                      // 🧪 목업 항목은 실제 파일이 없어 CapturePreview의
                                      // fetch가 항상 실패한다 — 정적 플레이스홀더로 대체.
                                      <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed bg-muted">
                                        <p className="text-xs text-muted-foreground sm:text-sm">목업 이미지 (실제 파일 없음)</p>
                                      </div>
                                    ) : session?.token ? (
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
                                      <SubRow label="발생일시" value={formatDateTime24h(item.ts)} />
                                      <SubRow label="처리현황" value={statusLabel(item, (applied[item.id]?.penalty ?? item.penalty)?.occurrence ?? null)} />
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
                                          ? formatDateTime24h(item.targetRespondedAt)
                                          : "응답 대기 중"
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
                                      // 🔧 [사용자 지시] 반려 취소선 옆에 "반려"/"반려 (상점인정)"
                                      // 구분을 덧붙인다 — 유예가 "유예 N차"를 덧붙이는 것과
                                      // 동일한 이유(값만 보고 왜 적용이 안 됐는지 바로 알 수
                                      // 있도록). rejected_recognized는 로컬 세션(applied)
                                      // 또는 새로고침 후의 item.reviewStatus 둘 중 하나에만
                                      // 있을 수 있어 statusLabel/isItemRejected와 동일하게
                                      // 둘 다 확인한다.
                                      const isRejectedRecognized =
                                        applied[item.id]?.decision === "rejected_recognized" ||
                                        item.reviewStatus === "rejected_recognized";
                                      // 🔧 [버그 수정] deferOccurrence는 위 주석대로 이미 확정된
                                      // 유예(reviewStatus: "deferred")뿐 아니라 아직 pending인
                                      // 항목의 예상값에도 채워진다 — 있기만 하면 무조건 확정으로
                                      // 취급하면, 대상자 응답을 기다리는 중인 건도 "확정 적용"으로
                                      // 잘못 표시된다(사용자 실사례). reviewStatus로 실제 확정
                                      // 여부를 가른다.
                                      const isDecided =
                                        !!confirmedPenalty || item.reviewStatus === "deferred" || isRejectedDecided;
                                      // 🔧 [버그 수정] 취소선은 "원래 몇 차였을 조치가
                                      // 취소됐다"를 보여주는 용도인데, 잔여 슬롯이 없어
                                      // occurrence 자체가 null이면("적용 불가 (잔여 슬롯
                                      // 없음)") 애초에 취소할 조치 자체가 없어 취소선을
                                      // 긋는 게 논리적으로 맞지 않다(사용자 지적). 그 경우
                                      // "유예 N차"/"반려" 덧붙임 없이 순수 occurrenceLabel
                                      // 값만 보여준다.
                                      const decidedOccurrence = item.deferredOccurrence ?? item.nextOccurrence;
                                      return (
                                        <SubRow
                                          label={isDecided ? "확정 적용" : "예상 적용"}
                                          value={
                                            deferOccurrence && decidedOccurrence ? (
                                              <>
                                                <span className="line-through">{occurrenceLabel(decidedOccurrence)}</span>{" "}
                                                유예 {deferOccurrence}차
                                              </>
                                            ) : confirmedPenalty ? (
                                              occurrenceLabel(confirmedPenalty.occurrence)
                                            ) : isRejectedDecided && decidedOccurrence ? (
                                              <>
                                                <span className="line-through">{occurrenceLabel(decidedOccurrence)}</span>{" "}
                                                {isRejectedRecognized ? "반려 (상점인정)" : "반려"}
                                              </>
                                            ) : (
                                              occurrenceLabel(deferOccurrence || isRejectedDecided ? decidedOccurrence : item.nextOccurrence)
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
                                      coReviewers={effectiveCoReviewers}
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
                                    // "반려 취소" — 순수 반려("rejected")든 반려 (상점인정)
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
                                          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1.25 rounded-md bg-background/85 text-micro-lg font-semibold text-muted-foreground backdrop-blur-[1px] sm:text-xs">
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
                                      onClick={() => setPendingDeleteItem(item)}
                                      aria-label="기록 삭제"
                                    >
                                      <Trash2 className="size-4" strokeWidth={ICON_STROKE.default} />
                                    </Button>
                                  )}
                                </div>
                              </>
                            )}
                            </div>
                            </CollapsiblePanel>
                          </div>
                          </Collapsible>
                        );
                      })}
                </DayGroupHeader>
              );
            })}
          </div>
        )}
      </CollapsiblePanel>
    </Collapsible>
  );
}
