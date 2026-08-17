import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { InfoCard } from "@/components/dashboard/shared";
import { useApi } from "@/hooks/useApi";
import { ApiError } from "@/lib/api/client";
import type { ReactNode } from "react";
import type { GoalScheduleResponse } from "@/lib/api/types";

export function GoalTypeScheduleDialog({
  currentGoalType,
  children,
}: {
  currentGoalType: string;
  children: ReactNode;
}) {
  const { call } = useApi();
  const [open, setOpen] = useState(false);

  const [validValues, setValidValues] = useState<string[]>([]);
  const [scheduled, setScheduled] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "error" | "ok" } | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setLoadError(null);
    setMessage(null);
    call<GoalScheduleResponse>("/goal-schedule")
      .then((data) => {
        setValidValues(data.validValues || []);
        setScheduled(data.scheduled);
        setSelected(data.scheduled || data.validValues?.[0] || "");
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "예약 정보를 불러오지 못했습니다."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function handleSubmit() {
    if (!selected) return;
    setSubmitting(true);
    setMessage(null);
    try {
      await call("/goal-schedule", { method: "POST", body: { goalType: selected } });
      setScheduled(selected);
      setMessage({ text: "다음 주 월요일부터 적용되도록 예약되었습니다.", type: "ok" });
    } catch (err) {
      const text = err instanceof ApiError ? err.message : "네트워크 오류입니다.";
      setMessage({ text, type: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="w-full rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        {children}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Clock className="size-4 text-primary sm:size-5" />
            목표시간 변경 예약
          </DialogTitle>
          <DialogDescription>다음 주 월요일부터 적용할 목표시간을 미리 설정할 수 있습니다.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <InfoCard className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold sm:text-base">이번 주 목표시간</span>
            <span className="font-mono text-sm font-bold text-muted-foreground sm:text-base">
              {currentGoalType}
            </span>
          </InfoCard>
          <p className="text-micro-lg text-muted-foreground/70">
            규정상 이번 주 값은 변경할 수 없습니다. 지금 예약하면 다음 주 월요일에 자동 반영됩니다.
          </p>

          {loading && <p className="text-center font-mono text-xs text-muted-foreground sm:text-sm">불러오는 중...</p>}
          {loadError && (
            <Alert variant="destructive">
              <AlertDescription>{loadError}</AlertDescription>
            </Alert>
          )}

          {!loading && !loadError && (
            <>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-semibold sm:text-base">다음 주 예약</span>
                {scheduled && (
                  <span className="text-xs text-muted-foreground sm:text-sm">
                    현재 예약됨: <span className="font-mono font-semibold">{scheduled}</span>
                  </span>
                )}
                <Select value={selected} onValueChange={(v) => setSelected(v ?? "")}>
                  <SelectTrigger className="sm:h-12 sm:text-base">
                    <SelectValue>{selected}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {validValues.map((v) => (
                      <SelectItem key={v} value={v} className="sm:text-base">
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Button className="w-full sm:h-12 sm:text-base" disabled={submitting} onClick={handleSubmit}>
                다음 주 예약 저장
              </Button>
            </>
          )}

          {message && (
            <Alert variant={message.type === "error" ? "destructive" : "default"}>
              <AlertDescription>{message.text}</AlertDescription>
            </Alert>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
