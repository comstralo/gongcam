import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import type { CycleListResponse, CycleWeek } from "@/lib/api/types";

// weekOf는 백업 파일명에서 온 "YYMMDD"(그 주 월요일) 형식이다.
function formatWeekLabel(weekOf: string) {
  const m = weekOf.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!m) return weekOf;
  const [, , mm, dd] = m;
  return `${parseInt(mm, 10)}월 ${parseInt(dd, 10)}일 주`;
}

// MY/ALL 상단에서 "현재 진행 중인 사이클(최대 3주) 중 어느 시점을 볼지"
// 고르는 토글. "현재"(실시간, cycle 파라미터 없음)가 항상 맨 앞에 있고,
// 그 뒤로 이미 백업된 주차가 최신순으로 이어진다 — 사이클을 벗어난(4주
// 이상 지난) 기록은 이 토글에 나타나지 않는다.
export function CycleSwitcher({
  selectedFileId,
  onSelect,
  // 지금 조회 중인 회원 관점 — 실제 회원번호(관리자가 다른 회원을 보는
  // 중), "self"(본인 대시보드 — 서버가 세션 이메일로 본인을 판정), 또는
  // undefined(전체 랭킹처럼 특정 회원 관점이 없는 화면 — 필터링 없음).
  // 회원 관점이 있을 때, 그 회원이 해당 주차 명단에 없으면(중도 가입 등)
  // 그 버튼을 "데이터 없음"으로 표시한다.
  memberNumber,
}: {
  selectedFileId: string | null;
  onSelect: (fileId: string | null) => void;
  memberNumber?: string;
}) {
  const { call } = useApi();
  const [weeks, setWeeks] = useState<CycleWeek[] | null>(null);
  // 사이클 하나가 최대 몇 주인지(현재 3) — 아직 응답 전이면 기존 버그
  // ("과거 주차 있어도 응답 오기 전엔 안 보임")를 재현하지 않도록 슬롯을
  // 아예 안 그린다. 응답이 오면 실제 서버 값으로 갱신된다.
  const [maxWeeks, setMaxWeeks] = useState(0);
  // 🔧 [실패 시 무피드백 수정] 원래 실패를 그냥 삼켜서(catch(()=>{})) weeks가
  // 계속 null로 남아 토글 전체가 에러 표시 없이 조용히 사라졌다 — 사용자가
  // "지난 주 보기" 기능이 원래 있었는지조차 알 수 없었다. 실패 시 작은
  // 재시도 버튼을 보여준다.
  const [error, setError] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    const memberParam = memberNumber ? `?member=${encodeURIComponent(memberNumber)}` : "";
    call<CycleListResponse>(`/cycles${memberParam}`)
      .then((data) => {
        if (cancelled) return;
        setWeeks(data.weeks || []);
        setMaxWeeks(data.maxWeeks || 0);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberNumber, retryToken]);

  if (error) {
    return (
      <button
        type="button"
        onClick={() => setRetryToken((n) => n + 1)}
        className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-2 text-sm font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:bg-muted sm:text-base"
      >
        <RotateCw className="size-3.5" />
        지난 주 목록 다시 불러오기
      </button>
    );
  }

  if (weeks === null || maxWeeks === 0) return null;

  // 🔧 [빈 슬롯 표시] 아직 3주가 다 안 지나 백업이 없는 과거 주차는 원래
  // 버튼 자체가 안 보였다 — 몇 주째인지, 앞으로 몇 자리가 더 채워질지
  // 가늠할 수 없었다. 실제 존재하는 주차(최신순 응답을 오래된 순으로
  // 뒤집은 것) 앞쪽을, 아직 없는 주차 수만큼 비활성화 슬롯으로 채운다.
  // maxWeeks(3)는 "사이클 전체 주 수"이고 그중 하나는 항상 아래의 "현재"
  // 버튼이 차지하므로, 채워야 할 과거 슬롯 예산은 maxWeeks - 1이다 —
  // 이걸 안 빼서 총 버튼이 4개(빈슬롯 3 + 현재 1)로 보이던 버그였다.
  const oldestFirst = [...weeks].reverse();
  const missingCount = Math.max(0, maxWeeks - 1 - oldestFirst.length);
  const slots: (CycleWeek | null)[] = [...Array(missingCount).fill(null), ...oldestFirst];

  return (
    <div className="flex w-full flex-wrap gap-1.5 sm:gap-2">
      {slots.map((w, i) =>
        // 🔧 [중도 가입 회원 처리] 백업 파일 자체는 존재해도(w는 non-null),
        // 조회 대상 회원이 그 시점 명단에 없었다면(hasData: false) 실제
        // 날짜 라벨을 보여줄 수 없다 — 백업 자체가 없는 빈 슬롯과 동일하게
        // "데이터 없음"으로 비활성화한다.
        w && w.hasData ? (
          <button
            key={w.fileId}
            type="button"
            onClick={() => onSelect(w.fileId)}
            className={cn(
              "rounded-full border px-3.5 py-2 text-sm font-semibold transition-colors sm:text-base",
              w.fileId === selectedFileId
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card text-foreground hover:border-primary/50 hover:bg-muted"
            )}
          >
            {formatWeekLabel(w.weekOf)}
          </button>
        ) : (
          <button
            key={w ? w.fileId : `empty-${i}`}
            type="button"
            disabled
            className="cursor-not-allowed rounded-full border border-border bg-muted/50 px-3.5 py-2 text-sm font-semibold text-muted-foreground/50 sm:text-base"
          >
            데이터 없음
          </button>
        )
      )}
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={cn(
          "rounded-full border px-3.5 py-2 text-sm font-semibold transition-colors sm:text-base",
          selectedFileId === null
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-card text-foreground hover:border-primary/50 hover:bg-muted"
        )}
      >
        이번 주
      </button>
    </div>
  );
}
