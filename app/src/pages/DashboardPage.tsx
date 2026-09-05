import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusPage } from "@/pages/StatusPage";
import { RosterPage } from "@/pages/RosterPage";

type DashboardView = "me" | "all";

function normalizeView(raw: string | null): DashboardView {
  if (raw === "all") return raw;
  return "me";
}

export function DashboardPage({ visible = true }: { visible?: boolean }) {
  const [params, setParams] = useSearchParams();
  // 🔧 [탭 리셋 버그 수정] AdminPage와 같은 이유 — DashboardPage도 이제
  // 최상위 라우팅에서 언마운트되지 않고 hidden으로만 유지된다(App.tsx).
  // view를 매 렌더 URL 쿼리에서 다시 계산하면, 하단 탭바로 다른 페이지에
  // 갔다가 "대시보드"를 다시 눌러 쿼리 없는 "/" 경로로 돌아올 때마다
  // "전체" 탭을 보고 있었어도 조용히 "My" 탭으로 리셋됐다. 최초 마운트
  // 시 한 번만 URL에서 초기값을 읽고, 그 뒤로는 로컬 state로만 관리한다.
  const [view, setView] = useState<DashboardView>(() => normalizeView(params.get("view")));
  const cycleFileId = params.get("cycle");

  // AdminPage와 동일한 이유 — 탭을 오갈 때마다 언마운트/재마운트되며 각
  // 탭의 조회가 다시 실행되지 않도록, 한 번 연 탭은 hidden으로만 감춘다.
  const everOpened = useRef({ me: false, all: false });
  everOpened.current[view] = true;

  function selectCycle(fileId: string | null) {
    const next: Record<string, string> = {};
    if (view === "all") next.view = "all";
    if (fileId) next.cycle = fileId;
    setParams(next, { replace: true });
  }

  function changeView(v: string) {
    const next = normalizeView(v);
    setView(next);
    const nextParams: Record<string, string> = {};
    if (next === "all") nextParams.view = "all";
    if (cycleFileId) nextParams.cycle = cycleFileId;
    setParams(nextParams, { replace: true });
  }

  return (
    <div className="flex w-full page-content flex-col items-center gap-4">
      <Tabs value={view} onValueChange={changeView} className="w-full">
        <TabsList className="w-full">
          <TabsTrigger value="me" className="flex-1 font-mono text-xs tracking-wide uppercase">
            My
          </TabsTrigger>
          <TabsTrigger value="all" className="flex-1 font-mono text-xs tracking-wide uppercase">
            RANK
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="w-full" hidden={view !== "me"}>
        {everOpened.current.me && (
          <StatusPage cycleFileId={cycleFileId} onSelectCycle={selectCycle} visible={visible && view === "me"} />
        )}
      </div>
      <div className="w-full" hidden={view !== "all"}>
        {everOpened.current.all && (
          <RosterPage cycleFileId={cycleFileId} onSelectCycle={selectCycle} visible={visible && view === "all"} />
        )}
      </div>
    </div>
  );
}
