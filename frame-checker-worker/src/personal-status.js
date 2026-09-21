// 🔧 [구조 개선 15차, 2026-09-17] 개인 대시보드/랭킹 클러스터
// (buildPersonalStatus/buildRosterStatus와 그 하위 함수들)를 index.js에서
// 옮겼다(docs/TESTING.md 참고). 이 클러스터가 참조하는 상수(ROW_*/COL_*/
// STATUS_DAYS 등)와 parseWon/safeNumber/parseLeaveCount/colIndexToLetter/
// findMemberNumberByEmail/listAllMembers/resolveTargetFileId/
// depositRefundBreakdown/totalPenaltyBreakdown 등은 deposit.js/leave.js/
// exit.js/fines.js/cycle.js/members.js/report.js도 함께 공유하는 범용
// 유틸이라 index.js에 남기고 export만 추가했다(옮기지 않음). 반대로
// buildPersonalStatus는 exit.js가 이미 `from "./index.js"`로 import하고
// 있어, index.js가 이 파일에서 다시 import해 재export하는 3차(deposit.js)
// 와 동일한 패턴을 쓴다.
// 🔧 [구조 개선 19차, 2026-09-17] 랭킹/로스터/정산 클러스터
// (buildRosterStatus/handleRosterStatus/handleAdminPrizeSettle)를
// src/roster-status.js로 다시 옮겼다 — 17차 구조 감사가 놓쳤던
// "이미 분리된 대형 파일 내부"를 재조사해, 이 클러스터가 개인 대시보드
// 계산 헬퍼를 전혀 재사용하지 않는다는 걸 확인하고 분리했다. 이 파일에
// 남은 getMeritRank가 roster-status.js의 buildRosterStatus를 실사용
// import하는 단방향 순환만 있다(역방향 없음, TDZ 위험 없음).
// parseWeekOfToMonday는 이 파일(buildPersonalStatus)도 실사용해 여기
// 남기고 export만 추가했다 — roster-status.js가 실사용 import한다.
import {
  json,
  verifySession,
  getServiceAccountAccessToken,
  findMemberNumberByEmail,
  resolveTargetFileId,
  resolveTargetFileIdForAnyBackup,
  requireAdmin,
  getSheetValues,
  getCurrentPenCycle,
  getSpreadsheetMeta,
  writeSheetValues,
  getSheetIdByName,
  getRowNotes,
  buildSlotHistory,
  depositAgainOccurredDay,
  proxyToBotDashboard,
  OUTPUT_PEN_SHEET_NAME,
  OUTPUT_PEN_SLOT_COLUMNS,
  getLeaveQueueStub,
  listAllMembers,
  depositRefundBreakdown,
  totalPenaltyBreakdown,
  countCurrentCyclePen,
  parseWon,
  safeNumber,
  parseLeaveCount,
  STATUS_DAYS,
  STATUS_DAY_COLS,
  ROW_JOIN_DATE,
  ROW_MORNING_FINE,
  ROW_PAYMENT_CHECK,
  ROW_NORMAL_LEAVE_USE,
  ROW_REASON_LEAVE_USE,
  ROW_NORMAL_LEAVE_LEFT,
  ROW_REASON_LEAVE_LEFT,
  ROW_PARTI_STATUS,
  COL_PARTI_STATUS,
  ROW_DAILY_STUDY_TIME,
  ROW_LOG_STUDY_TIME,
  ROW_BONUS_STUDY_TIME,
  ROW_WEEKLY_STUDY_TIME,
  ROW_RECORD_TIME,
  ROW_TOTAL_FINE,
  ROW_GOAL_FINE,
  ROW_PERIOD_START,
  ROW_PERIOD_END,
  GOAL_TYPE_MINUTES,
  ROW_WEEKLY_MERIT,
  ROW_WEEKLY_TOTAL_FINE,
  ROW_PERIOD_ATTENDANCE_RATE,
  ROW_PENALTY_DISPLAY,
  ROW_REPORT_SHEET_ROW,
  ROW_AUDIT_SHEET_ROW,
  ROW_DEPOSIT_REFUND_ESTIMATE,
  COL_DEPOSIT_REFUND_ESTIMATE,
  ROW_STUDY_TIME_MERIT,
  ROW_REPORT_MERIT,
  COL_PERIOD_RATE_OFFSET,
  DAILY_FINE_CAP,
  EXITED_BACKUP_SHEET_RE,
  EXITED_MEMBER_PREFIX,
} from "./index.js";
import { _cachedCompute, invalidateMemberCache } from "./cache.js";
import { formatISODate, currentWeekMondayKST, formatYYMMDD } from "./date-utils.js";
import { listQueuedReasonLeaveDays } from "./leave.js";
import { buildRosterStatus } from "./roster-status.js";
import { findMemberByNumber } from "./pure-utils.js";

function isConfirmed(recordTimestamp) {
  return (recordTimestamp || "").includes("23:3");
}

function formatMinutes(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// "HH:MM" 문자열(부호 없는 누적 시간값 — 로그 학습시간, 1교시 종료 타이머
// 등)을 분으로 변환한다. 비어 있거나 형식이 안 맞으면 0.
function parseHHMMToMinutes(raw) {
  const m = /^(\d{1,3}):(\d{2})$/.exec((raw || "").trim());
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// 시트 29행(일간 목표시간 벌금) 수식의 반휴 반영 규칙과 동일.
// 월~토: 반휴 미사용 시 기준시간 그대로, 1건 사용 시 절반, 2건 이상이면 그날 목표시간 없음(면제).
// 일요일은 애초에 "반일" 목표제라 규칙이 다르다 — 기준시간 자체가 평일의 절반이고,
// 반휴를 정확히 1건 쓴 경우에만 면제되며(0건·2건은 그대로 절반 목표 유지) 2건 이상 상한이 없다.
function dailyGoalMinutes(goalType, normalLeaveUsed, reasonLeaveUsed, isSunday) {
  const prefix = (goalType || "").slice(0, 2);
  const baseMinutes = GOAL_TYPE_MINUTES[prefix] || 0;
  if (!baseMinutes) return null;
  const leaveCount = normalLeaveUsed + reasonLeaveUsed;

  if (isSunday) {
    if (leaveCount === 1) return 0;
    return baseMinutes / 2;
  }

  if (leaveCount >= 2) return 0;
  return leaveCount === 1 ? baseMinutes / 2 : baseMinutes;
}

// 1~14교시(시작/종료/참여율) 셀이 하나라도 비어 있으면 그날 집계가 아직 끝나지 않은 것 —
// 시트 수식(28행 일간 총 벌금)도 COUNTBLANK로 동일하게 체크한다.
function isDayComplete(rows, startCol) {
  for (let r = ROW_PERIOD_START; r <= ROW_PERIOD_END; r++) {
    const row = rows[r] || [];
    for (let c = startCol; c < startCol + 3; c++) {
      if (!row[c]) return false;
    }
  }
  return true;
}

// 시트 수식(C37 제보상점 합산 조건 COUNTBLANK(C6:Q19)=0)과 동일하게,
// 월~금(주중 5일, STATUS_DAY_COLS의 앞 5개) 1~14교시가 전부 채워졌는지 확인한다.
// 토/일은 이 범위에 포함되지 않는다 — 주중 기록이 끝나야만 그 주 제보상점이 반영된다.
function isWeekdayComplete(rows) {
  return STATUS_DAY_COLS.slice(0, 5).every((col) => isDayComplete(rows, col));
}

// 시트 수식(C35 상점 계산 마지막 배율)과 동일한 규칙.
// 사유반휴 2회 이상 사용 시: 교시제면 1.025, 아니면 1(달성제라도 배율 없음).
// 그 외에는 목표시간 타입별 고정 배율.
// 🔧 [15차] handleGetGoalSchedule/handleSetGoalSchedule(목표시간 예약,
// index.js 잔류)의 GOAL_TIME_VALID_VALUES가 이 객체의 키 목록을 그대로
// 쓰므로 export한다 — index.js가 다시 import해 재export한다(3차
// deposit.js와 동일한 패턴).
export const GOAL_TYPE_MULTIPLIER = {
  "8H (달성제)": 1,
  "9H (달성제)": 1.05,
  "10H (달성제)": 1.1,
  "8H (교시제)": 1.025,
  "9H (교시제)": 1.075,
  "10H (교시제)": 1.125,
};

function meritMultiplier(goalType, reasonLeaveTotal) {
  if (reasonLeaveTotal >= 2) return goalType.includes("교시제") ? 1.025 : 1;
  return GOAL_TYPE_MULTIPLIER[goalType] ?? 1;
}

// 월요일(1교시~14교시) 칸이 전부 비어 있으면 "그 주 월요일부터 참여하지 않은
// 중도 참여자"로 간주한다. isDayComplete와 반대로 "완전히 비어 있는가"를 본다.
function isDayEmpty(rows, startCol) {
  for (let r = ROW_PERIOD_START; r <= ROW_PERIOD_END; r++) {
    const row = rows[r] || [];
    for (let c = startCol; c < startCol + 3; c++) {
      if (row[c]) return false;
    }
  }
  return true;
}

// SUM(C21:W21) — 이번 주 사유반휴 사용 합계(요일별 열 합산).
function weeklyReasonLeaveTotal(rows) {
  const reasonLeaveUseRow = rows[ROW_REASON_LEAVE_USE] || [];
  return STATUS_DAY_COLS.reduce((sum, col) => sum + parseLeaveCount(reasonLeaveUseRow[col]), 0);
}

// 집계 시트 F열(순위)이 "-"가 되는 조건들(시트 수식 C35, 상점=0 조건과 동일)을
// 전부 판정해 각각의 해당 여부를 반환한다 — 모달에서 "제외 원인" 카드가 조건
// 전체를 보여주고 해당하는 것만 강조해야 하기 때문에, 첫 매칭에서 멈추지 않는다.
// 제보 누적 조건은 레거시라 판정에서 제외했다 — 곧 시트 수식에서도 정리될 예정.
function meritZeroConditions(rows, daysSinceJoin, currentCyclePenCount) {
  const weeklyFine = safeNumber((rows[ROW_WEEKLY_TOTAL_FINE] && rows[ROW_WEEKLY_TOTAL_FINE][2]) || 0);
  // 월요일 칸이 비어 있어도 가입한 지 오래된 회원(이번 주 이전부터 참여 중)이면
  // "중도 참여자"가 아니라 단순 기록 누락일 뿐이다 — 이번 주에 실제로 새로
  // 들어온 사람(가입 7일 미만)일 때만 중도 참여자로 판정한다.
  const isRecentJoin = daysSinceJoin >= 0 && daysSinceJoin < 7;

  return [
    { key: "midJoin", label: "월요일 이후 중도 참여", met: isRecentJoin && isDayEmpty(rows, STATUS_DAY_COLS[0]) },
    { key: "penalty", label: "페널티 1회 이상 적립", met: currentCyclePenCount >= 1 },
    { key: "fine", label: "벌금 5,000원 초과", met: weeklyFine >= 5000 },
    { key: "reasonLeave", label: "사유 반휴 3장 이상 사용", met: weeklyReasonLeaveTotal(rows) >= 3 },
  ];
}

// 요일별(월~일) 1~14교시 원본 기록을 그대로 그리드로 재구성한다.
// 각 교시는 시작/종료 시각과 참여율(%, 숫자) 또는 "ERR" 또는 빈 문자열(미기록)을 담는다.
function buildPeriodGrid(rows) {
  return STATUS_DAYS.map((day, i) => {
    const startCol = STATUS_DAY_COLS[i];
    const periods = [];
    for (let r = ROW_PERIOD_START; r <= ROW_PERIOD_END; r++) {
      const row = rows[r] || [];
      const start = row[startCol] || "";
      const end = row[startCol + 1] || "";
      const rateRaw = row[startCol + COL_PERIOD_RATE_OFFSET];
      const rate = rateRaw === undefined || rateRaw === null ? "" : String(rateRaw);
      periods.push({ start, end, rate });
    }
    return { day, periods };
  });
}

// 시트 수식(C43, 교시 참여율)과 동일하게 계산한다.
// 참여율 = (85% 이상 달성 교시 수 + 오류(ERR) 교시 수) / 목표 교시 수 × 100.
// 목표 교시 수는 목표시간(분)에서 사유반휴로 면제된 시간을 뺀 뒤 60분 단위로 환산한다.
function periodAttendanceBreakdown(rows, goalType) {
  const isPeriodType = /^(8H|9H|10H) \(교시제\)$/.test(goalType || "");
  if (!isPeriodType) {
    return { applicable: false, achievedCount: 0, errorCount: 0, targetPeriods: 0, rate: null };
  }

  let achievedCount = 0;
  let errorCount = 0;
  for (let r = ROW_PERIOD_START; r <= ROW_PERIOD_END; r++) {
    const row = rows[r] || [];
    for (const startCol of STATUS_DAY_COLS) {
      const raw = row[startCol + COL_PERIOD_RATE_OFFSET];
      if (raw === "ERR") errorCount += 1;
      else if (safeNumber(raw) >= 85) achievedCount += 1;
    }
  }

  const targetMinutes = weeklyGoalMinutes(rows, goalType);
  const targetPeriods = targetMinutes / 60;

  const rate = targetPeriods > 0 ? ((achievedCount + errorCount) / targetPeriods) * 100 : null;

  return { applicable: true, achievedCount, errorCount, targetPeriods, rate };
}

// 🔧 2026-09: 원본 시트 M28 수식은 "월요일 칸이 하나라도 비어 있으면 0"
// 이었으나, 화/수요일 등 다른 요일엔 이미 실제 참여 기록이 있는데도 월요일
// 결석만으로 그 주 목표(및 교시 참여율의 목표 교시 수)가 통째로 0/미표시
// 처리돼 화면에 왜곡된 값이 떴다(사용자 지적) — 서비스에서는 시트 수식을
// 그대로 재현하지 않고, "그 주 7일이 전부 비어 있을 때"(=완전한 중도
// 미참여)만 0으로 보고, 하루라도 기록이 있으면 정상적으로 5일치 목표를
// 계산한다.
function weeklyGoalMinutes(rows, goalType) {
  if (STATUS_DAY_COLS.every((col) => isDayEmpty(rows, col))) return 0;
  const prefix = goalType.slice(0, 2);
  const baseMinutes = GOAL_TYPE_MINUTES[prefix] || 0;
  const reasonLeaveTotal = weeklyReasonLeaveTotal(rows);
  return Math.max(0, baseMinutes * 5 - reasonLeaveTotal * (baseMinutes / 2));
}

// M28 값을 그대로 "HH:MM" 문자열로 표시한다.
function weeklyGoalTime(rows, goalType) {
  const minutes = weeklyGoalMinutes(rows, goalType);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function explainDay(total, goal, morning, confirmed) {
  const combined = goal + morning;
  if (!confirmed) {
    if (combined === 0) return "진행 전/기록 없음";
    return `마감 전(미확정) — 현재까지 목표시간 벌금 ₩${goal.toLocaleString()} + 오전 벌금 ₩${morning.toLocaleString()} 예상 중`;
  }
  if (total === 0) {
    if (combined === 0) return "벌금 없음 (목표 달성)";
    return `확정되었으나 총 벌금 ₩0 (목표 ₩${goal.toLocaleString()} / 오전 ₩${morning.toLocaleString()} — 규칙상 최종 미부과)`;
  }
  if (total >= DAILY_FINE_CAP && combined > DAILY_FINE_CAP) {
    return `상한 적용 — 목표 벌금 ₩${goal.toLocaleString()} + 오전 벌금 ₩${morning.toLocaleString()} = ₩${combined.toLocaleString()}이지만 하루 상한 ₩${DAILY_FINE_CAP.toLocaleString()}으로 조정되어 ₩${total.toLocaleString()} 확정`;
  }
  if (total === combined) {
    return `목표 벌금 ₩${goal.toLocaleString()} + 오전 벌금 ₩${morning.toLocaleString()} 그대로 합산되어 ₩${total.toLocaleString()} 확정`;
  }
  if (total === goal && morning === 0) {
    return `목표시간 벌금 ₩${goal.toLocaleString()}만 부과되어 ₩${total.toLocaleString()} 확정`;
  }
  return `목표 ₩${goal.toLocaleString()} / 오전 ₩${morning.toLocaleString()} 조합으로 ₩${total.toLocaleString()} 확정`;
}

// 🔧 [429 방지] "Penalty" 탭처럼 여러 컴포넌트가 한 페이지에서 동시에 마운트돼
// 각자 listAllMembers()를 부르는 상황이 잦아, 캐시(인메모리+KV)로 중복 호출을
// 흡수한다. 신규등록/퇴실/재납/이동 등 명단을 바꾸는 쓰기 뒤에는
// invalidateMemberCache()로 반드시 무효화하므로, TTL은 "무효화가 놓친 경우의
// 안전망"일 뿐이다.
//
// 🔧 [과거 fileId 분기 되돌림, 2026-09-10] 한때 과거 fileId만 2시간으로
// 늘렸었다(§17) — 하지만 listAllMembers는 이 함수 하나만 쓰는 게 아니라
// 제보 이름→회원번호 매칭(snapshotNextOccurrence 등)·퇴실 후보 판정
// (listExitCandidates) 등 20곳 이상이 공유하는 원본이라, "드롭다운만
// 2시간으로 하고 싶다"는 의도와 달리 정확성이 중요한 다른 호출부의
// 안전망까지 함께 늘어나는 부작용이 있었다(사용자 확인 후 원복). "내
// 대시보드" 드롭다운의 2시간 요구사항은 이 함수와 완전히 분리된 별도
// 바깥 캐시(handleAdminMembers의 adminMemberList:{fileId}, §17.1)로
// 충족했었다 — 이때는 members:를 다시 현재/과거 구분 없이 항상 10분으로
// 되돌렸다.
//
// 🔧 [TTL 재상향 + 승인 경로 방어, 2026-09-11] 위 되돌림의 핵심 우려는
// "제보 승인(applyOutputPenalty)/제보상점 지급(applyReportMerit)이 낡은
// 명단으로 닉네임→번호를 잘못 확정해, 번호가 재사용된 경우 엉뚱한
// 회원에게 벌점이 적힐 수 있다"는 것이었다 — 이건 실제로 심각한 위험이라
// TTL을 길게 잡는 것만으로는 해결이 안 됐다. 지금은 그 두 함수 호출
// 직전에 좁은 그룹(memberIdentity: members+dataSheetRows)만 무효화해,
// "명단이 실제로 바뀐 적이 있든 없든 승인 순간엔 무조건 방금 확인한
// 최신값을 쓴다"고 강제한다(하루 승인 건수가 10건 미만이라 이 무효화가
// 추가하는 KV 쓰기·삭제는 무시할 수준 — 사용자 확인). 이 방어가 생겼으니
// 나머지(대시보드 드롭다운 포함 20여 곳 전부)는 다시 10분에 묶어둘 이유가
// 없어져, members:도 dataSheetRows:/adminMemberList:와 같은 선상에서
// 2시간으로 늘린다 — adminMemberList:(§17.1)의 존재 이유(드롭다운 전용
// 별도 캐시)도 이제 옅어졌지만, 이미 분리돼 있고 건드릴 필요가 없어 그대로
// 둔다.
// 🔧 [캐싱 통합, 2026-09] "데이터" 시트 원본(A1:V50)을 listAllMembers 외에도
// handleAdminMembersRoster(상세 패널의 구루미 계정/준비 중인 시험), handleAdminOpenSlots
// (빈 번호 조회), handleAdminCreateMember(번호 중복 검증)가 각자 캐시 없이
// 직접 읽고 있었다 — listAllMembers는 이 원본에서 "이메일이 있는 유효 회원"만
// 걸러 쓰고 나머지 열/행은 버려, 그 버려진 부분이 필요한 화면들은 캐시를
// 재사용하지 못했다. 원본 로우 자체를 별도 키로 캐싱해 listAllMembers를
// 포함한 4곳이 모두 재사용하게 한다. members:와 TTL·무효화 그룹을 반드시
// 함께 맞춘다(MEMBER_CACHE_PREFIXES/MEMBER_CACHE_UNCONDITIONAL_KEYS/
// MEMBER_CACHE_GROUPS.roster 세 곳 모두에 dataSheetRows: 등록 필요).
// 🔧 [사용자 지시, 2026-09-11] members:가 2시간으로 늘 때(§1729 주석)
// "함께 맞춘다"고 명시해놓고 정작 TTL 자체는 10분에 남아있던 누락을
// 발견해 바로잡는다 — members:가 이 원본에서 파생되는데 재료(dataSheetRows)만
// 10분마다 낡은 것으로 취급되면 가공값(members)의 2시간 TTL도 사실상
// 무의미해진다. 소비처 3곳(listAllMembers/handleAdminMembersRoster/
// handleAdminOpenSlots) 모두 이메일·이름·시험종류처럼 저빈도로만 바뀌는
// 열만 읽고 벌점/상점 등 F~V열은 안 읽어(각 핸들러 주석 참고), 2시간
// 묵어도 안전하다고 재검증했다. 무효화 그룹(roster/memberIdentity/
// newMember)은 이미 members:와 완전히 동일하게 dataSheetRows:도 포함하고
// 있어 무효화 타이밍은 그대로 정확하다 — TTL만 안전망으로 따라간다.
// 집계 시트 B4:G18에서 회원번호에 해당하는 행의 상점(F열)/순위(G열)를 읽는다.
// 순위는 집계 시트가 이미 전체 15명을 비교해 계산해두므로, 개인 대시보드가
// 직접 15개 탭을 다시 조회할 필요 없이 이 값만 찾으면 된다.
// 🔧 [중복 캐시 통합, 2026-09-10] 원래 이 함수는 집계!B4:F18을 별도의
// meritRank:{fileId} 키로 캐싱했는데, 이 범위는 RANK 탭이 이미 캐싱해둔
// rosterStatus:{fileId}(집계!A4:L18, buildRosterStatus)의 완전한 부분집합
// 이다 — 같은 파일의 같은 상점/순위 데이터를 두 개의 캐시 키로 중복
// 저장·중복 조회하고 있었다(사용자 지적: "MY랑 RANK 둘이 같이 가져오는
// 걸로 해도 되지 않나?"). buildRosterStatus를 그대로 재사용한다 — 무효화
// 그룹(둘 다 roster 그룹에만 즉시 반응, penalty 그룹에선 의도적으로 제외)이
// 이미 동일해 합쳐도 정합성 차이가 없다. buildRosterStatus가 "빈 시트"
// 행을 걸러내지만 여기는 항상 실존하는 본인 조회라 그 필터링과 무관하다.
async function getMeritRank(env, accessToken, fileId, memberNumber) {
  const { members } = await buildRosterStatus(env, accessToken, fileId);
  const member = findMemberByNumber(members, memberNumber);
  if (!member) return { merit: "0", rank: "-" };
  return { merit: member.merit || "0", rank: member.rank || "-" };
}

// 🔧 [데이터 시트 통합] 옛 "제보상점" D~L(요일별 점수/K=총점/L=벌점) 구조가
// 사라지고, "데이터" 시트 R~V(제보상점 1~5차 슬롯, 값=발생 시점의 페널티
// 사이클 번호)로 바뀌었다. 개인 탭 C37 수식과 동일하게, 현재 사이클(집계!D25)과
// 일치하는 슬롯 개수 × 0.1이 총점이다. "벌점" 개념은 이제 존재하지 않는다
// (별도 페널티 판정은 송출P/주간P 슬롯이 담당).
async function _computeReportScore(env, accessToken, fileId, reportRow) {
  if (!reportRow) return { total: 0 };
  const [slotRows, currentCycle] = await Promise.all([
    getSheetValues(env, accessToken, fileId, `데이터!R${reportRow}:V${reportRow}`),
    getCurrentPenCycle(env, accessToken, fileId),
  ]);
  const slotRow = (slotRows && slotRows[0]) || [];
  const count = slotRow.filter((v) => parseInt(v, 10) === currentCycle).length;
  return { total: Math.round(count * 0.1 * 10) / 10 };
}

// "데이터" 탭 F~M열(송출P 1~6차 + 주간P 1~2차)에서 특정 회원(번호+3행)의 슬롯
// 값과, 4차(I)/6차(K) 슬롯에 값이 있을 때만 그 칸의 주석(발생 시점 · 사유)을
// 함께 읽는다. note 조회는 별도 API 호출이라 값이 없는 대부분의 경우엔
// 건너뛰어 비용을 아낀다. timePenValues(L/M)는 appscript.js daily_calc()의
// 판정 결과가 그대로 기록되는 슬롯이라 여기서는 그대로 읽기만 한다.
async function _computeOutputPenSlots(env, accessToken, fileId, memberNumber) {
  const row = parseInt(memberNumber, 10) + 3;
  const rows = await getSheetValues(env, accessToken, fileId, `'${OUTPUT_PEN_SHEET_NAME}'!F${row}:M${row}`);
  const slotRow = (rows && rows[0]) || [];
  const values = OUTPUT_PEN_SLOT_COLUMNS.map((_, i) => parseInt(slotRow[i], 10) || 0);
  const timePenValues = [parseInt(slotRow[6], 10) || 0, parseInt(slotRow[7], 10) || 0]; // L(1차), M(2차)

  // 🔧 [총 페널티 모달 매칭] "예치금 재납 대상자"가 쓰는 buildSlotHistory와
  // 동일한 이력(N차 라벨·발생일시·사유·캡처ID)을 개인 대시보드의 "총 페널티"
  // 모달에서도 그대로 보여주기 위해, F~K뿐 아니라 L~M(주간 P) 주석까지 함께
  // 읽는다. 채워진 슬롯이 하나도 없으면 굳이 시트를 한 번 더 조회하지 않는다.
  let outputPenHistory = [];
  let timePenHistory = [];
  const hasAnySlot = values.some((v) => v > 0) || timePenValues.some((v) => v > 0);
  if (hasAnySlot) {
    const sheetId = await getSheetIdByName(env, accessToken, fileId, OUTPUT_PEN_SHEET_NAME);
    if (sheetId !== null) {
      const rowNotes = await getRowNotes(env, accessToken, fileId, sheetId, row - 1, "F", "M");
      outputPenHistory = buildSlotHistory(values, rowNotes.slice(0, 6), "송출 P");
      timePenHistory = buildSlotHistory(timePenValues, rowNotes.slice(6, 8), "주간 P");
    }
  }

  return { values, timePenValues, outputPenHistory, timePenHistory };
}

// 오전 목표시간 벌금 수식: MAX(0, 3-HOUR(D10))*500 — D10은 1교시 종료
// 누적시간(HH:MM). 목표는 시(hour) 단위지만 UI에는 분 단위 미달치까지
// 정확히 보여줘야 해서 180분 기준으로 직접 계산한다(사용자 확인).
const MORNING_GOAL_MINUTES = 180;

// buildPersonalStatus가 넘겨주는 "이 조회가 보여주는 주의 월요일" 기준으로,
// 요일 인덱스(0=월 ... 6=일)에 해당하는 실제 캘린더 날짜를 계산한다.
// weekMonday가 없으면(계산 실패 등 방어) null.
function dayDateAt(weekMonday, dayIndex) {
  if (!weekMonday) return null;
  const d = new Date(weekMonday.getTime());
  d.setDate(d.getDate() + dayIndex);
  return formatISODate(d);
}

// 백업 파일명에서 온 weekOf("YYMMDD", 그 주의 월요일)를 Date로 파싱한다.
export function parseWeekOfToMonday(weekOf) {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(weekOf || "");
  if (!m) return null;
  return new Date(Date.UTC(2000 + parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
}

// RosterPage(대시보드 "랭킹"/"상금 정산")의 타이틀에 "YYMMDD-YYMMDD 주간"을
// 병기하기 위해, 이 조회가 어느 주(월~일)를 보여주는지 시작/종료일을
// 계산한다. weekOf가 없으면(실시간 조회) 이번 주 월요일을 기준으로 삼는다.
export function currentWeekRangeYYMMDD(weekOf) {
  const monday = weekOf ? parseWeekOfToMonday(weekOf) : currentWeekMondayKST();
  if (!monday) return null;
  const sunday = new Date(monday.getTime());
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  return { weekStart: formatYYMMDD(monday), weekEnd: formatYYMMDD(sunday) };
}

function buildStatusDays(rows, goalType, periodGrid, depositAgainDay, pendingReasonLeaveDays, weekMonday) {
  const dailyStudyRow = rows[ROW_DAILY_STUDY_TIME] || [];
  const logStudyRow = rows[ROW_LOG_STUDY_TIME] || [];
  const bonusStudyRow = rows[ROW_BONUS_STUDY_TIME] || [];
  const recordRow = rows[ROW_RECORD_TIME] || [];
  const totalRow = rows[ROW_TOTAL_FINE] || [];
  const goalRow = rows[ROW_GOAL_FINE] || [];
  const morningRow = rows[ROW_MORNING_FINE] || [];
  const paymentRow = rows[ROW_PAYMENT_CHECK] || [];
  const normalLeaveUseRow = rows[ROW_NORMAL_LEAVE_USE] || [];
  const reasonLeaveUseRow = rows[ROW_REASON_LEAVE_USE] || [];

  let weekTotalConfirmed = 0;
  const days = STATUS_DAYS.map((day, i) => {
    const col = STATUS_DAY_COLS[i];
    const complete = isDayComplete(rows, col);
    const confirmed = isConfirmed(recordRow[col]);
    const total = complete ? parseWon(totalRow[col]) : 0;
    const goal = complete ? parseWon(goalRow[col]) : 0;
    const morning = complete ? parseWon(morningRow[col]) : 0;
    const studyTime = dailyStudyRow[col] || "";
    const logStudyTime = logStudyRow[col] || "";
    const bonusStudyTime = bonusStudyRow[col] || "";
    const paymentStatus = paymentRow[col] || "";
    const normalLeaveUsed = parseLeaveCount(normalLeaveUseRow[col]);
    const reasonLeaveUsed = parseLeaveCount(reasonLeaveUseRow[col]);
    const goalMinutes = dailyGoalMinutes(goalType, normalLeaveUsed, reasonLeaveUsed, day === "일");
    const dailyGoalTime = goalMinutes === null ? "" : formatMinutes(goalMinutes);

    // 🔧 [벌금 미달치 표시] 시트 30행(일간 목표시간 벌금) 수식과 동일하게
    // CEILING(목표분 - 로그학습분, 30) 30분 단위로 올림한다. goal(벌금 원화)이
    // 0이면(목표 달성/면제) 미달치도 0으로 표시하지 않는다.
    const dailyShortfallMinutes =
      goal > 0 && goalMinutes
        ? Math.max(0, Math.ceil((goalMinutes - parseHHMMToMinutes(logStudyTime)) / 30) * 30)
        : 0;
    // 오전은 시트가 시(hour) 단위로만 벌금을 매기지만, 미달치 자체는 실제
    // 1교시 종료 누적시간(periods[0].end)과 180분의 차이를 분 단위 그대로 쓴다.
    const morningPeriodEnd = (periodGrid[i] && periodGrid[i].periods[0] && periodGrid[i].periods[0].end) || "";
    const morningShortfallMinutes =
      morning > 0 ? Math.max(0, MORNING_GOAL_MINUTES - parseHHMMToMinutes(morningPeriodEnd)) : 0;

    if (confirmed) weekTotalConfirmed += total;
    return {
      day,
      // 🔧 [가입일 이전 요일 비활성화용] 이 요일의 실제 캘린더 날짜
      // ("YYYY-MM-DD") — 프론트가 가입일과 비교해 "가입 전이라 아예
      // 참여할 수 없었던 요일"만 선택 불가로 표시하는 데 쓴다.
      date: dayDateAt(weekMonday, i),
      confirmed,
      complete,
      total,
      goal,
      morning,
      studyTime,
      logStudyTime,
      bonusStudyTime,
      dailyGoalTime,
      dailyShortfallTime: dailyShortfallMinutes > 0 ? formatMinutes(dailyShortfallMinutes) : "",
      morningShortfallTime: morningShortfallMinutes > 0 ? formatMinutes(morningShortfallMinutes) : "",
      // 예치금 재납 2회 달성 시점의 요일과 이 요일이 같을 때만 true — 프론트가
      // 이 요일의 카드에만 "재납 예치금" 하위 항목을 노출한다(사용자 지적:
      // 원래는 요일 스냅샷이 아니라 매 요일 카드에 동일하게 찍히던 버그).
      isDepositAgainDay: day === depositAgainDay,
      paymentStatus,
      normalLeaveUsed,
      reasonLeaveUsed,
      // 관리자 승인 대기 중인 사유반휴 신청이 이 요일에 있는지 — 승인 전까지는
      // reasonLeaveUsed(시트 값)에 반영되지 않으므로, 프론트가 "N장 (관리자 확인
      // 중)"으로 별도 표시하는 데 쓴다.
      reasonLeavePending: pendingReasonLeaveDays.includes(day),
      explain: explainDay(total, goal, morning, confirmed),
    };
  });

  return { days, weekTotalConfirmed };
}

// 예치금 재납 시 performDepositAgainReset이 리셋 직전 백업해 두는
// "{이름} (재납 {timestamp})" 탭 하나를 가볍게 파싱한다. buildPersonalStatus와
// 달리 순위/제보점수/사이클 페널티처럼 다른 시트(집계·데이터)를 참조해야 하는
// 값은 스냅샷 시점 그대로 복원할 수 없어 포함하지 않는다 — 이미 계산이 끝나
// 셀에 텍스트로 박혀 있는 요약값만 그대로 읽는다.
function buildDepositAgainSnapshot(rows) {
  if (!rows || rows.length <= ROW_MORNING_FINE) return null;

  const goalType = (rows[2] && rows[2][14]) || "";
  const periodGrid = buildPeriodGrid(rows);
  // 백업 탭은 리셋 직전 스냅샷이라 이 시점엔 이미 재납이 확정된 뒤이므로,
  // 재납 발생일 요일 강조(isDepositAgainDay)는 의미가 없어 항상 null로 둔다.
  const { days, weekTotalConfirmed } = buildStatusDays(rows, goalType, periodGrid, null, []);

  const weeklyMerit = (rows[ROW_WEEKLY_MERIT] && rows[ROW_WEEKLY_MERIT][2]) || "0";
  const weeklyTotalFineAmount = safeNumber((rows[ROW_WEEKLY_TOTAL_FINE] && rows[ROW_WEEKLY_TOTAL_FINE][2]) || 0);
  const weeklyStudyTimeStr = (rows[ROW_WEEKLY_STUDY_TIME] && rows[ROW_WEEKLY_STUDY_TIME][2]) || "00:00";

  // 🔧 [재납 전 스냅샷 왜곡 방지] weeklyGoalTime()/periodAttendanceBreakdown()은
  // "이번 주가 항상 5일(월~금) 전체 진행 중"이라는 실시간 조회 전제로 짜여
  // 있어, 완결 요일 수가 5일보다 적을 수 있는 백업 탭 스냅샷에 그대로 쓰면
  // 목표 대비 미달률/참여율이 실제보다 훨씬 나쁘게 계산된다(재납이 주
  // 초반일수록 왜곡이 커짐) — 그래서 이 두 값은 아예 계산하지 않고, 프론트가
  // "목표 비교 없이 실적치만" 보여주도록 goalTime은 항상 0(00:00), 참여율은
  // 항상 "-"(집계 불가)로 둔다.
  return {
    goalType,
    joinDate: (rows[ROW_JOIN_DATE] && rows[ROW_JOIN_DATE][8]) || "",
    weeklyMerit,
    weeklyGoalTime: "00:00",
    weeklyStudyTime: weeklyStudyTimeStr,
    weeklyTotalFine: `₩${weeklyTotalFineAmount.toLocaleString()}`,
    periodAttendanceRate: "-",
    periodAttendanceBreakdown: { applicable: false, achievedCount: 0, errorCount: 0, targetPeriods: 0, rate: null },
    periodGrid,
    days,
    weekTotalConfirmed,
  };
}

// 개인 탭 원본 조회는 buildPersonalStatus 안에서 가장 무거운 단일 호출이자
// 회원마다 유일한(=배치로 묶을 수 없는) 요청이라, 15명이 짧은 시간에 각자
// /status를 열면 그대로 15회가 쌓인다. 짧게(3초) 캐싱해 같은 회원이 연속
// 클릭하거나 여러 화면(설정/대시보드)이 거의 동시에 조회하는 중복만
// 제거한다 — 본인이 값을 바꾸면 writeSheetValues가 이 캐시를 즉시
// 무효화하므로 "방금 쓴 값이 안 보이는" 문제는 생기지 않는다.
// 🔧 [캐싱 통합, 2026-09] 개인 탭 원본(personalStatus)·송출P 슬롯
// (outputPenSlots)·제보상점(reportScore)은 buildPersonalStatus 한 곳에서만
// 항상 함께 쓰이는데도(다른 화면이 셋 중 하나만 독립적으로 부르는 경우가
// 없음) 각자 다른 KV 키로 따로 캐싱되고 있었다 — 대시보드 폴링(30분)마다
// 회원 1명당 KV put이 3번씩 발생해, 15명 기준 이 셋이 전체 KV 쓰기의
// 대부분을 차지했다(문서화된 실측 없이 직접 계산: 평균 사용 시나리오
// 기준 하루 약 500회 절감 추정). 셋을 personalStatusBundle: 하나의 캐시
// 키로 묶는다 — reportRow(제보상점 조회에 필요한 행 번호)가 개인 탭 42행
// (C42) 값이라 원래도 personalStatus를 먼저 읽어야만 알 수 있는 순차
// 의존 관계였으므로, 병렬로 쪼개져 있던 걸 오히려 자연스럽게 합칠 수
// 있었다. 셋 중 하나라도 무효화되면 셋 다 같이 재계산되지만(전보다
// 무효화 세밀도가 낮아짐), 그 대가로 생기는 추가 API 호출은 이미 30분
// 폴링 주기 안에서 일어나는 일이라 무시할 수준이다(사용자 확인 후 진행).
async function getPersonalStatusBundle(env, accessToken, fileId, memberNumber) {
  // 🔧 [30분→10분 하향, 2026-09] 개인 탭 값은 본인이 이 Worker의 API로
  // 직접 쓰는 경우(반휴 신청, 관리자 처리 등)는 writeSheetValues가 즉시
  // 무효화하므로 문제없지만, 도움봇 study_sw/bot/sheets.py의 set_sheet()가
  // 각 교시 시작/종료마다(timetable.csv 기준 최소 10분 간격) gspread로
  // 개인 탭에 직접 batch_update하는 경로는 이 Worker 캐시를 전혀 거치지
  // 않아 무효화되지 않는다 — 옛 "교시 60분 단위"라는 전제는 실제 쓰기
  // 간격(교시 종료→다음 교시 시작 10분)보다 길어 회원이 교시 종료 직후
  // 자기 참여율을 확인하려 할 때 최대 30분 낡은 값을 볼 수 있었다
  // (docs/CACHING_POLICY.md §7). 봇의 실제 쓰기 리듬에 맞춰 10분으로
  // 낮춘다 — 회원 수(15)에 비례하는 캐시라 KV 예산은 여전히 고려 대상.
  //
  // 🔧 [과거 fileId TTL 상향, 2026-09-10] 도움봇의 무효화 안 되는 직접 쓰기
  // 경로는 항상 "지금 진행 중인" 이번 주 시트(env.GOOGLE_SHEET_FILE_ID)에만
  // 있다 — 과거 백업 파일에는 도움봇도 절대 쓰지 않으므로, 10분을 짧게
  // 유지해야 할 이유가 과거 fileId에는 없다. 과거 fileId 조회는 이
  // Worker의 API(handleAdminFineStatus 등)를 통해서만 바뀔 수 있고, 그
  // 경로는 writeSheetValues → invalidatePersonalStatusCache가 그 fileId를
  // 그대로 받아 정확히 무효화하므로, TTL을 2시간으로 늘려도 "관리자가
  // 방금 처리한 값이 안 보이는" 문제는 생기지 않는다(사용자 확인). 같은
  // 근거(과거 fileId는 절대 안 바뀜)가 outputPenSlots/reportScore에도
  // 그대로 적용되므로 셋을 같은 TTL 분기로 묶어도 안전하다.
  const ttlMs = fileId === env.GOOGLE_SHEET_FILE_ID ? 10 * 60_000 : 2 * 60 * 60_000;
  return _cachedCompute(env, `personalStatusBundle:${fileId}:${memberNumber}`, ttlMs, async () => {
    const rows = await getSheetValues(env, accessToken, fileId, `${memberNumber}!A1:U${ROW_REPORT_SHEET_ROW + 1}`);
    const reportSheetRow = safeNumber((rows[ROW_REPORT_SHEET_ROW] && rows[ROW_REPORT_SHEET_ROW][2]) || 0);
    const [outputPenSlots, reportScore] = await Promise.all([
      _computeOutputPenSlots(env, accessToken, fileId, memberNumber),
      _computeReportScore(env, accessToken, fileId, reportSheetRow),
    ]);
    return { rows, outputPenSlots, reportScore };
  });
}

// weekOf: 이 조회가 어느 주(백업 파일명 기준 "YYMMDD" 월요일)를 보여주는지 —
// 실시간(라이브 시트) 조회면 null이며, 이 경우 오늘(KST) 기준 이번 주로
// 계산한다. 요일별 실제 캘린더 날짜(days[i].date)를 만드는 데 쓰인다.
export async function buildPersonalStatus(env, accessToken, fileId, memberNumber, memberName, weekOf) {
  const bundle = await getPersonalStatusBundle(env, accessToken, fileId, memberNumber);
  const { rows, outputPenSlots, reportScore } = bundle;
  if (!rows || rows.length <= ROW_MORNING_FINE) {
    throw new Error("개인 탭 데이터를 찾을 수 없습니다.");
  }

  const goalType = (rows[2] && rows[2][14]) || "";
  const joinDate = (rows[ROW_JOIN_DATE] && rows[ROW_JOIN_DATE][8]) || "";
  // 🔧 [가입일 이전 요일 비활성화용] I2(가입일자 원본, "YYYY-MM-DD")를 직접
  // 읽는다 — 위 joinDate(I3)는 "D+238"처럼 매일 바뀌는 상대값이라 특정
  // 요일의 날짜와 직접 비교할 수 없다. I2는 0-indexed row=1, col=8(I열).
  const joinDateExact = (rows[1] && rows[1][8]) || "";
  const weekMonday = weekOf ? parseWeekOfToMonday(weekOf) : currentWeekMondayKST();
  const weeklyMerit = (rows[ROW_WEEKLY_MERIT] && rows[ROW_WEEKLY_MERIT][2]) || "0";
  const normalLeaveLeft = (rows[ROW_NORMAL_LEAVE_LEFT] && rows[ROW_NORMAL_LEAVE_LEFT][2]) || "0";
  const reasonLeaveLeft = (rows[ROW_REASON_LEAVE_LEFT] && rows[ROW_REASON_LEAVE_LEFT][2]) || "0";
  const weeklyTotalFineAmount = safeNumber((rows[ROW_WEEKLY_TOTAL_FINE] && rows[ROW_WEEKLY_TOTAL_FINE][2]) || 0);
  const weeklyTotalFine = `₩${weeklyTotalFineAmount.toLocaleString()}`;
  const weeklyGoalTimeStr = weeklyGoalTime(rows, goalType);
  const weeklyStudyTimeStr =
    (rows[ROW_WEEKLY_STUDY_TIME] && rows[ROW_WEEKLY_STUDY_TIME][2]) || "00:00";
  const periodAttendanceRateRaw =
    (rows[ROW_PERIOD_ATTENDANCE_RATE] && rows[ROW_PERIOD_ATTENDANCE_RATE][2]) ?? "-";
  const periodAttendanceRate =
    periodAttendanceRateRaw === "-" || periodAttendanceRateRaw === ""
      ? "-"
      : `${Math.round(safeNumber(periodAttendanceRateRaw))}%`;
  const periodAttendanceBreakdownResult = periodAttendanceBreakdown(rows, goalType);
  const periodGrid = buildPeriodGrid(rows);
  const depositRefundEstimate =
    (rows[ROW_DEPOSIT_REFUND_ESTIMATE] && rows[ROW_DEPOSIT_REFUND_ESTIMATE][COL_DEPOSIT_REFUND_ESTIMATE]) ||
    "-";

  const { total: reportTotal } = reportScore;
  const [{ rank: rawRank }, currentCycle, exitRequestEntry] = await Promise.all([
    getMeritRank(env, accessToken, fileId, memberNumber),
    getCurrentPenCycle(env, accessToken, fileId),
    // 🔧 [고지지연 반영] depositRefundBreakdown이 amount 계산에 실제 퇴실
    // 신청일을 반영해야 하므로, 원래 이 아래(구 1758행)에서 뒤늦게 조회하던
    // 것을 이 병렬 조회로 앞당긴다.
    // 🔧 [KV → DO 이전, 2026-09-12] §47 — LeaveQueue DO에서 조회.
    getLeaveQueueStub(env)
      .fetch(`https://do/exit/get?memberNumber=${encodeURIComponent(memberNumber)}`)
      .then((r) => r.json())
      .then((d) => d.entry)
      .catch(() => null),
  ]);
  const penCounts = countCurrentCyclePen(outputPenSlots, currentCycle);
  const weeklyOutputPen = penCounts.outputPen;
  const weeklyTimePen = penCounts.timePen;
  const exitRequestDate = exitRequestEntry?.exitDate || null;
  const exitAgreedAt = exitRequestEntry?.agreedAt || null;
  const depositRefundBreakdownResult = depositRefundBreakdown(rows, penCounts, exitRequestDate);
  // 🔧 [정산 퇴실 절차 명확화] "마지막 참여일 익일에 정산 내역과 동의
  // 버튼 출력. 단, 미납 벌금이 있거나 상금 정산이 처리되지 않았으면
  // 보여주지 않음"(사용자 지시) — 상금은 그 주(월~일) 1~5등에게
  // 분배되므로, 마지막 참여일이 일요일(주 마지막 날)이 아니면 그 시점에
  // 상금 지급 대상 여부 자체가 아직 확정되지 않아 상금 조건은 애초에
  // 적용할 수 없다(사용자 지적) — 벌금 미납 여부만으로 판단한다.
  // 일요일인 경우에만 "이 회원이 순위권(1~5등)인데 아직 지급 안 됨"을
  // 함께 확인한다. 집계!P6은 회원별이 아니라 그 주 전체에 하나뿐인
  // "상금 정산 집행" 마킹(handleAdminPrizeSettle/roster-status.js 참고)
  // 이라, 순위와 조합해야만 "이 회원"의 미지급 여부가 나온다.
  let prizePending = false;
  if (exitRequestDate && new Date(exitRequestDate).getDay() === 0) {
    const rankNum = Number(rawRank);
    if (rankNum >= 1 && rankNum <= 5) {
      const prizeSettleRows = await getSheetValues(env, accessToken, fileId, "집계!P6").catch(() => []);
      const settlementSettled = ((prizeSettleRows[0] && prizeSettleRows[0][0]) || "").toString().trim() === "완료";
      prizePending = !settlementSettled;
    }
  }
  const zeroConditions = meritZeroConditions(rows, depositRefundBreakdownResult.daysSinceJoin, penCounts.total);
  const zeroReason = (zeroConditions.find((c) => c.met) || {}).label || null;
  const weeklyMeritRank = rawRank === "-" ? `- (${zeroReason || "미집계"})` : rawRank;
  const totalPenaltyBreakdownResult = totalPenaltyBreakdown(outputPenSlots);

  const partiStatus = (rows[ROW_PARTI_STATUS] && rows[ROW_PARTI_STATUS][COL_PARTI_STATUS]) || "";
  const isLeader = partiStatus === "스터디장" || partiStatus === "부스터디장";
  const studyTimeMerit = safeNumber((rows[ROW_STUDY_TIME_MERIT] && rows[ROW_STUDY_TIME_MERIT][2]) || 0);
  const reportMeritRaw = safeNumber((rows[ROW_REPORT_MERIT] && rows[ROW_REPORT_MERIT][2]) || 0);
  // 시트 수식: 제보상점(C37)은 그 주 월~금(주중) 1~14교시가 전부 채워져야만 합산에 포함된다.
  const weekdayComplete = isWeekdayComplete(rows);
  const reportMerit = isLeader ? 0.5 : reportMeritRaw;
  const includedReportMerit = weekdayComplete ? reportMerit : 0;
  const baseMerit = studyTimeMerit + includedReportMerit;

  const reasonLeaveTotal = weeklyReasonLeaveTotal(rows);
  const multiplier = meritMultiplier(goalType, reasonLeaveTotal);
  // 사유 반휴 2장 이상이면 배율이 강등된다(교시제→1.025, 달성제→1) —
  // 원래 goalType 그대로의 배율과 다르면 모달에 강등 사실을 보여줘야 한다.
  const baseMultiplier = GOAL_TYPE_MULTIPLIER[goalType] ?? 1;
  const multiplierDowngraded = reasonLeaveTotal >= 2 && multiplier !== baseMultiplier;

  // 🔧 [데이터 시트 통합] 개인 탭 C35 수식의 차감 항은 "제보상점 벌점"이
  // 아니라 송출P 2차(G)/3차(H)/5차(J) 중 현재 사이클과 일치하는 슬롯
  // 개수다(OUTPUT_PEN_SLOT_COLUMNS = ["F","G","H","I","J","K"] → idx 1,2,4).
  const minorOutputPenCount = [1, 2, 4].filter((idx) => outputPenSlots.values[idx] === currentCycle).length;

  // 부동소수점 오차(0.1025*1000 → 102.49999999999999 등) 방지를 위해 4자리로 반올림한다.
  const fineDeduction = Math.round((weeklyTotalFineAmount / 500) * 0.1 * 10000) / 10000;
  const penaltyDeduction = Math.round(minorOutputPenCount * 0.1 * 10000) / 10000;

  const computedMerit = Math.max(
    0,
    Math.round((baseMerit * multiplier - penaltyDeduction - fineDeduction) * 10000) / 10000
  );

  // 학습시간 상점 = 로그학습시간(분)/60*0.1 이므로 역산하면 누적 학습시간(시간)이 나온다.
  const studyTimeHours = Math.round((studyTimeMerit / 0.1) * 100) / 100;
  // 제보상점 K열(총점) 0.1당 인정 1건.
  const reportApprovedCount = isLeader ? null : Math.round((reportTotal / 0.1) * 100) / 100;

  const weeklyMeritBreakdown = {
    isZero: rawRank === "-",
    zeroReason,
    zeroConditions,
    studyTimeMerit,
    studyTimeHours,
    reportMerit,
    reportApprovedCount,
    isLeader,
    reportMeritIncluded: weekdayComplete,
    multiplier,
    multiplierDowngraded,
    reasonLeaveTotal,
    penaltyDeduction,
    fineDeduction,
    weeklyTotalFineAmount,
    computedMerit,
  };

  const depositAgainDay = depositAgainOccurredDay(outputPenSlots.outputPenHistory, outputPenSlots.timePenHistory);

  // 🔧 [대기 중 사유반휴 표시] 봇이 꺼져있어도 전체 대시보드가 죽지 않도록
  // try/catch로 감싸고, 실패하면 빈 배열(=대기 정보 없음)로 조용히 넘어간다.
  // 짧은 타임아웃(2초)을 써서 봇이 꺼져 있어도 대시보드 로딩이 8초씩 늘어지지
  // 않게 한다 — 이 정보는 있으면 좋은 부가 정보이지 필수 정보가 아니다.
  let pendingReasonLeaveDays = [];
  try {
    const [leaveProofData, queuedDays] = await Promise.all([
      proxyToBotDashboard(
        env,
        "/leave-proof?status=pending&number=" + encodeURIComponent(memberNumber),
        { timeoutMs: 2000 }
      ),
      listQueuedReasonLeaveDays(env, memberNumber),
    ]);
    const botDays = ((leaveProofData && leaveProofData.items) || []).map((item) => item.day);
    pendingReasonLeaveDays = [...new Set([...botDays, ...queuedDays])];
  } catch {
    pendingReasonLeaveDays = [];
  }

  const { days, weekTotalConfirmed } = buildStatusDays(
    rows,
    goalType,
    periodGrid,
    depositAgainDay,
    pendingReasonLeaveDays,
    weekMonday
  );

  const depositAgainSplit = await buildDepositAgainSplit(env, accessToken, fileId, memberName, days, weekMonday);
  // exitRequestEntry/exitRequestDate는 위(depositRefundBreakdown 호출 이전)에서
  // 이미 조회해둔 값을 그대로 재사용한다.

  return {
    name: memberName,
    goalType,
    joinDate,
    joinDateExact,
    weeklyMerit,
    weeklyMeritRank,
    weeklyMeritBreakdown,
    normalLeaveLeft,
    reasonLeaveLeft,
    days,
    weekTotalConfirmed,
    depositRefundEstimate,
    depositRefundBreakdown: depositRefundBreakdownResult,
    exitRequested: exitRequestEntry !== null,
    exitRequestDate,
    exitAgreedAt,
    prizePending,
    periodAttendanceRate,
    periodAttendanceBreakdown: periodAttendanceBreakdownResult,
    periodGrid,
    weeklyGoalTime: weeklyGoalTimeStr,
    weeklyStudyTime: weeklyStudyTimeStr,
    weeklyTotalFine,
    weeklyOutputPen,
    weeklyTimePen,
    totalPenaltyBreakdown: totalPenaltyBreakdownResult,
    depositAgainSplit,
  };
}

// 🔧 2026-09: 퇴실자 백업 탭("{이름} (퇴실)")을 buildPersonalStatus와 동일한
// StatusResponse 형태로 읽어 관리자 "다른 회원 보기"에서 조회할 수 있게
// 한다. buildPersonalStatus를 그대로 재사용하지 않는 이유 — 그 함수는
// "지금 살아있는 회원"을 전제로 순위(getMeritRank)/제보점수(getReportScore)/
// 페널티 슬롯(getOutputPenSlots)/현재 사이클(getCurrentPenCycle)/퇴실신청
// KV를 전부 실시간 재조회하는데, 퇴실자는 회원번호 자체가 없어(백업 탭
// 이름이 시트명) 이 조회들이 애초에 성립하지 않거나, 그 번호가 재사용된
// 새 회원의 값을 잘못 가져올 수 있다. 대신 백업 탭의 요일별 셀 값(A1:U
// 범위 — copyTo로 원본을 그대로 복사했으므로 개인 탭과 레이아웃이 동일)만
// buildStatusDays 등 순수 함수로 그대로 재현하고, "다시 실시간 계산할 수
// 없는" 순위/제보점수/페널티 슬롯 이력은 조회 불가를 뜻하는 값으로 채운다.
async function buildExitedMemberSnapshot(env, accessToken, fileId, backupSheetName) {
  const rows = await getSheetValues(
    env,
    accessToken,
    fileId,
    `'${backupSheetName}'!A1:U${ROW_REPORT_SHEET_ROW + 1}`
  ).catch(() => null);
  if (!rows || rows.length <= ROW_MORNING_FINE) return null;

  const displayName = EXITED_BACKUP_SHEET_RE.exec(backupSheetName)?.[1] || backupSheetName;
  const goalType = (rows[2] && rows[2][14]) || "";
  const joinDate = (rows[ROW_JOIN_DATE] && rows[ROW_JOIN_DATE][8]) || "";
  const joinDateExact = (rows[1] && rows[1][8]) || "";
  // 퇴실 시점 스냅샷이라 "이번 주"라는 개념이 없다 — 백업 탭이 만들어진 그
  // 순간이 기준이라, 요일별 날짜(days[i].date)는 계산하지 않고 buildStatusDays
  // 가 받는 weekMonday만 오늘 기준으로 채운다(요일 순서/라벨 표시에만 쓰이고
  // "가입 전 요일 비활성화" 판정에는 이미 joinDateExact가 과거 값이라 항상
  // 통과한다).
  const weekMonday = currentWeekMondayKST();
  const weeklyMerit = (rows[ROW_WEEKLY_MERIT] && rows[ROW_WEEKLY_MERIT][2]) || "0";
  const normalLeaveLeft = (rows[ROW_NORMAL_LEAVE_LEFT] && rows[ROW_NORMAL_LEAVE_LEFT][2]) || "0";
  const reasonLeaveLeft = (rows[ROW_REASON_LEAVE_LEFT] && rows[ROW_REASON_LEAVE_LEFT][2]) || "0";
  const weeklyTotalFineAmount = safeNumber((rows[ROW_WEEKLY_TOTAL_FINE] && rows[ROW_WEEKLY_TOTAL_FINE][2]) || 0);
  const weeklyTotalFine = `₩${weeklyTotalFineAmount.toLocaleString()}`;
  const weeklyGoalTimeStr = weeklyGoalTime(rows, goalType);
  const weeklyStudyTimeStr = (rows[ROW_WEEKLY_STUDY_TIME] && rows[ROW_WEEKLY_STUDY_TIME][2]) || "00:00";
  const periodAttendanceRateRaw = (rows[ROW_PERIOD_ATTENDANCE_RATE] && rows[ROW_PERIOD_ATTENDANCE_RATE][2]) ?? "-";
  const periodAttendanceRate =
    periodAttendanceRateRaw === "-" || periodAttendanceRateRaw === ""
      ? "-"
      : `${Math.round(safeNumber(periodAttendanceRateRaw))}%`;
  const periodAttendanceBreakdownResult = periodAttendanceBreakdown(rows, goalType);
  const periodGrid = buildPeriodGrid(rows);
  const depositRefundEstimate =
    (rows[ROW_DEPOSIT_REFUND_ESTIMATE] && rows[ROW_DEPOSIT_REFUND_ESTIMATE][COL_DEPOSIT_REFUND_ESTIMATE]) || "-";

  // 조회 불가 — 이미 퇴실 확정되어 재계산할 "현재 사이클"이 없다. 총
  // 페널티/제보상점 모달은 "적립 이력 조회 불가"로 빈 채 표시된다.
  const outputPenSlots = { values: [0, 0, 0, 0, 0, 0], timePenHistory: [], outputPenHistory: [] };
  const penCounts = { outputPen: 0, timePen: 0, total: 0 };
  const depositRefundBreakdownResult = depositRefundBreakdown(rows, penCounts, null);
  const zeroConditions = meritZeroConditions(rows, depositRefundBreakdownResult.daysSinceJoin, penCounts.total);
  const zeroReason = (zeroConditions.find((c) => c.met) || {}).label || null;
  // 순위는 이미 퇴실해 집계 시트에서 빠진 회원이라 애초에 없다 — 조회
  // 시도 자체가 의미 없으므로 곧바로 "조회 불가" 라벨을 붙인다.
  const weeklyMeritRank = "- (퇴실자, 조회 불가)";
  const totalPenaltyBreakdownResult = totalPenaltyBreakdown(outputPenSlots);

  const partiStatus = (rows[ROW_PARTI_STATUS] && rows[ROW_PARTI_STATUS][COL_PARTI_STATUS]) || "";
  const isLeader = partiStatus === "스터디장" || partiStatus === "부스터디장";
  const studyTimeMerit = safeNumber((rows[ROW_STUDY_TIME_MERIT] && rows[ROW_STUDY_TIME_MERIT][2]) || 0);
  const weekdayComplete = isWeekdayComplete(rows);
  const reasonLeaveTotal = weeklyReasonLeaveTotal(rows);
  const multiplier = meritMultiplier(goalType, reasonLeaveTotal);
  const baseMultiplier = GOAL_TYPE_MULTIPLIER[goalType] ?? 1;
  const multiplierDowngraded = reasonLeaveTotal >= 2 && multiplier !== baseMultiplier;
  const studyTimeHours = Math.round((studyTimeMerit / 0.1) * 100) / 100;

  const weeklyMeritBreakdown = {
    isZero: true,
    zeroReason,
    zeroConditions,
    studyTimeMerit,
    studyTimeHours,
    // 제보상점은 "데이터" 시트 슬롯 재조회가 필요해 조회 불가 — 0으로 둔다.
    reportMerit: 0,
    reportApprovedCount: isLeader ? null : 0,
    isLeader,
    reportMeritIncluded: weekdayComplete,
    multiplier,
    multiplierDowngraded,
    reasonLeaveTotal,
    penaltyDeduction: 0,
    fineDeduction: 0,
    weeklyTotalFineAmount,
    computedMerit: safeNumber(weeklyMerit),
  };

  const { days, weekTotalConfirmed } = buildStatusDays(rows, goalType, periodGrid, null, [], weekMonday);

  return {
    name: displayName,
    goalType,
    joinDate,
    joinDateExact,
    weeklyMerit,
    weeklyMeritRank,
    weeklyMeritBreakdown,
    normalLeaveLeft,
    reasonLeaveLeft,
    days,
    weekTotalConfirmed,
    depositRefundEstimate,
    depositRefundBreakdown: depositRefundBreakdownResult,
    exitRequested: false,
    exitRequestDate: null,
    exitAgreedAt: null,
    periodAttendanceRate,
    periodAttendanceBreakdown: periodAttendanceBreakdownResult,
    periodGrid,
    weeklyGoalTime: weeklyGoalTimeStr,
    weeklyStudyTime: weeklyStudyTimeStr,
    weeklyTotalFine,
    weeklyOutputPen: 0,
    weeklyTimePen: 0,
    totalPenaltyBreakdown: totalPenaltyBreakdownResult,
    depositAgainSplit: null,
  };
}

// 이번 주 안에 performDepositAgainReset이 실행된 적이 있는지 "{이름} (재납
// {timestamp})" 탭으로 감지한다. 같은 회원이 여러 번 재납됐을 수 있으니
// timestamp가 가장 큰(=가장 최근) 탭 하나만 "재납 전" 스냅샷으로 쓴다 —
// 그 이전 재납은 이미 그보다 더 이전 스냅샷에 흡수되어 있다고 본다.
// 리셋 후 요일이 하루도 지나지 않았다면(재납일이 이번 주의 마지막 완결
// 요일) 분리해서 보여줄 의미가 없으므로 null을 반환한다.
async function buildDepositAgainSplit(env, accessToken, fileId, memberName, currentDays, weekMonday) {
  const prefix = `${memberName} (재납 `;
  const sheets = await getSpreadsheetMeta(env, accessToken, fileId);
  const candidates = sheets
    .map((s) => s.title)
    .filter((title) => title.startsWith(prefix) && title.endsWith(")"))
    .sort();
  const backupName = candidates[candidates.length - 1];
  if (!backupName) return null;

  const backupRows = await getSheetValues(env, accessToken, fileId, `'${backupName}'!A1:U${ROW_REPORT_SHEET_ROW + 1}`);
  const before = buildDepositAgainSnapshot(backupRows);
  if (!before) return null;

  // 🔧 [재납 당일 활동 유실 수정] 원래는 백업 탭에 "complete"(1~14교시 전부
  // 채워짐)인 마지막 요일을 경계로 삼았다 — 그런데 재납 확정 처리는 항상
  // 그 판정 근거가 된 날(예: 화요일 일간 집계로 재납 대상 확정)의 다음날
  // 이후에나 실제로 일어난다(사용자 지적). 그래서 확정 처리 당일(예: 수요일)
  // 오전 활동은 그날이 아직 미완결이라 "재납 전"에도 못 들어가고, 초기화된
  // "재납 후" 탭에도 없어 화면 어디에도 안 보이는 문제가 있었다. 백업 시트
  // 이름에 남는 실제 확정 시각(Date.now())을 직접 읽어, "확정일 전날까지"를
  // 경계로 정확히 잡는다 — 확정 당일부터는 완결 여부와 무관하게 "재납 후"로
  // 보존된다.
  const backupTsMatch = /\(재납 (\d+)\)$/.exec(backupName);
  const backupTsMs = backupTsMatch ? parseInt(backupTsMatch[1], 10) : NaN;
  let boundaryIndex = -1;
  if (weekMonday && Number.isFinite(backupTsMs)) {
    const resetDateStr = formatISODate(new Date(backupTsMs + 9 * 60 * 60 * 1000));
    const resetDayIndex = Math.round((new Date(resetDateStr).getTime() - weekMonday.getTime()) / 86_400_000);
    // 확정일이 이번 주(월~일, 0~6) 범위 안일 때만 이 방식을 쓴다 — 범위
    // 밖(예: 백업이 지난 주에 만들어졌거나 시계 오차)이면 아래 폴백으로 넘어간다.
    if (resetDayIndex >= 0 && resetDayIndex <= 6) {
      boundaryIndex = resetDayIndex - 1;
    }
  }
  if (boundaryIndex === -1 && !(weekMonday && Number.isFinite(backupTsMs))) {
    // 폴백: weekMonday를 못 받았거나 백업 이름에서 시각을 못 읽은 경우,
    // 기존처럼 "실제로 기록이 남은 마지막 완결 요일"을 경계로 삼는다.
    before.days.forEach((d, i) => {
      if (d.complete) boundaryIndex = i;
    });
  }
  if (boundaryIndex === -1) return null;

  const boundaryDay = STATUS_DAYS[boundaryIndex];

  // 요일별 카드는 "재납 전" 구간(경계 요일 포함)은 백업 탭 값을, 그 뒤는
  // 현재 탭 값을 그대로 쓴다 — 이미 각자 정확한 값을 담고 있으니 덮어쓰기만
  // 하면 된다.
  const mergedDays = currentDays.map((d, i) => (i <= boundaryIndex ? before.days[i] : d));
  const { days: _beforeDays, ...beforeSummary } = before;

  return { boundaryDay, before: beforeSummary, days: mergedDays };
}

export async function handleStatus(req, env, origin, url) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    // 🔧 [사용자 지시] "관리자 본인의 화면에서도 뜨도록" — AdminCycleRangeSelect
    // (사이클 범위 선택 드롭다운)를 관리자가 자기 자신의 대시보드를 볼 때도
    // 쓸 수 있어야 한다. 이 핸들러는 관리자든 아니든 누구나 호출하는 공용
    // 엔드포인트라, isAdmin이 아니면 cycleAny를 조용히 무시하고 기존 cycle
    // 처리로 폴백한다(handleRosterStatus와 동일 패턴).
    const isAdmin = (session.email || "").toLowerCase() === (env.ADMIN_EMAIL || "").toLowerCase();
    const cycleAnyFileId = isAdmin && url ? url.searchParams.get("cycleAny") : null;
    // cycle 쿼리 파라미터(백업 fileId)가 있으면 "현재 사이클에 속한 과거
    // 주차" 데이터를, 없으면 실시간(현재 활성 시트) 데이터를 대상으로 한다.
    const cycleFileId = url ? url.searchParams.get("cycle") : null;
    const { fileId: targetFileId, weekOf } = cycleAnyFileId
      ? await resolveTargetFileIdForAnyBackup(env, accessToken, cycleAnyFileId)
      : await resolveTargetFileId(env, accessToken, cycleFileId);

    // 세션에 회원번호가 이미 있고 실시간 조회면(대상 파일이 현재 활성
    // 시트와 같으면) 권한관리 탭 재조회를 생략한다 — 과거 백업 파일은
    // 회원 구성이 다를 수 있어 매번 다시 찾아야 한다.
    let memberNumber = session.memberNumber;
    let memberName = session.memberName;
    if (!memberNumber || targetFileId !== env.GOOGLE_SHEET_FILE_ID) {
      const member = await findMemberNumberByEmail(env, accessToken, targetFileId, session.email);
      if (!member) {
        return json({ error: "데이터 시트 명단에서 계정을 찾을 수 없습니다." }, 403, origin);
      }
      memberNumber = member.number;
      memberName = member.name;
    }

    const status = await buildPersonalStatus(env, accessToken, targetFileId, memberNumber, memberName, weekOf);
    return json(status, 200, origin);
  } catch (err) {
    return json({ error: "상태 조회 실패: " + err.message }, 500, origin);
  }
}

export async function handleAdminMemberStatus(req, env, origin, memberNumber, url) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);

    // 🔧 2026-09: 퇴실자 백업 탭("{이름} (퇴실)")은 buildPersonalStatus가
    // 전제하는 "살아있는 회원"이 아니다 — 순위/제보점수/페널티 사이클/
    // "데이터" 시트 슬롯 모두 실시간 참조인데, 퇴실 시 그 회원번호 행은
    // 이미 초기화되었거나(재사용 전) 새 회원의 값으로 덮여있다(재사용 후).
    // 그대로 재사용하면 엉뚱한 값이 나오므로, 백업 탭 셀 값만 그대로
    // 읽는 별도 읽기 전용 경로(buildExitedMemberSnapshot)로 분기한다.
    if (memberNumber.startsWith(EXITED_MEMBER_PREFIX)) {
      const backupSheetName = memberNumber.slice(EXITED_MEMBER_PREFIX.length);
      const status = await buildExitedMemberSnapshot(env, accessToken, env.GOOGLE_SHEET_FILE_ID, backupSheetName);
      if (!status) return json({ error: "퇴실자 기록을 찾을 수 없습니다." }, 404, origin);
      return json(status, 200, origin);
    }

    // 🔧 [사용자 지시] "1주차 → 2주차 → 3주차로 딱 3주 단위로 끊어서
    // 확인" — 관리자 전용 "사이클 범위 선택" 드롭다운(AdminCycleRangeSelect)
    // 이 넘기는 cycleAny는 현재 사이클(최대 3주) 제약이 없는 전체 이력
    // 열람용이다. 이 핸들러는 위에서 이미 requireAdmin으로 보호되어
    // 있으므로 별도 권한 재확인이 필요 없다. cycle(기존 CycleSwitcher)과
    // 동시에 오면 cycleAny를 우선한다 — 프론트가 두 쿼리를 상호 배타적으로
    // 관리하므로 실무상 동시에 오지 않는다.
    const cycleAnyFileId = url ? url.searchParams.get("cycleAny") : null;
    const cycleFileId = url ? url.searchParams.get("cycle") : null;
    const { fileId: targetFileId, weekOf } = cycleAnyFileId
      ? await resolveTargetFileIdForAnyBackup(env, accessToken, cycleAnyFileId)
      : await resolveTargetFileId(env, accessToken, cycleFileId);
    const members = await listAllMembers(env, accessToken, targetFileId);
    const member = findMemberByNumber(members, memberNumber);
    if (!member) return json({ error: "존재하지 않는 회원번호입니다." }, 404, origin);

    const status = await buildPersonalStatus(env, accessToken, targetFileId, member.number, member.name, weekOf);
    return json(status, 200, origin);
  } catch (err) {
    return json({ error: "회원 상태 조회 실패: " + err.message }, 500, origin);
  }
}

