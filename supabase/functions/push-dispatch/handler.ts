// Lógica da Edge Function push-dispatch: entrega o Web Push de UM push_event já gravado no banco.
// Separada de index.ts para receber as dependências por parâmetro (sem supabase-js nem web-push aqui).
//
// Chamada SÓ pelo banco (pg_net, push_dispatch_event) com o segredo compartilhado no header x-internal-secret
// (mínimo 32 caracteres, comparação em tempo constante). verify_jwt = false em supabase/config.toml: não há JWT
// de usuário nessa chamada. Nunca é chamada pelo frontend.
//
// Fluxo: segredo -> VAPID -> reivindica o evento (pending -> sending, atômico: só UM worker ganha) -> resolve
// destinatários NO SERVIDOR (push_event_targets: aparelho ativo + vínculo ativo + papel + setor, da mesma empresa)
// -> envia -> registra o resultado de cada aparelho (404/410 desativam; 5 falhas seguidas desativam) -> fecha o
// evento (sent / partial / failed).
//
// Configuração ausente (segredo/VAPID) responde 503 SEM reivindicar: o evento continua pending e o retry por cron
// o reenvia quando a configuração existir.
import {
  authorizeInternalRequest,
  type PushMessage,
  type PushTarget,
  type SendOptions,
  type SendResult,
} from "../_shared/push-core.ts";

export interface ClaimedEvent {
  id: string;
  event_type: string;
  title: string;
  body: string;
}

export interface EventTarget extends PushTarget {
  subscription_id: string;
  url: string;
}

export interface DispatchDeps {
  internalSecret: string | undefined;
  vapidConfigured(): boolean;
  // push_claim_event: devolve o evento se ESTE chamador ganhou a reivindicação, senão null.
  claimEvent(eventId: string): Promise<ClaimedEvent | null>;
  // push_event_targets
  loadTargets(eventId: string): Promise<EventTarget[]>;
  send(target: PushTarget, message: PushMessage, options: SendOptions): Promise<SendResult>;
  // push_record_outcome
  recordOutcome(subscriptionId: string, outcome: "ok" | "gone" | "error"): Promise<void>;
  // push_finish_event
  finishEvent(eventId: string, sent: number, failed: number, error: string | null): Promise<void>;
}

const JSON_HEADERS = { "Content-Type": "application/json" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONCURRENCY = 10;

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// Eventos operacionais (pedido) chegam com urgência alta e TTL curto; o resumo financeiro é normal.
export function kindOf(eventType: string): "order" | "default" {
  return eventType === "new_order" || eventType === "order_ready" || eventType === "order_cancelled_in_production" ? "order" : "default";
}

export async function handlePushDispatch(req: Request, deps: DispatchDeps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authorization = authorizeInternalRequest(deps.internalSecret, req.headers.get("x-internal-secret"));
  if (authorization === "misconfigured") {
    console.error("push-dispatch: PUSH_DISPATCH_SECRET ausente ou com menos de 32 caracteres");
    return json({ error: "Push dispatch unavailable" }, 503);
  }
  if (authorization === "unauthorized") {
    console.error("push-dispatch: chamada não autorizada recusada");
    return json({ error: "Unauthorized" }, 401);
  }

  if (!deps.vapidConfigured()) {
    console.error("push-dispatch: VAPID não configurado");
    return json({ error: "Push dispatch unavailable" }, 503);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON payload" }, 400);
  }
  const eventId = body && typeof body === "object" ? (body as Record<string, unknown>).event_id : null;
  if (typeof eventId !== "string" || !UUID.test(eventId)) return json({ error: "event_id is required" }, 400);

  let event: ClaimedEvent | null;
  try {
    event = await deps.claimEvent(eventId);
  } catch (e) {
    console.error("push-dispatch: falha ao reivindicar o evento", e);
    return json({ error: "Unable to claim event" }, 500);
  }
  // Já reivindicado/enviado por outro worker (ou evento inexistente): nada a fazer. 200 evita reentrega do pg_net.
  if (!event) return json({ claimed: false, sent: 0, failed: 0 });

  let targets: EventTarget[];
  try {
    targets = await deps.loadTargets(event.id);
  } catch (e) {
    console.error("push-dispatch: falha ao resolver destinatários", e);
    // fica 'sending': o retry por cron o devolve a pending (ou falha) depois do timeout
    return json({ error: "Unable to resolve recipients" }, 500);
  }

  const options: SendOptions = { kind: kindOf(event.event_type) };
  let sent = 0;
  let failed = 0;
  let lastError: string | null = null;

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (target) => {
        const result = await deps.send(
          { endpoint: target.endpoint, p256dh: target.p256dh, auth: target.auth },
          { title: event.title, body: event.body, url: target.url, notificationId: event.id },
          options,
        );
        if (result.outcome === "ok") sent += 1;
        else {
          failed += 1;
          lastError = result.outcome === "gone" ? "assinatura inválida (404/410)" : `falha de envio${result.statusCode ? ` (${result.statusCode})` : ""}`;
        }
        await deps.recordOutcome(target.subscription_id, result.outcome).catch((e) => console.error("push-dispatch: falha ao registrar resultado", e));
      }),
    );
  }

  await deps.finishEvent(event.id, sent, failed, lastError).catch((e) => console.error("push-dispatch: falha ao fechar o evento", e));
  return json({ claimed: true, targets: targets.length, sent, failed });
}
