import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { SectionCard } from "@/components/admin/shared";
import { SubRow } from "@/components/dashboard/shared";
import { useApi } from "@/hooks/useApi";
import type { ActiveCooldownItem, ReportCooldownsResponse } from "@/lib/api/types";

const COOLDOWN_POLL_MS = 15000;
const TICK_MS = 1000;

function formatRemaining(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

// 최근 20분 내 제보가 접수돼 재제보 쿨다운이 걸린 대상을 모두가 볼 수 있게
// 보여준다 — handleReport(백엔드)가 어차피 중복 제보를 429로 막지만, 제보
// 버튼을 누르기 전에 "이미 접수됐구나"를 미리 알 수 있어야 헛수고를 줄인다.
// refreshSignal: 값이 바뀔 때마다 즉시 재조회한다 — 본인이 방금 제보를
// 제출했을 때 다음 폴링(최대 15초)을 기다리지 않고 바로 목록에 반영하기
// 위해 부모(ReportPage)가 제출 성공 시 이 값을 바꿔 넘긴다.
export function ActiveReportsSection({ refreshSignal }: { refreshSignal?: number }) {
  const { call } = useApi();
  const [items, setItems] = useState<ActiveCooldownItem[]>([]);
  const [now, setNow] = useState(() => Date.now());
  // 🔧 [조회 실패 무피드백 수정] 원래 실패를 그냥 삼켜서, 조회가 안 되는
  // 동안에도 "최근 진행된 제보가 없습니다"와 똑같이 보였다 — 실제로는
  // 쿨다운 중인 대상이 있는데도 없는 것처럼 보여, 제보를 시도했다가
  // 뒤늦게 429로 헛수고할 수 있었다. 실패 상태를 별도로 구분해 보여준다.
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    function load() {
      call<ReportCooldownsResponse>("/report-cooldowns")
        .then((data) => {
          if (cancelled) return;
          setItems(data.items || []);
          setError(false);
        })
        .catch(() => {
          if (!cancelled) setError(true);
        });
    }
    load();
    const pollTimer = setInterval(load, COOLDOWN_POLL_MS);
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

  // 폴링 사이(최대 15초) 만료된 항목은 다음 폴링까지 화면에 남을 수 있으니
  // 클라이언트에서도 즉시 걸러낸다.
  const active = items.filter((item) => item.expiresAt > now);

  return (
    <SectionCard className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.25 text-xs font-semibold text-muted-foreground sm:text-sm">
        <Clock className="size-3 shrink-0 sm:size-3.5" />
        최근 진행된 제보
      </span>
      {error ? (
        <SubRow label="목록을 불러오지 못했습니다. 잠시 후 다시 확인해주세요." value="" />
      ) : active.length === 0 ? (
        <SubRow label="최근 진행된 제보가 없습니다." value="" />
      ) : (
        <div className="flex flex-col gap-1">
          {active.map((item) => (
            <SubRow
              key={item.nickname}
              label={item.nickname}
              value={`${formatRemaining(item.expiresAt - now)} 남음`}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}
