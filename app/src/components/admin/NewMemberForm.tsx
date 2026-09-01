import { useEffect, useState } from "react";
import { User, Mail, Video, Hash, ListChecks, GraduationCap, CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useApi } from "@/hooks/useApi";
import { ApiError, WORKER_BASE } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/useAuth";
import { ICON_STROKE } from "@/lib/utils";
import type {
  AdminOpenSlotsResponse,
  CreateMemberResponse,
  GrantMemberAccessResponse,
} from "@/lib/api/types";

const GOAL_HOURS = ["8", "9", "10"];
const GOAL_KINDS = ["교시제", "달성제"];

// KST 기준 "오늘"의 "YYYY-MM-DD" — en-CA 로케일은 이 형식을 직접 만들어준다.
// 브라우저 로컬 타임존이 임의값일 수 있어 반드시 timeZone을 명시해야 한다
// (백엔드의 todayKSTDateString()과 동일한 값을 내야 첫 참여일 범위 검증이
// 서버 재검증과 어긋나지 않는다).
function todayKSTStr(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}

// "YYYY-MM-DD"에 일수를 더한다(음수 가능). 순수 날짜 연산이라 UTC 자정
// 기준으로 계산해도 타임존 이슈가 없다.
function addDaysToDateStr(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

// "8시간 교시제"(표시용) <-> goalHours="8"/goalKind="교시제"(내부 상태) 조합.
// 시트에 반영할 때는 handleSubmit에서 "8H (교시제)" 형태로 다시 변환한다.
// 표시 순서: 교시제 8/9/10 -> 달성제 8/9/10
const PARTICIPATION_TYPES = GOAL_KINDS.flatMap((kind) =>
  GOAL_HOURS.map((hours) => ({ value: `${hours}|${kind}`, hours, kind, label: `${hours}시간 ${kind}` }))
);

export function NewMemberForm() {
  const { call } = useApi();
  const { session } = useAuth();

  const [slots, setSlots] = useState<string[] | null>(null);
  const [slotsError, setSlotsError] = useState<string | null>(null);

  const [number, setNumber] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [gooroomeeAccount, setGooroomeeAccount] = useState("");
  const [participationType, setParticipationType] = useState("8|교시제");
  const [examKind, setExamKind] = useState("");
  // 정식 등록 전에 이미 참여를 시작한 회원의 실제 첫 참여일(시트 I2, "가입일")을
  // 오늘로 고정하지 않고 최근 일주일 이내에서 고를 수 있게 한다 — D+N/"30일
  // 미만 참여자" 판정이 실제 시작일 기준으로 정확히 맞아떨어져야 하기 때문.
  const [joinDate, setJoinDate] = useState(todayKSTStr());

  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "error" | "ok" } | null>(null);
  // Drive 권한 부여만 실패한 경우, 폼을 다시 채우지 않고 이 이메일로만
  // 재연동 후 권한 재시도를 할 수 있도록 남겨둔다.
  const [pendingAccessEmail, setPendingAccessEmail] = useState<string | null>(null);
  const [grantingAccess, setGrantingAccess] = useState(false);

  function loadSlots() {
    setSlotsError(null);
    call<AdminOpenSlotsResponse>("/admin/open-slots")
      .then((data) => {
        const list = data.slots || [];
        setSlots(list);
        setNumber(list[0] || "");
      })
      .catch((err) => setSlotsError(err instanceof Error ? err.message : "빈 자리를 불러오지 못했습니다."));
  }

  useEffect(loadSlots, []); // eslint-disable-line react-hooks/exhaustive-deps

  function resetForm() {
    setName("");
    setEmail("");
    setGooroomeeAccount("");
    setParticipationType("8|교시제");
    setExamKind("");
    setJoinDate(todayKSTStr());
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
    // 시트 D열에 "구글계정,구루미계정" 형태로 콤마 구분해 함께 저장하므로,
    // 어느 쪽 값에도 콤마가 섞이면 파싱이 깨진다(백엔드와 동일 규칙).
    if (email.includes(",") || gooroomeeAccount.includes(",")) {
      setMessage({ text: "이메일/구루미 계정에는 쉼표를 포함할 수 없습니다.", type: "error" });
      return;
    }
    const [goalHours, goalKind] = participationType.split("|");
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
          gooroomeeAccount: gooroomeeAccount.trim(),
          goalHours,
          goalKind,
          examKind: examKind.trim(),
          joinDate,
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
  const selectedType = PARTICIPATION_TYPES.find((t) => t.value === participationType);
  const allFieldsFilled =
    !!number && !!name.trim() && !!email.trim() && !!gooroomeeAccount.trim() && !!examKind.trim() && !!joinDate;

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:gap-3.5 sm:p-5">
      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor="new-member-name"
            className="inline-flex items-center gap-1.25 text-xs font-medium text-muted-foreground sm:text-sm"
          >
            <User className="size-3 shrink-0 sm:size-3.5" strokeWidth={ICON_STROKE.default} />
            이름
          </Label>
          <Input
            id="new-member-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: 길동"
            className="sm:h-12 sm:text-base md:text-base"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="inline-flex items-center gap-1.25 text-xs font-medium text-muted-foreground sm:text-sm">
            <ListChecks className="size-3 shrink-0 sm:size-3.5" strokeWidth={ICON_STROKE.default} />
            참여유형
          </Label>
          <Select value={participationType} onValueChange={(v) => setParticipationType(v ?? "8|교시제")}>
            <SelectTrigger className="w-full py-1 text-base data-[size=default]:h-8 sm:data-[size=default]:h-12 md:text-base">
              <SelectValue>{selectedType?.label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PARTICIPATION_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value} className="sm:text-base">
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="inline-flex items-center gap-1.25 text-xs font-medium text-muted-foreground sm:text-sm">
            <Hash className="size-3 shrink-0 sm:size-3.5" strokeWidth={ICON_STROKE.default} />
            시트번호
          </Label>
          <Select value={number} onValueChange={(v) => setNumber(v ?? "")} disabled={!slots || noSlots}>
            <SelectTrigger className="w-full py-1 text-base data-[size=default]:h-8 sm:data-[size=default]:h-12 md:text-base">
              <SelectValue placeholder={noSlots ? "빈 자리 없음" : "선택"}>
                {number ? `${number}번` : undefined}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {slots?.map((s) => (
                <SelectItem key={s} value={s} className="sm:text-base">
                  {s}번
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {slotsError && (
        <Alert variant="destructive">
          <AlertDescription>{slotsError}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor="new-member-email"
            className="inline-flex items-center gap-1.25 text-xs font-medium text-muted-foreground sm:text-sm"
          >
            <Mail className="size-3 shrink-0 sm:size-3.5" strokeWidth={ICON_STROKE.default} />
            구글 계정
          </Label>
          <Input
            id="new-member-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="example@gmail.com"
            className="sm:h-12 sm:text-base md:text-base"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor="new-member-gooroomee"
            className="inline-flex items-center gap-1.25 text-xs font-medium text-muted-foreground sm:text-sm"
          >
            <Video className="size-3 shrink-0 sm:size-3.5" strokeWidth={ICON_STROKE.default} />
            구루미 계정
          </Label>
          <Input
            id="new-member-gooroomee"
            type="email"
            value={gooroomeeAccount}
            onChange={(e) => setGooroomeeAccount(e.target.value)}
            placeholder="example@gmail.com"
            className="sm:h-12 sm:text-base md:text-base"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor="new-member-exam"
            className="inline-flex items-center gap-1.25 text-xs font-medium text-muted-foreground sm:text-sm"
          >
            <GraduationCap className="size-3 shrink-0 sm:size-3.5" strokeWidth={ICON_STROKE.default} />
            준비 중인 시험
          </Label>
          <Input
            id="new-member-exam"
            value={examKind}
            onChange={(e) => setExamKind(e.target.value)}
            placeholder="예: 공시, CPA"
            className="sm:h-12 sm:text-base md:text-base"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor="new-member-join-date"
            className="inline-flex items-center gap-1.25 text-xs font-medium text-muted-foreground sm:text-sm"
          >
            <CalendarDays className="size-3 shrink-0 sm:size-3.5" strokeWidth={ICON_STROKE.default} />
            첫 참여일 설정
          </Label>
          <Input
            id="new-member-join-date"
            type="date"
            value={joinDate}
            min={addDaysToDateStr(todayKSTStr(), -6)}
            max={todayKSTStr()}
            onChange={(e) => setJoinDate(e.target.value)}
            className="sm:h-12 sm:text-base md:text-base"
          />
        </div>
      </div>

      <Button
        className="w-full sm:h-12 sm:text-base"
        disabled={submitting || noSlots || !allFieldsFilled}
        onClick={handleSubmit}
      >
        등록하기
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
