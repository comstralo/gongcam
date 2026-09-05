const spread_sheet_id = "1jjIo-SulFyonrv2dSFYO4SVsejKgbfogCJLVLbA-0Ao";

// 🔧 [마지막 참여일 이후 집계 차단] daily_calc()가 퇴실 신청 회원의 exitDate를
// 조회할 때 쓰는 Worker 엔드포인트 — 도움봇(exit_sync.py)과 동일한 인증
// 방식(X-Bot-Secret)을 쓴다. BOT_SECRET 값은 소스에 직접 넣지 않고 Apps
// Script 프로젝트의 "스크립트 속성"(파일 > 프로젝트 설정 > 스크립트 속성)에
// 키 "BOT_SECRET"로 등록해야 한다 — .env/Worker의 BOT_SECRET과 동일한 값.
const worker_base_url = "https://frame-checker-worker.comstralo.workers.dev";

// 기타 전역 값
const deposit_value = 10000;
const service_account_email =
  "id-630@crack-decorator-450006-g9.iam.gserviceaccount.com";

// '집계' 시트의 셀 위치
const collect_money_cell = "D20"; // 총 모금액
const fine_carry_cell = "D21"; // 이월 상금
const fine_thisweek_cell = "D22"; // 주간 벌금
const fine_outer_cell = "D23"; // 퇴실 벌금
const deposit_outer_cell = "D24"; // 퇴실 예치

const collect_carry_check_cell = "Q6"; // 총 모금액 이월 (체크박스)
const period_omission_cell = "R6"; // 오류 교시 수
const pen_cycle_cell = "D25"; // 페널티 사이클

const leader_output_pen_cell = "H4"; // 스터디장 금주 송출 P
const leader_time_pen_cell = "J4"; // 스터디장 금주 주간 P

const prize_name_row = 3; // 이름
const prize_time_row = 4; // 주간 학습시간
const prize_score_row = 6; // 상점 값
const prize_rank_row = 7; // 순위

// '개인' 시트의 셀 위치
const member_name_cell = "B2"; // 📝 OO 님의 집계표 📝
const accession_date_cell = "I2"; // 가입일자 (2025-01-01)
const accession_date_dday_cell = "I3"; // D+0
const parti_status_cell = "L3"; // 참여상태
const target_time_cell = "O3"; // 의무시간
const deposit_again_cell = "R3"; // 예치금 재납

const fine_no_status_cell = "C33"; // 미납신호
const fine_already_payment_cell = "C34"; // 주간벌금

// 🔧 [데이터 시트 통합] 회원번호+3 규칙의 "행 계산 번호" — "권한관리"+
// "제보상점"+"사이클"이 합쳐진 "데이터" 시트를 이 값으로 INDIRECT 참조하므로
// 셀 위치를 통일. (구 C38→C43→C42, 옛 이름 report_sheet_row_cell 그대로
// 재사용 — 참조처가 많아 이름 변경은 보류)
// 🔧 "송출 P 감사"/"주간 P 감사" 행 삭제 + "송출 P / 주간 P"(C39) 행 추가로
// 줄배치가 밀려 C43 → C42로 이동.
const report_sheet_row_cell = "C42"; // 행 계산 번호 (데이터 시트 공용)
// 🔧 [데이터 감사] 퇴실·재납 시 그 시점의 "데이터" 시트 값을 "데이터 (감사)"
// 시트에 append-only로 스냅샷 저장한다. 원본 회원 시트(1~15)에서는 항상 0
// (감사 스냅샷 없음)이고, 퇴실·재납으로 만들어진 백업 사본 시트("이름 (퇴실)"
// 등)에서만 0이 아닌 값을 가지며, 그 백업 사본의 수식들은 report_sheet_row_cell
// (C42, "데이터" 참조용) 대신 이 셀(C43, "데이터 (감사)" 참조용)을 본다.
const data_audit_row_cell = "C43"; // 감사 행 계산 번호 (데이터 (감사) 시트 전용)
// 🔧 [셀 배치 정정] 이전 주석은 "C39가 일반반휴 잔여로 바뀌었다"고 잘못
// 가정했었다 — 실제로는 C39가 "송출 P / 주간 P" 표시 행이고, 일반반휴
// 잔여량은 C40, 사유반휴 잔여량은 C41이다. C39:39=송출P/주간P 표시,
// 40=일반반휴 잔여, 41=사유반휴 잔여, 42=참조 행 계산 번호,
// 43=감사 행 계산 번호. (구 holiday_reason_use_thisweek_cell/cumul_cell
// 상수는 더 이상 존재하지 않는 옛 44/45행을 가리키던 죽은 참조라 제거,
// 사유반휴는 "데이터" 시트 N~Q 슬롯 + 개인탭 C41 잔여량으로 통합됨.)
const holiday_normal_use_thiskweek_cell = "C40"; // 일반반휴 잔여량

const holiday_normal_row = "20"; // 반일휴무 행
const holiday_reason_row = "21"; // 사유휴무 행

const add_time_row = "27"; // 가산 학습시간 행
const fine_value_row = "29"; // 일간 총 벌금 행
const fine_check_row = "32"; // 납부확인 행

// [Getter 함수 1] 수동 실행용: 현재 열린 시트를 가져옴
function get_op_spreadsheet() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

// [Getter 함수 2] 트리거 실행용: ID로 공유 시트를 가져옴
function get_sh_spreadsheet() {
  return SpreadsheetApp.openById(spread_sheet_id);
}

// ⚙️ [수동] 주간집계 (상금 분배 대상 출력)
function weekly_calc() {
  if (check_execute_auth() == false) {
    return;
  }
  const ui = SpreadsheetApp.getUi();

  const spread_sheet = get_op_spreadsheet();
  const total_sheet = spread_sheet.getSheetByName("집계");

  // 🚀 [최적화 1] 흩어진 요약 데이터를 배열로 한 번에 가져오기 (5번 통신 -> 1번)
  const summary_values = total_sheet.getRange("D20:D24").getValues();
  const collect_money_total = summary_values[0][0]; // D20: 총 모금액
  const fine_carry          = summary_values[1][0]; // D21: 이월 상금
  const fine_thisweek       = summary_values[2][0]; // D22: 주간 벌금
  const fine_outer          = summary_values[3][0]; // D23: 퇴실 벌금
  const deposit_outer       = summary_values[4][0]; // D24: 퇴실 예치

  // 🔧 [데이터 시트 통합] 스터디장(1번 회원, "데이터" 시트 4행) 페널티 발생
  // 여부 — "권한관리"+"제보상점"+"사이클" 통합 시트("데이터")에서 현재
  // 사이클(D25)과 동일한 시점에 발생한 송출P(I/K열)·주간P(L/M열) 슬롯이
  // 있는지로 판정한다. F~K=송출P 1~6차, L~M=주간P 1~2차.
  const cycle_sheet_wc = spread_sheet.getSheetByName("데이터");
  const current_pen_cycle_wc = total_sheet.getRange(pen_cycle_cell).getValue();
  var leader_pen_status = 0;
  if (cycle_sheet_wc) {
    const leader_cycle_vals = cycle_sheet_wc.getRange("F4:M4").getValues()[0];
    // F~K=1~6차(idx0~5) → 4차=I(idx3), 6차=K(idx5). L~M=주간P 1~2차(idx6~7).
    [3, 5, 6, 7].forEach(function (offset) {
      if (leader_cycle_vals[offset] === current_pen_cycle_wc) leader_pen_status++;
    });
  }

  // 🚀 [최적화 2] 60번의 개별 통신을 1번의 배열 일괄 읽기(Batch Read)로 단축!
  // C열(이름) ~ F열(순위) 데이터를 통째로 메모리에 로드
  // 🔧 상점 F→E, 순위 G→F로 한 칸씩 당겨졌다.
  const member_data = total_sheet.getRange("C4:F18").getValues();

  var prize_list = [];
  var ranks = ["🥇", "🥈", "🥉", "🏅"];

  // 이제 구글 서버가 아닌, 자바스크립트 메모리(member_data) 안에서 순회합니다. 빛의 속도!
  for (var i = 0; i < member_data.length; i++) {
    var row_data = member_data[i];
    var rank = row_data[3]; // F열 (인덱스 3)

    if (ranks.includes(rank)) {
      prize_list.push({
        rank: rank,
        name: row_data[0],        // C열 (인덱스 0)
        study_time: row_data[1],  // D열 (인덱스 1)
        prize_score: row_data[2]  // E열 (인덱스 2, 상점)
      });
    }
  }

  // 🏆 메달 순서대로 정렬 (🥇🥈🥉🏅 순서)
  prize_list.sort((a, b) => ranks.indexOf(a.rank) - ranks.indexOf(b.rank));

  // ✅ 3. 결과 메시지 조립
  var result_msg = `#주간집계 #${get_last_week_date_range()}\n\n`;

  result_msg += `모두 고생 많으셨습니다!\n계속 파이팅! 😊🔥\n\n`;
  result_msg += "━━━━━━━━━━━━━━━━━━━━\n\n";
  result_msg += "[📢 공지사항 📢]\n\n";
  result_msg += "━━━━━━━━━━━━━━━━━━━━\n\n";
  result_msg += "[🧮 주간정산 🧮]\n\n";

  result_msg += `💰 총 모금액 : ₩${number_with_comma(collect_money_total)}\n`;
  result_msg += `➡️ 이월 상금 : ₩${number_with_comma(fine_carry)}\n`;
  result_msg += `➡️ 주간 벌금 : ₩${number_with_comma(fine_thisweek)}\n`;
  result_msg += `➡️ 퇴실 벌금 : ₩${number_with_comma(fine_outer)}\n`;

  if (leader_pen_status == 0 && deposit_outer > 0) {
    result_msg += `➡️ 퇴실 예치 : ₩${number_with_comma(deposit_outer)} (운영비 귀속)\n\n`;
  } else if (deposit_outer > 0) {
    result_msg += `➡️ 퇴실 예치 : ₩${number_with_comma(deposit_outer)} (벌금 귀속)\n\n`;
  } else if (deposit_outer == 0) {
    result_msg += `➡️ 퇴실 예치 : ₩${number_with_comma(deposit_outer)}\n\n`;
  }

  // 총 상금 수령자 수 계산
  var each_prize_money = 0;
  if (prize_list.length > 0) {
    each_prize_money = Math.trunc(collect_money_total / prize_list.length);
  }

  // 각 항목을 문자열로 변환하면서 금액 추가
  prize_list = prize_list.map(
    (member) =>
      `${member.rank} ${member.name} : ${member.study_time} / +${Number(member.prize_score).toFixed(2)} / ₩${number_with_comma(each_prize_money)}`
  );

  result_msg += "━━━━━━━━━━━━━━━━━━━━\n\n";
  result_msg += "[🏅 상금수령 대상자 🏅]\n\n";

  result_msg += prize_list.length
    ? prize_list.join(`\n`)
    : "출력 데이터가 없습니다. 🤔\n";

  if (prize_list.length > 0) {
    result_msg += "\n\n";
    result_msg += "⭐ 금주 페널티 적립자는 대상에서 제외\n";
    result_msg += "⭐ 선정 이력 없는 분은 입금계좌 전송\n";
    result_msg += "⭐ 선정 이력 있는 분은 기존계좌로 입금";
  }

  // ✅ 4. 상금 대상자가 없으면, 공유 시트의 D21에 누적 갱신.
  if (prize_list.length == 0) {
    const sh_spread_sheet = get_sh_spreadsheet();
    const sh_total_sheet = sh_spread_sheet.getSheetByName("집계");
    
    // 🚀 [최적화 3] 불필요한 .getValue() 제거. 아까 위에서 읽어둔 fine_carry 재사용
    sh_total_sheet.getRange(fine_carry_cell).setValue(collect_money_total + fine_carry);
  }

  ui.alert(result_msg);
}

// ⚙️ [수동] 스터디원 관리 (라우터 역할만 수행 - 15줄로 다이어트!)
function manage_member_selector() {
  if (check_execute_auth() == false) return;
  const ui = SpreadsheetApp.getUi();

  var response = ui.prompt(
    "⚙️ 스터디원 관리",
    "① 신규 스터디원 등록\n② 퇴실자 반환금 예상\n③ 퇴실자·재납자 처리\n\n원하는 작업의 번호를 입력하세요.",
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() == ui.Button.CANCEL) return;

  var choice = response.getResponseText().trim();
  
  if (choice === "1") _set_new_member();
  else if (choice === "2") _exit_define("preview");
  else if (choice === "3") _exit_define("define");
  else ui.alert("올바른 번호를 입력해 주세요.");
}

// =========================================================================
// ▼ 이하 평탄화(Flatten)되어 밖으로 독립한 전담 함수들 ▼
// =========================================================================

// 🛠️ [공통 헬퍼] 프롬프트 입력 자동화 (취소 시 null 반환)
function _prompt_helper(ui, title, message) {
  var response = ui.prompt(title, message, ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() == ui.Button.CANCEL) {
    ui.alert("작업을 취소합니다.");
    return null;
  }
  return response.getResponseText().trim();
}

// ⚙️ [수동/서브] 신규 스터디원 등록
function _set_new_member() {
  const ui = SpreadsheetApp.getUi();
  const spread_sheet = get_op_spreadsheet();
  const template_sheet = spread_sheet.getSheetByName("template");

  // 🚀 최적화: 헬퍼 함수를 사용하여 30줄이 5줄로 줄어듦!
  var name       = _prompt_helper(ui, "⚙️ 신규 스터디원 등록", "이름을 입력하세요. (예: 길동)"); if(!name) return;
  var sheet_num  = _prompt_helper(ui, "⚙️ 신규 스터디원 등록", "할당할 시트번호를 입력하세요. (예: 1)"); if(!sheet_num) return;
  var goal_level = _prompt_helper(ui, "⚙️ 신규 스터디원 등록", "의무시간과 타입을 입력하세요. (예: 8/교시)"); if(!goal_level) return;
  var email      = _prompt_helper(ui, "⚙️ 신규 스터디원 등록", "구글 이메일 주소를 입력하세요."); if(!email) return;
  var exam_kind  = _prompt_helper(ui, "⚙️ 신규 스터디원 등록", "준비 중인 시험 정보를 입력하세요."); if(!exam_kind) return;

  sheet_num = parseInt(sheet_num, 10);
  var member_sheet = spread_sheet.getSheetByName(sheet_num.toString());

  if (!member_sheet) { 
    var new_sheet = template_sheet.copyTo(spread_sheet);
    new_sheet.setName(sheet_num.toString());
    new_sheet.getRange(report_sheet_row_cell).setValue(sheet_num + 3);
    member_sheet = spread_sheet.getSheetByName(sheet_num.toString());
  }

  _set_sheet_init("신규회원", member_sheet, name, get_formatted_date(), "스터디원", `${goal_level}제`, email, exam_kind, sheet_num + 3, "");
  ui.alert(`${name}님의 정보가 등록 되었습니다.`);
}

// ⚙️ [수동/서브] 퇴실자, 재납자 처리
function _exit_define(string) {
  const ui = SpreadsheetApp.getUi();
  const spread_sheet = get_op_spreadsheet();
  const total_sheet = spread_sheet.getSheetByName("집계");

  var name = _prompt_helper(ui, "⚙️ 퇴실자·재납자 처리", "이름을 입력하세요. (예: 길동)");
  if(!name) return;

  var target_sheet_num = get_sheet_number(spread_sheet, name);
  if (!target_sheet_num) return; // 시트를 못 찾으면 멈춤

  var member_sheet = spread_sheet.getSheetByName(target_sheet_num.toString());
  var process_kind = 0; 
  var discount_ratio = 0;
  var result_str = [];

  // 강제 퇴실자 검사
  var process_result = _calc_forced_out_deposit(ui, member_sheet, string);
  if (process_result === "cancel") return;

  if (process_result == false) {
    var kind = _prompt_helper(ui, "⚙️ 퇴실자·재납자 처리", "작업을 선택하세요.\n① 정산 퇴실자 처리\n② 예치금 재납자 처리");
    if(!kind) return;
    process_kind = kind;

    if (process_kind == "1") process_result = _calc_return_deposit(spread_sheet, member_sheet);
    if (process_kind == "2") process_result = _calc_again_deposit(ui, member_sheet);
    if (!process_result) return; // 재납자가 아닌데 취소한 경우 등
  }

  discount_ratio = process_result.discount_ratio;
  result_str = process_result.result_str;

  // 벌금 계산 로직
  var fine_already_payment = member_sheet.getRange(fine_already_payment_cell).getValue();
  var total_fine = total_sheet.getRange(fine_outer_cell).getValue() + fine_already_payment;
  var total_deposit = total_sheet.getRange(deposit_outer_cell).getValue() + (deposit_value * discount_ratio);

  var result_msg = _get_result_msg(name, result_str, total_fine, total_deposit, discount_ratio, process_kind, member_sheet, total_sheet);

  if (string == "define") {
    // 반환 상태 기록
    if (discount_ratio == 0) member_sheet.getRange(parti_status_cell).setValue("퇴실자 (100% 반환)");
    else if (discount_ratio == 0.5) member_sheet.getRange(parti_status_cell).setValue("퇴실자 (50% 반환)");
    else if (discount_ratio == 1 && (process_kind == "1" || process_kind == "0")) member_sheet.getRange(parti_status_cell).setValue("퇴실자 (0% 반환)");
    else if (discount_ratio == 1 && process_kind == "2") member_sheet.getRange(parti_status_cell).setValue("재납자 (0% 반환)");

    total_sheet.getRange(fine_outer_cell).setValue(total_fine);
    total_sheet.getRange(deposit_outer_cell).setValue(total_deposit);

    var is_sunday = _prompt_helper(ui, "⚙️ 퇴실자·재납자 처리", "일요일에 발생한 퇴실자인가요? (y/n)");
    var sunday_str = (is_sunday && is_sunday.toLowerCase() == "y") ? "_sunday" : "";
    var row_number = parseInt(member_sheet.getName(), 10) + 3;

    if (process_kind == 0 || process_kind == 1) {
      _set_sheet_init(`퇴실자${sunday_str}`, member_sheet, name, "", "", "", "", "", row_number, result_msg);
    } else if (process_kind == 2) {
      _set_sheet_init(`재납자${sunday_str}`, member_sheet, name, get_formatted_date(), "스터디원", "", "", "", row_number, result_msg);
    }
  } 

  ui.alert(result_msg); // preview든 define이든 마지막에 결과 출력
}

// ⚙️ [부속] 강제 퇴실자 검사
// 🔧 [예치금 재납 UX 개선] 옛 로직은 R3(deposit_again_cell)가 "납부"면 그 전에
// 쌓인 다른 강제퇴실 사유(30일 미만, 벌금 미납)까지 전부 무시했다 — 관리자가
// 사전에 시트에서 직접 R3를 "납부"로 바꿔놓는 걸 전제한 설계였는데, 이걸
// 깜박하는 일이 잦았다. 이제 "미납" 상태를 발견하면(define 처리 시에만)
// 모달로 재납부 여부를 확인받아, 확인되면 그 자리에서 R3를 "납부"로 세팅하고
// 처리를 이어간다 — preview는 시트 상태를 바꾸지 않아야 하므로 대상에서 제외.
function _calc_forced_out_deposit(ui, member_sheet, process_string) {
  var result_str = [];
  var discount_ratio = 0;

  var i3_value = member_sheet.getRange(accession_date_dday_cell).getValue();
  var i3_number = parseInt(i3_value.replace(/\D/g, ""));
  if (i3_number < 30) { result_str.push("30일 미만 참여자 ➡️ 0% 반환"); discount_ratio = 1; }

  if (member_sheet.getRange(fine_no_status_cell).getValue() == "1") { result_str.push("벌금 시한 내 미납자 ➡️ 0% 반환"); discount_ratio = 1; }

  var is_deposit_no = member_sheet.getRange(deposit_again_cell).getValue();
  if (is_deposit_no == "미납") {
    if (process_string === "define") {
      var confirm_response = ui.alert(
        "⚙️ 퇴실자·재납자 처리",
        "예치금 재납부를 확인하셨나요?\n확인을 누르면 예치금 재납 상태로 처리를 진행합니다.",
        ui.ButtonSet.YES_NO
      );
      if (confirm_response != ui.Button.YES) return "cancel";
      member_sheet.getRange(deposit_again_cell).setValue("납부");
    } else {
      result_str.push(`예치금 시한 내 미납자 ➡️ 0% 반환`);
      discount_ratio = 1;
    }
  }

  var reason_str = _prompt_helper(ui, "⚙️ 퇴실자·재납자 처리", "기타 관리자 직권 강제퇴실이라면 사유를 입력하세요. (해당 없으면 취소 클릭)");
  if (reason_str) {
    result_str.push(`즉시 강제퇴실자 (사유 : ${reason_str}) ➡️ 0% 반환`);
    discount_ratio = 1;
  }

  if (result_str.length == 0 && discount_ratio == 0) return false;
  return { result_str: result_str, discount_ratio: discount_ratio };
}

// ⚙️ [부속] 정산 퇴실자 계산
// 🔧 [데이터 시트 통합] output_pen_cumul_cell/time_pen_cumul_cell(죽은 C39/C41
// 상수) 참조를 폐지. daily_calc()와 동일한 판정 방식으로, "데이터" 시트
// F~M열(I/K=송출P 4·6차, L/M=주간P 1·2차) 중 값이 0이 아닌 칸의 개수를
// 그대로 "이번 사이클 누적 페널티 횟수"로 사용한다.
function _calc_return_deposit(spread_sheet, member_sheet) {
  const cycle_sheet = spread_sheet.getSheetByName("데이터");
  var cycle_row = Number(member_sheet.getRange(report_sheet_row_cell).getValue()) || 0;
  var output_pen_total = 0;
  var time_pen_cumul = 0;

  if (cycle_sheet && cycle_row > 0) {
    var cycle_vals = cycle_sheet.getRange(`F${cycle_row}:M${cycle_row}`).getValues()[0];
    // F~K=송출P 1~6차(idx0~5) → 4차=I(idx3), 6차=K(idx5). L~M=주간P 1~2차(idx6~7).
    if ((Number(cycle_vals[3]) || 0) !== 0) output_pen_total++;
    if ((Number(cycle_vals[5]) || 0) !== 0) output_pen_total++;
    if ((Number(cycle_vals[6]) || 0) !== 0) time_pen_cumul++;
    if ((Number(cycle_vals[7]) || 0) !== 0) time_pen_cumul++;
  }

  var total_pen = output_pen_total + time_pen_cumul;
  var result_str = [];
  var discount_ratio = 0;

  if (total_pen == 0) { result_str.push(`송출 P (${output_pen_total}회) / 주간 P (${time_pen_cumul}회) ➡️ 100% 반환`); discount_ratio = 0; }
  else if (total_pen == 1) { result_str.push(`송출 P (${output_pen_total}회) / 주간 P (${time_pen_cumul}회) ➡️ 50% 반환`); discount_ratio = 0.5; }
  else if (total_pen >= 2) { result_str.push(`송출 P (${output_pen_total}회) / 주간 P (${time_pen_cumul}회) ➡️ 0% 반환`); discount_ratio = 1; }

  return { result_str: result_str, discount_ratio: discount_ratio };
}

// ⚙️ [부속] 예치 재납자 계산
function _calc_again_deposit(ui, member_sheet) {
  if (member_sheet.getRange(deposit_again_cell).getValue() == "납부") {
    return { result_str: [`예치금 재납자 ➡️ 0% 반환`], discount_ratio: 1 };
  } else {
    ui.alert("예치금 재납자가 아닙니다. 작업을 취소합니다.");
    return false;
  }
}

// ⚙️ [부속] 결과 메시지 생성
function _get_result_msg(name, result_str, total_fine, total_deposit, discount_ratio, process_kind, member_sheet, total_sheet) {
  var kind_str = process_kind == "0" ? "강제 퇴실자" : (process_kind == "1" ? "정산 퇴실자" : "예치금 재납자");
  var str_with_num = result_str.map((str, i) => `${String.fromCharCode(9312 + i)} ${str}`); // 9312 = ①

  return `🧑 이름 : ${name}\n📝 유형 : ${kind_str}\n📝 원인 : \n${str_with_num.join("\n")}\n💰 귀속예치 : ₩${number_with_comma(deposit_value * discount_ratio)}\n💰 반환예치 : ₩${number_with_comma(deposit_value - deposit_value * discount_ratio)}\n💰 기납벌금 : ₩${number_with_comma(member_sheet.getRange(fine_already_payment_cell).getValue())}\n\n📆 처리일자 : ${get_formatted_date()}\n================================\n[집계 시트의 변동사항]\n💰 퇴실벌금 : ₩${number_with_comma(total_sheet.getRange(fine_outer_cell).getValue())} → ₩${number_with_comma(total_fine)}\n💰 퇴실예치 : ₩${number_with_comma(total_sheet.getRange(deposit_outer_cell).getValue())} → ₩${number_with_comma(total_deposit)}`;
}

// ⚙️ [부속] "데이터" 시트 B~V행을 "데이터 (감사)"에 append-only로 스냅샷 저장.
// B열(회원번호)이 비어있는 첫 행을 찾아 그 자리에 값만 복사하고, C열(이름)은
// "{이름} ({event_label})\n{타임스탬프}"로 덮어써서 어느 이벤트의 스냅샷인지
// 식별한다. 반환값은 새로 채워진 감사 행 번호 — 백업 사본의 data_audit_row_cell
// (C43)에 이 값을 기록해두면, 원본 "데이터" 행이 이후 재사용되어 오염되더라도
// 백업 사본은 계속 이 감사 행을 통해 그 시점의 값을 정확히 볼 수 있다.
function _append_data_audit_snapshot(spread_sheet, data_sheet, row_number, name, event_label) {
  const audit_sheet = spread_sheet.getSheetByName("데이터 (감사)");
  if (!audit_sheet || !data_sheet) return 0;

  var last_row = Math.max(audit_sheet.getLastRow(), 3);
  var b_values = audit_sheet.getRange("B4:B" + last_row).getValues();
  var target_row = -1;
  for (var i = 0; i < b_values.length; i++) {
    if (b_values[i][0] === "" || b_values[i][0] === null) {
      target_row = i + 4;
      break;
    }
  }
  if (target_row === -1) target_row = last_row + 1;

  var source_values = data_sheet.getRange(`B${row_number}:V${row_number}`).getValues();
  audit_sheet.getRange(`B${target_row}:V${target_row}`).setValues(source_values);
  audit_sheet.getRange(`C${target_row}`).setValue(`${name} (${event_label})\n${get_formatted_date()}`);

  return target_row;
}

// ⚙️ [서브] 신규/퇴실 시트 초기화 처리
// [서브] 신규/퇴실 시트 초기화 처리 (일요일 동기화 + 이모지 템플릿 완벽 복구)
function _set_sheet_init(process_kind, member_sheet, name, date, status, goal_level, email, exam_kind, row_number, result_msg) {
  const spread_sheet = get_op_spreadsheet();
  const template_sheet = spread_sheet.getSheetByName("template");
  // 🔧 [데이터 시트 통합] "권한관리"+"제보상점"+"사이클"이 "데이터" 한 탭으로
  // 합쳐졌다. D=이메일, E=시험유형, F~K=송출P 1~6차, L~M=주간P 1~2차,
  // N~Q=사유반휴 슬롯, R~V=제보상점 슬롯. 퇴실·재납 시 같은 번호에 새/재납
  // 회원이 들어오면 이전 사람의 기록과 섞이므로 D~V를 명시적으로 지운다.
  const data_sheet = spread_sheet.getSheetByName("데이터");

  if (process_kind != "신규회원") {
    // 🔧 [웹 화면과 백업 이름 형식 통일] 재납 백업은 index.js(웹 화면)의
    // performDepositAgainReset이 만드는 이름("${이름} (재납 ${타임스탬프})")과
    // 반드시 같은 형식이어야 한다 — buildDepositAgainSplit이 이 접두사+
    // 타임스탬프 패턴으로 백업을 찾아 "재납 전/후" 분리 표시를 만들기
    // 때문이다. 원래 이 앱스크립트 경로는 타임스탬프 없이 고정 이름
    // "${이름} (재납)"을 썼는데, 그러면 웹 화면이 이 백업을 전혀 찾지
    // 못해 에러 없이 조용히 분리 표시 기능만 꺼진 채로 동작했다(사용자
    // 지적). 같은 회원이 여러 번 재납될 수도 있으므로, 타임스탬프를
    // 붙여 이전 백업을 덮어쓰지 않고 그대로 남긴다(웹 쪽도 이 전제로
    // "가장 최신 타임스탬프"만 골라 쓰도록 이미 만들어져 있다).
    var backup_name = process_kind.includes("퇴실자")
      ? `${name} (퇴실)`
      : `${name} (재납 ${Date.now()})`;

    var is_exist = spread_sheet.getSheetByName(backup_name);
    if (is_exist) spread_sheet.deleteSheet(is_exist);

    var dupl_sheet = member_sheet.copyTo(spread_sheet);
    dupl_sheet.setName(backup_name);

    // 🔧 [데이터 감사] "데이터" 원본 행을 초기화하기 전에, 그 시점의 값을
    // "데이터 (감사)"에 스냅샷으로 남기고, 백업 사본이 그 감사 행을 보도록
    // C43(감사 행 계산 번호)에 기록 + 수식 안의 "데이터"/C42 참조를
    // "데이터 (감사)"/C43으로 통째 치환한다.
    var audit_event_label = process_kind.includes("퇴실자") ? "퇴실" : "재납";
    var audit_row = _append_data_audit_snapshot(spread_sheet, data_sheet, row_number, name, audit_event_label);
    if (audit_row > 0) {
      dupl_sheet.getRange(data_audit_row_cell).setValue(audit_row);

      var formula_range = dupl_sheet.getRange("B2:W43");
      var formulas = formula_range.getFormulas();
      var changed = false;
      for (var fr = 0; fr < formulas.length; fr++) {
        for (var fc = 0; fc < formulas[fr].length; fc++) {
          var f = formulas[fr][fc];
          if (f && f.indexOf("'데이터'!") !== -1) {
            f = f.split("'데이터'!").join("'데이터 (감사)'!");
            // $C$42(절대참조)를 먼저 치환한 뒤 남은 C42(상대참조)를 치환 —
            // 순서를 바꾸면 먼저 바뀐 C43이 두 번째 치환에 다시 걸려 오염된다.
            f = f.split("$" + report_sheet_row_cell[0] + "$" + report_sheet_row_cell.slice(1))
                 .join("$" + data_audit_row_cell[0] + "$" + data_audit_row_cell.slice(1));
            f = f.split(report_sheet_row_cell).join(data_audit_row_cell);
            formulas[fr][fc] = f;
            changed = true;
          }
        }
      }
      if (changed) formula_range.setFormulas(formulas);
    }

    var border_style = SpreadsheetApp.BorderStyle.SOLID_MEDIUM;

    dupl_sheet.getRange("Y2:AC3").merge()
              .setBorder(true, true, true, true, true, true, "#595959", border_style)
              .setFontFamily("Nanum Gothic").setFontWeight("bold").setFontSize(11)
              .setBackground("#FCE4D6").setHorizontalAlignment("center").setVerticalAlignment("middle")
              .setValue("처리결과");

    dupl_sheet.getRange("Y4:AC18").merge()
              .setBorder(true, true, true, true, true, true, "#595959", border_style)
              .setFontFamily("Nanum Gothic").setFontSize(11)
              .setHorizontalAlignment("left").setVerticalAlignment("middle")
              .setValue(result_msg);

    protect_sheet(spread_sheet, backup_name);

    var sheet_name = member_sheet.getName();

    if (process_kind.includes("퇴실자")) {
      spread_sheet.deleteSheet(member_sheet);
      var new_sheet = template_sheet.copyTo(spread_sheet);
      new_sheet.setName(sheet_name);
      new_sheet.getRange(report_sheet_row_cell).setValue(row_number);

      // 🚀 [핵심 픽스] 퇴실 후 템플릿의 B2 셀에 이모지를 포함한 정확한 문자열 강제 삽입
      new_sheet.getRange(member_name_cell).setValue(`📝 ${sheet_name}번's 대시보드 📝`);

      email = data_sheet.getRange(`D${row_number}`).getValue();
      data_sheet.getRange(`D${row_number}:V${row_number}`).clearContent();
      remove_access(spread_sheet, email);
      protect_sheet(spread_sheet, sheet_name);

      if (process_kind.includes("_sunday")) {
        const sh_spread = get_sh_spreadsheet();
        const sh_data_sheet = sh_spread.getSheetByName("데이터");
        const sh_template_sheet = sh_spread.getSheetByName("template");
        const sh_member_sheet = sh_spread.getSheetByName(sheet_name);

        if (sh_member_sheet) sh_spread.deleteSheet(sh_member_sheet);

        var sh_new_sheet = sh_template_sheet.copyTo(sh_spread);
        sh_new_sheet.setName(sheet_name);
        sh_new_sheet.getRange(report_sheet_row_cell).setValue(row_number);

        // 🚀 [핵심 픽스] 공유 시트 템플릿 B2 셀에도 이모지 포함
        sh_new_sheet.getRange(member_name_cell).setValue(`📝 ${sheet_name}번's 대시보드 📝`);

        if (email) remove_access(sh_spread, email);
        if (sh_data_sheet) sh_data_sheet.getRange(`D${row_number}:V${row_number}`).clearContent();
        protect_sheet(sh_spread, sheet_name);
      }
    }

    if (process_kind.includes("재납자")) {
      var backup_b2 = member_sheet.getRange(member_name_cell).getValue();
      var backup_o3 = member_sheet.getRange(target_time_cell).getValue();

      spread_sheet.deleteSheet(member_sheet);
      var new_sheet = template_sheet.copyTo(spread_sheet);
      new_sheet.setName(sheet_name);
      new_sheet.getRange(report_sheet_row_cell).setValue(row_number);
      new_sheet.getRange(member_name_cell).setValue(backup_b2);
      new_sheet.getRange(accession_date_cell).setValue(date);
      new_sheet.getRange(parti_status_cell).setValue(status);
      new_sheet.getRange(target_time_cell).setValue(backup_o3);
      // 이메일(D)·시험유형(E)은 유지, F~V(송출P·주간P·사유반휴·제보상점)만 초기화
      data_sheet.getRange(`F${row_number}:V${row_number}`).clearContent();
      protect_sheet(spread_sheet, sheet_name);

      if (process_kind.includes("_sunday")) {
        const sh_spread = get_sh_spreadsheet();
        const sh_data_sheet = sh_spread.getSheetByName("데이터");
        const sh_member_sheet = sh_spread.getSheetByName(sheet_name);

        if (sh_member_sheet) {
          sh_member_sheet.getRange(accession_date_cell).setValue(date);
        }
        if (sh_data_sheet) sh_data_sheet.getRange(`F${row_number}:V${row_number}`).clearContent();
      }
    }
  } else { 
    // ==========================================================
    //  신규회원 등록 처리
    // ==========================================================
    member_sheet.getRange(member_name_cell).setValue(`📝 ${name}'s 대시보드 📝`);

    member_sheet.getRange(accession_date_cell).setValue(date);
    member_sheet.getRange(parti_status_cell).setValue(status);
    member_sheet.getRange(target_time_cell).setValue(`${goal_level.split('/')[0]}H (${goal_level.split('/')[1]})`);
    member_sheet.getRange(report_sheet_row_cell).setValue(row_number);

    data_sheet.getRange(`D${row_number}`).setValue(email);
    data_sheet.getRange(`E${row_number}`).setValue(exam_kind);
    
    grant_access(email);
    protect_sheet(spread_sheet, member_sheet.getName());

    var now = new Date();
    var day = now.getDay(); 
    var hour = now.getHours(); 

    if (hour >= 7 && hour < 23) {
      grant_editor_column_o();
    }

    if (day === 1 && hour >= 7 && hour < 14) {
      grant_editor_column_n();
    }
  }
  
  sort_sheets(spread_sheet);
}

// ⚙️ [수동] 페널티 관리 라우터 (아주 깔끔해진 뼈대)
function manage_penalty_selector() {
  if (check_execute_auth() == false) return;
  const ui = SpreadsheetApp.getUi();

  var response = ui.prompt(
    "⚙️ 페널티 및 상점 관리",
    "① 송출 P 수동 부여·취소\n② 제보상점 수동 부여·취소\n③ 송출 P·제보상점 현황 확인\n\n원하는 작업의 번호를 입력하세요.",
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() == ui.Button.CANCEL) return;
  var choice = response.getResponseText().trim();

  if (choice === "1") _add_sub_penalty_score();
  else if (choice === "2") _add_sub_report_score();
  else if (choice === "3") _view_report_score();
  else ui.alert("올바른 번호를 입력하세요 (1~3).");
}

// =========================================================================
// ▼ 이하 평탄화되어 밖으로 독립한 전담 함수들 ▼
// =========================================================================

// ⚙️ [수동/서브] 송출 P 수동 부여·취소
// 🔧 [데이터 시트 통합] 옛 "제보상점"!L열(벌점, 0.1점 단위 누적 숫자) 개념은
// 사라졌다 — 이건 사실 화각 제보 자동화가 붙기 전 관리자가 수동으로 송출 P를
// 매기던 기능이었다. 새 "데이터" 시트에서 송출 P는 F~K(1~6차) 슬롯에 "발생
// 시점의 사이클 번호"를 순차적으로 채우는 방식이라, 점수 가감이 아니라
// 1건씩 부여(다음 빈 슬롯 채움)·취소(마지막 채워진 슬롯 비움)로 재설계.
function _add_sub_penalty_score() {
  const ui = SpreadsheetApp.getUi();
  const spread_sheet = get_op_spreadsheet();
  const total_sheet = spread_sheet.getSheetByName("집계");
  const data_sheet = spread_sheet.getSheetByName("데이터");

  var name = _prompt_helper(ui, "⚙️ 송출 P 부여·취소", "이름을 입력하세요. (예: 길동)"); if (!name) return;
  var action = _prompt_helper(ui, "⚙️ 송출 P 부여·취소", "작업을 입력하세요. (부여 / 취소)"); if (!action) return;
  action = action.trim();
  if (action !== "부여" && action !== "취소") { ui.alert("'부여' 또는 '취소'를 입력하세요."); return; }

  var target_row = get_sheet_number(spread_sheet, name);
  if (!target_row) return;

  var data_row = target_row + 3;
  var slot_range = data_sheet.getRange(`F${data_row}:K${data_row}`);
  var slot_values = slot_range.getValues()[0];
  var current_cycle = total_sheet.getRange(pen_cycle_cell).getValue();

  if (action === "부여") {
    var empty_idx = slot_values.findIndex(function (v) { return (Number(v) || 0) === 0; });
    if (empty_idx === -1) { ui.alert(`${name} : 송출 P 슬롯(1~6차)이 이미 모두 채워져 있습니다.`); return; }
    slot_values[empty_idx] = current_cycle;
    slot_range.setValues([slot_values]);
    // 🔧 [날짜 주석 누락 수정] 자동 판정 경로(applyOutputPenalty, index.js)와
    // daily_calc(주간P)는 항상 "발생일 · 사유" 주석을 함께 남기는데, 이
    // 수동 부여 경로만 값만 쓰고 주석이 없었다 — 그 결과 4차/6차가 이
    // 경로로 채워지면 예치금 재납 요일 추정(depositAgainOccurredDay,
    // index.js)이 이 슬롯의 날짜를 못 읽어 재납 뱃지 자체가 안 뜨는 문제가
    // 있었다. daily_calc와 동일한 형식으로 개별 셀에 주석을 남긴다.
    slot_range.getCell(1, empty_idx + 1).setNote(get_formatted_date() + " · 관리자 수동 부여");
    ui.alert(`송출 P 부여 완료.\n${name} : ${empty_idx + 1}차 슬롯에 사이클 ${current_cycle} 기록`);
  } else {
    var filled_idx = -1;
    for (var i = slot_values.length - 1; i >= 0; i--) {
      if ((Number(slot_values[i]) || 0) !== 0) { filled_idx = i; break; }
    }
    if (filled_idx === -1) { ui.alert(`${name} : 취소할 송출 P 슬롯이 없습니다.`); return; }
    slot_values[filled_idx] = 0;
    slot_range.setValues([slot_values]);
    slot_range.getCell(1, filled_idx + 1).clearNote();
    ui.alert(`송출 P 취소 완료.\n${name} : ${filled_idx + 1}차 슬롯 비움`);
  }
}

// ⚙️ [수동/서브] 제보상점 수동 부여·취소
// 🔧 [데이터 시트 통합] 옛 "제보상점"!D~J열(요일별 점수, 자유 숫자 가감) 구조는
// 사라졌다 — "요일"이 아니라 "1~5차 슬롯"이 축이 됐고, 슬롯 값은 자유 숫자가
// 아니라 "발생 시점의 사이클 번호"다. 입력 점수(0.1점 단위)를 슬롯 개수로
// 환산해, 양수면 빈 슬롯을 앞에서부터 채우고 음수면 채워진 슬롯을 뒤에서부터
// 비운다. (송출 P처럼 사이클당 최대 1건이 아니라, 슬롯 5개까지 자유롭게
// 여러 건 처리 가능하므로 개수 입력을 그대로 유지한다.)
function _add_sub_report_score() {
  const ui = SpreadsheetApp.getUi();
  const spread_sheet = get_op_spreadsheet();
  const total_sheet = spread_sheet.getSheetByName("집계");
  const data_sheet = spread_sheet.getSheetByName("데이터");

  var name = _prompt_helper(ui, "⚙️ 제보상점 부여·취소", "이름을 입력하세요. (예: 길동)"); if (!name) return;

  var target_row = get_sheet_number(spread_sheet, name);
  if (!target_row) return;

  var data_row = target_row + 3;
  var slot_range = data_sheet.getRange(`R${data_row}:V${data_row}`);
  var slot_values = slot_range.getValues()[0];
  var current_cycle = total_sheet.getRange(pen_cycle_cell).getValue();
  var current_count = slot_values.filter(function (v) { return (Number(v) || 0) !== 0; }).length;

  var score_input = _prompt_helper(
    ui, "⚙️ 제보상점 부여·취소",
    `${name} : 현재 제보상점 ${(current_count * 0.1).toFixed(1)}점 (${current_count}/5건)\n\n점수를 입력하세요. (예: +0.3 또는 -0.2, 0.1점 단위)`
  );
  if (!score_input) return;

  var score_to_add = parseFloat(score_input);
  if (isNaN(score_to_add) || Math.round(score_to_add * 10) % 1 !== 0) { ui.alert("0.1점 단위의 숫자를 입력하세요."); return; }

  var slots_to_change = Math.round(Math.abs(score_to_add) * 10);

  if (score_to_add > 0) {
    var empty_indices = [];
    for (var i = 0; i < slot_values.length; i++) {
      if ((Number(slot_values[i]) || 0) === 0) empty_indices.push(i);
    }
    if (empty_indices.length < slots_to_change) {
      ui.alert(`${name} : 빈 슬롯이 ${empty_indices.length}개뿐이라 ${(slots_to_change * 0.1).toFixed(1)}점을 다 부여할 수 없습니다.`);
      return;
    }
    empty_indices.slice(0, slots_to_change).forEach(function (idx) { slot_values[idx] = current_cycle; });
  } else if (score_to_add < 0) {
    var filled_indices = [];
    for (var j = slot_values.length - 1; j >= 0; j--) {
      if ((Number(slot_values[j]) || 0) !== 0) filled_indices.push(j);
    }
    if (filled_indices.length < slots_to_change) {
      ui.alert(`${name} : 채워진 슬롯이 ${filled_indices.length}개뿐이라 ${(slots_to_change * 0.1).toFixed(1)}점을 다 취소할 수 없습니다.`);
      return;
    }
    filled_indices.slice(0, slots_to_change).forEach(function (idx) { slot_values[idx] = 0; });
  } else {
    return;
  }

  slot_range.setValues([slot_values]);
  var new_count = slot_values.filter(function (v) { return (Number(v) || 0) !== 0; }).length;
  ui.alert(`제보상점 ${score_to_add > 0 ? "부여" : "취소"} 완료.\n${name} : ${(current_count * 0.1).toFixed(1)}점 → ${(new_count * 0.1).toFixed(1)}점`);
}

// ⚙️ [수동/서브] 전체 인원의 송출 P·제보상점 현황 확인
// 🔧 [데이터 시트 통합] 옛 "제보상점" D~J(요일)/K(총점)/L(벌점) 열 구조 대신,
// "데이터" 시트 F~K(송출P 1~6차)·R~V(제보상점 1~5차) 슬롯을 직접 세어 표시.
// 송출P·제보상점 모두 "발생 시 사이클 번호, 미발생 시 0" 슬롯 방식이므로
// 채워진 슬롯 개수가 곧 발생 건수(제보상점은 ×0.1점)다.
function _view_report_score() {
  const ui = SpreadsheetApp.getUi();
  const spread_sheet = get_op_spreadsheet();
  const total_sheet = spread_sheet.getSheetByName("집계");
  const data_sheet = spread_sheet.getSheetByName("데이터");

  var names = total_sheet.getRange("C4:C18").getValues().flat().map((n) => n.toString().trim());
  var all_data = data_sheet.getRange("F4:V18").getValues(); // F~K(송출P 6), L~M(주간P 2), N~Q(사유반휴 4), R~V(제보상점 5)

  var table = "이름 | 송출P | 제보상점\n";
  table += "----------------------------------------\n";

  for (var i = 0; i < names.length; i++) {
    if (names[i] === "") continue;

    var row_data = all_data[i];
    var output_pen_slots = row_data.slice(0, 6);   // F~K
    var report_slots = row_data.slice(12, 17);     // R~V

    var output_pen_count = output_pen_slots.filter(function (v) { return (Number(v) || 0) !== 0; }).length;
    var report_count = report_slots.filter(function (v) { return (Number(v) || 0) !== 0; }).length;

    table += `${names[i]} | ${output_pen_count}/6건 | ${(report_count * 0.1).toFixed(1)}점 (${report_count}/5건)\n`;
  }

  ui.alert("송출 P · 제보 상점 현황", table, ui.ButtonSet.OK);
}

// ⚙️ [마지막 참여일 이후 집계 차단] Worker의 GET /bot/exit-requests를 조회해
// "회원번호 -> exitDate" 맵을 가져온다. 도움봇(exit_sync.py)이 매 교시 기록을
// 스킵하는 것과 동일한 목적 — 이 함수는 daily_calc()가 밤에 혼자 빈 칸을
// 00:00/ERR로 채우고 미납·페널티를 매기는 것까지 막아야 도움봇 쪽 조치와
// 합쳐 완전해진다(도움봇만 막으면 daily_calc가 그날 밤 같은 결과를 다시
// 만들어낸다). 조회 실패 시(스크립트 속성 미설정, 네트워크 오류 등) 빈
// 객체를 반환한다 — 이 경우 daily_calc()는 이 기능이 추가되기 전과 동일하게
// 아무도 건너뛰지 않고 그대로 처리한다(안전한 방향의 폴백).
function _fetchExitDates() {
  try {
    var secret = PropertiesService.getScriptProperties().getProperty("BOT_SECRET");
    if (!secret) {
      Logger.log("[퇴실 예약 조회] BOT_SECRET 스크립트 속성이 설정되지 않아 건너뜁니다.");
      return {};
    }
    var res = UrlFetchApp.fetch(worker_base_url + "/bot/exit-requests", {
      method: "get",
      headers: { "X-Bot-Secret": secret },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      Logger.log("[퇴실 예약 조회] 실패(HTTP " + res.getResponseCode() + "): " + res.getContentText());
      return {};
    }
    var data = JSON.parse(res.getContentText());
    return data.exitDates || {};
  } catch (e) {
    Logger.log("[퇴실 예약 조회] 예외 발생, 건너뜀: " + e);
    return {};
  }
}

// ⚙️ [트리거] 일간집계 자동화 함수.
// 일 단위 타이머 → 자정~오전 1시 사이 실행.
function daily_calc() {
  // 🚀 [최적화] 시간에 따라 동적으로 변하는 값은 전역변수가 아닌 함수 내부에서 선언하여 캐싱 오류 방지
  const ranges = cell_ranges(get_adjusted_day_of_week());
  const spread_sheet = get_sh_spreadsheet();
  const total_sheet = spread_sheet.getSheetByName("집계");

  // 🚀 [최적화] 기적의 수학 공식 제거. 교시 = 시간 이므로 분 단위 계산 아예 삭제.
  var missed_period_val = total_sheet.getRange(period_omission_cell).getValue();
  var missed_period = parseInt(missed_period_val, 10) || 0;

  const day_start_col = ranges.start;         // 예: C
  const day_parti_col = ranges.participation; // 예: E

  // 🚪 [마지막 참여일 이후 집계 차단] 이 실행 전체에서 한 번만 조회한다(회원마다
  // 반복 호출하지 않음) — today_str은 get_formatted_date()와 동일한 방식
  // (스크립트 타임존 기준 "YYYY-MM-DD")으로 계산해 exitDate 문자열과 그대로
  // 사전식 비교할 수 있게 한다.
  var exit_dates = _fetchExitDates();
  var today_str = get_formatted_date();

  // 0. '1~15' 시트를 순회
  for (var sheet_number = 1; sheet_number <= 15; sheet_number++) {
    var member_sheet = spread_sheet.getSheetByName(sheet_number.toString());

    if (!member_sheet || !check_no_member_sheet(member_sheet)) continue;

    var start_check = member_sheet.getRange("I3").getValue().toString();
    if (start_check.includes('D+0') || start_check.includes('-')) continue;

    // 마지막 참여일(exitDate) 당일까지는 정상 처리하고, 그 다음날부터는
    // 이 회원의 일간집계를 건너뛴다 — 관리자가 확정 처리를 늦게 하더라도
    // 그 사이 새 결석 기록(00:00/ERR)·벌금 미납·주간 P가 쌓이지 않는다.
    var exit_date = exit_dates[String(sheet_number)];
    if (exit_date && today_str > exit_date) {
      Logger.log(sheet_number + "번 시트 스킵 (마지막 참여일 " + exit_date + " 지남).");
      continue;
    }

 // ==========================================================
    // 🚀 [최적화 1] 시작/종료/참여도 3개 열 통읽기 (텍스트 타입 강제)
    // ==========================================================
    var data_range = member_sheet.getRange(`${day_start_col}6:${day_parti_col}19`);
    
    // 🌟 변경 1: getValues() 대신 getDisplayValues() 사용
    // 스프레드시트의 Date 객체가 아닌, 화면에 보이는 "01:49" 형태의 순수 문자열(String)로 읽어옵니다.
    var data_values = data_range.getDisplayValues(); 
    var is_changed = false; 

    for (var i = 0; i < 14; i++) {
      var s_val = data_values[i][0]; // 시작
      var e_val = data_values[i][1]; // 종료
      var p_val = data_values[i][2]; // 참여도

      // 🔧 PEN 분기 제거 — 이제 참여도 값에 "PEN" 상태가 더 이상 존재하지
      // 않아 빈칸이면 무조건 ERR 처리한다.
      if (s_val === "" || e_val === "" || p_val === "") {
        data_values[i][0] = "00:00";
        data_values[i][1] = "00:00";
        data_values[i][2] = "ERR";
        is_changed = true;
      }
    }

    if (is_changed) {
      // 🌟 변경 2: 시트에 덮어쓰기 직전, 시간 데이터들에 홑따옴표(')를 강제로 일괄 부착
      for (var j = 0; j < 14; j++) {
        // 중복 부착을 방지하기 위해 앞글자가 "'"가 아닐 때만 붙임
        if (!data_values[j][0].startsWith("'")) data_values[j][0] = "'" + data_values[j][0];
        if (!data_values[j][1].startsWith("'")) data_values[j][1] = "'" + data_values[j][1];
      }
      
      // 홑따옴표가 붙은 순수 텍스트 배열을 1번의 통신으로 덮어씀
      data_range.setValues(data_values); 
    }

    // ==========================================================
    // 🚀 [최적화 2] 20~32행 (휴무, 가산시간, 벌금) 통읽기 (5번 통신 -> 1번 통신)
    // ==========================================================
    var summary_range = member_sheet.getRange(`${day_start_col}20:${day_start_col}32`);
    var summary_vals = summary_range.getValues();

    var holiday_normal_use = Number(summary_vals[0][0]) || 0; // 20행
    var holiday_reason_use = Number(summary_vals[1][0]) || 0; // 21행
    var add_time_current   = summary_vals[7][0];              // 27행
    var fine_value         = Number(summary_vals[9][0]) || 0; // 29행
    var fine_check         = summary_vals[12][0];             // 32행

    // 🕒 구루미 오류 가산 시간 보정 (군더더기 삭제)
    if (missed_period != 0 && (holiday_normal_use + holiday_reason_use) !== 2) {
      var current_time = add_time_current ? add_time_current.toString().trim() : "00:00";
      var time_parts = current_time.split(":");
      
      // 그냥 앞자리(시간)에 missed_period를 더해주면 끝!
      var new_h = (Number(time_parts[0]) || 0) + missed_period;
      var new_m = time_parts[1] || "00"; 

      var new_time = "'" + ("0" + new_h).slice(-2) + ":" + new_m;
      member_sheet.getRange(`${day_start_col}27`).setValue(new_time);
    }

    // 💰 벌금 미납 처리
    if (fine_value > 0 && fine_check === "") {
      member_sheet.getRange(`${day_start_col}32`).setValue("미납");
    }

    // ==========================================================
    // 🚀 [최적화 3] 페널티 데이터 — "사이클" 시트 기반으로 전환
    // 🔧 [데이터 시트 통합] C39:C41 직접 참조를 폐지. 이제 총 페널티는
    // "데이터" 시트의 I/K열(송출 P 4차/6차)과 L/M열(주간 P 1차/2차) 중
    // 값이 0이 아닌(=적용 시기의 사이클 번호가 기록된) 칸의 개수로 판정한다.
    // C42(행 계산 번호)이 이 회원의 "데이터" 시트 행 번호다.
    // ==========================================================
    var cycle_sheet = spread_sheet.getSheetByName("데이터");
    var cycle_row = Number(member_sheet.getRange(report_sheet_row_cell).getValue()) || 0;
    var total_pen = 0;

    if (cycle_sheet && cycle_row > 0) {
      var cycle_vals = cycle_sheet.getRange(`F${cycle_row}:M${cycle_row}`).getValues()[0];
      // F~K=송출P 1~6차(idx0~5) → 4차=I(idx3), 6차=K(idx5). L~M=주간P 1~2차(idx6~7).
      var cycle_cols = [3, 5, 6, 7];
      for (var c = 0; c < cycle_cols.length; c++) {
        if ((Number(cycle_vals[cycle_cols[c]]) || 0) !== 0) total_pen++;
      }
    }

    if (total_pen >= 2) {
      member_sheet.getRange(deposit_again_cell).setValue("미납");
    }

    // ==========================================================
    // 🚀 [최적화 4] 일요일 한정 — "금주 주간 P" 발생 여부 판정 후,
    // 미달이면 "데이터" 시트 L열(1차)/M열(2차) 중 먼저 빈 칸에 현재
    // 페널티 사이클 번호(집계!D25)를 기록한다. 예전엔 이 판정 결과를
    // C40(금주 달성 P)에 저장했지만, 그 셀이 사라지면서 이제 여기서
    // 바로 판정하고 데이터 시트에 직접 써넣는다.
    // ==========================================================
    if (get_adjusted_day_of_week() == 0 && cycle_sheet && cycle_row > 0) {
      var parti_status = member_sheet.getRange(parti_status_cell).getValue();
      var period_blank_count = member_sheet.getRange("C6:W19").getValues()
        .flat().filter(function (v) { return v === "" || v === null; }).length;
      var day_complete = period_blank_count === 0;

      var time_pen_this = 0;
      if (!(parti_status === "" || !day_complete)) {
        var target_time = member_sheet.getRange(target_time_cell).getValue().toString();
        var reason_leave_total = member_sheet.getRange("C21:W21").getValues()[0]
          .reduce(function (sum, v) { return sum + (parseInt(v, 10) || 0); }, 0);
        var weekly_study_minutes = (Number(member_sheet.getRange("C28").getValue()) || 0) * 1440;

        var required_minutes = 0;
        if (target_time.startsWith("8H")) required_minutes = 2400 - reason_leave_total * 240;
        else if (target_time.startsWith("9H")) required_minutes = 2700 - reason_leave_total * 270;
        else if (target_time.startsWith("10H")) required_minutes = 3000 - reason_leave_total * 300;

        var time_shortfall = target_time.startsWith("8H") || target_time.startsWith("9H") || target_time.startsWith("10H")
          ? (required_minutes > weekly_study_minutes ? 1 : 0)
          : 0;

        var period_rate = member_sheet.getRange("C38").getValue();
        var period_shortfall = (period_rate === "-" || period_rate === "" || Number(period_rate) >= 85) ? 0 : 1;

        time_pen_this = Math.min(1, time_shortfall + period_shortfall);
      }

      if (time_pen_this === 1) {
        // 🔧 [주석 기록] 관리자 화면("예치금 재납 대상자")이 이 회원의
        // 페널티가 언제·왜 발생했는지 보여줘야 해서, 화각 제보 승인
        // (index.js applyOutputPenalty)과 동일하게 발생일시·사유를 셀
        // 주석으로 남긴다. 사유에는 실제 판정에 쓰인 수치도 "달성 / 기준"
        // 형태로 함께 남겨, 왜 미달로 판정됐는지 바로 확인할 수 있게 한다.
        var lm_vals = cycle_sheet.getRange(`L${cycle_row}:M${cycle_row}`).getValues()[0];
        var current_cycle = total_sheet.getRange(pen_cycle_cell).getValue();

        // HH:MM 표시용 — 사유반휴를 많이 써서 required_minutes가 음수로
        // 내려간 극단적인 경우에도 깨진 시각(-4:00 등)이 나오지 않도록
        // 0 이상으로 클램프한다(그 경우 필요시간은 사실상 0으로 봐도 된다).
        function to_hhmm_display(minutes) {
          var m = Math.max(0, minutes);
          return ("0" + Math.floor(m / 60)).slice(-2) + ":" + ("0" + (m % 60)).slice(-2);
        }

        var reason_parts = [];
        if (time_shortfall) {
          reason_parts.push(`주간 학습시간 미달 (${to_hhmm_display(weekly_study_minutes)} / ${to_hhmm_display(required_minutes)})`);
        }
        if (period_shortfall) {
          var period_rate_display = (period_rate === "-" || period_rate === "") ? "0" : Number(period_rate);
          reason_parts.push(`교시 참여율 미달 (${period_rate_display}% / 85%)`);
        }
        var time_pen_note = get_formatted_date() + " · " + reason_parts.join(" · ");
        if ((Number(lm_vals[0]) || 0) === 0) {
          cycle_sheet.getRange(`L${cycle_row}`).setValue(current_cycle).setNote(time_pen_note);
        } else if ((Number(lm_vals[1]) || 0) === 0) {
          cycle_sheet.getRange(`M${cycle_row}`).setValue(current_cycle).setNote(time_pen_note);
        }
      }
    }

  } // for loop 종료

  // '집계' 시트 정리 (마무리 작업)
  total_sheet.getRange(period_omission_cell).setValue("0");
  total_sheet.getRange("K4:L18").setValue("");
}

// ⚙️ [트리거] 전체 시트 초기화 함수.
// 주 단위 타이머 → 매주 월요일 오전 5시 ~ 오전 6시 사이 실행.
function sheet_reset() {
  const spread_sheet = get_sh_spreadsheet();
  const total_sheet = spread_sheet.getSheetByName("집계");

  // ✅ 1. 전체 시트의 백업 사본 생성. (드라이브 로직은 I/O 최적화 대상 밖이므로 유지)
  var folder_id = "15-_j0UmDC3Ox6l1ujZmAeGuuLU3gHhH7"; 
  var date_range_str = get_last_week_date_range();
  var base_name = "공부합시당 캠스터디 " + date_range_str;
  var folder = DriveApp.getFolderById(folder_id);

  var final_name = base_name;
  var counter = 1;
  while (folder.getFilesByName(final_name).hasNext()) {
    final_name = base_name + " (" + counter + ")";
    counter++;
  }

  var copied_file = spread_sheet.copy(final_name);
  DriveApp.getFileById(copied_file.getId()).moveTo(folder);

  // 🔧 [D+N 고정] 백업 사본의 I3(가입일 D-day)가 라이브 수식 그대로 남아
  // 계속 증가하지 않도록, 그 주 마지막 날(일요일) 기준 값으로 얼려둔다.
  // 예외가 나도(락 경합 등) 백업 파일 자체는 이미 만들어졌으니 초기화
  // 흐름을 막지 않는다 — 다음 실행에서도 이 사본을 다시 열어 재시도할
  // 수단은 없지만, 이 실패가 초기화 전체를 중단시키는 것보다는 낫다.
  try {
    var backup_spreadsheet = SpreadsheetApp.openById(copied_file.getId());
    _freeze_dday_in_backup(backup_spreadsheet);
  } catch (e) {
    Logger.log("D+N 고정 실패(백업 파일은 정상 생성됨): " + e);
  }

  // 🔧 [데이터 감사] 이번 주 동안 쌓인 "데이터 (감사)" 스냅샷은 방금 위에서 만든
  // Drive 백업 파일 안에 이미 그대로 보존되어 있다 — 실시간 공유 시트 쪽은
  // 다음 주를 위해 4행 이후를 비운다. (지난 주 백업 사본 파일들의
  // "데이터 (감사)"는 과거 기록이므로 건드리지 않는다.)
  const audit_sheet_sr = spread_sheet.getSheetByName("데이터 (감사)");
  if (audit_sheet_sr) {
    var audit_last_row = audit_sheet_sr.getLastRow();
    if (audit_last_row >= 4) {
      audit_sheet_sr.getRange(`B4:V${audit_last_row}`).clearContent();
    }
  }

  // ==========================================================
  // 🚀 [최적화 1] RangeList로 흩어진 요약 데이터 한 번에 초기화
  // ==========================================================
  total_sheet.getRangeList([fine_carry_cell, fine_outer_cell, deposit_outer_cell]).setValue(0);

  // ==========================================================
  // 🚀 [최적화 2] 반복문 진입 전 '페널티 사이클' 공통 값 미리 캐싱
  // ==========================================================
  var current_pen_cycle = total_sheet.getRange(pen_cycle_cell).getValue();
  var is_cycle_reset = (current_pen_cycle === 3);
  const cycle_sheet = spread_sheet.getSheetByName("데이터");

  // ✅ 3. '1~15' 시트 값 초기화 및 누적 갱신.
  for (var sheet_number = 1; sheet_number <= 15; sheet_number++) {
    var member_sheet = spread_sheet.getSheetByName(sheet_number.toString());

    if (!member_sheet || !check_no_member_sheet(member_sheet)) {
      console.log(`${sheet_number} 시트 처리 스킵.`);
      continue;
    }

    // ==========================================================
    // 🚀 [최적화 3] 사유 반휴 사용량 — "데이터" 시트 N~Q(1~4차) 슬롯에 기록
    // 🔧 송출 P/주간 P와 동일한 슬롯 방식: 3주 사이클당 총 4장 한도이며,
    // 한 주에 몰아서 여러 장을 쓸 수도 있다. 이번 주 C21:W21 사용 합계만큼
    // N~Q 중 빈 슬롯을 앞에서부터 채워 현재 사이클 번호를 기록한다.
    // ==========================================================
    var reason_holiday_vals = member_sheet.getRange("C21:W21").getValues()[0];
    var used_value = reason_holiday_vals.reduce((acc, val) => acc + (Number(val) || 0), 0);

    var cycle_row = Number(member_sheet.getRange(report_sheet_row_cell).getValue()) || 0;
    if (cycle_sheet && cycle_row > 0 && !is_cycle_reset && used_value > 0) {
      var reason_slot_range = cycle_sheet.getRange(`N${cycle_row}:Q${cycle_row}`);
      var reason_slot_values = reason_slot_range.getValues()[0];
      var filled = 0;
      for (var s = 0; s < reason_slot_values.length && filled < used_value; s++) {
        if ((Number(reason_slot_values[s]) || 0) === 0) {
          reason_slot_values[s] = current_pen_cycle;
          filled++;
        }
      }
      reason_slot_range.setValues([reason_slot_values]);
      if (filled < used_value) {
        console.log(`${sheet_number}번 사유반휴 슬롯 초과: ${used_value}장 사용, ${filled}장만 기록됨.`);
      }
    }

    // 넓은 범위 내용 초기화
    member_sheet.getRange("C6:W23").clearContent();

    // 인접한 범위 병합 초기화 (26행, 27행 두 번 쓰지 않고 하나로 합침)
    member_sheet.getRange("C26:W27").setValue("'00:00");

    // 흩어진 범위 빈칸 초기화 (벌금납부 C32:W32, 예치금재납 R3 -> 묶어서 통신)
    member_sheet.getRangeList(["C32:W32", deposit_again_cell]).setValue("");
  }

  // ✅ 4. '데이터' 시트 제보상점 슬롯(R~V) 일괄 초기화 — 매주.
  if (cycle_sheet) {
    cycle_sheet.getRange("R4:V18").setValue(0);
  }

  // ✅ 4-1. '데이터' 시트 F~Q열(송출P·주간P·사유반휴) 일괄 초기화 — 3주 사이클이
  // 끝나는 시점(is_cycle_reset)에만 지운다. 제보상점(R~V)처럼 매주 지우면
  // 사이클 도중(1~2주차)에 쌓인 위반 기록/사유 반휴 누적이 다음 주로 안
  // 넘어간다 — 그래서 이건 반드시 사이클 경계(3주에 한 번)에서만 지운다.
  // F~K=송출P, L~M=주간P, N~Q=사유반휴.
  if (is_cycle_reset && cycle_sheet) {
    cycle_sheet.getRange("F4:Q18").setValue(0);
  }

  // ✅ 5. ‘집계’ 시트 페널티 사이클 값 갱신
  var next_pen_cycle = current_pen_cycle === 1 ? 2 : (current_pen_cycle === 2 ? 3 : 1);
  total_sheet.getRange(pen_cycle_cell).setValue(next_pen_cycle);

  // ✅ 6. '집계' 시트 기타 항목 초기화
  // 🔧 period_omission_cell은 daily_calc()가 매일 밤 읽고 0으로 리셋하는
  // 사이클을 이미 완결하고 있어 여기서 다시 초기화할 필요가 없다(중복 제거).
  total_sheet.getRange("K4:L18").setValue("");

  // ==========================================================
  // 🚀 [최적화 5] 시트 삭제 알고리즘 단축 (필터링 후 즉시 삭제)
  // push로 배열에 담고 다시 도는 이중 작업을 체이닝으로 1줄 처리
  // ==========================================================
  spread_sheet.getSheets()
    .filter(sheet => sheet.getName().includes("퇴실") || sheet.getName().includes("재납"))
    .forEach(sheet => spread_sheet.deleteSheet(sheet));
}

// ⚙️ [트리거] ‘집계’ 시트의 의무시간 신청 (N열) 의 행 단위로 스터디원에게 수정 권한 부여 함수.
// 주 단위 타이머 → 매주 월요일 오전 7시 ~ 오전 8시 사이 실행.
function grant_editor_column_n() {
  const spread_sheet = get_sh_spreadsheet();
  const auth_sheet = spread_sheet.getSheetByName("데이터");
  const total_sheet = spread_sheet.getSheetByName("집계");

  // 관리자 기본 명단
  const owner_email = spread_sheet.getOwner().getEmail();
  const admin_emails = [owner_email, service_account_email];

  console.log("오전 권한 부여 시작: K열 스마트 권한 리모델링 로직 실행");

  // 1. 필요한 모든 데이터를 한 번에 가져오기 (I/O 횟수 최소화)
  const email_range = auth_sheet.getRange("D4:D18");
  const emails = email_range.getValues(); 
  
  const name_range = total_sheet.getRange("C4:C18"); 
  const names = name_range.getValues(); 

  const all_protections = total_sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);

  // 2. 반복문 실행 (스마트 권한 비교 및 추가)
  emails.forEach((row, index) => {
    const email_address = String(row[0]).trim();
    const row_number = index + 4;
    const member_name = names[index][0]; 
    const cell_a1_notation = `K${row_number}`;

    if (email_address !== "") {
      try {
        const cell_protections = all_protections.filter(p => p.getRange().getA1Notation() === cell_a1_notation);
        
        // 최종적으로 이 셀에 권한을 가져야 할 사람 명단 (관리자 + 해당 멤버)
        const desired_editors = [...admin_emails, email_address];

        if (cell_protections.length === 0) {
          // [예외 상황] 보호 규칙이 아예 없을 때만 새로 생성
          const target_cell = total_sheet.getRange(cell_a1_notation);
          const new_p = target_cell.protect();
          new_p.setDescription(`K${row_number} 편집 권한 for ${member_name}`)
               .removeEditors(new_p.getEditors())
               .addEditors(desired_editors);
          console.log(` -> 규칙 신규 생성 완료: K${row_number} [${email_address}]`);
          
        } else {
          // [핵심 최적화] 이미 규칙이 있다면 지우지 않고 명부만 스마트 업데이트
          const primary_p = cell_protections[0];
          
          // 혹시 구글 시트 오류로 중복 생성된 유령 규칙이 있다면 깔끔하게 청소
          for (let j = 1; j < cell_protections.length; j++) {
            cell_protections[j].remove();
          }

          // 현재 이 셀을 수정할 수 있는 사람 명단 확인
          const current_editors = primary_p.getEditors().map(u => u.getEmail());
          
          // 1) 명부에 추가해야 할 사람 (원하는 명단에는 있는데, 현재 방에 없는 사람)
          const to_add = desired_editors.filter(e => !current_editors.includes(e));
          // 2) 명부에서 빼야 할 사람 (현재 방에 있는데, 원하는 명단에는 없는 사람 / 소유자는 제외)
          const to_remove = current_editors.filter(e => !desired_editors.includes(e) && e !== owner_email);

          // 꼭 필요한 경우(변경 사항이 있을 때)에만 API 통신
          if (to_add.length > 0) primary_p.addEditors(to_add);
          if (to_remove.length > 0) primary_p.removeEditors(to_remove);
          
          if (to_add.length > 0 || to_remove.length > 0) {
             console.log(` -> 권한 업데이트 완료: K${row_number} [${email_address}]`);
          }
        }

      } catch (e) {
        console.error(`${row_number}행 권한 부여 중 오류: ${e.toString()}`);
      }

    } else {
      console.log(`${row_number}행 D열 이메일 비어있음 (건너뜀)`);
    }
  });
  
  console.log("K열 권한 부여 작업이 모두 완료되었습니다.");
}

// ⚙️ [트리거] '집계' 시트의 의무시간 신청 (K열) 의 행 단위로 작업 등록 및 전체 인원의 수정 권한 회수 함수.
// 주 단위 타이머 → 매주 월요일 오후 2시 ~ 오후 3시 사이 실행.
function revoke_editor_column_n() {
  const spread_sheet = get_sh_spreadsheet();
  const total_sheet = spread_sheet.getSheetByName("집계");

  const admin_emails = [
    spread_sheet.getOwner().getEmail(),
    service_account_email, // 전역 변수로 정의되어 있어야 합니다.
  ];

  console.log("작업 시작: 데이터 일괄 처리 및 스마트 권한 회수 실행");

  const range_n = total_sheet.getRange("K4:K18");
  const values_n = range_n.getValues();
  const all_protections = total_sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);

  let output_values = [];
  const valid_values = ["8H (교시제)", "8H (달성제)", "9H (교시제)", "9H (달성제)", "10H (교시제)", "10H (달성제)"];

  // ==========================================
  // STEP 1: 개별 시트 업데이트 및 K열 결과값 계산
  // ==========================================
  for (let i = 0; i < values_n.length; i++) {
    const row_number = i + 4;
    const n_value = values_n[i][0]; 
    let process_result = n_value; 

    try {
      if (valid_values.includes(n_value)) {
        const dest_sheet_name = (row_number - 3).toString();
        const dest_sheet = spread_sheet.getSheetByName(dest_sheet_name);

        if (dest_sheet) {
          dest_sheet.getRange(target_time_cell).setValue(n_value);
          process_result = `등록 (${n_value.replace(/(\d+H) \((.)(.*)/, '$1$2')})`;
        }
      }
      output_values.push([process_result]);
    } catch (e) {
      console.error(`${row_number}행 처리 중 오류 발생: ${e.toString()}`);
      output_values.push([n_value]); 
    }
  }

  // ==========================================
  // STEP 2: K열 데이터 한 번에 쓰기
  // ==========================================
  range_n.setValues(output_values);

  // ==========================================
  // STEP 3: [핵심 최적화] 스마트 권한 회수
  // 무작정 지우고 만들지 않고, 뺏을 권한이 있을 때만 통신합니다.
  // ==========================================
  for (let i = 0; i < values_n.length; i++) {
    const row_number = i + 4;
    const cell_a1_notation = `K${row_number}`;

    try {
      const cell_protections = all_protections.filter(p => p.getRange().getA1Notation() === cell_a1_notation);

      if (cell_protections.length > 0) {
        // 1. 이미 보호 규칙이 있는 경우: 관리자가 아닌 사람(불법 편집자)이 있는지 검사
        cell_protections.forEach(p => {
          const current_editors = p.getEditors().map(user => user.getEmail());
          const editors_to_remove = current_editors.filter(email => !admin_emails.includes(email));

          if (editors_to_remove.length > 0) {
            // 회수할 권한이 있을 때만 서버랑 통신해서 삭제함
            p.removeEditors(editors_to_remove);
            console.log(`${cell_a1_notation} 셀 권한 회수 완료`);
          }
          // 회수할 권한이 없으면(이미 관리자만 있으면) 아무것도 안 하고 0초 만에 패스!
        });
      } else {
        // 2. 보호 규칙이 아예 처음부터 없는 경우에만 새로 생성
        const n_cell = total_sheet.getRange(cell_a1_notation);
        const new_protection = n_cell.protect();
        new_protection.setDescription(`관리자 전용 보호 (${cell_a1_notation})`)
                      .removeEditors(new_protection.getEditors())
                      .addEditors(admin_emails);
      }
    } catch (e) {
      console.error(`${row_number}행 권한 설정 중 오류 발생: ${e.toString()}`);
    }
  }

  console.log("전체 작업 및 권한 회수가 완료되었습니다.");
}

// ⚙️ [트리거] '집계' 시트의 반일휴무 신청 (L열) 의 행 단위로 스터디원에게 수정 권한 부여 함수.
// 일 단위 타이머 → 매일 오전 7시 ~ 오전 8시 사이 실행.
function grant_editor_column_o() {
  const spread_sheet = get_sh_spreadsheet();
  const auth_sheet = spread_sheet.getSheetByName("데이터");
  const total_sheet = spread_sheet.getSheetByName("집계");

  // 관리자 기본 명단
  const owner_email = spread_sheet.getOwner().getEmail();
  const admin_emails = [owner_email, service_account_email];

  console.log("오전 권한 부여 시작: 권한 리모델링(스마트 업데이트) 로직 실행");

  // 1. 필요한 데이터 한 번에 가져오기
  const email_range = auth_sheet.getRange("D4:D18");
  const emails = email_range.getValues(); 
  
  const name_range = total_sheet.getRange("C4:C18");
  const names = name_range.getValues(); 

  const all_protections = total_sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);

  // 2. 반복문 실행 (스마트 권한 비교 및 추가)
  emails.forEach((row, index) => {
    const email_address = String(row[0]).trim();
    const row_number = index + 4;
    const member_name = names[index][0]; 
    const cell_a1_notation = `L${row_number}`; 

    if (email_address !== "") {
      try {
        // 해당 셀의 보호 규칙 찾기
        const cell_protections = all_protections.filter(p => p.getRange().getA1Notation() === cell_a1_notation);
        
        // 최종적으로 이 셀에 권한을 가져야 할 사람 명단 (관리자 + 해당 멤버)
        const desired_editors = [...admin_emails, email_address];

        if (cell_protections.length === 0) {
          // [예외 상황] 보호 규칙이 아예 날아가고 없을 때만 새로 생성 (약 2~3초 소요)
          const target_cell = total_sheet.getRange(cell_a1_notation);
          const new_p = target_cell.protect();
          new_p.setDescription(`L${row_number} 편집 권한 for ${member_name}`)
               .removeEditors(new_p.getEditors())
               .addEditors(desired_editors);
          console.log(` -> 규칙 신규 생성 및 완료: L${row_number} [${email_address}]`);
          
        } else {
          // [핵심 최적화] 이미 규칙이 있다면 지우지 않고 명부만 업데이트
          const primary_p = cell_protections[0];
          
          // 혹시나 중복 생성된 유령 규칙이 있다면 청소
          for (let j = 1; j < cell_protections.length; j++) {
            cell_protections[j].remove();
          }

          // 현재 방에 있는 사람 명단 가져오기
          const current_editors = primary_p.getEditors().map(u => u.getEmail());
          
          // 1) 추가해야 할 사람 찾기 (원하는 명단에는 있는데, 현재 방에 없는 사람)
          const to_add = desired_editors.filter(e => !current_editors.includes(e));
          // 2) 빼야 할 사람 찾기 (현재 방에 있는데, 원하는 명단에는 없는 사람)
          const to_remove = current_editors.filter(e => !desired_editors.includes(e) && e !== owner_email);

          // 꼭 필요한 경우에만 API 통신 (속도 향상의 핵심)
          if (to_add.length > 0) primary_p.addEditors(to_add);
          if (to_remove.length > 0) primary_p.removeEditors(to_remove);
          
          if (to_add.length > 0 || to_remove.length > 0) {
             console.log(` -> 권한 업데이트 완료: L${row_number} [${email_address}]`);
          }
        }

      } catch (e) {
        console.error(`${row_number}행 권한 부여 중 오류: ${e.toString()}`);
      }

    } else {
      console.log(`${row_number}행 D열 이메일 비어있음 (건너뜀)`);
    }
  });

  console.log("O열(반일휴무) 권한 부여 작업이 모두 완료되었습니다.");
}

// ⚙️ [트리거] '집계' 시트 작업 처리 및 권한 일괄 회수 함수 (극강 최적화 버전)
// 일 단위 타이머 → 매일 밤 11시 ~ 12시 사이 실행 권장
function revoke_editor_column_o() {
  const ranges = cell_ranges(get_adjusted_day_of_week());
  const spread_sheet = get_sh_spreadsheet();
  const total_sheet = spread_sheet.getSheetByName("집계");

  const admin_emails = [
    spread_sheet.getOwner().getEmail(),
    Session.getEffectiveUser().getEmail(), 
    service_account_email, 
  ];

  console.log("밤 11시 작업 시작: API 호출 극한 최적화 및 권한 리모델링 실행");

  const range_o = total_sheet.getRange("L4:L18");
  const values_o = range_o.getValues(); 
  const all_protections = total_sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  
  let output_values = []; 

  // ==========================================
  // STEP 1: 타겟 시트 호출 최소화 연산
  // ==========================================
  for (let i = 0; i < values_o.length; i++) {
    const row_number = i + 4; 
    const o_value = values_o[i][0]; 
    let result_txt = o_value; 
    
    try {
      if (o_value === "1장" || o_value === "2장") {
        const dest_sheet_name = (row_number - 3).toString();
        const dest_sheet = spread_sheet.getSheetByName(dest_sheet_name);
        
        if (dest_sheet) {
          // [최적화 1] 20행과 21행을 개별 getValue가 아닌 범위(getValues)로 한 번에 읽기
          const target_col = ranges.start; 
          const today_vals = dest_sheet.getRange(`${target_col}20:${target_col}21`).getValues();
          
          var holiday_use_remain = dest_sheet.getRange(holiday_normal_use_thiskweek_cell).getValue();
          var holiday_normal_today = today_vals[0][0] || 0; // 20행 값
          var holiday_reason_today = today_vals[1][0] || 0; // 21행 값
          var holiday_total_today = holiday_normal_today + holiday_reason_today;
          result_txt = ""; 

          if (o_value == "1장") {
            if (holiday_normal_today == 1) { result_txt = "오류 (중복)"; } 
            else if (holiday_total_today == 2) { result_txt = "오류 (초과)"; }
            else if (holiday_use_remain == 0) { result_txt = "오류 (초과)"; }
            else if (holiday_use_remain >= 1) { 
              result_txt = "등록 (1장)"; 
              dest_sheet.getRange(`${target_col}20`).setValue(1); 
            }
          }
          if (o_value == "2장") {
            if (holiday_normal_today == 2) { result_txt = "오류 (중복)"; }
            else if(holiday_total_today == 2) { result_txt = "오류 (초과)"; }
            else if (holiday_use_remain == 0) { result_txt = "오류 (초과)"; }
            else if (holiday_normal_today == 1) { 
              result_txt = "등록 (확장)"; 
              dest_sheet.getRange(`${target_col}20`).setValue(2); 
            }
            else if (holiday_use_remain == 2) { 
              result_txt = "등록 (2장)"; 
              dest_sheet.getRange(`${target_col}20`).setValue(2); 
            }
          }
        }
      }
      output_values.push([result_txt]); 
    } catch (e) {
      console.error(`${row_number}행 데이터 처리 오류: ${e.toString()}`);
      output_values.push([o_value]); 
    }
  }
  
  // ==========================================
  // STEP 2: 연산 결과 L4:L18에 한 번에 덮어쓰기
  // ==========================================
  range_o.setValues(output_values);

  // ==========================================
  // STEP 3: [최적화 2] 삭제하지 않고 편집자만 강퇴 (권한 리모델링)
  // ==========================================
  for (let i = 0; i < values_o.length; i++) {
    const row_number = i + 4;
    const cell_a1_notation = `L${row_number}`;

    try {
      const cell_protections = all_protections.filter(p => p.getRange().getA1Notation() === cell_a1_notation);

      if (cell_protections.length === 0) {
        // 규칙이 아예 없을 때만 어쩔 수 없이 새로 생성 (약 2~3초 소요)
        const o_cell = total_sheet.getRange(cell_a1_notation);
        const new_protection = o_cell.protect();
        new_protection.setDescription(`관리자 전용 보호 (${cell_a1_notation})`)
                      .removeEditors(new_protection.getEditors()) 
                      .addEditors(admin_emails); 
      } else {
        // 이미 규칙이 있다면 지우지 말고 껍데기는 재활용
        const primary_p = cell_protections[0];
        
        // 만약 구글 시트 오류로 중복 생성된 규칙이 있다면 청소
        for (let j = 1; j < cell_protections.length; j++) {
          cell_protections[j].remove(); 
        }

        const current_editors = primary_p.getEditors();
        const editors_to_remove = current_editors.filter(u => !admin_emails.includes(u.getEmail()));
        
        // 회수해야 할 일반 유저가 있을 때만 명단에서 강퇴 (매우 빠름)
        if (editors_to_remove.length > 0) {
          primary_p.removeEditors(editors_to_remove); 
          primary_p.addEditors(admin_emails); // 안전장치로 관리자 추가
          console.log(`${cell_a1_notation} 편집 권한 회수 완료`);
        }
      }
    } catch (e) {
      console.error(`${row_number}행 권한 설정 중 오류 발생: ${e.toString()}`);
    }
  }

  console.log("모든 데이터 처리 및 개인 권한 회수가 최단 시간으로 완료되었습니다.");
}

// ⚙️ [권한] 시트에 접근할 수 있는 권한 설정.
function grant_access(email) {
  const spread_sheet = get_sh_spreadsheet();
  spread_sheet.addEditor(email);
}

// ⚙️ [권한] 시트에 접근할 수 있는 권한 삭제.
function remove_access(spread_sheet, email) {
  try {
    spread_sheet.removeEditor(email); // 한 번만 확실하게 지웁니다.
  } catch (e) {
    console.log(`삭제 오류 ${e}`);
  }
}

// ⚙️ [권한] '집계' 시트를 소유자와 서비스 계정에게만 권한 부여.
function protectSheetForAdmins() {
  // 'service_account_email' 변수는 스크립트 내 다른 곳에 정의되어 있어야 합니다.
  // 예: const service_account_email = "your-service-account@...iam.gserviceaccount.com";

  try {
    const spread_sheet = SpreadsheetApp.getActiveSpreadsheet();
    const sheet_to_protect = spread_sheet.getSheetByName("집계");

    if (!sheet_to_protect) {
      console.warn("'집계' 시트를 찾을 수 없어 스크립트를 종료합니다.");
      return;
    }

    // ✅ 1. 편집 권한을 부여할 관리자 이메일 목록을 정의합니다.
    const admin_emails = [
      spread_sheet.getOwner().getEmail(),
      service_account_email, 
    ];

    // ✅ 2. 시트에 적용된 모든 기존 보호 규칙을 제거합니다.
    const protections = sheet_to_protect.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    protections.forEach(protection => {
      protection.remove();
    });

    // ✅ 3. 시트 전체에 새로운 보호를 설정합니다.
    const protection = sheet_to_protect.protect();
    
    // ✅ 4. 관리자 목록에 있는 사용자만 편집할 수 있도록 권한을 설정합니다.
    protection.setDescription("관리자 전용 시트 보호")
              .removeEditors(protection.getEditors()) // 기본으로 추가된 모든 편집자(본인 포함)를 제거
              .addEditors(admin_emails);             // 지정된 관리자만 편집자로 추가

    console.log(`'집계' 시트에 관리자 보호를 설정했습니다. 편집자: ${admin_emails.join(", ")}`);

  } catch (e) {
    console.error("보호 설정 중 오류가 발생했습니다: " + e.toString());
  }
}

// ⚙️ [권한] 새로운 개인시트 생성 시, 시트 보호 설정.
function protect_sheet(spread_sheet, sheet_name) {
  console.log(sheet_name);
  
  var sheet = spread_sheet.getSheetByName(sheet_name);

  // 시트가 존재하는 경우에만 아래 로직을 실행합니다.
  if (sheet) {
    // 2. 해당 시트의 기존 보호 설정을 모두 제거하여 충돌을 방지합니다.
    const protections = sheet.getProtections(
      SpreadsheetApp.ProtectionType.SHEET
    );
    // forEach 루프의 'p'를 더 명확한 이름으로 변경
    protections.forEach((existing_protection) =>
      existing_protection.remove()
    );

    // 3. 새로운 보호 설정을 생성합니다.
    const protection = sheet
      .protect()
      .setDescription("소유자와 특정 서비스 계정만 편집 가능");

    // 4. 새로운 보호 설정에서 모든 편집자를 제거한 후, 소유자와 서비스 계정만 추가합니다.
    // 이 방법이 가장 확실하게 원하는 계정만 남기는 방법입니다.
    protection.removeEditors(protection.getEditors());
    protection.addEditors([
      Session.getEffectiveUser().getEmail(),
      service_account_email,
    ]);
  }
}

// ⚙️ [권한] 함수 실행전에 소유자인지 확인.
function check_execute_auth() {
  const ui = SpreadsheetApp.getUi();

  // 🚀 [최적화] ID로 새로 열지 않고, 현재 열려있는 객체를 즉시 사용 (UI 딜레이 제거)
  const spread_sheet = get_op_spreadsheet(); 

  const current_user_email = Session.getActiveUser().getEmail();
  const owner_email = spread_sheet.getOwner().getEmail();

  if (current_user_email !== owner_email) {
    ui.alert("이 스크립트를 실행할 권한이 없습니다."); 
    return false; 
  } else {
    return true;
  }
}

// =============================================================

// ⚙️ [보조] 일간집계용 날짜 구하기
// 새벽 3시전이면 하루전으로 판단해 요일 숫자 반환. (예 : 월요일 새벽 2시 → 일요일)
function get_adjusted_day_of_week() {
  var now = new Date(); // 현재 시간
  var hour = now.getHours(); // 현재 시(hour) 추출
  var day = now.getDay(); // 현재 요일 (0~6)

  if (hour < 3) {
    // 새벽 3시면
    day = (day - 1 + 7) % 7; // 전날 요일로 조정 (0보다 작아지는 것 방지)
  }

  // Logger.log("보정된 요일: " + day);
  return day;
}

// ⚙️ [보조] 실행일자에 해당하는 셀 위치 반환.
function cell_ranges(day_of_week) {
  // 참여도 보정을 위한 셀 범위 함수
  var ranges = {
    start: "",
    end: "",
    participation: "",
  };

  switch (day_of_week) {
    case 0: // 일요일
      ranges.start = "U";
      ranges.end = "V";
      ranges.participation = "W";
      break;
    case 1: // 월요일
      ranges.start = "C";
      ranges.end = "D";
      ranges.participation = "E";
      break;
    case 2: // 화요일
      ranges.start = "F";
      ranges.end = "G";
      ranges.participation = "H";
      break;
    case 3: // 수요일
      ranges.start = "I";
      ranges.end = "J";
      ranges.participation = "K";
      break;
    case 4: // 목요일
      ranges.start = "L";
      ranges.end = "M";
      ranges.participation = "N";
      break;
    case 5: // 금요일
      ranges.start = "O";
      ranges.end = "P";
      ranges.participation = "Q";
      break;
    case 6: // 토요일
      ranges.start = "R";
      ranges.end = "S";
      ranges.participation = "T";
      break;
  }

  return ranges;
}

// ⚙️ [보조] 개인 시트의 B2 값이 'N번'인지 확인.
function check_no_member_sheet(member_sheet) {
  var nameCell = member_sheet.getRange("B2").getValue();
  var skipPattern = /^📝 (?:[0-9]|1[0-5])번 님의 집계표 📝$/;

  if (skipPattern.test(nameCell)) {
    return false;
  } else {
    return true;
  }
}

// ⚙️ [보조] 주간집계의 '250602-250608' 과 같은 날짜 범위 생성 (시트 백업 파일명 등에 사용)
function get_last_week_date_range() {
  // 현재 활성화된 스프레드시트에서 '집계'라는 이름의 시트를 가져옵니다.
  // 이 변수는 이 함수 내에서 직접 사용되진 않지만, 다른 로직에서 활용될 수 있습니다.
  // --- 주간 날짜 계산 (지난주 월요일 ~ 일요일) ---

  // 1. 기준이 되는 오늘 날짜를 가져옵니다.
  var today = new Date();

  // 2. 오늘의 요일을 숫자로 가져옵니다. (주의: 0=일요일, 1=월요일, ..., 6=토요일)
  var dayOfWeek = today.getDay();

  // 3. 지난주 월요일을 계산합니다.
  //    - new Date(today)로 오늘 날짜의 복사본을 만들어 원본이 바뀌지 않도록 합니다.
  var lastMonday = new Date(today);
  //    - setDate를 이용해 날짜를 재설정합니다.
  //    - (오늘 날짜 - 오늘 요일 숫자)는 '지난주 일요일'이 됩니다.
  //    - 여기서 6일을 더 빼면 '지난주 월요일'이 됩니다.
  lastMonday.setDate(today.getDate() - dayOfWeek - 6);

  // 4. 지난주 일요일을 계산합니다.
  //    - 위에서 계산한 지난주 월요일의 복사본을 만듭니다.
  var lastSunday = new Date(lastMonday);
  //    - 월요일 날짜에 6일을 더하여 해당 주의 일요일을 찾습니다.
  lastSunday.setDate(lastMonday.getDate() + 6);

  /**
   * 날짜 객체를 'YYMMDD' 형식의 문자열로 변환하는 내부 헬퍼 함수입니다.
   * @param {Date} date - 변환할 날짜 객체
   * @returns {string} 'YYMMDD' 형식의 문자열
   */
  function formatDate(date) {
    // getFullYear()로 전체 연도(예: 2025)를 가져와 마지막 두 자리("25")만 잘라냅니다.
    var yy = date.getFullYear().toString().slice(-2);
    // getMonth()는 0부터 시작(1월=0)하므로 +1을 해주고, '0'을 앞에 붙인 후 마지막 두 자리를 잘라 월을 항상 두 자리(예: "06")로 만듭니다.
    var mm = ("0" + (date.getMonth() + 1)).slice(-2);
    // getDate()로 날짜를 가져와 위와 동일한 방식으로 항상 두 자리(예: "08")로 만듭니다.
    var dd = ("0" + date.getDate()).slice(-2);
    return yy + mm + dd;
  }

  // 5. 계산된 월요일과 일요일을 포맷에 맞게 조합하여 최종 문자열을 만듭니다.
  var dateRange = `${formatDate(lastMonday)}-${formatDate(lastSunday)}`;

  // 6. 완성된 날짜 범위 문자열을 반환합니다.
  return dateRange;
}

// ⚙️ [보조] 백업 사본의 D+N(가입일 D-day) 값을 고정할 때 기준으로 삼을
// "지난주 일요일" Date 객체를 반환한다. get_last_week_date_range()와 동일한
// 계산이지만 문자열이 아니라 Date를 그대로 반환한다 — sheet_reset()이
// 백업 사본의 I3 셀을 "그 주 마지막 날(일요일) 기준 D+N"으로 얼릴 때 쓴다.
// sheet_reset()이 실행되는 시점(월요일 새벽)의 TODAY()를 그대로 쓰면
// "일요일까지의 D+238"이 아니라 "월요일의 D+239"가 고정되어 하루씩 밀린다.
function get_last_week_sunday() {
  var today = new Date();
  var dayOfWeek = today.getDay();
  var lastMonday = new Date(today);
  lastMonday.setDate(today.getDate() - dayOfWeek - 6);
  var lastSunday = new Date(lastMonday);
  lastSunday.setDate(lastMonday.getDate() + 6);
  return lastSunday;
}

// ⚙️ [보조] 자정 기준 날짜 차이(일수)를 구한다 — 시/분/초 값이 섞여 있어도
// 온전한 "일" 단위로만 비교하도록 두 날짜 모두 자정으로 맞춘 뒤 뺀다.
function _days_between(from_date, to_date) {
  var from_midnight = new Date(from_date.getFullYear(), from_date.getMonth(), from_date.getDate());
  var to_midnight = new Date(to_date.getFullYear(), to_date.getMonth(), to_date.getDate());
  return Math.round((to_midnight.getTime() - from_midnight.getTime()) / (24 * 60 * 60 * 1000));
}

// ⚙️ [D+N 고정] I3(가입일 D-day)는 "=IF(TODAY()<I2, "D-"&..., "D+"&(TODAY()-I2))"
// 형태의 라이브 수식이라, sheet_reset()이 만드는 백업 사본에서도 수식이
// 그대로 복사되어 시간이 지날수록 계속 증가해버린다 — 과거 사이클(백업)을
// 조회해도 "그 주 시점의 D+N"이 아니라 "지금 이 순간의 D+N"이 나와, "30일
// 미만 참여자" 같은 판정이 왜곡된다(사용자 지적, 2026-08). 백업 사본의
// 1~15번 시트를 훑어 I3를 "그 주 마지막 날(일요일) 기준" 값으로 계산해
// 수식이 아닌 순수 텍스트로 덮어써 영구히 얼린다. 라이브(원본) 시트의
// I3는 건드리지 않으므로 실시간 조회는 계속 정확하게 매일 갱신된다.
function _freeze_dday_in_backup(backup_spreadsheet) {
  var reference_date = get_last_week_sunday();
  for (var i = 1; i <= 15; i++) {
    var member_sheet = backup_spreadsheet.getSheetByName(i.toString());
    if (!member_sheet) continue;

    var join_date = member_sheet.getRange(accession_date_cell).getValue();
    // 회원이 아직 없는 빈 슬롯(I2가 비어있거나 날짜가 아님)은 건너뛴다 —
    // I3 수식이 이미 빈 값/에러를 내고 있을 것이므로 그대로 둬도 무해하다.
    if (!(join_date instanceof Date) || isNaN(join_date.getTime())) continue;

    var diff_days = _days_between(join_date, reference_date);
    var frozen_text = diff_days >= 0 ? "D+" + diff_days : "D-" + Math.abs(diff_days);
    member_sheet.getRange(accession_date_dday_cell).setValue(frozen_text);
  }
}

// ⚙️ [보조] '2025-01-01' 과 같은 날짜 생성. (가입일자 등에 사용)
function get_formatted_date() {
  var today = new Date();
  var formattedDate =
    today.getFullYear() +
    "-" +
    ("0" + (today.getMonth() + 1)).slice(-2) +
    "-" +
    ("0" + today.getDate()).slice(-2);

  return formattedDate;
}

// ⚙️ [보조] '1000' → '1,000' 과 같이 콤마 추가.
function number_with_comma(x) {
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ⚙️ [보조] '집계' 시트에서 이름으로 개인 시트 번호 찾아 반환.
//  [보조] '집계' 시트에서 이름으로 개인 시트 번호 찾아 반환. (완벽하게 최적화된 순정 버전)
function get_sheet_number(spread_sheet, name) {
  const ui = SpreadsheetApp.getUi();
  const total_sheet = spread_sheet.getSheetByName("집계");

  //  [최적화] B열(시트번호)과 C열(이름) 데이터를 한 번에 메모리로 로드 (API 호출 반갈죽)
  const data = total_sheet.getRange("B4:C18").getValues();
  
  for (let i = 0; i < data.length; i++) {
    const current_name = data[i][1].toString().trim(); // 인덱스 1은 C열(이름)
    
    if (current_name === name) {
      return Number(data[i][0]); // 인덱스 0은 B열(시트번호). 찾으면 즉시 반환!
    }
  }

  // 루프를 다 돌았는데도 못 찾았을 경우
  ui.alert("'" + name + "' 이름을 '집계' 시트(C4:C18)에서 찾을 수 없음.");
  return null; 
}

// ⚙️ [보조/수동] 개인시트의 숨김처리 행 ON / OFF 토글.
function toggle_display() {
  const ui = SpreadsheetApp.getUi();
  const spread_sheet = get_op_spreadsheet();

  const sheet_names = Array.from({ length: 15 }, (_, i) => (i + 1).toString());

  // 🚀 [최적화] 인접한 행들을 그룹화 [시작행, 연속된_줄_수] 로 묶어서 API 호출을 210번 -> 90번으로 단축!
  // 🔧 [데이터 시트 통합] 26~28=로그·보정·주간 학습시간, 30~31=일간·오전
  // 목표시간 벌금, 33~34=미납신호·주간총벌금, 36=학습시간상점,
  // 42~43=참조·감사 행 계산 번호. 37(제보상점)은 항상 숨김. 구 45행
  // (사유반휴사용)은 더 이상 존재하지 않아 제거.
  const row_groups_to_toggle = [
    [26, 3], // 26, 27, 28행
    [30, 2], // 30, 31행
    [33, 2], // 33, 34행
    [36, 1], // 36행
    [42, 2]  // 42, 43행
  ];
  const row_groups_to_always_hide = [[37, 1]]; // 37행

  const representative_sheet = spread_sheet.getSheetByName(sheet_names[0]);
  if (!representative_sheet) {
    Logger.log("대표 시트 '1'을 찾을 수 없습니다.");
    return;
  }
  
  const are_rows_hidden = representative_sheet.isRowHiddenByUser(26);
  const main_action = are_rows_hidden ? "show" : "hide";

  // 15개 시트 순회
  sheet_names.forEach((sheet_name) => {
    const sheet = spread_sheet.getSheetByName(sheet_name);
    if (!sheet) return;

    try {
      // 1. 토글 대상 그룹 처리
      row_groups_to_toggle.forEach(([start_row, num_rows]) => {
        if (main_action === "hide") sheet.hideRows(start_row, num_rows);
        else sheet.showRows(start_row, num_rows);
      });

      // 2. 항상 숨김 대상 그룹 처리
      row_groups_to_always_hide.forEach(([start_row, num_rows]) => {
        sheet.hideRows(start_row, num_rows);
      });
    } catch (e) {
      Logger.log(`시트 '${sheet_name}' 작업 오류: ${e.toString()}`);
    }
  });

  Logger.log("모든 토글 작업이 완료되었습니다.");
}

// ⚙️ [보조] 전체 시트 순서대로 정렬.
function sort_sheets(spread_sheet) {
  var sheets = spread_sheet.getSheets(); // 현재 모든 시트 가져오기

  // 1. 숨겨야 할 시트 이름 목록 정의
  var hidden_sheet_names = [
    "template",
    "데이터",
  ];

  // 2. 새로운 기준에 따라 시트 배열 정렬
  sheets.sort(function (a, b) {
    var name_a = a.getName();
    var name_b = b.getName();

    // --- 정렬 규칙 시작 ---

    // 규칙 1: '통합' 시트는 항상 가장 앞에 위치
    if (name_a === "집계") return -1;
    if (name_b === "집계") return 1;

    // 규칙 2: 시트 이름이 정확히 '1'부터 '15' 사이의 숫자인지 확인
    var is_num_a_1_to_15 = /^(?:[1-9]|1[0-5])$/.test(name_a);
    var is_num_b_1_to_15 = /^(?:[1-9]|1[0-5])$/.test(name_b);

    // '1'~'12' 시트끼리는 숫자 오름차순 정렬
    if (is_num_a_1_to_15 && is_num_b_1_to_15) {
      return parseInt(name_a) - parseInt(name_b);
    }

    // '1'~'12' 시트는 '통합' 다음, 나머지 시트들보다는 앞에 위치
    if (is_num_a_1_to_15) return -1;
    if (is_num_b_1_to_15) return 1;

    // 규칙 3: 나머지 시트들은 '12' 시트 뒤에 위치
    return name_a.localeCompare(name_b);

    // --- 정렬 규칙 끝 ---
  });

  // 3. 정렬된 순서대로 실제 시트 위치 이동
  for (var i = 0; i < sheets.length; i++) {
    var sheet_to_move = sheets[i];
    var target_index = i + 1; // 1-based index

    // 🚀 [최적화] 시트가 이미 올바른 위치에 있다면 불필요한 API 호출(이동) 생략!
    if (sheet_to_move.getIndex() === target_index) {
      continue; 
    }

    try {
      spread_sheet.setActiveSheet(sheet_to_move);
      spread_sheet.moveActiveSheet(target_index);
    } catch (e) {
      Logger.log("시트 이동 오류: '" + sheet_to_move.getName() + "' - " + e);
    }
  }

  // 4. 지정된 시트 숨김 처리
  hidden_sheet_names.forEach(function (sheet_name) {
    var sheet = spread_sheet.getSheetByName(sheet_name);
    if (sheet) {
      try {
        sheet.hideSheet();
      } catch (e) {
        Logger.log(
          "시트 숨김 오류: '" + sheet_name + "' 숨김 처리 불가 - " + e
        );
      }
    } else {
      Logger.log("숨김 대상 시트 없음: " + sheet_name);
    }
  });

  // --- ▼▼▼ 추가된 기능 ▼▼▼ ---
  // 5. '1'부터 '12' 이름의 시트는 항상 공개 처리
  // 이 로직은 혹시라도 '1'~'12' 시트가 숨겨져 있을 경우를 대비하여 강제로 보이게 만듭니다.
  for (var i = 1; i <= 15; i++) {
    var sheet_name = i.toString(); // 숫자 i를 문자열 'i'로 변환
    var sheet = spread_sheet.getSheetByName(sheet_name);
    if (sheet) {
      // 해당 이름의 시트가 존재할 경우에만 실행
      try {
        sheet.showSheet(); // 시트를 보이게 합니다. (이미 보이면 아무 변화 없음)
      } catch (e) {
        Logger.log(
          "시트 공개 오류: '" +
            sheet_name +
            "' 시트를 공개 처리할 수 없음 - " +
            e
        );
      }
    }
  }
}

// ⚙️ [보조/수동] '1~15' 시트를 삭제·재생성하지 않고, template의 B2:W43을
// 그대로 덮어써서 서식·수식 구조만 최신화한다. 회원이 채워온 값(개인정보,
// 학습기록, 상태)은 보존 영역으로 지정해 먼저 백업해뒀다가 덮어쓴 뒤 복원한다.
function update_sheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const templateSheet = ss.getSheetByName('template');
  if (!templateSheet) {
    SpreadsheetApp.getUi().alert("시트 'template'을 찾을 수 없습니다.");
    return;
  }

  // 회원이 직접 채운 값이라 template으로 덮어써도 보존해야 하는 영역
  const preserve_ranges = [
    member_name_cell,       // B2
    accession_date_cell,    // I2
    parti_status_cell,      // L3
    target_time_cell,       // O3
    deposit_again_cell,     // R3
    "C6:W23",
    "C26:W27",
    "C32:W32",
    report_sheet_row_cell,  // C42
    data_audit_row_cell,    // C43
  ];

  for (let i = 1; i <= 15; i++) {
    const sheetName = String(i);
    const member_sheet = ss.getSheetByName(sheetName);
    if (!member_sheet) {
      console.log(`${sheetName} 시트 없음, 스킵.`);
      continue;
    }

    // 🔧 [시간 텍스트 보존] getValues()로 백업하면 홑따옴표(')로 강제된
    // "00:00" 같은 시간 텍스트가 순수 문자열로 읽힌다. copyTo() 이후 그
    // 문자열을 setValues()로 그대로 되돌리면, 셀 서식이 template 것으로
    // 바뀌어 있어 Sheets가 "00:00"을 시간값으로 자동 파싱해버려 1899-12-30
    // 같은 날짜로 깨진다. getDisplayValues()로 표시 텍스트를 백업해두고,
    // 복원 시 시:분 형식("12:34")에는 홑따옴표를 다시 붙여 텍스트로 고정한다.
    var backup = preserve_ranges.map(function (a1) {
      return member_sheet.getRange(a1).getDisplayValues();
    });

    templateSheet.getRange("B2:W43").copyTo(member_sheet.getRange("B2:W43"));

    var time_pattern = /^\d{1,2}:\d{2}$/;
    preserve_ranges.forEach(function (a1, idx) {
      var restored = backup[idx].map(function (row) {
        return row.map(function (v) {
          return time_pattern.test(v) ? "'" + v : v;
        });
      });
      member_sheet.getRange(a1).setValues(restored);
    });

    // 🔧 레거시 시트에 template(43행 고정)보다 많은 물리적 행이 남아있으면
    // (예: 44, 45행) 붙여넣기 후에도 그대로 남는다 — copyTo()는 지정 범위
    // 밖은 건드리지 않으므로, template 기준 행 수를 넘는 초과분을 명시적으로
    // 삭제한다.
    var template_max_rows = templateSheet.getMaxRows();
    var member_max_rows = member_sheet.getMaxRows();
    if (member_max_rows > template_max_rows) {
      member_sheet.deleteRows(template_max_rows + 1, member_max_rows - template_max_rows);
    }

    protect_sheet(ss, sheetName);
  }
  sort_sheets(ss);
}