import { RotateCw, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn, ICON_STROKE } from "@/lib/utils";

// 관리자 탭의 각 현황 섹션 공통 헤더 — 제목(펼침/접힘 토글 겸)과 새로고침 버튼.
// 새로고침 버튼은 CollapsibleTrigger 바깥에 두어 클릭 시 섹션이 접히지 않게 한다.
export function SectionHeader({
  icon: Icon,
  title,
  loading,
  onRefresh,
}: {
  icon: LucideIcon;
  title: string;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <CollapsibleTrigger className="flex-1">
        <span className="flex items-center gap-1.5 text-sm font-bold sm:text-base">
          <Icon className="size-4 shrink-0 text-primary sm:size-5" strokeWidth={ICON_STROKE.default} />
          {title}
        </span>
      </CollapsibleTrigger>
      <Button variant="outline" size="icon-sm" onClick={onRefresh} disabled={loading} aria-label="새로고침">
        <RotateCw className={cn("size-3.5", loading && "animate-spin")} strokeWidth={ICON_STROKE.default} />
      </Button>
    </div>
  );
}
