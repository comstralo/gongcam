import { SectionCard } from "@/components/admin/shared";
import { PenaltyCandidateList } from "@/components/admin/PenaltyCandidateList";
import { PenaltyDepositList } from "@/components/admin/PenaltyDepositList";

export function AdminPenaltyTab() {
  return (
    <div className="flex flex-col gap-4">
      <SectionCard>
        <PenaltyCandidateList />
      </SectionCard>
      <SectionCard>
        <PenaltyDepositList />
      </SectionCard>
    </div>
  );
}
