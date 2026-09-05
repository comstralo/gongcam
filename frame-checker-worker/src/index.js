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
// KV에 보관해두고, Drive 편집자 추가가 필요할 때만 그 토큰으로 위임 호출한다.
const ADMIN_OAUTH_KV_KEY = "admin_oauth:refresh_token";
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
  const refreshToken = await env.REPORTS_KV.get(ADMIN_OAUTH_KV_KEY);
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
// (2026-08 실제로 RESOURCE_EXHAUSTED 발생) — 매주 1~3만 순환하는 값이라
// 60초 캐싱해도 신선도 문제가 없다. KV에도 함께 저장해(_cacheSetAsync)
// 다른 사용자·다른 isolate 간에도 이 값이 공유되게 한다.
async function getCurrentPenCycle(env, accessToken, fileId) {
  return _cachedCompute(env, `penCycle:${fileId}`, 60_000, async () => {
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
// 특정 회원의 personalStatus 캐시(개인 탭 원본 행)를 인메모리+KV 양쪽에서
// 지운다. 시트에 직접 쓸 때(writeSheetValues)뿐 아니라, 시트를 안 건드리고
// KV만 바꾸는 조작(퇴실 신청 등)이 depositRefundBreakdown처럼 personalStatus
// 캐시가 감싸는 계산 결과에 영향을 줄 때도 재사용한다.
async function invalidatePersonalStatusCache(env, fileId, memberNumber) {
  const cacheKey = `personalStatus:${fileId}:${memberNumber}`;
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
// meritRank:/reportScore:/outputPenSlots:/penSlotGrid:/weeklyPaidFine:)를
// 항상 통째로(부분적으로가 아니라) 무효화하므로, 이 그룹 전체에 대해 키
// 하나짜리 전역 카운터만 두면 충분하다 — 회원별로 갈라지는 outputPenSlots:/
// reportScore:는 아직 계산 중이라 특정 회원 키가 _sheetCache에 존재하지도
// 않는 시점에 무효화가 끼어들 수 있어(그래서 키별 Map으로는 놓칠 수 있음),
// "이 그룹에 속하는 키인지"만 판별해 그룹 공통 카운터를 쓰는 편이 더 정확하다.
// personalStatus:(writeSheetValues가 개별 무효화)처럼 정확히 어떤 키를
// 지우는지 아는 경우는 키별 Map으로 정밀하게 추적한다.
const MEMBER_CACHE_PREFIXES = [
  "members:",
  "meta:",
  "exitStatus:",
  "memberRows:",
  "meritRank:",
  "reportScore:",
  "outputPenSlots:",
  "penSlotGrid:",
  "weeklyPaidFine:",
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

// "진행 중인 제보 쿨다운"/"최근 전송된 알림" 목록을 KV.list()로 매번
// 다시 훑지 않기 위한 인덱스 헬퍼. 이 두 목록은 항목이 "등록되는 순간"과
// "TTL로 자연 만료되는 순간"에만 실제로 바뀌는데, 예전엔 15초 폴링마다
// list()를 새로 호출해 사람 수 x 폴링 횟수만큼 하루 list 할당량(무료 1000회)을
// 소진했다(2026-08 실측: 15명이 1시간만 동시 접속해도 초과). 이제는 항목
// 배열 자체를 파일당 1개의 키에 저장해두고, 등록 시에만 다시 써서(list() 없이
// get 1회 + put 1회) 갱신하고, 조회는 그 값을 그대로 돌려준다 — list()는
// 조회 시점에 만료된 항목이 섞여 있을 때 정리 목적으로만 드물게 쓰인다.
async function _appendToLiveIndex(env, indexKey, item, itemTtlSec) {
  const raw = await env.REPORTS_KV.get(indexKey);
  const now = Date.now();
  let items = [];
  if (raw) {
    try {
      items = JSON.parse(raw).filter((it) => it.expiresAt > now);
    } catch {
      items = [];
    }
  }
  items.push(item);
  // 인덱스 자체의 TTL은 그 안에 남아있는 항목 중 가장 늦게 만료되는 것보다
  // 넉넉히 길게 잡아, 아직 유효한 항목이 있는데 인덱스가 먼저 사라지는 일을 막는다.
  await env.REPORTS_KV.put(indexKey, JSON.stringify(items), { expirationTtl: itemTtlSec + 300 });
  return items;
}

async function _readLiveIndex(env, indexKey) {
  const raw = await env.REPORTS_KV.get(indexKey);
  if (!raw) return [];
  const now = Date.now();
  let items;
  try {
    items = JSON.parse(raw);
  } catch {
    return [];
  }
  const alive = items.filter((it) => it.expiresAt > now);
  // 만료된 항목이 섞여 있었다면(아무도 새로 등록하지 않아 자동 정리가 안 된
  // 경우) 조회 시점에 한 번 걸러내 다시 저장해둔다 — 다음 조회부터는 이미
  // 깨끗한 값을 쓰게 되어, 만료 항목이 계속 쌓여 값이 무한정 커지지 않는다.
  if (alive.length !== items.length && alive.length > 0) {
    const maxExpiresAt = Math.max(...alive.map((it) => it.expiresAt));
    const ttlSec = Math.max(60, Math.ceil((maxExpiresAt - now) / 1000) + 300);
    await env.REPORTS_KV.put(indexKey, JSON.stringify(alive), { expirationTtl: ttlSec }).catch(() => {});
  }
  return alive;
}

// leaveq:(사유반휴 봇 오프라인 대기열) 전용 인덱스. cooldown:/notice:와
// 달리 이 큐는 자연 만료(TTL)가 없고 "봇에 전달됨/승인됨/반려됨/철회됨"
// 시점에 명시적으로 사라져야 하므로, _appendToLiveIndex/_readLiveIndex의
// expiresAt 기반 필터링을 그대로 재사용할 수 없다 — 추가/제거를 직접
// 관리하는 전용 버전을 둔다. 🔧 [실측 계기] 2026-08-27 KV list() 하루
// 한도(1,000회)가 실제로 소진되어 "/admin/members/roster"가 500을
// 냈다(GraphQL 실측: list 1,102회/일). listQueuedReasonLeaveDays가
// buildPersonalStatus 안에서 /status를 열 때마다 list()를 불러 사실상
// 가장 빈번한 list() 발생원이었던 것이 확인되어, 이 큐도 인덱스 방식으로
// 전환한다.
const LEAVEQ_INDEX_KEY = "leaveqIndex:current";

async function _addToLeaveQueueIndex(env, item) {
  const raw = await env.REPORTS_KV.get(LEAVEQ_INDEX_KEY);
  let items = [];
  if (raw) {
    try {
      items = JSON.parse(raw);
    } catch {
      items = [];
    }
  }
  items.push(item);
  await env.REPORTS_KV.put(LEAVEQ_INDEX_KEY, JSON.stringify(items));
}

async function _removeFromLeaveQueueIndex(env, id) {
  const raw = await env.REPORTS_KV.get(LEAVEQ_INDEX_KEY);
  if (!raw) return;
  let items;
  try {
    items = JSON.parse(raw);
  } catch {
    return;
  }
  const next = items.filter((it) => it.id !== id);
  if (next.length !== items.length) {
    await env.REPORTS_KV.put(LEAVEQ_INDEX_KEY, JSON.stringify(next));
  }
}

async function _readLeaveQueueIndex(env) {
  const raw = await env.REPORTS_KV.get(LEAVEQ_INDEX_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// 시트 구조(권한관리·데이터 D~V 등)를 바꾸는 쓰기 작업 뒤에 호출해 캐시가
// 오래된 명단/메타를 계속 돌려주지 않게 한다. 인메모리는 즉시 지우고,
// KV는 비동기로 지운다(호출부가 await하지 않아도 되도록 fire-and-forget).
function invalidateMemberCache(env) {
  // outputPenSlots:/reportScore:는 회원별로 키가 갈라져 있어(예: "outputPenSlots:{fileId}:{number}")
  // 특정 회원 키를 KV에서 콕 집어 지울 수 없다 — 인메모리는 prefix 매칭으로
  // 전부 지우고, KV 쪽은 TTL(5분/30분, 🔧 이전 주석의 "60초/30분"은 outputPenSlots:의
  // 실제 TTL과 어긋난 오기였음)이 짧아 자연 만료를 기다려도 신선도 손실이
  // 작다는 전제로 그냥 둔다.
  // 🔧 [경쟁 조건 수정] 이 그룹 전체는 늘 함께 무효화되므로 세대 카운터도
  // 한 번만 올린다 — 지금 진행 중인 계산(_inFlight, 아직 _sheetCache에
  // 없어 아래 루프에 안 걸리는 것들 포함)이 있다면, 그 계산이 끝나도
  // _cachedCompute가 세대 불일치를 감지해 캐시에 쓰지 않는다.
  _bumpMemberCacheGeneration();
  const kvDeletes = [];
  for (const key of _sheetCache.keys()) {
    if (MEMBER_CACHE_PREFIXES.some((p) => key.startsWith(p))) {
      _sheetCache.delete(key);
      if (env) kvDeletes.push(env.REPORTS_KV.delete(`${KV_CACHE_PREFIX}${key}`).catch(() => {}));
    }
  }
  // exitStatus/memberRows/meritRank/members/meta는 fileId별로 키가 하나뿐이라
  // 인메모리에 아직 없어도(다른 isolate가 채운 KV 항목일 수 있음) KV 쪽은
  // 무조건 지운다. 🔧 [무효화 누락 수정] members:/meta:는 원래 이 무조건
  // 삭제 목록에서 빠져 있었다 — 회원별로 갈라지는 outputPenSlots:/reportScore:와
  // 달리 이 둘도 파일당 1개 키뿐이라 exitStatus:와 똑같이 다뤄야 하는데,
  // 실수로 위 prefix 루프(인메모리에 있을 때만 KV도 지움)에만 의존하고
  // 있었다 — 무효화를 호출한 isolate의 인메모리에 그 순간 항목이 없으면
  // (흔함, TTL 60초/5분으로 짧아 자주 비어있음) 다른 isolate가 채워둔 KV의
  // 신규 회원 누락/구정보가 최대 60초~5분 동안 그대로 남는 문제가 있었다.
  if (env) {
    kvDeletes.push(env.REPORTS_KV.delete(`${KV_CACHE_PREFIX}members:${env.GOOGLE_SHEET_FILE_ID}`).catch(() => {}));
    kvDeletes.push(env.REPORTS_KV.delete(`${KV_CACHE_PREFIX}meta:${env.GOOGLE_SHEET_FILE_ID}`).catch(() => {}));
    kvDeletes.push(env.REPORTS_KV.delete(`${KV_CACHE_PREFIX}exitStatus:${env.GOOGLE_SHEET_FILE_ID}`).catch(() => {}));
    kvDeletes.push(env.REPORTS_KV.delete(`${KV_CACHE_PREFIX}memberRows:${env.GOOGLE_SHEET_FILE_ID}`).catch(() => {}));
    kvDeletes.push(env.REPORTS_KV.delete(`${KV_CACHE_PREFIX}meritRank:${env.GOOGLE_SHEET_FILE_ID}`).catch(() => {}));
    kvDeletes.push(env.REPORTS_KV.delete(`${KV_CACHE_PREFIX}penSlotGrid:${env.GOOGLE_SHEET_FILE_ID}`).catch(() => {}));
    kvDeletes.push(env.REPORTS_KV.delete(`${KV_CACHE_PREFIX}weeklyPaidFine:${env.GOOGLE_SHEET_FILE_ID}`).catch(() => {}));
  }
  return Promise.all(kvDeletes);
}

// 스프레드시트 메타(모든 탭의 sheetId/title)를 가져온다. 시트 복사/삭제/서식
// 지정은 이름이 아니라 숫자 sheetId를 요구하므로, 이름→sheetId 매핑에 쓰인다.
// sheetId는 시트를 삭제·재생성(회원 등록/퇴실 시)해야만 바뀌고 그때마다
// invalidateMemberCache가 무효화하므로, 그 사이엔 몇 분을 캐싱해도 안전하다
// — KV 쓰기 예산을 아끼기 위해 5분으로 넉넉히 잡는다.
async function getSpreadsheetMeta(env, accessToken, fileId) {
  return _cachedCompute(env, `meta:${fileId}`, 5 * 60_000, async () => {
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
// 슬롯 개수로 판정한다. outputPenSlots는 getOutputPenSlots()의 반환값. 송출P와
// 주간P를 구분해서 반환한다(UI가 "송출 P N회 / 주간 P N회" 형태로 따로 보여줌).
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
// 보였다. 이제 getOutputPenSlots()가 이미 buildSlotHistory로 만들어둔
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
// 각자 listAllMembers()를 부르는 상황이 잦아, 60초 TTL 캐시(인메모리+KV)로
// 중복 호출을 흡수한다. 신규등록/퇴실/재납/이동 등 명단을 바꾸는 쓰기 뒤에는
// invalidateMemberCache()로 반드시 무효화한다.
async function listAllMembers(env, accessToken, fileId) {
  return _cachedCompute(env, `members:${fileId}`, 60_000, async () => {
    const rows = await getSheetValues(env, accessToken, fileId, "데이터!A1:V50");
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
// 직접 15개 탭을 다시 조회할 필요 없이 이 한 행만 읽으면 된다.
// 🔧 [열 이동] 집계 탭에서 상점(구 F열)/순위(구 G열)가 한 칸씩 앞으로
// 당겨져 각각 E열/F열이 됐다(범위도 G18→F18로 한 칸 줄어듦).
// 집계!B4:F18은 회원 15명 전체의 상점/순위를 한 범위에 담고 있어, 회원
// 개인 조회(/status)마다 이 전체 범위를 다시 읽을 필요가 없다 — 파일당
// 1개 키로 캐싱해 getPersonalTabRows(30분)와 비슷한 원리로 공유한다.
// 순위는 다른 회원의 상점이 바뀌어야 변하는 값이라 짧게(60초)만 캐싱해도
// "관리자 혼자 여러 번 조회"로 인한 중복 호출을 대부분 없앨 수 있다.
async function getMeritRank(env, accessToken, fileId, memberNumber) {
  const rows = await _cachedCompute(env, `meritRank:${fileId}`, 60_000, () =>
    getSheetValues(env, accessToken, fileId, "집계!B4:F18")
  );
  const row = rows.find((r) => (r[0] || "").toString().trim() === String(memberNumber));
  if (!row) return { merit: "0", rank: "-" };
  return { merit: (row[3] || "0").toString(), rank: (row[4] || "-").toString() };
}

// 🔧 [데이터 시트 통합] 옛 "제보상점" D~L(요일별 점수/K=총점/L=벌점) 구조가
// 사라지고, "데이터" 시트 R~V(제보상점 1~5차 슬롯, 값=발생 시점의 페널티
// 사이클 번호)로 바뀌었다. 개인 탭 C37 수식과 동일하게, 현재 사이클(집계!D25)과
// 일치하는 슬롯 개수 × 0.1이 총점이다. "벌점" 개념은 이제 존재하지 않는다
// (별도 페널티 판정은 송출P/주간P 슬롯이 담당).
// 회원마다 다른 행(reportRow)을 읽는 회원별 캐시. writeSheetValues가 이
// 회원의 개인 탭에 쓰기가 일어날 때 personalStatus 캐시를 지우는 것과
// 같은 이유로, 봇/앱스크립트가 아닌 본인 조작으로 이 값이 바뀔 일은 없어
// getPersonalTabRows와 같은 30분 TTL로 맞춘다.
async function getReportScore(env, accessToken, fileId, reportRow) {
  if (!reportRow) return { total: 0 };
  return _cachedCompute(env, `reportScore:${fileId}:${reportRow}`, 30 * 60_000, async () => {
    const [slotRows, currentCycle] = await Promise.all([
      getSheetValues(env, accessToken, fileId, `데이터!R${reportRow}:V${reportRow}`),
      getCurrentPenCycle(env, accessToken, fileId),
    ]);
    const slotRow = (slotRows && slotRows[0]) || [];
    const count = slotRow.filter((v) => parseInt(v, 10) === currentCycle).length;
    return { total: Math.round(count * 0.1 * 10) / 10 };
  });
}

// "데이터" 탭 F~M열(송출P 1~6차 + 주간P 1~2차)에서 특정 회원(번호+3행)의 슬롯
// 값과, 4차(I)/6차(K) 슬롯에 값이 있을 때만 그 칸의 주석(발생 시점 · 사유)을
// 함께 읽는다. note 조회는 별도 API 호출이라 값이 없는 대부분의 경우엔
// 건너뛰어 비용을 아낀다. timePenValues(L/M)는 appscript.js daily_calc()의
// 판정 결과가 그대로 기록되는 슬롯이라 여기서는 그대로 읽기만 한다.
// 회원별 캐시. 이 값은 관리자가 제보를 승인/취소/삭제할 때만 바뀌는데,
// 그 경로(handleAdminCaptureDecide 등)는 이미 invalidateMemberCache를
// 호출해 즉시 무효화하므로, TTL 자체는 KV 쓰기 예산을 아끼기 위해
// 5분으로 넉넉히 잡는다(회원 15명 × 분당 캐시는 KV 하루 쓰기 한도를
// 압박한다).
async function getOutputPenSlots(env, accessToken, fileId, memberNumber) {
  return _cachedCompute(env, `outputPenSlots:${fileId}:${memberNumber}`, 5 * 60_000, async () => {
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
  });
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
async function getPersonalTabRows(env, accessToken, fileId, memberNumber) {
  // 개인 탭 값은 본인이 이 Worker의 API로 직접 쓰는 경우가 아니면, 실제로는
  // 교시(60분) 단위로 봇이 기록하거나 앱스크립트 트리거(일간/주간 집계)가
  // 돌 때만 바뀐다 — 그 사이엔 몇 번을 조회해도 항상 같은 값이다. 본인이
  // 값을 바꾸는 경로(반휴 신청, 관리자 처리 등)는 writeSheetValues가 이
  // 회원의 캐시를 즉시 무효화하므로, TTL을 교시 주기에 맞춰 넉넉히(30분)
  // 잡아도 "방금 쓴 값이 안 보이는" 문제는 없다 — 회원 수(15)에 비례하는
  // 캐시라 KV 쓰기 폭주를 피하려면 이 TTL이 가장 중요하다.
  return _cachedCompute(env, `personalStatus:${fileId}:${memberNumber}`, 30 * 60_000, () =>
    getSheetValues(env, accessToken, fileId, `${memberNumber}!A1:U${ROW_REPORT_SHEET_ROW + 1}`)
  );
}

// weekOf: 이 조회가 어느 주(백업 파일명 기준 "YYMMDD" 월요일)를 보여주는지 —
// 실시간(라이브 시트) 조회면 null이며, 이 경우 오늘(KST) 기준 이번 주로
// 계산한다. 요일별 실제 캘린더 날짜(days[i].date)를 만드는 데 쓰인다.
async function buildPersonalStatus(env, accessToken, fileId, memberNumber, memberName, weekOf) {
  const rows = await getPersonalTabRows(env, accessToken, fileId, memberNumber);
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

  const reportSheetRow = safeNumber((rows[ROW_REPORT_SHEET_ROW] && rows[ROW_REPORT_SHEET_ROW][2]) || 0);
  const [{ rank: rawRank }, { total: reportTotal }, outputPenSlots, currentCycle, exitRequestRaw] = await Promise.all([
    getMeritRank(env, accessToken, fileId, memberNumber),
    getReportScore(env, accessToken, fileId, reportSheetRow),
    getOutputPenSlots(env, accessToken, fileId, memberNumber),
    getCurrentPenCycle(env, accessToken, fileId),
    // 🔧 [고지지연 반영] depositRefundBreakdown이 amount 계산에 실제 퇴실
    // 신청일을 반영해야 하므로, 원래 이 아래(구 1758행)에서 뒤늦게 조회하던
    // 것을 이 병렬 조회로 앞당긴다.
    env.REPORTS_KV.get(`${EXIT_REQUEST_KV_PREFIX}${memberNumber}`).catch(() => null),
  ]);
  const penCounts = countCurrentCyclePen(outputPenSlots, currentCycle);
  const weeklyOutputPen = penCounts.outputPen;
  const weeklyTimePen = penCounts.timePen;
  let exitRequestDate = null;
  let exitAgreedAt = null;
  try {
    const parsedExitRequest = exitRequestRaw ? JSON.parse(exitRequestRaw) : null;
    exitRequestDate = parsedExitRequest?.exitDate || null;
    exitAgreedAt = parsedExitRequest?.agreedAt || null;
  } catch {
    exitRequestDate = null;
    exitAgreedAt = null;
  }
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
  // exitRequestRaw/exitRequestDate는 위(depositRefundBreakdown 호출 이전)에서
  // 이미 조회·파싱해둔 값을 그대로 재사용한다.

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
    exitRequested: exitRequestRaw !== null,
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
// 넓은 범위라, 더 넓은 쪽 하나로 통일해 캐시/호출 자체를 공유한다. KV
// 쓰기는 파일당 1개 키만 남으므로(회원 수와 무관), TTL을 1분으로 잡아도
// 하루 최악치가 1,440회 수준으로 안전하다.
async function getSharedMemberRows(env, accessToken, fileId, members) {
  return _cachedCompute(env, `memberRows:${fileId}`, 60_000, () => {
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
// "Money" 탭의 "납부" 목록을 열 때마다 다시 읽을 필요가 없는 값이라 짧게
// (60초) 캐싱한다 — 벌금 상태 변경(handleAdminFineStatus)이 이미
// invalidateMemberCache를 호출하므로 그 무효화 대상에 포함시킨다.
async function getWeeklyPaidFineTotal(env, accessToken, fileId) {
  return _cachedCompute(env, `weeklyPaidFine:${fileId}`, 60_000, async () => {
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

async function handleVerify(req, env, origin) {
  const { credential } = await req.json();
  if (!credential) return json({ error: "credential 누락" }, 400, origin);

  let googleUser;
  try {
    googleUser = await verifyGoogleIdToken(credential, env.GOOGLE_CLIENT_ID);
  } catch (err) {
    return json({ error: "구글 인증 실패: " + err.message }, 401, origin);
  }

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
  // 임의로 위조해 넣을 수 없다).
  if (member) {
    const ip = req.headers.get("CF-Connecting-IP") || "";
    await env.REPORTS_KV
      .put(`lastLogin:${member.number}`, JSON.stringify({ ts: Date.now(), ip }))
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

const REPORT_COOLDOWN_SEC = 20 * 60;
const COOLDOWN_INDEX_KEY = "cooldownIndex:current";

async function handleReport(req, env, origin) {
  const { token, nickname, reason, mode } = await req.json();
  if (!token || !nickname) return json({ error: "필수 항목 누락" }, 400, origin);
  if (!reason) return json({ error: "상황 설명을 선택해주세요." }, 400, origin);

  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  // 관리자는 20분 쿨다운을 우회한다 — 같은 대상을 반복 확인해야 하는 경우가 있어서다.
  const isAdmin = (session.email || "").toLowerCase() === (env.ADMIN_EMAIL || "").toLowerCase();

  const trimmedNickname = nickname.slice(0, 50);
  // 쿨다운은 모드와 무관하게 닉네임 기준으로 공유한다 — 스크린샷 제보 직후
  // 영상 제보로 우회해 쿨다운을 피하는 것을 막기 위함이다.
  const cooldownKey = `cooldown:${trimmedNickname}`;
  if (!isAdmin) {
    const onCooldown = await env.REPORTS_KV.get(cooldownKey);
    if (onCooldown) {
      return json({ error: "같은 대상은 20분 내에 다시 제보할 수 없습니다." }, 429, origin);
    }
  }

  const id = crypto.randomUUID();
  const ts = Date.now();
  const entry = {
    id,
    nickname: trimmedNickname,
    reason: (reason || "").slice(0, 200),
    mode: mode === "video" ? "video" : "screenshot",
    reporterEmail: session.email,
    ts,
  };
  await env.REPORTS_KV.put(`report:${id}`, JSON.stringify(entry), {
    expirationTtl: 60 * 60 * 6,
  });
  // 관리자는 재제보 차단(위 429)만 우회할 뿐, "최근 진행된 제보" 목록에는
  // 관리자 제보도 똑같이 보여야 한다 — 그러지 않으면 실제로는 봇에 정상
  // 접수됐는데도 참여자들에게 "제보가 없다"고 잘못 보인다(사용자 지적).
  // 목록 화면(handleListActiveCooldowns)이 "언제 끝나는지"를 계산할 수
  // 있도록 ts도 함께 저장한다 — 값 자체(TTL 만료 여부)로 쿨다운 중인지는
  // 이미 판별되므로, ts는 순수하게 표시용 부가 정보다.
  const cooldownValue = { nickname: trimmedNickname, ts };
  await env.REPORTS_KV.put(cooldownKey, JSON.stringify(cooldownValue), {
    expirationTtl: REPORT_COOLDOWN_SEC,
  });
  // "진행 중인 제보" 목록(handleListActiveCooldowns)이 매 조회마다 KV를
  // 다시 훑지 않도록, 이 등록 시점에 공유 인덱스에도 함께 추가해둔다.
  await _appendToLiveIndex(
    env,
    COOLDOWN_INDEX_KEY,
    { nickname: trimmedNickname, expiresAt: ts + REPORT_COOLDOWN_SEC * 1000 },
    REPORT_COOLDOWN_SEC
  );

  // 봇에 즉시 푸시해서 폴링 지연 없이 바로 캡처를 시작시킨다. proxyToBotDashboard는
  // 실패(터널이 그 순간 끊겨 있는 등) 시 예외 없이 null만 반환하므로 여기서
  // 결과를 신경 쓰지 않는다 — 위 KV 기록은 이미 남아있으니 안전망 폴링
  // (report_intake.py, 훨씬 낮은 빈도)이 놓친 걸 나중에 집어간다.
  await proxyToBotDashboard(env, "/reports/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  });

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

  // list() 대신 handleReport가 등록 시점에 미리 채워둔 인덱스를 읽는다 —
  // 15초 폴링이 몇 명이든 실제 KV.list() 호출 없이 처리된다.
  const items = await _readLiveIndex(env, COOLDOWN_INDEX_KEY);
  items.sort((a, b) => a.expiresAt - b.expiresAt);
  return json({ items }, 200, origin);
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

async function handleListReports(req, env, origin) {
  const botSecret = req.headers.get("X-Bot-Secret");
  if (!botSecret || botSecret !== env.BOT_SECRET) {
    return json({ error: "unauthorized" }, 401, origin);
  }

  const list = await env.REPORTS_KV.list({ prefix: "report:" });
  const entries = [];
  for (const key of list.keys) {
    const raw = await env.REPORTS_KV.get(key.name);
    if (raw) entries.push(JSON.parse(raw));
    await env.REPORTS_KV.delete(key.name);
  }
  entries.sort((a, b) => a.ts - b.ts);
  return json(entries, 200, origin);
}

// --- 도움봇(study_manager_260418.py) 원격 상태/명령 ---
// 봇은 로컬 PC에서 Cloudflare Tunnel(cloudflared)로 자신의 로컬 상태
// 서버를 외부에 노출한다. 이 Worker는 봇이 (재)시작될 때 등록해온
// Tunnel URL을 KV에 저장해두고, 관리자가 상태를 조회하거나 재시작을
// 누를 때만 그 URL로 즉시 요청을 프록시한다 — 주기적 폴링이 없으므로
// KV 쓰기가 봇이 (재)시작될 때만 발생해 무료 티어 쓰기 한도에 안전하다.
const BOT_URL_KV_KEY = "bot:dashboard_url";
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

  await env.REPORTS_KV.put(BOT_URL_KV_KEY, body.url);
  // 봇이 방금 도달 가능해진 시점이므로, 오프라인 동안 쌓인 사유반휴 신청
  // 대기열을 바로 흘려보낸다.
  await flushQueuedReasonLeaveProofs(env);
  return json({ ok: true }, 200, origin);
}

async function proxyToBotDashboard(env, path, options = {}) {
  const url = await env.REPORTS_KV.get(BOT_URL_KV_KEY);
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

// UTC "datetimeHour"(예: "2026-08-28T15:00:00Z") 문자열을 KST 날짜
// 문자열("YYYY-MM-DD")로 변환한다 — Cloudflare Analytics의 date 필터는
// UTC 자정~자정 단위라서, "오늘(KST)" 하루가 UTC로는 어제 15시~오늘
// 14시59분에 걸쳐 있다. 이 함수로 각 시간대 버킷을 KST 기준 날짜로 되돌려
// 재집계해야 한국시간 자정에 정확히 초기화되는 "오늘" 합계가 나온다.
function datetimeHourToKSTDateString(datetimeHour) {
  const ms = Date.parse(datetimeHour);
  if (Number.isNaN(ms)) return null;
  return formatISODate(new Date(ms + 9 * 60 * 60 * 1000));
}

// Cloudflare GraphQL Analytics API로 오늘(KST) 하루치 Workers 요청 수와
// KV 읽기/쓰기 수를 조회한다. CF_API_TOKEN/CF_ACCOUNT_ID가 없으면(토큰
// 미발급) null을 반환 — "Bot·Sheet" 탭이 이 부분만 빈 상태로 보여준다.
async function fetchCloudflareUsage(env) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return null;

  // Cloudflare의 date 필터는 UTC 자정~자정 단위다 — "오늘(KST)"이 UTC로는
  // 어제 날짜에 걸쳐 있을 수 있어(KST 0~9시 = UTC 전날 15~24시), UTC 기준
  // 어제+오늘 이틀을 모두 가져온 뒤 아래에서 datetimeHour를 KST로 되돌려
  // "오늘(KST)"에 해당하는 시간대만 다시 걸러 합산한다.
  const todayKST = todayKSTDateString();
  const utcTodayStr = formatISODate(new Date());
  const utcYesterdayStr = formatISODate(new Date(Date.now() - 24 * 60 * 60_000));
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
          dateGeq: utcYesterdayStr,
          dateLeq: utcTodayStr,
          storageSince,
        },
      }),
    });
    const data = await res.json();
    const account = data && data.data && data.data.viewer && data.data.viewer.accounts && data.data.viewer.accounts[0];
    if (!account) return null;

    const workerGroups = (account.workersInvocationsAdaptive || []).filter(
      (g) => g.dimensions && datetimeHourToKSTDateString(g.dimensions.datetimeHour) === todayKST
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
    const kvGroups = (account.kvOperationsAdaptiveGroups || []).filter(
      (g) => g.dimensions && datetimeHourToKSTDateString(g.dimensions.datetimeHour) === todayKST
    );
    const kvReads = kvGroups
      .filter((g) => ["read", "list"].includes(g.dimensions.actionType))
      .reduce((sum, g) => sum + (g.sum ? g.sum.requests : 0), 0);
    const kvWrites = kvGroups
      .filter((g) => ["write", "delete"].includes(g.dimensions.actionType))
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
        kvStorageBytes: 1_000_000_000,
      },
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

  const data = await proxyToBotDashboard(env, "/" + command, { method: "POST" });
  if (!data) {
    return json({ error: "봇에 연결할 수 없습니다. 봇이 꺼져 있거나 Tunnel이 끊겼을 수 있습니다." }, 502, origin);
  }
  return json(data, 200, origin);
}

// proxyToBotDashboard는 항상 res.json()을 호출해 JSON 응답만 다룰 수 있다.
// 제보 캡처 파일(이미지/영상)은 바이너리이므로, 파싱하지 않고 Response를
// 그대로 넘기는 버전이 별도로 필요하다.
async function proxyToBotDashboardRaw(env, path) {
  const url = await env.REPORTS_KV.get(BOT_URL_KV_KEY);
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
async function attachNextOccurrence(env, items) {
  if (!items.length) return items;
  const accessToken = await getServiceAccountAccessToken(env);
  const fileId = env.GOOGLE_SHEET_FILE_ID;
  const [members, dataRows] = await Promise.all([
    listAllMembers(env, accessToken, fileId),
    _cachedCompute(env, `penSlotGrid:${fileId}`, 60_000, () =>
      getSheetValues(env, accessToken, fileId, `'${OUTPUT_PEN_SHEET_NAME}'!F4:K18`)
    ),
  ]);
  const memberByName = new Map(members.map((m) => [m.name, m]));
  const memberByEmail = new Map(members.map((m) => [m.email.toLowerCase(), m]));

  return items.map((item) => {
    const member = memberByName.get(item.nickname);
    const reporter = memberByEmail.get((item.reporterEmail || "").toLowerCase());
    const nextOccurrence = (() => {
      if (!member) return null;
      const row = dataRows[parseInt(member.number, 10) - 1] || [];
      const slotValues = OUTPUT_PEN_SLOT_COLUMNS.map((_, i) => parseInt(row[i], 10) || 0);
      const slotIndex = slotValues.findIndex((v) => v === 0);
      return slotIndex === -1 ? null : slotIndex + 1;
    })();
    return { ...item, nextOccurrence, reporterName: reporter ? reporter.name : null };
  });
}

// 대기 중(pending)인 제보뿐 아니라, 최근에 승인/반려 처리된 제보도 함께
// 보여준다 — 그러지 않으면 결정 즉시 목록에서 사라져서(봇 manifest의
// reviewStatus가 pending을 벗어나는 순간 필터에서 빠짐), 관리자가 방금
// 반려한 항목이 새로고침 한 번에 마치 없었던 일처럼 통째로 사라져 보인다
// (반려는 시트에 아무것도 안 남기므로 더더욱 흔적이 없어 보임 — 사용자 지적).
const RECENT_DECISION_WINDOW_MS = 24 * 60 * 60 * 1000;

// "다른 관리자 의견 반영"(공동 검토) 실제 구현 — 부스터디장이 제출한 의견을
// 캡처 id별로 저장한다. 캡처 자체(제보 원본)는 REPORTS_KV가 아니라 로컬
// 봇의 capture_manifest.py(플랫 JSON 파일)에 있으므로, 의견은 여기 KV에
// 독립적으로 두고 목록 조회 시점에 join한다. TTL 7일 — 부스터디장이 최대
// 2명뿐이라(사용자 확인) 항목당 최대 2회 KV.get만 필요해 KV.list() 없이도
// 충분히 저렴하다.
const REPORT_VOTE_KV_PREFIX = "reportVote:";
const REPORT_VOTE_TTL_SECONDS = 7 * 24 * 60 * 60;
const REPORT_SEVERITY_VALUES = ["high", "mid", "low", "none"];

async function handleAdminCapturesList(req, env, origin) {
  const auth = await requireAdminOrCoReviewer(req, env);
  if (!auth) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const data = await proxyToBotDashboard(env, "/captures");
  if (!data) {
    return json({ items: [], coReviewers: [] }, 200, origin);
  }
  const now = Date.now();
  const visible = (data.items || []).filter(
    (item) =>
      item.reviewStatus === "pending" ||
      (item.decidedAt && now - item.decidedAt < RECENT_DECISION_WINDOW_MS)
  );
  const withOccurrence = await attachNextOccurrence(env, visible);

  const accessToken = await getServiceAccountAccessToken(env);
  const coReviewers = await getCurrentCoReviewers(env, accessToken, env.GOOGLE_SHEET_FILE_ID);
  const items = await Promise.all(
    withOccurrence.map(async (item) => {
      const votes = {};
      for (const m of coReviewers) {
        const raw = await env.REPORTS_KV.get(`${REPORT_VOTE_KV_PREFIX}${item.id}:${m.number}`).catch(() => null);
        if (!raw) continue;
        try {
          votes[m.number] = JSON.parse(raw);
        } catch {
          // 손상된 값은 무시 — 미제출로 취급.
        }
      }
      return { ...item, votes };
    })
  );
  return json(
    { ...data, items, coReviewers, myMemberNumber: auth.role === "coReviewer" ? auth.memberNumber : null },
    200,
    origin
  );
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
    const accessToken = await getServiceAccountAccessToken(env);
    const coReviewers = await getCurrentCoReviewers(env, accessToken, env.GOOGLE_SHEET_FILE_ID);
    const me = coReviewers.find((m) => m.number === auth.memberNumber);
    if (!me) {
      return json({ error: "더 이상 부스터디장이 아니어서 의견을 제출할 수 없습니다." }, 403, origin);
    }
    await env.REPORTS_KV.put(
      `${REPORT_VOTE_KV_PREFIX}${id}:${me.number}`,
      JSON.stringify({ name: me.name, severity, votedAt: Date.now() }),
      { expirationTtl: REPORT_VOTE_TTL_SECONDS }
    );
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
async function applyOutputPenalty(env, accessToken, fileId, nickname, reason, ts, sendTime, replyTime, captureId) {
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

  return {
    number: member.number,
    name: member.name,
    occurrence,
    isPCount,
    col,
    deductedMinutes: timeDeduction.deductedMinutes,
    dayCol: timeDeduction.dayCol,
  };
}

// applyOutputPenalty()가 방금 기록한 슬롯을 되돌린다 — 관리자가 오적용을
// 바로잡을 수 있게 하는 상시 기능. 값(사이클 번호)과 주석을 모두 지운다.
// col은 승인 응답에 포함된 실제 기록 열(F~K)을 그대로 넘겨받아 사용한다.
// deductedMinutes/dayCol이 있으면(회신 지연으로 시간 차감이 함께 기록됐던
// 경우) 27행의 그 요일 칸에서도 동일한 분만큼 되돌린다.
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
  if (deductedMinutes > 0 && dayCol) {
    const cell = `${memberNumber}!${dayCol}${TIME_DEDUCT_ROW}`;
    writes.push(
      (async () => {
        const existingRows = await getSheetValues(env, accessToken, fileId, cell);
        const existingMinutes = parseSignedHHMM(existingRows[0] && existingRows[0][0]);
        const restoredMinutes = existingMinutes + deductedMinutes;
        const newValue =
          restoredMinutes === 0 ? "" : formatSignedHHMM(Math.abs(restoredMinutes), restoredMinutes < 0 ? "-" : "+");
        await writeSheetValues(env, accessToken, fileId, [{ range: cell, values: [[newValue]] }]);
      })()
    );
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
    await invalidateMemberCache(env); // 페널티 슬롯이 바뀌었으므로 exitStatus 캐시 무효화.
    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "취소 실패: " + err.message }, 500, origin);
  }
}

async function handleAdminCaptureDecide(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { id, decision, nickname, reason, ts, sendTime, replyTime } = await req.json().catch(() => ({}));
  if (!id || (decision !== "approved" && decision !== "rejected")) {
    return json({ error: "잘못된 요청입니다." }, 400, origin);
  }

  let penaltyResult = null;
  if (decision === "approved") {
    if (!nickname) return json({ error: "nickname이 필요합니다." }, 400, origin);
    try {
      const accessToken = await getServiceAccountAccessToken(env);
      penaltyResult = await applyOutputPenalty(
        env,
        accessToken,
        env.GOOGLE_SHEET_FILE_ID,
        nickname,
        reason,
        ts,
        sendTime,
        replyTime,
        id
      );
      await invalidateMemberCache(env); // 페널티 슬롯이 바뀌었으므로 exitStatus 캐시 무효화.
    } catch (err) {
      return json({ error: "시트 반영 실패: " + err.message }, 500, origin);
    }
  }

  const data = await proxyToBotDashboard(env, "/captures/decide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, decision }),
  });
  if (!data) {
    return json({ error: "봇에 연결할 수 없습니다." }, 502, origin);
  }
  return json({ ...data, penalty: penaltyResult }, 200, origin);
}

// 제보 기록 자체를 완전히 말소한다(반려 취소와 달리 되돌릴 수 없음). 이미
// "적용"되어 시트에 페널티가 반영된 항목이면, 봇 쪽 기록을 지우기 전에
// 프론트가 함께 보낸 penalty 정보(applied[item.id])로 먼저 cancelOutputPenalty를
// 호출해 시트도 원상복구한다 — 그러지 않으면 봇 기록은 사라졌는데 시트에는
// 페널티가 남는 불일치가 생긴다.
async function handleAdminCaptureDelete(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { id, penalty } = await req.json().catch(() => ({}));
  if (!id) return json({ error: "id가 필요합니다." }, 400, origin);

  if (penalty && penalty.number && penalty.col) {
    try {
      const accessToken = await getServiceAccountAccessToken(env);
      await cancelOutputPenalty(
        env,
        accessToken,
        env.GOOGLE_SHEET_FILE_ID,
        penalty.number,
        penalty.col,
        penalty.deductedMinutes || 0,
        penalty.dayCol || null
      );
      await invalidateMemberCache(env); // 페널티 슬롯이 바뀌었으므로 exitStatus 캐시 무효화.
    } catch (err) {
      return json({ error: "시트 페널티 취소 실패: " + err.message }, 500, origin);
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

async function handleGetLeaveApply(req, env, origin, url) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const type = url.searchParams.get("type");
  const day = url.searchParams.get("day");
  const config = LEAVE_TYPE_CONFIG[type];
  const col = statusColForDay(day);
  if (!config || col === null) return json({ error: "잘못된 요청입니다." }, 400, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const memberNumber = await resolveMemberNumber(env, accessToken, session);
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

    const data = await proxyToBotDashboard(env, "/leave-proof/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    if (data) return json(data, 200, origin);

    // 🔧 [봇 오프라인 대기열] 봇이 꺼져 있으면 신청 자체를 실패시키지 않고
    // KV에 임시 보관했다가, 봇이 다시 켜져 handleBotRegisterUrl을 호출하는
    // 시점에 자동으로 흘려보낸다(flushQueuedReasonLeaveProofs). 학생 화면에는
    // 큐에 있든 봇에 이미 전달됐든 동일하게 "관리자 확인 중"으로 보인다
    // (handleGetReasonLeaveProof가 큐도 함께 조회).
    const queueId = crypto.randomUUID();
    const ts = Date.now();
    // 🔧 [N+1 → list() 완전 제거] 처음엔 metadata 기반 list()로 N+1(list 후
    // 매 키마다 get())만 없앴는데, list() 자체가 buildPersonalStatus를 거쳐
    // /status를 열 때마다(useRefreshOnVisible 도입 이후 빈도 증가) 호출돼
    // KV list() 하루 한도(1,000회)를 실제로 소진시킨 주된 원인이었다(2026-08-27
    // 실측: "/admin/members/roster" 500 에러로 발견). cooldown:/notice:처럼
    // 인덱스(LEAVEQ_INDEX_KEY)에 요약을 남겨 list() 없이 조회한다. metadata는
    // (imageBase64 없이) 디버깅/전환기 안전망 목적으로 계속 남겨둔다. KV
    // metadata는 1024바이트 제한이 있어 memberName/requesterEmail도 짧게 자른다.
    const summary = {
      id: queueId,
      memberNumber,
      memberName: (memberName || "").slice(0, 50),
      day,
      reason: (reason || "").slice(0, 200),
      requesterEmail: (session.email || "").slice(0, 100),
      count,
      ts,
    };
    await env.REPORTS_KV.put(`leaveq:${queueId}`, JSON.stringify({ ...entry, ts }), { metadata: summary });
    await _addToLeaveQueueIndex(env, summary);
    return json({ ok: true, id: queueId, queued: true }, 200, origin);
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

    // 🔧 [list() 제거] list() 대신 인덱스에서 찾는다 — 배포 시점 기준으로
    // 큐가 비어있음을 확인했으므로(2026-08-27) 별도 백필 없이 전환한다.
    const queued = await _readLeaveQueueIndex(env);
    const match = queued.find((it) => it.memberNumber === memberNumber && it.day === day);
    if (match) {
      await env.REPORTS_KV.delete(`leaveq:${match.id}`);
      await _removeFromLeaveQueueIndex(env, match.id);
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
// 도달 가능해진 순간) KV에 쌓인 leaveq:* 항목을 순서대로 봇에 전달한다.
// 개별 항목 실패는 조용히 건너뛰고(다음 등록 시점에 재시도되도록 큐에 남김)
// 전체 흐름을 막지 않는다 — register-url 응답 자체가 늦어지면 봇 기동에
// 영향을 줄 수 있으므로 항목당 처리도 짧게 유지한다. 다른 leaveq: 조회
// 함수들과 달리 여기는 의도적으로 list()를 그대로 둔다 — 봇 재기동은
// 드문 이벤트라 빈도 부담이 없고, 인덱스(LEAVEQ_INDEX_KEY)가 어떤 이유로든
// 실제 KV 항목과 어긋나더라도(예: 인덱스 쓰기만 실패) 이 함수가 실제 KV를
// 직접 훑어 결국 모든 항목을 처리하는 안전망 역할을 한다.
async function flushQueuedReasonLeaveProofs(env) {
  const list = await env.REPORTS_KV.list({ prefix: "leaveq:" });
  for (const key of list.keys) {
    const raw = await env.REPORTS_KV.get(key.name);
    if (!raw) continue;
    const queueId = key.name.slice("leaveq:".length);
    try {
      const entry = JSON.parse(raw);
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
        await env.REPORTS_KV.delete(key.name);
        await _removeFromLeaveQueueIndex(env, queueId);
      }
    } catch {
      // 파싱 실패 등 복구 불가능한 항목은 다음에도 계속 실패할 것이므로 지운다.
      await env.REPORTS_KV.delete(key.name);
      await _removeFromLeaveQueueIndex(env, queueId);
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

async function handleAdminLeaveProofList(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

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
  return json({ items }, 200, origin);
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

  // 큐(KV)에만 있는 신청이면 봇을 거치지 않고 저장된 base64를 그대로
  // 서빙한다 — 봇이 꺼져 있어도 증빙 미리보기가 가능해야 한다.
  const queuedRaw = await env.REPORTS_KV.get(`leaveq:${id}`);
  if (queuedRaw) {
    try {
      const entry = JSON.parse(queuedRaw);
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

  const { id, decision, memberNumber, day, rejectReason, count: rawCount } = await req.json().catch(() => ({}));
  // count: 이 증빙으로 승인 시 반영할 장수(1 또는 2) — 신청 시점에 학생이
  // 고른 값을 목록 아이템(item.count)에서 그대로 넘겨받는다. 미지정 시 1.
  const count = rawCount === undefined ? 1 : rawCount;
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

  // 큐(KV)에만 있는 신청(봇이 아직 못 받은 것)인지 먼저 확인한다 — 이
  // 경우 봇 프록시를 시도하지 않고 시트 반영 + 큐 삭제로 끝낸다(봇이
  // 꺼져 있어도 관리자가 승인/반려를 완결할 수 있어야 한다).
  const queuedKey = `leaveq:${id}`;
  const isQueued = (await env.REPORTS_KV.get(queuedKey)) !== null;

  try {
    const accessToken = await getServiceAccountAccessToken(env);

    if (decision === "rejected") {
      if (isQueued) {
        await env.REPORTS_KV.delete(queuedKey);
        await _removeFromLeaveQueueIndex(env, id);
        // 큐 확인과 이 시점 사이에 flushQueuedReasonLeaveProofs가 끼어들어
        // 봇에도 같은 id로 레코드가 막 생겼을 수 있다 — 있으면 정리하고,
        // 없으면(대부분의 경우) 404로 조용히 무시된다. 결과와 무관하게
        // 이 요청 자체는 이미 완료된 것으로 응답한다.
        await proxyToBotDashboard(env, "/leave-proof/decide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, decision, rejectReason }),
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
      return json(data, 200, origin);
    }

    // 승인 — handleSetLeaveApply(count 지정)와 동일한 시트 반영 로직을 재사용한다.
    const colLetter = String.fromCharCode("A".charCodeAt(0) + col);
    const [cellRows, leftRows] = await Promise.all([
      getSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, `${memberNumber}!${colLetter}${ROW_REASON_LEAVE_USE + 1}`).catch(() => []),
      getSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, `${memberNumber}!C${ROW_REASON_LEAVE_LEFT + 1}`).catch(() => []),
    ]);
    const prevCount = parseLeaveCount((cellRows[0] && cellRows[0][0]) || "");
    const left = safeNumber((leftRows[0] && leftRows[0][0]) || 0);
    const nextCount = Math.min(MAX_LEAVES_PER_DAY_LIMIT, prevCount + count);
    if (nextCount - prevCount > left) return json({ error: "사유반휴 잔여량이 없습니다." }, 400, origin);

    await writeSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, [
      { range: `${memberNumber}!${colLetter}${ROW_REASON_LEAVE_USE + 1}`, values: [[nextCount]] },
    ]);

    if (isQueued) {
      // 봇을 거치지 않고 처리했으므로 큐에서 지우면 끝나지만, 큐 확인과
      // 이 시점 사이에 flushQueuedReasonLeaveProofs가 끼어들어 봇에도 같은
      // id로 pending 레코드가 막 생겼을 수 있다(레이스) — 있으면 approved로
      // 정리하고, 없으면 404로 조용히 무시된다. 이걸 빼먹으면 시트엔 이미
      // 반영됐는데 관리자 화면엔 처리 못하는 유령 pending이 남는다.
      await env.REPORTS_KV.delete(queuedKey);
      await _removeFromLeaveQueueIndex(env, id);
      await proxyToBotDashboard(env, "/leave-proof/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, decision: "approved" }),
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

const ROSTER_ROW_START = 3; // 시트 4행(0-indexed 3)부터 15명
const ROSTER_ROW_END = 17; // 시트 18행(0-indexed 17)까지

async function buildRosterStatus(env, accessToken, fileId) {
  const [rows, moneyRows, studyLeadSlotRows, cycleRows] = await Promise.all([
    getSheetValues(env, accessToken, fileId, "집계!A4:L18"),
    getSheetValues(env, accessToken, fileId, "집계!D20:D24").catch(() => []),
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

  return {
    members,
    collectMoney,
    fineCarry,
    fineThisWeek,
    fineOuter,
    depositOuter,
    depositOuterIncluded,
    settlement,
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
    const roster = await buildRosterStatus(env, accessToken, targetFileId);
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

async function handleAdminMembers(req, env, origin, url) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const cycleFileId = url ? url.searchParams.get("cycle") : null;
    const { fileId: targetFileId } = await resolveTargetFileId(env, accessToken, cycleFileId);
    const [members, exitedMembers] = await Promise.all([
      listAllMembers(env, accessToken, targetFileId),
      // 🔧 2026-09: "다른 회원 보기"에 퇴실자도 "{이름} (퇴실)"로 포함시켜
      // 관리자가 마지막 참여 시점 기록을 웹에서 조회할 수 있게 한다 —
      // 이전엔 이 탭이 구글 시트를 직접 열어야만 확인 가능했다. 원본
      // 조회일 때만(과거 사이클 백업 파일엔 이 탭이 없음).
      cycleFileId ? Promise.resolve([]) : listExitedMemberEntries(env, accessToken, targetFileId),
    ]);
    return json(
      {
        members: [
          ...members.map((m) => ({ number: m.number, name: m.name, email: m.email })),
          ...exitedMembers,
        ],
      },
      200,
      origin
    );
  } catch (err) {
    return json({ error: "회원 목록 조회 실패: " + err.message }, 500, origin);
  }
}

// "퇴실 스터디원 목록" 전용 — 원본 스프레드시트에 남은 퇴실자 백업 탭
// 각각에, 확정 처리 시점에 저장해둔 결과(EXIT_RESULT_KV_PREFIX)를 함께
// 붙여 반환한다. 이 기능 도입(2026-09) 이전에 처리된 퇴실자는 그 시점에
// 저장된 값이 없으므로 result: null로 내려간다 — 프론트가 "처리 결과를
// 조회할 수 없습니다(이 기능 도입 이전 처리)"로 안내한다.
async function handleAdminExitedMembers(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    const exitedMembers = await listExitedMemberEntries(env, accessToken, fileId);

    const members = await Promise.all(
      exitedMembers.map(async (m) => {
        const raw = await env.REPORTS_KV.get(`${EXIT_RESULT_KV_PREFIX}${m.name}`).catch(() => null);
        let result = null;
        if (raw) {
          try {
            result = JSON.parse(raw);
          } catch {
            result = null;
          }
        }
        return { number: m.number, name: m.name, result };
      })
    );

    return json({ members }, 200, origin);
  } catch (err) {
    return json({ error: "퇴실 스터디원 목록 조회 실패: " + err.message }, 500, origin);
  }
}

// "벌금 납부 대상 처리"(PaidFineList)의 "직권 P" 버튼은 항상 이 사유로
// 고정해서 admin_forced 확정을 요청한다(§AdminMoneyTab.tsx, lockForcedReason)
// — 이 문자열을 바꾸면 여기도 함께 바꿔야 아래 카운트가 계속 맞게 걸린다.
const FINE_UNPAID_ADMIN_FORCED_REASON_LABEL = "직권 사유: 벌금 시한 내 미납자";

// 🔧 2026-09: "직권 P : N건" 배지(§PaidFineList 요일 헤더) 실제 구현 —
// "벌금을 납부하지 않아서 '퇴실 처리 (직권 P)'가 눌려서 퇴실 처리된
// 사용자"(사용자 정의)를 요일별로 센다. 판정 기준은 kind==="admin_forced"
// 이면서 사유가 정확히 위 고정 문구인 것 — 같은 admin_forced라도
// MemberRosterList처럼 관리자가 자유 입력한 사유로 처리된 경우는 세지
// 않는다. 그 사람이 실제로 미납이었던 요일들(breakdown.fineUnpaidDays,
// 확정 시점 스냅샷)을 그대로 credit한다 — 한 사람이 여러 요일에 미납
// 이었으면 각 요일 그룹에 1건씩 더해진다(각 요일 그룹의 "미납" 목록에
// 실제로 그 사람이 있었으므로).
async function handleAdminFinesAdminForcedCount(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    const exitedMembers = await listExitedMemberEntries(env, accessToken, fileId);

    const counts = Object.fromEntries(STATUS_DAYS.map((d) => [d, 0]));
    await Promise.all(
      exitedMembers.map(async (m) => {
        const raw = await env.REPORTS_KV.get(`${EXIT_RESULT_KV_PREFIX}${m.name}`).catch(() => null);
        if (!raw) return; // 이 기능 도입 이전 처리된 퇴실자는 저장된 결과가 없다.
        let result;
        try {
          result = JSON.parse(raw);
        } catch {
          return;
        }
        if (result.kind !== "admin_forced") return;
        const isFineReason = (result.reasons || []).some(
          (r) => r.code === "admin_reason" && r.label === FINE_UNPAID_ADMIN_FORCED_REASON_LABEL
        );
        if (!isFineReason) return;
        for (const day of result.breakdown?.fineUnpaidDays || []) {
          if (day in counts) counts[day] += 1;
        }
      })
    );

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

async function handleAdminFinesUnpaid(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const unpaid = await listUnpaidFines(env, accessToken, env.GOOGLE_SHEET_FILE_ID);
    return json({ unpaid }, 200, origin);
  } catch (err) {
    return json({ error: "벌금 미납 목록 조회 실패: " + err.message }, 500, origin);
  }
}

async function handleAdminFinesPaid(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    const [paid, totalAmount] = await Promise.all([
      listPaidFines(env, accessToken, fileId),
      getWeeklyPaidFineTotal(env, accessToken, fileId),
    ]);
    return json({ paid, totalAmount }, 200, origin);
  } catch (err) {
    return json({ error: "벌금 납부 목록 조회 실패: " + err.message }, 500, origin);
  }
}

async function handleAdminFinesExempt(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const exempt = await listExemptFines(env, accessToken, env.GOOGLE_SHEET_FILE_ID);
    return json({ exempt }, 200, origin);
  } catch (err) {
    return json({ error: "벌금 면제 목록 조회 실패: " + err.message }, 500, origin);
  }
}

async function handleAdminFineStatus(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { number, day, status } = await req.json();
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
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    const col = colIndexToLetter(STATUS_DAY_COLS[dayIndex]);
    await writeSheetValues(env, accessToken, fileId, [
      { range: `${sheetNum}!${col}${ROW_PAYMENT_CHECK + 1}`, values: [[status]] },
    ]);
    await invalidateMemberCache(env); // 납부확인 값이 바뀌었으므로 paymentRows 캐시 무효화.
    return json({ ok: true, number: String(sheetNum), day, status }, 200, origin);
  } catch (err) {
    return json({ error: "납부 상태 변경 실패: " + err.message }, 500, origin);
  }
}

// Money 탭 "상금 수령 대상자 처리"의 "상금 정산 집행" 버튼 — 관리자가 이번 주
// 1~5등 분배를 실제로 지급했다는 걸 시트에 기록하는 단순 마킹. 다른 상태
// 마킹처럼 셀 하나(집계!P6)에 "완료" 문자열을 쓰기만 한다 — 이 값을 읽어서
// 판정에 쓰는 기존 로직(예: buildRosterStatus)은 없어 캐시 무효화도 불필요.
async function handleAdminPrizeSettle(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    await writeSheetValues(env, accessToken, fileId, [{ range: "집계!P6", values: [["완료"]] }]);
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
async function getAllExitRelevantStatus(env, accessToken, fileId, members) {
  return _cachedCompute(env, `exitStatus:${fileId}`, 60_000, async () => {
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
const EXIT_REQUEST_KV_PREFIX = "exitRequest:";
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
const EXIT_RESULT_KV_PREFIX = "exitResult:";
// 🔧 [list() 제거] 회원 수(15명 내외)만큼의 작은 맵이라, cooldown:/notice:/
// leaveq:와 동일한 이유로 list() 대신 인덱스를 쓴다 — 2026-08-27 KV list()
// 하루 한도(1,000회) 소진으로 이 데이터를 쓰는 "/admin/members/roster"가
// 500을 낸 것을 계기로 전환. 회원별로 최대 1건뿐이라 객체(map)로 관리한다.
const EXIT_REQUEST_INDEX_KEY = "exitRequestIndex:current";

// 🔧 [퇴실 프로세스 확장] 신청(exitDate)만으로는 관리자가 바로 정산 처리를
// 할 수 없게 됐다 — 퇴실 예약일이 지나야 회원이 "예치금 정산액에 동의"까지
// 눌러야 하고, 그 동의가 있어야만 관리자 쪽 "정산" 버튼이 활성화된다(사용자
// 지시). 인덱스에도 ts(신청일자)/agreedAt(동의일자, 안 했으면 null)을 함께
// 둔다.
async function _setExitRequestIndexEntry(env, memberNumber, exitDate, ts, agreedAt) {
  const raw = await env.REPORTS_KV.get(EXIT_REQUEST_INDEX_KEY);
  let map = {};
  if (raw) {
    try {
      map = JSON.parse(raw);
    } catch {
      map = {};
    }
  }
  map[memberNumber] = { exitDate: exitDate || null, ts: ts || null, agreedAt: agreedAt ?? null };
  await env.REPORTS_KV.put(EXIT_REQUEST_INDEX_KEY, JSON.stringify(map));
}

async function _removeExitRequestIndexEntry(env, memberNumber) {
  const raw = await env.REPORTS_KV.get(EXIT_REQUEST_INDEX_KEY);
  if (!raw) return;
  let map;
  try {
    map = JSON.parse(raw);
  } catch {
    return;
  }
  if (memberNumber in map) {
    delete map[memberNumber];
    await env.REPORTS_KV.put(EXIT_REQUEST_INDEX_KEY, JSON.stringify(map));
  }
}

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
    const exitRequestValue = { ts, exitDate: exitDate || null, agreedAt: null };
    await env.REPORTS_KV.put(`${EXIT_REQUEST_KV_PREFIX}${memberNumber}`, JSON.stringify(exitRequestValue), {
      metadata: exitRequestValue,
    });
    await _setExitRequestIndexEntry(env, memberNumber, exitDate, ts, null);
    // 🔧 [고지지연 반영] exitRequestDate가 이제 depositRefundBreakdown의
    // amount 계산에 쓰이므로, 신청 직후 본인 화면(personalStatus)과 관리자
    // 목록(exitStatus 등 MEMBER_CACHE_PREFIXES 그룹)에 옛 반환액이 남지
    // 않도록 함께 무효화한다.
    await Promise.all([
      invalidatePersonalStatusCache(env, env.GOOGLE_SHEET_FILE_ID, memberNumber),
      invalidateMemberCache(env),
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
    const raw = await env.REPORTS_KV.get(`${EXIT_REQUEST_KV_PREFIX}${memberNumber}`);
    if (!raw) return json({ error: "퇴실 신청 내역이 없습니다." }, 404, origin);

    let existing;
    try {
      existing = JSON.parse(raw);
    } catch {
      return json({ error: "퇴실 신청 정보를 읽을 수 없습니다." }, 500, origin);
    }
    if (!existing.exitDate) {
      return json({ error: "마지막 참여일이 지정되지 않은 신청입니다." }, 400, origin);
    }
    if (!exitDateSettled(existing.exitDate)) {
      return json({ error: "아직 마지막 참여일의 일간 집계가 끝나지 않았습니다." }, 400, origin);
    }

    const agreedAt = Date.now();
    const updated = { ...existing, agreedAt };
    await env.REPORTS_KV.put(`${EXIT_REQUEST_KV_PREFIX}${memberNumber}`, JSON.stringify(updated), {
      metadata: updated,
    });
    await _setExitRequestIndexEntry(env, memberNumber, existing.exitDate, existing.ts, agreedAt);
    await Promise.all([
      invalidatePersonalStatusCache(env, env.GOOGLE_SHEET_FILE_ID, memberNumber),
      invalidateMemberCache(env),
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
    await env.REPORTS_KV.delete(`${EXIT_REQUEST_KV_PREFIX}${memberNumber}`);
    await _removeExitRequestIndexEntry(env, memberNumber);
    await Promise.all([
      invalidatePersonalStatusCache(env, env.GOOGLE_SHEET_FILE_ID, memberNumber),
      invalidateMemberCache(env),
    ]);
    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "퇴실 신청 취소 실패: " + err.message }, 500, origin);
  }
}

// number -> {exitDate} 맵. list() 대신 EXIT_REQUEST_INDEX_KEY 인덱스를 읽는다
// (2026-08-27 KV list() 하루 한도 소진으로 이 함수를 쓰는 "/admin/members/roster"가
// 500을 낸 것을 계기로 전환).
async function listExitRequests(env) {
  const raw = await env.REPORTS_KV.get(EXIT_REQUEST_INDEX_KEY);
  if (!raw) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(raw)));
  } catch {
    return new Map();
  }
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
async function getCurrentCoReviewers(env, accessToken, fileId) {
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
      getSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, "데이터!A1:V50"),
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

    // 최근 접속일자·IP — 회원마다 lastLogin:{번호} 키를 개별 조회한다(회원
    // 수가 15명 규모라 병렬 조회로 충분히 저렴하다). 이 기능 추가 이전에
    // 저장된 값은 순수 타임스탬프 문자열이라 JSON.parse가 실패하는데, 이
    // 경우 구형 포맷으로 보고 ts만 있는 것으로 취급한다(ip는 알 수 없음).
    const lastLoginByNumber = new Map(
      await Promise.all(
        members.map(async (m) => {
          const raw = await env.REPORTS_KV.get(`lastLogin:${m.number}`).catch(() => null);
          if (!raw) return [m.number, { ts: null, ip: "" }];
          try {
            const parsed = JSON.parse(raw);
            return [m.number, { ts: parsed.ts || null, ip: parsed.ip || "" }];
          } catch {
            return [m.number, { ts: Number(raw) || null, ip: "" }];
          }
        })
      )
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
    const subscribedEmails = new Set();
    let cursor;
    do {
      const page = await env.PUSH_SUBS_KV.list({ prefix: "sub:", cursor });
      for (const key of page.keys) {
        const email = key.name.split(":")[1];
        if (email) subscribedEmails.add(email);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

    const membersWithNotify = await Promise.all(
      members.map(async (m) => {
        const email = emailByNumber.get(m.number) || null;
        const prefs = await loadNotifyPrefs(env, m.number);
        const detail = detailByNumber.get(m.number) || { googleAccount: "", gooroomeeAccount: "", examKind: "" };
        const lastLogin = lastLoginByNumber.get(m.number) || { ts: null, ip: "" };
        const joinDateYYMMDD = joinDateYYMMDDByNumber.get(m.number) || "";
        return {
          ...m,
          joinDate: joinDateYYMMDD && m.joinDate ? `${m.joinDate} (${joinDateYYMMDD})` : m.joinDate,
          pushSubscribed: email ? subscribedEmails.has(email) : false,
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
// 직접 바꿔쓴다. 인원 제한 없이 여러 명을 동시에 부스터디장으로 둘 수 있다.
// 스터디장은 이 API로 건드리지 않는다(퇴실 처리 등 별도 경로로만 관리).
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
    await writeSheetValues(env, accessToken, fileId, [{ range: `${member.number}!L3`, values: [[nextStatus]] }]);
    await invalidateMemberCache(env); // 참여상태(L3)가 바뀌었으므로 exitStatus 캐시 무효화.
    return json({ ok: true, partiStatus: nextStatus }, 200, origin);
  } catch (err) {
    return json({ error: "참여상태 변경 실패: " + err.message }, 500, origin);
  }
}

async function handleAdminExitCandidates(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const candidates = await listExitCandidates(env, accessToken, env.GOOGLE_SHEET_FILE_ID);
    return json({ candidates }, 200, origin);
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
async function resolveExitSourceFileId(env, accessToken, fileId, number, kind) {
  if (kind !== "settle") return { sourceFileId: fileId, fromBackup: false };
  const exitRequestRaw = await env.REPORTS_KV.get(`${EXIT_REQUEST_KV_PREFIX}${number}`).catch(() => null);
  if (!exitRequestRaw) return { sourceFileId: fileId, fromBackup: false };
  let exitDate;
  try {
    exitDate = JSON.parse(exitRequestRaw).exitDate;
  } catch {
    return { sourceFileId: fileId, fromBackup: false };
  }
  if (!exitDate || !exitWeekResetPassed(exitDate)) return { sourceFileId: fileId, fromBackup: false };
  const backup = await findBackupForExitDate(env, accessToken, exitDate);
  if (!backup) {
    throw new Error("퇴실 예약 주차의 백업 시트를 아직 찾을 수 없습니다. 잠시 후 다시 시도해주세요.");
  }
  return { sourceFileId: backup.fileId, fromBackup: true };
}

// 실제로 시트를 바꾸지 않고 discount_ratio/사유/결과 메시지만 계산해 돌려준다.
async function computeExitResult(env, accessToken, fileId, number, name, kind, forcedReason) {
  const { sourceFileId, fromBackup } = await resolveExitSourceFileId(env, accessToken, fileId, number, kind);
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
  let exitProcess = null;
  const exitRequestRaw = await env.REPORTS_KV.get(`${EXIT_REQUEST_KV_PREFIX}${number}`).catch(() => null);
  if (exitRequestRaw) {
    try {
      const parsed = JSON.parse(exitRequestRaw);
      exitProcess = { requestedAt: parsed.ts || null, exitDate: parsed.exitDate || null, agreedAt: parsed.agreedAt || null };
    } catch {
      exitProcess = null;
    }
  }

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
  };
}

async function handleAdminExitPreview(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { number, kind, forcedReason } = await req.json();
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
    const result = await computeExitResult(env, accessToken, fileId, member.number, member.name, kind, forcedReason);
    if (!result) {
      return json({ error: "해당 처리 유형에 해당하지 않는 회원입니다." }, 400, origin);
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
// sourceFileId: 퇴실자 백업 탭을 만들 때 회원 시트를 가져올 원본 — 보통은
// fileId와 같지만, sheet_reset이 이미 지난 뒤 정산 확정 처리를 하는 경우
// (computeExitResult의 resolveExitSourceFileId 참고) "지난 주 자동 백업
// 파일"이 되어, 원본(이미 초기화됨)이 아니라 리셋 전 값을 그대로 담은
// 백업에서 시트를 가져온다(사용자 지시). 원본의 회원 번호 슬롯 자체는
// sourceFileId와 무관하게 항상 이 함수가 template으로 새로 만든다.
async function performExitReset(env, accessToken, fileId, member, resultMsg, kindLabel, sourceFileId) {
  const rowNumber = parseInt(member.number, 10) + 3;
  const backupName = `${member.name} (퇴실)`;
  const effectiveSourceFileId = sourceFileId || fileId;

  const [ids, sourceIds] = await Promise.all([
    getSheetIdsByNames(env, accessToken, fileId, [backupName, member.number, "template"]),
    effectiveSourceFileId === fileId
      ? Promise.resolve(null)
      : getSheetIdsByNames(env, accessToken, effectiveSourceFileId, [member.number]),
  ]);
  const existingBackupId = ids[backupName];
  const memberSheetId = ids[member.number];
  const templateSheetId = ids["template"];
  // 백업 탭의 원본은 sourceFileId 쪽 회원 시트 sheetId — 같은 파일이면 위에서
  // 이미 찾은 memberSheetId를 그대로 쓰고, 다른 파일(지난 주 백업)이면 그
  // 파일 안에서 따로 찾은 sheetId를 쓴다.
  const backupSourceSheetId = sourceIds ? sourceIds[member.number] : memberSheetId;

  if (existingBackupId !== null) {
    await spreadsheetBatchUpdate(env, accessToken, fileId, [{ deleteSheet: { sheetId: existingBackupId } }]);
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
    fileId,
    backupName
  );
  await writeExitResultBox(env, accessToken, fileId, backupSheetId, resultMsg);

  // 🔧 [데이터 감사] "데이터" 원본 행을 초기화하기 전에, 그 시점의 값을
  // "데이터 (감사)"에 스냅샷으로 남기고, 백업 탭의 수식이 원본 대신 이
  // 감사 행을 보도록 통째 치환한다 — appendDataAuditSnapshot 주석 참고
  // (앱스크립트 _set_sheet_init()의 동작을 그대로 재현, 2026-09 추가:
  // 원래 웹 경로엔 이 로직이 없어 번호가 재사용되면 백업 탭 수식이
  // 새 회원 값을 잘못 참조할 위험이 있었다).
  const auditRow = await appendDataAuditSnapshot(env, accessToken, fileId, rowNumber, member.name, "퇴실").catch(
    () => 0
  );
  if (auditRow > 0) {
    await rewriteBackupAuditFormulas(env, accessToken, fileId, backupName, auditRow).catch(() => {});
  }

  const ownerEmail = env.ADMIN_EMAIL;
  await protectSheetForOwnerAndService(env, accessToken, fileId, backupSheetId, ownerEmail);

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
  await invalidateMemberCache(env); // 이메일이 비워져 명단이 바뀌었으므로 캐시 무효화.

  // 🔧 [블랙리스트 계정 저장] 확정 처리(handleAdminExitConfirm)가 이 값을
  // EXIT_RESULT_KV_PREFIX 결과에 함께 담아, "신규 스터디원 등록" 화면이
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
  await invalidateMemberCache(env); // 시트가 재생성되어 sheetId(meta)가 바뀌었으므로 캐시 무효화.
}

async function handleAdminExitConfirm(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { number, kind, forcedReason, blacklist } = await req.json();
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
      const exitRequestRaw = await env.REPORTS_KV.get(`${EXIT_REQUEST_KV_PREFIX}${member.number}`).catch(() => null);
      if (!exitRequestRaw) {
        return json({ error: "퇴실 신청이 접수되지 않은 회원은 정산 퇴실로 처리할 수 없습니다." }, 400, origin);
      }
      let exitRequestParsed;
      try {
        exitRequestParsed = JSON.parse(exitRequestRaw);
      } catch {
        exitRequestParsed = null;
      }
      if (!exitRequestParsed || !exitRequestParsed.agreedAt) {
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

    const result = await computeExitResult(env, accessToken, fileId, member.number, member.name, kind, forcedReason);
    if (!result) {
      return json({ error: "해당 처리 유형에 해당하지 않는 회원입니다." }, 400, origin);
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
      // 대상 아님 — EXIT_RESULT_KV_PREFIX 주석 참고).
      const backupName = `${member.name} (퇴실)`;
      await env.REPORTS_KV.put(
        `${EXIT_RESULT_KV_PREFIX}${backupName}`,
        JSON.stringify({
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
        })
      ).catch(() => {});
    }
    // 실제 처리가 확정됐으니 "퇴실 예약" 신청 표시도 함께 정리한다 — 시트가
    // 이미 초기화된 회원 번호에 예약 뱃지만 남아있으면 혼동을 준다.
    await env.REPORTS_KV.delete(`${EXIT_REQUEST_KV_PREFIX}${member.number}`);
    await _removeExitRequestIndexEntry(env, member.number);
    await invalidateMemberCache(env); // 참여상태(L3)/페널티 슬롯이 바뀌었으므로 exitStatus 캐시 무효화.

    return json({ ok: true, number: member.number, name: member.name, resultMsg: result.resultMsg }, 200, origin);
  } catch (err) {
    return json({ error: "퇴실 처리 확정 실패: " + err.message }, 500, origin);
  }
}

// "퇴실 스터디원 목록"의 블랙리스트 등록/해제 토글(§ExitedMemberList) — 확정
// 처리 시점을 놓쳤거나(forced/settle은 애초에 체크박스가 없었음) 판단을 나중에
// 바꾼 경우를 위해, 이미 저장된 EXIT_RESULT_KV_PREFIX 결과의 blacklist 필드만
// 뒤늦게 덮어쓴다. 토글이 아니라 프론트가 계산한 목표값을 명시적으로 보내게
// 해(다음 상태를 서버가 추측하지 않음) 중복 클릭으로 두 번 반전되는 사고를
// 피한다.
async function handleAdminExitBlacklist(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { name, blacklist } = await req.json();
  if (!name || typeof name !== "string" || typeof blacklist !== "boolean") {
    return json({ error: "대상 이름 또는 블랙리스트 값이 올바르지 않습니다." }, 400, origin);
  }

  try {
    const raw = await env.REPORTS_KV.get(`${EXIT_RESULT_KV_PREFIX}${name}`);
    if (!raw) {
      return json(
        { error: "처리 결과를 조회할 수 없는 회원은 블랙리스트를 변경할 수 없습니다(이 기능 도입 이전 처리)." },
        404,
        origin
      );
    }
    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      return json({ error: "저장된 처리 결과가 손상되어 있습니다." }, 500, origin);
    }
    result.blacklist = blacklist;
    await env.REPORTS_KV.put(`${EXIT_RESULT_KV_PREFIX}${name}`, JSON.stringify(result));
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
async function handleAdminBlacklist(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = env.GOOGLE_SHEET_FILE_ID;
    const exitedMembers = await listExitedMemberEntries(env, accessToken, fileId);

    const results = await Promise.all(
      exitedMembers.map(async (m) => {
        const raw = await env.REPORTS_KV.get(`${EXIT_RESULT_KV_PREFIX}${m.name}`).catch(() => null);
        if (!raw) return null;
        try {
          return { name: m.name, ...JSON.parse(raw) };
        } catch {
          return null;
        }
      })
    );

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
    await env.REPORTS_KV.put(ADMIN_OAUTH_KV_KEY, tokenData.refresh_token);
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
    const rows = await getSheetValues(env, accessToken, env.GOOGLE_SHEET_FILE_ID, "데이터!A1:V50");
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
  await invalidateMemberCache(env); // 번호별 이메일이 이동/재생성되어 명단과 sheetId가 바뀌었으므로 캐시 무효화.
}

async function handleAdminMemberReorder(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const fileId = env.GOOGLE_SHEET_FILE_ID;
  const moved = [];
  try {
    const accessToken = await getServiceAccountAccessToken(env);
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

    // 🔧 [데이터 시트 통합] "권한관리" 탭이 "데이터" 탭으로 흡수됐다. 열
    // 인덱스(B=번호, C=이름, D=이메일)는 그대로라 row[1]/row[3] 접근은 안
    // 바뀌지만, 시트 자체가 D~V까지 넓어져 범위를 A1:V50으로 확장했다.
    const authRows = await getSheetValues(env, accessToken, fileId, "데이터!A1:V50");
    const rowIndex = authRows.findIndex((row) => (row[1] || "").trim() === String(sheetNum));
    if (rowIndex === -1) return json({ error: "존재하지 않는 시트번호입니다." }, 404, origin);
    const existingEmail = parseGoogleEmail(authRows[rowIndex][3]);
    if (existingEmail) return json({ error: `이미 배정된 번호입니다 (${existingEmail}).` }, 409, origin);

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
    await invalidateMemberCache(env); // 신규 이메일이 명단에 추가되었으므로 캐시 무효화.

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

// 각 백업의 페널티 사이클 값(집계!D25, 1→2→3→1 순환)을 읽는다.
async function getBackupCycle(env, accessToken, fileId) {
  const values = await getSheetUnformattedValue(env, accessToken, fileId, "집계!D25");
  const raw = values[0] && values[0][0];
  const num = typeof raw === "number" ? raw : parseInt(raw, 10);
  return [1, 2, 3].includes(num) ? num : null;
}

// "현재 사이클 묶음"을 찾는다: 최신 백업부터 과거로 훑으면서, 사이클값이 1인
// 백업을 만나는 지점(포함)까지가 지금 진행 중인 3주 묶음이다. 그 이전(더
// 과거) 백업은 이전 사이클이므로 제외한다. CYCLE_MAX_LEN은 사이클값이
// 리셋되지 않는 이상 상황에 대비한 안전장치일 뿐, 정상적으로는 사이클=1을
// 만나는 즉시 멈춘다.
async function currentCycleBackups(env, accessToken, backups) {
  const bundle = [];
  for (const backup of backups) {
    if (bundle.length >= CYCLE_MAX_LEN) break;
    const cycle = await getBackupCycle(env, accessToken, backup.fileId);
    bundle.push(backup);
    if (cycle === 1) break;
  }
  return bundle;
}

// 관리자/일반 구분 없이 누구나 "현재 진행 중인 사이클(최대 3주) 중 이미
// 백업된 주차"까지만 조회할 수 있다 — 그 이전 사이클(4주 이상 전)은
// 대상이 아니다. MY/ALL 상단의 "사이클 토글"이 이 목록 + "현재"(실시간,
// fileId 없음)를 함께 보여준다.
async function listCurrentCycleBackups(env, accessToken) {
  const backups = await listBackupFiles(env, accessToken);
  return currentCycleBackups(env, accessToken, backups);
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
    const backups = await listCurrentCycleBackups(env, accessToken);
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
  const backups = await listCurrentCycleBackups(env, accessToken);
  const backup = backups.find((b) => b.fileId === cycleFileId);
  if (!backup) throw new Error("현재 사이클에 속하지 않는 기록입니다.");
  return { fileId: backup.fileId, weekOf: backup.weekOf };
}

// --- 실시간 참여자 명단: 로컬 봇이 PUT으로 갱신, 제보 페이지가 GET으로 조회 ---
// KV는 쓰기 횟수가 하루 1,000회로 제한되어 수 초 간격 갱신에 부적합하므로
// 쓰기 제한이 없는 Durable Object(단일 인스턴스, 메모리 상주)를 사용한다.

const PARTICIPANTS_STALE_MS = 60 * 1000;

export class ParticipantsRoster {
  constructor(state) {
    this.state = state;
    this.members = [];
    this.updatedAt = 0;
  }

  async fetch(req) {
    if (req.method === "PUT") {
      const { members } = await req.json();
      this.members = Array.isArray(members) ? members.slice(0, 200) : [];
      this.updatedAt = Date.now();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (req.method === "GET") {
      const stale = Date.now() - this.updatedAt > PARTICIPANTS_STALE_MS;
      return new Response(
        JSON.stringify({ members: this.members, updatedAt: this.updatedAt, stale }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("method not allowed", { status: 405 });
  }
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
const NOTIFY_PREF_KV_PREFIX = "notifyPref:";

function defaultNotifyPrefs() {
  return Object.fromEntries(Object.keys(NOTIFY_CATEGORIES).map((k) => [k, true]));
}

async function loadNotifyPrefs(env, memberNumber) {
  const raw = await env.REPORTS_KV.get(`${NOTIFY_PREF_KV_PREFIX}${memberNumber}`).catch(() => null);
  if (!raw) return defaultNotifyPrefs();
  try {
    return { ...defaultNotifyPrefs(), ...JSON.parse(raw) };
  } catch {
    return defaultNotifyPrefs();
  }
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
    await env.REPORTS_KV.put(`${NOTIFY_PREF_KV_PREFIX}${memberNumber}`, JSON.stringify(prefs));
    return json({ ok: true, prefs }, 200, origin);
  } catch (err) {
    return json({ error: "알림 설정 저장 실패: " + err.message }, 500, origin);
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

    const list = await env.PUSH_SUBS_KV.list({ prefix: `sub:${member.email}:` });
    if (list.keys.length === 0) {
      return json({ error: `${member.name}님은 아직 알림을 켜지 않았습니다.` }, 404, origin);
    }

    const payload = JSON.stringify({
      title: `[테스트] ${NOTIFY_CATEGORIES[category]}`,
      body: `관리자 테스트 발송 · ${new Date().toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul" })}`,
    });

    let sent = 0;
    for (const key of list.keys) {
      const raw = await env.PUSH_SUBS_KV.get(key.name);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      // enabled가 false로 명시된 기기(사용자가 껐거나, 중복이라 정리한
      // 기기)는 건너뛴다. 필드가 아예 없는 옛 구독(이 기능 추가 전 저장된
      // 것)은 기존처럼 발송 대상으로 취급한다.
      if (parsed.enabled === false) continue;
      const { subscription } = parsed;
      try {
        const res = await sendWebPush(subscription, payload, env);
        if (res.status === 404 || res.status === 410) {
          await env.PUSH_SUBS_KV.delete(key.name);
        } else if (res.status >= 200 && res.status < 300) {
          sent += 1;
        }
      } catch {
        // 개별 구독 발송 실패는 건너뛰고 나머지 구독에는 계속 시도한다.
      }
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
  await env.PUSH_SUBS_KV.put(
    key,
    JSON.stringify({ email: session.email, subscription, savedAt: Date.now(), deviceLabel, enabled: true })
  );

  // 🔧 [알림 켜기 직후 상태가 안 바뀌던 문제 수정] 프론트가 구독 등록
  // 직후 곧바로 /push/devices를 다시 조회해 "이 기기가 서버에도 있는지"
  // 확인하는데, Cloudflare KV는 쓰기 직후 list 조회에 결과적 일관성
  // (eventual consistency)만 보장해 방금 쓴 값이 곧바로 안 보일 수 있다
  // (사용자 지적: "알림이 켜졌습니다" 메시지는 뜨는데 상단 상태·버튼은
  // 계속 "꺼짐"으로 남아있었음). KV를 다시 조회하지 않아도 되도록, 방금
  // 저장한 key 이름과 라벨을 그대로 응답에 실어준다 — "알림 받는 기기"
  // 목록도 같은 이유로 재조회 직후엔 비어 보일 수 있어, 프론트가 이 값을
  // 받아 낙관적으로 목록에 바로 얹을 수 있게 한다.
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

  const list = await env.PUSH_SUBS_KV.list({ prefix: `sub:${session.email}:` });
  const devices = [];
  for (const key of list.keys) {
    const raw = await env.PUSH_SUBS_KV.get(key.name);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      devices.push({
        id: key.name,
        deviceLabel: parsed.deviceLabel || "알 수 없는 기기",
        enabled: parsed.enabled !== false,
        savedAt: parsed.savedAt || null,
      });
    } catch {
      // 손상된 항목은 목록에서 조용히 제외한다.
    }
  }
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

  const raw = await env.PUSH_SUBS_KV.get(id);
  if (!raw) return json({ error: "이미 삭제된 기기입니다." }, 404, origin);
  const parsed = JSON.parse(raw);
  parsed.enabled = !!enabled;
  await env.PUSH_SUBS_KV.put(id, JSON.stringify(parsed));
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

  const raw = await env.PUSH_SUBS_KV.get(id);
  if (!raw) return json({ error: "이미 삭제된 기기입니다." }, 404, origin);
  const parsed = JSON.parse(raw);
  parsed.deviceLabel = trimmed;
  await env.PUSH_SUBS_KV.put(id, JSON.stringify(parsed));
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

  await env.PUSH_SUBS_KV.delete(id);
  return json({ ok: true }, 200, origin);
}

async function handlePushSendTest(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const list = await env.PUSH_SUBS_KV.list({ prefix: `sub:${admin.email}:` });
  if (list.keys.length === 0) {
    return json({ error: "등록된 구독이 없습니다. 먼저 알림을 켜주세요." }, 404, origin);
  }

  const payload = JSON.stringify({
    title: "프레임 체커 테스트 알림",
    body: `관리자 테스트 발송 · ${new Date().toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul" })}`,
  });

  const results = [];
  for (const key of list.keys) {
    const raw = await env.PUSH_SUBS_KV.get(key.name);
    if (!raw) continue;
    const parsed = JSON.parse(raw);
    if (parsed.enabled === false) continue;
    const { subscription } = parsed;
    try {
      const res = await sendWebPush(subscription, payload, env);
      if (res.status === 404 || res.status === 410) {
        await env.PUSH_SUBS_KV.delete(key.name);
      }
      results.push({ key: key.name, status: res.status });
    } catch (err) {
      results.push({ key: key.name, error: err.message });
    }
  }

  return json({ ok: true, results }, 200, origin);
}

const NOTICE_COOLDOWN_SEC = 10 * 60;
const NOTICE_INDEX_KEY = "noticeIndex:current";

// 참여자가 다른 참여자에게 짧은 문구를 푸시 알림으로 보낸다(예: "타이머
// 안 켜졌어요" 같은 실수 알림용). 관리자 전용이 아니라 로그인한 누구나
// 쓸 수 있다 — 제보 메뉴와 접근 수준을 맞춘다. 대상은 닉네임(현재 접속
// 중인 참여자 명단에서 고른 이름)으로 지정하고, applyOutputPenalty와
// 동일하게 listAllMembers의 name과 정확히 일치하는 회원만 찾는다.
// 같은 대상에게는 handleReport의 20분 쿨다운과 같은 원리로 10분 내 중복
// 발송을 막고(notice-cooldown:*), 최근 발송 이력(notice:*)은 REPORTS_KV에
// 남겨 "최근 전송된 알림" 화면이 참여자 전체에게 공유되도록 한다.
// GET /push/subscription-status — "간단한 알림 전송" 화면이 대상자 드롭다운
// 옆에 "(알림구독 X)"를 미리 보여줄 수 있도록, 전체 회원의 웹 푸시 구독
// 여부를 한 번에 반환한다. PUSH_SUBS_KV 키는 `sub:${email}:${hash}` 형태라,
// list({prefix:"sub:"}) 한 번으로 구독 중인 이메일 집합을 얻을 수 있다(회원
// 마다 개별 조회할 필요 없음) — handlePushSendToMember가 발송 시점에 하는
// 것과 같은 판정을, 미리 보여주기 위해 배치로 수행하는 것뿐이다.
async function handlePushSubscriptionStatus(req, env, origin) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const members = await listAllMembers(env, accessToken, env.GOOGLE_SHEET_FILE_ID);

    const subscribedEmails = new Set();
    let cursor;
    do {
      const page = await env.PUSH_SUBS_KV.list({ prefix: "sub:", cursor });
      for (const key of page.keys) {
        const email = key.name.split(":")[1];
        if (email) subscribedEmails.add(email);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

    const items = members.map((m) => ({ name: m.name, subscribed: subscribedEmails.has(m.email) }));
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
  const cooldownKey = `notice-cooldown:${trimmedNickname}`;
  if (!isAdmin) {
    const onCooldown = await env.REPORTS_KV.get(cooldownKey);
    if (onCooldown) {
      return json({ error: "같은 대상에게는 10분 내에 다시 알림을 보낼 수 없습니다." }, 429, origin);
    }
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const members = await listAllMembers(env, accessToken, env.GOOGLE_SHEET_FILE_ID);
    const member = members.find((m) => m.name === nickname);
    if (!member) return json({ error: `"${nickname}" 이름과 일치하는 등록 회원을 찾을 수 없습니다.` }, 404, origin);

    const list = await env.PUSH_SUBS_KV.list({ prefix: `sub:${member.email}:` });
    if (list.keys.length === 0) {
      return json({ error: `${member.name}님은 아직 알림을 켜지 않았습니다.` }, 404, origin);
    }

    const payload = JSON.stringify({
      title: `${session.memberName || "참여자"}님의 알림`,
      body: text,
    });

    let sent = 0;
    for (const key of list.keys) {
      const raw = await env.PUSH_SUBS_KV.get(key.name);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (parsed.enabled === false) continue;
      const { subscription } = parsed;
      try {
        const res = await sendWebPush(subscription, payload, env);
        if (res.status === 404 || res.status === 410) {
          await env.PUSH_SUBS_KV.delete(key.name);
        } else if (res.status >= 200 && res.status < 300) {
          sent += 1;
        }
      } catch {
        // 개별 구독 발송 실패는 건너뛰고 나머지 구독에는 계속 시도한다.
      }
    }

    if (sent === 0) return json({ error: "알림 발송에 실패했습니다." }, 502, origin);

    const ts = Date.now();
    await env.REPORTS_KV.put(cooldownKey, "1", { expirationTtl: NOTICE_COOLDOWN_SEC });
    // "최근 전송된 알림" 화면(handleListRecentNotices)이 매 조회마다
    // KV.list()를 다시 훑지 않도록, 발송 시점에 공유 인덱스에도 추가해둔다.
    const noticeValue = { nickname: trimmedNickname, message: text, senderName: session.memberName || "참여자", ts };
    await _appendToLiveIndex(
      env,
      NOTICE_INDEX_KEY,
      { ...noticeValue, expiresAt: ts + NOTICE_COOLDOWN_SEC * 1000 },
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

  // list() 대신 handlePushSendToMember가 발송 시점에 미리 채워둔 인덱스를
  // 읽는다 — 15초 폴링이 몇 명이든 실제 KV.list() 호출 없이 처리된다.
  const items = await _readLiveIndex(env, NOTICE_INDEX_KEY);
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
  async fetch(req, env) {
    const origin = resolveOrigin(req, env);
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    try {
      if (url.pathname === "/verify" && req.method === "POST") {
        return await handleVerify(req, env, origin);
      }
      if (url.pathname === "/report" && req.method === "POST") {
        return await handleReport(req, env, origin);
      }
      if (url.pathname === "/report-cooldowns" && req.method === "GET") {
        return await handleListActiveCooldowns(req, env, origin);
      }
      if (url.pathname === "/reports" && req.method === "GET") {
        return await handleListReports(req, env, origin);
      }
      if (url.pathname === "/admin/bot-sheets-usage" && req.method === "POST") {
        return await handleBotSheetsUsageReport(req, env, origin);
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
        return await handleAdminCapturesList(req, env, origin);
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
      if (url.pathname === "/admin/captures/delete" && req.method === "POST") {
        return await handleAdminCaptureDelete(req, env, origin);
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
        return await handleAdminLeaveProofList(req, env, origin);
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
        return await handleAdminFinesUnpaid(req, env, origin);
      }
      if (url.pathname === "/admin/fines/paid" && req.method === "GET") {
        return await handleAdminFinesPaid(req, env, origin);
      }
      if (url.pathname === "/admin/fines/exempt" && req.method === "GET") {
        return await handleAdminFinesExempt(req, env, origin);
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
        return await handleAdminExitCandidates(req, env, origin);
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
};
