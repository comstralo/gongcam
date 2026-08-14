import { useEffect, useState } from "react";
import { Timer } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useApi } from "@/hooks/useApi";
import type { RosterMember, RosterStatusResponse } from "@/lib/api/types";
import { cn } from "@/lib/utils";

function isMedalRank(rank: string) {
  return rank === "🥇" || rank === "🥈" || rank === "🥉" || rank === "🏅";
}

function RankBadge({ rank }: { rank: string }) {
  if (!rank || rank === "-") {
    return <span className="w-7 shrink-0 text-center text-sm text-muted-foreground sm:text-base">-</span>;
  }
  if (isMedalRank(rank)) {
    return <span className="w-7 shrink-0 text-center text-lg sm:text-xl">{rank}</span>;
  }
  return (
    <span className="flex w-7 shrink-0 items-center justify-center text-sm font-bold tabular-nums text-muted-foreground sm:text-base">
      {rank}
    </span>
  );
}

function statusTone(status: string): "ok" | "warn" | "muted" {
  if (status.includes("미납") || status.includes("미해결")) return "warn";
  if (status === "-" || status === "빈 시트" || status === "달성시간 미등록") return "muted";
  return "ok";
}

export function RosterPage() {
  const { call } = useApi();
  const [members, setMembers] = useState<RosterMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    call<RosterStatusResponse>("/roster-status")
      .then((data) => {
        if (!cancelled) setMembers(data.members || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "전체 대시보드를 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card className="w-full">
      <CardContent className="flex flex-col gap-2 sm:gap-2.5">
        {members?.map((m, i) => {
          const tone = statusTone(m.status);
          return (
            <div
              key={`${m.name}-${i}`}
              className="flex items-center gap-3 rounded-xl border bg-muted px-3.5 py-3 sm:gap-4 sm:px-4 sm:py-3.5"
            >
              <RankBadge rank={m.rank} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-bold sm:text-base">{m.name}</span>
                <span className="inline-flex items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground sm:text-sm">
                  <Timer className="size-3 shrink-0 sm:size-3.5" strokeWidth={2.25} />
                  {m.timer || "-"}
                </span>
              </div>
              <span
                className={cn(
                  "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold sm:text-xs",
                  tone === "ok" && "bg-ok/15 text-ok",
                  tone === "warn" && "bg-destructive/15 text-destructive",
                  tone === "muted" && "bg-foreground/8 text-muted-foreground"
                )}
              >
                {m.status || "-"}
              </span>
            </div>
          );
        })}

        {members && members.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">
            참여 중인 멤버가 없습니다.
          </p>
        )}

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
