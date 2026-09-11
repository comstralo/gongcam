export function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.save();
  // 🔧 [사용자 지시] "격자를 좀 더 얇게" — lineWidth를 1→0.5로만 낮췄을 때는
  // 캔버스가 서브픽셀 선을 정수 좌표에 맞춰 안티앨리어싱하는 과정에서
  // 브라우저에 따라 1px과 거의 구분이 안 갔다(사용자 확인: "딱히 바뀐건지
  // 모르겠는데"). lineWidth는 1로 되돌리고 대신 불투명도를 확 낮춰(0.4→0.18)
  // 선 자체가 확실히 옅고 가늘어 보이게 한다 — 두께가 아니라 존재감을 줄이는
  // 방향.
  ctx.strokeStyle = "rgba(238,240,234,0.18)";
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
