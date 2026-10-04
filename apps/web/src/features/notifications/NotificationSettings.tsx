import { useAuth } from "../../app/useAuth";
import type { PushClient } from "./pushClient";
import {
  DENIED_TEXT,
  describeLastUsed,
  deviceStatusLabel,
  deviceTitle,
  IOS_INSTALL_MESSAGE,
  isSectorChecked,
  PLATFORM_LABEL,
  roleNotificationSummary,
  sectorSummary,
  STATE_LABEL,
  UNSUPPORTED_TEXT,
  unsupportedReason,
  type PushDevice,
  type PushState,
  type SectorDraft,
  type SectorOption,
} from "./pushLogic";
import { readPushEnv } from "./pushBrowser";
import { usePushNotifications } from "./usePushNotifications";

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });

function statusHint(state: PushState): string {
  switch (state) {
    case "subscribed":
      return "Este aparelho vai receber as notificações do seu papel.";
    case "not-subscribed":
      return "Ative para receber avisos neste aparelho, mesmo com o app fechado (quando o sistema permitir).";
    case "denied":
      return DENIED_TEXT;
    case "ios-not-installed":
      return IOS_INSTALL_MESSAGE;
    default: {
      const reason = unsupportedReason(readPushEnv());
      return UNSUPPORTED_TEXT[reason ?? "browser"];
    }
  }
}

// Editor de setores do aparelho ATUAL (production). As marcações editam um rascunho; só "Salvar configurações" grava.
function SectorEditor({ draft, sectors, dirty, canSave, saving, onAll, onToggle, onSave }: {
  draft: SectorDraft;
  sectors: SectorOption[];
  dirty: boolean;
  canSave: boolean;
  saving: boolean;
  onAll: () => void;
  onToggle: (sectorId: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="push-sector-editor">
      <div className="push-sector-list" role="group" aria-label="Setores acompanhados neste aparelho">
        <label className="checkbox-row">
          <input type="checkbox" checked={draft.all} disabled={saving} onChange={onAll} />
          Todos os setores
        </label>
        {sectors.map((s) => (
          <label key={s.id} className="checkbox-row">
            <input type="checkbox" checked={isSectorChecked(draft, s.id)} disabled={saving} onChange={() => onToggle(s.id)} />
            {s.name}
          </label>
        ))}
      </div>
      <div className="push-save-row">
        {dirty && <span className="push-unsaved" role="status">Alterações não salvas</span>}
        <button className="btn-primary btn-auto" type="button" disabled={!canSave} onClick={onSave}>
          {saving ? "Salvar configurações..." : "Salvar configurações"}
        </button>
      </div>
    </div>
  );
}

function DeviceRow({ device, isProduction, sectors, editor }: {
  device: PushDevice;
  isProduction: boolean;
  sectors: SectorOption[];
  editor: React.ReactNode;
}) {
  return (
    <li className="push-device">
      <div className="push-device-head">
        <strong>{deviceTitle(device)}</strong>
        {device.isCurrent && <span className="rec-badge">Este aparelho</span>}
        <span className={device.isActive ? "rec-badge rec-badge-paid" : "rec-badge"}>{deviceStatusLabel(device)}</span>
      </div>
      <small className="muted">
        {PLATFORM_LABEL[device.platform]} · {describeLastUsed(device.lastUsedAt)} · cadastrado em {dateTime.format(new Date(device.createdAt))}
      </small>
      {isProduction && (
        <div className="push-sectors">
          <small className="muted">Setores salvos: {sectorSummary(device.sectorIds, sectors)}</small>
          {editor}
        </div>
      )}
    </li>
  );
}

// Painel de notificações do aparelho. Mesmo componente na página administrativa (/app/configuracoes/notificacoes)
// e no modal das telas operacionais. A permissão do navegador SÓ é pedida no clique de "Ativar notificações".
// Três ações distintas: Ativar (associa), Desativar neste aparelho (opt-out) e Salvar configurações (só os setores
// deste aparelho, gravados no servidor).
export function NotificationSettings({ client }: { client?: PushClient }) {
  const { activeMembership, user } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const role = activeMembership?.role ?? null;
  const isProduction = role === "production";
  const push = usePushNotifications(companyId, user?.id ?? null, isProduction, client);
  const { state, current } = push;

  if (push.loading) return <p className="op-state">Carregando…</p>;

  return (
    <div className="push-settings">
      <div className="fin-card push-status">
        <div className="push-status-head">
          <h3>Notificações neste aparelho</h3>
          <span className={`rec-badge ${state === "subscribed" ? "rec-badge-paid" : state === "denied" ? "rec-badge-overdue" : ""}`}>{STATE_LABEL[state]}</span>
        </div>
        <p className="push-hint">{statusHint(state)}</p>
        {push.optedOut && state === "not-subscribed" && <p className="field-hint">Você desativou as notificações neste aparelho. Toque em Ativar notificações para voltar a receber.</p>}
        <p className="field-hint">{roleNotificationSummary(role)}</p>

        {push.error && <div className="form-error">{push.error}</div>}
        {push.notice && <div className="rec-notice" role="status">{push.notice}</div>}

        <div className="push-actions">
          {state === "not-subscribed" && (
            <button className="btn-primary btn-auto" type="button" disabled={push.busy} onClick={() => void push.enable()}>
              {push.busy ? "Ativando…" : "Ativar notificações"}
            </button>
          )}
          {state === "subscribed" && (
            <>
              <button className="btn-primary btn-auto" type="button" disabled={push.busy || push.saving || !current} onClick={() => void push.sendTest()}>
                {push.busy ? "Enviando…" : "Enviar notificação de teste"}
              </button>
              <button className="btn-secondary btn-auto" type="button" disabled={push.busy || push.saving} onClick={() => void push.disable()}>
                Desativar neste aparelho
              </button>
            </>
          )}
        </div>
        <p className="field-hint">
          A entrega depende do aparelho e do sistema (economia de bateria, modo Foco, permissões) e não é garantida nem instantânea.
        </p>
      </div>

      {push.devices.length > 0 && (
        <div className="fin-card">
          <h3>Meus aparelhos</h3>
          <ul className="push-devices">
            {push.devices.map((d) => (
              <DeviceRow
                key={d.id}
                device={d}
                isProduction={isProduction}
                sectors={push.sectors}
                editor={
                  d.isCurrent && d.isActive && push.sectors.length > 0 ? (
                    <SectorEditor
                      draft={push.draft}
                      sectors={push.sectors}
                      dirty={push.dirty}
                      canSave={push.canSave}
                      saving={push.saving}
                      onAll={push.toggleAllSectors}
                      onToggle={push.toggleSector}
                      onSave={() => void push.saveConfig()}
                    />
                  ) : null
                }
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
