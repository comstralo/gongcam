import { useSearchParams } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusPage } from "@/pages/StatusPage";
import { RosterPage } from "@/pages/RosterPage";

type DashboardView = "me" | "all";

export function DashboardPage() {
  const [params, setParams] = useSearchParams();
  const view: DashboardView = params.get("view") === "all" ? "all" : "me";

  return (
    <div className="flex w-full page-content flex-col items-center gap-4">
      <Tabs
        value={view}
        onValueChange={(v) => {
          const next = v === "all" ? "all" : "me";
          setParams(next === "me" ? {} : { view: next }, { replace: true });
        }}
        className="w-full"
      >
        <TabsList className="w-full">
          <TabsTrigger value="me" className="flex-1">
            내 대시보드
          </TabsTrigger>
          <TabsTrigger value="all" className="flex-1">
            전체 대시보드
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {view === "me" ? <StatusPage /> : <RosterPage />}
    </div>
  );
}
