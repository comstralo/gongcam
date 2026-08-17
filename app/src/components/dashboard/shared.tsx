import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn, ICON_STROKE } from "@/lib/utils";

type PillTone = "ok" | "warn" | "muted" | "primary";

const PILL_TONE_CLASSES: Record<PillTone, string> = {
  ok: "bg-ok/15 text-ok",
  warn: "bg-destructive/15 text-destructive",
  muted: "bg-foreground/8 text-muted-foreground",
  primary: "bg-primary/15 text-primary",
};

// 대시보드 전반(내 대시보드/전체 대시보드/지난 기록)에서 반복되는 "틴트된 상태 배지".
export function TintedPill({
  tone,
  icon: Icon,
  children,
  className,
}: {
  tone: PillTone;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-micro-lg font-semibold sm:text-xs",
        PILL_TONE_CLASSES[tone],
        className
      )}
    >
      {Icon && <Icon className="size-3 sm:size-3.5" strokeWidth={ICON_STROKE.emphasis} />}
      {children}
    </span>
  );
}

// 아이콘 + 라벨 + 값을 담는 요약 타일 (StatusView 상단 그리드).
// wrap: 순위 사유("- (사유 반휴 3장 이상 사용)")처럼 값이 길어질 수 있는
// 타일만 줄바꿈을 허용한다 — 기본은 다른 타일과 맞춰 한 줄 자르기.
// valueClassName: 페널티 합계처럼 값 자체의 색상을 상태에 따라 바꿔야 할 때 사용.
// hint: 라벨을 길게 늘이지 않고 값 옆에 부연 설명("예치금 납부일 기준")을 덧붙일 때 사용.
export function SummaryTile({
  icon: Icon,
  label,
  value,
  wrap,
  valueClassName,
  hint,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  wrap?: boolean;
  valueClassName?: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border bg-muted px-3.5 py-2.5 shadow-xs sm:px-4 sm:py-3">
      <div className="flex items-center gap-1.25 text-muted-foreground">
        <Icon className="size-3 shrink-0 sm:size-3.5" strokeWidth={ICON_STROKE.default} />
        <span className="truncate text-micro font-semibold tracking-wide uppercase sm:text-micro-lg">{label}</span>
      </div>
      <span
        className={cn(
          "text-xs font-semibold sm:text-sm",
          wrap ? "break-keep" : "truncate",
          valueClassName
        )}
      >
        {value}
      </span>
      {hint && <span className="truncate text-micro text-muted-foreground/70">{hint}</span>}
    </div>
  );
}

// 텍스트 구분자("|") 대신 은은한 세로선으로 두 값을 나눠 보여준다.
// 예: 주간 총 상점(수치) │ 순위.
export function DividedValue({ items }: { items: ReactNode[] }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {items.map((item, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {i > 0 && <span className="h-3 w-px bg-border" aria-hidden="true" />}
          {item}
        </span>
      ))}
    </span>
  );
}

// "└" 접두 트리 표기로 상위 행 아래 들여쓰기된 세부 항목을 표시하는 서브로우.
// indent: 상위 행 없이 박스 안에 항목만 나열할 때는 false로 꺼서 불필요한
// 좌측 여백/트리 기호 없이 일반 목록처럼 보이게 한다.
export function SubRow({
  label,
  value,
  valueClassName,
  indent = true,
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string;
  indent?: boolean;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-2", indent && "pl-5 sm:pl-5.5")}>
      <span
        className={cn(
          "text-micro-lg text-muted-foreground sm:text-xs",
          indent && "before:mr-1 before:content-['└']"
        )}
      >
        {label}
      </span>
      <span className={cn("font-mono text-xs tabular-nums text-muted-foreground sm:text-sm", valueClassName)}>
        {value}
      </span>
    </div>
  );
}

// 세션 카드/알림 설정 등 여러 페이지에서 반복되는 옅은 배경의 정보 카드.
export function InfoCard({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("rounded-lg border bg-muted p-3.5 shadow-xs sm:p-4.5", className)} {...props}>
      {children}
    </div>
  );
}
