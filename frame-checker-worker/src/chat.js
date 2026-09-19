// 🔧 [Stream Chat 도입, 2026-09-19 사용자 지시] "관리자-회원 1:1 문의방"
// 채팅 기능 — Stream Chat(getstream.io)은 클라이언트가 API Secret으로
// 직접 인증하지 않고, 서버가 사용자별 JWT를 발급해 그 토큰으로 클라이언트가
// 접속하는 구조다(Stream 관례). 이 프로젝트는 이미 자체 세션 체계
// (verifySession, index.js)가 있으므로, 그 세션을 통과한 사용자에게만
// Stream용 토큰을 새로 발급해주는 얇은 다리 역할만 한다.
//
// Node.js 전용 stream-chat 서버 SDK 대신 Stream Chat REST API를 직접
// fetch로 호출한다 — 이 Worker(Cloudflare Workers 런타임)는 SDK가 내부적으로
// fs/crypto 등 Node 전용 API를 쓸 경우 호환이 깨질 위험이 있고, 필요한 기능
// (사용자 토큰 발급, upsert)은 REST 엔드포인트 하나로 충분해 SDK 의존 자체가
// 불필요하다. 토큰 형식은 표준 JWT(HS256) — header.payload가 이 프로젝트의
// 기존 세션 토큰(index.js의 signSession, header 없는 2-part)과 다르므로
// 별도로 구현한다.
import { verifySession, json, base64url } from "./index.js";

const STREAM_API_BASE = "https://chat.stream-io-api.com";

// Stream Chat이 요구하는 표준 JWT를 만든다 — header는 항상 고정값
// ({"alg":"HS256","typ":"JWT"})이라 매번 다시 만들 필요 없이 상수로 둔다.
const JWT_HEADER = base64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));

async function signStreamToken(userId, apiSecret) {
  const payload = base64url(new TextEncoder().encode(JSON.stringify({ user_id: userId })));
  const signingInput = `${JWT_HEADER}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(sig)}`;
}

// Stream 서버 API 호출은 "서버 토큰"(위 signStreamToken과 별개로, user_id 없이
// 앱 전체 권한을 갖는 관리용 토큰)을 Authorization 헤더에 실어야 한다. Stream
// 문서상 서버 토큰은 payload가 빈 JWT(서명만 유효하면 됨)로 통용된다.
async function getStreamServerToken(apiSecret) {
  const payload = base64url(new TextEncoder().encode(JSON.stringify({ server: true })));
  const signingInput = `${JWT_HEADER}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(sig)}`;
}

// Stream Chat에 유저가 먼저 등록(upsert)되어 있어야 채널 멤버로 추가하거나
// 이름/이미지가 정상 표시된다 — 로그인 시점마다 최신 이름으로 갱신한다
// (회원 이름이 바뀔 일은 거의 없지만, 매번 upsert해도 멱등이라 안전하다).
async function upsertStreamUser(env, userId, name, role) {
  const serverToken = await getStreamServerToken(env.STREAM_CHAT_API_SECRET);
  const res = await fetch(`${STREAM_API_BASE}/users?api_key=${env.STREAM_CHAT_API_KEY}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: serverToken,
      "stream-auth-type": "jwt",
    },
    body: JSON.stringify({ users: { [userId]: { id: userId, name, role } } }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Stream upsert 실패 (${res.status}): ${text}`);
  }
}

// 🔧 [사용자 지시] "관리자-회원 1:1 문의방" — 회원 본인의 세션(email/
// memberNumber/memberName)을 그대로 Stream Chat user id/name으로 매핑한다.
// isAdmin 여부는 이 프로젝트 전역 관례(index.js 15곳 이상이 쓰는 패턴)와
// 동일하게 env.ADMIN_EMAIL과의 이메일 비교로 즉석 판정한다 — 세션 자체에는
// isAdmin 필드가 없다.
export async function handleChatToken(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  if (!env.STREAM_CHAT_API_KEY || !env.STREAM_CHAT_API_SECRET) {
    return json({ error: "채팅 기능이 아직 설정되지 않았습니다." }, 503, origin);
  }

  const isAdmin = (session.email || "").toLowerCase() === (env.ADMIN_EMAIL || "").toLowerCase();
  // 회원 본인 식별자는 memberNumber(시트상 고유 번호)를 쓴다 — 이메일은
  // Stream user id 규칙(특수문자 제한)과 충돌할 수 있고, 이미 이 프로젝트
  // 전역에서 회원을 구분하는 정본 키다. 관리자는 회원 번호가 없을 수 있어
  // 고정 id("admin")를 쓴다(주 관리자 1명 체계, members.js 조사 결과와 동일).
  const userId = isAdmin ? "admin" : `member-${session.memberNumber}`;
  // 🔧 [사용자 지시, 2026-09-19] "관리자여도 관리자 계정 이름으로" — 이미지
  // 확대 모달 등에서 관리자가 보낸 메시지의 발신자 표시가 고정 문자열
  // "관리자"로만 나와, 실제 어느 관리자(스터디장)인지 구분이 안 됐다.
  // 처음엔 report-review.js의 "스터디장 (이름)"처럼 구글 시트를 다시
  // 조회하려 했으나, 세션 토큰(auth.js, 로그인 시점에 발급) 자체에 이미
  // memberName이 들어있음을 확인했다(실측: JWT payload에 memberName:"재희"
  // — 관리자 계정도 회원 명단에 등록되어 있어 로그인 시 함께 채워짐).
  // 시트를 또 조회할 필요 없이 세션 값을 그대로 재사용한다.
  const userName = session.memberName || session.name || (isAdmin ? "관리자" : "회원");

  try {
    await upsertStreamUser(env, userId, userName, isAdmin ? "admin" : "user");
    const chatToken = await signStreamToken(userId, env.STREAM_CHAT_API_SECRET);
    return json(
      {
        token: chatToken,
        apiKey: env.STREAM_CHAT_API_KEY,
        userId,
        userName,
        isAdmin,
      },
      200,
      origin
    );
  } catch (err) {
    return json({ error: "채팅 토큰 발급 실패: " + err.message }, 500, origin);
  }
}

// 🔧 [사용자 지시, 2026-09-19] "일반 파일은 보낼 필요가 없고 보안 위협도
// 있으니 이미지만 전송 가능하도록 제한" — 프론트에서 "+" 메뉴의 파일/
// 명령어 항목을 없애 이미지 첨부만 남기는 것만으로는, 사용자가 API를
// 직접 호출하거나 드래그앤드롭으로 임의 파일(실행 파일 등)을 서버에
// 올릴 수 있는 경로를 막지 못한다.
//
// 🔧 [버그 수정] 처음에는 채널 타입("messaging")의 allowed_mime_types를
// 바꿨으나, stream-chat SDK 소스(AttachmentManager.getUploadConfigCheck,
// index.browser.js)를 직접 읽어보니 업로드 차단 검증은 채널 타입 설정이
// 아니라 앱 전체 설정(client.getAppSettings() → GET/PATCH /app의
// file_upload_config·image_upload_config)만 참조한다는 것을 확인했다 —
// 채널 타입 쪽 필드는 이 검증 경로에서 전혀 읽히지 않아 실효가 없었다.
// 또한 이 SDK의 allowed_mime_types 비교는 완전 일치(===)라
// "image/*" 같은 와일드카드는 매치되지 않으므로, file_upload_config
// (비이미지 파일 업로드 경로)의 허용 mime 목록을 빈 배열이 아닌 실제
// 이미지 mime 목록으로 좁혀 사실상 비이미지 파일을 차단한다
// (image_upload_config는 그대로 열어둬 이미지 업로드는 계속 허용).
// 앱 전체 설정이라 이 프로젝트의 Stream 앱(채팅 기능 전용) 전역에
// 적용되지만, 이 앱이 Stream을 이 채팅 기능 하나에만 쓰므로 범위상
// 문제 없다. 관리자가 배포 후 1회만 호출하면 되는 설정용 엔드포인트라
// requireAdmin으로 보호한다.
const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/heif"];

export async function handleChatConfigureUploads(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);
  if ((session.email || "").toLowerCase() !== (env.ADMIN_EMAIL || "").toLowerCase()) {
    return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);
  }
  if (!env.STREAM_CHAT_API_KEY || !env.STREAM_CHAT_API_SECRET) {
    return json({ error: "채팅 기능이 아직 설정되지 않았습니다." }, 503, origin);
  }

  try {
    const serverToken = await getStreamServerToken(env.STREAM_CHAT_API_SECRET);
    const res = await fetch(`${STREAM_API_BASE}/app?api_key=${env.STREAM_CHAT_API_KEY}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: serverToken,
        "stream-auth-type": "jwt",
      },
      body: JSON.stringify({
        file_upload_config: {
          allowed_file_extensions: [],
          blocked_file_extensions: [],
          allowed_mime_types: IMAGE_MIME_TYPES,
          blocked_mime_types: [],
        },
        image_upload_config: {
          allowed_file_extensions: [],
          blocked_file_extensions: [],
          allowed_mime_types: [],
          blocked_mime_types: [],
        },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`앱 업로드 설정 실패 (${res.status}): ${text}`);
    }
    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "업로드 제한 설정 실패: " + err.message }, 500, origin);
  }
}

// 🔧 [버그 수정, 2026-09-19 사용자 지시: "사용자를 선택해서 메시지를 발신"]
// Stream Chat은 채널 멤버로 지정하려는 유저가 사전에 upsert되어 있어야
// 한다 — 지금까지는 그 회원이 실제로 로그인해 /chat/token을 최소 1회
// 호출한 적이 있어야만 upsert가 됐다. 관리자가 "아직 채팅 탭에 한 번도
// 들어온 적 없는 회원"을 명단에서 골라 먼저 말을 걸려고 하면, Stream이
// "GetOrCreateChannel failed ... don't exist" 400을 반환하며 실패했다
// (실제 재현: member-1이 채널 멤버로 지정됐지만 Stream에 존재하지 않음).
// 관리자가 채널을 열기 직전에 이 엔드포인트로 그 회원을 먼저 upsert해
// 두면 이 문제가 해결된다 — 회원 본인이 아니라 관리자가 호출하므로
// requireAdmin으로 보호하고, 회원번호/이름은 관리자가 이미 GET
// /admin/members로 받은 값을 그대로 넘겨받는다(별도 시트 재조회 불필요).
export async function handleChatEnsureUser(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);
  if ((session.email || "").toLowerCase() !== (env.ADMIN_EMAIL || "").toLowerCase()) {
    return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);
  }
  if (!env.STREAM_CHAT_API_KEY || !env.STREAM_CHAT_API_SECRET) {
    return json({ error: "채팅 기능이 아직 설정되지 않았습니다." }, 503, origin);
  }

  const { memberNumber, memberName } = await req.json().catch(() => ({}));
  if (!memberNumber || !memberName) {
    return json({ error: "memberNumber와 memberName이 필요합니다." }, 400, origin);
  }

  try {
    await upsertStreamUser(env, `member-${memberNumber}`, memberName, "user");
    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "회원 등록 실패: " + err.message }, 500, origin);
  }
}
