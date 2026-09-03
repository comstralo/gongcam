import { useEffect, useState, type ReactNode } from "react";
import { DoorOpen, TriangleAlert, CircleCheck, Circle, MessageSquareWarning, Eye, PiggyBank, TrendingDown, ArrowRightLeft, ClipboardList } from "lucide-react";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { InfoCard, SubRow, buildDepositCauseItems } from "@/components/dashboard/shared";
import { FieldValue } from "@/components/admin/shared";
import { useApi } from "@/hooks/useApi";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { ExitCandidate, ExitCheckItem, ExitKind, ExitPreviewResponse, ExitConfirmResponse } from "@/lib/api/types";

function won(n: number) {
  return `₩${(n || 0).toLocaleString()}`;
}

// MemberRosterList(전체 명단)와 PenaltyCandidateList(예치금 재납 대상자) 둘
// 다 이 다이얼로그를 쓰지만, 서로 다른 타입(MemberRosterEntry/ExitCandidate)의
// 항목을 넘긴다. 이 다이얼로그가 실제로 쓰는 필드만 최소 타입으로 요구해야
// 두 목록 타입이 각자 필요한 필드만 갖고도 호환된다.
type ExitProcessCandidate = Pick<ExitCandidate, "number" | "name" | "suggestedKind" | "allChecks">;

const KIND_LABEL: Record<ExitKind, string> = {
  forced: "강제 퇴실자",
  admin_forced: "직권 퇴실자",
  settle: "정산 퇴실자",
  deposit_again: "예치금 재납자",
};

// 강제퇴실 조건 전체(해당 여부 무관)를 체크리스트 형태로 보여준다.
// 해당되는 항목만 강조(체크 아이콘, destructive 색)하고, 나머지는 무채색으로
// 그대로 나열해 관리자가 "왜 이 사람이 대상이 됐는지/안 됐는지"를 한눈에 본다.
function ForcedExitChecklist({ checks }: { checks: ExitCheckItem[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {checks.map((c) => (
        <li
          key={c.code}
          className={cn(
            "flex items-start gap-1.5 text-xs sm:text-sm",
            c.met ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {c.met ? (
            <CircleCheck className="size-3.5 shrink-0 translate-y-0.5" />
          ) : (
            <Circle className="size-3.5 shrink-0 translate-y-0.5" />
          )}
          <span>{c.label}</span>
        </li>
      ))}
    </ul>
  );
}

export function ExitProcessDialog({
  candidate,
  onConfirmed,
  triggerClassName,
  lockKind,
  lockForcedReason,
  children,
}: {
  candidate: ExitProcessCandidate;
  // 실제로 확정된 유형(forced/admin_forced/settle/deposit_again)을 함께
  // 넘긴다 — 호출부(PenaltyCandidateList 등)가 "이 회원이 강퇴로 처리됐는지
  // 재납으로 처리됐는지"를 화면 상태로 구분해 보여줘야 하기 때문이다.
  onConfirmed?: (kind: ExitKind) => void;
  triggerClassName?: string;
  // 페널티 2 이상은 반환율이 항상 0%로 고정되는 정산 퇴실자(settle) 단일
  // 경로라, PENALTY 탭에서는 유형 선택 UI 자체를 숨기고 이 값으로 고정한다.
  lockKind?: ExitKind;
  // admin_forced 전용 — 호출부가 사유를 이미 알고 있을 때(예: Money 탭의
  // "직권 P"는 항상 "벌금 시한 내 미납자") 입력란을 그 값으로 고정하고
  // 편집을 막는다. 없으면 기존처럼 관리자가 자유롭게 입력한다.
  lockForcedReason?: string;
  children: ReactNode;
}) {
  const { call } = useApi();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ExitKind>(lockKind ?? candidate.suggestedKind);
  const [forcedReason, setForcedReason] = useState(lockForcedReason ?? "");
  // 🔧 [블랙리스트 등록] 직권 P는 강제퇴실 중 가장 강한 방식(상대 동의 없이
  // 즉시 내쫓음)이라, 확정 처리 시 블랙리스트 등록 여부를 함께 표시할 수
  // 있게 한다(사용자 지시). 미리보기(handlePreview)에는 영향이 없고,
  // 확정 처리(handleConfirm) 시점에만 body에 실어 보낸다 — 이 값 자체가
  // discountRatio/반환액 계산에 관여하지 않기 때문.
  const [blacklist, setBlacklist] = useState(false);
  // 🔧 [직권 P 퇴실 전용 UI] 이 처리는 관리자가 사유만 입력하면 바로
  // 확정할 수 있는 단순한 흐름이라, 다른 유형(강제/정산/재납)과 공유하는
  // "처리 유형 선택 → 미리보기 계산 → 확정" 단계를 그대로 노출할 필요가
  // 없다(사용자 지적) — discountRatio가 이미 항상 1(0% 반환)로 고정되어
  // 있어 미리보기가 보여줄 새로운 정보도 없다.
  const isAdminForcedOnly = lockKind === "admin_forced";
  // 🔧 [정산 퇴실 전용 UI] 이 처리는 "미리보기 계산" 버튼을 별도로 눌러야
  // 하는 단계가 필요 없다 — 처리 유형이 이미 settle로 고정돼 있어 다이얼로그가
  // 열리자마자 바로 계산해 보여줄 수 있다(사용자 지적: "미리보기 계산을
  // 눌러서 뜨게 하지 말고 바로 표시해").
  const isSettleOnly = lockKind === "settle";

  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<ExitPreviewResponse | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetForNewKind(next: ExitKind) {
    setKind(next);
    setPreview(null);
    setError(null);
  }

  async function handlePreview() {
    setPreviewing(true);
    setError(null);
    setPreview(null);
    try {
      const data = await call<ExitPreviewResponse>("/admin/exit/preview", {
        method: "POST",
        body: { number: candidate.number, kind, forcedReason: kind === "admin_forced" ? forcedReason : undefined },
      });
      setPreview(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "미리보기 계산에 실패했습니다.");
    } finally {
      setPreviewing(false);
    }
  }

  useEffect(() => {
    if (open && isSettleOnly && !preview && !previewing) {
      handlePreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isSettleOnly]);

  // admin_forced도 settle과 동일하게 미리보기 카드를 보여준다. discountRatio가
  // 사유 여부와 무관하게 항상 0% 반환으로 고정이라, 서버(calcAdminForcedExit)도
  // 이제 사유 없이 계산을 허용한다 — 모달이 열리자마자(사유 미입력 상태에서도)
  // 바로 계산 결과가 보이도록 settle과 동일하게 open 시점에 1회 즉시 계산하고,
  // 이후 사유를 타이핑할 때마다(사유가 결과 문구에 반영되므로) 300ms
  // 디바운스로 재계산한다. 열릴 때 이 두 효과가 동시에 도니 첫 렌더에서
  // 중복 호출되지 않도록, "아직 한 번도 계산 안 한 최초 오픈"만 여기서
  // 즉시 처리하고 디바운스 효과에서는 그 몫을 건너뛴다.
  useEffect(() => {
    if (open && isAdminForcedOnly && !preview && !previewing) {
      handlePreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isAdminForcedOnly]);

  useEffect(() => {
    if (!open || !isAdminForcedOnly || (!preview && !previewing)) return;
    const timer = setTimeout(() => {
      handlePreview();
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isAdminForcedOnly, forcedReason]);

  async function handleConfirm() {
    setConfirming(true);
    setError(null);
    try {
      await call<ExitConfirmResponse>("/admin/exit/confirm", {
        method: "POST",
        body: {
          number: candidate.number,
          kind,
          forcedReason: kind === "admin_forced" ? forcedReason : undefined,
          blacklist: kind === "admin_forced" ? blacklist : undefined,
        },
      });
      setConfirmed(true);
      onConfirmed?.(kind);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "확정 처리에 실패했습니다.");
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setPreview(null);
          setError(null);
          setConfirmed(false);
          setForcedReason(lockForcedReason ?? "");
          setKind(lockKind ?? candidate.suggestedKind);
          setBlacklist(false);
        }
      }}
    >
      <DialogTrigger
        className={cn(
          "w-full rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
          triggerClassName
        )}
      >
        {children}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <DoorOpen className="size-4 text-primary sm:size-5" />
            {isAdminForcedOnly ? (
              <>직권 P 퇴실 처리 · {candidate.name}</>
            ) : isSettleOnly ? (
              <>정산 퇴실자 처리 · {candidate.name}</>
            ) : (
              <>{candidate.name} · 퇴실·재납 처리</>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {confirmed ? (
            <Alert>
              <AlertDescription>
                처리가 완료되었습니다. 시트가 백업 탭으로 옮겨지고 원래 슬롯은 초기화되었습니다.
              </AlertDescription>
            </Alert>
          ) : isAdminForcedOnly ? (
            <>
              <InfoCard className="flex flex-col gap-1.5">
                <Label
                  htmlFor="forced-reason"
                  className="flex items-center gap-1.25 text-xs font-semibold text-muted-foreground sm:text-sm"
                >
                  <MessageSquareWarning className="size-3.5 shrink-0 sm:size-4" />
                  직권 퇴실 사유
                </Label>
                <Input
                  id="forced-reason"
                  value={forcedReason}
                  onChange={(e) => setForcedReason(e.target.value)}
                  placeholder="예: 비매너 행위로 인한 즉시 퇴실"
                  className="sm:h-12 sm:text-base"
                  readOnly={lockForcedReason !== undefined}
                />
                {/* 🔧 [블랙리스트 등록] 직권 P는 상대 동의 없이 즉시 내쫓는
                    강제퇴실 중 가장 강한 방식이라, 확정 시 블랙리스트로도
                    함께 등록할지 여기서 고를 수 있게 한다(사용자 지시).
                    확정(handleConfirm)에서만 body에 실리고 미리보기 계산
                    (반환액 등)에는 영향을 주지 않는다. */}
                <Label className="mt-1 justify-start">
                  <Checkbox checked={blacklist} onCheckedChange={(c) => setBlacklist(c === true)} />
                  <span className="text-xs font-medium sm:text-sm">블랙리스트로 등록하시겠습니까?</span>
                </Label>
              </InfoCard>

              {previewing && !preview && (
                <p className="py-4 text-center text-sm text-muted-foreground sm:text-base">계산 중...</p>
              )}

              {/* 🔧 정산(settle) 미리보기와 동일한 카드 구성 — 직권 P도
                  반환율이 이미 0%로 고정돼 있을 뿐, 계산 결과 형태는
                  같아서 그대로 재사용한다(사용자 요청: "직권 P 모달에도
                  정산 모달과 같은 내용을 보여달라"). 단, 직권 P는 동의를
                  기다릴 필요가 없는 즉시 처리라 "확정 처리" 버튼은
                  agreedAt과 무관하게 forcedReason만 있으면 바로 활성화된다
                  (아래 버튼 참고). */}
              {preview && (
                <InfoCard className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
                    <PiggyBank className="size-3.5 shrink-0 sm:size-4" />
                    반환 예치금
                  </span>
                  <span
                    className={cn(
                      "text-xs sm:text-sm",
                      preview.refundAmount >= 5000 && "text-ok",
                      preview.refundAmount === 0 && "text-destructive"
                    )}
                  >
                    {won(preview.refundAmount)}
                  </span>
                </InfoCard>
              )}

              {preview && preview.breakdown && (
                <InfoCard className="flex flex-col gap-1.5">
                  <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
                    <TrendingDown className="size-3.5 shrink-0 sm:size-4" />
                    차감 원인
                  </span>
                  {buildDepositCauseItems(preview.breakdown, preview.breakdown.lateNotice ? 50 : 0).map((item) => (
                    <SubRow
                      key={item.key}
                      label={item.label}
                      value={`${item.rate}%`}
                      valueClassName={cn("font-sans", item.rate > 0 && "text-destructive")}
                    />
                  ))}
                </InfoCard>
              )}

              {preview && (
                <InfoCard className="flex flex-col gap-1.5">
                  <span className="flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                    <Eye className="size-3.5 shrink-0 sm:size-4" />
                    처리 결과
                  </span>
                  <SubRow label="반환 예치금" value={won(preview.refundAmount)} />
                  <SubRow label="귀속 예치금" value={won(preview.heldAmount)} />
                  <SubRow label="주간 납부 벌금" value={won(preview.fineAlreadyPayment)} />
                  <SubRow label="처리일자" value={preview.processedDate} />
                </InfoCard>
              )}

              {preview && (
                <InfoCard className="flex flex-col gap-1.5">
                  <span className="flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                    <ArrowRightLeft className="size-3.5 shrink-0 sm:size-4" />
                    시트 변동사항
                  </span>
                  <SubRow label="(집계) 퇴실자 벌금" value={`${won(preview.fineOuter)} → ${won(preview.newFineOuter)}`} />
                  <SubRow label="(집계) 퇴실자 예치금" value={`${won(preview.depositOuter)} → ${won(preview.newDepositOuter)}`} />
                </InfoCard>
              )}

              <InfoCard className="flex flex-col gap-1 border-destructive/30 bg-destructive/5">
                <div className="flex items-center gap-1.5 text-destructive">
                  <TriangleAlert className="size-3.5 shrink-0 sm:size-4" />
                  <span className="text-xs font-semibold sm:text-sm">주의사항</span>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
                  확정하면 현재 시트가 백업 탭으로 옮겨지고 원래 슬롯이 초기화됩니다. 되돌릴 수 없으니
                  내용을 다시 확인한 뒤 진행하세요.
                </p>
              </InfoCard>

              <Button
                className="w-full sm:h-12 sm:text-base"
                variant="destructive"
                disabled={confirming || !forcedReason.trim()}
                onClick={handleConfirm}
              >
                {confirming ? "처리 중..." : "확정 처리"}
              </Button>
            </>
          ) : isSettleOnly ? (
            <>
              {previewing && !preview && (
                <p className="py-4 text-center text-sm text-muted-foreground sm:text-base">계산 중...</p>
              )}

              {preview && (
                <InfoCard className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
                    <PiggyBank className="size-3.5 shrink-0 sm:size-4" />
                    반환 예치금
                  </span>
                  <span
                    className={cn(
                      "text-xs sm:text-sm",
                      preview.refundAmount >= 5000 && "text-ok",
                      preview.refundAmount === 0 && "text-destructive"
                    )}
                  >
                    {won(preview.refundAmount)}
                  </span>
                </InfoCard>
              )}

              {/* 🔧 [DepositRefundDialog와 동일한 차감 원인 카드] 정산
                  퇴실은 이미 확정된 퇴실 신청 건이라, 고지지연 여부는
                  선택 중인 날짜가 아니라 서버가 이미 판정한 breakdown.
                  lateNotice를 그대로 신뢰한다. */}
              {preview && preview.breakdown && (
                <InfoCard className="flex flex-col gap-1.5">
                  <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
                    <TrendingDown className="size-3.5 shrink-0 sm:size-4" />
                    차감 원인
                  </span>
                  {buildDepositCauseItems(preview.breakdown, preview.breakdown.lateNotice ? 50 : 0).map((item) => (
                    <SubRow
                      key={item.key}
                      label={item.label}
                      value={`${item.rate}%`}
                      valueClassName={cn("font-sans", item.rate > 0 && "text-destructive")}
                    />
                  ))}
                </InfoCard>
              )}

              {preview && (
                <InfoCard className="flex flex-col gap-1.5">
                  <span className="flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                    <Eye className="size-3.5 shrink-0 sm:size-4" />
                    처리 결과
                  </span>
                  <SubRow label="반환 예치금" value={won(preview.refundAmount)} />
                  <SubRow label="귀속 예치금" value={won(preview.heldAmount)} />
                  <SubRow label="주간 납부 벌금" value={won(preview.fineAlreadyPayment)} />
                  <SubRow label="처리일자" value={preview.processedDate} />
                </InfoCard>
              )}

              {preview && (
                <InfoCard className="flex flex-col gap-1.5">
                  <span className="flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                    <ArrowRightLeft className="size-3.5 shrink-0 sm:size-4" />
                    시트 변동사항
                  </span>
                  <SubRow label="(집계) 퇴실자 벌금" value={`${won(preview.fineOuter)} → ${won(preview.newFineOuter)}`} />
                  <SubRow label="(집계) 퇴실자 예치금" value={`${won(preview.depositOuter)} → ${won(preview.newDepositOuter)}`} />
                </InfoCard>
              )}

              {preview && preview.exitProcess && (
                <InfoCard className="flex flex-col gap-1.5">
                  <span className="flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
                    <ClipboardList className="size-3.5 shrink-0 sm:size-4" />
                    퇴실 프로세스
                  </span>
                  <SubRow
                    label="신청일자"
                    value={preview.exitProcess.requestedAt ? new Date(preview.exitProcess.requestedAt).toLocaleString("ko-KR") : "-"}
                  />
                  <SubRow label="예약일자" value={preview.exitProcess.exitDate || "-"} />
                  <SubRow
                    label="예치금 정산액 동의일자"
                    value={preview.exitProcess.agreedAt ? new Date(preview.exitProcess.agreedAt).toLocaleString("ko-KR") : "미동의"}
                    valueClassName={!preview.exitProcess.agreedAt ? "text-destructive" : undefined}
                  />
                  {preview.fromBackup && (
                    <SubRow label="데이터 기준" value="지난 주 백업 시트" valueClassName="text-muted-foreground" />
                  )}
                </InfoCard>
              )}

              {preview && (
                <InfoCard className="flex flex-col gap-1 border-destructive/30 bg-destructive/5">
                  <div className="flex items-center gap-1.5 text-destructive">
                    <TriangleAlert className="size-3.5 shrink-0 sm:size-4" />
                    <span className="text-xs font-semibold sm:text-sm">주의사항</span>
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
                    확정하면 현재 시트가 백업 탭으로 옮겨지고 원래 슬롯이 초기화됩니다. 되돌릴 수 없으니
                    내용을 다시 확인한 뒤 진행하세요.
                  </p>
                </InfoCard>
              )}

              {preview && (
                <Button
                  className="w-full sm:h-12 sm:text-base"
                  variant="destructive"
                  disabled={confirming || !preview.exitProcess?.agreedAt}
                  onClick={handleConfirm}
                >
                  {confirming ? "처리 중..." : "확정 처리"}
                </Button>
              )}
            </>
          ) : (
            <>
              <InfoCard className="flex flex-col gap-2">
                <Label className="text-xs font-semibold text-muted-foreground sm:text-sm">처리 유형</Label>
                {lockKind ? (
                  <FieldValue className="text-sm sm:text-base">{KIND_LABEL[lockKind]}</FieldValue>
                ) : (
                  <Select value={kind} onValueChange={(v) => v && resetForNewKind(v as ExitKind)}>
                    <SelectTrigger className="bg-card data-[size=default]:h-8 sm:data-[size=default]:h-12 sm:text-base">
                      <SelectValue>{KIND_LABEL[kind]}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="forced" className="sm:text-base">
                        {KIND_LABEL.forced}
                      </SelectItem>
                      <SelectItem value="admin_forced" className="sm:text-base">
                        {KIND_LABEL.admin_forced}
                      </SelectItem>
                      <SelectItem value="settle" className="sm:text-base">
                        {KIND_LABEL.settle}
                      </SelectItem>
                      <SelectItem value="deposit_again" className="sm:text-base">
                        {KIND_LABEL.deposit_again}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}

                {kind === "admin_forced" && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="forced-reason" className="text-xs font-medium text-muted-foreground sm:text-sm">
                      직권 퇴실 사유
                    </Label>
                    <Input
                      id="forced-reason"
                      value={forcedReason}
                      onChange={(e) => setForcedReason(e.target.value)}
                      placeholder="예: 비매너 행위로 인한 즉시 퇴실"
                      className="sm:h-12 sm:text-base"
                    />
                  </div>
                )}

                {kind === "forced" && candidate.allChecks && candidate.allChecks.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
                      강제퇴실 조건 (해당 항목만 적용됨)
                    </Label>
                    <ForcedExitChecklist checks={candidate.allChecks} />
                  </div>
                )}
              </InfoCard>

              <Button variant="outline" className="w-full sm:h-12 sm:text-base" disabled={previewing} onClick={handlePreview}>
                {previewing ? "계산 중..." : "미리보기 계산"}
              </Button>

              {preview && (
                <InfoCard className="flex flex-col gap-2">
                  <span className="text-xs font-semibold sm:text-sm">{preview.kindStr} 처리 결과</span>
                  {preview.allChecks.length > 0 && <ForcedExitChecklist checks={preview.allChecks} />}
                  <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground sm:text-sm">
                    {preview.resultMsg}
                  </pre>
                </InfoCard>
              )}

              {preview && (
                <InfoCard className="flex flex-col gap-1 border-destructive/30 bg-destructive/5">
                  <div className="flex items-center gap-1.5 text-destructive">
                    <TriangleAlert className="size-3.5 shrink-0 sm:size-4" />
                    <span className="text-xs font-semibold sm:text-sm">주의사항</span>
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
                    확정하면 현재 시트가 백업 탭으로 옮겨지고 원래 슬롯이 초기화됩니다. 되돌릴 수 없으니
                    내용을 다시 확인한 뒤 진행하세요.
                  </p>
                </InfoCard>
              )}

              {preview && (
                <Button
                  className="w-full sm:h-12 sm:text-base"
                  variant="destructive"
                  disabled={confirming}
                  onClick={handleConfirm}
                >
                  {confirming ? "처리 중..." : "확정 처리"}
                </Button>
              )}
            </>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
