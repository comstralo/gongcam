import { SectionCard } from "@/components/admin/shared";
import { ReportReviewList } from "@/components/admin/ReportReviewList";
import { PenaltyCandidateList } from "@/components/admin/PenaltyCandidateList";
import { PenaltyDepositList } from "@/components/admin/PenaltyDepositList";

export function AdminPenaltyTab() {
  return (
    <div className="flex flex-col gap-4">
      <SectionCard>
        <ReportReviewList />
      </SectionCard>
      <SectionCard>
        <PenaltyCandidateList />
      </SectionCard>
      <SectionCard>
        <PenaltyDepositList />
      </SectionCard>
    </div>
  );
}
