// Lógica da Edge Function push-test: envia uma notificação de TESTE só para UM aparelho do usuário autenticado.
// Separada de index.ts para receber as dependências por parâmetro (sem supabase-js nem web-push aqui).
//
// Regras de segurança:
//   * JWT obrigatório (verify_jwt em supabase/config.toml e o handler valida o token de novo). O usuário vem do
//     JWT, nunca do corpo da requisição.
//   * O corpo traz só { device_id }. O aparelho precisa ser do próprio usuário, estar ativo e o vínculo dele na
//     empresa precisa continuar ativo — quem decide é push_test_target (service_role), não o frontend.
//   * endpoint/chaves do aparelho nunca saem desta função (a resposta só diz o resultado).
//   * 404/410 desativam o aparelho; outras falhas somam failure_count (5 seguidas desativam) — push_record_outcome.
import { type PushMessage, type PushTarget, type SendResult, type SendOptions } from "../_shared/push-core.ts";

export interface TestHandlerDeps {
  // Valida o JWT e devolve o id do usuário (ou null).
  getUserId(jwt: string): Promise<string | null>;
  // service_role: alvo do teste (credenciais) para ESTE usuário e aparelho; null se não for dele/ativo/vínculo ativo.
  loadTarget(userId: string, deviceId: string): Promise<(PushTarget & { subscriptionId: string; url: string }) | null>;
  send(target: PushTarget, message: PushMessage, options: SendOptions): Promise<SendResult>;
  recordOutcome(subscriptionId: string, outcome: "ok" | "gone" | "error"): Promise<void>;
  // false = VAPID não configurado neste ambiente
  vapidConfigured(): boolean;
  newId(): string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const JSON_HEADERS = { ...CORS_HEADERS, "Content-Type": "application/json" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export const TEST_TITLE = "Gestão Atendimento Pro";
export const TEST_BODY = "Notificações ativadas com sucesso.";

export async function handlePushTest(req: Request, deps: TestHandlerDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  const authorization = req.headers.get("Authorization") ?? "";
  const jwt = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ error: "Sessão inválida." }, 401);
  const userId = await deps.getUserId(jwt).catch(() => null);
  if (!userId) return json({ error: "Sessão inválida." }, 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Requisição inválida." }, 400);
  }
  const deviceId = body && typeof body === "object" ? (body as Record<string, unknown>).device_id : null;
  if (typeof deviceId !== "string" || !UUID.test(deviceId)) {
    return json({ error: "Informe o aparelho." }, 400);
  }

  if (!deps.vapidConfigured()) {
    console.error("push-test: VAPID não configurado");
    return json({ error: "Notificações ainda não estão configuradas neste ambiente." }, 503);
  }

  const target = await deps.loadTarget(userId, deviceId).catch(() => null);
  if (!target) return json({ error: "Aparelho não encontrado ou desativado." }, 404);

  const result = await deps.send(
    { endpoint: target.endpoint, p256dh: target.p256dh, auth: target.auth },
    { title: TEST_TITLE, body: TEST_BODY, url: target.url, notificationId: `test:${deps.newId()}` },
    { kind: "default" },
  );
  await deps.recordOutcome(target.subscriptionId, result.outcome).catch((e) => console.error("push-test: falha ao registrar resultado", e));

  if (result.outcome === "ok") return json({ sent: true });
  if (result.outcome === "gone") return json({ sent: false, reason: "device_gone", error: "Este aparelho não recebe mais notificações. Ative de novo." }, 410);
  return json({ sent: false, reason: "send_failed", error: "Não foi possível enviar agora. Tente novamente." }, 502);
}
