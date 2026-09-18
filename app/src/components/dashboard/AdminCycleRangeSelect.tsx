import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TintedPill } from "@/components/dashboard/shared";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import type { CycleGroup, CycleGroupListResponse, CycleWeek } from "@/lib/api/types";

// weekOf/weekTo는 백업 파일명에서 온 "YYMMDD" 형식이다 — CycleSwitcher의
// formatDate와 동일한 표시 규칙.
function formatDate(raw: string) {
  const m = raw.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!m) return raw;
  const [, , mm, dd] = m;
  return `${mm}.${dd}`;
}

function thisWeekRange(): { start: string; end: string } {
  const now = new Date();
  const todayIndex = (now.getDay() + 6) % 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - todayIndex);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (d: Date) => `${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
  return { start: fmt(monday), end: fmt(sunday) };
}

// 진행 중 사이클은 서버가 "이번 주"(fileId 없음) 슬롯을 weeks 배열에 안
// 담아 보내므로, CycleSwitcher와 동일하게 여기서 합성해 넣는다.
function slotsOf(group: CycleGroup): (CycleWeek | null)[] {
  const oldestFirst = [...group.weeks].reverse();
  return group.isCurrent ? [...oldestFirst, null] : oldestFirst;
}

function groupLabel(group: CycleGroup): string {
  const start = group.startWeekOf ? formatDate(group.startWeekOf) : "?";
  const end = group.isCurrent ? thisWeekRange().end : group.endWeekOf ? formatDate(group.endWeekOf) : "?";
  return `${start} ~ ${end}`;
}

// 🔧 [사용자 지시] "주차 토글 옆에 관리자만 확인할 수 있는 사이클 범위를
// 지정할 수 있는 기능" — 기존 CycleSwitcher(현재 사이클 안에서 꼬리물기
// 이동)는 미납/미처리 확인용으로 그대로 두고, 그 옆에 "사이클(3주 묶음)을
// 먼저 고르고, 그 안의 1~3주차로 딱 끊어서 이동"하는 이 드롭다운을
// 별도로 추가한다. 백업이 남아있는 한 전체 과거 사이클을 조회 대상으로
// 삼는다는 점이 CycleSwitcher(현재 사이클로만 제한)와의 핵심 차이.
export function AdminCycleRangeSelect({
  value,
  onSelect,
}: {
  // 선택된 fileId — null이면 "이번 주"(진행 중 사이클의 실시간 슬롯).
  value: string | null;
  onSelect: (fileId: string | null, week?: CycleWeek | null) => void;
}) {
  const { call } = useApi();
  const [groups, setGroups] = useState<CycleGroup[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    call<CycleGroupListResponse>("/admin/cycles")
      .then((data) => {
        if (!cancelled) setGroups(data.groups || []);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error || !groups || groups.length === 0) return null;

  // value(선택된 fileId)가 속한 그룹을 찾는다 — null(이번 주)이면 진행 중
  // 그룹, 그 외엔 weeks 배열에서 fileId가 일치하는 그룹을 찾는다. 못
  // 찾으면(아직 아무것도 안 고름) 진행 중 그룹을 기본값으로 삼는다.
  const currentGroupIndex = groups.findIndex((g) => g.isCurrent);
  const selectedGroupIndex =
    value === null
      ? currentGroupIndex
      : groups.findIndex((g) => g.weeks.some((w) => w.fileId === value));
  const groupIndex = selectedGroupIndex === -1 ? currentGroupIndex : selectedGroupIndex;
  const group = groups[groupIndex];
  const slots = slotsOf(group);

  const weekIndex = value === null ? slots.length - 1 : slots.findIndex((w) => w?.fileId === value);
  const browseIndex = weekIndex === -1 ? slots.length - 1 : weekIndex;
  const browsedSlot = slots[browseIndex];
  const browsedIsThisWeek = group.isCurrent && browseIndex === slots.length - 1;

  function selectGroup(nextGroupIndex: number) {
    const nextGroup = groups![nextGroupIndex];
    const nextSlots = slotsOf(nextGroup);
    // 사이클을 바꾸면 항상 그 사이클의 가장 마지막(최신) 주차로 진입한다.
    const last = nextSlots[nextSlots.length - 1];
    onSelect(last ? last.fileId : null, last ?? null);
  }

  function step(delta: 1 | -1) {
    const next = browseIndex + delta;
    if (next < 0 || next >= slots.length) return;
    const target = slots[next];
    onSelect(target ? target.fileId : null, target ?? null);
  }

  return (
    <div className="flex w-full items-center justify-center gap-2">
      <Select value={String(groupIndex)} onValueChange={(v) => selectGroup(Number(v))}>
        <SelectTrigger className="w-fit shrink-0 bg-card data-[size=default]:h-7 sm:text-sm">
          <SelectValue>{groupLabel(group)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {groups.map((g, i) => (
            <SelectItem key={g.cycleKey} value={String(i)} className="sm:text-base">
              <span className="inline-flex items-center gap-1.5">
                {groupLabel(g)}
                {g.isCurrent && (
                  <TintedPill tone="primary" className="px-1.5 py-0">
                    진행
                  </TintedPill>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <button
        type="button"
        onClick={() => step(-1)}
        disabled={browseIndex <= 0}
        aria-label="사이클 내 이전 주차"
        className="flex shrink-0 items-center justify-center rounded-full p-1 text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-25"
      >
        <ChevronLeft className="size-4 sm:size-5" strokeWidth={2.5} />
      </button>

      <span className={cn("text-sm font-medium sm:text-base", "whitespace-nowrap")}>
        {browseIndex + 1}주차{" "}
        {browsedIsThisWeek
          ? `(${thisWeekRange().start} ~ ${thisWeekRange().end})`
          : browsedSlot
            ? `(${formatDate(browsedSlot.weekOf)} ~ ${formatDate(browsedSlot.weekTo)})`
            : ""}
      </span>

      <button
        type="button"
        onClick={() => step(1)}
        disabled={browseIndex >= slots.length - 1}
        aria-label="사이클 내 다음 주차"
        className="flex shrink-0 items-center justify-center rounded-full p-1 text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-25"
      >
        <ChevronRight className="size-4 sm:size-5" strokeWidth={2.5} />
      </button>
    </div>
  );
}
