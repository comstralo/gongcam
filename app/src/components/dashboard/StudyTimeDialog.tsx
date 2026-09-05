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
              <Timer className="size-3.5 shrink-0 text-muted-foreground sm:size-4" />
              <ItemTitle>주간 학습시간</ItemTitle>
            </span>
            <span className="text-sm sm:text-base">{weeklyStudyTime}</span>
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
                  {/* 🔧 2026-09 재정정(2차): "월요일"을 요약보다 작게 되돌린
                      이전 판단이 틀렸다(사용자 지적) — 구조를 다시 보면
                      "주간 학습시간"(요약 카드) + 요일 7개(형제 카드)는
                      MeritBreakdownDialog의 "주간 총 상점"(요약 카드) +
                      "상점 적립 원인" 등(형제 카드)과 완전히 동일한 모양
                      이다. 형제 카드는 전부 같은 위계라는 원칙을 여기도
                      그대로 적용해 ItemTitle로 되돌린다.
                      그리고 뱃지("0H 0M" 등)가 요일 라벨과 폰트 크기는
                      같은데도 훨씬 도드라져 보인 진짜 원인은 크기가 아니라
                      "꽉 찬 색 배경 + font-semibold" 조합이 필(pill) 형태로
                      시각적 무게를 만든 것이었다(사용자 지적 — "크기"가
                      아니라 "혼자 튀어 보임"의 문제). 배경을 더 옅게
                      (/15→/10), 굵기를 font-medium으로 낮춰 색으로 정보는
                      여전히 구분되지만 요일 제목을 압도하지 않게 했다. */}
                  <CollapsibleTrigger>
                    <span className="flex min-w-0 flex-1 items-center justify-between gap-1.5">
                      <span className="flex items-center gap-1.5">
                        <CalendarDays className="size-3.5 shrink-0 text-muted-foreground sm:size-4" />
                        <ItemTitle>{d.day}요일</ItemTitle>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {achieved !== null && (
                          <span
                            className={cn(
                              "rounded-full px-1.5 py-0.5 text-micro font-medium sm:text-micro-lg",
                              achieved ? "bg-ok/10 text-ok" : "bg-destructive/10 text-destructive"
                            )}
                          >
                            {formatHM(dayInfo?.studyTime || "")}
                          </span>
                        )}
                        {isPeriodType && (
                          <span className="rounded-full bg-ok/10 px-1.5 py-0.5 text-micro font-medium text-ok sm:text-micro-lg">
                            {passed}개 교시
                          </span>
                        )}
                      </span>
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
                                <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground sm:text-sm">
                                  <Clock className="size-2.5 shrink-0 sm:size-3" />
                                  <span className={cn("inline-block", !isPeriodType && "min-w-[6.5em]")}>
                                    {periodLabels[i]}
                                  </span>
                                </span>
                                <span
                                  className={cn(
                                    "text-xs tabular-nums sm:text-sm",
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
