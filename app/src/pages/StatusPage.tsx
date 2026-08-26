import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusView } from "@/components/dashboard/StatusView";
import { CycleSwitcher } from "@/components/dashboard/CycleSwitcher";
import { NotificationDialog } from "@/components/dashboard/NotificationDialog";
import { useApi } from "@/hooks/useApi";
import { useAuth } from "@/lib/auth/useAuth";
import type { AdminMember, AdminMembersResponse, StatusResponse } from "@/lib/api/types";

// 회원번호로 "본인"을 표시하는 특수값 — 실제 회원번호와 겹치지 않도록 접두사를 둔다.
const SELF_VALUE = "__self__";

export function StatusPage({
  cycleFileId,
  onSelectCycle,
}: {
  cycleFileId?: string | null;
  onSelectCycle?: (fileId: string | null) => void;
}) {
  const { call } = useApi();
  const { isAdmin } = useAuth();

  const [members, setMembers] = useState<AdminMember[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(SELF_VALUE);

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // 과거 사이클(cycleFileId 지정) 조회 중엔 관리자의 다른 회원 선택을
  // 지원하지 않는다 — /admin/members/{number}는 실시간 조회 전용이다.
  const isViewingCycle = !!cycleFileId;

  // 관리자만 다른 스터디원을 선택할 수 있으므로, 관리자일 때만 회원 목록을 불러온다.
  useEffect(() => {
    if (!isAdmin || isViewingCycle) return;
    call<AdminMembersResponse>("/admin/members")
      .then((data) => setMembers(data.members || []))
      .catch((err) => setMembersError(err instanceof Error ? err.message : "회원 목록을 불러오지 못했습니다."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, isViewingCycle]);

  function reload() {
    let cancelled = false;
    setLoading(true);
    setError(null);
    let path: string;
    if (isViewingCycle || selected === SELF_VALUE) {
      path = cycleFileId ? `/status?cycle=${encodeURIComponent(String(cycleFileId))}` : "/status";
    } else {
      path = `/admin/members/${encodeURIComponent(selected)}`;
    }
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
  }

  useEffect(reload, [selected, cycleFileId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card className="w-full">
      <CardContent className="flex flex-col gap-5">
        {isAdmin && !isViewingCycle && (
          <Select value={selected} onValueChange={(v) => setSelected(v ?? SELF_VALUE)}>
            <SelectTrigger className="w-fit data-[size=default]:h-9 sm:data-[size=default]:h-11 sm:text-base">
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

        <div className="flex items-center gap-3">
          {onSelectCycle && (
            <div className="flex-1">
              <CycleSwitcher selectedFileId={cycleFileId ?? null} onSelect={onSelectCycle} />
            </div>
          )}
          <NotificationDialog />
        </div>
        {membersError && (
          <Alert variant="destructive">
            <AlertDescription>{membersError}</AlertDescription>
          </Alert>
        )}

        <StatusView
          status={status}
          allowGoalSchedule={!isViewingCycle && selected === SELF_VALUE}
          isViewingCycle={isViewingCycle}
          onLeaveApplied={(day, type, delta) => {
            setStatus((prev) => {
              if (!prev) return prev;
              const usedField = type === "normal" ? "normalLeaveUsed" : "reasonLeaveUsed";
              const leftField = type === "normal" ? "normalLeaveLeft" : "reasonLeaveLeft";
              // 신청(delta > 0)은 잔여량을 그만큼 줄이고, 취소(delta < 0)는
              // 그만큼 되돌린다 — 새로고침 없이 "반휴권 잔여량" 카드가 즉시
              // 맞아떨어지게 한다. left는 문자열(시트 표시값)이라 숫자로
              // 변환해 계산한 뒤 다시 문자열로 되돌린다.
              const nextLeft = Math.max(0, Number(prev[leftField] || 0) - delta);
              return {
                ...prev,
                [leftField]: String(nextLeft),
                days: prev.days.map((d) =>
                  d.day === day ? { ...d, [usedField]: Math.max(0, d[usedField] + delta) } : d
                ),
              };
            });
          }}
          onReasonLeaveSubmitted={reload}
        />
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
