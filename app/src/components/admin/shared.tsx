import { useEffect, useState, type ReactNode } from "react";
import { RotateCw, FileText, Image as ImageIcon, Loader2, Search, type LucideIcon } from "lucide-react";
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
  iconVariant = "plain",
  trailing,
}: {
  icon: LucideIcon;
  title: string;
  loading?: boolean;
  onRefresh?: () => void;
  refreshProgress?: number;
  /** true면 로딩 중이 아니어도 버튼을 비활성화한다 — 서버 캐시 TTL이 아직
   * 안 지나 눌러도 같은 캐시값만 돌아오는 구간을 걸러내는 용도(예:
   * "내 대시보드"의 personalStatusBundle: TTL). 생략하면 기존 동작과
   * 동일(loading일 때만 비활성화). */
  refreshDisabled?: boolean;
  /** refreshDisabled가 true일 때 보여줄 이유(버튼 title 툴팁). */
  refreshDisabledReason?: string;
  /** "tint"면 아이콘을 원형 틴트 배지로 감싼다(사용자 지시: "디자인이
   * 딱딱해 보인다" — 우선 제보 화면에서만 사용). 기본은 기존과 동일한
   * 맨 아이콘(plain). */
  iconVariant?: "plain" | "tint";
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
        <span className="flex items-center gap-2 text-sm font-bold sm:text-base">
          {iconVariant === "tint" ? (
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary sm:size-7">
              <Icon className="size-3.5 sm:size-4" strokeWidth={ICON_STROKE.default} />
            </span>
          ) : (
            <Icon className="size-4 shrink-0 text-primary sm:size-5" strokeWidth={ICON_STROKE.default} />
          )}
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
          한 번에 적용된다. font-bold 오버라이드: 이 admin/shared.tsx의
          ItemTitle은 4단 체계상 font-semibold가 맞지만, TotalPenaltyDialog
          쪽에서는 이미 검증된 기준값인 MeritBreakdownDialog(text-sm
          font-bold sm:text-base)와 굵기까지 정확히 맞춰야 한다(사용자
          지시) — admin 쪽 다른 ItemTitle 용례(예: 회원 이름)는 semibold
          그대로 두고 여기만 개별적으로 올린다. */}
      <span className="inline-flex items-center gap-1.25">
        <Icon className="size-3.5 sm:size-4" strokeWidth={ICON_STROKE.default} />
        <ItemTitle className="font-bold">{title}</ItemTitle>
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
