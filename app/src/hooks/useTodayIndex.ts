import { useEffect, useState } from "react";

function computeTodayIndex(): number {
  return (new Date().getDay() + 6) % 7; // 월=0 ... 일=6
}

// 오늘 요일 인덱스(월=0 ... 일=6)를 반환한다. 대시보드/전체 대시보드 화면은
// 탭을 옮겨도 언마운트되지 않고 계속 떠 있을 수 있어, 이 값을 컴포넌트
// 최초 렌더 시점에 한 번만 계산해두면 자정을 넘긴 뒤에도 "오늘"이 어제로
// 고정된 채 남는다(예: 밤 11시 50분에 열어둔 화면을 자정 이후 다시 봐도
// "오늘" 표시·미래 요일 비활성화 기준이 하루 밀려 있음). 다음 자정까지
// 정확히 타이머를 걸어, 그 시점에 다시 계산하고 또 다음 자정 타이머를 건다.
export function useTodayIndex(): number {
  const [todayIndex, setTodayIndex] = useState(computeTodayIndex);

  useEffect(() => {
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    const msUntilMidnight = nextMidnight.getTime() - now.getTime();
    const timer = setTimeout(() => {
      setTodayIndex(computeTodayIndex());
    }, msUntilMidnight);
    return () => clearTimeout(timer);
  }, [todayIndex]);

  return todayIndex;
}
