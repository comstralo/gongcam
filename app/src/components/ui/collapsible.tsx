import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible"
import { ChevronDownIcon } from "lucide-react"

import { cn } from "@/lib/utils"

const Collapsible = CollapsiblePrimitive.Root

function CollapsibleTrigger({
  className,
  children,
  hideChevron,
  ...props
}: CollapsiblePrimitive.Trigger.Props & {
  /** SectionHeader가 chevron만 따로 우측 끝(새로고침 버튼 뒤)에 두고
   * 싶을 때, 제목을 감싸는 트리거 쪽 chevron을 감춘다. */
  hideChevron?: boolean
}) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      className={cn(
        "group/collapsible-trigger flex w-full items-center justify-between gap-2 outline-none",
        className
      )}
      {...props}
    >
      {children}
      {!hideChevron && (
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-panel-open/collapsible-trigger:rotate-180" />
      )}
    </CollapsiblePrimitive.Trigger>
  )
}

function CollapsiblePanel({
  className,
  ...props
}: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-panel"
      className={cn(
        "h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-[starting-style]:h-0 data-[ending-style]:h-0",
        className
      )}
      {...props}
    />
  )
}

export { Collapsible, CollapsibleTrigger, CollapsiblePanel }
