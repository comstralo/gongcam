import { useRef } from "react";
import { HashRouter, Routes, Route, useLocation, Navigate } from "react-router-dom";
import { LayoutDashboard, ScanLine, Link2, Settings, ShieldCheck } from "lucide-react";
import { AuthProvider } from "@/lib/auth/AuthContext";
import { useAuth } from "@/lib/auth/useAuth";
import { MyStatusProvider } from "@/lib/status/MyStatusContext";
import { PeriodAlarmProvider } from "@/lib/periodAlarm/PeriodAlarmContext";
import { AdminDeniedCard } from "@/lib/auth/AdminDeniedCard";
import { AppShell } from "@/components/layout/AppShell";
import { PullToRefreshIndicator } from "@/components/layout/PullToRefreshIndicator";
import { LoginPage } from "@/pages/LoginPage";
import { CheckerPage } from "@/pages/CheckerPage";
import { ReportPage } from "@/pages/ReportPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { LinksPage } from "@/pages/LinksPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { AdminPage } from "@/pages/AdminPage";
import { useVersionCheck } from "@/hooks/useVersionCheck";

type MainView = "/" | "/report" | "/links" | "/settings" | "/admin";
const MAIN_VIEWS: MainView[] = ["/", "/report", "/links", "/settings", "/admin"];

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
    "/links": false,
    "/settings": false,
    "/admin": false,
  });
  if (MAIN_VIEWS.includes(path)) everVisited.current[path] = true;

  if (!session) return <Navigate to="/login" replace />;
  if (!MAIN_VIEWS.includes(path)) return <Navigate to="/" replace />;

  return (
    <>
      <PullToRefreshIndicator />
      <div hidden={path !== "/"}>
        {everVisited.current["/"] && (
          <AppShell title="대시보드" titleIcon={LayoutDashboard}>
            <DashboardPage visible={path === "/"} />
          </AppShell>
        )}
      </div>
      <div hidden={path !== "/report"}>
        {everVisited.current["/report"] && (
          <AppShell title="제보" titleIcon={ScanLine}>
            <ReportPage />
          </AppShell>
        )}
      </div>
      <div hidden={path !== "/links"}>
        {everVisited.current["/links"] && (
          <AppShell title="링크" titleIcon={Link2}>
            <LinksPage />
          </AppShell>
        )}
      </div>
      <div hidden={path !== "/settings"}>
        {everVisited.current["/settings"] && (
          <AppShell title="설정" titleIcon={Settings}>
            <SettingsPage visible={path === "/settings"} />
          </AppShell>
        )}
      </div>
      <div hidden={path !== "/admin"}>
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
    </>
  );
}

export default function App() {
  useVersionCheck();

  return (
    <AuthProvider>
      <PeriodAlarmProvider>
        <HashRouter>
          <MyStatusProvider>
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
          </MyStatusProvider>
        </HashRouter>
      </PeriodAlarmProvider>
    </AuthProvider>
  );
}
