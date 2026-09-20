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

export function useVisualViewportRect(): ViewportRect | null {
  const [rect, setRect] = useState<ViewportRect | null>(null);

  useEffect(() => {
    const viewport: VisualViewport | null = window.visualViewport;
    if (!viewport) return;

    const update = () => {
      setRect({ top: viewport.offsetTop, height: viewport.height });
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
