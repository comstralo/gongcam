import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { registerServiceWorker } from '@/lib/push/registerSW'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
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
