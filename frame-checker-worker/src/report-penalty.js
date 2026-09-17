// 🔧 [구조 개선 20차, 2026-09-17] 제보/캡처 도메인(12차, src/report.js)을
// 다시 세 파일로 나눴다(docs/TESTING.md 참고). 이 파일(report-penalty.js)
// 은 "벌점/제보상점 반영(승인/취소/삭제/반려취소)" 단계만 담당한다 —
// 접수(report-intake.js)/검토(report-review.js) 단계와 실제 호출이
// 전혀 없음을 실측으로 확인했다(순수 재배치, 로직 변경 없음).
import {
  verifySession,
  getServiceAccountAccessToken,
  requireAdmin,
  json,
  withMemberLock,
  getSheetValues,
  writeSheetValues,
  spreadsheetBatchUpdate,
  getCurrentPenCycle,
  getSheetIdByName,
  colIndexToLetter,
  proxyToBotDashboard,
  OUTPUT_PEN_SHEET_NAME,
  OUTPUT_PEN_SLOT_COLUMNS,
  STATUS_DAY_COLS,
  resolveCaptureSourceFileId,
} from "./index.js";
import { listAllMembers } from "./members.js";
import { invalidateMemberCache, invalidateMemberSlotCache } from "./cache.js";
import { kstDateKey } from "./date-utils.js";

const OUTPUT_PEN_P_SLOTS = new Set(["I", "K"]); // 4차, 6차
// 제보상점 1~5차 슬롯(R~V) — getReportScore가 읽기 전용으로만 쓰던 범위를
// applyReportMerit(쓰기)에서도 그대로 재사용한다. 값=발생 시점의 페널티
// 사이클 번호(D25)로, OUTPUT_PEN_SLOT_COLUMNS와 동일한 기록 방식이다.
const REPORT_MERIT_SLOT_COLUMNS = ["R", "S", "T", "U", "V"]; // 1차..5차
// "D"~"I" 열 문자를 0-idx 컬럼 인덱스로 변환한다(batchUpdate의 grid 좌표는
// 이름이 아니라 숫자 인덱스를 요구한다). A=0.
function columnLetterToIndex(letter) {
  return letter.toUpperCase().charCodeAt(0) - "A".charCodeAt(0);
}

// 셀에 주석(note)을 남긴다 — spreadsheets.values API는 note를 다루지 못해
// batchUpdate의 updateCells(fields: "note")를 써야 한다.
async function writeCellNote(env, accessToken, fileId, sheetId, rowIndex, colLetter, note) {
  await spreadsheetBatchUpdate(env, accessToken, fileId, [
    {
      updateCells: {
        range: {
          sheetId,
          startRowIndex: rowIndex,
          endRowIndex: rowIndex + 1,
          startColumnIndex: columnLetterToIndex(colLetter),
          endColumnIndex: columnLetterToIndex(colLetter) + 1,
        },
        rows: [{ values: [{ note }] }],
        fields: "note",
      },
    },
  ]);
}

// "HH:MM" 문자열 두 개(발신/회신)의 차이를 분 단위로 계산한다. 회신이
// 발신보다 이르면(자정을 넘긴 경우) 24시간을 더해 보정한다.
function minutesBetween(sendTime, replyTime) {
  const parse = (t) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec((t || "").trim());
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  };
  const send = parse(sendTime);
  const reply = parse(replyTime);
  if (send === null || reply === null) return null;
  let diff = reply - send;
  if (diff < 0) diff += 24 * 60;
  return diff;
}

// 화각 요청 회신 지연(20분 초과분)을 개인 탭 27행(보정 학습시간)의 발생
// 요일 칸에 "-HH:MM"으로 차감 기록한다. 기존값에 그대로 더해 누적한다
// (구루미 오류 보정 가산시간 등 다른 보정과 공존해야 하기 때문).
const TIME_DEDUCT_GRACE_MINUTES = 20;
const TIME_DEDUCT_ROW = 27;

function formatSignedHHMM(totalMinutes, sign) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// 개인 탭 27행의 dayCol 칸에 있는 기존 값(HH:MM/+HH:MM/-HH:MM)을 분 단위로
// 파싱한다. 비어 있으면 0.
function parseSignedHHMM(raw) {
  const m = /^([+-]?)(\d{1,3}):(\d{2})$/.exec((raw || "").trim());
  if (!m) return 0;
  const minutes = parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
  return m[1] === "-" ? -minutes : minutes;
}

async function applyTimeDeduction(env, accessToken, fileId, memberNumber, ts, sendTime, replyTime) {
  const diffMinutes = minutesBetween(sendTime, replyTime);
  if (diffMinutes === null || diffMinutes <= TIME_DEDUCT_GRACE_MINUTES) {
    return { deductedMinutes: 0, dayCol: null };
  }
  const overMinutes = diffMinutes - TIME_DEDUCT_GRACE_MINUTES;
  const dayIndex = (new Date(ts).getDay() + 6) % 7; // 월=0 ... 일=6
  const dayCol = colIndexToLetter(STATUS_DAY_COLS[dayIndex]);
  const row = parseInt(memberNumber, 10) + 3;
  const cell = `${memberNumber}!${dayCol}${TIME_DEDUCT_ROW}`;

  const existingRows = await getSheetValues(env, accessToken, fileId, cell);
  const existingMinutes = parseSignedHHMM(existingRows[0] && existingRows[0][0]);
  const newMinutes = existingMinutes - overMinutes;
  const newValue = newMinutes === 0 ? "" : formatSignedHHMM(Math.abs(newMinutes), newMinutes < 0 ? "-" : "+");

  await writeSheetValues(env, accessToken, fileId, [{ range: cell, values: [[newValue]] }]);
  return { deductedMinutes: overMinutes, dayCol, row };
}

// 화각 제보 승인 시 "송출 P" 탭에 다음 차수를 기록한다. 사이클(D25)이 넘어가도
// 리셋하지 않고 이어서 센다 — 6차(송출P 2회)에 도달하면 예치금 재납으로 회원
// 행 자체가 초기화되는 게 유일한 리셋 지점이라, 여기서 별도로 주기 관리를
// 하지 않는다. 각 칸에는 그 위반이 발생한 시점의 D25 값을 기록용으로만 남긴다.
// reason/ts: 승인 대상 제보의 사유 텍스트와 발생 시각(ISO 문자열) — 셀 값
// 자체(사이클 번호)는 그대로 두고, 같은 칸에 주석(note)으로 "발생 시점 ·
// 사유"를 함께 남겨 나중에 상세 조회 시 근거를 보여줄 수 있게 한다.
// sendTime/replyTime: 관리자가 입력한 화각 요청 발신·회신 시각(HH:MM) —
// 20분 초과 지연분을 개인 탭 27행(보정 학습시간)에서 차감한다.
// 🔧 [버그 수정] "빈 슬롯 찾기 → 쓰기"는 락 없이 실행하면 같은 대상자에게
// 밀린 제보 여러 건을 관리자가 짧은 시간 안에 연속 승인할 때(백로그 정리 시
// 흔한 패턴) 두 요청이 같은 빈 슬롯을 읽어 하나가 조용히 덮어써지는
// 레이스가 있었다. withMemberLock으로 닉네임(대상자)별 임계구역을 감싸
// 동일 대상자에 대한 슬롯 배정은 항상 순차 실행되도록 한다.
async function applyOutputPenalty(env, accessToken, fileId, nickname, reason, ts, sendTime, replyTime, captureId) {
  return withMemberLock(env, `pen:${nickname}`, async () => {
    // 🔧 [members: TTL 2시간 상향 대응, 2026-09-11] 닉네임→번호 확정이 여기서
    // 벌점 슬롯에 실제로 기록되는 결정적 순간이다 — 번호가 재사용된 회원이
    // 있는데 members:가 낡아있으면 엉뚱한 회원에게 벌점이 적힐 수 있어,
    // 조회 직전에 좁은 그룹(members+dataSheetRows)만 무효화해 무조건 방금
    // 확인한 최신 명단으로 계산되게 한다(하루 승인 10건 미만이라 이 무효화
    // 추가 비용은 무시할 수준).
    await invalidateMemberCache(env, ["memberIdentity"], fileId);
    const [members, sheetId] = await Promise.all([
      listAllMembers(env, accessToken, fileId),
      getSheetIdByName(env, accessToken, fileId, OUTPUT_PEN_SHEET_NAME),
    ]);
    const member = members.find((m) => m.name === nickname);
    if (!member) {
      throw new Error(`"${nickname}" 이름과 일치하는 등록 회원을 찾을 수 없습니다.`);
    }
    const row = parseInt(member.number, 10) + 3;

    const [slotRows, currentD25] = await Promise.all([
      getSheetValues(env, accessToken, fileId, `'${OUTPUT_PEN_SHEET_NAME}'!F${row}:K${row}`),
      getCurrentPenCycle(env, accessToken, fileId),
    ]);
    const slotValues = (slotRows[0] || []).map((v) => parseInt(v, 10) || 0);

    // 값이 0인(=아직 안 채워진) 첫 칸을 찾는다.
    let slotIndex = -1;
    for (let i = 0; i < OUTPUT_PEN_SLOT_COLUMNS.length; i++) {
      if (slotValues[i] === 0) {
        slotIndex = i;
        break;
      }
    }
    if (slotIndex === -1) {
      // 사용자 확인: 6차(송출P 2회)에서 예치금 재납으로 기록이 초기화되므로
      // 정상 운영에서는 이 지점에 도달할 수 없다 — 도달하면 조용히 넘기지 않고 알린다.
      throw new Error(`${nickname}님은 1차~6차 칸이 모두 채워져 있습니다. 예치금 재납 처리가 필요할 수 있습니다.`);
    }

    const col = OUTPUT_PEN_SLOT_COLUMNS[slotIndex];
    const occurrence = slotIndex + 1; // 1차~6차
    const isPCount = OUTPUT_PEN_P_SLOTS.has(col);

    const writes = [writeSheetValues(env, accessToken, fileId, [
      { range: `'${OUTPUT_PEN_SHEET_NAME}'!${col}${row}`, values: [[currentD25]] },
    ])];
    // 🔧 [사유·발생일시·캡처ID 주석] 1~6차 모든 슬롯에 동일하게
    // "발생일시 · 사유 [cap:캡처ID]"를 남긴다 — reason이 비어 있어도 발생일시만이라도
    // 기록해 추적 가능하게 한다. 캡처ID는 " · "가 아니라 "[cap:...]" 대괄호
    // 표기로 맨 끝에 붙인다 — reason 자체가 관리자/봇이 자유 입력한 텍스트라
    // " · "를 포함할 수 있어, 같은 구분자로 세 번째 필드를 나누면 오파싱
    // 위험이 있기 때문이다. "예치금 재납 대상자" 카드에서 이 이력을 눌렀을 때
    // 봇이 보관 중인 원본 스크린샷·영상을 다시 불러오는 데 쓴다.
    if (sheetId !== null) {
      // 🔧 [타임존 버그] toLocaleString("ko-KR")은 표기 형식만 한국식일 뿐
      // 타임존은 Worker 실행 환경(UTC)을 그대로 쓴다 — timeZone을 명시해야
      // 실제 한국 시각으로 기록된다.
      const whenDate = ts ? new Date(ts) : new Date();
      const when = whenDate.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
      let note = reason ? `${when} · ${reason}` : when;
      if (captureId) note += ` [cap:${captureId}]`;
      writes.push(writeCellNote(env, accessToken, fileId, sheetId, row - 1, col, note));
    }
    await Promise.all(writes);

    const timeDeduction = await applyTimeDeduction(env, accessToken, fileId, member.number, ts, sendTime, replyTime);

    // 🔧 [이번 주 영향 스냅샷] "이번 주 영향"(weeklyMinorPenaltyCount ×
    // 0.1점)은 attachNextOccurrence가 GET 시점마다 다시 계산하는 값이라,
    // 이 건이 확정된 뒤 같은 대상자의 다른 건이 추가로 처리되면 계속
    // 달라진다(사용자 지적: "적용하고 나니까 -0.1점에서 -0.2점으로 바뀐다"
    // — 다음 pending 건 기준으로 재계산된 예측값을 계속 보여준 것이 원인).
    // 이 건이 실제로 확정된 시점의 값을 여기서 직접 계산해 응답에 실어
    // manifest에 저장해 두면, 이후 몇 번을 다시 조회하든 그 시점 값 그대로
    // 고정 표시할 수 있다. slotValues는 방금 쓴 슬롯이 반영되기 전 상태이므로
    // 이 건 자신의 슬롯(occurrence)도 2/3/5차면 카운트에 더한다.
    const isMinorSlot = occurrence === 2 || occurrence === 3 || occurrence === 5;
    const weeklyMinorPenaltyCount =
      [1, 2, 4].filter((idx) => slotValues[idx] === currentD25).length + (isMinorSlot ? 1 : 0);

    return {
      number: member.number,
      name: member.name,
      occurrence,
      isPCount,
      col,
      deductedMinutes: timeDeduction.deductedMinutes,
      dayCol: timeDeduction.dayCol,
      weeklyMinorPenaltyCount,
    };
  });
}

// 제보 승인("적용"/"반려 (인정)") 시 제보자에게 제보상점을 부여한다 —
// applyOutputPenalty와 완전히 동일한 패턴(값 0인 첫 칸을 찾아 현재 페널티
// 사이클 번호를 쓰고, 같은 칸에 발생일시·사유를 주석으로 남김)을 "데이터"
// 시트 R~V(제보상점 1~5차)에 그대로 적용한다. 5칸이 모두 차 있으면(정상
// 운영에서는 도달하지 않아야 함) applyOutputPenalty와 동일하게 조용히
// 넘기지 않고 명시적 에러를 던진다.
async function applyReportMerit(env, accessToken, fileId, reporterEmail, reason, ts, captureId) {
  return withMemberLock(env, `merit:${(reporterEmail || "").toLowerCase()}`, async () => {
    // 🔧 [members: TTL 2시간 상향 대응, 2026-09-11] applyOutputPenalty와 동일한
    // 이유 — 제보자 이메일→번호 확정이 여기서 상점 슬롯에 실제로 기록되는
    // 결정적 순간이라, 조회 직전에 좁은 그룹만 무효화해 최신 명단을 보장한다.
    await invalidateMemberCache(env, ["memberIdentity"], fileId);
    const [members, sheetId] = await Promise.all([
      listAllMembers(env, accessToken, fileId),
      getSheetIdByName(env, accessToken, fileId, OUTPUT_PEN_SHEET_NAME),
    ]);
    const reporter = members.find((m) => m.email.toLowerCase() === (reporterEmail || "").toLowerCase());
    if (!reporter) {
      throw new Error(`제보자(${reporterEmail || "이메일 없음"})와 일치하는 등록 회원을 찾을 수 없습니다.`);
    }
    const row = parseInt(reporter.number, 10) + 3;

    const [slotRows, currentD25] = await Promise.all([
      getSheetValues(env, accessToken, fileId, `'${OUTPUT_PEN_SHEET_NAME}'!R${row}:V${row}`),
      getCurrentPenCycle(env, accessToken, fileId),
    ]);
    const slotValues = (slotRows[0] || []).map((v) => parseInt(v, 10) || 0);

    let slotIndex = -1;
    for (let i = 0; i < REPORT_MERIT_SLOT_COLUMNS.length; i++) {
      if (slotValues[i] === 0) {
        slotIndex = i;
        break;
      }
    }
    if (slotIndex === -1) {
      throw new Error(`${reporter.name}님은 제보상점 1차~5차 칸이 모두 채워져 있습니다.`);
    }

    const col = REPORT_MERIT_SLOT_COLUMNS[slotIndex];
    const occurrence = slotIndex + 1; // 1차~5차

    const writes = [writeSheetValues(env, accessToken, fileId, [
      { range: `'${OUTPUT_PEN_SHEET_NAME}'!${col}${row}`, values: [[currentD25]] },
    ])];
    if (sheetId !== null) {
      const whenDate = ts ? new Date(ts) : new Date();
      const when = whenDate.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
      let note = reason ? `${when} · ${reason}` : when;
      if (captureId) note += ` [cap:${captureId}]`;
      writes.push(writeCellNote(env, accessToken, fileId, sheetId, row - 1, col, note));
    }
    await Promise.all(writes);

    return { number: reporter.number, name: reporter.name, occurrence, col };
  });
}

// applyOutputPenalty()가 방금 기록한 슬롯을 되돌린다 — 관리자가 오적용을
// 바로잡을 수 있게 하는 상시 기능. 값(사이클 번호)과 주석을 모두 지운다.
// col은 승인 응답에 포함된 실제 기록 열(F~K)을 그대로 넘겨받아 사용한다.
// deductedMinutes/dayCol이 있으면(회신 지연으로 시간 차감이 함께 기록됐던
// 경우) 27행의 그 요일 칸에서도 동일한 분만큼 되돌린다.
// applyTimeDeduction()이 개인 탭 27행에 기록한 지연 차감분을 되돌린다
// (cancelOutputPenalty의 시간 차감 되돌림 부분과 동일 로직 — "유예 취소"
// (revert)처럼 슬롯 자체는 없이 시간 차감만 되돌려야 하는 경우를 위해
// 분리했다).
async function cancelTimeDeduction(env, accessToken, fileId, memberNumber, deductedMinutes, dayCol) {
  if (!(deductedMinutes > 0) || !dayCol) return;
  const cell = `${memberNumber}!${dayCol}${TIME_DEDUCT_ROW}`;
  const existingRows = await getSheetValues(env, accessToken, fileId, cell);
  const existingMinutes = parseSignedHHMM(existingRows[0] && existingRows[0][0]);
  const restoredMinutes = existingMinutes + deductedMinutes;
  const newValue = restoredMinutes === 0 ? "" : formatSignedHHMM(Math.abs(restoredMinutes), restoredMinutes < 0 ? "-" : "+");
  await writeSheetValues(env, accessToken, fileId, [{ range: cell, values: [[newValue]] }]);
}

async function cancelOutputPenalty(env, accessToken, fileId, memberNumber, col, deductedMinutes, dayCol) {
  if (!OUTPUT_PEN_SLOT_COLUMNS.includes(col)) {
    throw new Error(`유효하지 않은 열입니다: ${col}`);
  }
  const row = parseInt(memberNumber, 10) + 3;
  const sheetId = await getSheetIdByName(env, accessToken, fileId, OUTPUT_PEN_SHEET_NAME);

  const writes = [writeSheetValues(env, accessToken, fileId, [
    { range: `'${OUTPUT_PEN_SHEET_NAME}'!${col}${row}`, values: [[0]] },
  ])];
  if (sheetId !== null) {
    writes.push(writeCellNote(env, accessToken, fileId, sheetId, row - 1, col, null));
  }
  writes.push(cancelTimeDeduction(env, accessToken, fileId, memberNumber, deductedMinutes, dayCol));
  await Promise.all(writes);
}

// applyReportMerit()가 방금 기록한 제보상점 슬롯을 되돌린다(cancelOutputPenalty와
// 동일 패턴 — 값과 주석만 지우면 되므로 시간 차감 되돌림은 없다). "폐기"가
// handleAdminCaptureDelete 경로를 재사용할 때, 이미 "적용"/"반려 (인정)"으로
// 제보상점이 기록된 항목이면 함께 원상복구하는 데 쓰인다.
async function cancelReportMerit(env, accessToken, fileId, memberNumber, col) {
  if (!REPORT_MERIT_SLOT_COLUMNS.includes(col)) {
    throw new Error(`유효하지 않은 열입니다: ${col}`);
  }
  const row = parseInt(memberNumber, 10) + 3;
  const sheetId = await getSheetIdByName(env, accessToken, fileId, OUTPUT_PEN_SHEET_NAME);

  const writes = [writeSheetValues(env, accessToken, fileId, [
    { range: `'${OUTPUT_PEN_SHEET_NAME}'!${col}${row}`, values: [[0]] },
  ])];
  if (sheetId !== null) {
    writes.push(writeCellNote(env, accessToken, fileId, sheetId, row - 1, col, null));
  }
  await Promise.all(writes);
}

export async function handleAdminCaptureCancel(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { number, col, deductedMinutes, dayCol, sourceFileId } = await req.json().catch(() => ({}));
  if (!number || !col) {
    return json({ error: "number와 col이 필요합니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — 실제로
    // 벌점을 쓴 파일(sourceFileId, handleAdminCaptureDecide 응답으로
    // 프론트가 들고 있음)에서 취소해야 한다. 없으면(옛 클라이언트 등)
    // 원본으로 폴백한다.
    const fileId = sourceFileId || env.GOOGLE_SHEET_FILE_ID;
    await cancelOutputPenalty(env, accessToken, fileId, number, col, deductedMinutes || 0, dayCol || null);
    // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — 캐시
    // 무효화도 실제로 쓴 fileId를 넘겨야 한다. 생략하면 항상
    // env.GOOGLE_SHEET_FILE_ID(원본)만 지워져, fileId가 지난 사이클
    // 백업이었을 때 그 백업의 캐시(exitStatus/personalStatusBundle 등)
    // 가 최대 TTL만큼 갱신되지 않는다.
    await invalidateMemberCache(env, ["penalty"], fileId); // 페널티 슬롯이 바뀌었으므로 관련 캐시만 무효화.
    await invalidateMemberSlotCache(env, number, fileId); // 이 회원의 outputPenSlots/reportScore는 KV까지 즉시.
    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "취소 실패: " + err.message }, 500, origin);
  }
}

// applyReportMerit()로 부여한 제보상점을 되돌린다(handleAdminCaptureCancel과
// 동일 패턴, cancelReportMerit 재사용) — "적용"/"페널티 적용 (불가)"로
// 처리된 항목의 "취소" 버튼이 대상자 페널티와 별개로 호출한다.
export async function handleAdminCaptureCancelMerit(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { number, col, sourceFileId } = await req.json().catch(() => ({}));
  if (!number || !col) {
    return json({ error: "number와 col이 필요합니다." }, 400, origin);
  }

  try {
    const accessToken = await getServiceAccountAccessToken(env);
    const fileId = sourceFileId || env.GOOGLE_SHEET_FILE_ID;
    await cancelReportMerit(env, accessToken, fileId, number, col);
    await invalidateMemberCache(env, ["penalty"], fileId); // 제보상점 슬롯이 바뀌었으므로 관련 캐시만 무효화.
    await invalidateMemberSlotCache(env, number, fileId); // 이 회원의 outputPenSlots/reportScore는 KV까지 즉시.
    return json({ ok: true }, 200, origin);
  } catch (err) {
    return json({ error: "취소 실패: " + err.message }, 500, origin);
  }
}

// 🔧 [3버튼 재설계 → 유예 추가] 결정 종류:
// - "approved" : 페널티로 인정되며 대상자 슬롯에 여유가 있음
//     → 제보자에게 제보상점 추가(applyReportMerit) + 대상자에게 벌점/페널티 추가(applyOutputPenalty).
// - "rejected_recognized" : 페널티로 인정되나 대상자 잔여 슬롯이 없어 등록 불가
//     → 제보자에게 제보상점만 추가, 대상자에게는 아무 처리도 하지 않음.
//     (프론트: "송출 P 적용 (불가)" 버튼이 이 decision을 보낸다 — 사용자 지시로
//     별도 "반려 (인정)" 버튼을 만들지 않고 "적용" 버튼의 동적 라벨/동작으로 흡수했다.)
// - "deferred" : 페널티로 인정되나, 대상자가 "당일 이미 1회 적용을 받아" 이후
//     최대 2건은 적용을 미룬다(사용자 지시 — "유예"). rejected_recognized와
//     처리 자체(제보자 상점만 부여, 대상자 처리 없음)는 동일하지만, "왜
//     대상자 처리를 안 했는지" 사유가 다르므로(잔여 슬롯 없음 vs 당일 1회
//     제한) 별도 decision 값으로 구분한다 — 나중에 "몇 번째 유예인지"를
//     추적해 "다음 적용"으로 재개할 시점을 판단하려면 이 구분이 필요하다.
// - "rejected" : 페널티로 인정되지 않음 → 아무 처리도 하지 않음(웹에는 계속 표시).
// "폐기"는 새 decision이 아니라 기존 handleAdminCaptureDelete(완전 삭제) 경로를
// 그대로 재사용한다(사용자 확정) — 여기서는 다루지 않는다.
const CAPTURE_DECISIONS = ["approved", "rejected_recognized", "deferred", "rejected"];

// 🔧 [제보상점 1일 1회 제한] 제보자는 하루에 최대 1회만 제보상점을 받을 수
// 있다(주간 5회 상한과 별개, 사용자 지시). "당일"은 실제로 시트에 상점이
// 반영된 시각(decidedAt) 기준 KST 날짜로 판정한다 — 제보 접수 시각(ts)
// 기준으로 하면, 예를 들어 어제 접수됐지만 오늘 관리자가 처리한 건이
// "어제 이미 받음"으로 잘못 카운트되는 문제가 있다(사용자 지적: "실제로
// 유예나 적용을 통해 시트에 적용된 경우에만 당일 1회를 받은 걸로 인식").
// 봇 manifest 전체(당일 판정이라 archive까지 볼 필요는 없음)에서 같은
// 제보자(reporterEmail)·같은 결정일(decidedAt의 KST 날짜)에 이미 성공한
// (merit이 error가 아닌) 건이 있는지 확인한다.
async function hasReporterAlreadyReceivedMeritToday(env, reporterEmail, nowTs) {
  const email = (reporterEmail || "").toLowerCase();
  if (!email) return false;
  const data = await proxyToBotDashboard(env, "/captures");
  const items = (data && data.items) || [];
  const todayKey = kstDateKey(nowTs);
  return items.some(
    (it) =>
      (it.reporterEmail || "").toLowerCase() === email &&
      it.merit &&
      !("error" in it.merit) &&
      it.decidedAt &&
      kstDateKey(it.decidedAt) === todayKey
  );
}

// 🔧 [유예/반려 차수 스냅샷] "지금 적용했다면 몇 차였을지"를 결정 시점에
// 직접 읽어 고정한다 — item.nextOccurrence는 GET 시점마다 재계산되는 값이라,
// 유예나 반려로 확정된 뒤 다른 건이 실제로 그 슬롯을 채우면(예: 다음 건이
// "확정"되어 2차가 채워지면) 이미 확정된 이 건의 표시 차수도 밀려 보였다
// (사용자 재현: "2차가 확정되니 앞의 유예 1차·2차가 모두 3차로 바뀜" — 반려도
// 동일 구조라 사용자 확인 후 함께 적용). nickname으로 회원을 못 찾으면 null.
async function snapshotNextOccurrence(env, accessToken, fileId, nickname) {
  if (!nickname) return null;
  const member = (await listAllMembers(env, accessToken, fileId)).find((m) => m.name === nickname);
  if (!member) return null;
  const row = parseInt(member.number, 10) + 3;
  const slotRows = await getSheetValues(env, accessToken, fileId, `'${OUTPUT_PEN_SHEET_NAME}'!F${row}:K${row}`);
  const slotValues = (slotRows[0] || []).map((v) => parseInt(v, 10) || 0);
  const slotIndex = slotValues.findIndex((v) => v === 0);
  return slotIndex === -1 ? null : slotIndex + 1;
}

export async function handleAdminCaptureDecide(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const { id, decision, nickname, reporterEmail, reason, ts, sendTime, replyTime } = await req.json().catch(() => ({}));
  if (!id || !CAPTURE_DECISIONS.includes(decision)) {
    return json({ error: "잘못된 요청입니다." }, 400, origin);
  }

  // 🔧 [버그 수정] 여기서 시트에 쓰기 전까지 이 capture id가 아직
  // "pending"인지 확인하는 코드가 없었다 — 첫 결정 요청이 시트 반영(수백ms
  // ~봇 프록시 타임아웃 8초)을 마치고 봇 manifest를 approved로 갱신하기
  // 전 사이, 관리자가 응답이 느려 답답해서 새로고침하면 GET /admin/captures가
  // 아직 pending인 스냅샷을 보여줘 "적용"/"반려" 버튼이 다시 뜬다. 여기서
  // 다시 누르면 같은 캡처에 벌점/제보상점 슬롯이 두 번 채워졌다. 시트에
  // 쓰기 직전 봇 manifest의 현재 상태를 한 번 더 확인해, 이미 pending이
  // 아니면(이미 처리됨) 거부한다.
  const currentStatus = await fetchCaptureReviewStatus(env, id);
  if (currentStatus !== null && currentStatus !== "pending") {
    return json({ error: "이미 처리된 제보입니다. 새로고침 후 확인해주세요." }, 409, origin);
  }

  let penaltyResult = null;
  let meritResult = null;
  let timeDeductionResult = null;
  let deferredOccurrenceSnapshot = null;
  // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — 아래 모든
  // 분기(승인/유예/반려 포함)가 이 하나의 fileId를 공유한다. ts가 속한
  // 주가 이번 주면 원본 그대로, 아니면 그 주의 백업 파일로 판정된다.
  let accessTokenForSource, sourceFileId;
  try {
    accessTokenForSource = await getServiceAccountAccessToken(env);
    ({ sourceFileId } = await resolveCaptureSourceFileId(
      env,
      accessTokenForSource,
      env.GOOGLE_SHEET_FILE_ID,
      ts
    ));
  } catch (err) {
    return json({ error: "제보 사이클 판정 실패: " + err.message }, 500, origin);
  }
  if (decision === "approved" || decision === "rejected_recognized" || decision === "deferred") {
    try {
      const accessToken = accessTokenForSource;
      const fileId = sourceFileId;

      if (decision === "approved") {
        if (!nickname) return json({ error: "nickname이 필요합니다." }, 400, origin);
        penaltyResult = await applyOutputPenalty(env, accessToken, fileId, nickname, reason, ts, sendTime, replyTime, id);
      } else if (decision === "deferred") {
        // 🔧 [유예도 응답 지연 시간 차감] "유예"는 당일 이미 1회 적용을 받아
        // 벌점/송출P 슬롯만 면제될 뿐, 화각 요청에 늦게 응답한 사실 자체는
        // 그대로 남는다(사용자 지시: "제보 확인 자체를 늦게 해서 엉망인
        // 화각으로 다른 사람에게 피해를 끼치는" 문제와 벌점 면제는 별개).
        // applyOutputPenalty(슬롯 채우기)는 건너뛰되, 그 안에서만 호출되던
        // applyTimeDeduction을 여기서 독립적으로 호출해 20분 초과 지연분을
        // 그대로 개인 탭 27행에서 차감한다. "송출 P 적용 (불가)"
        // (rejected_recognized, 잔여 슬롯 없음)는 이번 지시 범위 밖이라
        // 그대로 둔다(사용자 확인).
        if (nickname) {
          const member = (await listAllMembers(env, accessToken, fileId)).find((m) => m.name === nickname);
          if (member) {
            const timeDeduction = await applyTimeDeduction(env, accessToken, fileId, member.number, ts, sendTime, replyTime);
            if (timeDeduction.deductedMinutes > 0) {
              timeDeductionResult = {
                number: member.number,
                deductedMinutes: timeDeduction.deductedMinutes,
                dayCol: timeDeduction.dayCol,
              };
            }
          }
        }
      }
      // 🔧 [유예/반려 차수 스냅샷] 벌점 슬롯을 실제로 채우지 않는 세 결정
      // (deferred/rejected_recognized — 아래 순수 rejected는 이 블록 밖에서
      // 별도 처리) 모두, 결정 시점의 빈 슬롯을 스냅샷으로 남긴다 — 그러지
      // 않으면 이후 다른 건이 실제로 그 슬롯을 채울 때 이미 확정된 이 건의
      // 표시 차수까지 밀려 보인다(사용자 재현, 반려도 함께 적용하기로 확인).
      if (decision === "deferred" || decision === "rejected_recognized") {
        deferredOccurrenceSnapshot = await snapshotNextOccurrence(env, accessToken, fileId, nickname);
      }
      const alreadyReceivedToday = await hasReporterAlreadyReceivedMeritToday(env, reporterEmail, Date.now());
      if (alreadyReceivedToday) {
        // 1일 1회 상한 — 대상자 페널티(있었다면)는 이미 반영됐으니 그대로
        // 두고, 제보상점만 조용히 건너뛴다(applyOutputPenalty와 동일하게
        // "조용히 넘기지 않는다" 원칙 — meritResult에 사유를 남긴다).
        meritResult = { error: "제보자가 오늘 이미 제보상점을 받아 1일 1회 상한으로 부여하지 않았습니다." };
      } else {
        try {
          meritResult = await applyReportMerit(env, accessToken, fileId, reporterEmail, reason, ts, id);
        } catch (meritErr) {
          // 제보자 상점 부여는 대상자 페널티와 별개 실패 지점이다(예: 제보자가
          // 회원 명단에 없거나 5칸이 이미 다 찼을 때) — 이미 시트에 반영된
          // 대상자 페널티까지 되돌리지 않고, 그 사실을 응답에 담아 관리자가
          // 알 수 있게만 한다(자동 롤백은 하지 않음 — applyOutputPenalty와
          // 동일하게 "조용히 넘기지 않는다" 원칙).
          meritResult = { error: meritErr.message };
        }
      }
      // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — sourceFileId
      // 를 넘겨야 한다. 생략하면 항상 원본만 지워져, sourceFileId가 지난
      // 사이클 백업이었을 때 그 백업의 캐시가 갱신되지 않는다.
      await invalidateMemberCache(env, ["penalty"], sourceFileId); // 페널티/제보상점 슬롯이 바뀌었으므로 관련 캐시만 무효화.
      // 대상자(penaltyResult)와 제보자(meritResult)는 서로 다른 회원일 수
      // 있다 — 둘 다 outputPenSlots/reportScore가 KV까지 즉시 지워지도록.
      if (penaltyResult?.number) await invalidateMemberSlotCache(env, penaltyResult.number, sourceFileId);
      if (meritResult?.number) await invalidateMemberSlotCache(env, meritResult.number, sourceFileId);
    } catch (err) {
      return json({ error: "시트 반영 실패: " + err.message }, 500, origin);
    }
  } else if (decision === "rejected") {
    // 🔧 [반려 차수 스냅샷] 순수 반려는 시트에 아무것도 쓰지 않지만(위 if
    // 블록 밖), 위 유예/반려(인정)와 동일하게 "지금 적용했다면 몇 차였을지"
    // 취소선 표시가 나중에 밀리지 않도록 결정 시점의 스냅샷을 남긴다. 시트를
    // 쓰지 않는 경로라 조회 실패는 조용히 무시(null 유지, nextOccurrence로
    // 폴백)해도 안전하다 — 반려 처리 자체를 막을 이유는 아니다.
    try {
      deferredOccurrenceSnapshot = await snapshotNextOccurrence(env, accessTokenForSource, sourceFileId, nickname);
    } catch {
      // 조회만 실패한 것 — 반려 처리는 계속 진행, 스냅샷 없이 nextOccurrence로 폴백.
    }
  }

  // penalty/merit/timeDeduction을 봇 manifest에도 함께 저장해 둔다 —
  // 관리자가 새로고침한 뒤에도 "반려 취소"/"폐기"가 무엇을 되돌려야
  // 하는지 프론트 로컬 state 없이 이 기록만으로 알 수 있게 하기 위함
  // (GET /admin/captures가 그대로 다시 내려준다).
  const data = await proxyToBotDashboard(env, "/captures/decide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      decision,
      penalty: penaltyResult,
      merit: meritResult,
      timeDeduction: timeDeductionResult,
      deferredOccurrence: deferredOccurrenceSnapshot,
      // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — 이후
      // 취소/삭제/되돌리기(handleAdminCaptureCancel 등)가 새로고침
      // 후에도(findStoredPenaltyMerit 폴백) 정확한 파일에서 롤백할
      // 수 있도록 manifest에도 함께 남긴다.
      sourceFileId,
    }),
  });
  if (!data) {
    // 🔧 [버그 수정] 원래는 여기서 502만 반환했다 — 그런데 위에서 이미
    // applyOutputPenalty/applyReportMerit로 시트에는 페널티/제보상점을
    // 써버린 뒤라, 봇 manifest 반영(이 호출)만 실패하면 시트에는 반영됐는데
    // manifest는 여전히 "pending"인 불일치가 생겼다. 관리자는 에러를 보고
    // 재시도할 수밖에 없는데, 그러면 같은 캡처가 다시 승인되어 슬롯이
    // 중복 소비되거나(재시도가 성공하는 경우), 첫 시도의 시트 기록이
    // manifest 어디에도 연결되지 않아 findStoredPenaltyMerit로도 찾을 수
    // 없는 고아 기록으로 영구히 남았다(폐기/반려취소로도 되돌릴 길이 없음).
    // 여기서 실패하면 방금 쓴 시트 기록을 즉시 되돌려, 재시도가 항상
    // "처음부터 다시"가 되도록 한다. 롤백도 반드시 같은 sourceFileId에서
    // 이뤄져야 한다 — 실제로 쓴 곳과 다른 파일에서 취소하면 엉뚱한 슬롯을
    // 건드리거나 아무 효과 없이 조용히 끝난다.
    if (penaltyResult && penaltyResult.number && penaltyResult.col) {
      try {
        await cancelOutputPenalty(
          env,
          accessTokenForSource,
          sourceFileId,
          penaltyResult.number,
          penaltyResult.col,
          penaltyResult.deductedMinutes || 0,
          penaltyResult.dayCol || null
        );
      } catch (rollbackErr) {
        return json(
          { error: `봇에 연결할 수 없고, 시트 롤백도 실패했습니다(수동 확인 필요: ${rollbackErr.message}).` },
          502,
          origin
        );
      }
    }
    if (meritResult && meritResult.number && meritResult.col) {
      try {
        await cancelReportMerit(env, accessTokenForSource, sourceFileId, meritResult.number, meritResult.col);
      } catch (rollbackErr) {
        return json(
          { error: `봇에 연결할 수 없고, 제보상점 롤백도 실패했습니다(수동 확인 필요: ${rollbackErr.message}).` },
          502,
          origin
        );
      }
    }
    if (timeDeductionResult && timeDeductionResult.number) {
      try {
        await cancelTimeDeduction(
          env,
          accessTokenForSource,
          sourceFileId,
          timeDeductionResult.number,
          timeDeductionResult.deductedMinutes || 0,
          timeDeductionResult.dayCol || null
        );
      } catch (rollbackErr) {
        return json(
          { error: `봇에 연결할 수 없고, 시간 차감 롤백도 실패했습니다(수동 확인 필요: ${rollbackErr.message}).` },
          502,
          origin
        );
      }
    }
    if (penaltyResult || meritResult || timeDeductionResult) {
      // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — 위
      // 롤백(cancelOutputPenalty 등)이 sourceFileId에서 이뤄졌으므로
      // 캐시 무효화도 같은 파일을 대상으로 해야 한다.
      await invalidateMemberCache(env, ["penalty"], sourceFileId);
      if (penaltyResult?.number) await invalidateMemberSlotCache(env, penaltyResult.number, sourceFileId);
      if (meritResult?.number) await invalidateMemberSlotCache(env, meritResult.number, sourceFileId);
    }
    return json({ error: "봇에 연결할 수 없습니다. 시트 반영은 자동으로 되돌렸으니 다시 시도해주세요." }, 502, origin);
  }
  return json(
    { ...data, penalty: penaltyResult, merit: meritResult, timeDeduction: timeDeductionResult, sourceFileId },
    200,
    origin
  );
}

// 특정 캡처 id에 저장된 penalty/merit을 찾는다 — 관리자가 새로고침해
// 프론트 로컬 state(applied[item.id])를 잃은 뒤에도
// handleAdminCaptureDelete/handleAdminCaptureRevert가 무엇을 되돌려야
// 하는지 알 수 있게 하는 폴백 조회다(handleAdminCaptureDecide가 결정
// 시점에 봇 manifest에도 함께 저장해 둔다).
// 🔧 [버그 수정] 원래는 GET /captures(원본 manifest 전체만, archive
// 미포함)에서 id를 찾았다 — archive_old_captures로 옮겨진(3주 이상 지난
// 확정) 캡처에 대해 관리자가 새로고침 후 "폐기"/"반려 취소"를 누르면
// penalty/merit을 못 찾아 시트에 반영된 벌점/제보상점을 되돌리지 못한 채
// 그대로 진행됐다. 봇의 get_capture는 이미 archive도 함께 조회하므로,
// 이를 그대로 노출하는 단건 조회(/captures/one)로 바꿔 항상 정확한
// penalty/merit을 찾을 수 있게 한다.
async function findStoredPenaltyMerit(env, id) {
  const data = await proxyToBotDashboard(env, `/captures/one?id=${encodeURIComponent(id)}`);
  const item = data && data.item;
  return {
    penalty: item?.penalty || null,
    merit: item?.merit || null,
    timeDeduction: item?.timeDeduction || null,
    // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — handleAdminCaptureDecide
    // 가 manifest에 함께 저장해둔 sourceFileId. 프론트가 이 값을 안 보내도
    // (새로고침 등) 여기서 폴백해 정확한 파일에서 롤백할 수 있게 한다.
    sourceFileId: item?.sourceFileId || null,
  };
}

// capture id의 봇 manifest상 현재 reviewStatus만 가볍게 조회한다
// (handleAdminCaptureDecide가 시트에 쓰기 전 중복 처리 방지에 사용).
async function fetchCaptureReviewStatus(env, id) {
  const data = await proxyToBotDashboard(env, `/captures/one?id=${encodeURIComponent(id)}`);
  const item = data && data.item;
  return item?.reviewStatus ?? null;
}

// 제보 기록 자체를 완전히 말소한다(반려 취소와 달리 되돌릴 수 없음, 웹
// 서비스에서도 보이지 않게 됨 — "폐기" 기능이 그대로 재사용하는 경로,
// 사용자 확정). 이미 "적용"/"반려 (인정)"으로 시트에 반영된 값이 있으면,
// 봇 쪽 기록을 지우기 전에 원상복구한다 — 그러지 않으면 봇 기록은
// 사라졌는데 시트에는 페널티/제보상점이 남는 불일치가 생긴다. 프론트가
// 함께 보낸 penalty/merit(로컬 state)이 있으면 그대로 쓰고, 새로고침 등으로
// 없으면 봇 manifest에 저장된 값으로 폴백한다.
export async function handleAdminCaptureDelete(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const body = await req.json().catch(() => ({}));
  const { id } = body;
  if (!id) return json({ error: "id가 필요합니다." }, 400, origin);
  let { penalty, merit, sourceFileId } = body;
  if (!penalty && !merit) {
    ({ penalty, merit, sourceFileId } = await findStoredPenaltyMerit(env, id));
  }

  if ((penalty && penalty.number && penalty.col) || (merit && merit.number && merit.col)) {
    try {
      const accessToken = await getServiceAccountAccessToken(env);
      // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — 실제로
      // 벌점/상점을 쓴 파일에서 취소해야 한다.
      const fileId = sourceFileId || env.GOOGLE_SHEET_FILE_ID;
      if (penalty && penalty.number && penalty.col) {
        await cancelOutputPenalty(env, accessToken, fileId, penalty.number, penalty.col, penalty.deductedMinutes || 0, penalty.dayCol || null);
      }
      if (merit && merit.number && merit.col) {
        await cancelReportMerit(env, accessToken, fileId, merit.number, merit.col);
      }
      await invalidateMemberCache(env, ["penalty"], fileId); // 페널티/제보상점 슬롯이 바뀌었으므로 관련 캐시만 무효화.
      if (penalty?.number) await invalidateMemberSlotCache(env, penalty.number, fileId);
      if (merit?.number) await invalidateMemberSlotCache(env, merit.number, fileId);
    } catch (err) {
      return json({ error: "시트 반영 취소 실패: " + err.message }, 500, origin);
    }
  }

  const data = await proxyToBotDashboard(env, "/captures/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!data) {
    return json({ error: "봇에 연결할 수 없습니다." }, 502, origin);
  }
  return json(data, 200, origin);
}

// "반려 취소" — 이미 내린 결정(반려/반려 (인정))을 되돌려 다시 관리자가
// 판단할 수 있는 "처리 대기" 상태로 되돌린다(사용자 지시: "다시 벌점 및
// 페널티인지 판단할 수 있도록 되돌리려는" 것이 목표). "적용"(대상자 페널티가
// 실제로 기록된 경우)은 이 경로로 취소하지 않는다 — 대상자 페널티는
// cancel-penalty로 명시적으로 되돌려야 하므로, "취소"가 아니라 "반려 취소"
// 버튼에서만 쓰인다. 반려 (인정)으로 제보자에게 이미 부여된 제보상점이
// 있으면(merit) 되돌리기 전에 먼저 회수한다 — 그러지 않으면 판정을
// 다시 하는 동안 이미 부여된 상점이 남아있는 불일치가 생긴다.
export async function handleAdminCaptureRevert(req, env, origin) {
  const admin = await requireAdmin(req, env);
  if (!admin) return json({ error: "관리자만 사용할 수 있습니다." }, 403, origin);

  const body = await req.json().catch(() => ({}));
  const { id, skipMeritLookup } = body;
  if (!id) return json({ error: "id가 필요합니다." }, 400, origin);
  let { merit, sourceFileId } = body;
  // 🔧 [버그 수정] cancel()이 별도로 이미 cancel-merit을 호출해 시트를
  // 되돌린 뒤 상태만 pending으로 되돌리려는 경우, merit을 굳이 안 보냈다고
  // 폴백 조회를 하면 manifest에 아직 남아있는 옛 merit 값을 다시 찾아
  // cancelReportMerit을 중복 호출하게 된다(이미 빈 슬롯을 또 지우거나,
  // 그 사이 다른 제보가 같은 슬롯을 채웠다면 잘못 지울 위험) — 호출자가
  // "직접 이미 처리했다"고 명시하면 폴백을 건너뛴다.
  let timeDeduction = null;
  if (!merit && !skipMeritLookup) {
    ({ merit, timeDeduction, sourceFileId } = await findStoredPenaltyMerit(env, id));
  }
  // 🔧 [사용자 지시] "벌점·상점을 제보 발생 사이클에 기록" — 실제로
  // 상점/시간차감을 쓴 파일에서 회수해야 한다.
  const fileId = sourceFileId || env.GOOGLE_SHEET_FILE_ID;

  if (merit && merit.number && merit.col) {
    try {
      const accessToken = await getServiceAccountAccessToken(env);
      await cancelReportMerit(env, accessToken, fileId, merit.number, merit.col);
      await invalidateMemberCache(env, ["penalty"], fileId); // 제보상점 슬롯이 바뀌었으므로 관련 캐시만 무효화.
      await invalidateMemberSlotCache(env, merit.number, fileId); // 이 회원의 outputPenSlots/reportScore는 KV까지 즉시.
    } catch (err) {
      return json({ error: "제보상점 회수 실패: " + err.message }, 500, origin);
    }
  }
  // 🔧 [유예 취소 시 시간 차감도 되돌림] "유예" 결정에서 별도로 적용된
  // 응답 지연 시간 차감(timeDeduction)이 있으면, 재검토를 위해 되돌릴 때
  // 함께 되돌린다(사용자 지시) — merit과 달리 이 값은 프론트가 로컬
  // state로 들고 있지 않으므로(applied에 없음) 항상 manifest 폴백 조회
  // 결과만 사용한다.
  if (timeDeduction && timeDeduction.number) {
    try {
      const accessToken = await getServiceAccountAccessToken(env);
      await cancelTimeDeduction(
        env,
        accessToken,
        fileId,
        timeDeduction.number,
        timeDeduction.deductedMinutes || 0,
        timeDeduction.dayCol || null
      );
    } catch (err) {
      return json({ error: "시간 차감 회수 실패: " + err.message }, 500, origin);
    }
  }

  const data = await proxyToBotDashboard(env, "/captures/revert", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!data) {
    return json({ error: "봇에 연결할 수 없습니다." }, 502, origin);
  }
  return json(data, 200, origin);
}

// 제보자 본인이 자신이 제출한 제보의 캡처 진행 상황을 확인할 수 있어야 하므로
// requireAdmin이 아니라 일반 로그인 세션만 검증한다(handleStatus와 동일한 인증 수준).
export async function handleReportStatus(req, env, origin, url) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "로그인이 만료되었습니다. 다시 로그인해주세요." }, 401, origin);

  const nickname = url.searchParams.get("nickname") || "";
  if (!nickname) return json({ error: "nickname이 필요합니다." }, 400, origin);

  const data = await proxyToBotDashboard(env, "/report-status?nickname=" + encodeURIComponent(nickname));
  if (!data) {
    return json({ inProgress: false, recentLogs: [] }, 200, origin);
  }
  return json(data, 200, origin);
}
