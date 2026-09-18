// 🔧 [구조 개선, 2026-09-13] "Date.now() 기반 KST 시각 경계 판정"이라는
// 동일한 성격을 가진 짧은 순수 시계 함수 2개를 index.js에서 분리했다
// (docs/TESTING.md 참고) — 도메인은 다르지만(상금 공개 vs 퇴실 동의) 각각
// 별도 파일을 만들 만큼 크지 않아 한 파일로 묶었다.

// KST(UTC+9) 기준 "이번 주 정산" 공개 시각 — 일요일 14교시 종료(23:30)
// 이후부터 스터디원도 볼 수 있다. 스터디장(1번 회원)은 항상 볼 수 있다.
export function isSettlementVisibleToMembers() {
  const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const day = kstNow.getUTCDay(); // KST로 보정된 시각의 UTC getter를 그대로 쓴다.
  const hour = kstNow.getUTCHours();
  const minute = kstNow.getUTCMinutes();
  if (day !== 0) return false; // 0 = 일요일
  return hour > 23 || (hour === 23 && minute >= 30);
}

// 🔧 [정산 퇴실 절차 명확화, 사용자 지시] "퇴실 신청 → 마지막 참여일
// 익일에 정산 내역과 동의 버튼 출력. 단, 미납 벌금이 있거나 상금 정산이
// 처리되지 않았으면 내역과 동의 버튼을 보여주지 않음 → 동의를 누르면
// 관리자가 확인 후 확정 처리" — 이전엔 "exitDate 다음날 오전 2시"라는
// 모호한 시간 기준이었으나, "익일(자정)"로 단순화하고 벌금 미납/상금
// 미정산 여부는 handleAgreeExitRequest(exit-request.js)가 별도로 검증한다.
export function exitDateSettled(exitDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(exitDate || "");
  if (!m) return false;
  const exitDateMidnightUtcMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 9 * 60 * 60 * 1000;
  const nextDayMidnightUtcMs = exitDateMidnightUtcMs + 24 * 60 * 60 * 1000;
  return Date.now() >= nextDayMidnightUtcMs;
}
