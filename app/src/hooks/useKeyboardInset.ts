import { useEffect, useState } from "react";

// 🔧 [사용자 지시, 2026-09-20] "메시지 보내기에 탭 해서 입력 상태가 되면
// 카카오톡처럼 되면 좋겠는데 너무 여백이 많이 생겨" — 채팅 박스는
// 100dvh 기준 절대 높이로 고정돼 있는데(ChatPage.tsx), iOS Safari는
// 소프트웨어 키보드가 올라와도 레이아웃 뷰포트(따라서 dvh 값)를 줄이지
// 않는 게 표준 동작이다(키보드는 그 위에 오버레이될 뿐 문서 흐름에
// 영향을 주지 않음) — 그 결과 키보드가 화면 아래쪽을 가려도 우리 박스는
// 원래 높이 그대로 남아, 입력창이 키보드 바로 위에 붙지 못하고 그 사이에
// 큰 빈 공간(가려진 영역)이 생겼다. window.visualViewport는 이 키보드
// 오버레이를 반영해 실제로 보이는 영역만큼만 높이가 줄어드는 별도
// API라(레이아웃 뷰포트와 별개), 그 차이(레이아웃 높이 - visualViewport
// 높이)가 곧 키보드가 가리는 픽셀 수다. 이 값을 반환해 채팅 박스 높이
// 계산에서 빼면, 키보드가 뜬 만큼 박스가 줄어들어 입력창이 항상 키보드
// 바로 위에 붙는다.
export function useKeyboardInset() {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const viewport: VisualViewport | null = window.visualViewport;
    if (!viewport) return;

    const update = () => {
      // 🔧 레이아웃 뷰포트(window.innerHeight)와 visualViewport 높이의
      // 차이 — 키보드가 없으면 0에 가깝고(브라우저 UI 자체의 미세한
      // 차이는 무시), 키보드가 뜨면 그 높이만큼 벌어진다. offsetTop도
      // 함께 빼야 하는 이유: 일부 브라우저는 키보드가 뜰 때 visualViewport
      // 자체를 위로 밀어올리기도 해(offsetTop > 0), 단순 높이 차이만으로는
      // 부족한 경우가 있다 — 실측 안전을 위해 둘 다 반영한다.
      const heightDiff = window.innerHeight - viewport.height - viewport.offsetTop;
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
