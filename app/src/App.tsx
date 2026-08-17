import { HashRouter, Routes, Route } from "react-router-dom";
import { LayoutDashboard, ScanLine, Settings, ShieldCheck } from "lucide-react";
import { AuthProvider } from "@/lib/auth/AuthContext";
import { PeriodAlarmProvider } from "@/lib/periodAlarm/PeriodAlarmContext";
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
      <PeriodAlarmProvider>
        <HashRouter>
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
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <AppShell title="대시보드" titleIcon={LayoutDashboard}>
                    <DashboardPage />
                  </AppShell>
                </ProtectedRoute>
              }
            />
            <Route
              path="/report"
              element={
                <ProtectedRoute>
                  <AppShell title="화각 제보" titleIcon={ScanLine}>
                    <ReportPage />
                  </AppShell>
                </ProtectedRoute>
              }
            />
            <Route
              path="/settings"
              element={
                <ProtectedRoute>
                  <AppShell title="설정" titleIcon={Settings}>
                    <SettingsPage />
                  </AppShell>
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin"
              element={
                <AdminRoute>
                  <AppShell title="관리자" titleIcon={ShieldCheck}>
                    <AdminPage />
                  </AppShell>
                </AdminRoute>
              }
            />
          </Routes>
        </HashRouter>
      </PeriodAlarmProvider>
    </AuthProvider>
  );
}
