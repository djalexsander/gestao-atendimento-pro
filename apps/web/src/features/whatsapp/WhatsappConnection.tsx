import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Modal } from "../employees/Modal";
import { supabaseWhatsappModulesSource, type WhatsappModulesSource } from "./whatsappModulesApi";
import {
  DISCONNECT_CONFIRM_WORD,
  DISCONNECT_WARNING,
  SIGNUP_UNAVAILABLE_TEXT,
  WHATSAPP_NOT_CONTRACTED_TEXT,
  connectionStatusLabel,
  type ModuleState,
} from "./whatsappModulesLogic";
import { READONLY_MODULE_TEXT, type ConnectionSummary } from "./whatsappLogic";

// Configurações → Conexão do WhatsApp. Mostra o número, o status, as conversas e a integração com a Meta.
// Conectar pelo Cadastro Integrado fica INDISPONÍVEL (com explicação) até a plataforma ser liberada pela Meta: nada é simulado.
// Desconectar: só owner/admin, com confirmação digitada; o histórico e as configurações permanecem.
export function WhatsappConnection({ companyId, source = supabaseWhatsappModulesSource }: { companyId: string; source?: WhatsappModulesSource }) {
  const [state, setState] = useState<ModuleState | null>(null);
  const [summary, setSummary] = useState<ConnectionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, c] = await Promise.all([source.state(companyId), source.summary(companyId)]);
    if (s.data) setState(s.data);
    if (c.data) setSummary(c.data);
    setError(s.error ?? c.error);
  }, [companyId, source]);

  useEffect(() => {
    void load();
  }, [load]);

  async function doDisconnect() {
    setBusy(true);
    setModalError(null);
    const r = await source.disconnect(companyId, confirmText.trim());
    setBusy(false);
    if (r.error) {
      setModalError(r.error);
      return;
    }
    setManageOpen(false);
    setConfirmText("");
    setNotice("WhatsApp desconectado. O histórico foi mantido.");
    await load();
  }

  if (error && !state) return <div className="form-error" role="alert">{error}</div>;
  if (!state || !summary) return <p className="muted">Carregando…</p>;

  if (!state.whatsapp && !state.hasHistory) {
    return (
      <div className="module-locked" role="status">
        <p>{WHATSAPP_NOT_CONTRACTED_TEXT}</p>
      </div>
    );
  }

  const connected = summary.configured && summary.status === "active";

  return (
    <div className="wa-conn">
      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && <div className="form-notice" role="status">{notice}</div>}
      {!state.whatsapp && <div className="form-notice" role="status">{READONLY_MODULE_TEXT}</div>}

      <section className="settings-section wa-conn-card" aria-label="Número conectado">
        <h3 className="settings-section-title">Número conectado</h3>
        <p className="wa-conn-number">{summary.configured && summary.displayPhoneNumber ? summary.displayPhoneNumber : "Nenhum número conectado"}</p>
        {summary.businessName && <p className="field-hint">{summary.businessName}</p>}
        <p>
          <span className={`status-badge ${connected ? "status-active" : "status-inactive"}`}>
            {connectionStatusLabel(summary.status, summary.configured)}
          </span>
          {summary.mode === "test" && <span className="field-hint"> · modo de teste</span>}
        </p>
        <dl className="wa-conn-stats">
          <div><dt>Não lidas</dt><dd>{summary.unreadTotal}</dd></div>
          <div><dt>Conversas abertas</dt><dd>{summary.openConversations}</dd></div>
        </dl>
        <div className="wa-conn-actions">
          <Link className="btn-primary btn-auto" to="/operacional/whatsapp">
            {state.whatsapp ? "Abrir conversas" : "Consultar histórico"}
          </Link>
          {state.canManage && state.whatsapp && (
            <button type="button" className="btn-secondary btn-auto" onClick={() => { setNotice(null); setManageOpen(true); }} disabled={!connected}>
              Gerenciar conexão
            </button>
          )}
        </div>
      </section>

      <section className="settings-section wa-conn-card" aria-label="Integração com a Meta">
        <h3 className="settings-section-title">Integração com a Meta</h3>
        <p>
          A conexão usa a API oficial do WhatsApp Business (Meta). Não usamos QR Code do WhatsApp Web nem automação de sessão.
        </p>
        {state.canManage && state.whatsapp ? (
          <>
            <button type="button" className="btn-primary btn-auto" disabled={!state.signup.available} title={state.signup.available ? undefined : SIGNUP_UNAVAILABLE_TEXT}>
              Conectar WhatsApp
            </button>
            {!state.signup.available && <p className="field-hint" role="status">{SIGNUP_UNAVAILABLE_TEXT}</p>}
          </>
        ) : (
          <p className="field-hint">Somente donos(as) e administradores(as) conectam ou desconectam o número.</p>
        )}
      </section>

      {manageOpen && (
        <Modal title="Gerenciar conexão" onClose={() => (busy ? undefined : setManageOpen(false))}>
          <p>{DISCONNECT_WARNING}</p>
          <div className="field">
            <label htmlFor="wa-disconnect-confirm">Para confirmar, digite {DISCONNECT_CONFIRM_WORD}</label>
            <input id="wa-disconnect-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
          </div>
          {modalError && <div className="form-error" role="alert">{modalError}</div>}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setManageOpen(false)}>
              Cancelar
            </button>
            <button type="button" className="btn-danger" disabled={busy || confirmText.trim() !== DISCONNECT_CONFIRM_WORD} onClick={() => void doDisconnect()}>
              {busy ? "Desconectando…" : "Desconectar"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
