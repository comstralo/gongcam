import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SectionCard } from "@/components/admin/shared";
import { ReportReviewList } from "@/components/admin/ReportReviewList";
import { AdminMemberPenaltyTab } from "@/components/admin/AdminMemberPenaltyTab";
import { AdminMoneyTab } from "@/components/admin/AdminMoneyTab";
import { AdminBotSheetTab } from "@/components/admin/AdminBotSheetTab";
import { useAuth } from "@/lib/auth/useAuth";

type AdminView = "account" | "money" | "botsheet";

// "member"/"penalty"였던 값도(기존 북마크/링크 호환) account(통합 뷰)로 흡수한다.
function normalizeView(raw: string | null): AdminView {
  if (raw === "money" || raw === "botsheet") return raw;
  return "account";
}

export function AdminPage({ visible = true }: { visible?: boolean }) {
  const { isAdmin, isCoReviewer } = useAuth();
  const [params, setParams] = useSearchParams();
  // 🔧 [탭 리셋 버그 수정] AdminPage는 이제 최상위 라우팅에서도 언마운트되지
  // 않고 hidden으로만 유지된다(App.tsx) — 그런데 view를 매 렌더 URL 쿼리에서
  // 다시 계산하면, 하단 탭바로 다른 페이지에 갔다가 "관리자"를 다시 눌러
  // 쿼리 없는 "/admin" 경로로 돌아올 때마다 마지막에 보던 탭(Money 등)이
  // 조용히 기본값(account)으로 리셋됐다. 최초 마운트 시 한 번만 URL에서
  // 초기값을 읽고, 그 뒤로는 로컬 state로만 관리한다(북마크/공유를 위해
  // URL에는 계속 반영하되, 되읽지는 않는다).
  const [view, setView] = useState<AdminView>(() => normalizeView(params.get("tab")));

  // 한 번이라도 열린 탭은 계속 마운트 상태로 남겨(hidden으로만 감춤) 탭을
  // 오갈 때마다 다시 로드되지 않게 한다. 리렌더를 유발할 필요가 없는
  // "지금까지 열린 적 있는지" 플래그라 ref로 충분하다.
  const everOpened = useRef({ account: false, money: false, botsheet: false });
  everOpened.current[view] = true;

  function changeView(v: string) {
    const next = normalizeView(v);
    setView(next);
    setParams(next === "account" ? {} : { tab: next }, { replace: true });
  }

  // 🔧 2026-09: 부스터디장(공동 검토자)은 주 관리자가 아니므로(isAdmin===false)
  // Account/PEN·Money 나머지 섹션/Bot·Sheet에는 접근시키지 않는다 — 탭
  // 구조 자체를 건너뛰고 "송출 P 대상 처리"만 보여준다(사용자 지시). 훅
  // 순서를 지키기 위해 이 분기는 위 useState/useRef 다음, JSX 반환
  // 직전에 둔다.
  if (!isAdmin && isCoReviewer) {
    return (
      <div className="flex w-full page-content flex-col items-center gap-4">
        <SectionCard>
          <ReportReviewList visible={visible} />
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="flex w-full page-content flex-col items-center gap-4">
      <Tabs value={view} onValueChange={changeView} className="w-full">
        <TabsList className="w-full">
          <TabsTrigger value="account" className="flex-1 font-mono text-xs tracking-wide uppercase">
            Account
          </TabsTrigger>
          <TabsTrigger value="money" className="flex-1 font-mono text-xs tracking-wide uppercase">
            PEN · Money
          </TabsTrigger>
          <TabsTrigger value="botsheet" className="flex-1 font-mono text-xs tracking-wide uppercase">
            Bot · Sheet
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* 🔧 2026-09: 이 화면을 감싸던 바깥 Card/CardContent를 제거했다
          (사용자 지시) — 안쪽 각 탭(AdminMemberPenaltyTab/AdminMoneyTab/
          AdminBotSheetTab)이 이미 SectionCard 단위로 구성돼 있어, 바깥
          Card는 이중 테두리·이중 배경만 만들 뿐이었다. RosterPage/
          StatusPage/SettingsPage에서 같은 이유로 이미 제거한 것과 동일한
          처리.

          조건부 렌더링(view === "x" && ...) 대신 hidden으로 감춘다 — 한 번
          마운트된 탭은 언마운트하지 않고 그대로 유지해, 관리자가 탭을
          오갈 때마다 각 탭의 useEffect(load, [])가 매번 다시 실행되며
          Sheets API를 재호출하는 문제를 없앤다(2026-08 실제로 탭 전환
          몇 번만으로 429 RESOURCE_EXHAUSTED 재현됨). 아직 한 번도
          열지 않은 탭은 그대로 마운트를 미뤄 불필요한 초기 로드를
          피한다. */}
      <div className="flex w-full flex-col gap-4">
        <div hidden={view !== "account"}>
          {everOpened.current.account && <AdminMemberPenaltyTab visible={visible && view === "account"} />}
        </div>
        <div hidden={view !== "money"}>
          {everOpened.current.money && <AdminMoneyTab visible={visible && view === "money"} />}
        </div>
        <div hidden={view !== "botsheet"}>
          {everOpened.current.botsheet && <AdminBotSheetTab visible={visible && view === "botsheet"} />}
        </div>
      </div>
    </div>
  );
}
