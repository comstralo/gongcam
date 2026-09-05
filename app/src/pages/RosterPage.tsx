import { useEffect, useState } from "react";
import { Trophy, PiggyBank, Receipt } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { SectionHeader, SectionCard } from "@/components/admin/shared";
import { SubRow, ItemTitle, won } from "@/components/dashboard/shared";
import { RosterView, RosterViewSkeleton, RANK_EMOJI } from "@/components/dashboard/RosterView";
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
  // 집계!P6 === "완료"(관리자가 "상금 정산 집행"을 눌렀는지) — 정산 대상은
  // 계산돼 있어도 아직 집행 전이면 이 값이 false다.
  const [settlementSettled, setSettlementSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // 이 조회가 보여주는 주(월~일)의 시작/종료일("YYMMDD") — 섹션 타이틀에
  // "YYMMDD-YYMMDD 주간 랭킹/정산"으로 병기한다.
  const [weekRange, setWeekRange] = useState<{ weekStart: string; weekEnd: string } | null>(null);

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
        setSettlementSettled(!!data.settlementSettled);
        setWeekRange(data.weekStart && data.weekEnd ? { weekStart: data.weekStart, weekEnd: data.weekEnd } : null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "전체 대시보드를 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  const weekPrefix = weekRange ? `${weekRange.weekStart} - ${weekRange.weekEnd} ` : "";

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
          <SectionHeader icon={Trophy} title={`${weekPrefix}주간 랭킹`} loading={loading} onRefresh={load} />
          <CollapsiblePanel className="flex flex-col gap-2 sm:gap-2.5">
            <div className="h-px w-full bg-border" />
            {members ? <RosterView members={members} /> : !error && <RosterViewSkeleton />}
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
          <SectionHeader icon={PiggyBank} title={`${weekPrefix}주간 정산`} loading={loading} onRefresh={load} />
          <CollapsiblePanel className="flex flex-col gap-4">
            <div className="h-px w-full bg-border" />
            {money ? (
              <div className="flex flex-col gap-3 rounded-lg border bg-card p-3.5 shadow-xs sm:p-4.5">
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.25">
                      <PiggyBank className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                      <ItemTitle>총 모금액</ItemTitle>
                    </span>
                    <span className={cn("text-sm sm:text-base", money.collectMoney > 0 && "text-ok")}>
                      {won(money.collectMoney)}
                    </span>
                  </div>
                  {/* 🔧 2026-09: SubRow 기본값(11/12px) 대신 MeritBreakdownDialog와
                      동일한 하위 항목 크기(text-xs sm:text-sm)로 통일. */}
                  <SubRow label="이월된 상금" value={won(money.fineCarry)} labelClassName="text-xs sm:text-sm" valueClassName="text-xs sm:text-sm" />
                  <SubRow label="정상 참여자 납부 벌금" value={won(money.fineThisWeek)} labelClassName="text-xs sm:text-sm" valueClassName="text-xs sm:text-sm" />
                  <SubRow label="퇴실 · 재납자 납부 벌금" value={won(money.fineOuter)} labelClassName="text-xs sm:text-sm" valueClassName="text-xs sm:text-sm" />
                  {money.depositOuter !== undefined && (
                    <SubRow label="퇴실 · 재납자 귀속 예치금" value={won(money.depositOuter)} labelClassName="text-xs sm:text-sm" valueClassName="text-xs sm:text-sm" />
                  )}
                </div>

                <div className="h-px w-full bg-border" />

                <div className="flex flex-col gap-1.5">
                  <span className="inline-flex items-center gap-1.25">
                    <Receipt className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                    <ItemTitle>정산 내역</ItemTitle>
                  </span>
                  {settlement === null ? (
                    <SubRow label="일요일 14교시 종료 후 확인할 수 있습니다." value="" labelClassName="text-xs sm:text-sm" />
                  ) : settlement && settlement.length > 0 ? (
                    settlementSettled ? (
                      settlement.map((s) => (
                        <SubRow
                          key={s.number}
                          label={`${RANK_EMOJI[s.rank] || s.rank} ${s.name}`}
                          value={won(s.amount)}
                          labelClassName="text-xs sm:text-sm"
                          valueClassName="text-xs sm:text-sm"
                        />
                      ))
                    ) : (
                      <SubRow label="아직 집행되지 않았습니다." value="" labelClassName="text-xs sm:text-sm" />
                    )
                  ) : (
                    <SubRow label="정산 대상이 없습니다." value="" labelClassName="text-xs sm:text-sm" />
                  )}
                </div>
              </div>
            ) : (
              // 🔧 2026-09: "불러오는 중..." 텍스트 한 줄 → 카드 전체가
              // 한꺼번에 나타나던 것을, 실제 카드와 같은 구조(총 모금액 줄 +
              // SubRow 4개 + 구분선 + 정산 줄)의 펄스 스켈레톤으로 교체.
              !error && (
                <div className="flex animate-pulse flex-col gap-3 rounded-lg border bg-card p-3.5 shadow-xs sm:p-4.5" aria-hidden>
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="h-3.5 w-20 rounded bg-muted sm:h-4 sm:w-24" />
                      <span className="h-4 w-16 rounded bg-muted sm:h-5 sm:w-20" />
                    </div>
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="flex items-center justify-between gap-2">
                        <span className="h-3 w-32 rounded bg-muted sm:h-3.5 sm:w-40" />
                        <span className="h-3 w-12 rounded bg-muted sm:h-3.5 sm:w-14" />
                      </div>
                    ))}
                  </div>
                  <div className="h-px w-full bg-border" />
                  <div className="flex flex-col gap-1.5">
                    <span className="h-3.5 w-20 rounded bg-muted sm:h-4 sm:w-24" />
                    <div className="flex items-center justify-between gap-2">
                      <span className="h-3 w-28 rounded bg-muted sm:h-3.5 sm:w-36" />
                      <span className="h-3 w-12 rounded bg-muted sm:h-3.5 sm:w-14" />
                    </div>
                  </div>
                </div>
              )
            )}
          </CollapsiblePanel>
        </Collapsible>
      </SectionCard>
    </div>
  );
}
