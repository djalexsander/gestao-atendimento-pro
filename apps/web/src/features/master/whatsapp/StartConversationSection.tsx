import { useCallback, useEffect, useRef, useState } from "react";
import { fmtDateTimeSP } from "../../../lib/dates";
import { Modal } from "../../employees/Modal";
import { supabaseStartSource, type StartSource } from "../../whatsapp/whatsappStartApi";
import { supabaseStartSettings, supabaseTemplatesSync, type StartSettingsSource, type TemplatesSyncSource } from "../../whatsapp/whatsappTemplatesSyncApi";
import {
  ACCESS_RULE_TEXT,
  ACTION_LABEL,
  BLOCK_CONFIRM_TEXT,
  DEFAULT_DAILY_LIMIT,
  DEFAULT_INTERVAL_HOURS,
  needsBlockConfirmation,
  REASON_LABEL,
  SOURCE_LABEL,
  startRowLine,
  validateStartSettings,
  type StartEvent,
  type StartOverviewRow,
} from "../../whatsapp/whatsappTemplatesSyncLogic";
import { TemplatesSyncPanel } from "../../whatsapp/WhatsappTemplatesUi";
import { Badge } from "../MasterBits";
import { shortUserId } from "./whatsappMasterLogic";

// Painel Master › WhatsApp › "Iniciar conversa por empresa". Iniciar conversa faz parte do módulo WhatsApp: fica disponível AUTOMATICAMENTE para toda empresa
// com direito ativo ao módulo (assinatura, cortesia válida, liberação do Master). Aqui o Master vê o direito efetivo de cada empresa e só pode BLOQUEAR/LIBERAR
// individualmente (o bloqueio tem precedência) e ajustar o limite diário e o intervalo mínimo. Tudo vem do servidor (RPC master_whatsapp_start_overview) e a
// gravação é a RPC whatsapp_set_start_settings (reautentica o Admin Master no banco). Nada habilita à mão e nada sincroniza sozinho.

type Tone = "ok" | "warn" | "bad" | "muted";
const toneOf = (r: StartOverviewRow): Tone => (r.reason === "available" ? "ok" : r.reason === "blocked" ? "bad" : "muted");

export function StartConversationSection({
  settings = supabaseStartSettings,
  sync = supabaseTemplatesSync,
  templatesSource = supabaseStartSource,
}: {
  settings?: StartSettingsSource;
  sync?: TemplatesSyncSource;
  /** Leitura da lista de templates (só quem participa da empresa consegue ler). */
  templatesSource?: StartSource;
}) {
  const [rows, setRows] = useState<StartOverviewRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [companyId, setCompanyId] = useState("");
  const [events, setEvents] = useState<StartEvent[]>([]);
  const [blocked, setBlocked] = useState(false);
  const [limit, setLimit] = useState(String(DEFAULT_DAILY_LIMIT));
  const [interval, setIntervalHours] = useState(String(DEFAULT_INTERVAL_HOURS));
  const [touched, setTouched] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  const token = useRef(0);
  const pickToken = useRef(0);

  const loadAll = useCallback(async () => {
    const t = ++token.current;
    const o = await settings.overview(null);
    if (!alive.current || t !== token.current) return;
    setRows(o ? o.companies : null);
    setFailed(!o);
  }, [settings]);
  useEffect(() => {
    alive.current = true;
    void loadAll();
    return () => {
      alive.current = false;
    };
  }, [loadAll]);

  const current = rows?.find((r) => r.companyId === companyId) ?? null;

  function fillForm(r: StartOverviewRow) {
    setBlocked(r.blocked);
    setLimit(String(r.dailyLimit));
    setIntervalHours(String(r.minIntervalHours));
  }

  async function pick(r: StartOverviewRow) {
    const t = ++pickToken.current;
    setCompanyId(r.companyId);
    setError(null);
    setNotice(null);
    setTouched(false);
    setConfirming(false);
    fillForm(r);
    setEvents([]);
    const o = await settings.overview(r.companyId);
    if (!alive.current || t !== pickToken.current) return; // resposta de outra empresa é descartada
    if (o) setEvents(o.events);
  }

  const issues = validateStartSettings({ companyId, blocked, dailyLimit: limit, minIntervalHours: interval });

  async function save() {
    if (busyRef.current || !issues.ok || !issues.value || !current) return; // clique repetido: um salvamento por vez
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await settings.save(companyId, issues.value);
    busyRef.current = false;
    if (!alive.current) return;
    setBusy(false);
    setConfirming(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    setNotice(`Confirmado pelo servidor — ${current.name}: ${startRowLine(r.data)}.`);
    await loadAll();
    const o = await settings.overview(companyId);
    if (!alive.current) return;
    if (o) {
      setEvents(o.events);
      const fresh = o.companies[0];
      if (fresh) fillForm(fresh);
    }
  }

  function submit() {
    setTouched(true);
    if (!issues.ok) return;
    if (needsBlockConfirmation(blocked, current)) setConfirming(true);
    else void save();
  }

  return (
    <section className="mst-card" aria-labelledby="wa-start-title" data-testid="master-start-section">
      <div className="mst-head">
        <h3 id="wa-start-title">Iniciar conversa por empresa</h3>
      </div>
      <p className="mst-sub" data-testid="start-rule">
        {ACCESS_RULE_TEXT}
      </p>

      {failed && (
        <div className="form-error" role="alert">
          Não foi possível carregar as empresas agora.{" "}
          <button type="button" className="btn-secondary btn-small" onClick={() => void loadAll()}>
            Tentar de novo
          </button>
        </div>
      )}
      {rows === null && !failed && <p className="mst-sub">Carregando empresas…</p>}
      {rows && rows.length === 0 && <p className="mst-sub">Nenhuma empresa cadastrada.</p>}
      {rows && rows.length > 0 && (
        <div className="mst-scroll">
          <table className="mst-table" data-testid="start-table">
            <thead>
              <tr>
                <th>Empresa</th>
                <th>Direito ao módulo WhatsApp</th>
                <th>Iniciar conversa</th>
                <th>Limite / intervalo</th>
                <th>Hoje</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.companyId} data-testid="start-row" aria-selected={r.companyId === companyId}>
                  <td>{r.name}</td>
                  <td>{SOURCE_LABEL[r.source]}</td>
                  <td>
                    <Badge tone={toneOf(r)}>{REASON_LABEL[r.reason]}</Badge>
                  </td>
                  <td>
                    {r.dailyLimit}/dia · {r.minIntervalHours} h
                    {r.hasSettings ? "" : " (padrão)"}
                  </td>
                  <td>{r.usedToday}</td>
                  <td>
                    <button type="button" className="btn-secondary btn-small" onClick={() => void pick(r)}>
                      Ajustar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {current && (
        <>
          <div className="mst-banner" role="status" data-testid="start-current-state">
            <strong>Estado atual · {current.name}</strong>
            <span>
              <Badge tone={toneOf(current)}>{REASON_LABEL[current.reason]}</Badge> {SOURCE_LABEL[current.source]} · {startRowLine(current)}
              {current.connection ? ` · conexão ${current.connection.type === "coexistence" ? "Coexistence" : "Cloud API"} (${current.connection.status})` : " · sem conexão ativa"}
            </span>
            {current.reason === "no_module" && <span>Sem o módulo WhatsApp a empresa não usa o recurso; liberar aqui não concede o módulo.</span>}
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
              <input type="checkbox" checked={blocked} disabled={busy} onChange={(e) => setBlocked(e.target.checked)} data-testid="start-blocked" /> Bloquear Iniciar conversa para esta empresa
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
            <button type="button" className={blocked ? "btn-danger" : "btn-primary"} data-testid="start-save" disabled={busy} onClick={submit}>
              {busy ? "Salvando…" : blocked && !current.blocked ? "Bloquear…" : "Salvar"}
            </button>
          </div>

          {events.length > 0 && (
            <>
              <h4>Histórico</h4>
              <ul data-testid="start-events">
                {events.map((e, i) => (
                  <li key={`${e.at}-${i}`}>
                    {fmtDateTimeSP(e.at)} · {ACTION_LABEL[e.action] ?? e.action} por {shortUserId(e.actorUserId)}
                  </li>
                ))}
              </ul>
            </>
          )}

          <h4>Templates desta empresa</h4>
          <TemplatesSyncPanel key={current.companyId} companyId={current.companyId} sync={sync} source={templatesSource} />
        </>
      )}

      {confirming && current && (
        <Modal title={BLOCK_CONFIRM_TEXT.title} onClose={() => !busy && setConfirming(false)}>
          <p>
            <strong>{current.name}</strong>
          </p>
          <p>{BLOCK_CONFIRM_TEXT.body}</p>
          <div className="mst-actions">
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Cancelar
            </button>
            <button type="button" className="btn-danger" data-testid="start-confirm" disabled={busy} onClick={() => void save()}>
              {busy ? "Salvando…" : BLOCK_CONFIRM_TEXT.confirm}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
