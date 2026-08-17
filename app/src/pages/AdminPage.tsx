import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SessionCard } from "@/components/session/SessionCard";
import { StatusView } from "@/components/dashboard/StatusView";
import { usePushSubscription } from "@/hooks/usePushSubscription";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import type { AdminMember, AdminMembersResponse, StatusResponse } from "@/lib/api/types";

const STATE_LABEL: Record<string, string> = {
  checking: "알림 상태 확인 중...",
  on: "알림 켜짐 · 이 브라우저는 구독 중",
  off: "알림 꺼짐 · 아직 구독하지 않음",
  unsupported: "이 브라우저는 푸시 알림을 지원하지 않습니다.",
};

export function AdminPage() {
  const { state, message, enable, sendTest } = usePushSubscription();
  const { call } = useApi();

  const [members, setMembers] = useState<AdminMember[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [selectedNumber, setSelectedNumber] = useState<string>("");
  const [memberStatus, setMemberStatus] = useState<StatusResponse | null>(null);
  const [memberStatusError, setMemberStatusError] = useState<string | null>(null);
  const [loadingMemberStatus, setLoadingMemberStatus] = useState(false);

  useEffect(() => {
    call<AdminMembersResponse>("/admin/members")
      .then((data) => setMembers(data.members || []))
      .catch((err) => setMembersError(err instanceof Error ? err.message : "회원 목록을 불러오지 못했습니다."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedNumber) return;
    let cancelled = false;
    setLoadingMemberStatus(true);
    setMemberStatusError(null);
    call<StatusResponse>(`/admin/members/${encodeURIComponent(selectedNumber)}`)
      .then((data) => {
        if (!cancelled) setMemberStatus(data);
      })
      .catch((err) => {
        if (!cancelled) setMemberStatusError(err instanceof Error ? err.message : "회원 기록을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!cancelled) setLoadingMemberStatus(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNumber]);

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
          스터디원 기록 조회
        </span>
        <Select value={selectedNumber} onValueChange={(v) => setSelectedNumber(v ?? "")}>
          <SelectTrigger className="sm:h-12 sm:text-base">
            <SelectValue
              placeholder={
                membersError ? "회원 목록을 불러오지 못했습니다" : members === null ? "불러오는 중..." : "스터디원을 선택하세요"
              }
            >
              {selectedNumber ? members?.find((m) => m.number === selectedNumber)?.name : undefined}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {members?.map((m) => (
              <SelectItem key={m.number} value={m.number} className="sm:text-base">
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {membersError && (
          <Alert variant="destructive">
            <AlertDescription>{membersError}</AlertDescription>
          </Alert>
        )}

        {selectedNumber && (
          <div className="flex flex-col gap-3">
            {loadingMemberStatus && (
              <p className="text-center font-mono text-xs text-muted-foreground sm:text-sm">불러오는 중...</p>
            )}
            {memberStatusError && (
              <Alert variant="destructive">
                <AlertDescription>{memberStatusError}</AlertDescription>
              </Alert>
            )}
            {memberStatus && <StatusView status={memberStatus} />}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
