import { User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoCard } from "@/components/dashboard/shared";
import { useAuth } from "@/lib/auth/useAuth";
import { ICON_STROKE } from "@/lib/utils";
import { useNavigate } from "react-router-dom";

export function SessionCard({ name, onLogout }: { name?: string; onLogout?: () => void }) {
  const { session, logout } = useAuth();
  const navigate = useNavigate();

  if (!session) return null;

  return (
    <InfoCard className="flex items-center justify-between gap-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="inline-flex items-center gap-1.25 truncate text-sm font-semibold sm:text-base">
          <User className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
          {name || session.name || session.email}
        </span>
        <span className="truncate text-xs text-muted-foreground sm:text-sm">{session.email}</span>
      </div>
      <Button
        variant="link"
        size="sm"
        className="min-h-11 min-w-11 shrink-0 text-xs text-muted-foreground sm:text-sm"
        onClick={() => {
          logout();
          onLogout?.();
          navigate("/login", { replace: true });
        }}
      >
        로그아웃
      </Button>
    </InfoCard>
  );
}
