// 모든 테스트 파일 실행 전 한 번 로드된다(vitest.config.ts의 setupFiles).
// jest-dom의 커스텀 matcher(toBeInTheDocument 등)를 vitest의 expect에 확장한다.
import "@testing-library/jest-dom/vitest";
