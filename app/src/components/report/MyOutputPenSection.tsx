import { useEffect, useRef, useState } from "react";
import { ListChecks, ChevronDown, CalendarDays, Image as ImageIcon, Trash2, FileText, Clock, Gavel, Star, FlaskConical } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { InfoCard, SubRow, TintedPill, STATUS_DAYS, statusPillTone } from "@/components/dashboard/shared";
import {
  SectionHeader,
  SectionCard,
  CapturePreview,
  AdminListSkeleton,
  AdminEmptyState,
  formatDateTime24h,
  occurrenceLabel,
  penaltyCategoryLabel,
  weeklyImpactLabel,
  formatDeductedTime,
  statusLabel,
  DottedValue,
} from "@/components/admin/shared";
import { CycleSwitcher } from "@/components/dashboard/CycleSwitcher";
import { useApi } from "@/hooks/useApi";
import { useRefreshOnVisible } from "@/hooks/useRefreshOnVisible";
import { usePollingRefresh } from "@/hooks/usePollingRefresh";
import { useAuth } from "@/lib/auth/useAuth";
import { ICON_STROKE, cn } from "@/lib/utils";
import { toKSTDateString } from "@/lib/date";
import type {
  MyCaptureDeleteResponse,
  MyCaptureItem,
  MyCapturesResponse,
  MyOutputPenItem,
  MyOutputPenResponse,
  TargetRespondResponse,
} from "@/lib/api/types";

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


// 🔧 [공용화, 2026-09-19 사용자 지시] statusLabel/actionLabel/
// occurrenceLabel/penaltyCategoryLabel/weeklyImpactLabel/formatDeductedTime
// 은 관리자 화면(ReportReviewList.tsx)과 완전히 동일한 로직을 복제해
// 갖고 있었다 — "한쪽만 고치면 서로 달라지는" 문제를 없애기 위해
// admin/shared.tsx로 옮기고 두 파일이 함께 import한다.

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

// 🔧 [수신/발신 통합, 2026-09-19 사용자 지시] 발신 건(제보자 본인)의
// "처리현황"은 관리자 화면과 공유하는 statusLabel(반려/유예/경고/벌점/
// 페널티 등 세부 조치까지 노출)을 쓰지 않는다 — "제보자와 자세한 처리
// 내역을 공유할 필요는 없다"는 목적에 따라, 검토 완료 전까지는 "검토
// 중"만, 완료 후에는 실제 적용 여부(유예/반려도 결과적으로 벌점 미적용
// 이므로 "위반 미인정"에 포함)만 보여준다.
function sentStatusLabel(item: MyOutputPenItem): string {
  if (item.reviewStatus === "pending") return "검토 중";
  // 🔧 [버그 재수정, 2026-09-19] applyReportMerit(report-penalty.js
  // 492~549행)을 다시 확인한 결과, 제보상점은 approved/rejected_recognized
  // 뿐 아니라 "deferred"(유예)에서도 지급된다 — 492행 조건문이 이 셋을
  // 하나의 블록으로 묶어 함께 applyReportMerit을 호출하기 때문이다(유예는
  // "위반 인정, 다만 당일 1회 제한으로 대상자 벌점만 면제"라는 뜻이라
  // 제보자 상점은 그대로 지급됨). 제보상점이 지급되지 않는 건 시트에
  // 아무것도 쓰지 않는 순수 "rejected"(561행, 별도 블록) 하나뿐이다.
  const recognized = item.reviewStatus !== "rejected";
  return `검토 완료 (${recognized ? "위반 인정" : "위반 미인정"})`;
}

// "송출 P 대상 처리"(관리자용 ReportReviewList)와 동일한 요일별 아코디언 →
// 항목별 토글 → 캡처 미리보기 구조를 재활용한다(사용자 지시). 이 화면은
// 두 가지 서로 다른 항목을 같은 섹션에 함께 보여준다(사용자 지시):
// - "내 화각 점검"(kind: "selfCheck") — 본인이 스스로 찍은 것, 벌점/페널티
//   판정 대상이 아닌 읽기 전용.
// - "제보 목록"(kind: "outputPen", 🔧 [수신/발신 통합, 2026-09-19] 이전
//   이름 "received"에서 변경 — GET /my-output-pen이 이제 수신(대상자가
//   본인)뿐 아니라 발신(제보자가 본인)도 함께 내려주므로, "받은 제보"만을
//   뜻하던 옛 이름이 더 이상 정확하지 않다) — 각 항목의 실제 방향은
//   `data.direction`("received" | "sent")으로 구분한다. 수신 건만
//   대상자 본인이 "위반인정"/"이의제기" 중 하나를 제출할 수 있다
//   (관리자 화면의 90분 타임아웃·"다른 관리자 의견 반영" 활성화 조건이
//   이 응답을 사용한다) — 발신 건은 읽기 전용이다.
type MergedItem =
  | { kind: "selfCheck"; id: string; ts: number; data: MyCaptureItem }
  | { kind: "outputPen"; id: string; ts: number; data: MyOutputPenItem };

// 🔧 [버그 수정] 관리자 화면(ReportReviewList)의 groupByDay/thisWeekDateLabel은
// "이번 주 대기 건만" 다루는 화면이라 요일 이름(월~일)만으로 그룹핑해도
// 문제가 없었다. 하지만 이 컴포넌트는 여러 주에 걸친 이력을 계속 쌓아
// 보여주므로, 요일 이름만으로 그룹핑하면 서로 다른 주의 같은 요일이
// 하나로 합쳐지고, 헤더 날짜는 "오늘이 속한 주의 그 요일"로 계산돼 실제
// 항목 날짜와 어긋나 보이는 문제가 있었다(예: 9월 6일 접수 건인데 헤더가
// "9월 13일"로 표시). 요일 이름 대신 KST 기준 실제 날짜(YYYY-MM-DD)로
// 그룹핑해 이 문제를 근본적으로 없앤다.
// 🔧 [중복 제거, 2026-09-21] ReportReviewList.tsx에 거의 동일하게
// 복사돼 있던 이 함수를 lib/date.ts의 toKSTDateString으로 통합했다.
function kstDateKey(ts: number): string {
  return toKSTDateString(ts);
}

function dateLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const dayKr = STATUS_DAYS[(date.getDay() + 6) % 7];
  return `${m}월 ${d}일 ${dayKr}요일`;
}

function groupByDay(items: MergedItem[]) {
  const map = new Map<string, MergedItem[]>();
  for (const item of items) {
    const key = kstDateKey(item.ts);
    const existing = map.get(key);
    if (existing) existing.push(item);
    else map.set(key, [item]);
  }
  // 🔧 [사용자 지시] "12일이 9일보다 위에 있어" — 날짜 그룹은 오래된
  // 날짜가 위로 오도록 오름차순 정렬(그룹 내부 항목의 정렬 방향과 통일).
  return Array.from(map.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([dateKey, groupItems]) => ({ dateKey, items: groupItems }));
}

// 🧪 [목업 미리보기, 사용자 지시] 관리자 화면(ReportReviewList)과 동일한
// 패턴 — 실제 API 호출 없이 이 화면이 다룰 수 있는 상태(내 화각 점검/
// 받은 제보, 응답 대기·이의제기·위반인정·90분 자동응답, 확정(경고/벌점/
// 페널티)·유예·반려)를 한 번에 점검한다. occurrence 매핑은
// actionLabel()(1=구두경고, 2·3·5=벌점, 4·6=송출 P)과 정확히 맞춘다.
// 시각은 항상 "지금 기준 최근"으로 보이도록 Date.now() 상대값으로 채운다.
const DUMMY_NOW = Date.now();

const DUMMY_SELF_CHECK_ITEMS: MyCaptureItem[] = [
  { id: "dummy-self-1", nickname: "재희", reason: "", mode: "screenshot", ts: DUMMY_NOW - 3 * 60 * 60 * 1000 },
  { id: "dummy-self-2", nickname: "재희", reason: "", mode: "video", ts: DUMMY_NOW - 30 * 60 * 60 * 1000 },
  // 🔧 [논리적 삭제, 2026-09-19] 본인이 삭제 버튼을 눌러 deleted 오버레이가
  // 뜨는 케이스도 목업으로 미리보기 가능하게 한다.
  { id: "dummy-self-3", nickname: "재희", reason: "", mode: "screenshot", ts: DUMMY_NOW - 50 * 60 * 60 * 1000, deleted: true, deletedReason: "manual" },
  // 🔧 [10일 경과 자동 논리적 삭제, 2026-09-19] 봇의 매일 배치가 접수 10일
  // 경과 건에 세팅하는 케이스 — "10일 초과로 삭제처리 되었습니다" 문구가
  // 뜨는지 목업으로 확인할 수 있게 한다.
  {
    id: "dummy-self-4",
    nickname: "재희",
    reason: "",
    mode: "screenshot",
    ts: DUMMY_NOW - 11 * 24 * 60 * 60 * 1000,
    deleted: true,
    deletedReason: "expired",
  },
];

const DUMMY_RECEIVED_ITEMS: MyOutputPenItem[] = [
  // 아직 응답하지 않은 건 — "응답 대기 중"(글로우 강조 대상).
  {
    id: "dummy-received-1",
    reason: "격자 기준을 벗어난 근접 화각",
    mode: "screenshot",
    ts: DUMMY_NOW - 1 * 60 * 60 * 1000,
    reviewStatus: "pending",
    targetResponse: null,
    targetRespondedAt: null,
    targetResponseAuto: false,
    nextOccurrence: 2,
    weeklyMinorPenaltyCount: 1,
    deferOccurrence: null,
    deferredOccurrence: null,
    penalty: null,
    merit: null,
    timeDeduction: null,
    deleted: false,
    deletedReason: null,
    direction: "received",
    targetName: "재희",
  },
  // 이의제기 제출, 관리자 검토 대기 중.
  {
    id: "dummy-received-2",
    reason: "전자기기 사용목적 확인 불가",
    mode: "video",
    ts: DUMMY_NOW - 5 * 60 * 60 * 1000,
    reviewStatus: "pending",
    targetResponse: "disputed",
    targetRespondedAt: DUMMY_NOW - 4 * 60 * 60 * 1000,
    targetResponseAuto: false,
    nextOccurrence: 4,
    weeklyMinorPenaltyCount: 0,
    deferOccurrence: null,
    deferredOccurrence: null,
    penalty: null,
    merit: null,
    timeDeduction: null,
    deleted: false,
    deletedReason: null,
    direction: "received",
    targetName: "재희",
  },
  // 90분 무응답으로 시스템이 자동으로 위반인정 처리 — 아직 관리자 검토 전.
  {
    id: "dummy-received-3",
    reason: "기타 사유",
    mode: "screenshot",
    ts: DUMMY_NOW - 2 * 60 * 60 * 1000,
    reviewStatus: "pending",
    targetResponse: "recognized",
    targetRespondedAt: DUMMY_NOW - 30 * 60 * 1000,
    targetResponseAuto: true,
    nextOccurrence: 1,
    weeklyMinorPenaltyCount: 0,
    deferOccurrence: null,
    deferredOccurrence: null,
    penalty: null,
    merit: null,
    timeDeduction: null,
    deleted: false,
    deletedReason: null,
    direction: "received",
    targetName: "재희",
  },
  // 확정 — 1차(구두경고), 응답 지연 없어 시간 차감 0분(뱃지 숨김 케이스).
  {
    id: "dummy-received-4",
    reason: "얼굴, 정수리 등 노출",
    mode: "screenshot",
    ts: DUMMY_NOW - 28 * 60 * 60 * 1000,
    reviewStatus: "approved",
    targetResponse: "recognized",
    targetRespondedAt: DUMMY_NOW - 27 * 60 * 60 * 1000,
    targetResponseAuto: false,
    nextOccurrence: null,
    weeklyMinorPenaltyCount: 0,
    deferOccurrence: null,
    deferredOccurrence: null,
    penalty: { number: "1", name: "재희", occurrence: 1, isPCount: false, col: "F", deductedMinutes: 0, dayCol: null, weeklyMinorPenaltyCount: 0 },
    merit: null,
    timeDeduction: null,
    deleted: false,
    deletedReason: null,
    direction: "received",
    targetName: "재희",
  },
  // 확정 — 4차(송출 P 1회), 응답 지연 35분 발생(20분 유예 초과 15분 차감).
  {
    id: "dummy-received-5",
    reason: "과도한 스티커 사용",
    mode: "video",
    ts: DUMMY_NOW - 50 * 60 * 60 * 1000,
    reviewStatus: "approved",
    targetResponse: "disputed",
    targetRespondedAt: DUMMY_NOW - 49 * 60 * 60 * 1000 + 35 * 60 * 1000,
    targetResponseAuto: false,
    nextOccurrence: null,
    weeklyMinorPenaltyCount: 2,
    deferOccurrence: null,
    deferredOccurrence: null,
    penalty: { number: "1", name: "재희", occurrence: 4, isPCount: true, col: "I", deductedMinutes: 15, dayCol: "P", weeklyMinorPenaltyCount: 2 },
    merit: null,
    timeDeduction: null,
    deleted: false,
    deletedReason: null,
    direction: "received",
    targetName: "재희",
  },
  // 유예 — 당일 이미 1회 적용을 받아 2번째 건은 벌점만 면제, 시간 차감은 그대로.
  {
    id: "dummy-received-6",
    reason: "손 또는 학습자료 확인 불가",
    mode: "screenshot",
    ts: DUMMY_NOW - 32 * 60 * 60 * 1000,
    reviewStatus: "deferred",
    targetResponse: "recognized",
    targetRespondedAt: DUMMY_NOW - 31 * 60 * 60 * 1000,
    targetResponseAuto: false,
    nextOccurrence: null,
    weeklyMinorPenaltyCount: 1,
    deferOccurrence: 1,
    deferredOccurrence: 3,
    penalty: null,
    merit: null,
    timeDeduction: { number: "1", deductedMinutes: 12, dayCol: "P" },
    deleted: false,
    deletedReason: null,
    direction: "received",
    targetName: "재희",
  },
  // 반려 — 이의제기가 받아들여져 페널티 자체가 취소됨.
  {
    id: "dummy-received-7",
    reason: "격자 기준을 벗어난 근접 화각",
    mode: "screenshot",
    ts: DUMMY_NOW - 55 * 60 * 60 * 1000,
    reviewStatus: "rejected",
    targetResponse: "disputed",
    targetRespondedAt: DUMMY_NOW - 54 * 60 * 60 * 1000,
    targetResponseAuto: false,
    nextOccurrence: null,
    weeklyMinorPenaltyCount: 0,
    deferOccurrence: null,
    deferredOccurrence: null,
    penalty: null,
    merit: null,
    timeDeduction: null,
    deleted: false,
    deletedReason: null,
    direction: "received",
    targetName: "재희",
  },
  // 확정 — 3차(벌점), 잔여 슬롯 있어 정상 적용(occurrence 2/3/5 벌점군 중
  // 아직 없던 3차 케이스 보강).
  {
    id: "dummy-received-8",
    reason: "손 또는 학습자료 확인 불가",
    mode: "video",
    ts: DUMMY_NOW - 45 * 60 * 60 * 1000,
    reviewStatus: "approved",
    targetResponse: "recognized",
    targetRespondedAt: DUMMY_NOW - 44 * 60 * 60 * 1000,
    targetResponseAuto: false,
    nextOccurrence: null,
    weeklyMinorPenaltyCount: 3,
    deferOccurrence: null,
    deferredOccurrence: null,
    penalty: { number: "1", name: "재희", occurrence: 3, isPCount: false, col: "H", deductedMinutes: 0, dayCol: null, weeklyMinorPenaltyCount: 3 },
    merit: null,
    timeDeduction: null,
    deleted: false,
    deletedReason: null,
    direction: "received",
    targetName: "재희",
  },
  // 반려 (상점인정) — 위반은 인정되나 잔여 슬롯이 없어 등록 불가, 대상자에게는
  // 아무 처리도 되지 않음(관리자 화면과 동일하게 "반려"로 표시됨).
  {
    id: "dummy-received-9",
    reason: "얼굴, 정수리 등 노출",
    mode: "screenshot",
    ts: DUMMY_NOW - 65 * 60 * 60 * 1000,
    reviewStatus: "rejected_recognized",
    targetResponse: "recognized",
    targetRespondedAt: DUMMY_NOW - 64 * 60 * 60 * 1000,
    targetResponseAuto: false,
    nextOccurrence: null,
    weeklyMinorPenaltyCount: 0,
    deferOccurrence: null,
    deferredOccurrence: null,
    penalty: null,
    merit: null,
    timeDeduction: null,
    deleted: false,
    deletedReason: null,
    direction: "received",
    targetName: "재희",
  },
  // 🔧 [10일 경과 자동 논리적 삭제, 2026-09-19] 접수 10일 초과 확정 건 —
  // "10일 초과로 삭제처리 되었습니다" 오버레이를 수신 화면에서도 목업으로
  // 확인할 수 있게 한다.
  {
    id: "dummy-received-10",
    reason: "손 또는 학습자료 확인 불가",
    mode: "screenshot",
    ts: DUMMY_NOW - 11 * 24 * 60 * 60 * 1000,
    reviewStatus: "approved",
    targetResponse: "recognized",
    targetRespondedAt: DUMMY_NOW - 11 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000,
    targetResponseAuto: false,
    nextOccurrence: null,
    weeklyMinorPenaltyCount: 1,
    deferOccurrence: null,
    deferredOccurrence: null,
    penalty: { number: "1", name: "재희", occurrence: 2, isPCount: false, col: "G", deductedMinutes: 0, dayCol: null, weeklyMinorPenaltyCount: 1 },
    merit: null,
    timeDeduction: null,
    deleted: true,
    deletedReason: "expired",
    direction: "received",
    targetName: "재희",
  },
  // 발신 — 내가 제보한 건, 아직 대상자 응답 대기 중(읽기 전용, 버튼 없음).
  {
    id: "dummy-sent-1",
    reason: "얼굴, 정수리 등 노출",
    mode: "screenshot",
    ts: DUMMY_NOW - 3 * 60 * 60 * 1000,
    reviewStatus: "pending",
    targetResponse: null,
    targetRespondedAt: null,
    targetResponseAuto: false,
    nextOccurrence: 1,
    weeklyMinorPenaltyCount: 0,
    deferOccurrence: null,
    deferredOccurrence: null,
    penalty: null,
    merit: null,
    timeDeduction: null,
    deleted: false,
    deletedReason: null,
    direction: "sent",
    targetName: "민준",
  },
  // 발신 — 내가 제보한 건, 위반인정으로 확정(벌점) — 읽기 전용.
  {
    id: "dummy-sent-2",
    reason: "과도한 스티커 사용",
    mode: "video",
    ts: DUMMY_NOW - 40 * 60 * 60 * 1000,
    reviewStatus: "approved",
    targetResponse: "recognized",
    targetRespondedAt: DUMMY_NOW - 39 * 60 * 60 * 1000,
    targetResponseAuto: false,
    nextOccurrence: null,
    weeklyMinorPenaltyCount: 1,
    deferOccurrence: null,
    deferredOccurrence: null,
    penalty: { number: "7", name: "민준", occurrence: 2, isPCount: false, col: "G", deductedMinutes: 0, dayCol: null, weeklyMinorPenaltyCount: 1 },
    merit: { number: "1", name: "재희", occurrence: 3, col: "T" },
    timeDeduction: null,
    deleted: false,
    deletedReason: null,
    direction: "sent",
    targetName: "민준",
  },
  // 발신 — 대상자가 이의제기를 제출, 아직 관리자 검토 대기 중("발신 대기 검토").
  {
    id: "dummy-sent-3",
    reason: "전자기기 사용목적 확인 불가",
    mode: "screenshot",
    ts: DUMMY_NOW - 6 * 60 * 60 * 1000,
    reviewStatus: "pending",
    targetResponse: "disputed",
    targetRespondedAt: DUMMY_NOW - 5 * 60 * 60 * 1000,
    targetResponseAuto: false,
    nextOccurrence: 5,
    weeklyMinorPenaltyCount: 1,
    deferOccurrence: null,
    deferredOccurrence: null,
    penalty: null,
    merit: null,
    timeDeduction: null,
    deleted: false,
    deletedReason: null,
    direction: "sent",
    targetName: "하윤",
  },
  // 발신 — 90분 무응답 자동 위반인정, 아직 관리자 검토 전.
  {
    id: "dummy-sent-4",
    reason: "기타 사유",
    mode: "video",
    ts: DUMMY_NOW - 4 * 60 * 60 * 1000,
    reviewStatus: "pending",
    targetResponse: "recognized",
    targetRespondedAt: DUMMY_NOW - 90 * 60 * 1000,
    targetResponseAuto: true,
    nextOccurrence: 1,
    weeklyMinorPenaltyCount: 0,
    deferOccurrence: null,
    deferredOccurrence: null,
    penalty: null,
    merit: null,
    timeDeduction: null,
    deleted: false,
    deletedReason: null,
    direction: "sent",
    targetName: "서준",
  },
  // 발신 — 이의제기가 받아들여져 순수 반려됨(제보상점 미지급) —
  // "발신 확정 반려"(회색).
  {
    id: "dummy-sent-5",
    reason: "격자 기준을 벗어난 근접 화각",
    mode: "screenshot",
    ts: DUMMY_NOW - 60 * 60 * 60 * 1000,
    reviewStatus: "rejected",
    targetResponse: "disputed",
    targetRespondedAt: DUMMY_NOW - 59 * 60 * 60 * 1000,
    targetResponseAuto: false,
    nextOccurrence: null,
    weeklyMinorPenaltyCount: 0,
    deferOccurrence: null,
    deferredOccurrence: null,
    penalty: null,
    merit: null,
    timeDeduction: null,
    deleted: false,
    deletedReason: null,
    direction: "sent",
    targetName: "하윤",
  },
  // 발신 — 대상자가 당일 이미 1회 적용을 받아 유예 처리(벌점만 면제, 응답
  // 지연 시간 차감은 그대로 적용) — applyReportMerit은 deferred에서도
  // 제보상점을 지급하므로(위 sentStatusLabel 주석 참고) "발신 확정 상점"
  // (초록)으로 표시된다 — approved/rejected_recognized와 다른 결정
  // 경로에서도 동일하게 상점이 지급되는 케이스를 커버.
  {
    id: "dummy-sent-6",
    reason: "손 또는 학습자료 확인 불가",
    mode: "screenshot",
    ts: DUMMY_NOW - 33 * 60 * 60 * 1000,
    reviewStatus: "deferred",
    targetResponse: "recognized",
    targetRespondedAt: DUMMY_NOW - 32 * 60 * 60 * 1000,
    targetResponseAuto: false,
    nextOccurrence: null,
    weeklyMinorPenaltyCount: 1,
    deferOccurrence: 2,
    deferredOccurrence: 4,
    penalty: null,
    // 🔧 [버그 수정] applyReportMerit(report-penalty.js)은 deferred(유예)
    // 결정에서도 제보자에게 제보상점을 지급한다 — 이 목업은 merit: null로
    // 남아있어 "이번 상점"은 맞게 나와도(reviewStatus !== "rejected") "누적
    // 상점"(meritOccurrence 필요) SubRow가 안 뜨는 불일치가 있었다.
    merit: { number: "1", name: "재희", occurrence: 4, col: "U" },
    timeDeduction: { number: "1", deductedMinutes: 8, dayCol: "P" },
    deleted: false,
    deletedReason: null,
    direction: "sent",
    targetName: "서준",
  },
  // 발신 — 잔여 슬롯이 없어 "반려 (상점인정)"으로 확정, 제보상점은 지급됨
  // ("발신 확정 상점", 초록).
  {
    id: "dummy-sent-7",
    reason: "과도한 스티커 사용",
    mode: "video",
    ts: DUMMY_NOW - 70 * 60 * 60 * 1000,
    reviewStatus: "rejected_recognized",
    targetResponse: "recognized",
    targetRespondedAt: DUMMY_NOW - 69 * 60 * 60 * 1000,
    targetResponseAuto: false,
    nextOccurrence: null,
    weeklyMinorPenaltyCount: 0,
    deferOccurrence: null,
    deferredOccurrence: null,
    penalty: null,
    merit: { number: "1", name: "재희", occurrence: 5, col: "V" },
    timeDeduction: null,
    deleted: false,
    deletedReason: null,
    direction: "sent",
    targetName: "민준",
  },
];

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
  // 🔧 [사용자 지시, 2026-09-11] "새로고침 버튼도 새 접수 내역이 있을 때만
  // 활성화" — 대시보드의 TTL 기반 비활성화(refreshDisabled)와 같은 시각
  // 언어를 쓰되, 신선도를 "시간"이 아니라 "감지"로 판단한다(이 화면은
  // 캐시가 없어 시간만으로는 신선도를 예측할 수 없음). 폴링을 두 단계로
  // 분리했다:
  // - 20분 "렌더" 폴링(load, 아래) — 실제로 목록을 갱신하고, 갱신한
  //   순간엔 더 이상 안 보여준 게 없으므로 버튼을 다시 비활성화한다.
  // - 5분 "감지" 폴링(detectNew, 아래) — /my-output-pen만 가볍게 불러와
  //   지금 화면에 렌더된 id와 비교, 새 id가 있으면 버튼만 활성화한다
  //   (목록 자체는 안 바꿈 — 사용자가 직접 새로고침을 눌러야 반영).
  // 기본값 false(비활성화)로 시작 — 아직 아무것도 감지된 게 없으므로.
  const [hasNewReceived, setHasNewReceived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // 🧪 [목업 미리보기, 사용자 지시] 관리자 화면(ReportReviewList)과 동일한
  // showingDummy 패턴 — 켜져 있는 동안 실제 API 호출(load/detectNew)을
  // 막고 고정 스냅샷(DUMMY_SELF_CHECK_ITEMS/DUMMY_RECEIVED_ITEMS)만
  // 보여준다.
  const [showingDummy, setShowingDummy] = useState(false);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // 🔧 [UI 일관성, 2026-09-21] "기록 삭제" 확인을 브라우저 기본
  // window.confirm() 대신 앱 다이얼로그로 받는다 — ReportReviewList의
  // 관리자용 삭제 확인과 동일한 패턴(전수조사에서 발견, 되돌릴 수 없는
  // 셀프서비스 삭제라도 위험도는 같음).
  const [pendingDeleteItem, setPendingDeleteItem] = useState<MyCaptureItem | null>(null);
  // 🔧 [3주 사이클 토글] "현재 진행 중인 사이클"에서 어느 주(월~일, KST)를
  // 볼지 — null이면 현재(실시간), 아니면 CycleSwitcher가 넘긴 백업 fileId.
  // 사이클 밖(4주 이상 전)은 기존 CycleSwitcher와 마찬가지로 조회 대상이 아니다.
  const [cycleFileId, setCycleFileId] = useState<string | null>(null);
  // 🔧 [경쟁 조건 수정, 2026-09-10] 주차 토글을 빠르게 연달아 누르면 매번
  // load()가 다시 실행되는데, 먼저 시작된 요청(옛 주차)이 나중 요청(새
  // 주차)보다 늦게 도착하면 "가장 늦게 응답한 것"이 그대로 화면을 덮어써
  // 선택과 다른 주차 데이터가 보일 수 있었다 — MyStatusContext의 refresh()
  // 와 동일한 순번 가드를 적용해, 그사이 더 최신 load()가 시작됐으면 이번
  // 응답은 버린다.
  const requestIdRef = useRef(0);
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

  function load(force = false) {
    // 🧪 목업 중엔 실제 API를 호출하지 않는다 — 목업을 끌 때(force=true)만
    // 실제 데이터로 복원하기 위해 다시 호출된다(아래 트레일링 버튼 참고).
    if (showingDummy && !force) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    loadOnce(cycleFileId)
      .catch(() => new Promise((resolve) => setTimeout(resolve, 800)).then(() => loadOnce(cycleFileId)))
      .then(([captures, outputPen]) => {
        if (requestId !== requestIdRef.current) return;
        setSelfCheckItems(captures.items || []);
        setReceivedItems(outputPen.items || []);
        // 방금 전체를 새로 받아와 화면에 그대로 반영했으니, 더 이상
        // "안 보여준 새 항목"은 없다 — 버튼을 다시 비활성화한다.
        setHasNewReceived(false);
      })
      .catch((err) => {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : "제보 확인 목록을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (requestId !== requestIdRef.current) return;
        setLoading(false);
      });
  }

  // 🔧 [사용자 지시, 2026-09-11] "감지" 전용 — /my-output-pen만 가볍게
  // 불러와 지금 렌더된 receivedItems의 id와 비교한다. 다른 것(로딩 상태,
  // selfCheckItems, 목록 자체)은 전혀 안 건드린다 — 새 항목이 있다는
  // 사실만 새로고침 버튼에 반영한다.
  function detectNew() {
    // 🧪 목업 중엔 "새 항목 감지"도 실제 API를 호출하지 않는다.
    if (showingDummy) return;
    const cycleParam = cycleFileId ? `?cycle=${encodeURIComponent(cycleFileId)}` : "";
    call<MyOutputPenResponse>(`/my-output-pen${cycleParam}`)
      .then((data) => {
        const currentIds = new Set((receivedItems || []).map((it) => it.id));
        const hasNew = (data.items || []).some((it) => !currentIds.has(it.id));
        if (hasNew) setHasNewReceived(true);
      })
      .catch(() => {
        // 감지 실패는 조용히 넘어간다 — 다음 감지 틱이나 20분 렌더
        // 폴링이 알아서 다시 시도한다.
      });
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
  // 🔧 [사용자 지시, 2026-09-10] 3분 → 10분으로 하향 — 관리자가 실제로
  // 처리한 결과는 penalty 그룹 무효화로 이미 즉시 반영되므로(§관련
  // penSlotGrid:/members:/penCycle: 캐시), 이 폴링은 "무효화를 놓쳤을
  // 때의 안전망"일 뿐이다. 화면을 계속 띄워둔 채로도 몇 분 안에 자동
  // 반영되면 충분하다는 판단.
  // 🔧 [사용자 지시, 2026-09-11] 10분 → 20분 — 실제 목록 갱신(렌더)은
  // 이 폴링이 맡고, "새 항목이 왔는지"는 아래 더 짧은 감지 폴링이 대신
  // 맡도록 역할을 분리했다. penSlotGrid:도 60초→5분으로 늘어(§
  // attachNextOccurrence) 20분 폴링 기준 배율이 4배로 넉넉해졌다.
  const refreshProgress = usePollingRefresh(visible, load, 20 * 60_000);
  // 🔧 [사용자 지시, 2026-09-11] "새로고침 버튼도 새 접수 내역이 있을
  // 때만 활성화" — 렌더 폴링(20분)과 별개로, 훨씬 짧은 주기(5분)로 가볍게
  // "새 게 있는지"만 확인한다. penSlotGrid:도 5분 TTL이라 배율 1:1이지만,
  // attachNextOccurrence가 pending 건이 없으면 그 캐시 자체를 안 건드리게
  // 고쳐져 있어(백엔드) 실제 트리거 빈도는 낮다.
  usePollingRefresh(visible, detectNew, 5 * 60_000);
  useEffect(() => {
    if (refreshSignal) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  // 당사자 본인이 "위반인정"/"이의제기" 중 하나를 제출한다 — 제출 성공 시
  // 서버 재조회 없이 로컬 상태만 갱신해 즉시 반영한다(다른 결정 흐름과 동일 패턴).
  function respond(item: MyOutputPenItem, response: "disputed" | "recognized") {
    // 🧪 목업 중엔 실제 API를 호출하지 않고 로컬 state만 바꾼다.
    if (showingDummy) {
      setReceivedItems((prev) =>
        prev
          ? prev.map((i) => (i.id === item.id ? { ...i, targetResponse: response, targetRespondedAt: Date.now() } : i))
          : prev
      );
      return;
    }
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
  // 🔧 [논리적 삭제, 2026-09-19 사용자 지시] "화각 점검에서도 삭제를 누르면
  // 동일한 처리를(반려와 같은 방식으로 논리적 삭제)" — 서버가 실제 파일을
  // trash로만 옮기고 목록 엔트리는 남기므로(deleted 플래그), 프론트도
  // 목록에서 항목을 제거하지 않고 deleted만 true로 반영해 오버레이가
  // 뜨도록 한다.
  function deleteSelfCheck(item: MyCaptureItem) {
    // 🧪 목업 중엔 실제 삭제 API를 호출하지 않고 로컬 state만 갱신한다.
    if (showingDummy) {
      setSelfCheckItems((prev) => (prev ? prev.map((i) => (i.id === item.id ? { ...i, deleted: true } : i)) : prev));
      return;
    }
    setDeletingId(item.id);
    setError(null);
    call<MyCaptureDeleteResponse>("/my-captures/delete", { method: "POST", body: { id: item.id } })
      .then(() => {
        setSelfCheckItems((prev) => (prev ? prev.map((i) => (i.id === item.id ? { ...i, deleted: true } : i)) : prev));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "삭제에 실패했습니다."))
      .finally(() => setDeletingId(null));
  }

  // 🧪 [목업 미리보기] 토글을 켜는 순간 selfCheckItems/receivedItems
  // state 자체에 스냅샷이 들어가므로(아래 트레일링 버튼), 이 폴백은
  // 클릭 직후 커밋 전까지의 짧은 순간을 대비한 방어일 뿐이다.
  const effectiveSelfCheckItems = showingDummy ? (selfCheckItems ?? DUMMY_SELF_CHECK_ITEMS) : selfCheckItems;
  const effectiveReceivedItems = showingDummy ? (receivedItems ?? DUMMY_RECEIVED_ITEMS) : receivedItems;

  const items: MergedItem[] = [
    ...(effectiveSelfCheckItems || []).map((data): MergedItem => ({ kind: "selfCheck", id: data.id, ts: data.ts, data })),
    ...(effectiveReceivedItems || []).map((data): MergedItem => ({ kind: "outputPen", id: data.id, ts: data.ts, data })),
  ];
  const loaded = effectiveSelfCheckItems !== null && effectiveReceivedItems !== null;

  return (
    <div className="flex flex-col gap-4">
      <Dialog open={pendingDeleteItem !== null} onOpenChange={(open) => !open && setPendingDeleteItem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>기록 삭제</DialogTitle>
            <DialogDescription>이 내 화각 점검 기록을 삭제할까요? 되돌릴 수 없습니다.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Button
              variant="destructive"
              className="w-full sm:h-11 sm:text-base"
              onClick={() => {
                if (pendingDeleteItem) deleteSelfCheck(pendingDeleteItem);
                setPendingDeleteItem(null);
              }}
            >
              삭제
            </Button>
            <Button variant="outline" className="w-full sm:h-11 sm:text-base" onClick={() => setPendingDeleteItem(null)}>
              취소
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {/* 🔧 [사용자 지시] 주차 전환 토글("내 화각 불량 제보"의 사이클
          전환)을 섹션 접힘 상태와 무관하게 항상 보이도록 카드 바깥으로
          뺐다 — 예전엔 CollapsiblePanel 안에 있어 섹션을 접으면 함께
          사라졌다. */}
      <CycleSwitcher
        selectedFileId={cycleFileId}
        onSelect={setCycleFileId}
        memberNumber="self"
        includeUnpaid
        includeForced
      />
      <SectionCard className="shadow-sm shadow-black/[0.03]">
      <Collapsible defaultOpen className="flex flex-col">
        <SectionHeader
          icon={ListChecks}
          title="내 화각 불량 제보"
          loading={loading}
          onRefresh={load}
          refreshProgress={refreshProgress}
          refreshDisabled={!hasNewReceived}
          refreshDisabledReason="새로 접수된 내역이 없습니다"
          trailing={
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className={cn("shrink-0", showingDummy && "border-ok/30 bg-ok/15 text-ok hover:bg-ok/25 dark:hover:bg-ok/25")}
              onClick={() => {
                const next = !showingDummy;
                setShowingDummy(next);
                // 목업을 켤 땐 두 목록에 고정 스냅샷을 넣고, 끌 땐 null로
                // 비워 load(true)가 실제 데이터로 다시 채우게 한다 —
                // ReportReviewList.tsx와 동일한 패턴(CapturePreview가 더미
                // id로 실제 파일을 fetch하려다 실패하는 것을 막기 위함).
                setSelfCheckItems(next ? DUMMY_SELF_CHECK_ITEMS : null);
                setReceivedItems(next ? DUMMY_RECEIVED_ITEMS : null);
                setExpandedDay(null);
                setExpandedId(null);
                setHasNewReceived(false);
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
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {loading && !loaded && <AdminListSkeleton />}

          {/* 🔧 [사용자 지시, 2026-09-19] "'내 화각 불량 제보'가 비어있을 때
              출력되는 화면이 '화각 불량 제보 처리'가 비어있을 때랑 달라" —
              관리자 화면(ReportReviewList)의 빈 상태(AdminEmptyState,
              InfoCard+py-8)와 다른 임시 <p>(py-6, 카드 없음)를 쓰고 있어
              스켈레톤→빈 상태 전환 시 높이 낙차가 관리자 화면과 달랐다.
              7개 관리자 목록이 이미 통일해 쓰는 컴포넌트를 그대로 재사용. */}
          {!loading && loaded && items.length === 0 && (
            <AdminEmptyState>확인할 내 화각 점검·제보가 없습니다.</AdminEmptyState>
          )}

          {loaded && items.length > 0 && (
            <div className="flex flex-col gap-2 sm:gap-2.5">
              {groupByDay(items).map((group) => {
                const isDayExpanded = expandedDay === group.dateKey;
                // "내 화각 점검"(kind: "selfCheck")은 벌점/페널티 판정 대상이
                // 아닌 자가 점검용 기록이라 건수에서 제외한다(사용자 지시).
                // 🔧 [수신/발신 통합, 2026-09-19 사용자 지시] "총 N건" 하나로
                // 뭉쳐 보여주던 것을 "총 수신 : N건"/"총 발신 : N건" 두
                // 뱃지로 나눈다.
                const receivedCount = group.items.filter(
                  (item) => item.kind === "outputPen" && item.data.direction === "received"
                ).length;
                const sentCount = group.items.filter(
                  (item) => item.kind === "outputPen" && item.data.direction === "sent"
                ).length;
                return (
                  <InfoCard key={group.dateKey} className="flex flex-col gap-2.5 bg-card">
                    <button
                      type="button"
                      onClick={() => setExpandedDay(isDayExpanded ? null : group.dateKey)}
                      className="flex items-center justify-between gap-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded"
                    >
                      {/* 🔧 [사용자 지시] "최근 진행된 제보"(ActiveReportsSection,
                          text-sm sm:text-base)와 같은 화면 위계인데 이 날짜
                          그룹 헤더만 한 단계 작은 text-xs sm:text-sm였다 —
                          크기를 맞춰 위계를 키운다(볼드는 기존 semibold 유지). */}
                      <span className="inline-flex shrink-0 items-center gap-1.25 text-sm font-semibold sm:text-base">
                        <CalendarDays className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                        {dateLabel(group.dateKey)}
                      </span>
                      <span className="ml-auto flex items-center gap-1.5">
                        {/* 🔧 [사용자 지시] 이 뱃지는 TintedPill이 아니라 별도로
                            스타일링된 span이라, 다른 뱃지들을 "9월 9일
                            수요일"과 같은 크기로 키운 것과 별개로 여전히
                            작은 채(text-micro-lg sm:text-xs)였다 — 동일하게
                            맞춘다. 🔧 [버그 수정] leading-none(line-height:1)
                            때문에 패딩값이 같아도 배경(pill) 높이가
                            TintedPill(기본 line-height, 28px)보다 6px
                            작게(22px) 나와 "배경색 크기가 다르다"고
                            보였다(사용자 지적) — leading-none을 없애 맞춘다.
                            🔧 [사용자 지시] "뱃지는 아까 키웠잖아? 지금보니까
                            살짝 작은게 나은 것 같다" — TintedPill과 함께
                            한 단계씩 낮춘다(text-xs sm:text-sm). */}
                        {/* 🔧 [수신/발신 통합, 2026-09-19 사용자 지시] "총 N건"
                            하나였던 뱃지를 "총 수신 : N건"/"총 발신 : N건"
                            두 개로 나눈다. 색상은 2차 토글의 수신(blue)/
                            발신(purple) 뱃지와 동일하게 맞춘다(사용자 지시). */}
                        <span className="rounded-full bg-blue-600/15 px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap text-blue-600 sm:text-sm dark:bg-blue-400/15 dark:text-blue-400">
                          총 수신 : {receivedCount}건
                        </span>
                        <span className="rounded-full bg-violet-600/15 px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap text-violet-600 sm:text-sm dark:bg-violet-400/15 dark:text-violet-400">
                          총 발신 : {sentCount}건
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
                          // 🔧 [수신/발신 통합, 2026-09-19] kind: "outputPen"은
                          // "selfCheck가 아니라 GET /my-output-pen에서 온 항목"
                          // 이라는 뜻일 뿐, 수신/발신 여부는 별도로
                          // received.direction을 봐야 한다.
                          const isOutputPenItem = item.kind === "outputPen";
                          const received = isOutputPenItem ? (item.data as MyOutputPenItem) : null;
                          const isSent = received?.direction === "sent";
                          // 버튼 자체는 항상 보여주되(사용자 지시), 이미 관리자가 최종
                          // 처리(적용/유예/반려)했거나 대상자가 이미 응답을 제출한
                          // 건이면 눌러도 무효이므로 비활성화한다. 🔧 [수신/발신 통합]
                          // 발신 건(본인이 제보한 건)은 대상자 전용 액션이라 항상 불가.
                          const canRespond =
                            isOutputPenItem &&
                            !isSent &&
                            received!.reviewStatus === "pending" &&
                            !received!.targetResponse;
                          // 🔧 [뱃지 일치, 2026-09-19 사용자 지시] 관리자 화면
                          // (ReportReviewList)과 동일한 "{대기|확정} | {세부}" 단일
                          // 뱃지로 통일 — 1차 토글(날짜, 위 "총 수신/발신 N건")은
                          // 그대로 두고 2차 토글(이 항목 헤더)만 맞춘다. 이 화면은
                          // 로컬 세션 오버라이드(applied/rejected)가 없고 서버가
                          // 이미 확정한 reviewStatus를 그대로 신뢰하므로 관리자
                          // 화면의 isItemApplied류 헬퍼 대신 reviewStatus로 직접
                          // 판정한다.
                          const isApplied = isOutputPenItem && received!.reviewStatus === "approved";
                          const isDeferred = isOutputPenItem && received!.reviewStatus === "deferred";
                          const isRejected =
                            isOutputPenItem &&
                            (received!.reviewStatus === "rejected" || received!.reviewStatus === "rejected_recognized");
                          const statusPillGroup: "대기" | "확정" = isApplied || isDeferred || isRejected ? "확정" : "대기";
                          // 🔧 [사용자 지시 + 버그 재수정, 2026-09-19] 발신 건은 대상자
                          // 처리 세부(경고/벌점/페널티/유예/반려/이의/인정)를 공유하지
                          // 않는다는 원칙에 따라, "검토 중"인지 제보상점이 실제로
                          // 지급됐는지("상점")만 구분한다 — applyReportMerit
                          // (report-penalty.js 492~549행)은 approved/
                          // rejected_recognized뿐 아니라 deferred(유예)에서도 지급하고,
                          // 지급하지 않는 건 시트에 아무것도 쓰지 않는 순수
                          // "rejected"(561행, 별도 블록) 하나뿐이다.
                          const statusPillDetail = isSent
                            ? statusPillGroup === "확정"
                              ? received!.reviewStatus !== "rejected"
                                ? "상점"
                                : "반려"
                              : "검토"
                            : isApplied
                              ? penaltyCategoryLabel(received!.penalty?.occurrence ?? received!.nextOccurrence)
                              : isDeferred
                                ? "유예"
                                : isRejected
                                  ? "반려"
                                  : // 🔧 [사용자 지시, 2026-09-19] 수신(회원 본인) 화면은
                                    // 관리자 화면과 달리 이의제기/위반인정 여부를 굳이
                                    // 구분해 보여줄 필요가 없다 — "접수"(아직 응답 전)만
                                    // 남기고 나머지는 "검토"로 합친다.
                                    received?.targetResponse
                                      ? "검토"
                                      : "접수";
                          return (
                            // 🔧 [사용자 지시] 상세 펼치기/접기가 조건부 렌더링(즉시 나타남/
                            // 사라짐)이라 "뚝뚝 끊기는" 느낌이 있었다 — 기존에 섹션 전체
                            // 접기(위 Collapsible)에 이미 쓰던 base-ui Collapsible을 항목별로도
                            // 적용해 높이가 부드럽게 펼쳐지도록 한다. open/onOpenChange로
                            // controlled해 기존 expandedId(한 번에 하나만 펼침) 로직은 그대로 둔다.
                            <Collapsible
                              key={item.id}
                              open={isItemExpanded}
                              onOpenChange={(open) => setExpandedId(open ? item.id : null)}
                              className={cn(
                                // 🔧 [버그 수정] 이 카드(개별 제보 항목)만 p-2(8px)로
                                // 상위 두 카드(SectionCard/InfoCard, p-2.5 sm:p-3.5)
                                // 보다 좁아 "오전 1:48:19가 포함된 박스만 여백이 거의
                                // 없다"고 느껴졌다(사용자 지적) — 상위 카드와 동일한
                                // 값으로 맞춘다.
                                "flex flex-col gap-2.5 rounded-lg border bg-card p-2.5 sm:p-3.5",
                                // 아직 응답하지 않은 건은 대상자가 놓치기 쉬우므로(90분
                                // 시한이 지나면 자동으로 위반인정 처리됨) 벌금 미납
                                // 강조와 동일한 글로우 효과로 눈에 띄게 한다(사용자 지시).
                                canRespond && "border-destructive/60 animate-unpaid-glow"
                              )}
                            >
                              {/* 🔧 [사용자 지시, 2026-09-19] "1차 토글(요일 그룹)을 재활용" —
                                  기존엔 이 헤더가 <div>였고 우측의 ghost 아이콘 버튼만
                                  클릭 가능해, 뱃지 사이 빈 공간(가운데)을 눌러도 토글되지
                                  않고 ghost 버튼 특유의 hover 배경만 도드라졌다(사용자
                                  지적). 1차 토글(위 요일 그룹 헤더, 776번째 줄 부근)과
                                  동일하게 헤더 행 전체를 <button>으로 바꿔 어디를 눌러도
                                  토글되고 별도 hover 배경도 생기지 않게 한다. */}
                              <button
                                type="button"
                                onClick={() => setExpandedId(isItemExpanded ? null : item.id)}
                                aria-expanded={isItemExpanded}
                                className="flex flex-wrap items-center justify-between gap-x-1.5 gap-y-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded"
                              >
                                {/* 🔧 [사용자 지시] "뱃지가 줄어들어서 한 줄에 표현도 가능할 것
                                    같은데 잘리거나 넘칠 때만 개행하도록" — 뱃지 크기를
                                    줄인(TintedPill text-sm→text-xs) 뒤로는 대부분 폭에서 한
                                    줄에 들어가므로, 시간(좌측 고정)과 뱃지 그룹(우측 정렬,
                                    사용자 지시: "뱃지는 우측 정렬")을 양끝에 두고, 뱃지
                                    그룹만 flex-wrap으로 둬 공간이 모자랄 때만 다음 줄로
                                    넘어간다(이전엔 뱃지가 3개까지 붙는 유예/확정 건에서
                                    좁은 폭에 잘려 보여 아예 별도 줄로 고정 분리했었으나,
                                    뱃지 자체가 작아진 지금은 잘릴 때만 개행하는 편이
                                    대부분의 경우 더 컴팩트하다).
                                {/* 🔧 [사용자 지시] 이 시간 텍스트가 날짜 그룹 제목
                                    ("9월 9일 수요일", text-sm sm:text-base)과 같은
                                    위계(항목의 "제목" 역할)인데 한 단계 작은
                                    text-xs sm:text-sm였다 — 크기를 맞춘다. */}
                                <span className="inline-flex shrink-0 items-center gap-1.25 text-sm font-semibold sm:text-base">
                                  <Clock className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                  {/* 이미 날짜별로 묶여 있으므로(그룹 헤더에 날짜 표시) 여기서는
                                      시각만 보여준다(사용자 지시: 날짜는 빼고, 아이콘도 시계로). */}
                                  {new Date(item.ts).toLocaleTimeString("ko-KR")}
                                </span>
                                {/* 🔧 [사용자 지시] "좀 더 우측으로 붙여도 될 것 같다" — 뱃지
                                    그룹과 접기 버튼 사이 간격을 줄여 더 가깝게 붙인다. */}
                                <div className="flex min-w-0 flex-wrap items-center justify-end gap-0.5">
                                  <div className="flex flex-wrap items-center justify-end gap-1.5 [&_span]:shrink-0 [&_span]:whitespace-nowrap">
                                    {isOutputPenItem ? (
                                      <>
                                        {/* 🔧 [수신/발신 통합, 2026-09-19 사용자 지시] "확정이나
                                            대기 뱃지 앞에 '수신', '발신' 뱃지를 붙여서 구분" —
                                            별도 뱃지로 앞에 붙인다(대기/확정 뱃지와는 성격이
                                            다른 축의 구분이라 DividedValue로 합치지 않음). */}
                                        <TintedPill tone={isSent ? "purple" : "blue"}>
                                          {isSent ? "발신" : "수신"}
                                        </TintedPill>
                                        {/* 🔧 [뱃지 일치, 2026-09-19 사용자 지시] 관리자 화면
                                            (ReportReviewList)과 동일하게 "{대기|확정} | {세부}"
                                            단일 뱃지로 통일 — 기존에 최대 3개까지 늘어나던
                                            확정/유예 뱃지(조치명·차감시간 포함)를 여기로 합친다.
                                            차수·차감시간 상세는 펼쳤을 때 "학습시간 차감"/
                                            "벌점 · 페널티 변동" SubRow에서 그대로 볼 수 있다.
                                            색상 매핑(statusPillTone)은 관리자 화면과 완전히
                                            동일한 공용 헬퍼를 재사용한다. 🔧 [사용자 지시,
                                            2026-09-19] 발신의 "대기 | 검토"만 회색으로 —
                                            수신도 같은 "검토" 문자열을 쓰지만(이의/인정 통합)
                                            수신 쪽은 기존 amber를 유지해야 해서, statusPillTone
                                            공용 매핑 대신 여기서 발신 여부로 먼저 갈라 처리한다. */}
                                        <TintedPill tone={isSent && statusPillDetail === "검토" ? "muted" : statusPillTone(statusPillDetail)}>
                                          {/* 🔧 [사용자 지시, 2026-09-19] 제보 도메인 뱃지 구분자를
                                              공용 DividedValue(세로선)와 별개로 "·"로 통일. */}
                                          <DottedValue items={[statusPillGroup, statusPillDetail]} />
                                        </TintedPill>
                                      </>
                                    ) : (
                                      <>
                                        {/* 🔧 [사용자 지시] "내 화각 점검"(selfCheck)도 수신/발신과
                                            같은 방향 축의 뱃지가 있어야 통일감이 생긴다 — 수신도
                                            발신도 아닌 항목이라 "기타"로 앞에 붙인다. */}
                                        <TintedPill tone="muted">기타</TintedPill>
                                        <TintedPill tone="ok">화각 점검</TintedPill>
                                      </>
                                    )}
                                  </div>
                                  {/* 🔧 [사용자 지시, 2026-09-19] "1차 토글을 재활용" — 헤더 전체가
                                      이제 버튼이므로(위 변경) 별도의 클릭 가능한 ghost 버튼을
                                      두지 않고, 1차 토글(801~815번째 줄)과 동일하게 장식용
                                      chevron 아이콘만 배치한다. */}
                                  <ChevronDown
                                    className={cn(
                                      "size-3.5 shrink-0 text-muted-foreground transition-transform",
                                      isItemExpanded && "rotate-180"
                                    )}
                                    strokeWidth={ICON_STROKE.default}
                                  />
                                </div>
                              </button>

                              {/* 🔧 [버그 수정] 여기 pt-2.5가 부모 Collapsible의
                                  gap-2.5(헤더-패널 사이 간격)에 더해져 중복 적용돼,
                                  펼쳤을 때 구분선이 "접혔을 때 카드 하단선" 위치보다
                                  더 아래로 밀려나 이어지는 느낌이 끊겼다(사용자 지적:
                                  "구분선이 접혔을 때의 영역 끝 지점이랑 맞춰서
                                  펼쳐지도록"). pt를 없애 gap만으로 간격을 주면
                                  두 지점이 정확히 일치한다. */}
                              <CollapsiblePanel className="flex flex-col">
                                <div className="flex flex-col gap-3 sm:gap-3.5">
                                  <div className="h-px w-full bg-border" />
                                  {/* 🔧 [수신/발신 통합, 2026-09-19 사용자 지시] 발신 건(본인이
                                      제보한 건)은 캡처를 볼 필요가 없어(제보 시 이미 확인한
                                      본인 촬영물) 스크린샷·영상 미리보기를 생략한다. */}
                                  {!isSent && (
                                  <div className="flex flex-col gap-1.5">
                                    <span className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base">
                                      <ImageIcon className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                      스크린샷 · 영상
                                    </span>
                                    <div className="relative">
                                      {showingDummy ? (
                                        // 🧪 목업 항목은 실제 파일이 없어 CapturePreview가 봇 프록시
                                        // (/admin/captures/file)를 502로 실패시킨다(ReportReviewList.tsx
                                        // 와 동일한 이유) — 플레이스홀더로 대체한다.
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
                                      {/* 🔧 [사용자 지시, 2026-09-19] "반려된 건은 스크린샷/영상
                                          영역에 불투명 오버레이를 덮어서 '반려로 삭제처리
                                          되었습니다' 문구를 출력" — 서버는 실제 파일을 지우지
                                          않고 trash 폴더로만 이동하지만(관리자 화면에서는 계속
                                          조회 가능, 사용자 확정), 제보자와 자세한 내역을 공유할
                                          필요는 없다는 같은 원칙에 따라 수신(회원) 화면에서만
                                          가린다. "내 화각 점검"을 본인이 삭제한 경우도 동일한
                                          방식(논리적 삭제)으로 처리해 같은 오버레이를 쓰되
                                          문구만 다르게 한다(사용자 지시).
                                          🔧 [10일 경과 자동 논리적 삭제, 2026-09-19 사용자 지시]
                                          "접수 시점으로부터 10일이 지난 값은 모두 오버레이로
                                          덮어쓰고 논리적 삭제 처리" — 봇의 매일 배치
                                          (mark_expired_captures)가 selfCheck/수신 항목 모두에
                                          deleted+deletedReason:"expired"를 세팅한다. 발신
                                          항목은 애초에 이 스크린샷 섹션 자체가 !isSent 안에서만
                                          렌더링되므로(위) 오버레이도 자연히 표시되지 않는다
                                          (사용자 확정: "발신은 여전히 섹션 생략"). */}
                                      {(() => {
                                        const selfCheckData = !isOutputPenItem ? (item.data as MyCaptureItem) : null;
                                        const isExpired =
                                          (selfCheckData?.deleted && selfCheckData.deletedReason === "expired") ||
                                          (received?.deleted && received.deletedReason === "expired");
                                        const isManualDeleted = !!selfCheckData?.deleted && selfCheckData.deletedReason !== "expired";
                                        if (!isRejected && !isExpired && !isManualDeleted) return null;
                                        const text = isExpired
                                          ? "10일 초과로 삭제처리 되었습니다."
                                          : isRejected
                                            ? "반려로 삭제처리 되었습니다."
                                            : "삭제처리 되었습니다.";
                                        return (
                                          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/90">
                                            <p className="text-xs font-semibold text-muted-foreground sm:text-sm">{text}</p>
                                          </div>
                                        );
                                      })()}
                                    </div>
                                  </div>
                                  )}
                                  {isOutputPenItem && (
                                    <>
                                      {/* 🔧 [수신/발신 통합, 2026-09-19 사용자 지시] 발신 건은
                                          스크린샷·영상 섹션이 생략되어 바로 위(824행)
                                          구분선과 중첩되므로 여기서는 생략한다. */}
                                      {!isSent && <div className="h-px w-full bg-border" />}
                                      <div className="flex flex-col gap-1.5">
                                        <span className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base">
                                          <FileText className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                          제보정보
                                        </span>
                                        {/* 관리자 화면과 동일한 레이아웃이되, 제보자는 숨긴다(사용자 지시). */}
                                        {/* 🔧 [사용자 지시] "2번 사진의 영역을 1번 사진의 위계 크기
                                            처럼 맞추고 싶어" — SubRow 기본 크기(text-micro-lg
                                            sm:text-xs)가 "일간 총 벌금 · 재납 예치금" 아래
                                            항목들(labelClassName/valueClassName로 text-xs
                                            sm:text-sm 오버라이드됨)보다 한 단계 작았다 — 이
                                            섹션의 모든 SubRow에 동일하게 적용해 통일한다. */}
                                        {/* 🔧 [수신/발신 통합, 2026-09-19 사용자 지시: "대상자
                                            이름 보여줌"] 발신 건(본인이 제보한 건)에서만
                                            누구를 제보했는지 보여준다 — 수신 건은 본인
                                            이름이라 이미 아는 정보라 생략. */}
                                        {isSent && (
                                          <SubRow
                                            label="대상자"
                                            value={received!.targetName}
                                            labelClassName="text-xs sm:text-sm"
                                            valueClassName="text-xs sm:text-sm"
                                          />
                                        )}
                                        <SubRow
                                          label="사유"
                                          value={displayReason(received!.reason)}
                                          labelClassName="text-xs sm:text-sm"
                                          valueClassName="text-xs text-destructive sm:text-sm"
                                        />
                                        <SubRow
                                          label="발생일시"
                                          value={formatDateTime24h(item.ts)}
                                          labelClassName="text-xs sm:text-sm"
                                          valueClassName="text-xs sm:text-sm"
                                        />
                                        <SubRow
                                          label="처리현황"
                                          value={
                                            isSent
                                              ? sentStatusLabel(received!)
                                              : statusLabel(received!, received!.penalty?.occurrence ?? null)
                                          }
                                          labelClassName="text-xs sm:text-sm"
                                          valueClassName="text-xs sm:text-sm"
                                        />
                                      </div>

                                      {/* 🔧 [수신/발신 통합, 2026-09-19 사용자 지시] 발신 건은
                                          본인 학습시간이 차감되지 않으므로(대상자 학습시간만
                                          영향받음) 이 섹션을 생략한다. */}
                                      {!isSent && (
                                      <>
                                      <div className="h-px w-full bg-border" />

                                      <div className="flex flex-col gap-1.5">
                                        <span className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base">
                                          <Clock className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                          학습시간 차감
                                        </span>
                                        <SubRow
                                          label="응답일시"
                                          value={
                                            received!.targetRespondedAt
                                              ? formatDateTime24h(received!.targetRespondedAt)
                                              : "응답 대기 중"
                                          }
                                          labelClassName="text-xs sm:text-sm"
                                          valueClassName="text-xs sm:text-sm"
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
                                              labelClassName="text-xs sm:text-sm"
                                              valueClassName={cn("text-xs sm:text-sm", deductedMinutes !== 0 && "text-destructive")}
                                            />
                                          );
                                        })()}
                                      </div>
                                      </>
                                      )}

                                      <div className="h-px w-full bg-border" />

                                      {/* 🔧 [수신/발신 통합, 2026-09-19 사용자 지시] 발신 건은
                                          대상자의 벌점·페널티 세부(차수 등)를 공유할 필요가
                                          없어(제보자와 자세한 처리 내역을 공유하지 않는다는
                                          같은 원칙) 이 섹션 대신 "상점 변동"(제보자 본인에게
                                          지급되는 제보상점)만 보여준다. */}
                                      {isSent ? (
                                        <div className="flex flex-col gap-1.5">
                                          <span className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base">
                                            <Star className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                                            제보 상점 변동
                                          </span>
                                          {(() => {
                                            // 🔧 [백엔드 정책과 일치, 2026-09-19 재확인]
                                            // applyReportMerit(report-penalty.js 492~549행)은
                                            // "적용"(approved)·"반려 (상점인정)"(rejected_recognized)
                                            // 뿐 아니라 "유예"(deferred)에서도 제보자에게 제보상점
                                            // 1칸(0.1점)을 지급한다(492행이 이 셋을 한 블록으로
                                            // 묶어 함께 호출) — 지급되지 않는 건 시트에 아무것도
                                            // 쓰지 않는 순수 "반려"(rejected, 561행 별도 블록)뿐이다.
                                            const isDecided = received!.reviewStatus !== "pending";
                                            const isRecognized = isDecided && received!.reviewStatus !== "rejected";
                                            const meritOccurrence =
                                              received!.merit && !("error" in received!.merit!)
                                                ? received!.merit!.occurrence
                                                : null;
                                            return (
                                              <>
                                                <SubRow
                                                  label={isDecided ? "이번 상점" : "예상 적용"}
                                                  value={isRecognized ? "+0.1점" : "없음"}
                                                  labelClassName="text-xs sm:text-sm"
                                                  valueClassName={cn("text-xs sm:text-sm", isRecognized && "text-ok")}
                                                />
                                                {/* 🔧 [사용자 지시] "이번 적용" 아래에 이 건이 반영된
                                                    시점 기준 누적 제보상점을 함께 보여준다 —
                                                    제보상점은 1차~5차 슬롯(칸당 0.1점)에 순서대로
                                                    쌓이므로, 확정된 merit.occurrence(몇 번째
                                                    슬롯인지)로 누적값을 계산할 수 있다. 미확정이거나
                                                    미인정된 건은 슬롯 자체가 기록되지 않아
                                                    meritOccurrence가 없다. */}
                                                {meritOccurrence !== null && (
                                                  <SubRow
                                                    label="누적 상점"
                                                    value={`총 +${(meritOccurrence * 0.1).toFixed(1)}점`}
                                                    labelClassName="text-xs sm:text-sm"
                                                    valueClassName="text-xs text-ok sm:text-sm"
                                                  />
                                                )}
                                              </>
                                            );
                                          })()}
                                        </div>
                                      ) : (
                                      <div className="flex flex-col gap-1.5">
                                        <span className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base">
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
                                          // 🔧 [버그 수정] 취소선은 "원래 몇 차였을 조치가
                                          // 취소됐다"를 보여주는 용도인데, 잔여 슬롯이 없어
                                          // occurrence 자체가 null이면("적용 불가 (잔여 슬롯
                                          // 없음)")애초에 취소할 조치 자체가 없어 취소선을
                                          // 긋는 게 논리적으로 맞지 않다(사용자 지적). 그 경우
                                          // "유예 N차"/"반려" 덧붙임 없이 순수 occurrenceLabel
                                          // 값만 보여준다.
                                          const decidedOccurrence = received!.deferredOccurrence ?? received!.nextOccurrence;
                                          return (
                                            <SubRow
                                              label={isDecided ? "확정 적용" : "예상 적용"}
                                              value={
                                                received!.deferOccurrence && decidedOccurrence ? (
                                                  <>
                                                    <span className="line-through">{occurrenceLabel(decidedOccurrence)}</span>{" "}
                                                    유예 {received!.deferOccurrence}차
                                                  </>
                                                ) : received!.penalty ? (
                                                  occurrenceLabel(received!.penalty.occurrence)
                                                ) : isRejectedDecided && decidedOccurrence ? (
                                                  <span className="line-through">{occurrenceLabel(decidedOccurrence)}</span>
                                                ) : (
                                                  occurrenceLabel(received!.deferOccurrence || isRejectedDecided ? decidedOccurrence : received!.nextOccurrence)
                                                )
                                              }
                                              labelClassName="text-xs sm:text-sm"
                                              valueClassName="text-xs text-destructive sm:text-sm"
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
                                              labelClassName="text-xs sm:text-sm"
                                              valueClassName={cn("text-xs sm:text-sm", hasImpact && "text-destructive")}
                                            />
                                          );
                                        })()}
                                      </div>
                                      )}
                                    </>
                                  )}

                                  {/* 🔧 [버그 수정, 2026-09-19] "확정된 건에 대해서는
                                      '위반인정'/'이의제기' 버튼을 출력하지 마"라는 지시를
                                      statusPillGroup === "대기"로만 구현했더니, 이미 응답을
                                      제출했지만 관리자가 아직 처리하지 않은 건("대기 | 검토",
                                      canRespond는 false라 disabled였음)에도 버튼이 그대로
                                      떠 있는 문제가 있었다(사용자 지적: "대기 | 검토인데도
                                      버튼이 출력되는 목업이 있다"). 버튼이 실제로 의미
                                      있는 건 "아직 응답을 제출하지 않은 대기 건"뿐이고
                                      canRespond가 정확히 그 조건(isOutputPenItem && !isSent
                                      && pending && 응답 미제출)이므로, 렌더링 여부 자체를
                                      canRespond로 가른다 — disabled 표시 대신 아예
                                      노출하지 않는다. 남은 disabled는 respondingId(응답 전송
                                      중 로딩)만 처리하면 된다. */}
                                  {canRespond && (
                                    <>
                                      <div className="h-px w-full bg-border" />
                                      <div className="grid grid-cols-2 gap-2">
                                        <Button
                                          variant="outline"
                                          className="sm:h-11 sm:text-base"
                                          disabled={respondingId === item.id}
                                          onClick={() => respond(received!, "recognized")}
                                        >
                                          위반인정
                                        </Button>
                                        <Button
                                          variant="destructive"
                                          className="sm:h-11 sm:text-base"
                                          disabled={respondingId === item.id}
                                          onClick={() => respond(received!, "disputed")}
                                        >
                                          이의제기
                                        </Button>
                                      </div>
                                    </>
                                  )}

                                  {/* 🔧 [논리적 삭제, 2026-09-19] 이미 삭제된 건은 재삭제할
                                      필요가 없어(파일이 이미 trash에 있음) 버튼 자체를
                                      숨긴다 — 확정 건에서 위반인정/이의제기 버튼을 숨기는
                                      것과 동일한 원칙. */}
                                  {!isOutputPenItem && !(item.data as MyCaptureItem).deleted && (
                                    <>
                                      <div className="h-px w-full bg-border" />
                                      <Button
                                        variant="outline"
                                        className="text-destructive hover:bg-destructive/10 hover:text-destructive sm:h-11 sm:text-base"
                                        disabled={deletingId === item.id}
                                        onClick={() => setPendingDeleteItem(item.data as MyCaptureItem)}
                                      >
                                        <Trash2 className="size-3.5 shrink-0" strokeWidth={ICON_STROKE.default} />
                                        삭제
                                      </Button>
                                    </>
                                  )}
                                </div>
                              </CollapsiblePanel>
                            </Collapsible>
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
    </div>
  );
}
