import { useEffect, useState } from "react";
import { BedDouble } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { ApiError } from "@/lib/api/client";
import type { NormalLeaveResponse, SetNormalLeaveResponse } from "@/lib/api/types";

// 오늘 요일에 한해서만 일반반휴를 신청/취소한다 — 지난 요일이나 관리자가
// 다른 회원을 조회 중일 때는 이 버튼 자체를 렌더링하지 않는다(호출부에서 제어).
export function NormalLeaveButton() {
  const { call } = useApi();
  const [state, setState] = useState<NormalLeaveResponse | "loading" | "error">("loading");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setState("loading");
    call<NormalLeaveResponse>("/normal-leave")
      .then(setState)
      .catch(() => setState("error"));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggle() {
    if (state === "loading" || state === "error") return;
    setPending(true);
    setError(null);
    try {
      const data = await call<SetNormalLeaveResponse>("/normal-leave", {
        method: "POST",
        body: { applied: !state.applied },
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
        <BedDouble className="size-3.5 sm:size-4" />
        {pending ? "처리 중..." : state.applied ? "일반반휴 신청 취소" : "일반반휴 신청"}
      </Button>
      {!state.applied && state.left <= 0 && (
        <p className="text-center text-micro text-muted-foreground sm:text-micro-lg">
          일반반휴 잔여량이 없습니다.
        </p>
      )}
      {error && <p className="text-center text-micro text-destructive sm:text-micro-lg">{error}</p>}
    </div>
  );
}
