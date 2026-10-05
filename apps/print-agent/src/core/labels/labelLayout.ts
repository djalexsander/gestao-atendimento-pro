// Modelo de layout de etiqueta INDEPENDENTE do tamanho físico (sem DOM, sem dependências). Recebe o conteúdo e a
// geometria da etiqueta (mm) e devolve elementos em mm: textos com fonte ajustada e código de barras com módulos.
// Serve ao PREVIEW da tela (SVG) e ao Agente de Impressão (bitmap): MESMO arquivo nos dois
// (apps/print-agent/src/core/labels/labelLayout.ts); .claude/frontend-tests/labels-sync.mjs confere.
//
// Prioridade: 1) código de barras legível, 2) nome, 3) preço, 4) nada cortado. Se não couber, as fontes
// diminuem; só então itens de menor prioridade são omitidos (rodapé, cabeçalho, linhas, código em texto), sempre
// com aviso em `warnings`. Nenhuma coordenada é fixa para um tamanho específico.

import { encodeBarcode, isValidCode128B, isValidEan13, type Symbology } from "./barcodes.ts";

export interface LabelContent {
  header?: string;
  title?: string;
  lines?: string[];
  price?: string;
  barcode?: { value: string; symbology: Symbology };
  code_text?: string;
  footer?: string;
  // Título grande (cartão de comanda/mesa): número em destaque.
  big_title?: boolean;
}

export interface LabelGeometry {
  widthMm: number;
  heightMm: number;
  marginXMm: number;
  marginYMm: number;
  columns: number;
  gapMm: number;
}

export type Align = "left" | "center" | "right";

export type LabelElement =
  | { kind: "text"; text: string; x: number; y: number; w: number; h: number; fontMm: number; bold: boolean; align: Align }
  | { kind: "barcode"; x: number; y: number; w: number; h: number; symbology: Symbology; value: string; modules: boolean[]; moduleMm: number };

export interface LabelLayout {
  widthMm: number;
  heightMm: number;
  elements: LabelElement[];
  warnings: string[];
}

const LINE = 1.2; // altura da linha = fonte * 1.2
const CHAR_W = 0.52; // largura média de um caractere = fonte * 0.52 (negrito 0.58)
const MIN_MODULE_MM = 0.19; // módulo mínimo confiável em térmica de 203 dpi (~1,5 ponto)
const MAX_MODULE_MM = 0.5;
const QUIET_MODULES = 9;

const charW = (font: number, bold: boolean) => font * (bold ? 0.58 : CHAR_W);

// Quebra por palavras no que cabe em `maxChars`; palavra maior que a linha é partida (nada some em silêncio).
function wrap(text: string, maxChars: number): string[] {
  const width = Math.max(1, Math.floor(maxChars));
  const out: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/)) {
    let rest = word;
    while (rest.length > width) {
      if (line) {
        out.push(line);
        line = "";
      }
      out.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    if (!rest) continue;
    if (!line) line = rest;
    else if (line.length + 1 + rest.length <= width) line += ` ${rest}`;
    else {
      out.push(line);
      line = rest;
    }
  }
  if (line) out.push(line);
  return out;
}

interface TextSpec {
  key: string;
  text: string;
  base: number; // fonte desejada (mm)
  min: number; // fonte mínima (mm)
  maxLines: number;
  bold: boolean;
  align: Align;
}

interface Fitted {
  spec: TextSpec;
  font: number;
  lines: string[];
  height: number;
}

// Maior fonte (≤ base*scale, ≥ min) em que o texto cabe em `maxLines` linhas; no mínimo, reticências na última.
function fitText(spec: TextSpec, width: number, scale: number): Fitted {
  const start = Math.max(spec.min, spec.base * scale);
  let font = start;
  for (let guard = 0; guard < 60; guard += 1) {
    const lines = wrap(spec.text, width / charW(font, spec.bold));
    if (lines.length <= spec.maxLines) return { spec, font, lines, height: lines.length * font * LINE };
    if (font <= spec.min) break;
    font = Math.max(spec.min, font - 0.1);
  }
  const room = Math.max(1, Math.floor(width / charW(spec.min, spec.bold)));
  const all = wrap(spec.text, room).slice(0, spec.maxLines);
  const last = all.length - 1;
  all[last] = all[last].length >= 2 ? `${all[last].slice(0, Math.max(1, all[last].length - 1))}…` : all[last];
  return { spec, font: spec.min, lines: all, height: all.length * spec.min * LINE };
}

export function layoutLabel(content: LabelContent, geom: LabelGeometry): LabelLayout {
  const warnings: string[] = [];
  const innerW = geom.widthMm - 2 * geom.marginXMm;
  const innerH = geom.heightMm - 2 * geom.marginYMm;
  const ox = geom.marginXMm;
  const oy = geom.marginYMm;

  let barcode = content.barcode;
  if (barcode) {
    const ok = barcode.symbology === "ean13" ? isValidEan13(barcode.value) : isValidCode128B(barcode.value);
    if (!ok) {
      warnings.push("Código de barras inválido: não foi desenhado.");
      barcode = undefined;
    }
  }

  // Itens por prioridade de OMISSÃO (os primeiros a sair vêm primeiro).
  const flags = { footer: !!content.footer, header: !!content.header, lines: (content.lines ?? []).length, codeText: !!content.code_text };

  const build = (): { texts: TextSpec[]; hasBarcode: boolean } => {
    const texts: TextSpec[] = [];
    if (flags.header && content.header) texts.push({ key: "header", text: content.header, base: content.big_title ? 3.4 : 2.4, min: 1.6, maxLines: 1, bold: !!content.big_title, align: "center" });
    if (content.title) texts.push({ key: "title", text: content.title, base: content.big_title ? 11 : 4.2, min: 2.2, maxLines: content.big_title ? 1 : 2, bold: true, align: "center" });
    (content.lines ?? []).slice(0, flags.lines).forEach((l, i) => texts.push({ key: `line${i}`, text: l, base: 2.8, min: 1.7, maxLines: 1, bold: false, align: "center" }));
    if (content.price) texts.push({ key: "price", text: content.price, base: 6.2, min: 3, maxLines: 1, bold: true, align: "center" });
    return { texts, hasBarcode: !!barcode };
  };

  const barBase = Math.min(Math.max(innerH * 0.4, 6), 16);
  const barMin = 4.5;
  const codeTextSpec = (): TextSpec | null =>
    flags.codeText && content.code_text ? { key: "code_text", text: content.code_text, base: 2.4, min: 1.5, maxLines: 1, bold: false, align: "center" } : null;
  const footerSpec = (): TextSpec | null =>
    flags.footer && content.footer ? { key: "footer", text: content.footer, base: 2.2, min: 1.5, maxLines: 2, bold: false, align: "center" } : null;

  const attempt = (scale: number) => {
    const { texts, hasBarcode } = build();
    const fitted = texts.map((t) => fitText(t, innerW, scale));
    const code = codeTextSpec();
    const foot = footerSpec();
    const codeFit = code ? fitText(code, innerW, scale) : null;
    const footFit = foot ? fitText(foot, innerW, scale) : null;
    const barH = hasBarcode ? Math.max(barMin, barBase * scale) : 0;
    const gap = 0.35 * Math.max(scale, 0.5);
    const parts = [...fitted, ...(hasBarcode ? [{ barH }] : []), ...(codeFit ? [codeFit] : []), ...(footFit ? [footFit] : [])];
    const total = fitted.reduce((s, f) => s + f.height, 0) + barH + (codeFit?.height ?? 0) + (footFit?.height ?? 0) + gap * Math.max(0, parts.length - 1);
    return { fitted, codeFit, footFit, barH, gap, total, hasBarcode };
  };

  let result = attempt(1);
  let scale = 1;
  const drop = (): boolean => {
    if (flags.footer) { flags.footer = false; warnings.push("Rodapé omitido: não cabe na etiqueta."); return true; }
    if (flags.header) { flags.header = false; warnings.push("Cabeçalho omitido: não cabe na etiqueta."); return true; }
    if (flags.lines > 0) { flags.lines -= 1; warnings.push("Linha omitida: não cabe na etiqueta."); return true; }
    if (flags.codeText && barcode) { flags.codeText = false; warnings.push("Código em texto omitido: não cabe na etiqueta."); return true; }
    return false;
  };
  for (let guard = 0; guard < 80; guard += 1) {
    result = attempt(scale);
    if (result.total <= innerH + 1e-6) break;
    if (scale > 0.4) scale = Math.max(0.4, scale - 0.05);
    else if (!drop()) {
      warnings.push("O conteúdo é grande demais para esta etiqueta; aumente a etiqueta ou reduza os campos.");
      break;
    }
  }

  const elements: LabelElement[] = [];
  const extra = Math.max(0, innerH - result.total);
  // Espaço que sobra: centraliza o bloco na vertical (no máximo, o resto fica em cima e embaixo).
  let y = oy + extra / 2;
  const pushText = (f: { spec: TextSpec; font: number; lines: string[] }) => {
    for (const line of f.lines) {
      const h = f.font * LINE;
      elements.push({ kind: "text", text: line, x: ox, y, w: innerW, h, fontMm: f.font, bold: f.spec.bold, align: f.spec.align });
      y += h;
    }
    y += result.gap;
  };
  for (const f of result.fitted) pushText(f);
  if (result.hasBarcode && barcode) {
    const modules = encodeBarcode(barcode.symbology, barcode.value);
    const moduleMm = Math.min(MAX_MODULE_MM, innerW / (modules.length + 2 * QUIET_MODULES));
    if (moduleMm < MIN_MODULE_MM) warnings.push("Código de barras muito denso para a largura da etiqueta: pode não ler. Use uma etiqueta mais larga ou um código menor.");
    const w = modules.length * moduleMm;
    elements.push({ kind: "barcode", x: ox + (innerW - w) / 2, y, w, h: result.barH, symbology: barcode.symbology, value: barcode.value, modules, moduleMm });
    y += result.barH + result.gap;
  }
  if (result.codeFit) pushText(result.codeFit);
  if (result.footFit) pushText(result.footFit);

  return { widthMm: geom.widthMm, heightMm: geom.heightMm, elements, warnings };
}

// ---- folha: quantidade x colunas -------------------------------------------------------------------
export interface SheetPlan {
  columns: number;
  rows: number; // linhas físicas
  perRow: number[]; // quantas etiquetas em cada linha (a última pode ter menos)
  sheetWidthMm: number;
  sheetHeightMm: number;
}

// 2 colunas + 10 etiquetas = 5 linhas físicas; 2 colunas + 5 = 3 linhas (a última com 1).
export function planSheet(quantity: number, geom: Pick<LabelGeometry, "widthMm" | "heightMm" | "columns" | "gapMm">): SheetPlan {
  const qty = Math.max(1, Math.floor(quantity));
  const columns = Math.max(1, Math.floor(geom.columns));
  const rows = Math.ceil(qty / columns);
  const perRow = Array.from({ length: rows }, (_, i) => Math.min(columns, qty - i * columns));
  return {
    columns,
    rows,
    perRow,
    sheetWidthMm: columns * geom.widthMm + (columns - 1) * geom.gapMm,
    sheetHeightMm: geom.heightMm,
  };
}

// Posição X (mm) da coluna `c` dentro da linha física.
export const columnX = (c: number, geom: Pick<LabelGeometry, "widthMm" | "gapMm">): number => c * (geom.widthMm + geom.gapMm);
