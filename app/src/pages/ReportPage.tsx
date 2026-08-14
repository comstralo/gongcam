import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SessionCard } from "@/components/session/SessionCard";
import { useRosterPolling } from "@/hooks/useRosterPolling";
import { useApi } from "@/hooks/useApi";
import { ApiError } from "@/lib/api/client";
import { RefreshCw } from "lucide-react";

export function ReportPage() {
  const { call } = useApi();
  const { members, hint, refresh } = useRosterPolling();
  const [nickname, setNickname] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "error" | "ok" } | null>(null);

  const noMembers = members.length === 0;

  async function handleSubmit() {
    if (!nickname) {
      setMessage({ text: "대상 참여자를 선택해주세요.", type: "error" });
      return;
    }
    setSubmitting(true);
    setMessage(null);
    try {
      await call("/report", {
        method: "POST",
        body: { nickname, reason: reason.trim() },
        tokenInBody: true,
      });
      setMessage({ text: "제보가 접수되었습니다. 잠시 후 확인됩니다.", type: "ok" });
      setNickname("");
      setReason("");
    } catch (err) {
      const text = err instanceof ApiError ? err.message : "네트워크 오류입니다.";
      setMessage({ text, type: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="w-full page-content">
      <CardContent className="flex flex-col gap-4">
        <SessionCard />

        <div className="flex flex-col gap-1.5">
          <Label className="text-sm font-semibold sm:text-base">대상 참여자</Label>
          <span className="text-xs text-muted-foreground sm:text-sm">{hint}</span>
          <div className="flex items-center gap-2">
            <Select value={nickname} onValueChange={(v) => setNickname(v ?? "")} disabled={noMembers}>
              <SelectTrigger className="flex-1 sm:h-12 sm:text-base">
                <SelectValue
                  placeholder={noMembers ? "현재 접속 중인 참여자가 없습니다" : "참여자를 선택하세요"}
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
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-11 shrink-0 sm:size-12"
              onClick={refresh}
              aria-label="명단 새로고침"
            >
              <RefreshCw className="size-4 sm:size-5" />
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reason" className="text-sm font-semibold sm:text-base">
            상황 설명 (선택)
          </Label>
          <span className="text-xs text-muted-foreground sm:text-sm">화각 이탈, 화면 정지 등 간단히 적어주세요</span>
          <Textarea
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="예: 손이 안 보여요"
            maxLength={200}
            className="min-h-18 sm:text-base"
          />
        </div>

        <Button className="w-full sm:h-12 sm:text-base" disabled={submitting} onClick={handleSubmit}>
          제보 접수
        </Button>

        {message && (
          <Alert variant={message.type === "error" ? "destructive" : "default"}>
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
