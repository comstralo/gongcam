# 캐싱 정책 지도 (CACHING_POLICY.md)

> 이 문서는 Cloudflare Worker 백엔드(`frame-checker-worker/src/index.js`)가
> Google Sheets를 DB로 쓰면서 걸어둔 2단 캐시(인메모리 `_sheetCache` + KV
> `env.REPORTS_KV`)의 전체 구조와, "시트/KV 쓰기 지점 ↔ 캐시 무효화 ↔ TTL"이
> 실제로 정합하게 맞물려 있는지를 코드 전수조사로 확인한 결과입니다.
> `docs/WEB_ADMIN.md`, `docs/WEB_DASHBOARD.md`와 같은 목적·형식으로 작성했으며,
> 코드가 바뀌면(특히 `writeSheetValues` 호출 지점이나 `_cachedCompute` TTL을
> 건드리면) 이 문서도 함께 갱신해야 합니다.
>
> 최초 조사 시점: 2026-09-09. 이후 2026-09-11까지 지속 갱신(§14~§25).
> Cloudflare KV 무료 티어 쓰기/삭제 하루 1,000회 한도를 예민하게 관리해야
> 한다는 문제의식에서 시작해, "쓰기 시점 무효화가 실제로 필요한 곳을
> 놓치고 있지는 않은지"(정합성 위험)와 "거의 안 바뀌는데 TTL이 짧아 KV를
> 불필요하게 자주 두드리고 있지는 않은지"(예산 낭비) 두 방향을
> 전수조사했습니다. `_cachedCompute` 캐시 키는 현재 12종이며 전체 목록은
> §3, 무효화 그룹은 §1·§10 참고.

## 1. 아키텍처 개요

캐시는 두 계층으로 나뉩니다.

- **인메모리 캐시** (`_sheetCache`, `Map`): 하나의 isolate(요청을 처리하는
  Worker 실행 인스턴스) 안에서만 공유됩니다. 세대 카운터
  (`_memberCacheGeneration`, `_cacheGeneration`)로 계산 도중 무효화가 끼어드는
  경쟁 조건을 막습니다 — 계산 시작 시점의 세대를 기억해뒀다가, 끝난 뒤 세대가
  그대로일 때만 캐시에 씁니다.
- **KV 캐시** (`env.REPORTS_KV`, 키 prefix `sheetCache:`): isolate 경계를
  넘어 공유됩니다. TTL(`expiresAt` 필드로 자체 관리, `_cacheGetAsync`가 만료를
  확인) 또는 명시적 `.delete()`로만 사라집니다.

핵심 헬퍼: `_cacheGet`/`_cacheGetAsync`/`_cacheSet`/`_cacheSetAsync`/
`_cachedCompute`(index.js:445-560 부근). `_cachedCompute(env, key, ttlMs,
computeFn)` 형태로 각 파생 계산(주로 여러 셀을 모아 가공한 값)을 감쌉니다.

무효화는 두 가지 방식이 함께 쓰입니다.

1. **`writeSheetValues`의 내장 정밀 무효화** (index.js:400-430): 쓰는
   range의 시트명이 숫자(회원 개인 탭, 예: `"7!C10"`)이면 그 회원 한 명의
   `personalStatusBundle:{fileId}:{memberNumber}` 캐시만 인메모리+KV 양쪽에서
   즉시 지웁니다(`invalidatePersonalStatusCache`). 개인 탭에만 쓰는 대부분의
   경로는 이것만으로 충분합니다.
2. **`invalidateMemberCache(env, groups, fileId)`**: 회원 명단·순위·집계
   등 "여러 회원을 아우르는 파생 캐시"를 한 번에 무효화합니다.
   `MEMBER_CACHE_PREFIXES`(인메모리 세대 카운터가 관장하는 prefix 목록)는
   현재 다음과 같습니다.
   ```js
   const MEMBER_CACHE_PREFIXES = [
     "members:", "meta:", "exitStatus:", "memberRows:", "penSlotGrid:",
     "weeklyPaidFine:", "rosterStatus:", "adminMemberList:", "dataSheetRows:",
     "coReviewers:",
   ];
   ```
   > **이력**: `meritRank:`는 폐지(§16 — `getMeritRank`가 `rosterStatus:` 재사용).
   > `reportScore:`/`outputPenSlots:`도 폐지(§21 — 셋이 `personalStatusBundle:`
   > 하나로 통합). 그 대신 `rosterStatus:`(§16), `adminMemberList:`(§17.1),
   > `dataSheetRows:`(§20), `coReviewers:`(§22)가 추가됐다.

   인메모리는 세대 카운터를 올리는 것만으로 위 prefix 전체가 즉시
   무효화되어 공짜입니다. **KV 쪽은 그중 "파일 전체가 키 하나"인 종류만
   `MEMBER_CACHE_UNCONDITIONAL_KEYS`(= `members`/`meta`/`exitStatus`/
   `memberRows`/`penSlotGrid`/`weeklyPaidFine`/`penCycle`/`rosterStatus`/
   `adminMemberList`/`dataSheetRows`/`coReviewers`)에서 `activeKeys`
   (호출부가 넘긴 그룹)에 포함되는 것만 `.delete()`합니다.** 회원별로 키가
   갈라지는 `personalStatusBundle:{fileId}:{number}`는 이 방식으로는
   못 지웁니다 — 회원 번호를 아는 호출부가 `invalidateMemberSlotCache(env,
   번호)`(§21에서 이 함수로 통일)나 `invalidatePersonalStatusCache(env,
   fileId, 번호)`(`writeSheetValues` 내장 무효화)를 명시적으로 호출해
   그 회원의 번들 캐시를 콕 집어 지웁니다.
   >
   > 🔧 **[2026-09-09~09-10 이력] 회원별 캐시의 즉시 삭제**
   > — 원래 `outputPenSlots:`/`reportScore:`는 KV를 자연 TTL 만료
   > (5분/30분)로만 두도록 설계돼 있었으나, 제보 처리 경로
   > (`handleAdminCaptureCancel`/`CancelMerit`/`Decide`/`Delete`/`Revert`)가
   > 애초에 대상자·제보자 번호를 정확히 알고 호출된다는 점을 이용해 그
   > 6곳에서 `invalidateMemberSlotCache`를 추가로 호출하도록 넓혔다. §21에서
   > 이 두 캐시가 `personalStatusBundle:` 하나로 합쳐지며, `invalidateMemberSlotCache`도
   > 이제 그 번들 캐시 키 하나만 지운다(대상 회원 1명당 KV delete 2→1).

## 2. 시트 쓰기 지점 ↔ 무효화 매칭표

`writeSheetValues(` 호출 24곳 전수조사 결과입니다. "개인 탭만" 쓰는 지점은
위 1번 내장 무효화로 이미 안전하므로 `invalidateMemberCache`가 옆에 없어도
문제가 없습니다.

| 줄 | 함수 | 쓰는 범위 | 도메인 | 무효화 |
|---|---|---|---|---|
| 3874 | `applyTimeDeduction` | 개인 탭 27행 | 응답지연 시간 차감 | 개인 탭 내장 무효화 |
| 3928 | `applyOutputPenalty` | 송출 P F~K열 | 벌점 슬롯 | `invalidateMemberCache`(4100/4273) |
| 4016 | `applyReportMerit` | 송출 P R~V열 | 제보상점 슬롯 | `invalidateMemberCache`(4122/4273) |
| 4048 | `cancelTimeDeduction` | 개인 탭 27행 | 시간차감 취소 | 개인 탭 내장 무효화 |
| 4058 | `cancelOutputPenalty` | 송출 P F~K열 | 벌점 슬롯 취소 | `invalidateMemberCache`(4100) |
| 4079 | `cancelReportMerit` | 송출 P R~V열 | 제보상점 슬롯 취소 | `invalidateMemberCache`(4122/4432/4480) |
| 4704 | `handleSetLeaveApply` | 개인 탭 19/20행 | 반휴 사용 여부 | 개인 탭 내장 무효화 |
| 5168 | `handleAdminLeaveProofDecide` | 개인 탭 20행 | 사유반휴 승인 반영 | 개인 탭 내장 무효화 |
| 5278 | `handleSetGoalSchedule` | 집계!L{row} | 목표시간 예약 | 없음 — `buildRosterStatus`가 무캐시 직접조회라 안전 |
| 5692 | `handleAdminFineStatus` | 개인 탭 31행 | 벌금 납부 상태 | `invalidateMemberCache`(5695) |
| 5713 | `handleAdminPrizeSettle` | 집계!P6 | 상금 정산 집행 | 없음 — 무캐시 직접조회라 안전 |
| 6297 | `handleAdminSetPartiStatus` | 개인 탭 L3 | 참여상태 | `invalidateMemberCache`(6298) |
| 6534/6565/6568 | 감사·백업 관련 | 감사 시트/백업 탭 | 아카이브 | 없음 — 캐시된 파생값 없음 |
| 6640/6658 | `performExitReset` | 개인 탭 C42/B2, 데이터!D~V | 퇴실 초기화 | `invalidateMemberCache`(6664) |
| 6716 | `performDepositAgainReset` | 개인 탭+데이터!F~V | 재납 초기화 | `invalidateMemberCache`(6729) |
| 6796 | `handleAdminExitConfirm` | 개인 탭 L3, 집계!D23/D24 | 퇴실/재납 확정 | `invalidateMemberCache`(6845) |
| 7098/7104/7112 | `moveMemberSlot` | 개인 탭+데이터 | 회원번호 재배정 | `invalidateMemberCache`(7117) |
| 7229 | `handleAdminCreateMember` | 개인 탭+데이터 | 신규 회원 등록 | `invalidateMemberCache`(7241) |
| 7839 | 수식 일회성 마이그레이션 | 집계!D20 | — | 없음 — 무캐시 직접조회라 안전, 일회성 유틸 |

**결론**: 여러 회원을 아우르는 파생 캐시를 건드리는 쓰기는 전부
`invalidateMemberCache`와 정확히 짝이 맞습니다. `MEMBER_CACHE_PREFIXES`에
포함되지 않은 두 지점(`handleSetGoalSchedule`, `handleAdminPrizeSettle`)도
그 값을 읽는 `buildRosterStatus`가 애초에 캐시를 쓰지 않기 때문에 안전합니다
— 다만 향후 `buildRosterStatus`에 캐시를 도입하면 이 두 지점이 즉시
위험군으로 바뀐다는 점은 암묵적 결합이라 유의가 필요합니다.

퇴실 신청 관련 KV(`EXIT_REQUEST_KV_PREFIX`, 시트가 아니라 KV 자체에 상태
저장)도 `getAllExitRelevantStatus`(`exitStatus:` 캐시)의 계산 입력이지만,
`handleSetExitRequest`/`handleAgreeExitRequest`/`handleCancelExitRequest`
세 지점 모두 `invalidateMemberCache`를 페어로 호출해 정확히 무효화됩니다.

## 3. 읽기 경로 TTL 인벤토리

`_cachedCompute` 12곳 전수조사입니다(2026-09-10 갱신).

| 캐시 키 prefix | 함수 | TTL | 무효화 경로 |
|---|---|---|---|
| `penCycle:` | `getCurrentPenCycle` | **2시간**(§14.1 — 앱스크립트 `sheet_reset()`이 즉시 `cycle` 그룹 무효화, TTL은 안전망) | `invalidateMemberCache(["cycle"])` — 앱스크립트 알림 경로만 |
| `meta:` | `getSpreadsheetMeta` | **10분**(2026-09-11 상향, 구 5분) | `invalidateMemberCache`(`roster` 그룹) |
| `dataSheetRows:` | `getDataSheetRows`(§20, 2026-09-10 신설) | **2시간**(2026-09-11 상향, 구 10분 — §26, `members:`와 짝 맞춤) | `invalidateMemberCache`(`roster`/`memberIdentity`/`newMember` 그룹) — `데이터!A1:V50` 원본 로우, `listAllMembers`가 내부에서 재사용 |
| `members:` | `listAllMembers` | **2시간**(현재/과거 fileId 공통 — §17.2, 2026-09-11 재상향, 구 10분) | `invalidateMemberCache`(`roster` 그룹 — 신규등록/퇴실/재납/번호이동 5곳) + 제보 승인/상점 지급 직전 `memberIdentity` 그룹(좁게, §17.2) |
| `personalStatusBundle:` | `getPersonalStatusBundle`(§21, 2026-09-10 통합) | 10분(현재 시트) / **2시간(과거 fileId)** | `writeSheetValues` 내장 정밀 무효화(개인 탭 쓰기 시) + 제보 처리 경로의 `invalidateMemberSlotCache(env, 번호)` — 개인 탭 원본 + `outputPenSlots` + `reportScore` 셋을 담는 회원별 캐시 |
| `memberRows:` | `getSharedMemberRows` | **10분**(2026-09-11 상향, 구 60초 — §28) | `invalidateMemberCache`(`fine` 그룹) |
| `weeklyPaidFine:` | `getWeeklyPaidFineTotal` | **10분**(2026-09-11 상향, 구 5분 — §33) | `invalidateMemberCache`(`fine` 그룹) |
| `penSlotGrid:` | `attachNextOccurrence` | **5분**(2026-09-11 상향, 구 60초 — §24.6) | `invalidateMemberCache`(`penalty` 그룹) |
| `exitStatus:` | `getAllExitRelevantStatus` | **10분**(2026-09-11 상향, 구 60초 — §28) | `invalidateMemberCache`(`penalty`/`fine`/`exitRequest`/`partiStatus` 그룹) |
| `rosterStatus:` | `buildRosterStatus`(§16) | **10분**(현재 시트, 2026-09-11 하향 — 구 30분) / **2시간(과거 fileId, §17)** | `invalidateMemberCache`(`roster`에 자동 포함, "상금 정산 집행"만 `rosterOnly` 그룹으로 좁게) |
| `adminMemberList:` | `handleAdminMembers`(§17.1 재작성) | **2시간(현재/과거 fileId 공통)** | `invalidateMemberCache`(`roster` 그룹) — `listAllMembers`(`members:`)와는 별개의 바깥 캐시 |
| `coReviewers:` | `getCurrentCoReviewers`(§22, 2026-09-10 신설) | **10분**(2026-09-11 상향, 구 5분 — §28) | `invalidateMemberCache(["partiStatus"])` — 부스터디장 임명/해제(개인 탭 L3)가 즉시 무효화 |

**폐지된 캐시 키**:
- `meritRank:` — `getMeritRank`(MY 탭 개인 순위)가 `rosterStatus:`를 재사용(§16 후반부).
- `reportScore:` / `outputPenSlots:` — `personalStatusBundle:` 하나로 통합(§21). 내부 계산은
  `_computeReportScore` / `_computeOutputPenSlots` 헬퍼로 남아있지만 독립 캐시 키는 없어졌다.

`buildPersonalStatus`(개인 대시보드 조합 계산 자체)는 `_cachedCompute`를 직접
쓰지 않습니다 — `getPersonalStatusBundle` 하나를 거쳐 개인 탭 rows·벌점 슬롯·
제보상점을 한 번에 받아 조합합니다.

## 4. 알려진 위험 지점

1. **`penCycle:`(60초, 무효화 없음)** — `집계!D25`는 앱스크립트가 주 단위로만
   갱신하는 값이라 실사용상 위험은 낮지만, 관리자가 그 셀을 수동으로 편집하는
   경로가 있다면 최대 60초 동안 옛 사이클 번호가 여러 파생 계산에 전파될 수
   있습니다. 이 캐시 그룹에서 유일하게 무효화 경로가 전무한 키입니다.
2. **`personalStatusBundle:`(회원별 키) — 앱스크립트 `daily_calc()` 일요일
   주간 P 기록** — 제보 승인/취소 6곳과 개인 탭 직접 쓰기는
   `invalidateMemberSlotCache`/`writeSheetValues` 내장 무효화가 이 번들 KV를
   콕 집어 지우므로 정상 반영됩니다(§21로 옛 `outputPenSlots:`/`reportScore:`
   개별 gap이 오히려 해소됐다). 남은 gap은 `daily_calc()`가 `{groups:["penalty"]}`
   만 알려 이 회원별 번들은 건드리지 않는 경우 — 라이브 시트 10분 TTL로 자연
   갱신되고 활동이 없는 시간대(자정)라 §11.1에서 저심각도로 판단해 그대로
   뒀습니다. 과거 fileId 번들은 2시간 TTL이지만, 과거 백업 파일은 이 Worker의
   API로만 바뀌고 그 경로가 정확히 무효화하므로 위험 없음(§17).

이 두 위험은 이번 조사에서 "즉시 수정이 필요한 버그"가 아니라 "구조적으로
남아있는 트레이드오프"로 판단해 현재는 그대로 두기로 했습니다(2026-09-09
결정 — KV 삭제를 늘리는 방향은 예산을 더 압박하므로, 필요해지면 TTL을
줄이는 쪽을 우선 검토).

## 5. 낭비 후보 — TTL을 늘려도 정합성 손실 없는 지점

아래 네 캐시는 **무효화가 이미 정확히 걸려 있거나, 애초에 Worker가 쓰는
경로가 전혀 없는데도** TTL이 60초로 짧게 잡혀 있어, 실제로는 안 바뀐 값을
매 분 KV에서 재조회(=KV 읽기 소진)하고 있었습니다. TTL은 원래 "무효화가
놓친 경우의 안전망"인데, 무효화가 이미 완벽히 커버하거나 애초에 갱신
이벤트 자체가 드문 키는 TTL을 늘려도 신선도 손실이 없습니다. 2026-09-09
전수조사 직후 다음 4곳을 60초 → 5분으로 상향 적용했습니다(§3 표에 반영).

- **`members:`** — 회원 명단은 등록/퇴실/재납/번호이동 같은 관리자 조작
  이벤트로만 바뀌며, 그 이벤트들은 전부 `invalidateMemberCache`가 즉시
  무효화합니다. 성격이 같은 `meta:`가 이미 5분으로 잡혀 있던 것과
  맞춥니다.
- **`meritRank:`** — `집계!B4:F18`(상점/순위)은 앱스크립트 일간·주간
  집계가 갱신하며, Worker의 쓰기 지점과는 별개 트리거입니다. 60초 TTL은
  "곧 무효화될 캐시"가 아니라 사실상 폴링 주기로 기능하고 있었습니다.
- **`weeklyPaidFine:`** — `집계!D22`(주간 벌금 합산)는 벌금 상태 변경(하루
  수 회 이하로 추정되는 저빈도 관리자 조작)이나 앱스크립트 일간 집계로만
  바뀌며, 무효화가 5695줄에서 정확히 걸려 있습니다.
- **`penCycle:`** — `집계!D25`(1~3주차 순환)는 Worker 쪽에서 이 셀에 쓰는
  경로가 아예 없고(앱스크립트 주간 트리거만 갱신) 주 1회 수준으로만
  바뀝니다. 무효화 경로가 원래 없는 캐시라, TTL만이 유일한 신선도
  파라미터인데도 60초로 잡혀 있던 것이 가장 명백한 낭비였습니다.

`exitStatus:`/`memberRows:`/`penSlotGrid:`(각 60초, 당시 유지)는 같은 "무효화가
이미 정확함" 논리가 적용되지만, 관리자가 실시간성을 기대하며 자주
새로고침하는 목록/미리보기 화면(퇴실 후보 목록, 납부 상태, 제보 처리 화면의
다음 슬롯 미리보기)이라 **사용성 관점에서 보수적으로 유지**했습니다 —
방금 다른 관리자가 처리한 결과나 자신이 방금 처리한 다음 항목의 미리보기가
1분보다 오래 지연되면 체감 지연이 생길 수 있는 화면들입니다. 데이터
정합성만 보면 늘려도 안전하지만, "사용성을 해치지 않는 선"이라는 조건에서
당시엔 제외했습니다. `penSlotGrid:`는 2026-09-11에 이 조건이 재검토돼
5분으로 상향됐습니다(§24.6) — `exitStatus:`/`memberRows:`는 아직 60초
그대로입니다.

## 6. 다음 단계 (미착수)

이 문서는 조사 결과 기록이며, 아래는 아직 코드에 반영하지 않았습니다.

- `outputPenSlots:`/`reportScore:` 위험 지점(회원별 키라 KV가 자연 TTL
  만료에만 의존)은 별도 이슈로 인지만 하고, 당장은 그대로 유지(KV 삭제를
  늘리는 방향은 예산을 오히려 압박하므로 우선순위 낮음).
- `exitStatus:`/`memberRows:`는 정합성만 보면 TTL을 늘릴 여지가 있지만,
  관리자 화면의 체감 실시간성을 해치지 않기 위해 의도적으로 보류(§5 참고)
  — 사용 패턴이 바뀌어 이 화면들의 재조회 빈도가 문제가 되면 재검토.
  `penSlotGrid:`는 2026-09-11에 이 보류를 재검토해 5분으로 상향했다(§24.6).

## 7. 도움봇(`study_sw/bot/`)의 시트 직접 쓰기와 캐시 리듬 정합

지금까지의 무효화 매칭(§2)은 **Worker API를 경유한 쓰기**(`writeSheetValues`)
만 다룬다. 그런데 로컬 도움봇이 gspread로 시트에 **직접** 쓰는 경로가 따로
있고, 이 경로는 `writeSheetValues`의 내장 정밀 무효화나 `invalidateMemberCache`
를 전혀 거치지 않는다 — Worker 입장에서는 "누가 언제 시트를 바꿨는지 알 방법이
없는 쓰기"다. 이런 쓰기가 있는 캐시 키는 TTL이 유일한 신선도 파라미터가 되므로,
그 TTL은 임의로 정할 게 아니라 **봇이 실제로 그 값을 갱신하는 주기**에 맞춰야
한다.

`study_sw/bot/sheets.py`를 조사한 결과, 개인 탭에 직접 쓰는 경로는 두 가지였다.

- **`_process_holiday_use`/`_process_goaltime`(135/201줄)** — 반휴 신청,
  의무시간(교시제/달성제) 변경 처리. 하지만 `sheets.py:502`의 주석에 "구루미
  채팅(반휴·의무시간 신청)으로만 트리거되던 처리였으나, 채팅 송수신 기능
  자체가 서비스(관리자 페이지)로 대체되어 함께 제거됨"이라 명시되어 있고,
  실제로 호출부가 없는 **죽은 코드**다. 이 두 값은 현재 전부 Worker API
  (`handleSetLeaveApply`/`handleSetGoalSchedule`)로만 바뀌므로 §2의 "개인
  탭 내장 무효화" 커버리지 안에 있다 — 위험 없음.
- **`set_sheet()`(`sheets.py:392`, `worksheet.batch_update`)** — 살아있는
  유일한 경로. 각 교시(`resource/timetable.csv`)의 시작/종료 시각마다
  `schedule_process`(`scheduling.py`)가 호출해, 출석시각·참여율·학습시간을
  개인 탭에 기록한다. `timetable.csv` 기준 교시는 60분 단위이지만, 어느
  교시 종료 시각과 다음 교시 시작 시각 사이 간격은 **10분**이다(예: 1교시
  07:20~08:20, 2교시 08:30~09:30) — 즉 회원 관점에서 개인 탭은 최소
  **10분 간격**으로 갱신된다.

개인 탭 원본 캐시(당시 `personalStatus:`, §21에서 `personalStatusBundle:`로
통합)의 옛 30분 TTL은 "교시(60분) 단위로만 바뀐다"는 전제로 잡혀 있었는데,
실제 갱신 리듬(10분)보다 3배 느슨했다.
그 결과 교시가 끝난 직후 회원이 자기 개인 대시보드를 열어도 최대 30분간
방금 끝난 교시의 참여율이 반영 안 된 값을 볼 수 있었다 — 회원이 확인하고
싶어할 시점(교시 종료 직후)과 정확히 충돌하는 사용성 문제였다. 2026-09-09
TTL을 봇의 실제 쓰기 리듬에 맞춰 **10분**으로 낮췄다(§3 표에 반영).

같은 논리로 다른 캐시들도 봇 쓰기 대상인지 확인했다 — `reportScore:`/
`outputPenSlots:`("데이터" 시트 R~V/F~M열)는 관리자가 제보를 승인/취소할
때만 바뀌고 봇이 쓰는 대상이 아니므로 이 gap과 무관하다(§4의 회원별 키
문제는 별개 사안).

## 8. 프론트 소비 패턴·동시성·번호 재사용 종합 감사 (2026-09-09)

§1~§7의 조사가 "쓰기 지점 ↔ 서버 캐시 무효화" 축에 집중했다면, 이번 감사는
프론트엔드가 그 캐시된 응답을 실제로 어떻게 소비하는지, 그리고 회원 번호가
재사용되는 시나리오까지 넓혀 재점검한 결과다.

### 8.1 번호 재사용 시 회원별 KV 캐시 노출 — 수정 완료

§4에서 "회원별 키(`outputPenSlots:`/`reportScore:`)는 KV가 자연 TTL
만료에만 의존한다"는 트레이드오프를 알려진 위험으로 기록했는데, 이번
감사에서 그 위험이 **번호 재사용**과 겹치는 구체적 시나리오를 확인했다.

퇴실 처리(`performExitReset`)나 번호 재배치(`moveMemberSlot`)로 어떤 번호가
비워진 뒤, 그 번호로 신규 회원이 곧바로 등록되면(`handleAdminCreateMember`)
— 그 사이 다른 isolate가 옛 회원의 `outputPenSlots:{fileId}:{번호}` 또는
`reportScore:{fileId}:{번호+3}` KV 캐시를 이미 채워뒀을 경우, 신규 회원이
처음 `/status`(개인 대시보드)를 열 때 **퇴실한 옛 회원의 벌점/제보상점
이력을 그대로 받을 수 있었다.** 발생에는 ①같은 번호의 즉시 재사용
②그 직전 다른 isolate의 선캐싱 ③재사용 후 5분(outputPenSlots)/30분
(reportScore) 이내 조회, 세 조건이 겹쳐야 해 확률은 낮지만, 한 번 발생하면
신규 회원 화면에 남의 페널티 이력이 노출되는 표시 오염이라 값싸게 막을
수 있다면 막는 게 낫다고 판단했다.

**대응**: 새 헬퍼 `invalidateMemberSlotCache(env, memberNumber)`
(`index.js:878-895` 부근)를 추가해, 번호가 비워지거나 재배정되는 세 지점
— `performExitReset`(퇴실), `moveMemberSlot`(번호이동, from/to 둘 다),
`handleAdminCreateMember`(신규 등록 시점의 방어적 재확인) — 에서 그 번호
하나에 한해 `outputPenSlots:`/`reportScore:` KV까지 명시적으로 지운다.
이 세 함수는 제보 승인/취소처럼 자주 일어나는 액션이 아니라 "번호 1개당
1회"만 실행되는 저빈도 관리자 조작이라, `invalidateMemberCache`가 이 두
캐시를 무조건 삭제 목록에서 뺀 이유(회원 수만큼 반복되는 KV 삭제가 예산을
압박)가 여기서는 적용되지 않는다 — 예산에 미치는 영향은 무시할 수준이다.

### 8.2 관리자 간 화면 동기화는 서버 TTL이 아니라 "탭 재방문"이 지배 변수 — 현행 유지

`app/src/hooks/useRefreshOnVisible.ts`(탭이 `visible`로 바뀔 때만 재조회)가
관리자 데이터 화면 대부분에 쓰이고, 자동 폴링(`setInterval`)은
`useRosterPolling`(15초, 참여 현황 전용) 한 곳뿐이다. 즉 관리자 두 명이
각자 다른 회원을 처리하며 같은 화면을 계속 띄워둔 채 작업하면, 서로의
처리 결과는 상대가 탭을 벗어났다 돌아오거나 새로고침하기 전까지 반영되지
않는다 — 이건 서버 캐시 TTL과 무관한, 프론트 재조회 트리거 구조의 한계다.

이 자체는 정합성 문제가 아니다(재방문/새로고침하면 항상 정확한 값을
받는다). §5에서 이미 관리자 화면의 실시간성을 지키기 위해 일부 TTL을
짧게 유지하기로 결정했는데, 그 결정의 효과가 프론트 재조회 빈도에 의해
어차피 상당 부분 상쇄되고 있다는 뜻이기도 하다. 다만 이걸 해결하려면
폴링 추가나 서버 푸시 같은 별도 아키텍처 작업이 필요해 캐싱 정책 조정의
범위를 벗어난다 — 이번 조사에서는 수정하지 않고 현행 유지, 필요성이
커지면(예: 운영 중 실제로 중복 처리 사고가 발생하면) 별도 과제로 검토.

### 8.3 문제없음으로 재확인된 것

- 세대 카운터 보호(`_cachedCompute` 내장)는 12곳 모두에 예외 없이 적용되어
  있다 — 인메모리 안에서 "무효화가 무효화되는" 경쟁은 구조적으로 막혀
  있다(KV로 넘어가는 경계에는 세대 개념이 없어 9.1과 같은 gap이 남지만,
  그건 별도로 대응했다).
- 백업 파일(`sourceFileId`/`fromBackup`)은 실제로 불변 — 한 번 만들어진
  뒤 다시 쓰이지 않으므로, 그 파일에 대한 캐시가 낡아도 무해하다.
- `_cacheGeneration`(개별 키 세대 맵)의 실사용처는 `personalStatus:`
  하나뿐이고, `MEMBER_CACHE_PREFIXES` 밖에서 별도로 이 맵을 쓰는 캐시
  키는 없다.
- 프론트에 자체 캐싱 계층이 없다(`apiFetch`는 매번 실제 네트워크 요청) —
  "프론트가 오래된 응답을 재사용"하는 유형의 문제는 애초에 발생 구조가
  아니다.

## 9. 실사용 빈도 기준 재검토 (2026-09-09) — "극단적 경쟁 조건"이 아니라 "매일 벌어지는 흐름" 기준

§9까지의 조사는 저확률 경쟁 조건(isolate 간 레이스, 번호 재사용 5분 이내
우연한 조회 등)까지 파고들었다. 이번 조사는 관점을 바꿔 **"극한 상황이
아니라 당장 서비스 운영에서 실제로 자주 벌어지는 흐름에서 정합성·사용성이
심하게 저해되는 게 있는지"**를 기준으로 재검토했다.

### 9.1 발견 및 수정 — "벌금 납부 처리" 총액이 연속 처리 중 갱신 안 됨

`app/src/components/admin/AdminMoneyTab.tsx`의 `handleSetStatus`(관리자가
회원의 벌금 상태를 미납→납부 등으로 바꾸는 액션)는 개별 뱃지
(`statusOverride`)만 즉시 갱신하고, 상단 `InfoCard`의 "납부된 총 벌금액"
(`totalAmount`)은 전혀 갱신하지 않았다 — 이 값은 탭 최초 로드 시점에
받아온 값을 그대로 들고 있다가, 이 탭을 벗어났다 돌아오거나(`useRefreshOnVisible`)
새로고침해야만 정확해졌다.

관리자가 벌금 미납자 여러 명을 이 화면에서 벗어나지 않고 연달아 "납부"로
처리하며 그때그때 합계를 확인하는 것은 벌금 처리의 표준 워크플로우라 —
이건 §9가 다룬 저확률 경쟁 조건이 아니라 **매번, 확실하게 재현되는** 문제였다.
서버 쪽(`handleAdminFineStatus`, `index.js:5708-5734`)은 처리 직후
`invalidateMemberCache`로 `weeklyPaidFine:` 캐시를 정확히 무효화하고
있었으므로(§2에서 이미 확인) 캐싱 정책 자체의 결함이 아니라, **프론트가
서버 액션 성공 후 관련 파생값을 다시 받아오지 않은 순수 프론트 버그**였다.

**수정**: `handleSetStatus` 성공 콜백에서 `/admin/fines/paid`를 다시 호출해
`totalAmount`만 가볍게 갱신하도록 추가(전체 `load()`를 부르면
`statusOverride`가 초기화되어 방금 바꾼 뱃지 표시가 사라지므로, 합계만
별도로 재조회).

심각도는 사용성(표시 지연)이며 정합성(시트에 쓰이는 값) 문제는 아니었다 —
시트 자체는 항상 정확했고, 다음 새로고침에서는 항상 맞는 값이 나왔다.

### 9.2 재확인 — 회원별 KV gap은 "번호 재사용" 없이도 발생 가능하나 빈도는 미확정

§8.1에서 "번호 재사용" 시나리오에 한해 `outputPenSlots:`/`reportScore:`
KV gap을 방어했는데, 이번 재검토에서 **번호 재사용 없이 "제보 승인 → 대상
회원이 곧바로 자기 대시보드 확인"만으로도 같은 근본 gap(다른 isolate가
승인 직전에 캐시해둔 낡은 KV 값)이 이론상 발생할 수 있다**는 점을
재확인했다. 다만 이게 실제로 얼마나 자주 재현되는지는 Cloudflare Workers의
isolate 분산과 KV 히트율에 달려 있어 정적 코드 조사만으로는 빈도를 확정할
수 없었다 — "매번 발생"이라고 단정할 근거도, "극히 드묾"이라고 단정할
근거도 없다. 심각도는 어느 쪽이든 표시 지연(정합성 문제 아님)이라 이번엔
수정하지 않고 기록만 남긴다 — 필요하면 §5.1(사용량 모니터링)의 KV 히트/
미스 실측으로 재판단.

### 9.3 저확률로 판단해 제외한 것

- `GoalTypeScheduleDialog`의 예약 제출 후 상위 화면이 즉시 안 바뀌는 것 —
  "다음 주 월요일부터 적용"되는 예약값이라 오늘 화면에 반영될 필요가
  없고, 다이얼로그를 다시 열면 정확한 값을 다시 받아온다. 문제없음.
- `meritRank:`/`weeklyPaidFine:` 등의 5분 TTL 상향 — 앱스크립트 갱신
  주기(자정~새벽)와 회원 활동 시간대가 겹치지 않아 실사용 지연 체감
  가능성이 낮다. §5 결론 유지.

## 10. `invalidateMemberCache` 그룹 세분화 — KV 삭제 횟수 자체를 절감 (2026-09-09)

§5~§9는 대부분 **읽기 TTL**(캐시가 비어있을 때 KV를 다시 채우는 빈도)을
다뤘다. 하지만 사용자가 원래 지적한 "제보 처리 조금 했는데 KV 쓰기/삭제가
700회 넘게 소진됨"의 진짜 원인은 **쓰기 시점의 삭제 횟수 자체**였다 —
`invalidateMemberCache`는 §1에서 설명한 대로, 호출될 때마다 실제로
바뀐 캐시와 무관하게 **무조건 7개(+회원별 키)를 통째로 삭제**하도록
설계돼 있었다.

18개 호출부(§2의 16곳 + 이후 추가된 것 포함)를 실제로 어떤 시트 range를
쓰는지 다시 대조한 결과, 대부분은 9종 캐시 중 일부에만 영향을 준다:

| 실제 조작 | 영향받는 캐시 | 호출 빈도 |
|---|---|---|
| 제보 승인/취소/반려/유예 (6곳) | `penSlotGrid`/`exitStatus`(그룹) + 대상자·제보자의 `personalStatusBundle`(`invalidateMemberSlotCache`, §21) | **가장 빈번** |
| 벌금 납부 상태 변경 (1곳) | `exitStatus`/`memberRows`/`weeklyPaidFine` (3종) | 중간 |
| 퇴실 신청/동의/취소 (3곳) | `exitStatus` (1종) + 그 회원 `personalStatusBundle`(`invalidatePersonalStatusCache`) | 중간 |
| 참여상태(부스터디장) 변경 (1곳) | `exitStatus`/`coReviewers` (2종, §22) | 낮음 |
| 회원 명단/시트 구조 변경(신규·퇴실·번호이동, 4곳) | `roster` 그룹 전체(`MEMBER_CACHE_UNCONDITIONAL_KEYS` 전부) + 그 회원 `personalStatusBundle` | **저빈도** |

가장 자주 일어나는 제보 처리가 무관한 여러 종(`members`/`meta`/`meritRank`/
`memberRows` 등)까지 매번 함께 지우고 있었던 것이 핵심 낭비였다.

**대응**: `invalidateMemberCache(env, groups, fileId)`로 시그니처를 확장해,
`MEMBER_CACHE_GROUPS`(`roster`/`penalty`/`fine`/`exitRequest`/`partiStatus`/
`cycle`/`rosterOnly`)에 정의된 좁은 그룹을 호출부가 넘길 수 있게 했다.
`groups`를 생략하면 `roster` 그룹(= 회원 명단/시트 구조가 바뀌는 4곳은
실제로 전부와 관련 있으므로)이 기본값이라 안전망을 잃지 않는다. 인메모리
무효화(세대 카운터)는 그룹과 무관하게 **항상 전체를 한 번에** 처리한다 —
이건 공짜라 좁혀도 이득이 없고, 좁히면 오히려 "이번엔 무효화 안 된 인메모리
키가 남는" gap 위험만 늘어나기 때문이다. 아끼는 건 오직 KV `.delete()` 호출
수뿐이다.

> **§17.2 이후 현재 그룹 정의**(index.js):
> ```
> roster:         [...MEMBER_CACHE_UNCONDITIONAL_KEYS]   // 11종 전부
> penalty:        ["exitStatus", "penSlotGrid"]
> fine:           ["exitStatus", "memberRows", "weeklyPaidFine"]
> exitRequest:    ["exitStatus"]
> partiStatus:    ["exitStatus", "coReviewers"]
> cycle:          ["penCycle"]
> rosterOnly:     ["rosterStatus"]
> memberIdentity: ["members", "dataSheetRows"]   // §17.2, 제보 승인/상점 지급 직전 전용
> ```

18개 호출부를 각각 재분류해 반영한 결과(코드로 시뮬레이션 검증):

| 그룹 | 삭제 개수(기존 → 이후) | 절감률 |
|---|---|---|
| 제보 처리(`penalty`) | 7 → 2 | 약 71% |
| 벌금 처리(`fine`) | 7 → 3 | 약 57% |
| 퇴실신청/참여상태(`exitRequest`/`partiStatus`) | 7 → 1 | 약 86% |
| 회원 명단 변경(`roster`, 저빈도) | 7 → 7 | 변화 없음(원래 전부 필요) |

가장 빈번한 제보 처리 6곳이 71% 절감되므로, 하루 전체 KV 삭제 소진량은
실제 사용 패턴(제보 처리 비중이 클수록)에 따라 상당 폭 줄어들 것으로
기대한다. 정합성 손실은 없다 — 각 호출부가 실제로 `writeSheetValues`로
건드리는 range를 코드로 직접 대조해 그룹을 매겼고, 무관한 캐시를 빼는
것뿐이라 오히려 기존의 "과잉 무효화"보다 정확한 매핑이다.

## 11. 앱스크립트 트리거의 시트 직접 쓰기 — 매주 반복되는 흔한 흐름 기준 재검토 (2026-09-09)

§7이 다룬 "Worker를 거치지 않는 직접 쓰기"는 도움봇(`study_sw/bot/`)만
조사했다. 이번엔 시트에 내장된 **앱스크립트**(`study_sw/assets/appscript.js`)
트리거도 같은 성격의 쓰기를 하는지 전수조사했다 — "극단적 경쟁 조건"이
아니라 "매주 실제로 반복되는 흔한 흐름에서 체감되는 지연이 있는지" 기준으로.

### 11.1 발견

- **`daily_calc()`(매일 자정~1시, 일요일 실행분만)** — 그 주 목표시간/참여율
  미달을 판정해 "데이터" 시트 L/M열(주간 P 슬롯, 당시 `outputPenSlots:`/
  `reportScore:` — §21에서 `personalStatusBundle:`로 통합 — 및 `penSlotGrid:`
  캐시가 담는 값)에 관리자 개입 없이 직접 벌점을 기록한다. 지금까지 이 세 캐시는 "관리자 조작(제보 승인/취소)으로만
  바뀌고, 그건 항상 `invalidateMemberCache`가 무효화한다"는 전제였는데
  이 전제가 정확하지 않았다.
- **`revoke_editor_column_n()`(매주 월 14~15시, 목표시간 마감)** — 개인 탭
  O3(목표시간)에 직접 쓴다. 이 마감 시각이 **웹앱의 신청 마감(매주 월
  14:00)과 정확히 일치**해, 회원이 마감 직후 반영 여부를 확인하려는
  시점과 정확히 겹치는 매주 반복 시나리오였다.
- **`revoke_editor_column_o()`(매일 밤 11시~12시, 반휴 마감)** — 개인 탭
  20행(반휴 사용)에 직접 쓴다. 개인 탭 원본 캐시(`personalStatusBundle:`)가
  §7에서 이미 봇의 교시 리듬(10분)에 맞춰져 있어 영향은 크지 않지만 같은
  성격의 gap.

셋 다 **정합성(시트에 잘못된 값이 쓰이는 것) 문제는 아니다** — 표시가
최대 5~30분 낡아 보일 수 있는 사용성 문제였고, 활동이 적은 시간대(자정,
밤 11시)이거나 짧은 순간(마감 직후)이라 심각도는 낮았다.

### 11.2 대응 — 앱스크립트→Worker 무효화 알림

`invalidateMemberCache`를 여러 번 반복 호출하는 게 아니라, **15명을
순회하는 트리거 함수 하나가 끝날 때 딱 1번**만 Worker에 "방금 이만큼
바꿨다"고 알리는 방식이라 KV 예산에 미치는 영향은 미미하다(주당 최대
2~3회 추가, 각각 §10의 좁은 그룹 기준 2~4개 삭제 — 하루 1,000개 한도에
비해 무시할 수준).

- **새 엔드포인트**: `POST /bot/invalidate-cache`(`handleBotInvalidateCache`,
  index.js:6682 부근)가 `X-Bot-Secret` 인증 후 `{groups: [...]}` 또는
  `{memberNumbers: [...]}`를 받아 `invalidateMemberCache(env, groups)`
  또는 회원별 `invalidatePersonalStatusCache`(`personalStatusBundle:` 키)를
  호출한다.
- **`daily_calc()`**: 주간 P 슬롯을 실제로 채운 경우에만 함수 끝에서
  `_notifyWorkerCacheInvalidate({groups:["penalty"]})`.
- **`revoke_editor_column_n()`/`revoke_editor_column_o()`**: 실제로 값을
  반영한 회원 번호만 모아 `_notifyWorkerCacheInvalidate({memberNumbers:[...]})`.
- **방어**: `_fetchExitDates()`(§ "마지막 참여일 이후 집계 차단")와 동일한
  패턴 — `BOT_SECRET` 스크립트 속성 미설정이거나 호출 실패해도 조용히
  로그만 남기고 넘어간다. 본 작업(시트 반영)은 이미 끝난 뒤라 이 알림의
  실패가 daily_calc/revoke_editor_column_n·o 자체를 막지 않으며, 실패해도
  TTL 만료로 결국 저절로 정확해진다.

상세 코드 위치와 트리거별 설명은 `docs/SHEET_APPSCRIPT.md`
"Worker 캐시 무효화 알림" 절 참고.

**반영 시 주의**: `study_sw/assets/appscript.js`는 참고용 사본이며, 실제
동작하려면 Google Sheets의 확장 프로그램 → Apps Script 편집기에 이 코드를
수동으로 복사해 저장해야 한다.

## 12. 프론트 자동 폴링 — "새로고침 버튼도 캐시를 그대로 반환한다" 문제 대응 (2026-09-09)

새로고침 버튼(`SectionHeader`의 `onRefresh`)을 눌러도 결국 같은 API를
다시 부를 뿐이라, 서버 캐시 TTL이 안 지났으면 버튼을 눌러도 낡은 값을
그대로 받는다는 걸 사용자가 지적했다. "캐시를 무시하고 강제로 다시
읽기" 옵션은 사용자가 한도 개념 없이 연타하면 KV 예산을 오히려 압박할
위험이 있어 채택하지 않았다 — 대신 **TTL이 자연 만료될 때쯤 화면이
알아서 다시 불러오는 폴링**을 택했다(사용자 지시: "즉시는 아니어도 큰
부하 없는 선에서 자동 새로고침").

### 12.1 설계 원칙

새 훅 `usePollingRefresh(visible, load, intervalMs)`
(`app/src/hooks/usePollingRefresh.ts`)를 `useRefreshOnVisible`(탭 재방문
시 재조회)과 짝으로 둔다. 핵심 규칙: **폴링 주기는 관련 캐시 TTL의
3배 이상으로 잡는다.** 폴링 주기를 TTL과 비슷하게 잡으면 폴링이 도착할
때마다 캐시가 아직 안 만료된 상태라 매번 캐시를 그대로 반환받게 되어
사실상 의미가 없고, 반대로 TTL과 같거나 짧게 잡으면 폴링 자체가 캐시를
계속 강제로 재계산시키는 것과 같아져 캐시를 무력화한다(§1의 캐시 목적
자체를 해침). 3배 이상으로 잡으면 대부분의 폴링 시점에 캐시가 이미
자연 만료돼 있어, 캐시가 절감해온 KV 예산은 거의 그대로 유지하면서
"몇 분 안에 자동 반영"이라는 효과만 얻는다. `visible`이 false인 동안
(다른 SPA 내부 탭에 가려짐)에는 타이머 자체를 돌리지 않아, 보이지 않는
화면이 백그라운드에서 계속 요청을 쌓는 것도 막는다.

> 🔧 **[2026-09-09 시도 후 원복] Page Visibility API(A) / `MyStatusProvider`
> 화면 범위 제한(B) / 유휴 감지(G)** — 같은 날 세 가지를 순서대로 추가해
> 배포했었다: (A) 브라우저 탭이 다른 탭에 가려지거나 최소화된 순간의
> 폴링 틱을 `document.hidden`으로 건너뛰기, (B) `MyStatusProvider`를
> `App.tsx`의 `HashRouter` 바로 아래(라우팅 정보를 모르는 위치)에서
> `MainViews` 내부로 옮겨 대시보드/설정 화면일 때만 15분 폴링이 돌게
> 좁히기, (G) `app/src/lib/idleTracker.ts`를 신설해 마우스/키보드/터치
> 조작이 일정 시간(처음 5분, 이후 3분 폴링 주기보다 짧게 2분으로 재조정)
> 없으면 "화면은 보이지만 실제로는 안 쓰고 있다"고 판단해 폴링 틱을
> 건너뛰기. `wrangler tail` 실시간 로그와 Playwright(각 조건을 합성
> 이벤트로 격리 조작)로 세 가지 모두 의도대로 정확히 동작함을 검증까지
> 마쳤었다. 게이지도 hidden/idle로 실제 재조회가 건너뛰어질 때 표시용
> `displayTimer`가 계속 정상적으로 차올라 "지금 새로고침되고 있다"는
> 오해를 줄 수 있다는 지적에 맞춰 함께 동결시키도록 고쳤었다.
>
> 이후 사용자가 "가만히 화면을 보고만 있는데(스크롤·클릭 없이) 갱신이
> 멈추는 게 이상하다"고 지적했다 — 유휴 감지는 실제 조작 이벤트만
> 보므로 "화면을 계속 읽고만 있는" 정당한 사용 패턴과 "자리를 비운"
> 상태를 구분할 수 없다는 근본적 한계가 있었다. 이 한계를 어떻게
> 완화할지(유휴 기준을 다시 늘리거나, 멈췄을 때 이유를 보여주는 UI를
> 추가하는 등) 검토하기 전에, 우선 세 가지를 전부 걷어내 원점(§13
> 진단 도구만 있는 상태)으로 되돌렸다 — `app/src/App.tsx`,
> `app/src/hooks/usePollingRefresh.ts`, `app/src/lib/status/
> MyStatusContext.tsx`를 A/B/G 이전 커밋(`0f2f43d`) 상태로 되돌리고
> `idleTracker.ts`는 삭제했다. §13의 화면별 KV 쓰기/삭제 추적 로그(진단
> 도구)는 A/B/G와 무관하게 그대로 남아 있다 — 다시 절감 방안을 설계할
> 때 이 로그로 원인을 다시 좁힐 수 있다.
>
> 원복 직후 Playwright로 "A/B/G 없이 관리자 1명이 화면 하나만 띄워둔
> 채 방치"를 10분간 실측한 결과 KV 쓰기 24회(삭제 0회) — 시간당 약
> 144회, 8시간이면 약 1,152회로 관리자 단 1명이 하루 무료 한도(1,000회)
> 를 그냥 넘겨버리는 수준이었다. A/B/G 자체는 반드시 필요하다는 게
> 재확인된 셈이라, "가만히 보고 있으면 멈춘다"는 오해만 다른 방식으로
> 해소하기로 했다.

> 🔧 **[2026-09-09 재도입] A/B/G + 절전화면 오버레이** — 사용자 제안:
> "절전화면 같은 개념으로 만들어버리는 건 어때?". 유휴로 조용히 멈추는
> 대신, 유휴 상태를 화면에 명확히 알려주고 돌아오면 즉시 최신값을 받는
> 방식으로 A/B/G를 다시 넣었다.
>
> - **유휴 기준은 5분으로 통일**(사용자 확정) — `idleTracker.ts`가 이제
>   `IDLE_THRESHOLD_MS`(5분) 하나만 내보내고, `usePollingRefresh`/
>   `MyStatusContext`가 이 값을 그대로 가져다 쓴다(전에는 훅마다 따로
>   5분/2분을 들고 있어 어긋날 위험이 있었다). "첫 틱은 항상 통과된다"는
>   설계 허점이 다시 생기지만(가장 짧은 3분 폴링 기준 하루 몇십 회
>   수준으로 §12.1 앞부분에서 이미 실측), 아래 절전 오버레이가 "지금
>   유휴라 멈춰 있다"는 걸 명확히 보여주므로 그 정도 지연은 감수하기로
>   했다.
> - **`app/src/components/layout/IdleOverlay.tsx` 신설** — `App.tsx`
>   최상위(모든 라우트 공통)에 한 번 마운트한다. 유휴 상태가 되면 화면
>   전체를 반투명 스크림으로 덮고 "자동 새로고침을 잠시 멈췄어요 · 움직이면
>   다시 시작돼요"를 보여준다 — idleTracker가 이미 듣고 있는 이벤트
>   (마우스/키보드/스크롤/터치) 중 아무거나 발생하면 사라진다. 첫 클릭이
>   오버레이 아래 버튼을 곧바로 누르지 않도록(진짜 절전화면을 깨울 때와
>   같은 동작) 오버레이가 클릭을 가로챈다.
> - **유휴 진입/해제를 이벤트로 방송** — `idleTracker.ts`에 5초 주기
>   내부 체크를 추가해 유휴 상태가 바뀌는 순간 `IDLE_ENTER_EVENT`/
>   `IDLE_WAKE_EVENT`를 `window`에 쏜다. `useIsIdle()` 훅(오버레이 전용)은
>   이 이벤트만 구독해 리렌더한다 — 별도 폴링 없음.
> - **깨어나면 즉시 한 번 재조회** — `usePollingRefresh`/
>   `MyStatusProvider` 둘 다 `IDLE_WAKE_EVENT`를 구독해, 유휴가 풀리는
>   즉시(그 화면이 보이는 상태라면) `load()`/`refresh()`를 한 번 호출하고
>   게이지 카운트다운도 그 시점부터 새로 시작한다. 예전엔 자리를
>   비웠다 돌아와도 다음 정기 틱(최대 intervalMs)까지 낡은 값을 봐야
>   했는데, 이제 돌아오는 순간 최신값을 받는다 — 오히려 원래보다 체감
>   반응성이 좋아졌다.

### 12.2 적용한 화면과 주기

| 화면(메뉴) | 관련 캐시(TTL) | 폴링 주기 |
|---|---|---|
| `ReportReviewList`("화각 불량 제보 처리") | `penSlotGrid:` 5분(§24.6) / `coReviewers:` 5분(§22) | **20분**(2026-09-11, 구 10분 — `penSlotGrid:` 상향에 맞춰 배율 4배 유지, §24.6) |
| `PenaltyCandidateList`("예치금 재납 대상자") | `exitStatus:` 10분(2026-09-11 상향, §28) / `memberRows:` 10분(§28) | **20분**(2026-09-11, 구 3분 — "봇 상태 제외 전부 20분 통일" 지시, §27 참고. 배율 2:1) |
| `AdminMoneyTab`의 벌금 조회(`PaidFineList` 등) | `memberRows:` 10분(§28) / `weeklyPaidFine:` 10분(§33) | **20분**(2026-09-11, 구 3분 — 위와 동일 지시) |
| `MyOutputPenSection`("내 제보 확인") — 렌더(`load`) | `penSlotGrid:` 5분(§24.6) / `members:` 2시간(§17.2) | **20분**(2026-09-11, 구 10분·3분 — §24.6) |
| `MyOutputPenSection`("내 제보 확인") — 감지(`detectNew`, 신설) | `/my-output-pen` 응답의 id만 비교, 캐시 아님 | **5분**(§24.6, 새로고침 버튼 활성화 전용) |
| `RosterPage`("RANK") | `rosterStatus:` 10분(2026-09-11 하향, 구 30분) | 30분 — 폴링 : TTL 배율 **3:1**로 원칙(3배 이상) 충족(2026-09-11 이전엔 1:1이었다) |
| `StatusPage` / `MyStatusContext`("내 대시보드"·"설정") | `personalStatusBundle:` 10분(현재 시트) 등 §12.1·§21 | 30분(§14) — 대시보드/설정 화면일 때만(B) + `document.hidden`(A) + 5분 유휴(G, 절전 오버레이) 모두 적용 |
| `MemberRosterList`("참여 스터디원 목록") | `dataSheetRows:` 2시간(2026-09-11 상향, §26) / `meta:` 10분(2026-09-11, 구 5분) / `members:` 2시간(§17.2) | **20분**(2026-09-11, 구 30분 — "봇 상태 제외 전부 20분 통일" 지시, §27. `meta:` 기준 배율 2:1로 §12.1 원칙(3배 이상)에는 못 미치지만, 통일 지시에 따른 의도적 절충으로 기록) |

`AdminMoneyTab`의 `PrizeRecipientList`(`/roster-status`)는 `buildRosterStatus`
가 `_cachedCompute` 없이 매번 직접 시트를 조회하는 무캐시 경로라(§3
"관련 문서" 참고) 폴링을 걸 캐시 자체가 없어 대상에서 제외했다.
`ReasonLeaveReviewList`(사유 반휴 신청 처리)는 11종 캐시가 아니라 KV
기반(`leaveHistory:`)이라 이번 TTL 기준 폴링 설계와 무관해 손대지 않았다.
`ExitedMemberList`(퇴실 스터디원 목록)는 현재 실제 API 대신 더미 데이터를
표시 중인 미완성 상태(사용자 확인, 별도 과제로 보류)라 제외했다.

**`BotStatusSection`("도움봇 오퍼레이터", 스크린샷 포함)은 별도로 1분
고정 주기 폴링을 추가했다** — `handleAdminBotStatus`(index.js:3071-3080)는
KV 캐시가 아니라 매 요청마다 `proxyToBotDashboard(env, "/status")`로 봇에
직접 프록시하는 무캐시 경로라 위 "TTL의 3배" 원칙 자체가 적용되지 않는다.
대신 봇이 요청마다 Selenium(`ctx.driver.get_screenshot_as_base64()`,
`dashboard_server.py`)으로 화면을 실시간 캡처하며, 이 캡처가
`ctx.lock_element` 락 안에서 실행돼 제보 캡처·교시 기록 등 봇의 다른
작업과 자원을 공유한다 — 주기를 너무 짧게 잡으면(예: 30초, 하루 2,880회)
락 경합과 대역폭(스크린샷 1건당 대략 100~300KB, 하루 수백MB) 부담이
커진다. KV 예산과는 무관하지만 "봇 부하"라는 별개의 제약이라, 사용자가
1분을 "부하는 낮게 유지하면서 꽤 실시간"인 절충점으로 확정했다.

### 12.3 부수 수정 — `AdminMemberPenaltyTab`의 무시되던 `visible`

`MemberRosterList`에 폴링을 걸려고 보니 `AdminMemberPenaltyTab`(Account
탭)이 `visible` prop을 받고도 `{ visible: _visible }`로 이름 붙여 명시적으로
버리고 있었다 — 즉 이 탭은 폴링 이전부터도 탭을 벗어났다 돌아와도 자동
재조회가 안 되는 상태였다(다른 탭들과의 불일치). `visible`을
`MemberRosterList`까지 실제로 전달하도록 고치고, `useRefreshOnVisible`도
함께 추가했다 — 폴링 설계 과정에서 발견한 부수적 버그 수정.

### 12.4 "내 대시보드" 새로고침 버튼을 TTL 만료 전엔 비활성화 (2026-09-11)

이 절 도입부의 문제("새로고침 버튼을 눌러도 서버 캐시 TTL이 안 지났으면
낡은 값을 그대로 받는다")를 폴링으로 우회하는 대신, **MY 탭(`StatusPage`,
헤더 "내 대시보드")에 한해 그 버튼 자체를 TTL이 지나기 전엔 못 누르게
막는 방식**으로 직접 해결했다 — "캐시를 무시하고 강제로 다시 읽기"(§12
도입부에서 기각된 방안)의 반대 방향: 캐시를 우회시키는 게 아니라, 우회할
수 없다는 걸 버튼 상태로 드러낸다.

- **기준 TTL**: 백엔드 `getPersonalStatusBundle`과 동일한 분기(현재 시트
  10분 / 과거 사이클(cycle 파라미터) 2시간, §21)를 프론트에서 그대로
  재현한다(`StatusPage.tsx`의 `ttlMs = isViewingCycle ? 2h : 10min`).
- **기준 시각**: 서버에서 실제로 새 응답을 받은 시각만 기준으로 삼는다.
  `MyStatusContext`에 `lastLoadedAt`(ms epoch)을 추가해 `refresh()` 성공
  시점에만 갱신한다 — 반휴 신청 성공 시의 낙관적 업데이트(`setStatus`)는
  실제 서버 재조회가 아니므로 이 시각을 갱신하지 않는다(갱신하면 방금
  캐시가 무효화돼 다음 클릭이 진짜 최신값을 받을 수 있는 상황인데도
  버튼이 다시 잠겨버린다).
- **다른 회원/과거 사이클 조회**: `MyStatusContext`를 안 타는 경로라
  `StatusPage`가 로컬 `otherLoadedAt`으로 동일한 방식을 별도 추적한다.
- **재활성화**: 1초 간격 틱(`visible`일 때만 동작, 네트워크 요청 없이
  리렌더만)으로 TTL이 지나는 순간 자동으로 버튼이 풀린다. 비활성화
  중에는 버튼 `title` 툴팁에 "N분 후 새로고침 가능"을 보여준다.
- **적용 범위**: `SectionHeader`(20여 곳이 공유하는 컴포넌트)에 옵션
  prop `refreshDisabled`/`refreshDisabledReason`을 추가하는 형태로
  구현해, 값을 넘기지 않는 기존 호출부(관리자 리스트 등)는 동작이
  전혀 바뀌지 않는다 — 이번 요청은 "내 대시보드"에만 한정됐기 때문에
  다른 화면(예: RANK 탭, 관리자 리스트들)의 새로고침 버튼은 여전히
  `loading` 중에만 비활성화된다.

## 13. 화면별 KV 쓰기/삭제 추적 로그 (2026-09-09 신설)

사용자가 "관리자 3명이 화면을 계속 켜 놓으면 어떤 문제가 생기냐"고 물으며
"어느 화면에서 어떤 기능에 의해 쓰기·삭제가 주기적으로 발생하는지" 확실히
알고 싶다고 요청해 추가한 진단 도구다. §5.1의 Cloudflare 실측 게이지
(`kvWritesToday`)는 "오늘 하루 총합"만 보여줄 뿐 "어디서" 늘어나는지는
알려주지 않는다는 한계가 있었다.

- **구현**: `fetch`/`scheduled` 핸들러 진입 시 `env.REPORTS_KV`를 얇은
  프록시(`instrumentKvNamespace`, index.js)로 한 번만 감싼다 — 58곳에
  흩어진 개별 `.put()`/`.delete()` 호출부는 전혀 건드리지 않고, 이후의
  모든 호출을 자동으로 가로챈다. 각 호출마다 (연산 kv_put/kv_delete ×
  캐시 종류 × 이 요청의 URL pathname)을 인메모리 카운터
  (`_kvUsageCounters`, sheets API 카운터와 별도 Map으로 분리, 30분 창)에
  누적하고, `wrangler tail`에서 바로 보이도록 `console.log`도 함께
  남긴다(`[kv put] path=/admin/captures key=sheetCache:exitStatus:...`).
- **캐시 종류 표기**: `sheetCache:`(§1의 KV_CACHE_PREFIX)로 시작하는
  키만 두 번째 세그먼트까지 포함해 `sheetCache:exitStatus:`처럼 §3 표의
  캐시 종류가 그대로 드러나게 한다. 그 외(`report:`/`leaveq:`/
  `exitRequest:` 등)는 첫 세그먼트만.
- **확인 방법**: `GET /admin/usage` 응답의 `kvWriteBreakdown` 배열
  (`{op, kind, path, count}[]`), "Bot·Sheet" 탭 "사용량 모니터링" 섹션에
  "최근 30분 KV 쓰기·삭제 — 화면별"로 표시된다. `path`를 이 문서 §12.2의
  화면↔엔드포인트 매핑과 대조하면 "어느 화면"인지 바로 알 수 있다.
  개별 이벤트 하나하나를 놓치지 않고 보려면(예: 정확히 몇 시 몇 분에
  발생했는지) `wrangler tail`로 실시간 로그를 직접 관찰하는 것이 이
  인메모리 집계보다 정확하다 — 집계는 isolate 콜드스타트마다 리셋되는
  근사치다.
- **한계**: 여러 isolate로 요청이 분산되면 이 집계는 "지금 이 요청을
  처리한 isolate가 최근 30분간 직접 본 것"만 보여준다 — 다른 isolate가
  처리한 호출은 여기 안 잡힌다(§9.2의 isolate 분산 한계와 같은 종류).
  "정확한 하루 총합"은 §5.1의 Cloudflare 실측 게이지를 신뢰하고, 이
  breakdown은 "지금 이 순간 뭐가 반복해서 쓰는지" 원인을 좁히는 용도로
  쓴다.

## 14. 대시보드(`/status`) TTL·폴링 재조정 (2026-09-10)

`/status`(내 대시보드)가 조합하는 캐시 5종의 TTL이 서로 제각각이고
(5분/5분/5분/30분/10분), 폴링 주기(15분)와의 배율도 원칙(3배 이상)에
못 미쳐 실질적인 절감 효과가 거의 없다는 걸 대화로 하나씩 짚어가며
확인했다. 표로 정리:

| 캐시 | 이전 TTL | 변경 후 | 비고 |
|---|---|---|---|
| `personalStatus` → §21에서 `personalStatusBundle`로 통합 | 10분 | **10분(유지)** | 도움봇이 교시 종료마다(~10분 간격) 개인 탭에 직접 쓰므로, 그 리듬에 맞춰야 새로고침 시 낡은 값을 안 본다(§7) — 폴링 주기를 3배로 맞추지 않고 예외로 남겼다. §21에서 `outputPenSlots`/`reportScore`가 이 번들로 흡수되며 셋이 같은 10분 TTL을 공유한다 |
| `meritRank` | 5분 | **폐지**(§16 — `getMeritRank`가 `rosterStatus:` 재사용) | — |
| `outputPenSlots` | 5분→10분 | **폐지**(§21 — `personalStatusBundle`로 통합) | 통합 전 마지막 TTL은 10분 |
| `reportScore` | 30분 | **폐지**(§21 — `personalStatusBundle`로 통합) | 통합 전 마지막 TTL은 30분 |
| `penCycle` | 5분 | **2시간** | 아래 §14.1 참고 — 성격이 달라 별도로 다룬다 |
| 폴링 주기(대시보드) | 15분 | **30분** | `MyStatusContext`/`StatusPage` 둘 다 — 10분 TTL의 정확히 3배 |

새로고침(수동/탭 재방문)은 폴링 주기와 무관하게 즉시 서버에 요청을
보내지만, 그 요청도 여전히 TTL 체크를 거친다 — "즉시 요청"과 "즉시
최신값"은 다르다는 걸 이 대화에서 명확히 정리했다. `personalStatus`를
예외로 남긴 것도 이 때문 — 폴링 주기를 아무리 늘려도, TTL 자체가
길면 "교시 종료 직후 새로고침해도 낡은 값을 본다"는 문제는 그대로
남는다.

### 14.1 `penCycle` — TTL만으로는 해결이 안 되는 경우

`penCycle`(집계!D25, 1~3주차 순환)은 **일주일에 정확히 한 번만
바뀌는 값**인데, 그동안 5분 TTL로 계속 재확인·재기록되고 있었다 —
공유 캐시라 인원수와 무관하게도 하루 최대 144회(24시간×60분÷5분)
수준의 쓰기가 발생하는 구조였다. 문제는 이 값이 앱스크립트
`sheet_reset()`(매주 월요일 5~6시 실행)이 Worker API를 거치지 않고
시트에 직접 쓰는 값이라, `invalidateMemberCache` 같은 기존 무효화
장치가 이 변경을 전혀 알 수 없었다는 것 — 그래서 원래 무효화 그룹
밖에 있었다(§1).

**해결책**: 앱스크립트가 이미 비슷한 용도로 쓰던
`_notifyWorkerCacheInvalidate()`(§7에서 다루는, Worker API를 거치지
않는 시트 직접 쓰기 뒤 Worker에 무효화를 알려주는 헬퍼)를 재사용해,
`sheet_reset()`이 D25를 갱신한 직후 `{groups: ["cycle"]}`로 Worker에
알린다 — `MEMBER_CACHE_GROUPS`에 `penCycle` 전용 `cycle` 그룹을
신설했다. 이제 리셋 직후 곧바로 캐시가 지워지므로, TTL을 **2시간**
으로 크게 늘려도(하루 144회 → 하루 최대 12회 수준) 문제없다.

**TTL을 하루 종일이 아니라 2시간으로 절충한 이유**: 이 값은 제보
승인 시 슬롯에 그대로 기록되므로(`applyOutputPenalty` 등), 알림이
실패했을 때(네트워크 오류 등 — `muteHttpExceptions`로 조용히
넘어가는 best-effort 방식이라 실패해도 앱스크립트 본 작업은 안
막지만, 알림 자체는 재시도가 없다) TTL 자연 만료까지 잘못된
사이클 번호가 슬롯에 찍힐 위험 창이 있다. 이 노출 시간을 2시간으로
제한했다 — 리셋이 새벽 5~6시에 일어나므로, 알림이 실패해도 늦어도
오전 7~8시까지는 정정되고, 실제 서비스가 활발히 쓰이는 시간대엔
이미 안전하다.

**앱스크립트 배포 주의**: `study_sw/assets/appscript.js`는 이
저장소에 있는 "원본 사본"일 뿐, 실제 구글 Apps Script 편집기에
자동 배포되지 않는다 — 이 변경이 실제로 반영되려면 사용자가 직접
Apps Script 편집기에 붙여넣어야 한다.

## 15. 반일 휴무 신청 남용 방지 — 회원당 분당 2회 제한 (2026-09-10)

캐시 정합성을 점검하던 중 "장난으로 반일 휴무를 계속 눌렀다 껐다
하면 쓰기 횟수가 계속 소진되는 거 아니냐"는 지적으로 발견한 문제다.
`handleSetLeaveApply`(일반반휴 신청/취소, `LeaveApplyButton.tsx`)는
신청/취소 둘 다 매번 실제로 값이 바뀌는 조작이라, 프론트의 "직전과
같은 값이면 무시" 방어(`if (nextValue === prevCount) return;`)로는
반복 토글을 막지 못한다 — 게다가 취소하면 반휴 잔여량도 다시
채워져서 잔여량 부족으로 자연히 막히지도 않는다. 토글 1회마다
시트 쓰기 1회(`writeSheetValues`) + KV 삭제 1회
(`invalidatePersonalStatusCache`, `writeSheetValues`가 개인 탭
쓰기를 감지해 자동 호출)가 실제로 발생하므로, 연타하면 KV 예산은
물론 이 프로젝트가 실제로 겪은 적 있는 "시트 API 분당 쓰기 한도"
까지 위협할 수 있다(이건 계정 전체가 공유하는 한도라, 한 사람의
장난이 다른 모든 사용자의 정상적인 작업까지 막을 수 있다).

`checkAndRecordLeaveApplyRate(env, memberNumber)`로 회원 1명당 **1분에
최대 2회**까지만 허용한다 — `leaveApplyRate:{번호}` 키에 `{windowStart,
count}`를 60초 TTL로 저장하는 고정 창(슬라이딩 아님) 방식. 정상
사용(신청 한 번 또는 취소 한 번)은 전혀 걸리지 않고, 한도 초과 시
`429`와 함께 "너무 자주 요청했습니다"를 반환한다 — 프론트는 기존
`ApiError` 처리 경로를 그대로 타므로 별도 프론트 수정 없이 에러
메시지가 그대로 노출된다.

## 16. RANK 탭(`/roster-status`) 캐싱 추가 — 공용 데이터인데 캐시가 하나도 없었음 (2026-09-10)

meritRank(개인 대시보드 순위)의 캐싱 정책을 점검하다가, "여기(RANK 탭)도
캐싱을 적용해야 하지 않냐"는 지적으로 발견했다. `buildRosterStatus`
(대시보드 "RANK" 탭 = `RosterPage.tsx`가 부르는 `/roster-status`)는
`집계!A4:L18`/`집계!D20:D24`+`P6`/`데이터!F4:M4`/`집계!D25`를 요청마다
직접 4회 조회하고 있었다 — 로그인한 회원 15명 전원이 같은 파일의 같은
스냅샷을 보는 순수 공용 데이터인데도, `meritRank`/`reportScore`처럼
`_cachedCompute`로 감싸지 않아 캐시가 전혀 없었다. 이 화면을 열 때마다
쿼터를 그대로 소진하는 구조였다.

**대응**: `rosterStatus:{fileId}` 키로 파일당 하나씩, TTL 30분(meritRank와
동일 기준 — "표시만 지연될 뿐 정합성엔 무해"하다고 이미 §5/이번 세션에서
확인된 것과 같은 성격의 데이터)으로 캐싱했다. `MEMBER_CACHE_UNCONDITIONAL_KEYS`
에 추가해 `roster` 그룹(신규등록/퇴실 등 명단 구조 변경) 발생 시 자동으로
함께 무효화되게 했고, "상금 정산 집행" 마킹(`handleAdminPrizeSettle`,
집계!P6)만 좁게 지우는 `rosterOnly` 그룹을 신설해 그 조작에서도 즉시
무효화하도록 했다 — 이 조작을 읽어서 쓰는 로직(`buildRosterStatus`의
`settlementSettled`)이 이미 있는데도 "무효화 불필요"라고 적힌 낡은 주석이
있었다(buildRosterStatus 도입 당시 갱신을 놓친 것으로 추정).

**정정한 버그**: `handleRosterStatus`가 `buildRosterStatus`의 반환 객체를
그대로 받아 `Object.assign(roster, weekRange)`/`delete roster.depositOuter`/
`delete roster.settlement`로 **직접 변형**하고 있었다 — 캐싱 전에는 매
요청마다 새로 만들어진 객체라 무해했지만, 캐싱 후에는 이 객체가 여러
요청·isolate에 걸쳐 재사용되는 캐시 원본이라 그대로 두면 심각한 정보
노출/은닉 버그가 됐다. 예: 정산 비공개 시각에 조회한 일반 회원의
`delete roster.settlement`가 캐시 원본에 반영되면, 그 직후 공개 시각이
지나 조회한 관리자·스터디장도 캐시 만료(최대 30분) 전까지 정산 정보를
못 보게 된다. 반대로 `depositOuterIncluded`가 아닌데도 먼저 조회한
관리자 응답이 캐시에 남으면 이후 일반 회원에게 `depositOuter`(스터디장
개인 페널티 정보)가 새 나갈 수도 있었다. `buildRosterStatus` 결과를
얕은 복사(`{ ...cached }`)한 뒤에만 이후 변형을 적용하도록 고쳤다.

**뒤이은 통합**: "MY 탭과 RANK 탭 순위를 같이 가져오는 걸로 해도 되지
않냐"는 지적으로 `meritRank:` 캐시(`getMeritRank`, MY 탭의 개인 순위)를
다시 보니, 읽던 범위(`집계!B4:F18`)가 `rosterStatus:`가 읽는
`집계!A4:L18`의 완전한 부분집합이었다 — 두 캐시가 같은 파일의 같은
상점/순위 데이터를 중복 저장·중복 조회하고 있었던 것. `getMeritRank`가
`buildRosterStatus`를 그대로 호출해 `members` 배열에서 해당 회원을 찾는
방식으로 통합하고, `meritRank:` 캐시 키는 폐지했다. 두 캐시의 무효화
그룹이 이미 동일(`roster` 그룹에만 자동 포함, `penalty` 그룹에서는
의도적으로 제외)했기 때문에 합쳐도 정합성 차이가 없다.

> 🔧 **[TTL 하향, 2026-09-11]** RANK 탭 폴링(30분)과 이 30분 TTL이 같아
> "폴링:TTL = 1:1"이 되어 §12.1의 "폴링은 TTL의 3배 이상" 원칙을 유일하게
> 못 지키고 있었다(§12.2에서 개선 여지로 남겨둔 항목). `rosterStatus:`가
> 파일당 1개 키(회원 수와 무관)라 TTL을 낮춰도 KV 쓰기 증가가 작다는 점을
> 근거로 10분으로 낮췄다 — 폴링:TTL = 3:1로 원칙을 충족한다(§3에 반영).

## 17. 과거 fileId(백업 사이클) TTL 상향 — 2시간 (2026-09-10)

"MY 탭에서 과거 주차를 여러 번 토글하면 10~30분 TTL이 반복 만료돼 그때마다
재계산·KV 재기입이 일어나는 게 낭비 아니냐"는 지적으로 시작됐다.
`personalStatus:{fileId}:{번호}`(개인 탭 원본, 10분)와 `rosterStatus:{fileId}`
(순위·상점·정산, 30분) 둘 다 이 문제를 갖고 있었다 — 과거(백업) fileId는
관리자가 이 Worker의 API로 명시적으로 처리하지 않는 한 원본 값이 절대
바뀌지 않는데도, 현재 시트와 동일한 짧은 TTL을 쓰고 있었다.

**전제 확인**: 과거 fileId에 실제로 쓰기가 일어나는 경로는 세 곳뿐이다 —
벌금 납부(`handleAdminFineStatus`), 상금 정산 집행(`handleAdminPrizeSettle`),
퇴실 확정(`handleAdminExitConfirm`, 백업탭 생성 시 `backupTargetFileId`에
탭 추가/삭제). 앞의 둘은 이미 `writeSheetValues`/`invalidateMemberCache`에
그 `fileId`를 정확히 넘겨 즉시 무효화하고 있었다. 퇴실 확정은 과거
fileId에 쓰기는 하지만, 그 대상이 회원 번호 탭이 아니라 별도 이름의
백업 탭("{이름} (퇴실)")이고 "집계" 탭도 건드리지 않아 —
`personalStatus:`(`{번호}!A1:U...`만 읽음)·`rosterStatus:`(`집계!...`만
읽음) 어느 캐시에도 영향이 없다. 즉 세 경로 모두 TTL을 늘려도 "관리자가
방금 처리한 값이 안 보이는" 문제가 생기지 않는다(사용자 확인: "관리자가
쓰기 작업을 해서 과거 시트 값이 갱신되면 캐시가 바로 무효화되는 게
맞다").

도움봇(`study_sw/bot/`)의 무효화 안 되는 직접 쓰기 경로(§7)도 항상
`env.GOOGLE_SHEET_FILE_ID`(현재 시트)에만 있다 — 과거 백업 파일에는
도움봇도 절대 쓰지 않으므로, 짧은 TTL을 유지해야 할 이유가 과거 fileId
에는 원래 없었다.

**대응**: 두 캐시 모두 `fileId === env.GOOGLE_SHEET_FILE_ID`로 분기해,
현재 시트는 기존 TTL(10분/30분)을 유지하고 과거 fileId는 **2시간**으로
늘렸다. 무효화 인프라는 이미 fileId 단위로 정확히 동작하므로 추가 구현
없이 TTL 숫자만 바꿨다.

**§17.1 확장 — `members:` (2026-09-10, 같은 날 후속)**: "내 대시보드"
드롭다운("다른 회원 보기")이 쓰는 `listAllMembers`도 같은 문제를 갖고
있었다 — 10분 TTL이 현재/과거 fileId 구분 없이 적용됐다. "신규 회원
등록이나 퇴실 발생 시 캐시가 무효화되는 게 맞냐"는 확인 질문에 실제
호출부 5곳(`handleAdminCreateMember`/`handleAdminExitConfirm`/
`performExitReset`/`performDepositAgainReset`/
`handleAdminMemberReorderPreview`)을 전수조사한 결과, 전부 이미
`invalidateMemberCache(env, ["roster"])`를 호출하고 있었다 — `members`가
`MEMBER_CACHE_UNCONDITIONAL_KEYS`에 속해 `roster` 그룹에 자동 포함되기
때문에 별도 구현이 필요 없었다. 이 5곳은 전부 `fileId` 인자 없이
호출해(기본값 = 현재 시트) 항상 현재 시트만 무효화한다 — 신규등록·퇴실은
애초에 항상 현재 시트에서만 일어나는 조작이라 이게 맞다. 즉 과거
fileId의 회원 명단은 애초에 무효화될 이유가 없는 불변 데이터이므로,
같은 원칙(`fileId === env.GOOGLE_SHEET_FILE_ID` 분기)으로 과거 fileId만
2시간으로 늘렸다.

이 드롭다운 목록은 **자동 폴링의 영향을 받지 않는다** —
`StatusPage`의 `usePollingRefresh`(30분)/`useRefreshOnVisible`은 선택된
회원의 `/status`(또는 `/admin/members/:number`)를 재조회하는
`reload()`에만 걸려 있고, `/admin/members`(목록 자체)를 부르는 로직은
`[isAdmin, isViewingCycle, cycleFileId]`가 바뀔 때(최초 마운트, 사이클
전환)만 독립적으로 실행된다.

**후속 대응(같은 날, 2026-09-10)**: "대시보드를 오래 띄워둔 채 신규
회원이 등록돼도 반영이 안 된다"는 한계를 "드롭다운을 클릭할 때마다
새로고침되게 할 수 있냐"는 요청으로 해소했다. 목록 조회 로직을
`loadMembers()`로 분리하고, `Select`의 `onOpenChange`가 열릴 때(open
===true)마다 이를 호출하도록 추가했다 — `ReportPage`의 참여자 선택
드롭다운이 이미 쓰던 동일한 관용구(같은 파일, 349번 줄 근처)를 그대로
재사용한 것이라 새로운 패턴은 아니다.

**§17.1 재정정 — `adminMemberList:` 별도 캐시 분리 (같은 날, 두 번째
후속)**: "현재 시트도 어차피 자주 안 바뀌니 2시간으로 걸고 싶다"는
요청이 다시 들어왔다. 하지만 `listAllMembers`(`members:`)는 이
드롭다운 하나만 쓰는 게 아니라 **20곳 이상**이 공유하는 원본 함수다 —
그중 `snapshotNextOccurrence`(제보 이름→회원번호 매칭)나
`listExitCandidates`(퇴실 후보 판정)처럼 "무효화가 어쩌다 한 번
놓쳤을 때 얼마나 오래 낡은 값을 쓰게 되는지"가 정확성에 직결되는
곳들도 같은 캐시를 쓴다. `listAllMembers` 자체의 TTL을 2시간으로
올리면 드롭다운뿐 아니라 이 20여 곳의 안전망도 함께 12배(10분→2시간)
늘어나므로, 대신 `handleAdminMembers`의 **최종 응답**(members+
exitedMembers 조합)을 `listAllMembers`와는 별개의 바깥 캐시 키
`adminMemberList:{fileId}`로 한 번 더 감쌌다. `roster`
그룹(`MEMBER_CACHE_UNCONDITIONAL_KEYS`)에 이 prefix를 추가해, 신규
등록·퇴실이 발생하면 2시간을 기다리지 않고 그 즉시 무효화된다.
`onOpenChange` 재조회(위 후속 대응)와 합쳐지면 "평소엔 2시간 캐시로
아끼고, 실제로 명단이 바뀌면 다음 클릭에 바로 최신값"이 정확히
드롭다운에만 적용되고, 이름 매칭·퇴실 판정 등 정확성이 중요한 다른
호출부의 안전망은 그대로 유지된다.

**§17.1 재재정정 — `members:` 과거 fileId 분기 원복 (같은 날, 세 번째
후속)**: 위 두 번째 후속에서 `listAllMembers` 자체는 "그대로(현재
10분/과거 2시간)" 둔다고 적었는데, 이 과거 2시간 분기는 §17에서
먼저 걸어둔 것이었다 — "과거도 10분으로 돌려놔, 드롭다운에 대해서만
2시간 정책을 과거·현재 모두 적용하도록 해"라는 명시적 지시로
`listAllMembers`의 `fileId === env.GOOGLE_SHEET_FILE_ID` 분기를
제거했다. 이제 `members:`는 현재/과거 구분 없이 **항상 10분**이고,
드롭다운의 "과거/현재 모두 2시간"은 오직 `adminMemberList:`(바깥
캐시, 위 문단)로만 구현된다 — 두 캐시의 책임이 완전히 분리됐다:
`members:`(원본, 20여 곳 공유, 정확성 우선 10분 고정) /
`adminMemberList:`(드롭다운 전용, 실시간성 불필요, 2시간 고정).

**§17.2 — `members:` 2시간 재상향 + 결정적 경로(승인) 방어 (2026-09-11)**:
위 "재재정정"에서 `members:`를 10분 고정으로 되돌린 핵심 이유는 "무효화가
어쩌다 놓쳤을 때 `applyOutputPenalty`/`applyReportMerit`(제보 승인/제보상점
지급 — 닉네임·이메일을 번호로 확정해 그 번호 슬롯에 실제로 벌점/상점을
써넣는 결정적 순간)가 번호 재사용 시 엉뚱한 회원에게 잘못 기록할 위험"
이었다. 이번엔 그 위험 자체를 없애는 방식으로 접근했다 — TTL을 길게
유지해도 안전하도록, **그 두 함수가 `listAllMembers`를 호출하기 직전에
좁은 그룹(`memberIdentity: ["members", "dataSheetRows"]`, 신설)만 무효화**
해서 "지금 명단이 실제로 바뀌었는지와 무관하게, 벌점을 쓰는 순간엔 항상
방금 확인한 최신값을 쓴다"고 강제한다. `dataSheetRows`도 함께 지우는 이유는
`members:`가 그 원본에서 파생되는 값이라, `dataSheetRows`가 여전히
캐시돼 있으면 "새로 계산은 하지만 재료는 낡은" 상태가 되기 때문이다.
기존 `roster` 그룹(9개 키 전체)을 쓰지 않고 이 둘만 지우는 좁은 그룹을
새로 만든 이유는, 벌점 승인 하나 때문에 상관없는 벌금·순위 캐시까지
매번 지울 이유가 없어서다.

이 방어가 생기면서 "무효화를 못 믿어서 TTL을 짧게 유지"할 이유가
없어져, `members:` 자체도 `dataSheetRows:`/`adminMemberList:`와 같은
선상에서 **2시간**으로 올렸다(현재/과거 fileId 공통, 분기 없음 — §17.1
재재정정과 동일하게 유지). 하루 제보 승인 건수가 10건 미만임을
확인했고(사용자 제시), 이 좁은 무효화가 추가하는 KV 쓰기/삭제(승인당
최대 4건 — `members`/`dataSheetRows` 삭제 2건 + 재계산 시 재기입 2건)는
그 빈도에서 무시할 수준이다. `adminMemberList:`(드롭다운 전용 바깥
캐시)는 이제 존재 이유가 옅어졌지만 이미 분리돼 있어 그대로 둔다 —
제거할 이유도 없다.

**§17.3 — `MemberRosterList` 폴링 배율 원칙 충족 (2026-09-11)**: §12.2에서
"참여 스터디원 목록"의 폴링(15분) 대 `dataSheetRows:` TTL(10분) 배율이
1.5배로 원칙(3배 이상)에 못 미친다고 개선 여지로 남겨뒀던 것을 여기서
해결했다. `meta:`를 5분→10분으로 올리고(§17 문단, 위 표에 반영) 폴링도
15분→30분으로 늘려, `dataSheetRows:`/`meta:` 둘 다 정확히 3배가 되도록
맞췄다 — `members:`는 §17.2로 이미 2시간이라 이 화면의 병목이 아니다.
`meta:`를 10분으로 올려도 신선도 손실이 사실상 없는 이유는 §5에서 이미
확인한 대로다: 이 화면(유일한 정기 폴링 소비처)의 폴링 간격이 옛 TTL(5분)
보다도 이미 훨씬 길어, TTL이 아니라 폴링 빈도 자체가 쓰기 횟수의
병목이었기 때문이다.

"내 화각 불량 제보" 화면의 캐싱 정책을 점검하다가 발견했다. 이 화면이
3분마다 폴링하는 `handleMyOutputPen`이 본인 회원번호·이름을 알아내는 데
`findMemberNumberByEmail`을 쓰고 있었는데, 이 함수는 `_cachedCompute`를
전혀 거치지 않고 매번 `데이터!A1:V50`을 직접 읽는다 — 그런데 이 범위는
`listAllMembers`(`members:`, 10분 캐시)가 이미 캐싱해둔 것과 정확히
동일하다. 로그인한 사람이 본인 번호를 찾는 대부분의 경로는
`resolveMemberNumber`(세션에 이미 있는 `memberNumber`를 즉시 반환, 캐시
필요 없음)를 쓰는데, 이 화면은 그 경로를 안 타고 매번 시트를 다시
읽고 있었다.

**대응**: `handleMyOutputPen`과 응답 제출 경로인
`handleCaptureTargetRespond` 둘 다 `findMemberNumberByEmail` 대신
`listAllMembers`에서 `session.email`로 찾도록 바꿨다 — 3분 폴링마다
반복되던 불필요한 시트 읽기를 없애고, 이미 캐싱된 회원 명단을
재사용한다. `findMemberNumberByEmail` 자체는 그대로 남아있다(로그인
직후처럼 세션에 아직 번호가 없는 극히 드문 폴백 경로에서는 여전히
필요).

이 점검 과정에서 "내 화각 불량 제보"의 핵심 데이터(`/my-captures`,
`/my-output-pen`)는 로컬 도움봇으로 매번 실시간 프록시되는 구조라
캐싱 대상이 아니라는 것도 함께 확인했다 — 90분 응답 시한이 걸린
민감한 상태라 캐싱하면 오히려 정확성을 해친다.

**§18.1 일시 원복 후 재적용 — 이름 변경 시나리오는 실재하지 않음 (같은
날 후속)**: "이 캐싱이 정합성·사용성을 해칠 여지가 없는지 점검해달라"는
요청으로 다시 들여다보다가, `handleCaptureTargetRespond`가 본인 확인을
`item.nickname === member.name`(이름 문자열 비교)으로 한다는 걸 발견
했다 — 회원 이름이 방금 바뀌었다면 캐시가 최대 10분간 옛 이름을
돌려줘, 정작 본인이 대상자인 제보에 "본인이 대상자인 제보에만 응답할
수 있습니다"로 부당하게 거부될 수 있다고 판단해, 이 함수만
`findMemberNumberByEmail`(캐시 없음)로 먼저 되돌렸다. 그런데 사용자가
"이름을 변경할 일 자체가 없는데?"라고 반문해 실제로 "데이터" 시트
이름(C열)을 바꾸는 API가 이 프로젝트에 있는지 코드 전체를 다시 뒤져본
결과 — **그런 API는 어디에도 없었다.** 이름은 신규 등록
(`handleAdminCreateMember`) 시점에 한 번 정해지면 이후 Worker의 어떤
경로로도 바뀌지 않는다(시트를 관리자가 직접 열어 수동 편집하는 경우만
예외인데, 이건 캐싱 정책으로 막을 수 있는 범주가 아니다). 즉 되돌렸던
우려는 실재하지 않는 시나리오에 대한 과잉 대응이었다 — 사용자 확인
후 `handleCaptureTargetRespond`도 다시 `listAllMembers`(캐시) 재사용
으로 되돌렸다. 이 경험에서 남길 점: 캐싱이 "정합성을 깰 수 있는" 경로를
점검할 때는 그 변경 자체(이름 변경)가 시스템에 실제로 존재하는 경로
인지부터 먼저 확인해야 한다 — 코드상 이론적으로 가능해 보이는 값 불일치
라도, 그 값을 바꾸는 쓰기 경로 자체가 없다면 걱정할 이유가 없다.

## 19. 관리자 리스트 7곳 — 재조회 시 스켈레톤/빈 상태가 둘 다 안 뜨는 순간 (2026-09-10)

캐싱 자체가 아니라 **프론트가 캐시/폴링 응답을 그리는 방식**의 문제였지만,
KV 예산 논의(관리자 리스트가 3분 폴링으로 재조회를 반복한다는 맥락)에서
발견됐다. "PEN·Money" 탭 "사유 반휴 신청 처리"가 탭을 벗어났다 돌아올 때
(`useRefreshOnVisible` 재조회) "검토 대기 중인 신청이 없습니다" 문구 전에
영역이 잠깐 줄었다가 늘어난다는 지적.

**원인**: 세 렌더 조건(스켈레톤 / 빈 상태 / 목록)이 전부 `loading`에
게이팅돼 있었다. 재조회가 시작되는 순간 `loading=true`인데 `items`는 이미
빈 배열(`[]`)이라 — `loading && !items`(스켈레톤)도 `!loading && ...`(빈
상태)도 `items.length > 0`(목록)도 전부 거짓이 되어, 헤더만 남고 본문이
완전히 빈 순간이 **약 1초간** 지속됐다(Playwright로 실측 — 88px 높이 구간).
첫 수정 시도(스켈레톤 조건을 넓혀 `loading && (!items || length===0)`)는
공백은 없앴지만, 응답이 1초 내외로 빨라 "빈 상태(~142px) → 스켈레톤
(~306px) → 빈 상태"라는 더 큰 낙차만 만들었다(재실측으로 확인).

**최종 수정**: `loading`을 조건에서 완전히 제거하고 `items`(실제 데이터)의
존재 여부만으로 무엇을 보여줄지 정하도록 바꿨다 — 재조회 중엔 이전 렌더링
(빈 상태 메시지든 기존 목록이든)이 그대로 유지돼 화면이 흔들리지 않는다.
"로딩 중" 표시는 `SectionHeader`의 `loading` prop(새로고침 아이콘 회전)만
으로 충분하다. 적용 대상: 관리자 리스트 7곳(제보 검토 / 참여·퇴실 스터디원
목록 / 정산·벌금 / 페널티 대상자 / 사유반휴 검토). 빈 상태 문구도 공용
`AdminEmptyState`(InfoCard + `py-8`)로 감싸 스켈레톤과의 높이 차이를 줄였다.

## 20. 관리자 "Account" 탭 — "데이터" 시트 원본 조회를 `dataSheetRows:`로 통합 (2026-09-10)

"Account" 탭의 캐싱 정책을 점검하다가, 세 곳이 각자 캐시 없이 정확히
같은 범위(`데이터!A1:V50`, 전체 회원 명단 원본)를 읽고 있는 걸 발견했다:

- `listAllMembers`(`members:` 캐시, 원래 이 범위를 캐싱하고 있었음)
- `handleAdminMembersRoster`("참여 스터디원 목록" 상세 패널의 구루미
  계정·준비 중인 시험 — `listAllMembers`가 이 D~E열을 버리고 계산해서
  캐시를 재사용 못 하고 원본을 다시 읽었다)
- `handleAdminOpenSlots`("신규 스터디원 등록"의 빈 번호 드롭다운 —
  `listAllMembers`가 "이메일 있는 유효 회원"만 걸러 담아, 반대로 "이메일이
  비어있는 행"을 찾는 이 화면은 캐시를 못 썼다)

**대응**: 원본 로우 배열 자체를 `dataSheetRows:{fileId}` 키로 캐싱하는
`getDataSheetRows`를 신설하고, `listAllMembers`가 내부에서 이를 재사용하도록
바꿨다(`listAllMembers`의 반환 형태는 그대로 유지 — 26곳 호출부 영향 없음).
`handleAdminMembersRoster`·`handleAdminOpenSlots`도 직접 `getSheetValues`
호출을 `getDataSheetRows`로 교체. TTL은 `members:`와 동일한 10분,
무효화는 `MEMBER_CACHE_PREFIXES`·`MEMBER_CACHE_UNCONDITIONAL_KEYS` 양쪽에
`dataSheetRows` 등록해 `roster` 그룹(신규등록/퇴실/번호이동)이 자동으로
함께 지운다. 순수 로직 시뮬레이션으로 (1) 캐시 재사용, (2) 무효화 시 정확히
삭제, (3) 무효화 후 최신값 재조회를 검증했다.

`handleAdminCreateMember`의 등록 직전 최종 검증(번호가 진짜 비어있는지
재확인)은 "동시 등록 방지 안전장치" 성격이라 이번 통합 범위에서 제외했다.
`computeMemberReorderPlan`("Bot·Sheet" 탭 "번호 정렬")도 같은 범위를 읽지만
버튼 클릭 시에만 호출되고 폴링이 없어 저빈도라 그대로 뒀다(개선 여지로 남김).

## 21. 내 대시보드 개인 데이터를 `personalStatusBundle:` 하나로 통합 (2026-09-10)

15명 기준 하루 KV 쓰기의 대부분(코드로 직접 계산: 평균 시나리오에서
약 88%)이 "회원별 캐시" 3종에서 나왔다:

- `personalStatus:{fileId}:{번호}`(개인 탭 `A1:U42` 원본, 10분/현재)
- `outputPenSlots:{fileId}:{번호}`(송출 P 시트 `F~M` 슬롯, 10분)
- `reportScore:{fileId}:{reportRow}`(데이터 시트 `R~V` 제보상점 슬롯, 30분)

셋 다 **오직 `buildPersonalStatus` 안에서만, 항상 함께** 조회된다 — 다른
화면이 셋 중 하나만 독립적으로 부르는 경우가 코드 전체에 없었다. 그런데
각자 별도 KV 키·별도 TTL이라, `/status` 폴링(30분)마다 회원 1명당 KV put이
3번씩 발생했다.

**대응**: `getPersonalStatusBundle(env, at, fileId, 번호)` 하나로 묶어
`{ rows, outputPenSlots, reportScore }`를 한 캐시 키(`personalStatusBundle:`)에
저장한다. `reportRow`(제보상점 조회에 필요한 행 번호)가 개인 탭 42행(C42)
값이라 원래도 개인 탭을 먼저 읽어야 알 수 있는 순차 의존 관계였으므로,
병렬로 쪼개져 있던 걸 오히려 자연스럽게 합칠 수 있었다. `getReportScore`/
`getOutputPenSlots`는 캐시를 벗긴 `_computeReportScore`/`_computeOutputPenSlots`
헬퍼로 남겨 내부 로직을 그대로 재사용한다.

- **TTL**: `personalStatus`가 쓰던 분기(현재 10분 / 과거 2시간)를 그대로.
  "과거 fileId는 절대 안 바뀐다"(§17)는 근거가 세 데이터에 동일하게 적용된다.
- **무효화 세밀도 트레이드오프**: 지금은 셋이 서로 다른 이유로 독립적으로
  지워졌는데(개인 탭 쓰기 ↔ 제보 처리), 합치면 어느 한쪽이 바뀌어도 셋 다
  같이 재계산된다. 정합성은 오히려 더 보수적(교차 오염 없음)이고, 추가로
  생기는 재조회는 30분 폴링 주기 안에서 일어나는 일이라 무시할 수준
  (사용자 확인 후 진행).
- `MEMBER_CACHE_GROUPS.penalty`에서 `outputPenSlots`/`reportScore`가 빠지고
  `["exitStatus", "penSlotGrid"]`만 남았다 — 제보 처리 호출부는 이미 전부
  `invalidateMemberSlotCache(env, 대상자·제보자 번호)`를 함께 호출하고,
  이 함수가 이제 `personalStatusBundle:` 키 하나만 지운다.
- `roster` 그룹은 `[...MEMBER_CACHE_UNCONDITIONAL_KEYS]`로 단순화됐다
  (`reportScore`/`outputPenSlots` 명시 항목 제거 — 회원별 키라 어차피
  `invalidateMemberSlotCache`가 담당).

**절감 추정**(순수 계산, 문서화된 실측 아님): 평균 사용 시나리오(15명이
활동시간의 절반쯤 앱을 켜둠) 기준 하루 KV 쓰기·삭제 약 853회 → 약 353회
(약 59% 감소). 절감의 96%가 put 쪽(`/status` 폴링 1회당 3키 → 1키).

## 22. "송출 P 대상 처리" 부스터디장 목록 캐싱 — `coReviewers:` (2026-09-10)

"PEN·Money" 탭 "송출 P 대상 처리"가 3분마다 자동 새로고침되는데, 그때마다
서버가 "지금 부스터디장으로 임명된 사람이 누구인지"를 확인하려고
`getCurrentCoReviewers`를 캐시 없이 호출했다 — `listAllMembers`(캐시됨)까지는
재사용하지만, 그 뒤 `batchGetSheetValues`로 회원 15명의 L3(참여상태) 셀을
매번 새로 읽었다. 부스터디장 임명은 아주 가끔만 바뀌는 값인데도.

**대응**:
- `getCurrentCoReviewers`를 `_cachedCompute(env, coReviewers:{fileId}, 5분, ...)`로
  감쌌다 — `meta:`(스프레드시트 구조, 같은 성격의 저빈도 값)와 동일한 TTL.
- `MEMBER_CACHE_PREFIXES`·`MEMBER_CACHE_UNCONDITIONAL_KEYS`에 `coReviewers`
  등록하고, `MEMBER_CACHE_GROUPS.partiStatus`를 `["exitStatus"]` →
  `["exitStatus", "coReviewers"]`로 확장 — 부스터디장 임명/해제
  (`handleAdminSetPartiStatus`, 개인 탭 L3 쓰기)가 즉시 무효화한다.
- 이 화면의 폴링 주기도 3분 → **10분**으로 하향(§12.2) — `coReviewers:`
  5분 TTL의 2배. `penSlotGrid:`(60초 TTL)의 절감 효과는 여전히 유지된다.

순수 로직 시뮬레이션으로 캐시 재사용·무효화 정확성·재조회 최신성을 검증했다.

## 23. Cloudflare 모니터링 — KV `list()` 사용 횟수 별도 게이지 (2026-09-10)

"Bot·Sheet" 탭 "사용량 모니터링"의 Cloudflare 게이지("KV 읽기" 항목)는
`kvOperationsAdaptiveGroups`의 `actionType`이 `read`·`list` 둘을 **합산**해
보여주고 있었다 — `list()`가 몇 번인지 따로 알 수 없었다. `list()`는
read 한도(하루 10만)와 **별개로 하루 1,000회**라는 훨씬 빡빡한 자체
한도를 쓰고, 2026-08-27에 실제로 소진돼 `/admin/members/roster`가 500을
낸 이력이 있다(그 이후 `leaveq:`/`report:` 등을 "전역 인덱스 키 + get 1회"
방식으로 리팩터링한 계기).

**대응**: `fetchCloudflareUsage`가 `actionType === "list"`만 따로 합산해
`kvListsToday`로 반환하고, `limits.kvListsPerDay = 1_000`을 추가. 프론트
`AdminBotSheetTab`에 "KV 목록조회(list)" 게이지를 "KV 쓰기·삭제" 아래에
추가했다. `UsageBar`는 `used`/`limit`이 `undefined`(배포 직후 옛 워커
응답이 잠깐 섞이는 경우)일 때 0으로 방어하도록 함께 고쳤다 — 원래는
`undefined.toLocaleString()`에서 화면 전체가 죽었다(Sentry ErrorBoundary
"문제가 발생했습니다"로 재현·확인).

이 게이지는 §13의 "최근 30분 KV 쓰기·삭제·목록조회 — 화면별" breakdown
표(`instrumentKvNamespace`가 `kv_list`도 계측)와 함께 본다 — 게이지는
"오늘 하루 총합·한도 대비 위험 수준", breakdown은 "어느 화면이 list를
쓰는지".

## 24. PUSH 알림 — `list()` 완전 제거 + 쿨다운/최근목록의 KV→DO 이전 (2026-09-11)

"제보" 메뉴 KV 정책을 전수조사하다가, "PUSH 알림 전송" 탭이 제보/설정 관련
화면 중 유일하게 `list()`를 쓰는 곳으로 확인됐다(건당 발송 1회 + 탭 진입 시
1회). 회원별 기기 수가 적어 당장 위험한 수준은 아니었지만, 두 가지를 함께
정리했다.

### 24.1 `subIndex:{이메일}` — 회원별 기기 인덱스로 `list()` 제거

`PUSH_SUBS_KV`의 키 구조가 `sub:{이메일}:{기기해시}`라 "이 회원 기기가 뭐가
있나"를 알려면 원래 `list({prefix: sub:{이메일}:})`가 필요했다. 이 패턴을
쓰던 곳이 6곳이나 됐다: `handleListPushDevices`(설정 "알림 받는 기기"),
`handlePushSendToMember`(제보 "PUSH 알림 전송"), `handlePushSendTest`(관리자
테스트), `handleAdminPushSendCategory`(관리자 카테고리별 테스트),
`handlePushSubscriptionStatus`(제보, 전 회원 배치 조회),
`handleAdminMembersRoster`(관리자 "참여 스터디원 목록", 전 회원 배치 조회
— 이건 제보가 아니라 관리자 화면인데도 같은 문제를 겪고 있어서 함께
고쳤다).

**설계**: `subIndex:{이메일}` 키 하나에 그 회원 기기 배열
(`{id, deviceLabel, enabled, savedAt}[]`)을 담아, `GET /push/devices`가
필요로 하는 필드를 그대로 응답할 수 있게 했다(기기별 `get()`도 불필요).
기기를 바꾸는 4곳(`/push/subscribe`·`/push/devices/toggle`·`/rename`·
`/remove`)에서 `sub:` 값을 쓸 때 이 인덱스도 함께 갱신한다.

**마이그레이션**: 배포 전 이미 등록된 구독은 인덱스가 없다 —
`getPushDeviceIndex(env, email)`이 인덱스 부재 시 그 회원에 한해 딱 한 번
`list()`로 자체 복구(인덱스를 새로 만들어 저장)한다. 이후 그 회원에 대해
다시는 `list()`가 필요 없다 — 별도 백필 스크립트 없이 회원이 아무 push
화면이나 처음 건드리는 순간 자연스럽게 전환된다. `leaveq:` 인덱스 전환
(§18 근처) 때는 "마침 큐가 비어 있어서" 백필이 필요 없었는데, 이번엔 실제
구독이 이미 존재해 이 자체 복구 경로가 꼭 필요했다.

**전 회원 배치 조회 2곳**(`handlePushSubscriptionStatus`,
`handleAdminMembersRoster`)은 `list()` 1회가 회원 수만큼(최대 15회)
`get()`으로 바뀐다 — 읽기는 하루 10만 회로 여유가 커 문제없다.

### 24.2 알림 쿨다운·"최근 전송된 알림" — KV 대신 `ParticipantsRoster` DO

전송 1건당 KV 쓰기 2건(`notice-cooldown:{nickname}` put +
`_appendToLiveIndex(NOTICE_INDEX_KEY)`)이 있었다 — 빈도가 낮아 예산상
급하진 않았지만, "KV 없이 아예 안 쓰고 처리할 수 있냐"는 질문에 "KV
자체를 안 쓰는 건 구조적으로 안 되지만(요청 간 공유 상태가 필요하므로),
**KV가 아닌 Durable Object**로 옮기면 쓰기 자체가 한도 밖으로 빠진다"는
결론으로 이어졌다 — `/participants`(§3.1, `docs/WEB_REPORT.md`)가 이미
"몇 초 간격 갱신은 KV 부적합, DO가 적합"이라는 같은 논리로 DO를 쓰고
있던 선례를 그대로 재사용했다.

**구현**: 새 DO 클래스를 만들지 않고 기존 `ParticipantsRoster`(이미
`withMemberLock`의 락 저장소로도 겸용되던 다목적 싱글턴)에 `this.notices`
배열과 세 라우트(`POST /notice/check`, `POST /notice/record`,
`GET /notice/list`)를 추가했다. KV의 `_appendToLiveIndex`가 필요로 했던
CAS 재시도(get→put 사이 경합 방어)가 DO 안에서는 아예 필요 없다 — 단일
인스턴스가 요청을 이미 직렬 처리하므로 두 요청이 동시에 배열을 건드릴
수가 없다.

- `checkNoticeCooldown(env, nickname)` — 관리자가 아닐 때만 호출, 만료된
  항목을 걸러낸 뒤 그 닉네임이 남아있는지 확인.
- `recordNotice(env, entry, cooldownSec)` — 발송 성공 후 호출, 만료 항목을
  걸러낸 뒤 새 항목 추가(쿨다운 판정과 "최근 전송된 알림" 표시를 겸함).
- `listRecentNotices(env)` — `GET /push/recent-notices`가 그대로 반환.

`NOTICE_COOLDOWN_SEC`(10분)는 그대로 유지하되 `NOTICE_INDEX_KEY`/
`notice-cooldown:` 키는 완전히 폐지됐다. 처음엔 "진행 중인 제보"
(`COOLDOWN_INDEX_KEY`)는 봇의 `/reports/capture-done` 콜백과 얽혀 있어
건드리지 않고 후보로만 남겨뒀는데, 아래 §24.4에서 마저 옮겼다.

### 24.3 DO 전환 대상 판단 기준 — 뭐든 다 옮기면 안 되는 이유

"KV 쓰기 한도와 관련된 부분은 전부 DO로 바꿔도 되냐"는 질문에 확인한
결과, 아니다. DO(순수 메모리, `state.storage` 미사용)가 맞는 경우와
안 맞는 경우가 명확히 갈린다.

- **✅ 맞는 경우 — "지금 이 순간의 공유 상태", 없어져도 그만인 데이터**:
  `/participants`(실시간 접속 명단), 알림 쿨다운/최근 목록(§24.2), 진행
  중인 제보(§24.4) — 셋 다 여러 사용자가 동시에 보는 짧은 수명의 상태이고,
  DO가 재시작되면 그냥 빈 상태로 다시 시작하면 된다.
- **❌ 안 맞는 경우 — 영구 보관이 필요한 대기열/기록**: `report:{id}`
  (봇이 못 가져간 제보를 나중에 재시도로 집어가야 하는 안전망 큐),
  `leaveq:`(봇 오프라인 동안 몇 시간을 버텨야 하는 사유반휴 대기열),
  `lastLogin:`(영구 이력) — DO 메모리는 재배포·유휴 시 초기화되므로,
  이런 "사라지면 안 되는" 데이터를 여기 두면 오히려 유실 위험을 새로
  만든다.
- **❌ 안 맞는 경우 — 시트를 캐싱한 `_cachedCompute` 결과 전체**
  (`personalStatusBundle:`/`rosterStatus:`/`members:` 등 12종): DO는
  "전 세계에 단 하나"라 요청이 전부 그 인스턴스로 몰려 직렬(한 줄로) 처리된다
  — 15명이 각자 다른 데이터를 동시에 요청해도 서로 무관한데 한 줄로 서서
  기다리게 되는 셈이라, 원래 KV(분산·복제돼 병렬 응답 가능)가 담당하던
  "여러 사람이 동시에 빠르게 읽는" 역할엔 오히려 병목이 된다. 이 캐시들은
  이미 이번 세션에서 TTL을 조정해 예산 안에 들어와 있어 구조를 바꿀 급한
  이유도 없다.

### 24.4 "진행 중인 제보"도 DO로 — 남은 마지막 KV 라이브 인덱스 (2026-09-11)

§24.3의 기준에 따라 "진행 중인 제보"(`ActiveReportsSection`, 15초 폴링)도
DO로 옮겼다 — 알림과 완전히 같은 패턴이다. 같은 `ParticipantsRoster`에
`this.reportCooldowns` 배열과 네 라우트를 추가했다:

- `checkReportCooldown(env, cooldownKey)` — `handleReport`의 429 판정.
  `cooldownKey`는 KV 시절과 동일한 문자열(`cooldown:{닉네임}` 또는
  `selfcheck-cooldown:{이메일}`)을 그대로 재사용해 두 종류가 안 섞이게 한다.
- `recordReportCooldown(env, entry, cooldownSec)` — 제보 접수 시 기록.
- `markReportCaptureDone(env, id, capturedAt)` — 봇의 캡처 완료 콜백
  (`/reports/capture-done`)이 호출, 캡처 완료 시점부터 쿨다운을 재시작한다.
- `listReportCooldowns(env)` — "진행 중인 제보" 표시용.

**KV 시절보다 구조가 단순해졌다**: 원래는 차단 판정용 KV
(`cooldown:{nickname}`)와 표시용 인덱스(`COOLDOWN_INDEX_KEY`)가 서로
다른 저장소였다 — `_markCaptureDoneInLiveIndex`가 캡처 완료 시 이 둘을
**각각** 갱신해야 했다(인덱스의 `expiresAt`과 KV의 TTL 둘 다). DO에서는
배열 하나(`reportCooldowns`)가 차단 판정과 표시를 동시에 담당해 이 이중
갱신 자체가 사라졌다.

`_appendToLiveIndex`/`_readLiveIndex`/`_markCaptureDoneInLiveIndex`(CAS
유사 재시도 로직 포함)와 `LIVE_INDEX_MAX_RETRIES`/`COOLDOWN_INDEX_KEY`는
더 이상 아무 데서도 호출되지 않아 코드에서 완전히 제거했다 — DO는 단일
인스턴스가 요청을 직렬 처리해 이 재시도 로직 자체가 필요 없기 때문이다.
`leaveq:` 전용 인덱스(`_addToLeaveQueueIndex` 등)는 §24.3의 이유로
그대로 KV에 남겨뒀다 — 이름이 비슷해 보여도 서로 다른 함수라 혼동 주의.

### 24.5 순영향(§24.1~§24.4 종합)

| 항목 | 변화 |
|---|---|
| `list()`(하루 1,000회) | PUSH 관련 정기 소비가 사실상 0으로 감소(마이그레이션 자체 복구 제외) |
| 쓰기(write, 하루 1,000회 공유) | 기기 등록/토글/이름변경/삭제 시 `subIndex:` 갱신으로 각 +1건(저빈도 이벤트라 무시할 수준). 알림 전송·제보 접수의 쓰기는 그대로 발생하지만 **KV가 아니라 DO**로 이동해 KV 쓰기 한도에서 완전히 빠짐(제보 접수는 3건→`report:` 1건만 남고 나머지 2건은 DO로) |
| 삭제(delete) | "제보 즉시 처리 완료 시 `report:{id}` 삭제"만 KV에 남음(그 자체가 안전망 큐의 정상 소비 동작) — 그 외 변화 없음 |
| 읽기(read, 하루 10만 회) | 화면별로 증감이 있으나 예산 여유가 커 무의미 |

### 24.6 `penSlotGrid:` TTL 상향 + `attachNextOccurrence` pending 필터링 +
"내 제보 확인" 렌더/감지 폴링 이원화 (2026-09-11)

"내 제보 확인"에서 새로고침 버튼을 대시보드처럼 "지금 눌러볼 만한지"를
알려주는 신호로 통일하려다가, 세 가지가 얽힌 개선으로 이어졌다.

**① `attachNextOccurrence`가 붙이는 `nextOccurrence`/`weeklyMinorPenaltyCount`는
pending 건에서만 실제로 쓰인다.** 프론트 코드(`MyOutputPenSection.tsx`/
`ReportReviewList.tsx`)를 확인한 결과, 확정(approved)/유예(deferred) 건은
`penalty?.occurrence ?? nextOccurrence` / `deferredOccurrence ?? nextOccurrence`
형태로 **확정 시점 스냅샷을 항상 우선**하고, 반려는 애초에 페널티가 없어
이 값 자체가 안 쓰인다. 그런데 `attachNextOccurrence`는 배치에 pending
건이 하나도 없어도 무조건 `penSlotGrid:`(F4:K18 전체)를 조회했다 —
받은 제보가 이미 전부 처리 완료된 상태에서도 매번 헛돈을 쓰고 있었던
것. **대응**: `items.some((it) => it.reviewStatus === "pending")`이
false면 `penSlotGrid:`/`penCycle:` 조회를 통째로 건너뛰고 `null`
placeholder를 채운다(`reporterName`은 pending 여부와 무관하게 필요하므로
`members:`는 그대로 조회).

**② `penSlotGrid:` TTL 60초→5분 상향.** §5에서 이미 "정합성만 보면 늘려도
안전하다"고 확인해뒀던 캐시다 — 실제 승인(`applyOutputPenalty`)은 이
캐시를 전혀 안 쓰고 결정 시점에 직접 시트를 다시 읽으므로, `penSlotGrid:`
가 얼마나 낡았든 실제 벌점 반영 결과에는 영향이 없다. 60초로 유지했던
유일한 이유(관리자가 연속 처리할 때 체감 실시간성)는 여전히 유효하지만,
①의 pending 필터링과 합치면 이 캐시를 실제로 건드리는 빈도 자체가 낮아져
5분까지는 재조회 배율을 넉넉히 지키면서도 체감 지연이 크지 않을 걸로
판단했다(사용자 확인).

**③ "내 제보 확인" 폴링을 "렌더"(20분)/"감지"(5분) 두 단계로 분리.**
당초 "새 항목이 오면 새로고침 버튼에 강조를 준다"는 기능을 만들었다가,
`usePollingRefresh`가 `visible=false`일 때 타이머 자체를 멈춘다는 사실을
뒤늦게 확인해 — 탭을 벗어나 있으면 폴링이 전혀 안 돎 — 그 방식(직전에
"본" id와 비교)은 사용자가 그 신호를 볼 수 있는 시점엔 이미
`useRefreshOnVisible`이 최신 데이터를 자동으로 보여준 뒤라서 **절대
발동하지 않는 죽은 기능**이었다. 최종적으로는 대시보드의
`refreshDisabled`(TTL 기반 비활성화)와 **같은 prop을 반대 방향으로**
재사용해 통일했다 — 대시보드는 "기본 활성화, TTL 안엔 비활성화"이고
여기는 "기본 비활성화, 감지되면 활성화":

- **렌더**(`load`, 20분): `/my-captures`+`/my-output-pen`을 불러와 화면을
  실제로 갱신. 갱신 직후엔 안 보여준 새 항목이 없으므로 버튼을 다시
  비활성화한다.
- **감지**(`detectNew`, 5분, 신설): `/my-output-pen`만 가볍게 불러와 현재
  **렌더된** `receivedItems`의 id와 비교 — 화면은 안 건드리고 새 id가
  있으면 버튼만 활성화한다.

이 분리가 실제로 의미 있는 이유는 **탭을 계속 보고 있는 동안(20분 렌더
사이)의 갭을 5분 감지가 메운다**는 것이다 — 예전 방식과 달리 "탭을 벗어나
있는 동안"이 아니라 "탭을 보고 있는 동안"을 겨냥하므로 실제로 발동한다.
`SectionHeader`의 `refreshHighlight`(글로우) prop은 이 과정에서 도입했다가
바로 제거했다 — 코드에 남기지 않는다.

**배율 재확인**: `ReportReviewList`(같은 `penSlotGrid:` 공유)도 10분→20분으로
함께 올려, 20:5=4배로 원칙을 넉넉히 지킨다. "내 제보 확인"의 5분 감지 자체는
`penSlotGrid:` 기준 1:1이지만 ①의 pending 필터링으로 실제 트리거 빈도가
낮아 허용 가능하다고 판단했다(사용자 확인).

## 25. 신규 회원 등록 — `roster`(9종 전부) 대신 `newMember`(7종)로 좁힘 (2026-09-11)

관리자 메뉴 폴링/캐싱 정책을 처음부터 다시 점검하는 세션에서, "신규 회원
등록 1건이 벌점/벌금/사이클 캐시까지 매번 지우는 게 과도해 보인다"는
지적으로 `handleAdminCreateMember`의 `invalidateMemberCache(["roster"])`
호출을 재검토했다.

**먼저 "지우는 대신 캐시에 직접 추가(patch)하자"는 대안을 검토했으나
기각했다.** 이유 네 가지가 모두 독립적으로 patch를 깨뜨린다:
1. Workers는 여러 isolate가 동시에 떠 있고 서로 직접 통신할 수단이
   없어, 한 isolate의 인메모리 캐시만 patch해도 다른 isolate는 TTL
   만료 전까지 신규 회원을 계속 누락한다.
2. KV는 원자적 CAS/트랜잭션이 없는 last-write-wins 저장소라, 두 관리자가
   거의 동시에 서로 다른 회원을 등록하면 read-modify-write 경쟁으로 한쪽의
   추가분이 유실될 수 있다(`_cachedCompute`가 이미 세대 카운터로 이런
   경쟁을 우회하고 있다는 사실 자체가 이 위험을 방증한다).
3. 무효화 방식은 실패해도 최악의 경우 "낡은" 캐시가 남을 뿐이지만, patch는
   실패 시 "낡음"이 아니라 "틀림"으로 2시간(members: TTL) 동안 고정될 수
   있어 무효화보다 명백히 더 위험하다.
4. §9(회원번호 재사용) 위험과 정확히 겹친다 — 퇴실 처리로 캐시에서 아직
   안 지워진 옛 항목이 남은 상태에서 새 회원을 같은 번호로 patch append하면
   같은 번호를 가진 두 항목이 `members` 배열에 공존하게 된다.

**대신 이미 검증된 패턴(§17.2의 `memberIdentity` 그룹)과 동일하게, "무효화
자체는 유지하되 대상 그룹만 좁힌다"로 진행했다.** `handleAdminCreateMember`가
실제로 쓰는 범위는 개인탭 `B2`(대시보드 문구)/`I2`(가입일)/`L3`(참여상태=
"스터디원")/`O3`(목표시간)와 `데이터!D`(이메일)/`E`(시험종류)열뿐이다 —
시트 생성·삭제·이름변경이 없다. 9종 각각을 이 범위와 대조한 결과:

- **무관(제외)**: `meta:`(탭 구조 자체가 안 바뀜), `penSlotGrid:`(데이터!F~K,
  신규 등록은 D/E열만 씀), `weeklyPaidFine:`(집계!D22, 무관), `penCycle:`
  (집계!D25, 앱스크립트 전용 갱신 경로만 씀).
- **실제로 낡음(유지)**: `members:`/`dataSheetRows:`(D/E열이 원본), `exitStatus:`/
  `memberRows:`(L3가 두 캐시의 입력 범위 안), `rosterStatus:`(집계 수식이
  B2/L3를 즉시 반영), `adminMemberList:`(members 경유), `coReviewers:`
  (신규 회원의 L3는 "스터디원"이라 결과값엔 영향 없어 보이지만, `listAllMembers`
  의존성이 있어 보수적으로 유지).

새 그룹 `MEMBER_CACHE_GROUPS.newMember = ["members", "dataSheetRows",
"exitStatus", "memberRows", "rosterStatus", "adminMemberList", "coReviewers"]`
를 신설해 `handleAdminCreateMember`가 이 그룹만 무효화하도록 좁혔다. 번호
재사용 시 잔존하는 회원별 캐시(`personalStatusBundle:` 등)는 이 그룹과
무관하게 `invalidateMemberSlotCache(env, sheetName)`가 이미 별도로 방어하고
있어(같은 호출부에 직전부터 존재) 이번 변경으로 그 방어가 약해지지 않는다.

같은 세션에서 `performExitReset`/`performDepositAgainReset`/
`handleAdminExitConfirm`/`moveMemberSlot`도 함께 검토했으나, 넷 다
`spreadsheetBatchUpdate`로 시트를 복사·삭제·이름변경해 `meta:`(sheetId)까지
실제로 바뀌고 참여상태/벌점 슬롯도 함께 리셋되므로, 9종 중 최소 6종 이상이
실제로 낡아 `roster` 전체 무효화가 낭비가 아니라고 판단해 그대로 두었다
— 좁힌 것은 `handleAdminCreateMember` 하나뿐이다.

## 26. `dataSheetRows:` TTL을 `members:`와 맞춰 10분→2시간 상향 (2026-09-11)

§17.2(`members:` TTL 2시간 상향) 당시 주석(getDataSheetRows 근처, "members:와
TTL·무효화 그룹을 반드시 함께 맞춘다")에 이미 명시돼 있었음에도, 실제로는
무효화 그룹(roster/memberIdentity/newMember)만 맞춰지고 **TTL 자체는 10분에
남아있던 누락**을 이번 점검에서 발견했다. `members:`가 `dataSheetRows:`
(데이터!A1:V50)에서 파생되는 구조라, 재료가 10분마다 낡은 것으로 취급되면
가공값의 2시간 TTL도 재계산 빈도 측면에서 사실상 무의미해진다.

**올려도 안전한 이유**: `dataSheetRows:`의 소비처는 정확히 3곳
(`listAllMembers`/`handleAdminMembersRoster`/`handleAdminOpenSlots`)뿐이고,
셋 다 B(번호)/C(이름)/D(이메일)/E(시험종류)열만 읽는다 — F~V열(송출P/주간P/
제보상점 슬롯 등 자주 바뀌는 값)은 전혀 읽지 않는다. `handleAdminOpenSlots`
("빈 번호" 조회)가 최대 2시간 묵은 스냅샷으로 이미 채워진 번호를 "비어있다"고
잘못 보여줄 가능성은 있지만, 실제 등록 처리(`handleAdminCreateMember`)는 이
캐시를 전혀 거치지 않고 매번 시트를 직접 재조회해 중복을 재검증하므로 잘못된
안내가 실제 데이터 오염으로 이어지지 않는다.

**무효화 그룹은 members:와 완전히 1:1로 동기화**되어 있음을 전수 확인했다
(둘 다 있는 그룹: roster/memberIdentity/newMember, 둘 다 없는 그룹: 나머지
전부) — 한쪽만 지우는 비대칭 그룹은 없다. 즉 TTL만 안전망으로 따라가는
변경이며, 무효화 타이밍(정합성의 핵심)은 이번 변경으로 전혀 바뀌지 않는다.

## 27. 관리자 탭 폴링 주기 20분 통일 (2026-09-11)

사용자 지시("봇 상태를 제외하곤 모두 폴링 주기 20분으로 맞춰")에 따라
관리자 화면 폴링 4곳을 20분으로 통일했다:

| 컴포넌트 | 이전 | 이후 |
|---|---|---|
| `PenaltyCandidateList.tsx`(예치금 재납 대상자) | 3분 | 20분 |
| `AdminMoneyTab.tsx`(정산) | 3분 | 20분 |
| `MemberRosterList.tsx`(참여 스터디원 목록) | 30분 | 20분 |
| `ReportReviewList.tsx`(제보 처리) | 20분 | 20분(변경 없음) |
| `AdminBotSheetTab.tsx`(봇 상태) | 1분 | 1분(제외 대상, 변경 없음) |

`MemberRosterList`는 §12.1 원칙(캐시 TTL의 3배 이상)에 맞춰 `dataSheetRows:`/
`meta:`(당시 10분) 기준 정확히 3배인 30분으로 맞춰져 있었는데, 이번
통일로 20분(`meta:` 10분 기준 2배)으로 내려가 그 원칙에는 못 미치게 됐다
— `dataSheetRows:`가 §26에서 2시간으로 늘었으므로 실질적인 병목은 `meta:`
(10분) 하나뿐이고, 2배 배율로 캐시 미스가 다소 늘 수 있음을 감수한
의도적 절충이다(사용자 지시에 따른 결정, 재조사 없이 그대로 적용).

**추가 발견(2026-09-11, PEN·Money 탭 1차 점검)**: 위 통일 작업 당시
"PEN·Money" 탭 안의 5개 섹션 중 `ReasonLeaveReviewList.tsx`(사유 반휴
신청 처리)가 누락되어 있었다 — `useRefreshOnVisible`(탭 복귀 시에만
갱신)만 있고 `usePollingRefresh`가 없어, 탭을 계속 띄워둔 채로 있으면
다른 관리자가 처리한 반휴 신청이 자동으로 반영되지 않는 사각지대였다.
같은 탭의 나머지 4개 섹션(`ReportReviewList`/`PaidFineList`/
`PenaltyCandidateList`/`PrizeRecipientList`, 뒤의 둘은 `AdminMoneyTab.tsx`
내부)은 모두 20분 폴링이 걸려있어 형평에 맞지 않았다. `ReportReviewList`와
동일한 패턴(`usePollingRefresh(visible, load, 20 * 60_000)` +
`SectionHeader`에 `refreshProgress` 전달)으로 맞춰 추가했다.

## 28. ACCOUNT 탭 짧은 TTL 3종 상향 — `exitStatus:`/`memberRows:` 60초→10분, `coReviewers:` 5분→10분 (2026-09-11)

사용자가 "1분, 5분짜리 TTL을 10분으로 늘리면 위험한가"를 물어 셋을
각각 조사했다.

**`coReviewers:`(5분→10분, 안전)**: 부스터디장 임명/해제는
`handleAdminSetPartiStatus`(Worker API) 단일 경로뿐이고, 항상
`await invalidateMemberCache(["partiStatus"])`로 응답 전에 무효화된다.
시트를 직접 고쳐 부스터디장을 지정하는 우회 경로는 없다. 늘어나는 건
"무효화 자체가 실패했을 때의 안전망 시간"(5분→10분)뿐이라, 이 값이
쓰이는 권한 검사(`requireAdminOrCoReviewer`, §22)에 실질적 위험이
크지 않다고 판단했다.

**`memberRows:`(60초→10분, 안전)**: `fine` 그룹(벌금 처리)으로
무효화되는데, 프론트(`AdminMoneyTab`)가 확정 처리 후 캐시를 기다리지
않고 즉시 재조회(write-then-reload)해 체감 UX엔 영향이 없다. 매주
`sheet_reset()`이 `C32:W32`(납부확인 등)를 직접 초기화하며 무효화
알림을 안 보내는 gap이 있지만 주 1회뿐이라 영향이 작다.

**`exitStatus:`(60초→10분, 조건부 안전으로 재판정)**: 처음 조사에서는
"구글시트 메뉴 '퇴실자·재납자 처리'(`_exit_define`, appscript.js)가
Worker 캐시 무효화 알림 없이 참여상태/벌금을 직접 쓴다"는 gap을 근거로
보류를 권했다. 사용자 확인: "대부분의 기능이 웹 서비스로 이전 중이라,
웹이 정상 가동 중일 땐 이 시트 메뉴로 퇴실 처리를 할 일이 없고, 웹
장애 시의 비상 수단으로만 남아있다." 이 전제를 받아들이면 판단이
바뀐다 — TTL 상향이 위험해지는 시나리오("그 우회 경로를 실제로 쓰는
동안")와 그 gap이 실제로 해를 끼치는 시나리오("웹 화면의 캐시 최신성이
중요한 동안")가 서로 겹치지 않는다. 웹이 정상 동작 중엔 그 우회 경로를
안 쓰므로 gap이 발동하지 않고, 웹 장애로 그 경로를 쓰는 동안엔 애초에
웹 화면 자체가 안 보이니 캐시 최신성이 무의미하다. 따라서 10분으로
올려도 안전하다고 재판정했다. **단, 이 판단은 "시트 메뉴 직접 처리가
사실상 죽은 경로"라는 전제에 의존한다** — 나중에 그 메뉴가 다시
일상적으로 쓰이게 되면 이 판단을 재검토해야 한다.

세 캐시 모두 이 세션에서 10분으로 상향했고, `exitStatus:`/`memberRows:`를
공유하는 `PenaltyCandidateList`/`AdminMoneyTab`의 20분 폴링(§27)과 배율이
2:1이 된다 — `dataSheetRows:` 등 긴 TTL과 달리 §12.1의 "3배 이상" 원칙엔
못 미치지만, 10분 TTL 자체가 이미 충분히 짧아 실무상 문제로 보지 않는다.

## 29. "화각 불량 제보 처리" 부스터디장 투표 조회 순차→병렬화 (2026-09-11)

`handleAdminCapturesList`(`GET /admin/captures`, index.js:3616 부근)가
"다른 관리자 의견 반영" 섹션에 표시할 부스터디장 투표(`reportVote:` KV,
§ROADMAP 참고)를 항목마다 조회하는데, 바깥 루프(항목 배열)는 이미
`Promise.all`로 병렬화되어 있었지만 그 **안쪽**(항목 하나당 부스터디장
목록을 도는 루프)은 `for...of` + `await`로 순차 처리되고 있었다 — 항목
20건 × 부스터디장 최대 2명이면 최대 40회를 하나씩 순서대로 기다리는
구조.

**안전성 검증 후 진행**: 각 `env.REPORTS_KV.get()` 호출에 이미 개별
`.catch(() => null)`이 붙어 있어 어떤 조회가 실패해도 절대 reject로
전파되지 않는다는 걸 확인했다 — `Promise.all`의 "하나라도 reject되면
전체가 reject"되는 특성이 발동할 여지가 원천적으로 없어
`Promise.allSettled`가 필요 없다. 결과를 담는 `votes` 객체는 회원번호를
키로 쓰므로 조립 순서와도 무관하다. `getCurrentCoReviewers`(부스터디장
목록)는 이미 루프 밖에서 한 번만 호출되고 10분 TTL(§28)로 캐싱되어 있어
루프 안 반복 호출 낭비는 없었다. Subrequest 한도도 "하루 제보 처리
건수 10건 내외, 건당 최대 2명"(§ applyOutputPenalty 주석)이라는 기존
실측 근거상 여유가 있다고 판단했다.

안쪽 루프를 `coReviewers.map(...)` + `Promise.all`로 바꿔 항목당 최대
2회(부스터디장 수만큼)를 동시에 처리하도록 했다 — KV 조회 횟수 자체는
그대로이지만(캐시 절감 효과는 없음), 목록 조회 1건의 총 대기 시간이
줄어드는 순수 지연시간 개선이다.

## 30. 관리자 탭 전체 — 탭 복귀/당겨서 새로고침/폴링 중복 `load()` 방지 (2026-09-11)

"화각 불량 제보 처리" 캐싱 정책을 점검하던 중, 이 화면이 갱신을
트리거하는 세 가지 훅(`useRefreshOnVisible`/`usePullRefreshListener`/
`usePollingRefresh(20분)`)이 서로의 존재를 전혀 모른 채 독립적으로
`load()`를 호출한다는 걸 발견했다 — 타이밍이 겹치면(예: 폴링 타이머가
거의 다 찬 시점에 당겨서 새로고침, 또는 탭 복귀와 폴링 만료가 근접)
같은 목록 조회가 중복으로 나갈 수 있었다. `load()` 자체도 `loading`
state를 재진입 시 확인하는 가드가 없어 매번 새 요청을 그냥 보냈다.

조사 결과 이건 `ReportReviewList`만의 문제가 아니라 관리자 탭 전체
(`MemberRosterList`/`ReasonLeaveReviewList`/`AdminMoneyTab`의 `load()`
2개/`PenaltyCandidateList`)에 복제된 공통 패턴이었다 — 의도적으로
안전하게 설계된 게 아니라 동일한 취약점이 그대로 반복된 것이었다.
서버 부수효과가 없는 단순 조회라 심각한 문제는 아니었지만(응답이
겹쳐도 나중 응답이 화면을 최종적으로 덮어쓸 뿐 데이터 오염은 없음),
사용자 지시("관리자 탭 전체에 한번에 적용")에 따라 6곳 모두에 동일한
가드를 추가했다:

`const loadingRef = useRef(false)`를 두고, `load()` 진입 시
`if (loadingRef.current) return` 후 `loadingRef.current = true`,
`.finally()`에서 `loadingRef.current = false`로 되돌린다. `loading`
state 대신 `ref`를 쓴 이유는 `setState`가 비동기라 재진입 시점에
아직 최신값이 반영되지 않았을 수 있기 때문이다. `AdminMoneyTab.tsx`의
두 `load()`(`PaidFineList`/`PrizeRecipientList`)는 이미 서로 다른
컴포넌트 함수 안에 있어 `loadingRef`가 자연히 독립적이다.

## 31. "PEN·Money" 탭 1차 점검 — 현행 유지로 결론난 항목 3건 (2026-09-11)

ACCOUNT 탭에 이어 "PEN·Money" 탭(`ReportReviewList`/`ReasonLeaveReviewList`/
`PaidFineList`/`PenaltyCandidateList`/`PrizeRecipientList`, 5개 섹션이 한
컴포넌트 `AdminMoneyTab`에 모여있음)을 같은 방식으로 점검했다. 실제로
고친 건 §27(사유 반휴 폴링 누락)·§29(투표 조회 병렬화)·§30(중복 load
방지) 세 건이고, 아래 세 건은 "과도해 보이지만 실제로는 필요하거나,
건드리면 오히려 위험하다"고 판단해 현행을 유지했다.

**① `rosterStatus:` TTL(10분) 상향 — 보류.** "관리자 쓰기(`rosterOnly`
그룹)는 이미 즉시 무효화되고, 도움봇이 집계 탭에 직접 쓰지 않으니 TTL을
늘려도 안전하지 않을까"라는 가설로 조사했으나 두 가지 위험을 발견해
철회했다. (a) §16/decision_meritrank_penalty_cache.md에서 이미 "의도적
방치"로 확정된 사안 — 제보 승인이 집계 F열(순위) 수식을 바꾸는데
`penalty` 그룹(`exitStatus`+`penSlotGrid`만)엔 `rosterStatus`가 빠져
있다 — 이 방치 폭이 TTL 그대로 늘어난다. (b) 더 결정적으로,
`PrizeRecipientList`("상금 수령 처리")가 이 캐시를 그대로 보여주면서
같은 화면의 "상금 정산 집행"(`handleAdminPrizeSettle`)이 표시된 값을
재검증 없이 그대로 실행에 옮긴다 — TTL이 길수록 낡은 순위/분배금을 보고
정산을 집행할 위험이 커진다. MY 탭(`getMeritRank`)도 같은 캐시를
재사용해 동일 리스크를 공유한다.

**② `fine` 그룹(`exitStatus`/`memberRows`/`weeklyPaidFine`) — 3종 모두
필요, 과도한 항목 없음.** `handleAdminFineStatus`는 개인 탭 31행
(`ROW_PAYMENT_CHECK`, "✅ 납부확인")만 쓰는데, 이 행이 `memberRows:`의
읽기 범위(A1:U41, `ROW_REASON_LEAVE_LEFT` 기준)에 정확히 포함된다 —
`memberRows:`는 벌금 목록 API(`listUnpaidFines`/`listPaidFines`)가 직접
재사용하는 소스라 무효화가 필수다. `exitStatus`도 "표시용"이 아니라
32행(`ROW_FINE_NO_STATUS`, 미납신호)이 `depositRefundBreakdown`에서
`fine_unpaid` 강제퇴실 사유로 실제 판정에 들어간다 — 벌금 미납을
납부 처리했는데 이 캐시를 안 지우면 이미 납부한 회원이 강제퇴실
대상으로 잘못 판정될 위험이 있다.

**③ `penSlotGrid:` TTL(5분) 상향 — 보류.** 무효화 자체는 정확했다
(슬롯을 실제로 채우는 승인/인정만 `penalty` 그룹을 호출하고, 슬롯을
안 건드리는 유예/반려는 무효화하지 않는 설계가 갭 없이 맞아떨어진다).
`applyOutputPenalty`(실제 승인 확정)는 이 캐시를 전혀 안 쓰고 항상
시트를 직접 재조회하므로 **데이터 정합성 관점에서는 TTL을 늘려도
안전하다.** 다만 `ReportReviewList`의 "적용" 버튼 라벨·처리 유형
(`approved`/`rejected_recognized`)을 프론트가 이 캐시값(`nextOccurrence`)
만으로 미리 결정해 보여준다 — 캐시가 낡으면 버튼 문구가 실제 처리
결과와 어긋나 보여 관리자가 헷갈릴 수 있다(데이터 오염은 아님). 정합성
위험보다 이 UX 혼란 위험을 더 우선해 보수적으로 현행(5분) 유지를
택했다.

## 32. "상금 수령 처리" 폴링 누락 + 집행 직전 서버 재검증 추가 (2026-09-11)

"혹시 모르니 PEN·Money 탭 전반을 다시 점검해달라"는 요청으로 §25~§31과
겹치지 않는 각도에서 재조사한 결과, `PrizeRecipientList`("상금 수령
처리")에 다른 4개 섹션과 달리 `usePollingRefresh`가 아예 빠져 있는 걸
발견했다. §16에서 `rosterStatus:`(순위·분배금)에 캐싱이 도입된 뒤에도
이 섹션만 폴링 통일(§27) 대상에서 누락되어 있었다 — 관리자가 탭을 열어둔
채 방치하면 최대 10분(§9 TTL 표) 낡은 분배금을 계속 보면서도 자동으로
갱신되지 않았다.

문제는 여기서 그치지 않았다 — `PrizeRecipientList`가 이 캐시를 그대로
보여주는 화면에 "상금 정산 집행" 버튼(`handleAdminPrizeSettle`, 집계!P6에
"완료" 마킹)이 함께 있는데, 이 버튼이 **화면에 표시된 값을 재검증 없이
그대로 실행**했다. §31①에서 이미 "제보 승인이 `rosterStatus:`를 바꾸는데
`penalty` 그룹은 이걸 무효화하지 않는다(의도적 방치, §16)"는 걸 확인했던
바로 그 캐시라, 돈이 걸린 액션과 겹친다는 게 단순 표시 지연보다 훨씬
위험했다.

**두 겹의 방어를 추가했다**:
1. **폴링 추가**: 다른 섹션과 동일하게 `usePollingRefresh(isVisible, load,
   20 * 60_000)`을 붙였다(AdminMoneyTab.tsx, `PrizeRecipientList`).
2. **서버 측 집행 직전 재검증**: 처음엔 "프론트가 집행 직전에
   `/roster-status`를 한 번 더 조회해 비교"하는 방식을 시도했으나, 그
   조회 자체가 아직 무효화되지 않은 낡은 캐시를 받을 수 있어(제보 승인이
   `rosterStatus:`를 안 지우므로) 신뢰할 수 없다고 판단해 기각했다.
   대신 `handleAdminPrizeSettle`(index.js:6233 부근)이 **서버에서** 집행
   직전에 `rosterOnly` 그룹을 먼저 무효화하고 `buildRosterStatus`를
   강제로 재계산해, 프론트가 보낸 `expectedCollectMoney`(화면에 표시된
   총 모금액)와 "진짜 최신" 값을 대조한다 — 다르면 409를 반환해 집행을
   막고, 프론트는 이를 받아 `load()`로 최신 값을 다시 불러온다. 프론트
   재확인이 아니라 서버 강제 무효화+재계산만이 §16의 의도적 방치를
   완전히 우회하는 확실한 최종 방어선이다.

## 33. `weeklyPaidFine:` TTL 5분→10분 상향 (2026-09-11)

"PEN·Money 탭 5분짜리 TTL(`weeklyPaidFine:`/`penSlotGrid:`)을 10분으로
늘리면 위험한가" 재검토 요청으로 둘을 각각 조사했다.

**`weeklyPaidFine:` — 상향.** `getWeeklyPaidFineTotal`(집계!D22)은 "납부된
총 벌금액" 표시(`PaidFineList`) 하나에만 쓰이는 단순 집계값이고, 강제퇴실
판정 등 다른 계산엔 전혀 관여하지 않는다(그 판정은 개인 탭 32행 기반
`exitStatus:`가 별도로 담당). 유일한 쓰기 경로(`handleAdminFineStatus`)가
항상 `fine` 그룹으로 확실히 무효화하고, 이를 우회하는 쓰기 경로(앱스크립트
등)도 없음을 재확인했다 — `fine_check_row` 상수가 정의만 되고 실제로
쓰이는 곳이 없는 죽은 코드라는 것까지 확인해, "무효화는 완전히 신뢰
가능하고 TTL은 순수 안전망"이라는 이상적인 경우로 판단했다.

**`penSlotGrid:` — 재검증 후 5분 유지, 결론 불변.** §31③ 결론(실제 승인은
캐시를 안 쓰고 항상 시트를 직접 재조회하므로 정합성 위험은 없지만, 관리자가
보는 "적용" 버튼 라벨이 캐시값 기반이라 낡으면 실제와 어긋나 보일 수 있다)
을 재확인했다. 10분으로 늘리면 이 라벨 불일치의 노출 시간이 최대 5분→10분
으로 2배 늘고, `ReportReviewList`의 20분 폴링과 짝지어진 배율(4:1) 원칙을
지키려면 폴링도 40분으로 함께 늘려야 해 체감 지연이 커진다 — 여러
관리자가 동시에 제보를 처리하는 흐름에서 화면 간 불일치가 더 자주
노출될 수 있어 보수적으로 현행(5분)을 유지했다.

## 34. "상금 정산 집행" 서버 재검증 — 수령자 명단까지 확장 (2026-09-11)

캐싱 정책 전반의 데이터 정합성을 다시 훑는 세션에서, §32에서 추가한
`handleAdminPrizeSettle`의 서버 재검증(집행 직전 `rosterOnly` 그룹 강제
무효화 + `buildRosterStatus` 재계산 + `expectedCollectMoney` 대조)에 구멍이
있다는 지적이 나와 2차로 철저히 재검증했다.

**문제**: 이 검증은 총 모금액(집계!D20)만 대조한다. 그런데 제보 승인은
집계 F열(순위) 수식만 바꾸고 D20(총 모금액)은 그대로 두므로, **총액이
불변인 채 1~5등 수령자 구성만 바뀌는 경우 이 검증을 그대로 통과**했다.
`settlement`(수령자 목록)와 `collectMoney`(총액)는 각각 `집계!A4:L18`과
`집계!D20:D24`라는 서로 독립적인 범위에서 계산되기 때문이다(§16에서
이미 "F열 수식이 페널티 유무로 순위 제외를 판정한다"고 확인된 그 갭이
여기서도 그대로 재현됨).

**왜 위험한가**: 이 화면은 관리자가 표시된 명단을 보고 **먼저 실제로
송금**한 뒤 "집행" 버튼으로 완료만 기록하는 워크플로우다(코드 주석
명시: "관리자가 이번 주 1~5등에게 실제로 상금을 지급했음을... 기록한다").
즉 낡은 명단으로 이미 잘못된 사람에게 송금이 끝난 뒤에야 버튼이 (운
좋으면) 막히는 구조였다 — 사후 마킹 검증만으로는 실제 송금 자체를
막을 수 없다는 한계는 여전히 남지만, 최소한 "화면과 서버가 서로 다른
명단을 보고 있는 상태"는 이제 감지된다.

**수정**: 프론트(`AdminMoneyTab.tsx`)가 화면에 표시된 수령자 번호 순서
(`settlement.map(s => s.number)`, `expectedSettlementNumbers`)를
`expectedCollectMoney`와 함께 보내고, 서버가 재계산한 최신 `settlement`의
번호 순서와 정확히 일치할 때만 집행을 허용한다(하나라도 다르면 총액
검증과 동일하게 409). 2차 점검에서 `settlement` 배열이 `rankValue` 기준
안정 정렬(JS `Array.sort`)로 항상 결정적임을 확인해, 실제로 명단이 안
바뀐 정상 케이스에서 오탐(false positive)으로 막힐 위험은 없다고
검증했다.

## 35. 데이터 정합성 전면 재점검 — 동시 쓰기·KV 최종 일관성 (2026-09-11)

지금까지의 점검은 "무효화 타이밍이 코드상 정확한가"에 집중했다. 이번엔
관점을 바꿔 (a) 두 요청이 거의 동시에 같은 데이터를 건드리는 경쟁 조건,
(b) Cloudflare KV가 최종 일관성(eventually consistent) 저장소라 리전 간
전파에 최대 60초 걸릴 수 있다는 근본 특성이 실제 위험을 만드는지, (c)
기존 "표시만 지연될 뿐 무해하다"던 의도적 방치 판단들을 재검증했다. 세
갈래 심층 조사 결과, 실제로 손봐야 할 지점 4건을 찾아 전부 수정했다.

**① `handleAdminCreateMember`(신규 등록) — 동시 등록 시 데이터 소실 위험.**
"빈 번호 찾기 → 그 번호에 쓰기"가 락 없는 읽기-수정-쓰기 구조라, 관리자
두 명이 거의 동시에 등록하면 나중 요청이 먼저 등록된 회원을 완전히
덮어쓸 수 있었다. 이미 `applyOutputPenalty`/`applyReportMerit`에 쓰이던
`withMemberLock`(Durable Object 기반 뮤텍스, §withMemberLock 주석 참고)을
재사용해, 빈 번호 확인부터 시트 쓰기까지를 `newmember:${fileId}` 락으로
직렬화했다. 대상 회원이 아직 번호가 없는 단계라 회원 단위 락을 걸 수
없어 시트 전체 단위 락을 썼다 — `pen:`/`merit:` 접두어와 겹치지 않아
벌점 승인과는 무관하고, 신규 등록은 드문 조작이라 직렬화 비용도 낮다.
락 콜백 안의 검증 실패는 예외 대신 `{failure: {status, message}}` 마커로
반환해(이 코드베이스에 커스텀 HTTP 에러 클래스가 없어 기존 관례를 따름)
바깥에서 판별한다.

**② `handleAdminMemberReorder`(번호 정렬) — 동시 실행 시 시트 구조 손상
위험.** `moveMemberSlot`이 탭 삭제→이름변경→위치조정 등 여러 단계를 락
없이 순차 실행해, 두 관리자가 "정렬 실행"을 거의 동시에 누르면 서로
다른 시점의 계획으로 같은 탭을 건드려 구조가 깨질 수 있었다. plan
재계산부터 전체 이동 완료까지 요청 전체를 `reorder:${fileId}` 락으로
감쌌다 — 개별 이동 단계가 아니라 배치 전체를 하나의 임계구역으로 다룬다
(정렬 도중 다른 정렬 요청이 끼어드는 게 더 위험하므로).

**③ "상금 정산 집행" 서버 재검증의 구멍 — §34에서 이미 상세 기록.**
총 모금액만 검증해 수령자 명단만 바뀌는 경우를 놓쳤던 걸 2차 점검으로
확인해 수령자 번호 순서까지 검증하도록 확장했다.

**④ `computeExitResult`(퇴실 판정) — KV 최종 일관성으로 인한 반환금 오판정
위험.** 벌점 승인(`applyOutputPenalty`)이 `personalStatusBundle:`을 지운
직후(그 리전에서만) 60초 내에 다른 리전 관리자가 같은 회원을 퇴실
확정하면, 그 리전의 KV 로컬 복제본엔 delete가 아직 전파되지 않아 낡은
페널티 상태를 읽고 반환금을 잘못 계산할 수 있음을 확인했다. **핵심
발견은 "①·②와 달리 이건 뮤텍스로 해결되지 않는다"는 것** —
`withMemberLock`은 동시 실행 순서만 강제할 뿐, 락 해제 후에도 여전히
존재하는 "KV 자체의 리전 간 전파 지연"은 막지 못한다. 대신 실제로 시트를
바꾸는 확정(`handleAdminExitConfirm`) 경로에서만 `computeExitResult`에
새 `forceFresh` 플래그를 추가해, 판정 직전 해당 회원의
`personalStatusBundle:`을 강제로 지운 뒤 재계산한다(같은 요청 내 KV
read-your-write는 보장되므로 "이 판정 시점만큼은" 최신값을 보장).
미리보기(`handleAdminExitPreview`, 다이얼로그 열릴 때·사유 입력 중
300ms 디바운스로 반복 호출됨)에는 적용하지 않아 불필요한 재계산을
피했다. `invalidateMemberSlotCache`가 원래 항상 "현재 시트"만 지웠는데
퇴실 판정은 과거 백업 파일도 다룰 수 있어, 세 번째 인자로 대상 fileId를
지정할 수 있도록 확장했다(기존 12곳 호출부는 인자 생략 시 그대로 현재
시트를 지워 하위 호환).

**한계**: ④는 "지우기" 자체도 최종 일관성 연산이라 이론적으로 완전한
해결책은 아니다(다른 리전의 delete가 이 리전에 아직 안 닿았을 가능성은
이론상 남음). 완전한 해결은 캐시를 아예 거치지 않는 별도 경로가
필요하지만, 이 앱 규모(회원 15명, 관리자 최대 3명)에서 발생 확률이
원래도 낮은 엣지 케이스라 여기까지를 적절한 균형으로 판단했다.

**재검증 후 기존 판단 유지로 확정된 것**: 도움봇의 교시 기록(§7)은 강제
퇴실 판정 입력(참여상태/벌금/페널티 슬롯)과 겹치지 않아 안전, `members:`/
`dataSheetRows:` 2시간 TTL(§9)은 `memberIdentity` 좁은 무효화가 정확히
위험 지점(닉네임/이메일→번호 매칭 후 결정적 쓰기)에만 걸려 있어 안전.
`_exit_define`(구글시트 메뉴 직접 처리, §28)의 "사실상 죽은 경로" 판단은
여전히 코드상 강제되지 않고 사용자 구두 확인에만 의존한다는 점은 그대로
남아있다 — 그 메뉴가 다시 쓰이면 재검토가 필요하다.

같은 세션에서 §35의 패턴(동시 쓰기, 캐시된 값 재검증 없는 실행)이 코드
전반에 더 있는지 전수 탐색해, 부스터디장 임명 상한 미검증·퇴실신청
인덱스·사유반휴 승인 카운트·반휴 큐 인덱스 4건을 추가로 발견했다.
우선순위가 가장 높다고 판단한 사유반휴 승인부터 순차 점검·수정한다
(§36). 나머지 세 건은 아직 미착수.

## 36. 사유반휴 승인 — 동시 승인 시 사용량 소실 위험 (2026-09-11)

`handleAdminLeaveProofDecide`(index.js:5534 부근, 승인 분기)가 "회원+요일
셀의 현재 사용 횟수(prevCount) 읽기 → 잔여량(left) 검증 → nextCount 계산
→ 쓰기"를 락 없이 수행하고 있었다. 2차 점검에서 이 경쟁 조건이 실제로
성립하는 전제("같은 회원·같은 요일에 대기 신청이 2건 이상 존재할 수
있는가")를 확인한 결과, 신청 시점(`handleSetReasonLeaveProof`)과 봇
큐(`leave_proof_manifest.record_request`) 어디에도 "같은 회원+같은 요일"
중복 신청을 막는 검사가 없어, 학생이 같은 요일에 두 번 신청하면 별개
pending 항목 2건이 관리자 목록에 그대로 쌓일 수 있음을 확인했다. 관리자
두 명(또는 한 명이 창 두 개로)이 그 두 건을 거의 동시에 승인하면
`prevCount`를 동일하게 읽어 나중 쓰기가 먼저 반영을 덮어써 사용량 한
건이 조용히 소실되고, `left` 검증도 낡은 스냅샷 기준이라 실제 잔여보다
초과 승인될 수 있었다.

`left`(개인 탭 C41)는 요일과 무관하게 회원 전체가 공유하는 값이라, 락
범위를 신청 단위(요일별)가 아니라 **회원 단위**(`leave:${memberNumber}`)
로 잡았다 — 같은 회원의 서로 다른 요일 승인끼리도 이 값을 두고 경쟁할
수 있기 때문이다. `withMemberLock`(신규등록/번호정렬/벌점승인과 동일
패턴)으로 "읽기→검증→쓰기" 세 단계만 감싸고, 그 뒤에 이어지는 큐 삭제·
봇 동기화·이력 기록(카운트 셀과 무관한 부가 작업)은 락 밖에 그대로 뒀다
— Sheets API 왕복이 읽기 2회(병렬)+쓰기 1회 수준이라 `LOCK_WAIT_TIMEOUT_MS`
(15초) 안에 충분히 끝난다. 잔여량 검증 실패는 신규 등록과 동일하게
예외 대신 `{failure: true}` 마커로 반환해 바깥에서 400 응답으로 변환한다.
`leave:` 접두어는 기존 `pen:`/`merit:`/`newmember:`/`reorder:`와 겹치지
않아 다른 작업과 무관하게 독립적으로 직렬화된다.

## 37. 퇴실신청 인덱스 — 동시 신청/취소 시 다른 회원 항목 소실 위험 (2026-09-11)

`_setExitRequestIndexEntry`/`_removeExitRequestIndexEntry`(index.js:6442
부근)가 15명 전원의 퇴실 신청 정보를 `exitRequestIndex:current`라는 단일
KV 키(JSON 맵)에 락 없이 "읽기→수정→쓰기"로 관리하고 있었다. 신청/동의는
회원 본인이(`handleSetExitRequest`/`handleAgreeExitRequest`), 취소/확정은
주로 관리자가(`handleCancelExitRequest`/`handleAdminExitConfirm`) 트리거해
실제로 겹칠 수 있는 조합이다 — 회원 A가 신청을 제출하는 순간 관리자가
회원 B를 취소·확정하면, 나중 쓰기가 먼저 읽은 맵 전체를 덮어써 다른
회원의 항목이 에러 없이 조용히 사라질 수 있었다.

이 인덱스는 §22(2026-08-27)에서 KV `list()` 하루 한도(1,000회) 소진 사고를
계기로 회원별 개별 키 대신 단일 맵으로 전환된 것이라(`EXIT_REQUEST_INDEX_KEY`
주석 참고), 회원별 키로 되돌리는 구조 변경은 `listExitRequests`(전체
조회)가 다시 `list()`를 필요로 하게 만들어 같은 할당량 문제를 재발시킨다
— 그래서 구조는 그대로 두고 `withMemberLock(env, "exitRequestIndex:global",
...)`로 인덱스 전체를 하나의 임계구역으로 직렬화했다. 회원별 항목이 전부
같은 맵 안에 있어 회원 단위 락(§36의 `leave:${memberNumber}`처럼)으로는
서로 다른 회원 간 경쟁을 막을 수 없으므로, 고정 키(전역 락) 하나로 신청/
동의/취소/확정 네 액션 전부를 순서대로 처리하게 한다. 이 액션들은 회원
생애주기에서 많아야 몇 번뿐이고 KV get/put 각 1회 수준(사유반휴 승인의
Sheets API 왕복보다 훨씬 가벼움)이라 직렬화로 인한 체감 지연은 무시할
만하다. 헬퍼 함수 두 개만 감쌌으므로 호출부(`handleSetExitRequest`/
`handleAgreeExitRequest`/`handleCancelExitRequest`/`handleAdminExitConfirm`
4곳) 각각을 수정할 필요 없이 자동으로 보호된다.

## 38. 부스터디장 임명 — 최대 2명 상한 미검증 (2026-09-11)

`handleAdminSetPartiStatus`(index.js:6934 부근)는 "인원 제한 없이 여러
명을 동시에 부스터디장으로 둘 수 있다"는 설계로 남아있었는데, 실제로는
`getCurrentCoReviewers`/"송출 P 대상 처리"(ReportReviewList) 등 코드
전반이 "부스터디장 최대 2명"을 전제로 짜여 있어(§22) 이 무제한 설계가
버그였다. 2차 점검 결과 3명 이상이 임명돼도 배열 길이에 하드코딩된 로직이
없어 UI가 즉시 깨지지는 않지만(합의 인원이 자연히 4명으로 확장될 뿐),
"부스터디장 2명"이라는 운영 규칙 자체가 조용히 깨지는 건 사실이었다.

`appoint===true`(임명)일 때만 현재 부스터디장 수를 확인해 이미 2명이면
거부하도록 검증을 추가했다(해제는 인원이 줄어드는 방향이라 검증 불필요).
이미 부스터디장인 회원을 다시 임명하는 재임명(no-op)은
`alreadyViceLeader`로 걸러 상한 검증에 걸리지 않고, "A를 B로 교체"도
UI가 해제→임명 2회의 독립 호출이라(전용 교체 API 없음) A 해제가 먼저
반영되면 정상 통과한다.

검증만 추가하면 "조회→검증→쓰기"가 여전히 read-modify-write라 관리자
둘이 서로 다른 회원을 거의 동시에 임명할 때 둘 다 "현재 1명"을 보고
통과해 3명이 될 수 있어(§37과 동일한 패턴), `withMemberLock(env,
"viceLeader:global", ...)`로 전체를 감쌌다 — 부스터디장은 시트 전체에서
최대 2명이라는 전역 제약이라 회원 단위가 아닌 고정 키를 썼다.

**추가로 발견한 것**: `withMemberLock`은 "실행 순서"만 뮤텍스로 강제할
뿐, 락 콜백 안에서 읽는 `coReviewers:` 캐시(TTL 10분) 자체는 여전히 KV
최종 일관성을 따른다 — §35의 퇴실 판정 케이스와 정확히 같은 패턴이라,
락으로 순서를 강제해도 다른 리전에서 방금 처리된 임명이 아직 이 리전의
KV 로컬 복제본에 반영 안 됐을 수 있었다. 상한 검증 직전에
`invalidateMemberCache(["partiStatus"])`(coReviewers 포함, §857행 그룹
정의 참고)로 강제로 지운 뒤 `getCurrentCoReviewers`를 다시 호출해, 락과
캐시 재계산을 함께 적용해야 두 문제(동시 실행 + 최종 일관성)가 모두
방어된다.

## 39. 반휴 큐 인덱스 — 동시 신청/처리 시 항목 소실 위험 (2026-09-11)

`_addToLeaveQueueIndex`/`_removeFromLeaveQueueIndex`(index.js:733 부근)가
`LEAVEQ_INDEX_KEY`(§13에서 KV `list()` 할당량 소진을 계기로 도입된 인덱스,
모든 회원의 pending 사유반휴 신청 요약을 하나의 배열로 담음)에 대해 락
없이 "읽기→배열 조작→쓰기"만 하고 있었다 — §37(퇴실신청 인덱스)과
구조적으로 완전히 동일한 문제.

추가는 학생 본인의 신청 시, 삭제는 학생 본인 철회·봇 재기동 flush·관리자
승인·관리자 반려 총 4곳에서 일어난다. 학생 A가 새 신청을 넣는 순간
관리자가 학생 B의 기존 신청을 승인/반려하거나 봇 flush가 겹치면, 나중
쓰기가 먼저 반영을 덮어써 유령 pending이 남거나 실존 항목이 사라질 수
있었다. §36에서 사유반휴 승인에 적용한 `leave:${memberNumber}` 락은
승인 시 시트 카운트 셀(회원 단위 자원)만 감싸고 이 인덱스 갱신은 명시적
으로 그 락 밖에 있어(§36 주석: "큐 삭제·봇 동기화·이력 기록은 락 밖에")
부족하다 — 여러 회원 id가 섞인 전역 배열이라 회원 단위 락으로는 서로
다른 회원 간 경쟁을 막을 수 없다.

§37과 동일하게 `withMemberLock(env, "leaveQueueIndex:global", ...)`로
두 헬퍼 함수의 get→put 구간 전체를 감쌌다 — 호출부(신청/철회/flush/
승인/반려 총 6곳)는 수정 없이 함수 내부 변경만으로 전부 보호된다.
신청/처리는 회원 생애주기에 많아야 수 회, KV get/put 각 1회 수준이라
직렬화로 인한 체감 지연은 무시할 만하다.

**§35에서 발견한 4건(부스터디장 임명 상한, 퇴실신청 인덱스, 사유반휴
승인, 반휴 큐 인덱스) 전부 점검·수정 완료.**

이 시점에서 범위를 관리자 API 밖으로 넓혀 회원용 API·도움봇 연동·
Durable Object 내부·구글 Apps Script 자동 트리거까지 1차로 폭넓게
탐색했다. 새로 발견한 후보: (a) Apps Script `sheet_reset()`의 시트 삭제
직후 캐시 무효화 누락, (b) 반휴 신청 제출 단계에 잠금 없음, (c) PUSH
구독 인덱스 동시 등록 시 경쟁. 우선순위대로 (a)부터 순차 점검한다.

## 40. Apps Script `sheet_reset()` — 시트 삭제 후 캐시 무효화 누락 (2026-09-11)

`sheet_reset()`(study_sw/assets/appscript.js:1084, 매주 월요일 05:00~
06:00 실행 추정)이 이름에 "퇴실"/"재납"이 포함된 시트를 생성 시점과
무관하게 전부 삭제하는데(1218-1220행, 이름 패턴 매칭만 있고 사이클/
타임스탬프 조건은 없음), 삭제 직후 Worker 쪽 캐시를 무효화하는 호출이
없었다. 같은 함수 앞부분(페널티 사이클 갱신 직후, 1207행)엔 이미
`_notifyWorkerCacheInvalidate({groups:["cycle"]})`가 있어 이 패턴 자체는
낯설지 않다 — 시트 삭제 뒤에만 빠져 있었다.

**2차 점검으로 밝힌 실제 영향**: 처음 우려했던 것과 달리 "잘못된 데이터로
계산"되는 문제는 아니었다. `meta:`/`adminMemberList:`(퇴실자 드롭다운 등,
TTL 최대 2시간)가 삭제 사실을 모른 채 최대 2시간 동안 이미 삭제된
퇴실자를 목록에 계속 보여줄 수 있지만, 그 항목을 클릭해 상세를 조회하면
`buildExitedMemberSnapshot`이 캐시 없이 매번 시트를 직접 재확인해 시트가
없으면 404 "퇴실자 기록을 찾을 수 없습니다"로 정직하게 실패한다 —
"삭제된 게 존재하는 것처럼 잘못 계산"되는 게 아니라 "목록엔 뜨는데
클릭하면 실패"하는 최대 2시간짜리 표시 불일치였다.

**트리거 활성화 여부는 코드로 확인 불가**: 저장소 전체에 `ScriptApp.
newTrigger` 등록 코드가 없다 — `docs/SHEET_APPSCRIPT.md`가 이미 "시간
기반 트리거는 Apps Script 프로젝트 설정에서 별도로 연결되어 있어 이
파일만으로는 정확한 예약 시각을 알 수 없다"고 명시한다(§28의 `_exit_define`
과 같은 종류의 불확실성). `docs/tmp_appscript.js`(git 미추적)는
`_notifyWorkerCacheInvalidate` 도입 이전 시점의 구버전 스크래치 사본으로,
현재 운영 스크립트와 무관하다고 확인했다.

**수정**: 다른 Apps Script 함수들과 동일한 패턴으로, 시트 삭제 직후
`_notifyWorkerCacheInvalidate({ groups: ["roster"] })`를 추가했다 —
`roster` 그룹은 `meta`/`adminMemberList`를 포함한 9종 전부를 지운다
(index.js:852). 근본 해결(삭제 필터에 "이번 주기 시작 이전에 생성됐는지"
조건을 추가)은 "퇴실" 백업명에 타임스탬프가 없어(재납은 있음) 변경
범위가 더 크다고 판단해, 우선 캐시 무효화 추가만 적용했다. **이
저장소의 `study_sw/assets/appscript.js`는 참고용 사본이라, 실제 반영은
구글 스프레드시트의 Apps Script 편집기에 이 파일 내용을 다시 붙여넣어야
한다** — Worker/프론트와 달리 git push나 wrangler deploy로 자동 반영되지
않는다.

## 41. 사유반휴 신청 제출 — 동시 신청 시 중복 pending 방지 (2026-09-11)

`handleSetReasonLeaveProof`(index.js:5261 부근, 학생 본인이 반휴를
신청하는 엔드포인트)의 `left`(잔여량) 검증은 시트 값만 볼 뿐, 이미
큐/봇에 쌓인 같은 회원+같은 요일의 pending 신청 개수는 전혀 감안하지
않았다. 같은 학생이 두 기기(휴대폰+PC)에서 거의 동시에 신청하면 둘 다
같은 `left` 스냅샷을 보고 통과해 중복 pending이 쌓일 수 있었다.

**§36 락만으로는 부족하다는 게 이번 2차 점검의 핵심 발견**이다 — §36
(승인 단계)은 "동시 읽기로 인한 계산 오류"만 막을 뿐, 신청 단계 자체에
"같은 요일 중복 여부를 확인하는 검사"가 아예 없었다. 두 요청이 락으로
순서가 강제돼 순차 처리되더라도, 그 안에서 하는 일이 여전히 "기존
pending 없음"만 매번 확인하고 각자 추가하는 것이라면 락은 아무 효과가
없다 — 중복 신청 문제는 "계산이 틀리는" 문제가 아니라 "애초에 중복
여부를 안 보는" 로직 결함이라, 락 추가만으로는 고쳐지지 않았다.

`handleGetReasonLeaveProof`가 이미 조회에 쓰는 것과 동일한 두 경로
(봇에 이미 전달된 pending, KV 큐에 대기 중인 pending)를 신청 제출
시점에도 확인해 기존 신청이 있으면 409로 거절한다. 봇 조회
(`proxyToBotDashboard`, 최대 8초)는 `LOCK_WAIT_TIMEOUT_MS`(15초) 여유가
빠듯해지므로 락 밖에서 먼저 확인하고, "KV 큐 재확인 + 봇 신규 등록 +
큐 등록"만 §36과 동일한 `leave:${memberNumber}` 락으로 원자적으로
묶었다 — 두 기기의 요청이 순서대로 처리되며 두 번째 요청이 첫 번째가
막 등록한 pending을 보고 거절되게 한다. `withMemberLock`은 key(회원
번호)별로 독립된 락이라 다른 회원의 요청에는 영향이 없고, 같은 회원이
다른 요일에 정상적으로 연달아 신청하는 경우(중복 아님)엔 순차 대기만
발생할 뿐(최악 봇 타임아웃만큼) 거절되지는 않는다. 락 획득 자체가
실패해도(DO 장애 등) `withMemberLock`의 기존 설계대로 잠금 없이 진행
되지만, 그 경우에도 큐 재확인 로직 자체는 여전히 실행돼 완전히
무방비는 아니다.

## 42. PUSH 구독 인덱스 — 동시 등록 시 기기 누락 방지 (2026-09-11)

`getPushDeviceIndex`/`putPushDeviceIndex`(index.js:9196 부근, 회원별
`subIndex:{email}` KV 키에 기기 목록을 담음)를 쓰는 세 경로 — 첫 구독
(`handlePushSubscribe`), 토글/이름변경(`updatePushDeviceIndexEntry`),
삭제(`removePushDeviceIndexEntry`) — 가 전부 락 없는 read-modify-write
였다. 같은 사람이 두 기기(휴대폰+PC)에서 거의 동시에 구독·토글·삭제를
시도하면 나중 쓰기가 먼저 반영을 덮어써 한쪽의 변경이 조용히 사라질
수 있었다.

**2차 점검에서 확인한 결정적 사실**: `getPushDeviceIndex`의 자체 복구
폴백(인덱스가 없으면 `list()`로 원본 `sub:{email}:{endpoint}` 키들을
다시 스캔해 인덱스를 재구성)은 `subIndex:{email}` 키가 **아예 존재하지
않을 때만** 동작한다 — 첫 구독 이후로는 인덱스가 항상 존재하므로 이후
손상은 스스로 복구되지 않는다. 더 결정적으로, 실제 발송(`handlePushSendTest`/
`handlePushSendToMember`)이 오직 이 인덱스만 순회해서 알림을 보낸다 —
인덱스에서 빠진 기기는 원본 구독 데이터가 KV에 멀쩡히 남아있어도
**알림을 영영 못 받는다.**

발생 조건("첫 구독"은 버튼을 눌러 브라우저 알림 권한 프롬프트까지
거쳐야 하는 수동 액션이라 자동 트리거는 아님)을 감안하면 빈도는 높지
않지만, 온보딩 시 "폰이랑 PC 둘 다 켜자"며 짧은 간격으로 연속 조작하는
경우는 현실적이고, 한번 손상되면 자체 복구가 안 된다는 점에서 무시하기
어렵다고 판단했다.

공용 헬퍼 `updatePushDeviceIndexEntry`/`removePushDeviceIndexEntry`
내부를 `withMemberLock(env, `push:${email}`, ...)`로 감싸 토글/이름변경/
삭제 호출부는 수정 없이 전부 보호되며, `handlePushSubscribe`의 읽기→
쓰기 구간도 같은 락 키로 별도로 감쌌다 — 네 경로가 모두 같은 락
네임스페이스를 공유해 서로 간의 경쟁도 함께 방지된다.

**§35에서 1차 폭넓게 탐색해 찾은 신규 후보 3건(Apps Script 시트 초기화
캐시 무효화 누락, 반휴 신청 제출 잠금 부재, PUSH 구독 인덱스 경쟁)
전부 점검·수정 완료.**

## 43. "도움봇 오퍼레이터" 폴링 30초로 재조정 (2026-09-11)

§27에서 "봇 상태 제외 전부 20분 통일" 지시로 제외 대상으로 남겨뒀던
`AdminBotSheetTab.tsx`(도움봇 오퍼레이터 스크린샷 포함)의 1분 고정 폴링을
사용자 지시로 30초로 낮췄다. 이 화면은 KV 캐시가 아니라 매 요청마다
봇이 Selenium으로 화면을 새로 캡처하는 무캐시 실시간 프록시라(§12.1의
"캐시 TTL의 3배" 원칙 대상이 아님), 원래 1분은 "부하는 낮게, 그래도 꽤
실시간"이라는 절충으로 확정된 값이었다 — 너무 짧게 잡으면 제보 캡처·
교시 기록 같은 봇의 다른 작업과 `ctx.lock_element` 락 경합이 늘어난다는
게 그 근거였다. 이번 조정은 그 트레이드오프(락 경합 빈도 증가 가능성)를
감수하고 실시간성을 우선한 것으로, 코드 위험 재검증이 아니라 사용자의
우선순위 재확정이다.

## 44. "화각 불량 제보" 도움봇 연결 오탐 버그 수정 — ParticipantsRoster 재시작 시 stale 오판정 (2026-09-11)

"교시 시작 제한 시간이 아닌데도 도움봇이 가동중이지 않다는 오버레이가
가끔 뜬다"는 제보로 Playwright를 이용해 원인을 조사했다.

**증상 재현·원인 확인**: `ReportPage.tsx`의 `stale`(오버레이 트리거
조건)은 `useRosterPolling` → `GET /participants` → `ParticipantsRoster`
Durable Object가 반환하는 `Date.now() - this.updatedAt > 60초`로
판정된다(`PARTICIPANTS_STALE_MS`). 실제 프로덕션 API를 Playwright로
직접 호출해 봇이 약 10초 주기로 정상 PUT을 보내고 있음을 확인했고,
문제는 `this.updatedAt`(도움봇이 마지막으로 PUT을 보낸 시각)이 **순수
인메모리 필드**였다는 데 있었다 — Cloudflare가 이 DO를 유휴 시 자동
종료했다가 다음 요청에서 새 인스턴스로 재시작시키면(트래픽에 따라
수시로 일어나는, 이 앱이 제어할 수 없는 플랫폼 동작) `updatedAt`이
다시 0으로 리셋됐다. 재시작 직후 봇은 실제로 멀쩡히 동작 중인데도
`Date.now() - 0`이 항상 60초를 넘어 `stale:true`를 잘못 반환했고,
다음 봇 PUT(최대 약 10~15초 이내)이 오면 다시 정상화됐다 — "교시
제한과 무관하게 간헐적으로 잠깐 떴다가 사라지는" 증상과 정확히
일치한다.

**수정**: `ParticipantsRoster`(index.js:8352 부근)의 PUT 핸들러가
`this.updatedAt` 갱신 직후 DO의 영구 저장소(`this.state.storage.put`)
에도 함께 기록하고, 생성자에서 `this.state.blockConcurrencyWhile`로
그 값을 복구하도록 했다 — DO가 재시작돼도 "마지막으로 실제 갱신된
시각"을 이어받아 재시작 여부와 무관하게 정확히 판정한다. 진짜 봇이
오래 응답 없는 경우(복구된 값도 오래됨)엔 여전히 정확히 `stale:true`가
나오므로 오탐만 제거되고 본래 감지 기능은 그대로 유지된다.

**안전성 검증**: `wrangler.toml`에 이 DO가 이미 `new_sqlite_classes`로
등록되어 있어(17-19행) storage API 사용에 추가 마이그레이션이 필요
없음을 확인했다. `blockConcurrencyWhile`은 DO 인스턴스가 처음 뜰 때
(재시작 직후) 딱 한 번, `storage.get` 1회(수 ms)만큼만 첫 요청을
지연시키며, 락(`/lock/acquire`, `LOCK_WAIT_TIMEOUT_MS`=15초)을 포함한
이후 모든 요청엔 영향이 없다. `storage.put` 실패 시 조용히 넘어가되
`console.error`로 로그는 남기도록 했다 — 실패해도 이번 PUT 응답 자체는
막지 않고, 최악의 경우 다음 재시작 때만 이 버그가 재발하는 정도로
영향이 제한적이다.

## 45. 사용량 모니터링 고도화 — 하루/화면/사용자별 KV 쓰기·삭제·list 집계 (2026-09-11)

관리자 Bot·Sheet 탭 "사용량 모니터링"의 `kvWriteBreakdown`(30분,
isolate 인메모리 근사치, §화면별 특정 KV 추적 관련 주석 참고)을 "하루
동안, 어느 메뉴(API 경로)에서, 어느 사용자(관리자+학생 모두)에 의해"
발생했는지까지 보여주도록 확장했다. 목적은 KV 쓰기·삭제 절감 작업(§10
이하 전반)을 이어갈 때 병목을 더 정확히 찾기 위함이다.

**저장소**: 새 Durable Object `UsageStats`(index.js, `ParticipantsRoster`
클래스 바로 뒤)를 신설했다. `ParticipantsRoster`가 `new_sqlite_classes`로
등록돼 있지만 실제로는 `state.storage.get/put`(단순 key-value)만 쓰고
SQL API 전례가 없어(§44에서 재확인), `UsageStats`도 동일한 key-value
패턴(`blockConcurrencyWhile`로 재시작 시 전량 복구)을 따른다 — 회원
15명·관리자 3명 규모에서 SQL은 과함. 키는
`"{date}|{path}|{email}|{op}"`(date는 `todayKSTDateString()`과 동일한
KST YYYY-MM-DD). `wrangler.toml`에 `USAGE_STATS_DO` 바인딩과 `v2`
마이그레이션(`v1`은 그대로 유지)을 추가했다. `/flush`(배치 반영 시 7일
이전 키 정리) / `/today`(해당 날짜 조회) 두 엔드포인트만 둔다.

**이메일 계측 — 핵심 설계 결정**: 처음엔 전역 변수(mutable box)에
세션 이메일을 담아 `verifySession` 내부에서 채우는 방식을 검토했으나
**기각**했다 — `verifySession`(index.js:65) 내부에 `await
crypto.subtle.verify` 등 비동기 지점이 있어, 같은 isolate가 요청을
인터리빙 처리할 때 요청 A가 대기 중 요청 B가 전역을 재할당하면
이메일이 다른 사람 것으로 뒤섞이거나 유실될 위험이 실재했다(2차 조사로
확인). 이 코드베이스는 이미 "모듈 스코프 가변 상태는 요청 간 신뢰
불가"라는 원칙을 여러 곳에서 지키고 있다(§287, §425-430, §6389 등).
75곳 이상의 `verifySession`/`requireAdmin` 호출부를 일일이 고치는
방식도 침습 범위가 커서 기각했다. 대신 **`fetch(rawReq, rawEnv)`
최상단에서 Authorization 헤더를 먼저 파싱해 한 번만 선제적으로
`verifySession`을 호출**해 얻은 이메일을 요청마다 새로 생성되는 지역
변수(`requestEmail`, 전역이 아니므로 동시성 문제 없음)에 담아
`instrumentKvNamespace`에 넘긴다. 각 핸들러 내부의 기존 재검증(실제
권한 판정용)은 그대로 둔다 — HMAC 검증 자체가 가벼워 중복 호출 비용은
무시할 수준이다.

**전송 방식**: 매 KV 호출마다 DO에 실시간 전송하지 않는다(오버헤드 +
"감시가 감시 대상 할당량을 갉아먹는" 역설 방지, §33 이하에서 반복
확인된 원칙과 동일 맥락). `_bumpKvUsageCounter`가 기존 30분짜리
`_kvUsageCounters`와 별개로 `_dailyUsageBuffer`(하루 누적용 임시
버퍼)에도 함께 쌓고, 기존 5분 cron(`scheduled`, 이미 90분 위반인정
만료 처리를 하고 있었음)에 `flushDailyUsageStats` 단계를 추가해
배치로만 DO에 전송한다. `ctx`(ExecutionContext)가 `fetch`/`scheduled`
시그니처에 없어 `waitUntil`을 못 쓴다는 제약을 확인했으나, cron
핸들러는 애초에 막을 응답이 없어 문제되지 않는다.

**프론트**: `AdminUsageResponse.dailyUsage` 필드를 추가하고,
`AdminBotSheetTab.tsx`의 기존 `kvWriteBreakdown` 리스트 바로 아래에
path별로 묶고 그 안에서 email별로 PUT/DEL/LIST 합계를 보여주는 섹션을
추가했다(데이터 없으면 숨김, 기존 패턴과 동일).

**2차 검증**: 선제 `verifySession`이 토큰 없는 요청(비로그인, 봇
X-Bot-Secret 전용 엔드포인트 등)에서 암호 연산 없이 조기 반환됨을
확인, `/flush`·`/today`의 키 파싱(`split("|")`)이 path(URL 경로)·
email(구글 계정) 어디에도 `|` 문자가 올 수 없어 안전함을 확인,
7일 보관 정책이 실제 코드에 구현돼 있음을 재확인, `wrangler.toml`의
`v2` 마이그레이션이 `v1`과 충돌 없이 공존함을 확인.

## 46. `report:` 안전망 큐를 KV에서 영속 DO로 이전 (2026-09-12) — §24.3 결론 정정

§24.3에서 "❌ 안 맞는 경우"로 `report:{id}`(봇이 못 가져간 제보를 나중에
재시도로 집어가야 하는 안전망 큐)를 명시적으로 꼽았었다. 그 판단
자체는 여전히 유효하지만 — **순수 메모리 DO**(`state.storage` 미사용,
`ParticipantsRoster`의 notices/reportCooldowns처럼 재시작 시 빈 배열로
리셋되는 방식)에만 해당된다는 전제를 명확히 해둔다. 이번엔 §45에서
신설한 `UsageStats`와 동일하게 **`state.storage`를 실제로 쓰는 영속
DO**로 옮겼으므로, 재시작(유휴·재배포)해도 생성자의
`blockConcurrencyWhile`이 storage에서 전량 복원해 §24.3이 우려한
"봇이 몇 시간 꺼져 있는 동안 안전망 큐가 소실될 위험"이 발생하지
않는다(사용자 확인: "기능면에서 차이 없다").

계기는 관리자 "사용량 모니터링"에서 KV list() 하루 사용량(1,000회 한도
중 실측 약 59~144회/일)의 사실상 전부가 `handleListReports`(GET
/reports, 도움봇의 10분 안전망 폴링)의
`REPORTS_KV.list({prefix:"report:"})`에서 나온다는 게 확인된 것이다.
list 한도 자체는 여유가 있었지만(14% 수준), 사용자가 "옮겨버려"라고
명시적으로 결정해 진행했다.

**신설 DO**: `ReportQueue`(index.js, `UsageStats` 클래스 바로 뒤) —
`this.entries = new Map()`(id → entry, `expiresAt` 필드 포함)를
`state.storage`와 항상 동기화. 엔드포인트 3개:
- `POST /put` — `{entry, ttlSec}`을 받아 `expiresAt = Date.now() +
  ttlSec*1000`을 붙여 저장(KV `put`+`expirationTtl` 대체).
- `POST /delete` — `{id}` 삭제(KV `delete` 대체).
- `POST /drain` — 만료 안 된 항목 전부를 `ts` 오름차순으로 반환하고
  그 자리에서 전부 삭제, 이미 만료된 항목은 반환 없이 조용히 삭제
  (KV의 `list` + 각 `get` + 각 `delete` + 정렬을 한 번의 DO fetch로
  대체 — Cloudflare KV의 `expirationTtl` 자동 만료 대신 여기서 직접
  타임스탬프로 판정).

`getReportQueueStub(env)`는 `env.REPORT_QUEUE_DO.idFromName("report-queue")`
로 여느 DO와 동일한 싱글턴 패턴. `handleReport`/`handleListReports`/
`handleRequeueReport` 세 함수는 KV 호출을 위 세 엔드포인트 호출로
바꿨을 뿐, 엔드포인트 경로·요청/응답 형식·도움봇 쪽
(`report_intake.py`) 코드는 전혀 바뀌지 않았다.

`wrangler.toml`에 `REPORT_QUEUE_DO` 바인딩과 `tag = "v3"` 마이그레이션
(`new_sqlite_classes = ["ReportQueue"]`)을 추가했다 — v1(`ParticipantsRoster`),
v2(`UsageStats`)에 이어지는 순차 태그.

## 47. leaveq:/exitRequest:/leaveHistory:/reportVote:/leaveApplyRate:를 KV에서 DO로 이전 (2026-09-12)

§46에서 `report:{id}`를 영속 DO(`ReportQueue`)로 옮긴 뒤, "KV로 구현된
나머지 쓰기·삭제 기능도 DO로 전환 가능한가"를 전수 검토했다(사용자
지시: "전환 가능한 것들은 지금 전환하도록 하자"). 검토 결과 다섯 개를
추가로 옮겼다 — 현재 시스템이 개발 중이라 실사용자가 없어(대기 중인
leaveq/exitRequest/reportVote 항목이 API 실측으로 전부 0건임을 확인)
마이그레이션 유실 위험이 없었다.

**`LeaveQueue` DO**(신설, `UsageStats`/`ReportQueue`와 동일하게
`state.storage` 기반 영속): 사유반휴 대기열(`leaveq:{id}` +
`leaveqIndex:current`), 퇴실 신청(`exitRequest:{번호}` +
`exitRequestIndex:current`), 사유반휴 처리 이력(`leaveHistory:
{weekOf}`) 셋을 storage 키 prefix(`leaveq:`/`exit:`/`history:`)로
구분해 통합했다 — 셋 다 "사유반휴·퇴실 처리"라는 같은 도메인이고
트래픽이 낮아 인스턴스를 나눌 실익이 없었다. 퇴실 신청은 회원당 최대
1건이라 DO의 `Map<memberNumber, entry>` 자체가 인덱스를 겸해 별도
인덱스가 필요 없어졌다. §24.3에서 이 두 인덱스를 보호하던 전역 락
(`leaveQueueIndex:global`, `exitRequestIndex:global`, §37/§39)도 DO가
요청을 직렬 처리해 경쟁 조건이 구조적으로 불가능해지므로 함께
제거됐다 — 회원 단위 락(`leave:${memberNumber}`, "같은 회원의 같은
날 중복 신청" 방지 목적)은 인덱스 보호와 무관하므로 그대로 유지했다.

`flushQueuedReasonLeaveProofs`(봇 재기동 시 큐 배출)는 원래 "인덱스가
실제 KV와 어긋나도 list()로 직접 훑는 안전망" 역할이었는데, `LeaveQueue`
DO의 Map은 정의상 storage와 항상 동일한 단일 진실 소스라 그 어긋남
자체가 구조적으로 발생할 수 없다 — 안전망이 무의미해진 게 아니라 그
안전망이 막던 버그 클래스가 원천 제거됐다.

leaveq 항목은 imageBase64(증빙 사진)를 포함해 수 MB에 달할 수 있어,
목록(요약)만 필요한 호출부는 이미지를 뺀 `/leaveq/list`를, 봇에 그대로
전달해야 하는 `flushQueuedReasonLeaveProofs`만 전체를 반환하는
`/leaveq/list-full`을 쓰도록 응답을 분리했다.

**`ReportVote` DO**(신설, 영속): 제보 심각도 투표(`reportVote:{id}:
{번호}`, TTL 7일, 부스터디장 최대 2명)를 이전. 도메인이 달라
`LeaveQueue`와 분리했다. `handleAdminCapturesList`가 항목당 부스터디장
수만큼(§29에서 이미 병렬화했던 KV.get) 하던 조회를 항목당 DO fetch
1회(`/vote/get-batch`)로 더 줄였다.

**`ParticipantsRoster` DO 확장**: 반휴 신청 레이트리밋
(`leaveApplyRate:{번호}`, 60초 창에 최대 2회)은 "지금 이 순간의 상태,
없어져도 그만"이라 §24.3의 "✅ 맞는 경우"에 정확히 해당해, 기존
notices/reportCooldowns와 동일한 순수 메모리 배열 push+filter 패턴으로
`/leave-rate/check` 엔드포인트를 추가했다(storage 영속화 불필요).

`wrangler.toml`에 `LEAVE_QUEUE_DO`/`REPORT_VOTE_DO` 바인딩과
`tag = "v4"` 마이그레이션(`new_sqlite_classes = ["LeaveQueue",
"ReportVote"]`)을 추가했다.

**검증**: Playwright로 프로덕션에서 퇴실 신청→동의→취소, 사유반휴
신청→관리자 반려, 반휴 신청 61초 내 3회 연속 호출(3번째에서 정확히
429) 전부 실제 왕복 확인. `wrangler tail`로 `do/leaveq/put`,
`do/leaveq/delete`, `do/exit/put` 등이 예외 없이 호출됨을 실시간
확인. `/admin/usage`로 이 5개 관련 KV put/delete/list가 배포 이후
전혀 새로 발생하지 않음을 확인(과거 데이터만 남아있고 신규 항목 0건).
배포 직후 변수명 리팩터링 누락(`exitRequestRaw` 잔재)으로 `/status`가
500을 낸 것을 실측(Playwright 콘솔 에러)으로 발견해 즉시 수정·재배포
했다 — 이런 리팩터링 후에는 grep으로 옛 변수명이 완전히 사라졌는지
재확인하는 습관이 필요함을 재확인.

## 48. 남은 6개 KV 자료구조를 DO로 이전 — exitResult/notifyPref/statusMessage/PUSH구독/botUrl/adminOAuth (2026-09-12)

§46/§47에 이어 "KV로 구현된 나머지 것도 DO로 전환 가능한가"를 재검토했다.
사용자 지시: "실익이 없더라도 기능적으로 차이 없이 변환 가능한 구조라면
모두 변경하도록 해." — 남은 6개를 3개 DO로 그룹핑해 전환했다.

**§47까지의 5개와의 중요한 차이**: 이번 6개는 이미 실사용 데이터가
있었다(API 실측: 상태 메시지, 실제 등록된 푸시 구독 기기 등). 사용자가
"기존 값이 있어도 모두 날려버려. 상관없어"라고 명시적으로 확인해,
**백필 마이그레이션 없이** 그대로 전환했다 — 배포 후 알림 설정/상태
메시지/푸시 구독이 초기화됨.

**`MemberSettingsDO`**(신설, 영속): `notifyPref:`, `statusMessage:`,
`exitResult:` 통합. storage 키 prefix(`pref:`/`status:`/`exit:`)로
구분. 퇴실자 전원을 순회하며 개별 get을 병렬 호출하던 3곳
(`handleAdminExitedMembers`/`handleAdminFinesAdminForcedCount`/
`handleAdminBlacklist`)을 `GET /exit/list` 1회 호출로 대체했다(왕복
N회→1회). `handleAdminExitBlacklist`(blacklist 필드만 뒤늦게 덮어쓰던
get+merge+put)는 `/exit/patch`로 옮겨 DO 안에서 원자적으로 처리.

**`PushSubscriptionsDO`**(신설, 영속): `PUSH_SUBS_KV` 전체(`sub:
{email}:{hash}` 원본 + `subIndex:{email}` 인덱스). "인덱스 없으면
list()로 자체복구"하던 마이그레이션 폴백은 DO가 최초 배포 시
storage가 텅 빈 채로 시작하므로 완전히 불필요해져 삭제했다.
`withMemberLock(env, "push:${email}", ...)`(구독/토글/이름변경/삭제
레이스 방지용)도 DO의 직렬 처리로 구조적으로 불필요해져 제거 —
원본 저장+인덱스 갱신을 `/subscribe` 한 번의 DO fetch로 원자적 처리.
발송 실패(404/410) 시 정리도 개별 delete+개별 인덱스 put에서
`/device/prune` 배치 처리로 축소.

**`BotAdminConfigDO`**(신설, 영속): `bot:dashboard_url` +
`admin_oauth:refresh_token`. `botUrl`은 쓰기는 드물지만 거의 모든 봇
프록시 호출(`proxyToBotDashboard`)마다 읽혀 "쓰기 절감"이라는 DO 전환
취지에는 안 맞았지만, 실측상 DO fetch(수 ms) 지연이
`proxyToBotDashboard` 자체(봇 서버까지 수백ms~수초)에 비해 무시할
수준이라 일관성을 위해 함께 전환했다(사용자 확인).

**wrangler.toml**: `MEMBER_SETTINGS_DO`/`PUSH_SUBSCRIPTIONS_DO`/
`BOT_ADMIN_CONFIG_DO` 바인딩 + `tag = "v5"` 마이그레이션 추가.

**검증**: Playwright로 프로덕션에서 알림 설정 조회(초기값 확인)→토글→
재조회, 상태 메시지 설정→삭제→재조회, 푸시 구독 등록→toggle→rename→
remove 전체 사이클, 퇴실 관련 3개 엔드포인트(모두 200, 예외 없음)를
전부 실제 왕복 검증했다. `wrangler tail`로 `do/status`,
`do/status?memberNumber=1` 등이 예외 없이 호출됨을 확인. `/admin/usage`
로 이 6개 관련 KV put/delete가 배포 후 전혀 발생하지 않음을 확인(새로
찍힌 항목은 전부 `sheetCache:` 계열뿐).

**후속 조치 필요**: `bot:dashboard_url`이 초기화되어 관리자 화면의
봇 상태 조회가 실제 상태와 무관하게 "오프라인"으로 보인다 — 봇은
프로세스 시작 시점에만 URL을 재등록하므로, 로컬 PC에서 봇
(`study_manager_260418.py`)을 재시작해야 정상화된다(사용자가 직접
재시작하기로 확인, 코드 변경 불필요).

## 49. 관련 문서

- `docs/WEB_ADMIN.md` §3.1 — `applyOutputPenalty`/`applyReportMerit`/
  `applyTimeDeduction`가 실제로 호출되는 관리자 제보 처리 화면·플로우.
- `docs/WEB_ADMIN.md` §5.1 — "사용량 모니터링" 화면(KV 읽기/쓰기·삭제/
  목록조회 게이지 + 화면별 breakdown).
- `docs/WEB_DASHBOARD.md` — `buildPersonalStatus`/`getPersonalStatusBundle`이
  조립하는 개인 대시보드 데이터의 원본.
- `docs/WEB_REPORT.md` §3.1/§4.1/§7 — `ParticipantsRoster` DO의 원래
  용도(실시간 접속 명단)·PUSH 알림에 새로 얹은 용도·"진행 중인 제보"가
  아직 KV 라이브 인덱스로 남아있는 이유.
