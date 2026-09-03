# 관리자 기능 구조 지도 (WEB_ADMIN.md)

> 이 문서는 웹 서비스(`app/`, Cloudflare Worker `frame-checker-worker/`)의 **관리자**
> 기능(하단 내비게이션의 "/admin" 경로, "Account"/"PEN · Money"/"Bot · Sheet" 세
> 탭 — 🔧 2026-09 개편, 원래는 "MEM · PEN"/"Money"/"Bot · Sheet"였다)을
> 프론트~백엔드~시트/KV까지 실제 코드를 읽어 조사한 결과입니다. `docs/WEB_DASHBOARD.md`,
> `docs/WEB_REPORT.md`, `docs/WEB_SETTINGS.md`와 같은 목적·형식으로 작성했으며,
> 구현 명령을 내릴 때 이 문서를 참조점으로 삼습니다. 코드가 바뀌면 이 문서도 함께
> 갱신해야 합니다.
>
> 조사 시점: 2026-09-01. 대상 커밋 기준 `app/src/pages/AdminPage.tsx`,
> `app/src/components/admin/*`, `frame-checker-worker/src/index.js`.
>
> 이 문서는 지금까지 나온 문서 중 가장 넓은 표면적을 다룬다 — "관리자" 탭은 사실상
> 다른 세 문서(대시보드/제보/설정)에서 회원이 만든 요청·신청·제보를 관리자가
> 검토·확정하는 최종 처리 지점이라, 코드 자체가 다른 세 도메인의 backend 로직을
> 광범위하게 재사용한다. 겹치는 부분은 이 문서에서 반복 설명하지 않고 해당 절을
> 그대로 인용한다.

## 1. 범위 정의 — "관리자" 탭이란

`TabBar.tsx`가 `/admin`에 매핑하는 라벨이 "관리자"이며, `adminOnly: true`라
`isAdmin`(세션 이메일이 `ADMIN_EMAIL`과 일치)이 아니면 하단 탭 자체가 보이지
않는다. 백엔드도 이 탭이 쓰는 거의 모든 엔드포인트에서 `requireAdmin(req, env)`
(세션 검증 + 이메일이 `ADMIN_EMAIL`과 일치하는지)를 다시 확인한다 — 프론트에서
탭을 숨기는 것과 별개로 서버가 항상 최종 방어선이다.

`AdminPage`는 세 하위 탭을 가진다(URL 쿼리 `tab`으로 관리, 최초 마운트 이후 로컬
state):

- **Account**(`view=account`, 기본값) → `AdminMemberPenaltyTab` — 신규
  스터디원 등록, 참여 스터디원 목록, 퇴실 스터디원 목록 3개 섹션(계정/회원
  관리 전용).
- **PEN · Money**(`view=money`) → `AdminMoneyTab` — 제보 심사, 예치금 재납
  대상자, 사유반휴 승인, 벌금 납부 대상자 처리, 상금 수령 대상자 처리 5개
  섹션(페널티·벌금·상금 처리 전용).
- **Bot · Sheet**(`view=botsheet`) → `AdminBotSheetTab` — API 사용량 모니터링,
  로컬 도움봇 상태/재시작, 회원 번호 정렬.

> 🔧 2026-09: 원래 "MEM · PEN"(`view=member`)/"Money"(`view=money`) 두 탭으로
> 나뉘어 있었으나, "계정/회원 관리"와 "페널티·벌금·상금 처리"라는 성격
> 차이에 맞춰 재편했다 — `view=member`는 여전히 `account`로 정규화되어
> 옛 북마크/링크와 호환된다. 컴포넌트 파일명(`AdminMemberPenaltyTab.tsx`/
> `AdminMoneyTab.tsx`)은 바뀌지 않았으므로, 파일명만 보고 내용을 유추하지
> 말 것 — 지금은 각각 Account 탭/PEN · Money 탭의 컨테이너다.

세 탭 모두 `docs/WEB_DASHBOARD.md` §3.1과 동일한 "언마운트하지 않고 hidden으로만
감춘다" 패턴(`everOpened` ref)을 쓴다 — 관리자가 탭을 오갈 때마다 각 섹션의
`useEffect(load, [])`가 재실행돼 Sheets API를 재호출하는 걸 막기 위함이며, 실제로
2026-08에 탭 전환 몇 번만으로 `429 RESOURCE_EXHAUSTED`가 재현된 적이 있다(코드
주석에 명시).

---

## 2. 화면 계층 트리 (파일 매핑)

```
AdminPage (app/src/pages/AdminPage.tsx)
├─ [account] AdminMemberPenaltyTab (components/admin/AdminMemberPenaltyTab.tsx) — 🔧 2026-09 이름 변경/신설
│   ├─ NewMemberForm           — "신규 스터디원 등록" (기본 접힘) (§3.4)
│   ├─ MemberRosterList        — "참여 스터디원 목록" (§3.5)
│   │   └─ (MemberRosterList 전용) ExitProcessDialog (§3.6)
│   └─ ExitedMemberList        — "퇴실 스터디원 목록" (§3.5.1, 신설)
├─ [money] AdminMoneyTab (components/admin/AdminMoneyTab.tsx) — 🔧 2026-09 순서/이름 변경
│   ├─ ReportReviewList        — "송출 P 대상 처리" (§3.1)
│   ├─ ReasonLeaveReviewList   — "사유 반휴 신청 대상 처리" (§3.3)
│   ├─ PaidFineList            — "벌금 납부 대상 처리" (§4.1, paid/unpaid/exempt 통합 목록)
│   ├─ PenaltyCandidateList    — "예치금 재납 대상 처리" (§3.2)
│   └─ PrizeRecipientList      — "상금 수령 대상 처리" (§4 안내 참고, 상세 미기술)
│       └─ (PenaltyCandidateList/PaidFineList 공용) ExitProcessDialog (§3.6)
└─ [botsheet] AdminBotSheetTab (components/admin/AdminBotSheetTab.tsx) — 🔧 2026-09 순서/이름 변경
    ├─ BotStatusSection          — "도움봇 오퍼레이터" (§5.2)
    ├─ SpreadsheetOperatorSection — "스프레드시트 오퍼레이터" (§5.3, 새 상위 카드)
    │   └─ MemberReorderSection  — "번호 정렬" (§5.3, 하위 항목으로 편입)
    └─ UsageMonitorSection       — "사용량 모니터링" (§5.1)

components/admin/shared.tsx — 공용 프리미티브(§6): SectionCard/SectionHeader,
  ItemTitle/FieldLabel/FieldValue, CapturePreview, PenaltyHistorySection/
  PenaltyHistoryDetailDialog.

components/admin/PushNotificationSection.tsx — ⚠️ 어디서도 import되지 않는
  고아 컴포넌트(§7 참고). AdminPage의 실제 트리에는 없다.
```

---

## 3. 섹션 상세 (§3.1~3.3, §4는 PEN · Money 탭 / §3.4~3.6은 Account 탭)

> 🔧 2026-09 탭 재편 이후에도 섹션 번호(§3.1~3.6)는 유지한다 — 각 절 제목에
> 실제로 속한 탭을 표기했으니, "§3.x = 예전 MEM·PEN 탭"이라는 옛 매핑으로
> 읽지 말 것. 소속 탭은 §2의 트리를 기준으로 삼는다.

### 3.1 송출 P 대상 처리 (`ReportReviewList`) — PEN · Money 탭

> 🔧 2026-09: 화면 제목이 "송출 P 제보 확인"에서 "송출 P 대상 처리"로
> 바뀌었다. 아래 본문은 아직 옛 제목으로 서술된 부분이 있을 수 있으니
> 실제 표시 문구는 이 헤더를 기준으로 삼을 것.

`docs/WEB_REPORT.md` §6("제보 → 페널티 반영 전체 흐름")에서 데이터 흐름 관점으로
이미 다룬 화면의 **실제 UI 구현**이다. `GET /admin/captures`로 대기 중(+최근 24시간
내 결정된, `RECENT_DECISION_WINDOW_MS = 24h`) 제보를 요일별로 묶어 아코디언으로
보여준다(§3.2/§3.3/§4의 다른 목록들과 동일한 "요일 그룹 → 인원 토글" 2단 구조).

각 항목을 펼치면:

- **스크린샷·영상 미리보기** (`CapturePreview`, `shared.tsx` §6).
- **제보 정보**: 사유·제보자·발생일시.
- **시간 차감**: 관리자가 화각 요청 **발신·회신 시각**(HH:MM, 숫자만 입력하면
  자동으로 콜론 삽입)을 입력하는 칸. 이 값이 `POST /admin/captures/decide`의
  `sendTime`/`replyTime`으로 전달되고, `applyTimeDeduction`(§6 인용,
  `docs/WEB_REPORT.md` §6-5단계)이 20분 초과분을 개인 탭 27행(보정 학습시간)에서
  차감한다.
- **벌점·페널티 변동 미리보기**: `occurrenceLabel`/`weeklyImpactLabel`이 슬롯
  차수(1~6차)별 실제 영향을 규칙 기반으로 미리 안내한다(1차=구두경고, 2/3/5차=
  상점 0.1점 차감, 4/6차=주간 상점 전액 제외) — 실제 슬롯 값을 조회한 게 아니라
  차수별 고정 규칙을 문구로 보여줄 뿐이다.
- **"다른 관리자 의견 반영"(합의 투표)**: ⚠️ **완전한 더미 시뮬레이션이다.**
  `DUMMY_OTHER_ADMINS = ["부스터디장", "운영지원"]`이 하드코딩되어 있고, 주
  관리자가 그 두 "가상 관리자"의 선택값까지 자기가 직접 클릭해 대신 채운다.
  실제 다중 관리자 인증·집계는 없다(코드 주석: "실제 다중 관리자 투표/집계는
  아직 없고, 여기서는 UI 흐름만 미리 만들어둔다"). 이 섹션을 켠 상태에서는
  전원(본인+더미 2명) 제출이 끝나야만 승인/반려 버튼이 열린다(`canDecide`) —
  꺼두면 평소처럼 즉시 처리 가능.
- **승인/반려/취소/삭제**: 승인(`POST /admin/captures/decide`)은
  `applyOutputPenalty`를 트리거해 실제 시트에 반영되고, 취소
  (`POST /admin/captures/cancel-penalty`)는 그 슬롯을 되돌린다(시간 차감분까지
  복원). 반려는 시트에 아무것도 안 쓰므로 화면 상태만 되돌리면 그만("반려
  취소"는 API 호출 없음). 삭제(`POST /admin/captures/delete`)는 기록 자체를
  말소하며, 이미 적용된 항목이면 먼저 페널티를 취소한 뒤 지운다.
- **처리 완료 표시의 이중 신뢰 소스**: `isItemApplied`/`isItemRejected`는 이 세션
  안에서 방금 처리한 로컬 state(`applied`/`rejected`)뿐 아니라 서버가 내려준
  `item.reviewStatus`도 함께 본다 — 새로고침(F5) 후에도 이미 처리된 항목이
  "대기"로 되돌아 보이지 않게 하기 위함. 단, 새로고침 이후엔 취소에 필요한
  `occurrence`/`col` 등 세부 정보를 로컬에서 잃으므로, 이 경우 "취소" 버튼
  자체를 숨기고 "이미 처리된 제보입니다"로만 표시한다.

### 3.2 예치금 재납 대상 처리 (`PenaltyCandidateList`) — PEN · Money 탭

> 🔧 2026-09: 화면 제목이 "예치금 재납 대상자"에서 "예치금 재납 대상
> 처리"로 바뀌었다.

`GET /admin/exit/candidates`(→ `handleAdminExitCandidates` → `listExitCandidates`)
가 반환하는 **페널티 누적 2회 이상**(`calcForcedOutDeposit`이 `penalty_2_or_more`
사유로 걸린) 회원만 다룬다. 페널티 2회 이상은 이미 강제퇴실 조건이라 반환율이
항상 0%로 고정되며, 관리자는 유형을 고를 필요 없이 두 버튼 중 하나만 누른다:

- **"강제퇴실자 처리"** → `ExitProcessDialog(lockKind="forced")`.
- **"재납자 처리"** → `ExitProcessDialog(lockKind="deposit_again")`.

페널티 2회 달성 시점(`occurredDay`, 슬롯 주석의 최신 발생일 요일)으로 요일별
그룹핑한다 — 주석이 없으면 "요일 미확인" 그룹으로 따로 모은다. 펼치면
`PenaltyHistorySection`(§6)으로 송출 P/주간 P 원인 이력을 보여준다.

> ⚠️ **`DUMMY_TIME_PEN_HISTORY`**: 주간 P는 앱스크립트 `daily_calc()`가 자동으로
> 채우는 슬롯이라 이 세션 조사 시점까지 실제 이력이 쌓인 회원이 없어,
> `c.timePenHistory`가 비어 있으면 화면 확인용 더미 데이터(가짜 이력 2건)를
> 대신 보여준다. 코드 주석에 "실제 데이터가 쌓이면 이 상수와 사용처를 제거"
> 하라고 명시되어 있다 — 실제 주간 P 이력이 있는 회원을 조회했는데 낯선
> 이력이 보이면 이 더미일 가능성을 먼저 의심할 것.

### 3.3 사유 반휴 신청 대상 처리 (`ReasonLeaveReviewList`) — PEN · Money 탭

> 🔧 2026-09: 화면 제목이 "사유 반휴 신청"에서 "사유 반휴 신청 대상
> 처리"로 바뀌었다.

`GET /admin/leave-proof`가 **봇(도움봇)이 든 대기열**과 **KV 큐(봇이 아직 못 받은
신청)**를 합쳐서 보여준다(`docs/HELPERBOT.md` 참고 대상, `handleAdminLeaveProofList`).
봇이 꺼져 있어도 큐에만 있는 신청을 승인/반려할 수 있다 — 이 경우 시트 반영 후
큐에서만 제거하고 봇 프록시는 건너뛴다.

- **승인**: `handleSetLeaveApply`(대시보드 §4.3, `docs/WEB_DASHBOARD.md`)와 동일한
  로직으로 요일 셀에 `min(2, 기존값+count)`를 쓴다. 잔여량 부족이면 400.
- **반려**: 반려 사유 입력 필수(빈 값이면 "반려 확정" 버튼 비활성화). 시트에
  아무것도 쓰지 않는다 — "처음부터 없었던 신청"과 동일하게 취급.
- **`botSyncFailed`**: 시트 반영은 성공했지만 봇 manifest 갱신에 실패하면, 승인은
  유효하되 학생 화면의 "관리자 확인 중" 배지가 잠시 남을 수 있다는 경고를 별도
  Alert로 보여준다 — 시트 반영이 이미 성공한 뒤라 재시도가 아니라 안내만 한다.
- **증빙 이미지**: `CapturePreview`(§6)를 `endpoint="/admin/leave-proof/file"`로
  재사용. 큐에만 있는 신청이면 KV에 저장된 base64를 그대로 서빙하고, 봇에 이미
  전달된 신청이면 봇에 프록시한다.

### 3.4 신규 스터디원 등록 (`NewMemberForm`) — Account 탭

> 🔧 2026-09: 화면 제목이 "스터디원 등록"에서 "신규 스터디원 등록"으로
> 바뀌었다.

기본 접힘 상태(`defaultOpen={false}`)인 유일한 섹션. `GET /admin/open-slots`로
"데이터" 시트 B열(번호)은 있지만 D열(이메일)이 비어 있는 빈 시트번호 목록을
가져와 드롭다운으로 제공한다.

- 참여유형(예: "8시간 교시제")은 `{시간}|{교시제/달성제}` 조합 12개
  (`PARTICIPATION_TYPES`) 중 선택 — 제출 시 `"8H (교시제)"` 형식으로 변환.
- 구글 계정과 구루미 계정은 시트 D열에 `"구글계정,구루미계정"` 콤마 구분
  형식으로 함께 저장된다 — 어느 쪽에도 콤마가 들어가면 파싱이 깨지므로 프론트·
  백엔드 양쪽에서 동일하게 검증한다.
- **첫 참여일 설정**("준비 중인 시험" 옆, `type="date"`): 등록 시점이 아니라
  앞으로 최대 일주일 뒤부터 실제 참여를 시작할 회원의 시작일을 오늘 날짜로
  뭉개지 않고 미리 정확히 기록하기 위한 필드 — 개인 탭 I2("가입일" 원본
  날짜, 표시 라벨은 I2에 붙고 D+N 환산 결과는 I3에 수식으로 나타난다)에
  직접 쓰인다. 이 값이 `docs/WEB_DASHBOARD.md` §9.2 `depositRefundBreakdown`
  의 "D+N"/"30일 미만 참여자" 판정 기준이 되므로, 오늘로 고정하면 실제보다
  가입일이 이르게 잡혀 등록 직후 예치금 반환 계산이 틀어진다. 프론트가
  `min`/`max`로 오늘~일주일 뒤(KST, `todayKSTStr()`~`todayKSTStr()+6일`)만
  고를 수 있게 막고, 서버(`handleAdminCreateMember`)도 같은 범위
  (`todayKSTDateString()`~`kstDateOffsetString(6)`)로 재검증한다 — 미지정 시
  오늘(KST)로 대체. 미래 날짜를 쓰면 I3가 "D-n"으로 계산되는데, 앱스크립트
  `daily_calc()`의 기존 스킵 조건("D+0"/"-" 포함 시 건너뜀)이 이미 이런
  "아직 시작 전" 회원을 처리하지 않도록 걸러주므로 별도 처리가 필요 없다.
- **이름 중복 자동 처리**: 봇/집계 시트가 구루미 닉네임과 이름을 정확히
  일치시켜 매칭하므로, 같은 이름이 이미 있으면 서버가 자동으로 `"{이름}1"`,
  `"{이름}2"`... 형태로 번호를 붙인다(집계 탭 C열 기준 — 각 개인 탭 B2의 실시간
  수식 결과).
- **Drive 편집자 권한 부여 실패 처리**: 시트 값 기입 자체는 성공했는데(회원은
  이미 사실상 등록됨) `grantSheetAccess`만 실패하면 등록 자체를 실패로 되돌리지
  않는다 — `needsReauth: true`와 함께 응답하고, 프론트가 관리자 위임 OAuth 재연동
  링크(`/oauth/authorize?token=...`, 새 탭으로 열림)를 자동으로 열어준다. 이후
  "권한 다시 부여하기" 버튼(`POST /admin/members/grant-access`)으로 이메일만
  가지고 재시도할 수 있다. 이 OAuth 위임은 통상 최초 1회만 설정하면 되는
  인프라이며, 이 문서에서는 깊이 다루지 않는다(`handleAdminOAuthAuthorize`/
  `handleAdminOAuthCallback`, index.js).

### 3.5 참여 스터디원 목록 (`MemberRosterList`) — Account 탭

> 🔧 2026-09: 화면 제목이 "스터디원 목록"에서 "참여 스터디원 목록"으로
> 바뀌었다(§3.5.1 "퇴실 스터디원 목록"과 짝을 이루는 이름).

`GET /admin/members/roster`(→ `handleAdminMembersRoster`)가 전체 활성 회원의
상태·알림 설정·최근 접속 정보를 한 번에 모아 내려준다. 요일별이 아니라 회원별
아코디언 하나로 나열되고, 펼치면 두 정보 카드 + 액션 버튼 그리드가 나온다.

**"상태 정보" 카드**: 참여유형(=`goalType`, batchGet으로 15개 O3 셀을 한 번에
조회), 가입일자, 준비 중인 시험, 구글/구루미 계정("데이터" D~E열), 시트번호
(클릭 시 `https://docs.google.com/spreadsheets/d/{id}/edit#gid={sheetGid}`로
바로가기 — `getSpreadsheetMeta`의 5분 캐시를 그대로 재사용해 추가 API 호출
없음), 퇴실 예약일자, 최근 접속일자/IP(`lastLogin:{번호}` KV, `handleVerify`가
로그인 시 CF-Connecting-IP 헤더로 기록).

> 🔧 2026-09: **"가입일자" 값의 기반은 `listActiveMembersWithExitInfo`가
> 넘겨주는 `s.joinDate`(=개인 탭 I3, "D+n" 상대 표시)이며 이건 의도된
> 표시다** — `docs/WEB_DASHBOARD.md` §4의 개인 대시보드 "가입일자" 요약
> 타일과 동일한 값·형식으로 맞춘 것(사용자 확인). 다만 관리자가 실제
> 등록 날짜도 함께 확인할 수 있도록, `handleAdminMembersRoster`가 O3와
> 같은 batchGet 호출에 I2(원본 "YYYY-MM-DD")를 묶어 조회해
> `"D+n (YYMMDD)"` 형식으로 병기한다(예: `D+236 (260101)`) — I2 값이
> 없거나 형식이 어긋나면 괄호 병기 없이 `D+n`만 표시한다. I2/I3 셀
> 위치는 `docs/SHEET_STRUCTURE.md`가 원본.

**"알림 설정" 카드**: 회원별 카테고리 on/off를 **조회 전용**으로 보여준다(변경은
회원 본인만 `/notify-prefs`로 가능, `docs/WEB_SETTINGS.md` §4.2). PUSH 구독
(`pushSubscribed`) 자체가 꺼져 있으면 카테고리별 저장값이 ON이어도 화면에는 전부
OFF로 표시한다 — "구독은 꺼졌는데 세부 항목은 죄다 ON"으로 보이는 혼란을
막기 위한 의도적 표시 로직(저장값 자체를 바꾸는 건 아님).

> 🔧 2026-09 확인(잠재 함정, 미수정): `pushSubscribed`는 "이 회원 이메일로
> `PUSH_SUBS_KV`에 `sub:{email}:*` 키가 하나라도 있는지"만 본다 —
> `docs/WEB_SETTINGS.md` §4.2의 기기별 `enabled` 토글은 반영하지 않는다.
> `handlePushSendToMember`(실제 발송 경로)의 최상위 게이트(`list.keys.length
> === 0`이면 404)와는 정확히 같은 기준이라 이 필드 자체는 정확하지만,
> 회원이 등록된 기기를 **전부** `enabled: false`로 꺼둔 극단적 케이스에서는
> `pushSubscribed: true`(+ 카테고리 저장값이 ON)로 보여도 실제 발송은
> 기기별 필터에서 전부 걸러져 실패한다("이 회원 알림 받을 수 있음"으로
> 보이는데 실제로는 못 받는 사각지대). 별도 지시 전까지는 수정하지 않음 —
> 새 기능을 얹을 때 이 사각지대를 감안할 것.

**액션 버튼**(§3.6과 연결): 부스터디장 임명/해제(`POST
/admin/members/parti-status` → `handleAdminSetPartiStatus`, L3 셀 직접 전환,
스터디장·퇴실자·재납자는 이 API로 건드릴 수 없음), "퇴실 처리 (직권
P)"(`lockKind="admin_forced"`, 항상 활성), "퇴실 처리 (정산)"(`lockKind="settle"`,
**`m.exitAgreedAt`이 있어야만 활성** — 회원이 "예치금 정산액에 동의합니다"를
누르기 전엔 클릭 자체가 막힌다), 그리고 `m.exitRequested`일 때만 나타나는
"신청 취소"(`POST /exit-request/cancel`을 관리자 권한으로, body에 `number` 포함).

> 🔧 2026-09 수정: 부스터디장 임명/해제는 원래 `currentStatus === "스터디장"`
> 만 막고, "퇴실자 (0% 반환)"/"재납자 (0% 반환)" 같은 처리 완료 상태는
> 서버가 재검증하지 않았다 — 정상 UI 경로로는 이 화면의 `members` 자체가
> `listActiveMembersWithExitInfo`에서 이미 퇴실자/재납자를 필터링해 도달
> 불가능했지만(코드 검토로 발견, 실사용 재현 이력 없음), API를 직접
> 호출하면 이미 확정된 퇴실/재납 이력이 "부스터디장"/"스터디원"으로
> 조용히 덮어써질 수 있었다. `currentStatus`가 `/^(퇴실자|재납자)/`와
> 일치하면 400으로 거부하도록 서버에 방어를 추가했다.

> 이 화면은 **자진 퇴실 전용**으로 설계 의도가 명확하다(코드 주석): 페널티
> 누적으로 인한 강제퇴실/예치금 재납은 §3.2("예치금 재납 대상자")에서 별도로
> 처리하므로, 이 목록에서는 처리 유형을 관리자가 자유롭게 고를 수 없다 —
> "같은 회원에게 kind만 다르게 골라 반환율이 달라지는 것을 막기 위함"(사용자
> 지시: "무조건 계산은 어디서나 일치해야 해"). §3.6에서 이 설계가 어떻게
> `ExitProcessDialog`의 `lockKind` prop으로 구현됐는지 정리한다.

### 3.5.1 퇴실 스터디원 목록 (`ExitedMemberList`) — Account 탭, 2026-09 신설

`docs/WEB_DASHBOARD.md` §6.1이 다루는 "관리자 대시보드 다른 회원 보기"와는
목적이 다르다 — 그쪽은 퇴실자의 **요일별 학습 기록**(개인 탭 셀 값)을
조회하는 화면이고, 이 화면은 **퇴실 확정 처리 결과 자체**(반환 예치금/차감
원인/처리 결과/퇴실유형)를 조회하는 화면이다. `MemberRosterList`("참여
스터디원 목록") 바로 아래, 같은 아코디언 패턴(요일별이 아니라 회원별 하나씩
펼치는 카드)으로 배치된다.

- **`GET /admin/members/exited`** → `handleAdminExitedMembers`가
  `listExitedMemberEntries`(§`docs/WEB_DASHBOARD.md` §6.1의 것과 동일 —
  원본 스프레드시트의 `"{이름} (퇴실)"` 백업 탭을 정규식으로 스캔)로 목록을
  구하고, 각 항목에 `EXIT_RESULT_KV_PREFIX + 백업탭이름` 키로 저장된 처리
  결과를 붙여 반환한다.
- **처리 결과 저장 시점**: `handleAdminExitConfirm`이 퇴실 확정
  (`kind !== "deposit_again"`)을 처리하는 순간, `computeExitResult`가 이미
  계산해 들고 있던 구조화된 값(`kindStr`/`refundAmount`/`heldAmount`/
  `fineAlreadyPayment`/`breakdown`/`reasons`/`processedDate`)을 그대로
  `EXIT_RESULT_KV_PREFIX + "{이름} (퇴실)"` 키에 JSON으로 저장한다(TTL
  없음, 영구 보존). **재납(`deposit_again`)은 저장하지 않는다** — 재납자는
  `performDepositAgainReset`이 L3를 곧바로 "스터디원"으로 되돌려 다시
  정상 명단에 복귀하므로 이 화면의 대상이 아니다.
  - 🔧 **왜 텍스트 파싱이 아니라 KV 구조화 저장인가**: 백업 탭의 처리결과
    텍스트 박스(`resultMsg`, `writeExitResultBox`가 `Y2:AC18`에 쓰는
    한 줄짜리 이모지 포맷 문자열)에서 정규식으로 값을 다시 뽑아낼 수도
    있었지만, 이건 원문 포맷이 조금만 바뀌어도 조용히 깨지는 손실 있는
    왕복 변환이다(특히 `breakdown`은 `resultStr`이라는 요약 문장으로만
    녹아 있어 텍스트에서 역으로 복원이 사실상 불가능하다). `computeExitResult`
    가 확정 시점에 이미 들고 있는 구조화된 값을 그대로 저장하는 편이
    이 코드베이스의 기존 KV 저장 관례(퇴실 신청 `exitRequest:`, 알림
    선호도 `notifyPref:` 등)와도 일관된다(사용자 판단 확인 후 구현).
  - **키는 회원번호가 아니라 백업 탭 이름 기준**이다 — "데이터 (감사)"
    스냅샷(§3.6)과 같은 이유로, 회원번호는 나중에 새 회원에게 재배정되므로
    번호를 키로 쓰면 그 시점부터 옛 퇴실자의 처리 결과가 새 회원 것으로
    오인될 위험이 있다.
- **이 기능 도입 이전에 처리된 퇴실자**는 그 시점에 저장된 값이 없어
  `result: null`로 내려간다 — 프론트는 이 경우 "처리 결과를 조회할 수
  없습니다(이 기능 도입 이전 처리)"로 안내한다. 소급 적용은 하지 않는다.
- **화면 구성**: 회원별 아코디언을 펼치면 `ExitProcessDialog`의 `admin_forced`/
  `settle` 미리보기 카드와 동일한 시각 언어(반환 예치금 카드 — 10,000원이면
  `text-ok`, 0원이면 `text-destructive`, 볼드 없음; 차감 원인 카드 —
  `buildDepositCauseItems` 재사용; 처리 결과 카드)를 그대로 쓰되, "퇴실유형"
  카드를 추가로 보여준다. 다만 이건 **"지금 계산"이 아니라 "그때 이미
  확정된 값"을 그대로 보여주는 조회 전용**이라, 미리보기/확정 같은 별도
  API 호출이 없다 — 목록 응답 하나에 결과가 함께 실려온다. 아코디언
  헤더의 이름·내부 4개 카드 배경은 프론트에서만 조정한다: 이름 옆
  `"(퇴실)"`은 이 화면 자체가 퇴실자만 모아 보여줘 반복 표기가 불필요해
  `displayName()`으로 표시용으로만 제거하고, `InfoCard` 기본 배경
  (`bg-muted`, 회색)은 다른 화면에 영향 없이 이 화면 4개 카드에만
  `bg-card`(흰색)로 오버라이드했다.
- 🔧 2026-09: **이름 검색 필터 추가.** 목록 상단에 `Input` + `Search`
  아이콘으로 검색창을 두고, `displayName()`으로 `"(퇴실)"` 접미사를 뗀
  이름 기준·대소문자 구분 없이 부분 일치(`includes`)로 필터링한다
  (`useMemo`로 `members`/`query`가 바뀔 때만 재계산, 별도 API 호출
  없음 — 이미 불러온 목록을 클라이언트에서만 거른다). 검색어와 일치하는
  항목이 없으면 `"{검색어}"와 일치하는 퇴실 스터디원이 없습니다`를,
  애초에 퇴실자 자체가 없으면 기존 `"퇴실한 스터디원이 없습니다"`를
  보여줘 두 빈 상태를 구분한다.

> 🔧 2026-09: **`kindStr`이 "강제 퇴실자"/"직권 퇴실자"를 "강제 퇴실자"
> 하나로 통일했다**(`computeExitResult`, index.js) — `forced`(자동 감지된
> 강제 조건)와 `admin_forced`(관리자가 직접 입력한 사유)는 트리거 경로만
> 다를 뿐 결과(`discountRatio === 1`, 0% 반환)가 항상 같아 "직권 P든
> 자동 감지든 결국 관리자가 확정 버튼을 눌러야만 발생하는 처리라는 점에서
> 본질이 같다"는 판단에 따른 것(사용자 지시). **실제
> 사유는 `kindStr`이 아니라 `reasons`에 그대로 남아 있다** — `ExitedMemberList`
> 가 `exitTypeLabel(kindStr, reasons)`로 `code` 기준 짧은 라벨(`under_30_days`
> →"가입 30일 미만", `fine_unpaid`→"벌금 미납", `deposit_again_unpaid`
> →"예치금 미납", `penalty_2_or_more`→"페널티 2회 이상", `admin_reason`→
> `label`에서 "직권 사유: " 접두사만 뗀 원문)을 괄호로 이어붙여
> `"강제 퇴실자 (예치금 미납)"` 같은 한 줄로 합쳐 보여준다(여러 사유가
> 동시에 해당하면 쉼표로 나열). `reasons[].label` 원문(예: "페널티 누적
> 2회 이상 (송출 P 1회 / 주간 P 1회) ➡️ 0% 반환")은 백업 탭의 처리결과
> 텍스트 박스(`resultMsg`)에는 그대로 남아있다 — 이 화면의 짧은 표시만
> 바뀐 것이지 원본 데이터가 소실된 건 아니다.
>
> 🔧 **[회귀 버그 발견·수정, 2026-09-03 문서 교차 검증]** 위 통일을 처음
> 구현했을 때 판정 기준을 kind 값이 아니라 `discountRatio === 1`로
> 짰었다 — 당시엔 "`settle`은 페널티 2회 이상이면 이미 `forced` 쪽으로
> 분기되어 0/0.5만 남으므로 이 조건에 걸리지 않는다"고 판단했기 때문.
> 하지만 이후 **[§3.6의 `settle` 반환율 고지지연 반영 버그 수정](#36-퇴실재납-공유-다이얼로그-exitprocessdialog)**
> (아래)으로 `calcSettleReturnDeposit`이 페널티 1회 + 퇴실 통보 지연
> 조합에서도 `discountRatio: 1`(0% 반환)을 반환할 수 있게 되면서, 이
> 전제가 깨졌다 — `settle`로 처리해도 `discountRatio === 1`이면
> `kindStr`이 "정산 퇴실자"가 아니라 "강제 퇴실자"로 잘못 찍히게 된 것.
> 같은 이유로 `deposit_again`(`calcAgainDeposit`은 재납 확인 시 항상
> `discountRatio: 1` 반환)도 원래부터 이 조건에 걸려 "예치금 재납자"가
> 아니라 "강제 퇴실자"로 잘못 표시되고 있었다 — `handleAdminExitConfirm`이
> `deposit_again`은 `EXIT_RESULT_KV_PREFIX`에 저장하지 않아 "퇴실
> 스터디원 목록"에는 노출되지 않았지만, 백업 탭 처리결과 텍스트 박스
> (`resultMsg`의 "📝 유형 :" 줄)와 관리자가 "예치금 재납 대상 처리"에서
> 보는 미리보기 응답에는 그대로 노출되고 있었다. `discountRatio` 대신
> `kind === "forced" || kind === "admin_forced"`로 직접 분기하도록
> 수정해 두 kind가 우연히 discountRatio=1이 되는 경우와 무관하게 항상
> 올바른 라벨이 나오도록 고쳤다.

> 🔧 2026-09: **직권 P 확정 시 "블랙리스트로 등록" 체크박스 추가.**
> `admin_forced`는 상대 동의 없이 즉시 내쫓는 강제퇴실 중 가장 강한
> 방식이라는 판단에 따라(사용자 지시), `ExitProcessDialog`의 "직권 퇴실
> 사유" 입력 박스 안에 "블랙리스트로 등록하시겠습니까?" 체크박스
> (`Checkbox`, `components/ui/checkbox.tsx`)를 배치했다 — `forced`/
> `settle`에는 없다. 미리보기 계산(`handlePreview`, `/admin/exit/preview`)
> 에는 관여하지 않고, 확정 처리(`handleConfirm`)에서만 `kind ===
> "admin_forced"`일 때 body에 `blacklist: boolean`으로 함께 실려
> `/admin/exit/confirm`으로 전송된다. 서버(`handleAdminExitConfirm`)는
> `kind !== "admin_forced"`이면 값을 무시하고 항상 `false`로 저장한다
> (`isBlacklisted = kind === "admin_forced" && blacklist === true`) —
> 다른 유형에서는 애초에 의미 없는 개념이므로 API를 직접 호출해도
> 강제로 걸리지 않는다. 저장은 §위 KV 결과(`EXIT_RESULT_KV_PREFIX`)에
> `blacklist` 필드로 함께 들어가며, `ExitedMemberList`의 "퇴실유형"
> 카드가 이 값을 **모든 퇴실 유형에 항상** "블랙리스트: Y/N" 행으로
> 보여준다(🔧 2026-09: 처음엔 `kind === "admin_forced"`일 때만 조건부로
> 표시했으나, 사용자 지시로 항상 표시하도록 바꿨다 — `forced`/`settle`은
> 체크박스 자체가 없어 항상 `false`로 저장된 값이 "N"으로 그대로 뜬다.
> 표기도 "예/아니오"에서 "Y/N"으로 바꿨다). "Y"면 `text-destructive`로
> 강조. `blacklist === true`면 회원별 아코디언 헤더(이름 옆, ChevronDown
> 앞)에도 `TintedPill(tone="warn")`로 "블랙리스트" 뱃지가 함께 뜬다 —
> `MemberRosterList`의 부스터디장/퇴실예약 뱃지와 동일한 배치 패턴.

> 🔧 2026-09: **"차감 원인" 카드 항목 정리·재정렬**(`buildDepositCauseItems`,
> `docs/WEB_SETTINGS.md` §3.2와 공유) — "예치금 미납"(개인 탭 R3="미납")
> 항목을 제거했다(코드 검토로 확인: R3="미납"은 앱스크립트 `daily_calc()`
> 가 페널티 슬롯 총합 2 이상일 때만 자동으로 써넣는 값이라 항상 "페널티"
> 항목의 파생 표시였고, 반환액 계산도 R3와 무관하게 페널티 카운트만으로
> 이미 정확했다). 남은 4항목은 각 항목의 최대 차감률이 낮은 순(고지지연
> 최대 50% → 벌금 미납/30일 미만 참여자/페널티 각 최대 100%)으로
> 재배치했다 — 이 순서가 회원 대시보드(`DepositRefundDialog`)/
> `ExitProcessDialog`/`ExitedMemberList` 전체 공통이다. **"퇴실 스터디원
> 목록"은 "페널티 (직권 P N회)" 항목**(`insertAdminForcedCauseItem`)을
> 배열 맨 끝(같은 최대 100% 그룹의 "페널티" 항목 바로 뒤)에 항상 추가로
> 붙인다 — 🔧 2026-09: 처음엔 `kind === "admin_forced"`일 때만 조건부로
> 붙었으나(그때는 "페널티 (직권 P 1회)" 고정 문구), 블랙리스트 SubRow와
> 마찬가지로 사용자 지시에 따라 모든 퇴실 유형에 항상 표시하도록 바꿨다
> — `admin_forced`가 아니면 "0회"(rate 0), `admin_forced`면 "1회"
> (rate 100, 직권 P는 항상 반환율 0%=전액 차감)로 값만 다르게 채운다.

### 3.6 퇴실·재납 공유 다이얼로그 (`ExitProcessDialog`)

`docs/WEB_REPORT.md`·`docs/WEB_DASHBOARD.md`의 §9.2(예치금 반환 계산)와
직결되는 이 저장소에서 가장 복잡한 다이얼로그. `ExitKind`(4종) × 호출부(3곳)
조합이 전부 `lockKind`로 고정되어 있어, **관리자가 유형을 자유 선택하는 실제
경로는 현재 코드베이스 어디에도 없다**:

> 🔧 2026-09 추가: 확정 처리(`handleAdminExitConfirm` → `performExitReset`/
> `performDepositAgainReset`)가 "데이터" 시트 행을 초기화하기 직전에
> `appendDataAuditSnapshot`으로 그 시점 값을 "데이터 (감사)" 시트에
> append-only로 남기고, `rewriteBackupAuditFormulas`로 백업 탭
> ("{이름} (퇴실)" 등)의 수식(`INDIRECT("'데이터'!..." & C42)` 형태로
> "데이터" 시트를 실시간 참조)을 그 감사 행(`'데이터 (감사)'!C43`)을
> 가리키도록 통째 치환한다 — 앱스크립트 `_append_data_audit_snapshot`/
> `_set_sheet_init`의 동일 로직을 재현한 것. 이게 없으면 백업 탭이
> 원본 "데이터" 행을 계속 참조한 채로 남는데, 그 번호가 나중에 새
> 회원에게 재배정되면 이미 확정된 퇴실자의 백업 탭 수식(상점/제보상점/
> 페널티 표시 등)이 새 회원의 값을 잘못 참조해 과거 기록이 조용히
> 오염될 위험이 있었다(퇴실·재납 확정 처리가 앱스크립트에서 웹앱으로
> 이관될 당시 함께 옮겨지지 않았던 부분 — `docs/SHEET_APPSCRIPT.md`의
> "웹앱(frame-checker-worker)과의 관계 요약" 절 참고). 두 함수 모두
> 실패해도 `.catch()`로 흡수해 퇴실 처리 자체는 계속 진행된다 — 감사
> 스냅샷은 부가 기능이지 확정 처리의 필수 전제가 아니다.

| `ExitKind` | 의미 | 반환율 | 호출부 | `lockKind` |
|---|---|---|---|---|
| `forced` | 강제 퇴실(페널티 2회 이상 등 자동 감지) | 항상 0% | PenaltyCandidateList | `"forced"` |
| `deposit_again` | 예치금 재납(회원 행 리셋, 퇴실은 아님) | 항상 0%(재납액 전액) | PenaltyCandidateList | `"deposit_again"` |
| `admin_forced` | 직권 퇴실(관리자 임의 사유) | 항상 0% | MemberRosterList, AdminMoneyTab(§4 "직권 P") | `"admin_forced"` |
| `settle` | 정산(자진) 퇴실 | 페널티 0회: 고지지연 없으면 100%/있으면 50%. 페널티 1회: 고지지연 없으면 50%/있으면 0%(전액 차감) | MemberRosterList | `"settle"` |

> 🔧 2026-09 버그 수정: **`settle`의 반환율(`calcSettleReturnDeposit`)이
> 고지지연(`isLateNotice`)을 전혀 반영하지 않던 실제 처리 로직 버그를
> 고쳤다.** 회원 대시보드(`DepositRefundDialog`)가 퇴실 신청 전 미리
> 보여주는 "예상 반환액"은 `depositRefundBreakdown().amount`(§`docs/
> WEB_DASHBOARD.md` §9.2 — "페널티 1개(50%) + 고지지연(50%)이 겹치면
> 100% 차감"을 이미 반영)를 쓰는데, 관리자가 실제로 정산 퇴실을 확정
> 처리할 때는 별도의 `calcSettleReturnDeposit`이 페널티 횟수만으로
> 0%/50%를 계산해 고지지연을 무시했다 — 회원이 신청 전 미리 본 예상액과
> 관리자가 실제로 확정하는 반환액이 어긋나는 버그였다(더미 데이터를
> 검토하던 중 사용자가 발견: "통보 지연 50% + 페널티 1회 50%면 100%
> 차감 아닌가"). `depositBreakdown.lateNotice`를 반영해 두 계산이 다시
> 일치하도록 고쳤다 — 이제 페널티 1회 + 고지지연이면 `settle`도
> `depositRefundBreakdown`과 동일하게 100% 차감(반환 0원)이 된다.
> `resultStr`/`reasons`(`{code: "settle_return_rate", label: "N% 반환"}`)
> 도 함께 채워, "퇴실 스터디원 목록"의 "퇴실유형" 카드가 "정산 퇴실자
> (N% 반환)"처럼 반환율만 짧게 보여줄 수 있게 했다(사용자 지시 — 이전엔
> `reasons`가 아예 비어 있어 괄호 없이 "정산 퇴실자"만 나왔었다).
> 이 수정으로 `settle`도 `discountRatio: 1`(0% 반환)에 도달할 수 있게
> 됐는데, 이게 §3.5.1의 `kindStr` 통일 로직과 충돌해 새 회귀 버그를
> 만들었다 — 자세한 내용과 수정은 **[§3.5.1](#351-퇴실-스터디원-목록-exitedmemberlist--account-탭-2026-09-신설)**
> 참고.

🔧 2026-09: `AdminMoneyTab`(Money 탭)이 세 번째 호출부로 추가됐다 — 이
화면은 회원 목록을 `MemberRosterEntry`가 아니라 벌금 레코드(`FineRecord`)로
다루기 때문에 `suggestedKind`/`allChecks`(둘 다 `admin_forced`일 땐 UI에서
읽히지 않는 필드)를 타입만 맞춘 더미 값으로 채워 넘긴다. 자세한 내용은
§4 참고.

이 표에 따라 다이얼로그 내부는 세 가지 렌더 분기로 나뉜다(`isAdminForcedOnly`/
`isSettleOnly`/그 외):

- **`admin_forced`**: 사유 입력란 + `settle`과 동일한 미리보기 카드 4개
  (반환 예치금/차감 원인/처리 결과/시트 변동사항) + 주의사항 + 확정
  버튼으로 구성된다. 🔧 2026-09: 원래는 사유 입력 하나만 받고 바로
  확정하는 화면이었으나(discountRatio가 항상 1로 고정돼 미리보기가
  보여줄 게 없다는 이유로 미리보기 단계 자체가 없었다), 사용자 요청으로
  "직권 P 모달에도 정산 모달과 같은 내용을 보여달라"고 해서 `settle`
  분기의 미리보기 카드를 그대로 재사용해 추가했다. **단, `settle`과
  달리 확정 처리는 예치금 정산액 동의(`agreedAt`) 여부와 무관하게 항상
  가능하다** — 직권 P는 애초에 회원 동의를 기다리지 않고 관리자가
  강제로 진행하는 처리이므로, "확정 처리" 버튼은 여전히
  `forcedReason.trim()`만 있으면 바로 눌린다(사용자 지시: "직권 P는
  동의를 받을 필요 없이 강제로 진행하는 거니까 확정 처리 누르면 바로
  퇴실되어야 한다").
  - `lockForcedReason?: string` prop — 값을 넘기면 사유 입력란이 그
    문자열로 고정되고 `readOnly`로 편집이 막힌다. **`disabled`는 쓰지
    않는다** — 회색조로 흐려지고 클릭도 막혀 "비활성화된 폼"처럼 보이는
    게 사용자 지적으로 확인됐다(값이 실제로 채워져 있고 확정도 바로
    가능한데 disabled처럼 보이면 오해를 준다); `readOnly`만으로 값 변경은
    막되 입력창은 시각적으로 평범한 활성 상태(테두리/배경 정상, 포커스
    가능)로 남는다. `AdminMoneyTab`의 "직권 P"(§4)는 항상
    `"벌금 시한 내 미납자"`로 고정해서 넘긴다.
  - **미리보기는 사유 유무와 무관하게 다이얼로그가 열리자마자 자동으로
    뜬다**(🔧 2026-09 변경, settle과 동일). `discountRatio`가 사유 여부와
    무관하게 항상 1(0% 반환)로 고정되므로, 서버 `calcAdminForcedExit`도
    이제 `forcedReason`이 빈 문자열이면 `null`을 돌려주던 기존 로직을
    버리고 항상 계산 결과를 반환한다(사유가 없으면 결과 문구에
    "(사유 미입력)"으로 표시). `lockForcedReason`이 없는 자유 입력 호출부
    (`MemberRosterList`, 관리자가 직접 입력)는 이후 `forcedReason`이 바뀔
    때마다 300ms 디바운스로 재계산한다 — 사유를 다 입력하면 결과 문구의
    사유 부분만 갱신된다(반환액 자체는 이미 0원으로 고정 표시돼 있었으므로
    바뀌지 않음). **사유 필수 검증은 실제 시트를 바꾸는 확정 단계
    (`handleAdminExitConfirm`)로 옮겨졌다** — "확정 처리" 버튼은 여전히
    `forcedReason.trim()`이 있어야 눌리고, API를 직접 호출하는 경로도
    서버가 `kind === "admin_forced"`일 때 사유 없으면 400으로 거부한다.
- **`settle`**: 다이얼로그가 열리자마자(useEffect) 자동으로 `POST
  /admin/exit/preview`를 호출해 계산 결과를 바로 보여준다 — 별도의 "미리보기
  계산" 버튼 클릭이 필요 없다. "반환 예치금"/"차감 원인"(`buildDepositCauseItems`,
  `docs/WEB_SETTINGS.md` §3.2와 동일 함수 재사용)/"처리 결과"/"시트 변동사항"/
  "퇴실 프로세스"(신청일자·예약일자·동의일자, `exitAgreedAt`이 없으면 강조
  표시) 5개 카드로 구성. **`preview.fromBackup`이 true면 "데이터 기준: 지난 주
  백업 시트" 서브로우가 추가된다** — `sheet_reset`(매주 월요일 새벽) 이후에
  정산 처리가 이루어지는 경우 원본 대신 자동 백업 파일에서 계산했다는 뜻(이번
  세션에 구현된 로직, `computeExitResult`/`resolveExitSourceFileId`, index.js).
  🔧 2026-09: "반환 예치금" 표시값이 5,000원 이상이면 `text-ok`(초록),
  0원이면 `text-destructive`(빨강)로 강조된다(`preview.refundAmount >= 5000`
  / `=== 0`, `admin_forced`/`settle` 두 분기 공통, `ExitedMemberList`도
  동일 — 원래는 정확히 10,000원일 때만 초록이었으나 사용자 지시로 기준을
  5,000원으로 낮췄다). 숫자 자체는 굵기를 강조하지 않는다(`font-semibold`
  제거, 사용자 지시). 그리고 **"확정 처리" 버튼은
  `preview.exitProcess?.agreedAt`이 없으면 비활성화된다** — "예치금 정산액
  동의일자: 미동의"가 붉은 글씨로만 표시되고 버튼은 그대로 눌리던 예전
  동작을 사용자 지적으로 고쳤다. 트리거 버튼(`MemberRosterList`의 "퇴실
  처리 (정산)")도 원래 `!m.exitAgreedAt`일 때 비활성화되어 이중으로
  막아왔지만, 이 다이얼로그 내부 버튼 자체에도 같은 가드를 걸어 트리거
  쪽 가드가 어떤 이유로든 우회되어도(예: 디버깅 목적으로 일시적으로 푼
  경우) 실수로 미동의 회원을 확정 처리하는 일이 없도록 했다.
- **`forced`/`deposit_again`(그 외 분기)**: `lockKind`가 있어도 유형 선택
  드롭다운 자리에 고정 라벨만 보이고, **"미리보기 계산" 버튼을 명시적으로 눌러야
  하는 3단계 흐름**(계산 → `resultMsg`를 `<pre>`로 그대로 출력 → 확정)을 그대로
  쓴다. 이 분기 안의 `Select` 드롭다운(유형을 자유 선택하는 UI)은 `lockKind`가
  전달되지 않을 때만 노출되는데, **`forced`/`deposit_again`을 넘기는
  PenaltyCandidateList 호출부는 항상 `lockKind`를 함께 넘기므로 이
  드롭다운은 실제로 렌더링될 일이 없다** — 어떤 호출부든 `lockKind` 없이
  이 다이얼로그를 열지 않는 한 죽은 UI 경로다.

확정(`POST /admin/exit/confirm`) 시 서버는 프론트가 보낸 `kind`를 그대로
신뢰하지 않고 §3.5에서 언급한 "정산은 동의까지 필요" 검증을 다시 수행한다
(`docs/WEB_SETTINGS.md` §5 표의 `/exit-request/agree`와 대응) — 프론트가
버튼을 비활성화해도 API를 직접 두드리는 경로까지 막기 위함.

---

## 4. PEN · Money 탭의 벌금/상금 처리 (`AdminMoneyTab`)

> 🔧 2026-09 탭 재편: `AdminMoneyTab`은 이제 §3.1~3.3(송출 P 대상 처리/
> 예치금 재납 대상 처리/사유 반휴 신청 대상 처리)까지 함께 렌더링하는
> PEN · Money 탭 전체의 컨테이너다. 이 §4는 그중 아래쪽 두 섹션
> (`PaidFineList`/`PrizeRecipientList`)만 다룬다 — 위 세 섹션은 §3.1~3.3을
> 참고할 것. **탭 안 실제 표시 순서는 송출P대상처리 → 사유반휴신청대상처리
> → 벌금납부대상처리 → 예치금재납대상처리 → 상금수령대상처리다**(§2
> 트리 순서 그대로) — 이 문서의 절 번호(§3.1→3.2→3.3→4.1) 순서와 다르니
> 혼동하지 말 것. **`PrizeRecipientList`("상금 수령 대상 처리")는 아직
> 이 문서에 상세 기술되지 않았다** — 현재 더미 데이터로 랭킹 화면
> (`RosterView`) 레이아웃을 재사용해 UI만 먼저 완성하는 단계이며
> (`/admin/prize/settle` 백엔드는 배포됨, `handleAdminPrizeSettle`),
> 프론트가 실제 `/roster-status` 호출로 전환되면 이 섹션도 별도로
> 채워야 한다.

### 4.1 벌금 납부 대상 처리 (`PaidFineList`)

> 🔧 2026-09: 화면 제목이 "벌금 납부 대상자 처리"에서 "벌금 납부 대상
> 처리"로 바뀌었다.

🔧 2026-09: 원래 세 개의 거의-동형 리스트(납부/미납/면제 현황)가 나란히
있었으나, 사용자 지시로 **"벌금 미납 현황"(`FineList`)과 "벌금 면제
현황"(`ExemptFineList`)을 완전히 제거**하고 **"벌금 납부 현황"만 남겨
"벌금 납부 대상자 처리"로 개명**했다 — 지금 이 섹션은
`PaidFineList` 하나만 렌더링한다. 개인 탭 "✅ 납부확인" 행
(`docs/WEB_DASHBOARD.md` §10의 `ROW_PAYMENT_CHECK`)에서 나온 (회원, 요일,
상태) 레코드를 요일별로 그룹핑해 보여주는 §3.1(`ReportReviewList`)과 동일한
디자인 패턴(아이콘+무채색 요일 라벨, 상태 필 배지, 요일별 아코디언 →
인원별 토글)으로 맞춰져 있다.

- **데이터 소스 = 세 API 통합.** `load()`는 `/admin/fines/paid` +
  `/admin/fines/unpaid` + `/admin/fines/exempt`를 `Promise.all`로 모두
  불러와 각 항목에 `baseStatus`(그 항목이 실제로 속한 상태: "납부"/"미납"/
  "면제")를 태깅한 뒤 **하나의 배열(`FineRecord[]`)로 병합**한다. 요일
  그룹(`groupByDay`)은 이 병합 배열을 기준으로 만들어지므로, 미납 건이
  0이어도 그 요일에 납부/면제 건이 있으면 정상적으로 그룹이 나타난다.
  (한때 `/admin/fines/unpaid` 단독을 원본으로 써서 미납이 0건인 요일이
  통째로 빈 목록이 되는 문제가 있었으나, 사용자 지시로 세 상태 모두가 항상
  같이 보이도록 고쳤다 — "초기 상태가 미납이라는 건 유래일 뿐, 실제로는
  현재 상태가 무엇이든 전원이 목록에 떠야 한다".)
  `listPaidFines`/`listUnpaidFines`/`listExemptFines`는 모두
  `getAllPaymentRows` → `getSharedMemberRows`(15명 개인 탭 A1:U40을
  batchGet, 60초 캐시)를 거친다 — 이 캐시는 §3.2/§3.5가 쓰는
  `getAllExitRelevantStatus`(→ `listExitCandidates`/
  `listActiveMembersWithExitInfo`가 공유)가 내부적으로 호출하는 것과
  **같은 캐시 키**(`memberRows:{fileId}`)다.
- **배지 = 현재 상태 하나만, 버튼 = 나머지 선택지.** 각 회원 행의
  `effectiveStatus(f)`는 `statusOverride[key] ?? f.baseStatus` — 이 세션에서
  관리자가 방금 바꾼 값이 있으면 그걸, 없으면 서버가 알려준 실제 상태를
  쓴다. `TintedPill`로 그 상태 하나만 배지로 보여주고(납부=ok/초록,
  미납=warn/빨강, 면제=amber/주황), 상세를 펼치면 그 상태를 제외한
  나머지(`ALL_FINE_ACTIONS.filter(a => a !== status)` — 최대 "납부"/"미납"/
  "면제"/**"직권 P"** 4종 중 3개)만 버튼으로 제시한다. 이미 그 상태인데
  같은 버튼을 또 누르는 무의미한 액션을 없앤 것.
- **"직권 P" 버튼은 §3.5(`MemberRosterList`)의 "퇴실 처리 (직권 P)"와 동일한
  `ExitProcessDialog(lockKind="admin_forced")`를 그대로 재사용한다.** 🔧
  2026-09: 처음엔 항상 비활성화된 자리표시자였으나, 사용자 지시로 실제
  퇴실 처리 다이얼로그와 연결됐다 — 확정하면 `POST /admin/exit/confirm`
  (kind: `admin_forced`, 반환율 항상 0%)이 그대로 실행되고, 성공 시
  `onConfirmed={load}`로 Money 탭 목록을 다시 불러와 처리 결과를 반영한다.
  버튼 자체도 §3.5와 모양을 맞췄다(사용자 지시) — 라벨은 "직권 P"가
  아니라 §3.5와 동일한 "퇴실 처리 (직권 P)"이고, `variant="destructive"`
  (빨간 톤)로 다른 세 상태 버튼(납부/미납/면제, `variant="outline"`)과
  구분된다 — 이 버튼만 실제 퇴실을 트리거하는 위험한 동작이기 때문.
  (아이콘은 §3.5 쪽도 함께 제거됐다 — `MemberRosterList`의 "부스터디장
  임명"/"퇴실 처리" 버튼들에서 `Star`/`DoorOpen` 아이콘을 뺐다.)
  **사유 입력란은 `lockForcedReason="벌금 시한 내 미납자"`로 고정되어
  있다** — `MemberRosterList`(사유 자유 입력)와 달리, 이 화면에서 여는
  직권 P는 용도가 이미 정해져 있어 관리자가 매번 사유를 타이핑하지 않고
  바로 확정만 하면 된다(입력란은 `readOnly`만 적용 — 비활성화된 느낌을
  주지 않도록 `disabled`는 쓰지 않는다, §3.6 참고). 이
  화면엔 `MemberRosterEntry`가 갖는
  실제 `suggestedKind`/`allChecks`가 없지만, `lockKind="admin_forced"`일
  때는 그 두 필드가 UI에서 전혀 읽히지 않는다(체크리스트는 `kind ===
  "forced"`일 때만 노출, `suggestedKind`는 `lockKind`가 없을 때의
  fallback일 뿐)는 걸 `ExitProcessDialog.tsx` 소스로 확인한 뒤, 타입만
  맞추는 더미 값(`suggestedKind: "settle"`, `allChecks: []`)을 넘긴다.
  **단, 요일 헤더의 "직권 P : 0건" 카운트는 여전히 자리표시자다** — 이
  목록(paid/unpaid/exempt 병합)에는 애초에 admin_forced로 처리된 인원을
  구분할 필드가 없어, 몇 명이 그 상태인지 셀 기준 자체가 아직 정해지지
  않았다.
- **버튼 배치**: 상세를 펼치면 `DayDetailCard`(아래 항목) 바로 다음,
  "일간 총 벌금 · 재납 예치금" 카드 아래에 나머지 상태 버튼들이 한 줄
  (`flex` + `flex-1`)로 나열된다. 앱 전반의 표준 액션 버튼 높이
  (`sm:h-11`, `variant="outline"`)를 그대로 따르되, 2열 그리드가 아니라
  가로 한 줄로 배치해 불필요하게 폭을 넓게 쓰지 않는다.
- **상태 변경**: `POST /admin/fines/status`(회원번호+요일+새 상태) — 3가지
  상태 전환 모두의 유일한 쓰기 경로. 성공하면 `statusOverride`에 로컬로
  기록해 낙관적으로 배지를 갱신한다 — 상태가 바뀌어도 그 항목이 목록에서
  사라지지 않고 그 자리에 남아 배지만 바뀐다(서버 재조회 없음, 다음
  수동 새로고침 전까지 유지).
- **회원 상세**: 각 항목을 펼치면 `GET /admin/members/{번호}`
  (`handleAdminMemberStatus`, `docs/WEB_DASHBOARD.md`의 `buildPersonalStatus`를
  그대로 재사용)로 그 회원의 전체 `StatusResponse`를 불러와 해당 요일만
  `DayDetailCard`(`docs/WEB_DASHBOARD.md` §4.1, `showStatusBadges={false}`로
  요일/마감/벌금 뱃지 줄을 꺼서 사용)로 보여준다 — 회원별로 처음 펼칠 때만
  조회하고 이후엔 캐싱된 `dayDetail` state를 재사용.
- **납부된 총 벌금액**: 상단 요약 — `집계!D22`(`getWeeklyPaidFineTotal`,
  60초 캐시)를 그대로 읽는다.

---

## 5. Bot · Sheet 탭 (`AdminBotSheetTab`)

> 🔧 2026-09: 실제 표시 순서와 이름이 바뀌었다 — "도움봇 상태" →
> "도움봇 오퍼레이터"(§5.2, 개명만), "번호 정렬" → 새 상위 카드
> "스프레드시트 오퍼레이터"의 하위 항목으로 편입(§5.3), 그 아래
> "사용량 모니터링"(§5.1, 순서만 맨 뒤로) 순으로 렌더링된다. 절 번호
> (§5.1~5.3)는 이전 문서와의 연속성을 위해 그대로 두었으니, **화면 순서는
> §2 트리를 기준으로 삼을 것** — 절 번호 순서(5.1→5.2→5.3)와 실제 렌더링
> 순서(5.2→5.3→5.1)가 다르다.

### 5.2 도움봇 오퍼레이터 (`BotStatusSection`)

> 🔧 2026-09: 화면 제목이 "도움봇 상태"에서 "도움봇 오퍼레이터"로
> 바뀌었다(컴포넌트/엔드포인트는 그대로).

`GET /admin/bot/status` → `handleAdminBotStatus` → `proxyToBotDashboard(env,
"/status")`. 로컬 도움봇(`study_manager_260418.py`, `docs/HELPERBOT.md`)이
Cloudflare Tunnel로 노출한 로컬 상태 서버를 그때그때 프록시한다(폴링이 아니라
요청 시점 즉시 호출) — 온라인 여부, 스터디룸 접속 상태, 현재 화면 스크린샷
(base64 PNG), 최근 로그를 보여준다. 관리자가 원격으로 내릴 수 있는 유일한 명령은
**"재시작"**(`POST /admin/bot/command {command:"restart"}`, `BOT_COMMAND_VALUES =
["restart"]`)뿐이다 — 봇이 브라우저를 새로 열고 스터디룸에 재입장한다. 봇이
꺼져 있으면(`proxyToBotDashboard`가 null) 프론트는 "오프라인"으로만 표시하고
502가 아니라 200으로 조용히 응답한다.

### 5.3 스프레드시트 오퍼레이터 (`SpreadsheetOperatorSection`) — "번호 정렬"을 하위 항목으로 편입

> 🔧 2026-09 신설: 시트 자체를 직접 조작하는 관리 기능들을 모으는 상위
> 카드. `SectionHeader`가 `CollapsibleTrigger`를 내부에서 렌더링해 부모
> `Collapsible` 컨텍스트가 필수이므로, 이 카드는 접이식이 아니라 고정
> 헤더(아이콘+제목)로만 구성되고 — `Collapsible`을 중첩하면 `<Collapsible
> Trigger>` 컴포넌트가 부모 컨텍스트를 못 찾아 런타임 에러가 난다 — 실제
> 접힘/펼침은 안에 있는 하위 섹션(`MemberReorderSection`, 자체
> `Collapsible`을 그대로 유지)에서만 일어난다. 지금은 "번호 정렬" 하나만
> 하위 항목이지만, 향후 시트 관련 기능이 추가되면 같은 카드 안에 나란히
> 넣는 걸 염두에 둔 구조다.

#### 번호 정렬 (`MemberReorderSection`)

퇴실 등으로 비워진 시트번호를 앞으로 당겨 채우는 일괄 이동 기능. "데이터" 시트의
점유 슬롯을 번호 오름차순으로 나열해 1번부터 빈틈없이 재배정하는 계획을 계산한다
(`computeMemberReorderPlan`).

- **미리보기 먼저, 실행은 별도 확인**: `GET /admin/members/reorder-preview`로
  계획(각 회원이 몇 번에서 몇 번으로)만 먼저 보여주고, "실행"을 눌러야
  `POST /admin/members/reorder`가 실제로 옮긴다. 번호는 시트 탭 이름 자체이자
  "데이터" 시트의 고정 행 번호라 잘못 실행하면 출석·타이머 이력이 섞일 수 있어
  이렇게 2단계로 나뉜다(코드 주석).
- **실행 시 서버가 계획을 다시 계산**한다 — 클라이언트가 미리보기 이후 보낸
  계획을 신뢰하지 않고, 그 사이 상태가 바뀌었을 가능성을 감안해 항상 최신
  상태로 재계산.
- **구현 방식**: 셀을 하나하나 복사하지 않고 **탭 이름 자체를 바꿔치기**해서
  개인 탭의 모든 데이터(수식 포함)를 그대로 보존한다(`moveMemberSlot`) — 빈
  자리(to) 탭 삭제 → 점유 탭(from)의 이름·위치를 to로 변경 → 비워진 from
  번호에 template을 새로 복사(`docs/WEB_DASHBOARD.md`의 `performExitReset`과
  같은 "삭제+template 복사" 패턴). "데이터" 시트의 D~V(이메일~제보상점 슬롯)도
  함께 이동시킨다.

### 5.1 사용량 모니터링 (`UsageMonitorSection`)

> 🔧 2026-09: 화면 표시 순서만 맨 뒤(§5.2/§5.3 다음)로 바뀌었다 — 절 번호는
> 이전 문서와의 연속성을 위해 그대로 §5.1이다.

`GET /admin/usage`가 두 종류의 사용량을 한 화면에 보여준다:

- **Google Sheets(분당 60회 읽기/쓰기)**: Worker 메모리에만 존재하는 근사 카운터
  (`_usageCounters`, `_bumpUsageCounter`) — Cloudflare Workers가 요청을 여러
  isolate로 분산 처리하기 때문에 **정확한 전체 사용량이 아니라 "이 요청을 처리한
  isolate가 최근에 직접 본 호출"만 집계한 하한값**이다(콜드스타트마다 리셋). 로컬
  도움봇도 같은 서비스 계정으로 Sheets API를 호출하므로, 봇이 `POST
  /admin/bot-sheets-usage`(`X-Bot-Secret` 인증)로 자신의 호출 수를 5초 간격
  보고하면 이 카운터에 합산된다 — Worker 자신의 호출만 셌다면 실제 사용량을
  과소평가하게 되기 때문.
- **Cloudflare(오늘 하루 한도)**: `CF_API_TOKEN`/`CF_ACCOUNT_ID`가 설정돼 있을
  때만 GraphQL Analytics API로 실측치(Workers 요청·KV 읽기/쓰기·KV 저장 용량)를
  가져온다. **UTC 자정~자정 단위인 Cloudflare의 date 필터를 KST 자정 기준으로
  재집계**한다(`datetimeHourToKSTDateString`, 이번 세션 이전에 "클라우드플레어
  시간도 한국 시간대로" 요청에 따라 구현된 부분) — 그러지 않으면 KST 기준
  "오늘"이 오전 0~9시엔 실제로는 UTC 기준 "어제" 데이터에 걸쳐 있어 하루 사용량이
  자정에 정확히 리셋되지 않는다. 토큰 미설정 시 이 부분만 안내 문구로 대체.

---

## 6. 관리자 탭 전반의 공용 프리미티브 (`components/admin/shared.tsx`)

`docs/WEB_DASHBOARD.md`가 `components/dashboard/shared.tsx`(회원용 UI
프리미티브)를 다루듯, 관리자 화면은 별도의 `components/admin/shared.tsx`를
공유한다:

- **텍스트 위계**: `ItemTitle` > `FieldLabel`/`FieldValue` — 섹션 제목
  (`SectionHeader`, font-bold)보다 한 단계 낮은 굵기 체계.
- **`SectionCard`/`SectionHeader`**: 접이식 섹션 하나를 감싸는 카드 + 제목/
  새로고침 버튼 헤더. `onRefresh`가 없으면 버튼 자리를 빈 공간(size-7)으로
  유지해 다른 섹션과 chevron 위치를 맞춘다.
- **`CapturePreview`**: 화각 제보 캡처(`/admin/captures/file`)와 사유반휴 증빙
  (`/admin/leave-proof/file`)이 공유하는 fetch-blob 컴포넌트. 봇 로컬 디스크에만
  있는 파일을 Worker가 그때그때 프록시하므로, blob으로 받아 MIME 타입으로
  이미지/영상을 판정한다(별도 필드로 구분 저장하지 않음).
- **`PenaltyHistorySection`/`PenaltyHistoryDetailDialog`**: §3.2("예치금 재납
  대상자")와 개인 대시보드의 "총 페널티" 모달(`docs/WEB_DASHBOARD.md` §9.1,
  `TotalPenaltyDialog`)이 동일하게 재사용하는 슬롯 이력 표시 컴포넌트 —
  관리자·회원 화면 양쪽에서 같은 데이터 구조(`PenaltySlotHistoryEntry`)를
  같은 방식으로 보여준다.

---

## 7. 알려진 함정 / 특이사항

- **`PushNotificationSection.tsx`는 완전한 고아 컴포넌트다.** 저장소 전체에서
  어디에도 import되지 않는다(직접 확인). "브라우저 푸시 알림" 상태 표시 +
  카테고리별 테스트 발송 UI를 담고 있지만, 실제 `AdminPage` 트리에는 없다 —
  기능이 이미 `NotifyPrefsCard`(`docs/WEB_SETTINGS.md` §4.2, 회원 설정 탭)의
  "전송" 버튼(관리자에게만 노출)으로 흡수된 것으로 보인다. 이 파일을 수정해달라는
  요청이 오면 "정말 이 화면이 어딘가에 연결되어 있는지"부터 확인할 것 — 지금은
  코드만 존재하고 아무도 렌더링하지 않는다.
- **"다른 관리자 의견 반영"(제보 심사, §3.1)은 완전한 더미 시뮬레이션이다.**
  `DUMMY_OTHER_ADMINS` 하드코딩 배열 + 주 관리자가 대신 클릭하는 방식 — 실제
  다중 관리자 인증/집계 백엔드는 없다. "합의 판정이 이상하다"는 리포트는 애초에
  이게 UI 프로토타입일 뿐이라는 사실부터 확인할 것.
- **`DUMMY_TIME_PEN_HISTORY`(§3.2)는 주간 P 이력이 비어 있을 때만 화면에
  끼워지는 가짜 데이터다.** 실제 주간 P 이력이 쌓이기 시작하면 조용히 사라져야
  정상이며, 코드에 남아있는 이 상수와 fallback 로직은 제거 대상으로 명시되어
  있다.
- **PEN · Money 탭 "벌금 납부 대상자 처리" 목록의 "직권 P" 버튼(§4.1)과
  Account 탭 `MemberRosterList`의 "퇴실 처리 (직권 P)" 버튼(§3.5)은 서로
  다른 탭에서 같은 `ExitProcessDialog(lockKind="admin_forced")`를 각자
  다른 회원 데이터로 호출하는 서로 다른 진입점이다** — 둘 다 실제로
  확정하면 그 회원을 admin_forced로 즉시 퇴실 처리한다. 요일 헤더의
  "직권 P : 0건" 카운트만 아직 자리표시자로 남아있다(§4.1).
- **`ExitProcessDialog`의 "유형 선택 드롭다운" 분기는 현재 코드베이스에서 실제로
  렌더링될 수 없다**(§3.6). 세 호출부 모두 항상 `lockKind`를 넘기기 때문 — 다만
  `lockKind`가 있어도 "미리보기 계산 버튼 → `<pre>` 결과 → 확정"이라는 그 분기의
  나머지 흐름 자체는 `forced`/`deposit_again` 처리에 실제로 쓰인다. "드롭다운이
  죽은 코드"와 "그 분기 전체가 죽은 코드"를 혼동하지 말 것.
- **`_usageCounters`(사용량 모니터링, §5.1)는 정확한 전체 집계가 아니라 근사
  하한값이다.** Cloudflare Workers의 isolate 분산 특성상 콜드스타트마다
  리셋되고, 그 순간 요청을 받은 isolate가 본 것만 집계된다 — "지금 위험 수준인지"
  참고용이지 정밀 계측이 아니다.
- **"스터디원 목록"(§3.5)과 "예치금 재납 대상자"(§3.2)는 서로 다른 목적의
  회원 조회 함수를 쓴다.** 전자(`listActiveMembersWithExitInfo`)는 이미 퇴실/
  재납 처리된 회원만 제외한 전원, 후자(`listExitCandidates`)는 그중 강제퇴실
  조건(페널티 2회 이상)에 실제로 걸리는 회원만 추린다 — 같은 회원이 두 목록
  모두에 나타날 수 있고(정산도 가능하고 강제퇴실 대상이기도 한 경우), 그 경우
  어느 화면에서 먼저 처리하느냐에 따라 결과가 갈릴 수 있다는 점을 관리자에게
  안내할 때 유의.
- **번호 정렬(§5.3)과 퇴실 확정 처리(§3.6)는 같은 "삭제 후 template 복사"
  패턴을 각자 구현하고 있다.** 하나를 고치면 다른 쪽도 같은 문제가 있는지
  확인하는 습관이 필요하다 — 코드가 공유 함수로 추출되어 있지 않다.
- **"블랙리스트" 등록(§3.5.1)은 순수 정보 표시일 뿐 아무것도 강제하지
  않는다.** `blacklist: true`는 `EXIT_RESULT_KV_PREFIX` 결과에 저장되고
  `ExitedMemberList`에 뱃지/행으로 보일 뿐, "신규 스터디원 등록"
  (`NewMemberForm`, §3.4)은 이 값을 전혀 조회하지 않는다 — 같은 이름·
  이메일로 블랙리스트 등록자를 재등록해도 시스템이 걸러내지 않는다.
  "블랙리스트 등록했는데 왜 재가입이 막히지 않냐"는 문의가 오면 이게
  설계상 미구현(참고용 표시 전용)이라는 점부터 확인할 것 — §의 "5개
  알림 카테고리가 저장만 되고 실제 이벤트에 안 걸림"(`docs/
  WEB_SETTINGS.md` §7)과 같은 성격의 "표시는 있으나 집행은 없음" 패턴.

---

## 8. 관련 문서

- `docs/WEB_DASHBOARD.md` — `buildPersonalStatus`/`StatusResponse`/총 페널티·
  예치금 반환 계산 원본. Money 탭의 회원 상세, "예치금 재납 대상자"의 강제퇴실
  조건 판정이 모두 이 계산을 재사용한다.
- `docs/WEB_REPORT.md` — 제보 제출~봇 캡처까지의 흐름(§3.1이 다루는 화면의
  "이전 단계"). `_appendToLiveIndex` 패턴, `proxyToBotDashboard` 인프라 공유.
- `docs/WEB_SETTINGS.md` — 퇴실 신청/동의(`exitAgreedAt`) 플로우의 회원 쪽 절반,
  `NotifyPrefsCard`(§3.5의 "알림 설정" 카드가 조회 전용으로 재사용하는 원본
  데이터 구조).
- `docs/SHEET_STRUCTURE.md`, `docs/SHEET_APPSCRIPT.md`, `docs/HELPERBOT.md` —
  시트 셀 배치, `sheet_reset()`/`daily_calc()`, 로컬 봇 상태 서버 프로토콜
  (`/status`, `/restart`, `/captures*`, `/leave-proof*`, `/reports*` 등 이
  문서가 프록시하는 모든 봇 엔드포인트의 원본 구현).
