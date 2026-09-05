import { Timer, Search, CalendarDays, Clock } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoCard, ItemTitle } from "@/components/dashboard/shared";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import type { PeriodGridDay, PeriodGridPeriod, StatusDay } from "@/lib/api/types";

// study_sw/assets/timetable.csv와 동일한 고정 교시 시간표.
const PERIOD_TIMETABLE = [
  ["07:20", "08:20"],
  ["08:30", "09:30"],
  ["09:40", "10:40"],
  ["10:50", "11:50"],
  ["12:00", "13:00"],
  ["13:10", "14:10"],
  ["14:20", "15:20"],
  ["15:30", "16:30"],
  ["16:40", "17:40"],
  ["17:50", "18:50"],
  ["19:00", "20:00"],
  ["20:10", "21:10"],
  ["21:20", "22:20"],
  ["22:30", "23:30"],
];
const PERIOD_TIME_LABELS = PERIOD_TIMETABLE.map(([start, end]) => `${start}~${end}`);
const PERIOD_NUMBER_LABELS = Array.from({ length: 14 }, (_, i) => `${i + 1}교시`);

// "HH:MM"을 분으로 변환한다. 파싱 실패 시 null.
function timeToMinutes(raw: string): number | null {
  const m = (raw || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// 참여율 값을 "92%"/"ERR" 텍스트와 색상으로 판정한다: "ERR"=오류,
// 85% 이상=달성(초록), 그 외=미달(빨강).
function rateTone(rate: string): { text: string; className: string } {
  if (rate === "ERR") return { text: "ERR", className: "text-destructive" };
  const n = Number(rate);
  if (Number.isFinite(n)) {
    return { text: `${Math.round(n)}%`, className: n >= 85 ? "text-ok" : "text-destructive" };
  }
  return { text: rate, className: "text-muted-foreground" };
}

// 교시 한 칸을 요약한다 — 교시제는 "59분 · 92%", 달성제는 "59분"만 표시한다.
// 시작/종료/참여율이 전부 비어 있으면 기록 자체가 없는 것으로 본다.
function formatPeriod(
  p: PeriodGridPeriod,
  showRate: boolean
): { text: string; className?: string; recorded: boolean } {
  if (!p.start && !p.end && !p.rate) {
    return { text: "미기록", className: "text-muted-foreground/60", recorded: false };
  }
  const startMin = timeToMinutes(p.start);
  const endMin = timeToMinutes(p.end);
  const duration = startMin !== null && endMin !== null ? endMin - startMin : null;
  const durationText = duration !== null && duration >= 0 ? `${duration}분` : "-";
  const { text: rateText, className } = rateTone(p.rate);
  const text = showRate ? `${durationText} · ${rateText}` : durationText;
  return { text, className, recorded: true };
}

// 통과 교시 수 = 참여율 85% 이상 또는 "ERR"인 교시 개수(교시제 전용 지표).
function passedCount(periods: PeriodGridPeriod[]): number {
  return periods.filter((p) => p.rate === "ERR" || Number(p.rate) >= 85).length;
}

// "HH:MM"을 "NH NM"으로 표시한다.
function formatHM(raw: string): string {
  const min = timeToMinutes(raw);
  if (min === null) return "0H 0M";
  return `${Math.floor(min / 60)}H ${min % 60}M`;
}

export function StudyTimeDialog({
  weeklyStudyTime,
  goalType,
  periodGrid,
  days,
  children,
}: {
  weeklyStudyTime: string;
  goalType: string;
  periodGrid: PeriodGridDay[];
  days: StatusDay[];
  children: ReactNode;
}) {
  const isPeriodType = goalType.includes("교시제");
  const periodLabels = isPeriodType ? PERIOD_NUMBER_LABELS : PERIOD_TIME_LABELS;
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
            <span className="flex items-center gap-1.5">
              <Timer className="size-3.5 shrink-0 text-primary sm:size-4" />
              <ItemTitle>주간 학습시간</ItemTitle>
            </span>
            <span className="text-xs sm:text-sm">{weeklyStudyTime}</span>
          </InfoCard>

          {periodGrid.map((d) => {
            const dayInfo = days.find((x) => x.day === d.day);
            const studyMin = timeToMinutes(dayInfo?.studyTime || "");
            const goalMin = timeToMinutes(dayInfo?.dailyGoalTime || "");
            const achieved = studyMin !== null && goalMin !== null ? studyMin >= goalMin : null;
            const passed = passedCount(d.periods);

            return (
              <Collapsible key={d.day}>
                <InfoCard className="flex flex-col gap-1.5">
                  {/* 🔧 2026-09 정정: 이 요일 헤더를 위 "주간 학습시간" 요약과
                      똑같은 ItemTitle로 바꿨던 게 실수였다(사용자 지적) —
                      MeritBreakdownDialog처럼 고정된 개별 섹션들과 달리,
                      여기는 "요약 1개 + 반복되는 요일 목록 7개" 구조라
                      역할이 다르다. 7개 반복 항목을 요약과 같은 굵기·
                      크기로 만들면 스크롤할 때 전부 똑같이 도드라져
                      오히려 뭐가 우선인지 안 보인다 — 원래 크기
                      (text-xs sm:text-sm)로 되돌려 "요약 > 요일 행 > 교시
                      세부"라는 3단 구조를 유지한다. */}
                  <CollapsibleTrigger>
                    <span className="flex items-center gap-1.5 text-xs font-semibold sm:text-sm">
                      <CalendarDays className="size-3.5 shrink-0 text-primary sm:size-4" />
                      {d.day}요일
                      {achieved !== null && (
                        <span
                          className={cn(
                            "rounded-full px-1.5 py-0.5 text-micro font-semibold sm:text-micro-lg",
                            achieved ? "bg-ok/15 text-ok" : "bg-destructive/15 text-destructive"
                          )}
                        >
                          {formatHM(dayInfo?.studyTime || "")}
                        </span>
                      )}
                      {isPeriodType && (
                        <span className="rounded-full bg-ok/15 px-1.5 py-0.5 text-micro font-semibold text-ok sm:text-micro-lg">
                          {passed}개 교시
                        </span>
                      )}
                    </span>
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1.5">
                      {[d.periods.slice(0, 7), d.periods.slice(7, 14)].map((half, col) => (
                        <div key={col} className="flex flex-col gap-1">
                          {half.map((p, j) => {
                            const i = col * 7 + j;
                            const { text, className, recorded } = formatPeriod(p, isPeriodType);
                            return (
                              <div key={i} className="flex items-center justify-between gap-2">
                                <span className="flex shrink-0 items-center gap-1 text-micro-lg tabular-nums text-muted-foreground sm:text-xs">
                                  <Clock className="size-2.5 shrink-0 sm:size-3" />
                                  <span className={cn("inline-block", !isPeriodType && "min-w-[6.5em]")}>
                                    {periodLabels[i]}
                                  </span>
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
