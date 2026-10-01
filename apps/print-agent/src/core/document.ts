// PrintDocument: modelo INTERMEDIÁRIO entre o payload de negócio e o papel. As regras de negócio
// (document-builders.ts) só descrevem blocos; quem sabe de largura de papel, quebra de linha, code page
// e comandos ESC/POS são os renderers (text-renderer.ts e escpos.ts). Nenhum byte de impressora aparece
// fora do escpos.ts.

export type Align = "left" | "center" | "right";
export type PaperWidth = 58 | 80;

export type Block =
  // size 2 = largura e altura dobradas (metade das colunas por linha).
  | { type: "text"; text: string; align?: Align; bold?: boolean; size?: 1 | 2 }
  | { type: "divider"; char?: string }
  // `left` quebra em várias linhas se precisar (nunca é cortado); `right` fica na 1ª linha.
  // `indent`: recuo das linhas de continuação de `left`.
  | { type: "row"; left: string; right: string; bold?: boolean; indent?: number }
  | { type: "feed"; lines?: number }
  // Fim do documento: o modo (none/partial/full) vem da configuração da impressora.
  | { type: "cut" };

export interface PrintDocument {
  blocks: Block[];
}

// Larguras úteis (Font A) em UM só lugar. Nenhum outro arquivo deve conhecer 32/48.
export const PAPER_COLUMNS: Record<PaperWidth, number> = { 58: 32, 80: 48 };

export function columnsFor(width: PaperWidth): number {
  return PAPER_COLUMNS[width];
}

export type CutMode = "none" | "partial" | "full";
export type CodePage = "cp850" | "cp860" | "cp1252";

export const CODE_PAGE_LABEL: Record<CodePage, string> = { cp850: "CP850", cp860: "CP860", cp1252: "Windows-1252" };
export const CUT_MODE_LABEL: Record<CutMode, string> = { none: "Sem corte", partial: "Parcial", full: "Total" };

// ---- construtores (deixam os builders legíveis)
export const text = (value: string, o: { align?: Align; bold?: boolean; size?: 1 | 2 } = {}): Block => ({ type: "text", text: value, ...o });
export const center = (value: string, o: { bold?: boolean; size?: 1 | 2 } = {}): Block => ({ type: "text", text: value, align: "center", ...o });
export const bold = (value: string): Block => ({ type: "text", text: value, bold: true });
export const big = (value: string, o: { align?: Align; bold?: boolean } = {}): Block => ({ type: "text", text: value, size: 2, bold: true, ...o });
export const divider = (char?: string): Block => ({ type: "divider", char });
export const row = (left: string, right: string, o: { bold?: boolean; indent?: number } = {}): Block => ({ type: "row", left, right, ...o });
export const feed = (lines = 1): Block => ({ type: "feed", lines });
export const cut = (): Block => ({ type: "cut" });

// ---- quebra de linha
// Quebra por palavras; palavra maior que a linha é partida (nada é cortado em silêncio).
// \n explícito é respeitado. Linhas vazias são preservadas.
export function wrapText(value: string, columns: number): string[] {
  const width = Math.max(1, columns);
  const out: string[] = [];
  for (const paragraph of value.split("\n")) {
    if (paragraph.trim() === "") {
      out.push("");
      continue;
    }
    // Cabe na linha: mantém como está (preserva colunas feitas com espaços).
    if (paragraph.trimEnd().length <= width) {
      out.push(paragraph.trimEnd());
      continue;
    }
    let line = "";
    for (const word of paragraph.trim().split(/\s+/)) {
      let rest = word;
      while (rest.length > width) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      if (!line) line = rest;
      else if (line.length + 1 + rest.length <= width) line += ` ${rest}`;
      else {
        out.push(line);
        line = rest;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

// ---- layout: resolve quebra e larguras. Os dois renderers consomem as MESMAS linhas.
export type LayoutLine =
  | { kind: "text"; text: string; align: Align; bold: boolean; size: 1 | 2 }
  | { kind: "feed"; lines: number }
  | { kind: "cut" };

export function layout(doc: PrintDocument, columns: number): LayoutLine[] {
  const lines: LayoutLine[] = [];
  const plain = (text: string, align: Align = "left", bold = false, size: 1 | 2 = 1) => lines.push({ kind: "text", text, align, bold, size });
  for (const block of doc.blocks) {
    switch (block.type) {
      case "text": {
        const size = block.size ?? 1;
        const effective = size === 2 ? Math.max(1, Math.floor(columns / 2)) : columns;
        for (const piece of wrapText(block.text, effective)) plain(piece, block.align ?? "left", block.bold ?? false, size);
        break;
      }
      case "divider":
        plain((block.char && block.char.length > 0 ? block.char[0] : "-").repeat(columns));
        break;
      case "row": {
        const bold = block.bold ?? false;
        const right = block.right;
        if (right === "") {
          for (const piece of wrapIndented(block.left, columns, block.indent ?? 0)) plain(piece, "left", bold);
          break;
        }
        const room = columns - right.length - 1;
        if (room < 4) {
          // direita muito larga: esquerda numa linha, direita alinhada abaixo
          for (const piece of wrapIndented(block.left, columns, block.indent ?? 0)) plain(piece, "left", bold);
          plain(right, "right", bold);
          break;
        }
        const parts = wrapIndented(block.left, room, block.indent ?? 0);
        const first = parts[0] ?? "";
        plain(first + " ".repeat(Math.max(1, columns - first.length - right.length)) + right, "left", bold);
        for (const piece of parts.slice(1)) plain(piece, "left", bold);
        break;
      }
      case "feed":
        lines.push({ kind: "feed", lines: Math.max(0, Math.min(block.lines ?? 1, 10)) });
        break;
      case "cut":
        lines.push({ kind: "cut" });
        break;
    }
  }
  return lines;
}

// Quebra com recuo nas linhas de continuação (a 1ª linha usa a largura inteira).
function wrapIndented(value: string, columns: number, indent: number): string[] {
  const pad = Math.min(Math.max(0, indent), Math.max(0, columns - 4));
  if (pad === 0 || (!value.includes("\n") && value.trimEnd().length <= columns)) return wrapText(value, columns);
  const out: string[] = [];
  let line = "";
  const limit = () => (out.length === 0 ? columns : columns - pad);
  const flush = () => {
    out.push((out.length > 0 ? " ".repeat(pad) : "") + line);
    line = "";
  };
  for (const word of value.trim().split(/\s+/)) {
    let rest = word;
    while (rest.length > limit()) {
      if (line) flush();
      const lim = limit();
      line = rest.slice(0, lim);
      rest = rest.slice(lim);
      flush();
    }
    if (!line) line = rest;
    else if (line.length + 1 + rest.length <= limit()) line += ` ${rest}`;
    else {
      flush();
      line = rest;
    }
  }
  if (line) flush();
  return out;
}
