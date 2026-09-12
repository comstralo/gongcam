// 회원 관리 도메인의 읽기 전용 함수 통합 테스트 — fetch mock만 필요.
// 6차(fines.js)와 동일하게 fileId를 테스트 케이스마다 다르게 줘서
// _cachedCompute 캐시 오염을 피한다.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCurrentCoReviewers } from "../src/index.js";
import { listAllMembers, getDataSheetRows, computeMemberReorderPlan } from "../src/members.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function dataSheetResponse(members) {
  const rows = [["헤더", "번호", "이름", "이메일"]];
  for (const m of members) {
    rows.push(["", String(m.number), m.name, m.email ? `${m.email}` : ""]);
  }
  return new Response(JSON.stringify({ values: rows }));
}

function stubDataFetch(members) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const u = String(url);
      if (u.includes("V50")) {
        return Promise.resolve(dataSheetResponse(members));
      }
      throw new Error("unexpected fetch: " + u);
    })
  );
}

describe("listAllMembers", () => {
  it("이메일이 있는 유효 회원만 걸러 반환한다", async () => {
    const testEnv = { ...env, GOOGLE_SHEET_FILE_ID: "members-fetch-list" };
    stubDataFetch([
      { number: 1, name: "가", email: "a@b.com" },
      { number: 2, name: "나", email: "" },
    ]);

    const members = await listAllMembers(testEnv, "token", "members-fetch-list");
    expect(members).toEqual([{ number: "1", name: "가", email: "a@b.com" }]);
  });
});

describe("getDataSheetRows", () => {
  it("데이터 시트 원본 로우를 그대로 반환한다", async () => {
    const testEnv = { ...env, GOOGLE_SHEET_FILE_ID: "members-fetch-rows" };
    stubDataFetch([{ number: 3, name: "다", email: "c@d.com" }]);

    const rows = await getDataSheetRows(testEnv, "token", "members-fetch-rows");
    expect(rows[1]).toEqual(["", "3", "다", "c@d.com"]);
  });
});

describe("getCurrentCoReviewers", () => {
  it("참여상태가 부스터디장인 회원만 반환한다", async () => {
    const testEnv = { ...env, GOOGLE_SHEET_FILE_ID: "members-fetch-coreviewers" };
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes(":batchGet")) {
          return Promise.resolve(
            new Response(JSON.stringify({ valueRanges: [{ values: [["부스터디장"]] }, { values: [[""]] }] }))
          );
        }
        if (u.includes("V50")) {
          return Promise.resolve(
            dataSheetResponse([
              { number: 1, name: "가", email: "a@b.com" },
              { number: 2, name: "나", email: "b@c.com" },
            ])
          );
        }
        throw new Error("unexpected fetch: " + u);
      })
    );

    const coReviewers = await getCurrentCoReviewers(testEnv, "token", "members-fetch-coreviewers");
    expect(coReviewers).toEqual([{ number: "1", name: "가" }]);
  });
});

describe("computeMemberReorderPlan", () => {
  it("점유 슬롯을 앞으로 당겨 채우는 이동 계획을 계산한다", async () => {
    const testEnv = { ...env, GOOGLE_SHEET_FILE_ID: "members-fetch-reorder" };
    stubDataFetch([
      { number: 1, name: "가", email: "a@b.com" },
      { number: 3, name: "다", email: "c@d.com" },
    ]);

    const plan = await computeMemberReorderPlan(testEnv, "token");
    expect(plan).toEqual([{ from: "3", to: "2", name: "다" }]);
  });

  it("이미 제자리인 슬롯은 계획에서 뺀다", async () => {
    const testEnv = { ...env, GOOGLE_SHEET_FILE_ID: "members-fetch-reorder-noop" };
    stubDataFetch([{ number: 1, name: "가", email: "a@b.com" }]);

    const plan = await computeMemberReorderPlan(testEnv, "token");
    expect(plan).toEqual([]);
  });
});
