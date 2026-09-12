import { useEffect, useRef, useState } from "react";
import { ArrowRightLeft, Bot, Database, Gauge, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { InfoCard } from "@/components/dashboard/shared";
import { SectionHeader, SectionCard, ItemTitle, FieldLabel, FieldValue } from "@/components/admin/shared";
import { useApi } from "@/hooks/useApi";
import { useRefreshOnVisible } from "@/hooks/useRefreshOnVisible";
import { usePollingRefresh } from "@/hooks/usePollingRefresh";
import { usePullRefreshListener } from "@/hooks/usePullToRefresh";
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
// (docs/HELPERBOT.md 참고).

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function UsageBar({ label, used, limit, unit }: { label: string; used: number; limit: number; unit: string }) {
  // 🔧 [버그 수정] 프론트가 새 필드(kvListsToday 등)를 기대하는 배포 직후,
  // 아직 그 필드를 안 내려주는 이전 워커 응답이 잠깐 섞이면 used/limit이
  // undefined로 들어와 toLocaleString()에서 화면 전체가 죽었다("갑자기
  // 문제가 발생했습니다", Sentry ErrorBoundary로 재현·확인). 배포 타이밍
  // 차이는 늘 있을 수 있으므로 값이 없으면 0으로 방어한다.
  const safeUsed = used ?? 0;
  const safeLimit = limit ?? 0;
  const tone = usageTone(safeUsed, safeLimit);
  const pct = safeLimit > 0 ? Math.min(100, Math.round((safeUsed / safeLimit) * 1000) / 10) : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <FieldLabel>{label}</FieldLabel>
        <FieldValue className={TONE_TEXT_CLASS[tone]}>
          {safeUsed.toLocaleString()} / {safeLimit.toLocaleString()} {unit}
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

// 🔧 [사용자 지시] "그걸 알맞은 게이지 아래에 해달라고. 저렇게 몰아놓지
// 말고" — PUT·DEL·LIST 각각의 "최근 30분(isolate 근사치)"과 "오늘 하루
// (KST, DO 영구 저장)" breakdown을, 하나의 표에 다 몰아 보여주지 않고
// 해당 연산에 대응하는 UsageBar 바로 아래에 op 하나씩 붙이기 위한 헬퍼.
// 🔧 [사용자 지시] "알아먹기 쉽게 실제 메뉴명을 적어줘. 그리고 이메일
// 말고 사용자 이름을 적고" — path/email 필드명은 백엔드 응답 스키마
// 그대로지만, 실제 값은 서버가 이미 "메뉴명"·"사용자 이름"(모르면
// 이메일로 대체)으로 치환해서 내려준다(index.js _menuNameForPath/
// _displayNameForEmail). 프론트는 그대로 렌더링만 한다.
function UsageBreakdownGroup({
  opLabel,
  recentRows,
  dailyRows,
}: {
  opLabel: string;
  recentRows: { op: string; kind: string; path: string; email: string; count: number }[];
  dailyRows: { kind: string; path: string; email: string; op: string; count: number }[];
}) {
  // 🔧 [사용자 지시] "일일과 30분 필터링의 출력 유형이 다르잖아? 일일에
  // 맞춰" → "일일에서도 - 뒤에 캐시 유발 지점을 출력해줘" — "30분"과
  // "일일" 둘 다 메뉴(path)를 먼저 묶고, 그 아래 사용자별로 "영역(kind)"
  // 까지 "사용자 - 영역" 형태로 함께 표시하는 동일한 구조로 통일한다.
  const groupByPath = (rows: { path: string; email: string; kind: string; count: number }[]) =>
    rows.reduce<Record<string, { email: string; kind: string; count: number }[]>>((acc, { path, email, kind, count }) => {
      (acc[path] ??= []).push({ email, kind, count });
      return acc;
    }, {});
  const byPathRecent = groupByPath(recentRows);
  const byPathDaily = groupByPath(dailyRows);
  // 🔧 [사용자 지시] "PUT (쓰기) 옆에 토글 텍스트로 30분, 일일 을 넣고
  // 클릭하면 그에 맞는 값을 필터링 해서 보여줘" — 30분(이 서버 기준)과
  // 일일(DO 영구 저장) 두 목록을 늘 같이 보여주면 항목이 길어져 스캔하기
  // 어려웠다. 기본은 "일일"(더 정확한 값)로 시작하고, 클릭한 쪽만 보여준다.
  const [range, setRange] = useState<"recent" | "daily">("daily");
  return (
    <div className="flex flex-col gap-1.5 border-l-2 border-border pl-2">
      <div className="flex items-center gap-2">
        <span className="text-micro-lg font-semibold sm:text-xs">{opLabel}</span>
        <span aria-hidden className="h-3 w-px bg-border" />
        <div className="flex items-center gap-2 text-micro-lg sm:text-xs">
          <button
            type="button"
            onClick={() => setRange("recent")}
            className={cn(
              "underline-offset-2 hover:underline",
              range === "recent" ? "font-semibold text-foreground" : "text-muted-foreground"
            )}
          >
            30분
          </button>
          <button
            type="button"
            onClick={() => setRange("daily")}
            className={cn(
              "underline-offset-2 hover:underline",
              range === "daily" ? "font-semibold text-foreground" : "text-muted-foreground"
            )}
          >
            일일
          </button>
        </div>
      </div>
      {/* 🔧 [사용자 지시] "PUT (쓰기) 아래에 제목은 지워. 기록만 깔끔하게
          출력해줘" — opLabel과 30분/일일 토글이 이미 위에 있어 "최근 30분
          · 사용자별"/"오늘 하루 · 화면별·사용자별" 소제목은 중복이었다. */}
      {range === "recent" ? (
        <div className="flex flex-col gap-0.5">
          {recentRows.length === 0 ? (
            <p className="pl-2 text-micro-lg text-muted-foreground/70 sm:text-xs">아직 집계된 기록이 없습니다.</p>
          ) : (
            Object.entries(byPathRecent).map(([path, rows]) => (
              <div key={path} className="flex flex-col gap-0.5 pl-2">
                <span className="truncate text-micro-lg font-medium sm:text-xs">{path}</span>
                {rows.map(({ email, kind, count }) => (
                  <div key={`${email}|${kind}`} className="flex items-center justify-between gap-2 pl-2">
                    <span className="truncate text-micro-lg text-muted-foreground before:mr-1 before:content-['└'] sm:text-xs">
                      {email} - {kind}
                    </span>
                    <span className="shrink-0 text-micro-lg font-semibold tabular-nums sm:text-xs">{count}</span>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {dailyRows.length === 0 ? (
            <p className="pl-2 text-micro-lg text-muted-foreground/70 sm:text-xs">
              아직 집계된 기록이 없습니다.
            </p>
          ) : (
            Object.entries(byPathDaily).map(([path, rows]) => (
              <div key={path} className="flex flex-col gap-0.5 pl-2">
                <span className="truncate text-micro-lg font-medium sm:text-xs">{path}</span>
                {rows.map(({ email, kind, count }) => (
                  <div key={`${email}|${kind}`} className="flex items-center justify-between gap-2 pl-2">
                    <span className="truncate text-micro-lg text-muted-foreground before:mr-1 before:content-['└'] sm:text-xs">
                      {email} - {kind}
                    </span>
                    <span className="shrink-0 text-micro-lg font-semibold tabular-nums sm:text-xs">{count}</span>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// Google Sheets(분당 60회 읽기/쓰기)와 Cloudflare(Workers/KV 무료 티어) 무료
// 할당량 대비 현재 사용량을 한 화면에서 보여준다. Sheets 쪽은 이 Worker
// 자신이 호출할 때마다 인메모리로 센 근사치(콜드스타트 시 리셋)이고,
// Cloudflare 쪽은 CF_API_TOKEN이 등록되어 있을 때만 GraphQL Analytics API로
// 오늘 하루 실측치를 가져온다 — 토큰이 없으면 그 부분만 안내 문구로 대체한다.
function UsageMonitorSection({ visible }: { visible: boolean }) {
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
  // 이 카드는 "지금 할당량이 얼마나 찼는지"를 보여주는 실시간 모니터링이
  // 목적이라, 탭을 벗어났다가 돌아왔을 때 몇 분 전 값을 계속 보여주면
  // 한도 임박을 놓칠 수 있다 — 다시 보이게 될 때마다 새로 불러온다.
  useRefreshOnVisible(visible, load);
  usePullRefreshListener(visible, load);
  // 🔧 [사용자 지시] "사용량 모니터링은 1분마다 폴링을 해줘" — 탭을 계속
  // 열어두고 있어도 KV/Sheets 할당량이 실시간에 가깝게 갱신되도록 고정
  // 주기 폴링을 추가한다(다른 섹션들의 usePollingRefresh 패턴과 동일).
  const refreshProgress = usePollingRefresh(visible, load, 60_000);

  return (
    <SectionCard>
      <Collapsible defaultOpen className="flex flex-col">
        <SectionHeader
          icon={Gauge}
          title="사용량 모니터링"
          loading={loading}
          onRefresh={load}
          refreshProgress={refreshProgress}
        />
        <CollapsiblePanel className="flex flex-col gap-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {!usage && !error && (
            // 🔧 2026-09: usage 도착 전엔 이 섹션 안이 완전히 비어 있다가
            // 응답이 오면 카드 두 개(Sheets/Cloudflare, 각각 프로그레스 바
            // 포함)가 한꺼번에 나타나 레이아웃이 훅 밀렸다(사용자 지적) —
            // 실제 UsageBar와 같은 구조의 펄스 스켈레톤을 먼저 그려둔다.
            <div className="flex flex-col gap-3" aria-hidden>
              {Array.from({ length: 2 }).map((_, i) => (
                <InfoCard key={i} className="flex animate-pulse flex-col gap-3">
                  <span className="h-3.5 w-40 rounded bg-muted sm:h-4 sm:w-48" />
                  {Array.from({ length: 2 }).map((_, j) => (
                    <div key={j} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="h-3 w-20 rounded bg-muted sm:h-3.5 sm:w-24" />
                        <span className="h-3 w-16 rounded bg-muted sm:h-3.5 sm:w-20" />
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-muted" />
                    </div>
                  ))}
                </InfoCard>
              ))}
            </div>
          )}

          {usage && (
            <>
              <InfoCard className="flex flex-col gap-3 bg-card">
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
                  Worker와 도움봇(같은 서비스 계정으로 시트에 접근)의 호출을 합산한 근사치입니다. Cloudflare
                  가 요청을 여러 서버로 분산 처리하기 때문에, 이 값은 지금 이 요청을 처리한 서버가 최근에
                  직접 본 호출만 집계한 것으로, 실제 전체 호출량보다 낮게 보일 수 있습니다.
                </p>
              </InfoCard>

              <InfoCard className="flex flex-col gap-3 bg-card">
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
                    {/* 🔧 [사용자 지시] "해당 로그를 남겨서 어디서 누수가
                        발생하는지 알 수 있도록 해줘" → "어느 화면에서 어떤
                        기능에 의해 주기적으로 발생하는지 확인할 수 있도록,
                        좀 더 확실하게 원인을 알고 싶어" — 처음엔 캐시
                        종류만 보여줘 "어디서" 늘어나는지는 알 수 없었다.
                        이제 이 Worker isolate가 최근 30분간 실제로 호출한
                        KV.put/delete를 (연산·캐시종류·요청경로) 조합으로
                        집계해 함께 보여준다 — path로 어느 화면인지(§docs/
                        CACHING_POLICY.md §12.2의 화면↔엔드포인트 매핑과
                        대조), kind로 어떤 캐시인지 바로 알 수 있다
                        (isolate당 근사치 — 정확한 하루 총합은 위 게이지를
                        신뢰). 개별 이벤트 단위까지 보려면 wrangler tail의
                        [kv put]/[kv delete] 로그를 함께 참고.
                        🔧 [사용자 지시] "그걸 알맞은 게이지 아래에 해달라고.
                        저렇게 몰아놓지 말고" — PUT/DEL/LIST를 한 표로 몰아
                        보여주던 걸, PUT·DEL은 바로 위 "KV 쓰기·삭제"
                        게이지 아래에, LIST는 아래 "KV 목록조회(list)"
                        게이지 아래에 각각 붙여 보여준다.
                        🔧 [사용량 모니터링 고도화] 아래 "하루 누적" 목록은
                        위 30분·isolate 근사치와 달리 "오늘 하루(KST 자정
                        기준) 누적·관리자+학생 모두 포함·Durable Object
                        영구 저장" 기준이라 서버 재시작에도 유지된다.
                        🔧 [사용자 지시] "5분마다 갱신 이거 조건 없앨 수
                        있나? 폴링 될 때마다 새로 가져오도록" — 원래 5분
                        cron만 DO로 flush해 최근 5분 이내 발생분이 안 보일
                        수 있었는데, 이제 /admin/usage 조회 시점마다 서버가
                        먼저 flush한 뒤 응답하므로(이 화면 자체가 1분 폴링)
                        지연이 사실상 없다.
                        🔧 [사용자 지시] "내역이 없어도 기본으로 제목이라도
                        보여줘" → "값이 없더라도 각각 아래에 제목은
                        붙이라니까" — 데이터가 없어도 소제목은 항상 보이고,
                        목록이 비었을 때만 "없음" 안내로 대체한다. */}
                    {(
                      [
                        ["kv_put", "PUT (쓰기)"],
                        ["kv_delete", "DEL (삭제)"],
                      ] as const
                    ).map(([op, opLabel]) => (
                      <UsageBreakdownGroup
                        key={op}
                        opLabel={opLabel}
                        recentRows={usage.kvWriteBreakdown.filter((item) => item.op === op)}
                        dailyRows={usage.dailyUsage.filter((item) => item.op === op)}
                      />
                    ))}
                    {/* 🔧 [사용자 지시] "Cloudflare 모니터링 쪽에서 list
                        사용 횟수도 표기해줘" — list()는 위 "KV 읽기" 게이지
                        (read+list 합산, 하루 10만 한도)에도 이미 포함돼
                        있지만, 실제로는 무료 플랜에서 하루 1,000회라는
                        훨씬 빡빡한 자체 한도를 쓴다(2026-08-27 실제 소진
                        이력) — 별도 게이지로 그 한도 대비 사용량을 바로
                        볼 수 있게 한다. */}
                    <UsageBar
                      label="KV 목록조회(list)"
                      used={usage.cloudflare.kvListsToday}
                      limit={usage.limits.kvListsPerDay}
                      unit="회"
                    />
                    <UsageBreakdownGroup
                      opLabel="LIST (목록조회)"
                      recentRows={usage.kvWriteBreakdown.filter((item) => item.op === "kv_list")}
                      dailyRows={usage.dailyUsage.filter((item) => item.op === "kv_list")}
                    />
                    {usage.cloudflare.workersErrorsToday > 0 && (
                      <p className="text-micro-lg text-destructive sm:text-xs">
                        오늘 Workers 오류 {usage.cloudflare.workersErrorsToday}건
                      </p>
                    )}
                    {(() => {
                      const reports = usage.cloudflare.kvStorage.reportsKv;
                      const pushSubs = usage.cloudflare.kvStorage.pushSubsKv;
                      const totalBytes = (reports?.byteCount || 0) + (pushSubs?.byteCount || 0);
                      const limit = usage.limits.kvStorageBytes;
                      const tone = usageTone(totalBytes, limit);
                      const pct = limit > 0 ? Math.min(100, Math.round((totalBytes / limit) * 1000) / 10) : 0;
                      return (
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center justify-between gap-2">
                            <FieldLabel>KV 저장 용량</FieldLabel>
                            <FieldValue className={TONE_TEXT_CLASS[tone]}>
                              {formatBytes(totalBytes)} / {formatBytes(limit)}
                            </FieldValue>
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
                            <div
                              className={cn("h-full rounded-full transition-all", TONE_BAR_CLASS[tone])}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <p className="text-micro-lg text-muted-foreground/70 sm:text-xs">
                            REPORTS_KV{" "}
                            {reports ? `${formatBytes(reports.byteCount)}(키 ${reports.keyCount}개)` : "측정 전"} ·
                            PUSH_SUBS_KV{" "}
                            {pushSubs ? `${formatBytes(pushSubs.byteCount)}(키 ${pushSubs.keyCount}개)` : "측정 전"}
                          </p>
                        </div>
                      );
                    })()}
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

function BotStatusSection({ visible }: { visible: boolean }) {
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
  // 봇 온라인/오프라인은 실제로 수시로 바뀌는 상태라, 탭을 벗어났다가
  // 돌아왔을 때 방금 끊긴 봇을 계속 "온라인"으로 보여주면 오해를 준다.
  useRefreshOnVisible(visible, load);
  usePullRefreshListener(visible, load);
  // 🔧 [자동 갱신, 2026-09] 이 화면(스크린샷 포함)은 KV 캐시가 아니라
  // 봇에 매번 실시간으로 프록시하는 무캐시 경로라 usePollingRefresh의
  // "캐시 TTL의 3배" 원칙이 적용되지 않는다 — 사용자가 직접 정한 고정
  // 주기로 폴링한다. 봇이 요청마다 Selenium으로 화면을 새로 캡처하므로
  // (ctx.lock_element 락 공유), 너무 짧게 잡으면 제보 캡처·교시 기록
  // 같은 봇의 다른 작업과 락 경합이 늘고 대역폭도 커진다 — 원래 "부하는
  // 낮게, 그래도 꽤 실시간"인 절충점으로 1분을 확정했었으나(§12 참고),
  // 2026-09-11 사용자 지시로 더 실시간성을 우선해 30초로 낮췄다 — 락
  // 경합 빈도가 늘 수 있다는 트레이드오프는 감수하기로 함.
  const refreshProgress = usePollingRefresh(visible, load, 30_000);

  // 🔧 [버그 수정] daily_browser_reset(실제 재시작 작업) 자체는 완료까지
  // 수십 초(스레드 정리 대기+브라우저 재기동)가 걸리는데, 원래는 명령
  // 전송(POST) 응답이 오는 즉시 restarting을 풀어 버튼을 다시 누를 수
  // 있게 했다 — 관리자가 "왜 아직 안 됐지" 하며 그 사이 다시 누르면
  // 봇 쪽에서 daily_browser_reset이 동시에 두 번 실행되어 ctx.driver/
  // ctx.lock_element 등 공유 자원이 두 스레드에서 동시에 재할당되는 레이스
  // 로 이어졌다(봇 쪽에도 재진입 가드를 추가했지만, 애초에 프론트에서
  // 재클릭 자체를 막는 게 사용자 경험상 더 명확하다). 실제 재시작 소요
  // 시간(정지 대기 2초+스레드별 최대 11초 join+정리 3초+브라우저 재기동)
  // 보다 넉넉하게 MIN_RESTART_LOCK_MS 동안은 명령 전송이 성공해도 버튼을
  // 계속 비활성 상태로 유지한다.
  const MIN_RESTART_LOCK_MS = 40_000;
  // 🔧 [버그 수정] 예약된 setTimeout에 clearTimeout이 전혀 없었다 — 관리자가
  // 재시작 버튼을 누른 직후(40초 대기 중) 로그아웃 등으로 이 컴포넌트가
  // 언마운트되면, 언마운트된 컴포넌트에 대해 나중에 setState가 호출되는
  // React 경고와 잠재적 누수로 이어졌다. 타이머 id를 ref로 들고 있다가
  // 언마운트 시 정리한다.
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    };
  }, []);

  async function sendRestart() {
    setRestarting(true);
    setError(null);
    setMessage(null);
    const startedAt = Date.now();
    // 명령 전송 자체가 실패한 경우(네트워크 오류, 인증 만료 등)는 실제로
    // 재시작이 시작되지 않았을 가능성이 높으므로 즉시 다시 시도할 수
    // 있게 둔다 — 다만 봇이 "이미 재시작 진행 중"(409)이라고 응답한
    // 경우는 실제로 진행 중인 것이므로 그대로 대기시킨다.
    let shouldWait = true;
    try {
      await call<BotCommandResponse>("/admin/bot/command", { method: "POST", body: { command: "restart" } });
      setMessage("재시작 명령을 전송했습니다. 봇이 브라우저를 재시작하는 동안 잠시 기다려주세요.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "명령 전송에 실패했습니다.");
      shouldWait = err instanceof ApiError && err.status === 409;
    } finally {
      const elapsed = Date.now() - startedAt;
      const remaining = MIN_RESTART_LOCK_MS - elapsed;
      if (shouldWait && remaining > 0) {
        restartTimerRef.current = setTimeout(() => setRestarting(false), remaining);
      } else {
        setRestarting(false);
      }
    }
  }

  const online = status?.online ?? false;
  const roomState = status?.roomState;

  return (
    <SectionCard>
      <Collapsible defaultOpen className="flex flex-col">
        <SectionHeader icon={Bot} title="도움봇 오퍼레이터" loading={loading} onRefresh={load} refreshProgress={refreshProgress} />
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
            // 🔧 [사용자 지시] "이미지를 클릭하면 크게 띄워지도록" — 제보
            // 캡처 미리보기(CapturePreview)와 동일한 Dialog 확대 패턴을
            // 재사용한다.
            <Dialog>
              <DialogTrigger className="block w-full overflow-hidden rounded-lg border border-border outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                <img
                  src={`data:image/png;base64,${status.screenshot}`}
                  alt="도움봇 화면"
                  className="w-full cursor-zoom-in"
                />
              </DialogTrigger>
              <DialogContent className="max-w-3xl bg-black p-2 [&>button]:rounded-full [&>button]:bg-black/60 [&>button]:text-white [&>button]:opacity-100">
                <img
                  src={`data:image/png;base64,${status.screenshot}`}
                  alt="도움봇 화면 확대"
                  className="w-full rounded-lg object-contain"
                />
              </DialogContent>
            </Dialog>
          )}

          <InfoCard className="flex flex-col gap-2.5 bg-card">
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
// "스프레드시트 오퍼레이터"(시트 자체를 조작하는 기능들을 모으는 상위
// 섹션)의 첫 하위 항목 — 지금은 이것 하나뿐이지만, 향후 시트 관련 기능이
// 늘어나면 같은 상위 카드 안에 나란히 추가한다.
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
    <Collapsible defaultOpen className="flex flex-col">
      <SectionHeader icon={ArrowRightLeft} title="번호 정렬" />
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
                <InfoCard key={item.from} className="flex items-center justify-between gap-2 bg-card">
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
  );
}

// "스프레드시트 오퍼레이터" — 공유 스프레드시트 자체를 직접 조작하는 관리
// 기능들을 모으는 상위 섹션. 지금은 "번호 정렬" 하나만 하위 항목으로
// 담지만, 향후 시트 관련 기능이 늘어나면 같은 카드 안에 나란히 추가한다.
// SectionHeader는 내부적으로 CollapsibleTrigger를 렌더링해 부모 Collapsible
// 컨텍스트가 필수라 여기서는 재사용하지 않는다 — 이 상위 카드는 접히지
// 않고(하위 "번호 정렬"만 자체적으로 접힘), 제목만 같은 시각 스타일로
// 직접 그린다.
function SpreadsheetOperatorSection() {
  return (
    <SectionCard>
      {/* 🔧 [사용자 지시] SectionHeader와 동일한 "카드 안의 탭" 스타일을
          직접 그린다 — 이 섹션은 SectionHeader(펼침 트리거 겸용)를 못
          쓰는 특수 케이스라, SectionHeader와 동일하게 음수 마진으로 배경을
          부모 SectionCard 패딩 바깥(카드 가장자리)까지 넓힌다. */}
      <div className="-mx-2.5 -mt-2.5 mb-3.5 flex items-center bg-section-header px-2.5 py-3 sm:-mx-3.5 sm:-mt-3.5 sm:mb-4 sm:px-3.5 sm:py-3.5">
        <span className="flex items-center gap-1.5 text-sm font-bold sm:text-base">
          <Database className="size-4 shrink-0 text-primary sm:size-5" strokeWidth={ICON_STROKE.default} />
          스프레드시트 오퍼레이터
        </span>
      </div>
      <div className="flex flex-col gap-4">
        <MemberReorderSection />
      </div>
    </SectionCard>
  );
}

export function AdminBotSheetTab({ visible }: { visible: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <BotStatusSection visible={visible} />
      <SpreadsheetOperatorSection />
      <UsageMonitorSection visible={visible} />
    </div>
  );
}
