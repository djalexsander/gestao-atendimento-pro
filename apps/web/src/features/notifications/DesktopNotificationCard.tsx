import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../app/useAuth";
import { SectorEditor } from "./SectorEditor";
import { desktopSync } from "./desktopSyncBrowser";
import type { DesktopDeviceState } from "./desktopSync";
import { pushClient } from "./pushBrowser";
import {
  canSaveDraft,
  describeLastUsed,
  deviceStatusLabel,
  deviceTitle,
  draftFromSaved,
  draftToValue,
  isSectorsDirty,
  roleNotificationSummary,
  toggleAllInDraft,
  toggleSectorInDraft,
  type PushDevice,
  type SectorDraft,
  type SectorOption,
} from "./pushLogic";
import {
  DESKTOP_BLOCKED_TEXT,
  DESKTOP_SCOPE_TEXT,
  DESKTOP_STATE_LABEL,
  DESKTOP_TEST,
  DESKTOP_UNAVAILABLE_TEXT,
  DEVICE_KIND_LABEL,
  desktopState,
  readDesktopStatus,
  showDesktopNotification,
  type DesktopNativeStatus,
} from "./desktopNotify";

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });

// Tela de notificações quando o frontend roda DENTRO do Desktop (Tauri): canal = toast nativo do Windows. Não mostra
// nada de navegador/Web Push. "Outros aparelhos" lista as assinaturas de push (navegador/PWA) do usuário, só informativo.
export function DesktopNotificationCard() {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const role = activeMembership?.role ?? null;
  const [status, setStatus] = useState<DesktopNativeStatus | null>(null);
  const [device, setDevice] = useState<DesktopDeviceState | null>(null);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [sectors, setSectors] = useState<SectorOption[]>([]);
  const [draftState, setDraftState] = useState<SectorDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const isProduction = role === "production";
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await readDesktopStatus());
    if (companyId) setDevice(await desktopSync.heartbeat(companyId));
  }, [companyId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    void pushClient.devices(companyId).then((list) => {
      if (!cancelled) setDevices(list);
    });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  useEffect(() => {
    if (!companyId || !isProduction) return;
    void pushClient.listSectors(companyId).then(setSectors);
  }, [companyId, isProduction]);

  if (status === null) return <p className="op-state">Carregando…</p>;
  const state = desktopState(status, device ? !device.isEnabled : false);

  // Setores deste Desktop (production): rascunho local; só "Salvar configurações" grava (o servidor valida tudo).
  const saved = device?.sectorIds ?? null;
  const draft: SectorDraft = draftState ?? draftFromSaved(saved, sectors);
  const dirty = draftState !== null && isSectorsDirty(draftState, saved, sectors);

  async function saveSectors() {
    if (!companyId || !canSaveDraft(draft) || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const { state: next, error: message } = await desktopSync.setSectors(companyId, draftToValue(draft, sectors));
    setSaving(false);
    if (!next) {
      setError(message ? "Não foi possível salvar as configurações. Tente novamente." : "Não foi possível salvar as configurações.");
      return;
    }
    setDevice(next);
    setDraftState(null);
    setNotice("Configurações salvas.");
  }

  async function sendTest() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const ok = await showDesktopNotification(DESKTOP_TEST);
    setBusy(false);
    if (ok) setNotice("Notificação de teste enviada. Ela aparece no Windows; ao clicar, o aplicativo abre esta tela.");
    else setError("Não foi possível mostrar a notificação. Confira as notificações do Windows.");
  }

  async function toggle(off: boolean) {
    if (!companyId) return;
    setBusy(true);
    setError(null);
    const next = await desktopSync.setEnabled(companyId, !off);
    setBusy(false);
    if (!next) {
      setError("Não foi possível salvar a preferência. Tente novamente.");
      return;
    }
    setDevice(next);
    setNotice(off ? "Notificações do Desktop desativadas neste computador." : "Notificações do Desktop ativadas neste computador.");
  }

  return (
    <div className="push-settings">
      <div className="fin-card push-status">
        <div className="push-status-head">
          <h3>Notificações do Desktop</h3>
          <span className={`rec-badge ${state === "active" ? "rec-badge-paid" : state === "blocked" ? "rec-badge-overdue" : ""}`}>{DESKTOP_STATE_LABEL[state]}</span>
        </div>
        <p className="push-hint">
          {state === "active" && "Este computador mostra notificações do Windows do Gestão Atendimento Pro."}
          {state === "disabled" && "Você desativou as notificações do Desktop neste computador."}
          {state === "blocked" && DESKTOP_BLOCKED_TEXT}
          {state === "unavailable" && DESKTOP_UNAVAILABLE_TEXT}
        </p>
        <p className="field-hint">{DESKTOP_SCOPE_TEXT}</p>
        <p className="field-hint">{roleNotificationSummary(role)}</p>
        {device?.lastSeenAt && <p className="field-hint">Última atividade deste Desktop: {dateTime.format(new Date(device.lastSeenAt))}</p>}
        {isProduction && state !== "unavailable" && sectors.length > 0 && (
          <SectorEditor
            draft={draft}
            sectors={sectors}
            dirty={dirty}
            canSave={dirty && canSaveDraft(draft) && !saving}
            saving={saving}
            onAll={() => setDraftState(toggleAllInDraft(draft, sectors))}
            onToggle={(sectorId) => setDraftState(toggleSectorInDraft(draft, sectorId, sectors))}
            onSave={() => void saveSectors()}
          />
        )}
        {error && <div className="form-error">{error}</div>}
        {notice && (
          <div className="rec-notice" role="status">
            {notice}
          </div>
        )}
        <div className="push-actions">
          {state === "active" && (
            <>
              <button className="btn-primary btn-auto" type="button" disabled={busy} onClick={() => void sendTest()}>
                {busy ? "Enviando…" : "Enviar notificação de teste"}
              </button>
              <button className="btn-secondary btn-auto" type="button" disabled={busy} onClick={() => void toggle(true)}>
                Desativar neste computador
              </button>
            </>
          )}
          {state === "disabled" && (
            <button className="btn-primary btn-auto" type="button" disabled={busy} onClick={() => void toggle(false)}>
              Ativar notificações
            </button>
          )}
          {(state === "blocked" || state === "unavailable") && (
            <button className="btn-secondary btn-auto" type="button" onClick={() => void refresh()}>
              Verificar novamente
            </button>
          )}
        </div>
      </div>

      {devices.length > 0 && (
        <div className="fin-card">
          <h3>Outros aparelhos (navegador/PWA)</h3>
          <p className="field-hint">São os aparelhos que recebem notificações pelo navegador ou pelo app instalado. O Desktop não aparece aqui: ele usa as notificações do Windows.</p>
          <ul className="push-devices">
            {devices.map((d) => (
              <li key={d.id} className="push-device">
                <div className="push-device-head">
                  <strong>{deviceTitle(d)}</strong>
                  <span className={d.isActive ? "rec-badge rec-badge-paid" : "rec-badge"}>{deviceStatusLabel(d)}</span>
                </div>
                <small className="muted">
                  {DEVICE_KIND_LABEL[d.platform]} · {describeLastUsed(d.lastUsedAt)} · cadastrado em {dateTime.format(new Date(d.createdAt))}
                </small>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
