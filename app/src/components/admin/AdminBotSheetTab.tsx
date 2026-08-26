import { useEffect, useState } from "react";
import { ArrowRightLeft, Bot, Gauge, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { InfoCard } from "@/components/dashboard/shared";
import { SectionHeader, SectionCard, ItemTitle, FieldLabel, FieldValue } from "@/components/admin/shared";
import { useApi } from "@/hooks/useApi";
import { ApiError } from "@/lib/api/client";
import { cn, ICON_STROKE } from "@/lib/utils";
import type {
  AdminUsageResponse,
  BotStatusResponse,
  BotCommandResponse,
  MemberReorderPlanItem,
  MemberReorderPreviewResponse,
  MemberReorderResponse,
} from "@/lib/api/types";

// 도움봇(study_manager_260418.py)은 로컬 PC에서 상시 실행되는 Selenium
// 프로세스라, Cloudflare Tunnel로 노출한 로컬 상태 서버를 Worker가 요청
// 시점에 즉시 프록시하는 방식으로 연결된다(폴링 없음). 관리자가 할 수
// 있는 원격 명령은 "재시작"뿐이다 — 봇 쪽 코드가 그렇게 구현되어 있다
// (BOT_STRUCTURE.md 참고).

// 사용률(%)에 따라 색을 3단계로 나눈다 — 70% 미만은 안전(ok), 70~90%는
// 주의(amber), 90% 이상은 위험(destructive)임을 한눈에 알 수 있게 한다.
function usageTone(used: number, limit: number): "ok" | "amber" | "destructive" {
  if (limit <= 0) return "ok";
  const ratio = used / limit;
  if (ratio >= 0.9) return "destructive";
  if (ratio >= 0.7) return "amber";
  return "ok";
}

const TONE_BAR_CLASS: Record<string, string> = {
  ok: "bg-ok",
  amber: "bg-amber-600 dark:bg-amber-400",
  destructive: "bg-destructive",
};
const TONE_TEXT_CLASS: Record<string, string> = {
  ok: "text-ok",
  amber: "text-amber-600 dark:text-amber-400",
  destructive: "text-destructive",
};

function UsageBar({ label, used, limit, unit }: { label: string; used: number; limit: number; unit: string }) {
  const tone = usageTone(used, limit);
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 1000) / 10) : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <FieldLabel>{label}</FieldLabel>
        <FieldValue className={TONE_TEXT_CLASS[tone]}>
          {used.toLocaleString()} / {limit.toLocaleString()} {unit}
        </FieldValue>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
        <div
          className={cn("h-full rounded-full transition-all", TONE_BAR_CLASS[tone])}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// Google Sheets(분당 60회 읽기/쓰기)와 Cloudflare(Workers/KV 무료 티어) 무료
// 할당량 대비 현재 사용량을 한 화면에서 보여준다. Sheets 쪽은 이 Worker
// 자신이 호출할 때마다 인메모리로 센 근사치(콜드스타트 시 리셋)이고,
// Cloudflare 쪽은 CF_API_TOKEN이 등록되어 있을 때만 GraphQL Analytics API로
// 오늘 하루 실측치를 가져온다 — 토큰이 없으면 그 부분만 안내 문구로 대체한다.
function UsageMonitorSection() {
  const { call } = useApi();

  const [usage, setUsage] = useState<AdminUsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    call<AdminUsageResponse>("/admin/usage")
      .then((data) => setUsage(data))
      .catch((err) => setError(err instanceof Error ? err.message : "사용량을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <SectionCard>
      <Collapsible defaultOpen className="flex flex-col gap-4">
        <SectionHeader icon={Gauge} title="사용량 모니터링" loading={loading} onRefresh={load} />
        <div className="h-px w-full bg-border" />
        <CollapsiblePanel className="flex flex-col gap-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {usage && (
            <>
              <InfoCard className="flex flex-col gap-3">
                <ItemTitle>Google Sheets (분당 한도)</ItemTitle>
                <UsageBar
                  label="이번 분 읽기"
                  used={usage.sheets.readsThisMinute}
                  limit={usage.sheets.readLimitPerMinute}
                  unit="회"
                />
                <UsageBar
                  label="이번 분 쓰기"
                  used={usage.sheets.writesThisMinute}
                  limit={usage.sheets.writeLimitPerMinute}
                  unit="회"
                />
                <p className="text-micro-lg text-muted-foreground/70 sm:text-xs">
                  직전 분: 읽기 {usage.sheets.readsLastMinute}회 · 쓰기 {usage.sheets.writesLastMinute}회 —
                  Worker와 도움봇(같은 서비스 계정으로 시트에 접근)의 호출을 합산한 근사치이며, Worker
                  재배포·장시간 유휴 후에는 0부터 다시 셉니다.
                </p>
              </InfoCard>

              <InfoCard className="flex flex-col gap-3">
                <ItemTitle>Cloudflare (오늘 하루 한도)</ItemTitle>
                {usage.cloudflareConfigured && usage.cloudflare ? (
                  <>
                    <UsageBar
                      label="Workers 요청"
                      used={usage.cloudflare.workersRequestsToday}
                      limit={usage.limits.workersRequestsPerDay}
                      unit="회"
                    />
                    <UsageBar
                      label="KV 읽기"
                      used={usage.cloudflare.kvReadsToday}
                      limit={usage.limits.kvReadsPerDay}
                      unit="회"
                    />
                    <UsageBar
                      label="KV 쓰기·삭제"
                      used={usage.cloudflare.kvWritesToday}
                      limit={usage.limits.kvWritesPerDay}
                      unit="회"
                    />
                    {usage.cloudflare.workersErrorsToday > 0 && (
                      <p className="text-micro-lg text-destructive sm:text-xs">
                        오늘 Workers 오류 {usage.cloudflare.workersErrorsToday}건
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground sm:text-sm">
                    Cloudflare API 토큰이 설정되어 있지 않아 실제 사용량을 불러올 수 없습니다. Account Analytics
                    Read 권한의 API 토큰을 발급해 CF_API_TOKEN/CF_ACCOUNT_ID로 등록하면 표시됩니다.
                  </p>
                )}
              </InfoCard>
            </>
          )}
        </CollapsiblePanel>
      </Collapsible>
    </SectionCard>
  );
}

function BotStatusSection() {
  const { call } = useApi();

  const [status, setStatus] = useState<BotStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [restarting, setRestarting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    call<BotStatusResponse>("/admin/bot/status")
      .then((data) => setStatus(data))
      .catch((err) => setError(err instanceof Error ? err.message : "봇 상태를 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function sendRestart() {
    setRestarting(true);
    setError(null);
    setMessage(null);
    try {
      await call<BotCommandResponse>("/admin/bot/command", { method: "POST", body: { command: "restart" } });
      setMessage("재시작 명령을 전송했습니다. 봇이 즉시 브라우저를 재시작합니다.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "명령 전송에 실패했습니다.");
    } finally {
      setRestarting(false);
    }
  }

  const online = status?.online ?? false;
  const roomState = status?.roomState;

  return (
    <SectionCard>
      <Collapsible defaultOpen className="flex flex-col gap-4">
        <SectionHeader icon={Bot} title="도움봇 상태" loading={loading} onRefresh={load} />
        <div className="h-px w-full bg-border" />
        <CollapsiblePanel className="flex flex-col gap-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {message && (
            <Alert>
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          )}

          {status?.screenshot && (
            <img
              src={`data:image/png;base64,${status.screenshot}`}
              alt="도움봇 화면"
              className="w-full rounded-lg border border-border"
            />
          )}

          <InfoCard className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2">
              <FieldLabel>연결 상태</FieldLabel>
              <span className="inline-flex items-center gap-1.5">
                <span className={cn("size-2.5 shrink-0 rounded-full", online ? "bg-ok" : "bg-destructive")} />
                <FieldValue className={online ? "text-ok" : "text-destructive"}>
                  {online ? "온라인" : "오프라인"}
                </FieldValue>
              </span>
            </div>

            <div className="flex items-center justify-between gap-2">
              <FieldLabel>스터디룸 접속</FieldLabel>
              <FieldValue>
                {roomState === "in_room" ? "접속 중" : roomState === "outside" ? "외부" : "-"}
              </FieldValue>
            </div>
          </InfoCard>

          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" disabled={restarting} onClick={sendRestart} className="w-full sm:h-11">
              {restarting ? (
                <RotateCw className="size-4 animate-spin" strokeWidth={ICON_STROKE.default} />
              ) : (
                "재시작"
              )}
            </Button>
            <Button variant="outline" disabled={loading} onClick={load} className="w-full sm:h-11">
              <RotateCw className={cn("size-4", loading && "animate-spin")} strokeWidth={ICON_STROKE.default} />
              새로고침
            </Button>
          </div>

          <p className="text-xs text-muted-foreground sm:text-sm">
            재시작을 누르면 브라우저를 새로 열고 스터디룸에 재입장합니다.
          </p>

          {status?.recentLogs && status.recentLogs.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <FieldLabel>최근 로그</FieldLabel>
              <pre className="max-h-48 overflow-y-auto rounded-lg border border-border bg-muted p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {status.recentLogs.join("\n")}
              </pre>
            </div>
          )}
        </CollapsiblePanel>
      </Collapsible>
    </SectionCard>
  );
}

// 권한관리 탭의 빈 번호(퇴실 등으로 비워진 슬롯)를 앞으로 당겨 채우는 기능.
// 번호는 시트 탭 이름 자체이자 권한관리/제보상점의 고정 행 번호라, 잘못
// 실행하면 실제 출석/타이머 이력이 섞일 수 있다 — 그래서 미리보기로 이동
// 계획을 먼저 보여주고 관리자가 확인해야만 실행하도록 두 단계로 나눴다.
function MemberReorderSection() {
  const { call } = useApi();

  const [plan, setPlan] = useState<MemberReorderPlanItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  function loadPreview() {
    setLoading(true);
    setError(null);
    setResult(null);
    call<MemberReorderPreviewResponse>("/admin/members/reorder-preview")
      .then((data) => setPlan(data.plan))
      .catch((err) => setError(err instanceof Error ? err.message : "이동 계획을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  function execute() {
    setExecuting(true);
    setError(null);
    call<MemberReorderResponse>("/admin/members/reorder", { method: "POST", body: {} })
      .then((data) => {
        setResult(`${data.moved.length}건 이동 완료.`);
        setPlan(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "번호 정렬에 실패했습니다."))
      .finally(() => setExecuting(false));
  }

  return (
    <SectionCard>
      <Collapsible defaultOpen className="flex flex-col gap-4">
        <SectionHeader icon={ArrowRightLeft} title="번호 정렬" />
        <div className="h-px w-full bg-border" />
        <CollapsiblePanel className="flex flex-col gap-4">
          <p className="text-xs text-muted-foreground sm:text-sm">
            퇴실 등으로 비워진 번호를 앞으로 당겨 채웁니다. 진행 중인 교시가 없을 때 실행하는 것을 권장합니다.
          </p>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {result && (
            <Alert>
              <AlertDescription>{result}</AlertDescription>
            </Alert>
          )}

          <Button variant="outline" disabled={loading} onClick={loadPreview} className="w-full sm:h-11">
            {loading ? <RotateCw className="size-4 animate-spin" strokeWidth={ICON_STROKE.default} /> : "이동 계획 미리보기"}
          </Button>

          {plan && plan.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground sm:text-base">이미 정렬되어 있습니다.</p>
          )}

          {plan && plan.length > 0 && (
            <>
              <div className="flex flex-col gap-2">
                {plan.map((item) => (
                  <InfoCard key={item.from} className="flex items-center justify-between gap-2">
                    <ItemTitle>{item.name}</ItemTitle>
                    <FieldValue>
                      {item.from}번 → {item.to}번
                    </FieldValue>
                  </InfoCard>
                ))}
              </div>
              <Button variant="destructive" disabled={executing} onClick={execute} className="w-full sm:h-11">
                {executing ? <RotateCw className="size-4 animate-spin" strokeWidth={ICON_STROKE.default} /> : "실행"}
              </Button>
            </>
          )}
        </CollapsiblePanel>
      </Collapsible>
    </SectionCard>
  );
}

export function AdminBotSheetTab() {
  return (
    <div className="flex flex-col gap-4">
      <UsageMonitorSection />
      <BotStatusSection />
      <MemberReorderSection />
    </div>
  );
}
