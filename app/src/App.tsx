import { HashRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/lib/auth/AuthContext";
import { ProtectedRoute } from "@/lib/auth/ProtectedRoute";
import { AdminRoute } from "@/lib/auth/AdminRoute";
import { AppShell } from "@/components/layout/AppShell";
import { LoginPage } from "@/pages/LoginPage";
import { CheckerPage } from "@/pages/CheckerPage";
import { ReportPage } from "@/pages/ReportPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { AdminPage } from "@/pages/AdminPage";
import { useVersionCheck } from "@/hooks/useVersionCheck";

export default function App() {
  useVersionCheck();

  return (
    <AuthProvider>
      <HashRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/checker"
            element={
              <AppShell>
                <CheckerPage />
              </AppShell>
            }
          />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <AppShell title="대시보드" hideEyebrow>
                  <DashboardPage />
                </AppShell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/report"
            element={
              <ProtectedRoute>
                <AppShell title="화각 제보">
                  <ReportPage />
                </AppShell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <AppShell title="설정">
                  <SettingsPage />
                </AppShell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <AdminRoute>
                <AppShell title="관리자">
                  <AdminPage />
                </AppShell>
              </AdminRoute>
            }
          />
        </Routes>
      </HashRouter>
    </AuthProvider>
  );
}
