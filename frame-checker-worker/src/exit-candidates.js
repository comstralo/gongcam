// 🔧 [구조 개선 21차, 2026-09-17] 퇴실 처리 도메인(8차, src/exit.js)을
// 다시 세 파일로 나눴다(docs/TESTING.md 참고). 이 파일(exit-candidates.js)
// 은 "후보 판정/공유 조회(강제퇴실 후보 목록, 퇴실 스터디원 목록,
// 블랙리스트)" 단계만 담당한다 — 신청(exit-request.js)/확정 실행
// (exit-confirm.js) 단계와 실제 호출이 전혀 없음을 실측으로 확인했다
// (순수 재배치, 로직 변경 없음). cycle.js/members.js가 이미 이 파일의
// getAllExitRelevantStatus/listExitCandidates/listActiveMembersWithExitInfo
// 를 실사용 import하고 있어 그 두 파일의 import 경로만 갱신한다.
import {
  getServiceAccountAccessToken,
  requireAdmin,
  json,
  listAllMembers,
  getSheetValues,
  getCurrentPenCycle,
  getSharedMemberRows,
  _bumpUsageCounter,
  OUTPUT_PEN_SHEET_NAME,
  OUTPUT_PEN_SLOT_COLUMNS,
  ROW_JOIN_DATE,
  ROW_MORNING_FINE,
  ROW_PARTI_STATUS,
  COL_PARTI_STATUS,
  latestSlotDay,
  buildSlotHistory,
  listExitedMemberEntries,
  getMemberSettingsStub,
  getExitResults,
  resolveTargetFileId,
} from "./index.js";
import { _cachedCompute, fetchSheetsApiWithRetry } from "./cache.js";
import {
  countCurrentCyclePen,
  depositRefundBreakdown,
  forcedExitChecks,
  calcForcedOutDeposit,
} from "./deposit.js";
import { listExitRequests } from "./exit-request.js";

async function getPenaltySlotNotesGrid(env, accessToken, fileId) {
  _bumpUsageCounter("sheets_read");
  const res = await fetchSheetsApiWithRetry(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}?` +
      `ranges=${encodeURIComponent(`'${OUTPUT_PEN_SHEET_NAME}'!F4:M18`)}` +
      `&fields=sheets.data.rowData.values.note`,
    accessToken
  );
  const data = await res.json();
  const rowData = data.sheets && data.sheets[0] && data.sheets[0].data && data.sheets[0].data[0] && data.sheets[0].data[0].rowData;
  return (rowData || []).map((row) => (row.values || []).map((v) => (v && v.note) || ""));
}

export async function getAllExitRelevantStatus(env, accessToken, fileId, members) {
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

export async function handleAdminExitedMembers(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    const exitedMembers = await listExitedMemberEntries(env, accessToken, fileId);

    const allResults = await getExitResults(env);
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

    const allResults = await getExitResults(env);
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
