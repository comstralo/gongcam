import { useSearchParams } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusPage } from "@/pages/StatusPage";
import { RosterPage } from "@/pages/RosterPage";
import { SnapshotPage } from "@/pages/SnapshotPage";

type DashboardView = "me" | "all" | "history";

function normalizeView(raw: string | null): DashboardView {
  if (raw === "all" || raw === "history") return raw;
  return "me";
}

export function DashboardPage() {
  const [params, setParams] = useSearchParams();
  const view = normalizeView(params.get("view"));

  return (
    <div className="flex w-full page-content flex-col items-center gap-4">
      <Tabs
        value={view}
        onValueChange={(v) => {
          const next = normalizeView(v);
          setParams(next === "me" ? {} : { view: next }, { replace: true });
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
          <TabsTrigger value="history" className="flex-1 font-mono text-xs tracking-wide uppercase">
            History
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {view === "me" && <StatusPage />}
      {view === "all" && <RosterPage />}
      {view === "history" && <SnapshotPage />}
    </div>
  );
}
