import { NavLink } from "react-router-dom";
import { LayoutDashboard, Flag, ScanLine, Settings, ShieldCheck, type LucideIcon } from "lucide-react";
import { cn, ICON_STROKE } from "@/lib/utils";
import { useAuth } from "@/lib/auth/useAuth";

type Tab = {
  to: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
};

const TABS: Tab[] = [
  { to: "/", label: "대시보드", icon: LayoutDashboard },
  { to: "/report", label: "제보", icon: Flag },
  { to: "/checker", label: "체커", icon: ScanLine },
  { to: "/settings", label: "설정", icon: Settings },
  { to: "/admin", label: "관리자", icon: ShieldCheck, adminOnly: true },
];

// shadcn Tabs는 "한 화면 안 콘텐츠 전환"용이라 페이지 이동에는 의미상 맞지 않는다.
// NavLink 기반으로 직접 만든다.
export function TabBar() {
  const { session, isAdmin } = useAuth();
  if (!session) return null;

  const tabs = TABS.filter((t) => !t.adminOnly || isAdmin);

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-20 flex justify-center gap-0.5 border-t bg-card px-2.5 pb-[calc(6px+env(safe-area-inset-bottom,0px))] pt-1.5 shadow-lift sm:gap-1"
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
