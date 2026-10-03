// Assinatura Realtime da tela de atendimentos abertos: UM channel com três tabelas da empresa
// (service_sessions: abrir/fechar; service_orders: pedido novo/cancelado; service_order_items:
// cancelamento de item muda o total). Só AVISA; o dado sempre vem de uma nova consulta. Ordem
// validada no projeto: getSession -> realtime.setAuth -> channel. Cliente por parâmetro (testável).
import type { RealtimeChannelLike, RealtimeClientLike } from "../../lib/productsRealtime";

export const OPEN_ATTENDANCE_TABLES = ["service_sessions", "service_orders", "service_order_items"] as const;

function rtLog(message: string) {
  console.info(`[realtime] ${message}`);
}

// `tag` só dá nome ao channel/log (cada tela abre o seu): a tela de Pedidos usa a mesma assinatura.
export function subscribeToOpenAttendanceChanges(
  client: RealtimeClientLike,
  companyId: string,
  onChange: () => void,
  tag = "open-attendances",
): () => void {
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

    let ch = client.channel(`${tag}:${companyId}:${Math.random().toString(36).slice(2)}`);
    for (const table of OPEN_ATTENDANCE_TABLES) {
      ch = ch.on("postgres_changes", { event: "*", schema: "public", table, filter: `company_id=eq.${companyId}` }, () => {
        rtLog(`${tag} ${table} change received`);
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
