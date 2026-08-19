import { PenaltyCandidateList } from "@/components/admin/PenaltyCandidateList";
import { PenaltyDepositList } from "@/components/admin/PenaltyDepositList";

export function AdminPenaltyTab() {
  return (
    <div className="flex flex-col gap-6">
      <PenaltyCandidateList />
      <div className="h-px w-full bg-border" />
      <PenaltyDepositList />
    </div>
  );
}
