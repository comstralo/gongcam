import { useRef } from "react";
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

  // 한 번이라도 열린 탭은 계속 마운트 상태로 남겨(hidden으로만 감춤) 탭을
  // 오갈 때마다 다시 로드되지 않게 한다. 리렌더를 유발할 필요가 없는
  // "지금까지 열린 적 있는지" 플래그라 ref로 충분하다.
  const everOpened = useRef({ member: false, money: false, botsheet: false });
  everOpened.current[view] = true;

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
          {/* 조건부 렌더링(view === "x" && ...) 대신 hidden으로 감춘다 — 한 번
              마운트된 탭은 언마운트하지 않고 그대로 유지해, 관리자가 탭을
              오갈 때마다 각 탭의 useEffect(load, [])가 매번 다시 실행되며
              Sheets API를 재호출하는 문제를 없앤다(2026-08 실제로 탭 전환
              몇 번만으로 429 RESOURCE_EXHAUSTED 재현됨). 아직 한 번도
              열지 않은 탭은 그대로 마운트를 미뤄 불필요한 초기 로드를
              피한다. */}
          <div hidden={view !== "member"}>{everOpened.current.member && <AdminMemberPenaltyTab />}</div>
          <div hidden={view !== "money"}>{everOpened.current.money && <AdminMoneyTab />}</div>
          <div hidden={view !== "botsheet"}>{everOpened.current.botsheet && <AdminBotSheetTab />}</div>
        </CardContent>
      </Card>
    </div>
  );
}
