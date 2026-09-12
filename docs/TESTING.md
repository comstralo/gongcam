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

## 다음 단계

fetch 의존(`listBackupFiles`/`listCurrentCycleBackups`/
`resolveTargetFileId`)과 DO+fetch+시계 의존
(`resolveExitSourceFileId`/`resolveCaptureSourceFileId`) 함수는
`getCurrentPenCycle`/`findBackupForExitDate`(sheets API 의존, 아직
index.js에 남아있는 헬퍼)를 호출한다 — 이들을 옮기려면 sheets 저수준
래퍼(`getSheetValues`, `getServiceAccountAccessToken` 등) 분리가
먼저 필요하거나, 단계 4와 같은 방식으로 순환 import를 감수해야 한다.
이후 벌점/벌금/예치금/상금 처리, 회원 관리, 알림/푸시 도메인은 아직
테스트가 없으므로, "테스트 커버리지가 넓어지는 순서대로 파일을
분리한다"는 원칙에 따라 해당 도메인 테스트를 먼저 작성한 뒤 같은
패턴(함수 단위 발췌 + 재export)으로 이어간다. 테스트 없이 구조
변경부터 시작하지 않는다.
