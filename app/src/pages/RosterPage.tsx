import { useEffect, useState } from "react";
import { Trophy, PiggyBank } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
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

// TODO(dev-preview): 렌더링 확인용 더미 데이터. 확인 후 제거할 것.
const DUMMY_MEMBERS: RosterMember[] = [
  { number: "3", name: "박민수", timer: "42:10 / 50:00", merit: "87", rank: "🥇", status: "정상" },
  { number: "7", name: "이서연", timer: "40:05 / 50:00", merit: "81", rank: "🥈", status: "정상" },
  { number: "1", name: "김태현", timer: "38:20 / 50:00", merit: "76", rank: "🥉", status: "정상" },
  { number: "5", name: "정하윤", timer: "35:40 / 50:00", merit: "70", rank: "4", status: "정상" },
  { number: "2", name: "최도윤", timer: "30:15 / 50:00", merit: "58", rank: "5", status: "미납" },
  { number: "10", name: "한지민", timer: "28:50 / 50:00", merit: "55", rank: "6", status: "정상" },
  { number: "11", name: "오세훈", timer: "26:30 / 50:00", merit: "50", rank: "7", status: "정상" },
  { number: "12", name: "윤아름", timer: "24:00 / 50:00", merit: "45", rank: "8", status: "정상" },
  { number: "13", name: "장서준", timer: "20:15 / 50:00", merit: "38", rank: "9", status: "미납" },
  { number: "14", name: "임채원", timer: "18:40 / 50:00", merit: "30", rank: "10", status: "정상" },
  { number: "9", name: "매우매우매우매우긴이름테스트", timer: "12:00 / 50:00", merit: "20", rank: "-", status: "빈 시트" },
];

// TODO(dev-preview): 렌더링 확인용 더미 값. 확인 후 제거할 것.
const DUMMY_MONEY: {
  collectMoney: number;
  fineCarry: number;
  fineThisWeek: number;
  fineOuter: number;
  depositOuter?: number;
} = {
  collectMoney: 1_250_000,
  fineCarry: 30_000,
  fineThisWeek: 45_000,
  fineOuter: 60_000,
  depositOuter: 200_000,
};

// TODO(dev-preview): 렌더링 확인용 더미 값. 확인 후 제거할 것.
const DUMMY_SETTLEMENT: SettlementItem[] = [
  { number: "3", name: "박민수", rank: 1, amount: 250_000 },
  { number: "7", name: "이서연", rank: 2, amount: 250_000 },
  { number: "1", name: "김태현", rank: 3, amount: 250_000 },
  { number: "5", name: "정하윤", rank: 4, amount: 250_000 },
  { number: "2", name: "최도윤", rank: 5, amount: 250_000 },
];

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
  const [members, setMembers] = useState<RosterMember[] | null>(DUMMY_MEMBERS);
  const [money, setMoney] = useState(DUMMY_MONEY);
  // undefined: 아직 못 받아옴(로딩 중). null: 백엔드가 필드를 안 보냄(비공개 —
  // 스터디원이 일요일 14교시 종료 전에 조회한 경우).
  const [settlement, setSettlement] = useState<SettlementItem[] | null | undefined>(DUMMY_SETTLEMENT);
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
    <Card className="w-full">
      <CardContent className="flex flex-col gap-4">
        {onSelectCycle && <CycleSwitcher selectedFileId={cycleFileId ?? null} onSelect={onSelectCycle} />}

        <SectionCard>
          <Collapsible defaultOpen className="flex flex-col gap-4">
            <SectionHeader icon={Trophy} title="랭킹" loading={loading} onRefresh={load} />
            <div className="h-px w-full bg-border" />
            <CollapsiblePanel className="flex flex-col gap-2 sm:gap-2.5">
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
            <div className="h-px w-full bg-border" />
            <CollapsiblePanel>
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
            </CollapsiblePanel>
          </Collapsible>
        </SectionCard>
      </CardContent>
    </Card>
  );
}
