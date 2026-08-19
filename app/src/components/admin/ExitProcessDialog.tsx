import { useState, type ReactNode } from "react";
import { DoorOpen, TriangleAlert } from "lucide-react";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { InfoCard } from "@/components/dashboard/shared";
import { useApi } from "@/hooks/useApi";
import { ApiError } from "@/lib/api/client";
import type { ExitCandidate, ExitKind, ExitPreviewResponse, ExitConfirmResponse } from "@/lib/api/types";

const KIND_LABEL: Record<ExitKind, string> = {
  forced: "강제 퇴실자",
  settle: "정산 퇴실자",
  deposit_again: "예치금 재납자",
};

export function ExitProcessDialog({
  candidate,
  onConfirmed,
  children,
}: {
  candidate: ExitCandidate;
  onConfirmed?: () => void;
  children: ReactNode;
}) {
  const { call } = useApi();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ExitKind>(candidate.suggestedKind);
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
        body: { number: candidate.number, kind, forcedReason: kind === "forced" ? forcedReason : undefined },
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
        body: { number: candidate.number, kind, forcedReason: kind === "forced" ? forcedReason : undefined },
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
          setKind(candidate.suggestedKind);
        }
      }}
    >
      <DialogTrigger className="w-full rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
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
                <Select value={kind} onValueChange={(v) => v && resetForNewKind(v as ExitKind)}>
                  <SelectTrigger className="bg-card sm:h-12 sm:text-base">
                    <SelectValue>{KIND_LABEL[kind]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="forced" className="sm:text-base">
                      {KIND_LABEL.forced}
                    </SelectItem>
                    <SelectItem value="settle" className="sm:text-base">
                      {KIND_LABEL.settle}
                    </SelectItem>
                    <SelectItem value="deposit_again" className="sm:text-base">
                      {KIND_LABEL.deposit_again}
                    </SelectItem>
                  </SelectContent>
                </Select>

                {kind === "forced" && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="forced-reason" className="text-xs font-medium text-muted-foreground sm:text-sm">
                      기타 직권 사유 (해당 없으면 비워두세요)
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

                {candidate.reasons.length > 0 && (
                  <p className="text-xs text-muted-foreground sm:text-sm">
                    자동 감지된 사유: {candidate.reasons.join(", ")}
                  </p>
                )}
              </InfoCard>

              <Button variant="outline" className="w-full sm:h-12 sm:text-base" disabled={previewing} onClick={handlePreview}>
                {previewing ? "계산 중..." : "미리보기 계산"}
              </Button>

              {preview && (
                <InfoCard className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold sm:text-sm">{preview.kindStr} 처리 결과</span>
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
