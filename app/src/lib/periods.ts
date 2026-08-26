// 교시 시간표 — study_sw/resource/timetable.csv와 동일한 고정 시간표.
// 1교시 07:20 시작 ~ 14교시 23:30 종료, 각 60분 + 쉬는 시간.
export type Period = {
  index: number; // 1~14
  startMinutes: number; // 자정 기준 분
  endMinutes: number;
};

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

const RAW_TIMETABLE: [string, string][] = [
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

export const PERIODS: Period[] = RAW_TIMETABLE.map(([start, end], i) => ({
  index: i + 1,
  startMinutes: toMinutes(start),
  endMinutes: toMinutes(end),
}));

export type PeriodPhase =
  | { kind: "in-period"; period: Period; remainingMs: number }
  | { kind: "break"; next: Period | null; remainingMs: number }
  | { kind: "outside"; remainingMs: number };

// midnightMs: 오늘 00:00의 epoch ms, nowMs: 현재 epoch ms
export function getPeriodPhase(midnightMs: number, nowMs: number): PeriodPhase {
  const nowMinutes = (nowMs - midnightMs) / 60_000;
  for (const period of PERIODS) {
    if (nowMinutes >= period.startMinutes && nowMinutes < period.endMinutes) {
      const remainingMs = midnightMs + period.endMinutes * 60_000 - nowMs;
      return { kind: "in-period", period, remainingMs };
    }
  }
  const next = PERIODS.find((p) => p.startMinutes > nowMinutes) || null;
  if (nowMinutes >= PERIODS[0].startMinutes - 60 && nowMinutes < PERIODS[PERIODS.length - 1].endMinutes) {
    const remainingMs = next ? midnightMs + next.startMinutes * 60_000 - nowMs : 0;
    return { kind: "break", next, remainingMs };
  }
  // 운영시간 외 — 다음 1교시 시작까지 남은 시간을 계산한다. 자정 이후(0시~1교시
  // 시작 1시간 전)면 같은 날 1교시가 대상, 그 외(마지막 교시 종료 이후)면
  // 다음날 1교시가 대상이라 자정을 하루 더 건너간다.
  const todayFirstStartMs = midnightMs + PERIODS[0].startMinutes * 60_000;
  const nextFirstStartMs = nowMs < todayFirstStartMs ? todayFirstStartMs : todayFirstStartMs + 24 * 60 * 60_000;
  return { kind: "outside", remainingMs: nextFirstStartMs - nowMs };
}

export function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
