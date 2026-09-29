import { supabase } from "../../lib/supabaseClient";
import {
  describeOrderError,
  toSubmitPayload,
  type CartItem,
  type CatalogCategory,
  type CatalogProduct,
  type SubmittedOrder,
} from "./ordersLogic";

const LOAD_ERROR = "Não foi possível carregar esta tela agora. Tente novamente.";
const CATALOG_ERROR = "Não foi possível carregar o catálogo agora. Tente novamente.";
const ORDERS_ERROR = "Não foi possível carregar os pedidos agora. Tente novamente.";
const SUBMIT_ERROR = "Não foi possível enviar o pedido agora. Tente novamente.";
const SESSION_NOT_FOUND = "Este atendimento não foi encontrado.";

const IMAGE_BUCKET = "product-images";
// 1h: tempo de sobra para uma sessão de atendimento; a URL não é persistida em lugar nenhum, só
// usada em memória para os <img> do catálogo. Mesmo padrão de features/catalog/productsApi.ts.
const SIGNED_URL_TTL_SECONDS = 3600;

export interface SessionHeader {
  id: string;
  companyId: string;
  status: "open" | "closed";
  customerName: string | null;
  openedAt: string;
  openedByName: string | null;
  point: { id: string; type: "command" | "table"; code: string; displayName: string };
}

// Fonte de dados do fluxo de pedido. Recebida por parâmetro (a real, abaixo, é o padrão) para
// poder exercitar a tela com dados simulados, sem login e sem banco. Mesmo padrão de
// features/catalog/productsApi.ts e features/operations/api.ts.
export interface OrdersSource {
  loadSessionHeader(sessionId: string): Promise<{ data: SessionHeader | null; error: string | null }>;
  loadCatalog(companyId: string): Promise<{ data: { categories: CatalogCategory[]; products: CatalogProduct[] } | null; error: string | null }>;
  // path -> URL assinada (bucket privado); caminhos que falharem ficam de fora do Map.
  getImageUrls(paths: string[]): Promise<Map<string, string>>;
  loadOrders(sessionId: string): Promise<{ data: SubmittedOrder[] | null; error: string | null }>;
  // Só o essencial sai da cesta (ver toSubmitPayload): product_id, quantity, notes. Preço, nome,
  // setor e origem são sempre determinados pelo servidor (submit_service_order).
  submitOrder(sessionId: string, cart: CartItem[]): Promise<{ error: string | null }>;
  // Avisa (sem payload) que um pedido daquela sessão mudou; a tela recarrega do banco. Devolve o
  // cancelamento da assinatura. Falha do Realtime é silenciosa: o fallback por foco cobre.
  subscribeToOrders(sessionId: string, onChange: () => void): () => void;
}

async function loadProfileNames(userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = Array.from(new Set(userIds));
  if (unique.length === 0) return map;
  const { data, error } = await supabase.from("profiles").select("user_id, full_name").in("user_id", unique);
  if (error || !data) {
    console.error("Falha ao carregar nomes de perfil:", error?.code);
    return map;
  }
  for (const row of data as { user_id: string; full_name: string | null }[]) {
    if (row.full_name) map.set(row.user_id, row.full_name);
  }
  return map;
}

// O cliente sem tipos gerados do banco tipa TODO embed N:1 como array (mesmo problema de
// productsApi.ts). Normaliza para objeto único ou null.
function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export const supabaseOrdersSource: OrdersSource = {
  async loadSessionHeader(sessionId) {
    const { data, error } = await supabase
      .from("service_sessions")
      .select("id, company_id, status, customer_name, opened_at, opened_by, point:service_points(id, type, code, display_name)")
      .eq("id", sessionId)
      .maybeSingle();
    if (error) {
      console.error("Falha ao carregar o atendimento:", error.code);
      return { data: null, error: LOAD_ERROR };
    }
    if (!data) return { data: null, error: SESSION_NOT_FOUND };

    const row = data as unknown as {
      id: string;
      company_id: string;
      status: "open" | "closed";
      customer_name: string | null;
      opened_at: string;
      opened_by: string;
      point: SessionHeader["point"] | SessionHeader["point"][] | null;
    };
    const point = one(row.point);
    if (!point) return { data: null, error: SESSION_NOT_FOUND };

    const names = await loadProfileNames([row.opened_by]);
    return {
      data: {
        id: row.id,
        companyId: row.company_id,
        status: row.status,
        customerName: row.customer_name,
        openedAt: row.opened_at,
        openedByName: names.get(row.opened_by) ?? null,
        point,
      },
      error: null,
    };
  },

  async loadCatalog(companyId) {
    const [categoriesRes, productsRes] = await Promise.all([
      supabase
        .from("product_categories")
        .select("id, name, sort_order")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("sort_order")
        .order("name"),
      supabase
        .from("products")
        .select("id, category_id, name, description, code, barcode, sale_price, image_path")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("name"),
    ]);
    if (categoriesRes.error || productsRes.error) {
      console.error("Falha ao carregar o catálogo:", categoriesRes.error?.code ?? productsRes.error?.code);
      return { data: null, error: CATALOG_ERROR };
    }

    const categories = (categoriesRes.data ?? []).map((c) => ({ id: c.id, name: c.name, sortOrder: c.sort_order })) as CatalogCategory[];
    // Categoria ativa é responsabilidade nossa aqui (não só da RLS): owner/admin, que também
    // acessam esta tela no futuro, enxergam produto de categoria inativa via RLS — o catálogo
    // operacional nunca deve mostrá-lo, então filtramos pelo conjunto de categorias ativas.
    const activeCategoryIds = new Set(categories.map((c) => c.id));
    const products = (productsRes.data ?? [])
      .filter((p) => activeCategoryIds.has(p.category_id))
      .map((p) => ({
        id: p.id,
        categoryId: p.category_id,
        name: p.name,
        description: p.description,
        code: p.code,
        barcode: p.barcode,
        salePrice: Number(p.sale_price),
        imagePath: p.image_path,
      })) as CatalogProduct[];

    return { data: { categories, products }, error: null };
  },

  async getImageUrls(paths) {
    const map = new Map<string, string>();
    const unique = Array.from(new Set(paths));
    if (unique.length === 0) return map;
    const { data, error } = await supabase.storage.from(IMAGE_BUCKET).createSignedUrls(unique, SIGNED_URL_TTL_SECONDS);
    if (error || !data) {
      console.error("Falha ao gerar URLs assinadas das fotos:", error?.message);
      return map;
    }
    data.forEach((item, index) => {
      if (item.signedUrl && !item.error) map.set(unique[index], item.signedUrl);
    });
    return map;
  },

  async loadOrders(sessionId) {
    const { data, error } = await supabase
      .from("service_orders")
      .select(
        "id, origin, status, submitted_at, created_by, " +
          "items:service_order_items(id, product_id, product_name_snapshot, quantity, unit_price, notes, sector:production_sectors(name))",
      )
      .eq("service_session_id", sessionId)
      .order("submitted_at", { ascending: false });
    if (error) {
      console.error("Falha ao carregar os pedidos:", error.code);
      return { data: null, error: ORDERS_ERROR };
    }

    type RawItem = {
      id: string;
      product_id: string;
      product_name_snapshot: string;
      quantity: number;
      unit_price: number;
      notes: string | null;
      sector: { name: string } | { name: string }[] | null;
    };
    type RawOrder = {
      id: string;
      origin: SubmittedOrder["origin"];
      status: SubmittedOrder["status"];
      submitted_at: string;
      created_by: string;
      items: RawItem[];
    };
    const rows = (data ?? []) as unknown as RawOrder[];
    const names = await loadProfileNames(rows.map((r) => r.created_by));

    const orders: SubmittedOrder[] = rows.map((row) => ({
      id: row.id,
      origin: row.origin,
      status: row.status,
      submittedAt: row.submitted_at,
      createdByName: names.get(row.created_by) ?? null,
      items: row.items.map((item) => ({
        id: item.id,
        productId: item.product_id,
        productNameSnapshot: item.product_name_snapshot,
        quantity: item.quantity,
        unitPrice: Number(item.unit_price),
        notes: item.notes,
        sectorName: one(item.sector)?.name ?? null,
      })),
    }));
    return { data: orders, error: null };
  },

  async submitOrder(sessionId, cart) {
    const { error } = await supabase.rpc("submit_service_order", {
      p_service_session_id: sessionId,
      p_items: toSubmitPayload(cart),
    });
    if (error) return { error: describeOrderError(error, SUBMIT_ERROR) };
    return { error: null };
  },
  subscribeToOrders(sessionId, onChange) {
    const channel = supabase
      .channel(`service-orders:${sessionId}:${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "service_orders", filter: `service_session_id=eq.${sessionId}` },
        () => onChange(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  },
};
