import { useRef } from "react";
import { Link } from "react-router-dom";
import { RotateCcw, RotateCw, Download, Camera, Video, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCamera } from "@/hooks/useCamera";
import { useFrameCapture } from "@/hooks/useFrameCapture";
import { useScreenRecording } from "@/hooks/useScreenRecording";
import { useFitViewfinder } from "@/hooks/useFitViewfinder";

const TOTAL_SHOTS = 6;

export function CheckerPage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const liveCanvasRef = useRef<HTMLCanvasElement>(null);
  const resultCanvasRef = useRef<HTMLCanvasElement>(null);
  const { containerRef, size } = useFitViewfinder();

  const camera = useCamera();
  const capture = useFrameCapture({
    videoRef: camera.videoRef,
    liveCanvasRef,
    resultCanvasRef,
    stageRef,
    setStatus: camera.setStatus,
  });
  const recording = useScreenRecording({ liveCanvasRef, setStatus: camera.setStatus });

  const isCountingDown = capture.startCountdown !== null;

  // 상호배제 규칙을 한 곳에서 파생 상태로 계산 — 산발적 disabled 토글 버그를 막기 위함
  const canSwitchCamera = !capture.isCapturing && !isCountingDown && !recording.isRecording;
  const canStartSequence = camera.isReady && !recording.isRecording && !isCountingDown;
  const canStartRecording = !capture.isCapturing && !isCountingDown;

  const mm = String(Math.floor(capture.remainingSec / 60)).padStart(2, "0");
  const ss = String(capture.remainingSec % 60).padStart(2, "0");
  const recMm = String(Math.floor(recording.remainingSec / 60)).padStart(2, "0");
  const recSs = String(recording.remainingSec % 60).padStart(2, "0");

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-3 landscape:min-w-0 landscape:flex-row landscape:gap-3">
      <header className="flex w-full page-content-wide items-baseline justify-between gap-3 landscape:hidden">
        <div className="flex flex-col gap-0.5">
          <Link to="/" className="font-mono text-xs uppercase tracking-widest text-primary sm:text-sm">
            Framing Check
          </Link>
          <h1 className="text-xl font-bold sm:text-2xl">프레임 체커</h1>
        </div>
        <div className="text-right font-mono text-[11px] leading-relaxed text-muted-foreground sm:text-sm">
          GRID 4×4
          <br />
          {TOTAL_SHOTS} FRAMES / 30s
        </div>
      </header>

      {/* 뷰파인더가 차지할 수 있는 남는 공간 전체 — ResizeObserver가 이 크기를 측정해
          16:9를 유지한 채 정확히 안에 맞는 px 크기를 계산한다. */}
      <div
        ref={containerRef}
        className="flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden landscape:h-full landscape:w-0 landscape:flex-1"
      >
        <div
          className="relative overflow-hidden rounded-lg bg-[#1b1d19] p-3.5 landscape:p-2"
          style={
            size
              ? { width: size.width, height: size.height }
              : { width: "100%", aspectRatio: "16/9" }
          }
        >
          <div ref={stageRef} className="relative size-full overflow-hidden rounded-sm bg-black">
            <video ref={camera.videoRef} autoPlay playsInline muted className="absolute inset-0 size-full object-cover" />
            <canvas
              ref={liveCanvasRef}
              className={cn("absolute inset-0 size-full object-cover pointer-events-none", capture.isFinished && "hidden")}
            />
            <canvas
              ref={resultCanvasRef}
              className={cn("absolute inset-0 size-full bg-black object-cover", !capture.isFinished && "hidden")}
            />

            {/* 코너 브래킷 */}
            {(["tl", "tr", "bl", "br"] as const).map((corner) => (
              <div
                key={corner}
                className={cn(
                  "pointer-events-none absolute z-6 size-4 border-2 border-[#eef0ea]/85 sm:size-5.5",
                  corner === "tl" && "top-2 left-2 border-r-0 border-b-0 sm:top-2.5 sm:left-2.5",
                  corner === "tr" && "top-2 right-2 border-l-0 border-b-0 sm:top-2.5 sm:right-2.5",
                  corner === "bl" && "bottom-2 left-2 border-r-0 border-t-0 sm:bottom-2.5 sm:left-2.5",
                  corner === "br" && "bottom-2 right-2 border-l-0 border-t-0 sm:bottom-2.5 sm:right-2.5"
                )}
              />
            ))}

            {/* HUD: 좌상단 REC 상태 */}
            <div className="absolute top-3.5 left-3.5 z-6 font-mono text-[11px] tracking-wide text-[#eef0ea] sm:top-4 sm:left-4 sm:text-sm" style={{ textShadow: "0 1px 3px rgba(0,0,0,0.8)" }}>
              <span className={cn("inline-flex items-center gap-1.5", (capture.isCapturing || recording.isRecording) && "text-destructive")}>
                <span
                  className={cn(
                    "size-1.75 rounded-full bg-muted-foreground sm:size-2",
                    (capture.isCapturing || recording.isRecording) && "bg-destructive animate-pulse motion-reduce:animate-none"
                  )}
                />
                {capture.isCapturing
                  ? `REC ${TOTAL_SHOTS - capture.shotsLeft}/${TOTAL_SHOTS}`
                  : recording.isRecording
                    ? `REC ${recMm}:${recSs}`
                    : "STANDBY"}
              </span>
            </div>

            {/* HUD: 우상단 카운트다운 (정지사진 모드에서만) */}
            {capture.isCapturing && (
              <div className="absolute top-3.5 right-3.5 z-6 text-right font-mono text-[11px] tracking-wide text-[#eef0ea] sm:top-4 sm:right-4 sm:text-sm" style={{ textShadow: "0 1px 3px rgba(0,0,0,0.8)" }}>
                <span className="font-mono text-sm font-semibold tabular-nums sm:text-lg">
                  {mm}:{ss}
                </span>
                NEXT FRAME
              </div>
            )}

            {/* HUD: 촬영 시작 전 카운트다운 오버레이 */}
            {isCountingDown && (
              <div className="absolute inset-0 z-7 flex items-center justify-center bg-black/40">
                <span
                  className="font-mono text-6xl font-bold text-[#eef0ea] tabular-nums sm:text-7xl"
                  style={{ textShadow: "0 2px 8px rgba(0,0,0,0.8)" }}
                >
                  {capture.startCountdown}
                </span>
              </div>
            )}

            {/* HUD: 좌하단 프레임 진행 틱 */}
            <div className="absolute bottom-3.5 left-3.5 z-6 flex gap-1">
              {Array.from({ length: TOTAL_SHOTS }).map((_, i) => (
                <div
                  key={i}
                  className={cn("h-0.75 w-3 rounded-xs bg-[#eef0ea]/30", i < capture.thumbs.length && "bg-primary")}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex w-full shrink-0 page-content-wide flex-col gap-3 landscape:h-full landscape:w-56 landscape:justify-center landscape:gap-2.5 landscape:overflow-y-auto">
        {capture.thumbs.length > 0 && (
          <div className="flex w-full gap-1.5 overflow-x-auto p-0.5 sm:gap-2 landscape:flex-wrap landscape:overflow-visible">
            {capture.thumbs.map((src, i) => (
              <img key={i} src={src} className="h-13 w-17 shrink-0 rounded-sm border object-cover sm:h-16 sm:w-21" alt={`촬영 ${i + 1}`} />
            ))}
          </div>
        )}

        {capture.isFinished && (
          <div className="flex items-center gap-3 rounded-md border bg-card p-2.5 sm:p-3.5">
            <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase whitespace-nowrap sm:text-xs">Overlay</span>
            <input
              type="range"
              min={0.1}
              max={0.8}
              step={0.05}
              value={capture.opacity}
              onChange={(e) => capture.setOpacity(parseFloat(e.target.value))}
              className="flex-1 accent-primary"
            />
          </div>
        )}

        <div className="flex flex-col gap-3 rounded-lg border bg-card p-3.5 sm:p-5 landscape:gap-2.5 landscape:p-3">
          {/* 주 액션 3버튼: 카메라 전환 / 스크린샷 촬영 / 영상 녹화 — 항상 동일 규격 */}
          <div className="flex items-center justify-center gap-3 sm:gap-4 landscape:flex-col landscape:gap-2.5">
            <button
              type="button"
              title="카메라 전환"
              aria-label="카메라 전환"
              disabled={!canSwitchCamera}
              onClick={camera.switchFacing}
              className="flex size-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-full border bg-card text-foreground disabled:opacity-40 sm:size-16"
            >
              <RotateCw className="size-5 sm:size-5.5" />
            </button>

            {!capture.isCapturing && !isCountingDown ? (
              <button
                type="button"
                title="스크린샷 촬영 (10초 후 시작)"
                aria-label="스크린샷 촬영"
                disabled={!canStartSequence}
                onClick={capture.startSequence}
                className="flex size-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-full border-2 border-primary bg-card text-primary disabled:opacity-40 sm:size-16"
              >
                <Camera className="size-5 sm:size-5.5" />
              </button>
            ) : (
              <button
                type="button"
                title={isCountingDown ? "촬영 취소" : "촬영 중지"}
                aria-label={isCountingDown ? "촬영 취소" : "촬영 중지"}
                onClick={capture.stopSequence}
                className="flex size-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-full border-2 border-destructive bg-card text-destructive sm:size-16"
              >
                {isCountingDown ? <X className="size-5 sm:size-5.5" /> : <Square className="size-4.5 fill-current sm:size-5" />}
              </button>
            )}

            {!recording.isRecording ? (
              <button
                type="button"
                title="화면 녹화 시작 (1분 30초)"
                aria-label="화면 녹화 시작"
                disabled={!canStartRecording}
                onClick={recording.startRecording}
                className="flex size-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-full border-2 border-destructive bg-card text-destructive disabled:opacity-40 sm:size-16"
              >
                <Video className="size-5 sm:size-5.5" />
              </button>
            ) : (
              <button
                type="button"
                title="녹화 중지"
                aria-label="녹화 중지"
                onClick={recording.stopRecording}
                className="flex size-14 shrink-0 animate-pulse flex-col items-center justify-center gap-0.5 rounded-full border-2 border-destructive bg-card text-destructive motion-reduce:animate-none sm:size-16"
              >
                <Square className="size-4.5 fill-current sm:size-5" />
              </button>
            )}
          </div>

          {/* 보조 버튼: 결과물이 있을 때만 표시 */}
          {(capture.isFinished || recording.recordedBlobUrl) && (
            <div className="flex items-center justify-center gap-2.5 border-t pt-3 sm:gap-3.5 landscape:flex-col landscape:gap-2">
              {capture.isFinished && (
                <>
                  <button
                    type="button"
                    title="다시 촬영"
                    aria-label="다시 촬영"
                    onClick={capture.resetSequence}
                    className="flex size-10 shrink-0 items-center justify-center rounded-full border bg-card sm:size-11"
                  >
                    <RotateCcw className="size-4 sm:size-4.5" />
                  </button>
                  <button
                    type="button"
                    title="이미지 저장"
                    aria-label="이미지 저장"
                    onClick={capture.downloadResult}
                    className="flex size-10 shrink-0 items-center justify-center rounded-full border bg-card sm:size-11"
                  >
                    <Download className="size-4 sm:size-4.5" />
                  </button>
                </>
              )}
              {recording.recordedBlobUrl && (
                <button
                  type="button"
                  title="영상 저장"
                  aria-label="영상 저장"
                  onClick={recording.downloadRecording}
                  className="flex size-10 shrink-0 items-center justify-center rounded-full border bg-card sm:size-11"
                >
                  <Download className="size-4 sm:size-4.5" />
                </button>
              )}
            </div>
          )}
        </div>

        <div className="min-h-4 text-center font-mono text-xs text-muted-foreground sm:text-sm">{camera.status}</div>
      </div>
    </div>
  );
}
