import { useState } from "react";
import { Timer, Award, ChevronDown, ChevronUp, User } from "lucide-react";
import { ICON_STROKE } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { InfoCard, DividedValue } from "@/components/dashboard/shared";
import type { RosterMember } from "@/lib/api/types";

const COLLAPSED_COUNT = 7;

// 시트가 이미 이모지로 주는 1~4위(🥇🥈🥉🏅)에 더해, 숫자로만 오는 5위도
// 4위와 같은 배지(🏅)로 보여준다 — 4/5위는 동일한 등급으로 취급.
// "이번 주 정산"(RosterPage)도 같은 매핑을 재사용해 랭킹 화면과 등급
// 표시를 맞춘다.
export const RANK_EMOJI: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉", 4: "🏅", 5: "🏅" };
const MEDAL_RANK: Record<string, number> = { "🥇": 1, "🥈": 2, "🥉": 3, "🏅": 4 };

function isMedalRank(rank: string) {
  return rank in MEDAL_RANK;
}

function rankValue(rank: string): number {
  if (!rank || rank === "-") return Infinity;
  if (rank in MEDAL_RANK) return MEDAL_RANK[rank];
  const n = parseInt(rank, 10);
  return Number.isNaN(n) ? Infinity : n;
}

export function RankBadge({ rank }: { rank: string }) {
  if (!rank || rank === "-") {
    return <span className="w-7 shrink-0 text-center text-sm text-muted-foreground sm:text-base">-</span>;
  }
  if (isMedalRank(rank)) {
    return <span className="w-7 shrink-0 text-center text-lg sm:text-xl">{rank}</span>;
  }
  const value = rankValue(rank);
  if (value in RANK_EMOJI) {
    return <span className="w-7 shrink-0 text-center text-lg sm:text-xl">{RANK_EMOJI[value]}</span>;
  }
  return (
    <span className="flex w-7 shrink-0 items-center justify-center text-sm font-bold tabular-nums text-muted-foreground sm:text-base">
      {rank}
    </span>
  );
}

// RankBadge와 같은 판정 로직(1~5위 메달, 그 외 숫자)을 쓰되, 리스트 정렬용
// 고정폭(w-7) 없이 인라인 텍스트로 표시한다 — 대시보드 요약 타일처럼 값 하나만
// 짧게 보여주는 자리에서 쓴다.
export function formatRankInline(rank: string): string {
  if (!rank || rank === "-") return "-";
  if (isMedalRank(rank)) return rank;
  const value = rankValue(rank);
  if (value in RANK_EMOJI) return RANK_EMOJI[value];
  return `${rank}위`;
}

// timer는 백엔드에서 "달성 / 목표"(예: "42:10 / 50:00") 형태로 오는데,
// 여기서는 목표시간 없이 달성 시간만 보여준다. AdminMoneyTab의 "상금
// 수령 대상자 처리"도 이 화면과 동일한 타이머·상점 서브로우를 그대로
// 재활용하면서 세 번째 항목(분배 금액)만 덧붙이므로 함께 export한다.
export function achievedTime(timer: string): string {
  const [achieved] = timer.split("/");
  return achieved?.trim() || "";
}

// 순위(뱃지) 오름차순으로 정렬한다 — 단, 전원의 순위가 비어있으면("-") 순위로는
// 정렬 순서를 정할 수 없으므로 시트 번호(회원번호) 오름차순으로 대신한다.
function sortMembers(members: RosterMember[]): RosterMember[] {
  const hasAnyRank = members.some((m) => rankValue(m.rank) !== Infinity);
  if (hasAnyRank) {
    return [...members].sort((a, b) => rankValue(a.rank) - rankValue(b.rank));
  }
  return [...members].sort((a, b) => (parseInt(a.number, 10) || 0) - (parseInt(b.number, 10) || 0));
}

// 🔧 2026-09: RosterPage가 로딩 중엔 "불러오는 중..." 텍스트 한 줄만
// 보여주다가 응답이 오면 카드 여러 개가 한꺼번에 나타나 레이아웃이 크게
// 밀렸다(사용자 지적) — 실제 카드(RankBadge+이름+타이머/상점)와 같은
// 크기의 펄스 스켈레톤을 미리 그려둔다.
export function RosterViewSkeleton() {
  return (
    <div className="flex flex-col gap-2 sm:gap-2.5" aria-hidden>
      {Array.from({ length: COLLAPSED_COUNT }).map((_, i) => (
        <InfoCard key={i} className="flex animate-pulse items-center gap-3 sm:gap-4">
          <span className="size-7 shrink-0 rounded-full bg-muted" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="h-3.5 w-24 rounded bg-muted sm:h-4 sm:w-32" />
            <span className="h-3 w-36 rounded bg-muted sm:h-3.5 sm:w-44" />
          </div>
        </InfoCard>
      ))}
    </div>
  );
}

// 실시간 조회(RosterPage)와 지난 주 스냅샷(SnapshotPage) 모두 같은 형태로
// 데이터를 보여줘야 해서, fetch 로직과 표시 로직을 분리해 이 컴포넌트를 공유한다.
export function RosterView({ members }: { members: RosterMember[] }) {
  const [expanded, setExpanded] = useState(false);

  if (members.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">참여 중인 멤버가 없습니다.</p>;
  }

  const sorted = sortMembers(members);
  const visible = expanded ? sorted : sorted.slice(0, COLLAPSED_COUNT);
  const hiddenCount = sorted.length - visible.length;

  return (
    <div className="flex flex-col gap-2 sm:gap-2.5">
      {visible.map((m, i) => (
        <InfoCard key={`${m.name}-${i}`} className="flex items-center justify-between gap-3 bg-card sm:gap-4">
          <span className="flex min-w-0 items-center gap-3 sm:gap-4">
            <RankBadge rank={m.rank} />
            <User className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
            <span className="truncate text-sm sm:text-base">{m.name}</span>
          </span>
          <span className="shrink-0 text-sm tabular-nums sm:text-base">
            <DividedValue
              items={[
                <span key="timer" className="inline-flex items-center gap-1">
                  <Timer className="size-3 shrink-0 text-muted-foreground sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                  {achievedTime(m.timer) || "-"}
                </span>,
                <span key="merit" className="inline-flex items-center gap-1">
                  <Award className="size-3 shrink-0 text-muted-foreground sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                  {m.merit ? `+${m.merit}점` : "-"}
                </span>,
              ]}
            />
          </span>
        </InfoCard>
      ))}
      {expanded ? (
        sorted.length > COLLAPSED_COUNT && (
          <Button
            type="button"
            variant="outline"
            className="w-full gap-1.5 whitespace-nowrap sm:h-11 sm:text-base"
            onClick={() => setExpanded(false)}
          >
            <ChevronUp className="size-3.5 shrink-0 sm:size-4" strokeWidth={ICON_STROKE.default} />
            <span>접기</span>
          </Button>
        )
      ) : (
        hiddenCount > 0 && (
          <Button
            type="button"
            variant="outline"
            className="w-full gap-1.5 whitespace-nowrap sm:h-11 sm:text-base"
            onClick={() => setExpanded(true)}
          >
            <ChevronDown className="size-3.5 shrink-0 sm:size-4" strokeWidth={ICON_STROKE.default} />
            <span>더 보기 ({hiddenCount}명)</span>
          </Button>
        )
      )}
    </div>
  );
}
