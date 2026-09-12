// 프레임 체커 제보 API — Cloudflare Worker
//
// 엔드포인트
//   POST /verify   { credential: <Google ID Token> } -> { token, name, email }
//   POST /report   { token, nickname, reason } -> { ok: true }
//   GET  /reports  (Bot-Secret 헤더 필요) -> [{ id, nickname, reason, reporterEmail, ts }, ...]
//
// 인증 흐름
//   1. 브라우저가 Google Identity Services로 로그인 -> ID Token(credential) 획득
//   2. Worker가 Google의 공개키로 ID Token 서명을 검증하고 이메일 추출
//   3. 그 이메일이 구글 시트 "열람 권한" 목록에 있는지 대조
//   4. 있으면 서버가 서명한 세션 토큰 발급 (HMAC-SHA256, 24시간 만료)
//   5. 이후 /report 호출 시 이 세션 토큰을 다시 검증

const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const SESSION_TTL_SEC = 30 * 24 * 60 * 60;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Bot-Secret",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function base64url(bytes) {
  let str = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signSession(payload, secret) {
  const key = await hmacKey(secret);
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${base64url(sig)}`;
}

async function verifySession(token, secret) {
  const [body, sig] = (token || "").split(".");
  if (!body || !sig) return null;
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64urlToBytes(sig),
    new TextEncoder().encode(body)
  );
  if (!valid) return null;
  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(body)));
  if (payload.exp < Date.now() / 1000) return null;
  return payload;
}

// --- Google ID Token 검증 (RS256, JWKS 사용) ---

let cachedCerts = null;
let cachedCertsAt = 0;

async function getGoogleCerts() {
  if (cachedCerts && Date.now() - cachedCertsAt < 60 * 60 * 1000) return cachedCerts;
  const res = await fetch(GOOGLE_CERTS_URL);
  const data = await res.json();
  cachedCerts = data.keys;
  cachedCertsAt = Date.now();
  return cachedCerts;
}

async function verifyGoogleIdToken(credential, clientId) {
  const [headerB64, payloadB64, sigB64] = credential.split(".");
  if (!headerB64 || !payloadB64 || !sigB64) throw new Error("잘못된 토큰 형식");

  const header = JSON.parse(new TextDecoder().decode(base64urlToBytes(headerB64)));
  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(payloadB64)));

  const certs = await getGoogleCerts();
  const jwk = certs.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("일치하는 공개키를 찾을 수 없음");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64urlToBytes(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) throw new Error("서명 검증 실패");

  if (payload.aud !== clientId) throw new Error("클라이언트 ID 불일치");
  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") {
    throw new Error("발급자 불일치");
  }
  if (payload.exp < Date.now() / 1000) throw new Error("만료된 토큰");
  if (payload.email_verified !== true && payload.email_verified !== "true") {
    throw new Error("이메일 미인증 계정");
  }

  return { email: payload.email.toLowerCase(), name: payload.name || payload.email };
}

// --- 구글 시트 열람 권한 목록 조회 (서비스 계정) ---

// 서비스 계정 액세스 토큰은 1시간 유효하므로, 발급 후 55분간 재사용해
// 매 /status 요청마다 Google OAuth 서버를 왕복하는 것을 피한다.
let cachedAccessToken = null;
let cachedAccessTokenAt = 0;
const ACCESS_TOKEN_CACHE_MS = 55 * 60 * 1000;

async function getServiceAccountAccessToken(env) {
  if (cachedAccessToken && Date.now() - cachedAccessTokenAt < ACCESS_TOKEN_CACHE_MS) {
    return cachedAccessToken;
  }

  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope:
      "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const encHeader = base64url(new TextEncoder().encode(JSON.stringify(header)));
  const encClaim = base64url(new TextEncoder().encode(JSON.stringify(claim)));
  const signInput = `${encHeader}.${encClaim}`;

  const pemBody = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const keyBytes = base64urlToBytesStd(pemBody);

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signInput)
  );

  const jwt = `${signInput}.${base64url(sig)}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error("서비스 계정 인증 실패: " + JSON.stringify(tokenData));

  cachedAccessToken = tokenData.access_token;
  cachedAccessTokenAt = Date.now();
  return cachedAccessToken;
}

function base64urlToBytesStd(std) {
  const bin = atob(std);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// --- 관리자 위임 OAuth (Drive 파일 공유는 서비스 계정으로 불가능해서 필요) ---
// 개인 Gmail 정책상 서비스 계정(파일 소유자가 아님)은 다른 사용자를 편집자로
// 초대(공유)할 권한이 없다("Sorry, you do not have permission to share").
// 그래서 시트 소유자(관리자)가 1회 OAuth 동의를 거쳐 발급한 refresh_token을
// 보관해두고, Drive 편집자 추가가 필요할 때만 그 토큰으로 위임 호출한다.
// 🔧 [KV → DO 이전, 2026-09-12] §49 — BotAdminConfigDO로 이전.
const ADMIN_OAUTH_CONFIG_KEY = "adminOAuthRefreshToken";
const ADMIN_OAUTH_REDIRECT_PATH = "/oauth/callback";
const ADMIN_OAUTH_SCOPE = "https://www.googleapis.com/auth/drive";

function adminOAuthRedirectUri(env) {
  return (env.ADMIN_OAUTH_BASE_URL || "https://frame-checker-worker.comstralo.workers.dev") + ADMIN_OAUTH_REDIRECT_PATH;
}

async function exchangeAdminOAuthCode(env, code) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.ADMIN_OAUTH_CLIENT_ID,
      client_secret: env.ADMIN_OAUTH_CLIENT_SECRET,
      redirect_uri: adminOAuthRedirectUri(env),
      grant_type: "authorization_code",
    }),
  });
  const data = await res.json();
  if (!data.refresh_token) throw new Error("refresh_token 발급 실패: " + JSON.stringify(data));
  return data;
}

// 서비스 계정 토큰과 동일하게, 관리자 위임 토큰도 55분간 캐싱한다.
// grantSheetAccess/revokeSheetAccess가 신규 등록·퇴실 처리마다 각각 이
// 함수를 호출하는데, 캐싱 없이는 매번 Google OAuth 토큰 엔드포인트를
// 새로 왕복하게 된다(Sheets API 쿼터와는 무관하지만 불필요한 지연).
let cachedAdminAccessToken = null;
let cachedAdminAccessTokenAt = 0;

async function getAdminAccessToken(env) {
  if (cachedAdminAccessToken && Date.now() - cachedAdminAccessTokenAt < ACCESS_TOKEN_CACHE_MS) {
    return cachedAdminAccessToken;
  }
  const refreshTokenRes = await getBotAdminConfigStub(env).fetch(`https://do/config?key=${ADMIN_OAUTH_CONFIG_KEY}`);
  const { value: refreshToken } = await refreshTokenRes.json();
  if (!refreshToken) {
    throw new Error("관리자 위임 인증이 아직 설정되지 않았습니다. /oauth/authorize로 먼저 연동해주세요.");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.ADMIN_OAUTH_CLIENT_ID,
      client_secret: env.ADMIN_OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("관리자 위임 토큰 갱신 실패: " + JSON.stringify(data));
  cachedAdminAccessToken = data.access_token;
  cachedAdminAccessTokenAt = Date.now();
  return data.access_token;
}

async function getSheetViewerEmails(env) {
  const accessToken = await getServiceAccountAccessToken(env);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${env.GOOGLE_SHEET_FILE_ID}/permissions?fields=permissions(emailAddress,role)`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!data.permissions) throw new Error("권한 목록 조회 실패: " + JSON.stringify(data));
  return data.permissions
    .filter((p) => p.emailAddress)
    .map((p) => p.emailAddress.toLowerCase());
}

// 🔧 [사용량 모니터링] Sheets API 호출을 분 단위로 세어 "Bot·Sheet" 탭에서
// 무료 할당량(분당 60회 읽기/쓰기) 대비 현재 사용량을 보여주기 위한 계측.
// KV에 호출마다 쓰면 그 자체가 KV 쓰기 할당량(하루 1,000회)을 금방 태우니,
// 인메모리(모듈 스코프)에만 분 단위로 누적하고 관리자가 실제로 조회할 때만
// 값을 읽는다 — 같은 Worker isolate가 살아있는 동안만 유효한 근사치이지만
// (콜드스타트 시 리셋), "지금 이 순간 위험 수준인지"를 보는 용도로는 충분하다.
const _usageCounters = new Map(); // "sheets_read:2026-08-27T12:34" -> count

function _bumpUsageCounter(kind) {
  const minuteKey = new Date().toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
  const key = `${kind}:${minuteKey}`;
  _usageCounters.set(key, (_usageCounters.get(key) || 0) + 1);
  // 오래된 분 버킷은 청소한다 — 지난 5분만 유지하면 충분하다(분당 카운트만 필요).
  if (_usageCounters.size > 200) {
    const cutoff = Date.now() - 5 * 60_000;
    for (const k of _usageCounters.keys()) {
      const ts = k.slice(k.indexOf(":") + 1);
      if (new Date(ts + ":00Z").getTime() < cutoff) _usageCounters.delete(k);
    }
  }
}

function _getUsageCounter(kind, minutesAgo = 0) {
  const d = new Date(Date.now() - minutesAgo * 60_000);
  const minuteKey = d.toISOString().slice(0, 16);
  return _usageCounters.get(`${kind}:${minuteKey}`) || 0;
}

// 🔧 [사용자 지시] "해당 로그를 남겨서 어디서 누수가 발생하는지 아니면
// 기분탓인건지 알 수 있도록 해줘" → "어느 화면에서 어떤 기능에 의해
// 쓰기·삭제가 주기적으로 발생하는지 확인할 수 있도록, 좀 더 확실하게
// 원인을 알고 싶어" — 처음엔 "어떤 캐시 종류"(kind)까지만 구분했는데,
// "어느 화면"까지 특정하려면 그 KV 호출이 어느 API 요청 처리 중
// 일어났는지(요청 경로)도 함께 남겨야 한다. 58곳에 흩어진 개별
// env.REPORTS_KV.put/delete 호출부를 일일이 계측 코드로 바꾸는 대신,
// fetch 핸들러 진입 시 env.REPORTS_KV 자체를 이 얇은 프록시로 한 번만
// 감싸 이후의 모든 호출을 자동으로 잡는다(호출부 수정 0건) — 그 프록시를
// 만들 때 현재 요청의 url.pathname을 클로저로 넘겨받아 매 호출마다 함께
// 기록한다.
const KV_USAGE_WINDOW_MIN = 30;

// 🔧 [사용량 모니터링 고도화, 2026-09-11] "하루 동안, 어느 메뉴에서, 어느
// 사용자에 의해"까지 보려면 이 버퍼가 필요하다 — 5분 cron(scheduled)이
// UsageStats Durable Object로 배치 전송(flushDailyUsageStats)한 뒤 비우는
// 임시 중계소일 뿐이다. 매 KV 호출마다 DO에 실시간 전송하면 "감시 기능이
// 감시 대상 KV 할당량을 갉아먹는" 역설이 생기므로, DO에도 배치로만
// 보낸다(DO 자체는 KV 할당량과 무관하지만 오버헤드 자체를 줄이는 목적).
const _dailyUsageBuffer = new Map(); // "{date}|{kind}|{path}|{email}|{op}" -> count

// 🔧 [사용자 지시] "일일 중에서 30분내로 발생한것만 추려서 보여주면
// 되잖아" — 원래는 isolate 로컬 메모리(_kvUsageCounters)로 "최근 30분"을
// 별도 집계했는데, Cloudflare가 요청을 여러 서버로 분산 처리하면 한
// isolate가 직접 겪은 것만 보여 "일일"보다 훨씬 적게 보이는 구조적
// 한계가 있었다. 이제 위 _dailyUsageBuffer와 동일하게 DO로 배치
// 전송하되, DO 쪽에 분단위 키로 따로 저장해두고 "그중 최근 30분 것만"
// 필터링해 보여준다(§UsageStats DO의 /flush-recent, /recent) — isolate
// 무관하게 항상 완전한 값이 나온다.
const _minuteUsageBuffer = new Map(); // "{minuteKey}|{kind}|{path}|{email}|{op}" -> count

// 🔧 [사용자 지시] "이메일 말고 사용자 이름을 적고" — 집계 키(_dailyUsageBuffer/
// _minuteUsageBuffer/UsageStats DO)는 계속 email을 유일 식별자로 쓰되(이름은
// 동명이인 가능성이 있어 키로 부적합), 화면에 보여줄 때만 이름으로 바꿔
// 치환할 수 있도록 세션에 이미 담겨 있는 memberName(로그인 시점에 회원
// 시트에서 조회해 고정된 값 — 별도 시트 재조회 불필요)을 email과 함께
// 기억해둔다. isolate 재시작 시 비워져도 무해(그 경우 이메일로 대체 표시).
const _emailNameMap = new Map(); // email -> memberName

// 🔧 [사용자 지시] "여기 이메일로 보이는데?" — _emailNameMap이 isolate
// 로컬이라 "이 요청을 처리한 isolate가 그 사용자를 아직 못 봤으면"
// 이메일 그대로 보이는 문제가 있었다. 새로 관측된 (email, name) 쌍만
// 여기 모아뒀다가 flushDailyUsageStats가 DO(UsageStats)에도 영구
// 저장해, 어느 isolate가 응답을 만들든 DO의 전체 매핑을 참조할 수
// 있게 한다.
const _pendingNameFlush = new Map(); // email -> memberName (아직 DO로 안 보낸 것만)

function _bumpKvUsageCounter(op, prefix, path, email, name) {
  if (email && name && _emailNameMap.get(email) !== name) {
    _emailNameMap.set(email, name);
    _pendingNameFlush.set(email, name);
  }
  const minuteKey = new Date().toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"

  // 🔧 [사용자 지시] "일일에서도 - 뒤에 캐시 유발 지점을 출력해줘" —
  // kind(캐시 키 종류)도 하루 누적 키에 포함시켜, "30분" 뷰와 마찬가지로
  // 어떤 캐시가 원인인지 바로 알 수 있게 한다.
  const dailyKey = `${todayUTCDateString()}|${prefix}|${path || "(cron/기타)"}|${email || "(익명)"}|${op}`;
  _dailyUsageBuffer.set(dailyKey, (_dailyUsageBuffer.get(dailyKey) || 0) + 1);

  const minuteBucketKey = `${minuteKey}|${prefix}|${path || "(cron/기타)"}|${email || "(익명)"}|${op}`;
  _minuteUsageBuffer.set(minuteBucketKey, (_minuteUsageBuffer.get(minuteBucketKey) || 0) + 1);
}


// "최근 5분간 kv_put:sheetCache:9 라고 찍혀" — 콜론 1개까지만 잘라
// 접두사를 만들면 sheetCache:exitStatus:.../sheetCache:memberRows:... 등
// 서로 다른 캐시 키 종류가 전부 "sheetCache:" 하나로 뭉뚱그려진다.
// sheetCache:(KV_CACHE_PREFIX)로 시작하는 키만 특별 취급해 그 다음
// 세그먼트(캐시 키 종류: exitStatus/memberRows/outputPenSlots 등)까지
// 포함해 두 번째 콜론까지 자른다 — 나머지(report:/leaveq:/exitRequest:
// 등)는 원래대로 첫 콜론까지만.
function _kvKeyPrefix(key) {
  const idx = key.indexOf(":");
  if (idx === -1) return key;
  const firstPrefix = key.slice(0, idx + 1);
  if (firstPrefix !== KV_CACHE_PREFIX) return firstPrefix;
  const secondIdx = key.indexOf(":", idx + 1);
  return secondIdx === -1 ? key : key.slice(0, secondIdx + 1);
}

// 🔧 [사용량 모니터링 고도화, 2026-09-11] requestEmail은 fetch 최상단에서
// 딱 한 번 선제적으로 verifySession한 결과다(§fetch 진입부 주석 참고) —
// 각 핸들러 내부의 실제 권한 판정(requireAdmin 등)과는 별개로, "누가
// 이 KV 호출을 유발했는지" 집계용으로만 쓰인다.
function instrumentKvNamespace(kv, requestPath, requestEmail, requestName) {
  return {
    ...kv,
    get: kv.get.bind(kv),
    getWithMetadata: kv.getWithMetadata ? kv.getWithMetadata.bind(kv) : undefined,
    // 🔧 [사용량 모니터링에 list() 추가] KV list()는 무료 플랜 하루
    // 1,000회 한도가 있고(put/delete와는 별도 할당량), 2026-08-27 실제로
    // 소진된 이력이 있다(leaveq:/report: 등을 인덱스 방식으로 리팩터링한
    // 계기) — put/delete와 동일하게 (prefix, 요청 경로)별로 세어 "Bot·Sheet"
    // 탭에서 어느 화면이 list()를 얼마나 자주 쓰는지 보이게 한다.
    list(opts) {
      const prefix = _kvKeyPrefix((opts && opts.prefix) || "(전체)");
      _bumpKvUsageCounter("kv_list", prefix, requestPath, requestEmail, requestName);
      console.log(`[kv list] path=${requestPath || "(cron/기타)"} prefix=${(opts && opts.prefix) || "(전체)"}`);
      return kv.list(opts);
    },
    put(key, value, opts) {
      const prefix = _kvKeyPrefix(key);
      _bumpKvUsageCounter("kv_put", prefix, requestPath, requestEmail, requestName);
      console.log(`[kv put] path=${requestPath || "(cron/기타)"} key=${key}`);
      return kv.put(key, value, opts);
    },
    delete(key) {
      const prefix = _kvKeyPrefix(key);
      _bumpKvUsageCounter("kv_delete", prefix, requestPath, requestEmail, requestName);
      console.log(`[kv delete] path=${requestPath || "(cron/기타)"} key=${key}`);
      return kv.delete(key);
    },
  };
}

// 🔧 [사용자 지시] "알아먹기 쉽게 실제 메뉴명을 적어줘" — API 경로 그대로
// 보여주던 걸, 프론트 각 화면 컴포넌트가 실제로 그 경로를 호출하는 이름
// (docs/CACHING_POLICY.md §12.2의 화면↔엔드포인트 매핑과 동일 기준)으로
// 바꿔 보여준다. 매핑에 없는 경로(신규 추가분 등)는 원래 경로를 그대로
// 보여줘 정보 유실이 없게 한다.
const _PATH_MENU_NAMES = {
  "/status": "내 대시보드",
  "/admin/usage": "사용량 모니터링",
  "/admin/bot/status": "도움봇 오퍼레이터",
  "/admin/bot/command": "도움봇 오퍼레이터",
  "/admin/members/roster": "참여 스터디원 목록",
  "/admin/members/parti-status": "참여 스터디원 목록",
  "/admin/members/reorder": "번호 정렬",
  "/admin/members/reorder-preview": "번호 정렬",
  "/admin/members": "신규 스터디원 등록",
  "/admin/blacklist": "신규 스터디원 등록",
  "/admin/open-slots": "신규 스터디원 등록",
  "/admin/members/grant-access": "신규 스터디원 등록",
  "/admin/captures": "화각 불량 제보 처리",
  "/admin/captures/decide": "화각 불량 제보 처리",
  "/admin/captures/delete": "화각 불량 제보 처리",
  "/admin/captures/revert": "화각 불량 제보 처리",
  "/admin/captures/vote": "화각 불량 제보 처리",
  "/admin/captures/cancel-penalty": "화각 불량 제보 처리",
  "/admin/captures/cancel-merit": "화각 불량 제보 처리",
  "/admin/captures/file": "화각 불량 제보 처리",
  "/my-output-pen": "내 제보 확인",
  "/captures/target-respond": "내 제보 확인",
  "/my-captures/delete": "내 제보 확인",
  "/roster-status": "RANK",
  "/admin/fines/status": "PEN · Money",
  "/admin/fines/admin-forced-count": "PEN · Money",
  "/admin/prize/settle": "PEN · Money",
  "/admin/leave-proof": "사유 반휴 신청 처리",
  "/admin/leave-proof/file": "사유 반휴 신청 처리",
  "/admin/leave-proof/decide": "사유 반휴 신청 처리",
  "/admin/leave-apply": "반휴 신청",
  "/leave-apply": "반휴 신청",
  "/reason-leave-proof": "반휴 신청",
  "/reason-leave-proof/cancel": "반휴 신청",
  "/exit-request": "퇴실 신청",
  "/exit-request/agree": "퇴실 신청",
  "/admin/exit/preview": "퇴실 처리",
  "/admin/exit/confirm": "퇴실 처리",
  "/admin/exit/blacklist": "퇴실 스터디원 목록",
  "/admin/members/exited": "퇴실 스터디원 목록",
  "/notify-prefs": "알림 설정",
  "/push/devices": "알림 설정",
  "/push/devices/remove": "알림 설정",
  "/push/devices/rename": "알림 설정",
  "/push/devices/toggle": "알림 설정",
  "/admin/push/send-category": "알림 설정",
  "/push/send-to-member": "빠른 공지",
  "/push/subscription-status": "빠른 공지",
  "/push/recent-notices": "최근 공지",
  "/status-message": "상태 메시지",
  "/member-status-message": "제보",
  "/report": "제보",
  "/report-cooldowns": "제보",
  "/report-status": "제보",
  "/reports": "제보",
  "/reports/capture-done": "제보",
  "/reports/requeue": "제보",
  "/participants": "체커(참여자 목록)",
  "/goal-schedule": "목표시간 설정",
  "(cron)": "정기 배치(cron)",
};

function _menuNameForPath(path) {
  if (!path) return "(cron/기타)";
  return _PATH_MENU_NAMES[path] || path;
}

// fileId를 명시적으로 받는다 — 원본 시트뿐 아니라 지난 기록(Drive 백업 파일)도
// 같은 조회 로직을 공유해야 하기 때문.
async function getSheetValues(env, accessToken, fileId, range) {
  _bumpUsageCounter("sheets_read");
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!data.values) throw new Error("시트 값 조회 실패: " + JSON.stringify(data));
  return data.values;
}

// 집계!D25(현재 페널티 사이클, 1~3주차 순환)는 개인 대시보드(/status)
// 하나를 조회할 때만도 buildPersonalStatus와 getReportScore가 각각 따로
// 읽어 요청 1건에 이 셀만 2번 조회했다. 15명이 동시에 /status를 열면
// 이 셀 하나 때문에 30회가 몰려 "분당 60회" 한도를 순식간에 갉아먹는다
// (2026-08 실제로 RESOURCE_EXHAUSTED 발생) — 매주 1~3만 순환하는 값이고
// Worker 쪽에서 이 셀에 쓰는 경로가 전혀 없어(앱스크립트 주간 트리거만
// 갱신) 캐싱해도 신선도 문제가 없다. KV에도 함께 저장해
// (_cacheSetAsync) 다른 사용자·다른 isolate 간에도 이 값이 공유되게 한다
// (docs/CACHING_POLICY.md §6, 2026-09).
//
// 🔧 [사용자 지시, 2026-09] "일주일에 한 번만 바뀌는데 5분마다 재확인하는
// 게 아깝다" — 앱스크립트 sheet_reset()이 리셋 직후 Worker에 즉시 무효화를
// 알려주도록 바꿨으니(MEMBER_CACHE_GROUPS.cycle), TTL은 "그 알림이 실패했을
// 때의 안전망"으로만 기능하면 된다. 2시간으로 크게 늘렸다 — 이 값은
// 제보 승인 시 슬롯에 그대로 기록되므로(applyOutputPenalty 등), 안전망이
// 너무 길면(예: 하루) 알림 실패 시 리셋 직후 최대 하루까지 잘못된 사이클
// 번호가 슬롯에 찍힐 위험이 있어, 그 노출 시간을 2시간으로 절충했다.
async function getCurrentPenCycle(env, accessToken, fileId) {
  return _cachedCompute(env, `penCycle:${fileId}`, 2 * 60 * 60_000, async () => {
    const rows = await getSheetValues(env, accessToken, fileId, "집계!D25");
    return parseInt((rows[0] && rows[0][0]) || "1", 10) || 1;
  });
}

// 여러 range를 한 번의 HTTP 요청(=Sheets API 쿼터 1회 소진)으로 조회한다.
// 15명을 매번 개별 getSheetValues로 순회하면 회원 수만큼 쿼터를 쓰게 되어
// "분당 읽기 요청 60회" 한도를 손쉽게 넘긴다 — 회원 목록 같은 반복 조회는
// 반드시 이 함수로 한 번에 묶어야 한다. 반환값은 요청한 range 순서와 동일한
// 배열([][][]) — 각 range마다 못 찾으면 빈 배열을 채워 넣는다.
async function batchGetSheetValues(env, accessToken, fileId, ranges) {
  if (ranges.length === 0) return [];
  _bumpUsageCounter("sheets_read");
  const query = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values:batchGet?${query}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!data.valueRanges) throw new Error("시트 값 일괄 조회 실패: " + JSON.stringify(data));
  return data.valueRanges.map((vr) => vr.values || []);
}

// D25(페널티 사이클)는 "1/3주차"처럼 커스텀 숫자 서식이 입혀져 있어 기본
// 렌더링으로는 텍스트로 온다. UNFORMATTED_VALUE로 조회해 실제 숫자(1/2/3)를 얻는다.
async function getSheetUnformattedValue(env, accessToken, fileId, range) {
  _bumpUsageCounter("sheets_read");
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${encodeURIComponent(
      range
    )}?valueRenderOption=UNFORMATTED_VALUE`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!data.values) throw new Error("시트 값 조회 실패: " + JSON.stringify(data));
  return data.values;
}

// 셀에 입력된 수식 원문을 그대로 읽는다(계산 결과가 아니라 "=INDIRECT(...)"
// 같은 문자열 자체) — _appendDataAuditSnapshot/rewriteBackupAuditFormulas가
// 백업 탭의 수식을 "데이터"에서 "데이터 (감사)" 참조로 치환할 때 원본 수식
// 문자열이 필요하다.
async function getSheetFormulas(env, accessToken, fileId, range) {
  _bumpUsageCounter("sheets_read");
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${encodeURIComponent(
      range
    )}?valueRenderOption=FORMULA`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!data.values) throw new Error("시트 수식 조회 실패: " + JSON.stringify(data));
  return data.values;
}

// 여러 셀 범위를 한 번에 기입한다 — valueRanges: [{ range: "1!B2", values: [["텍스트"]] }, ...]
// 특정 회원의 personalStatusBundle 캐시(개인 탭 원본 행 + outputPenSlots +
// reportScore, §캐싱 통합 2026-09 참고)를 인메모리+KV 양쪽에서 지운다.
// 시트에 직접 쓸 때(writeSheetValues)뿐 아니라, 시트를 안 건드리고 KV만
// 바꾸는 조작(퇴실 신청 등)이 depositRefundBreakdown처럼 이 번들이 감싸는
// 계산 결과에 영향을 줄 때도 재사용한다.
async function invalidatePersonalStatusCache(env, fileId, memberNumber) {
  const cacheKey = `personalStatusBundle:${fileId}:${memberNumber}`;
  _sheetCache.delete(cacheKey);
  _bumpCacheGeneration(cacheKey);
  await env.REPORTS_KV.delete(`${KV_CACHE_PREFIX}${cacheKey}`).catch(() => {});
}

async function writeSheetValues(env, accessToken, fileId, valueRanges) {
  _bumpUsageCounter("sheets_write");
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values:batchUpdate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: valueRanges }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error("시트 값 기입 실패: " + JSON.stringify(data));
  // 이 range가 어떤 회원의 개인 탭(시트명이 순수 숫자, 예: "7!C10")을 건드렸으면
  // 그 회원의 personalStatus 캐시만 정확히 지운다 — 반휴 신청/제보 승인 등
  // 19곳의 쓰기 지점 각각에 무효화를 흩어 넣는 대신 여기 한 곳에서 처리해
  // "방금 쓴 값이 캐시 때문에 본인 화면에 안 보이는" 정합성 문제를 막는다.
  // 🔧 [KV 무효화 누락 수정] 예전엔 인메모리(_sheetCache)만 지웠는데, 이
  // 요청을 처리한 isolate와 회원 본인이 새로고침할 때 뜬 isolate가 다르면
  // (Workers가 요청을 여러 isolate로 분산하므로 흔함) 그 isolate는 KV에
  // 남은 옛 값을 30분 TTL 내내 그대로 돌려줬다 — "방금 쓴 값이 안 보이는
  // 문제는 없다"던 원래 전제가 KV 계층에서는 성립하지 않았던 실제 버그.
  const kvDeletes = [];
  for (const { range } of valueRanges) {
    const sheetName = (range.split("!")[0] || "").replace(/^'|'$/g, "");
    if (/^\d+$/.test(sheetName)) {
      kvDeletes.push(invalidatePersonalStatusCache(env, fileId, sheetName));
    }
  }
  if (kvDeletes.length) await Promise.all(kvDeletes);
  return data;
}

// 🔧 [429 방지 — 2계층 캐시] Sheets API 읽기 쿼터(분당 60회/사용자)를 아낀다.
// 인메모리(모듈 스코프 Map)만으로는 불충분하다는 걸 실측으로 확인했다
// (2026-08): Cloudflare Workers는 요청을 여러 독립된 isolate로 분산하고,
// 각 isolate가 자기만의 모듈 스코프를 갖기 때문에 — 브라우저 하나가 같은
// TCP 연결을 재사용하며 연달아 조회할 때만 인메모리 캐시가 히트하고,
// 서로 다른 사용자(또는 새 연결)가 요청하면 사실상 매번 캐시 미스가 나서
// 15명이 각자 접속하는 정상적인 사용 패턴에서도 분당 60회를 순식간에
// 넘겨 429가 재현됐다. 그래서 캐시를 KV(REPORTS_KV, 계정 전체에서 전역
// 공유됨)에도 함께 저장한다 — 인메모리는 "같은 isolate 안에서 즉시 재사용"
// 용도로 그대로 남기고(레이턴시 이득), KV는 "다른 isolate/사용자끼리도
// 공유" 용도로 추가한다. KV 쓰기는 하루 1,000회로 Sheets 읽기(분당 60)
// 보다 훨씬 빡빡하므로, _cacheSet은 캐시 미스가 났을 때만(=TTL 동안
// 최초 1회만) 호출되는 지금 구조를 그대로 유지해 쓰기 폭주를 피한다.
const _sheetCache = new Map(); // key -> { value, expiresAt } (인메모리, 1차)
const KV_CACHE_PREFIX = "sheetCache:";

function _cacheGet(key) {
  const entry = _sheetCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    _sheetCache.delete(key);
    return undefined;
  }
  return entry.value;
}

// KV(2차, isolate 경계를 넘어 공유됨)까지 확인하는 비동기 버전. 히트하면
// 인메모리에도 채워 같은 isolate의 다음 요청은 KV 왕복 없이 즉시 반환한다.
async function _cacheGetAsync(env, key) {
  const local = _cacheGet(key);
  if (local !== undefined) return local;
  try {
    const raw = await env.REPORTS_KV.get(`${KV_CACHE_PREFIX}${key}`);
    if (!raw) return undefined;
    const entry = JSON.parse(raw);
    if (Date.now() > entry.expiresAt) return undefined;
    _sheetCache.set(key, entry);
    return entry.value;
  } catch {
    return undefined;
  }
}

function _cacheSet(key, value, ttlMs) {
  _sheetCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  // _bumpUsageCounter와 동일한 저비용 방어책 — _sheetCache는 만료된 항목을
  // "다시 읽힐 때만" 지우는 지연삭제뿐이라, 한 번 쓰고 다시 안 읽는 키는
  // isolate가 오래 살아있으면 계속 쌓일 수 있다(실무 위험은 낮지만 공짜로
  // 막을 수 있어 추가). 항목이 많아지면 이미 만료된 것들만 훑어 지운다.
  if (_sheetCache.size > 300) {
    const now = Date.now();
    for (const [k, entry] of _sheetCache) {
      if (now > entry.expiresAt) _sheetCache.delete(k);
    }
  }
}

// 인메모리 + KV 양쪽에 쓴다. KV expirationTtl은 최소 60초라는 제약이 있어,
// 그보다 짧은 ttlMs를 그대로 넘기면 Cloudflare가 에러를 낸다 — KV의 만료는
// 넉넉히(ttl의 4배 또는 최소 60초) 잡고, 실제 "몇 초짜리 캐시인지" 판단은
// 우리가 저장한 expiresAt 값으로 한다(만료된 값은 위 _cacheGetAsync가 걸러냄).
async function _cacheSetAsync(env, key, value, ttlMs) {
  _cacheSet(key, value, ttlMs);
  try {
    const expiresAt = Date.now() + ttlMs;
    await env.REPORTS_KV.put(`${KV_CACHE_PREFIX}${key}`, JSON.stringify({ value, expiresAt }), {
      expirationTtl: Math.max(60, Math.ceil((ttlMs * 4) / 1000)),
    });
  } catch {
    // KV 저장 실패해도 인메모리 캐시는 이미 세팅됐으니 이번 요청은 정상 진행한다.
  }
}

// 캐시가 비어있는 순간(콜드 상태 직후, 또는 TTL 만료 직후) 같은 isolate로
// 여러 요청이 거의 동시에 몰리면, 다들 "캐시에 없네"를 보고 각자 compute()를
// 처음부터 실행해 시트를 중복으로 읽는다(cache stampede) — 실측: 관리자
// 페이지 하나에 여러 섹션이 동시에 마운트되며 겪음(2026-08). 이미 같은
// 키를 계산 중인 Promise가 있으면 새로 계산하지 않고 그 결과를 나눠 쓰게
// 해서, 동시 요청이 몇 개든 실제 compute()는 1회만 실행되게 한다. 계산이
// 끝나면(성공/실패 무관) in-flight 등록을 지운다 — 실패를 캐시하지 않아
// 다음 요청이 재시도할 수 있게 하기 위함이다.
const _inFlight = new Map(); // key -> Promise<value>

// invalidateMemberCache/writeSheetValues의 무효화는 _inFlight를 전혀 모른다
// — 계산이 이미 진행 중일 때 무효화가 일어나면, 그 계산은 "무효화 이전
// 시점"의 낡은 데이터를 읽고 있는 셈인데 끝나고 나서 그 낡은 값을 새
// TTL로 다시 캐시에 써버려 방금 한 무효화를 무의미하게 만든다(실측 아님,
// 코드 검토로 확인된 경쟁 조건 — 2026-08). 세대 번호를 두고, 계산 시작
// 시점의 세대를 기억해뒀다가 끝난 뒤 세대가 그대로일 때만 캐시에 쓴다 —
// 계산 도중 무효화가 끼어들었으면 이번 결과는 호출자에게만 돌려주고
// 캐시는 건드리지 않아, 다음 요청이 진짜 최신 값을 다시 읽게 한다.
//
// invalidateMemberCache는 9개 prefix(members:/meta:/exitStatus:/memberRows:/
// reportScore:/outputPenSlots:/penSlotGrid:/weeklyPaidFine:/rosterStatus:)를
// 항상 통째로(부분적으로가 아니라) 무효화하므로, 이 그룹 전체에 대해 키
// 하나짜리 전역 카운터만 두면 충분하다 — 회원별로 갈라지는 outputPenSlots:/
// reportScore:는 아직 계산 중이라 특정 회원 키가 _sheetCache에 존재하지도
// 않는 시점에 무효화가 끼어들 수 있어(그래서 키별 Map으로는 놓칠 수 있음),
// "이 그룹에 속하는 키인지"만 판별해 그룹 공통 카운터를 쓰는 편이 더
// 정확하다. personalStatusBundle:(writeSheetValues가 개별 무효화)처럼
// 정확히 어떤 키를 지우는지 아는 경우는 키별 Map으로 정밀하게 추적한다.
// 🔧 [중복 캐시 통합, 2026-09-10] meritRank: 캐시 키는 폐지됐다 —
// getMeritRank가 rosterStatus:(buildRosterStatus)를 그대로 재사용하도록
// 바뀌었다(§16 참고). 이 목록에서도 제거.
// 🔧 [캐싱 통합, 2026-09] reportScore:/outputPenSlots: 캐시 키는 폐지됐다 —
// personalStatusBundle:(§getPersonalStatusBundle)이 셋(개인 탭 원본 포함)을
// 하나로 합쳐 캐싱한다. 이 목록에서도 제거(personalStatusBundle:은 회원별
// 키라 fileId당 1개를 전제하는 이 prefix 목록·MEMBER_CACHE_UNCONDITIONAL_KEYS
// 방식으로는 지울 수 없고, invalidateMemberSlotCache/invalidatePersonalStatusCache
// 가 회원 번호를 알 때 개별적으로 지운다 — 기존 personalStatus:도 항상 이
// 방식이었다).
const MEMBER_CACHE_PREFIXES = [
  "members:",
  "meta:",
  "exitStatus:",
  "memberRows:",
  "penSlotGrid:",
  "weeklyPaidFine:",
  "rosterStatus:",
  "adminMemberList:",
  "dataSheetRows:",
  "coReviewers:",
];
let _memberCacheGeneration = 0;
const _cacheGeneration = new Map(); // key -> generation number (member-cache 그룹 외의 개별 키용)

function _isMemberCacheKey(key) {
  return MEMBER_CACHE_PREFIXES.some((p) => key.startsWith(p));
}

function _currentGeneration(key) {
  return _isMemberCacheKey(key) ? _memberCacheGeneration : _cacheGeneration.get(key) || 0;
}

function _bumpCacheGeneration(key) {
  if (_isMemberCacheKey(key)) {
    _memberCacheGeneration += 1;
  } else {
    _cacheGeneration.set(key, (_cacheGeneration.get(key) || 0) + 1);
  }
}

function _bumpMemberCacheGeneration() {
  _memberCacheGeneration += 1;
}

async function _cachedCompute(env, key, ttlMs, compute) {
  const cached = await _cacheGetAsync(env, key);
  if (cached !== undefined) return cached;

  const existing = _inFlight.get(key);
  if (existing) return existing;

  const generationAtStart = _currentGeneration(key);
  const promise = (async () => {
    try {
      const value = await compute();
      if (_currentGeneration(key) === generationAtStart) {
        await _cacheSetAsync(env, key, value, ttlMs);
      }
      return value;
    } finally {
      _inFlight.delete(key);
    }
  })();
  _inFlight.set(key, promise);
  return promise;
}

// 🔧 [KV → DO 이전, 2026-09-11] "진행 중인 제보 쿨다운"/"최근 전송된 알림"
// 목록은 예전엔 여기(REPORTS_KV)에 "파일당 1개 키 + CAS 유사 재시도"
// 방식의 라이브 인덱스로 있었다(list() 자체는 이미 없앤 상태였다). 이제는
// 둘 다 ParticipantsRoster Durable Object의 메모리 상태로 옮겨졌다
// (checkReportCooldown/recordReportCooldown/markReportCaptureDone/
// listReportCooldowns, checkNoticeCooldown/recordNotice/listRecentNotices —
// §ParticipantsRoster 클래스 정의 참고). DO는 단일 인스턴스가 요청을
// 직렬 처리하므로 이 절이 다루던 CAS 재시도 로직 자체가 필요 없어져
// 삭제했다 — 자세한 배경은 `docs/CACHING_POLICY.md` §24.2.

// 🔧 [KV → DO 이전, 2026-09-12] leaveq:(사유반휴 봇 오프라인 대기열)와
// 그 전용 인덱스(leaveqIndex:current)를 LeaveQueue DO로 옮겼다. 이전엔
// "자연 만료(TTL)가 없고 봇이 몇 시간 꺼져 있어도 반드시 살아남아야
// 하는 성격이라 DO의 휘발성 메모리로 옮기기엔 안 맞는다"(§24.3)고
// 판단해 KV에 남겨두고, list() 회피용으로 KV 안에서만 별도 인덱스를
// 뒀었다. §46에서 확인했듯 그 우려는 "순수 메모리 DO"에만 해당한다 —
// LeaveQueue는 UsageStats/ReportQueue와 동일하게 state.storage로
// 영속화되므로 재시작해도 전량 복원된다. 인덱스 전용 전역 락
// (leaveQueueIndex:global)도 DO가 요청을 직렬 처리해 경쟁 조건이
// 구조적으로 불가능해지므로 함께 사라졌다(§47 참고). 회원 단위 락
// (`leave:${memberNumber}`, "같은 회원이 같은 날 중복 신청하는 것" 방지
// 목적)은 인덱스 보호와 무관하므로 그대로 유지된다.
async function _readLeaveQueueIndex(env) {
  const res = await getLeaveQueueStub(env).fetch("https://do/leaveq/list");
  const { items } = await res.json();
  return items || [];
}

// 🔧 [PEN·MONEY 사이클 토글] 사유반휴 신청은 승인/반려 즉시 큐(leaveq:*)와
// 봇 manifest에서 삭제되어 처리 이력이 어디에도 남지 않는다 — 지난 사이클
// 조회를 지원하려면 처리 시점에 별도 영구 로그가 필요하다(사용자 지시).
// 시트 백업과 동일한 "그 주(월요일 weekOf)" 단위로 묶어, 키 하나
// (LeaveQueue DO의 history:{weekOf})에 그 주 처리 기록 전체를 배열로
// 누적한다 — TTL 없이 영구 보관. 처리는 항상 "지금"(과거 사이클을
// 재처리할 방법은 없음) 일어나므로, weekOf는 항상
// currentWeekMondayKST()(처리 시각=지금 기준)로 계산한다 — 사이클 조회
// 시 백업 파일의 weekOf와 그대로 매칭된다. 🔧 [KV → DO 이전, 2026-09-12]
// §47 참고 — get()/put()만 쓰고 list()와는 원래 무관했지만, leaveq:/
// exitRequest:와 같은 도메인(LeaveQueue DO)에 함께 두어 일관성을
// 맞췄다.
async function _appendLeaveHistory(env, entry) {
  const weekOf = formatYYMMDD(currentWeekMondayKST());
  await getLeaveQueueStub(env).fetch("https://do/history/append", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ weekOf, entry }),
  });
}

async function _readLeaveHistory(env, weekOf) {
  const res = await getLeaveQueueStub(env).fetch(`https://do/history/get?weekOf=${encodeURIComponent(weekOf)}`);
  const { items } = await res.json();
  return items || [];
}

// fileId당 키가 하나뿐이라 무조건 KV .delete() 대상이 되는 종류(회원별로
// 갈라지는 outputPenSlots:/reportScore:는 별도 처리 — 아래 함수의 prefix
// 루프에서 인메모리에 존재하는 것만 지운다).
//
// 🔧 [사용자 지시, 2026-09] penCycle 추가 — 매주 앱스크립트 sheet_reset()이
// 시트에 직접 쓰는 값(집계!D25)이라 Worker 쪽 쓰기 경로가 없어 원래
// 무효화 그룹 밖이었다. 그러다 보니 "일주일에 한 번만 바뀌는 값"인데도
// TTL(5분)만큼 자주 재확인·재기록됐다 — 앱스크립트가 리셋 직후
// `_notifyWorkerCacheInvalidate({groups:["cycle"]})`로 즉시 알려주도록
// 바꾸고(study_sw/assets/appscript.js), 그 대신 TTL을 2시간으로 크게
// 늘렸다(getCurrentPenCycle). 알림이 실패해도(네트워크 오류 등) 최악의
// 경우 2시간 안에는 자연 TTL 만료로 스스로 정정된다 — 제보 승인 시
// 이 값을 슬롯에 그대로 기록하므로(applyOutputPenalty 등), 리셋 직후
// 오래 낡아있으면 잘못된 사이클 번호가 슬롯에 찍힐 위험이 있어 하루
// 종일 같은 긴 TTL 대신 2시간으로 절충했다.
const MEMBER_CACHE_UNCONDITIONAL_KEYS = ["members", "meta", "exitStatus", "memberRows", "penSlotGrid", "weeklyPaidFine", "penCycle", "rosterStatus", "adminMemberList", "dataSheetRows", "coReviewers"];

// 🔧 [불필요한 KV 삭제 절감, 2026-09] 호출부가 실제로 건드린 시트 범위에
// 맞는 그룹만 넘기면, 무관한 캐시까지 매번 함께 지우는 낭비를 피할 수 있다
// — 특히 가장 빈번한 제보 처리(penalty)가 회원 명단/시트 메타/상점 순위/
// 개인 탭 배치처럼 무관한 4종까지 매번 함께 지우고 있었다
// (docs/CACHING_POLICY.md §11 실측 근거).
const MEMBER_CACHE_GROUPS = {
  // 회원 명단/시트 구조 자체가 바뀌는 저빈도 조작(신규등록/퇴실/번호이동)
  // 전용 — 9종 전부와 관련 있으므로 groups를 생략(=전체)했을 때와 동일하다.
  // 🔧 [캐싱 통합, 2026-09] reportScore/outputPenSlots는 personalStatusBundle
  // 로 흡수됐다 — 이 그룹이 실제로 회원별 캐시까지 지우는 경로는 여전히
  // invalidateMemberSlotCache(각 호출부가 번호를 알 때 명시 호출)가 담당한다.
  roster: [...MEMBER_CACHE_UNCONDITIONAL_KEYS], // penCycle/rosterStatus/adminMemberList 포함 9종 전부
  // 제보 승인/취소/반려·유예 — 벌점(outputPenSlots)·제보상점(reportScore)
  // 슬롯만 바뀐다. 다음 슬롯 미리보기(penSlotGrid)와 퇴실 후보 판정
  // (exitStatus)도 이 슬롯을 입력으로 쓰므로 함께 포함한다.
  //
  // 🔧 [의도적 방치, 2026-09-10] rosterStatus(RANK/MY 탭이 함께 쓰는 상점·
  // 순위 캐시, §16)는 실제로 이 그룹의 변경에 영향받지만(집계 F열 수식이
  // 페널티 유무를 조건으로 삼음), 표시만 최대 30분 지연될 뿐 다른 데이터
  // 정합성엔 영향이 없다고 판단해 이 그룹에서 의도적으로 뺐다(사용자 확인,
  // 원래는 meritRank: 캐시 단독 논의였으나 §16에서 getMeritRank가
  // rosterStatus를 재사용하도록 통합되며 이 판단도 함께 적용된다).
  // 🔧 [캐싱 통합, 2026-09] outputPenSlots/reportScore가 personalStatusBundle
  // 로 흡수되며 이 그룹에서도 빠졌다 — 제보 처리 호출부는 이미 전부
  // invalidateMemberSlotCache(대상자·제보자 번호)를 함께 호출해 그 회원의
  // personalStatusBundle을 명시적으로 지운다(§invalidateMemberSlotCache 참고).
  penalty: ["exitStatus", "penSlotGrid"],
  // 벌금 납부 상태 변경 — 개인 탭 31행(납부확인)만 바뀐다.
  fine: ["exitStatus", "memberRows", "weeklyPaidFine"],
  // 퇴실 신청/동의/취소(LeaveQueue DO) — exitStatus 계산의 입력값만 바뀐다.
  exitRequest: ["exitStatus"],
  // 참여상태(부스터디장 임명 등, 개인 탭 L3) 변경. coReviewers는 이 값을
  // 그대로 캐싱한 것이라 함께 무효화해야 임명/해제가 "송출 P 대상 처리"에
  // 즉시 반영된다(§getCurrentCoReviewers 참고).
  partiStatus: ["exitStatus", "coReviewers"],
  // 앱스크립트 sheet_reset()이 매주 집계!D25(페널티 사이클)를 갱신한
  // 직후 호출하는 전용 그룹 — penCycle 하나만 좁게 지운다.
  cycle: ["penCycle"],
  // 🔧 [RANK 탭 캐싱 추가, 2026-09-10] "상금 정산 집행" 마킹(집계!P6)처럼
  // rosterStatus(buildRosterStatus 결과)에만 영향을 주는 저빈도 조작 전용.
  rosterOnly: ["rosterStatus"],
  // 🔧 [members: TTL 상향 대응, 2026-09-11] members:가 10분→2시간으로 늘면서,
  // 제보 승인(applyOutputPenalty)/제보상점 지급(applyReportMerit)이 "이
  // 닉네임/이메일이 몇 번 회원인지"를 낡은 명단으로 잘못 확정해 벌점을
  // 엉뚱한 회원(번호 재사용 시)에게 적을 위험이 생긴다 — 하루 10건 미만인
  // 저빈도 액션이라, listAllMembers 호출 직전에 이 좁은 그룹만 무효화해
  // 그 즉시 최신 명단으로 다시 계산되게 한다(§members 참고). members는
  // dataSheetRows에서 파생되므로 dataSheetRows도 함께 지워야 "새로
  // 계산하지만 재료는 낡은" 상태를 피할 수 있다. exitStatus/penSlotGrid
  // 등 무관한 캐시까지 지우는 기본 roster 그룹보다 좁게 잡아 불필요한
  // KV 삭제를 아낀다.
  memberIdentity: ["members", "dataSheetRows"],
  // 🔧 [사용자 지시, 2026-09-11] "신규 등록이 왜 벌점/벌금/사이클 캐시까지
  // 매번 지우나" — handleAdminCreateMember가 실제로 쓰는 셀은 개인탭
  // B2/I2/L3/O3와 데이터!D/E열뿐이라(시트 생성·삭제 없음), 그 범위와
  // 무관한 meta:(탭 구조)/penSlotGrid:(데이터!F~K)/weeklyPaidFine:
  // (집계!D22)/penCycle:(집계!D25, 앱스크립트 전용)은 낡지 않는다 —
  // roster 그룹(9종 전부)보다 좁혀 이 4종의 불필요한 KV 삭제를 아낀다.
  // members/dataSheetRows(이메일 D/E열)·exitStatus·memberRows(참여상태
  // L3 등)·rosterStatus(집계 수식이 B2/L3를 즉시 반영)·adminMemberList
  // (members 경유)·coReviewers(members 의존, 보수적으로 포함)는 실제로
  // 낡으므로 그대로 남긴다. 번호 재사용 시 잔존 개인별 캐시는 이 그룹과
  // 별개로 invalidateMemberSlotCache가 이미 방어한다(handleAdminCreateMember
  // 호출부 참고).
  newMember: ["members", "dataSheetRows", "exitStatus", "memberRows", "rosterStatus", "adminMemberList", "coReviewers"],
};

// 시트 구조(권한관리·데이터 D~V 등)를 바꾸는 쓰기 작업 뒤에 호출해 캐시가
// 오래된 명단/메타를 계속 돌려주지 않게 한다. 인메모리는 즉시 지우고,
// KV는 비동기로 지운다(호출부가 await하지 않아도 되도록 fire-and-forget).
// groups를 생략하면 기존과 동일하게 9종 전부를 무효화한다(안전한 기본값) —
// 호출부가 실제로 어떤 시트 범위를 바꿨는지 확실할 때만 좁은 그룹을 넘겨
// 무관한 KV 삭제를 줄인다(docs/CACHING_POLICY.md §11).
//
// 🔧 [사용자 지시, 2026-09-10] "예치금 재납/벌금 납부는 지난주 시트에도
// 쓸 수 있어야 한다" — 이 함수는 원래 KV 쪽 무조건 삭제 대상(9종 중 7종)의
// 파일 구분을 env.GOOGLE_SHEET_FILE_ID로 하드코딩하고 있었다. 벌금 처리가
// 이제 과거 사이클(백업 fileId)에도 쓸 수 있게 되면서, 그 경우 무효화도
// 같은 백업 fileId를 대상으로 해야 한다 — 기본값은 그대로 현재 시트라
// 기존 호출부(전부 세 번째 인자를 안 넘김)는 동작이 전혀 바뀌지 않는다.
function invalidateMemberCache(env, groups, fileId) {
  const targetFileId = fileId || (env && env.GOOGLE_SHEET_FILE_ID);
  const activeKeys = groups ? [...new Set(groups.flatMap((g) => MEMBER_CACHE_GROUPS[g]))] : MEMBER_CACHE_GROUPS.roster;
  const activePrefixes = activeKeys.map((name) => `${name}:`);
  // 인메모리는 그룹 전체를 늘 세대 카운터 하나로 무효화한다(공짜 — 좁혀도
  // KV 삭제 횟수가 줄지 않으므로 아낄 이유가 없고, 좁히면 오히려 "이번엔
  // 무효화 안 된 인메모리 키가 남아있는" gap이 생길 위험만 커진다).
  // 🔧 [경쟁 조건 수정] 지금 진행 중인 계산(_inFlight, 아직 _sheetCache에
  // 없어 아래 루프에 안 걸리는 것들 포함)이 있다면, 그 계산이 끝나도
  // _cachedCompute가 세대 불일치를 감지해 캐시에 쓰지 않는다.
  _bumpMemberCacheGeneration();
  const kvDeletes = [];
  for (const key of _sheetCache.keys()) {
    if (activePrefixes.some((p) => key.startsWith(p))) {
      _sheetCache.delete(key);
      if (env) kvDeletes.push(env.REPORTS_KV.delete(`${KV_CACHE_PREFIX}${key}`).catch(() => {}));
    }
  }
  // exitStatus/memberRows/members/meta/penSlotGrid/weeklyPaidFine/rosterStatus는
  // fileId별로 키가 하나뿐이라 인메모리에 아직 없어도(다른 isolate가 채운
  // KV 항목일 수 있음) KV 쪽은 무조건 지운다 — 이번 호출이 실제로 건드린
  // 그룹에 속하는 것만.
  if (env) {
    for (const name of MEMBER_CACHE_UNCONDITIONAL_KEYS) {
      if (activeKeys.includes(name)) {
        kvDeletes.push(env.REPORTS_KV.delete(`${KV_CACHE_PREFIX}${name}:${targetFileId}`).catch(() => {}));
      }
    }
  }
  return Promise.all(kvDeletes);
}

// outputPenSlots:/reportScore:는 회원별 키라 invalidateMemberCache가 KV를
// 콕 집어 못 지운다(위 주석 참고) — 원래는 performExitReset/moveMemberSlot/
// handleAdminCreateMember(번호 재사용 대비, 2026-09)처럼 "번호 1개당 1회"만
// 실행되는 저빈도 관리자 조작에서만 호출해, 그 번호에 한해 KV까지 명시적으로
// 지웠다.
//
// 🔧 [사용자 지시, 2026-09] "제보 승인/취소 후 최대 5분/30분 지연도 즉시
// 삭제로 바꿔라" — 하루 제보 처리 건수가 많아야 10건 내외임을 확인해(건당
// 최대 2명 × 2개 캐시 = 하루 40회 미만 추가 삭제, KV 예산에 무시할 수준),
// applyOutputPenalty/applyReportMerit/cancelOutputPenalty/cancelReportMerit
// 호출부(handleAdminCaptureCancel/CancelMerit/Decide/Delete/Revert 등
// invalidateMemberCache(env, ["penalty"]) 호출 6곳)에서도 그 액션이 실제로
// 건드린 회원 번호(대상자·제보자, 최대 2명)에 한해 이 함수를 함께 호출한다
// — "번호 재사용" 대비용으로 좁게 쓰이던 함수가 이제 일반적인 제보 처리
// 경로에서도 쓰인다.
// 🔧 [캐싱 통합, 2026-09] outputPenSlots/reportScore가 personalStatusBundle:
// 하나로 합쳐지면서(§getPersonalStatusBundle), 이 둘을 개별적으로 지우던
// 과거 키(outputPenSlots:/reportScore:)는 더 이상 존재하지 않는다 —
// personalStatusBundle: 하나만 지우면 셋(개인 탭 원본 포함) 다 함께
// 재계산된다.
// fileId를 생략하면 항상 "지금 진행 중인" 현재 시트(env.GOOGLE_SHEET_FILE_ID)
// 기준으로 지운다 — 기존 호출부(벌점/상점 처리 등)는 전부 현재 시트만
// 다루므로 이 기본값으로 충분하다. 과거 백업 파일도 다룰 수 있는 호출부
// (computeExitResult 등)는 실제로 조회한 sourceFileId를 명시해야 그 파일의
// 캐시가 정확히 지워진다.
function invalidateMemberSlotCache(env, memberNumber, fileId) {
  if (!env) return Promise.resolve();
  const targetFileId = fileId || env.GOOGLE_SHEET_FILE_ID;
  const cacheKey = `personalStatusBundle:${targetFileId}:${memberNumber}`;
  _sheetCache.delete(cacheKey);
  return env.REPORTS_KV.delete(`${KV_CACHE_PREFIX}${cacheKey}`).catch(() => {});
}

// 스프레드시트 메타(모든 탭의 sheetId/title)를 가져온다. 시트 복사/삭제/서식
// 지정은 이름이 아니라 숫자 sheetId를 요구하므로, 이름→sheetId 매핑에 쓰인다.
// sheetId는 시트를 삭제·재생성(회원 등록/퇴실 시)해야만 바뀌고 그때마다
// invalidateMemberCache가 무효화하므로, 그 사이엔 몇 분을 캐싱해도 안전하다.
// 🔧 [2026-09-11] 5분→10분 — 유일한 정기 폴링 소비처(MemberRosterList,
// "참여 스터디원 목록")의 폴링을 30분으로 늘리면서, 같이 의존하는
// dataSheetRows:(10분)와 배율을 맞췄다. 애초에 5분이었을 때도 15분 폴링이
// 이미 5분보다 훨씬 길어 TTL이 쓰기 횟수의 병목이 아니었으므로(폴링 빈도가
// 병목), 10분으로 올려도 신선도·쓰기 횟수 둘 다 사실상 그대로다.
async function getSpreadsheetMeta(env, accessToken, fileId) {
  return _cachedCompute(env, `meta:${fileId}`, 10 * 60_000, async () => {
    _bumpUsageCounter("sheets_read");
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${fileId}?fields=sheets.properties`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await res.json();
    if (!data.sheets) throw new Error("시트 메타 조회 실패: " + JSON.stringify(data));
    return data.sheets.map((s) => s.properties);
  });
}

async function getSheetIdByName(env, accessToken, fileId, sheetName) {
  const sheets = await getSpreadsheetMeta(env, accessToken, fileId);
  const found = sheets.find((s) => s.title === sheetName);
  return found ? found.sheetId : null;
}

// 여러 시트 이름의 sheetId를 한 번의 메타 조회로 함께 찾는다. performExitReset/
// performDepositAgainReset처럼 한 흐름 안에서 getSheetIdByName을 연달아
// 여러 번(백업 시트 존재 확인/회원 시트/template) 호출하면 그때마다 스프레드시트
// 전체 메타를 새로 fetch해 API 요청이 불필요하게 늘어난다 — 한 번만 조회해 재사용한다.
async function getSheetIdsByNames(env, accessToken, fileId, sheetNames) {
  const sheets = await getSpreadsheetMeta(env, accessToken, fileId);
  const byTitle = new Map(sheets.map((s) => [s.title, s.sheetId]));
  return Object.fromEntries(sheetNames.map((name) => [name, byTitle.has(name) ? byTitle.get(name) : null]));
}

// 여러 batchUpdate 요청(시트 복사/삭제/서식/보호 등)을 한 번에 실행한다.
async function spreadsheetBatchUpdate(env, accessToken, fileId, requests) {
  _bumpUsageCounter("sheets_write");
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${fileId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("시트 구조 변경 실패: " + JSON.stringify(data));
  return data;
}

// 시트를 복제해 새 이름을 붙인다. 원본과 대상이 다른 스프레드시트일 수도
// 있다 — sheet_reset(월요일 새벽 초기화) 이후 정산 확정 처리 시, 이미
// 초기화된 원본이 아니라 "지난 주 백업 파일"에서 회원 시트를 가져와야 하는
// 경우(performExitReset) 이 경로를 쓴다(사용자 지시: "관리자가 확정 처리를
// 할 때만 시트에 백업이 생기고, 리셋 이후에도 지난 주 데이터로 계산").
// 반환값은 destFileId에 새로 생긴 시트의 sheetId.
async function copySheetToSpreadsheet(env, accessToken, sourceFileId, sourceSheetId, destFileId, newName) {
  _bumpUsageCounter("sheets_write");
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sourceFileId}/sheets/${sourceSheetId}:copyTo`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ destinationSpreadsheetId: destFileId }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error("시트 복사 실패: " + JSON.stringify(data));
  // 원본(template 등)이 숨김 상태면 복사본도 숨김 상태를 그대로 물려받는다.
  // 새로 만든 탭은 항상 보이게 해야 하므로 명시적으로 hidden: false를 강제한다.
  await spreadsheetBatchUpdate(env, accessToken, destFileId, [
    {
      updateSheetProperties: {
        properties: { sheetId: data.sheetId, title: newName, hidden: false },
        fields: "title,hidden",
      },
    },
  ]);
  return data.sheetId;
}

// 같은 스프레드시트 안에서 복제하는 기존 호출부용 얇은 래퍼.
async function copySheetWithName(env, accessToken, fileId, sourceSheetId, newName) {
  return copySheetToSpreadsheet(env, accessToken, fileId, sourceSheetId, fileId, newName);
}

// 기존 protectedRange를 모두 지우고 소유자(관리자 위임 계정)와 서비스 계정만
// 편집 가능하도록 새로 보호한다. protect_sheet(spread_sheet, sheet_name)와 동일.
async function protectSheetForOwnerAndService(env, accessToken, fileId, sheetId, ownerEmail) {
  const serviceAccountEmail = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON).client_email;
  _bumpUsageCounter("sheets_read");
  const meta = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}?fields=sheets(properties.sheetId,protectedRanges.protectedRangeId)`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  ).then((r) => r.json());
  const sheet = (meta.sheets || []).find((s) => s.properties.sheetId === sheetId);
  const requests = [];
  for (const pr of sheet?.protectedRanges || []) {
    requests.push({ deleteProtectedRange: { protectedRangeId: pr.protectedRangeId } });
  }
  requests.push({
    addProtectedRange: {
      protectedRange: {
        range: { sheetId },
        description: "소유자와 특정 서비스 계정만 편집 가능",
        editors: { users: [ownerEmail, serviceAccountEmail] },
      },
    },
  });
  await spreadsheetBatchUpdate(env, accessToken, fileId, requests);
}

// Y2:AC3(제목)과 Y4:AC18(본문) 셀을 병합하고 결과 메시지를 채운다.
// _set_sheet_init의 백업 탭 "처리결과" 박스 서식과 동일하다.
async function writeExitResultBox(env, accessToken, fileId, sheetId, resultMsg) {
  const border = { style: "SOLID_MEDIUM", color: { red: 0.35, green: 0.35, blue: 0.35 } };
  const fullBorder = { top: border, bottom: border, left: border, right: border };
  function mergeAndFill(rangeGrid, text, background) {
    return [
      { mergeCells: { range: rangeGrid, mergeType: "MERGE_ALL" } },
      {
        updateBorders: {
          range: rangeGrid,
          top: border,
          bottom: border,
          left: border,
          right: border,
          innerHorizontal: border,
          innerVertical: border,
        },
      },
      {
        repeatCell: {
          range: rangeGrid,
          cell: {
            userEnteredValue: { stringValue: text },
            userEnteredFormat: {
              backgroundColor: background,
              horizontalAlignment: "CENTER",
              verticalAlignment: "MIDDLE",
              textFormat: { bold: true, fontSize: 11 },
            },
          },
          fields: "userEnteredValue,userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)",
        },
      },
    ];
  }
  const titleRange = { sheetId, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 24, endColumnIndex: 29 };
  const bodyRange = { sheetId, startRowIndex: 3, endRowIndex: 18, startColumnIndex: 24, endColumnIndex: 29 };
  const requests = [
    ...mergeAndFill(titleRange, "처리결과", { red: 0.988, green: 0.894, blue: 0.839 }),
    { mergeCells: { range: bodyRange, mergeType: "MERGE_ALL" } },
    {
      repeatCell: {
        range: bodyRange,
        cell: {
          userEnteredValue: { stringValue: resultMsg },
          userEnteredFormat: { horizontalAlignment: "LEFT", verticalAlignment: "MIDDLE", textFormat: { fontSize: 11 } },
        },
        fields: "userEnteredValue,userEnteredFormat(horizontalAlignment,verticalAlignment,textFormat)",
      },
    },
    {
      updateBorders: {
        range: bodyRange,
        top: border,
        bottom: border,
        left: border,
        right: border,
      },
    },
  ];
  await spreadsheetBatchUpdate(env, accessToken, fileId, requests);
}

// 신규 스터디원의 구글 계정을 시트 편집자(writer)로 추가한다.
// 이 시트는 파일 자체의 편집자 목록으로 로그인 게이트(getSheetViewerEmails)를 겸하므로,
// 이 호출 하나가 앱스크립트의 grant_access와 로그인 허용을 동시에 대체한다.
async function grantSheetAccess(env, fileId, email) {
  const accessToken = await getAdminAccessToken(env);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?sendNotificationEmail=false`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "writer", type: "user", emailAddress: email }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error("Drive 편집자 권한 부여 실패: " + JSON.stringify(data));
  return data;
}

// 이메일로 파일 편집자 권한을 회수한다(퇴실 처리 시 grantSheetAccess의 반대 동작).
// Drive API는 이메일로 직접 삭제할 수 없어 permissionId를 먼저 조회해야 한다.
async function revokeSheetAccess(env, fileId, email) {
  if (!email) return;
  const accessToken = await getAdminAccessToken(env);
  const listRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?fields=permissions(id,emailAddress)`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const listData = await listRes.json();
  const perm = (listData.permissions || []).find(
    (p) => (p.emailAddress || "").toLowerCase() === email.toLowerCase()
  );
  if (!perm) return;
  const delRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions/${perm.id}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!delRes.ok && delRes.status !== 404) {
    const data = await delRes.json().catch(() => ({}));
    throw new Error("Drive 편집자 권한 회수 실패: " + JSON.stringify(data));
  }
}

// --- 개인 상태(벌금) 조회 ---
// 보안 핵심: 세션 이메일 → 권한관리 탭에서 그 이메일에 해당하는 멤버 순번만 찾고,
// 그 순번의 개인 탭(1~15) 단 하나만 열람한다. 다른 사람의 이름/데이터는 조회 자체를 하지 않는다.

const DAILY_FINE_CAP = 3000;
const STATUS_DAYS = ["월", "화", "수", "목", "금", "토", "일"];
const STATUS_DAY_COLS = [2, 5, 8, 11, 14, 17, 20]; // C,F,I,L,O,R,U (0-indexed)
const ROW_JOIN_DATE = 2;
const ROW_DAILY_STUDY_TIME = 24; // "⏰ 일간 학습시간"
const ROW_LOG_STUDY_TIME = 25; // "⏰ 로그 학습시간" (원본 로그값, 자동 기록)
const ROW_BONUS_STUDY_TIME = 26; // "⏰ 가산 학습시간"
const ROW_WEEKLY_STUDY_TIME = 27; // "⏰ 주간 학습시간" (C28, 요일별 합산 HH:MM)
const ROW_RECORD_TIME = 22;
const ROW_TOTAL_FINE = 28;
const ROW_GOAL_FINE = 29;
const ROW_MORNING_FINE = 30;
const ROW_PAYMENT_CHECK = 31; // "✅ 납부확인"
const ROW_PERIOD_START = 5; // 1교시 시작 행
const ROW_PERIOD_END = 18; // 14교시 시작 행
const ROW_NORMAL_LEAVE_USE = 19; // "😴 일반반휴" (그날 사용 여부)
const ROW_REASON_LEAVE_USE = 20; // "😴 사유반휴" (그날 사용 여부)
// 시트 수식(LEFT($O$3,2))과 동일하게 목표시간 문자열의 앞 2글자로 매칭한다.
// "8H"/"9H"/"10"(10H의 앞 2글자) 순서.
const GOAL_TYPE_MINUTES = { "8H": 480, "9H": 540, "10": 600 };
const ROW_WEEKLY_MERIT = 34; // "🏅 주간 총 상점" (C35)
const ROW_WEEKLY_TOTAL_FINE = 33; // "💰 주간 총 벌금" (C34)
// 🔧 [데이터 시트 통합 — SHEET_STRUCTURE.md 기준 재실측] "송출 P 감사"/"주간 P
// 감사" 행 삭제 + "🚨 페널티"(송출P/주간P 표시) 신규 행 추가로 37행부터 전부
// 재배치됨. 실측(1-idx → 0-idx): 37=제보상점(36), 38=교시참여율(37),
// 39=페널티표시(38, 신규), 40=일반반휴잔여(39), 41=사유반휴잔여(40),
// 42=참조행계산번호(41), 43=감사행계산번호(42, 신규). 옛 "누적 송출P"/"금주
// 달성P"/"누적 달성P" 개념은 완전히 사라졌다.
const ROW_PERIOD_ATTENDANCE_RATE = 37; // "📈 교시 참여율" (C38)
const ROW_PENALTY_DISPLAY = 38; // "🚨 페널티" (C39, 송출P/주간P 표시 텍스트)
const ROW_NORMAL_LEAVE_LEFT = 39; // "😴 일반반휴 잔여" (C40)
const ROW_REASON_LEAVE_LEFT = 40; // "😴 사유반휴 잔여" (C41)
const ROW_REPORT_SHEET_ROW = 41; // "⚙️ 참조 행 계산 번호" (C42) — "데이터" 시트 참조용
const ROW_AUDIT_SHEET_ROW = 42; // "⚙️ 감사 행 계산 번호" (C43) — "데이터 (감사)" 시트 참조용
const ROW_DEPOSIT_REFUND_ESTIMATE = 2; // "💰 예치금 반환 예상" (U열)
const COL_DEPOSIT_REFUND_ESTIMATE = 20; // U열 (0-indexed)
const ROW_STUDY_TIME_MERIT = 35; // "🏅 학습시간 상점" (C36)
const ROW_REPORT_MERIT = 36; // "🏅 제보 상점" (C37)
const ROW_PARTI_STATUS = 2; // "💾 참여상태" (L3, 0-idx row 2)
const COL_PARTI_STATUS = 11; // L열 (0-indexed)
const ROW_ACCESSION_DDAY = 2; // "D+n" (I3, 0-idx row 2)
const COL_ACCESSION_DDAY = 8; // I열 (0-indexed)
const ROW_DEPOSIT_AGAIN = 2; // "💰 예치금 재납" (R3, 0-idx row 2)
const COL_DEPOSIT_AGAIN = 17; // R열 (0-indexed)
const ROW_FINE_NO_STATUS = 32; // "미납신호" (C33)
const COL_PERIOD_RATE_OFFSET = 2; // 요일 시작열 + 2 = 그 교시의 참여율 서브컬럼

function parseWon(s) {
  return parseInt((s || "").replace(/[₩,]/g, ""), 10) || 0;
}

// Number(x)가 NaN이 되면(셀에 "#REF!" 같은 수식 에러나 텍스트가 남아있는 경우)
// JSON.stringify가 NaN을 null로 바꿔버려 프론트에서 크래시로 이어진다.
// 항상 유한한 숫자를 보장하기 위해 NaN이면 fallback으로 대체한다.
function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isConfirmed(recordTimestamp) {
  return (recordTimestamp || "").includes("23:3");
}

function parseLeaveCount(s) {
  const m = (s || "").match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

function formatMinutes(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// "HH:MM" 문자열(부호 없는 누적 시간값 — 로그 학습시간, 1교시 종료 타이머
// 등)을 분으로 변환한다. 비어 있거나 형식이 안 맞으면 0.
function parseHHMMToMinutes(raw) {
  const m = /^(\d{1,3}):(\d{2})$/.exec((raw || "").trim());
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// 시트 29행(일간 목표시간 벌금) 수식의 반휴 반영 규칙과 동일.
// 월~토: 반휴 미사용 시 기준시간 그대로, 1건 사용 시 절반, 2건 이상이면 그날 목표시간 없음(면제).
// 일요일은 애초에 "반일" 목표제라 규칙이 다르다 — 기준시간 자체가 평일의 절반이고,
// 반휴를 정확히 1건 쓴 경우에만 면제되며(0건·2건은 그대로 절반 목표 유지) 2건 이상 상한이 없다.
function dailyGoalMinutes(goalType, normalLeaveUsed, reasonLeaveUsed, isSunday) {
  const prefix = (goalType || "").slice(0, 2);
  const baseMinutes = GOAL_TYPE_MINUTES[prefix] || 0;
  if (!baseMinutes) return null;
  const leaveCount = normalLeaveUsed + reasonLeaveUsed;

  if (isSunday) {
    if (leaveCount === 1) return 0;
    return baseMinutes / 2;
  }

  if (leaveCount >= 2) return 0;
  return leaveCount === 1 ? baseMinutes / 2 : baseMinutes;
}

// 1~14교시(시작/종료/참여율) 셀이 하나라도 비어 있으면 그날 집계가 아직 끝나지 않은 것 —
// 시트 수식(28행 일간 총 벌금)도 COUNTBLANK로 동일하게 체크한다.
function isDayComplete(rows, startCol) {
  for (let r = ROW_PERIOD_START; r <= ROW_PERIOD_END; r++) {
    const row = rows[r] || [];
    for (let c = startCol; c < startCol + 3; c++) {
      if (!row[c]) return false;
    }
  }
  return true;
}

// 시트 수식(C37 제보상점 합산 조건 COUNTBLANK(C6:Q19)=0)과 동일하게,
// 월~금(주중 5일, STATUS_DAY_COLS의 앞 5개) 1~14교시가 전부 채워졌는지 확인한다.
// 토/일은 이 범위에 포함되지 않는다 — 주중 기록이 끝나야만 그 주 제보상점이 반영된다.
function isWeekdayComplete(rows) {
  return STATUS_DAY_COLS.slice(0, 5).every((col) => isDayComplete(rows, col));
}

// 시트 수식(C35 상점 계산 마지막 배율)과 동일한 규칙.
// 사유반휴 2회 이상 사용 시: 교시제면 1.025, 아니면 1(달성제라도 배율 없음).
// 그 외에는 목표시간 타입별 고정 배율.
const GOAL_TYPE_MULTIPLIER = {
  "8H (달성제)": 1,
  "9H (달성제)": 1.05,
  "10H (달성제)": 1.1,
  "8H (교시제)": 1.025,
  "9H (교시제)": 1.075,
  "10H (교시제)": 1.125,
};

function meritMultiplier(goalType, reasonLeaveTotal) {
  if (reasonLeaveTotal >= 2) return goalType.includes("교시제") ? 1.025 : 1;
  return GOAL_TYPE_MULTIPLIER[goalType] ?? 1;
}

// 월요일(1교시~14교시) 칸이 전부 비어 있으면 "그 주 월요일부터 참여하지 않은
// 중도 참여자"로 간주한다. isDayComplete와 반대로 "완전히 비어 있는가"를 본다.
function isDayEmpty(rows, startCol) {
  for (let r = ROW_PERIOD_START; r <= ROW_PERIOD_END; r++) {
    const row = rows[r] || [];
    for (let c = startCol; c < startCol + 3; c++) {
      if (row[c]) return false;
    }
  }
  return true;
}

// SUM(C21:W21) — 이번 주 사유반휴 사용 합계(요일별 열 합산).
function weeklyReasonLeaveTotal(rows) {
  const reasonLeaveUseRow = rows[ROW_REASON_LEAVE_USE] || [];
  return STATUS_DAY_COLS.reduce((sum, col) => sum + parseLeaveCount(reasonLeaveUseRow[col]), 0);
}

// 🔧 [데이터 시트 통합] 옛 개인 탭 C39(누적 송출P)/C40(금주 달성P) 숫자 셀은
// 사라졌다 — 총 페널티는 이제 appscript.js daily_calc()와 동일하게 "데이터"
// 시트 F~M열(4차=I, 6차=K, 주간P 1~2차=L/M) 중 현재 사이클(집계!D25)과 일치하는
// 슬롯 개수로 판정한다. outputPenSlots는 getPersonalStatusBundle()이 감싸는
// _computeOutputPenSlots()의 반환값. 송출P와 주간P를 구분해서 반환한다
// (UI가 "송출 P N회 / 주간 P N회" 형태로 따로 보여줌).
function countCurrentCyclePen(outputPenSlots, currentCycle) {
  const { values, timePenValues } = outputPenSlots;
  let outputPen = 0;
  if (values[3] === currentCycle) outputPen++; // 4차(I)
  if (values[5] === currentCycle) outputPen++; // 6차(K)
  let timePen = 0;
  if (timePenValues[0] === currentCycle) timePen++; // 주간P 1차(L)
  if (timePenValues[1] === currentCycle) timePen++; // 주간P 2차(M)
  return { outputPen, timePen, total: outputPen + timePen };
}

// 집계 시트 F열(순위)이 "-"가 되는 조건들(시트 수식 C35, 상점=0 조건과 동일)을
// 전부 판정해 각각의 해당 여부를 반환한다 — 모달에서 "제외 원인" 카드가 조건
// 전체를 보여주고 해당하는 것만 강조해야 하기 때문에, 첫 매칭에서 멈추지 않는다.
// 제보 누적 조건은 레거시라 판정에서 제외했다 — 곧 시트 수식에서도 정리될 예정.
function meritZeroConditions(rows, daysSinceJoin, currentCyclePenCount) {
  const weeklyFine = safeNumber((rows[ROW_WEEKLY_TOTAL_FINE] && rows[ROW_WEEKLY_TOTAL_FINE][2]) || 0);
  // 월요일 칸이 비어 있어도 가입한 지 오래된 회원(이번 주 이전부터 참여 중)이면
  // "중도 참여자"가 아니라 단순 기록 누락일 뿐이다 — 이번 주에 실제로 새로
  // 들어온 사람(가입 7일 미만)일 때만 중도 참여자로 판정한다.
  const isRecentJoin = daysSinceJoin >= 0 && daysSinceJoin < 7;

  return [
    { key: "midJoin", label: "월요일 이후 중도 참여", met: isRecentJoin && isDayEmpty(rows, STATUS_DAY_COLS[0]) },
    { key: "penalty", label: "페널티 1회 이상 적립", met: currentCyclePenCount >= 1 },
    { key: "fine", label: "벌금 5,000원 초과", met: weeklyFine >= 5000 },
    { key: "reasonLeave", label: "사유 반휴 3장 이상 사용", met: weeklyReasonLeaveTotal(rows) >= 3 },
  ];
}

// exitRequestDate(퇴실 신청 시 등록한 마지막 참여일)까지 남은 일수가 3일
// 미만이면 "퇴실 통보 지연"으로 친다. 이미 지난 날짜(음수)여도 여전히
// 3일 미만이므로 그대로 유지된다 — 마지막 참여일 다음날에도 50%가 계속
// 적용돼야 한다는 요구사항과 일치. exitRequestDate가 없으면(아직 퇴실
// 신청 전) 판정 자체를 하지 않는다.
function isLateNotice(exitRequestDate) {
  if (!exitRequestDate) return false;
  const today = new Date(todayKSTDateString()).getTime();
  const target = new Date(exitRequestDate).getTime();
  if (Number.isNaN(target)) return false;
  const daysUntilLastAttend = Math.round((target - today) / 86_400_000);
  return daysUntilLastAttend < 3;
}

// 시트 수식(템플릿 U3, 예치금 반환 예상)과 동일한 순서로 감액 사유를 판정한다.
// 각 조건은 앞선 것이 우선하며, 마지막까지 해당 없으면 송출P/주간P 누적 합계와
// 고지지연(퇴실 통보 지연) 여부를 합산해 10,000/5,000/0원을 가른다. penCounts는
// countCurrentCyclePen()의 반환값. exitRequestDate는 실제 제출된 퇴실 신청의
// 마지막 참여일(없으면 null) — 🔧 [고지지연 미반영 버그 수정] 원래 이 값을
// 아예 받지 않아 프론트가 "페널티 1개 + 고지지연 = 100%"라고 표시만 하고
// 실제 반환액(amount)에는 전혀 반영되지 않았다.
function depositRefundBreakdown(rows, penCounts, exitRequestDate) {
  const partiStatus = (rows[ROW_PARTI_STATUS] && rows[ROW_PARTI_STATUS][COL_PARTI_STATUS]) || "";
  const ddayRaw = (rows[ROW_ACCESSION_DDAY] && rows[ROW_ACCESSION_DDAY][COL_ACCESSION_DDAY]) || "";
  const dayMatch = /D\+(\d+)/.exec(ddayRaw);
  const daysSinceJoin = dayMatch ? Number(dayMatch[1]) : -1;
  const depositAgain = (rows[ROW_DEPOSIT_AGAIN] && rows[ROW_DEPOSIT_AGAIN][COL_DEPOSIT_AGAIN]) || "";
  const fineNoStatus = safeNumber((rows[ROW_FINE_NO_STATUS] && rows[ROW_FINE_NO_STATUS][2]) || 0);
  // 🔧 [벌금 미납 요일 표시] "차감 원인" 카드가 "벌금 미납 (월, 화)"처럼
  // 어느 요일에 미납이 발생했는지 함께 보여줄 수 있도록, "✅ 납부확인"
  // 행(31행)에서 값이 "미납"인 요일만 뽑는다 — fineNoStatus(C33 미납신호)는
  // 이 요일들 중 하나라도 있으면 1이 되는 단일 신호일 뿐 요일 정보를
  // 담지 않으므로 원본 행을 별도로 다시 읽는다.
  const paymentRow = rows[ROW_PAYMENT_CHECK] || [];
  const fineUnpaidDays = STATUS_DAYS.filter((_, i) => paymentRow[STATUS_DAY_COLS[i]] === "미납");
  // 🔧 [데이터 시트 통합] appscript.js _calc_return_deposit()과 동일하게
  // "데이터" 시트 F~M열 슬롯 중 현재 사이클과 일치하는 칸의 개수로 판정한다
  // (0=100%, 1=50%, 2 이상=0% 반환).
  const penTotal = penCounts.total;
  const lateNotice = isLateNotice(exitRequestDate);

  let amount = 0;
  let reason = null;
  if (!partiStatus) {
    reason = "참여상태 미확인";
  } else if (daysSinceJoin < 30) {
    reason = "가입 30일 미만";
  } else if (fineNoStatus === 1) {
    reason = "벌금 시한 내 미납";
  } else if (depositAgain === "미납") {
    reason = "예치금 재납 시한 미납";
  } else if (depositAgain === "납부") {
    reason = "예치금 재납 대상자";
  } else if (penTotal >= 2) {
    amount = 0;
  } else if (penTotal === 1) {
    // 페널티 1개(50%) + 고지지연(50%)이 겹치면 100% 차감(반환 0원).
    amount = lateNotice ? 0 : 5000;
  } else {
    amount = lateNotice ? 5000 : 10000;
  }
  if (reason) amount = 0;

  return {
    amount,
    reason,
    outputPen: penCounts.outputPen,
    timePen: penCounts.timePen,
    daysSinceJoin,
    fineUnpaid: fineNoStatus === 1,
    fineUnpaidDays,
    depositAgainStatus: depositAgain || null,
    lateNotice,
  };
}

// --- 퇴실자·재납자 처리 (앱스크립트 _exit_define / _calc_* 재현) ---
// 경로 A(원본 시트 즉시 처리)만 다룬다 — 주말 마감 후 Drive 백업 파일에서 처리하는
// 경로 B(_sunday 분기)는 이 버전에서 다루지 않는다.

const EXIT_DEPOSIT_VALUE = 10000;

// 강제퇴실 조건 전체를 met:true/false로 담아 반환한다. 실제로 걸렸는지와
// 무관하게 UI가 "가능한 모든 케이스"를 항상 나열하고 해당되는 것만 강조
// 표시할 수 있게 하기 위한 목록 — 예치금 재납("납부") 여부와 무관하게
// 순수 조건 계산 결과만 담는다(재납 시 강제퇴실 제외 로직은 calcForcedOutDeposit에서 처리).
function forcedExitChecks(depositBreakdown) {
  const totalPen = depositBreakdown.outputPen + depositBreakdown.timePen;
  return [
    {
      code: "under_30_days",
      label: "가입 30일 미만",
      met: depositBreakdown.daysSinceJoin >= 0 && depositBreakdown.daysSinceJoin < 30,
    },
    { code: "fine_unpaid", label: "벌금 시한 내 미납", met: depositBreakdown.fineUnpaid },
    {
      code: "deposit_again_unpaid",
      label: "예치금 시한 내 미납",
      met: depositBreakdown.depositAgainStatus === "미납",
    },
    {
      code: "penalty_2_or_more",
      label: `페널티 누적 2회 이상 (송출 P ${depositBreakdown.outputPen}회 / 주간 P ${depositBreakdown.timePen}회)`,
      met: totalPen >= 2,
    },
  ];
}

// 강제퇴실 판정 — 앱스크립트 _calc_forced_out_deposit()의 자동 감지 사유에
// "페널티 누적 2회 이상"을 추가로 합쳐 다룬다(원래 정산 퇴실자 쪽에서 0%
// 반환으로만 처리되던 조건인데, 강제퇴실 성격이 더 강해 이쪽으로 옮김).
// 사유가 하나라도 있으면 discount_ratio=1(0% 반환) 확정, 없으면 null 반환.
function calcForcedOutDeposit(depositBreakdown) {
  const allChecks = forcedExitChecks(depositBreakdown);
  const reasons = allChecks.filter((c) => c.met);

  // 앱스크립트 원본과 동일: 예치금을 이미 재납("납부")했다면 위에서 쌓인
  // 사유를 전부 무시하고 강제퇴실 대상에서 제외한다.
  if (depositBreakdown.depositAgainStatus === "납부") return null;

  if (reasons.length === 0) return null;
  const resultStr = reasons.map((r) => `${r.label} ➡️ 0% 반환`);
  return { resultStr, reasons, allChecks, discountRatio: 1 };
}

// 관리자가 직접 사유를 입력해 즉시 퇴실시키는 "직권 퇴실자" — 자동 감지되는
// 강제 퇴실자와 달리 항상 관리자 조작으로만 트리거되며, 반환율은 동일하게 0%.
// 🔧 2026-09: discountRatio는 사유 여부와 무관하게 항상 1(0% 반환)로
// 고정이라, 사유가 비어 있어도 계산 자체는 보여줄 수 있다(사용자 요청:
// 모달이 열리자마자 미리보기가 바로 뜨도록) — forcedReason 필수 검증은
// 실제 시트를 바꾸는 handleAdminExitConfirm 쪽으로 옮겼다.
function calcAdminForcedExit(forcedReason) {
  const reasonLabel = forcedReason || "(사유 미입력)";
  return {
    resultStr: [`즉시 직권퇴실자 (사유 : ${reasonLabel}) ➡️ 0% 반환`],
    reasons: [{ code: "admin_reason", label: `직권 사유: ${reasonLabel}` }],
    discountRatio: 1,
  };
}

// 앱스크립트 _calc_return_deposit()과 동일: 페널티(송출P 금주+누적, 주간P 누적)
// 총합으로 정산 퇴실자의 반환율을 정한다. 페널티 2회 이상은 이제 강제
// 퇴실자(calcForcedOutDeposit)에서 다루므로 여기서는 0/1회만 남는다.
// 🔧 [고지지연 미반영 버그 수정] 원래 이 함수는 고지지연(exitRequestDate
// 기준, depositRefundBreakdown()의 lateNotice)을 전혀 받지 않아 결과가
// 항상 페널티 횟수만으로 0%/50%였다 — depositRefundBreakdown()의 amount
// 계산(§9.2, "페널티 1개(50%) + 고지지연(50%)이 겹치면 100% 차감")과
// 어긋났다. 회원 대시보드(DepositRefundDialog)가 신청 전 미리 보여주는
// "예상 반환액"은 이미 depositRefundBreakdown().amount를 그대로 쓰고
// 있었는데, 관리자가 실제로 "정산 퇴실 확정" 처리할 때만 이 값을 무시하고
// 있어 — 회원이 미리 본 예상액과 관리자 확정액이 어긋나는 실제 버그였다
// (더미 데이터 오류가 아니라 처리 로직 자체의 문제, 2026-09 사용자 지적으로
// 발견). depositBreakdown.lateNotice를 반영해 두 계산을 다시 일치시킨다.
function calcSettleReturnDeposit(depositBreakdown) {
  const totalPen = depositBreakdown.outputPen + depositBreakdown.timePen;
  const lateNotice = !!depositBreakdown.lateNotice;
  // 페널티 0회: 고지지연 있으면 50% 차감, 없으면 0% 차감(100% 반환).
  // 페널티 1회: 고지지연 있으면 100% 차감(0원), 없으면 50% 차감 —
  // depositRefundBreakdown()의 amount 계산과 동일한 결과가 나오도록 맞춘 것.
  const discountRatio = totalPen === 0 ? (lateNotice ? 0.5 : 0) : lateNotice ? 1 : 0.5;
  const returnPct = Math.round((1 - discountRatio) * 100);
  const line =
    `송출 P (${depositBreakdown.outputPen}회) / 주간 P (${depositBreakdown.timePen}회)` +
    (lateNotice ? " + 퇴실 통보 지연" : "") +
    ` ➡️ ${returnPct}% 반환`;
  // 🔧 "퇴실유형" 카드(ExitedMemberList)가 exitTypeLabel(kindStr, reasons)로
  // "정산 퇴실자 (N% 반환)"처럼 반환율만 짧게 붙여 보여줄 수 있도록 code/label
  // 을 함께 채운다(사용자 지시: "50% 반환인지 100% 반환인지만 표시") — 이전엔
  // 이 함수가 reasons를 아예 반환하지 않아 항상 "정산 퇴실자"만 나왔었다.
  return {
    resultStr: [line],
    discountRatio,
    reasons: [{ code: "settle_return_rate", label: `${returnPct}% 반환` }],
  };
}

// 앱스크립트 _calc_again_deposit()과 동일: R3가 "납부"여야만 진행 가능.
function calcAgainDeposit(depositBreakdown) {
  if (depositBreakdown.depositAgainStatus !== "납부") return null;
  return { resultStr: ["예치금 재납자 ➡️ 0% 반환"], discountRatio: 1 };
}

// kind별로 위 계산 중 하나를 골라 실행한다.
function calcExitProcess(kind, depositBreakdown, forcedReason) {
  if (kind === "forced") {
    return calcForcedOutDeposit(depositBreakdown);
  }
  if (kind === "admin_forced") {
    return calcAdminForcedExit(forcedReason);
  }
  if (kind === "settle") {
    return calcSettleReturnDeposit(depositBreakdown);
  }
  if (kind === "deposit_again") {
    return calcAgainDeposit(depositBreakdown);
  }
  return null;
}

// 요일별(월~일) 1~14교시 원본 기록을 그대로 그리드로 재구성한다.
// 각 교시는 시작/종료 시각과 참여율(%, 숫자) 또는 "ERR" 또는 빈 문자열(미기록)을 담는다.
function buildPeriodGrid(rows) {
  return STATUS_DAYS.map((day, i) => {
    const startCol = STATUS_DAY_COLS[i];
    const periods = [];
    for (let r = ROW_PERIOD_START; r <= ROW_PERIOD_END; r++) {
      const row = rows[r] || [];
      const start = row[startCol] || "";
      const end = row[startCol + 1] || "";
      const rateRaw = row[startCol + COL_PERIOD_RATE_OFFSET];
      const rate = rateRaw === undefined || rateRaw === null ? "" : String(rateRaw);
      periods.push({ start, end, rate });
    }
    return { day, periods };
  });
}

// 시트 수식(C43, 교시 참여율)과 동일하게 계산한다.
// 참여율 = (85% 이상 달성 교시 수 + 오류(ERR) 교시 수) / 목표 교시 수 × 100.
// 목표 교시 수는 목표시간(분)에서 사유반휴로 면제된 시간을 뺀 뒤 60분 단위로 환산한다.
function periodAttendanceBreakdown(rows, goalType) {
  const isPeriodType = /^(8H|9H|10H) \(교시제\)$/.test(goalType || "");
  if (!isPeriodType) {
    return { applicable: false, achievedCount: 0, errorCount: 0, targetPeriods: 0, rate: null };
  }

  let achievedCount = 0;
  let errorCount = 0;
  for (let r = ROW_PERIOD_START; r <= ROW_PERIOD_END; r++) {
    const row = rows[r] || [];
    for (const startCol of STATUS_DAY_COLS) {
      const raw = row[startCol + COL_PERIOD_RATE_OFFSET];
      if (raw === "ERR") errorCount += 1;
      else if (safeNumber(raw) >= 85) achievedCount += 1;
    }
  }

  const targetMinutes = weeklyGoalMinutes(rows, goalType);
  const targetPeriods = targetMinutes / 60;

  const rate = targetPeriods > 0 ? ((achievedCount + errorCount) / targetPeriods) * 100 : null;

  return { applicable: true, achievedCount, errorCount, targetPeriods, rate };
}

// 🔧 2026-09: 원본 시트 M28 수식은 "월요일 칸이 하나라도 비어 있으면 0"
// 이었으나, 화/수요일 등 다른 요일엔 이미 실제 참여 기록이 있는데도 월요일
// 결석만으로 그 주 목표(및 교시 참여율의 목표 교시 수)가 통째로 0/미표시
// 처리돼 화면에 왜곡된 값이 떴다(사용자 지적) — 서비스에서는 시트 수식을
// 그대로 재현하지 않고, "그 주 7일이 전부 비어 있을 때"(=완전한 중도
// 미참여)만 0으로 보고, 하루라도 기록이 있으면 정상적으로 5일치 목표를
// 계산한다.
function weeklyGoalMinutes(rows, goalType) {
  if (STATUS_DAY_COLS.every((col) => isDayEmpty(rows, col))) return 0;
  const prefix = goalType.slice(0, 2);
  const baseMinutes = GOAL_TYPE_MINUTES[prefix] || 0;
  const reasonLeaveTotal = weeklyReasonLeaveTotal(rows);
  return Math.max(0, baseMinutes * 5 - reasonLeaveTotal * (baseMinutes / 2));
}

// M28 값을 그대로 "HH:MM" 문자열로 표시한다.
function weeklyGoalTime(rows, goalType) {
  const minutes = weeklyGoalMinutes(rows, goalType);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// 🔧 [총 페널티 모달 매칭] 예전에는 "N회차 (N/3 사이클) · 사유" 문자열
// 배열(outputPenReasons/timePenReasons)로 별도 조립했지만, "예치금 재납
// 대상자"에서 쓰는 슬롯 이력(outputPenHistory/timePenHistory,
// PenaltySlotHistoryEntry[])과 형식이 달라 두 화면의 "원인"이 서로 다르게
// 보였다. 이제 _computeOutputPenSlots()가 이미 buildSlotHistory로 만들어둔
// 이력을 그대로 넘겨받아 개인 대시보드 "총 페널티" 모달과 관리자
// "예치금 재납 대상자"가 완전히 같은 데이터·형식(N차 라벨, 발생일시,
// 사유, 캡처ID)을 쓰게 한다.
function totalPenaltyBreakdown(outputPenSlots) {
  return {
    outputPenHistory: outputPenSlots.outputPenHistory,
    timePenHistory: outputPenSlots.timePenHistory,
  };
}

function explainDay(total, goal, morning, confirmed) {
  const combined = goal + morning;
  if (!confirmed) {
    if (combined === 0) return "진행 전/기록 없음";
    return `마감 전(미확정) — 현재까지 목표시간 벌금 ₩${goal.toLocaleString()} + 오전 벌금 ₩${morning.toLocaleString()} 예상 중`;
  }
  if (total === 0) {
    if (combined === 0) return "벌금 없음 (목표 달성)";
    return `확정되었으나 총 벌금 ₩0 (목표 ₩${goal.toLocaleString()} / 오전 ₩${morning.toLocaleString()} — 규칙상 최종 미부과)`;
  }
  if (total >= DAILY_FINE_CAP && combined > DAILY_FINE_CAP) {
    return `상한 적용 — 목표 벌금 ₩${goal.toLocaleString()} + 오전 벌금 ₩${morning.toLocaleString()} = ₩${combined.toLocaleString()}이지만 하루 상한 ₩${DAILY_FINE_CAP.toLocaleString()}으로 조정되어 ₩${total.toLocaleString()} 확정`;
  }
  if (total === combined) {
    return `목표 벌금 ₩${goal.toLocaleString()} + 오전 벌금 ₩${morning.toLocaleString()} 그대로 합산되어 ₩${total.toLocaleString()} 확정`;
  }
  if (total === goal && morning === 0) {
    return `목표시간 벌금 ₩${goal.toLocaleString()}만 부과되어 ₩${total.toLocaleString()} 확정`;
  }
  return `목표 ₩${goal.toLocaleString()} / 오전 ₩${morning.toLocaleString()} 조합으로 ₩${total.toLocaleString()} 확정`;
}

// D열은 "구글계정,구루미계정" 형태로 콤마 구분해 두 계정을 함께 담는다
// (구루미 계정을 저장할 별도 컬럼이 없어 기존 이메일 칸에 함께 넣기로 함 —
// 사용자 확인). 로그인 매칭 등 "구글 이메일"이 필요한 모든 지점은 항상 이
// 헬퍼로 앞부분만 뽑아 써야 한다 — 그러지 않으면 콤마가 이메일 문자열에
// 섞여 정확 일치 비교가 깨진다.
function parseGoogleEmail(rawCell) {
  return (rawCell || "").split(",")[0].trim().toLowerCase();
}
function parseGooroomeeAccount(rawCell) {
  const parts = (rawCell || "").split(",");
  return (parts[1] || "").trim();
}

// 🔧 [데이터 시트 통합] "권한관리" 탭이 "데이터" 탭으로 흡수됐다.
// 열 인덱스(B=번호, C=이름, D=이메일)는 그대로 유지되어 row[1]/row[2]/row[3]
// 접근은 바뀌지 않았지만, 시트가 D~V까지 넓어져 A1:H50으로는 값을 다 못
// 읽으므로 범위를 A1:V50으로 확장했다.
async function findMemberNumberByEmail(env, accessToken, fileId, email) {
  const rows = await getSheetValues(env, accessToken, fileId, "데이터!A1:V50");
  for (const row of rows) {
    const rowEmail = parseGoogleEmail(row[3]);
    if (rowEmail && rowEmail === email) {
      const num = (row[1] || "").trim();
      const name = (row[2] || "").trim();
      if (num) return { number: num, name };
    }
  }
  return null;
}

// 🔧 [429 방지] "Penalty" 탭처럼 여러 컴포넌트가 한 페이지에서 동시에 마운트돼
// 각자 listAllMembers()를 부르는 상황이 잦아, 캐시(인메모리+KV)로 중복 호출을
// 흡수한다. 신규등록/퇴실/재납/이동 등 명단을 바꾸는 쓰기 뒤에는
// invalidateMemberCache()로 반드시 무효화하므로, TTL은 "무효화가 놓친 경우의
// 안전망"일 뿐이다.
//
// 🔧 [과거 fileId 분기 되돌림, 2026-09-10] 한때 과거 fileId만 2시간으로
// 늘렸었다(§17) — 하지만 listAllMembers는 이 함수 하나만 쓰는 게 아니라
// 제보 이름→회원번호 매칭(snapshotNextOccurrence 등)·퇴실 후보 판정
// (listExitCandidates) 등 20곳 이상이 공유하는 원본이라, "드롭다운만
// 2시간으로 하고 싶다"는 의도와 달리 정확성이 중요한 다른 호출부의
// 안전망까지 함께 늘어나는 부작용이 있었다(사용자 확인 후 원복). "내
// 대시보드" 드롭다운의 2시간 요구사항은 이 함수와 완전히 분리된 별도
// 바깥 캐시(handleAdminMembers의 adminMemberList:{fileId}, §17.1)로
// 충족했었다 — 이때는 members:를 다시 현재/과거 구분 없이 항상 10분으로
// 되돌렸다.
//
// 🔧 [TTL 재상향 + 승인 경로 방어, 2026-09-11] 위 되돌림의 핵심 우려는
// "제보 승인(applyOutputPenalty)/제보상점 지급(applyReportMerit)이 낡은
// 명단으로 닉네임→번호를 잘못 확정해, 번호가 재사용된 경우 엉뚱한
// 회원에게 벌점이 적힐 수 있다"는 것이었다 — 이건 실제로 심각한 위험이라
// TTL을 길게 잡는 것만으로는 해결이 안 됐다. 지금은 그 두 함수 호출
// 직전에 좁은 그룹(memberIdentity: members+dataSheetRows)만 무효화해,
// "명단이 실제로 바뀐 적이 있든 없든 승인 순간엔 무조건 방금 확인한
// 최신값을 쓴다"고 강제한다(하루 승인 건수가 10건 미만이라 이 무효화가
// 추가하는 KV 쓰기·삭제는 무시할 수준 — 사용자 확인). 이 방어가 생겼으니
// 나머지(대시보드 드롭다운 포함 20여 곳 전부)는 다시 10분에 묶어둘 이유가
// 없어져, members:도 dataSheetRows:/adminMemberList:와 같은 선상에서
// 2시간으로 늘린다 — adminMemberList:(§17.1)의 존재 이유(드롭다운 전용
// 별도 캐시)도 이제 옅어졌지만, 이미 분리돼 있고 건드릴 필요가 없어 그대로
// 둔다.
// 🔧 [캐싱 통합, 2026-09] "데이터" 시트 원본(A1:V50)을 listAllMembers 외에도
// handleAdminMembersRoster(상세 패널의 구루미 계정/준비 중인 시험), handleAdminOpenSlots
// (빈 번호 조회), handleAdminCreateMember(번호 중복 검증)가 각자 캐시 없이
// 직접 읽고 있었다 — listAllMembers는 이 원본에서 "이메일이 있는 유효 회원"만
// 걸러 쓰고 나머지 열/행은 버려, 그 버려진 부분이 필요한 화면들은 캐시를
// 재사용하지 못했다. 원본 로우 자체를 별도 키로 캐싱해 listAllMembers를
// 포함한 4곳이 모두 재사용하게 한다. members:와 TTL·무효화 그룹을 반드시
// 함께 맞춘다(MEMBER_CACHE_PREFIXES/MEMBER_CACHE_UNCONDITIONAL_KEYS/
// MEMBER_CACHE_GROUPS.roster 세 곳 모두에 dataSheetRows: 등록 필요).
// 🔧 [사용자 지시, 2026-09-11] members:가 2시간으로 늘 때(§1729 주석)
// "함께 맞춘다"고 명시해놓고 정작 TTL 자체는 10분에 남아있던 누락을
// 발견해 바로잡는다 — members:가 이 원본에서 파생되는데 재료(dataSheetRows)만
// 10분마다 낡은 것으로 취급되면 가공값(members)의 2시간 TTL도 사실상
// 무의미해진다. 소비처 3곳(listAllMembers/handleAdminMembersRoster/
// handleAdminOpenSlots) 모두 이메일·이름·시험종류처럼 저빈도로만 바뀌는
// 열만 읽고 벌점/상점 등 F~V열은 안 읽어(각 핸들러 주석 참고), 2시간
// 묵어도 안전하다고 재검증했다. 무효화 그룹(roster/memberIdentity/
// newMember)은 이미 members:와 완전히 동일하게 dataSheetRows:도 포함하고
// 있어 무효화 타이밍은 그대로 정확하다 — TTL만 안전망으로 따라간다.
async function getDataSheetRows(env, accessToken, fileId) {
  return _cachedCompute(env, `dataSheetRows:${fileId}`, 2 * 60 * 60_000, () => {
    return getSheetValues(env, accessToken, fileId, "데이터!A1:V50");
  });
}

async function listAllMembers(env, accessToken, fileId) {
  return _cachedCompute(env, `members:${fileId}`, 2 * 60 * 60_000, async () => {
    const rows = await getDataSheetRows(env, accessToken, fileId);
    const members = [];
    for (const row of rows) {
      const num = (row[1] || "").trim();
      const name = (row[2] || "").trim();
      const email = parseGoogleEmail(row[3]);
      // 헤더 행(예: "👦🏻 멤버" / "이메일")을 걸러낸다 — 회원번호는 항상 숫자,
      // 이메일은 항상 @를 포함한다.
      if (num && /^\d+$/.test(num) && email && email.includes("@")) {
        members.push({ number: num, name, email });
      }
    }
    return members;
  });
}

// 집계 시트 B4:G18에서 회원번호에 해당하는 행의 상점(F열)/순위(G열)를 읽는다.
// 순위는 집계 시트가 이미 전체 15명을 비교해 계산해두므로, 개인 대시보드가
// 직접 15개 탭을 다시 조회할 필요 없이 이 값만 찾으면 된다.
// 🔧 [중복 캐시 통합, 2026-09-10] 원래 이 함수는 집계!B4:F18을 별도의
// meritRank:{fileId} 키로 캐싱했는데, 이 범위는 RANK 탭이 이미 캐싱해둔
// rosterStatus:{fileId}(집계!A4:L18, buildRosterStatus)의 완전한 부분집합
// 이다 — 같은 파일의 같은 상점/순위 데이터를 두 개의 캐시 키로 중복
// 저장·중복 조회하고 있었다(사용자 지적: "MY랑 RANK 둘이 같이 가져오는
// 걸로 해도 되지 않나?"). buildRosterStatus를 그대로 재사용한다 — 무효화
// 그룹(둘 다 roster 그룹에만 즉시 반응, penalty 그룹에선 의도적으로 제외)이
// 이미 동일해 합쳐도 정합성 차이가 없다. buildRosterStatus가 "빈 시트"
// 행을 걸러내지만 여기는 항상 실존하는 본인 조회라 그 필터링과 무관하다.
async function getMeritRank(env, accessToken, fileId, memberNumber) {
  const { members } = await buildRosterStatus(env, accessToken, fileId);
  const member = members.find((m) => m.number === String(memberNumber));
  if (!member) return { merit: "0", rank: "-" };
  return { merit: member.merit || "0", rank: member.rank || "-" };
}

// 🔧 [데이터 시트 통합] 옛 "제보상점" D~L(요일별 점수/K=총점/L=벌점) 구조가
// 사라지고, "데이터" 시트 R~V(제보상점 1~5차 슬롯, 값=발생 시점의 페널티
// 사이클 번호)로 바뀌었다. 개인 탭 C37 수식과 동일하게, 현재 사이클(집계!D25)과
// 일치하는 슬롯 개수 × 0.1이 총점이다. "벌점" 개념은 이제 존재하지 않는다
// (별도 페널티 판정은 송출P/주간P 슬롯이 담당).
async function _computeReportScore(env, accessToken, fileId, reportRow) {
  if (!reportRow) return { total: 0 };
  const [slotRows, currentCycle] = await Promise.all([
    getSheetValues(env, accessToken, fileId, `데이터!R${reportRow}:V${reportRow}`),
    getCurrentPenCycle(env, accessToken, fileId),
  ]);
  const slotRow = (slotRows && slotRows[0]) || [];
  const count = slotRow.filter((v) => parseInt(v, 10) === currentCycle).length;
  return { total: Math.round(count * 0.1 * 10) / 10 };
}

// "데이터" 탭 F~M열(송출P 1~6차 + 주간P 1~2차)에서 특정 회원(번호+3행)의 슬롯
// 값과, 4차(I)/6차(K) 슬롯에 값이 있을 때만 그 칸의 주석(발생 시점 · 사유)을
// 함께 읽는다. note 조회는 별도 API 호출이라 값이 없는 대부분의 경우엔
// 건너뛰어 비용을 아낀다. timePenValues(L/M)는 appscript.js daily_calc()의
// 판정 결과가 그대로 기록되는 슬롯이라 여기서는 그대로 읽기만 한다.
async function _computeOutputPenSlots(env, accessToken, fileId, memberNumber) {
  const row = parseInt(memberNumber, 10) + 3;
  const rows = await getSheetValues(env, accessToken, fileId, `'${OUTPUT_PEN_SHEET_NAME}'!F${row}:M${row}`);
  const slotRow = (rows && rows[0]) || [];
  const values = OUTPUT_PEN_SLOT_COLUMNS.map((_, i) => parseInt(slotRow[i], 10) || 0);
  const timePenValues = [parseInt(slotRow[6], 10) || 0, parseInt(slotRow[7], 10) || 0]; // L(1차), M(2차)

  // 🔧 [총 페널티 모달 매칭] "예치금 재납 대상자"가 쓰는 buildSlotHistory와
  // 동일한 이력(N차 라벨·발생일시·사유·캡처ID)을 개인 대시보드의 "총 페널티"
  // 모달에서도 그대로 보여주기 위해, F~K뿐 아니라 L~M(주간 P) 주석까지 함께
  // 읽는다. 채워진 슬롯이 하나도 없으면 굳이 시트를 한 번 더 조회하지 않는다.
  let outputPenHistory = [];
  let timePenHistory = [];
  const hasAnySlot = values.some((v) => v > 0) || timePenValues.some((v) => v > 0);
  if (hasAnySlot) {
    const sheetId = await getSheetIdByName(env, accessToken, fileId, OUTPUT_PEN_SHEET_NAME);
    if (sheetId !== null) {
      const rowNotes = await getRowNotes(env, accessToken, fileId, sheetId, row - 1, "F", "M");
      outputPenHistory = buildSlotHistory(values, rowNotes.slice(0, 6), "송출 P");
      timePenHistory = buildSlotHistory(timePenValues, rowNotes.slice(6, 8), "주간 P");
    }
  }

  return { values, timePenValues, outputPenHistory, timePenHistory };
}

// 오전 목표시간 벌금 수식: MAX(0, 3-HOUR(D10))*500 — D10은 1교시 종료
// 누적시간(HH:MM). 목표는 시(hour) 단위지만 UI에는 분 단위 미달치까지
// 정확히 보여줘야 해서 180분 기준으로 직접 계산한다(사용자 확인).
const MORNING_GOAL_MINUTES = 180;

// 개인 탭 rows(A1:U... 2차원 배열)에서 요일별 days 배열을 만든다. 순수 함수로
// 분리해 실시간/과거 시트뿐 아니라 "예치금 재납 전" 백업 탭 스냅샷에도 그대로
// 재사용한다(buildDepositAgainSnapshot).
// Date 객체를 "YYYY-MM-DD"로 포맷한다. toISOString()은 UTC로 변환하며 자정을
// 넘나들 위험이 있어(이 값들은 이미 정오 무렵으로 만들어지므로 실제로는 안전
// 하지만), 명시적으로 로컬 필드에서 직접 조립해 시간대 변환에 의존하지 않는다.
function formatISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// buildPersonalStatus가 넘겨주는 "이 조회가 보여주는 주의 월요일" 기준으로,
// 요일 인덱스(0=월 ... 6=일)에 해당하는 실제 캘린더 날짜를 계산한다.
// weekMonday가 없으면(계산 실패 등 방어) null.
function dayDateAt(weekMonday, dayIndex) {
  if (!weekMonday) return null;
  const d = new Date(weekMonday.getTime());
  d.setDate(d.getDate() + dayIndex);
  return formatISODate(d);
}

// KST(UTC+9) 기준 "지금"을 나타내는 Date. Cloudflare Workers는 로컬 타임존이
// 항상 UTC라서, UTC Date에 9시간을 더해두고 이후 반드시 UTC getter(getUTCDate,
// getUTCDay 등)로만 읽으면 KST 기준 값이 정확히 나온다 — 로컬 getter를 쓰면
// (Workers 로컬=UTC이므로) 다시 UTC로 되돌아가버리니 주의.
function nowKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

// KST 기준 "오늘"의 "YYYY-MM-DD" 문자열. formatISODate는 로컬 getter를
// 쓰므로, nowKST()가 만든 "UTC 시각이지만 KST 날짜를 담고 있는" Date를
// 그대로 넘기면 정확한 KST 날짜 문자열이 나온다(Workers 로컬=UTC).
function todayKSTDateString() {
  return formatISODate(nowKST());
}

// UTC 기준 "오늘"의 "YYYY-MM-DD" 문자열(Workers 로컬=UTC이므로 그냥
// formatISODate(new Date())). 🔧 [사용자 지시] "UTC 기준으로 해줘야지.
// 결국 한도에 따른 사용치를 보고 싶은건데" — 사용량 모니터링의 "일일"
// 집계(_dailyUsageBuffer/UsageStats DO)가 KST 자정 기준이면, 같은 화면
// 위쪽의 Cloudflare 실측 게이지(fetchCloudflareUsage, 실제 한도가
// 리셋되는 UTC 자정 기준)와 하루 경계가 9시간 어긋나 합계가 안 맞아
// 보였다 — 둘 다 "한도 대비 사용량"이 목적이므로 같은 기준으로 통일한다.
function todayUTCDateString() {
  return formatISODate(new Date());
}

// KST 기준 "오늘 + N일"(N이 음수면 과거) 날짜의 "YYYY-MM-DD" 문자열. 신규
// 회원 등록 시 "첫 참여일"을 오늘부터 앞으로 일주일 이내로만 허용하는 범위
// 검증에 쓴다(handleAdminCreateMember) — 날짜 문자열끼리는 사전식 비교가 곧
// 날짜 비교와 같아, 별도 파싱 없이 `날짜문자열 <= kstDateOffsetString(6)`로
// 바로 비교할 수 있다.
function kstDateOffsetString(days) {
  const d = nowKST();
  d.setUTCDate(d.getUTCDate() + days);
  return formatISODate(d);
}

// KST(UTC+9) 기준 "이번 주 월요일" 자정을 계산한다. 다른 KST 계산(예:
// isSettlementVisibleToMembers)과 동일하게, UTC Date에 9시간을 더해두고
// UTC getter로 읽는 트릭을 쓴다 — Cloudflare Workers는 로컬 타임존이 항상
// UTC라서, 이렇게 만든 Date를 이후 formatISODate(로컬 getter)로 그대로
// 포맷해도 KST 기준 날짜가 정확히 나온다.
function currentWeekMondayKST() {
  const kstNow = nowKST();
  const jsDay = kstNow.getUTCDay(); // 일=0 ... 토=6
  const mondayOffset = (jsDay + 6) % 7; // 오늘이 월요일로부터 며칠째인지(월=0)
  const monday = new Date(kstNow.getTime());
  monday.setUTCDate(monday.getUTCDate() - mondayOffset);
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

// 백업 파일명에서 온 weekOf("YYMMDD", 그 주의 월요일)를 Date로 파싱한다.
function parseWeekOfToMonday(weekOf) {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(weekOf || "");
  if (!m) return null;
  return new Date(Date.UTC(2000 + parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
}

// UTC Date를 "YYMMDD"로 포맷한다(백업 파일명 weekOf와 동일한 규칙) — UTC
// getter를 쓰므로, currentWeekMondayKST()/parseWeekOfToMonday()가 만든
// "UTC 자정이지만 KST 날짜를 담은" Date를 그대로 넘기면 KST 기준 날짜가 나온다.
function formatYYMMDD(date) {
  const yy = String(date.getUTCFullYear()).slice(-2);
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

// RosterPage(대시보드 "랭킹"/"상금 정산")의 타이틀에 "YYMMDD-YYMMDD 주간"을
// 병기하기 위해, 이 조회가 어느 주(월~일)를 보여주는지 시작/종료일을
// 계산한다. weekOf가 없으면(실시간 조회) 이번 주 월요일을 기준으로 삼는다.
function currentWeekRangeYYMMDD(weekOf) {
  const monday = weekOf ? parseWeekOfToMonday(weekOf) : currentWeekMondayKST();
  if (!monday) return null;
  const sunday = new Date(monday.getTime());
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  return { weekStart: formatYYMMDD(monday), weekEnd: formatYYMMDD(sunday) };
}

function buildStatusDays(rows, goalType, periodGrid, depositAgainDay, pendingReasonLeaveDays, weekMonday) {
  const dailyStudyRow = rows[ROW_DAILY_STUDY_TIME] || [];
  const logStudyRow = rows[ROW_LOG_STUDY_TIME] || [];
  const bonusStudyRow = rows[ROW_BONUS_STUDY_TIME] || [];
  const recordRow = rows[ROW_RECORD_TIME] || [];
  const totalRow = rows[ROW_TOTAL_FINE] || [];
  const goalRow = rows[ROW_GOAL_FINE] || [];
  const morningRow = rows[ROW_MORNING_FINE] || [];
  const paymentRow = rows[ROW_PAYMENT_CHECK] || [];
  const normalLeaveUseRow = rows[ROW_NORMAL_LEAVE_USE] || [];
  const reasonLeaveUseRow = rows[ROW_REASON_LEAVE_USE] || [];

  let weekTotalConfirmed = 0;
  const days = STATUS_DAYS.map((day, i) => {
    const col = STATUS_DAY_COLS[i];
    const complete = isDayComplete(rows, col);
    const confirmed = isConfirmed(recordRow[col]);
    const total = complete ? parseWon(totalRow[col]) : 0;
    const goal = complete ? parseWon(goalRow[col]) : 0;
    const morning = complete ? parseWon(morningRow[col]) : 0;
    const studyTime = dailyStudyRow[col] || "";
    const logStudyTime = logStudyRow[col] || "";
    const bonusStudyTime = bonusStudyRow[col] || "";
    const paymentStatus = paymentRow[col] || "";
    const normalLeaveUsed = parseLeaveCount(normalLeaveUseRow[col]);
    const reasonLeaveUsed = parseLeaveCount(reasonLeaveUseRow[col]);
    const goalMinutes = dailyGoalMinutes(goalType, normalLeaveUsed, reasonLeaveUsed, day === "일");
    const dailyGoalTime = goalMinutes === null ? "" : formatMinutes(goalMinutes);

    // 🔧 [벌금 미달치 표시] 시트 30행(일간 목표시간 벌금) 수식과 동일하게
    // CEILING(목표분 - 로그학습분, 30) 30분 단위로 올림한다. goal(벌금 원화)이
    // 0이면(목표 달성/면제) 미달치도 0으로 표시하지 않는다.
    const dailyShortfallMinutes =
      goal > 0 && goalMinutes
        ? Math.max(0, Math.ceil((goalMinutes - parseHHMMToMinutes(logStudyTime)) / 30) * 30)
        : 0;
    // 오전은 시트가 시(hour) 단위로만 벌금을 매기지만, 미달치 자체는 실제
    // 1교시 종료 누적시간(periods[0].end)과 180분의 차이를 분 단위 그대로 쓴다.
    const morningPeriodEnd = (periodGrid[i] && periodGrid[i].periods[0] && periodGrid[i].periods[0].end) || "";
    const morningShortfallMinutes =
      morning > 0 ? Math.max(0, MORNING_GOAL_MINUTES - parseHHMMToMinutes(morningPeriodEnd)) : 0;

    if (confirmed) weekTotalConfirmed += total;
    return {
      day,
      // 🔧 [가입일 이전 요일 비활성화용] 이 요일의 실제 캘린더 날짜
      // ("YYYY-MM-DD") — 프론트가 가입일과 비교해 "가입 전이라 아예
      // 참여할 수 없었던 요일"만 선택 불가로 표시하는 데 쓴다.
      date: dayDateAt(weekMonday, i),
      confirmed,
      complete,
      total,
      goal,
      morning,
      studyTime,
      logStudyTime,
      bonusStudyTime,
      dailyGoalTime,
      dailyShortfallTime: dailyShortfallMinutes > 0 ? formatMinutes(dailyShortfallMinutes) : "",
      morningShortfallTime: morningShortfallMinutes > 0 ? formatMinutes(morningShortfallMinutes) : "",
      // 예치금 재납 2회 달성 시점의 요일과 이 요일이 같을 때만 true — 프론트가
      // 이 요일의 카드에만 "재납 예치금" 하위 항목을 노출한다(사용자 지적:
      // 원래는 요일 스냅샷이 아니라 매 요일 카드에 동일하게 찍히던 버그).
      isDepositAgainDay: day === depositAgainDay,
      paymentStatus,
      normalLeaveUsed,
      reasonLeaveUsed,
      // 관리자 승인 대기 중인 사유반휴 신청이 이 요일에 있는지 — 승인 전까지는
      // reasonLeaveUsed(시트 값)에 반영되지 않으므로, 프론트가 "N장 (관리자 확인
      // 중)"으로 별도 표시하는 데 쓴다.
      reasonLeavePending: pendingReasonLeaveDays.includes(day),
      explain: explainDay(total, goal, morning, confirmed),
    };
  });

  return { days, weekTotalConfirmed };
}

// 예치금 재납 시 performDepositAgainReset이 리셋 직전 백업해 두는
// "{이름} (재납 {timestamp})" 탭 하나를 가볍게 파싱한다. buildPersonalStatus와
// 달리 순위/제보점수/사이클 페널티처럼 다른 시트(집계·데이터)를 참조해야 하는
// 값은 스냅샷 시점 그대로 복원할 수 없어 포함하지 않는다 — 이미 계산이 끝나
// 셀에 텍스트로 박혀 있는 요약값만 그대로 읽는다.
function buildDepositAgainSnapshot(rows) {
  if (!rows || rows.length <= ROW_MORNING_FINE) return null;

  const goalType = (rows[2] && rows[2][14]) || "";
  const periodGrid = buildPeriodGrid(rows);
  // 백업 탭은 리셋 직전 스냅샷이라 이 시점엔 이미 재납이 확정된 뒤이므로,
  // 재납 발생일 요일 강조(isDepositAgainDay)는 의미가 없어 항상 null로 둔다.
  const { days, weekTotalConfirmed } = buildStatusDays(rows, goalType, periodGrid, null, []);

  const weeklyMerit = (rows[ROW_WEEKLY_MERIT] && rows[ROW_WEEKLY_MERIT][2]) || "0";
  const weeklyTotalFineAmount = safeNumber((rows[ROW_WEEKLY_TOTAL_FINE] && rows[ROW_WEEKLY_TOTAL_FINE][2]) || 0);
  const weeklyStudyTimeStr = (rows[ROW_WEEKLY_STUDY_TIME] && rows[ROW_WEEKLY_STUDY_TIME][2]) || "00:00";

  // 🔧 [재납 전 스냅샷 왜곡 방지] weeklyGoalTime()/periodAttendanceBreakdown()은
  // "이번 주가 항상 5일(월~금) 전체 진행 중"이라는 실시간 조회 전제로 짜여
  // 있어, 완결 요일 수가 5일보다 적을 수 있는 백업 탭 스냅샷에 그대로 쓰면
  // 목표 대비 미달률/참여율이 실제보다 훨씬 나쁘게 계산된다(재납이 주
  // 초반일수록 왜곡이 커짐) — 그래서 이 두 값은 아예 계산하지 않고, 프론트가
  // "목표 비교 없이 실적치만" 보여주도록 goalTime은 항상 0(00:00), 참여율은
  // 항상 "-"(집계 불가)로 둔다.
  return {
    goalType,
    joinDate: (rows[ROW_JOIN_DATE] && rows[ROW_JOIN_DATE][8]) || "",
    weeklyMerit,
    weeklyGoalTime: "00:00",
    weeklyStudyTime: weeklyStudyTimeStr,
    weeklyTotalFine: `₩${weeklyTotalFineAmount.toLocaleString()}`,
    periodAttendanceRate: "-",
    periodAttendanceBreakdown: { applicable: false, achievedCount: 0, errorCount: 0, targetPeriods: 0, rate: null },
    periodGrid,
    days,
    weekTotalConfirmed,
  };
}

// 개인 탭 원본 조회는 buildPersonalStatus 안에서 가장 무거운 단일 호출이자
// 회원마다 유일한(=배치로 묶을 수 없는) 요청이라, 15명이 짧은 시간에 각자
// /status를 열면 그대로 15회가 쌓인다. 짧게(3초) 캐싱해 같은 회원이 연속
// 클릭하거나 여러 화면(설정/대시보드)이 거의 동시에 조회하는 중복만
// 제거한다 — 본인이 값을 바꾸면 writeSheetValues가 이 캐시를 즉시
// 무효화하므로 "방금 쓴 값이 안 보이는" 문제는 생기지 않는다.
// 🔧 [캐싱 통합, 2026-09] 개인 탭 원본(personalStatus)·송출P 슬롯
// (outputPenSlots)·제보상점(reportScore)은 buildPersonalStatus 한 곳에서만
// 항상 함께 쓰이는데도(다른 화면이 셋 중 하나만 독립적으로 부르는 경우가
// 없음) 각자 다른 KV 키로 따로 캐싱되고 있었다 — 대시보드 폴링(30분)마다
// 회원 1명당 KV put이 3번씩 발생해, 15명 기준 이 셋이 전체 KV 쓰기의
// 대부분을 차지했다(문서화된 실측 없이 직접 계산: 평균 사용 시나리오
// 기준 하루 약 500회 절감 추정). 셋을 personalStatusBundle: 하나의 캐시
// 키로 묶는다 — reportRow(제보상점 조회에 필요한 행 번호)가 개인 탭 42행
// (C42) 값이라 원래도 personalStatus를 먼저 읽어야만 알 수 있는 순차
// 의존 관계였으므로, 병렬로 쪼개져 있던 걸 오히려 자연스럽게 합칠 수
// 있었다. 셋 중 하나라도 무효화되면 셋 다 같이 재계산되지만(전보다
// 무효화 세밀도가 낮아짐), 그 대가로 생기는 추가 API 호출은 이미 30분
// 폴링 주기 안에서 일어나는 일이라 무시할 수준이다(사용자 확인 후 진행).
async function getPersonalStatusBundle(env, accessToken, fileId, memberNumber) {
  // 🔧 [30분→10분 하향, 2026-09] 개인 탭 값은 본인이 이 Worker의 API로
  // 직접 쓰는 경우(반휴 신청, 관리자 처리 등)는 writeSheetValues가 즉시
  // 무효화하므로 문제없지만, 도움봇 study_sw/bot/sheets.py의 set_sheet()가
  // 각 교시 시작/종료마다(timetable.csv 기준 최소 10분 간격) gspread로
  // 개인 탭에 직접 batch_update하는 경로는 이 Worker 캐시를 전혀 거치지
  // 않아 무효화되지 않는다 — 옛 "교시 60분 단위"라는 전제는 실제 쓰기
  // 간격(교시 종료→다음 교시 시작 10분)보다 길어 회원이 교시 종료 직후
  // 자기 참여율을 확인하려 할 때 최대 30분 낡은 값을 볼 수 있었다
  // (docs/CACHING_POLICY.md §7). 봇의 실제 쓰기 리듬에 맞춰 10분으로
  // 낮춘다 — 회원 수(15)에 비례하는 캐시라 KV 예산은 여전히 고려 대상.
  //
  // 🔧 [과거 fileId TTL 상향, 2026-09-10] 도움봇의 무효화 안 되는 직접 쓰기
  // 경로는 항상 "지금 진행 중인" 이번 주 시트(env.GOOGLE_SHEET_FILE_ID)에만
  // 있다 — 과거 백업 파일에는 도움봇도 절대 쓰지 않으므로, 10분을 짧게
  // 유지해야 할 이유가 과거 fileId에는 없다. 과거 fileId 조회는 이
  // Worker의 API(handleAdminFineStatus 등)를 통해서만 바뀔 수 있고, 그
  // 경로는 writeSheetValues → invalidatePersonalStatusCache가 그 fileId를
  // 그대로 받아 정확히 무효화하므로, TTL을 2시간으로 늘려도 "관리자가
  // 방금 처리한 값이 안 보이는" 문제는 생기지 않는다(사용자 확인). 같은
  // 근거(과거 fileId는 절대 안 바뀜)가 outputPenSlots/reportScore에도
  // 그대로 적용되므로 셋을 같은 TTL 분기로 묶어도 안전하다.
  const ttlMs = fileId === env.GOOGLE_SHEET_FILE_ID ? 10 * 60_000 : 2 * 60 * 60_000;
  return _cachedCompute(env, `personalStatusBundle:${fileId}:${memberNumber}`, ttlMs, async () => {
    const rows = await getSheetValues(env, accessToken, fileId, `${memberNumber}!A1:U${ROW_REPORT_SHEET_ROW + 1}`);
    const reportSheetRow = safeNumber((rows[ROW_REPORT_SHEET_ROW] && rows[ROW_REPORT_SHEET_ROW][2]) || 0);
    const [outputPenSlots, reportScore] = await Promise.all([
      _computeOutputPenSlots(env, accessToken, fileId, memberNumber),
      _computeReportScore(env, accessToken, fileId, reportSheetRow),
    ]);
    return { rows, outputPenSlots, reportScore };
  });
}

// weekOf: 이 조회가 어느 주(백업 파일명 기준 "YYMMDD" 월요일)를 보여주는지 —
// 실시간(라이브 시트) 조회면 null이며, 이 경우 오늘(KST) 기준 이번 주로
// 계산한다. 요일별 실제 캘린더 날짜(days[i].date)를 만드는 데 쓰인다.
async function buildPersonalStatus(env, accessToken, fileId, memberNumber, memberName, weekOf) {
  const bundle = await getPersonalStatusBundle(env, accessToken, fileId, memberNumber);
  const { rows, outputPenSlots, reportScore } = bundle;
  if (!rows || rows.length <= ROW_MORNING_FINE) {
    throw new Error("개인 탭 데이터를 찾을 수 없습니다.");
  }

  const goalType = (rows[2] && rows[2][14]) || "";
  const joinDate = (rows[ROW_JOIN_DATE] && rows[ROW_JOIN_DATE][8]) || "";
  // 🔧 [가입일 이전 요일 비활성화용] I2(가입일자 원본, "YYYY-MM-DD")를 직접
  // 읽는다 — 위 joinDate(I3)는 "D+238"처럼 매일 바뀌는 상대값이라 특정
  // 요일의 날짜와 직접 비교할 수 없다. I2는 0-indexed row=1, col=8(I열).
  const joinDateExact = (rows[1] && rows[1][8]) || "";
  const weekMonday = weekOf ? parseWeekOfToMonday(weekOf) : currentWeekMondayKST();
  const weeklyMerit = (rows[ROW_WEEKLY_MERIT] && rows[ROW_WEEKLY_MERIT][2]) || "0";
  const normalLeaveLeft = (rows[ROW_NORMAL_LEAVE_LEFT] && rows[ROW_NORMAL_LEAVE_LEFT][2]) || "0";
  const reasonLeaveLeft = (rows[ROW_REASON_LEAVE_LEFT] && rows[ROW_REASON_LEAVE_LEFT][2]) || "0";
  const weeklyTotalFineAmount = safeNumber((rows[ROW_WEEKLY_TOTAL_FINE] && rows[ROW_WEEKLY_TOTAL_FINE][2]) || 0);
  const weeklyTotalFine = `₩${weeklyTotalFineAmount.toLocaleString()}`;
  const weeklyGoalTimeStr = weeklyGoalTime(rows, goalType);
  const weeklyStudyTimeStr =
    (rows[ROW_WEEKLY_STUDY_TIME] && rows[ROW_WEEKLY_STUDY_TIME][2]) || "00:00";
  const periodAttendanceRateRaw =
    (rows[ROW_PERIOD_ATTENDANCE_RATE] && rows[ROW_PERIOD_ATTENDANCE_RATE][2]) ?? "-";
  const periodAttendanceRate =
    periodAttendanceRateRaw === "-" || periodAttendanceRateRaw === ""
      ? "-"
      : `${Math.round(safeNumber(periodAttendanceRateRaw))}%`;
  const periodAttendanceBreakdownResult = periodAttendanceBreakdown(rows, goalType);
  const periodGrid = buildPeriodGrid(rows);
  const depositRefundEstimate =
    (rows[ROW_DEPOSIT_REFUND_ESTIMATE] && rows[ROW_DEPOSIT_REFUND_ESTIMATE][COL_DEPOSIT_REFUND_ESTIMATE]) ||
    "-";

  const { total: reportTotal } = reportScore;
  const [{ rank: rawRank }, currentCycle, exitRequestEntry] = await Promise.all([
    getMeritRank(env, accessToken, fileId, memberNumber),
    getCurrentPenCycle(env, accessToken, fileId),
    // 🔧 [고지지연 반영] depositRefundBreakdown이 amount 계산에 실제 퇴실
    // 신청일을 반영해야 하므로, 원래 이 아래(구 1758행)에서 뒤늦게 조회하던
    // 것을 이 병렬 조회로 앞당긴다.
    // 🔧 [KV → DO 이전, 2026-09-12] §47 — LeaveQueue DO에서 조회.
    getLeaveQueueStub(env)
      .fetch(`https://do/exit/get?memberNumber=${encodeURIComponent(memberNumber)}`)
      .then((r) => r.json())
      .then((d) => d.entry)
      .catch(() => null),
  ]);
  const penCounts = countCurrentCyclePen(outputPenSlots, currentCycle);
  const weeklyOutputPen = penCounts.outputPen;
  const weeklyTimePen = penCounts.timePen;
  const exitRequestDate = exitRequestEntry?.exitDate || null;
  const exitAgreedAt = exitRequestEntry?.agreedAt || null;
  const depositRefundBreakdownResult = depositRefundBreakdown(rows, penCounts, exitRequestDate);
  const zeroConditions = meritZeroConditions(rows, depositRefundBreakdownResult.daysSinceJoin, penCounts.total);
  const zeroReason = (zeroConditions.find((c) => c.met) || {}).label || null;
  const weeklyMeritRank = rawRank === "-" ? `- (${zeroReason || "미집계"})` : rawRank;
  const totalPenaltyBreakdownResult = totalPenaltyBreakdown(outputPenSlots);

  const partiStatus = (rows[ROW_PARTI_STATUS] && rows[ROW_PARTI_STATUS][COL_PARTI_STATUS]) || "";
  const isLeader = partiStatus === "스터디장" || partiStatus === "부스터디장";
  const studyTimeMerit = safeNumber((rows[ROW_STUDY_TIME_MERIT] && rows[ROW_STUDY_TIME_MERIT][2]) || 0);
  const reportMeritRaw = safeNumber((rows[ROW_REPORT_MERIT] && rows[ROW_REPORT_MERIT][2]) || 0);
  // 시트 수식: 제보상점(C37)은 그 주 월~금(주중) 1~14교시가 전부 채워져야만 합산에 포함된다.
  const weekdayComplete = isWeekdayComplete(rows);
  const reportMerit = isLeader ? 0.5 : reportMeritRaw;
  const includedReportMerit = weekdayComplete ? reportMerit : 0;
  const baseMerit = studyTimeMerit + includedReportMerit;

  const reasonLeaveTotal = weeklyReasonLeaveTotal(rows);
  const multiplier = meritMultiplier(goalType, reasonLeaveTotal);
  // 사유 반휴 2장 이상이면 배율이 강등된다(교시제→1.025, 달성제→1) —
  // 원래 goalType 그대로의 배율과 다르면 모달에 강등 사실을 보여줘야 한다.
  const baseMultiplier = GOAL_TYPE_MULTIPLIER[goalType] ?? 1;
  const multiplierDowngraded = reasonLeaveTotal >= 2 && multiplier !== baseMultiplier;

  // 🔧 [데이터 시트 통합] 개인 탭 C35 수식의 차감 항은 "제보상점 벌점"이
  // 아니라 송출P 2차(G)/3차(H)/5차(J) 중 현재 사이클과 일치하는 슬롯
  // 개수다(OUTPUT_PEN_SLOT_COLUMNS = ["F","G","H","I","J","K"] → idx 1,2,4).
  const minorOutputPenCount = [1, 2, 4].filter((idx) => outputPenSlots.values[idx] === currentCycle).length;

  // 부동소수점 오차(0.1025*1000 → 102.49999999999999 등) 방지를 위해 4자리로 반올림한다.
  const fineDeduction = Math.round((weeklyTotalFineAmount / 500) * 0.1 * 10000) / 10000;
  const penaltyDeduction = Math.round(minorOutputPenCount * 0.1 * 10000) / 10000;

  const computedMerit = Math.max(
    0,
    Math.round((baseMerit * multiplier - penaltyDeduction - fineDeduction) * 10000) / 10000
  );

  // 학습시간 상점 = 로그학습시간(분)/60*0.1 이므로 역산하면 누적 학습시간(시간)이 나온다.
  const studyTimeHours = Math.round((studyTimeMerit / 0.1) * 100) / 100;
  // 제보상점 K열(총점) 0.1당 인정 1건.
  const reportApprovedCount = isLeader ? null : Math.round((reportTotal / 0.1) * 100) / 100;

  const weeklyMeritBreakdown = {
    isZero: rawRank === "-",
    zeroReason,
    zeroConditions,
    studyTimeMerit,
    studyTimeHours,
    reportMerit,
    reportApprovedCount,
    isLeader,
    reportMeritIncluded: weekdayComplete,
    multiplier,
    multiplierDowngraded,
    reasonLeaveTotal,
    penaltyDeduction,
    fineDeduction,
    weeklyTotalFineAmount,
    computedMerit,
  };

  const depositAgainDay = depositAgainOccurredDay(outputPenSlots.outputPenHistory, outputPenSlots.timePenHistory);

  // 🔧 [대기 중 사유반휴 표시] 봇이 꺼져있어도 전체 대시보드가 죽지 않도록
  // try/catch로 감싸고, 실패하면 빈 배열(=대기 정보 없음)로 조용히 넘어간다.
  // 짧은 타임아웃(2초)을 써서 봇이 꺼져 있어도 대시보드 로딩이 8초씩 늘어지지
  // 않게 한다 — 이 정보는 있으면 좋은 부가 정보이지 필수 정보가 아니다.
  let pendingReasonLeaveDays = [];
  try {
    const [leaveProofData, queuedDays] = await Promise.all([
      proxyToBotDashboard(
        env,
        "/leave-proof?status=pending&number=" + encodeURIComponent(memberNumber),
        { timeoutMs: 2000 }
      ),
      listQueuedReasonLeaveDays(env, memberNumber),
    ]);
    const botDays = ((leaveProofData && leaveProofData.items) || []).map((item) => item.day);
    pendingReasonLeaveDays = [...new Set([...botDays, ...queuedDays])];
  } catch {
    pendingReasonLeaveDays = [];
  }

  const { days, weekTotalConfirmed } = buildStatusDays(
    rows,
    goalType,
    periodGrid,
    depositAgainDay,
    pendingReasonLeaveDays,
    weekMonday
  );

  const depositAgainSplit = await buildDepositAgainSplit(env, accessToken, fileId, memberName, days, weekMonday);
  // exitRequestEntry/exitRequestDate는 위(depositRefundBreakdown 호출 이전)에서
  // 이미 조회해둔 값을 그대로 재사용한다.

  return {
    name: memberName,
    goalType,
    joinDate,
    joinDateExact,
    weeklyMerit,
    weeklyMeritRank,
    weeklyMeritBreakdown,
    normalLeaveLeft,
    reasonLeaveLeft,
    days,
    weekTotalConfirmed,
    depositRefundEstimate,
    depositRefundBreakdown: depositRefundBreakdownResult,
    exitRequested: exitRequestEntry !== null,
    exitRequestDate,
    exitAgreedAt,
    periodAttendanceRate,
    periodAttendanceBreakdown: periodAttendanceBreakdownResult,
    periodGrid,
    weeklyGoalTime: weeklyGoalTimeStr,
    weeklyStudyTime: weeklyStudyTimeStr,
    weeklyTotalFine,
    weeklyOutputPen,
    weeklyTimePen,
    totalPenaltyBreakdown: totalPenaltyBreakdownResult,
    depositAgainSplit,
  };
}

// 🔧 2026-09: 퇴실자 백업 탭("{이름} (퇴실)")을 buildPersonalStatus와 동일한
// StatusResponse 형태로 읽어 관리자 "다른 회원 보기"에서 조회할 수 있게
// 한다. buildPersonalStatus를 그대로 재사용하지 않는 이유 — 그 함수는
// "지금 살아있는 회원"을 전제로 순위(getMeritRank)/제보점수(getReportScore)/
// 페널티 슬롯(getOutputPenSlots)/현재 사이클(getCurrentPenCycle)/퇴실신청
// KV를 전부 실시간 재조회하는데, 퇴실자는 회원번호 자체가 없어(백업 탭
// 이름이 시트명) 이 조회들이 애초에 성립하지 않거나, 그 번호가 재사용된
// 새 회원의 값을 잘못 가져올 수 있다. 대신 백업 탭의 요일별 셀 값(A1:U
// 범위 — copyTo로 원본을 그대로 복사했으므로 개인 탭과 레이아웃이 동일)만
// buildStatusDays 등 순수 함수로 그대로 재현하고, "다시 실시간 계산할 수
// 없는" 순위/제보점수/페널티 슬롯 이력은 조회 불가를 뜻하는 값으로 채운다.
async function buildExitedMemberSnapshot(env, accessToken, fileId, backupSheetName) {
  const rows = await getSheetValues(
    env,
    accessToken,
    fileId,
    `'${backupSheetName}'!A1:U${ROW_REPORT_SHEET_ROW + 1}`
  ).catch(() => null);
  if (!rows || rows.length <= ROW_MORNING_FINE) return null;

  const displayName = EXITED_BACKUP_SHEET_RE.exec(backupSheetName)?.[1] || backupSheetName;
  const goalType = (rows[2] && rows[2][14]) || "";
  const joinDate = (rows[ROW_JOIN_DATE] && rows[ROW_JOIN_DATE][8]) || "";
  const joinDateExact = (rows[1] && rows[1][8]) || "";
  // 퇴실 시점 스냅샷이라 "이번 주"라는 개념이 없다 — 백업 탭이 만들어진 그
  // 순간이 기준이라, 요일별 날짜(days[i].date)는 계산하지 않고 buildStatusDays
  // 가 받는 weekMonday만 오늘 기준으로 채운다(요일 순서/라벨 표시에만 쓰이고
  // "가입 전 요일 비활성화" 판정에는 이미 joinDateExact가 과거 값이라 항상
  // 통과한다).
  const weekMonday = currentWeekMondayKST();
  const weeklyMerit = (rows[ROW_WEEKLY_MERIT] && rows[ROW_WEEKLY_MERIT][2]) || "0";
  const normalLeaveLeft = (rows[ROW_NORMAL_LEAVE_LEFT] && rows[ROW_NORMAL_LEAVE_LEFT][2]) || "0";
  const reasonLeaveLeft = (rows[ROW_REASON_LEAVE_LEFT] && rows[ROW_REASON_LEAVE_LEFT][2]) || "0";
  const weeklyTotalFineAmount = safeNumber((rows[ROW_WEEKLY_TOTAL_FINE] && rows[ROW_WEEKLY_TOTAL_FINE][2]) || 0);
  const weeklyTotalFine = `₩${weeklyTotalFineAmount.toLocaleString()}`;
  const weeklyGoalTimeStr = weeklyGoalTime(rows, goalType);
  const weeklyStudyTimeStr = (rows[ROW_WEEKLY_STUDY_TIME] && rows[ROW_WEEKLY_STUDY_TIME][2]) || "00:00";
  const periodAttendanceRateRaw = (rows[ROW_PERIOD_ATTENDANCE_RATE] && rows[ROW_PERIOD_ATTENDANCE_RATE][2]) ?? "-";
  const periodAttendanceRate =
    periodAttendanceRateRaw === "-" || periodAttendanceRateRaw === ""
      ? "-"
      : `${Math.round(safeNumber(periodAttendanceRateRaw))}%`;
  const periodAttendanceBreakdownResult = periodAttendanceBreakdown(rows, goalType);
  const periodGrid = buildPeriodGrid(rows);
  const depositRefundEstimate =
    (rows[ROW_DEPOSIT_REFUND_ESTIMATE] && rows[ROW_DEPOSIT_REFUND_ESTIMATE][COL_DEPOSIT_REFUND_ESTIMATE]) || "-";

  // 조회 불가 — 이미 퇴실 확정되어 재계산할 "현재 사이클"이 없다. 총
  // 페널티/제보상점 모달은 "적립 이력 조회 불가"로 빈 채 표시된다.
  const outputPenSlots = { values: [0, 0, 0, 0, 0, 0], timePenHistory: [], outputPenHistory: [] };
  const penCounts = { outputPen: 0, timePen: 0, total: 0 };
  const depositRefundBreakdownResult = depositRefundBreakdown(rows, penCounts, null);
  const zeroConditions = meritZeroConditions(rows, depositRefundBreakdownResult.daysSinceJoin, penCounts.total);
  const zeroReason = (zeroConditions.find((c) => c.met) || {}).label || null;
  // 순위는 이미 퇴실해 집계 시트에서 빠진 회원이라 애초에 없다 — 조회
  // 시도 자체가 의미 없으므로 곧바로 "조회 불가" 라벨을 붙인다.
  const weeklyMeritRank = "- (퇴실자, 조회 불가)";
  const totalPenaltyBreakdownResult = totalPenaltyBreakdown(outputPenSlots);

  const partiStatus = (rows[ROW_PARTI_STATUS] && rows[ROW_PARTI_STATUS][COL_PARTI_STATUS]) || "";
  const isLeader = partiStatus === "스터디장" || partiStatus === "부스터디장";
  const studyTimeMerit = safeNumber((rows[ROW_STUDY_TIME_MERIT] && rows[ROW_STUDY_TIME_MERIT][2]) || 0);
  const weekdayComplete = isWeekdayComplete(rows);
  const reasonLeaveTotal = weeklyReasonLeaveTotal(rows);
  const multiplier = meritMultiplier(goalType, reasonLeaveTotal);
  const baseMultiplier = GOAL_TYPE_MULTIPLIER[goalType] ?? 1;
  const multiplierDowngraded = reasonLeaveTotal >= 2 && multiplier !== baseMultiplier;
  const studyTimeHours = Math.round((studyTimeMerit / 0.1) * 100) / 100;

  const weeklyMeritBreakdown = {
    isZero: true,
    zeroReason,
    zeroConditions,
    studyTimeMerit,
    studyTimeHours,
    // 제보상점은 "데이터" 시트 슬롯 재조회가 필요해 조회 불가 — 0으로 둔다.
    reportMerit: 0,
    reportApprovedCount: isLeader ? null : 0,
    isLeader,
    reportMeritIncluded: weekdayComplete,
    multiplier,
    multiplierDowngraded,
    reasonLeaveTotal,
    penaltyDeduction: 0,
    fineDeduction: 0,
    weeklyTotalFineAmount,
    computedMerit: safeNumber(weeklyMerit),
  };

  const { days, weekTotalConfirmed } = buildStatusDays(rows, goalType, periodGrid, null, [], weekMonday);

  return {
    name: displayName,
    goalType,
    joinDate,
    joinDateExact,
    weeklyMerit,
    weeklyMeritRank,
    weeklyMeritBreakdown,
    normalLeaveLeft,
    reasonLeaveLeft,
    days,
    weekTotalConfirmed,
    depositRefundEstimate,
    depositRefundBreakdown: depositRefundBreakdownResult,
    exitRequested: false,
    exitRequestDate: null,
    exitAgreedAt: null,
    periodAttendanceRate,
    periodAttendanceBreakdown: periodAttendanceBreakdownResult,
    periodGrid,
    weeklyGoalTime: weeklyGoalTimeStr,
    weeklyStudyTime: weeklyStudyTimeStr,
    weeklyTotalFine,
    weeklyOutputPen: 0,
    weeklyTimePen: 0,
    totalPenaltyBreakdown: totalPenaltyBreakdownResult,
    depositAgainSplit: null,
  };
}

// 이번 주 안에 performDepositAgainReset이 실행된 적이 있는지 "{이름} (재납
// {timestamp})" 탭으로 감지한다. 같은 회원이 여러 번 재납됐을 수 있으니
// timestamp가 가장 큰(=가장 최근) 탭 하나만 "재납 전" 스냅샷으로 쓴다 —
// 그 이전 재납은 이미 그보다 더 이전 스냅샷에 흡수되어 있다고 본다.
// 리셋 후 요일이 하루도 지나지 않았다면(재납일이 이번 주의 마지막 완결
// 요일) 분리해서 보여줄 의미가 없으므로 null을 반환한다.
async function buildDepositAgainSplit(env, accessToken, fileId, memberName, currentDays, weekMonday) {
  const prefix = `${memberName} (재납 `;
  const sheets = await getSpreadsheetMeta(env, accessToken, fileId);
  const candidates = sheets
    .map((s) => s.title)
    .filter((title) => title.startsWith(prefix) && title.endsWith(")"))
    .sort();
  const backupName = candidates[candidates.length - 1];
  if (!backupName) return null;

  const backupRows = await getSheetValues(env, accessToken, fileId, `'${backupName}'!A1:U${ROW_REPORT_SHEET_ROW + 1}`);
  const before = buildDepositAgainSnapshot(backupRows);
  if (!before) return null;

  // 🔧 [재납 당일 활동 유실 수정] 원래는 백업 탭에 "complete"(1~14교시 전부
  // 채워짐)인 마지막 요일을 경계로 삼았다 — 그런데 재납 확정 처리는 항상
  // 그 판정 근거가 된 날(예: 화요일 일간 집계로 재납 대상 확정)의 다음날
  // 이후에나 실제로 일어난다(사용자 지적). 그래서 확정 처리 당일(예: 수요일)
  // 오전 활동은 그날이 아직 미완결이라 "재납 전"에도 못 들어가고, 초기화된
  // "재납 후" 탭에도 없어 화면 어디에도 안 보이는 문제가 있었다. 백업 시트
  // 이름에 남는 실제 확정 시각(Date.now())을 직접 읽어, "확정일 전날까지"를
  // 경계로 정확히 잡는다 — 확정 당일부터는 완결 여부와 무관하게 "재납 후"로
  // 보존된다.
  const backupTsMatch = /\(재납 (\d+)\)$/.exec(backupName);
  const backupTsMs = backupTsMatch ? parseInt(backupTsMatch[1], 10) : NaN;
  let boundaryIndex = -1;
  if (weekMonday && Number.isFinite(backupTsMs)) {
    const resetDateStr = formatISODate(new Date(backupTsMs + 9 * 60 * 60 * 1000));
    const resetDayIndex = Math.round((new Date(resetDateStr).getTime() - weekMonday.getTime()) / 86_400_000);
    // 확정일이 이번 주(월~일, 0~6) 범위 안일 때만 이 방식을 쓴다 — 범위
    // 밖(예: 백업이 지난 주에 만들어졌거나 시계 오차)이면 아래 폴백으로 넘어간다.
    if (resetDayIndex >= 0 && resetDayIndex <= 6) {
      boundaryIndex = resetDayIndex - 1;
    }
  }
  if (boundaryIndex === -1 && !(weekMonday && Number.isFinite(backupTsMs))) {
    // 폴백: weekMonday를 못 받았거나 백업 이름에서 시각을 못 읽은 경우,
    // 기존처럼 "실제로 기록이 남은 마지막 완결 요일"을 경계로 삼는다.
    before.days.forEach((d, i) => {
      if (d.complete) boundaryIndex = i;
    });
  }
  if (boundaryIndex === -1) return null;

  const boundaryDay = STATUS_DAYS[boundaryIndex];

  // 요일별 카드는 "재납 전" 구간(경계 요일 포함)은 백업 탭 값을, 그 뒤는
  // 현재 탭 값을 그대로 쓴다 — 이미 각자 정확한 값을 담고 있으니 덮어쓰기만
  // 하면 된다.
  const mergedDays = currentDays.map((d, i) => (i <= boundaryIndex ? before.days[i] : d));
  const { days: _beforeDays, ...beforeSummary } = before;

  return { boundaryDay, before: beforeSummary, days: mergedDays };
}

// STATUS_DAY_COLS(0-indexed)를 실제 시트 열 문자(A1 표기)로 변환한다. 26 이하만
// 다루므로 A~Z 단일 문자면 충분하다.
function colIndexToLetter(col) {
  return String.fromCharCode(65 + col);
}

// exitStatus(getAllExitRelevantStatus)와 paymentRows(getAllPaymentRows)는
// 둘 다 "15명 개인 탭 A1:U(대략 30~40행)"이라는 거의 같은 범위를 각자
// batchGet했다 — ROW_REASON_LEAVE_LEFT(40)가 ROW_PAYMENT_CHECK(31)보다
// 넓은 범위라, 더 넓은 쪽 하나로 통일해 캐시/호출 자체를 공유한다.
// 🔧 [사용자 지시, 2026-09-11] ACCOUNT 탭 TTL 점검 — 벌금 처리(fine 그룹)는
// 프론트가 확정 후 즉시 재조회(`AdminMoneyTab`의 write-then-reload)해
// 캐시 TTL 자체는 체감 UX에 영향이 없고, 매주 sheet_reset()의 직접쓰기가
// 무효화를 못 받는 gap도 주 1회뿐이라 영향이 작다고 판단해 60초→10분으로
// 올린다. KV 쓰기는 파일당 1개 키만 남으므로(회원 수와 무관) 하루 최악치도
// 여전히 안전하다.
async function getSharedMemberRows(env, accessToken, fileId, members) {
  return _cachedCompute(env, `memberRows:${fileId}`, 10 * 60_000, () => {
    const ranges = members.map((m) => `${m.number}!A1:U${ROW_REASON_LEAVE_LEFT + 1}`);
    return batchGetSheetValues(env, accessToken, fileId, ranges);
  });
}

// 15개 개인 탭을 병렬로 훑어 "✅ 납부확인" 행에 "미납"이 찍힌 요일만 모은다.
// listUnpaidFines/listPaidFines/listExemptFines가 이 공통 조회를 재사용해
// 상태값(미납/납부/면제)별로 걸러내기만 한다.
async function getAllPaymentRows(env, accessToken, fileId, members) {
  const allRows = await getSharedMemberRows(env, accessToken, fileId, members);
  return members.map((member, i) => {
    const rows = allRows[i];
    return { member, paymentRow: (rows && rows[ROW_PAYMENT_CHECK]) || [] };
  });
}

function collectFinesByStatus(paymentRows, status) {
  return paymentRows.flatMap(({ member, paymentRow }) => {
    const days = STATUS_DAYS.filter((day, i) => paymentRow[STATUS_DAY_COLS[i]] === status);
    return days.map((day) => ({ number: member.number, name: member.name, day }));
  });
}

// 15개 개인 탭을 병렬로 훑어 "✅ 납부확인" 행에 "미납"이 찍힌 요일만 모은다.
async function listUnpaidFines(env, accessToken, fileId) {
  const members = await listAllMembers(env, accessToken, fileId);
  const paymentRows = await getAllPaymentRows(env, accessToken, fileId, members);
  return collectFinesByStatus(paymentRows, "미납");
}

// 15개 개인 탭을 병렬로 훑어 "✅ 납부확인" 행에 "납부"가 찍힌 요일만 모은다.
async function listPaidFines(env, accessToken, fileId) {
  const members = await listAllMembers(env, accessToken, fileId);
  const paymentRows = await getAllPaymentRows(env, accessToken, fileId, members);
  return collectFinesByStatus(paymentRows, "납부");
}

// 집계 탭 D22(주간 벌금 = 15명의 "납부" 처리된 일간 벌금 합산)를 읽는다.
// "Money" 탭의 "납부" 목록을 열 때마다 다시 읽을 필요가 없는 값이라
// 캐싱한다 — 벌금 상태 변경(handleAdminFineStatus)이 이미
// invalidateMemberCache를 호출하므로 그 무효화 대상에 포함시킨다. TTL은
// 무효화가 놓친 경우의 안전망일 뿐이라 5분으로 늘려 KV 읽기 빈도를 줄인다
// (docs/CACHING_POLICY.md §5, 2026-09).
// 🔧 [사용자 지시, 2026-09-11] 5분→10분 재상향 — 이 값은 "납부된 총
// 벌금액" 표시 전용이고(강제퇴실 판정 등 다른 계산엔 안 쓰임), 유일한
// 쓰기 경로(handleAdminFineStatus)가 항상 확실히 무효화하며 이를 우회하는
// 쓰기 경로(앱스크립트 등)도 없다 — TTL은 순수 안전망이라 10분으로
// 늘려도 위험이 없다고 재검증했다(§33).
async function getWeeklyPaidFineTotal(env, accessToken, fileId) {
  return _cachedCompute(env, `weeklyPaidFine:${fileId}`, 10 * 60_000, async () => {
    const rows = await getSheetValues(env, accessToken, fileId, "집계!D22");
    return safeNumber((rows && rows[0] && rows[0][0]) || 0);
  });
}

// 15개 개인 탭을 병렬로 훑어 "✅ 납부확인" 행에 "면제"가 찍힌 요일만 모은다.
async function listExemptFines(env, accessToken, fileId) {
  const members = await listAllMembers(env, accessToken, fileId);
  const paymentRows = await getAllPaymentRows(env, accessToken, fileId, members);
  return collectFinesByStatus(paymentRows, "면제");
}

// --- 핸들러 ---

// googleUser({email, name})가 확보된 뒤(구글 credential 검증이든, 아래
// handleDevLogin의 시크릿 검증이든) 공통으로 거치는 로그인 완료 절차 —
// 명단 확인, 회원번호 조회, 최근 접속 기록, 세션 토큰 발급. recordLastLogin
// 을 false로 넘기면 lastLogin 기록을 건너뛴다(개발용 로그인이 실제 접속
// 이력을 오염시키지 않도록 — handleDevLogin 전용).
async function completeLogin(req, env, origin, googleUser, { recordLastLogin = true } = {}) {
  let viewerEmails;
  try {
    viewerEmails = await getSheetViewerEmails(env);
  } catch (err) {
    return json({ error: "명단 조회 실패: " + err.message }, 500, origin);
  }

  if (!viewerEmails.includes(googleUser.email)) {
    return json({ error: "캠스터디 참여자 명단에서 확인되지 않는 계정입니다." }, 403, origin);
  }

  // 로그인 시점에 회원번호를 함께 조회해 세션에 실어두면, 이후 /status 호출마다
  // 권한관리 탭을 다시 조회하지 않아도 된다 (Sheets API 호출 1회 절감).
  let member = null;
  try {
    const accessToken = await getServiceAccountAccessToken(env);
    member = await findMemberNumberByEmail(env, accessToken, env.GOOGLE_SHEET_FILE_ID, googleUser.email);
  } catch {
    // 조회 실패해도 로그인 자체는 막지 않는다 — /status에서 폴백 조회로 재시도.
  }

  // 🔧 [최근 접속일자·IP] 관리자 "스터디원 목록"이 각 회원의 마지막 로그인
  // 시각·IP를 보여줄 수 있도록 기록한다 — 로그인 자체를 막으면 안 되므로
  // 실패해도 조용히 넘어간다. CF-Connecting-IP는 Cloudflare가 프록시 체인을
  // 거쳐도 실제 클라이언트 IP로 신뢰하는 헤더다(X-Forwarded-For처럼 클라이언트가
  // 임의로 위조해 넣을 수 없다). 🔧 [KV → DO 이전, 2026-09-12] §49 —
  // MemberSettingsDO로 이전.
  if (member && recordLastLogin) {
    const ip = req.headers.get("CF-Connecting-IP") || "";
    await getMemberSettingsStub(env)
      .fetch("https://do/last-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberNumber: member.number, ts: Date.now(), ip }),
      })
      .catch(() => {});
  }

  const token = await signSession(
    {
      email: googleUser.email,
      name: googleUser.name,
      memberNumber: member ? member.number : null,
      memberName: member ? member.name : null,
      exp: Date.now() / 1000 + SESSION_TTL_SEC,
    },
    env.SESSION_SECRET
  );

  return json({ token, name: googleUser.name, email: googleUser.email }, 200, origin);
}

async function handleVerify(req, env, origin) {
  const { credential } = await req.json();
  if (!credential) return json({ error: "credential 누락" }, 400, origin);

  let googleUser;
  try {
    googleUser = await verifyGoogleIdToken(credential, env.GOOGLE_CLIENT_ID);
  } catch (err) {
    return json({ error: "구글 인증 실패: " + err.message }, 401, origin);
  }

  return completeLogin(req, env, origin, googleUser);
}

// 🔧 [Playwright 점검용 로그인 우회, 2026-09] 구글 OAuth 팝업을 자동화
// 도구가 통과할 수 없어, 실제 화면 점검(로그인 이후 화면들)을 스크립트로
// 확인할 방법이 없었다. env.DEV_LOGIN_SECRET이 등록돼 있을 때만(=이
// 시크릿을 명시적으로 wrangler secret put한 경우에만) 존재하는 라우트 —
// 등록하지 않으면 이 함수가 항상 404를 반환해 프로덕션에서는 이 경로가
// 있는지조차 알 수 없다. 구글 credential 검증만 건너뛸 뿐, 이후 절차
// (참여자 명단 확인 등)는 완전히 동일해 명단에 없는 이메일로는 여전히
// 로그인할 수 없다 — "실명 확인을 생략"하는 것이지 "권한 검사를
// 생략"하는 게 아니다.
async function handleDevLogin(req, env, origin) {
  if (!env.DEV_LOGIN_SECRET) return json({ error: "not found" }, 404, origin);
  const secret = req.headers.get("X-Dev-Login-Secret");
  if (!secret || secret !== env.DEV_LOGIN_SECRET) {
    return json({ error: "unauthorized" }, 401, origin);
  }
  const { email, name } = await req.json().catch(() => ({}));
  if (!email) return json({ error: "email 누락" }, 400, origin);

  return completeLogin(req, env, origin, { email: email.toLowerCase(), name: name || email }, { recordLastLogin: false });
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

async function handleReport(req, env, origin) {
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
async function handleListActiveCooldowns(req, env, origin) {
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
async function handleReportCaptureDone(req, env, origin) {
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

// 봇(study_manager_260418.py)이 이 Worker와 같은 Google 서비스 계정을 써서
// 직접 Sheets API(gspread)를 호출한다 — Worker 자신의 호출만 세면 실제
// 분당 사용량을 과소평가하게 되므로, 봇이 usage_tracker.py로 자신의 호출
// 수를 5초 간격으로 이렇게 보고하면 Worker의 기존 카운터에 합산한다.
async function handleBotSheetsUsageReport(req, env, origin) {
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
async function handleInternalCycleBoundary(req, env, origin) {
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

// 🔧 [KV → DO 이전, 2026-09-12] ReportQueue DO의 /drain이 "list + 각
// get + 각 delete + 정렬"을 전부 대체한다(§ReportQueue 클래스 주석
// 참고) — 응답 형태(entries 배열 그대로, ok 래핑 없음)는 이전과 동일해
// report_intake.py 쪽 코드는 손댈 필요가 없다.
async function handleListReports(req, env, origin) {
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
async function handleRequeueReport(req, env, origin) {
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

// --- 도움봇(study_manager_260418.py) 원격 상태/명령 ---
// 봇은 로컬 PC에서 Cloudflare Tunnel(cloudflared)로 자신의 로컬 상태
// 서버를 외부에 노출한다. 이 Worker는 봇이 (재)시작될 때 등록해온
// Tunnel URL을 저장해두고, 관리자가 상태를 조회하거나 재시작을
// 누를 때만 그 URL로 즉시 요청을 프록시한다 — 주기적 폴링이 없으므로
// 쓰기가 봇이 (재)시작될 때만 발생해 무료 티어 쓰기 한도에 안전하다.
// 🔧 [KV → DO 이전, 2026-09-12] §49 — BotAdminConfigDO로 이전. 읽기는
// 거의 모든 봇 프록시 호출마다 발생하지만, 실측상 DO fetch(수 ms) 지연은
// proxyToBotDashboard 자체(봇 서버까지 수백ms~수초)에 비해 무시할
// 수준이라 일관성을 위해 함께 옮겼다(사용자 확인).
const BOT_URL_CONFIG_KEY = "botUrl";
const BOT_PROXY_TIMEOUT_MS = 8000;

async function handleBotRegisterUrl(req, env, origin) {
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

async function proxyToBotDashboard(env, path, options = {}) {
  const urlRes = await getBotAdminConfigStub(env).fetch(`https://do/config?key=${BOT_URL_CONFIG_KEY}`);
  const { value: url } = await urlRes.json();
  if (!url) return null;

  // 🔧 [사유반휴 대기 조회 지연 방지] buildPersonalStatus가 매 상태 조회마다
  // 대기 중 사유반휴 여부를 물어보는데, 기본 8초 타임아웃을 그대로 쓰면 봇이
  // 꺼져 있는 동안 로그인/새로고침마다 8초씩 늘어진다. 부가 정보 조회처럼
  // 짧게 실패해도 되는 호출은 options.timeoutMs로 개별 단축할 수 있게 한다.
  const { timeoutMs, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? BOT_PROXY_TIMEOUT_MS);
  try {
    const res = await fetch(url + path, {
      ...fetchOptions,
      headers: { "X-Dashboard-Secret": env.BOT_SECRET, ...(fetchOptions.headers || {}) },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
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
async function handleAdminUsageStatus(req, env, origin) {
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

async function handleAdminBotStatus(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const data = await proxyToBotDashboard(env, "/status");
  if (!data) {
    return json({ online: false, roomState: null, screenshot: null, recentLogs: [] }, 200, origin);
  }
  return json(data, 200, origin);
}

const BOT_COMMAND_VALUES = ["restart"];

async function handleAdminBotCommand(req, env, origin) {
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

// proxyToBotDashboard는 항상 res.json()을 호출해 JSON 응답만 다룰 수 있다.
// 제보 캡처 파일(이미지/영상)은 바이너리이므로, 파싱하지 않고 Response를
// 그대로 넘기는 버전이 별도로 필요하다.
async function proxyToBotDashboardRaw(env, path) {
  const urlRes = await getBotAdminConfigStub(env).fetch(`https://do/config?key=${BOT_URL_CONFIG_KEY}`);
  const { value: url } = await urlRes.json();
  if (!url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BOT_PROXY_TIMEOUT_MS);
  try {
    const res = await fetch(url + path, {
      headers: { "X-Dashboard-Secret": env.BOT_SECRET },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 각 제보 항목이 승인되면 몇 차 슬롯(1~6차)에 기록될지 미리 계산해 "nextOccurrence"
// 필드로 항목에 얹는다 — 프론트가 승인 전에 버튼 라벨(구두경고/벌점/페널티)을
// 정확히 보여줘야 하기 때문. 회원별로 개별 조회하지 않고 "데이터" 시트
// F4:K18을 한 번에 읽어 닉네임→회원번호 매핑으로 계산한다. 제보자 이메일
// (reporterEmail)도 같은 명단으로 이름을 찾아 reporterName으로 함께 붙인다
// — UI가 이메일 대신 이름을 보여줘야 하기 때문.
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

// KST(Asia/Seoul) 기준 "YYYY-MM-DD" 날짜 문자열 — "당일" 판정에 쓴다.
function kstDateKey(ts) {
  return new Date(ts).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }); // sv-SE 로케일이 YYYY-MM-DD를 그대로 출력.
}

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

async function applyAutoRecognitionForExpired(env, items) {
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

async function handleAdminCapturesList(req, env, origin, url) {
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
async function handleMyCaptures(req, env, origin, url) {
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
async function handleMyCaptureDelete(req, env, origin) {
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
async function handleMyOutputPen(req, env, origin, url) {
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
async function handleCaptureTargetRespond(req, env, origin) {
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
async function handleAdminCaptureVote(req, env, origin) {
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
async function handleAdminCaptureFile(req, env, origin, url) {
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

// 🔧 [데이터 시트 통합] "페널티"(구 "송출 P") 탭이 "권한관리"/"제보상점"과 함께
// "데이터" 탭으로 흡수됐다. 송출P 슬롯 위치도 D~I → F~K로 옮겨졌다.
const OUTPUT_PEN_SHEET_NAME = "데이터";
// 1차~6차 컬럼(F~K) 중 어떤 차수가 "송출P 발생(페널티)" 액션인지 — C39 수식과
// 동일한 기준(4차=I, 6차=K).
const OUTPUT_PEN_SLOT_COLUMNS = ["F", "G", "H", "I", "J", "K"]; // 1차..6차
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

// "송출 P" 탭에서 한 행(D~I 6칸)의 주석을 한 번에 읽는다. spreadsheets.get의
// fields 파라미터로 note만 좁혀서 값 API보다 훨씬 가벼운 응답을 받는다.
async function getRowNotes(env, accessToken, fileId, sheetId, rowIndex, startCol, endCol) {
  _bumpUsageCounter("sheets_read");
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}?` +
      `ranges=${encodeURIComponent(`'${OUTPUT_PEN_SHEET_NAME}'!${startCol}${rowIndex + 1}:${endCol}${rowIndex + 1}`)}` +
      `&fields=sheets.data.rowData.values.note`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  const rowData = data.sheets && data.sheets[0] && data.sheets[0].data && data.sheets[0].data[0] && data.sheets[0].data[0].rowData;
  const values = (rowData && rowData[0] && rowData[0].values) || [];
  return values.map((v) => (v && v.note) || "");
}

// "데이터" 탭 F4:M18(송출P+주간P 슬롯 전체)의 주석을 한 번의 spreadsheets.get
// 호출로 모두 읽는다. "페널티 대상자" 목록이 회원별로 "언제 2회에 도달했는지"를
// 알아야 하는데, 그 근거가 되는 발생일시가 슬롯 주석에만 있기 때문이다.
// 반환값은 행 인덱스(0-based, 4행=0)별 note 배열(F~M 8칸).
async function getPenaltySlotNotesGrid(env, accessToken, fileId) {
  _bumpUsageCounter("sheets_read");
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}?` +
      `ranges=${encodeURIComponent(`'${OUTPUT_PEN_SHEET_NAME}'!F4:M18`)}` +
      `&fields=sheets.data.rowData.values.note`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  const rowData = data.sheets && data.sheets[0] && data.sheets[0].data && data.sheets[0].data[0] && data.sheets[0].data[0].rowData;
  return (rowData || []).map((row) => (row.values || []).map((v) => (v && v.note) || ""));
}

// 채워진 슬롯(값이 0이 아닌 칸)들의 주석 중 "YYYY-MM-DD"로 시작하는 가장 최근
// 날짜를 찾아 발생 요일(월~일)로 변환한다. 주석이 하나도 없으면 null.
// 슬롯 주석("2026. 8. 25. 오후 3:41:46 · 사유" 또는 appscript.js
// get_formatted_date의 "2026-08-25 · 사유")에서 날짜만 UTC 자정 ms로 뽑는다.
// 파싱 실패 시 null.
function parseSlotNoteDateMs(note) {
  // "2026. 8. 25." 형식(index.js applyOutputPenalty의 toLocaleString)
  let m = /^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\./.exec(note || "");
  // "2026-08-25" 형식(appscript.js get_formatted_date)
  if (!m) m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(note || "");
  if (!m) return null;
  return Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
}

function msToStatusDay(ms) {
  const jsDay = new Date(ms).getUTCDay(); // 일=0 ... 토=6 (UTC 자정 고정이라 타임존 영향 없음)
  return STATUS_DAYS[(jsDay + 6) % 7]; // 월=0 ... 일=6으로 보정
}

// 🔧 [날짜 파싱 버그] 이전 정규식은 "YYYY-MM-DD"만 인식했지만, 실제 주석은
// applyOutputPenalty()가 toLocaleString("ko-KR", {timeZone:"Asia/Seoul"})로
// 남긴 "2026. 8. 25. 오후 3:41:46 · 사유"(점+공백 구분, 한 자리 월/일 가능)
// 형식이라 전혀 매칭되지 않았다 — "요일 미확인"으로만 빠지던 원인.
// appscript.js daily_calc()가 남기는 "YYYY-MM-DD · 사유"(get_formatted_date)
// 형식도 함께 지원한다.
function latestSlotDay(slotValues, slotNotes) {
  let latestMs = null;
  slotValues.forEach((v, i) => {
    if (!v) return;
    const ms = parseSlotNoteDateMs(slotNotes[i] || "");
    if (ms === null) return;
    if (latestMs === null || ms > latestMs) latestMs = ms;
  });
  if (latestMs === null) return null;
  return msToStatusDay(latestMs);
}

// 🔧 [예치금 재납 발생일] R3(예치금 재납 상태)는 개인 탭 상단의 "현재 시점
// 스냅샷" 하나뿐이라 요일 정보가 없다 — 그대로 쓰면 이번 주 모든 요일
// 카드에 동일하게 표시되는 문제가 있다(사용자 지적). "예치금 재납 대상"이
// 되는 건 이번 사이클에 실제로 카운트되는 슬롯(송출P 4차/6차, 주간P
// 1차/2차)이 2개 이상 채워진 시점이므로, 그 슬롯들의 주석 날짜를 오름차순
// 정렬해 2번째(=2회 달성 시점) 날짜의 요일을 "발생일"로 판정한다. 카운트
// 슬롯이 2개 미만이면(재납 대상이 아니거나 판정 근거 부족) null.
function depositAgainOccurredDay(outputPenHistory, timePenHistory) {
  const countedEntries = [
    outputPenHistory[3], // 4차(I)
    outputPenHistory[5], // 6차(K)
    timePenHistory[0], // 주간P 1차(L)
    timePenHistory[1], // 주간P 2차(M)
  ].filter(Boolean);

  const dates = countedEntries
    .map((entry) => parseSlotNoteDateMs(entry.when))
    .filter((ms) => ms !== null)
    .sort((a, b) => a - b);

  if (dates.length < 2) return null;
  return msToStatusDay(dates[1]);
}

// F~K(송출P 1~6차) 또는 L~M(주간P 1~2차) 슬롯 중 채워진 칸만 골라
// "{차수}차 · {발생일시} · {사유}" 형태의 상세 기록 목록을 만든다. 주석은
// "{발생일시} · {사유} [cap:캡처ID]"로 저장되므로, 먼저 끝의 "[cap:...]"를
// 떼어 captureId로 뽑고 남은 부분을 "{발생일시} · {사유}"로 나눠 쓴다.
// "예치금 재납 대상자" 카드가 송출P/주간P 각각의 적립 이력을 보여주는 데 쓰인다.
function buildSlotHistory(slotValues, slotNotes, labelPrefix) {
  const history = [];
  slotValues.forEach((v, i) => {
    if (!v) return;
    let note = slotNotes[i] || "";
    let captureId = null;
    const capMatch = /\s*\[cap:([^\]]+)\]\s*$/.exec(note);
    if (capMatch) {
      captureId = capMatch[1];
      note = note.slice(0, capMatch.index);
    }
    const [when, ...reasonParts] = note.split(" · ");
    history.push({
      label: `${labelPrefix} ${i + 1}차`,
      cycle: v,
      when: when || "",
      reason: reasonParts.join(" · ") || "",
      captureId,
    });
  });
  return history;
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

async function handleAdminCaptureCancel(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { number, col, deductedMinutes, dayCol } = await req.json().catch(() => ({}));
  if (!number || !col) {
    return json({ error: "number와 col이 필요합니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    await cancelOutputPenalty(env, accessToken, env.GOOGLE_SHEET_FILE_ID, number, col, deductedMinutes || 0, dayCol || null);
    await invalidateMemberCache(env, ["penalty"]); // 페널티 슬롯이 바뀌었으므로 관련 캐시만 무효화.
    await invalidateMemberSlotCache(env, number); // 이 회원의 outputPenSlots/reportScore는 KV까지 즉시.
    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "취소 실패: " + err.message }, 500, origin);
  }
}

// applyReportMerit()로 부여한 제보상점을 되돌린다(handleAdminCaptureCancel과
// 동일 패턴, cancelReportMerit 재사용) — "적용"/"페널티 적용 (불가)"로
// 처리된 항목의 "취소" 버튼이 대상자 페널티와 별개로 호출한다.
async function handleAdminCaptureCancelMerit(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { number, col } = await req.json().catch(() => ({}));
  if (!number || !col) {
    return json({ error: "number와 col이 필요합니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    await cancelReportMerit(env, accessToken, env.GOOGLE_SHEET_FILE_ID, number, col);
    await invalidateMemberCache(env, ["penalty"]); // 제보상점 슬롯이 바뀌었으므로 관련 캐시만 무효화.
    await invalidateMemberSlotCache(env, number); // 이 회원의 outputPenSlots/reportScore는 KV까지 즉시.
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

async function handleAdminCaptureDecide(req, env, origin) {
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
  if (decision === "approved" || decision === "rejected_recognized" || decision === "deferred") {
    try {
      const accessToken = await getServiceAccountAccessToken(env);
      const fileId = env.GOOGLE_SHEET_FILE_ID;

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
      await invalidateMemberCache(env, ["penalty"]); // 페널티/제보상점 슬롯이 바뀌었으므로 관련 캐시만 무효화.
      // 대상자(penaltyResult)와 제보자(meritResult)는 서로 다른 회원일 수
      // 있다 — 둘 다 outputPenSlots/reportScore가 KV까지 즉시 지워지도록.
      if (penaltyResult?.number) await invalidateMemberSlotCache(env, penaltyResult.number);
      if (meritResult?.number) await invalidateMemberSlotCache(env, meritResult.number);
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
      const accessToken = await getServiceAccountAccessToken(env);
      deferredOccurrenceSnapshot = await snapshotNextOccurrence(env, accessToken, env.GOOGLE_SHEET_FILE_ID, nickname);
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
    // "처음부터 다시"가 되도록 한다.
    if (penaltyResult && penaltyResult.number && penaltyResult.col) {
      try {
        const accessToken = await getServiceAccountAccessToken(env);
        await cancelOutputPenalty(
          env,
          accessToken,
          env.GOOGLE_SHEET_FILE_ID,
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
        const accessToken = await getServiceAccountAccessToken(env);
        await cancelReportMerit(env, accessToken, env.GOOGLE_SHEET_FILE_ID, meritResult.number, meritResult.col);
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
        const accessToken = await getServiceAccountAccessToken(env);
        await cancelTimeDeduction(
          env,
          accessToken,
          env.GOOGLE_SHEET_FILE_ID,
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
      await invalidateMemberCache(env, ["penalty"]);
      if (penaltyResult?.number) await invalidateMemberSlotCache(env, penaltyResult.number);
      if (meritResult?.number) await invalidateMemberSlotCache(env, meritResult.number);
    }
    return json({ error: "봇에 연결할 수 없습니다. 시트 반영은 자동으로 되돌렸으니 다시 시도해주세요." }, 502, origin);
  }
  return json({ ...data, penalty: penaltyResult, merit: meritResult, timeDeduction: timeDeductionResult }, 200, origin);
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
  return { penalty: item?.penalty || null, merit: item?.merit || null, timeDeduction: item?.timeDeduction || null };
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
async function handleAdminCaptureDelete(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const body = await req.json().catch(() => ({}));
  const { id } = body;
  if (!id) return json({ error: "id가 필요합니다." }, 400, origin);
  let { penalty, merit } = body;
  if (!penalty && !merit) {
    ({ penalty, merit } = await findStoredPenaltyMerit(env, id));
  }

  if ((penalty && penalty.number && penalty.col) || (merit && merit.number && merit.col)) {
    try {
      const accessToken = await getServiceAccountAccessToken(env);
      const fileId = env.GOOGLE_SHEET_FILE_ID;
      if (penalty && penalty.number && penalty.col) {
        await cancelOutputPenalty(env, accessToken, fileId, penalty.number, penalty.col, penalty.deductedMinutes || 0, penalty.dayCol || null);
      }
      if (merit && merit.number && merit.col) {
        await cancelReportMerit(env, accessToken, fileId, merit.number, merit.col);
      }
      await invalidateMemberCache(env, ["penalty"]); // 페널티/제보상점 슬롯이 바뀌었으므로 관련 캐시만 무효화.
      if (penalty?.number) await invalidateMemberSlotCache(env, penalty.number);
      if (merit?.number) await invalidateMemberSlotCache(env, merit.number);
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
async function handleAdminCaptureRevert(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const body = await req.json().catch(() => ({}));
  const { id, skipMeritLookup } = body;
  if (!id) return json({ error: "id가 필요합니다." }, 400, origin);
  let { merit } = body;
  // 🔧 [버그 수정] cancel()이 별도로 이미 cancel-merit을 호출해 시트를
  // 되돌린 뒤 상태만 pending으로 되돌리려는 경우, merit을 굳이 안 보냈다고
  // 폴백 조회를 하면 manifest에 아직 남아있는 옛 merit 값을 다시 찾아
  // cancelReportMerit을 중복 호출하게 된다(이미 빈 슬롯을 또 지우거나,
  // 그 사이 다른 제보가 같은 슬롯을 채웠다면 잘못 지울 위험) — 호출자가
  // "직접 이미 처리했다"고 명시하면 폴백을 건너뛴다.
  let timeDeduction = null;
  if (!merit && !skipMeritLookup) {
    ({ merit, timeDeduction } = await findStoredPenaltyMerit(env, id));
  }

  if (merit && merit.number && merit.col) {
    try {
      const accessToken = await getServiceAccountAccessToken(env);
      await cancelReportMerit(env, accessToken, env.GOOGLE_SHEET_FILE_ID, merit.number, merit.col);
      await invalidateMemberCache(env, ["penalty"]); // 제보상점 슬롯이 바뀌었으므로 관련 캐시만 무효화.
      await invalidateMemberSlotCache(env, merit.number); // 이 회원의 outputPenSlots/reportScore는 KV까지 즉시.
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
        env.GOOGLE_SHEET_FILE_ID,
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
async function handleReportStatus(req, env, origin, url) {
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

async function handleStatus(req, env, origin, url) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    // cycle 쿼리 파라미터(백업 fileId)가 있으면 "현재 사이클에 속한 과거
    // 주차" 데이터를, 없으면 실시간(현재 활성 시트) 데이터를 대상으로 한다.
    const cycleFileId = url ? url.searchParams.get("cycle") : null;
    const { fileId: targetFileId, weekOf } = await resolveTargetFileId(env, accessToken, cycleFileId);

    // 세션에 회원번호가 이미 있고 실시간 조회면(대상 파일이 현재 활성
    // 시트와 같으면) 권한관리 탭 재조회를 생략한다 — 과거 백업 파일은
    // 회원 구성이 다를 수 있어 매번 다시 찾아야 한다.
    let memberNumber = session.memberNumber;
    let memberName = session.memberName;
    if (!memberNumber || targetFileId !== env.GOOGLE_SHEET_FILE_ID) {
      const member = await findMemberNumberByEmail(env, accessToken, targetFileId, session.email);
      if (!member) {
        return json({ error: "데이터 시트 명단에서 계정을 찾을 수 없습니다." }, 403, origin);
      }
      memberNumber = member.number;
      memberName = member.name;
    }

    const status = await buildPersonalStatus(env, accessToken, targetFileId, memberNumber, memberName, weekOf);
    return json(status, 200, origin);
  } catch (err) {
    return json({ error: "상태 조회 실패: " + err.message }, 500, origin);
  }
}

// 로그인한 회원 본인이 "다른 관리자 의견 반영"(공동 검토) 권한을 가졌는지
// 확인한다 — 관리자 여부와 무관하게 아무 로그인 세션이나 호출 가능(부스터디장
// 여부만 판정하는 가벼운 자기 조회). 프론트가 앱 진입 시 한 번 호출해
// "관리자" 탭·제한된 검토 화면을 보여줄지 판단하는 데 쓴다.
async function handleMyRole(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    const memberNumber = await resolveMemberNumber(env, accessToken, session).catch(() => null);
    if (!memberNumber) return json({ isCoReviewer: false }, 200, origin);
    const coReviewers = await getCurrentCoReviewers(env, accessToken, fileId);
    return json({ isCoReviewer: coReviewers.some((m) => m.number === memberNumber) }, 200, origin);
  } catch {
    return json({ isCoReviewer: false }, 200, origin);
  }
}

// --- 목표시간 다음 주 예약 ('집계' 시트 N열) ---
// 앱스크립트의 revoke_editor_column_n 트리거가 매주 월요일 오후에 N열 값을
// 읽어 각 개인 탭 O3(의무시간)에 반영한다. N열은 소유자+서비스 계정만
// 편집 가능하도록 이미 보호되어 있어(회원 본인은 월요일 아침에만 열림),
// 워커는 서비스 계정 권한으로 그 시간 제약과 무관하게 언제든 예약을 넣을 수 있다.
// 현재 주간 값(O3)은 이 트리거가 실행되기 전까지 바뀌지 않으므로 규정대로 불변이다.
const GOAL_TIME_VALID_VALUES = Object.keys(GOAL_TYPE_MULTIPLIER);

// --- 반휴 신청 (개인 탭 20/21행, 선택한 요일 칸) ---
// 20/21행 셀에 "1"을 쓰면 시트 서식이 자동으로 "반휴 X 1"처럼 꾸며 보여준다 —
// parseLeaveCount가 셀 텍스트에서 숫자만 추출하므로 값은 항상 순수 숫자로만 쓴다.
// 어느 요일에든 신청/취소할 수 있게 day 파라미터로 대상 요일을 받는다.
const LEAVE_TYPE_CONFIG = {
  normal: { useRow: ROW_NORMAL_LEAVE_USE, leftRow: ROW_NORMAL_LEAVE_LEFT, label: "일반반휴" },
  reason: { useRow: ROW_REASON_LEAVE_USE, leftRow: ROW_REASON_LEAVE_LEFT, label: "사유반휴" },
};

function statusColForDay(day) {
  const dayIndex = STATUS_DAYS.indexOf(day);
  return dayIndex === -1 ? null : STATUS_DAY_COLS[dayIndex];
}

async function resolveMemberNumber(env, accessToken, session) {
  if (session.memberNumber) return session.memberNumber;
  const member = await findMemberNumberByEmail(env, accessToken, env.GOOGLE_SHEET_FILE_ID, session.email);
  if (!member) throw new Error("데이터 시트 명단에서 계정을 찾을 수 없습니다.");
  return member.number;
}

// 일반반휴는 요일 셀에 1 또는 2를 직접 써서 그날 몇 장 쓸지 조절할 수
// 있다(시트 29행 수식이 이미 "반휴 2건 이상이면 그날 목표시간 면제"를
// count로 처리하므로 셀에 2를 써도 그대로 반영된다 — dailyGoalMinutes 참고).
// 사유반휴는 handleSetLeaveApply(직접 토글)로는 여전히 0/1만 지원하지만,
// 증빙 신청→승인 경로(handleSetReasonLeaveProof/handleAdminLeaveProofDecide)
// 로는 한 증빙에 count(1~2)를 실어 하루 2장까지 승인할 수 있다.
const LEAVE_MAX_COUNT_BY_TYPE = { normal: 2, reason: 1 };
// 하루(요일)에 한 종류의 반휴 셀에 최종적으로 쓸 수 있는 최댓값 — 일반/
// 사유 공용으로 쓰는 하루 합산 상한과 동일한 값이다(HalfDayLeaveDialog의
// MAX_LEAVES_PER_DAY와 일치시켜야 한다).
const MAX_LEAVES_PER_DAY_LIMIT = 2;

// 🔧 [관리자 대리 신청, 2026-09-10] number 쿼리 파라미터는 관리자에게만
// 허용한다 — 관리자가 다른 회원의 대시보드를 띄우면 LeaveApplyButton이
// 이 파라미터로 그 회원의 일반반휴 현재 상태를 조회해야, 관리자 본인이
// 아니라 그 회원의 값이 표시된다(handleAdminLeaveApply와 짝을 이룬다).
async function handleGetLeaveApply(req, env, origin, url) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const type = url.searchParams.get("type");
  const day = url.searchParams.get("day");
  const numberParam = url.searchParams.get("number");
  const config = LEAVE_TYPE_CONFIG[type];
  const col = statusColForDay(day);
  if (!config || col === null) return json({ error: "잘못된 요청입니다." }, 400, origin);
  if (numberParam) {
    const sheetNum = parseInt(numberParam, 10);
    if (!sheetNum || sheetNum < 1 || sheetNum > 15) return json({ error: "잘못된 요청입니다." }, 400, origin);
    const isAdminSession = session.email === (env.ADMIN_EMAIL || "").toLowerCase();
    if (!isAdminSession) return json({ error: "관리자만 다른 회원을 조회할 수 있습니다." }, 403, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const memberNumber = numberParam ? String(parseInt(numberParam, 10)) : await resolveMemberNumber(env, accessToken, session);
    const colLetter = String.fromCharCode("A".charCodeAt(0) + col);

    const [cellRows, leftRows] = await Promise.all([
      getSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, `${memberNumber}!${colLetter}${config.useRow + 1}`).catch(() => []),
      getSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, `${memberNumber}!C${config.leftRow + 1}`).catch(() => []),
    ]);
    const count = parseLeaveCount((cellRows[0] && cellRows[0][0]) || "");
    // left는 이 요일에 이미 쓴 count와 무관하게 시트에 남은 "전체 잔여"이므로,
    // 이 요일에서 더 늘릴 수 있는 최대치는 count + left(2장 상한 이내)다.
    const left = safeNumber((leftRows[0] && leftRows[0][0]) || 0);

    return json({ applied: count > 0, count, left }, 200, origin);
  } catch (err) {
    return json({ error: `${config.label} 조회 실패: ` + err.message }, 500, origin);
  }
}

// 🔧 [사용자 지시, 2026-09] "장난으로 반일 휴무를 계속 눌렀다 껐다 하면
// 쓰기 횟수가 계속 소진되는거 아니야?" — 신청/취소는 매번 진짜로 값이
// 바뀌는 조작이라(그리고 취소하면 잔여량도 다시 채워져 자연히 막히지도
// 않는다), 프론트의 "직전과 같은 값이면 무시" 방어만으로는 반복 토글을
// 못 막는다. 한 번의 토글마다 시트 쓰기 1회 + KV 삭제 1회
// (invalidatePersonalStatusCache)가 실제로 발생하므로, 회원 1명당 1분에
// 2회까지만 허용한다 — 정상 사용(신청 또는 취소 한 번)은 전혀 걸리지
// 않고, 연타 스팸만 막는다. 고정 60초 창 방식(슬라이딩 윈도우가 아님)
// 이라 창 경계에서 약간의 버스트 여지는 있지만, 이건 보안 목적이 아니라
// 남용 억제용이라 이 정도 근사로 충분하다.
// 🔧 [KV → DO 이전, 2026-09-12] §47 — ParticipantsRoster DO의
// /leave-rate/check로 이전(순수 임시 상태, notices/reportCooldowns와
// 동일한 배열 push+filter 패턴 재사용).
async function checkAndRecordLeaveApplyRate(env, memberNumber) {
  const res = await getRosterStub(env).fetch("https://do/leave-rate/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memberNumber }),
  });
  const { allowed } = await res.json();
  return allowed;
}

async function handleSetLeaveApply(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const body = await req.json().catch(() => ({}));
  const { type, day } = body;
  const config = LEAVE_TYPE_CONFIG[type];
  const col = statusColForDay(day);
  const maxCount = LEAVE_MAX_COUNT_BY_TYPE[type] || 1;
  // 하위호환: applied(boolean)만 오면 0/1로, count(number)가 오면 그대로 쓴다.
  const count =
    typeof body.count === "number"
      ? body.count
      : typeof body.applied === "boolean"
        ? body.applied
          ? 1
          : 0
        : NaN;
  if (!config || col === null || !Number.isInteger(count) || count < 0 || count > maxCount) {
    return json({ error: "잘못된 요청입니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const memberNumber = await resolveMemberNumber(env, accessToken, session);

    if (!(await checkAndRecordLeaveApplyRate(env, memberNumber))) {
      return json({ error: "너무 자주 요청했습니다. 잠시 뒤 다시 시도해주세요." }, 429, origin);
    }

    const colLetter = String.fromCharCode("A".charCodeAt(0) + col);

    const cellRows = await getSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, `${memberNumber}!${colLetter}${config.useRow + 1}`).catch(() => []);
    const prevCount = parseLeaveCount((cellRows[0] && cellRows[0][0]) || "");

    if (count > prevCount) {
      const leftRows = await getSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, `${memberNumber}!C${config.leftRow + 1}`).catch(() => []);
      const left = safeNumber((leftRows[0] && leftRows[0][0]) || 0);
      if (count - prevCount > left) return json({ error: `${config.label} 잔여량이 없습니다.` }, 400, origin);
    }

    // 0일 때는 셀을 완전히 비운다 — 시트 서식이 0도 "반휴 X 0"처럼 표시해
    // 신청 이력처럼 보이는 것을 방지하기 위함.
    await writeSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, [
      { range: `${memberNumber}!${colLetter}${config.useRow + 1}`, values: [[count > 0 ? count : ""]] },
    ]);

    return json({ ok: true, applied: count > 0, count }, 200, origin);
  } catch (err) {
    return json({ error: `${config.label} 신청 실패: ` + err.message }, 500, origin);
  }
}

// 🔧 [관리자 대리 신청, 2026-09-10] "대시보드에서 오늘이 아닌 과거 일자의
// 반일 휴무 신청은 블락하되, 관리자가 다른 회원의 대시보드를 띄웠을 때는
// 예외로 허용" — 실수로 신청을 놓친 회원을 관리자가 대신 등록해줄 수
// 있어야 한다는 요구사항(사용자 지시). handleSetLeaveApply/
// handleAdminLeaveProofDecide는 둘 다 "세션 본인"(memberNumber를
// resolveMemberNumber로 찾음) 또는 "이미 접수된 증빙 큐 항목"만 다뤄서,
// "관리자가 임의 회원의 임의 요일에 즉시 반영"하는 경로가 없었다.
// type(normal/reason) 공용 — 일반반휴는 handleSetLeaveApply와 동일하게
// 셀에 count를 직접 쓰고, 사유반휴는 handleAdminLeaveProofDecide의 승인
// 로직(증빙 없이 관리자 직권으로 이미 확정된 값을 쓰는 것과 동일한 셈)을
// 그대로 재사용해 즉시 반영한다 — 증빙 대기열(leaveq:)을 거치지 않는다.
// 요일 제한이 전혀 없다 — 관리자 전용이라 과거 요일도 항상 허용한다.
async function handleAdminLeaveApply(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { type, number, day, count: rawCount } = await req.json().catch(() => ({}));
  const config = LEAVE_TYPE_CONFIG[type];
  const col = statusColForDay(day);
  const sheetNum = parseInt(number, 10);
  const maxCount = LEAVE_MAX_COUNT_BY_TYPE[type] || 1;
  const count = typeof rawCount === "number" ? rawCount : NaN;
  if (
    !config ||
    col === null ||
    !sheetNum ||
    sheetNum < 1 ||
    sheetNum > 15 ||
    !Number.isInteger(count) ||
    count < 0 ||
    count > maxCount
  ) {
    return json({ error: "잘못된 요청입니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const memberNumber = String(sheetNum);
    const colLetter = String.fromCharCode("A".charCodeAt(0) + col);

    const cellRows = await getSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, `${memberNumber}!${colLetter}${config.useRow + 1}`).catch(() => []);
    const prevCount = parseLeaveCount((cellRows[0] && cellRows[0][0]) || "");

    if (count > prevCount) {
      const leftRows = await getSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, `${memberNumber}!C${config.leftRow + 1}`).catch(() => []);
      const left = safeNumber((leftRows[0] && leftRows[0][0]) || 0);
      if (count - prevCount > left) return json({ error: `${config.label} 잔여량이 없습니다.` }, 400, origin);
    }

    await writeSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, [
      { range: `${memberNumber}!${colLetter}${config.useRow + 1}`, values: [[count > 0 ? count : ""]] },
    ]);

    // 사유반휴는 정식 승인 흐름(handleAdminLeaveProofDecide)과 동일하게
    // 처리 이력을 남긴다 — "지난 사이클 조회" 화면이 이 로그로 그 주의
    // 사유반휴 처리 내역을 보여주므로, 관리자 대리 신청도 빠지면 안 된다.
    if (type === "reason" && count > prevCount) {
      await _appendLeaveHistory(env, {
        id: `admin-apply-${Date.now()}`,
        decision: "approved",
        memberNumber,
        memberName: null,
        day,
        reason: "관리자 대리 신청",
        rejectReason: null,
        decidedAt: Date.now(),
      }).catch(() => {});
    }

    return json({ ok: true, number: memberNumber, applied: count > 0, count }, 200, origin);
  } catch (err) {
    return json({ error: `${config.label} 대리 신청 실패: ` + err.message }, 500, origin);
  }
}

// --- 사유반휴 신청/승인 (증빙 이미지 업로드 → 봇 대기열 → 관리자 승인 시 시트 반영) ---
// 일반반휴는 handleSetLeaveApply처럼 즉시 시트에 반영되지만, 사유반휴는 진단서 등
// 실물 증빙이 필요해 관리자 확인 전까지는 시트를 건드리지 않는다. 대기 상태 자체는
// 도움봇(study_sw/bot/dashboard_server.py)의 runtime/leave_proof/manifest.json에
// append-only로 쌓이고, Worker는 그 목록을 그대로 프록시하거나(조회) 승인 시점에만
// LEAVE_TYPE_CONFIG.reason 경로로 시트에 값을 쓴다(handleSetLeaveApply와 동일 로직).

async function handleGetReasonLeaveProof(req, env, origin, url) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const day = url.searchParams.get("day");
  if (statusColForDay(day) === null) return json({ error: "잘못된 요청입니다." }, 400, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const memberNumber = await resolveMemberNumber(env, accessToken, session);

    // 봇 오프라인 대기열(leaveq:*)에 이 회원·요일 신청이 남아있으면 봇에
    // 도달하기도 전이지만 학생 화면에는 동일하게 "대기 중"으로 보여준다.
    const hasQueuedEntry = await hasQueuedReasonLeaveProof(env, memberNumber, day);
    if (hasQueuedEntry) return json({ pending: true, rejected: null }, 200, origin);

    const data = await proxyToBotDashboard(env, "/leave-proof?number=" + encodeURIComponent(memberNumber));
    const items = (data && data.items) || []; // 봇이 이미 ts 내림차순 정렬해 반환
    const latest = items.find((item) => item.day === day);

    if (!latest || latest.reviewStatus === "approved") {
      return json({ pending: false, rejected: null }, 200, origin);
    }
    if (latest.reviewStatus === "pending") {
      return json({ pending: true, rejected: null }, 200, origin);
    }
    return json({ pending: false, rejected: { reason: latest.rejectReason || "" } }, 200, origin);
  } catch (err) {
    return json({ error: "사유반휴 신청 조회 실패: " + err.message }, 500, origin);
  }
}

// 봇 오프라인 대기열(leaveq:*)에서 특정 회원의 신청 요일 목록을 모은다.
// hasQueuedReasonLeaveProof/buildPersonalStatus가 함께 재사용한다.
async function listQueuedReasonLeaveDays(env, memberNumber) {
  // 🔧 [list() 제거] 이 함수는 buildPersonalStatus를 거쳐 /status를 열 때마다
  // 호출되어(2026-08 실측: KV list() 하루 한도 1,000회 소진의 주된 원인으로
  // 확인됨) list() 대신 인덱스를 읽는다.
  const items = await _readLeaveQueueIndex(env);
  return items.filter((it) => it.memberNumber === memberNumber).map((it) => it.day);
}

async function hasQueuedReasonLeaveProof(env, memberNumber, day) {
  const days = await listQueuedReasonLeaveDays(env, memberNumber);
  return days.includes(day);
}

// base64는 원본 대비 약 1.37배로 길어진다 — 5MB * 1.37 ≈ 6.85MB 문자열 길이를
// 넘으면 봇까지 프록시하지 않고 바로 거절한다(정확한 검증은 봇이 디코드 후 재검증).
const LEAVE_PROOF_MAX_BASE64_LENGTH = 7_000_000;

async function handleSetReasonLeaveProof(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const { day, reason, imageBase64, imageExt, count: rawCount } = await req.json().catch(() => ({}));
  // count: 같은 증빙으로 이 요일에 한 번에 신청할 장수(1 또는 2, 미지정 시 1).
  const count = rawCount === undefined ? 1 : rawCount;
  const col = statusColForDay(day);
  if (
    col === null ||
    !reason ||
    !imageBase64 ||
    (imageExt !== "jpg" && imageExt !== "png") ||
    (count !== 1 && count !== 2)
  ) {
    return json({ error: "잘못된 요청입니다." }, 400, origin);
  }
  if (imageBase64.length > LEAVE_PROOF_MAX_BASE64_LENGTH) {
    return json({ error: "이미지 용량이 너무 큽니다. 5MB 이하로 첨부해주세요." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    let memberNumber = session.memberNumber;
    let memberName = session.memberName;
    if (!memberNumber) {
      const member = await findMemberNumberByEmail(env, accessToken, env.GOOGLE_SHEET_FILE_ID, session.email);
      if (!member) return json({ error: "데이터 시트 명단에서 계정을 찾을 수 없습니다." }, 403, origin);
      memberNumber = member.number;
      memberName = member.name;
    }

    const leftRows = await getSheetValues(
      env,
      accessToken,
      env.GOOGLE_SHEET_FILE_ID,
      `${memberNumber}!C${ROW_REASON_LEAVE_LEFT + 1}`
    ).catch(() => []);
    const left = safeNumber((leftRows[0] && leftRows[0][0]) || 0);
    if (left < count) return json({ error: "사유반휴 잔여량이 없습니다." }, 400, origin);

    // 🔧 [2차 점검, 2026-09-11] 이 `left` 검증은 시트의 잔여량만 볼 뿐, 이미
    // 큐/봇에 쌓인 같은 회원+같은 요일의 pending 신청 개수는 전혀 감안하지
    // 않았다 — 같은 학생이 두 기기(휴대폰+PC)에서 거의 동시에 신청하면 둘
    // 다 같은 left 스냅샷을 보고 통과해 중복 pending이 쌓일 수 있었다.
    // §36 락(승인 단계)은 "동시 읽기로 인한 계산 오류"만 막을 뿐, 애초에
    // "같은 요일 중복 신청"을 막는 검사가 신청 단계 자체에 없었던 건 락만
    // 추가해도 고쳐지지 않는 별개의 로직 결함이었다 — 두 요청이 순서대로
    // 처리돼도 "기존 pending 없음"을 똑같이 확인하고 각자 추가하기 때문.
    // handleGetReasonLeaveProof가 이미 쓰는 것과 동일한 두 경로(봇에 이미
    // 전달된 pending, KV 큐에 대기 중인 pending)를 모두 확인해 기존 신청이
    // 있으면 거절한다. 봇 조회(proxyToBotDashboard, 최대 8초)는
    // LOCK_WAIT_TIMEOUT_MS(15초) 여유가 빠듯해지므로 락 밖에서 먼저
    // 확인하고, "KV 큐 확인 + 큐 등록"만 §36과 동일한 `leave:${memberNumber}`
    // 락으로 원자적으로 묶어 두 기기의 요청이 순차 처리되게 한다.
    const existingBotStatus = await proxyToBotDashboard(
      env,
      "/leave-proof?number=" + encodeURIComponent(memberNumber)
    ).catch(() => null);
    const existingBotPending = ((existingBotStatus && existingBotStatus.items) || []).some(
      (item) => item.day === day && item.reviewStatus === "pending"
    );
    if (existingBotPending) {
      return json({ error: "이미 처리 대기 중인 신청이 있습니다." }, 409, origin);
    }

    const entry = {
      memberNumber,
      memberName,
      day,
      reason,
      requesterEmail: session.email,
      imageBase64,
      imageExt,
      count,
    };

    const lockResult = await withMemberLock(env, `leave:${memberNumber}`, async () => {
      if (await hasQueuedReasonLeaveProof(env, memberNumber, day)) {
        return { failure: true };
      }

      const data = await proxyToBotDashboard(env, "/leave-proof/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });
      if (data) return { data };

      // 🔧 [봇 오프라인 대기열] 봇이 꺼져 있으면 신청 자체를 실패시키지 않고
      // KV에 임시 보관했다가, 봇이 다시 켜져 handleBotRegisterUrl을 호출하는
      // 시점에 자동으로 흘려보낸다(flushQueuedReasonLeaveProofs). 학생 화면에는
      // 큐에 있든 봇에 이미 전달됐든 동일하게 "관리자 확인 중"으로 보인다
      // (handleGetReasonLeaveProof가 큐도 함께 조회).
      const queueId = crypto.randomUUID();
      const ts = Date.now();
      // 🔧 [KV → DO 이전, 2026-09-12] leaveq: KV put + 인덱스 갱신을
      // LeaveQueue DO 호출 한 번으로 대체(§47 참고).
      await getLeaveQueueStub(env).fetch("https://do/leaveq/put", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: queueId, entry: { ...entry, ts } }),
      });
      return { queueId };
    });
    if (lockResult.failure) {
      return json({ error: "이미 처리 대기 중인 신청이 있습니다." }, 409, origin);
    }
    if (lockResult.data) return json(lockResult.data, 200, origin);
    return json({ ok: true, id: lockResult.queueId, queued: true }, 200, origin);
  } catch (err) {
    return json({ error: "사유반휴 신청 실패: " + err.message }, 500, origin);
  }
}

// 학생 본인이 대기 중(pending)인 사유반휴 신청을 스스로 철회한다. 큐(KV)에
// 있으면 그냥 삭제하고, 이미 봇에 넘어간 pending 항목이면 관리자용
// "반려"와 동일한 경로(/leave-proof/decide)로 처리해 manifest 상태만
// rejected로 바꾼다(시트는 애초에 건드리지 않은 상태이므로 손댈 것이 없다).
async function handleCancelReasonLeaveProof(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const { day } = await req.json().catch(() => ({}));
  if (statusColForDay(day) === null) return json({ error: "잘못된 요청입니다." }, 400, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const memberNumber = await resolveMemberNumber(env, accessToken, session);

    // 🔧 [KV → DO 이전, 2026-09-12] list() 대신 DO에서 찾는다.
    const queued = await _readLeaveQueueIndex(env);
    const match = queued.find((it) => it.memberNumber === memberNumber && it.day === day);
    if (match) {
      await getLeaveQueueStub(env).fetch("https://do/leaveq/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: match.id }),
      });
      return json({ ok: true }, 200, origin);
    }

    const data = await proxyToBotDashboard(env, "/leave-proof?number=" + encodeURIComponent(memberNumber));
    const items = (data && data.items) || [];
    const pending = items.find((item) => item.day === day && item.reviewStatus === "pending");
    if (!pending) return json({ error: "철회할 신청이 없습니다." }, 400, origin);

    const decideData = await proxyToBotDashboard(env, "/leave-proof/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: pending.id, decision: "rejected", rejectReason: "본인 철회" }),
    });
    if (!decideData) return json({ error: "봇에 연결할 수 없습니다." }, 502, origin);
    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "사유반휴 철회 실패: " + err.message }, 500, origin);
  }
}

// 🔧 [봇 오프라인 대기열 배출] 봇이 재기동해 자기 URL을 등록하는 순간(=이제
// 도달 가능해진 순간) 대기열에 쌓인 leaveq 항목을 순서대로 봇에 전달한다.
// 개별 항목 실패는 조용히 건너뛰고(다음 등록 시점에 재시도되도록 큐에 남김)
// 전체 흐름을 막지 않는다 — register-url 응답 자체가 늦어지면 봇 기동에
// 영향을 줄 수 있으므로 항목당 처리도 짧게 유지한다.
// 🔧 [KV → DO 이전, 2026-09-12] 예전엔 "인덱스가 실제 KV와 어긋나도
// 직접 list()로 훑는 안전망" 역할이었는데, LeaveQueue DO의 Map은 정의상
// storage와 항상 동일한 단일 진실 소스라 그 어긋남 자체가 구조적으로
// 발생할 수 없다 — /leaveq/list-full이 곧 유일한 데이터 소스이자
// "인덱스"이므로 안전망이 무의미해지는 게 아니라 그 안전망이 막던 버그
// 클래스가 원천 제거된 것이다(§47).
async function flushQueuedReasonLeaveProofs(env) {
  const stub = getLeaveQueueStub(env);
  const res = await stub.fetch("https://do/leaveq/list-full");
  const { items } = await res.json();
  for (const { id: queueId, ...entry } of items || []) {
    try {
      // 큐의 원래 id를 그대로 봇에 전달한다 — 그러지 않으면 봇이 새 id로
      // 레코드를 만들어, 관리자가 이미 이 큐 id 기준으로 승인/반려하고
      // 큐를 지운 뒤에도 봇 쪽엔 처리되지 않은 유령 pending이 남는다
      // (레이스: flush와 handleAdminLeaveProofDecide가 동시에 이 항목을
      // 다룰 때). 봇이 같은 id를 그대로 채택하므로 이후 처리 여부가 항상
      // 하나의 레코드로 합쳐진다.
      const data = await proxyToBotDashboard(env, "/leave-proof/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...entry, id: queueId }),
      });
      if (data) {
        await stub.fetch("https://do/leaveq/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: queueId }),
        });
      }
    } catch {
      // 파싱 실패 등 복구 불가능한 항목은 다음에도 계속 실패할 것이므로 지운다.
      await stub.fetch("https://do/leaveq/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: queueId }),
      });
    }
  }
}

// KV 큐(leaveq:*) 항목을 관리자 목록 아이템 형태로 변환한다. queueId를
// id로 그대로 쓰고 queued:true를 붙여, 목록/승인/반려 핸들러가 "봇 없이
// 큐에만 있는 신청"을 구분해 처리할 수 있게 한다.
async function listQueuedReasonLeaveItems(env) {
  const queued = await _readLeaveQueueIndex(env);
  return queued.map((it) => ({
    id: it.id,
    memberNumber: it.memberNumber,
    memberName: it.memberName,
    day: it.day,
    reason: it.reason,
    requesterEmail: it.requesterEmail,
    count: it.count || 1,
    ts: it.ts || 0,
    reviewStatus: "pending",
    rejectReason: null,
    queued: true,
  }));
}

async function handleAdminLeaveProofList(req, env, origin, url) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  // 🔧 [PEN·MONEY 사이클 토글] cycle 쿼리 파라미터가 있으면 그 주(월~일,
  // KST)의 처리 이력(_appendLeaveHistory가 쌓은 leaveHistory:{weekOf})을
  // 대신 보여준다 — 대기 큐/봇 목록과 달리 이건 이미 처리 완료된 읽기
  // 전용 기록이라 승인/반려 액션 없이 결과만 노출한다. 다른 사이클 지원
  // 핸들러(handleAdminFinesUnpaid 등)와 동일하게 resolveTargetFileId 실패
  // (사이클 범위를 벗어난 fileId 등)를 try/catch로 감싸 의미 있는 에러로 응답한다.
  const cycleFileId = url ? url.searchParams.get("cycle") : null;
  if (cycleFileId) {
    try {
      const accessToken = await getServiceAccountAccessToken(env);
      const { weekOf } = await resolveTargetFileId(env, accessToken, cycleFileId);
      const history = weekOf ? await _readLeaveHistory(env, weekOf) : [];
      const items = history
        .map((h) => ({
          id: h.id,
          memberNumber: h.memberNumber,
          memberName: h.memberName,
          day: h.day,
          reason: h.reason,
          requesterEmail: null,
          count: h.count || 1,
          ts: h.decidedAt,
          reviewStatus: h.decision,
          rejectReason: h.rejectReason || null,
          queued: false,
        }))
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
      return json({ items, readOnly: true }, 200, origin);
    } catch (err) {
      return json({ error: "사유반휴 처리 이력 조회 실패: " + err.message }, 500, origin);
    }
  }

  // 봇이 꺼져 있어도 관리자가 대기 중인 신청을 놓치지 않도록, 봇 목록과
  // KV 큐(아직 봇에 도달하지 못한 신청)를 합쳐서 보여준다. 봇이 응답하지
  // 않으면 빈 배열로 취급하고 큐만이라도 반환한다(봇 완전 다운 시에도
  // 관리자가 큐 항목을 승인/반려할 수 있어야 하므로).
  const [botData, queuedItems] = await Promise.all([
    proxyToBotDashboard(env, "/leave-proof?status=pending"),
    listQueuedReasonLeaveItems(env),
  ]);
  const botItems = (botData && botData.items) || [];
  const items = [...queuedItems, ...botItems].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return json({ items, readOnly: false }, 200, origin);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function handleAdminLeaveProofFile(req, env, origin, url) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const id = url.searchParams.get("id") || "";
  if (!id) return json({ error: "id가 필요합니다." }, 400, origin);

  // 큐(DO)에만 있는 신청이면 봇을 거치지 않고 저장된 base64를 그대로
  // 서빙한다 — 봇이 꺼져 있어도 증빙 미리보기가 가능해야 한다.
  const queuedRes = await getLeaveQueueStub(env).fetch(`https://do/leaveq/get?id=${encodeURIComponent(id)}`);
  if (queuedRes.ok) {
    try {
      const { entry } = await queuedRes.json();
      const contentType = entry.imageExt === "png" ? "image/png" : "image/jpeg";
      return new Response(base64ToBytes(entry.imageBase64), {
        status: 200,
        headers: { "Content-Type": contentType, ...corsHeaders(origin) },
      });
    } catch {
      return json({ error: "증빙 이미지를 읽지 못했습니다." }, 500, origin);
    }
  }

  const res = await proxyToBotDashboardRaw(env, "/leave-proof/file?id=" + encodeURIComponent(id));
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

async function handleAdminLeaveProofDecide(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const {
    id,
    decision,
    memberNumber,
    day,
    rejectReason,
    count: rawCount,
    memberName,
    reason,
  } = await req.json().catch(() => ({}));
  // count: 이 증빙으로 승인 시 반영할 장수(1 또는 2) — 신청 시점에 학생이
  // 고른 값을 목록 아이템(item.count)에서 그대로 넘겨받는다. 미지정 시 1.
  const count = rawCount === undefined ? 1 : rawCount;
  // memberName/reason: 목록 화면이 이미 갖고 있는 표시용 정보를 그대로
  // 넘겨받아 처리 이력 로그(_appendLeaveHistory)에 함께 남긴다 — 권한
  // 판정에는 쓰이지 않는 순수 표시값이라 클라이언트 제공값을 신뢰해도 된다.
  const col = statusColForDay(day);
  if (
    !id ||
    (decision !== "approved" && decision !== "rejected") ||
    !memberNumber ||
    col === null ||
    (count !== 1 && count !== 2)
  ) {
    return json({ error: "잘못된 요청입니다." }, 400, origin);
  }
  if (decision === "rejected" && !rejectReason) {
    return json({ error: "반려 사유를 입력해주세요." }, 400, origin);
  }

  // 큐(DO)에만 있는 신청(봇이 아직 못 받은 것)인지 먼저 확인한다 — 이
  // 경우 봇 프록시를 시도하지 않고 시트 반영 + 큐 삭제로 끝낸다(봇이
  // 꺼져 있어도 관리자가 승인/반려를 완결할 수 있어야 한다).
  const leaveQueueStub = getLeaveQueueStub(env);
  const isQueued = (await leaveQueueStub.fetch(`https://do/leaveq/get?id=${encodeURIComponent(id)}`)).ok;

  try {
    const accessToken = await getServiceAccountAccessToken(env);

    if (decision === "rejected") {
      if (isQueued) {
        await leaveQueueStub.fetch("https://do/leaveq/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        // 큐 확인과 이 시점 사이에 flushQueuedReasonLeaveProofs가 끼어들어
        // 봇에도 같은 id로 레코드가 막 생겼을 수 있다 — 있으면 정리하고,
        // 없으면(대부분의 경우) 404로 조용히 무시된다. 결과와 무관하게
        // 이 요청 자체는 이미 완료된 것으로 응답한다.
        await proxyToBotDashboard(env, "/leave-proof/decide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, decision, rejectReason }),
        }).catch(() => null);
        // 🔧 로그 기록 실패가 이미 완료된 처리(큐 삭제)를 실패로 되돌리면
        // 안 되므로(관리자가 "실패"로 오해해 재시도하면 중복 처리 위험)
        // 별도로 감싸 조용히 무시한다 — 이력 한 건이 안 쌓이는 것보다
        // 처리 자체가 실패로 보이는 게 훨씬 나쁘다.
        await _appendLeaveHistory(env, {
          id,
          decision,
          memberNumber,
          memberName: memberName || null,
          day,
          reason: reason || null,
          rejectReason,
          decidedAt: Date.now(),
        }).catch(() => null);
        return json({ ok: true }, 200, origin);
      }
      // 시트에는 아무것도 쓰지 않는다 — 반려된 신청은 처음부터 없었던 것과 같다.
      const data = await proxyToBotDashboard(env, "/leave-proof/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, decision, rejectReason }),
      });
      if (!data) return json({ error: "봇에 연결할 수 없습니다." }, 502, origin);
      await _appendLeaveHistory(env, {
        id,
        decision,
        memberNumber,
        memberName: memberName || null,
        day,
        reason: reason || null,
        rejectReason,
        decidedAt: Date.now(),
      }).catch(() => null);
      return json(data, 200, origin);
    }

    // 승인 — handleSetLeaveApply(count 지정)와 동일한 시트 반영 로직을 재사용한다.
    const colLetter = String.fromCharCode("A".charCodeAt(0) + col);
    // 🔧 [2차 점검, 2026-09-11] "같은 회원+같은 요일" 중복 pending 신청을
    // 막는 검사가 어디에도 없어(신청 시점도, 봇 큐도), 학생이 같은 요일에
    // 두 번 신청하면 별개 항목 2건이 관리자 목록에 그대로 쌓인다. 관리자
    // 두 명이 그 두 건을 거의 동시에 승인하면 이 "읽기(prevCount/left)→
    // 계산→쓰기"가 락 없는 read-modify-write라 나중 쓰기가 먼저 반영을
    // 덮어써 사용량 한 건이 조용히 소실되고, left 검증도 낡은 스냅샷
    // 기준이라 실제 잔여보다 초과 승인될 수 있었다(경쟁 조건 재검증 완료).
    // left(C41, 잔여량)는 요일과 무관하게 회원 전체가 공유하는 값이라,
    // 같은 회원의 다른 요일 승인과도 경쟁할 수 있어 락 범위를 요일이 아닌
    // 회원 단위(`leave:${memberNumber}`)로 잡는다 — 읽기·검증·쓰기 세
    // 단계 전부를 락 안에 넣어야 안전하므로, 그 뒤에 이어지는 큐 삭제·봇
    // 동기화·이력 기록(카운트 셀과 무관)은 락 밖에 그대로 둔다.
    const lockResult = await withMemberLock(env, `leave:${memberNumber}`, async () => {
      const [cellRows, leftRows] = await Promise.all([
        getSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, `${memberNumber}!${colLetter}${ROW_REASON_LEAVE_USE + 1}`).catch(() => []),
        getSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, `${memberNumber}!C${ROW_REASON_LEAVE_LEFT + 1}`).catch(() => []),
      ]);
      const prevCount = parseLeaveCount((cellRows[0] && cellRows[0][0]) || "");
      const left = safeNumber((leftRows[0] && leftRows[0][0]) || 0);
      const nextCount = Math.min(MAX_LEAVES_PER_DAY_LIMIT, prevCount + count);
      if (nextCount - prevCount > left) return { failure: true };

      await writeSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, [
        { range: `${memberNumber}!${colLetter}${ROW_REASON_LEAVE_USE + 1}`, values: [[nextCount]] },
      ]);
      return { failure: false };
    });
    if (lockResult.failure) return json({ error: "사유반휴 잔여량이 없습니다." }, 400, origin);

    if (isQueued) {
      // 봇을 거치지 않고 처리했으므로 큐에서 지우면 끝나지만, 큐 확인과
      // 이 시점 사이에 flushQueuedReasonLeaveProofs가 끼어들어 봇에도 같은
      // id로 pending 레코드가 막 생겼을 수 있다(레이스) — 있으면 approved로
      // 정리하고, 없으면 404로 조용히 무시된다. 이걸 빼먹으면 시트엔 이미
      // 반영됐는데 관리자 화면엔 처리 못하는 유령 pending이 남는다.
      await leaveQueueStub.fetch("https://do/leaveq/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await proxyToBotDashboard(env, "/leave-proof/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, decision: "approved" }),
      }).catch(() => null);
      await _appendLeaveHistory(env, {
        id,
        decision: "approved",
        memberNumber,
        memberName: memberName || null,
        day,
        reason: reason || null,
        rejectReason: null,
        decidedAt: Date.now(),
      }).catch(() => null);
      return json({ ok: true }, 200, origin);
    }

    // 시트 반영이 성공한 뒤에만 봇 manifest 상태를 갱신한다 — 순서를 바꾸면
    // "승인됐다고 표시되는데 시트엔 반영 안 된" 불일치가 생길 수 있다.
    const data = await proxyToBotDashboard(env, "/leave-proof/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision: "approved" }),
    });
    await _appendLeaveHistory(env, {
      id,
      decision: "approved",
      memberNumber,
      memberName: memberName || null,
      day,
      reason: reason || null,
      rejectReason: null,
      decidedAt: Date.now(),
    }).catch(() => null);
    if (!data) {
      return json({ ok: true, botSyncFailed: true }, 200, origin);
    }
    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "사유반휴 승인 처리 실패: " + err.message }, 500, origin);
  }
}

async function handleGetGoalSchedule(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    let memberNumber = session.memberNumber;
    if (!memberNumber) {
      const member = await findMemberNumberByEmail(env, accessToken, env.GOOGLE_SHEET_FILE_ID, session.email);
      if (!member) return json({ error: "데이터 시트 명단에서 계정을 찾을 수 없습니다." }, 403, origin);
      memberNumber = member.number;
    }

    const row = Number(memberNumber) + 4;
    // 셀이 완전히 비어 있으면 Sheets API가 values 자체를 생략해 예외가 나므로,
    // "아직 아무도 예약하지 않음"을 정상 상태로 처리하기 위해 개별적으로 방어한다.
    let raw = "";
    try {
      const rows = await getSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, `집계!L${row}`);
      raw = (rows[0] && rows[0][0]) || "";
    } catch {
      raw = "";
    }
    const scheduled = GOAL_TIME_VALID_VALUES.includes(raw) ? raw : null;

    return json({ scheduled, validValues: GOAL_TIME_VALID_VALUES }, 200, origin);
  } catch (err) {
    return json({ error: "예약 조회 실패: " + err.message }, 500, origin);
  }
}

async function handleSetGoalSchedule(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const { goalType } = await req.json();
  if (!GOAL_TIME_VALID_VALUES.includes(goalType)) {
    return json({ error: "올바른 목표시간 값이 아닙니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    let memberNumber = session.memberNumber;
    if (!memberNumber) {
      const member = await findMemberNumberByEmail(env, accessToken, env.GOOGLE_SHEET_FILE_ID, session.email);
      if (!member) return json({ error: "데이터 시트 명단에서 계정을 찾을 수 없습니다." }, 403, origin);
      memberNumber = member.number;
    }

    const row = Number(memberNumber) + 4;
    await writeSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, [
      { range: `집계!L${row}`, values: [[goalType]] },
    ]);

    return json({ ok: true, scheduled: goalType }, 200, origin);
  } catch (err) {
    return json({ error: "예약 저장 실패: " + err.message }, 500, origin);
  }
}

// --- 전체 대시보드('집계' 시트 요약) ---
// 로그인한 사람이면 누구나 볼 수 있다 — 이름/순위/타이머/총 상점을 노출한다
// (상태는 더 이상 프론트에서 쓰지 않지만 응답에는 계속 포함해 하위호환 유지).
//
// 🔧 [캐싱 추가, 2026-09-10] 캐시 없이 매 요청마다 Sheets API를 4번씩(집계
// 본문/집계 D20:D24+P6/데이터 F4:M4/집계 D25) 직접 호출하고 있었다 — 로그인한
// 회원 15명 전원이 같은 파일의 같은 스냅샷을 보는 공용 데이터인데도 캐시가
// 하나도 없어, RANK 탭이 열릴 때마다 그대로 쿼터를 소진했다(사용자 지적).
// reportScore와 동일한 원칙(파일당 1개 키 — "표시만 지연될 뿐 정합성엔
// 무해"하다고 이미 확인된 것과 같은 성격의 데이터)으로 파일당 하나의 키에
// 캐싱한다. 무효화는 "roster" 그룹(신규등록/퇴실 등 명단 자체가 바뀌는
// 저빈도 이벤트)에 자동 포함되고, "상금 정산 집행" 마킹은 별도로 좁은
// "rosterOnly" 그룹을 즉시 호출한다(handleAdminPrizeSettle 참고).
// 🔧 [TTL 하향, 2026-09-11] RANK 탭 폴링(30분)과 TTL이 30분으로 같아
// "폴링:TTL = 1:1"이 되어 매 폴링마다 캐시가 이미 만료돼 있어 재계산되는
// 문제가 있었다(§12.1의 "폴링은 TTL의 3배 이상" 원칙 미달). 10분으로
// 낮춰 3:1을 맞춘다 — 회원 수와 무관한 파일당 1개 키라 TTL을 낮춰도 KV
// 쓰기 증가는 미미하다(최악 하루 30분→10분 기준 KV put 48회→144회
// 수준이지만, 실제로는 대부분 인메모리/다른 isolate의 캐시로 흡수됨).
// 🔧 [중복 캐시 통합, 2026-09-10] MY 탭의 getMeritRank가 별도로 쓰던
// meritRank:{fileId} 캐시(집계!B4:F18)는 이 members 배열의 부분집합이라
// (사용자 지적: "MY랑 RANK 둘이 같이 가져오는 걸로 해도 되지 않나?"),
// getMeritRank가 이 함수를 그대로 재사용하도록 통합했다 — meritRank: 키는
// 폐지됐다.
//
// 🔧 [과거 fileId TTL 상향, 2026-09-10] "과거 주차를 여러 번 토글해도
// 10~30분마다 재계산·KV 재기입이 반복되는 게 낭비 아니냐"는 지적 —
// 과거(백업) fileId는 관리자가 이 Worker의 API로 처리하지 않는 한 원본이
// 절대 바뀌지 않는다. 벌금 납부(handleAdminFineStatus)·상금 정산 집행
// (handleAdminPrizeSettle)·퇴실 확정(handleAdminExitConfirm)이 과거
// fileId를 대상으로 쓰기를 하면 각각 invalidateMemberCache에 그 fileId를
// 정확히 넘겨 즉시 무효화하므로(사용자 확인: "관리자가 쓰기 작업을 해서
// 과거 시트 값이 갱신되면 캐시가 바로 무효화되는 게 맞다"), TTL을 2시간
// (현재 시트는 그대로 30분)으로 늘려도 낡은 값이 남는 문제는 생기지 않는다.
const ROSTER_ROW_START = 3; // 시트 4행(0-indexed 3)부터 15명
const ROSTER_ROW_END = 17; // 시트 18행(0-indexed 17)까지

async function buildRosterStatus(env, accessToken, fileId) {
  const ttlMs = fileId === env.GOOGLE_SHEET_FILE_ID ? 10 * 60_000 : 2 * 60 * 60_000;
  return _cachedCompute(env, `rosterStatus:${fileId}`, ttlMs, () => _computeRosterStatus(env, accessToken, fileId));
}

async function _computeRosterStatus(env, accessToken, fileId) {
  const [rows, [moneyRows, prizeSettleRows], studyLeadSlotRows, cycleRows] = await Promise.all([
    getSheetValues(env, accessToken, fileId, "집계!A4:L18"),
    // D20:D24(총 모금액~퇴실예치)와 P6("상금 정산 집행" 마킹, handleAdminPrizeSettle
    // 참고)를 한 번의 batchGet으로 묶어 API 호출 횟수를 아낀다.
    batchGetSheetValues(env, accessToken, fileId, ["집계!D20:D24", "집계!P6"]).catch(() => [[], []]),
    // 스터디장(1번 회원, 데이터 시트 4행)의 송출P/주간P 슬롯 — 값이 현재
    // 페널티 사이클(D25)과 같으면 "이번 주간 발생"으로 친다(집계!D20 수식과
    // 동일한 판정 기준).
    getSheetValues(env, accessToken, fileId, "데이터!F4:M4").catch(() => []),
    // 🔧 [D25 서식 파싱 버그 수정] D25는 "1/3주차"처럼 커스텀 숫자 서식이
    // 입혀져 있어(getCurrentPenCycle 주석 참고) 기본 렌더링(FORMATTED_VALUE)
    // 으로 읽으면 텍스트로 온다 — 원래 getSheetValues로 읽어 studyLeadSlots
    // (순수 숫자 "1"/"2"/"3")와 문자열 비교했는데 형태가 달라 항상 false가
    // 되어, depositOuterIncluded가 조건과 무관하게 항상 꺼진 채로 일반
    // 회원에게 퇴실 예치금이 상시 숨겨지고 있었다. 서식 무시하고 원본
    // 숫자를 읽는 전용 함수로 교체.
    getSheetUnformattedValue(env, accessToken, fileId, "집계!D25").catch(() => []),
  ]);

  const members = [];
  for (let i = 0; i <= ROSTER_ROW_END - ROSTER_ROW_START; i++) {
    const row = rows[i] || [];
    const name = (row[2] || "").trim();
    const status = (row[10] || "").trim();
    if (!name || status === "빈 시트") continue;

    members.push({
      number: (row[1] || "").trim(),
      name,
      timer: (row[3] || "").trim(),
      merit: (row[4] || "").trim(),
      rank: (row[5] || "").trim(),
      status,
    });
  }

  // 집계 D20~D24: 총 모금액/이월 상금/주간 벌금/퇴실 벌금/퇴실 예치.
  const collectMoney = parseWon((moneyRows[0] && moneyRows[0][0]) || "");
  const fineCarry = parseWon((moneyRows[1] && moneyRows[1][0]) || "");
  const fineThisWeek = parseWon((moneyRows[2] && moneyRows[2][0]) || "");
  const fineOuter = parseWon((moneyRows[3] && moneyRows[3][0]) || "");
  const depositOuter = parseWon((moneyRows[4] && moneyRows[4][0]) || "");

  const currentCycle = (cycleRows[0] && cycleRows[0][0] || "").toString().trim();
  const studyLeadSlots = studyLeadSlotRows[0] || [];
  const depositOuterIncluded =
    currentCycle !== "" && studyLeadSlots.some((v) => (v || "").toString().trim() === currentCycle);

  // "이번 주 정산": 총 모금액(D20)을 1~5등(메달 랭크)에게 1/n 균등 분배한다.
  // RosterView.tsx의 rankValue/MEDAL_RANK와 동일한 기준으로 1~4등은 이모지
  // (🥇🥈🥉🏅), 5등은 숫자 "5"로 온다 — 프론트와 판정 기준을 반드시 맞춰야
  // 화면에 보이는 랭킹과 정산 대상이 어긋나지 않는다.
  const MEDAL_RANK_VALUE = { "🥇": 1, "🥈": 2, "🥉": 3, "🏅": 4 };
  function rankValueForSettlement(rank) {
    const trimmed = (rank || "").trim();
    if (!trimmed || trimmed === "-") return null;
    if (trimmed in MEDAL_RANK_VALUE) return MEDAL_RANK_VALUE[trimmed];
    const n = parseInt(trimmed, 10);
    return Number.isNaN(n) ? null : n;
  }
  const settlementMembers = members
    .map((m) => ({ number: m.number, name: m.name, rankValue: rankValueForSettlement(m.rank) }))
    .filter((m) => m.rankValue !== null && m.rankValue <= 5)
    .sort((a, b) => a.rankValue - b.rankValue);
  const settlementShare = settlementMembers.length > 0 ? Math.floor(collectMoney / settlementMembers.length) : 0;
  const settlement = settlementMembers.map((m) => ({ number: m.number, name: m.name, rank: m.rankValue, amount: settlementShare }));
  // 🔧 2026-09: "정산 내역"을 관리자가 실제로 집행(핸드폰으로 송금 등)했는지는
  // handleAdminPrizeSettle이 쓰는 집계!P6("완료" 문자열) 하나로만 판정한다
  // (사용자 지시) — 이 값을 응답에 그대로 반영해, 프론트가 "정산 대상은
  // 계산됐지만 아직 집행 전"과 "이미 집행 완료"를 구분해 표시할 수 있게 한다.
  const settlementSettled = ((prizeSettleRows[0] && prizeSettleRows[0][0]) || "").toString().trim() === "완료";

  return {
    members,
    collectMoney,
    fineCarry,
    fineThisWeek,
    fineOuter,
    depositOuter,
    depositOuterIncluded,
    settlement,
    settlementSettled,
  };
}

// KST(UTC+9) 기준 "이번 주 정산" 공개 시각 — 일요일 14교시 종료(23:30)
// 이후부터 스터디원도 볼 수 있다. 스터디장(1번 회원)은 항상 볼 수 있다.
function isSettlementVisibleToMembers() {
  const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const day = kstNow.getUTCDay(); // KST로 보정된 시각의 UTC getter를 그대로 쓴다.
  const hour = kstNow.getUTCHours();
  const minute = kstNow.getUTCMinutes();
  if (day !== 0) return false; // 0 = 일요일
  return hour > 23 || (hour === 23 && minute >= 30);
}

async function handleRosterStatus(req, env, origin, url) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const cycleFileId = url ? url.searchParams.get("cycle") : null;
    const { fileId: targetFileId, weekOf } = await resolveTargetFileId(env, accessToken, cycleFileId);
    // 🔧 [캐시 오염 방지, 2026-09-10] buildRosterStatus가 이제 30분 캐시를
    // 쓰면서 반환 객체가 여러 요청·isolate에 걸쳐 재사용될 수 있게 됐다 —
    // 아래에서 weekRange 병합·depositOuter/settlement 삭제로 이 객체를
    // 직접 변형(mutate)하면, 그 변형이 캐시된 원본에 그대로 남아 이후
    // 다른 요청(다른 회원, 다른 cycle 파라미터, 관리자 여부가 다른 요청)
    // 에까지 잘못 전파된다 — 예를 들어 정산 비공개 시각에 조회한 일반
    // 회원의 delete roster.settlement가 캐시 원본에 반영되면, 그 뒤 공개
    // 시각이 지나 조회한 관리자도 캐시 만료 전까지 정산 정보를 못 보게
    // 된다. 얕은 복사본에만 이후 변형을 적용한다.
    const cached = await buildRosterStatus(env, accessToken, targetFileId);
    const roster = { ...cached };
    // 🔧 2026-09: RosterPage("랭킹"/"상금 정산" 타이틀)가 "YYMMDD-YYMMDD
    // 주간"을 병기할 수 있도록 이 조회가 보여주는 주(월~일)의 시작/종료일을
    // 함께 내려준다(사용자 지시).
    const weekRange = currentWeekRangeYYMMDD(weekOf);
    if (weekRange) Object.assign(roster, weekRange);
    // 퇴실 예치(D24)가 총 모금액에 포함되지 않는 주간에는, 관리자가 아닌
    // 일반 참여자에게는 이 항목 자체를 숨긴다(스터디장 개인 페널티 여부를
    // 노출하지 않기 위함) — 값을 응답에서 아예 빼서 프론트가 있는지
    // 여부로 노출 판단을 하게 한다.
    const isAdmin = session.email === (env.ADMIN_EMAIL || "").toLowerCase();
    if (!roster.depositOuterIncluded && !isAdmin) {
      delete roster.depositOuter;
    }

    // "이번 주 정산" 노출 시각 제한은 실시간 조회(=현재 진행 중인 주)에만
    // 적용한다 — 이미 백업된 과거 주차(cycleFileId 지정)는 그 주가 이미
    // 끝났으므로 스포일러 문제가 없어 항상 공개한다. 실시간일 때는
    // 스터디장(1번 회원)·관리자에게는 즉시 보이지만(관리자는 Money 탭
    // "상금 수령 대상자 처리"에서 상시 확인해야 하므로 2026-09에 추가),
    // 그 외 스터디원은 일요일 14교시 종료(23:30 KST) 전까지는 볼 수
    // 없다 — 정산이 확정되기 전 순위를 미리 알면 남은 시간 동안의 경쟁
    // 동기가 흐려지므로.
    const isRealtime = targetFileId === env.GOOGLE_SHEET_FILE_ID;
    if (isRealtime && !isAdmin) {
      let memberNumber = null;
      try {
        memberNumber = await resolveMemberNumber(env, accessToken, session);
      } catch {
        // 회원 매칭 실패는 정산 비공개로만 처리하고 전체 요청을 막지 않는다.
      }
      const isStudyLead = memberNumber === "1";
      if (!isStudyLead && !isSettlementVisibleToMembers()) {
        delete roster.settlement;
      }
    }

    return json(roster, 200, origin);
  } catch (err) {
    return json({ error: "전체 대시보드 조회 실패: " + err.message }, 500, origin);
  }
}

// --- 관리자 전용: 특정 회원의 개인 대시보드 조회 ---
// 회원 드롭다운(이름 목록)과, 선택한 회원의 요일별 벌금·학습시간 상세를 제공한다.

// 🔧 [과거 주차 회원 전환 지원] cycle 쿼리(백업 fileId)가 주어지면 그 주차의
// 백업 시트에서 회원 목록을 읽는다 — 이전엔 항상 현재(라이브) 시트만 봐서,
// 관리자가 과거 사이클을 조회할 때 "다른 회원 보기" 드롭다운 자체를 아예
// 숨겼었다. /status, /roster-status가 이미 쓰는 resolveTargetFileId와
// 동일한 검증(그 fileId가 실제로 현재 사이클에 속하는지)을 거친다.
// 백업 탭 시트 이름 패턴 — 퇴실 시 performExitReset이 만드는 "{이름} (퇴실)"만
// 매칭한다("{이름} (재납 {타임스탬프})"는 재납이라 "다시 활동 중인 스터디원"으로
// 취급되므로(§performDepositAgainReset이 L3를 "스터디원"으로 되돌림) 이 조회
// 대상이 아니다 — 재납자는 이미 listAllMembers에 정상적으로 다시 나타난다).
const EXITED_BACKUP_SHEET_RE = /^(.+) \(퇴실\)$/;
// 프론트가 "다른 회원 보기" 드롭다운에서 퇴실자를 구분할 수 있도록 number에
// 붙이는 접두사 — 실제 회원번호(숫자)와 절대 겹치지 않는다.
const EXITED_MEMBER_PREFIX = "exited:";

// 원본 스프레드시트에 남아있는 퇴실자 백업 탭 목록을 "다른 회원 보기"
// 드롭다운용 항목으로 변환한다. 과거 사이클 백업 파일(cycleFileId가 가리키는
// 완전히 별도의 Drive 파일)에는 이 탭이 존재하지 않으므로, 호출부가 원본
// 조회(cycleFileId 없음)일 때만 이 함수를 부른다.
async function listExitedMemberEntries(env, accessToken, fileId) {
  const sheets = await getSpreadsheetMeta(env, accessToken, fileId);
  return sheets
    .map((s) => EXITED_BACKUP_SHEET_RE.exec(s.title))
    .filter(Boolean)
    .map((m) => ({ number: `${EXITED_MEMBER_PREFIX}${m[0]}`, name: m[0], email: "" }));
}

// 🔧 [드롭다운 전용 캐시, 2026-09-10] "다른 회원 보기" 드롭다운(/admin/members)
// 은 거의 바뀌지 않는 화면인데도 listAllMembers(제보 이름 매칭, 퇴실 후보
// 판정 등 20곳 이상이 공유하는 원본 캐시, TTL 10분)를 그대로 썼다 — 이
// 드롭다운만 2시간으로 늘리고 싶다는 요청에 listAllMembers의 TTL 자체를
// 올리면, 이름 매칭처럼 "무효화가 어쩌다 한 번 놓쳤을 때의 노출 시간"이
// 중요한 다른 20곳의 안전망까지 함께 12배로 늘어난다(사용자 확인 후
// 분리하기로 함). 그래서 listAllMembers는 건드리지 않고, 이 핸들러의
// 최종 응답(members+exitedMembers 조합) 자체를 별도 키
// (adminMemberList:{fileId})로 한 번 더 감싼다 — 원본이 10분 만에
// 무효화돼도 이 바깥 캐시는 2시간 동안 그 스냅샷을 그대로 돌려주므로,
// listAllMembers 쪽 정확성 요구사항과는 완전히 분리된다. invalidateMemberCache
// 의 roster 그룹에 이미 이 prefix를 추가해뒀으므로(§MEMBER_CACHE_UNCONDITIONAL_KEYS),
// 신규등록/퇴실이 발생하면 2시간을 기다리지 않고 즉시 무효화된다 — 드롭다운을
// 열 때(onOpenChange)마다 재조회하는 프론트 로직과 합쳐지면 "평소엔 캐시로
// 아끼고, 실제로 바뀌면 다음 클릭에 바로 최신값"이 된다.
async function handleAdminMembers(req, env, origin, url) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const cycleFileId = url ? url.searchParams.get("cycle") : null;
    const { fileId: targetFileId } = await resolveTargetFileId(env, accessToken, cycleFileId);
    // 현재/과거 fileId 구분 없이 2시간 — 드롭다운은 실시간성이 필요 없고,
    // 신규등록·퇴실 발생 시 즉시 무효화되므로(아래 주석) 굳이 나눌 이유가 없다.
    const responseMembers = await _cachedCompute(env, `adminMemberList:${targetFileId}`, 2 * 60 * 60_000, async () => {
      const [members, exitedMembers] = await Promise.all([
        listAllMembers(env, accessToken, targetFileId),
        // 🔧 2026-09: "다른 회원 보기"에 퇴실자도 "{이름} (퇴실)"로 포함시켜
        // 관리자가 마지막 참여 시점 기록을 웹에서 조회할 수 있게 한다 —
        // 이전엔 이 탭이 구글 시트를 직접 열어야만 확인 가능했다. 원본
        // 조회일 때만(과거 사이클 백업 파일엔 이 탭이 없음).
        cycleFileId ? Promise.resolve([]) : listExitedMemberEntries(env, accessToken, targetFileId),
      ]);
      return [...members.map((m) => ({ number: m.number, name: m.name, email: m.email })), ...exitedMembers];
    });
    return json({ members: responseMembers }, 200, origin);
  } catch (err) {
    return json({ error: "회원 목록 조회 실패: " + err.message }, 500, origin);
  }
}

// "퇴실 스터디원 목록" 전용 — 원본 스프레드시트에 남은 퇴실자 백업 탭
// 각각에, 확정 처리 시점에 저장해둔 결과(MemberSettingsDO의 exitResult)를
// 함께 붙여 반환한다. 이 기능 도입(2026-09) 이전에 처리된 퇴실자는 그
// 시점에 저장된 값이 없으므로 result: null로 내려간다 — 프론트가 "처리
// 결과를 조회할 수 없습니다(이 기능 도입 이전 처리)"로 안내한다.
// 🔧 [KV → DO 이전, 2026-09-12] §49 — 퇴실자 전원에 대해 개별 get을
// 병렬 호출하던 것을 /exit/list 1회 호출로 대체(왕복 횟수 N회→1회).
async function handleAdminExitedMembers(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    const exitedMembers = await listExitedMemberEntries(env, accessToken, fileId);

    const resultsRes = await getMemberSettingsStub(env).fetch("https://do/exit/list");
    const { items: allResults } = await resultsRes.json();
    const members = exitedMembers.map((m) => ({
      number: m.number,
      name: m.name,
      result: allResults[m.name] || null,
    }));

    return json({ members }, 200, origin);
  } catch (err) {
    return json({ error: "퇴실 스터디원 목록 조회 실패: " + err.message }, 500, origin);
  }
}

// "벌금 납부 대상 처리"(PaidFineList)의 "직권 P" 버튼은 항상 이 사유로
// 고정해서 admin_forced 확정을 요청한다(§AdminMoneyTab.tsx, lockForcedReason)
// — 이 문자열을 바꾸면 여기도 함께 바꿔야 아래 카운트가 계속 맞게 걸린다.
// 🔧 [사용자 지시] "직권 P 사이클 오인 방지" — handleAdminExitPreview/
// handleAdminExitConfirm이 body로 받는 forcedReason "원본"(prefix 없는
// 값, 프론트 lockForcedReason과 동일)과 비교하려면 이 상수가 필요하다.
// FINE_UNPAID_ADMIN_FORCED_REASON_LABEL은 calcAdminForcedExit가 "직권
// 사유: " prefix를 붙인 뒤의 label 형태라 원본과 직접 비교할 수 없어,
// 아래 label 상수를 이 원본으로부터 파생시켜 두 상수가 항상 일치하게
// 유지한다(§46 근처의 "관련 문서" 앞에 §CACHING_POLICY.md 기록 참고).
const FINE_UNPAID_ADMIN_FORCED_REASON = "벌금 시한 내 미납자";
const FINE_UNPAID_ADMIN_FORCED_REASON_LABEL = `직권 사유: ${FINE_UNPAID_ADMIN_FORCED_REASON}`;

// 🔧 2026-09: "직권 P : N건" 배지(§PaidFineList 요일 헤더) 실제 구현 —
// "벌금을 납부하지 않아서 '퇴실 처리 (직권 P)'가 눌려서 퇴실 처리된
// 사용자"(사용자 정의)를 요일별로 센다. 판정 기준은 kind==="admin_forced"
// 이면서 사유가 정확히 위 고정 문구인 것 — 같은 admin_forced라도
// MemberRosterList처럼 관리자가 자유 입력한 사유로 처리된 경우는 세지
// 않는다. 그 사람이 실제로 미납이었던 요일들(breakdown.fineUnpaidDays,
// 확정 시점 스냅샷)을 그대로 credit한다 — 한 사람이 여러 요일에 미납
// 이었으면 각 요일 그룹에 1건씩 더해진다(각 요일 그룹의 "미납" 목록에
// 실제로 그 사람이 있었으므로).
// 🔧 [KV → DO 이전, 2026-09-12] §49 — /exit/list 1회 호출로 대체.
async function handleAdminFinesAdminForcedCount(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    const exitedMembers = await listExitedMemberEntries(env, accessToken, fileId);

    const resultsRes = await getMemberSettingsStub(env).fetch("https://do/exit/list");
    const { items: allResults } = await resultsRes.json();

    const counts = Object.fromEntries(STATUS_DAYS.map((d) => [d, 0]));
    for (const m of exitedMembers) {
      const result = allResults[m.name];
      if (!result) continue; // 이 기능 도입 이전 처리된 퇴실자는 저장된 결과가 없다.
      if (result.kind !== "admin_forced") continue;
      const isFineReason = (result.reasons || []).some(
        (r) => r.code === "admin_reason" && r.label === FINE_UNPAID_ADMIN_FORCED_REASON_LABEL
      );
      if (!isFineReason) continue;
      for (const day of result.breakdown?.fineUnpaidDays || []) {
        if (day in counts) counts[day] += 1;
      }
    }

    return json({ counts }, 200, origin);
  } catch (err) {
    return json({ error: "직권 P 인원 집계 실패: " + err.message }, 500, origin);
  }
}

async function handleAdminMemberStatus(req, env, origin, memberNumber, url) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);

    // 🔧 2026-09: 퇴실자 백업 탭("{이름} (퇴실)")은 buildPersonalStatus가
    // 전제하는 "살아있는 회원"이 아니다 — 순위/제보점수/페널티 사이클/
    // "데이터" 시트 슬롯 모두 실시간 참조인데, 퇴실 시 그 회원번호 행은
    // 이미 초기화되었거나(재사용 전) 새 회원의 값으로 덮여있다(재사용 후).
    // 그대로 재사용하면 엉뚱한 값이 나오므로, 백업 탭 셀 값만 그대로
    // 읽는 별도 읽기 전용 경로(buildExitedMemberSnapshot)로 분기한다.
    if (memberNumber.startsWith(EXITED_MEMBER_PREFIX)) {
      const backupSheetName = memberNumber.slice(EXITED_MEMBER_PREFIX.length);
      const status = await buildExitedMemberSnapshot(env, accessToken, env.GOOGLE_SHEET_FILE_ID, backupSheetName);
      if (!status) return json({ error: "퇴실자 기록을 찾을 수 없습니다." }, 404, origin);
      return json(status, 200, origin);
    }

    const cycleFileId = url ? url.searchParams.get("cycle") : null;
    const { fileId: targetFileId, weekOf } = await resolveTargetFileId(env, accessToken, cycleFileId);
    const members = await listAllMembers(env, accessToken, targetFileId);
    const member = members.find((m) => m.number === memberNumber);
    if (!member) return json({ error: "존재하지 않는 회원번호입니다." }, 404, origin);

    const status = await buildPersonalStatus(env, accessToken, targetFileId, member.number, member.name, weekOf);
    return json(status, 200, origin);
  } catch (err) {
    return json({ error: "회원 상태 조회 실패: " + err.message }, 500, origin);
  }
}

const FINE_STATUS_VALUES = ["미납", "납부", "면제"];

async function handleAdminFinesUnpaid(req, env, origin, url) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const cycleFileId = url ? url.searchParams.get("cycle") : null;
    const { fileId } = await resolveTargetFileId(env, accessToken, cycleFileId);
    const unpaid = await listUnpaidFines(env, accessToken, fileId);
    return json({ unpaid }, 200, origin);
  } catch (err) {
    return json({ error: "벌금 미납 목록 조회 실패: " + err.message }, 500, origin);
  }
}

async function handleAdminFinesPaid(req, env, origin, url) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const cycleFileId = url ? url.searchParams.get("cycle") : null;
    const { fileId } = await resolveTargetFileId(env, accessToken, cycleFileId);
    const [paid, totalAmount] = await Promise.all([
      listPaidFines(env, accessToken, fileId),
      getWeeklyPaidFineTotal(env, accessToken, fileId),
    ]);
    return json({ paid, totalAmount }, 200, origin);
  } catch (err) {
    return json({ error: "벌금 납부 목록 조회 실패: " + err.message }, 500, origin);
  }
}

async function handleAdminFinesExempt(req, env, origin, url) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const cycleFileId = url ? url.searchParams.get("cycle") : null;
    const { fileId } = await resolveTargetFileId(env, accessToken, cycleFileId);
    const exempt = await listExemptFines(env, accessToken, fileId);
    return json({ exempt }, 200, origin);
  } catch (err) {
    return json({ error: "벌금 면제 목록 조회 실패: " + err.message }, 500, origin);
  }
}

// 🔧 [사용자 지시, 2026-09-10] "예치금 재납이나 벌금 납부는 당일에 처리될
// 수도 있지만 보통은 익일이거나 하루 이틀 늦게 처리될 수도 있는데, 그럼
// 쓰기가 지난 주 시트에서도 가능해야 하지 않나?" — 납부확인은 "그 주차의
// 납부 기록 자체"라 실제로 그 주차 시트(현재 진행 중인 사이클 내 백업
// 포함)에 남아야 정확하다. resolveTargetFileId가 이미 "현재 사이클
// (1~3주차) 밖의 임의 fileId"는 거부하므로, 사이클을 벗어난 과거 기록을
// 건드릴 위험은 없다.
async function handleAdminFineStatus(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { number, day, status, cycle } = await req.json();
  const sheetNum = parseInt(number, 10);
  const dayIndex = STATUS_DAYS.indexOf(day);
  if (!sheetNum || sheetNum < 1 || sheetNum > 15 || dayIndex === -1) {
    return json({ error: "회원번호 또는 요일이 올바르지 않습니다." }, 400, origin);
  }
  if (!FINE_STATUS_VALUES.includes(status)) {
    return json({ error: "상태값은 미납/납부/면제 중 하나여야 합니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const { fileId } = await resolveTargetFileId(env, accessToken, cycle);
    const col = colIndexToLetter(STATUS_DAY_COLS[dayIndex]);
    await writeSheetValues(env, accessToken, fileId, [
      { range: `${sheetNum}!${col}${ROW_PAYMENT_CHECK + 1}`, values: [[status]] },
    ]);
    await invalidateMemberCache(env, ["fine"], fileId); // 납부확인 값이 바뀌었으므로 관련 캐시만, 그 fileId에 한해 무효화.
    return json({ ok: true, number: String(sheetNum), day, status }, 200, origin);
  } catch (err) {
    return json({ error: "납부 상태 변경 실패: " + err.message }, 500, origin);
  }
}

// Money 탭 "상금 수령 대상자 처리"의 "상금 정산 집행" 버튼 — 관리자가 이번 주
// 1~5등 분배를 실제로 지급했다는 걸 시트에 기록하는 단순 마킹. 다른 상태
// 마킹처럼 셀 하나(집계!P6)에 "완료" 문자열을 쓰기만 한다.
// 🔧 [버그 수정, 2026-09-10] 이 값은 buildRosterStatus의 settlementSettled로
// 이미 읽혀 RANK 탭에 노출되고 있었다 — "판정에 쓰는 기존 로직이 없다"는
// 이전 주석이 낡아 있었다(buildRosterStatus 도입 당시 갱신을 놓침). RANK
// 탭에 캐싱(rosterStatus:, 30분)을 새로 추가하면서, 이 마킹도 즉시
// 무효화해야 "정산 집행 완료" 상태가 최대 30분 늦게 반영되는 걸 막을 수
// 있다.
// 🔧 [사용자 지시, 2026-09-11] PEN·Money 탭 전면 재점검 — rosterStatus:는
// penalty 그룹(제보 승인) 무효화에서 의도적으로 빠져있어(§16, §31) 최대
// 10분 낡을 수 있는데, 프론트가 재조회해도 그 사이 캐시가 안 지워졌으면
// 여전히 낡은 총 모금액을 받아 검증이 무의미해질 수 있었다. 집행 직전에
// 이 함수 자체가 rosterOnly 그룹을 먼저 지우고 buildRosterStatus를 다시
// 계산해, 프론트가 보낸 expectedCollectMoney와 "진짜 최신" 총 모금액을
// 대조한다 — 프론트 재확인(느슨한 안전장치)과 별개로 서버가 최종 방어선
// 역할을 한다.
// 🔧 [2차 점검, 2026-09-11] "총 모금액만 검증하면 부족하다" — 제보 승인은
// 집계 F열(순위) 수식만 바꾸고 D20(총 모금액)은 안 바꾸므로, 총액이
// 그대로인 채 1~5등 수령자 구성만 바뀌는 경우 위 검증을 그대로 우회했다.
// 관리자가 화면에 뜬 명단을 보고 먼저 실제로 송금한 뒤 이 버튼으로 완료만
// 기록하는 워크플로우라(§6230 주석), 낡은 명단으로 잘못된 사람에게 이미
// 송금된 뒤에야 뒤늦게 막히는 게 진짜 위험이었다. 프론트가 화면에 표시된
// 수령자 번호 순서(expectedSettlementNumbers)도 함께 보내면, 서버가
// 재계산한 최신 순위 기준 수령자 번호 순서와 정확히 일치할 때만 집행을
// 허용한다. settlement는 rankValue로 안정 정렬되어 같은 데이터면 항상
// 같은 순서로 나오므로(비결정 요소 없음), 실제로 명단이 안 바뀌었다면
// 오탐 없이 통과한다.
async function handleAdminPrizeSettle(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const { expectedCollectMoney, expectedSettlementNumbers } = await req.json().catch(() => ({}));
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    await invalidateMemberCache(env, ["rosterOnly"], fileId);
    const latest = await buildRosterStatus(env, accessToken, fileId);
    const latestNumbers = (latest.settlement || []).map((s) => s.number);
    const collectMoneyChanged =
      typeof expectedCollectMoney === "number" && expectedCollectMoney !== (latest.collectMoney ?? 0);
    const settlementChanged =
      Array.isArray(expectedSettlementNumbers) &&
      (expectedSettlementNumbers.length !== latestNumbers.length ||
        expectedSettlementNumbers.some((num, i) => num !== latestNumbers[i]));
    if (collectMoneyChanged || settlementChanged) {
      return json(
        {
          error: "정산 대상 정보가 방금 바뀌었습니다. 화면을 새로고침한 뒤 다시 확인해 주세요.",
          collectMoney: latest.collectMoney ?? 0,
        },
        409,
        origin
      );
    }
    await writeSheetValues(env, accessToken, fileId, [{ range: "집계!P6", values: [["완료"]] }]);
    await invalidateMemberCache(env, ["rosterOnly"], fileId);
    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "상금 정산 집행 처리 실패: " + err.message }, 500, origin);
  }
}

// --- 퇴실자·재납자 처리 핸들러 (경로 A: 원본 시트 즉시 처리) ---

// PENALTY 탭 "페널티 대상자" 목록 — 페널티 누적(송출P 금주+누적, 주간P 누적)이
// 2 이상인 회원만 추린다. 예치금 관련(재납/미납) 강제퇴실은 별도 섹션
// (예치금 미납 현황)에서 다루므로 여기서는 다루지 않는다. 페널티 2 이상이면
// 반환율은 항상 0%로 고정이라 정산 퇴실자(settle) 단일 유형으로만 처리한다.
// listExitCandidates/listActiveMembersWithExitInfo가 공통으로 쓰는 조회.
// 퇴실 판정에 필요한 값(참여상태/가입일수/벌금·예치금 미납 신호/페널티
// 누적)은 모두 개인 탭 한 범위(A1:U45) 안에 있다. 예전에는 회원마다 이걸
// getSheetValues로 따로 불러 15번(+ 훨씬 무거운 buildPersonalStatus 조합
// 시 60번 이상)의 개별 HTTP 요청을 만들어 "분당 읽기 요청 60회" 한도를
// 손쉽게 넘겼다. batchGetSheetValues로 15명분을 한 번의 요청에 몰아
// Sheets API 쿼터를 1회만 소진하도록 바꾼다.
// 🔧 [데이터 시트 통합] 페널티 판정(depositRefundBreakdown)에 이제 "데이터"
// 시트 F~M 슬롯이 필요하다 — 회원마다 따로 조회하면 이 함수가 원래 피하려던
// "회원마다 개별 요청" 문제가 재발하므로, "데이터" 시트 F4:M18을 통째로 한 번만
// 읽어 회원번호(행-3)로 매핑해 재사용한다.
// "예치금 재납 대상자"(PenaltyCandidateList)와 "스터디원 목록"
// (MemberRosterList)이 같은 관리자 화면 안에서 거의 동시에 마운트되며
// 이 함수를 각자 호출한다 — 개인 탭 원본 배치 조회는 getSharedMemberRows가
// 이미 공유하지만, 여기서 파생 계산까지 마친 최종 결과도 함께 캐싱해
// 데이터/집계 시트 조회(3건)까지 완전히 건너뛴다. TTL 1분은 인메모리
// 캐시만으로는 부족하다(Cloudflare Workers가 요청을 여러 독립 isolate로
// 분산해, 다른 사용자·새 연결끼리는 인메모리 캐시가 거의 공유되지 않는다
// — 2026-08 실측으로 확인) — KV(REPORTS_KV)에도 함께 저장해 isolate
// 경계를 넘어 공유되도록 한다(_cacheSetAsync).
// 🔧 [사용자 지시, 2026-09-11] ACCOUNT 탭 TTL 점검 — 이 캐시를 무효화하는
// 5개 그룹(roster/penalty/fine/exitRequest/partiStatus) 모두 Worker API
// 경유 쓰기 직후 항상 await로 무효화되어 신뢰도가 높다. 유일한 우회 경로인
// 구글시트 메뉴 "퇴실자·재납자 처리"(_exit_define, appscript.js)는 캐시
// 무효화 알림이 없는 gap이 있지만, 웹 서비스가 정상 가동 중엔 이 메뉴를
// 쓸 일이 없고(대부분 기능이 웹으로 이전 완료, 웹 장애 시의 비상 수단으로만
// 남음) — 그 비상 상황 자체에선 웹 화면의 캐시 최신성이 애초에 무의미해
// 이 gap과 TTL 상향이 실질적으로 겹치지 않는다고 판단해 60초→10분으로
// 올린다.
async function getAllExitRelevantStatus(env, accessToken, fileId, members) {
  return _cachedCompute(env, `exitStatus:${fileId}`, 10 * 60_000, async () => {
    const [allRows, dataRows, currentCycle, notesGrid, exitRequests] = await Promise.all([
      getSharedMemberRows(env, accessToken, fileId, members),
      getSheetValues(env, accessToken, fileId, "데이터!F4:M18"),
      getCurrentPenCycle(env, accessToken, fileId),
      getPenaltySlotNotesGrid(env, accessToken, fileId),
      // 🔧 [고지지연 반영] 관리자용 목록(퇴실 후보/스터디원 목록)도 개인
      // 대시보드(buildPersonalStatus)와 동일하게 실제 퇴실 신청일을 반영해야
      // 반환 예상액이 어긋나지 않는다.
      listExitRequests(env),
    ]);

    return members.map((member, i) => {
      const rows = allRows[i];
      if (!rows || rows.length <= ROW_MORNING_FINE) return null;
      const partiStatus = (rows[ROW_PARTI_STATUS] && rows[ROW_PARTI_STATUS][COL_PARTI_STATUS]) || "";
      const joinDate = (rows[ROW_JOIN_DATE] && rows[ROW_JOIN_DATE][8]) || "";
      const rowIdx = parseInt(member.number, 10) - 1;
      const dataRow = dataRows[rowIdx] || [];
      const values = OUTPUT_PEN_SLOT_COLUMNS.map((_, idx) => parseInt(dataRow[idx], 10) || 0);
      const timePenValues = [parseInt(dataRow[6], 10) || 0, parseInt(dataRow[7], 10) || 0];
      const penCounts = countCurrentCyclePen({ values, timePenValues }, currentCycle);
      const exitRequestDate = (exitRequests.get(member.number) || {}).exitDate || null;
      const breakdown = depositRefundBreakdown(rows, penCounts, exitRequestDate);
      const slotNotes = notesGrid[rowIdx] || [];
      const occurredDay = latestSlotDay([...values, ...timePenValues], slotNotes);
      const outputPenHistory = buildSlotHistory(values, slotNotes.slice(0, 6), "송출 P");
      const timePenHistory = buildSlotHistory(timePenValues, slotNotes.slice(6, 8), "주간 P");
      return { member, partiStatus, joinDate, breakdown, occurredDay, outputPenHistory, timePenHistory };
    });
  });
}

// PENALTY 탭 "페널티 대상자" — 페널티 누적 2회 이상(강제 퇴실자 조건 중
// 하나)인 회원만 추린다. 다른 강제 퇴실 조건(30일 미만/벌금·예치금 미납)에
// 걸린 회원은 이 목록이 아니라 MEMBER 탭에서 함께 다룬다.
async function listExitCandidates(env, accessToken, fileId) {
  const members = await listAllMembers(env, accessToken, fileId);
  const statuses = await getAllExitRelevantStatus(env, accessToken, fileId, members);
  return statuses
    .filter(Boolean)
    .filter((s) => !/^(퇴실자|재납자)/.test(s.partiStatus))
    .map((s) => ({ ...s, forced: calcForcedOutDeposit(s.breakdown) }))
    .filter((s) => s.forced && s.forced.reasons.some((r) => r.code === "penalty_2_or_more"))
    .map((s) => ({
      number: s.member.number,
      name: s.member.name,
      suggestedKind: "forced",
      reasons: s.forced.resultStr,
      reasonCodes: s.forced.reasons,
      allChecks: forcedExitChecks(s.breakdown),
      // 채워진 송출P/주간P 슬롯 주석 중 가장 최근 날짜의 요일 — "예치금
      // 재납 대상자" 목록을 화각 제보 검토와 동일하게 요일별로 묶어 보여주는
      // 데 쓰인다. 주석이 하나도 없으면(예: 아주 예전 슬롯) null.
      occurredDay: s.occurredDay,
      // 개인별 상세 카드의 "송출 P 적립 기록"/"주간 P 적립 기록" 섹션에
      // 그대로 뿌려지는 슬롯별 이력(차수·발생일시·사유).
      outputPenHistory: s.outputPenHistory,
      timePenHistory: s.timePenHistory,
    }));
}

// MEMBER 탭 "스터디원 목록"용 — 이미 퇴실/재납 처리된 회원을 제외한 전원을
// 반환한다(listExitCandidates와 달리 강제 조건 여부로 걸러내지 않음).
// 조건에 해당 없는 회원은 suggestedKind를 "settle"(자연 퇴실 처리 가능)로 둔다.
// --- 퇴실 신청(예약) — 회원 본인이 "퇴실하겠다"고 미리 알리는 가벼운 표시.
// 실제 시트 반영(백업 탭 이동/초기화)은 여전히 관리자가 ExitProcessDialog로
// 확정해야만 일어난다 — 이 KV 항목은 순수하게 "스터디원 목록"에 "퇴실 예약"
// 뱃지를 보여주기 위한 상태일 뿐, 시트에는 아무 영향도 주지 않는다.
// 🔧 2026-09: 퇴실 확정 처리 결과(반환 예치금/차감 원인/처리 결과/퇴실유형)를
// 영구 보존한다 — resultMsg(백업 탭 텍스트 박스)는 사람이 읽기 좋은 문자열
// 하나로 뭉쳐져 있어, "참여 스터디원 목록"처럼 반환 예치금/차감 원인을
// 구조화된 카드로 다시 보여주려면 정규식 파싱이 필요했다. computeExitResult가
// 이미 계산해서 들고 있는 구조화된 값(refundAmount/heldAmount/breakdown/
// kindStr 등)을 확정 시점에 그대로 저장해두면 재계산·파싱 없이 그대로 재사용할
// 수 있다. 키는 회원번호가 아니라 백업 탭 이름("{이름} (퇴실)")을 기준으로
// 한다 — 회원번호는 나중에 새 회원에게 재배정되므로, 번호로 저장하면 그
// 시점부터 옛 퇴실자의 처리 결과가 새 회원 것으로 오인될 위험이 있다
// ("데이터 (감사)" 스냅샷과 동일한 이유, appendDataAuditSnapshot 주석 참고).
// TTL 없음(영구) — "최근 N분"짜리 알림이 아니라 회계상 보존해야 할 이력이다.
// 🔧 [KV → DO 이전, 2026-09-12] §49 — MemberSettingsDO로 이전했다.

// 🔧 [KV → DO 이전, 2026-09-12] exitRequest:{번호}와 그 인덱스
// (exitRequestIndex:current)를 LeaveQueue DO로 옮겼다(§47). 회원별
// 최대 1건이라 DO의 `Map<memberNumber, entry>` 자체가 인덱스 역할을
// 겸하므로 별도 인덱스가 필요 없다. 인덱스 전용 전역 락
// (exitRequestIndex:global, §37에서 "회원 A 신청과 관리자의 B 확정이
// 겹치는 경쟁 조건" 방지 목적으로 도입)도 DO가 요청을 직렬 처리해
// 경쟁 조건이 구조적으로 불가능해지므로 함께 사라졌다.
async function handleSetExitRequest(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const { exitDate } = await req.json().catch(() => ({}));
  if (exitDate && !/^\d{4}-\d{2}-\d{2}$/.test(exitDate)) {
    return json({ error: "희망 퇴실일 형식이 올바르지 않습니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const memberNumber = await resolveMemberNumber(env, accessToken, session);
    const ts = Date.now();
    // 새로 신청할 때마다 동의 상태는 초기화한다 — 신청을 취소했다가 다시
    // 하거나, 신청 날짜를 바꾸는 경우 이전 동의가 그대로 남아있으면 안 된다.
    await getLeaveQueueStub(env).fetch("https://do/exit/put", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberNumber, exitDate: exitDate || null, ts, agreedAt: null }),
    });
    // 🔧 [고지지연 반영] exitRequestDate가 이제 depositRefundBreakdown의
    // amount 계산에 쓰이므로, 신청 직후 본인 화면(personalStatus)과 관리자
    // 목록(exitStatus 등 MEMBER_CACHE_PREFIXES 그룹)에 옛 반환액이 남지
    // 않도록 함께 무효화한다.
    await Promise.all([
      invalidatePersonalStatusCache(env, env.GOOGLE_SHEET_FILE_ID, memberNumber),
      invalidateMemberCache(env, ["exitRequest"]),
    ]);
    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "퇴실 신청 실패: " + err.message }, 500, origin);
  }
}

// 🔧 [일간 집계 완료 시점 반영] daily_calc()(앱스크립트)는 "그날 다음날
// 자정~오전 1시 사이"에 실행돼야 그날치 벌금 미납/페널티 판정이 최종
// 반영된다 — exitDate 당일이 KST로 지났다고 바로 동의를 허용하면, 아직
// 그날 집계가 안 끝난 값에 회원이 동의해버릴 수 있다(사용자 지적). exitDate
// 다음날 오전 2시(집계 시각보다 여유를 둔 시각) KST 이후부터 허용한다.
function exitDateSettled(exitDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(exitDate || "");
  if (!m) return false;
  const exitDateMidnightUtcMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 9 * 60 * 60 * 1000;
  const settledAtUtcMs = exitDateMidnightUtcMs + 26 * 60 * 60 * 1000;
  return Date.now() >= settledAtUtcMs;
}

// exitDate("YYYY-MM-DD")의 KST 자정을 UTC ms로 계산 — exitDateSettled와
// 동일한 변환(KST는 UTC+9이므로 "그 날짜 00:00 KST" = "그 날짜 00:00 UTC - 9시간").
function exitDateMidnightUtcMs(exitDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(exitDate || "");
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 9 * 60 * 60 * 1000;
}

// exitDate가 속한 주(월~일)의 월요일을 "YYMMDD"로 반환 — appscript.js의
// get_last_week_date_range()가 만드는 백업 파일명 접두부와 동일한 포맷.
// sheet_reset()이 매주 월요일 새벽에 "그 주(월~일) 백업"을 만들 때 쓰는
// 이름 규칙을 그대로 역산해, exitDate가 어느 백업 파일에 담겨야 하는지 찾는다.
function weekOfForDate(exitDate) {
  const midnightMs = exitDateMidnightUtcMs(exitDate);
  if (midnightMs === null) return null;
  // exitDate(KST 자정)를 "UTC 시각이지만 KST 날짜를 담고 있는" Date로 다시
  // 만들어 nowKST()와 동일한 트릭으로 요일(getUTCDay)을 읽는다.
  const kstDate = new Date(midnightMs + 9 * 60 * 60 * 1000);
  const jsDay = kstDate.getUTCDay(); // 일=0 ... 토=6
  const mondayOffset = (jsDay + 6) % 7; // 이 날짜가 월요일로부터 며칠째인지(월=0)
  const monday = new Date(midnightMs - mondayOffset * 24 * 60 * 60 * 1000);
  const mondayKst = new Date(monday.getTime() + 9 * 60 * 60 * 1000);
  const yy = String(mondayKst.getUTCFullYear()).slice(-2);
  const mm = String(mondayKst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(mondayKst.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

// 🔧 [sheet_reset 이후 원본 오염 문제] exitDate가 속한 주의 sheet_reset
// (그 다음 월요일 오전 5~6시 KST)이 이미 지났으면, 원본 시트는 더 이상
// exitDate 시점의 정확한 값을 담고 있지 않다(페널티 사이클 순환, 재납
// 상태 초기화 등) — 이 경우 원본이 아니라 그 주의 자동 백업 파일을 봐야
// 한다(사용자 지시). "오늘이 며칠인지"가 아니라 반드시 "exitDate가 속한
// 주의 리셋 시점"을 기준으로 계산해야 한다 — 그렇지 않으면 exitDate가
// 월요일인 경우 "오늘도 월요일이니 리셋이 지났다"고 착각해, 실제로는
// exitDate가 담긴 백업이 아직 없는데(그 백업은 다음 주 월요일에야 생김)
// 엉뚱한 전전주 백업을 참조하게 된다(사용자 지적).
function exitWeekResetPassed(exitDate) {
  const midnightMs = exitDateMidnightUtcMs(exitDate);
  if (midnightMs === null) return false;
  const kstDate = new Date(midnightMs + 9 * 60 * 60 * 1000);
  const jsDay = kstDate.getUTCDay();
  const mondayOffset = (jsDay + 6) % 7; // 이 날짜가 월요일로부터 며칠째인지(월=0)
  const mondayMidnightUtcMs = midnightMs - mondayOffset * 24 * 60 * 60 * 1000;
  // 그 주 월요일 자정(KST) + 7일 + 6시간 = 다음 주 월요일 06:00 KST.
  // sheet_reset은 5~6시 사이 실행되므로 여유를 두고 6시를 기준으로 삼는다.
  const resetAtUtcMs = mondayMidnightUtcMs + 7 * 24 * 60 * 60 * 1000 + 6 * 60 * 60 * 1000;
  return Date.now() >= resetAtUtcMs;
}

// exitDate가 속한 주의 자동 백업 파일(fileId)을 찾는다. sheet_reset이 아직
// 그 주 백업을 만들지 않았으면(리셋 전, 또는 드물게 백업 실패) null.
async function findBackupForExitDate(env, accessToken, exitDate) {
  const weekOf = weekOfForDate(exitDate);
  if (!weekOf) return null;
  const backups = await listBackupFiles(env, accessToken);
  return backups.find((b) => b.weekOf === weekOf) || null;
}

// 회원 본인이 "예치금 정산액에 동의합니다"를 누르는 API — 퇴실 예약일
// (exitDate)의 일간 집계가 실제로 끝나야만(exitDateSettled) 누를 수 있다.
// 이 동의가 있어야만 관리자의 "정산" 처리 버튼이 활성화된다 — 신청만으로
// 관리자가 바로 확정 처리를 할 수 있었던 기존 흐름에, 회원이 최종 금액에
// 실제로 동의했는지 확인하는 단계를 하나 더 끼워넣는 것(사용자 지시).
async function handleAgreeExitRequest(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const memberNumber = await resolveMemberNumber(env, accessToken, session);
    const leaveQueueStub = getLeaveQueueStub(env);
    const existingRes = await leaveQueueStub.fetch(`https://do/exit/get?memberNumber=${encodeURIComponent(memberNumber)}`);
    const { entry: existing } = await existingRes.json();
    if (!existing) return json({ error: "퇴실 신청 내역이 없습니다." }, 404, origin);

    if (!existing.exitDate) {
      return json({ error: "마지막 참여일이 지정되지 않은 신청입니다." }, 400, origin);
    }
    if (!exitDateSettled(existing.exitDate)) {
      return json({ error: "아직 마지막 참여일의 일간 집계가 끝나지 않았습니다." }, 400, origin);
    }

    const agreedAt = Date.now();
    await leaveQueueStub.fetch("https://do/exit/put", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberNumber, exitDate: existing.exitDate, ts: existing.ts, agreedAt }),
    });
    await Promise.all([
      invalidatePersonalStatusCache(env, env.GOOGLE_SHEET_FILE_ID, memberNumber),
      invalidateMemberCache(env, ["exitRequest"]),
    ]);
    return json({ ok: true, agreedAt }, 200, origin);
  } catch (err) {
    return json({ error: "동의 처리 실패: " + err.message }, 500, origin);
  }
}

// 본인 또는 관리자가 취소할 수 있다 — 관리자는 body에 number를 지정해
// 다른 회원의 신청을 취소한다(스터디원 목록의 "퇴실 예약" 뱃지 옆에서 사용).
async function handleCancelExitRequest(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  try {
    const { number: targetNumber } = await req.json().catch(() => ({}));
    let memberNumber = targetNumber;
    if (memberNumber) {
      const isAdmin = (session.email || "").toLowerCase() === (env.ADMIN_EMAIL || "").toLowerCase();
      if (!isAdmin) return json({ error: "관리자만 다른 회원의 신청을 취소할 수 있습니다." }, 403, origin);
    } else {
      const accessToken = await getServiceAccountAccessToken(env);
      memberNumber = await resolveMemberNumber(env, accessToken, session);
    }
    await getLeaveQueueStub(env).fetch("https://do/exit/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberNumber }),
    });
    await Promise.all([
      invalidatePersonalStatusCache(env, env.GOOGLE_SHEET_FILE_ID, memberNumber),
      invalidateMemberCache(env, ["exitRequest"]),
    ]);
    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "퇴실 신청 취소 실패: " + err.message }, 500, origin);
  }
}

// number -> {exitDate,ts,agreedAt} 맵. LeaveQueue DO에서 조회한다
// (§47 — 2026-08-27 KV list() 하루 한도 소진으로 이 함수를 쓰는
// "/admin/members/roster"가 500을 낸 것을 계기로 인덱스 방식으로
// 전환했었고, 이번에 그 인덱스 자체를 DO로 옮겼다).
async function listExitRequests(env) {
  const res = await getLeaveQueueStub(env).fetch("https://do/exit/list");
  const { items } = await res.json();
  return new Map(Object.entries(items || {}));
}

// 🔧 [마지막 참여일 이후 집계 차단] 도움봇이 매 교시 시트에 기록하기 전,
// "이미 마지막 참여일이 지난 퇴실 신청 회원"을 걸러낼 수 있도록 exitDate만
// 뽑아 내려준다. 관리자가 확정 처리를 늦게 하더라도(sheet_reset을 넘기는
// 경우까지 포함), 그 사이 봇이 결석 기록("00:00"/ERR)을 계속 남겨 새 벌금·
// 페널티가 발생하는 것을 막기 위한 용도 — Worker/앱스크립트는 시트 자체를
// 건드리지 않고, 데이터를 만드는 첫 지점(도움봇)에서 원천 차단한다.
async function handleBotExitRequests(req, env, origin) {
  const botSecret = req.headers.get("X-Bot-Secret");
  if (!botSecret || botSecret !== env.BOT_SECRET) {
    return json({ error: "unauthorized" }, 401, origin);
  }
  const exitRequests = await listExitRequests(env);
  const exitDates = {};
  for (const [number, entry] of exitRequests) {
    if (entry && entry.exitDate) exitDates[number] = entry.exitDate;
  }
  return json({ exitDates }, 200, origin);
}

// 🔧 [앱스크립트 직접 쓰기 캐시 정합성, 2026-09] 앱스크립트(daily_calc/
// revoke_editor_column_n/o)는 Worker API를 거치지 않고 gspread와 마찬가지로
// 시트에 직접 쓴다 — writeSheetValues의 내장 무효화도, invalidateMemberCache
// 호출도 전혀 트리거되지 않는다. 지금까지는 personalStatus:(10분)/
// outputPenSlots:(5분) 등 TTL이 자연 만료될 때까지 기다리는 수밖에 없었는데,
// 특히 매주 월요일 목표시간 마감(회원이 마감 직후 확인하려는 시점과 겹침)과
// 일요일 자정 자동 벌점 기록(관리자 화면이 그 시각 열려 있으면 노출)에서
// 화면이 잠깐 낡아 보일 수 있었다(docs/CACHING_POLICY.md §12). 앱스크립트가
// 쓰기를 마친 직후 이 엔드포인트를 한 번 호출해 관련 캐시만 즉시 지운다 —
// 15명을 순회하는 함수 하나가 끝날 때 1회만 호출하면 되므로 KV 예산에
// 미치는 영향은 미미하다. groups는 invalidateMemberCache(env, groups)에
// 그대로 전달하고(생략 시 전체 무효화), memberNumbers가 있으면 그 각각의
// personalStatus: 캐시도 함께 지운다(개인 탭 값 — 목표시간/반휴 등은 이
// 그룹 밖이라 별도 처리 필요).
async function handleBotInvalidateCache(req, env, origin) {
  const botSecret = req.headers.get("X-Bot-Secret");
  if (!botSecret || botSecret !== env.BOT_SECRET) {
    return json({ error: "unauthorized" }, 401, origin);
  }
  const { groups, memberNumbers } = await req.json().catch(() => ({}));
  const validGroupNames = Object.keys(MEMBER_CACHE_GROUPS);
  if (groups && (!Array.isArray(groups) || groups.some((g) => !validGroupNames.includes(g)))) {
    return json({ error: "groups는 " + validGroupNames.join("/") + " 중 하나여야 합니다." }, 400, origin);
  }
  if (memberNumbers && !Array.isArray(memberNumbers)) {
    return json({ error: "memberNumbers는 배열이어야 합니다." }, 400, origin);
  }
  await Promise.all([
    groups || !memberNumbers ? invalidateMemberCache(env, groups) : Promise.resolve(),
    ...((memberNumbers || []).map((n) => invalidatePersonalStatusCache(env, env.GOOGLE_SHEET_FILE_ID, String(n)))),
  ]);
  return json({ ok: true }, 200, origin);
}

async function listActiveMembersWithExitInfo(env, accessToken, fileId) {
  const [members, exitRequests] = await Promise.all([
    listAllMembers(env, accessToken, fileId),
    listExitRequests(env),
  ]);
  const statuses = await getAllExitRelevantStatus(env, accessToken, fileId, members);
  return statuses
    .filter(Boolean)
    .filter((s) => !/^(퇴실자|재납자)/.test(s.partiStatus))
    .map((s) => {
      const forced = calcForcedOutDeposit(s.breakdown);
      const totalPen = s.breakdown.outputPen + s.breakdown.timePen;
      const exitRequest = exitRequests.get(s.member.number);
      return {
        number: s.member.number,
        name: s.member.name,
        joinDate: s.joinDate,
        totalPenalty: totalPen,
        suggestedKind: forced ? "forced" : "settle",
        reasons: forced ? forced.resultStr : [],
        reasonCodes: forced ? forced.reasons : [],
        allChecks: forcedExitChecks(s.breakdown),
        exitRequested: !!exitRequest,
        exitRequestDate: exitRequest?.exitDate || null,
        exitRequestedAt: exitRequest?.ts || null,
        exitAgreedAt: exitRequest?.agreedAt || null,
        partiStatus: s.partiStatus === "스터디장" || s.partiStatus === "부스터디장" ? s.partiStatus : "스터디원",
      };
    });
}

// "다른 관리자 의견 반영"(§ReportReviewList)의 실제 공동 검토자 명단 —
// 현재 부스터디장으로 임명된 회원(최대 2명, 사용자 확인)만 대상이다.
// listActiveMembersWithExitInfo는 강제퇴실 판정·페널티 집계까지 함께
// 계산해 이 조회엔 과하므로, batchGet으로 15개 L3(참여상태) 셀만 직접
// 읽는 훨씬 가벼운 전용 조회를 쓴다.
// 🔧 [캐싱 추가, 2026-09] "PEN·Money" 탭 "송출 P 대상 처리"(3분→10분 폴링,
// handleAdminCapturesList)가 이 함수를 매번 캐시 없이 호출해, 부스터디장
// 임명처럼 아주 가끔만 바뀌는 값을 3분마다 15명 전체 셀을 다시 읽고
// 있었다(사용자 지적). meta:(스프레드시트 구조, 같은 성격의 저빈도 값)와
// 동일하게 캐싱한다 — 임명/해제(handleAdminSetPartiStatus)가
// invalidateMemberCache(["partiStatus"])를 호출하므로, 그 그룹에 이 키를
// 포함시켜 즉시 무효화되게 한다(TTL은 그 무효화가 실패했을 때의 안전망).
// 🔧 [사용자 지시, 2026-09-11] ACCOUNT 탭 TTL 점검 — 임명/해제 경로가
// handleAdminSetPartiStatus 단일 경로뿐이고 항상 await로 무효화되며,
// 시트 직접쓰기로 부스터디장을 지정하는 우회 경로가 없음을 재확인해
// 5분→10분으로 올린다. 늘어나는 건 "무효화 자체가 실패했을 때의 안전망
// 시간"뿐이라 이 권한 검사(requireAdminOrCoReviewer)에 영향이 크지 않다.
async function getCurrentCoReviewers(env, accessToken, fileId) {
  return _cachedCompute(env, `coReviewers:${fileId}`, 10 * 60_000, async () => {
    const members = await listAllMembers(env, accessToken, fileId);
    const partiStatusValues = await batchGetSheetValues(
      env,
      accessToken,
      fileId,
      members.map((m) => `${m.number}!L3`)
    ).catch(() => []);
    return members
      .filter((_, i) => ((partiStatusValues[i] && partiStatusValues[i][0] && partiStatusValues[i][0][0]) || "") === "부스터디장")
      .map((m) => ({ number: m.number, name: m.name }));
  });
}

async function handleAdminMembersRoster(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const [members, allMembers, dataRows, sheetMeta] = await Promise.all([
      listActiveMembersWithExitInfo(env, accessToken, env.GOOGLE_SHEET_FILE_ID),
      listAllMembers(env, accessToken, env.GOOGLE_SHEET_FILE_ID),
      // 🔧 [상태 정보 확장] "스터디원 목록" 상세 패널에 구글/구루미 계정과
      // 준비 중인 시험(D~E열)을 보여주기 위해 별도로 조회한다 —
      // listAllMembers는 이메일(D열 앞부분)만 뽑아 쓰고 원본 셀 값 자체를
      // 반환하지 않으므로, 여기서 D~E열을 직접 읽어 회원번호(B열)로 매칭한다.
      // 🔧 [캐싱 통합, 2026-09] listAllMembers와 같은 원본(데이터!A1:V50)을
      // 매번 직접 다시 읽고 있었다 — getDataSheetRows(members:와 동일한
      // 10분 TTL·roster 무효화 그룹의 dataSheetRows: 캐시)로 교체해 이
      // 화면을 열 때마다 같은 범위를 두 번 읽던 걸 하나로 합친다.
      getDataSheetRows(env, accessToken, env.GOOGLE_SHEET_FILE_ID),
      // 🔧 [시트번호 바로가기] 회원번호 탭의 실제 sheetId(gid)를 알아야
      // "https://docs.google.com/.../edit#gid={sheetId}" 링크를 만들 수
      // 있다 — getSpreadsheetMeta는 5분 캐시라 이 요청 때문에 API 호출이
      // 추가로 늘지 않는다.
      getSpreadsheetMeta(env, accessToken, env.GOOGLE_SHEET_FILE_ID),
    ]);
    const sheetIdByTitle = new Map(sheetMeta.map((s) => [s.title, s.sheetId]));
    const emailByNumber = new Map(allMembers.map((m) => [m.number, m.email]));

    const detailByNumber = new Map();
    for (const row of dataRows) {
      const num = (row[1] || "").trim();
      if (!num || !/^\d+$/.test(num)) continue;
      detailByNumber.set(num, {
        googleAccount: parseGoogleEmail(row[3]),
        gooroomeeAccount: parseGooroomeeAccount(row[3]),
        examKind: (row[4] || "").trim(),
      });
    }

    // 🔧 [KV → DO 이전, 2026-09-12] §49 — 회원마다 개별 병렬 get 하던 것을
    // MemberSettingsDO의 /last-login/list 1회 호출로 대체(왕복 N회→1회).
    const lastLoginRes = await getMemberSettingsStub(env).fetch("https://do/last-login/list");
    const { items: lastLoginItems } = await lastLoginRes.json();
    const lastLoginByNumber = new Map(
      members.map((m) => {
        const entry = lastLoginItems[m.number];
        return [m.number, entry ? { ts: entry.ts || null, ip: entry.ip || "" } : { ts: null, ip: "" }];
      })
    );

    // 🔧 [참여유형 = 목표시간 유형] "참여유형"은 스터디장/부스터디장 구분이
    // 아니라 "8H 교시제" 같은 목표시간 유형(goalType)을 말한다(사용자 지적).
    // 이 값은 회원별 개인 탭 O3에만 있고 전체 회원을 한 번에 보여주는 공용
    // 셀이 없어, batchGet으로 15개 range를 한 번의 API 호출로 묶어 읽는다.
    // 🔧 [가입일자에 실제 날짜 병기] "상태 정보" 카드의 "가입일자"는
    // s.joinDate(=I3, "D+n" 상대 표시 — 개인 대시보드 요약 타일과 동일한
    // 값으로 의도된 표시)를 그대로 쓴다. 다만 관리자가 실제 등록 시점도
    // 함께 확인할 수 있도록 I2(원본 "YYYY-MM-DD")를 O3와 같은 batchGet
    // 호출에 묶어 조회해 "D+n (YYMMDD)" 형식으로 병기한다 — I3 표시 자체를
    // 대체하지 않는다(사용자 확인: D+n 표시는 의도된 것).
    const goalTypeAndJoinDateRanges = members.flatMap((m) => [`${m.number}!O3`, `${m.number}!I2`]);
    const goalTypeAndJoinDateValues = await batchGetSheetValues(
      env,
      accessToken,
      env.GOOGLE_SHEET_FILE_ID,
      goalTypeAndJoinDateRanges
    ).catch(() => []);
    const goalTypeByNumber = new Map();
    const joinDateYYMMDDByNumber = new Map();
    members.forEach((m, i) => {
      const goalTypeCell = goalTypeAndJoinDateValues[i * 2];
      const joinDateCell = goalTypeAndJoinDateValues[i * 2 + 1];
      goalTypeByNumber.set(m.number, ((goalTypeCell && goalTypeCell[0] && goalTypeCell[0][0]) || "").toString());
      const joinDateRaw = ((joinDateCell && joinDateCell[0] && joinDateCell[0][0]) || "").toString();
      // "YYYY-MM-DD" -> "YYMMDD". 형식이 어긋나면(빈 값 등) 병기하지 않는다.
      const m2 = /^\d{4}-(\d{2})-(\d{2})$/.exec(joinDateRaw);
      joinDateYYMMDDByNumber.set(m.number, m2 ? joinDateRaw.slice(2, 4) + m2[1] + m2[2] : "");
    });

    // 🔧 [관리자용 알림 설정 열람] "스터디원 목록"에서 회원별로 PUSH 구독
    // 여부(PUSH_SUBS_KV, 이메일 기준)와 카테고리별 on/off(REPORTS_KV의
    // notifyPref:{번호}, 회원번호 기준)를 함께 보여준다 — 조회 전용이며,
    // 관리자가 여기서 값을 바꾸지는 못한다(변경은 회원 본인만 /notify-prefs로).
    // 🔧 [KV list() 제거, 2026-09-11] 예전엔 list({prefix:"sub:"})로 전
    // 회원 구독을 한 번에 훑었는데, 이제 회원별 subIndex:{이메일}을 각자
    // 조회한다(§getPushDeviceIndex, handlePushSubscriptionStatus와 동일 패턴).
    const membersWithNotify = await Promise.all(
      members.map(async (m) => {
        const email = emailByNumber.get(m.number) || null;
        const [prefs, pushSubscribed] = await Promise.all([
          loadNotifyPrefs(env, m.number),
          email ? getPushDeviceIndex(env, email).then((d) => d.length > 0) : Promise.resolve(false),
        ]);
        const detail = detailByNumber.get(m.number) || { googleAccount: "", gooroomeeAccount: "", examKind: "" };
        const lastLogin = lastLoginByNumber.get(m.number) || { ts: null, ip: "" };
        const joinDateYYMMDD = joinDateYYMMDDByNumber.get(m.number) || "";
        return {
          ...m,
          joinDate: joinDateYYMMDD && m.joinDate ? `${m.joinDate} (${joinDateYYMMDD})` : m.joinDate,
          pushSubscribed,
          notifyPrefs: prefs,
          googleAccount: detail.googleAccount,
          gooroomeeAccount: detail.gooroomeeAccount,
          examKind: detail.examKind,
          goalType: goalTypeByNumber.get(m.number) || "",
          lastLoginAt: lastLogin.ts,
          lastLoginIp: lastLogin.ip,
          sheetGid: sheetIdByTitle.has(m.number) ? sheetIdByTitle.get(m.number) : null,
        };
      })
    );

    return json(
      { members: membersWithNotify, notifyCategories: NOTIFY_CATEGORIES, spreadsheetId: env.GOOGLE_SHEET_FILE_ID },
      200,
      origin
    );
  } catch (err) {
    return json({ error: "스터디원 목록 조회 실패: " + err.message }, 500, origin);
  }
}

// 부스터디장 임명/해제 — 개인 탭 L3(참여상태) 셀을 "부스터디장"/"스터디원"으로
// 직접 바꿔쓴다. 스터디장은 이 API로 건드리지 않는다(퇴실 처리 등 별도
// 경로로만 관리).
// 🔧 [2차 점검, 2026-09-11] "인원 제한 없이 여러 명을 동시에 부스터디장으로
// 둘 수 있다"던 이전 설계는 실제로는 버그였다 — `getCurrentCoReviewers`/
// "송출 P 대상 처리"(ReportReviewList) 등 코드 전반이 "부스터디장 최대
// 2명"을 전제로 짜여 있는데(사용자 확인 사항, §22), 정작 임명하는 이
// 함수엔 그 상한을 강제하는 검증이 전혀 없었다. 3명 이상이 임명돼도
// UI가 즉시 깨지지는 않지만(배열 길이에 하드코딩된 로직은 없음, 동적
// 순회), "부스터디장 2명 합의"라는 운영 규칙 자체가 조용히 깨진다.
// appoint===true일 때만 검증한다(해제는 인원이 줄어드는 방향이라 안전).
// "조회→검증→쓰기"가 그대로면 관리자 둘이 서로 다른 회원을 거의 동시에
// 임명할 때 둘 다 "현재 1명"을 보고 통과해 3명이 될 수 있어(경쟁 조건
// 재검증 완료), withMemberLock으로 전체를 감싼다 — 부스터디장은 시트
// 전체에서 최대 2명이라는 전역 제약이라 회원 단위가 아닌 고정 키
// ("viceLeader:global")로 직렬화한다. 이미 부스터디장인 회원을 다시
// appoint:true로 호출하는 재임명(no-op)은 alreadyViceLeader로 걸러
// 상한 검증에 걸리지 않는다 — "A를 B로 교체"도 UI가 해제→임명 2회의
// 독립 호출이라(전용 교체 API 없음, MemberRosterList.tsx 토글 방식)
// A 해제가 먼저 반영되면 정상적으로 통과된다.
async function handleAdminSetPartiStatus(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { number, appoint } = await req.json().catch(() => ({}));
  if (!number) return json({ error: "number가 필요합니다." }, 400, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    const members = await listAllMembers(env, accessToken, fileId);
    const member = members.find((m) => m.number === String(number));
    if (!member) return json({ error: "존재하지 않는 회원번호입니다." }, 404, origin);

    const rows = await getSheetValues(env, accessToken, fileId, `${member.number}!L3`).catch(() => []);
    const currentStatus = (rows[0] && rows[0][0]) || "";
    if (currentStatus === "스터디장") {
      return json({ error: "스터디장은 이 기능으로 변경할 수 없습니다." }, 400, origin);
    }
    // 🔧 [퇴실자/재납자 보호] "스터디원 목록"(listActiveMembersWithExitInfo)이
    // 퇴실자/재납자를 이미 필터링해 이 API를 정상 UI 경로로는 호출할 수
    // 없지만, API를 직접 호출하면 서버가 스터디장 외엔 currentStatus를
    // 검증하지 않아 "퇴실자 (0% 반환)"/"재납자 (0% 반환)" 같은 처리 완료
    // 이력이 "부스터디장"/"스터디원"으로 조용히 덮어써질 수 있었다
    // (2026-09 코드 검토로 발견, 실사용 경로에서 재현된 적은 없음).
    if (/^(퇴실자|재납자)/.test(currentStatus)) {
      return json({ error: "이미 퇴실/재납 처리된 회원은 이 기능으로 변경할 수 없습니다." }, 400, origin);
    }

    const nextStatus = appoint ? "부스터디장" : "스터디원";
    const lockResult = await withMemberLock(env, "viceLeader:global", async () => {
      if (appoint) {
        // withMemberLock은 "실행 순서"만 뮤텍스로 강제할 뿐, 그 안에서
        // 읽는 coReviewers: 캐시(TTL 10분) 자체는 여전히 KV 최종 일관성을
        // 따른다 — 다른 리전에서 방금 처리된 임명이 아직 이 리전의 KV
        // 로컬 복제본에 반영 안 됐을 수 있어(§35에서 재확인한 패턴과
        // 동일), 상한 검증 직전에 강제로 지우고 다시 계산해야 정확하다.
        await invalidateMemberCache(env, ["partiStatus"]);
        const coReviewers = await getCurrentCoReviewers(env, accessToken, fileId);
        const alreadyViceLeader = coReviewers.some((m) => m.number === member.number);
        if (!alreadyViceLeader && coReviewers.length >= 2) {
          return { failure: true };
        }
      }
      await writeSheetValues(env, accessToken, fileId, [{ range: `${member.number}!L3`, values: [[nextStatus]] }]);
      await invalidateMemberCache(env, ["partiStatus"]); // 참여상태(L3)가 바뀌었으므로 관련 캐시만 무효화.
      return { failure: false };
    });
    if (lockResult.failure) return json({ error: "부스터디장은 최대 2명까지 임명할 수 있습니다." }, 400, origin);
    return json({ ok: true, partiStatus: nextStatus }, 200, origin);
  } catch (err) {
    return json({ error: "참여상태 변경 실패: " + err.message }, 500, origin);
  }
}

async function handleAdminExitCandidates(req, env, origin, url) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const cycleFileId = url ? url.searchParams.get("cycle") : null;
    const { fileId } = await resolveTargetFileId(env, accessToken, cycleFileId);
    const candidates = await listExitCandidates(env, accessToken, fileId);
    // 지난 사이클(과거 백업) 조회면 그 시점의 대상자 명단만 보여주는 읽기
    // 전용 스냅샷이다 — 실제 강제 퇴실/재납 확정 액션은 현재 시트에서만
    // 의미가 있으므로, 프론트가 이 플래그로 처리 버튼을 잠근다.
    return json({ candidates, readOnly: !!cycleFileId }, 200, origin);
  } catch (err) {
    return json({ error: "퇴실 후보 조회 실패: " + err.message }, 500, origin);
  }
}

const EXIT_KIND_VALUES = ["forced", "admin_forced", "settle", "deposit_again"];

// 🔧 [sheet_reset 이후 정산 계산] kind === "settle"이고, 그 회원의 exitDate가
// 속한 주의 sheet_reset이 이미 지났으면, 원본(fileId) 대신 그 주의 자동
// 백업 파일에서 회원 상태를 읽어야 한다 — 원본은 이미 페널티 슬롯/재납
// 상태가 초기화되어 exitDate 시점 값을 더 이상 정확히 담고 있지 않다
// (사용자 지시: "지난 주 데이터를 가지고 계속 동일한 내용으로 계산").
// 백업이 아직 없으면(리셋 전, 또는 드문 실패) 원본을 그대로 쓴다 — 이 경우
// exitWeekResetPassed가 false이므로 애초에 이 분기를 타지 않는다.
//
// 🔧 [사용자 지시, 2026-09-10] "예치금 재납/벌금 납부는 익일이거나 하루
// 이틀 늦게 처리될 수도 있는데, 지난주 시트 기준으로도 처리 가능해야
// 하지 않나?" — settle은 회원의 exitDate로 관련 주차를 자동 판정하지만,
// deposit_again(예치금 재납)·forced류는 그런 날짜가 없다. 대신 "예치금
// 재납 대상자" 목록 자체가 이미 cycle 파라미터로 현재 진행 중인 1~3주차
// 중 어느 시점을 보고 있는지 알고 있으므로(handleAdminExitCandidates),
// 그 화면에서 확정을 누르면 프론트가 같은 cycleFileId를 함께 보내
// "그 목록을 보면서 확정한 그 주차 데이터"로 계산하게 한다. resolveTargetFileId
// 가 이미 "현재 사이클(1~3주차) 밖의 임의 fileId"를 거부하므로, 사이클을
// 벗어난 파일을 계산 근거로 쓸 위험은 없다. settle의 자동 판정이 있으면
// 그걸 그대로 우선한다 — 회원 스스로 신청한 exitDate가 더 정확하다.
//
// 🔧 [사용자 지시, 2026-09-10 재정정] 앱스크립트 원본(op/sh 이원 구조)을
// 다시 확인한 결과, "실제 참여상태 변경·탭 정리는 항상 현재 시트에만 쓴다"는
// 이전 설명은 틀렸다 — 원본은 관리자가 그 순간 실제로 연 파일(op, 리셋 이후
// 처리라면 지난 주 백업 파일일 수 있음)에 백업 탭·처리결과를 남기고, 고정
// ID로 연 이번 주 공유 시트(sh)에는 슬롯 청소(권한 회수·N번 리셋·데이터
// 초기화)만 별도로 적용한다. performExitReset이 이 구조를 재현한다 —
// sourceFileId(=이 함수가 반환하는 sourceFileId)가 fileId와 다르면(상황 B,
// 지난 주 백업) 백업 탭·감사 스냅샷이 그 백업 파일에 생성되고, 이번 주
// 공유 시트에서는 슬롯 청소만 일어난다. performDepositAgainReset(예치금
// 재납 확정)은 다르다 — 재납은 "지금도 활동 중인 회원"의 처리라 그 회원의
// 탭 자체가 항상 이번 주 시트에 존재하므로, sourceFileId 분리 없이 항상
// fileId만 쓴다.
async function resolveExitSourceFileId(env, accessToken, fileId, number, kind, cycleFileId) {
  if (kind === "settle") {
    // 🔧 [KV → DO 이전, 2026-09-12] §47 — LeaveQueue DO에서 조회.
    const exitRequestEntry = await getLeaveQueueStub(env)
      .fetch(`https://do/exit/get?memberNumber=${encodeURIComponent(number)}`)
      .then((r) => r.json())
      .then((d) => d.entry)
      .catch(() => null);
    if (exitRequestEntry) {
      const exitDate = exitRequestEntry.exitDate || null;
      if (exitDate && exitWeekResetPassed(exitDate)) {
        const backup = await findBackupForExitDate(env, accessToken, exitDate);
        if (!backup) {
          throw new Error("퇴실 예약 주차의 백업 시트를 아직 찾을 수 없습니다. 잠시 후 다시 시도해주세요.");
        }
        return { sourceFileId: backup.fileId, fromBackup: true };
      }
    }
  }
  if (cycleFileId) {
    const { fileId: resolvedFileId } = await resolveTargetFileId(env, accessToken, cycleFileId);
    return { sourceFileId: resolvedFileId, fromBackup: resolvedFileId !== fileId };
  }
  return { sourceFileId: fileId, fromBackup: false };
}

// 실제로 시트를 바꾸지 않고 discount_ratio/사유/결과 메시지만 계산해 돌려준다.
// 🔧 [2차 점검, 2026-09-11] Cloudflare KV 최종 일관성 재검증 — 벌점 승인
// (applyOutputPenalty)이 personalStatusBundle:을 지운 직후(승인이 실행된
// 리전에서만) 60초 내에 다른 리전 관리자가 같은 회원을 이 함수로 퇴실
// 판정하면, 그 리전의 KV 로컬 복제본엔 아직 delete가 전파되지 않아 낡은
// 페널티 상태(예: 강제퇴실 조건 미충족)를 읽고 반환금을 잘못 계산할 수
// 있음을 확인했다 — withMemberLock(뮤텍스)은 "동시 실행 순서"만 강제할
// 뿐, 락 해제 후에도 여전히 존재하는 "KV 자체의 리전 간 전파 지연"은
// 막지 못한다(뮤텍스로는 해결 안 됨을 재확인). `forceFresh`가 true면
// 퇴실 판정 직전에 이 회원의 personalStatusBundle:을 강제로 지운 뒤
// buildPersonalStatus를 호출해, 같은 요청 안에서 방금 지운 값을 그대로
// 다시 읽는(KV read-your-write는 같은 리전 내에서는 보장됨) 방식으로
// "이 판정 시점만큼은" 최대한 최신 값을 쓰도록 한다 — KV delete 자체도
// 최종 일관성 연산이라 이론상 완전한 해결은 아니지만(다른 리전의 delete가
// 이 리전에 아직 안 닿았을 가능성은 남음), §32와 동일한 수준의 실질적
// 안전장치다. 실제로 시트를 바꾸는 확정(handleAdminExitConfirm)에서만
// true로 넘긴다 — 미리보기(handleAdminExitPreview)는 다이얼로그를 열 때,
// 그리고 사유 입력 중 300ms 디바운스로 반복 호출되는 조회 전용 경로라
// 매번 강제 무효화하면 불필요한 KV delete+Sheets 재조회가 쌓인다.
// 🔧 [사용자 지시] "직권 P 사이클 오인 방지" — admin_forced는 settle과
// 달리 exitDate로 서버가 자동으로 지난 주 백업을 찾아주는 로직이 없고,
// 오직 프론트가 넘기는 cycle 파라미터에만 의존한다(resolveExitSourceFileId
// 참고). 프론트의 cycleFileId는 화면을 열면 항상 null(=이번 주)로
// 시작하므로, 관리자가 사이클 전환을 깜빡한 채 "벌금 시한 내 미납자"
// 고정 사유로 확정하면 이미 초기화됐을 수 있는 이번 주 원본을 계산
// 근거로 써버릴 위험이 있었다. 이 고정 사유일 때만, 계산 기준 시트에서
// 실제로 미납 상태인지 재검증한다 — 관리자가 자유 입력한 사유(미납과
// 무관한 처리)는 검증 대상이 아니다.
function requiresFineUnpaidRecheck(kind, forcedReason) {
  return kind === "admin_forced" && (forcedReason || "").trim() === FINE_UNPAID_ADMIN_FORCED_REASON;
}

async function computeExitResult(env, accessToken, fileId, number, name, kind, forcedReason, cycleFileId, forceFresh) {
  const { sourceFileId, fromBackup } = await resolveExitSourceFileId(env, accessToken, fileId, number, kind, cycleFileId);
  if (forceFresh) await invalidateMemberSlotCache(env, number, sourceFileId);
  const status = await buildPersonalStatus(env, accessToken, sourceFileId, number, name);
  const breakdown = status.depositRefundBreakdown;
  const process = calcExitProcess(kind, breakdown, forcedReason);
  if (!process) return null;

  const { discountRatio, resultStr, reasons } = process;
  // 집계!D23:D24(퇴실벌금/퇴실예치 누적)는 회원 개인 값이 아니라 전체
  // 스터디의 실시간 누적치이므로, 백업이 아니라 항상 원본(fileId)에서 읽는다.
  const totalSheetVals = await getSheetValues(env, accessToken, fileId, "집계!D23:D24");
  // 🔧 [파싱 불일치 수정] 같은 집계!D23:D24를 buildRosterStatus는 parseWon
  // (콤마·₩ 방어)으로 읽는데 여기는 safeNumber(Number() 그대로, 콤마 섞이면
  // NaN→0)를 써서, 혹시라도 이 셀에 천단위 구분 서식이 걸리면 금액이 조용히
  // 0으로 리셋된 채 그대로 D23/D24에 덮어써질 위험이 있었다. parseWon으로
  // 통일 — 콤마·₩ 없는 정상 케이스에서는 safeNumber와 동일하게 동작한다.
  const fineOuter = parseWon(totalSheetVals[0] && totalSheetVals[0][0]);
  const depositOuter = parseWon(totalSheetVals[0] && totalSheetVals[0][1]);
  const fineAlreadyPayment = status.weeklyTotalFine ? parseWon(status.weeklyTotalFine) : 0;

  const newFineOuter = fineOuter + fineAlreadyPayment;
  const newDepositOuter = depositOuter + EXIT_DEPOSIT_VALUE * discountRatio;

  // 🔧 2026-09: forced/admin_forced는 트리거 경로(자동 감지 vs 관리자 직접
  // 사유 입력)만 다를 뿐 결과는 항상 discountRatio=1(0% 반환)로 동일하다 —
  // "예치금 재납 대상 처리"의 강제퇴실도 결국 페널티/미납이라는 사유에
  // 의해 관리자가 확정 버튼을 눌러야만 발생하는 처리라는 점에서 직권 P와
  // 본질이 같다(사용자 판단). 두 유형을 "강제 퇴실자"로 통일하고, 실제
  // 사유는 kindStr이 아니라 resultStr/reasons(§아래 numberedReasons →
  // "📝 원인 :" 섹션, KV의 reasons 필드)에 그대로 남아 어떤 조건으로
  // 강제됐는지는 여전히 구분할 수 있다.
  // 🔧 [회귀 버그 수정] 위 통일을 discountRatio===1로 판정하면 forced/
  // admin_forced 외의 kind도 우연히 discountRatio가 1이 되는 경우 잘못
  // 걸린다 — calcAgainDeposit(deposit_again)은 납부 확인 시 항상
  // discountRatio:1을 반환하고, calcSettleReturnDeposit(settle)도 페널티
  // 1회+퇴실 통보 지연이 겹치면 discountRatio:1이 나올 수 있다(고지지연
  // 반영 버그 수정으로 새로 도달 가능해진 경로). 두 경우 모두 "강제
  // 퇴실자"가 아니라 "예치금 재납자"/"정산 퇴실자"로 남아야 하므로,
  // discountRatio가 아니라 kind로 직접 분기한다.
  const kindStr =
    kind === "forced" || kind === "admin_forced"
      ? "강제 퇴실자"
      : kind === "settle"
        ? "정산 퇴실자"
        : "예치금 재납자";
  const numberedReasons = resultStr.map((s, i) => `${String.fromCharCode(9312 + i)} ${s}`);
  const heldAmount = EXIT_DEPOSIT_VALUE * discountRatio;
  const refundAmount = EXIT_DEPOSIT_VALUE - heldAmount;
  const processedDate = todayKSTDateString();
  const resultMsg =
    `🧑 이름 : ${name}\n📝 유형 : ${kindStr}\n📝 원인 : \n${numberedReasons.join("\n")}\n` +
    `💰 귀속예치 : ₩${heldAmount.toLocaleString()}\n` +
    `💰 반환예치 : ₩${refundAmount.toLocaleString()}\n` +
    `💰 기납벌금 : ₩${fineAlreadyPayment.toLocaleString()}\n\n` +
    `📆 처리일자 : ${processedDate}\n` +
    `================================\n[집계 시트의 변동사항]\n` +
    `💰 퇴실벌금 : ₩${fineOuter.toLocaleString()} → ₩${newFineOuter.toLocaleString()}\n` +
    `💰 퇴실예치 : ₩${depositOuter.toLocaleString()} → ₩${newDepositOuter.toLocaleString()}`;

  const allChecks = kind === "forced" ? forcedExitChecks(breakdown) : [];

  // 🔧 [퇴실 프로세스 카드] "정산 퇴실자 처리" 다이얼로그의 "퇴실 프로세스"
  // 섹션(신청일자/예약일자/동의일자)에 쓰인다 — settle이 아닌 kind에서도
  // 신청 기록이 있으면(드묾) 참고용으로 함께 내려준다.
  // 🔧 [KV → DO 이전, 2026-09-12] §47 — LeaveQueue DO에서 조회.
  const exitRequestEntry = await getLeaveQueueStub(env)
    .fetch(`https://do/exit/get?memberNumber=${encodeURIComponent(number)}`)
    .then((r) => r.json())
    .then((d) => d.entry)
    .catch(() => null);
  const exitProcess = exitRequestEntry
    ? { requestedAt: exitRequestEntry.ts || null, exitDate: exitRequestEntry.exitDate || null, agreedAt: exitRequestEntry.agreedAt || null }
    : null;

  return {
    discountRatio,
    resultStr,
    reasons: reasons || [],
    allChecks,
    resultMsg,
    newFineOuter,
    newDepositOuter,
    kindStr,
    // 🔧 [미리보기 UI 개편] 프론트가 resultMsg(텔레그램용 이모지 텍스트
    // 블록)를 <pre>로 그대로 찍어 앱 UI와 어울리지 않았다(사용자 지적) —
    // 앱의 다른 다이얼로그(DepositRefundDialog 등)처럼 SubRow로 구조화해
    // 보여줄 수 있도록 개별 숫자 필드를 함께 내려준다.
    name,
    heldAmount,
    refundAmount,
    fineAlreadyPayment,
    processedDate,
    fineOuter,
    depositOuter,
    // 정산 퇴실("퇴실 처리 (정산)")도 DepositRefundDialog와 동일한 "차감
    // 원인" 카드를 보여줄 수 있도록, 그 계산에 쓰이는 원본 breakdown을
    // 그대로 함께 내려준다.
    breakdown,
    exitProcess,
    // 🔧 [백업 참조 표시] 원본이 아니라 sheet_reset 직전 자동 백업 파일에서
    // 이 회원의 지난 주 값을 읽었는지 — 프론트가 "지난 주 시트 기준" 안내를
    // 보여줄 수 있도록 함께 내려준다. sourceFileId는 handleAdminExitConfirm이
    // performExitReset에 그대로 전달해 백업 탭도 같은 소스에서 만들도록 한다.
    fromBackup,
    sourceFileId,
    // 🔧 [사용자 지시] "직권 P 사이클 오인 방지" — 위 requiresFineUnpaidRecheck
    // 참고. 계산 기준 시트(sourceFileId)에 실제 미납 기록이 없으면
    // true — 호출부(handleAdminExitPreview/handleAdminExitConfirm)가
    // 이 값을 보고 확정/미리보기 자체를 거부한다.
    fineUnpaidRecheckFailed: requiresFineUnpaidRecheck(kind, forcedReason) && !breakdown.fineUnpaid,
  };
}

async function handleAdminExitPreview(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { number, kind, forcedReason, cycle } = await req.json();
  const sheetNum = parseInt(number, 10);
  if (!sheetNum || sheetNum < 1 || sheetNum > 15 || !EXIT_KIND_VALUES.includes(kind)) {
    return json({ error: "회원번호 또는 처리 유형이 올바르지 않습니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    const members = await listAllMembers(env, accessToken, fileId);
    const member = members.find((m) => m.number === String(sheetNum));
    if (!member) return json({ error: "존재하지 않는 회원번호입니다." }, 404, origin);

    // 🔧 [미리보기는 항상 계산만 보여줌] 정산 퇴실이 실제 신청 여부와
    // 무관하게 계산 결과 자체는 항상 볼 수 있어야 한다(사용자 지적) —
    // "관리자 선택에 따라 반환율이 달라지면 안 된다"는 검증은 시트를 실제로
    // 바꾸는 확정 단계(handleAdminExitConfirm)에서만 하면 충분하고, 여기
    // (시트 불변경, 계산만)까지 막을 필요는 없다.
    // 🔧 [사용자 지시, 예외] "직권 P 사이클 오인 방지" — 위 원칙과 달리
    // 이 검증만은 미리보기 단계부터 함께 거부한다. 다이얼로그가 열리자마자
    // 자동 호출되는 이 경로에서 바로 막아야, 관리자가 "확정 처리" 버튼을
    // 눌러보기도 전에 "사이클을 잘못 보고 있다"는 걸 가장 빨리 알 수
    // 있다(사용자 확인: 미리보기·확정 동일하게 거부).
    const result = await computeExitResult(env, accessToken, fileId, member.number, member.name, kind, forcedReason, cycle);
    if (!result) {
      return json({ error: "해당 처리 유형에 해당하지 않는 회원입니다." }, 400, origin);
    }
    if (result.fineUnpaidRecheckFailed) {
      return json(
        { error: "지금 조회 중인 사이클(시트) 기준으로는 이 회원이 벌금 미납 상태가 아닙니다. 사이클을 다시 확인해주세요." },
        409,
        origin
      );
    }
    return json({ ok: true, ...result }, 200, origin);
  } catch (err) {
    return json({ error: "퇴실 처리 미리보기 실패: " + err.message }, 500, origin);
  }
}

// 앱스크립트 _append_data_audit_snapshot()을 재현한다. "데이터" 시트 행을
// 초기화하기 전에 그 시점의 값(B~V열)을 "데이터 (감사)" 시트의 첫 빈 행에
// append-only로 복사해 영구 보존한다 — B열(회원번호)이 비어 있는 첫 행을
// 찾아 그 자리에 값만 복사하고, C열(이름)은 "{이름} ({event_label})\n
// {오늘 날짜}"로 덮어써 어느 이벤트의 스냅샷인지 식별한다.
//
// 🔧 [왜 필요한가] 백업 탭("{이름} (퇴실)" 등)은 원본 시트를 copyTo로 그대로
// 복사한 사본이라, 안의 수식(C35 상점/C37 제보상점/C39 페널티 표시 등)이
// 여전히 INDIRECT("'데이터'!..." & C42)로 "데이터" 시트의 그 행을 실시간
// 참조한다. 퇴실 처리 직후 "데이터" 시트의 그 행(F~V열)은 곧바로 0으로
// 초기화되고, 나중에 같은 번호에 새 회원이 등록되면 그 행이 재사용된다 —
// 이 스냅샷/치환이 없으면 번호가 재사용되는 순간 이미 확정된 퇴실자의
// 백업 탭 수식이 새 회원의 값을 잘못 참조하게 되어 과거 기록이 조용히
// 오염된다. 반환값은 새로 채워진 감사 행 번호(1 이상) — 0이면 실패(감사
// 시트가 없거나 원본 행이 비어있음), 호출부는 이 경우 수식 치환을 건너뛴다.
async function appendDataAuditSnapshot(env, accessToken, fileId, rowNumber, name, eventLabel) {
  const AUDIT_SHEET = "데이터 (감사)";
  const sourceRow = await getSheetValues(env, accessToken, fileId, `데이터!B${rowNumber}:V${rowNumber}`).catch(
    () => []
  );
  if (!sourceRow[0]) return 0;

  // B4부터 아래로 훑어 B열(회원번호)이 비어있는 첫 행을 찾는다 — 이 시트는
  // append-only라 위에서부터 순서대로 채워져 있다는 전제(중간에 구멍이
  // 나는 삭제 동작이 없음)로, 직전 세션의 마지막 행 다음 줄을 최후
  // fallback으로 둔다. 🔧 [빈 시트 초기 상태 방어] "데이터 (감사)"가
  // 아직 한 번도 채워진 적 없으면(정상적인 초기 상태 — SHEET_STRUCTURE.md
  // 실측 당시도 그랬다) B4:B2000 조회 자체가 완전히 빈 응답이라
  // getSheetValues가 예외를 던진다 — 이 경우를 "감사 시트 없음"과 같은
  // 실패로 취급해 return 0 해버리면, 정작 첫 이벤트에서 스냅샷이 전혀
  // 안 남는 역설이 생긴다. 빈 배열로 폴백해 "B4가 바로 빈 행"으로
  // 정상 처리되게 한다.
  const bColumn = await getSheetValues(env, accessToken, fileId, `${AUDIT_SHEET}!B4:B2000`).catch(() => []);
  let targetRow = bColumn.findIndex((row) => !row[0]) + 4;
  if (targetRow === 3) targetRow = bColumn.length + 4; // findIndex가 -1이면(빈 행 없음) 맨 끝 다음 줄.

  // B~V 통째로(17열) 옮기되, C열(이름)만 이벤트 라벨로 덮어쓴다 — 원본
  // 이름 값은 애초에 라벨에 포함되므로 정보 손실 없음.
  const paddedRow = sourceRow[0].slice();
  while (paddedRow.length < 21) paddedRow.push(""); // B~V = 21개 열(sheets API가 뒤쪽 빈 칸을 잘라서 줄 수 있음).
  paddedRow[1] = `${name} (${eventLabel})\n${todayKSTDateString()}`; // C열 = index 1(B가 0).

  await writeSheetValues(env, accessToken, fileId, [
    { range: `${AUDIT_SHEET}!B${targetRow}:V${targetRow}`, values: [paddedRow] },
  ]);
  return targetRow;
}

// 백업 탭(퇴실/재납) 안의 수식 중 "데이터" 시트를 참조하는 것을 전부
// "데이터 (감사)" 참조로 치환한다 — appendDataAuditSnapshot이 반환한
// auditRow가 이제 그 회원의 스냅샷이 영구 보존되는 자리이므로, 백업 탭은
// 원본 "데이터" 행(이후 재사용될 수 있음) 대신 이 고정된 감사 행만 보도록
// 고정한다. 앱스크립트 _set_sheet_init()과 동일하게 $C$42(절대참조)를
// 먼저 치환한 뒤 남은 C42(상대참조)를 치환한다 — 순서를 바꾸면 먼저 바뀐
// C43이 두 번째 치환에서 다시 걸려 이중 치환되며 오염된다.
async function rewriteBackupAuditFormulas(env, accessToken, fileId, backupSheetName, auditRow) {
  const REPORT_ROW_CELL = "C42";
  const AUDIT_ROW_CELL = "C43";
  const formulas = await getSheetFormulas(env, accessToken, fileId, `'${backupSheetName}'!B2:W43`);
  const updates = [];
  formulas.forEach((row, r) => {
    row.forEach((cell, c) => {
      if (typeof cell !== "string" || !cell.includes("'데이터'!")) return;
      let f = cell.split("'데이터'!").join("'데이터 (감사)'!");
      f = f
        .split(`$${REPORT_ROW_CELL[0]}$${REPORT_ROW_CELL.slice(1)}`)
        .join(`$${AUDIT_ROW_CELL[0]}$${AUDIT_ROW_CELL.slice(1)}`);
      f = f.split(REPORT_ROW_CELL).join(AUDIT_ROW_CELL);
      const colLetter = colIndexToLetter(c + 1); // B2:W43 시작이 B(1)이므로 +1.
      updates.push({ range: `'${backupSheetName}'!${colLetter}${r + 2}`, values: [[f]] });
    });
  });
  if (updates.length === 0) return;
  await writeSheetValues(env, accessToken, fileId, updates);
  // C43(감사 행 계산 번호)에 실제 행 번호도 함께 기록 — 위 치환된 수식들이
  // 이 셀을 상대/절대참조로 가리키므로, 셀 자체에 실제 값이 있어야 한다.
  await writeSheetValues(env, accessToken, fileId, [
    { range: `'${backupSheetName}'!${AUDIT_ROW_CELL}`, values: [[auditRow]] },
  ]);
}

// 앱스크립트 _set_sheet_init()의 "퇴실자" 분기를 재현한다: 백업 탭 생성 후
// 원 슬롯을 template으로 리셋하고, 권한관리/제보상점/Drive 권한을 정리한다.
//
// 🔧 [사용자 지시, 2026-09-10] 앱스크립트 원본의 op/sh 이원 구조를 다시
// 들여다보면 — get_op_spreadsheet()는 "관리자가 그 순간 실제로 열어서 실행
// 중인 파일"이라, 리셋이 지난 뒤(예: 일요일 미납을 월요일 이후 처리) 관리자가
// 지난 주 백업 파일을 직접 열어 처리하면 op가 곧 그 백업 파일이 된다. 이때
// 백업 탭("{이름} (퇴실)")과 처리결과 박스는 그 op(=백업 파일) 쪽에 생성되고,
// sh(고정 ID = 이번 주 공유 시트)에는 _sunday 분기로 슬롯 청소(권한 회수·
// N번 리셋·데이터 초기화)만 별도로 적용된다 — 백업 탭은 안 만든다. 즉 "그
// 사람의 마지막 활동이 속한 시점의 파일에 결과 기록을 남기고, 현재 공유
// 시트에서는 접근 차단과 슬롯 청소만 한다"가 원래 의도였다.
//
// sourceFileId: 계산 근거이자 이제는 백업 탭의 생성 위치이기도 하다 — 보통은
// fileId와 같지만, sheet_reset이 이미 지난 뒤 정산 확정 처리를 하는 경우
// (computeExitResult의 resolveExitSourceFileId 참고) "지난 주 자동 백업
// 파일"이 되어, 백업 탭·감사 스냅샷 모두 그 백업 파일 쪽에 생성된다. 원본의
// 회원 번호 슬롯(N번 리셋)·권한 회수·데이터 시트 초기화는 sourceFileId와
// 무관하게 항상 fileId(이번 주 공유 시트)에 적용한다.
async function performExitReset(env, accessToken, fileId, member, resultMsg, kindLabel, sourceFileId) {
  const rowNumber = parseInt(member.number, 10) + 3;
  const backupName = `${member.name} (퇴실)`;
  const effectiveSourceFileId = sourceFileId || fileId;
  const backupTargetFileId = effectiveSourceFileId; // 백업 탭·감사 스냅샷의 실제 생성 위치.

  // 같은 파일이면(상황 A) ids 조회 하나에 backupName까지 함께 담아 끝내고,
  // 다른 파일이면(상황 B, 지난 주 백업) fileId 쪽은 member.number/template만,
  // backupTargetFileId(=effectiveSourceFileId) 쪽은 member.number/backupName을
  // 따로 조회한다 — 기존 백업 탭 존재 여부는 항상 backupTargetFileId 기준.
  const sameFile = effectiveSourceFileId === fileId;
  const [ids, sourceIds] = await Promise.all([
    getSheetIdsByNames(env, accessToken, fileId, sameFile ? [member.number, "template", backupName] : [member.number, "template"]),
    sameFile ? Promise.resolve(null) : getSheetIdsByNames(env, accessToken, effectiveSourceFileId, [member.number, backupName]),
  ]);
  const memberSheetId = ids[member.number];
  const templateSheetId = ids["template"];
  // 백업 탭의 원본은 sourceFileId 쪽 회원 시트 sheetId — 같은 파일이면 위에서
  // 이미 찾은 memberSheetId를 그대로 쓰고, 다른 파일(지난 주 백업)이면 그
  // 파일 안에서 따로 찾은 sheetId를 쓴다.
  const backupSourceSheetId = sourceIds ? sourceIds[member.number] : memberSheetId;
  const existingBackupId = sameFile ? ids[backupName] : sourceIds[backupName];

  if (existingBackupId !== null && existingBackupId !== undefined) {
    await spreadsheetBatchUpdate(env, accessToken, backupTargetFileId, [
      { deleteSheet: { sheetId: existingBackupId } },
    ]);
  }
  if (memberSheetId === null) throw new Error(`시트 ${member.number}를 찾을 수 없습니다.`);
  if (templateSheetId === null) throw new Error("template 시트를 찾을 수 없습니다.");
  if (backupSourceSheetId === null || backupSourceSheetId === undefined) {
    throw new Error(`백업 원본(지난 주 시트)에서 회원 ${member.number}의 탭을 찾을 수 없습니다.`);
  }

  const backupSheetId = await copySheetToSpreadsheet(
    env,
    accessToken,
    effectiveSourceFileId,
    backupSourceSheetId,
    backupTargetFileId,
    backupName
  );
  await writeExitResultBox(env, accessToken, backupTargetFileId, backupSheetId, resultMsg);

  // 🔧 [데이터 감사] "데이터" 원본 행을 초기화하기 전에, 그 시점의 값을
  // "데이터 (감사)"에 스냅샷으로 남기고, 백업 탭의 수식이 원본 대신 이
  // 감사 행을 보도록 통째 치환한다 — appendDataAuditSnapshot 주석 참고
  // (앱스크립트 _set_sheet_init()의 동작을 그대로 재현, 2026-09 추가:
  // 원래 웹 경로엔 이 로직이 없어 번호가 재사용되면 백업 탭 수식이
  // 새 회원 값을 잘못 참조할 위험이 있었다).
  //
  // 🔧 [백업 파일 분리, 2026-09-10] 백업 탭이 backupTargetFileId(지난 주
  // 백업 파일일 수 있음)에 생성되므로, 감사 스냅샷도 같은 파일의 "데이터"/
  // "데이터 (감사)"에 남겨야 백업 탭 수식(INDIRECT 참조)이 실제로 존재하는
  // 자리를 가리킨다 — fileId(이번 주 시트)에 남기면 그 파일엔 애초에 이
  // rowNumber의 원본 행이 이미 초기화되어 있거나(재사용 전) 다른 회원 값이
  // 들어있어(재사용 후) 스냅샷 자체가 무의미해진다.
  const auditRow = await appendDataAuditSnapshot(
    env,
    accessToken,
    backupTargetFileId,
    rowNumber,
    member.name,
    "퇴실"
  ).catch(() => 0);
  if (auditRow > 0) {
    await rewriteBackupAuditFormulas(env, accessToken, backupTargetFileId, backupName, auditRow).catch(() => {});
  }

  const ownerEmail = env.ADMIN_EMAIL;
  await protectSheetForOwnerAndService(env, accessToken, backupTargetFileId, backupSheetId, ownerEmail);

  await spreadsheetBatchUpdate(env, accessToken, fileId, [{ deleteSheet: { sheetId: memberSheetId } }]);
  const newSheetId = await copySheetWithName(env, accessToken, fileId, templateSheetId, member.number);

  // 🔧 [데이터 시트 통합] C38(옛 "제보상점 시트 행 번호") → C42("참조 행 계산
  // 번호"). B2 문구도 이번 개편에서 "📝 {번호}번's 대시보드 📝" 형식으로 통일됨.
  await writeSheetValues(env, accessToken, fileId, [
    { range: `${member.number}!C42`, values: [[rowNumber]] },
    { range: `${member.number}!B2`, values: [[`📝 ${member.number}번's 대시보드 📝`]] },
  ]);

  // 🔧 [데이터 시트 통합] "권한관리"(D=이메일,H=시험종류)+"제보상점"(D~J=요일별)
  // 이 "데이터" 한 탭(D=이메일,E=준비시험,F~V=송출P/주간P/사유반휴/제보상점
  // 슬롯)으로 합쳐졌다. 퇴실 시 D~V 전체를 초기화한다. (위 감사 스냅샷이
  // 이 초기화 직전 값을 이미 별도로 보존했다.)
  const authRows = await getSheetValues(env, accessToken, fileId, `데이터!D${rowNumber}:D${rowNumber}`);
  const memberEmailRaw = (authRows[0] && authRows[0][0]) || "";
  // 🔧 [회귀 버그 수정, 2026-09] D열은 "구글계정,구루미계정" 콤보 원본
  // 그대로다(parseGoogleEmail 주석 참고) — revokeSheetAccess는 Drive
  // 권한 목록의 순수 이메일과 정확 일치 비교를 하므로, 콤마 섞인 원본을
  // 그대로 넘기면 구루미 계정이 함께 저장된(사실상 항상 그런) 모든
  // 회원에서 비교가 절대 일치하지 않아 Drive 편집 권한 회수가 조용히
  // 실패하고 있었다 — parseGoogleEmail로 이메일만 뽑아 넘긴다.
  const memberEmail = parseGoogleEmail(memberEmailRaw);
  await writeSheetValues(env, accessToken, fileId, [
    { range: `데이터!D${rowNumber}:E${rowNumber}`, values: [["", ""]] },
    { range: `데이터!F${rowNumber}:V${rowNumber}`, values: [Array(17).fill(0)] },
  ]);
  await revokeSheetAccess(env, fileId, memberEmail);
  await protectSheetForOwnerAndService(env, accessToken, fileId, newSheetId, ownerEmail);
  await invalidateMemberCache(env, ["roster"]); // 이메일이 비워져 명단이 바뀌었으므로 전체 무효화.
  // 이 번호가 곧바로 다른 신규 회원에게 재배정될 수 있으므로, 퇴실한 회원의
  // 벌점/제보상점 KV 캐시가 새 회원에게 노출되지 않도록 함께 지운다.
  await invalidateMemberSlotCache(env, member.number);

  // 🔧 [블랙리스트 계정 저장] 확정 처리(handleAdminExitConfirm)가 이 값을
  // exitResult 결과에 함께 담아, "신규 스터디원 등록" 화면이
  // 블랙리스트 등록된 계정 재입력을 감지할 수 있게 한다(사용자 지시) —
  // 초기화 직전에만 D열 원본을 읽을 수 있으므로 여기서 뽑아 반환해야 한다.
  return { googleAccount: memberEmail, gooroomeeAccount: parseGooroomeeAccount(memberEmailRaw) };
}

// 앱스크립트 _set_sheet_init()의 "재납자" 분기를 재현한다: 이름(B2)과
// 목표시간(O3)은 보존한 채, 가입일자/참여상태를 새로 기록하고 나머지는 리셋한다.
// 백업 탭 이름에 타임스탬프를 붙여 매번 새 탭으로 남긴다 — 같은 주 안에 같은
// 회원이 두 번 이상 재납되는 극희소 케이스에도 이전 스냅샷이 덮어써지지 않고
// 웹 대시보드(재납 전/후 분리 조회)가 각 스냅샷을 모두 조회할 수 있게 하기 위함.
async function performDepositAgainReset(env, accessToken, fileId, member, resultMsg) {
  const rowNumber = parseInt(member.number, 10) + 3;
  const backupName = `${member.name} (재납 ${Date.now()})`;

  const ids = await getSheetIdsByNames(env, accessToken, fileId, [member.number, "template"]);
  const memberSheetId = ids[member.number];
  const templateSheetId = ids["template"];

  if (memberSheetId === null) throw new Error(`시트 ${member.number}를 찾을 수 없습니다.`);
  if (templateSheetId === null) throw new Error("template 시트를 찾을 수 없습니다.");

  const backupSheetId = await copySheetWithName(env, accessToken, fileId, memberSheetId, backupName);
  await writeExitResultBox(env, accessToken, fileId, backupSheetId, resultMsg);

  // 🔧 [데이터 감사] 퇴실과 동일한 이유로, 재납도 F~V열을 초기화하기 전에
  // "데이터 (감사)"에 스냅샷을 남기고 백업 탭 수식을 그 감사 행으로 치환한다
  // (performExitReset 쪽 appendDataAuditSnapshot 주석 참고).
  const auditRow = await appendDataAuditSnapshot(env, accessToken, fileId, rowNumber, member.name, "재납").catch(
    () => 0
  );
  if (auditRow > 0) {
    await rewriteBackupAuditFormulas(env, accessToken, fileId, backupName, auditRow).catch(() => {});
  }

  const ownerEmail = env.ADMIN_EMAIL;
  await protectSheetForOwnerAndService(env, accessToken, fileId, backupSheetId, ownerEmail);

  const [b2Rows, o3Rows] = await Promise.all([
    getSheetValues(env, accessToken, fileId, `${member.number}!B2`),
    getSheetValues(env, accessToken, fileId, `${member.number}!O3`),
  ]);
  const backupB2 = (b2Rows[0] && b2Rows[0][0]) || "";
  const backupO3 = (o3Rows[0] && o3Rows[0][0]) || "";

  await spreadsheetBatchUpdate(env, accessToken, fileId, [{ deleteSheet: { sheetId: memberSheetId } }]);
  const newSheetId = await copySheetWithName(env, accessToken, fileId, templateSheetId, member.number);

  const today = todayKSTDateString();
  await writeSheetValues(env, accessToken, fileId, [
    // 🔧 [데이터 시트 통합] C38(옛 "제보상점 시트 행 번호") → C42("참조 행 계산
    // 번호"). "제보상점" D~J 초기화도 "데이터" F~V로 이동 — appscript.js
    // 재납 분기와 동일하게 이메일(D)·시험유형(E)은 유지하고 F~V만 초기화한다.
    // (위 감사 스냅샷이 이 초기화 직전 값을 이미 별도로 보존했다.)
    { range: `${member.number}!C42`, values: [[rowNumber]] },
    { range: `${member.number}!B2`, values: [[backupB2]] },
    { range: `${member.number}!I2`, values: [[today]] },
    { range: `${member.number}!L3`, values: [["스터디원"]] },
    { range: `${member.number}!O3`, values: [[backupO3]] },
    { range: `데이터!F${rowNumber}:V${rowNumber}`, values: [Array(17).fill(0)] },
  ]);
  await protectSheetForOwnerAndService(env, accessToken, fileId, newSheetId, ownerEmail);
  await invalidateMemberCache(env, ["roster"]); // 시트가 재생성되어 sheetId(meta)가 바뀌었으므로 전체 무효화.
}

async function handleAdminExitConfirm(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { number, kind, forcedReason, blacklist, cycle } = await req.json();
  const sheetNum = parseInt(number, 10);
  if (!sheetNum || sheetNum < 1 || sheetNum > 15 || !EXIT_KIND_VALUES.includes(kind)) {
    return json({ error: "회원번호 또는 처리 유형이 올바르지 않습니다." }, 400, origin);
  }
  // 🔧 [블랙리스트 등록] 직권 P(admin_forced)에서만 의미 있는 값 — 다른
  // kind로 넘어와도 무시하고 항상 false로 저장한다(상대 동의 없이 즉시
  // 내쫓는 가장 강한 강제퇴실에만 해당되는 개념이라는 사용자 지시).
  const isBlacklisted = kind === "admin_forced" && blacklist === true;

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    const members = await listAllMembers(env, accessToken, fileId);
    const member = members.find((m) => m.number === String(sheetNum));
    if (!member) return json({ error: "존재하지 않는 회원번호입니다." }, 404, origin);

    // 🔧 [동의 없이 확정 처리하는 경로 차단] 프론트가 "동의합니다"를 누르기
    // 전엔 관리자 쪽 "정산" 버튼 자체를 비활성화해두지만(사용자 지시), API를
    // 직접 호출하는 경로까지 막기 위해 서버에서도 신청+동의 여부를 함께
    // 확인한다. confirm을 preview 없이 직접 호출하는 경로도 막아야 하므로
    // 여기서 다시 확인한다.
    if (kind === "settle") {
      // 🔧 [KV → DO 이전, 2026-09-12] §47 — LeaveQueue DO에서 조회.
      const exitRequestEntry = await getLeaveQueueStub(env)
        .fetch(`https://do/exit/get?memberNumber=${encodeURIComponent(member.number)}`)
        .then((r) => r.json())
        .then((d) => d.entry)
        .catch(() => null);
      if (!exitRequestEntry) {
        return json({ error: "퇴실 신청이 접수되지 않은 회원은 정산 퇴실로 처리할 수 없습니다." }, 400, origin);
      }
      if (!exitRequestEntry.agreedAt) {
        return json({ error: "회원이 예치금 정산액에 동의하지 않아 정산 퇴실로 처리할 수 없습니다." }, 400, origin);
      }
    }

    // 🔧 [사유 필수는 확정 단계에서만] calcAdminForcedExit는 미리보기가
    // 사유 없이도 계산을 보여줄 수 있도록 사유 검증을 하지 않는다 — 실제
    // 시트를 바꾸는 이 확정 단계에서 대신 검증한다(프론트도 "확정 처리"
    // 버튼을 forcedReason.trim()으로 막지만, API 직접 호출까지 방어).
    if (kind === "admin_forced" && !(forcedReason || "").trim()) {
      return json({ error: "직권 퇴실 사유를 입력해야 확정 처리할 수 있습니다." }, 400, origin);
    }

    // forceFresh: true — 실제로 시트를 바꾸는 확정 경로라 §computeExitResult
    // 주석 참고, 판정 직전 캐시를 강제로 재계산해 리전 간 KV 전파 지연으로
    // 인한 오판정 위험을 최대한 줄인다.
    const result = await computeExitResult(env, accessToken, fileId, member.number, member.name, kind, forcedReason, cycle, true);
    if (!result) {
      return json({ error: "해당 처리 유형에 해당하지 않는 회원입니다." }, 400, origin);
    }
    // 🔧 [사용자 지시] "직권 P 사이클 오인 방지" — §computeExitResult의
    // requiresFineUnpaidRecheck 참고. 미리보기(handleAdminExitPreview)에도
    // 동일한 검증이 있지만, API를 직접 호출해 preview 없이 confirm만
    // 부르는 경로까지 방어하기 위해 이 확정 단계에서도 다시 확인한다.
    if (result.fineUnpaidRecheckFailed) {
      return json(
        { error: "지금 조회 중인 사이클(시트) 기준으로는 이 회원이 벌금 미납 상태가 아닙니다. 사이클을 다시 확인해주세요." },
        409,
        origin
      );
    }

    const statusLabel =
      result.discountRatio === 0
        ? "퇴실자 (100% 반환)"
        : result.discountRatio === 0.5
          ? "퇴실자 (50% 반환)"
          : kind === "deposit_again"
            ? "재납자 (0% 반환)"
            : "퇴실자 (0% 반환)";

    await writeSheetValues(env, accessToken, fileId, [
      { range: `${member.number}!L3`, values: [[statusLabel]] },
      { range: "집계!D23", values: [[result.newFineOuter]] },
      { range: "집계!D24", values: [[result.newDepositOuter]] },
    ]);

    if (kind === "deposit_again") {
      await performDepositAgainReset(env, accessToken, fileId, member, result.resultMsg);
    } else {
      const exitAccounts = await performExitReset(
        env,
        accessToken,
        fileId,
        member,
        result.resultMsg,
        result.kindStr,
        result.sourceFileId
      );
      // 🔧 [퇴실 처리 결과 영구 보존] "퇴실 스터디원 목록"이 반환 예치금/
      // 차감 원인/처리 결과/퇴실유형을 구조화된 카드로 보여줄 수 있도록,
      // 백업 탭 이름을 키로 저장한다(재납은 다시 정상 명단으로 복귀하므로
      // 대상 아님). 🔧 [KV → DO 이전, 2026-09-12] §49 — MemberSettingsDO로 이전.
      const backupName = `${member.name} (퇴실)`;
      await getMemberSettingsStub(env)
        .fetch("https://do/exit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: backupName,
            entry: {
              kind,
              kindStr: result.kindStr,
              refundAmount: result.refundAmount,
              heldAmount: result.heldAmount,
              fineAlreadyPayment: result.fineAlreadyPayment,
              breakdown: result.breakdown,
              reasons: result.reasons,
              processedDate: result.processedDate,
              blacklist: isBlacklisted,
              // 🔧 [블랙리스트 계정 대조] "신규 스터디원 등록"이 이 계정으로
              // 재등록을 시도하는지 감지할 수 있도록 함께 저장한다 — 블랙리스트
              // 여부와 무관하게 항상 채워두면, 이후 "퇴실 스터디원 목록"에서
              // 블랙리스트를 뒤늦게 켜도(§블랙리스트 토글) 계정 정보가 이미
              // 있어 곧바로 대조 대상이 된다.
              googleAccount: exitAccounts?.googleAccount || "",
              gooroomeeAccount: exitAccounts?.gooroomeeAccount || "",
            },
          }),
        })
        .catch(() => {});
    }
    // 실제 처리가 확정됐으니 "퇴실 예약" 신청 표시도 함께 정리한다 — 시트가
    // 이미 초기화된 회원 번호에 예약 뱃지만 남아있으면 혼동을 준다.
    await getLeaveQueueStub(env).fetch("https://do/exit/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberNumber: member.number }),
    });
    await invalidateMemberCache(env, ["roster"]); // 참여상태/페널티 슬롯/시트 구조가 모두 바뀌었으므로 전체 무효화.

    return json({ ok: true, number: member.number, name: member.name, resultMsg: result.resultMsg }, 200, origin);
  } catch (err) {
    return json({ error: "퇴실 처리 확정 실패: " + err.message }, 500, origin);
  }
}

// "퇴실 스터디원 목록"의 블랙리스트 등록/해제 토글(§ExitedMemberList) — 확정
// 처리 시점을 놓쳤거나(forced/settle은 애초에 체크박스가 없었음) 판단을 나중에
// 바꾼 경우를 위해, 이미 저장된 exitResult의 blacklist 필드만 뒤늦게
// 덮어쓴다. 토글이 아니라 프론트가 계산한 목표값을 명시적으로 보내게
// 해(다음 상태를 서버가 추측하지 않음) 중복 클릭으로 두 번 반전되는 사고를
// 피한다. 🔧 [KV → DO 이전, 2026-09-12] §49 — MemberSettingsDO의
// /exit/patch가 get+merge+put을 원자적으로 처리한다.
async function handleAdminExitBlacklist(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { name, blacklist } = await req.json();
  if (!name || typeof name !== "string" || typeof blacklist !== "boolean") {
    return json({ error: "대상 이름 또는 블랙리스트 값이 올바르지 않습니다." }, 400, origin);
  }

  try {
    const res = await getMemberSettingsStub(env).fetch("https://do/exit/patch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, patch: { blacklist } }),
    });
    if (res.status === 404) {
      return json(
        { error: "처리 결과를 조회할 수 없는 회원은 블랙리스트를 변경할 수 없습니다(이 기능 도입 이전 처리)." },
        404,
        origin
      );
    }
    return json({ ok: true, name, blacklist }, 200, origin);
  } catch (err) {
    return json({ error: "블랙리스트 변경 실패: " + err.message }, 500, origin);
  }
}

// "신규 스터디원 등록"(NewMemberForm)이 입력 중인 구글/구루미 계정을 실시간
// 대조할 수 있도록, 블랙리스트로 등록된 퇴실자의 계정만 뽑아 가벼운 목록으로
// 내려준다(사용자 지시) — ExitedMemberList처럼 반환액/차감원인 같은 상세
// 데이터까지 함께 내려줄 필요는 없어 별도 엔드포인트로 분리했다. 이 기능
// 도입(2026-09) 이전에 처리된 블랙리스트 등록자는 계정 정보가 저장되지
// 않았으므로 대조 대상에 포함되지 않는다(§handleAdminExitBlacklist 주석 참고
// — 처리 결과 자체가 없으면 blacklist를 뒤늦게 켤 수도 없다).
// 🔧 [KV → DO 이전, 2026-09-12] §49 — /exit/list 1회 호출로 대체.
async function handleAdminBlacklist(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    const exitedMembers = await listExitedMemberEntries(env, accessToken, fileId);

    const resultsRes = await getMemberSettingsStub(env).fetch("https://do/exit/list");
    const { items: allResults } = await resultsRes.json();
    const results = exitedMembers.map((m) => (allResults[m.name] ? { name: m.name, ...allResults[m.name] } : null));

    const entries = results
      .filter((r) => r && r.blacklist === true)
      .map((r) => ({
        name: r.name,
        googleAccount: r.googleAccount || "",
        gooroomeeAccount: r.gooroomeeAccount || "",
      }));

    return json({ entries }, 200, origin);
  } catch (err) {
    return json({ error: "블랙리스트 조회 실패: " + err.message }, 500, origin);
  }
}

// --- 관리자 전용: Drive 위임 OAuth 연동 (1회 설정) ---
// 브라우저에서 여는 링크라 Authorization 헤더를 못 쓰므로, 세션 토큰을
// 쿼리 파라미터로 검증한다.

async function requireAdminFromQuery(req, env, url) {
  const token = url.searchParams.get("token") || "";
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return null;
  if (session.email !== (env.ADMIN_EMAIL || "").toLowerCase()) return null;
  return session;
}

async function handleAdminOAuthAuthorize(req, env, origin, url) {
  const admin = await requireAdminFromQuery(req, env, url);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", env.ADMIN_OAUTH_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", adminOAuthRedirectUri(env));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", ADMIN_OAUTH_SCOPE);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("login_hint", admin.email);

  return Response.redirect(authUrl.toString(), 302);
}

async function handleAdminOAuthCallback(req, env, origin, url) {
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) return new Response(`연동 실패: ${error}`, { status: 400 });
  if (!code) return new Response("code 파라미터가 없습니다.", { status: 400 });

  try {
    const tokenData = await exchangeAdminOAuthCode(env, code);
    await getBotAdminConfigStub(env).fetch("https://do/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: ADMIN_OAUTH_CONFIG_KEY, value: tokenData.refresh_token }),
    });
    return new Response(
      "관리자 위임 인증이 완료되었습니다. 이 탭을 닫고 앱으로 돌아가세요.",
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  } catch (err) {
    return new Response("연동 실패: " + err.message, { status: 500 });
  }
}

// --- 관리자 전용: 신규 스터디원 등록 ---
// 앱스크립트 _set_new_member/_set_sheet_init(신규회원 분기)를 REST API로 재현한다.
// 1~15번 시트는 항상 미리 만들어져 있으므로(템플릿 복사 불필요), 권한관리 탭에
// 이메일이 비어 있는 번호를 "빈 자리"로 간주해 그 번호의 개인 탭을 초기화한다.
// 시트 자체의 보호(protect)는 template에서 상속되어 이미 걸려 있어 재설정하지 않는다.

async function handleAdminOpenSlots(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    // 🔧 [캐싱 통합, 2026-09] listAllMembers/handleAdminMembersRoster와 같은
    // 원본(데이터!A1:V50)을 매번 직접 다시 읽고 있었다 — getDataSheetRows
    // (members:와 동일한 10분 TTL·roster 무효화 그룹)로 교체한다. 이 화면은
    // "폼을 여는 순간의 스냅샷"으로만 쓰이고(재조회 없음) 신규 등록 처리
    // (handleAdminCreateMember) 쪽에 최종 이메일 배정 여부를 다시 검증하는
    // 별도 안전장치가 있어, 최대 10분 지연된 스냅샷을 보여줘도 실제 등록
    // 단계에서 최신 상태로 재확인된다.
    const rows = await getDataSheetRows(env, accessToken, env.GOOGLE_SHEET_FILE_ID);
    const slots = [];
    for (const row of rows) {
      const num = (row[1] || "").trim();
      const email = (row[3] || "").trim();
      if (num && /^\d+$/.test(num) && !email) slots.push(num);
    }
    slots.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    return json({ slots }, 200, origin);
  } catch (err) {
    return json({ error: "빈 자리 조회 실패: " + err.message }, 500, origin);
  }
}

// "데이터" 탭의 점유/공백 슬롯을 읽어 "빈 자리를 앞으로 당겨 채우는" 이동
// 계획을 계산한다. 점유 슬롯을 번호 오름차순으로 나열해 1번부터 빈틈없이
// 다시 배정하고, 이미 제자리인 슬롯(현재번호 === 목표번호)은 계획에서 뺀다.
async function computeMemberReorderPlan(env, accessToken) {
  const fileId = env.GOOGLE_SHEET_FILE_ID;
  const rows = await getSheetValues(env, accessToken, fileId, "데이터!A1:V50");

  const occupied = [];
  for (const row of rows) {
    const num = (row[1] || "").trim();
    const name = (row[2] || "").trim();
    const email = (row[3] || "").trim();
    if (!num || !/^\d+$/.test(num)) continue;
    if (email) occupied.push({ number: num, name });
  }
  occupied.sort((a, b) => parseInt(a.number, 10) - parseInt(b.number, 10));

  // 목표 번호는 단순히 점유 슬롯을 원래 번호 순서대로 나열해 1번부터 다시
  // 매긴 것 — 빈 슬롯은 건너뛸 뿐 목표 번호 계산에 관여하지 않는다.
  const plan = [];
  occupied.forEach((o, idx) => {
    const from = parseInt(o.number, 10);
    const to = idx + 1;
    if (to !== from) {
      plan.push({ from: String(from), to: String(to), name: o.name });
    }
  });
  return plan;
}

async function handleAdminMemberReorderPreview(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const plan = await computeMemberReorderPlan(env, accessToken);
    return json({ plan }, 200, origin);
  } catch (err) {
    return json({ error: "이동 계획 계산 실패: " + err.message }, 500, origin);
  }
}

// 번호 from(점유 중)을 번호 to(빈 자리)로 옮긴다. 셀을 하나하나 복사하는 대신
// 탭 이름 자체를 바꿔치기해서 개인 탭의 모든 데이터(출석/타이머 기록, 수식)를
// 그대로 보존한다. performExitReset과 동일한 삭제+template 복사 패턴을 쓴다.
async function moveMemberSlot(env, accessToken, fileId, ownerEmail, from, to, oneIndex) {
  const ids = await getSheetIdsByNames(env, accessToken, fileId, [to, from, "template"]);
  const emptySheetId = ids[to];
  const occupiedSheetId = ids[from];
  const templateSheetId = ids["template"];
  if (emptySheetId === null) throw new Error(`시트 ${to}를 찾을 수 없습니다.`);
  if (occupiedSheetId === null) throw new Error(`시트 ${from}를 찾을 수 없습니다.`);
  if (templateSheetId === null) throw new Error("template 시트를 찾을 수 없습니다.");

  // "1"번 탭의 배치 시작 시점 위치(oneIndex)를 기준으로 N번 탭의 올바른
  // 위치를 oneIndex + (N-1)로 계산해 매번 그 자리에 명시적으로 배치한다
  // (이름만 바꾸면 원래 위치에 그대로 남아 탭 순서가 어긋난다). "1"번은
  // 가장 작은 번호라 이 로직에서 from이 될 수 없어 안정적인 기준점이다.
  const toIndex = oneIndex + parseInt(to, 10) - 1;
  const fromIndex = oneIndex + parseInt(from, 10) - 1;

  // 1. 빈 자리(to) 탭 삭제 — 실행 직전 재확인한 빈 슬롯이므로 내용 보존 불필요.
  await spreadsheetBatchUpdate(env, accessToken, fileId, [{ deleteSheet: { sheetId: emptySheetId } }]);

  // 2. 점유 중이던 탭(from)의 이름과 위치를 to로 변경 — 안의 모든 데이터가 그대로 이동.
  await spreadsheetBatchUpdate(env, accessToken, fileId, [
    {
      updateSheetProperties: {
        properties: { sheetId: occupiedSheetId, title: to, index: toIndex },
        fields: "title,index",
      },
    },
  ]);

  // 3. 비워진 from 번호에 template을 복사해 "1~15번은 항상 존재" 불변식을 유지.
  // template 원본의 B2는 자체 placeholder 텍스트("0번" 등)를 그대로 담고
  // 있으므로, performExitReset과 동일하게 번호 기준 문구로 다시 써야 한다
  // (빠뜨리면 집계 탭에 "0번"으로 잘못 표시됨). copySheetWithName이 이름과
  // 숨김 해제까지 처리하고, 위치는 여기서 별도로 바로잡는다.
  const newSheetId = await copySheetWithName(env, accessToken, fileId, templateSheetId, from);
  await spreadsheetBatchUpdate(env, accessToken, fileId, [
    { updateSheetProperties: { properties: { sheetId: newSheetId, index: fromIndex }, fields: "index" } },
  ]);
  await protectSheetForOwnerAndService(env, accessToken, fileId, newSheetId, ownerEmail);

  const fromRow = parseInt(from, 10) + 3;
  const toRow = parseInt(to, 10) + 3;

  // 🔧 [데이터 시트 통합] template 원본의 C42("참조 행 계산 번호", 옛 C38)도
  // B2처럼 고정된 placeholder 값을 담고 있어, 새로 만든 from 탭에도 자기
  // 번호 기준 행 번호로 다시 써야 한다(빠뜨리면 template의 값을 그대로
  // 물려받아 엉뚱한 "데이터" 행을 가리키게 된다). B2 문구도 새 형식으로 통일.
  await writeSheetValues(env, accessToken, fileId, [
    { range: `${from}!B2`, values: [[`📝 ${from}번's 대시보드 📝`]] },
    { range: `${from}!C42`, values: [[fromRow]] },
  ]);

  // 4. 이동된 탭의 "참조 행 계산 번호"(C42)를 새 번호 기준으로 갱신.
  await writeSheetValues(env, accessToken, fileId, [{ range: `${to}!C42`, values: [[toRow]] }]);

  // 5. 🔧 [데이터 시트 통합] "권한관리"+"제보상점"이 "데이터" 한 탭(D=이메일,
  // E=준비시험, F~V=송출P·주간P·사유반휴·제보상점 슬롯)으로 합쳐졌다.
  // from행의 D~V를 통째로 to행으로 옮기고 from행은 이메일/시험은 비우고
  // 나머지 슬롯은 0으로 초기화한다.
  const dataRows = await getSheetValues(env, accessToken, fileId, `데이터!D${fromRow}:V${fromRow}`);
  const dataValues = dataRows[0] || ["", "", ...Array(17).fill(0)];
  await writeSheetValues(env, accessToken, fileId, [
    { range: `데이터!D${toRow}:V${toRow}`, values: [dataValues] },
    { range: `데이터!D${fromRow}:E${fromRow}`, values: [["", ""]] },
    { range: `데이터!F${fromRow}:V${fromRow}`, values: [Array(17).fill(0)] },
  ]);
  await invalidateMemberCache(env, ["roster"]); // 번호별 이메일이 이동/재생성되어 명단과 sheetId가 바뀌었으므로 전체 무효화.
  // to는 from의 벌점/제보상점 값을 새로 물려받았고 from은 곧 신규 회원에게
  // 재배정될 수 있으므로, 두 번호 모두 옛 캐시가 남지 않도록 함께 지운다.
  await Promise.all([invalidateMemberSlotCache(env, from), invalidateMemberSlotCache(env, to)]);
}

// 🔧 [2차 점검, 2026-09-11] moveMemberSlot이 탭 삭제→이름변경→위치조정 등
// 여러 단계를 락 없이 순차 실행해, 관리자 두 명이 "정렬 실행"을 거의
// 동시에 누르면 서로 다른 시점의 계획(plan)으로 같은 탭을 건드려 시트
// 구조가 절반만 이동된 채 깨질 위험이 있었다(경쟁 조건 재검증 완료).
// 개별 이동 단계가 아니라 요청 전체(plan 재계산부터 전체 이동 완료까지)를
// withMemberLock으로 감싼다 — 정렬 도중 다른 정렬 요청이 끼어들면 더
// 위험하므로 배치 전체를 하나의 임계구역으로 다룬다. "reorder:" 접두어라
// 신규 등록("newmember:")/벌점 승인("pen:"/"merit:")과는 무관하게
// 독립적으로 직렬화된다. 정렬은 관리자가 명시적으로 트리거하는 드문 배치
// 작업이라 전역 직렬화의 체감 비용은 낮다.
async function handleAdminMemberReorder(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const fileId = env.GOOGLE_SHEET_FILE_ID;
  const moved = [];
  try {
    const accessToken = await getServiceAccountAccessToken(env);
    await withMemberLock(env, `reorder:${fileId}`, async () => {
      // 클라이언트가 미리보기 이후 시간이 지나 상태가 바뀌었을 수 있으므로,
      // 클라이언트가 보낸 계획을 신뢰하지 않고 서버에서 다시 계산한다.
      const plan = await computeMemberReorderPlan(env, accessToken);

      // "1"번 탭의 위치를 배치 전체에서 딱 한 번만 조회해 고정 기준점으로 쓴다.
      // "1"번은 가장 작은 번호라 이 로직의 from(이동 대상)이 될 수 없어
      // 배치 도중 계속 안정적이다("집계"와 "1" 사이에 숨겨진 다른 탭이
      // 있을 가능성까지 감안해, 그 사이 간격을 가정하지 않고 "1" 자체의
      // 실측 위치를 직접 기준으로 삼는다).
      const sheets = await getSpreadsheetMeta(env, accessToken, fileId);
      const oneSheet = sheets.find((s) => s.title === "1");
      if (!oneSheet) throw new Error("1번 탭을 찾을 수 없습니다.");
      const oneIndex = oneSheet.index;

      for (const step of plan) {
        await moveMemberSlot(env, accessToken, fileId, env.ADMIN_EMAIL, step.from, step.to, oneIndex);
        moved.push(step);
      }
    });
    return json({ ok: true, moved }, 200, origin);
  } catch (err) {
    return json({ ok: false, moved, error: err.message }, 500, origin);
  }
}

async function handleAdminCreateMember(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { number, name, email, gooroomeeAccount, goalHours, goalKind, examKind, joinDate } = await req.json();
  const sheetNum = parseInt(number, 10);
  if (!sheetNum || sheetNum < 1 || sheetNum > 15) {
    return json({ error: "시트번호는 1~15 사이여야 합니다." }, 400, origin);
  }
  if (!name || !email || !goalHours || !goalKind) {
    return json({ error: "이름, 이메일, 의무시간, 타입은 필수입니다." }, 400, origin);
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return json({ error: "이메일 형식이 올바르지 않습니다." }, 400, origin);
  }
  if (gooroomeeAccount && !/^\S+@\S+\.\S+$/.test(gooroomeeAccount)) {
    return json({ error: "구루미 계정 이메일 형식이 올바르지 않습니다." }, 400, origin);
  }
  // 콤마는 D열에서 구글계정/구루미계정을 나누는 구분자로 예약돼 있어, 둘 중
  // 어느 쪽 값에도 콤마가 섞이면 파싱이 깨진다.
  if (email.includes(",") || (gooroomeeAccount || "").includes(",")) {
    return json({ error: "이메일/구루미 계정에는 쉼표를 포함할 수 없습니다." }, 400, origin);
  }
  // 🔧 [첫 참여일 설정] 등록 시점보다 앞으로 최대 일주일 뒤부터 실제 참여를
  // 시작할 회원의 시작일(I2, "가입일")을 미리 정확히 반영할 수 있도록
  // 프론트에서 날짜를 입력받는다 — 오늘로 고정하면 D+N/"30일 미만 참여자"
  // 판정이 실제 시작일보다 이르게 잡혀 등록 직후 예치금 반환 계산이
  // 어긋난다. 프론트가 이미 min/max로 오늘~일주일 뒤 범위 밖을 못 고르게
  // 막지만, API를 직접 호출하는 경로까지 막기 위해 서버에서도 다시
  // 검증한다 — 미지정이면 오늘로 대체한다.
  const todayKST = todayKSTDateString();
  const latestJoinDate = kstDateOffsetString(6);
  if (joinDate && (!/^\d{4}-\d{2}-\d{2}$/.test(joinDate) || joinDate < todayKST || joinDate > latestJoinDate)) {
    return json({ error: "첫 참여일은 오늘부터 일주일 이내여야 합니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;

    // 🔧 [2차 점검, 2026-09-11] "빈 번호 찾기 → 그 번호에 쓰기"가 읽기-수정-
    // 쓰기(read-modify-write) 구조라, 관리자 두 명이 거의 동시에 등록하면
    // 둘 다 같은 "빈 번호"를 통과해 나중 쓰기가 먼저 등록된 회원을 완전히
    // 덮어써 데이터가 소실될 수 있었다(경쟁 조건 재검증 완료). 대상 회원
    // 번호가 아직 정해지지 않은 단계라 applyOutputPenalty/applyReportMerit
    // 처럼 회원 단위 락을 걸 수 없으므로, 이 fileId(사실상 단일 시트)의
    // 신규 등록 전체를 직렬화하는 전역 락을 쓴다 — "pen:"/"merit:" 접두어와
    // 겹치지 않아 벌점 승인과는 무관하고, 신규 등록은 애초에 드문 관리자
    // 조작이라 직렬화로 인한 체감 지연도 거의 없다. withMemberLock은 락
    // 획득 자체가 실패해도(DO 장애 등) 잠금 없이 그냥 진행하는 "레이스를
    // 줄이는" 안전장치일 뿐이라(§withMemberLock 주석), 승인 흐름이 락 때문에
    // 완전히 막히지는 않는다.
    // 락 콜백 안에서 검증 실패를 던지면 withMemberLock의 finally(release)
    // 순서가 꼬이지 않도록, 예외 대신 { failure: {status, message} } 마커를
    // 반환해 바깥에서 판별한다(이 코드베이스에 커스텀 HTTP 에러 클래스가
    // 없어, 기존 관례인 "핸들러가 직접 json()을 반환"하는 패턴을 그대로
    // 따른다).
    const result = await withMemberLock(env, `newmember:${fileId}`, async () => {
      // 🔧 [데이터 시트 통합] "권한관리" 탭이 "데이터" 탭으로 흡수됐다. 열
      // 인덱스(B=번호, C=이름, D=이메일)는 그대로라 row[1]/row[3] 접근은 안
      // 바뀌지만, 시트 자체가 D~V까지 넓어져 범위를 A1:V50으로 확장했다.
      const authRows = await getSheetValues(env, accessToken, fileId, "데이터!A1:V50");
      const rowIndex = authRows.findIndex((row) => (row[1] || "").trim() === String(sheetNum));
      if (rowIndex === -1) return { failure: { status: 404, message: "존재하지 않는 시트번호입니다." } };
      const existingEmail = parseGoogleEmail(authRows[rowIndex][3]);
      if (existingEmail) return { failure: { status: 409, message: `이미 배정된 번호입니다 (${existingEmail}).` } };

      // 🔧 [이름 중복 자동 처리] 도움봇/집계 시트는 구루미 닉네임과 이름(개인
      // 탭 B2 → 집계 C열 수식)을 정확히 일치시켜 매칭한다 — "이지은"과
      // "봉지은"이 똑같이 "지은"으로 등록되면 봇이 둘을 구분하지 못하고 먼저
      // 매칭되는 한 명에게만 기록이 붙는다. 지금까지 관리자가 겹칠 때마다
      // "지은1"처럼 수동으로 번호를 붙여온 관례를 그대로 자동화한다: 이미 쓰인
      // 이름과 정확히 같으면 뒤에 1부터 번호를 붙여 처음으로 비어있는 값을 쓴다.
      // "데이터" 시트 C열이 아니라 "집계" 시트 C열을 기준으로 삼는다 —
      // 집계 C열은 각 개인 탭 B2에서 수식으로 매번 다시 계산되는 "현재 실제로
      // 유효한 이름"이고, 봇이 구루미 닉네임 매칭에 쓰는 값도 바로 이것이다.
      const totalRows = await getSheetValues(env, accessToken, fileId, "집계!C4:C18").catch(() => []);
      const existingNames = new Set(totalRows.map((row) => (row[0] || "").trim()).filter(Boolean));
      const trimmedName = name.trim();
      let finalName = trimmedName;
      if (existingNames.has(finalName)) {
        let suffix = 1;
        while (existingNames.has(`${trimmedName}${suffix}`)) suffix += 1;
        finalName = `${trimmedName}${suffix}`;
      }

      const rowNumber = rowIndex + 1; // 1-indexed 시트 행 번호
      const dateStr = joinDate || todayKST;
      const targetTime = `${goalHours}H (${goalKind})`;
      const sheetName = String(sheetNum);
      // D열은 "구글계정,구루미계정" 형태로 저장한다(parseGoogleEmail/
      // parseGooroomeeAccount가 이 순서로 다시 나눠 읽음) — 구루미 계정을 담을
      // 별도 시트 컬럼이 없어 기존 이메일 칸에 함께 넣기로 함(사용자 확인).
      const dCellValue = gooroomeeAccount ? `${email},${gooroomeeAccount}` : email;

      await writeSheetValues(env, accessToken, fileId, [
        // 🔧 [B2 문구 통일] 집계 탭 C열 수식이 이제
        // =TRIM(MID(B2, 3, SEARCH("'s", B2)-3))로 바뀌어 " 님" 대신 "'s"를
        // 찾는다 — B2도 "📝 {이름}'s 대시보드 📝" 형식으로 맞춰야 한다.
        // finalName은 중복 시 자동으로 번호가 붙은 이름이다.
        { range: `${sheetName}!B2`, values: [[`📝 ${finalName}'s 대시보드 📝`]] },
        { range: `${sheetName}!I2`, values: [[dateStr]] },
        { range: `${sheetName}!L3`, values: [["스터디원"]] },
        { range: `${sheetName}!O3`, values: [[targetTime]] },
        { range: `데이터!D${rowNumber}`, values: [[dCellValue]] },
        { range: `데이터!E${rowNumber}`, values: [[examKind || ""]] },
      ]);
      return { sheetName, finalName };
    });
    if (result.failure) return json({ error: result.failure.message }, result.failure.status, origin);
    const { sheetName, finalName } = result;
    // 🔧 [사용자 지시, 2026-09-11] "신규 등록이 벌점/벌금/사이클 캐시까지
    // 매번 지우는 건 과도하다" — roster(9종 전부) 대신 이 함수가 실제로
    // 건드리는 범위와 겹치는 캐시만 지우는 newMember 그룹으로 좁힌다
    // (MEMBER_CACHE_GROUPS.newMember 정의 근처 주석 참고). meta:/
    // penSlotGrid:/weeklyPaidFine:/penCycle:는 이 함수가 건드리는 시트
    // 범위와 무관해 무효화 대상에서 뺐다.
    await invalidateMemberCache(env, ["newMember"]);
    // 이 번호가 과거 퇴실한 회원의 것이었다면, 그 회원의 벌점/제보상점 KV
    // 캐시가 아직 안 지워진 채 남아있을 수 있으므로 신규 등록 시점에도
    // 한 번 더 방어적으로 지운다.
    await invalidateMemberSlotCache(env, sheetName);

    // 시트 값 기입까지는 성공했으므로, 여기서 Drive 권한 부여만 실패해도
    // "등록 실패"로 되돌리지 않는다 — 프론트가 needsReauth를 보고 연동
    // 안내 후 /admin/members/grant-access로 권한만 재시도할 수 있게 한다.
    try {
      await grantSheetAccess(env, fileId, email);
    } catch (grantErr) {
      return json(
        {
          ok: true,
          number: sheetName,
          name: finalName,
          email,
          needsReauth: true,
          grantError: grantErr.message,
        },
        200,
        origin
      );
    }

    return json({ ok: true, number: sheetName, name: finalName, email }, 200, origin);
  } catch (err) {
    return json({ error: "신규 스터디원 등록 실패: " + err.message }, 500, origin);
  }
}

// 시트 값은 이미 채워졌지만 Drive 권한 부여만 실패했던 회원에게, 관리자 위임
// 재연동 후 권한만 다시 부여한다. 신규 등록 폼을 다시 채울 필요 없이
// 이메일만으로 재시도할 수 있게 한다.
async function handleGrantMemberAccess(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { email } = await req.json();
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return json({ error: "이메일 형식이 올바르지 않습니다." }, 400, origin);
  }

  try {
    await grantSheetAccess(env, env.GOOGLE_SHEET_FILE_ID, email);
    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "권한 부여 실패: " + err.message }, 500, origin);
  }
}

// --- 지난 기록: 앱스크립트가 매주 초기화 직전 Drive에 남기는 백업 시트를 조회 ---
// 백업 파일명 패턴: "공부합시당 캠스터디 YYMMDD-YYMMDD" (+선택적 " (N)" 중복 접미사).
// 이 파일들은 원본 시트를 통째로 복사한 사본이라 탭 구조(집계/1~15/권한관리 등)가 동일하다.
// 이 폴더는 일반 사용자와 공유되어 있지 않고, 서비스 계정에게만 뷰어 권한이 부여되어 있다.

const BACKUP_FILENAME_RE = /^공부합시당 캠스터디 (\d{6})-(\d{6})(?: \(\d+\))?$/;
const BACKUP_HISTORY_START_WEEK_OF = "260810"; // 이 주차(포함)부터만 지난 기록으로 취급
const CYCLE_MAX_LEN = 3; // 사이클 하나는 최대 3주 — 안전장치(사이클값이 리셋되지 않는 이상 상황 대비)

// weekOf(파일명의 시작일 YYMMDD)로 최신순 정렬
function compareWeekOfDesc(a, b) {
  return b.weekOf.localeCompare(a.weekOf);
}

async function listBackupFiles(env, accessToken) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?` +
      new URLSearchParams({
        q: `'${env.BACKUP_FOLDER_ID}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet'`,
        fields: "files(id,name)",
        pageSize: "200",
      }),
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!data.files) throw new Error("백업 폴더 조회 실패: " + JSON.stringify(data));

  const backups = [];
  for (const f of data.files) {
    const m = f.name.match(BACKUP_FILENAME_RE);
    if (!m) continue;
    const weekOf = m[1];
    if (weekOf < BACKUP_HISTORY_START_WEEK_OF) continue;
    backups.push({ fileId: f.id, weekOf, weekTo: m[2] });
  }
  backups.sort(compareWeekOfDesc);
  return backups;
}

// 🔧 [버그 수정, 2026-09] "최신 백업부터 훑다가 사이클값 1을 만나면(포함)
// 멈춘다"는 이전 로직은 현재 시트가 지금 1주차로 막 시작된 시점에 완전히
// 틀린 결과를 낸다 — sheet_reset()(appscript.js)은 D25(사이클)를 갱신하기
// *전에* 백업을 먼저 뜨므로, 백업 파일엔 항상 "그 주가 실제로 몇 주차였는지"
// 값이 그대로 남는다(1→2→3→1 순환). 즉 지금이 1주차라면 지난 주 백업은
// 리셋 직전 원본이 3주차였을 때 만들어졌으니 사이클값=3이고, 그 앞은 2, 그
// 앞(3주 전)에야 1을 만난다 — 옛 로직대로면 "1을 만날 때까지"가 방금 끝난
// 이전 사이클 3주 전체를 통째로 반환해버려, 1주차인 지금은 아직 이번
// 사이클의 백업이 하나도 없어야 하는데도 "현재 사이클 백업 3개"로 잘못
// 응답했다. 현재 시트 자체의 사이클 값(currentCycle)을 먼저 읽어 "이번
// 사이클에서 이미 지난 주가 몇 주인지"(currentCycle - 1)를 정확히 계산하고,
// 그 개수만큼만 최신 백업을 모은다 — 1주차면 0개, 2주차면 1개(사이클값=1인
// 것 하나), 3주차면 2개(사이클값 2, 1인 것 순서대로)를 반환한다.
function currentCycleBackups(backups, currentCycle) {
  const wantedCount = Math.min(CYCLE_MAX_LEN - 1, Math.max(0, currentCycle - 1));
  return backups.slice(0, wantedCount);
}

// 관리자/일반 구분 없이 누구나 "현재 진행 중인 사이클(최대 3주) 중 이미
// 백업된 주차"까지만 조회할 수 있다 — 그 이전 사이클(4주 이상 전)은
// 대상이 아니다. MY/ALL 상단의 "사이클 토글"이 이 목록 + "현재"(실시간,
// fileId 없음)를 함께 보여준다.
async function listCurrentCycleBackups(env, accessToken) {
  const [backups, currentCycle] = await Promise.all([
    listBackupFiles(env, accessToken),
    getCurrentPenCycle(env, accessToken, env.GOOGLE_SHEET_FILE_ID),
  ]);
  return { backups: currentCycleBackups(backups, currentCycle), currentCycle };
}

// GET /cycles — 토글에 뿌릴 선택지 목록. "현재"(fileId: null, 실시간)를
// 맨 앞에 두고, 그 뒤로 이미 백업된 주차를 최신순으로 나열한다.
// member 쿼리 파라미터가 있으면 각 주차마다 그 회원이 그 시점 명단에 실제로
// 존재했는지(hasData)도 함께 계산한다 — 중도 가입 회원은 가입 전 주차엔
// 명단 자체에 없기 때문이다. "self"는 세션 이메일로 본인을 판정하고(개인
// 대시보드용), 파라미터 자체가 없으면 전혀 필터링하지 않는다(전체 랭킹처럼
// 특정 회원 관점이 없는 화면용 — 항상 hasData: true).
async function handleCycleList(req, env, origin, url) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const { backups, currentCycle } = await listCurrentCycleBackups(env, accessToken);
    const memberParam = url ? url.searchParams.get("member") : null;

    let targetMemberNumber = null;
    if (memberParam === "self") {
      const member = await findMemberNumberByEmail(env, accessToken, env.GOOGLE_SHEET_FILE_ID, session.email);
      targetMemberNumber = member ? member.number : null;
    } else if (memberParam) {
      targetMemberNumber = memberParam;
    }

    const weeks = await Promise.all(
      backups.map(async (b) => {
        let hasData = true;
        if (targetMemberNumber) {
          const members = await listAllMembers(env, accessToken, b.fileId);
          hasData = members.some((m) => m.number === targetMemberNumber);
        }
        return { fileId: b.fileId, weekOf: b.weekOf, weekTo: b.weekTo, hasData };
      })
    );

    return json(
      {
        weeks,
        // 🔧 프론트가 "아직 백업이 없는 과거 주차"도 비활성화 슬롯으로
        // 채워 보여줄 수 있도록, 사이클 최대 길이를 함께 내려준다(하드코딩
        // 값이 바뀌어도 프론트가 자동으로 따라가게).
        maxWeeks: CYCLE_MAX_LEN,
        // 🔧 [버그 수정, 2026-09] 프론트(CycleSwitcher)가 "이번 주가 사이클
        // 몇 번째 주인지"를 weeks.length로 역산하던 방식은, 항상 3칸을
        // 채운다는 잘못된 가정과 맞물려 1~2주차인데도 "3주차"로 잘못
        // 표시되는 문제가 있었다 — 서버가 실제 현재 사이클 값을 직접
        // 내려줘 프론트가 더는 역산하지 않게 한다.
        currentWeekNumber: currentCycle,
      },
      200,
      origin
    );
  } catch (err) {
    return json({ error: "사이클 목록 조회 실패: " + err.message }, 500, origin);
  }
}

// /status, /roster-status가 공통으로 쓰는 헬퍼 — cycle 쿼리 파라미터(백업
// fileId)가 주어지면 그 백업이 "현재 진행 중인 사이클"에 실제로 속하는지
// 검증한 뒤 그 fileId를 반환하고, 없으면 현재 활성 시트(GOOGLE_SHEET_FILE_ID)를
// 반환한다 — 사이클 밖의 임의 fileId로 과거 무제한 조회를 막기 위한 검증이다.
// 🔧 [가입일 이전 요일 비활성화용] fileId뿐 아니라 그 fileId가 어느 주(weekOf,
// "YYMMDD" 형식의 월요일)인지도 함께 반환한다 — buildPersonalStatus가 요일별
// 실제 캘린더 날짜를 계산해 "가입 전 요일"을 판정하는 데 쓴다. 실시간(라이브
// 시트) 조회면 특정 백업 주차가 없으므로 weekOf는 null — 호출부가 "오늘
// 기준 이번 주"로 직접 계산한다.
async function resolveTargetFileId(env, accessToken, cycleFileId) {
  if (!cycleFileId) return { fileId: env.GOOGLE_SHEET_FILE_ID, weekOf: null };
  const { backups } = await listCurrentCycleBackups(env, accessToken);
  const backup = backups.find((b) => b.fileId === cycleFileId);
  if (!backup) throw new Error("현재 사이클에 속하지 않는 기록입니다.");
  return { fileId: backup.fileId, weekOf: backup.weekOf };
}

// --- 실시간 참여자 명단: 로컬 봇이 PUT으로 갱신, 제보 페이지가 GET으로 조회 ---
// KV는 쓰기 횟수가 하루 1,000회로 제한되어 수 초 간격 갱신에 부적합하므로
// 쓰기 제한이 없는 Durable Object(단일 인스턴스, 메모리 상주)를 사용한다.

const PARTICIPANTS_STALE_MS = 60 * 1000;

// 슬롯 배정 락(아래 ParticipantsRoster의 /lock/acquire)에서 한 대기자가
// 최대 기다릴 시간 — 이보다 오래 걸리면 락을 쥔 요청이 죽었거나 비정상적으로
// 지연되는 것으로 보고 대기를 포기시켜, 영구 데드락으로 이어지지 않게 한다.
// applyOutputPenalty/applyReportMerit 한 번의 실행 시간(Sheets API 호출
// 몇 번, 수백ms~수 초)보다 넉넉히 길게 잡는다.
const LOCK_WAIT_TIMEOUT_MS = 15000;

// 🔧 [버그 수정] applyOutputPenalty/applyReportMerit는 "빈 슬롯 찾기 →
// 쓰기"가 락 없는 read-modify-write라, 같은 대상자(또는 같은 제보자)에게
// 밀린 제보 여러 건을 관리자가 빠르게 연속 승인하면(백로그 정리 시 흔한
// 패턴) 둘 다 같은 빈 슬롯을 읽어 하나가 조용히 덮어써지는 레이스가 있었다.
// 이 Durable Object는 이미 단일 인스턴스로 모든 요청을 순차(직렬) 처리하는
// 성질을 그대로 이용해, 키(닉네임/제보자 이메일)별 순번 대기열을 메모리에
// 두는 최소한의 뮤텍스로 쓴다 — Sheets API 호출 자체는 여전히 Worker에서
// 하되, "acquire"(내 차례가 될 때까지 대기 후 티켓 발급)와 "release"(다음
// 대기자에게 순번 넘기기) 두 요청으로 임계구역을 감싼다.
export class ParticipantsRoster {
  constructor(state) {
    this.state = state;
    this.members = [];
    this.updatedAt = 0;
    // 🔧 [버그 수정, 2026-09-11] "교시 제한 시간도 아닌데 도움봇이 꺼져있다고
    // 뜬다"는 제보 — this.updatedAt은 순수 인메모리 필드라, Cloudflare가
    // 이 DO를 유휴 시 자동 종료했다가 다음 요청에서 새 인스턴스로 재시작시키면
    // (트래픽에 따라 수시로 일어남, 이 앱이 제어할 수 없는 플랫폼 동작)
    // updatedAt이 다시 0으로 리셋됐다 — 재시작 직후 봇은 실제로 멀쩡히
    // 동작 중인데도 "Date.now() - 0"이 항상 PARTICIPANTS_STALE_MS(60초)를
    // 넘어 stale:true를 잘못 반환하고, 다음 봇 PUT(최대 약 10~15초 이내)이
    // 오면 다시 정상화되는 패턴이었다(간헐적으로 "잠깐" 뜨는 증상과 일치).
    // DO의 영구 저장소(this.state.storage)에 매 PUT마다 updatedAt을 함께
    // 저장해두고, 재시작 시 blockConcurrencyWhile로 그 값을 복구해 재시작
    // 여부와 무관하게 "마지막으로 실제 갱신된 시각"을 정확히 유지한다 —
    // 첫 구동(진짜 아무도 PUT한 적 없음)이면 저장된 값이 없어 0 그대로
    // 유지되므로 stale:true가 맞게 나온다.
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get("updatedAt");
      if (typeof stored === "number") this.updatedAt = stored;
    });
    this.locks = new Map(); // key -> { holding: bool, queue: [resolve, ...] }
    // 🔧 [KV list() 제거, 2026-09-11] "PUSH 알림 전송"의 쿨다운(닉네임별
    // 재전송 제한)·"최근 전송된 알림" 목록을 원래 KV(notice-cooldown:/
    // noticeIndex:current)에 뒀었는데, 이 DO가 이미 "전 세계에 단 하나뿐인
    // 인스턴스"라 같은 목적(참여자 명단)에 더해 이 상태도 얹을 수 있다 —
    // KV처럼 하루 쓰기 한도(1,000회)에 걸리지 않고, get→put 사이 경합도
    // 없이(요청이 이 인스턴스로 직렬 처리됨) 원자적으로 처리된다. 만료
    // 판정용 expiresAt만 함께 저장해 매 조회 시 걸러낸다 — KV의
    // _appendToLiveIndex/_readLiveIndex와 같은 원리지만 DO 안에서는 CAS
    // 재시도 로직 자체가 필요 없다(단일 인스턴스가 이미 직렬화해주므로).
    this.notices = []; // { nickname, message, senderName, ts, expiresAt }
    // 🔧 [KV list() 무관, KV 쓰기 한도 제거, 2026-09-11] "진행 중인 제보"
    // (ActiveReportsSection, 15초 폴링)도 notices와 같은 이유로 여기로
    // 옮긴다 — cooldownKey(코드상 `cooldown:{nickname}`/
    // `selfcheck-cooldown:{email}`와 동일한 문자열을 그대로 재사용, 두
    // 종류가 섞이지 않도록) 존재 여부로 429 차단을 판정하고, 같은 배열을
    // "최근 진행된 제보" 표시에도 그대로 쓴다 — KV 시절엔 이 둘(차단 판정용
    // cooldown: 키, 표시용 COOLDOWN_INDEX_KEY 인덱스)이 서로 다른 저장소라
    // 수동으로 동기화해야 했는데(_markCaptureDoneInLiveIndex가 인덱스
    // expiresAt과 cooldown: TTL 둘 다 갱신), 여기선 한 배열이 둘 다 겸해
    // 그 동기화 자체가 필요 없어졌다.
    this.reportCooldowns = []; // { cooldownKey, id, nickname, mode, startedAt, capturedAt, expiresAt, selfCheck, reporterEmail }
    // 🔧 [KV → DO 이전, 2026-09-12] 반휴 신청 레이트리밋(leaveApplyRate:,
    // 60초 창에 최대 2회)도 notices/reportCooldowns와 동일한 이유로 이
    // DO로 옮긴다(§47) — "지금 이 순간의 상태, 없어져도 그만"이라 순수
    // 메모리로 충분하다(state.storage 영속화 불필요).
    this.leaveApplyRates = []; // { memberNumber, windowStart, count, expiresAt }
  }

  async fetch(req) {
    if (req.method === "PUT") {
      const { members } = await req.json();
      this.members = Array.isArray(members) ? members.slice(0, 200) : [];
      this.updatedAt = Date.now();
      // 이 DO가 나중에 재시작돼도 "마지막으로 실제 갱신된 시각"을 이어받을
      // 수 있도록 영구 저장소에도 함께 남긴다(위 생성자 주석 참고). 실패해도
      // 조용히 넘어간다 — 최악의 경우 다음 재시작 때만 이 문제가 재발할
      // 뿐, 이번 요청의 본 응답(멤버 목록 갱신)을 막을 이유는 아니다.
      this.state.storage.put("updatedAt", this.updatedAt).catch((e) => console.error("[ParticipantsRoster] updatedAt 영구 저장 실패:", e));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (req.method === "GET") {
      const url = new URL(req.url);
      if (url.pathname === "/notice/list") {
        const now = Date.now();
        this.notices = this.notices.filter((n) => n.expiresAt > now);
        return new Response(JSON.stringify({ items: this.notices }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/report-cooldown/list") {
        const now = Date.now();
        this.reportCooldowns = this.reportCooldowns.filter((c) => c.expiresAt > now);
        return new Response(JSON.stringify({ items: this.reportCooldowns }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      const stale = Date.now() - this.updatedAt > PARTICIPANTS_STALE_MS;
      return new Response(
        JSON.stringify({ members: this.members, updatedAt: this.updatedAt, stale }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
    if (req.method === "POST") {
      const url = new URL(req.url);
      if (url.pathname === "/notice/check") {
        const { nickname } = await req.json();
        const now = Date.now();
        this.notices = this.notices.filter((n) => n.expiresAt > now);
        const onCooldown = this.notices.some((n) => n.nickname === nickname);
        return new Response(JSON.stringify({ onCooldown }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/notice/record") {
        const { nickname, message, senderName, cooldownSec } = await req.json();
        const now = Date.now();
        this.notices = this.notices.filter((n) => n.expiresAt > now);
        this.notices.push({ nickname, message, senderName, ts: now, expiresAt: now + cooldownSec * 1000 });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/leave-rate/check") {
        // 🔧 [KV → DO 이전, 2026-09-12] checkAndRecordLeaveApplyRate와
        // 동일한 고정 60초 창 로직 — true면 이번 요청 진행 가능(카운트
        // 기록 완료), false면 이번 창에서 한도(2회)를 이미 다 쓴 것(거부된
        // 시도는 카운트하지 않음).
        const { memberNumber } = await req.json();
        const now = Date.now();
        const windowMs = 60 * 1000;
        const maxCount = 2;
        this.leaveApplyRates = this.leaveApplyRates.filter((r) => r.expiresAt > now);
        const entry = this.leaveApplyRates.find((r) => r.memberNumber === memberNumber);
        if (entry) {
          if (entry.count >= maxCount) {
            return new Response(JSON.stringify({ allowed: false }), { headers: { "Content-Type": "application/json" } });
          }
          entry.count += 1;
          entry.expiresAt = entry.windowStart + windowMs;
        } else {
          this.leaveApplyRates.push({ memberNumber, windowStart: now, count: 1, expiresAt: now + windowMs });
        }
        return new Response(JSON.stringify({ allowed: true }), { headers: { "Content-Type": "application/json" } });
      }
      if (url.pathname === "/report-cooldown/check") {
        const { cooldownKey } = await req.json();
        const now = Date.now();
        this.reportCooldowns = this.reportCooldowns.filter((c) => c.expiresAt > now);
        const onCooldown = this.reportCooldowns.some((c) => c.cooldownKey === cooldownKey);
        return new Response(JSON.stringify({ onCooldown }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/report-cooldown/record") {
        const { cooldownKey, id, nickname, mode, selfCheck, reporterEmail, cooldownSec } = await req.json();
        const now = Date.now();
        this.reportCooldowns = this.reportCooldowns.filter((c) => c.expiresAt > now);
        this.reportCooldowns.push({
          cooldownKey,
          id,
          nickname,
          mode,
          startedAt: now,
          capturedAt: null,
          expiresAt: now + cooldownSec * 1000,
          selfCheck: !!selfCheck,
          reporterEmail,
        });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/report-cooldown/capture-done") {
        // 🔧 [촬영 완료 후 20분 재시작] KV 시절 _markCaptureDoneInLiveIndex와
        // 동일한 로직 — capturedAt부터 원래 쿨다운 길이(expiresAt-startedAt)
        // 만큼 다시 카운트한다. 여긴 배열 하나가 차단 판정과 표시를 겸하므로
        // KV처럼 cooldown: 키를 별도로 재기입할 필요가 없다.
        const { id, capturedAt } = await req.json();
        const now = Date.now();
        this.reportCooldowns = this.reportCooldowns.filter((c) => c.expiresAt > now || c.id === id);
        const item = this.reportCooldowns.find((c) => c.id === id);
        if (item && !item.capturedAt) {
          const cooldownSec = Math.round((item.expiresAt - item.startedAt) / 1000);
          item.capturedAt = capturedAt;
          item.expiresAt = capturedAt + cooldownSec * 1000;
        }
        this.reportCooldowns = this.reportCooldowns.filter((c) => c.expiresAt > now);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      const key = url.searchParams.get("key");
      if (!key) return new Response(JSON.stringify({ error: "key required" }), { status: 400 });
      if (url.pathname === "/lock/acquire") {
        let entry = this.locks.get(key);
        if (!entry) {
          entry = { holding: false, queue: [] };
          this.locks.set(key, entry);
        }
        if (!entry.holding) {
          entry.holding = true;
        } else {
          // 🔧 [버그 수정] 원래는 타임아웃 없이 무기한 대기했다 — 락을 쥔
          // 요청이 release 없이 죽으면(Worker 강제종료 등, 드물지만 가능)
          // entry.holding이 영원히 true로 남아 이후 같은 key의 모든 acquire가
          // 무한 대기하는 영구 데드락이 됐다. 게다가 대기자가 존재하는 것
          // 자체가 DO를 "처리 중인 요청이 남아있다"로 보이게 해, 유휴 시
          // 자연 evict(재시작으로 this.locks가 초기화되는 자가치유)조차
          // 막을 수 있었다. LOCK_WAIT_TIMEOUT_MS 안에 못 받으면 큐에서
          // 자기 항목을 직접 제거하고 "실패"로 응답해, 상위(withMemberLock)가
          // 락 없이 진행하도록 한다 — 죽은 락 보유자로 인한 무한 대기 사슬을
          // 끊는다. release가 나중에 이 항목을 next()로 깨우는 레이스를
          // 막기 위해, 깨워진 콜백이 "이미 시간초과로 빠졌는지"를 own 배열
          // 참조로 직접 확인해 제거한다(splice는 항등 비교라 안전).
          const waiter = { resolve: null };
          const waitPromise = new Promise((resolve) => {
            waiter.resolve = resolve;
            entry.queue.push(waiter);
          });
          const acquiredInTime = await Promise.race([
            waitPromise.then(() => true),
            new Promise((resolve) => setTimeout(() => resolve(false), LOCK_WAIT_TIMEOUT_MS)),
          ]);
          if (!acquiredInTime) {
            const idx = entry.queue.indexOf(waiter);
            if (idx !== -1) entry.queue.splice(idx, 1); // 아직 안 깨워졌으면 큐에서 제거.
            return new Response(JSON.stringify({ ok: false, timedOut: true }), {
              status: 503,
              headers: { "Content-Type": "application/json" },
            });
          }
        }
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      }
      if (url.pathname === "/lock/release") {
        const entry = this.locks.get(key);
        if (entry) {
          const next = entry.queue.shift();
          if (next) {
            next.resolve(); // 다음 대기자가 락을 이어받는다(holding은 계속 true).
          } else {
            entry.holding = false;
            this.locks.delete(key);
          }
        }
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      }
    }
    return new Response("method not allowed", { status: 405 });
  }
}

// 🔧 [사용량 모니터링 고도화, 2026-09-11] "하루 동안, 어느 메뉴에서, 어느
// 사용자에 의해 KV 쓰기·삭제·목록조회가 발생했는지"를 재시작에도 유지되게
// 기록하는 전용 DO. ParticipantsRoster(참여자 명단/락/공지/쿨다운)와는
// 책임이 달라 별도 클래스로 뒀다 — 이 DO는 SQL API 없이
// ParticipantsRoster의 updatedAt과 동일한 단순 key-value 패턴만 쓴다
// (회원 15명·관리자 3명 규모에서 SQL은 과함). 키는
// "{date}|{path}|{email}|{op}"(date는 todayUTCDateString과 동일한 UTC
// YYYY-MM-DD — 🔧 [사용자 지시] "UTC 기준으로 해줘야지. 결국 한도에
// 따른 사용치를 보고 싶은건데": 같은 화면 위쪽 Cloudflare 실측 게이지가
// 실제 한도 리셋 시점인 UTC 자정 기준이라 여기도 맞춤), 값은 누적 카운트
// 정수. 매 KV 호출마다 이 DO에 실시간 fetch하지 않고(오버헤드 + "감시가
// 감시 대상을 갉아먹는" 역설 방지), index.js의 _dailyUsageBuffer가 5분
// cron에서 배치로 /flush를 호출한다.
export class UsageStats {
  constructor(state) {
    this.state = state;
    this.counts = new Map(); // "{date}|{path}|{email}|{op}" -> count
    // 🔧 [사용자 지시] "이메일 말고 사용자 이름을 적고" — 처음엔
    // _emailNameMap(index.js 상단, isolate 로컬 메모리)만으로 치환했는데,
    // "이 요청을 처리한 isolate가 그 사용자를 아직 한 번도 못 봤으면"
    // 이메일이 그대로 보이는 문제가 있었다(Cloudflare가 요청을 여러
    // 서버로 분산 처리하는 한, isolate 로컬 매핑은 "일일"/"30분" 집계와
    // 똑같은 구조적 한계를 겪는다). email→name 매핑도 여기 DO에 영구
    // 저장해 isolate 무관하게 항상 알 수 있게 한다.
    this.names = new Map(); // email -> memberName
    // ParticipantsRoster의 updatedAt 복구 패턴과 동일 — 재시작 시 영구
    // 저장소에서 전량 복원한다. 항목 수가 (보관 정책상 최대 7일)×(경로
    // 수십 개)×(사용자 15명 안팎)×(연산 3종) 수준이라 전량 로드에 무리가
    // 없다.
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.list();
      for (const [key, value] of stored) {
        if (typeof value === "number") this.counts.set(key, value);
        else if (typeof value === "string" && key.startsWith("n|")) this.names.set(key.slice(2), value);
      }
    });
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/flush") {
      const { entries, today, names } = await req.json();
      const puts = [];
      for (const { date, kind, path, email, op, count } of entries || []) {
        const key = `${date}|${kind}|${path}|${email}|${op}`;
        const next = (this.counts.get(key) || 0) + count;
        this.counts.set(key, next);
        puts.push(this.state.storage.put(key, next));
      }
      for (const [email, name] of Object.entries(names || {})) {
        if (this.names.get(email) === name) continue;
        this.names.set(email, name);
        puts.push(this.state.storage.put(`n|${email}`, name));
      }
      // 보관 정책: 오늘(today, 호출부가 todayUTCDateString()로 계산해
      // 넘김) 기준 7일보다 오래된 키는 함께 정리한다 — DO 저장 공간이
      // 무한정 쌓이지 않게 하는 목적. 문자열 YYYY-MM-DD는 사전순 비교가
      // 날짜순 비교와 일치해 Date 파싱 없이 바로 비교 가능하다.
      if (today) {
        const cutoffDate = new Date(today);
        cutoffDate.setDate(cutoffDate.getDate() - 7);
        const cutoff = cutoffDate.toISOString().slice(0, 10);
        for (const key of this.counts.keys()) {
          if (key.startsWith("m|")) continue; // 분단위 키는 아래 /flush-recent가 별도 정리
          const keyDate = key.slice(0, key.indexOf("|"));
          if (keyDate < cutoff) {
            this.counts.delete(key);
            puts.push(this.state.storage.delete(key));
          }
        }
      }
      await Promise.all(puts);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    // 🔧 [사용자 지시] "일일 중에서 30분내로 발생한것만 추려서 보여주면
    // 되잖아" — /flush와 별개 엔드포인트로 분단위(m|{minuteKey}|...) 키를
    // 반영하고, 30분보다 오래된 분단위 키는 여기서 함께 정리한다(daily
    // 키와 달리 자정 넘어가는 걸 기다릴 필요 없이 즉시 정리 가능).
    if (req.method === "POST" && url.pathname === "/flush-recent") {
      const { entries } = await req.json();
      const puts = [];
      for (const { minuteKey, kind, path, email, op, count } of entries || []) {
        const key = `m|${minuteKey}|${kind}|${path}|${email}|${op}`;
        const next = (this.counts.get(key) || 0) + count;
        this.counts.set(key, next);
        puts.push(this.state.storage.put(key, next));
      }
      const cutoff = Date.now() - KV_USAGE_WINDOW_MIN * 60_000;
      for (const key of this.counts.keys()) {
        if (!key.startsWith("m|")) continue;
        const minuteKey = key.slice(2, 18); // "m|" 제거 후 "YYYY-MM-DDTHH:MM"(16자)
        if (new Date(minuteKey + ":00Z").getTime() < cutoff) {
          this.counts.delete(key);
          puts.push(this.state.storage.delete(key));
        }
      }
      await Promise.all(puts);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "GET" && url.pathname === "/today") {
      const date = url.searchParams.get("date") || "";
      const prefix = `${date}|`;
      const items = [];
      for (const [key, count] of this.counts) {
        if (key.startsWith("m|") || !key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const parts = rest.split("|");
        const op = parts.pop();
        const email = parts.pop();
        // 🔧 [사용자 지시] "일일에서도 - 뒤에 캐시 유발 지점을 출력해줘" —
        // kind를 daily 키에 추가하기 전(구버전)엔 세그먼트가 4개
        // (path|email|op는 이미 pop됨 → path만 남음)였고, 이후(신버전)엔
        // kind가 맨 앞에 하나 더 있다(5개: kind|path|email|op). 남은
        // parts 길이로 구분해 과도기의 구버전 키도 깨지지 않게 읽는다
        // (최대 7일 뒤 자연 소멸).
        const kind = parts.length > 1 ? parts.shift() : "";
        const path = parts.join("|");
        items.push({ kind, path, email, op, count });
      }
      // 🔧 [사용자 지시] "이메일 말고 사용자 이름을 적고" — names(email->name
      // 전체 매핑)도 함께 내려줘 호출부가 isolate 로컬 매핑 없이 치환할
      // 수 있게 한다.
      return new Response(JSON.stringify({ items, names: Object.fromEntries(this.names) }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    // 🔧 최근 30분(KV_USAGE_WINDOW_MIN) 이내 분단위 키만 (path·email·op)로
    // 합산해 반환한다 — isolate 로컬이던 기존 "30분" 뷰와 달리 모든
    // isolate의 기록을 DO 하나로 모은 뒤 필터링하므로 항상 완전한 값이다.
    if (req.method === "GET" && url.pathname === "/recent") {
      const cutoff = Date.now() - KV_USAGE_WINDOW_MIN * 60_000;
      const totals = new Map(); // "{kind}|{path}|{email}|{op}" -> count
      for (const [key, count] of this.counts) {
        if (!key.startsWith("m|")) continue;
        const minuteKey = key.slice(2, 18);
        const ts = Date.parse(minuteKey + ":00Z");
        if (Number.isNaN(ts) || ts < cutoff) continue;
        const groupKey = key.slice(19); // "m|" + minuteKey(16) + "|" 제거
        totals.set(groupKey, (totals.get(groupKey) || 0) + count);
      }
      const items = [...totals.entries()].map(([groupKey, count]) => {
        const parts = groupKey.split("|");
        const op = parts.pop();
        const email = parts.pop();
        const kind = parts.shift();
        const path = parts.join("|");
        return { kind, path, email, op, count };
      });
      return new Response(JSON.stringify({ items, names: Object.fromEntries(this.names) }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("method not allowed", { status: 405 });
  }
}

function getUsageStatsStub(env) {
  const id = env.USAGE_STATS_DO.idFromName("usage-stats");
  return env.USAGE_STATS_DO.get(id);
}

// 🔧 [사용자 지시, 2026-09-12] "list 말고 다른 방식으로 구현은 어려운
// 구조야 현재?" → "그럼 옮겨버려" — handleListReports(GET /reports, 10분
// 안전망 폴링)가 REPORTS_KV.list({prefix:"report:"})로 하루 대부분의
// KV list() 호출(약 144회/일)을 차지했다. 이 큐를 KV에서 이 DO로
// 옮겨 put/delete/list 세 연산 모두 KV 할당량에서 뺀다.
// docs/CACHING_POLICY.md §24.3은 "report:{id}는 DO로 옮기면 안 된다"고
// 적어뒀지만, 그 결론은 순수 메모리 DO(재시작 시 빈 상태로 리셋)에만
// 해당한다 — 여기는 UsageStats와 동일하게 state.storage를 실제로 써서
// 재시작해도 blockConcurrencyWhile로 전량 복원되므로, §24.3이 우려한
// "봇이 몇 시간 꺼져 있는 동안 안전망 큐가 소실될 위험"이 발생하지
// 않는다(사용자 확인: 기능면에서 차이 없음).
export class ReportQueue {
  constructor(state) {
    this.state = state;
    this.entries = new Map(); // id -> entry(JSON 객체, expiresAt 필드 포함)
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.list();
      for (const [id, entry] of stored) this.entries.set(id, entry);
    });
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/put") {
      const { entry, ttlSec } = await req.json();
      const expiresAt = Date.now() + ttlSec * 1000;
      const stored = { ...entry, expiresAt };
      this.entries.set(entry.id, stored);
      await this.state.storage.put(entry.id, stored);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "POST" && url.pathname === "/delete") {
      const { id } = await req.json();
      this.entries.delete(id);
      await this.state.storage.delete(id);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    // handleListReports가 하던 "list + 각 get + 각 delete + 정렬해 반환"
    // 전부를 한 번의 DO fetch로 대체한다 — 만료 안 된 항목만 반환하고
    // (KV 시절과 동일하게 "조회 즉시 소비"), 이미 만료된 항목은 반환
    // 없이 조용히 지운다(KV expirationTtl 자동 만료 대신 여기서 직접
    // 판정).
    if (req.method === "POST" && url.pathname === "/drain") {
      const now = Date.now();
      const items = [];
      const puts = [];
      for (const [id, entry] of this.entries) {
        if (entry.expiresAt > now) items.push(entry);
        this.entries.delete(id);
        puts.push(this.state.storage.delete(id));
      }
      await Promise.all(puts);
      items.sort((a, b) => a.ts - b.ts);
      return new Response(JSON.stringify({ items }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("method not allowed", { status: 405 });
  }
}

function getReportQueueStub(env) {
  const id = env.REPORT_QUEUE_DO.idFromName("report-queue");
  return env.REPORT_QUEUE_DO.get(id);
}

// 🔧 [사용자 지시, 2026-09-12] "전환 가능한 것들은 지금 전환하도록 하자"
// — leaveq:(사유반휴 봇 오프라인 대기열)+leaveqIndex:current, exitRequest:
// (퇴실 신청)+exitRequestIndex:current, leaveHistory:(사유반휴 처리 이력)
// 세 KV 자료구조를 한 DO로 통합 이전한다. 셋 다 "사유반휴·퇴실 처리"라는
// 같은 도메인이고 트래픽이 낮아(회원 15명, 생애주기당 수 회) 인스턴스를
// 나눌 실익이 없다 — storage 키 prefix(leaveq:/exit:/history:)로만
// 구분한다. ReportQueue와 동일하게 state.storage 기반 영속 DO라 §24.3이
// 우려한 "재시작 시 소실" 위험이 없다(§46/§47 참고).
export class LeaveQueue {
  constructor(state) {
    this.state = state;
    this.leaveq = new Map(); // id -> entry(memberNumber, memberName, day, reason, requesterEmail, imageBase64, imageExt, count, ts)
    this.exitRequests = new Map(); // memberNumber -> {exitDate, ts, agreedAt}
    this.history = new Map(); // weekOf -> array
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.list();
      for (const [key, value] of stored) {
        if (key.startsWith("leaveq:")) this.leaveq.set(key.slice(7), value);
        else if (key.startsWith("exit:")) this.exitRequests.set(key.slice(5), value);
        else if (key.startsWith("history:")) this.history.set(key.slice(8), value);
      }
    });
  }

  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/leaveq/put") {
      const { id, entry } = await req.json();
      this.leaveq.set(id, entry);
      await this.state.storage.put(`leaveq:${id}`, entry);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "POST" && url.pathname === "/leaveq/delete") {
      const { id } = await req.json();
      const existed = this.leaveq.delete(id);
      await this.state.storage.delete(`leaveq:${id}`);
      return new Response(JSON.stringify({ ok: true, existed }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "GET" && url.pathname === "/leaveq/get") {
      const id = url.searchParams.get("id") || "";
      const entry = this.leaveq.get(id);
      if (!entry) return new Response(JSON.stringify({ entry: null }), { status: 404, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ entry }), { headers: { "Content-Type": "application/json" } });
    }
    // 🔧 [응답 크기 절감] leaveq 항목은 imageBase64(증빙 사진)를 포함해
    // 최대 수 MB에 달할 수 있다 — 목록(요약)이 필요한 호출부
    // (listQueuedReasonLeaveDays/listQueuedReasonLeaveItems/취소 매칭)는
    // 이미지를 뺀 요약만 받고, 실제로 전체 데이터가 필요한
    // flushQueuedReasonLeaveProofs(봇에 그대로 전달)만 /leaveq/list-full로
    // 구분한다.
    if (req.method === "GET" && url.pathname === "/leaveq/list") {
      const items = [...this.leaveq.entries()].map(([id, entry]) => ({
        id,
        memberNumber: entry.memberNumber,
        memberName: entry.memberName,
        day: entry.day,
        reason: entry.reason,
        requesterEmail: entry.requesterEmail,
        count: entry.count || 1,
        ts: entry.ts || 0,
      }));
      return new Response(JSON.stringify({ items }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "GET" && url.pathname === "/leaveq/list-full") {
      const items = [...this.leaveq.entries()].map(([id, entry]) => ({ id, ...entry }));
      return new Response(JSON.stringify({ items }), { headers: { "Content-Type": "application/json" } });
    }

    if (req.method === "POST" && url.pathname === "/exit/put") {
      const { memberNumber, exitDate, ts, agreedAt } = await req.json();
      const entry = { exitDate: exitDate || null, ts: ts || null, agreedAt: agreedAt ?? null };
      this.exitRequests.set(memberNumber, entry);
      await this.state.storage.put(`exit:${memberNumber}`, entry);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "POST" && url.pathname === "/exit/delete") {
      const { memberNumber } = await req.json();
      this.exitRequests.delete(memberNumber);
      await this.state.storage.delete(`exit:${memberNumber}`);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "GET" && url.pathname === "/exit/get") {
      const memberNumber = url.searchParams.get("memberNumber") || "";
      const entry = this.exitRequests.get(memberNumber) || null;
      return new Response(JSON.stringify({ entry }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "GET" && url.pathname === "/exit/list") {
      const items = Object.fromEntries(this.exitRequests);
      return new Response(JSON.stringify({ items }), { headers: { "Content-Type": "application/json" } });
    }

    if (req.method === "POST" && url.pathname === "/history/append") {
      const { weekOf, entry } = await req.json();
      const arr = this.history.get(weekOf) || [];
      arr.push(entry);
      this.history.set(weekOf, arr);
      await this.state.storage.put(`history:${weekOf}`, arr);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "GET" && url.pathname === "/history/get") {
      const weekOf = url.searchParams.get("weekOf") || "";
      const items = this.history.get(weekOf) || [];
      return new Response(JSON.stringify({ items }), { headers: { "Content-Type": "application/json" } });
    }

    return new Response("method not allowed", { status: 405 });
  }
}

function getLeaveQueueStub(env) {
  const id = env.LEAVE_QUEUE_DO.idFromName("leave-queue");
  return env.LEAVE_QUEUE_DO.get(id);
}

// 🔧 [사용자 지시, 2026-09-12] 제보 심각도 투표(부스터디장 최대 2명,
// TTL 7일) — reportVote:{id}:{num}을 이 DO로 이전. LeaveQueue와 도메인이
// 달라 별도 클래스로 분리했다.
export class ReportVote {
  constructor(state) {
    this.state = state;
    this.votes = new Map(); // "id:number" -> {name, severity, votedAt, expiresAt}
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.list();
      for (const [key, value] of stored) this.votes.set(key, value);
    });
  }

  async fetch(req) {
    const url = new URL(req.url);
    const REPORT_VOTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

    if (req.method === "POST" && url.pathname === "/vote/put") {
      const { id, number, name, severity } = await req.json();
      const key = `${id}:${number}`;
      const value = { name, severity, votedAt: Date.now(), expiresAt: Date.now() + REPORT_VOTE_TTL_MS };
      this.votes.set(key, value);
      const puts = [this.state.storage.put(key, value)];
      // 기회주의적 정리 — 이 id에 딸린 다른 투표 중 만료된 것도 함께 지운다.
      const now = Date.now();
      for (const [k, v] of this.votes) {
        if (k.startsWith(`${id}:`) && v.expiresAt <= now) {
          this.votes.delete(k);
          puts.push(this.state.storage.delete(k));
        }
      }
      await Promise.all(puts);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "POST" && url.pathname === "/vote/get-batch") {
      const { id, numbers } = await req.json();
      const now = Date.now();
      const votes = {};
      for (const number of numbers || []) {
        const v = this.votes.get(`${id}:${number}`);
        if (v && v.expiresAt > now) votes[number] = { name: v.name, severity: v.severity, votedAt: v.votedAt };
      }
      return new Response(JSON.stringify({ votes }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("method not allowed", { status: 405 });
  }
}

function getReportVoteStub(env) {
  const id = env.REPORT_VOTE_DO.idFromName("report-vote");
  return env.REPORT_VOTE_DO.get(id);
}

// 🔧 [사용자 지시, 2026-09-12] "실익이 없더라도 기능적으로 차이 없이
// 변환 가능한 구조라면 모두 변경하도록 해" — 회원 개인화 설정 3종
// (notifyPref:/statusMessage:/exitResult:)을 한 DO로 통합 이전한다.
// 셋 다 "회원 개인 데이터, 키가 회원번호/이름, TTL 없음, 트래픽 낮음
// (회원 15명 규모)"이라는 동일 프로필이라 인스턴스를 나눌 실익이 없다.
// 🔧 [사용자 지시] "기존 값이 있어도 모두 날려버려. 상관없어" — 기존
// KV 데이터는 백필하지 않는다(배포 후 초기화됨).
export class MemberSettingsDO {
  constructor(state) {
    this.state = state;
    this.prefs = new Map(); // memberNumber -> {category: boolean}
    this.statusMsgs = new Map(); // memberNumber -> string
    this.exitResults = new Map(); // "{이름} (퇴실)" -> object
    this.lastLogins = new Map(); // memberNumber -> {ts, ip}
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.list();
      for (const [key, value] of stored) {
        if (key.startsWith("pref:")) this.prefs.set(key.slice(5), value);
        else if (key.startsWith("status:")) this.statusMsgs.set(key.slice(7), value);
        else if (key.startsWith("exit:")) this.exitResults.set(key.slice(5), value);
        else if (key.startsWith("login:")) this.lastLogins.set(key.slice(6), value);
      }
    });
  }

  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/pref") {
      const memberNumber = url.searchParams.get("memberNumber") || "";
      const prefs = this.prefs.get(memberNumber) || null;
      return new Response(JSON.stringify({ prefs }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "POST" && url.pathname === "/pref") {
      const { memberNumber, prefs } = await req.json();
      this.prefs.set(memberNumber, prefs);
      await this.state.storage.put(`pref:${memberNumber}`, prefs);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    if (req.method === "GET" && url.pathname === "/status") {
      const memberNumber = url.searchParams.get("memberNumber") || "";
      const message = this.statusMsgs.get(memberNumber) || "";
      return new Response(JSON.stringify({ message }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "POST" && url.pathname === "/status") {
      const { memberNumber, message } = await req.json();
      this.statusMsgs.set(memberNumber, message);
      await this.state.storage.put(`status:${memberNumber}`, message);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "DELETE" && url.pathname === "/status") {
      const memberNumber = url.searchParams.get("memberNumber") || "";
      this.statusMsgs.delete(memberNumber);
      await this.state.storage.delete(`status:${memberNumber}`);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    if (req.method === "GET" && url.pathname === "/exit") {
      const name = url.searchParams.get("name") || "";
      const entry = this.exitResults.get(name) || null;
      return new Response(JSON.stringify({ entry }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "POST" && url.pathname === "/exit") {
      const { name, entry } = await req.json();
      this.exitResults.set(name, entry);
      await this.state.storage.put(`exit:${name}`, entry);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    // 🔧 [원자적 patch] handleAdminExitBlacklist는 기존 레코드의 blacklist
    // 필드만 뒤늦게 덮어쓴다 — DO 안에서 get+merge+put을 한 번에 처리해
    // Worker에서 get→put 사이에 다른 요청이 끼어들 여지를 없앤다(DO가
    // 요청을 직렬 처리하므로 자동으로 원자적).
    if (req.method === "POST" && url.pathname === "/exit/patch") {
      const { name, patch } = await req.json();
      const existing = this.exitResults.get(name);
      if (!existing) return new Response(JSON.stringify({ ok: false, notFound: true }), { status: 404, headers: { "Content-Type": "application/json" } });
      const updated = { ...existing, ...patch };
      this.exitResults.set(name, updated);
      await this.state.storage.put(`exit:${name}`, updated);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    // 🔧 [순회 조회 최적화] 퇴실자 전원에 대해 개별 get을 병렬 호출하던
    // 3곳(handleAdminExitedMemberList/handleAdminFinesAdminForcedCount/
    // handleAdminBlacklist)을 이 엔드포인트 1회 호출로 대체한다.
    if (req.method === "GET" && url.pathname === "/exit/list") {
      const items = Object.fromEntries(this.exitResults);
      return new Response(JSON.stringify({ items }), { headers: { "Content-Type": "application/json" } });
    }

    // 🔧 [KV → DO 이전, 2026-09-12] lastLogin:{번호}를 이 DO로 이전 —
    // "최근 접속일자·IP" 기록(로그인마다 1회 put)과 조회(관리자 "참여
    // 스터디원 목록"이 회원 전원을 병렬 get 하던 것)를 함께 옮긴다.
    if (req.method === "POST" && url.pathname === "/last-login") {
      const { memberNumber, ts, ip } = await req.json();
      const value = { ts, ip };
      this.lastLogins.set(memberNumber, value);
      await this.state.storage.put(`login:${memberNumber}`, value);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    // 🔧 [순회 조회 최적화] 회원 전원에 대해 개별 get을 병렬 호출하던
    // handleAdminMembersRoster를 이 엔드포인트 1회 호출로 대체한다.
    if (req.method === "GET" && url.pathname === "/last-login/list") {
      const items = Object.fromEntries(this.lastLogins);
      return new Response(JSON.stringify({ items }), { headers: { "Content-Type": "application/json" } });
    }

    return new Response("method not allowed", { status: 405 });
  }
}

function getMemberSettingsStub(env) {
  const id = env.MEMBER_SETTINGS_DO.idFromName("member-settings");
  return env.MEMBER_SETTINGS_DO.get(id);
}

// 🔧 [사용자 지시, 2026-09-12] PUSH_SUBS_KV 전체(구독 원본 sub:{email}:
// {hash} + 인덱스 subIndex:{email})를 이 DO로 이전한다. 도메인이
// 명확히 분리되고(웹 푸시) 항목이 상대적으로 크므로(endpoint+keys)
// 단독 DO로 둔다. 회원 15명×기기 2~3대 규모면 전체가 수십 KB 수준이라
// DO storage에 전혀 무리 없다.
export class PushSubscriptionsDO {
  constructor(state) {
    this.state = state;
    this.subs = new Map(); // "sub:{email}:{hash}" -> {email, subscription, savedAt, deviceLabel, enabled}
    this.index = new Map(); // email -> [{id, deviceLabel, enabled, savedAt}, ...]
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.list();
      for (const [key, value] of stored) {
        if (key.startsWith("sub:")) this.subs.set(key, value);
        else if (key.startsWith("idx:")) this.index.set(key.slice(4), value);
      }
    });
  }

  async fetch(req) {
    const url = new URL(req.url);

    // 🔧 [원자적 구독] 원본 put과 인덱스 갱신을 하나의 DO 호출로 합쳐
    // Worker의 withMemberLock(env, `push:${email}`, ...)을 대체한다 —
    // DO가 요청을 직렬 처리해 같은 이메일의 동시 구독 요청도 레이스
    // 없이 순서대로 처리된다.
    if (req.method === "POST" && url.pathname === "/subscribe") {
      const { email, id, deviceLabel, savedAt, subscription } = await req.json();
      const subValue = { email, subscription, savedAt, deviceLabel, enabled: true };
      this.subs.set(id, subValue);
      const devices = this.index.get(email) || [];
      const idx = devices.findIndex((d) => d.id === id);
      const entry = { id, deviceLabel, enabled: true, savedAt };
      if (idx >= 0) devices[idx] = entry;
      else devices.push(entry);
      this.index.set(email, devices);
      await Promise.all([this.state.storage.put(id, subValue), this.state.storage.put(`idx:${email}`, devices)]);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    if (req.method === "GET" && url.pathname === "/index") {
      const email = url.searchParams.get("email") || "";
      const devices = this.index.get(email) || [];
      return new Response(JSON.stringify({ devices }), { headers: { "Content-Type": "application/json" } });
    }

    if (req.method === "GET" && url.pathname === "/sub") {
      const id = url.searchParams.get("id") || "";
      const entry = this.subs.get(id) || null;
      return new Response(JSON.stringify({ entry }), { headers: { "Content-Type": "application/json" } });
    }

    if (req.method === "POST" && url.pathname === "/device/toggle") {
      const { id, enabled } = await req.json();
      const sub = this.subs.get(id);
      if (!sub) return new Response(JSON.stringify({ ok: false, notFound: true }), { status: 404, headers: { "Content-Type": "application/json" } });
      sub.enabled = !!enabled;
      const devices = this.index.get(sub.email) || [];
      const entry = devices.find((d) => d.id === id);
      if (entry) entry.enabled = !!enabled;
      await Promise.all([this.state.storage.put(id, sub), this.state.storage.put(`idx:${sub.email}`, devices)]);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    if (req.method === "POST" && url.pathname === "/device/rename") {
      const { id, deviceLabel } = await req.json();
      const sub = this.subs.get(id);
      if (!sub) return new Response(JSON.stringify({ ok: false, notFound: true }), { status: 404, headers: { "Content-Type": "application/json" } });
      sub.deviceLabel = deviceLabel;
      const devices = this.index.get(sub.email) || [];
      const entry = devices.find((d) => d.id === id);
      if (entry) entry.deviceLabel = deviceLabel;
      await Promise.all([this.state.storage.put(id, sub), this.state.storage.put(`idx:${sub.email}`, devices)]);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    if (req.method === "POST" && url.pathname === "/device/remove") {
      const { id } = await req.json();
      const sub = this.subs.get(id);
      this.subs.delete(id);
      const puts = [this.state.storage.delete(id)];
      if (sub) {
        const devices = (this.index.get(sub.email) || []).filter((d) => d.id !== id);
        this.index.set(sub.email, devices);
        puts.push(this.state.storage.put(`idx:${sub.email}`, devices));
      }
      await Promise.all(puts);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    // 🔧 [배치 정리] 발송 실패(404/410)로 죽은 구독을 정리할 때, 기존엔
    // 실패마다 개별 delete+개별 인덱스 put이었던 것을 배열로 한 번에
    // 처리한다 — email별로 인덱스 put을 한 번만 하도록 묶는다.
    if (req.method === "POST" && url.pathname === "/device/prune") {
      const { ids } = await req.json();
      const affectedEmails = new Set();
      const puts = [];
      for (const id of ids || []) {
        const sub = this.subs.get(id);
        this.subs.delete(id);
        puts.push(this.state.storage.delete(id));
        if (sub) affectedEmails.add(sub.email);
      }
      for (const email of affectedEmails) {
        const devices = (this.index.get(email) || []).filter((d) => !(ids || []).includes(d.id));
        this.index.set(email, devices);
        puts.push(this.state.storage.put(`idx:${email}`, devices));
      }
      await Promise.all(puts);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    return new Response("method not allowed", { status: 405 });
  }
}

function getPushSubscriptionsStub(env) {
  const id = env.PUSH_SUBSCRIPTIONS_DO.idFromName("push-subscriptions");
  return env.PUSH_SUBSCRIPTIONS_DO.get(id);
}

// 🔧 [사용자 지시, 2026-09-12] 봇 터널 URL(bot:dashboard_url)과 관리자
// Google OAuth 리프레시 토큰(admin_oauth:refresh_token) — 둘 다 "설정값
// 하나, 쓰기 극히 드묾"이라는 동일 프로필. botUrl은 읽기가 매우 잦지만
// (거의 모든 봇 프록시 호출) 실측상 DO fetch(수 ms) 지연은
// proxyToBotDashboard 자체(봇 서버까지 수백ms~수초)에 비해 무시할
// 수준이라 일관성을 위해 함께 옮긴다(사용자 확인).
export class BotAdminConfigDO {
  constructor(state) {
    this.state = state;
    this.config = new Map(); // "botUrl" | "adminOAuthRefreshToken" -> string
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.list();
      for (const [key, value] of stored) this.config.set(key, value);
    });
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/config") {
      const key = url.searchParams.get("key") || "";
      const value = this.config.get(key) || null;
      return new Response(JSON.stringify({ value }), { headers: { "Content-Type": "application/json" } });
    }
    if (req.method === "POST" && url.pathname === "/config") {
      const { key, value } = await req.json();
      this.config.set(key, value);
      await this.state.storage.put(key, value);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("method not allowed", { status: 405 });
  }
}

function getBotAdminConfigStub(env) {
  const id = env.BOT_ADMIN_CONFIG_DO.idFromName("bot-admin-config");
  return env.BOT_ADMIN_CONFIG_DO.get(id);
}

// _dailyUsageBuffer(index.js 상단)를 UsageStats DO로 배치 전송하고 비운다.
// 5분 cron(scheduled)에서 정기적으로 호출되고, handleAdminUsageStatus에서도
// 응답 직전에 한 번 더 호출된다(🔧 [사용자 지시] "5분마다 갱신 이거 조건
// 없앨 수 있나? 폴링 될 때마다 새로 가져오도록" — 버퍼가 비어있으면 즉시
// 반환하므로(위 if문) 이 엔드포인트를 호출하는 관리자 화면(1분 폴링) 정도
// 빈도에서는 DO fetch 오버헤드가 무시할 만하다).
async function flushDailyUsageStats(env) {
  const stub = getUsageStatsStub(env);

  if (_dailyUsageBuffer.size > 0 || _pendingNameFlush.size > 0) {
    const entries = [];
    for (const [key, count] of _dailyUsageBuffer) {
      const parts = key.split("|");
      const op = parts.pop();
      const email = parts.pop();
      const date = parts.shift();
      const kind = parts.shift();
      const path = parts.join("|");
      entries.push({ date, kind, path, email, op, count });
    }
    const names = Object.fromEntries(_pendingNameFlush);
    const res = await stub.fetch("https://do/flush", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries, today: todayUTCDateString(), names }),
    });
    if (res.ok) {
      _dailyUsageBuffer.clear();
      _pendingNameFlush.clear();
    }
  }

  // 🔧 [사용자 지시] "일일 중에서 30분내로 발생한것만 추려서 보여주면
  // 되잖아" — _minuteUsageBuffer(분단위 델타)도 같은 배치 타이밍에 DO로
  // 보내 모든 isolate의 기록을 하나로 모은다. DO가 30분 지난 분단위
  // 키를 스스로 정리하므로(위 /flush-recent) 여기서는 그냥 델타만 보낸다.
  if (_minuteUsageBuffer.size > 0) {
    const recentEntries = [];
    for (const [key, count] of _minuteUsageBuffer) {
      const parts = key.split("|");
      const op = parts.pop();
      const email = parts.pop();
      const minuteKey = parts.shift();
      const kind = parts.shift();
      const path = parts.join("|");
      recentEntries.push({ minuteKey, kind, path, email, op, count });
    }
    const recentRes = await stub.fetch("https://do/flush-recent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: recentEntries }),
    });
    if (recentRes.ok) _minuteUsageBuffer.clear();
  }
}

// key(닉네임 등)별로 fn()을 상호 배타적으로 실행한다 — DO가 죽거나 acquire가
// 예외를 던지는 극단적 상황에서도 fn() 자체가 멈추지 않도록, 락 획득
// 자체가 실패하면(예: DO 일시 장애) 잠금 없이 그냥 진행한다 — 락은 레이스를
// "줄이는" 안전장치이지, 락이 없다고 승인 자체를 막을 정도로 중요하지는
// 않다는 판단(사용자 확인: 시트 반영이 관리자의 유일한 처리 수단이라 완전히
// 막히면 더 큰 문제가 된다).
async function withMemberLock(env, key, fn) {
  const stub = getRosterStub(env);
  const lockKey = `slotlock:${key}`;
  let acquired = false;
  try {
    const res = await stub.fetch(`https://do/lock/acquire?key=${encodeURIComponent(lockKey)}`, { method: "POST" });
    // 🔧 [버그 수정] 원래는 fetch가 예외 없이 응답을 받으면(HTTP 상태와
    // 무관하게) 무조건 acquired = true로 간주했다 — DO가 LOCK_WAIT_TIMEOUT_MS
    // 안에 락을 못 줘서 503(ok:false, timedOut:true)을 응답해도 이를
    // "락을 획득함"으로 잘못 판단해, 나중에 release를 호출하게 됐다. 이
    // release가 실제로는 아무도 쥐고 있지 않은(또는 다른 요청이 이미 새로
    // 쥔) 엔트리를 잘못 건드려, 아직 락 대기 중인 다음 요청을 조기에
    // 풀어주는(release가 큐의 다음 대기자를 next()로 깨움) 이중 실행
    // 가능성을 만들었다. 응답 바디의 ok 값까지 확인해야 정확하다.
    acquired = res.ok;
  } catch {
    // DO 장애 시 잠금 없이 진행(위 주석 참고).
  }
  try {
    return await fn();
  } finally {
    if (acquired) {
      try {
        await stub.fetch(`https://do/lock/release?key=${encodeURIComponent(lockKey)}`, { method: "POST" });
      } catch {
        // release 실패는 무시 — 최악의 경우 해당 key의 락이 그 DO 인스턴스
        // 수명 동안 풀리지 않을 수 있으나, DO는 유휴 시 재시작되며 그때
        // this.locks도 함께 초기화된다.
      }
    }
  }
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

// "진행 중인 제보" 쿨다운/목록 — 같은 DO, notice와 동일한 패턴.
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

function getRosterStub(env) {
  const id = env.PARTICIPANTS_DO.idFromName("gooroomee-room");
  return env.PARTICIPANTS_DO.get(id);
}

async function handlePutParticipants(req, env, origin) {
  const botSecret = req.headers.get("X-Bot-Secret");
  if (!botSecret || botSecret !== env.BOT_SECRET) {
    return json({ error: "unauthorized" }, 401, origin);
  }
  const stub = getRosterStub(env);
  const doRes = await stub.fetch("https://do/participants", {
    method: "PUT",
    body: await req.text(),
    headers: { "Content-Type": "application/json" },
  });
  const data = await doRes.json();
  return json(data, 200, origin);
}

async function handleGetParticipants(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const stub = getRosterStub(env);
  const doRes = await stub.fetch("https://do/participants", { method: "GET" });
  const data = await doRes.json();
  return json(data, 200, origin);
}

// --- Web Push (브라우저 푸시 알림) ---
// 관리자 전용: 구독 등록은 로그인 세션만 있으면 누구나 가능하지만(자기 브라우저를 구독),
// 발송(send)은 ADMIN_EMAIL 계정만 트리거할 수 있다.

async function buildVapidJwk(privateKeyB64url, publicKeyB64url) {
  const pubBytes = base64urlToBytes(publicKeyB64url);
  const x = base64url(pubBytes.slice(1, 33));
  const y = base64url(pubBytes.slice(33, 65));
  return {
    kty: "EC",
    crv: "P-256",
    x,
    y,
    d: privateKeyB64url,
    ext: true,
  };
}

async function createVapidAuthHeader(env, audience) {
  const jwk = await buildVapidJwk(env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY);
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const header = { typ: "JWT", alg: "ES256" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: audience,
    exp: now + 12 * 60 * 60,
    sub: env.VAPID_SUBJECT,
  };
  const encHeader = base64url(new TextEncoder().encode(JSON.stringify(header)));
  const encPayload = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signInput = `${encHeader}.${encPayload}`;

  const sigDer = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signInput)
  );
  // Web Crypto ECDSA 서명은 이미 raw (r||s) 64바이트 포맷으로 반환된다.
  const jwt = `${signInput}.${base64url(sigDer)}`;

  return {
    Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
  };
}

async function encryptPushPayload(payloadText, subscription, env) {
  // RFC 8291 (aes128gcm) 최소 구현
  const p256dh = base64urlToBytes(subscription.keys.p256dh);
  const authSecret = base64urlToBytes(subscription.keys.auth);

  const localKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const localPublicRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", localKeyPair.publicKey)
  );

  const clientPublicKey = await crypto.subtle.importKey(
    "raw",
    p256dh,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: clientPublicKey },
      localKeyPair.privateKey,
      256
    )
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));

  const authInfo = concatBytes([
    new TextEncoder().encode("WebPush: info\0"),
    p256dh,
    localPublicRaw,
  ]);
  const ikm = await hkdf(authSecret, sharedSecret, authInfo, 32);

  const prk = await hkdfExtract(salt, ikm);
  const cekInfo = new TextEncoder().encode("Content-Encoding: aes128gcm\0");
  const cek = await hkdfExpand(prk, cekInfo, 16);
  const nonceInfo = new TextEncoder().encode("Content-Encoding: nonce\0");
  const nonce = await hkdfExpand(prk, nonceInfo, 12);

  // RFC 8188 구분자: 마지막(유일한) 레코드이므로 0x02. 0x00은 유효하지 않아
  // 수신측이 복호화에 실패해 메시지를 조용히 폐기하는 원인이 된다.
  const recordDelimiter = new Uint8Array([2]);
  const plaintext = concatBytes([new TextEncoder().encode(payloadText), recordDelimiter]);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext)
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096, false);
  const header = concatBytes([
    salt,
    recordSize,
    new Uint8Array([localPublicRaw.length]),
    localPublicRaw,
  ]);

  return concatBytes([header, ciphertext]);
}

function concatBytes(arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

async function hmacSha256Raw(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, dataBytes));
}

async function hkdfExtract(salt, ikm) {
  return hmacSha256Raw(salt, ikm);
}

async function hkdfExpand(prk, info, length) {
  const infoWithCounter = concatBytes([info, new Uint8Array([1])]);
  const t1 = await hmacSha256Raw(prk, infoWithCounter);
  return t1.slice(0, length);
}

async function hkdf(salt, ikm, info, length) {
  const prk = await hkdfExtract(salt, ikm);
  return hkdfExpand(prk, info, length);
}

async function sendWebPush(subscription, payloadText, env) {
  const endpointUrl = new URL(subscription.endpoint);
  const audience = `${endpointUrl.protocol}//${endpointUrl.host}`;
  const vapidHeaders = await createVapidAuthHeader(env, audience);
  const body = await encryptPushPayload(payloadText, subscription, env);

  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      ...vapidHeaders,
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: "60",
    },
    body,
  });
  return res;
}

async function requireAdmin(req, env) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return null;
  if (session.email !== (env.ADMIN_EMAIL || "").toLowerCase()) return null;
  return session;
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
  if (session.email === (env.ADMIN_EMAIL || "").toLowerCase()) {
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

// 🔧 [일회성 마이그레이션] 집계!D20(총 모금액) 수식을 고친다. 기존 수식
// `=D21+D22+D23+IF(G4+H4>=1,D24,0)`은 "스터디장(1번 회원)이 이번 주간
// 페널티를 1회 이상 받았으면 D24(퇴실/재납 예치금)를 벌금에 귀속시킨다"는
// 의도였는데, G4/H4가 더 이상 "이번 주간"이 아니라 전체 누적치로 바뀌어
// 조건이 항상 참이 되어버렸다. "이번 주간에 발생했는지"는 이제 '데이터'
// 시트의 슬롯 값(F4:M4, 발생 시점의 페널티 사이클 번호)이 현재 사이클
// (집계!D25)과 같은지로 판단해야 한다 — 사유반휴/총상점 수식이 이미 같은
// 패턴(INDIRECT + COUNTIF vs '집계'!D25)을 쓰고 있어 그대로 맞춘다.
// 실행 한 번으로 끝나는 작업이라 사용 후 이 핸들러와 라우트는 제거할 것.
async function handleMigrateFixCollectMoneyFormula(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    const newFormula =
      "=D21+D22+D23+IF(COUNTIF(INDIRECT(\"'데이터'!F4:M4\"),'집계'!D25)>=1,D24,0)";
    await writeSheetValues(env, accessToken, fileId, [
      { range: "집계!D20", values: [[newFormula]] },
    ]);
    const check = await getSheetValues(env, accessToken, fileId, "집계!D20");
    return json({ ok: true, newFormula, currentValue: check[0] && check[0][0] }, 200, origin);
  } catch (err) {
    return json({ error: "수식 마이그레이션 실패: " + err.message }, 500, origin);
  }
}

// 회원이 종류별로 켜고 끌 수 있는 푸시 알림 카테고리. 아직 각 카테고리를
// 실제 이벤트(제보 승인 등)에 연결하지는 않았고, 지금은 회원의 on/off
// 선호도를 저장/조회하는 것과 관리자가 종류를 골라 수동으로 테스트 발송하는
// 것까지만 지원한다 — 실제 이벤트 연동은 이 저장값을 그대로 재사용해 이어갈
// 예정.
const NOTIFY_CATEGORIES = {
  report_result: "제보 처리 결과",
  leave_proof_result: "사유 반휴 처리 결과",
  fine_status: "벌금 상태 변경",
  exit_result: "퇴실/재납 처리 결과",
  direct_message: "다른 참여자의 알림(귓속말)",
};
function defaultNotifyPrefs() {
  return Object.fromEntries(Object.keys(NOTIFY_CATEGORIES).map((k) => [k, true]));
}

// 🔧 [KV → DO 이전, 2026-09-12] §49 — MemberSettingsDO로 이전.
async function loadNotifyPrefs(env, memberNumber) {
  const res = await getMemberSettingsStub(env).fetch(`https://do/pref?memberNumber=${encodeURIComponent(memberNumber)}`);
  const { prefs } = await res.json();
  return prefs ? { ...defaultNotifyPrefs(), ...prefs } : defaultNotifyPrefs();
}

async function handleGetNotifyPrefs(req, env, origin) {
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

async function handleSetNotifyPrefs(req, env, origin) {
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
async function handleGetStatusMessage(req, env, origin) {
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
async function handleSetStatusMessage(req, env, origin) {
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
async function handleGetMemberStatusMessage(req, env, origin, url) {
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
async function handleAdminPushSendCategory(req, env, origin) {
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
function guessDeviceLabel(userAgent) {
  const ua = userAgent || "";
  let os = "알 수 없는 기기";
  if (/iPhone/i.test(ua)) os = "iPhone";
  else if (/iPad/i.test(ua)) os = "iPad";
  else if (/Android/i.test(ua)) os = "Android";
  else if (/Macintosh/i.test(ua)) os = "Mac";
  else if (/Windows/i.test(ua)) os = "Windows";
  else if (/Linux/i.test(ua)) os = "Linux";

  let browser = "";
  if (/Edg\//i.test(ua)) browser = "Edge";
  else if (/OPR\//i.test(ua) || /Opera/i.test(ua)) browser = "Opera";
  else if (/Chrome\//i.test(ua)) browser = "Chrome";
  else if (/CriOS\//i.test(ua)) browser = "Chrome";
  else if (/FxiOS\//i.test(ua) || /Firefox\//i.test(ua)) browser = "Firefox";
  else if (/Safari\//i.test(ua)) browser = "Safari";

  return browser ? `${os} · ${browser}` : os;
}

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
async function getPushDeviceIndex(env, email) {
  const res = await getPushSubscriptionsStub(env).fetch(`https://do/index?email=${encodeURIComponent(email)}`);
  const { devices } = await res.json();
  return devices || [];
}

async function handlePushSubscribe(req, env, origin) {
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
async function handleListPushDevices(req, env, origin) {
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
async function handlePushDeviceToggle(req, env, origin) {
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
async function handlePushDeviceRename(req, env, origin) {
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
async function handlePushDeviceRemove(req, env, origin) {
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
async function handlePushSendTest(req, env, origin) {
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
async function handlePushSubscriptionStatus(req, env, origin) {
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

async function handlePushSendToMember(req, env, origin) {
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
async function handleListRecentNotices(req, env, origin) {
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

// 로컬 개발(Vite dev 서버, http://localhost:*)에서의 요청은 배포된
// ALLOWED_ORIGIN(GitHub Pages 도메인)과 달라 CORS에 막혀 "Failed to
// fetch"가 난다. 요청의 실제 Origin이 localhost면 그대로 반사(echo)해
// 허용하고, 그 외에는 기존처럼 ALLOWED_ORIGIN 고정값을 쓴다 — 프로덕션
// 오리진 검증(ALLOWED_ORIGIN)을 느슨하게 만들지 않으면서 로컬 개발만 열어준다.
function resolveOrigin(req, env) {
  const requestOrigin = req.headers.get("Origin") || "";
  if (/^https?:\/\/localhost(:\d+)?$/.test(requestOrigin)) return requestOrigin;
  return env.ALLOWED_ORIGIN || "*";
}

export default {
  async fetch(rawReq, rawEnv) {
    // 🔧 [KV 쓰기/삭제 추적, 화면별 특정] env.REPORTS_KV를 계측 프록시로
    // 감싸, 이 요청 처리 중 실행되는 모든 .put()/.delete() 호출을
    // "캐시 종류 × 이 요청의 경로"로 자동 집계한다 — url을 먼저 계산해
    // pathname을 프록시에 넘겨야 하므로 origin 계산보다 앞으로 옮겼다.
    // 아래의 req/env는 이 감싸진 버전을 쓴다.
    const req = rawReq;
    const url = new URL(req.url);
    // 🔧 [사용량 모니터링 고도화, 2026-09-11] "어느 사용자에 의해"까지
    // 집계하려면 이메일이 필요하다. 각 핸들러 내부의 verifySession/
    // requireAdmin(75곳 이상)을 전부 손대는 대신, 여기서 딱 한 번
    // 선제적으로 검증해 얻은 이메일을 지역 변수(요청마다 새로 생성되는
    // fetch 스코프 — 전역이 아니므로 동시 요청끼리 섞일 위험이 없다)에
    // 담아 계측 프록시에 넘긴다. 각 핸들러의 기존 재검증(실제 권한
    // 판정용)은 그대로 둔다 — HMAC 검증 자체가 가벼워 중복 호출 비용은
    // 무시할 수준이다. 세션이 없거나 만료됐으면 null(집계 시 "(익명)").
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const requestSession = token ? await verifySession(token, rawEnv.SESSION_SECRET) : null;
    const requestEmail = requestSession ? requestSession.email : null;
    const requestName = requestSession ? requestSession.memberName : null;
    const env = {
      ...rawEnv,
      REPORTS_KV: instrumentKvNamespace(rawEnv.REPORTS_KV, url.pathname, requestEmail, requestName),
    };
    const origin = resolveOrigin(req, env);

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    try {
      if (url.pathname === "/verify" && req.method === "POST") {
        return await handleVerify(req, env, origin);
      }
      if (url.pathname === "/dev/login" && req.method === "POST") {
        return await handleDevLogin(req, env, origin);
      }
      if (url.pathname === "/report" && req.method === "POST") {
        return await handleReport(req, env, origin);
      }
      if (url.pathname === "/report-cooldowns" && req.method === "GET") {
        return await handleListActiveCooldowns(req, env, origin);
      }
      if (url.pathname === "/reports/capture-done" && req.method === "POST") {
        return await handleReportCaptureDone(req, env, origin);
      }
      if (url.pathname === "/reports" && req.method === "GET") {
        return await handleListReports(req, env, origin);
      }
      if (url.pathname === "/reports/requeue" && req.method === "POST") {
        return await handleRequeueReport(req, env, origin);
      }
      if (url.pathname === "/admin/bot-sheets-usage" && req.method === "POST") {
        return await handleBotSheetsUsageReport(req, env, origin);
      }
      if (url.pathname === "/internal/cycle-boundary" && req.method === "GET") {
        return await handleInternalCycleBoundary(req, env, origin);
      }
      if (url.pathname === "/report-status" && req.method === "GET") {
        return await handleReportStatus(req, env, origin, url);
      }
      if (url.pathname === "/bot/register-url" && req.method === "POST") {
        return await handleBotRegisterUrl(req, env, origin);
      }
      if (url.pathname === "/bot/exit-requests" && req.method === "GET") {
        return await handleBotExitRequests(req, env, origin);
      }
      if (url.pathname === "/bot/invalidate-cache" && req.method === "POST") {
        return await handleBotInvalidateCache(req, env, origin);
      }
      if (url.pathname === "/admin/bot/status" && req.method === "GET") {
        return await handleAdminBotStatus(req, env, origin);
      }
      if (url.pathname === "/admin/usage" && req.method === "GET") {
        return await handleAdminUsageStatus(req, env, origin);
      }
      if (url.pathname === "/admin/bot/command" && req.method === "POST") {
        return await handleAdminBotCommand(req, env, origin);
      }
      if (url.pathname === "/admin/captures" && req.method === "GET") {
        return await handleAdminCapturesList(req, env, origin, url);
      }
      if (url.pathname === "/my-captures" && req.method === "GET") {
        return await handleMyCaptures(req, env, origin, url);
      }
      if (url.pathname === "/my-captures/delete" && req.method === "POST") {
        return await handleMyCaptureDelete(req, env, origin);
      }
      if (url.pathname === "/my-output-pen" && req.method === "GET") {
        return await handleMyOutputPen(req, env, origin, url);
      }
      if (url.pathname === "/captures/target-respond" && req.method === "POST") {
        return await handleCaptureTargetRespond(req, env, origin);
      }
      if (url.pathname === "/admin/captures/file" && req.method === "GET") {
        return await handleAdminCaptureFile(req, env, origin, url);
      }
      if (url.pathname === "/admin/captures/decide" && req.method === "POST") {
        return await handleAdminCaptureDecide(req, env, origin);
      }
      if (url.pathname === "/admin/captures/cancel-penalty" && req.method === "POST") {
        return await handleAdminCaptureCancel(req, env, origin);
      }
      if (url.pathname === "/admin/captures/cancel-merit" && req.method === "POST") {
        return await handleAdminCaptureCancelMerit(req, env, origin);
      }
      if (url.pathname === "/admin/captures/delete" && req.method === "POST") {
        return await handleAdminCaptureDelete(req, env, origin);
      }
      if (url.pathname === "/admin/captures/revert" && req.method === "POST") {
        return await handleAdminCaptureRevert(req, env, origin);
      }
      if (url.pathname === "/admin/captures/vote" && req.method === "POST") {
        return await handleAdminCaptureVote(req, env, origin);
      }
      if (url.pathname === "/participants" && req.method === "PUT") {
        return await handlePutParticipants(req, env, origin);
      }
      if (url.pathname === "/participants" && req.method === "GET") {
        return await handleGetParticipants(req, env, origin);
      }
      if (url.pathname === "/status" && req.method === "GET") {
        return await handleStatus(req, env, origin, url);
      }
      if (url.pathname === "/me/role" && req.method === "GET") {
        return await handleMyRole(req, env, origin);
      }
      if (url.pathname === "/cycles" && req.method === "GET") {
        return await handleCycleList(req, env, origin, url);
      }
      if (url.pathname === "/goal-schedule" && req.method === "GET") {
        return await handleGetGoalSchedule(req, env, origin);
      }
      if (url.pathname === "/goal-schedule" && req.method === "POST") {
        return await handleSetGoalSchedule(req, env, origin);
      }
      if (url.pathname === "/leave-apply" && req.method === "GET") {
        return await handleGetLeaveApply(req, env, origin, url);
      }
      if (url.pathname === "/leave-apply" && req.method === "POST") {
        return await handleSetLeaveApply(req, env, origin);
      }
      if (url.pathname === "/admin/leave-apply" && req.method === "POST") {
        return await handleAdminLeaveApply(req, env, origin);
      }
      if (url.pathname === "/reason-leave-proof" && req.method === "GET") {
        return await handleGetReasonLeaveProof(req, env, origin, url);
      }
      if (url.pathname === "/reason-leave-proof" && req.method === "POST") {
        return await handleSetReasonLeaveProof(req, env, origin);
      }
      if (url.pathname === "/reason-leave-proof/cancel" && req.method === "POST") {
        return await handleCancelReasonLeaveProof(req, env, origin);
      }
      if (url.pathname === "/admin/leave-proof" && req.method === "GET") {
        return await handleAdminLeaveProofList(req, env, origin, url);
      }
      if (url.pathname === "/admin/leave-proof/file" && req.method === "GET") {
        return await handleAdminLeaveProofFile(req, env, origin, url);
      }
      if (url.pathname === "/admin/leave-proof/decide" && req.method === "POST") {
        return await handleAdminLeaveProofDecide(req, env, origin);
      }
      if (url.pathname === "/roster-status" && req.method === "GET") {
        return await handleRosterStatus(req, env, origin, url);
      }
      if (url.pathname === "/admin/members" && req.method === "GET") {
        return await handleAdminMembers(req, env, origin, url);
      }
      if (url.pathname === "/admin/members/roster" && req.method === "GET") {
        return await handleAdminMembersRoster(req, env, origin);
      }
      if (url.pathname === "/admin/members/exited" && req.method === "GET") {
        return await handleAdminExitedMembers(req, env, origin);
      }
      if (url.pathname === "/admin/members/parti-status" && req.method === "POST") {
        return await handleAdminSetPartiStatus(req, env, origin);
      }
      if (url.pathname === "/exit-request" && req.method === "POST") {
        return await handleSetExitRequest(req, env, origin);
      }
      if (url.pathname === "/exit-request/agree" && req.method === "POST") {
        return await handleAgreeExitRequest(req, env, origin);
      }
      if (url.pathname === "/exit-request/cancel" && req.method === "POST") {
        return await handleCancelExitRequest(req, env, origin);
      }
      if (url.pathname === "/admin/members/reorder-preview" && req.method === "GET") {
        return await handleAdminMemberReorderPreview(req, env, origin);
      }
      if (url.pathname === "/admin/members/reorder" && req.method === "POST") {
        return await handleAdminMemberReorder(req, env, origin);
      }
      if (url.pathname.startsWith("/admin/members/") && req.method === "GET") {
        const memberNumber = decodeURIComponent(url.pathname.slice("/admin/members/".length));
        return await handleAdminMemberStatus(req, env, origin, memberNumber, url);
      }
      if (url.pathname === "/admin/members" && req.method === "POST") {
        return await handleAdminCreateMember(req, env, origin);
      }
      if (url.pathname === "/admin/members/grant-access" && req.method === "POST") {
        return await handleGrantMemberAccess(req, env, origin);
      }
      if (url.pathname === "/admin/open-slots" && req.method === "GET") {
        return await handleAdminOpenSlots(req, env, origin);
      }
      if (url.pathname === "/admin/fines/unpaid" && req.method === "GET") {
        return await handleAdminFinesUnpaid(req, env, origin, url);
      }
      if (url.pathname === "/admin/fines/paid" && req.method === "GET") {
        return await handleAdminFinesPaid(req, env, origin, url);
      }
      if (url.pathname === "/admin/fines/exempt" && req.method === "GET") {
        return await handleAdminFinesExempt(req, env, origin, url);
      }
      if (url.pathname === "/admin/fines/status" && req.method === "POST") {
        return await handleAdminFineStatus(req, env, origin);
      }
      if (url.pathname === "/admin/fines/admin-forced-count" && req.method === "GET") {
        return await handleAdminFinesAdminForcedCount(req, env, origin);
      }
      if (url.pathname === "/admin/prize/settle" && req.method === "POST") {
        return await handleAdminPrizeSettle(req, env, origin);
      }
      if (url.pathname === "/admin/exit/candidates" && req.method === "GET") {
        return await handleAdminExitCandidates(req, env, origin, url);
      }
      if (url.pathname === "/admin/exit/preview" && req.method === "POST") {
        return await handleAdminExitPreview(req, env, origin);
      }
      if (url.pathname === "/admin/exit/confirm" && req.method === "POST") {
        return await handleAdminExitConfirm(req, env, origin);
      }
      if (url.pathname === "/admin/exit/blacklist" && req.method === "POST") {
        return await handleAdminExitBlacklist(req, env, origin);
      }
      if (url.pathname === "/admin/blacklist" && req.method === "GET") {
        return await handleAdminBlacklist(req, env, origin);
      }
      if (url.pathname === "/oauth/authorize" && req.method === "GET") {
        return await handleAdminOAuthAuthorize(req, env, origin, url);
      }
      if (url.pathname === "/oauth/callback" && req.method === "GET") {
        return await handleAdminOAuthCallback(req, env, origin, url);
      }
      if (url.pathname === "/push/subscribe" && req.method === "POST") {
        return await handlePushSubscribe(req, env, origin);
      }
      if (url.pathname === "/push/devices" && req.method === "GET") {
        return await handleListPushDevices(req, env, origin);
      }
      if (url.pathname === "/push/devices/toggle" && req.method === "POST") {
        return await handlePushDeviceToggle(req, env, origin);
      }
      if (url.pathname === "/push/devices/rename" && req.method === "POST") {
        return await handlePushDeviceRename(req, env, origin);
      }
      if (url.pathname === "/push/devices/remove" && req.method === "POST") {
        return await handlePushDeviceRemove(req, env, origin);
      }
      if (url.pathname === "/notify-prefs" && req.method === "GET") {
        return await handleGetNotifyPrefs(req, env, origin);
      }
      if (url.pathname === "/notify-prefs" && req.method === "POST") {
        return await handleSetNotifyPrefs(req, env, origin);
      }
      if (url.pathname === "/status-message" && req.method === "GET") {
        return await handleGetStatusMessage(req, env, origin);
      }
      if (url.pathname === "/status-message" && req.method === "POST") {
        return await handleSetStatusMessage(req, env, origin);
      }
      if (url.pathname === "/member-status-message" && req.method === "GET") {
        return await handleGetMemberStatusMessage(req, env, origin, url);
      }
      if (url.pathname === "/admin/push/send-category" && req.method === "POST") {
        return await handleAdminPushSendCategory(req, env, origin);
      }
      if (url.pathname === "/push/send-test" && req.method === "POST") {
        return await handlePushSendTest(req, env, origin);
      }
      if (url.pathname === "/push/send-to-member" && req.method === "POST") {
        return await handlePushSendToMember(req, env, origin);
      }
      if (url.pathname === "/push/subscription-status" && req.method === "GET") {
        return await handlePushSubscriptionStatus(req, env, origin);
      }
      if (url.pathname === "/push/recent-notices" && req.method === "GET") {
        return await handleListRecentNotices(req, env, origin);
      }
      if (url.pathname === "/admin/migrate/fix-collect-money-formula" && req.method === "POST") {
        return await handleMigrateFixCollectMoneyFormula(req, env, origin);
      }
      return json({ error: "not found" }, 404, origin);
    } catch (err) {
      return json({ error: "서버 오류: " + err.message }, 500, origin);
    }
  },

  // 🔧 [90분 자동 위반인정 — 크론 도입] 원래 applyAutoRecognitionForExpired는
  // 별도 크론 없이 GET /admin/captures·GET /my-output-pen 조회 시점에만
  // 지연 평가됐다 — 관리자도 대상자 본인도 한동안 해당 화면을 열지 않으면
  // 90분이 훌쩍 지나도 자동 위반인정 자체가 무기한 보류될 수 있었다
  // (사용자 결정: "90분 후 자동"이라는 문구가 실제로도 시간 기준으로
  // 지켜지도록 크론으로 처리). 두 조회 경로의 지연 평가는 "혹시 크론이
  // 늦게 돌기 전에 조회하는 경우"를 위한 안전망으로 그대로 남겨둔다 —
  // 크론이 이미 처리해 둔 항목은 targetResponse가 채워져 있어 그 경로의
  // 필터(!item.targetResponse)에 걸리지 않으므로 중복 처리 위험이 없다.
  async scheduled(event, rawEnv) {
    const env = { ...rawEnv, REPORTS_KV: instrumentKvNamespace(rawEnv.REPORTS_KV, "(cron)", null) };
    // 🔧 [사용량 모니터링 고도화, 2026-09-11] 하루 누적 버퍼(_dailyUsageBuffer)
    // 를 UsageStats DO로 배치 전송한다 — 기존 90분 위반인정 로직과는 별도
    // try/catch로 분리해, flush 실패가 그 아래 기존 크론 작업을 막지
    // 않게 한다.
    try {
      await flushDailyUsageStats(env);
    } catch (e) {
      console.error("[cron] usage flush 실패:", e);
    }
    const data = await proxyToBotDashboard(env, "/captures");
    if (!data) return; // 봇 연결 불가 — 다음 크론 실행이나 화면 조회 시 안전망이 재시도.
    await applyAutoRecognitionForExpired(env, data.items || []);
  },
};
