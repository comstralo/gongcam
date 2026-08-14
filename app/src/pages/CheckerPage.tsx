import { useRef } from "react";
import { Link } from "react-router-dom";
import { RotateCcw, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCamera } from "@/hooks/useCamera";
import { useFrameCapture } from "@/hooks/useFrameCapture";
import { useScreenRecording } from "@/hooks/useScreenRecording";

const TOTAL_SHOTS = 6;

export function CheckerPage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const liveCanvasRef = useRef<HTMLCanvasElement>(null);
  const resultCanvasRef = useRef<HTMLCanvasElement>(null);

  const camera = useCamera();
  const capture = useFrameCapture({
    videoRef: camera.videoRef,
    liveCanvasRef,
    resultCanvasRef,
    stageRef,
    setStatus: camera.setStatus,
  });
  const recording = useScreenRecording({ liveCanvasRef, setStatus: camera.setStatus });

  // 상호배제 규칙을 한 곳에서 파생 상태로 계산 — 산발적 disabled 토글 버그를 막기 위함
  const canSwitchCamera = !capture.isCapturing && !recording.isRecording;
  const canStartSequence = camera.isReady && !recording.isRecording;
  const canStartRecording = !capture.isCapturing;

  const mm = String(Math.floor(capture.remainingSec / 60)).padStart(2, "0");
  const ss = String(capture.remainingSec % 60).padStart(2, "0");
  const recMm = String(Math.floor(recording.remainingSec / 60)).padStart(2, "0");
  const recSs = String(recording.remainingSec % 60).padStart(2, "0");

  return (
    <>
      <header className="flex w-full max-w-160 items-baseline justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <Link to="/" className="font-mono text-xs uppercase tracking-widest text-primary">
            Framing Check
          </Link>
          <h1 className="text-xl font-bold">프레임 체커</h1>
        </div>
        <div className="text-right font-mono text-[11px] leading-relaxed text-muted-foreground">
          GRID 4×4
          <br />
          {TOTAL_SHOTS} FRAMES / 30s
        </div>
      </header>

      <div className="relative w-full max-w-160 overflow-hidden rounded-lg bg-[#1b1d19] p-3.5" style={{ aspectRatio: "16/9" }}>
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
          <div className="absolute top-3.5 left-3.5 z-6 font-mono text-[11px] tracking-wide text-[#eef0ea]" style={{ textShadow: "0 1px 3px rgba(0,0,0,0.8)" }}>
            <span className={cn("inline-flex items-center gap-1.5", (capture.isCapturing || recording.isRecording) && "text-destructive")}>
              <span
                className={cn(
                  "size-1.75 rounded-full bg-muted-foreground",
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
            <div className="absolute top-3.5 right-3.5 z-6 text-right font-mono text-[11px] tracking-wide text-[#eef0ea]" style={{ textShadow: "0 1px 3px rgba(0,0,0,0.8)" }}>
              <span className="font-mono text-sm font-semibold tabular-nums">
                {mm}:{ss}
              </span>
              NEXT FRAME
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

      {capture.thumbs.length > 0 && (
        <div className="flex w-full max-w-160 gap-1.5 overflow-x-auto p-0.5">
          {capture.thumbs.map((src, i) => (
            <img key={i} src={src} className="h-13 w-17 shrink-0 rounded-sm border object-cover" alt={`촬영 ${i + 1}`} />
          ))}
        </div>
      )}

      <div className="flex w-full max-w-160 flex-col gap-3.5">
        {capture.isFinished && (
          <div className="flex items-center gap-3 rounded-md border bg-card p-2.5">
            <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase whitespace-nowrap">Overlay</span>
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

        <div className="flex flex-col gap-4 rounded-lg border bg-card p-4 sm:flex-row sm:items-stretch sm:gap-4.5">
          <div className="flex min-w-0 flex-1 flex-col items-center gap-3">
            <span className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase">Stills · 30s × 6</span>
            <div className="flex flex-wrap items-center justify-center gap-2.5">
              <button
                type="button"
                title="카메라 전환"
                aria-label="카메라 전환"
                disabled={!canSwitchCamera}
                onClick={camera.switchFacing}
                className="flex size-11 shrink-0 items-center justify-center rounded-full border bg-card text-lg disabled:opacity-40"
              >
                ⟲
              </button>

              {!capture.isCapturing ? (
                <button
                  type="button"
                  title="촬영 시작"
                  aria-label="촬영 시작"
                  disabled={!canStartSequence}
                  onClick={capture.startSequence}
                  className="relative size-15.5 shrink-0 rounded-full border-3 border-primary bg-card disabled:opacity-40"
                >
                  <span className="absolute inset-1.5 rounded-full bg-primary transition-all" />
                </button>
              ) : (
                <button
                  type="button"
                  title="중지"
                  aria-label="중지"
                  onClick={capture.stopSequence}
                  className="relative size-15.5 shrink-0 rounded-full border-3 border-destructive bg-card"
                >
                  <span className="absolute inset-5 rounded-sm bg-destructive transition-all" />
                </button>
              )}

              {capture.isFinished && (
                <>
                  <button
                    type="button"
                    title="다시 촬영"
                    aria-label="다시 촬영"
                    onClick={capture.resetSequence}
                    className="flex size-11 shrink-0 items-center justify-center rounded-full border bg-card text-lg"
                  >
                    <RotateCcw className="size-4" />
                  </button>
                  <button
                    type="button"
                    title="이미지 저장"
                    aria-label="이미지 저장"
                    onClick={capture.downloadResult}
                    className="flex size-11 shrink-0 items-center justify-center rounded-full border bg-card text-lg"
                  >
                    <Download className="size-4" />
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="h-px w-full bg-border sm:h-auto sm:w-px" />

          <div className="flex min-w-0 flex-1 flex-col items-center gap-3">
            <span className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase">Video · 1:30</span>
            <div className="flex flex-wrap items-center justify-center gap-2.5">
              {!recording.isRecording ? (
                <button
                  type="button"
                  title="화면 녹화 시작 (1분 30초)"
                  aria-label="화면 녹화 시작"
                  disabled={!canStartRecording}
                  onClick={recording.startRecording}
                  className="relative size-15.5 shrink-0 rounded-full border-3 border-destructive bg-card disabled:opacity-40"
                >
                  <span className="absolute inset-4.5 rounded-full bg-destructive" />
                </button>
              ) : (
                <button
                  type="button"
                  title="녹화 중지"
                  aria-label="녹화 중지"
                  onClick={recording.stopRecording}
                  className="relative size-15.5 shrink-0 animate-pulse rounded-full border-3 border-destructive bg-card motion-reduce:animate-none"
                >
                  <span className="absolute inset-5.5 rounded-sm bg-destructive" />
                </button>
              )}

              {recording.recordedBlobUrl && (
                <button
                  type="button"
                  title="영상 저장"
                  aria-label="영상 저장"
                  onClick={recording.downloadRecording}
                  className="flex size-11 shrink-0 items-center justify-center rounded-full border bg-card text-lg"
                >
                  <Download className="size-4" />
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="min-h-4 text-center font-mono text-xs text-muted-foreground">{camera.status}</div>
      </div>
    </>
  );
}
