import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { TabBar } from "./TabBar";
import { ThemeToggleButton } from "./ThemeToggleButton";
import { PeriodAlarmToggleButton } from "./PeriodAlarmToggleButton";
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
        "flex w-full flex-col items-center gap-4.5 px-2.5 pt-2.5 sm:px-4 sm:pt-4",
        fitToScreen
          ? "h-dvh overflow-hidden mobile-landscape:gap-2 mobile-landscape:px-2 mobile-landscape:pt-2 mobile-landscape:pb-2"
          : "min-h-dvh",
        session && fitToScreen && "mobile-portrait:pb-(--shell-pb-portrait)"
      )}
      // 🔧 [버그 수정] 원래 pb를 Tailwind 임의값 calc()(3항 이상이라
      // 클래스 자체를 못 만듦 — 배포본 CSS에 규칙 자체가 없었다)나,
      // 이를 CSS 변수로 우회한 pb-(--shell-pb)(이번엔 클래스는 생겼지만
      // sm:p-4 같은 shorthand 반응형 규칙이 항상 나중 미디어 쿼리
      // 레이어에 쌓이는 Tailwind 구조상 계속 덮어써짐)로 시도했으나
      // 둘 다 하단 고정 탭바(TabBar, 실제 높이 약 90px)가 콘텐츠 마지막
      // 줄을 가리는 문제를 해결하지 못했다(사용자 발견: "아이패드에서
      // 네비바에 아래가 가려진다"). 인라인 style은 클래스 특정성/소스
      // 순서 경쟁 자체가 없어 항상 이기므로, paddingBottom을 JS로 직접
      // 계산해 넣어 이 문제를 근본적으로 없앤다.
      style={
        {
          paddingBottom:
            session && !fitToScreen ? "calc(32px + 64px + env(safe-area-inset-bottom, 0px))" : undefined,
          "--shell-pb-portrait": "calc(32px + 64px + env(safe-area-inset-bottom, 0px))",
        } as CSSProperties
      }
    >
      {title && (
        <header className="flex w-full page-content flex-col gap-0.5">
          <div className="flex items-end justify-between gap-2">
            <div className="flex flex-col gap-0.5">
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
            </div>
            {/* 🔧 [사용자 지시] "설정의 다크모드는 메뉴를 없애고 앱의 우측
                상단에 토글 아이콘 식으로" / "교시 종소리도 앱 우측 상단의
                여백으로 만들어줘" — eyebrow 라벨 유무와 무관하게 버튼들이
                항상 h1과 같은 줄 높이에 오도록 items-end로 맞춘다. */}
            <div className="flex shrink-0 items-center gap-0.5">
              <PeriodAlarmToggleButton />
              <ThemeToggleButton />
            </div>
          </div>
        </header>
      )}
      {children}
      <div className={cn(fitToScreen && "mobile-landscape:hidden")}>
        <TabBar />
      </div>
    </div>
  );
}
