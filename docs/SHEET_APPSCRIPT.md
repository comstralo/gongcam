# 공부합시당 캠스터디 — Google Apps Script 구조 문서

원본: `study_sw/resource/appscript.js` (1680줄)
스프레드시트 ID: `1jjIo-SulFyonrv2dSFYO4SVsejKgbfogCJLVLbA-0Ao` (`SHEET_STRUCTURE.md`와 동일)
서비스 계정: `id-630@crack-decorator-450006-g9.iam.gserviceaccount.com`

이 스크립트는 `frame-checker-worker`(웹앱 백엔드)와 별개로, Google Sheets에 바인딩되어 시간 기반 트리거와 커스텀 메뉴로 동작하는 자동화 계층이다. 웹앱은 대부분 **읽기**만 하고, 실제 데이터 변경(일일/주간 정산, 회원 등록/퇴실, 권한 부여)의 상당수는 지금도 이 앱스크립트가 담당한다.

## 전역 상수 (셀 위치 매핑)

`SHEET_STRUCTURE.md`와 대조 가능한 이름 매핑 — 앱스크립트 변수명과 index.js 상수명이 다르므로 대조표로 정리한다.

### 집계 시트

| 앱스크립트 변수 | 셀 | 의미 | index.js 대응 |
|---|---|---|---|
| `collect_money_cell` | D20 | 총 모금액 | (읽기 전용, 미사용) |
| `fine_carry_cell` | D21 | 이월 상금 | |
| `fine_thisweek_cell` | D22 | 주간 벌금 | |
| `fine_outer_cell` | D23 | 퇴실 벌금 | |
| `deposit_outer_cell` | D24 | 퇴실 예치 | |
| `collect_carry_check_cell` | Q6 | 총 모금액 이월 체크박스 | |
| `period_omission_cell` | R6 | 오류 교시 수(구루미 오류 보정용) | |
| `pen_cycle_cell` | D25 | 페널티 사이클(1→2→3→1 순환) | |
| `leader_output_pen_cell` | H4 | 스터디장 금주 송출 P | |
| `leader_time_pen_cell` | J4 | 스터디장 금주 주간 P | |

### 개인 탭(1~15, template)

| 앱스크립트 변수 | 셀 | 의미 | index.js 상수 (0-idx) |
|---|---|---|---|
| `member_name_cell` | B2 | `📝 OO 님의 집계표 📝` | — |
| `accession_date_cell` | I2 | 가입일자 | `ROW_JOIN_DATE` |
| `accession_date_dday_cell` | I3 | D+n | `ROW_ACCESSION_DDAY` |
| `parti_status_cell` | L3 | 참여상태 | `ROW_PARTI_STATUS`/`COL_PARTI_STATUS` |
| `target_time_cell` | O3 | 목표시간 | — |
| `deposit_again_cell` | R3 | 예치금 재납 | `ROW_DEPOSIT_AGAIN`/`COL_DEPOSIT_AGAIN` |
| `fine_no_status_cell` | C33 | 미납신호 | `ROW_FINE_NO_STATUS` |
| `fine_already_payment_cell` | C34 | 주간벌금(=SUMIF로 "납부"만 합산) | `ROW_WEEKLY_TOTAL_FINE` |
| `report_sheet_row_cell` | C38 | 제보상점 시트 행 번호 | `ROW_REPORT_SHEET_ROW` |
| `output_pen_thisweek_cell` | C39 | 금주 송출 P | `ROW_OUTPUT_PEN_THISWEEK` |
| `output_pen_cumul_cell` | C40 | 누적 송출 P | `ROW_OUTPUT_PEN_CUMUL` |
| `time_pen_thisweek_cell` | C41 | 금주 달성(주간) P | `ROW_TIME_PEN_THISWEEK` |
| `time_pen_cumul_cell` | C42 | 누적 달성(주간) P | `ROW_TIME_PEN_CUMUL` |
| `holiday_normal_use_thiskweek_cell` | C44 | 일반 반휴 잔여량 | `ROW_NORMAL_LEAVE_LEFT` |
| `holiday_reason_use_thisweek_cell` | C45 | 사유 반휴 잔여량 | `ROW_REASON_LEAVE_LEFT` |
| `holiday_reason_use_cumul_cell` | C46 | 사유 반휴 누적 사용량 | — |
| `holiday_normal_row`/`holiday_reason_row` | 20/21행 | 일반/사유 반휴 사용 여부 | `ROW_NORMAL_LEAVE_USE`/`ROW_REASON_LEAVE_USE` |
| `add_time_row` | 27행 | 가산 학습시간 | `ROW_BONUS_STUDY_TIME` |
| `fine_value_row` | 29행 | 일간 총 벌금 | `ROW_TOTAL_FINE` |
| `fine_check_row` | 32행 | 납부확인(미납/납부/면제) | `ROW_PAYMENT_CHECK` |

요일별 시작열은 `cell_ranges()` 함수가 계산한다 — 월=C, 화=F, 수=I, 목=L, 금=O, 토=R, 일=U (index.js `STATUS_DAY_COLS`와 동일한 규칙).

## 트리거 실행 함수 (시간 기반, 자동)

시간 기반 트리거는 앱스크립트 프로젝트 설정에서 별도로 연결되어 있으며, 이 파일 코드만으로는 정확한 예약 시각을 알 수 없다 — 아래는 각 함수 위의 주석에 적힌 **권장/설계 시각**이다.

| 함수 | 주기 | 권장 시각 | 역할 |
|---|---|---|---|
| `daily_calc()` | 일 단위 | 자정~오전 1시 | **일간집계**: 미입력 교시를 `ERR`/`00:00`으로 채우고, 구루미 오류 보정 가산시간 적용, 벌금 발생 시 미입력 납부확인 칸을 "미납"으로, 페널티 누적 2 이상이면 예치금 재납(R3)을 "미납"으로 자동 설정. 🔧 2026-09: 루프 진입 전 `_fetchExitDates()`로 Worker의 `GET /bot/exit-requests`를 1회 조회해 "회원번호→exitDate" 맵을 가져오고, 그 회원의 마지막 참여일(exitDate)이 지난 시트는 이 모든 처리를 통째로 건너뛴다(§"마지막 참여일 이후 집계 차단" 참고) |
| `sheet_reset()` | 주 단위(월) | 오전 5~6시 | **주간 전체 초기화**: Drive에 전체 시트 백업 복사본 생성 → 이월상금/퇴실벌금/퇴실예치 리셋 → 페널티 사이클에 따라 누적치 초기화 또는 갱신 → 개인 탭 C6:W23 내용 삭제 → 제보상점 초기화 → "퇴실"/"재납" 백업 탭 전체 삭제 |
| `grant_editor_column_n()` | 주 단위(월) | 오전 7~8시 | 집계 탭 N열(목표시간 변경 신청)에 회원별 편집 권한 부여(스마트 diff로 필요한 경우만 API 호출) |
| `revoke_editor_column_n()` | 주 단위(월) | 오후 2~3시 | N열 입력값을 검증해 유효하면 해당 개인 탭 O3(목표시간)에 반영하고, N열 편집 권한을 관리자만으로 회수 — **웹앱의 `/goal-schedule` 마감 시각(매주 월 14:00)과 정확히 일치** |
| `grant_editor_column_o()` | 일 단위 | 오전 7~8시 | 집계 탭 O열(일반반휴 신청)에 회원별 편집 권한 부여 |
| `revoke_editor_column_o()` | 일 단위 | 밤 11시~12시 | O열 입력값("1장"/"2장")을 검증해 개인 탭 20행(일반반휴 사용)에 반영, 중복/초과 시 "오류" 문구 기록, O열 권한 회수 — **일반반휴 신청 마감 매일 23:00과 일치** |

## 커스텀 메뉴 함수 (수동, 관리자 트리거)

스프레드시트를 연 관리자가 커스텀 메뉴에서 직접 실행하는 함수들. 모두 `check_execute_auth()`로 시트 소유자인지 확인 후 실행된다.

### `weekly_calc()` — 주간집계(상금 분배 대상 출력)

집계 탭 D20:D24(총 모금액~퇴실예치)와 H4/J4(스터디장 페널티)를 읽고, 순위가 🥇🥈🥉🏅인 회원만 골라 상금 분배 메시지를 조립해 `ui.alert`로 출력한다. 상금 수령자가 없으면 총 모금액을 D21(이월 상금)에 누적한다. 이 함수는 데이터를 확정 반영하지 않고 **미리보기/공지 문구 생성**이 목적이다.

### `manage_member_selector()` — 스터디원 관리 라우터

프롬프트로 "① 신규 등록 / ② 퇴실자 반환금 예상 / ③ 퇴실자·재납자 처리" 중 선택받아 아래 서브 함수로 위임한다.

- **`_set_new_member()`**: 이름/시트번호/의무시간·타입/이메일/시험정보를 순차 프롬프트로 입력받아, 해당 번호 시트가 없으면 template을 복사해 생성하고 `_set_sheet_init("신규회원", ...)`으로 초기화한다. **웹앱의 `handleAdminCreateMember`가 이 흐름을 대체하는 관계** — 웹앱은 폼 UI로 한 번에 입력받고 Drive 권한 위임까지 자동 처리하지만, 이 함수는 프롬프트 기반 수동 절차다.
- **`_exit_define("preview" | "define")`**: 퇴실/재납 처리의 핵심. 이름을 입력받아 시트를 찾고, 세 갈래로 분기한다.
  1. `_calc_forced_out_deposit()` — 강제퇴실 사유 자동 판정(가입 30일 미만 / 벌금 시한 미납 / 예치금 시한 미납) + 관리자가 직접 사유를 입력하면 "즉시 강제퇴실"도 추가. 하나라도 해당하면 discount_ratio=1(0% 반환)로 확정되고, 이후 프롬프트 없이 바로 처리된다.
  2. 위에 해당 없으면 "① 정산 퇴실자 / ② 예치금 재납자" 중 선택 프롬프트.
     - `_calc_return_deposit()`: 총 페널티(송출P+주간P 누적) 0회=100%반환, 1회=50%반환, 2회 이상=0%반환.
     - `_calc_again_deposit()`: R3가 "납부"여야만 진행(아니면 취소), 진행 시 discount_ratio=1(예치금 재납자는 100% 귀속).
  3. `"define"`으로 호출됐을 때만 실제 반영: 참여상태 셀에 "퇴실자 (N% 반환)" 또는 "재납자 (0% 반환)" 기록, 집계 탭 퇴실벌금/퇴실예치 누적 갱신, 일요일 발생 여부를 추가로 물어본 뒤 `_set_sheet_init()`으로 시트를 백업 탭으로 옮기고 원래 슬롯을 리셋한다. `"preview"`로 호출되면 계산 결과 메시지만 보여주고 시트는 변경하지 않는다.

### `manage_penalty_selector()` — 페널티 및 상점 관리 라우터

"① 벌점 추가·삭제 / ② 제보자 상점 추가·삭제 / ③ 총 벌점·상점 확인" 중 선택.

- **`_add_sub_penalty_score()`**: 이름+점수를 입력받아 제보상점 탭 L열(벌점)에 `점수*0.1`을 가감(0 미만 방지, 부동소수점 오차 보정 포함).
- **`_add_sub_report_score()`**: 이름+요일+점수를 입력받아 제보상점 탭 D~J열(요일별) 중 해당 칸에 가감.
- **`_view_report_score()`**: 전체 15명의 요일별 제보점수+총점(K열)+벌점(L열)을 텍스트 표로 만들어 `ui.alert`로 출력(읽기 전용).

## 핵심 공유 로직

### `_set_sheet_init(process_kind, member_sheet, name, date, status, goal_level, email, exam_kind, row_number, result_msg)`

신규 등록/퇴실/재납 세 갈래 모두가 최종적으로 거치는 함수. `process_kind`가 "신규회원"이 아니면:

1. 처리 전 데이터를 `"{이름} (퇴실)"` 또는 `"{이름} (재납)"` 이름의 백업 탭으로 통째로 복사(`copyTo`)하고, 그 탭의 Y2:AC18 영역에 `result_msg`(처리 결과 요약)를 붙여넣은 뒤 시트를 보호 처리한다.
2. **퇴실자**인 경우: 원래 시트를 삭제하고 template을 복사해 같은 번호로 재생성, 권한관리 탭의 이메일/시험정보를 지우고 `remove_access()`로 Drive 편집 권한도 회수, 제보상점 데이터도 0으로 리셋.
3. **재납자**인 경우: B2(이름 라벨)와 O3(목표시간)만 백업해두고 나머지는 template으로 리셋한 뒤 그 두 값과 가입일자/참여상태를 복원 — 즉 재납자는 이름 유지한 채 이번 주 기록만 초기화되는 것.
4. `process_kind`에 `"_sunday"`가 포함되면(일요일에 발생한 처리) — 이 로직이 실행되는 스프레드시트가 이미 그 주의 로컬 사본(Drive 백업 파일)일 수 있다는 뜻으로, `get_sh_spreadsheet()`로 원본(공유) 시트에도 동일한 리셋을 한 번 더 적용한다. **이 부분이 이전 세션에서 논의됐던 "경로 A/경로 B" 문제의 실체** — 처리 시점이 정산 주간 중(원본 시트에서 실행)인지 이미 마감된 지난 주(Drive 백업 파일에서 실행)인지에 따라 반영 대상이 갈린다.

`process_kind === "신규회원"`이면 위 백업 로직 없이 바로 개인 탭에 이름/가입일/참여상태/목표시간을 채우고, 권한관리 탭에 이메일·시험정보 기록, `grant_access()`로 Drive 편집 권한 부여, 시트 보호 설정. 등록 시각이 평일 07~23시면 `grant_editor_column_o()`(반휴 신청 권한)를, 월요일 07~14시면 `grant_editor_column_n()`(목표시간 변경 권한)를 즉시 한 번 더 실행해 등록 당일부터 신청 가능하게 한다.

### 권한 부여/회수 계열 (`grant_access`, `remove_access`, `protect_sheet`, `protectSheetForAdmins`)

- `grant_access(email)` / `remove_access(spread_sheet, email)`: 스프레드시트 파일 자체의 편집자(Editor) 추가/제거 — 이게 곧 로그인 게이트 역할도 겸한다(웹앱의 `grantSheetAccess`/OAuth 위임과 동일한 목적, 단 이쪽은 앱스크립트가 소유자 권한으로 직접 실행하므로 위임 토큰이 필요 없다).
- `protect_sheet(spread_sheet, sheet_name)`: 개인 탭 전체를 "소유자+서비스계정만 편집 가능"으로 보호 — 신규/퇴실/재납으로 시트가 재생성될 때마다 재적용됨.
- `protectSheetForAdmins()`: 집계 탭 전체를 관리자(소유자+서비스계정)만 편집 가능하도록 보호(수동 실행용, 트리거 연결 여부 불명).
- `grant_editor_column_n/o()`와 `revoke_editor_column_n/o()`: 개인별 단일 셀(N열 또는 O열의 자기 행)에 한해 신청 기간에만 본인 편집을 허용하고, 마감 후 회수하는 "스마트 diff" 방식 — 이미 올바른 권한 상태면 API 호출을 생략해 속도를 최적화했다는 주석이 반복적으로 강조되어 있음.

## 보조 유틸리티

| 함수 | 역할 |
|---|---|
| `get_op_spreadsheet()` | 수동 실행 시 "현재 열려 있는" 스프레드시트 반환 |
| `get_sh_spreadsheet()` | ID로 원본(공유) 스프레드시트를 명시적으로 열어 반환 — 트리거 실행 시 사용, `_set_sheet_init`의 `_sunday` 분기에서 "원본과 다른 파일에서 실행 중일 수 있다"를 구분하는 데도 사용 |
| `get_adjusted_day_of_week()` | 새벽 3시 이전이면 전날로 보정한 요일(0=일~6=토) 반환 — 자정 넘어 하는 공부도 "그 전날 기록"으로 취급하기 위함 |
| `cell_ranges(day_of_week)` | 요일별 시작/종료/참여율 열 문자를 반환(월=C.. 일=U) |
| `check_no_member_sheet(member_sheet)` | B2 값이 `📝 N번 님의 집계표 📝`(미등록 기본값) 패턴이면 `false` — 아직 회원이 등록 안 된 빈 시트를 걸러내는 용도 |
| `get_last_week_date_range()` | `YYMMDD-YYMMDD` 형식의 지난주 월~일 날짜 범위 문자열 생성(백업 파일명에 사용) |
| `get_formatted_date()` | `YYYY-MM-DD` 오늘 날짜 |
| `number_with_comma(x)` | 천단위 콤마 |
| `get_sheet_number(spread_sheet, name)` | 집계 탭에서 이름으로 회원번호 역조회 |
| `toggle_display()` | 15개 개인 탭의 특정 행 그룹(26~28, 30~31, 33~34, 36, 39~43, 46)을 일괄 숨김/표시 토글, 37~38행은 항상 숨김 — 관리자가 수식 노출을 줄이기 위한 UI 편의 기능 |
| `sort_sheets(spread_sheet)` | 탭 순서를 "집계 → 1~15 → 나머지"로 정렬하고 template/권한관리/제보상점을 숨김, 1~15는 항상 표시 — 신규/퇴실/재납 처리 후 매번 호출됨 |
| `make_all_sheet()` | 1~15 전체를 template로 강제 재생성(초기 세팅/전면 리셋용, 트리거 미연결 추정) |

## 마지막 참여일 이후 집계 차단 (`_fetchExitDates`, 2026-09 추가)

퇴실 신청 회원이 신청서에 적은 "마지막 참여일"(exitDate)이 지났는데도 관리자가
확정 처리(`docs/WEB_ADMIN.md` §3.6 `ExitProcessDialog`)를 늦게 하면, 그 사이
`daily_calc()`가 매일 밤 그 회원의 빈 칸을 그대로 `00:00`/`ERR`로 채우고 벌금
미납을 켜고, 일요일엔 새 주간 P 페널티까지 추가해버리는 문제가 있었다(도움봇도
매 교시 같은 문제를 일으킴 — `docs/HELPERBOT.md`의 "마지막 참여일 이후 집계
차단" 절 참고). 회원은 이미 그만두겠다고 통보했는데 관리자 처리가 늦어졌다는
이유만으로 불리한 벌금·페널티가 계속 쌓이는 것을 막기 위한 조치다.

- **`_fetchExitDates()`**: `daily_calc()` 루프 진입 전에 딱 한 번,
  `UrlFetchApp.fetch(worker_base_url + "/bot/exit-requests", ...)`로 Worker의
  `GET /bot/exit-requests`(`X-Bot-Secret` 인증, `frame-checker-worker/src/index.js`의
  `handleBotExitRequests`)를 호출해 `{"번호": "exitDate", ...}` 맵을 가져온다.
  이 시크릿은 **소스에 하드코딩하지 않고** Apps Script 프로젝트의 "스크립트
  속성"(프로젝트 설정 > 스크립트 속성)에 키 `BOT_SECRET`으로 등록해야 한다 —
  `.env`/Cloudflare Worker의 `BOT_SECRET`과 동일한 값. **미등록이거나 조회
  실패 시 빈 객체를 반환해, 이 기능이 없던 것처럼 아무도 건너뛰지 않고 그대로
  처리한다**(안전한 방향의 폴백 — 조회 실패로 정상 회원의 집계가 통째로
  막히는 일은 없다).
- **판정 기준**: exitDate **당일까지는 정상 처리**하고, 그 다음날(`오늘 날짜
  문자열 > exitDate`)부터 그 회원의 시트를 이번 실행에서 통째로 건너뛴다
  (`daily_calc()` 루프의 `continue`).
- **Apps Script가 외부 HTTP를 호출하는 첫 사례**다 — 이전까지 이 스크립트는
  `UrlFetchApp`을 전혀 쓰지 않았다. 코드 저장/실행 시 `script.external_request`
  권한 재승인 팝업이 한 번 뜰 수 있다.
- 이 로직은 **웹앱(exitRequest KV)에 의존**한다 — 웹앱이 exit-request 인덱스를
  지우거나(취소) 갱신하면 다음 `daily_calc()` 실행부터 즉시 반영된다. 관리자가
  실제로 "확정 처리"를 눌러 `performExitReset`/`performDepositAgainReset`이
  시트를 백업 탭으로 옮기고 나면 그 회원 번호는 다시 빈 슬롯이 되어
  `check_no_member_sheet`에서 이미 걸러지므로, 이 exitDate 스킵 로직 자체가
  필요 없어진다(정상적인 다음 단계로 자연스럽게 넘어감).

## 웹앱(frame-checker-worker)과의 관계 요약

- **읽기는 대부분 웹앱이 커버**: 개인 상태, 집계 랭킹, 로스터, 벌금/예치금 미납 목록 등은 `index.js`가 서비스 계정으로 직접 조회.
- **쓰기는 영역이 나뉘어 있음**:
  - 웹앱이 담당: 신규 등록(`handleAdminCreateMember`), 목표시간 예약(`/goal-schedule`), 벌금 미납/납부/면제 상태 변경(`/admin/fines/status`), 예치금 미납/납부 변경(`/admin/deposits/status`), **퇴실·재납 최종 확정 처리**(`/admin/exit/confirm` → `handleAdminExitConfirm` → `performExitReset`/`performDepositAgainReset`, `docs/WEB_ADMIN.md` §3.6). 🔧 2026-09: 이 부분은 예전에 앱스크립트(`_exit_define`→`_set_sheet_init`) 전담이었으나 이후 세션에서 웹앱으로 이관되었다 — 지금은 앱스크립트의 `manage_member_selector()`/`_exit_define()`이 프롬프트 기반 수동 대체 경로로 여전히 존재하지만, 실제 운영은 웹앱 쪽이 담당한다(둘 다 최종적으로 `_set_sheet_init`과 동일한 "백업 탭으로 이동 + template 재생성" 패턴을 각자 구현하고 있어, 하나를 고칠 때 다른 쪽도 같은 문제가 있는지 확인하는 습관이 필요). 🔧 2026-09 추가: 이관 당시 `_append_data_audit_snapshot()`(§핵심 공유 로직의 "데이터 감사" 절)이 함께 옮겨지지 않아, 웹 경로로 퇴실/재납 처리한 회원은 "데이터 (감사)" 시트에 스냅샷이 전혀 남지 않는 채로 한동안 운영되었다 — `performExitReset`/`performDepositAgainReset`이 만드는 백업 탭도 앱스크립트와 마찬가지로 `copyTo`로 원본을 그대로 복사해 `INDIRECT("'데이터'!..." & C42)` 형태의 살아있는 수식을 그대로 갖고 있어, 이 스냅샷/수식 치환 없이는 그 번호가 나중에 재사용될 때 이미 확정된 퇴실자의 백업 탭이 새 회원의 값을 잘못 참조하는 오염 위험이 있었다. `appendDataAuditSnapshot`/`rewriteBackupAuditFormulas`(index.js)로 동일 로직을 이식해 두 경로가 다시 동등해졌다.
  - 앱스크립트만 담당: 일간/주간 자동 정산(`daily_calc`, `sheet_reset`), 신청 권한 부여/회수(N/O열), 상점/벌점 수동 가감, 상금 대상자 계산.
- **Worker와 완전히 무관하다는 설명은 더 이상 정확하지 않다**: `daily_calc()`가 위 "마지막 참여일 이후 집계 차단" 절에서 설명한 대로 이제 Worker의 `/bot/exit-requests`를 직접 호출한다.
