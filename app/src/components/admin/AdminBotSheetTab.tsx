import { useEffect, useState } from "react";
import { Bot, RotateCw, Table } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { InfoCard } from "@/components/dashboard/shared";
import { SectionHeader, SectionCard, FieldLabel, FieldValue } from "@/components/admin/shared";
import { useApi } from "@/hooks/useApi";
import { ApiError } from "@/lib/api/client";
import { cn, ICON_STROKE } from "@/lib/utils";
import type { BotStatusResponse, BotCommand, BotCommandResponse } from "@/lib/api/types";

// 도움봇(study_manager_260418.py)은 로컬 PC에서 상시 실행되는 Selenium
// 프로세스라, Worker와 하트비트(생존 신호)/명령 예약으로만 느슨하게
// 연결된다. "정지"는 완전 종료가 아니라 브라우저만 끄고 다음 명령을
// 기다리는 상태 — 봇 쪽 코드가 그렇게 구현되어 있다(BOT_STRUCTURE.md 참고).
function timeAgo(ts: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}초 전`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHour = Math.floor(diffMin / 60);
  return `${diffHour}시간 전`;
}

function BotStatusSection() {
  const { call } = useApi();

  const [status, setStatus] = useState<BotStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingCommand, setPendingCommand] = useState<BotCommand | null>(null);
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

  async function sendCommand(command: BotCommand) {
    setPendingCommand(command);
    setError(null);
    setMessage(null);
    try {
      await call<BotCommandResponse>("/admin/bot/command", { method: "POST", body: { command } });
      setMessage("명령을 예약했습니다. 봇이 다음 하트비트(최대 30초) 때 수행합니다.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "명령 전송에 실패했습니다.");
    } finally {
      setPendingCommand(null);
    }
  }

  const online = status?.online ?? false;
  const browserState = status?.browserState;

  return (
    <SectionCard className="flex flex-col gap-4">
      <SectionHeader icon={Bot} title="도움봇 상태" loading={loading} onRefresh={load} />
      <div className="h-px w-full bg-border" />

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
          <FieldLabel>브라우저</FieldLabel>
          <FieldValue>
            {browserState === "running" ? "실행 중" : browserState === "stopped" ? "정지됨" : "-"}
          </FieldValue>
        </div>

        <div className="flex items-center justify-between gap-2">
          <FieldLabel>마지막 신호</FieldLabel>
          <FieldValue>{status?.lastSeenAt ? timeAgo(status.lastSeenAt) : "-"}</FieldValue>
        </div>
      </InfoCard>

      <div className="grid grid-cols-3 gap-2">
        <Button variant="outline" disabled={pendingCommand !== null} onClick={() => sendCommand("start")} className="sm:h-11">
          {pendingCommand === "start" ? (
            <RotateCw className="size-4 animate-spin" strokeWidth={ICON_STROKE.default} />
          ) : (
            "ON"
          )}
        </Button>
        <Button variant="outline" disabled={pendingCommand !== null} onClick={() => sendCommand("stop")} className="sm:h-11">
          {pendingCommand === "stop" ? (
            <RotateCw className="size-4 animate-spin" strokeWidth={ICON_STROKE.default} />
          ) : (
            "OFF"
          )}
        </Button>
        <Button
          variant="outline"
          disabled={pendingCommand !== null}
          onClick={() => sendCommand("restart")}
          className="sm:h-11"
        >
          {pendingCommand === "restart" ? (
            <RotateCw className="size-4 animate-spin" strokeWidth={ICON_STROKE.default} />
          ) : (
            "재시작"
          )}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground sm:text-sm">
        OFF는 봇 프로세스를 완전히 종료하지 않고 브라우저만 끕니다. 다시 ON 또는 재시작을 누르면
        브라우저를 새로 열고 스터디룸에 재입장합니다.
      </p>
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
