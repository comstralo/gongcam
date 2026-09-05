import { BellRing, DoorOpen, UserCog } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { SectionHeader, SectionCard } from "@/components/admin/shared";
import { SessionCard } from "@/components/session/SessionCard";
import { DividedValue, InfoCard } from "@/components/dashboard/shared";
import { PeriodAlarmCard } from "@/components/dashboard/PeriodAlarmCard";
import { NotifyPrefsCard } from "@/components/dashboard/NotifyPrefsCard";
import { InstallAppCard } from "@/components/dashboard/InstallAppCard";
import { DepositRefundDialog } from "@/components/dashboard/DepositRefundDialog";
import { useRefreshOnVisible } from "@/hooks/useRefreshOnVisible";
import { useMyStatus } from "@/lib/status/useMyStatus";
import { ICON_STROKE, cn } from "@/lib/utils";

export function SettingsPage({ visible = true }: { visible?: boolean }) {
  // 앱 전역에서 공유하는 "내 현재 상태" 캐시를 그대로 쓴다 — 대시보드에서
  // 이미 불러온 값이 있으면 이 페이지로 넘어와도 재요청 없이 즉시 보여준다
  // (이름이 잠깐 다른 값으로 보였다가 바뀌는 깜빡임 방지).
  const { status, refresh } = useMyStatus();
  // 관리자가 퇴실/예치금 처리를 다른 화면에서 했을 수 있어, 이 페이지로
  // 돌아올 때마다 최신 상태를 다시 불러온다.
  useRefreshOnVisible(visible, refresh);

  return (
    // 🔧 2026-09: 이 화면을 감싸던 바깥 Card/CardContent를 제거했다(사용자
    // 지시) — 안쪽 "계정 관리"/"알림 설정"이 이미 각자 SectionCard(자체
    // 테두리+배경)로 감싸여 있어, 바깥 Card는 이중 테두리·이중 배경만
    // 만들 뿐이었다. RosterPage/StatusPage에서 같은 이유로 이미 제거한
    // 것과 동일한 처리.
    <div className="flex w-full page-content flex-col gap-4">
      <SectionCard>
        <Collapsible defaultOpen className="flex flex-col gap-4">
          <SectionHeader icon={UserCog} title="계정 관리" />
          <CollapsiblePanel className="flex flex-col gap-4">
            <div className="h-px w-full bg-border" />
            <SessionCard name={status?.name} />
            <InstallAppCard />

            {status?.depositRefundBreakdown ? (
              <DepositRefundDialog
                depositRefundEstimate={status.depositRefundEstimate}
                breakdown={status.depositRefundBreakdown}
                exitRequested={!!status.exitRequested}
                exitRequestDate={status.exitRequestDate}
                exitAgreedAt={status.exitAgreedAt}
                onExitRequestChange={refresh}
              >
                <InfoCard className="flex items-center justify-between gap-2.5">
                  <span className="inline-flex min-w-0 flex-1 items-center gap-1.25 truncate text-xs font-semibold sm:text-sm">
                    <DoorOpen className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                    <DividedValue
                      items={[
                        "퇴실신청",
                        <span className="truncate text-xs font-normal text-muted-foreground sm:text-sm">
                          {status.exitRequested ? "신청됨" : "최소 3일 전까지 신청 바랍니다."}
                        </span>,
                      ]}
                    />
                  </span>
                  <span
                    className={cn(
                      buttonVariants({ variant: "outline", size: "sm" }),
                      "shrink-0 pointer-events-none text-xs sm:text-sm"
                    )}
                  >
                    {status.exitRequested ? "신청됨" : "신청하기"}
                  </span>
                </InfoCard>
              </DepositRefundDialog>
            ) : (
              <InfoCard className="flex items-center justify-between gap-2.5">
                <span className="inline-flex min-w-0 flex-1 items-center gap-1.25 truncate text-xs font-semibold sm:text-sm">
                  <DoorOpen className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                  <DividedValue
                    items={[
                      "퇴실신청",
                      <span className="truncate text-xs font-normal text-muted-foreground sm:text-sm">
                        최소 3일 전까지 신청 바랍니다.
                      </span>,
                    ]}
                  />
                </span>
              </InfoCard>
            )}
          </CollapsiblePanel>
        </Collapsible>
      </SectionCard>

      <SectionCard>
        <Collapsible defaultOpen className="flex flex-col gap-4">
          <SectionHeader icon={BellRing} title="알림 설정" />
          <CollapsiblePanel className="flex flex-col gap-4">
            <div className="h-px w-full bg-border" />
            <PeriodAlarmCard />
            <NotifyPrefsCard name={status?.name} />
          </CollapsiblePanel>
        </Collapsible>
      </SectionCard>
    </div>
  );
}
