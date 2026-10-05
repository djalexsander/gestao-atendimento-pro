import { supabase } from "../../lib/supabaseClient";
import { describeOrderError } from "../orders/ordersLogic";
import {
  likePattern,
  type BarcodeType,
  type FreeDraft,
  type LabelPrinterOption,
  type PointFields,
  type ProductFields,
  type ProductOption,
  type ServicePointOption,
} from "./labelsLogic";

const LOAD_ERROR = "Não foi possível carregar agora. Tente novamente.";
const PRINT_ERROR = "Não foi possível enviar para impressão agora. Tente novamente.";

export type Result<T> = { data: T; error: null } | { data: null; error: string };

// Fonte de dados da área Etiquetas (recebida por parâmetro para exercitar a tela com dados simulados). Preço, nome e
// código de produto/comanda/mesa são lidos do BANCO pelo servidor na hora de imprimir; o navegador só escolhe o que mostrar.
export interface LabelsSource {
  listPrinters(companyId: string): Promise<Result<LabelPrinterOption[]>>;
  searchProducts(companyId: string, term: string): Promise<Result<ProductOption[]>>;
  searchServicePoints(companyId: string, term: string): Promise<Result<ServicePointOption[]>>;
  // Gera o EAN-13 do produto pelo backend central (owner/admin). Devolve o código.
  generateProductBarcode(productId: string): Promise<Result<string>>;
  printProduct(companyId: string, productId: string, deviceId: string | null, quantity: number, fields: ProductFields): Promise<{ error: string | null }>;
  printFree(companyId: string, deviceId: string | null, quantity: number, draft: FreeDraft): Promise<{ error: string | null }>;
  printServicePoint(companyId: string, pointId: string, deviceId: string | null, quantity: number, fields: PointFields): Promise<{ error: string | null }>;
}

// Vírgula/parênteses/aspas quebrariam o filtro .or() do PostgREST: viram espaço.
const clean = (term: string) => term.replace(/[,()"]/g, " ");

function fail<T>(error: { code?: string | null; message?: string | null }, fallback: string): Result<T> {
  console.error("Falha em etiquetas:", error.code ?? "sem código");
  return { data: null, error: describeOrderError(error, fallback) };
}

async function rpc(name: string, args: Record<string, unknown>): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc(name, args);
  if (error) {
    console.error(`Falha em ${name}:`, error.code ?? "sem código");
    return { error: describeOrderError(error, PRINT_ERROR) };
  }
  return { error: null };
}

export const supabaseLabelsSource: LabelsSource = {
  async listPrinters(companyId) {
    const { data, error } = await supabase.rpc("list_label_printers", { p_company_id: companyId });
    if (error) return fail(error, LOAD_ERROR);
    const rows = data as Array<{ id: string; name: string; width_mm: number; height_mm: number; gap_mm: number; columns: number; margin_x_mm: number; margin_y_mm: number; is_default: boolean; is_ready: boolean }>;
    return {
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        widthMm: Number(r.width_mm),
        heightMm: Number(r.height_mm),
        gapMm: Number(r.gap_mm),
        columns: Number(r.columns),
        marginXMm: Number(r.margin_x_mm),
        marginYMm: Number(r.margin_y_mm),
        isDefault: r.is_default,
        isReady: r.is_ready,
      })),
      error: null,
    };
  },

  async searchProducts(companyId, term) {
    const pattern = likePattern(clean(term));
    const { data, error } = await supabase
      .from("products")
      .select("id, name, code, barcode, sale_price")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .or(`name.ilike.${pattern},code.ilike.${pattern},barcode.ilike.${pattern}`)
      .order("name")
      .limit(20);
    if (error) return fail(error, LOAD_ERROR);
    const rows = (data ?? []) as Array<{ id: string; name: string; code: string; barcode: string | null; sale_price: number | string }>;
    return { data: rows.map((r) => ({ id: r.id, name: r.name, code: r.code, barcode: r.barcode, priceCents: Math.round(Number(r.sale_price) * 100) })), error: null };
  },

  async searchServicePoints(companyId, term) {
    const pattern = likePattern(clean(term));
    let query = supabase
      .from("service_points")
      .select("id, type, code, display_name, barcode")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("type")
      .order("code")
      .limit(30);
    if (term.trim() !== "") query = query.or(`code.ilike.${pattern},display_name.ilike.${pattern}`);
    const { data, error } = await query;
    if (error) return fail(error, LOAD_ERROR);
    const rows = (data ?? []) as Array<{ id: string; type: "command" | "table"; code: string; display_name: string; barcode: string | null }>;
    return { data: rows.map((r) => ({ id: r.id, type: r.type, code: r.code, displayName: r.display_name, barcode: r.barcode })), error: null };
  },

  async generateProductBarcode(productId) {
    const { data, error } = await supabase.rpc("generate_product_ean13", { p_product_id: productId, p_regenerate: false });
    if (error) return fail(error, "Não foi possível gerar o código de barras agora.");
    return { data: data as string, error: null };
  },

  printProduct: (companyId, productId, deviceId, quantity, f) =>
    rpc("enqueue_product_labels", {
      p_company_id: companyId,
      p_product_id: productId,
      p_device_id: deviceId,
      p_quantity: quantity,
      p_show_name: f.name,
      p_show_price: f.price,
      p_show_barcode: f.barcode,
      p_show_code: f.code,
      p_show_company: f.company,
    }),

  printFree: (companyId, deviceId, quantity, d) =>
    rpc("enqueue_free_labels", {
      p_company_id: companyId,
      p_device_id: deviceId,
      p_quantity: quantity,
      p_title: d.title.trim() || null,
      p_line1: d.line1.trim() || null,
      p_line2: d.line2.trim() || null,
      p_line3: d.line3.trim() || null,
      p_price_text: d.price.trim() || null,
      p_barcode: d.barcode.trim() || null,
      p_barcode_type: d.barcodeType satisfies BarcodeType,
      p_extra: d.extra.trim() || null,
      p_show_company: d.company,
    }),

  printServicePoint: (companyId, pointId, deviceId, quantity, f) =>
    rpc("enqueue_service_point_labels", {
      p_company_id: companyId,
      p_service_point_id: pointId,
      p_device_id: deviceId,
      p_quantity: quantity,
      p_show_barcode: f.barcode,
      p_show_code: f.code,
      p_show_company: f.company,
    }),
};
