import { useEffect, useState } from "react";
import { MessageSquareText, Pencil, Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { InfoCard } from "@/components/dashboard/shared";
import { useApi } from "@/hooks/useApi";
import { ICON_STROKE } from "@/lib/utils";
import type { StatusMessageResponse, SetStatusMessageResponse } from "@/lib/api/types";

const STATUS_MESSAGE_MAX_LENGTH = 60;

// "상태 메시지" — 전자기기 사용 목적이 모호해 보여 오해로 제보가 들어오는
// 경우를 줄이려고, 본인이 미리 사용 목적을 적어두는 자유 텍스트(사용자
// 요청, 예: "태블릿 : AI 질의용도"). [제보] 대상자 선택 시 이 값이 노출된다.
export function StatusMessageCard() {
  const { call } = useApi();
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call<StatusMessageResponse>("/status-message")
      .then((data) => setMessage(data.message || ""))
      .catch((err) => setError(err instanceof Error ? err.message : "상태 메시지를 불러오지 못했습니다."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startEdit() {
    setDraft(message || "");
    setEditing(true);
    setError(null);
  }

  function cancelEdit() {
    setEditing(false);
    setDraft("");
  }

  function save() {
    setSaving(true);
    setError(null);
    call<SetStatusMessageResponse>("/status-message", { method: "POST", body: { message: draft.trim() } })
      .then((data) => {
        setMessage(data.message);
        setEditing(false);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "상태 메시지 저장에 실패했습니다."))
      .finally(() => setSaving(false));
  }

  return (
    <div className="flex flex-col gap-2.5">
      {/* 🔧 [사용자 지시] "텍스트 위계도 '제보' 화면 참고해서 조정" — 제목이
          다른 설정 카드(ItemTitle 등)보다 한 단계 작았다 — 통일한다. */}
      <InfoCard className="flex flex-col gap-2.5 bg-card">
        {/* 🔧 [사용자 지시] "'제보 대상자 선택 시 다른 참여자에게 표시됩니다.'
            이거랑 좌측의 구분자 제거해" — 설명 문구와 DividedValue 구분자를
            없애고 제목만 남긴다. */}
        <span className="inline-flex items-center gap-1.25 text-sm font-semibold sm:text-base">
          <MessageSquareText className="size-3.5 shrink-0 text-muted-foreground sm:size-4" strokeWidth={ICON_STROKE.default} />
          상태 메시지
        </span>

        {editing ? (
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={draft}
              maxLength={STATUS_MESSAGE_MAX_LENGTH}
              placeholder="예: 태블릿 : AI 질의용도"
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") cancelEdit();
              }}
              className="flex-1 sm:h-11 sm:text-base"
            />
            <Button variant="outline" size="icon" disabled={saving} onClick={save} aria-label="저장">
              <Check className="size-4" strokeWidth={ICON_STROKE.default} />
            </Button>
            <Button variant="outline" size="icon" disabled={saving} onClick={cancelEdit} aria-label="취소">
              <X className="size-4" strokeWidth={ICON_STROKE.default} />
            </Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={startEdit}
            className="flex items-center justify-between gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {message === null ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <span className={message ? "truncate text-sm" : "truncate text-sm text-muted-foreground"}>
                {message || "설정된 상태 메시지가 없습니다."}
              </span>
            )}
            <Pencil className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={ICON_STROKE.default} />
          </button>
        )}
      </InfoCard>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
