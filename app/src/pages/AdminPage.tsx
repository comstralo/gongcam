import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SessionCard } from "@/components/session/SessionCard";
import { usePushSubscription } from "@/hooks/usePushSubscription";
import { cn } from "@/lib/utils";

const STATE_LABEL: Record<string, string> = {
  checking: "알림 상태 확인 중...",
  on: "알림 켜짐 · 이 브라우저는 구독 중",
  off: "알림 꺼짐 · 아직 구독하지 않음",
  unsupported: "이 브라우저는 푸시 알림을 지원하지 않습니다.",
};

export function AdminPage() {
  const { state, message, enable, sendTest } = usePushSubscription();

  return (
    <Card className="w-full page-content">
      <CardContent className="flex flex-col gap-4">
        <SessionCard />

        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground sm:text-xs">
          브라우저 푸시 알림
        </span>
        <div className="flex items-center gap-2.5 rounded-lg border bg-muted p-3.5 text-sm sm:p-4.5 sm:text-base">
          <span
            className={cn(
              "size-2.5 shrink-0 rounded-full bg-muted-foreground",
              state === "on" && "bg-ok",
              state === "off" && "bg-destructive"
            )}
          />
          <span>{STATE_LABEL[state]}</span>
        </div>

        {state === "off" && (
          <Button className="w-full sm:h-12 sm:text-base" onClick={enable}>
            알림 켜기
          </Button>
        )}
        {state === "on" && (
          <Button className="w-full sm:h-12 sm:text-base" variant="outline" onClick={sendTest}>
            테스트 알림 보내기
          </Button>
        )}

        {message && (
          <Alert variant={message.type === "error" ? "destructive" : "default"}>
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
