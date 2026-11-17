// Lógica PURA dos contatos MANUAIS do WhatsApp (Etapa 7.10E): sem React, sem Supabase, sem relógio. Consome o formato das RPCs da migration
// 20261128010000 (create/update/get/archive/restore_whatsapp_contact e set_whatsapp_contact_customer).
//
// REGRA DE OURO (igual à das listas): o servidor decide TUDO (sessão, empresa, papel, módulo, somente leitura, duplicidade). O que existe aqui:
//   (1) validação do formulário com as MESMAS regras do banco, para avisar antes de chamar (a paridade com o SQL é testada em PGlite);
//   (2) quais ações cada papel enxerga (o servidor confere de novo: esconder um botão nunca é segurança);
//   (3) tradução dos erros PT400/401/402/403/404/409 em mensagens e tipos que a tela futura só precisa exibir.
// Nada aqui toca em conversas, na caixa de entrada nem na seleção de contatos.

export const MANUAL_NAME_MAX = 80;
export const MANUAL_NOTES_MAX = 1000;

// ---------------------------------------------------------------------------
// 1) Tipos e mapeadores (resposta das RPCs)
// ---------------------------------------------------------------------------
export interface ManualContact {
  id: string;
  name: string;
  /** E.164 só com dígitos (como o servidor guardou). */
  phone: string;
  contactKey: string;
  notes: string | null;
  source: "manual";
  customerId: string | null;
  customerName: string | null;
  /** null = sem cliente vinculado. */
  customerActive: boolean | null;
  archivedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ManualContactPermissionFlags {
  canEdit: boolean;
  canLinkCustomer: boolean;
  canArchive: boolean;
  canRestore: boolean;
}

export interface ManualContactDetail {
  contact: ManualContact;
  permissions: ManualContactPermissionFlags;
}

/** Resultado de uma escrita: changed=false quando nada mudou (operação repetida / sem alteração). */
export interface ManualContactMutation {
  changed: boolean;
  contact: ManualContact;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function toManualContact(raw: unknown): ManualContact | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const name = str(raw.name);
  const phone = str(raw.phone);
  const contactKey = str(raw.contact_key);
  if (!id || !name || !phone || !contactKey) return null;
  const customerId = str(raw.customer_id);
  return {
    id,
    name,
    phone,
    contactKey,
    notes: str(raw.notes),
    source: "manual",
    customerId,
    customerName: customerId ? str(raw.customer_name) : null,
    customerActive: customerId ? raw.customer_active === true : null,
    archivedAt: str(raw.archived_at),
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
  };
}

export function toManualContactMutation(raw: unknown): ManualContactMutation | null {
  if (!isObj(raw) || raw.ok !== true) return null;
  const contact = toManualContact(raw.contact);
  return contact ? { changed: raw.changed === true, contact } : null;
}

/** Resposta de delete_whatsapp_contact: só o id do contato removido (nada de dados pessoais). */
export interface ManualContactDeletion {
  contactId: string;
}

export function toManualContactDeletion(raw: unknown): ManualContactDeletion | null {
  if (!isObj(raw) || raw.ok !== true || raw.deleted !== true) return null;
  const contactId = str(raw.contact_id);
  return contactId ? { contactId } : null;
}

/** Palavra que o usuário precisa digitar para excluir definitivamente (o banco confere de novo, exatamente assim). */
export const DELETE_CONFIRMATION = "EXCLUIR";
export const isDeleteConfirmationValid = (text: string | null | undefined): boolean => text === DELETE_CONFIRMATION;

export function toManualContactDetail(raw: unknown): ManualContactDetail | null {
  if (!isObj(raw)) return null;
  const contact = toManualContact(raw.contact);
  const p = isObj(raw.permissions) ? raw.permissions : null;
  if (!contact || !p) return null;
  return {
    contact,
    permissions: { canEdit: p.can_edit === true, canLinkCustomer: p.can_link_customer === true, canArchive: p.can_archive === true, canRestore: p.can_restore === true },
  };
}

// ---------------------------------------------------------------------------
// 2) Permissões por papel (espelho de whatsapp_contacts_assert_writer; o servidor decide de verdade)
// ---------------------------------------------------------------------------
export interface ManualContactPermissions {
  canView: boolean;
  /** Exclusão definitiva: SOMENTE o dono (o servidor também exige que o contato esteja arquivado). */
  canDelete: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canLinkCustomer: boolean;
  canArchive: boolean;
  canRestore: boolean;
}

/** owner/admin: tudo. attendant: cria, edita e vincula. cashier: só consulta. Qualquer outro papel (ou nenhum): nada. */
export function manualContactPermissions(role: string | null | undefined): ManualContactPermissions {
  const manage = role === "owner" || role === "admin";
  const write = manage || role === "attendant";
  const view = write || role === "cashier";
  return { canView: view, canDelete: role === "owner", canCreate: write, canEdit: write, canLinkCustomer: write, canArchive: manage, canRestore: manage };
}

export type ManualContactOperation = "create" | "update" | "get" | "archive" | "restore" | "link" | "delete";

export function isOperationAllowed(role: string | null | undefined, op: ManualContactOperation): boolean {
  const p = manualContactPermissions(role);
  switch (op) {
    case "get":
      return p.canView;
    case "create":
      return p.canCreate;
    case "update":
      return p.canEdit;
    case "link":
      return p.canLinkCustomer;
    case "archive":
      return p.canArchive;
    case "restore":
      return p.canRestore;
    case "delete":
      return p.canDelete;
  }
}

// ---------------------------------------------------------------------------
// 3) Formulário: normalização do telefone (espelho de whatsapp_contact_normalize_phone) e validação
// ---------------------------------------------------------------------------
/**
 * Telefone digitado → E.164 só com dígitos, ou null quando inválido. Mesmas regras do banco:
 *  '+' no começo ........ internacional, 8 a 15 dígitos, sem zero inicial (se começar com 55, vale a regra do Brasil);
 *  sem '+', 10 ou 11 .... DDD + número do Brasil (ganha 55);
 *  sem '+', 12 ou 13 .... só se já começar com 55;
 *  qualquer outro caso (8/9 dígitos sem DDD, outro país sem '+', 14+ dígitos, sem dígitos) é inválido.
 * Brasil (55): 12 ou 13 dígitos, DDD sem zero, 13 exigem o 9 na 5ª posição, 12 exigem 2..9 na 5ª.
 */
export function normalizeContactPhone(raw: string | null | undefined): string | null {
  const text = raw ?? "";
  const plus = /^\s*\+/.test(text);
  const d = text.replace(/[^0-9]/g, "");
  const l = d.length;
  let e: string | null;
  if (l === 0) e = null;
  else if (plus) e = l >= 8 && l <= 15 && d[0] !== "0" ? d : null;
  else if (l === 10 || l === 11) e = "55" + d;
  else if ((l === 12 || l === 13) && d.startsWith("55")) e = d;
  else e = null;
  if (e === null) return null;
  if (e.startsWith("55")) {
    const n = e.length;
    const ddd = e[2];
    const fifth = e[4];
    const ok = (n === 12 || n === 13) && ddd >= "1" && ddd <= "9" && ((n === 13 && fifth === "9") || (n === 12 && fifth >= "2" && fifth <= "9"));
    return ok ? e : null;
  }
  return e;
}

const codePoints = (s: string): number => Array.from(s).length;

export interface ManualContactFormInput {
  name: string | null | undefined;
  phone: string | null | undefined;
  notes?: string | null | undefined;
}

export type ManualContactFormField = "name" | "phone" | "notes";

export interface ManualContactFormValues {
  /** Nome aparado, com espaços internos únicos. */
  name: string;
  /** E.164 normalizado (só dígitos), para mostrar/comparar. */
  phoneE164: string;
  /** Telefone a ENVIAR: '+' + E.164 (não deixa dúvida ao servidor sobre o país). */
  phoneToSend: string;
  /** Observações aparadas; vazio vira null. */
  notes: string | null;
}

export type ManualContactFormResult =
  | { ok: true; values: ManualContactFormValues; errors: Record<never, never> }
  | { ok: false; values: null; errors: Partial<Record<ManualContactFormField, string>> };

export const FORM_MESSAGES = {
  nameRequired: "Informe o nome do contato.",
  nameTooLong: `O nome pode ter no máximo ${MANUAL_NAME_MAX} caracteres.`,
  phoneRequired: "Informe o telefone do contato.",
  phoneInvalid: "Telefone inválido. Informe o DDD (ex.: (44) 99999-8888) ou, para outro país, comece com + e o código do país.",
  notesTooLong: `As observações podem ter no máximo ${MANUAL_NOTES_MAX} caracteres.`,
} as const;

export function validateManualContactForm(input: ManualContactFormInput): ManualContactFormResult {
  const errors: Partial<Record<ManualContactFormField, string>> = {};
  const name = (input.name ?? "").replace(/\s+/g, " ").trim();
  const notesTrim = (input.notes ?? "").trim();
  const notes = notesTrim === "" ? null : notesTrim;
  if (name === "") errors.name = FORM_MESSAGES.nameRequired;
  else if (codePoints(name) > MANUAL_NAME_MAX) errors.name = FORM_MESSAGES.nameTooLong;
  const phoneRaw = (input.phone ?? "").trim();
  const e164 = normalizeContactPhone(phoneRaw);
  if (phoneRaw === "") errors.phone = FORM_MESSAGES.phoneRequired;
  else if (e164 === null) errors.phone = FORM_MESSAGES.phoneInvalid;
  if (notes !== null && codePoints(notes) > MANUAL_NOTES_MAX) errors.notes = FORM_MESSAGES.notesTooLong;
  if (Object.keys(errors).length > 0 || e164 === null) return { ok: false, values: null, errors };
  return { ok: true, values: { name, phoneE164: e164, phoneToSend: "+" + e164, notes }, errors: {} };
}

/** Campos que realmente mudaram em relação ao contato salvo (para a tela avisar "nada a salvar" sem chamar o servidor). */
export function changedManualContactFields(original: Pick<ManualContact, "name" | "phone" | "notes">, values: ManualContactFormValues): ManualContactFormField[] {
  const out: ManualContactFormField[] = [];
  if (values.name !== original.name) out.push("name");
  if (values.phoneE164 !== original.phone) out.push("phone");
  if (values.notes !== original.notes) out.push("notes");
  return out;
}

/** Valores iniciais de um formulário de edição. */
export function manualContactToForm(c: Pick<ManualContact, "name" | "phone" | "notes">): { name: string; phone: string; notes: string } {
  return { name: c.name, phone: "+" + c.phone, notes: c.notes ?? "" };
}

// ---------------------------------------------------------------------------
// 4) Erros do servidor → tipo + mensagem (nunca telefone, nome nem observações)
// ---------------------------------------------------------------------------
export type ManualContactErrorKind =
  | "auth" // PT401 sessão
  | "readonly" // PT402 empresa em modo somente leitura
  | "forbidden" // PT403 papel/módulo
  | "not_found" // PT404 contato ou cliente inexistente (ou de outra empresa: o servidor responde igual)
  | "conflict" // PT409 (ver reason)
  | "invalid" // PT400 (ou validação local)
  | "busy" // já existe uma operação em andamento para este contato
  | "stale" // a empresa/papel mudou enquanto a operação rodava: resultado descartado
  | "generic";

export type ManualContactConflictReason = "duplicate_phone" | "restore_conflict" | "archived" | "not_archived" | "inactive_customer" | "other";

export interface ManualContactError {
  kind: ManualContactErrorKind;
  message: string;
  /** Só em kind = 'conflict'. */
  reason?: ManualContactConflictReason;
  /** Id do contato ATIVO que já usa o telefone (vem do DETAIL do PT409; sempre da mesma empresa). */
  existingContactId?: string;
  /** Só em kind = 'not_found': o que não foi achado. */
  entity?: "contact" | "customer";
  /** Erros por campo (validação local e PT400). */
  fieldErrors?: Partial<Record<ManualContactFormField, string>>;
}

export interface ManualRpcErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function mapManualContactError(error: ManualRpcErrorLike, op: ManualContactOperation): ManualContactError {
  const code = error.code ?? "";
  const msg = error.message ?? "";
  if (code === "PT401" || code === "401" || /sess[ãa]o inv[aá]lida|jwt|not authenticated/i.test(msg)) {
    return { kind: "auth", message: "Sua sessão expirou. Entre novamente para continuar." };
  }
  if (code === "PT402" || /somente leitura/i.test(msg)) {
    return { kind: "readonly", message: "A empresa está em modo somente leitura. Regularize a contratação/pagamento para voltar a alterar contatos." };
  }
  if (code === "PT403") {
    if (/excluir contatos definitivamente/i.test(msg)) return { kind: "forbidden", message: "Somente o dono da empresa pode excluir contatos definitivamente." };
    return { kind: "forbidden", message: /arquivar ou restaurar/i.test(msg) ? "Somente donos e administradores podem arquivar ou restaurar contatos." : "Você não tem permissão para esta ação com contatos do WhatsApp." };
  }
  if (code === "PT404") {
    const customer = /cliente/i.test(msg);
    return customer
      ? { kind: "not_found", entity: "customer", message: "Cliente não encontrado. Atualize a lista de clientes e tente de novo." }
      : { kind: "not_found", entity: "contact", message: "Contato não encontrado. Ele pode ter sido removido ou você não tem acesso a ele." };
  }
  if (code === "PT409") {
    const detail = (error.details ?? "").trim();
    const existingContactId = UUID.test(detail) ? detail.toLowerCase() : undefined;
    if (/j[áa] existe/i.test(msg)) {
      return op === "restore"
        ? { kind: "conflict", reason: "restore_conflict", existingContactId, message: "Já existe outro contato ativo com este telefone. Não é possível restaurar este." }
        : { kind: "conflict", reason: "duplicate_phone", existingContactId, message: "Já existe um contato ativo com este telefone." };
    }
    if (/arquive o contato antes/i.test(msg)) return { kind: "conflict", reason: "not_archived", message: "Arquive o contato antes de excluí-lo definitivamente." };
    if (/arquivado/i.test(msg)) return { kind: "conflict", reason: "archived", message: "Este contato está arquivado. Restaure-o antes de alterar." };
    if (/inativo/i.test(msg)) return { kind: "conflict", reason: "inactive_customer", message: "Este cliente está inativo e não pode ser vinculado." };
    return { kind: "conflict", reason: "other", message: "Não foi possível concluir: o contato mudou. Atualize e tente de novo." };
  }
  if (code === "PT400") {
    if (/confirma/i.test(msg)) return { kind: "invalid", message: `Confirmação inválida. Digite ${DELETE_CONFIRMATION} para excluir definitivamente.` };
    const fieldErrors: Partial<Record<ManualContactFormField, string>> = {};
    if (/telefone/i.test(msg)) fieldErrors.phone = FORM_MESSAGES.phoneInvalid;
    else if (/observa/i.test(msg)) fieldErrors.notes = FORM_MESSAGES.notesTooLong;
    else if (/nome/i.test(msg)) fieldErrors.name = /80/.test(msg) ? FORM_MESSAGES.nameTooLong : FORM_MESSAGES.nameRequired;
    const first = Object.values(fieldErrors)[0];
    return { kind: "invalid", message: first ?? "Confira os dados informados e tente de novo.", fieldErrors };
  }
  return { kind: "generic", message: "Não foi possível concluir agora. Tente novamente." };
}

/** Mensagem de bloqueio local por permissão (o servidor também recusa). */
export function forbiddenMessage(op: ManualContactOperation): string {
  if (op === "delete") return "Somente o dono da empresa pode excluir contatos definitivamente.";
  return op === "archive" || op === "restore"
    ? "Somente donos e administradores podem arquivar ou restaurar contatos."
    : op === "get"
      ? "Você não tem acesso aos contatos do WhatsApp."
      : "Você não tem permissão para cadastrar, editar ou vincular contatos.";
}

/** Falha que vale repetir (rede/servidor). Validação, permissão, conflito e somente leitura não melhoram sozinhos. */
export function isRetryableManualError(e: ManualContactError): boolean {
  return e.kind === "generic";
}
