import { useEffect, useRef } from "react";

type VersionInfo = { version: string };

// 🔧 [버그 수정, 2026-09-20 사용자 지시: "배포될 때마다 앱을 껐다
// 켜야하는데 혹시 켜져 있더라도 자동으로 반영되도록 할 수는 없나"] —
// 이 폴링은 GitHub Pages의 정적 파일(version.json)만 대상으로 하며,
// KV 쓰기 한도가 있는 Cloudflare Worker/KV와는 완전히 분리된 별개
// 경로다(import.meta.env.BASE_URL이 vite.config.ts의 base='/gongcam/'
// 를 그대로 가리켜 항상 GitHub Pages 도메인으로만 감). GitHub Pages는
// 이 정도 정적 파일 요청 빈도에 과금되거나 제한되지 않으므로, 주기를
// 줄이는 게 KV 절약 정책(idleTracker, MyStatusProvider 등 별개 대상)과
// 겹치거나 그 한도에 영향을 주지 않는다.
//
// 기존에도 자동 반영 로직 자체는 있었지만(폴링 + visibilitychange),
// iOS PWA(홈 화면에 추가해 standalone으로 실행하는 앱)는 백그라운드로
// 보내지면 iOS가 WebView의 JS 실행 자체를 완전히 정지(suspend)시킬 수
// 있어 setInterval 타이머가 멈추고, 다시 포그라운드로 돌아왔을 때도
// visibilitychange 이벤트가 안정적으로 발생하지 않는 경우가 있었다 —
// 그 결과 "앱이 계속 켜져 있었다"고 인식되는 상태에서 배포된 새 버전이
// 반영되지 않고, 완전히 껐다 켜야만(=페이지 자체가 처음부터 다시
// 로드되어야만) 새 코드를 받아왔다. visibilitychange 외에
// pageshow(뒤로가기/캐시된 페이지 복귀 포함)와 focus(윈도우 포커스,
// 일부 iOS 버전에서 visibilitychange보다 더 안정적으로 발생) 이벤트도
// 함께 구독해 복귀 감지 경로를 넓히고, 주기 자체도 5분→1분으로
// 줄여 "포그라운드 이벤트가 아예 안 뜨고 오래 켜놨을 때"의 최대
// 지연도 함께 줄인다.
const CHECK_INTERVAL_MS = 60 * 1000;

// GitHub Pages가 index.html을 10분간 캐싱해, 배포 후에도 이미 열려 있는
// 탭/PWA가 옛 번들을 계속 쓰는 문제가 있었다. version.json을 no-store로
// 주기적으로/포그라운드 복귀 시 확인해, 빌드 시점 버전과 다르면 새로고침한다.
export function useVersionCheck() {
  const checkingRef = useRef(false);

  useEffect(() => {
    async function check() {
      if (checkingRef.current) return;
      checkingRef.current = true;
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data: VersionInfo = await res.json();
        if (data.version && data.version !== __APP_VERSION__) {
          window.location.reload();
        }
      } catch {
        // 네트워크 오류는 무시 — 다음 체크 때 다시 시도
      } finally {
        checkingRef.current = false;
      }
    }

    check();
    const timer = setInterval(check, CHECK_INTERVAL_MS);

    function onVisible() {
      if (document.visibilityState === "visible") check();
    }
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", check);
    window.addEventListener("focus", check);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", check);
      window.removeEventListener("focus", check);
    };
  }, []);
}
