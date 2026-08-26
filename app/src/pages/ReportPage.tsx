import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { SectionHeader, SectionCard } from "@/components/admin/shared";
import { useRosterPolling } from "@/hooks/useRosterPolling";
import { useApi } from "@/hooks/useApi";
import { ApiError } from "@/lib/api/client";
import { Bell, Flag, MessageSquareWarning, User } from "lucide-react";
import { SimpleNoticeSection } from "@/components/report/SimpleNoticeSection";
import { ActiveReportsSection } from "@/components/report/ActiveReportsSection";

const REASON_OPTIONS = [
  { value: "모호한 송출", label: "모호한 송출" },
  { value: "근거리 송출", label: "근거리 송출" },
];

type ReportMode = "screenshot" | "video";

export function ReportPage() {
  const { call } = useApi();
  const { members, stale, refresh } = useRosterPolling();
  const [nickname, setNickname] = useState("");
  const [reason, setReason] = useState("");
  const [submittingMode, setSubmittingMode] = useState<ReportMode | null>(null);
  const [message, setMessage] = useState<{ text: string; type: "error" | "ok" } | null>(null);
  const [cooldownRefreshSignal, setCooldownRefreshSignal] = useState(0);

  const noMembers = members.length === 0;
  const submitting = submittingMode !== null;

  async function handleSubmit(mode: ReportMode) {
    if (!nickname) {
      setMessage({ text: "제보 대상자를 선택해주세요.", type: "error" });
      return;
    }
    if (!reason) {
      setMessage({ text: "제보 원인을 선택해주세요.", type: "error" });
      return;
    }
    setSubmittingMode(mode);
    setMessage(null);
    try {
      await call("/report", {
        method: "POST",
        body: { nickname, reason, mode },
        tokenInBody: true,
      });
      setMessage({
        text:
          mode === "video"
            ? "영상 제보가 접수되었습니다. 90초 녹화 후 전송됩니다."
            : "제보가 접수되었습니다. 잠시 후 확인됩니다.",
        type: "ok",
      });
      setNickname("");
      setReason("");
      setCooldownRefreshSignal((n) => n + 1);
    } catch (err) {
      const text = err instanceof ApiError ? err.message : "네트워크 오류입니다.";
      setMessage({ text, type: "error" });
    } finally {
      setSubmittingMode(null);
    }
  }

  return (
    <div className="flex w-full page-content flex-col gap-4">
      <Card className="w-full">
        <CardContent>
          <Collapsible defaultOpen className="flex flex-col gap-4">
            <SectionHeader icon={Flag} title="송출 P 제보" onRefresh={refresh} />
            <div className="h-px w-full bg-border" />
            <CollapsiblePanel className="flex flex-col gap-4">
              <SectionCard className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label className="flex items-center gap-1.25 text-xs font-semibold text-muted-foreground sm:text-sm">
                    <User className="size-3 shrink-0 sm:size-3.5" />
                    제보 대상자
                  </Label>
                  <Select
                    value={nickname}
                    onValueChange={(v) => setNickname(v ?? "")}
                    disabled={stale || noMembers}
                    onOpenChange={(open) => {
                      if (open) refresh();
                    }}
                  >
                    <SelectTrigger className="w-full data-[size=default]:h-8 sm:data-[size=default]:h-12 sm:text-base">
                      <SelectValue
                        placeholder={
                          stale
                            ? "도움봇이 가동중이지 않습니다."
                            : noMembers
                              ? "현재 접속 중인 참여자가 없습니다"
                              : "참여자를 선택하세요"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {members.map((name) => (
                        <SelectItem key={name} value={name} className="sm:text-base">
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="reason" className="flex items-center gap-1.25 text-xs font-semibold text-muted-foreground sm:text-sm">
                    <MessageSquareWarning className="size-3 shrink-0 sm:size-3.5" />
                    제보 원인
                  </Label>
                  <Select value={reason} onValueChange={(v) => setReason(v ?? "")} disabled={stale}>
                    <SelectTrigger
                      id="reason"
                      className="w-full data-[size=default]:h-8 sm:data-[size=default]:h-12 sm:text-base"
                    >
                      <SelectValue placeholder="원인을 선택해 주세요." />
                    </SelectTrigger>
                    <SelectContent>
                      {REASON_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value} className="sm:text-base">
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <Button
                    className="w-full border-primary hover:bg-primary/10 sm:h-12 sm:text-base"
                    variant="outline"
                    disabled={submitting || stale}
                    onClick={() => handleSubmit("screenshot")}
                  >
                    스크린샷 제보
                  </Button>
                  <Button
                    className="w-full border-primary hover:bg-primary/10 sm:h-12 sm:text-base"
                    variant="outline"
                    disabled={submitting || stale}
                    onClick={() => handleSubmit("video")}
                  >
                    영상 제보
                  </Button>
                </div>
              </SectionCard>

              <ActiveReportsSection refreshSignal={cooldownRefreshSignal} />

              {message && (
                <Alert variant={message.type === "error" ? "destructive" : "default"}>
                  <AlertDescription>{message.text}</AlertDescription>
                </Alert>
              )}

            </CollapsiblePanel>
          </Collapsible>
        </CardContent>
      </Card>

      <Card className="w-full">
        <CardContent>
          <Collapsible defaultOpen className="flex flex-col gap-4">
            <SectionHeader icon={Bell} title="간단한 알림" onRefresh={refresh} />
            <div className="h-px w-full bg-border" />
            <CollapsiblePanel className="flex flex-col gap-4">
              <SimpleNoticeSection members={members} noMembers={noMembers} stale={stale} />
            </CollapsiblePanel>
          </Collapsible>
        </CardContent>
      </Card>
    </div>
  );
}
