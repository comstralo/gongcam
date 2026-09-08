# 캐싱 정책 지도 (CACHING_POLICY.md)

> 이 문서는 Cloudflare Worker 백엔드(`frame-checker-worker/src/index.js`)가
> Google Sheets를 DB로 쓰면서 걸어둔 2단 캐시(인메모리 `_sheetCache` + KV
> `env.REPORTS_KV`)의 전체 구조와, "시트/KV 쓰기 지점 ↔ 캐시 무효화 ↔ TTL"이
> 실제로 정합하게 맞물려 있는지를 코드 전수조사로 확인한 결과입니다.
> `docs/WEB_ADMIN.md`, `docs/WEB_DASHBOARD.md`와 같은 목적·형식으로 작성했으며,
> 코드가 바뀌면(특히 `writeSheetValues` 호출 지점이나 `_cachedCompute` TTL을
> 건드리면) 이 문서도 함께 갱신해야 합니다.
>
> 조사 시점: 2026-09-09. Cloudflare KV 무료 티어 쓰기/삭제 하루 1,000회 한도를
> 예민하게 관리해야 한다는 문제의식에서 시작해, "쓰기 시점 무효화가 실제로
> 필요한 곳을 놓치고 있지는 않은지"(정합성 위험)와 "거의 안 바뀌는데 TTL이
> 짧아 KV를 불필요하게 자주 두드리고 있지는 않은지"(예산 낭비) 두 방향을
> 전수조사했습니다.

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
   `personalStatus:{fileId}:{memberNumber}` 캐시만 인메모리+KV 양쪽에서
   즉시 지웁니다(`invalidatePersonalStatusCache`). 개인 탭에만 쓰는 대부분의
   경로는 이것만으로 충분합니다.
2. **`invalidateMemberCache(env)`** (index.js:837-874): 회원 명단·순위·집계
   등 "여러 회원을 아우르는 파생 캐시" 9종(`MEMBER_CACHE_PREFIXES`)을 한
   번에 무효화합니다.
   ```js
   const MEMBER_CACHE_PREFIXES = [
     "members:", "meta:", "exitStatus:", "memberRows:", "meritRank:",
     "reportScore:", "outputPenSlots:", "penSlotGrid:", "weeklyPaidFine:",
   ];
   ```
   인메모리는 세대 카운터를 올리는 것만으로 9종 전체가 즉시 무효화되어
   공짜입니다. **KV 쪽은 그중 파일 전체가 키 하나인 7종(`members:`/`meta:`/
   `exitStatus:`/`memberRows:`/`meritRank:`/`penSlotGrid:`/`weeklyPaidFine:`)만
   무조건 `.delete()`합니다.** 회원별로 키가 갈라지는 `outputPenSlots:{fileId}:
   {number}`와 `reportScore:{fileId}:{reportRow}`는 그 순간 인메모리에 이미
   올라와 있던 것만 지우고, KV 쪽은 **자연 TTL 만료를 기다리도록 설계**되어
   있습니다(주석에 명시된 의도적 트레이드오프 — 회원 수만큼 KV 삭제를 추가로
   호출하면 KV 쓰기/삭제 예산을 더 많이 쓰기 때문).

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

`_cachedCompute` 12곳 전수조사입니다.

| 캐시 키 prefix | 함수 | TTL | 무효화 경로 |
|---|---|---|---|
| `penCycle:` | `getCurrentPenCycle` | 5분(2026-09 상향, 구 60초) | **없음** — Worker가 쓰는 경로가 전혀 없어 의도적으로 무효화 그룹 밖 |
| `meta:` | `getSpreadsheetMeta` | 5분 | `invalidateMemberCache` |
| `members:` | `listAllMembers` | 5분(2026-09 상향, 구 60초) | `invalidateMemberCache` |
| `meritRank:` | `getMeritRank` | 5분(2026-09 상향, 구 60초) | `invalidateMemberCache` |
| `reportScore:` | `getReportScore` | 30분 | `invalidateMemberCache`(회원별 키 — KV는 자연 만료만) |
| `outputPenSlots:` | `getOutputPenSlots` | 5분 | `invalidateMemberCache`(회원별 키 — KV는 자연 만료만) |
| `personalStatus:` | `getPersonalTabRows` | 10분(2026-09 하향, 구 30분) | `writeSheetValues` 내장 정밀 무효화(§7 — 도움봇 직접 쓰기는 무효화 밖) |
| `memberRows:` | `getSharedMemberRows` | 60초(유지) | `invalidateMemberCache` |
| `weeklyPaidFine:` | `getWeeklyPaidFineTotal` | 5분(2026-09 상향, 구 60초) | `invalidateMemberCache` |
| `penSlotGrid:` | `attachNextOccurrence` | 60초(유지) | `invalidateMemberCache` |
| `exitStatus:` | `getAllExitRelevantStatus` | 60초(유지) | `invalidateMemberCache` |

`buildRosterStatus`, `buildPersonalStatus`(개인 탭 조합 계산 자체)는
`_cachedCompute`를 쓰지 않습니다 — 전자는 매 호출 시트 직접 조회, 후자는
내부적으로 `getPersonalTabRows`만 캐시를 거칩니다.

## 4. 알려진 위험 지점

1. **`penCycle:`(60초, 무효화 없음)** — `집계!D25`는 앱스크립트가 주 단위로만
   갱신하는 값이라 실사용상 위험은 낮지만, 관리자가 그 셀을 수동으로 편집하는
   경로가 있다면 최대 60초 동안 옛 사이클 번호가 여러 파생 계산에 전파될 수
   있습니다. 이 캐시 그룹에서 유일하게 무효화 경로가 전무한 키입니다.
2. **`outputPenSlots:`/`reportScore:`(회원별 키, KV는 자연 TTL 만료에만
   의존)** — 벌점/제보상점을 승인한 요청을 처리한 isolate는 인메모리가 즉시
   비워져 정상 반영되지만, 다른 isolate가 그 직전 KV에 채워둔 캐시는 최대
   5분(`outputPenSlots`)/30분(`reportScore`) 동안 낡은 값을 돌려줄 수
   있습니다. `personalStatus:`가 이미 겪었던 것과 같은 종류의 gap이며, 코드
   주석에 알려진 트레이드오프로 명시되어 있습니다(회원별 KV 삭제를 추가하면
   KV 쓰기 예산을 더 많이 씀).

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

`exitStatus:`/`memberRows:`/`penSlotGrid:`(각 60초, 유지)는 같은 "무효화가
이미 정확함" 논리가 적용되지만, 관리자가 실시간성을 기대하며 자주
새로고침하는 목록/미리보기 화면(퇴실 후보 목록, 납부 상태, 제보 처리 화면의
다음 슬롯 미리보기)이라 **사용성 관점에서 보수적으로 유지**했습니다 —
방금 다른 관리자가 처리한 결과나 자신이 방금 처리한 다음 항목의 미리보기가
1분보다 오래 지연되면 체감 지연이 생길 수 있는 화면들입니다. 데이터
정합성만 보면 늘려도 안전하지만, "사용성을 해치지 않는 선"이라는 조건에서
제외했습니다.

## 6. 다음 단계 (미착수)

이 문서는 조사 결과 기록이며, 아래는 아직 코드에 반영하지 않았습니다.

- `outputPenSlots:`/`reportScore:` 위험 지점(회원별 키라 KV가 자연 TTL
  만료에만 의존)은 별도 이슈로 인지만 하고, 당장은 그대로 유지(KV 삭제를
  늘리는 방향은 예산을 오히려 압박하므로 우선순위 낮음).
- `exitStatus:`/`memberRows:`/`penSlotGrid:`는 정합성만 보면 TTL을 늘릴
  여지가 있지만, 관리자 화면의 체감 실시간성을 해치지 않기 위해 의도적으로
  보류(§5 참고) — 사용 패턴이 바뀌어 이 화면들의 재조회 빈도가 문제가 되면
  재검토.

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

`personalStatus:`(`getPersonalTabRows`) 캐시의 옛 30분 TTL은 "교시(60분)
단위로만 바뀐다"는 전제로 잡혀 있었는데, 실제 갱신 리듬(10분)보다 3배 느슨했다.
그 결과 교시가 끝난 직후 회원이 자기 개인 대시보드를 열어도 최대 30분간
방금 끝난 교시의 참여율이 반영 안 된 값을 볼 수 있었다 — 회원이 확인하고
싶어할 시점(교시 종료 직후)과 정확히 충돌하는 사용성 문제였다. 2026-09-09
TTL을 봇의 실제 쓰기 리듬에 맞춰 **10분**으로 낮췄다(§3 표에 반영).

같은 논리로 다른 캐시들도 봇 쓰기 대상인지 확인했다 — `reportScore:`/
`outputPenSlots:`("데이터" 시트 R~V/F~M열)는 관리자가 제보를 승인/취소할
때만 바뀌고 봇이 쓰는 대상이 아니므로 이 gap과 무관하다(§4의 회원별 키
문제는 별개 사안).

## 9. 프론트 소비 패턴·동시성·번호 재사용 종합 감사 (2026-09-09)

§1~§7의 조사가 "쓰기 지점 ↔ 서버 캐시 무효화" 축에 집중했다면, 이번 감사는
프론트엔드가 그 캐시된 응답을 실제로 어떻게 소비하는지, 그리고 회원 번호가
재사용되는 시나리오까지 넓혀 재점검한 결과다.

### 9.1 번호 재사용 시 회원별 KV 캐시 노출 — 수정 완료

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

### 9.2 관리자 간 화면 동기화는 서버 TTL이 아니라 "탭 재방문"이 지배 변수 — 현행 유지

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

### 9.3 문제없음으로 재확인된 것

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

## 10. 관련 문서

- `docs/WEB_ADMIN.md` §3.1 — `applyOutputPenalty`/`applyReportMerit`/
  `applyTimeDeduction`가 실제로 호출되는 관리자 제보 처리 화면·플로우.
- `docs/WEB_DASHBOARD.md` — `buildPersonalStatus`/`getPersonalTabRows`가
  조립하는 개인 대시보드 데이터의 원본.
- `AdminBotSheetTab.tsx`의 "사용량 모니터링" 섹션 — 이 문서가 다루는 KV
  읽기/쓰기·삭제 횟수를 Cloudflare Analytics로 실측해 보여주는 화면(§5.1,
  `docs/WEB_ADMIN.md`).
