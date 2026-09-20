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

    // 🔧 [버그 수정, 2026-09-21] Mac Safari의 iOS 기기 웹 인스펙터로
    // 실기기(홈 화면에 추가한 PWA, standalone, iOS 27)에 직접 연결해
    // 콘솔에서 실측 확인: 키보드를 닫은 뒤 window.innerHeight와
    // visualViewport.height가 "둘 다 함께" 원래값(844)이 아니라 상단
    // 안전영역만큼(47px) 줄어든 값(797)에 머물렀다 — 즉 이건
    // visualViewport와 innerHeight 사이의 계산 불일치가 아니라, WebKit이
    // 보고하는 뷰포트 값 자체가 실제로 잘못됐다는 뜻이다("관측된 값 중
    // 최댓값을 기억"하는 이전 보정은, 페이지 로드 후 최댓값을 한 번도
    // 못 본 채 바로 재현하면 애초에 틀린 값을 최댓값으로 잘못 학습하는
    // 결함이 있었다).
    //
    // window.screen.height(디바이스의 물리적 화면 높이, CSS px 기준)는
    // 같은 기기에서 실측해도 이 버그의 영향을 받지 않고 항상 844로
    // 고정되어 있음을 확인했다(웹 인스펙터 콘솔 실측). 키보드가 없을
    // 때는 이 값을 "진짜 뷰포트 높이"로 신뢰하고, 키보드가 떠 있을 때
    // (offsetTop > 0)만 그 순간엔 정확한 visualViewport.height를 그대로
    // 쓴다 — 지금까지 문제가 된 경우는 전부 "키보드를 닫은 후"였고
    // "키보드가 떠 있는 동안"의 값은 실측에서 항상 정확했다.
    const update = () => {
      const offsetTop = viewport.offsetTop;
      // screen.height/width는 방향(세로/가로)에 따라 실제 의미가 바뀌므로
      // (iOS는 회전 시 이 둘의 값 자체를 서로 교체) 매번 다시 읽어,
      // 현재 방향에서 "더 큰 실측 대비"가 아니라 실제 세로 길이를 쓰도록
      // window.innerWidth(레이아웃 뷰포트, 이 훅이 다루는 height 버그와
      // 무관하게 항상 정확함)와 비교해 방향을 판단한다.
      const isLandscape = window.innerWidth > window.screen.width;
      const screenHeight = isLandscape ? window.screen.width : window.screen.height;
      const height = offsetTop > 0 ? viewport.height : screenHeight;
      setRect({ top: offsetTop, height });
    };

    update();
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
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return rect;
}
