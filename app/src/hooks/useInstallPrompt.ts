import { useCallback, useEffect, useState } from "react";

// beforeinstallprompt는 표준 DOM 타입에 없어 직접 정의한다.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone(): boolean {
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  // iOS Safari 전용 플래그(표준 API 아님).
  return (window.navigator as { standalone?: boolean }).standalone === true;
}

function isIosSafari(): boolean {
  const ua = window.navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && "ontouchend" in document);
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|Chrome/.test(ua);
  return isIos && isSafari;
}

export type InstallPlatform = "android" | "ios" | "unsupported";

export function useInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone());

  useEffect(() => {
    if (installed) return;
    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      setDeferredPrompt(null);
      setInstalled(true);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, [installed]);

  const platform: InstallPlatform = deferredPrompt
    ? "android"
    : isIosSafari()
      ? "ios"
      : "unsupported";

  const promptInstall = useCallback(async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") setInstalled(true);
    setDeferredPrompt(null);
  }, [deferredPrompt]);

  return {
    installed,
    // 안드로이드/크롬은 네이티브 프롬프트가 실제로 준비됐을 때만, iOS
    // Safari는 항상(수동 안내로) 설치 가능 취급 — 그 외(설치 조건 미충족
    // 데스크톱 브라우저 등)는 버튼 자체를 숨긴다.
    canInstall: !installed && (platform === "android" || platform === "ios"),
    platform,
    promptInstall,
  };
}
