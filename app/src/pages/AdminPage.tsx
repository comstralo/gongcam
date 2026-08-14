import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SessionCard } from "@/components/session/SessionCard";
import { usePushSubscription } from "@/hooks/usePushSubscription";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import type { SnapshotRunNowResponse } from "@/lib/api/types";

const STATE_LABEL: Record<string, string> = {
  checking: "알림 상태 확인 중...",
  on: "알림 켜짐 · 이 브라우저는 구독 중",
  off: "알림 꺼짐 · 아직 구독하지 않음",
  unsupported: "이 브라우저는 푸시 알림을 지원하지 않습니다.",
};

export function AdminPage() {
  const { state, message, enable, sendTest } = usePushSubscription();
  const { call } = useApi();
  const [snapshotState, setSnapshotState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [snapshotMessage, setSnapshotMessage] = useState<string | null>(null);

  async function runSnapshotNow() {
    setSnapshotState("running");
    setSnapshotMessage(null);
    try {
      const res = await call<SnapshotRunNowResponse>("/snapshots/run-now", { method: "POST" });
      setSnapshotState("done");
      setSnapshotMessage(`${res.weekOf} 주차 · ${res.memberCount}명 저장 완료`);
    } catch (err) {
      setSnapshotState("error");
      setSnapshotMessage(err instanceof Error ? err.message : "스냅샷 저장에 실패했습니다.");
    }
  }

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

        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground sm:text-xs">
          주간 스냅샷
        </span>
        <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
          매주 월요일 04:50에 자동으로 저장되지만, 즉시 확인하거나 실패 시 재시도하려면 아래 버튼을 누르세요.
        </p>
        <Button
          className="w-full sm:h-12 sm:text-base"
          variant="outline"
          onClick={runSnapshotNow}
          disabled={snapshotState === "running"}
        >
          {snapshotState === "running" ? "저장 중..." : "지금 스냅샷 저장"}
        </Button>
        {snapshotMessage && (
          <Alert variant={snapshotState === "error" ? "destructive" : "default"}>
            <AlertDescription>{snapshotMessage}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
