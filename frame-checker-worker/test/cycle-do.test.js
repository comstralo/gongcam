// 오늘 세션에서 발견·수정한 사이클 오인 버그의 근본 로직 —
// resolveExitSourceFileId(퇴실 정산)와 resolveCaptureSourceFileId(화각 불량
// 제보 확인)를 테스트한다. @cloudflare/vitest-plugin은 실제 workerd
// 런타임이므로 env.LEAVE_QUEUE_DO는 mock 없이 실제 Durable Object로
// 동작한다 — mock이 필요한 건 fetch(Drive/Sheets API)와 시스템 시계뿐이다.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLeaveQueueStub, resolveCaptureSourceFileId, resolveExitSourceFileId } from "../src/index.js";

function driveFilesResponse(names) {
  return new Response(JSON.stringify({ files: names.map((name, i) => ({ id: `file-${i}-${name}`, name })) }), {
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetchForBackupsAndCycle(backupNames, currentCycle) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const u = String(url);
      if (u.includes("drive/v3/files")) {
        return Promise.resolve(driveFilesResponse(backupNames));
      }
      if (u.includes("sheets.googleapis.com")) {
        return Promise.resolve(new Response(JSON.stringify({ values: [[String(currentCycle)]] })));
      }
      throw new Error("unexpected fetch: " + u);
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("resolveExitSourceFileId", () => {
  // exitDate = 2026-09-07(월요일). 그 주의 리셋 시각은 다음 주 월요일
  // (2026-09-14) 06:00 KST == 2026-09-13 21:00 UTC (cycle-clock.test.js와 동일).
  const exitDate = "2026-09-07";
  const resetAtUtcMs = Date.UTC(2026, 8, 13, 21, 0, 0);

  it("kind가 settle이 아니면 exitRequests 조회 없이 cycleFileId 분기로 바로 간다", async () => {
    const testEnv = { ...env, GOOGLE_SHEET_FILE_ID: "live-file-id-a" };
    const result = await resolveExitSourceFileId(testEnv, "test-access-token", "live-file-id-a", "9001", "forced", null);
    expect(result).toEqual({ sourceFileId: "live-file-id-a", fromBackup: false });
  });

  it("settle이지만 퇴실 신청 자체가 없으면 cycleFileId 없이 원본을 그대로 반환한다", async () => {
    const testEnv = { ...env, GOOGLE_SHEET_FILE_ID: "live-file-id-b" };
    const result = await resolveExitSourceFileId(testEnv, "test-access-token", "live-file-id-b", "9002-no-entry", "settle", null);
    expect(result).toEqual({ sourceFileId: "live-file-id-b", fromBackup: false });
  });

  it("settle이고 리셋 전이면 원본 그대로 반환한다(실제 DO에 신청 데이터를 심어서 검증)", async () => {
    const memberNumber = "9003";
    await getLeaveQueueStub(env).fetch("https://do/exit/put", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberNumber, exitDate, ts: Date.now() }),
    });

    vi.useFakeTimers();
    vi.setSystemTime(resetAtUtcMs - 1);

    const testEnv = { ...env, GOOGLE_SHEET_FILE_ID: "live-file-id-c" };
    const result = await resolveExitSourceFileId(testEnv, "test-access-token", "live-file-id-c", memberNumber, "settle", null);
    expect(result).toEqual({ sourceFileId: "live-file-id-c", fromBackup: false });
  });

  it("settle이고 리셋이 지났으면 exitDate가 속한 주의 백업 파일을 반환한다", async () => {
    const memberNumber = "9004";
    await getLeaveQueueStub(env).fetch("https://do/exit/put", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberNumber, exitDate, ts: Date.now() }),
    });

    vi.useFakeTimers();
    vi.setSystemTime(resetAtUtcMs + 1000);
    // exitDate(2026-09-07)가 속한 주의 weekOf는 "260907"(월요일 그 자신).
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const u = String(url);
        if (u.includes("drive/v3/files")) {
          return Promise.resolve(driveFilesResponse(["공부합시당 캠스터디 260907-260913"]));
        }
        throw new Error("unexpected fetch: " + u);
      })
    );

    const testEnv = { ...env, GOOGLE_SHEET_FILE_ID: "live-file-id-d", BACKUP_FOLDER_ID: "test-folder-d" };
    const result = await resolveExitSourceFileId(testEnv, "test-access-token", "live-file-id-d", memberNumber, "settle", null);
    expect(result).toEqual({ sourceFileId: "file-0-공부합시당 캠스터디 260907-260913", fromBackup: true });
  });

  it("settle이고 리셋이 지났는데 백업이 아직 없으면 에러를 던진다", async () => {
    const memberNumber = "9005";
    await getLeaveQueueStub(env).fetch("https://do/exit/put", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberNumber, exitDate, ts: Date.now() }),
    });

    vi.useFakeTimers();
    vi.setSystemTime(resetAtUtcMs + 1000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(driveFilesResponse([])));

    const testEnv = { ...env, GOOGLE_SHEET_FILE_ID: "live-file-id-e", BACKUP_FOLDER_ID: "test-folder-e" };
    await expect(
      resolveExitSourceFileId(testEnv, "test-access-token", "live-file-id-e", memberNumber, "settle", null)
    ).rejects.toThrow("퇴실 예약 주차의 백업 시트를 아직 찾을 수 없습니다.");
  });
});

describe("resolveCaptureSourceFileId", () => {
  // "지금"을 2026-09-16(수) 10:00 KST(== 2026-09-16 01:00 UTC)로 고정 —
  // currentWeekMondayKST()가 "260914"를 반환하는 주.
  const nowUtcMs = Date.UTC(2026, 8, 16, 1, 0, 0);

  afterEach(() => {
    vi.useRealTimers();
  });

  it("제보가 이번 주에 발생했으면 원본을 그대로 반환한다(fetch 없음)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowUtcMs);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // ts도 같은 주(2026-09-16 09:00 KST)로 맞춘다.
    const ts = Date.UTC(2026, 8, 16, 0, 0, 0);
    const testEnv = { ...env, GOOGLE_SHEET_FILE_ID: "live-file-id-f" };
    const result = await resolveCaptureSourceFileId(testEnv, "test-access-token", "live-file-id-f", ts);

    expect(result).toEqual({ sourceFileId: "live-file-id-f", fromBackup: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("같은 3주 사이클 안의 지난 주에 발생했으면 그 주의 백업(현재 사이클 소속)에 기록한다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowUtcMs);
    // ts는 지난 주(2026-09-09, 월요일 weekOf="260907")에 발생.
    const ts = Date.UTC(2026, 8, 9, 0, 0, 0);

    stubFetchForBackupsAndCycle(["공부합시당 캠스터디 260907-260913"], 2);

    const testEnv = { ...env, GOOGLE_SHEET_FILE_ID: "live-file-id-g", BACKUP_FOLDER_ID: "test-folder-g" };
    const result = await resolveCaptureSourceFileId(testEnv, "test-access-token", "live-file-id-g", ts);

    expect(result).toEqual({ sourceFileId: "file-0-공부합시당 캠스터디 260907-260913", fromBackup: true });
  });

  it("이미 사이클이 리셋되어 지난 주가 현재 사이클 밖이면, 전체 백업에서 직접 찾아 기록한다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowUtcMs);
    // ts는 이미 끝난 사이클의 주(2026-08-24, weekOf="260824")에 발생 —
    // 이번 사이클(1주차, currentCycle=1)의 listCurrentCycleBackups는 0개를
    // 반환하므로 (c) 분기(listBackupFiles 전체 탐색)를 타야 한다.
    const ts = Date.UTC(2026, 7, 24, 0, 0, 0);

    stubFetchForBackupsAndCycle(
      ["공부합시당 캠스터디 260907-260913", "공부합시당 캠스터디 260824-260830"],
      1
    );

    const testEnv = { ...env, GOOGLE_SHEET_FILE_ID: "live-file-id-h", BACKUP_FOLDER_ID: "test-folder-h" };
    const result = await resolveCaptureSourceFileId(testEnv, "test-access-token", "live-file-id-h", ts);

    expect(result).toEqual({ sourceFileId: "file-1-공부합시당 캠스터디 260824-260830", fromBackup: true });
  });

  it("발생 주차의 백업이 어디에도 없으면 에러를 던진다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowUtcMs);
    const ts = Date.UTC(2026, 7, 24, 0, 0, 0);

    stubFetchForBackupsAndCycle(["공부합시당 캠스터디 260907-260913"], 1);

    const testEnv = { ...env, GOOGLE_SHEET_FILE_ID: "live-file-id-i", BACKUP_FOLDER_ID: "test-folder-i" };
    await expect(
      resolveCaptureSourceFileId(testEnv, "test-access-token", "live-file-id-i", ts)
    ).rejects.toThrow("제보가 발생한 주차의 백업 시트를 아직 찾을 수 없습니다.");
  });
});
