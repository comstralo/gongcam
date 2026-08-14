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
  explain: string;
  confirmed: boolean;
};

export type StatusResponse = {
  goalType: string;
  weekTotalConfirmed: number;
  days: StatusDay[];
};

export type PushSendTestResult = {
  status?: number;
  error?: string;
};

export type PushSendTestResponse = {
  results: PushSendTestResult[];
};
