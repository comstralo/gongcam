// 예치금 반환 계산 중 시계(Date.now())에 의존하는 함수 테스트.
// isLateNotice는 todayKSTDateString()을 직접 호출하고, depositRefundBreakdown은
// 이를 내부에서 호출해 간접적으로 시계에 의존한다.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COL_ACCESSION_DDAY,
  COL_DEPOSIT_AGAIN,
  COL_PARTI_STATUS,
  ROW_ACCESSION_DDAY,
  ROW_DEPOSIT_AGAIN,
  ROW_FINE_NO_STATUS,
  ROW_PARTI_STATUS,
  ROW_PAYMENT_CHECK,
  STATUS_DAY_COLS,
} from "../src/index.js";
import { calcSettleReturnDeposit, depositRefundBreakdown, isLateNotice } from "../src/deposit.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("isLateNotice", () => {
  it("exitRequestDate가 없으면(falsy) false", () => {
    expect(isLateNotice(null)).toBe(false);
    expect(isLateNotice("")).toBe(false);
  });

  it("파싱 불가능한 문자열이면 false", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 9, 1, 0, 0)); // 2026-09-09 10:00 KST
    expect(isLateNotice("invalid-date")).toBe(false);
  });

  it("exitRequestDate가 오늘 기준 3일 이상 남았으면 false", () => {
    vi.useFakeTimers();
    // "오늘"(KST) = 2026-09-09
    vi.setSystemTime(Date.UTC(2026, 8, 9, 1, 0, 0));
    expect(isLateNotice("2026-09-12")).toBe(false); // 3일 후
  });

  it("exitRequestDate가 오늘 기준 2일 이하 남았으면 true(경계값)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 9, 1, 0, 0)); // "오늘" = 2026-09-09
    expect(isLateNotice("2026-09-11")).toBe(true); // 2일 후
  });

  it("exitRequestDate가 이미 지난 날짜(음수 daysUntilLastAttend)여도 true 유지된다", () => {
    // "마지막 참여일 다음날에도 50%가 계속 적용돼야 한다"는 요구사항 재현.
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 9, 1, 0, 0)); // "오늘" = 2026-09-09
    expect(isLateNotice("2026-09-01")).toBe(true);
  });
});

describe("depositRefundBreakdown", () => {
  // rows 배열을 필요한 셀만 채워 만드는 헬퍼. partiStatus가 있어야
  // "참여상태 미확인" 분기를 피해 penTotal 분기까지 도달한다.
  function makeRows({ partiStatus = "재학생", daysSinceJoin = 100, depositAgain = "", fineNoStatus = 0, fineUnpaidDayCols = [] } = {}) {
    const rows = [];
    rows[ROW_PARTI_STATUS] = [];
    rows[ROW_PARTI_STATUS][COL_PARTI_STATUS] = partiStatus;
    rows[ROW_ACCESSION_DDAY] = rows[ROW_ACCESSION_DDAY] || [];
    rows[ROW_ACCESSION_DDAY][COL_ACCESSION_DDAY] = `D+${daysSinceJoin}`;
    rows[ROW_DEPOSIT_AGAIN] = rows[ROW_DEPOSIT_AGAIN] || [];
    rows[ROW_DEPOSIT_AGAIN][COL_DEPOSIT_AGAIN] = depositAgain;
    rows[ROW_FINE_NO_STATUS] = [];
    rows[ROW_FINE_NO_STATUS][2] = fineNoStatus;
    rows[ROW_PAYMENT_CHECK] = [];
    for (const col of fineUnpaidDayCols) rows[ROW_PAYMENT_CHECK][col] = "미납";
    return rows;
  }

  it("partiStatus 없으면 reason '참여상태 미확인', amount 0", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 9, 1, 0, 0));
    const rows = makeRows({ partiStatus: "" });
    const result = depositRefundBreakdown(rows, { outputPen: 0, timePen: 0, total: 0 }, null);
    expect(result.reason).toBe("참여상태 미확인");
    expect(result.amount).toBe(0);
  });

  it("daysSinceJoin < 30이면 reason '가입 30일 미만', amount 0", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 9, 1, 0, 0));
    const rows = makeRows({ daysSinceJoin: 10 });
    const result = depositRefundBreakdown(rows, { outputPen: 0, timePen: 0, total: 0 }, null);
    expect(result.reason).toBe("가입 30일 미만");
    expect(result.amount).toBe(0);
  });

  it("fineNoStatus === 1이면 reason '벌금 시한 내 미납', amount 0, fineUnpaidDays에 정확한 요일만 포함", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 9, 1, 0, 0));
    const rows = makeRows({ fineNoStatus: 1, fineUnpaidDayCols: [STATUS_DAY_COLS[0], STATUS_DAY_COLS[2]] });
    const result = depositRefundBreakdown(rows, { outputPen: 0, timePen: 0, total: 0 }, null);
    expect(result.reason).toBe("벌금 시한 내 미납");
    expect(result.amount).toBe(0);
    expect(result.fineUnpaidDays).toEqual(["월", "수"]);
  });

  it("depositAgain === '미납'이면 reason '예치금 재납 시한 미납', amount 0", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 9, 1, 0, 0));
    const rows = makeRows({ depositAgain: "미납" });
    const result = depositRefundBreakdown(rows, { outputPen: 0, timePen: 0, total: 0 }, null);
    expect(result.reason).toBe("예치금 재납 시한 미납");
    expect(result.amount).toBe(0);
  });

  it("depositAgain === '납부'이면 reason '예치금 재납 대상자', amount 0", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 9, 1, 0, 0));
    const rows = makeRows({ depositAgain: "납부" });
    const result = depositRefundBreakdown(rows, { outputPen: 0, timePen: 0, total: 0 }, null);
    expect(result.reason).toBe("예치금 재납 대상자");
    expect(result.amount).toBe(0);
  });

  it("penTotal >= 2이면 amount 0, reason 없음", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 9, 1, 0, 0));
    const rows = makeRows();
    const result = depositRefundBreakdown(rows, { outputPen: 1, timePen: 1, total: 2 }, null);
    expect(result.reason).toBeNull();
    expect(result.amount).toBe(0);
  });

  it("penTotal === 1, lateNotice false -> amount 5000", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 9, 1, 0, 0)); // "오늘" = 2026-09-09
    const rows = makeRows();
    // exitRequestDate를 멀리 잡아 lateNotice=false로 만든다.
    const result = depositRefundBreakdown(rows, { outputPen: 1, timePen: 0, total: 1 }, "2026-09-20");
    expect(result.lateNotice).toBe(false);
    expect(result.amount).toBe(5000);
  });

  it("🔧 버그였던 케이스: penTotal === 1, lateNotice true -> amount 0(100% 차감)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 9, 1, 0, 0)); // "오늘" = 2026-09-09
    const rows = makeRows();
    // exitRequestDate를 가깝게 잡아 lateNotice=true로 만든다(3일 미만).
    const result = depositRefundBreakdown(rows, { outputPen: 1, timePen: 0, total: 1 }, "2026-09-10");
    expect(result.lateNotice).toBe(true);
    expect(result.amount).toBe(0);

    // 교차 검증: calcSettleReturnDeposit도 동일 입력(outputPen/timePen/lateNotice)에
    // 대해 discountRatio 1(0% 반환)을 내야 두 계산이 일관된다 — 이게 실제
    // 버그였던 지점(회원이 미리 보는 예상액과 관리자 확정액이 어긋남)의 회귀 방지.
    const settleResult = calcSettleReturnDeposit(result);
    expect(settleResult.discountRatio).toBe(1);
  });

  it("penTotal === 0, lateNotice false -> amount 10000", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 9, 1, 0, 0));
    const rows = makeRows();
    const result = depositRefundBreakdown(rows, { outputPen: 0, timePen: 0, total: 0 }, "2026-09-20");
    expect(result.lateNotice).toBe(false);
    expect(result.amount).toBe(10000);
  });

  it("penTotal === 0, lateNotice true -> amount 5000", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 9, 1, 0, 0));
    const rows = makeRows();
    const result = depositRefundBreakdown(rows, { outputPen: 0, timePen: 0, total: 0 }, "2026-09-10");
    expect(result.lateNotice).toBe(true);
    expect(result.amount).toBe(5000);
  });
});
