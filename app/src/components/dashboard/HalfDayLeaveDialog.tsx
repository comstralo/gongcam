import { useEffect, useRef, useState } from "react";
import { BedDouble, CalendarCheck, FileText, ImagePlus, Minus, Pencil, Plus, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { InfoCard, DividedValue, MAX_LEAVES_PER_DAY } from "@/components/dashboard/shared";
import { LeaveApplyButton } from "@/components/dashboard/LeaveApplyButton";
import { ImageEditDialog } from "@/components/dashboard/ImageEditDialog";
import { useApi } from "@/hooks/useApi";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type {
  ReasonLeaveProofStatus,
  SetReasonLeaveProofResponse,
  CancelReasonLeaveProofResponse,
  SetLeaveApplyResponse,
} from "@/lib/api/types";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png"];

// 압축 목표: 긴 변 1600px, 품질 0.8에서 시작해 1MB를 넘으면 0.6 → 0.4까지
// 단계적으로 낮춰 재시도한다. 그래도 1MB를 못 맞추면(고해상도 텍스트 스캔본
// 등) 품질 0.4 결과를 그대로 쓰되, 최종적으로 기존 5MB 상한만 지킨다.
const COMPRESS_MAX_DIMENSION = 1600;
const COMPRESS_TARGET_BYTES = 1024 * 1024;
const COMPRESS_QUALITIES = [0.8, 0.6, 0.4];

// data:image/jpeg;base64,xxxx 형태에서 순수 base64 부분만 잘라낸다.
function stripDataUrlPrefix(dataUrl: string): string {
  const idx = dataUrl.indexOf(",");
  return idx === -1 ? dataUrl : dataUrl.slice(idx + 1);
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("이미지를 읽지 못했습니다."));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

// 진단서 등 증빙 이미지를 Canvas로 리사이즈+JPEG 재인코딩해 업로드 용량을
// 줄인다. 항상 압축을 시도하고(스마트폰 사진은 보통 수 MB), 결과가 1MB를
// 넘으면 품질을 낮춰가며 재시도한다. 최종적으로도 5MB를 넘으면 실패로 본다
// (Worker/봇의 5MB 상한과 동일 기준).
async function compressImage(file: File): Promise<File> {
  const img = await loadImage(file);
  const scale = Math.min(1, COMPRESS_MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("이미지를 압축하지 못했습니다.");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  let lastBlob: Blob | null = null;
  for (const quality of COMPRESS_QUALITIES) {
    const blob = await canvasToBlob(canvas, quality);
    if (!blob) continue;
    lastBlob = blob;
    if (blob.size <= COMPRESS_TARGET_BYTES) break;
  }
  if (!lastBlob) throw new Error("이미지를 압축하지 못했습니다.");
  if (lastBlob.size > MAX_IMAGE_BYTES) {
    throw new Error("압축 후에도 이미지 용량이 5MB를 초과합니다. 더 작은 이미지를 선택해주세요.");
  }
  return new File([lastBlob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
}

// "일반반휴 신청"/"사유반휴 신청" 두 버튼을 대체하는 통합 진입점. 일반반휴는
// 기존 LeaveApplyButton을 그대로 재사용해 즉시 신청/취소하고, 사유반휴는
// 증빙 이미지+사유를 제출하면 관리자 승인 전까지 시트에 반영되지 않는 대기
// 상태로 전환된다.
export function HalfDayLeaveDialog({
  day,
  usedToday,
  reasonLeaveUsed,
  normalLeaveLeft,
  reasonLeaveLeft,
  onNormalApplied,
  onReasonLeaveApplied,
  onReasonLeaveSubmitted,
  onOpen,
}: {
  day: string;
  usedToday: number;
  // 이 요일에 이미 승인되어 시트에 반영된 사유반휴 장수. 0보다 크면 "취소"
  // 버튼을 보여준다(대기 중 신청과는 별개 — 승인 완료된 건이다).
  reasonLeaveUsed: number;
  // 대시보드 상단 "반휴권 잔여량" 타일과 같은 값(StatusResponse 그대로) —
  // 이 요일 한정이 아니라 전체(주간/사이클) 잔여량이다.
  normalLeaveLeft: string;
  reasonLeaveLeft: string;
  onNormalApplied?: (delta: number) => void;
  // 승인된 사유반휴를 취소했을 때 그 변화량(항상 음수)을 부모에 알려, 요일
  // 카드의 "사유반휴" 카운트를 새로고침 없이 즉시 갱신한다.
  onReasonLeaveApplied?: (delta: number) => void;
  onReasonLeaveSubmitted?: () => void;
  // 다이얼로그가 열릴 때마다 호출된다 — normalLeaveLeft/reasonLeaveLeft/
  // usedToday는 이 컴포넌트가 아니라 부모(StatusPage)의 status에서 내려오는
  // 값이라, 다른 사람(관리자)이 그 사이 승인/반려한 결과가 있으면 열 때마다
  // 부모가 재조회해야 최신 잔여량이 반영된다.
  onOpen?: () => void;
}) {
  const { call } = useApi();
  const [open, setOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [status, setStatus] = useState<ReasonLeaveProofStatus | "loading" | "error">("loading");
  const [reason, setReason] = useState("");
  // 같은 증빙으로 이 요일에 한 번에 신청할 장수. 일반반휴 스테퍼와 동일하게
  // 기본값은 0이며, "신청" 버튼은 0일 때(=아직 아무 장수도 고르지 않은 상태)
  // 비활성화된다.
  const [proofCount, setProofCount] = useState<0 | 1 | 2>(0);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  // 파일 선택 즉시 편집 모달(자르기/모자이크)이 뜬다 — "완료" 전까지는
  // selectedFile을 바꾸지 않고 이 임시 슬롯에만 담아둔다.
  const [editingFile, setEditingFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  // 대기 중 신청 철회, 승인 완료 건 취소는 별개 액션이라 각자의 진행/에러
  // 상태를 따로 둔다.
  const [cancelingPending, setCancelingPending] = useState(false);
  const [cancelPendingError, setCancelPendingError] = useState<string | null>(null);
  const [cancelingApproved, setCancelingApproved] = useState(false);
  const [cancelApprovedError, setCancelApprovedError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStatus("loading");
    setReason("");
    setProofCount(0);
    setSelectedFile(null);
    setEditingFile(null);
    setFileError(null);
    setSubmitError(null);
    setSubmitted(false);
    setCancelPendingError(null);
    setCancelApprovedError(null);
    call<ReasonLeaveProofStatus>(`/reason-leave-proof?day=${encodeURIComponent(day)}`)
      .then(setStatus)
      .catch(() => setStatus("error"));
    onOpen?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, day]);

  // usedToday가 바뀌어(예: 일반반휴를 먼저 신청) 선택 가능한 최대 장수가
  // 줄어들면, 이미 골라둔 proofCount도 그 상한을 넘지 않게 맞춘다.
  const maxProofCount = Math.max(1, Math.min(2, MAX_LEAVES_PER_DAY - usedToday)) as 1 | 2;
  useEffect(() => {
    setProofCount((prev) => (prev > maxProofCount ? maxProofCount : prev));
  }, [maxProofCount]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // 같은 파일을 다시 선택해도 onChange가 발생하도록 입력값을 비운다.
    e.target.value = "";
    if (!file) return;
    setFileError(null);
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      setFileError("jpg 또는 png 이미지만 첨부할 수 있습니다.");
      return;
    }
    setEditingFile(file);
  }

  async function handleSubmit() {
    if (!selectedFile || !reason.trim() || proofCount === 0) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const compressed = await compressImage(selectedFile);
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(compressed);
      });
      await call<SetReasonLeaveProofResponse>("/reason-leave-proof", {
        method: "POST",
        body: {
          day,
          reason: reason.trim(),
          imageBase64: stripDataUrlPrefix(dataUrl),
          imageExt: "jpg",
          count: proofCount,
        },
      });
      setSubmitted(true);
      onReasonLeaveSubmitted?.();
    } catch (err) {
      if (err instanceof ApiError) setSubmitError(err.message);
      else if (err instanceof Error) setSubmitError(err.message);
      else setSubmitError("신청에 실패했습니다.");
    } finally {
      setSubmitting(false);
    }
  }

  // 아직 관리자 확인 전(pending)인 신청을 학생 스스로 철회한다 — 큐에만
  // 있으면 그대로 삭제되고, 봇에 이미 넘어간 신청이면 반려와 동일한
  // 경로(사유="본인 철회")로 처리된다. 성공하면 status를 다시 조회해
  // "신청 폼"이 다시 나타나게 한다.
  async function handleCancelPending() {
    setCancelingPending(true);
    setCancelPendingError(null);
    try {
      await call<CancelReasonLeaveProofResponse>("/reason-leave-proof/cancel", {
        method: "POST",
        body: { day },
      });
      setStatus({ pending: false, rejected: null });
      onReasonLeaveSubmitted?.();
    } catch (err) {
      setCancelPendingError(err instanceof ApiError ? err.message : "철회에 실패했습니다.");
    } finally {
      setCancelingPending(false);
    }
  }

  // 이미 승인되어 시트에 반영된 사유반휴를 취소한다 — 일반반휴와 동일한
  // /leave-apply API를 count:0으로 호출해 셀을 비운다.
  async function handleCancelApproved() {
    setCancelingApproved(true);
    setCancelApprovedError(null);
    try {
      await call<SetLeaveApplyResponse>("/leave-apply", {
        method: "POST",
        body: { type: "reason", day, count: 0 },
      });
      onReasonLeaveApplied?.(-reasonLeaveUsed);
    } catch (err) {
      setCancelApprovedError(err instanceof ApiError ? err.message : "취소에 실패했습니다.");
    } finally {
      setCancelingApproved(false);
    }
  }

  // usedToday는 이 요일에 이미 확정 반영된 반휴 수(일반+승인된 사유 합산)라,
  // 여기서 막힌 뒤에도 반려(rejected)된 사유반휴는 재신청할 수 있어야 한다
  // (반려는 usedToday에 포함되지 않으므로 별도 처리가 필요 없다).
  const dayFull = usedToday >= MAX_LEAVES_PER_DAY;
  const hasApprovedReasonLeave = reasonLeaveUsed > 0;
  const showForm =
    status !== "loading" &&
    status !== "error" &&
    !status.pending &&
    !submitted &&
    !dayFull &&
    !hasApprovedReasonLeave;
  const canSubmit = !!selectedFile && !!reason.trim() && proofCount > 0 && !submitting;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="w-full rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <Button variant="outline" className="w-full sm:h-11">
          반일 휴무 신청
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <BedDouble className="size-4 text-primary sm:size-5" />
            반일 휴무 신청
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <InfoCard className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <BedDouble className="size-3.5 shrink-0 text-primary sm:size-4" />
              반휴권 잔여량
            </span>
            <span className="text-xs font-semibold sm:text-sm">
              <DividedValue
                items={[`일반 ${normalLeaveLeft || "0"}회`, `사유 ${reasonLeaveLeft || "0"}회`]}
              />
            </span>
          </InfoCard>

          <InfoCard className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <CalendarCheck className="size-3.5 shrink-0 text-primary sm:size-4" />
              일반 반휴
            </span>
            <LeaveApplyButton day={day} dayFull={dayFull} onApplied={onNormalApplied} />
          </InfoCard>

          <InfoCard className="flex flex-col gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <FileText className="size-3.5 shrink-0 text-primary sm:size-4" />
              사유 반휴
            </span>

            {status === "loading" && (
              <p className="text-center font-mono text-xs text-muted-foreground sm:text-sm">불러오는 중...</p>
            )}
            {status === "error" && (
              <Alert variant="destructive">
                <AlertDescription>사유반휴 신청 정보를 불러오지 못했습니다.</AlertDescription>
              </Alert>
            )}

            {status !== "loading" && status !== "error" && status.pending && !submitted && (
              <div className="flex flex-col gap-2">
                <p className="text-micro-lg text-muted-foreground sm:text-xs">
                  관리자 확인 중입니다. 승인되면 자동으로 반영됩니다.
                </p>
                <Button
                  variant="outline"
                  className="w-full sm:h-11"
                  disabled={cancelingPending}
                  onClick={handleCancelPending}
                >
                  {cancelingPending ? "철회 중..." : "신청 철회"}
                </Button>
                {cancelPendingError && (
                  <p className="text-center text-micro-lg text-destructive sm:text-xs">{cancelPendingError}</p>
                )}
              </div>
            )}

            {hasApprovedReasonLeave && !submitted && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 items-center rounded-lg border sm:h-11">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-full w-8 shrink-0 rounded-r-none sm:w-11"
                      disabled
                      aria-label="사유반휴 장수 줄이기"
                    >
                      <Minus className="size-3.5" />
                    </Button>
                    <span className="w-6 text-center text-sm font-semibold tabular-nums sm:text-base">
                      {reasonLeaveUsed}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-full w-8 shrink-0 rounded-l-none sm:w-11"
                      disabled
                      aria-label="사유반휴 장수 늘리기"
                    >
                      <Plus className="size-3.5" />
                    </Button>
                  </div>
                  <Button
                    variant="destructive"
                    className="min-w-0 flex-1 sm:h-11"
                    disabled={cancelingApproved}
                    onClick={handleCancelApproved}
                  >
                    {cancelingApproved ? "취소 중..." : "취소"}
                  </Button>
                </div>
                {cancelApprovedError && (
                  <p className="text-center text-micro-lg text-destructive sm:text-xs">{cancelApprovedError}</p>
                )}
              </div>
            )}

            {submitted && (
              <p className="text-micro-lg text-ok sm:text-xs">신청이 접수되었습니다. 관리자 확인 중입니다.</p>
            )}

            {status !== "loading" && status !== "error" && status.rejected && !submitted && (
              <Alert variant="destructive">
                <AlertDescription>반려됨: {status.rejected.reason || "사유 없음"}</AlertDescription>
              </Alert>
            )}

            {showForm && (
              <div className="flex flex-col gap-2">
                <Textarea
                  placeholder="사유를 입력해주세요 (예: 병원 진료)"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={submitting}
                  className="text-xs sm:text-sm"
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png"
                  onChange={handleFileChange}
                  disabled={submitting}
                  className="hidden"
                />
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-w-0 flex-1 justify-start gap-2 overflow-hidden sm:h-11"
                    disabled={submitting}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <ImagePlus className="size-3.5 shrink-0 sm:size-4" />
                    <span className="truncate">
                      {selectedFile ? selectedFile.name : "증빙 이미지 첨부 (jpg/png)"}
                    </span>
                  </Button>
                  {selectedFile && (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="shrink-0 sm:size-11"
                      disabled={submitting}
                      onClick={() => setEditingFile(selectedFile)}
                      aria-label="이미지 편집"
                    >
                      <Pencil className="size-3.5 sm:size-4" />
                    </Button>
                  )}
                </div>
                {selectedFile && (
                  <p className="text-micro-lg text-muted-foreground sm:text-xs">
                    제출 시 자동으로 용량이 압축됩니다.
                  </p>
                )}
                {fileError && <p className="text-micro-lg text-destructive sm:text-xs">{fileError}</p>}

                <div className="flex items-center gap-2">
                  <div className="flex h-8 items-center rounded-lg border sm:h-11">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-full w-8 shrink-0 rounded-r-none sm:w-11"
                      disabled={submitting || proofCount <= 0}
                      onClick={() => setProofCount((n) => (n > 0 ? ((n - 1) as 0 | 1 | 2) : n))}
                      aria-label="사유반휴 장수 줄이기"
                    >
                      <Minus className="size-3.5" />
                    </Button>
                    <span className="w-6 text-center text-sm font-semibold tabular-nums sm:text-base">
                      {proofCount}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-full w-8 shrink-0 rounded-l-none sm:w-11"
                      disabled={submitting || proofCount >= maxProofCount}
                      onClick={() => setProofCount((n) => (n < maxProofCount ? ((n + 1) as 0 | 1 | 2) : n))}
                      aria-label="사유반휴 장수 늘리기"
                    >
                      <Plus className="size-3.5" />
                    </Button>
                  </div>
                  <Button
                    className={cn("min-w-0 flex-1 sm:h-11")}
                    disabled={!canSubmit}
                    onClick={handleSubmit}
                  >
                    {submitting ? "제출 중..." : "신청"}
                  </Button>
                </div>
              </div>
            )}

            {submitError && (
              <Alert variant="destructive">
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            )}
          </InfoCard>

          <InfoCard className="flex flex-col gap-1 border-destructive/30 bg-destructive/5">
            <div className="flex items-center gap-1.5 text-destructive">
              <TriangleAlert className="size-3.5 shrink-0 sm:size-4" />
              <span className="text-xs font-semibold sm:text-sm">안내</span>
            </div>
            <ul className="flex flex-col gap-1 text-micro-lg leading-relaxed text-muted-foreground sm:text-xs">
              <li className="flex gap-1.5">
                <span className="text-destructive/60">•</span>
                사유 반휴는 증빙 확인 후 관리자가 승인해야 최종 반영됩니다.
              </li>
              <li className="flex gap-1.5">
                <span className="text-destructive/60">•</span>
                같은 증빙으로 하루 최대 {MAX_LEAVES_PER_DAY}장까지 함께 신청할 수 있습니다.
              </li>
              <li className="flex gap-1.5">
                <span className="text-destructive/60">•</span>
                반려된 경우 사유가 표시되며, 다시 신청할 수 있습니다.
              </li>
            </ul>
          </InfoCard>
        </div>
      </DialogContent>

      <ImageEditDialog
        file={editingFile}
        onConfirm={(edited) => {
          setSelectedFile(edited);
          setEditingFile(null);
        }}
        onCancel={() => setEditingFile(null)}
      />
    </Dialog>
  );
}
