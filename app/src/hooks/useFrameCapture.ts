import { useEffect, useRef, useState, type RefObject } from "react";
import { computeCoverRect, drawGrid } from "@/lib/checker/drawGrid";

const TOTAL_SHOTS = 6;
const INTERVAL_SEC = 30;
const START_COUNTDOWN_SEC = 10;

// 최종 합성본 좌측 상단에 찍는 라벨의 타임스탬프 형식 — YYMMDD HH:MM:SS
function formatTimestamp(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const yy = pad(date.getFullYear() % 100);
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yy}${mm}${dd} ${hh}:${min}:${ss}`;
}

type UseFrameCaptureArgs = {
  videoRef: RefObject<HTMLVideoElement | null>;
  liveCanvasRef: RefObject<HTMLCanvasElement | null>;
  resultCanvasRef: RefObject<HTMLCanvasElement | null>;
  stageRef: RefObject<HTMLDivElement | null>;
  mirrored: boolean;
};

export function useFrameCapture({ videoRef, liveCanvasRef, resultCanvasRef, stageRef, mirrored }: UseFrameCaptureArgs) {
  const capturedShotsRef = useRef<HTMLCanvasElement[]>([]);
  // 최종 합성본에 찍을 완료 시각 — 촬영이 끝난 시점(finishSequence)에 한 번
  // 고정해, 이후 재렌더(예: 리사이즈로 인한 재합성)에도 값이 바뀌지 않게 한다.
  const finishedAtRef = useRef<Date | null>(null);
  // 🔧 [사용자 지시] 라벨에 "(세로모드)" 같이 촬영 당시 화면 방향도 함께
  // 표기 — 촬영 완료 시점에 한 번 판별해 고정한다(회전 후에도 값 유지).
  const finishedOrientationRef = useRef<"세로모드" | "가로모드" | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [shotsLeft, setShotsLeft] = useState(TOTAL_SHOTS);
  const [remainingSec, setRemainingSec] = useState(0);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isFinished, setIsFinished] = useState(false);
  const [startCountdown, setStartCountdown] = useState<number | null>(null);

  const captureTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startCountdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // rAF 루프와 캡처 함수가 항상 최신 mirrored 값을 읽도록 ref로 미러링
  const mirroredRef = useRef(mirrored);
  mirroredRef.current = mirrored;

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
            ctx.save();
            if (mirroredRef.current) {
              ctx.translate(w, 0);
              ctx.scale(-1, 1);
            }
            ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
            ctx.restore();
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
      sctx.save();
      if (mirroredRef.current) {
        sctx.translate(w, 0);
        sctx.scale(-1, 1);
      }
      sctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
      sctx.restore();
    }
    return shotCanvas;
  }

  function addShot(canvas: HTMLCanvasElement) {
    capturedShotsRef.current.push(canvas);
    setThumbs((prev) => [...prev, canvas.toDataURL("image/jpeg", 0.7)]);
  }

  // 🔧 [사용자 지시] "촬영 완료 후에 오버레이를 조정하는게 아닌, 네가 적당한
  // 투명도를 줘서 하나의 파일로 합치도록" — 이 기능의 목적은 6장에 걸쳐
  // 손/움직임이 화각 격자 안에 들어오는지 "한 장으로" 확인하는 것이라, 특정
  // 프레임(기존엔 1번째 컷)만 진하고 나머지가 옅게 묻히면 뒤쪽 프레임의
  // 움직임이 잘 안 보여 목적에 안 맞았다. 6장을 전부 동일한 가중치로
  // 반영해야 "어느 프레임에서든 격자를 벗어났는지"가 고르게 드러난다.
  // 순차 알파블렌딩(위 프레임이 아래 프레임을 가림) 대신 globalCompositeOperation
  // "lighter"(가산 혼합) + 각 프레임 alpha = 1/장수를 써서, 정확히 균등한
  // 가중치로 겹치면서도 결과 밝기가 자연스럽게 정규화되도록 한다.
  function renderOverlayResult() {
    const resultCanvas = resultCanvasRef.current;
    if (!resultCanvas) return;
    const ctx = resultCanvas.getContext("2d");
    if (!ctx) return;
    const w = resultCanvas.width;
    const h = resultCanvas.height;
    const shots = capturedShotsRef.current;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = shots.length > 0 ? 1 / shots.length : 1;
    shots.forEach((shot) => {
      ctx.drawImage(shot, 0, 0, w, h);
    });
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    drawGrid(ctx, w, h);

    // 🔧 [사용자 지시] 최종 합성본 좌측 상단에 출처/시각 라벨을 함께 저장.
    // "(세로모드)" 같이 촬영 당시 화면 방향도 함께 표기하고, 문구 색상은
    // 노란색으로 강조한다.
    // 🔧 [사용자 지적] "상단에 텍스트가 좀 잘리거든? 라운드를 고려해서
    // 맞춰줘" — 이 캔버스를 감싸는 바깥 컨테이너가 rounded-lg로 잘리는데,
    // 라벨 배경 박스를 캔버스 (0,0) 꼭짓점에 딱 붙여 그리다 보니 그 둥근
    // 모서리에 좌상단 모서리가 걸려 잘려 보였다. 캔버스 모서리에서 살짝
    // 띄우고(margin) 배경 박스 자체도 둥글게 그려 라운드 처리와 시각적으로
    // 맞춘다.
    if (finishedAtRef.current) {
      const orientation = finishedOrientationRef.current ? ` (${finishedOrientationRef.current})` : "";
      const label = `공부합시당 캠스터디 화각 체커${orientation} - ${formatTimestamp(finishedAtRef.current)}`;
      const fontSize = Math.max(11, Math.round(h * 0.028));
      ctx.save();
      ctx.font = `${fontSize}px ui-monospace, "SFMono-Regular", monospace`;
      ctx.textBaseline = "top";
      const margin = Math.max(6, Math.round(fontSize * 0.5));
      const paddingX = fontSize * 0.6;
      const paddingY = fontSize * 0.45;
      const textWidth = ctx.measureText(label).width;
      const boxW = textWidth + paddingX * 2;
      const boxH = fontSize + paddingY * 2;
      const boxRadius = Math.min(8, boxH / 2);
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.beginPath();
      ctx.roundRect(margin, margin, boxW, boxH, boxRadius);
      ctx.fill();
      ctx.fillStyle = "#facc15";
      ctx.fillText(label, margin + paddingX, margin + paddingY);
      ctx.restore();
    }
  }

  function clearTimers() {
    if (captureTimerRef.current) {
      clearInterval(captureTimerRef.current);
      captureTimerRef.current = null;
    }
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    if (startCountdownTimerRef.current) {
      clearInterval(startCountdownTimerRef.current);
      startCountdownTimerRef.current = null;
    }
  }

  function finishSequence() {
    clearTimers();
    setIsCapturing(false);
    setIsFinished(true);
    finishedAtRef.current = new Date();
    finishedOrientationRef.current =
      typeof window !== "undefined" && window.matchMedia("(orientation: portrait)").matches
        ? "세로모드"
        : "가로모드";
    // 다음 렌더에서 resultCanvas가 표시된 뒤 그려야 하므로 마이크로태스크로 미룸
    requestAnimationFrame(renderOverlayResult);
  }

  // startCountdown 값이 실제로 바뀔 때만 그에 대응하는 부수효과를 정확히
  // 한 번 실행한다 — setInterval 콜백(위 startSequence)은 다음 숫자를
  // 계산만 하고, 그 숫자로 무엇을 할지(문구 갱신/카운트다운 종료 시 실촬영
  // 시작)는 여기서 처리해 React state updater 순수성 문제를 피한다.
  useEffect(() => {
    if (startCountdown === null) return;
    if (startCountdown <= 0) {
      if (startCountdownTimerRef.current) {
        clearInterval(startCountdownTimerRef.current);
        startCountdownTimerRef.current = null;
      }
      setStartCountdown(null);
      beginActualCapture();
      return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startCountdown]);

  function beginActualCapture() {
    setIsCapturing(true);
    setRemainingSec(INTERVAL_SEC);

    let shotsRemaining = TOTAL_SHOTS;

    // 첫 컷은 즉시 촬영
    const first = captureFrame();
    if (first) addShot(first);
    shotsRemaining--;
    setShotsLeft(shotsRemaining);

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
      setRemainingSec(INTERVAL_SEC);
      if (shotsRemaining <= 0) {
        finishSequence();
      }
    }, INTERVAL_SEC * 1000);
  }

  function startSequence() {
    capturedShotsRef.current = [];
    setThumbs([]);
    setIsFinished(false);
    setStartCountdown(START_COUNTDOWN_SEC);

    // 🔧 [버그 수정] setStartCountdown의 updater 함수 안에서
    // beginActualCapture()(캔버스 캡처+addShot 등 부수효과)를 직접 호출하고
    // 있었다 — React StrictMode는 개발 모드에서 상태 updater 함수의 순수성을
    // 검증하기 위해 그 콜백을 두 번 호출하는데(실제 상태 반영은 한 번),
    // updater 안에 부수효과가 있으면 그 부수효과도 그대로 두 번 실행된다.
    // 그 결과 사진이 매번 2장씩 겹쳐 찍혔다(사용자 발견: "왜 2장씩 보이는거지?").
    // 부수효과는 updater 밖, setInterval 콜백 몸체로 옮기고 updater는 다음
    // 카운트다운 값만 순수하게 계산해 반환한다.
    startCountdownTimerRef.current = setInterval(() => {
      setStartCountdown((prev) => (prev === null ? null : prev - 1));
    }, 1000);

    // 카운트다운 값이 실제로 몇으로 바뀌었는지는 다음 렌더의 useEffect에서
    // 관찰해 부수효과(문구 갱신/타이머 정리/실촬영 시작)를 딱 한 번만 실행한다.
  }

  // 🔧 [사용자 지시] "촬영 시작을 누르면 '초기화' 버튼이 되도록 해줘. 그리고
  // 초기화를 누르면 임시로 저장한 값은 모두 지워버려" — 기존 stopSequence는
  // 타이머만 멈추고 이미 찍힌 썸네일/캡처본은 남겨뒀는데, "초기화"라는
  // 이름에 맞게 진행 중이던 캡처를 완전히 백지 상태로 되돌린다.
  function stopSequence() {
    clearTimers();
    setStartCountdown(null);
    setIsCapturing(false);
    capturedShotsRef.current = [];
    finishedAtRef.current = null;
    finishedOrientationRef.current = null;
    setThumbs([]);
    setShotsLeft(TOTAL_SHOTS);
  }

  function resetSequence() {
    capturedShotsRef.current = [];
    finishedAtRef.current = null;
    finishedOrientationRef.current = null;
    setThumbs([]);
    setIsFinished(false);
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
    startCountdown,
    startSequence,
    stopSequence,
    resetSequence,
    downloadResult,
  };
}
