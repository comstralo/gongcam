import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import './index.css'
import App from './App.tsx'
import { registerServiceWorker } from '@/lib/push/registerSW'
import { initSentry } from '@/lib/sentry'

initSentry()

// 이전까지 이 앱엔 Error Boundary가 전혀 없어(렌더링 중 에러가 나면 흰
// 화면으로 크래시), Sentry.ErrorBoundary가 그 자리를 겸한다 — 에러를
// Sentry로 보내면서 동시에 최소한의 폴백 화면을 보여준다.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Sentry.ErrorBoundary
      fallback={({ resetError }) => (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm font-semibold">문제가 발생했습니다.</p>
          <p className="text-xs text-muted-foreground">
            잠시 후 다시 시도해 주세요. 문제가 계속되면 관리자에게 알려주세요.
          </p>
          <button
            type="button"
            onClick={() => {
              resetError();
              window.location.reload();
            }}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium"
          >
            새로고침
          </button>
        </div>
      )}
    >
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>,
)

// 푸시 구독 여부와 무관하게 항상 서비스워커를 등록해둔다 — 크롬/안드로이드가
// PWA 설치 가능(installable) 조건으로 활성 서비스워커를 요구하는데, 이전엔
// 사용자가 알림을 켤 때만 등록되어 대부분의 방문자에게 설치 배너/버튼이
// 뜰 조건 자체가 충족되지 않았다.
if ("serviceWorker" in navigator) {
  registerServiceWorker().catch((err) => {
    console.error("서비스워커 등록 실패", err);
  });
}
