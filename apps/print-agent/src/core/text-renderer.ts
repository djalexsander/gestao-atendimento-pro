import { layout, type PrintDocument } from "./document.ts";

// Renderer de TEXTO: PrintDocument -> linhas legíveis (log, preview e simulação). Usa o mesmo layout do
// ESC/POS, então o preview mostra quebras e colunas iguais às do papel.
export function renderText(doc: PrintDocument, columns: number): string[] {
  const out: string[] = [];
  for (const line of layout(doc, columns)) {
    if (line.kind === "feed") {
      for (let i = 0; i < line.lines; i += 1) out.push("");
    } else if (line.kind === "cut") {
      out.push("- - - - - - - - ✂ corte - - - - - - - -");
    } else {
      // largura visual: caractere em tamanho 2 ocupa 2 colunas
      const visual = line.text.length * line.size;
      const free = Math.max(0, columns - visual);
      const pad = line.align === "center" ? Math.floor(free / 2) : line.align === "right" ? free : 0;
      out.push(" ".repeat(pad) + line.text);
    }
  }
  return out;
}
