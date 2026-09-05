import { Moon } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { InfoCard, ItemTitle } from "@/components/dashboard/shared";
import { useTheme } from "@/hooks/useTheme";
import { ICON_STROKE } from "@/lib/utils";

export function ThemeToggleCard() {
  const { dark, setDark } = useTheme();

  return (
    <InfoCard className="flex items-center justify-between gap-2.5">
      <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
        <Moon className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
        <ItemTitle>다크 모드</ItemTitle>
      </span>
      <Switch checked={dark} onCheckedChange={setDark} aria-label="다크 모드" />
    </InfoCard>
  );
}
