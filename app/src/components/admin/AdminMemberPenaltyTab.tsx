import { UserPlus } from "lucide-react";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { SectionCard, SectionHeader } from "@/components/admin/shared";
import { NewMemberForm } from "@/components/admin/NewMemberForm";
import { MemberRosterList } from "@/components/admin/MemberRosterList";

// ACCOUNT 탭 — 계정/회원 관리 전용: 스터디원 목록(참여자/퇴실자 뷰 전환) →
// 스터디원 등록(🔧 [사용자 지시] "신규"를 빼고 "스터디원 등록"으로).
// 🔧 [사용자 지시] "참여 스터디원 목록"과 "퇴실 스터디원 목록"을
// "스터디원 목록" 하나로 합쳤다 — MemberRosterList 내부의 드롭다운으로
// 참여자/퇴실자 뷰를 전환한다(기본값 참여자). (제보확인/예치금재납대상자/
// 사유반휴신청/벌금·상금 처리는 PEN · MONEY 탭으로 이동)
export function AdminMemberPenaltyTab({ visible }: { visible: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <SectionCard>
        <MemberRosterList visible={visible} />
      </SectionCard>

      <SectionCard>
        <Collapsible open disabled className="flex flex-col">
          <SectionHeader icon={UserPlus} title="스터디원 등록" />
          <CollapsiblePanel className="flex flex-col gap-3">
            <NewMemberForm />
          </CollapsiblePanel>
        </Collapsible>
      </SectionCard>
    </div>
  );
}
