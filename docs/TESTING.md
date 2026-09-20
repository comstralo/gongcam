# 테스트 인프라 (`frame-checker-worker`)

## 배경

`frame-checker-worker/src/index.js`는 약 11,000줄, 300여 개 함수,
8개 Durable Object 클래스를 담은 단일 파일이고, 이 프로젝트엔 원래
자동화된 테스트가 전혀 없었다(`package.json` 자체가 없었음). 2026-09
세션에서 "사이클 오인"(관리자가 지난 주/이번 주 시트를 헷갈려 데이터
정합성이 깨지는 버그) 5건을 발견·수정하는 동안, 매번 Playwright로
실제 프로덕션 API를 왕복 호출하며 수동 검증하는 방식에만 의존했다 —
이는 "그때그때 사람이 확인해본 경로"에 국한되고, 향후 이 파일을
리팩터링하거나 다른 기능을 추가할 때 회귀를 자동으로 잡아주는
장치가 없었다.

사용자 목표: "지금 볼륨이 크더라도, 유지보수하기 쉽고 AI 에이전트가
주제에 집중해서 작업할 수 있는 구조로 개선"하되, **테스트 장치를
먼저 깔고 그 안전망 위에서 구조 개선(파일 분리 등)을 진행**하는
순서로 확정했다 — 테스트 없이 먼저 파일을 쪼개면 실수로 헬퍼 하나를
빠뜨려도 배포 후에야 발견되는 위험을 그대로 안게 되기 때문이다.

## 도구 선택

**`@cloudflare/vitest-plugin`**(Vitest 4.1+) — Cloudflare가
2026-08-19 `@cloudflare/vitest-pool-workers`(구, Vitest 3용)를
리브랜딩한 신규 공식 패키지. 실제 workerd 런타임을 그대로 써서
KV/Durable Object 바인딩까지 mock 없이 동작하는 테스트가 가능하다.
`wrangler.toml`을 `configPath`로 그대로 재사용한다(`.toml`/`.json(c)`
둘 다 지원).

```bash
cd frame-checker-worker
npm install   # 최초 1회
npm test      # 전체 테스트 실행
npm run test:watch  # watch 모드
```

**로컬 개발 서버(`wrangler dev` + `vite dev`)** — 2026-09-17에 정비했다.
`src/index.js`를 `wrangler.toml`의 `main`으로 직접 쓰면 이 환경의
wrangler dev(및 로컬 workerd)가 "Incorrect type for map entry
'<이름>': not of type 'function or ExportedHandler'"로 기동에
실패한다 — 진입 모듈이 named export를 하나라도 가지면 재현되는
이 환경 자체의 버그(wrangler 4.109.0~4.133.0, workerd
2026-07~2026-09 빌드 전부 재현 확인, 버전 문제 아님)이고,
`index.js`는 다른 도메인 파일들이 공유하는 유틸을 100개 이상
export해 이 버그를 그대로 트리거한다. 해결책으로 `src/worker-entry.js`
(default export와 `wrangler.toml`의 `durable_objects.bindings`가
요구하는 DO 클래스 8개만 `index.js`에서 재노출하는 얇은 래퍼)를
신설해 `main`으로 지정했다 — `index.js`의 실제 로직은 전혀 건드리지
않아 `wrangler deploy`/`npm test` 동작에는 차이가 없다(둘 다 검증됨).

```bash
cd frame-checker-worker
npx wrangler dev   # http://localhost:8787 — "Ready on ..." 뜰 때까지 대기
```

다만 로컬 `wrangler dev`에는 `SESSION_SECRET` 등 프로덕션 시크릿
14개(`wrangler secret list`로 이름만 확인 가능, 값은 조회 불가)가
전혀 없어, 인증이 필요한 요청이 오면 `verifySession`이 빈 HMAC 키로
서명 검증을 시도하다 500 예외를 던지고, 그 예외가 CORS 헤더를 붙이기
전에 터져서 브라우저에는 "CORS 정책 위반"/"Failed to fetch"로 보인다.
시크릿을 로컬에 복제하는 대신(보안상 프로덕션 값을 알 수 없기도 함)
프론트엔드(`app/`)는 로컬 개발에서도 항상 프로덕션 워커
(`https://frame-checker-worker.comstralo.workers.dev`, `app/src/lib/api/client.ts`
의 `WORKER_BASE`)를 호출하도록 유지한다(사용자 결정) — `wrangler dev`
는 API 엔드포인트 자체의 동작을 확인하거나 curl로 스모크 테스트할
때만 쓰고, 화면(UI) 작업은 `npm run dev`(Vite, `app/`)만으로
충분하다. 로컬 workerd의 CORS는 `resolveOrigin`(index.js)이 이미
`http://localhost:*` Origin을 echo하도록 되어 있어 별도 설정이
필요 없다.

```bash
cd app
npm run dev   # http://localhost:5173/gongcam/ — 항상 프로덕션 워커를 호출
```

Sentry(`app/src/lib/sentry.ts`)도 이때 함께 손봤다 — 로컬 `vite dev`
중 HMR(Hot Module Reload)로 나는 일회성 에러(모듈 교체 과도기에
Provider가 잠깐 언마운트되며 나는 `useContext` 에러 등)가 그대로
프로덕션 Sentry 프로젝트로 전송돼 실제 운영 이슈처럼 이메일 알림이
오는 문제가 있었다. `Sentry.init`에 `environment`(dev/prod 구분)와
`enabled`(로컬 dev에서는 아예 전송 안 함)를 추가했다 — 빌드
산출물에서는 `environment: "production", enabled: true`로 고정되어
프로덕션 동작에는 변화가 없다(빌드 후 grep으로 확인).

## 파일 구조

- `frame-checker-worker/package.json` — devDependencies(`vitest`,
  `@cloudflare/vitest-plugin`, `wrangler`).
- `frame-checker-worker/vitest.config.ts` — `cloudflareTest({ wrangler:
  { configPath: "./wrangler.toml" } })`로 기존 wrangler 설정(8개 DO
  바인딩, 2개 KV 네임스페이스 등)을 그대로 재사용.
- `frame-checker-worker/test/*.test.js` — 테스트 파일들.

`main`(`src/index.js`)을 테스트에서 `import`하면 실제 워커 내부에서
쓰이는 것과 정확히 같은 모듈 인스턴스를 받는다(공식 문서 명시) —
별도 번들링/변환 없이 `export`만 붙이면 바로 유닛 테스트할 수 있다.

## 현재 유효한 잔류 근거 요약 (21차 기준 — 🔧 [2026-09-19] 아래 표 재실측 갱신)

> 아래는 1~21차 각 섹션에 흩어져 있는 "이 함수는 index.js에 남긴다"
> 는 선언들의 **최신 스냅샷**이다. 각 차수 섹션 본문은 그 시점의
> 역사적 기록으로 그대로 보존하고(예: 10차의 "notify.js는 leaf
> 도메인" 서술은 16차 이후 더 이상 사실이 아니지만 본문은 갱신 노트만
> 덧붙이고 남겨뒀다), **지금 코드베이스의 진실**을 알고 싶으면 이
> 표만 보면 된다. 17차 구조 감사가 "차수 섹션을 순서대로 읽으면 낡은
> 근거를 최신으로 오인하기 쉽다"고 지적해 추가했다.
>
> 🔧 **[2026-09-19 정정]** "이 표만 보면 된다"는 문구를 스스로 무색하게
> 만든 사실이 발견됐다 — 21차(2026-09-17) 이후 하루 뒤(2026-09-18)에
> 실질적 기능 개발 7개 커밋이 더 있었고, 그로 인해 `cycle.js`/
> `exit-request.js`/`exit-confirm.js` 세 파일이 아래 표보다 커져 있었다.
> 상세는 아래 새 "22차" 섹션 참고. 표 자체는 이번에 재실측해 최신화했다.

**최종 파일 구조**(🔧 [2026-09-19] 재실측, `frame-checker-worker/src/`):

| 파일 | 줄 수 | 도메인 |
|---|---:|---|
| `index.js` | 2,099 | 엔트리포인트 — 세션/인증 프리미티브, 시트 API 저수준 유틸, 사용량 계측, DO stub, 관리자 위임 OAuth 저수준 유틸, 목표시간 예약, 참여자 명단, 라우팅 테이블(`export default { fetch, scheduled }`) |
| `personal-status.js` | 1,083 | 개인 대시보드(`handleStatus`/`handleAdminMemberStatus`) |
| `durable-objects.js` | 922 | DO 클래스 8개 |
| `exit-confirm.js` | 801 | 퇴실/재납 — 미리보기/확정 실행. 🔧 22차(2026-09-18)에 +58줄(퇴실 예약일자/최근 접속/퇴실 집행일자 캡처, 아래 참고) |
| `report-penalty.js` | 845 | 제보/캡처 — 벌점/제보상점 반영(승인/취소/삭제/반려취소) |
| `leave.js` | 863 | 사유반휴/일반반휴 |
| `report-review.js` | 663 | 제보/캡처 — 캡처 검토/목록/투표 |
| `members.js` | 678 | 회원 관리(CRUD/번호 재배치), 회원 상세 로스터 |
| `notify.js` | 665 | 알림/푸시 |
| `cycle.js` | 470 | 사이클(3주 백업) 판정. 🔧 22차에 +112줄(`groupBackupsIntoCycles`/`listAllCycleGroups`/`handleAdminCycleGroups`/`resolveTargetFileIdForAnyBackup` 신설) |
| `report-intake.js` | 389 | 제보/캡처 — 접수/쿨다운 |
| `bot.js` | 398 | 봇 원격 상태/사용량 |
| `cache.js` | 371 | 캐시 인프라 |
| `roster-status.js` | 320 | 랭킹/로스터/정산(19차에서 personal-status.js에서 분리) |
| `exit-request.js` | 280 | 퇴실/재납 — 신청/동의/취소, 도움봇 조회. 🔧 22차에 +126줄(`autoAgreeExpiredExitRequests`/`agreeExitRequestForMember` 신설) |
| `deposit.js` | 265 | 예치금 반환/강제퇴실/정산 판정 핵심 계산 |
| `auth.js` | 265 | 로그인/OAuth |
| `exit-candidates.js` | 252 | 퇴실/재납 — 후보 판정/공유 조회, 블랙리스트 |
| `fines.js` | 216 | 벌금/납부 처리 |
| `push-crypto.js` | 153 | 웹푸시 암호화(RFC 8291/8292) |
| `date-utils.js` | 132 | KST 날짜 계산 |
| `pure-utils.js` | 79 | 회원 계정 파싱 + 웹푸시 보조 + 알림 기본값(세 영역이 섞인 의도된 잡동사니 유틸, 18차에서 member-utils.js → pure-utils.js로 리네임) |
| `exit-timing.js` | 29 | 정산 공개 시점 판정 — 🔧 [2026-09-19 정정] "순수 함수"가 아니라 **시계 의존 함수**다(`isSettlementVisibleToMembers`/`exitDateSettled` 둘 다 `Date.now()`를 직접 호출). 테스트 파일명도 실제 성격에 맞게 `exit-timing-clock.test.js`(아래 3차 참고) |
| `worker-entry.js` | 28 | `fetch`/`scheduled` 얇은 진입점(위 "버그 우회" 절 참고) |

**index.js에 여러 도메인이 공유해서 남아있는 것들**(대표 예시 —
전체 목록은 각 차수 섹션 참고):

| 심볼 | 공유하는 파일 | 비고 |
|---|---|---|
| `signSession`/`verifySession` | 전 도메인 | 세션 토큰 서명/검증 |
| `getServiceAccountAccessToken` | 전 도메인 | 서비스 계정 OAuth 토큰 |
| `json`/`corsHeaders` | 전 도메인 | 표준 응답 헬퍼 |
| `requireAdmin`/`resolveMemberNumber`/`findMemberNumberByEmail` | 8곳 이상 | 인증/회원 식별 |
| `getSheetValues`/`writeSheetValues`/`batchGetSheetValues`/`getSpreadsheetMeta` | 7곳 이상 | 시트 API 저수준 유틸 |
| `resolveTargetFileId` | 7곳 이상 | 사이클 판정(원본 실제로는 cycle.js, index.js가 재export) |
| `parseWon`/`safeNumber`/`parseLeaveCount`/`colIndexToLetter` | deposit.js/leave.js/exit.js/fines.js 등 | 순수 계산 헬퍼 |
| `STATUS_DAYS`/`STATUS_DAY_COLS`/`ROW_PAYMENT_CHECK` 등 시트 레이아웃 상수 | 여러 도메인 | 15차에서 "범용"이라 뭉뚱그렸으나 실측 결과 다수는 personal-status.js 전용 — 그래도 시트 물리 레이아웃을 한곳에 모아두는 실용적 설계로 유지 |
| `getMemberSettingsStub`/`getRosterStub`/`getBotAdminConfigStub`/`getUsageStatsStub` | 여러 도메인 | DO stub 헬퍼 |
| `MEMBER_CACHE_GROUPS`(cache.js) | bot.js 경유 handleBotInvalidateCache | 17차에서 export 누락 버그 발견·수정 |
| `getAdminAccessToken`/`exchangeAdminOAuthCode`/`ADMIN_OAUTH_SCOPE` | exit.js/members.js | 관리자 위임 OAuth(Drive 편집자 초대용) |

**index.js에 남아있는 소수 핸들러**(각자 작고 독립적, 17차에서 전부
export + 최소 스모크 테스트 확보): `handleMyRole`,
`handleGetGoalSchedule`/`handleSetGoalSchedule`,
`handleBotInvalidateCache`, `handlePutParticipants`/
`handleGetParticipants`.

**비-허브 순환**(index.js를 거치지 않는 파일 간 직접 순환):
- `members.js ↔ notify.js`(16차에서 `handleAdminMembersRoster` 이동
  때 생김) — `members.js`가 `notify.js`의 `loadNotifyPrefs`/
  `getPushDeviceIndex`를, `notify.js`가 `members.js`의
  `listAllMembers`를 실사용 import한다.
- `personal-status.js ↔ roster-status.js`(19차에서 분리 때 생김) —
  `roster-status.js`가 `personal-status.js`의
  `parseWeekOfToMonday`/`currentWeekRangeYYMMDD`를, `personal-status.js`
  (의 `getMeritRank`)가 `roster-status.js`의 `buildRosterStatus`를
  실사용 import한다.

둘 다 전부 함수 선언(호이스팅)이라 TDZ 위험 없음.

## 진행 상황

### 1~2단계 완료 (2026-09-12)

사이클 판정 관련 핵심 함수 8개에 `export` 키워드를 추가하고(로직
변경 없음), 순수성에 따라 두 파일로 나눠 테스트했다:

- **`test/cycle-pure.test.js`** — 완전 순수 함수(fetch/DO/캐시/시계
  의존 전혀 없음): `requiresFineUnpaidRecheck`,
  `isUnguardedAdminForcedCycleCombo`, `weekOfForDate`,
  `exitDateMidnightUtcMs`, `kstDateKey`, `formatYYMMDD`. 오늘 세션에서
  실제 프로덕션 API로 검증했던 사이클 오인 케이스들을 그대로
  테스트 케이스화했다(예: `isUnguardedAdminForcedCycleCombo`의
  "자유 사유 + cycle 있음 → 차단" 등 4가지 조합).
- **`test/cycle-clock.test.js`** — `Date.now()`에 의존하는 함수:
  `exitWeekResetPassed`, `currentWeekMondayKST`. `vi.setSystemTime()`
  으로 리셋 경계 시각(월요일 06:00 KST) 전후를 고정해 검증한다.

`npm test` 기준 31개 테스트 전부 통과. 배포 후 Playwright로 회귀
없음(직권 P 자유사유+cycle 차단 등 실제 API 동작) 확인, `wrangler
tail`로 예외 0건 확인.

### 3단계 완료 (2026-09-13)

fetch(Google Sheets/Drive API)와 Durable Object에 의존하는 사이클
판정 함수들을 테스트 대상에 추가했다. 착수 전 가장 먼저
`vi.stubGlobal("fetch", ...)`가 `@cloudflare/vitest-plugin`의 실제
workerd 런타임 안에서도 그대로 통하는지 `listBackupFiles`로
스파이크 검증했고(통과), 이 전략을 나머지 함수로 그대로 확장했다.

이번 조사로 `currentCycleBackups`(`index.js:8491`, 🔧 [2026-09-17]
현재는 9차에서 이미 옮겨진 `frame-checker-worker/src/cycle.js`)와
`compareWeekOfDesc`(`index.js:8449`, 동일)가 완전한 순수 함수임을 새로
발견해 `export`를 추가하고 `test/cycle-pure.test.js`에 소급
편입했다 — 특히 `currentCycleBackups`는 §"1~2단계" 이전에 실제로
고쳤던 버그(`sheet_reset()`이 D25 갱신 전에 백업을 먼저 뜨는 순서
때문에 생긴 사이클 오프바이원)의 재발 방지 테스트 그 자체다.

- **`test/cycle-fetch.test.js`**(신설) — Drive/Sheets API fetch에만
  의존하는 함수: `listBackupFiles`(파일명 패턴 필터링, 히스토리
  시작 주차 이전 제외, weekOf 내림차순 정렬), `resolveTargetFileId`
  (cycleFileId 없으면 fetch 없이 즉시 반환/있으면 현재 사이클 소속
  검증), `listCurrentCycleBackups`(currentCycle 값에 따라 정확히
  0~2개만 반환). `env`는 `cloudflare:test`의 실제 바인딩을
  얕은 복사해 `GOOGLE_SHEET_FILE_ID`/`BACKUP_FOLDER_ID`(secret이라
  `wrangler.toml`엔 없음)만 테스트용 값으로 덮어썼다.
- **`test/cycle-do.test.js`**(신설) — DO+fetch+시계가 모두 얽힌 핵심
  함수 2개:
  - `resolveExitSourceFileId` — `getLeaveQueueStub(env)`가 mock이
    아니라 **실제 LeaveQueue Durable Object**로 동작함을 그대로
    이용해, 테스트 시작 전 `/exit/put`으로 실제 퇴실 신청 데이터를
    심어둔 뒤 `exitWeekResetPassed`를 fake timer로 리셋 전/후 두
    가지로 나눠 검증했다(리셋 전엔 원본 반환, 후엔
    `findBackupForExitDate`가 찾은 백업 반환). `kind`가 `settle`이
    아니거나 신청 자체가 없는 경우의 `cycleFileId` 폴백 분기도 함께
    검증.
  - `resolveCaptureSourceFileId` — 문서에 미리 적어둔 "함정"(`ts`와
    별개로 내부에서 `currentWeekMondayKST()`가 "지금"을 암묵적으로
    다시 읽는 것)을 그대로 재현해, `ts`와 시스템 시계를 함께
    맞춘 뒤 3가지 분기(이번 주 발생/같은 사이클 내 지난 주/이미
    사이클이 끝난 지난 주)를 각각 검증했다 — 이게 오늘 세션에서
    수정한 "화각 불량 제보 확인 사이클 기록" 버그의 근본 로직에
    대한 회귀 테스트다.

`hasUnpaidFineInCycle`/`hasForcedCandidateInCycle`은 계획대로 이번
범위에서 계속 제외했다 — `listAllMembers`→`getSharedMemberRows`/
`getAllExitRelevantStatus`→`listUnpaidFines`/`listExitCandidates`/
`calcForcedOutDeposit` 등 의존 체인이 매우 깊어, mock으로 모든 분기를
정확히 재현하는 비용이 얻는 확신보다 크다고 판단했다 — 이 두 함수는
계속 Playwright 프로덕션 검증에 의존한다.

`npm test` 기준 52개 테스트 전부 통과. `node --check`로 export 추가
구문 확인, 배포 후 Playwright로 관리자 화면(퇴실 처리, 제보 확인)
회귀 없음 확인, `wrangler tail`로 예외 0건 확인.

## 구조 개선 1차 — 안전 구간 모듈 분리 (2026-09-13)

테스트 안전망 위에서 `src/index.js`(약 11,000줄)를 여러 ES 모듈로
분리하는 작업을 처음 실행했다. 4단계 모두 "새 파일 생성 → index.js
에서 코드 제거 → import 추가 → 테스트가 참조하는 심볼은 index.js
에서 재export" 순서로 진행했고, 매 단계 `npm test` 전체 통과 +
`node --check` + `wrangler deploy` + curl/Playwright 스모크를
게이트로 삼았다.

- **단계 1 — `src/durable-objects.js`**: 완전히 독립적인(this.state/
  this.state.storage와 JS 내장 객체만 사용, index.js의 다른 헬퍼를
  전혀 호출하지 않는) Durable Object 클래스 8개(`ParticipantsRoster`,
  `UsageStats`, `ReportQueue`, `LeaveQueue`, `getLeaveQueueStub`,
  `ReportVote`, `MemberSettingsDO`, `PushSubscriptionsDO`,
  `BotAdminConfigDO`)를 옮겼다. `wrangler.toml`의
  `durable_objects.bindings[].class_name`이 main 파일의 named
  export를 찾으므로 index.js가 이 8개를 재export한다 — stub 헬퍼
  (`getUsageStatsStub` 등, `env.BINDING.get(id)`만 하는 함수)는 136개
  handle* 함수 전역에서 호출되므로 이동 범위를 최소화하기 위해
  index.js에 남겼다. 약 870줄 감소(10,984→10,116).
- **단계 2 — `src/cache.js`**: 캐시 인프라(`_sheetCache`/`_inFlight`/
  `_memberCacheGeneration`/`MEMBER_CACHE_PREFIXES`/
  `MEMBER_CACHE_GROUPS` 등)를 옮겼다. 외부에는 `_cachedCompute`/
  `invalidateMemberCache`/`invalidateMemberSlotCache` 3개 wrapper만
  export한다(테스트가 직접 import하지 않으므로 index.js 재export는
  불필요). 이 블록 중간에 물리적으로 끼어 있던 leave-history 함수 3개
  (`_readLeaveQueueIndex`/`_appendLeaveHistory`/`_readLeaveHistory`,
  캐시 상태와 무관하고 `getLeaveQueueStub`/`formatYYMMDD`에만 의존)는
  index.js에 그대로 남겼다. 약 334줄 감소(10,116→9,782).
- **단계 3 — `src/date-utils.js`**: 순수 날짜/시간 유틸 11개
  (`formatISODate`, `nowKST`, `todayKSTDateString`,
  `todayUTCDateString`, `kstDateOffsetString`, `currentWeekMondayKST`,
  `formatYYMMDD`, `kstDateKey`, `exitDateMidnightUtcMs`,
  `weekOfForDate`, `exitWeekResetPassed`)를 옮겼다. 이 함수들에
  의존하지만 도메인 로직에 더 가까운 `dayDateAt`/
  `parseWeekOfToMonday`/`currentWeekRangeYYMMDD`는 index.js에 남기고
  `formatISODate`/`currentWeekMondayKST`/`formatYYMMDD`를 import해
  쓴다. 약 100줄 감소(9,782→9,683, 이후 단계 4의 import 추가분 포함
  9,648).
- **단계 4 — `src/cycle.js`**: 완전 순수한 사이클 판정 함수 4개
  (`requiresFineUnpaidRecheck`, `isUnguardedAdminForcedCycleCombo`,
  `compareWeekOfDesc`, `currentCycleBackups`)를 옮겼다.
  `requiresFineUnpaidRecheck`가 참조하는
  `FINE_UNPAID_ADMIN_FORCED_REASON` 상수는 index.js의 다른 곳
  (`FINE_UNPAID_ADMIN_FORCED_REASON_LABEL`)에서도 쓰여 index.js에
  남기고 `export const`로 노출, `cycle.js`가 import한다 — 이때
  `cycle.js → index.js`(상수 import)와 `index.js → cycle.js`(재export)
  양방향 import가 생겨 **이 프로젝트에서 처음으로 순환 import가
  발생**했다. index.js는 재export 목적으로만 `cycle.js`를 import하고
  최상위에서 그 값을 즉시 평가하지 않으므로(전부 handle* 함수 본문
  안, 즉 요청 처리 시점에 지연 호출됨) TDZ 문제 없이 정상 동작함을
  `npm test`(52개 테스트 통과, 특히 두 함수가 서로 여집합 관계임을
  확인하는 테스트가 순환 경로를 실제로 왕복시킴)와 `wrangler deploy`
  양쪽으로 확인했다. `listBackupFiles`/`listCurrentCycleBackups`(아직
  index.js에 남아있는 fetch 의존 함수)는 이 4개 함수 중
  `compareWeekOfDesc`/`currentCycleBackups`를 `cycle.js`에서
  import해서 쓴다. 약 40줄 감소(최종 9,648줄, 시작 대비 약 12.2% 감소).

DO 클래스 자체 테스트는 없지만 `cycle-do.test.js`가
`env.LEAVE_QUEUE_DO`를 실제로 기동시켜 재export 경로를 실질적으로
검증했고, 캐시 인프라도 `resolveExitSourceFileId` 등이 내부적으로
`invalidateMemberSlotCache`를 호출하는 경로를 통해 간접 검증됐다 —
직접 테스트가 없는 두 영역(DO 클래스, 캐시)일수록 배포 후 curl/
`wrangler tail` 스모크를 더 꼼꼼히 반복했다.

## 구조 개선 2차 — fetch/DO 의존 사이클 함수 분리 (2026-09-13)

1차에서 남겨둔 fetch/DO 의존 사이클 함수를 마저 `cycle.js`로 옮겼다.
착수 전 `getCurrentPenCycle`/`findBackupForExitDate`의 실제 호출부를
grep으로 재조사한 결과, 애초 계획과 달리 **`getCurrentPenCycle`은
사이클 전용이 아니라 `_computeReportScore`/`buildPersonalStatus`/
`applyOutputPenalty`/`applyReportMerit`/`getAllExitRelevantStatus` 등
벌점·제보점수·퇴실판정 도메인에서 6곳이나 직접 호출**하고 있었다 —
`getSheetValues`와 같은 범용 유틸로 재분류해 **index.js에 남기고
`export`만 추가**했다(계획을 구현 중 수정한 사례). `findBackupForExitDate`
는 실제 호출부가 `resolveExitSourceFileId` 한 곳뿐이라 계획대로
옮겼다.

- **`cycle.js`에 추가로 옮긴 것**: `findBackupForExitDate`,
  `resolveExitSourceFileId`, `resolveCaptureSourceFileId`,
  `listBackupFiles`(+`BACKUP_FILENAME_RE`/`BACKUP_HISTORY_START_WEEK_OF`
  상수), `listCurrentCycleBackups`, `resolveTargetFileId`.
- **index.js에 남기고 `export`만 추가한 것**: `getSheetValues`(회원/
  벌점/벌금/퇴실/반휴/감사 등 전 도메인에서 40회 이상 호출되는 저수준
  유틸, `_bumpUsageCounter`라는 모듈 스코프 상태에도 의존),
  `getCurrentPenCycle`(위 재조사로 범용 유틸임이 드러남). `cycle.js`
  는 이 둘을 `import { getSheetValues, getCurrentPenCycle } from
  "./index.js"`로 가져온다 — 1차에서 검증한 "재export 전용 순환"
  패턴에 심볼이 늘어난 것뿐이라 새 위험은 없었다.
- `getLeaveQueueStub`(durable-objects.js), `weekOfForDate`/
  `kstDateKey`/`formatYYMMDD`/`currentWeekMondayKST`/
  `exitWeekResetPassed`(date-utils.js)도 `cycle.js`가 직접 import한다.

index.js 9,648→9,494줄(약 154줄 감소, 시작 대비 총 13.6% 감소).
`npm test` 기준 52개 테스트 전부 통과 — `cycle-fetch.test.js`/
`cycle-do.test.js`가 이제 `cycle.js` 구현 전체(순환 import 경로
포함)를 실질적으로 검증한다. 배포 후 curl로 `/cycles`/`/status`
정상 401 응답 확인, `wrangler tail`로 두 요청 모두 예외 없이
"Ok" 처리됨을 확인했다.

## 구조 개선 3차 — 예치금 반환/강제퇴실/정산 판정 분리 (2026-09-13)

벌점/벌금/예치금/상금 도메인 중 순수·시계 의존 함수가 몰려 있는
예치금 반환 계산 핵심부를 옮겼다. `depositRefundBreakdown`이 만드는
`depositBreakdown` 객체를 `forcedExitChecks`/`calcForcedOutDeposit`/
`calcAdminForcedExit`/`calcSettleReturnDeposit`/`calcAgainDeposit`가
입력으로 받고, `calcExitProcess`가 kind별로 이 넷을 디스패치하는
강하게 연결된 순수 함수 그룹이라는 게 착수 전 조사로 확인됐다.

- **`src/deposit.js`(신설)**: `countCurrentCyclePen`, `isLateNotice`
  (유일하게 `Date.now()`를 직접 씀 — `todayKSTDateString()` 호출),
  `depositRefundBreakdown`(`isLateNotice` 호출로 시계 의존 전파),
  `forcedExitChecks`, `calcForcedOutDeposit`, `calcAdminForcedExit`,
  `calcSettleReturnDeposit`, `calcAgainDeposit`, `calcExitProcess`,
  `totalPenaltyBreakdown`. `safeNumber`/`STATUS_DAYS`/
  `STATUS_DAY_COLS`/`ROW_PARTI_STATUS` 등 시트 레이아웃 상수·헬퍼는
  index.js 전역(22곳, 16곳 등)에서 광범위하게 쓰이는 범용 유틸이라
  `getSheetValues`와 같은 방식으로 **index.js에 남기고 `export`만
  추가**했다 — `deposit.js`는 이를 순환 import로 가져온다(1차/2차와
  동일한 재export 전용 패턴).
- **`src/exit-timing.js`(신설)**: `isSettlementVisibleToMembers`
  (상금 공개 시각, 일요일 23:30 KST 이후), `exitDateSettled`(퇴실
  동의 가능 시점, exitDate+26시간 경계) — 도메인은 다르지만 둘 다
  짧은 순수 시계 함수라 한 파일로 묶었다(사용자 확인). 둘 다 다른
  파일 import가 필요 없어 순환이 생기지 않는다.
- **버그 재현 회귀 테스트**: `calcSettleReturnDeposit`과
  `depositRefundBreakdown`에 실제 "고지지연(퇴실 통보 지연) 미반영"
  버그 수정 이력이 있다 — 회원이 미리 보는 예상 반환액과 관리자가
  확정 처리할 때 실제 반환액이 어긋났었다. `test/deposit-clock.
  test.js`가 `depositRefundBreakdown`의 버그 케이스(penTotal===1 &
  lateNotice===true → amount 0)를 검증한 뒤, 그 결과를 그대로
  `calcSettleReturnDeposit`에 넣어 discountRatio가 1(0% 반환)로
  일치하는지 **교차 검증**한다 — 두 함수가 서로 어긋나지 않는지
  자체가 회귀 방지 포인트다.
- `calcSettleReturnDeposit`은 `Date.now()`를 직접 쓰지 않고
  `depositBreakdown.lateNotice`(이미 계산된 값)만 참조하므로
  `test/deposit-pure.test.js`(완전 순수 그룹)에 배치했다(사용자
  확인) — `vi.setSystemTime()` 없이 fixture로 `lateNotice`를 직접
  주입해 결정적으로 테스트한다.
- `calcAdminForcedExit`/`calcAgainDeposit`/`calcSettleReturnDeposit`/
  `isLateNotice`는 `calcExitProcess`/`depositRefundBreakdown`을
  통해서만 간접 호출되고 index.js 다른 함수가 직접 부르지 않아
  index.js 재export 대상에서 제외했다 — 이 함수들을 테스트하는
  파일은 `../src/deposit.js`에서 직접 import한다(같은 모듈 인스턴스
  이므로 index.js를 거쳐 import하는 것과 동작 차이 없음).

index.js 9,494→9,273줄(약 221줄 감소, 시작 대비 총 15.6% 감소).
`npm test` 기준 120개 테스트 전부 통과(기존 52개 + 신규 68개).
배포 후 curl로 `/status`/`/roster-status`/`/cycles` 정상 401 응답
확인, `wrangler tail`로 예외 없이 "Ok" 처리됨을 확인했다.

## 구조 개선 4차 — 회원 관리/알림·푸시 도메인의 작은 순수 함수 (2026-09-13)

착수 전 조사로 이 도메인은 **이전 세 도메인과 성격이 다르다**는
게 확인됐다 — 핵심 함수(`handleAdminCreateMember`, `moveMemberSlot`,
`handleAdminMembersRoster` 등)는 전부 fetch 4~8회 + DO 왕복이
뒤섞인 5~7단계 체인이라 순수 로직을 뽑아낼 여지가 이미 거의
소진되어 있고, 웹푸시 암호화 함수(HKDF, `encryptPushPayload` 등)는
RFC 8291/5869 표준 구현이라 it.each 대신 표준 벡터/왕복 검증이
필요해 테스트 성격이 다르다. 사용자 확인을 거쳐 **범위를 완전
순수하고 짧은 함수 6개로 좁혀** 진행했다 — 무리하게 fetch/DO
함수를 순수 함수 테스트로 끌고 가지 않았다.

- **`src/member-utils.js`(신설)**: `parseGoogleEmail`/
  `parseGooroomeeAccount`("구글계정,구루미계정" 형식 셀 파싱),
  `guessDeviceLabel`(User-Agent로 OS 6종×브라우저 6종 우선순위
  판정), `defaultNotifyPrefs`(`NOTIFY_CATEGORIES` 키 전부 true로
  초기화), `buildVapidJwk`(async이지만 `crypto.subtle` 없이 공개키
  바이트를 x/y로 슬라이스하는 순수 함수), `concatBytes`(Uint8Array
  이어붙이기). `base64url`/`base64urlToBytes`(20곳에서 쓰이는 범용
  인코딩)와 `NOTIFY_CATEGORIES`(6곳에서 쓰이는 범용 상수)는
  `getSheetValues`와 같은 방식으로 index.js에 남기고 `export`만
  추가해 순환 import로 가져온다.
- `buildVapidJwk`/`concatBytes`의 유일한 호출부는 각각
  `createVapidAuthHeader`/`encryptPushPayload`·`hkdfExpand`(둘 다
  이번에 제외한 암호화 함수, index.js 잔류)뿐이라 **재export 없이
  import 문 하나로 해결**했다 — `hasForcedCandidateInCycle`
  (3차)에서 이미 검증된 "제외 대상 함수도 새 모듈 의존이 생기는 건
  괜찮다" 패턴과 동일.
- **`test/member-utils.test.js`(신설)**: 6개 함수 전부 완전 순수라
  한 파일에 모았다 — `guessDeviceLabel`은 실제 UA 문자열(iPhone+
  Safari, Android+Chrome, Windows+Edge 등)을 it.each로, `buildVapidJwk`
  는 65바이트 P-256 공개키(0x04+x32+y32)를 넣어 x/y가 정확히
  1~33/33~65 구간으로 슬라이스되는지(오프바이원 회귀 방지) 검증했다.

index.js 9,273→9,232줄(약 41줄 감소, 시작 대비 총 15.9% 감소 —
짧은 함수들이라 이전 차수보다 감소폭은 작다). `npm test` 기준
151개 테스트 전부 통과(기존 120개 + 신규 31개). 배포 후 curl로
`/cycles`/`/admin/members/roster`/`/push/devices` 정상 401 응답
확인, `wrangler tail`로 전부 예외 없이 "Ok" 처리됨을 확인했다.

**총평**: 이 도메인은 순수 로직 비중이 낮아 모듈 분리로 큰 성과를
내기 어렵다. `handleAdminCreateMember`/`moveMemberSlot`/
`handleAdminMembersRoster` 등 핵심 함수를 테스트하려면 순수 정렬
로직을 인라인에서 뽑아내는 리팩터링(예: `computeMemberReorderPlan`
내부를 `computeReorderPlanFromRows`로 분리)이 선행되어야 하는데,
이는 "테스트 확장" 범위를 넘어서는 별도 결정이 필요해 이번엔
보류했다.

## 구조 개선 5차 — 웹푸시 암호화 함수 (2026-09-13)

4차에서 "RFC 표준 구현이라 it.each 대신 표준 벡터/왕복 검증이
필요해 테스트 성격이 다르다"는 이유로 제외했던 웹푸시 암호화 함수
7개를, 4차 문서에 이미 예정된 옵션 (c)대로 별도 전략으로 착수했다.

**표준 벡터 대신 채택한 전략**: RFC 5869(HKDF) Appendix A의 공개
SHA-256 벡터는 출력 길이(L)가 전부 32바이트(해시 크기)를 넘어
다중 블록이 필요한데, 이 코드의 `hkdfExpand`는 카운터를 항상 1로
고정해 1블록(최대 32바이트)만 생성한다(RFC 8291이 실제로 요구하는
단순화된 형태) — 표준 벡터를 그대로 쓸 수 없고, 정확한 바이트 값을
확신 없이 코드에 박아넣는 위험을 피하기 위해 두 가지 대안을
채택했다:
1. **정의상 합성 관계 검증**: `hkdfExtract`/`hkdfExpand`/`hkdf`가
   `hmacSha256Raw`를 정확히 어떻게 조합하는지(설계 문서 그 자체)를
   고정하는 회귀 테스트로 검증 — 표준 벡터보다 "구현이 정의대로
   정확히 동작하는가"를 더 정밀하게 잡아낸다.
2. **암호화→복호화 왕복 검증**: `encryptPushPayload`는 salt/ephemeral
   key가 매번 랜덤이라 표준 벡터 자체가 무의미하다 — 테스트 코드
   안에 RFC 8291 aes128gcm 복호화 로직을 직접 구현해, 암호화한
   결과를 가짜 "클라이언트"(테스트가 미리 만든 P-256 키쌍) 입장에서
   되돌려 원문이 정확히 복원되는지 확인한다. HKDF·ECDH·AES-GCM
   전체 체인이 하나라도 틀리면 AEAD 인증 태그 불일치로 즉시 예외가
   나므로, 이 왕복 검증 자체가 매우 강한 정확성 보장이 된다.
3. **`createVapidAuthHeader`**: 테스트에서 실제 P-256 ECDSA 키쌍을
   `crypto.subtle.generateKey`로 생성해 만든 JWT를 그 공개키로 실제
   `crypto.subtle.verify`까지 호출해 서명이 유효한지 확인하는 왕복
   검증. 엉뚱한 공개키로는 검증이 실패하는지(서명 위조 방지)도
   함께 확인했다.

**`src/push-crypto.js`(신설)**: `hmacSha256Raw`, `hkdfExtract`,
`hkdfExpand`, `hkdf`, `createVapidAuthHeader`, `encryptPushPayload`,
`sendWebPush` 7개 함수. `base64url`/`base64urlToBytes`(index.js에서
export만 추가, 순환 import)와 `buildVapidJwk`/`concatBytes`
(member-utils.js에서 index.js를 거치지 않고 직접 import)에 의존한다.
`sendWebPush`만 index.js 내 3곳(관리자 발송 핸들러)에서 직접
호출하므로 그것만 import하고, 나머지 6개는 서로 내부에서만
호출되고 index.js 다른 곳이 직접 부르지 않아 재export하지 않았다
— 테스트는 필요에 따라 `../src/push-crypto.js`에서 직접 import.

**테스트 파일 4개**:
- `test/push-crypto-hkdf.test.js` — 완전 순수, 합성 관계 검증.
- `test/push-crypto-vapid.test.js` — 실제 키쌍 생성 + JWT 왕복 검증.
- `test/push-crypto-payload.test.js` — 암호화→복호화 왕복 검증(빈
  문자열/한글·이모지 페이로드, 헤더 레이아웃, 비결정성, 잘못된
  authSecret으로 복호화 시 AEAD 무결성 검증 실패까지 확인).
- `test/push-crypto-send.test.js` — 기존에 검증된
  `vi.stubGlobal("fetch", ...)` 패턴으로 요청 URL/헤더/body 검증.

`@cloudflare/vitest-plugin`의 실제 workerd 런타임 덕분에
`crypto.subtle`(HMAC/ECDSA/ECDH/AES-GCM 전부)이 mock 없이 그대로
동작함을 실증했다 — 지금까지 실제 DO를 mock 없이 써온 것과 같은
원리가 암호화 API에도 그대로 적용된다.

index.js 9,232→9,093줄(약 139줄 감소, 시작 대비 총 17.2% 감소).
`npm test` 기준 173개 테스트 전부 통과(기존 151개 + 신규 22개).
배포 후 curl로 `/push/devices` 정상 401 응답 확인 — 이 도메인은
암호화 로직이라 유닛 테스트만으로 놓칠 수 있는 실제 푸시 서비스
(FCM/Mozilla autopush)와의 호환성 문제는 배포 후 실사용(관리자
화면에서 실제 발송)으로 추가 확인이 필요하다는 점을 남겨둔다.

## 구조 개선 6차 — fetch 의존 벌금/납부 처리 도메인 통합 테스트 + 이동 (2026-09-13)

1~5차는 "순수 함수만 골라내는" 전략으로 index.js를 17.2% 줄였지만,
실제로 옮긴 건 약 40개 함수뿐이고 나머지 260개 이상은 fetch/DO가
깊게 얽힌 handle* 핸들러라 손대지 못했다. 이번 6차부터는 전략을
전환했다 — **순수성과 무관하게 fetch mock + 실제 workerd DO로 통합
테스트를 먼저 깐 뒤, 도메인 단위로 핸들러+로직을 통째로 파일
이동**한다.

착수 전 "회원 관리"(933줄)와 "벌금/납부 처리"(343줄)를 비교했다.
회원 관리는 `handleAdminMemberStatus`가 아직 index.js에 남은 exit
도메인의 `buildExitedMemberSnapshot`을 호출해 진짜 상호 순환
위험이 있고 `moveMemberSlot`은 fetch mock이 10종 이상 필요해
테스트 비용이 크다 — 반면 벌금/납부 처리는 fetch 2~3종만 필요하고
DO가 전혀 없어 순환 위험도 없다. 사용자 확인을 거쳐 벌금/납부
처리부터 시작해 "통합테스트 먼저 → 이동" 워크플로우 자체를
검증했다.

**`src/fines.js`(신설)**: `getAllPaymentRows`, `collectFinesByStatus`,
`listUnpaidFines`, `listPaidFines`, `getWeeklyPaidFineTotal`,
`listExemptFines`, `FINE_STATUS_VALUES`, `handleAdminFinesUnpaid`,
`handleAdminFinesPaid`, `handleAdminFinesExempt`,
`handleAdminFineStatus`. `listAllMembers`/`getSharedMemberRows`/
`writeSheetValues`/`colIndexToLetter`/`requireAdmin`/
`getServiceAccountAccessToken`/`json`/`signSession`은 이 도메인
전용이 아니라 여러 도메인이 공유하는 범용 유틸이라 index.js에
남기고 export만 추가했다. `hasUnpaidFineInCycle`(사이클 도메인,
계속 index.js에 남는 제외 대상 함수)이 `listUnpaidFines`를 직접
호출하므로, index.js는 재export가 아니라 실제 사용 목적으로
`fines.js`를 import한다 — 3차의 `hasForcedCandidateInCycle` →
`calcForcedOutDeposit` 패턴과 동일.

**통합 테스트 2개 파일**:
- `test/fines-fetch.test.js` — 조회 함수 4개 + 순수 필터
  (`collectFinesByStatus`)를 `vi.stubGlobal("fetch", ...)`로 검증.
- `test/fines-handlers.test.js` — 핸들러 4개를 `signSession`으로
  만든 실제 유효 세션 토큰과 fetch mock을 조합해 인증 실패(403)/
  유효성 검사 실패(400)/정상 응답(200)/쓰기 range 정확성까지
  통합 검증. `getServiceAccountAccessToken`이
  `env.GOOGLE_SERVICE_ACCOUNT_JSON`을 실제로 RSA JWT 서명하므로,
  `test/helpers/service-account.js`에 테스트 전용 더미 RSA 키쌍을
  마련해 재사용했다(node `crypto.generateKeyPairSync`로 1회 생성,
  실제 Google 계정과 무관). `listAllMembers` 등이 `_cachedCompute`
  로 fileId별로 캐싱되므로, 같은 테스트 파일 안의 케이스마다 서로
  다른 `GOOGLE_SHEET_FILE_ID`를 써서 캐시 오염 없이 격리했다.

**🔧 실제 프로덕션 버그 발견·수정**: `fines-handlers.test.js`의 쓰기
경로(`handleAdminFineStatus`) 테스트가 500 에러를 내며, 1차 분리
때 놓친 실제 버그를 드러냈다 — index.js에 남아있던
`invalidatePersonalStatusCache`와 `_kvKeyPrefix`(KV 사용량 계측용)
가 `_sheetCache`/`_bumpCacheGeneration`/`KV_CACHE_PREFIX`를 정의
없이 참조하고 있었다(1차 분리 때 이 심볼들이 `cache.js`로 옮겨진
걸 놓침). `invalidatePersonalStatusCache`는 try/catch가 없어
개인 탭에 쓰는 모든 요청(`writeSheetValues` 경유)이 실제로 500으로
실패하고 있었고, `_kvKeyPrefix`는 호출부(`_cacheGetAsync`/
`_cacheSetAsync`)가 try/catch로 감싸 조용히 삼켜져 **KV 캐시
읽기/쓰기가 계속 무효화**되고 있었다(기능은 원본 재조회로 정답을
냈지만 캐싱 효과·쿼터 절약이 전혀 없었음). `KV_CACHE_PREFIX`를
`cache.js`에서 export하고, `invalidatePersonalStatusCache` 자체도
로직 변경 없이 `cache.js`로 옮겨 index.js가 import하도록 수정했다
— 순수 함수 분리 단계에서는 발견되지 않고, 이번 6차의 통합 테스트
(실제 쓰기 경로를 끝까지 태우는 테스트)에서 처음 드러난 버그다.

index.js 9,093→8,967줄(약 126줄 감소, 시작 대비 총 18.4% 감소).
`npm test` 기준 190개 테스트 전부 통과(기존 173개 + 신규 17개).
배포 후 curl로 `/admin/fines/unpaid` 정상 403 응답 확인,
`wrangler tail`로 실사용 트래픽(봇 PUT, `/bot/exit-requests`)이
예외 없이 처리됨을 확인했다.

## 구조 개선 7차 — 회원 관리(CRUD/번호 재배치) 도메인 통합 테스트 + 이동 (2026-09-13)

6차에서 확립한 "fetch mock + 실제 workerd DO 통합 테스트를 먼저
깐 뒤 도메인을 통째로 이동"하는 전략을 두 번째로 적용했다. 대상은
"회원 관리"(CRUD·번호 재배치) 도메인.

**착수 전 조사에서 계획을 세 차례 좁혔다** — 서브에이전트의 최초
조사를 그대로 믿지 않고, 실행 직전 각 함수를 실제로 grep해 재검증한
결과다:
1. `resolveMemberNumber`/`findMemberNumberByEmail`은 회원 관리
   전용이 아니라 로그인/제보/반휴 등 **15곳 이상이 공유하는 인증
   유틸**이라 제외했다(`withMemberLock`/`getRosterStub`과 동일한
   성격, 사용자 확인).
2. `handleAdminMemberStatus`(→`buildPersonalStatus`, exit 신청 DO
   조회까지 얽힘)와 `handleAdminMembersRoster`(→
   `listActiveMembersWithExitInfo`, exit 도메인 판정 로직 포함)는
   둘 다 예상보다 훨씬 무거워 통합 테스트 비용과 순환 복잡도가
   지나치게 커서 제외했다(사용자 확인).
3. `getCurrentCoReviewers`는 애초 계획에는 이동 대상이었으나,
   구현 중 재확인(`grep -n "getCurrentCoReviewers("`)한 결과 제보
   (`handleAdminCapturesList`/`handleAdminCaptureVote`), 권한 조회
   (`handleMyRole`), 인증(`requireAdminOrCoReviewer`)까지 5곳
   이상이 쓰는 범용 함수임을 발견해 index.js에 남기기로 계획을
   스스로 수정했다.

**`src/members.js`(신설)**: `grantSheetAccess`, `getDataSheetRows`,
`listAllMembers`, `handleAdminMembers`, `handleAdminSetPartiStatus`,
`handleAdminOpenSlots`, `computeMemberReorderPlan`,
`handleAdminMemberReorderPreview`, `moveMemberSlot`,
`handleAdminMemberReorder`, `handleAdminCreateMember`,
`handleGrantMemberAccess`. `withMemberLock`/`getRosterStub`, 범용
시트 조작 유틸 6종(`getSheetIdsByNames`/`spreadsheetBatchUpdate`/
`copySheetToSpreadsheet`/`copySheetWithName`/
`protectSheetForOwnerAndService`/`getSpreadsheetMeta`),
`listExitedMemberEntries`, `getCurrentCoReviewers`,
`getAdminAccessToken`은 exit 도메인 등 다른 도메인도 공유하는
범용 유틸이라 index.js에 남기고 export만 추가했다. `listAllMembers`
는 `fines.js`가 여전히 `./index.js`에서 import하므로(6차 잔재),
index.js가 `members.js`에서 재import해 재export한다 — 6차의
`listUnpaidFines`와 동일한 패턴.

**통합 테스트 3개 파일**:
- `test/members-fetch.test.js` — `listAllMembers`,
  `getDataSheetRows`, `getCurrentCoReviewers`,
  `computeMemberReorderPlan`(읽기 전용, fetch mock만 필요) 5개
  케이스.
- `test/members-handlers.test.js` — `handleAdminMembers`,
  `handleAdminOpenSlots`, `handleAdminMemberReorderPreview`,
  `handleGrantMemberAccess` 9개 케이스. `handleAdminMembers`가
  내부적으로 `listExitedMemberEntries`(스프레드시트 메타 조회)도
  호출한다는 걸 테스트 작성 중 실패로 발견해 mock을 보강했다.
- `test/members-mutations.test.js` — `handleAdminSetPartiStatus`,
  `moveMemberSlot`, `handleAdminMemberReorder`,
  `handleAdminCreateMember` 12개 케이스. `moveMemberSlot`은
  계획대로 fetch mock 10종 이상(메타 조회/`:copyTo`/시트
  보호/`:batchUpdate`/`values:batchUpdate`)을 조합해 탭 삭제→
  이름변경→template 복사→값 이전까지 예외 없이 끝나는지 검증했다.
  `getSheetValues`가 항상 `init` 인자를 넘긴다는 걸 놓쳐
  `!L3 && !init` 조건이 항상 거짓이 되는 mock 버그를 처음엔 만들었다
  — `getSheetValues(...).catch(() => [])`가 이 실패를 조용히
  삼켜 "스터디장은 변경할 수 없다" 테스트가 거짓으로 통과할 뻔한
  것을 assertion 실패로 잡아내 수정했다.

index.js 8,967→8,463줄(약 504줄 감소, 시작(10,984줄) 대비 총
22.9% 감소). `npm test` 기준 216개 테스트 전부 통과(기존 190개 +
신규 26개). 배포 후 `/admin/members`, `/admin/members/open-slots`,
`/admin/members/reorder-preview`, `/admin/members`(POST),
`/admin/members/grant-access`, `/admin/members/parti-status`,
`/admin/members/reorder` 전부 인증 없이 403 정상 응답 확인,
`wrangler tail`로 실제 요청들이 예외 없이("Ok") 처리됨을 확인했다.

## 다음 단계

사이클 판정, 예치금/강제퇴실/정산 판정, 회원 관리/알림·푸시의
순수 함수, 웹푸시 암호화, 벌금/납부 처리, 회원 관리(CRUD/번호
재배치)까지 총 7차에 걸쳐 분리했다. 다음 후보는 "퇴실
처리"(1,255줄) — cycle.js/deposit.js 모두와 얽혀 있고, 이번에
제외한 `handleAdminMemberStatus`/`handleAdminMembersRoster`가
의존하는 `buildPersonalStatus`/`listActiveMembersWithExitInfo`도
이 도메인에 속해 있어 함께 정리할 기회가 된다. `resolveMemberNumber`
/`findMemberNumberByEmail`(15곳 이상 공유 인증 유틸)은 여러 차수에
걸쳐 계속 제외 대상으로 남아있다 — 별도로 "인증/조회 유틸" 차수를
만들어 다룰지, 계속 index.js에 남길지는 퇴실 처리 이후 재검토한다.
테스트 없이 구조 변경부터 시작하지 않는다는 원칙은 유지한다 —
6차·7차 모두 통합 테스트 작성 자체가 실제 버그/mock 결함을 잡아내는
안전망 역할을 했으므로, 순서를 건너뛰지 않는다.

## 구조 개선 8차 — 퇴실 처리 도메인 통합 테스트 + 이동 (2026-09-13)

7차 완료 기록에서 예고한 대로 "퇴실 처리"(신청/동의/취소, 관리자
후보 조회/미리보기/확정, 강제퇴실·재납 시트 조작, 블랙리스트)
도메인을 `src/exit.js`로 옮겼다. 6~7차와 동일하게 fetch mock +
실제 workerd DO 통합 테스트를 먼저 깐 뒤 도메인을 통째로 이동했다.

**범위 확정**: `buildPersonalStatus`(개인 대시보드 `/status` 전용
— `handleStatus`가 실제 소비처이고, exit 도메인은 `computeExitResult`
에서 호출만 함)와 `handleAdminMemberStatus`/`handleAdminMembersRoster`
(7차에서 이미 제외 확정)는 이번에도 index.js에 남겼다. 대신
`listActiveMembersWithExitInfo`(exit 전용 로직, `handleAdminMembersRoster`
가 참조만 함)는 이동 대상에 포함했다 — index.js가 exit.js에서
이 함수 하나만 다시 가져와 `handleAdminMembersRoster`에 연결한다.
`handleAdminFinesAdminForcedCount`(벌금 도메인, index.js 잔류)는
`listExitedMemberEntries`/`getMemberSettingsStub`을 참조하지만 둘 다
이미 index.js에 있어 영향이 없었다.

**`src/exit.js`(신설, 22개 함수, 약 1,125줄)**: `writeExitResultBox`,
`revokeSheetAccess`, `getPenaltySlotNotesGrid`, `getSheetFormulas`,
`getAllExitRelevantStatus`, `listExitCandidates`, `handleSetExitRequest`,
`handleAgreeExitRequest`, `handleCancelExitRequest`, `listExitRequests`,
`handleBotExitRequests`, `handleAdminExitedMembers`,
`listActiveMembersWithExitInfo`, `handleAdminExitCandidates`,
`computeExitResult`, `handleAdminExitPreview`, `appendDataAuditSnapshot`,
`rewriteBackupAuditFormulas`, `performExitReset`, `performDepositAgainReset`,
`handleAdminExitConfirm`, `handleAdminExitBlacklist`, `handleAdminBlacklist`.
cycle.js/deposit.js에서 이미 index.js가 재export하는 범용 함수
(`isUnguardedAdminForcedCycleCombo`/`resolveExitSourceFileId`/
`resolveTargetFileId`, `calcForcedOutDeposit`/`calcExitProcess`/
`countCurrentCyclePen`/`depositRefundBreakdown`/`forcedExitChecks`)는
실제 사용 목적으로 다시 import한다(6~7차와 동일 패턴). `getSharedMemberRows`
/`latestSlotDay`/`buildSlotHistory`/`_bumpUsageCounter`/
`OUTPUT_PEN_SHEET_NAME`/`OUTPUT_PEN_SLOT_COLUMNS`/각종 `ROW_*`·`COL_*`
상수는 다른 도메인(개인 대시보드, 벌점 집계)도 공유하는 범용
유틸·상수라 index.js에 남기고 export만 추가했다.

**🔧 통합 테스트 작성 중 발견·수정한 실제 버그**: exit.js로 옮기며
`computeExitResult`의 예치금 반환액 계산부(`heldAmount`/`refundAmount`)
를 원본을 옆에 두지 않고 기억에 의존해 재구성하다가, 실제 상수
(`EXIT_DEPOSIT_VALUE=10000`)와 공식(`heldAmount = EXIT_DEPOSIT_VALUE *
discountRatio`)을 놓치고 임의의 `depositAmount=50000`과 반대 방향
공식(`heldAmount = depositAmount * (1 - discountRatio)`)으로 잘못
작성했다 — 문법 검사와 기존 190여 개 테스트는 이 함수를 전혀
호출하지 않아 통과했지만, 이번 8차에서 `handleAdminExitPreview`
통합 테스트를 작성하며 기대값과 실제값이 반대로 나오는 것을 보고
발견했다. `git show HEAD:.../index.js`로 커밋된 원본을 다시 꺼내
`computeExitResult` 전체를 그대로 교체해 바로잡았고, 이후 이동한
22개 함수 전부를 원본과 자동 diff로 대조해 주석 축약 외 로직
차이가 없음을 재확인했다. **교훈**: "로직 변경 없이 그대로 옮긴다"
원칙을 지키려면 큰 함수일수록 기억으로 재구성하지 말고 원본 텍스트를
그대로 복사해야 한다 — 이번엔 통합 테스트가 안전망 역할을 했지만,
읽기 전용 함수였다면 조용히 프로덕션에 배포될 뻔했다.

**통합 테스트 3개 파일(31개 케이스)**:
- `test/exit-requests.test.js`(13개) — `handleSetExitRequest`/
  `handleAgreeExitRequest`/`handleCancelExitRequest`/
  `handleBotExitRequests`. LeaveQueue DO(실제 workerd)에 직접
  기록된 값을 검증한다. `resolveMemberNumber`가 `session.memberNumber`
  로 즉시 반환되는 경우에도 그 앞에서 `getServiceAccountAccessToken`
  이 항상 먼저 실행됨을 놓쳐 첫 시도에 다수 실패했다 — 각 테스트에
  OAuth fetch mock을 명시적으로 걸어 해결.
- `test/exit-fetch.test.js`(10개) — `handleAdminExitedMembers`/
  `handleAdminExitCandidates`/`handleAdminExitBlacklist`/
  `handleAdminBlacklist`. MemberSettingsDO(실제 workerd)에 exit
  결과를 미리 심어(seed) 조회 결과를 검증한다.
- `test/exit-confirm.test.js`(8개) — `handleAdminExitPreview`/
  `handleAdminExitConfirm`. `buildPersonalStatus` 전체(개인 탭
  조회+`_computeOutputPenSlots`+`_computeReportScore`+`getMeritRank`
  →`buildRosterStatus`)를 실제로 태우는 가장 무거운 mock 시나리오 —
  같은 회원번호(1번)의 "데이터" 탭 슬롯 조회가 `_computeOutputPenSlots`
  (`'데이터'!F4:M4`, 시트명을 작은따옴표로 감쌈)와
  `_computeRosterStatus`(`데이터!F4:M4`, 따옴표 없음)에서 URL이
  거의 같게 인코딩되어(둘 다 회원 1번=4행) 처음엔 서로의 mock을
  가로챘다 — `encodeURIComponent`가 작은따옴표를 인코딩하지 않는
  성질을 이용해 `'`를 표식으로 구분해 해결.

index.js 8,463→7,338줄(약 1,125줄 감소, 시작(10,984줄) 대비 총
33.2% 감소). `npm test` 기준 247개 테스트 전부 통과(기존 216개 +
신규 31개). 배포 후 curl로 `/admin/exit/candidates`,
`/admin/members/exited`, `/admin/blacklist`, `/exit-request`,
`/exit-request/agree`, `/exit-request/cancel`, `/admin/exit/preview`,
`/admin/exit/confirm`, `/admin/exit/blacklist`, `/bot/exit-requests`
전부 정상 인증 응답(401/403) 확인, `wrangler tail`로 실제 요청과
봇 트래픽이 예외 없이("Ok") 처리됨을 확인했다.

## 구조 개선 9차 — 사이클 판정 정리 + CYCLE_MAX_LEN 버그 수정 (2026-09-13)

8차 완료 기록에서 예고한 대로 index.js에 남아있던 사이클 판정
함수 `hasUnpaidFineInCycle`/`hasForcedCandidateInCycle`과, 이 둘을
호출하는 유일한 핸들러 `handleCycleList`(`GET /cycles`)를 `src/cycle.js`
로 옮겼다. 8차보다 훨씬 작은 규모(약 125줄)의 "워밍업" 성격 정리다.

**🔧 착수 전 실제 프로덕션 버그 발견·즉시 수정**: 이동 작업을 시작하기
전 코드를 다시 읽다가, `handleCycleList`가 참조하는 `CYCLE_MAX_LEN`
(cycle.js의 상수, 값 3)이 index.js의 cycle.js import 목록에 빠져있는
것을 발견했다 — `GET /cycles`를 호출할 때마다 `ReferenceError:
CYCLE_MAX_LEN is not defined`로 500이 나고 있었다(프론트의 사이클
토글 UI가 이 엔드포인트를 씀). 이 함수가 언제부터 index.js에
있었는지와 무관하게, 발견 즉시 import에 추가해 별도 커밋 없이 9차
작업에 포함해 바로잡았다. 기존 테스트 스위트에 `/cycles` 관련
테스트가 전혀 없어(`grep -rl handleCycleList test/`가 빈 결과) 8차
이전부터 이 버그가 감지되지 못하고 있었던 것으로 보인다.

**이동 대상**: `hasUnpaidFineInCycle`(사이클에 벌금 미납 기록이
있는지, 회원 지정 가능), `hasForcedCandidateInCycle`(사이클에 자동
강제퇴실 후보가 있는지, 회원 지정 가능), `handleCycleList`(`GET
/cycles`, 사이클 토글 목록 + 위 두 판정을 `includeUnpaid`/
`includeForced` 쿼리 파라미터로 선택 포함). fines.js의
`listUnpaidFines`, exit.js의 `getAllExitRelevantStatus`/
`listExitCandidates`, deposit.js의 `calcForcedOutDeposit`을 재export가
아니라 실제 사용 목적으로 import한다 — 6~8차에서 반복 검증된 "실사용
import" 패턴 그대로다. `getAllExitRelevantStatus`(exit.js)와
`findMemberNumberByEmail`(index.js)이 각각 export 안 되어 있던 것을
발견해 export를 추가했다. 이동 후 index.js에서 더는 안 쓰이게 된
`listUnpaidFines`/`listExitCandidates`의 fines.js/exit.js import도
함께 제거했다.

**8차 교훈 적용**: `computeExitResult`를 기억으로 재구성하다 실제
버그를 만들 뻔했던 8차 경험에 따라, 이번엔 이동한 함수 3개를 곧바로
`git show HEAD:frame-checker-worker/src/index.js`로 꺼낸 원본과 자동
diff 대조했다 — 전부 완전히 일치함을 확인(주석 차이도 없음).

**통합 테스트**: `test/cycle-list.test.js`(8개 케이스, 신설) — 6~8차와
동일하게 fetch mock만 사용(DO 의존 없음). `handleCycleList`의 "로그인
후 200 정상 응답 + maxWeeks 필드 확인" 테스트가 곧 이번 CYCLE_MAX_LEN
버그 수정의 회귀 방지 테스트를 겸한다 — 이 테스트가 먼저 있었다면
애초에 버그가 배포되지 않았을 것이다. `test/cycle-fetch.test.js`(3단계
때 신설된 기존 파일, `listBackupFiles`/`resolveTargetFileId`/
`listCurrentCycleBackups` 테스트)와 이름이 겹칠 뻔했다 — 최초 작업 중
실수로 이 기존 파일을 덮어썼다가 `git status`에서 "modified"로 표시된
것을 보고 발견해 `git checkout`으로 복원하고, 신규 테스트는 별도
파일(`cycle-list.test.js`)로 분리했다.

index.js 7,338→7,202줄(약 136줄 감소, 시작(10,984줄) 대비 총 34.4%
감소). `npm test` 기준 255개 테스트 전부 통과(8차 종료 시점 247개 +
신규 8개, 기존 `cycle-fetch.test.js`의 7개는 247개 안에 포함되어
있던 것을 재확인). 배포 후 curl로 `/cycles` 정상 401 응답 확인,
`wrangler tail`로 실제 요청과 봇 트래픽이 예외 없이("Ok") 처리됨을
확인했다.

## 구조 개선 10차 — 알림/푸시 도메인 통합 테스트 + 이동 (2026-09-13)

> **🔧 [18차 갱신 노트]** 아래 "순환 없는 잎(leaf) 도메인"이라는
> 서술은 **10차 당시에는 사실**이었으나, 16차에서
> `handleAdminMembersRoster`가 members.js로 옮겨가며 members.js가
> notify.js의 `loadNotifyPrefs`/`getPushDeviceIndex`를 실사용
> import하게 됐고 notify.js도 members.js의 `listAllMembers`를
> 실사용 import해, **지금은 index.js를 거치지 않는 직접 순환이
> members.js↔notify.js 사이에 있다**(17차 구조 감사에서 발견, 두
> 심볼 모두 함수 선언이라 TDZ 위험은 없음). member-utils.js는
> 18차에서 pure-utils.js로 리네임됐다. 아래 본문은 10차 시점
> 기록을 그대로 보존한다.

9차 조사에서 예고한 대로 알림/푸시 도메인(카테고리별 알림 설정,
상태 메시지, 웹 푸시 구독/기기 관리/발송, 참여자 간 알림)을
`src/notify.js`로 옮겼다. 조사 결과 이 도메인은 다른 도메인 파일
(fines.js/exit.js/deposit.js/cycle.js)을 전혀 실사용하지 않는 순환
없는 잎(leaf) 도메인이었다 — members.js의 `listAllMembers`만
소비하고, 나머지는 push-crypto.js/member-utils.js의 이미 export된
순수 함수와 index.js의 범용 뼈대 유틸(verifySession/
getServiceAccountAccessToken/requireAdmin/json/getMemberSettingsStub)
만 가져다 쓴다.

**착수 전 조사에서 발견한 사실**: 같은 구역(index.js 5988~6864행)에
알림/푸시가 아닌 함수들이 섞여 있었다 — `checkReportCooldown`류(제보
도메인), `handlePutParticipants`/`handleGetParticipants`(참여자 명단
도메인), `requireAdmin`/`requireAdminOrCoReviewer`(인증, 이미
export), `handleMigrateFixCollectMoneyFormula`(일회성 마이그레이션).
이들은 라우팅 매핑을 먼저 확인해 이번 범위에서 제외했다 — 라우팅
테이블(`/push/*`, `/notify-prefs`, `/status-message*`,
`/member-status-message`, `/admin/push/*`)과 정확히 일치하는 15개
handle*만 골라 옮겼다.

**이동 대상(22개)**: `getPushSubscriptionsStub`, `checkNoticeCooldown`
/`recordNotice`/`listRecentNotices`(ParticipantsRoster DO 위임),
`loadNotifyPrefs`, `handleGetNotifyPrefs`, `handleSetNotifyPrefs`,
`loadStatusMessage`, `handleGetStatusMessage`, `handleSetStatusMessage`,
`handleGetMemberStatusMessage`, `handleAdminPushSendCategory`,
`getPushDeviceIndex`, `handlePushSubscribe`, `sha256Hex`,
`handleListPushDevices`, `handlePushDeviceToggle`,
`handlePushDeviceRename`, `handlePushDeviceRemove`,
`handlePushSendTest`, `handlePushSubscriptionStatus`,
`handlePushSendToMember`, `handleListRecentNotices`.
`NOTIFY_CATEGORIES`(member-utils.js의 `defaultNotifyPrefs`와
`handleAdminMembersRoster`도 참조하는 범용 상수)와 `getRosterStub`
(withMemberLock 등 여러 도메인이 공유하는 DO 스텁, export만 추가)은
index.js에 남겼다.

**8~9차 교훈 재적용**: 이동한 22개 함수 전부를 `git show
HEAD:frame-checker-worker/src/index.js`로 꺼낸 원본과 자동 diff
대조해 완전히 일치함을 확인했다(주석 차이도 없음) — 8차의
`computeExitResult` 재구성 오류를 반복하지 않았다.

**통합 테스트 3개 파일(39개 케이스)**:
- `test/notify-prefs.test.js`(13개) — `handleGetNotifyPrefs`/
  `handleSetNotifyPrefs`/`handleGetStatusMessage`/
  `handleSetStatusMessage`/`handleGetMemberStatusMessage`.
  MemberSettingsDO(실제 workerd)에 저장된 값을 검증한다.
- `test/notify-push-devices.test.js`(13개) — `handlePushSubscribe`/
  `handleListPushDevices`/`handlePushDeviceToggle`/
  `handlePushDeviceRename`/`handlePushDeviceRemove`/
  `handlePushSubscriptionStatus`. PushSubscriptionsDO(실제 workerd)에
  직접 기록된 값을 검증한다.
- `test/notify-push-send.test.js`(13개) — `handleAdminPushSendCategory`/
  `handlePushSendTest`/`handlePushSendToMember`/
  `handleListRecentNotices`. `sendWebPush`가 실제 fetch로
  `subscription.endpoint`에 POST하므로 5차(push-crypto)와 동일하게
  유효한 VAPID 키쌍을 env에 심어 암호화 경로까지 실제로 태운다.
  **DO 상태 격리 실수를 발견·수정**: "카테고리를 꺼둔 회원" 테스트와
  "정상 발송" 테스트가 우연히 같은 회원번호(1)·이메일
  (`member@test.com`)을 써서, `loadNotifyPrefs`/`getPushDeviceIndex`
  가 참조하는 MemberSettingsDO/PushSubscriptionsDO(둘 다 전역
  싱글턴, `GOOGLE_SHEET_FILE_ID`를 바꿔도 격리되지 않음)의 상태가
  테스트 간에 새어나가 "정상 발송" 테스트가 실패했다 — 각기 다른
  회원번호/이메일을 쓰도록 고쳐 해결했다. 6~9차의 "fileId를 다르게
  줘서 캐시 오염 방지" 원칙이 DO 키에는 적용되지 않는다는 걸 보여준
  사례라 이후 차수에서도 주의할 지점이다.

index.js 7,202→6,596줄(약 606줄 감소, 시작(10,984줄) 대비 총 **40.0%
감소** — 처음으로 40%를 넘었다). `npm test` 기준 294개 테스트 전부
통과(9차 종료 시점 255개 + 신규 39개). 배포 후 curl로 `/push/*`,
`/notify-prefs`, `/status-message*`, `/member-status-message`,
`/admin/push/*` 전부 정상 401/403 응답 확인, `wrangler tail`로 실제
요청과 봇 트래픽이 예외 없이("Ok") 처리됨을 확인했다.

## 구조 개선 11차 — 사유반휴/일반반휴 도메인 통합 테스트 + 이동, TDZ 버그 발견·수정 (2026-09-13)

10차 조사에서 예고한 대로 사유반휴/일반반휴 도메인(즉시 신청·관리자
대리 신청, 증빙 업로드→봇 대기열→관리자 승인/반려)을 `src/leave.js`
로 옮겼다. 사전에 우려했던 `hasQueuedReasonLeaveProof`↔
`buildPersonalStatus` 역참조 방향을 실제로 확인한 결과, 정확히는
그 안의 `listQueuedReasonLeaveDays`를 `buildPersonalStatus`(개인
대시보드, index.js 잔류)가 실사용으로 참조하는 것으로 확인됐다 —
9~10차와 동일한 "실사용 import" 패턴으로 처리했다. 같은 이유로
`flushQueuedReasonLeaveProofs`도 `handleBotRegisterUrl`(봇 도메인,
index.js 잔류)이 실사용하므로 export해 재import했다.

**🔧 이동 작업 중 심각한 실제 버그 발견·수정(TDZ)**: leave.js를
작성한 직후 통합 테스트를 돌리자 모든 셀 range가 `1!CNaN`으로
깨지는 것을 발견했다. 원인은 index.js의 leave.js `import` 구문
(파일 상단, 250행대)이 index.js 자신의 `ROW_NORMAL_LEAVE_USE` 등
`export const` 선언(파일 하단, 985행대)보다 앞서 실행된다는
것이었다 — leave.js가 로드되는 시점에 그 상수들은 아직 초기화 전
(TDZ)이라, leave.js 모듈 최상위에서 즉시 `LEAVE_TYPE_CONFIG = {
normal: { useRow: ROW_NORMAL_LEAVE_USE, ... } }`를 만들면 그
안의 모든 값이 `undefined`(계산 결과는 `NaN`)로 굳어버렸다. 6~10차
에서 반복 검증된 "재export 전용 순환은 함수 호출 시점에만 지연
평가되므로 안전하다"는 원칙이 **최상위에서 즉시 평가되는 객체
리터럴에는 적용되지 않는다**는 걸 이번에 처음 발견했다 — 함수
호이스팅과 달리 `const` 객체 리터럴은 모듈 로드 시점에 즉시
실행되기 때문이다. `LEAVE_TYPE_CONFIG`를 `getLeaveTypeConfig(type)`
함수로 감싸 실제 요청 처리 시점(index.js 전체 평가가 끝난 뒤)에만
계산되도록 고쳐 해결했다. 통합 테스트의 fetch mock URL 검증이 이
버그를 실제로 잡아냈다 — 배포 전에 발견되어 프로덕션에는 영향이
없었다.

**이동 대상(18개 함수 + 관련 상수)**: `_readLeaveQueueIndex`,
`_appendLeaveHistory`, `_readLeaveHistory`(LeaveQueue DO 위임),
`handleGetLeaveApply`, `checkAndRecordLeaveApplyRate`,
`handleSetLeaveApply`, `handleAdminLeaveApply`,
`handleGetReasonLeaveProof`, `listQueuedReasonLeaveDays`,
`hasQueuedReasonLeaveProof`, `handleSetReasonLeaveProof`,
`handleCancelReasonLeaveProof`, `flushQueuedReasonLeaveProofs`,
`listQueuedReasonLeaveItems`, `handleAdminLeaveProofList`,
`base64ToBytes`, `handleAdminLeaveProofFile`,
`handleAdminLeaveProofDecide`. `proxyToBotDashboard`/
`proxyToBotDashboardRaw`(제보 도메인도 공유하는 범용 봇 프록시),
`corsHeaders`, `parseLeaveCount`, 4개 `ROW_*` 상수는 index.js에
남기고 export만 추가했다.

**8~10차 교훈 재적용**: 이동한 18개 함수와 관련 상수 전부를 `git
show HEAD:.../index.js`로 꺼낸 원본과 자동 diff 대조해 완전히
일치함을 확인했다 — `LEAVE_TYPE_CONFIG` 등 최상위 상수도 값 자체는
원본과 동일하고, 지연 평가로 감싼 구조만 바뀌었다(로직 변경 없음
원칙 유지, 감싸는 방식 변경은 TDZ 버그 수정을 위한 불가피한 최소
개입).

**통합 테스트 2개 파일(33개 케이스)**:
- `test/leave-apply.test.js`(12개) — `handleGetLeaveApply`/
  `handleSetLeaveApply`/`handleAdminLeaveApply`. 실제 workerd
  ParticipantsRoster DO의 `leave-rate/check`(회원당 분당 2회 제한)
  까지 실제로 태워 3번째 요청이 429가 나는지 검증한다. 월요일이
  `STATUS_DAY_COLS[0]=2`(0-idx) → C열이라 사용 셀(`{번호}!C20`)과
  잔여 셀(`{번호}!C{leftRow+1}`=40)이 둘 다 "!C"로 시작해 처음엔
  행 번호 없이 구분하려다 mock이 꼬였다 — 행 번호까지 포함해 구분해
  해결.
- `test/leave-proof.test.js`(21개) — `handleGetReasonLeaveProof`/
  `handleSetReasonLeaveProof`/`handleCancelReasonLeaveProof`/
  `handleAdminLeaveProofList`/`handleAdminLeaveProofFile`/
  `handleAdminLeaveProofDecide`. 봇 URL을 설정하지 않으면
  `proxyToBotDashboard`가 fetch 없이 즉시 `null`을 반환하는 성질
  (BotAdminConfigDO, 실제 workerd)을 활용해 "봇 오프라인" 경로
  (LeaveQueue DO 큐 경유)를 mock 없이 자연스럽게 검증했다. 관리자
  승인 테스트에서 `getSheetValues(...).catch(() => [])`가 mock
  실패를 조용히 삼켜 range 오타(`!C20` vs 실제 `!C21`,
  `ROW_REASON_LEAVE_USE+1`)를 우연히 통과시킬 뻔한 것을 write
  호출 내용을 직접 로그로 찍어 발견·수정했다.

index.js 6,596→5,780줄(약 816줄 감소, 시작(10,984줄) 대비 총
**47.4% 감소**). `npm test` 기준 327개 테스트 전부 통과(10차 종료
시점 294개 + 신규 33개). 배포 후 curl로 `/leave-apply`,
`/admin/leave-apply`, `/reason-leave-proof`, `/reason-leave-proof/cancel`,
`/admin/leave-proof`, `/admin/leave-proof/file`,
`/admin/leave-proof/decide` 전부 정상 401/403 응답 확인(curl에
한글 쿼리 파라미터를 직접 넘기면 URL 인코딩이 깨져 400이 나는
현상을 발견 — `day=%EC%9B%94`로 인코딩해 재확인하니 정상 401,
코드 자체는 문제없었음), `wrangler tail`로 실제 요청과 봇 트래픽이
예외 없이("Ok") 처리됨을 확인했다.

## 구조 개선 12차 — 제보/캡처 도메인 통합 테스트 + 이동 (2026-09-13)

11차에서 예고한 대로 남은 최대 후보였던 제보/캡처 도메인을
`src/report.js`(약 1,871줄)로 옮겼다. 조사 결과를 바탕으로
AskUserQuestion으로 범위를 확인한 뒤 "조사된 전체 범위로 한 번에"
진행하기로 하고, 44개 함수/상수를 한 번에 이동했다 — 이전 차수들과
달리 이동 대상이 index.js 내에서 연속 블록이 아니라 여러 구간에
걸쳐 다른 도메인(개인 대시보드 공용 유틸, 봇 상태/사용량 도메인)과
촘촘히 섞여 있어, 구간마다 Read로 시작/끝 줄을 재확인하며 발췌
이동(cherry-pick move)했다.

**착수 전 조사에서 사람이 재검증해 범위를 두 차례 좁혔다**:
1. `latestSlotDay`, `buildSlotHistory`, `getRowNotes`,
   `getSheetIdByName`, `parseSlotNoteDateMs`, `msToStatusDay`,
   `depositAgainOccurredDay` — 조사 에이전트가 이동 대상으로
   분류했으나, 실제로는 exit.js(8차)와 `buildPersonalStatus`(개인
   대시보드, index.js 잔류)가 공유하는 범용 함수임을 grep 재확인으로
   발견해 제외하고 index.js에 export만 추가했다.
2. `handleBotSheetsUsageReport`, `handleInternalCycleBoundary`,
   `handleBotRegisterUrl`, `handleAdminUsageStatus`,
   `handleAdminBotStatus`, `handleAdminBotCommand`,
   `fetchCloudflareUsage` 등 6~7개 함수는 라우팅과 로직을 대조한
   결과 제보/캡처가 아니라 별개의 "봇 상태/사용량" 도메인임을
   확정하고 13차 이후 후보로 분리했다.

**이동 대상(44개)**: 접수/쿨다운(`handleReport`,
`handleListActiveCooldowns`, `handleReportCaptureDone`,
`handleListReports`, `handleRequeueReport`, `getReportQueueStub`,
`getReportVoteStub`, `checkReportCooldown`, `recordReportCooldown`,
`markReportCaptureDone`, `listReportCooldowns`,
`requireAdminOrCoReviewer`, 관련 상수), 캡처 목록/응답/투표
(`handleAdminCapturesList`, `handleMyCaptures`,
`handleMyCaptureDelete`, `handleMyOutputPen`,
`handleCaptureTargetRespond`, `handleAdminCaptureVote`,
`handleAdminCaptureFile`, `handleReportStatus`,
`applyAutoRecognitionForExpired`), 승인/취소/삭제/반려취소
(`handleAdminCaptureDecide`, `handleAdminCaptureCancel`,
`handleAdminCaptureCancelMerit`, `handleAdminCaptureDelete`,
`handleAdminCaptureRevert`, `applyOutputPenalty`, `applyReportMerit`,
`applyTimeDeduction`, `cancelTimeDeduction`, `cancelOutputPenalty`,
`cancelReportMerit`, `hasReporterAlreadyReceivedMeritToday`,
`snapshotNextOccurrence`, `findStoredPenaltyMerit`,
`fetchCaptureReviewStatus` 등)까지 세 그룹으로 나뉜다.
`getCurrentCoReviewers`, `proxyToBotDashboard`/
`proxyToBotDashboardRaw`, `getRosterStub`/`withMemberLock`, `getSheetIdByName`
등 범용 유틸은 index.js에 남기고 export만 추가했다.

**🔧 배포 전 코드 검토에서 발견한 버그**: report.js 작성 후 index.js
잔여 참조를 grep하다가, 파일 끝의 `scheduled`(cron) 핸들러가
`applyAutoRecognitionForExpired(env, data.items || [])`를 직접
호출하고 있는데 이 함수가 export 없이 report.js로 옮겨져 있었다는
것을 발견했다 — 배포했다면 5분마다 도는 cron이 매번
`ReferenceError`로 실패했을 심각한 버그(11차 TDZ 버그와 유사하게
실제 배포 전 단계에서 발견). `export async function
applyAutoRecognitionForExpired`로 고치고 index.js가 9~11차와 동일한
"실사용 import" 패턴으로 가져오도록 수정해 해결했다.

**44개 함수 전체 diff 검증**: `git show HEAD:.../index.js`로 꺼낸
11차 종료 시점 원본에서 정규식 기반 스크립트로 44개 함수를 각각
추출해 report.js와 diff 대조했다. 43개는 완전 일치, `handleCaptureTargetRespond`
1개만 주석 줄 들여쓰기가 원본(8칸, 명백한 오타)과 새 파일(4칸,
정상 재작성) 간에 차이가 있어 — "로직 변경 없이 그대로 옮긴다"
원칙에 따라 원본의 오타까지 그대로 재현해 완전 일치를 달성했다.

**통합 테스트 3개 파일(67개 케이스)**: 🔧 [2026-09-19 갱신] 개수는 실측
(`grep -c "it(" <파일>`) 기준으로 다시 세었다 — 아래 서술이 실제 코드와
달라지면 이 개수부터 다시 세어 갱신할 것.
- `test/report-submit.test.js`(18개) — 접수/쿨다운/안전망 큐.
  봇 오프라인(BOT_URL 미설정 → `proxyToBotDashboard`가 fetch 없이
  즉시 null) 경로를 mock 없이 자연스럽게 검증.
- `test/report-captures-list.test.js`(27개) — 관리자/본인 캡처
  목록·삭제·응답·투표·파일·상태 조회. `handleAdminCaptureVote`가
  `requireAdminOrCoReviewer`로 역할부터 검증하는 순서라, "severity
  값이 잘못되면 400" 케이스는 실제 coReviewer 세션(부스터디장 시트
  L3 값 mock)까지 갖춰야 도달함을 확인해 mock을 보강했다.
  🔧 [수신/발신 통합, 2026-09-19] "내 화각 불량 제보"가 대상자로
  지목된 수신 건뿐 아니라 본인이 제보한 발신 건도 함께 보여주도록
  확장되면서(`handleMyOutputPen`), 그 판정을 담당하는 순수 함수
  `isVisibleForMyOutputPen`/`myOutputPenDirection`(report-review.js)에
  대한 별도 `describe` 블록 5개 케이스가 추가됐다 — selfCheck 기록
  제외, 수신("nickname"이 본인)/발신("reporterEmail"이 본인) 각각의
  판정, 그리고 둘 다 아닌 경우 `false`를 반환하는지 확인한다.
- `test/report-decide.test.js`(22개) — 승인/취소/삭제/반려취소.
  `applyOutputPenalty`/`applyReportMerit`가 실제로 "데이터" 시트
  F~K(벌점)/R~V(제보상점) 슬롯에 쓰는지까지 fetch mock으로 검증했다.
  최초 작성 시 슬롯 셀 위치를 `번호` 그대로(F5) 잘못 가정했으나
  실제로는 `행 = 번호 + 3`(F8)이라 fetch 호출 로그로 원인을 찾아
  수정했고, `집계!D25`/`R%3AV` 등 URL 매처가 한글 range의
  `encodeURIComponent` 결과(`%EC%A7%91%EA%B3%84!D25`)와 매칭되지
  않아 엉뚱한 폴백 mock으로 새어나간 것도 같은 방식으로 발견·수정했다.
  봇 URL 미설정 상태를 활용해 "시트에는 반영됐지만 봇 manifest
  갱신에 실패한" 502 자동 롤백 경로(승인 벌점/제보상점 되돌리기)도
  실제 fetch 호출 검증으로 확인했다.

index.js 5,780→3,937줄(약 1,843줄 감소, 시작(10,984줄) 대비 총
**64.2% 감소** — 60%대 최초 돌파). `npm test` 기준 386개 테스트
전부 통과(11차 종료 시점 327개 + 신규 59개). 배포 후 curl로
`/report`, `/report-cooldowns`, `/reports`, `/reports/requeue`,
`/reports/capture-done`, `/admin/captures*`, `/my-captures*`,
`/my-output-pen`, `/captures/target-respond`, `/report-status`,
`/admin/captures/decide`, `/admin/captures/vote` 전부 정상 401/403
응답 확인, `wrangler tail`로 실제 요청이 예외 없이("Ok") 처리됨을
확인했다.

## 🔧 긴급 수정 — 12차 이동 중 실수로 삭제된 함수 2개 복구 (2026-09-13)

13차 착수 조사 중, 라우팅 테이블이 `handleBotSheetsUsageReport`/
`handleInternalCycleBoundary`를 호출하는데 index.js 어디에도 그
정의가 없다는 것을 발견했다. 12차(제보/캡처 도메인) 발췌 이동 시
경계를 잘못 잡아 — 이 두 함수가 이동 대상(`handleReportCaptureDone`
~`handleListReports`) 사이에 끼어 있었는데, 발췌 범위가 이들까지
함께 삼켜버렸다. 라우팅 테이블은 그대로 남아있어 배포 직후부터
`/admin/bot-sheets-usage`, `/internal/cycle-boundary` 두 엔드포인트가
호출될 때마다 `ReferenceError`로 500을 반환하고 있었다(전자는 봇의
5초 주기 사용량 보고, 후자는 매주 월요일 캡처 정리 배치가 호출 —
당장 대량 장애는 아니지만 방치하면 사용량 계측과 캡처 아카이브
경계 판정이 조용히 계속 실패했을 것). 11차 종료 시점 원본(git
show)과 완전히 동일하게 복구해 즉시 배포하고, 두 엔드포인트가
정상 401을 반환하는지, `wrangler tail`에 예외가 없는지 확인한 뒤
별도 커밋으로 남겼다. **교훈**: 발췌 이동(여러 구간에 흩어진
함수를 나눠서 옮기는 방식)에서는 이동 후 index.js 쪽에 "옮긴
함수가 실제로 전부 옮겨졌는지"뿐 아니라 "옮기지 않은 함수가
실수로 함께 삭제되지 않았는지"도 라우팅 테이블 전체를 grep해
교차 검증해야 한다 — diff 대조는 옮긴 함수가 원본과 일치하는지만
확인할 뿐, 옮기지 않았어야 할 함수가 사라진 것은 잡아내지 못한다.

## 구조 개선 13차 — 봇 상태/사용량 도메인 통합 테스트 + 이동 (2026-09-13)

12차에서 분리해둔 대로 봇 상태/사용량 도메인을 `src/bot.js`로
옮겼다. `handleBotRegisterUrl`, `handleBotSheetsUsageReport`,
`handleInternalCycleBoundary`, `fetchCloudflareUsage`,
`handleAdminUsageStatus`, `handleAdminBotStatus`,
`handleAdminBotCommand` 7개 함수 — 이전 차수들보다 작은 규모지만,
`proxyToBotDashboard`/`proxyToBotDashboardRaw`, `getBotAdminConfigStub`,
`BOT_URL_CONFIG_KEY`/`BOT_PROXY_TIMEOUT_MS`, 사용량 계측 클러스터
(`_bumpUsageCounter`/`_getUsageCounter`/`_emailNameMap`/
`_menuNameForPath`/`_usageCounters`/`_dailyUsageBuffer`/
`_minuteUsageBuffer`/`_pendingNameFlush`), `getUsageStatsStub`/
`flushDailyUsageStats`까지 index.js의 로그인/OAuth, 시트 읽기·쓰기
계측(58곳 이상의 `_bumpUsageCounter` 호출), cron(`scheduled`가
`flushDailyUsageStats` 직접 호출)과 두루 얽혀 있어 범위를 정확히
가르는 데 공을 들였다. 이 범용 유틸 전부는 index.js에 남기고
`export`만 추가했다 — 새 파일로 옮긴 건 라우팅 테이블에서만
호출되고 index.js의 다른 함수가 실사용하지 않는 6개 핸들러 +
`fetchCloudflareUsage`(내부 전용)뿐이다. `handleBotRegisterUrl`이
쓰는 `flushQueuedReasonLeaveProofs`(leave.js, 11차)는 index.js를
거치지 않고 bot.js가 leave.js에서 직접 import하도록 정리했다
(index.js는 더 이상 이 함수를 쓰지 않으므로 그 import도 제거).

**7개 함수 전체 diff 검증**: 정규식 기반 함수 추출로 이동 전
원본(직전 커밋의 index.js, 위 긴급 수정 포함)과 bot.js를 비교해
7개 전부 완전 일치를 확인했다.

**통합 테스트(`test/bot-status.test.js`, 17개)**: BotAdminConfigDO/
UsageStats 모두 실제 workerd DO를 그대로 써서(mock 불필요)
`handleBotRegisterUrl`이 실제로 DO에 URL을 쓰는지, 그 값을
`handleAdminBotStatus`가 다시 읽어 실제로 그 주소로 fetch하는지까지
end-to-end로 검증했다. `handleAdminUsageStatus`는 `CF_API_TOKEN`/
`CF_ACCOUNT_ID`를 비워 `fetchCloudflareUsage`가 fetch 없이 즉시
null을 반환하는 경로(cloudflareConfigured:false)를 mock 없이
검증했다. `handleInternalCycleBoundary` 테스트에서 처음엔 Drive
파일 목록만 mock했다가 `listCurrentCycleBackups`가 내부적으로
`집계!D25`(현재 페널티 사이클)도 함께 조회한다는 것을 놓쳐 500이
났다 — mock을 보강해 해결(12차에서 확립한 "폴백 mock이 조용히
받아버리는 경로를 조심하라"는 교훈과 같은 종류의 실수).

파일 전체를 실행하면 workerd 풀 내부에서 "uncaught exception:
internal error"라는 스택 없는 로그가 이따금(24회 실행 중 1회)
찍히며 그 1회에서 드물게 테스트가 실패하는 현상을 관찰했다 —
같은 파일을 단독/부분 조합으로 실행하면 재현되지 않고, 반복 실행
시 대부분(23/24, 그리고 이후 15/15 연속) 통과해 코드 결함이 아니라
다수의 DO 인스턴스가 한 파일에 몰릴 때 발생하는 테스트 풀 자체의
teardown 경합으로 판단했다 — 전체 스위트(`npm test`)를 연속 2회
돌려도 403/403 전부 통과함을 확인해 실제 배포에는 영향이 없음을
확인했다.

index.js 3,987(긴급 수정 후)→3,624줄(약 363줄 감소, 시작(10,984줄)
대비 총 **67.0% 감소**). `npm test` 기준 403개 테스트 전부
통과(12차 종료+긴급수정 시점 386개 + 신규 17개). 배포 후 curl로
`/bot/register-url`, `/admin/bot-sheets-usage`,
`/internal/cycle-boundary`, `/admin/bot/status`, `/admin/usage`,
`/admin/bot/command` 전부 정상 401/403 응답 확인, `wrangler tail`로
실제 요청이 예외 없이("Ok") 처리됨을 확인했다.

## 구조 개선 14차 — 로그인/OAuth 도메인 통합 테스트 + 이동 (2026-09-13)

13차에서 다음 후보로 지목한 로그인/세션/OAuth 도메인 중, `getAdminAccessToken`
과 얽힌 부분을 제외한 순수 로그인·OAuth 플로우를 `src/auth.js`로
옮겼다. 착수 조사에서 이 도메인이 겉보기와 달리 두 갈래로 갈라져
있다는 것을 확인했다:

1. **옮긴 것(9개 함수 — 라우팅에서만 호출, index.js의 다른 함수가
   실사용하지 않음)**: `getGoogleCerts`/`verifyGoogleIdToken`(RS256
   JWKS 검증), `getSheetViewerEmails`(참여자 명단 확인),
   `completeLogin`/`handleVerify`/`handleDevLogin`(로그인 완료
   절차), `requireAdminFromQuery`/`handleAdminOAuthAuthorize`/
   `handleAdminOAuthCallback`(관리자 Drive 위임 OAuth 플로우).
   `GOOGLE_CERTS_URL`/`SESSION_TTL_SEC`도 이 파일에서만 쓰여
   그대로 옮겼다(index.js에는 남길 이유가 없어 export 대신 이관).
2. **남긴 것(`getAdminAccessToken`과 그 하위 의존)**: `signSession`/
   `verifySession`(전 도메인 공유), `base64url`/`base64urlToBytes`
   (member-utils.js/push-crypto.js와도 공유), `getServiceAccountAccessToken`
   (전 도메인 공유), `adminOAuthRedirectUri`/`exchangeAdminOAuthCode`/
   `ADMIN_OAUTH_CONFIG_KEY`/`ADMIN_OAUTH_SCOPE` — 얼핏 OAuth 플로우
   전용처럼 보이지만 실제로는 `getAdminAccessToken`(exit.js의
   `performExitReset`, members.js의 `grantSheetAccess` 등 7차에서
   이미 공유 확정)이 refresh_token 갱신에 재사용해 index.js에
   남기고 `export`만 추가했다. `getBotAdminConfigStub`(13차에서
   이미 export)도 로그인 도메인과 봇 도메인 양쪽에서 refresh_token/
   봇 URL을 같은 DO에 저장하는 데 함께 쓰인다.

**9개 함수 전체 diff 검증**: 정규식 기반 함수 추출로 이동 전
원본(직전 커밋의 index.js)과 auth.js를 비교해 9개 전부 완전
일치를 확인했다.

**통합 테스트(`test/auth-login.test.js`, 18개)**: `handleVerify`는
실제 Google 서명 ID 토큰을 테스트에서 위조할 수 없어 크리덴셜
누락/형식 오류 경로만 검증했고, 로그인 완료 로직(`completeLogin`)
자체는 Google 검증을 우회하는 `handleDevLogin`으로 충분히
검증했다(참여자 명단 확인, 회원번호 매칭 성공/실패 양쪽, 세션
토큰 발급 내용 확인). `handleAdminOAuthAuthorize`는 실제
`signSession`으로 관리자/비관리자 토큰을 만들어 302 리다이렉트
URL의 `client_id`/`login_hint`/`state` 파라미터까지 검증했고,
`handleAdminOAuthCallback`은 CSRF 방어용 state의 purpose 불일치·
만료·토큰 교환 실패(500)·성공(200, BotAdminConfigDO에 refresh_token
저장) 경로를 fetch mock으로 검증했다. `MemberSettingsDO`(last-login
기록)는 실제 workerd DO를 그대로 사용했다.

index.js 3,624→3,399줄(약 225줄 감소, 시작(10,984줄) 대비 총
**69.1% 감소**). `npm test` 기준 421개 테스트 전부 통과(13차 종료
시점 403개 + 신규 18개). 배포 후 curl로 `/verify`(크리덴셜 누락/
형식 오류), `/dev/login`(시크릿 오류 401), `/oauth/authorize`(토큰
없음 403), `/oauth/callback`(code 없음 400) 전부 정상 응답 확인 —
로그인은 전체 서비스의 진입점이라 다른 차수보다 스모크 테스트를
더 꼼꼼히 확인했다. `wrangler tail`은 요청이 너무 빨리 끝나 일부
호출은 로그 윈도우에 잡히지 않았지만, curl 응답 자체가 이미 4xx
정상 에러(500 아님)임을 직접 확인했으므로 문제 없다고 판단했다.

## 구조 개선 15차 — 개인 대시보드/랭킹 클러스터 통합 테스트 + 이동 (2026-09-17)

14차에서 "순환 위험이 가장 크다"고 지목했던 `buildPersonalStatus`/
`buildRosterStatus` 클러스터를 `src/personal-status.js`로 옮겼다.
`buildPersonalStatus`는 exit.js가 이미 `from "./index.js"`로
import하고 있어, 3차(deposit.js) 이래 반복해온 "새 파일이 index.js를
import하고 index.js도 그 파일을 다시 import해 재export"하는 패턴을
그대로 적용했다 — 순수 객체 리터럴(`GOAL_TYPE_MULTIPLIER` 등)만
재export하고 함수는 전부 함수 선언(호이스팅)이라 11차의 TDZ 위험이
없음을 재확인했다.

**이동 대상(33개 함수 + 4개 상수)**: 개인 탭 순수 계산 함수(`isConfirmed`,
`formatMinutes`, `parseHHMMToMinutes`, `dailyGoalMinutes`,
`isDayComplete`, `isWeekdayComplete`, `meritMultiplier`, `isDayEmpty`,
`weeklyReasonLeaveTotal`, `meritZeroConditions`, `buildPeriodGrid`,
`periodAttendanceBreakdown`, `weeklyGoalMinutes`, `weeklyGoalTime`,
`explainDay`, `GOAL_TYPE_MULTIPLIER`), 개인 상태 핵심(`getMeritRank`,
`_computeReportScore`, `_computeOutputPenSlots`, `MORNING_GOAL_MINUTES`,
`dayDateAt`, `parseWeekOfToMonday`, `currentWeekRangeYYMMDD`,
`buildStatusDays`, `buildDepositAgainSnapshot`, `getPersonalStatusBundle`,
`buildPersonalStatus`, `buildExitedMemberSnapshot`, `buildDepositAgainSplit`),
라우트 핸들러(`handleStatus`, `handleAdminMemberStatus`), 랭킹/정산
클러스터(`ROSTER_ROW_START`, `ROSTER_ROW_END`, `buildRosterStatus`,
`_computeRosterStatus`, `handleRosterStatus`, `handleAdminPrizeSettle`).
`parseWon`/`safeNumber`/`parseLeaveCount`/`colIndexToLetter`/
`findMemberNumberByEmail`/`listAllMembers`/`resolveTargetFileId`/
`depositRefundBreakdown`/`totalPenaltyBreakdown`와 이 클러스터가 읽는
시트 레이아웃 상수(`STATUS_DAYS`, `ROW_*`/`COL_*` 20여 개)는
deposit.js/leave.js/exit.js/fines.js/cycle.js/members.js/report.js도
공유하는 범용 유틸이라 index.js에 남기고 export만 추가했다(15차
착수 조사에서 grep으로 전수 확인 — 이번엔 12개 상수가 새로 export로
전환됨).

**🔧 발췌 이동 중 발견·수정한 실제 누락 3건**: 44개 항목을 여러
구간으로 나눠 옮기는 과정에서, 이동 후 `npm test`가 즉시 잡아낸
누락이 세 번 있었다 — (1) `getSheetUnformattedValue`(index.js 잔류
함수인데 애초에 `export`가 안 되어 있었던 기존 버그, `_computeRosterStatus`
가 사용), (2) `countCurrentCyclePen`/`resolveMemberNumber`/
`proxyToBotDashboard`(모두 index.js에 이미 export되어 있었지만
personal-status.js의 import 목록에서 빠짐), (3) `depositAgainOccurredDay`
(index.js에 정의만 있고 `buildExitedMemberSnapshot` 하나만 쓰는데
export가 안 되어 있었음 — export 추가로 해결), (4) `formatYYMMDD`
(date-utils.js, `handleRosterStatus`가 씀). 매번 "정적 export/import
목록 대조 스크립트로 못 잡는 실제 함수 호출 누락"은 `npm test`가
호출 시점에 `ReferenceError`/`TypeError`로 드러냈다 — **13차 교훈
("옮기지 않아야 할 걸 실수로 지웠는지 확인")의 반대 방향인 "옮겨야
할 걸 실수로 안 옮겼는지"도 정적 검토만으로는 못 잡고, 반드시
`npm test` 전체 통과로 최종 확인해야 한다**는 것을 재확인했다.

**세션 중 작업 파일이 두 차례 사라지는 사고**: 이번 차수 작업
도중 `src/personal-status.js`(git에 아직 추가되지 않은 새 파일)가
디스크에서 원인 불명으로 두 차례 사라졌다(git이 추적하는 `index.js`는
매번 무사했음 — untracked 파일만 영향받음). 원인은 특정되지 않았으나
(에디터/동기화 도구 등 외부 요인으로 추정), 이후로는 새 파일을 만들
때마다 **`git add`로 즉시 스테이징**(스테이징된 내용은 git 오브젝트
DB에 안전하게 보관되어 파일시스템 변동과 무관)하고, 별도로 `/tmp`에도
체크포인트 사본을 남기는 절차를 추가해 두 번째 사고부터는 즉시 복구할
수 있었다. **다음 차수부터는 새 파일을 작성한 직후, 그리고 통합
테스트가 통과할 때마다 `git add`로 즉시 스테이징하는 것을 필수
절차로 삼는다** — 커밋 전이라도 스테이징만으로 안전망이 된다.

**44개 항목 전체 diff 검증**: 정규식 기반 함수/상수 추출 스크립트로
`git show HEAD`의 14차 종료 시점 원본과 personal-status.js를 비교해
33개 함수 + 4개 상수 전부 완전 일치를 확인했다(4개 라우트 핸들러는
`export` 키워드 추가만 차이 — 로직 자체는 동일). 이동 후 index.js의
선언 목록을 원본과 diff해 "정확히 이 37개만" 사라졌음을 확인했고
(13차 긴급 수정 이후 정착한 절차), 라우팅 테이블 전체를 grep해 모든
핸들러 호출이 import 또는 로컬 선언으로 해소되는지도 스크립트로
교차 검증했다.

**통합 테스트(`test/personal-status.test.js`, 11개)**: `test/exit-confirm.test.js`
(8차/`buildPersonalStatus`를 이미 무겁게 태우는 기존 테스트)의
`stubForcedExitFetch` mock 패턴을 그대로 재사용해 mock 설계 시간을
아꼈다. `handleStatus`(로그인 필요 401, 명단 미매칭 403, 정상 200),
`handleAdminMemberStatus`(관리자 아니면 403, 존재하지 않는 회원
404, 정상 200, 퇴실자 접두사 `exited:` 분기), `handleRosterStatus`
(로그인 필요 401, 정상 200), `handleAdminPrizeSettle`(관리자 아니면
403, cycle 파라미터 없으면 400)을 검증했다. `listQueuedReasonLeaveDays`/
LeaveQueue DO의 `/exit/get`은 실제 workerd DO를 그대로 써서(둘 다
기본값이 빈 배열/null) 추가 mock 없이 자연스럽게 커버했다.

index.js 3,399→2,189줄(약 1,210줄 감소, 시작(10,984줄) 대비 총
**80.1% 감소** — 80%대 최초 돌파). `npm test` 기준 432개 테스트
전부 통과(14차 종료 시점 421개 + 신규 11개), 연속 3회 실행으로
안정성 확인.

## 구조 개선 16차 — handleAdminMembersRoster 재검토 이동 + 실제 프로덕션 버그 수정 (2026-09-17)

15차에서 다음 후보로 남겨둔 `handleAdminMembersRoster`("스터디원
목록" 상세 패널, 7차에서 "무겁다"고 제외했던 함수)를 재검토해
`src/members.js`로 옮겼다. 이동 전 코드 검토 중 **실제 프로덕션
버그를 발견**했다 — 이 함수가 쓰는 `loadNotifyPrefs`/
`getPushDeviceIndex`(notify.js)가 애초에 index.js에 **import조차
되어 있지 않았다**(10차에서 알림/푸시 도메인을 notify.js로 분리할
때 누락된 것으로 추정). 즉 관리자가 "스터디원 목록" 화면을 열
때마다(`GET /admin/members/roster`) `ReferenceError: loadNotifyPrefs
is not defined`로 500이 났을 것이다 — 이 경로를 다루는 테스트가
지금까지 하나도 없어 오랫동안 발견되지 않은 것으로 보인다. notify.js
에 두 함수의 `export`를 추가하고 members.js가 직접 import하도록
고쳐 해결했다.

**이동 대상은 함수 1개**지만, exit.js(`listActiveMembersWithExitInfo`)/
members.js(자기 자신, `listAllMembers`/`getDataSheetRows`)/index.js
(`getSpreadsheetMeta`/`getMemberSettingsStub`/`batchGetSheetValues`/
`NOTIFY_CATEGORIES`)/notify.js(`loadNotifyPrefs`/`getPushDeviceIndex`)/
member-utils.js(`parseGoogleEmail`/`parseGooroomeeAccount`) **다섯
도메인에 걸친 의존성**을 정리해야 했다. `listActiveMembersWithExitInfo`
는 index.js가 더 이상 직접 쓰지 않게 되어(유일한 소비자가
`handleAdminMembersRoster`였음) index.js의 exit.js import 목록에서
제거하고, members.js가 exit.js에서 직접 import하도록 정리했다
(index.js를 거치지 않는 직접 import — report.js/leave.js가 이미
쓰는 패턴과 동일). `getDataSheetRows`도 같은 이유로 index.js의
members.js import 목록에서 제거했다(members.js 자기 내부에 이미
정의돼 있어 재import 불필요).

**diff 검증**: `handleAdminMembersRoster`를 정규식 추출로
`git show HEAD`의 15차 종료 시점 원본과 비교해 완전 일치를 확인했다
(로직은 전혀 바꾸지 않고 위치만 옮겼으며, 버그 수정은 notify.js의
`export` 키워드 추가와 members.js의 import 목록 추가로만 이뤄져
`handleAdminMembersRoster` 자체 텍스트는 원본 그대로다).

**통합 테스트(`test/members-roster.test.js`, 2개)**: 관리자 아니면
403, 정상 조회 시 200과 `notifyPrefs`/`pushSubscribed`가 포함된
회원 상세를 반환하는지 검증했다 — 후자가 바로 이번에 고친
`ReferenceError` 버그의 회귀 방지 테스트다. mock 설계 중
`listActiveMembersWithExitInfo`가 내부적으로 쓰는
`getSharedMemberRows`(회원별 `{번호}!A1:U41`을 `values:batchGet`
하나로 묶어 조회)의 응답 배열을 처음에 `{values: [...]}`로 감싸지
않고 원본 rows 배열을 그대로 넣어 `batchGetSheetValues`가 빈
배열로 폴백해버리는 실수를 했다 — `members.length`가 0으로 나오는
증상으로 나타나 디버그 로그로 원인을 찾아 수정했다(15차의
"정적 대조만으로는 부족, `npm test`로 최종 확인" 원칙이 이번엔
mock 자체의 버그를 잡는 데도 유효했다).

index.js 2,189→2,071줄(약 118줄 감소, 시작(10,984줄) 대비 총
**81.2% 감소**). `npm test` 기준 434개 테스트 전부 통과(15차 종료
시점 432개 + 신규 2개), 연속 3회 실행으로 안정성 확인.

## 구조 개선 17차 — 전체 구조 감사 + 사후 정리 (2026-09-17)

16차까지 파일 분할 자체는 끝냈지만, 사용자 요청으로 "분할이
체계적으로 잘 되었는지" 전체를 재점검하는 감사(audit)를 진행했다
(Explore 서브에이전트에 위임). 감사 항목: (1) 순환 import 전수
조사, (2) index.js에 남은 것들의 타당성, (3) 파일명-내용 일치성,
(4) 테스트 커버리지 사각지대, (5) 1~16차가 스스로 남긴 "제외 근거"
들이 지금도 유효한지. 감사 결과를 바탕으로 우선순위가 높은 항목만
17차에서 바로 정리했다(리네임/문서 정비/라우팅 재배치 같은 낮은
우선순위 항목은 보류).

**감사에서 확인된 구조적 건전성**: 13개 도메인 파일이 index.js와
맺는 순환은 전부 의도된 "허브 패턴"(재export 또는 함수 선언 실사용
import)이라 TDZ 위험이 없다. `members.js ↔ notify.js`는 index.js를
거치지 않는 유일한 직접 순환(16차에서 `handleAdminMembersRoster`
이동 때 생김)이지만 두 심볼(`loadNotifyPrefs`/`getPushDeviceIndex`,
`listAllMembers`) 모두 함수 선언이라 안전하다. 파일명과 내용도
대부분 일치했다(`personal-status.js`가 랭킹/로스터까지 포함하는 건
"개인 대시보드"의 자연스러운 확장으로 판단, `member-utils.js`는
회원+푸시+알림 세 영역이 섞인 의도된 잡동사니 유틸 파일).

**🔧 이번에도 발견한 실제 프로덕션 버그**: `handleBotInvalidateCache`
(index.js)가 참조하는 `MEMBER_CACHE_GROUPS`(cache.js)가 export도
안 되고 import도 안 된 채로 방치돼 있었다 — 9차(`CYCLE_MAX_LEN`)와
16차(`loadNotifyPrefs`/`getPushDeviceIndex`)와 **정확히 같은
패턴**이다. `POST /bot/invalidate-cache`를 `groups` 파라미터와
함께 호출하면 `ReferenceError`로 500이 났을 것이다. cache.js에
export를 추가하고 index.js가 import하도록 고쳤다. 감사 보고서가
정확히 예측한 대로 — "index.js에 남기기로 한 소수 핸들러들은
6차 이후의 '테스트를 먼저 깐 뒤 이동' 원칙 적용 대상에서 애초에
빠졌기 때문에 사각지대가 생긴다"는 패턴이 이번에도 그대로
재현됐다.

**정리한 항목**:
1. `handleMigrateFixCollectMoneyFormula`와 그 라우트
   (`/admin/migrate/fix-collect-money-formula`)를 삭제했다 — 코드
   자신이 "실행 한 번으로 끝나는 작업이라 사용 후 제거할 것"이라고
   명시했고, 실제로 이미 실행 완료된 것을 사용자에게 확인 후 제거했다.
2. index.js가 재export하던 `GOAL_TYPE_MULTIPLIER`를 제거했다 —
   personal-status.js에서 import는 하지만(내부 `GOAL_TIME_VALID_VALUES`
   계산에 필요) 이 재export 자체를 가져다 쓰는 곳이 없는 죽은
   export였다.
3. `GOAL_TIME_VALID_VALUES = Object.keys(GOAL_TYPE_MULTIPLIER)`
   (index.js 최상위 즉시 평가)를 `getGoalTimeValidValues()` 함수로
   감쌌다 — 11차 TDZ 버그(`LEAVE_TYPE_CONFIG`)와 정확히 같은 모양의
   패턴인데, 지금은 import 순서상 우연히 안전할 뿐이라 감사 보고서가
   "재발 가능한 취약 지점"으로 지목했다. 지연 평가로 감싸면 향후
   import 순서가 바뀌어도 항상 안전하다.
4. `MEMBER_CACHE_GROUPS` export 누락(위 프로덕션 버그) 수정.
5. index.js에 로컬로만 남아있던 마지막 7개 핸들러
   (`handleMyRole`, `handleGetGoalSchedule`, `handleSetGoalSchedule`,
   `handleAdminFinesAdminForcedCount`, `handleBotInvalidateCache`,
   `handlePutParticipants`, `handleGetParticipants`)에 `export`를
   추가하고 `test/index-remaining-handlers.test.js`(14개)로 최소
   인증/검증 스모크 테스트를 깔았다 — `handlePutParticipants`/
   `handleGetParticipants`는 실제 `ParticipantsRoster` DO에 쓰고
   다시 읽어 값이 일치하는지까지 검증했다(mock 불필요). 이 14개
   테스트가 방금 고친 `MEMBER_CACHE_GROUPS` 버그의 회귀 방지선이자,
   앞으로 이 7개 핸들러에 같은 패턴의 import 누락이 생기면 즉시
   잡아낸다.

index.js 2,071→2,054줄(마이그레이션 핸들러 삭제로 소폭 감소, 시작
(10,984줄) 대비 총 **81.3% 감소**). `npm test` 기준 448개 테스트
전부 통과(16차 종료 시점 434개 + 신규 14개), 연속 3회 실행으로
안정성 확인.

**감사에서 나왔지만 17차 시점엔 보류했던 항목**(18차에서 전부
처리 — 아래 18차 섹션 참고): `handleAdminFinesAdminForcedCount`를
fines.js로 이동, `member-utils.js` 리네임, notify.js 낡은 주석
갱신, 라우팅 테이블 도메인별 주석 헤더, "현재 유효한 잔류 근거
요약" 표.

## 구조 개선 18차 — 17차 감사의 낮은 우선순위 항목 전체 정리 (2026-09-17)

17차 구조 감사가 지목했지만 그때는 보류했던 5개 항목을 전부
처리했다 — 전부 로직 변경이 없거나(리네임/주석/문서) 이미 검증된
패턴을 그대로 적용하는(함수 이동) 순수 정리 작업이라 리스크가
낮았다.

1. **`handleAdminFinesAdminForcedCount`를 fines.js로 이동** — exit.js
   8차 주석이 이미 "벌금 도메인"이라고 인지하고 있던 함수. 파생
   상수 `FINE_UNPAID_ADMIN_FORCED_REASON_LABEL`도 함께 옮기고,
   원본 `FINE_UNPAID_ADMIN_FORCED_REASON`(exit.js와 공유)은
   index.js에 남겨 export만 유지했다. 이동 직후 diff 대조로 로직
   완전 일치를 확인했고, 17차에서 이 함수용으로 작성했던 테스트
   2개를 `test/fines-handlers.test.js`로 함께 옮겼다.
2. **`member-utils.js` → `pure-utils.js` 리네임** — 회원 계정
   파싱(`parseGoogleEmail`/`parseGooroomeeAccount`)/웹푸시 암호화
   보조(`buildVapidJwk`/`concatBytes`)/알림 기본값
   (`defaultNotifyPrefs`/`guessDeviceLabel`) 세 영역이 섞인 의도된
   잡동사니 유틸 파일이라 "member"라는 이름이 실제 내용을 대표하지
   못한다는 지적을 반영했다. `git mv`로 이력을 보존하고, 참조하는
   8개 파일(exit.js/members.js/push-crypto.js/index.js/notify.js와
   테스트 3개)의 import 경로와 주석을 전부 갱신했다.
3. **notify.js 상단 주석 갱신** — 10차의 "순환 없는 leaf 도메인"
   서술이 16차(`handleAdminMembersRoster` 이동)로 무효화됐는데
   반영되지 않았던 문제. "10차 당시엔"이라는 시점 한정 표현으로
   바꾸고, 지금은 members.js와 직접 순환(loadNotifyPrefs/
   getPushDeviceIndex ↔ listAllMembers)이 있다는 사실을 명시했다.
   `docs/TESTING.md`의 10차 섹션에도 같은 취지의 갱신 노트를
   인용구로 덧붙였다(본문은 역사적 기록으로 그대로 보존).
4. **라우팅 테이블에 도메인별 주석 헤더 추가** — 85개 라우트의
   순서 자체(`url.pathname` 문자열, 호출하는 핸들러, if 체인 순서)
   는 전혀 건드리지 않고 `// --- 도메인명 (파일명) ---` 헤더만
   삽입했다. 도메인이 섞여 있는 구간(예: 봇 라우트 사이에 낀
   `/report-status`, 회원 관리 라우트 사이에 낀 퇴실 신청 3개)은
   인라인 주석으로 표시했다. diff에서 `url.pathname` 관련 줄의
   추가/삭제가 0건임을 스크립트로 확인해 순수 주석 삽입만
   이뤄졌음을 검증했다.
5. **`docs/TESTING.md`에 "현재 유효한 잔류 근거 요약" 표 추가** —
   "파일 구조" 섹션 바로 다음에 최종 파일 목록(줄 수·도메인),
   index.js가 여러 도메인과 공유하는 대표 심볼 표, 남은 소수
   핸들러 목록, 유일한 비-허브 순환(members.js↔notify.js)을
   한눈에 볼 수 있는 스냅샷을 추가했다. 각 차수 섹션 본문은
   역사적 기록으로 그대로 두고, 이 표만 항상 최신 상태를
   반영하도록 앞으로 리팩터링이 있을 때마다 갱신한다.

index.js 줄 수는 이번 차수에서 변하지 않았다(2,054줄 그대로 —
handleAdminFinesAdminForcedCount 이동으로 줄어든 만큼 주석 추가로
다시 늘어 상쇄됨). 시작(10,984줄) 대비 총 **81.3% 감소** 유지.
`npm test` 기준 448개 테스트 전부 통과(17차와 동일 — 이동한 2개
테스트를 제외한 순수 이전이라 개수 변화 없음), 연속 실행으로
안정성 확인.

## 구조 개선 19차 — 개인 대시보드/랭킹 클러스터에서 roster-status.js 분리 (2026-09-17)

18차에서 "구조적으로 더 손댈 곳은 없다"고 판단했으나, 사용자 요청으로
"이미 분리된 대형 파일 내부"를 다시 조사한 결과 `personal-status.js`
(15차 신설, 1,313줄)가 실제로는 두 개의 서로 무호출인 클러스터를
품고 있음을 발견했다 — 개인 대시보드(`handleStatus`,
`handleAdminMemberStatus`, `buildPersonalStatus`)와 랭킹/로스터/
정산(`buildRosterStatus`, `handleRosterStatus`,
`handleAdminPrizeSettle`)이 서로를 전혀 호출하지 않는다는 사실을
함수 그룹별 텍스트 추출 + 정규식 상호 참조 카운트 스크립트로 실측
확인했다. 크기가 아니라 "내부 무호출 구조"가 분리 근거라는 원칙을
이번에 처음 명시적으로 세웠다(20차·21차에도 동일하게 적용).

**발췌 이동 시 경계 오판 발견**: 최초 조사(서브에이전트) 보고서는
로스터 클러스터를 "1004-1313행" 단일 블록으로 보고했으나, 실제로는
`handleAdminMemberStatus`(1197-1228행, 개인 대시보드 도메인)가
로스터 클러스터 중간에 끼어 있었다. 직접 코드를 재확인해 발견하고
정밀 발췌로 처리했다.

`src/roster-status.js`(310줄) 신설: `ROSTER_ROW_START`,
`ROSTER_ROW_END`, `buildRosterStatus`(export), `_computeRosterStatus`,
`handleRosterStatus`(export), `handleAdminPrizeSettle`(export).
`personal-status.js`는 1,313→1,043줄로 축소, `handleAdminMemberStatus`
는 그대로 유지(개인 대시보드 도메인으로 확인됐으므로).

**실사용 import 버그**: `roster-status.js`가 `handleRosterStatus`
내부에서 `personal-status.js`의 `currentWeekRangeYYMMDD`를 쓰는데
처음엔 export를 빠뜨려 테스트 실행 시 "전체 대시보드 조회 실패:
currentWeekRangeYYMMDD is not defined" 에러로 즉시 발견, export
추가 및 import 목록에 추가해 해결. `parseWeekOfToMonday`도 함께
export 추가. `buildRosterStatus`는 `personal-status.js`에 남은
`getMeritRank`가 실사용하므로 export 추가 후 `roster-status.js`가
이를 다시 import하는 9~11차와 동일한 실사용 import 패턴 적용.

미사용이 된 import 3개(`resolveMemberNumber`,
`getSheetUnformattedValue`, `batchGetSheetValues`)를
`personal-status.js`에서 제거.

테스트: `test/personal-status.test.js`에서 `handleRosterStatus`/
`handleAdminPrizeSettle` 관련 describe 블록 2개(4개 테스트)를
`test/roster-status.test.js`(신설)로 이전, `stubRosterStatusFetch`
헬퍼로 mock 구성.

diff 검증으로 이동한 모든 함수가 원본과 완전 일치함을 확인.
`npm test` 기준 448개 테스트 전부 통과.

## 구조 개선 20차 — report.js를 report-intake/review/penalty 3파일로 분할 (2026-09-17)

12차에서 신설한 `report.js`(1,871줄)도 19차와 동일한 방식으로
재조사한 결과 세 개의 서로 무호출인 클러스터로 나뉨을 확인했다:
접수/쿨다운, 캡처 검토/목록/투표, 벌점/제보상점 반영. 함수 그룹별
텍스트 추출 + 상호 참조 카운트 스크립트로 실측 검증.

- `src/report-intake.js`(389줄) — 접수/쿨다운:
  `getReportQueueStub`, `checkReportCooldown`, `recordReportCooldown`,
  `markReportCaptureDone`, `listReportCooldowns`, `handleReport`,
  `handleListActiveCooldowns`, `handleReportCaptureDone`,
  `handleListReports`, `handleRequeueReport` 등.
- `src/report-review.js`(663줄) — 캡처 검토/목록/투표:
  `getReportVoteStub`, `requireAdminOrCoReviewer`,
  `attachNextOccurrence`, `attachDeferralInfo`, `filterItemsByCycle`,
  `applyAutoRecognitionForExpired`, `handleAdminCapturesList`,
  `handleMyCaptures`, `handleMyCaptureDelete`, `handleMyOutputPen`,
  `handleCaptureTargetRespond`, `handleAdminCaptureVote`,
  `handleAdminCaptureFile` 등.
- `src/report-penalty.js`(845줄) — 벌점/제보상점 반영:
  `applyTimeDeduction`, `applyOutputPenalty`, `applyReportMerit`,
  `cancelTimeDeduction`, `cancelOutputPenalty`, `cancelReportMerit`,
  `handleAdminCaptureCancel`, `handleAdminCaptureCancelMerit`,
  `handleAdminCaptureDecide`, `handleAdminCaptureDelete`,
  `handleAdminCaptureRevert`, `handleReportStatus` 등.

**발췌 경계 재확인**: `requireAdminOrCoReviewer`는 초기 가정("접수
그룹")과 달리 실제로는 "검토 그룹"에서만 쓰임을 직접 코드 확인으로
발견, review 파일로 배치했다.

**실사용 import 패턴**: `applyAutoRecognitionForExpired`는
`index.js`의 `scheduled`(cron 핸들러)가 실사용하므로 재export가
아니라 `index.js`가 `report-review.js`에서 다시 import하는 방식을
적용(9~11차와 동일 패턴).

`report.js`는 `git rm`으로 완전히 삭제. `index.js`의 import 블록을
3개로 재편하고, 라우팅 테이블 주석 헤더를
`// --- Report/Capture 접수·쿨다운 (report-intake.js) ---` /
`// --- Report/Capture 캡처 검토/투표 (report-review.js) ---` /
`// --- Report/Capture 벌점/상점 반영 (report-penalty.js) ---`로
갱신(19차의 roster-status.js 관련 주석도 함께 정정). 순수
if-chain이라 순서 무관하므로 `handleAdminCaptureVote`를 검토
그룹 끝으로 재배치해 도메인 그룹핑 정확도를 높였다.

테스트: `test/report-submit.test.js`(→report-intake.js),
`test/report-decide.test.js`(→report-penalty.js),
`test/report-captures-list.test.js`(→7개는 report-review.js,
`handleReportStatus` 1개만 report-penalty.js)로 import 경로 갱신.

diff 검증 스크립트로 이동한 45개 함수(처음 파악한 44개 +
`weekOfToMondayEpochKST` 신규 발견) + 13개 상수 전부 원본과 완전
일치 확인. 라우팅 cross-check 스크립트로 모든 라우트가 정상
resolve됨을 확인. `npm test` 기준 448개 테스트 전부 통과, 연속
2회 재실행으로 안정성 재확인(직전 1회 workerd 풀 teardown 경합으로
추정되는 flaky 실패가 있었으나 — 15차·20차에서 반복 확인된 코스메틱
노이즈 패턴과 일치 — 즉시 재실행 시 448/448 통과, 총 6/7회(85%)
성공률로 코드 결함이 아님을 확인).

## 구조 개선 21차 — exit.js를 exit-request/candidates/confirm 3파일로 분할 (2026-09-17)

19차·20차와 동일한 기준(내부 무호출 구조)으로 `exit.js`(8차 신설,
1,160줄)를 재조사한 결과 세 개의 서로 무호출인 클러스터로 나뉨을
확인했다: 신청/동의/취소, 후보 판정/공유 조회, 미리보기/확정 실행.
함수 그룹별 텍스트 추출 + 상호 참조 카운트 스크립트로 실측 검증.

- `src/exit-request.js`(154줄) — 신청/동의/취소/도움봇 조회:
  `handleSetExitRequest`, `handleAgreeExitRequest`,
  `handleCancelExitRequest`, `listExitRequests`,
  `handleBotExitRequests`.
- `src/exit-candidates.js`(252줄) — 후보 판정/공유 조회:
  `getAllExitRelevantStatus`, `listExitCandidates`,
  `handleAdminExitedMembers`, `listActiveMembersWithExitInfo`,
  `handleAdminExitCandidates`, `handleAdminExitBlacklist`,
  `handleAdminBlacklist`, `getPenaltySlotNotesGrid`.
- `src/exit-confirm.js`(743줄) — 미리보기/확정 실행:
  `computeExitResult`, `handleAdminExitPreview`,
  `appendDataAuditSnapshot`, `rewriteBackupAuditFormulas`,
  `performExitReset`, `performDepositAgainReset`,
  `handleAdminExitConfirm`, `writeExitResultBox`,
  `revokeSheetAccess`, `getSheetFormulas`, `EXIT_KIND_VALUES`.

**사전 조사 보고서의 경계 오판 발견**: 19차·20차에서 두 차례 경계
오판이 있었던 전례에 따라, 착수 전 이전 조사(서브에이전트) 보고서가
`handleAdminExitBlacklist`/`handleAdminBlacklist`를 "확정 실행" 그룹
(exit-confirm.js)으로 분류했던 가정을 직접 코드와 테스트 파일
(`test/exit-fetch.test.js`가 이 둘을 `handleAdminExitedMembers`/
`handleAdminExitCandidates`와 함께 테스트하고 있었음)로 재확인한
결과, 실제로는 확정 실행 그룹의 어떤 함수도 호출하지 않는
`MemberSettingsDO` 순수 읽기/쓰기 핸들러라 "후보 판정/공유 조회"
그룹(exit-candidates.js) 소속임을 발견, 처음 계획을 수정해 처리했다.

**실사용 import 패턴**: `getAllExitRelevantStatus`/
`listActiveMembersWithExitInfo`(candidates)가 `listExitRequests`
(request)를 호출하므로, `listExitRequests`에 export를 추가하고
`exit-candidates.js`가 이를 다시 import하는 9~11차와 동일한 실사용
import 패턴을 적용했다. `exit-confirm.js`의 4개 헬퍼(`writeExitResultBox`/
`revokeSheetAccess`/`getSheetFormulas`)와 `exit-candidates.js`의
`getPenaltySlotNotesGrid`는 외부에서 전혀 참조되지 않는 각 그룹 전용
내부 헬퍼임을 grep으로 확인, export 없이 그대로 이동했다.

`exit.js`는 git이 자동으로 `exit-confirm.js`로의 리네임으로 인식할
만큼 내용이 겹쳤다(실제로는 `git rm` 후 세 파일 신설). `cycle.js`/
`members.js`가 이미 이 파일의 함수를 실사용 import하고 있어 import
경로만 `./exit-candidates.js`로 갱신했다. `index.js`의 import 블록을
3개로 재편하고, 라우팅 테이블 주석 헤더를
`// --- 퇴실/재납 신청 (exit-request.js) ---` /
`// --- 퇴실/재납 후보 판정 (exit-candidates.js) ---` /
`// --- 퇴실/재납 확정 실행 (exit-confirm.js) ---`로 갱신, 기존에
한 헤더 아래 뭉쳐 있던 후보 판정/확정 실행 라우트를 실제 소속에 맞게
분리했다.

테스트: `test/exit-requests.test.js`(→exit-request.js),
`test/exit-fetch.test.js`(→exit-candidates.js),
`test/exit-confirm.test.js`(→exit-confirm.js)로 import 경로 갱신 —
세 테스트 파일의 기존 경계가 실제 함수 그룹 경계와 정확히 일치했다.

diff 검증 스크립트로 이동한 23개 함수 + `EXIT_KIND_VALUES` 상수
전부 원본과 완전 일치 확인. 라우팅 cross-check 스크립트로 모든
라우트가 정상 resolve됨을 확인(url.pathname 관련 줄의 추가/삭제
0건도 함께 확인). `npm test` 기준 448개 테스트 전부 통과, 연속
2회 재실행으로 안정성 재확인.

## 구조 개선 22차 — 21차 이후 신규 기능 7건 (2026-09-18, 🔧 [2026-09-19] 문서 누락분 추가)

> 21차(2026-09-17)까지의 서술이 스스로를 "지금 코드베이스의 진실"이라
> 표방했지만, 실제로는 그 다음날(2026-09-18)에 순수 구조 리팩터링이
> 아니라 **실질적 기능 개발** 커밋 7개(`b01b364`, `9a34cdc`, `68af8c0`,
> `0df9b68`, `6f8b86b`, `7fa833e`, `e7de323`, `bfaf5d5`)가 있었고, 이번
> 세션의 문서 전수 대조에서야 뒤늦게 발견됐다. 앞선 1~21차와 성격이
> 다르다 — 파일을 옮긴 게 아니라 새 함수/새 라우트를 추가한 것이라
> "차수"라는 이름이 어색할 수 있지만, 위 파일 구조 표의 줄 수 증가분이
> 전부 이 작업 때문이라 같은 번호 체계로 기록한다.

**1) 관리자 전용 "사이클 범위 선택"** (`cycle.js`, +112줄) —
`groupBackupsIntoCycles`/`listAllCycleGroups`/`handleAdminCycleGroups`
(신규 라우트 `GET /admin/cycles`)/`resolveTargetFileIdForAnyBackup` 4개
함수 신설. 관리자가 `?cycleAny=`로 현재 사이클(최대 3주) 제약 없이 전체
이력을 조회할 수 있게 한다 — `handleStatus`(personal-status.js)/
`handleRosterStatus`(roster-status.js)에 새 분기 추가. 테스트:
`test/cycle-groups.test.js`(211줄, 신설).

**2) 퇴실 신청 48시간 자동 동의 크론** (`exit-request.js`, +126줄) —
`autoAgreeExpiredExitRequests`/`agreeExitRequestForMember` 2개 함수
신설. 마지막 참여일 익일로부터 48시간이 지나도 회원이 "동의합니다"를
누르지 않으면 5분 주기 cron(`scheduled`)이 자동으로 동의 처리한다.
테스트: `test/exit-requests.test.js`에 `autoAgreeExpiredExitRequests`
describe 블록 추가(신규 함수라 기존 테스트 파일에 편입).

**3) 정산 퇴실 절차 재정의** (`exit-timing.js`, `DepositRefundDialog.tsx`) —
`exitDateSettled()`/`exitDatePassedDay()`의 판정 기준이 "exitDate 다음날
오전 2시 KST"라는 모호한 기준에서 **"익일(자정) 이후"로 단순화**됐다.
벌금 미납/상금 미정산 판정은 `canAgree`라는 별도 축으로 분리되어, 동의
버튼을 숨기지 않고 비활성화만 하도록 바뀌었다. `StatusResponse.prizePending`
필드도 이때 추가됐다. 상세는 `docs/WEB_SETTINGS.md` §3.2(2026-09-19
전면 재작성)에 반영.

**4) `exit-confirm.js` 퇴실 확정 신규 캡처 필드** (+58줄, 이번 세션 계획
기준 구현 완료) — `handleAdminExitConfirm`이 확정 처리 시 `exitRequestEntry`
조회(모든 kind로 확장)와 `do/last-login/list` 조회 결과를 DO 저장
`entry`에 `exitRequestDate`/`lastLoginAt`/`lastLoginIp` 3개 필드로 추가
기록한다 — 회원번호 슬롯이 나중에 재사용돼도 퇴실 시점의 이 값들이
영구 보존된다. 프론트(`ExitedMemberRosterView.tsx`, `types.ts`)도 이
필드를 "상태 정보" 카드에 표시하도록 반영 완료. 테스트:
`test/exit-confirm.test.js`(필드 null 검증 + `exitRequestDate`/
`lastLoginAt`/`lastLoginIp` 실값 검증 케이스 추가).

이 7개 커밋으로 최종 테스트 스위트는 **36개 파일, 479개 테스트**로
늘었다(21차 시점의 "448개"에서 +31, `npm test` 재실행으로 확인) — 21차
이하 섹션에 반복 등장하는 "448개 테스트 전부 통과"라는 숫자는 이제
22차 이전 시점의 스냅샷으로 읽을 것.

## 다음 단계

사이클 판정, 예치금/강제퇴실/정산 판정, 회원 관리/알림·푸시의
순수 함수, 웹푸시 암호화, 벌금/납부 처리, 회원 관리(CRUD/번호
재배치), 퇴실 처리, 사이클 판정 정리, 알림/푸시 도메인, 사유반휴/
일반반휴 도메인, 제보/캡처 도메인, 봇 상태/사용량 도메인, 로그인/
OAuth 도메인, 개인 대시보드/랭킹 클러스터, `handleAdminMembersRoster`
까지 총 16차에 걸쳐 분리하고, 17차에서 전체 구조 감사와 사후 정리를,
18차에서 그 감사의 낮은 우선순위 항목까지 전부 마무리했다.

18차 시점엔 "구조적으로 더 손댈 곳은 없다"고 판단했으나, 사용자
요청으로 "이미 분리된 대형 파일 내부"까지 재조사한 결과 19~21차에서
추가로 세 건의 유효한 분할(personal-status.js→roster-status.js,
report.js→report-intake/review/penalty, exit.js→exit-request/
candidates/confirm)을 발견해 전부 처리했다. 세 차수 모두 코드 작업·
테스트·diff 검증·배포·문서화·커밋까지 완료된 상태다. 🔧 [2026-09-19
추가] 다만 이 "완료" 판단은 순수 구조 리팩터링 관점의 것이고, 그
다음날(2026-09-18) 같은 파일들(`cycle.js`/`exit-request.js`/
`exit-confirm.js`) 위에 실질적 기능 개발이 더 있었다 — 위 22차 참고.

이번 리팩터링 전체(1~21차)에서 반복적으로 확인된 원칙들을 다시
정리한다: 테스트 없이 구조 변경부터 시작하지 않는다(전 차수),
이동 직후 원본과 diff 대조하는 절차(8차부터), DO 키 기준 테스트
격리(10차부터), 최상위 `const` 객체 리터럴의 TDZ 위험 점검(11차
부터), 이동 후 라우팅 테이블 전체를 grep해 실수로 삭제된 함수가
없는지 교차 검증(13차부터), 이동한 코드가 실제로 호출하는 모든
함수가 import됐는지 `npm test`로 최종 확인(15차부터), 새 파일은
작성 직후 `git add`로 즉시 스테이징(15차부터), 파일 크기가 아니라
"내부 무호출 구조"가 분리 가능성의 유일한 신뢰할 수 있는 기준
(19차부터, 함수 그룹별 텍스트 추출 + 상호 참조 카운트 스크립트로
실측). **가장 중요한 교훈**(9차·16차·17차·19차·20차 다섯 번에
걸쳐 반복 확인): "이동 대상인가 잔류 대상인가"와 무관하게, 어떤
함수든 그 경로를 실제로 실행하는 테스트가 없으면 import 누락 같은
사소한 실수가 무기한 방치될 수 있다 — "이 함수를 옮길지 말지"보다
"이 함수를 실행하는 테스트가 있는지"를 먼저 확인하는 습관이 구조
개선 자체보다 더 근본적인 예방책이다. 또한 서브에이전트의 초기
조사(발췌 경계, 그룹 소속)는 사람이 직접 코드를 재확인하기 전까지
신뢰하지 않는다(19차·20차·21차 세 번 모두 실제로 경계 오판을
발견 — 마지막 21차는 handleAdminExitBlacklist/handleAdminBlacklist가
보고서상 "확정 실행" 그룹으로 분류됐으나 실제로는 "후보 판정" 그룹
소속이었음). 향후 이 코드베이스에 새 도메인이나 기능이 추가될 때도
이 원칙들을 계속 적용한다.
