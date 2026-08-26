import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { SectionCard } from "@/components/admin/shared";
import { SubRow } from "@/components/dashboard/shared";
import { useApi } from "@/hooks/useApi";
import type { RecentNoticeItem, RecentNoticesResponse } from "@/lib/api/types";

const NOTICE_POLL_MS = 15000;
const TICK_MS = 1000;

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return "방금 전";
  const min = Math.floor(totalSec / 60);
  return `${min}분 전`;
}

// 최근 10분 내 전송된 알림 이력을 모두가 볼 수 있게 보여준다 — 같은 대상에게
// 중복으로 알림을 보내지 않도록(백엔드도 10분 쿨다운으로 막지만, 보내기
// 전에 미리 확인시켜 헛수고를 줄이는 목적) "최근 진행된 제보"와 동일한 패턴.
// refreshSignal: 본인이 방금 알림을 보냈을 때 다음 폴링을 기다리지 않고
// 즉시 목록에 반영하기 위해 부모(SimpleNoticeSection)가 넘긴다.
export function RecentNoticesSection({ refreshSignal }: { refreshSignal?: number }) {
  const { call } = useApi();
  const [items, setItems] = useState<RecentNoticeItem[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    function load() {
      call<RecentNoticesResponse>("/push/recent-notices")
        .then((data) => {
          if (!cancelled) setItems(data.items || []);
        })
        .catch(() => {});
    }
    load();
    const pollTimer = setInterval(load, NOTICE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(pollTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, refreshSignal]);

  useEffect(() => {
    const tickTimer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(tickTimer);
  }, []);

  return (
    <SectionCard className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.25 text-xs font-semibold text-muted-foreground sm:text-sm">
        <History className="size-3 shrink-0 sm:size-3.5" />
        최근 전송된 알림
      </span>
      {items.length === 0 ? (
        <SubRow label="최근 전송된 알림이 없습니다." value="" />
      ) : (
        <div className="flex flex-col gap-1">
          {items.map((item, i) => (
            <SubRow
              key={`${item.nickname}-${item.ts}-${i}`}
              label={`${item.nickname} · ${item.message}`}
              value={formatElapsed(now - item.ts)}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}
