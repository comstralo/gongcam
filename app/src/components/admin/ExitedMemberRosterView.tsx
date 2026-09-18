import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  User,
  ChevronDown,
  Hash,
  PiggyBank,
  TrendingDown,
  Eye,
  Search,
  LayoutDashboard,
  ExternalLink,
} from "lucide-react";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "@/components/ui/collapsible";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { InfoCard, SubRow, TintedPill, buildDepositCauseItems } from "@/components/dashboard/shared";
import type { DepositCauseItem } from "@/components/dashboard/shared";
import { displayExitedName as displayName, AdminListSkeleton, AdminEmptyState } from "@/components/admin/shared";
import { useApi } from "@/hooks/useApi";
import { usePullRefreshListener } from "@/hooks/usePullToRefresh";
import { useRefreshOnVisible } from "@/hooks/useRefreshOnVisible";
import { ApiError } from "@/lib/api/client";
import { ICON_STROKE, cn } from "@/lib/utils";
import type {
  AdminExitedMembersResponse,
  DepositRefundBreakdown,
  ExitedMemberEntry,
  ExitKind,
  SetExitBlacklistResponse,
} from "@/lib/api/types";

// 셸(MemberRosterList)이 "새로고침" 버튼을 눌렀을 때 지금 보이는 뷰의
// load()를 호출하기 위한 명령형 핸들 — 상태(loading/refreshProgress)는
// ref로 읽지 않는다(자식의 ref 갱신은 부모 리렌더를 트리거하지 않아 헤더가
// 낡은 값을 계속 보여줄 수 있다). 대신 onStateChange 콜백으로 부모의
// state에 반영해 정상적으로 리렌더되게 한다.
export type RosterViewHandle = {
  load: (force?: boolean) => void;
};

// refreshProgress는 없음(퇴실자 뷰는 폴링을 쓰지 않는다) — 항상 undefined.
export type RosterViewState = {
  loading: boolean;
  refreshProgress?: number;
};

function won(n: number) {
  return `₩${(n || 0).toLocaleString()}`;
}

// 🔧 2026-09: 백엔드가 kindStr을 "강제 퇴실자"(discountRatio===1인 모든
// 경우 — 자동 감지된 강제 조건이든 관리자의 직권 사유든)로 통일했다.
// reasons[].label은 "페널티 누적 2회 이상 (송출 P 1회 / 주간 P 1회) ➡️
// 0% 반환"처럼 화살표·반환율까지 포함한 긴 문장이라, "강제 퇴실자
// (사유)" 한 줄로 합칠 때는 code 기준으로 짧은 키워드만 뽑는다(사용자
// 지시: "강제 퇴실자 (예치금 미납)"/"강제 퇴실자 (벌금 미납)" 형태).
// admin_reason(직권 P, 관리자가 자유 입력한 사유)만 label에서 접두사
// ("직권 사유: ")를 떼고 그대로 쓴다 — 그 값 자체가 이미 짧은 키워드가
// 아니라 관리자가 쓴 문장이기 때문이다.
const REASON_SHORT_LABEL: Record<string, string> = {
  under_30_days: "가입 30일 미만",
  fine_unpaid: "벌금 미납",
  deposit_again_unpaid: "예치금 미납",
  penalty_2_or_more: "페널티 2회 이상",
};

function shortReasonLabel(reason: { code: string; label: string }): string {
  if (reason.code === "admin_reason") return reason.label.replace(/^직권 사유:\s*/, "");
  return REASON_SHORT_LABEL[reason.code] ?? reason.label;
}

// "강제 퇴실자"/"정산 퇴실자" 등 유형에, 해당하는 사유를 괄호로 이어붙인다.
// 사유가 여러 개(예: 벌금 미납 + 페널티 2회 이상 동시 해당)면 쉼표로 나열.
function exitTypeLabel(kindStr: string, reasons: { code: string; label: string }[]): string {
  if (reasons.length === 0) return kindStr;
  return `${kindStr} (${reasons.map(shortReasonLabel).join(", ")})`;
}

// 🔧 2026-09: "차감 원인" 카드(buildDepositCauseItems)는 회원 대시보드/
// ExitProcessDialog와 공유하는 함수라, 그 회원의 실제 시트 상태(벌금
// 미납, 가입일수, 송출P/주간P 페널티)만 보여준다 — kind=admin_forced
// (직권 P)로 처리됐다는 사실 자체는 여기에 전혀 반영되지 않는다(계산에도
// 관여하지 않음, ExitProcessDialog의 admin_forced 미리보기와 동일하게
// discountRatio가 사유와 무관하게 항상 1로 고정이기 때문). 관리자가 "이
// 회원이 직권 P로 처리됐는지"를 차감 원인 목록에서도 명시적으로 확인할
// 수 있도록, "퇴실 스터디원 목록"에서만(사용자 지시 — 다른 화면은
// 그대로 둠) 직권 P 횟수를 함께 보여준다.
// 🔧 [사용자 지시] "직권 P를 별개의 항목으로 빼지 말고, 두 항목을 합쳐줘.
// 페널티 쪽을 '송출 P : 1회' 같은 형식으로" — 원래는 "페널티 (직권 P
// N회)"를 별도 항목으로 끼워 넣었으나, 기존 "페널티(송출 P+주간 P)"
// 항목 하나에 직권 P까지 한 줄로 합치고 각 값 앞에 콜론을 붙인다.
// buildDepositCauseItems가 만든 penalty 항목(key: "penalty")을 찾아
// 라벨만 다시 조립한다(breakdown 원본값을 직접 받아 문자열 재파싱 없이
// 안전하게 조립) — rate는 그 항목이 이미 계산해둔 값(송출/주간 페널티
// 합산 기준)과 admin_forced 여부 중 더 큰 차감률을 쓴다(직권 P는 항상
// 100%=전액 차감이므로 admin_forced면 무조건 100%).
function mergePenaltyLabel(
  items: DepositCauseItem[],
  breakdown: DepositRefundBreakdown,
  kind: ExitKind
): DepositCauseItem[] {
  const isAdminForced = kind === "admin_forced";
  return items.map((item) => {
    if (item.key !== "penalty") return item;
    return {
      ...item,
      label: `페널티 (송출 P : ${breakdown.outputPen ?? 0}회 + 주간 P : ${breakdown.timePen ?? 0}회 + 직권 P : ${isAdminForced ? 1 : 0}회)`,
      rate: isAdminForced ? 100 : item.rate,
    };
  });
}

// 🧪 [목업 미리보기] "새로고침" 버튼 옆의 실험용 버튼(셸이 소유) — 실제
// API 호출 없이 이 화면이 다룰 수 있는 상태를 한 번에 눈으로 점검하기
// 위한 것이다(사용자 지시). 실제 /admin/members/exited 응답과 동일한
// 타입을 그대로 써서 화면 코드는 손대지 않는다.
//
// 커버하는 분기(11개, ActiveMemberRosterView의 DUMMY_MEMBERS와 동일한
// 문서화 밀도로 정리):
//  1) forced, examKind/sheetGid/backupFileId 전부 채워진 케이스(이 필드
//     추가 이후 처리) — "상태 정보" 카드가 값을 온전히 보여주는지 확인.
//  2) admin_forced, blacklist=true — 직권 P + 블랙리스트 등록.
//  3) forced, 벌금 미납 아님 + 페널티 2회 이상(예치금 재납 미납 파생) —
//     R3="미납"은 항상 페널티 2회 이상의 파생 결과라(daily_calc 검토로
//     확인) 실제 있을 수 없는 "예치금 미납만 단독" 조합은 만들지 않는다.
//  4) forced, 벌금 시한 내 미납 단독.
//  5) settle, 100% 반환(페널티 0회 + 지연 없음).
//  6) settle, 0% 반환(페널티 1회 + 고지지연 동시 — 100% 차감).
//  7) result=null — 이 기능(2026-09) 도입 이전에 처리되어 조회 불가.
//  8) settle, 50% 반환(페널티 1회 단독) — 5·6번엔 없던 유일한 중간
//     반환율 분기.
//  9) forced, 이름을 2글자("민준")로 짧게 두어 "(퇴실)" 접미사를 뗀 뒤
//     검색 필터가 짧은 이름에서도 정상 매칭되는지 확인.
//  10) admin_forced, blacklist=false — "직권 P인데 체크박스는 안 누른"
//      조합(2번은 blacklist=true뿐이라 반대 케이스가 없었다).
//  11) forced, 벌금 미납 + 페널티 2회 이상이 동시에 걸리는 케이스 —
//      "차감 원인" 카드에 두 항목이 함께 표시되는지 확인.
const DUMMY_EXITED_MEMBERS: ExitedMemberEntry[] = [
  {
    number: "exited:재희 (퇴실)",
    name: "재희 (퇴실)",
    result: {
      kind: "forced",
      kindStr: "강제 퇴실자",
      refundAmount: 0,
      heldAmount: 10000,
      fineAlreadyPayment: 3000,
      breakdown: {
        amount: 0,
        reason: "페널티 2회 이상",
        outputPen: 1,
        timePen: 1,
        daysSinceJoin: 82,
        fineUnpaid: false,
        fineUnpaidDays: [],
        depositAgainStatus: null,
        lateNotice: false,
      },
      reasons: [{ code: "penalty_2_or_more", label: "페널티 누적 2회 이상 (송출 P 1회 / 주간 P 1회) ➡️ 0% 반환" }],
      processedDate: "2026-08-24",
      blacklist: false,
      googleAccount: "jaehee.kim@gmail.com",
      gooroomeeAccount: "jaehee.kim@gmail.com",
      examKind: "9급 공무원",
      sheetGid: 987654321,
      backupFileId: "dummy-backup-file-id",
      // 🔧 [사용자 지시] "퇴실 예약일자/최근 접속/퇴실 집행일자" 렌더링
      // 확인용 — forced는 신청 없이도 처리될 수 있지만, 이 케이스는 신청
      // 후 처리된(exitRequestDate 있음) 조합으로 둔다.
      exitRequestDate: "2026-08-20",
      lastLoginAt: Date.UTC(2026, 7, 23, 9, 0, 0),
      lastLoginIp: "121.128.55.10",
    },
  },
  {
    number: "exited:서준 (퇴실)",
    name: "서준 (퇴실)",
    result: {
      kind: "admin_forced",
      kindStr: "강제 퇴실자",
      refundAmount: 0,
      heldAmount: 10000,
      fineAlreadyPayment: 0,
      breakdown: {
        amount: 0,
        reason: null,
        outputPen: 0,
        timePen: 0,
        daysSinceJoin: 45,
        fineUnpaid: false,
        fineUnpaidDays: [],
        depositAgainStatus: null,
        lateNotice: false,
      },
      reasons: [{ code: "admin_reason", label: "직권 사유: 비매너 행위로 인한 즉시 퇴실" }],
      processedDate: "2026-08-19",
      blacklist: true,
      googleAccount: "seojun.lee@gmail.com",
      gooroomeeAccount: "seojun.lee@gmail.com",
      // 이 필드 추가(2026-09) 이전에 처리된 케이스 — "없음"이 의도된
      // 값임을 명시적으로 남긴다(examKind/sheetGid/backupFileId 전부 없음).
    },
  },
  {
    // 🔧 R3(예치금 재납)="미납"은 항상 페널티 2회 이상의 파생 결과라(코드
    // 검토로 확인, daily_calc()가 total_pen>=2일 때만 이 값을 씀), 예치금
    // 미납만 있고 페널티가 0회인 조합은 실제로 발생할 수 없다 — outputPen/
    // timePen을 2회로 맞춰 실제 있을 수 있는 조합으로 더미를 구성한다.
    number: "exited:아름 (퇴실)",
    name: "아름 (퇴실)",
    result: {
      kind: "forced",
      kindStr: "강제 퇴실자",
      refundAmount: 0,
      heldAmount: 10000,
      fineAlreadyPayment: 0,
      breakdown: {
        amount: 0,
        reason: "페널티 2회 이상",
        outputPen: 2,
        timePen: 0,
        daysSinceJoin: 60,
        fineUnpaid: false,
        fineUnpaidDays: [],
        depositAgainStatus: "미납",
        lateNotice: false,
      },
      reasons: [{ code: "penalty_2_or_more", label: "페널티 누적 2회 이상 (송출 P 2회 / 주간 P 0회) ➡️ 0% 반환" }],
      processedDate: "2026-08-17",
      blacklist: false,
      googleAccount: "areum.yoon@gmail.com",
      gooroomeeAccount: "areum.yoon@gmail.com",
    },
  },
  {
    number: "exited:지민 (퇴실)",
    name: "지민 (퇴실)",
    result: {
      kind: "forced",
      kindStr: "강제 퇴실자",
      refundAmount: 0,
      heldAmount: 10000,
      fineAlreadyPayment: 5000,
      breakdown: {
        amount: 0,
        reason: "벌금 시한 내 미납",
        outputPen: 0,
        timePen: 0,
        daysSinceJoin: 70,
        fineUnpaid: true,
        fineUnpaidDays: ["월", "화", "수"],
        depositAgainStatus: null,
        lateNotice: false,
      },
      reasons: [{ code: "fine_unpaid", label: "벌금 시한 내 미납 ➡️ 0% 반환" }],
      processedDate: "2026-08-12",
      blacklist: false,
      googleAccount: "jimin.han@gmail.com",
      gooroomeeAccount: "jimin.han@gmail.com",
    },
  },
  {
    number: "exited:도윤 (퇴실)",
    name: "도윤 (퇴실)",
    result: {
      kind: "settle",
      kindStr: "정산 퇴실자",
      refundAmount: 10000,
      heldAmount: 0,
      fineAlreadyPayment: 0,
      breakdown: {
        amount: 10000,
        reason: null,
        outputPen: 0,
        timePen: 0,
        daysSinceJoin: 120,
        fineUnpaid: false,
        fineUnpaidDays: [],
        depositAgainStatus: null,
        lateNotice: false,
      },
      reasons: [{ code: "settle_return_rate", label: "100% 반환" }],
      processedDate: "2026-08-10",
      blacklist: false,
      googleAccount: "doyoon.park@gmail.com",
      gooroomeeAccount: "doyoon.park@gmail.com",
    },
  },
  {
    // 🔧 페널티 1회 + 고지지연이 동시에 있으면 100% 차감(반환 0원)이어야
    // 한다(calcSettleReturnDeposit 수정으로 depositRefundBreakdown과 일치
    // 시킴, 2026-09) — 이전 더미는 이 조합에서도 50%/₩5,000으로 남아있던
    // 실제 처리 로직 버그를 그대로 반영한 상태였다.
    number: "exited:하은 (퇴실)",
    name: "하은 (퇴실)",
    result: {
      kind: "settle",
      kindStr: "정산 퇴실자",
      refundAmount: 0,
      heldAmount: 10000,
      fineAlreadyPayment: 1500,
      breakdown: {
        amount: 0,
        reason: null,
        outputPen: 1,
        timePen: 0,
        daysSinceJoin: 95,
        fineUnpaid: false,
        fineUnpaidDays: [],
        depositAgainStatus: null,
        lateNotice: true,
      },
      reasons: [{ code: "settle_return_rate", label: "0% 반환" }],
      processedDate: "2026-08-03",
      blacklist: false,
      googleAccount: "haeun.choi@gmail.com",
      gooroomeeAccount: "haeun.choi@gmail.com",
    },
  },
  {
    // 이 기능(2026-09) 도입 이전에 처리된 퇴실자 — 저장된 결과가 없어
    // "조회 불가" 안내만 뜨는 케이스도 함께 확인한다.
    number: "exited:유나 (퇴실)",
    name: "유나 (퇴실)",
    result: null,
  },
  {
    // 8) settle 50% 반환 — 페널티 1회 단독(고지지연 없음)일 때만 나오는
    //    유일한 중간 반환율 케이스. 기존 더미(5, 6번)는 100%/0%뿐이라
    //    이 분기가 빠져 있었다.
    number: "exited:민서 (퇴실)",
    name: "민서 (퇴실)",
    result: {
      kind: "settle",
      kindStr: "정산 퇴실자",
      refundAmount: 5000,
      heldAmount: 5000,
      fineAlreadyPayment: 0,
      breakdown: {
        amount: 5000,
        reason: "페널티 1회",
        outputPen: 1,
        timePen: 0,
        daysSinceJoin: 140,
        fineUnpaid: false,
        fineUnpaidDays: [],
        depositAgainStatus: null,
        lateNotice: false,
      },
      reasons: [{ code: "settle_return_rate", label: "50% 반환" }],
      processedDate: "2026-07-28",
      blacklist: false,
      googleAccount: "minseo.choi@gmail.com",
      gooroomeeAccount: "minseo.choi@gmail.com",
      // examKind/sheetGid/backupFileId가 온전히 채워진 두 번째 사례
      // (1번 재희와 함께) — 이 필드가 "특이 케이스"가 아니라 정상
      // 케이스임을 확인하기 위해 둘 이상 둔다.
      examKind: "세무사",
      sheetGid: 135792468,
      backupFileId: "dummy-backup-file-id-2",
    },
  },
  {
    // 9) forced, 가입 30일 미만 — 이름을 2글자로 짧게 두어 "(퇴실)"
    //    접미사를 뗀 뒤에도 검색 필터가 짧은 이름에서 정상 매칭되는지
    //    확인할 수 있게 한다("민준"으로 검색 시 매칭되는지).
    number: "exited:민준 (퇴실)",
    name: "민준 (퇴실)",
    result: {
      kind: "forced",
      kindStr: "강제 퇴실자",
      refundAmount: 0,
      heldAmount: 10000,
      fineAlreadyPayment: 0,
      breakdown: {
        amount: 0,
        reason: "가입 30일 미만",
        outputPen: 0,
        timePen: 0,
        daysSinceJoin: 5,
        fineUnpaid: false,
        fineUnpaidDays: [],
        depositAgainStatus: null,
        lateNotice: false,
      },
      reasons: [{ code: "under_30_days", label: "가입 30일 미만 ➡️ 0% 반환" }],
      processedDate: "2026-07-20",
      blacklist: false,
      googleAccount: "minjun.k@gmail.com",
      gooroomeeAccount: "minjun.k@gmail.com",
    },
  },
  {
    // 10) admin_forced + blacklist=false — 기존 admin_forced 더미(2번,
    //     서준)는 blacklist=true뿐이라, "직권 P인데 블랙리스트는 등록
    //     안 한"(체크박스를 일부러 안 누른 관리자) 조합이 없었다.
    number: "exited:하준 (퇴실)",
    name: "하준 (퇴실)",
    result: {
      kind: "admin_forced",
      kindStr: "강제 퇴실자",
      refundAmount: 0,
      heldAmount: 10000,
      fineAlreadyPayment: 0,
      breakdown: {
        amount: 0,
        reason: null,
        outputPen: 0,
        timePen: 0,
        daysSinceJoin: 30,
        fineUnpaid: false,
        fineUnpaidDays: [],
        depositAgainStatus: null,
        lateNotice: false,
      },
      reasons: [{ code: "admin_reason", label: "직권 사유: 장기 무단 결석" }],
      processedDate: "2026-07-15",
      blacklist: false,
      googleAccount: "hajun.jung@gmail.com",
      gooroomeeAccount: "hajun.jung@gmail.com",
    },
  },
  {
    // 11) forced, 벌금 미납 + 페널티 2회 이상이 동시에 걸리는 케이스 —
    //     "차감 원인" 카드에 두 항목이 함께 표시되는지 확인(참여자 목록
    //     5번 도윤과 동일한 취지, 퇴실자 쪽엔 이 이중 조건 케이스가 없었다).
    number: "exited:세아 (퇴실)",
    name: "세아 (퇴실)",
    result: {
      kind: "forced",
      kindStr: "강제 퇴실자",
      refundAmount: 0,
      heldAmount: 10000,
      fineAlreadyPayment: 2000,
      breakdown: {
        amount: 0,
        reason: "벌금 시한 내 미납",
        outputPen: 1,
        timePen: 1,
        daysSinceJoin: 88,
        fineUnpaid: true,
        fineUnpaidDays: ["금"],
        depositAgainStatus: "미납",
        lateNotice: false,
      },
      reasons: [
        { code: "fine_unpaid", label: "벌금 시한 내 미납 ➡️ 0% 반환" },
        { code: "penalty_2_or_more", label: "페널티 누적 2회 이상 (송출 P 1회 / 주간 P 1회) ➡️ 0% 반환" },
      ],
      processedDate: "2026-07-05",
      blacklist: false,
      googleAccount: "sea.oh@gmail.com",
      gooroomeeAccount: "sea.oh@gmail.com",
    },
  },
];

// "스터디원 목록"의 퇴실자 뷰 본문 — 원본 스프레드시트에 남은 "{이름}
// (퇴실)" 백업 탭 목록을 보여주고, 각 항목을 펼치면 확정 처리 시점에
// 저장해둔 결과(반환 예치금/차감 원인/처리 결과/퇴실유형)를
// ExitProcessDialog의 미리보기 카드와 동일한 형태로 보여준다 — 다만 이건
// "지금 계산"이 아니라 "그때 이미 확정된 값"을 그대로 보여주는 조회
// 전용 화면이라 별도 API 호출(미리보기/확정) 없이 목록 응답에 함께
// 실려온다. 셸(MemberRosterList)이 SectionHeader/드롭다운/목업 버튼을
// 소유하고 이 컴포넌트는 본문(검색창~카드 목록)만 렌더링한다.
export const ExitedMemberRosterView = forwardRef<
  RosterViewHandle,
  { visible: boolean; showingDummy: boolean; onStateChange: (state: RosterViewState) => void }
>(function ExitedMemberRosterView({ visible, showingDummy, onStateChange }, ref) {
  const { call } = useApi();
  const [members, setMembers] = useState<ExitedMemberEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedNumber, setExpandedNumber] = useState<string | null>(null);
  // 퇴실자가 많아지면 목록을 스크롤로 훑기보다 이름으로 바로 찾는 게
  // 빠르다 — displayName()으로 "(퇴실)" 접미사를 뗀 이름 기준, 대소문자
  // 구분 없이 부분 일치로 필터링한다.
  const [query, setQuery] = useState("");
  // 블랙리스트 토글 진행 중인 회원(번호)만 잠근다 — 여러 항목을 동시에
  // 눌러도 서로 막지 않는다.
  const [togglingNumber, setTogglingNumber] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const wasDummyRef = useRef(false);

  // 🔧 [사용자 지시] "실제 운영 환경 데이터를 오염시킬만한 실질적인 데이터
  // 처리는 없어야 함" — 이전엔 이 화면 자체가 항상 목업만 보여주고 실제
  // /admin/members/exited 호출 코드가 없었다(방치된 상태). ActiveMemberRosterView와
  // 동일한 관용구(loadingRef 가드, force 파라미터)로 실제 API 호출을 복원한다.
  // useCallback으로 안정화 — useImperativeHandle이 이 함수를 deps로
  // 참조하는데, 매 렌더 새 함수면 handle도 매번 새로 만들어진다(무해하지만
  // 불필요한 재실행 경고를 유발한다).
  const load = useCallback(
    (force = false) => {
      if ((showingDummy && !force) || loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      setError(null);
      call<AdminExitedMembersResponse>("/admin/members/exited")
        .then((data) => {
          setMembers(data.members || []);
        })
        .catch((err) => setError(err instanceof Error ? err.message : "퇴실 스터디원 목록을 불러오지 못했습니다."))
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
      setMembers(DUMMY_EXITED_MEMBERS);
    } else if (wasDummyRef.current) {
      load(true);
    }
    wasDummyRef.current = showingDummy;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showingDummy]);

  useEffect(() => load(), []); // eslint-disable-line react-hooks/exhaustive-deps
  usePullRefreshListener(true, () => load());
  useRefreshOnVisible(visible, load);

  // load는 매 렌더 새로 만들어지는 클로저(showingDummy를 참조)라 deps에서
  // 빼면 셸이 오래된 showingDummy 값을 참조하는 handle을 들고 있게 될 수
  // 있다 — load도 deps에 포함해 항상 최신 클로저를 노출한다.
  useImperativeHandle(ref, () => ({ load }), [load]);

  // 🔧 [버그 방지] ref(useImperativeHandle)로 loading/refreshProgress를
  // 그대로 노출하면, 이 값이 바뀌어도(자식 리렌더) 부모(셸)는 리렌더되지
  // 않아 헤더의 로딩 스피너·새로고침 버튼이 낡은 값에 머무를 수 있다 —
  // 콜백으로 부모의 state에 반영해 정상적으로 리렌더를 트리거한다.
  useEffect(() => {
    onStateChange({ loading, refreshProgress: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // 🔧 2026-09: 블랙리스트 등록/해제 토글(POST /admin/exit/blacklist) —
  // 실제 백엔드를 호출하는 진짜 액션이다(목록 자체는 실제 API 또는 목업일
  // 수 있지만, 이 버튼은 실제 KV 값을 바꾼다). 성공하면 이 화면이 "그때
  // 이미 확정된 값"을 그대로 보여주는 조회 전용이라는 원칙대로, 서버가
  // 승인한 값으로 로컬 상태만 갱신한다 — load()를 다시 부르면 방금 바꾼
  // 값이 재조회로 덮어써질 수 있으므로 쓰지 않는다.
  function toggleBlacklist(m: ExitedMemberEntry) {
    if (!m.result) return;
    const nextBlacklist = !m.result.blacklist;
    // 🧪 목업 미리보기 중에는 더미 이름으로 실제 MemberSettingsDO에 값을
    // 써버리면 안 되므로 API를 호출하지 않는다 — 대신 로컬 state만 그대로
    // 토글해 버튼이 눌리는 걸 눈으로 확인할 수 있게 한다(사용자 지시:
    // "목업에서도 버튼 클릭이 가능하도록").
    if (showingDummy) {
      setMembers(
        (prev) =>
          prev?.map((x) => (x.number === m.number && x.result ? { ...x, result: { ...x.result, blacklist: nextBlacklist } } : x)) ??
          prev
      );
      return;
    }
    setTogglingNumber(m.number);
    setError(null);
    call<SetExitBlacklistResponse>("/admin/exit/blacklist", {
      method: "POST",
      body: { name: m.name, blacklist: nextBlacklist },
    })
      .then(() => {
        setMembers(
          (prev) =>
            prev?.map((x) => (x.number === m.number && x.result ? { ...x, result: { ...x.result, blacklist: nextBlacklist } } : x)) ??
            prev
        );
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "블랙리스트 변경에 실패했습니다."))
      .finally(() => setTogglingNumber(null));
  }

  const filteredMembers = useMemo(() => {
    if (!members) return members;
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return members;
    return members.filter((m) => displayName(m.name).toLowerCase().includes(trimmed));
  }, [members, query]);

  return (
    <>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

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

      {members && members.length === 0 && <AdminEmptyState>퇴실한 스터디원이 없습니다.</AdminEmptyState>}

      {!loading && members && members.length > 0 && filteredMembers && filteredMembers.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">
          "{query}"와 일치하는 퇴실 스터디원이 없습니다.
        </p>
      )}

      {filteredMembers && filteredMembers.length > 0 && (
        <div className="flex flex-col gap-2 sm:gap-2.5">
          {filteredMembers.map((m) => {
            const isExpanded = expandedNumber === m.number;
            const result = m.result;
            return (
              // 🔧 [사용자 지시] "제보 쪽 토글의 전환 애니메이션처럼 부드럽게"
              // — 기존엔 isExpanded 조건부 렌더링으로 펼침 영역이 즉시
              // 나타났다 사라졌다(뚝뚝 끊김). MyOutputPenSection에 적용했던
              // base-ui Collapsible(높이 전환 애니메이션)을 여기도 적용한다.
              <Collapsible key={m.number} open={isExpanded} onOpenChange={(open) => setExpandedNumber(open ? m.number : null)}>
              <InfoCard className="flex flex-col gap-2.5 bg-card">
                <CollapsibleTrigger className="flex items-center justify-between gap-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded" hideChevron>
                  {/* 🔧 [사용자 지시] "이름이 작게 나오지 않아?" — 다른
                      관리자 화면(참여 스터디원 목록 등)의 회원 이름
                      (text-sm sm:text-base)보다 한 단계 작았다 — 통일한다. */}
                  <span className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base">
                    <User className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
                    {displayName(m.name)}
                  </span>
                  <span className="flex items-center gap-1.5">
                    {result?.blacklist && <TintedPill tone="warn">블랙리스트</TintedPill>}
                    <ChevronDown
                      className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isExpanded && "rotate-180")}
                      strokeWidth={ICON_STROKE.default}
                    />
                  </span>
                </CollapsibleTrigger>

                <CollapsiblePanel className="flex flex-col">
                  <div className="flex flex-col gap-2.5 pt-2.5">
                    {!result && (
                      <p className="py-4 text-center text-xs text-muted-foreground sm:text-sm">
                        처리 결과를 조회할 수 없습니다 (이 기능 도입 이전에 처리된 퇴실자입니다).
                      </p>
                    )}

                    {result && (
                      <>
                        {/* 🔧 [사용자 지시] "'참여 스터디원 목록'의 상태
                            정보를 '퇴실 스터디원 목록'에도 반환 예치금
                            위에" — MemberRosterList의 상태 정보 카드에서
                            발췌한 항목(준비시험/계정/대시보드/시트번호)에
                            더해, 최근 접속 일자·IP/퇴실 예약일자/퇴실
                            집행일자도 추가했다(사용자 지시. 순서는 최근
                            접속 IP 다음에 예약·집행일자가 오도록 배치).
                            퇴실 예약일자는
                            참여자 뷰의 "2026-09-25 희망" 같은 진행중 표현
                            대신 이미 끝난 일이므로 날짜값만 그대로 보여준다.
                            퇴실 집행일자는 별도 필드가 아니라 "처리 결과"
                            카드의 processedDate를 그대로 병기한다. 이
                            필드들을 저장하기 시작한 시점(2026-09) 이전에
                            처리된 퇴실자는 값이 없어 "-"로 표시된다. */}
                        <InfoCard className="flex flex-col gap-1.5 bg-card">
                          <span className="flex items-center gap-1.5 text-sm font-semibold sm:text-base">
                            <Hash className="size-3.5 shrink-0 sm:size-4" strokeWidth={ICON_STROKE.default} />
                            상태 정보
                          </span>
                          <div className="flex flex-col gap-1.5 [&_span]:text-xs [&_span]:sm:text-sm">
                            <SubRow label="준비시험" value={result.examKind || "-"} />
                            <SubRow label="구글 계정" value={result.googleAccount || "-"} />
                            <SubRow label="구루미 계정" value={result.gooroomeeAccount || "-"} />
                            {/* 🔧 퇴실자의 원래 회원번호(m.number, "exited:{이름}
                                (퇴실)")는 살아있는 회원과 달리 다른 회원에게
                                재배정될 위험이 없다 — handleAdminMemberStatus가
                                이 접두사를 인식해 백업 탭 스냅샷을 보여준다. */}
                            <SubRow
                              label="대시보드"
                              value={
                                <a
                                  href={`#/?member=${encodeURIComponent(m.number)}`}
                                  className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
                                >
                                  {displayName(m.name)}
                                  <LayoutDashboard className="size-3 shrink-0" strokeWidth={ICON_STROKE.default} />
                                </a>
                              }
                            />
                            <SubRow
                              label="시트번호"
                              value={
                                result.backupFileId && result.sheetGid !== undefined && result.sheetGid !== null ? (
                                  <a
                                    href={`https://docs.google.com/spreadsheets/d/${result.backupFileId}/edit#gid=${result.sheetGid}`}
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
                              label="최근 접속일자"
                              value={result.lastLoginAt ? new Date(result.lastLoginAt).toLocaleString("ko-KR") : "-"}
                            />
                            <SubRow label="최근 접속 IP" value={result.lastLoginIp || "-"} />
                            {/* 🔧 [사용자 지시] "'퇴실 예약일자', '퇴실
                                집행일자'는 '최근 접속 IP' 밑으로 내려줘". */}
                            <SubRow label="퇴실 예약일자" value={result.exitRequestDate || "-"} />
                            <SubRow label="퇴실 집행일자" value={result.processedDate || "-"} />
                          </div>
                        </InfoCard>

                        {/* 🔧 [사용자 지시] "현재 페이지(관리자)의 위계도
                            맞춰줘" — 이 소제목만 다른 소제목(차감 원인 등,
                            text-sm sm:text-base)보다 한 단계 작았다.
                            🔧 [사용자 지시] "우측의 텍스트 위계를 좌측
                            제목과 일치시켜줘. 대신 볼드 처리는 하지마" —
                            값(₩0 등)의 크기를 제목과 같은 text-sm
                            sm:text-base로 맞추되 font-semibold는 주지 않아
                            제목과 시각적으로 구분되게 한다. */}
                        <InfoCard className="flex items-center justify-between gap-2 bg-card">
                          <span className="flex items-center gap-1.5 text-sm font-semibold sm:text-base">
                            <PiggyBank className="size-3.5 shrink-0 sm:size-4" strokeWidth={ICON_STROKE.default} />
                            반환 예치금
                          </span>
                          <span
                            className={cn(
                              "text-sm sm:text-base",
                              result.refundAmount >= 5000 && "text-ok",
                              result.refundAmount === 0 && "text-destructive"
                            )}
                          >
                            {won(result.refundAmount)}
                          </span>
                        </InfoCard>

                        {/* 🔧 [사용자 지시] "현재 페이지(관리자)의 위계도
                            맞춰줘" — 소제목(차감 원인/처리 결과/퇴실유형)이
                            다른 관리자 화면 소제목(text-sm sm:text-base)
                            보다 한 단계 작았고, SubRow도 기본 크기
                            (text-micro-lg sm:text-xs)라 제보 화면 기준
                            (text-xs sm:text-sm)보다 작았다 — 함께 맞춘다. */}
                        <InfoCard className="flex flex-col gap-1.5 bg-card">
                          <span className="flex items-center gap-1.5 text-sm font-semibold sm:text-base">
                            <TrendingDown className="size-3.5 shrink-0 sm:size-4" strokeWidth={ICON_STROKE.default} />
                            차감 원인
                          </span>
                          <div className="flex flex-col gap-1.5 [&_span]:text-xs [&_span]:sm:text-sm">
                            {mergePenaltyLabel(
                              buildDepositCauseItems(result.breakdown, result.breakdown.lateNotice ? 50 : 0),
                              result.breakdown,
                              result.kind
                            ).map((item) => (
                              <SubRow
                                key={item.key}
                                label={item.label}
                                value={`${item.rate}%`}
                                valueClassName={cn("font-sans", item.rate > 0 && "text-destructive")}
                              />
                            ))}
                          </div>
                        </InfoCard>

                        {/* 🔧 [사용자 지시] "'퇴실유형'을 '처리 결과'에
                            귀속시켜" — 별도 카드였던 퇴실유형/블랙리스트를
                            하나의 카드로 합쳤다. "유형" 라벨은 "퇴실유형"으로
                            이름을 바꾼다. "처리일자"는 "상태 정보" 카드의
                            "퇴실 집행일자"(같은 값 processedDate)와 중복이라
                            제거했다(사용자 지시). */}
                        <InfoCard className="flex flex-col gap-1.5 bg-card">
                          <span className="flex items-center gap-1.25 text-sm font-semibold sm:text-base">
                            <Eye className="size-3.5 shrink-0 sm:size-4" strokeWidth={ICON_STROKE.default} />
                            처리 결과
                          </span>
                          <div className="flex flex-col gap-1.5 [&_span]:text-xs [&_span]:sm:text-sm">
                            <SubRow label="반환 예치금" value={won(result.refundAmount)} />
                            <SubRow label="귀속 예치금" value={won(result.heldAmount)} />
                            <SubRow label="납부된 벌금" value={won(result.fineAlreadyPayment)} />
                            <SubRow label="퇴실유형" value={exitTypeLabel(result.kindStr, result.reasons)} />
                            {/* 🔧 2026-09: 처음엔 admin_forced(직권 P)에서만
                                조건부로 보였으나, 사용자 지시로 모든 퇴실
                                유형에 항상 표시하도록 변경 — forced/settle은
                                블랙리스트 체크박스 자체가 없어(§ExitProcessDialog)
                                항상 N으로 저장된 값이 그대로 뜬다. 표기도
                                "예/아니오"에서 "Y/N"으로 변경. */}
                            <SubRow
                              label="블랙리스트"
                              value={result.blacklist ? "Y" : "N"}
                              valueClassName={result.blacklist ? "text-destructive" : undefined}
                            />
                          </div>
                        </InfoCard>

                        <Button
                          variant={result.blacklist ? "outline" : "destructive"}
                          className="w-full sm:h-11 sm:text-base"
                          disabled={togglingNumber === m.number}
                          onClick={() => toggleBlacklist(m)}
                        >
                          {result.blacklist ? "블랙리스트 해제" : "블랙리스트 등록"}
                        </Button>
                      </>
                    )}
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
