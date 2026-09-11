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
  // cycle 쿼리로 지난 사이클을 조회했을 때만 true — 처리 이력(leaveHistory)
  // 스냅샷이라 승인/반려 액션이 없는 읽기 전용 목록임을 프론트에 알린다.
  readOnly?: boolean;
};

export type LeaveProofDecideRequest = {
  id: string;
  decision: "approved" | "rejected";
  memberNumber: string;
  day: string;
  rejectReason?: string;
  count?: 1 | 2;
  // 처리 이력 로그(leaveHistory)에 함께 남기기 위한 표시용 정보 — 목록
  // 화면이 이미 갖고 있는 값을 그대로 넘긴다.
  memberName?: string;
  reason?: string;
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
  // fineUnpaid의 근거가 된 요일("월"~"일") 목록 — 개인 탭 "✅ 납부확인" 행에서
  // "미납"인 요일만 뽑는다. fineUnpaid가 false여도 항상 존재(빈 배열).
  fineUnpaidDays: string[];
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
  // 집계!P6 === "완료"(관리자가 "상금 정산 집행" 버튼을 눌렀는지) 여부.
  // settlement 계산 자체와는 무관하게 별도로 내려온다 — "대상은 계산됐지만
  // 아직 집행 전"과 "이미 집행 완료"를 구분해 표시하는 데 쓴다.
  settlementSettled: boolean;
  // 이 조회가 보여주는 주(월~일)의 시작/종료일, "YYMMDD" — RosterPage
  // 타이틀에 "YYMMDD-YYMMDD 주간 랭킹/정산"으로 병기한다.
  weekStart?: string;
  weekEnd?: string;
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
  // 🔧 [버그 수정, 2026-09] "이번 주"가 이 사이클에서 몇 번째 주인지(1~maxWeeks)
  // — 예전엔 프론트가 weeks.length로 역산했는데, weeks.length는 사이클
  // 경계 판정 결과일 뿐 "이번 주가 몇 주차인지"와 항상 같지 않아 라벨이
  // 틀리는 경우가 있었다. 서버가 집계!D25(페널티 사이클)를 직접 읽어 내려준다.
  currentWeekNumber: number;
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

// 🔧 2026-09: "벌금 납부 대상 처리"(PaidFineList) 요일 헤더의 "직권 P : N건"
// 배지 — 벌금 미납으로 "퇴실 처리 (직권 P)"가 눌려 실제 admin_forced
// 퇴실된 인원을, 그 사람이 미납이었던 요일별로 센 값. 월~일 7개 키 모두
// 항상 포함(0이어도).
export type AdminFinesAdminForcedCountResponse = {
  counts: Record<string, number>;
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

export type PrizeSettleResponse = {
  ok: true;
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
  // cycle 쿼리로 지난 사이클을 조회했을 때만 true — 그 시점 스냅샷이라
  // 강퇴/재납 확정 액션이 잠겨야 함을 프론트에 알린다.
  readOnly?: boolean;
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

// 퇴실 확정 시점에 저장해둔 처리 결과 — ExitPreviewResponse에서 미리보기
// 전용 필드(discountRatio/resultStr/allChecks/exitProcess/fromBackup 등)를
// 뺀 부분집합. "퇴실 스터디원 목록"이 이 값을 그대로 카드로 보여준다.
export type ExitedMemberResult = {
  kind: ExitKind;
  kindStr: string;
  refundAmount: number;
  heldAmount: number;
  fineAlreadyPayment: number;
  breakdown: DepositRefundBreakdown;
  reasons: ExitReasonCode[];
  processedDate: string;
  // 직권 P(admin_forced)로 확정하면서 "블랙리스트로 등록하시겠습니까?"를
  // 체크했는지 — kind가 admin_forced가 아니면 항상 false. 확정 이후에도
  // "퇴실 스터디원 목록"의 토글로 뒤늦게 바꿀 수 있다(POST /admin/exit/blacklist).
  blacklist: boolean;
  // 🔧 2026-09: 확정 처리 시점(D열 초기화 직전)에 뽑아둔 계정 — "신규
  // 스터디원 등록"이 블랙리스트 등록자의 계정 재입력을 감지하는 데 쓰인다
  // (GET /admin/blacklist). 이 기능 도입 이전 처리된 퇴실자는 빈 문자열.
  googleAccount: string;
  gooroomeeAccount: string;
};

export type ExitedMemberEntry = {
  // "다른 회원 보기" 드롭다운과 동일한 형식("exited:{이름} (퇴실)").
  number: string;
  // 백업 탭 이름 그대로("{이름} (퇴실)").
  name: string;
  // 이 기능 도입(2026-09) 이전에 처리된 퇴실자는 저장된 값이 없어 null.
  result: ExitedMemberResult | null;
};

export type AdminExitedMembersResponse = {
  members: ExitedMemberEntry[];
};

export type SetExitBlacklistResponse = {
  ok: boolean;
  name: string;
  blacklist: boolean;
};

// GET /admin/blacklist — "신규 스터디원 등록"이 입력 중인 계정을 대조하는 데
// 쓰는 가벼운 목록. 블랙리스트로 등록된 퇴실자만 담긴다(ExitedMemberResult의
// 부분집합).
export type BlacklistEntry = {
  name: string;
  googleAccount: string;
  gooroomeeAccount: string;
};

export type AdminBlacklistResponse = {
  entries: BlacklistEntry[];
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
  // 🔧 [사용자 지시] list()는 kvReadsToday(read+list 합산)에도 포함되지만,
  // 하루 1,000회라는 더 빡빡한 자체 한도(무료 플랜)를 쓰므로 별도로 표기한다.
  kvListsToday: number;
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
    kvListsPerDay: number;
    kvStorageBytes: number;
  };
  // 🔧 [KV 쓰기/삭제 추적, 화면별 특정] 이 Worker isolate가 최근 30분간
  // 실제로 KV.put/delete를 호출한 (연산·캐시종류·요청경로) 조합별 집계 —
  // 예: [{op:"kv_put", kind:"sheetCache:exitStatus:",
  // path:"/admin/captures", count:5}]. isolate당 근사치라 정확한 하루
  // 총합은 아니다.
  kvWriteBreakdown: { op: string; kind: string; path: string; count: number }[];
  // 🔧 [사용량 모니터링 고도화] 위 kvWriteBreakdown과 달리 "하루(KST 자정
  // 기준) 누적 · 관리자+학생 모두 포함 · Durable Object 영구 저장" 기준이라
  // isolate 재시작에도 유지된다. email은 세션이 없는 요청이면 "(익명)".
  // 최근 5분 이내 발생분은 cron 배치 전이라 아직 반영 안 됐을 수 있다.
  dailyUsage: { path: string; email: string; op: string; count: number }[];
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
  // 제보 고유 id(report_id) — handleReport가 항목 등록 시 이미 함께 저장해
  // 두지만 타입 정의에서 빠져 있었다. 관리자가 같은 대상을 짧은 간격으로
  // 연달아 제보하면(관리자 중복 제보 허용) 같은 nickname의 항목이 여러 개
  // 동시에 존재할 수 있어, React key로 nickname 대신 이 고유 id를 써야 한다.
  id: string;
  nickname: string;
  // 이 쿨다운이 풀리는 시각(ms epoch) — 20분 제보 쿨다운 종료 시점.
  expiresAt: number;
  // 아래 세 필드는 "촬영이 아직 진행 중인지"를 프론트가 판정하는 데 쓴다 —
  // 접수 직후 20분 쿨다운을 바로 보여주는 대신, 봇이 실제 캡처를 끝내기
  // 전까지는 촬영 예상 소요시간으로 카운트다운을 보여주기 위함.
  mode: "screenshot" | "video";
  startedAt: number;
  // 봇이 캡처를 끝내고 Worker에 알리기 전까지는 null.
  capturedAt: number | null;
};

export type ReportCooldownsResponse = {
  items: ActiveCooldownItem[];
};

// 🔧 2026-09: "다른 관리자 의견 반영" 실제 구현 — 부스터디장(공동 검토자,
// 최대 2명)이 제출한 의견. 키는 회원번호, 없으면 아직 제출 안 한 것.
export type CaptureVote = {
  name: string;
  severity: "high" | "mid" | "low" | "none";
  votedAt: number;
};

export type CaptureReviewItem = {
  id: string;
  nickname: string;
  reason: string;
  mode: "screenshot" | "video";
  reporterEmail: string;
  ts: number;
  // 🔧 [3버튼 재설계] "rejected_recognized" — 페널티로는 인정되나 대상자
  // 잔여 슬롯이 없어 등록만 못 하는 경우(제보자 상점은 부여됨).
  // 🔧 [유예] "deferred" — 당일 1회 적용 후 최대 2건 보류(제보자 상점만 부여).
  reviewStatus: "pending" | "approved" | "rejected" | "rejected_recognized" | "deferred";
  // 승인 시 몇 차 슬롯(1~6)에 기록될지 미리 계산된 값. 회원을 찾지 못했거나
  // 슬롯이 모두 찼으면 null.
  nextOccurrence: number | null;
  // 이 제보가 적용될 경우, 이번 사이클의 2/3/5차(경미 벌점) 슬롯이 총 몇
  // 개가 되는지(기존 개수 + 이번 건). "주간 총 상점 -0.X점" 계산에 쓰인다.
  weeklyMinorPenaltyCount: number;
  // 🔧 [유예 조건] 대상자가 오늘 이미 1회 적용(penalty 실제 반영)을 받았으면
  // true — "적용" 버튼 대신 "유예"를 노출해야 한다(사용자 지시, pending
  // 항목에만 계산됨).
  shouldDefer: boolean;
  // 이 건이 당일 몇 번째 유예인지(1 또는 2, MAX_DEFER_PER_DAY=2) —
  // reviewStatus === "deferred"인 확정 건은 실제 유예된 순서, pending +
  // shouldDefer인 예상 건은 "지금 유예하면 몇 번째가 될지"를 담는다.
  // 유예와 무관한 건(아직 판정 전이거나 대상 아님)은 null.
  deferOccurrence: number | null;
  // "유예" 결정 시점에 실제로 읽은 빈 슬롯 차수(1~6) 스냅샷 — nextOccurrence
  // (조회 시점마다 재계산되는 값)와 달리 유예 확정 당시의 값으로 고정된다.
  // 다른 건이 나중에 그 슬롯을 실제로 채워도 이 유예 건의 표시 차수는 바뀌지
  // 않는다. 아직 확정되지 않은(pending) 건이면 null — 이 경우 예상 표시에는
  // 여전히 nextOccurrence를 쓴다.
  deferredOccurrence: number | null;
  // 제보자 이메일로 매칭한 이름. 등록 회원이 아니면 null.
  reporterName: string | null;
  // 🔧 [당사자 응답 시스템] 대상자 본인이 [내 송출 P 제보 확인]에서 제출한
  // 응답 — reviewStatus(관리자 최종 결정)와는 독립적인 별도 필드다. null이면
  // 아직 응답 전(90분 경과 여부와 함께 관리자 화면의 "적용"/"반려" 버튼
  // 활성화 조건에 쓰인다).
  targetResponse: "disputed" | "recognized" | null;
  targetRespondedAt: number | null;
  // 90분 타임아웃으로 자동 위반인정된 건인지 — 대상자가 직접 버튼을 눌러
  // 응답한 것과 "처리현황" 문구를 다르게 보여주기 위함(MyOutputPenItem과
  // 동일 필드).
  targetResponseAuto: boolean;
  votes: Record<string, CaptureVote>;
  // 이 건이 이미 "적용"으로 확정됐다면(reviewStatus === "approved") 그때
  // 실제 시트에 반영된 값(봇 manifest에 저장된 스냅샷) — 새로고침 등으로
  // 이 세션의 로컬 상태(applied[item.id])를 잃은 뒤에도 "확정 차감시간"을
  // 정확히 보여주고 "취소" 버튼이 다시 나타나게 하기 위해 필요하다. 아직
  // 미확정이거나 대상자 페널티 없이 처리된 건(rejected_recognized/deferred)
  // 이면 null.
  penalty: OutputPenaltyResult | null;
  // penalty와 동일한 이유로 함께 내려주는 제보자 상점 스냅샷 — applied 없이도
  // "취소"가 이미 부여된 제보상점을 되돌릴 수 있어야 한다. 실패 기록이면
  // { error: string }.
  merit: ReportMeritResult | { error: string } | null;
  // "유예" 결정에서만 채워진다 — 벌점 슬롯(penalty)은 면제해도 화각 요청
  // 응답 지연에 대한 시간 차감은 별도로 적용되므로(사용자 지시: "유예도
  // 적용만 안 됐을 뿐 확정으로 표시"), 그 확정값을 "확정 차감시간"에
  // 보여주기 위해 필요하다. 지연이 없었거나(20분 이하) 유예가 아니면 null.
  timeDeduction: TimeDeductionResult | null;
};

// "내 화각 점검" 기록 — GET /my-captures가 내려주는 항목. 관리자 목록
// (CaptureReviewItem)과 달리 벌점/페널티 판정 대상이 아니라 nextOccurrence·
// votes 등 판정용 필드가 없다.
export type MyCaptureItem = {
  id: string;
  nickname: string;
  reason: string;
  mode: "screenshot" | "video";
  ts: number;
};

export type MyCapturesResponse = {
  items: MyCaptureItem[];
};

export type MyCaptureDeleteResponse = {
  ok: boolean;
};

// [내 송출 P 제보 확인]에서 "나를 대상으로 한 다른 사람의 제보" —
// GET /my-output-pen이 내려주는 항목. 대상자 본인이 "위반인정"/"이의제기"를
// 제출할 수 있다.
export type MyOutputPenItem = {
  id: string;
  reason: string;
  mode: "screenshot" | "video";
  ts: number;
  reviewStatus: "pending" | "approved" | "rejected" | "rejected_recognized" | "deferred";
  targetResponse: "disputed" | "recognized" | null;
  targetRespondedAt: number | null;
  // 90분 타임아웃으로 자동 위반인정된 건인지 — 대상자가 직접 버튼을 눌러
  // 응답한 것과 처리현황 문구를 다르게 보여주기 위함.
  targetResponseAuto: boolean;
  // 관리자 화면(ReportReviewList)의 "벌점 · 페널티 변동"과 동일한 값을
  // 보여주기 위해 attachNextOccurrence가 계산해 함께 내려주는 필드.
  nextOccurrence: number | null;
  weeklyMinorPenaltyCount: number;
  // 관리자 화면과 동일하게 attachDeferralInfo가 계산해 내려주는 필드 —
  // 이 건이 당일 몇 번째 유예인지(확정된 deferred 건은 실제 순서, pending
  // + 유예 대상 건은 "지금 유예하면 몇 번째가 될지"). 유예와 무관하면 null.
  deferOccurrence: number | null;
  // "유예" 결정 시점에 실제로 읽은 빈 슬롯 차수(1~6) 스냅샷 — nextOccurrence
  // 와 달리 유예 확정 당시의 값으로 고정된다. pending이면 null(예상 표시는
  // nextOccurrence 사용).
  deferredOccurrence: number | null;
  // 이미 확정된 항목이면 봇 manifest에 저장된 실제 값(관리자가 "예상 차감"
  // 대신 확정값을 보여주는 것과 동일한 패턴).
  penalty: OutputPenaltyResult | null;
  merit: ReportMeritResult | { error: string } | null;
  // "유예" 결정에서만 채워지는 시간 차감 확정값(관리자 화면과 동일 — 벌점은
  // 면제돼도 응답 지연 시간 차감은 별도 적용됨).
  timeDeduction: TimeDeductionResult | null;
};

export type MyOutputPenResponse = {
  items: MyOutputPenItem[];
};

export type TargetRespondResponse = {
  ok: boolean;
};

export type CapturesListResponse = {
  items: CaptureReviewItem[];
  // 현재 임명된 부스터디장(공동 검토자) 명단 — 0~2명.
  coReviewers: { number: string; name: string }[];
  // 이 세션이 부스터디장으로서 호출한 경우 자신의 회원번호(item.votes에서
  // "내 제출값"을 찾는 키). 주 관리자로 호출했으면 null.
  myMemberNumber: string | null;
  // 주 관리자(스터디장)로 호출한 경우 회원 명단에서 찾은 본인 이름 —
  // "스터디장 (이름)" 라벨에 쓰인다. 관리자 계정이 회원 명단에 없거나
  // 부스터디장으로 호출한 경우 null.
  myName: string | null;
};

export type CaptureVoteResponse = {
  ok: boolean;
};

export type MyRoleResponse = {
  isCoReviewer: boolean;
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
  // 🔧 [이번 주 영향 스냅샷] 확정 시점의 weeklyMinorPenaltyCount(그 사이클
  // 2/3/5차 슬롯 개수 — 이 건 자신 포함) — "이번 주 영향"이 이후 같은
  // 대상자의 다른 건 처리로 계속 재계산돼 바뀌어 보이지 않도록, 확정된
  // 값을 그대로 고정 표시하는 데 쓴다.
  weeklyMinorPenaltyCount: number;
};

export type ReportMeritResult = {
  number: string;
  name: string;
  // 제보상점 몇 차 슬롯(1~5)에 기록됐는지.
  occurrence: number;
  col: string;
};

// "유예" 결정에서 벌점 슬롯(OutputPenaltyResult)과 별개로 응답 지연 시간
// 차감만 적용됐을 때의 확정값(사용자 지시: 유예도 확인이 늦으면 시간
// 차감은 그대로 받아야 함 — 벌점 면제와 시간 차감은 별개).
export type TimeDeductionResult = {
  number: string;
  deductedMinutes: number;
  dayCol: string | null;
};

export type CaptureDecideResponse = {
  ok: boolean;
  penalty?: OutputPenaltyResult | null;
  // applyReportMerit 실패 시(예: 제보자가 회원이 아니거나 5칸이 이미 다 참)
  // { error: string } 형태로 온다 — 대상자 페널티는 이미 반영됐을 수 있어
  // 자동 롤백하지 않고 관리자에게 알리기만 한다.
  merit?: ReportMeritResult | { error: string } | null;
  // decision === "deferred"일 때만 채워진다(응답 지연 시간 차감).
  timeDeduction?: TimeDeductionResult | null;
};

export type CaptureDeleteResponse = {
  ok: boolean;
};

export type CaptureRevertResponse = {
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

// 참여자가 [설정]에 등록해두는 자유 텍스트 — [제보] 대상자 선택 시 노출돼
// 오해로 인한 제보를 줄이는 용도(사용자 요청).
export type StatusMessageResponse = {
  message: string;
};

export type SetStatusMessageResponse = {
  ok: boolean;
  message: string;
};

export type AdminPushSendCategoryResponse = {
  ok: boolean;
  blocked?: boolean;
  message?: string;
  sent?: number;
};
