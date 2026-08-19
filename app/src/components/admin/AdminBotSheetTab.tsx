import { useEffect, useState } from "react";
import { Bot, RotateCw, Table } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { InfoCard } from "@/components/dashboard/shared";
import { SectionHeader, SectionCard, FieldLabel, FieldValue } from "@/components/admin/shared";
import { useApi } from "@/hooks/useApi";
import { ApiError } from "@/lib/api/client";
import { cn, ICON_STROKE } from "@/lib/utils";
import type { BotStatusResponse, BotCommandResponse } from "@/lib/api/types";

// 도움봇(study_manager_260418.py)은 로컬 PC에서 상시 실행되는 Selenium
// 프로세스라, Cloudflare Tunnel로 노출한 로컬 상태 서버를 Worker가 요청
// 시점에 즉시 프록시하는 방식으로 연결된다(폴링 없음). 관리자가 할 수
// 있는 원격 명령은 "재시작"뿐이다 — 봇 쪽 코드가 그렇게 구현되어 있다
// (BOT_STRUCTURE.md 참고).

function BotStatusSection() {
  const { call } = useApi();

  const [status, setStatus] = useState<BotStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [restarting, setRestarting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    call<BotStatusResponse>("/admin/bot/status")
      .then((data) => setStatus(data))
      .catch((err) => setError(err instanceof Error ? err.message : "봇 상태를 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function sendRestart() {
    setRestarting(true);
    setError(null);
    setMessage(null);
    try {
      await call<BotCommandResponse>("/admin/bot/command", { method: "POST", body: { command: "restart" } });
      setMessage("재시작 명령을 전송했습니다. 봇이 즉시 브라우저를 재시작합니다.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "명령 전송에 실패했습니다.");
    } finally {
      setRestarting(false);
    }
  }

  const online = status?.online ?? false;
  const roomState = status?.roomState;

  return (
    <SectionCard>
      <Collapsible defaultOpen className="flex flex-col gap-4">
        <SectionHeader icon={Bot} title="도움봇 상태" loading={loading} onRefresh={load} />
        <div className="h-px w-full bg-border" />
        <CollapsiblePanel className="flex flex-col gap-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {message && (
            <Alert>
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          )}

          {status?.screenshot && (
            <img
              src={`data:image/png;base64,${status.screenshot}`}
              alt="도움봇 화면"
              className="w-full rounded-lg border border-border"
            />
          )}

          <InfoCard className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2">
              <FieldLabel>연결 상태</FieldLabel>
              <span className="inline-flex items-center gap-1.5">
                <span className={cn("size-2.5 shrink-0 rounded-full", online ? "bg-ok" : "bg-destructive")} />
                <FieldValue className={online ? "text-ok" : "text-destructive"}>
                  {online ? "온라인" : "오프라인"}
                </FieldValue>
              </span>
            </div>

            <div className="flex items-center justify-between gap-2">
              <FieldLabel>스터디룸 접속</FieldLabel>
              <FieldValue>
                {roomState === "in_room" ? "접속 중" : roomState === "outside" ? "외부" : "-"}
              </FieldValue>
            </div>
          </InfoCard>

          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" disabled={restarting} onClick={sendRestart} className="w-full sm:h-11">
              {restarting ? (
                <RotateCw className="size-4 animate-spin" strokeWidth={ICON_STROKE.default} />
              ) : (
                "재시작"
              )}
            </Button>
            <Button variant="outline" disabled={loading} onClick={load} className="w-full sm:h-11">
              <RotateCw className={cn("size-4", loading && "animate-spin")} strokeWidth={ICON_STROKE.default} />
              새로고침
            </Button>
          </div>

          <p className="text-xs text-muted-foreground sm:text-sm">
            재시작을 누르면 브라우저를 새로 열고 스터디룸에 재입장합니다.
          </p>

          {status?.recentLogs && status.recentLogs.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <FieldLabel>최근 로그</FieldLabel>
              <pre className="max-h-48 overflow-y-auto rounded-lg border border-border bg-muted p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {status.recentLogs.join("\n")}
              </pre>
            </div>
          )}
        </CollapsiblePanel>
      </Collapsible>
    </SectionCard>
  );
}

function SheetPlaceholderSection() {
  return (
    <SectionCard className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
      <Table className="size-8" strokeWidth={ICON_STROKE.large} />
      <p className="text-sm sm:text-base">시트 관리 기능은 준비 중입니다.</p>
    </SectionCard>
  );
}

export function AdminBotSheetTab() {
  return (
    <div className="flex flex-col gap-4">
      <BotStatusSection />
      <SheetPlaceholderSection />
    </div>
  );
}
