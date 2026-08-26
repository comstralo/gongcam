import { useEffect, useState } from "react";
import { DoorOpen } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SessionCard } from "@/components/session/SessionCard";
import { InfoCard, ItemTitle } from "@/components/dashboard/shared";
import { PeriodAlarmCard } from "@/components/dashboard/PeriodAlarmCard";
import { DepositRefundDialog } from "@/components/dashboard/DepositRefundDialog";
import { useApi } from "@/hooks/useApi";
import { ICON_STROKE } from "@/lib/utils";
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
        <SessionCard />

        <span className="font-mono text-micro uppercase tracking-wide text-muted-foreground sm:text-xs">알림</span>
        <InfoCard className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-semibold sm:text-base">브라우저 푸시 알림</span>
            <span className="text-xs text-muted-foreground sm:text-sm">제보/벌금 알림 등 종류별 on/off는 곧 추가됩니다</span>
          </div>
          <Badge variant="secondary" className="shrink-0 font-mono text-micro sm:text-xs">
            준비 중
          </Badge>
        </InfoCard>

        <span className="font-mono text-micro uppercase tracking-wide text-muted-foreground sm:text-xs">일반</span>
        <PeriodAlarmCard />

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
            <InfoCard className="flex items-center justify-between gap-3 text-left">
              <div className="flex min-w-0 items-center gap-2.5">
                <DoorOpen className="size-4 shrink-0 text-primary sm:size-5" strokeWidth={ICON_STROKE.default} />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5">
                    <ItemTitle>퇴실신청</ItemTitle>
                    {status.exitRequested && (
                      <Badge variant="secondary" className="shrink-0 font-mono text-micro sm:text-xs">
                        신청됨
                      </Badge>
                    )}
                  </span>
                  <span className="truncate text-xs text-muted-foreground sm:text-sm">
                    가급적 3일 전까지 신청해 주세요.
                  </span>
                </div>
              </div>
            </InfoCard>
          </DepositRefundDialog>
        ) : (
          <InfoCard className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <DoorOpen className="size-4 shrink-0 text-primary sm:size-5" strokeWidth={ICON_STROKE.default} />
              <div className="flex min-w-0 flex-col gap-0.5">
                <ItemTitle>퇴실신청</ItemTitle>
                <span className="truncate text-xs text-muted-foreground sm:text-sm">
                  가급적 3일 전까지 신청해 주세요.
                </span>
              </div>
            </div>
          </InfoCard>
        )}
      </CardContent>
    </Card>
  );
}
