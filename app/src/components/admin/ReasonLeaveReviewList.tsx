import { useEffect, useState } from "react";
import { BedDouble, ChevronDown, CalendarDays, User, FileText, Image as ImageIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { InfoCard, SubRow, TintedPill } from "@/components/dashboard/shared";
import { SectionHeader, CapturePreview, AdminListSkeleton } from "@/components/admin/shared";
import { useApi } from "@/hooks/useApi";
import { useRefreshOnVisible } from "@/hooks/useRefreshOnVisible";
import { useAuth } from "@/lib/auth/useAuth";
import { ICON_STROKE, cn } from "@/lib/utils";
import type { LeaveProofReviewItem, LeaveProofListResponse, LeaveProofDecideResponse } from "@/lib/api/types";

const STATUS_DAYS = ["월", "화", "수", "목", "금", "토", "일"];

// 오늘 날짜 기준 이번 주(월~일)의 각 요일 실제 날짜를 "8월 19일" 형태로
// 계산한다(송출 P 제보 확인의 thisWeekDateLabel과 동일 패턴).
function thisWeekDateLabel(dayKr: string): string {
  const dayIndex = STATUS_DAYS.indexOf(dayKr);
  if (dayIndex === -1) return "";
  const now = new Date();
  const todayIndex = (now.getDay() + 6) % 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - todayIndex);
  const target = new Date(monday);
  target.setDate(monday.getDate() + dayIndex);
  return `${target.getMonth() + 1}월 ${target.getDate()}일`;
}

// 신청의 day 필드(이미 요일 문자열)를 기준으로 요일별로 묶는다.
function groupByDay(items: LeaveProofReviewItem[]) {
  const map = new Map<string, LeaveProofReviewItem[]>();
  for (const item of items) {
    const existing = map.get(item.day);
    if (existing) existing.push(item);
    else map.set(item.day, [item]);
  }
  return STATUS_DAYS.filter((d) => map.has(d)).map((day) => ({ day, items: map.get(day)! }));
}

export function ReasonLeaveReviewList({ visible }: { visible: boolean }) {
  const { call } = useApi();
  const { session } = useAuth();

  const [items, setItems] = useState<LeaveProofReviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 승인/반려 완료된 항목도 목록에서 지우지 않고 화면 상태로만 표시한다
  // (봇 manifest 재조회 없이 즉시 배지 전환).
  const [approved, setApproved] = useState<Record<string, true>>({});
  const [rejected, setRejected] = useState<Record<string, { reason: string }>>({});
  // 반려 버튼을 누르면 사유 입력 필드를 펼치고, "반려 확정"을 눌러야 실제 반려된다.
  const [rejecting, setRejecting] = useState<Record<string, boolean>>({});
  const [rejectReasonDraft, setRejectReasonDraft] = useState<Record<string, string>>({});
  const [botSyncFailedIds, setBotSyncFailedIds] = useState<Record<string, true>>({});

  function load() {
    setLoading(true);
    setError(null);
    call<LeaveProofListResponse>("/admin/leave-proof")
      .then((data) => setItems(data.items || []))
      .catch((err) => setError(err instanceof Error ? err.message : "사유반휴 신청 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 새 반휴 신청이 탭을 벗어난 사이에 들어올 수 있어, 돌아올 때마다 새로
  // 불러와야 처리가 늦어지지 않는다.
  useRefreshOnVisible(visible, load);

  function decide(item: LeaveProofReviewItem, decision: "approved" | "rejected", rejectReason?: string) {
    setDecidingId(item.id);
    setError(null);
    call<LeaveProofDecideResponse>("/admin/leave-proof/decide", {
      method: "POST",
      body: {
        id: item.id,
        decision,
        memberNumber: item.memberNumber,
        day: item.day,
        count: item.count,
        ...(rejectReason ? { rejectReason } : {}),
      },
    })
      .then((data) => {
        if (decision === "approved") {
          setApproved((prev) => ({ ...prev, [item.id]: true }));
          if (data.botSyncFailed) setBotSyncFailedIds((prev) => ({ ...prev, [item.id]: true }));
        } else {
          setRejected((prev) => ({ ...prev, [item.id]: { reason: rejectReason || "" } }));
          setRejecting((prev) => ({ ...prev, [item.id]: false }));
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "처리에 실패했습니다."))
      .finally(() => setDecidingId(null));
  }

  return (
    <Collapsible defaultOpen className="flex flex-col gap-4">
      <SectionHeader icon={BedDouble} title="사유 반휴 신청 대상 처리" loading={loading} onRefresh={load} />
      <CollapsiblePanel className="flex flex-col gap-4">
        {/* 🔧 2026-09: 이 구분선을 SectionHeader와 CollapsiblePanel 사이(항상
            보이는 위치)가 아니라 패널 안(접히면 함께 사라짐)으로 옮겼다 —
            토글이 접혀있을 때도 구분선만 남아 보이던 문제(사용자 지적)를
            같은 패턴을 쓰는 모든 접이식 섹션에서 일괄 수정. */}
        <div className="h-px w-full bg-border" />
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading && !items && <AdminListSkeleton />}

        {!loading && items && items.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">검토 대기 중인 신청이 없습니다.</p>
        )}

        {items && items.length > 0 && (
          <div className="flex flex-col gap-2 sm:gap-2.5">
            {groupByDay(items).map((group) => {
              const isDayExpanded = expandedDay === group.day;
              const approvedCount = group.items.filter((item) => approved[item.id]).length;
              const rejectedCount = group.items.filter((item) => rejected[item.id]).length;
              const pendingCount = group.items.length - approvedCount - rejectedCount;
              return (
                <InfoCard key={group.day} className="flex flex-col gap-2.5">
                  <button
                    type="button"
                    onClick={() => setExpandedDay(isDayExpanded ? null : group.day)}
                    className="flex items-center justify-between gap-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded"
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      <span className="inline-flex shrink-0 items-center gap-1.25 text-xs font-semibold text-muted-foreground sm:text-sm">
                        <CalendarDays className="size-3 shrink-0 sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                        {thisWeekDateLabel(group.day)} {group.day}요일
                      </span>
                      <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
                        <span className="rounded-full bg-destructive/15 px-2 py-1 text-micro-lg leading-none sm:text-xs font-semibold text-destructive">
                          대기 : {pendingCount}건
                        </span>
                        <span className="rounded-full bg-ok/15 px-2 py-1 text-micro-lg leading-none sm:text-xs font-semibold text-ok">
                          승인 : {approvedCount}건
                        </span>
                        <span className="rounded-full bg-amber-600/15 px-2 py-1 text-micro-lg leading-none sm:text-xs font-semibold text-amber-600 dark:bg-amber-400/15 dark:text-amber-400">
                          반려 : {rejectedCount}건
                        </span>
                      </span>
                    </span>
                    <ChevronDown
                      className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isDayExpanded && "rotate-180")}
                      strokeWidth={ICON_STROKE.default}
                    />
                  </button>

                  {isDayExpanded && (
                    <div className="flex flex-col gap-2.5">
                      {group.items.map((item) => {
                        const isMemberExpanded = expandedId === item.id;
                        const isApproved = !!approved[item.id];
                        const rejectedInfo = rejected[item.id];
                        const isRejected = !!rejectedInfo;
                        const isRejecting = !!rejecting[item.id];
                        return (
                          <div key={item.id} className="flex flex-col gap-2.5 rounded-lg border bg-card p-3">
                            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                              <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                                <User className="size-3 shrink-0 text-muted-foreground sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                                {item.memberName}
                              </span>
                              <div className="flex items-center gap-1.5">
                                {!isApproved && !isRejected && item.queued && (
                                  <TintedPill tone="amber">봇 대기중</TintedPill>
                                )}
                                {isApproved ? (
                                  <TintedPill tone="ok">승인</TintedPill>
                                ) : isRejected ? (
                                  <TintedPill tone="amber">반려</TintedPill>
                                ) : (
                                  <TintedPill tone="warn">대기</TintedPill>
                                )}
                                <Button
                                  variant="outline"
                                  size="icon-sm"
                                  onClick={() => setExpandedId(isMemberExpanded ? null : item.id)}
                                  aria-label={isMemberExpanded ? "상세 접기" : "상세 펼치기"}
                                >
                                  <ChevronDown
                                    className={cn("size-3.5 transition-transform", isMemberExpanded && "rotate-180")}
                                    strokeWidth={ICON_STROKE.default}
                                  />
                                </Button>
                              </div>
                            </div>

                            {isMemberExpanded && (
                              <>
                                <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:gap-3.5 sm:p-5">
                                  <div className="flex flex-col gap-1.5">
                                    <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                                      <ImageIcon className="size-3.5 sm:size-4" strokeWidth={ICON_STROKE.default} />
                                      증빙 이미지
                                    </span>
                                    {session?.token ? (
                                      <CapturePreview id={item.id} token={session.token} endpoint="/admin/leave-proof/file" />
                                    ) : (
                                      <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed bg-muted">
                                        <p className="text-xs text-muted-foreground sm:text-sm">
                                          미리보기를 불러오지 못했습니다.
                                        </p>
                                      </div>
                                    )}
                                  </div>

                                  <div className="h-px w-full bg-border" />

                                  <div className="flex flex-col gap-1.5">
                                    <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                                      <FileText className="size-3.5 sm:size-4" strokeWidth={ICON_STROKE.default} />
                                      신청 정보
                                    </span>
                                    <SubRow label="사유" value={item.reason || "-"} />
                                    <SubRow label="신청 장수" value={`${item.count ?? 1}장`} />
                                    <SubRow label="신청일시" value={new Date(item.ts).toLocaleString("ko-KR")} />
                                  </div>

                                  {isRejected && (
                                    <>
                                      <div className="h-px w-full bg-border" />
                                      <SubRow
                                        label="반려 사유"
                                        value={rejectedInfo.reason || "-"}
                                        valueClassName="text-destructive"
                                      />
                                    </>
                                  )}

                                  {isApproved && botSyncFailedIds[item.id] && (
                                    <Alert variant="destructive">
                                      <AlertDescription>
                                        시트엔 반영되었으나 봇 동기화에 실패해 학생 화면의 대기 배지가 남아있을 수
                                        있습니다.
                                      </AlertDescription>
                                    </Alert>
                                  )}
                                </div>

                                {!isApproved && !isRejected && (
                                  <>
                                    {isRejecting ? (
                                      <div className="flex flex-col gap-2 rounded-xl border bg-card p-4 sm:gap-2.5 sm:p-5">
                                        <Textarea
                                          placeholder="반려 사유를 입력해주세요"
                                          value={rejectReasonDraft[item.id] || ""}
                                          onChange={(e) =>
                                            setRejectReasonDraft((prev) => ({ ...prev, [item.id]: e.target.value }))
                                          }
                                          className="text-xs sm:text-sm"
                                        />
                                        <div className="grid grid-cols-2 gap-2">
                                          <Button
                                            variant="outline"
                                            className="sm:h-12 sm:text-base"
                                            disabled={decidingId === item.id}
                                            onClick={() => setRejecting((prev) => ({ ...prev, [item.id]: false }))}
                                          >
                                            취소
                                          </Button>
                                          <Button
                                            variant="destructive"
                                            className="sm:h-12 sm:text-base"
                                            disabled={decidingId === item.id || !rejectReasonDraft[item.id]?.trim()}
                                            onClick={() =>
                                              decide(item, "rejected", (rejectReasonDraft[item.id] || "").trim())
                                            }
                                          >
                                            반려 확정
                                          </Button>
                                        </div>
                                      </div>
                                    ) : (
                                      <div className="grid grid-cols-2 gap-2">
                                        <Button
                                          variant="destructive"
                                          className="sm:h-12 sm:text-base"
                                          disabled={decidingId === item.id}
                                          onClick={() => decide(item, "approved")}
                                        >
                                          사유반휴 적용 ({item.count ?? 1}장)
                                        </Button>
                                        <Button
                                          variant="outline"
                                          className="sm:h-12 sm:text-base"
                                          disabled={decidingId === item.id}
                                          onClick={() => setRejecting((prev) => ({ ...prev, [item.id]: true }))}
                                        >
                                          반려
                                        </Button>
                                      </div>
                                    )}
                                  </>
                                )}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </InfoCard>
              );
            })}
          </div>
        )}
      </CollapsiblePanel>
    </Collapsible>
  );
}
