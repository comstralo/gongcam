import { BellRing, Volume2, VolumeX } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { InfoCard } from "@/components/dashboard/shared";
import { ICON_STROKE } from "@/lib/utils";
import { usePeriodAlarm } from "@/lib/periodAlarm/usePeriodAlarm";

export function PeriodAlarmCard() {
  const { phase, remainingLabel, soundEnabled, setSoundEnabled } = usePeriodAlarm();

  let statusLabel: string;
  if (phase.kind === "in-period") {
    statusLabel = `${phase.period.index}교시 남은시간 ${remainingLabel}`;
  } else if (phase.kind === "break") {
    statusLabel = phase.next ? `휴식 남은시간 ${remainingLabel}` : "오늘 교시 종료";
  } else {
    statusLabel = "운영시간 외";
  }

  return (
    <InfoCard className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <BellRing className="size-4 shrink-0 text-primary sm:size-5" strokeWidth={ICON_STROKE.default} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-semibold sm:text-base">교시 종소리</span>
          <span className="truncate text-xs text-muted-foreground sm:text-sm">{statusLabel}</span>
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
          aria-label="교시 종소리"
        />
      </div>
    </InfoCard>
  );
}
