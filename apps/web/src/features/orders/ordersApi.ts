import type { RealtimeChannel } from "@supabase/supabase-js";
import { subscribeToProductChanges, type RealtimeClientLike } from "../../lib/productsRealtime";
import { supabase } from "../../lib/supabaseClient";
import { createBroadcastGate, type BroadcastGate } from "./broadcastGate";
import {
  describeOrderError,
  toSubmitPayload,
  type CartItem,
  type CatalogCategory,
  type CatalogProduct,
  type ItemCancellation,
  type SubmittedOrder,
} from "./ordersLogic";

const LOAD_ERROR = "Não foi possível carregar esta tela agora. Tente novamente.";
const CATALOG_ERROR = "Não foi possível carregar o catálogo agora. Tente novamente.";
const ORDERS_ERROR = "Não foi possível carregar os pedidos agora. Tente novamente.";
const CANCEL_ERROR = "Não foi possível cancelar o item agora. Tente novamente.";
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
  // Cancela quantidade de um item de conta ABERTA (nunca apaga; evento auditável). O servidor valida
  // papel, quantidade e se o item já entrou em produção.
  cancelItem(itemId: string, quantity: number, reason: string): Promise<{ error: string | null }>;
  // Avisa (sem payload de dados) que um pedido daquela sessão mudou; a tela recarrega do banco.
  // Dois caminhos: Broadcast (rápido, enviado pelo próprio app depois do submit) e
  // postgres_changes (fallback). Devolve o cancelamento das assinaturas. Falha do Realtime é
  // silenciosa: o fallback por foco cobre.
  subscribeToOrders(sessionId: string, onChange: () => void): () => void;
  // Avisa (sem dados) que um produto da empresa mudou (estoque/disponibilidade): a tela recarrega o
  // catálogo. Só UX — submit_service_order continua validando o saldo real. Opcional (fontes simuladas).
  subscribeToProducts?(companyId: string, onChange: () => void): () => void;
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

// Canal de Broadcast por atendimento, aberto enquanto a tela está montada. O "gate" garante que o
// aviso só sai com o canal SUBSCRIBED (ou fica pendente até lá). Só o aviso "order-submitted" com o
// sessionId trafega: o conteúdo do pedido sempre vem do banco (loadOrders).
const broadcastGates = new Map<string, BroadcastGate>();
const BROADCAST_EVENT = "order-submitted";

// Diagnóstico do Realtime (temporário): só estados técnicos, nunca token, ids ou dados do pedido.
function rtLog(message: string) {
  console.info(`[realtime] ${message}`);
}

// Não bloqueia nem falha o envio do pedido: sem canal/erro, postgres_changes e o foco cobrem.
function notifyOrderSubmitted(sessionId: string) {
  broadcastGates.get(sessionId)?.notify();
}

export const supabaseOrdersSource: OrdersSource = {
  subscribeToProducts(companyId, onChange) {
    return subscribeToProductChanges(supabase as unknown as RealtimeClientLike, companyId, "catalog-products", onChange);
  },

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
      point: RawPoint | RawPoint[] | null;
    };
    // O banco devolve snake_case (display_name); a tela usa camelCase (displayName).
    type RawPoint = { id: string; type: "command" | "table"; code: string; display_name: string };
    const rawPoint = one(row.point);
    if (!rawPoint) return { data: null, error: SESSION_NOT_FOUND };
    const point: SessionHeader["point"] = {
      id: rawPoint.id,
      type: rawPoint.type,
      code: rawPoint.code,
      displayName: rawPoint.display_name,
    };

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
        .select("id, category_id, name, description, code, barcode, sale_price, image_path, available_for_sale, stock_control, stock_quantity, minimum_stock_quantity")
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
        availableForSale: p.available_for_sale,
        stockControl: p.stock_control,
        stockQuantity: p.stock_quantity,
        minimumStockQuantity: p.minimum_stock_quantity,
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
          "items:service_order_items(id, product_id, product_name_snapshot, quantity, unit_price, notes, production_status, cancelled_quantity, sector:production_sectors(name))",
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
      production_status: SubmittedOrder["items"][number]["productionStatus"];
      cancelled_quantity: number;
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
    // Eventos de cancelamento dos itens carregados (uma consulta; só itens com algo cancelado).
    const cancelledIds = rows.flatMap((r) => r.items.filter((i) => i.cancelled_quantity > 0).map((i) => i.id));
    type RawCancellation = { id: string; service_order_item_id: string; quantity: number; reason: string; created_at: string; cancelled_by: string };
    let rawCancellations: RawCancellation[] = [];
    if (cancelledIds.length > 0) {
      const { data: cancelData, error: cancelError } = await supabase
        .from("service_order_item_cancellations")
        .select("id, service_order_item_id, quantity, reason, created_at, cancelled_by")
        .in("service_order_item_id", cancelledIds)
        .order("created_at", { ascending: true });
      if (cancelError) {
        console.error("Falha ao carregar os cancelamentos:", cancelError.code);
        return { data: null, error: ORDERS_ERROR };
      }
      rawCancellations = (cancelData ?? []) as RawCancellation[];
    }
    const names = await loadProfileNames([...rows.map((r) => r.created_by), ...rawCancellations.map((c) => c.cancelled_by)]);
    const cancellationsByItem = new Map<string, ItemCancellation[]>();
    for (const c of rawCancellations) {
      const list = cancellationsByItem.get(c.service_order_item_id) ?? [];
      list.push({ id: c.id, quantity: c.quantity, reason: c.reason, createdAt: c.created_at, cancelledByName: names.get(c.cancelled_by) ?? null });
      cancellationsByItem.set(c.service_order_item_id, list);
    }

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
        productionStatus: item.production_status,
        cancelledQuantity: item.cancelled_quantity,
        cancellations: cancellationsByItem.get(item.id) ?? [],
      })),
    }));
    return { data: orders, error: null };
  },

  async cancelItem(itemId, quantity, reason) {
    const { error } = await supabase.rpc("cancel_service_order_item", {
      p_item_id: itemId,
      p_quantity: quantity,
      p_reason: reason,
    });
    if (error) {
      console.error("Falha ao cancelar o item:", error.code);
      return { error: describeOrderError(error, CANCEL_ERROR) };
    }
    return { error: null };
  },

  async submitOrder(sessionId, cart) {
    const { error } = await supabase.rpc("submit_service_order", {
      p_service_session_id: sessionId,
      p_items: toSubmitPayload(cart),
    });
    if (error) return { error: describeOrderError(error, SUBMIT_ERROR) };
    // Só depois do RPC confirmar: avisa os outros aparelhos com esta comanda aberta.
    notifyOrderSubmitted(sessionId);
    return { error: null };
  },
  subscribeToOrders(sessionId, onChange) {
    const suffix = Math.random().toString(36).slice(2);
    let disposed = false;
    let broadcast: RealtimeChannel | null = null;
    let changes: RealtimeChannel | null = null;

    // O "gate" nasce já e recebe avisos pendentes enquanto o setup assíncrono ainda roda; só envia
    // com o canal SUBSCRIBED. Sem canal (setup falhou ou tela saiu) o pendente é descartado.
    const gate = createBroadcastGate(() => {
      void broadcast
        ?.send({ type: "broadcast", event: BROADCAST_EVENT, payload: { sessionId } })
        .then((result) => rtLog(`broadcast send ${String(result)}`))
        .catch(() => undefined);
    });
    broadcastGates.set(sessionId, gate);

    void (async () => {
      // 1) sessão autenticada -> 2) Realtime autenticado (sem token manual: o supabase-js lê o
      // token atual e o renova sozinho) -> 3) só então os canais (o privado exige autorização).
      try {
        const { data } = await supabase.auth.getSession();
        if (!data.session) throw new Error("sem sessão");
        await supabase.realtime.setAuth();
        rtLog("auth ready");
      } catch {
        rtLog("auth failed (canais não criados; foco/visibilidade seguem como fallback)");
        return;
      }
      if (disposed) return; // saiu da tela durante o await: não cria canal nenhum

      // Caminho rápido: Broadcast PRIVADO por atendimento (RLS em realtime.messages, migration
      // 20260929050000). self:false — quem envia não recebe o próprio aviso.
      broadcast = supabase
        .channel(`service-session:${sessionId}`, { config: { private: true, broadcast: { self: false } } })
        .on("broadcast", { event: BROADCAST_EVENT }, (message) => {
          // Só confere a quem se refere; nenhum dado do payload é usado além disso.
          const payload = message.payload as { sessionId?: string } | undefined;
          if (payload?.sessionId === sessionId) {
            rtLog("broadcast received");
            onChange();
          }
        })
        .subscribe((status) => {
          rtLog(`broadcast ${status}`);
          gate.onStatus(status);
        });

      // Fallback: mudanças na tabela (independe do app que gravou). Criado DEPOIS da autenticação.
      changes = supabase
        .channel(`service-orders:${sessionId}:${suffix}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "service_orders", filter: `service_session_id=eq.${sessionId}` },
          () => {
            rtLog("postgres change received");
            onChange();
          },
        )
        .subscribe((status) => rtLog(`postgres_changes ${status}`));
    })();

    return () => {
      disposed = true;
      gate.dispose();
      if (broadcastGates.get(sessionId) === gate) broadcastGates.delete(sessionId);
      if (broadcast) void supabase.removeChannel(broadcast);
      if (changes) void supabase.removeChannel(changes);
    };
  },
};
