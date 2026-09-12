// 벌금/납부 처리 도메인의 fetch 의존 조회 함수 테스트. cycle-fetch.test.js
// 와 동일한 vi.stubGlobal("fetch", ...) 패턴을 재사용한다 — DO는 전혀
// 쓰이지 않는 얕은 도메인이라 fetch mock만으로 충분하다.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectFinesByStatus,
  getWeeklyPaidFineTotal,
  listExemptFines,
  listPaidFines,
  listUnpaidFines,
} from "../src/fines.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

// "데이터!A1:V50" 응답 — B/C/D열이 번호/이름/이메일. 헤더 행은 번호가
// 숫자가 아니라 listAllMembers가 자동으로 걸러낸다.
function dataSheetResponse(members) {
  const rows = [["헤더", "번호", "이름", "이메일"]];
  for (const m of members) {
    rows.push(["", String(m.number), m.name, `${m.email},gooroomee${m.number}`]);
  }
  return new Response(JSON.stringify({ values: rows }), {
    headers: { "Content-Type": "application/json" },
  });
}

// batchGet 응답 — 각 회원 탭의 A1:U41 범위. ROW_PAYMENT_CHECK(31행, 0-idx)
// 에 STATUS_DAY_COLS(2,5,8,11,14,17,20) 위치로 상태값을 채운다.
function batchGetPaymentResponse(memberPaymentRows) {
  const valueRanges = memberPaymentRows.map((paymentRow) => {
    const rows = [];
    rows[31] = paymentRow;
    return { values: rows };
  });
  return new Response(JSON.stringify({ valueRanges }), {
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(dataMembers, memberPaymentRows) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const u = String(url);
      if (u.includes(":batchGet")) {
        return Promise.resolve(batchGetPaymentResponse(memberPaymentRows));
      }
      if (u.includes("V50")) {
        return Promise.resolve(dataSheetResponse(dataMembers));
      }
      if (u.includes("D22")) {
        return Promise.resolve(new Response(JSON.stringify({ values: [["15000"]] })));
      }
      throw new Error("unexpected fetch: " + u);
    })
  );
}

describe("collectFinesByStatus", () => {
  it("해당 상태값이 찍힌 요일만 정확히 걸러낸다(순수 필터)", () => {
    const paymentRows = [
      { member: { number: "1", name: "가" }, paymentRow: { 2: "미납", 5: "납부", 8: "미납" } },
      { member: { number: "2", name: "나" }, paymentRow: { 2: "면제" } },
    ];
    expect(collectFinesByStatus(paymentRows, "미납")).toEqual([
      { number: "1", name: "가", day: "월" },
      { number: "1", name: "가", day: "수" },
    ]);
  });

  it("해당 상태값이 없으면 빈 배열을 반환한다", () => {
    const paymentRows = [{ member: { number: "1", name: "가" }, paymentRow: {} }];
    expect(collectFinesByStatus(paymentRows, "미납")).toEqual([]);
  });
});

describe("listUnpaidFines", () => {
  it("데이터 시트+batchGet을 조회해 '미납'이 찍힌 요일만 모은다", async () => {
    const members = [
      { number: 1, name: "가", email: "a@b.com" },
      { number: 2, name: "나", email: "c@d.com" },
    ];
    stubFetch(members, [
      { 2: "미납", 5: "납부" }, // 회원 1: 월요일 미납
      { 2: "납부", 8: "미납" }, // 회원 2: 수요일 미납
    ]);

    const unpaid = await listUnpaidFines({ ...env, GOOGLE_SHEET_FILE_ID: "test-fine-1" }, "token", "test-fine-1");

    expect(unpaid).toEqual([
      { number: "1", name: "가", day: "월" },
      { number: "2", name: "나", day: "수" },
    ]);
  });

  it("미납이 하나도 없으면 빈 배열을 반환한다", async () => {
    const members = [{ number: 1, name: "가", email: "a@b.com" }];
    stubFetch(members, [{ 2: "납부" }]);

    const unpaid = await listUnpaidFines({ ...env, GOOGLE_SHEET_FILE_ID: "test-fine-2" }, "token", "test-fine-2");
    expect(unpaid).toEqual([]);
  });
});

describe("listPaidFines", () => {
  it("'납부'가 찍힌 요일만 모은다", async () => {
    const members = [{ number: 1, name: "가", email: "a@b.com" }];
    stubFetch(members, [{ 2: "납부", 5: "미납", 8: "납부" }]);

    const paid = await listPaidFines({ ...env, GOOGLE_SHEET_FILE_ID: "test-fine-3" }, "token", "test-fine-3");
    expect(paid).toEqual([
      { number: "1", name: "가", day: "월" },
      { number: "1", name: "가", day: "수" },
    ]);
  });
});

describe("listExemptFines", () => {
  it("'면제'가 찍힌 요일만 모은다", async () => {
    const members = [{ number: 1, name: "가", email: "a@b.com" }];
    stubFetch(members, [{ 2: "면제" }]);

    const exempt = await listExemptFines({ ...env, GOOGLE_SHEET_FILE_ID: "test-fine-4" }, "token", "test-fine-4");
    expect(exempt).toEqual([{ number: "1", name: "가", day: "월" }]);
  });
});

describe("getWeeklyPaidFineTotal", () => {
  it("집계!D22 값을 숫자로 파싱해 반환한다", async () => {
    stubFetch([], []);
    const total = await getWeeklyPaidFineTotal({ ...env, GOOGLE_SHEET_FILE_ID: "test-fine-5" }, "token", "test-fine-5");
    expect(total).toBe(15000);
  });
});
