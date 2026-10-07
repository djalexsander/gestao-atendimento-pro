import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Modal } from "../employees/Modal";
import { formatCents } from "../../lib/money";
import { supabaseCommercialSource, type CommercialSource } from "./commercialApi";
import { contractAndCharge } from "./commercialFlow";
import {
  contractDayInSaoPaulo,
  fullBundleCents,
  monthlyTotalCents,
  pickContractPlan,
  selectableModules,
  summaryLines,
  type Catalog,
} from "./commercialLogic";
import { useServerQuote } from "./useServerQuote";

// Contratação inicial (SÓ OWNER; o banco confere de novo em tenant_subscribe). O frontend envia apenas plano + módulos
// escolhidos; preços, total e vencimento são calculados no servidor (cotação em tempo real + valor final do tenant_subscribe).
// "Completo" é só a soma comercial (não existe como plano).
export function SubscribePanel({
  companyId,
  source = supabaseCommercialSource,
  onContracted,
}: {
  companyId: string;
  source?: CommercialSource;
  onContracted: (invoiceId: string) => void;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void source.getCatalog(companyId).then((result) => {
      if (cancelled) return;
      if (result.error !== null) setLoadError(result.error);
      else setCatalog(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [companyId, source]);

  const plan = useMemo(() => (catalog ? pickContractPlan(catalog) : null), [catalog]);
  const modules = useMemo(() => (catalog ? selectableModules(catalog, plan) : []), [catalog, plan]);
  const { quote, pending, error: quoteError } = useServerQuote(source, companyId, plan?.id ?? null, selected);

  if (loadError) return <div className="form-error">{loadError}</div>;
  if (!catalog) return <p className="muted">Carregando planos…</p>;
  if (!plan) return <div className="form-error">Nenhum plano disponível para contratação no momento.</div>;

  const estimate = monthlyTotalCents(plan, modules, selected);
  const total = quote?.monthly_cents ?? estimate;
  const full = fullBundleCents(plan, modules);
  const day = contractDayInSaoPaulo(new Date());
  const allSelected = modules.length > 0 && selected.length === modules.length;
  const chosen = modules.filter((m) => selected.includes(m.id));
  const lines = summaryLines(plan, quote ? quote.modules : chosen);

  function toggle(id: string) {
    setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  }

  async function confirm() {
    if (!catalog) return;
    setSubmitting(true);
    setError(null);
    const outcome = await contractAndCharge(source, companyId, catalog, selected);
    setSubmitting(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setConfirming(false);
    onContracted(outcome.subscribe.invoice_id);
  }

  return (
    <section className="subscribe-panel">
      <h3>Contratar agora</h3>
      <p className="field-hint">Escolha os módulos opcionais. O valor final é calculado pelo sistema.</p>

      {modules.length > 0 && (
        <div className="module-grid">
          {modules.map((m) => {
            const on = selected.includes(m.id);
            return (
              <label key={m.id} className={`module-card${on ? " module-card-on" : ""}`}>
                <input type="checkbox" checked={on} onChange={() => toggle(m.id)} />
                <span className="module-card-body">
                  <strong>{m.name}</strong>
                  {m.description && <small className="field-hint">{m.description}</small>}
                </span>
                <span className="module-price">{formatCents(m.monthly_price_cents)}/mês</span>
              </label>
            );
          })}
        </div>
      )}
      {modules.length > 0 && (
        <button type="button" className="btn-secondary btn-small btn-auto" onClick={() => setSelected(allSelected ? [] : modules.map((m) => m.id))}>
          {allSelected ? "Limpar seleção" : `Completo — todos os módulos (${formatCents(full)}/mês)`}
        </button>
      )}

      <ul className="plan-summary" aria-live="polite">
        {lines.map((l) => (
          <li key={l.label}>
            <span>{l.label}</span>
            <span>{formatCents(l.cents)}</span>
          </li>
        ))}
        <li className="plan-summary-total">
          <span>Novo total{pending ? " (calculando…)" : ""}</span>
          <span>{formatCents(total)}/mês</span>
        </li>
      </ul>
      {quoteError && <div className="form-error">{quoteError}</div>}

      <button type="button" className="btn-primary btn-auto" onClick={() => setConfirming(true)}>
        Contratar agora
      </button>

      {confirming && (
        <Modal title="Confirmar contratação" onClose={() => (submitting ? undefined : setConfirming(false))}>
          <ul className="plan-summary">
            {lines.map((l) => (
              <li key={l.label}>
                <span>{l.label}</span>
                <span>{formatCents(l.cents)}</span>
              </li>
            ))}
            <li className="plan-summary-total">
              <span>Total mensal</span>
              <span>{formatCents(total)}</span>
            </li>
          </ul>
          <p className="modal-text">
            <strong>Valor de hoje: {formatCents(total)}</strong> (cobrança integral, sem proporcional). Os próximos vencimentos
            mensais caem sempre no <strong>mesmo dia da contratação (dia {day})</strong>; nos meses sem esse dia, no último dia do mês.
          </p>
          <p className="field-hint">Enquanto o pagamento não for confirmado, a empresa fica em modo somente leitura.</p>
          {error && (
            <div className="form-error">
              {error} {/CNPJ|CPF/.test(error) && <Link to="/app/configuracoes/empresa">Abrir dados da empresa</Link>}
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={() => setConfirming(false)} disabled={submitting}>
              Voltar
            </button>
            <button type="button" className="btn-primary btn-auto" onClick={() => void confirm()} disabled={submitting}>
              {submitting ? "Contratando…" : "Confirmar e gerar Pix"}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
