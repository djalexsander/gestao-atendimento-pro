import type { RasterSurface, SurfaceFactory } from "./core/labels/labelRaster.ts";

// Superfície de desenho das etiquetas sobre <canvas> (WebView2). Texto com o motor do navegador; barras em retângulos
// inteiros (sem anti-aliasing). A conversão final é por LIMIAR (luminância < 128 = preto): bitmap puro de 1 bit.
export const canvasSurface: SurfaceFactory = (widthPx, heightPx): RasterSurface => {
  const canvas = document.createElement("canvas");
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Não foi possível preparar o desenho da etiqueta.");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, widthPx, heightPx);
  ctx.fillStyle = "#000";
  ctx.textBaseline = "alphabetic";

  return {
    fillRect(x, y, w, h) {
      ctx.fillStyle = "#000";
      ctx.fillRect(x, y, w, h);
    },
    drawText(text, x, y, fontPx, bold, align, maxWidth) {
      ctx.fillStyle = "#000";
      ctx.font = `${bold ? "bold " : ""}${fontPx}px Arial, Helvetica, sans-serif`;
      ctx.textAlign = align;
      ctx.fillText(text, x, y, maxWidth);
    },
    toMono() {
      const { data } = ctx.getImageData(0, 0, widthPx, heightPx);
      const stride = Math.ceil(widthPx / 32) * 4;
      const out = new Uint8Array(stride * heightPx).fill(0xff); // 1 = branco
      for (let row = 0; row < heightPx; row += 1) {
        for (let col = 0; col < widthPx; col += 1) {
          const i = (row * widthPx + col) * 4;
          const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          if (luma < 128) out[row * stride + (col >> 3)] &= ~(0x80 >> (col & 7)); // preto = bit 0
        }
      }
      return out;
    },
  };
};
