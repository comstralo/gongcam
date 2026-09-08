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
| `penCycle:` | `getCurrentPenCycle` | 60초 | **없음** — 의도적으로 무효화 그룹 밖 |
| `meta:` | `getSpreadsheetMeta` | 5분 | `invalidateMemberCache` |
| `members:` | `listAllMembers` | 60초 | `invalidateMemberCache` |
| `meritRank:` | `getMeritRank` | 60초 | `invalidateMemberCache` |
| `reportScore:` | `getReportScore` | 30분 | `invalidateMemberCache`(회원별 키 — KV는 자연 만료만) |
| `outputPenSlots:` | `getOutputPenSlots` | 5분 | `invalidateMemberCache`(회원별 키 — KV는 자연 만료만) |
| `personalStatus:` | `getPersonalTabRows` | 30분 | `writeSheetValues` 내장 정밀 무효화 |
| `memberRows:` | `getSharedMemberRows` | 60초 | `invalidateMemberCache` |
| `weeklyPaidFine:` | `getWeeklyPaidFineTotal` | 60초 | `invalidateMemberCache` |
| `penSlotGrid:` | `attachNextOccurrence` | 60초 | `invalidateMemberCache` |
| `exitStatus:` | `getAllExitRelevantStatus` | 60초 | `invalidateMemberCache` |

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

아래 세 캐시는 **무효화가 이미 정확히 걸려 있는데도** TTL이 60초로 짧게
잡혀 있어, 실제로는 안 바뀐 값을 매 분 KV에서 재조회(=KV 읽기 소진)하고
있습니다. TTL은 원래 "무효화가 놓친 경우의 안전망"인데, 무효화가 이미
완벽히 커버하는 키는 TTL을 늘려도 신선도 손실이 없습니다.

- **`members:`(60초 → 후보: 5분)** — 회원 명단은 등록/퇴실/재납/번호이동
  같은 관리자 조작 이벤트로만 바뀌며, 그 이벤트들은 전부 `invalidateMemberCache`
  가 즉시 무효화합니다. 성격이 같은 `meta:`가 이미 5분으로 잡혀 있는 것과
  대조적입니다.
- **`meritRank:`(60초 → 후보: 5분)** — `집계!B4:F18`(상점/순위)은 앱스크립트
  일간·주간 집계가 갱신하며, Worker의 쓰기 지점과는 별개 트리거입니다.
  60초 TTL은 "곧 무효화될 캐시"가 아니라 사실상 폴링 주기로 기능하고
  있습니다.
- **`weeklyPaidFine:`(60초 → 후보: 5분)** — `집계!D22`(주간 벌금 합산)는
  벌금 상태 변경(하루 수 회 이하로 추정되는 저빈도 관리자 조작)이나
  앱스크립트 일간 집계로만 바뀌며, 무효화가 5695줄에서 정확히 걸려 있습니다.

`exitStatus:`/`memberRows:`(각 60초)도 같은 논리가 적용되지만, 회원 15명
개인 탭을 batchGet하는 무거운 계산이라 원래 목적이 "동시 마운트 컴포넌트
간 중복 요청 제거"였다는 점에서 더 보수적으로 접근했습니다 — TTL을 늘리는
확장은 이번 조사에서 결론만 내리고 실제 코드 변경은 보류했습니다(아래
"다음 단계" 참고).

## 6. 다음 단계 (미착수)

이 문서는 조사 결과 기록이며, 아직 다음 변경은 코드에 반영하지 않았습니다.

- `members:`/`meritRank:`/`weeklyPaidFine:` TTL을 60초 → 5분 등으로 늘려
  KV 읽기 빈도를 줄이는 안 (정합성 손실 없음, 순수 예산 절감).
- `outputPenSlots:`/`reportScore:` 위험 지점은 별도 이슈로 인지만 하고,
  당장은 그대로 유지(KV 삭제를 늘리는 방향은 예산을 오히려 압박하므로
  우선순위 낮음).
- `penCycle:`은 위험이 낮다고 판단해 이번 조사에서는 변경 대상에서 제외.

## 7. 관련 문서

- `docs/WEB_ADMIN.md` §3.1 — `applyOutputPenalty`/`applyReportMerit`/
  `applyTimeDeduction`가 실제로 호출되는 관리자 제보 처리 화면·플로우.
- `docs/WEB_DASHBOARD.md` — `buildPersonalStatus`/`getPersonalTabRows`가
  조립하는 개인 대시보드 데이터의 원본.
- `AdminBotSheetTab.tsx`의 "사용량 모니터링" 섹션 — 이 문서가 다루는 KV
  읽기/쓰기·삭제 횟수를 Cloudflare Analytics로 실측해 보여주는 화면(§5.1,
  `docs/WEB_ADMIN.md`).
