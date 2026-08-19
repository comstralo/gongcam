import { Timer } from "lucide-react";
import { ICON_STROKE } from "@/lib/utils";
import { InfoCard, TintedPill, ItemTitle } from "@/components/dashboard/shared";
import type { RosterMember } from "@/lib/api/types";

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

const MEDAL_RANK: Record<string, number> = { "🥇": 1, "🥈": 2, "🥉": 3, "🏅": 4 };

function rankValue(rank: string): number {
  if (!rank || rank === "-") return Infinity;
  if (rank in MEDAL_RANK) return MEDAL_RANK[rank];
  const n = parseInt(rank, 10);
  return Number.isNaN(n) ? Infinity : n;
}

function sortByRank(members: RosterMember[]): RosterMember[] {
  return [...members].sort((a, b) => rankValue(a.rank) - rankValue(b.rank));
}

// 실시간 조회(RosterPage)와 지난 주 스냅샷(SnapshotPage) 모두 같은 형태로
// 데이터를 보여줘야 해서, fetch 로직과 표시 로직을 분리해 이 컴포넌트를 공유한다.
export function RosterView({ members }: { members: RosterMember[] }) {
  if (members.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">참여 중인 멤버가 없습니다.</p>;
  }

  const sorted = sortByRank(members);

  return (
    <div className="flex flex-col gap-2 sm:gap-2.5">
      {sorted.map((m, i) => (
        <InfoCard key={`${m.name}-${i}`} className="flex items-center gap-3 sm:gap-4">
          <RankBadge rank={m.rank} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <ItemTitle className="truncate">{m.name}</ItemTitle>
            <span className="inline-flex items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground sm:text-sm">
              <Timer className="size-3 shrink-0 sm:size-3.5" strokeWidth={ICON_STROKE.default} />
              {m.timer || "-"}
            </span>
          </div>
          <TintedPill tone={statusTone(m.status)} className="shrink-0">
            {m.status || "-"}
          </TintedPill>
        </InfoCard>
      ))}
    </div>
  );
}
