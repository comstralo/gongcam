import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SessionCard } from "@/components/session/SessionCard";
import { InfoCard } from "@/components/dashboard/shared";

export function SettingsPage() {
  return (
    <Card className="w-full page-content">
      <CardContent className="flex flex-col gap-4">
        <SessionCard />

        <span className="font-mono text-micro uppercase tracking-wide text-muted-foreground sm:text-xs">알림</span>
        <InfoCard className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-semibold sm:text-base">브라우저 푸시 알림</span>
            <span className="text-xs text-muted-foreground sm:text-sm">제보/벌금 알림 등 종류별 on/off는 곧 추가됩니다</span>
          </div>
          <Badge variant="secondary" className="shrink-0 font-mono text-micro sm:text-xs">
            준비 중
          </Badge>
        </InfoCard>
      </CardContent>
    </Card>
  );
}
