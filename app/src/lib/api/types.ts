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
};

export type StatusResponse = {
  goalType: string;
  joinDate: string;
  weeklyMerit: string;
  normalLeaveLeft: string;
  reasonLeaveLeft: string;
  weekTotalConfirmed: number;
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
  capturedAt: string;
  roster: RosterStatusResponse;
  personal: StatusResponse | null;
};

export type SnapshotRunNowResponse = {
  ok: true;
  weekOf: string;
  memberCount: number;
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
