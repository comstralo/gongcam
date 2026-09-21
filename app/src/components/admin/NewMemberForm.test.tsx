// 🔧 [2026-09-22 사용자 지시: "먼저 프론트엔드 테스트부터 완성하고
// 푸시할게. 계속 진행해"(프론트 테스트 도구 보강 6차, 첫 폼 제출
// 컴포넌트)] — 이 폼은 마운트 시 두 API를 병행 조회(open-slots,
// blacklist)하고, 입력값을 실시간으로 블랙리스트와 대조하며, 제출
// 시 성공/재인증 필요/네트워크 오류 세 갈래로 갈린다. @base-ui/react
// 의 Select(드롭다운)는 fireEvent.click만으로는 onValueChange가
// 호출되지 않음을 스파이크로 확인했다(pointerdown/up 이벤트 시퀀스가
// 필요) — @testing-library/user-event를 도입해 실제 사용자 상호작용에
// 더 가깝게 재현한다.
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, stubApiFetch, makeSession } from "@/test-utils";
import { NewMemberForm } from "./NewMemberForm";
import type {
  AdminBlacklistResponse,
  AdminOpenSlotsResponse,
  CreateMemberResponse,
} from "@/lib/api/types";

function stubInitialLoad(overrides?: {
  slots?: string[];
  blacklist?: AdminBlacklistResponse["entries"];
}) {
  return stubApiFetch({
    "/admin/open-slots": { body: { slots: overrides?.slots ?? ["12", "15"] } satisfies AdminOpenSlotsResponse },
    "/admin/blacklist": { body: { entries: overrides?.blacklist ?? [] } satisfies AdminBlacklistResponse },
  });
}

// 필수 필드(이름/이메일/구루미 계정/준비 시험)를 채우는 공용 헬퍼 —
// 시트 번호/참여 유형/첫 참여일은 이미 기본값이 채워져 있어 건드릴
// 필요가 없다(number는 open-slots 로드 후 자동으로 첫 항목이 선택됨).
async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("이름"), "홍길동");
  await user.type(screen.getByLabelText("구글 계정"), "hong@example.com");
  await user.type(screen.getByLabelText("구루미 계정"), "hong-g@example.com");
  await user.type(screen.getByLabelText("준비 시험"), "공시");
}

describe("NewMemberForm", () => {
  it("마운트되면 빈 자리 목록을 불러와 첫 번째 슬롯을 기본 선택한다", async () => {
    stubInitialLoad({ slots: ["12", "15"] });
    renderWithProviders(<NewMemberForm />, { authValue: { session: makeSession() } });

    await waitFor(() => {
      expect(screen.getByText("12번")).toBeInTheDocument();
    });
  });

  it("빈 자리가 없으면 시트 번호 선택을 비활성화하고 '빈 자리 없음'을 보여준다", async () => {
    stubInitialLoad({ slots: [] });
    renderWithProviders(<NewMemberForm />, { authValue: { session: makeSession() } });

    await waitFor(() => {
      expect(screen.getByText("빈 자리 없음")).toBeInTheDocument();
    });
  });

  it("빈 자리 조회가 실패하면 에러 메시지를 보여준다", async () => {
    stubApiFetch({
      "/admin/open-slots": { status: 500, body: { error: "시트 조회 실패" } },
      "/admin/blacklist": { body: { entries: [] } satisfies AdminBlacklistResponse },
    });
    renderWithProviders(<NewMemberForm />, { authValue: { session: makeSession() } });

    await waitFor(() => {
      expect(screen.getByText("시트 조회 실패")).toBeInTheDocument();
    });
  });

  it("입력한 구글 계정이 블랙리스트와 일치하면 경고를 보여준다", async () => {
    const user = userEvent.setup();
    stubInitialLoad({
      blacklist: [{ name: "김철수", googleAccount: "blocked@example.com", gooroomeeAccount: "" }],
    });
    renderWithProviders(<NewMemberForm />, { authValue: { session: makeSession() } });

    await waitFor(() => {
      expect(screen.getByText("12번")).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText("구글 계정"), "blocked@example.com");

    expect(screen.getByText(/블랙리스트로 등록된 스터디원/)).toBeInTheDocument();
    expect(screen.getByLabelText("구글 계정")).toHaveAttribute("aria-invalid", "true");
  });

  it("대소문자가 달라도 블랙리스트 이메일을 정확히 매칭한다", async () => {
    const user = userEvent.setup();
    stubInitialLoad({
      blacklist: [{ name: "김철수", googleAccount: "blocked@example.com", gooroomeeAccount: "" }],
    });
    renderWithProviders(<NewMemberForm />, { authValue: { session: makeSession() } });
    await waitFor(() => {
      expect(screen.getByText("12번")).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText("구글 계정"), "BLOCKED@EXAMPLE.COM");
    expect(screen.getByText(/블랙리스트로 등록된 스터디원/)).toBeInTheDocument();
  });

  it("필수 필드를 모두 채우기 전에는 등록 버튼이 비활성화된다", async () => {
    stubInitialLoad();
    renderWithProviders(<NewMemberForm />, { authValue: { session: makeSession() } });
    await waitFor(() => {
      expect(screen.getByText("12번")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "등록하기" })).toBeDisabled();
  });

  it("모든 필수 필드를 채우면 등록 버튼이 활성화되고, 제출하면 성공 메시지를 보여준다", async () => {
    const user = userEvent.setup();
    // 🔧 open-slots/blacklist/members 세 경로를 처음부터 함께 등록해둔다
    // — stubApiFetch(vi.stubGlobal 기반)를 나중에 다시 호출하면 fetch
    // 자체가 완전히 새 mock으로 교체되어 이전 호출 기록(초기 로드 검증에
    // 쓸 수 있는)까지 함께 사라지므로, 처음부터 필요한 경로를 전부
    // 등록해두는 편이 더 명확하다.
    stubApiFetch({
      "/admin/open-slots": { body: { slots: ["12"] } satisfies AdminOpenSlotsResponse },
      "/admin/blacklist": { body: { entries: [] } satisfies AdminBlacklistResponse },
      "/admin/members": {
        body: { ok: true, number: "12", name: "홍길동", email: "hong@example.com" } satisfies CreateMemberResponse,
      },
    });
    renderWithProviders(<NewMemberForm />, { authValue: { session: makeSession() } });
    await waitFor(() => {
      expect(screen.getByText("12번")).toBeInTheDocument();
    });

    await fillRequiredFields(user);
    expect(screen.getByRole("button", { name: "등록하기" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "등록하기" }));

    await waitFor(() => {
      expect(screen.getByText("홍길동님(12번)이 등록되었습니다.")).toBeInTheDocument();
    });
  });

  it("제출 후 폼이 초기화된다(이름 입력값이 비워짐)", async () => {
    const user = userEvent.setup();
    stubInitialLoad({ slots: ["12"] });
    renderWithProviders(<NewMemberForm />, { authValue: { session: makeSession() } });
    await waitFor(() => {
      expect(screen.getByText("12번")).toBeInTheDocument();
    });
    await fillRequiredFields(user);

    stubApiFetch({
      "/admin/open-slots": { body: { slots: ["12"] } satisfies AdminOpenSlotsResponse },
      "/admin/blacklist": { body: { entries: [] } satisfies AdminBlacklistResponse },
      "/admin/members": {
        body: { ok: true, number: "12", name: "홍길동", email: "hong@example.com" } satisfies CreateMemberResponse,
      },
    });
    await user.click(screen.getByRole("button", { name: "등록하기" }));

    await waitFor(() => {
      const nameInput = screen.getByLabelText("이름") as HTMLInputElement;
      expect(nameInput.value).toBe("");
    });
  });

  it("시트 번호 드롭다운에서 다른 슬롯을 선택하면 제출 요청에 그 값이 담긴다", async () => {
    // 🔧 @base-ui/react의 Select는 fireEvent.click만으로는
    // onValueChange가 호출되지 않음을 스파이크로 확인했다(내부적으로
    // pointerdown/up 이벤트 시퀀스에 반응) — user.click()이 이 시퀀스를
    // 실제로 재현해준다. combobox에 접근 가능한 이름이 없어(스파이크로
    // 확인: aria-label 없음, 텍스트만 "8시간 교시제"/"12번") 렌더링
    // 순서상 두 번째(인덱스 1)가 시트 번호 드롭다운이다.
    const user = userEvent.setup();
    stubInitialLoad({ slots: ["12", "15"] });
    renderWithProviders(<NewMemberForm />, { authValue: { session: makeSession() } });
    await waitFor(() => {
      expect(screen.getByText("12번")).toBeInTheDocument();
    });
    await fillRequiredFields(user);

    const [, numberCombobox] = screen.getAllByRole("combobox");
    await user.click(numberCombobox);
    await user.click(await screen.findByRole("option", { name: "15번" }));

    const { fetchMock } = stubApiFetch({
      "/admin/open-slots": { body: { slots: ["12", "15"] } satisfies AdminOpenSlotsResponse },
      "/admin/blacklist": { body: { entries: [] } satisfies AdminBlacklistResponse },
      "/admin/members": {
        body: { ok: true, number: "15", name: "홍길동", email: "hong@example.com" } satisfies CreateMemberResponse,
      },
    });
    await user.click(screen.getByRole("button", { name: "등록하기" }));

    await waitFor(() => {
      expect(screen.getByText("홍길동님(15번)이 등록되었습니다.")).toBeInTheDocument();
    });
    const submitCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/admin/members"));
    expect(submitCall).toBeDefined();
    const body = JSON.parse((submitCall![1] as RequestInit).body as string);
    expect(body.number).toBe("15");
  });

  it("Drive 권한 부여가 실패하면(needsReauth) 재시도 버튼과 안내 문구를 보여주고 새 창을 연다", async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    stubInitialLoad({ slots: ["12"] });
    renderWithProviders(<NewMemberForm />, { authValue: { session: makeSession({ token: "sess-tok" }) } });
    await waitFor(() => {
      expect(screen.getByText("12번")).toBeInTheDocument();
    });
    await fillRequiredFields(user);

    stubApiFetch({
      "/admin/open-slots": { body: { slots: ["12"] } satisfies AdminOpenSlotsResponse },
      "/admin/blacklist": { body: { entries: [] } satisfies AdminBlacklistResponse },
      "/admin/members": {
        body: {
          ok: true,
          number: "12",
          name: "홍길동",
          email: "hong@example.com",
          needsReauth: true,
        } satisfies CreateMemberResponse,
      },
    });
    await user.click(screen.getByRole("button", { name: "등록하기" }));

    await waitFor(() => {
      expect(screen.getByText(/Drive 편집자 권한 부여에 실패했습니다/)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "hong@example.com 권한 다시 부여하기" })).toBeInTheDocument();
    expect(openSpy).toHaveBeenCalledWith(expect.stringContaining("sess-tok"), "_blank", "noreferrer");

    openSpy.mockRestore();
  });

  it("이메일/구루미 계정에 쉼표가 포함되면 제출 전에 클라이언트에서 막는다", async () => {
    const user = userEvent.setup();
    const { fetchMock } = stubInitialLoad({ slots: ["12"] });
    renderWithProviders(<NewMemberForm />, { authValue: { session: makeSession() } });
    await waitFor(() => {
      expect(screen.getByText("12번")).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText("이름"), "홍길동");
    await user.type(screen.getByLabelText("구글 계정"), "hong,evil@example.com");
    await user.type(screen.getByLabelText("구루미 계정"), "hong-g@example.com");
    await user.type(screen.getByLabelText("준비 시험"), "공시");

    const callsBefore = fetchMock.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "등록하기" }));

    expect(screen.getByText("이메일/구루미 계정에는 쉼표를 포함할 수 없습니다.")).toBeInTheDocument();
    // 유효성 검사 실패는 서버 요청 자체를 만들지 않아야 한다.
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });
});
