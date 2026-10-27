// Fluxo do PEDIDO conversacional (modo AUTOMÁTICO) — orquestra as RPCs whatsapp_order_* (banco = fonte de verdade) com um
// EXTRATOR de operações (modelo) e templates determinísticos. Sem rede e sem Deno aqui: toda entrada/saída passa por OrderFlowIo
// (o handler injeta cota, provedor, commit/dispatch oficial e encerramento do job). Nada aqui loga mensagem, endereço, nome ou
// telefone: só códigos.
//
// Garantias:
//  * Nenhuma mutação com contexto velho (RPCs recebem p_expected_latest); reprocessamento do MESMO job pula as mensagens já
//    aplicadas (p_tail_count / state.applied) => nada de item duplicado depois de reagendamento.
//  * Produto/opção/preço/taxa/zona/total/estoque: sempre do banco. O modelo só devolve TEXTO de produto e números.
//  * Confirmação do cliente: regra determinística (ai-order.ts), nunca o modelo. Pedido oficial só pela RPC de confirmação.
//  * Toda resposta ao cliente é template. "Pedido confirmado" só com result='created' vindo do banco.
import { norm, type AutoMessage } from "./ai-auto.ts";
import {
  LEGACY_SHOW_OPTIONS_RE, MSG_ALREADY_CONFIRMED, MSG_CANCEL_AFTER_ORDER, MSG_CANCELLED, MSG_CHOICE_GIVEUP, MSG_FAILED, MSG_NOT_FOUND, MSG_NO_DRAFT, MSG_REPROMPT, MSG_TOO_BIG,
  boundedTail, countChoiceAsks, parseChoiceQuestion, parseLetterReply, pickChoice, renderChoice, renderLetterChoice, MSG_CHOICE_EXPIRED, buildOrderSystemPrompt, buildOrderUserBlock, classifyConfirmationBatch, decideQuantity, hasOrderVerb, isCancelIntent, looksLikeItemList, matchItem,
  nextQuestion, parseOrderState, plain, removalIntent, renderAmbiguous, renderAskQuantity, renderCreated, renderPriceChanges, renderSummary,
  renderUnavailable, renderZoneAmbiguous, startsWithQuantity, validateExtraction, brl, PAYMENT_LABELS,
  type ExtractedOp, type OrderState,
} from "./ai-order.ts";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export interface RpcResult { data: unknown; error: { code?: string; message: string } | null }
export interface OrderFlowIo {
  rpc(fn: string, args: Record<string, unknown>): Promise<RpcResult>;
  /** Chama o modelo (reserva de cota, timeout, finalização do uso). Em falha o JOB JÁ FOI ENCERRADO e devolve o desfecho. */
  extract(system: string, user: string, validate: (text: string) => boolean): Promise<{ ok: true; text: string } | { ok: false; outcome: string }>;
  /** UMA resposta pelo caminho oficial (commit + dispatch). onSent roda depois do envio ok, com o id da mensagem. */
  reply(body: string, o: { outcome: "replied" | "handoff"; reason: string; onSent?: (messageId: string) => Promise<void> }): Promise<string>;
  complete(outcome: string, reason: string | null, o?: { handled?: string | null; handoff?: boolean }): Promise<string>;
}
export interface OrderFlowInput {
  jobId: string;
  latest: string;
  messages: AutoMessage[];
  businessName: string | null;
  customerFirstName: string | null;
  fallback: boolean;
  pre: { action: "handoff" | "ignore"; reason_code: string } | null;
}
export type OrderFlowResult = { handled: false; active: boolean } | { handled: true; outcome: string };

class StaleContext extends Error {}
class FlowAbort extends Error { constructor(public outcome: string, public reason: string, public handoff = false) { super(outcome); } }

const DISABLED_REASONS = new Set(["order_drafts_disabled", "mode_not_auto", "module_inactive"]);
const GENERIC_TYPE_RE = /\b(cervejas?|refrigerantes?|refris?)\b/g;
// pergunta NOVA (com letras): a que já foi respondida/resolvida NÃO pode voltar pelo caminho de compatibilidade das perguntas antigas
const LETTER_PROMPT_RE = /Responda [A-E](?: |,|\.)/;
const EDIT_RE = /(alterar|mudar|trocar|tirar|tira|remover|retirar|adicionar|colocar|coloca) /;
const OUR_QUESTION_RE = /^(quantos |atendemos mais de um bairro|qual voc[eê] prefere|para .*:|para a entrega|prefere retirada|ser[aá] (entrega|retirada)|como prefere pagar|vai precisar de troco|em nome de quem|o que voc[eê] gostaria|n[aã]o encontrei esse item|n[aã]o encontrei exatamente|n[aã]o consegui identificar|para [^\n]*encontrei est|preciso rever|n[aã]o entregamos|no momento n[aã]o)/;
const isOurQuestion = (t: string | null) => !!t && (OUR_QUESTION_RE.test(norm(t).replace(/^anotei[^\n]*\n/, "")) || !!parseChoiceQuestion(t));
const isMissingFunction = (e: { code?: string; message: string }) => e.code === "42883" || e.code === "PGRST202" || /could not find the function|does not exist/i.test(e.message);

interface Ack { kind: "add" | "remove" | "change"; text: string }
interface Unit { ops: Array<Record<string, unknown>>; acks: Ack[] }

export async function runOrderFlow(io: OrderFlowIo, input: OrderFlowInput): Promise<OrderFlowResult> {
  const { jobId, latest } = input;
  const got = await io.rpc("whatsapp_order_get_state", { p_job_id: jobId });
  if (got.error) {
    if (isMissingFunction(got.error)) return { handled: false, active: false };   // migrations ainda não aplicadas: fluxo antigo
    console.error("whatsapp-order: get_state falhou", { code: got.error.code ?? null });
    return { handled: true, outcome: "left_for_retry" };
  }
  const g = isObj(got.data) ? got.data : null;
  if (!g) return { handled: true, outcome: "left_for_retry" };
  if (g.result === "blocked") {
    const reason = String(g.reason ?? "");
    if (DISABLED_REASONS.has(reason)) return { handled: false, active: false };
    if (reason === "human_control") return { handled: true, outcome: await io.complete("aborted_human", "ai_paused") };
    if (reason === "conversation_closed" || reason === "conversation_missing") return { handled: true, outcome: await io.complete("aborted_closed", reason) };
    return { handled: true, outcome: "not_active" };
  }
  const state = parseOrderState(g.state);

  const inbound = boundedTail(input.messages).filter((m) => m.direction === "inbound");
  const skip = state && state.applied.job_id === jobId ? Math.min(state.applied.tail_count ?? 0, inbound.length) : 0;
  const fresh = inbound.slice(skip);
  const texts = fresh.filter((m) => m.type === undefined || m.type === "text" || m.type === "interactive").map((m) => m.text);
  const joined = texts.join(" ");
  const lastBot = [...input.messages].reverse().find((m) => m.direction === "outbound")?.text ?? null;

  try {
    // 1) cancelar (antes de qualquer outra coisa; depois do pedido oficial a IA NÃO cancela)
    if (texts.length > 0 && isCancelIntent(texts[texts.length - 1])) {
      const c = await mutate(io, "whatsapp_order_cancel", { p_job_id: jobId, p_expected_latest: latest });
      if (c.result === "cancelled") return { handled: true, outcome: await io.reply(MSG_CANCELLED, { outcome: "replied", reason: "order_cancelled" }) };
      if (c.result === "already_confirmed") return { handled: true, outcome: await io.reply(MSG_CANCEL_AFTER_ORDER, { outcome: "handoff", reason: "action_required" }) };
      return { handled: false, active: true };
    }

    // 1a) RECUPERAÇÃO da fila de ambiguidades: se uma escolha foi resolvida mas a fila não foi consumida (o worker caiu no meio), consome
    //     agora (atômico e idempotente no banco). O que o cliente já escolheu/pediu nunca precisa ser repetido.
    const ch0 = await getChoice(io, jobId);
    if (ch0?.pendingQueue) {
      const base0: Extract<Exec, { kind: "reply" }> = { kind: "reply", state, acks: [], notes: [], questions: [] };
      return { handled: true, outcome: await sendComposed(io, input, await continueQueue(io, input, base0, ch0.pendingQueue.queue, null, lastBot, ch0.pendingQueue.choiceId)) };
    }

    let pendingChoiceBlock: string | null = null;
    // 1b) desambiguação ATIVA (contexto PERSISTIDO no banco): letra/ordinal/nome é resolvido AQUI, sem modelo, e o item entra com a
    //     quantidade guardada. Sem contexto ativo "A" não significa nada. Ambiguidade nunca vira handoff (só após 3 tentativas seguidas).
    const ch = texts.length > 0 ? ch0 : null;
    const lastTxt = texts.length > 0 ? texts[texts.length - 1] : "";
    const newInstruction = hasOrderVerb(lastTxt) || startsWithQuantity(lastTxt) || norm(lastTxt).replace(/[^a-z0-9 ]+/g, " ").trim().split(/\s+/).length > 4 || classifyConfirmationBatch([lastTxt]) === "confirm";
    if (ch?.active && classifyConfirmationBatch([lastTxt]) === "confirm") {
      // "confirmar" com uma pergunta de escolha ainda aberta: NÃO confirma e NÃO descarta a pergunta; pede a escolha primeiro
      const live0 = ch.active.options.filter((o) => o.active);
      if (live0.length > 0) return { handled: true, outcome: await io.reply(clampBody(`Antes de confirmar, preciso saber qual você quer.\n${renderLetterChoice(ch.active.source, live0.map((o) => o.name ?? ""), "ambiguous", live0.map((o) => o.letter))}`), { outcome: "replied", reason: "order_question" }) };
    }
    if (ch?.active) {
      const act = ch.active;
      const names = act.options.map((o) => o.name ?? "");
      const li = parseLetterReply(lastTxt);
      const byName = li === null ? pickChoice(lastTxt, names) : null;
      const idx = li !== null ? (li < act.options.length ? li : -1) : byName?.kind === "one" ? byName.index : -1;
      const live = act.options.filter((o) => o.active);   // a lista que volta ao cliente só mostra o que ainda pode ser pedido (as letras originais não mudam)
      if (live.length === 0) {
        await io.rpc("whatsapp_order_choice_cancel", { p_job_id: jobId });
        return { handled: true, outcome: await io.reply(`${MSG_NOT_FOUND}`, { outcome: "replied", reason: "order_question" }) };
      }
      const block = renderLetterChoice(act.source, live.map((o) => o.name ?? ""), "ambiguous", live.map((o) => o.letter));
      if (idx >= 0) {
        const r = await io.rpc("whatsapp_order_choice_resolve", { p_job_id: jobId, p_choice_id: act.choiceId, p_letter: act.options[idx].letter, p_message_id: latest, p_expected_latest: latest, p_tail_count: inbound.length });
        const d = isObj(r.data) ? r.data : null;
        if (r.error || !d) throw new FlowAbort("left_for_retry", "rpc_error");
        if (d.result === "blocked") {
          if (d.reason === "stale_context") throw new StaleContext();
          if (d.reason === "human_control") throw new FlowAbort("aborted_human", "ai_paused");
          throw new FlowAbort("aborted_mode", String(d.reason ?? "blocked"));
        }
        if (d.result === "ok" && isObj(d.product)) return { handled: true, outcome: await sendComposed(io, input, await continueQueue(io, input, choiceExec(state, d), d.queue, inbound.length, lastBot, act.choiceId)) };
        if (d.result === "apply_failed") return { handled: true, outcome: await sendComposed(io, input, choiceFailedExec(state, d)) };
        if (d.result === "product_inactive") return { handled: true, outcome: await reaskChoice(io, input, block, "Essa opção não está mais disponível.") };
        if (d.result === "expired") return { handled: true, outcome: await io.reply(MSG_CHOICE_EXPIRED, { outcome: "replied", reason: "order_question" }) };
        // already_resolved / not_found: o contexto mudou entre a leitura e a escolha; segue o fluxo normal
      } else if (li !== null || byName?.kind === "many") {
        return { handled: true, outcome: await reaskChoice(io, input, block) };   // letra fora da lista ou nome que serve para várias opções
      } else if (newInstruction) {
        await io.rpc("whatsapp_order_choice_cancel", { p_job_id: jobId });   // o cliente mudou de assunto/pedido: o contexto antigo deixa de valer
      } else {
        pendingChoiceBlock = block;   // o extrator ainda pode entender outra coisa; se não entender nada, pergunta de novo
      }
    } else if (ch && (ch.expired || (parseLetterReply(lastTxt) !== null && !!parseChoiceQuestion(lastBot)))) {
      // contexto expirado (ou já resolvido) e o cliente respondeu só com uma letra: não adivinha, pede o item de novo
      return { handled: true, outcome: await io.reply(MSG_CHOICE_EXPIRED, { outcome: "replied", reason: "order_question" }) };
    } else {
      // compatibilidade: pergunta de escolha ANTIGA (bullets) ainda no histórico de conversas existentes, sem contexto no banco
      const choice = texts.length > 0 && !LETTER_PROMPT_RE.test(lastBot ?? "") ? parseChoiceQuestion(lastBot) : null;
      if (choice) {
        const pick = pickChoice(lastTxt, choice.options);
        if (pick.kind === "one") {
          const exec = await executeExtraction(io, input, state, [addOpFor(choice.options[pick.index], choice.qty)], `${joined} ${choice.qty ?? ""}`, true, inbound.length, lastBot);
          if (exec.kind === "legacy") return { handled: false, active: true };
          return { handled: true, outcome: await sendComposed(io, input, exec) };
        }
        if (!newInstruction && pick.kind === "many") return { handled: true, outcome: await reaskChoice(io, input, choice.block) };
        if (!newInstruction && pick.kind === "none") pendingChoiceBlock = choice.block;
      }
    }

    // 1c) "sim" à pergunta ANTIGA "Quer que eu mostre as opções disponíveis?" (conversas que ainda a têm no histórico): mostra o cardápio real
    if (texts.length > 0 && lastBot && LEGACY_SHOW_OPTIONS_RE.test(lastBot) && classifyConfirmationBatch(texts) === "ambiguous_ack") {
      return { handled: true, outcome: await io.reply(await menuText(io, input), { outcome: "replied", reason: "order_question" }) };
    }

    // 2a) "confirmar" SEM resumo pendente (repetido depois do pedido, ou antes de o resumo existir): o banco decide
    //     (already_confirmed / not_awaiting / no_draft); nunca cai no fluxo de conversa livre.
    if (texts.length > 0 && state?.status !== "awaiting_confirmation" && classifyConfirmationBatch(texts) === "confirm") {
      return { handled: true, outcome: await doConfirm(io, input, state) };
    }

    // 2) confirmação / "ok" com o resumo já enviado
    if (state?.status === "awaiting_confirmation" && texts.length > 0) {
      const cls = classifyConfirmationBatch(texts);
      if (cls === "confirm") return { handled: true, outcome: await doConfirm(io, input, state) };
      if (cls === "ambiguous_ack") return { handled: true, outcome: await io.reply(MSG_REPROMPT, { outcome: "replied", reason: "order_reprompt" }) };
    }

    // 3) filtros do fluxo antigo que NÃO são do pedido
    if (!pendingChoiceBlock && input.pre?.reason_code === "action_required" && !(state && EDIT_RE.test(norm(joined) + " "))) return { handled: false, active: true };
    if (!pendingChoiceBlock && input.pre?.action === "ignore" && state && state.status === "collecting" && texts.length > 0) {
      return { handled: true, outcome: await respondFromState(io, input, state) };   // "ok" no meio da montagem: repete a pergunta
    }
    if (!pendingChoiceBlock && input.pre?.action === "ignore") return { handled: false, active: true };

    // D5: item só entra com intenção clara de pedido (verbo de pedido, quantidade no começo com pedido aberto, ou resposta a uma
    // pergunta nossa). Pergunta informativa ("tem espeto de carne?") nunca adiciona item.
    // Lista de itens sem verbo ("2 espetos de carne 3 coca") também é pedido (caso real 27/10): sem isso caía no fluxo de conhecimento
    // e virava handoff action_required. Continua passando pelo extrator (order_intent) e pelo catálogo do banco.
    const listy = looksLikeItemList(joined);
    const orderish = hasOrderVerb(joined) || listy || (!!state && startsWithQuantity(joined)) || isOurQuestion(lastBot);
    if (!state && !hasOrderVerb(joined) && !listy && !isOurQuestion(lastBot)) return { handled: false, active: true };   // pergunta informativa etc.

    // 4) tudo já aplicado em uma rodada anterior deste job (reagendamento): só responder
    if (texts.length === 0) {
      if (!state) return { handled: false, active: true };
      // reagendamento depois de a mensagem já ter sido aplicada: se ainda há uma pergunta de escolha PENDENTE (próxima da fila), repete-a
      const pend = await getChoice(io, jobId);
      if (pend?.active) {
        const live = pend.active.options.filter((o) => o.active);
        if (live.length > 0) return { handled: true, outcome: await io.reply(clampBody(`${renderLetterChoice(pend.active.source, live.map((o) => o.name ?? ""), "ambiguous", live.map((o) => o.letter))}`), { outcome: "replied", reason: "order_question" }) };
      }
      return { handled: true, outcome: await respondFromState(io, input, state) };
    }

    // 5) extrator (modelo): só intenção
    const ex = await io.extract(buildOrderSystemPrompt(input.businessName), buildOrderUserBlock({ tail: texts, lastBotText: lastBot, state, customerFirstName: input.customerFirstName }), (t) => validateExtraction(t).ok);
    if (!ex.ok) return { handled: true, outcome: ex.outcome };
    const v = validateExtraction(ex.text);
    if (!v.ok) {
      console.error("whatsapp-order: extração inválida", { why: v.why });
      return { handled: true, outcome: await io.complete("invalid_output", "invalid_output", { handled: latest, handoff: input.fallback }) };
    }
    const extraction = v.extraction;
    if (pendingChoiceBlock && extraction.operations.length === 0) return { handled: true, outcome: await reaskChoice(io, input, pendingChoiceBlock) };
    if (!state && !extraction.order_intent) return { handled: false, active: true };
    if (extraction.inquiry_only && extraction.operations.length === 0) {
      // "sim"/"ok" solto com pedido em montagem: repete o próximo passo do pedido (NUNCA cai no fluxo de conhecimento => handoff)
      if (state && state.status === "collecting" && classifyConfirmationBatch(texts) === "ambiguous_ack") return { handled: true, outcome: await respondFromState(io, input, state) };
      return { handled: false, active: true };
    }

    const exec = await executeExtraction(io, input, state, extraction.operations, joined, orderish, inbound.length, lastBot, false, !state && !hasOrderVerb(joined) && !isOurQuestion(lastBot));
    if (exec.kind === "legacy") return { handled: false, active: true };
    return { handled: true, outcome: await sendComposed(io, input, exec) };
  } catch (e) {
    if (e instanceof StaleContext) return { handled: true, outcome: await io.complete("ignored", "stale_context", { handled: latest }) };
    if (e instanceof FlowAbort) return { handled: true, outcome: await io.complete(e.outcome, e.reason, { handled: latest, handoff: e.handoff }) };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Mutação (contexto atual obrigatório) e mapeamento dos bloqueios
// ---------------------------------------------------------------------------
async function mutate(io: OrderFlowIo, fn: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await io.rpc(fn, args);
  if (r.error || !isObj(r.data)) {
    console.error("whatsapp-order: rpc falhou", { fn, code: r.error?.code ?? null });
    throw new FlowAbort("left_for_retry", "rpc_error");
  }
  const d = r.data;
  if (d.result === "blocked") {
    const reason = String(d.reason ?? "");
    if (reason === "stale_context") throw new StaleContext();
    if (reason === "human_control") throw new FlowAbort("aborted_human", "ai_paused");
    if (reason === "conversation_closed" || reason === "conversation_missing") throw new FlowAbort("aborted_closed", reason);
    if (reason === "rate_limited") throw new FlowAbort("handoff", "order_rate_limited", true);
    if (reason === "not_active") throw new FlowAbort("not_active", "not_active");
    throw new FlowAbort("aborted_mode", reason || "blocked");
  }
  return d;
}

// ---------------------------------------------------------------------------
// Confirmação
// ---------------------------------------------------------------------------
async function doConfirm(io: OrderFlowIo, input: OrderFlowInput, before: OrderState | null): Promise<string> {
  const { jobId, latest } = input;
  const pend = await getChoice(io, jobId);
  const liveC = pend?.active ? pend.active.options.filter((o) => o.active) : [];
  if (pend?.active && liveC.length > 0) {
    return io.reply(clampBody(`Antes de confirmar, preciso saber qual você quer.\n${renderLetterChoice(pend.active.source, liveC.map((o) => o.name ?? ""), "ambiguous", liveC.map((o) => o.letter))}`), { outcome: "replied", reason: "order_question" });
  }
  const d = await mutate(io, "whatsapp_order_confirm", { p_job_id: jobId, p_confirm_message_id: latest });
  const res = String(d.result ?? "");
  const st = parseOrderState(d.state);
  switch (res) {
    case "created": {
      const minutes = !before ? null : before.fulfillment === "delivery" ? before.estimated_minutes ?? before.settings.delivery_minutes : before.settings.pickup_minutes;
      return io.reply(renderCreated(String(d.total ?? before?.grand_total ?? 0), String(d.fulfillment ?? before?.fulfillment ?? "pickup"), minutes), { outcome: "replied", reason: "order_confirmed" });
    }
    case "already_confirmed":
      return io.reply(MSG_ALREADY_CONFIRMED, { outcome: "replied", reason: "order_already_confirmed" });
    case "price_changed": {
      if (!st) return io.reply(MSG_FAILED, { outcome: "handoff", reason: "order_failed" });
      const changes = Array.isArray(d.price_changes) ? (d.price_changes as Array<{ name: string; old: number | string; new: number | string }>) : [];
      const head = renderPriceChanges(changes, d.old_fee as string | number | null ?? null, st.delivery_fee, st.grand_total);
      return sendSummaryText(io, input, st, `${head}\n\n${renderSummary(st, "Seu pedido atualizado")}`);
    }
    case "needs_changes": {
      if (!st) return io.reply(MSG_FAILED, { outcome: "handoff", reason: "order_failed" });
      const changes = Array.isArray(d.price_changes) ? (d.price_changes as Array<{ name: string; old: number | string; new: number | string }>) : [];
      const head = changes.length ? renderPriceChanges(changes, null, null, st.grand_total) + "\n" : "";
      const q = nextQuestion(st) ?? "Preciso conferir seu pedido de novo. O que você quer ajustar?";
      return io.reply(`${head}${q}`, { outcome: "replied", reason: "order_needs_changes" });
    }
    case "not_awaiting":
    case "stale_summary":
    case "summary_not_sent":
    case "confirm_before_summary": {
      const cur = st ?? parseOrderState(isObj(d) ? d.state : null);
      if (cur && cur.ready) return sendSummaryText(io, input, cur, renderSummary(cur));
      return io.reply(cur ? nextQuestion(cur) ?? MSG_REPROMPT : MSG_NO_DRAFT, { outcome: "replied", reason: "order_resume" });
    }
    case "no_draft":
      return io.reply(MSG_NO_DRAFT, { outcome: "replied", reason: "order_no_draft" });
    case "failed":
      return io.reply(MSG_FAILED, { outcome: "handoff", reason: "order_failed" });
    case "invalid":
      if (d.reason === "not_latest_message") return io.complete("ignored", "stale_context", { handled: latest });
      return io.reply(MSG_FAILED, { outcome: "handoff", reason: "order_failed" });
    default:
      console.error("whatsapp-order: resultado de confirmação inesperado", { res });
      return io.reply(MSG_FAILED, { outcome: "handoff", reason: "order_failed" });
  }
}

/** Envia o resumo e, SÓ depois do envio, marca no banco (a confirmação do cliente só vale depois disso). */
function sendSummaryText(io: OrderFlowIo, input: OrderFlowInput, st: OrderState, body: string): Promise<string> {
  return io.reply(clampBody(body), {
    outcome: "replied", reason: "order_summary",
    onSent: async (messageId) => {
      const r = await io.rpc("whatsapp_order_mark_summary_sent", { p_job_id: input.jobId, p_message_id: messageId, p_expected_version: st.version, p_expected_latest: input.latest });
      const ok = !r.error && isObj(r.data) && r.data.result === "ok";
      if (!ok) console.error("whatsapp-order: resumo não marcado", { code: r.error?.code ?? null, result: isObj(r.data) ? String(r.data.result) : null });
    },
  });
}
const clampBody = (b: string) => (b.length > 3900 ? b.slice(0, 3890) + "…" : b);

async function respondFromState(io: OrderFlowIo, input: OrderFlowInput, st: OrderState): Promise<string> {
  if (st.status === "awaiting_confirmation") return io.reply(MSG_REPROMPT, { outcome: "replied", reason: "order_reprompt" });
  if (st.ready) return sendSummaryText(io, input, st, renderSummary(st));
  return io.reply(nextQuestion(st) ?? "Posso ajudar com mais alguma coisa no pedido?", { outcome: "replied", reason: "order_question" });
}

// ---------------------------------------------------------------------------
// Execução das operações extraídas
// ---------------------------------------------------------------------------
type Exec = { kind: "legacy" } | { kind: "reply"; state: OrderState | null; acks: Ack[]; notes: string[]; questions: string[] };

async function executeExtraction(
  io: OrderFlowIo, input: OrderFlowInput, state0: OrderState | null, ops: ExtractedOp[], text: string, orderish: boolean, tailCount: number | null, lastBot: string | null, unguarded = false, implicit = false, takeChoiceId: string | null = null,
): Promise<Exec> {
  const { jobId } = input;
  // fila de ambiguidades: o que o cliente JÁ disse não pode se perder se chegou mensagem nova no meio do turno (o reenvio da resposta trata a nova)
  const latest = unguarded ? null : input.latest;
  const units: Unit[] = [];
  const questions: string[] = [];
  const notes: string[] = [];
  let address = null as Record<string, string> | null;
  let payment = null as { method: string | null; needsChange: boolean | null; amount: number | null } | null;
  let state = state0;
  let considered = 0;
  let recognized = false;   // algum item da mensagem existe no catálogo (exato, ambíguo ou indisponível); "near" não conta
  // PRIMEIRA ambiguidade da mensagem abre o contexto de escolha; as demais ficam numa FILA persistida no mesmo contexto (uma pergunta por vez)
  let choice: { slot: number; op: ExtractedOp; pq: number | null; kind: "ambiguous" | "near"; c: Array<{ name: string; price: number | string }>; ids: string[] } | null = null;
  const deferred: Array<{ text: string; quantity: number | null; notes: string | null }> = [];
  // quantidade "viva" de cada linha dentro deste lote (várias retiradas na mesma mensagem não podem usar o estado velho)
  const qtyNow = new Map<string, number>();
  const liveQty = (i: { item_id: string; quantity: number }) => qtyNow.get(i.item_id) ?? i.quantity;
  const removals = ops.filter((o) => o.op === "remove_item" || o.op === "decrement_item").length;

  const resolveRaw = async (mention: string) => {
    const r = await io.rpc("whatsapp_order_resolve_item", { p_job_id: jobId, p_mention: mention, p_limit: 5 });
    if (r.error || !isObj(r.data)) throw new FlowAbort("left_for_retry", "rpc_error");
    if (r.data.result === "blocked") throw new FlowAbort("aborted_mode", String(r.data.reason ?? "blocked"));
    return r.data;
  };
  // "cerveja haineken": a palavra genérica do TIPO de bebida não está no nome do produto ("Heineken Zero"). Sem resultado, tenta de novo
  // SÓ com o resto (o catálogo do banco continua decidindo); se ainda assim nada serve, vale o resultado original.
  const resolveItem = async (mention: string) => {
    const first = await resolveRaw(mention);
    if (first.result !== "none") return first;
    const rest = norm(mention).replace(GENERIC_TYPE_RE, " ").replace(/\s+/g, " ").trim();
    if (!rest || rest === norm(mention).trim()) return first;
    const second = await resolveRaw(rest);
    return second.result === "none" ? first : second;
  };
  const resolveOption = async (productId: string, mention: string) => {
    const r = await io.rpc("whatsapp_order_resolve_option", { p_job_id: jobId, p_product_id: productId, p_mention: mention });
    if (r.error || !isObj(r.data)) throw new FlowAbort("left_for_retry", "rpc_error");
    return r.data;
  };

  for (const op of ops) {
    switch (op.op) {
      case "add_item": {
        if (!orderish || !op.product_text) break;            // pergunta informativa NÃO adiciona item
        considered++;
        const rr = await resolveItem(op.product_text);
        if (rr.result !== "none") recognized = true;
        if (rr.result === "ambiguous" || rr.result === "none") {
          // opções REAIS na mesma resposta, por LETRA; a quantidade/observação ficam num contexto PERSISTENTE (não dependem da memória do worker)
          const pend = decideQuantity(op, text);
          const pq = pend.kind === "qty" ? pend.qty : null;
          const kind = rr.result === "ambiguous" ? "ambiguous" : "near";
          const c = ((rr.result === "ambiguous" ? rr.candidates : rr.near) as Array<{ product_id?: string; name: string; price: number | string }> | undefined) ?? [];
          const total = rr.result === "ambiguous" ? Number(rr.total_candidates ?? c.length) : c.length;
          if (c.length === 0) { questions.push(MSG_NOT_FOUND); break; }
          if (total > 5) { questions.push(`Encontrei muitas opções de ${plain(op.product_text, 50)}. Pode me dizer mais detalhes do item (o nome completo)?`); break; }
          if (choice) { deferred.push({ text: op.product_text, quantity: pq, notes: op.notes }); break; }
          const ids = c.map((x) => (typeof x.product_id === "string" ? x.product_id : ""));
          if (ids.every(Boolean)) { choice = { slot: questions.length, op, pq, kind, c, ids }; questions.push(""); break; }
          // sem contexto persistido (migration ausente/falha): pergunta no formato antigo, sem letra (a resposta é lida da própria mensagem)
          questions.push(renderChoice(op.product_text, pq, c, kind));
          break;
        }
        const prod = isObj(rr.product) ? rr.product : null;
        if (!prod) break;
        if (rr.result === "unavailable") { notes.push(renderUnavailable(String(prod.name))); break; }
        const q = decideQuantity(op, text);
        if (q.kind === "too_many") { notes.push("Para mais de 50 unidades de um item, vou chamar a equipe."); throw new FlowAbort("handoff", "order_too_big", true); }
        if (q.kind === "ask") { questions.push(renderAskQuantity(String(prod.name))); break; }
        const optionIds: string[] = [];
        for (const m of op.options_text) {
          const ro = await resolveOption(String(prod.product_id), m);
          if (ro.result === "exact" && isObj(ro.option)) optionIds.push(String(ro.option.option_id));
          else if (ro.result === "none") notes.push(`Não encontrei a opção "${plain(m, 40)}" para ${plain(String(prod.name), 60)}.`);
        }
        units.push({ ops: [{ op: "add_item", product_id: prod.product_id, quantity: q.qty, notes: op.notes, option_ids: optionIds }], acks: [{ kind: "add", text: `${q.qty}x ${plain(String(prod.name), 80)}` }] });
        break;
      }
      case "remove_item": case "decrement_item": case "set_quantity": case "set_item_notes": case "set_item_options": case "replace_item": {
        if (!state) { notes.push("Ainda não há itens no seu pedido."); break; }
        considered++;
        const m = matchItem(state.items.filter((i) => liveQty(i) > 0), op.product_text);
        if (m.kind === "none") { notes.push("Não encontrei esse item no seu pedido."); break; }
        if (m.kind === "many") { questions.push(`Em qual item: ${m.items.map((i) => plain(i.name, 60)).join(" ou ")}?`); break; }
        const it = m.item;
        if (op.op === "remove_item" || op.op === "decrement_item") {
          // linha inteira x reduzir N: a decisão vem do TEXTO do cliente; a conta (atual - N) é feita aqui, nunca pelo modelo
          const cur = liveQty(it);
          const intent = removalIntent(op, text, removals === 1);
          if (intent.mode === "qty" && intent.qty > cur) {
            questions.push(`Você tem ${cur} ${cur === 1 ? "unidade" : "unidades"} de ${plain(it.name, 80)} no pedido. Quantas deseja retirar?`);
            break;
          }
          if (intent.mode === "all" || intent.qty === cur) {
            qtyNow.set(it.item_id, 0);
            units.push({ ops: [{ op: "remove_item", item_id: it.item_id }], acks: [{ kind: "remove", text: `${cur}x ${plain(it.name, 80)}` }] });
            break;
          }
          const left = cur - intent.qty;
          qtyNow.set(it.item_id, left);
          units.push({ ops: [{ op: "set_quantity", item_id: it.item_id, quantity: left }], acks: [{ kind: "change", text: `${left}x ${plain(it.name, 80)}` }] });
          break;
        }
        if (op.op === "set_quantity") {
          const q = decideQuantity(op, text);
          if (q.kind !== "qty") { questions.push(renderAskQuantity(it.name)); break; }
          qtyNow.set(it.item_id, q.qty);
          units.push({ ops: [{ op: "set_quantity", item_id: it.item_id, quantity: q.qty }], acks: [{ kind: "change", text: `${q.qty}x ${plain(it.name, 80)}` }] });
          break;
        }
        if (op.op === "set_item_notes") { units.push({ ops: [{ op: "set_item_notes", item_id: it.item_id, notes: op.notes }], acks: [{ kind: "change", text: `${plain(it.name, 80)}${op.notes ? ` (${plain(op.notes, 60)})` : ""}` }] }); break; }
        if (op.op === "set_item_options") {
          const picked: Array<{ id: string; group: string }> = [];
          for (const mm of op.options_text) {
            const ro = await resolveOption(it.product_id, mm);
            if (ro.result === "exact" && isObj(ro.option)) picked.push({ id: String(ro.option.option_id), group: String(ro.option.group_id) });
            else if (ro.result === "ambiguous") questions.push(`Qual opção você quer? ${((ro.candidates as Array<{ name: string }>) ?? []).map((c) => plain(c.name, 40)).join(", ")}.`);
            else notes.push(`Não encontrei a opção "${plain(mm, 40)}" para ${plain(it.name, 60)}.`);
          }
          if (picked.length === 0) break;
          const groups = new Set(picked.map((p) => p.group));
          const keep = it.options.filter((o) => !groups.has(o.group_id)).map((o) => o.option_id);
          units.push({ ops: [{ op: "set_item_options", item_id: it.item_id, option_ids: [...keep, ...picked.map((p) => p.id)] }], acks: [{ kind: "change", text: plain(it.name, 80) }] });
          break;
        }
        // replace_item: troca o produto mantendo (ou redefinindo) a quantidade; se o destino não resolver, NADA muda
        if (!op.to_text) break;
        const rr = await resolveItem(op.to_text);
        if (rr.result === "ambiguous") { questions.push(renderAmbiguous((rr.candidates as Array<{ name: string; price: number | string }>) ?? [])); break; }
        if (rr.result === "none") { questions.push(MSG_NOT_FOUND); break; }
        const prod = isObj(rr.product) ? rr.product : null;
        if (!prod) break;
        if (rr.result === "unavailable") { notes.push(renderUnavailable(String(prod.name))); break; }
        let qty = it.quantity;
        if (op.quantity !== null) { const q = decideQuantity({ ...op, product_text: op.to_text }, text); if (q.kind !== "qty") { questions.push(renderAskQuantity(String(prod.name))); break; } qty = q.qty; }
        units.push({
          ops: [{ op: "remove_item", item_id: it.item_id }, { op: "add_item", product_id: prod.product_id, quantity: qty, notes: null, option_ids: [] }],
          acks: [{ kind: "remove", text: `${it.quantity}x ${plain(it.name, 80)}` }, { kind: "add", text: `${qty}x ${plain(String(prod.name), 80)}` }],
        });
        break;
      }
      case "set_fulfillment":
        if (op.value === "pickup" || op.value === "delivery") { considered++; units.push({ ops: [{ op: "set_fulfillment", value: op.value }], acks: [] }); }
        break;
      case "set_contact_name":
        if (op.value) { considered++; units.push({ ops: [{ op: "set_contact_name", value: op.value }], acks: [] }); }
        break;
      case "set_order_notes":
        if (op.value) { considered++; units.push({ ops: [{ op: "set_notes", value: op.value }], acks: [] }); }
        break;
      case "set_address": {
        considered++;
        const f: Record<string, string> = {};
        for (const k of ["street", "number", "complement", "neighborhood", "city", "state", "cep", "reference"] as const) if (op[k]) f[k] = String(op[k]);
        address = { ...(address ?? {}), ...f };
        break;
      }
      case "set_payment_method":
        if (op.value && ["cash", "pix", "debit_card", "credit_card", "other"].includes(op.value)) { considered++; payment = { method: op.value, needsChange: payment?.needsChange ?? null, amount: payment?.amount ?? null }; }
        break;
      case "set_change":
        considered++;
        payment = { method: payment?.method ?? null, needsChange: op.needs_change, amount: op.amount };
        break;
      default:
        break;
    }
  }

  if (choice) {
    const ch = choice;
    const o = await io.rpc("whatsapp_order_choice_open", {
      p_job_id: jobId, p_source_text: ch.op.product_text, p_quantity: ch.pq, p_notes: ch.op.notes, p_product_ids: ch.ids, p_expected_latest: latest,
      ...(deferred.length > 0 ? { p_queue: deferred } : {}),
    });
    const od = isObj(o.data) ? o.data : null;
    if (od && od.result === "blocked" && od.reason === "stale_context") throw new StaleContext();
    if (od && od.result === "blocked" && od.reason === "human_control") throw new FlowAbort("aborted_human", "ai_paused");
    if (o.error && !isMissingFunction(o.error)) throw new FlowAbort("left_for_retry", "rpc_error");   // falha real: o job é retomado (a fila não se perde); só "função ausente" degrada
    if (!o.error && od && od.result === "ok") {
      const later = deferred.length > 0 ? `
Depois eu pergunto sobre: ${deferred.map((x) => `${x.quantity ? `${x.quantity}x ` : ""}${plain(x.text, 40)}`).join(", ")}.` : "";
      questions[ch.slot] = renderLetterChoice(ch.op.product_text ?? "", ch.c.map((x) => x.name), ch.kind) + later;
    } else {
      // sem contexto persistido (migration ausente/falha): pergunta no formato antigo, sem letra; as demais menções viram aviso
      questions[ch.slot] = renderChoice(ch.op.product_text ?? "", ch.pq, ch.c, ch.kind);
      for (const x of deferred) notes.push(`Para ${plain(x.text, 50)}, me diga depois qual você quer.`);
    }
  }

  // pedido IMPLÍCITO (lista sem verbo, sem rascunho): só vale se algum produto for reconhecido; "2 horas", "3 pessoas" voltam ao fluxo normal
  if (implicit && !recognized) return { kind: "legacy" };
  const takeArgs = (ops: unknown[]) => ({ p_job_id: jobId, p_choice_id: takeChoiceId, p_ops: ops, p_tail_count: tailCount });
  if (considered === 0 && questions.length === 0 && notes.length === 0 && takeChoiceId) await mutate(io, "whatsapp_order_choice_queue_take", takeArgs([]));   // nada a aplicar: só consome a fila
  if (considered === 0 && questions.length === 0 && notes.length === 0) return state ? { kind: "reply", state, acks: [], notes: [], questions: [] } : { kind: "legacy" };

  const acks: Ack[] = [];
  const base = { p_job_id: jobId, p_expected_latest: latest, p_tail_count: tailCount };
  // itens, tipo, nome, observação: lote atômico; se o lote falhar, cada unidade é tentada sozinha para isolar o problema
  const flat = units.flatMap((u) => u.ops);
  if (takeChoiceId) {
    // fila de ambiguidades: aplicar os itens e esvaziar a fila é UMA transação (retry/recuperação nunca duplica nem perde)
    const t = await mutate(io, "whatsapp_order_choice_queue_take", takeArgs(flat));
    if (t.result === "ok" || t.result === "empty") {
      state = parseOrderState(t.state) ?? state;
      if (t.result === "ok") acks.push(...units.flatMap((u) => u.acks));
    } else {
      for (const u of units) {
        const one = await mutate(io, "whatsapp_order_apply_ops", { ...base, p_ops: u.ops });
        if (one.result === "ok") { state = parseOrderState(one.state) ?? state; acks.push(...u.acks); }
        else mapInvalid(String(one.reason ?? ""), u, notes, questions);
      }
      const cl = await mutate(io, "whatsapp_order_choice_queue_take", takeArgs([]));
      state = parseOrderState(cl.state) ?? state;
    }
  } else if (flat.length > 0 || state) {
    let applied = false;
    if (flat.length > 0) {
      const r = await mutate(io, "whatsapp_order_apply_ops", { ...base, p_ops: flat });
      if (r.result === "ok") { state = parseOrderState(r.state) ?? state; acks.push(...units.flatMap((u) => u.acks)); applied = true; }
      else {
        for (const u of units) {
          const one = await mutate(io, "whatsapp_order_apply_ops", { ...base, p_ops: u.ops });
          if (one.result === "ok") { state = parseOrderState(one.state) ?? state; acks.push(...u.acks); }
          else mapInvalid(String(one.reason ?? ""), u, notes, questions);
        }
        applied = true;
      }
    }
    if (!applied && state) {
      const t = await mutate(io, "whatsapp_order_apply_ops", { ...base, p_ops: [] });
      state = parseOrderState(t.state) ?? state;
    }
  }
  if (address) {
    if (!state || state.fulfillment !== "delivery") { questions.push(state?.fulfillment === "pickup" ? "Seu pedido está como retirada. Quer trocar para entrega?" : "Prefere retirada no balcão ou entrega?"); }
    else {
      const r = await mutate(io, "whatsapp_order_set_address", { ...base, p_fields: address });
      if (r.result === "ok") {
        state = parseOrderState(r.state) ?? state;
        // mais de uma zona compatível com o bairro digitado: NÃO escolhe; pergunta qual (a resposta traz o nome completo)
        if (r.address_status === "ambiguous_zone" && Array.isArray(r.zone_candidates)) {
          questions.push(renderZoneAmbiguous((r.zone_candidates as Array<{ neighborhood?: unknown }>).map((c) => String(c.neighborhood ?? "")).filter(Boolean)));
        }
      } else if (r.reason === "address_invalid") notes.push(`O endereço informado parece inválido${typeof r.message === "string" ? ` (${plain(r.message, 100)})` : ""}. Pode conferir?`);
      else if (r.reason === "delivery_disabled") notes.push("No momento não estamos fazendo entregas. Quer retirar no balcão?");
    }
  }
  if (payment) {
    const r = await mutate(io, "whatsapp_order_set_payment", { ...base, p_method: payment.method, p_change_needed: payment.needsChange, p_change_for: payment.needsChange ? payment.amount : null });
    if (r.result === "ok") state = parseOrderState(r.state) ?? state;
    else if (r.reason === "method_not_authorized") questions.push(`Aceitamos: ${(state?.payment.authorized_methods ?? []).map((m) => PAYMENT_LABELS[m] ?? m).join(", ")}. Qual você prefere?`);
    else if (r.reason === "change_below_total") questions.push(`O valor do troco precisa cobrir o total de ${brl(Number(r.grand_total ?? state?.grand_total ?? 0))}. Para quanto?`);
    else if (r.reason === "change_value" || r.reason === "change_needs_cash") questions.push("Para quanto você precisa de troco?");
  }
  return { kind: "reply", state, acks, notes, questions };
}

interface ActiveChoice { choiceId: string; source: string; quantity: number | null; options: Array<{ letter: string; productId: string; name: string | null; active: boolean }> }
/** Contexto de desambiguação ATIVO da conversa do job (o banco expira o vencido). null = função ausente (migration ainda não aplicada). */
interface PendingQueue { choiceId: string; queue: unknown[] }
async function getChoice(io: OrderFlowIo, jobId: string): Promise<{ active: ActiveChoice | null; expired: boolean; pendingQueue: PendingQueue | null } | null> {
  const r = await io.rpc("whatsapp_order_choice_get", { p_job_id: jobId });
  if (r.error) {
    if (!isMissingFunction(r.error)) console.error("whatsapp-order: choice_get falhou", { code: r.error.code ?? null });
    return null;
  }
  const d = isObj(r.data) ? r.data : null;
  if (!d || d.result === "blocked") return null;
  const pq = isObj(d.pending_queue) && typeof d.pending_queue.choice_id === "string" && Array.isArray(d.pending_queue.queue) && d.pending_queue.queue.length > 0
    ? { choiceId: d.pending_queue.choice_id, queue: d.pending_queue.queue as unknown[] }
    : null;
  if (d.result !== "ok" || typeof d.choice_id !== "string" || !Array.isArray(d.options)) return { active: null, expired: d.expired === true, pendingQueue: pq };
  const options = (d.options as unknown[]).filter(isObj).map((o) => ({ letter: String(o.letter), productId: String(o.product_id), name: typeof o.name === "string" ? o.name : null, active: o.active === true && o.available !== false }));
  if (options.length === 0) return { active: null, expired: false, pendingQueue: pq };
  return { active: { choiceId: d.choice_id, source: typeof d.source_text === "string" ? d.source_text : "o item", quantity: typeof d.quantity === "number" ? d.quantity : null, options }, expired: false, pendingQueue: pq };
}

/** Resultado de whatsapp_order_choice_resolve: o banco JÁ aplicou o item (quantidade e observação guardadas) na mesma transação da escolha. */
function choiceExec(state: OrderState | null, d: Record<string, unknown>): Extract<Exec, { kind: "reply" }> {
  const prod = isObj(d.product) ? d.product : {};
  const qty = typeof d.quantity === "number" ? d.quantity : null;
  if (d.applied !== true || !qty) return { kind: "reply", state, acks: [], notes: [], questions: [renderAskQuantity(String(prod.name ?? "o item"))] };
  return { kind: "reply", state: parseOrderState(d.state) ?? state, acks: [{ kind: "add", text: `${qty}x ${plain(String(prod.name ?? ""), 80)}` }], notes: [], questions: [] };
}
function choiceFailedExec(state: OrderState | null, d: Record<string, unknown>): Extract<Exec, { kind: "reply" }> {
  const prod = isObj(d.product) ? d.product : {};
  const qty = typeof d.quantity === "number" ? d.quantity : 1;
  const notes: string[] = [];
  const questions: string[] = [];
  mapInvalid(String(d.reason ?? ""), { ops: [], acks: [{ kind: "add", text: `${qty}x ${plain(String(prod.name ?? "esse item"), 80)}` }] }, notes, questions);
  return { kind: "reply", state, acks: [], notes, questions };
}

/**
 * Fila de menções ambíguas guardada no contexto de escolha (mesma mensagem do cliente): depois de aplicar a escolha atual, reprocessa
 * as que faltam pelo MESMO caminho do pedido (catálogo do banco, quantidade guardada). Exata => entra no rascunho; ambígua => abre a
 * PRÓXIMA pergunta com letras (e leva o resto da fila); inexistente/indisponível => aviso. Nada que o cliente já disse é pedido de novo.
 */
async function continueQueue(io: OrderFlowIo, input: OrderFlowInput, base: Extract<Exec, { kind: "reply" }>, rawQueue: unknown, tailCount: number | null, lastBot: string | null, choiceId: string): Promise<Extract<Exec, { kind: "reply" }>> {
  const queue = (Array.isArray(rawQueue) ? rawQueue : []).filter(isObj).filter((q) => typeof q.text === "string" && q.text.length > 0);
  if (queue.length === 0) return base;
  const qty = (q: Record<string, unknown>) => (typeof q.quantity === "number" && Number.isInteger(q.quantity) ? q.quantity : null);
  const ops = queue.map((q) => addOpFor(String(q.text), qty(q), typeof q.notes === "string" ? q.notes : null));
  const text = queue.map((q) => `${qty(q) ?? ""} ${String(q.text)}`).join(" ");
  const exec = await executeExtraction(io, input, base.state, ops, text, true, tailCount, lastBot, true, false, choiceId);
  if (exec.kind === "legacy") return base;
  return { kind: "reply", state: exec.state ?? base.state, acks: [...base.acks, ...exec.acks], notes: [...base.notes, ...exec.notes], questions: [...base.questions, ...exec.questions] };
}

/** Repete a lista (até 3 perguntas seguidas); depois cancela o contexto e encaminha à equipe, sem laço infinito. */
async function reaskChoice(io: OrderFlowIo, input: OrderFlowInput, block: string, lead = "Não consegui identificar qual você quer."): Promise<string> {
  if (countChoiceAsks(input.messages) >= 3) {
    await io.rpc("whatsapp_order_choice_cancel", { p_job_id: input.jobId });
    return io.reply(MSG_CHOICE_GIVEUP, { outcome: "handoff", reason: "order_unresolved" });
  }
  return io.reply(clampBody(`${lead}\n${block}`), { outcome: "replied", reason: "order_question" });
}

/** Operação sintética "adicionar item" para a escolha do cliente (texto = nome exato da opção; quantidade = a que ficou pendente). */
function addOpFor(productText: string, qty: number | null, notes: string | null = null): ExtractedOp {
  return {
    op: "add_item", product_text: productText, to_text: null, quantity: qty, quantity_kind: qty ? "explicit" : "unclear", options_text: [], notes, value: null,
    needs_change: null, amount: null, street: null, number: null, complement: null, neighborhood: null, city: null, state: null, cep: null, reference: null,
  };
}

/** Cardápio real (categorias) para o "sim" a "Quer que eu mostre as opções?"; sem base de conhecimento: pede o nome do item. */
async function menuText(io: OrderFlowIo, input: OrderFlowInput): Promise<string> {
  const r = await io.rpc("whatsapp_ai_lookup_knowledge_job", { p_job_id: input.jobId, p_query: "cardápio", p_limit: 8 });
  const cats = r.error || !isObj(r.data) || r.data.enabled !== true || !Array.isArray(r.data.categories)
    ? []
    : (r.data.categories as unknown[]).map((c) => (isObj(c) && typeof c.name === "string" ? plain(c.name, 40) : "")).filter(Boolean).slice(0, 12);
  return cats.length > 0 ? `Nosso cardápio tem: ${cats.join(", ")}.
Diga o item que você quer (por exemplo, "2 coca zero") e eu anoto.` : "Claro! Diga o nome do item que você quer e eu anoto.";
}

function mapInvalid(reason: string, u: Unit, notes: string[], questions: string[]): void {
  const what = u.acks[u.acks.length - 1]?.text ?? "esse item";
  if (reason === "product_unavailable") notes.push(`${what} não está disponível na quantidade pedida.`);
  else if (reason === "delivery_disabled") notes.push("No momento não estamos fazendo entregas. Quer retirar no balcão?");
  else if (reason === "pickup_disabled") notes.push("No momento não estamos fazendo retirada. Quer receber por entrega?");
  else if (reason === "too_many_items") throw new FlowAbort("handoff", "order_too_big", true);
  else if (reason.startsWith("option_")) notes.push(`Não consegui aplicar essa opção em ${what}.`);
  else if (reason === "contact_name") questions.push("Em nome de quem fica o pedido?");
  else notes.push(`Não consegui anotar ${what}.`);
}

// ---------------------------------------------------------------------------
// Resposta do turno (UMA mensagem): confirmações do que foi anotado + dúvidas + próxima pergunta OU resumo completo
// ---------------------------------------------------------------------------
async function sendComposed(io: OrderFlowIo, input: OrderFlowInput, ex: Extract<Exec, { kind: "reply" }>): Promise<string> {
  const head: string[] = [];
  const add = ex.acks.filter((a) => a.kind === "add").map((a) => a.text);
  const rem = ex.acks.filter((a) => a.kind === "remove").map((a) => a.text);
  const chg = ex.acks.filter((a) => a.kind === "change").map((a) => a.text);
  if (add.length) head.push(`Anotei: ${add.join("; ")}.`);
  if (rem.length) head.push(`Retirei: ${rem.join("; ")}.`);
  if (chg.length) head.push(`Atualizei: ${chg.join("; ")}.`);
  head.push(...ex.notes);
  const st = ex.state;
  if (ex.questions.length > 0) {
    return io.reply(clampBody([...head, ...ex.questions.slice(0, 2)].join("\n")), { outcome: "replied", reason: "order_question" });
  }
  if (st && st.ready) {
    // ambiguidade ainda pendente: NÃO manda o resumo (o cliente confirmaria um pedido incompleto); repete a escolha
    const pend = await getChoice(io, input.jobId);
    const liveP = pend?.active ? pend.active.options.filter((o) => o.active) : [];
    if (pend?.active && liveP.length > 0) {
      return io.reply(clampBody([...head, renderLetterChoice(pend.active.source, liveP.map((o) => o.name ?? ""), "ambiguous", liveP.map((o) => o.letter))].join("\n")), { outcome: "replied", reason: "order_question" });
    }
    const body = (head.length ? head.join("\n") + "\n\n" : "") + renderSummary(st);
    return sendSummaryText(io, input, st, body);
  }
  if (st) {
    const q = nextQuestion(st);
    return io.reply(clampBody([...head, q ?? "Posso ajudar com mais alguma coisa no pedido?"].join("\n")), { outcome: "replied", reason: "order_question" });
  }
  if (head.length === 0) head.push(MSG_NOT_FOUND);
  return io.reply(clampBody(head.join("\n")), { outcome: "replied", reason: "order_question" });
}

export const __test = { isOurQuestion, MSG_TOO_BIG };
