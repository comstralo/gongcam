import { useEffect, useRef, useState } from "react";
import { Crop, Grid3x3, RotateCcw, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// 캔버스의 HTML width/height(내부 픽셀 버퍼)와 CSS 표시 크기를 항상 정확히
// 동일한 숫자로 고정한다(px 단위 인라인 style). 브라우저가 캔버스를 CSS로
// 확대/축소하지 않으므로, getBoundingClientRect() 기반 비율 계산이 전혀
// 필요 없다 — 화면 좌표(clientX/Y - 캔버스 위치)가 곧 캔버스 내부 좌표다.
// 이전에는 max-w-full로 캔버스를 CSS 축소 표시하면서 매 렌더마다
// boundRect.width/canvas.width 비율로 오버레이 위치를 환산했는데, 그 비율이
// 조금이라도 어긋나면(레이아웃 타이밍, 서브픽셀 반올림 등) 크롭 사각형과
// 핸들이 실제 이미지 가장자리에서 점점 안쪽으로 밀려 보이는 문제가 있었다.
// 좌표계를 원천적으로 하나로 통일해 그 오차 가능성 자체를 없앤다.
// 폭 상한은 고정값이 아니라 실제 모달 콘텐츠 폭을 런타임에 측정해 정한다
// (DISPLAY_MAX_WIDTH_FALLBACK은 측정 전 최초 프레임에만 쓰이는 안전값).
const DISPLAY_MAX_WIDTH_FALLBACK = 360;
const DISPLAY_MAX_HEIGHT = 420;
const MIN_CROP_SIZE = 20;
const MOSAIC_BLOCK_SIZE = 12;
const DEFAULT_BRUSH_SIZE = 24;
const MIN_BRUSH_SIZE = 10;
const MAX_BRUSH_SIZE = 60;
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
// 트랙패드 핀치(wheel + ctrlKey)의 deltaY 값은 브라우저마다 스케일이 달라
// 그대로 곱하면 너무 빠르거나 느리다 — 경험적으로 완만한 배율.
const ZOOM_WHEEL_SENSITIVITY = 0.01;
// 마우스 사용자를 위한 +/- 버튼 클릭당 배율 증감폭.
const MOUSE_ZOOM_STEP = 0.5;

type Tool = "crop" | "mosaic";
type CornerName = "tl" | "tr" | "bl" | "br";

type Rect = { x: number; y: number; w: number; h: number };
type Point = { x: number; y: number };
type Size = { w: number; h: number };

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("이미지를 읽지 못했습니다."));
    };
    img.src = url;
  });
}

// 모자이크 붓 크기를 그대로 반영한 원형 커서를 SVG data URI로 만든다.
// CSS cursor는 고정 아이콘만 지원해 브러시 크기를 동적으로 보여줄 수
// 없으므로, 크기가 바뀔 때마다 그 크기의 원을 그린 커서 이미지를 새로
// 만들어 cursor: url(...) x y로 지정한다("x y"는 커서 이미지 안에서 실제
// 클릭 지점이 되는 좌표 — 원의 중심으로 맞춰야 실제 칠해지는 위치와
// 커서가 가리키는 위치가 일치한다).
function mosaicCursor(size: number): string {
  const r = size / 2;
  // 안쪽은 반투명 흰색으로 채워 어두운 배경에서도 보이게 하고, 테두리는
  // 진한 색 두 겹(흰/검)으로 둘러 밝은 배경에서도 항상 식별되게 한다.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<circle cx="${r}" cy="${r}" r="${r - 1.5}" fill="rgba(255,255,255,0.25)" stroke="black" stroke-width="1"/>` +
    `<circle cx="${r}" cy="${r}" r="${r - 0.5}" fill="none" stroke="white" stroke-width="1"/>` +
    `</svg>`;
  const encoded = encodeURIComponent(svg);
  return `url("data:image/svg+xml,${encoded}") ${r} ${r}, crosshair`;
}

function cornerPoints(rect: Rect): Record<CornerName, Point> {
  return {
    tl: { x: rect.x, y: rect.y },
    tr: { x: rect.x + rect.w, y: rect.y },
    bl: { x: rect.x, y: rect.y + rect.h },
    br: { x: rect.x + rect.w, y: rect.y + rect.h },
  };
}

// 붓 중심(cx, cy) 주변 반경 radius 내부를 블록 단위로 다운샘플링해 픽셀화한다.
// 판정 기준을 커서에 그려 보여주는 원 크기와 정확히 맞추기 위해, 블록
// "중심"이 아니라 블록이 원과 조금이라도 겹치는지(블록의 가장 가까운
// 지점까지 거리)로 판단한다 — 중심 기준으로 반경에 블록 반개만큼 여유를
// 더 주던 이전 방식은 실제로 칠해지는 범위가 커서보다 한 블록만큼 더
// 넓어 보이는 원인이었다.
function applyMosaicBrush(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number) {
  const canvas = ctx.canvas;
  const left = Math.max(0, Math.floor((cx - radius) / MOSAIC_BLOCK_SIZE) * MOSAIC_BLOCK_SIZE);
  const top = Math.max(0, Math.floor((cy - radius) / MOSAIC_BLOCK_SIZE) * MOSAIC_BLOCK_SIZE);
  const right = Math.min(canvas.width, Math.ceil((cx + radius) / MOSAIC_BLOCK_SIZE) * MOSAIC_BLOCK_SIZE);
  const bottom = Math.min(canvas.height, Math.ceil((cy + radius) / MOSAIC_BLOCK_SIZE) * MOSAIC_BLOCK_SIZE);

  for (let by = top; by < bottom; by += MOSAIC_BLOCK_SIZE) {
    for (let bx = left; bx < right; bx += MOSAIC_BLOCK_SIZE) {
      // 블록(정사각형) 위에서 원 중심에 가장 가까운 점까지의 거리.
      const nearestX = Math.max(bx, Math.min(cx, bx + MOSAIC_BLOCK_SIZE));
      const nearestY = Math.max(by, Math.min(cy, by + MOSAIC_BLOCK_SIZE));
      const dist = Math.hypot(nearestX - cx, nearestY - cy);
      if (dist > radius) continue;

      const bw = Math.min(MOSAIC_BLOCK_SIZE, canvas.width - bx);
      const bh = Math.min(MOSAIC_BLOCK_SIZE, canvas.height - by);
      if (bw <= 0 || bh <= 0) continue;
      const { data } = ctx.getImageData(bx, by, bw, bh);
      let r = 0;
      let g = 0;
      let b = 0;
      const count = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
      }
      ctx.fillStyle = `rgb(${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)})`;
      ctx.fillRect(bx, by, bw, bh);
    }
  }
}

// 증빙 이미지 편집 모달 — 파일 선택 즉시 열린다.
// 자르기: 처음엔 이미지 전체가 크롭 영역이고, 네 모서리 핸들을 드래그해
// 안쪽으로 줄인다("적용"을 눌러야 실제로 잘라낸다).
// 모자이크: 붓으로 문지른 자리를 픽셀화한다. 문지르기 한 번(포인터
// down~up)마다 이전 상태를 스택에 쌓아 "되돌리기"로 한 단계씩 취소할 수 있다.
export function ImageEditDialog({
  file,
  onConfirm,
  onCancel,
}: {
  file: File | null;
  onConfirm: (file: File) => void;
  onCancel: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // 편집 영역(패딩 뺀 다이얼로그 콘텐츠 폭)을 실측해 캔버스 표시 폭 상한으로
  // 쓴다. 모달은 max-w-md에 좌우 패딩까지 있어 고정값(예: 420px)이 실제
  // 사용 가능 폭보다 넓을 수 있고, 그러면 캔버스가 모달 밖으로 삐져나가
  // 가로 스크롤이 생겼다.
  const measureRef = useRef<HTMLDivElement>(null);
  // 뷰포트(overflow-hidden 창) — wheel 리스너를 여기 직접(네이티브,
  // passive:false로) 붙인다. React의 onWheel prop은 브라우저에 따라
  // preventDefault()가 제대로 안 먹혀, macOS 트랙패드 핀치 시 이 편집
  // 캔버스가 아니라 브라우저 페이지 전체가 함께 확대되는 문제가 있었다.
  const viewportRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<Tool>("crop");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [canvasSize, setCanvasSize] = useState<Size | null>(null);
  const canvasSizeRef = useRef(canvasSize);
  canvasSizeRef.current = canvasSize;

  // --- 확대/축소(줌) & 이동(팬) ---
  // 캔버스의 내부 픽셀 좌표계(canvasSize, cropRect 등)는 절대 건드리지 않고,
  // 오직 "화면에 얼마나 크게 · 어디를 보여줄지"만 CSS transform으로 다룬다.
  // 이전에 캔버스를 CSS로 축소 표시했다가 좌표 오차가 반복됐던 경험 때문에,
  // 이번엔 zoom/pan을 하나의 상태로 모으고 좌표 변환도 getCanvasPos
  // 한 곳에서만 하도록 통일한다.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });

  function clampPan(nextPan: Point, nextZoom: number): Point {
    const size = canvasSizeRef.current;
    if (!size) return nextPan;
    // 확대된 캔버스가 뷰포트보다 커진 만큼만 팬 가능 — 그 이상은 여백만
    // 보이게 되므로 캔버스 가장자리에서 막는다.
    const scaledW = size.w * nextZoom;
    const scaledH = size.h * nextZoom;
    const maxPanX = Math.max(0, (scaledW - size.w) / 2);
    const maxPanY = Math.max(0, (scaledH - size.h) / 2);
    return {
      x: Math.max(-maxPanX, Math.min(maxPanX, nextPan.x)),
      y: Math.max(-maxPanY, Math.min(maxPanY, nextPan.y)),
    };
  }

  // +/- 버튼 전용 — 트랙패드 핀치(wheel)와 별개로 마우스 사용자를 위해
  // 고정 배율만큼 줌을 바꾼다. wheel 핸들러의 계산 로직과 동일하게 맞춰
  // 두 입력 방식이 항상 같은 clampPan 규칙을 따르게 한다.
  function applyZoomDelta(delta: number) {
    setZoom((prev) => {
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev + delta));
      setPan((prevPan) => clampPan(prevPan, next));
      return next;
    });
  }

  // 뷰포트에 네이티브 wheel 리스너를 { passive: false }로 붙여야
  // preventDefault()가 확실히 먹힌다 — React onWheel prop만으로는 브라우저에
  // 따라 macOS 트랙패드 핀치가 이 캔버스가 아니라 브라우저 페이지 전체
  // 확대로 새어나가는 문제가 있었다.
  // 🔧 [등록 타이밍 버그] 의존성 배열을 []로 두면 컴포넌트가 처음
  // 마운트되는 시점(Dialog가 아직 닫혀 있어 이 콘텐츠가 DOM에 없는 시점)에만
  // 한 번 실행되어 viewportRef.current가 항상 null이었다 — 이후 실제로
  // 모달이 열려도 리스너가 다시 등록되지 않아 핀치가 전혀 안 먹혔다.
  // canvasSize가 채워지는 시점(=캔버스와 뷰포트가 실제로 DOM에 존재하는
  // 시점)마다 재등록해야 한다.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      if (e.ctrlKey) {
        // 트랙패드 핀치는 wheel 이벤트에 ctrlKey=true로 전달된다(핀치 확대
        // 시 deltaY<0, 축소 시 deltaY>0인 브라우저 관례를 따른다).
        setZoom((prev) => {
          const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev - e.deltaY * ZOOM_WHEEL_SENSITIVITY));
          setPan((prevPan) => clampPan(prevPan, next));
          return next;
        });
      } else {
        // 두 손가락 드래그(스크롤) — 확대 상태일 때만 의미가 있으므로
        // zoom<=1이면 무시한다.
        setZoom((currentZoom) => {
          if (currentZoom > MIN_ZOOM) {
            setPan((prevPan) => clampPan({ x: prevPan.x - e.deltaX, y: prevPan.y - e.deltaY }, currentZoom));
          }
          return currentZoom;
        });
      }
    }

    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [canvasSize]);

  function resetZoom() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  // 자르기 상태
  const [cropRect, setCropRect] = useState<Rect | null>(null);
  const draggingCornerRef = useRef<CornerName | null>(null);
  const cropRectRef = useRef(cropRect);
  cropRectRef.current = cropRect;

  // 모자이크 상태
  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH_SIZE);
  const isPaintingRef = useRef(false);
  const strokeSnapshotRef = useRef<ImageData | null>(null);
  const [undoStack, setUndoStack] = useState<ImageData[]>([]);

  const open = !!file;

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    setLoadError(null);
    setTool("crop");
    setUndoStack([]);
    resetZoom();
    loadImage(file)
      .then((img) => {
        if (cancelled) return;
        imgRef.current = img;
        drawFresh(img);
      })
      .catch(() => {
        if (!cancelled) setLoadError("이미지를 불러오지 못했습니다.");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  // 이미지가 로드된 뒤 canvas 엘리먼트가 실제로 그 크기로 커밋된 다음에
  // 그려야, drawImage 호출 시점에 canvas.width/height가 확실히 최신값이다.
  useEffect(() => {
    if (!canvasSize || !imgRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.drawImage(imgRef.current, 0, 0, canvasSize.w, canvasSize.h);
  }, [canvasSize]);

  function drawFresh(img: HTMLImageElement) {
    // measureRef 자신에게 p-3(양쪽 12px)이 있으므로, 그 padding을 뺀 값이
    // 실제로 캔버스가 차지할 수 있는 최대 폭이다.
    const measured = measureRef.current;
    const maxWidth = measured ? measured.clientWidth - 24 : DISPLAY_MAX_WIDTH_FALLBACK;
    const scale = Math.min(1, maxWidth / img.naturalWidth, DISPLAY_MAX_HEIGHT / img.naturalHeight);
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    setCanvasSize({ w, h });
    setCropRect({ x: 0, y: 0, w, h });
    setUndoStack([]);
  }

  // 확대(zoom)가 없을 때는 캔버스 width/height 속성과 CSS 표시 크기가 같은
  // 숫자라 비율 변환이 필요 없었지만, 이제 캔버스에 CSS transform: scale()이
  // 걸릴 수 있다. getBoundingClientRect()는 transform 적용 후의 실제 화면
  // 크기를 정확히 돌려주므로, "실제 표시 크기 / 캔버스 내부 크기"를 그
  // 자리에서 구해 나누면 zoom 상태값을 따로 참조하지 않고도 항상 정확한
  // 캔버스 내부 좌표를 얻는다(줌 값 자체의 오차가 좌표에 전혀 영향을 못
  // 준다).
  function getCanvasPos(clientX: number, clientY: number): Point {
    const canvas = canvasRef.current;
    if (!canvas || !canvasSize) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / canvasSize.w;
    const scaleY = rect.height / canvasSize.h;
    return {
      x: Math.max(0, Math.min(canvasSize.w, (clientX - rect.left) / scaleX)),
      y: Math.max(0, Math.min(canvasSize.h, (clientY - rect.top) / scaleY)),
    };
  }
  // --- 자르기: 모서리 핸들 드래그 ---
  // 핸들 <div> 자체에서 포인터를 잡고, move/up은 window에서 추적한다(포인터가
  // 빠르게 움직여 핸들 밖으로 나가도 드래그가 끊기지 않도록).
  function handleCropHandleDown(corner: CornerName) {
    return (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      // 포인터를 핸들 자신에게 캡처해, 드래그 중 포인터가 캔버스/모달 밖
      // (다이얼로그 백드롭 등)으로 나가도 그 아래 엘리먼트가 클릭 이벤트를
      // 받지 않게 한다 — 이걸 안 하면 백드롭이 "바깥 클릭"으로 오인해
      // 모달이 닫혀버렸다.
      e.currentTarget.setPointerCapture(e.pointerId);
      draggingCornerRef.current = corner;
    };
  }

  useEffect(() => {
    function handleMove(e: PointerEvent) {
      const corner = draggingCornerRef.current;
      const rect = cropRectRef.current;
      if (!corner || !rect || !canvasSize) return;
      const pos = getCanvasPos(e.clientX, e.clientY);

      // 드래그 중인 모서리는 움직이고, 그 대각선 반대 모서리는 고정한다.
      const fixed =
        corner === "tl"
          ? { x: rect.x + rect.w, y: rect.y + rect.h }
          : corner === "tr"
            ? { x: rect.x, y: rect.y + rect.h }
            : corner === "bl"
              ? { x: rect.x + rect.w, y: rect.y }
              : { x: rect.x, y: rect.y };

      const clampedX = Math.max(0, Math.min(canvasSize.w, pos.x));
      const clampedY = Math.max(0, Math.min(canvasSize.h, pos.y));

      let x = Math.min(fixed.x, clampedX);
      let w = Math.abs(fixed.x - clampedX);
      let y = Math.min(fixed.y, clampedY);
      let h = Math.abs(fixed.y - clampedY);

      if (w < MIN_CROP_SIZE) w = MIN_CROP_SIZE;
      if (h < MIN_CROP_SIZE) h = MIN_CROP_SIZE;
      x = Math.min(x, canvasSize.w - w);
      y = Math.min(y, canvasSize.h - h);

      setCropRect({ x, y, w, h });
    }

    function handleUp() {
      draggingCornerRef.current = null;
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasSize]);

  function applyCrop() {
    const canvas = canvasRef.current;
    if (!canvas || !cropRect || !canvasSize) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (cropRect.w >= canvasSize.w && cropRect.h >= canvasSize.h && cropRect.x === 0 && cropRect.y === 0) return;
    const cropped = ctx.getImageData(
      Math.round(cropRect.x),
      Math.round(cropRect.y),
      Math.round(cropRect.w),
      Math.round(cropRect.h)
    );
    const newSize = { w: cropped.width, h: cropped.height };
    // canvas 크기를 먼저 바꾸면 getImageData로 뽑아둔 cropped 픽셀이 유지된
    // 채로, 다음 페인트에서 putImageData로 그대로 옮겨 그린다.
    canvas.width = newSize.w;
    canvas.height = newSize.h;
    ctx.putImageData(cropped, 0, 0);
    setCanvasSize(newSize);
    setCropRect({ x: 0, y: 0, w: newSize.w, h: newSize.h });
    setUndoStack([]);
  }

  // --- 모자이크: 붓으로 문지르기 ---
  // 포인터를 캔버스에 캡처(setPointerCapture)하면 이후 pointermove/pointerup/
  // pointercancel은 항상 캔버스로만 전달되지만, pointerleave/pointerenter는
  // 캡처와 무관하게 실제 커서 위치 기준으로 계속 발생한다(Pointer Events
  // 스펙). 문지르는 도중 커서가 캔버스 경계를 살짝 넘나들 때마다 leave가
  // 발동해 스트로크가 조각조각 끊기면서 상태가 꼬였던 게 "되돌리기가 전혀
  // 안 먹힌다"는 증상의 원인으로 보인다 — 캡처가 걸려 있는 한 leave로 굳이
  // 끝낼 필요가 없으므로 up/cancel에서만 스트로크를 마무리한다.
  function handleMosaicPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    isPaintingRef.current = true;
    // 이 스트로크 시작 전 상태를 되돌리기용으로 저장한다.
    strokeSnapshotRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pos = getCanvasPos(e.clientX, e.clientY);
    applyMosaicBrush(ctx, pos.x, pos.y, brushSize / 2);
  }

  function handleMosaicPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!isPaintingRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    const pos = getCanvasPos(e.clientX, e.clientY);
    applyMosaicBrush(ctx, pos.x, pos.y, brushSize / 2);
  }

  function finishMosaicStroke() {
    if (!isPaintingRef.current) return;
    isPaintingRef.current = false;
    const snapshot = strokeSnapshotRef.current;
    strokeSnapshotRef.current = null;
    if (snapshot) {
      setUndoStack((prev) => [...prev, snapshot]);
    }
  }

  function handleUndo() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || undoStack.length === 0) return;
    const prevState = undoStack[undoStack.length - 1];
    ctx.putImageData(prevState, 0, 0);
    setUndoStack((prev) => prev.slice(0, -1));
  }

  function handleReset() {
    if (imgRef.current) drawFresh(imgRef.current);
  }

  function handleConfirm() {
    const canvas = canvasRef.current;
    if (!canvas || !file) return;
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        onConfirm(new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" }));
      },
      "image/jpeg",
      0.92
    );
  }

  const pointerHandlers =
    tool === "mosaic"
      ? {
          onPointerDown: handleMosaicPointerDown,
          onPointerMove: handleMosaicPointerMove,
          onPointerUp: finishMosaicStroke,
          // 터치 디바이스에서 브라우저가 스크롤/줌 제스처로 판단하면 pointerup
          // 대신 pointercancel이 발생해 스트로크가 undoStack에 안 쌓이는 채로
          // 끊길 수 있다 — 같은 마무리 로직을 태워 스택에 반드시 반영한다.
          onPointerCancel: finishMosaicStroke,
        }
      : {};

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Crop className="size-4 text-primary sm:size-5" />
            이미지 편집
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {loadError && <p className="text-center text-xs text-destructive sm:text-sm">{loadError}</p>}

          {/* 핸들이 캔버스 모서리 바로 위에 오므로, 잘려 보이지 않도록 여백을
              둔다. 캔버스 width/height 속성과 style의 px 크기를 canvasSize로
              정확히 통일해 브라우저가 별도로 스케일링하지 않게 한다 —
              오버레이(크롭 사각형/핸들)도 같은 canvasSize 좌표계를 그대로
              쓰므로 항상 정확히 겹친다. measureRef는 w-full 블록이라 항상
              "다이얼로그 콘텐츠의 실제 사용 가능 폭"을 그대로 갖는다(안쪽의
              relative 박스는 flex+justify-center라 캔버스 크기에 맞춰
              줄어들므로 그걸로는 측정할 수 없다). */}
          <div ref={measureRef} className="flex w-full justify-center p-3">
            {/* 뷰포트 — overflow-hidden 창. 크기는 항상 canvasSize(줌 1일 때
                기준)로 고정해, 확대해도 레이아웃(모달 높이 등)이 흔들리지
                않는다. 그 안의 relative 박스만 transform: scale + translate로
                확대·이동한다 — 캔버스 자체의 width/height 속성과 canvasSize
                좌표계는 전혀 건드리지 않으므로 크롭/모자이크 좌표 계산은
                그대로 유효하고, getCanvasPos만 실제 화면 크기(전개된
                getBoundingClientRect)를 기준으로 역산해 정확한 위치를 찾는다. */}
            <div
              ref={viewportRef}
              className="relative overflow-hidden rounded-lg"
              style={canvasSize ? { width: canvasSize.w, height: canvasSize.h } : undefined}
            >
              <div
                className="absolute top-0 left-0"
                style={
                  canvasSize
                    ? {
                        width: canvasSize.w,
                        height: canvasSize.h,
                        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                        transformOrigin: "center center",
                      }
                    : undefined
                }
              >
                <div className="pointer-events-none absolute inset-0 -z-10 border bg-muted" aria-hidden />
                {canvasSize && (
                  <canvas
                    ref={canvasRef}
                    width={canvasSize.w}
                    height={canvasSize.h}
                    className="block"
                    style={{
                      width: canvasSize.w,
                      height: canvasSize.h,
                      touchAction: "none",
                      cursor: tool === "mosaic" ? mosaicCursor(brushSize) : undefined,
                    }}
                    {...pointerHandlers}
                  />
                )}
                {tool === "crop" && cropRect && (
                  <div
                    className="pointer-events-none absolute border-2 border-primary"
                    style={{ left: cropRect.x, top: cropRect.y, width: cropRect.w, height: cropRect.h }}
                    aria-hidden
                  />
                )}
                {tool === "crop" &&
                  cropRect &&
                  (Object.entries(cornerPoints(cropRect)) as [CornerName, Point][]).map(([name, p]) => (
                    <div
                      key={name}
                      onPointerDown={handleCropHandleDown(name)}
                      className="absolute z-10 flex size-9 touch-none items-center justify-center sm:size-10"
                      style={{
                        left: p.x,
                        top: p.y,
                        // 핸들 히트박스/원은 화면상 항상 같은 크기로 보이게,
                        // 캔버스가 확대된 배율만큼 역으로 축소해 보정한다
                        // (그러지 않으면 확대할수록 핸들도 함께 커진다).
                        transform: `translate(-50%, -50%) scale(${1 / zoom})`,
                        cursor: name === "tl" || name === "br" ? "nwse-resize" : "nesw-resize",
                      }}
                    >
                      <div className="size-5 rounded-full border-2 border-card bg-primary shadow-md sm:size-6" />
                    </div>
                  ))}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-7 sm:size-8"
                onClick={() => applyZoomDelta(-MOUSE_ZOOM_STEP)}
                disabled={zoom <= MIN_ZOOM}
              >
                <ZoomOut className="size-3.5 sm:size-4" />
              </Button>
              <span className="w-10 text-center text-micro-lg text-muted-foreground sm:text-xs">
                {Math.round(zoom * 100)}%
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-7 sm:size-8"
                onClick={() => applyZoomDelta(MOUSE_ZOOM_STEP)}
                disabled={zoom >= MAX_ZOOM}
              >
                <ZoomIn className="size-3.5 sm:size-4" />
              </Button>
            </div>
            {zoom > 1 && (
              <Button type="button" variant="ghost" size="sm" className="gap-1 text-micro-lg sm:text-xs" onClick={resetZoom}>
                <RotateCcw className="size-3 sm:size-3.5" />
                확대 초기화
              </Button>
            )}
          </div>
          <p className="text-center text-micro-lg text-muted-foreground sm:text-xs">
            트랙패드로 꼬집듯이(핀치) 확대·축소, 두 손가락으로 드래그해 이동할 수 있습니다. 마우스는 +/- 버튼으로 확대할 수 있습니다.
          </p>

          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={tool === "crop" ? "default" : "outline"}
              className="gap-1.5 sm:h-11"
              onClick={() => setTool("crop")}
            >
              <Crop className="size-3.5 sm:size-4" />
              자르기
            </Button>
            <Button
              type="button"
              variant={tool === "mosaic" ? "default" : "outline"}
              className="gap-1.5 sm:h-11"
              onClick={() => setTool("mosaic")}
            >
              <Grid3x3 className="size-3.5 sm:size-4" />
              모자이크
            </Button>
          </div>

          {tool === "crop" && (
            <p className="text-center text-micro-lg text-muted-foreground sm:text-xs">
              모서리를 드래그해 남길 영역을 조정한 뒤 적용하세요.
            </p>
          )}

          {tool === "mosaic" && (
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2">
                <span className="shrink-0 text-micro-lg text-muted-foreground sm:text-xs">붓 크기</span>
                <input
                  type="range"
                  min={MIN_BRUSH_SIZE}
                  max={MAX_BRUSH_SIZE}
                  value={brushSize}
                  onChange={(e) => setBrushSize(Number(e.target.value))}
                  className="flex-1"
                />
                {/* 실제 문지를 때 캔버스에 찍히는 크기(brushSize px)를 그대로
                    보여주는 미리보기 원. 최대 크기(MAX_BRUSH_SIZE)만큼의
                    고정 박스 안에 중앙 정렬해, 크기가 바뀌어도 옆 레이아웃이
                    흔들리지 않게 한다. */}
                <div
                  className="flex shrink-0 items-center justify-center"
                  style={{ width: MAX_BRUSH_SIZE, height: MAX_BRUSH_SIZE }}
                >
                  <div
                    className="rounded-full bg-primary/70"
                    style={{ width: brushSize, height: brushSize }}
                    aria-hidden
                  />
                </div>
              </label>
              <p className="text-center text-micro-lg text-muted-foreground sm:text-xs">
                가리고 싶은 부분을 손가락(또는 마우스)으로 문질러주세요.
              </p>
            </div>
          )}

          {tool === "crop" ? (
            <Button type="button" variant="secondary" className="sm:h-11" onClick={applyCrop}>
              자르기 적용
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              className="gap-1.5 sm:h-11"
              disabled={undoStack.length === 0}
              onClick={handleUndo}
            >
              <Undo2 className="size-3.5 sm:size-4" />
              되돌리기
            </Button>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" className="gap-1.5 sm:h-11" onClick={handleReset}>
              <RotateCcw className="size-3.5 sm:size-4" />
              초기화
            </Button>
            <Button type="button" className={cn("sm:h-11")} onClick={handleConfirm}>
              완료
            </Button>
          </div>

          <Button type="button" variant="ghost" className="text-xs sm:text-sm" onClick={onCancel}>
            취소
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
