import { Card, CardContent } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { InfoCard } from "@/components/dashboard/shared";
import { NewMemberForm } from "@/components/admin/NewMemberForm";
import { usePushSubscription } from "@/hooks/usePushSubscription";
import { useAuth } from "@/lib/auth/useAuth";
import { WORKER_BASE } from "@/lib/api/client";
import { cn } from "@/lib/utils";

const STATE_LABEL: Record<string, string> = {
  checking: "알림 상태 확인 중...",
  on: "알림 켜짐 · 이 브라우저는 구독 중",
  off: "알림 꺼짐 · 아직 구독하지 않음",
  unsupported: "이 브라우저는 푸시 알림을 지원하지 않습니다.",
};

export function AdminPage() {
  const { state, message, enable, sendTest } = usePushSubscription();
  const { session } = useAuth();

  return (
    <Card className="w-full page-content">
      <CardContent className="flex flex-col gap-4">
        <span className="font-mono text-micro uppercase tracking-wide text-muted-foreground sm:text-xs">
          Drive 편집자 권한 위임
        </span>
        <InfoCard className="flex flex-col gap-2">
          <span className="text-sm text-muted-foreground sm:text-base">
            신규 스터디원 등록 시 구글 시트 편집자 권한을 자동으로 부여하려면, 관리자 계정으로 1회
            연동이 필요합니다.
          </span>
          <a
            href={`${WORKER_BASE}/oauth/authorize?token=${encodeURIComponent(session?.token || "")}`}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: "outline" }), "w-full sm:h-12 sm:text-base")}
          >
            Drive 권한 연동하기
          </a>
        </InfoCard>

        <span className="font-mono text-micro uppercase tracking-wide text-muted-foreground sm:text-xs">
          신규 스터디원 등록
        </span>
        <NewMemberForm />

        <span className="font-mono text-micro uppercase tracking-wide text-muted-foreground sm:text-xs">
          브라우저 푸시 알림
        </span>
        <InfoCard className="flex items-center gap-2.5 text-sm sm:text-base">
          <span
            className={cn(
              "size-2.5 shrink-0 rounded-full bg-muted-foreground",
              state === "on" && "bg-ok",
              state === "off" && "bg-destructive"
            )}
          />
          <span>{STATE_LABEL[state]}</span>
        </InfoCard>

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
