import { useEffect, useRef, useState, type RefObject } from "react";

const RECORD_SEC = 90;

function pickRecorderMimeType(): string {
  const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return candidates.find((type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type)) || "";
}

export function useScreenRecording({
  liveCanvasRef,
  setStatus,
}: {
  liveCanvasRef: RefObject<HTMLCanvasElement | null>;
  setStatus: (status: string) => void;
}) {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [remainingSec, setRemainingSec] = useState(RECORD_SEC);
  const [recordedBlobUrl, setRecordedBlobUrl] = useState<string | null>(null);
  const recordedBlobUrlRef = useRef<string | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function setBlobUrl(url: string | null) {
    if (recordedBlobUrlRef.current) URL.revokeObjectURL(recordedBlobUrlRef.current);
    recordedBlobUrlRef.current = url;
    setRecordedBlobUrl(url);
  }

  function clearCountdown() {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }

  function stopRecording() {
    // isRecording state가 아니라 recorder 존재 여부로 판단한다.
    // setInterval 콜백 클로저가 startRecording 실행 시점(아직 isRecording=false)을
    // 캡처해서 state 체크가 항상 false로 나오는 것을 피하기 위함.
    if (!mediaRecorderRef.current) return;
    setIsRecording(false);
    clearCountdown();
    if (mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;
  }

  function startRecording() {
    const liveCanvas = liveCanvasRef.current;
    if (!liveCanvas || !liveCanvas.captureStream) {
      setStatus("이 브라우저는 화면 녹화를 지원하지 않습니다.");
      return;
    }
    setBlobUrl(null);
    recordedChunksRef.current = [];

    const canvasStream = liveCanvas.captureStream(30);
    const mimeType = pickRecorderMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(canvasStream, mimeType ? { mimeType } : undefined);
    } catch (err) {
      setStatus(`녹화를 시작할 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, { type: mimeType || "video/webm" });
      setBlobUrl(URL.createObjectURL(blob));
      setStatus(`녹화 완료 (${RECORD_SEC}초). 영상을 저장하세요.`);
    };

    mediaRecorderRef.current = recorder;
    recorder.start();
    setIsRecording(true);
    setRemainingSec(RECORD_SEC);
    setStatus(`화면 녹화 중... (${RECORD_SEC}초)`);

    countdownTimerRef.current = setInterval(() => {
      setRemainingSec((prev) => {
        const next = prev - 1;
        if (next <= 0) {
          // setState 콜백 내부에서 직접 stopRecording을 부르면 클로저가 stale해질 수 있어
          // 다음 틱에 정지 로직을 맡긴다.
          queueMicrotask(() => stopRecording());
        }
        return next;
      });
    }, 1000);
  }

  function downloadRecording() {
    if (!recordedBlobUrl) return;
    const link = document.createElement("a");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    link.download = `fov-check-recording-${ts}.webm`;
    link.href = recordedBlobUrl;
    link.click();
  }

  // 언마운트 시 타이머 정리 + blob URL 해제.
  // 원본 코드는 새 녹화 시작 시에만 이전 URL을 revoke했고 페이지 이탈 시 정리하지 않았다 — 메모리 누수 수정.
  useEffect(() => {
    return () => {
      clearCountdown();
      if (recordedBlobUrlRef.current) URL.revokeObjectURL(recordedBlobUrlRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { isRecording, remainingSec, recordedBlobUrl, startRecording, stopRecording, downloadRecording };
}
