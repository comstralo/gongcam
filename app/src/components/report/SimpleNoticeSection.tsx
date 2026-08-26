import { useState } from "react";
import { MessageSquareWarning, User } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SectionCard } from "@/components/admin/shared";
import { RecentNoticesSection } from "@/components/report/RecentNoticesSection";
import { useApi } from "@/hooks/useApi";
import { ApiError } from "@/lib/api/client";
import type { PushSendToMemberResponse } from "@/lib/api/types";

// TODO: 실제 알림 원인 옵션은 나중에 채운다 — 지금은 드롭다운 모양만 잡아둔 상태.
const NOTICE_REASON_OPTIONS: { value: string; label: string }[] = [];

// "제보"와 같은 메뉴에서, 타이머를 실수로 안 켠 참여자처럼 화면까지 확인할
// 필요 없는 사소한 상황을 가볍게 알려주는 용도. 대상은 현재 접속 중인
// 참여자 명단(부모가 useRosterPolling으로 이미 폴링 중인 것)에서 고르고,
// 실제 발송은 그 사람의 계정(이메일) 기준으로 등록된 푸시 구독을 찾아
// 보낸다 — 구독이 없으면(알림을 켠 적 없으면) 실패로 안내한다.
export function SimpleNoticeSection({
  members,
  noMembers,
  stale,
}: {
  members: string[];
  noMembers: boolean;
  stale: boolean;
}) {
  const { call } = useApi();
  const [nickname, setNickname] = useState("");
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ text: string; type: "error" | "ok" } | null>(null);
  const [noticeRefreshSignal, setNoticeRefreshSignal] = useState(0);

  async function handleSend() {
    if (!nickname) {
      setResult({ text: "수신 대상자를 선택해주세요.", type: "error" });
      return;
    }
    if (!reason) {
      setResult({ text: "전송 원인을 선택해주세요.", type: "error" });
      return;
    }
    setSending(true);
    setResult(null);
    try {
      await call<PushSendToMemberResponse>("/push/send-to-member", {
        method: "POST",
        body: { nickname, message: reason },
      });
      setResult({ text: `${nickname}님에게 알림을 보냈습니다.`, type: "ok" });
      setReason("");
      setNoticeRefreshSignal((n) => n + 1);
    } catch (err) {
      setResult({ text: err instanceof ApiError ? err.message : "네트워크 오류입니다.", type: "error" });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionCard className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label className="flex items-center gap-1.25 text-xs font-semibold text-muted-foreground sm:text-sm">
            <User className="size-3 shrink-0 sm:size-3.5" />
            수신 대상자
          </Label>
          <Select value={nickname} onValueChange={(v) => setNickname(v ?? "")} disabled={stale || noMembers}>
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
          <Label htmlFor="notice-reason" className="flex items-center gap-1.25 text-xs font-semibold text-muted-foreground sm:text-sm">
            <MessageSquareWarning className="size-3 shrink-0 sm:size-3.5" />
            전송 원인
          </Label>
          <Select value={reason} onValueChange={(v) => setReason(v ?? "")} disabled={stale}>
            <SelectTrigger id="notice-reason" className="w-full data-[size=default]:h-8 sm:data-[size=default]:h-12 sm:text-base">
              <SelectValue placeholder="원인을 선택해 주세요." />
            </SelectTrigger>
            <SelectContent>
              {NOTICE_REASON_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="sm:text-base">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          className="w-full border-primary hover:bg-primary/10 sm:h-12 sm:text-base"
          variant="outline"
          disabled={sending || stale}
          onClick={handleSend}
        >
          {sending ? "보내는 중..." : "알림 보내기"}
        </Button>
      </SectionCard>

      <RecentNoticesSection refreshSignal={noticeRefreshSignal} />

      {result && (
        <Alert variant={result.type === "error" ? "destructive" : "default"}>
          <AlertDescription>{result.text}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
