// 🔧 [사용자 지시] "주차 토글 옆에 관리자만 확인할 수 있는 사이클 범위를
// 지정할 수 있는 기능" — listAllCycleGroups/handleAdminCycleGroups/
// resolveTargetFileIdForAnyBackup 통합 테스트. handleCycleList와 동일한
// mock 패턴(cycle-list.test.js 참고)을 재사용한다. 각 백업 fileId별로
// getCurrentPenCycle이 "집계!D25"를 조회하므로, fetch mock에서 fileId를
// 구분해 서로 다른 사이클 값을 돌려준다.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../src/index.js";
import { listAllCycleGroups, handleAdminCycleGroups, resolveTargetFileIdForAnyBackup } from "../src/cycle.js";
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
    GOOGLE_SERVICE_ACCOUNT_JSON: TEST_SERVICE_ACCOUNT_JSON,
    BACKUP_FOLDER_ID: "test-backup-folder",
    ...overrides,
  };
}

function makeRequest(url, { token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(url, { headers });
}

function backupFolderResponse(files) {
  return new Response(JSON.stringify({ files }));
}

// 파일명 "공부합시당 캠스터디 YYMMDD-YYMMDD"에서 weekOf를 fileId로 그대로
// 쓰기 위해, fileId 자체를 weekOf로 맞춰 fetch mock을 단순화한다.
function backupFile(weekOf, weekTo) {
  return { id: weekOf, name: `공부합시당 캠스터디 ${weekOf}-${weekTo}` };
}

// D25 조회(getCurrentPenCycle)는 URL에 fileId와 "D25"가 함께 포함된다.
function stubFetchWithCycles({ liveCycle, backupCycles = {} }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
      if (u.includes("drive/v3/files")) {
        return Promise.resolve(
          backupFolderResponse([
            backupFile("260921", "260927"),
            backupFile("260914", "260920"),
            backupFile("260907", "260913"),
            backupFile("260831", "260906"),
            backupFile("260824", "260830"),
            backupFile("260817", "260823"),
          ])
        );
      }
      if (u.includes("D25")) {
        for (const [fileId, cycle] of Object.entries(backupCycles)) {
          if (u.includes(`/${fileId}/`) || u.includes(`spreadsheets/${fileId}`)) {
            return Promise.resolve(new Response(JSON.stringify({ values: [[String(cycle)]] })));
          }
        }
        // 나머지(라이브 시트)는 liveCycle.
        return Promise.resolve(new Response(JSON.stringify({ values: [[String(liveCycle)]] })));
      }
      throw new Error("unexpected fetch: " + u);
    })
  );
}

describe("listAllCycleGroups", () => {
  it("완결된 과거 사이클을 D25=1 경계로 정확히 그룹핑하고, 진행 중 사이클을 첫 그룹으로 합성한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "live-cycle-groups-1" });
    // 라이브 시트는 2주차 진행 중(260921 백업 하나만 현재 사이클 소속).
    // 나머지 백업(260914부터)은 D25 순환값 [1, 3,2,1, 2,1]로 과거 두 사이클을 이룬다.
    stubFetchWithCycles({
      liveCycle: 2,
      backupCycles: {
        260921: 1,
        260914: 3,
        260907: 2,
        260831: 1,
        260824: 2,
        260817: 1,
      },
    });

    const groups = await listAllCycleGroups(testEnv, "token");

    expect(groups).toHaveLength(3);
    // 진행 중 사이클: 라이브(2주차) + 260921(1주차, D25=1) 하나만 소속.
    expect(groups[0].isCurrent).toBe(true);
    expect(groups[0].currentWeekNumber).toBe(2);
    expect(groups[0].weeks.map((w) => w.weekOf)).toEqual(["260921"]);
    // 완결된 사이클 1: 260914(3주차) → 260907(2주차) → 260831(1주차).
    expect(groups[1].isCurrent).toBe(false);
    expect(groups[1].weeks.map((w) => w.weekOf)).toEqual(["260914", "260907", "260831"]);
    // 완결된 사이클 2: 260824(2주차) → 260817(1주차).
    expect(groups[2].weeks.map((w) => w.weekOf)).toEqual(["260824", "260817"]);
  });

  it("백업이 하나도 없으면 진행 중 그룹만 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "live-cycle-groups-empty" });
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("drive/v3/files")) return Promise.resolve(backupFolderResponse([]));
        if (u.includes("D25")) return Promise.resolve(new Response(JSON.stringify({ values: [["1"]] })));
        throw new Error("unexpected fetch: " + u);
      })
    );

    const groups = await listAllCycleGroups(testEnv, "token");
    expect(groups).toHaveLength(1);
    expect(groups[0].isCurrent).toBe(true);
    expect(groups[0].weeks).toEqual([]);
  });
});

describe("resolveTargetFileIdForAnyBackup", () => {
  it("cycleFileId가 없으면 실시간 원본을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "live-resolve-any-1" });
    const result = await resolveTargetFileIdForAnyBackup(testEnv, "token", null);
    expect(result).toEqual({ fileId: "live-resolve-any-1", weekOf: null });
  });

  it("현재 사이클을 훨씬 벗어난 과거 백업도 허용한다(resolveTargetFileId와의 핵심 차이)", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "live-resolve-any-2" });
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("drive/v3/files")) {
          return Promise.resolve(backupFolderResponse([backupFile("260817", "260823")]));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );

    const result = await resolveTargetFileIdForAnyBackup(testEnv, "token", "260817");
    expect(result).toEqual({ fileId: "260817", weekOf: "260817" });
  });

  it("백업 기록에 없는 fileId면 에러를 던진다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "live-resolve-any-3" });
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("drive/v3/files")) return Promise.resolve(backupFolderResponse([]));
        throw new Error("unexpected fetch: " + u);
      })
    );

    await expect(resolveTargetFileIdForAnyBackup(testEnv, "token", "no-such-file")).rejects.toThrow(
      "백업 기록에 없는 사이클입니다."
    );
  });
});

describe("handleAdminCycleGroups", () => {
  it("로그인하지 않으면 403을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "live-admin-cycles-401" });
    const req = makeRequest("https://worker/admin/cycles");

    const res = await handleAdminCycleGroups(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("관리자가 아니면 403을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "live-admin-cycles-403" });
    const token = await signSession({ email: "member@test.com", exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
    const req = makeRequest("https://worker/admin/cycles", { token });

    const res = await handleAdminCycleGroups(req, testEnv, "https://example.com");
    expect(res.status).toBe(403);
  });

  it("관리자면 200과 함께 groups 배열을 반환한다", async () => {
    const testEnv = makeTestEnv({ GOOGLE_SHEET_FILE_ID: "live-admin-cycles-200" });
    const token = await signSession({ email: ADMIN_EMAIL, exp: Date.now() / 1000 + 3600 }, TEST_SECRET);
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) return Promise.resolve(oauthTokenResponse());
        if (u.includes("drive/v3/files")) return Promise.resolve(backupFolderResponse([]));
        if (u.includes("D25")) return Promise.resolve(new Response(JSON.stringify({ values: [["1"]] })));
        throw new Error("unexpected fetch: " + u);
      })
    );
    const req = makeRequest("https://worker/admin/cycles", { token });

    const res = await handleAdminCycleGroups(req, testEnv, "https://example.com");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(Array.isArray(body.groups)).toBe(true);
    expect(body.groups[0].isCurrent).toBe(true);
  });
});
