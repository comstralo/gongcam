import { useEffect, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { ApiError } from "@/lib/api/client";
import { MAX_LEAVES_PER_DAY } from "@/components/dashboard/shared";
import type { LeaveApplyResponse, SetLeaveApplyResponse } from "@/lib/api/types";

// 선택한 요일(day)의 일반반휴 신청을 all-or-nothing으로 다룬다: 아직
// 신청 전이면 좌측 -/+ 스테퍼로 장수(1~2)를 고른 뒤 "신청"을 눌러야 반영되고,
// 이미 신청됐으면 스테퍼는 잠기고(부분 변경 불가) "취소" 버튼만 눌러 한
// 번에 0으로 되돌릴 수 있다 — 신청된 장수를 1↔2로 바꾸려면 먼저 취소한
// 뒤 새로 신청해야 한다.
// onApplied: 신청/취소가 실제로 반영됐을 때 그 변화량(delta, 음수 가능)을
// 부모에 알려, 요일 카드의 "일반반휴" 카운트를 새로고침 없이 즉시 갱신한다.
export function LeaveApplyButton({
  day,
  dayFull,
  onApplied,
}: {
  day: string;
  // 이 요일에 이미 반휴(일반+사유 합산) 상한을 다 썼는지 — true면 현재
  // 저장된 값보다 늘리는 조작만 막는다(줄이는 것은 항상 허용).
  dayFull?: boolean;
  onApplied?: (delta: number) => void;
}) {
  const { call } = useApi();
  const [state, setState] = useState<LeaveApplyResponse | "loading" | "error">("loading");
  const [draft, setDraft] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setState("loading");
    call<LeaveApplyResponse>(`/leave-apply?type=normal&day=${encodeURIComponent(day)}`)
      .then((data) => {
        // count/left는 항상 숫자를 기대하지만, 구버전 응답 등 예상 밖의 값이
        // 오더라도 NaN이 draft/maxDraft 계산에 퍼지지 않도록 방어한다.
        const count = Number.isFinite(data.count) ? data.count : 0;
        const left = Number.isFinite(data.left) ? data.left : 0;
        setState({ ...data, count, left });
        setDraft(count);
      })
      .catch(() => setState("error"));
  }

  useEffect(load, [day]); // eslint-disable-line react-hooks/exhaustive-deps

  async function apply(nextValue: number) {
    if (state === "loading" || state === "error") return;
    const prevCount = state.count;
    if (nextValue === prevCount) return;
    setPending(true);
    setError(null);
    try {
      const data = await call<SetLeaveApplyResponse>("/leave-apply", {
        method: "POST",
        body: { type: "normal", day, count: nextValue },
      });
      const nextCount = Number.isFinite(data.count) ? data.count : nextValue;
      // left(전체 잔여)는 시트 수식(=2-SUMPRODUCT(...))이 "이번 주 전체
      // 요일" 사용량으로 계산하므로, 이 요일의 count가 바뀐 만큼 반대
      // 방향으로 즉시 보정해야 한다 — 그러지 않으면 취소 직후에도 이전
      // 조회 시점의 낡은 left(이 요일 사용이 아직 포함된 값)가 남아 "잔여량
      // 없음"으로 잘못 표시된다. 다음 load()에서 서버 값으로 다시 맞춰진다.
      const countDelta = nextCount - prevCount;
      setState((prev) =>
        prev === "loading" || prev === "error"
          ? prev
          : { ...prev, applied: data.applied, count: nextCount, left: Math.max(0, prev.left - countDelta) }
      );
      setDraft(nextCount);
      if (countDelta !== 0) onApplied?.(countDelta);
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

  // 이미 신청된 상태(applied)에서는 스테퍼를 잠그고 draft를 저장된 값에
  // 고정한다 — 부분 변경 없이 "취소"로 0으로 되돌리는 것만 허용한다.
  const applied = state.count > 0;
  // 신청 전 스테퍼로 고를 수 있는 최대치: 유형 상한(MAX_LEAVES_PER_DAY),
  // 시트 전체 잔여량, dayFull(하루 합산 상한 도달) 여부를 모두 반영한다.
  const maxDraft = dayFull ? 0 : Math.min(MAX_LEAVES_PER_DAY, state.left);
  const noLeftToIncrease = state.left <= 0;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <div className="flex h-8 items-center rounded-lg border sm:h-11">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-full w-8 shrink-0 rounded-r-none sm:w-11"
            disabled={pending || applied || draft <= 0}
            onClick={() => setDraft((d) => Math.max(0, d - 1))}
            aria-label="일반반휴 장수 줄이기"
          >
            <Minus className="size-3.5" />
          </Button>
          <span className="w-6 text-center text-sm font-semibold tabular-nums sm:text-base">{draft}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-full w-8 shrink-0 rounded-l-none sm:w-11"
            disabled={pending || applied || draft >= maxDraft}
            onClick={() => setDraft((d) => Math.min(maxDraft, d + 1))}
            aria-label="일반반휴 장수 늘리기"
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
        {applied ? (
          <Button
            variant="destructive"
            className="min-w-0 flex-1 sm:h-11"
            disabled={pending}
            onClick={() => apply(0)}
          >
            {pending ? "처리 중..." : "취소"}
          </Button>
        ) : (
          <Button
            className="min-w-0 flex-1 sm:h-11"
            disabled={pending || draft === 0}
            onClick={() => apply(draft)}
          >
            {pending ? "처리 중..." : "신청"}
          </Button>
        )}
      </div>
      {!applied && draft >= maxDraft && noLeftToIncrease && (
        <p className="text-center text-micro text-muted-foreground sm:text-micro-lg">
          일반반휴 잔여량이 없습니다.
        </p>
      )}
      {error && <p className="text-center text-micro text-destructive sm:text-micro-lg">{error}</p>}
    </div>
  );
}
