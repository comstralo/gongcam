// 예치금 반환/강제퇴실/정산 판정 중 완전 순수 함수(fetch/DO/캐시/시계 의존
// 전혀 없음) 테스트. calcSettleReturnDeposit은 Date.now()를 직접 쓰지 않고
// depositBreakdown.lateNotice(이미 계산된 값)만 참조하므로 fixture로 직접
// 주입하면 순수 함수로 테스트 가능하다.
import { describe, expect, it } from "vitest";
import {
  calcExitProcess,
  calcForcedOutDeposit,
  countCurrentCyclePen,
  forcedExitChecks,
  totalPenaltyBreakdown,
} from "../src/index.js";
import { calcAdminForcedExit, calcAgainDeposit, calcSettleReturnDeposit } from "../src/deposit.js";

describe("countCurrentCyclePen", () => {
  it.each([
    [{ values: [0, 0, 0, 1, 0, 0], timePenValues: [0, 0] }, 1, { outputPen: 1, timePen: 0, total: 1 }],
    [{ values: [0, 0, 0, 0, 0, 1], timePenValues: [0, 0] }, 1, { outputPen: 1, timePen: 0, total: 1 }],
    [{ values: [0, 0, 0, 1, 0, 1], timePenValues: [0, 0] }, 1, { outputPen: 2, timePen: 0, total: 2 }],
    [{ values: [0, 0, 0, 0, 0, 0], timePenValues: [1, 0] }, 1, { outputPen: 0, timePen: 1, total: 1 }],
    [{ values: [0, 0, 0, 0, 0, 0], timePenValues: [1, 1] }, 1, { outputPen: 0, timePen: 2, total: 2 }],
    [{ values: [0, 0, 0, 0, 0, 0], timePenValues: [0, 0] }, 1, { outputPen: 0, timePen: 0, total: 0 }],
    // 과거 사이클 잔존값(슬롯엔 값이 있지만 currentCycle과 다름)은 카운트되지 않아야 한다
    // — "그 사이클에 발생한 일은 그 사이클에 기록되어야 한다" 원칙의 핵심 검증.
    [{ values: [0, 0, 0, 2, 0, 3], timePenValues: [2, 3] }, 1, { outputPen: 0, timePen: 0, total: 0 }],
  ])("outputPenSlots=%j, currentCycle=%s -> %j", (outputPenSlots, currentCycle, expected) => {
    expect(countCurrentCyclePen(outputPenSlots, currentCycle)).toEqual(expected);
  });
});

describe("forcedExitChecks", () => {
  const base = { daysSinceJoin: 100, fineUnpaid: false, depositAgainStatus: null, outputPen: 0, timePen: 0 };

  it("아무 조건도 해당 없으면 전부 met:false", () => {
    const checks = forcedExitChecks(base);
    expect(checks.every((c) => c.met === false)).toBe(true);
  });

  it("가입 30일 미만이면 under_30_days만 met:true", () => {
    const checks = forcedExitChecks({ ...base, daysSinceJoin: 10 });
    const byCode = Object.fromEntries(checks.map((c) => [c.code, c.met]));
    expect(byCode).toEqual({
      under_30_days: true,
      fine_unpaid: false,
      deposit_again_unpaid: false,
      penalty_2_or_more: false,
    });
  });

  it("벌금 미납이면 fine_unpaid만 met:true", () => {
    const checks = forcedExitChecks({ ...base, fineUnpaid: true });
    expect(checks.find((c) => c.code === "fine_unpaid").met).toBe(true);
  });

  it("예치금 재납 미납이면 deposit_again_unpaid만 met:true", () => {
    const checks = forcedExitChecks({ ...base, depositAgainStatus: "미납" });
    expect(checks.find((c) => c.code === "deposit_again_unpaid").met).toBe(true);
  });

  it("페널티 총합 2회 이상이면 penalty_2_or_more가 met:true이고 label에 정확한 횟수가 보간된다", () => {
    const checks = forcedExitChecks({ ...base, outputPen: 1, timePen: 1 });
    const penaltyCheck = checks.find((c) => c.code === "penalty_2_or_more");
    expect(penaltyCheck.met).toBe(true);
    expect(penaltyCheck.label).toBe("페널티 누적 2회 이상 (송출 P 1회 / 주간 P 1회)");
  });

  it("페널티 총합 1회는 penalty_2_or_more가 met:false", () => {
    const checks = forcedExitChecks({ ...base, outputPen: 1, timePen: 0 });
    expect(checks.find((c) => c.code === "penalty_2_or_more").met).toBe(false);
  });
});

describe("calcForcedOutDeposit", () => {
  const base = { daysSinceJoin: 100, fineUnpaid: false, depositAgainStatus: null, outputPen: 0, timePen: 0 };

  it("조건 전부 met:false -> null", () => {
    expect(calcForcedOutDeposit(base)).toBeNull();
  });

  it("depositAgainStatus === '납부'면 다른 조건이 met이어도 무조건 null(재납 시 사유 무시)", () => {
    const breakdown = { ...base, daysSinceJoin: 10, fineUnpaid: true, depositAgainStatus: "납부" };
    expect(calcForcedOutDeposit(breakdown)).toBeNull();
  });

  it("조건 1개 이상 met, 납부 아님 -> discountRatio 1, reasons/resultStr에 met인 것만 포함", () => {
    const breakdown = { ...base, fineUnpaid: true };
    const result = calcForcedOutDeposit(breakdown);
    expect(result.discountRatio).toBe(1);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0].code).toBe("fine_unpaid");
    expect(result.resultStr).toEqual(["벌금 시한 내 미납 ➡️ 0% 반환"]);
    expect(result.allChecks).toHaveLength(4);
  });
});

describe("calcAdminForcedExit", () => {
  it("forcedReason이 있으면 resultStr에 해당 사유가 보간된다", () => {
    const result = calcAdminForcedExit("비매너 행위");
    expect(result.resultStr).toEqual(["즉시 직권퇴실자 (사유 : 비매너 행위) ➡️ 0% 반환"]);
    expect(result.reasons).toEqual([{ code: "admin_reason", label: "직권 사유: 비매너 행위" }]);
  });

  it.each([[""], [null], [undefined]])("forcedReason=%s이면 '(사유 미입력)'으로 대체된다", (forcedReason) => {
    const result = calcAdminForcedExit(forcedReason);
    expect(result.resultStr).toEqual(["즉시 직권퇴실자 (사유 : (사유 미입력)) ➡️ 0% 반환"]);
  });

  it("사유 유무와 무관하게 discountRatio는 항상 1이다", () => {
    expect(calcAdminForcedExit("아무 사유").discountRatio).toBe(1);
    expect(calcAdminForcedExit(null).discountRatio).toBe(1);
  });
});

describe("calcSettleReturnDeposit", () => {
  it.each([
    [{ outputPen: 0, timePen: 0, lateNotice: false }, 0, 100],
    [{ outputPen: 0, timePen: 0, lateNotice: true }, 0.5, 50],
    [{ outputPen: 1, timePen: 0, lateNotice: false }, 0.5, 50],
    // 🔧 버그였던 케이스: 페널티 1개 + 고지지연 = 100% 차감(0% 반환).
    // depositRefundBreakdown()의 동일 입력(penTotal===1, lateNotice===true
    // -> amount 0)과 반드시 일치해야 한다 — 아래 별도 교차 검증 테스트 참고.
    [{ outputPen: 1, timePen: 0, lateNotice: true }, 1, 0],
    [{ outputPen: 0, timePen: 1, lateNotice: true }, 1, 0],
  ])("outputPen/timePen/lateNotice=%j -> discountRatio %s (반환 %s%%)", (depositBreakdown, discountRatio, returnPct) => {
    const result = calcSettleReturnDeposit(depositBreakdown);
    expect(result.discountRatio).toBe(discountRatio);
    expect(result.reasons).toEqual([{ code: "settle_return_rate", label: `${returnPct}% 반환` }]);
  });

  it("고지지연이 있으면 resultStr에 '퇴실 통보 지연' 문구가 포함된다", () => {
    const result = calcSettleReturnDeposit({ outputPen: 0, timePen: 0, lateNotice: true });
    expect(result.resultStr[0]).toContain("퇴실 통보 지연");
  });

  it("고지지연이 없으면 resultStr에 '퇴실 통보 지연' 문구가 없다", () => {
    const result = calcSettleReturnDeposit({ outputPen: 0, timePen: 0, lateNotice: false });
    expect(result.resultStr[0]).not.toContain("퇴실 통보 지연");
  });

  // 🔧 [안전망 보강] depositRefundBreakdown().amount는 reason(참여상태
  // 미확인/가입 30일 미만/벌금 미납/예치금 재납 관련)이 있으면 페널티·
  // 고지지연과 무관하게 0원을 강제한다 — 관리자가 kind를 임의로 settle로
  // 지정해도 회원 쪽 예상액과 어긋나지 않도록, reason이 있으면 이 함수도
  // discountRatio=1(0% 반환)을 강제해야 한다.
  it.each([["참여상태 미확인"], ["가입 30일 미만"], ["벌금 시한 내 미납"], ["예치금 재납 시한 미납"], ["예치금 재납 대상자"]])(
    "reason=%s가 있으면 페널티/고지지연과 무관하게 discountRatio 1(0%% 반환)을 강제한다",
    (reason) => {
      const result = calcSettleReturnDeposit({ outputPen: 0, timePen: 0, lateNotice: false, reason });
      expect(result.discountRatio).toBe(1);
      expect(result.reasons).toEqual([{ code: "settle_return_rate", label: "0% 반환" }]);
      expect(result.resultStr[0]).toContain(reason);
    }
  );
});

describe("calcAgainDeposit", () => {
  it.each([["미납"], [""], [null]])("depositAgainStatus=%s -> null", (depositAgainStatus) => {
    expect(calcAgainDeposit({ depositAgainStatus })).toBeNull();
  });

  it("depositAgainStatus === '납부' -> discountRatio 1", () => {
    const result = calcAgainDeposit({ depositAgainStatus: "납부" });
    expect(result).toEqual({ resultStr: ["예치금 재납자 ➡️ 0% 반환"], discountRatio: 1 });
  });
});

describe("calcExitProcess", () => {
  const breakdown = { daysSinceJoin: 100, fineUnpaid: false, depositAgainStatus: null, outputPen: 0, timePen: 0, lateNotice: false };

  it.each([
    ["forced", calcForcedOutDeposit(breakdown)],
    ["admin_forced", calcAdminForcedExit("사유")],
    ["settle", calcSettleReturnDeposit(breakdown)],
    ["deposit_again", calcAgainDeposit(breakdown)],
  ])("kind=%s이면 해당 하위 함수를 직접 호출한 것과 동일한 결과를 반환한다", (kind, directResult) => {
    expect(calcExitProcess(kind, breakdown, "사유")).toEqual(directResult);
  });

  it("알 수 없는 kind는 null을 반환한다", () => {
    expect(calcExitProcess("unknown", breakdown, null)).toBeNull();
  });
});

describe("totalPenaltyBreakdown", () => {
  it("outputPenHistory/timePenHistory를 그대로 재포장한다", () => {
    const outputPenSlots = {
      outputPenHistory: [{ label: "4차", ts: 1 }],
      timePenHistory: [{ label: "주간P 1차", ts: 2 }],
      values: [],
      timePenValues: [],
    };
    expect(totalPenaltyBreakdown(outputPenSlots)).toEqual({
      outputPenHistory: outputPenSlots.outputPenHistory,
      timePenHistory: outputPenSlots.timePenHistory,
    });
  });

  it("이력이 빈 배열이어도 그대로 반환한다", () => {
    const outputPenSlots = { outputPenHistory: [], timePenHistory: [] };
    expect(totalPenaltyBreakdown(outputPenSlots)).toEqual({ outputPenHistory: [], timePenHistory: [] });
  });
});
