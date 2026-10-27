// Gerador do PDF do cardápio (A4), SEM dependências: PDF 1.4 com Helvetica (fontes padrão do leitor, nada embutido) e codificação
// WinAnsi, que cobre o português. Recebe SÓ o catálogo já filtrado pelo banco (whatsapp_ai_menu_context) e não inventa nada.
// Determinístico: a mesma entrada gera os mesmos bytes (o cache por hash do catálogo depende disso).

export interface MenuProduct {
  name: string;
  description: string | null;
  price: number;
}
export interface MenuCategory {
  name: string;
  products: MenuProduct[];
}
export interface MenuCatalog {
  company: string;
  categories: MenuCategory[];
}

export const MENU_PDF_MAX_BYTES = 4 * 1024 * 1024;

// Larguras Helvetica / Helvetica-Bold (AFM) de 32 a 126, em milésimos de em.
const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

// Um caractere -> byte WinAnsi (Latin-1 + pontuação tipográfica usual); o resto vira "?".
const WIN_ANSI_EXTRA: Record<string, number> = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "™": 0x99 };

function toWinAnsi(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFC")) {
    const c = ch.codePointAt(0) as number;
    if (c === 0x09 || c === 0x0a || c === 0x0d) out += " ";
    else if (c >= 0x20 && c <= 0x7e) out += ch;
    else if (c >= 0xa0 && c <= 0xff) out += ch;
    else if (WIN_ANSI_EXTRA[ch] !== undefined) out += String.fromCharCode(WIN_ANSI_EXTRA[ch]);
    else out += "?";
  }
  return out;
}

function charWidth(ch: string, bold: boolean): number {
  const c = ch.charCodeAt(0);
  const table = bold ? W_BOLD : W_REG;
  if (c >= 32 && c <= 126) return table[c - 32];
  // letra acentuada: a largura da letra base
  const base = ch.normalize("NFD").charAt(0);
  const bc = base.charCodeAt(0);
  if (bc >= 32 && bc <= 126 && base !== ch) return table[bc - 32];
  return 556;
}

function textWidth(s: string, size: number, bold: boolean): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch, bold);
  return (w * size) / 1000;
}

function wrap(text: string, maxWidth: number, size: number, bold: boolean): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    // palavra maior que a linha: quebra por caractere
    let piece = word;
    while (textWidth(piece, size, bold) > maxWidth) {
      let n = piece.length;
      while (n > 1 && textWidth(piece.slice(0, n), size, bold) > maxWidth) n--;
      if (cur) { lines.push(cur); cur = ""; }
      lines.push(piece.slice(0, n));
      piece = piece.slice(n);
    }
    const next = cur ? `${cur} ${piece}` : piece;
    if (textWidth(next, size, bold) <= maxWidth) cur = next;
    else { lines.push(cur); cur = piece; }
  }
  if (cur) lines.push(cur);
  return lines;
}

const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const num = (n: number): string => (Math.round(n * 100) / 100).toString();

export function formatBRL(v: number): string {
  const [i, d] = Math.abs(v).toFixed(2).split(".");
  return `R$ ${i.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${d}`;
}

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 42;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const BOTTOM = 56;

class Page {
  ops: string[] = [];
  text(x: number, y: number, size: number, bold: boolean, rgb: [number, number, number], s: string): void {
    this.ops.push(`BT /${bold ? "F2" : "F1"} ${num(size)} Tf ${rgb.map(num).join(" ")} rg ${num(x)} ${num(y)} Td (${esc(toWinAnsi(s))}) Tj ET`);
  }
  rect(x: number, y: number, w: number, h: number, rgb: [number, number, number]): void {
    this.ops.push(`${rgb.map(num).join(" ")} rg ${num(x)} ${num(y)} ${num(w)} ${num(h)} re f`);
  }
}

const INK: [number, number, number] = [0.13, 0.13, 0.15];
const MUTED: [number, number, number] = [0.42, 0.42, 0.46];
const ACCENT: [number, number, number] = [0.72, 0.27, 0.1];
const BAND: [number, number, number] = [0.95, 0.93, 0.9];

/** Monta o PDF. `generatedAt` só entra no rodapé (data de atualização); passe-o fixo nos testes. */
export function buildMenuPdf(catalog: MenuCatalog, generatedAt: Date): Uint8Array {
  const pages: Page[] = [];
  let page = new Page();
  pages.push(page);
  let y = PAGE_H - MARGIN;
  const newPage = (): void => {
    page = new Page();
    pages.push(page);
    y = PAGE_H - MARGIN;
  };
  const ensure = (h: number): void => {
    if (y - h < BOTTOM) newPage();
  };

  // cabeçalho
  const title = catalog.company.trim() || "Cardápio";
  const titleSize = textWidth(title, 24, true) > CONTENT_W ? 17 : 24;
  for (const line of wrap(title, CONTENT_W, titleSize, true).slice(0, 2)) {
    y -= titleSize + 2;
    page.text(MARGIN, y, titleSize, true, INK, line);
  }
  y -= 18;
  page.text(MARGIN, y, 12, false, ACCENT, "CARDÁPIO");
  y -= 10;
  page.rect(MARGIN, y, CONTENT_W, 1.5, ACCENT);
  y -= 8;

  const PRICE_SIZE = 10.5;
  for (const cat of catalog.categories) {
    if (cat.products.length === 0) continue;
    // a categoria nunca fica sozinha no fim da página: precisa caber o título e o 1º item
    ensure(22 + 14 + 26);
    y -= 12;
    page.rect(MARGIN, y - 5, CONTENT_W, 20, BAND);
    page.text(MARGIN + 8, y + 1, 12, true, ACCENT, cat.name.toUpperCase());
    y -= 14;
    for (const p of cat.products) {
      const price = formatBRL(p.price);
      const priceW = textWidth(price, PRICE_SIZE, true);
      const nameLines = wrap(p.name, CONTENT_W - priceW - 16, PRICE_SIZE, true);
      const descLines = p.description ? wrap(p.description, CONTENT_W - priceW - 16, 9, false) : [];
      const h = nameLines.length * 13 + descLines.length * 11.5 + 8;
      ensure(h);
      y -= 13;
      page.text(MARGIN + 4, y, PRICE_SIZE, true, INK, nameLines[0]);
      page.text(MARGIN + CONTENT_W - priceW - 4, y, PRICE_SIZE, true, INK, price);
      for (const extra of nameLines.slice(1)) {
        y -= 13;
        page.text(MARGIN + 4, y, PRICE_SIZE, true, INK, extra);
      }
      for (const d of descLines) {
        y -= 11.5;
        page.text(MARGIN + 4, y, 9, false, MUTED, d);
      }
      y -= 8;
    }
  }

  // rodapé com paginação (2ª passada: o total só é conhecido agora)
  const dd = String(generatedAt.getUTCDate()).padStart(2, "0");
  const mm = String(generatedAt.getUTCMonth() + 1).padStart(2, "0");
  const when = `Atualizado em ${dd}/${mm}/${generatedAt.getUTCFullYear()} · Preços sujeitos a alteração`;
  pages.forEach((pg, i) => {
    pg.rect(MARGIN, 38, CONTENT_W, 0.5, MUTED);
    pg.text(MARGIN, 26, 8, false, MUTED, when);
    const label = `Página ${i + 1} de ${pages.length}`;
    pg.text(MARGIN + CONTENT_W - textWidth(label, 8, false), 26, 8, false, MUTED, label);
  });

  // serialização
  const objs: string[] = [];
  const add = (body: string): number => objs.push(body);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(`<< /Type /Pages /Kids [${pages.map((_, i) => `${5 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  pages.forEach((pg, i) => {
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
    const stream = pg.ops.join("\n");
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  // cada caractere de `out` já é um byte (ASCII ou WinAnsi)
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
