import { ListChecks } from "lucide-react";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { SectionHeader, SectionCard } from "@/components/admin/shared";

// TODO(dev-preview): 세부 요소 미정 — 사용자가 추후 지시할 예정.
export function MyOutputPenSection() {
  return (
    <SectionCard>
      <Collapsible defaultOpen className="flex flex-col gap-4">
        <SectionHeader icon={ListChecks} title="내 송출 P 제보 확인" />
        <CollapsiblePanel className="flex flex-col gap-4">
          <div className="h-px w-full bg-border" />
          <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">준비 중입니다.</p>
        </CollapsiblePanel>
      </Collapsible>
    </SectionCard>
  );
}
