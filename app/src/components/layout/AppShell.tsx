import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { TabBar } from "./TabBar";
import { useAuth } from "@/lib/auth/useAuth";
import { cn, ICON_STROKE } from "@/lib/utils";

type AppShellProps = {
  children: ReactNode;
  /** 지정하면 표준 헤더("공부합시당 캠스터디" 라벨 + 제목)를 렌더링한다. 페이지가 자체 헤더를 그릴 경우 생략. */
  title?: string;
  /** 지정하면 제목 좌측에 아이콘을 함께 표시한다. */
  titleIcon?: LucideIcon;
  /** true면 title은 유지하되 상단 "공부합시당 캠스터디" 라벨을 생략한다. */
  hideEyebrow?: boolean;
  /**
   * true면 화면 높이를 정확히 고정하고(min-height 대신 height), 가로 모드에서
   * 하단 탭바를 숨기고 좌우 여백/패딩을 줄인다. 체커처럼 콘텐츠가 뷰포트
   * 안에 정확히 맞아 들어가야 하는(내부에서 flex-1로 남는 공간을 계산하는)
   * 페이지 전용 — 일반 페이지는 콘텐츠가 넘치면 자연스럽게 스크롤되어야 하므로
   * 사용하지 않는다.
   */
  fitToScreen?: boolean;
};

export function AppShell({ children, title, titleIcon: TitleIcon, hideEyebrow, fitToScreen }: AppShellProps) {
  const { session } = useAuth();

  return (
    <div
      className={cn(
        // 🔧 [모바일 가독성] 좌우 여백이 AppShell(여기)+SectionCard(내부
        // p-3.5)+개별 카드(p-3)로 세 겹 겹쳐, 375px 화면에서 실제 텍스트
        // 폭이 300px 아래로 줄어들며 폰트/뱃지 가독성이 떨어졌다(사용자
        // 지적, Playwright MCP 모바일 점검에서 실측). 카드 내부 여백은
        // 시각적 구분을 위해 그대로 두고, 가장 바깥 여백만 모바일에서
        // 좁혀 실사용 폭을 확보한다 — sm 이상(태블릿/데스크톱)은 기존
        // p-4 그대로 유지.
        "flex w-full flex-col items-center gap-4.5 p-2.5 sm:p-4",
        fitToScreen ? "h-dvh overflow-hidden mobile-landscape:gap-2 mobile-landscape:p-2" : "min-h-dvh",
        session && !fitToScreen && "pb-[calc(32px+64px+env(safe-area-inset-bottom,0px))]",
        session &&
          fitToScreen &&
          "mobile-portrait:pb-[calc(32px+64px+env(safe-area-inset-bottom,0px))] mobile-landscape:pb-2"
      )}
    >
      {title && (
        <header className="flex w-full page-content flex-col gap-0.5">
          {!hideEyebrow && (
            <span className="text-xs font-semibold tracking-tight text-primary sm:text-sm">
              공부합시당 캠스터디
            </span>
          )}
          <h1 className="flex items-center gap-2 text-xl font-bold sm:text-2xl">
            {TitleIcon && (
              <TitleIcon className="size-5 text-primary sm:size-6" strokeWidth={ICON_STROKE.default} />
            )}
            {title}
          </h1>
        </header>
      )}
      {children}
      <div className={cn(fitToScreen && "mobile-landscape:hidden")}>
        <TabBar />
      </div>
    </div>
  );
}
