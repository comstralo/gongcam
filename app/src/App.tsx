import { lazy, Suspense, useRef, useState } from "react";
import { HashRouter, Routes, Route, useLocation, Navigate } from "react-router-dom";
import { MessageCircle, Loader2 } from "lucide-react";
import { AuthProvider } from "@/lib/auth/AuthContext";
import { useAuth } from "@/lib/auth/useAuth";
import { MyStatusProvider } from "@/lib/status/MyStatusContext";
import { PeriodAlarmProvider } from "@/lib/periodAlarm/PeriodAlarmContext";
import { AdminDeniedCard } from "@/lib/auth/AdminDeniedCard";
import { AppShell } from "@/components/layout/AppShell";
import { PullToRefreshIndicator } from "@/components/layout/PullToRefreshIndicator";
import { IdleOverlay } from "@/components/layout/IdleOverlay";
import { OfflineBanner } from "@/components/layout/OfflineBanner";
import { LoginPage } from "@/pages/LoginPage";
import { CheckerPage } from "@/pages/CheckerPage";
import { ReportPage } from "@/pages/ReportPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { useVersionCheck } from "@/hooks/useVersionCheck";

// 🔧 [번들 최적화, 2026-09-21] vite build가 2.69MB 단일 청크 경고를 계속
// 냈다 — stream-chat/stream-chat-react(채팅 SDK, 전 회원이 매번 로드)와
// 관리자 전용 대량 컴포넌트(AdminPage, 부스터디장 이상만 진입)가 가장 큰
// 기여 후보였다. 이 둘만 동적 import로 분리한다 — 아래 MainViews의
// "한 번 방문한 페이지는 hidden으로만 감추고 계속 마운트 유지" 구조와
// React.lazy는 실제로 상충하지 않는다: lazy는 컴포넌트가 처음
// resolve된 뒤로는 계속 그 결과를 재사용하고, 언마운트가 애초에 안
// 일어나는 구조라 재로드 이슈도 생기지 않는다. named export라 default로
// 감싸야 한다.
const ChatPage = lazy(() => import("@/pages/ChatPage").then((m) => ({ default: m.ChatPage })));
const AdminPage = lazy(() => import("@/pages/AdminPage").then((m) => ({ default: m.AdminPage })));

function PageLoadingFallback() {
  return (
    <div className="flex w-full flex-1 items-center justify-center py-16">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  );
}

type MainView = "/" | "/report" | "/chat" | "/settings" | "/admin";
const MAIN_VIEWS: MainView[] = ["/", "/report", "/chat", "/settings", "/admin"];

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
  // 🔧 [버그 수정, 2026-09-21 사용자 지시: "PC에서는 굳이 기본이 접힘
  // 상태일 필요가 없을 것 같아. 펼침 상태로(선택 시 접기 가능으로)"] —
  // 위 접힘 기본값은 모바일(세로 공간이 빠듯해 입력창까지 가리는 걸
  // 막으려는 의도)에만 해당하는 이유였다. PC는 화면 세로 공간이
  // 넉넉해 그 이유 자체가 없다 — ChatPage가 이미 "모바일/데스크톱"
  // 구분에 쓰는 것과 동일한 Tailwind md 브레이크포인트(768px,
  // ChatPage.tsx의 max-md:hidden 참고)를 그대로 재사용해, 그 이상
  // 폭에서는 펼침을 기본값으로 시작한다. 여전히 언제든 수동으로 접을
  // 수 있고(TabBar의 접기 버튼), 그 선택도 위와 동일하게 세션 중 유지된다.
  const [chatTabBarCollapsed, setChatTabBarCollapsed] = useState(() => window.innerWidth < 768);
  // 🔧 [버그 수정, 2026-09-20 사용자 지시: "채팅에서는 여전히 네비바
  // 위치가 이상해"] — AppShell이 실측한 하단 바(TabBar 또는 접힘 버튼)
  // 의 실제 높이를 받아 ChatPage에 그대로 전달한다 — 매직넘버 계산
  // 대신 이 실측값 하나로 항상 정확히 정합성이 맞는다.
  const [chatBarHeight, setChatBarHeight] = useState(0);

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
    // 🔧 [버그 수정, 2026-09-21 사용자 지시: "타이틀 + 탭바까지는 고정으로
    // 하는게 나은거 같아. 그 하위 요소만 스크롤 되도록"] — 각 페이지
    // (Dashboard/Report/Settings/Admin)가 이제 자기 자신을 AppShell로
    // 직접 감싸고(각 페이지 내부에 title/titleIcon, 탭이 있으면
    // stickyHeader까지 채워 렌더링) 여기서는 페이지 컴포넌트를 그대로
    // 반환한다 — AppShell이 여기(App.tsx)와 각 페이지 두 곳에 흩어져
    // 있으면 stickyHeader처럼 페이지 내부 상태(탭 view 등)가 필요한
    // prop을 넘길 수 없었다. ChatPage만 예외 — collapsibleTabBar 상태를
    // AppShell과 ChatPage 형제 컴포넌트가 함께 공유해야 해서(둘 다
    // App.tsx 자식) 그 상태의 공통 부모인 여기서 계속 감싼다.
    <MyStatusProvider visible={path === "/" || path === "/settings"}>
      <PullToRefreshIndicator />
      <div hidden={path !== "/"} className="animate-tab-enter">
        {everVisited.current["/"] && <DashboardPage visible={path === "/"} />}
      </div>
      <div hidden={path !== "/report"} className="animate-tab-enter">
        {everVisited.current["/report"] && <ReportPage visible={path === "/report"} />}
      </div>
      <div hidden={path !== "/chat"} className="animate-tab-enter">
        {everVisited.current["/chat"] && (
          <AppShell
            title="채팅"
            titleIcon={MessageCircle}
            collapsibleTabBar={{ collapsed: chatTabBarCollapsed, onCollapsedChange: setChatTabBarCollapsed }}
            onBarHeightChange={setChatBarHeight}
          >
            <Suspense fallback={<PageLoadingFallback />}>
              <ChatPage
                visible={path === "/chat"}
                tabBarCollapsed={chatTabBarCollapsed}
                onTabBarCollapsedChange={setChatTabBarCollapsed}
                tabBarHeight={chatBarHeight}
              />
            </Suspense>
          </AppShell>
        )}
      </div>
      <div hidden={path !== "/settings"} className="animate-tab-enter">
        {everVisited.current["/settings"] && <SettingsPage visible={path === "/settings"} />}
      </div>
      <div hidden={path !== "/admin"} className="animate-tab-enter">
        {everVisited.current["/admin"] &&
          // 🔧 2026-09: 부스터디장(공동 검토자)도 "관리자" 경로에 들어올 수
          // 있다 — AdminPage 내부가 isAdmin/isCoReviewer를 보고 전체 탭
          // 구조를 보여줄지, "송출 P 대상 처리"만 보여줄지 스스로 정한다.
          (isAdmin || isCoReviewer ? (
            <Suspense fallback={<PageLoadingFallback />}>
              <AdminPage visible={path === "/admin"} />
            </Suspense>
          ) : (
            <AdminDeniedCard />
          ))}
      </div>
    </MyStatusProvider>
  );
}

// 🔧 [버그 수정, 2026-09-21 사용자 지시: "로그인 안 한 상태로 접속했을
// 때 대시보드가 순간적으로 보였다가 로그인 페이지로 바뀐다, 방지해야"] —
// AuthContext.tsx의 sessionVerified 설명 참고. 저장된 토큰의 실제 유효성이
// 서버에서 확인될 때까지는 로그인 화면도 대시보드도(둘 다 "확정된 답"을
// 전제로 한 라우팅 판단이므로) 렌더링하지 않고, 빈 화면 대신 짧은 로딩
// 표시만 보여준다. 저장된 토큰이 아예 없는 절대다수의 경우 이 컴포넌트는
// 첫 렌더에 이미 sessionVerified=true라 이 분기를 타지 않는다(체감상
// 로딩 없이 즉시 로그인 화면) — 토큰이 있어 검증이 실제로 필요한
// 경우에만 아주 짧게(보통 API 응답 1회 왕복) 나타난다.
function AppRoutes() {
  const { sessionVerified } = useAuth();

  if (!sessionVerified) {
    return (
      <div className="flex min-h-dvh w-full items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
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
  );
}

export default function App() {
  useVersionCheck();

  return (
    <AuthProvider>
      <PeriodAlarmProvider>
        <OfflineBanner />
        <IdleOverlay />
        <AppRoutes />
      </PeriodAlarmProvider>
    </AuthProvider>
  );
}
