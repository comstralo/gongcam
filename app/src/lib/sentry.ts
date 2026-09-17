import * as Sentry from "@sentry/react";

// 프론트엔드(React) 전용 Sentry 프로젝트 — Worker 백엔드는 별도로 계측하지
// 않는다(Cloudflare Workers는 콘솔 로그와 "사용량 모니터링" 화면으로 이미
// 관찰 중이라 이번 범위 밖). DSN은 비밀값이 아니라 클라이언트에 항상
// 노출되는 공개 식별자라 다른 상수들과 동일하게 소스에 직접 둔다.
const SENTRY_DSN = "https://baa0108f57723788701a64bcb990c840@o4512053003747328.ingest.us.sentry.io/4512053014298624";

export function initSentry() {
  Sentry.init({
    dsn: SENTRY_DSN,
    // 로컬 dev(vite dev)에서 난 에러가 프로덕션 알림과 섞이지 않도록 구분한다
    // — HMR로 모듈이 교체되는 과도기에 나는 일회성 에러(예: Provider 언마운트
    // 도중 useContext 호출)가 실제 운영 이슈처럼 메일로 오는 문제가 있었다.
    environment: import.meta.env.DEV ? "development" : "production",
    // 로컬 개발 중의 노이즈는 아예 전송하지 않는다 — environment 태그만으로도
    // Sentry 대시보드에서 필터링은 가능하지만, dev 환경에서는 애초에 이벤트
    // 자체를 안 보내는 편이 이메일 알림 소음을 없애는 데 더 확실하다.
    enabled: !import.meta.env.DEV,
    // 배포 버전(version.json이 이미 커밋 해시 기반으로 관리 중 — useVersionCheck.ts
    // 참고)과 굳이 중복 추적하지 않는다. 세션 리플레이/트레이싱은 무료 티어
    // 이벤트 예산을 빠르게 소진할 수 있어 켜지 않고, 순수 에러 수집만 한다.
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
  });
}
