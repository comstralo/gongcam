import { useEffect, useState } from "react";
import { Users, User, DoorOpen, ChevronDown, Hash, Star, Bell, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { InfoCard, SubRow, TintedPill } from "@/components/dashboard/shared";
import { SectionHeader } from "@/components/admin/shared";
import { ExitProcessDialog } from "@/components/admin/ExitProcessDialog";
import { useApi } from "@/hooks/useApi";
import { ICON_STROKE, cn } from "@/lib/utils";
import type {
  AdminMembersRosterResponse,
  MemberRosterEntry,
  NotifyCategory,
  SetPartiStatusResponse,
} from "@/lib/api/types";

// StatusView.tsx의 동일 함수와 같은 표시 규칙 — "8H (교시제)" 같은 시트
// 원본 값에서 괄호만 제거해 "8H 교시제"로 보여준다.
function formatGoalType(raw: string): string {
  if (!raw) return "-";
  return raw.replace(/[()]/g, "").replace(/\s+/g, " ").trim();
}

export function MemberRosterList() {
  const { call } = useApi();

  const [members, setMembers] = useState<MemberRosterEntry[] | null>(null);
  // 카테고리 키("report_result" 등)를 사람이 읽을 라벨("제보 처리 결과")로
  // 바꾸는 데 쓴다 — 서버가 roster 응답과 함께 내려준다(/notify-prefs와
  // 동일한 카테고리 정의를 그대로 재사용).
  const [notifyCategories, setNotifyCategories] = useState<Record<string, string> | null>(null);
  // 시트번호를 눌렀을 때 그 회원 탭으로 바로 이동하는 링크를 만드는 데 쓴다.
  const [spreadsheetId, setSpreadsheetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedNumber, setExpandedNumber] = useState<string | null>(null);
  const [cancelingNumber, setCancelingNumber] = useState<string | null>(null);
  const [togglingNumber, setTogglingNumber] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    call<AdminMembersRosterResponse>("/admin/members/roster")
      .then((data) => {
        setMembers(data.members || []);
        setNotifyCategories(data.notifyCategories || null);
        setSpreadsheetId(data.spreadsheetId || null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "스터디원 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  function cancelExitRequest(number: string) {
    setCancelingNumber(number);
    setError(null);
    call<{ ok: boolean }>("/exit-request/cancel", { method: "POST", body: { number } })
      .then(load)
      .catch((err) => setError(err instanceof Error ? err.message : "퇴실 신청 취소에 실패했습니다."))
      .finally(() => setCancelingNumber(null));
  }

  function toggleViceLeader(m: MemberRosterEntry) {
    setTogglingNumber(m.number);
    setError(null);
    call<SetPartiStatusResponse>("/admin/members/parti-status", {
      method: "POST",
      body: { number: m.number, appoint: m.partiStatus !== "부스터디장" },
    })
      .then(load)
      .catch((err) => setError(err instanceof Error ? err.message : "부스터디장 임명/해제에 실패했습니다."))
      .finally(() => setTogglingNumber(null));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Collapsible defaultOpen className="flex flex-col gap-4">
      <SectionHeader icon={Users} title="스터디원 목록" loading={loading} onRefresh={load} />
      <div className="h-px w-full bg-border" />
      <CollapsiblePanel className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading && !members && (
          <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">불러오는 중...</p>
        )}

        {!loading && members && members.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">등록된 스터디원이 없습니다.</p>
        )}

        {members && members.length > 0 && (
          <div className="flex flex-col gap-2 sm:gap-2.5">
            {members.map((m) => {
              const isExpanded = expandedNumber === m.number;
              return (
                <InfoCard key={m.number} className="flex flex-col gap-2.5">
                  <button
                    type="button"
                    onClick={() => setExpandedNumber(isExpanded ? null : m.number)}
                    className="flex items-center justify-between gap-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded"
                  >
                    <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                      <User className="size-3 shrink-0 text-muted-foreground sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                      {m.name}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <TintedPill
                        tone={m.partiStatus === "스터디장" ? "primary" : m.partiStatus === "부스터디장" ? "ok" : "muted"}
                        className="px-2 py-1 leading-none"
                      >
                        {m.partiStatus}
                      </TintedPill>
                      {m.exitRequested && <TintedPill tone="amber">퇴실 예약</TintedPill>}
                      <ChevronDown
                        className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isExpanded && "rotate-180")}
                        strokeWidth={ICON_STROKE.default}
                      />
                    </span>
                  </button>

                  {isExpanded && (
                    <>
                      <div className="flex flex-col gap-1.5 rounded-xl border bg-card p-4 sm:p-5">
                        <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                          <Hash className="size-3.5 sm:size-4" strokeWidth={ICON_STROKE.default} />
                          상태 정보
                        </span>
                        <SubRow label="참여유형" value={formatGoalType(m.goalType)} />
                        <SubRow label="준비 중인 시험" value={m.examKind || "-"} />
                        <SubRow label="가입일자" value={m.joinDate || "-"} />
                        <SubRow label="구글 계정" value={m.googleAccount || "-"} />
                        <SubRow label="구루미 계정" value={m.gooroomeeAccount || "-"} />
                        <SubRow
                          label="시트번호"
                          value={
                            spreadsheetId && m.sheetGid !== null ? (
                              <a
                                href={`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${m.sheetGid}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
                              >
                                {m.number}번
                                <ExternalLink className="size-3 shrink-0" strokeWidth={ICON_STROKE.default} />
                              </a>
                            ) : (
                              `${m.number}번`
                            )
                          }
                        />
                        {m.exitRequested && (
                          <SubRow
                            label="퇴실 예약일자"
                            value={m.exitRequestDate ? `${m.exitRequestDate} 희망` : "접수됨"}
                            valueClassName="text-amber-600 dark:text-amber-400"
                          />
                        )}
                        <SubRow
                          label="최근 접속일자"
                          value={m.lastLoginAt ? new Date(m.lastLoginAt).toLocaleString("ko-KR") : "-"}
                        />
                        <SubRow label="최근 접속 IP" value={m.lastLoginIp || "-"} />
                      </div>

                      {/* 🔧 [관리자용 알림 설정 열람] 조회 전용 — 실제 변경은
                          회원 본인만 자기 대시보드의 알림 설정에서 할 수 있다. */}
                      <div className="flex flex-col gap-1.5 rounded-xl border bg-card p-4 sm:p-5">
                        <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                          <Bell className="size-3.5 sm:size-4" strokeWidth={ICON_STROKE.default} />
                          알림 설정
                        </span>
                        {/* 🔧 [PUSH 구독 OFF 시 세부 항목도 OFF로 표시] PUSH
                            구독은 알림 수신의 최상위 조건이다 — 꺼져 있으면
                            카테고리별 설정이 ON이어도 실제로는 아무 알림도
                            못 받는다. 저장된 원본값을 그대로 보여주면 "구독은
                            꺼졌는데 세부 항목은 죄다 ON"으로 보여 혼란을
                            줬다(사용자 지적) — PUSH 구독 행 자체는 없애고,
                            구독이 꺼진 회원은 세부 항목을 실제 저장값과
                            무관하게 전부 OFF로 보여준다. */}
                        {notifyCategories &&
                          Object.entries(notifyCategories).map(([key, label]) => {
                            const enabled = m.pushSubscribed && m.notifyPrefs[key as NotifyCategory];
                            return (
                              <SubRow
                                key={key}
                                label={label}
                                value={enabled ? "ON" : "OFF"}
                                valueClassName={enabled ? "text-ok" : "text-muted-foreground"}
                              />
                            );
                          })}
                      </div>

                      {/* 🔧 [퇴실 처리 버튼 분리] "스터디원 목록"은 자진 퇴실
                          전용 화면이다 — 페널티 누적으로 인한 강제퇴실/예치금
                          재납은 "페널티 대상자" 화면에서 별도로 처리하므로
                          여기서는 유형을 직접 고를 필요가 없다(오히려 관리자가
                          같은 회원에게 kind만 다르게 골라 반환율이 달라지는
                          걸 방지하기 위함, 사용자 지적: "무조건 계산은 어디서나
                          일치해야 해"). "직권 P"(admin_forced, 즉시 0% 반환)와
                          "정산"(settle, 페널티 0/1회 기준 100%/50% 반환) 두
                          가지로 고정하고, 정산은 회원이 실제로 퇴실 신청(예약)
                          한 경우에만 누를 수 있게 한다. */}
                      <div className={cn("grid gap-2", m.exitRequested ? "grid-cols-4" : "grid-cols-3")}>
                        <Button
                          variant="outline"
                          className="w-full sm:h-12 sm:text-base"
                          disabled={m.partiStatus === "스터디장" || togglingNumber === m.number}
                          onClick={() => toggleViceLeader(m)}
                        >
                          <Star className="size-3.5 shrink-0" strokeWidth={ICON_STROKE.default} />
                          {m.partiStatus === "부스터디장" ? "임명 해제" : "부스터디장 임명"}
                        </Button>
                        <ExitProcessDialog candidate={m} lockKind="admin_forced" onConfirmed={load} triggerClassName="w-full">
                          <Button variant="destructive" className="w-full sm:h-12 sm:text-base">
                            <DoorOpen className="size-3.5 shrink-0" strokeWidth={ICON_STROKE.default} />
                            퇴실 처리 (직권 P)
                          </Button>
                        </ExitProcessDialog>
                        <ExitProcessDialog
                          candidate={m}
                          lockKind="settle"
                          onConfirmed={load}
                          triggerClassName={cn("w-full", !m.exitRequested && "pointer-events-none")}
                        >
                          <Button
                            variant="destructive"
                            className="w-full sm:h-12 sm:text-base"
                            disabled={!m.exitRequested}
                          >
                            <DoorOpen className="size-3.5 shrink-0" strokeWidth={ICON_STROKE.default} />
                            퇴실 처리 (정산)
                          </Button>
                        </ExitProcessDialog>
                        {m.exitRequested && (
                          <Button
                            variant="outline"
                            className="w-full sm:h-12 sm:text-base"
                            disabled={cancelingNumber === m.number}
                            onClick={() => cancelExitRequest(m.number)}
                          >
                            신청 취소
                          </Button>
                        )}
                      </div>
                    </>
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
