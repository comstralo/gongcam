import { useEffect, useState } from "react";
import { Bell, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DividedValue, InfoCard } from "@/components/dashboard/shared";
import { usePushSubscription } from "@/hooks/usePushSubscription";
import { useApi } from "@/hooks/useApi";
import { useAuth } from "@/lib/auth/useAuth";
import { ICON_STROKE, cn } from "@/lib/utils";
import type { AdminPushSendCategoryResponse, NotifyCategory, NotifyPrefsResponse, SetNotifyPrefsResponse } from "@/lib/api/types";

const PUSH_STATE_LABEL: Record<string, string> = {
  checking: "알림 상태 확인 중...",
  on: "알림 켜짐",
  off: "알림 꺼짐",
  unsupported: "이 브라우저는 푸시 알림을 지원하지 않습니다.",
};

export function NotifyPrefsCard({ name }: { name?: string }) {
  const { call } = useApi();
  const { isAdmin } = useAuth();
  const { state, message, enable } = usePushSubscription();

  const [categories, setCategories] = useState<Record<NotifyCategory, string> | null>(null);
  const [prefs, setPrefs] = useState<Record<NotifyCategory, boolean> | null>(null);
  const [pendingCategory, setPendingCategory] = useState<NotifyCategory | null>(null);
  const [testingCategory, setTestingCategory] = useState<NotifyCategory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ text: string; type: "error" | "ok" } | null>(null);

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
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

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
    if (!name) return;
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
                <span
                  className={cn(
                    "inline-flex items-center gap-1 text-micro-lg text-muted-foreground before:content-['└'] sm:text-xs"
                  )}
                >
                  {isAdmin && (
                    <button
                      type="button"
                      className="inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/70 outline-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 sm:size-4.5"
                      disabled={!name || testingCategory === key}
                      onClick={() => sendTestToSelf(key)}
                      aria-label={`${categories[key]} 테스트 발송`}
                    >
                      <Send className="size-3 sm:size-3.5" strokeWidth={ICON_STROKE.default} />
                    </button>
                  )}
                  {categories[key]}
                </span>
                <Switch
                  checked={prefs[key]}
                  disabled={pendingCategory === key}
                  onCheckedChange={(checked) => toggleCategory(key, checked)}
                  aria-label={categories[key]}
                />
              </div>
            ))}
          </div>
        )}
      </InfoCard>

      {(message || error || testResult) && (
        <Alert
          variant={error || testResult?.type === "error" ? "destructive" : message?.type === "error" ? "destructive" : "default"}
        >
          <AlertDescription>{error || testResult?.text || message?.text}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
