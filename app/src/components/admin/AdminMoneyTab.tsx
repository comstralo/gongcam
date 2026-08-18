import { useEffect, useState } from "react";
import { Wallet, PiggyBank, RotateCw, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { InfoCard, DayDetailCard } from "@/components/dashboard/shared";
import { useApi } from "@/hooks/useApi";
import { ApiError } from "@/lib/api/client";
import { ICON_STROKE, cn } from "@/lib/utils";
import type {
  AdminFinesUnpaidResponse,
  AdminDepositsUnpaidResponse,
  FineStatus,
  DepositStatus,
  SetFineStatusResponse,
  SetDepositStatusResponse,
  UnpaidFine,
  UnpaidDeposit,
  StatusResponse,
} from "@/lib/api/types";

const FINE_STATUS_OPTIONS: FineStatus[] = ["미납", "납부", "면제"];
const DEPOSIT_STATUS_OPTIONS: DepositStatus[] = ["미납", "납부"];
const STATUS_DAYS = ["월", "화", "수", "목", "금", "토", "일"];

function fineKey(f: Pick<UnpaidFine, "number" | "day">) {
  return `${f.number}-${f.day}`;
}

function FineList() {
  const { call } = useApi();

  const [unpaid, setUnpaid] = useState<UnpaidFine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [resolvedKeys, setResolvedKeys] = useState<Set<string>>(new Set());
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [dayDetail, setDayDetail] = useState<Record<string, StatusResponse | "loading" | "error">>({});

  function load() {
    setLoading(true);
    setError(null);
    call<AdminFinesUnpaidResponse>("/admin/fines/unpaid")
      .then((data) => {
        setUnpaid(data.unpaid || []);
        setResolvedKeys(new Set());
      })
      .catch((err) => setError(err instanceof Error ? err.message : "벌금 미납 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSetStatus(f: UnpaidFine, status: FineStatus) {
    const key = fineKey(f);
    setPendingKey(key);
    setError(null);
    try {
      await call<SetFineStatusResponse>("/admin/fines/status", {
        method: "POST",
        body: { number: f.number, day: f.day, status },
      });
      setResolvedKeys((prev) => new Set(prev).add(key));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "납부 상태 변경에 실패했습니다.");
    } finally {
      setPendingKey(null);
    }
  }

  function toggleExpand(f: UnpaidFine) {
    const key = fineKey(f);
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(key);
    if (!dayDetail[key]) {
      setDayDetail((prev) => ({ ...prev, [key]: "loading" }));
      call<StatusResponse>(`/admin/members/${encodeURIComponent(f.number)}`)
        .then((data) => setDayDetail((prev) => ({ ...prev, [key]: data })))
        .catch(() => setDayDetail((prev) => ({ ...prev, [key]: "error" })));
    }
  }

  const visible = (unpaid || []).filter((f) => !resolvedKeys.has(fineKey(f)));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-bold sm:text-base">
          <Wallet className="size-4 shrink-0 text-primary sm:size-5" strokeWidth={ICON_STROKE.default} />
          벌금 미납 현황
        </span>
        <Button variant="outline" size="icon-sm" onClick={load} disabled={loading} aria-label="새로고침">
          <RotateCw className={cn("size-3.5", loading && "animate-spin")} strokeWidth={ICON_STROKE.default} />
        </Button>
      </div>
      <div className="h-px w-full bg-border" />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && !unpaid && (
        <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">불러오는 중...</p>
      )}

      {!loading && unpaid && visible.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">미납 항목이 없습니다.</p>
      )}

      {visible.length > 0 && (
        <div className="flex flex-col gap-2 sm:gap-2.5">
          {visible.map((f) => {
            const key = fineKey(f);
            const isPending = pendingKey === key;
            const isExpanded = expandedKey === key;
            const detail = dayDetail[key];
            const dayIndex = STATUS_DAYS.indexOf(f.day);
            const day =
              detail && detail !== "loading" && detail !== "error" ? detail.days[dayIndex] : null;

            return (
              <InfoCard key={key} className="flex flex-col gap-2.5">
                <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-sm font-bold sm:text-base">{f.name}</span>
                  <div className="flex items-center gap-1.5">
                    {FINE_STATUS_OPTIONS.map((status) => (
                      <Button
                        key={status}
                        size="sm"
                        variant={status === "미납" ? "destructive" : "outline"}
                        disabled={isPending}
                        onClick={() => handleSetStatus(f, status)}
                        className="flex-1 sm:flex-none"
                      >
                        {status}
                      </Button>
                    ))}
                    {/* 강제퇴실 처리 — 아직 미구현, 버튼만 우선 배치 */}
                    <Button size="sm" variant="outline" disabled className="flex-1 sm:flex-none">
                      직권
                    </Button>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      onClick={() => toggleExpand(f)}
                      aria-label={isExpanded ? "상세 접기" : "상세 펼치기"}
                    >
                      <ChevronDown
                        className={cn("size-3.5 transition-transform", isExpanded && "rotate-180")}
                        strokeWidth={ICON_STROKE.default}
                      />
                    </Button>
                  </div>
                </div>

                {isExpanded && (
                  <>
                    {detail === "loading" && (
                      <p className="py-4 text-center text-sm text-muted-foreground">불러오는 중...</p>
                    )}
                    {detail === "error" && (
                      <p className="py-4 text-center text-sm text-destructive">정보를 불러오지 못했습니다.</p>
                    )}
                    {day && <DayDetailCard day={day} dayLabel={`${f.day}요일`} />}
                  </>
                )}
              </InfoCard>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DepositList() {
  const { call } = useApi();

  const [unpaid, setUnpaid] = useState<UnpaidDeposit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingNumber, setPendingNumber] = useState<string | null>(null);
  const [resolvedNumbers, setResolvedNumbers] = useState<Set<string>>(new Set());

  function load() {
    setLoading(true);
    setError(null);
    call<AdminDepositsUnpaidResponse>("/admin/deposits/unpaid")
      .then((data) => {
        setUnpaid(data.unpaid || []);
        setResolvedNumbers(new Set());
      })
      .catch((err) => setError(err instanceof Error ? err.message : "예치금 미납 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSetStatus(d: UnpaidDeposit, status: DepositStatus) {
    setPendingNumber(d.number);
    setError(null);
    try {
      await call<SetDepositStatusResponse>("/admin/deposits/status", {
        method: "POST",
        body: { number: d.number, status },
      });
      setResolvedNumbers((prev) => new Set(prev).add(d.number));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "예치금 재납 상태 변경에 실패했습니다.");
    } finally {
      setPendingNumber(null);
    }
  }

  const visible = (unpaid || []).filter((d) => !resolvedNumbers.has(d.number));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-bold sm:text-base">
          <PiggyBank className="size-4 shrink-0 text-primary sm:size-5" strokeWidth={ICON_STROKE.default} />
          예치금 미납 현황
        </span>
        <Button variant="outline" size="icon-sm" onClick={load} disabled={loading} aria-label="새로고침">
          <RotateCw className={cn("size-3.5", loading && "animate-spin")} strokeWidth={ICON_STROKE.default} />
        </Button>
      </div>
      <div className="h-px w-full bg-border" />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && !unpaid && (
        <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">불러오는 중...</p>
      )}

      {!loading && unpaid && visible.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground sm:text-base">미납 항목이 없습니다.</p>
      )}

      {visible.length > 0 && (
        <div className="flex flex-col gap-2 sm:gap-2.5">
          {visible.map((d) => {
            const isPending = pendingNumber === d.number;
            return (
              <InfoCard key={d.number} className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-sm font-bold sm:text-base">{d.name}</span>
                <div className="flex gap-1.5">
                  {DEPOSIT_STATUS_OPTIONS.map((status) => (
                    <Button
                      key={status}
                      size="sm"
                      variant={status === "미납" ? "destructive" : "outline"}
                      disabled={isPending}
                      onClick={() => handleSetStatus(d, status)}
                      className="flex-1 sm:flex-none"
                    >
                      {status}
                    </Button>
                  ))}
                </div>
              </InfoCard>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function AdminMoneyTab() {
  return (
    <div className="flex flex-col gap-6">
      <FineList />
      <div className="h-px w-full bg-border" />
      <DepositList />
    </div>
  );
}
