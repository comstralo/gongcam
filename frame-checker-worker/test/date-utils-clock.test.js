// 🔧 [테스트 정비 23차, 2026-09-22 사용자 지시: "프론트엔드, 백엔드 테스트
// 도구 정비는 끝난거야?" 후속 전수조사] — date-utils.js의 11개 함수 중
// index.js가 재export하는 6개(currentWeekMondayKST/formatYYMMDD/kstDateKey/
// exitDateMidnightUtcMs/weekOfForDate/exitWeekResetPassed)는 이미
// cycle-clock.test.js/cycle-pure.test.js가 검증한다(docs/TESTING.md
// "구조 개선 1차" 참고). 나머지 5개(formatISODate/nowKST/todayKSTDateString/
// todayUTCDateString/kstDateOffsetString)는 "테스트가 직접 import하지
// 않는다"는 이유로 애초에 재export 대상에서 빠졌을 뿐 — 의도적으로
// 방치된 게 아니라 단순히 진입점이 없었다(index.js에서 nowKST/
// formatISODate/todayUTCDateString/kstDateOffsetString은 grep해도
// export되지 않음). Workers 런타임의 로컬 타임존이 항상 UTC라는 전제
// (파일 상단 주석)가 실제로 이 vitest 환경(@cloudflare/vitest-plugin,
// 진짜 workerd)에서도 성립하는지 자체도 이 테스트로 함께 확인한다.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatISODate,
  nowKST,
  todayKSTDateString,
  todayUTCDateString,
  kstDateOffsetString,
} from "../src/date-utils.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("formatISODate", () => {
  it("로컬 getter로 YYYY-MM-DD를 조립한다(Workers 로컬=UTC 전제 실증)", () => {
    // 2026-09-09 05:30:00 UTC. Workers 로컬 타임존이 실제로 UTC라면
    // getFullYear/getMonth/getDate가 그대로 9/9/2026이어야 한다 —
    // 만약 이 전제가 이 workerd 버전에서 깨졌다면 이 값이 어긋나며
        // 파일 상단 주석의 근거 자체가 무효화됐음을 알 수 있다.
    const d = new Date(Date.UTC(2026, 8, 9, 5, 30, 0));
    expect(formatISODate(d)).toBe("2026-09-09");
  });

  it("월/일 한 자리는 0으로 패딩한다(2026-01-05 등 오프바이원 방지)", () => {
    const d = new Date(Date.UTC(2026, 0, 5, 0, 0, 0));
    expect(formatISODate(d)).toBe("2026-01-05");
  });

  it("자정 근처 UTC 시각도 자정을 넘나들지 않고 그대로 날짜를 포맷한다", () => {
    // 파일 상단 주석이 우려하는 "toISOString() UTC 변환 자정 넘나듦"을
    // formatISODate 자신은 겪지 않아야 한다 — 로컬(=UTC) getter만 쓰므로.
    const d = new Date(Date.UTC(2026, 8, 9, 23, 59, 59));
    expect(formatISODate(d)).toBe("2026-09-09");
  });
});

describe("nowKST", () => {
  it("UTC 시각에 9시간을 더한 Date를 반환한다", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 9, 0, 0, 0)); // 2026-09-09 00:00 UTC
    const result = nowKST();
    // KST = UTC+9이므로 UTC getter로 읽으면 09:00이어야 한다.
    expect(result.getUTCFullYear()).toBe(2026);
    expect(result.getUTCMonth()).toBe(8);
    expect(result.getUTCDate()).toBe(9);
    expect(result.getUTCHours()).toBe(9);
  });

  it("KST로 보정하면 날짜가 다음날로 넘어가는 경계(UTC 15:00 이후)를 정확히 반영한다", () => {
    vi.useFakeTimers();
    // 2026-09-09 15:00 UTC == 2026-09-10 00:00 KST(자정 정각).
    vi.setSystemTime(Date.UTC(2026, 8, 9, 15, 0, 0));
    const result = nowKST();
    expect(result.getUTCDate()).toBe(10);
    expect(result.getUTCHours()).toBe(0);
  });
});

describe("todayKSTDateString", () => {
  it("KST 기준 날짜 문자열을 반환한다(UTC로는 아직 전날인 시각 포함)", () => {
    vi.useFakeTimers();
    // 2026-09-09 20:00 UTC == 2026-09-10 05:00 KST — UTC 기준으로는
    // 여전히 9일이지만 KST로는 이미 10일이다. 이 시차가 정확히
    // 반영되는지가 이 함수의 존재 이유(todayUTCDateString과의 대조).
    vi.setSystemTime(Date.UTC(2026, 8, 9, 20, 0, 0));
    expect(todayKSTDateString()).toBe("2026-09-10");
  });

  it("KST 자정 직전(UTC 14:59)에는 아직 그날 날짜를 반환한다", () => {
    vi.useFakeTimers();
    // 2026-09-09 14:59 UTC == 2026-09-09 23:59 KST.
    vi.setSystemTime(Date.UTC(2026, 8, 9, 14, 59, 0));
    expect(todayKSTDateString()).toBe("2026-09-09");
  });
});

describe("todayUTCDateString", () => {
  it("UTC 기준 날짜 문자열을 반환한다(KST와 9시간 시차로 하루 다를 수 있음)", () => {
    vi.useFakeTimers();
    // todayKSTDateString 첫 케이스와 동일 시각 — KST로는 10일이지만
    // UTC로는 여전히 9일이어야 한다. 이 대조가 이 두 함수를 분리한
    // 이유(파일 상단 주석: Cloudflare 실측 게이지 UTC 자정 리셋 대응) 그 자체다.
    vi.setSystemTime(Date.UTC(2026, 8, 9, 20, 0, 0));
    expect(todayUTCDateString()).toBe("2026-09-09");
  });
});

describe("kstDateOffsetString", () => {
  it("days=0이면 오늘(KST) 날짜를 그대로 반환한다", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 9, 1, 0, 0)); // 2026-09-09 10:00 KST
    expect(kstDateOffsetString(0)).toBe("2026-09-09");
  });

  it("양수 days는 미래 날짜를 반환한다(신규 회원 첫 참여일 범위 검증에 쓰임)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 9, 1, 0, 0)); // 2026-09-09 10:00 KST
    expect(kstDateOffsetString(6)).toBe("2026-09-15");
  });

  it("음수 days는 과거 날짜를 반환한다", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 9, 1, 0, 0)); // 2026-09-09 10:00 KST
    expect(kstDateOffsetString(-9)).toBe("2026-08-31");
  });

  it("월 경계를 넘는 offset도 정확히 계산한다(2026-09-01 → -1일 = 2026-08-31)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 31, 15, 0, 0)); // 2026-09-01 00:00 KST
    expect(kstDateOffsetString(-1)).toBe("2026-08-31");
  });
});
