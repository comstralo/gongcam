import { useRef } from "react";
import { HashRouter, Routes, Route, useLocation, Navigate } from "react-router-dom";
import { LayoutDashboard, ScanLine, Bell, Link2, Settings, ShieldCheck } from "lucide-react";
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
import { DashboardPage } from "@/pages/DashboardPage";
import { NotificationsPage } from "@/pages/NotificationsPage";
import { LinksPage } from "@/pages/LinksPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { AdminPage } from "@/pages/AdminPage";
import { useVersionCheck } from "@/hooks/useVersionCheck";

type MainView = "/" | "/report" | "/notifications" | "/links" | "/settings" | "/admin";
const MAIN_VIEWS: MainView[] = ["/", "/report", "/notifications", "/links", "/settings", "/admin"];

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
    "/notifications": false,
    "/links": false,
    "/settings": false,
    "/admin": false,
  });
  if (MAIN_VIEWS.includes(path)) everVisited.current[path] = true;

  if (!session) return <Navigate to="/login" replace />;
  if (!MAIN_VIEWS.includes(path)) return <Navigate to="/" replace />;

  return (
    // 🔧 [사용자 지시] "탭 전환 정책과 캐싱 정책을 원초적으로 재검토해서
    // KV 쓰기 삭제를 절약할 방안" — MyStatusProvider는 원래 HashRouter
    // 바로 안(라우팅 정보를 모르는 위치)에 있어, "지금 어느 메인 페이지를
    // 보고 있는지"와 완전히 무관하게 세션이 있는 동안 항상 15분 폴링을
    // 돌렸다. 이 전역 상태를 실제로 쓰는 화면은 대시보드(StatusPage)와
    // 설정(SettingsPage) 둘뿐인데(useMyStatus 사용처 전수조사로 확인),
    // 제보/알림/링크/관리자 화면에 있는 동안에도 계속 재작성됐다.
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
      <div hidden={path !== "/notifications"} className="animate-tab-enter">
        {everVisited.current["/notifications"] && (
          <AppShell title="알림" titleIcon={Bell}>
            <NotificationsPage />
          </AppShell>
        )}
      </div>
      <div hidden={path !== "/links"} className="animate-tab-enter">
        {everVisited.current["/links"] && (
          <AppShell title="링크" titleIcon={Link2}>
            <LinksPage />
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

export default function App() {
  useVersionCheck();

  return (
    <AuthProvider>
      <PeriodAlarmProvider>
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
