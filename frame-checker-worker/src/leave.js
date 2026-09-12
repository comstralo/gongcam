// 🔧 [구조 개선 11차, 2026-09-13] 사유반휴/일반반휴 도메인(신청/조회,
// 증빙 업로드→봇 대기열→관리자 승인)을 index.js에서 분리했다
// (docs/TESTING.md 참고). 조사 결과 listQueuedReasonLeaveDays를
// buildPersonalStatus(개인 대시보드, index.js 잔류)가 실사용으로
// 참조한다는 걸 확인했다 — 9~10차와 동일한 "실사용 import" 패턴으로
// index.js가 이 파일에서 재import한다(재export 아님, TDZ 위험 없음).
// flushQueuedReasonLeaveProofs도 봇 등록 핸들러(handleBotRegisterUrl,
// index.js 잔류)가 동일한 패턴으로 참조한다.
import {
  verifySession,
  getServiceAccountAccessToken,
  resolveMemberNumber,
  findMemberNumberByEmail,
  requireAdmin,
  json,
  corsHeaders,
  withMemberLock,
  getRosterStub,
  getSheetValues,
  writeSheetValues,
  safeNumber,
  parseLeaveCount,
  proxyToBotDashboard,
  proxyToBotDashboardRaw,
  resolveTargetFileId,
  STATUS_DAYS,
  STATUS_DAY_COLS,
  ROW_NORMAL_LEAVE_USE,
  ROW_NORMAL_LEAVE_LEFT,
  ROW_REASON_LEAVE_USE,
  ROW_REASON_LEAVE_LEFT,
} from "./index.js";
import { getLeaveQueueStub } from "./durable-objects.js";
import { currentWeekMondayKST, formatYYMMDD } from "./date-utils.js";

// --- 봇 오프라인 대기열(leaveq:*) 인덱스/처리 이력 — LeaveQueue DO 위임 ---
// 🔧 [KV → DO 이전, 2026-09-12] §47 — LeaveQueue DO의 Map은 정의상
// storage와 항상 동일한 단일 진실 소스라 KV list()의 "인덱스가 실제와
// 어긋날 수 있는" 문제 자체가 구조적으로 발생할 수 없다. 회원 단위 락
// (`leave:${memberNumber}`, "같은 회원이 같은 날 중복 신청하는 것" 방지
// 목적)은 인덱스 보호와 무관하므로 그대로 유지된다.
async function _readLeaveQueueIndex(env) {
  const res = await getLeaveQueueStub(env).fetch("https://do/leaveq/list");
  const { items } = await res.json();
  return items || [];
}

// 🔧 [PEN·MONEY 사이클 토글] 사유반휴 신청은 승인/반려 즉시 큐(leaveq:*)와
// 봇 manifest에서 삭제되어 처리 이력이 어디에도 남지 않는다 — 지난 사이클
// 조회를 지원하려면 처리 시점에 별도 영구 로그가 필요하다(사용자 지시).
// 시트 백업과 동일한 "그 주(월요일 weekOf)" 단위로 묶어, 키 하나
// (LeaveQueue DO의 history:{weekOf})에 그 주 처리 기록 전체를 배열로
// 누적한다 — TTL 없이 영구 보관. 처리는 항상 "지금"(과거 사이클을
// 재처리할 방법은 없음) 일어나므로, weekOf는 항상
// currentWeekMondayKST()(처리 시각=지금 기준)로 계산한다 — 사이클 조회
// 시 백업 파일의 weekOf와 그대로 매칭된다.
async function _appendLeaveHistory(env, entry) {
  const weekOf = formatYYMMDD(currentWeekMondayKST());
  await getLeaveQueueStub(env).fetch("https://do/history/append", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ weekOf, entry }),
  });
}

async function _readLeaveHistory(env, weekOf) {
  const res = await getLeaveQueueStub(env).fetch(`https://do/history/get?weekOf=${encodeURIComponent(weekOf)}`);
  const { items } = await res.json();
  return items || [];
}

// --- 목표시간 다음 주 예약과 별개, 반휴 신청 (개인 탭 20/21행, 선택한 요일 칸) ---
// 20/21행 셀에 "1"을 쓰면 시트 서식이 자동으로 "반휴 X 1"처럼 꾸며 보여준다 —
// parseLeaveCount가 셀 텍스트에서 숫자만 추출하므로 값은 항상 순수 숫자로만 쓴다.
// 어느 요일에든 신청/취소할 수 있게 day 파라미터로 대상 요일을 받는다.
// 🔧 [TDZ 방지] index.js가 이 파일을 import하는 시점(파일 최상단)은
// index.js 자신의 ROW_NORMAL_LEAVE_USE 등 export const 선언(파일 하단)
// 보다 앞이라, 이 객체를 모듈 최상위에서 즉시 만들면 아직 초기화 전인
// 값을 참조해 실제로 NaN이 되는 버그가 있었다(9~10차까지의 "재export
// 전용 순환"과 달리 이번엔 최상위에서 즉시 평가하는 게 문제였음) — 함수
// 안으로 옮겨 실제 요청 처리 시점(index.js 전체 평가가 끝난 뒤)에만
// 계산되게 한다.
function getLeaveTypeConfig(type) {
  const config = {
    normal: { useRow: ROW_NORMAL_LEAVE_USE, leftRow: ROW_NORMAL_LEAVE_LEFT, label: "일반반휴" },
    reason: { useRow: ROW_REASON_LEAVE_USE, leftRow: ROW_REASON_LEAVE_LEFT, label: "사유반휴" },
  };
  return config[type];
}

function statusColForDay(day) {
  const dayIndex = STATUS_DAYS.indexOf(day);
  return dayIndex === -1 ? null : STATUS_DAY_COLS[dayIndex];
}

// 일반반휴는 요일 셀에 1 또는 2를 직접 써서 그날 몇 장 쓸지 조절할 수
// 있다(시트 29행 수식이 이미 "반휴 2건 이상이면 그날 목표시간 면제"를
// count로 처리하므로 셀에 2를 써도 그대로 반영된다 — dailyGoalMinutes 참고).
// 사유반휴는 handleSetLeaveApply(직접 토글)로는 여전히 0/1만 지원하지만,
// 증빙 신청→승인 경로(handleSetReasonLeaveProof/handleAdminLeaveProofDecide)
// 로는 한 증빙에 count(1~2)를 실어 하루 2장까지 승인할 수 있다.
const LEAVE_MAX_COUNT_BY_TYPE = { normal: 2, reason: 1 };

// 하루(요일)에 한 종류의 반휴 셀에 최종적으로 쓸 수 있는 최댓값 — 일반/
// 사유 공용으로 쓰는 하루 합산 상한과 동일한 값이다(HalfDayLeaveDialog의
// MAX_LEAVES_PER_DAY와 일치시켜야 한다).
const MAX_LEAVES_PER_DAY_LIMIT = 2;

// 🔧 [관리자 대리 신청, 2026-09-10] number 쿼리 파라미터는 관리자에게만
// 허용한다 — 관리자가 다른 회원의 대시보드를 띄우면 LeaveApplyButton이
// 이 파라미터로 그 회원의 일반반휴 현재 상태를 조회해야, 관리자 본인이
// 아니라 그 회원의 값이 표시된다(handleAdminLeaveApply와 짝을 이룬다).
export async function handleGetLeaveApply(req, env, origin, url) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const type = url.searchParams.get("type");
  const day = url.searchParams.get("day");
  const numberParam = url.searchParams.get("number");
  const config = getLeaveTypeConfig(type);
  const col = statusColForDay(day);
  if (!config || col === null) return json({ error: "잘못된 요청입니다." }, 400, origin);
  if (numberParam) {
    const sheetNum = parseInt(numberParam, 10);
    if (!sheetNum || sheetNum < 1 || sheetNum > 15) return json({ error: "잘못된 요청입니다." }, 400, origin);
    // 🔧 [사용자 지시] "관리자 판정 비교 일관성" — session.email은 로그인
    // 시점부터 항상 소문자로 정규화되어 있어 지금은 위험이 없지만, 다른
    // 관리자 판정 지점(requireAdmin 등)과 동일하게 양쪽 다 소문자화해
    // 향후 이메일 저장 경로가 추가돼도 이 비교만 조용히 어긋나는 회귀를
    // 막는다.
    const isAdminSession = (session.email || "").toLowerCase() === (env.ADMIN_EMAIL || "").toLowerCase();
    if (!isAdminSession) return json({ error: "관리자만 다른 회원을 조회할 수 있습니다." }, 403, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const memberNumber = numberParam ? String(parseInt(numberParam, 10)) : await resolveMemberNumber(env, accessToken, session);
    const colLetter = String.fromCharCode("A".charCodeAt(0) + col);

    const [cellRows, leftRows] = await Promise.all([
      getSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, `${memberNumber}!${colLetter}${config.useRow + 1}`).catch(() => []),
      getSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, `${memberNumber}!C${config.leftRow + 1}`).catch(() => []),
    ]);
    const count = parseLeaveCount((cellRows[0] && cellRows[0][0]) || "");
    // left는 이 요일에 이미 쓴 count와 무관하게 시트에 남은 "전체 잔여"이므로,
    // 이 요일에서 더 늘릴 수 있는 최대치는 count + left(2장 상한 이내)다.
    const left = safeNumber((leftRows[0] && leftRows[0][0]) || 0);

    return json({ applied: count > 0, count, left }, 200, origin);
  } catch (err) {
    return json({ error: `${config.label} 조회 실패: ` + err.message }, 500, origin);
  }
}

// 🔧 [사용자 지시, 2026-09] "장난으로 반일 휴무를 계속 눌렀다 껐다 하면
// 쓰기 횟수가 계속 소진되는거 아니야?" — 신청/취소는 매번 진짜로 값이
// 바뀌는 조작이라(그리고 취소하면 잔여량도 다시 채워져 자연히 막히지도
// 않는다), 프론트의 "직전과 같은 값이면 무시" 방어만으로는 반복 토글을
// 못 막는다. 한 번의 토글마다 시트 쓰기 1회 + KV 삭제 1회
// (invalidatePersonalStatusCache)가 실제로 발생하므로, 회원 1명당 1분에
// 2회까지만 허용한다 — 정상 사용(신청 또는 취소 한 번)은 전혀 걸리지
// 않고, 연타 스팸만 막는다. 고정 60초 창 방식(슬라이딩 윈도우가 아님)
// 이라 창 경계에서 약간의 버스트 여지는 있지만, 이건 보안 목적이 아니라
// 남용 억제용이라 이 정도 근사로 충분하다.
async function checkAndRecordLeaveApplyRate(env, memberNumber) {
  const res = await getRosterStub(env).fetch("https://do/leave-rate/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memberNumber }),
  });
  const { allowed } = await res.json();
  return allowed;
}

export async function handleSetLeaveApply(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const body = await req.json().catch(() => ({}));
  const { type, day } = body;
  const config = getLeaveTypeConfig(type);
  const col = statusColForDay(day);
  const maxCount = LEAVE_MAX_COUNT_BY_TYPE[type] || 1;
  // 하위호환: applied(boolean)만 오면 0/1로, count(number)가 오면 그대로 쓴다.
  const count =
    typeof body.count === "number"
      ? body.count
      : typeof body.applied === "boolean"
        ? body.applied
          ? 1
          : 0
        : NaN;
  if (!config || col === null || !Number.isInteger(count) || count < 0 || count > maxCount) {
    return json({ error: "잘못된 요청입니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const memberNumber = await resolveMemberNumber(env, accessToken, session);

    if (!(await checkAndRecordLeaveApplyRate(env, memberNumber))) {
      return json({ error: "너무 자주 요청했습니다. 잠시 뒤 다시 시도해주세요." }, 429, origin);
    }

    const colLetter = String.fromCharCode("A".charCodeAt(0) + col);

    const cellRows = await getSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, `${memberNumber}!${colLetter}${config.useRow + 1}`).catch(() => []);
    const prevCount = parseLeaveCount((cellRows[0] && cellRows[0][0]) || "");

    if (count > prevCount) {
      const leftRows = await getSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, `${memberNumber}!C${config.leftRow + 1}`).catch(() => []);
      const left = safeNumber((leftRows[0] && leftRows[0][0]) || 0);
      if (count - prevCount > left) return json({ error: `${config.label} 잔여량이 없습니다.` }, 400, origin);
    }

    // 0일 때는 셀을 완전히 비운다 — 시트 서식이 0도 "반휴 X 0"처럼 표시해
    // 신청 이력처럼 보이는 것을 방지하기 위함.
    await writeSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, [
      { range: `${memberNumber}!${colLetter}${config.useRow + 1}`, values: [[count > 0 ? count : ""]] },
    ]);

    return json({ ok: true, applied: count > 0, count }, 200, origin);
  } catch (err) {
    return json({ error: `${config.label} 신청 실패: ` + err.message }, 500, origin);
  }
}

// 🔧 [관리자 대리 신청, 2026-09-10] "대시보드에서 오늘이 아닌 과거 일자의
// 반일 휴무 신청은 블락하되, 관리자가 다른 회원의 대시보드를 띄웠을 때는
// 예외로 허용" — 실수로 신청을 놓친 회원을 관리자가 대신 등록해줄 수
// 있어야 한다는 요구사항(사용자 지시). handleSetLeaveApply/
// handleAdminLeaveProofDecide는 둘 다 "세션 본인"(memberNumber를
// resolveMemberNumber로 찾음) 또는 "이미 접수된 증빙 큐 항목"만 다뤄서,
// "관리자가 임의 회원의 임의 요일에 즉시 반영"하는 경로가 없었다.
// type(normal/reason) 공용 — 일반반휴는 handleSetLeaveApply와 동일하게
// 셀에 count를 직접 쓰고, 사유반휴는 handleAdminLeaveProofDecide의 승인
// 로직(증빙 없이 관리자 직권으로 이미 확정된 값을 쓰는 것과 동일한 셈)을
// 그대로 재사용해 즉시 반영한다 — 증빙 대기열(leaveq:)을 거치지 않는다.
// 요일 제한이 전혀 없다 — 관리자 전용이라 과거 요일도 항상 허용한다.
export async function handleAdminLeaveApply(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { type, number, day, count: rawCount } = await req.json().catch(() => ({}));
  const config = getLeaveTypeConfig(type);
  const col = statusColForDay(day);
  const sheetNum = parseInt(number, 10);
  const maxCount = LEAVE_MAX_COUNT_BY_TYPE[type] || 1;
  const count = typeof rawCount === "number" ? rawCount : NaN;
  if (
    !config ||
    col === null ||
    !sheetNum ||
    sheetNum < 1 ||
    sheetNum > 15 ||
    !Number.isInteger(count) ||
    count < 0 ||
    count > maxCount
  ) {
    return json({ error: "잘못된 요청입니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const memberNumber = String(sheetNum);
    const colLetter = String.fromCharCode("A".charCodeAt(0) + col);

    const cellRows = await getSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, `${memberNumber}!${colLetter}${config.useRow + 1}`).catch(() => []);
    const prevCount = parseLeaveCount((cellRows[0] && cellRows[0][0]) || "");

    if (count > prevCount) {
      const leftRows = await getSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, `${memberNumber}!C${config.leftRow + 1}`).catch(() => []);
      const left = safeNumber((leftRows[0] && leftRows[0][0]) || 0);
      if (count - prevCount > left) return json({ error: `${config.label} 잔여량이 없습니다.` }, 400, origin);
    }

    await writeSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, [
      { range: `${memberNumber}!${colLetter}${config.useRow + 1}`, values: [[count > 0 ? count : ""]] },
    ]);

    // 사유반휴는 정식 승인 흐름(handleAdminLeaveProofDecide)과 동일하게
    // 처리 이력을 남긴다 — "지난 사이클 조회" 화면이 이 로그로 그 주의
    // 사유반휴 처리 내역을 보여주므로, 관리자 대리 신청도 빠지면 안 된다.
    if (type === "reason" && count > prevCount) {
      await _appendLeaveHistory(env, {
        id: `admin-apply-${Date.now()}`,
        decision: "approved",
        memberNumber,
        memberName: null,
        day,
        reason: "관리자 대리 신청",
        rejectReason: null,
        decidedAt: Date.now(),
      }).catch(() => {});
    }

    return json({ ok: true, number: memberNumber, applied: count > 0, count }, 200, origin);
  } catch (err) {
    return json({ error: `${config.label} 대리 신청 실패: ` + err.message }, 500, origin);
  }
}

// --- 사유반휴 신청/승인 (증빙 이미지 업로드 → 봇 대기열 → 관리자 승인 시 시트 반영) ---
// 일반반휴는 handleSetLeaveApply처럼 즉시 시트에 반영되지만, 사유반휴는 진단서 등
// 실물 증빙이 필요해 관리자 확인 전까지는 시트를 건드리지 않는다. 대기 상태 자체는
// 도움봇(study_sw/bot/dashboard_server.py)의 runtime/leave_proof/manifest.json에
// append-only로 쌓이고, Worker는 그 목록을 그대로 프록시하거나(조회) 승인 시점에만
// LEAVE_TYPE_CONFIG.reason 경로로 시트에 값을 쓴다(handleSetLeaveApply와 동일 로직).

export async function handleGetReasonLeaveProof(req, env, origin, url) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const day = url.searchParams.get("day");
  if (statusColForDay(day) === null) return json({ error: "잘못된 요청입니다." }, 400, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const memberNumber = await resolveMemberNumber(env, accessToken, session);

    // 봇 오프라인 대기열(leaveq:*)에 이 회원·요일 신청이 남아있으면 봇에
    // 도달하기도 전이지만 학생 화면에는 동일하게 "대기 중"으로 보여준다.
    const hasQueuedEntry = await hasQueuedReasonLeaveProof(env, memberNumber, day);
    if (hasQueuedEntry) return json({ pending: true, rejected: null }, 200, origin);

    const data = await proxyToBotDashboard(env, "/leave-proof?number=" + encodeURIComponent(memberNumber));
    const items = (data && data.items) || []; // 봇이 이미 ts 내림차순 정렬해 반환
    const latest = items.find((item) => item.day === day);

    if (!latest || latest.reviewStatus === "approved") {
      return json({ pending: false, rejected: null }, 200, origin);
    }
    if (latest.reviewStatus === "pending") {
      return json({ pending: true, rejected: null }, 200, origin);
    }
    return json({ pending: false, rejected: { reason: latest.rejectReason || "" } }, 200, origin);
  } catch (err) {
    return json({ error: "사유반휴 신청 조회 실패: " + err.message }, 500, origin);
  }
}

// 봇 오프라인 대기열(leaveq:*)에서 특정 회원의 신청 요일 목록을 모은다.
// hasQueuedReasonLeaveProof/buildPersonalStatus(index.js, 개인 대시보드)가
// 함께 재사용한다.
export async function listQueuedReasonLeaveDays(env, memberNumber) {
  // 🔧 [list() 제거] 이 함수는 buildPersonalStatus를 거쳐 /status를 열 때마다
  // 호출되어(2026-08 실측: KV list() 하루 한도 1,000회 소진의 주된 원인으로
  // 확인됨) list() 대신 인덱스를 읽는다.
  const items = await _readLeaveQueueIndex(env);
  return items.filter((it) => it.memberNumber === memberNumber).map((it) => it.day);
}

async function hasQueuedReasonLeaveProof(env, memberNumber, day) {
  const days = await listQueuedReasonLeaveDays(env, memberNumber);
  return days.includes(day);
}

// base64는 원본 대비 약 1.37배로 길어진다 — 5MB * 1.37 ≈ 6.85MB 문자열 길이를
// 넘으면 봇까지 프록시하지 않고 바로 거절한다(정확한 검증은 봇이 디코드 후 재검증).
const LEAVE_PROOF_MAX_BASE64_LENGTH = 7_000_000;

export async function handleSetReasonLeaveProof(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const { day, reason, imageBase64, imageExt, count: rawCount } = await req.json().catch(() => ({}));
  // count: 같은 증빙으로 이 요일에 한 번에 신청할 장수(1 또는 2, 미지정 시 1).
  const count = rawCount === undefined ? 1 : rawCount;
  const col = statusColForDay(day);
  if (
    col === null ||
    !reason ||
    !imageBase64 ||
    (imageExt !== "jpg" && imageExt !== "png") ||
    (count !== 1 && count !== 2)
  ) {
    return json({ error: "잘못된 요청입니다." }, 400, origin);
  }
  if (imageBase64.length > LEAVE_PROOF_MAX_BASE64_LENGTH) {
    return json({ error: "이미지 용량이 너무 큽니다. 5MB 이하로 첨부해주세요." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    let memberNumber = session.memberNumber;
    let memberName = session.memberName;
    if (!memberNumber) {
      const member = await findMemberNumberByEmail(env, accessToken, env.GOOGLE_SHEET_FILE_ID, session.email);
      if (!member) return json({ error: "데이터 시트 명단에서 계정을 찾을 수 없습니다." }, 403, origin);
      memberNumber = member.number;
      memberName = member.name;
    }

    const leftRows = await getSheetValues(
      env,
      accessToken,
      env.GOOGLE_SHEET_FILE_ID,
      `${memberNumber}!C${ROW_REASON_LEAVE_LEFT + 1}`
    ).catch(() => []);
    const left = safeNumber((leftRows[0] && leftRows[0][0]) || 0);
    if (left < count) return json({ error: "사유반휴 잔여량이 없습니다." }, 400, origin);

    // 🔧 [2차 점검, 2026-09-11] 이 `left` 검증은 시트의 잔여량만 볼 뿐, 이미
    // 큐/봇에 쌓인 같은 회원+같은 요일의 pending 신청 개수는 전혀 감안하지
    // 않았다 — 같은 학생이 두 기기(휴대폰+PC)에서 거의 동시에 신청하면 둘
    // 다 같은 left 스냅샷을 보고 통과해 중복 pending이 쌓일 수 있었다.
    // §36 락(승인 단계)은 "동시 읽기로 인한 계산 오류"만 막을 뿐, 애초에
    // "같은 요일 중복 신청"을 막는 검사가 신청 단계 자체에 없었던 건 락만
    // 추가해도 고쳐지지 않는 별개의 로직 결함이었다 — 두 요청이 순서대로
    // 처리돼도 "기존 pending 없음"을 똑같이 확인하고 각자 추가하기 때문.
    // handleGetReasonLeaveProof가 이미 쓰는 것과 동일한 두 경로(봇에 이미
    // 전달된 pending, KV 큐에 대기 중인 pending)를 모두 확인해 기존 신청이
    // 있으면 거절한다. 봇 조회(proxyToBotDashboard, 최대 8초)는
    // LOCK_WAIT_TIMEOUT_MS(15초) 여유가 빠듯해지므로 락 밖에서 먼저
    // 확인하고, "KV 큐 확인 + 큐 등록"만 §36과 동일한 `leave:${memberNumber}`
    // 락으로 원자적으로 묶어 두 기기의 요청이 순차 처리되게 한다.
    const existingBotStatus = await proxyToBotDashboard(
      env,
      "/leave-proof?number=" + encodeURIComponent(memberNumber)
    ).catch(() => null);
    const existingBotPending = ((existingBotStatus && existingBotStatus.items) || []).some(
      (item) => item.day === day && item.reviewStatus === "pending"
    );
    if (existingBotPending) {
      return json({ error: "이미 처리 대기 중인 신청이 있습니다." }, 409, origin);
    }

    const entry = {
      memberNumber,
      memberName,
      day,
      reason,
      requesterEmail: session.email,
      imageBase64,
      imageExt,
      count,
    };

    const lockResult = await withMemberLock(env, `leave:${memberNumber}`, async () => {
      if (await hasQueuedReasonLeaveProof(env, memberNumber, day)) {
        return { failure: true };
      }

      const data = await proxyToBotDashboard(env, "/leave-proof/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });
      if (data) return { data };

      // 🔧 [봇 오프라인 대기열] 봇이 꺼져 있으면 신청 자체를 실패시키지 않고
      // KV에 임시 보관했다가, 봇이 다시 켜져 handleBotRegisterUrl을 호출하는
      // 시점에 자동으로 흘려보낸다(flushQueuedReasonLeaveProofs). 학생 화면에는
      // 큐에 있든 봇에 이미 전달됐든 동일하게 "관리자 확인 중"으로 보인다
      // (handleGetReasonLeaveProof가 큐도 함께 조회).
      const queueId = crypto.randomUUID();
      const ts = Date.now();
      // 🔧 [KV → DO 이전, 2026-09-12] leaveq: KV put + 인덱스 갱신을
      // LeaveQueue DO 호출 한 번으로 대체(§47 참고).
      await getLeaveQueueStub(env).fetch("https://do/leaveq/put", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: queueId, entry: { ...entry, ts } }),
      });
      return { queueId };
    });
    if (lockResult.failure) {
      return json({ error: "이미 처리 대기 중인 신청이 있습니다." }, 409, origin);
    }
    if (lockResult.data) return json(lockResult.data, 200, origin);
    return json({ ok: true, id: lockResult.queueId, queued: true }, 200, origin);
  } catch (err) {
    return json({ error: "사유반휴 신청 실패: " + err.message }, 500, origin);
  }
}

// 학생 본인이 대기 중(pending)인 사유반휴 신청을 스스로 철회한다. 큐(KV)에
// 있으면 그냥 삭제하고, 이미 봇에 넘어간 pending 항목이면 관리자용
// "반려"와 동일한 경로(/leave-proof/decide)로 처리해 manifest 상태만
// rejected로 바꾼다(시트는 애초에 건드리지 않은 상태이므로 손댈 것이 없다).
export async function handleCancelReasonLeaveProof(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const { day } = await req.json().catch(() => ({}));
  if (statusColForDay(day) === null) return json({ error: "잘못된 요청입니다." }, 400, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const memberNumber = await resolveMemberNumber(env, accessToken, session);

    // 🔧 [KV → DO 이전, 2026-09-12] list() 대신 DO에서 찾는다.
    const queued = await _readLeaveQueueIndex(env);
    const match = queued.find((it) => it.memberNumber === memberNumber && it.day === day);
    if (match) {
      await getLeaveQueueStub(env).fetch("https://do/leaveq/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: match.id }),
      });
      return json({ ok: true }, 200, origin);
    }

    const data = await proxyToBotDashboard(env, "/leave-proof?number=" + encodeURIComponent(memberNumber));
    const items = (data && data.items) || [];
    const pending = items.find((item) => item.day === day && item.reviewStatus === "pending");
    if (!pending) return json({ error: "철회할 신청이 없습니다." }, 400, origin);

    const decideData = await proxyToBotDashboard(env, "/leave-proof/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: pending.id, decision: "rejected", rejectReason: "본인 철회" }),
    });
    if (!decideData) return json({ error: "봇에 연결할 수 없습니다." }, 502, origin);
    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "사유반휴 철회 실패: " + err.message }, 500, origin);
  }
}

// 🔧 [봇 오프라인 대기열 배출] 봇이 재기동해 자기 URL을 등록하는 순간(=이제
// 도달 가능해진 순간) 대기열에 쌓인 leaveq 항목을 순서대로 봇에 전달한다.
// 개별 항목 실패는 조용히 건너뛰고(다음 등록 시점에 재시도되도록 큐에 남김)
// 전체 흐름을 막지 않는다 — register-url 응답 자체가 늦어지면 봇 기동에
// 영향을 줄 수 있으므로 항목당 처리도 짧게 유지한다.
export async function flushQueuedReasonLeaveProofs(env) {
  const stub = getLeaveQueueStub(env);
  const res = await stub.fetch("https://do/leaveq/list-full");
  const { items } = await res.json();
  for (const { id: queueId, ...entry } of items || []) {
    try {
      // 큐의 원래 id를 그대로 봇에 전달한다 — 그러지 않으면 봇이 새 id로
      // 레코드를 만들어, 관리자가 이미 이 큐 id 기준으로 승인/반려하고
      // 큐를 지운 뒤에도 봇 쪽엔 처리되지 않은 유령 pending이 남는다
      // (레이스: flush와 handleAdminLeaveProofDecide가 동시에 이 항목을
      // 다룰 때). 봇이 같은 id를 그대로 채택하므로 이후 처리 여부가 항상
      // 하나의 레코드로 합쳐진다.
      const data = await proxyToBotDashboard(env, "/leave-proof/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...entry, id: queueId }),
      });
      if (data) {
        await stub.fetch("https://do/leaveq/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: queueId }),
        });
      }
    } catch {
      // 파싱 실패 등 복구 불가능한 항목은 다음에도 계속 실패할 것이므로 지운다.
      await stub.fetch("https://do/leaveq/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: queueId }),
      });
    }
  }
}

// KV 큐(leaveq:*) 항목을 관리자 목록 아이템 형태로 변환한다. queueId를
// id로 그대로 쓰고 queued:true를 붙여, 목록/승인/반려 핸들러가 "봇 없이
// 큐에만 있는 신청"을 구분해 처리할 수 있게 한다.
async function listQueuedReasonLeaveItems(env) {
  const queued = await _readLeaveQueueIndex(env);
  return queued.map((it) => ({
    id: it.id,
    memberNumber: it.memberNumber,
    memberName: it.memberName,
    day: it.day,
    reason: it.reason,
    requesterEmail: it.requesterEmail,
    count: it.count || 1,
    ts: it.ts || 0,
    reviewStatus: "pending",
    rejectReason: null,
    queued: true,
  }));
}

export async function handleAdminLeaveProofList(req, env, origin, url) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  // 🔧 [PEN·MONEY 사이클 토글] cycle 쿼리 파라미터가 있으면 그 주(월~일,
  // KST)의 처리 이력(_appendLeaveHistory가 쌓은 leaveHistory:{weekOf})을
  // 대신 보여준다 — 대기 큐/봇 목록과 달리 이건 이미 처리 완료된 읽기
  // 전용 기록이라 승인/반려 액션 없이 결과만 노출한다. 다른 사이클 지원
  // 핸들러(handleAdminFinesUnpaid 등)와 동일하게 resolveTargetFileId 실패
  // (사이클 범위를 벗어난 fileId 등)를 try/catch로 감싸 의미 있는 에러로 응답한다.
  const cycleFileId = url ? url.searchParams.get("cycle") : null;
  if (cycleFileId) {
    try {
      const accessToken = await getServiceAccountAccessToken(env);
      const { weekOf } = await resolveTargetFileId(env, accessToken, cycleFileId);
      const history = weekOf ? await _readLeaveHistory(env, weekOf) : [];
      const items = history
        .map((h) => ({
          id: h.id,
          memberNumber: h.memberNumber,
          memberName: h.memberName,
          day: h.day,
          reason: h.reason,
          requesterEmail: null,
          count: h.count || 1,
          ts: h.decidedAt,
          reviewStatus: h.decision,
          rejectReason: h.rejectReason || null,
          queued: false,
        }))
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
      return json({ items, readOnly: true }, 200, origin);
    } catch (err) {
      return json({ error: "사유반휴 처리 이력 조회 실패: " + err.message }, 500, origin);
    }
  }

  // 봇이 꺼져 있어도 관리자가 대기 중인 신청을 놓치지 않도록, 봇 목록과
  // KV 큐(아직 봇에 도달하지 못한 신청)를 합쳐서 보여준다. 봇이 응답하지
  // 않으면 빈 배열로 취급하고 큐만이라도 반환한다(봇 완전 다운 시에도
  // 관리자가 큐 항목을 승인/반려할 수 있어야 하므로).
  const [botData, queuedItems] = await Promise.all([
    proxyToBotDashboard(env, "/leave-proof?status=pending"),
    listQueuedReasonLeaveItems(env),
  ]);
  const botItems = (botData && botData.items) || [];
  const items = [...queuedItems, ...botItems].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return json({ items, readOnly: false }, 200, origin);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function handleAdminLeaveProofFile(req, env, origin, url) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const id = url.searchParams.get("id") || "";
  if (!id) return json({ error: "id가 필요합니다." }, 400, origin);

  // 큐(DO)에만 있는 신청이면 봇을 거치지 않고 저장된 base64를 그대로
  // 서빙한다 — 봇이 꺼져 있어도 증빙 미리보기가 가능해야 한다.
  const queuedRes = await getLeaveQueueStub(env).fetch(`https://do/leaveq/get?id=${encodeURIComponent(id)}`);
  if (queuedRes.ok) {
    try {
      const { entry } = await queuedRes.json();
      const contentType = entry.imageExt === "png" ? "image/png" : "image/jpeg";
      return new Response(base64ToBytes(entry.imageBase64), {
        status: 200,
        headers: { "Content-Type": contentType, ...corsHeaders(origin) },
      });
    } catch {
      return json({ error: "증빙 이미지를 읽지 못했습니다." }, 500, origin);
    }
  }

  const res = await proxyToBotDashboardRaw(env, "/leave-proof/file?id=" + encodeURIComponent(id));
  if (!res) {
    return json({ error: "봇에 연결할 수 없습니다." }, 502, origin);
  }
  return new Response(res.body, {
    status: 200,
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "application/octet-stream",
      ...corsHeaders(origin),
    },
  });
}

export async function handleAdminLeaveProofDecide(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const {
    id,
    decision,
    memberNumber,
    day,
    rejectReason,
    count: rawCount,
    memberName,
    reason,
  } = await req.json().catch(() => ({}));
  // count: 이 증빙으로 승인 시 반영할 장수(1 또는 2) — 신청 시점에 학생이
  // 고른 값을 목록 아이템(item.count)에서 그대로 넘겨받는다. 미지정 시 1.
  const count = rawCount === undefined ? 1 : rawCount;
  // memberName/reason: 목록 화면이 이미 갖고 있는 표시용 정보를 그대로
  // 넘겨받아 처리 이력 로그(_appendLeaveHistory)에 함께 남긴다 — 권한
  // 판정에는 쓰이지 않는 순수 표시값이라 클라이언트 제공값을 신뢰해도 된다.
  const col = statusColForDay(day);
  if (
    !id ||
    (decision !== "approved" && decision !== "rejected") ||
    !memberNumber ||
    col === null ||
    (count !== 1 && count !== 2)
  ) {
    return json({ error: "잘못된 요청입니다." }, 400, origin);
  }
  if (decision === "rejected" && !rejectReason) {
    return json({ error: "반려 사유를 입력해주세요." }, 400, origin);
  }

  // 큐(DO)에만 있는 신청(봇이 아직 못 받은 것)인지 먼저 확인한다 — 이
  // 경우 봇 프록시를 시도하지 않고 시트 반영 + 큐 삭제로 끝낸다(봇이
  // 꺼져 있어도 관리자가 승인/반려를 완결할 수 있어야 한다).
  const leaveQueueStub = getLeaveQueueStub(env);
  const isQueued = (await leaveQueueStub.fetch(`https://do/leaveq/get?id=${encodeURIComponent(id)}`)).ok;

  try {
    const accessToken = await getServiceAccountAccessToken(env);

    if (decision === "rejected") {
      if (isQueued) {
        await leaveQueueStub.fetch("https://do/leaveq/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        // 큐 확인과 이 시점 사이에 flushQueuedReasonLeaveProofs가 끼어들어
        // 봇에도 같은 id로 레코드가 막 생겼을 수 있다 — 있으면 정리하고,
        // 없으면(대부분의 경우) 404로 조용히 무시된다. 결과와 무관하게
        // 이 요청 자체는 이미 완료된 것으로 응답한다.
        await proxyToBotDashboard(env, "/leave-proof/decide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, decision, rejectReason }),
        }).catch(() => null);
        // 🔧 로그 기록 실패가 이미 완료된 처리(큐 삭제)를 실패로 되돌리면
        // 안 되므로(관리자가 "실패"로 오해해 재시도하면 중복 처리 위험)
        // 별도로 감싸 조용히 무시한다 — 이력 한 건이 안 쌓이는 것보다
        // 처리 자체가 실패로 보이는 게 훨씬 나쁘다.
        await _appendLeaveHistory(env, {
          id,
          decision,
          memberNumber,
          memberName: memberName || null,
          day,
          reason: reason || null,
          rejectReason,
          decidedAt: Date.now(),
        }).catch(() => null);
        return json({ ok: true }, 200, origin);
      }
      // 시트에는 아무것도 쓰지 않는다 — 반려된 신청은 처음부터 없었던 것과 같다.
      const data = await proxyToBotDashboard(env, "/leave-proof/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, decision, rejectReason }),
      });
      if (!data) return json({ error: "봇에 연결할 수 없습니다." }, 502, origin);
      await _appendLeaveHistory(env, {
        id,
        decision,
        memberNumber,
        memberName: memberName || null,
        day,
        reason: reason || null,
        rejectReason,
        decidedAt: Date.now(),
      }).catch(() => null);
      return json(data, 200, origin);
    }

    // 승인 — handleSetLeaveApply(count 지정)와 동일한 시트 반영 로직을 재사용한다.
    const colLetter = String.fromCharCode("A".charCodeAt(0) + col);
    // 🔧 [2차 점검, 2026-09-11] "같은 회원+같은 요일" 중복 pending 신청을
    // 막는 검사가 어디에도 없어(신청 시점도, 봇 큐도), 학생이 같은 요일에
    // 두 번 신청하면 별개 항목 2건이 관리자 목록에 그대로 쌓인다. 관리자
    // 두 명이 그 두 건을 거의 동시에 승인하면 이 "읽기(prevCount/left)→
    // 계산→쓰기"가 락 없는 read-modify-write라 나중 쓰기가 먼저 반영을
    // 덮어써 사용량 한 건이 조용히 소실되고, left 검증도 낡은 스냅샷
    // 기준이라 실제 잔여보다 초과 승인될 수 있었다(경쟁 조건 재검증 완료).
    // left(C41, 잔여량)는 요일과 무관하게 회원 전체가 공유하는 값이라,
    // 같은 회원의 다른 요일 승인과도 경쟁할 수 있어 락 범위를 요일이 아닌
    // 회원 단위(`leave:${memberNumber}`)로 잡는다 — 읽기·검증·쓰기 세
    // 단계 전부를 락 안에 넣어야 안전하므로, 그 뒤에 이어지는 큐 삭제·봇
    // 동기화·이력 기록(카운트 셀과 무관)은 락 밖에 그대로 둔다.
    const lockResult = await withMemberLock(env, `leave:${memberNumber}`, async () => {
      const [cellRows, leftRows] = await Promise.all([
        getSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, `${memberNumber}!${colLetter}${ROW_REASON_LEAVE_USE + 1}`).catch(() => []),
        getSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, `${memberNumber}!C${ROW_REASON_LEAVE_LEFT + 1}`).catch(() => []),
      ]);
      const prevCount = parseLeaveCount((cellRows[0] && cellRows[0][0]) || "");
      const left = safeNumber((leftRows[0] && leftRows[0][0]) || 0);
      const nextCount = Math.min(MAX_LEAVES_PER_DAY_LIMIT, prevCount + count);
      if (nextCount - prevCount > left) return { failure: true };

      await writeSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, [
        { range: `${memberNumber}!${colLetter}${ROW_REASON_LEAVE_USE + 1}`, values: [[nextCount]] },
      ]);
      return { failure: false };
    });
    if (lockResult.failure) return json({ error: "사유반휴 잔여량이 없습니다." }, 400, origin);

    if (isQueued) {
      // 봇을 거치지 않고 처리했으므로 큐에서 지우면 끝나지만, 큐 확인과
      // 이 시점 사이에 flushQueuedReasonLeaveProofs가 끼어들어 봇에도 같은
      // id로 pending 레코드가 막 생겼을 수 있다(레이스) — 있으면 approved로
      // 정리하고, 없으면 404로 조용히 무시된다. 이걸 빼먹으면 시트엔 이미
      // 반영됐는데 관리자 화면엔 처리 못하는 유령 pending이 남는다.
      await leaveQueueStub.fetch("https://do/leaveq/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await proxyToBotDashboard(env, "/leave-proof/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, decision: "approved" }),
      }).catch(() => null);
      await _appendLeaveHistory(env, {
        id,
        decision: "approved",
        memberNumber,
        memberName: memberName || null,
        day,
        reason: reason || null,
        rejectReason: null,
        decidedAt: Date.now(),
      }).catch(() => null);
      return json({ ok: true }, 200, origin);
    }

    // 시트 반영이 성공한 뒤에만 봇 manifest 상태를 갱신한다 — 순서를 바꾸면
    // "승인됐다고 표시되는데 시트엔 반영 안 된" 불일치가 생길 수 있다.
    const data = await proxyToBotDashboard(env, "/leave-proof/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision: "approved" }),
    });
    await _appendLeaveHistory(env, {
      id,
      decision: "approved",
      memberNumber,
      memberName: memberName || null,
      day,
      reason: reason || null,
      rejectReason: null,
      decidedAt: Date.now(),
    }).catch(() => null);
    if (!data) {
      return json({ ok: true, botSyncFailed: true }, 200, origin);
    }
    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "사유반휴 승인 처리 실패: " + err.message }, 500, origin);
  }
}
