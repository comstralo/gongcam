# 관리자 기능 구조 지도 (WEB_ADMIN.md)

> 이 문서는 웹 서비스(`app/`, Cloudflare Worker `frame-checker-worker/`)의 **관리자**
> 기능(하단 내비게이션의 "/admin" 경로, "MEM · PEN"/"Money"/"Bot · Sheet" 세 탭)을
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

- **MEM · PEN**(`view=member`, 기본값) → `AdminMemberPenaltyTab` — 제보 심사,
  강제퇴실 후보 처리, 사유반휴 승인, 신규 회원 등록, 스터디원 목록 5개 섹션을
  세로로 나열.
- **Money**(`view=money`) → `AdminMoneyTab` — 벌금 납부/미납/면제 3분류 현황.
- **Bot · Sheet**(`view=botsheet`) → `AdminBotSheetTab` — API 사용량 모니터링,
  로컬 도움봇 상태/재시작, 회원 번호 정렬.

세 탭 모두 `docs/WEB_DASHBOARD.md` §3.1과 동일한 "언마운트하지 않고 hidden으로만
감춘다" 패턴(`everOpened` ref)을 쓴다 — 관리자가 탭을 오갈 때마다 각 섹션의
`useEffect(load, [])`가 재실행돼 Sheets API를 재호출하는 걸 막기 위함이며, 실제로
2026-08에 탭 전환 몇 번만으로 `429 RESOURCE_EXHAUSTED`가 재현된 적이 있다(코드
주석에 명시).

---

## 2. 화면 계층 트리 (파일 매핑)

```
AdminPage (app/src/pages/AdminPage.tsx)
├─ [member] AdminMemberPenaltyTab (components/admin/AdminMemberPenaltyTab.tsx)
│   ├─ ReportReviewList        — "송출 P 제보 확인" (§3.1)
│   ├─ PenaltyCandidateList    — "예치금 재납 대상자" (§3.2)
│   ├─ ReasonLeaveReviewList   — "사유 반휴 신청" (§3.3)
│   ├─ NewMemberForm           — "스터디원 등록" (기본 접힘) (§3.4)
│   └─ MemberRosterList        — "스터디원 목록" (§3.5)
│       └─ (PenaltyCandidateList/MemberRosterList 공용) ExitProcessDialog (§3.6)
├─ [money] AdminMoneyTab (components/admin/AdminMoneyTab.tsx)
│   ├─ PaidFineList   — "벌금 납부 현황" (§4)
│   ├─ FineList       — "벌금 미납 현황" (§4)
│   └─ ExemptFineList — "벌금 면제 현황" (§4)
└─ [botsheet] AdminBotSheetTab (components/admin/AdminBotSheetTab.tsx)
    ├─ UsageMonitorSection  — "사용량 모니터링" (§5.1)
    ├─ BotStatusSection     — "도움봇 상태" (§5.2)
    └─ MemberReorderSection — "번호 정렬" (§5.3)

components/admin/shared.tsx — 공용 프리미티브(§6): SectionCard/SectionHeader,
  ItemTitle/FieldLabel/FieldValue, CapturePreview, PenaltyHistorySection/
  PenaltyHistoryDetailDialog.

components/admin/PushNotificationSection.tsx — ⚠️ 어디서도 import되지 않는
  고아 컴포넌트(§7 참고). AdminPage의 실제 트리에는 없다.
```

---

## 3. MEM · PEN 탭

### 3.1 송출 P 제보 확인 (`ReportReviewList`)

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

### 3.2 예치금 재납 대상자 (`PenaltyCandidateList`)

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

### 3.3 사유 반휴 신청 (`ReasonLeaveReviewList`)

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

### 3.4 스터디원 등록 (`NewMemberForm`)

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

### 3.5 스터디원 목록 (`MemberRosterList`)

`GET /admin/members/roster`(→ `handleAdminMembersRoster`)가 전체 활성 회원의
상태·알림 설정·최근 접속 정보를 한 번에 모아 내려준다. 요일별이 아니라 회원별
아코디언 하나로 나열되고, 펼치면 두 정보 카드 + 액션 버튼 그리드가 나온다.

**"상태 정보" 카드**: 참여유형(=`goalType`, batchGet으로 15개 O3 셀을 한 번에
조회), 가입일자, 준비 중인 시험, 구글/구루미 계정("데이터" D~E열), 시트번호
(클릭 시 `https://docs.google.com/spreadsheets/d/{id}/edit#gid={sheetGid}`로
바로가기 — `getSpreadsheetMeta`의 5분 캐시를 그대로 재사용해 추가 API 호출
없음), 퇴실 예약일자, 최근 접속일자/IP(`lastLogin:{번호}` KV, `handleVerify`가
로그인 시 CF-Connecting-IP 헤더로 기록).

**"알림 설정" 카드**: 회원별 카테고리 on/off를 **조회 전용**으로 보여준다(변경은
회원 본인만 `/notify-prefs`로 가능, `docs/WEB_SETTINGS.md` §4.2). PUSH 구독
(`pushSubscribed`) 자체가 꺼져 있으면 카테고리별 저장값이 ON이어도 화면에는 전부
OFF로 표시한다 — "구독은 꺼졌는데 세부 항목은 죄다 ON"으로 보이는 혼란을
막기 위한 의도적 표시 로직(저장값 자체를 바꾸는 건 아님).

**액션 버튼**(§3.6과 연결): 부스터디장 임명/해제(`POST
/admin/members/parti-status`, L3 셀 직접 전환, 스터디장은 이 API로 건드릴 수
없음), "퇴실 처리 (직권 P)"(`lockKind="admin_forced"`, 항상 활성), "퇴실 처리
(정산)"(`lockKind="settle"`, **`m.exitAgreedAt`이 있어야만 활성** — 회원이
"예치금 정산액에 동의합니다"를 누르기 전엔 클릭 자체가 막힌다), 그리고
`m.exitRequested`일 때만 나타나는 "신청 취소"(`POST /exit-request/cancel`을
관리자 권한으로, body에 `number` 포함).

> 이 화면은 **자진 퇴실 전용**으로 설계 의도가 명확하다(코드 주석): 페널티
> 누적으로 인한 강제퇴실/예치금 재납은 §3.2("예치금 재납 대상자")에서 별도로
> 처리하므로, 이 목록에서는 처리 유형을 관리자가 자유롭게 고를 수 없다 —
> "같은 회원에게 kind만 다르게 골라 반환율이 달라지는 것을 막기 위함"(사용자
> 지시: "무조건 계산은 어디서나 일치해야 해"). §3.6에서 이 설계가 어떻게
> `ExitProcessDialog`의 `lockKind` prop으로 구현됐는지 정리한다.

### 3.6 퇴실·재납 공유 다이얼로그 (`ExitProcessDialog`)

`docs/WEB_REPORT.md`·`docs/WEB_DASHBOARD.md`의 §9.2(예치금 반환 계산)와
직결되는 이 저장소에서 가장 복잡한 다이얼로그. `ExitKind`(4종) × 호출부(2곳)
조합이 전부 `lockKind`로 고정되어 있어, **관리자가 유형을 자유 선택하는 실제
경로는 현재 코드베이스 어디에도 없다**:

| `ExitKind` | 의미 | 반환율 | 호출부 | `lockKind` |
|---|---|---|---|---|
| `forced` | 강제 퇴실(페널티 2회 이상 등 자동 감지) | 항상 0% | PenaltyCandidateList | `"forced"` |
| `deposit_again` | 예치금 재납(회원 행 리셋, 퇴실은 아님) | 항상 0%(재납액 전액) | PenaltyCandidateList | `"deposit_again"` |
| `admin_forced` | 직권 퇴실(관리자 임의 사유) | 항상 0% | MemberRosterList | `"admin_forced"` |
| `settle` | 정산(자진) 퇴실 | 페널티 0회→100% / 1회→50% | MemberRosterList | `"settle"` |

이 표에 따라 다이얼로그 내부는 세 가지 렌더 분기로 나뉜다(`isAdminForcedOnly`/
`isSettleOnly`/그 외):

- **`admin_forced`**: 사유 입력 하나만 받고 바로 확정. 미리보기 계산 단계 없음
  (discountRatio가 항상 1로 고정돼 미리보기가 보여줄 새 정보가 없기 때문).
- **`settle`**: 다이얼로그가 열리자마자(useEffect) 자동으로 `POST
  /admin/exit/preview`를 호출해 계산 결과를 바로 보여준다 — 별도의 "미리보기
  계산" 버튼 클릭이 필요 없다. "반환 예치금"/"차감 원인"(`buildDepositCauseItems`,
  `docs/WEB_SETTINGS.md` §3.2와 동일 함수 재사용)/"처리 결과"/"시트 변동사항"/
  "퇴실 프로세스"(신청일자·예약일자·동의일자, `exitAgreedAt`이 없으면 강조
  표시) 5개 카드로 구성. **`preview.fromBackup`이 true면 "데이터 기준: 지난 주
  백업 시트" 서브로우가 추가된다** — `sheet_reset`(매주 월요일 새벽) 이후에
  정산 처리가 이루어지는 경우 원본 대신 자동 백업 파일에서 계산했다는 뜻(이번
  세션에 구현된 로직, `computeExitResult`/`resolveExitSourceFileId`, index.js).
- **`forced`/`deposit_again`(그 외 분기)**: `lockKind`가 있어도 유형 선택
  드롭다운 자리에 고정 라벨만 보이고, **"미리보기 계산" 버튼을 명시적으로 눌러야
  하는 3단계 흐름**(계산 → `resultMsg`를 `<pre>`로 그대로 출력 → 확정)을 그대로
  쓴다. 이 분기 안의 `Select` 드롭다운(유형을 자유 선택하는 UI)은 `lockKind`가
  전달되지 않을 때만 노출되는데, **현재 두 호출부 모두 항상 `lockKind`를
  넘기므로 이 드롭다운은 실제로 렌더링될 일이 없다** — 향후 세 번째 호출부가
  `lockKind` 없이 이 다이얼로그를 열지 않는 한 죽은 UI 경로다.

확정(`POST /admin/exit/confirm`) 시 서버는 프론트가 보낸 `kind`를 그대로
신뢰하지 않고 §3.5에서 언급한 "정산은 동의까지 필요" 검증을 다시 수행한다
(`docs/WEB_SETTINGS.md` §5 표의 `/exit-request/agree`와 대응) — 프론트가
버튼을 비활성화해도 API를 직접 두드리는 경로까지 막기 위함.

---

## 4. Money 탭 (`AdminMoneyTab`)

🔧 2026-09: 원래 세 개의 거의-동형 리스트(납부/미납/면제 현황)가 나란히
있었으나, 사용자 지시로 **"벌금 미납 현황"(`FineList`)과 "벌금 면제
현황"(`ExemptFineList`)을 완전히 제거**하고 **"벌금 납부 현황"만 남겨
"벌금 납부 대상자 처리"로 개명**했다 — 지금 `AdminMoneyTab`은
`PaidFineList` 하나만 렌더링한다. 개인 탭 "✅ 납부확인" 행
(`docs/WEB_DASHBOARD.md` §10의 `ROW_PAYMENT_CHECK`)에서 상태값이 "납부"인
(회원, 요일) 쌍을 요일별로 그룹핑해 보여주는 §3.1(`ReportReviewList`)과
동일한 디자인 패턴(아이콘+무채색 요일 라벨, 상태 필 배지, 요일별 아코디언 →
인원별 토글)으로 맞춰져 있다.

- `PaidFineList`가 부르는 `listPaidFines`는 여전히 `getAllPaymentRows` →
  `getSharedMemberRows`(15명 개인 탭 A1:U40을 batchGet, 60초 캐시)를 거친다
  — 이 캐시는 §3.2/§3.5가 쓰는 `getAllExitRelevantStatus`(→
  `listExitCandidates`/`listActiveMembersWithExitInfo`가 공유)가 내부적으로
  호출하는 것과 **같은 캐시 키**(`memberRows:{fileId}`)다.
- **요일 헤더 배지**: 🔧 2026-09 추가 — `load()`가 `/admin/fines/paid`뿐
  아니라 `/admin/fines/unpaid`/`/admin/fines/exempt`도 `Promise.all`로 함께
  불러와(`AdminFinesUnpaidResponse`/`AdminFinesExemptResponse`, §3.1
  `ReportReviewList`의 대기/적용/반려 배지와 동일한 위계) 요일별 인원수만
  센다(`countByDay`). 순서는 납부(ok, 초록) → 미납(destructive, 빨강) →
  면제(amber, 주황) → **직권 P(primary, 파랑)**. 다만 **요일 그룹 자체는
  여전히 "납부" 항목 기준으로만 나열된다** — 그날 미납/면제만 있고 납부
  건이 0이면 그 요일은 아예 그룹으로 나타나지 않아, 그 요일의 미납/면제
  배지도 함께 보이지 않는다(순수 카운트 참고용이지, 이 목록이 미납/면제
  항목 자체를 펼쳐 보여주거나 조작하지는 않는다).
- **"직권 P" 배지는 아직 자리표시자다.** 항상 `직권 P : 0건`으로 고정
  표시되며, 어떤 인원을 세야 하는지(집계 로직)가 아직 정해지지 않아 실제
  카운트가 연결되어 있지 않다 — 코드 주석에 "🧪 [자리표시자]"로 명시. 처음엔
  "강퇴"라는 라벨로 추가됐다가 §3.5/§3.6의 "직권 P"(`admin_forced`,
  `ExitProcessDialog(lockKind="admin_forced")`) 용어에 맞춰 이름만 바뀐
  상태 — 실제로 그 처리와 연결되어 있는 건 아니다. 집계 기준을 나중에
  사용자가 정해 알려주기로 함.
- **상태 변경**: `POST /admin/fines/status`(회원번호+요일+새 상태) — "미납"/
  "면제" 버튼으로 되돌릴 수 있다. 세 리스트가 있던 시절엔 이 변경이 다른
  두 리스트를 교차 재조회시켰지만(`refreshToken`/`handleFineResolved`),
  그 두 리스트 자체가 사라지면서 이 플러밍도 함께 제거됐다 — 지금은 상태를
  바꾼 항목이 이 목록에서만 조용히 빠질 뿐이다(3배지 카운트는 다음
  `load()` 전까지 갱신되지 않는다).
- **회원 상세**: 각 항목을 펼치면 `GET /admin/members/{번호}`
  (`handleAdminMemberStatus`, `docs/WEB_DASHBOARD.md`의 `buildPersonalStatus`를
  그대로 재사용)로 그 회원의 전체 `StatusResponse`를 불러와 해당 요일만
  `DayDetailCard`(`docs/WEB_DASHBOARD.md` §4.1)로 보여준다 — 회원별로 처음
  펼칠 때만 조회하고 이후엔 캐싱된 `dayDetail` state를 재사용.
- **납부된 총 벌금액**: 상단 요약 — `집계!D22`(`getWeeklyPaidFineTotal`,
  60초 캐시)를 그대로 읽는다.

> ⚠️ **백엔드 `/admin/fines/unpaid`/`/admin/fines/exempt`는 UI가 다시
> 호출하기 시작했지만(위 "요일 헤더 배지"), 오직 카운트용이다.** `FineList`/
> `ExemptFineList` 자체(개별 항목 펼치기, 상세 조회, 상태 변경 버튼)는
> 부활하지 않았다 — "미납"/"직권 P" 버튼이 하던 "강제퇴실 처리 — 아직
> 미구현" 자리표시자도 그 두 컴포넌트와 함께 여전히 사라진 상태다. 그
> 기능이 필요해지면 §3.5의 "퇴실 처리 (직권 P)"(`MemberRosterList`,
> `ExitProcessDialog(lockKind="admin_forced")`, 이미 동작 중)를 참고해
> 어디에 다시 넣을지 새로 정해야 한다.

---

## 5. Bot · Sheet 탭 (`AdminBotSheetTab`)

### 5.1 사용량 모니터링 (`UsageMonitorSection`)

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

### 5.2 도움봇 상태 (`BotStatusSection`)

`GET /admin/bot/status` → `handleAdminBotStatus` → `proxyToBotDashboard(env,
"/status")`. 로컬 도움봇(`study_manager_260418.py`, `docs/HELPERBOT.md`)이
Cloudflare Tunnel로 노출한 로컬 상태 서버를 그때그때 프록시한다(폴링이 아니라
요청 시점 즉시 호출) — 온라인 여부, 스터디룸 접속 상태, 현재 화면 스크린샷
(base64 PNG), 최근 로그를 보여준다. 관리자가 원격으로 내릴 수 있는 유일한 명령은
**"재시작"**(`POST /admin/bot/command {command:"restart"}`, `BOT_COMMAND_VALUES =
["restart"]`)뿐이다 — 봇이 브라우저를 새로 열고 스터디룸에 재입장한다. 봇이
꺼져 있으면(`proxyToBotDashboard`가 null) 프론트는 "오프라인"으로만 표시하고
502가 아니라 200으로 조용히 응답한다.

### 5.3 번호 정렬 (`MemberReorderSection`)

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
- **Money 탭 "미납" 목록의 "직권 P" 버튼은 항상 비활성화된 자리표시자다**(§4).
  같은 이름의 실제 기능(`ExitProcessDialog(lockKind="admin_forced")`)은
  `MemberRosterList`에 이미 있다 — 서로 다른 화면의 서로 다른 진입점이니 착각
  주의.
- **`ExitProcessDialog`의 "유형 선택 드롭다운" 분기는 현재 코드베이스에서 실제로
  렌더링될 수 없다**(§3.6). 두 호출부 모두 항상 `lockKind`를 넘기기 때문 — 다만
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
