import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { SectionHeader, SectionCard } from "@/components/admin/shared";
import { useRosterPolling } from "@/hooks/useRosterPolling";
import { usePullRefreshListener } from "@/hooks/usePullToRefresh";
import { useApi } from "@/hooks/useApi";
import { useAuth } from "@/lib/auth/useAuth";
import { ApiError } from "@/lib/api/client";
import { Bell, Flag, Lightbulb, MessageSquareWarning, TriangleAlert, User } from "lucide-react";
import { InfoCard } from "@/components/dashboard/shared";
import { SimpleNoticeSection } from "@/components/report/SimpleNoticeSection";
import { ActiveReportsSection } from "@/components/report/ActiveReportsSection";
import { MyOutputPenSection } from "@/components/report/MyOutputPenSection";
import type { StatusMessageResponse } from "@/lib/api/types";
import { cn } from "@/lib/utils";

// 제보 페이지에서 참여자들이 놓치기 쉬운 규칙을 모아 보여준다 — 배열이라
// 앞으로 문구가 늘어나도 이 목록에 항목만 추가하면 된다.
const REPORT_CAUTIONS = ["동일 대상자에 대해 20분내로 중복 제보는 불가합니다."];

const REASON_OPTIONS = [
  { value: "격자 기준을 벗어난 근접 화각", label: "격자 기준을 벗어난 근접 화각" },
  { value: "손 또는 학습자료 확인 불가", label: "손 또는 학습자료 확인 불가" },
  { value: "전자기기 사용목적 확인 불가", label: "전자기기 사용목적 확인 불가" },
  { value: "얼굴, 정수리 등 노출", label: "얼굴, 정수리 등 노출" },
  { value: "과도한 스티커 사용", label: "과도한 스티커 사용" },
  { value: "기타", label: "기타 (직접 기재)" },
] as const;
const REASON_OTHER_VALUE = "기타";
const REASON_OTHER_MAX_LENGTH = 100;

// 봇이 매 교시 "시작" 시각마다 스터디룸 페이지를 강제 새로고침한다
// (study_sw/bot/scheduling.py의 schedule_process — 메모리 확보 목적). 이
// 새로고침이 진행되는 동안 촬영이 시작되면 끊기므로, 다음 교시 시작 직전
// 구간에는 접수 자체를 막는다(사용자 지시). 종료 시점에는 새로고침이
// 일어나지 않으므로 별도 제한이 필요 없다. study_sw/assets/timetable.csv와
// 동일한 시작 시각 목록 — 그 파일이 바뀌면 이 배열도 함께 갱신해야 한다.
const PERIOD_START_TIMES = [
  "07:20",
  "08:30",
  "09:40",
  "10:50",
  "12:00",
  "13:10",
  "14:20",
  "15:30",
  "16:40",
  "17:50",
  "19:00",
  "20:10",
  "21:20",
  "22:30",
];
// 스크린샷은 30초 간격 6장(3분), 영상은 90초 — 촬영 시간만큼 여유를 두고
// "다음 교시 시작까지 촬영 시간 이내로 남았으면" 접수를 막아야 새로고침에
// 걸리지 않고 끝까지 찍을 수 있다.
const SCREENSHOT_LEAD_SEC = 3 * 60;
const VIDEO_LEAD_SEC = 90;

// 현재 시각(KST) 기준, 다음으로 다가올 교시 시작까지 남은 초를 계산한다.
// 자정을 넘어가는 마지막 교시(14교시 22:30) 이후에는 다음 날 1교시(07:20)까지의
// 간격을 본다.
function secondsUntilNextPeriodStart(now: Date): number {
  const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const startMinutes = PERIOD_START_TIMES.map((t) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  });
  const upcoming = startMinutes.find((m) => m > nowMin);
  const targetMin = upcoming !== undefined ? upcoming : startMinutes[0] + 24 * 60;
  return Math.round((targetMin - nowMin) * 60);
}

function isWithinReconnectWindow(leadSec: number): boolean {
  return secondsUntilNextPeriodStart(new Date()) <= leadSec;
}

type ReportMode = "screenshot" | "video";
type ReportView = "capture" | "notice";

function normalizeView(raw: string | null): ReportView {
  if (raw === "notice") return raw;
  return "capture";
}

export function ReportPage({ visible = true }: { visible?: boolean }) {
  const { call } = useApi();
  const { isAdmin, session } = useAuth();
  const { members: allMembers, stale, hint, refresh } = useRosterPolling();
  // "내 화각 점검" 기능이 따로 있으므로 일반 회원에게는 제보 대상자
  // 드롭다운에서 본인을 아예 안 보여준다(사용자 결정) — 관리자는 기능
  // 테스트를 위해 계속 자기 자신도 선택할 수 있어야 하므로 예외로 둔다.
  const members = isAdmin ? allMembers : allMembers.filter((name) => name !== session?.name);
  usePullRefreshListener(true, refresh);
  const [nickname, setNickname] = useState("");
  const [reason, setReason] = useState("");
  // "기타" 선택 시 제보 원인을 직접 입력받는 값 — 제출 시 reason 자체를
  // 이 텍스트로 대체해서 보낸다(백엔드는 reason을 자유 문자열로만 다뤄
  // 별도 처리가 필요 없다).
  const [otherReason, setOtherReason] = useState("");
  // 🔧 [상태 메시지] 대상자를 고르면 그 사람이 [설정]에 등록해둔 상태
  // 메시지(예: "태블릿 : AI 질의용도")를 보여줘 오해로 인한 제보를 줄인다
  // (사용자 요청). null=아직 조회 전, ""=조회했지만 등록된 메시지 없음.
  const [targetStatusMessage, setTargetStatusMessage] = useState<string | null>(null);
  const [submittingMode, setSubmittingMode] = useState<ReportMode | null>(null);
  const [submittingSelfCheck, setSubmittingSelfCheck] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "error" | "ok" } | null>(null);
  const [cooldownRefreshSignal, setCooldownRefreshSignal] = useState(0);
  // "내 화각 점검"이 새 기록을 남기면 [내 송출 P 제보 확인]이 새로고침
  // 없이도 바로 보이도록 신호만 넘긴다(ActiveReportsSection의 refreshSignal과 동일 패턴).
  const [myCapturesRefreshSignal, setMyCapturesRefreshSignal] = useState(0);
  // 다음 교시 시작까지 남은 시간이 흘러 접수 가능/불가 경계를 넘는 순간을
  // 반영하려고 20초 간격으로만 다시 렌더링한다(초 단위 카운트다운을 보여줄
  // 필요는 없어 너무 잦은 리렌더는 피한다).
  const [, setReconnectTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setReconnectTick((n) => n + 1), 20_000);
    return () => clearInterval(timer);
  }, []);

  // 🔧 [버그 수정] useRosterPolling이 15초마다 참여자 명단을 새로 받아오는데,
  // 사용자가 대상자를 고른 뒤(또는 드롭다운을 열어 고민하는 사이) 그 사람이
  // 스터디룸에서 퇴장하면 다음 폴링에서 members 배열에서 사라진다 — 하지만
  // nickname state는 그대로 남아 있어, Select 트리거가 더 이상 목록에 없는
  // 값을 표시하려다 빈 것처럼 보이거나 이전 라벨에 고정된 채로 어긋났다.
  // 제출 시 서버(handleReport)가 재검증해 400으로 막아 데이터 정합성은
  // 지켜지지만, 사용자 입장에서는 "방금 고른 사람이 왜 안 되지"라는 혼란만
  // 남았다. members가 갱신될 때마다 현재 선택값이 여전히 유효한지 확인해,
  // 아니면 즉시 초기화해 드롭다운이 "다시 선택해주세요" 상태로 명확히
  // 돌아가게 한다.
  useEffect(() => {
    if (nickname && !members.includes(nickname)) {
      setNickname("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members]);

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

  useEffect(() => {
    if (!nickname) {
      setTargetStatusMessage(null);
      return;
    }
    let cancelled = false;
    setTargetStatusMessage(null);
    call<StatusMessageResponse>("/member-status-message?nickname=" + encodeURIComponent(nickname))
      .then((data) => {
        if (!cancelled) setTargetStatusMessage(data.message || "");
      })
      .catch(() => {
        if (!cancelled) setTargetStatusMessage("");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nickname]);

  async function handleSubmit(mode: ReportMode) {
    if (!nickname) {
      setMessage({ text: "제보 대상자를 선택해주세요.", type: "error" });
      return;
    }
    if (!reason) {
      setMessage({ text: "제보 원인을 선택해주세요.", type: "error" });
      return;
    }
    const isOther = reason === REASON_OTHER_VALUE;
    if (isOther && !otherReason.trim()) {
      setMessage({ text: "제보 원인을 입력해주세요.", type: "error" });
      return;
    }
    // 다음 교시 시작 직전에는 봇이 스터디룸을 새로고침해 촬영이 끊기므로
    // 접수를 막는다(사용자 지시) — 버튼도 비활성화되지만, 그 사이 시간이
    // 흘러 조건을 넘겼을 수 있어 제출 시점에도 다시 확인한다.
    const leadSec = mode === "video" ? VIDEO_LEAD_SEC : SCREENSHOT_LEAD_SEC;
    if (isWithinReconnectWindow(leadSec)) {
      setMessage({ text: "다음 교시 시작이 임박해 촬영이 끊길 수 있어 잠시 후 다시 시도해주세요.", type: "error" });
      return;
    }
    const finalReason = isOther ? otherReason.trim() : reason;
    setSubmittingMode(mode);
    setMessage(null);
    try {
      await call("/report", {
        method: "POST",
        body: { nickname, reason: finalReason, mode },
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
      setOtherReason("");
      setCooldownRefreshSignal((n) => n + 1);
    } catch (err) {
      const text = err instanceof ApiError ? err.message : "네트워크 오류입니다.";
      setMessage({ text, type: "error" });
    } finally {
      setSubmittingMode(null);
    }
  }

  // "내 화각 점검" — 스크린샷 제보와 동일한 캡처 메커니즘이지만 대상자·원인을
  // 고르지 않는다(대상자는 항상 본인, 원인은 서버가 고정 문구로 채움). 결과는
  // [송출 P 대상 처리]에 노출되지 않고 [내 송출 P 제보 확인]에서만 확인 가능.
  async function handleSelfCheck() {
    if (isWithinReconnectWindow(SCREENSHOT_LEAD_SEC)) {
      setMessage({ text: "다음 교시 시작이 임박해 촬영이 끊길 수 있어 잠시 후 다시 시도해주세요.", type: "error" });
      return;
    }
    setSubmittingSelfCheck(true);
    setMessage(null);
    try {
      await call("/report", {
        method: "POST",
        body: { selfCheck: true },
        tokenInBody: true,
      });
      setMessage({ text: "내 화각 점검이 접수되었습니다. 잠시 후 확인됩니다.", type: "ok" });
      setMyCapturesRefreshSignal((n) => n + 1);
    } catch (err) {
      const text = err instanceof ApiError ? err.message : "네트워크 오류입니다.";
      setMessage({ text, type: "error" });
    } finally {
      setSubmittingSelfCheck(false);
    }
  }

  return (
    <div className="flex w-full page-content flex-col gap-4">
      <Tabs value={view} onValueChange={changeView} className="w-full">
        <TabsList className="w-full">
          <TabsTrigger value="capture" className="flex-1 font-mono text-xs tracking-wide uppercase">
            화각 불량 제보
          </TabsTrigger>
          <TabsTrigger value="notice" className="flex-1 font-mono text-xs tracking-wide uppercase">
            PUSH 알림 전송
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="flex w-full flex-col gap-4" hidden={view !== "capture"}>
        {everOpened.current.capture && (
          <>
            <Card className="w-full">
              <CardContent>
                <Collapsible defaultOpen className="flex flex-col gap-4">
                  <SectionHeader icon={Flag} title="화각 불량 제보" onRefresh={refresh} />
                  <CollapsiblePanel className="flex flex-col gap-4">
                    <div className="h-px w-full bg-border" />
                    <SectionCard className="flex flex-col gap-3">
                      <div className="flex flex-col gap-1.5">
                        <Label className="flex items-center gap-1.25 text-sm font-bold sm:text-base">
                          <User className="size-3 shrink-0 text-muted-foreground sm:size-3.5" />
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
                          <SelectTrigger className="w-full data-[size=default]:h-8 sm:data-[size=default]:h-12 pl-3.5 sm:pl-4.5 sm:text-base">
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
                        <Label className="flex items-center gap-1.25 text-sm font-bold sm:text-base">
                          <Lightbulb className="size-3 shrink-0 text-muted-foreground sm:size-3.5" />
                          상태 메시지
                        </Label>
                        <InfoCard className="flex h-8 items-center bg-card py-0 sm:h-12">
                          <span
                            className={cn(
                              "truncate text-sm sm:text-base",
                              targetStatusMessage ? "text-foreground" : "text-muted-foreground"
                            )}
                          >
                            {!nickname
                              ? "제보 대상자를 먼저 선택해주세요."
                              : targetStatusMessage === null
                                ? "불러오는 중..."
                                : targetStatusMessage || "작성된 내용이 없습니다."}
                          </span>
                        </InfoCard>
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="reason" className="flex items-center gap-1.25 text-sm font-bold sm:text-base">
                          <MessageSquareWarning className="size-3 shrink-0 text-muted-foreground sm:size-3.5" />
                          제보 원인
                        </Label>
                        <Select value={reason} onValueChange={(v) => setReason(v ?? "")} disabled={stale}>
                          <SelectTrigger
                            id="reason"
                            className="w-full data-[size=default]:h-8 sm:data-[size=default]:h-12 pl-3.5 sm:pl-4.5 sm:text-base"
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
                        {reason === REASON_OTHER_VALUE && (
                          <Input
                            value={otherReason}
                            maxLength={REASON_OTHER_MAX_LENGTH}
                            placeholder="제보 원인을 입력해 주세요."
                            disabled={stale}
                            onChange={(e) => setOtherReason(e.target.value)}
                            className="w-full pl-3.5 text-sm sm:h-12 sm:pl-4.5 sm:text-base md:text-base"
                          />
                        )}
                      </div>

                      <div className="grid grid-cols-3 gap-2">
                        <Button
                          className="w-full sm:h-12 sm:text-base"
                          variant="outline"
                          disabled={submitting || stale || isWithinReconnectWindow(SCREENSHOT_LEAD_SEC)}
                          onClick={() => handleSubmit("screenshot")}
                        >
                          스크린샷 제보
                        </Button>
                        <Button
                          className="w-full sm:h-12 sm:text-base"
                          variant="outline"
                          disabled={submitting || stale || isWithinReconnectWindow(VIDEO_LEAD_SEC)}
                          onClick={() => handleSubmit("video")}
                        >
                          영상 제보
                        </Button>
                        <Button
                          className="w-full sm:h-12 sm:text-base"
                          variant="outline"
                          disabled={submittingSelfCheck || stale || isWithinReconnectWindow(SCREENSHOT_LEAD_SEC)}
                          onClick={handleSelfCheck}
                        >
                          내 화각 점검
                        </Button>
                      </div>
                      {isWithinReconnectWindow(SCREENSHOT_LEAD_SEC) && (
                        <p className="text-center text-micro-lg text-muted-foreground sm:text-xs">
                          다음 교시 시작이 임박해 잠시 후 다시 접수할 수 있습니다.
                        </p>
                      )}
                    </SectionCard>

                    <ActiveReportsSection refreshSignal={cooldownRefreshSignal} />

                    <InfoCard className="flex flex-col gap-1 border-amber-600/30 bg-amber-600/5 dark:border-amber-400/30 dark:bg-amber-400/5">
                      <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                        <TriangleAlert className="size-3.5 shrink-0 sm:size-4" />
                        <span className="text-sm font-bold sm:text-base">주의사항</span>
                      </div>
                      <ul className="flex flex-col gap-0.5">
                        {REPORT_CAUTIONS.map((text) => (
                          <li
                            key={text}
                            className="text-xs leading-relaxed text-muted-foreground before:mr-1 before:content-['·'] sm:text-sm"
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

            <MyOutputPenSection refreshSignal={myCapturesRefreshSignal} visible={visible} />
          </>
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
