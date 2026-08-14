import { useEffect, useRef, useState } from "react";

export type FacingMode = "user" | "environment";

export function useCamera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<FacingMode>("user");
  const [status, setStatus] = useState("카메라를 시작하려면 브라우저 권한을 허용해주세요.");
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function startCamera() {
      // 카메라 전환 시 기존 스트림을 반드시 먼저 정지 (원본 코드와 동일한 동작)
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      setStatus("카메라 연결 중...");
      setIsReady(false);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setStatus("준비 완료. 촬영 시작을 누르세요.");
        setIsReady(true);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setStatus(`카메라 접근 실패: ${message} (다른 카메라로 전환해보세요)`);
        setIsReady(false);
      }
    }

    startCamera();

    // 언마운트(페이지 이탈) 시 스트림 정리 — 원본 정적 페이지에는 없던 부분.
    // SPA에서는 페이지 전환 시 카메라가 계속 켜진 채로 남는 걸 막기 위해 필요하다.
    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [facing]);

  function switchFacing() {
    setFacing((prev) => (prev === "user" ? "environment" : "user"));
  }

  return { videoRef, status, setStatus, isReady, switchFacing };
}
