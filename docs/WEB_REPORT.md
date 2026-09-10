# 제보 기능 구조 지도 (WEB_REPORT.md)

> 이 문서는 웹 서비스(`app/`, Cloudflare Worker `frame-checker-worker/`)의 **제보**
> 기능(하단 내비게이션의 "/report" 경로, "화각 불량 제보"/"PUSH 알림 전송" 두 탭)을
> 프론트~백엔드~KV까지 실제 코드를 읽어 조사한 결과입니다. `docs/WEB_DASHBOARD.md`와
> 같은 목적·형식으로 작성했으며, 구현 명령을 내릴 때 이 문서를 참조점으로 삼습니다.
> 코드가 바뀌면 이 문서도 함께 갱신해야 합니다.
>
> 조사 시점: 2026-09-09(§3.4 "내 화각 불량 제보" 개명·처리현황 뱃지 이원화·
> 유예 독립 시간 차감·제보상점 1일 1회 상한·§6 4가지 결정 반영 등 대규모
> 갱신). 대상 커밋 기준 `app/src/pages/ReportPage.tsx`,
> `app/src/components/report/*`, `app/src/hooks/useRosterPolling.ts`,
> `frame-checker-worker/src/index.js`.

## 1. 범위 정의 — "제보" 탭이란

`TabBar.tsx`가 `/report`에 매핑하는 라벨이 "제보"이며, 실제로는 `ReportPage` 하나가
URL 쿼리 `?tab=`으로 관리하는 두 하위 탭을 담고 있다(기본값 "capture"):

- **화각 불량 제보**(`view=capture`, 기본. 예전 이름 "송출 P 제보") — 화각 이탈/근거리
  송출 등을 스크린샷·영상으로 제보하는 화면. 실제 페널티(§6)로 이어지는 시작점.
- **PUSH 알림 전송**(`view=notice`) — 관리자 승인 절차 없이 로그인한 누구나 다른
  참여자에게 짧은 문구(현재는 "타이머 멈춤" 하나)를 웹 푸시로 즉시 보내는 화면.
  실제 시트를 건드리지 않는 순수 알림 기능으로, 제보와는 무관하지만 같은 메뉴에
  얹혀 있다("제보"만큼 무거운 절차 없이 가볍게 주의를 환기하는 용도).

두 탭 모두 로그인만 되어 있으면(관리자 여부 무관) 누구나 쓸 수 있다 — 관리자는 각
탭의 쿨다운(20분/10분)만 우회한다.

**"화각 불량 제보" 탭 안의 별도 섹션 — 내 화각 불량 제보**: `MyOutputPenSection`
(§3.4, 🔧 2026-09 "내 송출 P 제보 확인"에서 개명)이 제보 폼 아래에 함께 렌더링된다.
"내 화각 점검"(본인이 셀프로 찍은 기록)과 "받은 제보"(자신이 대상으로 지목된 일반
제보)를 한 화면에서 보여주고, 대상자 본인이 "위반인정"/"이의제기"를 제출할 수 있는
유일한 화면이다.

**포함되지 않는 것(별도 문서 참고)**: 관리자가 제보 캡처를 승인/반려하는 화면
(`AdminPage`의 "화각 불량 제보 처리" — `ReportReviewList` 등, `docs/WEB_ADMIN.md`
참고, 🔧 2026-09 "송출 P 대상 처리"에서 개명),
로컬 봇(`study_manager_260418.py`)의 캡처 로직 자체(`docs/HELPERBOT.md` 참고). 다만
§6에서 제보 제출 이후 실제로 페널티가 시트에 반영되기까지의 백엔드 흐름은 "제보"
기능을 이해하는 데 필수적이라 함께 다룬다.

---

## 2. 화면 계층 트리 (파일 매핑)

```
ReportPage (app/src/pages/ReportPage.tsx)
├─ useRosterPolling (hooks/useRosterPolling.ts) — 15초 폴링, 두 탭이 공유
├─ Tabs: "capture"(기본) | "notice"  — URL 쿼리(tab)와 동기화, 최초 마운트 이후 로컬 state
├─ [capture] "화각 불량 제보"
│   ├─ 대상자 Select (members, 실시간 접속 명단)
│   ├─ 원인 Select (REASON_OPTIONS: 고정 5개 + "기타(직접 기재)" — §3.2 참고)
│   ├─ "스크린샷 제보" / "영상 제보" 버튼 → POST /report
│   ├─ "내 화각 점검" 버튼 → POST /report ({selfCheck: true}, 본인 대상 셀프 캡처)
│   ├─ ActiveReportsSection (components/report/ActiveReportsSection.tsx)
│   │   └─ GET /report-cooldowns, 15초 폴링 + 1초 카운트다운 (§3.3)
│   ├─ MyOutputPenSection (components/report/MyOutputPenSection.tsx) — §3.4
│   │   ├─ CycleSwitcher — 3주 사이클 토글(현재 진행 중 + 지난 주차)
│   │   ├─ GET /my-captures, GET /my-output-pen (?cycle= 선택)
│   │   ├─ "위반인정"/"이의제기" 제출 → POST /captures/target-respond
│   │   └─ "내 화각 점검" 삭제 → POST /my-captures/delete
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

## 3. "화각 불량 제보" 탭 상세

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

1. `{token, nickname, reason, mode, selfCheck}` — 토큰은 body에 실어 보낸다
   (`tokenInBody: true`, 이 엔드포인트만 `Authorization` 헤더 대신 body 토큰을 쓰는
   예외적 패턴이니 유의). `selfCheck: true`면 "내 화각 점검"(§3.4) — 대상자를
   항상 본인으로 서버가 강제하고, 모드도 스크린샷으로 고정한다.
   **사유(`reason`)는 프론트 `REASON_OPTIONS`(5개 고정 문구 + "기타") 중 하나** —
   "기타"를 고르면 그 라벨 자체는 서버로 전송되지 않고 참여자가 입력한 자유
   텍스트로 완전히 대체된다(서버는 200자로만 자르고 그대로 저장, 별도 검증 없음).
   즉 `reason` 문자열만으로는 "기타(자유기재)"였는지 구분할 표식이 없다 —
   `MyOutputPenSection`(§3.4)이 고정 5개 목록에 없는 값을 "기타(자유기재)"로
   간주해 "기타 (관리자 문의)"로 대신 표시하는 이유다.
2. **20분 쿨다운**(`REPORT_COOLDOWN_SEC = 20*60`): 같은 닉네임(`cooldown:{nickname}`
   KV 키, TTL 20분)에 이미 진행 중인 제보가 있으면 429. **스크린샷/영상 모드와
   무관하게 닉네임 기준으로 공유** — 모드를 바꿔 우회하지 못하게 막는다. 관리자
   (`session.email === ADMIN_EMAIL`)는 이 쿨다운(429 차단)을 우회하지만, **같은
   대상에게 짧은 간격으로 연달아 제보하면 예전엔 첫 캡처가 아직 진행 중일 때
   두 번째가 조용히 무시됐다**(봇의 `thread_id`가 닉네임 기준으로 공유돼 중복
   실행을 막는 구조였기 때문) — 지금은 관리자 제보에 한해 `entry.isAdmin` 플래그를
   봇에 함께 전달해, 봇이 `report_id`를 섞어 매 요청마다 다른 `thread_id`를
   만들도록 고쳤다(`docs/HELPERBOT.md` §5 참고). 일반 제보는 20분 쿨다운으로
   이미 중복이 걸러지므로 기존 방식 그대로다.
3. `report:{uuid}` KV(6시간 TTL)에 제보 원본 저장, 쿨다운 키 기록, 그리고
   `_appendToLiveIndex(COOLDOWN_INDEX_KEY, ...)`로 "진행 중인 제보" 목록용 공유
   인덱스에도 즉시 반영. 이 인덱스 항목에는 `id`/`mode`/`startedAt`/
   `capturedAt: null`도 함께 담긴다 — §3.3의 촬영 진행 카운트다운과 20분
   쿨다운 재시작에 쓰인다.
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
표시하되, **두 단계로 나뉜다**:

1. **촬영 진행 중** — 봇이 아직 캡처를 끝내지 못했으면(`capturedAt: null`)
   "진행 중 (MM:SS 남음)"으로, 모드별 예상 소요시간(`EXPECTED_CAPTURE_SEC`:
   스크린샷 150초, 영상 180초 — 실측 기준, `docs/HELPERBOT.md` §7 참고) 기준
   카운트다운을 보여준다. 실제로 봇이 얼마나 걸리는지와 무관하게 클라이언트가
   `startedAt + 예상초`로 자체 계산하는 값이라, 캡처가 예상보다 늦어지면 0에서
   멈춰 있다가 완료 알림이 오면 다음 단계로 넘어간다.
2. **중복접수 방지** — 봇이 `POST /reports/capture-done`(§5, `handleReportCaptureDone`)
   으로 캡처 완료를 알리면 그 시점부터 새로 20분을 세어 "중복접수 방지 (MM:SS
   남음)"으로 전환된다. **20분 쿨다운은 이제 제보 접수 시각이 아니라 캡처가
   실제로 끝난 시각부터 시작한다** — 촬영 소요시간이 20분 안에 포함되지 않게
   바뀐 것이라, 총 재제보 대기시간은 예전보다 촬영 시간만큼 더 길어진다.
   `_markCaptureDoneInLiveIndex`가 `expiresAt`(화면 표시용 인덱스)과
   `cooldown:{nickname}` KV의 TTL(실제 429 차단 기준) 둘 다 이 시점 기준으로
   재계산한다.

이미 서버가 429로 중복 제보를 막지만, 누르기 전에 "이미 접수됐구나"를 보여줘
헛수고를 줄이는 목적은 그대로다. 관리자가 쿨다운을 우회해 제보해도(§3.2) 이
목록에는 똑같이 뜬다 — 그러지 않으면 참여자 입장에서 "방금 분명 제보됐는데
목록엔 없다"는 혼란이 생기기 때문(코드 주석에 명시된 의도적 설계).

> ⚠️ **동시 쓰기 레이스**: `_appendToLiveIndex`/`_markCaptureDoneInLiveIndex`는
> 인덱스 배열 전체를 get→수정→put하는 구조라, 두 제보(또는 제보 접수와 다른 건의
> 캡처 완료)가 몇 초 간격으로 겹치면 나중 put이 앞선 변경을 통째로 덮어써 항목이
> 사라지는 사고가 실제로 있었다. 지금은 put 직전에 원본을 다시 읽어 그 사이
> 값이 바뀌었으면 처음부터 재시도하는 CAS 유사 방식으로 고쳐져 있다(§7 참고).

### 3.4 "내 화각 불량 제보" (`MyOutputPenSection`) — 당사자 응답 시스템

> 🔧 2026-09: 화면 제목이 "내 송출 P 제보 확인"에서 "내 화각 불량 제보"로
> 바뀌었다(관리자 화면과 동일한 개명 흐름 — `docs/WEB_ADMIN.md` §3.1).

제보 폼 하단에 함께 렌더링되는 별도 섹션. "내 화각 점검"(본인이 셀프로 찍은 기록,
`GET /my-captures`)과 "받은 제보"(자신이 대상으로 지목된 일반 제보,
`GET /my-output-pen`)를 요일별 아코디언으로 합쳐 보여준다. 두 API 모두 상단
`CycleSwitcher`로 고른 사이클(`?cycle=` 쿼리, 없으면 현재 진행 중인 주)에 맞춰
그 주(월~일, KST) 데이터를 조회한다 — `docs/WEB_DASHBOARD.md` §6의 사이클 토글
패턴을 그대로 재사용한 것이다. 재조회는 `useRefreshOnVisible`(탭 복귀 시) +
`usePollingRefresh(visible, load, 10 * 60_000)`(10분 폴링 — 🔧 2026-09 3분에서
하향, `penSlotGrid:`/`members:`/`penCycle:` 캐시가 이미 즉시 무효화되므로 폴링은
무효화를 놓친 경우의 안전망 역할). 섹션 헤더의 수동 새로고침 버튼과 폴링
진행률 게이지는 2026-09에 제거됐다. 🔧 2026-09: 날짜 그룹 내부 항목 정렬은 발생
시각(`ts`) 오름차순(오래된 게 위)이고, 날짜 그룹 헤더 우측에 "N건" 뱃지가
붙는다(주황색 — 내 화각 점검은 건수에서 제외, 받은 제보만 카운트). 항목 카드
헤더에는 사람 아이콘 대신 시계 아이콘 + 시각만 표시한다(날짜는 이미 그룹
헤더에 있음).

- **당사자 응답**: "받은 제보" 항목마다 "위반인정"/"이의제기" 버튼이 있어, 대상자
  본인이 직접 소명 방향을 정할 수 있다(`POST /captures/target-respond`). 제출
  후에도 버튼은 사라지지 않고 비활성화된 채로 남는다(어떤 응답을 냈는지 계속
  보이도록). 서버는 이미 응답했거나 관리자가 이미 처리를 끝낸 건에 재응답이
  오면 409로 거부한다. 🔧 2026-09: 아직 응답하지 않은 건("응답 대기 중")은
  90분 시한이 지나면 자동으로 위반인정 처리되므로 대상자가 놓치기 쉽다 — 기존
  벌금 미납 강조와 동일한 글로우 이펙트(`animate-unpaid-glow`, destructive
  톤)로 카드 전체를 눈에 띄게 한다.
- **90분 자동 위반인정**: 접수 후 90분 안에 응답이 없으면 시스템이 자동으로
  "위반인정"으로 확정한다(`TARGET_RESPONSE_TIMEOUT_MS`, `applyAutoRecognitionForExpired`
  — 별도 크론 없이 `GET /admin/captures`/`GET /my-output-pen` 조회 시점마다
  지연 평가). 이때 `targetResponseAuto: true`가 함께 기록되어, 본인이 직접 누른
  것과 구분해 "시한 (90분) 초과로 위반인정 자동 제출 (검토 중)"으로 다르게
  표시한다.
- **처리현황**: 대상자 응답과 관리자 최종 처리(승인/반려/유예)를 조합해 8가지
  문구 중 하나를 보여준다 — "대상자 응답 대기 중", "이의제기 제출 (검토 중)",
  "위반인정 제출 (검토 중)", "시한 (90분) 초과로 위반인정 자동 제출 (검토 중)",
  "이의제기 승인 (반려)", "이의제기 미승인 (확정)", "위반인정 승인 (확정)",
  "위반인정 미승인 (반려)". "이의제기/위반인정 승인·미승인"이라는 값이 서버에
  별도로 저장되지는 않고, 최종 `reviewStatus`(승인=확정, 유예=유예, 반려·반려_
  인정=반려)로부터 프론트가 매번 역산한다 — 관리자는 대상자 응답과 무관하게
  4가지 결정 중 자유롭게 고를 수 있어(`docs/WEB_ADMIN.md` §3.1의
  `CAPTURE_DECISIONS`), 위반인정을 눌러도 관리자가 검토 후 반려할 수 있다.
  🔧 2026-09: 이 상세 텍스트는 "처리현황" SubRow 전용이고, 그와 별개로 **항목
  카드 헤더에는 단순화된 6종 뱃지**(응답 대기 중/이의제기 (검토 중)/위반인정
  (검토 중)/확정/유예/반려, `statusInfo` 함수)가 붙는다 — 카드 헤더는 관리자
  최종 처리 결과 위주로, "처리현황"은 대상자가 어떤 응답을 냈고 관리자가 그걸
  승인했는지까지 상세하게 나눠 보여주는 역할 분담이다. 확정/유예 뱃지 옆에는
  차수("N차 (조치명)", 노란색)·확정 차감시간 뱃지도 추가로 붙는다(펼치지
  않아도 바로 보이도록) — 반려에는 붙지 않는다(실제로 아무것도 부여되지
  않으므로 단순 "반려"만 표시). 이 `statusLabel`/`statusInfo` 로직은 관리자
  화면(`docs/WEB_ADMIN.md` §3.1의 "처리현황")에도 완전히 동일하게 이식되어
  있다(함수 사본이 두 파일에 있지만 로직은 한 글자도 다르지 않다).
- **학습시간 차감**(예전 이름 "시간 차감"): "응답일시"(대상자가 응답한 시각,
  없으면 "대상자 응답 대기 중")와 확정 여부에 따라 라벨이 전환되는 차감시간
  SubRow를 함께 보여준다. 🔧 2026-09: 라벨이 "예상차감" 고정에서 **"예상
  차감시간"/"확정 차감시간"** 동적 전환으로 바뀌었다 — `reviewStatus`가
  `pending`을 벗어나면(관리자가 어떤 형태로든 처리를 마쳤으면) "확정"으로
  간주한다. 확정 전에는 접수 시각(`ts`)부터 응답 시각(`targetRespondedAt`)
  까지의 경과에서 20분 유예(`TIME_DEDUCT_GRACE_MINUTES`)를 뺀 초과분을
  프론트가 미리 계산해 보여준다(응답 전이거나 20분 이하면 `-00:00`). 확정
  후에는 `penalty.deductedMinutes`를 우선 쓰고, 없으면(유예 건)
  `timeDeduction.deductedMinutes`로 폴백한다 — **유예는 벌점 슬롯만 면제될
  뿐 응답 지연 시간 차감은 별도로 그대로 적용되기 때문**(🔧 2026-09 신설,
  `docs/WEB_ADMIN.md` §3.1c "유예" 설명 참고). 값이 0분이면 무채색, 실제
  차감이 있으면 빨간색으로 강조한다.
- **벌점·페널티 변동**(🔧 2026-09 신설, 이전엔 관리자 화면에만 있었다):
  "적용 시"가 "예상 적용"/"확정 적용"으로 라벨 전환되며, 유예 건은 원래
  차수 라벨에 취소선을 긋고 "유예 N차"를 덧붙인다. "이번 주 영향"은 확정
  시점 스냅샷(`penalty.weeklyMinorPenaltyCount`)을 우선 사용해 이후 다른
  건 처리로 값이 계속 바뀌지 않게 고정 표시한다 — 관리자 화면과 완전히
  동일한 로직(`docs/WEB_ADMIN.md` §3.1a).
- **제보정보**(예전 이름 "제보 정보"): "사유" 값이 빨간색으로 강조되고, 고정
  5개 목록(§3.2)에 없는 값이면 원문 대신 "기타 (관리자 문의)"로 표시한다 —
  다른 참여자가 자유 기재한 임의 문구를 그대로 노출하지 않기 위함. "제보자"
  는 관리자 화면과 달리 이 화면에서는 숨긴다(사용자 지시). "제보자 상점"
  표시는 2026-09에 관리자/대상자 화면 모두에서 완전히 제거했다.
- **내 화각 점검 삭제**: 본인이 찍은 셀프 체크 기록은 `POST /my-captures/delete`로
  직접 삭제할 수 있다(벌점/페널티 판정 대상이 아니므로 시트 되돌림 없이 봇
  manifest 기록만 지움).

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
| POST | `/reports/capture-done` | `handleReportCaptureDone` | 봇 전용(`X-Bot-Secret`). 캡처 완료 시점부터 20분 쿨다운 재시작(§3.3) |
| GET | `/reports` | `handleListReports` | 봇 전용, 읽으면서 즉시 삭제(소비 큐) |
| GET | `/my-captures` | `handleMyCaptures` | 내 화각 점검 목록(`?cycle=` 지원) |
| POST | `/my-captures/delete` | `handleMyCaptureDelete` | 본인 화각 점검 기록 삭제 |
| GET | `/my-output-pen` | `handleMyOutputPen` | 받은 제보 목록(`?cycle=` 지원) |
| POST | `/captures/target-respond` | `handleCaptureTargetRespond` | 당사자 "위반인정"/"이의제기" 제출 |
| POST | `/push/send-to-member` | `handlePushSendToMember` | |
| GET | `/push/subscription-status` | `handlePushSubscriptionStatus` | 전 회원 구독 여부 배치 조회 |
| GET | `/push/recent-notices` | `handleListRecentNotices` | "최근 전송된 알림" |

이 문서 범위 밖이지만 §6에서 함께 다루는 관리자 전용 라우트(상세는 `docs/WEB_ADMIN.md`):

| 메서드 | 경로 | 핸들러 | 비고 |
|---|---|---|---|
| GET | `/admin/captures` | `handleAdminCapturesList` | 봇의 `/captures`를 프록시(`?cycle=` 지원, 없으면 대기+최근 24h 결정만 필터) |
| GET | `/admin/captures/file` | `handleAdminCaptureFile` | 스크린샷/영상 원본. 로그인만 되어 있으면 열람 가능(ID 추측 불가 전제) |
| POST | `/admin/captures/decide` | `handleAdminCaptureDecide` | 4가지 결정(승인/반려_인정/유예/반려) 중 승인·반려_인정·유예 시 `applyOutputPenalty`+`applyReportMerit` 호출 |
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
3. **관리자 검토**: `AdminPage`가 `GET /admin/captures`로 그 사이클(기본 이번 주,
   `?cycle=` 지원)의 캡처 목록을 불러와 보여주고, 관리자가 이미지/영상
   (`/admin/captures/file`)을 직접 확인한 뒤 4가지 결정 중 하나를
   `POST /admin/captures/decide`(`decision: "approved"|"rejected_recognized"|
   "deferred"|"rejected"`)로 내린다 — 4가지 결정의 의미는
   `docs/WEB_ADMIN.md` §3.1c 참고.
4. **승인 시 페널티 반영** (`applyOutputPenalty`, `decision === "approved"`일 때
   `handleAdminCaptureDecide` 내부 호출): "데이터" 시트(회원번호+3행) F~K열
   (송출P 1~6차) 중 **값이 0인 첫 칸**을 찾아 현재 페널티 사이클 번호(`집계!D25`)
   를 써넣고, 같은 칸에 "발생일시 · 사유 [cap:캡처ID]" 주석을 남긴다. I열(4차)·
   K열(6차)에 기록되면 이게 바로 `docs/WEB_DASHBOARD.md` §9.1/§10에서 다룬
   "총 페널티(송출 P)" 카운트에 그대로 반영되는 슬롯이다 — **제보 승인이 곧
   대시보드의 총 페널티·예치금 반환 예상액·주간 상점 계산에 실시간으로 영향을
   준다.** 1~6차 칸이 이미 모두 채워진 상태면 `"rejected_recognized"`("반려
   (인정)")로만 처리 가능하다(대상자 페널티 미반영, 제보자 상점만 지급).
   확정 시점의 `weeklyMinorPenaltyCount`(그 사이클 2/3/5차 슬롯 개수)를
   `penalty` 응답에 스냅샷으로 함께 저장한다(🔧 2026-09, "이번 주 영향"이
   이후 재계산으로 값이 바뀌는 걸 막기 위함).
5. **회신 지연 차감** (`applyTimeDeduction`): 관리자가 승인 시 함께 입력하는
   화각 요청 발신·회신 시각(`sendTime`/`replyTime`)의 차이가 20분
   (`TIME_DEDUCT_GRACE_MINUTES`)을 넘으면, 그 초과분을 개인 탭 27행("보정
   학습시간", `docs/WEB_DASHBOARD.md`의 `DayDetailCard`가 표시하는 바로 그
   값)의 해당 요일 칸에 `-HH:MM`으로 차감 기록한다. 🔧 2026-09: **`"deferred"`
   ("유예") 결정도 벌점 슬롯(4단계)은 건너뛰지만 이 회신 지연 차감은
   독립적으로 그대로 적용한다** — "유예"는 당일 이미 1회 적용을 받아
   벌점만 면제될 뿐, 화각 요청에 늦게 응답한 사실 자체는 별개이기 때문
   (사용자 지시). 결과는 `TimeDeductionResult`로 봇 manifest에 저장된다.
6. **제보자 상점 지급** (`applyReportMerit`): `approved`/`rejected_recognized`/
   `deferred` 세 결정 모두에서 제보자에게 제보상점을 지급한다("데이터" 시트
   R~V, 1~5차 슬롯) — 순수 반려(`rejected`)만 제보자에게도 아무 보상이 없다.
   🔧 2026-09 신설: **1일 1회 상한**(`hasReporterAlreadyReceivedMeritToday`)이
   기존 주간 5칸 상한에 추가됐다 — 같은 제보자가 같은 날(결정 반영일 기준
   KST) 이미 성공한 지급이 있으면 이번 지급은 조용히 건너뛴다(대상자
   페널티는 영향 없음). 이 실패는 **화면 어디에도 표시되지 않는다** — "제보자
   상점" 표시 자체를 2026-09에 완전히 제거했다(관리자/대상자 화면 모두).
7. **되돌리기**: 오승인은 `POST /admin/captures/cancel-penalty`
   (`cancelOutputPenalty`)로 슬롯 값·주석·시간차감을 모두 원상복구할 수 있고,
   유예의 독립 시간 차감만 되돌릴 때는 `cancelTimeDeduction`(🔧 2026-09
   신설, "유예 취소" 버튼이 호출), 제보상점만 되돌릴 때는
   `POST /admin/captures/cancel-merit`(`cancelReportMerit`)을 쓴다. 캡처
   기록 자체를 지우는 `POST /admin/captures/delete`("폐기" 버튼)도 이미
   적용된 페널티가 있으면 먼저 같은 방식으로 되돌린 뒤 삭제하지만, **2026-09
   부터 폐기 버튼 자체가 확정/유예/반려 처리 완료 후에는 노출되지 않는다**
   (사용자 지시 — 처리 완료된 건은 각 "취소" 버튼으로만 되돌리게 한다).

> ⚠️ 순수 반려(`decision: "rejected"`)는 시트에 아무 영향도 주지 않는다 —
> 벌점·시간차감·제보상점 어느 쪽도 반영되지 않는다. "반려 (인정)"
> (`rejected_recognized`)과 "유예"(`deferred`)는 벌점만 없을 뿐 제보상점은
> 지급된다는 점에서 순수 반려와 다르다.

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
| `ActiveCooldownItem` / `ReportCooldownsResponse` | `nickname`, `mode`, `startedAt`, `capturedAt`, `expiresAt` / `items[]` | `/report-cooldowns` |
| `MyOutputPenItem` / `MyOutputPenResponse` | `id`, `reason`, `mode`, `ts`, `reviewStatus`, `targetResponse`, `targetRespondedAt`, `targetResponseAuto`, `nextOccurrence`, `weeklyMinorPenaltyCount`, `deferOccurrence`, `penalty`, `merit`, `timeDeduction` / `items[]` | `/my-output-pen`. `deferOccurrence`/`timeDeduction`은 🔧 2026-09 신설(유예 관련) |
| `MyCaptureItem` / `MyCapturesResponse` | `id`, `ts`, ... / `items[]` | `/my-captures` |
| `TargetRespondResponse` | `ok: true` | `/captures/target-respond` |
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

- `docs/WEB_ADMIN.md` §3.1 "화각 불량 제보 처리" — 관리자가 이 문서의 §3.2/§3.4에서
  다룬 제보를 승인/반려/유예하는 화면. `CAPTURE_DECISIONS`(4가지 결정), 당사자
  응답과 연동된 90분 타임아웃·"다른 관리자 의견 반영" 게이팅, 3주 사이클 토글이
  §3.4와 같은 백엔드 필드(`targetResponse` 등)를 공유한다.
- `docs/WEB_DASHBOARD.md` — 총 페널티(§9.1)/상점 차감(§9.3) 계산이 여기서
  기록한 F~K 슬롯을 그대로 읽어간다. §6이 사이클 토글(`CycleSwitcher`)의 원본
  구현 문서다. 두 문서는 "데이터" 시트의 같은 열 구간을 서로 다른 방향(쓰기/읽기)
  에서 다룬다.
- `docs/SHEET_STRUCTURE.md`, `docs/HELPERBOT.md` — 시트 셀 배치, 로컬 봇의
  캡처·상태 서버 구조. 봇 쪽 캡처 소요시간(§3.3의 `EXPECTED_CAPTURE_SEC` 실측
  근거), 텔레그램 캡션 포맷, 스터디룸 입장 로직은 `docs/HELPERBOT.md` 참고.
- `docs/WEB_SETTINGS.md` — 푸시 구독 관리(기기별 on/off, `usePushSubscription`/
  `NotifyPrefsCard`), 퇴실 프로세스. §4의 "PUSH 알림 전송"이 쓰는 구독 데이터의
  등록·해제 화면이다.
- `docs/WEB_DASHBOARD.md` §3.4 — "제보" 탭도 공통 `AppShell` 헤더(다크모드·교시
  종소리 토글, 탭 전환 페이드, 전역 텍스트 선택 차단)를 그대로 쓴다.
