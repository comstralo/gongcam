# 제보 기능 구조 지도 (WEB_REPORT.md)

> 이 문서는 웹 서비스(`app/`, Cloudflare Worker `frame-checker-worker/`)의 **제보**
> 기능(하단 내비게이션의 "/report" 경로, "송출 P 제보"/"PUSH 알림 전송" 두 탭)을
> 프론트~백엔드~KV까지 실제 코드를 읽어 조사한 결과입니다. `docs/WEB_DASHBOARD.md`와
> 같은 목적·형식으로 작성했으며, 구현 명령을 내릴 때 이 문서를 참조점으로 삼습니다.
> 코드가 바뀌면 이 문서도 함께 갱신해야 합니다.
>
> 조사 시점: 2026-09-01. 대상 커밋 기준 `app/src/pages/ReportPage.tsx`,
> `app/src/components/report/*`, `app/src/hooks/useRosterPolling.ts`,
> `frame-checker-worker/src/index.js`.

## 1. 범위 정의 — "제보" 탭이란

`TabBar.tsx`가 `/report`에 매핑하는 라벨이 "제보"이며, 실제로는 `ReportPage` 하나가
URL 쿼리 `?tab=`으로 관리하는 두 하위 탭을 담고 있다(기본값 "capture"):

- **송출 P 제보**(`view=capture`, 기본) — 화각 이탈/근거리 송출 등을 스크린샷·영상으로
  제보하는 화면. 실제 페널티(§6)로 이어지는 시작점.
- **PUSH 알림 전송**(`view=notice`) — 관리자 승인 절차 없이 로그인한 누구나 다른
  참여자에게 짧은 문구(현재는 "타이머 멈춤" 하나)를 웹 푸시로 즉시 보내는 화면.
  실제 시트를 건드리지 않는 순수 알림 기능으로, 제보와는 무관하지만 같은 메뉴에
  얹혀 있다("제보"만큼 무거운 절차 없이 가볍게 주의를 환기하는 용도).

두 탭 모두 로그인만 되어 있으면(관리자 여부 무관) 누구나 쓸 수 있다 — 관리자는 각
탭의 쿨다운(20분/10분)만 우회한다.

**포함되지 않는 것(별도 문서 예정)**: 관리자가 제보 캡처를 승인/반려하는 화면
(`AdminPage`의 "제보 심사" — `PenaltyCandidateList`, `ReportReviewList` 등), 로컬
봇(`study_manager_260418.py`)의 캡처 로직 자체(`docs/HELPERBOT.md` 참고). 다만
§6에서 제보 제출 이후 실제로 페널티가 시트에 반영되기까지의 백엔드 흐름은 "제보"
기능을 이해하는 데 필수적이라 함께 다룬다.

---

## 2. 화면 계층 트리 (파일 매핑)

```
ReportPage (app/src/pages/ReportPage.tsx)
├─ useRosterPolling (hooks/useRosterPolling.ts) — 15초 폴링, 두 탭이 공유
├─ Tabs: "capture"(기본) | "notice"  — URL 쿼리(tab)와 동기화, 최초 마운트 이후 로컬 state
├─ [capture] "송출 P 제보"
│   ├─ 대상자 Select (members, 실시간 접속 명단)
│   ├─ 원인 Select (REASON_OPTIONS: "모호한 송출" | "근거리 송출" — 하드코딩)
│   ├─ "스크린샷 제보" / "영상 제보" 버튼 → POST /report
│   ├─ ActiveReportsSection (components/report/ActiveReportsSection.tsx)
│   │   └─ GET /report-cooldowns, 15초 폴링 + 1초 카운트다운
│   └─ 주의사항 InfoCard (REPORT_CAUTIONS 배열)
└─ [notice] "PUSH 알림 전송"
    └─ SimpleNoticeSection (components/report/SimpleNoticeSection.tsx)
        ├─ 구독 여부 사전 조회: GET /push/subscription-status
        ├─ 대상자 Select (구독 안 한 회원은 "(PUSH OFF)"로 비활성 표시)
        ├─ 원인 Select (NOTICE_REASON_OPTIONS: "타이머 멈춤" 하나뿐 — 하드코딩)
        ├─ "알림 전송" 버튼 → POST /push/send-to-member
        ├─ RecentNoticesSection (components/report/RecentNoticesSection.tsx)
        │   └─ GET /push/recent-notices, 15초 폴링 + 1초 경과시간 갱신
        └─ 주의사항 InfoCard (NOTICE_CAUTIONS 배열)
```

두 서브탭 모두 `App.tsx`/`DashboardPage.tsx`와 같은 "언마운트하지 않고 hidden으로만
감춘다" 패턴을 그대로 따른다(`everOpened` ref).

---

## 3. "송출 P 제보" 탭 상세

### 3.1 실시간 접속 명단 (`useRosterPolling` + `ParticipantsRoster` Durable Object)

대상자 드롭다운은 시트가 아니라 **로컬 봇이 실시간으로 밀어넣는 구루미 접속자 명단**을
쓴다 — 지금 화면에 없는 사람을 제보 대상으로 고를 수 없게 하기 위함.

- 프론트: `useRosterPolling()`이 `GET /participants`를 15초 간격으로 폴링,
  `{members, stale}`을 반환. 드롭다운을 열 때(`onOpenChange`)도 즉시 한 번 더
  갱신한다.
- 백엔드: `GET /participants` → `handleGetParticipants` → Durable Object
  `ParticipantsRoster`(단일 인스턴스, 이름 `"gooroomee-room"`, `getRosterStub`)에
  프록시. 로컬 봇이 `PUT /participants`(→ `handlePutParticipants`, `X-Bot-Secret`
  헤더로 인증)로 주기적으로 멤버 배열(최대 200명)을 밀어넣으면 DO가 메모리에
  들고 있다가 GET에 그대로 응답한다.
- **`stale`**: DO가 마지막으로 PUT을 받은 시각으로부터 60초
  (`PARTICIPANTS_STALE_MS`)가 지나면 true — "봇이 꺼져 있다/연결이 끊겼다"는 뜻.
  프론트는 `stale`이면 드롭다운·제보 버튼을 비활성화하고 "도움봇이 가동중이지
  않습니다"로 안내한다.
- **KV가 아니라 Durable Object를 쓰는 이유**(코드 주석): KV는 하루 쓰기 1,000회
  제한이 있어 수 초 간격 갱신에 부적합 — DO는 쓰기 제한이 없는 메모리 상주
  객체라 이 용도에 맞다.

### 3.2 제보 제출 (`POST /report` → `handleReport`)

1. `{token, nickname, reason, mode}` 필수(토큰은 body에 실어 보낸다 — `tokenInBody:
   true`, 이 엔드포인트만 `Authorization` 헤더 대신 body 토큰을 쓰는 예외적
   패턴이니 유의).
2. **20분 쿨다운**(`REPORT_COOLDOWN_SEC = 20*60`): 같은 닉네임(`cooldown:{nickname}`
   KV 키, TTL 20분)에 이미 진행 중인 제보가 있으면 429. **스크린샷/영상 모드와
   무관하게 닉네임 기준으로 공유** — 모드를 바꿔 우회하지 못하게 막는다. 관리자
   (`session.email === ADMIN_EMAIL`)는 이 쿨다운을 우회한다.
3. `report:{uuid}` KV(6시간 TTL)에 제보 원본 저장, 쿨다운 키 기록, 그리고
   `_appendToLiveIndex(COOLDOWN_INDEX_KEY, ...)`로 "진행 중인 제보" 목록용 공유
   인덱스에도 즉시 반영.
4. **봇에게 즉시 통지**: `proxyToBotDashboard(env, "/reports/new", POST)`로 로컬
   봇의 상태 서버(Cloudflare Tunnel 경유)에 바로 알린다. 이건 지연 없이 캡처를
   시작시키기 위한 최적 경로일 뿐 — 실패해도(봇이 그 순간 꺼져 있어도) 예외를
   던지지 않고 조용히 넘어간다.
5. **폴링 안전망**: `GET /reports`(→ `handleListReports`, `X-Bot-Secret` 인증,
   프론트에서는 호출하지 않음)가 `report:*` KV를 통째로 읽어 반환하며 **읽은 즉시
   전부 삭제**한다 — at-most-once 소비 큐다. 코드 주석에 따르면 봇 쪽의
   `report_intake.py`가 훨씬 낮은 빈도로 이 엔드포인트를 폴링해, 4번의 즉시 푸시가
   실패했을 때(봇이 그 순간 오프라인)를 놓치지 않기 위한 안전망 역할을 한다.

### 3.3 "최근 진행된 제보" (`ActiveReportsSection`)

`GET /report-cooldowns` → `handleListActiveCooldowns`가 `_readLiveIndex
(COOLDOWN_INDEX_KEY)`(KV.list() 없이 인덱스 배열 하나만 읽는 최적화, §7 참고)를
만료 임박순(`expiresAt` 오름차순)으로 반환. 15초 폴링 + 1초 카운트다운 타이머로
"몇 분 몇 초 남음"을 실시간 표시한다 — 이미 서버가 429로 중복 제보를 막지만, 누르기
전에 "이미 접수됐구나"를 보여줘 헛수고를 줄이는 목적. 관리자가 쿨다운을 우회해
제보해도(§3.2) 이 목록에는 똑같이 뜬다 — 그러지 않으면 참여자 입장에서 "방금 분명
제보됐는데 목록엔 없다"는 혼란이 생기기 때문(코드 주석에 명시된 의도적 설계).

---

## 4. "PUSH 알림 전송" 탭 상세

시트를 전혀 건드리지 않는 순수 알림 기능. `SimpleNoticeSection`이 대상자·원인
드롭다운을 보여주고 `POST /push/send-to-member`로 전송한다.

- **원인 → 실제 문구 분리**: `NOTICE_REASON_OPTIONS`의 `value`(드롭다운 표시/선택용)
  와 `message`(실제 푸시에 담기는 문장)가 다르다 — 예: `value: "타이머 멈춤"` →
  `message: "타이머가 멈춰있어요. 확인해 주세요."`. 지금은 옵션이 하나뿐이라 프론트
  하드코딩 배열(`components/report/SimpleNoticeSection.tsx`)만 수정하면 늘릴 수
  있다.
- **구독 여부 사전 확인**: 다이얼로그가 열리자마자(컴포넌트 마운트 시)
  `GET /push/subscription-status`(→ `handlePushSubscriptionStatus`)로 전 회원의
  웹 푸시 구독 이메일 집합을 한 번에 가져온다(`PUSH_SUBS_KV`를 `sub:` 접두사로
  list, 회원별 개별 조회 없이 배치 판정). 구독 안 한 회원은 드롭다운에서
  `"{이름} (PUSH OFF)"`로 표시되고 선택 자체가 막힌다(`disabled`).
- **`POST /push/send-to-member` → `handlePushSendToMember`**:
  1. **10분 쿨다운**(`NOTICE_COOLDOWN_SEC = 10*60`, `notice-cooldown:{nickname}` KV
     키) — 관리자는 우회.
  2. `listAllMembers`에서 닉네임과 이름이 정확히 일치하는 회원을 찾고, 그 이메일로
     `PUSH_SUBS_KV`에서 `sub:{email}:*` 구독을 전부 조회 — 없으면 404("아직 알림을
     켜지 않았습니다").
  3. 등록된 모든 기기 구독에 `sendWebPush`로 발송(`{title: "{발신자}님의 알림",
     body: 문구}`). 발송 중 404/410(만료된 구독)을 만나면 그 자리에서 KV 구독을
     삭제해 정리한다. 하나라도 성공(`sent>0`)하면 성공 응답, 전부 실패하면 502.
  4. 성공 시 쿨다운 키 기록 + `_appendToLiveIndex(NOTICE_INDEX_KEY, ...)`로
     "최근 전송된 알림" 인덱스에 추가.
- **"최근 전송된 알림"** (`RecentNoticesSection`): `GET /push/recent-notices` →
  `handleListRecentNotices`가 `NOTICE_INDEX_KEY` 인덱스를 그대로 반환. 15초 폴링 +
  1초 경과시간(`N분 전`) 갱신 — §3.3과 동일한 목적·패턴.

---

## 5. 백엔드 라우트 — 엔드포인트 → 핸들러 매핑

전부 `frame-checker-worker/src/index.js`. `X-Bot-Secret` 표시가 있는 것은 로컬 봇
전용(브라우저 세션이 아니라 `env.BOT_SECRET` 헤더로 인증)이고, 나머지는 로그인 세션만
요구한다(관리자 제한 없음).

| 메서드 | 경로 | 핸들러 | 비고 |
|---|---|---|---|
| GET | `/participants` | `handleGetParticipants` | DO(`ParticipantsRoster`) 프록시 |
| PUT | `/participants` | `handlePutParticipants` | 봇 전용(`X-Bot-Secret`) |
| POST | `/report` | `handleReport` | 토큰을 body로 받음(`tokenInBody`) |
| GET | `/report-cooldowns` | `handleListActiveCooldowns` | "최근 진행된 제보" |
| GET | `/reports` | `handleListReports` | 봇 전용, 읽으면서 즉시 삭제(소비 큐) |
| POST | `/push/send-to-member` | `handlePushSendToMember` | |
| GET | `/push/subscription-status` | `handlePushSubscriptionStatus` | 전 회원 구독 여부 배치 조회 |
| GET | `/push/recent-notices` | `handleListRecentNotices` | "최근 전송된 알림" |

이 문서 범위 밖이지만 §6에서 함께 다루는 관리자 전용 라우트(참고용):

| 메서드 | 경로 | 핸들러 | 비고 |
|---|---|---|---|
| GET | `/admin/captures` | `handleAdminCapturesList` | 봇의 `/captures`를 프록시 + 최근 24h 결정만 필터 |
| GET | `/admin/captures/file` | `handleAdminCaptureFile` | 스크린샷/영상 원본. 로그인만 되어 있으면 열람 가능(ID 추측 불가 전제) |
| POST | `/admin/captures/decide` | `handleAdminCaptureDecide` | 승인 시 `applyOutputPenalty` 호출 |
| POST | `/admin/captures/cancel-penalty` | `handleAdminCaptureCancel` | 오적용된 슬롯 되돌림 |
| POST | `/admin/captures/delete` | `handleAdminCaptureDelete` | 캡처 기록 완전 삭제(+적용된 페널티면 함께 취소) |

---

## 6. 제보 → 페널티 반영 전체 흐름

"제보"라는 기능이 실제로 무엇을 하는지 이해하려면 제출 이후 흐름까지 알아야 한다.
이 구간(4~6단계)의 UI는 `AdminPage`에 있어 이 문서의 직접 범위는 아니지만, 데이터
흐름은 아래와 같이 이어진다:

1. **제출** (§3.2): 회원이 `POST /report` → `report:{id}` KV + 봇에 즉시 통지.
2. **봇 캡처**: 로컬 봇이 통지(또는 폴링 안전망)를 받아 해당 참여자의 화면을
   스크린샷/영상(90초, 영상 모드)으로 캡처해 자체 저장소에 보관하고 "검토 대기"
   상태로 관리(봇 내부 로직, `docs/HELPERBOT.md` 범위).
3. **관리자 검토**: `AdminPage`가 `GET /admin/captures`로 대기 중(+최근 24시간 내
   결정된) 캡처 목록을 불러와 보여주고, 관리자가 이미지/영상(`/admin/captures/file`)
   을 직접 확인한 뒤 승인/반려를 `POST /admin/captures/decide`로 결정한다.
4. **승인 시 페널티 반영** (`applyOutputPenalty`, `handleAdminCaptureDecide` 내부
   호출): "데이터" 시트(회원번호+3행) F~K열(송출P 1~6차) 중 **값이 0인 첫 칸**을
   찾아 현재 페널티 사이클 번호(`집계!D25`)를 써넣고, 같은 칸에 "발생일시 · 사유
   [cap:캡처ID]" 주석을 남긴다. I열(4차)·K열(6차)에 기록되면 이게 바로
   `docs/WEB_DASHBOARD.md` §9.1/§10에서 다룬 "총 페널티(송출 P)" 카운트에
   그대로 반영되는 슬롯이다 — **제보 승인이 곧 대시보드의 총 페널티·예치금 반환
   예상액·주간 상점 계산에 실시간으로 영향을 준다.** 1~6차 칸이 이미 모두 채워진
   상태에서 또 승인하면 에러(정상 운영에서는 6차=송출P 2회 도달 시 예치금 재납으로
   행 자체가 초기화되므로 이 지점에 도달하지 않아야 정상).
5. **회신 지연 차감** (`applyTimeDeduction`): 관리자가 승인 시 함께 입력하는
   화각 요청 발신·회신 시각(`sendTime`/`replyTime`)의 차이가 20분
   (`TIME_DEDUCT_GRACE_MINUTES`)을 넘으면, 그 초과분을 개인 탭 27행("보정
   학습시간", `docs/WEB_DASHBOARD.md`의 `DayDetailCard`가 표시하는 바로 그
   값)의 해당 요일 칸에 `-HH:MM`으로 차감 기록한다.
6. **되돌리기**: 오승인은 `POST /admin/captures/cancel-penalty`
   (`cancelOutputPenalty`)로 슬롯 값·주석·시간차감을 모두 원상복구할 수 있고,
   캡처 기록 자체를 지우는 `POST /admin/captures/delete`도 이미 적용된 페널티가
   있으면 먼저 같은 방식으로 되돌린 뒤 삭제한다.

> ⚠️ 반려(`decision: "rejected"`)는 시트에 아무 영향도 주지 않는다 — `applyOutputPenalty`
> 는 `decision === "approved"`일 때만 호출된다.

---

## 7. KV 라이브 인덱스 패턴 (`_appendToLiveIndex`/`_readLiveIndex`)

"진행 중인 제보"(`COOLDOWN_INDEX_KEY = "cooldownIndex:current"`)와 "최근 전송된
알림"(`NOTICE_INDEX_KEY = "noticeIndex:current"`)이 공유하는 공통 헬퍼
(`index.js` 581~619행 근처). 두 목록 다 15초 폴링으로 여러 사용자가 동시에
조회하는데, 예전엔 매 폴링마다 `KV.list()`를 새로 호출해 "15명이 1시간만 접속해도
하루 무료 한도(1,000회)를 초과"하는 문제가 있었다(코드 주석에 실측 기록). 지금은:

- **등록 시점**(`_appendToLiveIndex`): 인덱스 키 하나에 담긴 배열을 `get` 1회로
  읽어, 만료된 항목을 걸러내고 새 항목을 추가한 뒤 `put` 1회로 다시 저장. 인덱스
  자체의 TTL은 안에 남은 항목 중 가장 늦게 만료되는 것보다 5분 더 길게 잡는다.
- **조회 시점**(`_readLiveIndex`): 그 배열을 `get` 1회로 읽어 `expiresAt` 기준으로
  살아있는 것만 걸러 반환. 걸러진(만료된) 항목이 있었으면 조회 시점에 한 번
  정리해서 다시 저장 — 아무도 새로 등록하지 않아도 값이 무한정 커지지 않는다.

새로운 "최근 N분 내 이벤트" 목록을 만들 때는 KV.list()를 직접 쓰지 말고 이 패턴을
재사용하는 것이 이 코드베이스의 관례다.

---

## 8. 핵심 데이터 모델

전체 필드 정의는 `app/src/lib/api/types.ts`가 원본.

| 타입 | 필드 | 비고 |
|---|---|---|
| `ParticipantsResponse` | `members: string[]`, `stale: boolean` | `/participants` |
| `ActiveCooldownItem` / `ReportCooldownsResponse` | `nickname`, `expiresAt` / `items[]` | `/report-cooldowns` |
| `PushSubscriptionStatusItem` / `...Response` | `name`, `subscribed` / `items[]` | `/push/subscription-status` |
| `PushSendToMemberResponse` | `ok: true` | `/push/send-to-member` |
| `RecentNoticeItem` / `RecentNoticesResponse` | `nickname`, `message`, `senderName`, `ts` / `items[]` | `/push/recent-notices` |

---

## 9. 알려진 함정 / 특이사항

- **`/report`는 `tokenInBody: true`를 쓰는 유일한 예외 경로다.** 이 앱의 다른 모든
  API는 `Authorization: Bearer` 헤더로 세션 토큰을 보내는데(`useApi`), 이 엔드포인트만
  body의 `token` 필드로 받는다 — `handleReport` 시그니처를 보면 `req.json()`에서
  `token`을 직접 꺼낸다. 새 엔드포인트를 추가할 때 이 패턴을 무심코 복사하지 않도록
  주의.
- **쿨다운은 "제보 모드"가 아니라 "닉네임" 기준으로 공유된다.** 스크린샷으로 이미
  제보된 대상은 영상으로도 20분간 재제보할 수 없다 — 의도된 설계(우회 방지).
- **관리자는 쿨다운을 우회하지만, "진행 중인 제보"/"최근 전송된 알림" 목록에는
  똑같이 노출된다.** 우회 = "제한을 받지 않는다"이지 "기록이 안 남는다"가 아니다.
- **`/reports`(GET, 봇 전용)는 호출 즉시 KV 항목을 전부 삭제하는 소비형 큐다.**
  디버깅 목적으로 이 엔드포인트를 브라우저에서 직접 두드리면 봇이 아직 못 가져간
  대기 중인 제보가 그대로 유실된다 — 절대 프론트/수동 테스트에서 호출하면 안 된다.
- **`실시간 접속 명단`(`/participants`)은 시트가 아니라 Durable Object 메모리다.**
  봇이 재시작되거나 60초 이상 PUT을 멈추면 `stale: true`로 전환되고, Worker가
  재배포되면 DO 인스턴스가 초기화되어 명단이 빈 배열로 되돌아간다(다음 PUT까지) —
  "제보 대상자가 갑자기 하나도 안 보인다"는 신고는 시트/KV가 아니라 이 DO 상태나
  봇의 Tunnel 연결부터 의심할 것.
- **제보 승인 → 시트 반영은 "빈 슬롯 순차 채움" 방식이라 되돌릴 때 반드시 정확한
  `col`을 알아야 한다.** `cancelOutputPenalty`는 열 이름(F~K)을 인자로 받아 그
  칸만 지운다 — "이 회원의 페널티를 취소해줘"라는 요청을 값만 보고 임의로 특정
  칸을 지우면 다른 위반 기록을 잘못 지울 수 있다. 항상 `handleAdminCaptureDecide`
  응답에 담겨 있던 실제 `col`(그 승인이 기록된 정확한 칸)을 그대로 넘겨써야 한다.
- **"PUSH 알림 전송"은 시트를 전혀 건드리지 않는다.** "송출 P 제보"와 같은 메뉴에
  있어 헷갈리기 쉽지만, 페널티·벌점과는 완전히 무관한 순수 알림 기능이다.

---

## 10. 관련 문서

- `docs/WEB_DASHBOARD.md` — 총 페널티(§9.1)/상점 차감(§9.3) 계산이 여기서
  기록한 F~K 슬롯을 그대로 읽어간다. 두 문서는 "데이터" 시트의 같은 열 구간을
  서로 다른 방향(쓰기/읽기)에서 다룬다.
- `docs/SHEET_STRUCTURE.md`, `docs/HELPERBOT.md` — 시트 셀 배치, 로컬 봇의
  캡처·상태 서버 구조.
- **향후 작성 예정**: 관리자 페이지(제보 심사 UI — `PenaltyCandidateList`,
  `ReportReviewList`, 예치금 재납 대상자 목록), 설정 페이지(퇴실 프로세스), 푸시
  구독 관리(기기별 on/off, `usePushSubscription`).
