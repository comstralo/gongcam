import { BellRing, Volume2, VolumeX } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { InfoCard } from "@/components/dashboard/shared";
import { ICON_STROKE } from "@/lib/utils";
import { usePeriodAlarm } from "@/hooks/usePeriodAlarm";

export function PeriodAlarmCard() {
  const { phase, remainingLabel, soundEnabled, setSoundEnabled } = usePeriodAlarm();

  let statusLabel: string;
  let detailLabel: string;
  if (phase.kind === "in-period") {
    statusLabel = `${phase.period.index}교시 진행중`;
    detailLabel = `종료까지 ${remainingLabel}`;
  } else if (phase.kind === "break") {
    statusLabel = phase.next ? `${phase.next.index}교시 시작 전` : "마지막 교시 종료";
    detailLabel = phase.next ? `시작까지 ${remainingLabel}` : "오늘 교시가 모두 끝났습니다";
  } else {
    statusLabel = "운영시간 외";
    detailLabel = "07:20 ~ 23:30";
  }

  return (
    <InfoCard className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <BellRing className="size-4 shrink-0 text-primary sm:size-5" strokeWidth={ICON_STROKE.default} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-semibold sm:text-base">교시 알람</span>
          <span className="truncate text-xs text-muted-foreground sm:text-sm">
            {statusLabel} · {detailLabel}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {soundEnabled ? (
          <Volume2 className="size-3.5 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
        ) : (
          <VolumeX className="size-3.5 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
        )}
        <Switch
          checked={soundEnabled}
          onCheckedChange={setSoundEnabled}
          aria-label="교시 알람 소리"
        />
      </div>
    </InfoCard>
  );
}
