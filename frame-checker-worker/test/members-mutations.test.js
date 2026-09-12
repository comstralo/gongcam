// 회원 관리 도메인의 쓰기 경로 통합 테스트 — DO 락(withMemberLock)은
// 실제 workerd PARTICIPANTS_DO를 그대로 쓰고(mock 불필요, 6차까지
// 반복 검증된 패턴), fetch만 mock한다.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../src/index.js";
import { handleAdminSetPartiStatus, handleAdminMemberReorder, moveMemberSlot, handleAdminCreateMember } from "../src/members.js";
import { TEST_SERVICE_ACCOUNT_JSON, oauthTokenResponse } from "./helpers/service-account.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const TEST_SECRET = "test-session-secret";
const ADMIN_EMAIL = "admin@test.com";

function makeTestEnv(overrides = {}) {
  return {
    ...env,
    SESSION_SECRET: TEST_SECRET,
    ADMIN_EMAIL,
    GOOGLE_SHEET_FILE_ID: "live-members-mut-file",
    GOOGLE_SERVICE_ACCOUNT_JSON: TEST_SERVICE_ACCOUNT_JSON,
    ...overrides,
  };
}

async function makeAdminToken() {
  return signSession({ email: ADMIN_EMAIL, exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
}

async function makeNonAdminToken() {
  return signSession({ email: "member@test.com", exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
}

function makeRequest(url, { token, method = "GET", body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

function dataSheetResponse(members) {
  const rows = [["헤더", "번호", "이름", "이메일"]];
  for (const m of members) rows.push(["", String(m.number), m.name, m.email || ""]);
  return new Response(JSON.stringify({ values: rows }));
}

describe("handleAdminSetPartiStatus", () => {
  function stubFetch({ dataMembers, currentStatus, coReviewerStatuses }) {
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("values:batchGet")) {
          return Promise.resolve(
            new Response(JSON.stringify({ valueRanges: coReviewerStatuses.map((s) => ({ values: [[s]] })) }))
          );
        }
        if (u.includes("values:batchUpdate")) {
          return Promise.resolve(new Response(JSON.stringify({ ok: true })));
        }
        if (u.includes("V50")) return Promise.resolve(dataSheetResponse(dataMembers));
        if (u.includes("L3")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [[currentStatus]] })));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );
  }

  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeNonAdminToken();
    const req = makeRequest("https://worker/admin/members/parti-status", {
      token,
      method: "POST",
      body: { number: "1", appoint: true },
    });

    const res = await handleAdminSetPartiStatus(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("존재하지 않는 회원번호면 404를 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "mutations-parti-404" });
    const token = await makeAdminToken();
    stubFetch({ dataMembers: [{ number: 1, name: "가", email: "a@b.com" }], currentStatus: "", coReviewerStatuses: [] });
    const req = makeRequest("https://worker/admin/members/parti-status", {
      token,
      method: "POST",
      body: { number: "9", appoint: true },
    });

    const res = await handleAdminSetPartiStatus(req, testEnv, "https://example.com");
    expect(res.status).toBe(404);
  });

  it("스터디장은 변경할 수 없다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "mutations-parti-leader" });
    const token = await makeAdminToken();
    stubFetch({
      dataMembers: [{ number: 1, name: "가", email: "a@b.com" }],
      currentStatus: "스터디장",
      coReviewerStatuses: [],
    });
    const req = makeRequest("https://worker/admin/members/parti-status", {
      token,
      method: "POST",
      body: { number: "1", appoint: true },
    });

    const res = await handleAdminSetPartiStatus(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("부스터디장이 이미 2명이면 임명을 거부한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "mutations-parti-full" });
    const token = await makeAdminToken();
    stubFetch({
      dataMembers: [
        { number: 1, name: "가", email: "a@b.com" },
        { number: 2, name: "나", email: "b@c.com" },
        { number: 3, name: "다", email: "c@d.com" },
      ],
      currentStatus: "스터디원",
      coReviewerStatuses: ["부스터디장", "부스터디장", ""],
    });
    const req = makeRequest("https://worker/admin/members/parti-status", {
      token,
      method: "POST",
      body: { number: "3", appoint: true },
    });

    const res = await handleAdminSetPartiStatus(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("유효한 임명 요청이면 200을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "mutations-parti-ok" });
    const token = await makeAdminToken();
    stubFetch({
      dataMembers: [{ number: 1, name: "가", email: "a@b.com" }],
      currentStatus: "스터디원",
      coReviewerStatuses: [""],
    });
    const req = makeRequest("https://worker/admin/members/parti-status", {
      token,
      method: "POST",
      body: { number: "1", appoint: true },
    });

    const res = await handleAdminSetPartiStatus(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toEqual({ ok: true, partiStatus: "부스터디장" });
  });
});

describe("moveMemberSlot", () => {
  it("탭 삭제→이름변경→template 복사→값 이전까지 예외 없이 완료한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "mutations-move-slot" });
    const fileId = "mutations-move-slot";
    const batchUpdateCalls = [];

    vi.stubGlobal(
      "fetch",
      vi.fn((url, init) => {
        const u = String(url);
        if (u.includes("fields=sheets.properties")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                sheets: [
                  { properties: { sheetId: 1, title: "1" } },
                  { properties: { sheetId: 2, title: "2" } },
                  { properties: { sheetId: 3, title: "3" } },
                  { properties: { sheetId: 99, title: "template" } },
                ],
              })
            )
          );
        }
        if (u.includes(":copyTo")) {
          return Promise.resolve(new Response(JSON.stringify({ sheetId: 555 })));
        }
        if (u.includes("fields=sheets(properties.sheetId")) {
          return Promise.resolve(
            new Response(JSON.stringify({ sheets: [{ properties: { sheetId: 555 }, protectedRanges: [] }] }))
          );
        }
        if (/:batchUpdate$/.test(u)) {
          batchUpdateCalls.push(JSON.parse(init.body));
          return Promise.resolve(new Response(JSON.stringify({ ok: true })));
        }
        if (u.includes("values:batchUpdate")) {
          return Promise.resolve(new Response(JSON.stringify({ ok: true })));
        }
        if (u.includes("V")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [["a@b.com", "", 0, 0]] })));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );

    await expect(
      moveMemberSlot(testEnv, "token", fileId, ADMIN_EMAIL, "3", "2", 0)
    ).resolves.toBeUndefined();
    expect(batchUpdateCalls.length).toBeGreaterThan(0);
  });
});

describe("handleAdminMemberReorder", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeNonAdminToken();
    const req = makeRequest("https://worker/admin/members/reorder", { token, method: "POST" });

    const res = await handleAdminMemberReorder(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("이동할 슬롯이 없으면 빈 moved 배열과 함께 200을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "mutations-reorder-empty" });
    const token = await makeAdminToken();
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("V50")) return Promise.resolve(dataSheetResponse([{ number: 1, name: "가", email: "a@b.com" }]));
        if (u.includes("fields=sheets.properties")) {
          return Promise.resolve(new Response(JSON.stringify({ sheets: [{ properties: { sheetId: 1, title: "1" } }] })));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );
    const req = makeRequest("https://worker/admin/members/reorder", { token, method: "POST" });

    const res = await handleAdminMemberReorder(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toEqual({ ok: true, moved: [] });
  });
});

describe("handleAdminCreateMember", () => {
  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeNonAdminToken();
    const req = makeRequest("https://worker/admin/members/create", {
      token,
      method: "POST",
      body: { number: "1", name: "가", email: "a@b.com", goalHours: "10", goalKind: "취준" },
    });

    const res = await handleAdminCreateMember(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("시트번호가 범위를 벗어나면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeAdminToken();
    const req = makeRequest("https://worker/admin/members/create", {
      token,
      method: "POST",
      body: { number: "16", name: "가", email: "a@b.com", goalHours: "10", goalKind: "취준" },
    });

    const res = await handleAdminCreateMember(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("필수값이 없으면 400을 반환한다", async () => {
    const testEnv = makeTestEnv();
    const token = await makeAdminToken();
    const req = makeRequest("https://worker/admin/members/create", {
      token,
      method: "POST",
      body: { number: "1", name: "", email: "a@b.com", goalHours: "10", goalKind: "취준" },
    });

    const res = await handleAdminCreateMember(req, testEnv, "https://example.com");
    expect(res.status).toBe(400);
  });

  it("이미 배정된 번호면 409를 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "mutations-create-409" });
    const token = await makeAdminToken();
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("V50")) return Promise.resolve(dataSheetResponse([{ number: 1, name: "가", email: "a@b.com" }]));
        throw new Error("unexpected fetch: " + u);
      })
    );
    const req = makeRequest("https://worker/admin/members/create", {
      token,
      method: "POST",
      body: { number: "1", name: "나", email: "b@c.com", goalHours: "10", goalKind: "취준" },
    });

    const res = await handleAdminCreateMember(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
  });
});
