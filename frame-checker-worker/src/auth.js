// 🔧 [구조 개선 14차, 2026-09-13] 로그인/OAuth 도메인을 index.js에서
// 옮겼다(docs/TESTING.md 참고). signSession/verifySession, base64url류,
// getServiceAccountAccessToken, findMemberNumberByEmail, getMemberSettingsStub,
// getBotAdminConfigStub, getAdminAccessToken이 의존하는 exchangeAdminOAuthCode/
// adminOAuthRedirectUri/ADMIN_OAUTH_SCOPE/ADMIN_OAUTH_CONFIG_KEY는 index.js의
// 다른 도메인(members.js/exit.js의 grantSheetAccess 등)과도 공유하는 범용
// 유틸이라 index.js에 남기고 export만 추가했다. GOOGLE_CERTS_URL/
// SESSION_TTL_SEC는 이 파일에서만 쓰여 그대로 옮겼다.
import {
  json,
  base64urlToBytes,
  getServiceAccountAccessToken,
  findMemberNumberByEmail,
  getMemberSettingsStub,
  signSession,
  verifySession,
  getBotAdminConfigStub,
  ADMIN_OAUTH_CONFIG_KEY,
  ADMIN_OAUTH_SCOPE,
  adminOAuthRedirectUri,
  exchangeAdminOAuthCode,
} from "./index.js";

const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const SESSION_TTL_SEC = 30 * 24 * 60 * 60;

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
    // 🔧 [사용자 지시] "'최근 접속 IP' 출력 값에 () 로 브라우저 유형도
    // 붙여줘" — User-Agent 원본을 저장해두고, 표시 시점(guessDeviceLabel,
    // pure-utils.js)에 "OS · 브라우저" 형태로 가공한다. 원본을 저장하는
    // 이유는 라벨링 규칙이 나중에 바뀌어도 과거 기록에 소급 적용할 수
    // 있게 하기 위함. 이 필드 추가 이전에 로그인한 기록은 값이 없다.
    const userAgent = req.headers.get("User-Agent") || "";
    await getMemberSettingsStub(env)
      .fetch("https://do/last-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberNumber: member.number, ts: Date.now(), ip, userAgent }),
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

export async function handleVerify(req, env, origin) {
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
export async function handleDevLogin(req, env, origin) {
  if (!env.DEV_LOGIN_SECRET) return json({ error: "not found" }, 404, origin);
  const secret = req.headers.get("X-Dev-Login-Secret");
  if (!secret || secret !== env.DEV_LOGIN_SECRET) {
    return json({ error: "unauthorized" }, 401, origin);
  }
  const { email, name } = await req.json().catch(() => ({}));
  if (!email) return json({ error: "email 누락" }, 400, origin);

  return completeLogin(req, env, origin, { email: email.toLowerCase(), name: name || email }, { recordLastLogin: false });
}

// --- 관리자 전용: Drive 위임 OAuth 연동 (1회 설정) ---
// 브라우저에서 여는 링크라 Authorization 헤더를 못 쓰므로, 세션 토큰을
// 쿼리 파라미터로 검증한다.

async function requireAdminFromQuery(req, env, url) {
  const token = url.searchParams.get("token") || "";
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return null;
  if ((session.email || "").toLowerCase() !== (env.ADMIN_EMAIL || "").toLowerCase()) return null;
  return session;
}

// 🔧 [사용자 지시] "관리자 OAuth 콜백 CSRF 방어" — 콜백(handleAdminOAuthCallback)
// 이 원래 code 파라미터만 확인하고 이 요청이 실제로 handleAdminOAuthAuthorize
// 가 시작한 흐름인지 검증하지 않았다. 표준 OAuth state 파라미터를 도입해,
// authorize 단계에서 서버가 서명한 1회용 값(짧은 만료)을 실어 보내고 콜백에서
// 그 서명·만료·용도(purpose)를 재검증한다 — 별도 저장소 없이 signSession/
// verifySession(HMAC 서명, exp 검증)을 그대로 재사용하는 stateless 방식.
// purpose 필드로 일반 로그인 세션과 절대 혼동되지 않게 구분한다.
const ADMIN_OAUTH_STATE_PURPOSE = "admin_oauth_state";
const ADMIN_OAUTH_STATE_TTL_SEC = 10 * 60; // authorize→콜백까지 사람이 오가는 흐름이라 10분이면 충분.

export async function handleAdminOAuthAuthorize(req, env, origin, url) {
  const admin = await requireAdminFromQuery(req, env, url);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const state = await signSession(
    { purpose: ADMIN_OAUTH_STATE_PURPOSE, email: admin.email, exp: Date.now() / 1000 + ADMIN_OAUTH_STATE_TTL_SEC },
    env.SESSION_SECRET
  );

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", env.ADMIN_OAUTH_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", adminOAuthRedirectUri(env));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", ADMIN_OAUTH_SCOPE);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("login_hint", admin.email);
  authUrl.searchParams.set("state", state);

  return Response.redirect(authUrl.toString(), 302);
}

export async function handleAdminOAuthCallback(req, env, origin, url) {
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) return new Response(`연동 실패: ${error}`, { status: 400 });
  if (!code) return new Response("code 파라미터가 없습니다.", { status: 400 });

  const state = await verifySession(url.searchParams.get("state") || "", env.SESSION_SECRET);
  if (!state || state.purpose !== ADMIN_OAUTH_STATE_PURPOSE) {
    return new Response("state 파라미터가 유효하지 않거나 만료되었습니다. 처음부터 다시 시도해주세요.", { status: 400 });
  }

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
