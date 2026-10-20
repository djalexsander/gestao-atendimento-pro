// Edge Function whatsapp-order-notify (verify_jwt = false; chamada SÓ pelo banco via pg_cron/pg_net com x-internal-secret):
// WORKER dos avisos automáticos do pedido pelo WhatsApp (pronto para retirada / pronto para entrega / saiu para entrega).
//
// DETERMINÍSTICO: sem OpenAI, sem cota de IA, sem ai_job, sem mudar ai_control, sem atribuir atendente.
// Fluxo por notificação (outbox order_customer_notifications):
//   claim (lease, SKIP LOCKED, expira o vencido) -> prepare (REVALIDA flag, módulo, estado oficial do pedido, vínculo,
//   conversa, conexão, janela de 24 h e destinatário de teste; grava a mensagem origin='system' 'queued')
//   -> dispatch OFICIAL (_shared/whatsapp-dispatch.ts) -> finish (sent | retry com backoff | blocked_window | failed).
// Falha da Meta NUNCA altera produção/delivery/pedido: só a linha da outbox muda.
//
// Chave de segurança: WHATSAPP_ORDER_NOTIFY_ENABLED precisa ser exatamente "true". Qualquer outro valor => NADA é claimado
// nem enviado (as notificações apenas envelhecem e expiram sem aviso). Nunca é logado: telefone, texto, token, Authorization.
import { authorizeInternalRequest } from "../_shared/push-core.ts";
import { dispatchQueuedMessage, type DispatchRpcClient } from "../_shared/whatsapp-dispatch.ts";
import { isValidGraphVersion, type GraphSender } from "../_shared/whatsapp-graph.ts";

export type RpcClient = DispatchRpcClient;

export interface NotifyDeps {
  /** Secret compartilhado com o banco (x-internal-secret). */
  internalSecret: string | undefined;
  /** WHATSAPP_ORDER_NOTIFY_ENABLED: só "true" liga. */
  killSwitch: string | undefined;
  admin: RpcClient;
  graph: GraphSender;
  graphVersion: string | undefined;
  maxItems?: number;
}

const JSON_HEADERS = { "Content-Type": "application/json" };
const MAX_ITEMS = 10;
const CONCURRENCY = 3;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

async function call(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { code?: string; message: string } | null }> {
  try {
    return await client.rpc(fn, args);
  } catch (e) {
    console.error("whatsapp-order-notify: rpc lançou exceção", { fn, name: e instanceof Error ? e.name : null });
    return { data: null, error: { message: "falha de comunicação" } };
  }
}

/** Processa UMA notificação já reclamada. Devolve o resultado final registrado no banco. */
async function processOne(deps: NotifyDeps, notificationId: string): Promise<string> {
  const prep = await call(deps.admin, "order_notify_prepare", { p_id: notificationId });
  const p = isObj(prep.data) ? prep.data : null;
  if (prep.error || !p) {
    // prepare falhou antes de qualquer envio: libera para nova tentativa pelo backoff
    await call(deps.admin, "order_notify_finish", { p_id: notificationId, p_ok: false, p_error_code: "prepare_error" });
    return "prepare_error";
  }
  if (p.result === "retry") {
    await call(deps.admin, "order_notify_finish", {
      p_id: notificationId,
      p_ok: false,
      p_error_code: typeof p.reason === "string" ? p.reason : "retry",
    });
    return "retry";
  }
  if (p.result !== "queued" || typeof p.message_id !== "string") {
    // blocked_window | skipped | expired | not_active: o banco já gravou o estado final
    return typeof p.result === "string" ? p.result : "unknown";
  }

  const dispatch = await dispatchQueuedMessage(
    { admin: deps.admin, graph: deps.graph, graphVersion: deps.graphVersion as string },
    p.message_id,
  );
  if (dispatch.ok) {
    await call(deps.admin, "order_notify_finish", { p_id: notificationId, p_ok: true });
    return "sent";
  }
  const fin = await call(deps.admin, "order_notify_finish", { p_id: notificationId, p_ok: false, p_error_code: dispatch.errorCode });
  const r = isObj(fin.data) && typeof fin.data.result === "string" ? fin.data.result : "failed";
  return r;
}

export async function handleWhatsappOrderNotify(req: Request, deps: NotifyDeps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  const auth = authorizeInternalRequest(deps.internalSecret, req.headers.get("x-internal-secret"));
  if (auth === "misconfigured") {
    console.error("whatsapp-order-notify: segredo interno ausente ou curto");
    return json({ error: "Indisponível." }, 503);
  }
  if (auth !== "authorized") return json({ error: "Não autorizado." }, 401);

  // KILL SWITCH global: só "true" liga. Desligado, nada é claimado nem enviado.
  if (deps.killSwitch !== "true") return json({ processed: 0, disabled: true });

  if (!isValidGraphVersion(deps.graphVersion)) {
    console.error("whatsapp-order-notify: WHATSAPP_GRAPH_API_VERSION ausente ou inválida");
    return json({ error: "Indisponível." }, 503);
  }

  const claim = await call(deps.admin, "order_notify_claim", { p_limit: deps.maxItems ?? MAX_ITEMS, p_lease_seconds: 120 });
  if (claim.error) {
    console.error("whatsapp-order-notify: claim falhou", { code: claim.error.code ?? null });
    return json({ error: "Falha ao processar." }, 500);
  }
  const ids = isObj(claim.data) && Array.isArray(claim.data.ids)
    ? (claim.data.ids as unknown[]).filter((x): x is string => typeof x === "string")
    : [];

  const outcomes: string[] = [];
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    const done = await Promise.all(
      batch.map(async (nid) => {
        try {
          return await processOne(deps, nid);
        } catch (e) {
          // exceção inesperada: a notificação fica 'processing' e o lease expira (o claim a reaproveita ou encerra)
          console.error("whatsapp-order-notify: exceção", { name: e instanceof Error ? e.name : null });
          return "error";
        }
      }),
    );
    outcomes.push(...done);
  }
  const summary: Record<string, number> = {};
  for (const o of outcomes) summary[o] = (summary[o] ?? 0) + 1;
  return json({ processed: ids.length, outcomes: summary });
}
