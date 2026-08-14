import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SessionCard } from "@/components/session/SessionCard";

export function SettingsPage() {
  return (
    <Card className="w-full max-w-md">
      <CardContent className="flex flex-col gap-4">
        <SessionCard />

        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">알림</span>
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted p-3.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-semibold">브라우저 푸시 알림</span>
            <span className="text-xs text-muted-foreground">제보/벌금 알림 등 종류별 on/off는 곧 추가됩니다</span>
          </div>
          <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
            준비 중
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}
