import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { ApiError } from "@/lib/api/client";
import type { LeaveApplyResponse, SetLeaveApplyResponse } from "@/lib/api/types";

// 선택한 요일(day)에 한해 일반반휴/사유반휴를 신청/취소한다.
export function LeaveApplyButton({ type, day, label }: { type: "normal" | "reason"; day: string; label: string }) {
  const { call } = useApi();
  const [state, setState] = useState<LeaveApplyResponse | "loading" | "error">("loading");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setState("loading");
    call<LeaveApplyResponse>(`/leave-apply?type=${type}&day=${encodeURIComponent(day)}`)
      .then(setState)
      .catch(() => setState("error"));
  }

  useEffect(load, [type, day]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggle() {
    if (state === "loading" || state === "error") return;
    setPending(true);
    setError(null);
    try {
      const data = await call<SetLeaveApplyResponse>("/leave-apply", {
        method: "POST",
        body: { type, day, applied: !state.applied },
      });
      setState((prev) => (prev === "loading" || prev === "error" ? prev : { ...prev, applied: data.applied }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "요청에 실패했습니다.");
    } finally {
      setPending(false);
    }
  }

  if (state === "loading") {
    return (
      <Button variant="outline" className="w-full sm:h-11" disabled>
        불러오는 중...
      </Button>
    );
  }
  if (state === "error") {
    return (
      <Button variant="outline" className="w-full sm:h-11" onClick={load}>
        다시 시도
      </Button>
    );
  }

  const disabled = pending || (!state.applied && state.left <= 0);

  return (
    <div className="flex flex-col gap-1">
      <Button
        variant={state.applied ? "destructive" : "outline"}
        className="w-full sm:h-11"
        disabled={disabled}
        onClick={toggle}
      >
        {pending ? "처리 중..." : state.applied ? `${label} 신청 취소` : `${label} 신청`}
      </Button>
      {!state.applied && state.left <= 0 && (
        <p className="text-center text-micro text-muted-foreground sm:text-micro-lg">
          {label} 잔여량이 없습니다.
        </p>
      )}
      {error && <p className="text-center text-micro text-destructive sm:text-micro-lg">{error}</p>}
    </div>
  );
}
