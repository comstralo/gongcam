import { Bell, BellRing, CircleDollarSign, Megaphone, ShieldAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { InfoCard } from "@/components/dashboard/shared";
import { cn, ICON_STROKE } from "@/lib/utils";

type NotificationItem = {
  id: string;
  icon: LucideIcon;
  title: string;
  body: string;
  time: string;
  read: boolean;
};

// TODO(dev-preview): 실제 알림 API가 아직 없어 렌더링 확인용 더미 데이터를 쓴다.
// 연동 시 이 배열과 "읽음" 처리 로직을 서버 상태로 교체할 것.
const DUMMY_NOTIFICATIONS: NotificationItem[] = [
  {
    id: "1",
    icon: ShieldAlert,
    title: "송출 P 제보 반영",
    body: "화각 이탈 제보가 승인되어 송출 P가 1 추가되었습니다.",
    time: "10분 전",
    read: false,
  },
  {
    id: "2",
    icon: CircleDollarSign,
    title: "벌금 미납 안내",
    body: "화요일 벌금이 아직 납부되지 않았습니다. 확인해주세요.",
    time: "2시간 전",
    read: false,
  },
  {
    id: "3",
    icon: Megaphone,
    title: "공지사항",
    body: "이번 주 일요일은 정기 점검으로 14교시가 30분 앞당겨집니다.",
    time: "어제",
    read: true,
  },
];

export function NotificationDialog() {
  const unreadCount = DUMMY_NOTIFICATIONS.filter((n) => !n.read).length;

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            variant="outline"
            size="icon"
            className="relative size-9 shrink-0 rounded-full sm:size-10"
            aria-label="알림"
          >
            <Bell className="size-4 sm:size-4.5" strokeWidth={ICON_STROKE.default} />
            {unreadCount > 0 && (
              <span className="absolute top-0.5 right-0.5 size-2 rounded-full bg-destructive ring-2 ring-card" />
            )}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <BellRing className="size-4 text-primary sm:size-5" />
            알림
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {DUMMY_NOTIFICATIONS.length === 0 ? (
            <InfoCard className="flex flex-col items-center gap-1.5 py-6 text-center text-muted-foreground">
              <Bell className="size-5" strokeWidth={ICON_STROKE.default} />
              <span className="text-xs sm:text-sm">받은 알림이 없습니다.</span>
            </InfoCard>
          ) : (
            DUMMY_NOTIFICATIONS.map((n) => (
              <InfoCard
                key={n.id}
                className={cn(
                  "flex items-start gap-2.5",
                  !n.read && "border-primary/40 bg-primary/5"
                )}
              >
                <n.icon
                  className={cn("mt-0.5 size-4 shrink-0", n.read ? "text-muted-foreground" : "text-primary")}
                  strokeWidth={ICON_STROKE.default}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold sm:text-sm">{n.title}</span>
                    <span className="shrink-0 text-micro-lg text-muted-foreground sm:text-xs">{n.time}</span>
                  </div>
                  <span className="text-micro-lg text-muted-foreground sm:text-xs">{n.body}</span>
                </div>
                {!n.read && <span className="mt-1 size-2 shrink-0 rounded-full bg-primary" />}
              </InfoCard>
            ))
          )}
        </div>

        {unreadCount > 0 && (
          <p className="text-center text-micro-lg text-muted-foreground sm:text-xs">
            읽지 않은 알림 {unreadCount}개
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
