import { useEffect, useRef, useState, type RefObject } from "react";
import { computeCoverRect, drawGrid } from "@/lib/checker/drawGrid";

const TOTAL_SHOTS = 6;
const INTERVAL_SEC = 30;

type UseFrameCaptureArgs = {
  videoRef: RefObject<HTMLVideoElement | null>;
  liveCanvasRef: RefObject<HTMLCanvasElement | null>;
  resultCanvasRef: RefObject<HTMLCanvasElement | null>;
  stageRef: RefObject<HTMLDivElement | null>;
  setStatus: (status: string) => void;
};

export function useFrameCapture({ videoRef, liveCanvasRef, resultCanvasRef, stageRef, setStatus }: UseFrameCaptureArgs) {
  const capturedShotsRef = useRef<HTMLCanvasElement[]>([]);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [shotsLeft, setShotsLeft] = useState(TOTAL_SHOTS);
  const [remainingSec, setRemainingSec] = useState(0);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isFinished, setIsFinished] = useState(false);
  const [opacity, setOpacity] = useState(0.35);

  const captureTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function resizeCanvases() {
    const stage = stageRef.current;
    const liveCanvas = liveCanvasRef.current;
    const resultCanvas = resultCanvasRef.current;
    if (!stage || !liveCanvas || !resultCanvas) return;
    const rect = stage.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    liveCanvas.width = w;
    liveCanvas.height = h;
    resultCanvas.width = w;
    resultCanvas.height = h;
  }

  // 라이브 프리뷰 렌더 루프 (rAF) + 리사이즈 리스너.
  // cleanup에서 rAF 취소 — 원본 정적 페이지에는 없던 부분(SPA 언마운트 시 루프가 계속 돌면 누수).
  useEffect(() => {
    resizeCanvases();
    window.addEventListener("resize", resizeCanvases);

    let rafId: number;
    function renderLive() {
      const video = videoRef.current;
      const liveCanvas = liveCanvasRef.current;
      if (video && liveCanvas && video.readyState >= 2) {
        const ctx = liveCanvas.getContext("2d");
        const w = liveCanvas.width;
        const h = liveCanvas.height;
        if (ctx) {
          ctx.clearRect(0, 0, w, h);
          const vw = video.videoWidth;
          const vh = video.videoHeight;
          if (vw && vh) {
            const { sx, sy, sw, sh } = computeCoverRect(vw, vh, w, h);
            ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
          }
          drawGrid(ctx, w, h);
        }
      }
      rafId = requestAnimationFrame(renderLive);
    }
    rafId = requestAnimationFrame(renderLive);

    return () => {
      window.removeEventListener("resize", resizeCanvases);
      cancelAnimationFrame(rafId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function captureFrame(): HTMLCanvasElement | null {
    const video = videoRef.current;
    const liveCanvas = liveCanvasRef.current;
    if (!video || !liveCanvas) return null;
    const w = liveCanvas.width;
    const h = liveCanvas.height;
    const shotCanvas = document.createElement("canvas");
    shotCanvas.width = w;
    shotCanvas.height = h;
    const sctx = shotCanvas.getContext("2d");
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (sctx && vw && vh) {
      const { sx, sy, sw, sh } = computeCoverRect(vw, vh, w, h);
      sctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
    }
    return shotCanvas;
  }

  function addShot(canvas: HTMLCanvasElement) {
    capturedShotsRef.current.push(canvas);
    setThumbs((prev) => [...prev, canvas.toDataURL("image/jpeg", 0.7)]);
  }

  function renderOverlayResult() {
    const resultCanvas = resultCanvasRef.current;
    if (!resultCanvas) return;
    const ctx = resultCanvas.getContext("2d");
    if (!ctx) return;
    const w = resultCanvas.width;
    const h = resultCanvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

    capturedShotsRef.current.forEach((shot, idx) => {
      ctx.globalAlpha = idx === 0 ? 1 : opacity;
      ctx.drawImage(shot, 0, 0, w, h);
    });
    ctx.globalAlpha = 1;
    drawGrid(ctx, w, h);
  }

  // 투명도 슬라이더를 조정하면 결과 화면을 즉시 다시 그린다.
  useEffect(() => {
    if (isFinished) renderOverlayResult();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opacity, isFinished]);

  function clearTimers() {
    if (captureTimerRef.current) {
      clearInterval(captureTimerRef.current);
      captureTimerRef.current = null;
    }
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }

  function finishSequence() {
    clearTimers();
    setIsCapturing(false);
    setIsFinished(true);
    setStatus(`촬영 완료: 총 ${capturedShotsRef.current.length}장. 오버레이 결과를 확인하세요.`);
    // 다음 렌더에서 resultCanvas가 표시된 뒤 그려야 하므로 마이크로태스크로 미룸
    requestAnimationFrame(renderOverlayResult);
  }

  function startSequence() {
    capturedShotsRef.current = [];
    setThumbs([]);
    setIsFinished(false);
    setIsCapturing(true);
    setRemainingSec(INTERVAL_SEC);

    let shotsRemaining = TOTAL_SHOTS;

    // 첫 컷은 즉시 촬영
    const first = captureFrame();
    if (first) addShot(first);
    shotsRemaining--;
    setShotsLeft(shotsRemaining);
    setStatus(`1번째 사진 촬영됨. 총 ${TOTAL_SHOTS}장 중 ${TOTAL_SHOTS - shotsRemaining}장 완료.`);

    countdownTimerRef.current = setInterval(() => {
      setRemainingSec((prev) => Math.max(prev - 1, 0));
    }, 1000);

    captureTimerRef.current = setInterval(() => {
      if (shotsRemaining <= 0) {
        finishSequence();
        return;
      }
      const shot = captureFrame();
      if (shot) addShot(shot);
      shotsRemaining--;
      setShotsLeft(shotsRemaining);
      setStatus(`${TOTAL_SHOTS - shotsRemaining}번째 사진 촬영됨. 총 ${TOTAL_SHOTS}장 중 ${TOTAL_SHOTS - shotsRemaining}장 완료.`);
      setRemainingSec(INTERVAL_SEC);
      if (shotsRemaining <= 0) {
        finishSequence();
      }
    }, INTERVAL_SEC * 1000);
  }

  function stopSequence() {
    clearTimers();
    setIsCapturing(false);
    setStatus("촬영이 중지되었습니다.");
  }

  function resetSequence() {
    capturedShotsRef.current = [];
    setThumbs([]);
    setIsFinished(false);
    setStatus("준비 완료. 촬영 시작을 누르세요.");
  }

  function downloadResult() {
    const resultCanvas = resultCanvasRef.current;
    if (!resultCanvas) return;
    const link = document.createElement("a");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    link.download = `fov-check-${ts}.jpg`;
    link.href = resultCanvas.toDataURL("image/jpeg", 0.92);
    link.click();
  }

  // 언마운트 시 안전망으로 타이머 정리 (버튼 클릭으로 정지하지 않고 페이지를 벗어나는 경우 대비)
  useEffect(() => clearTimers, []);

  return {
    thumbs,
    shotsLeft,
    remainingSec,
    isCapturing,
    isFinished,
    opacity,
    setOpacity,
    startSequence,
    stopSequence,
    resetSequence,
    downloadResult,
  };
}
