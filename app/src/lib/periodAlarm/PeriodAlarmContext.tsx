import { createContext, useEffect, useRef, useState, type ReactNode } from "react";
import { PERIODS, getPeriodPhase, formatRemaining, type PeriodPhase } from "@/lib/periods";

const SOUND_PREF_KEY = "periodAlarmSoundEnabled";
const START_CHIME_SRC = `${import.meta.env.BASE_URL}sounds/period-start.mp3`;
const END_CHIME_SRC = `${import.meta.env.BASE_URL}sounds/period-end.mp3`;

function loadSoundPref(): boolean {
  try {
    const raw = localStorage.getItem(SOUND_PREF_KEY);
    return raw === null ? false : raw === "1";
  } catch {
    return false;
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
    // 🔧 [버그 수정] "종소리를 켜놓고 새로고침하면 바로 울린다" — 마운트
    // 직후 첫 tick은 lastTickAtRef가 방금 초기화된 시각이라 wasAsleep이
    // 항상 false로 판정되고, lastFiredRef도 아직 null이라 "발화 이력
    // 없음"으로 취급됐다. 새로고침한 순간이 우연히 어떤 교시의 시작/종료
    // 분(정수 경계)과 겹치면, 이미 그 이전부터 진행 중이던 교시임에도
    // "지금 막 시작/종료됐다"고 오판해 즉시 재생됐다(사용자 발견). 마운트
    // 시점에 lastFiredRef를 "지금 이 순간의 경계는 이미 지나간 것"으로
    // 미리 채워, 최초 tick에서는 그 경계를 절대 새로 발화하지 않게 한다 —
    // 이미 진행 중이던 알람은 이 경로로 건너뛸 이유가 없다(정상적으로
    // 그 페이지를 열어두고 있었다면 setInterval이 이미 그 경계를 처리했을
    // 것이므로).
    const mountMinutes = (Date.now() - todayMidnightMs()) / 60_000;
    const mountMinuteFloor = Math.floor(mountMinutes);
    for (const period of PERIODS) {
      if (mountMinuteFloor === period.startMinutes) lastFiredRef.current.startIndex = period.index;
      if (mountMinuteFloor === period.endMinutes) lastFiredRef.current.endIndex = period.index;
    }

    function tick() {
      const midnight = todayMidnightMs();
      const now = Date.now();
      const nowMinutes = (now - midnight) / 60_000;
      const next = getPeriodPhase(midnight, now);
      setPhase(next);
      setRemainingLabel(formatRemaining(next.remainingMs));

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
