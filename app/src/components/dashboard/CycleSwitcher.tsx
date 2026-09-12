import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, RotateCw } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
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
// "N주차 : 08.02 ~ 08.09"처럼 현재 슬롯 하나만 보여주고 </> 로 넘기는
// 방식으로 바꿨다. N은 이 사이클 안에서 몇 번째 주인지(1~currentWeekNumber,
// 여러 사이클을 관통하는 누적 번호는 아니다)이고, 지금 진행 중인 마지막 슬롯
// (실시간, cycle 파라미터 없음)에는 "진행" 뱃지를 따로 붙여 구분한다.
export function CycleSwitcher({
  selectedFileId,
  onSelect,
  // 지금 조회 중인 회원 관점 — 실제 회원번호(관리자가 다른 회원을 보는
  // 중), "self"(본인 대시보드 — 서버가 세션 이메일로 본인을 판정), 또는
  // undefined(전체 랭킹처럼 특정 회원 관점이 없는 화면 — 필터링 없음).
  // 회원 관점이 있을 때, 그 회원이 해당 주차 명단에 없으면(중도 가입 등)
  // 그 슬롯을 "데이터 없음"으로 표시한다.
  memberNumber,
  // 🔧 [사용자 지시] "벌금 납부 처리 사이클 오인 방지" — true면 서버에
  // includeUnpaid=1을 함께 보내 각 슬롯의 미납 여부를 받아 점(dot)으로
  // 표시한다. 관리자 화면·본인 대시보드처럼 원래 미납 정보를 다루는
  // 화면만 켜야 한다 — 전체 랭킹처럼 원래 "누가 미납인지"를 노출하지
  // 않는 화면은 이 prop을 안 켜서, 서버 응답에 관련 필드 자체가
  // 실리지 않게 한다(단순히 화면에 안 그리는 것과 다르다).
  includeUnpaid = false,
  // 🔧 [사용자 지시] "예치금 재납 대상(forced) 사이클 오인 방지" — includeUnpaid와
  // 동일한 원칙. true면 서버에 includeForced=1을 함께 보내 각 슬롯의 forced
  // (페널티 2회 이상) 후보 존재 여부를 받아 점(dot)으로 표시한다.
  includeForced = false,
}: {
  selectedFileId: string | null;
  // week: 선택된 주차의 전체 정보(weekOf/weekTo 등) — "현재"를 고르면 null.
  // PEN·MONEY 탭처럼 실제 날짜 라벨을 다시 계산해야 하는 화면에서 쓴다.
  onSelect: (fileId: string | null, week?: CycleWeek | null) => void;
  memberNumber?: string;
  includeUnpaid?: boolean;
  includeForced?: boolean;
}) {
  const { call } = useApi();
  const [weeks, setWeeks] = useState<CycleWeek[] | null>(null);
  const [currentHasUnpaid, setCurrentHasUnpaid] = useState(false);
  const [currentHasForced, setCurrentHasForced] = useState(false);
  // 🔧 [버그 수정, 2026-09] 예전엔 이번 주가 사이클 몇 번째 주인지를
  // weeks.length(백업 개수)로 역산했다 — 그런데 sheet_reset이 백업을 뜨는
  // 시점과 사이클 값을 갱신하는 시점이 달라, 이번 주가 사이클 1주차로
  // 막 시작된 직후엔 weeks.length가 "방금 끝난 이전 사이클"의 개수를 담고
  // 있어 "3주차"처럼 잘못 표시됐다. 서버가 집계!D25를 직접 읽어 내려주는
  // currentWeekNumber를 그대로 쓴다(0이면 아직 응답 전).
  const [currentWeekNumber, setCurrentWeekNumber] = useState(0);
  // 🔧 [실패 시 무피드백 수정] 원래 실패를 그냥 삼켜서(catch(()=>{})) weeks가
  // 계속 null로 남아 토글 전체가 에러 표시 없이 조용히 사라졌다 — 사용자가
  // "지난 주 보기" 기능이 원래 있었는지조차 알 수 없었다. 실패 시 작은
  // 재시도 버튼을 보여준다.
  const [error, setError] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    const params = new URLSearchParams();
    if (memberNumber) params.set("member", memberNumber);
    if (includeUnpaid) params.set("includeUnpaid", "1");
    if (includeForced) params.set("includeForced", "1");
    const query = params.toString();
    call<CycleListResponse>(`/cycles${query ? `?${query}` : ""}`)
      .then((data) => {
        if (cancelled) return;
        setWeeks(data.weeks || []);
        setCurrentWeekNumber(data.currentWeekNumber || 0);
        setCurrentHasUnpaid(data.currentHasUnpaid ?? false);
        setCurrentHasForced(data.currentHasForced ?? false);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberNumber, includeUnpaid, includeForced, retryToken]);

  // 🔧 [버그 수정] 훅은 조건부 return보다 항상 먼저 호출돼야 한다(React
  // 훅 규칙) — weeks/maxWeeks가 아직 없을 때도 슬롯 계산이 빈 배열
  // 기준으로 안전하게 굴러가도록 미리 만들어두고, 실제 화면 분기는
  // 아래 JSX에서만 한다.
  const oldestFirst = weeks ? [...weeks].reverse() : [];
  // "이번 주" 앞에 와야 할 슬롯 수는 currentWeekNumber - 1(예: 2주차 진행
  // 중이면 1개) — weeks.length가 그보다 적으면(백업 조회 실패 등 드문 경우)
  // 남는 자리를 빈 슬롯으로 채운다.
  const missingCount = Math.max(0, currentWeekNumber - 1 - oldestFirst.length);
  const pastSlots: (CycleWeek | null)[] = [...Array(missingCount).fill(null), ...oldestFirst];
  // "이번 주"(fileId: null)를 항상 마지막 슬롯으로 붙인다 — 트랙 길이는
  // maxWeeks(항상 3칸)가 아니라 currentWeekNumber로 고정한다: 사이클이 아직
  // 안 끝난 시점에 이번 주 이후 슬롯(미래 주차)은 존재하지 않기 때문이다.
  const slots: (CycleWeek | null)[] = currentWeekNumber > 0 ? [...pastSlots, null] : [];
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
  if (weeks === null || currentWeekNumber === 0) {
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

  // 🔧 [사용자 지시] "이번 주 화면에 있어도 지난 주차에 미처리가 남아있는지
  // 미리 알려준다" — 슬롯 하나(index)에 미납/forced가 있는지를 공통으로
  // 판단하는 헬퍼. "이번 주" 슬롯(currentWeekIndex)은 weeks 배열에 없어
  // currentHasUnpaid/currentHasForced를 대신 본다.
  function hasPendingAt(index: number): boolean {
    if (index === currentWeekIndex) return currentHasUnpaid || currentHasForced;
    const slot = slots[index];
    return !!slot && (!!slot.hasUnpaid || !!slot.hasForced);
  }

  const browsedSlot = slots[browseIndex];
  const browsedIsCurrentWeek = browseIndex === currentWeekIndex;
  const browsedHasData = hasDataAt(browseIndex);
  const browsedHasPending = hasPendingAt(browseIndex);
  // 왼쪽(과거, 더 작은 인덱스)/오른쪽(더 큰 인덱스) 방향 중 지금 보고 있는
  // 슬롯을 제외한 어딘가에 미처리가 있으면 그 방향 화살표를 글로우한다 —
  // "지금 안 보이지만 다른 방향에 확인할 게 있다"는 유도 신호.
  const hasPendingToLeft = Array.from({ length: browseIndex }, (_, i) => i).some(hasPendingAt);
  const hasPendingToRight = Array.from({ length: slots.length - browseIndex - 1 }, (_, i) => browseIndex + 1 + i).some(
    hasPendingAt
  );
  const thisWeek = thisWeekRange();

  return (
    // 🔧 [사용자 지시] "깔끔하게" — 가운데 필박스 배경/테두리와 화살표의
    // 원형 배경 버튼을 모두 없애고, 아이콘과 텍스트만 남긴 미니멀한 한 줄로.
    <div className="flex w-full items-center justify-center gap-3">
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={!hasDataAt(browseIndex - 1)}
        aria-label={hasPendingToLeft ? "이전 주차 (확인이 필요한 처리 대상 있음)" : "이전 주차"}
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full p-1 text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-25",
          // 🔧 [사용자 지시] "과거 사이클의 미처리가 있다면 < 쪽에 글로우
          // 이펙트로 표시" — 지금 보고 있는 슬롯 자체가 아니라 그 방향
          // 어딘가에 미처리가 있다는 유도 신호. 비활성화된 화살표에는
          // 애초에 넘어갈 곳이 없으므로 글로우를 주지 않는다.
          hasPendingToLeft && hasDataAt(browseIndex - 1) && "text-destructive animate-unpaid-glow"
        )}
      >
        <ChevronLeft className="size-4 sm:size-5" strokeWidth={2.5} />
      </button>

      <div
        className={cn(
          "flex items-center gap-1.5 rounded-full text-center transition-shadow",
          // 🔧 [사용자 지시] "해당 주차에 미처리가 있으면 뱃지 ~ 날짜까지를
          // 글로우 처리" — 점 대신 이 그룹 전체에 은은한 발광 테두리를 준다.
          browsedHasPending && "px-2 py-0.5 shadow-[0_0_0_1px_var(--destructive)] animate-unpaid-glow"
        )}
      >
        {/* 🔧 [사용자 지시] "이번 주" 대신 다른 과거 슬롯과 동일하게
            "N주차"로 통일하고, 지금 진행 중인지/과거인지를 "N주차" 바로
            왼쪽에 뱃지로 표시한다("진행"→"현재", 과거 슬롯이면 "과거").
            데이터가 없는 슬롯(browsedHasData=false)은 애초에 "몇 주차"
            자체가 의미 없으므로 뱃지를 생략한다. 패딩을 TintedPill과
            동일하게 맞춰 "확정" 등 다른 뱃지와 크기를 통일한다(원래
            px-1.5 py-0.5로 더 작았음). 🔧 [사용자 지시] "뱃지는 아까
            키웠잖아? 지금보니까 살짝 작은게 나은 것 같다" — TintedPill과
            함께 한 단계씩 낮춘다(text-xs sm:text-sm). */}
        {browsedHasData && (
          <span
            className={cn(
              "rounded-full px-2.5 py-0.5 text-xs font-bold sm:text-sm",
              browsedIsCurrentWeek ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
            )}
          >
            {browsedIsCurrentWeek ? "현재" : "과거"}
          </span>
        )}
        {/* 🔧 [사용자 지시] "3주차"와 날짜의 색을 서로 바꾼다 — 주차 숫자는
            보조 정보로 muted, 실제 날짜 구간이 더 중요한 정보이므로
            기본 전경색으로. */}
        <span className="text-sm font-medium text-muted-foreground sm:text-base">{browseIndex + 1}주차</span>
        <span className="text-sm font-medium sm:text-base">
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
        aria-label={hasPendingToRight ? "다음 주차 (확인이 필요한 처리 대상 있음)" : "다음 주차"}
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full p-1 text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-25",
          hasPendingToRight && hasDataAt(browseIndex + 1) && "text-destructive animate-unpaid-glow"
        )}
      >
        <ChevronRight className="size-4 sm:size-5" strokeWidth={2.5} />
      </button>
    </div>
  );
}
