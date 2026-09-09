import { useEffect, useState } from "react";
import { useApi } from "./useApi";
import { usePollingRefresh } from "./usePollingRefresh";
import type { ParticipantsResponse } from "@/lib/api/types";

const ROSTER_POLL_MS = 15000;

// 🔧 [사용자 지시] 이 훅이 자체 setInterval로 15초 폴링을 직접 돌리다 보니,
// "화각 불량 제보" 헤더(SectionHeader)가 참여자 명단 폴링 이외의 다른
// 화면들처럼 "다음 자동 갱신까지 남은 시간" 게이지를 보여줄 방법이 없었다
// (사용자 지적: "왜 게이지가 안 차는거지"). usePollingRefresh(다른 화면들이
// 이미 쓰는, 진행률 0~1을 반환하는 공용 폴링 훅)로 재구성해 실제 데이터
// 재조회와 게이지 표시를 하나의 타이머로 통일한다.
export function useRosterPolling() {
  const { call } = useApi();
  const [members, setMembers] = useState<string[]>([]);
  const [stale, setStale] = useState(false);
  const [hint, setHint] = useState("실시간 접속 명단을 불러오는 중...");

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 참여자 명단은 화면이 떠 있는 동안 항상 최신이어야 하므로 visible을
  // 고정 true로 넘긴다(다른 화면처럼 "다른 탭에 가려지면 멈춤" 최적화는
  // 필요 없음 — 원래도 그렇게 항상 폴링했다).
  const refreshProgress = usePollingRefresh(true, load, ROSTER_POLL_MS);

  return { members, stale, hint, refresh: load, refreshProgress };
}
