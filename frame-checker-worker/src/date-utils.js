// 🔧 [구조 개선, 2026-09-13] 순수 날짜/시간 유틸을 index.js에서 분리했다
// (docs/TESTING.md 참고) — 전부 인자만으로 계산하고 fetch/DO/캐시를
// 전혀 건드리지 않는다. dayDateAt/parseWeekOfToMonday/currentWeekRangeYYMMDD
// 처럼 이 함수들을 사용하지만 그 자체가 도메인 로직에 더 가까운 함수는
// index.js에 남기고 여기서 import한다.

// Date 객체를 "YYYY-MM-DD"로 포맷한다. toISOString()은 UTC로 변환하며 자정을
// 넘나들 위험이 있어(이 값들은 이미 정오 무렵으로 만들어지므로 실제로는 안전
// 하지만), 명시적으로 로컬 필드에서 직접 조립해 시간대 변환에 의존하지 않는다.
export function formatISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// KST(UTC+9) 기준 "지금"을 나타내는 Date. Cloudflare Workers는 로컬 타임존이
// 항상 UTC라서, UTC Date에 9시간을 더해두고 이후 반드시 UTC getter(getUTCDate,
// getUTCDay 등)로만 읽으면 KST 기준 값이 정확히 나온다 — 로컬 getter를 쓰면
// (Workers 로컬=UTC이므로) 다시 UTC로 되돌아가버리니 주의.
export function nowKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

// KST 기준 "오늘"의 "YYYY-MM-DD" 문자열. formatISODate는 로컬 getter를
// 쓰므로, nowKST()가 만든 "UTC 시각이지만 KST 날짜를 담고 있는" Date를
// 그대로 넘기면 정확한 KST 날짜 문자열이 나온다(Workers 로컬=UTC).
export function todayKSTDateString() {
  return formatISODate(nowKST());
}

// UTC 기준 "오늘"의 "YYYY-MM-DD" 문자열(Workers 로컬=UTC이므로 그냥
// formatISODate(new Date())). 🔧 [사용자 지시] "UTC 기준으로 해줘야지.
// 결국 한도에 따른 사용치를 보고 싶은건데" — 사용량 모니터링의 "일일"
// 집계(_dailyUsageBuffer/UsageStats DO)가 KST 자정 기준이면, 같은 화면
// 위쪽의 Cloudflare 실측 게이지(fetchCloudflareUsage, 실제 한도가
// 리셋되는 UTC 자정 기준)와 하루 경계가 9시간 어긋나 합계가 안 맞아
// 보였다 — 둘 다 "한도 대비 사용량"이 목적이므로 같은 기준으로 통일한다.
export function todayUTCDateString() {
  return formatISODate(new Date());
}

// KST 기준 "오늘 + N일"(N이 음수면 과거) 날짜의 "YYYY-MM-DD" 문자열. 신규
// 회원 등록 시 "첫 참여일"을 오늘부터 앞으로 일주일 이내로만 허용하는 범위
// 검증에 쓴다(handleAdminCreateMember) — 날짜 문자열끼리는 사전식 비교가 곧
// 날짜 비교와 같아, 별도 파싱 없이 `날짜문자열 <= kstDateOffsetString(6)`로
// 바로 비교할 수 있다.
export function kstDateOffsetString(days) {
  const d = nowKST();
  d.setUTCDate(d.getUTCDate() + days);
  return formatISODate(d);
}

// KST(UTC+9) 기준 "이번 주 월요일" 자정을 계산한다. 다른 KST 계산(예:
// isSettlementVisibleToMembers)과 동일하게, UTC Date에 9시간을 더해두고
// UTC getter로 읽는 트릭을 쓴다 — Cloudflare Workers는 로컬 타임존이 항상
// UTC라서, 이렇게 만든 Date를 이후 formatISODate(로컬 getter)로 그대로
// 포맷해도 KST 기준 날짜가 정확히 나온다.
export function currentWeekMondayKST() {
  const kstNow = nowKST();
  const jsDay = kstNow.getUTCDay(); // 일=0 ... 토=6
  const mondayOffset = (jsDay + 6) % 7; // 오늘이 월요일로부터 며칠째인지(월=0)
  const monday = new Date(kstNow.getTime());
  monday.setUTCDate(monday.getUTCDate() - mondayOffset);
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

// UTC Date를 "YYMMDD"로 포맷한다(백업 파일명 weekOf와 동일한 규칙) — UTC
// getter를 쓰므로, currentWeekMondayKST()/parseWeekOfToMonday()가 만든
// "UTC 자정이지만 KST 날짜를 담은" Date를 그대로 넘기면 KST 기준 날짜가 나온다.
export function formatYYMMDD(date) {
  const yy = String(date.getUTCFullYear()).slice(-2);
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

// KST(Asia/Seoul) 기준 "YYYY-MM-DD" 날짜 문자열 — "당일" 판정에 쓴다.
export function kstDateKey(ts) {
  return new Date(ts).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }); // sv-SE 로케일이 YYYY-MM-DD를 그대로 출력.
}

// exitDate("YYYY-MM-DD")의 KST 자정을 UTC ms로 계산 — exitDateSettled와
// 동일한 변환(KST는 UTC+9이므로 "그 날짜 00:00 KST" = "그 날짜 00:00 UTC - 9시간").
export function exitDateMidnightUtcMs(exitDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(exitDate || "");
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 9 * 60 * 60 * 1000;
}

// exitDate가 속한 주(월~일)의 월요일을 "YYMMDD"로 반환 — appscript.js의
// get_last_week_date_range()가 만드는 백업 파일명 접두부와 동일한 포맷.
// sheet_reset()이 매주 월요일 새벽에 "그 주(월~일) 백업"을 만들 때 쓰는
// 이름 규칙을 그대로 역산해, exitDate가 어느 백업 파일에 담겨야 하는지 찾는다.
export function weekOfForDate(exitDate) {
  const midnightMs = exitDateMidnightUtcMs(exitDate);
  if (midnightMs === null) return null;
  // exitDate(KST 자정)를 "UTC 시각이지만 KST 날짜를 담고 있는" Date로 다시
  // 만들어 nowKST()와 동일한 트릭으로 요일(getUTCDay)을 읽는다.
  const kstDate = new Date(midnightMs + 9 * 60 * 60 * 1000);
  const jsDay = kstDate.getUTCDay(); // 일=0 ... 토=6
  const mondayOffset = (jsDay + 6) % 7; // 이 날짜가 월요일로부터 며칠째인지(월=0)
  const monday = new Date(midnightMs - mondayOffset * 24 * 60 * 60 * 1000);
  const mondayKst = new Date(monday.getTime() + 9 * 60 * 60 * 1000);
  const yy = String(mondayKst.getUTCFullYear()).slice(-2);
  const mm = String(mondayKst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(mondayKst.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

// 🔧 [sheet_reset 이후 원본 오염 문제] exitDate가 속한 주의 sheet_reset
// (그 다음 월요일 오전 5~6시 KST)이 이미 지났으면, 원본 시트는 더 이상
// exitDate 시점의 정확한 값을 담고 있지 않다(페널티 사이클 순환, 재납
// 상태 초기화 등) — 이 경우 원본이 아니라 그 주의 자동 백업 파일을 봐야
// 한다(사용자 지시). "오늘이 며칠인지"가 아니라 반드시 "exitDate가 속한
// 주의 리셋 시점"을 기준으로 계산해야 한다 — 그렇지 않으면 exitDate가
// 월요일인 경우 "오늘도 월요일이니 리셋이 지났다"고 착각해, 실제로는
// exitDate가 담긴 백업이 아직 없는데(그 백업은 다음 주 월요일에야 생김)
// 엉뚱한 전전주 백업을 참조하게 된다(사용자 지적).
export function exitWeekResetPassed(exitDate) {
  const midnightMs = exitDateMidnightUtcMs(exitDate);
  if (midnightMs === null) return false;
  const kstDate = new Date(midnightMs + 9 * 60 * 60 * 1000);
  const jsDay = kstDate.getUTCDay();
  const mondayOffset = (jsDay + 6) % 7; // 이 날짜가 월요일로부터 며칠째인지(월=0)
  const mondayMidnightUtcMs = midnightMs - mondayOffset * 24 * 60 * 60 * 1000;
  // 그 주 월요일 자정(KST) + 7일 + 6시간 = 다음 주 월요일 06:00 KST.
  // sheet_reset은 5~6시 사이 실행되므로 여유를 두고 6시를 기준으로 삼는다.
  const resetAtUtcMs = mondayMidnightUtcMs + 7 * 24 * 60 * 60 * 1000 + 6 * 60 * 60 * 1000;
  return Date.now() >= resetAtUtcMs;
}
