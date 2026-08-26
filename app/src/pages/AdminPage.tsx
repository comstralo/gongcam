import { useSearchParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AdminMemberPenaltyTab } from "@/components/admin/AdminMemberPenaltyTab";
import { AdminMoneyTab } from "@/components/admin/AdminMoneyTab";
import { AdminBotSheetTab } from "@/components/admin/AdminBotSheetTab";

type AdminView = "member" | "money" | "botsheet";

// "penalty"였던 값도(기존 북마크/링크 호환) member(통합 뷰)로 흡수한다.
function normalizeView(raw: string | null): AdminView {
  if (raw === "money" || raw === "botsheet") return raw;
  return "member";
}

export function AdminPage() {
  const [params, setParams] = useSearchParams();
  const view = normalizeView(params.get("tab"));

  return (
    <div className="flex w-full page-content flex-col items-center gap-4">
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
            MEM · PEN
          </TabsTrigger>
          <TabsTrigger value="money" className="flex-1 font-mono text-xs tracking-wide uppercase">
            Money
          </TabsTrigger>
          <TabsTrigger value="botsheet" className="flex-1 font-mono text-xs tracking-wide uppercase">
            Bot · Sheet
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <Card className="w-full">
        <CardContent className="flex flex-col gap-4">
          {view === "member" && <AdminMemberPenaltyTab />}
          {view === "money" && <AdminMoneyTab />}
          {view === "botsheet" && <AdminBotSheetTab />}
        </CardContent>
      </Card>
    </div>
  );
}
