import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth/useAuth";
import { useNavigate } from "react-router-dom";

export function SessionCard({ onLogout }: { onLogout?: () => void }) {
  const { session, logout } = useAuth();
  const navigate = useNavigate();

  if (!session) return null;

  return (
    <div className="flex items-center justify-between gap-2.5 rounded-lg border bg-muted p-3.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-semibold">{session.name || session.email}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">{session.email}</span>
      </div>
      <Button
        variant="link"
        size="sm"
        className="min-h-11 min-w-11 shrink-0 text-xs text-muted-foreground"
        onClick={() => {
          logout();
          onLogout?.();
          navigate("/login", { replace: true });
        }}
      >
        로그아웃
      </Button>
    </div>
  );
}
