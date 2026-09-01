import { useEffect, useState } from "react";
import { registerServiceWorker } from "@/lib/push/registerSW";
import { urlBase64ToUint8Array, VAPID_PUBLIC_KEY } from "@/lib/push/vapid";
import { sha256Hex } from "@/lib/push/endpointHash";
import { useApi } from "./useApi";
import type { ListPushDevicesResponse } from "@/lib/api/types";

type PushState = "checking" | "on" | "off" | "unsupported";

export function usePushSubscription() {
  const { call } = useApi();
  const [state, setState] = useState<PushState>("checking");
  const [message, setMessage] = useState<{ text: string; type: "error" | "ok" } | null>(null);
  // 서버 기준으로 "지금 이 브라우저"에 해당하는 기기 목록 항목의 id(=서버
  // 저장 키 이름). NotifyPrefsCard가 "이 기기 자신"을 지울 때, 브라우저의
  // 실제 구독도 함께 해지시키는 데 쓴다.
  const [selfDeviceId, setSelfDeviceId] = useState<string | null>(null);
  // enable() 직후 NotifyPrefsCard가 "알림 받는 기기" 목록에 새 기기를
  // 낙관적으로 바로 얹을 수 있도록 함께 넘긴다(재조회 시 KV 결과적
  // 일관성으로 아직 안 보일 수 있으므로).
  const [justEnabledLabel, setJustEnabledLabel] = useState<string | null>(null);

  // 브라우저가 구독 객체를 갖고 있는지뿐 아니라, 그 endpoint가 서버에도
  // 실제로 등록돼 있는지까지 확인한다 — "알림 받는 기기" 목록에서 이
  // 기기 자신의 서버 기록을 지운 경우, 브라우저는 여전히 자기가 구독
  // 중이라 믿고 있어(실제로는 서버가 몰라 알림이 전혀 안 오는데도)
  // "알림 켜짐"으로 뜨는 어긋남이 있었다(사용자 지적). enable() 직후에도
  // 같은 확인이 필요해 재사용 가능한 함수로 뺐다.
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
      if (!sub) {
        setSelfDeviceId(null);
        setState("off");
        return;
      }
      const hash = await sha256Hex(sub.endpoint);
      const data = await call<ListPushDevicesResponse>("/push/devices");
      const selfDevice = (data.devices || []).find((d) => d.id.endsWith(`:${hash}`));
      setSelfDeviceId(selfDevice ? selfDevice.id : null);
      setState(selfDevice ? "on" : "off");
    } catch (err) {
      setState("unsupported");
      setMessage({
        text: `Service Worker 등록 실패: ${err instanceof Error ? err.message : String(err)}`,
        type: "error",
      });
    }
  }

  useEffect(() => {
    check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // 🔧 [알림 켜기 직후 상태가 안 바뀌던 문제 수정] 원래는 여기서 다시
      // check()를 불러 /push/devices로 재확인했는데, Cloudflare KV는 쓰기
      // 직후 list 조회에 결과적 일관성만 보장해 방금 등록한 구독이 곧바로
      // 안 보일 수 있었다(사용자 지적: 메시지는 "켜짐"인데 상단 상태·버튼은
      // 계속 "꺼짐"으로 남음). 서버가 /push/subscribe 응답에 실어주는
      // deviceId를 그대로 신뢰해 즉시 상태를 맞춘다 — 재조회가 필요 없다.
      const { deviceId, deviceLabel } = await call<{ ok: true; deviceId: string; deviceLabel: string }>(
        "/push/subscribe",
        { method: "POST", body: { subscription: sub.toJSON() } }
      );
      setSelfDeviceId(deviceId);
      setJustEnabledLabel(deviceLabel);
      setState("on");
      setMessage({ text: "알림이 켜졌습니다.", type: "ok" });
    } catch (err) {
      setMessage({ text: `오류: ${err instanceof Error ? err.message : String(err)}`, type: "error" });
    }
  }

  // "알림 받는 기기" 목록에서 지금 이 브라우저 자신의 항목을 지울 때 함께
  // 호출한다 — 서버 기록만 지우고 브라우저의 실제 구독은 그대로 두면,
  // 브라우저는 계속 자기가 구독 중이라 믿어 "알림 켜짐"으로 표시되지만
  // 실제로는 서버가 몰라 알림이 전혀 안 오는 어긋난 상태가 된다.
  async function unsubscribeSelf() {
    try {
      const reg = await registerServiceWorker();
      const sub = await reg.pushManager.getSubscription();
      await sub?.unsubscribe();
    } catch {
      // 브라우저 쪽 해지가 실패해도 서버 기록 삭제 자체는 이미 별도로
      // 처리되었으므로 조용히 넘어간다 — 다음 페이지 로드 시 재확인된다.
    }
    setSelfDeviceId(null);
    setState("off");
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

  return { state, message, enable, sendTest, selfDeviceId, unsubscribeSelf, justEnabledLabel };
}
