import { useEffect, useState } from "react";
import { Trophy, PiggyBank } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { SectionHeader, SectionCard } from "@/components/admin/shared";
import { SubRow, won } from "@/components/dashboard/shared";
import { RosterView, RANK_EMOJI } from "@/components/dashboard/RosterView";
import { CycleSwitcher } from "@/components/dashboard/CycleSwitcher";
import { useApi } from "@/hooks/useApi";
import { useRefreshOnVisible } from "@/hooks/useRefreshOnVisible";
import { ICON_STROKE, cn } from "@/lib/utils";
import type { RosterMember, RosterStatusResponse, SettlementItem } from "@/lib/api/types";

type RosterMoney = {
  collectMoney: number;
  fineCarry: number;
  fineThisWeek: number;
  fineOuter: number;
  depositOuter?: number;
};

export function RosterPage({
  cycleFileId,
  onSelectCycle,
  visible = true,
}: {
  cycleFileId?: string | null;
  onSelectCycle?: (fileId: string | null) => void;
  visible?: boolean;
}) {
  const { call } = useApi();
  const [members, setMembers] = useState<RosterMember[] | null>(null);
  const [money, setMoney] = useState<RosterMoney | null>(null);
  // undefined: 아직 못 받아옴(로딩 중). null: 백엔드가 필드를 안 보냄(비공개 —
  // 스터디원이 일요일 14교시 종료 전에 조회한 경우).
  const [settlement, setSettlement] = useState<SettlementItem[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function load() {
    setLoading(true);
    setError(null);
    const path = cycleFileId
      ? `/roster-status?cycle=${encodeURIComponent(String(cycleFileId))}`
      : "/roster-status";
    call<RosterStatusResponse>(path)
      .then((data) => {
        setMembers(data.members || []);
        setMoney({
          collectMoney: data.collectMoney ?? 0,
          fineCarry: data.fineCarry ?? 0,
          fineThisWeek: data.fineThisWeek ?? 0,
          fineOuter: data.fineOuter ?? 0,
          // 백엔드가 이 필드를 아예 안 보낼 수 있다(총모금액 미포함 + 비관리자) —
          // undefined면 SubRow 자체를 숨긴다.
          depositOuter: data.depositOuter,
        });
        setSettlement(data.settlement ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "전체 대시보드를 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, [cycleFileId]); // eslint-disable-line react-hooks/exhaustive-deps
  // 다른 회원들의 타이머·순위·정산은 이 화면을 벗어난 사이에도 계속
  // 바뀐다 — "실시간 랭킹"을 표방하는 화면이라 돌아올 때마다 새로 불러온다.
  useRefreshOnVisible(visible, load);

  return (
    // 🔧 2026-09: 이 화면(전체 대시보드 "ALL" 탭)을 감싸던 바깥 Card/
    // CardContent를 제거했다(사용자 지시) — 안쪽 랭킹/상금 정산이 이미
    // 각자 SectionCard(자체 테두리+배경)로 감싸여 있어, 바깥 Card는
    // 이중 테두리·이중 배경만 만들 뿐 시각적으로 불필요했다.
    <div className="flex w-full flex-col gap-4">
      {onSelectCycle && <CycleSwitcher selectedFileId={cycleFileId ?? null} onSelect={onSelectCycle} />}

      <SectionCard>
        <Collapsible defaultOpen className="flex flex-col gap-4">
          <SectionHeader icon={Trophy} title="랭킹" loading={loading} onRefresh={load} />
          <CollapsiblePanel className="flex flex-col gap-2 sm:gap-2.5">
            <div className="h-px w-full bg-border" />
            {members && <RosterView members={members} />}
            {loading && (
              <p className="text-center font-mono text-xs text-muted-foreground sm:text-sm">불러오는 중...</p>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </CollapsiblePanel>
        </Collapsible>
      </SectionCard>

      <SectionCard>
        <Collapsible defaultOpen className="flex flex-col gap-4">
          <SectionHeader icon={PiggyBank} title="상금 정산" loading={loading} onRefresh={load} />
          <CollapsiblePanel className="flex flex-col gap-4">
            <div className="h-px w-full bg-border" />
            {money ? (
              <div className="flex flex-col gap-3 rounded-lg border bg-card p-3.5 shadow-xs sm:p-4.5">
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                      <PiggyBank className="size-3.5 sm:size-4" strokeWidth={ICON_STROKE.default} />
                      총 모금액
                    </span>
                    <span
                      className={cn(
                        "text-sm font-semibold sm:text-base",
                        money.collectMoney > 0 ? "text-ok" : "text-muted-foreground"
                      )}
                    >
                      {won(money.collectMoney)}
                    </span>
                  </div>
                  <SubRow label="지난 주 이월된 상금" value={won(money.fineCarry)} />
                  <SubRow label="이번 주 납부한 벌금" value={won(money.fineThisWeek)} />
                  <SubRow label="이번 주 퇴실 · 재납자가 납부한 벌금" value={won(money.fineOuter)} />
                  {money.depositOuter !== undefined && (
                    <SubRow label="이번 주 퇴실 · 재납자가 납부한 예치금" value={won(money.depositOuter)} />
                  )}
                </div>

                <div className="h-px w-full bg-border" />

                <div className="flex flex-col gap-1.5">
                  <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                    <PiggyBank className="size-3.5 sm:size-4" strokeWidth={ICON_STROKE.default} />
                    이번 주 정산
                  </span>
                  {settlement === null ? (
                    <SubRow label="일요일 14교시 종료 후 확인할 수 있습니다." value="" />
                  ) : settlement && settlement.length > 0 ? (
                    settlement.map((s) => (
                      <SubRow
                        key={s.number}
                        label={`${RANK_EMOJI[s.rank] || s.rank} ${s.name}`}
                        value={won(s.amount)}
                      />
                    ))
                  ) : (
                    <SubRow label="정산 대상이 없습니다." value="" />
                  )}
                </div>
              </div>
            ) : (
              !error && (
                <p className="py-4 text-center font-mono text-xs text-muted-foreground sm:text-sm">
                  불러오는 중...
                </p>
              )
            )}
          </CollapsiblePanel>
        </Collapsible>
      </SectionCard>
    </div>
  );
}
