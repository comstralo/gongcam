import { useEffect, useState } from "react";

// KST(Asia/Seoul) 기준 "지금"의 연/월/일/요일을 얻는다. 서버(Worker)는
// 항상 UTC 로컬이라 Date.now() + 9시간 트릭을 쓰지만, 브라우저는 사용자
// 기기에 설정된 임의의 시간대로 돌아가므로 그 트릭이 통하지 않는다 —
// Intl.DateTimeFormat에 timeZone을 명시해 KST 값을 직접 얻어야 한다.
function getKSTParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  const weekdayMap: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    // 자정 직후 24시로 표기되는 로케일이 있어 보정한다.
    hour: get("hour") === "24" ? 0 : Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    dayIndex: weekdayMap[get("weekday")] ?? 0, // 월=0 ... 일=6
  };
}

function computeTodayIndex(): number {
  return getKSTParts(new Date()).dayIndex;
}

// KST 기준 다음 자정까지 남은 ms. setTimeout 최대 지연(약 24.8일)을 훨씬
// 밑도는 값이라 안전하게 그대로 쓸 수 있다.
function msUntilNextKSTMidnight(): number {
  const { hour, minute, second } = getKSTParts(new Date());
  const elapsedMs = ((hour * 60 + minute) * 60 + second) * 1000;
  const msPerDay = 24 * 60 * 60 * 1000;
  return msPerDay - elapsedMs + 5000; // 자정 경계 오차 방지용 5초 여유.
}

// 오늘 요일 인덱스(월=0 ... 일=6)를 KST(한국시간) 기준으로 반환한다. 이
// 서비스는 백엔드 계산이 전부 KST로 고정되어 있는데, 프론트에서 이 값을
// 사용자 기기의 로컬 시간대로 계산하면 해외에 있거나 기기 시간대가 잘못
// 설정된 사용자에게 "오늘" 표시·미래 요일 비활성화가 실제 시트 기준과
// 어긋나 보일 수 있다.
// 대시보드/전체 대시보드 화면은 탭을 옮겨도 언마운트되지 않고 계속 떠
// 있을 수 있어, 이 값을 컴포넌트 최초 렌더 시점에 한 번만 계산해두면
// 자정을 넘긴 뒤에도 "오늘"이 어제로 고정된 채 남는다. KST 기준 다음
// 자정까지 정확히 타이머를 걸어, 그 시점에 다시 계산하고 또 다음 자정
// 타이머를 건다.
export function useTodayIndex(): number {
  const [todayIndex, setTodayIndex] = useState(computeTodayIndex);

  useEffect(() => {
    const timer = setTimeout(() => {
      setTodayIndex(computeTodayIndex());
    }, msUntilNextKSTMidnight());
    return () => clearTimeout(timer);
  }, [todayIndex]);

  return todayIndex;
}
