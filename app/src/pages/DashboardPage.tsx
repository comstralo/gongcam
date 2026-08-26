import { useSearchParams } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusPage } from "@/pages/StatusPage";
import { RosterPage } from "@/pages/RosterPage";

type DashboardView = "me" | "all";

function normalizeView(raw: string | null): DashboardView {
  if (raw === "all") return raw;
  return "me";
}

export function DashboardPage() {
  const [params, setParams] = useSearchParams();
  const view = normalizeView(params.get("view"));
  const cycleFileId = params.get("cycle");

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

      {view === "me" && <StatusPage cycleFileId={cycleFileId} onSelectCycle={selectCycle} />}
      {view === "all" && <RosterPage cycleFileId={cycleFileId} onSelectCycle={selectCycle} />}
    </div>
  );
}
