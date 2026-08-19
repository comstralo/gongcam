import { useState, type ReactNode } from "react";
import { DoorOpen, TriangleAlert } from "lucide-react";
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
import type { ExitCandidate, ExitKind, ExitPreviewResponse, ExitConfirmResponse } from "@/lib/api/types";

const KIND_LABEL: Record<ExitKind, string> = {
  forced: "강제 퇴실자",
  admin_forced: "직권 퇴실자",
  settle: "정산 퇴실자",
  deposit_again: "예치금 재납자",
};

export function ExitProcessDialog({
  candidate,
  onConfirmed,
  triggerClassName,
  lockKind,
  children,
}: {
  candidate: ExitCandidate;
  onConfirmed?: () => void;
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
      onConfirmed?.();
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
            {candidate.name} · 퇴실·재납 처리
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {confirmed ? (
            <Alert>
              <AlertDescription>
                처리가 완료되었습니다. 시트가 백업 탭으로 옮겨지고 원래 슬롯은 초기화되었습니다.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <InfoCard className="flex flex-col gap-2">
                <Label className="text-xs font-semibold text-muted-foreground sm:text-sm">처리 유형</Label>
                {lockKind ? (
                  <FieldValue className="text-sm sm:text-base">{KIND_LABEL[lockKind]}</FieldValue>
                ) : (
                  <Select value={kind} onValueChange={(v) => v && resetForNewKind(v as ExitKind)}>
                    <SelectTrigger className="bg-card sm:h-12 sm:text-base">
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

                {kind === "forced" && candidate.reasonCodes && candidate.reasonCodes.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
                      감지된 강제퇴실 조건
                    </Label>
                    <ul className="flex flex-col gap-1">
                      {candidate.reasonCodes.map((r) => (
                        <li
                          key={r.code}
                          className="flex items-start gap-1.5 text-xs text-destructive sm:text-sm"
                        >
                          <TriangleAlert className="size-3.5 shrink-0 translate-y-0.5" />
                          <span>{r.label}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </InfoCard>

              <Button variant="outline" className="w-full sm:h-12 sm:text-base" disabled={previewing} onClick={handlePreview}>
                {previewing ? "계산 중..." : "미리보기 계산"}
              </Button>

              {preview && (
                <InfoCard className="flex flex-col gap-2">
                  <span className="text-xs font-semibold sm:text-sm">{preview.kindStr} 처리 결과</span>
                  {preview.reasons.length > 0 && (
                    <ul className="flex flex-col gap-1">
                      {preview.reasons.map((r) => (
                        <li
                          key={r.code}
                          className="flex items-start gap-1.5 text-xs text-destructive sm:text-sm"
                        >
                          <TriangleAlert className="size-3.5 shrink-0 translate-y-0.5" />
                          <span>{r.label}</span>
                        </li>
                      ))}
                    </ul>
                  )}
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
