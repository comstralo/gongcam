import { useState } from "react";
import { NavLink } from "react-router-dom";
import { LayoutDashboard, Flag, ScanLine, Settings, ShieldCheck, MessageCircle, ChevronDown, type LucideIcon } from "lucide-react";
import { cn, ICON_STROKE } from "@/lib/utils";
import { useAuth } from "@/lib/auth/useAuth";
import { useResizeObserver } from "@/hooks/useResizeObserver";
import type { ViewportRect } from "@/hooks/useKeyboardInset";

type Tab = {
  to: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
};

const TABS: Tab[] = [
  { to: "/", label: "대시보드", icon: LayoutDashboard },
  { to: "/report", label: "제보", icon: Flag },
  { to: "/chat", label: "채팅", icon: MessageCircle },
  { to: "/checker", label: "체커", icon: ScanLine },
  { to: "/settings", label: "설정", icon: Settings },
  { to: "/admin", label: "관리자", icon: ShieldCheck, adminOnly: true },
];

// shadcn Tabs는 "한 화면 안 콘텐츠 전환"용이라 페이지 이동에는 의미상 맞지 않는다.
// NavLink 기반으로 직접 만든다.
// 🔧 [사용자 지시, 2026-09-20] "접는 버튼을 아예 네비바에 내장시키고
// 싶은거야. 상단 경계쪽에 표시되도록" — 채팅 화면(AppShell의
// collapsibleTabBar)에서만 쓰는 "탭바 접기" 버튼을, TabBar 바깥에서
// 별도 relative wrapper로 얹으려 했더니 TabBar 자신이
// position:fixed라 그 wrapper가 문서 흐름에 기여할 콘텐츠 크기가
// 없어(fixed 자식은 부모의 레이아웃 크기에 기여하지 않음) 0×0으로
// 접혀버렸다(실측: getBoundingClientRect width/height 모두 0). TabBar
// 자신은 fixed여도 스스로는 absolute 자식의 위치 기준(containing
// block)이 될 수 있으므로, 이 nav 안에 버튼을 직접 내장시켜(선택적 prop)
// nav의 상단 테두리(border-t) 경계에 걸치도록 배치한다.
export function TabBar({
  collapseButton,
  viewportRect,
  onHeightChange,
}: {
  collapseButton?: { onClick: () => void };
  /**
   * 🔧 [버그 수정, 2026-09-20 사용자 지시: "키보드 입력 상태에서 ^
   * 표시가 보이는것도 이상하고"] — fixed bottom:0(레이아웃 뷰포트
   * 기준)은 iOS Safari가 fixed 요소를 실제로는 키보드 위(visualViewport
   * 근처)까지 끌어올려 그리는 특성 때문에, 키보드가 떠도 이 탭바가
   * 화면 밖으로 사라지지 않고 입력창 근처에 걸쳐 보였다(ChatPage
   * 실측). collapsibleTabBar를 쓰는 화면(현재 채팅)에서만 이 값을
   * 넘겨 bottom 대신 visualViewport 기준 top을 직접 계산한다 — 다른
   * 페이지는 그런 문제가 없어 생략하면 기존 bottom:0 그대로 동작한다.
   */
  viewportRect?: ViewportRect | null;
  /**
   * 🔧 [버그 수정, 2026-09-20 사용자 지시: "채팅에서는 여전히 네비바
   * 위치가 이상해"] — 이 탭바의 실제 화면 상 총 높이(v버튼이 nav
   * 경계 위로 튀어나온 부분까지 포함)를 ChatPage가 매직넘버로
   * 추측해왔는데(85px, 안전영역을 EnvSafeAreaBottom 훅으로 별도 실측
   * 후 더함), TabBar 자신의 padding/env 계산이 바뀔 때마다 그
   * 추측값과 계속 어긋났다(실측 없이 몇 차례 조정해도 재발). TabBar가
   * 실제 렌더링된 자신의 높이를 ResizeObserver로 직접 측정해 콜백으로
   * 올려보내, ChatPage가 항상 "지금 이 순간 실제 렌더링된 값"만
   * 쓰게 한다 — 매직넘버 자체가 존재하지 않으므로 어긋날 여지가
   * 없다.
   */
  onHeightChange?: (height: number) => void;
}) {
  const { session, isAdmin, isCoReviewer } = useAuth();
  // 🔧 [버그 수정] navRef.current를 렌더링(JSX의 style 계산) 중에 직접
  // 읽으면 첫 렌더링 시점엔 아직 null이라 즉시 오류가 난다 — 실측값을
  // state로 보관해, ResizeObserver가 실제로 측정을 마친 뒤에야
  // top 계산에 반영되도록(그 전까지는 undefined로 기존 bottom:0
  // 동작 유지) 분리한다.
  const [navHeight, setNavHeight] = useState<number | null>(null);
  // 🔧 [리팩터, 2026-09-21 사용자 지시: "다양한 환경 대응을 위한 도구를
  // 체계적으로 적용"] — new ResizeObserver + observe/disconnect cleanup을
  // 공용 훅(useResizeObserver)으로 교체했다. collapseButton 유무에 따라
  // "nav 자신의 높이 + v버튼이 튀어나온 24px"를 더할지만 report() 안에서
  // 갈리므로, 훅 재구독 자체는 필요 없다(콜백 안에서 최신 collapseButton
  // 값을 그때그때 참조).
  const navRef = useResizeObserver<HTMLElement>((_entry, nav) => {
    const height = nav.getBoundingClientRect().height;
    setNavHeight(height);
    // 🔧 v버튼(collapseButton)이 -top-6(24px)만큼 nav 상단 경계 위로
    // 튀어나오므로, nav 자신의 높이만으로는 "화면에서 실제로 이
    // 탭바 영역 전체가 차지하는 높이"를 알 수 없다 — 버튼이 있으면
    // 그만큼(24px) 더해 보고한다.
    onHeightChange?.(height + (collapseButton ? 24 : 0));
  });

  if (!session) return null;

  // 🔧 2026-09: 부스터디장(공동 검토자)도 "관리자" 탭을 볼 수 있다 —
  // 실제로 들어가면 AdminPage가 "송출 P 대상 처리"만 제한적으로 보여준다.
  const tabs = TABS.filter((t) => !t.adminOnly || isAdmin || isCoReviewer);

  return (
    <nav
      ref={navRef}
      // 🔧 2026-09: index.html의 viewport meta에 viewport-fit=cover가 없던
      // 시절엔 env(safe-area-inset-bottom)이 항상 0으로 평가돼(홈
      // 인디케이터 영역 아래로 콘텐츠를 확장하는 옵트인이 없으면 이 값
      // 자체가 없음), 실제 여백은 6px→16px→22px로 순수 하드코딩만
      // 계속 늘려왔다.
      // 🔧 [버그 수정, 2026-09-20 사용자 재보고: "네비바 하단에 여백이
      // 가득한데"] — viewport-fit=cover 추가 이후 env(safe-area-inset-
      // bottom)이 실제로 채워지면서(실측: 34px) 그 22px 위에 그대로
      // 더해져 탭 아이콘 아래로 56px(22+34)나 되는 빈 공간이 생겼다.
      // 이 22px는 애초에 "env가 항상 0이라 대신 채워 넣은 값"이었지
      // env와 별개로 필요한 순수 여백이 아니었다.
      // 🔧 [버그 수정, 2026-09-20] 8px로 줄인 뒤에도 사용자가 다른 앱
      // (마이루틴 등, 스크린샷으로 실측 비교)과 나란히 비교해보니
      // 여전히 탭 아이콘 아래 공간이 눈에 띄게 넓었다 — 참고 앱들은
      // 순수 여백을 거의 0에 가깝게 두고 실제 홈 인디케이터 안전영역
      // (env, 이미 34px로 충분히 여유로움)에만 의존한다. 순수 여백을
      // 4px까지 더 줄인다.
      // 🔧 [버그 수정, 2026-09-20 사용자 지시: "상식적으로 다른 곳
      // 네비바랑 높이가 같아야지 다르면 되겠냐?"] — 채팅 화면(viewportRect
      // 있음)만 pb-0을 써서 안전영역(env(safe-area-inset-bottom), 실측
      // 34px) 패딩이 통째로 빠져 있었다. top을 visualViewport 기준으로
      // 직접 계산하는 방식(bottom:0이 아님)으로 바뀌면서 "bottom:0
      // 기준이 아니니 안전영역 패딩도 무의미하다"고 잘못 판단해 pb-0으로
      // 처리했었는데, 실제로는 이 패딩이 있어야 navHeight(getBoundingClientRect
      // 기준 실측값)에 그만큼 반영되어 top이 위로 올라가고, 그 결과
      // 탭바가 화면 맨 끝이 아니라 다른 화면과 동일하게 안전영역 위에
      // 떠 있게 된다 — pb를 다른 화면과 완전히 통일한다.
      className="fixed inset-x-0 z-20 flex justify-center gap-0.5 border-t bg-card px-2.5 pt-1.5 pb-[calc(4px+env(safe-area-inset-bottom,0px))] shadow-lift sm:gap-1"
      style={
        viewportRect
          ? // 🔧 navHeight 실측 전(마운트 직후 첫 프레임) 잠깐은 top이
            // 없어 fixed 요소가 문서 흐름상 원래 위치로 튈 수 있으므로,
            // 그 짧은 순간엔 화면 최하단(bottom:0)에 붙여 안전하게
            // 폴백한다 — ResizeObserver가 실제 높이를 보고하는 즉시
            // top 기반 계산으로 넘어간다.
            navHeight !== null
            ? { top: viewportRect.top + viewportRect.height - navHeight }
            : { bottom: 0 }
          : { bottom: 0 }
      }
      aria-label="하단 탭 메뉴"
    >
      {collapseButton && (
        // 🔧 [버그 수정, 2026-09-20 사용자 지시: "v 표시가 너무 메시지
        // 보내기 영역이랑 붙어있어. 살짝만 띄울 필요가 있어보여"] —
        // -top-3.5(-14px)는 nav(TabBar) 상단 경계에 거의 딱 걸쳐 있어,
        // 바로 위 채팅 박스(입력창)와 시각적으로 거의 맞닿아 보였다.
        // -top-6(-24px)로 더 띄워 둘 사이에 여백을 준다.
        <button
          type="button"
          onClick={collapseButton.onClick}
          aria-label="하단 탭 메뉴 접기"
          title="하단 탭 메뉴 접기"
          className="absolute inset-x-0 -top-6 z-10 mx-auto flex justify-center text-muted-foreground"
        >
          <ChevronDown className="size-3.5" strokeWidth={ICON_STROKE.default} />
        </button>
      )}
      {tabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.to === "/"}
            className={({ isActive }) =>
              cn(
                "flex min-h-13 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg p-1 text-muted-foreground transition-colors sm:min-h-15 sm:max-w-32 sm:flex-row sm:gap-2 sm:p-2.5",
                isActive && "text-primary"
              )
            }
          >
            <Icon className="size-5.5 shrink-0 sm:size-5" strokeWidth={ICON_STROKE.default} />
            <span className="max-w-full truncate text-micro font-semibold sm:text-sm">{tab.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
