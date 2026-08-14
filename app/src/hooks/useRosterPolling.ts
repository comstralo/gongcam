import { useEffect, useRef, useState } from "react";
import { useApi } from "./useApi";
import type { ParticipantsResponse } from "@/lib/api/types";

const ROSTER_POLL_MS = 15000;

export function useRosterPolling() {
  const { call } = useApi();
  const [members, setMembers] = useState<string[]>([]);
  const [stale, setStale] = useState(false);
  const [hint, setHint] = useState("실시간 접속 명단을 불러오는 중...");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function load() {
    try {
      const data = await call<ParticipantsResponse>("/participants");
      setMembers(data.members || []);
      setStale(data.stale);
      setHint(
        data.stale
          ? "명단이 최신이 아닐 수 있습니다 (봇 연결 확인 중) · ⟲로 다시 시도"
          : "실시간 구루미 접속 명단입니다"
      );
    } catch (err) {
      setHint(err instanceof Error ? err.message : "명단을 불러오지 못했습니다.");
    }
  }

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, ROSTER_POLL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { members, stale, hint, refresh: load };
}
