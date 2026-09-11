import { Volume2, VolumeX } from "lucide-react";
import { usePeriodAlarm } from "@/lib/periodAlarm/usePeriodAlarm";
import { ICON_STROKE, cn } from "@/lib/utils";

// 🔧 [사용자 지시] "교시 종소리도 앱 우측 상단의 여백으로 만들어줘" —
// "설정" 안의 PeriodAlarmCard(켬/끔 스위치 + 남은시간 텍스트)를 없애고,
// ThemeToggleButton과 나란히 모든 메인 페이지 헤더에 공통으로 뜨는 아이콘
// 버튼으로 옮긴다. 클릭할 때마다 켬/끔을 토글하고, 옆에 짧은 남은시간
// 텍스트를 함께 보여줘 설정에 다시 들어가지 않아도 현재 교시 상태를 바로
// 확인할 수 있게 한다.
export function PeriodAlarmToggleButton() {
  const { phase, remainingLabel, soundEnabled, setSoundEnabled } = usePeriodAlarm();

  // 🔧 [사용자 지시] "N교시 00:00 남음 / 휴식 00:00 남음 으로만 처리해줘" —
  // 세 가지 phase 문구를 "{접두어} {남은시간} 남음"으로 통일한다.
  // 🔧 [사용자 지시] "11교시 같은 표시 뒤에는 구분자 기호를 넣어줘" →
  // "가운뎃점 말고 세로 구분선을 써" → 세로선 DOM 요소로 시도했다가
  // "가운데 점이 나은듯 저기선" — 이 헤더 pill처럼 짧고 촘촘한 텍스트에는
  // 세로선보다 가운뎃점이 더 어울린다는 판단으로 되돌림. 이 코드베이스가
  // 이미 쓰는 가운뎃점(·) 구분자 관례(admin/shared.tsx의 "스크린샷 · 영상"
  // 등)를 따른다.
  let statusLabel: string;
  if (phase.kind === "in-period") {
    statusLabel = `${phase.period.index}교시 · ${remainingLabel} 남음`;
  } else if (phase.kind === "break") {
    statusLabel = `휴식 · ${remainingLabel} 남음`;
  } else {
    statusLabel = `1교시 · ${remainingLabel} 남음`;
  }

  return (
    // 🔧 [사용자 지시] "모양 진짜 개못생김; 좀 세련되게" — 각진 outline
    // 버튼 대신, CycleSwitcher 등 이 앱의 다른 pill(rounded-full + 옅은
    // border)과 같은 톤으로 맞춘 완전한 캡슐 형태로 바꾼다. 켜짐/꺼짐은
    // 배경 유무가 아니라 아이콘·글자 색 하나로만 구분해 과하지 않게 한다.
    <button
      type="button"
      aria-label={soundEnabled ? "교시 종소리 끄기" : "교시 종소리 켜기"}
      onClick={() => setSoundEnabled(!soundEnabled)}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1 rounded-full border px-2.5 text-micro-lg font-medium tabular-nums transition-colors sm:text-xs",
        soundEnabled
          ? "border-primary/20 bg-primary/8 text-primary hover:bg-primary/15"
          : "border-border/70 bg-transparent text-muted-foreground hover:bg-muted"
      )}
    >
      {soundEnabled ? (
        <Volume2 className="size-3.5 shrink-0" strokeWidth={ICON_STROKE.default} />
      ) : (
        <VolumeX className="size-3.5 shrink-0" strokeWidth={ICON_STROKE.default} />
      )}
      <span>{statusLabel}</span>
    </button>
  );
}
