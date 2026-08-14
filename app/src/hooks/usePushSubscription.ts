import { useEffect, useState } from "react";
import { registerServiceWorker } from "@/lib/push/registerSW";
import { urlBase64ToUint8Array, VAPID_PUBLIC_KEY } from "@/lib/push/vapid";
import { useApi } from "./useApi";

type PushState = "checking" | "on" | "off" | "unsupported";

export function usePushSubscription() {
  const { call } = useApi();
  const [state, setState] = useState<PushState>("checking");
  const [message, setMessage] = useState<{ text: string; type: "error" | "ok" } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setState("unsupported");
        setMessage({
          text: `이 브라우저/모드는 serviceWorker 또는 PushManager를 지원하지 않습니다. (standalone: ${
            (navigator as { standalone?: boolean }).standalone ?? "n/a"
          })`,
          type: "error",
        });
        return;
      }
      try {
        const reg = await registerServiceWorker();
        const sub = await reg.pushManager.getSubscription();
        if (!cancelled) setState(sub ? "on" : "off");
      } catch (err) {
        if (!cancelled) {
          setState("unsupported");
          setMessage({
            text: `Service Worker 등록 실패: ${err instanceof Error ? err.message : String(err)}`,
            type: "error",
          });
        }
      }
    }
    check();
    return () => {
      cancelled = true;
    };
  }, []);

  async function enable() {
    setMessage({ text: "알림 권한 요청 중...", type: "ok" });
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setMessage({ text: `브라우저 알림 권한이 거부되었습니다. (현재 상태: ${permission})`, type: "error" });
        return;
      }
      const reg = await registerServiceWorker();
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      await call("/push/subscribe", { method: "POST", body: { subscription: sub.toJSON() } });
      setMessage({ text: "알림이 켜졌습니다.", type: "ok" });
      setState("on");
    } catch (err) {
      setMessage({ text: `오류: ${err instanceof Error ? err.message : String(err)}`, type: "error" });
    }
  }

  async function sendTest() {
    setMessage({ text: "테스트 알림 전송 중...", type: "ok" });
    try {
      const data = await call<{ results: { status?: number; error?: string }[] }>("/push/send-test", {
        method: "POST",
      });
      const detail = (data.results || [])
        .map((r) => (r.error ? `오류: ${r.error}` : `상태 ${r.status}`))
        .join(" / ");
      setMessage({ text: `전송 완료 — ${detail}`, type: "ok" });
    } catch (err) {
      setMessage({ text: `오류: ${err instanceof Error ? err.message : String(err)}`, type: "error" });
    }
  }

  return { state, message, enable, sendTest };
}
