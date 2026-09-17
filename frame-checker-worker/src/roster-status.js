// 🔧 [구조 개선 19차, 2026-09-17] 랭킹/로스터/정산 클러스터를
// personal-status.js에서 옮겼다(docs/TESTING.md 참고). 17차 구조
// 감사에서 "index.js에 남은 것"만 살피고 이미 분리된 대형 도메인
// 파일 내부(personal-status.js 등)는 감사 범위 밖이었다는 지적을
// 반영해, 사용자 요청으로 재조사한 뒤 진행했다. buildRosterStatus는
// personal-status.js의 getMeritRank가 실사용 import하고 있어 단방향
// 순환이지만(personal-status.js → roster-status.js만, 역방향 없음),
// 함수 선언(호이스팅)이라 TDZ 위험이 없다. parseWon/verifySession/
// requireAdmin/getServiceAccountAccessToken/resolveTargetFileId/
// resolveMemberNumber/getSheetValues/getSheetUnformattedValue/
// batchGetSheetValues/writeSheetValues/json 등은 여러 도메인이 함께
// 쓰는 index.js의 범용 유틸이라 index.js에서 직접 import한다.
// parseWeekOfToMonday는 personal-status.js의 buildPersonalStatus도
// 실사용해 그 파일에 남아있고, 이 파일이 실사용 import한다(15차
// deposit.js 재export 패턴과 동일하게 "함수 이동이 아니라 실사용
// import"이므로 순환 위험 없음).
import {
  json,
  verifySession,
  getServiceAccountAccessToken,
  resolveMemberNumber,
  resolveTargetFileId,
  requireAdmin,
  getSheetValues,
  getSheetUnformattedValue,
  batchGetSheetValues,
  writeSheetValues,
  parseWon,
} from "./index.js";
import { _cachedCompute, invalidateMemberCache } from "./cache.js";
import { formatYYMMDD, currentWeekMondayKST } from "./date-utils.js";
import { parseWeekOfToMonday, currentWeekRangeYYMMDD } from "./personal-status.js";

// --- 전체 대시보드('집계' 시트 요약) ---
// 로그인한 사람이면 누구나 볼 수 있다 — 이름/순위/타이머/총 상점을 노출한다
// (상태는 더 이상 프론트에서 쓰지 않지만 응답에는 계속 포함해 하위호환 유지).
//
// 🔧 [캐싱 추가, 2026-09-10] 캐시 없이 매 요청마다 Sheets API를 4번씩(집계
// 본문/집계 D20:D24+P6/데이터 F4:M4/집계 D25) 직접 호출하고 있었다 — 로그인한
// 회원 15명 전원이 같은 파일의 같은 스냅샷을 보는 공용 데이터인데도 캐시가
// 하나도 없어, RANK 탭이 열릴 때마다 그대로 쿼터를 소진했다(사용자 지적).
// reportScore와 동일한 원칙(파일당 1개 키 — "표시만 지연될 뿐 정합성엔
// 무해"하다고 이미 확인된 것과 같은 성격의 데이터)으로 파일당 하나의 키에
// 캐싱한다. 무효화는 "roster" 그룹(신규등록/퇴실 등 명단 자체가 바뀌는
// 저빈도 이벤트)에 자동 포함되고, "상금 정산 집행" 마킹은 별도로 좁은
// "rosterOnly" 그룹을 즉시 호출한다(handleAdminPrizeSettle 참고).
// 🔧 [TTL 하향, 2026-09-11] RANK 탭 폴링(30분)과 TTL이 30분으로 같아
// "폴링:TTL = 1:1"이 되어 매 폴링마다 캐시가 이미 만료돼 있어 재계산되는
// 문제가 있었다(§12.1의 "폴링은 TTL의 3배 이상" 원칙 미달). 10분으로
// 낮춰 3:1을 맞춘다 — 회원 수와 무관한 파일당 1개 키라 TTL을 낮춰도 KV
// 쓰기 증가는 미미하다(최악 하루 30분→10분 기준 KV put 48회→144회
// 수준이지만, 실제로는 대부분 인메모리/다른 isolate의 캐시로 흡수됨).
// 🔧 [중복 캐시 통합, 2026-09-10] MY 탭의 getMeritRank가 별도로 쓰던
// meritRank:{fileId} 캐시(집계!B4:F18)는 이 members 배열의 부분집합이라
// (사용자 지적: "MY랑 RANK 둘이 같이 가져오는 걸로 해도 되지 않나?"),
// getMeritRank가 이 함수를 그대로 재사용하도록 통합했다 — meritRank: 키는
// 폐지됐다.
//
// 🔧 [과거 fileId TTL 상향, 2026-09-10] "과거 주차를 여러 번 토글해도
// 10~30분마다 재계산·KV 재기입이 반복되는 게 낭비 아니냐"는 지적 —
// 과거(백업) fileId는 관리자가 이 Worker의 API로 처리하지 않는 한 원본이
// 절대 바뀌지 않는다. 벌금 납부(handleAdminFineStatus)·상금 정산 집행
// (handleAdminPrizeSettle)·퇴실 확정(handleAdminExitConfirm)이 과거
// fileId를 대상으로 쓰기를 하면 각각 invalidateMemberCache에 그 fileId를
// 정확히 넘겨 즉시 무효화하므로(사용자 확인: "관리자가 쓰기 작업을 해서
// 과거 시트 값이 갱신되면 캐시가 바로 무효화되는 게 맞다"), TTL을 2시간
// (현재 시트는 그대로 30분)으로 늘려도 낡은 값이 남는 문제는 생기지 않는다.
const ROSTER_ROW_START = 3; // 시트 4행(0-indexed 3)부터 15명
const ROSTER_ROW_END = 17; // 시트 18행(0-indexed 17)까지

export async function buildRosterStatus(env, accessToken, fileId) {
  const ttlMs = fileId === env.GOOGLE_SHEET_FILE_ID ? 10 * 60_000 : 2 * 60 * 60_000;
  return _cachedCompute(env, `rosterStatus:${fileId}`, ttlMs, () => _computeRosterStatus(env, accessToken, fileId));
}

async function _computeRosterStatus(env, accessToken, fileId) {
  const [rows, [moneyRows, prizeSettleRows], studyLeadSlotRows, cycleRows] = await Promise.all([
    getSheetValues(env, accessToken, fileId, "집계!A4:L18"),
    // D20:D24(총 모금액~퇴실예치)와 P6("상금 정산 집행" 마킹, handleAdminPrizeSettle
    // 참고)를 한 번의 batchGet으로 묶어 API 호출 횟수를 아낀다.
    batchGetSheetValues(env, accessToken, fileId, ["집계!D20:D24", "집계!P6"]).catch(() => [[], []]),
    // 스터디장(1번 회원, 데이터 시트 4행)의 송출P/주간P 슬롯 — 값이 현재
    // 페널티 사이클(D25)과 같으면 "이번 주간 발생"으로 친다(집계!D20 수식과
    // 동일한 판정 기준).
    getSheetValues(env, accessToken, fileId, "데이터!F4:M4").catch(() => []),
    // 🔧 [D25 서식 파싱 버그 수정] D25는 "1/3주차"처럼 커스텀 숫자 서식이
    // 입혀져 있어(getCurrentPenCycle 주석 참고) 기본 렌더링(FORMATTED_VALUE)
    // 으로 읽으면 텍스트로 온다 — 원래 getSheetValues로 읽어 studyLeadSlots
    // (순수 숫자 "1"/"2"/"3")와 문자열 비교했는데 형태가 달라 항상 false가
    // 되어, depositOuterIncluded가 조건과 무관하게 항상 꺼진 채로 일반
    // 회원에게 퇴실 예치금이 상시 숨겨지고 있었다. 서식 무시하고 원본
    // 숫자를 읽는 전용 함수로 교체.
    getSheetUnformattedValue(env, accessToken, fileId, "집계!D25").catch(() => []),
  ]);

  const members = [];
  for (let i = 0; i <= ROSTER_ROW_END - ROSTER_ROW_START; i++) {
    const row = rows[i] || [];
    const name = (row[2] || "").trim();
    const status = (row[10] || "").trim();
    if (!name || status === "빈 시트") continue;

    members.push({
      number: (row[1] || "").trim(),
      name,
      timer: (row[3] || "").trim(),
      merit: (row[4] || "").trim(),
      rank: (row[5] || "").trim(),
      status,
    });
  }

  // 집계 D20~D24: 총 모금액/이월 상금/주간 벌금/퇴실 벌금/퇴실 예치.
  const collectMoney = parseWon((moneyRows[0] && moneyRows[0][0]) || "");
  const fineCarry = parseWon((moneyRows[1] && moneyRows[1][0]) || "");
  const fineThisWeek = parseWon((moneyRows[2] && moneyRows[2][0]) || "");
  const fineOuter = parseWon((moneyRows[3] && moneyRows[3][0]) || "");
  const depositOuter = parseWon((moneyRows[4] && moneyRows[4][0]) || "");

  const currentCycle = (cycleRows[0] && cycleRows[0][0] || "").toString().trim();
  const studyLeadSlots = studyLeadSlotRows[0] || [];
  const depositOuterIncluded =
    currentCycle !== "" && studyLeadSlots.some((v) => (v || "").toString().trim() === currentCycle);

  // "이번 주 정산": 총 모금액(D20)을 1~5등(메달 랭크)에게 1/n 균등 분배한다.
  // RosterView.tsx의 rankValue/MEDAL_RANK와 동일한 기준으로 1~4등은 이모지
  // (🥇🥈🥉🏅), 5등은 숫자 "5"로 온다 — 프론트와 판정 기준을 반드시 맞춰야
  // 화면에 보이는 랭킹과 정산 대상이 어긋나지 않는다.
  const MEDAL_RANK_VALUE = { "🥇": 1, "🥈": 2, "🥉": 3, "🏅": 4 };
  function rankValueForSettlement(rank) {
    const trimmed = (rank || "").trim();
    if (!trimmed || trimmed === "-") return null;
    if (trimmed in MEDAL_RANK_VALUE) return MEDAL_RANK_VALUE[trimmed];
    const n = parseInt(trimmed, 10);
    return Number.isNaN(n) ? null : n;
  }
  const settlementMembers = members
    .map((m) => ({ number: m.number, name: m.name, rankValue: rankValueForSettlement(m.rank) }))
    .filter((m) => m.rankValue !== null && m.rankValue <= 5)
    .sort((a, b) => a.rankValue - b.rankValue);
  const settlementShare = settlementMembers.length > 0 ? Math.floor(collectMoney / settlementMembers.length) : 0;
  const settlement = settlementMembers.map((m) => ({ number: m.number, name: m.name, rank: m.rankValue, amount: settlementShare }));
  // 🔧 2026-09: "정산 내역"을 관리자가 실제로 집행(핸드폰으로 송금 등)했는지는
  // handleAdminPrizeSettle이 쓰는 집계!P6("완료" 문자열) 하나로만 판정한다
  // (사용자 지시) — 이 값을 응답에 그대로 반영해, 프론트가 "정산 대상은
  // 계산됐지만 아직 집행 전"과 "이미 집행 완료"를 구분해 표시할 수 있게 한다.
  const settlementSettled = ((prizeSettleRows[0] && prizeSettleRows[0][0]) || "").toString().trim() === "완료";

  return {
    members,
    collectMoney,
    fineCarry,
    fineThisWeek,
    fineOuter,
    depositOuter,
    depositOuterIncluded,
    settlement,
    settlementSettled,
  };
}

export async function handleRosterStatus(req, env, origin, url) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const cycleFileId = url ? url.searchParams.get("cycle") : null;
    const { fileId: targetFileId, weekOf } = await resolveTargetFileId(env, accessToken, cycleFileId);
    // 🔧 [캐시 오염 방지, 2026-09-10] buildRosterStatus가 이제 30분 캐시를
    // 쓰면서 반환 객체가 여러 요청·isolate에 걸쳐 재사용될 수 있게 됐다 —
    // 아래에서 weekRange 병합·depositOuter/settlement 삭제로 이 객체를
    // 직접 변형(mutate)하면, 그 변형이 캐시된 원본에 그대로 남아 이후
    // 다른 요청(다른 회원, 다른 cycle 파라미터, 관리자 여부가 다른 요청)
    // 에까지 잘못 전파된다 — 예를 들어 정산 비공개 시각에 조회한 일반
    // 회원의 delete roster.settlement가 캐시 원본에 반영되면, 그 뒤 공개
    // 시각이 지나 조회한 관리자도 캐시 만료 전까지 정산 정보를 못 보게
    // 된다. 얕은 복사본에만 이후 변형을 적용한다.
    const cached = await buildRosterStatus(env, accessToken, targetFileId);
    const roster = { ...cached };
    // 🔧 2026-09: RosterPage("랭킹"/"상금 정산" 타이틀)가 "YYMMDD-YYMMDD
    // 주간"을 병기할 수 있도록 이 조회가 보여주는 주(월~일)의 시작/종료일을
    // 함께 내려준다(사용자 지시).
    const weekRange = currentWeekRangeYYMMDD(weekOf);
    if (weekRange) Object.assign(roster, weekRange);
    // 퇴실 예치(D24)가 총 모금액에 포함되지 않는 주간에는, 관리자가 아닌
    // 일반 참여자에게는 이 항목 자체를 숨긴다(스터디장 개인 페널티 여부를
    // 노출하지 않기 위함) — 값을 응답에서 아예 빼서 프론트가 있는지
    // 여부로 노출 판단을 하게 한다.
    // 🔧 [사용자 지시] "관리자 판정 비교 일관성" — 위 5185행과 동일한
    // 이유로 양쪽 다 소문자화.
    const isAdmin = (session.email || "").toLowerCase() === (env.ADMIN_EMAIL || "").toLowerCase();
    if (!roster.depositOuterIncluded && !isAdmin) {
      delete roster.depositOuter;
    }

    // "이번 주 정산" 노출 시각 제한은 실시간 조회(=현재 진행 중인 주)에만
    // 적용한다 — 이미 백업된 과거 주차(cycleFileId 지정)는 그 주가 이미
    // 끝났으므로 스포일러 문제가 없어 항상 공개한다. 실시간일 때는
    // 스터디장(1번 회원)·관리자에게는 즉시 보이지만(관리자는 Money 탭
    // "상금 수령 대상자 처리"에서 상시 확인해야 하므로 2026-09에 추가),
    // 그 외 스터디원은 일요일 14교시 종료(23:30 KST) 전까지는 볼 수
    // 없다 — 정산이 확정되기 전 순위를 미리 알면 남은 시간 동안의 경쟁
    // 동기가 흐려지므로.
    const isRealtime = targetFileId === env.GOOGLE_SHEET_FILE_ID;
    if (isRealtime && !isAdmin) {
      let memberNumber = null;
      try {
        memberNumber = await resolveMemberNumber(env, accessToken, session);
      } catch {
        // 회원 매칭 실패는 정산 비공개로만 처리하고 전체 요청을 막지 않는다.
      }
      const isStudyLead = memberNumber === "1";
      if (!isStudyLead && !isSettlementVisibleToMembers()) {
        delete roster.settlement;
      }
    }

    return json(roster, 200, origin);
  } catch (err) {
    return json({ error: "전체 대시보드 조회 실패: " + err.message }, 500, origin);
  }
}

// Money 탭 "상금 수령 대상자 처리"의 "상금 정산 집행" 버튼 — 관리자가 이번 주
// 1~5등 분배를 실제로 지급했다는 걸 시트에 기록하는 단순 마킹. 다른 상태
// 마킹처럼 셀 하나(집계!P6)에 "완료" 문자열을 쓰기만 한다.
// 🔧 [버그 수정, 2026-09-10] 이 값은 buildRosterStatus의 settlementSettled로
// 이미 읽혀 RANK 탭에 노출되고 있었다 — "판정에 쓰는 기존 로직이 없다"는
// 이전 주석이 낡아 있었다(buildRosterStatus 도입 당시 갱신을 놓침). RANK
// 탭에 캐싱(rosterStatus:, 30분)을 새로 추가하면서, 이 마킹도 즉시
// 무효화해야 "정산 집행 완료" 상태가 최대 30분 늦게 반영되는 걸 막을 수
// 있다.
// 🔧 [사용자 지시, 2026-09-11] PEN·Money 탭 전면 재점검 — rosterStatus:는
// penalty 그룹(제보 승인) 무효화에서 의도적으로 빠져있어(§16, §31) 최대
// 10분 낡을 수 있는데, 프론트가 재조회해도 그 사이 캐시가 안 지워졌으면
// 여전히 낡은 총 모금액을 받아 검증이 무의미해질 수 있었다. 집행 직전에
// 이 함수 자체가 rosterOnly 그룹을 먼저 지우고 buildRosterStatus를 다시
// 계산해, 프론트가 보낸 expectedCollectMoney와 "진짜 최신" 총 모금액을
// 대조한다 — 프론트 재확인(느슨한 안전장치)과 별개로 서버가 최종 방어선
// 역할을 한다.
// 🔧 [2차 점검, 2026-09-11] "총 모금액만 검증하면 부족하다" — 제보 승인은
// 집계 F열(순위) 수식만 바꾸고 D20(총 모금액)은 안 바꾸므로, 총액이
// 그대로인 채 1~5등 수령자 구성만 바뀌는 경우 위 검증을 그대로 우회했다.
// 관리자가 화면에 뜬 명단을 보고 먼저 실제로 송금한 뒤 이 버튼으로 완료만
// 기록하는 워크플로우라(§6230 주석), 낡은 명단으로 잘못된 사람에게 이미
// 송금된 뒤에야 뒤늦게 막히는 게 진짜 위험이었다. 프론트가 화면에 표시된
// 수령자 번호 순서(expectedSettlementNumbers)도 함께 보내면, 서버가
// 재계산한 최신 순위 기준 수령자 번호 순서와 정확히 일치할 때만 집행을
// 허용한다. settlement는 rankValue로 안정 정렬되어 같은 데이터면 항상
// 같은 순서로 나오므로(비결정 요소 없음), 실제로 명단이 안 바뀌었다면
// 오탐 없이 통과한다.
// 🔧 [사용자 지시, 2026-09-12] "상금 정산 집행을 지난 주 사이클에
// 반영" — 상금 정산은 일요일까지의 지난 한 주 실적을 대상으로 하지만
// 실제 집행은 다음 주 중(일요일 당일 처리는 실무상 어려움)에 이뤄진다.
// 원래는 cycle과 무관하게 항상 env.GOOGLE_SHEET_FILE_ID(실시간 원본)에만
// 썼는데, 월요일 새벽 리셋이 지나면 원본은 이미 "이번 주"로 전환되어
// 있어(총 모금액 D20·순위 F열이 라이브 수식) 화요일에 집행해도 지난
// 주가 아니라 텅 빈 이번 주 기준으로 처리되는 사이클 오인 위험이 있었다.
// 벌금 납부 처리(handleAdminFineStatus)와 동일하게 cycle을 필수로 받아
// resolveTargetFileId로 검증한 그 사이클(지난 주 백업) 파일에 직접
// 쓰도록 바꾼다 — 퇴실/재납 처리와 달리 "그 주에 상금을 지급했다"는
// 순수 기록성 사실이라, 현재 시점에 별도로 반영할 상태/권한이 없다
// (사용자 확인: "상금은 지난 주에만 기록하면 충분"). cycle이 없으면
// (=이번 주를 보고 있으면) 애초에 집행 대상이 존재하지 않으므로 거부한다
// — 이렇게 하면 일요일(아직 백업 자체가 없어 선택할 지난 사이클이
// 없음)엔 자연히 집행이 불가능해진다.
export async function handleAdminPrizeSettle(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const { expectedCollectMoney, expectedSettlementNumbers, cycle } = await req.json().catch(() => ({}));
    if (!cycle) {
      return json(
        { error: "상금 정산은 지난 주 사이클을 선택한 상태에서만 집행할 수 있습니다." },
        400,
        origin
      );
    }
    const accessToken = await getServiceAccountAccessToken(env);
    const { fileId } = await resolveTargetFileId(env, accessToken, cycle);
    await invalidateMemberCache(env, ["rosterOnly"], fileId);
    const latest = await buildRosterStatus(env, accessToken, fileId);
    const latestNumbers = (latest.settlement || []).map((s) => s.number);
    const collectMoneyChanged =
      typeof expectedCollectMoney === "number" && expectedCollectMoney !== (latest.collectMoney ?? 0);
    const settlementChanged =
      Array.isArray(expectedSettlementNumbers) &&
      (expectedSettlementNumbers.length !== latestNumbers.length ||
        expectedSettlementNumbers.some((num, i) => num !== latestNumbers[i]));
    if (collectMoneyChanged || settlementChanged) {
      return json(
        {
          error: "정산 대상 정보가 방금 바뀌었습니다. 화면을 새로고침한 뒤 다시 확인해 주세요.",
          collectMoney: latest.collectMoney ?? 0,
        },
        409,
        origin
      );
    }
    await writeSheetValues(env, accessToken, fileId, [{ range: "집계!P6", values: [["완료"]] }]);
    await invalidateMemberCache(env, ["rosterOnly"], fileId);
    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "상금 정산 집행 처리 실패: " + err.message }, 500, origin);
  }
}
