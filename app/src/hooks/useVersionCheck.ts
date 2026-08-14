import { useEffect, useRef } from "react";

type VersionInfo = { version: string };

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

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

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}
