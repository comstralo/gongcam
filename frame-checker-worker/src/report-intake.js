// 🔧 [구조 개선 20차, 2026-09-17] 제보/캡처 도메인(12차, src/report.js)을
// 다시 세 파일로 나눴다(docs/TESTING.md 참고) — 17차 구조 감사가 놓쳤던
// "이미 분리된 대형 파일 내부"를 재조사한 19차·20차·21차의 일환이다.
// 이 파일(report-intake.js)은 "접수/쿨다운" 단계만 담당한다 — 검토
// (report-review.js)/벌점반영(report-penalty.js) 단계와 실제 호출이
// 전혀 없음을 실측으로 확인했다(순수 재배치, 로직 변경 없음).
// getReportVoteStub/requireAdminOrCoReviewer는 이 파일이 아니라
// report-review.js가 실사용해 그쪽으로 옮겼다.
import {
  verifySession,
  getServiceAccountAccessToken,
  findMemberNumberByEmail,
  json,
  getRosterStub,
  proxyToBotDashboard,
} from "./index.js";
import { listAllMembers } from "./members.js";

function getReportQueueStub(env) {
  const id = env.REPORT_QUEUE_DO.idFromName("report-queue");
  return env.REPORT_QUEUE_DO.get(id);
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
