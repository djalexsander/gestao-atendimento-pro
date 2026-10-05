import { isValidCode128B, isValidEan13, pickSymbology, type Symbology } from "./barcodes.ts";
import type { LabelContent, LabelGeometry } from "./labelLayout.ts";

// Regras PURAS da área Etiquetas (sem React, sem Supabase). O servidor é a autoridade (papel, impressora pronta,
// dados do produto/comanda lidos do banco); aqui há tipos, rascunhos, validação amigável e o CONTEÚDO do preview.

export type LabelMode = "product" | "free" | "service_point";
export const MODE_LABEL: Record<LabelMode, string> = { product: "Produto", free: "Impressão livre", service_point: "Comanda / Mesa" };

// Quem vê cada aba (o banco confere de novo): attendant só comanda/mesa.
export function modesForRole(role: string | null): LabelMode[] {
  if (role === "attendant") return ["service_point"];
  if (role === "owner" || role === "admin" || role === "cashier") return ["product", "free", "service_point"];
  return [];
}

export interface LabelPrinterOption {
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
  gapMm: number;
  columns: number;
  marginXMm: number;
  marginYMm: number;
  isDefault: boolean;
  isReady: boolean;
}

export function geometryOf(p: LabelPrinterOption): LabelGeometry {
  return { widthMm: p.widthMm, heightMm: p.heightMm, marginXMm: p.marginXMm, marginYMm: p.marginYMm, columns: p.columns, gapMm: p.gapMm };
}

// Impressora sugerida: a escolhida; senão a padrão pronta; senão a única pronta; senão a padrão.
export function defaultPrinterId(printers: LabelPrinterOption[]): string | null {
  const ready = printers.filter((p) => p.isReady);
  // Com impressoras prontas, só sugere a padrão ou a única; entre várias sem padrão, a pessoa escolhe.
  if (ready.length > 0) return ready.find((p) => p.isDefault)?.id ?? (ready.length === 1 ? ready[0].id : null);
  return printers.find((p) => p.isDefault)?.id ?? printers[0]?.id ?? null;
}

export interface ProductOption {
  id: string;
  name: string;
  code: string;
  barcode: string | null;
  priceCents: number;
}

export interface ServicePointOption {
  id: string;
  type: "command" | "table";
  code: string;
  displayName: string;
  barcode: string | null;
}

export const priceText = (cents: number): string => `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;

export const QTY_MAX = { product: 500, free: 500, service_point: 50 } as const;

export function validateQuantity(raw: string, max: number): { error: string } | { quantity: number } {
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > max) return { error: `A quantidade deve ser de 1 a ${max}.` };
  return { quantity: n };
}

// ---- produto ---------------------------------------------------------------------------------------
export interface ProductFields {
  name: boolean;
  price: boolean;
  barcode: boolean;
  code: boolean;
  company: boolean;
}
export const DEFAULT_PRODUCT_FIELDS: ProductFields = { name: true, price: true, barcode: true, code: false, company: false };

export function productContent(p: ProductOption, f: ProductFields, companyName: string): LabelContent {
  return {
    header: f.company ? companyName : undefined,
    title: f.name ? p.name : undefined,
    price: f.price ? priceText(p.priceCents) : undefined,
    barcode: f.barcode && p.barcode ? { value: p.barcode, symbology: pickSymbology(p.barcode) } : undefined,
    code_text: f.code ? (p.barcode ?? p.code) : undefined,
  };
}

export function productProblem(p: ProductOption | null, f: ProductFields): string | null {
  if (!p) return "Escolha um produto.";
  if (!(f.name || f.price || f.barcode || f.code)) return "Escolha pelo menos um item para aparecer na etiqueta.";
  if (f.barcode && !p.barcode) return "Este produto não tem código de barras.";
  return null;
}

// ---- livre ------------------------------------------------------------------------------------------
export type BarcodeType = "auto" | "code128" | "ean13";
export interface FreeDraft {
  title: string;
  line1: string;
  line2: string;
  line3: string;
  price: string;
  barcode: string;
  barcodeType: BarcodeType;
  extra: string;
  company: boolean;
}
export const EMPTY_FREE: FreeDraft = { title: "", line1: "", line2: "", line3: "", price: "", barcode: "", barcodeType: "auto", extra: "", company: false };

export function freeSymbology(d: Pick<FreeDraft, "barcode" | "barcodeType">): Symbology | null {
  const code = d.barcode.trim();
  if (code === "") return null;
  if (d.barcodeType === "ean13") return isValidEan13(code) ? "ean13" : null;
  if (d.barcodeType === "code128") return isValidCode128B(code) ? "code128" : null;
  return isValidEan13(code) ? "ean13" : isValidCode128B(code) ? "code128" : null;
}

export function freeProblem(d: FreeDraft): string | null {
  const t = (s: string) => s.trim();
  if ([d.title, d.line1, d.line2, d.line3].some((s) => t(s).length > 60) || t(d.extra).length > 120) return "Textos muito longos: título e linhas até 60 caracteres, texto adicional até 120.";
  if (t(d.price).length > 20) return "O valor pode ter no máximo 20 caracteres.";
  const code = t(d.barcode);
  if (code !== "") {
    if (d.barcodeType === "ean13" && !isValidEan13(code)) return "EAN-13 inválido: informe 13 dígitos com o dígito verificador correto.";
    if (!isValidCode128B(code)) return "O código de barras aceita até 40 caracteres simples (letras, números e símbolos comuns).";
  }
  if (![d.title, d.line1, d.line2, d.line3, d.price, d.barcode, d.extra].some((s) => t(s) !== "")) return "Preencha pelo menos um campo da etiqueta.";
  return null;
}

export function freeContent(d: FreeDraft, companyName: string): LabelContent {
  const sym = freeSymbology(d);
  const lines = [d.line1, d.line2, d.line3].map((s) => s.trim()).filter(Boolean);
  return {
    header: d.company ? companyName : undefined,
    title: d.title.trim() || undefined,
    lines: lines.length > 0 ? lines : undefined,
    price: d.price.trim() || undefined,
    barcode: sym ? { value: d.barcode.trim(), symbology: sym } : undefined,
    code_text: sym ? d.barcode.trim() : undefined,
    footer: d.extra.trim() || undefined,
  };
}

// ---- comanda / mesa ---------------------------------------------------------------------------------
export interface PointFields {
  barcode: boolean;
  code: boolean;
  company: boolean;
}
export const DEFAULT_POINT_FIELDS: PointFields = { barcode: true, code: true, company: false };

// Mesmo texto do servidor: "Comanda 005" -> "005"; "Mesa 12" -> "12".
export const pointTitle = (displayName: string): string => displayName.replace(/^(comanda|mesa)\s+/i, "");

export function pointContent(p: ServicePointOption, f: PointFields, companyName: string): LabelContent {
  // Usa o barcode JÁ cadastrado do ponto; sem barcode, o código (CODE128), igual ao servidor.
  const value = p.barcode ?? p.code;
  return {
    header: p.type === "table" ? "MESA" : "COMANDA",
    title: pointTitle(p.displayName),
    barcode: f.barcode ? { value, symbology: pickSymbology(value) } : undefined,
    code_text: f.code ? p.code : undefined,
    footer: f.company ? companyName : undefined,
    big_title: true,
  };
}

// Escape de LIKE: % e _ são texto (busca literal).
export function likePattern(term: string): string {
  return `%${term.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
