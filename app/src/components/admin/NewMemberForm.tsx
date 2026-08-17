import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useApi } from "@/hooks/useApi";
import { ApiError, WORKER_BASE } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/useAuth";
import type {
  AdminOpenSlotsResponse,
  CreateMemberResponse,
  GrantMemberAccessResponse,
} from "@/lib/api/types";

const GOAL_HOURS = ["8", "9", "10"];
const GOAL_KINDS = ["교시제", "달성제"];

export function NewMemberForm() {
  const { call } = useApi();
  const { session } = useAuth();

  const [slots, setSlots] = useState<string[] | null>(null);
  const [slotsError, setSlotsError] = useState<string | null>(null);

  const [number, setNumber] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [goalHours, setGoalHours] = useState("8");
  const [goalKind, setGoalKind] = useState("교시제");
  const [examKind, setExamKind] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "error" | "ok" } | null>(null);
  // Drive 권한 부여만 실패한 경우, 폼을 다시 채우지 않고 이 이메일로만
  // 재연동 후 권한 재시도를 할 수 있도록 남겨둔다.
  const [pendingAccessEmail, setPendingAccessEmail] = useState<string | null>(null);
  const [grantingAccess, setGrantingAccess] = useState(false);

  function loadSlots() {
    setSlotsError(null);
    call<AdminOpenSlotsResponse>("/admin/open-slots")
      .then((data) => setSlots(data.slots || []))
      .catch((err) => setSlotsError(err instanceof Error ? err.message : "빈 자리를 불러오지 못했습니다."));
  }

  useEffect(loadSlots, []); // eslint-disable-line react-hooks/exhaustive-deps

  function resetForm() {
    setNumber("");
    setName("");
    setEmail("");
    setGoalHours("8");
    setGoalKind("교시제");
    setExamKind("");
  }

  function openDriveAuthLink() {
    const url = `${WORKER_BASE}/oauth/authorize?token=${encodeURIComponent(session?.token || "")}`;
    window.open(url, "_blank", "noreferrer");
  }

  async function handleSubmit() {
    if (!number || !name.trim() || !email.trim()) {
      setMessage({ text: "시트번호, 이름, 이메일은 필수입니다.", type: "error" });
      return;
    }
    setSubmitting(true);
    setMessage(null);
    setPendingAccessEmail(null);
    try {
      const data = await call<CreateMemberResponse>("/admin/members", {
        method: "POST",
        body: {
          number,
          name: name.trim(),
          email: email.trim(),
          goalHours,
          goalKind,
          examKind: examKind.trim(),
        },
      });

      if (data.needsReauth) {
        setPendingAccessEmail(data.email);
        setMessage({
          text: `${data.name}님(${data.number}번)의 시트 값은 등록되었지만, Drive 편집자 권한 부여에 실패했습니다. 연동 후 아래 버튼으로 권한만 다시 부여해주세요.`,
          type: "error",
        });
        openDriveAuthLink();
      } else {
        setMessage({ text: `${data.name}님(${data.number}번)이 등록되었습니다.`, type: "ok" });
      }
      resetForm();
      loadSlots();
    } catch (err) {
      const text = err instanceof ApiError ? err.message : "네트워크 오류입니다.";
      setMessage({ text, type: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRetryGrantAccess() {
    if (!pendingAccessEmail) return;
    setGrantingAccess(true);
    try {
      await call<GrantMemberAccessResponse>("/admin/members/grant-access", {
        method: "POST",
        body: { email: pendingAccessEmail },
      });
      setMessage({ text: `${pendingAccessEmail}에 Drive 편집자 권한을 부여했습니다.`, type: "ok" });
      setPendingAccessEmail(null);
    } catch (err) {
      const text = err instanceof ApiError ? err.message : "네트워크 오류입니다.";
      setMessage({ text, type: "error" });
    } finally {
      setGrantingAccess(false);
    }
  }

  const noSlots = slots?.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label className="text-sm font-semibold sm:text-base">시트번호</Label>
        <Select value={number} onValueChange={(v) => setNumber(v ?? "")} disabled={!slots || noSlots}>
          <SelectTrigger className="sm:h-12 sm:text-base">
            <SelectValue placeholder={noSlots ? "배정 가능한 자리가 없습니다" : "빈 자리를 선택하세요"} />
          </SelectTrigger>
          <SelectContent>
            {slots?.map((s) => (
              <SelectItem key={s} value={s} className="sm:text-base">
                {s}번
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {slotsError && (
          <Alert variant="destructive">
            <AlertDescription>{slotsError}</AlertDescription>
          </Alert>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-member-name" className="text-sm font-semibold sm:text-base">
          이름
        </Label>
        <Input
          id="new-member-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="예: 길동"
          className="sm:h-12 sm:text-base"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-member-email" className="text-sm font-semibold sm:text-base">
          구글 이메일
        </Label>
        <Input
          id="new-member-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="example@gmail.com"
          className="sm:h-12 sm:text-base"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label className="text-sm font-semibold sm:text-base">의무시간</Label>
          <Select value={goalHours} onValueChange={(v) => setGoalHours(v ?? "8")}>
            <SelectTrigger className="sm:h-12 sm:text-base">
              <SelectValue>{goalHours}시간</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {GOAL_HOURS.map((h) => (
                <SelectItem key={h} value={h} className="sm:text-base">
                  {h}시간
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-sm font-semibold sm:text-base">타입</Label>
          <Select value={goalKind} onValueChange={(v) => setGoalKind(v ?? "교시제")}>
            <SelectTrigger className="sm:h-12 sm:text-base">
              <SelectValue>{goalKind}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {GOAL_KINDS.map((k) => (
                <SelectItem key={k} value={k} className="sm:text-base">
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-member-exam" className="text-sm font-semibold sm:text-base">
          준비 시험 (선택)
        </Label>
        <Input
          id="new-member-exam"
          value={examKind}
          onChange={(e) => setExamKind(e.target.value)}
          placeholder="예: 공시, CPA"
          className="sm:h-12 sm:text-base"
        />
      </div>

      <Button className="w-full sm:h-12 sm:text-base" disabled={submitting || noSlots} onClick={handleSubmit}>
        신규 스터디원 등록
      </Button>

      {message && (
        <Alert variant={message.type === "error" ? "destructive" : "default"}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}

      {pendingAccessEmail && (
        <Button
          variant="outline"
          className="w-full sm:h-12 sm:text-base"
          disabled={grantingAccess}
          onClick={handleRetryGrantAccess}
        >
          {pendingAccessEmail} 권한 다시 부여하기
        </Button>
      )}
    </div>
  );
}
