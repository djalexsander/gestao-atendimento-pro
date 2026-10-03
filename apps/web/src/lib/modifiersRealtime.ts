// Assinatura Realtime dos CADASTROS de adicionais da empresa (grupos, opções e vínculos produto/grupo).
// Só AVISA que algo mudou: quem chama recarrega o catálogo do servidor. O snapshot dos pedidos
// (service_order_item_modifiers) não é assinado. Mesmo padrão de productsRealtime.ts: sessão autenticada
// -> realtime.setAuth() -> só então o channel; filtro company_id=eq.<empresa>; cleanup remove o channel.
import type { RealtimeChannelLike, RealtimeClientLike } from "./productsRealtime";

export const MODIFIER_TABLES = ["product_modifier_groups", "product_modifier_options", "product_modifier_group_products"] as const;

function rtLog(message: string) {
  console.info(`[realtime] ${message}`);
}

export function subscribeToModifierChanges(client: RealtimeClientLike, companyId: string, tag: string, onChange: () => void): () => void {
  let disposed = false;
  let channel: RealtimeChannelLike | null = null;

  void (async () => {
    try {
      const { data } = await client.auth.getSession();
      if (!data.session) throw new Error("sem sessão");
      await client.realtime.setAuth();
      rtLog(`${tag} auth ready`);
    } catch {
      rtLog(`${tag} auth failed (foco/visibilidade seguem como fallback)`);
      return;
    }
    if (disposed) return;

    const ch = client.channel(`${tag}:${companyId}:${Math.random().toString(36).slice(2)}`);
    for (const table of MODIFIER_TABLES) {
      ch.on("postgres_changes", { event: "*", schema: "public", table, filter: `company_id=eq.${companyId}` }, () => {
        rtLog(`${tag} change received (${table})`);
        onChange();
      });
    }
    channel = ch;
    ch.subscribe((status) => rtLog(`${tag} ${status}`));
  })();

  return () => {
    disposed = true;
    if (channel) void client.removeChannel(channel);
  };
}
