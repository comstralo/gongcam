// TODO(dev-preview): 3주 사이클 전반(현재 + 과거 2주) 점검용 더미 데이터 인터셉터.
// apiFetch가 /cycles, /status(+cycle), /roster-status(+cycle) 요청을 워커로 보내는
// 대신 이 파일의 더미 응답으로 대신한다. 점검이 끝나면 client.ts의 호출부와 이
// 파일을 통째로 제거할 것.
//
// 설계 원칙: 요일별 "원본 사실"(로그 학습시간, 목표유형, 반휴 사용, 납부여부)만
// 손으로 정하고, 나머지 전부(목표시간, 벌금, 주간 합계, 참여율, 상점 등)는
// frame-checker-worker/src/index.js의 실제 계산 규칙을 그대로 재현한 아래 함수들로
// "파생"시킨다 — 필드마다 서로 무관한 숫자를 따로 채워 넣으면(이전 버전의 문제)
// "화요일 벌금 미납인데 주간 총 벌금은 0원" 같은 모순이 생기기 쉽다.
import type {
  CycleListResponse,
  LeaveProofListResponse,
  RosterStatusResponse,
  StatusDay,
  StatusResponse,
} from "@/lib/api/types";

const STATUS_DAYS = ["월", "화", "수", "목", "금", "토", "일"];

const CYCLE_WEEK_1_AGO = "dummy-week-1-ago";
const CYCLE_WEEK_2_AGO = "dummy-week-2-ago";

// --- frame-checker-worker/src/index.js와 동일한 상수/공식 ---
// (GOAL_TYPE_MINUTES, dailyGoalMinutes, DAILY_FINE_CAP, MORNING_GOAL_MINUTES,
//  GOAL_TYPE_MULTIPLIER, weeklyGoalMinutes 등 — index.js:579,598,665-677,702-713,966-971)
const GOAL_TYPE_MINUTES: Record<string, number> = { "8H": 480, "9H": 540, "10": 600 };
const DAILY_FINE_CAP = 3000;
const MORNING_GOAL_MINUTES = 180;
const MORNING_FINE_PER_HOUR = 500;
// 30분 미달당 벌금 단가. 정확한 원본 단가는 앱스크립트 수식에만 있어 index.js
// 주석에도 명시돼 있지 않지만, 오전 벌금과 같은 시간당 500원 단가로 두면
// 6칸(3시간)째에 정확히 하루 상한 3,000원에 도달해 DAILY_FINE_CAP과 정합적이다.
const DAILY_FINE_PER_30MIN = 250;
const GOAL_TYPE_MULTIPLIER: Record<string, number> = {
  "8H (달성제)": 1,
  "9H (달성제)": 1.05,
  "10H (달성제)": 1.1,
  "8H (교시제)": 1.025,
  "9H (교시제)": 1.075,
  "10H (교시제)": 1.125,
};

function dailyGoalMinutes(
  goalType: string,
  normalLeaveUsed: number,
  reasonLeaveUsed: number,
  isSunday: boolean
): number | null {
  const prefix = goalType.slice(0, 2);
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

function weeklyGoalMinutes(goalType: string, weekdayEmpty: boolean, reasonLeaveTotal: number): number {
  if (weekdayEmpty) return 0;
  const prefix = goalType.slice(0, 2);
  const baseMinutes = GOAL_TYPE_MINUTES[prefix] || 0;
  return Math.max(0, baseMinutes * 5 - reasonLeaveTotal * (baseMinutes / 2));
}

function parseHM(raw: string): number {
  const m = (raw || "").trim().match(/^(\d{1,3}):(\d{2})$/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function formatHM(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function won(n: number): string {
  return `₩${n.toLocaleString()}`;
}

// 요일 하나를 만들 때 손으로 정하는 "원본 사실"만 받는다. 나머지(goal/morning/total,
// dailyGoalTime, shortfall)는 goalType/반휴 상태로부터 계산해서 채운다.
type DaySeed = {
  day: string;
  goalType: string;
  logStudyTimeMinutes: number; // 그날 실제 학습한 시간(분)
  normalLeaveUsed?: number;
  reasonLeaveUsed?: number;
  paymentStatus?: "" | "납부" | "미납";
  complete?: boolean; // false면 아직 마감 전(오늘/미래) — 벌금 계산도 하지 않는다
  confirmed?: boolean;
  morningEndMinutes?: number; // 1교시 종료까지 누적 학습시간(오전 벌금 계산용)
  isDepositAgainDay?: boolean;
};

function buildDay(seed: DaySeed): StatusDay {
  const {
    day,
    goalType,
    logStudyTimeMinutes,
    normalLeaveUsed = 0,
    reasonLeaveUsed = 0,
    paymentStatus = "",
    complete = true,
    confirmed = true,
    morningEndMinutes = MORNING_GOAL_MINUTES,
    isDepositAgainDay = false,
  } = seed;

  const isSunday = day === "일";
  const goalMinutes = dailyGoalMinutes(goalType, normalLeaveUsed, reasonLeaveUsed, isSunday);
  const dailyGoalTime = goalMinutes === null ? "" : formatHM(goalMinutes);

  // 목표시간 벌금: 미달분을 30분 단위로 올림해 단가를 곱하고, 하루 상한 이내로 자른다.
  let goalFineAmount = 0;
  let dailyShortfallMinutes = 0;
  if (complete && goalMinutes && goalMinutes > logStudyTimeMinutes) {
    dailyShortfallMinutes = Math.ceil((goalMinutes - logStudyTimeMinutes) / 30) * 30;
    goalFineAmount = Math.min(DAILY_FINE_CAP, (dailyShortfallMinutes / 30) * DAILY_FINE_PER_30MIN);
  }

  // 오전 목표시간 벌금: MAX(0, 3-누적시간(h)) × 500원 (index.js:1121).
  let morningFineAmount = 0;
  let morningShortfallMinutes = 0;
  if (complete && morningEndMinutes < MORNING_GOAL_MINUTES) {
    morningShortfallMinutes = MORNING_GOAL_MINUTES - morningEndMinutes;
    const shortfallHours = Math.floor(morningShortfallMinutes / 60) + (morningShortfallMinutes % 60 > 0 ? 1 : 0);
    morningFineAmount = Math.min(3 * MORNING_FINE_PER_HOUR, shortfallHours * MORNING_FINE_PER_HOUR);
  }

  const combined = goalFineAmount + morningFineAmount;
  const total = complete ? Math.min(DAILY_FINE_CAP, combined) : 0;

  return {
    day,
    total,
    goal: complete ? goalFineAmount : 0,
    morning: complete ? morningFineAmount : 0,
    explain: "",
    confirmed,
    complete,
    studyTime: formatHM(logStudyTimeMinutes),
    logStudyTime: formatHM(logStudyTimeMinutes),
    bonusStudyTime: "",
    dailyGoalTime,
    dailyShortfallTime: dailyShortfallMinutes > 0 ? formatHM(dailyShortfallMinutes) : "",
    morningShortfallTime: morningShortfallMinutes > 0 ? formatHM(morningShortfallMinutes) : "",
    isDepositAgainDay,
    paymentStatus: complete ? paymentStatus : "",
    normalLeaveUsed,
    reasonLeaveUsed,
    reasonLeavePending: false,
  };
}

// days로부터 주간 요약(학습시간/벌금/상점/참여율)을 실제 규칙대로 파생시킨다.
function deriveWeeklySummary(days: StatusDay[], goalType: string) {
  const weeklyStudyMinutes = days.reduce((sum, d) => sum + parseHM(d.studyTime), 0);
  const reasonLeaveTotal = days.reduce((sum, d) => sum + d.reasonLeaveUsed, 0);
  // 월요일 교시 칸이 비었는지로 "이번 주 진행 자체가 없었는지" 판정(index.js:967).
  const weekdayEmpty = !days[0]?.complete && parseHM(days[0]?.studyTime || "") === 0;
  const weeklyGoalMin = weeklyGoalMinutes(goalType, weekdayEmpty, reasonLeaveTotal);

  // 주간 총 벌금 = SUMIF(납부, 총벌금) — 납부된 날짜분만 합산(SHEET_STRUCTURE.md:63).
  const weeklyTotalFineAmount = days
    .filter((d) => d.paymentStatus === "납부")
    .reduce((sum, d) => sum + d.total, 0);

  // 학습시간 상점 = 로그학습시간(분)/60 × 0.1 (SHEET_STRUCTURE.md C36).
  const studyTimeMerit = Math.round((weeklyStudyMinutes / 60) * 0.1 * 10000) / 10000;
  const multiplier = GOAL_TYPE_MULTIPLIER[goalType] ?? 1;
  const fineDeduction = Math.round((weeklyTotalFineAmount / 500) * 0.1 * 10000) / 10000;
  const computedMerit = Math.max(0, Math.round(studyTimeMerit * multiplier * 10000) / 10000 - fineDeduction);

  const weekTotalConfirmed = days.filter((d) => d.confirmed).reduce((sum, d) => sum + d.total, 0);

  const isPeriodType = /^(8H|9H|10H) \(교시제\)$/.test(goalType);
  const targetPeriods = weeklyGoalMin / 60;

  return {
    weeklyStudyTime: formatHM(weeklyStudyMinutes),
    weeklyGoalTime: formatHM(weeklyGoalMin),
    weeklyTotalFineAmount,
    weeklyTotalFine: won(weeklyTotalFineAmount),
    studyTimeMerit,
    computedMerit,
    weekTotalConfirmed,
    isPeriodType,
    targetPeriods,
  };
}

// --- 사이클 2주 전: 페널티/미납 없이 깔끔하게 끝난 완결 주 (9H 교시제, 반휴 없음) ---
function buildTwoWeeksAgo(): StatusResponse {
  const goalType = "9H (교시제)";
  const perDayMinutes = [560, 545, 550, 560, 555, 540, 270]; // 월~토 9H+α, 일 반일 목표 충족
  const days = STATUS_DAYS.map((day, i) => buildDay({ day, goalType, logStudyTimeMinutes: perDayMinutes[i], paymentStatus: "납부" }));
  const summary = deriveWeeklySummary(days, goalType);

  return {
    goalType,
    joinDate: "2026-01-12",
    weeklyMerit: String(summary.computedMerit),
    weeklyMeritRank: "2",
    weeklyMeritBreakdown: {
      isZero: false,
      zeroReason: null,
      zeroConditions: [],
      studyTimeMerit: summary.studyTimeMerit,
      studyTimeHours: Math.round((summary.weeklyStudyTime ? parseHM(summary.weeklyStudyTime) : 0) / 60 * 100) / 100,
      reportMerit: 0.5,
      reportApprovedCount: 5,
      isLeader: false,
      reportMeritIncluded: true,
      multiplier: GOAL_TYPE_MULTIPLIER[goalType],
      multiplierDowngraded: false,
      reasonLeaveTotal: 0,
      penaltyDeduction: 0,
      fineDeduction: 0,
      weeklyTotalFineAmount: summary.weeklyTotalFineAmount,
      computedMerit: summary.computedMerit,
    },
    normalLeaveLeft: "2",
    reasonLeaveLeft: "4",
    weekTotalConfirmed: summary.weekTotalConfirmed,
    depositRefundEstimate: "₩10,000",
    depositRefundBreakdown: {
      amount: 10000,
      reason: null,
      outputPen: 0,
      timePen: 0,
      daysSinceJoin: 220,
      fineUnpaid: false,
      depositAgainStatus: "",
    },
    exitRequested: false,
    exitRequestDate: null,
    periodAttendanceRate: "93%",
    periodAttendanceBreakdown: {
      applicable: summary.isPeriodType,
      achievedCount: Math.round(summary.targetPeriods * 0.93),
      errorCount: 0,
      targetPeriods: summary.targetPeriods,
      rate: 93,
    },
    periodGrid: [],
    weeklyGoalTime: summary.weeklyGoalTime,
    weeklyStudyTime: summary.weeklyStudyTime,
    weeklyTotalFine: summary.weeklyTotalFine,
    weeklyOutputPen: 0,
    weeklyTimePen: 0,
    totalPenaltyBreakdown: { outputPenHistory: [], timePenHistory: [] },
    days,
  };
}

// --- 사이클 1주 전: 화요일 벌금 미납 1건이 있는 완결 주 ---
function buildOneWeekAgo(): StatusResponse {
  const goalType = "9H (교시제)";
  // 화요일만 로그학습시간을 목표(540분) 대비 크게 못 채워 미달 벌금이 발생하고,
  // paymentStatus를 "미납"으로 둔다 — 그날만 벌금이 생기고 납부도 안 된 유일한 날.
  const perDayMinutes = [545, 370, 550, 560, 555, 540, 270];
  const paymentByDay: Record<string, "" | "납부" | "미납"> = {
    월: "납부", 화: "미납", 수: "납부", 목: "납부", 금: "납부", 토: "납부", 일: "납부",
  };
  const days = STATUS_DAYS.map((day, i) =>
    buildDay({ day, goalType, logStudyTimeMinutes: perDayMinutes[i], paymentStatus: paymentByDay[day] })
  );
  const summary = deriveWeeklySummary(days, goalType);

  return {
    goalType,
    joinDate: "2026-01-12",
    weeklyMerit: String(summary.computedMerit),
    weeklyMeritRank: "5",
    weeklyMeritBreakdown: {
      isZero: false,
      zeroReason: null,
      zeroConditions: [],
      studyTimeMerit: summary.studyTimeMerit,
      studyTimeHours: Math.round((parseHM(summary.weeklyStudyTime) / 60) * 100) / 100,
      reportMerit: 0.5,
      reportApprovedCount: 5,
      isLeader: false,
      reportMeritIncluded: true,
      multiplier: GOAL_TYPE_MULTIPLIER[goalType],
      multiplierDowngraded: false,
      reasonLeaveTotal: 0,
      penaltyDeduction: 0,
      fineDeduction: Math.round((summary.weeklyTotalFineAmount / 500) * 0.1 * 10000) / 10000,
      weeklyTotalFineAmount: summary.weeklyTotalFineAmount,
      computedMerit: summary.computedMerit,
    },
    normalLeaveLeft: "1",
    reasonLeaveLeft: "3",
    weekTotalConfirmed: summary.weekTotalConfirmed,
    depositRefundEstimate: "₩10,000",
    depositRefundBreakdown: {
      amount: 10000,
      reason: null,
      outputPen: 0,
      timePen: 0,
      daysSinceJoin: 227,
      // 화요일 벌금 3,000원 초과 미납 상태 — forcedExitChecks의 "벌금 시한 내 미납" 사유와
      // 정합적으로 fineUnpaid를 true로 둔다(index.js:834).
      fineUnpaid: true,
      depositAgainStatus: "",
    },
    exitRequested: true,
    exitRequestDate: "2026-09-01",
    periodAttendanceRate: "86%",
    periodAttendanceBreakdown: {
      applicable: summary.isPeriodType,
      achievedCount: Math.round(summary.targetPeriods * 0.86),
      errorCount: 0,
      targetPeriods: summary.targetPeriods,
      rate: 86,
    },
    periodGrid: [],
    weeklyGoalTime: summary.weeklyGoalTime,
    weeklyStudyTime: summary.weeklyStudyTime,
    weeklyTotalFine: summary.weeklyTotalFine,
    weeklyOutputPen: 0,
    weeklyTimePen: 0,
    totalPenaltyBreakdown: { outputPenHistory: [], timePenHistory: [] },
    days,
  };
}

// --- 현재(실시간): 월요일에 예치금 재납 발생 ---
// 재납 판정은 "그날 14교시가 마감된 뒤" 그 확정된 일간 집계를 근거로 이뤄진다
// (관리자가 화요일 이후에 처리 버튼을 눌러도, 월요일 자체는 이미 마감되어
// 백업 탭에 고스란히 남는다) — 그래서 월요일 재납은 boundaryIndex=0("월")인
// 평범한 케이스이지, 분리 UI가 아예 안 뜨는 경계 케이스가 아니다. "재납 전"
// 구간이 월요일 하루뿐이고, 화~목(오늘)이 리셋 후 새로 쌓인 기록이다.
//
// 재납 리셋은 개인 탭을 template로 교체하므로(performDepositAgainReset), 리셋
// 이후(화~목)는 반휴 잔여량도 초기화된 상태 — normalLeaveLeft/reasonLeaveLeft를
// template 기본값(교시제 기준 흔한 값)으로 둔다.
function buildCurrent(): StatusResponse {
  const goalType = "9H (교시제)";

  // 월요일: 재납 이전 마지막 완결일 — 심한 미달로 벌금 3,000원(상한) 발생, 미납.
  const monday = buildDay({ day: "월", goalType, logStudyTimeMinutes: 60, paymentStatus: "미납", morningEndMinutes: 0 });

  // 리셋 이후(화~목)는 goalType/join이 template 초기 상태이므로 목표시간 계산
  // 자체가 무의미하다 — dailyGoalTime을 만들지 않고(""), 그냥 그날 실제 학습시간만
  // 기록되는 형태로 둔다(재납 직후 신규 등록과 동일한 취급).
  const afterDays: StatusDay[] = [
    buildDay({ day: "화", goalType, logStudyTimeMinutes: 310 }),
    buildDay({ day: "수", goalType, logStudyTimeMinutes: 295 }),
    buildDay({ day: "목", goalType, logStudyTimeMinutes: 200 }),
    buildDay({ day: "금", goalType, logStudyTimeMinutes: 0, complete: false, confirmed: false }),
    buildDay({ day: "토", goalType, logStudyTimeMinutes: 0, complete: false, confirmed: false }),
    buildDay({ day: "일", goalType, logStudyTimeMinutes: 0, complete: false, confirmed: false }),
  ];
  const days = [monday, ...afterDays];

  // 리셋 후(화~목) 구간만으로 "현재" 요약을 계산 — 월요일은 이미 백업 탭으로
  // 옮겨졌으므로 현재 개인 탭 집계에는 포함되지 않는다.
  const afterOnly = [buildDay({ day: "월", goalType, logStudyTimeMinutes: 0, complete: false, confirmed: false }), ...afterDays];
  const summaryAfter = deriveWeeklySummary(afterOnly, goalType);

  // 재납 전(월요일만) 요약 — 백업 탭 스냅샷.
  const beforeDays = [monday, ...STATUS_DAYS.slice(1).map((day) => buildDay({ day, goalType, logStudyTimeMinutes: 0, complete: false, confirmed: false }))];
  const summaryBefore = deriveWeeklySummary(beforeDays, goalType);

  return {
    goalType,
    joinDate: "2026-08-25", // 재납으로 오늘(화요일, 처리 시점) 날짜로 리셋됨
    weeklyMerit: String(summaryAfter.computedMerit),
    weeklyMeritRank: "7",
    weeklyMeritBreakdown: {
      isZero: false,
      zeroReason: null,
      zeroConditions: [],
      studyTimeMerit: summaryAfter.studyTimeMerit,
      studyTimeHours: Math.round((parseHM(summaryAfter.weeklyStudyTime) / 60) * 100) / 100,
      reportMerit: 0,
      reportApprovedCount: 0,
      isLeader: false,
      reportMeritIncluded: false,
      multiplier: GOAL_TYPE_MULTIPLIER[goalType],
      multiplierDowngraded: false,
      reasonLeaveTotal: 0,
      penaltyDeduction: 0,
      fineDeduction: 0,
      weeklyTotalFineAmount: summaryAfter.weeklyTotalFineAmount,
      computedMerit: summaryAfter.computedMerit,
    },
    normalLeaveLeft: "2",
    reasonLeaveLeft: "4",
    weekTotalConfirmed: summaryAfter.weekTotalConfirmed,
    depositRefundEstimate: "₩0",
    depositRefundBreakdown: {
      amount: 0,
      reason: "예치금 재납 대상자",
      outputPen: 0,
      timePen: 0,
      daysSinceJoin: 0,
      fineUnpaid: false,
      depositAgainStatus: "납부",
    },
    exitRequested: false,
    exitRequestDate: null,
    periodAttendanceRate: "-",
    periodAttendanceBreakdown: { applicable: false, achievedCount: 0, errorCount: 0, targetPeriods: 0, rate: null },
    periodGrid: [],
    weeklyGoalTime: summaryAfter.weeklyGoalTime,
    weeklyStudyTime: summaryAfter.weeklyStudyTime,
    weeklyTotalFine: summaryAfter.weeklyTotalFine,
    weeklyOutputPen: 0,
    weeklyTimePen: 0,
    totalPenaltyBreakdown: { outputPenHistory: [], timePenHistory: [] },
    days,
    depositAgainSplit: {
      boundaryDay: "월",
      before: {
        goalType,
        joinDate: "2026-01-12",
        weeklyMerit: String(summaryBefore.computedMerit),
        // buildDepositAgainSnapshot(index.js)이 목표시간/참여율 왜곡을 막기 위해
        // 항상 00:00 / "-"로 두는 것과 동일하게 맞춘다.
        weeklyGoalTime: "00:00",
        weeklyStudyTime: monday.studyTime,
        weeklyTotalFine: won(monday.paymentStatus === "납부" ? monday.total : 0),
        periodAttendanceRate: "-",
        periodAttendanceBreakdown: { applicable: false, achievedCount: 0, errorCount: 0, targetPeriods: 0, rate: null },
        periodGrid: [],
        weekTotalConfirmed: monday.confirmed ? monday.total : 0,
      },
      days,
    },
  };
}

const CYCLE_BUILDERS: Record<string, () => StatusResponse> = {
  [CYCLE_WEEK_1_AGO]: buildOneWeekAgo,
  [CYCLE_WEEK_2_AGO]: buildTwoWeeksAgo,
};

export function dummyCycleList(): CycleListResponse {
  return {
    weeks: [
      { fileId: CYCLE_WEEK_1_AGO, weekOf: "260817", weekTo: "260823" },
      { fileId: CYCLE_WEEK_2_AGO, weekOf: "260810", weekTo: "260816" },
    ],
  };
}

export function dummyStatus(cycleFileId: string | null): StatusResponse {
  if (cycleFileId && CYCLE_BUILDERS[cycleFileId]) return CYCLE_BUILDERS[cycleFileId]();
  return buildCurrent();
}

// --- ALL 탭(roster) 더미 ---
// RosterMember.timer는 "달성/목표" 형식(index.js buildRosterStatus의 D열 그대로,
// 개인 탭 C28/M28 참조) — 각 사이클의 weeklyGoalTime(45:00, 반휴 없는 9H 교시제
// 기준)과 실제로 어긋나지 않도록 45:00을 목표로 통일한다.
const DUMMY_MEMBERS_CURRENT = [
  { number: "3", name: "박민수", timer: "08:20 / 45:00", merit: "0.9", rank: "🥇", status: "정상" },
  { number: "7", name: "이서연", timer: "07:55 / 45:00", merit: "0.8", rank: "🥈", status: "정상" },
  { number: "1", name: "김태현", timer: "07:30 / 45:00", merit: "0.7", rank: "🥉", status: "정상" },
  { number: "5", name: "정하윤", timer: "06:40 / 45:00", merit: "0.6", rank: "4", status: "정상" },
  { number: "2", name: "최도윤", timer: "01:00 / 45:00", merit: "0.1", rank: "5", status: "미납" },
  { number: "9", name: "장서준", timer: "05:10 / 45:00", merit: "0.5", rank: "6", status: "정상" },
];

const DUMMY_MEMBERS_1_AGO = [
  { number: "7", name: "이서연", timer: "46:10 / 45:00", merit: "7.4", rank: "🥇", status: "정상" },
  { number: "3", name: "박민수", timer: "44:50 / 45:00", merit: "6.9", rank: "🥈", status: "정상" },
  { number: "2", name: "최도윤", timer: "43:00 / 45:00", merit: "5.2", rank: "🥉", status: "미납" },
  { number: "1", name: "김태현", timer: "40:20 / 45:00", merit: "4.9", rank: "4", status: "정상" },
  { number: "5", name: "정하윤", timer: "38:00 / 45:00", merit: "4.1", rank: "5", status: "정상" },
];

const DUMMY_MEMBERS_2_AGO = [
  { number: "1", name: "김태현", timer: "47:40 / 45:00", merit: "6.5", rank: "🥇", status: "정상" },
  { number: "5", name: "정하윤", timer: "47:10 / 45:00", merit: "6.3", rank: "🥈", status: "정상" },
  { number: "3", name: "박민수", timer: "46:00 / 45:00", merit: "6.1", rank: "🥉", status: "정상" },
  { number: "7", name: "이서연", timer: "45:30 / 45:00", merit: "5.8", rank: "4", status: "정상" },
  { number: "2", name: "최도윤", timer: "45:05 / 45:00", merit: "5.6", rank: "5", status: "정상" },
];

// 집계 D20(총 모금액) = D21(이월)+D22(주간벌금)+D23(퇴실벌금)+D24(퇴실예치, 조건부)
// (frame-checker-worker/src/index.js의 마이그레이션 수식 주석 기준) — fineCarry/
// fineThisWeek/fineOuter/depositOuter 네 값의 합으로 collectMoney를 파생시킨다.
function buildCollectMoney(fineCarry: number, fineThisWeek: number, fineOuter: number, depositOuter = 0) {
  return fineCarry + fineThisWeek + fineOuter + depositOuter;
}

export function dummyRosterStatus(cycleFileId: string | null): RosterStatusResponse {
  if (cycleFileId === CYCLE_WEEK_1_AGO) {
    const fineCarry = 0;
    const fineThisWeek = 33_000; // 5명 중 화요일 미납 1건을 제외한 나머지 납부분 합계 규모
    const fineOuter = 0;
    const collectMoney = buildCollectMoney(fineCarry, fineThisWeek, fineOuter);
    const share = Math.floor(collectMoney / 5 / 1000) * 1000;
    return {
      members: DUMMY_MEMBERS_1_AGO,
      collectMoney,
      fineCarry,
      fineThisWeek,
      fineOuter,
      settlement: [
        { number: "7", name: "이서연", rank: 1, amount: share },
        { number: "3", name: "박민수", rank: 2, amount: share },
        { number: "2", name: "최도윤", rank: 3, amount: share },
        { number: "1", name: "김태현", rank: 4, amount: share },
        { number: "5", name: "정하윤", rank: 5, amount: share },
      ],
    };
  }
  if (cycleFileId === CYCLE_WEEK_2_AGO) {
    const fineCarry = 0;
    const fineThisWeek = 0; // 전원 목표 달성, 벌금 자체가 없는 주
    const fineOuter = 0;
    const collectMoney = buildCollectMoney(fineCarry, fineThisWeek, fineOuter);
    const share = Math.floor(collectMoney / 5 / 1000) * 1000;
    return {
      members: DUMMY_MEMBERS_2_AGO,
      collectMoney,
      fineCarry,
      fineThisWeek,
      fineOuter,
      settlement: [
        { number: "1", name: "김태현", rank: 1, amount: share },
        { number: "5", name: "정하윤", rank: 2, amount: share },
        { number: "3", name: "박민수", rank: 3, amount: share },
        { number: "7", name: "이서연", rank: 4, amount: share },
        { number: "2", name: "최도윤", rank: 5, amount: share },
      ],
    };
  }
  // 현재(실시간) — 1주 전 이월분(fineCarry)이 이번 주로 넘어오고, 아직 이번 주가
  // 안 끝났으니 settlement는 비공개(undefined, 일요일 14교시 종료 전).
  const fineCarry = 33_000; // 1주 전 화요일 미납분이 그대로 이월
  const fineThisWeek = 5_000; // 이번 주 들어온 납부분(예: 최도윤 재납 관련 외 소액)
  const fineOuter = 0;
  const depositOuter = 0;
  return {
    members: DUMMY_MEMBERS_CURRENT,
    collectMoney: buildCollectMoney(fineCarry, fineThisWeek, fineOuter, depositOuter),
    fineCarry,
    fineThisWeek,
    fineOuter,
    depositOuter,
    settlement: undefined,
  };
}

// --- "사유 반휴 신청" 관리자 검토 화면 더미 — 디자인 확인용 ---
// 상태(대기/봇 대기중 큐)와 신청 장수(1장/2장)가 섞인 케이스를 함께 보여준다.
const now = Date.now();
export function dummyLeaveProofList(): LeaveProofListResponse {
  return {
    items: [
      {
        id: "dummy-leave-1",
        memberNumber: "3",
        memberName: "박민수",
        day: "화",
        reason: "병원 진료로 인한 오전 반차",
        requesterEmail: "member3@example.com",
        ts: now - 30 * 60 * 1000,
        reviewStatus: "pending",
        rejectReason: null,
        count: 1,
      },
      {
        id: "dummy-leave-2",
        memberNumber: "7",
        memberName: "이서연",
        day: "화",
        reason: "가족 행사 참석",
        requesterEmail: "member7@example.com",
        ts: now - 90 * 60 * 1000,
        reviewStatus: "pending",
        rejectReason: null,
        count: 2,
      },
      {
        id: "dummy-leave-3",
        memberNumber: "1",
        memberName: "김태현",
        day: "목",
        reason: "감기몸살로 인한 컨디션 난조",
        requesterEmail: "member1@example.com",
        ts: now - 3 * 60 * 60 * 1000,
        reviewStatus: "pending",
        rejectReason: null,
        count: 1,
        // 봇이 꺼져 있어 Worker KV 대기열에만 있는 신청 케이스 — "봇 대기중" 뱃지 확인용.
        queued: true,
      },
    ],
  };
}
