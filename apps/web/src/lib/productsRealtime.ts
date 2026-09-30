// Assinatura Realtime de PRODUTOS da empresa (estoque, disponibilidade, modo de controle, ativo).
// Só AVISA que algo mudou: quem chama recarrega do servidor (nunca soma saldo pelo payload). O
// cliente entra por parâmetro (sem importar o supabase aqui) para poder ser testado com um falso.
//
// Ordem validada no projeto (ver operations/api.ts): sessão autenticada -> realtime.setAuth() ->
// só então criar/assinar o channel. Filtro por company_id (nunca ouve products de outras empresas).

export interface RealtimeChannelLike {
  on(type: "postgres_changes", filter: { event: string; schema: string; table: string; filter: string }, callback: () => void): RealtimeChannelLike;
  subscribe(callback?: (status: string) => void): unknown;
}

export interface RealtimeClientLike {
  auth: { getSession(): Promise<{ data: { session: unknown | null } }> };
  realtime: { setAuth(): Promise<unknown> };
  channel(name: string): RealtimeChannelLike;
  removeChannel(channel: RealtimeChannelLike): unknown;
}

function rtLog(message: string) {
  console.info(`[realtime] ${message}`);
}

// Devolve o cancelamento da assinatura (remove o channel; se o setup ainda estiver rodando, impede
// que o channel seja criado).
export function subscribeToProductChanges(
  client: RealtimeClientLike,
  companyId: string,
  tag: string,
  onChange: () => void,
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

    channel = client
      .channel(`${tag}:${companyId}:${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "products", filter: `company_id=eq.${companyId}` }, () => {
        rtLog(`${tag} change received`);
        onChange();
      });
    channel.subscribe((status) => rtLog(`${tag} ${status}`)); // SUBSCRIBED / CHANNEL_ERROR / TIMED_OUT / CLOSED
  })();

  return () => {
    disposed = true;
    if (channel) void client.removeChannel(channel);
  };
}
