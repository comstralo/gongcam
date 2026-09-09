import { Moon } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { InfoCard, ItemTitle } from "@/components/dashboard/shared";
import { useTheme } from "@/hooks/useTheme";
import { ICON_STROKE } from "@/lib/utils";

export function ThemeToggleCard() {
  const { dark, setDark } = useTheme();

  return (
    // 🔧 [사용자 지시] "'설정'에서 황토색 배경 부분들 다 걷어내 흰색으로" —
    // InfoCard 기본 배경(bg-muted, #f1e9da)이 황토색으로 보였다 — bg-card로
    // 오버라이드한다.
    <InfoCard className="flex items-center justify-between gap-2.5 bg-card">
      <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
        <Moon className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
        {/* 🔧 [사용자 지시] 설정 화면 텍스트 위계 통일 — 이 ItemTitle
            (dashboard/shared.tsx 버전, font-bold)이 "교시 종소리"/"상태
            메시지" 등 다른 설정 카드 제목(font-semibold)보다 굵었다. */}
        <ItemTitle className="font-semibold">다크 모드</ItemTitle>
      </span>
      <Switch checked={dark} onCheckedChange={setDark} aria-label="다크 모드" />
    </InfoCard>
  );
}
