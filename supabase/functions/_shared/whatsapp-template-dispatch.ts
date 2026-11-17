// Despacho de uma mensagem de TEMPLATE 'queued' (Etapa 7.11E). Separado de whatsapp-dispatch.ts (envio de texto, que não foi alterado) e pensado para a
// Edge de iniciar conversa (7.11F). Fluxo:
//   1. service_role -> whatsapp_get_template_send_context: revalida TUDO (template aprovado e elegível, nome/idioma, variáveis, conexão, token, modo teste, OPT-OUT)
//      e faz o CLAIM atômico. Sem claim = não chama a Meta (outra chamada já despachou, ou o resultado anterior foi ambíguo).
//   2. Graph API (adapter whatsapp-template-send.ts), UMA tentativa, sem retry automático.
//   3. whatsapp_template_message_finish: 'sent' (grava o id da Meta), 'failed' (rejeição DEFINITIVA da Meta ou barreira local; libera a vaga) ou 'uncertain'
//      (timeout, rede, 5xx ou resposta sem id: a Meta pode ter aceitado; NADA reenvia sozinho e a vaga continua ocupada).
// Nenhum token, telefone, variável ou resposta bruta é registrado aqui.
import { classifyGraphAuthFailure, type DispatchRpcClient } from "./whatsapp-dispatch.ts";
import type { TemplateSender } from "./whatsapp-template-send.ts";

export const TEMPLATE_GENERIC_ERROR = "Não foi possível enviar o template agora. Tente novamente em instantes.";
export const TEMPLATE_UNCONFIRMED = "A Meta demorou ou deu uma resposta incerta. O envio pode ter sido aceito: confira o status da conversa antes de tentar de novo.";

export type TemplateDispatchResult =
  | { ok: true; status: "sent" }
  | { ok: false; outcome: "failed" | "uncertain" | "skipped"; errorCode: string; http: number; friendly: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

async function call(client: DispatchRpcClient, fn: string, args: Record<string, unknown>) {
  try {
    return await client.rpc(fn, args);
  } catch (e) {
    console.error("whatsapp-template-dispatch: rpc lançou exceção", { fn, name: e instanceof Error ? e.name : null });
    return { data: null, error: { message: "falha de comunicação" } };
  }
}

// motivos do contexto que são barreiras LOCAIS: a mensagem vira 'failed' (nada foi enviado) com mensagem amigável
const LOCAL_BLOCKS: Record<string, { http: number; friendly: string }> = {
  template_unavailable: { http: 409, friendly: "Este template não está mais aprovado ou disponível. Atualize os templates e escolha outro." },
  template_changed: { http: 409, friendly: "O template mudou depois da reserva. Tente novamente." },
  template_params_invalid: { http: 409, friendly: "As variáveis do template não são mais válidas para este template. Tente novamente." },
  opted_out: { http: 409, friendly: "Este contato pediu para não receber mensagens da empresa." },
  optout_check_failed: { http: 503, friendly: "Não foi possível verificar o bloqueio do contato. Por segurança o envio foi cancelado; tente novamente." },
  connection_inactive: { http: 409, friendly: "O WhatsApp desta empresa não está conectado." },
  module_inactive: { http: 403, friendly: "O módulo WhatsApp não está contratado." },
  token_expired: { http: 409, friendly: "A conexão do WhatsApp expirou ou foi revogada e precisa ser refeita. Procure o administrador da empresa." },
  token_revoked: { http: 409, friendly: "A conexão do WhatsApp expirou ou foi revogada e precisa ser refeita. Procure o administrador da empresa." },
  token_unavailable: { http: 503, friendly: "A conexão do WhatsApp não está disponível. Procure o administrador." },
  test_recipient_blocked: { http: 403, friendly: "Destinatário não autorizado no modo de teste." },
  conversation_unavailable: { http: 409, friendly: "A conversa não está mais disponível." },
};
// motivos que NÃO enviam e NÃO mexem em nada (outra chamada cuida, ou o resultado anterior foi ambíguo)
const SKIPPED: Record<string, { http: number; friendly: string }> = {
  already_claimed: { http: 202, friendly: "Este envio já está em andamento." },
  not_queued: { http: 200, friendly: "Esta mensagem já foi processada." },
  send_unconfirmed: { http: 202, friendly: TEMPLATE_UNCONFIRMED },
  not_template: { http: 400, friendly: TEMPLATE_GENERIC_ERROR },
  not_found: { http: 404, friendly: TEMPLATE_GENERIC_ERROR },
};

export async function dispatchQueuedTemplate(
  deps: { admin: DispatchRpcClient; sender: TemplateSender; graphVersion: string },
  messageId: string,
): Promise<TemplateDispatchResult> {
  const { admin, sender, graphVersion } = deps;
  const finish = async (outcome: "sent" | "failed" | "uncertain", providerId: string | null, code: string | null) => {
    let r = await call(admin, "whatsapp_template_message_finish", { p_message_id: messageId, p_outcome: outcome, p_provider_message_id: providerId, p_error_code: code });
    if (r.error && outcome === "sent") r = await call(admin, "whatsapp_template_message_finish", { p_message_id: messageId, p_outcome: outcome, p_provider_message_id: providerId, p_error_code: code });
    if (r.error) console.error("whatsapp-template-dispatch: não registrou o resultado", { outcome, code: r.error.code ?? null });
  };

  // 1) contexto + claim
  const ctxRes = await call(admin, "whatsapp_get_template_send_context", { p_message_id: messageId });
  const ctx = isObj(ctxRes.data) ? ctxRes.data : null;
  if (ctxRes.error || !ctx) {
    console.error("whatsapp-template-dispatch: contexto indisponível", { code: ctxRes.error?.code ?? null });
    await finish("failed", null, "context_error");
    return { ok: false, outcome: "failed", errorCode: "context_error", http: 502, friendly: TEMPLATE_GENERIC_ERROR };
  }
  if (ctx.ok !== true) {
    const reason = typeof ctx.error === "string" ? ctx.error : "context_error";
    const skip = SKIPPED[reason];
    if (skip) return { ok: false, outcome: "skipped", errorCode: reason, http: skip.http, friendly: skip.friendly };
    await finish("failed", null, reason);
    const blk = LOCAL_BLOCKS[reason];
    return { ok: false, outcome: "failed", errorCode: reason, http: blk?.http ?? 502, friendly: blk?.friendly ?? TEMPLATE_GENERIC_ERROR };
  }
  const phoneNumberId = typeof ctx.phone_number_id === "string" ? ctx.phone_number_id : "";
  const recipient = typeof ctx.recipient_phone === "string" ? ctx.recipient_phone : "";
  const token = typeof ctx.access_token === "string" ? ctx.access_token : "";
  const name = typeof ctx.template_name === "string" ? ctx.template_name : "";
  const language = typeof ctx.template_language === "string" ? ctx.template_language : "";
  const params = Array.isArray(ctx.parameters) && ctx.parameters.every((p) => typeof p === "string") ? (ctx.parameters as string[]) : null;
  const connectionId = typeof ctx.connection_id === "string" ? ctx.connection_id : "";
  if (!phoneNumberId || !recipient || !token || !name || !language || !params) {
    // o claim já foi usado: nenhuma chamada à Meta aconteceu, então é falha definitiva local
    await finish("failed", null, "context_error");
    return { ok: false, outcome: "failed", errorCode: "context_error", http: 502, friendly: TEMPLATE_GENERIC_ERROR };
  }

  // 2) Graph: UMA tentativa, sem retry
  const result = await sender.sendTemplate({ version: graphVersion, phoneNumberId, accessToken: token, to: recipient, name, language, parameters: params });
  if (result.ok) {
    await finish("sent", result.messageId, null);
    return { ok: true, status: "sent" };
  }

  // 3) falha: definitiva (a Meta recusou) x ambígua (a Meta pode ter aceitado)
  const definite = result.kind === "http" && typeof result.status === "number" && result.status >= 400 && result.status < 500;
  if (definite) {
    const code = (result.code ?? `http_${result.status}`).slice(0, 64);
    console.error("whatsapp-template-dispatch: Graph recusou", { status: result.status ?? null, code });
    const auth = classifyGraphAuthFailure(result);
    if (auth && connectionId) {
      const rep = await call(admin, "whatsapp_connection_report_token_failure", { p_connection_id: connectionId, p_kind: auth, p_code: result.code ?? null, p_subcode: result.subcode ?? null });
      if (rep.error) console.error("whatsapp-template-dispatch: não registrou a saúde do token", { code: rep.error.code ?? null });
    }
    await finish("failed", null, code);
    const friendly =
      auth === "invalid" ? "A conexão do WhatsApp precisa ser reconectada. Procure o administrador da empresa."
      : code === "131050" ? "Este contato pediu para não receber esse tipo de mensagem da empresa. O contato foi bloqueado para novas iniciações."
      : result.code === "10" || /^2[0-9]{2}$/.test(result.code ?? "") ? "A conexão do WhatsApp não tem permissão para enviar templates. Procure o administrador."
      : result.status === 429 ? "A Meta limitou os envios por agora. Tente novamente em alguns minutos."
      : "O WhatsApp recusou o template. Confira o contato e o template.";
    return { ok: false, outcome: "failed", errorCode: code, http: result.status === 429 ? 429 : 502, friendly };
  }
  const code = (result.kind === "http" ? `http_${result.status ?? "error"}` : result.kind).slice(0, 64);
  console.error("whatsapp-template-dispatch: resultado ambíguo da Meta", { kind: result.kind, status: result.status ?? null });
  await finish("uncertain", null, code);
  return { ok: false, outcome: "uncertain", errorCode: `unconfirmed_${code}`.slice(0, 64), http: result.kind === "timeout" ? 504 : 502, friendly: TEMPLATE_UNCONFIRMED };
}
