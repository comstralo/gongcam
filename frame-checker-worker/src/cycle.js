// 🔧 [구조 개선, 2026-09-13] 완전 순수한 사이클 판정 함수를 index.js에서
// 분리했다(docs/TESTING.md 참고) — fetch/DO/캐시/시계에 전혀 의존하지
// 않는다. requiresFineUnpaidRecheck는 FINE_UNPAID_ADMIN_FORCED_REASON을
// 참조하는데, 이 상수는 index.js의 다른 곳(FINE_UNPAID_ADMIN_FORCED_REASON_LABEL)
// 에서도 쓰이므로 index.js에 남겨두고 여기서 import한다 — index.js는
// 재export 목적으로만 이 파일을 import하고 최상위에서 값을 즉시 평가하지
// 않으므로(전부 요청 처리 시점에 지연 호출됨) 순환 import가 생겨도 TDZ
// 문제가 없다.
//
// 🔧 [구조 개선 2차, 2026-09-13] fetch(Google Sheets/Drive API)와 DO에
// 의존하는 나머지 사이클 함수도 이어서 옮겼다. getSheetValues/
// getCurrentPenCycle은 사이클 전용이 아니라 회원/벌점/제보점수/퇴실판정
// 등 여러 도메인에서 광범위하게 쓰이는 범용 함수라(index.js 곳곳에서
// 직접 호출) index.js에 남기고 이 파일이 import만 한다 — 위와 동일한
// 재export 전용 순환 패턴이라 안전하다.
// 🔧 [구조 개선 9차, 2026-09-13] hasUnpaidFineInCycle/hasForcedCandidateInCycle/
// handleCycleList를 index.js에서 옮겼다(docs/TESTING.md 참고). 이 셋은
// fines.js의 listUnpaidFines, exit.js의 getAllExitRelevantStatus/
// listExitCandidates, deposit.js의 calcForcedOutDeposit을 실제 사용
// 목적으로 참조한다 — 재export가 아니라 8차까지 반복된 "실사용 import"
// 패턴 그대로다.
import {
  FINE_UNPAID_ADMIN_FORCED_REASON,
  getSheetValues,
  getCurrentPenCycle,
  getSharedMemberRows,
  STATUS_DAY_COLS,
  ROW_PAYMENT_CHECK,
  verifySession,
  getServiceAccountAccessToken,
  json,
  findMemberNumberByEmail,
} from "./index.js";
import { listAllMembers } from "./members.js";
import { listUnpaidFines } from "./fines.js";
import { getAllExitRelevantStatus, listExitCandidates } from "./exit.js";
import { calcForcedOutDeposit } from "./deposit.js";
import { getLeaveQueueStub } from "./durable-objects.js";
import { weekOfForDate, kstDateKey, formatYYMMDD, currentWeekMondayKST, exitWeekResetPassed } from "./date-utils.js";

// 사이클 하나는 최대 3주 — 안전장치(사이클값이 리셋되지 않는 이상 상황 대비)
export const CYCLE_MAX_LEN = 3;

// 🔧 [사용자 지시] "직권 P 사이클 오인 방지" — admin_forced는 settle과
// 달리 exitDate로 서버가 자동으로 지난 주 백업을 찾아주는 로직이 없고,
// 오직 프론트가 넘기는 cycle 파라미터에만 의존한다(resolveExitSourceFileId
// 참고). 프론트의 cycleFileId는 화면을 열면 항상 null(=이번 주)로
// 시작하므로, 관리자가 사이클 전환을 깜빡한 채 "벌금 시한 내 미납자"
// 고정 사유로 확정하면 이미 초기화됐을 수 있는 이번 주 원본을 계산
// 근거로 써버릴 위험이 있었다. 이 고정 사유일 때만, 계산 기준 시트에서
// 실제로 미납 상태인지 재검증한다 — 관리자가 자유 입력한 사유(미납과
// 무관한 처리)는 검증 대상이 아니다.
export function requiresFineUnpaidRecheck(kind, forcedReason) {
  return kind === "admin_forced" && (forcedReason || "").trim() === FINE_UNPAID_ADMIN_FORCED_REASON;
}

// 🔧 [사용자 지시] "자유 사유 직권 P의 사이클 오인 잠재 위험 차단" —
// admin_forced는 서버가 자동으로 사이클을 판단해줄 근거(exitDate 같은
// 날짜 필드)가 없어 cycleFileId 파라미터를 그대로 신뢰한다. "벌금 시한
// 내 미납자" 고정 사유는 requiresFineUnpaidRecheck가 실제 미납 여부로
// 재검증하지만, 관리자가 자유 입력한 사유는 검증할 조건 자체가 없어
// cycleFileId가 함께 오면 "리셋된 이번 주 원본을 지난 주 데이터인 것
// 처럼 계산해 그 빈 스냅샷을 감사 기록으로 영구 저장"하는 사고가
// 가능하다. 현재 두 UI 경로(MemberRosterList=자유사유+cycle 없음,
// AdminMoneyTab=cycle 있음+고정사유)가 이 조합을 우연히 만들지 않을
// 뿐, 서버 API 자체엔 막는 검증이 없었다 — 향후 UI가 바뀌거나 API를
// 직접 호출하면 조용히 재현되므로, "이 조합 자체를 거부"하는 방식으로
// 근본 차단한다(§CACHING_POLICY.md 참고).
export function isUnguardedAdminForcedCycleCombo(kind, forcedReason, cycleFileId) {
  return kind === "admin_forced" && !!cycleFileId && !requiresFineUnpaidRecheck(kind, forcedReason);
}

// weekOf(파일명의 시작일 YYMMDD)로 최신순 정렬
export function compareWeekOfDesc(a, b) {
  return b.weekOf.localeCompare(a.weekOf);
}

// 🔧 [버그 수정, 2026-09] "최신 백업부터 훑다가 사이클값 1을 만나면(포함)
// 멈춘다"는 이전 로직은 현재 시트가 지금 1주차로 막 시작된 시점에 완전히
// 틀린 결과를 낸다 — sheet_reset()(appscript.js)은 D25(사이클)를 갱신하기
// *전에* 백업을 먼저 뜨므로, 백업 파일엔 항상 "그 주가 실제로 몇 주차였는지"
// 값이 그대로 남는다(1→2→3→1 순환). 즉 지금이 1주차라면 지난 주 백업은
// 리셋 직전 원본이 3주차였을 때 만들어졌으니 사이클값=3이고, 그 앞은 2, 그
// 앞(3주 전)에야 1을 만난다 — 옛 로직대로면 "1을 만날 때까지"가 방금 끝난
// 이전 사이클 3주 전체를 통째로 반환해버려, 1주차인 지금은 아직 이번
// 사이클의 백업이 하나도 없어야 하는데도 "현재 사이클 백업 3개"로 잘못
// 응답했다. 현재 시트 자체의 사이클 값(currentCycle)을 먼저 읽어 "이번
// 사이클에서 이미 지난 주가 몇 주인지"(currentCycle - 1)를 정확히 계산하고,
// 그 개수만큼만 최신 백업을 모은다 — 1주차면 0개, 2주차면 1개(사이클값=1인
// 것 하나), 3주차면 2개(사이클값 2, 1인 것 순서대로)를 반환한다.
export function currentCycleBackups(backups, currentCycle) {
  const wantedCount = Math.min(CYCLE_MAX_LEN - 1, Math.max(0, currentCycle - 1));
  return backups.slice(0, wantedCount);
}

// --- 지난 기록: 앱스크립트가 매주 초기화 직전 Drive에 남기는 백업 시트를 조회 ---
// 백업 파일명 패턴: "공부합시당 캠스터디 YYMMDD-YYMMDD" (+선택적 " (N)" 중복 접미사).
// 이 파일들은 원본 시트를 통째로 복사한 사본이라 탭 구조(집계/1~15/권한관리 등)가 동일하다.
// 이 폴더는 일반 사용자와 공유되어 있지 않고, 서비스 계정에게만 뷰어 권한이 부여되어 있다.

const BACKUP_FILENAME_RE = /^공부합시당 캠스터디 (\d{6})-(\d{6})(?: \(\d+\))?$/;
const BACKUP_HISTORY_START_WEEK_OF = "260810"; // 이 주차(포함)부터만 지난 기록으로 취급

export async function listBackupFiles(env, accessToken) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?` +
      new URLSearchParams({
        q: `'${env.BACKUP_FOLDER_ID}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet'`,
        fields: "files(id,name)",
        pageSize: "200",
      }),
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!data.files) throw new Error("백업 폴더 조회 실패: " + JSON.stringify(data));

  const backups = [];
  for (const f of data.files) {
    const m = f.name.match(BACKUP_FILENAME_RE);
    if (!m) continue;
    const weekOf = m[1];
    if (weekOf < BACKUP_HISTORY_START_WEEK_OF) continue;
    backups.push({ fileId: f.id, weekOf, weekTo: m[2] });
  }
  backups.sort(compareWeekOfDesc);
  return backups;
}

// 관리자/일반 구분 없이 누구나 "현재 진행 중인 사이클(최대 3주) 중 이미
// 백업된 주차"까지만 조회할 수 있다 — 그 이전 사이클(4주 이상 전)은
// 대상이 아니다. MY/ALL 상단의 "사이클 토글"이 이 목록 + "현재"(실시간,
// fileId 없음)를 함께 보여준다.
export async function listCurrentCycleBackups(env, accessToken) {
  const [backups, currentCycle] = await Promise.all([
    listBackupFiles(env, accessToken),
    getCurrentPenCycle(env, accessToken, env.GOOGLE_SHEET_FILE_ID),
  ]);
  return { backups: currentCycleBackups(backups, currentCycle), currentCycle };
}

// /status, /roster-status가 공통으로 쓰는 헬퍼 — cycle 쿼리 파라미터(백업
// fileId)가 주어지면 그 백업이 "현재 진행 중인 사이클"에 실제로 속하는지
// 검증한 뒤 그 fileId를 반환하고, 없으면 현재 활성 시트(GOOGLE_SHEET_FILE_ID)를
// 반환한다 — 사이클 밖의 임의 fileId로 과거 무제한 조회를 막기 위한 검증이다.
// 🔧 [가입일 이전 요일 비활성화용] fileId뿐 아니라 그 fileId가 어느 주(weekOf,
// "YYMMDD" 형식의 월요일)인지도 함께 반환한다 — buildPersonalStatus가 요일별
// 실제 캘린더 날짜를 계산해 "가입 전 요일"을 판정하는 데 쓴다. 실시간(라이브
// 시트) 조회면 특정 백업 주차가 없으므로 weekOf는 null — 호출부가 "오늘
// 기준 이번 주"로 직접 계산한다.
export async function resolveTargetFileId(env, accessToken, cycleFileId) {
  if (!cycleFileId) return { fileId: env.GOOGLE_SHEET_FILE_ID, weekOf: null };
  const { backups } = await listCurrentCycleBackups(env, accessToken);
  const backup = backups.find((b) => b.fileId === cycleFileId);
  if (!backup) throw new Error("현재 사이클에 속하지 않는 기록입니다.");
  return { fileId: backup.fileId, weekOf: backup.weekOf };
}

// exitDate가 속한 주의 자동 백업 파일(fileId)을 찾는다. sheet_reset이 아직
// 그 주 백업을 만들지 않았으면(리셋 전, 또는 드물게 백업 실패) null.
async function findBackupForExitDate(env, accessToken, exitDate) {
  const weekOf = weekOfForDate(exitDate);
  if (!weekOf) return null;
  const backups = await listBackupFiles(env, accessToken);
  return backups.find((b) => b.weekOf === weekOf) || null;
}

// 🔧 [KV → DO 이전, 2026-09-12] §47 — 퇴실 확정(settle)은 LeaveQueue DO에서
// 조회한 exitDate가 이미 리셋을 넘겼으면 그 주의 백업(sourceFileId)을 써야
// 한다 — 원본 시트는 이미 다음 사이클로 넘어가 exitDate 시점 값을 담고 있지
// 않기 때문이다. admin_forced/forced/deposit_again은 cycleFileId(프론트
// 사이클 토글)를 그대로 신뢰한다.
export async function resolveExitSourceFileId(env, accessToken, fileId, number, kind, cycleFileId) {
  if (kind === "settle") {
    const exitRequestEntry = await getLeaveQueueStub(env)
      .fetch(`https://do/exit/get?memberNumber=${encodeURIComponent(number)}`)
      .then((r) => r.json())
      .then((d) => d.entry)
      .catch(() => null);
    if (exitRequestEntry) {
      const exitDate = exitRequestEntry.exitDate || null;
      if (exitDate && exitWeekResetPassed(exitDate)) {
        const backup = await findBackupForExitDate(env, accessToken, exitDate);
        if (!backup) {
          throw new Error("퇴실 예약 주차의 백업 시트를 아직 찾을 수 없습니다. 잠시 후 다시 시도해주세요.");
        }
        return { sourceFileId: backup.fileId, fromBackup: true };
      }
    }
  }
  if (cycleFileId) {
    const { fileId: resolvedFileId } = await resolveTargetFileId(env, accessToken, cycleFileId);
    return { sourceFileId: resolvedFileId, fromBackup: resolvedFileId !== fileId };
  }
  return { sourceFileId: fileId, fromBackup: false };
}

// 🔧 [사용자 지시] "화각 불량 제보 확인 — 벌점·상점을 제보 발생
// 사이클에 기록" — handleAdminCaptureDecide는 cycle 파라미터 없이
// 항상 실시간 원본에만 벌점(applyOutputPenalty)/제보상점
// (applyReportMerit)을 썼다. 이 벌점은 강제퇴실/예치금 재납 판정의
// 실질적 카운터라, 위반이 실제 발생한 사이클이 아니라 관리자가
// 처리 버튼을 누른 시점의 사이클에 잘못 귀속되면 페널티 판정 자체가
// 왜곡된다 — "그 사이클에 발생한 일은 그 사이클에 기록되어야 한다"
// 는 원칙(사용자 확인)에 따라, 제보 발생 시각(ts)이 속한 주(월~일)의
// fileId를 판정한다.
export async function resolveCaptureSourceFileId(env, accessToken, fileId, ts) {
  const weekOf = weekOfForDate(kstDateKey(ts));
  if (!weekOf) return { sourceFileId: fileId, fromBackup: false };
  const currentWeekOf = formatYYMMDD(currentWeekMondayKST());
  // (a) 이번 주에 발생 — 원본 그대로.
  if (weekOf === currentWeekOf) return { sourceFileId: fileId, fromBackup: false };
  // (b) 같은 3주 사이클 안에서 주만 넘어간 경우 — 벌점 슬롯(F~K열)은
  // 3주 사이클 전체가 공유하는 카운터라 그 주의 백업에 써도 원본과
  // 이어진다. resolveTargetFileId가 "현재 사이클(최대 2개 백업)"
  // 소속 여부를 검증해준다.
  const { backups } = await listCurrentCycleBackups(env, accessToken);
  const inCycle = backups.find((b) => b.weekOf === weekOf);
  if (inCycle) return { sourceFileId: inCycle.fileId, fromBackup: true };
  // (c) 이미 그 사이클 자체가 끝나버린 경우(다음 사이클로 넘어감) —
  // 그 위반이 발생한 사이클은 리셋되어 죽었지만, 실제 발생 시점
  // 기준으로 정확히 그 백업 파일에 기록해야 한다(사용자 확인) —
  // 그래야 관리자가 그 사이클로 토글했을 때 강제퇴실/재납 판정에
  // 반영된다. listBackupFiles(사이클 제약 없음)에서 직접 찾는다.
  const allBackups = await listBackupFiles(env, accessToken);
  const outOfCycle = allBackups.find((b) => b.weekOf === weekOf);
  if (!outOfCycle) {
    throw new Error("제보가 발생한 주차의 백업 시트를 아직 찾을 수 없습니다. 잠시 후 다시 시도해주세요.");
  }
  return { sourceFileId: outOfCycle.fileId, fromBackup: true };
}

// 그 fileId(사이클)에 벌금 미납 기록이 하나라도 있는지 확인한다.
// memberNumber가 있으면 그 회원 한 명만, 없으면 전체 회원 기준.
// listUnpaidFines/getAllPaymentRows가 이미 getSharedMemberRows(10분
// 캐시)를 거치므로, 벌금 탭이 같은 fileId를 방금 조회했다면 캐시를
// 그대로 재사용한다.
export async function hasUnpaidFineInCycle(env, accessToken, fileId, memberNumber) {
  if (memberNumber) {
    const members = await listAllMembers(env, accessToken, fileId);
    const member = members.find((m) => m.number === memberNumber);
    if (!member) return false;
    const [rows] = await getSharedMemberRows(env, accessToken, fileId, [member]);
    const paymentRow = (rows && rows[ROW_PAYMENT_CHECK]) || [];
    return STATUS_DAY_COLS.some((col) => paymentRow[col] === "미납");
  }
  const unpaid = await listUnpaidFines(env, accessToken, fileId);
  return unpaid.length > 0;
}

// 그 fileId(사이클)에 forced(자동 강제퇴실, "페널티 2회 이상") 후보가
// 있는지 확인한다. memberNumber가 있으면 그 회원 한 명만, 없으면 전체
// 회원 기준(listExitCandidates와 동일 필터 — §6532의 "페널티 대상자"
// 조건 그대로 재사용). getAllExitRelevantStatus가 이미 fileId별 10분
// 캐시(exitStatus:{fileId})이므로, "예치금 재납 대상 처리" 화면이 같은
// fileId를 방금 조회했다면 캐시를 그대로 재사용한다.
export async function hasForcedCandidateInCycle(env, accessToken, fileId, memberNumber) {
  if (memberNumber) {
    const members = await listAllMembers(env, accessToken, fileId);
    const member = members.find((m) => m.number === memberNumber);
    if (!member) return false;
    const statuses = await getAllExitRelevantStatus(env, accessToken, fileId, members);
    const status = statuses.find((s) => s && s.member.number === memberNumber);
    if (!status || /^(퇴실자|재납자)/.test(status.partiStatus)) return false;
    const forced = calcForcedOutDeposit(status.breakdown);
    return !!forced && forced.reasons.some((r) => r.code === "penalty_2_or_more");
  }
  const candidates = await listExitCandidates(env, accessToken, fileId);
  return candidates.length > 0;
}

// 🔧 [사용자 지시] "벌금 납부 처리에서 사이클 오인 방지" — 관리자가
// 사이클 토글을 지난 주로 전환하는 걸 깜빡하면 이미 리셋된 이번 주
// 원본만 보고 "미납자 없음"으로 오인해 실제 미납자를 방치할 수 있다
// (§CACHING_POLICY.md 참고 예정). 서버가 자동으로 사이클을 판단해줄
// 근거(exitDate 같은 날짜 필드)가 벌금 상태 셀엔 없어, 대신 토글
// 자체에 "이 사이클에 미납 기록이 있다"는 신호를 얹어 관리자가
// 전환해보지 않아도 알아채게 한다. 이 계산은 `includeUnpaid` 쿼리
// 파라미터로 명시적으로 요청한 화면(관리자 화면, 본인 대시보드)에서만
// 수행하고 응답에 포함한다 — 전체 랭킹(RosterPage)처럼 원래 "누가/
// 얼마나 미납인지" 같은 개인 식별 정보를 다루지 않는 화면은 이
// 파라미터를 보내지 않아, 서버가 계산 자체를 생략하고 필드도 응답에
// 넣지 않는다(값을 false로 채우는 게 아니라 필드 자체가 없음 — 그
// 화면의 세션으로 개발자도구를 열어봐도 신호가 없다).
export async function handleCycleList(req, env, origin, url) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const { backups, currentCycle } = await listCurrentCycleBackups(env, accessToken);
    const memberParam = url ? url.searchParams.get("member") : null;
    const includeUnpaid = url ? url.searchParams.get("includeUnpaid") : null;
    const includeForced = url ? url.searchParams.get("includeForced") : null;

    let targetMemberNumber = null;
    if (memberParam === "self") {
      const member = await findMemberNumberByEmail(env, accessToken, env.GOOGLE_SHEET_FILE_ID, session.email);
      targetMemberNumber = member ? member.number : null;
    } else if (memberParam) {
      targetMemberNumber = memberParam;
    }

    const weeks = await Promise.all(
      backups.map(async (b) => {
        let hasData = true;
        if (targetMemberNumber) {
          const members = await listAllMembers(env, accessToken, b.fileId);
          hasData = members.some((m) => m.number === targetMemberNumber);
        }
        const week = { fileId: b.fileId, weekOf: b.weekOf, weekTo: b.weekTo, hasData };
        if (includeUnpaid) {
          week.hasUnpaid = await hasUnpaidFineInCycle(env, accessToken, b.fileId, targetMemberNumber);
        }
        if (includeForced) {
          week.hasForced = await hasForcedCandidateInCycle(env, accessToken, b.fileId, targetMemberNumber);
        }
        return week;
      })
    );

    const result = {
      weeks,
      // 🔧 프론트가 "아직 백업이 없는 과거 주차"도 비활성화 슬롯으로
      // 채워 보여줄 수 있도록, 사이클 최대 길이를 함께 내려준다(하드코딩
      // 값이 바뀌어도 프론트가 자동으로 따라가게).
      maxWeeks: CYCLE_MAX_LEN,
      // 🔧 [버그 수정, 2026-09] 프론트(CycleSwitcher)가 "이번 주가 사이클
      // 몇 번째 주인지"를 weeks.length로 역산하던 방식은, 항상 3칸을
      // 채운다는 잘못된 가정과 맞물려 1~2주차인데도 "3주차"로 잘못
      // 표시되는 문제가 있었다 — 서버가 실제 현재 사이클 값을 직접
      // 내려줘 프론트가 더는 역산하지 않게 한다.
      currentWeekNumber: currentCycle,
    };
    if (includeUnpaid) {
      result.currentHasUnpaid = await hasUnpaidFineInCycle(
        env,
        accessToken,
        env.GOOGLE_SHEET_FILE_ID,
        targetMemberNumber
      );
    }
    if (includeForced) {
      result.currentHasForced = await hasForcedCandidateInCycle(
        env,
        accessToken,
        env.GOOGLE_SHEET_FILE_ID,
        targetMemberNumber
      );
    }

    return json(result, 200, origin);
  } catch (err) {
    return json({ error: "사이클 목록 조회 실패: " + err.message }, 500, origin);
  }
}
