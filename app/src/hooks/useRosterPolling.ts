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
      setHint("");
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
