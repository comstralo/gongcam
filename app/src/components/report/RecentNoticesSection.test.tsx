// 🔧 [2026-09-22 사용자 지시: "응 진행해"(프론트 테스트 도구 보강
// 5차, fetch 의존 컴포넌트 첫 대상)] — useApi()가 실제로 apiFetch를
// 호출해 전역 fetch를 타므로, stubApiFetch(test-utils.tsx)로 응답을
// 통제한다. 15초 폴링과 1초 tick(경과 시간 갱신) 둘 다 있어
// vi.useFakeTimers()로 시간을 직접 제어해야 결정적으로 테스트할 수
// 있다.
//
// 🔧 [디버그 확인] vi.useFakeTimers()를 켠 채 @testing-library/react의
// waitFor()를 쓰면 전부 타임아웃났다 — waitFor 내부 폴링이 실제
// setTimeout에 의존하는데 fake timer가 그 시간 흐름 자체를 멈춰버려서
// fetch 응답이 이미 resolve됐어도 waitFor가 다음 체크를 하지 못한다.
// 대신 vi.advanceTimersByTimeAsync()(pending microtask/promise까지
// 함께 진행시키는 비동기 버전)로 시간을 흘려보낸 뒤 곧바로 동기
// assertion을 쓰는 방식으로 전환해 해결했다 — fake timer 환경에서는
// 이 패턴이 waitFor보다 안전하다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, act } from "@testing-library/react";
import { renderWithProviders, stubApiFetch, makeSession } from "@/test-utils";
import { RecentNoticesSection } from "./RecentNoticesSection";
import type { RecentNoticesResponse } from "@/lib/api/types";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RecentNoticesSection", () => {
  it("항목이 없으면 안내 문구를 보여준다", async () => {
    stubApiFetch({
      "/push/recent-notices": { body: { items: [] } satisfies RecentNoticesResponse },
    });
    renderWithProviders(<RecentNoticesSection />, { authValue: { session: makeSession() } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("최근 전송된 알림이 없습니다.")).toBeInTheDocument();
  });

  it("항목이 있으면 닉네임과 메시지를 표시한다", async () => {
    stubApiFetch({
      "/push/recent-notices": {
        body: {
          items: [{ nickname: "재희", message: "공지 도착", senderName: "관리자", ts: Date.now() }],
        } satisfies RecentNoticesResponse,
      },
    });
    renderWithProviders(<RecentNoticesSection />, { authValue: { session: makeSession() } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("재희 · 공지 도착")).toBeInTheDocument();
  });

  it("경과 시간이 1분 미만이면 '방금 전'을, 1분 이상이면 'N분 전'을 표시한다", async () => {
    const now = Date.now();
    stubApiFetch({
      "/push/recent-notices": {
        body: {
          items: [{ nickname: "재희", message: "방금", senderName: "관리자", ts: now }],
        } satisfies RecentNoticesResponse,
      },
    });
    renderWithProviders(<RecentNoticesSection />, { authValue: { session: makeSession() } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("방금 전")).toBeInTheDocument();

    // tick 타이머(1초 주기)로 "지금"이 갱신되며 3분 경과를 흉내 낸다.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    });
    expect(screen.getByText("3분 전")).toBeInTheDocument();
  });

  it("15초마다 목록을 다시 조회한다(폴링)", async () => {
    const { fetchMock } = stubApiFetch({
      "/push/recent-notices": { body: { items: [] } satisfies RecentNoticesResponse },
    });
    renderWithProviders(<RecentNoticesSection />, { authValue: { session: makeSession() } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshSignal이 바뀌면 폴링 주기를 기다리지 않고 즉시 다시 조회한다", async () => {
    const { fetchMock } = stubApiFetch({
      "/push/recent-notices": { body: { items: [] } satisfies RecentNoticesResponse },
    });
    const { rerender } = renderWithProviders(<RecentNoticesSection refreshSignal={1} />, {
      authValue: { session: makeSession() },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender(<RecentNoticesSection refreshSignal={2} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("API 호출이 실패해도 예외를 던지지 않고 조용히 무시한다(catch(() => {}))", async () => {
    stubApiFetch({
      "/push/recent-notices": { status: 500, body: { error: "서버 오류" } },
    });

    await act(async () => {
      renderWithProviders(<RecentNoticesSection />, { authValue: { session: makeSession() } });
      await vi.advanceTimersByTimeAsync(0);
    });

    // 실패해도 최소한 기존 렌더링(빈 목록 안내)은 그대로 유지되어야 한다.
    expect(screen.getByText("최근 전송된 알림이 없습니다.")).toBeInTheDocument();
  });
});
