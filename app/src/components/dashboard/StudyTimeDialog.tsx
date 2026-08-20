import { Timer, Search, CalendarDays, Clock } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoCard, TintedPill } from "@/components/dashboard/shared";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import type { PeriodGridDay, PeriodGridPeriod, StatusDay } from "@/lib/api/types";

const PERIOD_LABELS = Array.from({ length: 14 }, (_, i) => `${i + 1}교시`);

// "HH:MM"을 분으로 변환한다. 파싱 실패 시 null.
function timeToMinutes(raw: string): number | null {
  const m = (raw || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// 참여율 값을 판정한다: "ERR"=기록 오류, 숫자 85 이상=달성, 그 외 숫자=미달.
function rateTone(rate: string): { text: string; className?: string } {
  if (rate === "ERR") return { text: "ERR", className: "text-destructive" };
  const n = Number(rate);
  if (Number.isFinite(n)) {
    return { text: `${Math.round(n)}%`, className: n >= 85 ? "text-ok" : "text-destructive" };
  }
  return { text: rate, className: "text-muted-foreground" };
}

// 교시 한 칸을 "59분 · 0%" 형태로 요약한다.
// 시작/종료/참여율이 전부 비어 있으면 기록 자체가 없는 것으로 본다.
function formatPeriod(p: PeriodGridPeriod): { text: string; className?: string; recorded: boolean } {
  if (!p.start && !p.end && !p.rate) {
    return { text: "미기록", className: "text-muted-foreground/60", recorded: false };
  }
  const startMin = timeToMinutes(p.start);
  const endMin = timeToMinutes(p.end);
  const duration = startMin !== null && endMin !== null ? endMin - startMin : null;
  const { text: rateText, className } = rateTone(p.rate);
  const durationText = duration !== null && duration >= 0 ? `${duration}분` : "-";
  return { text: `${durationText} · ${rateText}`, className, recorded: true };
}

// 통과 교시 수 = 참여율 85% 이상 또는 "ERR"인 교시 개수.
function passedCount(periods: PeriodGridPeriod[]): number {
  return periods.filter((p) => p.rate === "ERR" || Number(p.rate) >= 85).length;
}

export function StudyTimeDialog({
  weeklyStudyTime,
  periodGrid,
  days,
  children,
}: {
  weeklyStudyTime: string;
  periodGrid: PeriodGridDay[];
  days: StatusDay[];
  children: ReactNode;
}) {
  return (
    <Dialog>
      <DialogTrigger className="w-full rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        {children}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Search className="size-4 text-primary sm:size-5" />
            주간 학습시간 · 세부사항
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <InfoCard className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
              <Timer className="size-3.5 shrink-0 text-primary sm:size-4" />
              주간 학습시간
            </span>
            <span className="text-xs sm:text-sm">{weeklyStudyTime}</span>
          </InfoCard>

          {periodGrid.map((d) => {
            const dayInfo = days.find((x) => x.day === d.day);
            const studyMin = timeToMinutes(dayInfo?.studyTime || "");
            const goalMin = timeToMinutes(dayInfo?.dailyGoalTime || "");
            const achieved =
              dayInfo?.complete && studyMin !== null && goalMin !== null ? studyMin >= goalMin : null;
            const passed = passedCount(d.periods);

            return (
              <Collapsible key={d.day}>
                <InfoCard className="flex flex-col gap-1.5">
                  <CollapsibleTrigger>
                    <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
                      <CalendarDays className="size-3.5 shrink-0 text-primary sm:size-4" />
                      {d.day}요일
                    </span>
                    <span className="flex items-center gap-1">
                      {achieved !== null && (
                        <TintedPill tone={achieved ? "ok" : "warn"}>
                          {dayInfo?.studyTime || "0:00"} {achieved ? "달성" : "미달성"}
                        </TintedPill>
                      )}
                      <TintedPill tone="primary">{passed}교시 통과</TintedPill>
                    </span>
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1.5">
                      {[d.periods.slice(0, 7), d.periods.slice(7, 14)].map((half, col) => (
                        <div key={col} className="flex flex-col gap-1">
                          {half.map((p, j) => {
                            const i = col * 7 + j;
                            const { text, className, recorded } = formatPeriod(p);
                            return (
                              <div key={i} className="flex items-center justify-between gap-2">
                                <span className="flex shrink-0 items-center gap-1 text-micro-lg text-muted-foreground sm:text-xs">
                                  <Clock className="size-2.5 shrink-0 sm:size-3" />
                                  {PERIOD_LABELS[i]}
                                </span>
                                <span
                                  className={cn(
                                    "text-micro-lg tabular-nums sm:text-xs",
                                    recorded ? className : "text-muted-foreground/60"
                                  )}
                                >
                                  {text}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </CollapsiblePanel>
                </InfoCard>
              </Collapsible>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
