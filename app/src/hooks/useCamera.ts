import { useEffect, useRef, useState } from "react";

export type FacingMode = "user" | "environment";

export function useCamera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<FacingMode>("user");
  const [isReady, setIsReady] = useState(false);
  // 전면 카메라는 거울처럼 보이는 게 자연스러워 기본 ON, 후면은 기본 OFF.
  // 카메라를 전환할 때마다 그 방향의 관례적인 기본값으로 재설정된다.
  const [mirrored, setMirrored] = useState(true);
  // 🔧 [사용자 지시] "이 페이지에 들어오자마자 자동으로 카메라를 켜지마" —
  // 기존엔 마운트되자마자 getUserMedia를 호출해 권한 프롬프트가 곧바로
  // 떴다. enabled를 기본 false로 두고, 사용자가 새로 생긴 "카메라 켜기"
  // 버튼을 눌러야만 스트림을 시작한다.
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!enabled) {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      setIsReady(false);
      return;
    }

    let cancelled = false;

    async function startCamera() {
      // 카메라 전환 시 기존 스트림을 반드시 먼저 정지 (원본 코드와 동일한 동작)
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
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
        setIsReady(true);
      } catch {
        if (cancelled) return;
        setIsReady(false);
      }
    }

    startCamera();

    // 언마운트(페이지 이탈)나 꺼짐 시 스트림 정리 — 원본 정적 페이지에는 없던 부분.
    // SPA에서는 페이지 전환 시 카메라가 계속 켜진 채로 남는 걸 막기 위해 필요하다.
    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [facing, enabled]);

  function switchFacing() {
    setFacing((prev) => {
      const next = prev === "user" ? "environment" : "user";
      setMirrored(next === "user");
      return next;
    });
  }

  function toggleMirror() {
    setMirrored((prev) => !prev);
  }

  function toggleCamera() {
    setEnabled((prev) => !prev);
  }

  return { videoRef, isReady, switchFacing, facing, mirrored, toggleMirror, enabled, toggleCamera };
}
