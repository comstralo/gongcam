import { useEffect, useState } from "react";

// 🔧 [사용자 지시, 2026-09-20] "메시지 보내기에 탭 해서 입력 상태가 되면
// 카카오톡처럼 되면 좋겠는데 너무 여백이 많이 생겨" → 실기기(아이폰)
// 디버그 배지로 여러 차례 실측해 정확한 원인을 확인했다: iOS Safari는
// 키보드가 뜰 때 100dvh나 레이아웃 자체를 줄이지 않고, 대신 "카메라"
// (visualViewport)를 문서 좌표계 안에서 키보드 높이만큼 아래로
// 이동(offsetTop > 0)시킨다.
//
// 🔧 [버그 수정] 이 오프셋을 "박스 전체에 translateY"로 보정하는 방식을
// 두 차례 시도했으나 계속 새 문제를 만들었다 — 박스 전체를 옮기면
// 헤더까지 화면 밖으로 밀려났고(1차), 헤더만 translateY 대상에서
// 빼자 이번엔 헤더가 원래 레이아웃 뷰포트 좌표(카메라가 이미 이동해
// 실제로는 화면 밖) 그대로 남아 아예 안 보였다(2차) — translateY는
// "레이아웃 흐름 안에서 상대적으로 옮기는" 도구라, 애초에 좌표계
// 자체가 어긋난 이 문제(카메라가 문서 전체와 다른 위치로 이동)를
// 부분적으로만 보정하면 반드시 다른 부분이 깨진다.
//
// 근본 해법(실제 카카오톡 웹뷰 등 모바일 채팅 UI가 쓰는 표준 패턴):
// 채팅 컨테이너 자체를 position:fixed로 만들고, top/height를
// visualViewport.offsetTop/height로 직접 계산한다. position:fixed는
// 원래 레이아웃 뷰포트 기준이라 카메라 이동과 무관하지만, 그 top/height
// 값 자체를 매 resize마다 "지금 카메라가 정확히 어디 있는지"로 다시
// 계산해서 갱신하면, 컨테이너가 사실상 카메라를 그대로 따라다니게
// 된다 — 헤더든 입력창이든 컨테이너 내부의 상대적 레이아웃(flex)은
// 전혀 건드리지 않고 그대로 유지되므로 부분적 보정 문제 자체가
// 생기지 않는다.
export type ViewportRect = { top: number; height: number };

// 🔧 [버그 수정, 2026-09-20 사용자 지시: "위쪽이 잘리는 현상이 전혀
// 개선이 안됐어"] — ChatPage의 headerOffsetPx가 AppShell 헤더 높이를
// 74px 하드코딩값으로 써왔는데, 이건 env(safe-area-inset-top)이 0이던
// (viewport-fit=cover 추가 전) 시절의 실측값이었다. 그 값을 추가한
// 이후 실제 헤더는 이 세이프에어리어만큼(실측: 아이폰에서 47px) 더
// 커졌는데 74px는 그대로라, 채팅 컨테이너가 그 늘어난 만큼 헤더 위에
// 겹쳐 올라가 헤더가 잘려 보였다(디버그 배지로 env-top:47px 확인).
// CSS의 env()는 JS 인라인 style 계산식 안에서 직접 쓸 수 없으므로,
// 화면에 보이지 않는 프로브 엘리먼트로 실제 계산된 padding 값을 읽어
// px 숫자로 노출한다 — 회전 등으로 값이 바뀔 수 있어 resize에도
// 반응한다.
export function useSafeAreaInsetTop(): number {
  return useSafeAreaInset("top");
}

// 🔧 [버그 수정, 2026-09-20 사용자 지시: "네비바 하단에 여백이
// 가득한데"] — 하단도 같은 문제였다: TabBar/AppShell 여러 곳에 흩어진
// 하드코딩 여백(22px 등)이 전부 "env(safe-area-inset-bottom)이 항상
// 0으로 평가되던 시절"의 순수 시각적 여백이었는데, viewport-fit=cover
// 추가로 그 env 값이 실제로 채워지면서(실측 34px) 각 자리에 중복으로
// 더해져 여백이 과해졌다. top/bottom 모두 같은 프로브 패턴을 쓰므로
// 방향을 매개변수로 받는 공용 훅으로 합쳐, 앞으로 이런 값이 필요한
// 곳은 전부 이 훅에서 실측하게 한다.
function useSafeAreaInset(side: "top" | "bottom"): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const probe = document.createElement("div");
    probe.style.position = "fixed";
    probe.style[side] = "0";
    probe.style[side === "top" ? "paddingTop" : "paddingBottom"] = `env(safe-area-inset-${side}, 0px)`;
    probe.style.visibility = "hidden";
    probe.style.pointerEvents = "none";
    document.body.appendChild(probe);

    const update = () => {
      const value = side === "top" ? getComputedStyle(probe).paddingTop : getComputedStyle(probe).paddingBottom;
      setInset(parseFloat(value) || 0);
    };
    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      document.body.removeChild(probe);
    };
  }, [side]);

  return inset;
}

export function useVisualViewportRect(): ViewportRect | null {
  const [rect, setRect] = useState<ViewportRect | null>(null);

  useEffect(() => {
    const viewport: VisualViewport | null = window.visualViewport;
    if (!viewport) return;

    // 🔧 [버그 수정, 2026-09-21 사용자 지시: "키보드가 올라왔다가
    // 내려가면 ^ 위치가 달라지잖아"] — 실기기 디버그 배지로 실측한
    // 결과, 키보드를 닫는 순간 visualViewport의 resize 이벤트가 최종
    // 안정값(예: 797, 홈 인디케이터 안전영역을 뺀 값) 이전에 과도값
    // (예: 844, 안전영역을 아직 안 뺀 전체 화면 높이로 보임 — iOS가
    // 키보드 축소 애니메이션 도중 레이아웃 뷰포트를 살짝 다르게
    // 보고하는 것으로 추정)을 먼저 한 번 쏘고, 그 뒤 안정값으로 다시
    // resize 이벤트가 오는데 이 두 번째 이벤트가 누락되거나 늦게
    // 도착해 화면엔 과도값 기준 레이아웃(컨테이너가 실제보다 커져
    // 하단에 빈 여백)이 그대로 남는 현상이 있었다. resize/scroll
    // 이벤트로 값이 바뀔 때마다 그 값을 즉시 반영하는 대신, 짧게
    // (120ms) 디바운스해 마지막 값만 반영한다 — 과도값→안정값으로
    // 이어지는 연속 이벤트 중 마지막(안정값) 것만 실제로 렌더링에
    // 쓰이므로, 두 번째 이벤트가 누락되는 경우와 무관하게 항상 최신
    // 값으로 수렴한다. 120ms는 사람이 인지하기엔 짧아 지연으로
    // 느껴지지 않으면서, 연속으로 오는 과도값들을 충분히 걸러낸다.
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        setRect({ top: viewport.offsetTop, height: viewport.height });
      }, 120);
    };
    const updateImmediate = () => {
      setRect({ top: viewport.offsetTop, height: viewport.height });
    };

    updateImmediate();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    // 🔧 [버그 수정] 데스크톱에서 브라우저 창 크기를 조절하면
    // visualViewport의 resize 이벤트가 즉시 따라오지 않아(실측:
    // window.innerHeight는 새 값으로 바뀌었는데 visualViewport.height는
    // 이전 창 크기에 머문 채 몇 초간 갱신 안 됨) 채팅 박스 하단이 실제
    // 창보다 넘치는 문제가 있었다. window의 resize도 함께 구독해
    // 안전망으로 삼는다 — 실기기 키보드 시나리오에서는 visualViewport
    // 이벤트가 더 정확하지만, 둘 다 결국 같은 update()를 부르므로
    // 무해하다.
    window.addEventListener("resize", update);
    return () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return rect;
}
