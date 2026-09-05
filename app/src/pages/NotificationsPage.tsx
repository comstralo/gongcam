import { Bell } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { InfoCard, ItemTitle } from "@/components/dashboard/shared";
import { DUMMY_NOTIFICATIONS } from "@/lib/notifications/notifications";
import { cn, ICON_STROKE } from "@/lib/utils";

// 🔧 2026-09: 기존에는 대시보드 상단 종 아이콘을 눌러야 뜨는 모달
// (NotificationDialog)이었으나, 하단 탭바에 "알림" 탭이 새로 생기며 그
// 화면으로 승격했다(사용자 지시) — 다이얼로그 래퍼만 벗겨내고 내용은
// 그대로 옮겼다.
export function NotificationsPage() {
  const unreadCount = DUMMY_NOTIFICATIONS.filter((n) => !n.read).length;

  return (
    <Card className="w-full page-content">
      <CardContent className="flex flex-col gap-2">
        {DUMMY_NOTIFICATIONS.length === 0 ? (
          <InfoCard className="flex flex-col items-center gap-1.5 bg-card py-6 text-center text-muted-foreground">
            <Bell className="size-5" strokeWidth={ICON_STROKE.default} />
            <span className="text-xs sm:text-sm">받은 알림이 없습니다.</span>
          </InfoCard>
        ) : (
          DUMMY_NOTIFICATIONS.map((n) => (
            <InfoCard
              key={n.id}
              className={cn("flex items-start gap-2.5", n.read ? "bg-card" : "border-primary/40 bg-primary/5")}
            >
              <n.icon
                className={cn("mt-0.5 size-4 shrink-0", n.read ? "text-muted-foreground" : "text-primary")}
                strokeWidth={ICON_STROKE.default}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-center justify-between gap-2">
                  <ItemTitle className="truncate">{n.title}</ItemTitle>
                  <span className="shrink-0 text-micro-lg text-muted-foreground sm:text-xs">{n.time}</span>
                </div>
                <span className="text-micro-lg text-muted-foreground sm:text-xs">{n.body}</span>
              </div>
              {!n.read && <span className="mt-1 size-2 shrink-0 rounded-full bg-primary" />}
            </InfoCard>
          ))
        )}

        {unreadCount > 0 && (
          <p className="text-center text-micro-lg text-muted-foreground sm:text-xs">
            읽지 않은 알림 {unreadCount}개
          </p>
        )}
      </CardContent>
    </Card>
  );
}
