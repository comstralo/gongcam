import { useEffect, useState, type ReactNode } from "react";
import { RotateCw, FileText, Image as ImageIcon, Search, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { InfoCard, SubRow } from "@/components/dashboard/shared";
import { WORKER_BASE } from "@/lib/api/client";
import { cn, ICON_STROKE } from "@/lib/utils";
import type { PenaltySlotHistoryEntry } from "@/lib/api/types";

// 관리자 탭 전반의 텍스트 위계를 명시적으로 나눈 프리미티브들.
// 1. SectionHeader 제목  — text-sm/base, font-bold   (섹션의 최상위 텍스트)
// 2. ItemTitle           — text-sm/base, font-semibold (리스트 한 항목의 1차 텍스트, 섹션 제목보다 굵기 한 단계 낮음)
// 3. FieldLabel          — text-xs/sm,  font-medium, muted (카드 안 항목명 — 크기 자체를 한 단계 낮춰 값과 구분)
// 4. FieldValue          — text-xs/sm,  font-semibold (카드 안 강조 값, FieldLabel과 나란히 쓰임)
// 이전에는 섹션 제목과 리스트 아이템 이름, 카드 라벨이 모두 text-sm/base 크기를 공유해
// 굵기 차이(bold vs semibold)만으로 위계를 나누려 해서 시각적으로 거의 구분되지 않았다.

// 백엔드가 퇴실자를 "{이름} (퇴실)" 형태(백업 탭 이름 그대로)로 내려주는
// 곳(ExitedMemberList, "다른 회원 보기" 드롭다운, 신규 등록 블랙리스트 경고
// 등)이 여럿이라 표시용 이름만 뽑는 로직을 공용으로 둔다.
export function displayExitedName(name: string): string {
  return name.replace(/ \(퇴실\)$/, "");
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

// 관리자 탭에서 접이식 섹션 하나를 감싸는 카드. 회색 배경(bg-muted)을 쓰면
// 내용물이 흐리게 보여 비활성화된 것처럼 착시가 생기므로, 배경은 부모
// Card와 같은 흰 바탕(bg-card)을 유지하고 테두리로만 섹션 경계를 드러낸다.
export function SectionCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-xl border border-border bg-card p-3.5 sm:p-4", className)}>{children}</div>;
}

// 관리자 탭의 각 현황 섹션 공통 헤더 — 제목(펼침/접힘 토글 겸)과 새로고침 버튼.
// 새로고침 버튼은 CollapsibleTrigger 바깥에 두어 클릭 시 섹션이 접히지 않게 한다.
// onRefresh가 없는 섹션(예: 신규 등록 폼처럼 서버에서 다시 불러올 목록이 없는
// 경우)은 버튼 자리를 비워두고 chevron만 우측에 남긴다 — 다른 섹션과 chevron
// 위치를 맞추기 위해 버튼 크기(size-7)만큼의 빈 공간을 유지한다.
export function SectionHeader({
  icon: Icon,
  title,
  loading,
  onRefresh,
}: {
  icon: LucideIcon;
  title: string;
  loading?: boolean;
  onRefresh?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <CollapsibleTrigger className="flex-1">
        <span className="flex items-center gap-1.5 text-sm font-bold sm:text-base">
          <Icon className="size-4 shrink-0 text-primary sm:size-5" strokeWidth={ICON_STROKE.default} />
          {title}
        </span>
      </CollapsibleTrigger>
      {onRefresh ? (
        <Button variant="outline" size="icon-sm" onClick={onRefresh} disabled={loading} aria-label="새로고침">
          <RotateCw className={cn("size-3.5", loading && "animate-spin")} strokeWidth={ICON_STROKE.default} />
        </Button>
      ) : (
        <span className="size-7 shrink-0" aria-hidden="true" />
      )}
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
        <p className="text-xs text-muted-foreground sm:text-sm">미리보기 불러오는 중...</p>
      </div>
    );
  }
  if (isVideo) {
    return (
      <video
        src={blobUrl}
        controls
        className="aspect-video w-full rounded-lg bg-black object-contain"
      />
    );
  }
  return (
    <Dialog>
      <DialogTrigger className="block w-full overflow-hidden rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
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
      <DialogTrigger className="rounded text-micro-lg tabular-nums text-muted-foreground underline decoration-dotted underline-offset-2 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 sm:text-xs">
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
            <InfoCard className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
                <ImageIcon className="size-3.5 shrink-0 text-primary sm:size-4" />
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

          <InfoCard className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <FileText className="size-3.5 shrink-0 text-primary sm:size-4" />
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
        <Icon className="size-3.5 sm:size-4" strokeWidth={ICON_STROKE.default} />
        <ItemTitle>{title}</ItemTitle>
      </span>
      {entries.length === 0 ? (
        <SubRow label="해당 없음" value="-" />
      ) : (
        entries.map((entry, i) => {
          const label = slotLabels?.[i] ?? parenthesizeOccurrence(entry.label);
          const isPenalty = label.startsWith("페널티") || label.startsWith("주간 P");
          return (
            <SubRow
              key={entry.label}
              label={label}
              labelClassName={isPenalty ? "font-semibold text-destructive" : undefined}
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
