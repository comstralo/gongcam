export function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.save();
  // 🔧 [사용자 지시 이력] "격자를 좀 더 얇게" → lineWidth 1, 불투명도만
  // 0.4→0.18로 낮췄더니 이번엔 "너무 희미해서 안 보인다"는 반대 피드백.
  // 선 두께(lineWidth: 1, 얇음)는 유지하되, 밝은 배경/어두운 배경 화면
  // 어디서나 인식되도록 회색 계열로 불투명도를 올리고 옅은 그림자로
  // 테두리 대비를 더해 존재감만 키운다 — 두께가 아니라 색/대비로 해결.
  ctx.strokeStyle = "rgba(148,148,148,0.55)";
  ctx.lineWidth = 1;
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 1;
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
