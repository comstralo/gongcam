import { useRef } from "react";
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
  const view = normalizeView(params.get("view"));
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

  return (
    <div className="flex w-full page-content flex-col items-center gap-4">
      <Tabs
        value={view}
        onValueChange={(v) => {
          const next = normalizeView(v);
          const nextParams: Record<string, string> = {};
          if (next === "all") nextParams.view = "all";
          if (cycleFileId) nextParams.cycle = cycleFileId;
          setParams(nextParams, { replace: true });
        }}
        className="w-full"
      >
        <TabsList className="w-full">
          <TabsTrigger value="me" className="flex-1 font-mono text-xs tracking-wide uppercase">
            My
          </TabsTrigger>
          <TabsTrigger value="all" className="flex-1 font-mono text-xs tracking-wide uppercase">
            All
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
