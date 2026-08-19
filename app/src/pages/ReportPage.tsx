import { useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useRosterPolling } from "@/hooks/useRosterPolling";
import { useApi } from "@/hooks/useApi";
import { ApiError } from "@/lib/api/client";
import { RefreshCw } from "lucide-react";
import type { ReportStatusResponse } from "@/lib/api/types";

const REPORT_STATUS_POLL_MS = 15000;

const REASON_OPTIONS = [
  { value: "모호한 송출", label: "모호한 송출" },
  { value: "근거리 송출", label: "근거리 송출" },
];

type ReportMode = "screenshot" | "video";

export function ReportPage() {
  const { call } = useApi();
  const { members, hint, refresh } = useRosterPolling();
  const [nickname, setNickname] = useState("");
  const [reason, setReason] = useState("");
  const [submittingMode, setSubmittingMode] = useState<ReportMode | null>(null);
  const [message, setMessage] = useState<{ text: string; type: "error" | "ok" } | null>(null);

  // 방금 제출한 제보의 캡처 진행 상황을 확인하기 위한 폴링 대상.
  // 새 제보를 제출하면 이 값이 바뀌면서 이전 폴링을 정리하고 새로 시작한다.
  const [trackedNickname, setTrackedNickname] = useState<string | null>(null);
  const [trackedMode, setTrackedMode] = useState<ReportMode | null>(null);
  const [reportStatus, setReportStatus] = useState<ReportStatusResponse | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const noMembers = members.length === 0;
  const submitting = submittingMode !== null;

  async function handleSubmit(mode: ReportMode) {
    if (!nickname) {
      setMessage({ text: "대상 참여자를 선택해주세요.", type: "error" });
      return;
    }
    if (!reason) {
      setMessage({ text: "상황 설명을 선택해주세요.", type: "error" });
      return;
    }
    setSubmittingMode(mode);
    setMessage(null);
    try {
      await call("/report", {
        method: "POST",
        body: { nickname, reason, mode },
        tokenInBody: true,
      });
      setMessage({
        text:
          mode === "video"
            ? "영상 제보가 접수되었습니다. 90초 녹화 후 전송됩니다."
            : "제보가 접수되었습니다. 잠시 후 확인됩니다.",
        type: "ok",
      });
      setTrackedNickname(nickname);
      setTrackedMode(mode);
      setReportStatus(null);
      setNickname("");
      setReason("");
    } catch (err) {
      const text = err instanceof ApiError ? err.message : "네트워크 오류입니다.";
      setMessage({ text, type: "error" });
    } finally {
      setSubmittingMode(null);
    }
  }

  useEffect(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (!trackedNickname) return;

    function loadStatus() {
      call<ReportStatusResponse>(`/report-status?nickname=${encodeURIComponent(trackedNickname!)}`)
        .then((data) => setReportStatus(data))
        .catch(() => {});
    }

    loadStatus();
    pollTimerRef.current = setInterval(loadStatus, REPORT_STATUS_POLL_MS);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackedNickname]);

  return (
    <Card className="w-full page-content">
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label className="text-sm font-semibold sm:text-base">대상 참여자</Label>
          <span className="text-xs text-muted-foreground sm:text-sm">{hint}</span>
          <div className="flex items-center gap-2">
            <Select value={nickname} onValueChange={(v) => setNickname(v ?? "")} disabled={noMembers}>
              <SelectTrigger className="flex-1 data-[size=default]:h-8 sm:data-[size=default]:h-12 sm:text-base">
                <SelectValue
                  placeholder={noMembers ? "현재 접속 중인 참여자가 없습니다" : "참여자를 선택하세요"}
                />
              </SelectTrigger>
              <SelectContent>
                {members.map((name) => (
                  <SelectItem key={name} value={name} className="sm:text-base">
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-11 shrink-0 sm:size-12"
              onClick={refresh}
              aria-label="명단 새로고침"
            >
              <RefreshCw className="size-4 sm:size-5" />
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reason" className="text-sm font-semibold sm:text-base">
            상황 설명
          </Label>
          <span className="text-xs text-muted-foreground sm:text-sm">해당하는 상황을 선택해주세요</span>
          <Select value={reason} onValueChange={(v) => setReason(v ?? "")}>
            <SelectTrigger id="reason" className="data-[size=default]:h-8 sm:data-[size=default]:h-12 sm:text-base">
              <SelectValue placeholder="상황을 선택하세요" />
            </SelectTrigger>
            <SelectContent>
              {REASON_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="sm:text-base">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button
            className="w-full sm:h-12 sm:text-base"
            disabled={submitting}
            onClick={() => handleSubmit("screenshot")}
          >
            스크린샷 제보
          </Button>
          <Button
            className="w-full sm:h-12 sm:text-base"
            variant="secondary"
            disabled={submitting}
            onClick={() => handleSubmit("video")}
          >
            영상 제보
          </Button>
        </div>

        {message && (
          <Alert variant={message.type === "error" ? "destructive" : "default"}>
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}

        {trackedNickname && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-sm font-semibold sm:text-base">
                [{trackedNickname}] {trackedMode === "video" ? "영상" : "스크린샷"} 처리 현황
              </Label>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className={`size-2.5 shrink-0 rounded-full ${
                    reportStatus?.inProgress ? "bg-ok" : "bg-muted-foreground/40"
                  }`}
                />
                <span className="text-xs text-muted-foreground sm:text-sm">
                  {reportStatus?.inProgress ? "캡처 진행 중" : "대기 중 또는 완료"}
                </span>
              </span>
            </div>
            {reportStatus?.recentLogs && reportStatus.recentLogs.length > 0 && (
              <pre className="max-h-48 overflow-y-auto rounded-lg border border-border bg-muted p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {reportStatus.recentLogs.join("\n")}
              </pre>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
