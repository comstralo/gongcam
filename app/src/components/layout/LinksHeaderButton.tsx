import { NavLink } from "react-router-dom";
import { Link2 } from "lucide-react";
import { cn, ICON_STROKE } from "@/lib/utils";

// 🔧 [사용자 지시] "링크 메뉴를 우측 상단의 다크모드 토글 버튼 좌측에
// 넣어줘" — 하단 탭바의 "링크" 항목을 헤더로 옮긴다. ThemeToggleButton과
// 동일한 원형 아이콘 버튼 톤(평소엔 존재감 낮추고 hover로만 드러남)을
// 맞추되, 이건 토글이 아니라 페이지 이동이라 NavLink로 활성 상태(/links
// 진입 중)만 강조한다.
export function LinksHeaderButton() {
  return (
    <NavLink
      to="/links"
      aria-label="링크"
      className={({ isActive }) =>
        cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-primary",
          isActive && "text-primary"
        )
      }
    >
      <Link2 className="size-4.5" strokeWidth={ICON_STROKE.default} />
    </NavLink>
  );
}
