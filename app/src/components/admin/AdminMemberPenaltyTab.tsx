import { UserPlus } from "lucide-react";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { SectionCard, SectionHeader } from "@/components/admin/shared";
import { NewMemberForm } from "@/components/admin/NewMemberForm";
import { MemberRosterList } from "@/components/admin/MemberRosterList";

// ACCOUNT 탭 — 계정/회원 관리 전용: 스터디원등록 → 스터디원목록.
// (제보확인/예치금재납대상자/사유반휴신청/벌금·상금 처리는 PEN · MONEY 탭으로 이동)
export function AdminMemberPenaltyTab({ visible: _visible }: { visible: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <SectionCard>
        <Collapsible defaultOpen={false} className="flex flex-col gap-3">
          <SectionHeader icon={UserPlus} title="스터디원 등록" />
          <div className="h-px w-full bg-border" />
          <CollapsiblePanel>
            <NewMemberForm />
          </CollapsiblePanel>
        </Collapsible>
      </SectionCard>

      <SectionCard>
        <MemberRosterList />
      </SectionCard>
    </div>
  );
}
