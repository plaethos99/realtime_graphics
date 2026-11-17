/** A fake "web page" screenshot so the bench has something to point at before you capture a real one. */
export function drawSamplePage(width = 1280, height = 800): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  // Browser chrome
  ctx.fillStyle = '#e8e6e1';
  ctx.fillRect(0, 0, width, 64);
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, 140, 16, 640, 32, 16);
  ctx.fillStyle = '#6b6862';
  ctx.font = '15px system-ui, sans-serif';
  ctx.fillText('raspberrypi.example/documentation/camera', 160, 37);

  // Article
  ctx.fillStyle = '#1f1e1c';
  ctx.font = 'bold 34px system-ui, sans-serif';
  ctx.fillText('Raspberry Pi 5: camera setup', 64, 130);
  ctx.fillStyle = '#c7c3bb';
  for (let i = 0; i < 12; i++) roundRect(ctx, 64, 170 + i * 34, i % 4 === 3 ? 300 : 440, 12, 6);

  // Board photo
  const bx = 0.47 * width;
  const by = 0.3 * height;
  const bw = 0.34 * width;
  const bh = 0.38 * height;
  ctx.fillStyle = '#2f7d4a';
  roundRect(ctx, bx, by, bw, bh, 18);
  ctx.fillStyle = '#c9b458';
  for (let i = 0; i < 20; i++) ctx.fillRect(bx + 30 + i * 18, by + 14, 10, 10);
  ctx.fillStyle = '#5b5b5b';
  roundRect(ctx, bx + 40, by + 70, 90, 90, 6); // SoC
  ctx.fillStyle = '#9aa0a6';
  ctx.fillRect(bx + bw - 70, by + 60, 70, 60); // USB
  ctx.fillRect(bx + bw - 70, by + 150, 70, 60);
  // Camera connector, centred near (0.60, 0.47)
  ctx.fillStyle = '#e9e4d8';
  ctx.fillRect(0.6 * width - 40, 0.47 * height - 9, 80, 18);
  ctx.fillStyle = '#1f1e1c';
  ctx.font = '13px system-ui, sans-serif';
  ctx.fillText('CAM/DISP 0', 0.6 * width - 34, 0.47 * height + 28);

  ctx.fillStyle = '#6b6862';
  ctx.font = '14px system-ui, sans-serif';
  ctx.fillText('Figure 1. Raspberry Pi 5 board', bx, by + bh + 26);

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}
