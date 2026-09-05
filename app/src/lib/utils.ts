import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// 🔧 2026-09 [핵심 버그 발견·수정]: index.css가 @utility로 등록한 커스텀
// 폰트 크기(text-micro/text-micro-lg, 10px/11px)를 tailwind-merge가 모르는
// 클래스로 취급해, "text-{알수없는이름}"을 전부 text 색상 유틸리티와 같은
// 충돌 그룹으로 오인했다 — 그 결과 cn("text-micro-lg text-muted-foreground
// ...")처럼 커스텀 크기와 색상을 같이 쓰기만 하면(이 코드베이스 전역의
// SubRow 기본값이 정확히 이 패턴이다) merge 과정에서 크기 클래스가 조용히
// 삭제되고 색상만 남았다 — 실제로 node로 직접 재현: twMerge("text-micro
// text-destructive") === "text-destructive". "제목과 하위 항목 크기가
// 똑같아 보인다"는 지적이 이번 세션 내내 반복된 진짜 원인이 이것이었다 —
// SubRow의 작은 글씨가 cn()을 거칠 때마다 앱 전체에서 한 번도 실제로
// 적용된 적이 없었다. extendTailwindMerge로 이 두 커스텀 유틸리티를
// font-size 그룹에 정식 등록해, 색상 클래스와 더 이상 충돌 판정되지
// 않도록 고쳤다(다른 폰트 크기 클래스끼리는 여전히 정상적으로 서로를
// 오버라이드한다 — 위 node 테스트로 확인).
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": ["text-micro", "text-micro-lg"],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// lucide-react 아이콘 strokeWidth를 앱 전역에서 통일하기 위한 상수.
// default: 일반 인라인 아이콘 · emphasis: 강조가 필요한 상태 아이콘(굵게) ·
// large: size가 큰 아이콘(가늘게 해야 시각적으로 균형이 맞음)
export const ICON_STROKE = { default: 2.25, emphasis: 2.5, large: 1.75 } as const

