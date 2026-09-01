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
  // 이 요일의 실제 캘린더 날짜("YYYY-MM-DD"). 서버가 계산에 실패하면 null —
  // 이 경우 프론트는 가입일 비교를 건너뛰고 기존처럼 동작한다.
  date: string | null;
  total: number;
  goal: number;
  morning: number;
  explain: string;
  confirmed: boolean;
  complete: boolean;
  studyTime: string;
  logStudyTime: string;
  bonusStudyTime: string;
  dailyGoalTime: string;
  // 일간/오전 목표시간 벌금이 부과된 날의 미달 시간(HH:MM). 벌금이 0이면 "".
  dailyShortfallTime: string;
  morningShortfallTime: string;
  // 예치금 재납 2회 달성 시점의 요일과 이 요일이 같을 때만 true. 예치금
  // 재납 상태(depositRefundBreakdown)는 요일별 기록이 아니라 개인 탭 상단의
  // 주간 스냅샷 하나뿐이라, 이 값으로 "발생일" 카드에만 노출한다.
  isDepositAgainDay: boolean;
  paymentStatus: string;
  normalLeaveUsed: number;
  reasonLeaveUsed: number;
  // 관리자 승인 대기 중인 사유반휴 신청이 이 요일에 있는지 — 승인 전까지는
  // reasonLeaveUsed에 반영되지 않는다.
  reasonLeavePending: boolean;
};

export type ReasonLeaveProofStatus = {
  pending: boolean;
  rejected: { reason: string } | null;
};

export type SetReasonLeaveProofRequest = {
  day: string;
  reason: string;
  imageBase64: string;
  imageExt: "jpg" | "png";
  // 같은 증빙으로 이 요일에 한 번에 신청할 장수(1 또는 2). 미지정 시 1.
  count?: 1 | 2;
};

export type SetReasonLeaveProofResponse = {
  ok: true;
  id: string;
  // 봇이 꺼져 있어 KV 대기열에 임시 보관됐다는 표시. 학생 화면에는 봇에 이미
  // 전달된 경우와 동일하게 "관리자 확인 중"으로 보여준다.
  queued?: boolean;
};

export type CancelReasonLeaveProofResponse = {
  ok: true;
};

export type LeaveProofReviewItem = {
  id: string;
  memberNumber: string;
  memberName: string;
  day: string;
  reason: string;
  requesterEmail: string;
  ts: number;
  reviewStatus: "pending" | "approved" | "rejected";
  rejectReason: string | null;
  // 승인 시 이 증빙으로 반영할 장수(1 또는 2). 이 필드가 생기기 전 신청은
  // undefined일 수 있으며, 그 경우 1로 취급한다.
  count?: 1 | 2;
  // 봇이 꺼져 있어 아직 봇 manifest가 아니라 Worker KV 대기열에만 있는
  // 신청인지 — true면 관리자 승인/반려가 봇 없이 즉시 처리된다.
  queued?: boolean;
};

export type LeaveProofListResponse = {
  items: LeaveProofReviewItem[];
};

export type LeaveProofDecideRequest = {
  id: string;
  decision: "approved" | "rejected";
  memberNumber: string;
  day: string;
  rejectReason?: string;
  count?: 1 | 2;
};

export type LeaveProofDecideResponse = {
  ok: boolean;
  botSyncFailed?: boolean;
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
  // 실제 제출된 퇴실 신청일 기준으로 서버가 판정한 "퇴실 통보 지연" 여부.
  // amount에 이미 반영되어 있으므로, 신청 완료 상태에서는 이 값을 그대로
  // 신뢰해서 보여주면 된다(프론트가 재계산할 필요 없음).
  lateNotice: boolean;
};

export type PeriodAttendanceBreakdown = {
  applicable: boolean;
  achievedCount: number;
  errorCount: number;
  targetPeriods: number;
  rate: number | null;
};

export type TotalPenaltyBreakdown = {
  outputPenHistory: PenaltySlotHistoryEntry[];
  timePenHistory: PenaltySlotHistoryEntry[];
};

// 재납 확정 직전 백업 탭에서 복원한 "재납 이전" 요약 스냅샷. 순위/제보점수
// 등 다른 시트를 참조해야 하는 값은 스냅샷 시점 그대로 복원할 수 없어 포함되지
// 않는다.
export type DepositAgainBeforeSnapshot = {
  goalType: string;
  joinDate: string;
  weeklyMerit: string;
  weeklyGoalTime: string;
  weeklyStudyTime: string;
  weeklyTotalFine: string;
  periodAttendanceRate: string;
  periodAttendanceBreakdown: PeriodAttendanceBreakdown;
  periodGrid: PeriodGridDay[];
  weekTotalConfirmed: number;
};

export type DepositAgainSplit = {
  // 재납 전 구간의 마지막 요일("월"~"일"). 이 요일까지(포함)는 백업 탭 값을,
  // 그 뒤는 현재 탭 값을 쓴다.
  boundaryDay: string;
  before: DepositAgainBeforeSnapshot;
  // days와 동일한 형태지만, 요일별로 재납 전/후 값이 이미 병합되어 있다.
  days: StatusDay[];
};

export type StatusResponse = {
  name: string;
  goalType: string;
  joinDate: string;
  // 가입일 원본("YYYY-MM-DD") — joinDate("D+238")는 매일 바뀌는 상대값이라
  // 요일별 날짜와 직접 비교할 수 없어 별도로 내려준다. 값이 없으면 "".
  joinDateExact: string;
  weeklyMerit: string;
  weeklyMeritRank: string;
  weeklyMeritBreakdown: WeeklyMeritBreakdown;
  normalLeaveLeft: string;
  reasonLeaveLeft: string;
  weekTotalConfirmed: number;
  depositRefundEstimate: string;
  depositRefundBreakdown: DepositRefundBreakdown;
  // 본인이 대시보드에서 "퇴실 신청"을 접수해둔 상태인지.
  exitRequested: boolean;
  exitRequestDate: string | null;
  // 마지막 참여일이 지난 뒤 "예치금 정산액에 동의합니다"를 누른 시각(ms
  // epoch). 아직 안 눌렀으면 null.
  exitAgreedAt: number | null;
  periodAttendanceRate: string;
  periodAttendanceBreakdown: PeriodAttendanceBreakdown;
  periodGrid: PeriodGridDay[];
  weeklyGoalTime: string;
  weeklyStudyTime: string;
  weeklyTotalFine: string;
  weeklyOutputPen: number;
  weeklyTimePen: number;
  totalPenaltyBreakdown: TotalPenaltyBreakdown;
  days: StatusDay[];
  // 이번 주 안에 예치금 재납이 발생했을 때만 존재. 없으면(대부분의 경우)
  // undefined — 이 주는 재납이 없었거나 분리해서 보여줄 "재납 전" 구간이
  // 없다는 뜻이다(예: 월요일 시작 직후 재납).
  depositAgainSplit?: DepositAgainSplit | null;
};

export type PeriodGridPeriod = {
  start: string;
  end: string;
  rate: string;
};

export type PeriodGridDay = {
  day: string;
  periods: PeriodGridPeriod[];
};

export type RosterMember = {
  number: string;
  name: string;
  timer: string;
  merit: string;
  rank: string;
  status: string;
};

export type SettlementItem = {
  number: string;
  name: string;
  rank: number;
  // 총 모금액을 정산 대상 인원 수로 1/n 균등 분배한 금액, 원 단위.
  amount: number;
};

export type RosterStatusResponse = {
  members: RosterMember[];
  // 집계 시트 D20~D24, 원 단위 숫자.
  collectMoney: number;
  fineCarry: number;
  fineThisWeek: number;
  fineOuter: number;
  // 이번 주간 총 모금액에 포함되지 않았고(스터디장 개인 페널티 없음) 관리자가
  // 아니면 백엔드가 이 필드 자체를 응답에서 제외한다.
  depositOuter?: number;
  // 이번 주 1~5등에게 분배될 금액. 스터디장 본인이거나 일요일 14교시
  // 종료(23:30 KST) 이후가 아니면 백엔드가 이 필드 자체를 제외한다.
  settlement?: SettlementItem[];
};

export type CycleWeek = {
  // 이 주차 백업 파일의 Google Drive fileId. /status, /roster-status에
  // ?cycle=<fileId>로 넘기면 그 주차 기준 데이터를 조회한다.
  fileId: string;
  weekOf: string;
  weekTo: string;
  // 조회 대상 회원(member 쿼리 파라미터, 없으면 본인)이 이 주차 시점 명단에
  // 실제로 존재했는지. 중도 가입 회원은 가입 전 주차엔 명단 자체에 없어
  // false가 된다 — 이 경우 프론트는 날짜 라벨 대신 "데이터 없음"으로 보여준다.
  hasData: boolean;
};

export type CycleListResponse = {
  // 현재 진행 중인 사이클(최대 3주) 중 이미 백업된 주차만 최신순으로 담는다.
  // "현재"(실시간) 옵션은 이 목록에 없다 — 프론트가 cycle 파라미터 생략으로 표현한다.
  weeks: CycleWeek[];
  // 사이클 하나가 최대 몇 주로 구성되는지(현재 3) — weeks.length가 이보다
  // 적으면(아직 3주가 안 지남) 나머지는 비활성화 슬롯으로 채워 보여준다.
  maxWeeks: number;
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

export type PushSendToMemberRequest = {
  nickname: string;
  message: string;
};

export type PushSendToMemberResponse = {
  ok: true;
};

export type PushSubscriptionStatusItem = {
  name: string;
  subscribed: boolean;
};

export type PushSubscriptionStatusResponse = {
  items: PushSubscriptionStatusItem[];
};

export type PushDevice = {
  id: string;
  deviceLabel: string;
  enabled: boolean;
  savedAt: number | null;
};

export type ListPushDevicesResponse = {
  devices: PushDevice[];
};

export type PushDeviceToggleResponse = {
  ok: true;
};

export type PushDeviceRemoveResponse = {
  ok: true;
};

export type PushDeviceRenameResponse = {
  ok: true;
  deviceLabel: string;
};

export type RecentNoticeItem = {
  nickname: string;
  message: string;
  senderName: string;
  ts: number;
};

export type RecentNoticesResponse = {
  items: RecentNoticeItem[];
};

export type AdminOpenSlotsResponse = {
  slots: string[];
};

export type CreateMemberRequest = {
  number: string;
  name: string;
  email: string;
  gooroomeeAccount?: string;
  goalHours: string;
  goalKind: string;
  examKind?: string;
  // "YYYY-MM-DD". 미지정 시 서버가 오늘(KST) 날짜로 대체한다 — 서버가
  // 오늘~일주일 뒤 범위인지 다시 검증하므로 그 범위 밖 값은 400으로 거부된다.
  joinDate?: string;
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

export type ExitKind = "forced" | "admin_forced" | "settle" | "deposit_again";

export type ExitReasonCode = {
  code: string;
  label: string;
};

// met: 이 조건에 실제로 해당하는지. allChecks는 해당 여부와 무관하게
// 강제퇴실 조건 전체(4개)를 담아, UI가 모든 케이스를 나열하고 해당되는
// 것만 강조 표시할 수 있게 한다.
export type ExitCheckItem = ExitReasonCode & { met: boolean };

export type PenaltySlotHistoryEntry = {
  label: string;
  cycle: number;
  when: string;
  reason: string;
  // 이 이력이 기록될 때 함께 남긴 원본 제보 캡처 ID. /admin/captures/file로
  // 스크린샷·영상을 다시 불러오는 데 쓴다. 이 필드가 생기기 전 이력은 null.
  captureId: string | null;
};

export type ExitCandidate = {
  number: string;
  name: string;
  suggestedKind: Exclude<ExitKind, "deposit_again" | "admin_forced">;
  reasons: string[];
  reasonCodes?: ExitReasonCode[];
  allChecks?: ExitCheckItem[];
  // 채워진 송출P/주간P 슬롯 주석 중 가장 최근 날짜의 요일("월"~"일"). 주석이
  // 없으면 null — 이 경우 "요일 미확인" 그룹으로 묶인다.
  occurredDay: string | null;
  // 개인별 상세 카드의 "송출 P 적립 기록"/"주간 P 적립 기록" 섹션에 그대로
  // 뿌려지는 슬롯별 이력(차수·발생일시·사유).
  outputPenHistory: PenaltySlotHistoryEntry[];
  timePenHistory: PenaltySlotHistoryEntry[];
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
  // 회원 본인이 대시보드에서 "퇴실 신청"을 접수했는지 — 실제 시트 반영과는
  // 무관한 예약 표시일 뿐이며, 관리자가 퇴실을 확정하면 자동으로 꺼진다.
  exitRequested: boolean;
  exitRequestDate: string | null;
  // 신청일자(ms epoch)와 동의일자(ms epoch, 아직 동의 전이면 null). 회원이
  // 마지막 참여일이 지난 뒤 "예치금 정산액에 동의합니다"를 눌러야 정산
  // 퇴실 처리 버튼이 활성화된다.
  exitRequestedAt: number | null;
  exitAgreedAt: number | null;
  partiStatus: "스터디장" | "부스터디장" | "스터디원";
  // PUSH 알림 자체를 켰는지(웹 푸시 구독 여부) — 이게 꺼져 있으면 아래
  // notifyPrefs가 전부 켜져 있어도 실제로는 아무 알림도 못 받는다.
  pushSubscribed: boolean;
  // 카테고리별 수신 on/off. 관리자는 여기서 조회만 할 수 있고, 실제 변경은
  // 회원 본인이 /notify-prefs로만 할 수 있다.
  notifyPrefs: Record<NotifyCategory, boolean>;
  googleAccount: string;
  gooroomeeAccount: string;
  examKind: string;
  // 목표시간 유형("8H (교시제)" 등, 개인 탭 O3). formatGoalType으로 괄호를
  // 벗겨 표시한다 — StatusView.tsx와 동일한 표시 규칙.
  goalType: string;
  // 마지막으로 로그인한 시각(ms epoch). 한 번도 로그인한 적 없으면 null.
  lastLoginAt: number | null;
  // 마지막 로그인 IP. lastLoginAt이 null이거나, 이 기능 추가 이전에 저장된
  // 구형 기록이면 빈 문자열.
  lastLoginIp: string;
  // 이 회원 개인 탭의 실제 구글 시트 gid. 시트에서 그 탭을 찾지 못하면 null.
  sheetGid: number | null;
};

export type AdminMembersRosterResponse = {
  members: MemberRosterEntry[];
  notifyCategories: Record<NotifyCategory, string>;
  spreadsheetId: string;
};

export type SetPartiStatusResponse = {
  ok: boolean;
  partiStatus: "부스터디장" | "스터디원";
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
  name: string;
  heldAmount: number;
  refundAmount: number;
  fineAlreadyPayment: number;
  processedDate: string;
  fineOuter: number;
  depositOuter: number;
  breakdown: DepositRefundBreakdown;
  // "퇴실 프로세스" 섹션(신청일자/예약일자/동의일자)에 쓰인다. 신청 기록
  // 자체가 없으면(직권 P 등 신청 없이 처리하는 경우) null.
  exitProcess: { requestedAt: number | null; exitDate: string | null; agreedAt: number | null } | null;
  // true면 원본이 아니라 sheet_reset 직전 자동 백업 파일(지난 주 시트)에서
  // 이 값을 읽었다는 뜻 — 마지막 참여일이 속한 주의 월요일 새벽 리셋이
  // 이미 지난 뒤 정산 처리를 하는 경우에만 true가 된다.
  fromBackup: boolean;
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

export type LeaveApplyResponse = {
  applied: boolean;
  // 이 요일에 이미 신청된 개수(일반반휴는 0~2, 사유반휴는 0~1).
  count: number;
  // count와 무관하게 시트에 남은 전체 잔여량 — 이 요일에서 더 늘릴 수
  // 있는 최대치는 count + left(단, 유형별 상한 이내)다.
  left: number;
};

export type SetLeaveApplyResponse = {
  ok: true;
  applied: boolean;
  count: number;
};

export type BotStatusResponse = {
  online: boolean;
  roomState: "in_room" | "outside" | null;
  screenshot: string | null;
  recentLogs: string[];
};

export type KvNamespaceStorage = {
  byteCount: number;
  keyCount: number;
} | null;

export type CloudflareUsage = {
  workersRequestsToday: number;
  workersErrorsToday: number;
  kvReadsToday: number;
  kvWritesToday: number;
  kvStorage: {
    reportsKv: KvNamespaceStorage;
    pushSubsKv: KvNamespaceStorage;
  };
};

export type AdminUsageResponse = {
  sheets: {
    readsThisMinute: number;
    readsLastMinute: number;
    writesThisMinute: number;
    writesLastMinute: number;
    readLimitPerMinute: number;
    writeLimitPerMinute: number;
  };
  cloudflare: CloudflareUsage | null;
  cloudflareConfigured: boolean;
  limits: {
    workersRequestsPerDay: number;
    kvReadsPerDay: number;
    kvWritesPerDay: number;
    kvStorageBytes: number;
  };
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

export type ActiveCooldownItem = {
  nickname: string;
  // 이 쿨다운이 풀리는 시각(ms epoch) — 20분 제보 쿨다운 종료 시점.
  expiresAt: number;
};

export type ReportCooldownsResponse = {
  items: ActiveCooldownItem[];
};

export type CaptureReviewItem = {
  id: string;
  nickname: string;
  reason: string;
  mode: "screenshot" | "video";
  reporterEmail: string;
  ts: number;
  reviewStatus: "pending" | "approved" | "rejected";
  // 승인 시 몇 차 슬롯(1~6)에 기록될지 미리 계산된 값. 회원을 찾지 못했거나
  // 슬롯이 모두 찼으면 null.
  nextOccurrence: number | null;
  // 제보자 이메일로 매칭한 이름. 등록 회원이 아니면 null.
  reporterName: string | null;
};

export type CapturesListResponse = {
  items: CaptureReviewItem[];
};

export type OutputPenaltyResult = {
  number: string;
  name: string;
  occurrence: number;
  isPCount: boolean;
  col: string;
  // 화각 요청 회신 지연(20분 초과분)으로 개인 탭 27행에서 차감된 분. 0이면
  // 차감 없음(지연 없었거나 발신/회신 시각을 입력하지 않음).
  deductedMinutes: number;
  // 차감이 기록된 요일 열 문자(A1 표기). deductedMinutes가 0이면 null.
  dayCol: string | null;
};

export type CaptureDecideResponse = {
  ok: boolean;
  penalty?: OutputPenaltyResult | null;
};

export type CaptureDeleteResponse = {
  ok: boolean;
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

export type NotifyCategory =
  | "report_result"
  | "leave_proof_result"
  | "fine_status"
  | "exit_result"
  | "direct_message";

export type NotifyPrefsResponse = {
  categories: Record<NotifyCategory, string>;
  prefs: Record<NotifyCategory, boolean>;
};

export type SetNotifyPrefsResponse = {
  ok: boolean;
  prefs: Record<NotifyCategory, boolean>;
};

export type AdminPushSendCategoryResponse = {
  ok: boolean;
  blocked?: boolean;
  message?: string;
  sent?: number;
};
