import { User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DividedValue, InfoCard } from "@/components/dashboard/shared";
import { useAuth } from "@/lib/auth/useAuth";
import { ICON_STROKE } from "@/lib/utils";
import { useNavigate } from "react-router-dom";

export function SessionCard({ name, onLogout }: { name?: string; onLogout?: () => void }) {
  const { session, logout } = useAuth();
  const navigate = useNavigate();

  if (!session) return null;

  return (
    <InfoCard className="flex items-center justify-between gap-2.5">
      <span className="inline-flex min-w-0 flex-1 items-center gap-1.25 truncate text-sm font-semibold sm:text-base">
        <User className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
        <DividedValue
          items={[
            name || session.name || session.email,
            <span className="truncate text-xs font-normal text-muted-foreground sm:text-sm">{session.email}</span>,
          ]}
        />
      </span>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0 text-xs sm:text-sm"
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
