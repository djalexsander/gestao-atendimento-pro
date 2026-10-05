import { useEffect, useState, type FormEvent } from "react";
import { formatCents } from "../../lib/money";
import { Modal } from "../employees/Modal";
import { formatDateBR, todayInSaoPaulo } from "../reports/reportsLogic";
import type { CustomersSource } from "./customersApi";
import {
  CUSTOMER_TYPE_LABEL,
  draftFromDetail,
  EMPTY_DRAFT,
  formatDocument,
  formatPhone,
  maskDocumentInput,
  when,
  maskPhoneInput,
  validateDraft,
  type CustomerDetail,
  type CustomerDraft,
  type CustomerType,
} from "./customersLogic";


export function ActiveBadge({ active }: { active: boolean }) {
  return <span className={active ? "rec-badge rec-badge-paid" : "rec-badge"}>{active ? "Ativo" : "Inativo"}</span>;
}

// Novo cliente / editar cadastro. Na edição busca o detalhe completo (a lista não traz observações nem
// nascimento). O servidor valida de novo e recusa documento duplicado com mensagem amigável.
export function CustomerFormDialog({
  source,
  companyId,
  customerId,
  onDone,
  onClose,
}: {
  source: CustomersSource;
  companyId: string;
  customerId: string | null; // null = novo
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<CustomerDraft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(customerId !== null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!customerId) return;
    let live = true;
    void source.get(customerId).then((result) => {
      if (!live) return;
      setLoading(false);
      if (result.error || !result.data) setError(result.error);
      else setDraft(draftFromDetail(result.data));
    });
    return () => {
      live = false;
    };
  }, [customerId, source]);

  const patch = (p: Partial<CustomerDraft>) => setDraft((d) => ({ ...d, ...p }));

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting || loading) return;
    const checked = validateDraft(draft, todayInSaoPaulo());
    if ("error" in checked) {
      setError(checked.error);
      return;
    }
    setError(null);
    setSubmitting(true);
    const result = customerId ? await source.update(customerId, checked.payload) : await source.create(companyId, checked.payload);
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onDone(customerId ? "Cliente atualizado." : "Cliente cadastrado.");
  }

  const canSave = !loading && !(customerId && error && draft.name === "");

  return (
    <Modal title={customerId ? "Editar cliente" : "Novo cliente"} onClose={onClose}>
      <form className="rec-form cus-form" onSubmit={handleSubmit}>
        {error && <div className="form-error">{error}</div>}
        {loading && <p className="op-state">Carregando…</p>}
        <div className="field">
          <label htmlFor="cus-name">Nome*</label>
          <input id="cus-name" autoFocus maxLength={80} autoComplete="off" value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
        </div>
        <div className="rec-form-row">
          <div className="field">
            <label htmlFor="cus-type">Tipo</label>
            <select id="cus-type" value={draft.type} onChange={(e) => patch({ type: e.target.value as CustomerType })}>
              {(Object.keys(CUSTOMER_TYPE_LABEL) as CustomerType[]).map((t) => (
                <option key={t} value={t}>
                  {CUSTOMER_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="cus-document">CPF/CNPJ</label>
            <input
              id="cus-document"
              inputMode="numeric"
              autoComplete="off"
              placeholder="Opcional"
              value={draft.document}
              onChange={(e) => patch({ document: maskDocumentInput(e.target.value) })}
            />
          </div>
        </div>
        <div className="rec-form-row">
          <div className="field">
            <label htmlFor="cus-phone">Telefone</label>
            <input
              id="cus-phone"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              placeholder="(00) 00000-0000"
              value={draft.phone}
              onChange={(e) => patch({ phone: maskPhoneInput(e.target.value) })}
            />
          </div>
          <div className="field">
            <label htmlFor="cus-whatsapp">WhatsApp</label>
            <input
              id="cus-whatsapp"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              placeholder="(00) 00000-0000"
              disabled={draft.sameWhatsapp}
              value={draft.sameWhatsapp ? draft.phone : draft.whatsapp}
              onChange={(e) => patch({ whatsapp: maskPhoneInput(e.target.value) })}
            />
          </div>
        </div>
        <label className="checkbox-row">
          <input type="checkbox" checked={draft.sameWhatsapp} onChange={(e) => patch({ sameWhatsapp: e.target.checked })} />
          Usar o mesmo número no WhatsApp
        </label>
        <div className="rec-form-row">
          <div className="field">
            <label htmlFor="cus-email">E-mail</label>
            <input id="cus-email" type="email" autoComplete="off" maxLength={254} value={draft.email} onChange={(e) => patch({ email: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="cus-birth">Data de nascimento</label>
            <input id="cus-birth" type="date" max={todayInSaoPaulo()} value={draft.birthDate} onChange={(e) => patch({ birthDate: e.target.value })} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="cus-notes">Observações</label>
          <textarea id="cus-notes" rows={3} maxLength={1000} value={draft.notes} onChange={(e) => patch({ notes: e.target.value })} />
        </div>
        <div className="modal-actions">
          <button className="btn-secondary" type="button" disabled={submitting} onClick={onClose}>
            Cancelar
          </button>
          <button className="btn-primary btn-auto" type="submit" disabled={submitting || !canSave}>
            {submitting ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Detalhe: dados cadastrais + resumo de atendimentos (calculado no servidor, sem carregar o histórico inteiro).
export function CustomerDetailDialog({
  source,
  customerId,
  onEdit,
  onToggleActive,
  onClose,
}: {
  source: CustomersSource;
  customerId: string;
  onEdit: () => void;
  onToggleActive: (customer: CustomerDetail) => void;
  onClose: () => void;
}) {
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void source.get(customerId).then((result) => {
      if (!live) return;
      if (result.error || !result.data) setError(result.error);
      else setCustomer(result.data);
    });
    return () => {
      live = false;
    };
  }, [customerId, source]);

  return (
    <Modal title={customer?.name ?? "Cliente"} onClose={onClose}>
      <div className="rec-detail cus-detail">
        {error && <div className="form-error">{error}</div>}
        {!customer && !error && <p className="op-state">Carregando…</p>}
        {customer && (
          <>
            <div className="rec-detail-head">
              <span className="rec-badges">
                <ActiveBadge active={customer.isActive} />
                <span className="rec-badge">{CUSTOMER_TYPE_LABEL[customer.type]}</span>
              </span>
            </div>
            <h4>Dados cadastrais</h4>
            <dl className="rec-detail-grid">
              <div>
                <dt>CPF/CNPJ</dt>
                <dd>{customer.document ? formatDocument(customer.document) : "—"}</dd>
              </div>
              <div>
                <dt>Nascimento</dt>
                <dd>{customer.birthDate ? formatDateBR(customer.birthDate) : "—"}</dd>
              </div>
              <div>
                <dt>Telefone</dt>
                <dd>{customer.phone ? formatPhone(customer.phone) : "—"}</dd>
              </div>
              <div>
                <dt>WhatsApp</dt>
                <dd>{customer.whatsapp ? formatPhone(customer.whatsapp) : "—"}</dd>
              </div>
              <div>
                <dt>E-mail</dt>
                <dd>{customer.email ?? "—"}</dd>
              </div>
              <div>
                <dt>Cadastrado em</dt>
                <dd>
                  {when(customer.createdAt)}
                  {customer.createdByName && <small className="muted"> · {customer.createdByName}</small>}
                </dd>
              </div>
              <div>
                <dt>Última atualização</dt>
                <dd>{when(customer.updatedAt)}</dd>
              </div>
            </dl>
            {customer.notes && (
              <>
                <h4>Observações</h4>
                <p className="rec-detail-notes">{customer.notes}</p>
              </>
            )}
            <h4>Histórico resumido</h4>
            <dl className="rec-detail-grid">
              <div>
                <dt>Atendimentos</dt>
                <dd>{customer.visits}</dd>
              </div>
              <div>
                <dt>Última visita</dt>
                <dd>{customer.lastVisitAt ? when(customer.lastVisitAt) : "Nenhuma ainda"}</dd>
              </div>
              <div>
                <dt>Total gasto</dt>
                <dd>{formatCents(customer.totalSpentCents)}</dd>
              </div>
              <div>
                <dt>Ticket médio</dt>
                <dd>{customer.closedVisits > 0 ? formatCents(customer.averageTicketCents) : "—"}</dd>
              </div>
              {customer.openReceivableCount > 0 && (
                <div>
                  <dt>A receber (em aberto)</dt>
                  <dd>
                    {formatCents(customer.openReceivableCents)}
                    <small className="muted"> · {customer.openReceivableCount} {customer.openReceivableCount === 1 ? "conta" : "contas"}</small>
                  </dd>
                </div>
              )}
            </dl>
            <p className="field-hint">Total e ticket consideram as contas já fechadas e vinculadas a este cliente.</p>
          </>
        )}
        <div className="modal-actions rec-detail-actions">
          <button className="btn-secondary" type="button" onClick={onClose}>
            Fechar
          </button>
          {customer && (
            <>
              <button className="btn-secondary btn-auto" type="button" onClick={() => onToggleActive(customer)}>
                {customer.isActive ? "Inativar" : "Ativar"}
              </button>
              <button className="btn-primary btn-auto" type="button" onClick={onEdit}>
                Editar
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
