import { useEffect, useRef, useState } from "react";
import { HashRouter, Routes, Route, useLocation, Navigate } from "react-router-dom";
import { LayoutDashboard, ScanLine, Bell, Settings, ShieldCheck, MessageCircle } from "lucide-react";
import { AuthProvider } from "@/lib/auth/AuthContext";
import { useAuth } from "@/lib/auth/useAuth";
import { MyStatusProvider } from "@/lib/status/MyStatusContext";
import { PeriodAlarmProvider } from "@/lib/periodAlarm/PeriodAlarmContext";
import { AdminDeniedCard } from "@/lib/auth/AdminDeniedCard";
import { AppShell } from "@/components/layout/AppShell";
import { PullToRefreshIndicator } from "@/components/layout/PullToRefreshIndicator";
import { IdleOverlay } from "@/components/layout/IdleOverlay";
import { LoginPage } from "@/pages/LoginPage";
import { CheckerPage } from "@/pages/CheckerPage";
import { ReportPage } from "@/pages/ReportPage";
import { ChatPage } from "@/pages/ChatPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { NotificationsPage } from "@/pages/NotificationsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { AdminPage } from "@/pages/AdminPage";
import { useVersionCheck } from "@/hooks/useVersionCheck";

type MainView = "/" | "/report" | "/chat" | "/notifications" | "/settings" | "/admin";
const MAIN_VIEWS: MainView[] = ["/", "/report", "/chat", "/notifications", "/settings", "/admin"];

// 로그인 후 오가는 5개 메인 페이지(대시보드/제보/링크/설정/관리자)는 예전
// react-router <Routes>처럼 경로가 바뀔 때마다 언마운트/재마운트되면, 각
// 페이지 내부의 캐시 방지 로직(everOpened 등)이 아무리 잘 되어 있어도
// "그 페이지를 떠났다가 돌아오는" 순간 전부 무의미해진다 — 페이지 자체가
// 통째로 다시 마운트되어 useEffect(load, [])가 전부 재실행되기 때문이다.
// 2026-08 실측: 여러 페이지를 빠르게 오가기만 해도 시트 읽기가 40회 이상
// 치솟음(서버 쪽 1분 캐시가 아직 안 끝났는데도 재조회가 발생). AdminPage/
// DashboardPage 안에서 이미 쓰던 것과 같은 원리로, 한 번이라도 방문한
// 메인 페이지는 hidden으로만 감추고 계속 마운트 상태로 남긴다.
function MainViews() {
  const location = useLocation();
  const { session, isAdmin, isCoReviewer } = useAuth();
  const path = location.pathname as MainView;
  const everVisited = useRef<Record<MainView, boolean>>({
    "/": false,
    "/report": false,
    "/chat": false,
    "/notifications": false,
    "/settings": false,
    "/admin": false,
  });
  if (MAIN_VIEWS.includes(path)) everVisited.current[path] = true;
  // 🔧 [사용자 지시, 2026-09-20] "채팅 화면에서는 하단 네비바를 숨김
  // 처리 할 수 있어?" — 접힘 상태를 AppShell(탭바 자체를 그리는 쪽)과
  // ChatPage(탭바가 접힌 만큼 자기 높이를 늘려야 하는 쪽) 둘 다 알아야
  // 해서, 둘의 공통 부모인 여기서 소유한다.
  // 🔧 [사용자 지시, 2026-09-20] "채팅창에 들어오면 기본으로 하단
  // 네비바가 접힌 상태가 되도록" — 초기값을 true로. 세션 중 사용자가
  // 직접 펼치면(다른 탭에 갔다 돌아와도 이 컴포넌트는 hidden div로
  // 계속 마운트 유지되는 구조라) 그 선택은 그대로 남는다 — 매번 다시
  // 접히면 "펼쳐 두고 싶다"는 선택 자체를 무시하는 셈이라 부자연스럽다.
  const [chatTabBarCollapsed, setChatTabBarCollapsed] = useState(true);

  if (!session) return <Navigate to="/login" replace />;
  if (!MAIN_VIEWS.includes(path)) return <Navigate to="/" replace />;

  return (
    // 🔧 [사용자 지시] "탭 전환 정책과 캐싱 정책을 원초적으로 재검토해서
    // KV 쓰기 삭제를 절약할 방안" — MyStatusProvider는 원래 HashRouter
    // 바로 안(라우팅 정보를 모르는 위치)에 있어, "지금 어느 메인 페이지를
    // 보고 있는지"와 완전히 무관하게 세션이 있는 동안 항상 15분 폴링을
    // 돌렸다. 이 전역 상태를 실제로 쓰는 화면은 대시보드(StatusPage)와
    // 설정(SettingsPage) 둘뿐인데(useMyStatus 사용처 전수조사로 확인),
    // 제보/알림/관리자 화면에 있는 동안에도 계속 재작성됐다.
    // MainViews(=useLocation을 쓸 수 있는 위치) 안으로 Provider를 옮겨
    // path를 그대로 visible 계산에 써서, 그 두 화면 중 하나를 보고 있을
    // 때만 폴링이 돌게 좁힌다. 최초 로드(로그인 직후 1회, 화면 전환 시
    // 깜빡임 방지가 원래 목적)와 pull-to-refresh 리스너는 이 visible과
    // 무관하게 그대로 유지된다 — MyStatusProvider 내부 참고. CheckerPage/
    // LoginPage는 useMyStatus를 쓰지 않아(확인 완료) Provider 밖에 있어도
    // 안전하다.
    <MyStatusProvider visible={path === "/" || path === "/settings"}>
      <PullToRefreshIndicator />
      <div hidden={path !== "/"} className="animate-tab-enter">
        {everVisited.current["/"] && (
          <AppShell title="대시보드" titleIcon={LayoutDashboard}>
            <DashboardPage visible={path === "/"} />
          </AppShell>
        )}
      </div>
      <div hidden={path !== "/report"} className="animate-tab-enter">
        {everVisited.current["/report"] && (
          <AppShell title="제보" titleIcon={ScanLine}>
            <ReportPage visible={path === "/report"} />
          </AppShell>
        )}
      </div>
      <div hidden={path !== "/chat"} className="animate-tab-enter">
        {everVisited.current["/chat"] && (
          <AppShell
            title="채팅"
            titleIcon={MessageCircle}
            collapsibleTabBar={{ collapsed: chatTabBarCollapsed, onCollapsedChange: setChatTabBarCollapsed }}
          >
            <ChatPage
              visible={path === "/chat"}
              tabBarCollapsed={chatTabBarCollapsed}
              onTabBarCollapsedChange={setChatTabBarCollapsed}
            />
          </AppShell>
        )}
      </div>
      <div hidden={path !== "/notifications"} className="animate-tab-enter">
        {everVisited.current["/notifications"] && (
          <AppShell title="알림" titleIcon={Bell}>
            <NotificationsPage />
          </AppShell>
        )}
      </div>
      <div hidden={path !== "/settings"} className="animate-tab-enter">
        {everVisited.current["/settings"] && (
          <AppShell title="설정" titleIcon={Settings}>
            <SettingsPage visible={path === "/settings"} />
          </AppShell>
        )}
      </div>
      <div hidden={path !== "/admin"} className="animate-tab-enter">
        {everVisited.current["/admin"] &&
          // 🔧 2026-09: 부스터디장(공동 검토자)도 "관리자" 경로에 들어올 수
          // 있다 — AdminPage 내부가 isAdmin/isCoReviewer를 보고 전체 탭
          // 구조를 보여줄지, "송출 P 대상 처리"만 보여줄지 스스로 정한다.
          (isAdmin || isCoReviewer ? (
            <AppShell title="관리자" titleIcon={ShieldCheck}>
              <AdminPage visible={path === "/admin"} />
            </AppShell>
          ) : (
            <AdminDeniedCard />
          ))}
      </div>
    </MyStatusProvider>
  );
}

// 🔧 [임시 디버그, 2026-09-20] "하단 바는 여전히 해결되지 않았어" 재조사용
// — TabBar의 실제 DOM 높이/위치, env(safe-area-inset-bottom) 실측값,
// 화면(뷰포트) 바닥까지 남는 여백을 화면 최하단 한 줄에 작게 표시한다.
// 탭바 자체를 가리지 않도록 탭바보다 아래(화면 맨 끝)에 둔다. 원인
// 확정 후 반드시 제거할 것.
function BottomDebugBadge() {
  const [info, setInfo] = useState("측정 중...");
  useEffect(() => {
    const id = setInterval(() => {
      const probe = document.createElement("div");
      probe.style.position = "fixed";
      probe.style.bottom = "0";
      probe.style.paddingBottom = "env(safe-area-inset-bottom, -1px)";
      probe.style.visibility = "hidden";
      document.body.appendChild(probe);
      const envBottom = getComputedStyle(probe).paddingBottom;
      document.body.removeChild(probe);

      const nav = document.querySelector<HTMLElement>('nav[aria-label="하단 탭 메뉴"]');
      const navRect = nav ? nav.getBoundingClientRect() : null;
      const navPB = nav ? getComputedStyle(nav).paddingBottom : "no nav";

      setInfo(
        `env-bottom:${envBottom} nav-bottom:${navRect ? Math.round(navRect.bottom) : "n/a"} nav-pb:${navPB} winH:${window.innerHeight} gapBelowNav:${navRect ? Math.round(window.innerHeight - navRect.bottom) : "n/a"}`
      );
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 99999,
        background: "rgba(0,0,255,0.95)",
        color: "white",
        fontSize: 9,
        padding: "2px 4px",
        fontFamily: "monospace",
        pointerEvents: "none",
        wordBreak: "break-all",
      }}
    >
      {info}
    </div>
  );
}

export default function App() {
  useVersionCheck();

  return (
    <AuthProvider>
      <PeriodAlarmProvider>
        <BottomDebugBadge />
        <IdleOverlay />
        <HashRouter>
          {/* 🔧 MyStatusProvider는 이제 MainViews 내부(useLocation을 쓸 수
              있는 위치)로 옮겨, 대시보드/설정 화면을 보고 있을 때만 폴링이
              돌도록 좁혔다 — 상세 이유는 MainViews의 주석 참고. /login,
              /checker는 useMyStatus를 쓰지 않아(확인 완료) Provider 밖에
              있어도 안전하다. */}
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/checker"
              element={
                <AppShell fitToScreen>
                  <CheckerPage />
                </AppShell>
              }
            />
            <Route path="/*" element={<MainViews />} />
          </Routes>
        </HashRouter>
      </PeriodAlarmProvider>
    </AuthProvider>
  );
}
