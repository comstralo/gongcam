import { User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DividedValue, InfoCard } from "@/components/dashboard/shared";
import { useAuth } from "@/lib/auth/useAuth";
import { ICON_STROKE } from "@/lib/utils";
import { useNavigate } from "react-router-dom";

export function SessionCard({ name, onLogout }: { name?: string; onLogout?: () => void }) {
  const { session, logout } = useAuth();
  const navigate = useNavigate();

  // 🔧 2026-09: session이 채워지기 전엔 아예 아무것도 안 그려 SettingsPage
  // 최상단이 비어 있다가, 세션이 로드되는 순간 카드가 갑자기 나타나 그
  // 아래 콘텐츠가 훅 밀렸다(CycleSwitcher와 같은 패턴, 사용자 지적) —
  // 같은 InfoCard 레이아웃 크기의 펄스 스켈레톤을 먼저 그려 자리를 잡는다.
  if (!session) {
    return (
      <InfoCard className="flex items-center justify-between gap-2.5" aria-hidden>
        <span className="flex min-w-0 flex-1 animate-pulse items-center gap-1.25">
          <span className="size-3.5 shrink-0 rounded-full bg-muted sm:size-4" />
          <span className="h-3.5 w-32 rounded bg-muted sm:h-4 sm:w-40" />
        </span>
        <span className="h-8 w-20 shrink-0 animate-pulse rounded-md bg-muted" />
      </InfoCard>
    );
  }

  return (
    <InfoCard className="flex items-center justify-between gap-2.5">
      <span className="inline-flex min-w-0 flex-1 items-center gap-1.25 truncate text-xs font-semibold sm:text-sm">
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
