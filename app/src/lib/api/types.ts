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

export type StatusResponse = {
  goalType: string;
  joinDate: string;
  weeklyMerit: string;
  weeklyMeritRank: string;
  normalLeaveLeft: string;
  reasonLeaveLeft: string;
  weekTotalConfirmed: number;
  depositRefundEstimate: string;
  periodAttendanceRate: string;
  weeklyTotalFine: string;
  weeklyOutputPen: number;
  weeklyTimePen: number;
  days: StatusDay[];
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
};
