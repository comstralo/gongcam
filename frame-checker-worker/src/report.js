// 🔧 [구조 개선 12차, 2026-09-13] 제보/캡처 도메인(신고 접수/쿨다운,
// 캡처 검토·결정, 벌점/제보상점 반영, 부스터디장 투표)을 index.js에서
// 분리했다(docs/TESTING.md 참고). 이 도메인 자체가 직접 쓰는 DO는
// ReportQueue/ReportVote 두 개뿐이며, ParticipantsRoster(쿨다운 4함수 +
// withMemberLock)는 leave.js/exit.js 등과 공유하는 범용 DO라 그 stub과
// 4개 헬퍼(checkReportCooldown 등)만 이 파일로 함께 옮기고 getRosterStub
// 자체는 index.js에 남긴다.
//
// OUTPUT_PEN_SHEET_NAME/OUTPUT_PEN_SLOT_COLUMNS/colIndexToLetter/
// getSheetIdByName/getRowNotes는 exit.js/개인 대시보드(buildPersonalStatus)
// 도 공유하는 범용 함수·상수라 index.js에 남기고 export만 추가해 여기서
// 실사용 목적으로 가져온다(6~11차와 동일 패턴) — latestSlotDay/
// buildSlotHistory/depositAgainOccurredDay/parseSlotNoteDateMs/
// msToStatusDay(슬롯 주석 → 요일/이력 변환 유틸)도 exit.js·
// buildPersonalStatus가 실사용해 index.js에 남는다.
import {
  verifySession,
  getServiceAccountAccessToken,
  resolveMemberNumber,
  findMemberNumberByEmail,
  requireAdmin,
  json,
  corsHeaders,
  withMemberLock,
  getRosterStub,
  getSheetValues,
  writeSheetValues,
  spreadsheetBatchUpdate,
  getCurrentPenCycle,
  getSheetIdByName,
  colIndexToLetter,
  getCurrentCoReviewers,
  proxyToBotDashboard,
  proxyToBotDashboardRaw,
  OUTPUT_PEN_SHEET_NAME,
  OUTPUT_PEN_SLOT_COLUMNS,
  STATUS_DAYS,
  STATUS_DAY_COLS,
  resolveTargetFileId,
  resolveCaptureSourceFileId,
} from "./index.js";
import { listAllMembers } from "./members.js";
import { _cachedCompute, invalidateMemberCache, invalidateMemberSlotCache } from "./cache.js";
import { kstDateKey, currentWeekMondayKST, formatYYMMDD } from "./date-utils.js";

function getReportQueueStub(env) {
  const id = env.REPORT_QUEUE_DO.idFromName("report-queue");
  return env.REPORT_QUEUE_DO.get(id);
}

function getReportVoteStub(env) {
  const id = env.REPORT_VOTE_DO.idFromName("report-vote");
  return env.REPORT_VOTE_DO.get(id);
}

// "진행 중인 제보" 쿨다운/목록 — ParticipantsRoster DO(§lock과 동일한 단일
// 인스턴스)에 위임한다. 이 네 함수 모두 KV를 전혀 건드리지 않는다.
async function checkReportCooldown(env, cooldownKey) {
  const stub = getRosterStub(env);
  const res = await stub.fetch("https://do/report-cooldown/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cooldownKey }),
  });
  const data = await res.json();
  return !!data.onCooldown;
}

async function recordReportCooldown(env, entry, cooldownSec) {
  const stub = getRosterStub(env);
  await stub.fetch("https://do/report-cooldown/record", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...entry, cooldownSec }),
  });
}

async function markReportCaptureDone(env, id, capturedAt) {
  const stub = getRosterStub(env);
  await stub.fetch("https://do/report-cooldown/capture-done", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, capturedAt }),
  });
}

async function listReportCooldowns(env) {
  const stub = getRosterStub(env);
  const res = await stub.fetch("https://do/report-cooldown/list", { method: "GET" });
  const data = await res.json();
  return data.items || [];
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

const REPORT_COOLDOWN_SEC = 20 * 60;
// 🔧 [촬영 진행 중 카운트다운] 제보 접수 직후부터 20분 재제보 쿨다운을 바로
// 보여주면, 실제로 봇이 촬영 중인 짧은 구간(스크린샷 약 2.5분, 영상 약
// 1.5~3분)에도 20분짜리 숫자가 떠 사용자가 "촬영이 끝났나?"를 가늠할 수
// 없었다(사용자 지시). 모드별 예상 촬영 소요시간을 실제값(study_sw/bot/
// tracking.py의 스크린샷 30초×6장=150초, 영상 DURATION_SEC=90초, 최대
// 180초 상한)에 맞춰 넉넉히 잡아, 봇이 캡처 완료를 보고하기 전까지는 이
// 값으로 카운트다운하다가 완료 보고를 받으면(또는 예상 시간을 넘기면) 그
// 때부터 20분 카운트다운으로 자연히 전환한다.
const EXPECTED_CAPTURE_SEC = { screenshot: 150, video: 180 };
// "내 화각 점검" — 제보와 동일한 캡처 메커니즘(스크린샷)을 쓰지만 대상자가
// 항상 본인이고, 벌점/페널티 판정 대상이 아닌 셀프 확인용이다(사용자 요청).
// 일반 제보와 쿨다운/노출 목록을 공유하면 서로 간섭하므로 완전히 분리한다.
const SELF_CHECK_REASON = "본인 화각 점검";
const SELF_CHECK_COOLDOWN_SEC = 20 * 60;
// handleReport가 report:{id}를 최초로 KV에 쓸 때와 handleRequeueReport가
// 안전망 폴링에서 스킵된 항목을 재등록할 때 동일하게 참조하는 TTL.
// 🔧 [2026-09-11] 6시간→12시간 — 봇이 오래 꺼져 있어도(직접 푸시 실패 +
// 10분 안전망 폴링도 그동안 못 도는 경우) 더 긴 유예를 두기 위함. TTL만
// 늘리는 변경이라 KV 쓰기/삭제 횟수에는 영향 없음(그대로 접수 1건).
const REPORT_TTL_SEC = 60 * 60 * 12;

export async function handleReport(req, env, origin) {
  const { token, nickname, reason, mode, selfCheck } = await req.json();
  if (!token) return json({ error: "필수 항목 누락" }, 400, origin);

  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const isSelfCheck = !!selfCheck;

  let trimmedNickname;
  let finalReason;
  let finalMode;
  let cooldownKey;
  let cooldownSec;

  if (isSelfCheck) {
    // 대상자는 항상 본인 — 프론트가 보낸 nickname을 신뢰하지 않고 서버가
    // 회원 명단에서 직접 조회해 강제한다(제3자를 지정할 수 없게).
    try {
      const accessToken = await getServiceAccountAccessToken(env);
      const member = await findMemberNumberByEmail(env, accessToken, env.GOOGLE_SHEET_FILE_ID, session.email);
      if (!member) return json({ error: "데이터 시트 명단에서 계정을 찾을 수 없습니다." }, 403, origin);
      trimmedNickname = member.name;
    } catch (err) {
      return json({ error: "회원 조회 실패: " + err.message }, 500, origin);
    }
    finalReason = SELF_CHECK_REASON;
    finalMode = "screenshot"; // 셀프 확인은 스크린샷만 지원(사용자 확정).
    cooldownKey = `selfcheck-cooldown:${session.email}`;
    cooldownSec = SELF_CHECK_COOLDOWN_SEC;
  }

  // 🔧 [사용자 지시] 관리자는 일반 제보 20분 쿨다운을 우회한다 — 같은
  // 대상을 반복 확인해야 하는 경우가 있어서다. 셀프 체크도 이제 관리자는
  // 동일하게 우회한다(사용자 확인: "관리자는 항상 가능하게 하도록
  // 했을텐데" — 원래는 셀프 체크만 예외로 관리자도 쿨다운이 걸려 있었는데,
  // 일반 제보와 정책을 통일했다).
  const isAdmin = (session.email || "").toLowerCase() === (env.ADMIN_EMAIL || "").toLowerCase();

  if (!isSelfCheck) {
    if (!nickname) return json({ error: "필수 항목 누락" }, 400, origin);
    if (!reason) return json({ error: "상황 설명을 선택해주세요." }, 400, origin);
    trimmedNickname = nickname.slice(0, 50);
    // 🔧 [버그 방어] 웹 UI는 실시간 참여자 명단에서 고르는 드롭다운이라
    // 정상 사용 경로에서는 오타가 날 수 없지만, /report는 로그인 세션만
    // 있으면 누구나 직접 호출 가능한 일반 HTTP 엔드포인트다 — UI를 거치지
    // 않고 임의의 nickname으로 이 엔드포인트를 직접 두드리면 검증 없이
    // 접수돼, 봇이 화면에서 존재하지도 않는 이름을 찾느라 캡처 사이클(특히
    // 영상 모드는 더 오래 걸림)을 낭비하고 관리자 검토 목록에는 최종
    // 승인 단계(applyOutputPenalty)에서나 발각되는 처리 불가 항목이
    // 쌓였다. listAllMembers는 캐시(현재 10분, members: 참고)가 있어 매
    // 제보마다 새로 시트를 읽지 않으므로, 접수 시점에 앞당겨 확인해도 API
    // 호출 부담이 늘지 않는다.
    let members;
    try {
      const accessToken = await getServiceAccountAccessToken(env);
      members = await listAllMembers(env, accessToken, env.GOOGLE_SHEET_FILE_ID);
      if (!members.some((m) => m.name === trimmedNickname)) {
        return json({ error: "회원 명단에서 해당 참여자를 찾을 수 없습니다." }, 400, origin);
      }
    } catch (err) {
      return json({ error: "회원 조회 실패: " + err.message }, 500, origin);
    }
    // 🔧 [버그 수정] "내 화각 점검" 기능이 이미 자기 자신을 확인하는 용도로
    // 따로 있으므로, 일반 제보(=위반 심사로 이어짐)에서는 관리자가 아닌
    // 이상 자기 자신을 대상자로 지정할 수 없게 막는다(사용자 결정). 웹
    // UI 드롭다운은 이미 본인 이름을 안 보여주지만, /report는 직접 호출도
    // 가능한 엔드포인트라 서버에서도 동일하게 막아야 한다. 관리자는 기능
    // 테스트를 위해 예외로 허용한다(사용자 결정).
    // 🔧 원래는 session.memberName(로그인 시점에 고정, 최대 30일 유지되는
    // 세션 값)과 비교했다 — 로그인 이후 시트에서 본인 닉네임이 바뀌면
    // (개명·오타 정정 등) 세션의 옛 이름과 현재 닉네임이 달라져 자기 자신을
    // 신고해도 통과되거나, 반대로 옛 이름을 물려받은 다른 사람을 신고했는데
    // 잘못 차단될 수 있었다. 바로 위에서 이미 조회해 둔 최신 회원 명단에서
    // session.email로 현재 닉네임을 다시 찾아 비교해, 세션이 오래돼도 항상
    // 최신 상태 기준으로 판단하게 한다.
    if (!isAdmin) {
      const selfMember = members.find((m) => m.email.toLowerCase() === (session.email || "").toLowerCase());
      if (selfMember && trimmedNickname === selfMember.name) {
        return json({ error: "본인은 제보 대상으로 지정할 수 없습니다. '내 화각 점검'을 이용해주세요." }, 400, origin);
      }
    }
    finalReason = reason.slice(0, 200);
    finalMode = mode === "video" ? "video" : "screenshot";
    // 쿨다운은 모드와 무관하게 닉네임 기준으로 공유한다 — 스크린샷 제보 직후
    // 영상 제보로 우회해 쿨다운을 피하는 것을 막기 위함이다.
    cooldownKey = `cooldown:${trimmedNickname}`;
    cooldownSec = REPORT_COOLDOWN_SEC;
  }

  // 🔧 [KV → DO 이전, 2026-09-11] 쿨다운 체크를 KV(cooldown:/selfcheck-cooldown:)가
  // 아니라 ParticipantsRoster DO에 위임한다 — cooldownKey 문자열은 그대로
  // 재사용(두 종류가 안 섞이도록)하되, 저장소만 바뀐다.
  if (!isAdmin) {
    const onCooldown = await checkReportCooldown(env, cooldownKey);
    if (onCooldown) {
      return json(
        {
          error: isSelfCheck
            ? "내 화각 점검은 20분 내에 다시 실행할 수 없습니다."
            : "같은 대상은 20분 내에 다시 제보할 수 없습니다.",
        },
        429,
        origin
      );
    }
  }

  const id = crypto.randomUUID();
  const ts = Date.now();
  const entry = {
    id,
    nickname: trimmedNickname,
    reason: finalReason,
    mode: finalMode,
    reporterEmail: session.email,
    // 텔레그램 알림에 "제보자: <이름>"으로 보여주기 위함(사용자 지시) —
    // 세션이 로그인 시점에 이미 회원 시트에서 조회해둔 이름(memberName)을
    // 그대로 재사용해 별도 시트 조회 없이 얻는다. 명단에 없는 계정이면
    // null이므로 이메일로 폴백한다.
    reporterName: session.memberName || session.email,
    ts,
    selfCheck: isSelfCheck,
    // 🔧 [관리자 중복 제보 허용] 같은 대상에게 짧은 간격으로 두 번째 제보가
    // 오면, 봇은 원래 thread_id(닉네임 기준)로 중복 실행을 막아 첫 캡처가
    // 끝나기 전엔 두 번째를 조용히 무시했다(사용자 지시로 이제 관리자는
    // 이 제한을 우회 — 관리자가 의도적으로 같은 대상을 연달아 제보하는
    // 경우를 실제로 놓치지 않아야 하므로). 이 플래그를 봇이 보고 thread_id
    // 자체를 요청마다 고유하게 만든다(report_intake.py 참고).
    isAdmin,
  };
  // 🔧 [KV → DO 이전, 2026-09-12] 안전망 큐(report:{id})를 ReportQueue DO로
  // 옮겼다(§ReportQueue 클래스 주석 참고) — KV put/delete/list 세 연산이
  // 여기서 전부 빠진다.
  const reportQueue = getReportQueueStub(env);
  await reportQueue.fetch("https://do/put", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entry, ttlSec: REPORT_TTL_SEC }),
  });
  // 🔧 [KV → DO 이전, 2026-09-11] 쿨다운 기록 + "진행 중인 제보" 표시를
  // 하나의 DO 호출로 겸한다 — KV 시절엔 cooldownKey(차단 판정용)와
  // COOLDOWN_INDEX_KEY(표시용)를 따로 썼는데, DO에서는 배열 하나(§record)가
  // 둘 다 담당해 별도로 동기화할 필요가 없다. 셀프 체크도 항상 기록하되
  // (본인조차 진행 상황을 봐야 하므로), "진행 중인 제보" 조회 시점
  // (handleListActiveCooldowns)에서 요청자 본인과 관리자에게만 걸러
  // 보여준다 — 그 필터링 로직 자체는 그대로 유지된다. 관리자는 재제보
  // 차단(위 429)만 우회할 뿐 이 기록 자체는 관리자 제보도 똑같이 남는다.
  await recordReportCooldown(
    env,
    {
      cooldownKey,
      id,
      nickname: trimmedNickname,
      mode: finalMode,
      selfCheck: isSelfCheck,
      reporterEmail: session.email,
    },
    cooldownSec
  );

  // 봇에 즉시 푸시해서 폴링 지연 없이 바로 캡처를 시작시킨다. proxyToBotDashboard는
  // 실패(터널이 그 순간 끊겨 있는 등) 시 예외 없이 null만 반환한다 — 실패하면
  // 위 KV 기록(report:{id})이 이미 남아있으니 안전망 폴링(report_intake.py,
  // 훨씬 낮은 빈도)이 놓친 걸 나중에 집어간다.
  // 🔧 [버그 수정] 원래는 이 호출의 성공/실패와 무관하게 report:{id} KV를
  // 그대로 뒀다 — handleListReports(안전망 폴링이 부르는 경로)만 유일하게
  // 이 키를 지우는데, 즉시 푸시가 성공해도 이 키는 그대로 남아 TTL(6시간)
  // 동안 존재했다. 스크린샷(3분)/영상(90초) 캡처는 항상 안전망 폴링 주기
  // (10분)보다 먼저 끝나므로, 정상적으로 즉시 처리된 거의 모든 제보가
  // 10분 뒤 안전망 폴링에 다시 걸려 캡처가 중복 실행되고 텔레그램도
  // 중복 전송됐다. 즉시 푸시가 성공한 경우에는 그 자리에서 바로 지워
  // 안전망이 재처리하지 못하게 한다 — 실패한 경우에만 안전망이 나중에
  // 이 키를 발견해 처리한다.
  // 🔧 [버그 수정, 2차] 위 수정이 "HTTP 200/202 = 실제로 캡처가 시작됨"으로
  // 오해해 생긴 새 회귀 — 봇의 set_thread는 같은 대상에 대해 이미 진행
  // 중인 캡처가 있으면(예: 이 대상자의 "내 화각 점검"이 마침 진행 중일 때
  // 다른 사람이 진짜로 신고하는 경우, 서로 다른 쿨다운 키라 둘 다 통과됨)
  // 새로 시작하지 않고 조용히 건너뛰지만 HTTP 응답은 여전히 200/202였다.
  // 그러면 이 분기가 "성공"으로 오판해 KV를 지워버려, 그 진짜 위반 제보가
  // 캡처도 텔레그램 알림도 manifest 기록도 없이 조용히 영구 소실되고
  // 제보자에게는 "제보가 접수되었습니다"만 보였다. 이제 봇이 응답 바디에
  // 실어 보내는 started 필드까지 확인해, 실제로 캡처가 시작된 경우에만
  // KV를 지운다 — 건너뛴 경우는 KV를 그대로 남겨 안전망 폴링이 나중에
  // (그 사이 기존 캡처가 끝나 thread_id가 비면) 다시 시도하게 한다.
  const pushed = await proxyToBotDashboard(env, "/reports/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  });
  if (pushed && pushed.started) {
    await reportQueue.fetch("https://do/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  }

  return json({ ok: true }, 200, origin);
}

// 20분 쿨다운이 걸려 있는(=최근 제보가 접수된) 대상 목록을 반환한다.
// 참여자들이 이 목록을 함께 볼 수 있어야 "이미 제보됐구나"를 알고 굳이
// 새로 제보하지 않는다(어차피 handleReport가 429로 막지만, 그 전에
// 눈으로 미리 확인시켜 헛수고를 줄이는 목적). 로그인만 되어 있으면
// 누구나 조회할 수 있다(제보 자체가 로그인 사용자면 누구나 가능하므로).
export async function handleListActiveCooldowns(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const isAdmin = (session.email || "").toLowerCase() === (env.ADMIN_EMAIL || "").toLowerCase();

  // 🔧 [KV → DO 이전, 2026-09-11] list() 대신(원래도 이미 인덱스 방식이었지만,
  // 이제 그 인덱스 자체가 KV가 아니라) ParticipantsRoster DO의 메모리
  // 상태를 읽는다 — 15초 폴링이 몇 명이든 KV를 전혀 안 거친다.
  const rawItems = await listReportCooldowns(env);
  // 🔧 [버그 수정] 셀프 체크 항목도 이제 이 목록에 들어오지만(사용자
  // 지시: 본인이 자신의 진행 상황을 볼 수 있어야 함), "최근 진행된
  // 제보"는 전체 참여자에게 공개되는 목록이라 그대로 노출하면 다른
  // 사람에게도 "OOO이 셀프 체크했다"가 보이는 부작용이 있다 — 요청자
  // 본인의 셀프 체크이거나 관리자 본인이 조회하는 경우에만 통과시키고,
  // 다른 사람의 셀프 체크 항목은 걸러낸다(사용자 결정: "자기랑
  // 관리자한테만 노출"). 일반 제보(selfCheck: false)는 지금까지처럼
  // 누구에게나 보인다.
  const items = rawItems
    .filter((item) => !item.selfCheck || isAdmin || item.reporterEmail === session.email)
    .map(({ cooldownKey, selfCheck, reporterEmail, ...rest }) => rest);
  items.sort((a, b) => a.expiresAt - b.expiresAt);
  return json({ items }, 200, origin);
}

// 봇이 실제 캡처(스크린샷/영상)를 끝낸 시점을 알려준다 — 참여자 명단
// 동기화(roster_sync.py)와 동일하게 봇→Worker POST + X-Bot-Secret 인증
// 패턴을 그대로 따른다. id를 못 찾거나 이미 만료된 쿨다운이어도 조용히
// ok:true만 반환한다(쿨다운 자체의 정상 동작에는 영향이 없으므로).
export async function handleReportCaptureDone(req, env, origin) {
  const botSecret = req.headers.get("X-Bot-Secret");
  if (!botSecret || botSecret !== env.BOT_SECRET) {
    return json({ error: "unauthorized" }, 401, origin);
  }
  const { id } = await req.json().catch(() => ({}));
  if (!id) return json({ error: "id가 필요합니다." }, 400, origin);
  // 🔧 [KV → DO 이전, 2026-09-11] cooldown: KV TTL 재기입 + 인덱스 갱신
  // 두 단계였던 걸 DO 호출 하나로 대체(§ParticipantsRoster
  // /report-cooldown/capture-done).
  await markReportCaptureDone(env, id, Date.now());
  return json({ ok: true }, 200, origin);
}

export async function handleListReports(req, env, origin) {
  const botSecret = req.headers.get("X-Bot-Secret");
  if (!botSecret || botSecret !== env.BOT_SECRET) {
    return json({ error: "unauthorized" }, 401, origin);
  }

  const res = await getReportQueueStub(env).fetch("https://do/drain", { method: "POST" });
  const { items } = await res.json();
  return json(items, 200, origin);
}

// 🔧 [버그 수정] 안전망 폴링(report_intake.py의 _poll_and_start_captures,
// 10분 간격) 경로는 handleListReports가 GET /reports 호출 즉시 KV의
// report:{id}를 무조건 지운 뒤 봇에 넘긴다. 그런데 그 시점에 같은 대상에
// 대한 다른 캡처가 여전히 진행 중이면(set_thread가 조용히 건너뜀,
// started=false) 이 항목은 Worker KV에도 없고 봇도 처리하지 않은 채로
// 영구 소실됐다 — 즉시 푸시 경로(handleReport)의 "started 확인 후에만 KV
// 삭제" 안전장치는 이 안전망 경로 자체에는 적용되지 않는 구조적 한계였다.
// 봇이 안전망 폴링에서도 started=false를 받으면 이 엔드포인트로 그 entry를
// 되돌려 보내, 다음 안전망 주기(10분 뒤)에 다시 시도할 수 있게 한다.
// 원래 접수 시각(entry.ts) 기준 REPORT_TTL_SEC가 이미 지났으면 재등록하지
// 않는다 — 무한정 스킵되는 항목이 TTL 없이 영원히 되살아나는 것을 막는다.
export async function handleRequeueReport(req, env, origin) {
  const botSecret = req.headers.get("X-Bot-Secret");
  if (!botSecret || botSecret !== env.BOT_SECRET) {
    return json({ error: "unauthorized" }, 401, origin);
  }
  const entry = await req.json().catch(() => null);
  if (!entry || !entry.id || !entry.ts) {
    return json({ error: "잘못된 요청입니다." }, 400, origin);
  }
  const remainingSec = Math.floor((entry.ts + REPORT_TTL_SEC * 1000 - Date.now()) / 1000);
  if (remainingSec <= 0) {
    // 원래 접수로부터 이미 TTL이 다 지났다 — 더는 재시도 가치가 없다.
    return json({ ok: true, requeued: false }, 200, origin);
  }
  // 🔧 [KV → DO 이전, 2026-09-12] DO에는 KV expirationTtl 같은 강제
  // 최솟값이 없지만, TTL 만료 직전(60초 미만 남음)이어도 다음 안전망
  // 주기(10분 뒤)까지는 버티도록 기존과 동일하게 최소 60초를 보장한다.
  await getReportQueueStub(env).fetch("https://do/put", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entry, ttlSec: Math.max(remainingSec, 60) }),
  });
  return json({ ok: true, requeued: true }, 200, origin);
}

// 🔧 [비용 절감, 2026-09-11] nextOccurrence/weeklyMinorPenaltyCount는
// 프론트에서 "penalty?.occurrence ?? nextOccurrence"(확정)/
// "deferredOccurrence ?? nextOccurrence"(유예) 형태로 쓰인다 — 즉 이미
// 확정 시점 스냅샷이 있는 건(approved/deferred)은 그 스냅샷을 우선하고,
// nextOccurrence는 **아직 pending이라 스냅샷이 없는 건에서만** 실제로
// 화면에 쓰인다(반려는 페널티 자체가 없어 애초에 안 씀 — 프론트 코드
// 확인 완료). pending 건이 하나도 없는 배치는 penSlotGrid:/penCycle: 조회
// 자체를 건너뛴다 — reporterName은 pending 여부와 무관하게 관리자 화면이
// 확정 건에도 표시하므로 members:(이미 2시간 캐시)는 그대로 조회한다.
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
const OUTPUT_PEN_P_SLOTS = new Set(["I", "K"]); // 4차, 6차
// 제보상점 1~5차 슬롯(R~V) — getReportScore가 읽기 전용으로만 쓰던 범위를
// applyReportMerit(쓰기)에서도 그대로 재사용한다. 값=발생 시점의 페널티
// 사이클 번호(D25)로, OUTPUT_PEN_SLOT_COLUMNS와 동일한 기록 방식이다.
const REPORT_MERIT_SLOT_COLUMNS = ["R", "S", "T", "U", "V"]; // 1차..5차
// "D"~"I" 열 문자를 0-idx 컬럼 인덱스로 변환한다(batchUpdate의 grid 좌표는
// 이름이 아니라 숫자 인덱스를 요구한다). A=0.
function columnLetterToIndex(letter) {
  return letter.toUpperCase().charCodeAt(0) - "A".charCodeAt(0);
}

// 셀에 주석(note)을 남긴다 — spreadsheets.values API는 note를 다루지 못해
// batchUpdate의 updateCells(fields: "note")를 써야 한다.
async function writeCellNote(env, accessToken, fileId, sheetId, rowIndex, colLetter, note) {
  await spreadsheetBatchUpdate(env, accessToken, fileId, [
    {
      updateCells: {
        range: {
          sheetId,
          startRowIndex: rowIndex,
          endRowIndex: rowIndex + 1,
          startColumnIndex: columnLetterToIndex(colLetter),
          endColumnIndex: columnLetterToIndex(colLetter) + 1,
        },
        rows: [{ values: [{ note }] }],
        fields: "note",
      },
    },
  ]);
}

// "HH:MM" 문자열 두 개(발신/회신)의 차이를 분 단위로 계산한다. 회신이
// 발신보다 이르면(자정을 넘긴 경우) 24시간을 더해 보정한다.
function minutesBetween(sendTime, replyTime) {
  const parse = (t) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec((t || "").trim());
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  };
  const send = parse(sendTime);
  const reply = parse(replyTime);
  if (send === null || reply === null) return null;
  let diff = reply - send;
  if (diff < 0) diff += 24 * 60;
  return diff;
}

// 화각 요청 회신 지연(20분 초과분)을 개인 탭 27행(보정 학습시간)의 발생
// 요일 칸에 "-HH:MM"으로 차감 기록한다. 기존값에 그대로 더해 누적한다
// (구루미 오류 보정 가산시간 등 다른 보정과 공존해야 하기 때문).
const TIME_DEDUCT_GRACE_MINUTES = 20;
const TIME_DEDUCT_ROW = 27;

function formatSignedHHMM(totalMinutes, sign) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// 개인 탭 27행의 dayCol 칸에 있는 기존 값(HH:MM/+HH:MM/-HH:MM)을 분 단위로
// 파싱한다. 비어 있으면 0.
function parseSignedHHMM(raw) {
  const m = /^([+-]?)(\d{1,3}):(\d{2})$/.exec((raw || "").trim());
  if (!m) return 0;
  const minutes = parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
  return m[1] === "-" ? -minutes : minutes;
}

async function applyTimeDeduction(env, accessToken, fileId, memberNumber, ts, sendTime, replyTime) {
  const diffMinutes = minutesBetween(sendTime, replyTime);
  if (diffMinutes === null || diffMinutes <= TIME_DEDUCT_GRACE_MINUTES) {
    return { deductedMinutes: 0, dayCol: null };
  }
  const overMinutes = diffMinutes - TIME_DEDUCT_GRACE_MINUTES;
  const dayIndex = (new Date(ts).getDay() + 6) % 7; // 월=0 ... 일=6
  const dayCol = colIndexToLetter(STATUS_DAY_COLS[dayIndex]);
  const row = parseInt(memberNumber, 10) + 3;
  const cell = `${memberNumber}!${dayCol}${TIME_DEDUCT_ROW}`;

  const existingRows = await getSheetValues(env, accessToken, fileId, cell);
  const existingMinutes = parseSignedHHMM(existingRows[0] && existingRows[0][0]);
  const newMinutes = existingMinutes - overMinutes;
  const newValue = newMinutes === 0 ? "" : formatSignedHHMM(Math.abs(newMinutes), newMinutes < 0 ? "-" : "+");

  await writeSheetValues(env, accessToken, fileId, [{ range: cell, values: [[newValue]] }]);
  return { deductedMinutes: overMinutes, dayCol, row };
}

// 화각 제보 승인 시 "송출 P" 탭에 다음 차수를 기록한다. 사이클(D25)이 넘어가도
// 리셋하지 않고 이어서 센다 — 6차(송출P 2회)에 도달하면 예치금 재납으로 회원
// 행 자체가 초기화되는 게 유일한 리셋 지점이라, 여기서 별도로 주기 관리를
// 하지 않는다. 각 칸에는 그 위반이 발생한 시점의 D25 값을 기록용으로만 남긴다.
// reason/ts: 승인 대상 제보의 사유 텍스트와 발생 시각(ISO 문자열) — 셀 값
// 자체(사이클 번호)는 그대로 두고, 같은 칸에 주석(note)으로 "발생 시점 ·
// 사유"를 함께 남겨 나중에 상세 조회 시 근거를 보여줄 수 있게 한다.
// sendTime/replyTime: 관리자가 입력한 화각 요청 발신·회신 시각(HH:MM) —
// 20분 초과 지연분을 개인 탭 27행(보정 학습시간)에서 차감한다.
// 🔧 [버그 수정] "빈 슬롯 찾기 → 쓰기"는 락 없이 실행하면 같은 대상자에게
// 밀린 제보 여러 건을 관리자가 짧은 시간 안에 연속 승인할 때(백로그 정리 시
// 흔한 패턴) 두 요청이 같은 빈 슬롯을 읽어 하나가 조용히 덮어써지는
// 레이스가 있었다. withMemberLock으로 닉네임(대상자)별 임계구역을 감싸
// 동일 대상자에 대한 슬롯 배정은 항상 순차 실행되도록 한다.
async function applyOutputPenalty(env, accessToken, fileId, nickname, reason, ts, sendTime, replyTime, captureId) {
  return withMemberLock(env, `pen:${nickname}`, async () => {
    // 🔧 [members: TTL 2시간 상향 대응, 2026-09-11] 닉네임→번호 확정이 여기서
    // 벌점 슬롯에 실제로 기록되는 결정적 순간이다 — 번호가 재사용된 회원이
    // 있는데 members:가 낡아있으면 엉뚱한 회원에게 벌점이 적힐 수 있어,
    // 조회 직전에 좁은 그룹(members+dataSheetRows)만 무효화해 무조건 방금
    // 확인한 최신 명단으로 계산되게 한다(하루 승인 10건 미만이라 이 무효화
    // 추가 비용은 무시할 수준).
    await invalidateMemberCache(env, ["memberIdentity"], fileId);
    const [members, sheetId] = await Promise.all([
      listAllMembers(env, accessToken, fileId),
      getSheetIdByName(env, accessToken, fileId, OUTPUT_PEN_SHEET_NAME),
    ]);
    const member = members.find((m) => m.name === nickname);
    if (!member) {
      throw new Error(`"${nickname}" 이름과 일치하는 등록 회원을 찾을 수 없습니다.`);
    }
    const row = parseInt(member.number, 10) + 3;

    const [slotRows, currentD25] = await Promise.all([
      getSheetValues(env, accessToken, fileId, `'${OUTPUT_PEN_SHEET_NAME}'!F${row}:K${row}`),
      getCurrentPenCycle(env, accessToken, fileId),
    ]);
    const slotValues = (slotRows[0] || []).map((v) => parseInt(v, 10) || 0);

    // 값이 0인(=아직 안 채워진) 첫 칸을 찾는다.
    let slotIndex = -1;
    for (let i = 0; i < OUTPUT_PEN_SLOT_COLUMNS.length; i++) {
      if (slotValues[i] === 0) {
        slotIndex = i;
        break;
      }
    }
    if (slotIndex === -1) {
      // 사용자 확인: 6차(송출P 2회)에서 예치금 재납으로 기록이 초기화되므로
      // 정상 운영에서는 이 지점에 도달할 수 없다 — 도달하면 조용히 넘기지 않고 알린다.
      throw new Error(`${nickname}님은 1차~6차 칸이 모두 채워져 있습니다. 예치금 재납 처리가 필요할 수 있습니다.`);
    }

    const col = OUTPUT_PEN_SLOT_COLUMNS[slotIndex];
    const occurrence = slotIndex + 1; // 1차~6차
    const isPCount = OUTPUT_PEN_P_SLOTS.has(col);

    const writes = [writeSheetValues(env, accessToken, fileId, [
      { range: `'${OUTPUT_PEN_SHEET_NAME}'!${col}${row}`, values: [[currentD25]] },
    ])];
    // 🔧 [사유·발생일시·캡처ID 주석] 1~6차 모든 슬롯에 동일하게
    // "발생일시 · 사유 [cap:캡처ID]"를 남긴다 — reason이 비어 있어도 발생일시만이라도
    // 기록해 추적 가능하게 한다. 캡처ID는 " · "가 아니라 "[cap:...]" 대괄호
    // 표기로 맨 끝에 붙인다 — reason 자체가 관리자/봇이 자유 입력한 텍스트라
    // " · "를 포함할 수 있어, 같은 구분자로 세 번째 필드를 나누면 오파싱
    // 위험이 있기 때문이다. "예치금 재납 대상자" 카드에서 이 이력을 눌렀을 때
    // 봇이 보관 중인 원본 스크린샷·영상을 다시 불러오는 데 쓴다.
    if (sheetId !== null) {
      // 🔧 [타임존 버그] toLocaleString("ko-KR")은 표기 형식만 한국식일 뿐
      // 타임존은 Worker 실행 환경(UTC)을 그대로 쓴다 — timeZone을 명시해야
      // 실제 한국 시각으로 기록된다.
      const whenDate = ts ? new Date(ts) : new Date();
      const when = whenDate.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
      let note = reason ? `${when} · ${reason}` : when;
      if (captureId) note += ` [cap:${captureId}]`;
      writes.push(writeCellNote(env, accessToken, fileId, sheetId, row - 1, col, note));
    }
    await Promise.all(writes);

    const timeDeduction = await applyTimeDeduction(env, accessToken, fileId, member.number, ts, sendTime, replyTime);

    // 🔧 [이번 주 영향 스냅샷] "이번 주 영향"(weeklyMinorPenaltyCount ×
    // 0.1점)은 attachNextOccurrence가 GET 시점마다 다시 계산하는 값이라,
    // 이 건이 확정된 뒤 같은 대상자의 다른 건이 추가로 처리되면 계속
    // 달라진다(사용자 지적: "적용하고 나니까 -0.1점에서 -0.2점으로 바뀐다"
    // — 다음 pending 건 기준으로 재계산된 예측값을 계속 보여준 것이 원인).
    // 이 건이 실제로 확정된 시점의 값을 여기서 직접 계산해 응답에 실어
    // manifest에 저장해 두면, 이후 몇 번을 다시 조회하든 그 시점 값 그대로
    // 고정 표시할 수 있다. slotValues는 방금 쓴 슬롯이 반영되기 전 상태이므로
    // 이 건 자신의 슬롯(occurrence)도 2/3/5차면 카운트에 더한다.
    const isMinorSlot = occurrence === 2 || occurrence === 3 || occurrence === 5;
    const weeklyMinorPenaltyCount =
      [1, 2, 4].filter((idx) => slotValues[idx] === currentD25).length + (isMinorSlot ? 1 : 0);

    return {
      number: member.number,
      name: member.name,
      occurrence,
      isPCount,
      col,
      deductedMinutes: timeDeduction.deductedMinutes,
      dayCol: timeDeduction.dayCol,
      weeklyMinorPenaltyCount,
    };
  });
}

// 제보 승인("적용"/"반려 (인정)") 시 제보자에게 제보상점을 부여한다 —
// applyOutputPenalty와 완전히 동일한 패턴(값 0인 첫 칸을 찾아 현재 페널티
// 사이클 번호를 쓰고, 같은 칸에 발생일시·사유를 주석으로 남김)을 "데이터"
// 시트 R~V(제보상점 1~5차)에 그대로 적용한다. 5칸이 모두 차 있으면(정상
// 운영에서는 도달하지 않아야 함) applyOutputPenalty와 동일하게 조용히
// 넘기지 않고 명시적 에러를 던진다.
async function applyReportMerit(env, accessToken, fileId, reporterEmail, reason, ts, captureId) {
  return withMemberLock(env, `merit:${(reporterEmail || "").toLowerCase()}`, async () => {
    // 🔧 [members: TTL 2시간 상향 대응, 2026-09-11] applyOutputPenalty와 동일한
    // 이유 — 제보자 이메일→번호 확정이 여기서 상점 슬롯에 실제로 기록되는
    // 결정적 순간이라, 조회 직전에 좁은 그룹만 무효화해 최신 명단을 보장한다.
    await invalidateMemberCache(env, ["memberIdentity"], fileId);
    const [members, sheetId] = await Promise.all([
      listAllMembers(env, accessToken, fileId),
      getSheetIdByName(env, accessToken, fileId, OUTPUT_PEN_SHEET_NAME),
    ]);
    const reporter = members.find((m) => m.email.toLowerCase() === (reporterEmail || "").toLowerCase());
    if (!reporter) {
      throw new Error(`제보자(${reporterEmail || "이메일 없음"})와 일치하는 등록 회원을 찾을 수 없습니다.`);
    }
    const row = parseInt(reporter.number, 10) + 3;

    const [slotRows, currentD25] = await Promise.all([
      getSheetValues(env, accessToken, fileId, `'${OUTPUT_PEN_SHEET_NAME}'!R${row}:V${row}`),
      getCurrentPenCycle(env, accessToken, fileId),
    ]);
    const slotValues = (slotRows[0] || []).map((v) => parseInt(v, 10) || 0);

    let slotIndex = -1;
    for (let i = 0; i < REPORT_MERIT_SLOT_COLUMNS.length; i++) {
      if (slotValues[i] === 0) {
        slotIndex = i;
        break;
      }
    }
    if (slotIndex === -1) {
      throw new Error(`${reporter.name}님은 제보상점 1차~5차 칸이 모두 채워져 있습니다.`);
    }

    const col = REPORT_MERIT_SLOT_COLUMNS[slotIndex];
    const occurrence = slotIndex + 1; // 1차~5차

    const writes = [writeSheetValues(env, accessToken, fileId, [
      { range: `'${OUTPUT_PEN_SHEET_NAME}'!${col}${row}`, values: [[currentD25]] },
    ])];
    if (sheetId !== null) {
      const whenDate = ts ? new Date(ts) : new Date();
      const when = whenDate.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
      let note = reason ? `${when} · ${reason}` : when;
      if (captureId) note += ` [cap:${captureId}]`;
      writes.push(writeCellNote(env, accessToken, fileId, sheetId, row - 1, col, note));
    }
    await Promise.all(writes);

    return { number: reporter.number, name: reporter.name, occurrence, col };
  });
}

// applyOutputPenalty()가 방금 기록한 슬롯을 되돌린다 — 관리자가 오적용을
// 바로잡을 수 있게 하는 상시 기능. 값(사이클 번호)과 주석을 모두 지운다.
// col은 승인 응답에 포함된 실제 기록 열(F~K)을 그대로 넘겨받아 사용한다.
// deductedMinutes/dayCol이 있으면(회신 지연으로 시간 차감이 함께 기록됐던
// 경우) 27행의 그 요일 칸에서도 동일한 분만큼 되돌린다.
// applyTimeDeduction()이 개인 탭 27행에 기록한 지연 차감분을 되돌린다
// (cancelOutputPenalty의 시간 차감 되돌림 부분과 동일 로직 — "유예 취소"
// (revert)처럼 슬롯 자체는 없이 시간 차감만 되돌려야 하는 경우를 위해
// 분리했다).
async function cancelTimeDeduction(env, accessToken, fileId, memberNumber, deductedMinutes, dayCol) {
  if (!(deductedMinutes > 0) || !dayCol) return;
  const cell = `${memberNumber}!${dayCol}${TIME_DEDUCT_ROW}`;
  const existingRows = await getSheetValues(env, accessToken, fileId, cell);
  const existingMinutes = parseSignedHHMM(existingRows[0] && existingRows[0][0]);
  const restoredMinutes = existingMinutes + deductedMinutes;
  const newValue = restoredMinutes === 0 ? "" : formatSignedHHMM(Math.abs(restoredMinutes), restoredMinutes < 0 ? "-" : "+");
  await writeSheetValues(env, accessToken, fileId, [{ range: cell, values: [[newValue]] }]);
}

async function cancelOutputPenalty(env, accessToken, fileId, memberNumber, col, deductedMinutes, dayCol) {
  if (!OUTPUT_PEN_SLOT_COLUMNS.includes(col)) {
    throw new Error(`유효하지 않은 열입니다: ${col}`);
  }
  const row = parseInt(memberNumber, 10) + 3;
  const sheetId = await getSheetIdByName(env, accessToken, fileId, OUTPUT_PEN_SHEET_NAME);

  const writes = [writeSheetValues(env, accessToken, fileId, [
    { range: `'${OUTPUT_PEN_SHEET_NAME}'!${col}${row}`, values: [[0]] },
  ])];
  if (sheetId !== null) {
    writes.push(writeCellNote(env, accessToken, fileId, sheetId, row - 1, col, null));
  }
  writes.push(cancelTimeDeduction(env, accessToken, fileId, memberNumber, deductedMinutes, dayCol));
  await Promise.all(writes);
}

// applyReportMerit()가 방금 기록한 제보상점 슬롯을 되돌린다(cancelOutputPenalty와
// 동일 패턴 — 값과 주석만 지우면 되므로 시간 차감 되돌림은 없다). "폐기"가
// handleAdminCaptureDelete 경로를 재사용할 때, 이미 "적용"/"반려 (인정)"으로
// 제보상점이 기록된 항목이면 함께 원상복구하는 데 쓰인다.
async function cancelReportMerit(env, accessToken, fileId, memberNumber, col) {
  if (!REPORT_MERIT_SLOT_COLUMNS.includes(col)) {
    throw new Error(`유효하지 않은 열입니다: ${col}`);
  }
  const row = parseInt(memberNumber, 10) + 3;
  const sheetId = await getSheetIdByName(env, accessToken, fileId, OUTPUT_PEN_SHEET_NAME);

  const writes = [writeSheetValues(env, accessToken, fileId, [
    { range: `'${OUTPUT_PEN_SHEET_NAME}'!${col}${row}`, values: [[0]] },
  ])];
  if (sheetId !== null) {
    writes.push(writeCellNote(env, accessToken, fileId, sheetId, row - 1, col, null));
  }
  await Promise.all(writes);
}

export async function handleAdminCaptureCancel(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { number, col, deductedMinutes, dayCol, sourceFileId } = await req.json().catch(() => ({}));
  if (!number || !col) {
    return json({ error: "number와 col이 필요합니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — 실제로
    // 벌점을 쓴 파일(sourceFileId, handleAdminCaptureDecide 응답으로
    // 프론트가 들고 있음)에서 취소해야 한다. 없으면(옛 클라이언트 등)
    // 원본으로 폴백한다.
    const fileId = sourceFileId || env.GOOGLE_SHEET_FILE_ID;
    await cancelOutputPenalty(env, accessToken, fileId, number, col, deductedMinutes || 0, dayCol || null);
    // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — 캐시
    // 무효화도 실제로 쓴 fileId를 넘겨야 한다. 생략하면 항상
    // env.GOOGLE_SHEET_FILE_ID(원본)만 지워져, fileId가 지난 사이클
    // 백업이었을 때 그 백업의 캐시(exitStatus/personalStatusBundle 등)
    // 가 최대 TTL만큼 갱신되지 않는다.
    await invalidateMemberCache(env, ["penalty"], fileId); // 페널티 슬롯이 바뀌었으므로 관련 캐시만 무효화.
    await invalidateMemberSlotCache(env, number, fileId); // 이 회원의 outputPenSlots/reportScore는 KV까지 즉시.
    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "취소 실패: " + err.message }, 500, origin);
  }
}

// applyReportMerit()로 부여한 제보상점을 되돌린다(handleAdminCaptureCancel과
// 동일 패턴, cancelReportMerit 재사용) — "적용"/"페널티 적용 (불가)"로
// 처리된 항목의 "취소" 버튼이 대상자 페널티와 별개로 호출한다.
export async function handleAdminCaptureCancelMerit(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { number, col, sourceFileId } = await req.json().catch(() => ({}));
  if (!number || !col) {
    return json({ error: "number와 col이 필요합니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = sourceFileId || env.GOOGLE_SHEET_FILE_ID;
    await cancelReportMerit(env, accessToken, fileId, number, col);
    await invalidateMemberCache(env, ["penalty"], fileId); // 제보상점 슬롯이 바뀌었으므로 관련 캐시만 무효화.
    await invalidateMemberSlotCache(env, number, fileId); // 이 회원의 outputPenSlots/reportScore는 KV까지 즉시.
    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "취소 실패: " + err.message }, 500, origin);
  }
}

// 🔧 [3버튼 재설계 → 유예 추가] 결정 종류:
// - "approved" : 페널티로 인정되며 대상자 슬롯에 여유가 있음
//     → 제보자에게 제보상점 추가(applyReportMerit) + 대상자에게 벌점/페널티 추가(applyOutputPenalty).
// - "rejected_recognized" : 페널티로 인정되나 대상자 잔여 슬롯이 없어 등록 불가
//     → 제보자에게 제보상점만 추가, 대상자에게는 아무 처리도 하지 않음.
//     (프론트: "송출 P 적용 (불가)" 버튼이 이 decision을 보낸다 — 사용자 지시로
//     별도 "반려 (인정)" 버튼을 만들지 않고 "적용" 버튼의 동적 라벨/동작으로 흡수했다.)
// - "deferred" : 페널티로 인정되나, 대상자가 "당일 이미 1회 적용을 받아" 이후
//     최대 2건은 적용을 미룬다(사용자 지시 — "유예"). rejected_recognized와
//     처리 자체(제보자 상점만 부여, 대상자 처리 없음)는 동일하지만, "왜
//     대상자 처리를 안 했는지" 사유가 다르므로(잔여 슬롯 없음 vs 당일 1회
//     제한) 별도 decision 값으로 구분한다 — 나중에 "몇 번째 유예인지"를
//     추적해 "다음 적용"으로 재개할 시점을 판단하려면 이 구분이 필요하다.
// - "rejected" : 페널티로 인정되지 않음 → 아무 처리도 하지 않음(웹에는 계속 표시).
// "폐기"는 새 decision이 아니라 기존 handleAdminCaptureDelete(완전 삭제) 경로를
// 그대로 재사용한다(사용자 확정) — 여기서는 다루지 않는다.
const CAPTURE_DECISIONS = ["approved", "rejected_recognized", "deferred", "rejected"];

// 🔧 [제보상점 1일 1회 제한] 제보자는 하루에 최대 1회만 제보상점을 받을 수
// 있다(주간 5회 상한과 별개, 사용자 지시). "당일"은 실제로 시트에 상점이
// 반영된 시각(decidedAt) 기준 KST 날짜로 판정한다 — 제보 접수 시각(ts)
// 기준으로 하면, 예를 들어 어제 접수됐지만 오늘 관리자가 처리한 건이
// "어제 이미 받음"으로 잘못 카운트되는 문제가 있다(사용자 지적: "실제로
// 유예나 적용을 통해 시트에 적용된 경우에만 당일 1회를 받은 걸로 인식").
// 봇 manifest 전체(당일 판정이라 archive까지 볼 필요는 없음)에서 같은
// 제보자(reporterEmail)·같은 결정일(decidedAt의 KST 날짜)에 이미 성공한
// (merit이 error가 아닌) 건이 있는지 확인한다.
async function hasReporterAlreadyReceivedMeritToday(env, reporterEmail, nowTs) {
  const email = (reporterEmail || "").toLowerCase();
  if (!email) return false;
  const data = await proxyToBotDashboard(env, "/captures");
  const items = (data && data.items) || [];
  const todayKey = kstDateKey(nowTs);
  return items.some(
    (it) =>
      (it.reporterEmail || "").toLowerCase() === email &&
      it.merit &&
      !("error" in it.merit) &&
      it.decidedAt &&
      kstDateKey(it.decidedAt) === todayKey
  );
}

// 🔧 [유예/반려 차수 스냅샷] "지금 적용했다면 몇 차였을지"를 결정 시점에
// 직접 읽어 고정한다 — item.nextOccurrence는 GET 시점마다 재계산되는 값이라,
// 유예나 반려로 확정된 뒤 다른 건이 실제로 그 슬롯을 채우면(예: 다음 건이
// "확정"되어 2차가 채워지면) 이미 확정된 이 건의 표시 차수도 밀려 보였다
// (사용자 재현: "2차가 확정되니 앞의 유예 1차·2차가 모두 3차로 바뀜" — 반려도
// 동일 구조라 사용자 확인 후 함께 적용). nickname으로 회원을 못 찾으면 null.
async function snapshotNextOccurrence(env, accessToken, fileId, nickname) {
  if (!nickname) return null;
  const member = (await listAllMembers(env, accessToken, fileId)).find((m) => m.name === nickname);
  if (!member) return null;
  const row = parseInt(member.number, 10) + 3;
  const slotRows = await getSheetValues(env, accessToken, fileId, `'${OUTPUT_PEN_SHEET_NAME}'!F${row}:K${row}`);
  const slotValues = (slotRows[0] || []).map((v) => parseInt(v, 10) || 0);
  const slotIndex = slotValues.findIndex((v) => v === 0);
  return slotIndex === -1 ? null : slotIndex + 1;
}

export async function handleAdminCaptureDecide(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { id, decision, nickname, reporterEmail, reason, ts, sendTime, replyTime } = await req.json().catch(() => ({}));
  if (!id || !CAPTURE_DECISIONS.includes(decision)) {
    return json({ error: "잘못된 요청입니다." }, 400, origin);
  }

  // 🔧 [버그 수정] 여기서 시트에 쓰기 전까지 이 capture id가 아직
  // "pending"인지 확인하는 코드가 없었다 — 첫 결정 요청이 시트 반영(수백ms
  // ~봇 프록시 타임아웃 8초)을 마치고 봇 manifest를 approved로 갱신하기
  // 전 사이, 관리자가 응답이 느려 답답해서 새로고침하면 GET /admin/captures가
  // 아직 pending인 스냅샷을 보여줘 "적용"/"반려" 버튼이 다시 뜬다. 여기서
  // 다시 누르면 같은 캡처에 벌점/제보상점 슬롯이 두 번 채워졌다. 시트에
  // 쓰기 직전 봇 manifest의 현재 상태를 한 번 더 확인해, 이미 pending이
  // 아니면(이미 처리됨) 거부한다.
  const currentStatus = await fetchCaptureReviewStatus(env, id);
  if (currentStatus !== null && currentStatus !== "pending") {
    return json({ error: "이미 처리된 제보입니다. 새로고침 후 확인해주세요." }, 409, origin);
  }

  let penaltyResult = null;
  let meritResult = null;
  let timeDeductionResult = null;
  let deferredOccurrenceSnapshot = null;
  // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — 아래 모든
  // 분기(승인/유예/반려 포함)가 이 하나의 fileId를 공유한다. ts가 속한
  // 주가 이번 주면 원본 그대로, 아니면 그 주의 백업 파일로 판정된다.
  let accessTokenForSource, sourceFileId;
  try {
    accessTokenForSource = await getServiceAccountAccessToken(env);
    ({ sourceFileId } = await resolveCaptureSourceFileId(
      env,
      accessTokenForSource,
      env.GOOGLE_SHEET_FILE_ID,
      ts
    ));
  } catch (err) {
    return json({ error: "제보 사이클 판정 실패: " + err.message }, 500, origin);
  }
  if (decision === "approved" || decision === "rejected_recognized" || decision === "deferred") {
    try {
      const accessToken = accessTokenForSource;
      const fileId = sourceFileId;

      if (decision === "approved") {
        if (!nickname) return json({ error: "nickname이 필요합니다." }, 400, origin);
        penaltyResult = await applyOutputPenalty(env, accessToken, fileId, nickname, reason, ts, sendTime, replyTime, id);
      } else if (decision === "deferred") {
        // 🔧 [유예도 응답 지연 시간 차감] "유예"는 당일 이미 1회 적용을 받아
        // 벌점/송출P 슬롯만 면제될 뿐, 화각 요청에 늦게 응답한 사실 자체는
        // 그대로 남는다(사용자 지시: "제보 확인 자체를 늦게 해서 엉망인
        // 화각으로 다른 사람에게 피해를 끼치는" 문제와 벌점 면제는 별개).
        // applyOutputPenalty(슬롯 채우기)는 건너뛰되, 그 안에서만 호출되던
        // applyTimeDeduction을 여기서 독립적으로 호출해 20분 초과 지연분을
        // 그대로 개인 탭 27행에서 차감한다. "송출 P 적용 (불가)"
        // (rejected_recognized, 잔여 슬롯 없음)는 이번 지시 범위 밖이라
        // 그대로 둔다(사용자 확인).
        if (nickname) {
          const member = (await listAllMembers(env, accessToken, fileId)).find((m) => m.name === nickname);
          if (member) {
            const timeDeduction = await applyTimeDeduction(env, accessToken, fileId, member.number, ts, sendTime, replyTime);
            if (timeDeduction.deductedMinutes > 0) {
              timeDeductionResult = {
                number: member.number,
                deductedMinutes: timeDeduction.deductedMinutes,
                dayCol: timeDeduction.dayCol,
              };
            }
          }
        }
      }
      // 🔧 [유예/반려 차수 스냅샷] 벌점 슬롯을 실제로 채우지 않는 세 결정
      // (deferred/rejected_recognized — 아래 순수 rejected는 이 블록 밖에서
      // 별도 처리) 모두, 결정 시점의 빈 슬롯을 스냅샷으로 남긴다 — 그러지
      // 않으면 이후 다른 건이 실제로 그 슬롯을 채울 때 이미 확정된 이 건의
      // 표시 차수까지 밀려 보인다(사용자 재현, 반려도 함께 적용하기로 확인).
      if (decision === "deferred" || decision === "rejected_recognized") {
        deferredOccurrenceSnapshot = await snapshotNextOccurrence(env, accessToken, fileId, nickname);
      }
      const alreadyReceivedToday = await hasReporterAlreadyReceivedMeritToday(env, reporterEmail, Date.now());
      if (alreadyReceivedToday) {
        // 1일 1회 상한 — 대상자 페널티(있었다면)는 이미 반영됐으니 그대로
        // 두고, 제보상점만 조용히 건너뛴다(applyOutputPenalty와 동일하게
        // "조용히 넘기지 않는다" 원칙 — meritResult에 사유를 남긴다).
        meritResult = { error: "제보자가 오늘 이미 제보상점을 받아 1일 1회 상한으로 부여하지 않았습니다." };
      } else {
        try {
          meritResult = await applyReportMerit(env, accessToken, fileId, reporterEmail, reason, ts, id);
        } catch (meritErr) {
          // 제보자 상점 부여는 대상자 페널티와 별개 실패 지점이다(예: 제보자가
          // 회원 명단에 없거나 5칸이 이미 다 찼을 때) — 이미 시트에 반영된
          // 대상자 페널티까지 되돌리지 않고, 그 사실을 응답에 담아 관리자가
          // 알 수 있게만 한다(자동 롤백은 하지 않음 — applyOutputPenalty와
          // 동일하게 "조용히 넘기지 않는다" 원칙).
          meritResult = { error: meritErr.message };
        }
      }
      // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — sourceFileId
      // 를 넘겨야 한다. 생략하면 항상 원본만 지워져, sourceFileId가 지난
      // 사이클 백업이었을 때 그 백업의 캐시가 갱신되지 않는다.
      await invalidateMemberCache(env, ["penalty"], sourceFileId); // 페널티/제보상점 슬롯이 바뀌었으므로 관련 캐시만 무효화.
      // 대상자(penaltyResult)와 제보자(meritResult)는 서로 다른 회원일 수
      // 있다 — 둘 다 outputPenSlots/reportScore가 KV까지 즉시 지워지도록.
      if (penaltyResult?.number) await invalidateMemberSlotCache(env, penaltyResult.number, sourceFileId);
      if (meritResult?.number) await invalidateMemberSlotCache(env, meritResult.number, sourceFileId);
    } catch (err) {
      return json({ error: "시트 반영 실패: " + err.message }, 500, origin);
    }
  } else if (decision === "rejected") {
    // 🔧 [반려 차수 스냅샷] 순수 반려는 시트에 아무것도 쓰지 않지만(위 if
    // 블록 밖), 위 유예/반려(인정)와 동일하게 "지금 적용했다면 몇 차였을지"
    // 취소선 표시가 나중에 밀리지 않도록 결정 시점의 스냅샷을 남긴다. 시트를
    // 쓰지 않는 경로라 조회 실패는 조용히 무시(null 유지, nextOccurrence로
    // 폴백)해도 안전하다 — 반려 처리 자체를 막을 이유는 아니다.
    try {
      deferredOccurrenceSnapshot = await snapshotNextOccurrence(env, accessTokenForSource, sourceFileId, nickname);
    } catch {
      // 조회만 실패한 것 — 반려 처리는 계속 진행, 스냅샷 없이 nextOccurrence로 폴백.
    }
  }

  // penalty/merit/timeDeduction을 봇 manifest에도 함께 저장해 둔다 —
  // 관리자가 새로고침한 뒤에도 "반려 취소"/"폐기"가 무엇을 되돌려야
  // 하는지 프론트 로컬 state 없이 이 기록만으로 알 수 있게 하기 위함
  // (GET /admin/captures가 그대로 다시 내려준다).
  const data = await proxyToBotDashboard(env, "/captures/decide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      decision,
      penalty: penaltyResult,
      merit: meritResult,
      timeDeduction: timeDeductionResult,
      deferredOccurrence: deferredOccurrenceSnapshot,
      // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — 이후
      // 취소/삭제/되돌리기(handleAdminCaptureCancel 등)가 새로고침
      // 후에도(findStoredPenaltyMerit 폴백) 정확한 파일에서 롤백할
      // 수 있도록 manifest에도 함께 남긴다.
      sourceFileId,
    }),
  });
  if (!data) {
    // 🔧 [버그 수정] 원래는 여기서 502만 반환했다 — 그런데 위에서 이미
    // applyOutputPenalty/applyReportMerit로 시트에는 페널티/제보상점을
    // 써버린 뒤라, 봇 manifest 반영(이 호출)만 실패하면 시트에는 반영됐는데
    // manifest는 여전히 "pending"인 불일치가 생겼다. 관리자는 에러를 보고
    // 재시도할 수밖에 없는데, 그러면 같은 캡처가 다시 승인되어 슬롯이
    // 중복 소비되거나(재시도가 성공하는 경우), 첫 시도의 시트 기록이
    // manifest 어디에도 연결되지 않아 findStoredPenaltyMerit로도 찾을 수
    // 없는 고아 기록으로 영구히 남았다(폐기/반려취소로도 되돌릴 길이 없음).
    // 여기서 실패하면 방금 쓴 시트 기록을 즉시 되돌려, 재시도가 항상
    // "처음부터 다시"가 되도록 한다. 롤백도 반드시 같은 sourceFileId에서
    // 이뤄져야 한다 — 실제로 쓴 곳과 다른 파일에서 취소하면 엉뚱한 슬롯을
    // 건드리거나 아무 효과 없이 조용히 끝난다.
    if (penaltyResult && penaltyResult.number && penaltyResult.col) {
      try {
        await cancelOutputPenalty(
          env,
          accessTokenForSource,
          sourceFileId,
          penaltyResult.number,
          penaltyResult.col,
          penaltyResult.deductedMinutes || 0,
          penaltyResult.dayCol || null
        );
      } catch (rollbackErr) {
        return json(
          { error: `봇에 연결할 수 없고, 시트 롤백도 실패했습니다(수동 확인 필요: ${rollbackErr.message}).` },
          502,
          origin
        );
      }
    }
    if (meritResult && meritResult.number && meritResult.col) {
      try {
        await cancelReportMerit(env, accessTokenForSource, sourceFileId, meritResult.number, meritResult.col);
      } catch (rollbackErr) {
        return json(
          { error: `봇에 연결할 수 없고, 제보상점 롤백도 실패했습니다(수동 확인 필요: ${rollbackErr.message}).` },
          502,
          origin
        );
      }
    }
    if (timeDeductionResult && timeDeductionResult.number) {
      try {
        await cancelTimeDeduction(
          env,
          accessTokenForSource,
          sourceFileId,
          timeDeductionResult.number,
          timeDeductionResult.deductedMinutes || 0,
          timeDeductionResult.dayCol || null
        );
      } catch (rollbackErr) {
        return json(
          { error: `봇에 연결할 수 없고, 시간 차감 롤백도 실패했습니다(수동 확인 필요: ${rollbackErr.message}).` },
          502,
          origin
        );
      }
    }
    if (penaltyResult || meritResult || timeDeductionResult) {
      // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — 위
      // 롤백(cancelOutputPenalty 등)이 sourceFileId에서 이뤄졌으므로
      // 캐시 무효화도 같은 파일을 대상으로 해야 한다.
      await invalidateMemberCache(env, ["penalty"], sourceFileId);
      if (penaltyResult?.number) await invalidateMemberSlotCache(env, penaltyResult.number, sourceFileId);
      if (meritResult?.number) await invalidateMemberSlotCache(env, meritResult.number, sourceFileId);
    }
    return json({ error: "봇에 연결할 수 없습니다. 시트 반영은 자동으로 되돌렸으니 다시 시도해주세요." }, 502, origin);
  }
  return json(
    { ...data, penalty: penaltyResult, merit: meritResult, timeDeduction: timeDeductionResult, sourceFileId },
    200,
    origin
  );
}

// 특정 캡처 id에 저장된 penalty/merit을 찾는다 — 관리자가 새로고침해
// 프론트 로컬 state(applied[item.id])를 잃은 뒤에도
// handleAdminCaptureDelete/handleAdminCaptureRevert가 무엇을 되돌려야
// 하는지 알 수 있게 하는 폴백 조회다(handleAdminCaptureDecide가 결정
// 시점에 봇 manifest에도 함께 저장해 둔다).
// 🔧 [버그 수정] 원래는 GET /captures(원본 manifest 전체만, archive
// 미포함)에서 id를 찾았다 — archive_old_captures로 옮겨진(3주 이상 지난
// 확정) 캡처에 대해 관리자가 새로고침 후 "폐기"/"반려 취소"를 누르면
// penalty/merit을 못 찾아 시트에 반영된 벌점/제보상점을 되돌리지 못한 채
// 그대로 진행됐다. 봇의 get_capture는 이미 archive도 함께 조회하므로,
// 이를 그대로 노출하는 단건 조회(/captures/one)로 바꿔 항상 정확한
// penalty/merit을 찾을 수 있게 한다.
async function findStoredPenaltyMerit(env, id) {
  const data = await proxyToBotDashboard(env, `/captures/one?id=${encodeURIComponent(id)}`);
  const item = data && data.item;
  return {
    penalty: item?.penalty || null,
    merit: item?.merit || null,
    timeDeduction: item?.timeDeduction || null,
    // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — handleAdminCaptureDecide
    // 가 manifest에 함께 저장해둔 sourceFileId. 프론트가 이 값을 안 보내도
    // (새로고침 등) 여기서 폴백해 정확한 파일에서 롤백할 수 있게 한다.
    sourceFileId: item?.sourceFileId || null,
  };
}

// capture id의 봇 manifest상 현재 reviewStatus만 가볍게 조회한다
// (handleAdminCaptureDecide가 시트에 쓰기 전 중복 처리 방지에 사용).
async function fetchCaptureReviewStatus(env, id) {
  const data = await proxyToBotDashboard(env, `/captures/one?id=${encodeURIComponent(id)}`);
  const item = data && data.item;
  return item?.reviewStatus ?? null;
}

// 제보 기록 자체를 완전히 말소한다(반려 취소와 달리 되돌릴 수 없음, 웹
// 서비스에서도 보이지 않게 됨 — "폐기" 기능이 그대로 재사용하는 경로,
// 사용자 확정). 이미 "적용"/"반려 (인정)"으로 시트에 반영된 값이 있으면,
// 봇 쪽 기록을 지우기 전에 원상복구한다 — 그러지 않으면 봇 기록은
// 사라졌는데 시트에는 페널티/제보상점이 남는 불일치가 생긴다. 프론트가
// 함께 보낸 penalty/merit(로컬 state)이 있으면 그대로 쓰고, 새로고침 등으로
// 없으면 봇 manifest에 저장된 값으로 폴백한다.
export async function handleAdminCaptureDelete(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const body = await req.json().catch(() => ({}));
  const { id } = body;
  if (!id) return json({ error: "id가 필요합니다." }, 400, origin);
  let { penalty, merit, sourceFileId } = body;
  if (!penalty && !merit) {
    ({ penalty, merit, sourceFileId } = await findStoredPenaltyMerit(env, id));
  }

  if ((penalty && penalty.number && penalty.col) || (merit && merit.number && merit.col)) {
    try {
      const accessToken = await getServiceAccountAccessToken(env);
      // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — 실제로
      // 벌점/상점을 쓴 파일에서 취소해야 한다.
      const fileId = sourceFileId || env.GOOGLE_SHEET_FILE_ID;
      if (penalty && penalty.number && penalty.col) {
        await cancelOutputPenalty(env, accessToken, fileId, penalty.number, penalty.col, penalty.deductedMinutes || 0, penalty.dayCol || null);
      }
      if (merit && merit.number && merit.col) {
        await cancelReportMerit(env, accessToken, fileId, merit.number, merit.col);
      }
      await invalidateMemberCache(env, ["penalty"], fileId); // 페널티/제보상점 슬롯이 바뀌었으므로 관련 캐시만 무효화.
      if (penalty?.number) await invalidateMemberSlotCache(env, penalty.number, fileId);
      if (merit?.number) await invalidateMemberSlotCache(env, merit.number, fileId);
    } catch (err) {
      return json({ error: "시트 반영 취소 실패: " + err.message }, 500, origin);
    }
  }

  const data = await proxyToBotDashboard(env, "/captures/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!data) {
    return json({ error: "봇에 연결할 수 없습니다." }, 502, origin);
  }
  return json(data, 200, origin);
}

// "반려 취소" — 이미 내린 결정(반려/반려 (인정))을 되돌려 다시 관리자가
// 판단할 수 있는 "처리 대기" 상태로 되돌린다(사용자 지시: "다시 벌점 및
// 페널티인지 판단할 수 있도록 되돌리려는" 것이 목표). "적용"(대상자 페널티가
// 실제로 기록된 경우)은 이 경로로 취소하지 않는다 — 대상자 페널티는
// cancel-penalty로 명시적으로 되돌려야 하므로, "취소"가 아니라 "반려 취소"
// 버튼에서만 쓰인다. 반려 (인정)으로 제보자에게 이미 부여된 제보상점이
// 있으면(merit) 되돌리기 전에 먼저 회수한다 — 그러지 않으면 판정을
// 다시 하는 동안 이미 부여된 상점이 남아있는 불일치가 생긴다.
export async function handleAdminCaptureRevert(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const body = await req.json().catch(() => ({}));
  const { id, skipMeritLookup } = body;
  if (!id) return json({ error: "id가 필요합니다." }, 400, origin);
  let { merit, sourceFileId } = body;
  // 🔧 [버그 수정] cancel()이 별도로 이미 cancel-merit을 호출해 시트를
  // 되돌린 뒤 상태만 pending으로 되돌리려는 경우, merit을 굳이 안 보냈다고
  // 폴백 조회를 하면 manifest에 아직 남아있는 옛 merit 값을 다시 찾아
  // cancelReportMerit을 중복 호출하게 된다(이미 빈 슬롯을 또 지우거나,
  // 그 사이 다른 제보가 같은 슬롯을 채웠다면 잘못 지울 위험) — 호출자가
  // "직접 이미 처리했다"고 명시하면 폴백을 건너뛴다.
  let timeDeduction = null;
  if (!merit && !skipMeritLookup) {
    ({ merit, timeDeduction, sourceFileId } = await findStoredPenaltyMerit(env, id));
  }
  // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — 실제로
  // 상점/시간차감을 쓴 파일에서 회수해야 한다.
  const fileId = sourceFileId || env.GOOGLE_SHEET_FILE_ID;

  if (merit && merit.number && merit.col) {
    try {
      const accessToken = await getServiceAccountAccessToken(env);
      await cancelReportMerit(env, accessToken, fileId, merit.number, merit.col);
      await invalidateMemberCache(env, ["penalty"], fileId); // 제보상점 슬롯이 바뀌었으므로 관련 캐시만 무효화.
      await invalidateMemberSlotCache(env, merit.number, fileId); // 이 회원의 outputPenSlots/reportScore는 KV까지 즉시.
    } catch (err) {
      return json({ error: "제보상점 회수 실패: " + err.message }, 500, origin);
    }
  }
  // 🔧 [유예 취소 시 시간 차감도 되돌림] "유예" 결정에서 별도로 적용된
  // 응답 지연 시간 차감(timeDeduction)이 있으면, 재검토를 위해 되돌릴 때
  // 함께 되돌린다(사용자 지시) — merit과 달리 이 값은 프론트가 로컬
  // state로 들고 있지 않으므로(applied에 없음) 항상 manifest 폴백 조회
  // 결과만 사용한다.
  if (timeDeduction && timeDeduction.number) {
    try {
      const accessToken = await getServiceAccountAccessToken(env);
      await cancelTimeDeduction(
        env,
        accessToken,
        fileId,
        timeDeduction.number,
        timeDeduction.deductedMinutes || 0,
        timeDeduction.dayCol || null
      );
    } catch (err) {
      return json({ error: "시간 차감 회수 실패: " + err.message }, 500, origin);
    }
  }

  const data = await proxyToBotDashboard(env, "/captures/revert", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!data) {
    return json({ error: "봇에 연결할 수 없습니다." }, 502, origin);
  }
  return json(data, 200, origin);
}

// 제보자 본인이 자신이 제출한 제보의 캡처 진행 상황을 확인할 수 있어야 하므로
// requireAdmin이 아니라 일반 로그인 세션만 검증한다(handleStatus와 동일한 인증 수준).
export async function handleReportStatus(req, env, origin, url) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const nickname = url.searchParams.get("nickname") || "";
  if (!nickname) return json({ error: "nickname이 필요합니다." }, 400, origin);

  const data = await proxyToBotDashboard(env, "/report-status?nickname=" + encodeURIComponent(nickname));
  if (!data) {
    return json({ inProgress: false, recentLogs: [] }, 200, origin);
  }
  return json(data, 200, origin);
}
