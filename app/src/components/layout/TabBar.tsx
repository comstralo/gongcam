import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth/useAuth";

type Tab = {
  to: string;
  label: string;
  icon: string;
  adminOnly?: boolean;
};

const TABS: Tab[] = [
  { to: "/", label: "대시보드", icon: "🏠" },
  { to: "/report", label: "제보", icon: "🚩" },
  { to: "/checker", label: "체커", icon: "📐" },
  { to: "/settings", label: "설정", icon: "⚙️" },
  { to: "/admin", label: "관리자", icon: "🛠️", adminOnly: true },
];

// shadcn Tabs는 "한 화면 안 콘텐츠 전환"용이라 페이지 이동에는 의미상 맞지 않는다.
// NavLink 기반으로 직접 만든다.
export function TabBar() {
  const { session, isAdmin } = useAuth();
  if (!session) return null;

  const tabs = TABS.filter((t) => !t.adminOnly || isAdmin);

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-20 flex gap-0.5 border-t bg-card px-2.5 pb-[calc(6px+env(safe-area-inset-bottom,0px))] pt-1.5"
      aria-label="하단 탭 메뉴"
    >
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.to === "/"}
          className={({ isActive }) =>
            cn(
              "flex min-h-13 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg p-1 text-muted-foreground transition-colors",
              isActive && "text-primary"
            )
          }
        >
          <span aria-hidden="true" className="text-xl leading-none">
            {tab.icon}
          </span>
          <span className="max-w-full truncate text-[10px] font-semibold">{tab.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
