// 🔧 [구조 개선 20차, 2026-09-17] 제보/캡처 도메인(12차, src/report.js)을
// 다시 세 파일로 나눴다(docs/TESTING.md 참고). 이 파일(report-review.js)
// 은 "캡처 목록/응답/투표" 단계만 담당한다 — 접수(report-intake.js)/
// 벌점반영(report-penalty.js) 단계와 실제 호출이 전혀 없음을 실측으로
// 확인했다(순수 재배치, 로직 변경 없음). applyAutoRecognitionForExpired
// 는 index.js의 scheduled(cron 핸들러)가 실사용 import하므로 그대로
// export를 유지한다(12차부터 이어진 패턴).
import {
  verifySession,
  getServiceAccountAccessToken,
  resolveMemberNumber,
  findMemberNumberByEmail,
  requireAdmin,
  json,
  corsHeaders,
  getSheetValues,
  getCurrentPenCycle,
  getCurrentCoReviewers,
  proxyToBotDashboard,
  proxyToBotDashboardRaw,
  OUTPUT_PEN_SHEET_NAME,
  OUTPUT_PEN_SLOT_COLUMNS,
  resolveTargetFileId,
} from "./index.js";
import { listAllMembers } from "./members.js";
import { _cachedCompute } from "./cache.js";
import { kstDateKey, currentWeekMondayKST, formatYYMMDD } from "./date-utils.js";

function getReportVoteStub(env) {
  const id = env.REPORT_VOTE_DO.idFromName("report-vote");
  return env.REPORT_VOTE_DO.get(id);
}
// "송출 P 대상 처리"의 "다른 관리자 의견 반영" — 실제 주 관리자(ADMIN_EMAIL)
// 뿐 아니라 현재 임명된 부스터디장도 캡처 목록 열람/의견 제출을 할 수 있게
// 넓힌 인가. requireAdmin 자체는 건드리지 않고, 캡처 관련 엔드포인트 2곳
// (목록 조회/의견 제출)에서만 이 헬퍼를 쓴다 — 그 외 모든 관리자 엔드포인트는
// 여전히 requireAdmin(주 관리자 전용) 그대로다.
async function requireAdminOrCoReviewer(req, env) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return null;
  if ((session.email || "").toLowerCase() === (env.ADMIN_EMAIL || "").toLowerCase()) {
    return { ...session, role: "admin" };
  }
  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    const memberNumber = await resolveMemberNumber(env, accessToken, session);
    const coReviewers = await getCurrentCoReviewers(env, accessToken, fileId);
    if (coReviewers.some((m) => m.number === memberNumber)) {
      return { ...session, role: "coReviewer", memberNumber };
    }
  } catch {
    // 회원 매칭 실패 등은 그냥 권한 없음으로 처리한다.
  }
  return null;
}

async function attachNextOccurrence(env, items) {
  if (!items.length) return items;
  const accessToken = await getServiceAccountAccessToken(env);
  const fileId = env.GOOGLE_SHEET_FILE_ID;
  const needsSlotPreview = items.some((it) => it.reviewStatus === "pending");
  const [members, dataRows, currentCycle] = await Promise.all([
    listAllMembers(env, accessToken, fileId),
    needsSlotPreview
      ? _cachedCompute(env, `penSlotGrid:${fileId}`, 5 * 60_000, () =>
          getSheetValues(env, accessToken, fileId, `'${OUTPUT_PEN_SHEET_NAME}'!F4:K18`)
        )
      : Promise.resolve(null),
    needsSlotPreview ? getCurrentPenCycle(env, accessToken, fileId) : Promise.resolve(null),
  ]);
  const memberByName = new Map(members.map((m) => [m.name, m]));
  const memberByEmail = new Map(members.map((m) => [m.email.toLowerCase(), m]));

  return items.map((item) => {
    const reporter = memberByEmail.get((item.reporterEmail || "").toLowerCase());
    if (!needsSlotPreview) {
      return { ...item, nextOccurrence: null, weeklyMinorPenaltyCount: 0, reporterName: reporter ? reporter.name : null };
    }
    const member = memberByName.get(item.nickname);
    const row = member ? dataRows[parseInt(member.number, 10) - 1] || [] : [];
    const slotValues = OUTPUT_PEN_SLOT_COLUMNS.map((_, i) => parseInt(row[i], 10) || 0);
    const nextOccurrence = (() => {
      if (!member) return null;
      const slotIndex = slotValues.findIndex((v) => v === 0);
      return slotIndex === -1 ? null : slotIndex + 1;
    })();
    // 🔧 ["이번 주 영향" 실데이터화] 2/3/5차(idx 1,2,4)는 개인 탭 C35 수식과
    // 동일하게 "이번 사이클과 일치하는 슬롯 개수 × 0.1점" 차감이다
    // (buildPersonalStatus의 minorOutputPenCount와 동일 로직). 이 제보가
    // 적용되면 nextOccurrence 슬롯도 currentCycle 값으로 채워지므로,
    // 그 슬롯이 2/3/5차에 해당하면 기존 개수에 1을 더해 "적용 후" 개수를
    // 미리 계산해 둔다 — 프론트가 승인 전에 정확한 예상 차감점을 보여줄 수 있다.
    const existingMinorCount = [1, 2, 4].filter((idx) => slotValues[idx] === currentCycle).length;
    const nextIsMinorSlot = nextOccurrence !== null && [2, 3, 5].includes(nextOccurrence);
    const weeklyMinorPenaltyCount = existingMinorCount + (nextIsMinorSlot ? 1 : 0);
    return {
      ...item,
      nextOccurrence,
      weeklyMinorPenaltyCount,
      reporterName: reporter ? reporter.name : null,
    };
  });
}

// 🔧 [유예 조건] "대상자가 당일 이미 1회 적용을 받았다면, 이후 최대 2건은
// '적용' 대신 '유예'를 노출 → 그 2건을 다 쓰면 다시 '적용'으로 돌아간다"
// (사용자 지시: "1회 적용 → 2회 유예 → 다음 1회 적용" 순환 — 하루 동안
// 여러 번 반복될 수 있다). "당일"은 접수 시각(ts) 기준 KST 날짜 — 봇
// manifest 전체(24시간 노출 창을 벗어난 것도 포함, allItems)에서 "같은
// 날, 같은 대상자"의 승인(penalty 있는 approved)·유예(deferred) 이벤트를
// 접수 시각 순으로 순회하며, 승인이 나올 때마다 유예 카운터를 리셋한다
// (사이클마다 다시 2건까지 유예 가능 — "당일 누적 2건" 한도가 아니다).
// 🔧 [버그 수정, 2026-09] 원래는 "당일 누적 유예 건수 < 2"로 판정해,
// 하루 동안 1적용→2유예 사이클이 한 번 다 돌고 나면(예: 적용→유예→유예→
// 적용) 그 이후의 모든 pending 건이 영원히 "적용"으로만 표시되고 다시는
// 유예가 나오지 않는 버그가 있었다(사용자 실사례로 재현 확인 — 2차 벌점이
// 이미 확정된 뒤에도 다음 건이 "3차 적용"으로만 뜨고 유예로 전환되지
// 않음). 관리자 목록(handleAdminCapturesList)과 대상자 본인 목록
// (handleMyOutputPen)이 동일한 shouldDefer/deferOccurrence 값을 봐야
// 두 화면이 일치하므로(사용자 지시: "내 화각 불량 제보"를 관리자 화면
// 기준으로 맞춤) 공용 함수로 분리해 둘 다 재사용한다.
// items: shouldDefer/deferOccurrence를 붙여 반환할 대상(사이클/닉네임 등으로
// 이미 필터링된 목록) — allItems: 당일 집계용 전체 원본(필터링 전).
function attachDeferralInfo(items, allItems) {
  const MAX_DEFER_PER_CYCLE = 2;
  // 대상자별로 당일 이벤트(승인/유예)를 접수 시각 순으로 순회해, "가장
  // 최근 적용 이후 몇 번째 유예인지"를 센다. 승인이 나오면 카운터가
  // 0으로 리셋되어 다음 적용까지 다시 최대 2건을 유예할 수 있다.
  const eventsByKey = new Map();
  for (const it of allItems) {
    if (it.selfCheck) continue;
    if (!(it.reviewStatus === "deferred" || (it.reviewStatus === "approved" && it.penalty))) continue;
    const key = `${it.nickname}::${kstDateKey(it.ts)}`;
    const list = eventsByKey.get(key) || [];
    list.push(it);
    eventsByKey.set(key, list);
  }
  // 각 대상자의 이벤트열을 훑어, "이 pending 건 직전까지의 사이클 내
  // 유예 순번"(deferredSinceLastApply)과 "직전까지 최소 1회 적용이
  // 있었는지"(hasAppliedBefore)를 시간순으로 누적한다.
  const deferOccurrenceById = new Map();
  const cycleStateByKey = new Map(); // key -> { deferredSinceLastApply, hasApplied }
  for (const [key, list] of eventsByKey) {
    list.sort((a, b) => a.ts - b.ts);
    let deferredSinceLastApply = 0;
    let hasApplied = false;
    for (const it of list) {
      if (it.reviewStatus === "deferred") {
        deferredSinceLastApply += 1;
        deferOccurrenceById.set(it.id, deferredSinceLastApply);
      } else {
        hasApplied = true;
        deferredSinceLastApply = 0;
      }
    }
    cycleStateByKey.set(key, { deferredSinceLastApply, hasApplied });
  }
  return items.map((item) => {
    const key = `${item.nickname}::${kstDateKey(item.ts)}`;
    const state = cycleStateByKey.get(key) || { deferredSinceLastApply: 0, hasApplied: false };
    // 이 항목 자신이 이미 처리(적용/반려/유예 등)되었으면 재판정할 필요가
    // 없다 — pending인 항목에만 "직전 적용 이후, 아직 이번 사이클의 유예
    // 2건을 다 쓰지 않았을 때만" 유예 대상을 매긴다. 2건을 다 쓴 다음
    // pending 건부터는 shouldDefer가 false로 돌아가 다시 "적용"이
    // 나오고, 그 적용이 처리되면 사이클이 리셋되어 다시 유예가 가능해진다.
    const shouldDefer =
      item.reviewStatus === "pending" && state.hasApplied && state.deferredSinceLastApply < MAX_DEFER_PER_CYCLE;
    const deferOccurrence =
      item.reviewStatus === "deferred"
        ? deferOccurrenceById.get(item.id) ?? null
        : shouldDefer
          ? state.deferredSinceLastApply + 1
          : null;
    return { ...item, shouldDefer, deferOccurrence };
  });
}

// "다른 관리자 의견 반영"(공동 검토) 실제 구현 — 부스터디장이 제출한 의견을
// 캡처 id별로 저장한다. 캡처 자체(제보 원본)는 REPORTS_KV가 아니라 로컬
// 봇의 capture_manifest.py(플랫 JSON 파일)에 있으므로, 의견은 여기 KV에
// 독립적으로 두고 목록 조회 시점에 join한다. 🔧 [KV → DO 이전, 2026-09-12]
// §47 — ReportVote DO로 이전(TTL 7일은 그대로, DO 내부에서 관리).
// 🔧 [위반 O/X 단순화] 상/중/하/위반 아님(4단계, 평균 가중치 판정)에서
// "위반 O"/"위반 X"(2단계, 전체 관리자 중 O가 CONSENSUS_THRESHOLD명 이상이면
// 확정) 방식으로 바뀌었다(사용자 지시) — 프론트 SEVERITY_LEVELS와 동일.
const REPORT_SEVERITY_VALUES = ["yes", "no"];

// 🔧 [3주 사이클 토글] weekOf("YYMMDD", 백업 파일명의 그 주 월요일)를 "그
// 월요일 00:00 KST"의 진짜 UTC epoch ms로 변환한다. exitDateSettled류가 쓰는
// `Date.UTC(...) - 9시간` 패턴과 동일 — parseWeekOfToMonday()가 만드는
// "가짜 UTC"(실은 KST 날짜를 담은) Date와 달리, 여기서는 item.ts(진짜 epoch)와
// 직접 비교해야 하므로 KST→UTC 오프셋을 명시적으로 뺀다.
function weekOfToMondayEpochKST(weekOf) {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(weekOf || "");
  if (!m) return null;
  return Date.UTC(2000 + parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)) - 9 * 60 * 60 * 1000;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// cycleFileId(GET /cycles가 내려준 백업 fileId, 없으면 "현재 진행 중")로
// 캡처 items를 그 주(월~일, KST)에 속한 것만 걸러낸다. 현재 진행 중인 사이클은
// 이번 주 월요일 00:00 KST부터 지금까지 — 상한이 없다.
// 🔧 [검토 완료, 수정 보류] 앱스크립트 sheet_reset()은 월요일 00:00이 아니라
// 새벽 5~6시에 실행되므로(exitWeekResetPassed 주석 참고), 이론적으로는
// 월요일 00:00~05:59 사이 발생한 캡처가 "이번 주"로 분류되지만 그 시각
// 실시간 시트의 사이클 번호(집계!D25)는 아직 리셋 전(=지난 사이클)이라
// 화면 분류와 실제 페널티 슬롯 판정이 어긋날 수 있는 경계가 존재한다.
// 다만 정상 운영에서는 교시 시간표(1교시 07:20 시작 ~ 14교시 23:30 종료)가
// 이 새벽 시간대를 아예 포함하지 않아 제보/캡처 자체가 발생하지 않으므로
// (사용자 확인), 실무에 영향이 없는 이론적 경계로 판단해 지금은 손대지
// 않는다 — 교시 시간표 밖에서 캡처가 발생하는 상황(예: 테스트)이 생기면
// 이 함수의 경계를 weekOfToMondayEpochKST + 6시간으로 옮기는 걸 재검토할 것.
async function filterItemsByCycle(env, accessToken, items, cycleFileId) {
  if (!cycleFileId) {
    const mondayEpoch = weekOfToMondayEpochKST(formatYYMMDD(currentWeekMondayKST()));
    return items.filter((item) => item.ts >= mondayEpoch);
  }
  const { weekOf } = await resolveTargetFileId(env, accessToken, cycleFileId);
  const mondayEpoch = weekOfToMondayEpochKST(weekOf);
  if (mondayEpoch == null) return items;
  return items.filter((item) => item.ts >= mondayEpoch && item.ts < mondayEpoch + WEEK_MS);
}

// 🔧 [90분 자동 위반인정] 대상자가 접수 시점(ts)으로부터 90분 내에 "위반인정"/
// "이의제기"를 제출하지 않으면 자동으로 "위반인정"으로 간주한다(사용자
// 지시). 별도 크론 없이, 관리자 목록(handleAdminCapturesList)과 본인 목록
// (handleMyOutputPen) 조회 시점마다 이 함수가 대상 항목을 찾아 그 자리에서
// 봇에 확정 기록을 남긴다 — 다음 조회부터는 이미 targetResponse가 있으니
// 재판정하지 않는다. pending 상태에서만 자동인정한다 — 관리자가 이미
// approved/rejected 등으로 최종 처리했으면 당사자 응답 자체가 더는 의미가
// 없으므로 건드리지 않는다(handleCaptureTargetRespond의 서버측 검증과
// 동일한 기준).
const TARGET_RESPONSE_TIMEOUT_MS = 90 * 60 * 1000;

export async function applyAutoRecognitionForExpired(env, items) {
  const now = Date.now();
  const targets = items.filter(
    (item) =>
      !item.selfCheck &&
      item.reviewStatus === "pending" &&
      !item.targetResponse &&
      now - item.ts >= TARGET_RESPONSE_TIMEOUT_MS
  );
  if (targets.length === 0) return items;

  const respondedAt = Date.now();
  // 🔧 [버그 수정] 원래는 각 /captures/respond 호출의 성공/실패를 전혀
  // 확인하지 않고, 시도한 항목 전부를 무조건 "자동 위반인정됨"으로 화면에
  // 반영했다 — 봇 연결이 그 순간 끊겨 있으면(proxyToBotDashboard가 null
  // 반환) 실제로는 봇 manifest에 targetResponse가 저장되지 않았는데도
  // 응답에는 확정된 것처럼 표시됐다. 그 사이 관리자가 이를 보고 "적용"을
  // 눌러 reviewStatus가 pending을 벗어나면, 이 함수의 대상 필터(pending만)
  // 에 다시는 걸리지 않아 targetResponse가 영원히 기록되지 않는 채로
  // 끝났다. 각 호출의 실제 결과(null이 아닌지)를 확인해, 실제로 저장에
  // 성공한 항목만 "자동 위반인정됨"으로 반영한다 — 실패한 항목은 pending +
  // targetResponse 없음 상태 그대로 남아, 다음 조회 시점에 다시 자동인정을
  // 시도한다(최초 설계 의도인 "다음 조회부터는 재판정 안 함"이 실제로
  // 저장에 성공했을 때만 성립하도록 바로잡음).
  const results = await Promise.all(
    targets.map((item) =>
      proxyToBotDashboard(env, "/captures/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, response: "recognized", auto: true }),
      })
    )
  );

  const autoRecognized = new Set();
  targets.forEach((item, idx) => {
    if (results[idx]) autoRecognized.add(item.id);
  });
  return items.map((item) =>
    autoRecognized.has(item.id)
      ? { ...item, targetResponse: "recognized", targetRespondedAt: respondedAt, targetResponseAuto: true }
      : item
  );
}

export async function handleAdminCapturesList(req, env, origin, url) {
  const auth = await requireAdminOrCoReviewer(req, env);
  if (!auth) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const data = await proxyToBotDashboard(env, "/captures");
  if (!data) {
    return json({ items: [], coReviewers: [] }, 200, origin);
  }
  const allItems = await applyAutoRecognitionForExpired(env, data.items || []);
  // 🔧 [3주 사이클 토글] cycle 쿼리 파라미터(백업 fileId, 없으면 현재 진행
  // 중인 이번 주)로 그 주(월~일, KST)에 발생한 항목만 reviewStatus 무관하게
  // 노출한다("내 송출 P 제보 확인"과 동일한 패턴) — 예전에는 "이번 주"
  // 탭에서도 발생 주차와 무관하게 "대기 중이거나 24시간 이내 결정"만
  // 걸렀는데, 그 결과 지난 주 발생건이 여전히 대기 상태면 "이번 주"에도
  // 계속 섞여 나와 혼란을 줬다(사용자 지적). 다만 미처리 건을 놓치지
  // 않아야 한다는 원래 의도는 지난 사이클 토글로 대체된다 — 관리자가 지난
  // 주차를 눌러보면 그때 미처리로 남아있던 건도 그대로 보인다. shouldDefer
  // (당일 유예 판정, 아래)는 이 필터와 무관하게 항상 allItems 전체를
  // 스캔해야 하므로 여기서 걸러내지 않는다.
  const accessToken = await getServiceAccountAccessToken(env);
  const cycleFileId = url ? url.searchParams.get("cycle") : null;
  const baseItems = await filterItemsByCycle(env, accessToken, allItems, cycleFileId);
  const visible = baseItems.filter((item) => !item.selfCheck);
  const withOccurrence = await attachNextOccurrence(env, visible);

  const withOccurrenceAndDeferral = attachDeferralInfo(withOccurrence, allItems);

  const fileId = env.GOOGLE_SHEET_FILE_ID;
  const coReviewers = await getCurrentCoReviewers(env, accessToken, fileId);
  // 🔧 [KV → DO 이전, 2026-09-12] 예전엔 항목당 부스터디장 수만큼(최대
  // 2명) KV.get을 병렬 호출했는데(§29), 이제 ReportVote DO의
  // /vote/get-batch가 항목 하나당 DO fetch 1회로 부스터디장 전원의
  // 투표를 한 번에 반환한다(§47).
  const reportVoteStub = getReportVoteStub(env);
  const numbers = coReviewers.map((m) => m.number);
  const items = await Promise.all(
    withOccurrenceAndDeferral.map(async (item) => {
      const res = await reportVoteStub
        .fetch("https://do/vote/get-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: item.id, numbers }),
        })
        .catch(() => null);
      const votes = res ? (await res.json()).votes || {} : {};
      return { ...item, votes };
    })
  );
  // 🔧 [스터디장 (이름)] 프론트가 "다른 관리자 의견 반영" 섹션에서 주
  // 관리자 본인의 행을 "스터디장 (이름)"으로 표시하려면 그 이름이 필요하다
  // — 세션에는 이메일만 있으므로, 회원 명단에서 admin 이메일과 일치하는
  // 회원을 찾아 이름을 내려준다(관리자 계정이 회원 명단에 없으면 null —
  // 프론트는 이 경우 이름 없이 "스터디장"만 표시).
  const myName =
    auth.role === "admin"
      ? (await findMemberNumberByEmail(env, accessToken, fileId, (auth.email || "").toLowerCase()).catch(() => null))
          ?.name || null
      : null;
  return json(
    {
      ...data,
      items,
      coReviewers,
      myMemberNumber: auth.role === "coReviewer" ? auth.memberNumber : null,
      myName,
    },
    200,
    origin
  );
}

// "내 송출 P 제보 확인"(제보 페이지) — 본인이 실행한 "내 화각 점검" 기록만
// 조회한다. 관리자 목록(handleAdminCapturesList)과 달리 벌점/페널티 판정
// 대상이 아니라 공동검토자 투표·nextOccurrence 계산이 필요 없어 훨씬
// 단순하다. reporterEmail이 본인이고 selfCheck인 항목만 남긴다 — nickname이
// 아니라 reporterEmail로 거르는 이유는 닉네임 변경/동명이인 가능성과 무관하게
// "누가 실행했는지"가 로그인 계정 기준으로 항상 정확하기 때문이다.
export async function handleMyCaptures(req, env, origin, url) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const data = await proxyToBotDashboard(env, "/captures");
  if (!data) {
    return json({ items: [] }, 200, origin);
  }
  const myEmail = (session.email || "").toLowerCase();
  const mine = (data.items || []).filter(
    (item) => item.selfCheck && (item.reporterEmail || "").toLowerCase() === myEmail
  );
  // 🔧 [3주 사이클 토글] handleMyOutputPen과 동일하게 cycle 쿼리 파라미터로
  // 그 주(월~일, KST)에 발생한 기록만 걸러 보여준다.
  const accessToken = await getServiceAccountAccessToken(env);
  const cycleFileId = url ? url.searchParams.get("cycle") : null;
  const items = await filterItemsByCycle(env, accessToken, mine, cycleFileId);
  return json({ items }, 200, origin);
}

// "내 화각 점검"은 벌점/페널티 판정 대상이 아닌 순수 셀프 확인용 기록이라
// (applyOutputPenalty/applyReportMerit이 전혀 관여하지 않음) 시트를 되돌릴
// 필요 없이 봇 기록만 지우면 된다(사용자 요청: 본인이 직접 삭제 가능하게).
// 관리자 전용 handleAdminCaptureDelete와 달리 로그인한 본인이 자신의
// selfCheck 기록만 지울 수 있도록 별도 라우트로 둔다 — 다른 사람의 캡처나
// 일반 제보를 실수로/악의적으로 지우지 못하게.
export async function handleMyCaptureDelete(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const { id } = await req.json().catch(() => ({}));
  if (!id) return json({ error: "id가 필요합니다." }, 400, origin);

  const data = await proxyToBotDashboard(env, "/captures");
  const item = data && (data.items || []).find((i) => i.id === id);
  if (!item) return json({ error: "기록을 찾을 수 없습니다." }, 404, origin);
  const myEmail = (session.email || "").toLowerCase();
  if (!item.selfCheck || (item.reporterEmail || "").toLowerCase() !== myEmail) {
    return json({ error: "본인의 내 화각 점검 기록만 삭제할 수 있습니다." }, 403, origin);
  }

  const result = await proxyToBotDashboard(env, "/captures/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!result) return json({ error: "봇에 연결할 수 없습니다." }, 502, origin);
  return json(result, 200, origin);
}

// [내 송출 P 제보 확인]이 "나를 대상으로 한 다른 사람의 제보"(selfCheck가
// 아닌 일반 제보 중 nickname이 본인)를 조회한다 — 대상자가 "위반인정"/
// "이의제기"를 누를 수 있는 목록. handleAdminCapturesList와 달리 관리자
// 권한이 필요 없다(로그인만 하면 자기 것만 볼 수 있음). cycle 쿼리
// 파라미터(GET /cycles가 내려준 백업 fileId, 없으면 현재 진행 중)로 그
// 주(월~일, KST)에 발생한 항목 전체를 reviewStatus 무관하게 보여준다.
export async function handleMyOutputPen(req, env, origin, url) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    // 🔧 [캐시 재사용, 2026-09-10] 이 핸들러는 3분마다 폴링되는데도
    // findMemberNumberByEmail(캐시 없이 매번 데이터!A1:V50 직접 조회)을
    // 써서, 세션에 이미 memberNumber가 있어도(정상 경로) 그걸 무시하고
    // 매번 시트를 다시 읽었다 — listAllMembers는 이미 같은 범위를
    // members:(10분) 캐시로 갖고 있으므로, 여기서 이메일로 찾으면 그
    // 캐시를 그대로 재사용할 수 있다(사용자 지적).
    const members = await listAllMembers(env, accessToken, env.GOOGLE_SHEET_FILE_ID);
    const member = members.find((m) => m.email === (session.email || "").toLowerCase());
    if (!member) return json({ items: [] }, 200, origin);

    const data = await proxyToBotDashboard(env, "/captures");
    if (!data) return json({ items: [] }, 200, origin);

    const allItems = await applyAutoRecognitionForExpired(env, data.items || []);
    // 🔧 [3주 사이클 토글] cycle 쿼리 파라미터(백업 fileId, 없으면 현재
    // 진행 중)로 그 주(월~일, KST)에 발생한 항목만 걸러 보여준다 — 예전
    // 24시간 창 제한은 폐지, 선택된 주 전체를 reviewStatus 무관하게 노출한다.
    const cycleFileId = url ? url.searchParams.get("cycle") : null;
    const inCycle = await filterItemsByCycle(env, accessToken, allItems, cycleFileId);
    const visible = inCycle.filter((item) => !item.selfCheck && item.nickname === member.name);
    // 🔧 [상세 화면 관리자 화면과 동일화] "벌점·페널티 변동"(적용 시 차수,
    // 이번 주 영향)을 관리자 화면과 동일하게 보여주려면 nextOccurrence/
    // weeklyMinorPenaltyCount가 필요하다 — attachNextOccurrence는 그대로
    // 재사용 가능한 순수 함수다(env, items만 받음). 제보자 이름도 이 함수가
    // 함께 채워주지만, "제보자는 숨긴다"(사용자 지시)는 프론트에서 그냥
    // 안 보여주는 방식으로 처리하고 여기서는 굳이 제거하지 않는다.
    const withOccurrence = await attachNextOccurrence(env, visible);
    // 🔧 [관리자 화면과 동일화] 유예(deferOccurrence, 당일 몇 번째 유예인지)
    // 정보도 관리자 목록(handleAdminCapturesList)과 동일한 로직으로 계산해
    // 함께 내려준다 — 대상자 본인 화면의 "예상/확정 적용"에도 관리자 화면과
    // 똑같이 "2차 (벌점) 유예 1차" 형태의 취소선 표시가 가능해진다(사용자
    // 지시: "내 화각 불량 제보"를 관리자 화면 기준으로 맞춤). 당일 집계는
    // 사이클/닉네임으로 걸러지지 않은 allItems 전체를 봐야 한다.
    const withDeferral = attachDeferralInfo(withOccurrence, allItems);
    const items = withDeferral.map((item) => ({
      id: item.id,
      reason: item.reason,
      mode: item.mode,
      ts: item.ts,
      reviewStatus: item.reviewStatus,
      targetResponse: item.targetResponse || null,
      targetRespondedAt: item.targetRespondedAt || null,
      // 90분 타임아웃으로 자동 위반인정된 건인지 — 대상자가 직접 버튼을 눌러
      // 응답한 것과 프론트에서 다른 문구로 구분해 보여주기 위함.
      targetResponseAuto: !!item.targetResponseAuto,
      nextOccurrence: item.nextOccurrence,
      weeklyMinorPenaltyCount: item.weeklyMinorPenaltyCount,
      deferOccurrence: item.deferOccurrence,
      // "유예" 결정 시점에 스냅샷으로 고정된 슬롯 차수(있으면) — 없으면
      // nextOccurrence(실시간 재계산값)로 폴백해 보여준다.
      deferredOccurrence: item.deferredOccurrence ?? null,
      // 이미 확정(approved 등)된 항목이면 봇 manifest에 실제 penalty/merit이
      // 저장되어 있다 — "예상 차감"/"적용 시"에 확정값을 보여줄 수 있게 전달.
      penalty: item.penalty || null,
      merit: item.merit || null,
      // "유예" 결정에서만 채워지는 시간 차감 확정값(사용자 지시: 유예도
      // 확정으로 표시).
      timeDeduction: item.timeDeduction || null,
      // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — 새로고침
      // 등으로 applied[item.id](이 세션 로컬 상태)를 잃어도 이 스냅샷으로
      // "취소" 버튼이 정확한 파일에서 롤백할 수 있게 한다.
      sourceFileId: item.sourceFileId || null,
    }));
    return json({ items }, 200, origin);
  } catch (err) {
    return json({ error: "조회 실패: " + err.message }, 500, origin);
  }
}

// [내 송출 P 제보 확인]에서 대상자 본인이 "위반인정"/"이의제기" 중 하나를
// 제출한다. 대상자 신원 확인은 여기서 회원 명단 조회로 하고(닉네임 매칭),
// 본인이 대상자인 캡처가 아니면 거부한다 — 다른 사람의 제보에 함부로
// 응답하지 못하게 막는 최소한의 안전장치.
export async function handleCaptureTargetRespond(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const { id, response } = await req.json().catch(() => ({}));
  if (!id || (response !== "disputed" && response !== "recognized")) {
    return json({ error: "잘못된 요청입니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    // 🔧 [캐시 재사용, 2026-09-10 재적용] 한때 "회원 이름이 방금 바뀌면
    // 캐시가 옛 이름을 돌려줘 본인 확인이 실패할 수 있다"는 우려로
    // findMemberNumberByEmail(캐시 없음)로 되돌렸었다 — 하지만 실제로
    // 확인해보니 "데이터" 시트 이름(C열)을 바꾸는 API 자체가 이 프로젝트
    // 어디에도 없다(신규 등록 시 한 번 정해지면 이후 변경 불가, 사용자
    // 확인: "이름을 변경할 일 자체가 없는데"). 즉 그 우려는 실재하지
    // 않는 시나리오였으므로, handleMyOutputPen과 동일하게 listAllMembers
    // (members:, 10분 캐시)를 다시 재사용한다.
    const members = await listAllMembers(env, accessToken, env.GOOGLE_SHEET_FILE_ID);
    const member = members.find((m) => m.email === (session.email || "").toLowerCase());
    if (!member) return json({ error: "데이터 시트 명단에서 계정을 찾을 수 없습니다." }, 403, origin);

    // 🔧 [버그 수정] data가 null이면(proxyToBotDashboard는 타임아웃/네트워크
    // 실패/!res.ok를 전부 null로 뭉뚱그림) "봇이 완전히 꺼져 있다"는 뜻인데,
    // 원래는 이 경우도 "그 id의 캡처가 없다"는 404로 뭉뚱그려 사용자가
    // 실제 원인(봇 연결 문제)을 알 수 없었다. 여기서 먼저 명시적으로 구분한다.
    const data = await proxyToBotDashboard(env, "/captures");
    if (!data) return json({ error: "봇에 연결할 수 없습니다. 잠시 후 다시 시도해주세요." }, 502, origin);
    const item = (data.items || []).find((i) => i.id === id);
    if (!item) return json({ error: "제보를 찾을 수 없습니다." }, 404, origin);
    if (item.nickname !== member.name) {
      return json({ error: "본인이 대상자인 제보에만 응답할 수 있습니다." }, 403, origin);
    }
    // 🔧 [버그 수정] 클라이언트(canRespond)는 이미 응답했거나 관리자가
    // 최종 처리(승인/반려/유예 등)한 건에는 버튼 자체를 숨기지만, API를
    // 직접 호출하거나 두 탭에서 경합하면 서버 검증이 없어 이미 "위반인정"
    // 한 건을 "이의제기"로 덮어쓰거나, 관리자가 이미 승인 처리한 건에도
    // 뒤늦게 응답이 기록될 수 있었다. 서버에서도 동일 조건을 강제한다.
    if (item.reviewStatus !== "pending") {
      return json({ error: "이미 처리가 완료된 제보입니다." }, 409, origin);
    }
    if (item.targetResponse) {
      return json({ error: "이미 응답을 제출한 제보입니다." }, 409, origin);
    }

    const result = await proxyToBotDashboard(env, "/captures/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, response }),
    });
    // 🔧 [버그 수정] proxyToBotDashboard는 봇이 404(capture_manifest.
    // set_target_response가 "이미 응답 있음"으로 거부)를 반환해도 !res.ok라
    // null을 돌려줘, "진짜 연결 실패"와 "레이스로 인한 거부"를 구분할 수
    // 없다 — 다만 방금 위에서 GET /captures가 성공했으므로(연결 실패였다면
    // 이미 502로 끝났을 것) 봇이 이 요청 사이 짧은 순간에 완전히 끊겼을
    // 가능성은 낮고, 대부분 그 사이 다른 탭/자동확정이 먼저 기록을 마친
        // 레이스라고 보는 게 더 정확하다. 100% 확정할 수는 없어 문구에도 두
    // 가능성을 함께 안내한다.
    if (!result) {
      return json(
        { error: "응답이 반영되지 않았습니다. 이미 다른 곳에서 처리됐거나 봇 연결이 끊겼을 수 있습니다. 새로고침 후 다시 확인해주세요." },
        409,
        origin
      );
    }
    return json(result, 200, origin);
  } catch (err) {
    return json({ error: "응답 제출 실패: " + err.message }, 500, origin);
  }
}

// 부스터디장(공동 검토자)이 대기 중인 제보 하나에 자신의 위반 수준 판단을
// 제출한다. 주 관리자 본인의 "내 판단"은 지금처럼 화면 로컬 상태로만
// 남는다 — 같은 기기·세션에서 바로 확정에 쓰이므로 별도 저장이 필요 없다.
export async function handleAdminCaptureVote(req, env, origin) {
  const auth = await requireAdminOrCoReviewer(req, env);
  if (!auth) return json({ error: "권한이 없습니다." }, 403, origin);
  if (auth.role !== "coReviewer") {
    return json({ error: "공동 검토자(부스터디장)만 의견을 제출할 수 있습니다." }, 403, origin);
  }

  const { id, severity } = await req.json();
  if (!id || typeof id !== "string" || !REPORT_SEVERITY_VALUES.includes(severity)) {
    return json({ error: "제보 ID 또는 판단 값이 올바르지 않습니다." }, 400, origin);
  }

  try {
    // 🔧 [버그 수정] 원래는 id 형식만 검증하고 그 캡처가 실제 존재하는지,
    // 이미 관리자가 최종 처리(승인/반려/유예)했는지 전혀 확인하지 않았다 —
    // handleCaptureTargetRespond(당사자 응답)에는 이미 있는 검증이 이
    // 경로에만 빠져 있었다. 관리자가 승인을 누르는 순간과 거의 동시에
    // 부스터디장이 투표하면, 이미 확정된 항목에 뒤늦은 투표가 조용히
    // 기록될 수 있었다(프론트는 UI로만 막고 있어 직접 API 호출이나
    // 레이스에는 무방비).
    const data = await proxyToBotDashboard(env, "/captures");
    if (!data) return json({ error: "봇에 연결할 수 없습니다. 잠시 후 다시 시도해주세요." }, 502, origin);
    const item = (data.items || []).find((i) => i.id === id);
    if (!item) return json({ error: "제보를 찾을 수 없습니다." }, 404, origin);
    if (item.reviewStatus !== "pending") {
      return json({ error: "이미 처리가 완료된 제보에는 의견을 제출할 수 없습니다." }, 409, origin);
    }
    // 🔧 [버그 수정] 관리자(스터디장) 쪽 ConsensusSection은 "대상자가
    // 이의제기한 건에서만" 합의 검토를 켤 수 있게 막아두는데(사용자
    // 결정), 부스터디장이 실제로 의견을 제출하는 이 엔드포인트는 그
    // 조건을 전혀 검사하지 않았다 — 프론트에서만 막고 있어 API를 직접
    // 호출하면 대상자가 아직 응답하지 않았거나 스스로 위반을 인정한
    // 건에도 부스터디장의 위반 O/X 판단이 KV에 그대로 기록될 수 있었다.
    if (item.targetResponse !== "disputed") {
      return json({ error: "대상자가 이의제기한 건에서만 의견을 제출할 수 있습니다." }, 409, origin);
    }

    const accessToken = await getServiceAccountAccessToken(env);
    const coReviewers = await getCurrentCoReviewers(env, accessToken, env.GOOGLE_SHEET_FILE_ID);
    const me = coReviewers.find((m) => m.number === auth.memberNumber);
    if (!me) {
      return json({ error: "더 이상 부스터디장이 아니어서 의견을 제출할 수 없습니다." }, 403, origin);
    }
    // 🔧 [KV → DO 이전, 2026-09-12] §47 — ReportVote DO로 이전.
    await getReportVoteStub(env).fetch("https://do/vote/put", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, number: me.number, name: me.name, severity }),
    });
    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "의견 제출 실패: " + err.message }, 500, origin);
  }
}

// 🔧 [총 페널티 모달 매칭] 원래는 관리자 전용("화각 제보 검토"/"예치금 재납
// 대상자"에서만 열람)이었지만, 개인 대시보드 "총 페널티" 모달도 같은 이력
// 데이터(PenaltyHistoryDetailDialog)를 재사용하게 되면서 일반 회원도 자신의
// 캡처를 열람할 수 있어야 한다. 캡처 id는 추측 불가능한 봇 발급 문자열이라,
// "로그인된 회원이면 열람 가능"으로 완화해도 실질적으로 본인 관련 캡처만
// 접근하게 된다(다른 회원의 id를 알아낼 방법이 없음).
export async function handleAdminCaptureFile(req, env, origin, url) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const id = url.searchParams.get("id") || "";
  if (!id) return json({ error: "id가 필요합니다." }, 400, origin);

  const res = await proxyToBotDashboardRaw(env, "/captures/file?id=" + encodeURIComponent(id));
  if (!res) {
    return json({ error: "봇에 연결할 수 없습니다." }, 502, origin);
  }
  return new Response(res.body, {
    status: 200,
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "application/octet-stream",
      ...corsHeaders(origin),
    },
  });
}

// 1차~6차 컬럼(F~K) 중 어떤 차수가 "송출P 발생(페널티)" 액션인지 — C39 수식과
// 동일한 기준(4차=I, 6차=K).
