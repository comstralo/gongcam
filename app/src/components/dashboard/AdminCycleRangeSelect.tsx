import { useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatWeekOfDate, thisWeekRange } from "@/components/dashboard/shared";
import { useApi } from "@/hooks/useApi";
import type { CycleGroup, CycleGroupListResponse } from "@/lib/api/types";

function groupLabel(group: CycleGroup): string {
  // 진행 중 사이클이 아직 1주차라 완결된 백업이 하나도 없으면
  // startWeekOf가 null로 온다 — 이번 주 자체가 사이클의 시작이므로
  // thisWeekRange().start를 그대로 시작일로 쓴다("?" 표시 방지).
  const start = group.startWeekOf
    ? formatWeekOfDate(group.startWeekOf)
    : group.isCurrent
      ? thisWeekRange().start
      : "?";
  const end = group.isCurrent ? thisWeekRange().end : group.endWeekOf ? formatWeekOfDate(group.endWeekOf) : "?";
  return `${start} ~ ${end}`;
}

// 드롭다운에서 "미지정"(사이클 고정 해제, 기존 꼬리물기 방식으로 복귀)을
// 고르기 위한 특수값 — 실제 그룹의 cycleKey와 겹치지 않도록 접두사를 둔다.
const UNSET_VALUE = "__unset__";

// 🔧 [사용자 지시] "주차 토글 옆에 관리자만 확인할 수 있는 사이클 범위를
// 지정할 수 있는 기능" + "UI가 번잡하지 않게, 토글은 기존 것을 재활용" —
// 이 컴포넌트는 사이클(3주 묶음)을 고르는 드롭다운 하나만 담당한다. 주차
// 이동(화살표 UI)은 자체 구현하지 않고, 여기서 고른 그룹을 부모가
// CycleSwitcher의 overrideGroup prop으로 넘겨 그 화살표를 그대로
// 재사용한다(화면에 화살표 UI가 두 벌 생기지 않도록).
export function AdminCycleRangeSelect({
  activeFileId,
  overriding,
  onSelectGroup,
}: {
  // 지금 실제로 조회 중인 fileId(CycleSwitcher가 이동시킨 결과) — 이
  // 값이 속한 그룹을 드롭다운에서 하이라이트한다. null이면 진행 중
  // 사이클의 "이번 주".
  activeFileId: string | null;
  // 🔧 [사용자 지시] "미지정을 누르면 기존같이 꼬리물기처럼 동작" — 부모가
  // overrideGroup을 이미 해제한 상태(=꼬리물기 모드로 돌아간 상태)인지.
  // false면 드롭다운이 "미지정"을 선택된 상태로 보여준다(activeFileId만
  // 봐서는 "미지정"과 "마침 진행 중 그룹의 이번 주를 고른 상태"를 구분할
  // 수 없어 별도로 받는다).
  overriding: boolean;
  onSelectGroup: (group: CycleGroup | null) => void;
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

  const currentGroupIndex = groups.findIndex((g) => g.isCurrent);
  const matchedIndex = activeFileId === null ? -1 : groups.findIndex((g) => g.weeks.some((w) => w.fileId === activeFileId));
  const groupIndex = overriding ? (matchedIndex === -1 ? currentGroupIndex : matchedIndex) : -1;
  const value = groupIndex === -1 ? UNSET_VALUE : String(groupIndex);

  function handleChange(v: string | null) {
    if (!v || v === UNSET_VALUE) {
      onSelectGroup(null);
      return;
    }
    onSelectGroup(groups![Number(v)]);
  }

  return (
    <Select value={value} onValueChange={handleChange}>
      <SelectTrigger className="w-fit shrink-0 bg-card data-[size=default]:h-7 sm:text-sm">
        <SelectValue>{groupIndex === -1 ? "미지정" : groupLabel(groups[groupIndex])}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNSET_VALUE} className="sm:text-base">
          미지정
        </SelectItem>
        {groups.map((g, i) => (
          <SelectItem key={g.cycleKey} value={String(i)} className="sm:text-base">
            {groupLabel(g)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
