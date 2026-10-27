// Edge Function whatsapp-ai-auto (verify_jwt = false; chamada SÓ pelo banco via pg_cron/pg_net com x-internal-secret):
// WORKER do modo AUTOMÁTICO da IA do WhatsApp (Fase 2).
//
// Separada de whatsapp-ai-suggest (que continua só sugerindo). Fluxo por job:
//   claim (lease, SKIP LOCKED) -> prepare (barreiras determinísticas + contexto mínimo) -> pré-filtros em código ->
//   reserva de cota AUTO (antes do provedor) -> IA com decisão estruturada -> validação ESTRUTURAL -> checagens de segurança
//   da resposta -> commit_send (REVALIDAÇÃO FINAL sob lock + mensagem 'queued', client_request_id = job) -> dispatch OFICIAL
//   (_shared/whatsapp-dispatch.ts: send context, Graph, mark_sent/failed) -> complete_job.
//
// Chave de segurança: WHATSAPP_AI_AUTO_ENABLED precisa ser exatamente "true". Qualquer outro valor => NADA é claimado,
// NADA é gerado e NADA é enviado (os jobs apenas envelhecem e expiram sem resposta).
// Nunca é logado: prompt, mensagem, resposta, telefone, token, chave, Authorization. Só códigos e IDs técnicos.
import {
  AUTO_REPLY_MAX_CHARS,
  AUTO_TIMEOUT_MS,
  buildAutoConversationBlock,
  buildAutoSystemPrompt,
  checkReplySafety,
  preFilter,
  unansweredTail,
  validateDecision,
  type AiDecider,
  type AutoContext,
} from "../_shared/ai-auto.ts";
import {
  KNOWLEDGE_LOOKUP_LIMIT,
  buildFactsBlock,
  checkSuggestionSafety,
  isOrderIntent,
  knowledgeKinds,
  knowledgeQuery,
  parseKnowledge,
  type KnowledgeFacts,
} from "../_shared/ai-knowledge.ts";
import { ORDER_EXTRACT_SCHEMA, validateExtraction } from "../_shared/ai-order.ts";
import { runOrderFlow, type OrderFlowIo } from "../_shared/ai-order-flow.ts";
import { composeWithIntro, greetingReply, isGreetingOnly } from "../_shared/ai-intro.ts";
import { authorizeInternalRequest } from "../_shared/push-core.ts";
import { MENU_CAPTION, MENU_OFFER_TEXT, menuFilename, menuIntent } from "../_shared/ai-menu.ts";
import { MENU_PDF_MAX_BYTES, buildMenuPdf, type MenuCatalog } from "../_shared/menu-pdf.ts";
import { dispatchQueuedMessage, markMessageFailed, type DispatchDocument, type DispatchRpcClient } from "../_shared/whatsapp-dispatch.ts";
import { isValidGraphVersion, type GraphSender } from "../_shared/whatsapp-graph.ts";

export type RpcClient = DispatchRpcClient;

export interface AutoDeps {
  /** Secret compartilhado com o banco (x-internal-secret). */
  internalSecret: string | undefined;
  /** WHATSAPP_AI_AUTO_ENABLED: só "true" liga. */
  killSwitch: string | undefined;
  admin: RpcClient;
  /** null = provedor não configurado (falha fechada). */
  decider: AiDecider | null;
  graph: GraphSender;
  graphVersion: string | undefined;
  now?: () => number;
  maxJobs?: number;
  /** Cardápio em PDF (opcional): sem isto a funcionalidade não existe e o fluxo é exatamente o de sempre. */
  menu?: MenuDeps;
}

/** Arquivos do cardápio no bucket PRIVADO whatsapp-menu (service_role). */
export interface MenuDeps {
  download(path: string): Promise<Uint8Array | null>;
  upload(path: string, bytes: Uint8Array): Promise<boolean>;
}

const JSON_HEADERS = { "Content-Type": "application/json" };
const MAX_JOBS = 5;
const ORDER_TIMEOUT_MS = 18_000;
const ORDER_MAX_OUTPUT_TOKENS = 2500;
const CONCURRENCY = 3;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

async function call(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { code?: string; message: string } | null }> {
  try {
    return await client.rpc(fn, args);
  } catch (e) {
    console.error("whatsapp-ai-auto: rpc lançou exceção", { fn, name: e instanceof Error ? e.name : null });
    return { data: null, error: { message: "falha de comunicação" } };
  }
}

function isAutoContext(v: unknown): v is AutoContext & { latest_message_id: string; after_hours_message?: string } {
  return (
    isObj(v) &&
    typeof v.latest_message_id === "string" &&
    (Array.isArray(v.messages) || typeof v.after_hours_message === "string") &&
    (v.messages === undefined || (Array.isArray(v.messages) && v.messages.every((m) => isObj(m) && typeof m.text === "string" && (m.direction === "inbound" || m.direction === "outbound"))))
  );
}

type FinalStatus = "ok" | "timeout" | "provider_error" | "rate_limited" | "invalid_output";

interface JobRow {
  id: string;
}

interface Ctx {
  deps: AutoDeps;
  /** Apresentação da assistente a prefixar na 1ª saída da conversa (por JOB; o Ctx base é compartilhado e nunca a recebe). */
  intro?: string | null;
}

async function completeJob(
  c: Ctx,
  jobId: string,
  outcome: string,
  reason: string | null,
  opts: { usageId?: string | null; handled?: string | null; handoff?: boolean } = {},
): Promise<void> {
  const r = await call(c.deps.admin, "whatsapp_ai_complete_job", {
    p_job_id: jobId,
    p_outcome: outcome,
    p_reason_code: reason,
    p_usage_id: opts.usageId ?? null,
    p_handled_latest_message_id: opts.handled ?? null,
    p_handoff: opts.handoff === true,
  });
  if (r.error) console.error("whatsapp-ai-auto: não encerrou o job", { code: r.error.code ?? null, outcome });
}

async function finalizeUsage(c: Ctx, usageId: string, status: FinalStatus, input: number | null, output: number | null, latency: number): Promise<void> {
  const r = await call(c.deps.admin, "whatsapp_ai_finalize_usage", {
    p_usage_id: usageId,
    p_status: status,
    p_input_tokens: input,
    p_output_tokens: output,
    p_latency_ms: Math.max(0, Math.round(latency)),
  });
  if (r.error) console.error("whatsapp-ai-auto: não finalizou o uso", { code: r.error.code ?? null });
}

// Rastreio SEM conteúdo da base de conhecimento (usado?, nº de produtos, tipos, consultas, código de bloqueio). Falha só é logada.
async function recordKnowledge(c: Ctx, usageId: string, facts: KnowledgeFacts, safetyReason: string | null): Promise<void> {
  const r = await call(c.deps.admin, "whatsapp_ai_record_knowledge_usage", {
    p_usage_id: usageId,
    p_knowledge_used: true,
    p_product_count: facts.products.length,
    p_kinds: knowledgeKinds(facts),
    p_lookup_count: 1,
    p_safety_reason: safetyReason,
  });
  if (r.error) console.error("whatsapp-ai-auto: não registrou o uso do conhecimento", { code: r.error.code ?? null });
}

/** Handoff (conversa vai para o humano) quando fallback_to_human=true; senão apenas não responde (ignored). */
async function handoffOrIgnore(
  c: Ctx,
  jobId: string,
  fallback: boolean,
  reason: string,
  opts: { usageId?: string | null; handled?: string | null; failureOutcome?: string } = {},
): Promise<string> {
  if (opts.failureOutcome) {
    // erro do provedor/timeout/saída inválida: o desfecho é a própria falha; a conversa só vai ao humano se permitido
    await completeJob(c, jobId, opts.failureOutcome, reason, { usageId: opts.usageId, handled: opts.handled, handoff: fallback });
    return opts.failureOutcome;
  }
  if (fallback) {
    await completeJob(c, jobId, "handoff", reason, { usageId: opts.usageId, handled: opts.handled, handoff: true });
    return "handoff";
  }
  await completeJob(c, jobId, "ignored", reason, { usageId: opts.usageId, handled: opts.handled });
  return "ignored";
}

async function commitAndDispatch(
  c: Ctx,
  jobId: string,
  latest: string,
  body: string,
  opts: {
    usageId: string | null;
    okOutcome: string;
    okReason: string;
    fallback: boolean;
    onSent?: (messageId: string) => Promise<void>;
    /** Envio do cardápio: commit do DOCUMENTO (mesmas barreiras do automático) + despacho por media_id. */
    menu?: { hash: string; document: DispatchDocument };
  },
): Promise<string> {
  // APRESENTAÇÃO (Fase 2): só na 1ª saída da conversa, prefixo FIXO do banco; as checagens de segurança já rodaram sobre a resposta pura
  const finalBody = composeWithIntro(c.intro ?? null, body);
  const commit = opts.menu
    ? await call(c.deps.admin, "whatsapp_ai_menu_commit_send", { p_job_id: jobId, p_context_latest_message_id: latest, p_caption: finalBody, p_hash: opts.menu.hash })
    : await call(c.deps.admin, "whatsapp_ai_auto_commit_send", { p_job_id: jobId, p_context_latest_message_id: latest, p_body: finalBody });
  const res = isObj(commit.data) ? commit.data : null;
  if (commit.error || !res || typeof res.result !== "string") {
    console.error("whatsapp-ai-auto: commit falhou", { code: commit.error?.code ?? null });
    return "left_for_retry"; // lease expira e o job é recuperado; a mensagem (se existir) é única por job
  }
  if (res.result === "not_active") return "not_active";
  if (res.result === "stale") return "left_for_retry"; // o catálogo mudou entre a geração e o envio: o job é retomado e gera de novo
  if (res.result === "rescheduled") return "rescheduled"; // entrou inbound novo: a resposta antiga NÃO é enviada
  if (res.result === "abort") {
    const outcome = typeof res.outcome === "string" ? res.outcome : "aborted_mode";
    const reason = typeof res.reason === "string" ? res.reason : "aborted";
    await completeJob(c, jobId, outcome, reason, { usageId: opts.usageId, handoff: outcome === "handoff" && opts.fallback });
    return outcome;
  }
  const messageId = typeof res.message_id === "string" ? res.message_id : null;
  if (!messageId) return "left_for_retry";

  if (res.result === "existing") {
    // retry de worker: NUNCA reenviar. Se ficou 'queued', o envio foi interrompido: falha explícita (igual ao envio manual).
    const st = typeof res.status === "string" ? res.status : "";
    if (st === "queued") {
      await markMessageFailed(c.deps.admin, messageId, "send_interrupted");
      await completeJob(c, jobId, "failed_send", "send_interrupted", { usageId: opts.usageId });
      return "failed_send";
    }
    if (st === "failed") {
      await completeJob(c, jobId, "failed_send", "send_failed", { usageId: opts.usageId });
      return "failed_send";
    }
    // retry de worker com a mensagem já enviada: garante o que depende do envio (ex.: marcar o resumo do pedido)
    if (opts.onSent && (st === "sent" || st === "delivered" || st === "read")) await opts.onSent(messageId);
    await completeJob(c, jobId, opts.okOutcome, opts.okReason, { usageId: opts.usageId, handled: latest });
    return opts.okOutcome;
  }

  // result === 'queued' => fluxo OFICIAL de despacho
  const graphVersion = c.deps.graphVersion as string; // validado antes de claimar
  const sent = await dispatchQueuedMessage({ admin: c.deps.admin, graph: c.deps.graph, graphVersion }, messageId, opts.menu?.document);
  if (sent.ok) {
    if (opts.onSent) await opts.onSent(messageId);
    await completeJob(c, jobId, opts.okOutcome, opts.okReason, { usageId: opts.usageId, handled: latest });
    return opts.okOutcome;
  }
  await completeJob(c, jobId, "failed_send", sent.errorCode, { usageId: opts.usageId });
  return "failed_send";
}

// IO do fluxo de PEDIDO: reaproveita a cota, o provedor, o commit/dispatch OFICIAIS e o encerramento do job do fluxo de sempre.
function makeOrderIo(c: Ctx, jobId: string, latest: string, fallback: boolean): OrderFlowIo {
  let usageId: string | null = null;
  return {
    rpc: (fn, args) => call(c.deps.admin, fn, args),
    async extract(system, user, validate) {
      const decider = c.deps.decider as AiDecider;
      const rsv = await call(c.deps.admin, "whatsapp_ai_reserve_auto_usage", { p_job_id: jobId, p_provider: decider.provider, p_model: decider.model });
      const rd = isObj(rsv.data) ? rsv.data : {};
      if (rsv.error || (rd.result !== "reserved" && rd.result !== "blocked")) {
        console.error("whatsapp-ai-auto: reserva de cota (pedido) falhou", { code: rsv.error?.code ?? null });
        return { ok: false, outcome: "left_for_retry" };
      }
      if (rd.result === "blocked") {
        await completeJob(c, jobId, "blocked_quota", typeof rd.reason === "string" ? rd.reason : "auto_minute");
        return { ok: false, outcome: "blocked_quota" };
      }
      usageId = typeof rd.usage_id === "string" ? rd.usage_id : null;
      if (!usageId) return { ok: false, outcome: "left_for_retry" };
      const now = c.deps.now ?? Date.now;
      const started = now();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<{ ok: false; kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve({ ok: false, kind: "timeout" }); }, ORDER_TIMEOUT_MS);
      });
      let result;
      try {
        result = await Promise.race([
          decider.decide({ system, user, timeoutMs: ORDER_TIMEOUT_MS, signal: controller.signal, schema: ORDER_EXTRACT_SCHEMA as unknown as { name: string; schema: object }, maxOutputTokens: ORDER_MAX_OUTPUT_TOKENS }),
          timeout,
        ]);
      } catch (e) {
        console.error("whatsapp-ai-auto: provedor (pedido) lançou exceção", { name: e instanceof Error ? e.name : null });
        result = { ok: false as const, kind: "provider_error" as const };
      } finally {
        if (timer) clearTimeout(timer);
      }
      const latency = now() - started;
      if (!result.ok) {
        await finalizeUsage(c, usageId, result.kind, null, null, latency);
        console.error("whatsapp-ai-auto: geração (pedido) falhou", { kind: result.kind });
        return { ok: false, outcome: await handoffOrIgnore(c, jobId, fallback, result.kind, { usageId, handled: latest, failureOutcome: result.kind }) };
      }
      if (!validate(result.text)) {
        await finalizeUsage(c, usageId, "invalid_output", result.inputTokens, result.outputTokens, latency);
        return { ok: false, outcome: await handoffOrIgnore(c, jobId, fallback, "invalid_output", { usageId, handled: latest, failureOutcome: "invalid_output" }) };
      }
      await finalizeUsage(c, usageId, "ok", result.inputTokens, result.outputTokens, latency);
      return { ok: true, text: result.text };
    },
    reply: (body, o) => commitAndDispatch(c, jobId, latest, body, { usageId, okOutcome: o.outcome, okReason: o.reason, fallback, onSent: o.onSent }),
    async complete(outcome, reason, o) {
      await completeJob(c, jobId, outcome, reason, { usageId, handled: o?.handled ?? null, handoff: o?.handoff });
      return outcome;
    },
  };
}

// ---------------------------------------------------------------------------
// CARDÁPIO EM PDF (documento por media_id). Determinístico e sem IA: pedido explícito, ou aceite de uma oferta PENDENTE (decidida no
// banco). Falha de leitura do contexto devolve null e o atendimento segue pelo fluxo de sempre.
// ---------------------------------------------------------------------------
interface MenuCtx {
  companyId: string;
  companyName: string;
  productCount: number;
  hash: string;
  offerPending: boolean;
  offerAllowed: boolean;
  cachedPath: string | null;
  catalog: MenuCatalog | null;
}

function parseMenuCtx(v: unknown): MenuCtx | null {
  if (!isObj(v) || v.enabled !== true) return null;
  if (typeof v.company_id !== "string" || typeof v.catalog_hash !== "string" || !/^[0-9a-f]{32}$/.test(v.catalog_hash)) return null;
  const cat = v.catalog;
  const catalog = isObj(cat) && typeof cat.company === "string" && Array.isArray(cat.categories) ? (cat as unknown as MenuCatalog) : null;
  return {
    companyId: v.company_id,
    companyName: typeof v.company_name === "string" ? v.company_name : "",
    productCount: typeof v.product_count === "number" ? v.product_count : 0,
    hash: v.catalog_hash,
    offerPending: v.offer_pending === true,
    offerAllowed: v.offer_allowed === true,
    cachedPath: typeof v.cached_path === "string" ? v.cached_path : null,
    catalog,
  };
}

async function menuContext(c: Ctx, jobId: string, withCatalog: boolean): Promise<MenuCtx | null> {
  const r = await call(c.deps.admin, "whatsapp_ai_menu_context", { p_job_id: jobId, p_with_catalog: withCatalog });
  if (r.error) {
    console.error("whatsapp-ai-auto: contexto do cardápio falhou", { code: r.error.code ?? null });
    return null;
  }
  return parseMenuCtx(r.data);
}

/** Bytes do PDF vigente: do cache (hash igual ao do catálogo) ou gerados agora e guardados. null = indisponível. */
async function menuBytes(c: Ctx, jobId: string, m: MenuCtx): Promise<{ bytes: Uint8Array; hash: string } | null> {
  const menu = c.deps.menu as MenuDeps;
  if (m.cachedPath) {
    const cached = await menu.download(m.cachedPath).catch(() => null);
    if (cached && cached.length > 0) return { bytes: cached, hash: m.hash };
  }
  const fresh = await menuContext(c, jobId, true);
  if (!fresh || !fresh.catalog || fresh.productCount === 0) return null;
  const bytes = buildMenuPdf(fresh.catalog, new Date((c.deps.now ?? Date.now)()));
  if (bytes.length === 0 || bytes.length > MENU_PDF_MAX_BYTES) return null;
  const path = `${fresh.companyId}/${fresh.hash}.pdf`;
  if (!(await menu.upload(path, bytes).catch(() => false))) return null;
  const stored = await call(c.deps.admin, "whatsapp_ai_menu_store", { p_job_id: jobId, p_hash: fresh.hash, p_path: path, p_size: bytes.length });
  if (stored.error || stored.data !== true) return null;
  return { bytes, hash: fresh.hash };
}

/**
 * Pedido/aceite do cardápio. Devolve o desfecho do job, ou null quando NÃO é o caso (o fluxo de sempre segue). Nunca consome cota
 * de IA. Falha de geração/upload/envio = failed_send (com handoff quando permitido); nunca diz ao cliente que enviou.
 */
async function tryMenu(c: Ctx, jobId: string, latest: string, inbound: string[], fallback: boolean): Promise<string | null> {
  const intent = menuIntent(inbound);
  if (!intent) return null;
  const m = await menuContext(c, jobId, false);
  if (!m || m.productCount === 0) return null;
  if (intent === "acceptance" && !m.offerPending) return null; // "sim" sem oferta pendente é conversa normal
  const built = await menuBytes(c, jobId, m);
  if (!built) {
    console.error("whatsapp-ai-auto: cardápio indisponível");
    await completeJob(c, jobId, "failed_send", "menu_pdf_unavailable", { handled: latest, handoff: fallback });
    return "failed_send";
  }
  return await commitAndDispatch(c, jobId, latest, MENU_CAPTION, {
    usageId: null,
    okOutcome: "replied",
    okReason: "menu_pdf_sent",
    fallback,
    menu: { hash: built.hash, document: { bytes: built.bytes, filename: menuFilename(m.companyName), mimeType: "application/pdf" } },
  });
}

async function processJob(base: Ctx, job: JobRow): Promise<string> {
  const { deps } = base;
  let c: Ctx = base;
  const decider = deps.decider as AiDecider;

  const prep = await call(deps.admin, "whatsapp_ai_prepare_auto", { p_job_id: job.id });
  const p = isObj(prep.data) ? prep.data : null;
  if (prep.error || !p) {
    console.error("whatsapp-ai-auto: prepare falhou", { code: prep.error?.code ?? null });
    return "left_for_retry";
  }
  if (p.resume === true && typeof p.message_id === "string") {
    // RETOMADA: o job já tem saída (worker caiu depois do commit). NUNCA gera nem reenvia; só resolve o estado dela,
    // exatamente como o envio manual trata um 'queued' parado (falha explícita 'send_interrupted').
    const st = typeof p.status === "string" ? p.status : "";
    if (st === "queued") {
      await markMessageFailed(deps.admin, p.message_id, "send_interrupted");
      await completeJob(c, job.id, "failed_send", "send_interrupted");
      return "failed_send";
    }
    if (st === "failed") {
      await completeJob(c, job.id, "failed_send", "send_failed");
      return "failed_send";
    }
    if (p.after_hours === true) {
      await completeJob(c, job.id, "out_of_hours", "after_hours_message_sent");
      return "out_of_hours";
    }
    await completeJob(c, job.id, "replied", "answered");
    return "replied";
  }
  if (p.proceed !== true) {
    const outcome = typeof p.outcome === "string" ? p.outcome : null;
    if (!outcome) return "not_active";
    await completeJob(c, job.id, outcome, typeof p.reason === "string" ? p.reason : null);
    return outcome;
  }
  if (!isAutoContext(p)) {
    console.error("whatsapp-ai-auto: contexto inesperado");
    return "left_for_retry";
  }
  const latest = p.latest_message_id;

  // APRESENTAÇÃO da assistente (Fase 2): o banco diz se esta será a 1ª saída da conversa e entrega a frase pronta. Falha ou migration
  // ausente = sem apresentação (comportamento anterior), nunca erro. O nome da assistente jamais entra em prompt.
  const introRes = await call(deps.admin, "whatsapp_ai_auto_intro", { p_job_id: job.id });
  const introData = isObj(introRes.data) ? introRes.data : null;
  const intro = !introRes.error && introData && introData.first === true && typeof introData.intro === "string" && introData.intro.length > 0 ? introData.intro : null;
  if (intro) c = { deps, intro };

  // fora do expediente com mensagem fixa: SEM IA
  if (typeof p.after_hours_message === "string" && !Array.isArray(p.messages)) {
    return await commitAndDispatch(c, job.id, latest, p.after_hours_message, {
      usageId: null,
      okOutcome: "out_of_hours",
      okReason: "after_hours_message_sent",
      fallback: false,
    });
  }

  const ctx = p as AutoContext & { latest_message_id: string };
  const fallback = ctx.fallback_to_human === true;

  // 1ª saída E o cliente só cumprimentou ("Oi", "Bom dia"): resposta 100% template, SEM OpenAI e sem gastar cota
  if (intro) {
    const pending = unansweredTail(ctx.messages).filter((m) => m.direction === "inbound");
    if (pending.length > 0 && pending.every((m) => isGreetingOnly(m.text))) {
      // Cardápio: a saudação pode OFERECER o PDF (uma vez por conversa); o envio só acontece se o cliente pedir/aceitar depois.
      let offer = false;
      if (deps.menu) {
        const mc = await menuContext(c, job.id, false);
        offer = !!mc && mc.productCount > 0 && mc.offerAllowed;
      }
      return await commitAndDispatch(c, job.id, latest, offer ? `${greetingReply(intro)} ${MENU_OFFER_TEXT}` : greetingReply(intro), {
        usageId: null,
        okOutcome: "replied",
        okReason: "intro_greeting",
        fallback,
        onSent: offer
          ? async (messageId) => {
              const r = await call(deps.admin, "whatsapp_ai_menu_register_offer", { p_job_id: job.id, p_message_id: messageId });
              if (r.error) console.error("whatsapp-ai-auto: não registrou a oferta do cardápio", { code: r.error.code ?? null });
            }
          : undefined,
      });
    }
  }

  // pré-filtros determinísticos: sem custo de IA
  const pre = preFilter(ctx);
  // CARDÁPIO EM PDF: antes do pedido/IA, mas nunca por cima de um handoff duro (injeção, humano, jurídico, cobrança, reclamação, mídia).
  if (deps.menu && (!pre || pre.action === "ignore" || pre.reason_code === "action_required")) {
    const inbound = unansweredTail(ctx.messages)
      .filter((m) => m.direction === "inbound" && (m.type === undefined || m.type === "text" || m.type === "interactive"))
      .map((m) => m.text);
    const sent = await tryMenu(c, job.id, latest, inbound, fallback);
    if (sent) return sent;
  }
  // PEDIDO CONVERSACIONAL (só roda com order_drafts_enabled=true e as migrations aplicadas; senão devolve handled=false e o fluxo
  // de sempre segue IGUAL). Handoffs duros (injeção, humano, jurídico, cobrança, reclamação, mídia) continuam sendo os de sempre.
  let orderActive = false;
  if (!(pre && pre.action === "handoff" && pre.reason_code !== "action_required")) {
    const flow = await runOrderFlow(makeOrderIo(c, job.id, latest, fallback), {
      jobId: job.id, latest, messages: ctx.messages, businessName: ctx.business_name, customerFirstName: ctx.customer_first_name, fallback, pre,
    });
    if (flow.handled) return flow.outcome;
    orderActive = flow.active;
  }
  if (pre) {
    if (pre.action === "ignore") {
      await completeJob(c, job.id, "ignored", pre.reason_code, { handled: latest });
      return "ignored";
    }
    return await handoffOrIgnore(c, job.id, fallback, pre.reason_code, { handled: latest });
  }

  // BASE DE CONHECIMENTO (Etapa 3): só com knowledge_enabled=true (senão a RPC devolve {enabled:false} e nada muda). UMA consulta ao
  // banco com a MESMA busca do suggest; a empresa vem do JOB no banco. A busca usa a ÚLTIMA mensagem do cliente (a anterior só entra
  // quando a última depende dela). Falha na consulta = falha fechada: nada é gerado nem enviado, o job é retomado depois.
  const kQuery = knowledgeQuery(ctx.messages);
  const lookup = await call(deps.admin, "whatsapp_ai_lookup_knowledge_job", { p_job_id: job.id, p_query: kQuery, p_limit: KNOWLEDGE_LOOKUP_LIMIT });
  if (lookup.error) {
    console.error("whatsapp-ai-auto: consulta de conhecimento falhou", { code: lookup.error.code ?? null });
    return "left_for_retry";
  }
  const facts = parseKnowledge(lookup.data);
  // com a base ligada, pedido/compra não gasta IA: handoff direto (o automático nunca cria, anota nem reserva pedido)
  if (facts && isOrderIntent(kQuery) && !orderActive) {
    return await handoffOrIgnore(c, job.id, fallback, "action_required", { handled: latest });
  }

  // reserva atômica da cota ANTES do provedor
  const rsv = await call(deps.admin, "whatsapp_ai_reserve_auto_usage", { p_job_id: job.id, p_provider: decider.provider, p_model: decider.model });
  const rd = isObj(rsv.data) ? rsv.data : {};
  if (rsv.error || (rd.result !== "reserved" && rd.result !== "blocked")) {
    console.error("whatsapp-ai-auto: reserva de cota falhou", { code: rsv.error?.code ?? null, result: typeof rd.result === "string" ? rd.result : null });
    return "left_for_retry"; // falha fechada: sem reserva, sem provedor
  }
  if (rd.result === "blocked") {
    await completeJob(c, job.id, "blocked_quota", typeof rd.reason === "string" ? rd.reason : "auto_minute");
    return "blocked_quota";
  }
  const usageId = typeof rd.usage_id === "string" ? rd.usage_id : null;
  if (!usageId) return "left_for_retry";

  // com fatos, o prompt ganha a seção FATOS AUTORIZADOS (+ regras do auto); sem fatos é EXATAMENTE o prompt de sempre
  const systemPrompt = facts ? [buildAutoSystemPrompt(ctx), ...buildFactsBlock(facts, "auto")].join("\n") : buildAutoSystemPrompt(ctx);
  let knowledgeRecorded = false;
  const recordKn = async (reason: string | null): Promise<void> => {
    if (!facts || knowledgeRecorded) return;
    knowledgeRecorded = true;
    await recordKnowledge(c, usageId, facts, reason);
  };

  // provedor (timeout, sem retry)
  const now = deps.now ?? Date.now;
  const started = now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, kind: "timeout" });
    }, AUTO_TIMEOUT_MS);
  });
  let result;
  try {
    result = await Promise.race([
      decider.decide({ system: systemPrompt, user: buildAutoConversationBlock(ctx), timeoutMs: AUTO_TIMEOUT_MS, signal: controller.signal }),
      timeout,
    ]);
  } catch (e) {
    console.error("whatsapp-ai-auto: provedor lançou exceção", { name: e instanceof Error ? e.name : null });
    result = { ok: false as const, kind: "provider_error" as const };
  } finally {
    if (timer) clearTimeout(timer);
  }
  const latency = now() - started;

  if (!result.ok) {
    await finalizeUsage(c, usageId, result.kind, null, null, latency);
    await recordKn(null);
    console.error("whatsapp-ai-auto: geração falhou", { kind: result.kind });
    return await handoffOrIgnore(c, job.id, fallback, result.kind, { usageId, handled: latest, failureOutcome: result.kind });
  }

  const v = validateDecision(result.text);
  if (!v.ok) {
    await finalizeUsage(c, usageId, "invalid_output", result.inputTokens, result.outputTokens, latency);
    await recordKn(null);
    console.error("whatsapp-ai-auto: decisão inválida", { why: v.why });
    return await handoffOrIgnore(c, job.id, fallback, "invalid_output", { usageId, handled: latest, failureOutcome: "invalid_output" });
  }
  await finalizeUsage(c, usageId, "ok", result.inputTokens, result.outputTokens, latency);
  const d = v.decision;

  if (d.action === "ignore") {
    await recordKn(null);
    await completeJob(c, job.id, "ignored", d.reason_code, { usageId, handled: latest });
    return "ignored";
  }
  if (d.action === "handoff") {
    await recordKn(null);
    return await handoffOrIgnore(c, job.id, fallback, d.reason_code, { usageId, handled: latest });
  }

  // action === 'reply': só com confiança alta e dentro das checagens de segurança
  if (d.confidence !== "high") {
    await recordKn(null);
    return await handoffOrIgnore(c, job.id, fallback, "low_confidence", { usageId, handled: latest });
  }
  const reply = d.reply as string;
  if (reply.length > AUTO_REPLY_MAX_CHARS) {
    await recordKn(null);
    return await handoffOrIgnore(c, job.id, fallback, "invalid_output", { usageId, handled: latest, failureOutcome: "invalid_output" });
  }
  // Com fatos: a MESMA checagem do suggest (fatos + instruções + horário; preço/produto/pagamento/horário/entrega/disponibilidade).
  // Sem fatos: a checagem de sempre. Fora dos fatos => handoff, zero mensagem.
  const safe = facts ? checkSuggestionSafety(reply, facts, ctx, { strictProducts: true }) : checkReplySafety(reply, ctx);
  if (!safe.ok) {
    await recordKn(safe.reason_code === "action_required" ? "action_required" : "unsupported_commercial_claim");
    return await handoffOrIgnore(c, job.id, fallback, safe.reason_code ?? "other", { usageId, handled: latest });
  }

  await recordKn(null);
  return await commitAndDispatch(c, job.id, latest, reply, { usageId, okOutcome: "replied", okReason: "answered", fallback });
}

export async function handleWhatsappAiAuto(req: Request, deps: AutoDeps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  const auth = authorizeInternalRequest(deps.internalSecret, req.headers.get("x-internal-secret"));
  if (auth === "misconfigured") {
    console.error("whatsapp-ai-auto: segredo interno ausente ou curto");
    return json({ error: "Indisponível." }, 503);
  }
  if (auth !== "authorized") return json({ error: "Não autorizado." }, 401);

  // KILL SWITCH: só "true" liga. Desligada, nada é claimado, gerado ou enviado.
  if (deps.killSwitch !== "true") return json({ processed: 0, disabled: true });

  if (!deps.decider) {
    console.error("whatsapp-ai-auto: provedor de IA não configurado");
    return json({ error: "Indisponível." }, 503);
  }
  if (!isValidGraphVersion(deps.graphVersion)) {
    console.error("whatsapp-ai-auto: WHATSAPP_GRAPH_API_VERSION ausente ou inválida");
    return json({ error: "Indisponível." }, 503);
  }

  const claim = await call(deps.admin, "whatsapp_ai_claim_jobs", { p_limit: deps.maxJobs ?? MAX_JOBS, p_lease_seconds: 120 });
  if (claim.error) {
    console.error("whatsapp-ai-auto: claim falhou", { code: claim.error.code ?? null });
    return json({ error: "Falha ao processar." }, 500);
  }
  const jobs = (Array.isArray(claim.data) ? claim.data : []).filter((j): j is JobRow => isObj(j) && typeof j.id === "string");

  const c: Ctx = { deps };
  const outcomes: string[] = [];
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    const done = await Promise.all(
      batch.map(async (job) => {
        try {
          return await processJob(c, job);
        } catch (e) {
          // exceção inesperada: o job fica 'processing' e o lease expira (no máx. 3 tentativas)
          console.error("whatsapp-ai-auto: exceção no job", { name: e instanceof Error ? e.name : null });
          return "error";
        }
      }),
    );
    outcomes.push(...done);
  }
  return json({ processed: jobs.length, outcomes });
}
