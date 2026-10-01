// Assinatura Realtime da IMPRESSÃO (fila, impressoras, agentes e avisos de falha) da empresa ativa.
// Só AVISA que algo mudou e de qual tabela: quem chama recarrega do servidor (o payload nunca é o estado).
// O cliente entra por parâmetro para poder ser testado com um falso. Ordem validada no projeto:
// sessão autenticada -> realtime.setAuth() -> só então criar/assinar o channel, filtrando por company_id.
// O Realtime respeita a RLS (owner/admin); print_agents é publicada sem token_hash (migration 030000).
import type { RealtimeClientLike } from "../../lib/productsRealtime";

export type PrintTable = "print_jobs" | "print_devices" | "print_agents" | "print_enqueue_failures";

export const PRINT_TABLES: readonly PrintTable[] = ["print_jobs", "print_devices", "print_agents", "print_enqueue_failures"];

function rtLog(message: string) {
  console.info(`[realtime] ${message}`);
}

// Devolve o cancelamento (remove o channel; se o setup ainda estiver rodando, impede que ele seja criado).
// Ao RECONECTAR (SUBSCRIBED depois de CHANNEL_ERROR/TIMED_OUT/CLOSED) avisa todas as tabelas uma vez, para a
// tela recuperar o que passou durante a queda.
export function subscribeToPrintChanges(
  client: RealtimeClientLike,
  companyId: string,
  onChange: (table: PrintTable) => void,
): () => void {
  let disposed = false;
  let channel: ReturnType<RealtimeClientLike["channel"]> | null = null;

  void (async () => {
    try {
      const { data } = await client.auth.getSession();
      if (!data.session) throw new Error("sem sessão");
      await client.realtime.setAuth();
      rtLog("print auth ready");
    } catch {
      rtLog("print auth failed (visibilidade segue como fallback)");
      return;
    }
    if (disposed) return;

    let next = client.channel(`print:${companyId}:${Math.random().toString(36).slice(2)}`);
    for (const table of PRINT_TABLES) {
      for (const event of ["INSERT", "UPDATE"]) {
        next = next.on("postgres_changes", { event, schema: "public", table, filter: `company_id=eq.${companyId}` }, () => {
          if (!disposed) onChange(table);
        });
      }
    }
    channel = next;
    let wasDown = false;
    next.subscribe((status) => {
      rtLog(`print ${status}`);
      if (status === "SUBSCRIBED") {
        if (wasDown && !disposed) for (const table of PRINT_TABLES) onChange(table);
        wasDown = false;
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        wasDown = true;
      }
    });
  })();

  return () => {
    disposed = true;
    if (channel) void client.removeChannel(channel);
  };
}
