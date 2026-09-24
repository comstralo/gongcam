import { useEffect, useState, type ReactNode } from "react";
import { RotateCw, FileText, Image as ImageIcon, Loader2, Search, Hash, ExternalLink, Eye, ChevronDown, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "@/components/ui/collapsible";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  InfoCard,
  SubRow,
  buildDepositCauseItems,
  mergePenaltyLabel,
  won,
  RefundAmountCard,
  DepositCauseCard,
} from "@/components/dashboard/shared";
import { WORKER_BASE } from "@/lib/api/client";
import { cn, ICON_STROKE } from "@/lib/utils";
import type { PenaltySlotHistoryEntry, DepositRefundBreakdown, ExitKind } from "@/lib/api/types";

// 관리자 탭 전반의 텍스트 위계를 명시적으로 나눈 프리미티브들.
// 1. SectionHeader 제목  — text-sm/base, font-semibold (섹션의 최상위 텍스트)
// 2. ItemTitle           — text-sm/base, font-semibold (리스트 한 항목의 1차 텍스트)
// 3. FieldLabel          — text-xs/sm,  font-medium, muted (카드 안 항목명 — 크기 자체를 한 단계 낮춰 값과 구분)
// 4. FieldValue          — text-xs/sm,  font-semibold (카드 안 강조 값, FieldLabel과 나란히 쓰임)
// 🔧 [사용자 지시] "우리 시스템에서 볼드로 처리된 부분 모두 세미볼드로
// 전수조사해서 바꿔버려" — 앱 전체의 font-bold를 font-semibold로
// 통일했다. SectionHeader와 ItemTitle의 굵기 자체는 이제 같지만
// text-sm/base 크기가 나머지 두 단계와 이미 구분해주므로 위계는
// 유지된다.

// 백엔드가 퇴실자를 "{이름} (퇴실)" 형태(백업 탭 이름 그대로)로 내려주는
// 곳(ExitedMemberRosterView, "다른 회원 보기" 드롭다운, 신규 등록 블랙리스트 경고
// 등)이 여럿이라 표시용 이름만 뽑는 로직을 공용으로 둔다.
export function displayExitedName(name: string): string {
  return name.replace(/ \(퇴실\)$/, "");
}

// 🔧 [사용자 지시] "'최근 접속 일자'에서 시간부를 00:00:00 형식으로" —
// toLocaleString의 "hour12: false"만으로는 로케일 기본 표기("7시 13분
// 20초")가 유지돼 시:분:초를 직접 2자리로 패딩한다.
// 🔧 [사용자 지시] "24시간제로 표현할 때 시 분 초가 아닌 : 방식으로
// 출력" — toLocaleString(ko-KR, {hour12:false})만으로는 로케일 기본
// 표기("16시 33분 38초")가 그대로 남아 시:분:초를 직접 2자리로 패딩한다.
// admin/shared.tsx뿐 아니라 ExitProcessDialog(퇴실 프로세스 카드)도
// 신청/동의 일자에 동일한 형식을 써야 해서 공유 함수로 뽑았다.
export function formatDateTime24h(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.toLocaleDateString("ko-KR")} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 🔧 [공용화, 2026-09-19 사용자 지시] "화각 불량 제보 처리"(관리자,
// ReportReviewList.tsx)와 "내 화각 불량 제보"(회원, MyOutputPenSection.tsx)
// 가 글자 하나 다르지 않게 복제해 갖고 있던 제보 처리 문구 함수들 —
// "한쪽만 고치면 서로 달라지는" 문제를 근본적으로 없애기 위해 공용
// 파일로 옮겼다. 두 파일 모두 이 함수들을 import해서 쓴다.

// 송출 P 슬롯 차수(1~6차)별로 실제 적용되는 조치가 다르다 — 1차는 구두경고만,
// 2/3/5차는 총 상점에서 벌점만 차감(개인 탭 C35 수식), 4/6차는 실제 송출 P가
// 발생해 예치금 재납 등 페널티로 이어진다(OUTPUT_PEN_P_SLOTS와 동일 기준).
export function actionLabel(occurrence: number | null): string {
  if (occurrence === 1) return "구두경고";
  if (occurrence === 2 || occurrence === 3 || occurrence === 5) return "벌점";
  if (occurrence === 4) return "송출 P : 1회";
  if (occurrence === 6) return "송출 P : 2회";
  return "적용 불가 (잔여 슬롯 없음)";
}

// 버튼/SubRow 문구용 "N차 (조치명)" 형태. occurrence가 없으면(회원을 못
// 찾았거나 슬롯이 다 찼으면) "적용 불가 (잔여 슬롯 없음)"만 보여준다.
export function occurrenceLabel(occurrence: number | null): string {
  const action = actionLabel(occurrence);
  return occurrence ? `${occurrence}차 (${action})` : action;
}

// 뱃지 통폐합(§ReportReviewList/MyOutputPenSection 헤더 뱃지)용 3갈래
// 요약 — actionLabel과 동일한 차수 매핑이지만 "경고/벌점/페널티"만
// 필요할 때 쓴다.
export function penaltyCategoryLabel(occurrence: number | null): string {
  if (occurrence === 1) return "경고";
  if (occurrence === 4 || occurrence === 6) return "페널티";
  return "벌점"; // occurrence === 2, 3, 5
}

// "이번 주 영향"(벌점·페널티 변동) SubRow용 — 2/3/5차는 이번 사이클
// 슬롯 개수 × 0.1점 차감, 4/6차는 실제 송출 P 발생, 1차는 영향 없음.
export function weeklyImpactLabel(occurrence: number | null, weeklyMinorPenaltyCount: number): string {
  if (occurrence === 1) return "없음";
  if (occurrence === 2 || occurrence === 3 || occurrence === 5) {
    const deduction = Math.round(weeklyMinorPenaltyCount * 0.1 * 10) / 10;
    return `주간 총 상점에서 -${deduction}점`;
  }
  if (occurrence === 4) return "송출 P : 1회";
  if (occurrence === 6) return "송출 P : 2회";
  return "-";
}

// 차감 분을 "-HH:MM" 형식으로 포맷한다.
export function formatDeductedTime(minutes: number): string {
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `-${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

// 🔧 [사용자 지시, 2026-09-19] "화각 불량 제보 처리"/"내 화각 불량 제보"
// 뱃지("대기 | 확정", "수신 | 발신" 등)의 구분자를 다른 화면(대시보드
// 타일 등)이 공용으로 쓰는 DividedValue(세로선 │)와 별개로 "·"(가운뎃점)로
// 바꿔달라는 요청 — 제보 도메인 뱃지에서만 국한된 변경이라 공용
// DividedValue는 그대로 두고, 이 두 화면(ReportReviewList/
// MyOutputPenSection)만 쓰는 전용 컴포넌트를 admin/shared.tsx에 둔다(이미
// 두 파일이 공유하는 위치).
export function DottedValue({ items }: { items: ReactNode[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {items.map((item, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <span aria-hidden="true">·</span>}
          {item}
        </span>
      ))}
    </span>
  );
}

// "처리현황" SubRow 텍스트 — 대상자 응답(targetResponse)과 관리자 최종
// 처리(reviewStatus)를 조합한다. confirmedOccurrence는 reviewStatus가
// "approved"일 때만 의미 있는 확정 조치 차수(경고/벌점/페널티 판정용)로,
// 호출자가 로컬 세션 오버라이드(관리자 화면의 applied 등)와 서버 스냅샷을
// 이미 병합해 넘겨야 한다 — 이 함수 자체는 그 병합 방식을 모른 채 순수하게
// occurrence 값만 받는다(두 화면이 서로 다른 방식으로 병합하므로 이렇게
// 분리해야 공용화가 가능했다).
export function statusLabel(
  item: {
    reviewStatus: "pending" | "approved" | "rejected" | "rejected_recognized" | "deferred";
    targetResponse: "disputed" | "recognized" | null;
    targetResponseAuto: boolean;
  },
  confirmedOccurrence: number | null
): string {
  if (!item.targetResponse) {
    return "응답 대기 중";
  }
  const isDisputed = item.targetResponse === "disputed";
  // 90분 시한 초과로 시스템이 자동 제출한 응답은 대상자 본인이 직접
  // 누른 위반인정과 구분되도록 "자동응답"으로 표시한다.
  const responseLabel = item.targetResponseAuto ? "자동응답" : isDisputed ? "이의제기" : "위반인정";
  if (item.reviewStatus === "pending") {
    if (item.targetResponseAuto) return "90분 내 무응답으로 자동 제출 (검토 중)";
    return `${responseLabel} 제출 (검토 중)`;
  }
  if (item.reviewStatus === "deferred") {
    return `${responseLabel} → 검토 완료 (유예 확정)`;
  }
  if (item.reviewStatus === "rejected" || item.reviewStatus === "rejected_recognized") {
    return `${responseLabel} → 검토 완료 (반려 확정)`;
  }
  // reviewStatus === "approved"
  return `${responseLabel} → 검토 완료 (${penaltyCategoryLabel(confirmedOccurrence)} 확정)`;
}

// "스터디원 목록"의 참여자 뷰/퇴실자 뷰가 각자 손으로 복붙해 구현하던
// "상태 정보" 카드(준비 시험/계정/대시보드/시트 번호/최근 접속 일자·IP)를
// 공통 컴포넌트로 뽑았다 — 필드 순서나 라벨을 바꿀 때마다 두 파일을
// 매번 함께 고쳐야 했던 것이 실제 문제였다(사용자 지적: "참여자랑
// 퇴실자랑 UI가 겹치는 부분이 많은데 재활용되고 있는 상황이야?"). 대시보드
// 링크는 참여자 뷰에서만 쓰는 showingDummy 가드(더미 회원은 실제
// 회원번호가 아니라 링크를 걸지 않음)가 있어 옵션으로 받는다. 퇴실
// 예약일자 값은 두 뷰가 의미가 달라(참여자는 "신청됨~아직 처리 전"이라
// "접수됨" 같은 진행중 표현이 필요하고, 퇴실자는 이미 끝난 일이라 날짜만)
// 완성된 노드를 그대로 받는다. 퇴실 집행 일자는 퇴실자 전용이라 옵션.
export function MemberStatusInfoCard({
  examKind,
  googleAccount,
  gooroomeeAccount,
  dashboardHref,
  sheetHref,
  lastLoginAt,
  lastLoginIp,
  exitRequestDateValue,
  exitProcessedDateValue,
}: {
  examKind: string;
  googleAccount: string;
  gooroomeeAccount: string;
  /** undefined면 "대시보드" 행 값을 "-"로 표시(예: 목업 미리보기 중). */
  dashboardHref: string | undefined;
  /** undefined면 "시트 번호" 행 값을 "-"로 표시. */
  sheetHref: string | undefined;
  lastLoginAt: number | null | undefined;
  lastLoginIp: string;
  /** "퇴실 예약 일자" 행에 표시할 완성된 값(뷰마다 의미가 달라 노드로 받는다). */
  exitRequestDateValue: ReactNode;
  /** 있으면 "퇴실 예약 일자" 아래에 "퇴실 집행 일자" 행을 추가한다(퇴실자 뷰 전용). */
  exitProcessedDateValue?: ReactNode;
}) {
  return (
    <InfoCard className="flex flex-col gap-1.5 bg-card">
      <span className="flex items-center gap-1.5 text-sm font-semibold sm:text-base">
        <Hash className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
        상태 정보
      </span>
      <div className="flex flex-col gap-1.5 [&_span]:text-xs [&_span]:sm:text-sm">
        <SubRow label="준비 시험" value={examKind || "-"} />
        <SubRow label="구글 계정" value={googleAccount || "-"} />
        <SubRow label="구루미 계정" value={gooroomeeAccount || "-"} />
        <SubRow
          label="대시보드"
          value={
            dashboardHref ? (
              <a href={dashboardHref} className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline">
                바로가기
                <ExternalLink className="size-3 shrink-0" strokeWidth={ICON_STROKE.default} />
              </a>
            ) : (
              "-"
            )
          }
        />
        <SubRow
          label="시트 번호"
          value={
            sheetHref ? (
              <a
                href={sheetHref}
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
        <SubRow label="최근 접속 일자" value={lastLoginAt ? formatDateTime24h(lastLoginAt) : "-"} />
        <SubRow label="최근 접속 IP" value={lastLoginIp || "-"} />
        <SubRow label="퇴실 예약 일자" value={exitRequestDateValue} />
        {exitProcessedDateValue !== undefined && <SubRow label="퇴실 집행 일자" value={exitProcessedDateValue} />}
      </div>
    </InfoCard>
  );
}

// 🔧 [사용자 지시] "'퇴실유형'은 '강제 퇴실자', '정산 퇴실자'로만 출력해줘.
// () 내용은 지우자" — 예전엔 사유(reasons)를 괄호로 붙였으나, 이제
// kindStr 자체를 그대로 반환한다(사유 목록은 더 이상 표시하지 않음).
export function exitTypeLabel(kindStr: string): string {
  return kindStr;
}


// "정산 퇴실"/"직권 P 퇴실" 모달(ExitProcessDialog)의 미리보기와 "퇴실
// 스터디원 목록"(ExitedMemberRosterView)의 확정된 처리 결과가 "반환
// 예치금"/"차감 원인"/"처리 결과" 세 카드를 각자 복붙해 구현하고
// 있었다(사용자 지적: "UI 재활용이 가능하면 리팩토링해줘") — 두 화면이
// 참조하는 값(ExitPreviewResponse/ExitedMemberResult)이 kindStr·
// refundAmount·heldAmount·fineAlreadyPayment·breakdown·kind 등 필드
// 이름까지 동일해 그대로 공용 컴포넌트로 묶었다. 모달의 "반환 예치금"
// 카드가 목록과 값 크기가 달랐던 것(text-xs/sm vs text-sm/base)과, 모달의
// "처리 결과"에 있던 "반환 예치금"/"처리 일자"(다른 카드와 중복)를
// 목록 쪽 구성(귀속 예치금/납부된 벌금/퇴실 유형/블랙리스트)으로
// 맞췄다. 블랙리스트는 모달에서는 아직 확정 전이라 체크박스 상태를,
// 목록에서는 이미 저장된 값을 그대로 넘긴다 — 둘 다 없으면(undefined)
// "처리 결과" 카드에서 그 행을 생략한다(예: settle은 블랙리스트 개념이
// 없음).
export function ExitResultCards({
  kindStr,
  kind,
  refundAmount,
  heldAmount,
  fineAlreadyPayment,
  breakdown,
  blacklist,
}: {
  kindStr: string;
  kind: ExitKind;
  refundAmount: number;
  heldAmount: number;
  fineAlreadyPayment: number;
  breakdown: DepositRefundBreakdown;
  /** undefined면 "처리 결과" 카드에 블랙리스트 행을 표시하지 않는다. */
  blacklist?: boolean;
}) {
  // 🔧 [버그 수정] "페널티가 0회면 항목 자체가 사라진다" — 이전엔
  // rate===0인 penalty 항목을 통째로 걸러냈으나, 사용자 지적대로 다른
  // 항목(퇴실 통보 지연/30일 미만 참여)은 0%여도 항상 표시되는 것과
  // 일관되지 않았다. "항목 출력은 언제나 하되, 괄호 안에서 0건인
  // 텍스트만 출력하지 말라"는 것이 원래 의도였다 — 그 부분은 이미
  // mergePenaltyLabel이 처리하므로(각 P 종류별 0회 항목만 라벨에서
  // 생략), 여기서 항목 자체를 지우는 필터는 제거한다.
  const causeItems = mergePenaltyLabel(buildDepositCauseItems(breakdown, breakdown.lateNotice ? 50 : 0), breakdown, kind);

  return (
    <>
      <RefundAmountCard
        valueContent={won(refundAmount)}
        valueClassName={cn(
          "text-sm sm:text-base",
          refundAmount >= 10000 && "text-ok",
          refundAmount === 5000 && "text-amber-600 dark:text-amber-400",
          refundAmount === 0 && "text-destructive"
        )}
      />

      <DepositCauseCard items={causeItems} />

      <InfoCard className="flex flex-col gap-1.5 bg-card">
        <span className="flex items-center gap-1.25 text-sm font-semibold sm:text-base">
          <Eye className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
          처리 결과
        </span>
        <div className="flex flex-col gap-1.5 [&_span]:text-xs [&_span]:sm:text-sm">
          <SubRow label="귀속 예치금" value={won(heldAmount)} />
          <SubRow label="납부된 벌금" value={won(fineAlreadyPayment)} />
          <SubRow
            label="퇴실 유형"
            value={exitTypeLabel(kindStr)}
            valueClassName={
              kindStr === "강제 퇴실자" ? "text-destructive" : kindStr === "정산 퇴실자" ? "text-ok" : undefined
            }
          />
          {blacklist !== undefined && (
            <SubRow label="블랙리스트" value={blacklist ? "Y" : "N"} valueClassName={blacklist ? "text-destructive" : undefined} />
          )}
        </div>
      </InfoCard>
    </>
  );
}

export function ItemTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-sm font-semibold sm:text-base", className)}>{children}</span>;
}

export function FieldLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("text-xs font-medium text-muted-foreground sm:text-sm", className)}>{children}</span>
  );
}

export function FieldValue({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-xs font-semibold sm:text-sm", className)}>{children}</span>;
}

// 🔧 2026-09: 관리자 탭의 목록 섹션들(제보 확인/참여·퇴실 스터디원/예치금
// 재납 대상/사유 반휴 신청 등)이 전부 "loading && !items && <p>불러오는
// 중...</p>" 패턴이라, 응답이 오면 카드 여러 개가 한꺼번에 나타나 레이아웃이
// 크게 밀렸다(사용자 지적) — 실제 InfoCard 행과 비슷한 크기의 펄스
// 스켈레톤을 공통으로 만들어 재사용한다. rows는 목록이 평소 몇 줄 정도
// 보이는지에 맞춰 호출부가 조정한다.
export function AdminListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2 sm:gap-2.5" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <InfoCard key={i} className="flex animate-pulse items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="h-3.5 w-28 rounded bg-muted sm:h-4 sm:w-36" />
            <span className="h-3 w-40 rounded bg-muted sm:h-3.5 sm:w-52" />
          </div>
          <span className="h-7 w-16 shrink-0 rounded-md bg-muted sm:h-8 sm:w-20" />
        </InfoCard>
      ))}
    </div>
  );
}

// 🔧 [사용자 지시] "PEN·MONEY에서 사유 반휴 신청 처리가 내용이 없을 땐
// 작았다가 펼쳐지는데 눈에 띄네" — AdminListSkeleton(카드 3개 높이)이
// 뜨다가, 로딩이 끝나 실제로 항목이 0개면 텍스트 한 줄(py-6)로 확 줄어드는
// 낙차가 관리자 리스트 7곳(제보 검토/스터디원·퇴실자 목록/정산·벌금/
// 페널티 대상자/사유반휴 검토) 전부에 있었다. 빈 상태도 InfoCard + 같은
// 세로 패딩(py-8)을 줘 스켈레톤과 실제 데이터 사이 높이 차이를 줄인다.
export function AdminEmptyState({ children }: { children: ReactNode }) {
  return (
    <InfoCard className="flex items-center justify-center bg-card py-8">
      <p className="text-center text-sm text-muted-foreground sm:text-base">{children}</p>
    </InfoCard>
  );
}

// 🔧 [리팩토링, 2026-09-19] "스터디원 목록"/"퇴실 스터디원 목록"이 완전히
// 동일한 마크업(주석에도 "동일한 마크업을 그대로 재사용한다"고 명시)으로
// 각자 갖고 있던 이름 검색창을 공용화. placeholder만 도메인마다 다르다.
export function AdminSearchInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground sm:size-4"
        strokeWidth={ICON_STROKE.default}
      />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn("pl-9 sm:h-11 sm:pl-10 sm:text-base", className)}
      />
    </div>
  );
}

// 🔧 [리팩토링, 2026-09-19] 관리자 탭 4곳(벌금 납부/예치금 재납/사유 반휴/
// 화각 불량 제보)의 "요일별 그룹" 1차 토글이 바깥 골격(Collapsible 상태
// 관리 + InfoCard + CollapsibleTrigger의 className + ChevronDown + 펼침
// 패널 wrapper)을 완전히 동일하게 복붙해 갖고 있었다 — 이번 세션에서 실제로
// 겪은 뱃지 개행/토글 버그가 이 4곳에 각각 따로 있었던 근본 원인. 다만
// 헤더 안쪽(날짜 라벨 + 뱃지 나열)의 세부 구조는 화면마다 미묘하게 달라
// (예: ReportReviewList는 뱃지가 2행으로 줄바꿈되고 ChevronDown이 다른
// 위치에 있음) 그 부분까지 강제로 통일하면 오히려 각 화면의 실제 배치
// 의도를 왜곡할 위험이 있다 — 그래서 헤더 안쪽 콘텐츠는 `header` prop으로
// 그대로 받아 각 파일이 자유롭게 구성하게 하고, 100% 동일했던 바깥 골격만
// 공용화한다.
export function DayGroupHeader({
  isExpanded,
  onOpenChange,
  header,
  children,
}: {
  isExpanded: boolean;
  onOpenChange: (open: boolean) => void;
  /** CollapsibleTrigger 안에 그대로 렌더링되는 헤더 콘텐츠(날짜 라벨 + 뱃지들).
   * ChevronDown은 이 컴포넌트가 자동으로 붙이므로 포함하지 않는다. */
  header: ReactNode;
  /** CollapsiblePanel 안에 펼쳐질 때 보여줄 내용(회원별 상세 목록 등). */
  children: ReactNode;
}) {
  return (
    <Collapsible open={isExpanded} onOpenChange={onOpenChange}>
      <InfoCard className="flex flex-col gap-2.5 bg-card">
        <CollapsibleTrigger
          className="flex items-center justify-between gap-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded"
          hideChevron
        >
          {header}
          <ChevronDown
            className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isExpanded && "rotate-180")}
            strokeWidth={ICON_STROKE.default}
          />
        </CollapsibleTrigger>
        <CollapsiblePanel className="flex flex-col">
          <div className="flex flex-col gap-2.5 pt-2.5">{children}</div>
        </CollapsiblePanel>
      </InfoCard>
    </Collapsible>
  );
}

// 관리자 탭에서 접이식 섹션 하나를 감싸는 카드. 회색 배경(bg-muted)을 쓰면
// 내용물이 흐리게 보여 비활성화된 것처럼 착시가 생기므로, 배경은 부모
// Card와 같은 흰 바탕(bg-card)을 유지하고 테두리로만 섹션 경계를 드러낸다.
// 🔧 [여백 확보, 2026-09] AppShell 좌우 여백을 모바일에서 줄여 폭을
// 넓힌 뒤(사용자 지시), 그만큼 카드 안쪽이 상대적으로 답답해 보인다는
// 🔧 [여백 재조정, 2026-09] 가독성을 위해 한 단계 키웠던 패딩(p-3.5→p-4,
// sm:p-4→sm:p-5)이, 그 안에 다시 패딩을 갖는 개별 항목 카드와 겹쳐 좌우
// 실사용 폭 손실이 크다는 피드백(사용자 지시: "쓸데없이 여백이 너무 크다")
// 으로 원래 값의 2/3 수준(사용자 지시)으로 되돌렸다.
// 🔧 [사용자 지시, 되돌림] 제목-본문 경계를 단순 구분선(hr) 대신 "카드
// 안의 탭"처럼 보이게 하려고 한때 이 카드의 패딩 자체를 없앤 적이 있는데,
// SectionCard는 SectionHeader와 항상 짝을 이루는 게 아니라 단독 콘텐츠
// 박스로도 널리 쓰인다(예: ReportPage의 "제보 대상자" 폼,
// ActiveReportsSection의 "최근 진행된 제보") — 그런 곳들은 헤더가 없어
// 패딩을 보정할 데가 없어 카드가 완전히 납작해졌다(사용자 지적: "제보
// 대상자를 감싸는 박스가 비정상"). 패딩은 이 카드에 그대로 두고, 대신
// SectionHeader 쪽에서 음수 마진으로 자기 배경만 이 패딩 바깥까지
// 넓혀 탭처럼 보이게 한다 — 그러면 헤더 없는 단순 콘텐츠 카드는 영향을
// 받지 않는다.
export function SectionCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-xl border border-border bg-card p-2.5 sm:p-3.5", className)}>
      {children}
    </div>
  );
}

// 🔧 [사용자 지시, 되돌림] 새로고침 버튼 테두리를 도는 원형 게이지였는데,
// "배경색이 끝나는 지점에 가로 게이지로" 표현하길 원해 SectionHeader
// 탭 배경 맨 아래(하단 경계선 자리)에 까는 얇은 가로 바로 바꿨다.
// progress는 0(방금 갱신, 비어있음)에서 1(다음 갱신 직전, 가득 참)로
// 늘어난다 — usePollingRefresh가 반환하는 값(1→0, 남은 비율)을
// SectionHeader에서 1에서 빼 "채워지는 방향"으로 뒤집어 전달한다.
function RefreshProgressBar({ progress }: { progress: number }) {
  const filled = Math.max(0, Math.min(1, progress)) * 100;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px] overflow-hidden bg-black/5 dark:bg-white/10">
      <div
        className="h-full bg-primary/70"
        style={{ width: `${filled}%`, transition: "width 1s linear" }}
      />
    </div>
  );
}

// 관리자 탭의 각 현황 섹션 공통 헤더 — 제목(펼침/접힘 토글 겸)과 새로고침 버튼.
// 새로고침 버튼은 CollapsibleTrigger 바깥에 두어 클릭 시 섹션이 접히지 않게 한다.
// onRefresh가 없는 섹션(예: 신규 등록 폼처럼 서버에서 다시 불러올 목록이 없는
// 경우)은 버튼 자리를 비워두고 chevron만 우측에 남긴다 — 다른 섹션과 chevron
// 위치를 맞추기 위해 버튼 크기(size-7)만큼의 빈 공간을 유지한다.
// refreshProgress(usePollingRefresh가 반환하는 "다음 갱신까지 남은 비율",
// 1=방금 갱신~0=갱신 직전)를 넘기면 자동 폴링까지 남은 시간을 버튼 테두리에
// 원형 게이지로 함께 보여준다 — 폴링을 쓰지 않는 섹션은 생략. 게이지 자체는
// 반대 방향(0=비어있음~1=가득 참)으로 채워지므로 여기서 뒤집어 전달한다.
export function SectionHeader({
  icon: Icon,
  title,
  loading,
  onRefresh,
  refreshProgress,
  refreshDisabled,
  refreshDisabledReason,
  trailing,
}: {
  icon: LucideIcon;
  title: string;
  loading?: boolean;
  onRefresh?: () => void;
  refreshProgress?: number;
  /** true면 로딩 중이 아니어도 버튼을 비활성화한다 — "지금 눌러도 의미
   * 없다"는 신호를 통일된 방식으로 준다. 두 가지 근거로 쓰인다: (1) 서버
   * 캐시 TTL이 아직 안 지나 눌러도 같은 캐시값만 돌아오는 경우(예: "내
   * 대시보드"의 personalStatusBundle: TTL, 시간 기반 예측) — 기본은
   * 비활성화가 아니라 활성화이고 TTL 안에서만 비활성화된다. (2) 캐시가
   * 없어 시간으로 신선도를 예측할 수 없는 화면에서, 배경 폴링이 "새로
   * 볼 게 있다"를 감지했을 때만 활성화하는 경우(예: "내 제보 확인") —
   * 기본이 비활성화이고 감지됐을 때만 활성화된다. 생략하면 기존 동작과
   * 동일(loading일 때만 비활성화). */
  refreshDisabled?: boolean;
  /** refreshDisabled가 true일 때 보여줄 이유(버튼 title 툴팁). */
  refreshDisabledReason?: string;
  /** 🔧 [사용자 지시] "관리자 드롭다운을 헤더 영역에 넣어버릴 수 있나?" —
   * 제목과 새로고침 버튼 사이에 임의 콘텐츠(회원 선택 Select 등)를 끼워
   * 넣기 위한 옵셔널 슬롯. 생략하면 기존 20여 곳의 사용처와 완전히
   * 동일하게 렌더링된다. */
  trailing?: ReactNode;
}) {
  // 🔧 [사용자 지시] 제목-본문 경계를 hr 구분선 대신 "카드 안의 탭"처럼
  // 보이게 한다 — 헤더 영역에 은은한 배경을 입히되, SectionCard가
  // 자체 패딩(p-2.5 sm:p-3.5)을 유지하므로 이 배경이 그 패딩 안쪽에만
  // 칠해지면 카드 가장자리까지 닿지 않아 탭처럼 안 보인다 — 음수 마진으로
  // 배경을 부모 패딩 바깥(카드 가장자리)까지 넓히고, 넓힌 만큼 자체 패딩을
  // 다시 줘 안쪽 콘텐츠 위치는 그대로 유지한다. SectionCard가
  // overflow-hidden이라 이 배경도 카드 위쪽 모서리 둥글기에 맞춰 자동으로
  // 잘린다. 🔧 [버그 수정] 이 헤더를 담는 Collapsible이 gap 없이
  // (flex flex-col) 배치되다 보니, 탭 배경이 끝나는 지점에 바로 본문이
  // 붙어버려 여백 없이 딱 붙은 것처럼 보였다(사용자 지적) — mb로 헤더
  // 자신이 하단 여백을 갖게 해 모든 사용처(16곳)에서 한 번에 해결한다.
  // 🔧 [사용자 지시] 배경을 회색(bg-muted)에서 아이보리 톤의 따뜻한
  // 색(bg-section-header — index.css 전용 토큰, 낮은 채도 크림/브라운)
  // 으로 변경. 기존 --accent는 primary와 같은 코랄 계열이라 채도가 높아
  // "주황색"으로 보였다(사용자 지적) — 뱃지 등과 공유하는 --accent 대신
  // 이 헤더 전용 토큰을 쓴다. relative를 추가해 아래 RefreshProgressBar
  // (절대 위치)가 이 배경 하단 경계선에 정확히 깔리도록 한다.
  // 🔧 [사용자 지시] 시안처럼 상하 여백을 조금 더 넉넉하게 — 1차
  // 조정(py-2→2.5, sm:py-2.5→3)이 시안 대비 아직 부족하다는 피드백으로
  // 한 단계 더 키웠다(py-3, sm:py-3.5) — 앱 전체 20여 곳에 공통 적용.
  return (
    <div className="relative -mx-2.5 -mt-2.5 mb-3.5 flex items-center justify-between gap-2 bg-section-header px-2.5 py-3 sm:-mx-3.5 sm:-mt-3.5 sm:mb-4 sm:px-3.5 sm:py-3.5">
      {/* 🔧 [사용자 지시] "전체 헤더 영역의 버튼 순서를 ^ 새로고침 → 새로고침
          ^ 순으로 바꿔" — trailing 유무와 무관하게 제목 트리거의 chevron은
          항상 숨기고(hideChevron), 새로고침 버튼 뒤에 chevron만 보이는
          두 번째 트리거를 둔다 — 같은 Collapsible.Root 아래 트리거는
          여러 개 둬도 동일한 열림 상태를 함께 토글하므로 어느 쪽을
          눌러도 똑같이 펼쳐진다. 두 번째 트리거의 제목 텍스트는 화면엔
          안 보이되(sr-only) 스크린 리더용 라벨로 남긴다. */}
      <CollapsibleTrigger className={trailing ? "w-auto shrink-0" : "flex-1"} hideChevron>
        <span className="flex items-center gap-2 text-sm font-semibold sm:text-base">
          <Icon className="size-4 shrink-0 text-primary sm:size-5" strokeWidth={ICON_STROKE.default} />
          {title}
        </span>
      </CollapsibleTrigger>
      {trailing && <span className="flex-1" aria-hidden="true" />}
      {trailing}
      {onRefresh ? (
        <Button
          variant="outline"
          size="icon-sm"
          className="shrink-0"
          onClick={onRefresh}
          disabled={loading || refreshDisabled}
          aria-label="새로고침"
          title={!loading && refreshDisabled ? refreshDisabledReason : undefined}
        >
          <RotateCw className={cn("size-3.5", loading && "animate-spin")} strokeWidth={ICON_STROKE.default} />
        </Button>
      ) : (
        <span className="size-7 shrink-0" aria-hidden="true" />
      )}
      <CollapsibleTrigger className="w-auto shrink-0">
        <span className="sr-only">{title}</span>
      </CollapsibleTrigger>
      {/* 🔧 [사용자 지시] 새로고침 진행률을 버튼 테두리 원형 게이지 대신
          "배경색이 끝나는 지점"인 탭 하단 경계선에 가로 바로 표현한다. */}
      {refreshProgress !== undefined && !loading && <RefreshProgressBar progress={1 - refreshProgress} />}
    </div>
  );
}

// 화각 제보로 봇이 캡처한 파일(스크린샷/영상)은 봇 로컬 디스크에만 있고
// Worker가 Cloudflare Tunnel로 그때그때 프록시해서 가져온다. 목록/이력에는
// 메타데이터만 담고, 실제 파일 바이트는 열람 시 별도로 fetch()해서 blob으로
// 받는다. 이미지/영상 여부는 별도 필드로 저장하지 않고 응답 blob의 MIME
// 타입으로 판정한다 — "송출 P 제보 확인"(대기 중 제보)와 "예치금 재납
// 대상자"(이미 승인된 이력)가 동일하게 재사용한다.
export function CapturePreview({
  id,
  token,
  endpoint = "/admin/captures/file",
}: {
  id: string;
  token: string;
  // 화각 제보 캡처("/admin/captures/file")와 사유반휴 증빙("/admin/leave-proof/file")이
  // 동일한 fetch-blob 패턴을 공유하되 조회 경로만 다르다.
  endpoint?: string;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [isVideo, setIsVideo] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;

    fetch(`${WORKER_BASE}${endpoint}?id=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error("파일을 불러오지 못했습니다.");
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setIsVideo(blob.type.startsWith("video/"));
        setBlobUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, token, endpoint]);

  // 로딩·에러 상태에서도 실제 미디어와 같은 비율의 박스를 유지해, 미리보기가
  // 나타나기 전후로 카드 높이가 출렁이지 않게 한다.
  if (error) {
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed bg-muted">
        <p className="text-xs text-destructive sm:text-sm">미리보기를 불러오지 못했습니다.</p>
      </div>
    );
  }
  if (!blobUrl) {
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed bg-muted">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (isVideo) {
    return (
      // 스터디원이 업로드한 제보 영상(사용자 생성 콘텐츠)이라 자막 트랙을
      // 붙일 방법이 없다 — 관리자가 직접 화면 내용을 확인하는 용도.
      // oxlint-disable-next-line jsx-a11y/media-has-caption
      <video
        src={blobUrl}
        controls
        className="aspect-video w-full rounded-lg bg-black object-contain"
      />
    );
  }
  return (
    <Dialog>
      <DialogTrigger className="block w-full overflow-hidden rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50">
        <img
          src={blobUrl}
          alt="제보 캡처"
          className="aspect-video w-full cursor-zoom-in bg-black object-contain"
        />
      </DialogTrigger>
      <DialogContent className="max-w-3xl bg-black p-2 [&>button]:rounded-full [&>button]:bg-black/60 [&>button]:text-white [&>button]:opacity-100">
        <img src={blobUrl} alt="제보 캡처 확대" className="w-full rounded-lg object-contain" />
      </DialogContent>
    </Dialog>
  );
}

// "송출 P 1차"/"주간 P 1차" 같은 기본 라벨의 "N차"를 괄호로 묶는다
// ("페널티 1차" → "페널티 (1차)") — 조치명과 차수를 시각적으로 구분한다.
export function parenthesizeOccurrence(label: string): string {
  return label.replace(/\s*(\d+차)$/, " ($1)");
}

// 슬롯 주석에 남긴 발생일시 문자열("2026. 8. 25. 오후 3:41:46 · 사유")에서
// 날짜만 잘라 "8월 25일" 형태로 보여준다. 파싱에 실패하면 원본을 그대로 둔다.
export function dateOnlyLabel(when: string): string {
  const m = /^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\./.exec(when);
  if (!m) return when || "-";
  return `${parseInt(m[2], 10)}월 ${parseInt(m[3], 10)}일`;
}

// 페널티 슬롯 이력 한 줄을 눌렀을 때 뜨는 모달 — 대시보드 타일(예치금
// 반환·총 페널티 등)을 누르면 뜨는 모달과 같은 톤으로 맞춘다: DialogTitle에
// Search 아이콘 + "· 세부사항", 본문은 InfoCard 박스 안에 아이콘+제목 헤더.
// 슬롯 주석에는 발신/회신 시각·차감분이 남지 않으므로 "시간 차감"은 넣지
// 않는다. 제보자는 비밀이라 표시하지 않는다. captureId가 있는 이력(캡처ID
// 기록 기능 이후 생성된 것)만 "스크린샷 · 영상" 섹션을 보여준다 — 이전
// 이력은 캡처와의 연결이 없다. 관리자 "예치금 재납 대상자"와 개인 대시보드
// "총 페널티" 모달이 동일하게 재사용한다.
export function PenaltyHistoryDetailDialog({
  label,
  entry,
  token,
  children,
}: {
  label: string;
  entry: PenaltySlotHistoryEntry;
  token: string | undefined;
  children: ReactNode;
}) {
  return (
    <Dialog>
      <DialogTrigger className="rounded text-micro-lg tabular-nums text-muted-foreground underline decoration-dotted underline-offset-2 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50 sm:text-xs">
        {children}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Search className="size-4 text-primary sm:size-5" />
            {label} · 세부사항
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {entry.captureId && (
            <InfoCard className="flex flex-col gap-1.5 bg-card">
              <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
                <ImageIcon className="size-3.5 shrink-0 text-muted-foreground sm:size-4" />
                스크린샷 · 영상
              </span>
              {token ? (
                <CapturePreview id={entry.captureId} token={token} />
              ) : (
                <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed bg-muted">
                  <p className="text-xs text-muted-foreground sm:text-sm">미리보기를 불러오지 못했습니다.</p>
                </div>
              )}
            </InfoCard>
          )}

          <InfoCard className="flex flex-col gap-1.5 bg-card">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <FileText className="size-3.5 shrink-0 text-muted-foreground sm:size-4" />
              제보 정보
            </span>
            <SubRow label="사유" value={entry.reason || "-"} />
            <SubRow label="발생일시" value={entry.when || "-"} />
          </InfoCard>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// "송출 P 원인"/"주간 P 원인" 같은 슬롯 이력 섹션 — 채워진 슬롯마다 한 줄로
// 나열한다. 우측에는 날짜만 보여주고, 누르면 상세(제보 정보) 모달이 뜬다.
// slotLabels가 있으면(송출 P 1~6차 → 구두경고/벌점/페널티) 그 순서대로 쓰고,
// 없으면(주간 P) 기본 라벨의 "N차"만 괄호로 묶어 그대로 쓴다. 라벨이
// "페널티" 또는 "주간 P"로 시작하면(둘 다 실제 페널티로 이어지는 슬롯)
// 빨간색으로 강조한다.
export function PenaltyHistorySection({
  icon: Icon,
  title,
  history,
  slotLabels,
  token,
}: {
  icon: LucideIcon;
  title: string;
  history: PenaltySlotHistoryEntry[];
  slotLabels?: string[];
  token: string | undefined;
}) {
  const entries = history || [];
  return (
    <div className="flex flex-col gap-1.5">
      {/* 🔧 2026-09: 이 제목이 SubRow(§FieldLabel 크기 미만, 11/12px 기본값)
          와 거의 같은 크기(12/14px)라 위계가 잘 안 읽혔다 — 위 4단 체계의
          ItemTitle(14/16px)로 올렸다. TotalPenaltyDialog(회원용)와
          PenaltyCandidateList(관리자용) 둘 다 이 컴포넌트를 공유하므로
          한 번에 적용된다. */}
      <span className="inline-flex items-center gap-1.25">
        <Icon className="size-3.5 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
        <ItemTitle>{title}</ItemTitle>
      </span>
      {/* 🔧 2026-09 재정정: "-" 가짜 값 문제를 고친 뒤에도 여전히 위계가
          안 맞아 보인다는 지적을 받았다 — 원인은 크기였다. SubRow
          기본값(text-micro-lg sm:text-xs, 11/12px)을 그대로 뒀는데,
          MeritBreakdownDialog의 동급 하위 항목("주간 학습시간 상점" 등)은
          labelClassName/valueClassName으로 text-xs sm:text-sm(12/14px)로
          이미 키워서 쓰고 있었다 — 같은 "카드 제목 밑 하위 항목" 역할인데
          이 컴포넌트만 더 작은 기본값에 머물러 있었던 것(사용자 지적,
          두 화면 직접 비교로 확인). 크기를 맞춘다. */}
      {entries.length === 0 ? (
        <SubRow label="해당 없음" value="" labelClassName="text-xs sm:text-sm" />
      ) : (
        entries.map((entry, i) => {
          const label = slotLabels?.[i] ?? parenthesizeOccurrence(entry.label);
          const isPenalty = label.startsWith("페널티") || label.startsWith("주간 P");
          return (
            <SubRow
              key={entry.label}
              label={label}
              labelClassName={cn("text-xs sm:text-sm", isPenalty && "font-semibold text-destructive")}
              valueClassName="text-xs sm:text-sm"
              value={
                <PenaltyHistoryDetailDialog label={label} entry={entry} token={token}>
                  {dateOnlyLabel(entry.when)}
                </PenaltyHistoryDetailDialog>
              }
            />
          );
        })
      )}
    </div>
  );
}
