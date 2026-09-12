// 🔧 [구조 개선 13차, 2026-09-13] 봇 상태/사용량 도메인을 index.js에서
// 옮겼다(docs/TESTING.md 참고). proxyToBotDashboard/proxyToBotDashboardRaw,
// getBotAdminConfigStub, BOT_URL_CONFIG_KEY/BOT_PROXY_TIMEOUT_MS,
// _bumpUsageCounter/_getUsageCounter/_emailNameMap/_menuNameForPath,
// getUsageStatsStub/flushDailyUsageStats는 index.js의 다른 도메인(로그인/
// OAuth, 시트 읽기/쓰기 계측, cron)과도 공유하는 범용 유틸이라 index.js에
// 남기고 export만 추가했다. flushQueuedReasonLeaveProofs(leave.js, 11차)는
// handleBotRegisterUrl이 실사용하므로 여기서도 동일하게 import한다.
import {
  json,
  getBotAdminConfigStub,
  BOT_URL_CONFIG_KEY,
  BOT_PROXY_TIMEOUT_MS,
  _bumpUsageCounter,
  _getUsageCounter,
  _emailNameMap,
  _menuNameForPath,
  getUsageStatsStub,
  flushDailyUsageStats,
  getServiceAccountAccessToken,
  requireAdmin,
  proxyToBotDashboard,
} from "./index.js";
import { flushQueuedReasonLeaveProofs } from "./leave.js";
import { listCurrentCycleBackups } from "./cycle.js";
import { formatISODate, todayUTCDateString } from "./date-utils.js";

export async function handleBotRegisterUrl(req, env, origin) {
  const botSecret = req.headers.get("X-Bot-Secret");
  if (!botSecret || botSecret !== env.BOT_SECRET) {
    return json({ error: "unauthorized" }, 401, origin);
  }

  const body = await req.json().catch(() => ({}));
  if (!body.url || typeof body.url !== "string") {
    return json({ error: "url이 필요합니다." }, 400, origin);
  }

  await getBotAdminConfigStub(env).fetch("https://do/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: BOT_URL_CONFIG_KEY, value: body.url }),
  });
  // 봇이 방금 도달 가능해진 시점이므로, 오프라인 동안 쌓인 사유반휴 신청
  // 대기열을 바로 흘려보낸다.
  await flushQueuedReasonLeaveProofs(env);
  return json({ ok: true }, 200, origin);
}

export async function handleBotSheetsUsageReport(req, env, origin) {
  const botSecret = req.headers.get("X-Bot-Secret");
  if (!botSecret || botSecret !== env.BOT_SECRET) {
    return json({ error: "unauthorized" }, 401, origin);
  }

  const { read, write } = await req.json().catch(() => ({}));
  for (let i = 0; i < (parseInt(read, 10) || 0); i++) _bumpUsageCounter("sheets_read");
  for (let i = 0; i < (parseInt(write, 10) || 0); i++) _bumpUsageCounter("sheets_write");
  return json({ ok: true }, 200, origin);
}

// 🔧 [버그 방어] 봇의 capture_manifest.py가 오래된 캡처를 정리(archive)할
// 때, 단순히 "접수 후 N일 지났는지"로 판단하면 실제 3주 사이클 경계와
// 어긋나 "이번 사이클 안에서 아직 조회돼야 할" 캡처가 먼저 옮겨질 수
// 있다(사용자 지적) — 사이클 길이가 정확히 21일이 아닐 수 있고, 새
// 사이클이 막 시작된 직후엔 지난 사이클 자료가 21일 전이라는 이유만으로
// 옮겨지는 경우가 생긴다. listCurrentCycleBackups가 이미 "지금 진행 중인
// 3주 묶음"을 정확히 계산해 두므로, 그 묶음에서 가장 오래된(=사이클 1주차)
// 백업의 weekOf를 그대로 "그 이전 접수 건은 지난 사이클, 그 이후는 이번
// 사이클"의 경계로 봇에게 알려준다 — 봇은 이 경계보다 이전에 접수된
// 확정 건만 archive로 옮긴다. 매주 월요일 정기 작업 한 번만 호출되므로
// Sheets API 부담은 미미하다.
export async function handleInternalCycleBoundary(req, env, origin) {
  const botSecret = req.headers.get("X-Bot-Secret");
  if (!botSecret || botSecret !== env.BOT_SECRET) {
    return json({ error: "unauthorized" }, 401, origin);
  }
  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const { backups } = await listCurrentCycleBackups(env, accessToken);
    // backups는 최신순 정렬 — 배열의 마지막이 "이번 3주 묶음"에서 가장
    // 과거(=사이클 1주차) 백업이다. 백업이 아직 하나도 없으면(운영 시작
    // 직후 등) 이번 사이클 시작을 판단할 근거가 없으므로 null로 알려
    // 봇이 이번 회차 정리를 건너뛰게 한다.
    const oldestInCycle = backups[backups.length - 1] || null;
    return json(
      { cycleStartWeekOf: oldestInCycle ? oldestInCycle.weekOf : null },
      200,
      origin
    );
  } catch (err) {
    return json({ error: "사이클 조회 실패: " + err.message }, 500, origin);
  }
}

// Cloudflare GraphQL Analytics API로 오늘(UTC) 하루치 Workers 요청 수와
// KV 읽기/쓰기 수를 조회한다. CF_API_TOKEN/CF_ACCOUNT_ID가 없으면(토큰
// 미발급) null을 반환 — "Bot·Sheet" 탭이 이 부분만 빈 상태로 보여준다.
// 🔧 [사용자 지시] "일일한도 초기화 시점이 실제 클라우드플레어측 초기화
// 시점과 동일해?" — 무료 티어 할당량(하루 쓰기 1,000회 등)은 Cloudflare
// 내부적으로 UTC 자정에 리셋된다. 예전엔 이 화면이 "오늘"을 KST 자정
// 기준으로 재계산해서 보여줬는데, 그러면 화면의 "오늘 사용량"이 실제
// 한도가 리셋되는 시점(UTC 자정 = KST 오전 9시)과 9시간 어긋나 — 예를
// 들어 KST 오전 9시 직후엔 실제 카운터는 막 0으로 리셋됐는데 화면은
// 여전히 KST 자정부터의 누적치를 보여주는 식으로, 실제 한도 임박 여부를
// 오판하게 만들 수 있었다. Cloudflare의 실제 리셋 기준(UTC 자정~자정)을
// 그대로 따르도록 바꾼다 — date 필터도, 이후 집계 필터도 전부 UTC
// 날짜로 통일(예전에 KST용으로 쓰던 datetimeHourToKSTDateString 변환은
// 더 이상 필요 없어 제거).
async function fetchCloudflareUsage(env) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return null;

  const todayUTC = formatISODate(new Date());
  const utcTodayStr = todayUTC;
  // workersInvocationsAdaptive는 dimensions 없이 limit만 걸면 그날 데이터를
  // 시간대별로 쪼개지 않은 채 정렬 기준 없는 임의의 버킷 몇 개만 반환한다
  // (실측: limit 1이었을 때 하루 총 요청의 약 90%만 잡혔음 — 24시간 중 일부
  // datetimeHour 버킷이 누락된 것). datetimeHour로 명시적으로 나누고
  // limit을 이틀치 최대 시간대 수(48)로 잡은 뒤, 아래에서 직접 합산한다.
  // KV storage 스냅샷은 자동 수집 주기가 (실측상) 하루 5~6회 정도로 드물어,
  // 오늘 날짜만 필터링하면 자정 직후엔 스냅샷이 하나도 없을 수 있다.
  // date_geq로 이틀 전부터 넓게 잡고 orderBy datetime_DESC + limit으로 각
  // 네임스페이스의 가장 최근 스냅샷만 취한다.
  const storageSince = formatISODate(new Date(Date.now() - 2 * 24 * 60 * 60_000));
  const query = `
    query ($accountTag: string!, $dateGeq: string!, $dateLeq: string!, $storageSince: string!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(
            limit: 48
            filter: { date_geq: $dateGeq, date_leq: $dateLeq, scriptName: "frame-checker-worker" }
          ) {
            sum { requests, errors }
            dimensions { datetimeHour }
          }
          kvOperationsAdaptiveGroups(
            limit: 200
            filter: { date_geq: $dateGeq, date_leq: $dateLeq }
          ) {
            sum { requests }
            dimensions { actionType, datetimeHour }
          }
          kvStorageAdaptiveGroups(
            limit: 20
            orderBy: [datetime_DESC]
            filter: { date_geq: $storageSince }
          ) {
            max { byteCount, keyCount }
            dimensions { namespaceId, datetime }
          }
        }
      }
    }
  `;

  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: {
          accountTag: env.CF_ACCOUNT_ID,
          // 🔧 실제 할당량 리셋 기준(UTC 자정~자정)과 동일하게 오늘(UTC)
          // 하루만 조회한다 — 예전엔 KST 하루가 UTC 이틀에 걸쳐 있어 이틀을
          // 가져온 뒤 재필터링했지만, 이제 UTC 기준으로만 보므로 그 보정이
          // 필요 없다.
          dateGeq: utcTodayStr,
          dateLeq: utcTodayStr,
          storageSince,
        },
      }),
    });
    const data = await res.json();
    const account = data && data.data && data.data.viewer && data.data.viewer.accounts && data.data.viewer.accounts[0];
    if (!account) return null;

    const workerGroups = (account.workersInvocationsAdaptive || []).filter(
      (g) => g.dimensions && formatISODate(new Date(g.dimensions.datetimeHour)) === todayUTC
    );
    const workers = workerGroups.reduce(
      (acc, g) => ({
        requests: acc.requests + ((g.sum && g.sum.requests) || 0),
        errors: acc.errors + ((g.sum && g.sum.errors) || 0),
      }),
      { requests: 0, errors: 0 }
    );
    // Cloudflare KV의 actionType은 read/write/delete/list 4종류다. list()도
    // 읽기 할당량(무료 티어 하루 10만 읽기)을 그대로 소진하는 작업이라 read와
    // 함께 묶지 않으면 실사용량을 과소평가한다(실측 확인: list가 read보다도
    // 호출량이 더 많았음 — 이 저장소의 폴링 화면들이 KV.list()를 자주 쓰기 때문).
    // 🔧 [사용자 지시] list()는 read와 별도로 하루 1,000회라는 더 빡빡한
    // 자체 한도(무료 플랜, 2026-08-27 실제 소진 이력)를 쓰므로, kvReadsToday
    // (read+list 합산, 기존 read 10만 한도 게이지용)와는 별도로 list만의
    // 오늘 총합도 함께 반환한다.
    const kvGroups = (account.kvOperationsAdaptiveGroups || []).filter(
      (g) => g.dimensions && formatISODate(new Date(g.dimensions.datetimeHour)) === todayUTC
    );
    const kvReads = kvGroups
      .filter((g) => ["read", "list"].includes(g.dimensions.actionType))
      .reduce((sum, g) => sum + (g.sum ? g.sum.requests : 0), 0);
    const kvWrites = kvGroups
      .filter((g) => ["write", "delete"].includes(g.dimensions.actionType))
      .reduce((sum, g) => sum + (g.sum ? g.sum.requests : 0), 0);
    const kvLists = kvGroups
      .filter((g) => g.dimensions.actionType === "list")
      .reduce((sum, g) => sum + (g.sum ? g.sum.requests : 0), 0);

    // namespaceId에 하이픈이 있는/없는 두 표기가 섞여 나올 수 있어 비교 전에
    // 제거한다. orderBy datetime_DESC로 이미 최신순 정렬되어 있으므로, 각
    // 네임스페이스에서 처음 만나는 항목이 곧 가장 최근 스냅샷이다.
    const norm = (id) => (id || "").replace(/-/g, "");
    const storageGroups = account.kvStorageAdaptiveGroups || [];
    const knownNamespaces = [
      { key: "reportsKv", id: norm("4c09599c0cf34fb493137a337b0cf1db") },
      { key: "pushSubsKv", id: norm("2154564b9fb44d15ae0d682a7ce86232") },
    ];
    const kvStorage = {};
    for (const ns of knownNamespaces) {
      const latest = storageGroups.find((g) => g.dimensions && norm(g.dimensions.namespaceId) === ns.id);
      kvStorage[ns.key] = latest ? { byteCount: latest.max.byteCount || 0, keyCount: latest.max.keyCount || 0 } : null;
    }

    return {
      workersRequestsToday: workers.requests || 0,
      workersErrorsToday: workers.errors || 0,
      kvReadsToday: kvReads,
      kvWritesToday: kvWrites,
      kvListsToday: kvLists,
      kvStorage,
    };
  } catch {
    return null;
  }
}

// 자체 계측(Sheets API 분당 호출 수)과 Cloudflare 실측치(오늘 하루 Workers
// 요청 수/KV 읽기·쓰기 수)를 함께 반환한다. 무료 티어 한도(Sheets 분당 60,
// Workers 하루 10만, KV 하루 읽기 10만/쓰기 1천)와 나란히 보여줘 "Bot·Sheet"
// 탭에서 한눈에 위험 수준을 판단할 수 있게 한다.
export async function handleAdminUsageStatus(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const cloudflare = await fetchCloudflareUsage(env);

  // 🔧 [사용자 지시] "5분마다 갱신 이거 조건 없앨 수 있나? 폴링 될 때마다
  // 새로 가져오도록" — cron(5분 주기)만 flush하면 그 사이 발생분은 화면에
  // 안 보인다. DO 조회 직전에 한 번 더 flush해 이 요청 시점까지의 버퍼를
  // 반영시킨다 — flush 자체가 실패해도(신규 배포 직후 DO 초기화 지연 등)
  // 조회는 계속 진행되도록 별도 try/catch로 감싼다.
  try {
    await flushDailyUsageStats(env);
  } catch (e) {
    console.error("[admin/usage] flush 실패:", e);
  }

  // UsageStats DO에서 오늘(KST) 하루치 (경로·사용자·연산)별 누적 집계와
  // 최근 30분치 (캐시종류·경로·사용자·연산)별 집계를 함께 읽어온다. DO
  // 조회 자체가 실패해도(신규 배포 직후 등) 전체 응답이 죽지 않도록 빈
  // 배열로 대체한다.
  // 🔧 [사용자 지시] "알아먹기 쉽게 실제 메뉴명을 적어줘. 그리고 이메일
  // 말고 사용자 이름을 적고" → "여기 이메일로 보이는데?" — 처음엔
  // isolate 로컬 _emailNameMap만으로 치환해, 이 요청을 처리한 isolate가
  // 그 사용자를 아직 못 봤으면 이메일이 그대로 보이는 문제가 있었다.
  // 이제 DO 응답의 names(모든 isolate가 관측한 email->name 전체 매핑)를
  // 우선 쓰고, 거기 없으면 isolate 로컬 매핑, 그마저 없으면 이메일
  // 그대로 표시한다(집계 값 자체는 항상 정확).
  const usageStub = getUsageStatsStub(env);
  const displayNameWith = (doNames) => (email) => {
    if (!email || email === "(익명)") return email || "(익명)";
    return doNames[email] || _emailNameMap.get(email) || email;
  };
  const dailyUsage = await usageStub
    .fetch(`https://do/today?date=${encodeURIComponent(todayUTCDateString())}`)
    .then((r) => r.json())
    .then((d) => {
      const toName = displayNameWith(d.names || {});
      return (d.items || []).map((it) => ({ ...it, path: _menuNameForPath(it.path), email: toName(it.email) }));
    })
    .catch(() => []);
  // 🔧 [사용자 지시] "일일 중에서 30분내로 발생한것만 추려서 보여주면
  // 되잖아" — 기존 _getKvWriteBreakdown()(isolate 로컬 _kvUsageCounters)
  // 대신 DO의 /recent(모든 isolate의 기록을 모아 30분만 필터링)를 쓴다.
  const kvWriteBreakdown = await usageStub
    .fetch("https://do/recent")
    .then((r) => r.json())
    .then((d) => {
      const toName = displayNameWith(d.names || {});
      return (d.items || [])
        .map((it) => ({ ...it, path: _menuNameForPath(it.path), email: toName(it.email) }))
        .sort((a, b) => b.count - a.count);
    })
    .catch(() => []);

  return json(
    {
      sheets: {
        readsThisMinute: _getUsageCounter("sheets_read"),
        readsLastMinute: _getUsageCounter("sheets_read", 1),
        writesThisMinute: _getUsageCounter("sheets_write"),
        writesLastMinute: _getUsageCounter("sheets_write", 1),
        readLimitPerMinute: 60,
        writeLimitPerMinute: 60,
      },
      cloudflare,
      cloudflareConfigured: !!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID),
      limits: {
        workersRequestsPerDay: 100_000,
        kvReadsPerDay: 100_000,
        kvWritesPerDay: 1_000,
        // 🔧 [사용자 지시] list()는 read 한도(10만)와 별개로 무료 플랜에서
        // 하루 1,000회라는 훨씬 빡빡한 자체 한도를 쓴다(2026-08-27 실제
        // 소진 이력) — kvReadsPerDay와 별도 게이지로 보여주기 위한 한도.
        kvListsPerDay: 1_000,
        kvStorageBytes: 1_000_000_000,
      },
      // 🔧 [KV 쓰기/삭제 추적, 화면별 특정] "어느 화면에서 어떤 기능에
      // 의해 쓰기·삭제가 주기적으로 발생하는지" — 최근 30분간 실제로
      // KV.put/delete/list를 호출한 (연산·캐시종류·요청경로·사용자) 조합별
      // 집계, 예: [{op:"kv_put", kind:"sheetCache:exitStatus:",
      // path:"화각 불량 제보 처리", email:"재희", count:5}, ...].
      // 🔧 [사용자 지시] "일일 중에서 30분내로 발생한것만 추려서 보여주면
      // 되잖아" — 예전엔 이 isolate가 콜드스타트된 이후 직접 겪은 것만
      // 보여줘(isolate 로컬 _kvUsageCounters) Cloudflare가 요청을 여러
      // 서버로 분산 처리하면 "일일"보다 훨씬 적게 보였다. 이제 DO에 저장된
      // "모든 isolate의 기록"에서 최근 30분치만 필터링해 보여주므로 항상
      // 완전한 값이다.
      kvWriteBreakdown,
      // 🔧 [사용량 모니터링 고도화, 2026-09-11] 위 kvWriteBreakdown과 달리
      // "하루(KST 자정 기준) 누적 · 관리자+학생 모두 포함" 기준이다. 둘 다
      // 이제 같은 Durable Object에 저장되므로 isolate 재시작·분산 처리와
      // 무관하게 항상 완전한 값을 보여준다.
      dailyUsage,
    },
    200,
    origin
  );
}

export async function handleAdminBotStatus(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const data = await proxyToBotDashboard(env, "/status");
  if (!data) {
    return json({ online: false, roomState: null, screenshot: null, recentLogs: [] }, 200, origin);
  }
  return json(data, 200, origin);
}

const BOT_COMMAND_VALUES = ["restart"];

export async function handleAdminBotCommand(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { command } = await req.json();
  if (!BOT_COMMAND_VALUES.includes(command)) {
    return json({ error: "알 수 없는 명령입니다." }, 400, origin);
  }

  // 🔧 [버그 수정] proxyToBotDashboard는 봇 응답이 200번대가 아니면(409
  // 포함) 무조건 null로 뭉뚱그린다 — 그래서 봇의 /restart가 "이미 재시작
  // 진행 중"을 알리려고 409를 반환해도 이 핸들러는 이를 "봇에 연결할 수
  // 없음"(502)과 구분하지 못하고 항상 502로만 응답했다. 관리자에게 정확한
  // 사유를 보여주기 위해 이 호출만은 proxyToBotDashboard를 거치지 않고
  // 직접 fetch해 상태 코드를 그대로 확인한다.
  const botUrlRes = await getBotAdminConfigStub(env).fetch(`https://do/config?key=${BOT_URL_CONFIG_KEY}`);
  const { value: botUrl } = await botUrlRes.json();
  if (!botUrl) {
    return json({ error: "봇에 연결할 수 없습니다. 봇이 꺼져 있거나 Tunnel이 끊겼을 수 있습니다." }, 502, origin);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BOT_PROXY_TIMEOUT_MS);
  try {
    const res = await fetch(botUrl + "/" + command, {
      method: "POST",
      headers: { "X-Dashboard-Secret": env.BOT_SECRET },
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) {
      return json({ error: data.error || "이미 처리 중인 명령이 있습니다." }, 409, origin);
    }
    if (!res.ok) {
      return json({ error: "봇에 연결할 수 없습니다. 봇이 꺼져 있거나 Tunnel이 끊겼을 수 있습니다." }, 502, origin);
    }
    return json(data, 200, origin);
  } catch {
    return json({ error: "봇에 연결할 수 없습니다. 봇이 꺼져 있거나 Tunnel이 끊겼을 수 있습니다." }, 502, origin);
  } finally {
    clearTimeout(timer);
  }
}
