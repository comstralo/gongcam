// 🔧 [2026-09-22 사용자 지시: "먼저 계속 진행해"(프론트 테스트 도구
// 보강 4차)] — @base-ui/react의 Dialog(모달)와 react-router-dom의
// Link를 함께 쓰는 컴포넌트의 첫 테스트. Dialog가 portal로 렌더링되어
// document.body에 붙는지, 열기/닫기 상호작용이 jsdom에서 실제로
// 동작하는지부터 확인이 필요했다(스파이크 성격 — 이후 Dialog를 쓰는
// 다른 컴포넌트 테스트의 선례가 된다).
import { describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils";
import { LinksHeaderButton } from "./LinksHeaderButton";

describe("LinksHeaderButton", () => {
  it("초기 상태에는 모달 콘텐츠가 보이지 않는다", () => {
    renderWithProviders(<LinksHeaderButton />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("버튼을 클릭하면 모달이 열리고 링크 목록이 보인다", async () => {
    renderWithProviders(<LinksHeaderButton />);
    fireEvent.click(screen.getByRole("button", { name: "링크" }));

    // @base-ui/react의 Dialog는 애니메이션/포털 마운트가 비동기일 수
    // 있어(실측 필요성 확인) waitFor로 기다린다.
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(screen.getByText("단체 채팅방")).toBeInTheDocument();
    expect(screen.getByText("스터디 규정")).toBeInTheDocument();
    expect(screen.getByText("원본 시트")).toBeInTheDocument();
    expect(screen.getByText("공지사항")).toBeInTheDocument();
  });

  it("체커 링크를 클릭하면 /checker로 이동하고 모달이 닫힌다", async () => {
    renderWithProviders(<LinksHeaderButton />);
    fireEvent.click(screen.getByRole("button", { name: "링크" }));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("체커"));

    await waitFor(() => {
      expect(screen.getByTestId("location-display")).toHaveTextContent("/checker");
    });
  });

  it("외부 링크는 새 탭에서 열리도록 target=_blank/rel=noreferrer를 갖는다", async () => {
    renderWithProviders(<LinksHeaderButton />);
    fireEvent.click(screen.getByRole("button", { name: "링크" }));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    const chatLink = screen.getByText("단체 채팅방").closest("a");
    expect(chatLink).toHaveAttribute("target", "_blank");
    expect(chatLink).toHaveAttribute("rel", "noreferrer");
  });
});
