import { useEffect, useState } from "react";
import { Loader2, User } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { SectionHeader, SectionCard } from "@/components/admin/shared";
import { StatusView } from "@/components/dashboard/StatusView";
import { CycleSwitcher } from "@/components/dashboard/CycleSwitcher";
import { useApi } from "@/hooks/useApi";
import { useRefreshOnVisible } from "@/hooks/useRefreshOnVisible";
import { usePollingRefresh } from "@/hooks/usePollingRefresh";
import { useAuth } from "@/lib/auth/useAuth";
import { useMyStatus } from "@/lib/status/useMyStatus";
import type { AdminMember, AdminMembersResponse, StatusResponse } from "@/lib/api/types";

// 회원번호로 "본인"을 표시하는 특수값 — 실제 회원번호와 겹치지 않도록 접두사를 둔다.
const SELF_VALUE = "__self__";

export function StatusPage({
  cycleFileId,
  onSelectCycle,
  visible = true,
}: {
  cycleFileId?: string | null;
  onSelectCycle?: (fileId: string | null) => void;
  visible?: boolean;
}) {
  const { call } = useApi();
  const { isAdmin } = useAuth();
  const myStatus = useMyStatus();

  const [members, setMembers] = useState<AdminMember[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(SELF_VALUE);

  const [otherStatus, setOtherStatus] = useState<StatusResponse | null>(null);
  const [otherError, setOtherError] = useState<string | null>(null);
  const [otherLoading, setOtherLoading] = useState(false);

  const isViewingCycle = !!cycleFileId;
  // "내 대시보드 · 현재 사이클" 조회는 앱 전역 캐시(MyStatusContext)를 그대로
  // 쓴다. 그 외(다른 회원 선택, 과거 사이클 조회)는 파라미터가 붙는 별도
  // 조회라 이 페이지 로컬에서 따로 불러온다.
  const usingMyStatus = !isViewingCycle && selected === SELF_VALUE;
  const status = usingMyStatus ? myStatus.status : otherStatus;
  const loading = usingMyStatus ? myStatus.loading : otherLoading;
  const error = usingMyStatus ? myStatus.error : otherError;

  // 관리자만 다른 스터디원을 선택할 수 있으므로, 관리자일 때만 회원 목록을 불러온다.
  // 🔧 [과거 주차 회원 전환 지원] 이전엔 isViewingCycle이면 아예 건너뛰어
  // "다른 회원 보기" 드롭다운 자체가 사라졌다 — 그 주차 백업 시트의 회원
  // 목록을 cycle 파라미터로 함께 요청한다(그 주엔 있었지만 지금은 퇴실한
  // 회원도 과거 기록 조회 대상에 포함되도록).
  function loadMembers() {
    if (!isAdmin) return;
    const cycleParam = isViewingCycle ? `?cycle=${encodeURIComponent(String(cycleFileId))}` : "";
    call<AdminMembersResponse>(`/admin/members${cycleParam}`)
      .then((data) => {
        const list = data.members || [];
        setMembers(list);
        // 사이클을 전환하면서 이전에 선택했던 회원이 그 주차 명단에 없으면
        // (예: 이번엔 있었지만 그 주엔 없었던 회원) "내 대시보드"로 되돌린다
        // — 존재하지 않는 회원을 선택한 채로 남아있는 오류 상태 방지.
        setSelected((prev) => (prev === SELF_VALUE || list.some((m) => m.number === prev) ? prev : SELF_VALUE));
      })
      .catch((err) => setMembersError(err instanceof Error ? err.message : "회원 목록을 불러오지 못했습니다."));
  }

  // 🔧 [사용자 지시] "드롭다운의 폴링은 클릭할 때마다 발생하게 할 수
  // 있어?" — 이 목록은 자동 폴링이 없어(최초 마운트/사이클 전환 시에만
  // 조회) 대시보드를 오래 띄워두면 신규 회원이 안 보일 수 있었다.
  // ReportPage의 참여자 선택 드롭다운과 동일하게, 드롭다운을 열 때마다
  // (onOpenChange) 다시 불러오게 한다.
  useEffect(loadMembers, [isAdmin, isViewingCycle, cycleFileId]); // eslint-disable-line react-hooks/exhaustive-deps

  function reload() {
    if (usingMyStatus) {
      myStatus.refresh();
      return;
    }
    let cancelled = false;
    setOtherLoading(true);
    setOtherError(null);
    const cycleParam = isViewingCycle ? `?cycle=${encodeURIComponent(String(cycleFileId))}` : "";
    const path = selected === SELF_VALUE ? `/status${cycleParam}` : `/admin/members/${encodeURIComponent(selected)}${cycleParam}`;
    call<StatusResponse>(path)
      .then((data) => {
        if (!cancelled) setOtherStatus(data);
      })
      .catch((err) => {
        if (!cancelled) setOtherError(err instanceof Error ? err.message : "상태를 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!cancelled) setOtherLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }

  useEffect(reload, [selected, cycleFileId]); // eslint-disable-line react-hooks/exhaustive-deps
  // 관리자가 다른 곳에서 처리한 벌금/반휴/페널티 결과가 이 화면을 벗어난
  // 사이에도 바뀔 수 있어, 돌아올 때마다 새로 불러온다.
  useRefreshOnVisible(visible, reload);
  // 🔧 [2026-09 재조정] buildPersonalStatus가 조합하는 캐시들의 TTL을
  // 10분으로 통일하면서, 폴링 주기도 그 3배인 30분으로 늘렸다(기존
  // 15분 — docs/CACHING_POLICY.md §12.1 참고).
  const refreshProgress = usePollingRefresh(visible, reload, 30 * 60_000);

  return (
    // 🔧 [사용자 지시] "MY도 헤더 제목으로 박스 안에 묶으려고 하거든?" —
    // 원래는 안쪽 StatusView가 이미 SummaryTile(각자 자체 카드)과 요일별
    // 카드로 구성돼 있어 바깥 Card를 두면 이중 테두리만 생긴다는 이유로
    // 감싸는 카드를 없앴었는데, 이번엔 제보 화면("화각 불량 제보")과
    // 동일하게 SectionCard+SectionHeader로 전체를 감싸 제목 있는 탭
    // 형태로 통일한다.
    <SectionCard className="shadow-sm shadow-black/[0.03]">
      <Collapsible defaultOpen className="flex flex-col">
        <SectionHeader
          icon={User}
          title="내 대시보드"
          loading={loading}
          onRefresh={reload}
          refreshProgress={refreshProgress}
          iconVariant="tint"
          trailing={
            isAdmin ? (
              // 🔧 [사용자 지시] "관리자 드롭다운을 헤더 영역에 넣어버릴 수
              // 있나?" — CycleSwitcher와 한 줄을 다투던 회원 선택 드롭다운을
              // 제목 옆(새로고침 버튼 왼쪽)으로 옮겨, 본문 폭을 CycleSwitcher가
              // 온전히 쓰게 한다. 🔧 [로딩 중 빈 목록 오해 방지] members가
              // 아직 null(회원 목록 응답 전)일 때 드롭다운을 열면 "내
              // 대시보드" 옵션만 있고 다른 회원은 하나도 안 보여, 순간적으로
              // "다른 회원이 없다"로 오해할 수 있었다. 이 짧은 로딩 구간엔
              // 트리거 자체를 비활성화한다 — 이 앱의 다른 Select들
              // (NewMemberForm, SimpleNoticeSection 등)과 동일한 컨벤션.
              <Select
                value={selected}
                onValueChange={(v) => setSelected(v ?? SELF_VALUE)}
                disabled={!members}
                onOpenChange={(open) => {
                  if (open) loadMembers();
                }}
              >
                {/* 🔧 [사용자 지시] "'화각 불량 제보'의 헤더 배경 높이랑 '내
                    대시보드'의 높이랑 다른거 아니야?" — 이 드롭다운(h-8/
                    sm:h-9, 32px/36px)이 옆의 새로고침 버튼(icon-sm, size-7
                    고정 28px)보다 커서 헤더 전체 높이가 그만큼 늘어나
                    있었다. 새로고침 버튼과 같은 높이(h-7=28px)로 맞춘다. */}
                <SelectTrigger className="w-fit shrink-0 bg-card data-[size=default]:h-7 sm:text-sm">
                  <SelectValue>
                    {selected === SELF_VALUE ? "내 대시보드" : members?.find((m) => m.number === selected)?.name}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SELF_VALUE} className="sm:text-base">
                    내 대시보드
                  </SelectItem>
                  {members?.map((m) => (
                    <SelectItem key={m.number} value={m.number} className="sm:text-base">
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : undefined
          }
        />
        <CollapsiblePanel className="flex flex-col gap-5">
      {onSelectCycle && (
        <CycleSwitcher
          selectedFileId={cycleFileId ?? null}
          onSelect={onSelectCycle}
          memberNumber={selected === SELF_VALUE ? "self" : selected}
        />
      )}
      {membersError && (
        <Alert variant="destructive">
          <AlertDescription>{membersError}</AlertDescription>
        </Alert>
      )}

      <div className="relative">
        <StatusView
          status={status}
          allowGoalSchedule={!isViewingCycle && selected === SELF_VALUE}
          // 🔧 [사용자 지시] "오늘이 아닌 과거 일자의 반일 휴무 신청은
          // 블락하되, 관리자가 다른 회원의 대시보드를 띄웠을 때는 예외로
          // 허용" — 실수를 대신 등록해주는 용도이므로 대상은 실시간(현재
          // 진행 중인 시트) 조회로 한정한다. 과거 사이클(isViewingCycle)은
          // 이미 끝난 주라 "신청"이라는 개념 자체가 성립하지 않는다.
          adminTargetNumber={isAdmin && !isViewingCycle && selected !== SELF_VALUE ? selected : undefined}
          isViewingCycle={isViewingCycle}
          onLeaveApplied={(day, type, delta) => {
            const applyLeaveDelta = (prev: StatusResponse | null) => {
              if (!prev) return prev;
              const usedField = type === "normal" ? "normalLeaveUsed" : "reasonLeaveUsed";
              const leftField = type === "normal" ? "normalLeaveLeft" : "reasonLeaveLeft";
              // 신청(delta > 0)은 잔여량을 그만큼 줄이고, 취소(delta < 0)는
              // 그만큼 되돌린다 — 새로고침 없이 "반휴권 잔여량" 카드가 즉시
              // 맞아떨어지게 한다. left는 문자열(시트 표시값)이라 숫자로
              // 변환해 계산한 뒤 다시 문자열로 되돌린다.
              const nextLeft = Math.max(0, Number(prev[leftField] || 0) - delta);
              return {
                ...prev,
                [leftField]: String(nextLeft),
                days: prev.days.map((d) =>
                  d.day === day ? { ...d, [usedField]: Math.max(0, d[usedField] + delta) } : d
                ),
              };
            };
            if (usingMyStatus) {
              myStatus.setStatus(applyLeaveDelta);
            } else {
              setOtherStatus(applyLeaveDelta);
            }
          }}
          onReasonLeaveSubmitted={reload}
        />
        {loading && status && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/60 backdrop-blur-[1px]"
            aria-hidden="true"
          >
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
        </CollapsiblePanel>
      </Collapsible>
    </SectionCard>
  );
}
