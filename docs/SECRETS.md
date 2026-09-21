# 백엔드 시크릿 지도 (SECRETS.md)

> 이 문서는 `frame-checker-worker`가 `wrangler secret`으로 등록해 쓰는
> 시크릿 15개의 목록·용도·소스상 사용 위치를 정리한 참조 문서입니다.
> `npx wrangler secret list`는 이름만 보여주고 값이나 용도는 알려주지
> 않아, 몇 달 뒤 "이 시크릿이 뭐였지"를 매번 코드에서 grep해야 하는
> 문제가 있었습니다 — 이 문서가 그 grep을 대신합니다.
>
> 작성 시점: 2026-09-21. 시크릿을 추가/제거하면(`wrangler secret put`/
> `delete`) 이 표도 함께 갱신해야 합니다 — 실제 등록 여부의 최종 진실은
> 항상 `npx wrangler secret list`(frame-checker-worker/ 안에서 실행)이고,
> 이 문서는 "그 이름이 왜 필요한지"를 보충하는 용도입니다.

## 1. 시크릿 vs 공개 변수

값을 안다고 공격에 쓸 수 있는 게 아니면 시크릿이 아닙니다. 예를 들어
`STREAM_CHAT_API_KEY`(Stream Chat App Key)는 Stream 관례상 프론트에도
그대로 노출되는 공개 식별자라 `wrangler.toml`의 `[vars]`에 평문으로
있고, 실제로 위험한 `STREAM_CHAT_API_SECRET`만 시크릿으로 등록되어
있습니다(`wrangler.toml` 79~87번째 줄 주석 참고). `ALLOWED_ORIGIN`,
`BACKUP_FOLDER_ID`도 같은 이유로 `[vars]`에 있습니다 — 이 문서는
시크릿(`wrangler secret`)만 다룹니다.

## 2. 시크릿 15개

| 이름 | 용도 | 주요 사용 파일 |
|---|---|---|
| `ADMIN_EMAIL` | "누가 관리자인가"의 기준이 되는 이메일. 알림 발송 등 관리자 전용 동작을 이 값과 세션 이메일 비교로 허용한다(`requireAdmin`류 로직의 근거). | `index.js`, `auth.js` 등 12개 파일 |
| `ADMIN_OAUTH_CLIENT_ID` / `ADMIN_OAUTH_CLIENT_SECRET` | **관리자 위임 OAuth**(Google Drive 공유 전용, `GOOGLE_CLIENT_ID`와는 다른 흐름)의 OAuth 클라이언트 자격증명. 개인 Gmail 정책상 서비스 계정은 다른 사용자를 Drive 편집자로 초대할 권한이 없어("Sorry, you do not have permission to share"), 시트 소유자(관리자)가 1회 동의해 발급한 `refresh_token`으로 위임 호출한다. | `auth.js`, `index.js` (§`handleAdminOAuthAuthorize`/`Callback`, `index.js:501` 부근 주석) |
| `BOT_SECRET` | 도움봇(구글 앱스크립트/외부 봇)이 `X-Bot-Secret` 헤더로 자신을 증명하는 값. 이게 없거나 틀리면 401. | `bot.js`, `report-intake.js`, `exit-request.js` |
| `CF_ACCOUNT_ID` / `CF_API_TOKEN` | Cloudflare API로 **이 Worker 자신의 KV 읽기/쓰기 횟수**를 조회하기 위한 자격증명(무료 티어 한도 관리 목적, `docs/CACHING_POLICY.md` 참고). 없어도 앱은 정상 동작하고 이 조회 기능만 비활성화된다(`bot.js`의 `!env.CF_API_TOKEN \|\| !env.CF_ACCOUNT_ID` 가드). | `bot.js` |
| `DEV_LOGIN_SECRET` | **E2E 테스트 전용** — 구글 OAuth를 자동화 도구가 통과할 수 없어 만든 우회 로그인(`POST /dev/login`)의 인증 키. 등록되어 있지 않으면 그 경로 자체가 항상 404(프로덕션에 있는지조차 알 수 없음). 로컬 사본은 `app/.env.test`(gitignore됨, `app/tests/e2e/README.md` 참고). | `auth.js` |
| `GOOGLE_CLIENT_ID` | 회원 로그인(Google Identity Services)에서 받은 `credential`(ID 토큰)을 검증할 때 쓰는 OAuth 클라이언트 ID. `ADMIN_OAUTH_CLIENT_ID`와는 완전히 다른 흐름(하나는 로그인, 하나는 Drive 위임)이라 혼동 주의. | `auth.js` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google Sheets/Drive API를 호출하는 서비스 계정의 키 JSON 전체(private key 포함). 시트를 DB로 쓰는 이 앱의 거의 모든 읽기/쓰기가 이 계정의 액세스 토큰으로 이뤄진다. | `index.js`(`getServiceAccountAccessToken` 등) |
| `GOOGLE_SHEET_FILE_ID` | 실제 데이터가 들어있는 Google Sheets 파일 ID. 사실상 "DB 연결 문자열"에 해당 — 이 값이 바뀌면 완전히 다른 시트를 본다. | 거의 전 도메인 파일(16개) |
| `SESSION_SECRET` | 로그인 세션 토큰(`signSession`/`verifySession`)과 관리자 OAuth CSRF state 토큰 서명에 쓰는 HMAC 키. 이게 유출되면 임의 세션을 위조할 수 있어 가장 민감한 시크릿 중 하나. | `auth.js`, `index.js` 등 12개 파일 |
| `STREAM_CHAT_API_SECRET` | Stream Chat(getstream.io) 서버 사이드 토큰 서명 키. 공개 `STREAM_CHAT_API_KEY`(App Key)와 짝을 이루며, 이 값으로 회원별 채팅 토큰을 서버에서 발급한다. | `chat.js` |
| `VAPID_PRIVATE_KEY` / `VAPID_PUBLIC_KEY` / `VAPID_SUBJECT` | 웹 푸시(Web Push API) VAPID 키 쌍과 연락처(subject, `mailto:` 형식). 브라우저 푸시 구독을 서버가 대신 발송할 때 이 키로 서명한다. | `push-crypto.js` |

## 3. 등록/조회 방법

```bash
cd frame-checker-worker
npx wrangler secret list              # 등록된 이름만 조회(값은 안 보임)
npx wrangler secret put <NAME>        # 등록/갱신 (프롬프트로 값 입력)
npx wrangler secret delete <NAME>     # 삭제
```

로컬 `wrangler dev`에는 이 시크릿들이 전혀 없다 — `app/src/lib/api/client.ts`
최상단 주석에 있는 대로, 로컬 개발도 항상 프로덕션 Worker를 호출하도록
되어 있어 이 문제를 우회한다(로컬에 시크릿을 복제하지 않음, 사용자 결정).
테스트(`frame-checker-worker/test/`)는 이 시크릿들 대신 각자
mock/테스트 전용 값(`TEST_SERVICE_ACCOUNT_JSON` 등)을 쓰므로
`npm test`에는 실제 시크릿이 전혀 필요 없다.
