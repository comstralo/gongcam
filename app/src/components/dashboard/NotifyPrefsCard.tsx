import { useEffect, useState } from "react";
import { Bell, Check, Pencil, Smartphone, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DividedValue, InfoCard } from "@/components/dashboard/shared";
import { usePushSubscription } from "@/hooks/usePushSubscription";
import { useApi } from "@/hooks/useApi";
import { useAuth } from "@/lib/auth/useAuth";
import { ICON_STROKE } from "@/lib/utils";
import type {
  AdminPushSendCategoryResponse,
  ListPushDevicesResponse,
  NotifyCategory,
  NotifyPrefsResponse,
  PushDevice,
  PushDeviceRemoveResponse,
  PushDeviceRenameResponse,
  PushDeviceToggleResponse,
  SetNotifyPrefsResponse,
} from "@/lib/api/types";

const PUSH_STATE_LABEL: Record<string, string> = {
  checking: "알림 상태 확인 중...",
  on: "ON",
  off: "OFF",
  unsupported: "이 브라우저는 푸시 알림을 지원하지 않습니다.",
};

export function NotifyPrefsCard({ name }: { name?: string }) {
  const { call } = useApi();
  const { isAdmin } = useAuth();
  const { state, message, enable, selfDeviceId, unsubscribeSelf, justEnabledLabel } = usePushSubscription();

  const [categories, setCategories] = useState<Record<NotifyCategory, string> | null>(null);
  const [prefs, setPrefs] = useState<Record<NotifyCategory, boolean> | null>(null);
  const [pendingCategory, setPendingCategory] = useState<NotifyCategory | null>(null);
  const [testingCategory, setTestingCategory] = useState<NotifyCategory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ text: string; type: "error" | "ok" } | null>(null);

  // 🔧 [푸시 중복 발송 대응] 서비스워커 재등록 등으로 endpoint가 바뀌면
  // 옛 구독이 정리되지 않고 남아있어, 같은 사람 앞으로 알림이 여러 번(예:
  // 2번) 가는 원인이 됐다(사용자 지적) — 정확한 기기 식별은 웹에서 불가능
  // 하므로, 대신 이 기기 목록을 보여주고 사용자가 직접 죽은/중복 기기를
  // 끄거나 지울 수 있게 한다.
  const [devices, setDevices] = useState<PushDevice[] | null>(null);
  const [pendingDeviceId, setPendingDeviceId] = useState<string | null>(null);
  // 자동 추정된 기기명("Windows · Chrome")은 같은 종류 기기가 여러 대면
  // 겹칠 수 있어, 사용자가 직접 구분할 수 있는 이름으로 바꿀 수 있게 한다.
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");

  function loadDevices() {
    call<ListPushDevicesResponse>("/push/devices")
      .then((data) => {
        const list = data.devices || [];
        // 🔧 [방금 켠 기기가 목록에 안 뜨던 문제 대응] KV는 쓰기 직후
        // list 조회에 결과적 일관성만 보장해, 알림을 막 켠 직후엔 이
        // 재조회 결과에 그 기기가 아직 안 보일 수 있다 — enable()이 넘겨준
        // 값으로 낙관적으로 보정한다.
        if (selfDeviceId && justEnabledLabel && !list.some((d) => d.id === selfDeviceId)) {
          list.unshift({ id: selfDeviceId, deviceLabel: justEnabledLabel, enabled: true, savedAt: Date.now() });
        }
        setDevices(list);
      })
      .catch(() => {});
  }

  useEffect(() => {
    if (state !== "on") return;
    let cancelled = false;
    call<NotifyPrefsResponse>("/notify-prefs")
      .then((data) => {
        if (cancelled) return;
        setCategories(data.categories);
        setPrefs(data.prefs);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "알림 설정을 불러오지 못했습니다."));
    loadDevices();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // 🔧 [삭제 시 브라우저-서버 상태 어긋남 수정] 이 목록에서 "지금 이
  // 브라우저 자신"의 항목을 끄거나 지울 때는, 서버 기록뿐 아니라 브라우저의
  // 실제 구독도 함께 해지해야 한다 — 서버 기록만 지우면 브라우저는 계속
  // 자기가 구독 중이라 믿어(실제로는 알림이 전혀 안 오는데도) "알림 켜짐"
  // 으로 표시되는 어긋남이 있었다(사용자 지적).
  function toggleDevice(device: PushDevice, enabled: boolean) {
    setPendingDeviceId(device.id);
    setError(null);
    call<PushDeviceToggleResponse>("/push/devices/toggle", { method: "POST", body: { id: device.id, enabled } })
      .then(() => {
        setDevices((prev) => (prev ? prev.map((d) => (d.id === device.id ? { ...d, enabled } : d)) : prev));
        if (!enabled && device.id === selfDeviceId) unsubscribeSelf();
      })
      .catch((err) => setError(err instanceof Error ? err.message : "기기 설정 변경에 실패했습니다."))
      .finally(() => setPendingDeviceId(null));
  }

  function removeDevice(device: PushDevice) {
    setPendingDeviceId(device.id);
    setError(null);
    call<PushDeviceRemoveResponse>("/push/devices/remove", { method: "POST", body: { id: device.id } })
      .then(() => {
        setDevices((prev) => (prev ? prev.filter((d) => d.id !== device.id) : prev));
        if (device.id === selfDeviceId) unsubscribeSelf();
      })
      .catch((err) => setError(err instanceof Error ? err.message : "기기 삭제에 실패했습니다."))
      .finally(() => setPendingDeviceId(null));
  }

  function startRename(device: PushDevice) {
    setEditingDeviceId(device.id);
    setEditingValue(device.deviceLabel);
  }

  function cancelRename() {
    setEditingDeviceId(null);
    setEditingValue("");
  }

  function confirmRename(device: PushDevice) {
    const trimmed = editingValue.trim();
    if (!trimmed || trimmed === device.deviceLabel) {
      cancelRename();
      return;
    }
    setPendingDeviceId(device.id);
    setError(null);
    call<PushDeviceRenameResponse>("/push/devices/rename", {
      method: "POST",
      body: { id: device.id, deviceLabel: trimmed },
    })
      .then((data) => {
        setDevices((prev) =>
          prev ? prev.map((d) => (d.id === device.id ? { ...d, deviceLabel: data.deviceLabel } : d)) : prev
        );
        cancelRename();
      })
      .catch((err) => setError(err instanceof Error ? err.message : "기기 이름 변경에 실패했습니다."))
      .finally(() => setPendingDeviceId(null));
  }

  function toggleCategory(category: NotifyCategory, enabled: boolean) {
    setPendingCategory(category);
    setError(null);
    call<SetNotifyPrefsResponse>("/notify-prefs", { method: "POST", body: { category, enabled } })
      .then((data) => setPrefs(data.prefs))
      .catch((err) => setError(err instanceof Error ? err.message : "알림 설정 저장에 실패했습니다."))
      .finally(() => setPendingCategory(null));
  }

  // 관리자 전용 — 실제 이벤트에 연결되기 전, 본인 계정으로 종류별 발송/차단이
  // 의도대로 동작하는지 즉시 확인해보는 용도.
  function sendTestToSelf(category: NotifyCategory) {
    if (!name) {
      setTestResult({ text: "본인 이름을 아직 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", type: "error" });
      return;
    }
    setTestingCategory(category);
    setTestResult(null);
    call<AdminPushSendCategoryResponse>("/admin/push/send-category", {
      method: "POST",
      body: { nickname: name, category },
    })
      .then((data) => {
        if (data.blocked) {
          setTestResult({ text: data.message || "이 종류를 꺼두어 발송하지 않았습니다.", type: "error" });
        } else {
          setTestResult({ text: "테스트 알림을 보냈습니다.", type: "ok" });
        }
      })
      .catch((err) => setTestResult({ text: err instanceof Error ? err.message : "테스트 발송에 실패했습니다.", type: "error" }))
      .finally(() => setTestingCategory(null));
  }

  return (
    <div className="flex flex-col gap-2.5">
      <InfoCard className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2.5">
          <span className="inline-flex min-w-0 flex-1 items-center gap-1.25 truncate text-xs font-semibold sm:text-sm">
            <Bell className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
            <DividedValue
              items={[
                "푸시 알림",
                <span className="truncate text-xs font-normal text-muted-foreground sm:text-sm">
                  {PUSH_STATE_LABEL[state]}
                </span>,
              ]}
            />
          </span>
          {state === "off" && (
            <Button size="sm" className="shrink-0 text-xs sm:text-sm" onClick={enable}>
              알림 켜기
            </Button>
          )}
        </div>

        {state === "on" && categories && prefs && (
          <div className="flex flex-col gap-1.5">
            {(Object.keys(categories) as NotifyCategory[]).map((key) => (
              <div key={key} className="flex items-center justify-between gap-2 pl-5 sm:pl-5.5">
                <span className="text-micro-lg text-muted-foreground before:mr-1 before:content-['└'] sm:text-xs">
                  {categories[key]}
                </span>
                <span className="inline-flex shrink-0 items-center gap-2">
                  {isAdmin && (
                    <button
                      type="button"
                      className="text-micro-lg font-medium text-muted-foreground/70 outline-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 sm:text-xs"
                      disabled={testingCategory === key}
                      onClick={() => sendTestToSelf(key)}
                      aria-label={`${categories[key]} 테스트 발송`}
                    >
                      전송
                    </button>
                  )}
                  <Switch
                    checked={prefs[key]}
                    disabled={pendingCategory === key}
                    onCheckedChange={(checked) => toggleCategory(key, checked)}
                    aria-label={categories[key]}
                  />
                </span>
              </div>
            ))}
          </div>
        )}

        {state === "on" && devices && devices.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t pt-2.5">
            <span className="inline-flex items-center gap-1.25 text-xs font-semibold sm:text-sm">
              <Smartphone className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
              알림 받는 기기
            </span>
            {devices.map((d) =>
              editingDeviceId === d.id ? (
                <div key={d.id} className="flex items-center gap-2 pl-5 sm:pl-5.5">
                  <Input
                    autoFocus
                    value={editingValue}
                    maxLength={30}
                    disabled={pendingDeviceId === d.id}
                    onChange={(e) => setEditingValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") confirmRename(d);
                      if (e.key === "Escape") cancelRename();
                    }}
                    className="h-6 flex-1 text-micro-lg sm:text-xs"
                    aria-label="기기 이름"
                  />
                  <span className="inline-flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      className="inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/70 outline-none hover:text-ok focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 sm:size-4.5"
                      disabled={pendingDeviceId === d.id}
                      onClick={() => confirmRename(d)}
                      aria-label="이름 변경 확인"
                    >
                      <Check className="size-3 sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                    </button>
                    <button
                      type="button"
                      className="inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/70 outline-none hover:text-destructive focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 sm:size-4.5"
                      disabled={pendingDeviceId === d.id}
                      onClick={cancelRename}
                      aria-label="이름 변경 취소"
                    >
                      <X className="size-3 sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                    </button>
                  </span>
                </div>
              ) : (
                <div key={d.id} className="flex items-center justify-between gap-2 pl-5 sm:pl-5.5">
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <span className="truncate text-micro-lg text-muted-foreground before:mr-1 before:content-['└'] sm:text-xs">
                      {d.deviceLabel}
                    </span>
                    <button
                      type="button"
                      className="inline-flex size-3.5 shrink-0 items-center justify-center rounded text-muted-foreground/50 outline-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 sm:size-4"
                      disabled={pendingDeviceId === d.id}
                      onClick={() => startRename(d)}
                      aria-label={`${d.deviceLabel} 이름 변경`}
                    >
                      <Pencil className="size-2.5 sm:size-3" strokeWidth={ICON_STROKE.default} />
                    </button>
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      className="inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/70 outline-none hover:text-destructive focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 sm:size-4.5"
                      disabled={pendingDeviceId === d.id}
                      onClick={() => removeDevice(d)}
                      aria-label={`${d.deviceLabel} 삭제`}
                    >
                      <X className="size-3 sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                    </button>
                    <Switch
                      checked={d.enabled}
                      disabled={pendingDeviceId === d.id}
                      onCheckedChange={(checked) => toggleDevice(d, checked)}
                      aria-label={`${d.deviceLabel} 알림 수신`}
                    />
                  </span>
                </div>
              )
            )}
          </div>
        )}
      </InfoCard>

      {(message || error || testResult) && (
        <Alert
          variant={error || testResult?.type === "error" ? "destructive" : message?.type === "error" ? "destructive" : "success"}
        >
          <AlertDescription>{error || testResult?.text || message?.text}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
