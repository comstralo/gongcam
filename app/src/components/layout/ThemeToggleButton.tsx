import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { ICON_STROKE } from "@/lib/utils";

// 🔧 [사용자 지시] "설정의 다크모드는 메뉴를 없애고 앱의 우측 상단에 토글
// 아이콘 식으로 구현해줘" — "화면 설정" 섹션(ThemeToggleCard) 전체를
// 없애고, 모든 메인 페이지 헤더(AppShell)에 공통으로 뜨는 아이콘 버튼으로
// 옮긴다.
// 🔧 [사용자 지시] "모양 진짜 개못생김; 좀 세련되게" — outline 버튼(각진
// 사각 배경+테두리)이 헤더에서 이질적이었다. 원형 아이콘만 두고 hover 시에만
// 옅은 원형 배경이 뜨는, 이 앱 다른 헤더/툴바에서 흔한 미니멀한 톤으로
// 바꾼다 — 평소엔 존재감을 낮추되 누를 곳이라는 건 hover로 분명해진다.
export function ThemeToggleButton() {
  const { dark, setDark } = useTheme();

  return (
    <button
      type="button"
      aria-label={dark ? "라이트 모드로 전환" : "다크 모드로 전환"}
      onClick={() => setDark(!dark)}
      className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-primary"
    >
      {dark ? (
        <Sun className="size-4.5" strokeWidth={ICON_STROKE.default} />
      ) : (
        <Moon className="size-4.5" strokeWidth={ICON_STROKE.default} />
      )}
    </button>
  );
}
