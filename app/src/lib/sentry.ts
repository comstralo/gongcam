import * as Sentry from "@sentry/react";

// 프론트엔드(React) 전용 Sentry 프로젝트 — Worker 백엔드는 별도로 계측하지
// 않는다(Cloudflare Workers는 콘솔 로그와 "사용량 모니터링" 화면으로 이미
// 관찰 중이라 이번 범위 밖). DSN은 비밀값이 아니라 클라이언트에 항상
// 노출되는 공개 식별자라 다른 상수들과 동일하게 소스에 직접 둔다.
const SENTRY_DSN = "https://baa0108f57723788701a64bcb990c840@o4512053003747328.ingest.us.sentry.io/4512053014298624";

export function initSentry() {
  Sentry.init({
    dsn: SENTRY_DSN,
    // 배포 버전(version.json이 이미 커밋 해시 기반으로 관리 중 — useVersionCheck.ts
    // 참고)과 굳이 중복 추적하지 않는다. 세션 리플레이/트레이싱은 무료 티어
    // 이벤트 예산을 빠르게 소진할 수 있어 켜지 않고, 순수 에러 수집만 한다.
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
  });
}
