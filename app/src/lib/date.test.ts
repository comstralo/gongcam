// 🔧 [2026-09-22 사용자 지시: "프론트엔드 테스트 도구도 정비해"] —
// 백엔드(frame-checker-worker/src/date-utils.js)와 정확히 같은 종류의
// KST 타임존 계산이 프론트엔드에도 독립적으로 존재한다 — 이 파일 상단
// 주석대로 세 곳의 중복(NewMemberForm/ReportReviewList/
// MyOutputPenSection)을 통합한 결과물이라 회귀 파급 범위가 넓다.
// 백엔드는 UTC+9 수동 계산 트릭을 쓰지만 이쪽은 Intl.toLocaleDateString
// 으로 완전히 다른 구현이라, 백엔드 테스트가 이 파일의 정확성까지
// 보장해주지 않는다 — 독립적으로 검증이 필요하다.
import { describe, expect, it, vi } from "vitest";
import { toKSTDateString, todayKSTDateString } from "./date";

describe("toKSTDateString", () => {
  it("KST와 UTC가 같은 날짜인 시각은 그대로 반환한다", () => {
    // 2026-09-09 10:00 UTC == 2026-09-09 19:00 KST — 같은 날짜.
    expect(toKSTDateString(Date.UTC(2026, 8, 9, 10, 0, 0))).toBe("2026-09-09");
  });

  it("UTC로는 전날이지만 KST로는 이미 다음날인 경계를 정확히 반영한다", () => {
    // 2026-09-09 20:00 UTC == 2026-09-10 05:00 KST.
    expect(toKSTDateString(Date.UTC(2026, 8, 9, 20, 0, 0))).toBe("2026-09-10");
  });

  it("KST 자정 직전(UTC 14:59)에는 아직 그날 날짜다", () => {
    // 2026-09-09 14:59 UTC == 2026-09-09 23:59 KST.
    expect(toKSTDateString(Date.UTC(2026, 8, 9, 14, 59, 0))).toBe("2026-09-09");
  });

  it("KST 자정 정각(UTC 15:00)에는 다음날 날짜로 넘어간다", () => {
    expect(toKSTDateString(Date.UTC(2026, 8, 9, 15, 0, 0))).toBe("2026-09-10");
  });

  it("숫자(epoch ms)와 Date 객체 둘 다 동일하게 처리한다", () => {
    const ms = Date.UTC(2026, 8, 9, 10, 0, 0);
    expect(toKSTDateString(ms)).toBe(toKSTDateString(new Date(ms)));
  });

  it("월/일 한 자리 값도 0으로 패딩된 YYYY-MM-DD를 반환한다", () => {
    expect(toKSTDateString(Date.UTC(2026, 0, 5, 10, 0, 0))).toBe("2026-01-05");
  });
});

describe("todayKSTDateString", () => {
  it("현재 시각을 KST로 변환한 날짜 문자열을 반환한다", () => {
    vi.useFakeTimers();
    // 2026-09-09 20:00 UTC == 2026-09-10 05:00 KST.
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 9, 20, 0, 0)));
    expect(todayKSTDateString()).toBe("2026-09-10");
    vi.useRealTimers();
  });
});
