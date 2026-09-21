// 🔧 [2026-09-22 사용자 지시: "프론트엔드 테스트 도구도 정비해"] —
// getPeriodPhase는 세 가지 상태(in-period/break/outside)를 시각 하나로
// 분기하는 로직이라 오프바이원(<= vs <, 경계 시각 자체)이 나기 쉽다.
// 백엔드의 exit-timing.js/date-utils.js가 KST 경계를 다루는 것과 같은
// 성격의 "시각 경계 판정" 코드인데, 이쪽은 지금까지 화면에서 눈으로
// 봐가며 검증한 것 말고는 자동 테스트가 전혀 없었다.
import { describe, expect, it } from "vitest";
import { formatRemaining, getPeriodPhase, PERIODS } from "./periods";

// 모든 테스트가 "오늘 00:00 = 0"이라는 동일 기준을 쓰도록 자정을 0으로 고정한다.
const MIDNIGHT_MS = 0;
const MIN = 60_000;

describe("PERIODS", () => {
  it("14교시를 정확한 순서/분 단위로 담고 있다", () => {
    expect(PERIODS).toHaveLength(14);
    expect(PERIODS[0]).toEqual({ index: 1, startMinutes: 7 * 60 + 20, endMinutes: 8 * 60 + 20 });
    expect(PERIODS[13]).toEqual({ index: 14, startMinutes: 22 * 60 + 30, endMinutes: 23 * 60 + 30 });
  });
});

describe("getPeriodPhase", () => {
  it("1교시 시작 직전(운영시간 외, 자정~1교시 1시간 전)에는 outside를 반환한다", () => {
    // 1교시 시작 440분(07:20) - 61분 = 06:19, 아직 "1시간 전" 범위 밖.
    const now = MIDNIGHT_MS + (7 * 60 + 20 - 61) * MIN;
    const phase = getPeriodPhase(MIDNIGHT_MS, now);
    expect(phase.kind).toBe("outside");
  });

  it("1교시 시작 정확히 1시간 전에는 break(다음 교시=1교시)를 반환한다", () => {
    // 🔧 55행 조건: nowMinutes >= PERIODS[0].startMinutes - 60. 60분 전
    // 경계에서 >= 이므로 포함(break)이어야 한다 — 오프바이원 회귀 방지.
    const startMinutes = 7 * 60 + 20;
    const now = MIDNIGHT_MS + (startMinutes - 60) * MIN;
    const phase = getPeriodPhase(MIDNIGHT_MS, now);
    expect(phase.kind).toBe("break");
    if (phase.kind === "break") expect(phase.next.index).toBe(1);
  });

  it("1교시 시작 정각에는 in-period(1교시)를 반환한다", () => {
    const now = MIDNIGHT_MS + (7 * 60 + 20) * MIN;
    const phase = getPeriodPhase(MIDNIGHT_MS, now);
    expect(phase.kind).toBe("in-period");
    if (phase.kind === "in-period") expect(phase.period.index).toBe(1);
  });

  it("1교시 종료 정각(=2교시 쉬는시간 시작)에는 break를 반환한다(endMinutes는 배타적 상한)", () => {
    // 1교시 endMinutes=500(08:20). 46행 조건이 `< endMinutes`이므로
        // 500분 정각은 이미 1교시 밖 — 다음 교시(2교시)까지의 break여야 한다.
    const now = MIDNIGHT_MS + (8 * 60 + 20) * MIN;
    const phase = getPeriodPhase(MIDNIGHT_MS, now);
    expect(phase.kind).toBe("break");
    if (phase.kind === "break") expect(phase.next.index).toBe(2);
  });

  it("교시 도중(예: 1교시 07:50)에는 in-period와 정확한 remainingMs를 반환한다", () => {
    const now = MIDNIGHT_MS + (7 * 60 + 50) * MIN;
    const phase = getPeriodPhase(MIDNIGHT_MS, now);
    expect(phase.kind).toBe("in-period");
    if (phase.kind === "in-period") {
      expect(phase.period.index).toBe(1);
      // 1교시 종료(08:20)까지 30분 남음.
      expect(phase.remainingMs).toBe(30 * MIN);
    }
  });

  it("마지막 교시(14교시) 종료 직전까지는 in-period다", () => {
    const now = MIDNIGHT_MS + (23 * 60 + 29) * MIN; // 23:29, 종료 1분 전
    const phase = getPeriodPhase(MIDNIGHT_MS, now);
    expect(phase.kind).toBe("in-period");
    if (phase.kind === "in-period") expect(phase.period.index).toBe(14);
  });

  it("마지막 교시(14교시) 종료 정각 이후에는 outside를 반환하고, 다음날 1교시까지 남은 시간을 계산한다", () => {
    const now = MIDNIGHT_MS + (23 * 60 + 30) * MIN; // 23:30 정각, 14교시 종료
    const phase = getPeriodPhase(MIDNIGHT_MS, now);
    expect(phase.kind).toBe("outside");
    if (phase.kind === "outside") {
      // 다음날 1교시(07:20) 시작까지: (24*60 - 23*60 - 30 + 7*60 + 20)분.
      const expectedMinutes = 24 * 60 - (23 * 60 + 30) + (7 * 60 + 20);
      expect(phase.remainingMs).toBe(expectedMinutes * MIN);
    }
  });

  it("자정 직후(00:00)에는 outside이고, 같은 날 1교시 시작까지 남은 시간을 계산한다", () => {
    const now = MIDNIGHT_MS; // 00:00
    const phase = getPeriodPhase(MIDNIGHT_MS, now);
    expect(phase.kind).toBe("outside");
    if (phase.kind === "outside") {
      expect(phase.remainingMs).toBe((7 * 60 + 20) * MIN);
    }
  });
});

describe("formatRemaining", () => {
  it("1시간 미만이면 MM:SS 형식이다(분 2자리 패딩)", () => {
    expect(formatRemaining(9 * 60 * 1000 + 5 * 1000)).toBe("09:05");
  });

  it("1시간 이상이면 H:MM:SS 형식이다", () => {
    expect(formatRemaining(5 * 3600 * 1000 + 50 * 60 * 1000 + 11 * 1000)).toBe("5:50:11");
  });

  it("음수 ms는 0으로 취급한다(카운트다운이 만료를 살짝 넘긴 순간 음수를 방지)", () => {
    expect(formatRemaining(-1000)).toBe("00:00");
  });

  it("정확히 0ms는 00:00이다", () => {
    expect(formatRemaining(0)).toBe("00:00");
  });
});
