import { createContext, useEffect, useRef, useState, type ReactNode } from "react";
import { PERIODS, getPeriodPhase, formatRemaining, type PeriodPhase } from "@/lib/periods";

const SOUND_PREF_KEY = "periodAlarmSoundEnabled";
const START_CHIME_SRC = `${import.meta.env.BASE_URL}sounds/period-start.mp3`;
const END_CHIME_SRC = `${import.meta.env.BASE_URL}sounds/period-end.mp3`;

function loadSoundPref(): boolean {
  try {
    const raw = localStorage.getItem(SOUND_PREF_KEY);
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

function saveSoundPref(enabled: boolean) {
  try {
    localStorage.setItem(SOUND_PREF_KEY, enabled ? "1" : "0");
  } catch {
    // 저장 실패해도 현재 세션 동작에는 지장 없음
  }
}

function todayMidnightMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export type PeriodAlarmContextValue = {
  phase: PeriodPhase;
  remainingLabel: string;
  soundEnabled: boolean;
  setSoundEnabled: (enabled: boolean) => void;
};

export const PeriodAlarmContext = createContext<PeriodAlarmContextValue | null>(null);

// 앱 최상단(App.tsx)에서 한 번만 마운트해 대시보드 탭을 벗어나도 타이머와
// 차임벨 재생이 계속되도록 한다. 이전에는 PeriodAlarmCard 안에서 직접
// setInterval을 돌려서, 다른 탭으로 이동해 카드가 언마운트되면 알람도 함께 멎었다.
export function PeriodAlarmProvider({ children }: { children: ReactNode }) {
  const [soundEnabled, setSoundEnabledState] = useState(loadSoundPref);
  const [phase, setPhase] = useState<PeriodPhase>(() => getPeriodPhase(todayMidnightMs(), Date.now()));
  const [remainingLabel, setRemainingLabel] = useState("");

  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const startAudioRef = useRef<HTMLAudioElement | null>(null);
  const endAudioRef = useRef<HTMLAudioElement | null>(null);
  const lastFiredRef = useRef<{ startIndex: number | null; endIndex: number | null }>({
    startIndex: null,
    endIndex: null,
  });
  // 직전 tick 이후 이 간격보다 오래 멈췄다 재개되면(맥북 잠자기 등) 그 사이 지나간
  // 알람은 밀려서 재생하지 않고 건너뛴다. setInterval(1000ms) 정상 지연을 여유 있게
  // 허용하기 위해 5초로 잡는다.
  const lastTickAtRef = useRef<number>(Date.now());

  useEffect(() => {
    startAudioRef.current = new Audio(START_CHIME_SRC);
    endAudioRef.current = new Audio(END_CHIME_SRC);
  }, []);

  function setSoundEnabled(enabled: boolean) {
    setSoundEnabledState(enabled);
    saveSoundPref(enabled);
  }

  useEffect(() => {
    function tick() {
      const midnight = todayMidnightMs();
      const now = Date.now();
      const nowMinutes = (now - midnight) / 60_000;
      const next = getPeriodPhase(midnight, now);
      setPhase(next);
      setRemainingLabel(next.kind === "outside" ? "" : formatRemaining(next.remainingMs));

      const wasAsleep = now - lastTickAtRef.current > 5000;
      lastTickAtRef.current = now;

      const nowMinuteFloor = Math.floor(nowMinutes);
      for (const period of PERIODS) {
        if (nowMinuteFloor === period.startMinutes && lastFiredRef.current.startIndex !== period.index) {
          lastFiredRef.current.startIndex = period.index;
          if (soundEnabledRef.current && !wasAsleep) startAudioRef.current?.play().catch(() => {});
        }
        if (nowMinuteFloor === period.endMinutes && lastFiredRef.current.endIndex !== period.index) {
          lastFiredRef.current.endIndex = period.index;
          if (soundEnabledRef.current && !wasAsleep) endAudioRef.current?.play().catch(() => {});
        }
      }
    }

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const value: PeriodAlarmContextValue = { phase, remainingLabel, soundEnabled, setSoundEnabled };

  return <PeriodAlarmContext.Provider value={value}>{children}</PeriodAlarmContext.Provider>;
}
