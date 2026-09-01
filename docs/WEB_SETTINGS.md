# 설정 기능 구조 지도 (WEB_SETTINGS.md)

> 이 문서는 웹 서비스(`app/`, Cloudflare Worker `frame-checker-worker/`)의 **설정**
> 기능(하단 내비게이션의 "/settings" 경로, "계정 관리"/"알림 설정" 두 섹션)을
> 프론트~백엔드~KV까지 실제 코드를 읽어 조사한 결과입니다. `docs/WEB_DASHBOARD.md`,
> `docs/WEB_REPORT.md`와 같은 목적·형식으로 작성했으며, 구현 명령을 내릴 때 이
> 문서를 참조점으로 삼습니다. 코드가 바뀌면 이 문서도 함께 갱신해야 합니다.
>
> 조사 시점: 2026-09-01. 대상 커밋 기준 `app/src/pages/SettingsPage.tsx`,
> `app/src/components/session/SessionCard.tsx`,
> `app/src/components/dashboard/{DepositRefundDialog,PeriodAlarmCard,NotifyPrefsCard}.tsx`,
> `app/src/lib/periodAlarm/*`, `app/src/hooks/usePushSubscription.ts`,
> `app/src/lib/push/*`, `app/public/sw.js`, `frame-checker-worker/src/index.js`.

## 1. 범위 정의 — "설정" 탭이란

`TabBar.tsx`가 `/settings`에 매핑하는 라벨이 "설정"이며, `SettingsPage` 하나가 접힘
가능한(`Collapsible`, 둘 다 기본 열림) 두 섹션을 담고 있다 — 서브 라우팅/탭 전환 없이
한 화면에 세로로 나열된다.

- **계정 관리**(`UserCog` 아이콘) — `SessionCard`(로그인 정보 + 로그아웃) +
  퇴실신청 카드(`DepositRefundDialog`).
- **알림 설정**(`BellRing` 아이콘) — `PeriodAlarmCard`(교시 종소리, 순수 클라이언트) +
  `NotifyPrefsCard`(웹 푸시 구독 on/off, 카테고리별 알림 선호도, 기기별 관리).

`SettingsPage`는 앱 전역 캐시(`MyStatusContext`, `docs/WEB_DASHBOARD.md` §3.2)를
그대로 재사용한다 — 대시보드에서 이미 `/status`를 불러온 상태라면 이 페이지로 넘어와도
재요청 없이 즉시 보여준다. 단, `useRefreshOnVisible(visible, refresh)`로 이 페이지가
다시 보일 때마다(관리자가 다른 화면에서 퇴실/예치금을 처리했을 수 있으므로) 최신
상태를 다시 불러온다.

**포함되지 않는 것(별도 문서 예정)**: 퇴실 신청을 관리자가 확정 처리하는 화면
(`AdminPage`의 "스터디원 목록"/"퇴실 처리" — `ExitProcessDialog`), 관리자 전용 푸시
발송 도구(`AdminPage`의 `PushNotificationSection`). 다만 이 문서가 다루는 흐름이 그쪽
화면의 시작점이므로, 연결 지점만 pointer로 남긴다.

---

## 2. 화면 계층 트리 (파일 매핑)

```
SettingsPage (app/src/pages/SettingsPage.tsx)
├─ useMyStatus() — 전역 /status 캐시 재사용 (WEB_DASHBOARD.md §3.2와 동일 인스턴스)
├─ "계정 관리"
│   ├─ SessionCard (components/session/SessionCard.tsx) — 이름/이메일 표시 + 로그아웃
│   └─ DepositRefundDialog (components/dashboard/DepositRefundDialog.tsx) — "퇴실신청" 카드
│       (status.depositRefundBreakdown이 없으면 다이얼로그 없이 안내 카드만 표시)
└─ "알림 설정"
    ├─ PeriodAlarmCard (components/dashboard/PeriodAlarmCard.tsx)
    │   └─ usePeriodAlarm() → PeriodAlarmContext (App.tsx 최상단에서 전역 마운트)
    │       └─ lib/periods.ts (고정 교시 시간표, 순수 함수)
    └─ NotifyPrefsCard (components/dashboard/NotifyPrefsCard.tsx)
        ├─ usePushSubscription() (hooks/usePushSubscription.ts)
        │   ├─ lib/push/registerSW.ts → public/sw.js (서비스워커)
        │   ├─ lib/push/vapid.ts (VAPID 공개키, base64url 변환)
        │   └─ lib/push/endpointHash.ts (sha256Hex, 서버와 동일 해시로 "이 기기" 식별)
        ├─ 카테고리별 알림 on/off (5종)
        └─ "알림 받는 기기" 목록 (기기별 on/off · 이름변경 · 삭제)
```

---

## 3. 계정 관리 섹션

### 3.1 `SessionCard`

이름(`status.name` 우선, 없으면 세션의 `name`/`email`)과 이메일을 보여주고
"로그아웃" 버튼을 제공한다. 로그아웃은 `useAuth().logout()`(세션 클리어) →
`/login`으로 리다이렉트. API 호출 없는 순수 프론트 로직 — 서버에 별도 로그아웃
엔드포인트가 없다(세션은 클라이언트가 들고 있는 JWT류 토큰을 버리는 것만으로
무효화된다는 뜻).

### 3.2 퇴실신청 (`DepositRefundDialog`)

`status.depositRefundBreakdown`이 있을 때만(=시트에서 정상적으로 계산된 값이 있을
때만) 실제 다이얼로그로 감싼 카드를 보여주고, 없으면 클릭 불가한 안내 카드만
보여준다.

#### 다이얼로그 내용

- **마지막 참여일**: 신청 전이면 날짜 입력(`min = 오늘`), 신청 후면 읽기 전용 표시.
- **예치금 반환 예상액**: 관리자만 실제 금액(₩)을 보고, 일반 회원은 `-`만 보인다
  (`isAdmin` 분기) — 일반 회원에게는 "마지막 참여일 다음 날 확인하실 수 있습니다"
  안내만 노출. 이는 `docs/WEB_DASHBOARD.md` §9.2의 `depositRefundBreakdown`
  값을 그대로 재사용한다.
- **차감 원인**(관리자만): `buildDepositCauseItems(breakdown, lateNoticeRate)`
  (`components/dashboard/shared.tsx`, `docs/WEB_REPORT.md`/Dashboard 문서와
  공유하는 공용 함수)로 벌금미납/예치금미납/30일미만/페널티/고지지연 5항목을 고정
  순서로 보여준다.
- **주의사항**: 조회 당일 기준 안내 + (있다면) `breakdown.reason`(단, "가입 30일
  미만"은 이미 별도 UI가 없어 중복 표시하지 않도록 제외됨).

#### 버튼 3단 분기 (퇴실 프로세스 상태 머신)

`DepositRefundDialog`는 신청/동의 상태에 따라 하단 버튼을 완전히 다른 조합으로
그린다 — 이 상태 머신이 이 카드의 핵심이다:

| 상태 | 조건 | 보여주는 것 |
|---|---|---|
| 신청 전 | `!exitRequested` | "퇴실 신청하기" 버튼 → `POST /exit-request {exitDate}` |
| 신청함, 아직 정산 시점 전 | `exitRequested && !exitDatePassed` | "퇴실 신청 취소" 버튼만 → `POST /exit-request/cancel` |
| 정산 시점 지남, 미동의 | `exitDatePassed && !exitAgreedAt` | "퇴실 신청 취소" + "동의합니다"(2열 그리드) → 후자는 `POST /exit-request/agree` |
| 정산 시점 지남, 동의 완료 | `exitDatePassed && exitAgreedAt` | 안내 Alert만("예치금 정산액에 동의하셨습니다. 관리자 확인 후 처리됩니다.") — 버튼 없음 |

`exitDatePassed = exitRequested && exitDateSettled(exitRequestDate)`.
**`exitDateSettled()`**: exitDate 당일이 KST로 지났다고 바로 동의를 허용하지 않고,
**exitDate 다음날 오전 2시 KST 이후**부터 허용한다 — 앱스크립트 `daily_calc()`가
"그날 다음날 자정~오전 1시 사이"에 실행돼야 그날치 벌금 미납/페널티 판정이 최종
반영되기 때문에, 그 집계가 끝나기 전에 회원이 아직 확정 안 된 값에 동의해버리는
것을 막기 위한 여유 시간이다. 이 함수는 **백엔드(`exitDateSettled`, index.js)와
프론트가 각각 독립적으로 동일한 로직을 구현**하고 있다 — 서버는 `/exit-request/agree`
호출 시 이 조건을 다시 검증해 프론트를 우회한 직접 API 호출도 막는다(§5).

이 화면 자체는 "동의합니다"를 누른 뒤 안내 문구만 보여줄 뿐, **실제 반환액 확정·시트
처리는 하지 않는다** — 동의가 기록되면 그걸 신호로 관리자 쪽 "정산" 처리 버튼이
활성화되는 다음 단계로 넘어갈 뿐이다. 관리자 확인·확정 처리는
`AdminPage`(`ExitProcessDialog`) 몫이며 이 문서 범위 밖이다.

#### 고지지연 미리보기 (`lateNoticeRate`)

퇴실 신청 전(날짜만 고르는 중)에는 서버가 아직 이 날짜를 모르므로, 프론트가 선택한
`selectedDate`로 "이 날짜로 신청하면 며칠 전 고지인지"를 **프론트에서 직접
재계산**해 미리보기로 보여준다(3일 미만이면 50%). 이미 신청을 제출한 뒤에는 서버가
정확히 아는 `breakdown.lateNotice`를 그대로 신뢰해서 쓴다 — 신청 전 미리보기 값은
실제 서버 `amount` 계산에는 아직 반영되지 않은 상태임에 유의(신청을 완료해야 확정).

---

## 4. 알림 설정 섹션

### 4.1 `PeriodAlarmCard` — 교시 종소리(순수 클라이언트, API 없음)

지금 몇 교시/휴식/운영시간 외인지와 남은 시간을 1초 단위로 보여주고, 켜져 있으면
교시 시작/종료 시각에 차임벨(mp3)을 자동 재생한다. **API 호출이 전혀 없다** — 모든
계산이 `lib/periods.ts`의 고정 시간표(1교시 07:20 ~ 14교시 23:30, `study_sw/`의
`timetable.csv`와 동일 값을 프론트에 하드코딩)와 순수 함수 `getPeriodPhase()`로
클라이언트에서만 이루어진다.

- **`PeriodAlarmProvider`는 `App.tsx` 최상단에서 한 번만 마운트된다** — `SettingsPage`
  가 아니라 앱 전역이다. 대시보드/제보 등 다른 탭으로 이동해도 타이머와 차임벨
  재생이 계속된다(이전엔 카드 안에서 직접 `setInterval`을 돌려 카드가 언마운트되면
  알람도 멎는 버그가 있었음 — 코드 주석에 명시).
- **켜짐/꺼짐 상태는 `localStorage`(`periodAlarmSoundEnabled`)에 저장** — 서버에
  전혀 동기화되지 않는다. 기기를 바꾸면 다시 꺼진 상태(기본값)로 시작한다.
  `PUSH 알림`(§4.2)과 달리 계정에 귀속되지 않는 순수 브라우저 설정.
- **잠자기 복귀 시 밀린 알람 스킵**: 직전 tick으로부터 5초 이상 벌어졌으면(맥북
  잠자기 등) 그 사이 지나간 시작/종료 시각의 차임벨을 재생하지 않고 건너뛴다.

### 4.2 `NotifyPrefsCard` — 웹 푸시 구독 + 기기 관리 + 카테고리 선호도

세 가지가 한 카드에 묶여 있다:

**① 구독 on/off** (`usePushSubscription`): `state`가 `checking`/`on`/`off`/
`unsupported` 중 하나. `off`일 때만 "알림 켜기" 버튼이 보인다.

- **켜기**(`enable()`): 브라우저 알림 권한 요청 → 서비스워커 등록
  (`public/sw.js`, `registerServiceWorker()`) → `pushManager.subscribe()`(VAPID
  공개키 사용) → `POST /push/subscribe`로 구독 객체를 서버에 저장.
- **상태 확인**(`check()`): 서비스워커의 `getSubscription()`으로 브라우저가 구독
  객체를 갖고 있는지뿐 아니라, 그 endpoint 해시가 **서버에도 실제로 등록돼
  있는지**(`GET /push/devices`)까지 함께 확인한다 — 둘 중 하나만 확인하면
  "브라우저는 구독 중이라 믿는데 서버 기록은 없어서 실제로는 알림이 안 오는"
  어긋남이 생길 수 있어서다(코드 주석에 명시된 과거 버그 수정 이력).
- **끄기**(기기 목록에서 자기 자신을 토글 off/삭제할 때 `unsubscribeSelf()`가
  함께 호출됨) — 아래 ③ 참고.

**② "알림 받는 기기" 목록** (`GET /push/devices` 등): §7 "함정" 참고 —
서비스워커 재등록·PWA 재설치 등으로 브라우저가 새 endpoint를 받으면 예전엔 옛
구독이 정리되지 않고 계속 쌓였던 문제를, "기기별로 직접 켜고 끄고 지울 수 있게"
바꿔 해결한 구조다.

- 각 기기는 `id`(=KV 키 이름, `sub:{email}:{endpoint의 sha256}`),
  `deviceLabel`(User-Agent로 자동 추정, 예: `"iPhone · Safari"`),
  `enabled`(기본 true), `savedAt`을 가진다.
- **토글**(`/push/devices/toggle`): `enabled`만 바꾼다 — 발송 로직
  (`handlePushSendToMember` 등)이 `enabled === false`인 구독을 건너뛴다. 지금 이
  브라우저 자신의 항목을 끄면(`device.id === selfDeviceId`) 프론트가
  `unsubscribeSelf()`도 함께 호출해 브라우저의 실제 구독도 해지한다.
- **이름변경**(`/push/devices/rename`, 30자 제한): 자동 추정 라벨이 같은 종류
  기기 여러 대에서 겹칠 수 있어 사용자가 직접 구분 가능한 이름으로 바꿀 수 있다.
- **삭제**(`/push/devices/remove`): 구독 정보 자체를 완전히 지운다(되돌릴 수
  없음, 토글과 다름). 자기 자신을 삭제해도 `unsubscribeSelf()` 호출.
- **낙관적 갱신**: 방금 구독을 켠 직후(`enable()`)나 기기 목록을 새로 불러올 때,
  KV의 결과적 일관성(eventual consistency) 때문에 방금 쓴 값이 곧바로 안 보일 수
  있다 — 서버가 `/push/subscribe` 응답에 실어준 `deviceId`/`deviceLabel`을 그대로
  믿어 프론트 state를 즉시 맞추고, 목록 재조회 시에도 그 값이 아직 없으면
  낙관적으로 맨 앞에 끼워 넣는다(`loadDevices()`의 `unshift`).

**③ 카테고리별 알림 on/off** (`GET`/`POST /notify-prefs`): 5개 카테고리
(`report_result`, `leave_proof_result`, `fine_status`, `exit_result`,
`direct_message`) 각각을 스위치로 켜고 끌 수 있다. 기본값은 전부 true.

> ⚠️ **이 카테고리들은 아직 실제 이벤트에 연결되어 있지 않다.** 백엔드 코드
> 주석에 명시: "아직 각 카테고리를 실제 이벤트(제보 승인 등)에 연결하지는 않았고,
> 지금은 회원의 on/off 선호도를 저장/조회하는 것과 관리자가 종류를 골라 수동으로
> 테스트 발송하는 것까지만 지원한다." 즉 회원이 "제보 처리 결과" 알림을 꺼도,
> 지금은 그 상황이 실제로 발생했을 때 자동으로 이 설정을 확인해 발송을 막는
> 코드 자체가 없다 — 저장 인프라만 미리 만들어져 있는 상태다. 관리자가 각
> 카테고리 옆의 "전송" 버튼(`isAdmin`에게만 노출)으로 `POST
> /admin/push/send-category`를 호출해 본인에게 수동 테스트 발송해볼 수 있을
> 뿐이다(꺼둔 카테고리면 `blocked: true`로 차단됨을 확인 가능).

---

## 5. 백엔드 라우트 — 엔드포인트 → 핸들러 매핑

전부 `frame-checker-worker/src/index.js`. 표시 없으면 로그인 세션만 요구(관리자
제한 없음). 여러 엔드포인트가 자기 이메일 소유 여부를 `id.startsWith("sub:{email}:")`
검증으로 강제해, 다른 회원의 기기를 조작할 수 없게 막는다.

| 메서드 | 경로 | 핸들러 | 비고 |
|---|---|---|---|
| POST | `/exit-request` | `handleSetExitRequest` | 새 신청마다 `agreedAt`을 `null`로 초기화 |
| POST | `/exit-request/agree` | `handleAgreeExitRequest` | `exitDateSettled()` 재검증(서버측 방어) |
| POST | `/exit-request/cancel` | `handleCancelExitRequest` | 본인 또는(body에 `number` 지정 시) 관리자 |
| POST | `/push/subscribe` | `handlePushSubscribe` | `deviceId`/`deviceLabel`을 응답에 실어 즉시 신뢰 가능하게 함 |
| GET | `/push/devices` | `handleListPushDevices` | 본인 이메일 접두 기기만 |
| POST | `/push/devices/toggle` | `handlePushDeviceToggle` | |
| POST | `/push/devices/rename` | `handlePushDeviceRename` | 30자 제한 |
| POST | `/push/devices/remove` | `handlePushDeviceRemove` | |
| GET | `/notify-prefs` | `handleGetNotifyPrefs` | |
| POST | `/notify-prefs` | `handleSetNotifyPrefs` | |
| POST | `/admin/push/send-category` | `handleAdminPushSendCategory` | 관리자 전용, 카테고리 차단 테스트용 |

---

## 6. 핵심 데이터 모델

전체 필드 정의는 `app/src/lib/api/types.ts`가 원본. `StatusResponse`의
`depositRefundBreakdown`/`exitRequested`/`exitRequestDate`/`exitAgreedAt`은
`docs/WEB_DASHBOARD.md` §8에 이미 정리되어 있어 여기서는 생략한다.

| 타입 | 필드 | 비고 |
|---|---|---|
| `PushDevice` / `ListPushDevicesResponse` | `id`, `deviceLabel`, `enabled`, `savedAt` / `devices[]` | |
| `PushDeviceToggleResponse` / `RemoveResponse` | `ok: true` | |
| `PushDeviceRenameResponse` | `ok: true`, `deviceLabel` | 서버가 trim한 최종 값을 되돌려줌 |
| `NotifyCategory` | `"report_result" \| "leave_proof_result" \| "fine_status" \| "exit_result" \| "direct_message"` | |
| `NotifyPrefsResponse` | `categories: Record<NotifyCategory,string>`, `prefs: Record<NotifyCategory,boolean>` | |
| `SetNotifyPrefsResponse` | `ok`, `prefs` | |
| `AdminPushSendCategoryResponse` | `ok`, `blocked?`, `message?`, `sent?` | |

KV 저장 구조(참고, `PUSH_SUBS_KV`): 키 `sub:{email}:{sha256(endpoint)}` → 값
`{email, subscription, savedAt, deviceLabel, enabled}`. `REPORTS_KV`: 키
`notifyPref:{memberNumber}` → 값 `Record<NotifyCategory, boolean>`(부분 저장,
`defaultNotifyPrefs()`와 병합해 조회), 키 `exitRequest:{memberNumber}` → 값
`{ts, exitDate, agreedAt}`.

---

## 7. 알려진 함정 / 특이사항

- **알림 설정의 5개 카테고리는 아직 "저장만 되고 실제로 쓰이지는 않는" 상태다.**
  §4.2 참고 — "제보 결과 알림을 껐는데도 온다/안 온다" 류 리포트를 받으면, 애초에
  이 카테고리를 검사해서 발송을 막거나 보내는 실제 이벤트 코드가 없다는 사실부터
  확인할 것. `docs/WEB_DASHBOARD.md`의 `NotificationDialog`(완전 더미)와는
  다른 종류의 미완성이다 — 이쪽은 저장 인프라는 실재하고 발송 트리거만 없다.
- **`exitDateSettled()`이 프론트(`DepositRefundDialog.tsx`)와 백엔드(`index.js`)에
  중복 구현되어 있다.** 로직(exitDate 다음날 02:00 KST)이 동일해야 하며, 한쪽만
  고치면 "프론트는 동의 버튼을 보여주는데 서버는 거부한다" 같은 불일치가 생긴다.
- **`DepositRefundDialog`의 `todayStr()`은 KST가 아니라 UTC 기준이다**
  (`new Date().toISOString().slice(0,10)`). 날짜 입력 `min` 속성과 고지지연
  미리보기(`lateNoticeRate`, 신청 전 한정) 계산에 쓰인다 — 자정 근처(KST 00:00~
  08:59, 즉 UTC로는 아직 전날)에는 "오늘"이 실제 KST 날짜보다 하루 이르게 잡혀,
  이 좁은 시간대에 한해 날짜 선택 최솟값이나 미리보기 계산이 살짝 어긋날 수 있다.
  이미 신청을 제출한 뒤의 확정 판정(`exitDateSettled`, `depositRefundBreakdown.
  lateNotice`)은 서버의 KST 계산을 그대로 신뢰하므로 영향받지 않는다 — 영향 범위는
  "아직 신청 전, 날짜를 고르는 중"인 좁은 창에 한정된다.
- **`PeriodAlarmCard`의 시간 계산은 KST를 명시하지 않고 기기 로컬 시간대를 그대로
  쓴다**(`PeriodAlarmContext.tsx`의 `todayMidnightMs()` → `new Date();
  d.setHours(0,0,0,0)`). 대시보드(`useTodayIndex`)나 백엔드(`nowKST()`)가 항상
  KST를 명시적으로 계산하는 것과 다른 패턴이다 — 참여자가 전부 한국에서 접속한다는
  전제하에선 문제없지만, 기기 시간대가 잘못 설정돼 있거나 해외에서 접속하면 교시
  시작/종료 시각과 차임벨 타이밍이 실제 교시와 어긋난다.
- **서비스워커(`public/sw.js`)에 GitHub Pages 서브패스(`/gongcam/`)가
  하드코딩되어 있다** — 알림 아이콘 경로와 `notificationclick`의 fallback
  `openWindow` 대상. 배포 base 경로가 바뀌면 `vite.config.ts`뿐 아니라 이 파일도
  함께 고쳐야 한다(코드 주석에도 명시).
- **`usePushSubscription`의 `sendTest()`는 `NotifyPrefsCard`(설정 탭)가 아니라
  `AdminPage`의 `PushNotificationSection`에서만 쓰인다.** 같은 훅을 두 화면이
  공유하지만 노출하는 기능은 다르다 — 설정 탭에는 "테스트 발송" 버튼이 없다.
- **기기 삭제(`remove`)는 되돌릴 수 없지만 토글(`toggle`)은 되돌릴 수 있다.**
  "죽은 기기 정리"가 목적이면 toggle로 충분한 경우가 많다 — remove는 그 기기의
  구독 자체(재구독 없이는 복구 불가)를 지운다는 점을 UI 문구 등에서 헷갈리지
  않게 유지할 것.

---

## 8. 관련 문서

- `docs/WEB_DASHBOARD.md` — `depositRefundBreakdown`/총 페널티 계산 원본,
  `MyStatusContext` 캐시 구조.
- `docs/WEB_REPORT.md` — `buildDepositCauseItems` 등 공용 헬퍼 재사용,
  `_appendToLiveIndex` 패턴과는 무관(이 문서의 기능들은 KV 단건 저장/조회만 씀).
- **향후 작성 예정**: 관리자 페이지(퇴실 처리 `ExitProcessDialog`, 푸시 발송 도구
  `PushNotificationSection`, 스터디원 목록). 이 문서가 다루는 "회원 쪽 신청/동의"·
  "회원 쪽 알림 on/off"가 그 화면들의 입력값이 된다.
