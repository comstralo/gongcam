// 🔧 [구조 개선, 2026-09-13] 완전 순수한 사이클 판정 함수를 index.js에서
// 분리했다(docs/TESTING.md 참고) — fetch/DO/캐시/시계에 전혀 의존하지
// 않는다. requiresFineUnpaidRecheck는 FINE_UNPAID_ADMIN_FORCED_REASON을
// 참조하는데, 이 상수는 index.js의 다른 곳(FINE_UNPAID_ADMIN_FORCED_REASON_LABEL)
// 에서도 쓰이므로 index.js에 남겨두고 여기서 import한다 — index.js는
// 재export 목적으로만 이 파일을 import하고 최상위에서 값을 즉시 평가하지
// 않으므로(전부 요청 처리 시점에 지연 호출됨) 순환 import가 생겨도 TDZ
// 문제가 없다.
import { FINE_UNPAID_ADMIN_FORCED_REASON } from "./index.js";

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
