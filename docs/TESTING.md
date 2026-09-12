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

이번 조사로 `currentCycleBackups`(`index.js:8491`)와
`compareWeekOfDesc`(`index.js:8449`)가 완전한 순수 함수임을 새로
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

## 다음 단계

사이클 판정, 예치금/강제퇴실/정산 판정, 회원 관리/알림·푸시의
순수 함수, 웹푸시 암호화, 벌금/납부 처리, 회원 관리(CRUD/번호
재배치), 퇴실 처리, 사이클 판정 정리, 알림/푸시 도메인, 사유반휴/
일반반휴 도메인까지 총 11차에 걸쳐 분리했다. `resolveMemberNumber`
/`findMemberNumberByEmail`(15곳 이상 공유 인증 유틸)은 계속 제외
대상으로 남아있다. 남은 최대 후보는 제보/캡처 도메인(약 2,274줄) —
`applyOutputPenalty`/`handleAdminCaptureDecide` 같은 복잡한 분기
함수가 많아 지금까지 중 가장 큰 사고 위험을 안고 있다. `buildPersonalStatus`
/`buildRosterStatus`(여러 도메인이 공유하는 대형 집계 함수)는 계속
index.js 잔류 + export 확대가 안전해 보이며, 별도 도메인으로 뺄지는
이후 재검토한다. 테스트 없이 구조 변경부터 시작하지 않는다는 원칙,
이동 직후 원본과 diff 대조하는 절차(8차부터), DO 키 기준 테스트
격리(10차부터) 모두 유지한다. **11차에서 새로 얻은 교훈** — 새 파일이
index.js를 import하면서 동시에 index.js가 그 파일을 import하는
순환에서, 함수 선언(호이스팅되어 안전)과 달리 **모듈 최상위의 `const`
객체 리터럴이 다른 모듈의 값을 즉시 참조하면 TDZ로 깨질 수 있다** —
다음 차수에서 새 도메인 파일을 만들 때 최상위 상수가 index.js의
값을 참조한다면 함수로 감싸 지연 평가하거나, 참조하는 값 자체를
새 파일에 하드코딩(원본과 동일한 값이면 로직 변경 아님)하는 것을
우선 검토한다.
