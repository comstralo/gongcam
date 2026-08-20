export type VerifyResponse = {
  token: string;
  email: string;
  name?: string;
};

export type ParticipantsResponse = {
  members: string[];
  stale: boolean;
};

export type StatusDay = {
  day: string;
  total: number;
  goal: number;
  morning: number;
  explain: string;
  confirmed: boolean;
  complete: boolean;
  studyTime: string;
  bonusStudyTime: string;
  dailyGoalTime: string;
  paymentStatus: string;
  normalLeaveUsed: number;
  reasonLeaveUsed: number;
};

export type MeritZeroCondition = {
  key: string;
  label: string;
  met: boolean;
};

export type WeeklyMeritBreakdown = {
  isZero: boolean;
  zeroReason: string | null;
  zeroConditions: MeritZeroCondition[];
  studyTimeMerit: number;
  studyTimeHours: number;
  reportMerit: number;
  reportApprovedCount: number | null;
  isLeader: boolean;
  reportMeritIncluded: boolean;
  multiplier: number;
  multiplierDowngraded: boolean;
  reasonLeaveTotal: number;
  penaltyDeduction: number;
  fineDeduction: number;
  weeklyTotalFineAmount: number;
  computedMerit: number;
};

export type DepositRefundBreakdown = {
  amount: number;
  reason: string | null;
  outputPen: number;
  timePen: number;
  daysSinceJoin: number;
  fineUnpaid: boolean;
  depositAgainStatus: string | null;
};

export type PeriodAttendanceBreakdown = {
  applicable: boolean;
  achievedCount: number;
  errorCount: number;
  targetPeriods: number;
  rate: number | null;
};

export type TotalPenaltyBreakdown = {
  outputPenReasons: string[];
  timePenReasons: string[];
};

export type StatusResponse = {
  goalType: string;
  joinDate: string;
  weeklyMerit: string;
  weeklyMeritRank: string;
  weeklyMeritBreakdown: WeeklyMeritBreakdown;
  normalLeaveLeft: string;
  reasonLeaveLeft: string;
  weekTotalConfirmed: number;
  depositRefundEstimate: string;
  depositRefundBreakdown: DepositRefundBreakdown;
  periodAttendanceRate: string;
  periodAttendanceBreakdown: PeriodAttendanceBreakdown;
  periodGrid: PeriodGridDay[];
  weeklyTotalFine: string;
  weeklyOutputPen: number;
  weeklyTimePen: number;
  totalPenaltyBreakdown: TotalPenaltyBreakdown;
  days: StatusDay[];
};

export type PeriodGridDay = {
  day: string;
  periods: string[];
};

export type RosterMember = {
  name: string;
  timer: string;
  rank: string;
  status: string;
};

export type RosterStatusResponse = {
  members: RosterMember[];
};

export type SnapshotListResponse = {
  weeks: string[];
};

export type SnapshotDetailResponse = {
  weekOf: string;
  weekTo: string;
  roster: RosterStatusResponse;
  personal: StatusResponse | null;
};

export type AdminMember = {
  number: string;
  name: string;
  email: string;
};

export type AdminMembersResponse = {
  members: AdminMember[];
};

export type PushSendTestResult = {
  status?: number;
  error?: string;
};

export type PushSendTestResponse = {
  results: PushSendTestResult[];
};

export type AdminOpenSlotsResponse = {
  slots: string[];
};

export type CreateMemberRequest = {
  number: string;
  name: string;
  email: string;
  goalHours: string;
  goalKind: string;
  examKind?: string;
};

export type CreateMemberResponse = {
  ok: true;
  number: string;
  name: string;
  email: string;
  needsReauth?: boolean;
  grantError?: string;
};

export type GrantMemberAccessResponse = {
  ok: true;
};

export type FineStatus = "미납" | "납부" | "면제";

export type UnpaidFine = {
  number: string;
  name: string;
  day: string;
};

export type AdminFinesUnpaidResponse = {
  unpaid: UnpaidFine[];
};

export type PaidFine = {
  number: string;
  name: string;
  day: string;
};

export type AdminFinesPaidResponse = {
  paid: PaidFine[];
  totalAmount: number;
};

export type ExemptFine = {
  number: string;
  name: string;
  day: string;
};

export type AdminFinesExemptResponse = {
  exempt: ExemptFine[];
};

export type SetFineStatusRequest = {
  number: string;
  day: string;
  status: FineStatus;
};

export type SetFineStatusResponse = {
  ok: true;
  number: string;
  day: string;
  status: FineStatus;
};

export type DepositStatus = "미납" | "납부";

export type UnpaidDeposit = {
  number: string;
  name: string;
};

export type AdminDepositsUnpaidResponse = {
  unpaid: UnpaidDeposit[];
};

export type SetDepositStatusRequest = {
  number: string;
  status: DepositStatus;
};

export type SetDepositStatusResponse = {
  ok: true;
  number: string;
  status: DepositStatus;
};

export type ExitKind = "forced" | "admin_forced" | "settle" | "deposit_again";

export type ExitReasonCode = {
  code: string;
  label: string;
};

// met: 이 조건에 실제로 해당하는지. allChecks는 해당 여부와 무관하게
// 강제퇴실 조건 전체(4개)를 담아, UI가 모든 케이스를 나열하고 해당되는
// 것만 강조 표시할 수 있게 한다.
export type ExitCheckItem = ExitReasonCode & { met: boolean };

export type ExitCandidate = {
  number: string;
  name: string;
  suggestedKind: Exclude<ExitKind, "deposit_again" | "admin_forced">;
  reasons: string[];
  reasonCodes?: ExitReasonCode[];
  allChecks?: ExitCheckItem[];
};

export type AdminExitCandidatesResponse = {
  candidates: ExitCandidate[];
};

export type MemberRosterEntry = {
  number: string;
  name: string;
  joinDate: string;
  totalPenalty: number;
  suggestedKind: Exclude<ExitKind, "deposit_again" | "admin_forced">;
  reasons: string[];
  reasonCodes?: ExitReasonCode[];
  allChecks?: ExitCheckItem[];
};

export type AdminMembersRosterResponse = {
  members: MemberRosterEntry[];
};

export type ExitPreviewRequest = {
  number: string;
  kind: ExitKind;
  forcedReason?: string;
};

export type ExitPreviewResponse = {
  ok: true;
  discountRatio: number;
  resultStr: string[];
  reasons: ExitReasonCode[];
  allChecks: ExitCheckItem[];
  resultMsg: string;
  newFineOuter: number;
  newDepositOuter: number;
  kindStr: string;
};

export type ExitConfirmResponse = {
  ok: true;
  number: string;
  name: string;
  resultMsg: string;
};

export type GoalScheduleResponse = {
  scheduled: string | null;
  validValues: string[];
};

export type SetGoalScheduleResponse = {
  ok: true;
  scheduled: string;
};

export type BotStatusResponse = {
  online: boolean;
  roomState: "in_room" | "outside" | null;
  screenshot: string | null;
  recentLogs: string[];
};

export type BotCommand = "restart";

export type BotCommandResponse = {
  ok: true;
  command: BotCommand;
};

export type ReportStatusResponse = {
  inProgress: boolean;
  recentLogs: string[];
};

export type CaptureReviewItem = {
  id: string;
  nickname: string;
  reason: string;
  mode: "screenshot" | "video";
  reporterEmail: string;
  ts: number;
  reviewStatus: "pending" | "approved" | "rejected";
};

export type CapturesListResponse = {
  items: CaptureReviewItem[];
};

export type OutputPenaltyResult = {
  number: string;
  name: string;
  occurrence: number;
  isPCount: boolean;
};

export type CaptureDecideResponse = {
  ok: boolean;
  penalty?: OutputPenaltyResult | null;
};

export type MemberReorderPlanItem = {
  from: string;
  to: string;
  name: string;
};

export type MemberReorderPreviewResponse = {
  plan: MemberReorderPlanItem[];
};

export type MemberReorderResponse = {
  ok: boolean;
  moved: MemberReorderPlanItem[];
  error?: string;
};
