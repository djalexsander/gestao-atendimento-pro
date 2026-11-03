import { useCallback, useEffect, useState } from "react";
import { useCommercial } from "../commercial/CommercialProvider";
import { moduleAccess } from "../commercial/commercialLogic";
import { supabaseDeliverySource, type DeliverySource } from "../delivery/deliveryApi";
import {
  ADDRESS_KIND_LABEL,
  ADDRESS_KINDS,
  addressFormProblem,
  addressToForm,
  EMPTY_ADDRESS,
  formatAddressLine,
  formatCep,
  type AddressForm,
  type AddressKind,
  type AddressRow,
} from "../delivery/deliveryLogic";

/** Só o que a seção usa do Delivery: as RPCs de endereço (a empresa vem do cliente/endereço no servidor, nunca daqui). */
export type AddressesSource = Pick<DeliverySource, "addresses" | "createAddress" | "updateAddress" | "setAddressActive" | "setAddressPrimary">;

const FIELDS: Array<[keyof Omit<AddressForm, "kind">, string, number]> = [
  ["cep", "CEP", 9],
  ["street", "Rua", 120],
  ["number", "Número", 20],
  ["complement", "Complemento", 60],
  ["neighborhood", "Bairro", 80],
  ["city", "Cidade", 80],
  ["state", "UF", 2],
  ["reference", "Ponto de referência", 120],
  ["label", "Apelido (opcional)", 30],
];

// "Endereços de entrega" do cliente (Cadastros → Clientes). Várias moradas, uma principal, tipo Casa/Trabalho/Outro.
// Nada é apagado: "Desativar" preserva o histórico dos pedidos. A IA do WhatsApp sugere o principal primeiro (sempre com confirmação).
// Regras (duplicidade, limite, principal único, permissões, módulo) são do servidor; aqui só a validação básica do formulário.
export function CustomerAddressesSection({
  customerId,
  customerActive,
  readOnly = false,
  source = supabaseDeliverySource,
}: {
  customerId: string | null; // null = cliente ainda não salvo
  customerActive: boolean;
  readOnly?: boolean;
  source?: AddressesSource;
}) {
  const { entitlements } = useCommercial();
  const access = moduleAccess(entitlements, "delivery");
  const [rows, setRows] = useState<AddressRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<{ id: string | null; form: AddressForm } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!customerId) return;
    const r = await source.addresses(customerId, true);
    if (r.error) setError(r.error);
    else {
      setError(null);
      setRows(r.data);
    }
  }, [customerId, source]);

  useEffect(() => {
    setRows(null);
    setForm(null);
    setNotice(null);
    if (customerId && access === "allowed") void reload();
  }, [customerId, access, reload]);

  async function run(action: () => Promise<{ error: string | null }>, done: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await action();
    setBusy(false);
    if (r.error) {
      setError(r.error);
      return;
    }
    setNotice(done);
    await reload();
  }

  async function save() {
    if (!form || !customerId) return;
    const problem = addressFormProblem(form.form);
    if (problem) {
      setError(problem);
      return;
    }
    const f = form.form;
    await run(async () => {
      const r = form.id ? await source.updateAddress(form.id, f) : await source.createAddress(customerId, f);
      if (!r.error) setForm(null);
      return r;
    }, form.id ? "Endereço atualizado." : "Endereço cadastrado.");
  }

  const active = (rows ?? []).filter((a) => a.isActive);
  const inactive = (rows ?? []).filter((a) => !a.isActive);

  return (
    <section className="cus-addr" aria-label="Endereços de entrega">
      <h4>Endereços de entrega</h4>
      {access === "loading" && <p className="muted">Carregando…</p>}
      {access === "locked" && <p className="field-hint">O módulo Delivery não está contratado para esta empresa. Os endereços de entrega ficam disponíveis com o módulo.</p>}
      {access === "allowed" && !customerId && <p className="field-hint">Salve o cliente para cadastrar endereços de entrega. O endereço é opcional.</p>}
      {access === "allowed" && customerId && (
        <>
          {rows === null && !error && <p className="muted">Carregando endereços…</p>}
          {rows !== null && active.length === 0 && !form && <p className="muted">Nenhum endereço de entrega cadastrado. O endereço é opcional.</p>}
          {error && <div className="form-error" role="alert">{error}</div>}
          {notice && <div className="rec-notice" role="status">{notice}</div>}
          {active.map((a) => (
            <AddressCard key={a.id} a={a} readOnly={readOnly || busy} onEdit={() => { setError(null); setForm({ id: a.id, form: addressToForm(a) }); }}
              onPrimary={() => void run(() => source.setAddressPrimary(a.id), "Endereço principal atualizado.")}
              onActive={() => void run(() => source.setAddressActive(a.id, false), "Endereço desativado. O histórico de pedidos foi preservado.")} />
          ))}
          {inactive.length > 0 && (
            <details className="cus-addr-inactive">
              <summary>Endereços desativados ({inactive.length})</summary>
              {inactive.map((a) => (
                <AddressCard key={a.id} a={a} readOnly={readOnly || busy} onEdit={() => { setError(null); setForm({ id: a.id, form: addressToForm(a) }); }}
                  onPrimary={() => undefined} onActive={() => void run(() => source.setAddressActive(a.id, true), "Endereço reativado.")} />
              ))}
            </details>
          )}
          {!readOnly && form && (
            <form className="dl-addr-form cus-addr-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
              <div className="dl-field dl-field-wide">
                <span>Tipo</span>
                <div className="cus-addr-kinds" role="radiogroup" aria-label="Tipo de endereço">
                  {ADDRESS_KINDS.map((k) => (
                    <label key={k} className={`cus-addr-kind${form.form.kind === k ? " cus-addr-kind-on" : ""}`}>
                      <input type="radio" name="cus-addr-kind" checked={form.form.kind === k} onChange={() => setForm({ ...form, form: { ...form.form, kind: k } })} />
                      {ADDRESS_KIND_LABEL[k]}
                    </label>
                  ))}
                </div>
              </div>
              {FIELDS.map(([k, label, max]) => (
                <label key={k} className={`dl-field${k === "street" || k === "reference" ? " dl-field-wide" : ""}`}>
                  <span>{label}</span>
                  <input
                    value={form.form[k]}
                    maxLength={max}
                    inputMode={k === "cep" ? "numeric" : undefined}
                    autoComplete="off"
                    onChange={(e) => setForm({ ...form, form: { ...form.form, [k]: k === "state" ? e.target.value.toUpperCase() : e.target.value } })}
                  />
                </label>
              ))}
              <div className="modal-actions dl-field-wide">
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => { setForm(null); setError(null); }}>Cancelar</button>
                <button type="submit" className="btn-primary btn-auto" disabled={busy}>{busy ? "Salvando…" : "Salvar endereço"}</button>
              </div>
            </form>
          )}
          {!readOnly && !form && (
            <button type="button" className="btn-secondary btn-auto" disabled={busy || !customerActive} onClick={() => { setError(null); setNotice(null); setForm({ id: null, form: { ...EMPTY_ADDRESS } }); }}>
              Novo endereço
            </button>
          )}
          {!readOnly && !customerActive && <p className="field-hint">Cliente inativo: ative-o para cadastrar novos endereços.</p>}
          <p className="field-hint">Endereços não são excluídos: ao desativar, o histórico de pedidos é preservado. O principal é sugerido primeiro no pedido e no WhatsApp, sempre com a confirmação do cliente.</p>
        </>
      )}
    </section>
  );
}

function AddressCard({ a, readOnly, onEdit, onPrimary, onActive }: { a: AddressRow; readOnly: boolean; onEdit: () => void; onPrimary: () => void; onActive: () => void }) {
  return (
    <div className={`dl-addr${a.isPrimary ? " dl-addr-on" : ""}${a.isActive ? "" : " cus-addr-off"}`}>
      <div className="dl-addr-main">
        <span>
          <strong>
            {a.label ?? "Endereço"}
            {a.isPrimary && <span className="rec-badge rec-badge-paid cus-addr-badge">Principal</span>}
            <span className="rec-badge cus-addr-badge">{ADDRESS_KIND_LABEL[a.kind as AddressKind]}</span>
            {!a.isActive && <span className="rec-badge cus-addr-badge">Desativado</span>}
          </strong>
          <span className="dl-addr-line">{formatAddressLine({ street: a.street, number: a.number, complement: a.complement, neighborhood: a.neighborhood, city: a.city, state: a.state, cep: a.cep, reference: a.reference })}</span>
          {a.cep && <span className="muted">CEP {formatCep(a.cep)}</span>}
          {a.reference && <span className="muted">Ref.: {a.reference}</span>}
        </span>
      </div>
      {!readOnly && (
        <span className="dl-addr-actions">
          <button type="button" className="btn-secondary btn-small" onClick={onEdit}>Editar</button>
          {a.isActive && !a.isPrimary && <button type="button" className="btn-secondary btn-small" onClick={onPrimary}>Definir principal</button>}
          <button type="button" className="btn-secondary btn-small" onClick={onActive}>{a.isActive ? "Desativar" : "Reativar"}</button>
        </span>
      )}
    </div>
  );
}
