import type { ReactNode } from "react";
import { RotateCw, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn, ICON_STROKE } from "@/lib/utils";

// 관리자 탭 전반의 텍스트 위계를 명시적으로 나눈 프리미티브들.
// 1. SectionHeader 제목  — text-sm/base, font-bold   (섹션의 최상위 텍스트)
// 2. ItemTitle           — text-sm/base, font-semibold (리스트 한 항목의 1차 텍스트, 섹션 제목보다 굵기 한 단계 낮음)
// 3. FieldLabel          — text-xs/sm,  font-medium, muted (카드 안 항목명 — 크기 자체를 한 단계 낮춰 값과 구분)
// 4. FieldValue          — text-xs/sm,  font-semibold (카드 안 강조 값, FieldLabel과 나란히 쓰임)
// 이전에는 섹션 제목과 리스트 아이템 이름, 카드 라벨이 모두 text-sm/base 크기를 공유해
// 굵기 차이(bold vs semibold)만으로 위계를 나누려 해서 시각적으로 거의 구분되지 않았다.

export function ItemTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-sm font-semibold sm:text-base", className)}>{children}</span>;
}

export function FieldLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("text-xs font-medium text-muted-foreground sm:text-sm", className)}>{children}</span>
  );
}

export function FieldValue({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-xs font-semibold sm:text-sm", className)}>{children}</span>;
}

// 관리자 탭에서 접이식 섹션 하나를 감싸는 카드. AdminPage가 이미 전체를
// Card(bg-card)로 감싸고 있어, bg-muted/40으로 옅게 톤을 낮춰 섹션 경계를
// 뚜렷이 드러내면서도 내부 리스트 아이템의 InfoCard(bg-muted)와는 밝기 차이를 둔다.
export function SectionCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-xl border border-border bg-muted/40 p-3.5 sm:p-4", className)}>{children}</div>
  );
}

// 관리자 탭의 각 현황 섹션 공통 헤더 — 제목(펼침/접힘 토글 겸)과 새로고침 버튼.
// 새로고침 버튼은 CollapsibleTrigger 바깥에 두어 클릭 시 섹션이 접히지 않게 한다.
// onRefresh가 없는 섹션(예: 신규 등록 폼처럼 서버에서 다시 불러올 목록이 없는
// 경우)은 버튼 자리를 비워두고 chevron만 우측에 남긴다 — 다른 섹션과 chevron
// 위치를 맞추기 위해 버튼 크기(size-7)만큼의 빈 공간을 유지한다.
export function SectionHeader({
  icon: Icon,
  title,
  loading,
  onRefresh,
}: {
  icon: LucideIcon;
  title: string;
  loading?: boolean;
  onRefresh?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <CollapsibleTrigger className="flex-1">
        <span className="flex items-center gap-1.5 text-sm font-bold sm:text-base">
          <Icon className="size-4 shrink-0 text-primary sm:size-5" strokeWidth={ICON_STROKE.default} />
          {title}
        </span>
      </CollapsibleTrigger>
      {onRefresh ? (
        <Button variant="outline" size="icon-sm" onClick={onRefresh} disabled={loading} aria-label="새로고침">
          <RotateCw className={cn("size-3.5", loading && "animate-spin")} strokeWidth={ICON_STROKE.default} />
        </Button>
      ) : (
        <span className="size-7 shrink-0" aria-hidden="true" />
      )}
    </div>
  );
}
