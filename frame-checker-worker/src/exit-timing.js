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

// 🔧 [일간 집계 완료 시점 반영] daily_calc()(앱스크립트)는 "그날 다음날
// 자정~오전 1시 사이"에 실행돼야 그날치 벌금 미납/페널티 판정이 최종
// 반영된다 — exitDate 당일이 KST로 지났다고 바로 동의를 허용하면, 아직
// 그날 집계가 안 끝난 값에 회원이 동의해버릴 수 있다(사용자 지적). exitDate
// 다음날 오전 2시(집계 시각보다 여유를 둔 시각) KST 이후부터 허용한다.
export function exitDateSettled(exitDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(exitDate || "");
  if (!m) return false;
  const exitDateMidnightUtcMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 9 * 60 * 60 * 1000;
  const settledAtUtcMs = exitDateMidnightUtcMs + 26 * 60 * 60 * 1000;
  return Date.now() >= settledAtUtcMs;
}
