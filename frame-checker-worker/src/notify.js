// 🔧 [구조 개선 10차, 2026-09-13] 알림/푸시 도메인(카테고리 알림 설정,
// 상태 메시지, 웹 푸시 구독/기기 관리/발송, 참여자 간 알림)을
// index.js에서 분리했다(docs/TESTING.md 참고). 6~9차와 동일하게 fetch
// mock + 실제 workerd DO 통합 테스트를 먼저 깐 뒤 도메인을 통째로
// 옮겼다. 이 도메인은 조사 결과 다른 도메인(fines.js/exit.js/deposit.js
// 등)을 전혀 실사용하지 않는 순환 없는 잎(leaf) 도메인이었다 —
// members.js의 listAllMembers만 소비하고, 그 외에는 push-crypto.js/
// member-utils.js의 이미 export된 순수 함수와 index.js의 범용 뼈대
// 유틸만 가져다 쓴다.
//
// NOTIFY_CATEGORIES는 member-utils.js(defaultNotifyPrefs)와
// handleAdminMembersRoster(회원 관리 도메인, index.js 잔류)도 함께
// 참조하는 범용 상수라 index.js에 남기고 export만 유지한다 — 여기서는
// 재export가 아니라 실제 사용 목적으로 import한다(9차까지 반복된
// 패턴). getRosterStub도 withMemberLock 등 여러 도메인이 공유하는
// DO 스텁이라 index.js에 남기고 export만 추가했다.
import {
  verifySession,
  getServiceAccountAccessToken,
  resolveMemberNumber,
  requireAdmin,
  json,
  getMemberSettingsStub,
  getRosterStub,
  NOTIFY_CATEGORIES,
} from "./index.js";
import { listAllMembers } from "./members.js";
import { defaultNotifyPrefs, guessDeviceLabel } from "./member-utils.js";
import { sendWebPush } from "./push-crypto.js";

function getPushSubscriptionsStub(env) {
  const id = env.PUSH_SUBSCRIPTIONS_DO.idFromName("push-subscriptions");
  return env.PUSH_SUBSCRIPTIONS_DO.get(id);
}

// PUSH 알림 쿨다운/최근 목록 — ParticipantsRoster DO(§lock과 동일한 단일
// 인스턴스)에 위임한다. 이 세 함수 모두 KV를 전혀 건드리지 않는다.
async function checkNoticeCooldown(env, nickname) {
  const stub = getRosterStub(env);
  const res = await stub.fetch("https://do/notice/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nickname }),
  });
  const data = await res.json();
  return !!data.onCooldown;
}

async function recordNotice(env, entry, cooldownSec) {
  const stub = getRosterStub(env);
  await stub.fetch("https://do/notice/record", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...entry, cooldownSec }),
  });
}

async function listRecentNotices(env) {
  const stub = getRosterStub(env);
  const res = await stub.fetch("https://do/notice/list", { method: "GET" });
  const data = await res.json();
  return data.items || [];
}

// 🔧 [KV → DO 이전, 2026-09-12] §49 — MemberSettingsDO로 이전.
export async function loadNotifyPrefs(env, memberNumber) {
  const res = await getMemberSettingsStub(env).fetch(`https://do/pref?memberNumber=${encodeURIComponent(memberNumber)}`);
  const { prefs } = await res.json();
  return prefs ? { ...defaultNotifyPrefs(), ...prefs } : defaultNotifyPrefs();
}

export async function handleGetNotifyPrefs(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const memberNumber = await resolveMemberNumber(env, accessToken, session);
    const prefs = await loadNotifyPrefs(env, memberNumber);
    return json({ categories: NOTIFY_CATEGORIES, prefs }, 200, origin);
  } catch (err) {
    return json({ error: "알림 설정 조회 실패: " + err.message }, 500, origin);
  }
}

export async function handleSetNotifyPrefs(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const { category, enabled } = await req.json().catch(() => ({}));
  if (!Object.prototype.hasOwnProperty.call(NOTIFY_CATEGORIES, category)) {
    return json({ error: "알 수 없는 알림 종류입니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const memberNumber = await resolveMemberNumber(env, accessToken, session);
    const prefs = await loadNotifyPrefs(env, memberNumber);
    prefs[category] = !!enabled;
    await getMemberSettingsStub(env).fetch("https://do/pref", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberNumber, prefs }),
    });
    return json({ ok: true, prefs }, 200, origin);
  } catch (err) {
    return json({ error: "알림 설정 저장 실패: " + err.message }, 500, origin);
  }
}

// "상태 메시지" — 참여자가 [설정]에서 자유 텍스트(예: "태블릿: AI 질의용도")를
// 등록해두면, 다른 참여자가 [제보] 대상자를 선택했을 때 그 메시지를 보여줘
// 오해로 인한 제보를 줄인다(사용자 요청). notifyPref와 동일하게 시트를
// 건드리지 않고 KV에 회원번호를 키로 저장한다 — 15개 개인 탭 + template에
// 새 셀을 추가하는 것보다 리스크가 훨씬 낮다.
const STATUS_MESSAGE_MAX_LENGTH = 60;

// 🔧 [KV → DO 이전, 2026-09-12] §49 — MemberSettingsDO로 이전.
async function loadStatusMessage(env, memberNumber) {
  const res = await getMemberSettingsStub(env).fetch(`https://do/status?memberNumber=${encodeURIComponent(memberNumber)}`);
  const { message } = await res.json();
  return message || "";
}

// 본인 상태 메시지 조회 — [설정] 페이지가 현재 값을 입력창에 미리 채우는 데 쓴다.
export async function handleGetStatusMessage(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const memberNumber = await resolveMemberNumber(env, accessToken, session);
    const message = await loadStatusMessage(env, memberNumber);
    return json({ message }, 200, origin);
  } catch (err) {
    return json({ error: "상태 메시지 조회 실패: " + err.message }, 500, origin);
  }
}

// 본인 상태 메시지 저장. 빈 문자열이면 삭제(KV에서 키 제거)한다.
export async function handleSetStatusMessage(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const { message } = await req.json().catch(() => ({}));
  if (typeof message !== "string") {
    return json({ error: "message가 필요합니다." }, 400, origin);
  }
  const trimmed = message.trim().slice(0, STATUS_MESSAGE_MAX_LENGTH);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const memberNumber = await resolveMemberNumber(env, accessToken, session);
    const stub = getMemberSettingsStub(env);
    if (trimmed) {
      await stub.fetch("https://do/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberNumber, message: trimmed }),
      });
    } else {
      await stub.fetch(`https://do/status?memberNumber=${encodeURIComponent(memberNumber)}`, { method: "DELETE" });
    }
    return json({ ok: true, message: trimmed }, 200, origin);
  } catch (err) {
    return json({ error: "상태 메시지 저장 실패: " + err.message }, 500, origin);
  }
}

// [제보] 페이지가 대상자를 고른 직후 그 사람의 상태 메시지를 조회한다.
// 로그인만 하면 누구나 조회 가능(handleReportStatus와 동일한 인증 수준) —
// 상태 메시지 자체가 제보 오해를 줄이려고 공개하는 정보라 회원 본인 여부를
// 가릴 필요가 없다.
export async function handleGetMemberStatusMessage(req, env, origin, url) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const nickname = url.searchParams.get("nickname") || "";
  if (!nickname) return json({ error: "nickname이 필요합니다." }, 400, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const members = await listAllMembers(env, accessToken, env.GOOGLE_SHEET_FILE_ID);
    const member = members.find((m) => m.name === nickname);
    if (!member) return json({ message: "" }, 200, origin);
    const message = await loadStatusMessage(env, member.number);
    return json({ message }, 200, origin);
  } catch (err) {
    return json({ error: "상태 메시지 조회 실패: " + err.message }, 500, origin);
  }
}

// 관리자가 특정 회원 + 특정 알림 종류를 골라 수동으로 테스트 발송해본다.
// 실제 이벤트에 연결되기 전, 종류별 on/off 차단이 의도대로 동작하는지
// 확인하는 용도. 회원이 해당 종류를 꺼뒀으면 실제로 발송을 막고 그 사실을
// 응답에 담아 관리자가 확인할 수 있게 한다.
export async function handleAdminPushSendCategory(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { nickname, category } = await req.json().catch(() => ({}));
  if (!nickname) return json({ error: "알림을 받을 참여자를 선택해주세요." }, 400, origin);
  if (!Object.prototype.hasOwnProperty.call(NOTIFY_CATEGORIES, category)) {
    return json({ error: "알 수 없는 알림 종류입니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const members = await listAllMembers(env, accessToken, env.GOOGLE_SHEET_FILE_ID);
    const member = members.find((m) => m.name === nickname);
    if (!member) return json({ error: `"${nickname}" 이름과 일치하는 등록 회원을 찾을 수 없습니다.` }, 404, origin);

    const prefs = await loadNotifyPrefs(env, member.number);
    if (!prefs[category]) {
      return json(
        { ok: false, blocked: true, message: `${member.name}님은 "${NOTIFY_CATEGORIES[category]}" 알림을 꺼두어 발송하지 않았습니다.` },
        200,
        origin
      );
    }

    // 🔧 [KV → DO 이전, 2026-09-12] §49 — PushSubscriptionsDO로 이전.
    const pushStub = getPushSubscriptionsStub(env);
    const devices = await getPushDeviceIndex(env, member.email);
    if (devices.length === 0) {
      return json({ error: `${member.name}님은 아직 알림을 켜지 않았습니다.` }, 404, origin);
    }

    const payload = JSON.stringify({
      title: `[테스트] ${NOTIFY_CATEGORIES[category]}`,
      body: `관리자 테스트 발송 · ${new Date().toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul" })}`,
    });

    let sent = 0;
    const missingIds = [];
    for (const device of devices) {
      // enabled가 false로 명시된 기기(사용자가 껐거나, 중복이라 정리한
      // 기기)는 건너뛴다. 필드가 아예 없는 옛 구독(이 기능 추가 전 저장된
      // 것)은 기존처럼 발송 대상으로 취급한다.
      if (device.enabled === false) continue;
      const subRes = await pushStub.fetch(`https://do/sub?id=${encodeURIComponent(device.id)}`);
      const { entry: parsed } = await subRes.json();
      if (!parsed) {
        missingIds.push(device.id);
        continue;
      }
      if (parsed.enabled === false) continue;
      const { subscription } = parsed;
      try {
        const res = await sendWebPush(subscription, payload, env);
        if (res.status === 404 || res.status === 410) {
          missingIds.push(device.id);
        } else if (res.status >= 200 && res.status < 300) {
          sent += 1;
        }
      } catch {
        // 개별 구독 발송 실패는 건너뛰고 나머지 구독에는 계속 시도한다.
      }
    }
    if (missingIds.length > 0) {
      await pushStub.fetch("https://do/device/prune", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: missingIds }),
      });
    }

    if (sent === 0) return json({ error: "알림 발송에 실패했습니다." }, 502, origin);
    return json({ ok: true, blocked: false, sent }, 200, origin);
  } catch (err) {
    return json({ error: "알림 발송 실패: " + err.message }, 500, origin);
  }
}

// User-Agent로 "이 기기가 대략 뭔지" 사람이 알아볼 수 있는 이름을 추정한다.
// 브라우저는 보안상 실제 기기 고유명(예: 사용자가 붙인 아이폰 이름, PC
// 계정명)을 웹사이트에 절대 넘겨주지 않으므로, User-Agent에서 뽑을 수 있는
// OS/브라우저 종류까지만 추정할 수 있다 — 같은 종류의 기기가 여러 대면
// 이름이 겹칠 수 있다(정확한 개체 식별이 목적이 아니라, "대략 이런
// 기기다"를 보여주는 용도).
// 🔧 [푸시 중복 발송 수정] 서비스워커 재등록·PWA 재설치·캐시 초기화 등으로
// 브라우저가 새 endpoint를 발급하면, 기존엔 옛 구독을 정리하지 않고 계속
// 추가만 해서 같은 사람 앞으로 죽은 구독이 무한정 쌓였다 — 발송 로직이
// 그 사람의 모든 구독에 각각 보내는 구조라, 알림이 여러 번(예: 2번) 가는
// 것처럼 보이는 원인이었다(사용자 지적). endpoint가 바뀌어도 "같은 기기"로
// 이어보려면 정확한 기기 식별이 필요한데, 웹에서는 불가능하므로 대신
// "기기별로 켜고 끌 수 있게" 사용자가 직접 죽은/중복 기기를 정리할 수
// 있는 구조로 바꾼다 — deviceLabel(자동 추정)과 enabled(기본 true)를
// 함께 저장하고, 발송 로직은 enabled가 false인 구독을 건너뛴다.
// 🔧 [KV → DO 이전, 2026-09-12] §49 — PushSubscriptionsDO로 이전했다.
// 예전엔 인덱스(subIndex:{이메일})가 KV에 있어 "인덱스 없으면 list()로
// 자체복구"하는 마이그레이션 폴백이 필요했는데, DO는 최초 배포 시
// storage가 텅 빈 채로 시작하므로(이번 전환에서 기존 데이터를 날리기로
// 확정) 그 폴백 자체가 통째로 불필요해져 삭제했다. "읽기→배열 수정→
// 쓰기" 레이스를 막던 withMemberLock(env, `push:${email}`, ...)도 DO가
// 요청을 직렬 처리해 구조적으로 불필요해져 제거했다.
export async function getPushDeviceIndex(env, email) {
  const res = await getPushSubscriptionsStub(env).fetch(`https://do/index?email=${encodeURIComponent(email)}`);
  const { devices } = await res.json();
  return devices || [];
}

export async function handlePushSubscribe(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const { subscription } = await req.json();
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return json({ error: "구독 정보가 올바르지 않습니다." }, 400, origin);
  }

  const key = `sub:${session.email}:${await sha256Hex(subscription.endpoint)}`;
  const deviceLabel = guessDeviceLabel(req.headers.get("User-Agent"));
  const savedAt = Date.now();
  // 🔧 [원자적 구독] 원본 저장 + 인덱스 갱신을 DO의 /subscribe 한 번으로
  // 처리한다(§PushSubscriptionsDO 주석 참고) — 같은 기기(endpoint)가
  // 재구독하면 같은 key로 덮어써지므로 교체, 새 기기면 추가.
  await getPushSubscriptionsStub(env).fetch("https://do/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: session.email, id: key, deviceLabel, savedAt, subscription }),
  });

  // 🔧 [알림 켜기 직후 상태가 안 바뀌던 문제 수정] 프론트가 구독 등록
  // 직후 곧바로 /push/devices를 다시 조회해 "이 기기가 서버에도 있는지"
  // 확인하는데, 이전엔 Cloudflare KV의 쓰기 직후 결과적 일관성
  // (eventual consistency) 때문에 방금 쓴 값이 곧바로 안 보일 수 있었다
  // (사용자 지적: "알림이 켜졌습니다" 메시지는 뜨는데 상단 상태·버튼은
  // 계속 "꺼짐"으로 남아있었음). DO 전환 후에는 이 문제 자체가 없지만
  // (같은 DO가 쓰기 직후 읽기에도 항상 최신값을 반환), 재조회 왕복을
  // 아끼기 위해 응답에 방금 저장한 값을 그대로 실어주는 관행은 유지한다.
  return json({ ok: true, deviceId: key, deviceLabel }, 200, origin);
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// GET /push/devices — 로그인한 본인이 지금까지 등록한 모든 기기(구독)
// 목록을 보여준다. "알림 설정" 화면에서 죽었거나 더 이상 안 쓰는 기기를
// 직접 끄거나 지울 수 있게 하기 위함 — endpoint가 바뀔 때마다(서비스워커
// 재등록 등) 옛 구독이 삭제되지 않고 쌓이는 게 중복 발송의 원인이었다.
export async function handleListPushDevices(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  // 🔧 [KV list() 제거, 2026-09-11] subIndex:{이메일}이 이미 이 응답에
  // 필요한 필드(id/deviceLabel/enabled/savedAt)를 그대로 담고 있어
  // list()도 기기별 get()도 필요 없다.
  const devices = (await getPushDeviceIndex(env, session.email)).slice();
  devices.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  return json({ devices }, 200, origin);
}

// POST /push/devices/toggle — 본인 기기 하나의 알림 수신 on/off. id는
// handleListPushDevices가 내려준 key.name을 그대로 되돌려받아 쓴다 —
// 본인 이메일 프리픽스로 시작하는지 반드시 확인해 다른 사람 구독을 끄는
// 것을 막는다.
export async function handlePushDeviceToggle(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const { id, enabled } = await req.json().catch(() => ({}));
  if (!id || typeof id !== "string" || !id.startsWith(`sub:${session.email}:`)) {
    return json({ error: "잘못된 기기 정보입니다." }, 400, origin);
  }

  // 🔧 [KV → DO 이전, 2026-09-12] §49 — PushSubscriptionsDO의
  // /device/toggle이 원본 수정 + 인덱스 갱신을 원자적으로 처리한다.
  const res = await getPushSubscriptionsStub(env).fetch("https://do/device/toggle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, enabled: !!enabled }),
  });
  if (res.status === 404) return json({ error: "이미 삭제된 기기입니다." }, 404, origin);
  return json({ ok: true }, 200, origin);
}

// POST /push/devices/rename — 본인 기기 하나의 표시 이름을 사용자가 직접
// 지정한 값으로 바꾼다. deviceLabel은 User-Agent로 자동 추정한 값이라
// 같은 종류 기기가 여러 대면 이름이 겹치는데("Windows · Chrome"이 두 개
// 등), 정확한 기기 고유명은 웹에서 얻을 수 없으므로 사용자가 직접 구분할
// 수 있게 한다.
export async function handlePushDeviceRename(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const { id, deviceLabel } = await req.json().catch(() => ({}));
  if (!id || typeof id !== "string" || !id.startsWith(`sub:${session.email}:`)) {
    return json({ error: "잘못된 기기 정보입니다." }, 400, origin);
  }
  const trimmed = (deviceLabel || "").trim().slice(0, 30);
  if (!trimmed) return json({ error: "기기 이름을 입력해주세요." }, 400, origin);

  // 🔧 [KV → DO 이전, 2026-09-12] §49 — PushSubscriptionsDO의
  // /device/rename이 원본 수정 + 인덱스 갱신을 원자적으로 처리한다.
  const res = await getPushSubscriptionsStub(env).fetch("https://do/device/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, deviceLabel: trimmed }),
  });
  if (res.status === 404) return json({ error: "이미 삭제된 기기입니다." }, 404, origin);
  return json({ ok: true, deviceLabel: trimmed }, 200, origin);
}

// POST /push/devices/remove — 본인 기기 하나를 완전히 삭제(구독 정보
// 자체를 지운다, 껐다 켰다 하는 toggle과 달리 되돌릴 수 없음).
export async function handlePushDeviceRemove(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const { id } = await req.json().catch(() => ({}));
  if (!id || typeof id !== "string" || !id.startsWith(`sub:${session.email}:`)) {
    return json({ error: "잘못된 기기 정보입니다." }, 400, origin);
  }

  // 🔧 [KV → DO 이전, 2026-09-12] §49 — PushSubscriptionsDO의
  // /device/remove가 원본 삭제 + 인덱스 갱신을 원자적으로 처리한다.
  await getPushSubscriptionsStub(env).fetch("https://do/device/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  return json({ ok: true }, 200, origin);
}

// 🔧 [KV → DO 이전, 2026-09-12] §49 — 발송 루프는 그대로 두되, 구독
// 원본 조회는 /sub?id=로, 발송 실패(404/410) 정리는 루프 종료 후
// /device/prune 한 번으로 배치 처리한다(기존엔 실패마다 개별
// delete+개별 인덱스 put이었음).
export async function handlePushSendTest(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const pushStub = getPushSubscriptionsStub(env);
  const devices = await getPushDeviceIndex(env, admin.email);
  if (devices.length === 0) {
    return json({ error: "등록된 구독이 없습니다. 먼저 알림을 켜주세요." }, 404, origin);
  }

  const payload = JSON.stringify({
    title: "프레임 체커 테스트 알림",
    body: `관리자 테스트 발송 · ${new Date().toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul" })}`,
  });

  const results = [];
  const missingIds = [];
  for (const device of devices) {
    if (device.enabled === false) continue;
    const subRes = await pushStub.fetch(`https://do/sub?id=${encodeURIComponent(device.id)}`);
    const { entry: parsed } = await subRes.json();
    if (!parsed) {
      missingIds.push(device.id);
      continue;
    }
    if (parsed.enabled === false) continue;
    const { subscription } = parsed;
    try {
      const res = await sendWebPush(subscription, payload, env);
      if (res.status === 404 || res.status === 410) {
        missingIds.push(device.id);
      }
      results.push({ key: device.id, status: res.status });
    } catch (err) {
      results.push({ key: device.id, error: err.message });
    }
  }
  if (missingIds.length > 0) {
    await pushStub.fetch("https://do/device/prune", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: missingIds }),
    });
  }

  return json({ ok: true, results }, 200, origin);
}

const NOTICE_COOLDOWN_SEC = 10 * 60;

// 참여자가 다른 참여자에게 짧은 문구를 푸시 알림으로 보낸다(예: "타이머
// 안 켜졌어요" 같은 실수 알림용). 관리자 전용이 아니라 로그인한 누구나
// 쓸 수 있다 — 제보 메뉴와 접근 수준을 맞춘다. 대상은 닉네임(현재 접속
// 중인 참여자 명단에서 고른 이름)으로 지정하고, applyOutputPenalty와
// 동일하게 listAllMembers의 name과 정확히 일치하는 회원만 찾는다.
// 같은 대상에게는 handleReport의 20분 쿨다운과 같은 원리로 10분 내 중복
// 발송을 막고, 최근 발송 이력은 "최근 전송된 알림" 화면이 참여자 전체에게
// 공유되도록 한다 — 🔧 [KV → DO 이전, 2026-09-11] 이 둘(쿨다운·이력) 모두
// KV가 아니라 ParticipantsRoster DO에 저장한다(checkNoticeCooldown/
// recordNotice/listRecentNotices 참고, §ParticipantsRoster 주석).
// GET /push/subscription-status — "간단한 알림 전송" 화면이 대상자 드롭다운
// 옆에 "(알림구독 X)"를 미리 보여줄 수 있도록, 전체 회원의 웹 푸시 구독
// 여부를 한 번에 반환한다. 🔧 [KV list() 제거, 2026-09-11] 예전엔
// PUSH_SUBS_KV.list({prefix:"sub:"}) 한 번으로 구독 중인 이메일 집합을
// 얻었는데(회원마다 개별 조회할 필요 없이), 이제 회원별 subIndex:{이메일}
// (§getPushDeviceIndex)을 각자 조회하는 방식으로 바뀌었다 — list() 호출
// 자체를 없애는 대신 회원 수만큼(최대 15회) get()을 쓴다(읽기는 하루
// 10만 회로 여유가 커 문제없음).
export async function handlePushSubscriptionStatus(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const members = await listAllMembers(env, accessToken, env.GOOGLE_SHEET_FILE_ID);

    // 🔧 [KV list() 제거, 2026-09-11] 예전엔 list({prefix:"sub:"})로 전
    // 회원 구독을 한 번에 훑었는데, 이제 회원별 subIndex:{이메일}를 각자
    // 조회한다 — list() 1회가 get() 최대 15회(회원 수)로 바뀐다(읽기는
    // 예산이 넉넉해 문제없음).
    const items = await Promise.all(
      members.map(async (m) => ({
        name: m.name,
        subscribed: (await getPushDeviceIndex(env, m.email)).length > 0,
      }))
    );
    return json({ items }, 200, origin);
  } catch (err) {
    return json({ error: "구독 현황 조회 실패: " + err.message }, 500, origin);
  }
}

export async function handlePushSendToMember(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const { nickname, message } = await req.json().catch(() => ({}));
  if (!nickname) return json({ error: "알림을 받을 참여자를 선택해주세요." }, 400, origin);
  const text = (message || "").trim();
  if (!text) return json({ error: "알림 내용을 입력해주세요." }, 400, origin);
  if (text.length > 200) return json({ error: "알림 내용은 200자 이내로 입력해주세요." }, 400, origin);

  // 관리자는 20분 쿨다운을 우회하는 handleReport와 동일하게 10분 쿨다운도
  // 우회한다 — 같은 대상에게 반복 확인·전송해야 하는 경우가 있어서다.
  const isAdmin = (session.email || "").toLowerCase() === (env.ADMIN_EMAIL || "").toLowerCase();

  const trimmedNickname = nickname.slice(0, 50);
  // 🔧 [KV → DO 이전, 2026-09-11] 쿨다운 체크·기록을 KV(notice-cooldown:)가
  // 아니라 ParticipantsRoster DO에 위임한다 — 하루 쓰기 한도(1,000회)와
  // 무관해지고, get→put 사이 경합(레이스)도 원천적으로 없다(§ParticipantsRoster
  // 주석 참고).
  if (!isAdmin) {
    const onCooldown = await checkNoticeCooldown(env, trimmedNickname);
    if (onCooldown) {
      return json({ error: "같은 대상에게는 10분 내에 다시 알림을 보낼 수 없습니다." }, 429, origin);
    }
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const members = await listAllMembers(env, accessToken, env.GOOGLE_SHEET_FILE_ID);
    const member = members.find((m) => m.name === nickname);
    if (!member) return json({ error: `"${nickname}" 이름과 일치하는 등록 회원을 찾을 수 없습니다.` }, 404, origin);

    // 🔧 [KV → DO 이전, 2026-09-12] §49 — PushSubscriptionsDO로 이전.
    const pushStub = getPushSubscriptionsStub(env);
    const devices = await getPushDeviceIndex(env, member.email);
    if (devices.length === 0) {
      return json({ error: `${member.name}님은 아직 알림을 켜지 않았습니다.` }, 404, origin);
    }

    const payload = JSON.stringify({
      title: `${session.memberName || "참여자"}님의 알림`,
      body: text,
    });

    let sent = 0;
    const missingIds = [];
    for (const device of devices) {
      if (device.enabled === false) continue;
      const subRes = await pushStub.fetch(`https://do/sub?id=${encodeURIComponent(device.id)}`);
      const { entry: parsed } = await subRes.json();
      if (!parsed) {
        // 인덱스에는 있지만 실제 구독이 사라진 경우(드묾) — 다음 정리 때
        // 인덱스에서도 걸러지도록 표시만 해두고 계속 진행한다.
        missingIds.push(device.id);
        continue;
      }
      if (parsed.enabled === false) continue;
      const { subscription } = parsed;
      try {
        const res = await sendWebPush(subscription, payload, env);
        if (res.status === 404 || res.status === 410) {
          missingIds.push(device.id);
        } else if (res.status >= 200 && res.status < 300) {
          sent += 1;
        }
      } catch {
        // 개별 구독 발송 실패는 건너뛰고 나머지 구독에는 계속 시도한다.
      }
    }
    if (missingIds.length > 0) {
      await pushStub.fetch("https://do/device/prune", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: missingIds }),
      });
    }

    if (sent === 0) return json({ error: "알림 발송에 실패했습니다." }, 502, origin);

    // 🔧 [KV → DO 이전, 2026-09-11] "최근 전송된 알림" 목록도 KV
    // (noticeIndex:current) 대신 같은 DO에 기록한다.
    await recordNotice(
      env,
      { nickname: trimmedNickname, message: text, senderName: session.memberName || "참여자" },
      NOTICE_COOLDOWN_SEC
    );

    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "알림 발송 실패: " + err.message }, 500, origin);
  }
}

// 최근 10분 내 발송된 알림 이력을 모두가 볼 수 있게 반환한다("최근 전송된
// 알림" 화면용) — "진행 중인 제보"(handleListActiveCooldowns)와 동일한
// 목적: 이미 알림이 갔다는 걸 다른 참여자도 알아야 중복으로 보내지 않는다.
export async function handleListRecentNotices(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  // 🔧 [KV → DO 이전, 2026-09-11] ParticipantsRoster DO의 메모리 상태를
  // 그대로 읽는다 — KV(REPORTS_KV)를 전혀 거치지 않는다(읽기도 쓰기도).
  const items = await listRecentNotices(env);
  items.sort((a, b) => b.ts - a.ts);
  return json({ items }, 200, origin);
}
