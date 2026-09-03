# 대시보드 기능 구조 지도 (WEB_DASHBOARD.md)

> 이 문서는 웹 서비스(`app/`, Cloudflare Worker `frame-checker-worker/`)의 **대시보드**
> 기능(하단 내비게이션의 "/" 경로, My/All 두 탭)을 프론트~백엔드~시트까지 실제 코드를
> 읽어 조사한 결과입니다. 구현 명령을 내릴 때 과거 맥락을 다시 설명하지 않고 이 문서를
> 참조점으로 삼기 위한 것으로, 코드가 바뀌면 이 문서도 함께 갱신해야 합니다.
>
> 조사 시점: 2026-09-01. 대상 커밋 기준 `app/src/pages/DashboardPage.tsx`,
> `app/src/pages/StatusPage.tsx`, `app/src/pages/RosterPage.tsx`,
> `app/src/components/dashboard/*`, `frame-checker-worker/src/index.js`.

## 1. 범위 정의 — "대시보드"란

`App.tsx`의 최상위 라우팅에서 `"/"` 경로가 렌더링하는 `DashboardPage`를 말한다. 하단 탭바의
"대시보드" 항목이며, 내부에 **My**(`view=me`, 기본값)와 **All**(`view=all`) 두 하위 탭을 가진다.

- **My** → `StatusPage` → `StatusView` — 로그인한 본인(또는 관리자가 선택한 다른 회원)의
  개인 대시보드. 요약 타일 6개 + 요일별 상세 카드 + 반휴 신청.
- **All** → `RosterPage` → `RosterView` — 전체 스터디원 랭킹 + 상금 정산 현황.

**이 문서의 범위에 포함되는 것**: 위 두 탭과 그 하위 다이얼로그, 그리고 이들이 호출하는
백엔드 엔드포인트(`/status`, `/roster-status`, `/cycles`, `/admin/members`,
`/goal-schedule`, `/leave-apply`, `/reason-leave-proof*`).

**포함되지 않는 것(별도 문서로 다룰 예정)**: `SettingsPage`(퇴실신청 다이얼로그, 알림 설정),
`AdminPage`(관리자 전용 탭 전체 — 스터디원 목록, 퇴실 처리, 벌금 현황 등), `ReportPage`,
`CheckerPage`, 푸시 알림 인프라. 이들은 다른 라우트("/settings", "/admin" 등)에 속한다.
`docs/SHEET_STRUCTURE.md`(시트 셀 배치), `docs/SHEET_APPSCRIPT.md`(앱스크립트 트리거),
`docs/HELPERBOT.md`(로컬 봇)는 이미 존재하는 인접 문서이며, 이 문서는 그 위에서 동작하는
**웹 대시보드 조회 계층**만 다룬다.

---

## 2. 화면 계층 트리 (파일 매핑)

```
DashboardPage (app/src/pages/DashboardPage.tsx)
├─ Tabs: "me" | "all"  — URL 쿼리(view, cycle)와 동기화, 최초 마운트 이후엔 로컬 state로만 관리
├─ [me]  StatusPage (pages/StatusPage.tsx)
│         ├─ Select: "내 대시보드" | 다른 회원 (관리자 전용, /admin/members)
│         ├─ CycleSwitcher (components/dashboard/CycleSwitcher.tsx)  — 지난 주 조회
│         ├─ NotificationDialog (components/dashboard/NotificationDialog.tsx)  — ⚠️ 더미 데이터, 실제 API 없음
│         └─ StatusView (components/dashboard/StatusView.tsx)
│             ├─ SummaryTile × 6  (components/dashboard/shared.tsx)
│             │   ├─ 목표시간        → GoalTypeScheduleDialog (edit, 본인만)
│             │   ├─ 가입일자        → (다이얼로그 없음)
│             │   ├─ 총 페널티       → TotalPenaltyDialog
│             │   ├─ 주간 총 상점    → MeritBreakdownDialog
│             │   ├─ 주간 학습시간   → StudyTimeDialog
│             │   └─ 주간 교시 참여율 → PeriodAttendanceDialog
│             ├─ 요일 버튼 그리드(월~일, 7개) — 선택 시 DayDetailCard 전환
│             └─ DayDetailCard (components/dashboard/shared.tsx)
│                 └─ footer: HalfDayLeaveDialog (본인만)
│                     ├─ LeaveApplyButton (일반반휴, 즉시 반영)
│                     └─ 사유반휴 폼 → ImageEditDialog(증빙 이미지 크롭/모자이크, 순수 클라이언트)
└─ [all] RosterPage (pages/RosterPage.tsx)
          ├─ CycleSwitcher
          ├─ "랭킹" 섹션 → RosterView (components/dashboard/RosterView.tsx)
          └─ "상금 정산" 섹션 (RosterPage.tsx 안에 인라인 — 별도 컴포넌트 없음)
```

공용 UI 프리미티브(`ItemTitle`, `TintedPill`, `SummaryTile`, `DividedValue`, `SubRow`,
`InfoCard`, `won()`, `buildDepositCauseItems`, `formatTotalPenalty`, `DayDetailCard`,
`MAX_LEAVES_PER_DAY`)는 전부 `components/dashboard/shared.tsx` 한 파일에 모여 있고, My/All
탭뿐 아니라 관리자 화면(`ExitProcessDialog` 등)에서도 재사용된다.

---

## 3. 데이터 흐름 아키텍처

### 3.1 페이지는 언마운트되지 않는다

`App.tsx`/`DashboardPage.tsx` 모두 탭을 전환해도 컴포넌트를 언마운트하지 않고 `hidden`
속성으로만 감춘다(`everOpened`/`everVisited` ref로 "한 번이라도 열렸는지"를 추적해 처음
열릴 때만 마운트). 이 때문에 두 가지 패턴이 항상 함께 다닌다:

- **`visible` prop**: 지금 실제로 화면에 보이는지. `useRefreshOnVisible(visible, load)`가
  `false → true`로 바뀌는 순간(=사용자가 이 탭으로 "돌아온" 순간)에만 재조회한다. 최초
  마운트 시 자체 `useEffect(load, [])`와 별개로 동작하며 중복 호출하지 않는다.
- **`useTodayIndex()`**: 자정을 넘겨도 화면이 계속 떠 있을 수 있어, "오늘" 요일 인덱스를
  모듈 상수가 아니라 KST 기준 다음 자정에 자동 재계산되는 훅으로 관리한다
  (`hooks/useTodayIndex.ts`). `Intl.DateTimeFormat({timeZone:"Asia/Seoul"})`로 기기
  시간대와 무관하게 KST를 직접 얻는다 — 백엔드가 쓰는 `nowKST()`(UTC+9 트릭)와 결과는
  같아야 하지만 구현 방식은 다르다(프론트는 브라우저 로컬 타임존이 임의값일 수 있어서
  UTC+9 트릭이 통하지 않는다).

### 3.2 "내 상태"는 앱 전역에서 한 번만 캐시된다

`MyStatusProvider`(`lib/status/MyStatusContext.tsx`)가 `/status`(파라미터 없음 = 실시간·
본인) 응답을 앱 전역 Context로 캐시한다. `StatusPage`와 `SettingsPage`가 각자 따로 불러오면
페이지 전환마다 깜빡임이 생기기 때문. **다른 회원 조회 / 과거 사이클(cycle 파라미터) 조회는
이 캐시를 타지 않고 각 페이지(`StatusPage`)가 로컬 state로 별도 호출한다.**

- `refresh()`: 요청마다 `requestIdRef`로 순번을 매겨, 먼저 시작했지만 늦게 도착한 응답이
  나중에 시작된 최신 상태를 덮어쓰지 않게 한다.
- `setStatus(updater)`: 반휴 신청/취소 같은 낙관적 업데이트도 하나의 "이벤트"로 취급해
  같은 순번 체계에 편입시킨다.

### 3.3 API 클라이언트

`useApi()`(`hooks/useApi.ts`) → `apiFetch()`(`lib/api/client.ts`)를 감싸는 얇은 훅. 세션
토큰을 `Authorization: Bearer` 헤더로 자동 첨부하고, 401 응답이면 `logout()` 후
`/login`으로 리다이렉트한다. 대시보드의 모든 API 호출은 이 `call<T>(path, opts)` 하나를
거친다.

---

## 4. My 탭 — StatusView 요약 타일 레퍼런스

`StatusView`가 `status: StatusResponse`(실시간이면 `MyStatusContext`, 아니면 `StatusPage`가
직접 조회) 하나를 받아 그린다. 6개 요약 타일과 각각의 세부 다이얼로그, 데이터 출처:

| 타일 | 값 | 클릭 시 | 백엔드 계산 함수 |
|---|---|---|---|
| 목표시간 | `status.goalType` (괄호 제거 표시) | `GoalTypeScheduleDialog`(본인만, edit) | 개인 탭 O3 |
| 가입일자 | `status.joinDate` ("D+N" 상대값) | 없음 | 개인 탭 I3 |
| 총 페널티 | `송출P N회 │ 주간P N회` (`formatTotalPenalty`) | `TotalPenaltyDialog` | `countCurrentCyclePen` + `getOutputPenSlots` |
| 주간 총 상점 | `+N점 │ 순위` | `MeritBreakdownDialog` | `weeklyMeritBreakdown` 전체 블록 |
| 주간 학습시간 | `실적 │ 목표` | `StudyTimeDialog` | `weeklyStudyTime`/`weeklyGoalTime`/`periodGrid` |
| 주간 교시 참여율 | `비율 │ 85%` | `PeriodAttendanceDialog` | `periodAttendanceBreakdown` |

**예치금 반환 예상액**(`status.depositRefundBreakdown`)은 StatusView 요약 타일에는 없고
`SettingsPage`의 `DepositRefundDialog`가 쓴다 — 단, 계산 자체는 이 문서가 다루는
`buildPersonalStatus` 안에서 함께 이루어진다(§9 참고).

### 4.1 요일 그리드 + DayDetailCard

7개 요일 버튼(`status.days` 또는 재납 병합본, 아래 4.2)을 가로로 나열하고, 선택된 요일의
`DayDetailCard`를 아래에 그린다. 버튼 상태:

- **비활성화**: 미래 요일(`isViewingCycle`이 아니고 `i > TODAY_INDEX`), 또는 가입 전 요일
  (`d.date < status.joinDateExact` — 날짜 문자열 사전식 비교).
- **벌금 미납/납부 뱃지**: `d.paymentStatus` 또는(재납일이면) `depositRefundBreakdown
  .depositAgainStatus`.
- **오늘 표시**: `!isViewingCycle && i === TODAY_INDEX`.

`DayDetailCard`(`shared.tsx`)는 일간 학습시간(로그/보정 포함), 반휴 사용량, 일간 총
벌금(+재납 예치금 병합 표시), 납부확인 상태를 SubRow로 나열한다. 재납이 발생한 요일
(`day.isDepositAgainDay`)에만 "재납 예치금" 서브로우가 붙는다 — 다른 요일에 중복 표시되지
않도록 서버가 이미 그 요일 하나로 한정해서 내려준다.

카드 상단에는 요일/마감·진행중/벌금 납부·미납/예치금 납부·미납 뱃지 한 줄
(`TintedPill` 여러 개)이 있다 — MY 대시보드(이 화면)는 이 뱃지가 핵심 정보라
기본값(`showStatusBadges = true`)대로 그대로 보여준다. 🔧 2026-09: 이 뱃지 줄
전체를 끌 수 있는 `showStatusBadges` prop이 추가됐다 — `docs/WEB_ADMIN.md`
§4의 "벌금 납부 대상자 처리"(`AdminMoneyTab`)가 `false`로 꺼서 쓴다(그
화면은 이미 요일별 그룹 헤더와 "납부확인" SubRow에 같은 정보가 있어 중복
이었음). **이 컴포넌트를 고칠 때는 두 호출부(이 화면과 AdminMoneyTab)
모두에 영향이 없는지 확인할 것** — 공용 컴포넌트라 한쪽만 보고 수정하면
다른 쪽이 깨질 수 있다.

### 4.2 예치금 재납 전/후 병합 (`depositAgainSplit`)

이번 주 안에 예치금 재납(`performDepositAgainReset`)이 있었으면 `status.depositAgainSplit`
이 채워진다. `StatusView`는 `split.days`(재납 전 백업 스냅샷 + 재납 후 현재 값이 요일별로
병합된 배열)를 `status.days` 대신 쓰고, 재납 전 요일을 선택 중이면(`viewingBeforeSplit`)
요약 타일 상단에 반투명 오버레이("예치금 재납 이전 데이터입니다")를 씌우고 순위·상점·
페널티·학습시간·교시참여율 타일의 클릭(모달)을 비활성화한다 — 백업 스냅샷은 다른 시트
참조값(순위 등)을 갖고 있지 않고, 목표시간 대비 비교도 "5일 기준"으로 고정 계산돼 왜곡되기
때문. 자세한 계산은 백엔드 `buildDepositAgainSplit`/`buildDepositAgainSnapshot` 참고
(§9.5).

### 4.3 반휴 신청 흐름

`HalfDayLeaveDialog`가 일반/사유 두 반휴를 한 다이얼로그에서 다룬다:

- **일반반휴** (`LeaveApplyButton`): 스테퍼로 장수(0~2)를 고르고 즉시 `/leave-apply`
  POST — all-or-nothing, 승인 절차 없음.
- **사유반휴** (`HalfDayLeaveDialog` 내부 폼): 증빙 이미지 첨부 필수. 파일 선택 즉시
  `ImageEditDialog`(캔버스 기반 크롭/모자이크 편집기, 순수 클라이언트 — API 호출 없음)가
  뜨고, "완료" 후 `compressImage()`(긴 변 1600px, JPEG 품질 0.8→0.6→0.4 단계적 압축,
  최종 5MB 상한)로 압축해 `/reason-leave-proof` POST. **관리자 승인 전까지 시트에
  반영되지 않는다** — 승인/반려는 이 문서 범위 밖(`AdminPage`의 `ReasonLeaveReviewList`)
  이다. 대기 중이면 "관리자 확인 중" 표시, 반려되면 사유와 함께 재신청 가능.

하루 반휴 합산 상한은 `MAX_LEAVES_PER_DAY = 2`(일반+사유 합계, `shared.tsx`)로 프론트·
백엔드(`MAX_LEAVES_PER_DAY_LIMIT`, index.js) 양쪽에 동일하게 하드코딩되어 있다 — 한쪽만
바꾸면 어긋난다.

---

## 5. All 탭 — RosterView + 상금 정산

`RosterPage`가 `/roster-status`(또는 `?cycle=`) 하나를 조회해 `members`/`money`/
`settlement` 세 부분으로 나눠 그린다.

### 5.1 랭킹 (`RosterView`)

`RosterMember[]`을 순위(`rankValue`, 메달 이모지 1~4위 + 숫자 5위 이후) 오름차순 정렬,
전원 순위가 비어 있으면("-") 회원번호 오름차순으로 대체 정렬. 기본 8명만 보여주고
"더 보기" 버튼으로 전체 펼침(`COLLAPSED_COUNT = 8`).

### 5.2 상금 정산 카드

- **총 모금액** 이하 4개 SubRow: 지난 주 이월 상금 / 이번 주 납부 벌금 / 이번 주 퇴실·
  재납자 납부 벌금 / (조건부) 퇴실·재납자 납부 예치금. 마지막 항목은
  `data.depositOuter`가 `undefined`(백엔드가 아예 필드를 안 보낸 경우)면 통째로 숨긴다.
- **이번 주 정산**: `settlement`가 `undefined`(로딩 전)/`null`(비공개)/`[]`(대상 없음)/
  `SettlementItem[]`(공개) 네 가지 상태를 구분해 각각 다른 문구를 보여준다.

### 5.3 노출 제한 (백엔드 `handleRosterStatus`)

- **`depositOuter`**: `roster.depositOuterIncluded`(이번 주 정산 사이클에 스터디장 개인
  페널티가 포함됐는지)가 false이고 요청자가 관리자가 아니면 응답에서 필드 자체를 삭제한다
  — 스터디장 개인 페널티 발생 여부를 일반 회원에게 간접 노출하지 않기 위함.
- **`settlement`**: 실시간 조회(`cycle` 파라미터 없음)일 때만 시각 제한이 적용된다.
  스터디장(회원번호 "1")은 항상 볼 수 있고, 그 외는 일요일 23:30 KST
  (`isSettlementVisibleToMembers()`, 14교시 종료 시각) 이후에만 필드가 채워진다 — 그
  전엔 필드 자체가 삭제된다. 이미 백업된 과거 주차(cycle 지정)는 그 주가 끝났으므로
  항상 공개.

---

## 6. 지난 기록(사이클) 조회 — `CycleSwitcher`

My/All 두 탭 모두 상단에 `CycleSwitcher`를 둘 수 있고(`DashboardPage`가 `cycleFileId`를
URL 쿼리 `cycle`로 관리해 두 탭에 전달), 실시간(현재) 값과 "현재 진행 중인 사이클(최대
3주) 안에서 이미 지난 주" 값을 토글로 전환한다.

- **`GET /cycles?member=<번호|self>`** → `handleCycleList`: 앱스크립트 `sheet_reset()`이
  매주 월요일 새벽(5~6시 KST) 만드는 Drive 백업 파일(`공부합시당 캠스터디
  YYMMDD-YYMMDD`) 중 **현재 사이클에 속한 것만** 나열한다(`listCurrentCycleBackups` →
  `listBackupFiles` + `currentCycleBackups`, 사이클 판정은 각 백업의 `집계!D25` 값이
  1을 만나는 지점까지 최신순으로 훑는 방식). `member` 파라미터가 있으면 그 회원이 그
  주차 명단에 실제로 있었는지(`hasData`)도 함께 계산 — 중도 가입 회원은 가입 전 주차에
  "데이터 없음"으로 비활성화 표시된다.
- **`resolveTargetFileId(env, accessToken, cycleFileId)`**: `/status`, `/roster-status`,
  `/admin/members`가 공통으로 쓰는 헬퍼. `cycleFileId`가 실제로 현재 사이클에 속하는지
  재검증한 뒤 그 `fileId`(+`weekOf`, "YYMMDD" 월요일)를 반환한다 — 사이클 밖의 임의
  fileId로 과거를 무제한 조회하는 것을 막는 서버 측 방어.
- 백업 파일은 원본과 탭 구조가 동일한 완전한 사본이라, `buildPersonalStatus`/
  `buildRosterStatus`가 `fileId`만 바꿔 그대로 재사용된다 — My/All 탭의 "지난 기록"
  보기는 별도 코드 경로가 아니라 **같은 조회 함수에 다른 fileId를 넣는 것**뿐이다.

> ⚠️ 이 백업 파일 인프라(`listBackupFiles`, `BACKUP_FILENAME_RE`,
> `env.BACKUP_FOLDER_ID`)는 퇴실 정산 처리(`ExitProcessDialog`, `AdminPage` 범위)에서도
> "sheet_reset 이후 지난 주 데이터 참조"용으로 재사용된다 — 이 문서 범위 밖이지만 같은
> 코드를 공유한다는 점만 기록해둔다.

### 6.1 퇴실자 마지막 참여 기록 조회 (2026-09 추가)

`CycleSwitcher`의 "지난 주 백업 파일" 메커니즘은 **퇴실이 발생한 주는 조회할 수
없다** — 퇴실 처리가 그 주의 `sheet_reset`보다 먼저 일어나면, 백업 파일이
만들어지는 시점엔 이미 원본의 그 번호 슬롯이 template으로 초기화된 뒤라
백업에도 빈 슬롯이 그대로 찍힌다(퇴실 이전 주차들은 각각 독립적인 스냅샷이라
영향받지 않는다). 이 빈틈을 메우기 위해 별도 경로를 추가했다:

- **`GET /admin/members`가 "다른 회원 보기" 드롭다운에 퇴실자도 함께 내려준다.**
  원본 스프레드시트에 남아있는 `"{이름} (퇴실)"` 백업 탭(§`docs/WEB_ADMIN.md`
  §3.6의 `performExitReset`이 만드는 것)을 `listExitedMemberEntries`로 찾아,
  `number: "exited:{이름} (퇴실)"`(실제 회원번호와 겹치지 않는 접두사),
  `name: "{이름} (퇴실)"`로 추가한다 — 프론트(`StatusPage.tsx`)는 이 항목을
  다른 회원과 구분 없이 그대로 렌더링하므로 **드롭다운 쪽 프론트 코드 변경은
  필요 없었다.** 재납자(`"{이름} (재납 {타임스탬프})"`)는 대상이 아니다 —
  재납은 `performDepositAgainReset`이 L3를 곧바로 "스터디원"으로 되돌려 그
  회원이 다시 정상 명단에 나타나므로, 이미 `listAllMembers`로 조회된다.
  과거 사이클 백업 파일(`cycle` 쿼리)을 볼 때는 이 항목을 추가하지 않는다 —
  그 파일은 원본과 별개의 Drive 스프레드시트라 "{이름} (퇴실)" 탭 자체가
  없다.
- **`GET /admin/members/exited:{이름} (퇴실)`을 선택하면 `buildExitedMemberSnapshot`
  이 응답한다** — `buildPersonalStatus`를 재사용하지 않는다. 그 함수는
  순위(`getMeritRank`)/제보점수(`getReportScore`)/페널티 슬롯
  (`getOutputPenSlots`)/현재 사이클(`getCurrentPenCycle`)을 전부 "지금
  살아있는 회원"을 전제로 실시간 재조회하는데, 퇴실자는 그 번호 슬롯이
  이미 초기화됐거나(재사용 전) 새 회원 값으로 덮여있어(재사용 후) 그대로
  재사용하면 엉뚱한 값이 나온다. 대신 백업 탭의 A1:U 범위(개인 탭과 동일
  레이아웃 — `copyTo`로 원본을 그대로 복사했으므로)만 읽어 `buildStatusDays`
  등 순수 함수(다른 시트를 참조하지 않는 함수)로 요일별 데이터를 그대로
  재현하고, 실시간 재계산이 불가능한 값(순위 `"- (퇴실자, 조회 불가)"`,
  제보상점/페널티 슬롯 이력 빈 값)은 조회 불가를 뜻하는 자리표시자로 채운다.
  `buildDepositAgainSnapshot`(재납 전/후 분리 표시, §4.2)이 이미 같은
  "스냅샷이라 일부 값은 복원 불가" 패턴을 쓰고 있어 그 관례를 그대로 따랐다.
- **알려진 한계**: 요일별 `days[i].date`(가입 전 요일 비활성화 판정용)는
  실제 퇴실 시점의 주 월요일이 아니라 **조회하는 시점(오늘) 기준 이번 주
  월요일**로 계산된다 — 백업 탭 자체에 "이 스냅샷이 어느 주였는지"를 담은
  메타데이터가 없기 때문. `joinDateExact`(과거 날짜)보다 항상 나중 날짜가
  되므로 "가입 전" 오판정으로 요일이 잘못 비활성화되는 일은 없지만, 이
  `date` 값 자체를 다른 용도로 신뢰해서는 안 된다.

---

## 7. 백엔드 라우트 — 엔드포인트 → 핸들러 매핑

전부 `frame-checker-worker/src/index.js`. 세션 검증(`verifySession`)은 관리자 전용 표시가
없는 한 로그인만 요구한다.

| 메서드 | 경로 | 핸들러 | 비고 |
|---|---|---|---|
| GET | `/status` | `handleStatus` | `?cycle=<fileId>`로 과거 주차 조회 |
| GET | `/roster-status` | `handleRosterStatus` | 〃 |
| GET | `/cycles` | `handleCycleList` | `?member=<번호\|self>` |
| GET | `/admin/members` | `handleAdminMembers` | 관리자 전용, "다른 회원 보기" 드롭다운 |
| GET | `/admin/members/:number` | `handleAdminMemberStatus` | 관리자가 특정 회원 `/status`와 동형 응답 조회 |
| GET | `/goal-schedule` | `handleGetGoalSchedule` | 다음 주 목표시간 예약 조회 |
| POST | `/goal-schedule` | `handleSetGoalSchedule` | 예약 저장(집계 시트 N열, 월요일 오후 트리거가 반영) |
| GET | `/leave-apply?type=normal&day=` | `handleGetLeaveApply` | |
| POST | `/leave-apply` | `handleSetLeaveApply` | `{type:"normal"|"reason", day, count}` |
| GET | `/reason-leave-proof?day=` | `handleGetReasonLeaveProof` | pending/rejected 상태 조회 |
| POST | `/reason-leave-proof` | `handleSetReasonLeaveProof` | 증빙 제출(관리자 승인 대기) |
| POST | `/reason-leave-proof/cancel` | `handleCancelReasonLeaveProof` | 대기 중 신청 본인 철회 |

---

## 8. 핵심 데이터 모델 — `StatusResponse` / `RosterStatusResponse`

전체 필드 정의는 `app/src/lib/api/types.ts`가 원본이며, 여기서는 대시보드가 실제로
읽는 것 중심으로 요약한다.

### `StatusResponse` (from `buildPersonalStatus`)

| 필드 | 용도 |
|---|---|
| `goalType`, `joinDate`, `joinDateExact` | 목표시간/가입일 타일, 요일 비활성화 판정 |
| `weeklyMerit`, `weeklyMeritRank`, `weeklyMeritBreakdown` | 상점 타일 + 세부 모달 |
| `normalLeaveLeft`, `reasonLeaveLeft` | 반휴 잔여량 (요일 무관, 전체 잔여) |
| `depositRefundEstimate`, `depositRefundBreakdown` | (SettingsPage에서 소비, §9.2) |
| `exitRequested`, `exitRequestDate`, `exitAgreedAt` | 퇴실 프로세스 상태(SettingsPage 범위) |
| `periodAttendanceRate`, `periodAttendanceBreakdown`, `periodGrid` | 교시 참여율 타일 + 학습시간 모달의 교시별 그리드 |
| `weeklyGoalTime`, `weeklyStudyTime`, `weeklyTotalFine` | 학습시간 타일 |
| `weeklyOutputPen`, `weeklyTimePen`, `totalPenaltyBreakdown` | 총 페널티 타일 + 세부 모달(적립 이력) |
| `days: StatusDay[]` | 요일 그리드 + DayDetailCard |
| `depositAgainSplit` | 재납 전/후 병합 데이터(§4.2) |

### `RosterStatusResponse` (from `buildRosterStatus`)

| 필드 | 용도 |
|---|---|
| `members: RosterMember[]` | 랭킹 리스트 |
| `collectMoney`, `fineCarry`, `fineThisWeek`, `fineOuter` | 상금 정산 카드 |
| `depositOuter?` | 조건부 노출(§5.3) |
| `settlement?` | 조건부 노출(§5.3) |

---

## 9. 핵심 계산 로직 — 어디서 무엇을 계산하는가

전부 `buildPersonalStatus`(index.js, 약 1730행 근처) 안에서 개인 탭 A1:U43 범위
(`getPersonalTabRows`, 30분 캐시)를 한 번 읽은 뒤 병렬로 보조 조회를 붙이는 구조다.

### 9.1 총 페널티 (`countCurrentCyclePen`)

"데이터" 시트 F~M열(회원번호+3행) 중 **현재 페널티 사이클(`집계!D25`)과 값이 일치하는
슬롯 개수**로 판정한다 — 슬롯에 저장된 값 자체가 "발생 시점의 사이클 번호"다.

- 송출 P = I열("페널티 1차") + K열("페널티 2차") 슬롯 중 일치하는 것. F~K 6개 슬롯 중
  4번째·6번째 위치라 코드 주석에서는 "4차"/"6차"로도 부른다(§10 표와 연결).
- 주간 P = L열("주간P 1차") + M열("주간P 2차") 슬롯 중 일치하는 것.
- F("구두경고 1차")·G/H/J("벌점" 1~3차)는 총 페널티 카운트에 포함되지 않는다 —
  `TotalPenaltyDialog`의 이력 표시(과거 있었던 일)용일 뿐, 반환액·상점 계산에는 관여하지
  않는다(단, G/H/J는 §9.3 상점 차감에서 별도로 쓰인다).

`getOutputPenSlots`가 슬롯 값과 함께 셀 주석(발생일시·사유·캡처ID)을 `PenaltySlotHistoryEntry[]`
로 파싱해 `TotalPenaltyDialog`의 "적립 원인" 섹션에 그대로 전달된다.

### 9.2 예치금 반환 예상액 (`depositRefundBreakdown`)

우선순위 판정(첫 매칭이 이김, 시트 U3 수식과 동일 순서):

1. 참여상태 미확인 → reason만 있고 amount=0
2. 가입 30일 미만(`D+N`의 N<30) → 〃
3. 벌금 시한 내 미납(`fineNoStatus===1`) → 〃
4. 예치금 재납 시한 미납 → 〃
5. 예치금 재납 대상자(이미 "납부"로 재납 완료) → 〃
6. 페널티 2회 이상 → amount=0 (사유 없이 0원)
7. 페널티 1회 → amount = 고지지연이면 0원, 아니면 5,000원
8. 페널티 0회 → amount = 고지지연이면 5,000원, 아니면 10,000원(만액)

**고지지연**(`isLateNotice`): 퇴실 신청 시 등록한 `exitRequestDate`까지 남은 일수가 3일
미만이면 true. 신청 전(exitRequestDate 없음)이면 항상 false.

> 이 함수는 §9.1의 `penCounts`를 그대로 받으므로, 총 페널티 계산이 바뀌면 예치금 반환액도
> 함께 바뀐다 — 두 값은 항상 같은 슬롯 판정 기준을 공유해야 한다.

### 9.3 주간 총 상점 (`weeklyMeritBreakdown`)

```
computedMerit = max(0, round4((studyTimeMerit + reportMerit(조건부)) × multiplier
                              − penaltyDeduction − fineDeduction))
```

- `studyTimeMerit`: 개인 탭 C36 그대로 읽음(로그 학습시간 기반, 시간당 0.1점).
- `reportMerit`: 스터디장/부스터디장이면 항상 0.5(고정), 아니면 "데이터" 시트 R~V열
  제보상점 슬롯 중 현재 사이클과 일치하는 개수 × 0.1. **월~금(주중) 1~14교시가 전부
  채워져야만**(`isWeekdayComplete`) 합산에 포함된다 — 아니면 계산은 그대로 두고 화면에
  0으로 표시(`reportMeritIncluded: false`).
- `multiplier`: 목표시간 유형별 고정 배율(`GOAL_TYPE_MULTIPLIER`, 아래 표) — 단, 사유반휴
  2장 이상 쓴 주는 교시제=1.025, 달성제=1로 강제 강등된다(`multiplierDowngraded` 플래그).
- `penaltyDeduction`: "데이터" G/H/J열(idx `[1,2,4]`, "벌점" 1~3차 슬롯 — 구두경고(F)와
  실제 "페널티" 등급(I=1차, K=2차)은 제외) 중 현재 사이클과 일치하는 개수 × 0.1.
  §9.1의 총 페널티 카운트(I/K열)와는 겹치지 않는 별개 부분집합이니 혼동 주의.
- `fineDeduction`: `weeklyTotalFineAmount / 500 × 0.1`.
- **0점 처리 조건**(`meritZeroConditions`, `순위`도 "-"가 됨): 중도 참여자(가입 7일 미만
  + 이번 주 월요일 칸이 통째로 비어있음) / 페널티 1회 이상 / 주간 벌금 5,000원 초과 /
  사유반휴 3장 이상. 이 중 하나라도 met이면 `weeklyMeritRank`가 `"-"`가 되고, 상점 모달의
  "상점 제외 원인" 카드에 해당 조건이 강조 표시된다.

`GOAL_TYPE_MULTIPLIER` 표:

| 목표시간 값 | 배율 |
|---|---|
| 8H (달성제) | 1 |
| 9H (달성제) | 1.05 |
| 10H (달성제) | 1.1 |
| 8H (교시제) | 1.025 |
| 9H (교시제) | 1.075 |
| 10H (교시제) | 1.125 |

### 9.4 교시 참여율 (`periodAttendanceBreakdown`)

`(85% 이상 달성 교시 + ERR 교시) ÷ 목표 교시 수 × 100`. **교시제 참여자만 적용 가능**
(`applicable: false`면 달성제 — 모달이 "달성제 참여자는 집계되지 않습니다"로 안내).
목표 교시 수는 사유반휴 사용 시 감소한다.

### 9.5 예치금 재납 전/후 스냅샷 (`buildDepositAgainSplit`)

`{회원명} (재납 {timestamp})` 백업 탭 중 가장 최근 것을 찾아(같은 주 여러 번 재납된
극희소 케이스는 최신 것만) `buildDepositAgainSnapshot`으로 가볍게 파싱한다. 이 스냅샷은
순위/제보점수/사이클 페널티처럼 다른 시트를 참조해야 하는 값을 복원할 수 없어 포함하지
않고, 목표 대비 학습시간 비교도 "5일 기준 고정 전제"가 완결 요일 수보다 적을 수 있는
스냅샷엔 왜곡되므로 goalTime을 항상 0으로 고정한다(§4.2 프론트 처리와 대응).

---

## 10. 개인 탭 행/열 상수 빠른 참조

`buildPersonalStatus`가 읽는 개인 탭(1~15번, template) 행 상수 — 전체 시트 레이아웃은
`docs/SHEET_STRUCTURE.md`가 원본이며, 아래는 이 문서(대시보드) 계산과 직결되는 것만 발췌.
행은 0-indexed(index.js 코드 그대로), 시트 상 실제 행 번호는 +1.

| 상수 | 0-idx 행 | 시트 행 | 의미 |
|---|---|---|---|
| `ROW_JOIN_DATE` | 2 | 3행 | I3 "D+n" 상대 가입일 |
| `ROW_PARTI_STATUS` / `COL_PARTI_STATUS` | 2 / 11(L) | L3 | 참여상태 |
| `ROW_ACCESSION_DDAY` / `COL_ACCESSION_DDAY` | 2 / 8(I) | I3 | D+N 원본(퇴실 조건 판정용) |
| `ROW_DEPOSIT_AGAIN` / `COL_DEPOSIT_AGAIN` | 2 / 17(R) | R3 | 예치금 재납 상태(""/미납/납부) |
| `ROW_DEPOSIT_REFUND_ESTIMATE` / `COL_...` | 2 / 20(U) | U3 | 예치금 반환 예상(표시용 텍스트) |
| `STATUS_DAY_COLS` | [2,5,8,11,14,17,20] | C,F,I,L,O,R,U | 요일 시작열(월~일) |
| `ROW_PERIOD_START` ~ `ROW_PERIOD_END` | 5~18 | 6~19행 | 1~14교시 |
| `ROW_NORMAL_LEAVE_USE` / `ROW_REASON_LEAVE_USE` | 19 / 20 | 20/21행 | 요일별 반휴 사용 |
| `ROW_DAILY_STUDY_TIME`~`ROW_WEEKLY_STUDY_TIME` | 24~27 | 25~28행 | 일간/로그/보정/주간 학습시간 |
| `ROW_TOTAL_FINE`/`ROW_GOAL_FINE`/`ROW_MORNING_FINE` | 28/29/30 | 29~31행 | 벌금 |
| `ROW_PAYMENT_CHECK` | 31 | 32행 | 납부확인 |
| `ROW_FINE_NO_STATUS` | 32 | 33행 | 미납신호(0/1) |
| `ROW_WEEKLY_TOTAL_FINE` | 33 | 34행 | 주간 총 벌금 |
| `ROW_WEEKLY_MERIT` | 34 | 35행 | 주간 총 상점 |
| `ROW_STUDY_TIME_MERIT` / `ROW_REPORT_MERIT` | 35 / 36 | 36/37행 | 상점 세부 |
| `ROW_PERIOD_ATTENDANCE_RATE` | 37 | 38행 | 교시 참여율 |
| `ROW_NORMAL_LEAVE_LEFT` / `ROW_REASON_LEAVE_LEFT` | 39 / 40 | 40/41행 | 반휴 잔여 |
| `ROW_REPORT_SHEET_ROW` | 41 | 42행 | "데이터" 시트 참조 행(회원번호+3) |

"데이터" 시트(전 회원 공용, 행=회원번호+3) 열 배치: `OUTPUT_PEN_SLOT_COLUMNS =
["F","G","H","I","J","K"]`(송출P 1~6차), L/M=주간P 1~2차, N~Q=사유반휴 슬롯, R~V=제보상점
슬롯. `집계!D25`가 현재 페널티 사이클(1→2→3→1 순환, 매주 월요일 `sheet_reset`이 갱신) —
서식이 "1/3주차" 텍스트로 입혀져 있어 반드시 `getSheetUnformattedValue`로 읽어야 한다
(포맷된 값으로 읽으면 항상 문자열 불일치로 조용히 실패한다 — 과거 실제 버그였음).

---

## 11. 알려진 함정 / 특이사항

- **`NotificationDialog`는 완전히 더미다.** `DUMMY_NOTIFICATIONS` 하드코딩 배열만 보여줄
  뿐 실제 알림 API가 없다(`TODO(dev-preview)` 주석 있음). "알림 목록이 안 보인다" 류
  버그 리포트는 이 자리부터 확인할 것 — 백엔드를 뒤질 필요 없음.
- **KST 계산이 프론트/백엔드에서 서로 다른 방식으로 두 번 구현되어 있다.** 백엔드
  (Cloudflare Workers, 로컬 타임존 항상 UTC)는 `Date.now() + 9시간` 트릭 +
  `getUTC*()` 게터. 프론트(브라우저, 로컬 타임존 임의)는
  `Intl.DateTimeFormat({timeZone:"Asia/Seoul"})`. 새 KST 계산을 추가할 때 반대쪽
  방식을 그대로 복붙하면 실제로는 틀린 결과가 나온다.
- **`집계!D25`(페널티 사이클)는 항상 `getSheetUnformattedValue`로 읽는다.** 위 §10 참고 —
  서식 파싱 버그가 과거 "일반 회원에게 예치금 반환액이 상시 숨겨지는" 실사용 버그의
  원인이었다.
- **재납 스냅샷(`depositAgainSplit`)과 지난 주 사이클 조회(`cycle` 파라미터)는 서로 다른
  메커니즘이다.** 전자는 "이번 주 안에서 재납이 발생했을 때 그 주 하나를 전/후로 쪼개
  보여주는" 것(개인 탭 안의 재납 백업 탭 참조), 후자는 "완전히 지난 주 전체를 통째로
  보여주는" 것(Drive의 스프레드시트 백업 파일 참조). 둘 다 켜져 있는 조합(과거 사이클
  조회 + 그 주에 재납도 있었던 경우)도 이론상 가능하니 새 기능을 얹을 때 두 분기를
  같이 고려해야 한다.
- **총 페널티(§9.1)와 상점 차감(§9.3)은 "데이터" 시트에서 서로 겹치지 않는 별개 열을
  본다.** 총 페널티는 I/K열("페널티" 등급, 4차·6차 슬롯)만, 상점 차감은 G/H/J열
  ("벌점" 등급, 1~3차 슬롯)만 본다 — 하나만 보고 "페널티 계산이 이상하다"고 판단하면
  안 된다.
- **`buildPersonalStatus`는 항상 라이브 계산이다(스냅샷 아님).** `fileId` 인자만 실시간
  시트 ID 대신 과거 백업 fileId로 바꾸면 그 시점 데이터를 읽는 구조이지, 결과를 미리
  캐시해둔 것이 아니다 — 같은 fileId로 두 번 호출하면 (캐시 TTL 안에서는) 같은 값이지만,
  "그 fileId가 가리키는 시트 자체가 나중에 바뀌면" 값도 바뀐다(예: 백업 파일에 관리자가
  수동으로 접근해 셀을 고친 경우).

---

## 12. 관련 문서

- `docs/SHEET_STRUCTURE.md` — 스프레드시트 탭/셀 배치 원본.
- `docs/SHEET_APPSCRIPT.md` — `sheet_reset()`/`daily_calc()` 등 앱스크립트 트리거.
- `docs/HELPERBOT.md` — 로컬 봇(교시 기록 자동화)과 시트 관계.
- **향후 작성 예정**: 설정 페이지(퇴실 프로세스 — 신청/동의/확정, `DepositRefundDialog`),
  관리자 페이지(스터디원 목록, 퇴실 처리, 벌금 현황, 페널티 후보, 제보 심사), 푸시 알림
  인프라(기기별 구독 관리). 이 문서와 마찬가지로 코드를 직접 재조사해 작성해야 한다.
