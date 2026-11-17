import { useState, type FormEvent } from "react";
import { CustomerPicker } from "../customers/CustomerPicker";
import type { CustomersSource } from "../customers/customersApi";
import type { CustomerOption } from "../customers/customersLogic";
import { Modal } from "../employees/Modal";
import { formatWaPhone } from "./whatsappLogic";
import {
  DELETE_CONFIRMATION,
  MANUAL_NAME_MAX,
  MANUAL_NOTES_MAX,
  manualContactToForm,
  validateManualContactForm,
  type ManualContact,
  type ManualContactDetail,
  type ManualContactError,
  type ManualContactFormField,
} from "./whatsappManualContactsLogic";
import { MANUAL_TEXT, type DetailState } from "./whatsappManualContactsUiLogic";

// Interface dos contatos MANUAIS (Etapa 7.10F). Só apresentação: quem chama o servidor é o contêiner (WhatsappContacts.tsx), por meio do
// controlador da 7.10E. Nenhum componente aqui cria cliente, cria conversa ou envia mensagem.

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
const fmtDate = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : dateTime.format(d);
};

/** Mensagem do erro da operação, com o atalho "Ver contato existente" quando o servidor informou o contato que já usa o telefone. */
function OperationError({ error, onOpenExisting }: { error: ManualContactError; onOpenExisting?: (contactId: string) => void }) {
  return (
    <div className="form-error mc-error" role="alert">
      <span>{error.message}</span>
      {error.existingContactId && onOpenExisting && (
        <button type="button" className="btn-secondary btn-small" onClick={() => onOpenExisting(error.existingContactId as string)}>
          {MANUAL_TEXT.openExisting}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formulário (novo / editar)
// ---------------------------------------------------------------------------
export function ManualContactForm({
  mode,
  initial,
  busy,
  error,
  onSubmit,
  onCancel,
  onOpenExisting,
}: {
  mode: "create" | "edit";
  initial?: Pick<ManualContact, "name" | "phone" | "notes">;
  busy: boolean;
  /** Erro devolvido pelo servidor na última tentativa (duplicidade, permissão, somente leitura…). */
  error: ManualContactError | null;
  onSubmit: (input: { name: string; phone: string; notes: string }) => void;
  onCancel: () => void;
  onOpenExisting: (contactId: string) => void;
}) {
  const start = initial ? manualContactToForm(initial) : { name: "", phone: "", notes: "" };
  const [name, setName] = useState(start.name);
  const [phone, setPhone] = useState(start.phone);
  const [notes, setNotes] = useState(start.notes);
  const [touched, setTouched] = useState(false);
  const check = validateManualContactForm({ name, phone, notes });
  // erros de campo: os locais (depois da primeira tentativa) e os do servidor (PT400)
  const fieldErrors: Partial<Record<ManualContactFormField, string>> = { ...(touched && !check.ok ? check.errors : {}), ...(error?.fieldErrors ?? {}) };
  const title = mode === "create" ? MANUAL_TEXT.createTitle : MANUAL_TEXT.editTitle;

  function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (busy || !check.ok) return;
    onSubmit({ name, phone, notes });
  }

  return (
    <Modal title={title} onClose={() => !busy && onCancel()}>
      <form className="mc-form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="mc-name">{MANUAL_TEXT.nameLabel}</label>
          <input id="mc-name" type="text" autoComplete="off" autoFocus maxLength={MANUAL_NAME_MAX + 20} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!fieldErrors.name} aria-describedby={fieldErrors.name ? "mc-name-err" : undefined} />
          {fieldErrors.name && (
            <p id="mc-name-err" className="mc-field-error" role="alert">
              {fieldErrors.name}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="mc-phone">{MANUAL_TEXT.phoneLabel}</label>
          <input id="mc-phone" type="tel" inputMode="tel" autoComplete="off" maxLength={24} value={phone} onChange={(e) => setPhone(e.target.value)} aria-invalid={!!fieldErrors.phone} aria-describedby="mc-phone-hint" />
          <p id="mc-phone-hint" className={fieldErrors.phone ? "mc-field-error" : "field-hint"} role={fieldErrors.phone ? "alert" : undefined}>
            {fieldErrors.phone ?? MANUAL_TEXT.phoneHint}
          </p>
        </div>
        <div className="field">
          <label htmlFor="mc-notes">{MANUAL_TEXT.notesLabel}</label>
          <textarea id="mc-notes" rows={4} maxLength={MANUAL_NOTES_MAX + 100} value={notes} onChange={(e) => setNotes(e.target.value)} aria-invalid={!!fieldErrors.notes} aria-describedby="mc-notes-hint" />
          <p id="mc-notes-hint" className={fieldErrors.notes ? "mc-field-error" : "field-hint"} role={fieldErrors.notes ? "alert" : undefined}>
            {fieldErrors.notes ?? `${MANUAL_TEXT.notesHint} (${Array.from(notes).length}/${MANUAL_NOTES_MAX})`}
          </p>
        </div>
        {mode === "create" && <p className="field-hint">{MANUAL_TEXT.noteNoConversation}</p>}
        {error && Object.keys(error.fieldErrors ?? {}).length === 0 && <OperationError error={error} onOpenExisting={onOpenExisting} />}
        <div className="modal-actions mc-actions">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>
            {MANUAL_TEXT.cancel}
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? MANUAL_TEXT.saving : MANUAL_TEXT.save}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Detalhe (+ confirmação de arquivar/restaurar)
// ---------------------------------------------------------------------------
export function ManualContactDetailView({
  detail,
  busy,
  error,
  confirm,
  onClose,
  onEdit,
  onLink,
  onUnlink,
  onAskConfirm,
  onConfirm,
  onRetry,
  onOpenExisting,
  canDelete = false,
  onDelete,
}: {
  detail: DetailState;
  busy: boolean;
  error: ManualContactError | null;
  confirm: "archive" | "restore" | "delete" | null;
  onClose: () => void;
  onEdit: () => void;
  onLink: () => void;
  onUnlink: () => void;
  onAskConfirm: (what: "archive" | "restore" | "delete" | null) => void;
  onConfirm: () => void;
  onRetry: () => void;
  onOpenExisting: (contactId: string) => void;
  /** Mostra "Excluir definitivamente" (somente o dono; só aparece em contato arquivado). */
  canDelete?: boolean;
  onDelete?: (confirmation: string) => void;
}) {
  return (
    <Modal title={MANUAL_TEXT.detailTitle} onClose={onClose}>
      <div className="mc-detail">
        {detail.status === "loading" && (
          <p className="op-state" role="status">
            {MANUAL_TEXT.loadingDetail}
          </p>
        )}
        {detail.status === "error" && (
          <div className="form-error mc-error" role="alert">
            <span>{detail.error.message}</span>
            {detail.error.kind === "generic" && (
              <button type="button" className="btn-secondary btn-small" onClick={onRetry}>
                Tentar de novo
              </button>
            )}
          </div>
        )}
        {detail.status === "ready" && <DetailBody data={detail.data} busy={busy} error={error} confirm={confirm} onEdit={onEdit} onLink={onLink} onUnlink={onUnlink} onAskConfirm={onAskConfirm} onConfirm={onConfirm} onOpenExisting={onOpenExisting} canDelete={canDelete} onDelete={onDelete} />}
        <div className="modal-actions mc-actions">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>
            {MANUAL_TEXT.close}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function DetailBody({
  data,
  busy,
  error,
  confirm,
  onEdit,
  onLink,
  onUnlink,
  onAskConfirm,
  onConfirm,
  onOpenExisting,
  canDelete,
  onDelete,
}: {
  data: ManualContactDetail;
  busy: boolean;
  error: ManualContactError | null;
  confirm: "archive" | "restore" | "delete" | null;
  onEdit: () => void;
  onLink: () => void;
  onUnlink: () => void;
  onAskConfirm: (what: "archive" | "restore" | "delete" | null) => void;
  onConfirm: () => void;
  onOpenExisting: (contactId: string) => void;
  canDelete: boolean;
  onDelete?: (confirmation: string) => void;
}) {
  const c = data.contact;
  const p = data.permissions; // permissões DO SERVIDOR (já consideram contato arquivado e papel)
  const archived = c.archivedAt !== null;
  const updated = fmtDate(c.updatedAt);
  return (
    <>
      <div className="mc-head">
        <strong className="mc-name">{c.name}</strong>
        <span className="wc-badge">Contato manual</span>
        {archived && <span className="wc-badge mc-badge-archived">{MANUAL_TEXT.archivedBadge}</span>}
      </div>
      <dl className="mc-fields">
        <div>
          <dt>{MANUAL_TEXT.phoneLabel}</dt>
          <dd>{formatWaPhone(c.phone)}</dd>
        </div>
        <div>
          <dt>{MANUAL_TEXT.notesLabel}</dt>
          <dd className="mc-notes">{c.notes ?? <span className="muted">{MANUAL_TEXT.noNotes}</span>}</dd>
        </div>
        <div>
          <dt>Cliente vinculado</dt>
          <dd>
            {c.customerId ? (
              <>
                {c.customerName ?? "Cliente"}
                {c.customerActive === false && <span className="wc-chip"> inativo</span>}
              </>
            ) : (
              <span className="muted">{MANUAL_TEXT.noCustomer}</span>
            )}
          </dd>
        </div>
        {archived && (
          <div>
            <dt>Arquivado em</dt>
            <dd>{fmtDate(c.archivedAt)}</dd>
          </div>
        )}
        {updated && (
          <div>
            <dt>Atualizado em</dt>
            <dd>{updated}</dd>
          </div>
        )}
      </dl>

      {error && <OperationError error={error} onOpenExisting={onOpenExisting} />}

      {confirm === "delete" && onDelete ? (
        <DeleteConfirm busy={busy} onCancel={() => onAskConfirm(null)} onDelete={onDelete} />
      ) : confirm !== null && confirm !== "delete" ? (
        <div className="mc-confirm" role="group" aria-label="Confirmação">
          <p className="modal-text">{confirm === "archive" ? MANUAL_TEXT.confirmArchive : MANUAL_TEXT.confirmRestore}</p>
          <div className="mc-actions-row">
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => onAskConfirm(null)}>
              {MANUAL_TEXT.cancel}
            </button>
            <button type="button" className="btn-primary" disabled={busy} onClick={onConfirm}>
              {busy ? MANUAL_TEXT.saving : confirm === "archive" ? MANUAL_TEXT.archive : MANUAL_TEXT.restore}
            </button>
          </div>
        </div>
      ) : (
        <div className="mc-actions-row">
          {p.canEdit && (
            <button type="button" className="btn-secondary" disabled={busy} onClick={onEdit}>
              {MANUAL_TEXT.edit}
            </button>
          )}
          {p.canLinkCustomer && (
            <button type="button" className="btn-secondary" disabled={busy} onClick={onLink}>
              {c.customerId ? MANUAL_TEXT.changeCustomer : MANUAL_TEXT.linkCustomer}
            </button>
          )}
          {p.canLinkCustomer && c.customerId && (
            <button type="button" className="btn-secondary" disabled={busy} onClick={onUnlink}>
              {MANUAL_TEXT.unlinkCustomer}
            </button>
          )}
          {p.canArchive && (
            <button type="button" className="btn-secondary mc-danger" disabled={busy} onClick={() => onAskConfirm("archive")}>
              {MANUAL_TEXT.archive}
            </button>
          )}
          {p.canRestore && (
            <button type="button" className="btn-primary" disabled={busy} onClick={() => onAskConfirm("restore")}>
              {MANUAL_TEXT.restore}
            </button>
          )}
          {canDelete && archived && onDelete && (
            <button type="button" className="btn-danger mc-delete" disabled={busy} onClick={() => onAskConfirm("delete")}>
              {MANUAL_TEXT.deleteForever}
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** Confirmação da exclusão definitiva: o botão só habilita com a palavra EXCLUIR digitada (o banco confere de novo). */
function DeleteConfirm({ busy, onCancel, onDelete }: { busy: boolean; onCancel: () => void; onDelete: (confirmation: string) => void }) {
  const [typed, setTyped] = useState("");
  const ok = typed === DELETE_CONFIRMATION;
  return (
    <form
      className="mc-confirm mc-delete-confirm"
      role="group"
      aria-label="Confirmar exclusão definitiva"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok && !busy) onDelete(typed);
      }}
    >
      <p className="modal-text mc-delete-warning">{MANUAL_TEXT.confirmDelete}</p>
      <div className="field">
        <label htmlFor="mc-delete-confirm">{MANUAL_TEXT.deleteTypeLabel}</label>
        <input id="mc-delete-confirm" type="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy} />
      </div>
      <div className="mc-actions-row">
        <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>
          {MANUAL_TEXT.cancel}
        </button>
        <button type="submit" className="btn-danger" disabled={busy || !ok}>
          {busy ? MANUAL_TEXT.saving : MANUAL_TEXT.deleteForever}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Vincular cliente (só clientes existentes e ativos; nada de cadastro rápido)
// ---------------------------------------------------------------------------
export function ManualContactLinkView({
  companyId,
  currentName,
  busy,
  error,
  customerSource,
  onSubmit,
  onCancel,
  onOpenExisting,
}: {
  companyId: string;
  currentName: string | null;
  busy: boolean;
  error: ManualContactError | null;
  customerSource?: CustomersSource;
  onSubmit: (customerId: string) => void;
  onCancel: () => void;
  onOpenExisting: (contactId: string) => void;
}) {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<CustomerOption | null>(null);
  return (
    <Modal title={MANUAL_TEXT.linkTitle} onClose={() => !busy && onCancel()}>
      <div className="mc-link">
        <p className="modal-text">{MANUAL_TEXT.linkHelp}</p>
        {currentName && <p className="field-hint">Cliente atual: {currentName}</p>}
        <CustomerPicker companyId={companyId} inputId="mc-customer" label="Cliente" maxLength={80} text={text} onTextChange={setText} selected={selected} onSelect={setSelected} allowQuickCreate={false} source={customerSource} />
        {error && <OperationError error={error} onOpenExisting={onOpenExisting} />}
        <div className="modal-actions mc-actions">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>
            {MANUAL_TEXT.cancel}
          </button>
          <button type="button" className="btn-primary" disabled={busy || !selected} onClick={() => selected && onSubmit(selected.id)}>
            {busy ? MANUAL_TEXT.saving : MANUAL_TEXT.linkCustomer}
          </button>
        </div>
      </div>
    </Modal>
  );
}
