// 프레임 체커 제보 API — Cloudflare Worker
//
// 엔드포인트
//   POST /verify   { credential: <Google ID Token> } -> { token, name, email }
//   POST /report   { token, nickname, reason } -> { ok: true }
//   GET  /reports  (Bot-Secret 헤더 필요) -> [{ id, nickname, reason, reporterEmail, ts }, ...]
//
// 인증 흐름
//   1. 브라우저가 Google Identity Services로 로그인 -> ID Token(credential) 획득
//   2. Worker가 Google의 공개키로 ID Token 서명을 검증하고 이메일 추출
//   3. 그 이메일이 구글 시트 "열람 권한" 목록에 있는지 대조
//   4. 있으면 서버가 서명한 세션 토큰 발급 (HMAC-SHA256, 24시간 만료)
//   5. 이후 /report 호출 시 이 세션 토큰을 다시 검증

// 🔧 [구조 개선, 2026-09-13] Durable Object 클래스 8개는 src/durable-objects.js로
// 분리했다(docs/TESTING.md 참고) — wrangler.toml의 durable_objects.bindings가
// main 파일(이 파일)의 named export를 찾으므로 아래에서 재export한다.
import {
  ParticipantsRoster,
  UsageStats,
  ReportQueue,
  LeaveQueue,
  getLeaveQueueStub,
  ReportVote,
  MemberSettingsDO,
  PushSubscriptionsDO,
  BotAdminConfigDO,
} from "./durable-objects.js";
export {
  ParticipantsRoster,
  UsageStats,
  ReportQueue,
  LeaveQueue,
  getLeaveQueueStub,
  ReportVote,
  MemberSettingsDO,
  PushSubscriptionsDO,
  BotAdminConfigDO,
};

// 🔧 [구조 개선, 2026-09-13] 캐시 인프라는 src/cache.js로 옮겼다 — 이
// wrapper들만 외부에서 호출되므로(docs/TESTING.md 참고) 재export는
// 불필요하다(테스트가 직접 import하지 않음).
// 🔧 [버그 수정, 2026-09-13] invalidatePersonalStatusCache/KV_CACHE_PREFIX는
// 원래 index.js 로컬이었다가 이 함수가 참조하는 _sheetCache 등이 1차
// 분리 때 cache.js로 옮겨지며 정의되지 않은 심볼을 참조하는 실제
// 프로덕션 버그가 됐다(6차 fines.js 통합 테스트로 발견) — 이제
// invalidatePersonalStatusCache 자체도 cache.js로 옮기고 여기서 import한다.
// 🔧 [버그 수정, 17차] MEMBER_CACHE_GROUPS도 마찬가지로 cache.js에
// export 없이 정의만 되어 있었는데 handleBotInvalidateCache가 참조하고
// 있어, 이 엔드포인트를 실제로 호출하면 ReferenceError로 500이 나는
// 프로덕션 버그였다 — export 추가 + import로 해결.
import {
  _cachedCompute,
  invalidateMemberCache,
  invalidateMemberSlotCache,
  invalidatePersonalStatusCache,
  KV_CACHE_PREFIX,
  MEMBER_CACHE_GROUPS,
  fetchSheetsApiWithRetry,
} from "./cache.js";

// 🔧 [구조 개선, 2026-09-13] 순수 날짜/시간 유틸은 src/date-utils.js로
// 옮겼다 — 테스트가 직접 import하는 6개(currentWeekMondayKST/formatYYMMDD/
// kstDateKey/exitDateMidnightUtcMs/weekOfForDate/exitWeekResetPassed)는
// 재export한다(docs/TESTING.md 참고).
import {
  formatISODate,
  todayKSTDateString,
  todayUTCDateString,
  kstDateOffsetString,
  currentWeekMondayKST,
  formatYYMMDD,
  kstDateKey,
  exitDateMidnightUtcMs,
  weekOfForDate,
  exitWeekResetPassed,
} from "./date-utils.js";
export {
  currentWeekMondayKST,
  formatYYMMDD,
  kstDateKey,
  exitDateMidnightUtcMs,
  weekOfForDate,
  exitWeekResetPassed,
  todayKSTDateString,
};

// 🔧 [구조 개선, 2026-09-13] 완전 순수한 사이클 판정 함수는 src/cycle.js로
// 옮겼다 — cycle.js가 FINE_UNPAID_ADMIN_FORCED_REASON을 이 파일에서
// import하므로(위 export const 선언 참고) 여기서 다시 cycle.js를
// import하는 것은 순환이지만, 재export 목적뿐이라 TDZ 위험이 없다
// (docs/TESTING.md 참고).
import {
  requiresFineUnpaidRecheck,
  isUnguardedAdminForcedCycleCombo,
  compareWeekOfDesc,
  currentCycleBackups,
  listBackupFiles,
  listCurrentCycleBackups,
  resolveTargetFileId,
  resolveTargetFileIdForAnyBackup,
  resolveExitSourceFileId,
  resolveCaptureSourceFileId,
  handleCycleList,
  handleAdminCycleGroups,
} from "./cycle.js";
export {
  requiresFineUnpaidRecheck,
  isUnguardedAdminForcedCycleCombo,
  compareWeekOfDesc,
  currentCycleBackups,
  listBackupFiles,
  listCurrentCycleBackups,
  resolveTargetFileId,
  resolveTargetFileIdForAnyBackup,
  resolveExitSourceFileId,
  resolveCaptureSourceFileId,
};

// 🔧 [구조 개선, 2026-09-13] 예치금 반환/강제퇴실/정산 판정 핵심부는
// src/deposit.js로 옮겼다 — deposit.js가 이 파일의 safeNumber/STATUS_DAYS
// 등 시트 레이아웃 상수를 import하므로(아래 export 선언 참고) 순환이지만
// 재export 목적뿐이라 TDZ 위험이 없다(cycle.js와 동일 패턴).
import {
  countCurrentCyclePen,
  depositRefundBreakdown,
  forcedExitChecks,
  calcForcedOutDeposit,
  calcExitProcess,
  totalPenaltyBreakdown,
} from "./deposit.js";
export {
  countCurrentCyclePen,
  depositRefundBreakdown,
  forcedExitChecks,
  calcForcedOutDeposit,
  calcExitProcess,
  totalPenaltyBreakdown,
};

// 🔧 [구조 개선, 2026-09-13] "Date.now() 기반 KST 시각 경계 판정" 함수는
// src/exit-timing.js로 옮겼다 — 둘 다 완전히 독립적이라 순환 없음.
import { isSettlementVisibleToMembers, exitDateSettled } from "./exit-timing.js";
export { isSettlementVisibleToMembers, exitDateSettled };

// 🔧 [구조 개선, 2026-09-13] 회원 관리/알림·푸시 도메인의 완전 순수 함수
// 4개는 src/pure-utils.js로 옮겼다(18차에서 member-utils.js → pure-utils.js
// 로 리네임 — 회원 계정 파싱/웹푸시 암호화 보조/알림 기본값 세 영역이
// 섞인 잡동사니 유틸 파일이라 "member"라는 이름이 실제 내용을 대표하지
// 못한다는 17차 구조 감사 지적을 반영). pure-utils.js가 이 파일의
// base64url/base64urlToBytes/NOTIFY_CATEGORIES를 import하므로(아래 export
// 선언 참고) 순환이지만 재export 목적뿐이라 TDZ 위험이 없다.
// index.js 다른 함수(handleAdminCreateMember 등)가 그대로 참조하므로
// 재export는 불필요하다 — 테스트가 필요하면 ../src/pure-utils.js에서
// 직접 import.
import {
  parseGoogleEmail,
  parseGooroomeeAccount,
  guessDeviceLabel,
  defaultNotifyPrefs,
} from "./pure-utils.js";

// 🔧 [구조 개선, 2026-09-13] 웹푸시 암호화/발송 함수 7개는
// src/push-crypto.js로 옮겼다(buildVapidJwk/concatBytes를 import해
// 씀 — pure-utils.js에서 직접 가져오므로 index.js 경유 불필요).
// sendWebPush만 index.js 내 3곳(관리자 발송 핸들러)에서 직접 호출하므로
// 그것만 import한다 — 재export는 불필요(테스트가 필요하면
// ../src/push-crypto.js에서 직접 import).
import { sendWebPush } from "./push-crypto.js";

// 🔧 [구조 개선 6차, 2026-09-13] 벌금/납부 처리 도메인(조회 함수 4개 +
// 핸들러 4개)을 src/fines.js로 옮겼다 — 1~5차의 순수 함수 분리와 달리
// 이번엔 fetch mock 기반 통합 테스트로 안전망을 먼저 깐 뒤 fetch 의존
// 함수를 통째로 옮긴 첫 사례다. fines.js가 이 파일의 json/listAllMembers
// 등 범용 유틸을 import하므로(위 export 선언들 참고) 순환이지만,
// 4개 핸들러는 라우팅 테이블이 직접 호출하므로 함께 import한다.
// 🔧 [구조 개선 9차] listUnpaidFines를 실사용하던 hasUnpaidFineInCycle이
// cycle.js로 옮겨가면서, index.js는 더 이상 이 함수를 직접 쓰지 않는다.
// 🔧 [구조 개선 18차] handleAdminFinesAdminForcedCount도 이 파일로
// 옮겼다 — exit.js 8차 주석이 이미 "벌금 도메인"이라고 인지했던
// 함수를 17차 구조 감사에서 재확인해 이동했다.
import {
  handleAdminFinesUnpaid,
  handleAdminFinesPaid,
  handleAdminFinesExempt,
  handleAdminFineStatus,
  handleAdminFinesAdminForcedCount,
} from "./fines.js";

// 🔧 [구조 개선 7차, 2026-09-13] 회원 관리(CRUD/번호 재배치) 도메인을
// src/members.js로 옮겼다(docs/TESTING.md 참고). listAllMembers는
// fines.js가 여전히 이 파일에서 import하므로 재export가 필요하다
// (아래 export 선언 참고) — 6차의 listUnpaidFines와 동일한 패턴.
// 🔧 [구조 개선 16차, 2026-09-17] handleAdminMembersRoster도 이 파일로
// 옮겼다 — 라우팅 테이블에서만 호출되는 단순 연결이라 재export는
// 불필요하다.
import {
  listAllMembers,
  handleAdminMembers,
  handleAdminMembersRoster,
  handleAdminSetPartiStatus,
  handleAdminOpenSlots,
  handleAdminMemberReorderPreview,
  handleAdminMemberReorder,
  handleAdminCreateMember,
  handleGrantMemberAccess,
} from "./members.js";
export { listAllMembers };

// 🔧 [구조 개선 8차, 2026-09-13] 퇴실 처리 도메인을 src/exit.js로
// 옮겼다(docs/TESTING.md 참고).
// 🔧 [구조 개선 9차] listExitCandidates를 실사용하던 hasForcedCandidateInCycle이
// cycle.js로 옮겨가면서, index.js는 더 이상 이 함수를 직접 쓰지 않는다.
// 🔧 [구조 개선 16차] listActiveMembersWithExitInfo를 실사용하던
// handleAdminMembersRoster가 members.js로 옮겨가면서, index.js는
// 더 이상 이 함수를 직접 쓰지 않는다(members.js가 exit.js에서 직접 import).
// 🔧 [구조 개선 21차, 2026-09-17] exit.js를 다시 신청(exit-request.js)/
// 후보 판정(exit-candidates.js)/확정 실행(exit-confirm.js) 세 파일로
// 나눴다(docs/TESTING.md 참고) — 라우팅 테이블에서 각 파일 함수를 그대로
// 호출하므로 import 출처만 바뀌었다.
import {
  handleSetExitRequest,
  handleAgreeExitRequest,
  handleCancelExitRequest,
  handleBotExitRequests,
  autoAgreeExpiredExitRequests,
} from "./exit-request.js";
import {
  handleAdminExitedMembers,
  handleAdminExitCandidates,
  handleAdminExitBlacklist,
  handleAdminBlacklist,
} from "./exit-candidates.js";
import {
  handleAdminExitPreview,
  handleAdminExitConfirm,
} from "./exit-confirm.js";

// 🔧 [구조 개선 10차, 2026-09-13] 알림/푸시 도메인을 src/notify.js로
// 옮겼다(docs/TESTING.md 참고). 다른 도메인 파일을 실사용하지 않는
// 순환 없는 잎(leaf) 도메인이라 별도 재export가 필요 없다.
import {
  handleGetNotifyPrefs,
  handleSetNotifyPrefs,
  handleGetStatusMessage,
  handleSetStatusMessage,
  handleGetMemberStatusMessage,
  handleAdminPushSendCategory,
  handlePushSubscribe,
  handleListPushDevices,
  handlePushDeviceToggle,
  handlePushDeviceRename,
  handlePushDeviceRemove,
  handlePushSendTest,
  handlePushSubscriptionStatus,
  handlePushSendToMember,
  handleListRecentNotices,
} from "./notify.js";

// 🔧 [구조 개선 11차, 2026-09-13] 사유반휴/일반반휴 도메인을 src/leave.js로
// 옮겼다(docs/TESTING.md 참고).
// 🔧 [구조 개선 13차] flushQueuedReasonLeaveProofs는 handleBotRegisterUrl과
// 함께 src/bot.js로 옮겨져, 이제 index.js가 아니라 bot.js가 leave.js에서
// 직접 import한다.
// 🔧 [구조 개선 15차] listQueuedReasonLeaveDays는 buildPersonalStatus와
// 함께 src/personal-status.js로 옮겨져, 이제 index.js가 아니라
// personal-status.js가 leave.js에서 직접 import한다.
import {
  handleGetLeaveApply,
  handleSetLeaveApply,
  handleAdminLeaveApply,
  handleGetReasonLeaveProof,
  handleSetReasonLeaveProof,
  handleCancelReasonLeaveProof,
  handleAdminLeaveProofList,
  handleAdminLeaveProofFile,
  handleAdminLeaveProofDecide,
} from "./leave.js";

// 🔧 [구조 개선 12차, 2026-09-13] 제보/캡처 도메인을 src/report.js로
// 옮겼다(docs/TESTING.md 참고).
// 🔧 [구조 개선 20차, 2026-09-17] report.js를 다시 접수/검토/벌점반영
// 세 파일로 나눴다(17차 구조 감사가 놓친 "이미 분리된 대형 파일 내부"를
// 재조사한 결과) — 라우팅 테이블에서 각 파일 함수를 그대로 호출하므로
// import 출처만 바뀌었다. applyAutoRecognitionForExpired는
// scheduled(cron 핸들러, 이 파일 잔류)가 실사용하므로 재export가 아니라
// 9~11차와 동일한 실사용 import 패턴으로 report-review.js에서 가져온다.
import {
  handleReport,
  handleListActiveCooldowns,
  handleReportCaptureDone,
  handleListReports,
  handleRequeueReport,
} from "./report-intake.js";
import {
  handleAdminCapturesList,
  handleMyCaptures,
  handleMyCaptureDelete,
  handleMyOutputPen,
  handleCaptureTargetRespond,
  handleAdminCaptureFile,
  handleAdminCaptureVote,
  applyAutoRecognitionForExpired,
} from "./report-review.js";
import {
  handleReportStatus,
  handleAdminCaptureDecide,
  handleAdminCaptureCancel,
  handleAdminCaptureCancelMerit,
  handleAdminCaptureDelete,
  handleAdminCaptureRevert,
} from "./report-penalty.js";

// 🔧 [구조 개선 13차, 2026-09-13] 봇 상태/사용량 도메인을 src/bot.js로
// 옮겼다(docs/TESTING.md 참고). 이 6개 함수는 모두 라우팅 테이블에서만
// 호출되고 index.js의 다른 함수가 실사용하는 지점은 없어 재export도
// 실사용 import도 아닌 단순 라우팅 연결이다.
import {
  handleBotRegisterUrl,
  handleBotSheetsUsageReport,
  handleInternalCycleBoundary,
  handleAdminUsageStatus,
  handleAdminBotStatus,
  handleAdminBotCommand,
} from "./bot.js";

// 🔧 [구조 개선 14차, 2026-09-13] 로그인/OAuth 도메인을 src/auth.js로
// 옮겼다(docs/TESTING.md 참고). 이 4개 함수도 라우팅 테이블에서만
// 호출되고 index.js의 다른 함수가 실사용하는 지점은 없다.
import {
  handleVerify,
  handleDevLogin,
  handleAdminOAuthAuthorize,
  handleAdminOAuthCallback,
} from "./auth.js";

// 🔧 [Stream Chat 도입, 2026-09-19] "관리자-회원 1:1 문의방" 채팅 기능 —
// 이 프로젝트 세션을 통과한 사용자에게 Stream Chat용 토큰을 발급하는
// 다리 역할만 한다(docs/TESTING.md 참고 예정).
import { handleChatToken, handleChatEnsureUser, handleChatConfigureUploads } from "./chat.js";

// 🔧 [구조 개선 15차, 2026-09-17] 개인 대시보드/랭킹 클러스터를
// src/personal-status.js로 옮겼다(docs/TESTING.md 참고). buildPersonalStatus는
// exit.js가 이미 `from "./index.js"`로 import하고 있어, 재export가
// 필요하다(3차 deposit.js와 동일한 패턴) — personal-status.js가 이 파일의
// parseWon/safeNumber/ROW_*류 상수를 가져가므로 순환이지만, 재export
// 목적뿐이거나(buildPersonalStatus) 함수 선언(호이스팅되어 안전)이라
// TDZ 위험이 없다. GOAL_TYPE_MULTIPLIER는 이 파일의 GOAL_TIME_VALID_VALUES가
// 실사용 import한다(재export는 아무도 안 써서 17차에서 제거 — 순수
// 객체 리터럴이라 TDZ 위험 없음, 11차 교훈: 다른 모듈의 값을 즉시
// 참조하는 경우에만 위험한데 이건 그런 참조가 없다).
import {
  handleStatus,
  handleAdminMemberStatus,
  buildPersonalStatus,
  GOAL_TYPE_MULTIPLIER,
} from "./personal-status.js";
export { buildPersonalStatus };

// 🔧 [구조 개선 19차, 2026-09-17] 랭킹/로스터/정산 클러스터를
// src/roster-status.js로 옮겼다(docs/TESTING.md 참고) — 라우팅
// 테이블에서만 호출되는 단순 연결이라 재export는 불필요하다.
import { handleRosterStatus, handleAdminPrizeSettle } from "./roster-status.js";

export function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Bot-Secret",
    "Access-Control-Max-Age": "86400",
  };
}

export function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

export function base64url(bytes) {
  let str = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlToBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signSession(payload, secret) {
  const key = await hmacKey(secret);
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${base64url(sig)}`;
}

export async function verifySession(token, secret) {
  const [body, sig] = (token || "").split(".");
  if (!body || !sig) return null;
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64urlToBytes(sig),
    new TextEncoder().encode(body)
  );
  if (!valid) return null;
  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(body)));
  if (payload.exp < Date.now() / 1000) return null;
  return payload;
}

// --- 구글 시트 열람 권한 목록 조회 (서비스 계정) ---

// 서비스 계정 액세스 토큰은 1시간 유효하므로, 발급 후 55분간 재사용해
// 매 /status 요청마다 Google OAuth 서버를 왕복하는 것을 피한다.
let cachedAccessToken = null;
let cachedAccessTokenAt = 0;
const ACCESS_TOKEN_CACHE_MS = 55 * 60 * 1000;

export async function getServiceAccountAccessToken(env) {
  if (cachedAccessToken && Date.now() - cachedAccessTokenAt < ACCESS_TOKEN_CACHE_MS) {
    return cachedAccessToken;
  }

  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope:
      "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const encHeader = base64url(new TextEncoder().encode(JSON.stringify(header)));
  const encClaim = base64url(new TextEncoder().encode(JSON.stringify(claim)));
  const signInput = `${encHeader}.${encClaim}`;

  const pemBody = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const keyBytes = base64urlToBytesStd(pemBody);

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signInput)
  );

  const jwt = `${signInput}.${base64url(sig)}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error("서비스 계정 인증 실패: " + JSON.stringify(tokenData));

  cachedAccessToken = tokenData.access_token;
  cachedAccessTokenAt = Date.now();
  return cachedAccessToken;
}

function base64urlToBytesStd(std) {
  const bin = atob(std);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// --- 관리자 위임 OAuth (Drive 파일 공유는 서비스 계정으로 불가능해서 필요) ---
// 개인 Gmail 정책상 서비스 계정(파일 소유자가 아님)은 다른 사용자를 편집자로
// 초대(공유)할 권한이 없다("Sorry, you do not have permission to share").
// 그래서 시트 소유자(관리자)가 1회 OAuth 동의를 거쳐 발급한 refresh_token을
// 보관해두고, Drive 편집자 추가가 필요할 때만 그 토큰으로 위임 호출한다.
// 🔧 [KV → DO 이전, 2026-09-12] §49 — BotAdminConfigDO로 이전.
export const ADMIN_OAUTH_CONFIG_KEY = "adminOAuthRefreshToken";
const ADMIN_OAUTH_REDIRECT_PATH = "/oauth/callback";
export const ADMIN_OAUTH_SCOPE = "https://www.googleapis.com/auth/drive";

export function adminOAuthRedirectUri(env) {
  return (env.ADMIN_OAUTH_BASE_URL || "https://frame-checker-worker.comstralo.workers.dev") + ADMIN_OAUTH_REDIRECT_PATH;
}

export async function exchangeAdminOAuthCode(env, code) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.ADMIN_OAUTH_CLIENT_ID,
      client_secret: env.ADMIN_OAUTH_CLIENT_SECRET,
      redirect_uri: adminOAuthRedirectUri(env),
      grant_type: "authorization_code",
    }),
  });
  const data = await res.json();
  if (!data.refresh_token) throw new Error("refresh_token 발급 실패: " + JSON.stringify(data));
  return data;
}

// 서비스 계정 토큰과 동일하게, 관리자 위임 토큰도 55분간 캐싱한다.
// grantSheetAccess/revokeSheetAccess가 신규 등록·퇴실 처리마다 각각 이
// 함수를 호출하는데, 캐싱 없이는 매번 Google OAuth 토큰 엔드포인트를
// 새로 왕복하게 된다(Sheets API 쿼터와는 무관하지만 불필요한 지연).
let cachedAdminAccessToken = null;
let cachedAdminAccessTokenAt = 0;

export async function getAdminAccessToken(env) {
  if (cachedAdminAccessToken && Date.now() - cachedAdminAccessTokenAt < ACCESS_TOKEN_CACHE_MS) {
    return cachedAdminAccessToken;
  }
  const refreshTokenRes = await getBotAdminConfigStub(env).fetch(`https://do/config?key=${ADMIN_OAUTH_CONFIG_KEY}`);
  const { value: refreshToken } = await refreshTokenRes.json();
  if (!refreshToken) {
    throw new Error("관리자 위임 인증이 아직 설정되지 않았습니다. /oauth/authorize로 먼저 연동해주세요.");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.ADMIN_OAUTH_CLIENT_ID,
      client_secret: env.ADMIN_OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("관리자 위임 토큰 갱신 실패: " + JSON.stringify(data));
  cachedAdminAccessToken = data.access_token;
  cachedAdminAccessTokenAt = Date.now();
  return data.access_token;
}

// 🔧 [사용량 모니터링] Sheets API 호출을 분 단위로 세어 "Bot·Sheet" 탭에서
// 무료 할당량(분당 60회 읽기/쓰기) 대비 현재 사용량을 보여주기 위한 계측.
// KV에 호출마다 쓰면 그 자체가 KV 쓰기 할당량(하루 1,000회)을 금방 태우니,
// 인메모리(모듈 스코프)에만 분 단위로 누적하고 관리자가 실제로 조회할 때만
// 값을 읽는다 — 같은 Worker isolate가 살아있는 동안만 유효한 근사치이지만
// (콜드스타트 시 리셋), "지금 이 순간 위험 수준인지"를 보는 용도로는 충분하다.
const _usageCounters = new Map(); // "sheets_read:2026-08-27T12:34" -> count

export function _bumpUsageCounter(kind) {
  const minuteKey = new Date().toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
  const key = `${kind}:${minuteKey}`;
  _usageCounters.set(key, (_usageCounters.get(key) || 0) + 1);
  // 오래된 분 버킷은 청소한다 — 지난 5분만 유지하면 충분하다(분당 카운트만 필요).
  if (_usageCounters.size > 200) {
    const cutoff = Date.now() - 5 * 60_000;
    for (const k of _usageCounters.keys()) {
      const ts = k.slice(k.indexOf(":") + 1);
      if (new Date(ts + ":00Z").getTime() < cutoff) _usageCounters.delete(k);
    }
  }
}

export function _getUsageCounter(kind, minutesAgo = 0) {
  const d = new Date(Date.now() - minutesAgo * 60_000);
  const minuteKey = d.toISOString().slice(0, 16);
  return _usageCounters.get(`${kind}:${minuteKey}`) || 0;
}

// 🔧 [사용자 지시] "해당 로그를 남겨서 어디서 누수가 발생하는지 아니면
// 기분탓인건지 알 수 있도록 해줘" → "어느 화면에서 어떤 기능에 의해
// 쓰기·삭제가 주기적으로 발생하는지 확인할 수 있도록, 좀 더 확실하게
// 원인을 알고 싶어" — 처음엔 "어떤 캐시 종류"(kind)까지만 구분했는데,
// "어느 화면"까지 특정하려면 그 KV 호출이 어느 API 요청 처리 중
// 일어났는지(요청 경로)도 함께 남겨야 한다. 58곳에 흩어진 개별
// env.REPORTS_KV.put/delete 호출부를 일일이 계측 코드로 바꾸는 대신,
// fetch 핸들러 진입 시 env.REPORTS_KV 자체를 이 얇은 프록시로 한 번만
// 감싸 이후의 모든 호출을 자동으로 잡는다(호출부 수정 0건) — 그 프록시를
// 만들 때 현재 요청의 url.pathname을 클로저로 넘겨받아 매 호출마다 함께
// 기록한다.
const KV_USAGE_WINDOW_MIN = 30;

// 🔧 [사용량 모니터링 고도화, 2026-09-11] "하루 동안, 어느 메뉴에서, 어느
// 사용자에 의해"까지 보려면 이 버퍼가 필요하다 — 5분 cron(scheduled)이
// UsageStats Durable Object로 배치 전송(flushDailyUsageStats)한 뒤 비우는
// 임시 중계소일 뿐이다. 매 KV 호출마다 DO에 실시간 전송하면 "감시 기능이
// 감시 대상 KV 할당량을 갉아먹는" 역설이 생기므로, DO에도 배치로만
// 보낸다(DO 자체는 KV 할당량과 무관하지만 오버헤드 자체를 줄이는 목적).
const _dailyUsageBuffer = new Map(); // "{date}|{kind}|{path}|{email}|{op}" -> count

// 🔧 [사용자 지시] "일일 중에서 30분내로 발생한것만 추려서 보여주면
// 되잖아" — 원래는 isolate 로컬 메모리(_kvUsageCounters)로 "최근 30분"을
// 별도 집계했는데, Cloudflare가 요청을 여러 서버로 분산 처리하면 한
// isolate가 직접 겪은 것만 보여 "일일"보다 훨씬 적게 보이는 구조적
// 한계가 있었다. 이제 위 _dailyUsageBuffer와 동일하게 DO로 배치
// 전송하되, DO 쪽에 분단위 키로 따로 저장해두고 "그중 최근 30분 것만"
// 필터링해 보여준다(§UsageStats DO의 /flush-recent, /recent) — isolate
// 무관하게 항상 완전한 값이 나온다.
const _minuteUsageBuffer = new Map(); // "{minuteKey}|{kind}|{path}|{email}|{op}" -> count

// 🔧 [사용자 지시] "이메일 말고 사용자 이름을 적고" — 집계 키(_dailyUsageBuffer/
// _minuteUsageBuffer/UsageStats DO)는 계속 email을 유일 식별자로 쓰되(이름은
// 동명이인 가능성이 있어 키로 부적합), 화면에 보여줄 때만 이름으로 바꿔
// 치환할 수 있도록 세션에 이미 담겨 있는 memberName(로그인 시점에 회원
// 시트에서 조회해 고정된 값 — 별도 시트 재조회 불필요)을 email과 함께
// 기억해둔다. isolate 재시작 시 비워져도 무해(그 경우 이메일로 대체 표시).
export const _emailNameMap = new Map(); // email -> memberName

// 🔧 [사용자 지시] "여기 이메일로 보이는데?" — _emailNameMap이 isolate
// 로컬이라 "이 요청을 처리한 isolate가 그 사용자를 아직 못 봤으면"
// 이메일 그대로 보이는 문제가 있었다. 새로 관측된 (email, name) 쌍만
// 여기 모아뒀다가 flushDailyUsageStats가 DO(UsageStats)에도 영구
// 저장해, 어느 isolate가 응답을 만들든 DO의 전체 매핑을 참조할 수
// 있게 한다.
const _pendingNameFlush = new Map(); // email -> memberName (아직 DO로 안 보낸 것만)

function _bumpKvUsageCounter(op, prefix, path, email, name) {
  if (email && name && _emailNameMap.get(email) !== name) {
    _emailNameMap.set(email, name);
    _pendingNameFlush.set(email, name);
  }
  const minuteKey = new Date().toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"

  // 🔧 [사용자 지시] "일일에서도 - 뒤에 캐시 유발 지점을 출력해줘" —
  // kind(캐시 키 종류)도 하루 누적 키에 포함시켜, "30분" 뷰와 마찬가지로
  // 어떤 캐시가 원인인지 바로 알 수 있게 한다.
  const dailyKey = `${todayUTCDateString()}|${prefix}|${path || "(cron/기타)"}|${email || "(익명)"}|${op}`;
  _dailyUsageBuffer.set(dailyKey, (_dailyUsageBuffer.get(dailyKey) || 0) + 1);

  const minuteBucketKey = `${minuteKey}|${prefix}|${path || "(cron/기타)"}|${email || "(익명)"}|${op}`;
  _minuteUsageBuffer.set(minuteBucketKey, (_minuteUsageBuffer.get(minuteBucketKey) || 0) + 1);
}

// "최근 5분간 kv_put:sheetCache:9 라고 찍혀" — 콜론 1개까지만 잘라
// 접두사를 만들면 sheetCache:exitStatus:.../sheetCache:memberRows:... 등
// 서로 다른 캐시 키 종류가 전부 "sheetCache:" 하나로 뭉뚱그려진다.
// sheetCache:(KV_CACHE_PREFIX)로 시작하는 키만 특별 취급해 그 다음
// 세그먼트(캐시 키 종류: exitStatus/memberRows/outputPenSlots 등)까지
// 포함해 두 번째 콜론까지 자른다 — 나머지(report:/leaveq:/exitRequest:
// 등)는 원래대로 첫 콜론까지만.
function _kvKeyPrefix(key) {
  const idx = key.indexOf(":");
  if (idx === -1) return key;
  const firstPrefix = key.slice(0, idx + 1);
  if (firstPrefix !== KV_CACHE_PREFIX) return firstPrefix;
  const secondIdx = key.indexOf(":", idx + 1);
  return secondIdx === -1 ? key : key.slice(0, secondIdx + 1);
}

// 🔧 [사용량 모니터링 고도화, 2026-09-11] requestEmail은 fetch 최상단에서
// 딱 한 번 선제적으로 verifySession한 결과다(§fetch 진입부 주석 참고) —
// 각 핸들러 내부의 실제 권한 판정(requireAdmin 등)과는 별개로, "누가
// 이 KV 호출을 유발했는지" 집계용으로만 쓰인다.
function instrumentKvNamespace(kv, requestPath, requestEmail, requestName) {
  return {
    ...kv,
    get: kv.get.bind(kv),
    getWithMetadata: kv.getWithMetadata ? kv.getWithMetadata.bind(kv) : undefined,
    // 🔧 [사용량 모니터링에 list() 추가] KV list()는 무료 플랜 하루
    // 1,000회 한도가 있고(put/delete와는 별도 할당량), 2026-08-27 실제로
    // 소진된 이력이 있다(leaveq:/report: 등을 인덱스 방식으로 리팩터링한
    // 계기) — put/delete와 동일하게 (prefix, 요청 경로)별로 세어 "Bot·Sheet"
    // 탭에서 어느 화면이 list()를 얼마나 자주 쓰는지 보이게 한다.
    list(opts) {
      const prefix = _kvKeyPrefix((opts && opts.prefix) || "(전체)");
      _bumpKvUsageCounter("kv_list", prefix, requestPath, requestEmail, requestName);
      console.log(`[kv list] path=${requestPath || "(cron/기타)"} prefix=${(opts && opts.prefix) || "(전체)"}`);
      return kv.list(opts);
    },
    put(key, value, opts) {
      const prefix = _kvKeyPrefix(key);
      _bumpKvUsageCounter("kv_put", prefix, requestPath, requestEmail, requestName);
      console.log(`[kv put] path=${requestPath || "(cron/기타)"} key=${key}`);
      return kv.put(key, value, opts);
    },
    delete(key) {
      const prefix = _kvKeyPrefix(key);
      _bumpKvUsageCounter("kv_delete", prefix, requestPath, requestEmail, requestName);
      console.log(`[kv delete] path=${requestPath || "(cron/기타)"} key=${key}`);
      return kv.delete(key);
    },
  };
}

// 🔧 [사용자 지시] "알아먹기 쉽게 실제 메뉴명을 적어줘" — API 경로 그대로
// 보여주던 걸, 프론트 각 화면 컴포넌트가 실제로 그 경로를 호출하는 이름
// (docs/CACHING_POLICY.md §12.2의 화면↔엔드포인트 매핑과 동일 기준)으로
// 바꿔 보여준다. 매핑에 없는 경로(신규 추가분 등)는 원래 경로를 그대로
// 보여줘 정보 유실이 없게 한다.
const _PATH_MENU_NAMES = {
  "/status": "내 대시보드",
  "/admin/usage": "사용량 모니터링",
  "/admin/bot/status": "도움봇 오퍼레이터",
  "/admin/bot/command": "도움봇 오퍼레이터",
  "/admin/members/roster": "참여 스터디원 목록",
  "/admin/members/parti-status": "참여 스터디원 목록",
  "/admin/members/reorder": "번호 정렬",
  "/admin/members/reorder-preview": "번호 정렬",
  "/admin/members": "신규 스터디원 등록",
  "/admin/blacklist": "신규 스터디원 등록",
  "/admin/open-slots": "신규 스터디원 등록",
  "/admin/members/grant-access": "신규 스터디원 등록",
  "/admin/captures": "화각 불량 제보 처리",
  "/admin/captures/decide": "화각 불량 제보 처리",
  "/admin/captures/delete": "화각 불량 제보 처리",
  "/admin/captures/revert": "화각 불량 제보 처리",
  "/admin/captures/vote": "화각 불량 제보 처리",
  "/admin/captures/cancel-penalty": "화각 불량 제보 처리",
  "/admin/captures/cancel-merit": "화각 불량 제보 처리",
  "/admin/captures/file": "화각 불량 제보 처리",
  "/my-output-pen": "내 제보 확인",
  "/captures/target-respond": "내 제보 확인",
  "/my-captures/delete": "내 제보 확인",
  "/roster-status": "RANK",
  "/admin/fines/status": "PEN · Money",
  "/admin/fines/admin-forced-count": "PEN · Money",
  "/admin/prize/settle": "PEN · Money",
  "/admin/leave-proof": "사유 반휴 신청 처리",
  "/admin/leave-proof/file": "사유 반휴 신청 처리",
  "/admin/leave-proof/decide": "사유 반휴 신청 처리",
  "/admin/leave-apply": "반휴 신청",
  "/leave-apply": "반휴 신청",
  "/reason-leave-proof": "반휴 신청",
  "/reason-leave-proof/cancel": "반휴 신청",
  "/exit-request": "퇴실 신청",
  "/exit-request/agree": "퇴실 신청",
  "/admin/exit/preview": "퇴실 처리",
  "/admin/exit/confirm": "퇴실 처리",
  "/admin/exit/blacklist": "퇴실 스터디원 목록",
  "/admin/members/exited": "퇴실 스터디원 목록",
  "/notify-prefs": "알림 설정",
  "/push/devices": "알림 설정",
  "/push/devices/remove": "알림 설정",
  "/push/devices/rename": "알림 설정",
  "/push/devices/toggle": "알림 설정",
  "/admin/push/send-category": "알림 설정",
  "/push/send-to-member": "빠른 공지",
  "/push/subscription-status": "빠른 공지",
  "/push/recent-notices": "최근 공지",
  "/status-message": "상태 메시지",
  "/member-status-message": "제보",
  "/report": "제보",
  "/report-cooldowns": "제보",
  "/report-status": "제보",
  "/reports": "제보",
  "/reports/capture-done": "제보",
  "/reports/requeue": "제보",
  "/participants": "체커(참여자 목록)",
  "/goal-schedule": "목표시간 설정",
  "(cron)": "정기 배치(cron)",
};

export function _menuNameForPath(path) {
  if (!path) return "(cron/기타)";
  return _PATH_MENU_NAMES[path] || path;
}

// fileId를 명시적으로 받는다 — 원본 시트뿐 아니라 지난 기록(Drive 백업 파일)도
// 같은 조회 로직을 공유해야 하기 때문.
export async function getSheetValues(env, accessToken, fileId, range) {
  _bumpUsageCounter("sheets_read");
  const res = await fetchSheetsApiWithRetry(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${encodeURIComponent(range)}`,
    accessToken
  );
  const data = await res.json();
  if (!data.values) throw new Error("시트 값 조회 실패: " + JSON.stringify(data));
  return data.values;
}

// 집계!D25(현재 페널티 사이클, 1~3주차 순환)는 개인 대시보드(/status)
// 하나를 조회할 때만도 buildPersonalStatus와 getReportScore가 각각 따로
// 읽어 요청 1건에 이 셀만 2번 조회했다. 15명이 동시에 /status를 열면
// 이 셀 하나 때문에 30회가 몰려 "분당 60회" 한도를 순식간에 갉아먹는다
// (2026-08 실제로 RESOURCE_EXHAUSTED 발생) — 매주 1~3만 순환하는 값이고
// Worker 쪽에서 이 셀에 쓰는 경로가 전혀 없어(앱스크립트 주간 트리거만
// 갱신) 캐싱해도 신선도 문제가 없다. KV에도 함께 저장해
// (_cacheSetAsync) 다른 사용자·다른 isolate 간에도 이 값이 공유되게 한다
// (docs/CACHING_POLICY.md §6, 2026-09).
//
// 🔧 [사용자 지시, 2026-09] "일주일에 한 번만 바뀌는데 5분마다 재확인하는
// 게 아깝다" — 앱스크립트 sheet_reset()이 리셋 직후 Worker에 즉시 무효화를
// 알려주도록 바꿨으니(MEMBER_CACHE_GROUPS.cycle), TTL은 "그 알림이 실패했을
// 때의 안전망"으로만 기능하면 된다. 2시간으로 크게 늘렸다 — 이 값은
// 제보 승인 시 슬롯에 그대로 기록되므로(applyOutputPenalty 등), 안전망이
// 너무 길면(예: 하루) 알림 실패 시 리셋 직후 최대 하루까지 잘못된 사이클
// 번호가 슬롯에 찍힐 위험이 있어, 그 노출 시간을 2시간으로 절충했다.
export async function getCurrentPenCycle(env, accessToken, fileId) {
  return _cachedCompute(env, `penCycle:${fileId}`, 2 * 60 * 60_000, async () => {
    const rows = await getSheetValues(env, accessToken, fileId, "집계!D25");
    return parseInt((rows[0] && rows[0][0]) || "1", 10) || 1;
  });
}

// 여러 range를 한 번의 HTTP 요청(=Sheets API 쿼터 1회 소진)으로 조회한다.
// 15명을 매번 개별 getSheetValues로 순회하면 회원 수만큼 쿼터를 쓰게 되어
// "분당 읽기 요청 60회" 한도를 손쉽게 넘긴다 — 회원 목록 같은 반복 조회는
// 반드시 이 함수로 한 번에 묶어야 한다. 반환값은 요청한 range 순서와 동일한
// 배열([][][]) — 각 range마다 못 찾으면 빈 배열을 채워 넣는다.
export async function batchGetSheetValues(env, accessToken, fileId, ranges) {
  if (ranges.length === 0) return [];
  _bumpUsageCounter("sheets_read");
  const query = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
  const res = await fetchSheetsApiWithRetry(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values:batchGet?${query}`,
    accessToken
  );
  const data = await res.json();
  if (!data.valueRanges) throw new Error("시트 값 일괄 조회 실패: " + JSON.stringify(data));
  return data.valueRanges.map((vr) => vr.values || []);
}

// D25(페널티 사이클)는 "1/3주차"처럼 커스텀 숫자 서식이 입혀져 있어 기본
// 렌더링으로는 텍스트로 온다. UNFORMATTED_VALUE로 조회해 실제 숫자(1/2/3)를 얻는다.
export async function getSheetUnformattedValue(env, accessToken, fileId, range) {
  _bumpUsageCounter("sheets_read");
  const res = await fetchSheetsApiWithRetry(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${encodeURIComponent(
      range
    )}?valueRenderOption=UNFORMATTED_VALUE`,
    accessToken
  );
  const data = await res.json();
  if (!data.values) throw new Error("시트 값 조회 실패: " + JSON.stringify(data));
  return data.values;
}

export async function writeSheetValues(env, accessToken, fileId, valueRanges) {
  _bumpUsageCounter("sheets_write");
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values:batchUpdate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: valueRanges }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error("시트 값 기입 실패: " + JSON.stringify(data));
  // 이 range가 어떤 회원의 개인 탭(시트명이 순수 숫자, 예: "7!C10")을 건드렸으면
  // 그 회원의 personalStatus 캐시만 정확히 지운다 — 반휴 신청/제보 승인 등
  // 19곳의 쓰기 지점 각각에 무효화를 흩어 넣는 대신 여기 한 곳에서 처리해
  // "방금 쓴 값이 캐시 때문에 본인 화면에 안 보이는" 정합성 문제를 막는다.
  // 🔧 [KV 무효화 누락 수정] 예전엔 인메모리(_sheetCache)만 지웠는데, 이
  // 요청을 처리한 isolate와 회원 본인이 새로고침할 때 뜬 isolate가 다르면
  // (Workers가 요청을 여러 isolate로 분산하므로 흔함) 그 isolate는 KV에
  // 남은 옛 값을 30분 TTL 내내 그대로 돌려줬다 — "방금 쓴 값이 안 보이는
  // 문제는 없다"던 원래 전제가 KV 계층에서는 성립하지 않았던 실제 버그.
  const kvDeletes = [];
  for (const { range } of valueRanges) {
    const sheetName = (range.split("!")[0] || "").replace(/^'|'$/g, "");
    if (/^\d+$/.test(sheetName)) {
      kvDeletes.push(invalidatePersonalStatusCache(env, fileId, sheetName));
    }
  }
  if (kvDeletes.length) await Promise.all(kvDeletes);
  return data;
}

// 🔧 [KV → DO 이전, 2026-09-11] "진행 중인 제보 쿨다운"/"최근 전송된 알림"
// 목록은 예전엔 여기(REPORTS_KV)에 "파일당 1개 키 + CAS 유사 재시도"
// 방식의 라이브 인덱스로 있었다(list() 자체는 이미 없앤 상태였다). 이제는
// 둘 다 ParticipantsRoster Durable Object의 메모리 상태로 옮겨졌다
// (checkReportCooldown/recordReportCooldown/markReportCaptureDone/
// listReportCooldowns, checkNoticeCooldown/recordNotice/listRecentNotices —
// §ParticipantsRoster 클래스 정의 참고). DO는 단일 인스턴스가 요청을
// 직렬 처리하므로 이 절이 다루던 CAS 재시도 로직 자체가 필요 없어져
// 삭제했다 — 자세한 배경은 `docs/CACHING_POLICY.md` §24.2.

// 스프레드시트 메타(모든 탭의 sheetId/title)를 가져온다. 시트 복사/삭제/서식
// 지정은 이름이 아니라 숫자 sheetId를 요구하므로, 이름→sheetId 매핑에 쓰인다.
// sheetId는 시트를 삭제·재생성(회원 등록/퇴실 시)해야만 바뀌고 그때마다
// invalidateMemberCache가 무효화하므로, 그 사이엔 몇 분을 캐싱해도 안전하다.
// 🔧 [2026-09-11] 5분→10분 — 유일한 정기 폴링 소비처(MemberRosterList,
// "참여 스터디원 목록")의 폴링을 30분으로 늘리면서, 같이 의존하는
// dataSheetRows:(10분)와 배율을 맞췄다. 애초에 5분이었을 때도 15분 폴링이
// 이미 5분보다 훨씬 길어 TTL이 쓰기 횟수의 병목이 아니었으므로(폴링 빈도가
// 병목), 10분으로 올려도 신선도·쓰기 횟수 둘 다 사실상 그대로다.
export async function getSpreadsheetMeta(env, accessToken, fileId) {
  return _cachedCompute(env, `meta:${fileId}`, 10 * 60_000, async () => {
    _bumpUsageCounter("sheets_read");
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${fileId}?fields=sheets.properties`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await res.json();
    if (!data.sheets) throw new Error("시트 메타 조회 실패: " + JSON.stringify(data));
    return data.sheets.map((s) => s.properties);
  });
}

export async function getSheetIdByName(env, accessToken, fileId, sheetName) {
  const sheets = await getSpreadsheetMeta(env, accessToken, fileId);
  const found = sheets.find((s) => s.title === sheetName);
  return found ? found.sheetId : null;
}

// 여러 시트 이름의 sheetId를 한 번의 메타 조회로 함께 찾는다. performExitReset/
// performDepositAgainReset처럼 한 흐름 안에서 getSheetIdByName을 연달아
// 여러 번(백업 시트 존재 확인/회원 시트/template) 호출하면 그때마다 스프레드시트
// 전체 메타를 새로 fetch해 API 요청이 불필요하게 늘어난다 — 한 번만 조회해 재사용한다.
export async function getSheetIdsByNames(env, accessToken, fileId, sheetNames) {
  const sheets = await getSpreadsheetMeta(env, accessToken, fileId);
  const byTitle = new Map(sheets.map((s) => [s.title, s.sheetId]));
  return Object.fromEntries(sheetNames.map((name) => [name, byTitle.has(name) ? byTitle.get(name) : null]));
}

// 여러 batchUpdate 요청(시트 복사/삭제/서식/보호 등)을 한 번에 실행한다.
export async function spreadsheetBatchUpdate(env, accessToken, fileId, requests) {
  _bumpUsageCounter("sheets_write");
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${fileId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("시트 구조 변경 실패: " + JSON.stringify(data));
  return data;
}

// 시트를 복제해 새 이름을 붙인다. 원본과 대상이 다른 스프레드시트일 수도
// 있다 — sheet_reset(월요일 새벽 초기화) 이후 정산 확정 처리 시, 이미
// 초기화된 원본이 아니라 "지난 주 백업 파일"에서 회원 시트를 가져와야 하는
// 경우(performExitReset) 이 경로를 쓴다(사용자 지시: "관리자가 확정 처리를
// 할 때만 시트에 백업이 생기고, 리셋 이후에도 지난 주 데이터로 계산").
// 반환값은 destFileId에 새로 생긴 시트의 sheetId.
export async function copySheetToSpreadsheet(env, accessToken, sourceFileId, sourceSheetId, destFileId, newName) {
  _bumpUsageCounter("sheets_write");
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sourceFileId}/sheets/${sourceSheetId}:copyTo`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ destinationSpreadsheetId: destFileId }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error("시트 복사 실패: " + JSON.stringify(data));
  // 원본(template 등)이 숨김 상태면 복사본도 숨김 상태를 그대로 물려받는다.
  // 새로 만든 탭은 항상 보이게 해야 하므로 명시적으로 hidden: false를 강제한다.
  await spreadsheetBatchUpdate(env, accessToken, destFileId, [
    {
      updateSheetProperties: {
        properties: { sheetId: data.sheetId, title: newName, hidden: false },
        fields: "title,hidden",
      },
    },
  ]);
  return data.sheetId;
}

// 같은 스프레드시트 안에서 복제하는 기존 호출부용 얇은 래퍼.
export async function copySheetWithName(env, accessToken, fileId, sourceSheetId, newName) {
  return copySheetToSpreadsheet(env, accessToken, fileId, sourceSheetId, fileId, newName);
}

// 기존 protectedRange를 모두 지우고 소유자(관리자 위임 계정)와 서비스 계정만
// 편집 가능하도록 새로 보호한다. protect_sheet(spread_sheet, sheet_name)와 동일.
export async function protectSheetForOwnerAndService(env, accessToken, fileId, sheetId, ownerEmail) {
  const serviceAccountEmail = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON).client_email;
  _bumpUsageCounter("sheets_read");
  const meta = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}?fields=sheets(properties.sheetId,protectedRanges.protectedRangeId)`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  ).then((r) => r.json());
  const sheet = (meta.sheets || []).find((s) => s.properties.sheetId === sheetId);
  const requests = [];
  for (const pr of sheet?.protectedRanges || []) {
    requests.push({ deleteProtectedRange: { protectedRangeId: pr.protectedRangeId } });
  }
  requests.push({
    addProtectedRange: {
      protectedRange: {
        range: { sheetId },
        description: "소유자와 특정 서비스 계정만 편집 가능",
        editors: { users: [ownerEmail, serviceAccountEmail] },
      },
    },
  });
  await spreadsheetBatchUpdate(env, accessToken, fileId, requests);
}

// --- 개인 상태(벌금) 조회 ---
// 보안 핵심: 세션 이메일 → 권한관리 탭에서 그 이메일에 해당하는 멤버 순번만 찾고,
// 그 순번의 개인 탭(1~15) 단 하나만 열람한다. 다른 사람의 이름/데이터는 조회 자체를 하지 않는다.

export const DAILY_FINE_CAP = 3000;
export const STATUS_DAYS = ["월", "화", "수", "목", "금", "토", "일"];
export const STATUS_DAY_COLS = [2, 5, 8, 11, 14, 17, 20]; // C,F,I,L,O,R,U (0-indexed)
export const ROW_JOIN_DATE = 2;
export const ROW_DAILY_STUDY_TIME = 24; // "⏰ 일간 학습시간"
export const ROW_LOG_STUDY_TIME = 25; // "⏰ 로그 학습시간" (원본 로그값, 자동 기록)
export const ROW_BONUS_STUDY_TIME = 26; // "⏰ 가산 학습시간"
export const ROW_WEEKLY_STUDY_TIME = 27; // "⏰ 주간 학습시간" (C28, 요일별 합산 HH:MM)
export const ROW_RECORD_TIME = 22;
export const ROW_TOTAL_FINE = 28;
export const ROW_GOAL_FINE = 29;
export const ROW_MORNING_FINE = 30;
export const ROW_PAYMENT_CHECK = 31; // "✅ 납부확인"
export const ROW_PERIOD_START = 5; // 1교시 시작 행
export const ROW_PERIOD_END = 18; // 14교시 시작 행
export const ROW_NORMAL_LEAVE_USE = 19; // "😴 일반반휴" (그날 사용 여부)
export const ROW_REASON_LEAVE_USE = 20; // "😴 사유반휴" (그날 사용 여부)
// 시트 수식(LEFT($O$3,2))과 동일하게 목표시간 문자열의 앞 2글자로 매칭한다.
// "8H"/"9H"/"10"(10H의 앞 2글자) 순서.
export const GOAL_TYPE_MINUTES = { "8H": 480, "9H": 540, "10": 600 };
export const ROW_WEEKLY_MERIT = 34; // "🏅 주간 총 상점" (C35)
export const ROW_WEEKLY_TOTAL_FINE = 33; // "💰 주간 총 벌금" (C34)
// 🔧 [데이터 시트 통합 — SHEET_STRUCTURE.md 기준 재실측] "송출 P 감사"/"주간 P
// 감사" 행 삭제 + "🚨 페널티"(송출P/주간P 표시) 신규 행 추가로 37행부터 전부
// 재배치됨. 실측(1-idx → 0-idx): 37=제보상점(36), 38=교시참여율(37),
// 39=페널티표시(38, 신규), 40=일반반휴잔여(39), 41=사유반휴잔여(40),
// 42=참조행계산번호(41), 43=감사행계산번호(42, 신규). 옛 "누적 송출P"/"금주
// 달성P"/"누적 달성P" 개념은 완전히 사라졌다.
export const ROW_PERIOD_ATTENDANCE_RATE = 37; // "📈 교시 참여율" (C38)
export const ROW_PENALTY_DISPLAY = 38; // "🚨 페널티" (C39, 송출P/주간P 표시 텍스트)
export const ROW_NORMAL_LEAVE_LEFT = 39; // "😴 일반반휴 잔여" (C40)
export const ROW_REASON_LEAVE_LEFT = 40; // "😴 사유반휴 잔여" (C41)
export const ROW_REPORT_SHEET_ROW = 41; // "⚙️ 참조 행 계산 번호" (C42) — "데이터" 시트 참조용
export const ROW_AUDIT_SHEET_ROW = 42; // "⚙️ 감사 행 계산 번호" (C43) — "데이터 (감사)" 시트 참조용
export const ROW_DEPOSIT_REFUND_ESTIMATE = 2; // "💰 예치금 반환 예상" (U열)
export const COL_DEPOSIT_REFUND_ESTIMATE = 20; // U열 (0-indexed)
export const ROW_STUDY_TIME_MERIT = 35; // "🏅 학습시간 상점" (C36)
export const ROW_REPORT_MERIT = 36; // "🏅 제보 상점" (C37)
export const ROW_PARTI_STATUS = 2; // "💾 참여상태" (L3, 0-idx row 2)
export const COL_PARTI_STATUS = 11; // L열 (0-indexed)
export const ROW_ACCESSION_DDAY = 2; // "D+n" (I3, 0-idx row 2)
export const COL_ACCESSION_DDAY = 8; // I열 (0-indexed)
export const ROW_DEPOSIT_AGAIN = 2; // "💰 예치금 재납" (R3, 0-idx row 2)
export const COL_DEPOSIT_AGAIN = 17; // R열 (0-indexed)
export const ROW_FINE_NO_STATUS = 32; // "미납신호" (C33)
export const COL_PERIOD_RATE_OFFSET = 2; // 요일 시작열 + 2 = 그 교시의 참여율 서브컬럼

export function parseWon(s) {
  return parseInt((s || "").replace(/[₩,]/g, ""), 10) || 0;
}

// Number(x)가 NaN이 되면(셀에 "#REF!" 같은 수식 에러나 텍스트가 남아있는 경우)
// JSON.stringify가 NaN을 null로 바꿔버려 프론트에서 크래시로 이어진다.
// 항상 유한한 숫자를 보장하기 위해 NaN이면 fallback으로 대체한다.
export function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function parseLeaveCount(s) {
  const m = (s || "").match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

// --- 퇴실자·재납자 처리 (앱스크립트 _exit_define / _calc_* 재현) ---
// 경로 A(원본 시트 즉시 처리)만 다룬다 — 주말 마감 후 Drive 백업 파일에서 처리하는
// 경로 B(_sunday 분기)는 이 버전에서 다루지 않는다.

export const EXIT_DEPOSIT_VALUE = 10000;

// D열은 "구글계정,구루미계정" 형태로 콤마 구분해 두 계정을 함께 담는다
// (구루미 계정을 저장할 별도 컬럼이 없어 기존 이메일 칸에 함께 넣기로 함 —
// 사용자 확인). 로그인 매칭 등 "구글 이메일"이 필요한 모든 지점은 항상 이
// 헬퍼로 앞부분만 뽑아 써야 한다 — 그러지 않으면 콤마가 이메일 문자열에
// 섞여 정확 일치 비교가 깨진다.

// 🔧 [데이터 시트 통합] "권한관리" 탭이 "데이터" 탭으로 흡수됐다.
// 열 인덱스(B=번호, C=이름, D=이메일)는 그대로 유지되어 row[1]/row[2]/row[3]
// 접근은 바뀌지 않았지만, 시트가 D~V까지 넓어져 A1:H50으로는 값을 다 못
// 읽으므로 범위를 A1:V50으로 확장했다.
export async function findMemberNumberByEmail(env, accessToken, fileId, email) {
  const rows = await getSheetValues(env, accessToken, fileId, "데이터!A1:V50");
  for (const row of rows) {
    const rowEmail = parseGoogleEmail(row[3]);
    if (rowEmail && rowEmail === email) {
      const num = (row[1] || "").trim();
      const name = (row[2] || "").trim();
      if (num) return { number: num, name };
    }
  }
  return null;
}

// 개인 탭 rows(A1:U... 2차원 배열)에서 요일별 days 배열을 만든다. 순수 함수로
// 분리해 실시간/과거 시트뿐 아니라 "예치금 재납 전" 백업 탭 스냅샷에도 그대로
// 재사용한다(buildDepositAgainSnapshot).

// STATUS_DAY_COLS(0-indexed)를 실제 시트 열 문자(A1 표기)로 변환한다. 26 이하만
// 다루므로 A~Z 단일 문자면 충분하다.
export function colIndexToLetter(col) {
  return String.fromCharCode(65 + col);
}

// exitStatus(getAllExitRelevantStatus)와 paymentRows(getAllPaymentRows)는
// 둘 다 "15명 개인 탭 A1:U(대략 30~40행)"이라는 거의 같은 범위를 각자
// batchGet했다 — ROW_REASON_LEAVE_LEFT(40)가 ROW_PAYMENT_CHECK(31)보다
// 넓은 범위라, 더 넓은 쪽 하나로 통일해 캐시/호출 자체를 공유한다.
// 🔧 [사용자 지시, 2026-09-11] ACCOUNT 탭 TTL 점검 — 벌금 처리(fine 그룹)는
// 프론트가 확정 후 즉시 재조회(`AdminMoneyTab`의 write-then-reload)해
// 캐시 TTL 자체는 체감 UX에 영향이 없고, 매주 sheet_reset()의 직접쓰기가
// 무효화를 못 받는 gap도 주 1회뿐이라 영향이 작다고 판단해 60초→10분으로
// 올린다. KV 쓰기는 파일당 1개 키만 남으므로(회원 수와 무관) 하루 최악치도
// 여전히 안전하다.
export async function getSharedMemberRows(env, accessToken, fileId, members) {
  return _cachedCompute(env, `memberRows:${fileId}`, 10 * 60_000, () => {
    const ranges = members.map((m) => `${m.number}!A1:U${ROW_REASON_LEAVE_LEFT + 1}`);
    return batchGetSheetValues(env, accessToken, fileId, ranges);
  });
}

// --- 도움봇(study_manager_260418.py) 원격 상태/명령 ---
// 봇은 로컬 PC에서 Cloudflare Tunnel(cloudflared)로 자신의 로컬 상태
// 서버를 외부에 노출한다. 이 Worker는 봇이 (재)시작될 때 등록해온
// Tunnel URL을 저장해두고, 관리자가 상태를 조회하거나 재시작을
// 누를 때만 그 URL로 즉시 요청을 프록시한다 — 주기적 폴링이 없으므로
// 쓰기가 봇이 (재)시작될 때만 발생해 무료 티어 쓰기 한도에 안전하다.
// 🔧 [KV → DO 이전, 2026-09-12] §49 — BotAdminConfigDO로 이전. 읽기는
// 거의 모든 봇 프록시 호출마다 발생하지만, 실측상 DO fetch(수 ms) 지연은
// proxyToBotDashboard 자체(봇 서버까지 수백ms~수초)에 비해 무시할
// 수준이라 일관성을 위해 함께 옮겼다(사용자 확인).
export const BOT_URL_CONFIG_KEY = "botUrl";
export const BOT_PROXY_TIMEOUT_MS = 8000;

export async function proxyToBotDashboard(env, path, options = {}) {
  const urlRes = await getBotAdminConfigStub(env).fetch(`https://do/config?key=${BOT_URL_CONFIG_KEY}`);
  const { value: url } = await urlRes.json();
  if (!url) return null;

  // 🔧 [사유반휴 대기 조회 지연 방지] buildPersonalStatus가 매 상태 조회마다
  // 대기 중 사유반휴 여부를 물어보는데, 기본 8초 타임아웃을 그대로 쓰면 봇이
  // 꺼져 있는 동안 로그인/새로고침마다 8초씩 늘어진다. 부가 정보 조회처럼
  // 짧게 실패해도 되는 호출은 options.timeoutMs로 개별 단축할 수 있게 한다.
  const { timeoutMs, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? BOT_PROXY_TIMEOUT_MS);
  try {
    const res = await fetch(url + path, {
      ...fetchOptions,
      headers: { "X-Dashboard-Secret": env.BOT_SECRET, ...(fetchOptions.headers || {}) },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// proxyToBotDashboard는 항상 res.json()을 호출해 JSON 응답만 다룰 수 있다.
// 제보 캡처 파일(이미지/영상)은 바이너리이므로, 파싱하지 않고 Response를
// 그대로 넘기는 버전이 별도로 필요하다.
export async function proxyToBotDashboardRaw(env, path) {
  const urlRes = await getBotAdminConfigStub(env).fetch(`https://do/config?key=${BOT_URL_CONFIG_KEY}`);
  const { value: url } = await urlRes.json();
  if (!url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BOT_PROXY_TIMEOUT_MS);
  try {
    const res = await fetch(url + path, {
      headers: { "X-Dashboard-Secret": env.BOT_SECRET },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 각 제보 항목이 승인되면 몇 차 슬롯(1~6차)에 기록될지 미리 계산해 "nextOccurrence"
// 필드로 항목에 얹는다 — 프론트가 승인 전에 버튼 라벨(구두경고/벌점/페널티)을
// 정확히 보여줘야 하기 때문. 회원별로 개별 조회하지 않고 "데이터" 시트
// F4:K18을 한 번에 읽어 닉네임→회원번호 매핑으로 계산한다. 제보자 이메일
// (reporterEmail)도 같은 명단으로 이름을 찾아 reporterName으로 함께 붙인다
// — UI가 이메일 대신 이름을 보여줘야 하기 때문.
// 🔧 [비용 절감, 2026-09-11] nextOccurrence/weeklyMinorPenaltyCount는
// 프론트에서 "penalty?.occurrence ?? nextOccurrence"(확정)/
// "deferredOccurrence ?? nextOccurrence"(유예) 형태로 쓰인다 — 즉 이미
// 확정 시점 스냅샷이 있는 건(approved/deferred)은 그 스냅샷을 우선하고,
// nextOccurrence는 **아직 pending이라 스냅샷이 없는 건에서만** 실제로
// 화면에 쓰인다(반려는 페널티 자체가 없어 애초에 안 씀 — 프론트 코드
// 확인 완료). pending 건이 하나도 없는 배치는 penSlotGrid:/penCycle: 조회
// 자체를 건너뛴다 — reporterName은 pending 여부와 무관하게 관리자 화면이
// 확정 건에도 표시하므로 members:(이미 2시간 캐시)는 그대로 조회한다.

// 🔧 [데이터 시트 통합] "페널티"(구 "송출 P") 탭이 "권한관리"/"제보상점"과 함께
// "데이터" 탭으로 흡수됐다. 송출P 슬롯 위치도 D~I → F~K로 옮겨졌다.
export const OUTPUT_PEN_SHEET_NAME = "데이터";
// 1차~6차 컬럼(F~K) 중 어떤 차수가 "송출P 발생(페널티)" 액션인지 — C39 수식과
// 동일한 기준(4차=I, 6차=K).
export const OUTPUT_PEN_SLOT_COLUMNS = ["F", "G", "H", "I", "J", "K"]; // 1차..6차
// "송출 P" 탭에서 한 행(D~I 6칸)의 주석을 한 번에 읽는다. spreadsheets.get의
// fields 파라미터로 note만 좁혀서 값 API보다 훨씬 가벼운 응답을 받는다.
export async function getRowNotes(env, accessToken, fileId, sheetId, rowIndex, startCol, endCol) {
  _bumpUsageCounter("sheets_read");
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}?` +
      `ranges=${encodeURIComponent(`'${OUTPUT_PEN_SHEET_NAME}'!${startCol}${rowIndex + 1}:${endCol}${rowIndex + 1}`)}` +
      `&fields=sheets.data.rowData.values.note`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  const rowData = data.sheets && data.sheets[0] && data.sheets[0].data && data.sheets[0].data[0] && data.sheets[0].data[0].rowData;
  const values = (rowData && rowData[0] && rowData[0].values) || [];
  return values.map((v) => (v && v.note) || "");
}

// 채워진 슬롯(값이 0이 아닌 칸)들의 주석 중 "YYYY-MM-DD"로 시작하는 가장 최근
// 날짜를 찾아 발생 요일(월~일)로 변환한다. 주석이 하나도 없으면 null.
// 슬롯 주석("2026. 8. 25. 오후 3:41:46 · 사유" 또는 appscript.js
// get_formatted_date의 "2026-08-25 · 사유")에서 날짜만 UTC 자정 ms로 뽑는다.
// 파싱 실패 시 null.
function parseSlotNoteDateMs(note) {
  // "2026. 8. 25." 형식(index.js applyOutputPenalty의 toLocaleString)
  let m = /^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\./.exec(note || "");
  // "2026-08-25" 형식(appscript.js get_formatted_date)
  if (!m) m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(note || "");
  if (!m) return null;
  return Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
}

function msToStatusDay(ms) {
  const jsDay = new Date(ms).getUTCDay(); // 일=0 ... 토=6 (UTC 자정 고정이라 타임존 영향 없음)
  return STATUS_DAYS[(jsDay + 6) % 7]; // 월=0 ... 일=6으로 보정
}

// 🔧 [날짜 파싱 버그] 이전 정규식은 "YYYY-MM-DD"만 인식했지만, 실제 주석은
// applyOutputPenalty()가 toLocaleString("ko-KR", {timeZone:"Asia/Seoul"})로
// 남긴 "2026. 8. 25. 오후 3:41:46 · 사유"(점+공백 구분, 한 자리 월/일 가능)
// 형식이라 전혀 매칭되지 않았다 — "요일 미확인"으로만 빠지던 원인.
// appscript.js daily_calc()가 남기는 "YYYY-MM-DD · 사유"(get_formatted_date)
// 형식도 함께 지원한다.
export function latestSlotDay(slotValues, slotNotes) {
  let latestMs = null;
  slotValues.forEach((v, i) => {
    if (!v) return;
    const ms = parseSlotNoteDateMs(slotNotes[i] || "");
    if (ms === null) return;
    if (latestMs === null || ms > latestMs) latestMs = ms;
  });
  if (latestMs === null) return null;
  return msToStatusDay(latestMs);
}

// 🔧 [예치금 재납 발생일] R3(예치금 재납 상태)는 개인 탭 상단의 "현재 시점
// 스냅샷" 하나뿐이라 요일 정보가 없다 — 그대로 쓰면 이번 주 모든 요일
// 카드에 동일하게 표시되는 문제가 있다(사용자 지적). "예치금 재납 대상"이
// 되는 건 이번 사이클에 실제로 카운트되는 슬롯(송출P 4차/6차, 주간P
// 1차/2차)이 2개 이상 채워진 시점이므로, 그 슬롯들의 주석 날짜를 오름차순
// 정렬해 2번째(=2회 달성 시점) 날짜의 요일을 "발생일"로 판정한다. 카운트
// 슬롯이 2개 미만이면(재납 대상이 아니거나 판정 근거 부족) null.
export function depositAgainOccurredDay(outputPenHistory, timePenHistory) {
  const countedEntries = [
    outputPenHistory[3], // 4차(I)
    outputPenHistory[5], // 6차(K)
    timePenHistory[0], // 주간P 1차(L)
    timePenHistory[1], // 주간P 2차(M)
  ].filter(Boolean);

  const dates = countedEntries
    .map((entry) => parseSlotNoteDateMs(entry.when))
    .filter((ms) => ms !== null)
    .sort((a, b) => a - b);

  if (dates.length < 2) return null;
  return msToStatusDay(dates[1]);
}

// F~K(송출P 1~6차) 또는 L~M(주간P 1~2차) 슬롯 중 채워진 칸만 골라
// "{차수}차 · {발생일시} · {사유}" 형태의 상세 기록 목록을 만든다. 주석은
// "{발생일시} · {사유} [cap:캡처ID]"로 저장되므로, 먼저 끝의 "[cap:...]"를
// 떼어 captureId로 뽑고 남은 부분을 "{발생일시} · {사유}"로 나눠 쓴다.
// "예치금 재납 대상자" 카드가 송출P/주간P 각각의 적립 이력을 보여주는 데 쓰인다.
export function buildSlotHistory(slotValues, slotNotes, labelPrefix) {
  const history = [];
  slotValues.forEach((v, i) => {
    if (!v) return;
    let note = slotNotes[i] || "";
    let captureId = null;
    const capMatch = /\s*\[cap:([^\]]+)\]\s*$/.exec(note);
    if (capMatch) {
      captureId = capMatch[1];
      note = note.slice(0, capMatch.index);
    }
    const [when, ...reasonParts] = note.split(" · ");
    history.push({
      label: `${labelPrefix} ${i + 1}차`,
      cycle: v,
      when: when || "",
      reason: reasonParts.join(" · ") || "",
      captureId,
    });
  });
  return history;
}

// 로그인한 회원 본인이 "다른 관리자 의견 반영"(공동 검토) 권한을 가졌는지
// 확인한다 — 관리자 여부와 무관하게 아무 로그인 세션이나 호출 가능(부스터디장
// 여부만 판정하는 가벼운 자기 조회). 프론트가 앱 진입 시 한 번 호출해
// "관리자" 탭·제한된 검토 화면을 보여줄지 판단하는 데 쓴다.
export async function handleMyRole(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    const memberNumber = await resolveMemberNumber(env, accessToken, session).catch(() => null);
    if (!memberNumber) return json({ isCoReviewer: false }, 200, origin);
    const coReviewers = await getCurrentCoReviewers(env, accessToken, fileId);
    return json({ isCoReviewer: coReviewers.some((m) => m.number === memberNumber) }, 200, origin);
  } catch {
    return json({ isCoReviewer: false }, 200, origin);
  }
}

// --- 목표시간 다음 주 예약 ('집계' 시트 N열) ---
// 앱스크립트의 revoke_editor_column_n 트리거가 매주 월요일 오후에 N열 값을
// 읽어 각 개인 탭 O3(의무시간)에 반영한다. N열은 소유자+서비스 계정만
// 편집 가능하도록 이미 보호되어 있어(회원 본인은 월요일 아침에만 열림),
// 워커는 서비스 계정 권한으로 그 시간 제약과 무관하게 언제든 예약을 넣을 수 있다.
// 현재 주간 값(O3)은 이 트리거가 실행되기 전까지 바뀌지 않으므로 규정대로 불변이다.
// 🔧 [17차, TDZ 방어] Object.keys(GOAL_TYPE_MULTIPLIER)를 모듈 최상위에서
// 즉시 평가하지 않고 함수로 감싼다 — 지금은 import 순서상 우연히
// 안전하지만(personal-status.js가 이 시점 이전에 완전히 평가됨), 11차에서
// 실제로 겪은 TDZ 버그(LEAVE_TYPE_CONFIG)와 동일한 모양이라 import 순서가
// 바뀌면 재발할 수 있다. 함수 안에서 호출 시점에만 평가하면 순서와 무관하게
// 항상 안전하다.
function getGoalTimeValidValues() {
  return Object.keys(GOAL_TYPE_MULTIPLIER);
}

export async function resolveMemberNumber(env, accessToken, session) {
  if (session.memberNumber) return session.memberNumber;
  const member = await findMemberNumberByEmail(env, accessToken, env.GOOGLE_SHEET_FILE_ID, session.email);
  if (!member) throw new Error("데이터 시트 명단에서 계정을 찾을 수 없습니다.");
  return member.number;
}

export async function handleGetGoalSchedule(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    let memberNumber = session.memberNumber;
    if (!memberNumber) {
      const member = await findMemberNumberByEmail(env, accessToken, env.GOOGLE_SHEET_FILE_ID, session.email);
      if (!member) return json({ error: "데이터 시트 명단에서 계정을 찾을 수 없습니다." }, 403, origin);
      memberNumber = member.number;
    }

    const row = Number(memberNumber) + 4;
    // 셀이 완전히 비어 있으면 Sheets API가 values 자체를 생략해 예외가 나므로,
    // "아직 아무도 예약하지 않음"을 정상 상태로 처리하기 위해 개별적으로 방어한다.
    let raw = "";
    try {
      const rows = await getSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, `집계!L${row}`);
      raw = (rows[0] && rows[0][0]) || "";
    } catch {
      raw = "";
    }
    const validValues = getGoalTimeValidValues();
    const scheduled = validValues.includes(raw) ? raw : null;

    return json({ scheduled, validValues }, 200, origin);
  } catch (err) {
    return json({ error: "예약 조회 실패: " + err.message }, 500, origin);
  }
}

export async function handleSetGoalSchedule(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const { goalType } = await req.json();
  if (!getGoalTimeValidValues().includes(goalType)) {
    return json({ error: "올바른 목표시간 값이 아닙니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    let memberNumber = session.memberNumber;
    if (!memberNumber) {
      const member = await findMemberNumberByEmail(env, accessToken, env.GOOGLE_SHEET_FILE_ID, session.email);
      if (!member) return json({ error: "데이터 시트 명단에서 계정을 찾을 수 없습니다." }, 403, origin);
      memberNumber = member.number;
    }

    const row = Number(memberNumber) + 4;
    await writeSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, [
      { range: `집계!L${row}`, values: [[goalType]] },
    ]);

    return json({ ok: true, scheduled: goalType }, 200, origin);
  } catch (err) {
    return json({ error: "예약 저장 실패: " + err.message }, 500, origin);
  }
}

 // 시트 4행(0-indexed 3)부터 15명
 // 시트 18행(0-indexed 17)까지

// --- 관리자 전용: 특정 회원의 개인 대시보드 조회 ---
// 회원 드롭다운(이름 목록)과, 선택한 회원의 요일별 벌금·학습시간 상세를 제공한다.

// 🔧 [과거 주차 회원 전환 지원] cycle 쿼리(백업 fileId)가 주어지면 그 주차의
// 백업 시트에서 회원 목록을 읽는다 — 이전엔 항상 현재(라이브) 시트만 봐서,
// 관리자가 과거 사이클을 조회할 때 "다른 회원 보기" 드롭다운 자체를 아예
// 숨겼었다. /status, /roster-status가 이미 쓰는 resolveTargetFileId와
// 동일한 검증(그 fileId가 실제로 현재 사이클에 속하는지)을 거친다.
// 백업 탭 시트 이름 패턴 — 퇴실 시 performExitReset이 만드는 "{이름} (퇴실)"만
// 매칭한다("{이름} (재납 {타임스탬프})"는 재납이라 "다시 활동 중인 스터디원"으로
// 취급되므로(§performDepositAgainReset이 L3를 "스터디원"으로 되돌림) 이 조회
// 대상이 아니다 — 재납자는 이미 listAllMembers에 정상적으로 다시 나타난다).
export const EXITED_BACKUP_SHEET_RE = /^(.+) \(퇴실\)$/;
// 프론트가 "다른 회원 보기" 드롭다운에서 퇴실자를 구분할 수 있도록 number에
// 붙이는 접두사 — 실제 회원번호(숫자)와 절대 겹치지 않는다.
export const EXITED_MEMBER_PREFIX = "exited:";

// 원본 스프레드시트에 남아있는 퇴실자 백업 탭 목록을 "다른 회원 보기"
// 드롭다운용 항목으로 변환한다. 과거 사이클 백업 파일(cycleFileId가 가리키는
// 완전히 별도의 Drive 파일)에는 이 탭이 존재하지 않으므로, 호출부가 원본
// 조회(cycleFileId 없음)일 때만 이 함수를 부른다.
export async function listExitedMemberEntries(env, accessToken, fileId) {
  const sheets = await getSpreadsheetMeta(env, accessToken, fileId);
  return sheets
    .map((s) => EXITED_BACKUP_SHEET_RE.exec(s.title))
    .filter(Boolean)
    .map((m) => ({ number: `${EXITED_MEMBER_PREFIX}${m[0]}`, name: m[0], email: "" }));
}

// 🔧 [사용자 지시] "직권 P 사이클 오인 방지" — handleAdminExitPreview/
// handleAdminExitConfirm이 body로 받는 forcedReason "원본"(prefix 없는
// 값, 프론트 lockForcedReason과 동일)과 비교하는 데 쓰인다. 이 원본에서
// "직권 사유: " prefix를 붙인 label 형태를 파생시켜 쓰는 쪽은
// fines.js의 handleAdminFinesAdminForcedCount(18차에서 이동)다.
export const FINE_UNPAID_ADMIN_FORCED_REASON = "벌금 시한 내 미납자";

// 🔧 [앱스크립트 직접 쓰기 캐시 정합성, 2026-09] 앱스크립트(daily_calc/
// revoke_editor_column_n/o)는 Worker API를 거치지 않고 gspread와 마찬가지로
// 시트에 직접 쓴다 — writeSheetValues의 내장 무효화도, invalidateMemberCache
// 호출도 전혀 트리거되지 않는다. 지금까지는 personalStatus:(10분)/
// outputPenSlots:(5분) 등 TTL이 자연 만료될 때까지 기다리는 수밖에 없었는데,
// 특히 매주 월요일 목표시간 마감(회원이 마감 직후 확인하려는 시점과 겹침)과
// 일요일 자정 자동 벌점 기록(관리자 화면이 그 시각 열려 있으면 노출)에서
// 화면이 잠깐 낡아 보일 수 있었다(docs/CACHING_POLICY.md §12). 앱스크립트가
// 쓰기를 마친 직후 이 엔드포인트를 한 번 호출해 관련 캐시만 즉시 지운다 —
// 15명을 순회하는 함수 하나가 끝날 때 1회만 호출하면 되므로 KV 예산에
// 미치는 영향은 미미하다. groups는 invalidateMemberCache(env, groups)에
// 그대로 전달하고(생략 시 전체 무효화), memberNumbers가 있으면 그 각각의
// personalStatus: 캐시도 함께 지운다(개인 탭 값 — 목표시간/반휴 등은 이
// 그룹 밖이라 별도 처리 필요).
export async function handleBotInvalidateCache(req, env, origin) {
  const botSecret = req.headers.get("X-Bot-Secret");
  if (!botSecret || botSecret !== env.BOT_SECRET) {
    return json({ error: "unauthorized" }, 401, origin);
  }
  const { groups, memberNumbers } = await req.json().catch(() => ({}));
  const validGroupNames = Object.keys(MEMBER_CACHE_GROUPS);
  if (groups && (!Array.isArray(groups) || groups.some((g) => !validGroupNames.includes(g)))) {
    return json({ error: "groups는 " + validGroupNames.join("/") + " 중 하나여야 합니다." }, 400, origin);
  }
  if (memberNumbers && !Array.isArray(memberNumbers)) {
    return json({ error: "memberNumbers는 배열이어야 합니다." }, 400, origin);
  }
  await Promise.all([
    groups || !memberNumbers ? invalidateMemberCache(env, groups) : Promise.resolve(),
    ...((memberNumbers || []).map((n) => invalidatePersonalStatusCache(env, env.GOOGLE_SHEET_FILE_ID, String(n)))),
  ]);
  return json({ ok: true }, 200, origin);
}

// "다른 관리자 의견 반영"(§ReportReviewList)의 실제 공동 검토자 명단 —
// 현재 부스터디장으로 임명된 회원(최대 2명, 사용자 확인)만 대상이다.
// listActiveMembersWithExitInfo는 강제퇴실 판정·페널티 집계까지 함께
// 계산해 이 조회엔 과하므로, batchGet으로 15개 L3(참여상태) 셀만 직접
// 읽는 훨씬 가벼운 전용 조회를 쓴다.
// 🔧 [캐싱 추가, 2026-09] "PEN·Money" 탭 "송출 P 대상 처리"(3분→10분 폴링,
// handleAdminCapturesList)가 이 함수를 매번 캐시 없이 호출해, 부스터디장
// 임명처럼 아주 가끔만 바뀌는 값을 3분마다 15명 전체 셀을 다시 읽고
// 있었다(사용자 지적). meta:(스프레드시트 구조, 같은 성격의 저빈도 값)와
// 동일하게 캐싱한다 — 임명/해제(handleAdminSetPartiStatus)가
// invalidateMemberCache(["partiStatus"])를 호출하므로, 그 그룹에 이 키를
// 포함시켜 즉시 무효화되게 한다(TTL은 그 무효화가 실패했을 때의 안전망).
// 🔧 [사용자 지시, 2026-09-11] ACCOUNT 탭 TTL 점검 — 임명/해제 경로가
// handleAdminSetPartiStatus 단일 경로뿐이고 항상 await로 무효화되며,
// 시트 직접쓰기로 부스터디장을 지정하는 우회 경로가 없음을 재확인해
// 5분→10분으로 올린다. 늘어나는 건 "무효화 자체가 실패했을 때의 안전망
// 시간"뿐이라 이 권한 검사(requireAdminOrCoReviewer)에 영향이 크지 않다.
export async function getCurrentCoReviewers(env, accessToken, fileId) {
  return _cachedCompute(env, `coReviewers:${fileId}`, 10 * 60_000, async () => {
    const members = await listAllMembers(env, accessToken, fileId);
    const partiStatusValues = await batchGetSheetValues(
      env,
      accessToken,
      fileId,
      members.map((m) => `${m.number}!L3`)
    ).catch(() => []);
    return members
      .filter((_, i) => ((partiStatusValues[i] && partiStatusValues[i][0] && partiStatusValues[i][0][0]) || "") === "부스터디장")
      .map((m) => ({ number: m.number, name: m.name }));
  });
}

// 🔧 [구조 개선, 2026-09-13] Durable Object 클래스 8개는 src/durable-objects.js로
// 옮겼다(파일 상단 import/재export 참고) — 아래 stub 헬퍼만 여기 남겼다.
export function getUsageStatsStub(env) {
  const id = env.USAGE_STATS_DO.idFromName("usage-stats");
  return env.USAGE_STATS_DO.get(id);
}

export function getMemberSettingsStub(env) {
  const id = env.MEMBER_SETTINGS_DO.idFromName("member-settings");
  return env.MEMBER_SETTINGS_DO.get(id);
}

// 🔧 [중복 제거, 2026-09-21] "MemberSettingsDO의 do/exit/list를 fetch해
// { items } 구조분해"까지의 2줄이 exit-candidates.js(2곳)/fines.js 3곳에
// 그대로 반복되고 있었다(전수조사에서 발견) — exit-request.js의
// listExitRequests(같은 목적, LeaveQueue DO 버전)와 같은 패턴의 헬퍼가
// 이쪽엔 없던 공백이다. 이후 로직(맵 순회, 필터링 등)은 호출부마다
// 달라 여기서는 파싱까지만 캡슐화한다.
export async function getExitResults(env) {
  const res = await getMemberSettingsStub(env).fetch("https://do/exit/list");
  const { items } = await res.json();
  return items || {};
}

export function getBotAdminConfigStub(env) {
  const id = env.BOT_ADMIN_CONFIG_DO.idFromName("bot-admin-config");
  return env.BOT_ADMIN_CONFIG_DO.get(id);
}

// _dailyUsageBuffer(index.js 상단)를 UsageStats DO로 배치 전송하고 비운다.
// 5분 cron(scheduled)에서 정기적으로 호출되고, handleAdminUsageStatus에서도
// 응답 직전에 한 번 더 호출된다(🔧 [사용자 지시] "5분마다 갱신 이거 조건
// 없앨 수 있나? 폴링 될 때마다 새로 가져오도록" — 버퍼가 비어있으면 즉시
// 반환하므로(위 if문) 이 엔드포인트를 호출하는 관리자 화면(1분 폴링) 정도
// 빈도에서는 DO fetch 오버헤드가 무시할 만하다).
export async function flushDailyUsageStats(env) {
  const stub = getUsageStatsStub(env);

  if (_dailyUsageBuffer.size > 0 || _pendingNameFlush.size > 0) {
    const entries = [];
    for (const [key, count] of _dailyUsageBuffer) {
      const parts = key.split("|");
      const op = parts.pop();
      const email = parts.pop();
      const date = parts.shift();
      const kind = parts.shift();
      const path = parts.join("|");
      entries.push({ date, kind, path, email, op, count });
    }
    const names = Object.fromEntries(_pendingNameFlush);
    const res = await stub.fetch("https://do/flush", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries, today: todayUTCDateString(), names }),
    });
    if (res.ok) {
      _dailyUsageBuffer.clear();
      _pendingNameFlush.clear();
    }
  }

  // 🔧 [사용자 지시] "일일 중에서 30분내로 발생한것만 추려서 보여주면
  // 되잖아" — _minuteUsageBuffer(분단위 델타)도 같은 배치 타이밍에 DO로
  // 보내 모든 isolate의 기록을 하나로 모은다. DO가 30분 지난 분단위
  // 키를 스스로 정리하므로(위 /flush-recent) 여기서는 그냥 델타만 보낸다.
  if (_minuteUsageBuffer.size > 0) {
    const recentEntries = [];
    for (const [key, count] of _minuteUsageBuffer) {
      const parts = key.split("|");
      const op = parts.pop();
      const email = parts.pop();
      const minuteKey = parts.shift();
      const kind = parts.shift();
      const path = parts.join("|");
      recentEntries.push({ minuteKey, kind, path, email, op, count });
    }
    const recentRes = await stub.fetch("https://do/flush-recent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: recentEntries }),
    });
    if (recentRes.ok) _minuteUsageBuffer.clear();
  }
}

// key(닉네임 등)별로 fn()을 상호 배타적으로 실행한다 — DO가 죽거나 acquire가
// 예외를 던지는 극단적 상황에서도 fn() 자체가 멈추지 않도록, 락 획득
// 자체가 실패하면(예: DO 일시 장애) 잠금 없이 그냥 진행한다 — 락은 레이스를
// "줄이는" 안전장치이지, 락이 없다고 승인 자체를 막을 정도로 중요하지는
// 않다는 판단(사용자 확인: 시트 반영이 관리자의 유일한 처리 수단이라 완전히
// 막히면 더 큰 문제가 된다).
export async function withMemberLock(env, key, fn) {
  const stub = getRosterStub(env);
  const lockKey = `slotlock:${key}`;
  let acquired = false;
  try {
    const res = await stub.fetch(`https://do/lock/acquire?key=${encodeURIComponent(lockKey)}`, { method: "POST" });
    // 🔧 [버그 수정] 원래는 fetch가 예외 없이 응답을 받으면(HTTP 상태와
    // 무관하게) 무조건 acquired = true로 간주했다 — DO가 LOCK_WAIT_TIMEOUT_MS
    // 안에 락을 못 줘서 503(ok:false, timedOut:true)을 응답해도 이를
    // "락을 획득함"으로 잘못 판단해, 나중에 release를 호출하게 됐다. 이
    // release가 실제로는 아무도 쥐고 있지 않은(또는 다른 요청이 이미 새로
    // 쥔) 엔트리를 잘못 건드려, 아직 락 대기 중인 다음 요청을 조기에
    // 풀어주는(release가 큐의 다음 대기자를 next()로 깨움) 이중 실행
    // 가능성을 만들었다. 응답 바디의 ok 값까지 확인해야 정확하다.
    acquired = res.ok;
  } catch {
    // DO 장애 시 잠금 없이 진행(위 주석 참고).
  }
  try {
    return await fn();
  } finally {
    if (acquired) {
      try {
        await stub.fetch(`https://do/lock/release?key=${encodeURIComponent(lockKey)}`, { method: "POST" });
      } catch {
        // release 실패는 무시 — 최악의 경우 해당 key의 락이 그 DO 인스턴스
        // 수명 동안 풀리지 않을 수 있으나, DO는 유휴 시 재시작되며 그때
        // this.locks도 함께 초기화된다.
      }
    }
  }
}

export function getRosterStub(env) {
  const id = env.PARTICIPANTS_DO.idFromName("gooroomee-room");
  return env.PARTICIPANTS_DO.get(id);
}

export async function handlePutParticipants(req, env, origin) {
  const botSecret = req.headers.get("X-Bot-Secret");
  if (!botSecret || botSecret !== env.BOT_SECRET) {
    return json({ error: "unauthorized" }, 401, origin);
  }
  const stub = getRosterStub(env);
  const doRes = await stub.fetch("https://do/participants", {
    method: "PUT",
    body: await req.text(),
    headers: { "Content-Type": "application/json" },
  });
  const data = await doRes.json();
  return json(data, 200, origin);
}

export async function handleGetParticipants(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const stub = getRosterStub(env);
  const doRes = await stub.fetch("https://do/participants", { method: "GET" });
  const data = await doRes.json();
  return json(data, 200, origin);
}

// --- Web Push (브라우저 푸시 알림) ---
// 관리자 전용: 구독 등록은 로그인 세션만 있으면 누구나 가능하지만(자기 브라우저를 구독),
// 발송(send)은 ADMIN_EMAIL 계정만 트리거할 수 있다.

export async function requireAdmin(req, env) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return null;
  if (session.email !== (env.ADMIN_EMAIL || "").toLowerCase()) return null;
  return session;
}

// 회원이 종류별로 켜고 끌 수 있는 푸시 알림 카테고리. 아직 각 카테고리를
// 실제 이벤트(제보 승인 등)에 연결하지는 않았고, 지금은 회원의 on/off
// 선호도를 저장/조회하는 것과 관리자가 종류를 골라 수동으로 테스트 발송하는
// 것까지만 지원한다 — 실제 이벤트 연동은 이 저장값을 그대로 재사용해 이어갈
// 예정.
export const NOTIFY_CATEGORIES = {
  report_result: "제보 처리 결과",
  leave_proof_result: "사유 반휴 처리 결과",
  fine_status: "벌금 상태 변경",
  exit_result: "퇴실/재납 처리 결과",
  direct_message: "다른 참여자의 알림(귓속말)",
};

// 로컬 개발(Vite dev 서버, http://localhost:*)에서의 요청은 배포된
// ALLOWED_ORIGIN(GitHub Pages 도메인)과 달라 CORS에 막혀 "Failed to
// fetch"가 난다. 요청의 실제 Origin이 localhost면 그대로 반사(echo)해
// 허용하고, 그 외에는 기존처럼 ALLOWED_ORIGIN 고정값을 쓴다 — 프로덕션
// 오리진 검증(ALLOWED_ORIGIN)을 느슨하게 만들지 않으면서 로컬 개발만 열어준다.
function resolveOrigin(req, env) {
  const requestOrigin = req.headers.get("Origin") || "";
  if (/^https?:\/\/localhost(:\d+)?$/.test(requestOrigin)) return requestOrigin;
  return env.ALLOWED_ORIGIN || "*";
}

export default {
  async fetch(rawReq, rawEnv) {
    // 🔧 [KV 쓰기/삭제 추적, 화면별 특정] env.REPORTS_KV를 계측 프록시로
    // 감싸, 이 요청 처리 중 실행되는 모든 .put()/.delete() 호출을
    // "캐시 종류 × 이 요청의 경로"로 자동 집계한다 — url을 먼저 계산해
    // pathname을 프록시에 넘겨야 하므로 origin 계산보다 앞으로 옮겼다.
    // 아래의 req/env는 이 감싸진 버전을 쓴다.
    const req = rawReq;
    const url = new URL(req.url);
    // 🔧 [사용량 모니터링 고도화, 2026-09-11] "어느 사용자에 의해"까지
    // 집계하려면 이메일이 필요하다. 각 핸들러 내부의 verifySession/
    // requireAdmin(75곳 이상)을 전부 손대는 대신, 여기서 딱 한 번
    // 선제적으로 검증해 얻은 이메일을 지역 변수(요청마다 새로 생성되는
    // fetch 스코프 — 전역이 아니므로 동시 요청끼리 섞일 위험이 없다)에
    // 담아 계측 프록시에 넘긴다. 각 핸들러의 기존 재검증(실제 권한
    // 판정용)은 그대로 둔다 — HMAC 검증 자체가 가벼워 중복 호출 비용은
    // 무시할 수준이다. 세션이 없거나 만료됐으면 null(집계 시 "(익명)").
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const requestSession = token ? await verifySession(token, rawEnv.SESSION_SECRET) : null;
    const requestEmail = requestSession ? requestSession.email : null;
    const requestName = requestSession ? requestSession.memberName : null;
    const env = {
      ...rawEnv,
      REPORTS_KV: instrumentKvNamespace(rawEnv.REPORTS_KV, url.pathname, requestEmail, requestName),
    };
    const origin = resolveOrigin(req, env);

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    try {
      // 🔧 [18차, 순수 재배열 없는 주석 정리] 라우팅 테이블 자체는 원본
      // 모놀리식 코드의 추가 순서(역사적 순서)를 그대로 유지한다 — 로직
      // 순서 변경 없이, 17차 구조 감사가 지적한 "도메인 인지도가 전혀
      // 반영되지 않은" 문제만 주석 헤더로 완화한다.

      // --- Auth (auth.js) ---
      if (url.pathname === "/verify" && req.method === "POST") {
        return await handleVerify(req, env, origin);
      }
      if (url.pathname === "/dev/login" && req.method === "POST") {
        return await handleDevLogin(req, env, origin);
      }

      // --- Chat (chat.js) ---
      if (url.pathname === "/chat/token" && req.method === "POST") {
        return await handleChatToken(req, env, origin);
      }
      if (url.pathname === "/chat/ensure-user" && req.method === "POST") {
        return await handleChatEnsureUser(req, env, origin);
      }
      if (url.pathname === "/chat/configure-uploads" && req.method === "POST") {
        return await handleChatConfigureUploads(req, env, origin);
      }

      // --- Report/Capture 접수·쿨다운 (report-intake.js) ---
      if (url.pathname === "/report" && req.method === "POST") {
        return await handleReport(req, env, origin);
      }
      if (url.pathname === "/report-cooldowns" && req.method === "GET") {
        return await handleListActiveCooldowns(req, env, origin);
      }
      if (url.pathname === "/reports/capture-done" && req.method === "POST") {
        return await handleReportCaptureDone(req, env, origin);
      }
      if (url.pathname === "/reports" && req.method === "GET") {
        return await handleListReports(req, env, origin);
      }
      if (url.pathname === "/reports/requeue" && req.method === "POST") {
        return await handleRequeueReport(req, env, origin);
      }

      // --- Bot 상태/사용량 (bot.js) ---
      if (url.pathname === "/admin/bot-sheets-usage" && req.method === "POST") {
        return await handleBotSheetsUsageReport(req, env, origin);
      }
      if (url.pathname === "/internal/cycle-boundary" && req.method === "GET") {
        return await handleInternalCycleBoundary(req, env, origin);
      }
      if (url.pathname === "/report-status" && req.method === "GET") {
        // report-penalty.js — 봇 등록 흐름 근처에 있지만 제보 도메인.
        return await handleReportStatus(req, env, origin, url);
      }
      if (url.pathname === "/bot/register-url" && req.method === "POST") {
        return await handleBotRegisterUrl(req, env, origin);
      }
      if (url.pathname === "/bot/exit-requests" && req.method === "GET") {
        // exit-request.js — 봇이 퇴실 신청 목록을 폴링하는 경로.
        return await handleBotExitRequests(req, env, origin);
      }
      if (url.pathname === "/bot/invalidate-cache" && req.method === "POST") {
        return await handleBotInvalidateCache(req, env, origin);
      }
      if (url.pathname === "/admin/bot/status" && req.method === "GET") {
        return await handleAdminBotStatus(req, env, origin);
      }
      if (url.pathname === "/admin/usage" && req.method === "GET") {
        return await handleAdminUsageStatus(req, env, origin);
      }
      if (url.pathname === "/admin/bot/command" && req.method === "POST") {
        return await handleAdminBotCommand(req, env, origin);
      }

      // --- Report/Capture 캡처 검토/투표 (report-review.js) ---
      if (url.pathname === "/admin/captures" && req.method === "GET") {
        return await handleAdminCapturesList(req, env, origin, url);
      }
      if (url.pathname === "/my-captures" && req.method === "GET") {
        return await handleMyCaptures(req, env, origin, url);
      }
      if (url.pathname === "/my-captures/delete" && req.method === "POST") {
        return await handleMyCaptureDelete(req, env, origin);
      }
      if (url.pathname === "/my-output-pen" && req.method === "GET") {
        return await handleMyOutputPen(req, env, origin, url);
      }
      if (url.pathname === "/captures/target-respond" && req.method === "POST") {
        return await handleCaptureTargetRespond(req, env, origin);
      }
      if (url.pathname === "/admin/captures/file" && req.method === "GET") {
        return await handleAdminCaptureFile(req, env, origin, url);
      }
      if (url.pathname === "/admin/captures/vote" && req.method === "POST") {
        return await handleAdminCaptureVote(req, env, origin);
      }

      // --- Report/Capture 벌점/상점 반영 (report-penalty.js) ---
      if (url.pathname === "/admin/captures/decide" && req.method === "POST") {
        return await handleAdminCaptureDecide(req, env, origin);
      }
      if (url.pathname === "/admin/captures/cancel-penalty" && req.method === "POST") {
        return await handleAdminCaptureCancel(req, env, origin);
      }
      if (url.pathname === "/admin/captures/cancel-merit" && req.method === "POST") {
        return await handleAdminCaptureCancelMerit(req, env, origin);
      }
      if (url.pathname === "/admin/captures/delete" && req.method === "POST") {
        return await handleAdminCaptureDelete(req, env, origin);
      }
      if (url.pathname === "/admin/captures/revert" && req.method === "POST") {
        return await handleAdminCaptureRevert(req, env, origin);
      }

      // --- 참여자 명단(index.js, ParticipantsRoster DO) ---
      if (url.pathname === "/participants" && req.method === "PUT") {
        return await handlePutParticipants(req, env, origin);
      }
      if (url.pathname === "/participants" && req.method === "GET") {
        return await handleGetParticipants(req, env, origin);
      }

      // --- 개인 대시보드/랭킹 (personal-status.js) ---
      if (url.pathname === "/status" && req.method === "GET") {
        return await handleStatus(req, env, origin, url);
      }
      if (url.pathname === "/me/role" && req.method === "GET") {
        // index.js — 관리자 여부와 무관한 공동 검토자 자기 조회.
        return await handleMyRole(req, env, origin);
      }
      if (url.pathname === "/cycles" && req.method === "GET") {
        // cycle.js
        return await handleCycleList(req, env, origin, url);
      }
      if (url.pathname === "/admin/cycles" && req.method === "GET") {
        // cycle.js — 관리자 전용 "사이클 범위 선택" 드롭다운: 현재 사이클
        // 제약 없이 백업이 남아있는 전체 이력을 3주 단위로 그룹핑해 반환.
        return await handleAdminCycleGroups(req, env, origin);
      }
      if (url.pathname === "/goal-schedule" && req.method === "GET") {
        // index.js — 목표시간 다음 주 예약.
        return await handleGetGoalSchedule(req, env, origin);
      }
      if (url.pathname === "/goal-schedule" && req.method === "POST") {
        return await handleSetGoalSchedule(req, env, origin);
      }

      // --- 사유반휴/일반반휴 (leave.js) ---
      if (url.pathname === "/leave-apply" && req.method === "GET") {
        return await handleGetLeaveApply(req, env, origin, url);
      }
      if (url.pathname === "/leave-apply" && req.method === "POST") {
        return await handleSetLeaveApply(req, env, origin);
      }
      if (url.pathname === "/admin/leave-apply" && req.method === "POST") {
        return await handleAdminLeaveApply(req, env, origin);
      }
      if (url.pathname === "/reason-leave-proof" && req.method === "GET") {
        return await handleGetReasonLeaveProof(req, env, origin, url);
      }
      if (url.pathname === "/reason-leave-proof" && req.method === "POST") {
        return await handleSetReasonLeaveProof(req, env, origin);
      }
      if (url.pathname === "/reason-leave-proof/cancel" && req.method === "POST") {
        return await handleCancelReasonLeaveProof(req, env, origin);
      }
      if (url.pathname === "/admin/leave-proof" && req.method === "GET") {
        return await handleAdminLeaveProofList(req, env, origin, url);
      }
      if (url.pathname === "/admin/leave-proof/file" && req.method === "GET") {
        return await handleAdminLeaveProofFile(req, env, origin, url);
      }
      if (url.pathname === "/admin/leave-proof/decide" && req.method === "POST") {
        return await handleAdminLeaveProofDecide(req, env, origin);
      }

      // --- 랭킹/로스터 (roster-status.js) ---
      if (url.pathname === "/roster-status" && req.method === "GET") {
        return await handleRosterStatus(req, env, origin, url);
      }

      // --- 회원 관리(CRUD/번호 재배치) (members.js) ---
      if (url.pathname === "/admin/members" && req.method === "GET") {
        return await handleAdminMembers(req, env, origin, url);
      }
      if (url.pathname === "/admin/members/roster" && req.method === "GET") {
        return await handleAdminMembersRoster(req, env, origin);
      }
      if (url.pathname === "/admin/members/exited" && req.method === "GET") {
        // exit-candidates.js
        return await handleAdminExitedMembers(req, env, origin);
      }
      if (url.pathname === "/admin/members/parti-status" && req.method === "POST") {
        return await handleAdminSetPartiStatus(req, env, origin);
      }

      // --- 퇴실/재납 신청 (exit-request.js) ---
      if (url.pathname === "/exit-request" && req.method === "POST") {
        return await handleSetExitRequest(req, env, origin);
      }
      if (url.pathname === "/exit-request/agree" && req.method === "POST") {
        return await handleAgreeExitRequest(req, env, origin);
      }
      if (url.pathname === "/exit-request/cancel" && req.method === "POST") {
        return await handleCancelExitRequest(req, env, origin);
      }

      // --- 회원 관리(CRUD/번호 재배치) (members.js, 계속) ---
      if (url.pathname === "/admin/members/reorder-preview" && req.method === "GET") {
        return await handleAdminMemberReorderPreview(req, env, origin);
      }
      if (url.pathname === "/admin/members/reorder" && req.method === "POST") {
        return await handleAdminMemberReorder(req, env, origin);
      }
      if (url.pathname.startsWith("/admin/members/") && req.method === "GET") {
        // personal-status.js — 회원번호별 상세 조회(퇴실자 접두사 분기 포함).
        const memberNumber = decodeURIComponent(url.pathname.slice("/admin/members/".length));
        return await handleAdminMemberStatus(req, env, origin, memberNumber, url);
      }
      if (url.pathname === "/admin/members" && req.method === "POST") {
        return await handleAdminCreateMember(req, env, origin);
      }
      if (url.pathname === "/admin/members/grant-access" && req.method === "POST") {
        return await handleGrantMemberAccess(req, env, origin);
      }
      if (url.pathname === "/admin/open-slots" && req.method === "GET") {
        return await handleAdminOpenSlots(req, env, origin);
      }

      // --- 벌금/납부 처리 (fines.js) ---
      if (url.pathname === "/admin/fines/unpaid" && req.method === "GET") {
        return await handleAdminFinesUnpaid(req, env, origin, url);
      }
      if (url.pathname === "/admin/fines/paid" && req.method === "GET") {
        return await handleAdminFinesPaid(req, env, origin, url);
      }
      if (url.pathname === "/admin/fines/exempt" && req.method === "GET") {
        return await handleAdminFinesExempt(req, env, origin, url);
      }
      if (url.pathname === "/admin/fines/status" && req.method === "POST") {
        return await handleAdminFineStatus(req, env, origin);
      }
      if (url.pathname === "/admin/fines/admin-forced-count" && req.method === "GET") {
        return await handleAdminFinesAdminForcedCount(req, env, origin);
      }

      // --- 랭킹/로스터 (roster-status.js, 계속: 상금 정산) ---
      if (url.pathname === "/admin/prize/settle" && req.method === "POST") {
        return await handleAdminPrizeSettle(req, env, origin);
      }

      // --- 퇴실/재납 후보 판정 (exit-candidates.js, 계속) ---
      if (url.pathname === "/admin/exit/candidates" && req.method === "GET") {
        return await handleAdminExitCandidates(req, env, origin, url);
      }

      // --- 퇴실/재납 확정 실행 (exit-confirm.js) ---
      if (url.pathname === "/admin/exit/preview" && req.method === "POST") {
        return await handleAdminExitPreview(req, env, origin);
      }
      if (url.pathname === "/admin/exit/confirm" && req.method === "POST") {
        return await handleAdminExitConfirm(req, env, origin);
      }

      // --- 퇴실/재납 후보 판정 (exit-candidates.js, 계속: 블랙리스트) ---
      if (url.pathname === "/admin/exit/blacklist" && req.method === "POST") {
        return await handleAdminExitBlacklist(req, env, origin);
      }
      if (url.pathname === "/admin/blacklist" && req.method === "GET") {
        return await handleAdminBlacklist(req, env, origin);
      }

      // --- 관리자 위임 OAuth (auth.js) ---
      if (url.pathname === "/oauth/authorize" && req.method === "GET") {
        return await handleAdminOAuthAuthorize(req, env, origin, url);
      }
      if (url.pathname === "/oauth/callback" && req.method === "GET") {
        return await handleAdminOAuthCallback(req, env, origin, url);
      }

      // --- 알림/푸시 (notify.js) ---
      if (url.pathname === "/push/subscribe" && req.method === "POST") {
        return await handlePushSubscribe(req, env, origin);
      }
      if (url.pathname === "/push/devices" && req.method === "GET") {
        return await handleListPushDevices(req, env, origin);
      }
      if (url.pathname === "/push/devices/toggle" && req.method === "POST") {
        return await handlePushDeviceToggle(req, env, origin);
      }
      if (url.pathname === "/push/devices/rename" && req.method === "POST") {
        return await handlePushDeviceRename(req, env, origin);
      }
      if (url.pathname === "/push/devices/remove" && req.method === "POST") {
        return await handlePushDeviceRemove(req, env, origin);
      }
      if (url.pathname === "/notify-prefs" && req.method === "GET") {
        return await handleGetNotifyPrefs(req, env, origin);
      }
      if (url.pathname === "/notify-prefs" && req.method === "POST") {
        return await handleSetNotifyPrefs(req, env, origin);
      }
      if (url.pathname === "/status-message" && req.method === "GET") {
        return await handleGetStatusMessage(req, env, origin);
      }
      if (url.pathname === "/status-message" && req.method === "POST") {
        return await handleSetStatusMessage(req, env, origin);
      }
      if (url.pathname === "/member-status-message" && req.method === "GET") {
        return await handleGetMemberStatusMessage(req, env, origin, url);
      }
      if (url.pathname === "/admin/push/send-category" && req.method === "POST") {
        return await handleAdminPushSendCategory(req, env, origin);
      }
      if (url.pathname === "/push/send-test" && req.method === "POST") {
        return await handlePushSendTest(req, env, origin);
      }
      if (url.pathname === "/push/send-to-member" && req.method === "POST") {
        return await handlePushSendToMember(req, env, origin);
      }
      if (url.pathname === "/push/subscription-status" && req.method === "GET") {
        return await handlePushSubscriptionStatus(req, env, origin);
      }
      if (url.pathname === "/push/recent-notices" && req.method === "GET") {
        return await handleListRecentNotices(req, env, origin);
      }
      return json({ error: "not found" }, 404, origin);
    } catch (err) {
      return json({ error: "서버 오류: " + err.message }, 500, origin);
    }
  },

  // 🔧 [90분 자동 위반인정 — 크론 도입] 원래 applyAutoRecognitionForExpired는
  // 별도 크론 없이 GET /admin/captures·GET /my-output-pen 조회 시점에만
  // 지연 평가됐다 — 관리자도 대상자 본인도 한동안 해당 화면을 열지 않으면
  // 90분이 훌쩍 지나도 자동 위반인정 자체가 무기한 보류될 수 있었다
  // (사용자 결정: "90분 후 자동"이라는 문구가 실제로도 시간 기준으로
  // 지켜지도록 크론으로 처리). 두 조회 경로의 지연 평가는 "혹시 크론이
  // 늦게 돌기 전에 조회하는 경우"를 위한 안전망으로 그대로 남겨둔다 —
  // 크론이 이미 처리해 둔 항목은 targetResponse가 채워져 있어 그 경로의
  // 필터(!item.targetResponse)에 걸리지 않으므로 중복 처리 위험이 없다.
  async scheduled(event, rawEnv) {
    const env = { ...rawEnv, REPORTS_KV: instrumentKvNamespace(rawEnv.REPORTS_KV, "(cron)", null) };
    // 🔧 [사용량 모니터링 고도화, 2026-09-11] 하루 누적 버퍼(_dailyUsageBuffer)
    // 를 UsageStats DO로 배치 전송한다 — 기존 90분 위반인정 로직과는 별도
    // try/catch로 분리해, flush 실패가 그 아래 기존 크론 작업을 막지
    // 않게 한다.
    try {
      await flushDailyUsageStats(env);
    } catch (e) {
      console.error("[cron] usage flush 실패:", e);
    }
    // 🔧 [48시간 자동 동의 — 사용자 지시] "신청자가 동의를 누르지 않으면
    // 48시간 뒤에는 자동 동의 처리" — 위 90분 자동 위반인정과 동일한
    // 이유로 별도 try/catch로 분리한다. 봇 연결과 무관한 로직(도움봇
    // 대시보드를 거치지 않고 시트/LeaveQueue DO만 조회)이라 아래
    // proxyToBotDashboard 실패 여부와도 독립적으로 항상 시도한다.
    try {
      await autoAgreeExpiredExitRequests(env);
    } catch (e) {
      console.error("[cron] 퇴실 신청 자동 동의 실패:", e);
    }
    const data = await proxyToBotDashboard(env, "/captures");
    if (!data) return; // 봇 연결 불가 — 다음 크론 실행이나 화면 조회 시 안전망이 재시도.
    await applyAutoRecognitionForExpired(env, data.items || []);
  },
};
