import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsiblePanel } from "@/components/ui/collapsible";
import { InfoCard } from "@/components/dashboard/shared";
import { SectionHeader } from "@/components/admin/shared";
import { usePushSubscription } from "@/hooks/usePushSubscription";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import type {
  AdminMembersRosterResponse,
  AdminPushSendCategoryResponse,
  NotifyCategory,
  NotifyPrefsResponse,
} from "@/lib/api/types";

const STATE_LABEL: Record<string, string> = {
  checking: "알림 상태 확인 중...",
  on: "알림 켜짐 · 이 브라우저는 구독 중",
  off: "알림 꺼짐 · 아직 구독하지 않음",
  unsupported: "이 브라우저는 푸시 알림을 지원하지 않습니다.",
};

// 실제 이벤트(제보 승인 등)에 연결되기 전, 회원별 종류별 on/off 설정과
// 발송 파이프라인이 의도대로 동작하는지 관리자가 수동으로 확인하는 용도.
function CategoryTestSend() {
  const { call } = useApi();
  const [members, setMembers] = useState<string[] | null>(null);
  const [categories, setCategories] = useState<Record<NotifyCategory, string> | null>(null);
  const [nickname, setNickname] = useState("");
  const [category, setCategory] = useState<NotifyCategory | "">("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ text: string; type: "error" | "ok" } | null>(null);

  useEffect(() => {
    call<AdminMembersRosterResponse>("/admin/members/roster")
      .then((data) => setMembers((data.members || []).map((m) => m.name)))
      .catch(() => setMembers([]));
    // 카테고리 목록은 회원 개인용 API를 그대로 재사용 — 관리자도 로그인 회원이므로
    // 자신의 prefs가 함께 오지만 여기서는 categories만 사용한다.
    call<NotifyPrefsResponse>("/notify-prefs")
      .then((data) => setCategories(data.categories))
      .catch(() => setCategories(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSend() {
    if (!nickname) {
      setResult({ text: "수신 대상자를 선택해주세요.", type: "error" });
      return;
    }
    if (!category) {
      setResult({ text: "알림 종류를 선택해주세요.", type: "error" });
      return;
    }
    setSending(true);
    setResult(null);
    try {
      const data = await call<AdminPushSendCategoryResponse>("/admin/push/send-category", {
        method: "POST",
        body: { nickname, category },
      });
      if (data.blocked) {
        setResult({ text: data.message || "회원이 해당 종류를 꺼두어 발송하지 않았습니다.", type: "error" });
      } else {
        setResult({ text: `${nickname}님에게 테스트 알림을 보냈습니다.`, type: "ok" });
      }
    } catch (err) {
      setResult({ text: err instanceof Error ? err.message : "네트워크 오류입니다.", type: "error" });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs font-semibold text-muted-foreground sm:text-sm">수신 대상자</Label>
        <Select value={nickname} onValueChange={(v) => setNickname(v ?? "")} disabled={!members || members.length === 0}>
          <SelectTrigger className="w-full data-[size=default]:h-8 sm:data-[size=default]:h-12 sm:text-base">
            <SelectValue placeholder={!members || members.length === 0 ? "등록된 회원이 없습니다" : "회원을 선택하세요"} />
          </SelectTrigger>
          <SelectContent>
            {(members || []).map((name) => (
              <SelectItem key={name} value={name} className="sm:text-base">
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label className="text-xs font-semibold text-muted-foreground sm:text-sm">알림 종류</Label>
        <Select value={category} onValueChange={(v) => setCategory((v as NotifyCategory) ?? "")} disabled={!categories}>
          <SelectTrigger className="w-full data-[size=default]:h-8 sm:data-[size=default]:h-12 sm:text-base">
            <SelectValue placeholder="종류를 선택하세요" />
          </SelectTrigger>
          <SelectContent>
            {categories &&
              (Object.keys(categories) as NotifyCategory[]).map((key) => (
                <SelectItem key={key} value={key} className="sm:text-base">
                  {categories[key]}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>

      <Button
        className="w-full border-primary hover:bg-primary/10 sm:h-12 sm:text-base"
        variant="outline"
        disabled={sending}
        onClick={handleSend}
      >
        {sending ? "보내는 중..." : "종류별 테스트 발송"}
      </Button>

      {result && (
        <Alert variant={result.type === "error" ? "destructive" : "default"}>
          <AlertDescription>{result.text}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

export function PushNotificationSection() {
  const { state, message, enable, sendTest } = usePushSubscription();

  return (
    <Collapsible defaultOpen className="flex flex-col gap-3">
      <SectionHeader icon={Bell} title="브라우저 푸시 알림" />
      <div className="h-px w-full bg-border" />
      <CollapsiblePanel className="flex flex-col gap-3">
        <InfoCard className="flex items-center gap-2.5 text-sm sm:text-base">
          <span
            className={cn(
              "size-2.5 shrink-0 rounded-full bg-muted-foreground",
              state === "on" && "bg-ok",
              state === "off" && "bg-destructive"
            )}
          />
          <span>{STATE_LABEL[state]}</span>
        </InfoCard>

        {state === "off" && (
          <Button className="w-full sm:h-12 sm:text-base" onClick={enable}>
            알림 켜기
          </Button>
        )}
        {state === "on" && (
          <Button className="w-full sm:h-12 sm:text-base" variant="outline" onClick={sendTest}>
            테스트 알림 보내기
          </Button>
        )}

        {message && (
          <Alert variant={message.type === "error" ? "destructive" : "default"}>
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}

        <div className="h-px w-full bg-border" />
        <CategoryTestSend />
      </CollapsiblePanel>
    </Collapsible>
  );
}
