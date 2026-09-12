// 🔧 [구조 개선 7차, 2026-09-13] 회원 관리(CRUD/번호 재배치) 도메인을
// index.js에서 분리했다(docs/TESTING.md 참고). 6차(fines.js)와 동일하게
// fetch mock + 실제 workerd DO 기반 통합 테스트를 먼저 깐 뒤 도메인을
// 통째로 옮겼다.
//
// 착수 전 조사에서 두 차례 범위를 좁혔다:
// 1) resolveMemberNumber/findMemberNumberByEmail은 회원 관리 전용이
//    아니라 로그인/제보/반휴 등 15곳 이상이 공유하는 인증 유틸이라
//    제외했다(withMemberLock/getRosterStub과 동일한 성격).
// 2) handleAdminMemberStatus/handleAdminMembersRoster는 각각
//    buildPersonalStatus(exit 신청 DO 조회까지 얽힌 무거운 함수)와
//    listActiveMembersWithExitInfo(exit 도메인 판정 로직 포함)를
//    호출해 통합 테스트 비용과 순환 복잡도가 지나치게 커서 제외했다.
//
// withMemberLock/getRosterStub, 범용 시트 조작 유틸(getSheetIdsByNames/
// spreadsheetBatchUpdate/copySheetToSpreadsheet/copySheetWithName/
// protectSheetForOwnerAndService/getSpreadsheetMeta)은 exit 도메인도
// 동일하게 공유하므로 index.js에 남기고 export만 추가해 여기서 가져온다.
// getCurrentCoReviewers도 마찬가지로 제보(handleAdminCapturesList 등)/
// 권한 조회(handleMyRole)/인증(requireAdminOrCoReviewer) 도메인이 함께
// 쓰는 범용 함수라 index.js에 남긴다(당초 계획은 이 함수도 이동 대상
// 이었으나, 구현 중 재확인해 계획을 수정했다).
import {
  getAdminAccessToken,
  getSheetValues,
  writeSheetValues,
  getSpreadsheetMeta,
  getSheetIdsByNames,
  spreadsheetBatchUpdate,
  copySheetWithName,
  protectSheetForOwnerAndService,
  requireAdmin,
  getServiceAccountAccessToken,
  resolveTargetFileId,
  json,
  withMemberLock,
  listExitedMemberEntries,
  getCurrentCoReviewers,
} from "./index.js";
import { parseGoogleEmail, parseGooroomeeAccount } from "./member-utils.js";
import { todayKSTDateString, kstDateOffsetString } from "./date-utils.js";
import { _cachedCompute, invalidateMemberCache, invalidateMemberSlotCache } from "./cache.js";

// 신규 스터디원의 구글 계정을 시트 편집자(writer)로 추가한다.
// 이 시트는 파일 자체의 편집자 목록으로 로그인 게이트(getSheetViewerEmails)를 겸하므로,
// 이 호출 하나가 앱스크립트의 grant_access와 로그인 허용을 동시에 대체한다.
export async function grantSheetAccess(env, fileId, email) {
  const accessToken = await getAdminAccessToken(env);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?sendNotificationEmail=false`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "writer", type: "user", emailAddress: email }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error("Drive 편집자 권한 부여 실패: " + JSON.stringify(data));
  return data;
}

// 🔧 [캐싱 통합, 2026-09] "데이터" 시트 원본(A1:V50)을 listAllMembers 외에도
// handleAdminMembersRoster(상세 패널의 구루미 계정/준비 중인 시험), handleAdminOpenSlots
// (빈 번호 조회), handleAdminCreateMember(번호 중복 검증)가 각자 캐시 없이
// 직접 읽고 있었다 — listAllMembers는 이 원본에서 "이메일이 있는 유효 회원"만
// 걸러 쓰고 나머지 열/행은 버려, 그 버려진 부분이 필요한 화면들은 캐시를
// 재사용하지 못했다. 원본 로우 자체를 별도 키로 캐싱해 listAllMembers를
// 포함한 4곳이 모두 재사용하게 한다. members:와 TTL·무효화 그룹을 반드시
// 함께 맞춘다(MEMBER_CACHE_PREFIXES/MEMBER_CACHE_UNCONDITIONAL_KEYS/
// MEMBER_CACHE_GROUPS.roster 세 곳 모두에 dataSheetRows: 등록 필요).
export async function getDataSheetRows(env, accessToken, fileId) {
  return _cachedCompute(env, `dataSheetRows:${fileId}`, 2 * 60 * 60_000, () => {
    return getSheetValues(env, accessToken, fileId, "데이터!A1:V50");
  });
}

// 🔧 [429 방지] "Penalty" 탭처럼 여러 컴포넌트가 한 페이지에서 동시에 마운트돼
// 각자 listAllMembers()를 부르는 상황이 잦아, 캐시(인메모리+KV)로 중복 호출을
// 흡수한다. 신규등록/퇴실/재납/이동 등 명단을 바꾸는 쓰기 뒤에는
// invalidateMemberCache()로 반드시 무효화하므로, TTL은 "무효화가 놓친 경우의
// 안전망"일 뿐이다.
export async function listAllMembers(env, accessToken, fileId) {
  return _cachedCompute(env, `members:${fileId}`, 2 * 60 * 60_000, async () => {
    const rows = await getDataSheetRows(env, accessToken, fileId);
    const members = [];
    for (const row of rows) {
      const num = (row[1] || "").trim();
      const name = (row[2] || "").trim();
      const email = parseGoogleEmail(row[3]);
      // 헤더 행(예: "👦🏻 멤버" / "이메일")을 걸러낸다 — 회원번호는 항상 숫자,
      // 이메일은 항상 @를 포함한다.
      if (num && /^\d+$/.test(num) && email && email.includes("@")) {
        members.push({ number: num, name, email });
      }
    }
    return members;
  });
}

// 🔧 [드롭다운 전용 캐시, 2026-09-10] "다른 회원 보기" 드롭다운(/admin/members)
// 은 거의 바뀌지 않는 화면인데도 listAllMembers(제보 이름 매칭, 퇴실 후보
// 판정 등 20곳 이상이 공유하는 원본 캐시, TTL 10분)를 그대로 썼다 — 이
// 드롭다운만 2시간으로 늘리고 싶다는 요청에 listAllMembers의 TTL 자체를
// 올리면, 이름 매칭처럼 "무효화가 어쩌다 한 번 놓쳤을 때의 노출 시간"이
// 중요한 다른 20곳의 안전망까지 함께 12배로 늘어난다(사용자 확인 후
// 분리하기로 함). 그래서 listAllMembers는 건드리지 않고, 이 핸들러의
// 최종 응답(members+exitedMembers 조합) 자체를 별도 키
// (adminMemberList:{fileId})로 한 번 더 감싼다.
export async function handleAdminMembers(req, env, origin, url) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const cycleFileId = url ? url.searchParams.get("cycle") : null;
    const { fileId: targetFileId } = await resolveTargetFileId(env, accessToken, cycleFileId);
    // 현재/과거 fileId 구분 없이 2시간 — 드롭다운은 실시간성이 필요 없고,
    // 신규등록·퇴실 발생 시 즉시 무효화되므로(아래 주석) 굳이 나눌 이유가 없다.
    const responseMembers = await _cachedCompute(env, `adminMemberList:${targetFileId}`, 2 * 60 * 60_000, async () => {
      const [members, exitedMembers] = await Promise.all([
        listAllMembers(env, accessToken, targetFileId),
        // 🔧 2026-09: "다른 회원 보기"에 퇴실자도 "{이름} (퇴실)"로 포함시켜
        // 관리자가 마지막 참여 시점 기록을 웹에서 조회할 수 있게 한다 —
        // 이전엔 이 탭이 구글 시트를 직접 열어야만 확인 가능했다. 원본
        // 조회일 때만(과거 사이클 백업 파일엔 이 탭이 없음).
        cycleFileId ? Promise.resolve([]) : listExitedMemberEntries(env, accessToken, targetFileId),
      ]);
      return [...members.map((m) => ({ number: m.number, name: m.name, email: m.email })), ...exitedMembers];
    });
    return json({ members: responseMembers }, 200, origin);
  } catch (err) {
    return json({ error: "회원 목록 조회 실패: " + err.message }, 500, origin);
  }
}

// 부스터디장 임명/해제 — 개인 탭 L3(참여상태) 셀을 "부스터디장"/"스터디원"으로
// 직접 바꿔쓴다. 스터디장은 이 API로 건드리지 않는다(퇴실 처리 등 별도
// 경로로만 관리).
export async function handleAdminSetPartiStatus(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { number, appoint } = await req.json().catch(() => ({}));
  if (!number) return json({ error: "number가 필요합니다." }, 400, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    const members = await listAllMembers(env, accessToken, fileId);
    const member = members.find((m) => m.number === String(number));
    if (!member) return json({ error: "존재하지 않는 회원번호입니다." }, 404, origin);

    const rows = await getSheetValues(env, accessToken, fileId, `${member.number}!L3`).catch(() => []);
    const currentStatus = (rows[0] && rows[0][0]) || "";
    if (currentStatus === "스터디장") {
      return json({ error: "스터디장은 이 기능으로 변경할 수 없습니다." }, 400, origin);
    }
    // 🔧 [퇴실자/재납자 보호] "스터디원 목록"(listActiveMembersWithExitInfo)이
    // 퇴실자/재납자를 이미 필터링해 이 API를 정상 UI 경로로는 호출할 수
    // 없지만, API를 직접 호출하면 서버가 스터디장 외엔 currentStatus를
    // 검증하지 않아 "퇴실자 (0% 반환)"/"재납자 (0% 반환)" 같은 처리 완료
    // 이력이 "부스터디장"/"스터디원"으로 조용히 덮어써질 수 있었다
    // (2026-09 코드 검토로 발견, 실사용 경로에서 재현된 적은 없음).
    if (/^(퇴실자|재납자)/.test(currentStatus)) {
      return json({ error: "이미 퇴실/재납 처리된 회원은 이 기능으로 변경할 수 없습니다." }, 400, origin);
    }

    const nextStatus = appoint ? "부스터디장" : "스터디원";
    const lockResult = await withMemberLock(env, "viceLeader:global", async () => {
      if (appoint) {
        // withMemberLock은 "실행 순서"만 뮤텍스로 강제할 뿐, 그 안에서
        // 읽는 coReviewers: 캐시(TTL 10분) 자체는 여전히 KV 최종 일관성을
        // 따른다 — 다른 리전에서 방금 처리된 임명이 아직 이 리전의 KV
        // 로컬 복제본에 반영 안 됐을 수 있어, 상한 검증 직전에 강제로
        // 지우고 다시 계산해야 정확하다.
        await invalidateMemberCache(env, ["partiStatus"]);
        const coReviewers = await getCurrentCoReviewers(env, accessToken, fileId);
        const alreadyViceLeader = coReviewers.some((m) => m.number === member.number);
        if (!alreadyViceLeader && coReviewers.length >= 2) {
          return { failure: true };
        }
      }
      await writeSheetValues(env, accessToken, fileId, [{ range: `${member.number}!L3`, values: [[nextStatus]] }]);
      await invalidateMemberCache(env, ["partiStatus"]); // 참여상태(L3)가 바뀌었으므로 관련 캐시만 무효화.
      return { failure: false };
    });
    if (lockResult.failure) return json({ error: "부스터디장은 최대 2명까지 임명할 수 있습니다." }, 400, origin);
    return json({ ok: true, partiStatus: nextStatus }, 200, origin);
  } catch (err) {
    return json({ error: "참여상태 변경 실패: " + err.message }, 500, origin);
  }
}

export async function handleAdminOpenSlots(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    // 🔧 [캐싱 통합, 2026-09] listAllMembers/handleAdminMembersRoster와 같은
    // 원본(데이터!A1:V50)을 매번 직접 다시 읽고 있었다 — getDataSheetRows
    // (members:와 동일한 10분 TTL·roster 무효화 그룹)로 교체한다. 이 화면은
    // "폼을 여는 순간의 스냅샷"으로만 쓰이고(재조회 없음) 신규 등록 처리
    // (handleAdminCreateMember) 쪽에 최종 이메일 배정 여부를 다시 검증하는
    // 별도 안전장치가 있어, 최대 10분 지연된 스냅샷을 보여줘도 실제 등록
    // 단계에서 최신 상태로 재확인된다.
    const rows = await getDataSheetRows(env, accessToken, env.GOOGLE_SHEET_FILE_ID);
    const slots = [];
    for (const row of rows) {
      const num = (row[1] || "").trim();
      const email = (row[3] || "").trim();
      if (num && /^\d+$/.test(num) && !email) slots.push(num);
    }
    slots.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    return json({ slots }, 200, origin);
  } catch (err) {
    return json({ error: "빈 자리 조회 실패: " + err.message }, 500, origin);
  }
}

// "데이터" 탭의 점유/공백 슬롯을 읽어 "빈 자리를 앞으로 당겨 채우는" 이동
// 계획을 계산한다. 점유 슬롯을 번호 오름차순으로 나열해 1번부터 빈틈없이
// 다시 배정하고, 이미 제자리인 슬롯(현재번호 === 목표번호)은 계획에서 뺀다.
export async function computeMemberReorderPlan(env, accessToken) {
  const fileId = env.GOOGLE_SHEET_FILE_ID;
  const rows = await getSheetValues(env, accessToken, fileId, "데이터!A1:V50");

  const occupied = [];
  for (const row of rows) {
    const num = (row[1] || "").trim();
    const name = (row[2] || "").trim();
    const email = (row[3] || "").trim();
    if (!num || !/^\d+$/.test(num)) continue;
    if (email) occupied.push({ number: num, name });
  }
  occupied.sort((a, b) => parseInt(a.number, 10) - parseInt(b.number, 10));

  // 목표 번호는 단순히 점유 슬롯을 원래 번호 순서대로 나열해 1번부터 다시
  // 매긴 것 — 빈 슬롯은 건너뛸 뿐 목표 번호 계산에 관여하지 않는다.
  const plan = [];
  occupied.forEach((o, idx) => {
    const from = parseInt(o.number, 10);
    const to = idx + 1;
    if (to !== from) {
      plan.push({ from: String(from), to: String(to), name: o.name });
    }
  });
  return plan;
}

export async function handleAdminMemberReorderPreview(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const plan = await computeMemberReorderPlan(env, accessToken);
    return json({ plan }, 200, origin);
  } catch (err) {
    return json({ error: "이동 계획 계산 실패: " + err.message }, 500, origin);
  }
}

// 번호 from(점유 중)을 번호 to(빈 자리)로 옮긴다. 셀을 하나하나 복사하는 대신
// 탭 이름 자체를 바꿔치기해서 개인 탭의 모든 데이터(출석/타이머 기록, 수식)를
// 그대로 보존한다. performExitReset과 동일한 삭제+template 복사 패턴을 쓴다.
export async function moveMemberSlot(env, accessToken, fileId, ownerEmail, from, to, oneIndex) {
  const ids = await getSheetIdsByNames(env, accessToken, fileId, [to, from, "template"]);
  const emptySheetId = ids[to];
  const occupiedSheetId = ids[from];
  const templateSheetId = ids["template"];
  if (emptySheetId === null) throw new Error(`시트 ${to}를 찾을 수 없습니다.`);
  if (occupiedSheetId === null) throw new Error(`시트 ${from}를 찾을 수 없습니다.`);
  if (templateSheetId === null) throw new Error("template 시트를 찾을 수 없습니다.");

  // "1"번 탭의 배치 시작 시점 위치(oneIndex)를 기준으로 N번 탭의 올바른
  // 위치를 oneIndex + (N-1)로 계산해 매번 그 자리에 명시적으로 배치한다
  // (이름만 바꾸면 원래 위치에 그대로 남아 탭 순서가 어긋난다). "1"번은
  // 가장 작은 번호라 이 로직에서 from이 될 수 없어 안정적인 기준점이다.
  const toIndex = oneIndex + parseInt(to, 10) - 1;
  const fromIndex = oneIndex + parseInt(from, 10) - 1;

  // 1. 빈 자리(to) 탭 삭제 — 실행 직전 재확인한 빈 슬롯이므로 내용 보존 불필요.
  await spreadsheetBatchUpdate(env, accessToken, fileId, [{ deleteSheet: { sheetId: emptySheetId } }]);

  // 2. 점유 중이던 탭(from)의 이름과 위치를 to로 변경 — 안의 모든 데이터가 그대로 이동.
  await spreadsheetBatchUpdate(env, accessToken, fileId, [
    {
      updateSheetProperties: {
        properties: { sheetId: occupiedSheetId, title: to, index: toIndex },
        fields: "title,index",
      },
    },
  ]);

  // 3. 비워진 from 번호에 template을 복사해 "1~15번은 항상 존재" 불변식을 유지.
  // template 원본의 B2는 자체 placeholder 텍스트("0번" 등)를 그대로 담고
  // 있으므로, performExitReset과 동일하게 번호 기준 문구로 다시 써야 한다
  // (빠뜨리면 집계 탭에 "0번"으로 잘못 표시됨). copySheetWithName이 이름과
  // 숨김 해제까지 처리하고, 위치는 여기서 별도로 바로잡는다.
  const newSheetId = await copySheetWithName(env, accessToken, fileId, templateSheetId, from);
  await spreadsheetBatchUpdate(env, accessToken, fileId, [
    { updateSheetProperties: { properties: { sheetId: newSheetId, index: fromIndex }, fields: "index" } },
  ]);
  await protectSheetForOwnerAndService(env, accessToken, fileId, newSheetId, ownerEmail);

  const fromRow = parseInt(from, 10) + 3;
  const toRow = parseInt(to, 10) + 3;

  // 🔧 [데이터 시트 통합] template 원본의 C42("참조 행 계산 번호", 옛 C38)도
  // B2처럼 고정된 placeholder 값을 담고 있어, 새로 만든 from 탭에도 자기
  // 번호 기준 행 번호로 다시 써야 한다(빠뜨리면 template의 값을 그대로
  // 물려받아 엉뚱한 "데이터" 행을 가리키게 된다). B2 문구도 새 형식으로 통일.
  await writeSheetValues(env, accessToken, fileId, [
    { range: `${from}!B2`, values: [[`📝 ${from}번's 대시보드 📝`]] },
    { range: `${from}!C42`, values: [[fromRow]] },
  ]);

  // 4. 이동된 탭의 "참조 행 계산 번호"(C42)를 새 번호 기준으로 갱신.
  await writeSheetValues(env, accessToken, fileId, [{ range: `${to}!C42`, values: [[toRow]] }]);

  // 5. 🔧 [데이터 시트 통합] "권한관리"+"제보상점"이 "데이터" 한 탭(D=이메일,
  // E=준비시험, F~V=송출P·주간P·사유반휴·제보상점 슬롯)으로 합쳐졌다.
  // from행의 D~V를 통째로 to행으로 옮기고 from행은 이메일/시험은 비우고
  // 나머지 슬롯은 0으로 초기화한다.
  const dataRows = await getSheetValues(env, accessToken, fileId, `데이터!D${fromRow}:V${fromRow}`);
  const dataValues = dataRows[0] || ["", "", ...Array(17).fill(0)];
  await writeSheetValues(env, accessToken, fileId, [
    { range: `데이터!D${toRow}:V${toRow}`, values: [dataValues] },
    { range: `데이터!D${fromRow}:E${fromRow}`, values: [["", ""]] },
    { range: `데이터!F${fromRow}:V${fromRow}`, values: [Array(17).fill(0)] },
  ]);
  await invalidateMemberCache(env, ["roster"]); // 번호별 이메일이 이동/재생성되어 명단과 sheetId가 바뀌었으므로 전체 무효화.
  // to는 from의 벌점/제보상점 값을 새로 물려받았고 from은 곧 신규 회원에게
  // 재배정될 수 있으므로, 두 번호 모두 옛 캐시가 남지 않도록 함께 지운다.
  await Promise.all([invalidateMemberSlotCache(env, from), invalidateMemberSlotCache(env, to)]);
}

// 🔧 [2차 점검, 2026-09-11] moveMemberSlot이 탭 삭제→이름변경→위치조정 등
// 여러 단계를 락 없이 순차 실행해, 관리자 두 명이 "정렬 실행"을 거의
// 동시에 누르면 서로 다른 시점의 계획(plan)으로 같은 탭을 건드려 시트
// 구조가 절반만 이동된 채 깨질 위험이 있었다(경쟁 조건 재검증 완료).
// 개별 이동 단계가 아니라 요청 전체(plan 재계산부터 전체 이동 완료까지)를
// withMemberLock으로 감싼다.
export async function handleAdminMemberReorder(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const fileId = env.GOOGLE_SHEET_FILE_ID;
  const moved = [];
  try {
    const accessToken = await getServiceAccountAccessToken(env);
    await withMemberLock(env, `reorder:${fileId}`, async () => {
      // 클라이언트가 미리보기 이후 시간이 지나 상태가 바뀌었을 수 있으므로,
      // 클라이언트가 보낸 계획을 신뢰하지 않고 서버에서 다시 계산한다.
      const plan = await computeMemberReorderPlan(env, accessToken);

      // "1"번 탭의 위치를 배치 전체에서 딱 한 번만 조회해 고정 기준점으로 쓴다.
      const sheets = await getSpreadsheetMeta(env, accessToken, fileId);
      const oneSheet = sheets.find((s) => s.title === "1");
      if (!oneSheet) throw new Error("1번 탭을 찾을 수 없습니다.");
      const oneIndex = oneSheet.index;

      for (const step of plan) {
        await moveMemberSlot(env, accessToken, fileId, env.ADMIN_EMAIL, step.from, step.to, oneIndex);
        moved.push(step);
      }
    });
    return json({ ok: true, moved }, 200, origin);
  } catch (err) {
    return json({ ok: false, moved, error: err.message }, 500, origin);
  }
}

export async function handleAdminCreateMember(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { number, name, email, gooroomeeAccount, goalHours, goalKind, examKind, joinDate } = await req.json();
  const sheetNum = parseInt(number, 10);
  if (!sheetNum || sheetNum < 1 || sheetNum > 15) {
    return json({ error: "시트번호는 1~15 사이여야 합니다." }, 400, origin);
  }
  if (!name || !email || !goalHours || !goalKind) {
    return json({ error: "이름, 이메일, 의무시간, 타입은 필수입니다." }, 400, origin);
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return json({ error: "이메일 형식이 올바르지 않습니다." }, 400, origin);
  }
  if (gooroomeeAccount && !/^\S+@\S+\.\S+$/.test(gooroomeeAccount)) {
    return json({ error: "구루미 계정 이메일 형식이 올바르지 않습니다." }, 400, origin);
  }
  // 콤마는 D열에서 구글계정/구루미계정을 나누는 구분자로 예약돼 있어, 둘 중
  // 어느 쪽 값에도 콤마가 섞이면 파싱이 깨진다.
  if (email.includes(",") || (gooroomeeAccount || "").includes(",")) {
    return json({ error: "이메일/구루미 계정에는 쉼표를 포함할 수 없습니다." }, 400, origin);
  }
  // 🔧 [첫 참여일 설정] 등록 시점보다 앞으로 최대 일주일 뒤부터 실제 참여를
  // 시작할 회원의 시작일(I2, "가입일")을 미리 정확히 반영할 수 있도록
  // 프론트에서 날짜를 입력받는다.
  const todayKST = todayKSTDateString();
  const latestJoinDate = kstDateOffsetString(6);
  if (joinDate && (!/^\d{4}-\d{2}-\d{2}$/.test(joinDate) || joinDate < todayKST || joinDate > latestJoinDate)) {
    return json({ error: "첫 참여일은 오늘부터 일주일 이내여야 합니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;

    // 🔧 [2차 점검, 2026-09-11] "빈 번호 찾기 → 그 번호에 쓰기"가 읽기-수정-
    // 쓰기(read-modify-write) 구조라, 관리자 두 명이 거의 동시에 등록하면
    // 둘 다 같은 "빈 번호"를 통과해 나중 쓰기가 먼저 등록된 회원을 완전히
    // 덮어써 데이터가 소실될 수 있었다(경쟁 조건 재검증 완료).
    const result = await withMemberLock(env, `newmember:${fileId}`, async () => {
      // 🔧 [데이터 시트 통합] "권한관리" 탭이 "데이터" 탭으로 흡수됐다.
      const authRows = await getSheetValues(env, accessToken, fileId, "데이터!A1:V50");
      const rowIndex = authRows.findIndex((row) => (row[1] || "").trim() === String(sheetNum));
      if (rowIndex === -1) return { failure: { status: 404, message: "존재하지 않는 시트번호입니다." } };
      const existingEmail = parseGoogleEmail(authRows[rowIndex][3]);
      if (existingEmail) return { failure: { status: 409, message: `이미 배정된 번호입니다 (${existingEmail}).` } };

      // 🔧 [이름 중복 자동 처리] 도움봇/집계 시트는 구루미 닉네임과 이름(개인
      // 탭 B2 → 집계 C열 수식)을 정확히 일치시켜 매칭한다.
      const totalRows = await getSheetValues(env, accessToken, fileId, "집계!C4:C18").catch(() => []);
      const existingNames = new Set(totalRows.map((row) => (row[0] || "").trim()).filter(Boolean));
      const trimmedName = name.trim();
      let finalName = trimmedName;
      if (existingNames.has(finalName)) {
        let suffix = 1;
        while (existingNames.has(`${trimmedName}${suffix}`)) suffix += 1;
        finalName = `${trimmedName}${suffix}`;
      }

      const rowNumber = rowIndex + 1; // 1-indexed 시트 행 번호
      const dateStr = joinDate || todayKST;
      const targetTime = `${goalHours}H (${goalKind})`;
      const sheetName = String(sheetNum);
      // D열은 "구글계정,구루미계정" 형태로 저장한다(parseGoogleEmail/
      // parseGooroomeeAccount가 이 순서로 다시 나눠 읽음) — 구루미 계정을 담을
      // 별도 시트 컬럼이 없어 기존 이메일 칸에 함께 넣기로 함(사용자 확인).
      const dCellValue = gooroomeeAccount ? `${email},${gooroomeeAccount}` : email;

      await writeSheetValues(env, accessToken, fileId, [
        // 🔧 [B2 문구 통일] 집계 탭 C열 수식이 이제
        // =TRIM(MID(B2, 3, SEARCH("'s", B2)-3))로 바뀌어 " 님" 대신 "'s"를
        // 찾는다.
        { range: `${sheetName}!B2`, values: [[`📝 ${finalName}'s 대시보드 📝`]] },
        { range: `${sheetName}!I2`, values: [[dateStr]] },
        { range: `${sheetName}!L3`, values: [["스터디원"]] },
        { range: `${sheetName}!O3`, values: [[targetTime]] },
        { range: `데이터!D${rowNumber}`, values: [[dCellValue]] },
        { range: `데이터!E${rowNumber}`, values: [[examKind || ""]] },
      ]);
      return { sheetName, finalName };
    });
    if (result.failure) return json({ error: result.failure.message }, result.failure.status, origin);
    const { sheetName, finalName } = result;
    // 🔧 [사용자 지시, 2026-09-11] "신규 등록이 벌점/벌금/사이클 캐시까지
    // 매번 지우는 건 과도하다" — roster(9종 전부) 대신 이 함수가 실제로
    // 건드리는 범위와 겹치는 캐시만 지우는 newMember 그룹으로 좁힌다.
    await invalidateMemberCache(env, ["newMember"]);
    // 이 번호가 과거 퇴실한 회원의 것이었다면, 그 회원의 벌점/제보상점 KV
    // 캐시가 아직 안 지워진 채 남아있을 수 있으므로 신규 등록 시점에도
    // 한 번 더 방어적으로 지운다.
    await invalidateMemberSlotCache(env, sheetName);

    // 시트 값 기입까지는 성공했으므로, 여기서 Drive 권한 부여만 실패해도
    // "등록 실패"로 되돌리지 않는다 — 프론트가 needsReauth를 보고 연동
    // 안내 후 /admin/members/grant-access로 권한만 재시도할 수 있게 한다.
    try {
      await grantSheetAccess(env, fileId, email);
    } catch (grantErr) {
      return json(
        {
          ok: true,
          number: sheetName,
          name: finalName,
          email,
          needsReauth: true,
          grantError: grantErr.message,
        },
        200,
        origin
      );
    }

    return json({ ok: true, number: sheetName, name: finalName, email }, 200, origin);
  } catch (err) {
    return json({ error: "신규 스터디원 등록 실패: " + err.message }, 500, origin);
  }
}

// 시트 값은 이미 채워졌지만 Drive 권한 부여만 실패했던 회원에게, 관리자 위임
// 재연동 후 권한만 다시 부여한다. 신규 등록 폼을 다시 채울 필요 없이
// 이메일만으로 재시도할 수 있게 한다.
export async function handleGrantMemberAccess(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { email } = await req.json();
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return json({ error: "이메일 형식이 올바르지 않습니다." }, 400, origin);
  }

  try {
    await grantSheetAccess(env, env.GOOGLE_SHEET_FILE_ID, email);
    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "권한 부여 실패: " + err.message }, 500, origin);
  }
}
