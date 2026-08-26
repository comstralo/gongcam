import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DividedValue, InfoCard, SubRow } from "@/components/dashboard/shared";
import { usePushSubscription } from "@/hooks/usePushSubscription";
import { useApi } from "@/hooks/useApi";
import { ICON_STROKE } from "@/lib/utils";
import type { NotifyCategory, NotifyPrefsResponse, SetNotifyPrefsResponse } from "@/lib/api/types";

const PUSH_STATE_LABEL: Record<string, string> = {
  checking: "알림 상태 확인 중...",
  on: "알림 켜짐",
  off: "알림 꺼짐",
  unsupported: "이 브라우저는 푸시 알림을 지원하지 않습니다.",
};

export function NotifyPrefsCard() {
  const { call } = useApi();
  const { state, message, enable } = usePushSubscription();

  const [categories, setCategories] = useState<Record<NotifyCategory, string> | null>(null);
  const [prefs, setPrefs] = useState<Record<NotifyCategory, boolean> | null>(null);
  const [pendingCategory, setPendingCategory] = useState<NotifyCategory | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="flex flex-col gap-2.5">
      <InfoCard className="flex items-center justify-between gap-2.5">
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
      </InfoCard>

      {state === "on" && categories && prefs && (
        <InfoCard className="flex flex-col gap-1.5">
          {(Object.keys(categories) as NotifyCategory[]).map((key) => (
            <SubRow
              key={key}
              indent={false}
              label={categories[key]}
              value={
                <Switch
                  checked={prefs[key]}
                  disabled={pendingCategory === key}
                  onCheckedChange={(checked) => toggleCategory(key, checked)}
                  aria-label={categories[key]}
                />
              }
            />
          ))}
        </InfoCard>
      )}

      {(message || error) && (
        <Alert variant={error ? "destructive" : message?.type === "error" ? "destructive" : "default"}>
          <AlertDescription>{error || message?.text}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
