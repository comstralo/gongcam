export function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.save();
  ctx.strokeStyle = "rgba(238,240,234,0.5)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const x = (w / 4) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    const y = (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.restore();
}

// object-fit: cover 방식으로 비디오/캔버스를 목표 크기에 맞춰 그리기 위한 소스 사각형 계산
export function computeCoverRect(sourceW: number, sourceH: number, targetW: number, targetH: number) {
  const scale = Math.max(targetW / sourceW, targetH / sourceH);
  const sw = targetW / scale;
  const sh = targetH / scale;
  const sx = (sourceW - sw) / 2;
  const sy = (sourceH - sh) / 2;
  return { sx, sy, sw, sh };
}
