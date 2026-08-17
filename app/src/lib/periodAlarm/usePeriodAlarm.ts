import { useContext } from "react";
import { PeriodAlarmContext, type PeriodAlarmContextValue } from "./PeriodAlarmContext";

export function usePeriodAlarm(): PeriodAlarmContextValue {
  const ctx = useContext(PeriodAlarmContext);
  if (!ctx) throw new Error("usePeriodAlarm must be used within a PeriodAlarmProvider");
  return ctx;
}
