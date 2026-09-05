import { NavLink } from "react-router-dom";
import { LayoutDashboard, Flag, Bell, Link2, Settings, ShieldCheck, type LucideIcon } from "lucide-react";
import { cn, ICON_STROKE } from "@/lib/utils";
import { useAuth } from "@/lib/auth/useAuth";

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
  { to: "/links", label: "링크", icon: Link2 },
  { to: "/settings", label: "설정", icon: Settings },
  { to: "/admin", label: "관리자", icon: ShieldCheck, adminOnly: true },
];

// shadcn Tabs는 "한 화면 안 콘텐츠 전환"용이라 페이지 이동에는 의미상 맞지 않는다.
// NavLink 기반으로 직접 만든다.
export function TabBar() {
  const { session, isAdmin, isCoReviewer } = useAuth();
  if (!session) return null;

  // 🔧 2026-09: 부스터디장(공동 검토자)도 "관리자" 탭을 볼 수 있다 —
  // 실제로 들어가면 AdminPage가 "송출 P 대상 처리"만 제한적으로 보여준다.
  const tabs = TABS.filter((t) => !t.adminOnly || isAdmin || isCoReviewer);

  return (
    <nav
      // 🔧 2026-09: index.html의 viewport meta에 viewport-fit=cover가 없어
      // env(safe-area-inset-bottom)이 항상 0으로 평가된다(홈 인디케이터
      // 영역 아래로 콘텐츠를 확장하는 옵트인이 없으면 이 값 자체가 없음) —
      // 그래서 실제 여백은 6px→16px로 늘렸던 것도 여전히 부족해 보여
      // (사용자 지적) 22px로 한 번 더 늘렸다. viewport-fit=cover를
      // 추가하는 건 상단 세이프에어리어(노치/상태바) 대응까지 함께
      // 손봐야 하는 더 큰 변경이라, 우선 이 하단 여백 자체를 계속
      // 조정하는 쪽으로 처리 — env() 항은 나중에 viewport-fit=cover가
      // 추가돼도 자연히 더해지도록 그대로 남겨둔다.
      className="fixed inset-x-0 bottom-0 z-20 flex justify-center gap-0.5 border-t bg-card px-2.5 pb-[calc(22px+env(safe-area-inset-bottom,0px))] pt-1.5 shadow-lift sm:gap-1"
      aria-label="하단 탭 메뉴"
    >
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
