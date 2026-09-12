// 🔧 [구조 개선, 2026-09-13] 예치금 반환/강제퇴실/정산 판정 핵심부를
// index.js에서 분리했다(docs/TESTING.md 참고). depositRefundBreakdown이
// 만드는 depositBreakdown 객체를 forcedExitChecks/calcForcedOutDeposit/
// calcAdminForcedExit/calcSettleReturnDeposit/calcAgainDeposit가 입력으로
// 받고, calcExitProcess가 kind별로 이 넷을 디스패치하는 강하게 연결된
// 순수 함수 그룹이다. isLateNotice(시계 의존, todayKSTDateString() 호출)
// 만 실제로 Date.now()를 쓰고, depositRefundBreakdown은 이를 내부에서
// 호출해 간접 의존한다. calcSettleReturnDeposit은 depositBreakdown.
// lateNotice(이미 계산된 값)만 참조하므로 완전한 순수 함수다.
import { todayKSTDateString } from "./date-utils.js";
import {
  safeNumber,
  STATUS_DAYS,
  STATUS_DAY_COLS,
  ROW_PARTI_STATUS,
  COL_PARTI_STATUS,
  ROW_ACCESSION_DDAY,
  COL_ACCESSION_DDAY,
  ROW_DEPOSIT_AGAIN,
  COL_DEPOSIT_AGAIN,
  ROW_FINE_NO_STATUS,
  ROW_PAYMENT_CHECK,
} from "./index.js";

// 🔧 [데이터 시트 통합] 옛 개인 탭 C39(누적 송출P)/C40(금주 달성P) 숫자 셀은
// 사라졌다 — 총 페널티는 이제 appscript.js daily_calc()와 동일하게 "데이터"
// 시트 F~M열(4차=I, 6차=K, 주간P 1~2차=L/M) 중 현재 사이클(집계!D25)과 일치하는
// 슬롯 개수로 판정한다. outputPenSlots는 getPersonalStatusBundle()이 감싸는
// _computeOutputPenSlots()의 반환값. 송출P와 주간P를 구분해서 반환한다
// (UI가 "송출 P N회 / 주간 P N회" 형태로 따로 보여줌).
export function countCurrentCyclePen(outputPenSlots, currentCycle) {
  const { values, timePenValues } = outputPenSlots;
  let outputPen = 0;
  if (values[3] === currentCycle) outputPen++; // 4차(I)
  if (values[5] === currentCycle) outputPen++; // 6차(K)
  let timePen = 0;
  if (timePenValues[0] === currentCycle) timePen++; // 주간P 1차(L)
  if (timePenValues[1] === currentCycle) timePen++; // 주간P 2차(M)
  return { outputPen, timePen, total: outputPen + timePen };
}

// exitRequestDate(퇴실 신청 시 등록한 마지막 참여일)까지 남은 일수가 3일
// 미만이면 "퇴실 통보 지연"으로 친다. 이미 지난 날짜(음수)여도 여전히
// 3일 미만이므로 그대로 유지된다 — 마지막 참여일 다음날에도 50%가 계속
// 적용돼야 한다는 요구사항과 일치. exitRequestDate가 없으면(아직 퇴실
// 신청 전) 판정 자체를 하지 않는다.
export function isLateNotice(exitRequestDate) {
  if (!exitRequestDate) return false;
  const today = new Date(todayKSTDateString()).getTime();
  const target = new Date(exitRequestDate).getTime();
  if (Number.isNaN(target)) return false;
  const daysUntilLastAttend = Math.round((target - today) / 86_400_000);
  return daysUntilLastAttend < 3;
}

// 시트 수식(템플릿 U3, 예치금 반환 예상)과 동일한 순서로 감액 사유를 판정한다.
// 각 조건은 앞선 것이 우선하며, 마지막까지 해당 없으면 송출P/주간P 누적 합계와
// 고지지연(퇴실 통보 지연) 여부를 합산해 10,000/5,000/0원을 가른다. penCounts는
// countCurrentCyclePen()의 반환값. exitRequestDate는 실제 제출된 퇴실 신청의
// 마지막 참여일(없으면 null) — 🔧 [고지지연 미반영 버그 수정] 원래 이 값을
// 아예 받지 않아 프론트가 "페널티 1개 + 고지지연 = 100%"라고 표시만 하고
// 실제 반환액(amount)에는 전혀 반영되지 않았다.
export function depositRefundBreakdown(rows, penCounts, exitRequestDate) {
  const partiStatus = (rows[ROW_PARTI_STATUS] && rows[ROW_PARTI_STATUS][COL_PARTI_STATUS]) || "";
  const ddayRaw = (rows[ROW_ACCESSION_DDAY] && rows[ROW_ACCESSION_DDAY][COL_ACCESSION_DDAY]) || "";
  const dayMatch = /D\+(\d+)/.exec(ddayRaw);
  const daysSinceJoin = dayMatch ? Number(dayMatch[1]) : -1;
  const depositAgain = (rows[ROW_DEPOSIT_AGAIN] && rows[ROW_DEPOSIT_AGAIN][COL_DEPOSIT_AGAIN]) || "";
  const fineNoStatus = safeNumber((rows[ROW_FINE_NO_STATUS] && rows[ROW_FINE_NO_STATUS][2]) || 0);
  // 🔧 [벌금 미납 요일 표시] "차감 원인" 카드가 "벌금 미납 (월, 화)"처럼
  // 어느 요일에 미납이 발생했는지 함께 보여줄 수 있도록, "✅ 납부확인"
  // 행(31행)에서 값이 "미납"인 요일만 뽑는다 — fineNoStatus(C33 미납신호)는
  // 이 요일들 중 하나라도 있으면 1이 되는 단일 신호일 뿐 요일 정보를
  // 담지 않으므로 원본 행을 별도로 다시 읽는다.
  const paymentRow = rows[ROW_PAYMENT_CHECK] || [];
  const fineUnpaidDays = STATUS_DAYS.filter((_, i) => paymentRow[STATUS_DAY_COLS[i]] === "미납");
  // 🔧 [데이터 시트 통합] appscript.js _calc_return_deposit()과 동일하게
  // "데이터" 시트 F~M열 슬롯 중 현재 사이클과 일치하는 칸의 개수로 판정한다
  // (0=100%, 1=50%, 2 이상=0% 반환).
  const penTotal = penCounts.total;
  const lateNotice = isLateNotice(exitRequestDate);

  let amount = 0;
  let reason = null;
  if (!partiStatus) {
    reason = "참여상태 미확인";
  } else if (daysSinceJoin < 30) {
    reason = "가입 30일 미만";
  } else if (fineNoStatus === 1) {
    reason = "벌금 시한 내 미납";
  } else if (depositAgain === "미납") {
    reason = "예치금 재납 시한 미납";
  } else if (depositAgain === "납부") {
    reason = "예치금 재납 대상자";
  } else if (penTotal >= 2) {
    amount = 0;
  } else if (penTotal === 1) {
    // 페널티 1개(50%) + 고지지연(50%)이 겹치면 100% 차감(반환 0원).
    amount = lateNotice ? 0 : 5000;
  } else {
    amount = lateNotice ? 5000 : 10000;
  }
  if (reason) amount = 0;

  return {
    amount,
    reason,
    outputPen: penCounts.outputPen,
    timePen: penCounts.timePen,
    daysSinceJoin,
    fineUnpaid: fineNoStatus === 1,
    fineUnpaidDays,
    depositAgainStatus: depositAgain || null,
    lateNotice,
  };
}

// 강제퇴실 조건 전체를 met:true/false로 담아 반환한다. 실제로 걸렸는지와
// 무관하게 UI가 "가능한 모든 케이스"를 항상 나열하고 해당되는 것만 강조
// 표시할 수 있게 하기 위한 목록 — 예치금 재납("납부") 여부와 무관하게
// 순수 조건 계산 결과만 담는다(재납 시 강제퇴실 제외 로직은 calcForcedOutDeposit에서 처리).
export function forcedExitChecks(depositBreakdown) {
  const totalPen = depositBreakdown.outputPen + depositBreakdown.timePen;
  return [
    {
      code: "under_30_days",
      label: "가입 30일 미만",
      met: depositBreakdown.daysSinceJoin >= 0 && depositBreakdown.daysSinceJoin < 30,
    },
    { code: "fine_unpaid", label: "벌금 시한 내 미납", met: depositBreakdown.fineUnpaid },
    {
      code: "deposit_again_unpaid",
      label: "예치금 시한 내 미납",
      met: depositBreakdown.depositAgainStatus === "미납",
    },
    {
      code: "penalty_2_or_more",
      label: `페널티 누적 2회 이상 (송출 P ${depositBreakdown.outputPen}회 / 주간 P ${depositBreakdown.timePen}회)`,
      met: totalPen >= 2,
    },
  ];
}

// 강제퇴실 판정 — 앱스크립트 _calc_forced_out_deposit()의 자동 감지 사유에
// "페널티 누적 2회 이상"을 추가로 합쳐 다룬다(원래 정산 퇴실자 쪽에서 0%
// 반환으로만 처리되던 조건인데, 강제퇴실 성격이 더 강해 이쪽으로 옮김).
// 사유가 하나라도 있으면 discount_ratio=1(0% 반환) 확정, 없으면 null 반환.
export function calcForcedOutDeposit(depositBreakdown) {
  const allChecks = forcedExitChecks(depositBreakdown);
  const reasons = allChecks.filter((c) => c.met);

  // 앱스크립트 원본과 동일: 예치금을 이미 재납("납부")했다면 위에서 쌓인
  // 사유를 전부 무시하고 강제퇴실 대상에서 제외한다.
  if (depositBreakdown.depositAgainStatus === "납부") return null;

  if (reasons.length === 0) return null;
  const resultStr = reasons.map((r) => `${r.label} ➡️ 0% 반환`);
  return { resultStr, reasons, allChecks, discountRatio: 1 };
}

// 관리자가 직접 사유를 입력해 즉시 퇴실시키는 "직권 퇴실자" — 자동 감지되는
// 강제 퇴실자와 달리 항상 관리자 조작으로만 트리거되며, 반환율은 동일하게 0%.
// 🔧 2026-09: discountRatio는 사유 여부와 무관하게 항상 1(0% 반환)로
// 고정이라, 사유가 비어 있어도 계산 자체는 보여줄 수 있다(사용자 요청:
// 모달이 열리자마자 미리보기가 바로 뜨도록) — forcedReason 필수 검증은
// 실제 시트를 바꾸는 handleAdminExitConfirm 쪽으로 옮겼다.
export function calcAdminForcedExit(forcedReason) {
  const reasonLabel = forcedReason || "(사유 미입력)";
  return {
    resultStr: [`즉시 직권퇴실자 (사유 : ${reasonLabel}) ➡️ 0% 반환`],
    reasons: [{ code: "admin_reason", label: `직권 사유: ${reasonLabel}` }],
    discountRatio: 1,
  };
}

// 앱스크립트 _calc_return_deposit()과 동일: 페널티(송출P 금주+누적, 주간P 누적)
// 총합으로 정산 퇴실자의 반환율을 정한다. 페널티 2회 이상은 이제 강제
// 퇴실자(calcForcedOutDeposit)에서 다루므로 여기서는 0/1회만 남는다.
// 🔧 [고지지연 미반영 버그 수정] 원래 이 함수는 고지지연(exitRequestDate
// 기준, depositRefundBreakdown()의 lateNotice)을 전혀 받지 않아 결과가
// 항상 페널티 횟수만으로 0%/50%였다 — depositRefundBreakdown()의 amount
// 계산(§9.2, "페널티 1개(50%) + 고지지연(50%)이 겹치면 100% 차감")과
// 어긋났다. 회원 대시보드(DepositRefundDialog)가 신청 전 미리 보여주는
// "예상 반환액"은 이미 depositRefundBreakdown().amount를 그대로 쓰고
// 있었는데, 관리자가 실제로 "정산 퇴실 확정" 처리할 때만 이 값을 무시하고
// 있어 — 회원이 미리 본 예상액과 관리자 확정액이 어긋나는 실제 버그였다
// (더미 데이터 오류가 아니라 처리 로직 자체의 문제, 2026-09 사용자 지적으로
// 발견). depositBreakdown.lateNotice를 반영해 두 계산을 다시 일치시킨다.
export function calcSettleReturnDeposit(depositBreakdown) {
  const totalPen = depositBreakdown.outputPen + depositBreakdown.timePen;
  const lateNotice = !!depositBreakdown.lateNotice;
  // 페널티 0회: 고지지연 있으면 50% 차감, 없으면 0% 차감(100% 반환).
  // 페널티 1회: 고지지연 있으면 100% 차감(0원), 없으면 50% 차감 —
  // depositRefundBreakdown()의 amount 계산과 동일한 결과가 나오도록 맞춘 것.
  const discountRatio = totalPen === 0 ? (lateNotice ? 0.5 : 0) : lateNotice ? 1 : 0.5;
  const returnPct = Math.round((1 - discountRatio) * 100);
  const line =
    `송출 P (${depositBreakdown.outputPen}회) / 주간 P (${depositBreakdown.timePen}회)` +
    (lateNotice ? " + 퇴실 통보 지연" : "") +
    ` ➡️ ${returnPct}% 반환`;
  // 🔧 "퇴실유형" 카드(ExitedMemberList)가 exitTypeLabel(kindStr, reasons)로
  // "정산 퇴실자 (N% 반환)"처럼 반환율만 짧게 붙여 보여줄 수 있도록 code/label
  // 을 함께 채운다(사용자 지시: "50% 반환인지 100% 반환인지만 표시") — 이전엔
  // 이 함수가 reasons를 아예 반환하지 않아 항상 "정산 퇴실자"만 나왔었다.
  return {
    resultStr: [line],
    discountRatio,
    reasons: [{ code: "settle_return_rate", label: `${returnPct}% 반환` }],
  };
}

// 앱스크립트 _calc_again_deposit()과 동일: R3가 "납부"여야만 진행 가능.
export function calcAgainDeposit(depositBreakdown) {
  if (depositBreakdown.depositAgainStatus !== "납부") return null;
  return { resultStr: ["예치금 재납자 ➡️ 0% 반환"], discountRatio: 1 };
}

// kind별로 위 계산 중 하나를 골라 실행한다.
export function calcExitProcess(kind, depositBreakdown, forcedReason) {
  if (kind === "forced") {
    return calcForcedOutDeposit(depositBreakdown);
  }
  if (kind === "admin_forced") {
    return calcAdminForcedExit(forcedReason);
  }
  if (kind === "settle") {
    return calcSettleReturnDeposit(depositBreakdown);
  }
  if (kind === "deposit_again") {
    return calcAgainDeposit(depositBreakdown);
  }
  return null;
}

// 🔧 [총 페널티 모달 매칭] 예전에는 "N회차 (N/3 사이클) · 사유" 문자열
// 배열(outputPenReasons/timePenReasons)로 별도 조립했지만, "예치금 재납
// 대상자"에서 쓰는 슬롯 이력(outputPenHistory/timePenHistory,
// PenaltySlotHistoryEntry[])과 형식이 달라 두 화면의 "원인"이 서로 다르게
// 보였다. 이제 _computeOutputPenSlots()가 이미 buildSlotHistory로 만들어둔
// 이력을 그대로 넘겨받아 개인 대시보드 "총 페널티" 모달과 관리자
// "예치금 재납 대상자"가 완전히 같은 데이터·형식(N차 라벨, 발생일시,
// 사유, 캡처ID)을 쓰게 한다.
export function totalPenaltyBreakdown(outputPenSlots) {
  return {
    outputPenHistory: outputPenSlots.outputPenHistory,
    timePenHistory: outputPenSlots.timePenHistory,
  };
}
