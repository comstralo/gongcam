import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Users, User, ChevronDown, Hash, Bell, ExternalLink, FlaskConical, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InfoCard, SubRow, TintedPill } from "@/components/dashboard/shared";
import { SectionHeader, AdminListSkeleton, AdminEmptyState } from "@/components/admin/shared";
import { ExitProcessDialog } from "@/components/admin/ExitProcessDialog";
import { ExitedMemberRosterView } from "@/components/admin/ExitedMemberRosterView";
import type { RosterViewHandle, RosterViewState } from "@/components/admin/ExitedMemberRosterView";
import { useApi } from "@/hooks/useApi";
import { usePullRefreshListener } from "@/hooks/usePullToRefresh";
import { useRefreshOnVisible } from "@/hooks/useRefreshOnVisible";
import { usePollingRefresh } from "@/hooks/usePollingRefresh";
import { ICON_STROKE, cn } from "@/lib/utils";
import type {
  AdminMembersRosterResponse,
  DepositRefundBreakdown,
  ExitCheckItem,
  ExitKind,
  ExitPreviewResponse,
  MemberRosterEntry,
  NotifyCategory,
  SetPartiStatusResponse,
} from "@/lib/api/types";

// 🧪 [목업 미리보기] "새로고침" 버튼 옆의 실험용 버튼 — 실제 API 호출 없이
// 이 화면이 다룰 수 있는 상태(스터디장/부스터디장/스터디원, 퇴실 예약
// 유무, 알림 설정 ON/OFF, 시트 gid 유무)를 한 번에 눈으로 점검하기 위한
// 것이다(사용자 지시). 실제 /admin/members/roster 응답과 동일한 타입을
// 그대로 써서 화면 코드는 손대지 않는다.
const DUMMY_NOTIFY_CATEGORIES: Record<NotifyCategory, string> = {
  report_result: "제보 처리 결과",
  leave_proof_result: "사유 반휴 처리 결과",
  fine_status: "벌금 상태 변경",
  exit_result: "퇴실/재납 처리 결과",
  direct_message: "다른 참여자의 알림(귓속말)",
};
const DUMMY_MEMBERS: MemberRosterEntry[] = [
  // 1) 기본 케이스: 스터디장, 활발히 접속 중, 알림 전부 ON, 시트 링크 정상.
  {
    number: "1",
    name: "재희",
    joinDate: "2026-01-05",
    totalPenalty: 0,
    suggestedKind: "settle",
    reasons: [],
    exitRequested: false,
    exitRequestDate: null,
    exitRequestedAt: null,
    exitAgreedAt: null,
    partiStatus: "스터디장",
    pushSubscribed: true,
    notifyPrefs: {
      report_result: true,
      leave_proof_result: true,
      fine_status: true,
      exit_result: true,
      direct_message: true,
    },
    googleAccount: "hui.jae@gmail.com",
    gooroomeeAccount: "hui.jae@gmail.com",
    examKind: "공시",
    goalType: "10H (교시제)",
    lastLoginAt: Date.now() - 1000 * 60 * 40,
    lastLoginIp: "121.128.55.10",
    sheetGid: 123456789,
  },
  // 2) 부스터디장, 퇴실 신청은 했지만 아직 동의 전(exitAgreedAt=null) — 신청
  //    취소 버튼이 노출되는 케이스. 알림 설정도 절반만 ON으로 섞는다.
  {
    number: "2",
    name: "서준",
    joinDate: "2026-02-14",
    totalPenalty: 1,
    suggestedKind: "settle",
    reasons: [],
    exitRequested: true,
    exitRequestDate: "2026-09-25",
    exitRequestedAt: Date.now() - 1000 * 60 * 60 * 24 * 2,
    exitAgreedAt: null,
    partiStatus: "부스터디장",
    pushSubscribed: true,
    notifyPrefs: {
      report_result: true,
      leave_proof_result: false,
      fine_status: true,
      exit_result: false,
      direct_message: true,
    },
    googleAccount: "seojun.dev@gmail.com",
    gooroomeeAccount: "seojun.dev@gmail.com",
    examKind: "CPA",
    goalType: "9H (달성제)",
    lastLoginAt: Date.now() - 1000 * 60 * 60 * 5,
    lastLoginIp: "58.234.11.202",
    sheetGid: 234567890,
  },
  // 3) 스터디원, 페널티 누적(강제퇴실 후보), 구루미 계정 미기재, PUSH 구독
  //    자체가 꺼져 있어 notifyPrefs 원본이 ON이어도 화면은 전부 OFF로
  //    보여야 하는 케이스(코드 주석의 "PUSH 구독 OFF 시 세부 항목도 OFF").
  {
    number: "3",
    name: "아름",
    joinDate: "2026-03-02",
    totalPenalty: 2,
    suggestedKind: "forced",
    reasons: [],
    exitRequested: false,
    exitRequestDate: null,
    exitRequestedAt: null,
    exitAgreedAt: null,
    partiStatus: "스터디원",
    pushSubscribed: false,
    notifyPrefs: {
      report_result: true,
      leave_proof_result: true,
      fine_status: true,
      exit_result: true,
      direct_message: true,
    },
    googleAccount: "areum.study@gmail.com",
    gooroomeeAccount: "",
    examKind: "",
    goalType: "8H (교시제)",
    lastLoginAt: Date.now() - 1000 * 60 * 60 * 24 * 9,
    lastLoginIp: "211.36.140.7",
    sheetGid: 345678901,
  },
  // 4) 스터디원, 퇴실 신청 + 동의까지 완료(exitAgreedAt 있음) — "정산 퇴실"
  //    버튼이 실제로 활성화되는 유일한 조합. 한 번도 로그인한 적 없어
  //    lastLoginAt/lastLoginIp가 전부 null/빈 값인 케이스도 겸한다.
  {
    number: "4",
    name: "지민",
    joinDate: "2026-04-20",
    totalPenalty: 0,
    suggestedKind: "settle",
    reasons: [],
    exitRequested: true,
    exitRequestDate: "2026-09-21",
    exitRequestedAt: Date.now() - 1000 * 60 * 60 * 24 * 5,
    exitAgreedAt: Date.now() - 1000 * 60 * 60 * 3,
    partiStatus: "스터디원",
    pushSubscribed: true,
    notifyPrefs: {
      report_result: false,
      leave_proof_result: false,
      fine_status: false,
      exit_result: true,
      direct_message: false,
    },
    googleAccount: "jimin.cam@gmail.com",
    gooroomeeAccount: "jimin.cam@gmail.com",
    examKind: "공무원",
    goalType: "10H (달성제)",
    lastLoginAt: null,
    lastLoginIp: "",
    sheetGid: 456789012,
  },
  // 5) 스터디원, 시트 gid를 찾지 못한 엣지 케이스(sheetGid=null이지만
  //    spreadsheetId는 있는 상태 — 시트번호가 링크 없이 일반 텍스트로
  //    표시돼야 함), 알림 설정 전부 OFF, 최근 접속 IP는 있지만 준비 중인
  //    시험은 미기재.
  {
    number: "5",
    name: "도윤",
    joinDate: "2026-05-11",
    totalPenalty: 0,
    suggestedKind: "settle",
    reasons: [],
    exitRequested: false,
    exitRequestDate: null,
    exitRequestedAt: null,
    exitAgreedAt: null,
    partiStatus: "스터디원",
    pushSubscribed: true,
    notifyPrefs: {
      report_result: false,
      leave_proof_result: false,
      fine_status: false,
      exit_result: false,
      direct_message: false,
    },
    googleAccount: "doyun.p@gmail.com",
    gooroomeeAccount: "doyun.p@gmail.com",
    examKind: "",
    goalType: "9H (교시제)",
    lastLoginAt: Date.now() - 1000 * 60 * 5,
    lastLoginIp: "112.170.88.44",
    sheetGid: null,
  },
];

// 🧪 [목업 미리보기 전용] 회원별로 서로 다른 예치금 반환 계산 재료
// (frame-checker-worker/src/deposit.js의 depositBreakdown과 동일한 형태)
// 를 심어, "직권 P 퇴실"/"정산 퇴실" 다이얼로그를 열었을 때 각 분기가
// 실제로 어떤 값을 보여주는지 회원마다 다르게 확인할 수 있게 한다.
const DUMMY_BREAKDOWNS: Record<string, DepositRefundBreakdown> = {
  // 재희: 페널티 0회, 지연 없음 — 정산 퇴실 시 100% 반환(가장 무난한 케이스).
  "1": {
    amount: 0,
    reason: null,
    outputPen: 0,
    timePen: 0,
    daysSinceJoin: 256,
    fineUnpaid: false,
    fineUnpaidDays: [],
    depositAgainStatus: null,
    lateNotice: false,
  },
  // 서준: 페널티 1회 — 정산 퇴실 시 50% 반환.
  "2": {
    amount: 5000,
    reason: "페널티 1회",
    outputPen: 1,
    timePen: 0,
    daysSinceJoin: 216,
    fineUnpaid: false,
    fineUnpaidDays: [],
    depositAgainStatus: null,
    lateNotice: false,
  },
  // 아름: 페널티 2회 이상 — 강제퇴실 조건 충족(0% 반환, "직권 P 퇴실"에서도
  // 동일하게 discountRatio=1이지만 "정산 퇴실" 미리보기에서 페널티 100%
  // 차감으로 나타나는 차이를 확인할 수 있다).
  "3": {
    amount: 0,
    reason: "페널티 2회 이상",
    outputPen: 1,
    timePen: 1,
    daysSinceJoin: 197,
    fineUnpaid: false,
    fineUnpaidDays: [],
    depositAgainStatus: null,
    lateNotice: false,
  },
  // 지민: 페널티 0회지만 퇴실 통보 지연 — 정산 퇴실 시 50% 반환(지연만으로
  // 차감되는 케이스, 페널티 케이스와 사유가 다름을 비교할 수 있다).
  "4": {
    amount: 5000,
    reason: "퇴실 통보 지연",
    outputPen: 0,
    timePen: 0,
    daysSinceJoin: 151,
    fineUnpaid: false,
    fineUnpaidDays: [],
    depositAgainStatus: null,
    lateNotice: true,
  },
  // 도윤: 벌금 미납 + 가입 30일 미만 — 강제퇴실 조건 2개가 동시에 걸리는
  // 케이스(차감 원인 카드에 두 항목이 함께 100%로 표시됨).
  "5": {
    amount: 0,
    reason: "벌금 미납",
    outputPen: 0,
    timePen: 0,
    daysSinceJoin: 12,
    fineUnpaid: true,
    fineUnpaidDays: ["화", "목"],
    depositAgainStatus: null,
    lateNotice: false,
  },
};

const EXIT_DEPOSIT_VALUE = 10000;

// frame-checker-worker/src/deposit.js의 forcedExitChecks와 동일한 4개
// 조건 판정 — allChecks(체크리스트 전체)를 만드는 데 쓴다.
function mockForcedExitChecks(b: DepositRefundBreakdown): ExitCheckItem[] {
  const totalPen = b.outputPen + b.timePen;
  return [
    { code: "under_30_days", label: "가입 30일 미만", met: b.daysSinceJoin >= 0 && b.daysSinceJoin < 30 },
    { code: "fine_unpaid", label: "벌금 시한 내 미납", met: b.fineUnpaid },
    { code: "deposit_again_unpaid", label: "예치금 시한 내 미납", met: b.depositAgainStatus === "미납" },
    {
      code: "penalty_2_or_more",
      label: `페널티 누적 2회 이상 (송출 P ${b.outputPen}회 / 주간 P ${b.timePen}회)`,
      met: totalPen >= 2,
    },
  ];
}

// frame-checker-worker/src/deposit.js의 calcExitProcess(+ calcForcedOutDeposit/
// calcAdminForcedExit/calcSettleReturnDeposit)를 그대로 미러링한 순수 함수 —
// 서버를 타지 않고 목업 breakdown만으로 동일한 결과 구조를 계산한다.
function buildMockExitPreview(member: MemberRosterEntry, kind: ExitKind, forcedReason: string): ExitPreviewResponse {
  const breakdown = DUMMY_BREAKDOWNS[member.number] ?? DUMMY_BREAKDOWNS["1"];
  const allChecks = mockForcedExitChecks(breakdown);

  let discountRatio: number;
  let resultStr: string[];
  let reasons: { code: string; label: string }[];

  if (kind === "admin_forced") {
    const reasonLabel = forcedReason || "(사유 미입력)";
    discountRatio = 1;
    resultStr = [`즉시 직권퇴실자 (사유 : ${reasonLabel}) ➡️ 0% 반환`];
    reasons = [{ code: "admin_reason", label: `직권 사유: ${reasonLabel}` }];
  } else {
    // settle(정산 퇴실) — 강제퇴실 조건 충족 여부와 무관하게, 이 다이얼로그는
    // 항상 settle 계산식(페널티/지연 기준 0·50·100%)만 보여준다 — 실제
    // handleAdminExitConfirm도 lockKind로 고정된 kind만 계산하기 때문.
    const totalPen = breakdown.outputPen + breakdown.timePen;
    const lateNotice = !!breakdown.lateNotice;
    discountRatio = totalPen === 0 ? (lateNotice ? 0.5 : 0) : lateNotice ? 1 : 0.5;
    const returnPct = Math.round((1 - discountRatio) * 100);
    resultStr = [
      `송출 P (${breakdown.outputPen}회) / 주간 P (${breakdown.timePen}회)` +
        (lateNotice ? " + 퇴실 통보 지연" : "") +
        ` ➡️ ${returnPct}% 반환`,
    ];
    reasons = [{ code: "settle_return_rate", label: `${returnPct}% 반환` }];
  }

  const heldAmount = EXIT_DEPOSIT_VALUE * discountRatio;
  const refundAmount = EXIT_DEPOSIT_VALUE - heldAmount;
  const fineAlreadyPayment = 0;
  const fineOuter = 128000;
  const depositOuter = 640000;
  const processedDate = new Date().toISOString().slice(0, 10);

  return {
    ok: true,
    discountRatio,
    resultStr,
    reasons,
    allChecks,
    resultMsg:
      `🧑 이름 : ${member.name}\n📝 유형 : ${kind === "admin_forced" ? "강제 퇴실자" : "정산 퇴실자"}\n` +
      `📝 원인 : \n${resultStr.map((s, i) => `${String.fromCharCode(9312 + i)} ${s}`).join("\n")}\n` +
      `💰 귀속예치 : ₩${heldAmount.toLocaleString()}\n💰 반환예치 : ₩${refundAmount.toLocaleString()}`,
    newFineOuter: fineOuter,
    newDepositOuter: depositOuter + heldAmount,
    kindStr: kind === "admin_forced" ? "강제 퇴실자" : "정산 퇴실자",
    name: member.name,
    heldAmount,
    refundAmount,
    fineAlreadyPayment,
    processedDate,
    fineOuter,
    depositOuter,
    breakdown,
    exitProcess: member.exitRequested
      ? {
          requestedAt: member.exitRequestedAt,
          exitDate: member.exitRequestDate,
          agreedAt: member.exitAgreedAt,
        }
      : null,
    fromBackup: false,
  };
}

// 🔧 [사용자 지시] "'참여 스터디원 목록'과 '퇴실 스터디원 목록'을 합칠거야"
// — 참여자 뷰 본문. 셸(MemberRosterList)이 SectionHeader/드롭다운/목업
// 버튼을 소유하고, 이 컴포넌트는 그 아래 실제 목록(검색창~카드 목록)만
// 렌더링한다. load는 ref(RosterViewHandle)로 셸에 노출해 새로고침 버튼이
// 호출할 수 있게 하고, loading/refreshProgress는 onStateChange 콜백으로
// 셸의 state에 반영한다(ref로 노출하면 값이 바뀌어도 부모가 리렌더되지
// 않아 헤더가 낡은 값을 보여줄 수 있다).
const ActiveMemberRosterView = forwardRef<
  RosterViewHandle,
  { visible: boolean; showingDummy: boolean; onStateChange: (state: RosterViewState) => void }
>(function ActiveMemberRosterView({ visible, showingDummy, onStateChange }, ref) {
  const { call } = useApi();

  const [members, setMembers] = useState<MemberRosterEntry[] | null>(null);
  // 카테고리 키("report_result" 등)를 사람이 읽을 라벨("제보 처리 결과")로
  // 바꾸는 데 쓴다 — 서버가 roster 응답과 함께 내려준다(/notify-prefs와
  // 동일한 카테고리 정의를 그대로 재사용).
  const [notifyCategories, setNotifyCategories] = useState<Record<string, string> | null>(null);
  // 시트번호를 눌렀을 때 그 회원 탭으로 바로 이동하는 링크를 만드는 데 쓴다.
  const [spreadsheetId, setSpreadsheetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedNumber, setExpandedNumber] = useState<string | null>(null);
  const [cancelingNumber, setCancelingNumber] = useState<string | null>(null);
  const [togglingNumber, setTogglingNumber] = useState<string | null>(null);
  // 🔧 [사용자 지시] "퇴실 스터디원 목록"과 동일한 이름 검색 —
  // ExitedMemberRosterView와 같은 패턴(대소문자 무시, 부분 일치)을 재사용한다.
  const [query, setQuery] = useState("");
  // 탭 복귀/당겨서 새로고침/폴링이 겹쳐 load()가 중복 호출되는 걸 막는
  // 가드 — loading state는 비동기라 ref로 즉시 확인한다.
  const loadingRef = useRef(false);
  // showingDummy는 이제 셸(MemberRosterList)이 소유한다 — 이전엔 이
  // 컴포넌트 안에서 직접 뒤집던 state를 prop으로 받고, 그 변화를 감지해
  // 목업 주입/실 데이터 재조회를 수행한다. 최초 마운트 시(showingDummy가
  // 처음부터 false)까지 "꺼지는 전환"으로 오인해 불필요한 강제 재조회가
  // 한 번 더 일어나지 않도록 이전 값을 추적한다.
  const wasDummyRef = useRef(false);

  // force: 목업 미리보기를 끄는 시점처럼, 아직 state에 반영되지 않은
  // showingDummy=true를 무시하고 강제로 실제 목록을 불러올 때 쓴다 —
  // setState 직후 같은 틱에서 부르는 클로저는 이전 렌더의 showingDummy
  // 값을 참조하므로 가드만으로는 막을 수 없다.
  // useCallback으로 안정화 — useImperativeHandle이 이 함수를 deps로
  // 참조하는데, 매 렌더 새 함수면 handle도 매번 새로 만들어진다(무해하지만
  // 불필요한 재실행 경고를 유발한다).
  const load = useCallback(
    (force = false) => {
      // 🧪 목업 미리보기 중에는 자동 새로고침/폴링이 실제 데이터로
      // 덮어쓰지 않도록 막는다.
      if ((showingDummy && !force) || loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      setError(null);
      call<AdminMembersRosterResponse>("/admin/members/roster")
        .then((data) => {
          setMembers(data.members || []);
          setNotifyCategories(data.notifyCategories || null);
          setSpreadsheetId(data.spreadsheetId || null);
        })
        .catch((err) => setError(err instanceof Error ? err.message : "스터디원 목록을 불러오지 못했습니다."))
        .finally(() => {
          loadingRef.current = false;
          setLoading(false);
        });
    },
    [call, showingDummy]
  );

  useEffect(() => {
    if (showingDummy) {
      setError(null);
      setExpandedNumber(null);
      setMembers(DUMMY_MEMBERS);
      setNotifyCategories(DUMMY_NOTIFY_CATEGORIES);
      // 실제로 존재하지 않는 시트를 가리키는 가짜 링크를 만들지 않도록
      // spreadsheetId는 비워둔다 — 컴포넌트의 기존 분기(spreadsheetId가
      // 없으면 시트번호를 일반 텍스트로만 표시)가 그대로 적용된다.
      setSpreadsheetId(null);
    } else if (wasDummyRef.current) {
      load(true);
    }
    wasDummyRef.current = showingDummy;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showingDummy]);

  function cancelExitRequest(number: string) {
    // 🧪 목업 미리보기 중에는 실제 회원이 아니므로 API를 호출하지 않는다.
    if (showingDummy) {
      setError("목업 미리보기 중입니다 — 실제 데이터에는 영향을 주지 않습니다.");
      return;
    }
    setCancelingNumber(number);
    setError(null);
    call<{ ok: boolean }>("/exit-request/cancel", { method: "POST", body: { number } })
      .then(() => load())
      .catch((err) => setError(err instanceof Error ? err.message : "퇴실 신청 취소에 실패했습니다."))
      .finally(() => setCancelingNumber(null));
  }

  function toggleViceLeader(m: MemberRosterEntry) {
    // 🧪 목업 미리보기 중에는 실제 회원이 아니므로 API를 호출하지 않는다.
    if (showingDummy) {
      setError("목업 미리보기 중입니다 — 실제 데이터에는 영향을 주지 않습니다.");
      return;
    }
    setTogglingNumber(m.number);
    setError(null);
    call<SetPartiStatusResponse>("/admin/members/parti-status", {
      method: "POST",
      body: { number: m.number, appoint: m.partiStatus !== "부스터디장" },
    })
      .then(() => load())
      .catch((err) => setError(err instanceof Error ? err.message : "부스터디장 임명/해제에 실패했습니다."))
      .finally(() => setTogglingNumber(null));
  }

  useEffect(() => load(), []); // eslint-disable-line react-hooks/exhaustive-deps
  usePullRefreshListener(true, () => load());
  // 이 뷰로 돌아올 때마다 다시 불러오고(신규등록/퇴실/번호이동은 다른
  // 화면에서 처리되므로), 계속 띄워둔 채로도 관련 캐시의 3배 이상 주기로
  // 폴링해 자동 갱신되게 한다.
  // 🔧 [사용자 지시] "봇 상태를 제외하곤 모두 폴링 주기 20분으로 맞춰" —
  // 관리자 탭 간 폴링 주기를 20분으로 통일. 직전엔 dataSheetRows:/meta:
  // (10분)의 3배 원칙(docs/CACHING_POLICY.md §12.1)을 맞추려 30분이었는데,
  // 이번 통일 지시로 배율이 2배로 낮아진다 — 그만큼 캐시 미스(재계산)
  // 빈도가 약간 늘 수 있음을 감안한 결정.
  useRefreshOnVisible(visible, load);
  const refreshProgress = usePollingRefresh(visible, load, 20 * 60_000);

  // load는 매 렌더 새로 만들어지는 클로저(showingDummy를 참조)라 deps에서
  // 빼면 셸이 오래된 showingDummy 값을 참조하는 handle을 들고 있게 될 수
  // 있다 — load도 deps에 포함해 항상 최신 클로저를 노출한다.
  useImperativeHandle(ref, () => ({ load }), [load]);

  // 🔧 [버그 방지] ref(useImperativeHandle)로 loading/refreshProgress를
  // 그대로 노출하면, 이 값이 바뀌어도(자식 리렌더) 부모(셸)는 리렌더되지
  // 않아 헤더의 로딩 스피너·새로고침 게이지가 낡은 값에 머무를 수 있다 —
  // 콜백으로 부모의 state에 반영해 정상적으로 리렌더를 트리거한다.
  useEffect(() => {
    onStateChange({ loading, refreshProgress });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, refreshProgress]);

  const filteredMembers = useMemo(() => {
    if (!members) return members;
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return members;
    return members.filter((m) => m.name.toLowerCase().includes(trimmed));
  }, [members, query]);

  return (
    <>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* 🔧 [사용자 지시] "퇴실 스터디원 목록"과 동일한 이름 검색 UI —
          ExitedMemberRosterView §검색창과 동일한 마크업(위치/아이콘/placeholder
          스타일)을 그대로 재사용한다. */}
      {members && members.length > 0 && (
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground sm:size-4"
            strokeWidth={ICON_STROKE.default}
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="이름으로 검색"
            className="pl-9 sm:h-11 sm:pl-10 sm:text-base"
          />
        </div>
      )}

      {/* 🔧 [버그 수정, 2026-09] ReasonLeaveReviewList와 동일한 근본
          수정 — 세 조건이 loading에 게이팅돼 있어 재조회 시작 직후
          (loading=true, members=[]) 전부 거짓이 되는 진짜 공백이
          있었다(Playwright 실측, ~1초 지속). loading을 빼고 members의
          실제 값만으로 렌더링해 재조회 중엔 이전 화면이 그대로
          유지되게 한다. */}
      {!members && <AdminListSkeleton />}

      {members && members.length === 0 && <AdminEmptyState>등록된 스터디원이 없습니다.</AdminEmptyState>}

      {!loading && members && members.length > 0 && filteredMembers && filteredMembers.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">
          "{query}"와 일치하는 스터디원이 없습니다.
        </p>
      )}

      {filteredMembers && filteredMembers.length > 0 && (
        <div className="flex flex-col gap-2 sm:gap-2.5">
          {filteredMembers.map((m) => {
            const isExpanded = expandedNumber === m.number;
            return (
              // 🔧 [사용자 지시] "제보 쪽 토글의 전환 애니메이션처럼 부드럽게"
              // — MyOutputPenSection에 적용한 base-ui Collapsible(높이
              // 전환)을 여기도 적용해 펼침이 즉시 나타나지 않고 부드럽게
              // 펼쳐지도록 한다.
              <Collapsible key={m.number} open={isExpanded} onOpenChange={(open) => setExpandedNumber(open ? m.number : null)}>
              {/* 🔧 [사용자 지시] "퇴실예약" 뱃지를 단 회원의 카드(토글
                  박스)에 은은한 amber 글로우를 얹어 목록에서 한눈에
                  띄게 한다 — 위 뱃지와 같은 톤(amber)을 그대로 쓴다. */}
              <InfoCard className={cn("flex flex-col gap-2.5 bg-card", m.exitRequested && "animate-exit-requested-glow")}>
                <CollapsibleTrigger className="flex items-center justify-between gap-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded" hideChevron>
                  <span className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base">
                    <User className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                    {m.name}
                  </span>
                  <span className="flex items-center gap-1.5">
                    {/* 🔧 [사용자 지시] "'화각 불량 제보'에서 설정한 디자인을 기준으로
                        비슷한 모양의 다른 화면에도 적용" — 패딩 오버라이드(px-2 py-1
                        leading-none)를 없애 TintedPill 기본 크기로 통일한다. 이전엔
                        바로 옆 "퇴실 예약" 뱃지와 미묘하게 크기가 달랐다.
                        🔧 [사용자 지시] 참여상태 3종을 색으로 바로 구분되게:
                        스터디장=보라(purple), 부스터디장=파랑(blue),
                        스터디원=초록(ok). */}
                    <TintedPill
                      tone={m.partiStatus === "스터디장" ? "purple" : m.partiStatus === "부스터디장" ? "blue" : "ok"}
                    >
                      {m.partiStatus}
                    </TintedPill>
                    {m.exitRequested && <TintedPill tone="amber">퇴실 예약</TintedPill>}
                    <ChevronDown
                      className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isExpanded && "rotate-180")}
                      strokeWidth={ICON_STROKE.default}
                    />
                  </span>
                </CollapsibleTrigger>

                <CollapsiblePanel className="flex flex-col">
                  <div className="flex flex-col gap-2.5 pt-2.5">
                    <div className="flex flex-col gap-1.5 rounded-xl border bg-card p-4 sm:p-5">
                      <span className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base">
                        <Hash className="size-3.5 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                        상태 정보
                      </span>
                      {/* 🔧 [사용자 지시] "현재 페이지(관리자)의 위계도
                          맞춰줘" — SubRow 기본 크기(text-micro-lg
                          sm:text-xs)가 제보 화면 기준(text-xs sm:text-sm)
                          보다 한 단계 작았다. 호출부마다
                          labelClassName/valueClassName을 개별 지정하는
                          대신, SubRow만 감싸는 컨테이너에 자손 선택자로
                          한 번에 적용한다 — valueClassName으로 이미 색만
                          지정된 곳(퇴실 예약일자 등)과도 충돌 없이
                          합쳐진다. */}
                      <div className="flex flex-col gap-1.5 [&_span]:text-xs [&_span]:sm:text-sm">
                        <SubRow label="준비 시험" value={m.examKind || "-"} />
                        <SubRow label="구글 계정" value={m.googleAccount || "-"} />
                        <SubRow label="구루미 계정" value={m.gooroomeeAccount || "-"} />
                        {/* 🔧 [사용자 지시] "'시트번호' 위에 '대시보드'를
                            만들고 해당 유저의 대시보드를 확인할 수 있는
                            링크" — StatusPage의 관리자용 회원 선택
                            드롭다운을 `?member=<번호>` 쿼리로 초기 선택되게
                            해뒀다(StatusPage.tsx 참고). 로그인 세션이
                            "한 번만"(sessionStorage) 모드면 새 탭에는
                            세션이 없어 로그인 화면으로 튕기므로, 새 탭이
                            아니라 같은 탭에서 대시보드 홈("/")으로
                            이동한다 — 목업 미리보기 중인 더미 회원은 실제
                            회원번호가 아니므로(showingDummy) 링크를 걸지
                            않는다. */}
                        {/* 🔧 [사용자 지시] "퇴실자 쪽 출력 형태로 일치시켜줘"
                            — 값 텍스트를 "바로가기"로, 아이콘을 시트번호와
                            동일한 ExternalLink로 통일한다(ExitedMemberRosterView
                            참고). showingDummy 분기(더미 회원은 링크를 걸지
                            않음)는 참여자 뷰 고유의 안전장치라 그대로 둔다. */}
                        <SubRow
                          label="대시보드"
                          value={
                            showingDummy ? (
                              "-"
                            ) : (
                              <a
                                href={`#/?member=${encodeURIComponent(m.number)}`}
                                className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
                              >
                                바로가기
                                <ExternalLink className="size-3 shrink-0" strokeWidth={ICON_STROKE.default} />
                              </a>
                            )
                          }
                        />
                        <SubRow
                          label="시트 번호"
                          value={
                            spreadsheetId && m.sheetGid !== null ? (
                              <a
                                href={`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${m.sheetGid}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
                              >
                                바로가기
                                <ExternalLink className="size-3 shrink-0" strokeWidth={ICON_STROKE.default} />
                              </a>
                            ) : (
                              "-"
                            )
                          }
                        />
                        <SubRow
                          label="최근 접속 일자"
                          value={m.lastLoginAt ? new Date(m.lastLoginAt).toLocaleString("ko-KR", { hour12: false }) : "-"}
                        />
                        <SubRow label="최근 접속 IP" value={m.lastLoginIp || "-"} />
                        <SubRow
                          label="퇴실 예약 일자"
                          value={m.exitRequested ? (m.exitRequestDate ? m.exitRequestDate : "접수됨") : "-"}
                        />
                      </div>
                    </div>

                    {/* 🔧 [관리자용 알림 설정 열람] 조회 전용 — 실제 변경은
                        회원 본인만 자기 대시보드의 알림 설정에서 할 수 있다. */}
                    <div className="flex flex-col gap-1.5 rounded-xl border bg-card p-4 sm:p-5">
                      <span className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base">
                        <Bell className="size-3.5 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                        알림 설정
                      </span>
                      {/* 🔧 [PUSH 구독 OFF 시 세부 항목도 OFF로 표시] PUSH
                          구독은 알림 수신의 최상위 조건이다 — 꺼져 있으면
                          카테고리별 설정이 ON이어도 실제로는 아무 알림도
                          못 받는다. 저장된 원본값을 그대로 보여주면 "구독은
                          꺼졌는데 세부 항목은 죄다 ON"으로 보여 혼란을
                          줬다(사용자 지적) — PUSH 구독 행 자체는 없애고,
                          구독이 꺼진 회원은 세부 항목을 실제 저장값과
                          무관하게 전부 OFF로 보여준다. */}
                      <div className="flex flex-col gap-1.5 [&_span]:text-xs [&_span]:sm:text-sm">
                        {notifyCategories &&
                          Object.entries(notifyCategories).map(([key, label]) => {
                            const enabled = m.pushSubscribed && m.notifyPrefs[key as NotifyCategory];
                            return (
                              <SubRow
                                key={key}
                                label={label}
                                value={enabled ? "ON" : "OFF"}
                                valueClassName={enabled ? "text-ok" : "text-muted-foreground"}
                              />
                            );
                          })}
                      </div>
                    </div>

                    {/* 🔧 [퇴실 처리 버튼 분리] "스터디원 목록"은 자진 퇴실
                        전용 화면이다 — 페널티 누적으로 인한 강제퇴실/예치금
                        재납은 "페널티 대상자" 화면에서 별도로 처리하므로
                        여기서는 유형을 직접 고를 필요가 없다(오히려 관리자가
                        같은 회원에게 kind만 다르게 골라 반환율이 달라지는
                        걸 방지하기 위함, 사용자 지적: "무조건 계산은 어디서나
                        일치해야 해"). "직권 P"(admin_forced, 즉시 0% 반환)와
                        "정산"(settle, 페널티 0/1회 기준 100%/50% 반환) 두
                        가지로 고정한다. 정산은 회원이 실제로 퇴실 신청(예약)
                        했을 뿐 아니라, 마지막 참여일이 지난 뒤 "예치금
                        정산액에 동의합니다"까지 눌러야만 누를 수 있다 —
                        신청만으로 관리자가 바로 확정 처리할 수 있으면 회원이
                        실제 반환액을 확인하기도 전에 처리가 끝나버릴 수
                        있다(사용자 지시로 동의 단계 추가). */}
                    <div className={cn("grid gap-2", m.exitRequested ? "grid-cols-4" : "grid-cols-3")}>
                      <Button
                        variant="outline"
                        className="w-full sm:h-12 sm:text-base"
                        disabled={showingDummy || m.partiStatus === "스터디장" || togglingNumber === m.number}
                        onClick={() => toggleViceLeader(m)}
                      >
                        {m.partiStatus === "부스터디장" ? "임명 해제" : "부스터디장 임명"}
                      </Button>
                      <ExitProcessDialog
                        candidate={m}
                        lockKind="admin_forced"
                        onConfirmed={() => load()}
                        triggerClassName="w-full"
                        mockPreview={showingDummy ? (kind, reason) => buildMockExitPreview(m, kind, reason) : undefined}
                      >
                        <Button variant="destructive" className="w-full sm:h-12 sm:text-base">
                          직권 P 퇴실
                        </Button>
                      </ExitProcessDialog>
                      <ExitProcessDialog
                        candidate={m}
                        lockKind="settle"
                        onConfirmed={() => load()}
                        triggerClassName="w-full"
                        mockPreview={showingDummy ? (kind, reason) => buildMockExitPreview(m, kind, reason) : undefined}
                      >
                        <Button
                          variant="destructive"
                          className="w-full sm:h-12 sm:text-base"
                        >
                          정산 퇴실
                        </Button>
                      </ExitProcessDialog>
                      {m.exitRequested && (
                        <Button
                          variant="outline"
                          className="w-full sm:h-12 sm:text-base"
                          disabled={showingDummy || cancelingNumber === m.number}
                          onClick={() => cancelExitRequest(m.number)}
                        >
                          신청 취소
                        </Button>
                      )}
                    </div>
                  </div>
                </CollapsiblePanel>
              </InfoCard>
              </Collapsible>
            );
          })}
        </div>
      )}
    </>
  );
});

// 🔧 [사용자 지시] "'참여 스터디원 목록'을 '스터디원 목록'으로 바꾸고,
// 목업 버튼 좌측에 드롭다운으로 '참여자'/'퇴실자'를 눌러서 토글" — 이
// 컴포넌트가 뷰 전환 셸이 된다. SectionHeader/Collapsible/뷰 전환
// 드롭다운/목업 토글 버튼은 여기서 한 번만 렌더링하고, 그 아래 본문은
// view에 따라 ActiveMemberRosterView(참여자) 또는
// ExitedMemberRosterView(퇴실자)로 갈아끼운다. 두 뷰는 언마운트하지
// 않고 hidden으로만 숨긴다(DashboardPage의 everOpened+hidden 패턴과
// 동일) — 전환해도 검색어/펼침 상태/목업 여부가 각자 그대로 유지된다.
export function MemberRosterList({ visible = true }: { visible?: boolean }) {
  const [view, setView] = useState<"active" | "exited">("active");
  // 🧪 [목업 미리보기] 🔧 [사용자 지시] "목업 토글 버튼을 누르면 퇴실자,
  // 참여자 모두 목업 상태로 들어가도록" — 이전엔 뷰마다 독립된 토글이라
  // 참여자에서 켜도 퇴실자는 실제 데이터 그대로 보였다(개별 작동). 이제
  // 하나의 state를 두 뷰가 공유해, 버튼 하나로 두 뷰 모두 동시에
  // 목업/실데이터 상태가 맞춰진다 — 아직 마운트 안 된 뷰(퇴실자를 한 번도
  // 안 본 경우)도 이 state를 prop으로 그대로 받으므로, 나중에 처음
  // 마운트될 때부터 바로 목업 상태로 시작한다.
  const [dummy, setDummy] = useState(false);
  // 각 뷰가 onStateChange 콜백으로 알려주는 loading/refreshProgress를
  // 셸의 state로 들고 있는다 — ref로 직접 읽으면 자식이 바뀌어도 부모가
  // 리렌더되지 않아 헤더가 낡은 값을 계속 보여줄 수 있다.
  const [activeState, setActiveState] = useState<RosterViewState>({ loading: true });
  const [exitedState, setExitedState] = useState<RosterViewState>({ loading: true });
  // 처음 선택된 뷰(active)만 우선 마운트하고, 퇴실자 뷰는 한 번이라도
  // 선택된 뒤에야 마운트한다 — 그래야 앱 진입 시 퇴실자 API를 불필요하게
  // 먼저 호출하지 않는다(DashboardPage의 everOpened 패턴과 동일 원리).
  const everOpened = useRef<Record<"active" | "exited", boolean>>({ active: true, exited: false });
  everOpened.current[view] = true;

  const activeRef = useRef<RosterViewHandle>(null);
  const exitedRef = useRef<RosterViewHandle>(null);
  const currentState = view === "active" ? activeState : exitedState;

  function toggleDummy() {
    setDummy((v) => !v);
  }

  return (
    <Collapsible defaultOpen className="flex flex-col">
      <SectionHeader
        icon={Users}
        title="스터디원 목록"
        loading={currentState.loading}
        onRefresh={() => (view === "active" ? activeRef.current : exitedRef.current)?.load()}
        // 퇴실자 뷰는 폴링이 없어 게이지 자체가 의미 없다 — undefined면
        // SectionHeader가 게이지를 그리지 않는다.
        refreshProgress={currentState.refreshProgress}
        trailing={
          <div className="flex items-center gap-1.5">
            {/* 🔧 [사용자 지시] "목업 버튼 좌측에 드롭다운으로 '참여자'/
                '퇴실자'를 눌러서 토글되도록, 기본은 참여자" */}
            <Select value={view} onValueChange={(v) => v && setView(v as "active" | "exited")}>
              <SelectTrigger className="w-fit shrink-0 bg-card data-[size=default]:h-7 sm:text-sm">
                <SelectValue>{view === "active" ? "참여자" : "퇴실자"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active" className="sm:text-base">
                  참여자
                </SelectItem>
                <SelectItem value="exited" className="sm:text-base">
                  퇴실자
                </SelectItem>
              </SelectContent>
            </Select>
            {/* 🔧 [사용자 지시] "토글 눌림 상태를 좀 더 확실하게 — 눌렸을
                땐 버튼을 초록색으로" — outline 기반에 ok 톤(bg-ok/text-ok,
                다른 관리자 화면의 "완료" 뱃지 등과 동일한 색 관례)을
                덧씌운다. */}
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className={cn(
                "shrink-0",
                dummy && "border-ok/30 bg-ok/15 text-ok hover:bg-ok/25 dark:hover:bg-ok/25"
              )}
              onClick={toggleDummy}
              aria-pressed={dummy}
              aria-label={dummy ? "목업 미리보기 끄기" : "목업 데이터로 미리보기"}
              title={dummy ? "목업 미리보기 끄기" : "목업 데이터로 미리보기"}
            >
              <FlaskConical className="size-3.5" strokeWidth={ICON_STROKE.default} />
            </Button>
          </div>
        }
      />
      <CollapsiblePanel className="flex flex-col gap-4">
        <div hidden={view !== "active"} className="flex flex-col gap-4">
          {everOpened.current.active && (
            <ActiveMemberRosterView
              ref={activeRef}
              visible={visible && view === "active"}
              showingDummy={dummy}
              onStateChange={setActiveState}
            />
          )}
        </div>
        <div hidden={view !== "exited"} className="flex flex-col gap-4">
          {everOpened.current.exited && (
            <ExitedMemberRosterView
              ref={exitedRef}
              visible={visible && view === "exited"}
              showingDummy={dummy}
              onStateChange={setExitedState}
            />
          )}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
