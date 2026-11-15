// Edge Function whatsapp-webhook (PÚBLICA, verify_jwt = false): recebe os eventos da WhatsApp Business Platform (Cloud API).
//
// Segurança e semântica
//   * GET (verificação do webhook): hub.mode=subscribe + hub.verify_token == WHATSAPP_VERIFY_TOKEN => devolve hub.challenge;
//     qualquer outro caso => 403. Sem WHATSAPP_VERIFY_TOKEN configurado => 503.
//   * POST: o corpo BRUTO é autenticado por X-Hub-Signature-256 (HMAC-SHA256 com WHATSAPP_APP_SECRET), comparado em tempo
//     constante. Ausente/inválida => 401 e NADA é gravado. Sem WHATSAPP_APP_SECRET => 503.
//   * A empresa vem SEMPRE de metadata.phone_number_id (conexão cadastrada); nunca do telefone do cliente. Conexão
//     desconhecida/inativa => 200 sem gravar (a Meta não deve reentregar para sempre).
//   * Idempotência: chave do evento derivada do id da Meta (mensagem: wamid; status: wamid+status+timestamp). A dedupe e
//     o processamento são UMA transação no banco (whatsapp_ingest_message / whatsapp_ingest_status).
//   * Replay: assinatura + dedupe. Não há limite de idade do evento de propósito: a Meta reentrega eventos legítimos
//     dias depois e descartá-los perderia mensagens.
//   * Resposta rápida: nenhum processamento pesado aqui (só validar, extrair o mínimo e chamar o banco). 5xx SÓ para
//     falha transitória do banco, para a Meta reentregar.
//   * O que se grava é MÍNIMO (id, telefone, nome, tipo, texto/legenda, horário). Nenhum payload bruto; nenhum segredo,
//     assinatura ou corpo é logado.
export interface RpcResult {
  data: unknown;
  error: { message?: string; code?: string } | null;
}

export interface WebhookDeps {
  verifyToken: string | undefined;
  appSecret: string | undefined;
  db: { rpc(fn: string, args: Record<string, unknown>): Promise<RpcResult> };
}

// 8 MiB: pedaços de histórico da Coexistence podem ter milhares de mensagens (a assinatura cobre o corpo inteiro)
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const JSON_HEADERS = { "Content-Type": "application/json" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Comparação em tempo constante de duas strings. */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Unix segundos (string) da Meta => ISO; nulo quando inválido. */
function isoFromUnix(v: unknown): string | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

interface ParsedMessage {
  id: string;
  from: string;
  name: string | null;
  type: string;
  body: string | null;
  timestamp: string | null;
}

/** Só o conteúdo textual necessário; mídia vira tipo (+ legenda). Reações não viram mensagem. */
export function parseMessage(raw: unknown, contacts: unknown[]): ParsedMessage | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const from = str(raw.from);
  const kind = str(raw.type) ?? "unknown";
  if (!id || !from || kind === "reaction") return null;

  let type = "unknown";
  let body: string | null = null;
  if (kind === "text" && isObj(raw.text)) {
    type = "text";
    body = str(raw.text.body);
  } else if (kind === "image" && isObj(raw.image)) {
    type = "image";
    body = str(raw.image.caption);
  } else if ((kind === "audio" || kind === "voice") && isObj(raw.audio)) {
    type = "audio";
  } else if (kind === "document" && isObj(raw.document)) {
    type = "document";
    body = str(raw.document.caption);
  } else if (kind === "location") {
    type = "location";
  } else if (kind === "interactive" && isObj(raw.interactive)) {
    type = "interactive";
    const br = isObj(raw.interactive.button_reply) ? raw.interactive.button_reply : null;
    const lr = isObj(raw.interactive.list_reply) ? raw.interactive.list_reply : null;
    body = str(br?.title) ?? str(lr?.title);
  } else if (kind === "button" && isObj(raw.button)) {
    type = "interactive";
    body = str(raw.button.text);
  }

  let name: string | null = null;
  for (const c of contacts) {
    if (!isObj(c)) continue;
    const profile = isObj(c.profile) ? c.profile : null;
    if (str(c.wa_id) === from && str(profile?.name)) {
      name = str(profile?.name);
      break;
    }
  }
  if (!name) {
    const first = contacts.find(isObj) as Obj | undefined;
    name = isObj(first?.profile) ? str((first!.profile as Obj).name) : null;
  }

  return { id, from, name, type, body, timestamp: isoFromUnix(raw.timestamp) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Coexistence (app WhatsApp Business + Cloud API): smb_message_echoes, smb_app_state_sync, history, account_update.
// O banco decide tudo (RPCs service_role): eco só vale em conexão 'coexistence'; sincronização e account_update guardam SÓ contagens e
// nomes de evento (nunca texto, telefone, nome ou payload). Nenhum histórico é importado.
// ---------------------------------------------------------------------------------------------------------------------
const COEXISTENCE_FIELDS = new Set(["smb_message_echoes", "smb_app_state_sync", "history", "account_update"]);

async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

interface Counts { stored: number; duplicate: number; ignored: number }
function tally(counts: Counts, result: unknown): void {
  if (result === "stored" || result === "recorded") counts.stored += 1;
  else if (result === "duplicate") counts.duplicate += 1;
  else counts.ignored += 1;
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e9 ? Math.floor(v) : null);

/** Texto/legenda de uma mensagem de eco (mesmas regras das mensagens recebidas; mídia vira só tipo + legenda). */
export function parseEchoBody(raw: Obj): { type: string; body: string | null } {
  const kind = str(raw.type) ?? "unknown";
  if (kind === "text" && isObj(raw.text)) return { type: "text", body: str(raw.text.body) };
  if (kind === "image" && isObj(raw.image)) return { type: "image", body: str(raw.image.caption) };
  if ((kind === "audio" || kind === "voice") && isObj(raw.audio)) return { type: "audio", body: null };
  if (kind === "document" && isObj(raw.document)) return { type: "document", body: str(raw.document.caption) };
  if (kind === "location") return { type: "location", body: null };
  if (kind === "interactive") return { type: "interactive", body: null };
  return { type: "unknown", body: null };
}

async function handleCoexistenceChange(
  deps: WebhookDeps,
  entry: Obj,
  change: Obj,
  field: string,
  counts: Counts,
): Promise<"ok" | "transient"> {
  const value = change.value as Obj;
  const pnid = isObj(value.metadata) ? str(value.metadata.phone_number_id) : null;
  const call = async (fn: string, args: Record<string, unknown>): Promise<unknown | "transient"> => {
    const res = await deps.db.rpc(fn, args);
    if (res.error) {
      console.error("whatsapp-webhook: falha transitória (coexistence)", fn, res.error.code ?? "");
      return "transient";
    }
    return isObj(res.data) ? str(res.data.result) : null;
  };

  if (field === "account_update") {
    const waba = str(entry.id);
    const event = str(value.event);
    if (!waba || !event) {
      counts.ignored += 1;
      return "ok";
    }
    const di = isObj(value.disconnection_info) ? value.disconnection_info : null;
    const reason = str(di?.reason);
    const key = `acct:${waba}:${await sha256Hex(JSON.stringify({ t: entry.time ?? null, e: event, r: reason }))}`;
    // entry.time (segundos Unix) ordena eventos atrasados/fora de ordem no banco; sem ele o evento só é registrado
    const evTime = typeof entry.time === "number" && Number.isFinite(entry.time) ? Math.floor(entry.time) : (typeof entry.time === "string" && /^[0-9]{9,12}$/.test(entry.time) ? Number(entry.time) : null);
    const r = await call("whatsapp_coexistence_account_update", { p_waba_id: waba, p_event: event, p_reason: reason, p_event_key: key, p_event_time: evTime });
    if (r === "transient") return "transient";
    tally(counts, r);
    return "ok";
  }

  if (!pnid) {
    counts.ignored += 1;
    return "ok";
  }

  if (field === "smb_message_echoes") {
    const contacts = arr(value.contacts);
    for (const rawEcho of arr(value.message_echoes)) {
      if (!isObj(rawEcho)) {
        counts.ignored += 1;
        continue;
      }
      const id = str(rawEcho.id);
      const kind = str(rawEcho.type) ?? "unknown";
      if (!id || kind === "reaction") {
        counts.ignored += 1;
        continue;
      }
      if (kind === "revoke" || kind === "edit") {
        // só registra (sem conteúdo); nada é apagado nem alterado nesta etapa
        const r = await call("whatsapp_coexistence_record", {
          p_phone_number_id: pnid,
          p_kind: kind === "revoke" ? "echo_revoke" : "echo_edit",
          p_event_name: kind,
          p_event_key: `echoev:${pnid}:${id}:${kind}:${str(rawEcho.timestamp) ?? ""}`,
          p_detail: {},
        });
        if (r === "transient") return "transient";
        tally(counts, r);
        continue;
      }
      const firstContact = contacts.find(isObj) as Obj | undefined;
      const to = str(rawEcho.to) ?? str(firstContact?.wa_id);
      const { type, body } = parseEchoBody(rawEcho);
      const r = await call("whatsapp_ingest_echo", {
        p_phone_number_id: pnid,
        p_provider_message_id: id,
        p_to: to,
        p_type: type,
        p_body: body,
        p_provider_timestamp: isoFromUnix(rawEcho.timestamp),
        p_event_key: `echo:${pnid}:${id}`,
      });
      if (r === "transient") return "transient";
      tally(counts, r);
    }
    return "ok";
  }

  if (field === "smb_app_state_sync") {
    const items = arr(value.state_sync);
    let added = 0;
    let removed = 0;
    for (const it of items) {
      if (!isObj(it)) continue;
      if (it.action === "add") added += 1;
      else if (it.action === "remove") removed += 1;
    }
    const key = `sync:${pnid}:${await sha256Hex(JSON.stringify(items))}`;
    const r = await call("whatsapp_coexistence_record", { p_phone_number_id: pnid, p_kind: "contact_sync", p_event_name: "smb_app_state_sync", p_event_key: key, p_detail: { added, removed } });
    if (r === "transient") return "transient";
    tally(counts, r);
    return "ok";
  }

  // history: só metadados (fase, ordem do pedaço, progresso, contagens) ou a recusa do cliente; o conteúdo NUNCA é lido nem guardado
  if (Array.isArray(value.messages) && value.messages.length > 0) counts.ignored += 1; // webhook de mídia do histórico: fora desta etapa
  for (const item of arr(value.history)) {
    if (!isObj(item)) {
      counts.ignored += 1;
      continue;
    }
    const errors = arr(item.errors);
    if (errors.length > 0) {
      const first = isObj(errors[0]) ? errors[0] : null;
      const code = num(first?.code) ?? 0;
      const r = await call("whatsapp_coexistence_record", { p_phone_number_id: pnid, p_kind: "history_declined", p_event_name: "history", p_event_key: `histdecl:${pnid}:${code}`, p_detail: { error_code: code } });
      if (r === "transient") return "transient";
      tally(counts, r);
      continue;
    }
    const md = isObj(item.metadata) ? item.metadata : {};
    const phase = num(md.phase);
    const chunk = num(md.chunk_order);
    const progress = num(md.progress);
    if (phase === null || chunk === null || progress === null) {
      counts.ignored += 1;
      continue;
    }
    const threads = arr(item.threads);
    let messages = 0;
    for (const t of threads) if (isObj(t)) messages += arr(t.messages).length;
    const r = await call("whatsapp_coexistence_record", {
      p_phone_number_id: pnid,
      p_kind: "history_chunk",
      p_event_name: "history",
      p_event_key: `hist:${pnid}:${phase}:${chunk}:${progress}`,
      p_detail: { phase, chunk_order: chunk, progress, threads: threads.length, messages },
    });
    if (r === "transient") return "transient";
    tally(counts, r);
  }
  return "ok";
}

export async function handleWhatsappWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  if (req.method === "GET") {
    if (!deps.verifyToken) {
      console.error("whatsapp-webhook: WHATSAPP_VERIFY_TOKEN não configurado");
      return json({ error: "Webhook indisponível." }, 503);
    }
    const q = new URL(req.url).searchParams;
    const mode = q.get("hub.mode");
    const token = q.get("hub.verify_token") ?? "";
    const challenge = q.get("hub.challenge");
    if (mode === "subscribe" && challenge !== null && timingSafeEqual(token, deps.verifyToken)) {
      return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    return json({ error: "Verificação recusada." }, 403);
  }
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  if (!deps.appSecret) {
    console.error("whatsapp-webhook: WHATSAPP_APP_SECRET não configurado");
    return json({ error: "Webhook indisponível." }, 503);
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Corpo grande demais." }, 413);

  const header = req.headers.get("x-hub-signature-256") ?? "";
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(header);
  if (!match) {
    console.warn("whatsapp-webhook: assinatura ausente ou malformada");
    return json({ error: "Não autorizado." }, 401);
  }
  const expected = await hmacSha256Hex(deps.appSecret, raw);
  if (!timingSafeEqual(match[1].toLowerCase(), expected)) {
    console.warn("whatsapp-webhook: assinatura inválida");
    return json({ error: "Não autorizado." }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: "JSON inválido." }, 400);
  }
  if (!isObj(payload) || payload.object !== "whatsapp_business_account") {
    return json({ received: true, processed: 0 });
  }

  const counts = { stored: 0, duplicate: 0, ignored: 0 };
  for (const entry of arr(payload.entry)) {
    if (!isObj(entry)) continue;
    for (const change of arr(entry.changes)) {
      if (!isObj(change) || !isObj(change.value)) continue;
      if (typeof change.field === "string" && COEXISTENCE_FIELDS.has(change.field)) {
        const r = await handleCoexistenceChange(deps, entry, change, change.field, counts);
        if (r === "transient") return json({ error: "Falha ao processar o evento." }, 500);
        continue;
      }
      if (change.field !== "messages") continue;
      const value = change.value;
      const phoneNumberId = isObj(value.metadata) ? str(value.metadata.phone_number_id) : null;
      if (!phoneNumberId) {
        counts.ignored += 1;
        continue;
      }
      const contacts = arr(value.contacts);

      for (const rawMsg of arr(value.messages)) {
        const m = parseMessage(rawMsg, contacts);
        if (!m) {
          counts.ignored += 1;
          continue;
        }
        const res = await deps.db.rpc("whatsapp_ingest_message", {
          p_phone_number_id: phoneNumberId,
          p_provider_message_id: m.id,
          p_from: m.from,
          p_contact_name: m.name,
          p_type: m.type,
          p_body: m.body,
          p_provider_timestamp: m.timestamp,
          p_event_key: `msg:${phoneNumberId}:${m.id}`,
        });
        if (res.error) {
          console.error("whatsapp-webhook: falha transitória ao gravar mensagem", res.error.code ?? "");
          return json({ error: "Falha ao processar o evento." }, 500);
        }
        const result = isObj(res.data) ? str(res.data.result) : null;
        if (result === "stored") counts.stored += 1;
        else if (result === "duplicate") counts.duplicate += 1;
        else counts.ignored += 1;
      }

      for (const rawSt of arr(value.statuses)) {
        if (!isObj(rawSt)) {
          counts.ignored += 1;
          continue;
        }
        const id = str(rawSt.id);
        const status = str(rawSt.status);
        if (!id || !status) {
          counts.ignored += 1;
          continue;
        }
        const ts = isoFromUnix(rawSt.timestamp);
        const err = isObj(arr(rawSt.errors)[0]) ? (arr(rawSt.errors)[0] as Obj) : null;
        const errorCode = err ? (typeof err.code === "number" ? String(err.code) : str(err.code)) : null;
        const res = await deps.db.rpc("whatsapp_ingest_status", {
          p_phone_number_id: phoneNumberId,
          p_provider_message_id: id,
          p_status: status,
          p_provider_timestamp: ts,
          p_error_code: errorCode,
          p_event_key: `st:${phoneNumberId}:${id}:${status}:${str(rawSt.timestamp) ?? ""}`,
        });
        if (res.error) {
          console.error("whatsapp-webhook: falha transitória ao gravar status", res.error.code ?? "");
          return json({ error: "Falha ao processar o evento." }, 500);
        }
        const result = isObj(res.data) ? str(res.data.result) : null;
        if (result === "stored") counts.stored += 1;
        else if (result === "duplicate") counts.duplicate += 1;
        else counts.ignored += 1;
      }
    }
  }

  return json({ received: true, ...counts });
}
