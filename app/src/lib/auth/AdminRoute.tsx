import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "./useAuth";
import { AdminDeniedCard } from "./AdminDeniedCard";

// admin.html은 관리자가 아니면 리다이렉트가 아니라 "접근 거부" 카드를 보여주는 게 기존 동작.
// ProtectedRoute와 로직이 갈리므로 별도 컴포넌트로 분리해 실수를 방지한다.
export function AdminRoute({ children }: { children: ReactNode }) {
  const { session, isAdmin } = useAuth();
  if (!session) return <Navigate to="/login" replace />;
  if (!isAdmin) return <AdminDeniedCard />;
  return children;
}
