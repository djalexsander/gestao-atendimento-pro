import { layout, type CodePage, type CutMode, type PrintDocument } from "./document.ts";

// Renderer ESC/POS: PrintDocument -> bytes. É o ÚNICO lugar com comandos de impressora. Perfil inicial:
// generic_escpos (Font A). Nada aqui abre gaveta, imprime QR/bitmap ou liga a nenhuma impressora.

export const ESC = 0x1b;
export const GS = 0x1d;
export const LF = 0x0a;

// Números de code page do comando ESC t n (Epson/genéricas): 2 = CP850, 3 = CP860, 16 = WPC1252.
export const CODE_PAGE_NUMBER: Record<CodePage, number> = { cp850: 2, cp860: 3, cp1252: 16 };

// Metade alta (0x80-0xFF) de cada tabela, 16 caracteres por linha.
const HIGH: Record<"cp850" | "cp860", string> = {
  cp850: [
    "ÇüéâäàåçêëèïîìÄÅ",
    "ÉæÆôöòûùÿÖÜø£Ø×ƒ",
    "áíóúñÑªº¿®¬½¼¡«»",
    "░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐",
    "└┴┬├─┼ãÃ╚╔╩╦╠═╬¤",
    "ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀",
    "ÓßÔÒõÕµþÞÚÛÙýÝ¯´",
    "­±‗¾¶§÷¸°¨·¹³²■ ",
  ].join(""),
  cp860: [
    "ÇüéâãàÁçêÊèÍÔìÃÂ",
    "ÉÀÈôõòÚùÌÕÜ¢£Ù₧Ó",
    "áíóúñÑªº¿Ò¬½¼¡«»",
    "░▒▓│┤╡╢╖╕╣║╗╝╜╛┐",
    "└┴┬├─┼╞╟╚╔╩╦╠═╬╧",
    "╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀",
    "αßΓπΣσµτΦΘΩδ∞φε∩",
    "≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ",
  ].join(""),
};

const tables = new Map<CodePage, Map<string, number>>();

function tableFor(page: CodePage): Map<string, number> {
  let map = tables.get(page);
  if (map) return map;
  map = new Map();
  if (page === "cp1252") {
    for (let code = 0xa0; code <= 0xff; code += 1) map.set(String.fromCharCode(code), code); // = Latin-1
    map.set("€", 0x80);
  } else {
    const high = HIGH[page];
    for (let i = 0; i < 128; i += 1) map.set(high[i], 0x80 + i);
  }
  tables.set(page, map);
  return map;
}

export function codePageTable(page: CodePage): string {
  return page === "cp1252" ? "" : HIGH[page];
}

// Tipografia que as tabelas não têm vira o equivalente simples.
const SIMPLE: Record<string, string> = {
  "—": "-", "–": "-", "‘": "'", "’": "'", "“": '"', "”": '"', "…": "...", "→": "->", "←": "<-", "•": "*", " ": " ", "✂": "x",
};

// Caractere -> byte. Fora da tabela: tenta a letra base (sem acento), senão '?'. Nunca derruba.
export function encodeChar(ch: string, page: CodePage): number {
  const code = ch.charCodeAt(0);
  if (code >= 0x20 && code <= 0x7e) return code;
  const direct = tableFor(page).get(ch);
  if (direct !== undefined) return direct;
  const simple = SIMPLE[ch];
  if (simple !== undefined) return simple.charCodeAt(0);
  const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (base !== ch && base.length === 1 && base.charCodeAt(0) < 0x7f && base.charCodeAt(0) >= 0x20) return base.charCodeAt(0);
  return 0x3f;
}

export function encodeText(value: string, page: CodePage): number[] {
  const bytes: number[] = [];
  for (const ch of Array.from(value)) {
    const mapped = SIMPLE[ch];
    if (mapped !== undefined && mapped.length > 1) {
      for (const c of mapped) bytes.push(c.charCodeAt(0));
    } else {
      bytes.push(encodeChar(ch, page));
    }
  }
  return bytes;
}

export interface EscPosOptions {
  columns: number;
  codePage: CodePage;
  cutMode: CutMode;
}

// Linhas de avanço antes do corte: leva o papel até a guilhotina.
const FEED_BEFORE_CUT = 4;

export function renderEscPos(doc: PrintDocument, options: EscPosOptions): Uint8Array {
  const out: number[] = [];
  const push = (...bytes: number[]) => out.push(...bytes);
  push(ESC, 0x40); // ESC @ — inicializa
  push(ESC, 0x74, CODE_PAGE_NUMBER[options.codePage]); // ESC t n — code page
  let align = 0;
  let bold = false;
  let size: 1 | 2 = 1;
  let cutDone = false;

  for (const line of layout(doc, options.columns)) {
    if (line.kind === "feed") {
      if (line.lines > 0) push(ESC, 0x64, line.lines); // ESC d n
      continue;
    }
    if (line.kind === "cut") {
      cutDone = true;
      push(ESC, 0x61, 0, ESC, 0x45, 0, GS, 0x21, 0x00);
      align = 0;
      bold = false;
      size = 1;
      push(ESC, 0x64, FEED_BEFORE_CUT);
      if (options.cutMode === "partial") push(GS, 0x56, 0x01); // GS V 1 — corte parcial
      else if (options.cutMode === "full") push(GS, 0x56, 0x00); // GS V 0 — corte total
      continue;
    }
    const wantAlign = line.align === "center" ? 1 : line.align === "right" ? 2 : 0;
    if (wantAlign !== align) {
      push(ESC, 0x61, wantAlign);
      align = wantAlign;
    }
    if (line.bold !== bold) {
      push(ESC, 0x45, line.bold ? 1 : 0); // ESC E n — negrito
      bold = line.bold;
    }
    if (line.size !== size) {
      push(GS, 0x21, line.size === 2 ? 0x11 : 0x00); // GS ! n — largura e altura dobradas
      size = line.size;
    }
    push(...encodeText(line.text, options.codePage), LF);
  }
  // Documento sem bloco `cut`: restaura o estado e só avança o papel.
  if (!cutDone) push(ESC, 0x61, 0, ESC, 0x45, 0, GS, 0x21, 0x00, ESC, 0x64, 3);
  return Uint8Array.from(out);
}
