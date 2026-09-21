import path from "path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// 🔧 [2026-09-22 사용자 지시: "프론트엔드 테스트 도구도 정비해"] —
// 이 프로젝트엔 그동안 tests/e2e/(Playwright, 레이아웃 구조 회귀만
// 다룸)만 있었고, hooks/순수 로직 단위 테스트가 전혀 없었다. vite.config.ts
// 에 test 옵션을 얹지 않고 별도 파일로 분리한 이유: playwright.config.ts
// 와 대칭을 이루고("어느 도구가 무엇을 담당하는지"가 파일명만으로
// 분명해짐), vite.config.ts가 프로덕션 번들링 설정에만 집중하게 해
// 두 설정이 서로의 관심사를 침범하지 않게 한다.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // vite.config.ts와 동일한 "@" 별칭 — 별도로 유지보수하지 않도록
    // 값이 갈리면 바로 눈에 띄게 동일한 상대 경로 계산식을 쓴다.
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    // hooks(useState/useEffect 등)와 DOM API(localStorage, matchMedia 등)를
    // 쓰는 컴포넌트를 테스트하려면 jsdom이 필요하다 — 순수 로직 테스트는
    // jsdom 없이도 동작하지만, 환경을 프로젝트 전체에서 하나로 통일해
    // "이 파일만 jsdom이 필요하다"는 걸 매번 따로 관리하지 않는다.
    environment: "jsdom",
    // tests/e2e/*는 Playwright 전용 스위트라 완전히 분리한다 — 두 스위트가
        // 같은 파일 패턴을 두고 서로 다른 실행기로 충돌할 위험을 원천 차단.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
  },
});
