import { useEffect, useRef, useState } from "react";

const ASPECT = 16 / 9;

// 뷰파인더는 항상 16:9를 유지해야 하지만, CSS의 aspect-ratio + 가변 크기
// 조합만으로는(특히 flex/grid item에서) 남는 공간에 맞춰 정확히 축소되지
// 않는 경우가 있다(폭 기준으로만 커지거나, 좁은 트랙에서 비율이 깨짐).
// 컨테이너의 실제 가용 크기를 ResizeObserver로 측정해 16:9를 유지한 채
// 그 안에 꼭 맞는 폭/높이를 px로 직접 계산한다.
export function useFitViewfinder() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;

      // 가로/세로 중 더 제약이 큰 쪽에 맞춰 16:9를 유지하며 축소
      let w = width;
      let h = w / ASPECT;
      if (h > height) {
        h = height;
        w = h * ASPECT;
      }
      setSize({ width: Math.floor(w), height: Math.floor(h) });
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { containerRef, size };
}
