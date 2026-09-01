import { useState, type ReactNode } from "react";
import { DoorOpen, TriangleAlert, CircleCheck, Circle, MessageSquareWarning } from "lucide-react";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { InfoCard } from "@/components/dashboard/shared";
import { FieldValue } from "@/components/admin/shared";
import { useApi } from "@/hooks/useApi";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { ExitCandidate, ExitCheckItem, ExitKind, ExitPreviewResponse, ExitConfirmResponse } from "@/lib/api/types";

// MemberRosterList(전체 명단)와 PenaltyCandidateList(예치금 재납 대상자) 둘
// 다 이 다이얼로그를 쓰지만, 서로 다른 타입(MemberRosterEntry/ExitCandidate)의
// 항목을 넘긴다. 이 다이얼로그가 실제로 쓰는 필드만 최소 타입으로 요구해야
// 두 목록 타입이 각자 필요한 필드만 갖고도 호환된다.
type ExitProcessCandidate = Pick<ExitCandidate, "number" | "name" | "suggestedKind" | "allChecks">;

const KIND_LABEL: Record<ExitKind, string> = {
  forced: "강제 퇴실자",
  admin_forced: "직권 퇴실자",
  settle: "정산 퇴실자",
  deposit_again: "예치금 재납자",
};

// 강제퇴실 조건 전체(해당 여부 무관)를 체크리스트 형태로 보여준다.
// 해당되는 항목만 강조(체크 아이콘, destructive 색)하고, 나머지는 무채색으로
// 그대로 나열해 관리자가 "왜 이 사람이 대상이 됐는지/안 됐는지"를 한눈에 본다.
function ForcedExitChecklist({ checks }: { checks: ExitCheckItem[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {checks.map((c) => (
        <li
          key={c.code}
          className={cn(
            "flex items-start gap-1.5 text-xs sm:text-sm",
            c.met ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {c.met ? (
            <CircleCheck className="size-3.5 shrink-0 translate-y-0.5" />
          ) : (
            <Circle className="size-3.5 shrink-0 translate-y-0.5" />
          )}
          <span>{c.label}</span>
        </li>
      ))}
    </ul>
  );
}

export function ExitProcessDialog({
  candidate,
  onConfirmed,
  triggerClassName,
  lockKind,
  children,
}: {
  candidate: ExitProcessCandidate;
  // 실제로 확정된 유형(forced/admin_forced/settle/deposit_again)을 함께
  // 넘긴다 — 호출부(PenaltyCandidateList 등)가 "이 회원이 강퇴로 처리됐는지
  // 재납으로 처리됐는지"를 화면 상태로 구분해 보여줘야 하기 때문이다.
  onConfirmed?: (kind: ExitKind) => void;
  triggerClassName?: string;
  // 페널티 2 이상은 반환율이 항상 0%로 고정되는 정산 퇴실자(settle) 단일
  // 경로라, PENALTY 탭에서는 유형 선택 UI 자체를 숨기고 이 값으로 고정한다.
  lockKind?: ExitKind;
  children: ReactNode;
}) {
  const { call } = useApi();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ExitKind>(lockKind ?? candidate.suggestedKind);
  const [forcedReason, setForcedReason] = useState("");
  // 🔧 [직권 P 퇴실 전용 UI] 이 처리는 관리자가 사유만 입력하면 바로
  // 확정할 수 있는 단순한 흐름이라, 다른 유형(강제/정산/재납)과 공유하는
  // "처리 유형 선택 → 미리보기 계산 → 확정" 단계를 그대로 노출할 필요가
  // 없다(사용자 지적) — discountRatio가 이미 항상 1(0% 반환)로 고정되어
  // 있어 미리보기가 보여줄 새로운 정보도 없다.
  const isAdminForcedOnly = lockKind === "admin_forced";

  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<ExitPreviewResponse | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetForNewKind(next: ExitKind) {
    setKind(next);
    setPreview(null);
    setError(null);
  }

  async function handlePreview() {
    setPreviewing(true);
    setError(null);
    setPreview(null);
    try {
      const data = await call<ExitPreviewResponse>("/admin/exit/preview", {
        method: "POST",
        body: { number: candidate.number, kind, forcedReason: kind === "admin_forced" ? forcedReason : undefined },
      });
      setPreview(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "미리보기 계산에 실패했습니다.");
    } finally {
      setPreviewing(false);
    }
  }

  async function handleConfirm() {
    setConfirming(true);
    setError(null);
    try {
      await call<ExitConfirmResponse>("/admin/exit/confirm", {
        method: "POST",
        body: { number: candidate.number, kind, forcedReason: kind === "admin_forced" ? forcedReason : undefined },
      });
      setConfirmed(true);
      onConfirmed?.(kind);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "확정 처리에 실패했습니다.");
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setPreview(null);
          setError(null);
          setConfirmed(false);
          setForcedReason("");
          setKind(lockKind ?? candidate.suggestedKind);
        }
      }}
    >
      <DialogTrigger
        className={cn(
          "w-full rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
          triggerClassName
        )}
      >
        {children}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <DoorOpen className="size-4 text-primary sm:size-5" />
            {isAdminForcedOnly ? (
              <>직권 P 퇴실 처리 · {candidate.name}</>
            ) : (
              <>{candidate.name} · 퇴실·재납 처리</>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {confirmed ? (
            <Alert>
              <AlertDescription>
                처리가 완료되었습니다. 시트가 백업 탭으로 옮겨지고 원래 슬롯은 초기화되었습니다.
              </AlertDescription>
            </Alert>
          ) : isAdminForcedOnly ? (
            <>
              <InfoCard className="flex flex-col gap-1.5">
                <Label
                  htmlFor="forced-reason"
                  className="flex items-center gap-1.25 text-xs font-semibold text-muted-foreground sm:text-sm"
                >
                  <MessageSquareWarning className="size-3.5 shrink-0 sm:size-4" />
                  직권 퇴실 사유
                </Label>
                <Input
                  id="forced-reason"
                  value={forcedReason}
                  onChange={(e) => setForcedReason(e.target.value)}
                  placeholder="예: 비매너 행위로 인한 즉시 퇴실"
                  className="sm:h-12 sm:text-base"
                />
              </InfoCard>

              <InfoCard className="flex flex-col gap-1 border-destructive/30 bg-destructive/5">
                <div className="flex items-center gap-1.5 text-destructive">
                  <TriangleAlert className="size-3.5 shrink-0 sm:size-4" />
                  <span className="text-xs font-semibold sm:text-sm">주의사항</span>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
                  확정하면 현재 시트가 백업 탭으로 옮겨지고 원래 슬롯이 초기화됩니다. 되돌릴 수 없으니
                  내용을 다시 확인한 뒤 진행하세요.
                </p>
              </InfoCard>

              <Button
                className="w-full sm:h-12 sm:text-base"
                variant="destructive"
                disabled={confirming || !forcedReason.trim()}
                onClick={handleConfirm}
              >
                {confirming ? "처리 중..." : "확정 처리"}
              </Button>
            </>
          ) : (
            <>
              <InfoCard className="flex flex-col gap-2">
                <Label className="text-xs font-semibold text-muted-foreground sm:text-sm">처리 유형</Label>
                {lockKind ? (
                  <FieldValue className="text-sm sm:text-base">{KIND_LABEL[lockKind]}</FieldValue>
                ) : (
                  <Select value={kind} onValueChange={(v) => v && resetForNewKind(v as ExitKind)}>
                    <SelectTrigger className="bg-card data-[size=default]:h-8 sm:data-[size=default]:h-12 sm:text-base">
                      <SelectValue>{KIND_LABEL[kind]}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="forced" className="sm:text-base">
                        {KIND_LABEL.forced}
                      </SelectItem>
                      <SelectItem value="admin_forced" className="sm:text-base">
                        {KIND_LABEL.admin_forced}
                      </SelectItem>
                      <SelectItem value="settle" className="sm:text-base">
                        {KIND_LABEL.settle}
                      </SelectItem>
                      <SelectItem value="deposit_again" className="sm:text-base">
                        {KIND_LABEL.deposit_again}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}

                {kind === "admin_forced" && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="forced-reason" className="text-xs font-medium text-muted-foreground sm:text-sm">
                      직권 퇴실 사유
                    </Label>
                    <Input
                      id="forced-reason"
                      value={forcedReason}
                      onChange={(e) => setForcedReason(e.target.value)}
                      placeholder="예: 비매너 행위로 인한 즉시 퇴실"
                      className="sm:h-12 sm:text-base"
                    />
                  </div>
                )}

                {kind === "forced" && candidate.allChecks && candidate.allChecks.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
                      강제퇴실 조건 (해당 항목만 적용됨)
                    </Label>
                    <ForcedExitChecklist checks={candidate.allChecks} />
                  </div>
                )}
              </InfoCard>

              <Button variant="outline" className="w-full sm:h-12 sm:text-base" disabled={previewing} onClick={handlePreview}>
                {previewing ? "계산 중..." : "미리보기 계산"}
              </Button>

              {preview && (
                <InfoCard className="flex flex-col gap-2">
                  <span className="text-xs font-semibold sm:text-sm">{preview.kindStr} 처리 결과</span>
                  {preview.allChecks.length > 0 && <ForcedExitChecklist checks={preview.allChecks} />}
                  <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground sm:text-sm">
                    {preview.resultMsg}
                  </pre>
                </InfoCard>
              )}

              {preview && (
                <InfoCard className="flex flex-col gap-1 border-destructive/30 bg-destructive/5">
                  <div className="flex items-center gap-1.5 text-destructive">
                    <TriangleAlert className="size-3.5 shrink-0 sm:size-4" />
                    <span className="text-xs font-semibold sm:text-sm">주의사항</span>
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
                    확정하면 현재 시트가 백업 탭으로 옮겨지고 원래 슬롯이 초기화됩니다. 되돌릴 수 없으니
                    내용을 다시 확인한 뒤 진행하세요.
                  </p>
                </InfoCard>
              )}

              {preview && (
                <Button
                  className="w-full sm:h-12 sm:text-base"
                  variant="destructive"
                  disabled={confirming}
                  onClick={handleConfirm}
                >
                  {confirming ? "처리 중..." : "확정 처리"}
                </Button>
              )}
            </>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
