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
// API다 — "키보드가 없을 때의 visualViewport 높이"를 기준값으로 고정해
// 두고 그 값과 현재 값의 차이를 반환하면 곧 키보드가 가리는 픽셀 수다
// (아래 baselineHeight 참고 — 처음엔 window.innerHeight를 기준으로
// 썼다가 iOS 주소창 자동 접힘 때문에 오히려 부정확해져 이 방식으로
// 교체했다). 이 값을 반환해 채팅 박스 높이 계산에서 빼면, 키보드가 뜬
// 만큼 박스가 줄어들어 입력창이 항상 키보드 바로 위에 붙는다.
export function useKeyboardInset() {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const viewport: VisualViewport | null = window.visualViewport;
    if (!viewport) return;

    // 🔧 [버그 수정, 2026-09-20 사용자 지시: "여전히 아이폰에서 입력 시
    // 공백이 생겨" — 실제 아이폰 스크린샷으로 확인: 채팅 박스가 화면
    // 중간에서 멈추고, 그 아래(접기 힌트~진짜 키보드 사이)에 여전히
    // 큰 빈 공간이 남아 있었다] — window.innerHeight를 매번 다시
    // 읽어 "레이아웃 뷰포트"로 삼은 게 원인이었다. iOS Safari는 키보드가
    // 뜨는 동안 주소창이 자동으로 접히며 window.innerHeight 자체도
    // 함께 커지는데(키보드와 무관한 변화), 그 순간의 innerHeight를
    // 기준으로 삼으면 "주소창이 접힌 만큼 커진 값"과 "키보드가 줄인
    // visualViewport 값"이 서로 다른 시점의 서로 다른 원인으로 뒤섞여
    // 실제 키보드 높이보다 훨씬 작은 값이 계산됐다(실측: 화면 절반
    // 가까이 빈 공간이 남았는데도 계산된 inset은 그 절반에도 못
    // 미쳤음). 대신 "키보드가 없는 상태"의 visualViewport.height를
    // 최초 마운트 시점에 기준값으로 한 번만 고정해두고, 이후로는 항상
    // 그 고정 기준값과 현재 값의 차이만 본다 — 주소창 등 innerHeight
    // 자체의 변동과 완전히 무관해진다.
    let baselineHeight = viewport.height;

    const update = () => {
      // 키보드가 접혀 있는 상태(주소창 표시 등으로 baseline 이상 커진
      // 경우)라면 그게 새로운 "키보드 없음" 기준이므로 baseline을
      // 갱신한다 — 그래야 나중에 실제로 키보드가 뜰 때만 감소로 잡힌다.
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
