import { useEffect, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, RotateCw } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { ICON_STROKE } from "@/lib/utils";
import type { CycleListResponse, CycleWeek } from "@/lib/api/types";

// weekOf/weekTo는 백업 파일명에서 온 "YYMMDD" 형식이다.
function formatDate(raw: string) {
  const m = raw.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!m) return raw;
  const [, , mm, dd] = m;
  return `${mm}.${dd}`;
}

// 🔧 [사용자 지시] "이번 주" 슬롯도 과거 주차처럼 날짜 구간을 보여준다 —
// 이 컴포넌트는 /cycles 응답(과거 백업의 weekOf/weekTo)만 받고 "이번 주"
// 자체의 날짜는 서버에서 내려주지 않으므로, 다른 화면들과 동일한 관용구
// ((getDay()+6)%7로 일요일=0을 월요일=0으로 보정)로 클라이언트에서
// 오늘이 속한 주의 월~일을 직접 계산한다.
function thisWeekRange(): { start: string; end: string } {
  const now = new Date();
  const todayIndex = (now.getDay() + 6) % 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - todayIndex);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (d: Date) => `${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
  return { start: fmt(monday), end: fmt(sunday) };
}

// MY/ALL 상단에서 "현재 진행 중인 사이클(최대 3주) 중 어느 시점을 볼지"
// 고르는 전환 UI. "현재"(실시간, cycle 파라미터 없음)가 항상 맨 마지막
// 슬롯이고, 그 앞으로 이미 백업된 주차가 오래된 순으로 이어진다 — 사이클을
// 벗어난(4주 이상 지난) 기록은 나타나지 않는다.
// 🔧 [사용자 지시] 원래 슬롯 개수만큼 버튼을 나열해(예: "데이터 없음" ×2 +
// "이번 주") 슬롯이 늘어날수록 버튼 줄이 옆으로 계속 길어지는 방식이었는데,
// "N/3주차 : 08.02 ~ 08.09"처럼 현재 슬롯 하나만 보여주고 </> 로 넘기는
// 방식으로 바꿨다 — 백엔드가 실제로 관리하는 "사이클 내 몇 번째 주인지"
// (1/3주차 등, 여러 사이클을 관통하는 누적 번호는 없음)를 그대로 노출한다.
export function CycleSwitcher({
  selectedFileId,
  onSelect,
  // 지금 조회 중인 회원 관점 — 실제 회원번호(관리자가 다른 회원을 보는
  // 중), "self"(본인 대시보드 — 서버가 세션 이메일로 본인을 판정), 또는
  // undefined(전체 랭킹처럼 특정 회원 관점이 없는 화면 — 필터링 없음).
  // 회원 관점이 있을 때, 그 회원이 해당 주차 명단에 없으면(중도 가입 등)
  // 그 슬롯을 "데이터 없음"으로 표시한다.
  memberNumber,
}: {
  selectedFileId: string | null;
  // week: 선택된 주차의 전체 정보(weekOf/weekTo 등) — "현재"를 고르면 null.
  // PEN·MONEY 탭처럼 실제 날짜 라벨을 다시 계산해야 하는 화면에서 쓴다.
  onSelect: (fileId: string | null, week?: CycleWeek | null) => void;
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

  // 🔧 [버그 수정] 훅은 조건부 return보다 항상 먼저 호출돼야 한다(React
  // 훅 규칙) — weeks/maxWeeks가 아직 없을 때도 슬롯 계산이 빈 배열
  // 기준으로 안전하게 굴러가도록 미리 만들어두고, 실제 화면 분기는
  // 아래 JSX에서만 한다.
  const oldestFirst = weeks ? [...weeks].reverse() : [];
  const missingCount = Math.max(0, maxWeeks - 1 - oldestFirst.length);
  const pastSlots: (CycleWeek | null)[] = [...Array(missingCount).fill(null), ...oldestFirst];
  // "이번 주"(fileId: null)를 항상 마지막 슬롯으로 붙여, 전체를 "1/3주차 →
  // 2/3주차 → 3/3주차(이번 주)"처럼 시간 순으로 오가는 하나의 트랙으로 만든다.
  const slots: (CycleWeek | null)[] = maxWeeks > 0 ? [...pastSlots, null] : [];
  const currentWeekIndex = slots.length - 1;
  const selectedIndex =
    selectedFileId === null ? currentWeekIndex : slots.findIndex((w) => w?.fileId === selectedFileId);
  const activeIndex = selectedIndex === -1 ? currentWeekIndex : selectedIndex;

  const [browseIndex, setBrowseIndex] = useState(activeIndex);
  // selectedFileId가 바깥에서 바뀌거나(다른 화면 전환 등) 슬롯 목록이 막
  // 도착해 activeIndex가 -1→실제 값으로 바뀔 때 탐색 위치도 맞춘다.
  useEffect(() => {
    setBrowseIndex(activeIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex]);

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

  // 🔧 2026-09: 응답 오기 전엔 아예 아무것도 안 그리다가(return null) 응답이
  // 도착하는 순간 전환 UI가 레이아웃에 갑자기 끼어들어 그 아래 콘텐츠가
  // 훅 밀리는 "짠" 현상이 있었다(사용자 지적) — 실제 카드와 같은 크기의
  // 자리표시자를 먼저 그려 그 자리를 미리 차지해둔다.
  if (weeks === null || maxWeeks === 0) {
    return <div className="h-11 w-full animate-pulse rounded-full bg-muted/50 sm:h-12" aria-hidden />;
  }

  function goTo(index: number) {
    const target = slots[index];
    if (index === currentWeekIndex) {
      onSelect(null, null);
    } else if (target) {
      onSelect(target.fileId, target);
    }
    // target이 null(아직 데이터 없는 과거 슬롯)이면 이동만 하고 선택은
    // 바꾸지 않는다 — 아래에서 "데이터 없음"만 보여주고 화살표는 계속
    // 눌러 다른 슬롯으로 넘어갈 수 있게 둔다.
  }

  // 🔧 [사용자 지시] "데이터가 없으면 넘어가지 않도록" — 원래는 화살표로
  // "데이터 없음" 슬롯까지도 이동은 허용하고 그 자리에서만 선택을 안 바꿨는데,
  // 그 슬롯으로 이동 자체가 안 되도록 막는다(그 방향 화살표를 비활성화).
  function hasDataAt(index: number): boolean {
    if (index === currentWeekIndex) return true;
    return !!slots[index]?.hasData;
  }

  function step(delta: 1 | -1) {
    const next = browseIndex + delta;
    if (next < 0 || next >= slots.length || !hasDataAt(next)) return;
    setBrowseIndex(next);
    goTo(next);
  }

  const browsedSlot = slots[browseIndex];
  const browsedIsCurrentWeek = browseIndex === currentWeekIndex;
  const thisWeek = thisWeekRange();

  return (
    // 🔧 [사용자 지시] "깔끔하게" — 가운데 필박스 배경/테두리와 화살표의
    // 원형 배경 버튼을 모두 없애고, 아이콘과 텍스트만 남긴 미니멀한 한 줄로.
    <div className="flex w-full items-center justify-center gap-3">
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={!hasDataAt(browseIndex - 1)}
        aria-label="이전 주차"
        className="flex shrink-0 items-center justify-center p-1 text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-25"
      >
        <ChevronLeft className="size-4 sm:size-5" strokeWidth={2.5} />
      </button>

      <div className="flex items-center gap-1.5 text-center">
        <CalendarDays className="size-3.5 shrink-0 text-primary sm:size-4" strokeWidth={ICON_STROKE.default} />
        <span className="text-sm font-medium sm:text-base">
          {browsedIsCurrentWeek ? "이번 주" : `${browseIndex + 1}/${maxWeeks}주차`}
        </span>
        <span className="text-sm text-muted-foreground sm:text-base">
          {browsedIsCurrentWeek
            ? `${thisWeek.start} ~ ${thisWeek.end}`
            : browsedSlot
              ? `${formatDate(browsedSlot.weekOf)} ~ ${formatDate(browsedSlot.weekTo)}`
              : "데이터 없음"}
        </span>
      </div>

      <button
        type="button"
        onClick={() => step(1)}
        disabled={!hasDataAt(browseIndex + 1)}
        aria-label="다음 주차"
        className="flex shrink-0 items-center justify-center p-1 text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-25"
      >
        <ChevronRight className="size-4 sm:size-5" strokeWidth={2.5} />
      </button>
    </div>
  );
}
