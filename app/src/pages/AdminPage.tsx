import { useSearchParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AdminMemberTab } from "@/components/admin/AdminMemberTab";
import { AdminMoneyTab } from "@/components/admin/AdminMoneyTab";
import { AdminPenaltyTab } from "@/components/admin/AdminPenaltyTab";

type AdminView = "member" | "money" | "penalty";

function normalizeView(raw: string | null): AdminView {
  if (raw === "money" || raw === "penalty") return raw;
  return "member";
}

export function AdminPage() {
  const [params, setParams] = useSearchParams();
  const view = normalizeView(params.get("tab"));

  return (
    <Card className="w-full page-content">
      <CardContent className="flex flex-col gap-4">
        <Tabs
          value={view}
          onValueChange={(v) => {
            const next = normalizeView(v);
            setParams(next === "member" ? {} : { tab: next }, { replace: true });
          }}
          className="w-full"
        >
          <TabsList className="w-full">
            <TabsTrigger value="member" className="flex-1 font-mono text-xs tracking-wide uppercase">
              Member
            </TabsTrigger>
            <TabsTrigger value="money" className="flex-1 font-mono text-xs tracking-wide uppercase">
              Money
            </TabsTrigger>
            <TabsTrigger value="penalty" className="flex-1 font-mono text-xs tracking-wide uppercase">
              Penalty
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {view === "member" && <AdminMemberTab />}
        {view === "money" && <AdminMoneyTab />}
        {view === "penalty" && <AdminPenaltyTab />}
      </CardContent>
    </Card>
  );
}
