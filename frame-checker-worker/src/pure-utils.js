// 🔧 [구조 개선, 2026-09-13] 회원 관리/알림·푸시 도메인에서 완전 순수하고
// 짧은 함수 6개를 index.js에서 분리했다(docs/TESTING.md 참고) — 이 도메인
// 핵심 함수(handleAdminCreateMember/moveMemberSlot/handleAdminMembersRoster
// 등)는 fetch 4~8회 + DO 왕복이 뒤섞인 5~7단계 체인이라 순수 로직을 뽑아낼
// 여지가 이미 소진되어 있고, 웹푸시 암호화 함수(HKDF/encryptPushPayload 등)
// 는 RFC 표준 구현이라 이번 범위에서 제외했다(사용자 확인) — 이번엔 아래
// 6개만 옮긴다. base64url/base64urlToBytes/NOTIFY_CATEGORIES는 index.js
// 전역에서 광범위하게 쓰이는 범용 유틸이라 옮기지 않고 export만 추가해
// 여기서 import한다.
import { base64url, base64urlToBytes, NOTIFY_CATEGORIES } from "./index.js";

// 🔧 [회원 계정 통합] "구글계정,구루미계정" 형식으로 한 셀에 함께 저장한다
// (구루미 계정을 저장할 별도 컬럼이 없어 기존 이메일 칸에 함께 넣기로 함 —
// 사용자 확인). 로그인 매칭 등 "구글 이메일"이 필요한 모든 지점은 항상 이
// 헬퍼로 앞부분만 뽑아 써야 한다 — 그러지 않으면 콤마가 이메일 문자열에
// 섞여 정확 일치 비교가 깨진다.
export function parseGoogleEmail(rawCell) {
  return (rawCell || "").split(",")[0].trim().toLowerCase();
}
export function parseGooroomeeAccount(rawCell) {
  const parts = (rawCell || "").split(",");
  return (parts[1] || "").trim();
}

// 🔧 [중복 제거, 2026-09-21] "회원번호는 1~15"라는 동일한 검증식이
// fines.js/exit-confirm.js(2곳)/leave.js(2곳)/members.js 6곳에 각자
// 하드코딩되어 있었다(전수조사에서 발견) — 정원이 바뀌면 하나를 빠뜨릴
// 위험이 있어 상수+헬퍼로 통합한다. sheetNum이 parseInt(number, 10)의
// 결과라 NaN일 수 있는데, 기존 호출부가 전부 `!sheetNum`으로 NaN/0을
// 함께 걸러내던 의미를 그대로 보존한다(NaN은 <, > 비교 모두 false라
// 범위 체크만으로는 안 걸러짐).
export const MEMBER_NUMBER_MIN = 1;
export const MEMBER_NUMBER_MAX = 15;
export function isValidMemberNumber(sheetNum) {
  return Boolean(sheetNum) && sheetNum >= MEMBER_NUMBER_MIN && sheetNum <= MEMBER_NUMBER_MAX;
}

// 🔧 [중복 제거, 2026-09-21] "listAllMembers로 받은 배열에서 번호로 찾고,
// 없으면 404 JSON을 반환"하는 동일한 3줄이 exit-confirm.js(2곳)/
// members.js/personal-status.js 4곳에 그대로 반복되고 있었다(전수조사에서
// 발견) — findMemberNumberByEmail(index.js, 이메일 기반 조회)과 짝을
// 이루는 "번호 기반 조회" 헬퍼가 없던 공백이다. 호출부마다 number를
// 문자열(String(sheetNum)/memberNumber)로 넘기던 방식이 조금씩 달라
// 여기서 String()으로 통일해 흡수한다 — members 배열의 number 필드
// 자체가 항상 문자열이므로(listAllMembers) 안전하다.
export function findMemberByNumber(members, number) {
  const target = String(number);
  return members.find((m) => m.number === target) || null;
}

export async function buildVapidJwk(privateKeyB64url, publicKeyB64url) {
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

export function concatBytes(arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

export function defaultNotifyPrefs() {
  return Object.fromEntries(Object.keys(NOTIFY_CATEGORIES).map((k) => [k, true]));
}

// User-Agent로 "이 기기가 대략 뭔지" 사람이 알아볼 수 있는 이름을 추정한다.
// 브라우저는 보안상 실제 기기 고유명(예: 사용자가 붙인 아이폰 이름, PC
// 계정명)을 웹사이트에 절대 넘겨주지 않으므로, User-Agent에서 뽑을 수 있는
// OS/브라우저 종류까지만 추정할 수 있다 — 같은 종류의 기기가 여러 대면
// 이름이 겹칠 수 있다(정확한 개체 식별이 목적이 아니라, "대략 이런
// 기기다"를 보여주는 용도).
export function guessDeviceLabel(userAgent) {
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
