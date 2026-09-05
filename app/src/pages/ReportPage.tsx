import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { SectionHeader, SectionCard } from "@/components/admin/shared";
import { useRosterPolling } from "@/hooks/useRosterPolling";
import { useApi } from "@/hooks/useApi";
import { ApiError } from "@/lib/api/client";
import { Bell, Flag, MessageSquareWarning, TriangleAlert, User } from "lucide-react";
import { InfoCard } from "@/components/dashboard/shared";
import { SimpleNoticeSection } from "@/components/report/SimpleNoticeSection";
import { ActiveReportsSection } from "@/components/report/ActiveReportsSection";

// 제보 페이지에서 참여자들이 놓치기 쉬운 규칙을 모아 보여준다 — 배열이라
// 앞으로 문구가 늘어나도 이 목록에 항목만 추가하면 된다.
const REPORT_CAUTIONS = ["동일 대상자에 대해 20분내로 중복 제보는 불가합니다."];

const REASON_OPTIONS = [
  { value: "모호한 송출", label: "모호한 송출" },
  { value: "근거리 송출", label: "근거리 송출" },
];

type ReportMode = "screenshot" | "video";
type ReportView = "capture" | "notice";

function normalizeView(raw: string | null): ReportView {
  if (raw === "notice") return raw;
  return "capture";
}

export function ReportPage() {
  const { call } = useApi();
  const { members, stale, hint, refresh } = useRosterPolling();
  const [nickname, setNickname] = useState("");
  const [reason, setReason] = useState("");
  const [submittingMode, setSubmittingMode] = useState<ReportMode | null>(null);
  const [message, setMessage] = useState<{ text: string; type: "error" | "ok" } | null>(null);
  const [cooldownRefreshSignal, setCooldownRefreshSignal] = useState(0);

  const [params, setParams] = useSearchParams();
  // AdminPage와 동일한 이유 — 최초 마운트 시 한 번만 URL에서 초기 탭을 읽고,
  // 이후로는 로컬 state로만 관리한다(하단 탭바로 다른 페이지에 갔다가 돌아와도
  // 마지막에 보던 탭이 쿼리 초기화로 조용히 리셋되지 않게).
  const [view, setView] = useState<ReportView>(() => normalizeView(params.get("tab")));
  const everOpened = useRef({ capture: false, notice: false });
  everOpened.current[view] = true;

  function changeView(v: string) {
    const next = normalizeView(v);
    setView(next);
    setParams(next === "capture" ? {} : { tab: next }, { replace: true });
  }

  const noMembers = members.length === 0;
  const submitting = submittingMode !== null;

  async function handleSubmit(mode: ReportMode) {
    if (!nickname) {
      setMessage({ text: "제보 대상자를 선택해주세요.", type: "error" });
      return;
    }
    if (!reason) {
      setMessage({ text: "제보 원인을 선택해주세요.", type: "error" });
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
      setNickname("");
      setReason("");
      setCooldownRefreshSignal((n) => n + 1);
    } catch (err) {
      const text = err instanceof ApiError ? err.message : "네트워크 오류입니다.";
      setMessage({ text, type: "error" });
    } finally {
      setSubmittingMode(null);
    }
  }

  return (
    <div className="flex w-full page-content flex-col gap-4">
      <Tabs value={view} onValueChange={changeView} className="w-full">
        <TabsList className="w-full">
          <TabsTrigger value="capture" className="flex-1 font-mono text-xs tracking-wide uppercase">
            송출 P 제보
          </TabsTrigger>
          <TabsTrigger value="notice" className="flex-1 font-mono text-xs tracking-wide uppercase">
            PUSH 알림 전송
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="w-full" hidden={view !== "capture"}>
        {everOpened.current.capture && (
          <Card className="w-full">
            <CardContent>
              <Collapsible defaultOpen className="flex flex-col gap-4">
                <SectionHeader icon={Flag} title="송출 P 제보" onRefresh={refresh} />
                <CollapsiblePanel className="flex flex-col gap-4">
                  <div className="h-px w-full bg-border" />
                  <SectionCard className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1.5">
                      <Label className="flex items-center gap-1.25 text-xs font-semibold text-muted-foreground sm:text-sm">
                        <User className="size-3 shrink-0 sm:size-3.5" />
                        제보 대상자
                      </Label>
                      <Select
                        value={nickname}
                        onValueChange={(v) => setNickname(v ?? "")}
                        disabled={stale || noMembers}
                        onOpenChange={(open) => {
                          if (open) refresh();
                        }}
                      >
                        <SelectTrigger className="w-full data-[size=default]:h-8 sm:data-[size=default]:h-12 sm:text-base">
                          <SelectValue
                            placeholder={
                              stale
                                ? "도움봇이 가동중이지 않습니다."
                                : noMembers
                                  ? // 🔧 [로딩 실패가 "0명"으로 오인되던 문제 수정] hint는
                                    // useRosterPolling이 로딩 중/실패 시 채워두는 값이다 —
                                    // 원래 이걸 안 써서 /participants 조회가 실패해도 항상
                                    // "접속 중인 참여자가 없습니다"로만 보였다.
                                    hint || "현재 접속 중인 참여자가 없습니다"
                                  : "참여자를 선택하세요"
                            }
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
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="reason" className="flex items-center gap-1.25 text-xs font-semibold text-muted-foreground sm:text-sm">
                        <MessageSquareWarning className="size-3 shrink-0 sm:size-3.5" />
                        제보 원인
                      </Label>
                      <Select value={reason} onValueChange={(v) => setReason(v ?? "")} disabled={stale}>
                        <SelectTrigger
                          id="reason"
                          className="w-full data-[size=default]:h-8 sm:data-[size=default]:h-12 sm:text-base"
                        >
                          <SelectValue placeholder="원인을 선택해 주세요." />
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
                        variant="outline"
                        disabled={submitting || stale}
                        onClick={() => handleSubmit("screenshot")}
                      >
                        스크린샷 제보
                      </Button>
                      <Button
                        className="w-full sm:h-12 sm:text-base"
                        variant="outline"
                        disabled={submitting || stale}
                        onClick={() => handleSubmit("video")}
                      >
                        영상 제보
                      </Button>
                    </div>
                  </SectionCard>

                  <ActiveReportsSection refreshSignal={cooldownRefreshSignal} />

                  <InfoCard className="flex flex-col gap-1 border-amber-600/30 bg-amber-600/5 dark:border-amber-400/30 dark:bg-amber-400/5">
                    <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                      <TriangleAlert className="size-3.5 shrink-0 sm:size-4" />
                      <span className="text-xs font-semibold sm:text-sm">주의사항</span>
                    </div>
                    <ul className="flex flex-col gap-0.5">
                      {REPORT_CAUTIONS.map((text) => (
                        <li
                          key={text}
                          className="text-micro-lg leading-relaxed text-muted-foreground before:mr-1 before:content-['·'] sm:text-xs"
                        >
                          {text}
                        </li>
                      ))}
                    </ul>
                  </InfoCard>

                  {message && (
                    <Alert variant={message.type === "error" ? "destructive" : "success"}>
                      <AlertDescription>{message.text}</AlertDescription>
                    </Alert>
                  )}
                </CollapsiblePanel>
              </Collapsible>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="w-full" hidden={view !== "notice"}>
        {everOpened.current.notice && (
          <Card className="w-full">
            <CardContent>
              <Collapsible defaultOpen className="flex flex-col gap-4">
                <SectionHeader icon={Bell} title="PUSH 알림" onRefresh={refresh} />
                <CollapsiblePanel className="flex flex-col gap-4">
                  <div className="h-px w-full bg-border" />
                  <SimpleNoticeSection members={members} noMembers={noMembers} stale={stale} />
                </CollapsiblePanel>
              </Collapsible>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
