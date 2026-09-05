import { CircleDollarSign, Megaphone, ShieldAlert, type LucideIcon } from "lucide-react";

export type NotificationItem = {
  id: string;
  icon: LucideIcon;
  title: string;
  body: string;
  time: string;
  read: boolean;
};

// TODO(dev-preview): 실제 알림 API가 아직 없어 렌더링 확인용 더미 데이터를 쓴다.
// 연동 시 이 배열과 "읽음" 처리 로직을 서버 상태로 교체할 것. NotificationsPage와
// TabBar(안 읽은 알림 뱃지)가 같은 값을 봐야 해서 공용 위치로 뺐다.
export const DUMMY_NOTIFICATIONS: NotificationItem[] = [
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

export function useUnreadNotificationCount(): number {
  return DUMMY_NOTIFICATIONS.filter((n) => !n.read).length;
}
