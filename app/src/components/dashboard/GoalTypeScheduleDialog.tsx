import { useEffect, useState } from "react";
import { CalendarClock, SquarePen, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { InfoCard, ItemTitle } from "@/components/dashboard/shared";
import { useApi } from "@/hooks/useApi";
import { ApiError } from "@/lib/api/client";
import type { ReactNode } from "react";
import type { GoalScheduleResponse } from "@/lib/api/types";

// 시트 원본 값("8H (교시제)")의 괄호를 지워 드롭다운에 그대로 노출하지 않는다.
function formatGoalType(raw: string): string {
  return raw.replace(/[()]/g, "").replace(/\s+/g, " ").trim();
}

export function GoalTypeScheduleDialog({
  onScheduled,
  children,
}: {
  onScheduled?: (goalType: string) => void;
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
      onScheduled?.(selected);
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
            <SquarePen className="size-4 text-primary sm:size-5" />
            목표시간 · 변경 예약
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {loading && (
            // 🔧 2026-09: 다이얼로그가 열리자마자 fetch를 시작해, 텍스트 한
            // 줄 → InfoCard 전체(제목+예약 안내+select+주의문구)로 다이얼로그
            // 높이가 갑자기 늘어났다(사용자 지적) — 실제 카드와 비슷한 크기의
            // 펄스 스켈레톤으로 미리 그 자리를 잡는다.
            <InfoCard className="flex animate-pulse flex-col gap-1.5" aria-hidden>
              <span className="h-3.5 w-32 rounded bg-muted sm:h-4 sm:w-40" />
              <span className="h-3 w-44 rounded bg-muted sm:h-3.5 sm:w-52" />
              <span className="h-8 w-full rounded-md bg-muted sm:h-12" />
            </InfoCard>
          )}
          {loadError && (
            <Alert variant="destructive">
              <AlertDescription>{loadError}</AlertDescription>
            </Alert>
          )}

          {!loading && !loadError && (
            <>
              <InfoCard className="flex flex-col gap-1.5">
                <span className="flex items-center gap-1.5">
                  <CalendarClock className="size-3.5 shrink-0 text-muted-foreground sm:size-4" />
                  <ItemTitle>다음 주 목표시간</ItemTitle>
                </span>
                {scheduled && (
                  <span className="text-xs text-muted-foreground sm:text-sm">
                    현재 예약됨: <span className="font-mono font-semibold">{formatGoalType(scheduled)}</span>
                  </span>
                )}
                <div className="flex items-center gap-1.5">
                  <span className="shrink-0 text-muted-foreground">└</span>
                  <div className="min-w-0 flex-1">
                    <Select value={selected} onValueChange={(v) => setSelected(v ?? "")}>
                      <SelectTrigger className="bg-card text-xs data-[size=default]:h-8 sm:data-[size=default]:h-12 sm:text-sm">
                        <SelectValue>{selected && formatGoalType(selected)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {validValues.map((v) => (
                          <SelectItem key={v} value={v} className="text-xs sm:text-sm">
                            {formatGoalType(v)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <span className="pl-5 text-micro text-amber-600 sm:pl-5.5 sm:text-micro-lg dark:text-amber-400">
                  * 변경하지 않으면 기존 설정 값이 계속 유지됩니다.
                </span>
              </InfoCard>

              <InfoCard className="flex flex-col gap-1 border-destructive/30 bg-destructive/5">
                <div className="flex items-center gap-1.5 text-destructive">
                  <TriangleAlert className="size-3.5 shrink-0 sm:size-4" />
                  <ItemTitle className="text-destructive">주의사항</ItemTitle>
                </div>
                <ul className="flex flex-col gap-1 text-micro-lg leading-relaxed text-muted-foreground sm:text-xs">
                  <li className="flex gap-1.5">
                    <span className="text-destructive/60">•</span>
                    현재 진행 주간의 목표시간은 중도 변경이 불가합니다.
                  </li>
                  <li className="flex gap-1.5">
                    <span className="text-destructive/60">•</span>
                    위 설정 값은 다음 주 월요일부터 적용됩니다.
                  </li>
                </ul>
              </InfoCard>

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
