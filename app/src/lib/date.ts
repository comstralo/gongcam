// 🔧 [중복 제거, 2026-09-21] "KST 기준 YYYY-MM-DD 얻기"가 목적이 같은
// 서로 다른 로케일 트릭(en-CA/sv-SE)으로 최소 3곳에 흩어져 있었다
// (NewMemberForm.tsx의 todayKSTStr, ReportReviewList.tsx와
// MyOutputPenSection.tsx의 kstDateKey — 뒤 두 개는 주석까지 거의
// 동일한 완전 중복이었다). 브라우저 로컬 타임존이 임의값일 수 있어
// timeZone을 명시해야 한다는 점, 그리고 백엔드의 todayKSTStr()과 같은
// 형식을 내야 한다는 이유는 세 곳 모두 동일했으므로 여기로 합친다.
//
// 라이브러리(date-fns/dayjs) 도입은 검토했으나, 이 프로젝트가 다루는
// 타임존이 KST 하나뿐이고 필요한 연산도 "YYYY-MM-DD 문자열 얻기"뿐이라
// 네이티브 Intl API로 충분하다고 판단했다(전수조사 결론).

// 임의 시각(ms epoch 또는 Date)을 KST 기준 "YYYY-MM-DD"로 변환한다.
// sv-SE 로케일이 이 형식을 그대로 출력해준다(en-CA도 동일 형식을 내지만
// 표기가 하나로 통일되어 있는 편이 이후 grep하기 쉽다).
export function toKSTDateString(tsOrDate: number | Date): string {
  const date = typeof tsOrDate === "number" ? new Date(tsOrDate) : tsOrDate;
  return date.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
}

// KST 기준 "오늘"의 "YYYY-MM-DD".
export function todayKSTDateString(): string {
  return toKSTDateString(new Date());
}
