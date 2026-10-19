import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabaseKnowledgeSource, type KnowledgeSource } from "./whatsappKnowledgeApi";
import {
  AVAILABILITY_OPTIONS,
  NOTES_MAX,
  PAYMENT_OPTIONS,
  TIMEZONE_OPTIONS,
  WEEK_DAYS,
  deliverySummaryText,
  hoursToDraft,
  profileError,
  togglePayment,
  toProfileInput,
  type AvailabilityMode,
  type BusinessProfile,
  type DayKey,
  type HoursDraft,
  type PaymentCode,
} from "./whatsappKnowledgeLogic";

// IA do WhatsApp → Conhecimento da empresa (owner/admin). Etapa 1: só guarda endereço, horários, pagamentos e observações.
// Produtos, preços, contato e entrega NÃO são editados aqui: aparecem somente leitura, vindos dos módulos de origem.
export function WhatsappKnowledgeSettings({ companyId, source = supabaseKnowledgeSource }: { companyId: string; source?: KnowledgeSource }) {
  const [loaded, setLoaded] = useState<BusinessProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [timezone, setTimezone] = useState("America/Sao_Paulo");
  const [hours, setHours] = useState<HoursDraft>(() => hoursToDraft(null));
  const [closed, setClosed] = useState<{ date: string; label: string }[]>([]);
  const [payments, setPayments] = useState<PaymentCode[]>([]);
  const [pix, setPix] = useState("");
  const [notes, setNotes] = useState("");
  const [availability, setAvailability] = useState<AvailabilityMode>("catalog");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const apply = (p: BusinessProfile) => {
    setLoaded(p);
    setAddress(p.addressText);
    setTimezone(p.timezone);
    setHours(hoursToDraft(p.weeklyHours));
    setClosed(p.closedDates);
    setPayments(p.paymentMethods);
    setPix(p.pixInstructions);
    setNotes(p.publicNotes);
    setAvailability(p.aiAvailabilityMode);
  };

  useEffect(() => {
    let alive = true;
    void source.get(companyId).then((r) => {
      if (!alive) return;
      if (r.data) apply(r.data);
      else setLoadError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [companyId, source]);

  const setDay = (k: DayKey, fn: (d: HoursDraft[DayKey]) => HoursDraft[DayKey]) => setHours((h) => ({ ...h, [k]: fn(h[k]) }));

  async function save() {
    const input = toProfileInput({ addressText: address, timezone, closedDates: closed, paymentMethods: payments, pixInstructions: pix, publicNotes: notes, aiAvailabilityMode: availability }, hours);
    const problem = profileError(input, hours);
    if (problem) return setMessage({ kind: "err", text: problem });
    setSaving(true);
    setMessage(null);
    const r = await source.save(companyId, input);
    setSaving(false);
    if (r.data) {
      apply(r.data);
      setMessage({ kind: "ok", text: "Conhecimento da empresa salvo." });
    } else setMessage({ kind: "err", text: r.error });
  }

  if (loadError) return <div className="form-error" role="alert">{loadError}</div>;
  if (!loaded) return <p className="muted">Carregando…</p>;
  const sum = loaded.summary;

  return (
    <div className="dl-settings" data-testid="wa-knowledge">
      <section className="dl-card-box">
        <h3>Conhecimento da empresa</h3>
        <p className="field-hint">Informações do seu estabelecimento que, no futuro, a IA poderá usar para responder clientes. Nesta etapa elas apenas ficam guardadas.</p>
        <label className="dl-check">
          <input type="checkbox" checked={false} disabled readOnly data-testid="wa-knowledge-enabled" />
          Base de conhecimento — preparação (a IA ainda não utiliza estes dados)
        </label>

        <label className="dl-field dl-field-wide">
          <span>Endereço</span>
          <input maxLength={300} placeholder="Rua, número, bairro, cidade" value={address} onChange={(e) => setAddress(e.target.value)} />
        </label>
        <label className="dl-field">
          <span>Fuso horário</span>
          <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {TIMEZONE_OPTIONS.some((t) => t.value === timezone) ? null : <option value={timezone}>{timezone}</option>}
            {TIMEZONE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>

        <fieldset className="dl-field dl-field-wide" data-testid="wa-knowledge-hours">
          <legend>Horário de funcionamento</legend>
          {WEEK_DAYS.map((d) => {
            const day = hours[d.key];
            return (
              <div key={d.key} className="dl-field" data-testid={`wa-hours-${d.key}`}>
                <strong>{d.label}</strong>
                <label className="dl-check">
                  <input
                    type="checkbox"
                    checked={day.closed}
                    onChange={(e) => setDay(d.key, (x) => (e.target.checked ? { closed: true, periods: x.periods } : { closed: false, periods: x.periods.length ? x.periods : [{ start: "09:00", end: "18:00" }] }))}
                  />
                  Fechado
                </label>
                {!day.closed && (
                  <>
                    {day.periods.map((p, i) => (
                      <div key={i} className="dl-grid2">
                        <label className="dl-field"><span>Abre</span><input type="time" aria-label={`${d.label} abre ${i + 1}`} value={p.start} onChange={(e) => setDay(d.key, (x) => ({ ...x, periods: x.periods.map((q, j) => (j === i ? { ...q, start: e.target.value } : q)) }))} /></label>
                        <label className="dl-field"><span>Fecha</span><input type="time" aria-label={`${d.label} fecha ${i + 1}`} value={p.end} onChange={(e) => setDay(d.key, (x) => ({ ...x, periods: x.periods.map((q, j) => (j === i ? { ...q, end: e.target.value } : q)) }))} /></label>
                        <button type="button" className="btn-secondary btn-auto" onClick={() => setDay(d.key, (x) => { const periods = x.periods.filter((_, j) => j !== i); return { closed: periods.length === 0, periods }; })}>Remover período</button>
                      </div>
                    ))}
                    {day.periods.length < 4 && (
                      <button type="button" className="btn-secondary btn-auto" onClick={() => setDay(d.key, (x) => ({ ...x, periods: [...x.periods, { start: "18:00", end: "22:00" }] }))}>Adicionar período</button>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </fieldset>

        <fieldset className="dl-field dl-field-wide">
          <legend>Datas fechadas (opcional)</legend>
          {closed.map((c, i) => (
            <div key={i} className="dl-grid2">
              <label className="dl-field"><span>Data</span><input type="date" value={c.date} onChange={(e) => setClosed((l) => l.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))} /></label>
              <label className="dl-field"><span>Motivo</span><input maxLength={60} value={c.label} onChange={(e) => setClosed((l) => l.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} /></label>
              <button type="button" className="btn-secondary btn-auto" onClick={() => setClosed((l) => l.filter((_, j) => j !== i))}>Remover data</button>
            </div>
          ))}
          {closed.length < 120 && <button type="button" className="btn-secondary btn-auto" onClick={() => setClosed((l) => [...l, { date: "", label: "" }])}>Adicionar data fechada</button>}
        </fieldset>

        <fieldset className="dl-field dl-field-wide" data-testid="wa-knowledge-payments">
          <legend>Formas de pagamento aceitas</legend>
          {PAYMENT_OPTIONS.map((p) => (
            <label key={p.code} className="dl-check">
              <input type="checkbox" checked={payments.includes(p.code)} onChange={(e) => setPayments((cur) => togglePayment(cur, p.code, e.target.checked))} />
              {p.label}
            </label>
          ))}
        </fieldset>
        <label className="dl-field dl-field-wide">
          <span>Instruções do Pix (texto público)</span>
          <input maxLength={300} placeholder="Ex.: Pix na entrega ou no balcão" value={pix} onChange={(e) => setPix(e.target.value)} />
          <small className="field-hint">Não coloque senhas ou dados sigilosos.</small>
        </label>
        <label className="dl-field dl-field-wide">
          <span>Observações públicas</span>
          <textarea rows={3} maxLength={NOTES_MAX} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        <fieldset className="dl-field dl-field-wide" data-testid="wa-knowledge-availability">
          <legend>Disponibilidade dos produtos</legend>
          {AVAILABILITY_OPTIONS.map((o) => (
            <label key={o.value} className="dl-check">
              <input type="radio" name="wa-availability" checked={availability === o.value} onChange={() => setAvailability(o.value)} />
              <span><strong>{o.label}</strong> — {o.hint}</span>
            </label>
          ))}
        </fieldset>

        {message && <div className={message.kind === "ok" ? "form-notice" : "form-error"} role={message.kind === "ok" ? "status" : "alert"}>{message.text}</div>}
        <div className="modal-actions">
          <button type="button" className="btn-primary btn-auto" disabled={saving} onClick={() => void save()}>{saving ? "Salvando…" : "Salvar conhecimento"}</button>
        </div>
      </section>

      <section className="dl-card-box" data-testid="wa-knowledge-readonly">
        <h3>Obtido automaticamente (somente leitura)</h3>
        <p className="field-hint">Produtos e preços são obtidos automaticamente do seu catálogo.</p>
        <p data-testid="wa-summary-catalog">{sum.catalog.productsActive} produto(s) ativo(s) em {sum.catalog.categoriesActive} categoria(s) ativa(s). <Link to="/app/cadastros/produtos">Gerenciar em Cadastros → Produtos</Link></p>
        <p data-testid="wa-summary-contact">
          Contato: {sum.contact.name || "—"} · Telefone {sum.contact.phone || "—"} · WhatsApp {sum.contact.whatsapp || "—"} · E-mail {sum.contact.email || "—"}.{" "}
          <Link to="/app/configuracoes/empresa">Editar dados da empresa</Link>
        </p>
        <p className="field-hint">Configurações de entrega são obtidas automaticamente do módulo de entrega.</p>
        <ul data-testid="wa-summary-delivery">
          {deliverySummaryText(sum.delivery).map((l) => <li key={l}>{l}</li>)}
        </ul>
        <p><Link to="/app/configuracoes/delivery">Gerenciar entrega</Link></p>
      </section>
    </div>
  );
}
