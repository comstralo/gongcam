// fetch(Google Drive/Sheets API) mock이 필요한 사이클 판정 함수 테스트.
// @cloudflare/vitest-plugin은 실제 workerd 런타임을 쓰므로, 이 mock 전략
// (vi.stubGlobal("fetch", ...))이 실제로 통하는지가 3단계 전체의 전제다 —
// listBackupFiles로 먼저 검증한 뒤 나머지 함수로 확장한다.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listBackupFiles, listCurrentCycleBackups, resolveTargetFileId } from "../src/index.js";

function driveFilesResponse(names) {
  return new Response(JSON.stringify({ files: names.map((name, i) => ({ id: `file-${i}-${name}`, name })) }), {
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listBackupFiles", () => {
  it("파일명 패턴에 맞는 것만 걸러 weekOf 내림차순으로 반환한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      driveFilesResponse([
        "공부합시당 캠스터디 260817-260823",
        "공부합시당 캠스터디 260810-260816",
        "공부합시당 캠스터디 260824-260830 (1)", // 중복 접미사도 허용
        "관계없는 파일",
        "공부합시당 캠스터디 260803-260809", // BACKUP_HISTORY_START_WEEK_OF(260810) 이전 — 제외
      ])
    );
    vi.stubGlobal("fetch", fetchMock);

    const backups = await listBackupFiles({ ...env, BACKUP_FOLDER_ID: "test-folder" }, "test-access-token");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(backups.map((b) => b.weekOf)).toEqual(["260824", "260817", "260810"]);
  });

  it("Drive API가 files 필드를 주지 않으면 에러를 던진다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "denied" }))));
    await expect(listBackupFiles({ ...env, BACKUP_FOLDER_ID: "test-folder" }, "test-access-token")).rejects.toThrow(
      "백업 폴더 조회 실패"
    );
  });
});

describe("resolveTargetFileId", () => {
  it("cycleFileId가 없으면 fetch 없이 현재 시트를 그대로 반환한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const testEnv = { ...env, GOOGLE_SHEET_FILE_ID: "live-file-id" };
    const result = await resolveTargetFileId(testEnv, "test-access-token", null);

    expect(result).toEqual({ fileId: "live-file-id", weekOf: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cycleFileId가 현재 사이클에 속하면 그 백업 정보를 반환한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("drive/v3/files")) {
          return Promise.resolve(driveFilesResponse(["공부합시당 캠스터디 260817-260823"]));
        }
        if (u.includes("sheets.googleapis.com")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [["2"]] })));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );

    const testEnv = { ...env, GOOGLE_SHEET_FILE_ID: "live-file-id", BACKUP_FOLDER_ID: "test-folder" };
    const backupFileId = "file-0-공부합시당 캠스터디 260817-260823";
    const result = await resolveTargetFileId(testEnv, "test-access-token", backupFileId);

    expect(result).toEqual({ fileId: backupFileId, weekOf: "260817" });
  });

  it("cycleFileId가 현재 사이클에 속하지 않으면 에러를 던진다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("drive/v3/files")) {
          return Promise.resolve(driveFilesResponse(["공부합시당 캠스터디 260817-260823"]));
        }
        if (u.includes("sheets.googleapis.com")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [["2"]] })));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );

    const testEnv = { ...env, GOOGLE_SHEET_FILE_ID: "live-file-id-2", BACKUP_FOLDER_ID: "test-folder-2" };
    await expect(resolveTargetFileId(testEnv, "test-access-token", "not-in-cycle")).rejects.toThrow(
      "현재 사이클에 속하지 않는 기록입니다."
    );
  });
});

describe("listCurrentCycleBackups", () => {
  it("currentCycle 값에 맞는 개수만큼만 백업을 반환한다(1주차 -> 0개)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("drive/v3/files")) {
          return Promise.resolve(
            driveFilesResponse(["공부합시당 캠스터디 260824-260830", "공부합시당 캠스터디 260817-260823"])
          );
        }
        if (u.includes("sheets.googleapis.com")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [["1"]] })));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );

    const testEnv = { ...env, GOOGLE_SHEET_FILE_ID: "live-file-id-3", BACKUP_FOLDER_ID: "test-folder-3" };
    const { backups, currentCycle } = await listCurrentCycleBackups(testEnv, "test-access-token");

    expect(currentCycle).toBe(1);
    expect(backups).toEqual([]);
  });

  it("3주차면 이전 2개 백업을 최신순으로 반환한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("drive/v3/files")) {
          return Promise.resolve(
            driveFilesResponse([
              "공부합시당 캠스터디 260824-260830",
              "공부합시당 캠스터디 260817-260823",
              "공부합시당 캠스터디 260810-260816",
            ])
          );
        }
        if (u.includes("sheets.googleapis.com")) {
          return Promise.resolve(new Response(JSON.stringify({ values: [["3"]] })));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );

    const testEnv = { ...env, GOOGLE_SHEET_FILE_ID: "live-file-id-4", BACKUP_FOLDER_ID: "test-folder-4" };
    const { backups, currentCycle } = await listCurrentCycleBackups(testEnv, "test-access-token");

    expect(currentCycle).toBe(3);
    expect(backups.map((b) => b.weekOf)).toEqual(["260824", "260817"]);
  });
});
