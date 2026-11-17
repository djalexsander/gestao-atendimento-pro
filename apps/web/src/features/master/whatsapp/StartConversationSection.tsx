import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "../../employees/Modal";
import { supabaseStartSource, type StartSource } from "../../whatsapp/whatsappStartApi";
import { supabaseStartSettings, supabaseTemplatesSync, type StartSettingsSource, type TemplatesSyncSource } from "../../whatsapp/whatsappTemplatesSyncApi";
import {
  DEFAULT_DAILY_LIMIT,
  DEFAULT_INTERVAL_HOURS,
  ENABLE_CONFIRM_TEXT,
  needsEnableConfirmation,
  STATE_UNKNOWN_TEXT,
  startSettingsLine,
  validateStartSettings,
  type SavedStartSettings,
} from "../../whatsapp/whatsappTemplatesSyncLogic";
import { TemplatesSyncPanel } from "../../whatsapp/WhatsappTemplatesUi";
import { fetchMasterCompanies } from "../api";
import { Badge } from "../MasterBits";

// Painel Master › WhatsApp › "Iniciar conversa por empresa" (Etapa 7.11M). Habilita/desabilita o recurso e define limite diário e intervalo mínimo por
// contato, pela RPC whatsapp_set_start_settings (reautentica o Admin Master no banco). Nada é habilitado por padrão e nada sincroniza sozinho.
// O Master só LÊ o estado das empresas das quais participa: nas demais a tela diz que não leu e mostra o que o servidor confirmar ao salvar.

type Company = { id: string; name: string };
type Known = { state: "loading" } | { state: "known"; value: SavedStartSettings } | { state: "unknown" };

export function StartConversationSection({
  settings = supabaseStartSettings,
  sync = supabaseTemplatesSync,
  templatesSource = supabaseStartSource,
  loadCompanies = async () => (await fetchMasterCompanies()).data.map((c) => ({ id: c.id, name: c.name })),
}: {
  settings?: StartSettingsSource;
  sync?: TemplatesSyncSource;
  /** Leitura da lista de templates (só quem participa da empresa consegue ler). */
  templatesSource?: StartSource;
  loadCompanies?: () => Promise<Company[]>;
}) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [companyId, setCompanyId] = useState("");
  const [known, setKnown] = useState<Known>({ state: "unknown" });
  const [enabled, setEnabled] = useState(false);
  const [limit, setLimit] = useState(String(DEFAULT_DAILY_LIMIT));
  const [interval, setIntervalHours] = useState(String(DEFAULT_INTERVAL_HOURS));
  const [touched, setTouched] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  const readToken = useRef(0);

  useEffect(() => {
    alive.current = true;
    void loadCompanies().then((c) => {
      if (!alive.current) return;
      setCompanies(c);
      setLoaded(true);
    });
    return () => {
      alive.current = false;
    };
  }, [loadCompanies]);

  const company = companies.find((c) => c.id === companyId) ?? null;

  const apply = useCallback((v: SavedStartSettings) => {
    setEnabled(v.enabled);
    setLimit(String(v.dailyLimit));
    setIntervalHours(String(v.minIntervalHours));
  }, []);

  function pickCompany(id: string) {
    setCompanyId(id);
    setError(null);
    setNotice(null);
    setTouched(false);
    setConfirming(false);
    setEnabled(false);
    setLimit(String(DEFAULT_DAILY_LIMIT));
    setIntervalHours(String(DEFAULT_INTERVAL_HOURS));
    if (!id) {
      setKnown({ state: "unknown" });
      return;
    }
    setKnown({ state: "loading" });
    const t = ++readToken.current;
    void settings.read(id).then((v) => {
      if (!alive.current || t !== readToken.current) return; // resposta de outra empresa
      if (v) {
        setKnown({ state: "known", value: v });
        apply(v);
      } else setKnown({ state: "unknown" });
    });
  }

  const issues = validateStartSettings({ companyId, enabled, dailyLimit: limit, minIntervalHours: interval });
  const current = known.state === "known" ? known.value : null;

  async function save() {
    if (busyRef.current || !issues.ok || !issues.value) return; // clique repetido: um salvamento por vez
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const value = issues.value;
    const r = await settings.save(companyId, value);
    busyRef.current = false;
    if (!alive.current) return;
    setBusy(false);
    setConfirming(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    setKnown({ state: "known", value: r.data });
    apply(r.data);
    setNotice(`Confirmado pelo servidor — ${company?.name ?? "empresa"}: ${startSettingsLine(r.data)}.`);
  }

  function submit() {
    setTouched(true);
    if (!issues.ok) return;
    if (needsEnableConfirmation(enabled, current)) setConfirming(true);
    else void save();
  }

  return (
    <section className="mst-card" aria-labelledby="wa-start-title" data-testid="master-start-section">
      <div className="mst-head">
        <h3 id="wa-start-title">Iniciar conversa por empresa</h3>
      </div>
      <p className="mst-sub">
        Liga ou desliga o envio de templates aprovados para iniciar conversas e define o limite diário e o intervalo mínimo por contato. Todas as empresas começam desabilitadas.
      </p>

      <div className="mst-toolbar">
        <div>
          <label htmlFor="wa-start-company">Empresa</label>
          <select id="wa-start-company" value={companyId} onChange={(e) => pickCompany(e.target.value)} disabled={busy}>
            <option value="">{loaded ? "Selecione…" : "Carregando…"}</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {company && (
        <>
          <div className="mst-banner" role="status" data-testid="start-current-state">
            <strong>Estado atual · {company.name}</strong>
            {known.state === "loading" && <span>Lendo o estado…</span>}
            {known.state === "known" && (
              <span>
                <Badge tone={known.value.enabled ? "ok" : "muted"}>{known.value.enabled ? "Habilitado" : "Desabilitado"}</Badge> {startSettingsLine(known.value)}
              </span>
            )}
            {known.state === "unknown" && <span>{STATE_UNKNOWN_TEXT}</span>}
          </div>

          {notice && (
            <div className="form-notice" role="status" data-testid="start-notice">
              {notice}
            </div>
          )}
          {error && (
            <div className="form-error" role="alert" data-testid="start-error">
              {error}
            </div>
          )}

          <div className="wa-start-grid">
            <label className="wa-start-switch">
              <input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => setEnabled(e.target.checked)} data-testid="start-enabled" /> Iniciar conversa habilitado para esta empresa
            </label>
            <div>
              <label htmlFor="wa-start-limit">Limite diário de conversas iniciadas</label>
              <input id="wa-start-limit" inputMode="numeric" value={limit} disabled={busy} onChange={(e) => setLimit(e.target.value)} aria-invalid={touched && !!issues.dailyLimit} />
              {touched && issues.dailyLimit && <small className="field-error">{issues.dailyLimit}</small>}
            </div>
            <div>
              <label htmlFor="wa-start-interval">Intervalo mínimo por contato (horas)</label>
              <input id="wa-start-interval" inputMode="numeric" value={interval} disabled={busy} onChange={(e) => setIntervalHours(e.target.value)} aria-invalid={touched && !!issues.minIntervalHours} />
              {touched && issues.minIntervalHours && <small className="field-error">{issues.minIntervalHours}</small>}
            </div>
          </div>
          <div className="mst-actions">
            <button type="button" className="btn-primary" data-testid="start-save" disabled={busy} onClick={submit}>
              {busy ? "Salvando…" : enabled ? "Salvar e habilitar…" : "Salvar"}
            </button>
          </div>

          <h4>Templates desta empresa</h4>
          <TemplatesSyncPanel key={company.id} companyId={company.id} sync={sync} source={templatesSource} />
        </>
      )}

      {confirming && company && (
        <Modal title={ENABLE_CONFIRM_TEXT.title} onClose={() => !busy && setConfirming(false)}>
          <p>
            <strong>{company.name}</strong>
          </p>
          <p>{ENABLE_CONFIRM_TEXT.body}</p>
          <p className="muted">
            Limite de {limit.trim()} por dia · intervalo de {interval.trim()} h por contato.
          </p>
          <div className="mst-actions">
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Cancelar
            </button>
            <button type="button" className="btn-primary" data-testid="start-confirm" disabled={busy} onClick={() => void save()}>
              {busy ? "Salvando…" : ENABLE_CONFIRM_TEXT.confirm}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
