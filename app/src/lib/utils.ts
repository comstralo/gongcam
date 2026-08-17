import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// lucide-react 아이콘 strokeWidth를 앱 전역에서 통일하기 위한 상수.
// default: 일반 인라인 아이콘 · emphasis: 강조가 필요한 상태 아이콘(굵게) ·
// large: size가 큰 아이콘(가늘게 해야 시각적으로 균형이 맞음)
export const ICON_STROKE = { default: 2.25, emphasis: 2.5, large: 1.75 } as const

