// 사이클 판정 관련 완전 순수 함수 테스트 — fetch/DO/캐시 의존이 전혀
// 없어 mock 없이 바로 검증 가능한 함수들만 모았다. 이 테스트들은
// "그 사이클에 발생한 일은 그 사이클에 기록되어야 한다"는 원칙(2026-09
// 세션에서 여러 차례 발견·수정한 사이클 오인 버그들의 공통 근거)이
// 회귀 없이 유지되는지 확인하는 안전망이다.
import { describe, expect, it } from "vitest";
import {
  compareWeekOfDesc,
  currentCycleBackups,
  exitDateMidnightUtcMs,
  formatYYMMDD,
  isUnguardedAdminForcedCycleCombo,
  kstDateKey,
  requiresFineUnpaidRecheck,
  weekOfForDate,
} from "../src/index.js";

describe("requiresFineUnpaidRecheck", () => {
  // 직권 P(admin_forced)의 "벌금 시한 내 미납자" 고정 사유일 때만
  // 재검증 대상이 된다(§CACHING_POLICY.md §50).
  it.each([
    ["admin_forced", "벌금 시한 내 미납자", true],
    ["admin_forced", "비매너 행위로 인한 즉시 퇴실", false],
    ["admin_forced", "", false],
    ["admin_forced", null, false],
    ["forced", "벌금 시한 내 미납자", false],
    ["settle", "벌금 시한 내 미납자", false],
    ["deposit_again", "벌금 시한 내 미납자", false],
    // 앞뒤 공백은 trim되어 정확히 일치해야 한다.
    ["admin_forced", "  벌금 시한 내 미납자  ", true],
  ])("kind=%s, forcedReason=%s -> %s", (kind, forcedReason, expected) => {
    expect(requiresFineUnpaidRecheck(kind, forcedReason)).toBe(expected);
  });
});

describe("isUnguardedAdminForcedCycleCombo", () => {
  // 2026-09-12 세션에서 실제 프로덕션 API로 검증했던 4가지 조합
  // (docs/WEB_ADMIN.md §3.6 "직권 P: 자유 사유 + 지난 사이클 조합" 참고).
  it.each([
    // [kind, forcedReason, cycleFileId, expected]
    ["admin_forced", "벌금 시한 내 미납자", null, false], // 정상: 고정 사유, 이번 주
    ["admin_forced", "벌금 시한 내 미납자", "backup-file-id", false], // 정상: 고정 사유 + cycle → fineUnpaidRecheckFailed가 대신 검증
    ["admin_forced", "비매너 행위", null, false], // 정상: 자유 사유, 이번 주(MemberRosterList 경로)
    ["admin_forced", "비매너 행위", "backup-file-id", true], // 차단 대상: 자유 사유 + cycle
    ["forced", "비매너 행위", "backup-file-id", false], // admin_forced가 아니면 애초에 대상 아님
    ["settle", null, "backup-file-id", false],
  ])("kind=%s, forcedReason=%s, cycleFileId=%s -> %s", (kind, forcedReason, cycleFileId, expected) => {
    expect(isUnguardedAdminForcedCycleCombo(kind, forcedReason, cycleFileId)).toBe(expected);
  });

  it("고정 사유 여부와 무관하게 항상 requiresFineUnpaidRecheck의 여집합이다", () => {
    // 두 함수가 서로 모순되는 조합(둘 다 true, 또는 cycle 있는데 둘 다 false)이
    // 없어야 한다 — isUnguardedAdminForcedCycleCombo는 requiresFineUnpaidRecheck
    // 를 그대로 합성해서 쓰므로 항상 여집합 관계가 유지돼야 한다.
    const cases = [
      ["admin_forced", "벌금 시한 내 미납자"],
      ["admin_forced", "자유 사유"],
      ["forced", "벌금 시한 내 미납자"],
      ["settle", null],
    ];
    for (const [kind, forcedReason] of cases) {
      const recheck = requiresFineUnpaidRecheck(kind, forcedReason);
      const blocked = isUnguardedAdminForcedCycleCombo(kind, forcedReason, "some-cycle-file-id");
      if (kind === "admin_forced") {
        expect(blocked).toBe(!recheck);
      } else {
        expect(blocked).toBe(false);
      }
    }
  });
});

describe("exitDateMidnightUtcMs", () => {
  it("YYYY-MM-DD를 KST 자정의 UTC epoch ms로 변환한다", () => {
    // 2026-09-07 00:00 KST == 2026-09-06 15:00 UTC
    expect(exitDateMidnightUtcMs("2026-09-07")).toBe(Date.UTC(2026, 8, 6, 15, 0, 0));
  });

  it("형식이 안 맞으면 null을 반환한다", () => {
    expect(exitDateMidnightUtcMs("")).toBeNull();
    expect(exitDateMidnightUtcMs(null)).toBeNull();
    expect(exitDateMidnightUtcMs("2026/09/07")).toBeNull();
    expect(exitDateMidnightUtcMs("invalid")).toBeNull();
  });
});

describe("weekOfForDate", () => {
  it("월요일 자신을 넣으면 그 날짜 그대로 YYMMDD를 반환한다", () => {
    // 2026-09-07은 월요일.
    expect(weekOfForDate("2026-09-07")).toBe("260907");
  });

  it("주중 아무 날짜를 넣어도 그 주의 월요일로 역산한다", () => {
    // 2026-09-09(수), 2026-09-13(일) 모두 같은 주(월=09-07)에 속한다.
    expect(weekOfForDate("2026-09-09")).toBe("260907");
    expect(weekOfForDate("2026-09-13")).toBe("260907");
  });

  it("월 경계를 넘는 주도 정확히 계산한다", () => {
    // 2026-09-01(화)은 2026-08-31(월)이 속한 주.
    expect(weekOfForDate("2026-09-01")).toBe("260831");
  });

  it("형식이 안 맞으면 null을 반환한다", () => {
    expect(weekOfForDate("")).toBeNull();
    expect(weekOfForDate(null)).toBeNull();
  });
});

describe("kstDateKey", () => {
  it("KST 기준 YYYY-MM-DD를 반환한다", () => {
    // 2026-09-09 00:30 KST == 2026-09-08 15:30 UTC
    const ts = Date.UTC(2026, 8, 8, 15, 30, 0);
    expect(kstDateKey(ts)).toBe("2026-09-09");
  });

  it("UTC 자정 근처(KST 날짜가 하루 앞서는 경계)에서도 KST 날짜를 정확히 반환한다", () => {
    // UTC 2026-09-08 23:00 == KST 2026-09-09 08:00 — 같은 UTC 날짜라도
    // KST로는 이미 다음 날이다.
    const ts = Date.UTC(2026, 8, 8, 23, 0, 0);
    expect(kstDateKey(ts)).toBe("2026-09-09");
  });
});

describe("formatYYMMDD", () => {
  it("UTC getter로 연/월/일을 2자리씩 패딩해 YYMMDD를 만든다", () => {
    expect(formatYYMMDD(new Date(Date.UTC(2026, 8, 7)))).toBe("260907"); // 9월(0-indexed 8)
    expect(formatYYMMDD(new Date(Date.UTC(2026, 0, 1)))).toBe("260101"); // 1월 1일(한 자리 월/일)
  });
});

describe("compareWeekOfDesc", () => {
  it("weekOf 문자열을 최신순(내림차순)으로 정렬한다", () => {
    const items = [{ weekOf: "260810" }, { weekOf: "260824" }, { weekOf: "260817" }];
    items.sort(compareWeekOfDesc);
    expect(items.map((i) => i.weekOf)).toEqual(["260824", "260817", "260810"]);
  });
});

describe("currentCycleBackups", () => {
  // 🔧 [버그 수정, 2026-09] sheet_reset()이 D25(사이클)를 갱신하기 *전에*
  // 백업을 먼저 뜨므로, 백업 파일엔 항상 "그 주가 실제로 몇 주차였는지"
  // 값이 남는다 — 이 재발 방지 테스트 자체가 그 수정의 핵심이다.
  const backups = [{ weekOf: "260824" }, { weekOf: "260817" }, { weekOf: "260810" }, { weekOf: "260803" }];

  it.each([
    [1, []],
    [2, [{ weekOf: "260824" }]],
    [3, [{ weekOf: "260824" }, { weekOf: "260817" }]],
  ])("currentCycle=%s -> 최신 %s개만 반환한다", (currentCycle, expected) => {
    expect(currentCycleBackups(backups, currentCycle)).toEqual(expected);
  });

  it("currentCycle이 CYCLE_MAX_LEN(3)을 넘거나 비정상 값이어도 최대 2개로 고정된다", () => {
    expect(currentCycleBackups(backups, 4)).toEqual([{ weekOf: "260824" }, { weekOf: "260817" }]);
    expect(currentCycleBackups(backups, 0)).toEqual([]);
  });
});
