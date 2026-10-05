// Codificadores de código de barras PUROS (sem DOM, sem dependências): devolvem os módulos (true = barra preta).
// MESMO arquivo no Agente de Impressão (apps/print-agent/src/core/labels/barcodes.ts): o teste de sincronia
// (.claude/frontend-tests/labels-sync.mjs) falha se os dois divergirem.
//
// Suportados: EAN-13 (13 dígitos, dígito verificador conferido) e CODE128 (subconjunto B, ASCII 32–126).
// Nada é convertido à força: valor que não é EAN-13 válido NÃO vira EAN-13 (o chamador usa CODE128).

export type Symbology = "ean13" | "code128";

// ---- EAN-13 -------------------------------------------------------------------------------------
const EAN_L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const EAN_G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const EAN_R = EAN_L.map((p) => [...p].map((b) => (b === "1" ? "0" : "1")).join(""));
const EAN_PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

export function ean13CheckDigit(digits12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(digits12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(value: string): boolean {
  return /^[0-9]{13}$/.test(value) && ean13CheckDigit(value.slice(0, 12)) === Number(value[12]);
}

export function encodeEan13(value: string): boolean[] {
  if (!isValidEan13(value)) throw new Error("EAN-13 inválido: informe 13 dígitos com o dígito verificador correto.");
  const parity = EAN_PARITY[Number(value[0])];
  let bits = "101";
  for (let i = 0; i < 6; i += 1) {
    const d = Number(value[i + 1]);
    bits += parity[i] === "L" ? EAN_L[d] : EAN_G[d];
  }
  bits += "01010";
  for (let i = 0; i < 6; i += 1) bits += EAN_R[Number(value[i + 7])];
  bits += "101";
  return [...bits].map((b) => b === "1");
}

// ---- CODE128 (subconjunto B) -----------------------------------------------------------------------
// Larguras barra/espaço alternadas de cada símbolo (0..105); o STOP (106) tem 7 larguras.
const C128 = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232",
];
const C128_STOP = "2331112";
export const CODE128_PATTERNS: readonly string[] = [...C128, C128_STOP];

export function isValidCode128B(value: string): boolean {
  return /^[ -~]{1,40}$/.test(value);
}

function widthsToModules(widths: string): boolean[] {
  const out: boolean[] = [];
  let bar = true;
  for (const w of widths) {
    for (let i = 0; i < Number(w); i += 1) out.push(bar);
    bar = !bar;
  }
  return out;
}

export function encodeCode128(value: string): boolean[] {
  if (!isValidCode128B(value)) throw new Error("Código de barras inválido: use de 1 a 40 caracteres simples (letras, números e símbolos comuns).");
  const codes = [104, ...[...value].map((c) => c.charCodeAt(0) - 32)];
  let checksum = codes[0];
  for (let i = 1; i < codes.length; i += 1) checksum += codes[i] * i;
  codes.push(checksum % 103);
  const out: boolean[] = [];
  for (const c of codes) out.push(...widthsToModules(C128[c]));
  out.push(...widthsToModules(C128_STOP));
  return out;
}

export function encodeBarcode(symbology: Symbology, value: string): boolean[] {
  return symbology === "ean13" ? encodeEan13(value) : encodeCode128(value);
}

// "auto": EAN-13 só se for válido; qualquer outro texto vira CODE128 (nunca um EAN-13 inválido).
export function pickSymbology(value: string): Symbology {
  return isValidEan13(value) ? "ean13" : "code128";
}
