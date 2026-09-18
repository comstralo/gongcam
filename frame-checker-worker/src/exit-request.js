// 🔧 [구조 개선 21차, 2026-09-17] 퇴실 처리 도메인(8차, src/exit.js)을
// 다시 세 파일로 나눴다(docs/TESTING.md 참고). 이 파일(exit-request.js)
// 은 "신청/동의/취소/도움봇 조회" 단계만 담당한다 — 후보 판정
// (exit-candidates.js)/확정 실행(exit-confirm.js) 단계와 실제 호출이
// 전혀 없음을 실측으로 확인했다(순수 재배치, 로직 변경 없음).
// listExitRequests는 exit-candidates.js의 getAllExitRelevantStatus/
// listActiveMembersWithExitInfo가 실사용하므로 export한다(9~11차와
// 동일한 실사용 import 패턴).
import {
  getServiceAccountAccessToken,
  json,
  verifySession,
  resolveMemberNumber,
  getLeaveQueueStub,
  exitDateSettled,
  findMemberNumberByEmail,
  buildPersonalStatus,
  resolveExitSourceFileId,
} from "./index.js";
import { invalidateMemberCache, invalidatePersonalStatusCache } from "./cache.js";

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

    // 🔧 [사용자 지시] "미납 벌금이 있거나 상금 정산이 처리되지 않았으면
    // 내역과 동의 버튼을 보여주지 않음" — 프론트가 이미 같은 조건으로
    // 버튼 자체를 숨기지만(DepositRefundDialog), API를 직접 호출하는
    // 경로까지 막기 위해 서버에서도 다시 확인한다. buildPersonalStatus가
    // fineUnpaid/prizePending을 함께 계산해두므로 그대로 재사용한다.
    // 🔧 [버그 수정] 마지막 참여일이 일요일이고, 회원이 그 다음 주
    // 월요일 새벽 sheet_reset(06:00 KST) 이후에야 동의를 시도하면, 원본
    // 시트(env.GOOGLE_SHEET_FILE_ID)는 이미 새 사이클로 넘어가 지난 주
    // 순위/집계!P6이 사라진 상태다(순위가 "-"가 되어 항상 순위권 밖으로
    // 오판 → 상금이 실제로는 미지급인데도 동의를 허용해버리는 위험).
    // exit-confirm.js의 computeExitResult가 확정 처리 경로에서 이미 쓰는
    // resolveExitSourceFileId(kind: "settle")를 그대로 재사용해, 리셋을
    // 넘겼으면 그 주의 백업 파일에서 조회하도록 한다.
    const member = await findMemberNumberByEmail(env, accessToken, env.GOOGLE_SHEET_FILE_ID, session.email);
    if (!member) return json({ error: "데이터 시트 명단에서 계정을 찾을 수 없습니다." }, 403, origin);
    const { sourceFileId } = await resolveExitSourceFileId(
      env,
      accessToken,
      env.GOOGLE_SHEET_FILE_ID,
      memberNumber,
      "settle",
      null
    );
    const status = await buildPersonalStatus(env, accessToken, sourceFileId, member.number, member.name);
    if (status.depositRefundBreakdown.fineUnpaid) {
      return json({ error: "벌금 미납분이 남아있어 동의할 수 없습니다." }, 400, origin);
    }
    if (status.prizePending) {
      return json({ error: "이번 주 상금 정산이 아직 처리되지 않아 동의할 수 없습니다." }, 400, origin);
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
export async function listExitRequests(env) {
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
