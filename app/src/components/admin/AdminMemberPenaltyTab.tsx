import { UserPlus } from "lucide-react";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { SectionCard, SectionHeader } from "@/components/admin/shared";
import { ReportReviewList } from "@/components/admin/ReportReviewList";
import { PenaltyCandidateList } from "@/components/admin/PenaltyCandidateList";
import { ReasonLeaveReviewList } from "@/components/admin/ReasonLeaveReviewList";
import { NewMemberForm } from "@/components/admin/NewMemberForm";
import { MemberRosterList } from "@/components/admin/MemberRosterList";
import { PushNotificationSection } from "@/components/admin/PushNotificationSection";

// MEMBER 탭과 PENALTY 탭을 통합한 뷰(MEM · PEN). 요구된 순서대로 배치한다:
// 화각제보검토 → 예치금재납대상자 → 사유반휴신청 → 스터디원등록 → 명단 → 푸시알림.
export function AdminMemberPenaltyTab() {
  return (
    <div className="flex flex-col gap-4">
      <SectionCard>
        <ReportReviewList />
      </SectionCard>

      <SectionCard>
        <PenaltyCandidateList />
      </SectionCard>

      <SectionCard>
        <ReasonLeaveReviewList />
      </SectionCard>

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

      <SectionCard>
        <PushNotificationSection />
      </SectionCard>
    </div>
  );
}
