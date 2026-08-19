import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusView } from "@/components/dashboard/StatusView";
import { useApi } from "@/hooks/useApi";
import { useAuth } from "@/lib/auth/useAuth";
import { ICON_STROKE } from "@/lib/utils";
import type { AdminMember, AdminMembersResponse, StatusResponse } from "@/lib/api/types";

// 회원번호로 "본인"을 표시하는 특수값 — 실제 회원번호와 겹치지 않도록 접두사를 둔다.
const SELF_VALUE = "__self__";

export function StatusPage() {
  const { call } = useApi();
  const { isAdmin } = useAuth();

  const [members, setMembers] = useState<AdminMember[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(SELF_VALUE);

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // 관리자만 다른 스터디원을 선택할 수 있으므로, 관리자일 때만 회원 목록을 불러온다.
  useEffect(() => {
    if (!isAdmin) return;
    call<AdminMembersResponse>("/admin/members")
      .then((data) => setMembers(data.members || []))
      .catch((err) => setMembersError(err instanceof Error ? err.message : "회원 목록을 불러오지 못했습니다."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const path = selected === SELF_VALUE ? "/status" : `/admin/members/${encodeURIComponent(selected)}`;
    call<StatusResponse>(path)
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "상태를 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  return (
    <Card className="w-full">
      <CardContent className="flex flex-col gap-5">
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-micro uppercase tracking-wide text-muted-foreground sm:text-xs">
            내 대시보드
          </span>
          <Button
            variant="outline"
            size="icon"
            className="size-9 shrink-0 rounded-full sm:size-10"
            aria-label="알림"
          >
            <Bell className="size-4 sm:size-4.5" strokeWidth={ICON_STROKE.default} />
          </Button>
        </div>
        {isAdmin && (
          <Select value={selected} onValueChange={(v) => setSelected(v ?? SELF_VALUE)}>
            <SelectTrigger className="data-[size=default]:h-8 sm:data-[size=default]:h-12 sm:text-base">
              <SelectValue>
                {selected === SELF_VALUE ? "내 대시보드" : members?.find((m) => m.number === selected)?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SELF_VALUE} className="sm:text-base">
                내 대시보드
              </SelectItem>
              {members?.map((m) => (
                <SelectItem key={m.number} value={m.number} className="sm:text-base">
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {membersError && (
          <Alert variant="destructive">
            <AlertDescription>{membersError}</AlertDescription>
          </Alert>
        )}

        <StatusView status={status} allowGoalSchedule={selected === SELF_VALUE} />
        {loading && <p className="text-center font-mono text-xs text-muted-foreground sm:text-sm">불러오는 중...</p>}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
