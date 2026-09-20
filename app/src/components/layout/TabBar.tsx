import { NavLink } from "react-router-dom";
import { LayoutDashboard, Flag, Bell, ScanLine, Settings, ShieldCheck, MessageCircle, ChevronDown, type LucideIcon } from "lucide-react";
import { cn, ICON_STROKE } from "@/lib/utils";
import { useAuth } from "@/lib/auth/useAuth";
import { useUnreadNotificationCount } from "@/lib/notifications/notifications";
import type { ViewportRect } from "@/hooks/useKeyboardInset";
import { useSafeAreaInsetBottom } from "@/hooks/useKeyboardInset";

type Tab = {
  to: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
};

const TABS: Tab[] = [
  { to: "/notifications", label: "알림", icon: Bell },
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
}) {
  const { session, isAdmin, isCoReviewer } = useAuth();
  const unreadCount = useUnreadNotificationCount();
  // 🔧 [버그 수정, 2026-09-20 사용자 지시: "네비바 하단에 여백이
  // 가득한데"] — 이 상수가 순수 하드코딩(89, env=0이던 시절의
  // pt-1.5+콘텐츠+pb-22px 실측 합)이던 시절엔 실제
  // env(safe-area-inset-bottom)을 반영하지 못해, 위 pb-[calc(...)] (CSS,
  // 브라우저가 자동으로 정확히 계산)와 이 JS 상수(수동으로 맞춰야 함)
  // 사이에 정합성이 계속 깨졌다(이번에도 pb를 22→8로 줄였는데 이 값을
  // 안 고쳤으면 다시 어긋날 뻔했다). "env가 0이었을 때의 순수 부분"만
  // 분리해 하드코딩하고(89 - 기존 pb 22 + 새 pb 8 = 75), 실제
  // 안전영역은 훅으로 실측해 더한다 — 이제 이 값은 항상 위 className의
  // 계산식과 자동으로 일치한다. 훅은 조건부 return(!session) 이전에
  // 호출해야 하므로 여기 최상단에 둔다.
  const safeAreaInsetBottom = useSafeAreaInsetBottom();
  if (!session) return null;

  // 🔧 2026-09: 부스터디장(공동 검토자)도 "관리자" 탭을 볼 수 있다 —
  // 실제로 들어가면 AdminPage가 "송출 P 대상 처리"만 제한적으로 보여준다.
  const tabs = TABS.filter((t) => !t.adminOnly || isAdmin || isCoReviewer);
  const tabBarHeight = 75 + safeAreaInsetBottom; // 실측 순수 높이(pt-1.5 + 콘텐츠 + pb-8px) + 실측 안전영역.

  return (
    <nav
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
      // env와 별개로 필요한 순수 여백이 아니었으므로, 이제 env가 실제
      // 홈 인디케이터 영역을 정확히 알려주는 지금은 최소한의 시각적
      // 여백(8px)만 남기고 나머지는 실측 안전영역에 맡긴다.
      className={cn(
        "fixed inset-x-0 z-20 flex justify-center gap-0.5 border-t bg-card px-2.5 pt-1.5 shadow-lift sm:gap-1",
        viewportRect ? "pb-0" : "bottom-0 pb-[calc(8px+env(safe-area-inset-bottom,0px))]"
      )}
      style={viewportRect ? { top: viewportRect.top + viewportRect.height - tabBarHeight } : undefined}
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
        const showUnreadHint = tab.to === "/notifications" && unreadCount > 0;
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
            {({ isActive }) => (
              <>
                <span className="relative flex">
                  <Icon
                    className={cn(
                      "size-5.5 shrink-0 sm:size-5",
                      // 🔧 2026-09: 안 읽은 알림이 있을 때 탭바를 훑다가도
                      // 눈에 띄도록 아이콘 자체에 은은한 펄스 + 글로우를
                      // 건다. 이미 그 화면을 보고 있는 동안(isActive)까지
                      // 계속 흔들리면 오히려 거슬리므로 그때는 끈다.
                      showUnreadHint && !isActive && "animate-notif-pulse text-primary"
                    )}
                    strokeWidth={ICON_STROKE.default}
                  />
                  {showUnreadHint && (
                    <span className="absolute -top-0.5 -right-1 flex size-2.25">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
                      <span className="relative inline-flex size-2.25 rounded-full bg-destructive ring-2 ring-card" />
                    </span>
                  )}
                </span>
                <span className="max-w-full truncate text-micro font-semibold sm:text-sm">{tab.label}</span>
              </>
            )}
          </NavLink>
        );
      })}
    </nav>
  );
}
