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
   `exitStatus:`/`memberRows:`/`meritRank:`/`penSlotGrid:`/`weeklyPaidFine:`)을
   무조건 `.delete()`합니다.** 회원별로 키가 갈라지는 `outputPenSlots:{fileId}:
   {number}`와 `reportScore:{fileId}:{reportRow}`는 `invalidateMemberCache`
   자체는 그 순간 인메모리에 이미 올라와 있던 것만 지우고 KV까지는 손대지
   않습니다 — 회원 번호를 모르는 채로 호출될 수도 있어 여전히 이렇게
   둡니다.
   >
   > 🔧 **[2026-09-09 재검토] 제보 처리 경로는 예외로 즉시 삭제하도록 변경**
   > — 원래는 이 2종도 KV는 자연 TTL 만료(5분/30분)를 기다리도록 설계돼
   > 있었다("회원 수만큼 KV 삭제를 추가로 호출하면 예산을 더 쓴다"는
   > 우려). 그런데 제보 승인/취소/반려 경로(`handleAdminCaptureCancel`/
   > `CancelMerit`/`Decide`/`Delete`/`Revert`)는 애초에 그 액션이 건드린
   > 회원 번호(대상자·제보자, 최대 2명)를 정확히 알고 호출되고, 하루 제보
   > 처리 건수도 많아야 10건 내외임을 확인해(건당 최대 4개 삭제 → 하루
   > 40회 미만, KV 예산에 무시할 수준) — 이 6곳에는 `invalidateMemberCache`
   > 바로 뒤에 `invalidateMemberSlotCache(env, 그_회원번호)`를 추가로 호출해
   > 그 회원의 outputPenSlots/reportScore도 KV까지 즉시 지운다. "회원 번호를
   > 모르는" 나머지 호출부(예: `roster` 그룹의 일부 경로)는 그대로 자연 TTL
   > 만료를 기다린다 — 회원 번호를 확실히 아는 곳에서만 넓혔다.

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
| 제보 승인/취소/반려/유예 (6곳) | `outputPenSlots`/`reportScore`/`penSlotGrid`/`exitStatus` (4종) | **가장 빈번** |
| 벌금 납부 상태 변경 (1곳) | `exitStatus`/`memberRows`/`weeklyPaidFine` (3종) | 중간 |
| 퇴실 신청/동의/취소 (3곳) | `exitStatus` (1종) | 중간 |
| 참여상태(부스터디장) 변경 (1곳) | `exitStatus` (1종) | 낮음 |
| 회원 명단/시트 구조 변경(신규·퇴실·번호이동, 4곳) | 9종 전부 | **저빈도** |

가장 자주 일어나는 제보 처리가 9종 중 무관한 5종(`members`/`meta`/
`meritRank`/`memberRows`/`reportScore` 일부)까지 매번 함께 지우고
있었던 것이 핵심 낭비였다.

**대응**: `invalidateMemberCache(env, groups)`로 시그니처를 확장해,
`MEMBER_CACHE_GROUPS`(`roster`/`penalty`/`fine`/`exitRequest`/
`partiStatus`)에 정의된 좁은 그룹을 호출부가 넘길 수 있게 했다. `groups`를
생략하면 기존과 완전히 동일하게 9종 전부를 무효화하는 걸 기본값으로 유지해
(`roster` 그룹과 동일 — 회원 명단/시트 구조가 바뀌는 4곳은 실제로 9종 전부와
관련 있으므로 그대로 둠) 안전망을 잃지 않는다. 인메모리 무효화(세대
카운터)는 그룹과 무관하게 **항상 전체를 한 번에** 처리한다 — 이건 공짜라
좁혀도 이득이 없고, 좁히면 오히려 "이번엔 무효화 안 된 인메모리 키가
남는" gap 위험만 늘어나기 때문이다. 아끼는 건 오직 KV `.delete()` 호출
수뿐이다.

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
  미달을 판정해 "데이터" 시트 L/M열(주간 P 슬롯, `outputPenSlots:`/
  `reportScore:`/`penSlotGrid:` 캐시가 담는 값)에 관리자 개입 없이 직접
  벌점을 기록한다. 지금까지 이 세 캐시는 "관리자 조작(제보 승인/취소)으로만
  바뀌고, 그건 항상 `invalidateMemberCache`가 무효화한다"는 전제였는데
  이 전제가 정확하지 않았다.
- **`revoke_editor_column_n()`(매주 월 14~15시, 목표시간 마감)** — 개인 탭
  O3(목표시간)에 직접 쓴다. 이 마감 시각이 **웹앱의 신청 마감(매주 월
  14:00)과 정확히 일치**해, 회원이 마감 직후 반영 여부를 확인하려는
  시점과 정확히 겹치는 매주 반복 시나리오였다.
- **`revoke_editor_column_o()`(매일 밤 11시~12시, 반휴 마감)** — 개인 탭
  20행(반휴 사용)에 직접 쓴다. `personalStatus:`가 §7에서 이미 봇의 교시
  리듬(10분)에 맞춰져 있어 영향은 크지 않지만 같은 성격의 gap.

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
  index.js:6171-6189)가 `X-Bot-Secret` 인증 후 `{groups: [...]}` 또는
  `{memberNumbers: [...]}`를 받아 `invalidateMemberCache(env, groups)`
  또는 회원별 `invalidatePersonalStatusCache`를 호출한다.
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

| 화면 | 관련 캐시(TTL) | 폴링 주기 |
|---|---|---|
| `ReportReviewList`(제보 확인) | `penSlotGrid:` 60초 | 3분 |
| `PenaltyCandidateList`(예치금 재납 대상자) | `exitStatus:`/`memberRows:` 60초 | 3분 |
| `AdminMoneyTab`의 `PaidFineList`(벌금 납부 처리) | `memberRows:` 60초/`weeklyPaidFine:` 5분 | 3분(더 짧은 쪽 기준) |
| `MyOutputPenSection`(내 송출 P 제보 확인) | `penSlotGrid:` 60초 | 3분 |
| `StatusPage`(다른 회원/과거 사이클 조회) | `members:`/`meritRank:`/`outputPenSlots:`/`penCycle:` 5분, `reportScore:` 30분 | 15분(가장 짧은 쪽 기준) |
| `MemberRosterList`(참여 스터디원 목록) | `members:`/`meta:` 5분 | 15분 |
| `MyStatusContext`(내 대시보드, 앱 전역 Provider) | `personalStatus:` 10분 등 §12.1 상동 | 15분, 대시보드/설정 화면일 때만(B) + `document.hidden`(A) + 5분 유휴(G, 절전 오버레이) 모두 적용 |

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
| `personalStatus` | 10분 | **10분(유지)** | 도움봇이 교시 종료마다(~10분 간격) 개인 탭에 직접 쓰므로, 그 리듬에 맞춰야 새로고침 시 낡은 값을 안 본다(§7) — 다른 넷과 달리 폴링 주기를 3배로 맞추지 않고 예외로 남겼다 |
| `meritRank` | 5분 | **10분** | 실제 변경 시 `invalidateMemberCache`가 즉시 무효화하므로 TTL은 안전망일 뿐 — 늘려도 위험 없음 |
| `outputPenSlots` | 5분 | **10분** | 위와 동일 + 2026-09-09에 `invalidateMemberSlotCache`로 즉시 무효화까지 추가돼 더 안전 |
| `reportScore` | 30분 | **10분** | 위와 동일한 이유로 낮춰도 안전(오히려 30분일 때보다 배율이 개선됨) |
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

## 15. 관련 문서

- `docs/WEB_ADMIN.md` §3.1 — `applyOutputPenalty`/`applyReportMerit`/
  `applyTimeDeduction`가 실제로 호출되는 관리자 제보 처리 화면·플로우.
- `docs/WEB_DASHBOARD.md` — `buildPersonalStatus`/`getPersonalTabRows`가
  조립하는 개인 대시보드 데이터의 원본.
- `AdminBotSheetTab.tsx`의 "사용량 모니터링" 섹션 — 이 문서가 다루는 KV
  읽기/쓰기·삭제 횟수를 Cloudflare Analytics로 실측해 보여주는 화면(§5.1,
  `docs/WEB_ADMIN.md`).
