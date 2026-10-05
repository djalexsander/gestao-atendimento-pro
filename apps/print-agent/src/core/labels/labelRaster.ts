import { columnX, layoutLabel, planSheet } from "./labelLayout.ts";
import type { LabelJobModel } from "../model.ts";

// Rasteriza as etiquetas de um job em bitmaps monocromáticos (1 bit/pixel), UMA página por linha física (todas as
// colunas lado a lado). O desenho vem do MESMO motor de layout do preview da tela; aqui só se converte mm em pontos.
// A superfície de desenho é injetada (canvas no app; falsa nos testes): este arquivo não toca em DOM.

export const DOTS_PER_MM = 12; // ~305 dpi: nítido para código de barras e legível em 203/300 dpi

export interface RasterSurface {
  /** Retângulo PRETO. Coordenadas e tamanhos em pontos, inteiros. */
  fillRect(x: number, y: number, w: number, h: number): void;
  /** Texto preto; (x, y) é a linha de base; `align` define o ponto de ancoragem; `maxWidth` comprime se passar. */
  drawText(text: string, x: number, y: number, fontPx: number, bold: boolean, align: "left" | "center" | "right", maxWidth: number): void;
  /** 1 bit por pixel, topo primeiro, linhas alinhadas a 4 bytes, bit 1 = branco, 0 = preto. */
  toMono(): Uint8Array;
}

export type SurfaceFactory = (widthPx: number, heightPx: number) => RasterSurface;

export interface LabelPageBitmap {
  widthPx: number;
  heightPx: number;
  widthMm: number;
  heightMm: number;
  data: Uint8Array;
}

const px = (mm: number) => Math.round(mm * DOTS_PER_MM);

export function renderLabelPages(job: LabelJobModel, makeSurface: SurfaceFactory): LabelPageBitmap[] {
  const { content, geometry, quantity } = job;
  const layout = layoutLabel(content, geometry);
  const plan = planSheet(quantity, geometry);
  const widthPx = px(plan.sheetWidthMm);
  const heightPx = px(plan.sheetHeightMm);
  const pages: LabelPageBitmap[] = [];

  for (const count of plan.perRow) {
    const surface = makeSurface(widthPx, heightPx);
    for (let c = 0; c < count; c += 1) {
      const ox = px(columnX(c, geometry));
      for (const e of layout.elements) {
        if (e.kind === "text") {
          const x = e.align === "center" ? e.x + e.w / 2 : e.align === "right" ? e.x + e.w : e.x;
          surface.drawText(e.text, ox + px(x), px(e.y + e.h * 0.78), Math.max(6, px(e.fontMm)), e.bold, e.align, px(e.w));
        } else {
          // Módulos em pontos INTEIROS (sem anti-aliasing): barras nítidas, largura uniforme.
          const modulePx = Math.max(1, Math.floor(e.moduleMm * DOTS_PER_MM));
          const total = e.modules.length * modulePx;
          const x0 = ox + Math.round(px(e.x + e.w / 2) - total / 2);
          const y0 = px(e.y);
          const h = Math.max(1, px(e.h));
          let start = -1;
          e.modules.forEach((on, i) => {
            if (on && start < 0) start = i;
            if ((!on || i === e.modules.length - 1) && start >= 0) {
              const end = on ? i + 1 : i;
              surface.fillRect(x0 + start * modulePx, y0, (end - start) * modulePx, h);
              start = -1;
            }
          });
        }
      }
    }
    pages.push({ widthPx, heightPx, widthMm: plan.sheetWidthMm, heightMm: plan.sheetHeightMm, data: surface.toMono() });
  }
  return pages;
}

export const monoStride = (widthPx: number): number => Math.ceil(widthPx / 32) * 4;
