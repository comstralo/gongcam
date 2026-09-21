// 🔧 [2026-09-22 사용자 지시: "프론트 도구도 보강 확실하게 하자"] —
// 이 파일 상단 주석에 기록된 실제 프로덕션 버그("제목과 하위 항목
// 크기가 똑같아 보인다"는 사용자 지적의 근본 원인)를 회귀 테스트로
// 고정한다: tailwind-merge가 커스텀 유틸리티(text-micro/text-micro-lg)
// 를 font-size 그룹으로 알지 못해 색상 클래스와 같은 충돌 그룹으로
// 오인, cn()을 거칠 때마다 크기 클래스가 조용히 삭제되던 문제.
import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("클래스 목록을 공백으로 이어붙인다", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("falsy 값(false/null/undefined)은 무시한다", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
  });

  it("같은 tailwind 유틸리티 그룹끼리는 나중 클래스가 이전 것을 덮어쓴다(표준 twMerge 동작)", () => {
    expect(cn("text-sm", "text-lg")).toBe("text-lg");
  });

  // 🔧 [회귀 방지, 실제 프로덕션 버그] 이 세션 상단 주석이 기록한 정확한
  // 재현: 커스텀 유틸리티(text-micro)와 색상 클래스(text-destructive)를
  // 함께 쓰면, extendTailwindMerge 확장 전에는 twMerge가 이 둘을 같은
  // "text 색상" 충돌 그룹으로 오인해 text-micro를 삭제했다(node로 직접
  // 재현된 실측: twMerge("text-micro text-destructive") ===
  // "text-destructive"). 확장 후에는 서로 다른 그룹(font-size vs
  // text-color)이라 둘 다 살아남아야 한다.
  it("커스텀 폰트 크기(text-micro)와 색상 클래스를 함께 써도 크기가 삭제되지 않는다", () => {
    const result = cn("text-micro text-destructive");
    expect(result).toContain("text-micro");
    expect(result).toContain("text-destructive");
  });

  it("text-micro-lg도 동일하게 색상 클래스와 충돌 없이 공존한다", () => {
    const result = cn("text-micro-lg text-muted-foreground");
    expect(result).toContain("text-micro-lg");
    expect(result).toContain("text-muted-foreground");
  });

  it("커스텀 폰트 크기끼리는 여전히 서로를 정상적으로 오버라이드한다(font-size 그룹 등록이 다른 크기 클래스를 깨지 않음)", () => {
    // text-micro와 text-micro-lg를 같은 font-size 그룹으로 등록했으므로,
    // 표준 twMerge 규칙대로 나중 클래스가 이겨야 한다.
    expect(cn("text-micro text-micro-lg")).toBe("text-micro-lg");
    expect(cn("text-micro-lg text-micro")).toBe("text-micro");
  });

  it("표준 폰트 크기(text-sm 등)와 커스텀 크기(text-micro)는 서로 다른 그룹이 아니라 같은 font-size 그룹으로 충돌한다", () => {
    // extendTailwindMerge가 text-micro를 "font-size" 그룹에 등록했으므로,
    // Tailwind 표준 크기 클래스(text-sm)도 같은 그룹이라 나중 것이 이긴다.
    expect(cn("text-sm text-micro")).toBe("text-micro");
  });
});
