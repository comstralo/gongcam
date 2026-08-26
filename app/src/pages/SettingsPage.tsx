import { useEffect, useState } from "react";
import { BellRing, DoorOpen, UserCog } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { SectionHeader, SectionCard } from "@/components/admin/shared";
import { SessionCard } from "@/components/session/SessionCard";
import { DividedValue, InfoCard } from "@/components/dashboard/shared";
import { PeriodAlarmCard } from "@/components/dashboard/PeriodAlarmCard";
import { DepositRefundDialog } from "@/components/dashboard/DepositRefundDialog";
import { useApi } from "@/hooks/useApi";
import { ICON_STROKE, cn } from "@/lib/utils";
import type { StatusResponse } from "@/lib/api/types";

export function SettingsPage() {
  const { call } = useApi();
  const [status, setStatus] = useState<StatusResponse | null>(null);

  // 퇴실신청 카드는 "내 대시보드" 기준 예치금 반환 예상액을 보여줘야 하므로,
  // 대시보드 조회와 무관하게 이 페이지에서 직접 /status를 불러온다.
  useEffect(() => {
    let cancelled = false;
    call<StatusResponse>("/status")
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card className="w-full page-content">
      <CardContent className="flex flex-col gap-4">
        <SectionCard>
          <Collapsible defaultOpen className="flex flex-col gap-4">
            <SectionHeader icon={UserCog} title="계정 관리" />
            <div className="h-px w-full bg-border" />
            <CollapsiblePanel className="flex flex-col gap-4">
              <SessionCard name={status?.name} />

              {status?.depositRefundBreakdown ? (
                <DepositRefundDialog
                  depositRefundEstimate={status.depositRefundEstimate}
                  breakdown={status.depositRefundBreakdown}
                  exitRequested={!!status.exitRequested}
                  exitRequestDate={status.exitRequestDate}
                  onExitRequestChange={() => {
                    call<StatusResponse>("/status")
                      .then(setStatus)
                      .catch(() => {});
                  }}
                >
                  <InfoCard className="flex items-center justify-between gap-2.5">
                    <span className="inline-flex min-w-0 flex-1 items-center gap-1.25 truncate text-xs font-semibold sm:text-sm">
                      <DoorOpen className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                      <DividedValue
                        items={[
                          "퇴실신청",
                          <span className="truncate text-xs font-normal text-muted-foreground sm:text-sm">
                            {status.exitRequested ? "신청됨" : "가급적 3일 전까지 신청해 주세요."}
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
                          가급적 3일 전까지 신청해 주세요.
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
            <div className="h-px w-full bg-border" />
            <CollapsiblePanel className="flex flex-col gap-4">
              <PeriodAlarmCard />
            </CollapsiblePanel>
          </Collapsible>
        </SectionCard>
      </CardContent>
    </Card>
  );
}
