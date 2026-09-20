import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronUp } from "lucide-react";
import { TabBar } from "./TabBar";
import { ThemeToggleButton } from "./ThemeToggleButton";
import { PeriodAlarmToggleButton } from "./PeriodAlarmToggleButton";
import { LinksHeaderButton } from "./LinksHeaderButton";
import { useAuth } from "@/lib/auth/useAuth";
import { useVisualViewportRect } from "@/hooks/useKeyboardInset";
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
  /**
   * 🔧 [사용자 지시, 2026-09-20] "채팅 화면에서는 하단 네비바를 숨김
   * 처리 할 수 있어? 접힌 상태를 아이콘으로 표시하고 누르면 다시 복구
   * 되도록" — 채팅처럼 메시지 입력창까지 세로 공간이 빠듯한 화면에서만
   * 켜는 옵트인. 지정하면 TabBar 대신 작게 접힌 원형 토글 버튼(위쪽
   * 화살표) 하나만 하단에 남기고, 누르면 TabBar가 다시 펼쳐진다.
   * 상태 자체는 App.tsx(MainViews)가 소유한다 — ChatPage도 이 접힘
   * 여부에 맞춰 자기 높이 계산을 함께 조정해야 해서(탭바가 접힌 만큼
   * 채팅 영역이 더 커져야 자연스러움), 두 컴포넌트가 형제 관계인 이상
   * 상태를 여기 로컬로 두면 공유할 방법이 없다.
   */
  collapsibleTabBar?: { collapsed: boolean; onCollapsedChange: (collapsed: boolean) => void };
};

export function AppShell({
  children,
  title,
  titleIcon: TitleIcon,
  hideEyebrow,
  fitToScreen,
  collapsibleTabBar,
}: AppShellProps) {
  const { session } = useAuth();
  const tabBarCollapsed = collapsibleTabBar?.collapsed ?? false;
  // 🔧 [사용자 지시, 2026-09-20] "키보드 입력 상태에서 ^ 표시가 보이는것도
  // 이상하고" — 이 접기 버튼(펼치기 힌트)이 fixed bottom:0(레이아웃
  // 뷰포트 기준)이라, 키보드가 떠도 레이아웃 뷰포트 자체는 안 줄어드는
  // iOS 표준 동작과 무관하게 iOS Safari가 fixed 요소를 실제로는
  // 키보드 위(visualViewport 근처)까지 끌어올려 그리는 특성이 있어
  // (또 다른 iOS 고유 동작 — ChatPage.tsx가 채팅 컨테이너 자체를
  // position:fixed + visualViewport 좌표로 재구성한 것과 같은 종류의
  // 문제), 실측 결과 이 버튼이 화면 밖으로 사라지지 않고 오히려 입력창
  // 바로 아래에 붙어 보였다. collapsibleTabBar가 켜진 화면(현재는
  // 채팅 하나뿐)에서만 이 버튼도 채팅 컨테이너와 동일하게
  // visualViewport 좌표를 직접 계산해, 키보드가 뜨면 확실히 화면
  // 밖으로 사라지고 없을 때는 확실히 화면 최하단에 붙게 한다.
  const viewportRect = useVisualViewportRect();

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
        "flex w-full flex-col items-center gap-4.5 px-2.5 sm:px-4 page-pt-safe",
        fitToScreen
          ? "mobile-landscape:h-dvh mobile-landscape:overflow-hidden mobile-landscape:gap-2 mobile-landscape:px-2 mobile-landscape:pt-2 mobile-landscape:pb-2"
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
      // 🔧 [사용자 발견] "아이폰에서 좌측 상단이 흐릿하게 나온다" — 상단
      // safe-area 처리는 index.css의 page-pt-safe 유틸리티(className)로
      // 옮겼다 — sm: 반응형 분기가 필요해 순수 인라인 style로는 표현이
      // 안 됐다(sm:pt-4가 media query 필요).
      style={
        {
          paddingBottom:
            session && !fitToScreen
              ? collapsibleTabBar && tabBarCollapsed
                ? "calc(32px + 40px + env(safe-area-inset-bottom, 0px))"
                : "calc(32px + 64px + env(safe-area-inset-bottom, 0px))"
              : undefined,
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
              <h1 className="flex items-center gap-2 text-xl font-semibold sm:text-2xl">
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
              <LinksHeaderButton />
              <ThemeToggleButton />
            </div>
          </div>
        </header>
      )}
      {children}
      {collapsibleTabBar && tabBarCollapsed ? (
        // 🔧 [사용자 지시, 2026-09-20] "접힌 상태를 아이콘으로 표시하고
        // 누르면 다시 복구되도록" — TabBar 자리를 완전히 비우지 않고
        // 같은 위치(fixed bottom)에 작은 원형 버튼 하나만 남겨, 탭바가
        // "숨겨졌을 뿐 여전히 여기 있다"는 걸 알 수 있게 한다.
        <button
          type="button"
          onClick={() => collapsibleTabBar.onCollapsedChange(false)}
          aria-label="하단 탭 메뉴 펼치기"
          title="하단 탭 메뉴 펼치기"
          // 🔧 [사용자 지시, 2026-09-20] "기호를 좀 더 아래로 내리고
          // 원형 아이콘 말고 ^ 기호로만 구현해줘 — 버튼이 커서 네비바를
          // 숨긴 의미가 퇴색되고 있어" — 이전엔 원형 배경(size-9,
          // border+bg-card+shadow-lift)을 가진 버튼이라 그 배경 자체가
          // 차지하는 공간(36px + 상하 여백)이 작지 않아, "탭바를 접어
          // 채팅 영역을 넓힌다"는 목적과 상충됐다. 배경/테두리/그림자를
          // 모두 없애고 순수 셰브런 문자만 남겨(히트박스는 실제 접근성을
          // 위해 padding으로 충분히 확보하되 시각적으로는 아이콘만
          // 보이게) 차지하는 실제 화면 높이를 최소화한다.
          // 🔧 [버그 수정] bottom:0(레이아웃 뷰포트 기준)은 iOS Safari가
          // fixed 요소를 실제로는 키보드 위(visualViewport 근처)까지
          // 끌어올려 그리는 특성 때문에, 키보드가 떠도 화면 밖으로
          // 사라지지 않고 입력창 바로 아래에 걸쳐 보였다(실측). top을
          // viewportRect 기준으로 직접 계산해 항상 "지금 화면의 실제
          // 맨 아래"에 오도록 고정한다 — viewportRect가 아직 없으면
          // (초기 렌더/구형 브라우저) 기존 bottom:0으로 폴백.
          className={cn(
            "fixed inset-x-0 z-20 mx-auto flex justify-center text-muted-foreground",
            !viewportRect && "bottom-0 pb-[calc(4px+env(safe-area-inset-bottom,0px))]"
          )}
          style={
            viewportRect
              ? { top: viewportRect.top + viewportRect.height - 28 }
              : undefined
          }
        >
          {/* 🔧 [사용자 지시, 2026-09-20] "네비바가 접혔다는걸 알도록
              힌트 효과를 줄 수 있을까?" — 버튼을 최소화하면서 옅어진
              존재감을 보완한다. 이 button 엘리먼트 자체는 tabBarCollapsed
              분기(TabBar와 삼항으로 나뉨)가 true가 될 때마다 새로
              마운트되므로, 별도 상태 없이 이 아이콘의 animate-
              collapse-hint 클래스가 접을 때마다 자동으로 재생된다(유한
              반복이라 몇 번 튕긴 뒤 스스로 멈춘다 — index.css 참고). */}
          <ChevronUp className="size-5 animate-collapse-hint" strokeWidth={ICON_STROKE.default} />
        </button>
      ) : (
        <div className={cn(fitToScreen && "mobile-landscape:hidden")}>
          <TabBar
            collapseButton={
              collapsibleTabBar && {
                onClick: () => collapsibleTabBar.onCollapsedChange(true),
              }
            }
            viewportRect={collapsibleTabBar ? viewportRect : undefined}
          />
        </div>
      )}
    </div>
  );
}
