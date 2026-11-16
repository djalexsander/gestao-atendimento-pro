import { supabase } from "../../lib/supabaseClient";
import {
  FORM_MESSAGES,
  forbiddenMessage,
  isOperationAllowed,
  mapManualContactError,
  toManualContactDetail,
  toManualContactMutation,
  validateManualContactForm,
  type ManualContactDetail,
  type ManualContactError,
  type ManualContactFormInput,
  type ManualContactMutation,
  type ManualContactOperation,
  type ManualRpcErrorLike,
} from "./whatsappManualContactsLogic";

// Contatos MANUAIS do WhatsApp (Etapa 7.10E): chamadas tipadas às seis RPCs da migration 20261128010000 e um controlador que protege as
// operações (permissão, validação, chamada duplicada, empresa trocada, resposta atrasada). SEM telas, botões nem modais (Etapa 7.10F),
// SEM exclusão definitiva e SEM acesso direto a tabelas: o servidor valida sessão, empresa, módulo, papel e somente leitura. Esta camada
// nunca abre conversa, nunca mexe na seleção da lista e nunca dispara mensagem.

export type ManualResult<T> = { ok: true; data: T } | { ok: false; error: ManualContactError };

/** Dados já validados/normalizados do formulário (telefone com '+', observações aparadas ou null). */
export interface ManualContactInput {
  name: string;
  phone: string;
  notes: string | null;
}

/** Fonte de dados. Recebida por parâmetro para exercitar a lógica com RPCs simuladas ou reais (PGlite). */
export interface ManualContactsSource {
  create(companyId: string, input: ManualContactInput): Promise<ManualResult<ManualContactMutation>>;
  update(contactId: string, input: ManualContactInput): Promise<ManualResult<ManualContactMutation>>;
  get(contactId: string): Promise<ManualResult<ManualContactDetail>>;
  archive(contactId: string): Promise<ManualResult<ManualContactMutation>>;
  restore(contactId: string): Promise<ManualResult<ManualContactMutation>>;
  /** customerId = null desvincula. */
  setCustomer(contactId: string, customerId: string | null): Promise<ManualResult<ManualContactMutation>>;
}

const UNEXPECTED: ManualContactError = { kind: "generic", message: "Resposta inesperada do servidor. Tente novamente." };
const NETWORK: ManualContactError = { kind: "generic", message: "Não foi possível concluir agora. Tente novamente." };

function fail(error: ManualRpcErrorLike, op: ManualContactOperation): ManualResult<never> {
  // nunca registra telefone, nome nem observações
  console.error("Falha nos contatos manuais do WhatsApp:", error.code ?? "sem código");
  return { ok: false, error: mapManualContactError(error, op) };
}

async function call<T>(op: ManualContactOperation, rpc: PromiseLike<{ data: unknown; error: ManualRpcErrorLike | null }>, map: (raw: unknown) => T | null): Promise<ManualResult<T>> {
  const { data, error } = await rpc;
  if (error) return fail(error, op);
  const mapped = map(data);
  return mapped === null ? { ok: false, error: UNEXPECTED } : { ok: true, data: mapped };
}

export const supabaseManualContactsSource: ManualContactsSource = {
  create: (companyId, input) =>
    call("create", supabase.rpc("create_whatsapp_contact", { p_company_id: companyId, p_name: input.name, p_phone: input.phone, p_notes: input.notes }), toManualContactMutation),
  update: (contactId, input) =>
    call("update", supabase.rpc("update_whatsapp_contact", { p_contact_id: contactId, p_name: input.name, p_phone: input.phone, p_notes: input.notes }), toManualContactMutation),
  get: (contactId) => call("get", supabase.rpc("get_whatsapp_contact", { p_contact_id: contactId }), toManualContactDetail),
  archive: (contactId) => call("archive", supabase.rpc("archive_whatsapp_contact", { p_contact_id: contactId }), toManualContactMutation),
  restore: (contactId) => call("restore", supabase.rpc("restore_whatsapp_contact", { p_contact_id: contactId }), toManualContactMutation),
  setCustomer: (contactId, customerId) =>
    call("link", supabase.rpc("set_whatsapp_contact_customer", { p_contact_id: contactId, p_customer_id: customerId }), toManualContactMutation),
};

// ---------------------------------------------------------------------------
// Controlador (sem React): uma tela futura apenas chama estes métodos e mostra o resultado.
// ---------------------------------------------------------------------------
export interface ManualContactChange {
  op: Exclude<ManualContactOperation, "get">;
  /** O contato depois da operação (a chave pode ter mudado se o telefone mudou). */
  contact: ManualContactMutation["contact"];
}

export interface ManualContactsController {
  create(input: ManualContactFormInput): Promise<ManualResult<ManualContactMutation>>;
  update(contactId: string, input: ManualContactFormInput): Promise<ManualResult<ManualContactMutation>>;
  get(contactId: string): Promise<ManualResult<ManualContactDetail>>;
  archive(contactId: string): Promise<ManualResult<ManualContactMutation>>;
  restore(contactId: string): Promise<ManualResult<ManualContactMutation>>;
  /** customerId = null desvincula. */
  setCustomer(contactId: string, customerId: string | null): Promise<ManualResult<ManualContactMutation>>;
  /** Há operação em andamento? (sem argumento: qualquer uma; com id: só para aquele contato). */
  isBusy(contactId?: string): boolean;
  /** Troca a empresa ativa: operações em andamento deixam de valer (resultado descartado, lista não é atualizada). */
  setCompany(companyId: string | null): void;
  /** Descarta o resultado de TODAS as operações em andamento (ex.: a tela foi fechada), sem mudar empresa nem papel. */
  invalidate(): void;
  /** Troca o papel (permissões): operações em andamento deixam de valer. */
  setRole(role: string | null): void;
}

export function createManualContactsController(options: {
  source: ManualContactsSource;
  companyId: string | null;
  role: string | null;
  /** Chamado UMA vez depois de cada escrita bem-sucedida que mudou algo (e só se a empresa/papel não mudou). Falhas aqui são ignoradas. */
  onChanged?: (change: ManualContactChange) => void | Promise<void>;
}): ManualContactsController {
  const { source, onChanged } = options;
  let companyId = options.companyId;
  let role = options.role;
  let epoch = 0;
  const pending = new Map<string, Promise<unknown>>();
  /** contato -> operação em andamento (uma por contato) */
  const busyContacts = new Map<string, string>();
  let busyCreate = 0;

  const deny = (kind: ManualContactError["kind"], message: string): ManualResult<never> => ({ ok: false, error: { kind, message } });

  function guard(op: ManualContactOperation): ManualResult<never> | null {
    if (!companyId) return deny("forbidden", "Selecione uma empresa para ver os contatos.");
    if (!isOperationAllowed(role, op)) return deny("forbidden", forbiddenMessage(op));
    return null;
  }

  /** Executa uma escrita/consulta com: chamada duplicada = mesma promessa; uma operação por contato; descarte se a empresa/papel mudou. */
  function run<T extends ManualContactMutation | ManualContactDetail>(
    op: ManualContactOperation,
    contactId: string | null,
    payloadKey: string,
    exec: () => Promise<ManualResult<T>>,
    notify: (data: T) => ManualContactChange | null,
  ): Promise<ManualResult<T>> {
    const key = `${op}|${contactId ?? "-"}|${payloadKey}`;
    const same = pending.get(key);
    if (same) return same as Promise<ManualResult<T>>; // duplo clique / reenvio: UMA chamada ao servidor
    const exclusive = op !== "get"; // consultar não bloqueia nem é bloqueada por escritas
    if (exclusive && contactId && busyContacts.has(contactId)) {
      return Promise.resolve(deny("busy", "Já existe uma operação em andamento para este contato. Aguarde."));
    }
    const myEpoch = epoch;
    if (!exclusive) {
      /* consulta: sem reserva */
    } else if (contactId) busyContacts.set(contactId, op);
    else busyCreate++;
    const p = (async (): Promise<ManualResult<T>> => {
      let res: ManualResult<T>;
      try {
        res = await exec();
      } catch {
        res = { ok: false, error: NETWORK };
      }
      if (myEpoch !== epoch) {
        return { ok: false, error: { kind: "stale", message: "A empresa ou o acesso mudou durante a operação. Atualize a lista." } };
      }
      if (res.ok && onChanged) {
        const change = notify(res.data);
        if (change) {
          try {
            await onChanged(change);
          } catch {
            /* a atualização da lista não pode transformar uma operação que deu certo em erro */
          }
        }
      }
      return res;
    })().finally(() => {
      pending.delete(key);
      if (!exclusive) return;
      if (contactId) busyContacts.delete(contactId);
      else busyCreate--;
    });
    pending.set(key, p);
    return p;
  }

  const mutationChange = (op: ManualContactChange["op"]) => (m: ManualContactMutation): ManualContactChange | null => (m.changed ? { op, contact: m.contact } : null);

  function invalid(errors: NonNullable<ManualContactError["fieldErrors"]>): ManualResult<never> {
    return { ok: false, error: { kind: "invalid", message: Object.values(errors)[0] ?? FORM_MESSAGES.phoneInvalid, fieldErrors: errors } };
  }

  return {
    create(input) {
      const blocked = guard("create");
      if (blocked) return Promise.resolve(blocked);
      const v = validateManualContactForm(input);
      if (!v.ok) return Promise.resolve(invalid(v.errors));
      const company = companyId as string;
      const { name, phoneToSend, notes } = v.values;
      return run("create", null, JSON.stringify([company, name, phoneToSend, notes]), () => source.create(company, { name, phone: phoneToSend, notes }), mutationChange("create"));
    },
    update(contactId, input) {
      const blocked = guard("update");
      if (blocked) return Promise.resolve(blocked);
      const v = validateManualContactForm(input);
      if (!v.ok) return Promise.resolve(invalid(v.errors));
      const { name, phoneToSend, notes } = v.values;
      return run("update", contactId, JSON.stringify([name, phoneToSend, notes]), () => source.update(contactId, { name, phone: phoneToSend, notes }), mutationChange("update"));
    },
    get(contactId) {
      const blocked = guard("get");
      if (blocked) return Promise.resolve(blocked);
      return run("get", contactId, "", () => source.get(contactId), () => null);
    },
    archive(contactId) {
      const blocked = guard("archive");
      if (blocked) return Promise.resolve(blocked);
      return run("archive", contactId, "", () => source.archive(contactId), mutationChange("archive"));
    },
    restore(contactId) {
      const blocked = guard("restore");
      if (blocked) return Promise.resolve(blocked);
      return run("restore", contactId, "", () => source.restore(contactId), mutationChange("restore"));
    },
    setCustomer(contactId, customerId) {
      const blocked = guard("link");
      if (blocked) return Promise.resolve(blocked);
      return run("link", contactId, String(customerId), () => source.setCustomer(contactId, customerId), mutationChange("link"));
    },
    isBusy: (contactId) => (contactId ? busyContacts.has(contactId) : busyContacts.size > 0 || busyCreate > 0),
    setCompany(next) {
      if (next === companyId) return;
      companyId = next;
      epoch++;
    },
    invalidate() {
      epoch++;
    },
    setRole(next) {
      if (next === role) return;
      role = next;
      epoch++;
    },
  };
}
