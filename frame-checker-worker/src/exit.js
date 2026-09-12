// 🔧 [구조 개선 8차, 2026-09-13] 퇴실 처리(신청/동의/취소, 관리자 후보
// 조회/미리보기/확정, 강제퇴실·재납 시트 조작, 블랙리스트) 도메인을
// index.js에서 분리했다(docs/TESTING.md 참고). 6~7차와 동일하게 fetch
// mock + 실제 workerd DO 기반 통합 테스트를 먼저 깐 뒤 도메인을 통째로
// 옮겼다.
//
// buildPersonalStatus(개인 대시보드 /status 전용, exit은 호출만 함)와
// handleAdminMemberStatus/handleAdminMembersRoster(7차에서 이미 exit/
// cycle/DO까지 깊게 얽혀 제외 확정된 핸들러)는 이번에도 index.js에
// 남긴다 — listActiveMembersWithExitInfo는 이 파일로 옮기고
// handleAdminMembersRoster가 index.js에서 그대로 import한다.
// handleAdminFinesAdminForcedCount(벌금 도메인, index.js 잔류)도
// listExitedMemberEntries/getMemberSettingsStub을 참조하지만 라우팅상
// 벌금 도메인 소속이라 옮기지 않는다.
//
// cycle.js/deposit.js에서 이미 index.js가 import 후 재export하는
// 범용 함수(isUnguardedAdminForcedCycleCombo/resolveExitSourceFileId/
// resolveTargetFileId, calcForcedOutDeposit/calcExitProcess/
// countCurrentCyclePen/depositRefundBreakdown/forcedExitChecks)는
// index.js에서 그대로 다시 가져온다 — 실제 사용 목적 import라 6~7차와
// 같은 패턴(재export 전용 순환 아님)이다. withMemberLock/getRosterStub
// 같은 DO 락은 이 도메인이 쓰지 않는다(exit 확정은 시트 자체가
// 순차적으로 조작되고, 동시 확정 경쟁은 사용자 지시로 허용 범위 밖).
import {
  getServiceAccountAccessToken,
  requireAdmin,
  json,
  verifySession,
  resolveMemberNumber,
  listAllMembers,
  getSheetValues,
  writeSheetValues,
  getSheetIdsByNames,
  spreadsheetBatchUpdate,
  copySheetToSpreadsheet,
  copySheetWithName,
  protectSheetForOwnerAndService,
  getAdminAccessToken,
  getCurrentPenCycle,
  getSharedMemberRows,
  colIndexToLetter,
  _bumpUsageCounter,
  OUTPUT_PEN_SHEET_NAME,
  OUTPUT_PEN_SLOT_COLUMNS,
  STATUS_DAYS,
  ROW_JOIN_DATE,
  ROW_MORNING_FINE,
  ROW_PARTI_STATUS,
  COL_PARTI_STATUS,
  latestSlotDay,
  buildSlotHistory,
  listExitedMemberEntries,
  getMemberSettingsStub,
  getLeaveQueueStub,
  buildPersonalStatus,
  isUnguardedAdminForcedCycleCombo,
  resolveExitSourceFileId,
  resolveTargetFileId,
  requiresFineUnpaidRecheck,
  FINE_UNPAID_ADMIN_FORCED_REASON,
  exitDateSettled,
  EXIT_DEPOSIT_VALUE,
  parseWon,
} from "./index.js";
import { parseGoogleEmail, parseGooroomeeAccount } from "./member-utils.js";
import { todayKSTDateString } from "./date-utils.js";
import {
  _cachedCompute,
  invalidateMemberCache,
  invalidateMemberSlotCache,
  invalidatePersonalStatusCache,
} from "./cache.js";
import {
  countCurrentCyclePen,
  depositRefundBreakdown,
  forcedExitChecks,
  calcForcedOutDeposit,
  calcExitProcess,
} from "./deposit.js";

// Y2:AC3(제목)과 Y4:AC18(본문) 셀을 병합하고 결과 메시지를 채운다.
// _set_sheet_init의 백업 탭 "처리결과" 박스 서식과 동일하다.
async function writeExitResultBox(env, accessToken, fileId, sheetId, resultMsg) {
  const border = { style: "SOLID_MEDIUM", color: { red: 0.35, green: 0.35, blue: 0.35 } };
  const fullBorder = { top: border, bottom: border, left: border, right: border };
  function mergeAndFill(rangeGrid, text, background) {
    return [
      { mergeCells: { range: rangeGrid, mergeType: "MERGE_ALL" } },
      {
        updateBorders: {
          range: rangeGrid,
          top: border,
          bottom: border,
          left: border,
          right: border,
          innerHorizontal: border,
          innerVertical: border,
        },
      },
      {
        repeatCell: {
          range: rangeGrid,
          cell: {
            userEnteredValue: { stringValue: text },
            userEnteredFormat: {
              backgroundColor: background,
              horizontalAlignment: "CENTER",
              verticalAlignment: "MIDDLE",
              textFormat: { bold: true, fontSize: 11 },
            },
          },
          fields: "userEnteredValue,userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)",
        },
      },
    ];
  }
  const titleRange = { sheetId, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 24, endColumnIndex: 29 };
  const bodyRange = { sheetId, startRowIndex: 3, endRowIndex: 18, startColumnIndex: 24, endColumnIndex: 29 };
  const requests = [
    ...mergeAndFill(titleRange, "처리결과", { red: 0.988, green: 0.894, blue: 0.839 }),
    { mergeCells: { range: bodyRange, mergeType: "MERGE_ALL" } },
    {
      repeatCell: {
        range: bodyRange,
        cell: {
          userEnteredValue: { stringValue: resultMsg },
          userEnteredFormat: { horizontalAlignment: "LEFT", verticalAlignment: "MIDDLE", textFormat: { fontSize: 11 } },
        },
        fields: "userEnteredValue,userEnteredFormat(horizontalAlignment,verticalAlignment,textFormat)",
      },
    },
    {
      updateBorders: {
        range: bodyRange,
        top: border,
        bottom: border,
        left: border,
        right: border,
      },
    },
  ];
  await spreadsheetBatchUpdate(env, accessToken, fileId, requests);
}

// 이메일로 파일 편집자 권한을 회수한다(퇴실 처리 시 grantSheetAccess의 반대 동작).
// Drive API는 이메일로 직접 삭제할 수 없어 permissionId를 먼저 조회해야 한다.
async function revokeSheetAccess(env, fileId, email) {
  if (!email) return;
  const accessToken = await getAdminAccessToken(env);
  const listRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?fields=permissions(id,emailAddress)`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const listData = await listRes.json();
  const perm = (listData.permissions || []).find(
    (p) => (p.emailAddress || "").toLowerCase() === email.toLowerCase()
  );
  if (!perm) return;
  const delRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions/${perm.id}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!delRes.ok && delRes.status !== 404) {
    const data = await delRes.json().catch(() => ({}));
    throw new Error("Drive 편집자 권한 회수 실패: " + JSON.stringify(data));
  }
}

// "데이터" 탭 F4:M18(송출P+주간P 슬롯 전체)의 주석을 한 번의 spreadsheets.get
// 호출로 모두 읽는다. "페널티 대상자" 목록이 회원별로 "언제 2회에 도달했는지"를
// 알아야 하는데, 그 근거가 되는 발생일시가 슬롯 주석에만 있기 때문이다.
// 반환값은 행 인덱스(0-based, 4행=0)별 note 배열(F~M 8칸).
async function getPenaltySlotNotesGrid(env, accessToken, fileId) {
  _bumpUsageCounter("sheets_read");
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}?` +
      `ranges=${encodeURIComponent(`'${OUTPUT_PEN_SHEET_NAME}'!F4:M18`)}` +
      `&fields=sheets.data.rowData.values.note`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  const rowData = data.sheets && data.sheets[0] && data.sheets[0].data && data.sheets[0].data[0] && data.sheets[0].data[0].rowData;
  return (rowData || []).map((row) => (row.values || []).map((v) => (v && v.note) || ""));
}

// 셀에 입력된 수식 원문을 그대로 읽는다(계산 결과가 아니라 "=INDIRECT(...)"
// 같은 문자열 자체) — rewriteBackupAuditFormulas가 백업 탭의 수식을
// "데이터"에서 "데이터 (감사)" 참조로 치환할 때 원본 수식 문자열이 필요하다.
async function getSheetFormulas(env, accessToken, fileId, range) {
  _bumpUsageCounter("sheets_read");
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${encodeURIComponent(
      range
    )}?valueRenderOption=FORMULA`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!data.values) throw new Error("시트 수식 조회 실패: " + JSON.stringify(data));
  return data.values;
}

// 그 fileId(사이클)에 강제퇴실 대상이 있는지 판정하는 조회들이 반복해서
// 필요로 하는 회원별 상태(참여상태/가입일/예치금 반환 판정 재료/페널티
// 발생 요일)를 한 번에 계산해 10분 캐싱한다. listExitCandidates/
// listActiveMembersWithExitInfo/hasForcedCandidateInCycle(사이클 도메인,
// index.js 잔류)이 모두 이 캐시를 공유한다.
async function getAllExitRelevantStatus(env, accessToken, fileId, members) {
  return _cachedCompute(env, `exitStatus:${fileId}`, 10 * 60_000, async () => {
    const [allRows, dataRows, currentCycle, notesGrid, exitRequests] = await Promise.all([
      getSharedMemberRows(env, accessToken, fileId, members),
      getSheetValues(env, accessToken, fileId, "데이터!F4:M18"),
      getCurrentPenCycle(env, accessToken, fileId),
      getPenaltySlotNotesGrid(env, accessToken, fileId),
      // 🔧 [고지지연 반영] 관리자용 목록(퇴실 후보/스터디원 목록)도 개인
      // 대시보드(buildPersonalStatus)와 동일하게 실제 퇴실 신청일을 반영해야
      // 반환 예상액이 어긋나지 않는다.
      listExitRequests(env),
    ]);

    return members.map((member, i) => {
      const rows = allRows[i];
      if (!rows || rows.length <= ROW_MORNING_FINE) return null;
      const partiStatus = (rows[ROW_PARTI_STATUS] && rows[ROW_PARTI_STATUS][COL_PARTI_STATUS]) || "";
      const joinDate = (rows[ROW_JOIN_DATE] && rows[ROW_JOIN_DATE][8]) || "";
      const rowIdx = parseInt(member.number, 10) - 1;
      const dataRow = dataRows[rowIdx] || [];
      const values = OUTPUT_PEN_SLOT_COLUMNS.map((_, idx) => parseInt(dataRow[idx], 10) || 0);
      const timePenValues = [parseInt(dataRow[6], 10) || 0, parseInt(dataRow[7], 10) || 0];
      const penCounts = countCurrentCyclePen({ values, timePenValues }, currentCycle);
      const exitRequestDate = (exitRequests.get(member.number) || {}).exitDate || null;
      const breakdown = depositRefundBreakdown(rows, penCounts, exitRequestDate);
      const slotNotes = notesGrid[rowIdx] || [];
      const occurredDay = latestSlotDay([...values, ...timePenValues], slotNotes);
      const outputPenHistory = buildSlotHistory(values, slotNotes.slice(0, 6), "송출 P");
      const timePenHistory = buildSlotHistory(timePenValues, slotNotes.slice(6, 8), "주간 P");
      return { member, partiStatus, joinDate, breakdown, occurredDay, outputPenHistory, timePenHistory };
    });
  });
}

// PENALTY 탭 "페널티 대상자" — 페널티 누적 2회 이상(강제 퇴실자 조건 중
// 하나)인 회원만 추린다. 다른 강제 퇴실 조건(30일 미만/벌금·예치금 미납)에
// 걸린 회원은 이 목록이 아니라 MEMBER 탭에서 함께 다룬다.
export async function listExitCandidates(env, accessToken, fileId) {
  const members = await listAllMembers(env, accessToken, fileId);
  const statuses = await getAllExitRelevantStatus(env, accessToken, fileId, members);
  return statuses
    .filter(Boolean)
    .filter((s) => !/^(퇴실자|재납자)/.test(s.partiStatus))
    .map((s) => ({ ...s, forced: calcForcedOutDeposit(s.breakdown) }))
    .filter((s) => s.forced && s.forced.reasons.some((r) => r.code === "penalty_2_or_more"))
    .map((s) => ({
      number: s.member.number,
      name: s.member.name,
      suggestedKind: "forced",
      reasons: s.forced.resultStr,
      reasonCodes: s.forced.reasons,
      allChecks: forcedExitChecks(s.breakdown),
      // 채워진 송출P/주간P 슬롯 주석 중 가장 최근 날짜의 요일 — "예치금
      // 재납 대상자" 목록을 화각 제보 검토와 동일하게 요일별로 묶어 보여주는
      // 데 쓰인다. 주석이 하나도 없으면(예: 아주 예전 슬롯) null.
      occurredDay: s.occurredDay,
      // 개인별 상세 카드의 "송출 P 적립 기록"/"주간 P 적립 기록" 섹션에
      // 그대로 뿌려지는 슬롯별 이력(차수·발생일시·사유).
      outputPenHistory: s.outputPenHistory,
      timePenHistory: s.timePenHistory,
    }));
}

// 회원 본인이 "퇴실하겠다"고 미리 알리는 가벼운 표시 — 실제 시트 반영(백업
// 탭 이동/초기화)은 여전히 관리자가 확정해야만 일어난다. 이 항목은 순수하게
// "스터디원 목록"에 "퇴실 예약" 뱃지를 보여주기 위한 상태일 뿐, 시트에는
// 아무 영향도 주지 않는다.
export async function handleSetExitRequest(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const { exitDate } = await req.json().catch(() => ({}));
  if (exitDate && !/^\d{4}-\d{2}-\d{2}$/.test(exitDate)) {
    return json({ error: "희망 퇴실일 형식이 올바르지 않습니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const memberNumber = await resolveMemberNumber(env, accessToken, session);
    const ts = Date.now();
    // 새로 신청할 때마다 동의 상태는 초기화한다 — 신청을 취소했다가 다시
    // 하거나, 신청 날짜를 바꾸는 경우 이전 동의가 그대로 남아있으면 안 된다.
    await getLeaveQueueStub(env).fetch("https://do/exit/put", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberNumber, exitDate: exitDate || null, ts, agreedAt: null }),
    });
    // 🔧 [고지지연 반영] exitRequestDate가 이제 depositRefundBreakdown의
    // amount 계산에 쓰이므로, 신청 직후 본인 화면(personalStatus)과 관리자
    // 목록(exitStatus 등 MEMBER_CACHE_PREFIXES 그룹)에 옛 반환액이 남지
    // 않도록 함께 무효화한다.
    await Promise.all([
      invalidatePersonalStatusCache(env, env.GOOGLE_SHEET_FILE_ID, memberNumber),
      invalidateMemberCache(env, ["exitRequest"]),
    ]);
    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "퇴실 신청 실패: " + err.message }, 500, origin);
  }
}

// 회원 본인이 "예치금 정산액에 동의합니다"를 누르는 API — 퇴실 예약일
// (exitDate)의 일간 집계가 실제로 끝나야만(exitDateSettled) 누를 수 있다.
// 이 동의가 있어야만 관리자의 "정산" 처리 버튼이 활성화된다 — 신청만으로
// 관리자가 바로 확정 처리를 할 수 있었던 기존 흐름에, 회원이 최종 금액에
// 실제로 동의했는지 확인하는 단계를 하나 더 끼워넣는 것(사용자 지시).
export async function handleAgreeExitRequest(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const memberNumber = await resolveMemberNumber(env, accessToken, session);
    const leaveQueueStub = getLeaveQueueStub(env);
    const existingRes = await leaveQueueStub.fetch(`https://do/exit/get?memberNumber=${encodeURIComponent(memberNumber)}`);
    const { entry: existing } = await existingRes.json();
    if (!existing) return json({ error: "퇴실 신청 내역이 없습니다." }, 404, origin);

    if (!existing.exitDate) {
      return json({ error: "마지막 참여일이 지정되지 않은 신청입니다." }, 400, origin);
    }
    if (!exitDateSettled(existing.exitDate)) {
      return json({ error: "아직 마지막 참여일의 일간 집계가 끝나지 않았습니다." }, 400, origin);
    }

    const agreedAt = Date.now();
    await leaveQueueStub.fetch("https://do/exit/put", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberNumber, exitDate: existing.exitDate, ts: existing.ts, agreedAt }),
    });
    await Promise.all([
      invalidatePersonalStatusCache(env, env.GOOGLE_SHEET_FILE_ID, memberNumber),
      invalidateMemberCache(env, ["exitRequest"]),
    ]);
    return json({ ok: true, agreedAt }, 200, origin);
  } catch (err) {
    return json({ error: "동의 처리 실패: " + err.message }, 500, origin);
  }
}

// 본인 또는 관리자가 취소할 수 있다 — 관리자는 body에 number를 지정해
// 다른 회원의 신청을 취소한다(스터디원 목록의 "퇴실 예약" 뱃지 옆에서 사용).
export async function handleCancelExitRequest(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  try {
    const { number: targetNumber } = await req.json().catch(() => ({}));
    let memberNumber = targetNumber;
    if (memberNumber) {
      const isAdmin = (session.email || "").toLowerCase() === (env.ADMIN_EMAIL || "").toLowerCase();
      if (!isAdmin) return json({ error: "관리자만 다른 회원의 신청을 취소할 수 있습니다." }, 403, origin);
    } else {
      const accessToken = await getServiceAccountAccessToken(env);
      memberNumber = await resolveMemberNumber(env, accessToken, session);
    }
    await getLeaveQueueStub(env).fetch("https://do/exit/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberNumber }),
    });
    await Promise.all([
      invalidatePersonalStatusCache(env, env.GOOGLE_SHEET_FILE_ID, memberNumber),
      invalidateMemberCache(env, ["exitRequest"]),
    ]);
    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "퇴실 신청 취소 실패: " + err.message }, 500, origin);
  }
}

// number -> {exitDate,ts,agreedAt} 맵. LeaveQueue DO에서 조회한다.
async function listExitRequests(env) {
  const res = await getLeaveQueueStub(env).fetch("https://do/exit/list");
  const { items } = await res.json();
  return new Map(Object.entries(items || {}));
}

// 🔧 [마지막 참여일 이후 집계 차단] 도움봇이 매 교시 시트에 기록하기 전,
// "이미 마지막 참여일이 지난 퇴실 신청 회원"을 걸러낼 수 있도록 exitDate만
// 뽑아 내려준다. 관리자가 확정 처리를 늦게 하더라도(sheet_reset을 넘기는
// 경우까지 포함), 그 사이 봇이 결석 기록("00:00"/ERR)을 계속 남겨 새 벌금·
// 페널티가 발생하는 것을 막기 위한 용도 — Worker/앱스크립트는 시트 자체를
// 건드리지 않고, 데이터를 만드는 첫 지점(도움봇)에서 원천 차단한다.
export async function handleBotExitRequests(req, env, origin) {
  const botSecret = req.headers.get("X-Bot-Secret");
  if (!botSecret || botSecret !== env.BOT_SECRET) {
    return json({ error: "unauthorized" }, 401, origin);
  }
  const exitRequests = await listExitRequests(env);
  const exitDates = {};
  for (const [number, entry] of exitRequests) {
    if (entry && entry.exitDate) exitDates[number] = entry.exitDate;
  }
  return json({ exitDates }, 200, origin);
}

// "퇴실 스터디원 목록" 전용 — 원본 스프레드시트에 남은 퇴실자 백업 탭
// 각각에, 확정 처리 시점에 저장해둔 결과(MemberSettingsDO의 exitResult)를
// 함께 붙여 반환한다. 이 기능 도입(2026-09) 이전에 처리된 퇴실자는 그
// 시점에 저장된 값이 없으므로 result: null로 내려간다 — 프론트가 "처리
// 결과를 조회할 수 없습니다(이 기능 도입 이전 처리)"로 안내한다.
export async function handleAdminExitedMembers(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    const exitedMembers = await listExitedMemberEntries(env, accessToken, fileId);

    const resultsRes = await getMemberSettingsStub(env).fetch("https://do/exit/list");
    const { items: allResults } = await resultsRes.json();
    const members = exitedMembers.map((m) => ({
      number: m.number,
      name: m.name,
      result: allResults[m.name] || null,
    }));

    return json({ members }, 200, origin);
  } catch (err) {
    return json({ error: "퇴실 스터디원 목록 조회 실패: " + err.message }, 500, origin);
  }
}

// MEMBER 탭 "스터디원 목록"용 — 이미 퇴실/재납 처리된 회원을 제외한 전원을
// 반환한다(listExitCandidates와 달리 강제 조건 여부로 걸러내지 않음).
// 조건에 해당 없는 회원은 suggestedKind를 "settle"(자연 퇴실 처리 가능)로 둔다.
// handleAdminMembersRoster(회원 관리 도메인, 7차에서 index.js 잔류 확정)가
// index.js에서 이 함수를 그대로 import해서 쓴다.
export async function listActiveMembersWithExitInfo(env, accessToken, fileId) {
  const [members, exitRequests] = await Promise.all([
    listAllMembers(env, accessToken, fileId),
    listExitRequests(env),
  ]);
  const statuses = await getAllExitRelevantStatus(env, accessToken, fileId, members);
  return statuses
    .filter(Boolean)
    .filter((s) => !/^(퇴실자|재납자)/.test(s.partiStatus))
    .map((s) => {
      const forced = calcForcedOutDeposit(s.breakdown);
      const totalPen = s.breakdown.outputPen + s.breakdown.timePen;
      const exitRequest = exitRequests.get(s.member.number);
      return {
        number: s.member.number,
        name: s.member.name,
        joinDate: s.joinDate,
        totalPenalty: totalPen,
        suggestedKind: forced ? "forced" : "settle",
        reasons: forced ? forced.resultStr : [],
        reasonCodes: forced ? forced.reasons : [],
        allChecks: forcedExitChecks(s.breakdown),
        exitRequested: !!exitRequest,
        exitRequestDate: exitRequest?.exitDate || null,
        exitRequestedAt: exitRequest?.ts || null,
        exitAgreedAt: exitRequest?.agreedAt || null,
        partiStatus: s.partiStatus === "스터디장" || s.partiStatus === "부스터디장" ? s.partiStatus : "스터디원",
      };
    });
}

export async function handleAdminExitCandidates(req, env, origin, url) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const cycleFileId = url ? url.searchParams.get("cycle") : null;
    const { fileId } = await resolveTargetFileId(env, accessToken, cycleFileId);
    const candidates = await listExitCandidates(env, accessToken, fileId);
    // 지난 사이클(과거 백업) 조회면 그 시점의 대상자 명단만 보여주는 읽기
    // 전용 스냅샷이다 — 실제 강제 퇴실/재납 확정 액션은 현재 시트에서만
    // 의미가 있으므로, 프론트가 이 플래그로 처리 버튼을 잠근다.
    return json({ candidates, readOnly: !!cycleFileId }, 200, origin);
  } catch (err) {
    return json({ error: "퇴실 후보 조회 실패: " + err.message }, 500, origin);
  }
}

const EXIT_KIND_VALUES = ["forced", "admin_forced", "settle", "deposit_again"];

// 실제로 시트를 바꾸지 않고 discount_ratio/사유/결과 메시지만 계산해 돌려준다.
// 🔧 [2차 점검, 2026-09-11] Cloudflare KV 최종 일관성 재검증 — 벌점 승인
// (applyOutputPenalty)이 personalStatusBundle:을 지운 직후(승인이 실행된
// 리전에서만) 60초 내에 다른 리전 관리자가 같은 회원을 이 함수로 퇴실
// 판정하면, 그 리전의 KV 로컬 복제본엔 아직 delete가 전파되지 않아 낡은
// 페널티 상태(예: 강제퇴실 조건 미충족)를 읽고 반환금을 잘못 계산할 수
// 있음을 확인했다 — withMemberLock(뮤텍스)은 "동시 실행 순서"만 강제할
// 뿐, 락 해제 후에도 여전히 존재하는 "KV 자체의 리전 간 전파 지연"은
// 막지 못한다(뮤텍스로는 해결 안 됨을 재확인). `forceFresh`가 true면
// 퇴실 판정 직전에 이 회원의 personalStatusBundle:을 강제로 지운 뒤
// buildPersonalStatus를 호출해, 같은 요청 안에서 방금 지운 값을 그대로
// 다시 읽는(KV read-your-write는 같은 리전 내에서는 보장됨) 방식으로
// "이 판정 시점만큼은" 최대한 최신 값을 쓰도록 한다 — KV delete 자체도
// 최종 일관성 연산이라 이론상 완전한 해결은 아니지만(다른 리전의 delete가
// 이 리전에 아직 안 닿았을 가능성은 남음), §32와 동일한 수준의 실질적
// 안전장치다. 실제로 시트를 바꾸는 확정(handleAdminExitConfirm)에서만
// true로 넘긴다 — 미리보기(handleAdminExitPreview)는 다이얼로그를 열 때,
// 그리고 사유 입력 중 300ms 디바운스로 반복 호출되는 조회 전용 경로라
// 매번 강제 무효화하면 불필요한 KV delete+Sheets 재조회가 쌓인다.
async function computeExitResult(env, accessToken, fileId, number, name, kind, forcedReason, cycleFileId, forceFresh) {
  if (isUnguardedAdminForcedCycleCombo(kind, forcedReason, cycleFileId)) {
    // 🔧 err.status를 얹어 호출부가 메시지 문자열을 파싱하지 않고도 400과
    // 500(예상 못한 서버 오류)을 구분해 응답하게 한다.
    const err = new Error("직권 퇴실은 자유 입력 사유로 지난 사이클(백업) 시트를 대상으로 처리할 수 없습니다 — 이번 주 시트 기준으로만 처리해주세요.");
    err.status = 400;
    throw err;
  }
  const { sourceFileId, fromBackup } = await resolveExitSourceFileId(env, accessToken, fileId, number, kind, cycleFileId);
  if (forceFresh) await invalidateMemberSlotCache(env, number, sourceFileId);
  const status = await buildPersonalStatus(env, accessToken, sourceFileId, number, name);
  const breakdown = status.depositRefundBreakdown;
  const process = calcExitProcess(kind, breakdown, forcedReason);
  if (!process) return null;

  const { discountRatio, resultStr, reasons } = process;
  // 집계!D23:D24(퇴실벌금/퇴실예치 누적)는 회원 개인 값이 아니라 전체
  // 스터디의 실시간 누적치이므로, 백업이 아니라 항상 원본(fileId)에서 읽는다.
  const totalSheetVals = await getSheetValues(env, accessToken, fileId, "집계!D23:D24");
  // 🔧 [파싱 불일치 수정] 같은 집계!D23:D24를 buildRosterStatus는 parseWon
  // (콤마·₩ 방어)으로 읽는데 여기는 safeNumber(Number() 그대로, 콤마 섞이면
  // NaN→0)를 써서, 혹시라도 이 셀에 천단위 구분 서식이 걸리면 금액이 조용히
  // 0으로 리셋된 채 그대로 D23/D24에 덮어써질 위험이 있었다. parseWon으로
  // 통일 — 콤마·₩ 없는 정상 케이스에서는 safeNumber와 동일하게 동작한다.
  const fineOuter = parseWon(totalSheetVals[0] && totalSheetVals[0][0]);
  const depositOuter = parseWon(totalSheetVals[0] && totalSheetVals[0][1]);
  const fineAlreadyPayment = status.weeklyTotalFine ? parseWon(status.weeklyTotalFine) : 0;

  const newFineOuter = fineOuter + fineAlreadyPayment;
  const newDepositOuter = depositOuter + EXIT_DEPOSIT_VALUE * discountRatio;

  // 🔧 2026-09: forced/admin_forced는 트리거 경로(자동 감지 vs 관리자 직접
  // 사유 입력)만 다를 뿐 결과는 항상 discountRatio=1(0% 반환)로 동일하다 —
  // "예치금 재납 대상 처리"의 강제퇴실도 결국 페널티/미납이라는 사유에
  // 의해 관리자가 확정 버튼을 눌러야만 발생하는 처리라는 점에서 직권 P와
  // 본질이 같다(사용자 판단). 두 유형을 "강제 퇴실자"로 통일하고, 실제
  // 사유는 kindStr이 아니라 resultStr/reasons(§numberedReasons →
  // "📝 원인 :" 섹션, KV의 reasons 필드)에 그대로 남아 어떤 조건으로
  // 강제됐는지는 여전히 구분할 수 있다.
  // 🔧 [회귀 버그 수정] 위 통일을 discountRatio===1로 판정하면 forced/
  // admin_forced 외의 kind도 우연히 discountRatio가 1이 되는 경우 잘못
  // 걸린다 — calcAgainDeposit(deposit_again)은 납부 확인 시 항상
  // discountRatio:1을 반환하고, calcSettleReturnDeposit(settle)도 페널티
  // 1회+퇴실 통보 지연이 겹치면 discountRatio:1이 나올 수 있다(고지지연
  // 반영 버그 수정으로 새로 도달 가능해진 경로). 두 경우 모두 "강제
  // 퇴실자"가 아니라 "예치금 재납자"/"정산 퇴실자"로 남아야 하므로,
  // discountRatio가 아니라 kind로 직접 분기한다.
  const kindStr =
    kind === "forced" || kind === "admin_forced"
      ? "강제 퇴실자"
      : kind === "settle"
        ? "정산 퇴실자"
        : "예치금 재납자";
  const numberedReasons = resultStr.map((s, i) => `${String.fromCharCode(9312 + i)} ${s}`);
  const heldAmount = EXIT_DEPOSIT_VALUE * discountRatio;
  const refundAmount = EXIT_DEPOSIT_VALUE - heldAmount;
  const processedDate = todayKSTDateString();
  const resultMsg =
    `🧑 이름 : ${name}\n📝 유형 : ${kindStr}\n📝 원인 : \n${numberedReasons.join("\n")}\n` +
    `💰 귀속예치 : ₩${heldAmount.toLocaleString()}\n` +
    `💰 반환예치 : ₩${refundAmount.toLocaleString()}\n` +
    `💰 기납벌금 : ₩${fineAlreadyPayment.toLocaleString()}\n\n` +
    `📆 처리일자 : ${processedDate}\n` +
    `================================\n[집계 시트의 변동사항]\n` +
    `💰 퇴실벌금 : ₩${fineOuter.toLocaleString()} → ₩${newFineOuter.toLocaleString()}\n` +
    `💰 퇴실예치 : ₩${depositOuter.toLocaleString()} → ₩${newDepositOuter.toLocaleString()}`;

  const allChecks = kind === "forced" ? forcedExitChecks(breakdown) : [];

  // 🔧 [퇴실 프로세스 카드] "정산 퇴실자 처리" 다이얼로그의 "퇴실 프로세스"
  // 섹션(신청일자/예약일자/동의일자)에 쓰인다 — settle이 아닌 kind에서도
  // 신청 기록이 있으면(드묾) 참고용으로 함께 내려준다.
  const exitRequestEntry = await getLeaveQueueStub(env)
    .fetch(`https://do/exit/get?memberNumber=${encodeURIComponent(number)}`)
    .then((r) => r.json())
    .then((d) => d.entry)
    .catch(() => null);
  const exitProcess = exitRequestEntry
    ? { requestedAt: exitRequestEntry.ts || null, exitDate: exitRequestEntry.exitDate || null, agreedAt: exitRequestEntry.agreedAt || null }
    : null;

  return {
    discountRatio,
    resultStr,
    reasons: reasons || [],
    allChecks,
    resultMsg,
    newFineOuter,
    newDepositOuter,
    kindStr,
    // 🔧 [미리보기 UI 개편] 프론트가 resultMsg(텔레그램용 이모지 텍스트
    // 블록)를 <pre>로 그대로 찍어 앱 UI와 어울리지 않았다(사용자 지적) —
    // 앱의 다른 다이얼로그(DepositRefundDialog 등)처럼 SubRow로 구조화해
    // 보여줄 수 있도록 개별 숫자 필드를 함께 내려준다.
    name,
    heldAmount,
    refundAmount,
    fineAlreadyPayment,
    processedDate,
    fineOuter,
    depositOuter,
    // 정산 퇴실("퇴실 처리 (정산)")도 DepositRefundDialog와 동일한 "차감
    // 원인" 카드를 보여줄 수 있도록, 그 계산에 쓰이는 원본 breakdown을
    // 그대로 함께 내려준다.
    breakdown,
    exitProcess,
    // 🔧 [백업 참조 표시] 원본이 아니라 sheet_reset 직전 자동 백업 파일에서
    // 이 회원의 지난 주 값을 읽었는지 — 프론트가 "지난 주 시트 기준" 안내를
    // 보여줄 수 있도록 함께 내려준다. sourceFileId는 handleAdminExitConfirm이
    // performExitReset에 그대로 전달해 백업 탭도 같은 소스에서 만들도록 한다.
    fromBackup,
    sourceFileId,
    // 🔧 [사용자 지시] "직권 P 사이클 오인 방지" — 위 requiresFineUnpaidRecheck
    // 참고. 계산 기준 시트(sourceFileId)에 실제 미납 기록이 없으면
    // true — 호출부(handleAdminExitPreview/handleAdminExitConfirm)가
    // 이 값을 보고 확정/미리보기 자체를 거부한다.
    fineUnpaidRecheckFailed: requiresFineUnpaidRecheck(kind, forcedReason) && !breakdown.fineUnpaid,
  };
}

export async function handleAdminExitPreview(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { number, kind, forcedReason, cycle } = await req.json();
  const sheetNum = parseInt(number, 10);
  if (!sheetNum || sheetNum < 1 || sheetNum > 15 || !EXIT_KIND_VALUES.includes(kind)) {
    return json({ error: "회원번호 또는 처리 유형이 올바르지 않습니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    const members = await listAllMembers(env, accessToken, fileId);
    const member = members.find((m) => m.number === String(sheetNum));
    if (!member) return json({ error: "존재하지 않는 회원번호입니다." }, 404, origin);

    // 🔧 [미리보기는 항상 계산만 보여줌] 정산 퇴실이 실제 신청 여부와
    // 무관하게 계산 결과 자체는 항상 볼 수 있어야 한다(사용자 지적) —
    // "관리자 선택에 따라 반환율이 달라지면 안 된다"는 검증은 시트를 실제로
    // 바꾸는 확정 단계(handleAdminExitConfirm)에서만 하면 충분하고, 여기
    // (시트 불변경, 계산만)까지 막을 필요는 없다.
    // 🔧 [사용자 지시, 예외] "직권 P 사이클 오인 방지" — 위 원칙과 달리
    // 이 검증만은 미리보기 단계부터 함께 거부한다. 다이얼로그가 열리자마자
    // 자동 호출되는 이 경로에서 바로 막아야, 관리자가 "확정 처리" 버튼을
    // 눌러보기도 전에 "사이클을 잘못 보고 있다"는 걸 가장 빨리 알 수
    // 있다(사용자 확인: 미리보기·확정 동일하게 거부).
    const result = await computeExitResult(env, accessToken, fileId, member.number, member.name, kind, forcedReason, cycle);
    if (!result) {
      return json({ error: "해당 처리 유형에 해당하지 않는 회원입니다." }, 400, origin);
    }
    if (result.fineUnpaidRecheckFailed) {
      return json(
        { error: "지금 조회 중인 사이클(시트) 기준으로는 이 회원이 벌금 미납 상태가 아닙니다. 사이클을 다시 확인해주세요." },
        409,
        origin
      );
    }
    return json({ ok: true, ...result }, 200, origin);
  } catch (err) {
    // 🔧 computeExitResult가 err.status(예: 400)를 얹어 던지면 그대로
    // 따른다 — isUnguardedAdminForcedCycleCombo처럼 관리자의 잘못된 입력
    // 조합을 안내하는 에러는 500(서버 오류)이 아니어야 한다.
    return json({ error: "퇴실 처리 미리보기 실패: " + err.message }, err.status || 500, origin);
  }
}

// 앱스크립트 _append_data_audit_snapshot()을 재현한다. "데이터" 시트 행을
// 초기화하기 전에 그 시점의 값(B~V열)을 "데이터 (감사)" 시트의 첫 빈 행에
// append-only로 복사해 영구 보존한다 — B열(회원번호)이 비어 있는 첫 행을
// 찾아 그 자리에 값만 복사하고, C열(이름)은 "{이름} ({event_label})\n
// {오늘 날짜}"로 덮어써 어느 이벤트의 스냅샷인지 식별한다.
//
// 🔧 [왜 필요한가] 백업 탭("{이름} (퇴실)" 등)은 원본 시트를 copyTo로 그대로
// 복사한 사본이라, 안의 수식(C35 상점/C37 제보상점/C39 페널티 표시 등)이
// 여전히 INDIRECT("'데이터'!..." & C42)로 "데이터" 시트의 그 행을 실시간
// 참조한다. 퇴실 처리 직후 "데이터" 시트의 그 행(F~V열)은 곧바로 0으로
// 초기화되고, 나중에 같은 번호에 새 회원이 등록되면 그 행이 재사용된다 —
// 이 스냅샷/치환이 없으면 번호가 재사용되는 순간 이미 확정된 퇴실자의
// 백업 탭 수식이 새 회원의 값을 잘못 참조하게 되어 과거 기록이 조용히
// 오염된다. 반환값은 새로 채워진 감사 행 번호(1 이상) — 0이면 실패(감사
// 시트가 없거나 원본 행이 비어있음), 호출부는 이 경우 수식 치환을 건너뛴다.
async function appendDataAuditSnapshot(env, accessToken, fileId, rowNumber, name, eventLabel) {
  const AUDIT_SHEET = "데이터 (감사)";
  const sourceRow = await getSheetValues(env, accessToken, fileId, `데이터!B${rowNumber}:V${rowNumber}`).catch(
    () => []
  );
  if (!sourceRow[0]) return 0;

  // B4부터 아래로 훑어 B열(회원번호)이 비어있는 첫 행을 찾는다 — 이 시트는
  // append-only라 위에서부터 순서대로 채워져 있다는 전제(중간에 구멍이
  // 나는 삭제 동작이 없음)로, 직전 세션의 마지막 행 다음 줄을 최후
  // fallback으로 둔다. 🔧 [빈 시트 초기 상태 방어] "데이터 (감사)"가
  // 아직 한 번도 채워진 적 없으면(정상적인 초기 상태) B4:B2000 조회 자체가
  // 완전히 빈 응답이라 getSheetValues가 예외를 던진다 — 이 경우를 "감사
  // 시트 없음"과 같은 실패로 취급해 return 0 해버리면, 정작 첫 이벤트에서
  // 스냅샷이 전혀 안 남는 역설이 생긴다. 빈 배열로 폴백해 "B4가 바로 빈
  // 행"으로 정상 처리되게 한다.
  const bColumn = await getSheetValues(env, accessToken, fileId, `${AUDIT_SHEET}!B4:B2000`).catch(() => []);
  let targetRow = bColumn.findIndex((row) => !row[0]) + 4;
  if (targetRow === 3) targetRow = bColumn.length + 4; // findIndex가 -1이면(빈 행 없음) 맨 끝 다음 줄.

  // B~V 통째로(17열) 옮기되, C열(이름)만 이벤트 라벨로 덮어쓴다 — 원본
  // 이름 값은 애초에 라벨에 포함되므로 정보 손실 없음.
  const paddedRow = sourceRow[0].slice();
  while (paddedRow.length < 21) paddedRow.push(""); // B~V = 21개 열(sheets API가 뒤쪽 빈 칸을 잘라서 줄 수 있음).
  paddedRow[1] = `${name} (${eventLabel})\n${todayKSTDateString()}`; // C열 = index 1(B가 0).

  await writeSheetValues(env, accessToken, fileId, [
    { range: `${AUDIT_SHEET}!B${targetRow}:V${targetRow}`, values: [paddedRow] },
  ]);
  return targetRow;
}

// 백업 탭(퇴실/재납) 안의 수식 중 "데이터" 시트를 참조하는 것을 전부
// "데이터 (감사)" 참조로 치환한다 — appendDataAuditSnapshot이 반환한
// auditRow가 이제 그 회원의 스냅샷이 영구 보존되는 자리이므로, 백업 탭은
// 원본 "데이터" 행(이후 재사용될 수 있음) 대신 이 고정된 감사 행만 보도록
// 고정한다. 앱스크립트 _set_sheet_init()과 동일하게 $C$42(절대참조)를
// 먼저 치환한 뒤 남은 C42(상대참조)를 치환한다 — 순서를 바꾸면 먼저 바뀐
// C43이 두 번째 치환에서 다시 걸려 이중 치환되며 오염된다.
async function rewriteBackupAuditFormulas(env, accessToken, fileId, backupSheetName, auditRow) {
  const REPORT_ROW_CELL = "C42";
  const AUDIT_ROW_CELL = "C43";
  const formulas = await getSheetFormulas(env, accessToken, fileId, `'${backupSheetName}'!B2:W43`);
  const updates = [];
  formulas.forEach((row, r) => {
    row.forEach((cell, c) => {
      if (typeof cell !== "string" || !cell.includes("'데이터'!")) return;
      let f = cell.split("'데이터'!").join("'데이터 (감사)'!");
      f = f
        .split(`$${REPORT_ROW_CELL[0]}$${REPORT_ROW_CELL.slice(1)}`)
        .join(`$${AUDIT_ROW_CELL[0]}$${AUDIT_ROW_CELL.slice(1)}`);
      f = f.split(REPORT_ROW_CELL).join(AUDIT_ROW_CELL);
      const colLetter = colIndexToLetter(c + 1); // B2:W43 시작이 B(1)이므로 +1.
      updates.push({ range: `'${backupSheetName}'!${colLetter}${r + 2}`, values: [[f]] });
    });
  });
  if (updates.length === 0) return;
  await writeSheetValues(env, accessToken, fileId, updates);
  // C43(감사 행 계산 번호)에 실제 행 번호도 함께 기록 — 위 치환된 수식들이
  // 이 셀을 상대/절대참조로 가리키므로, 셀 자체에 실제 값이 있어야 한다.
  await writeSheetValues(env, accessToken, fileId, [
    { range: `'${backupSheetName}'!${AUDIT_ROW_CELL}`, values: [[auditRow]] },
  ]);
}

// 앱스크립트 _set_sheet_init()의 "퇴실자" 분기를 재현한다: 백업 탭 생성 후
// 원 슬롯을 template으로 리셋하고, 권한관리/제보상점/Drive 권한을 정리한다.
//
// 🔧 [사용자 지시, 2026-09-10] 앱스크립트 원본의 op/sh 이원 구조를 다시
// 들여다보면 — get_op_spreadsheet()는 "관리자가 그 순간 실제로 열어서 실행
// 중인 파일"이라, 리셋이 지난 뒤(예: 일요일 미납을 월요일 이후 처리) 관리자가
// 지난 주 백업 파일을 직접 열어 처리하면 op가 곧 그 백업 파일이 된다. 이때
// 백업 탭("{이름} (퇴실)")과 처리결과 박스는 그 op(=백업 파일) 쪽에 생성되고,
// sh(고정 ID = 이번 주 공유 시트)에는 _sunday 분기로 슬롯 청소(권한 회수·
// N번 리셋·데이터 초기화)만 별도로 적용된다 — 백업 탭은 안 만든다. 즉 "그
// 사람의 마지막 활동이 속한 시점의 파일에 결과 기록을 남기고, 현재 공유
// 시트에서는 접근 차단과 슬롯 청소만 한다"가 원래 의도였다.
//
// sourceFileId: 계산 근거이자 이제는 백업 탭의 생성 위치이기도 하다 — 보통은
// fileId와 같지만, sheet_reset이 이미 지난 뒤 정산 확정 처리를 하는 경우
// (computeExitResult의 resolveExitSourceFileId 참고) "지난 주 자동 백업
// 파일"이 되어, 백업 탭·감사 스냅샷 모두 그 백업 파일 쪽에 생성된다. 원본의
// 회원 번호 슬롯(N번 리셋)·권한 회수·데이터 시트 초기화는 sourceFileId와
// 무관하게 항상 fileId(이번 주 공유 시트)에 적용한다.
async function performExitReset(env, accessToken, fileId, member, resultMsg, kindLabel, sourceFileId) {
  const rowNumber = parseInt(member.number, 10) + 3;
  const backupName = `${member.name} (퇴실)`;
  const effectiveSourceFileId = sourceFileId || fileId;
  const backupTargetFileId = effectiveSourceFileId; // 백업 탭·감사 스냅샷의 실제 생성 위치.

  // 같은 파일이면(상황 A) ids 조회 하나에 backupName까지 함께 담아 끝내고,
  // 다른 파일이면(상황 B, 지난 주 백업) fileId 쪽은 member.number/template만,
  // backupTargetFileId(=effectiveSourceFileId) 쪽은 member.number/backupName을
  // 따로 조회한다 — 기존 백업 탭 존재 여부는 항상 backupTargetFileId 기준.
  const sameFile = effectiveSourceFileId === fileId;
  const [ids, sourceIds] = await Promise.all([
    getSheetIdsByNames(env, accessToken, fileId, sameFile ? [member.number, "template", backupName] : [member.number, "template"]),
    sameFile ? Promise.resolve(null) : getSheetIdsByNames(env, accessToken, effectiveSourceFileId, [member.number, backupName]),
  ]);
  const memberSheetId = ids[member.number];
  const templateSheetId = ids["template"];
  // 백업 탭의 원본은 sourceFileId 쪽 회원 시트 sheetId — 같은 파일이면 위에서
  // 이미 찾은 memberSheetId를 그대로 쓰고, 다른 파일(지난 주 백업)이면 그
  // 파일 안에서 따로 찾은 sheetId를 쓴다.
  const backupSourceSheetId = sourceIds ? sourceIds[member.number] : memberSheetId;
  const existingBackupId = sameFile ? ids[backupName] : sourceIds[backupName];

  if (existingBackupId !== null && existingBackupId !== undefined) {
    await spreadsheetBatchUpdate(env, accessToken, backupTargetFileId, [
      { deleteSheet: { sheetId: existingBackupId } },
    ]);
  }
  if (memberSheetId === null) throw new Error(`시트 ${member.number}를 찾을 수 없습니다.`);
  if (templateSheetId === null) throw new Error("template 시트를 찾을 수 없습니다.");
  if (backupSourceSheetId === null || backupSourceSheetId === undefined) {
    throw new Error(`백업 원본(지난 주 시트)에서 회원 ${member.number}의 탭을 찾을 수 없습니다.`);
  }

  const backupSheetId = await copySheetToSpreadsheet(
    env,
    accessToken,
    effectiveSourceFileId,
    backupSourceSheetId,
    backupTargetFileId,
    backupName
  );
  await writeExitResultBox(env, accessToken, backupTargetFileId, backupSheetId, resultMsg);

  // 🔧 [데이터 감사] "데이터" 원본 행을 초기화하기 전에, 그 시점의 값을
  // "데이터 (감사)"에 스냅샷으로 남기고, 백업 탭의 수식이 원본 대신 이
  // 감사 행을 보도록 통째 치환한다 — appendDataAuditSnapshot 주석 참고
  // (앱스크립트 _set_sheet_init()의 동작을 그대로 재현, 2026-09 추가:
  // 원래 웹 경로엔 이 로직이 없어 번호가 재사용되면 백업 탭 수식이
  // 새 회원 값을 잘못 참조할 위험이 있었다).
  //
  // 🔧 [백업 파일 분리, 2026-09-10] 백업 탭이 backupTargetFileId(지난 주
  // 백업 파일일 수 있음)에 생성되므로, 감사 스냅샷도 같은 파일의 "데이터"/
  // "데이터 (감사)"에 남겨야 백업 탭 수식(INDIRECT 참조)이 실제로 존재하는
  // 자리를 가리킨다 — fileId(이번 주 시트)에 남기면 그 파일엔 애초에 이
  // rowNumber의 원본 행이 이미 초기화되어 있거나(재사용 전) 다른 회원 값이
  // 들어있어(재사용 후) 스냅샷 자체가 무의미해진다.
  const auditRow = await appendDataAuditSnapshot(
    env,
    accessToken,
    backupTargetFileId,
    rowNumber,
    member.name,
    "퇴실"
  ).catch(() => 0);
  if (auditRow > 0) {
    await rewriteBackupAuditFormulas(env, accessToken, backupTargetFileId, backupName, auditRow).catch(() => {});
  }

  const ownerEmail = env.ADMIN_EMAIL;
  await protectSheetForOwnerAndService(env, accessToken, backupTargetFileId, backupSheetId, ownerEmail);

  await spreadsheetBatchUpdate(env, accessToken, fileId, [{ deleteSheet: { sheetId: memberSheetId } }]);
  const newSheetId = await copySheetWithName(env, accessToken, fileId, templateSheetId, member.number);

  // 🔧 [데이터 시트 통합] C38(옛 "제보상점 시트 행 번호") → C42("참조 행 계산
  // 번호"). B2 문구도 이번 개편에서 "📝 {번호}번's 대시보드 📝" 형식으로 통일됨.
  await writeSheetValues(env, accessToken, fileId, [
    { range: `${member.number}!C42`, values: [[rowNumber]] },
    { range: `${member.number}!B2`, values: [[`📝 ${member.number}번's 대시보드 📝`]] },
  ]);

  // 🔧 [데이터 시트 통합] "권한관리"(D=이메일,H=시험종류)+"제보상점"(D~J=요일별)
  // 이 "데이터" 한 탭(D=이메일,E=준비시험,F~V=송출P/주간P/사유반휴/제보상점
  // 슬롯)으로 합쳐졌다. 퇴실 시 D~V 전체를 초기화한다. (위 감사 스냅샷이
  // 이 초기화 직전 값을 이미 별도로 보존했다.)
  const authRows = await getSheetValues(env, accessToken, fileId, `데이터!D${rowNumber}:D${rowNumber}`);
  const memberEmailRaw = (authRows[0] && authRows[0][0]) || "";
  // 🔧 [회귀 버그 수정, 2026-09] D열은 "구글계정,구루미계정" 콤보 원본
  // 그대로다(parseGoogleEmail 주석 참고) — revokeSheetAccess는 Drive
  // 권한 목록의 순수 이메일과 정확 일치 비교를 하므로, 콤마 섞인 원본을
  // 그대로 넘기면 구루미 계정이 함께 저장된(사실상 항상 그런) 모든
  // 회원에서 비교가 절대 일치하지 않아 Drive 편집 권한 회수가 조용히
  // 실패하고 있었다 — parseGoogleEmail로 이메일만 뽑아 넘긴다.
  const memberEmail = parseGoogleEmail(memberEmailRaw);
  await writeSheetValues(env, accessToken, fileId, [
    { range: `데이터!D${rowNumber}:E${rowNumber}`, values: [["", ""]] },
    { range: `데이터!F${rowNumber}:V${rowNumber}`, values: [Array(17).fill(0)] },
  ]);
  await revokeSheetAccess(env, fileId, memberEmail);
  await protectSheetForOwnerAndService(env, accessToken, fileId, newSheetId, ownerEmail);
  await invalidateMemberCache(env, ["roster"]); // 이메일이 비워져 명단이 바뀌었으므로 전체 무효화.
  // 이 번호가 곧바로 다른 신규 회원에게 재배정될 수 있으므로, 퇴실한 회원의
  // 벌점/제보상점 KV 캐시가 새 회원에게 노출되지 않도록 함께 지운다.
  await invalidateMemberSlotCache(env, member.number);

  // 🔧 [블랙리스트 계정 저장] 확정 처리(handleAdminExitConfirm)가 이 값을
  // exitResult 결과에 함께 담아, "신규 스터디원 등록" 화면이
  // 블랙리스트 등록된 계정 재입력을 감지할 수 있게 한다(사용자 지시) —
  // 초기화 직전에만 D열 원본을 읽을 수 있으므로 여기서 뽑아 반환해야 한다.
  return { googleAccount: memberEmail, gooroomeeAccount: parseGooroomeeAccount(memberEmailRaw) };
}

// 앱스크립트 _set_sheet_init()의 "재납자" 분기를 재현한다: 이름(B2)과
// 목표시간(O3)은 보존한 채, 가입일자/참여상태를 새로 기록하고 나머지는 리셋한다.
// 백업 탭 이름에 타임스탬프를 붙여 매번 새 탭으로 남긴다 — 같은 주 안에 같은
// 회원이 두 번 이상 재납되는 극희소 케이스에도 이전 스냅샷이 덮어써지지 않고
// 웹 대시보드(재납 전/후 분리 조회)가 각 스냅샷을 모두 조회할 수 있게 하기 위함.
async function performDepositAgainReset(env, accessToken, fileId, member, resultMsg) {
  const rowNumber = parseInt(member.number, 10) + 3;
  const backupName = `${member.name} (재납 ${Date.now()})`;

  const ids = await getSheetIdsByNames(env, accessToken, fileId, [member.number, "template"]);
  const memberSheetId = ids[member.number];
  const templateSheetId = ids["template"];

  if (memberSheetId === null) throw new Error(`시트 ${member.number}를 찾을 수 없습니다.`);
  if (templateSheetId === null) throw new Error("template 시트를 찾을 수 없습니다.");

  const backupSheetId = await copySheetWithName(env, accessToken, fileId, memberSheetId, backupName);
  await writeExitResultBox(env, accessToken, fileId, backupSheetId, resultMsg);

  // 🔧 [데이터 감사] 퇴실과 동일한 이유로, 재납도 F~V열을 초기화하기 전에
  // "데이터 (감사)"에 스냅샷을 남기고 백업 탭 수식을 그 감사 행으로 치환한다
  // (performExitReset 쪽 appendDataAuditSnapshot 주석 참고).
  const auditRow = await appendDataAuditSnapshot(env, accessToken, fileId, rowNumber, member.name, "재납").catch(
    () => 0
  );
  if (auditRow > 0) {
    await rewriteBackupAuditFormulas(env, accessToken, fileId, backupName, auditRow).catch(() => {});
  }

  const ownerEmail = env.ADMIN_EMAIL;
  await protectSheetForOwnerAndService(env, accessToken, fileId, backupSheetId, ownerEmail);

  const [b2Rows, o3Rows] = await Promise.all([
    getSheetValues(env, accessToken, fileId, `${member.number}!B2`),
    getSheetValues(env, accessToken, fileId, `${member.number}!O3`),
  ]);
  const backupB2 = (b2Rows[0] && b2Rows[0][0]) || "";
  const backupO3 = (o3Rows[0] && o3Rows[0][0]) || "";

  await spreadsheetBatchUpdate(env, accessToken, fileId, [{ deleteSheet: { sheetId: memberSheetId } }]);
  const newSheetId = await copySheetWithName(env, accessToken, fileId, templateSheetId, member.number);

  const today = todayKSTDateString();
  await writeSheetValues(env, accessToken, fileId, [
    // 🔧 [데이터 시트 통합] C38(옛 "제보상점 시트 행 번호") → C42("참조 행 계산
    // 번호"). "제보상점" D~J 초기화도 "데이터" F~V로 이동 — appscript.js
    // 재납 분기와 동일하게 이메일(D)·시험유형(E)은 유지하고 F~V만 초기화한다.
    // (위 감사 스냅샷이 이 초기화 직전 값을 이미 별도로 보존했다.)
    { range: `${member.number}!C42`, values: [[rowNumber]] },
    { range: `${member.number}!B2`, values: [[backupB2]] },
    { range: `${member.number}!I2`, values: [[today]] },
    { range: `${member.number}!L3`, values: [["스터디원"]] },
    { range: `${member.number}!O3`, values: [[backupO3]] },
    { range: `데이터!F${rowNumber}:V${rowNumber}`, values: [Array(17).fill(0)] },
  ]);
  await protectSheetForOwnerAndService(env, accessToken, fileId, newSheetId, ownerEmail);
  await invalidateMemberCache(env, ["roster"]); // 시트가 재생성되어 sheetId(meta)가 바뀌었으므로 전체 무효화.
}

export async function handleAdminExitConfirm(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { number, kind, forcedReason, blacklist, cycle } = await req.json();
  const sheetNum = parseInt(number, 10);
  if (!sheetNum || sheetNum < 1 || sheetNum > 15 || !EXIT_KIND_VALUES.includes(kind)) {
    return json({ error: "회원번호 또는 처리 유형이 올바르지 않습니다." }, 400, origin);
  }
  // 🔧 [블랙리스트 등록] 직권 P(admin_forced)에서만 의미 있는 값 — 다른
  // kind로 넘어와도 무시하고 항상 false로 저장한다(상대 동의 없이 즉시
  // 내쫓는 가장 강한 강제퇴실에만 해당되는 개념이라는 사용자 지시).
  const isBlacklisted = kind === "admin_forced" && blacklist === true;

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    const members = await listAllMembers(env, accessToken, fileId);
    const member = members.find((m) => m.number === String(sheetNum));
    if (!member) return json({ error: "존재하지 않는 회원번호입니다." }, 404, origin);

    // 🔧 [동의 없이 확정 처리하는 경로 차단] 프론트가 "동의합니다"를 누르기
    // 전엔 관리자 쪽 "정산" 버튼 자체를 비활성화해두지만(사용자 지시), API를
    // 직접 호출하는 경로까지 막기 위해 서버에서도 신청+동의 여부를 함께
    // 확인한다. confirm을 preview 없이 직접 호출하는 경로도 막아야 하므로
    // 여기서 다시 확인한다.
    if (kind === "settle") {
      const exitRequestEntry = await getLeaveQueueStub(env)
        .fetch(`https://do/exit/get?memberNumber=${encodeURIComponent(member.number)}`)
        .then((r) => r.json())
        .then((d) => d.entry)
        .catch(() => null);
      if (!exitRequestEntry) {
        return json({ error: "퇴실 신청이 접수되지 않은 회원은 정산 퇴실로 처리할 수 없습니다." }, 400, origin);
      }
      if (!exitRequestEntry.agreedAt) {
        return json({ error: "회원이 예치금 정산액에 동의하지 않아 정산 퇴실로 처리할 수 없습니다." }, 400, origin);
      }
    }

    // 🔧 [사유 필수는 확정 단계에서만] calcAdminForcedExit는 미리보기가
    // 사유 없이도 계산을 보여줄 수 있도록 사유 검증을 하지 않는다 — 실제
    // 시트를 바꾸는 이 확정 단계에서 대신 검증한다(프론트도 "확정 처리"
    // 버튼을 forcedReason.trim()으로 막지만, API 직접 호출까지 방어).
    if (kind === "admin_forced" && !(forcedReason || "").trim()) {
      return json({ error: "직권 퇴실 사유를 입력해야 확정 처리할 수 있습니다." }, 400, origin);
    }

    // forceFresh: true — 실제로 시트를 바꾸는 확정 경로라 §computeExitResult
    // 주석 참고, 판정 직전 캐시를 강제로 재계산해 리전 간 KV 전파 지연으로
    // 인한 오판정 위험을 최대한 줄인다.
    const result = await computeExitResult(env, accessToken, fileId, member.number, member.name, kind, forcedReason, cycle, true);
    if (!result) {
      return json({ error: "해당 처리 유형에 해당하지 않는 회원입니다." }, 400, origin);
    }
    // 🔧 [사용자 지시] "직권 P 사이클 오인 방지" — §computeExitResult의
    // requiresFineUnpaidRecheck 참고. 미리보기(handleAdminExitPreview)에도
    // 동일한 검증이 있지만, API를 직접 호출해 preview 없이 confirm만
    // 부르는 경로까지 방어하기 위해 이 확정 단계에서도 다시 확인한다.
    if (result.fineUnpaidRecheckFailed) {
      return json(
        { error: "지금 조회 중인 사이클(시트) 기준으로는 이 회원이 벌금 미납 상태가 아닙니다. 사이클을 다시 확인해주세요." },
        409,
        origin
      );
    }

    const statusLabel =
      result.discountRatio === 0
        ? "퇴실자 (100% 반환)"
        : result.discountRatio === 0.5
          ? "퇴실자 (50% 반환)"
          : kind === "deposit_again"
            ? "재납자 (0% 반환)"
            : "퇴실자 (0% 반환)";

    await writeSheetValues(env, accessToken, fileId, [
      { range: `${member.number}!L3`, values: [[statusLabel]] },
      { range: "집계!D23", values: [[result.newFineOuter]] },
      { range: "집계!D24", values: [[result.newDepositOuter]] },
    ]);

    if (kind === "deposit_again") {
      await performDepositAgainReset(env, accessToken, fileId, member, result.resultMsg);
    } else {
      const exitAccounts = await performExitReset(
        env,
        accessToken,
        fileId,
        member,
        result.resultMsg,
        result.kindStr,
        result.sourceFileId
      );
      // 🔧 [퇴실 처리 결과 영구 보존] "퇴실 스터디원 목록"이 반환 예치금/
      // 차감 원인/처리 결과/퇴실유형을 구조화된 카드로 보여줄 수 있도록,
      // 백업 탭 이름을 키로 저장한다(재납은 다시 정상 명단으로 복귀하므로
      // 대상 아님).
      const backupName = `${member.name} (퇴실)`;
      await getMemberSettingsStub(env)
        .fetch("https://do/exit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: backupName,
            entry: {
              kind,
              kindStr: result.kindStr,
              refundAmount: result.refundAmount,
              heldAmount: result.heldAmount,
              fineAlreadyPayment: result.fineAlreadyPayment,
              breakdown: result.breakdown,
              reasons: result.reasons,
              processedDate: result.processedDate,
              blacklist: isBlacklisted,
              // 🔧 [블랙리스트 계정 대조] "신규 스터디원 등록"이 이 계정으로
              // 재등록을 시도하는지 감지할 수 있도록 함께 저장한다 — 블랙리스트
              // 여부와 무관하게 항상 채워두면, 이후 "퇴실 스터디원 목록"에서
              // 블랙리스트를 뒤늦게 켜도(§블랙리스트 토글) 계정 정보가 이미
              // 있어 곧바로 대조 대상이 된다.
              googleAccount: exitAccounts?.googleAccount || "",
              gooroomeeAccount: exitAccounts?.gooroomeeAccount || "",
            },
          }),
        })
        .catch(() => {});
    }
    // 실제 처리가 확정됐으니 "퇴실 예약" 신청 표시도 함께 정리한다 — 시트가
    // 이미 초기화된 회원 번호에 예약 뱃지만 남아있으면 혼동을 준다.
    await getLeaveQueueStub(env).fetch("https://do/exit/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberNumber: member.number }),
    });
    await invalidateMemberCache(env, ["roster"]); // 참여상태/페널티 슬롯/시트 구조가 모두 바뀌었으므로 전체 무효화.

    return json({ ok: true, number: member.number, name: member.name, resultMsg: result.resultMsg }, 200, origin);
  } catch (err) {
    // 🔧 computeExitResult가 err.status(예: 400)를 얹어 던지면 그대로
    // 따른다 — isUnguardedAdminForcedCycleCombo처럼 관리자의 잘못된 입력
    // 조합을 안내하는 에러는 500(서버 오류)이 아니어야 한다.
    return json({ error: "퇴실 처리 확정 실패: " + err.message }, err.status || 500, origin);
  }
}

// "퇴실 스터디원 목록"의 블랙리스트 등록/해제 토글 — 확정 처리 시점을
// 놓쳤거나(forced/settle은 애초에 체크박스가 없었음) 판단을 나중에 바꾼
// 경우를 위해, 이미 저장된 exitResult의 blacklist 필드만 뒤늦게 덮어쓴다.
export async function handleAdminExitBlacklist(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { name, blacklist } = await req.json();
  if (!name || typeof name !== "string" || typeof blacklist !== "boolean") {
    return json({ error: "대상 이름 또는 블랙리스트 값이 올바르지 않습니다." }, 400, origin);
  }

  try {
    const res = await getMemberSettingsStub(env).fetch("https://do/exit/patch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, patch: { blacklist } }),
    });
    if (res.status === 404) {
      return json(
        { error: "처리 결과를 조회할 수 없는 회원은 블랙리스트를 변경할 수 없습니다(이 기능 도입 이전 처리)." },
        404,
        origin
      );
    }
    return json({ ok: true, name, blacklist }, 200, origin);
  } catch (err) {
    return json({ error: "블랙리스트 변경 실패: " + err.message }, 500, origin);
  }
}

// "신규 스터디원 등록"(NewMemberForm)이 입력 중인 구글/구루미 계정을 실시간
// 대조할 수 있도록, 블랙리스트로 등록된 퇴실자의 계정만 뽑아 가벼운 목록으로
// 내려준다(사용자 지시) — ExitedMemberList처럼 반환액/차감원인 같은 상세
// 데이터까지 함께 내려줄 필요는 없어 별도 엔드포인트로 분리했다. 이 기능
// 도입(2026-09) 이전에 처리된 블랙리스트 등록자는 계정 정보가 저장되지
// 않았으므로 대조 대상에 포함되지 않는다(§handleAdminExitBlacklist 주석 참고
// — 처리 결과 자체가 없으면 blacklist를 뒤늦게 켤 수도 없다).
export async function handleAdminBlacklist(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    const exitedMembers = await listExitedMemberEntries(env, accessToken, fileId);

    const resultsRes = await getMemberSettingsStub(env).fetch("https://do/exit/list");
    const { items: allResults } = await resultsRes.json();
    const results = exitedMembers.map((m) => (allResults[m.name] ? { name: m.name, ...allResults[m.name] } : null));

    const entries = results
      .filter((r) => r && r.blacklist === true)
      .map((r) => ({
        name: r.name,
        googleAccount: r.googleAccount || "",
        gooroomeeAccount: r.gooroomeeAccount || "",
      }));

    return json({ entries }, 200, origin);
  } catch (err) {
    return json({ error: "블랙리스트 조회 실패: " + err.message }, 500, origin);
  }
}
