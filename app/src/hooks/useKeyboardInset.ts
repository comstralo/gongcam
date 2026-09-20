import { useEffect, useState } from "react";

// 🔧 [사용자 지시, 2026-09-20] "메시지 보내기에 탭 해서 입력 상태가 되면
// 카카오톡처럼 되면 좋겠는데 너무 여백이 많이 생겨" → 실기기(아이폰)
// 디버그 배지로 여러 차례 실측해 정확한 원인을 확인했다:
//
// 1) 100dvh는 키보드가 떠도 전혀 줄지 않는다(실측: dvh와 base가 항상
//    동일) — 채팅 박스의 높이 계산(calc(100dvh - ... - inset)) 자체는
//    처음부터 정확했다.
// 2) body를 position:fixed로 완전히 잠가도(문서 스크롤 자체를 원천
//    차단) 문제가 재현됐다 — 즉 원인이 "문서가 스크롤된다"는 것도
//    아니었다.
// 3) 결정적 실측: 키보드가 뜨면 visualViewport.offsetTop이 정확히
//    keyboardInset과 같은 값으로 커진다(예: inset=369, offsetTop=369,
//    raw+offsetTop=base). 즉 iOS Safari는 키보드가 뜰 때 레이아웃
//    자체를 줄이는 게 아니라 "카메라(visualViewport)를 문서 좌표계
//    안에서 아래로 이동시킨다" — body 스크롤과는 무관한, iOS 고유의
//    visualViewport 오프셋이다.
//
// 결론: 채팅 박스는 높이만 줄여서는 부족하고, 그 offsetTop만큼 함께
// 아래로 이동(translateY)해야 실제 카메라(visualViewport) 안에 다시
// 들어온다 — 높이 축소(inset)와 위치 이동(offsetTop)은 이 오프셋의
// 서로 다른 두 측면이라 값이 항상 같다.
export function useKeyboardInset() {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const viewport: VisualViewport | null = window.visualViewport;
    if (!viewport) return;

    // 키보드가 없는 상태의 visualViewport 높이를 기준값으로 고정해두고,
    // 그 값과 현재 값의 차이를 반환한다 — window.innerHeight는 iOS의
    // 주소창 자동 접힘으로 키보드와 무관하게 변동해 기준으로 삼기
    // 부적절하다(먼저 시도해 실패).
    let baselineHeight = viewport.height;

    const update = () => {
      if (viewport.height > baselineHeight) {
        baselineHeight = viewport.height;
      }
      const heightDiff = baselineHeight - viewport.height;
      setInset(Math.max(0, Math.round(heightDiff)));
    };

    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);

  return inset;
}
