import { useEffect, useRef, useState } from "react";
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

export function usePeriodAlarm() {
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
      setRemainingLabel(
        next.kind === "outside" ? "" : formatRemaining(next.remainingMs)
      );

      const nowMinuteFloor = Math.floor(nowMinutes);
      for (const period of PERIODS) {
        if (nowMinuteFloor === period.startMinutes && lastFiredRef.current.startIndex !== period.index) {
          lastFiredRef.current.startIndex = period.index;
          if (soundEnabledRef.current) startAudioRef.current?.play().catch(() => {});
        }
        if (nowMinuteFloor === period.endMinutes && lastFiredRef.current.endIndex !== period.index) {
          lastFiredRef.current.endIndex = period.index;
          if (soundEnabledRef.current) endAudioRef.current?.play().catch(() => {});
        }
      }
    }

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return { phase, remainingLabel, soundEnabled, setSoundEnabled };
}
