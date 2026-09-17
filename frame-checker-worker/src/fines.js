// 🔧 [구조 개선 6차, 2026-09-13] 벌금/납부 처리 도메인을 index.js에서
// 분리했다(docs/TESTING.md 참고) — 1~5차와 달리 이번엔 순수 함수가 아니라
// fetch 의존 도메인 전체(조회 함수 + 핸들러)를 fetch mock 기반 통합
// 테스트로 안전망을 깐 뒤 통째로 옮겼다. listAllMembers/getSharedMemberRows
// 등은 이 도메인 전용이 아니라 회원 관리 등 다른 도메인도 공유하는 범용
// 유틸이라 index.js에 남기고 export만 추가해 여기서 import한다 — 이미
// getSheetValues/getCurrentPenCycle에서 검증된 패턴과 동일.
import {
  json,
  getSheetValues,
  writeSheetValues,
  listAllMembers,
  getSharedMemberRows,
  colIndexToLetter,
  requireAdmin,
  getServiceAccountAccessToken,
  resolveTargetFileId,
  safeNumber,
  ROW_PAYMENT_CHECK,
  STATUS_DAYS,
  STATUS_DAY_COLS,
  listExitedMemberEntries,
  getMemberSettingsStub,
  FINE_UNPAID_ADMIN_FORCED_REASON,
} from "./index.js";
import { _cachedCompute, invalidateMemberCache } from "./cache.js";

// 15개 개인 탭을 병렬로 훑어 "✅ 납부확인" 행에 "미납"이 찍힌 요일만 모은다.
// listUnpaidFines/listPaidFines/listExemptFines가 이 공통 조회를 재사용해
// 상태값(미납/납부/면제)별로 걸러내기만 한다.
export async function getAllPaymentRows(env, accessToken, fileId, members) {
  const allRows = await getSharedMemberRows(env, accessToken, fileId, members);
  return members.map((member, i) => {
    const rows = allRows[i];
    return { member, paymentRow: (rows && rows[ROW_PAYMENT_CHECK]) || [] };
  });
}

export function collectFinesByStatus(paymentRows, status) {
  return paymentRows.flatMap(({ member, paymentRow }) => {
    const days = STATUS_DAYS.filter((day, i) => paymentRow[STATUS_DAY_COLS[i]] === status);
    return days.map((day) => ({ number: member.number, name: member.name, day }));
  });
}

// 15개 개인 탭을 병렬로 훑어 "✅ 납부확인" 행에 "미납"이 찍힌 요일만 모은다.
export async function listUnpaidFines(env, accessToken, fileId) {
  const members = await listAllMembers(env, accessToken, fileId);
  const paymentRows = await getAllPaymentRows(env, accessToken, fileId, members);
  return collectFinesByStatus(paymentRows, "미납");
}

// 15개 개인 탭을 병렬로 훑어 "✅ 납부확인" 행에 "납부"가 찍힌 요일만 모은다.
export async function listPaidFines(env, accessToken, fileId) {
  const members = await listAllMembers(env, accessToken, fileId);
  const paymentRows = await getAllPaymentRows(env, accessToken, fileId, members);
  return collectFinesByStatus(paymentRows, "납부");
}

// 집계 탭 D22(주간 벌금 = 15명의 "납부" 처리된 일간 벌금 합산)를 읽는다.
// "Money" 탭의 "납부" 목록을 열 때마다 다시 읽을 필요가 없는 값이라
// 캐싱한다 — 벌금 상태 변경(handleAdminFineStatus)이 이미
// invalidateMemberCache를 호출하므로 그 무효화 대상에 포함시킨다. TTL은
// 무효화가 놓친 경우의 안전망일 뿐이라 5분으로 늘려 KV 읽기 빈도를 줄인다
// (docs/CACHING_POLICY.md §5, 2026-09).
// 🔧 [사용자 지시, 2026-09-11] 5분→10분 재상향 — 이 값은 "납부된 총
// 벌금액" 표시 전용이고(강제퇴실 판정 등 다른 계산엔 안 쓰임), 유일한
// 쓰기 경로(handleAdminFineStatus)가 항상 확실히 무효화하며 이를 우회하는
// 쓰기 경로(앱스크립트 등)도 없다 — TTL은 순수 안전망이라 10분으로
// 늘려도 위험이 없다고 재검증했다(§33).
export async function getWeeklyPaidFineTotal(env, accessToken, fileId) {
  return _cachedCompute(env, `weeklyPaidFine:${fileId}`, 10 * 60_000, async () => {
    const rows = await getSheetValues(env, accessToken, fileId, "집계!D22");
    return safeNumber((rows && rows[0] && rows[0][0]) || 0);
  });
}

// 15개 개인 탭을 병렬로 훑어 "✅ 납부확인" 행에 "면제"가 찍힌 요일만 모은다.
export async function listExemptFines(env, accessToken, fileId) {
  const members = await listAllMembers(env, accessToken, fileId);
  const paymentRows = await getAllPaymentRows(env, accessToken, fileId, members);
  return collectFinesByStatus(paymentRows, "면제");
}

export const FINE_STATUS_VALUES = ["미납", "납부", "면제"];

export async function handleAdminFinesUnpaid(req, env, origin, url) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const cycleFileId = url ? url.searchParams.get("cycle") : null;
    const { fileId } = await resolveTargetFileId(env, accessToken, cycleFileId);
    const unpaid = await listUnpaidFines(env, accessToken, fileId);
    return json({ unpaid }, 200, origin);
  } catch (err) {
    return json({ error: "벌금 미납 목록 조회 실패: " + err.message }, 500, origin);
  }
}

export async function handleAdminFinesPaid(req, env, origin, url) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const cycleFileId = url ? url.searchParams.get("cycle") : null;
    const { fileId } = await resolveTargetFileId(env, accessToken, cycleFileId);
    const [paid, totalAmount] = await Promise.all([
      listPaidFines(env, accessToken, fileId),
      getWeeklyPaidFineTotal(env, accessToken, fileId),
    ]);
    return json({ paid, totalAmount }, 200, origin);
  } catch (err) {
    return json({ error: "벌금 납부 목록 조회 실패: " + err.message }, 500, origin);
  }
}

export async function handleAdminFinesExempt(req, env, origin, url) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const cycleFileId = url ? url.searchParams.get("cycle") : null;
    const { fileId } = await resolveTargetFileId(env, accessToken, cycleFileId);
    const exempt = await listExemptFines(env, accessToken, fileId);
    return json({ exempt }, 200, origin);
  } catch (err) {
    return json({ error: "벌금 면제 목록 조회 실패: " + err.message }, 500, origin);
  }
}

// 🔧 [사용자 지시, 2026-09-10] "예치금 재납이나 벌금 납부는 당일에 처리될
// 수도 있지만 보통은 익일이거나 하루 이틀 늦게 처리될 수도 있는데, 그럼
// 쓰기가 지난 주 시트에서도 가능해야 하지 않나?" — 납부확인은 "그 주차의
// 납부 기록 자체"라 실제로 그 주차 시트(현재 진행 중인 사이클 내 백업
// 포함)에 남아야 정확하다. resolveTargetFileId가 이미 "현재 사이클
// (1~3주차) 밖의 임의 fileId"는 거부하므로, 사이클을 벗어난 과거 기록을
// 건드릴 위험은 없다.
export async function handleAdminFineStatus(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { number, day, status, cycle } = await req.json();
  const sheetNum = parseInt(number, 10);
  const dayIndex = STATUS_DAYS.indexOf(day);
  if (!sheetNum || sheetNum < 1 || sheetNum > 15 || dayIndex === -1) {
    return json({ error: "회원번호 또는 요일이 올바르지 않습니다." }, 400, origin);
  }
  if (!FINE_STATUS_VALUES.includes(status)) {
    return json({ error: "상태값은 미납/납부/면제 중 하나여야 합니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const { fileId } = await resolveTargetFileId(env, accessToken, cycle);
    const col = colIndexToLetter(STATUS_DAY_COLS[dayIndex]);
    await writeSheetValues(env, accessToken, fileId, [
      { range: `${sheetNum}!${col}${ROW_PAYMENT_CHECK + 1}`, values: [[status]] },
    ]);
    await invalidateMemberCache(env, ["fine"], fileId); // 납부확인 값이 바뀌었으므로 관련 캐시만, 그 fileId에 한해 무효화.
    return json({ ok: true, number: String(sheetNum), day, status }, 200, origin);
  } catch (err) {
    return json({ error: "납부 상태 변경 실패: " + err.message }, 500, origin);
  }
}

// 🔧 [구조 개선 18차, 2026-09-17] "벌금 도메인"이라고 exit.js 8차 주석이
// 이미 인지하고 있었지만(index.js 잔류로만 남겨뒀던 함수) 17차 구조
// 감사에서 이동 후보로 지목되어 옮겼다. FINE_UNPAID_ADMIN_FORCED_REASON_LABEL
// 은 calcAdminForcedExit가 "직권 사유: " prefix를 붙인 뒤의 label 형태라
// FINE_UNPAID_ADMIN_FORCED_REASON(index.js, exit.js와 공유) 원본과 직접
// 비교할 수 없어, 이 파생 상수를 이 파일 로컬로 둔다(index.js 원본에서
// 파생시켜 항상 일치하게 유지).
const FINE_UNPAID_ADMIN_FORCED_REASON_LABEL = `직권 사유: ${FINE_UNPAID_ADMIN_FORCED_REASON}`;

// "벌금 납부 대상 처리"(PaidFineList)의 "직권 P" 버튼은 항상 이 사유로
// 고정해서 admin_forced 확정을 요청한다(§AdminMoneyTab.tsx, lockForcedReason)
// — 이 문자열을 바꾸면 여기도 함께 바꿔야 아래 카운트가 계속 맞게 걸린다.
// 요일별로 "직권 P(벌금 미납 사유)"로 확정된 인원 수를 센다 — 퇴실자
// 백업 탭(listExitedMemberEntries)을 순회하며 MemberSettingsDO에 저장된
// 확정 결과(admin_forced, 사유가 벌금 미납인 것)만 집계한다.
// 🔧 [KV → DO 이전, 2026-09-12] §49 — /exit/list 1회 호출로 대체.
export async function handleAdminFinesAdminForcedCount(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    const exitedMembers = await listExitedMemberEntries(env, accessToken, fileId);

    const resultsRes = await getMemberSettingsStub(env).fetch("https://do/exit/list");
    const { items: allResults } = await resultsRes.json();

    const counts = Object.fromEntries(STATUS_DAYS.map((d) => [d, 0]));
    for (const m of exitedMembers) {
      const result = allResults[m.name];
      if (!result) continue; // 이 기능 도입 이전 처리된 퇴실자는 저장된 결과가 없다.
      if (result.kind !== "admin_forced") continue;
      const isFineReason = (result.reasons || []).some(
        (r) => r.code === "admin_reason" && r.label === FINE_UNPAID_ADMIN_FORCED_REASON_LABEL
      );
      if (!isFineReason) continue;
      for (const day of result.breakdown?.fineUnpaidDays || []) {
        if (day in counts) counts[day] += 1;
      }
    }

    return json({ counts }, 200, origin);
  } catch (err) {
    return json({ error: "직권 P 인원 집계 실패: " + err.message }, 500, origin);
  }
}
